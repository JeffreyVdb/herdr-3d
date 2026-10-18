package server

// #224: "Ask the agent". worker.handoff in mode "agent" (the F dialog), or
// a composer prompt that is exactly "/handoff [instruction]" (worker.prompt,
// read before any translation), asks an idle or done worker's own agent to
// write a handoff with its handoff skill. The bridge checks the worker's
// command catalog lists the skill, reserves the file through the cabinet's
// service (handoff.Reserve: a hidden pending directory the startup
// reconcile never registers from), stores the request (SQLite
// handoff_request: its op, nonce, path, transcript offset), and sends one
// prompt: the skill in the harness's own spelling (harness.SkillCall:
// Claude "/handoff", Codex "$handoff"), the instruction, where to write the
// file (<path>.tmp, then renamed to <path>), the bridge's front matter
// values and a marker with the request's nonce.
//
// The usage tracker follows the transcript from the request's offset with
// a transcript.MarkerTracker (the wrap-up's turn rules) and looks at the
// reserved file every round. The request is filed (handoff.Adopt: the
// bridge's front matter, never the agent's; the common filing path) only
// once both hold: the turn that answered the marked prompt ended, herdr
// says idle or done for the debounce with no question, and the file is
// complete (no .tmp, a regular file). Either may come first. It fails,
// keeping the worker, on: no result within the timeout (10 min), a
// cancellation, the worker's agent session or transcript changing, a person
// prompting, typing or answering the worker, the turn ending without the
// file (after a short grace), the skill missing. A failed request's file
// goes to the trash. The send home asked for starts only after it was
// filed. No model is called by the bridge.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/handoff"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/promptsecret"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
	"github.com/JeffreyVdb/herdr-3d/internal/usage"
)

// Agent handoff timings.
const (
	// DefaultAgentHandoffTimeout is how long a request waits for its file
	// and its turn's end.
	DefaultAgentHandoffTimeout = 10 * time.Minute
	// DefaultAgentHandoffGrace is how long after the turn ended (and
	// herdr's idle held) the file may still appear.
	DefaultAgentHandoffGrace = 5 * time.Second
	// agentHandoffSkillWait bounds the catalog lookup of the skill.
	agentHandoffSkillWait = 10 * time.Second
	// agentHandoffFind is how long a starting request waits for the
	// worker's transcript to be found (a transcript not found is looked for
	// again every WatchedRescan while a request runs).
	agentHandoffFind = 2*WatchedRescan + 2*time.Second
	// agentHandoffKeep is how long a settled request's row is kept (its op
	// answers a retry).
	agentHandoffKeep = 30 * 24 * time.Hour
)

// AgentHandoffMarker starts the marker line a request's prompt ends with.
const AgentHandoffMarker = "H3D-HANDOFF"

var errSkillMissing = errors.New("no handoff skill")

// agentHandoff is an agent handoff request (hub goroutine).
type agentHandoff struct {
	req   store.HandoffRequest
	at    time.Time // the request's time (the handoff's date)
	state string    // proto.AgentHandoff*
	// checking: the starting checks (catalog, reservation) run.
	checking bool
	// Starting: the command, its client and audit row, the text to
	// prompt, how to answer it, (agentAsk.settle) whom to tell and
	// (agentAsk.rev) its review.
	client  *Client
	cmd     proto.Command
	auditID int64
	text    string
	answer  func(r proto.AgentHandoff, existing bool, queued bool) any
	settle  func(err error, existing bool)
	rev     *promptsecret.Reviewer
	// sending: the lane is sending the request's prompt, so the send's
	// result settles, not the request's end (settleAgentStart).
	sending bool
	by      string
	// The tracker's last look at the ended turn: its line count, since
	// when; and since when the turn ended with herdr idle.
	lines   int
	quietAt time.Time
	idleAt  time.Time
	// Filed: the handoff and how the send home went.
	handoff           *store.Handoff
	sendHome, homeWhy string
}

// agentHandoffState is the hub's part (hub goroutine).
type agentHandoffState struct {
	byOp     map[string]*agentHandoff
	byWorker map[string]*agentHandoff // the request a worker shows
}

// agentWatch is what the usage tracker needs of a request.
type agentWatch struct {
	op, nonce, marker string
	offset            int64 // -1: take the session's tail after this round's read
	written           func() error
}

// agentUpdate is the tracker's look at a request, every round.
type agentUpdate struct {
	op, nonce string
	key       string
	offset    int64
	found     bool
	state     transcript.WrapUpState
	file      error // handoff.Service.Written
}

func agentMarker(nonce string) string { return "(" + AgentHandoffMarker + " " + nonce + ")" }

func (ah *agentHandoff) pending() bool {
	return ah.state == proto.AgentHandoffStarting || ah.state == proto.AgentHandoffPending || ah.state == proto.AgentHandoffFiling
}

func (ah *agentHandoff) view() proto.AgentHandoff {
	v := proto.AgentHandoff{Op: ah.req.Op, State: ah.state, Reason: ah.req.Reason, StartedAt: ah.req.CreatedAt,
		Instruction: ah.req.Instruction, SendHome: ah.req.SendHome, SendHomeResult: ah.sendHome, SendHomeReason: ah.homeWhy}
	if ah.handoff != nil {
		v.Handoff = ah.handoff.ID
	} else {
		v.Handoff = ah.req.HandoffID
	}
	return v
}

// loadAgentHandoffs reads the pending requests (NewHub, after the cabinet):
// one whose prompt was sent resumes from its offset while its timeout
// runs; one never sent, or out of time, failed. Reserved files of no
// pending request go to the trash; settled rows a month old are forgotten.
func (h *Hub) loadAgentHandoffs(ctx context.Context) error {
	h.ah = agentHandoffState{byOp: map[string]*agentHandoff{}, byWorker: map[string]*agentHandoff{}}
	if h.ho.svc == nil {
		return nil
	}
	now := h.opts.Now()
	if err := h.st.PruneHandoffRequests(ctx, now.Add(-agentHandoffKeep).UnixMilli()); err != nil {
		return err
	}
	rows, err := h.st.HandoffRequests(ctx, store.HandoffRequestPending)
	if err != nil {
		return err
	}
	keep := map[string]bool{}
	for _, r := range rows {
		ah := &agentHandoff{req: r, at: time.UnixMilli(r.CreatedAt), state: proto.AgentHandoffPending, lines: -1, by: "handoff"}
		h.ah.byOp[r.Op] = ah
		h.ah.byWorker[r.WorkerID] = ah
		switch {
		case r.Offset < 0 || !transcript.ValidWrapUpNonce(r.Nonce):
			h.failAgentHandoff(ctx, ah, "the bridge restarted before the request was sent")
		case now.Sub(ah.at) >= h.opts.AgentHandoffTimeout:
			h.failAgentHandoff(ctx, ah, "no handoff within "+h.opts.AgentHandoffTimeout.String()+" (the bridge was restarted)")
		default:
			keep[r.Path] = true
			h.log.Info("agent handoff resumed", "worker", r.WorkerID, "op", r.Op, "offset", r.Offset)
		}
	}
	if n, err := h.ho.svc.CleanPending(keep); err != nil {
		h.log.Warn("cleaning the pending handoffs failed", "err", err)
	} else if n > 0 {
		h.log.Info("pending handoff files of no request moved to the trash", "files", n)
	}
	return nil
}

// agentHandoffView is worker id's request as clients see it (nil: none).
func (h *Hub) agentHandoffView(id string) *proto.AgentHandoff {
	ah := h.ah.byWorker[id]
	if ah == nil {
		return nil
	}
	v := ah.view()
	return &v
}

// publishAgentHandoff sends the worker's upsert when its request changed.
func (h *Hub) publishAgentHandoff(id string) {
	w := h.workers[id]
	if w == nil {
		return
	}
	v := h.agentHandoffView(id)
	if (w.AgentHandoff == nil && v == nil) || (w.AgentHandoff != nil && v != nil && *w.AgentHandoff == *v) {
		return
	}
	next := *w
	next.AgentHandoff = v
	h.workers[id] = &next
	h.emit(proto.Event{T: proto.EvWorkerUpsert, Worker: &next})
}

// agentWatchOf is what the tracker watches of worker id's request (nil:
// none).
func (h *Hub) agentWatchOf(id string) *agentWatch {
	ah := h.ah.byWorker[id]
	if ah == nil || ah.checking || h.ho.svc == nil {
		return nil
	}
	svc, path := h.ho.svc, ah.req.Path
	aw := &agentWatch{op: ah.req.Op, nonce: ah.req.Nonce, marker: agentMarker(ah.req.Nonce), offset: ah.req.Offset,
		written: func() error { return svc.Written(path) }}
	switch ah.state {
	case proto.AgentHandoffStarting:
		aw.offset = -1
	case proto.AgentHandoffPending:
	default:
		return nil
	}
	return aw
}

// handoffCommand reads a composer prompt that is exactly "/handoff" or
// "/handoff <instruction>" (the trimmed text starts with it, then a blank
// or the end): the instruction (blank: none). Prose, a quoted example, a
// path ("/handoff/x") or the command anywhere else is not it.
func handoffCommand(text string) (string, bool) {
	t := strings.TrimSpace(text)
	name := "/" + proto.HandoffSkill
	if !strings.HasPrefix(t, name) {
		return "", false
	}
	rest := t[len(name):]
	if rest != "" {
		r, _ := utf8.DecodeRuneInString(rest)
		if !unicode.IsSpace(r) {
			return "", false
		}
	}
	return strings.TrimSpace(rest), true
}

// agentAsk is a request to start: the worker, op, instruction (as given),
// send home, and how its command is answered.
type agentAsk struct {
	worker, op, instruction string
	sendHome                bool
	// prompt: it came from the composer (a pending request of the worker
	// is answered, not refused).
	prompt bool
	answer func(r proto.AgentHandoff, existing bool, queued bool) any
	// settle (#108, nil: none) is told once (hub goroutine) how the
	// request's prompt ended: existing when another request answered the
	// command; else, until the lane begins to send the prompt, with the
	// request's end (the error of one that failed once started) as the
	// command is answered, and from then on with the send's result
	// whatever ended the request meanwhile: nil when the prompt may have
	// reached the terminal (sent, or failed without knowing), the error
	// when none of it did. Never for a refusal startAgentHandoff returns.
	settle func(err error, existing bool)
	// rev (#108, nil: none) is the instruction's review, checked again
	// right before the request's prompt goes (review B2, pass 2).
	rev *promptsecret.Reviewer
}

// agentInstruction is an instruction as sent: trimmed, the default when
// blank; checked.
func agentInstruction(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return proto.DefaultHandoffInstruction, nil
	}
	if len(s) > proto.MaxHandoffInstruction || !utf8.ValidString(s) || strings.ContainsRune(s, 0) {
		return "", bad("instruction must be at most %d bytes of UTF-8 without NUL, got %d bytes", proto.MaxHandoffInstruction, len(s))
	}
	return s, nil
}

// agentCannotAsk says why worker w's agent cannot be asked for a handoff
// now ("": it can), and the error to refuse with.
func (h *Hub) agentCannotAsk(w *proto.Worker) (string, error) {
	kind := w.AgentKind
	switch {
	case h.ho.svc == nil:
		return "the bridge has no handoff directory", fmt.Errorf("%w: the bridge has no handoff directory", errUnsupported)
	case h.opts.Usage == nil:
		return "the bridge does not read the agents' transcripts", errors.New("agent handoffs need the agents' transcripts, which this bridge does not read")
	case h.opts.Commands == nil || h.opts.Term == nil:
		return "the bridge cannot list skills or prompt workers", errors.New("agent handoffs are not configured")
	case kind != transcript.Claude && kind != transcript.Codex:
		why := w.Name + " runs no Claude or Codex agent"
		return why, fmt.Errorf("%w: %s", errInvalidState, why)
	case w.PaneID == "":
		why := w.Name + " has no pane"
		return why, fmt.Errorf("%w: %s", errInvalidState, why)
	case w.Ask != nil:
		why := w.Name + " waits on its question: answer it first"
		return why, fmt.Errorf("%w: %s", errInvalidState, why)
	case w.Status != statusIdle && w.Status != statusDone:
		why := w.Name + " is " + w.Status + ": only an idle or done worker can be asked for a handoff"
		return why, fmt.Errorf("%w: %s", errInvalidState, why)
	}
	if wu := h.wrapups[w.ID]; wu != nil && wu.state != proto.WrapUpNeedsYou {
		why := w.Name + " is wrapping up"
		return why, fmt.Errorf("%w: %s", errBusy, why)
	}
	if ah := h.ah.byWorker[w.ID]; ah != nil && ah.pending() {
		why := w.Name + " is writing a handoff already"
		return why, fmt.Errorf("%w: %s", errBusy, why)
	}
	return "", nil
}

// startAgentHandoff starts an agent handoff request (hub goroutine): an op
// known answers its request; else the worker is checked, then (off the
// hub) the skill and the reservation, then the tracker takes the
// transcript offset, then the prompt goes out on the worker's input lane;
// the reply follows the prompt.
func (h *Hub) startAgentHandoff(ctx context.Context, c *Client, cmd proto.Command, a agentAsk) error {
	if !handoffOp.MatchString(a.op) {
		return bad("op must be 1–%d characters of A-Z, a-z, 0-9, _ and -", proto.MaxHandoffOp)
	}
	instruction, err := agentInstruction(a.instruction)
	if err != nil {
		return err
	}
	if ah := h.ah.byOp[a.op]; ah != nil {
		if ah.req.WorkerID != a.worker {
			return bad("op %q is another worker's handoff", a.op)
		}
		h.answerKnown(ctx, c, cmd, ah.view(), a)
		return nil
	}
	if h.ho.svc != nil {
		if r, err := h.st.HandoffRequestByOp(ctx, a.op); err == nil {
			if r.WorkerID != a.worker {
				return bad("op %q is another worker's handoff", a.op)
			}
			ah := &agentHandoff{req: r, state: r.State}
			h.answerKnown(ctx, c, cmd, ah.view(), a)
			return nil
		} else if !errors.Is(err, store.ErrNotFound) {
			return err
		}
	}
	w := h.workers[a.worker]
	if w == nil {
		return fmt.Errorf("%w: %q", errUnknownWorker, a.worker)
	}
	if _, _, err := h.termWorker(a.worker); err != nil {
		return err
	}
	if ah := h.ah.byWorker[w.ID]; a.prompt && ah != nil && ah.pending() {
		h.answerKnown(ctx, c, cmd, ah.view(), a)
		return nil
	}
	if _, err := h.agentCannotAsk(w); err != nil {
		return err
	}
	auditID, err := h.st.AuditBegin(ctx, c.name, cmd.T, auditArgs(cmd))
	if err != nil {
		return err
	}
	now := h.opts.Now()
	ah := &agentHandoff{req: store.HandoffRequest{Op: a.op, WorkerID: w.ID, Floor: workerFloor(w), Harness: w.AgentKind,
		AgentSession: w.AgentSession, Offset: -1, Nonce: randHex(8), Instruction: instruction, SendHome: a.sendHome,
		State: store.HandoffRequestPending, CreatedAt: now.UnixMilli()}, at: now, state: proto.AgentHandoffStarting,
		checking: true, client: c, cmd: cmd, auditID: auditID, answer: a.answer, settle: a.settle, rev: a.rev, by: c.name, lines: -1}
	h.ah.byOp[a.op] = ah
	h.ah.byWorker[w.ID] = ah
	h.publishAgentHandoff(w.ID)
	h.log.Info("agent handoff starting", "client", c.name, "req_id", cmd.ReqID, "worker", w.ID, "op", a.op)
	kind, dir, floor, svc := w.AgentKind, checkoutOf(w), w.Session, h.ho.svc
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		call, err := h.agentHandoffSkill(ctx, kind, dir)
		var path string
		if err == nil {
			path, err = svc.Reserve(floor, a.op)
		}
		// The request is the hub's: what was found is set there.
		_ = h.doWait(ctx, func() {
			if h.ah.byOp[a.op] != ah || ah.state != proto.AgentHandoffStarting {
				h.agentStartEnded(ctx, ah, path) // cancelled (or gone) meanwhile
				return
			}
			if err != nil {
				h.failAgentHandoff(ctx, ah, err.Error())
				h.endAgentStart(ctx, ah, err)
				return
			}
			ah.req.Path = path
			if err := h.agentHandoffPrompt(ah, call); err != nil {
				h.failAgentHandoff(ctx, ah, err.Error())
				h.endAgentStart(ctx, ah, err)
				return
			}
			if err := h.st.AddHandoffRequest(ctx, ah.req); err != nil {
				if errors.Is(err, store.ErrRequestTaken) {
					err = fmt.Errorf("%w: a handoff request with this op exists", errBusy)
				}
				h.failAgentHandoff(ctx, ah, err.Error())
				h.endAgentStart(ctx, ah, err)
				return
			}
			ah.checking = false
			h.kickUsage()
		})
	}()
	return nil
}

// agentStartEnded settles a request that ended (cancelled, the worker gone,
// a person took over) while its skill was looked up and its file reserved
// (hub goroutine): nothing was sent; the request is stored as it ended,
// with the path reserved for it, so its op answers a retry after a
// restart too, and the reserved file goes to the trash.
func (h *Hub) agentStartEnded(ctx context.Context, ah *agentHandoff, path string) {
	if path == "" || ah.req.Path != "" || ah.pending() {
		return
	}
	ah.req.Path, ah.req.State = path, store.HandoffRequestFailed
	if err := h.st.AddHandoffRequest(ctx, ah.req); err != nil {
		h.log.Error("saving the handoff request failed", "op", ah.req.Op, "err", err)
	}
	if err := h.ho.svc.Discard(path); err != nil {
		h.log.Warn("discarding the agent's handoff file failed", "path", path, "err", err)
	}
}

// agentHandoffSkill checks the harness lists a handoff skill in the
// checkout (off the hub goroutine) and returns how the harness runs it.
func (h *Hub) agentHandoffSkill(ctx context.Context, kind, dir string) (string, error) {
	if !herdr.ValidDir(dir) {
		return "", fmt.Errorf("%w: the worker has no working directory to list its skills in", errInvalidState)
	}
	ctx, cancel := context.WithTimeout(ctx, agentHandoffSkillWait)
	defer cancel()
	res, err := h.opts.Commands.Commands(ctx, kind, dir)
	switch {
	case err != nil:
		return "", fmt.Errorf("%w: its skills could not be listed: %v", errSkillMissing, err)
	case !listsSkill(res.Commands, proto.HandoffSkill) && res.Partial:
		return "", fmt.Errorf("%w: its skills could not be listed, so the handoff skill could not be found", errSkillMissing)
	case !listsSkill(res.Commands, proto.HandoffSkill):
		return "", fmt.Errorf("%w: %s lists no %q skill in %s", errSkillMissing, kind, proto.HandoffSkill, dir)
	}
	call := "/" + proto.HandoffSkill
	if h.opts.Prompts != nil {
		call = h.opts.Prompts.SkillCall(kind, proto.HandoffSkill)
	}
	return call, nil
}

// listsSkill reports whether a command catalog lists a skill name that no
// built-in of the same name shadows (the built-in is what the name runs).
func listsSkill(cmds []proto.CommandEntry, name string) bool {
	skill := false
	for _, c := range cmds {
		if c.Name != name {
			continue
		}
		switch c.Kind {
		case proto.CommandKindSkill:
			skill = true
		case proto.CommandKindBuiltin:
			return false
		}
	}
	return skill
}

// agentHandoffPrompt builds a request's prompt: the skill call and the
// instruction, the file's path (written as a .tmp, then renamed), the
// bridge's front matter values, the title rule and the marker. It must fit
// a prompt and, for Claude, be typed.
func (h *Hub) agentHandoffPrompt(ah *agentHandoff, call string) error {
	w := h.workers[ah.req.WorkerID]
	if w == nil {
		return fmt.Errorf("%w: %q is gone", errUnknownWorker, ah.req.WorkerID)
	}
	fm := []struct{ k, v string }{{"date", ah.at.Local().Format(time.RFC3339)}, {"floor", w.Session}, {"worker", w.Name},
		{"branch", w.Branch}, {"harness", harnessOf(w)}, {"model", w.Model}, {"session", w.AgentSession}, {"source", "agent"}}
	var b strings.Builder
	b.WriteString(call + " " + ah.req.Instruction + "\n\n")
	b.WriteString("Save the handoff document at this exact path, not in the temporary directory: write it to " +
		ah.req.Path + ".tmp first, then rename that file to " + ah.req.Path + " once it is complete.\n")
	b.WriteString("Begin the document with this front matter, as given:\n---\n")
	for _, kv := range fm {
		if kv.v != "" {
			q, _ := json.Marshal(kv.v)
			b.WriteString(kv.k + ": " + string(q) + "\n")
		}
	}
	b.WriteString("---\nThen one specific H1 title of at most 80 characters, then the handoff.\n\n")
	b.WriteString(agentMarker(ah.req.Nonce))
	text := b.String()
	if !herdr.ValidMessage(text) {
		return bad("the handoff request is %d bytes, more than a prompt may have (%d): shorten the instruction", len(text), herdr.MaxMessage)
	}
	if err := checkTyped(w.AgentKind, text, herdr.MaxMessage, "instruction"); err != nil {
		return err
	}
	ah.text = text
	return nil
}

// answerKnown answers a's command with a request it names (its op, or the
// worker's pending one): nothing is sent again.
func (h *Hub) answerKnown(ctx context.Context, c *Client, cmd proto.Command, v proto.AgentHandoff, a agentAsk) {
	if a.settle != nil {
		a.settle(nil, true)
	}
	h.audit(ctx, c, cmd, nil)
	h.reply(c, cmd, a.answer(v, true, false), nil)
}

// settleAgentStart tells a request's settle how its prompt ended, once.
func (h *Hub) settleAgentStart(ah *agentHandoff, err error) {
	if settle := ah.settle; settle != nil {
		ah.settle = nil
		settle(err, false)
	}
}

// endAgentStart tells a starting request's settle how it ended unless its
// prompt is being sent (the send settles), then writes its audit row and
// replies to its command (once).
func (h *Hub) endAgentStart(ctx context.Context, ah *agentHandoff, err error, queued ...bool) {
	if !ah.sending {
		h.settleAgentStart(ah, err)
	}
	if ah.client == nil {
		return
	}
	rep := struct {
		Worker string `json:"worker"`
		Op     string `json:"op"`
		Nonce  string `json:"nonce,omitempty"`
		Path   string `json:"path,omitempty"`
		Offset int64  `json:"offset"`
		Queued bool   `json:"queued,omitempty"`
	}{ah.req.WorkerID, ah.req.Op, ah.req.Nonce, ah.req.Path, ah.req.Offset, len(queued) > 0 && queued[0]}
	if aerr := h.st.AuditEnd(ctx, ah.auditID, err, rep); aerr != nil {
		h.log.Error("audit log write failed", "err", aerr)
	}
	if err != nil {
		h.reply(ah.client, ah.cmd, nil, err)
	} else {
		h.reply(ah.client, ah.cmd, ah.answer(ah.view(), false, rep.Queued), nil)
	}
	ah.client = nil
}

// saveAgentHandoff records a request's state in the store.
func (h *Hub) saveAgentHandoff(ctx context.Context, ah *agentHandoff) {
	switch ah.state {
	case proto.AgentHandoffFiled:
		ah.req.State = store.HandoffRequestFiled
	case proto.AgentHandoffFailed:
		ah.req.State = store.HandoffRequestFailed
	default:
		ah.req.State = store.HandoffRequestPending
	}
	if ah.handoff != nil {
		ah.req.HandoffID = ah.handoff.ID
	}
	if err := h.st.UpdateHandoffRequest(ctx, ah.req); err != nil && !errors.Is(err, store.ErrNotFound) {
		h.log.Error("saving the handoff request failed", "op", ah.req.Op, "err", err)
	}
}

// failAgentHandoff ends a request without a handoff: failed, with why; the
// worker stays, and its reserved file (if the agent wrote one) goes to the
// trash.
func (h *Hub) failAgentHandoff(ctx context.Context, ah *agentHandoff, reason string) {
	if !ah.pending() && ah.state != "" {
		return
	}
	reason = strings.TrimSpace(reason)
	if len(reason) > proto.MaxWrapUpReason {
		reason = reason[:proto.MaxWrapUpReason]
		for !utf8.ValidString(reason) {
			reason = reason[:len(reason)-1]
		}
	}
	ah.state, ah.req.Reason, ah.checking = proto.AgentHandoffFailed, reason, false
	h.saveAgentHandoff(ctx, ah)
	if ah.req.Path != "" && h.ho.svc != nil {
		if err := h.ho.svc.Discard(ah.req.Path); err != nil {
			h.log.Warn("discarding the agent's handoff file failed", "path", ah.req.Path, "err", err)
		}
	}
	h.log.Info("agent handoff failed", "worker", ah.req.WorkerID, "op", ah.req.Op, "reason", reason)
	h.publishAgentHandoff(ah.req.WorkerID)
}

// agentTookOver fails a worker's running request when a person prompts,
// types into or answers the worker (worker.prompt, worker.keys,
// worker.answer, worker.answer_ask, worker.answer_followup): its turn is
// not the bridge's any more. One being filed goes on.
func (h *Hub) agentTookOver(ctx context.Context, id string) {
	ah := h.ah.byWorker[id]
	if ah == nil || (ah.state != proto.AgentHandoffStarting && ah.state != proto.AgentHandoffPending) {
		return
	}
	h.failAgentHandoff(ctx, ah, "a person took over")
	h.endAgentStart(ctx, ah, fmt.Errorf("%w: a prompt, keys or an answer came first", errInvalidState))
}

// forgetAgentHandoff ends the request of a worker that is gone (closed in
// herdr or sent home): a running one failed.
func (h *Hub) forgetAgentHandoff(ctx context.Context, id string) {
	ah := h.ah.byWorker[id]
	if ah == nil {
		return
	}
	if ah.state == proto.AgentHandoffStarting || ah.state == proto.AgentHandoffPending {
		h.failAgentHandoff(ctx, ah, "the worker is gone")
		h.endAgentStart(ctx, ah, fmt.Errorf("%w: %q is gone", errUnknownWorker, id))
	}
	if ah.state != proto.AgentHandoffFiling {
		delete(h.ah.byWorker, id)
	}
}

// agentSeen applies the tracker's look at a request (hub goroutine).
func (h *Hub) agentSeen(ctx context.Context, u agentUpdate) {
	ah := h.ah.byOp[u.op]
	if ah == nil || ah.req.Nonce != u.nonce || ah.checking || h.ah.byWorker[ah.req.WorkerID] != ah {
		return
	}
	switch ah.state {
	case proto.AgentHandoffStarting:
		h.agentArmed(ctx, ah, u)
		return
	case proto.AgentHandoffPending:
	default:
		return
	}
	w := h.workers[ah.req.WorkerID]
	if w == nil {
		return
	}
	now := h.opts.Now()
	st := u.state
	switch {
	case !u.found || u.key != ah.req.Transcript || u.offset != ah.req.Offset:
		h.failAgentHandoff(ctx, ah, "its transcript is gone or the agent session changed")
		return
	case w.AgentSession != ah.req.AgentSession:
		h.failAgentHandoff(ctx, ah, "the agent session changed")
		return
	case st.TookOver:
		h.failAgentHandoff(ctx, ah, "a person took over")
		return
	case now.Sub(ah.at) >= h.opts.AgentHandoffTimeout:
		h.failAgentHandoff(ctx, ah, "no handoff within "+h.opts.AgentHandoffTimeout.String())
		return
	case !st.Prompted || !st.Ended:
		ah.lines, ah.idleAt = -1, time.Time{}
		return
	case st.Lines != ah.lines:
		ah.lines, ah.quietAt, ah.idleAt = st.Lines, now, time.Time{}
		return
	}
	// The request's turn ended and the transcript kept quiet since; herdr
	// must say idle for as long, with no question pending.
	debounce := h.opts.WrapUpDebounce
	if now.Sub(ah.quietAt) < debounce || w.Ask != nil || (w.Status != statusIdle && w.Status != statusDone) ||
		now.UnixMilli()-w.StatusSince < debounce.Milliseconds() {
		ah.idleAt = time.Time{}
		return
	}
	if ah.idleAt.IsZero() {
		ah.idleAt = now
	}
	switch {
	case u.file == nil:
		h.adoptAgentHandoff(ctx, ah, w)
	case errors.Is(u.file, handoff.ErrNoFile), errors.Is(u.file, handoff.ErrIncomplete):
		if now.Sub(ah.idleAt) < h.opts.AgentHandoffGrace {
			return
		}
		if errors.Is(u.file, handoff.ErrIncomplete) {
			h.failAgentHandoff(ctx, ah, "the agent's turn ended with the handoff still at "+ah.req.Path+".tmp (never renamed)")
		} else {
			h.failAgentHandoff(ctx, ah, "the agent's turn ended without the handoff at "+ah.req.Path)
		}
	default:
		h.failAgentHandoff(ctx, ah, "the handoff file cannot be read: "+u.file.Error())
	}
}

// agentArmed records the offset the tracker took and prompts the agent on
// its input lane, once more checked to be idle or done, and (#108 review
// B2) its instruction's review checked again: the switch changed while the
// request started or waited, nothing is sent.
func (h *Hub) agentArmed(ctx context.Context, ah *agentHandoff, u agentUpdate) {
	if (!u.found || u.offset < 0) && h.opts.Now().Sub(ah.at) < agentHandoffFind {
		return // not found yet: looked for again soon
	}
	if !u.found || u.offset < 0 {
		err := fmt.Errorf("%w: the worker's transcript cannot be read (an agent that was never prompted has none yet), so its handoff could not be seen; nothing was sent", errInvalidState)
		h.failAgentHandoff(ctx, ah, err.Error())
		h.endAgentStart(ctx, ah, err)
		return
	}
	ah.req.Transcript, ah.req.Offset, ah.state = u.key, u.offset, proto.AgentHandoffPending
	h.saveAgentHandoff(ctx, ah)
	h.publishAgentHandoff(ah.req.WorkerID)
	h.log.Info("agent handoff requested", "worker", ah.req.WorkerID, "op", ah.req.Op, "offset", u.offset, "path", ah.req.Path)
	id, text := ah.req.WorkerID, ah.text
	h.queueLane(ctx, id, func(ctx context.Context) {
		t, err := query(ctx, h, func() laneTarget {
			w, _, err := h.termWorker(id)
			switch {
			case err != nil:
				return laneTarget{err: err}
			case h.ah.byOp[ah.req.Op] != ah || ah.state != proto.AgentHandoffPending:
				return laneTarget{err: fmt.Errorf("%w: the handoff request ended before it was sent", errInvalidState)}
			case w.Ask != nil || (w.Status != statusIdle && w.Status != statusDone):
				return laneTarget{err: fmt.Errorf("%w: %s is %s: only an idle or done worker is asked", errInvalidState, w.Name, w.Status)}
			}
			if err := h.reviewHolds(ah.rev, text); err != nil {
				return laneTarget{err: err}
			}
			ah.sending = true
			return laneTarget{session: w.Session, pane: w.PaneID}
		})
		var res any
		began := false
		if err == nil {
			if err = t.err; err == nil {
				began = true
				res, err = h.prompt(ctx, proto.WorkerPromptArgs{ID: id, Text: text}, t.session, t.pane, ah.rev)
			}
		}
		if err == nil {
			h.kickUsage()
		}
		_ = h.doWait(ctx, func() {
			if ah.sending { // #108: the send settles, whatever ended the request meanwhile
				ah.sending = false
				if err != nil && (!began || notSent(err)) {
					h.settleAgentStart(ah, err)
				} else {
					h.settleAgentStart(ah, nil)
				}
			}
			if err != nil && h.ah.byOp[ah.req.Op] == ah {
				h.failAgentHandoff(ctx, ah, "its prompt failed: "+err.Error())
			}
			pr, _ := res.(proto.PromptResult)
			h.endAgentStart(ctx, ah, err, pr.Queued)
		})
	})
}

// adoptAgentHandoff files the agent's file (off the hub goroutine), then
// sends the worker home when asked.
func (h *Hub) adoptAgentHandoff(ctx context.Context, ah *agentHandoff, w *proto.Worker) {
	ah.state = proto.AgentHandoffFiling
	h.publishAgentHandoff(w.ID)
	items, _ := json.Marshal(struct {
		Harness     string `json:"harness"`
		Nonce       string `json:"nonce"`
		Instruction string `json:"instruction"`
		Transcript  string `json:"transcript"`
		Offset      int64  `json:"offset"`
	}{ah.req.Harness, ah.req.Nonce, ah.req.Instruction, ah.req.Transcript, ah.req.Offset})
	src := handoff.Source{Floor: workerFloor(w), WorkerID: w.ID, WorkerName: w.Name, Label: w.Label, Harness: harnessOf(w), Model: w.Model,
		Cwd: checkoutOf(w), Branch: w.Branch, AgentSession: ah.req.AgentSession, Kind: store.HandoffAgent, Turn: ah.req.Op,
		Items: string(items), Op: ah.req.Op, At: ah.at}
	svc, path, instruction := h.ho.svc, ah.req.Path, ah.req.Instruction
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		filed, existing, err := svc.Adopt(ctx, src, path)
		if err == nil { // #108 round 5: what it names, for its successor
			if _, body, rerr := svc.Read(ctx, filed.ID); rerr == nil {
				h.noteHandoffSecrets(ctx, filed.ID, body, instruction)
			}
		}
		_ = h.doWait(ctx, func() {
			if err != nil {
				ah.state = proto.AgentHandoffPending // so it fails
				h.failAgentHandoff(ctx, ah, "the handoff could not be filed: "+err.Error())
				return
			}
			ah.handoff, ah.state = &filed, proto.AgentHandoffFiled
			h.saveAgentHandoff(ctx, ah)
			if !existing {
				h.ho.counts[filed.Floor]++
				n := h.ho.counts[filed.Floor]
				e := entryOf(filed)
				h.emit(proto.Event{T: proto.EvHandoffAdded, Session: h.sessionOf(filed.Floor), FloorID: filed.Floor, Handoff: &e, HandoffCount: &n})
				h.log.Info("agent handoff filed", "worker", ah.req.WorkerID, "op", ah.req.Op, "handoff", filed.ID, "path", filed.Path)
			}
			if ah.req.SendHome {
				ah.sendHome, ah.homeWhy = h.handoffSendHome(ctx, ah.by, ah.req.WorkerID, filed.ID)
			}
			h.publishAgentHandoff(ah.req.WorkerID)
		})
	}()
}

// startHandoffCancel answers worker.handoff_cancel: of an LLM job (#9)
// when the op is the worker's latest one, else of an agent request.
func (h *Hub) startHandoffCancel(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.WorkerHandoffCancelArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if h.workers[a.Worker] != nil {
		if ok, err := h.llmHandoffCancel(ctx, c, cmd, a); ok {
			return err
		}
	}
	return h.startAgentHandoffCancel(ctx, c, cmd)
}

// startAgentHandoffCancel answers worker.handoff_cancel: a running request
// (not one being filed) fails as cancelled; a settled one is dismissed
// from the worker.
func (h *Hub) startAgentHandoffCancel(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.WorkerHandoffCancelArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	w := h.workers[a.Worker]
	if w == nil {
		return fmt.Errorf("%w: %q", errUnknownWorker, a.Worker)
	}
	ah := h.ah.byWorker[a.Worker]
	switch {
	case ah == nil || ah.req.Op != a.Op:
		return fmt.Errorf("%w: %s has no handoff request %q", errInvalidState, w.Name, a.Op)
	case ah.state == proto.AgentHandoffFiling:
		return fmt.Errorf("%w: the handoff is being filed", errBusy)
	case ah.pending():
		h.failAgentHandoff(ctx, ah, "cancelled")
		h.endAgentStart(ctx, ah, fmt.Errorf("%w: the handoff request was cancelled", errInvalidState))
	default:
		delete(h.ah.byWorker, a.Worker)
		h.publishAgentHandoff(a.Worker)
	}
	h.audit(ctx, c, cmd, nil)
	h.reply(c, cmd, ah.view(), nil)
	return nil
}

// agentPreview is the agent part of worker.handoff_preview: the skill call
// (off the hub goroutine) and whether the worker can be asked now.
func (h *Hub) agentPreview(ctx context.Context, w *proto.Worker, why string) *proto.AgentHandoffPreview {
	p := &proto.AgentHandoffPreview{Harness: harnessOf(w), Model: w.Model, Instruction: proto.DefaultHandoffInstruction,
		CanAsk: why == "", CannotAsk: why}
	if h.opts.Commands == nil || (w.AgentKind != transcript.Claude && w.AgentKind != transcript.Codex) {
		return p
	}
	call, err := h.agentHandoffSkill(ctx, w.AgentKind, checkoutOf(w))
	if err != nil {
		p.CanAsk, p.CannotAsk = false, strings.TrimPrefix(err.Error(), errSkillMissing.Error()+": ")
		return p
	}
	p.Call = call
	return p
}

// agentBefore gives a resumed request (its offset known) its tracker before
// the session reads, so it gets every line from the offset on; one whose
// lines from there were read already cannot resume and is void (usage
// tracker goroutine).
func (tr *usageTracker) agentBefore(w usageWorker) {
	l := tr.lines[w.id]
	if w.agentHo == nil {
		if l != nil {
			l.agentHo = nil
		}
		return
	}
	if l == nil || w.agentHo.offset < 0 || (l.agentHo != nil && l.agentHo.Nonce() == w.agentHo.nonce) {
		return
	}
	t := transcript.NewMarkerTracker(w.harness, w.agentHo.nonce, w.agentHo.marker, w.agentHo.offset)
	if t == nil {
		return
	}
	if s := tr.sessions[w.id]; s != nil && s.Delivered() > w.agentHo.offset {
		t.Reset()
	}
	l.agentHo = t
}

// offerAgentHandoff queues the tracker's look at the worker's request: a
// new one's tracker starts where the session's tail is now (after its
// read); the reserved file is looked at too.
func (tr *usageTracker) offerAgentHandoff(w usageWorker) {
	aw := w.agentHo
	if aw == nil {
		return
	}
	u := agentUpdate{op: aw.op, nonce: aw.nonce, key: tr.keys[w.id], offset: aw.offset, file: handoff.ErrNoFile}
	defer func() { tr.agentUps = append(tr.agentUps, u) }()
	s, l := tr.sessions[w.id], tr.lines[w.id]
	if s == nil || l == nil || !s.Found() {
		return
	}
	if l.agentHo == nil || l.agentHo.Nonce() != aw.nonce {
		if aw.offset >= 0 {
			return // a resumed one whose tracker could not be made
		}
		if l.agentHo = transcript.NewMarkerTracker(w.harness, aw.nonce, aw.marker, s.Delivered()); l.agentHo == nil {
			return
		}
	}
	u.offset, u.state = l.agentHo.From(), l.agentHo.State()
	u.found = !u.state.Void
	if aw.offset >= 0 && aw.written != nil {
		u.file = aw.written()
	}
}

// startAgentPreview answers worker.handoff_preview in mode "agent": the
// provenance, send-home eligibility, whether and how the agent can be
// asked (its skill looked up off the hub goroutine), the prompt cache as
// estimated now, and the literal candidate's text when it names the current
// one (so the dialog can still offer "Save last message").
func (h *Hub) startAgentPreview(ctx context.Context, c *Client, cmd proto.Command, a proto.WorkerHandoffPreviewArgs) error {
	if h.ho.svc == nil {
		return fmt.Errorf("%w: the bridge has no handoff directory", errUnsupported)
	}
	w := h.workers[a.Worker]
	if w == nil {
		return fmt.Errorf("%w: %q", errUnknownWorker, a.Worker)
	}
	why, _ := h.agentCannotAsk(w)
	prov, blocked, now := provenanceOf(w), h.sendHomeBlocked(w), h.opts.Now()
	var cache *proto.CacheEstimate
	if w.Usage != nil && w.Usage.Cache != nil {
		e := usage.EstimateCache(w.Usage.Cache, now)
		cache = &e
	}
	var src *handoffCand
	var cand proto.HandoffCandidate
	if a.Candidate != "" {
		if _, hc, err := h.handoffCandOf(a.Worker, "", a.Candidate, ""); err == nil {
			cp := *hc
			src, cand = &cp, *h.handoffView(a.Worker, w.AgentSession)
		}
	}
	h.startAsync(ctx, c, cmd, func(ctx context.Context) (any, error) {
		res := proto.WorkerHandoffPreviewResult{Provenance: prov, CanSendHome: blocked == "", SendHomeBlocked: blocked,
			Agent: h.agentPreview(ctx, w, why), Cache: cache}
		if src != nil {
			if body, err := src.check(); err == nil {
				text, cut := previewText(body, proto.HandoffPreviewBytes)
				res.Candidate, res.Text, res.Truncated, res.Title = &cand, text, cut, handoff.Title(body, w.Name, now)
			}
		}
		return res, nil
	})
	return nil
}
