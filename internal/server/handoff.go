package server

// #223 handoffs: a worker's latest completed final reply filed literally, and
// the floors' filing cabinets. The usage tracker's HandoffTracker (fed the
// same lines and TurnEvents as the follow-up and wrap-up trackers) knows each
// worker's candidate and the transcript file it was read from; the hub keeps
// it and shows its identity as Worker.Handoff, never its text.
//
// worker.handoff_preview and worker.handoff resolve the candidate's whole
// text from its lines in that file (transcript.Resolve) off the hub
// goroutine: the client names a candidate the bridge gave it, never a path
// or a text. Filing goes through internal/handoff, the cabinet's one writer
// (later modes and worker.fire's reserved handoff field use it too). A
// requested send home starts only after the handoff was filed and indexed,
// through worker.fire's own path, its eligibility checked again then. No
// model is called and nothing is sent to the worker.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/handoff"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/secretfiles"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
	"github.com/JeffreyVdb/herdr-3d/internal/usage"
)

var (
	errHandoffUnavailable = errors.New("no such handoff candidate")
	errHandoffFailed      = errors.New("filing the handoff failed")
)

// handoffOp is an operation id's form.
var handoffOp = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// handoffCand is a worker's candidate and the transcript file it was read
// from (its path, the file as the tail read it, and where the tail had read
// to), under the agent session herdr reported of the worker then (agent;
// "" for a Codex agent whose rollout was found by its cwd).
type handoffCand struct {
	c     transcript.Candidate
	path  string
	fi    fs.FileInfo
	end   int64
	agent string
}

// check reads the candidate's transcript again (off the hub goroutine): the
// lines that made it the candidate must be unchanged, the lines written
// since must leave it the latest completed reply, and its whole text must
// still be what it was.
func (hc *handoffCand) check() (string, error) {
	if err := transcript.StillLatest(hc.path, hc.fi, &hc.c, hc.end); err != nil {
		return "", err
	}
	return transcript.Resolve(hc.path, hc.fi, &hc.c, proto.MaxHandoffBytes)
}

// handoffUpdate is a worker's new candidate (nil: none now), from the usage
// tracker.
type handoffUpdate struct {
	id   string
	cand *handoffCand
}

// handoffOffered is what the tracker last offered of a worker, and under
// which agent session herdr reported: another one offers the candidate
// again, pinned to it.
type handoffOffered struct {
	t     *transcript.HandoffTracker
	seq   int
	agent string
}

// offerHandoff queues worker w's candidate when it changed (usage tracker
// goroutine, after its session's Poll).
func (tr *usageTracker) offerHandoff(w usageWorker, s *usage.Session) {
	var ht *transcript.HandoffTracker
	if l := tr.lines[w.id]; l != nil {
		ht = l.handoff
	}
	o := handoffOffered{t: ht, agent: w.agent}
	var c *transcript.Candidate
	if ht != nil {
		o.seq, c = ht.Seq(), ht.Candidate()
	}
	prev, ok := tr.hoOffered[w.id]
	if ok && prev == o {
		return
	}
	tr.hoOffered[w.id] = o
	if !ok && c == nil {
		return
	}
	u := handoffUpdate{id: w.id}
	if c != nil && s != nil {
		path, fi, end := s.Main()
		hc := &handoffCand{c: *c, path: path, fi: fi, end: end, agent: w.agent}
		hc.c.Spans = append([]transcript.Span(nil), c.Spans...)
		if hc.c.Session == "" { // a Codex rollout without its session_meta read
			hc.c.Session = w.session
		}
		if path != "" {
			u.cand = hc
		}
	}
	tr.hoUps = append(tr.hoUps, u)
}

// handoffState is the hub's part (hub goroutine).
type handoffState struct {
	svc      *handoff.Service
	cands    map[string]*handoffCand // worker id → its candidate
	counts   map[string]int          // floor → its handoffs
	inflight map[string]bool         // operation ids being filed
}

// initHandoffs reconciles the cabinet with its directory and counts the
// floors' handoffs (NewHub); nothing without a handoff directory.
func (h *Hub) initHandoffs(ctx context.Context) error {
	h.ho = handoffState{svc: h.opts.Handoffs, cands: map[string]*handoffCand{}, counts: map[string]int{}, inflight: map[string]bool{}}
	if h.ho.svc == nil {
		return nil
	}
	r, err := h.ho.svc.Reconcile(ctx)
	if err != nil {
		return fmt.Errorf("handoffs: %w", err)
	}
	if r != (handoff.Reconciled{}) {
		h.log.Info("handoffs reconciled", "dir", h.ho.svc.Dir(), "removed", r.Removed, "reindexed", r.Reindexed,
			"registered", r.Registered, "tmp", r.Tmp)
	}
	counts, err := h.st.HandoffCounts(ctx)
	if err != nil {
		return fmt.Errorf("handoffs: %w", err)
	}
	h.ho.counts = counts
	return nil
}

// handoffsView is the snapshot's cabinet (nil: none).
func (h *Hub) handoffsView() *proto.HandoffCabinet {
	if h.ho.svc == nil {
		return nil
	}
	v := &proto.HandoffCabinet{Counts: map[string]int{}}
	for f, n := range h.ho.counts {
		if n > 0 {
			v.Counts[f] = n
		}
	}
	return v
}

// handoffView is a worker's candidate as Worker.Handoff (nil: none). A
// candidate read under another agent session than the worker's (agent) is
// not shown (and refused, handoffCandOf): the tracker's next read offers
// the new session's, or the same one again pinned to it.
func (h *Hub) handoffView(id, agent string) *proto.HandoffCandidate {
	hc := h.ho.cands[id]
	if hc == nil || h.ho.svc == nil || hc.agent != agent {
		return nil
	}
	c := hc.c
	return &proto.HandoffCandidate{ID: c.ID, Session: c.Session, Revision: c.Hash, Harness: c.Harness, Message: c.Message,
		Turn: c.Turn, Source: c.Source, Bytes: len(c.Body), Images: c.Images, TooLarge: len(c.Body) > proto.MaxHandoffBytes}
}

// handoffSeen takes a worker's candidate from the tracker and publishes the
// worker when it changed.
func (h *Hub) handoffSeen(u handoffUpdate) {
	if h.ho.svc == nil {
		return
	}
	if u.cand == nil {
		delete(h.ho.cands, u.id)
	} else {
		h.ho.cands[u.id] = u.cand
	}
	w := h.workers[u.id]
	if w == nil {
		return
	}
	v := h.handoffView(u.id, w.AgentSession)
	if (w.Handoff == nil && v == nil) || (w.Handoff != nil && v != nil && *w.Handoff == *v) {
		return
	}
	next := *w
	next.Handoff = v
	h.workers[u.id] = &next
	h.emit(proto.Event{T: proto.EvWorkerUpsert, Worker: &next})
}

// handoffCandOf checks a worker's current candidate is the one named (hub
// goroutine).
func (h *Hub) handoffCandOf(id, session, cand, revision string) (*proto.Worker, *handoffCand, error) {
	if h.ho.svc == nil {
		return nil, nil, fmt.Errorf("%w: the bridge has no handoff directory", errUnsupported)
	}
	w := h.workers[id]
	if w == nil {
		return nil, nil, fmt.Errorf("%w: %q", errUnknownWorker, id)
	}
	hc := h.ho.cands[id]
	switch {
	case hc != nil && hc.agent != w.AgentSession:
		return nil, nil, fmt.Errorf("%w: %s's agent session changed", errHandoffUnavailable, w.Name)
	case hc == nil:
		return nil, nil, fmt.Errorf("%w: %s has no completed reply to file now", errHandoffUnavailable, w.Name)
	case hc.c.ID != cand:
		return nil, nil, fmt.Errorf("%w: reply %q is not %s's latest completed reply any more", errHandoffUnavailable, clip(cand), w.Name)
	case session != "" && hc.c.Session != session:
		return nil, nil, fmt.Errorf("%w: the agent session changed", errHandoffUnavailable)
	case revision != "" && hc.c.Hash != revision:
		return nil, nil, fmt.Errorf("%w: the reply changed", errHandoffUnavailable)
	}
	return w, hc, nil
}

// sendHomeBlocked says why worker w cannot be sent home now ("": it can):
// the same checks as worker.fire, and a worker at work, blocked or waiting on
// its question is never sent home by a handoff.
func (h *Hub) sendHomeBlocked(w *proto.Worker) string {
	switch {
	case w.Status == statusWorking:
		return w.Name + " is working"
	case w.Status == statusBlocked:
		return w.Name + " is blocked: it waits on you"
	case w.Ask != nil:
		return w.Name + " waits on its question"
	case h.opts.Hire == nil:
		return "sending workers home is not configured"
	}
	_, f, err := h.fireWorker(w.ID)
	if err != nil {
		return err.Error()
	}
	if why := h.groupBlocked(w, f); why != "" {
		return why
	}
	return ""
}

func provenanceOf(w *proto.Worker) proto.HandoffProvenance {
	return proto.HandoffProvenance{Floor: workerFloor(w), WorkerName: w.Name, Label: w.Label, Harness: harnessOf(w), Model: w.Model,
		Branch: w.Branch, Cwd: checkoutOf(w), Session: w.AgentSession}
}

func harnessOf(w *proto.Worker) string {
	if w.Harness != "" {
		return w.Harness
	}
	return w.AgentKind
}

// previewText is the first max bytes of s, cut on a character.
func previewText(s string, max int) (string, bool) {
	if len(s) <= max {
		return s, false
	}
	s = s[:max]
	for len(s) > 0 && !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s, true
}

// reviewedHandoff is worker.handoff's instruction (modes agent and llm)
// through the gate (#108 round 2; hub goroutine), its files the worker's,
// then the handoff with what it made. The agent's request settles them as
// a /handoff's does (settleHandoff: kept once its prompt is sent, else
// removed); an LLM job keeps them once it started (the model reads only
// the references), and an existing op's answer, which uses none of the
// text, removes them.
func (h *Hub) reviewedHandoff(ctx context.Context, c *Client, cmd proto.Command, a proto.WorkerHandoffArgs) error {
	if err := h.stillOn(); err != nil {
		return err
	}
	if strings.TrimSpace(a.Instruction) == "" {
		if a.Secrets != nil {
			return fmt.Errorf("%w: a review needs the instruction it is of", errSecretsReviewRequired)
		}
		return h.startHandoffOf(ctx, c, cmd, a) // nothing typed: the default instruction
	}
	if err := scannable(a.Instruction, "instruction"); err != nil {
		return err
	}
	rev, owner := h.ps.rev, secretfiles.Worker(a.Worker)
	startGated(h, ctx, c, cmd, rev, func(ctx context.Context) (protected, error) {
		return h.protectText(ctx, rev, owner, time.Time{}, a.Instruction, a.Secrets)
	}, func(ctx context.Context, p protected) { h.unprotect(ctx, p) }, func(ctx context.Context, p protected) error {
		b := a
		b.Instruction, b.Secrets = p.text, nil
		if a.Mode == proto.HandoffModeAgent {
			ask := agentAsk{worker: b.Worker, op: b.Op, instruction: b.Instruction, sendHome: b.SendHome, rev: rev,
				answer: func(r proto.AgentHandoff, existing, _ bool) any {
					res := proto.WorkerHandoffRequestResult{Request: r, Existing: existing}
					if !existing {
						res.Protected = len(p.files)
					}
					return res
				}}
			if len(p.files) > 0 {
				ask.settle = h.settleHandoff(p, owner)
			}
			return h.startAgentHandoff(ctx, c, cmd, ask)
		}
		started := false
		if err := h.startLLMHandoff(ctx, c, cmd, b, rev, func() { started = true }); err != nil {
			return err
		}
		h.settleHandoff(p, owner)(nil, !started)
		return nil
	})
	return nil
}

// startHandoffOf is startHandoff's modes agent (#224) and llm (#9) for
// args read.
func (h *Hub) startHandoffOf(ctx context.Context, c *Client, cmd proto.Command, a proto.WorkerHandoffArgs) error {
	if a.Mode == proto.HandoffModeAgent {
		return h.startAgentHandoff(ctx, c, cmd, agentAsk{worker: a.Worker, op: a.Op, instruction: a.Instruction, sendHome: a.SendHome,
			answer: func(r proto.AgentHandoff, existing, _ bool) any {
				return proto.WorkerHandoffRequestResult{Request: r, Existing: existing}
			}})
	}
	return h.startLLMHandoff(ctx, c, cmd, a, nil, nil)
}

// startHandoffPreview answers worker.handoff_preview: the candidate's text,
// read back from its transcript off the hub goroutine.
func (h *Hub) startHandoffPreview(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.WorkerHandoffPreviewArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	switch a.Mode {
	case proto.HandoffModeAgent: // #224
		return h.startAgentPreview(ctx, c, cmd, a)
	case proto.HandoffModeLLM: // #9
		return h.startLLMPreview(ctx, c, cmd, a)
	}
	w, hc, err := h.handoffCandOf(a.Worker, "", a.Candidate, "")
	if err != nil {
		return err
	}
	cand := *h.handoffView(a.Worker, w.AgentSession)
	prov, blocked := provenanceOf(w), h.sendHomeBlocked(w)
	name, now := w.Name, h.opts.Now()
	src := *hc
	h.startAsync(ctx, c, cmd, func(context.Context) (any, error) {
		body, err := src.check()
		if err != nil {
			return nil, err
		}
		text, cut := previewText(body, proto.HandoffPreviewBytes)
		return proto.WorkerHandoffPreviewResult{Candidate: &cand, Text: text, Truncated: cut, Title: handoff.Title(body, name, now),
			Provenance: prov, CanSendHome: blocked == "", SendHomeBlocked: blocked}, nil
	})
	return nil
}

// handoffReport is the audit-log result of a worker.handoff: ids, the path
// and sizes, never the text.
type handoffReport struct {
	Worker    string `json:"worker"`
	Candidate string `json:"candidate"`
	Revision  string `json:"revision"`
	Handoff   int64  `json:"handoff,omitempty"`
	Path      string `json:"path,omitempty"`
	Bytes     int    `json:"bytes,omitempty"`
	Existing  bool   `json:"existing,omitempty"`
	SendHome  string `json:"send_home,omitempty"`
	Reason    string `json:"send_home_reason,omitempty"`
}

// startHandoff answers worker.handoff: the candidate checked to be the
// worker's current one, under its current agent session, and to be the
// transcript's latest completed reply still (the lines written since the
// tracker's last read included), its text read back from the transcript and
// checked against its revision, the handoff filed and indexed, handoff.added; then,
// when asked, the send home, its eligibility checked again.
func (h *Hub) startHandoff(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.WorkerHandoffArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if a.Mode == proto.HandoffModeAgent || a.Mode == proto.HandoffModeLLM { // #224, #9
		if h.gated(a.Secrets != nil) { // #108
			return h.reviewedHandoff(ctx, c, cmd, a)
		}
		return h.startHandoffOf(ctx, c, cmd, a)
	}
	switch {
	case a.Mode != proto.HandoffModeLiteral:
		return bad("mode must be %q, %q or %q, got %q", proto.HandoffModeLiteral, proto.HandoffModeAgent, proto.HandoffModeLLM, a.Mode)
	case !handoffOp.MatchString(a.Op):
		return bad("op must be 1–%d characters of A-Z, a-z, 0-9, _ and -", proto.MaxHandoffOp)
	case a.Session == "" || a.Candidate == "" || a.Revision == "":
		return bad("session, candidate and revision are required")
	}
	w, hc, err := h.handoffCandOf(a.Worker, a.Session, a.Candidate, a.Revision)
	if err != nil {
		return err
	}
	if h.ho.inflight[a.Op] {
		return fmt.Errorf("%w: this handoff is being filed", errBusy)
	}
	auditID, err := h.st.AuditBegin(ctx, c.name, cmd.T, auditArgs(cmd))
	if err != nil {
		return err
	}
	h.ho.inflight[a.Op] = true
	items, _ := json.Marshal(struct {
		Harness string            `json:"harness"`
		Message string            `json:"message,omitempty"`
		Request string            `json:"request,omitempty"`
		Line    string            `json:"line,omitempty"`
		Turn    string            `json:"turn,omitempty"`
		Source  string            `json:"source"`
		Spans   []transcript.Span `json:"spans"`
	}{hc.c.Harness, hc.c.Message, hc.c.Request, hc.c.Line, hc.c.Turn, hc.c.Source, hc.c.Spans})
	src := handoff.Source{Floor: workerFloor(w), WorkerID: w.ID, WorkerName: w.Name, Label: w.Label, Harness: harnessOf(w), Model: w.Model,
		Cwd: checkoutOf(w), Branch: w.Branch, AgentSession: hc.c.Session, Kind: store.HandoffLiteral, Turn: hc.c.ID,
		Items: string(items), Hash: hc.c.Hash, Op: a.Op}
	svc, cand := h.ho.svc, *hc
	rep := &handoffReport{Worker: w.ID, Candidate: a.Candidate, Revision: a.Revision}
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		var filed store.Handoff
		var existing bool
		body, err := cand.check()
		if err == nil {
			filed, existing, err = svc.File(ctx, src, body)
			if err != nil && !errors.Is(err, handoff.ErrOpReused) {
				err = fmt.Errorf("%w: %v", errHandoffFailed, err)
			}
			rep.Bytes = len(body)
		}
		derr := h.doWait(ctx, func() {
			delete(h.ho.inflight, a.Op)
			var res proto.WorkerHandoffResult
			if err == nil {
				rep.Handoff, rep.Path, rep.Existing = filed.ID, filed.Path, existing
				res = proto.WorkerHandoffResult{Handoff: entryOf(filed), Existing: existing}
				if !existing {
					h.ho.counts[filed.Floor]++
					n := h.ho.counts[filed.Floor]
					e := entryOf(filed)
					h.emit(proto.Event{T: proto.EvHandoffAdded, Session: h.sessionOf(filed.Floor), FloorID: filed.Floor, Handoff: &e, HandoffCount: &n})
					h.log.Info("handoff filed", "worker", w.ID, "handoff", filed.ID, "path", filed.Path, "bytes", rep.Bytes)
				}
				if a.SendHome {
					res.SendHome, res.SendHomeReason = h.handoffSendHome(ctx, c.name, a.Worker, filed.ID)
					rep.SendHome, rep.Reason = res.SendHome, res.SendHomeReason
				}
			} else {
				h.log.Warn("handoff not filed", "worker", w.ID, "candidate", clip(a.Candidate), "err", err)
			}
			if aerr := h.st.AuditEnd(ctx, auditID, err, rep); aerr != nil {
				h.log.Error("audit log write failed", "err", aerr)
			}
			if err != nil {
				h.reply(c, cmd, nil, err)
				return
			}
			h.reply(c, cmd, res, nil)
		})
		if derr != nil {
			h.log.Warn("handoff abandoned", "worker", a.Worker, "err", derr)
		}
	}()
	return nil
}

// handoffSendHome sends a worker home after its handoff was filed (hub
// goroutine): worker.fire's path with the worktree kept, its own audit row,
// when the worker may go now; else skipped and why.
func (h *Hub) handoffSendHome(ctx context.Context, by string, id string, handoffID int64) (string, string) {
	w := h.workers[id]
	if w == nil {
		return proto.HandoffSendSkipped, "the worker is gone"
	}
	if why := h.sendHomeBlocked(w); why != "" {
		return proto.HandoffSendSkipped, why
	}
	w, f, err := h.fireWorker(id)
	if err != nil {
		return proto.HandoffSendSkipped, err.Error()
	}
	op, err := h.newFireOp(ctx, w, f, proto.FireKeep)
	if err != nil {
		return proto.HandoffSendSkipped, err.Error()
	}
	args, _ := json.Marshal(map[string]any{"id": id, "worktree": proto.FireKeep, "handoff": handoffID})
	auditID, err := h.st.AuditBegin(ctx, by, proto.CmdWorkerFire, args)
	if err != nil {
		return proto.HandoffSendSkipped, "the audit log could not be written: " + err.Error()
	}
	op.auditID = auditID
	h.beginFire(ctx, op, f)
	h.log.Info("send home after handoff started", "session", op.session, "worker", op.id, "handoff", handoffID)
	return proto.HandoffSendStarted, ""
}

func entryOf(h store.Handoff) proto.HandoffEntry {
	return proto.HandoffEntry{ID: h.ID, Floor: h.Floor, WorkerID: h.WorkerID, WorkerName: h.WorkerName, Label: h.Label,
		Harness: h.Harness, Model: h.Model, Cwd: h.Cwd, Branch: h.Branch, AgentSession: h.AgentSession, Path: h.Path,
		Title: h.Title, CreatedAt: h.CreatedAt, Source: h.Source, Bytes: h.Size}
}

// startHandoffs answers handoff.list, handoff.get and handoff.delete; the
// store and the files are read off the hub goroutine.
func (h *Hub) startHandoffs(ctx context.Context, c *Client, cmd proto.Command) error {
	svc := h.ho.svc
	if svc == nil {
		return fmt.Errorf("%w: the bridge has no handoff directory", errUnsupported)
	}
	switch cmd.T {
	case proto.CmdHandoffList:
		var a proto.HandoffListArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return err
		}
		if a.Floor == "" || len(a.Floor) > 256 {
			return bad("floor is required")
		}
		if a.Limit < 0 {
			return bad("limit must not be negative")
		}
		h.startAsync(ctx, c, cmd, func(ctx context.Context) (any, error) {
			hits, err := h.st.Handoffs(ctx, a.Floor, a.Q, a.Limit)
			if err != nil {
				return nil, err
			}
			res := proto.HandoffListResult{Floor: a.Floor, Handoffs: []proto.HandoffEntry{}}
			for _, hit := range hits {
				e := entryOf(hit.Handoff)
				e.Snippet = hit.Snippet
				res.Handoffs = append(res.Handoffs, e)
			}
			return res, nil
		})
	case proto.CmdHandoffGet:
		var a proto.HandoffGetArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return err
		}
		h.startAsync(ctx, c, cmd, func(ctx context.Context) (any, error) {
			got, body, fm, err := svc.ReadProvenance(ctx, a.ID)
			if err != nil {
				return nil, err
			}
			return proto.HandoffGetResult{Handoff: entryOf(got), Body: body, LLM: llmProvenanceOf(got.Source, fm)}, nil // #9
		})
	default: // handoff.delete
		var a proto.HandoffDeleteArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return err
		}
		if !a.Confirm {
			return fmt.Errorf("%w: deleting a handoff needs confirm: true", errConfirmation)
		}
		h.startAsync(ctx, c, cmd, func(ctx context.Context) (any, error) {
			gone, err := svc.Delete(ctx, a.ID)
			if err != nil {
				return nil, err
			}
			_ = h.doWait(ctx, func() {
				if h.ho.counts[gone.Floor] > 0 {
					h.ho.counts[gone.Floor]--
				}
				n := h.ho.counts[gone.Floor]
				h.emit(proto.Event{T: proto.EvHandoffRemoved, Session: h.sessionOf(gone.Floor), FloorID: gone.Floor, HandoffID: gone.ID,
					HandoffCount: &n})
				h.log.Info("handoff deleted", "handoff", gone.ID, "path", gone.Path)
			})
			return proto.HandoffDeleteResult{Handoff: entryOf(gone)}, nil
		})
	}
	return nil
}

// handoffErrorCode maps an error of the handoffs to its protocol code; ""
// when it is none.
func handoffErrorCode(err error) string {
	switch {
	case errors.Is(err, errHandoffUnavailable), errors.Is(err, transcript.ErrNotLatest):
		return proto.ErrHandoffUnavailable
	case errors.Is(err, transcript.ErrSourceTooLarge), errors.Is(err, handoff.ErrTooLarge):
		return proto.ErrTooLarge
	case errors.Is(err, transcript.ErrSourceReplaced), errors.Is(err, transcript.ErrSourceChanged):
		return proto.ErrHandoffSource
	case errors.Is(err, handoff.ErrOpReused):
		return proto.ErrBadRequest
	case errors.Is(err, handoff.ErrEmpty):
		return proto.ErrHandoffUnavailable
	case errors.Is(err, errHandoffFailed), errors.Is(err, handoff.ErrOutside):
		return proto.ErrHandoffFailed
	case errors.Is(err, errSkillMissing): // #224
		return proto.ErrHandoffSkillMissing
	}
	return ""
}
