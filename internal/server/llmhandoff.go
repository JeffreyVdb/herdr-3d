package server

// #9: "Use configured LLM". worker.handoff in mode "llm" (the F dialog) has
// the configured LLM (#92, the LLM role; never the classifier, never the
// worker's agent) write a handoff from the worker's transcript. The worker
// is not prompted, whatever its prompt cache is estimated to be.
//
// Nothing is sent unless the feature (internal/handoffllm's Service: off by
// default, switched on after a passing handoff_llm.test of the config in
// use) is ready when the handoff is asked for and again when the call goes.
// The snapshot is the transcript up to the worker's current candidate (its
// latest completed turn): the dialog names it, as a literal handoff does,
// and a newer one makes the request stale. The reducer (handoffllm.Reduce,
// injectable as Options.HandoffReduce) reads that immutable snapshot off the
// hub goroutine and returns bounded, scrubbed source data; the prompt
// (handoffllm.Build) adds the bridge's facts (the git state captured now,
// the cached skill list when one exists) and the focus instruction as
// delimited data. One call (handoffllm.Service.Generate: one at a time over
// the bridge, its own timeout, no second attempt after an uncertain
// outcome, NoPartial), the answer validated, then filed through the
// cabinet's service with the LLM's provenance in the front matter, and only
// then, when asked, the send home through worker.fire's path, its
// eligibility checked again.
//
// A job (store handoff_llm_job, one per op) is persisted before the call:
// the op answers a repeated submit with the same job (another worker or
// other arguments: bad_request), and a restart marks an unfinished one
// failed (handoff_llm_interrupted), never sending it again. A job is
// cancelled when its LLM config changes (the fingerprint it started with),
// the feature stops being ready, the worker's agent session changes or the
// worker leaves, and by worker.handoff_cancel; a late answer is never filed
// under another session or config. No failure sends the worker home, picks
// another mode or model, or prompts the worker.
//
// The audit row keeps the model, the endpoint's host, sizes, the elapsed
// time, the outcome code and the redaction counts; never the transcript,
// the instruction, the document or a key.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/handoff"
	"github.com/JeffreyVdb/herdr-3d/internal/handoffllm"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
)

const (
	// llmJobKeep is how long a settled job's row is kept (its op answers a
	// retry) and llmJobShown how long a settled job loaded at startup is
	// still shown on its worker.
	llmJobKeep  = 30 * 24 * time.Hour
	llmJobShown = 24 * time.Hour
	// llmGitWait bounds reading the worker's git state for the facts.
	llmGitWait = 5 * time.Second
	// llmFileWait bounds filing the document once it was written.
	llmFileWait = 30 * time.Second
)

// llmJob is an LLM handoff job (hub goroutine).
type llmJob struct {
	row         store.HandoffLLMJob
	model, host string
	// cancel stops the job while it runs (nil once settled); stop is why a
	// hook cancelled it (its state, code and message).
	cancel context.CancelFunc
	stop   *llmStop
	// filing: the answer passed every check and is being filed: no hook
	// cancels it any more.
	filing              bool
	homeResult, homeWhy string
}

type llmStop struct{ state, code, msg string }

func (j *llmJob) settled() bool {
	return j.row.State != store.HandoffJobQueued && j.row.State != store.HandoffJobRunning
}

func (j *llmJob) view() proto.LLMHandoff {
	return proto.LLMHandoff{Op: j.row.Op, State: j.row.State, Code: j.row.Code, Message: j.row.Message, StartedAt: j.row.CreatedAt,
		UpdatedAt: j.row.UpdatedAt, Model: j.model, Host: j.host, SendHome: j.row.SendHome, Handoff: j.row.HandoffID,
		SendHomeResult: j.homeResult, SendHomeReason: j.homeWhy}
}

// llmHandoffState is the hub's part (hub goroutine).
type llmHandoffState struct {
	svc      *handoffllm.Service
	roles    handoffllm.Roles
	last     string             // the view last published
	byWorker map[string]*llmJob // each worker's latest job
	running  *llmJob            // the one job out (one at a time)
}

// llmStore adapts the store to the feature's.
type llmStore struct{ st *store.Store }

func (a llmStore) LoadHandoffLLMSettings(ctx context.Context) (handoffllm.Settings, bool, error) {
	s, ok, err := a.st.LoadHandoffLLMSettings(ctx)
	return handoffllm.Settings{Enabled: s.Enabled, InputBytes: s.InputBytes, MaxTokens: s.MaxTokens, ReasoningEffort: s.ReasoningEffort,
		Bound: s.Bound}, ok, err
}

func (a llmStore) SaveHandoffLLMSettings(ctx context.Context, s handoffllm.Settings) error {
	return a.st.SaveHandoffLLMSettings(ctx, store.HandoffLLMSettings{Enabled: s.Enabled, InputBytes: s.InputBytes, MaxTokens: s.MaxTokens,
		ReasoningEffort: s.ReasoningEffort, Bound: s.Bound})
}

// initHandoffLLM makes the feature's service (NewHub, after the cabinet):
// none without the AI integration or a handoff directory. Jobs a restart
// interrupted are failed, never resumed.
func (h *Hub) initHandoffLLM(ctx context.Context) error {
	h.llm = llmHandoffState{byWorker: map[string]*llmJob{}}
	roles := h.opts.HandoffLLMRoles
	if roles == nil && h.opts.AI != nil {
		roles = h.opts.AI
	}
	if roles == nil || h.ho.svc == nil {
		return nil
	}
	if h.opts.HandoffReduce == nil {
		h.opts.HandoffReduce = handoffllm.Reduce
	}
	svc, err := handoffllm.New(ctx, handoffllm.Options{Roles: roles, Store: llmStore{h.st}, EnvEnabled: h.opts.HandoffLLMEnabled, Now: h.opts.Now})
	if err != nil {
		return fmt.Errorf("LLM handoffs: %w", err)
	}
	h.llm.svc, h.llm.roles = svc, roles
	if b, err := json.Marshal(llmStateOf(svc.View())); err == nil {
		h.llm.last = string(b)
	}
	now := h.opts.Now()
	if n, err := h.st.FailUnfinishedHandoffLLMJobs(ctx, proto.ErrHandoffLLMInterrupted,
		"the bridge restarted while the handoff was being written; it was not sent again and nothing was filed", now.UnixMilli()); err != nil {
		return fmt.Errorf("LLM handoffs: %w", err)
	} else if n > 0 {
		h.log.Info("LLM handoffs interrupted by the restart marked failed", "jobs", n)
	}
	if err := h.st.PruneHandoffLLMJobs(ctx, now.Add(-llmJobKeep).UnixMilli()); err != nil {
		return fmt.Errorf("LLM handoffs: %w", err)
	}
	jobs, err := h.st.LatestHandoffLLMJobs(ctx)
	if err != nil {
		return fmt.Errorf("LLM handoffs: %w", err)
	}
	for _, j := range jobs {
		if now.Sub(time.UnixMilli(j.UpdatedAt)) < llmJobShown {
			h.llm.byWorker[j.WorkerID] = &llmJob{row: j}
		}
	}
	return nil
}

// handoffLLMView is the feature's state for the snapshot (nil: none).
func (h *Hub) handoffLLMView() *proto.HandoffLLMState {
	if h.llm.svc == nil {
		return nil
	}
	v := llmStateOf(h.llm.svc.View())
	return &v
}

// publishHandoffLLMState emits handoff_llm.update when the state changed
// (hub goroutine), and stops a job the change made stale.
func (h *Hub) publishHandoffLLMState() {
	if h.llm.svc == nil {
		return
	}
	h.checkLLMJob()
	v := llmStateOf(h.llm.svc.View())
	b, err := json.Marshal(v)
	if err != nil || string(b) == h.llm.last {
		return
	}
	h.llm.last = string(b)
	h.seq++
	msg := mustJSON(proto.HandoffLLMUpdate{T: proto.EvHandoffLLMUpdate, Seq: h.seq, HandoffLLMState: v})
	h.ring.add(h.seq, msg)
	for c := range h.clients {
		h.deliver(c, msg)
	}
}

// checkLLMJob cancels the running job when its LLM config changed or the
// feature is no longer ready (hub goroutine).
func (h *Hub) checkLLMJob() {
	j := h.llm.running
	if j == nil || j.filing || j.stop != nil {
		return
	}
	switch {
	case h.llm.svc.Fingerprint() != j.row.Config:
		h.stopLLMJob(j, store.HandoffJobFailed, proto.ErrHandoffLLMStale, "the LLM's settings changed while the handoff was being written; nothing was filed")
	case h.llm.svc.Unready() != "":
		h.stopLLMJob(j, store.HandoffJobFailed, proto.ErrHandoffLLMUnavailable, "LLM handoffs stopped being available while the handoff was being written ("+h.llm.svc.Unready()+"); nothing was filed")
	}
}

// stopLLMJob cancels a running job; its goroutine settles it as said.
func (h *Hub) stopLLMJob(j *llmJob, state, code, msg string) {
	if j.cancel == nil || j.filing || j.stop != nil {
		return
	}
	j.stop = &llmStop{state, code, msg}
	j.cancel()
}

// llmSessionSeen cancels worker id's running job when its agent session is
// another than the job's (hub goroutine, the worker's upsert).
func (h *Hub) llmSessionSeen(id, agentSession string) {
	if j := h.llm.byWorker[id]; j != nil && !j.settled() && j.row.AgentSession != agentSession {
		h.stopLLMJob(j, store.HandoffJobFailed, proto.ErrHandoffLLMStale, "the worker's agent session changed while the handoff was being written; nothing was filed")
	}
}

// forgetLLMHandoff ends the job of a worker that is gone (closed or sent
// home): a running one is cancelled.
func (h *Hub) forgetLLMHandoff(id string) {
	j := h.llm.byWorker[id]
	if j == nil {
		return
	}
	if !j.settled() {
		h.stopLLMJob(j, store.HandoffJobFailed, proto.ErrHandoffLLMStale, "the worker left while the handoff was being written; nothing was filed")
	}
	if !j.filing {
		delete(h.llm.byWorker, id)
	}
}

// llmHandoffView is worker id's latest job as clients see it (nil: none).
func (h *Hub) llmHandoffView(id string) *proto.LLMHandoff {
	j := h.llm.byWorker[id]
	if j == nil {
		return nil
	}
	v := j.view()
	return &v
}

// publishLLMHandoff sends the worker's upsert when its job changed.
func (h *Hub) publishLLMHandoff(id string) {
	w := h.workers[id]
	if w == nil {
		return
	}
	v := h.llmHandoffView(id)
	if (w.LLMHandoff == nil && v == nil) || (w.LLMHandoff != nil && v != nil && *w.LLMHandoff == *v) {
		return
	}
	next := *w
	next.LLMHandoff = v
	h.workers[id] = &next
	h.emit(proto.Event{T: proto.EvWorkerUpsert, Worker: &next})
}

// llmRecipient is the configured LLM's model and endpoint host ("" each
// when the roles do not say): what the dialog and the audit name.
func llmRecipient(roles handoffllm.Roles) (model, host string) {
	v, ok := roles.(interface{ View() ai.View })
	if !ok {
		return "", ""
	}
	l := v.View().LLM
	if u, err := url.Parse(l.BaseURL); err == nil {
		host = u.Host
	}
	return l.Model, host
}

// startHandoffLLM answers handoff_llm.get, handoff_llm.set and
// handoff_llm.test off the hub goroutine; a change is published before
// the ack.
func (h *Hub) startHandoffLLM(ctx context.Context, c *Client, cmd proto.Command) error {
	svc := h.llm.svc
	if svc == nil {
		return fmt.Errorf("%w: the bridge has no LLM handoffs (it needs the AI integration and a handoff directory)", errUnsupported)
	}
	var work func(context.Context) (any, error)
	switch cmd.T {
	case proto.CmdHandoffLLMGet:
		if err := decodeArgs(cmd.Args, &struct{}{}); err != nil {
			return err
		}
		work = func(ctx context.Context) (any, error) {
			svc.Refresh(ctx)
			return llmStateOf(svc.View()), nil
		}
	case proto.CmdHandoffLLMSet:
		var a proto.HandoffLLMSetArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return err
		}
		work = func(ctx context.Context) (any, error) {
			err := svc.Apply(ctx, handoffllm.Update{Enabled: a.Enabled, InputBytes: a.InputBytes, MaxTokens: a.MaxTokens, ReasoningEffort: a.ReasoningEffort})
			if err != nil {
				return nil, err
			}
			_ = h.doWait(ctx, h.publishHandoffLLMState)
			return llmStateOf(svc.View()), nil
		}
	default: // handoff_llm.test
		if err := decodeArgs(cmd.Args, &struct{}{}); err != nil {
			return err
		}
		work = func(ctx context.Context) (any, error) {
			res, err := svc.Test(ctx)
			if err != nil {
				return nil, err
			}
			_ = h.doWait(ctx, h.publishHandoffLLMState)
			return testResultOf(res), nil
		}
	}
	h.startAsync(ctx, c, cmd, work)
	return nil
}

// handoffLLMErrorCode maps an error of internal/handoffllm to its protocol
// code; "" when it is none.
func handoffLLMErrorCode(err error) string {
	var fe *handoffllm.Error
	switch {
	case errors.As(err, &fe):
		return fe.Code
	case errors.Is(err, handoffllm.ErrTooLarge):
		return proto.ErrTooLarge
	case errors.Is(err, handoffllm.ErrChanged):
		return proto.ErrHandoffSource
	case errors.Is(err, handoffllm.ErrUnsupported):
		return proto.ErrHandoffUnavailable
	}
	return ""
}

// llmCand is the candidate a preview or a job is of: the one named, else
// the worker's current one.
func (h *Hub) llmCand(id, session, cand, revision string) (*proto.Worker, *handoffCand, error) {
	if cand == "" {
		if w := h.workers[id]; w != nil && h.ho.cands[id] == nil {
			return nil, nil, fmt.Errorf("%w: %s has no completed turn to hand off now: wait until its turn ends", errHandoffUnavailable, w.Name)
		}
		if hc := h.ho.cands[id]; hc != nil {
			cand = hc.c.ID
		}
	}
	return h.handoffCandOf(id, session, cand, revision)
}

// reduceInput is the reducer's request for a candidate's snapshot.
func reduceInput(hc *handoffCand, budget int) handoffllm.Input {
	return handoffllm.Input{Harness: hc.c.Harness, Path: hc.path, File: hc.fi, Through: hc.c.Through, Budget: budget}
}

// reduceSnapshot reduces a candidate's snapshot (off the hub goroutine):
// first the candidate checked to be the transcript's latest completed reply
// still, its lines unchanged (the reducer checks the file and the snapshot's
// end, not the candidate's region), then the reduction.
func reduceSnapshot(ctx context.Context, reduce func(context.Context, handoffllm.Input) (handoffllm.Payload, error), hc *handoffCand, budget int) (handoffllm.Payload, error) {
	if err := transcript.StillLatest(hc.path, hc.fi, &hc.c, hc.end); err != nil {
		return handoffllm.Payload{}, err
	}
	return reduce(ctx, reduceInput(hc, budget))
}

// startLLMPreview answers worker.handoff_preview in mode "llm": what the
// handoff would send and to whom; the reducer runs off the hub goroutine,
// nothing is sent.
func (h *Hub) startLLMPreview(ctx context.Context, c *Client, cmd proto.Command, a proto.WorkerHandoffPreviewArgs) error {
	svc := h.llm.svc
	if svc == nil {
		return fmt.Errorf("%w: the bridge has no LLM handoffs (it needs the AI integration and a handoff directory)", errUnsupported)
	}
	w, hc, err := h.llmCand(a.Worker, "", a.Candidate, "")
	if err != nil {
		return err
	}
	cand := *h.handoffView(a.Worker, w.AgentSession)
	prov, blocked := provenanceOf(w), h.sendHomeBlocked(w)
	why := svc.Unready()
	if why == "" && h.llm.running != nil {
		why = "another LLM handoff is being written: one at a time"
	}
	v := svc.View()
	model, host := llmRecipient(h.llm.roles)
	src, reduce := *hc, h.opts.HandoffReduce
	h.startAsync(ctx, c, cmd, func(ctx context.Context) (any, error) {
		p := &proto.LLMHandoffPreview{Model: model, Host: host, BudgetBytes: v.InputBytes, MaxTokens: v.MaxTokens, TimeoutS: v.TimeoutS,
			PromptVersion: v.PromptVersion, Categories: v.Categories, Redactions: map[string]int{}, Coverage: coverageOf(handoffllm.Coverage{})}
		pl, err := reduceSnapshot(ctx, reduce, &src, v.InputBytes)
		if err == nil {
			p.Reduced, p.PayloadBytes, p.EstTokens, p.Coverage = true, pl.Bytes, pl.EstTokens, coverageOf(pl.Coverage)
			for k, n := range pl.Redactions {
				p.Redactions[k] = n
			}
			for _, ar := range pl.Artifacts {
				p.Artifacts++
				if ar.Verified {
					p.Verified++
				}
			}
		} else if why == "" {
			why = reduceWhy(err)
		}
		p.Ready, p.Unavailable = why == "", why
		return proto.WorkerHandoffPreviewResult{Candidate: &cand, Provenance: prov, CanSendHome: blocked == "", SendHomeBlocked: blocked, LLM: p}, nil
	})
	return nil
}

// reduceWhy says why a reduction failed, in the dialog's words.
func reduceWhy(err error) string {
	switch {
	case errors.Is(err, handoffllm.ErrTooLarge):
		return "your prompts and the final reply alone do not fit the transcript budget (they are always sent whole): raise the budget in Settings, LLM handoffs, or save the last message instead"
	case errors.Is(err, handoffllm.ErrChanged), errors.Is(err, transcript.ErrSourceReplaced), errors.Is(err, transcript.ErrSourceChanged):
		return "the transcript changed since it was last read (replaced or cut): reopen the dialog"
	case errors.Is(err, transcript.ErrNotLatest):
		return "the worker finished another turn since: reopen the dialog for its latest reply"
	case errors.Is(err, transcript.ErrSourceTooLarge):
		return "the transcript has more since the reply than the bridge reads back"
	case errors.Is(err, handoffllm.ErrUnsupported):
		return "this conversation can't be read for an LLM handoff (a subagent's, an empty one, or a format the bridge does not know)"
	}
	return "the transcript could not be read"
}

// llmArgsHash identifies a job's arguments (never stored as text).
func llmArgsHash(a proto.WorkerHandoffArgs) string {
	b, _ := json.Marshal([]any{a.Worker, a.Session, a.Candidate, a.Revision, a.SendHome, a.Instruction})
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// llmReport is the audit-log result of an LLM handoff: ids, the
// recipient, sizes, the elapsed time, the outcome code and the redaction
// counts; never text.
type llmReport struct {
	Worker        string          `json:"worker"`
	Candidate     string          `json:"candidate"`
	Op            string          `json:"op"`
	Model         string          `json:"model"`
	Host          string          `json:"host"`
	PromptVersion string          `json:"prompt_version"`
	PayloadBytes  int             `json:"payload_bytes"`
	EstTokens     int             `json:"est_tokens"`
	SentBytes     int             `json:"sent_bytes"`
	FocusBytes    int             `json:"focus_bytes,omitempty"`
	AnswerBytes   int             `json:"answer_bytes"`
	DocBytes      int             `json:"doc_bytes,omitempty"`
	ElapsedMS     int64           `json:"elapsed_ms"`
	Effort        string          `json:"reasoning_effort,omitempty"`
	MaxTokens     int             `json:"max_tokens,omitempty"`
	Outcome       string          `json:"outcome"`
	Redactions    map[string]int  `json:"redactions,omitempty"`
	Kept          int             `json:"kept"`
	Messages      int             `json:"messages"`
	Complete      bool            `json:"complete"`
	Diag          *ai.Diagnostics `json:"diag,omitempty"`
	Handoff       int64           `json:"handoff,omitempty"`
	Path          string          `json:"path,omitempty"`
	SendHome      string          `json:"send_home,omitempty"`
	Reason        string          `json:"send_home_reason,omitempty"`
}

// startLLMHandoff answers worker.handoff in mode "llm": checked, the job
// stored and audited, answered at once; the work runs off the hub goroutine
// and the job is followed on Worker.LLMHandoff.
func (h *Hub) startLLMHandoff(ctx context.Context, c *Client, cmd proto.Command, a proto.WorkerHandoffArgs) error {
	svc := h.llm.svc
	switch {
	case svc == nil:
		return fmt.Errorf("%w: the bridge has no LLM handoffs (it needs the AI integration and a handoff directory)", errUnsupported)
	case !handoffOp.MatchString(a.Op):
		return bad("op must be 1–%d characters of A-Z, a-z, 0-9, _ and -", proto.MaxHandoffOp)
	case a.Session == "" || a.Candidate == "" || a.Revision == "":
		return bad("session, candidate and revision are required")
	case len(a.Instruction) > proto.MaxHandoffInstruction || !utf8.ValidString(a.Instruction):
		return bad("instruction must be valid UTF-8 of at most %d bytes", proto.MaxHandoffInstruction)
	}
	hash := llmArgsHash(a)
	if prev, err := h.llmJobOf(ctx, a.Op); err == nil {
		if prev.row.WorkerID != a.Worker || prev.row.ArgsHash != hash {
			return fmt.Errorf("%w: op %q was used for another handoff", handoff.ErrOpReused, a.Op)
		}
		h.audit(ctx, c, cmd, nil)
		h.reply(c, cmd, proto.WorkerHandoffJobResult{Job: prev.view(), Existing: true}, nil)
		return nil
	} else if !errors.Is(err, store.ErrNotFound) {
		return err
	}
	if why := svc.Unready(); why != "" {
		return &handoffllm.Error{Code: handoffllm.CodeUnavailable, Msg: why + "; nothing was sent"}
	}
	if h.llm.running != nil {
		return fmt.Errorf("%w: another LLM handoff is being written: one at a time", errBusy)
	}
	w, hc, err := h.handoffCandOf(a.Worker, a.Session, a.Candidate, a.Revision)
	if err != nil {
		return err
	}
	now := h.opts.Now()
	model, host := llmRecipient(h.llm.roles)
	j := &llmJob{model: model, host: host, row: store.HandoffLLMJob{Op: a.Op, WorkerID: w.ID, Floor: workerFloor(w), AgentSession: w.AgentSession,
		Candidate: hc.c.ID, ArgsHash: hash, Config: svc.Fingerprint(), PromptVersion: handoffllm.PromptVersion, SendHome: a.SendHome,
		State: store.HandoffJobRunning, CreatedAt: now.UnixMilli(), UpdatedAt: now.UnixMilli()}}
	// The audit row first, then the job row, then nothing that can fail
	// before the job runs: a stored running job always has its goroutine.
	// When either insert fails nothing is stored, nothing was sent, and the
	// op may be used again (D6).
	auditID, err := h.st.AuditBegin(ctx, c.name, cmd.T, auditArgs(cmd))
	if err != nil {
		return err
	}
	if err := h.st.AddHandoffLLMJob(ctx, j.row); err != nil {
		if errors.Is(err, store.ErrRequestTaken) {
			err = fmt.Errorf("%w: op %q was used for another handoff", handoff.ErrOpReused, a.Op)
		}
		if e := h.st.AuditEnd(ctx, auditID, err, nil); e != nil {
			h.log.Error("audit log write failed", "err", e)
		}
		h.reply(c, cmd, nil, err) // its audit row is the one begun
		return nil
	}
	jctx, cancel := context.WithCancel(ctx)
	j.cancel = cancel
	h.llm.running = j
	h.llm.byWorker[w.ID] = j
	h.publishLLMHandoff(w.ID)
	h.reply(c, cmd, proto.WorkerHandoffJobResult{Job: j.view()}, nil)
	h.log.Info("LLM handoff started", "worker", w.ID, "op", a.Op, "model", clip(model), "host", clip(host))
	facts := handoffllm.Facts{Now: now, Floor: h.workerFloorName(w), Worker: w.Name, Label: w.Label, Harness: harnessOf(w), Model: w.Model,
		Session: hc.c.Session, Candidate: hc.c.ID, Through: hc.c.Through, Cwd: checkoutOf(w), ReportedBranch: w.Branch}
	facts.Skills = h.cachedSkills(w)
	src := handoff.Source{Floor: workerFloor(w), WorkerID: w.ID, WorkerName: w.Name, Label: w.Label, Harness: harnessOf(w), Model: w.Model,
		Cwd: checkoutOf(w), Branch: w.Branch, AgentSession: hc.c.Session, Kind: store.HandoffLLM, Turn: hc.c.ID, Op: a.Op}
	rep := &llmReport{Worker: w.ID, Candidate: hc.c.ID, Op: a.Op, Model: clip(model), Host: clip(host), PromptVersion: handoffllm.PromptVersion}
	cand := *hc
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		defer cancel()
		h.runLLMHandoff(jctx, ctx, j, &cand, facts, src, a, auditID, c.name, rep)
	}()
	return nil
}

// llmJobOf is op's job: in memory, else stored.
func (h *Hub) llmJobOf(ctx context.Context, op string) (*llmJob, error) {
	for _, j := range h.llm.byWorker {
		if j.row.Op == op {
			return j, nil
		}
	}
	row, err := h.st.HandoffLLMJobByOp(ctx, op)
	if err != nil {
		return nil, err
	}
	return &llmJob{row: row}, nil
}

// cachedSkills are the skill names the worker's harness listed in its
// checkout, when the command catalog has them cached (never a probe).
func (h *Hub) cachedSkills(w *proto.Worker) []string {
	cc, ok := h.opts.Commands.(interface {
		Cached(harness, dir string) ([]proto.CommandEntry, bool)
	})
	if !ok || cc == nil {
		return nil
	}
	list, ok := cc.Cached(w.AgentKind, checkoutOf(w))
	if !ok {
		return nil
	}
	var out []string
	for _, e := range list {
		if e.Kind == proto.CommandKindSkill && len(out) < 60 {
			out = append(out, e.Name)
		}
	}
	return out
}

// gitNow reads the checkout's branch and status now, when the bridge's git
// can (facts.GitKnown false otherwise).
func (h *Hub) gitNow(ctx context.Context, f *handoffllm.Facts) {
	g, ok := h.opts.Git.(interface {
		Status(ctx context.Context, dir string) ([]string, error)
		CurrentBranch(ctx context.Context, dir string) (string, error)
	})
	if !ok || g == nil || f.Cwd == "" {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, llmGitWait)
	defer cancel()
	br, err := g.CurrentBranch(ctx, f.Cwd)
	if err != nil {
		return
	}
	st, err := g.Status(ctx, f.Cwd)
	if err != nil {
		return
	}
	f.GitBranch, f.GitStatus, f.GitKnown = br, st, true
}

// runLLMHandoff is a job's work (its own goroutine): reduce, build, the
// call, the checks, the filing; then it settles on the hub goroutine.
func (h *Hub) runLLMHandoff(jctx, hctx context.Context, j *llmJob, hc *handoffCand, facts handoffllm.Facts, src handoff.Source,
	a proto.WorkerHandoffArgs, auditID int64, by string, rep *llmReport) {
	svc := h.llm.svc
	var res handoffllm.Result
	var filed store.Handoff
	err := func() error {
		pl, err := reduceSnapshot(jctx, h.opts.HandoffReduce, hc, svc.InputBytes())
		if err != nil {
			return err
		}
		rep.PayloadBytes, rep.EstTokens, rep.Kept, rep.Messages, rep.Complete = pl.Bytes, pl.EstTokens, pl.Coverage.Kept, pl.Coverage.Messages, pl.Coverage.Complete
		h.gitNow(jctx, &facts)
		p, err := handoffllm.Build(facts, pl, a.Instruction)
		if err != nil {
			return err
		}
		rep.SentBytes, rep.FocusBytes, rep.Redactions = p.Bytes, p.FocusBytes, p.Redactions
		res, err = svc.Generate(jctx, p.Messages)
		rep.AnswerBytes, rep.ElapsedMS, rep.Diag, rep.Effort, rep.MaxTokens = res.Answer, res.Elapsed.Milliseconds(), res.Diag, res.Effort, res.MaxTokens
		if err != nil {
			return err
		}
		// The checks, on the hub goroutine: the job not stopped, the worker
		// there under the same agent session, the same LLM config, the
		// feature still ready. Then it is filed, whatever comes.
		var stale error
		if derr := h.doWait(hctx, func() {
			w := h.workers[j.row.WorkerID]
			switch {
			case j.stop != nil || jctx.Err() != nil:
				stale = context.Canceled
			case w == nil:
				j.stop = &llmStop{store.HandoffJobFailed, proto.ErrHandoffLLMStale, "the worker left while the handoff was being written; nothing was filed"}
				stale = context.Canceled
			case w.AgentSession != j.row.AgentSession:
				j.stop = &llmStop{store.HandoffJobFailed, proto.ErrHandoffLLMStale, "the worker's agent session changed while the handoff was being written; nothing was filed"}
				stale = context.Canceled
			case res.Fingerprint != j.row.Config || svc.Fingerprint() != j.row.Config:
				j.stop = &llmStop{store.HandoffJobFailed, proto.ErrHandoffLLMStale, "the LLM's settings changed while the handoff was being written; nothing was filed"}
				stale = context.Canceled
			case svc.Unready() != "":
				stale = &handoffllm.Error{Code: handoffllm.CodeUnavailable, Msg: svc.Unready() + "; nothing was filed"}
			default:
				j.filing = true
			}
		}); derr != nil {
			return derr
		}
		if stale != nil {
			return stale
		}
		sum := sha256.Sum256([]byte(res.Doc))
		src.Hash, src.At = hex.EncodeToString(sum[:]), h.opts.Now()
		src.Provenance = llmProvenance(j, hc, pl, p.Redactions)
		fctx, cancel := context.WithTimeout(context.WithoutCancel(hctx), llmFileWait)
		defer cancel()
		filed, _, err = h.ho.svc.File(fctx, src, res.Doc)
		if err != nil {
			return fmt.Errorf("%w: %v", errHandoffFailed, err)
		}
		rep.DocBytes = len(res.Doc)
		return nil
	}()
	if derr := h.doWait(hctx, func() { h.settleLLMJob(hctx, j, filed, err, auditID, by, rep) }); derr != nil {
		h.log.Warn("LLM handoff abandoned", "worker", j.row.WorkerID, "op", j.row.Op, "err", derr)
	}
}

// llmProvenance is a filed LLM handoff's front-matter provenance.
func llmProvenance(j *llmJob, hc *handoffCand, pl handoffllm.Payload, red map[string]int) map[string]string {
	c := pl.Coverage
	cov := fmt.Sprintf("%d of %d messages kept", c.Kept, c.Messages)
	if c.Compaction != "" && c.Compaction != "none" {
		cov += "; compaction " + c.Compaction
	}
	switch n := len(c.Gaps); {
	case n == 1:
		cov += "; 1 coverage gap"
	case n > 1:
		cov += fmt.Sprintf("; %d coverage gaps", n)
	}
	if c.Complete {
		cov += "; complete"
	}
	prov := map[string]string{"llm_model": j.model, "llm_host": j.host, "prompt_version": j.row.PromptVersion,
		"snapshot": fmt.Sprintf("%s@%d", hc.c.ID, hc.c.Through), "coverage": cov}
	if len(red) > 0 {
		b, _ := json.Marshal(red)
		prov["redactions"] = string(b)
	}
	return prov
}

// llmFailure is a failed job's state, code and short message: never the
// model's text, never a provider's detail.
func llmFailure(j *llmJob, err error) (state, code, msg string) {
	if j.stop != nil && (errors.Is(err, context.Canceled) || handoffllm.Reason(err) == handoffllm.CodeUnavailable) {
		return j.stop.state, j.stop.code, j.stop.msg
	}
	var fe *handoffllm.Error
	var ae *ai.Error
	switch {
	case errors.As(err, &fe):
		return store.HandoffJobFailed, fe.Code, fe.Msg
	case errors.Is(err, handoffllm.ErrBusy):
		return store.HandoffJobFailed, proto.ErrBusy, "another LLM handoff was being written: one at a time; nothing was sent"
	case errors.As(err, &ae):
		msg, _, _ := strings.Cut(ae.Msg, ": ")
		switch ae.Kind {
		case ai.KindTimeout:
			msg = fmt.Sprintf("the LLM did not answer within %d s", int(handoffllm.Timeout/time.Second))
		case ai.KindTruncated:
			msg = "the LLM's answer was cut off at the completion budget: raise it in Settings, LLM handoffs"
		}
		if ae.Kind != ai.KindNotReady && ae.Kind != ai.KindAuthFailed && ae.Kind != ai.KindRateLimited {
			msg += "; it was not sent again"
		}
		return store.HandoffJobFailed, string(ae.Kind), msg + "; nothing was filed"
	case handoffLLMErrorCode(err) != "":
		return store.HandoffJobFailed, handoffLLMErrorCode(err), reduceWhy(err) + "; nothing was sent"
	case errors.Is(err, transcript.ErrNotLatest), errors.Is(err, transcript.ErrSourceReplaced), errors.Is(err, transcript.ErrSourceChanged),
		errors.Is(err, transcript.ErrSourceTooLarge):
		return store.HandoffJobFailed, handoffErrorCode(err), reduceWhy(err) + "; nothing was sent"
	case errors.Is(err, errHandoffFailed):
		return store.HandoffJobFailed, proto.ErrHandoffFailed, "the handoff was written but could not be filed"
	case errors.Is(err, context.Canceled):
		return store.HandoffJobCancelled, "cancelled", "cancelled; nothing was filed"
	}
	return store.HandoffJobFailed, proto.ErrInternal, "the handoff failed; nothing was filed"
}

// settleLLMJob ends a job (hub goroutine): filed (handoff.added, then the
// send home when asked) or failed; the row, the audit row, the worker.
func (h *Hub) settleLLMJob(ctx context.Context, j *llmJob, filed store.Handoff, err error, auditID int64, by string, rep *llmReport) {
	if h.llm.running == j {
		h.llm.running = nil
	}
	j.cancel, j.filing = nil, false
	j.row.UpdatedAt = h.opts.Now().UnixMilli()
	var aerr error
	if err == nil {
		j.row.State, j.row.Code, j.row.Message, j.row.HandoffID = store.HandoffJobFiled, "", "", filed.ID
		rep.Outcome, rep.Handoff, rep.Path = "filed", filed.ID, filed.Path
		h.ho.counts[filed.Floor]++
		n := h.ho.counts[filed.Floor]
		e := entryOf(filed)
		h.emit(proto.Event{T: proto.EvHandoffAdded, Session: h.sessionOf(filed.Floor), FloorID: filed.Floor, Handoff: &e, HandoffCount: &n})
		h.log.Info("LLM handoff filed", "worker", j.row.WorkerID, "op", j.row.Op, "handoff", filed.ID, "path", filed.Path, "bytes", rep.DocBytes)
		if j.row.SendHome {
			j.homeResult, j.homeWhy = h.handoffSendHome(ctx, by, j.row.WorkerID, filed.ID)
			rep.SendHome, rep.Reason = j.homeResult, j.homeWhy
		}
	} else {
		j.row.State, j.row.Code, j.row.Message = llmFailure(j, err)
		rep.Outcome = j.row.Code
		aerr = errors.New(j.row.Code)
		h.log.Warn("LLM handoff not filed", "worker", j.row.WorkerID, "op", j.row.Op, "code", j.row.Code)
	}
	if serr := h.st.UpdateHandoffLLMJob(ctx, j.row); serr != nil {
		h.log.Error("saving the LLM handoff job failed", "op", j.row.Op, "err", serr)
	}
	if e := h.st.AuditEnd(ctx, auditID, aerr, rep); e != nil {
		h.log.Error("audit log write failed", "err", e)
	}
	if h.llm.byWorker[j.row.WorkerID] == j {
		if h.workers[j.row.WorkerID] == nil {
			delete(h.llm.byWorker, j.row.WorkerID)
		} else {
			h.publishLLMHandoff(j.row.WorkerID)
		}
	}
}

// llmHandoffCancel answers worker.handoff_cancel for an LLM job (ok false:
// the op is no LLM job of the worker's): a running one is cancelled (one
// being filed goes on), a settled one dismissed from the worker.
func (h *Hub) llmHandoffCancel(ctx context.Context, c *Client, cmd proto.Command, a proto.WorkerHandoffCancelArgs) (bool, error) {
	j := h.llm.byWorker[a.Worker]
	if j == nil || j.row.Op != a.Op {
		return false, nil
	}
	switch {
	case j.filing:
		return true, fmt.Errorf("%w: the handoff is being filed", errBusy)
	case !j.settled():
		h.stopLLMJob(j, store.HandoffJobCancelled, "cancelled", "cancelled; nothing was filed")
	default:
		delete(h.llm.byWorker, a.Worker)
		h.publishLLMHandoff(a.Worker)
	}
	h.audit(ctx, c, cmd, nil)
	h.reply(c, cmd, j.view(), nil)
	return true, nil
}

// coverageOf is a reduction's coverage as the protocol says it.
func coverageOf(c handoffllm.Coverage) proto.HandoffCoverage {
	out := proto.HandoffCoverage{Messages: c.Messages, Kept: c.Kept, Omitted: []proto.HandoffRange{}, Compaction: c.Compaction,
		Gaps: append([]string{}, c.Gaps...), Abandoned: c.Abandoned, Sidechains: c.Sidechains, Deduplicated: c.Deduplicated,
		Skipped: c.Skipped, Complete: c.Complete}
	for _, r := range c.Omitted {
		out.Omitted = append(out.Omitted, proto.HandoffRange{From: r.From, To: r.To, Why: r.Why})
	}
	return out
}

// llmStateOf is the feature's view as the protocol says it.
func llmStateOf(v handoffllm.View) proto.HandoffLLMState {
	s := proto.HandoffLLMState{Enabled: v.Enabled, State: v.State, Missing: v.Missing, Env: v.Env, Tested: v.Tested, InputBytes: v.InputBytes,
		MaxTokens: v.MaxTokens, ReasoningEffort: v.ReasoningEffort, Reasoning: v.Reasoning, EffortStale: v.EffortStale, TimeoutS: v.TimeoutS,
		PromptVersion: v.PromptVersion, Categories: v.Categories}
	s.Roles.LLM = v.Roles.LLM
	return s
}

// testResultOf is handoff_llm.test's ack.
func testResultOf(r *handoffllm.TestResult) proto.HandoffLLMTestResult {
	return proto.HandoffLLMTestResult{OK: r.OK, Reason: r.Reason, Title: r.Title, Bytes: r.Bytes, LatencyMS: r.LatencyMS, Diag: r.Diag}
}

// llmProvenanceOf is a handoff's LLM provenance from its front matter (nil:
// not an LLM handoff).
func llmProvenanceOf(src string, fm map[string]string) *proto.HandoffLLMProvenance {
	if src != store.HandoffLLM {
		return nil
	}
	p := &proto.HandoffLLMProvenance{Model: fm["llm_model"], Host: fm["llm_host"], PromptVersion: fm["prompt_version"],
		Snapshot: fm["snapshot"], Coverage: fm["coverage"]}
	if r := fm["redactions"]; r != "" {
		_ = json.Unmarshal([]byte(r), &p.Redactions)
	}
	return p
}
