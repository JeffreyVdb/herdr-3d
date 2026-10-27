package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/cmdrequest"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

type commandRequestShown struct {
	request *proto.CommandRequest
	turn    string
	source  commandRequestSource
}
type commandRequestSource struct{ Agent, Session string }
type storedCommandRequest struct {
	Request *proto.CommandRequest `json:"request"`
	Source  commandRequestSource  `json:"source"`
}
type commandRequestState struct {
	shown   map[string]commandRequestShown
	latest  map[string]string
	running map[string]map[string]bool
}

func (h *Hub) initCommandRequests() {
	h.cr = commandRequestState{shown: map[string]commandRequestShown{}, latest: map[string]string{}, running: map[string]map[string]bool{}}
}
func (h *Hub) commandRequestReady() bool {
	r := h.ss.roles
	return (h.opts.CommandRequestsEnabled == nil || *h.opts.CommandRequestsEnabled) && r != nil && r.State(ai.RoleClassifier) == ai.StateReady && r.State(ai.RoleLLM) == ai.StateReady
}
func (h *Hub) commandRequestSkip(w *proto.Worker) string {
	if !h.commandRequestReady() {
		return "the feature is not ready"
	}
	return turnSkip(w)
}
func (h *Hub) commandRequestView(id string) *proto.CommandRequest { return h.cr.shown[id].request }
func (h *Hub) commandRequestWants(id, hash string) bool {
	return h.commandRequestReady() && (h.cr.shown[id].request == nil || h.cr.shown[id].request.Key != hash)
}
func (h *Hub) commandRequestSeen(ctx context.Context, u followupUpdate) {
	s := h.cr.shown[u.id]
	if s.request != nil && s.source != u.source {
		h.closeCommandRequest(u.id, s.request.Key, "moved")
	}
	if u.turn == nil {
		delete(h.cr.latest, u.id)
		if u.moved && s.request != nil {
			h.closeCommandRequest(u.id, s.request.Key, "moved")
		}
		return
	}
	h.cr.latest[u.id] = u.turn.ID
	if s.request != nil && s.turn != u.turn.ID {
		h.closeCommandRequest(u.id, s.request.Key, "moved")
	}
}

// commandRequestUnseen reports whether c's reply was never looked at, or
// why not to look ("in flight", "already looked at", a read error).
func (h *Hub) commandRequestUnseen(ctx context.Context, id string, c *followupCand) (bool, string) {
	if h.cr.running[id][c.turn.Hash] {
		return false, "in flight"
	}
	v, ok, err := h.st.CommandRequestSeenOf(ctx, id, c.turn.Hash)
	if err != nil {
		h.log.Error("reading command request", "err", err)
		return false, "read error"
	}
	if !ok {
		return true, ""
	}
	if v.Request != "" && v.Outcome == "" {
		if v.Turn != c.turn.ID {
			_ = h.st.CloseCommandRequestSeen(ctx, id, c.turn.Hash, "moved")
			h.logCommandRequestClosed(id, c.turn.Hash, "moved", "restored for an older turn")
			return false, "already looked at"
		}
		var saved storedCommandRequest
		if json.Unmarshal([]byte(v.Request), &saved) == nil && saved.Request != nil && saved.Source == c.source && h.commandRequestSourceCurrent(id, c.source) {
			h.setCommandRequest(id, saved.Request, v.Turn, c.source)
			return false, "already looked at (request restored)"
		}
		_ = h.st.CloseCommandRequestSeen(ctx, id, c.turn.Hash, "moved")
		h.logCommandRequestClosed(id, c.turn.Hash, "moved", "restored for another agent session")
	}
	return false, "already looked at"
}
func (h *Hub) setCommandRequest(id string, req *proto.CommandRequest, turn string, source commandRequestSource) {
	w := h.workers[id]
	if w == nil {
		return
	}
	h.cr.shown[id] = commandRequestShown{req, turn, source}
	next := *w
	next.CommandRequest = req
	h.workers[id] = &next
	h.emit(proto.Event{T: proto.EvWorkerUpsert, Worker: &next})
}
func (h *Hub) dropCommandRequest(ctx context.Context, id, outcome string) bool {
	if outcome == "gone" {
		delete(h.cr.latest, id)
		delete(h.cr.running, id)
	}
	s := h.cr.shown[id]
	if s.request == nil {
		return false
	}
	delete(h.cr.shown, id)
	if err := h.st.CloseCommandRequestSeen(ctx, id, s.request.Key, outcome); err != nil {
		h.log.Error("closing command request", "err", err)
	}
	h.logCommandRequestClosed(id, s.request.Key, outcome, "")
	return true
}
func (h *Hub) closeCommandRequest(worker, key, outcome string) {
	s := h.cr.shown[worker]
	if s.request == nil || (key != "" && s.request.Key != key) {
		return
	}
	if !h.dropCommandRequest(context.Background(), worker, outcome) {
		return
	}
	if w := h.workers[worker]; w != nil {
		next := *w
		next.CommandRequest = nil
		h.workers[worker] = &next
		h.emit(proto.Event{T: proto.EvWorkerUpsert, Worker: &next})
	}
}
func (h *Hub) commandRequestEntry(worker, key string, index int) (cmd string, variants []string, host string, ok bool) {
	shown := h.cr.shown[worker]
	s := shown.request
	if s == nil || s.Key != key || shown.turn != h.cr.latest[worker] || !h.commandRequestSourceCurrent(worker, shown.source) || index < 0 || index >= len(s.Commands) {
		return "", nil, "", false
	}
	c := s.Commands[index]
	for _, v := range c.Variants {
		variants = append(variants, v.Command)
	}
	return c.Command, variants, c.Host, true
}

// crResult is one look of the command request pipeline at a reply.
type crResult struct {
	score     float64
	decision  cmdrequest.Decision
	extracted bool // the gate let it through to extraction
	commands  []cmdrequest.Command
	rejected  cmdrequest.Result
	stage     string // where err came from: classifier or extraction
	err       error
}

// commandRequestRetries bounds the retries of a reply after a transient
// model error; DefaultCommandRequestRetry is the first one's wait (doubled
// for the next).
const (
	commandRequestRetries      = 2
	DefaultCommandRequestRetry = 30 * time.Second
)

// crTransient reports whether a failed look may succeed when asked again.
func crTransient(err error) bool {
	if errors.Is(err, cmdrequest.ErrMalformed) {
		return true
	}
	switch ai.KindOf(err) {
	case ai.KindTimeout, ai.KindUnreachable, ai.KindRateLimited, ai.KindFailed, ai.KindBadResponse, ai.KindTruncated, ai.KindEmpty:
		return true
	}
	return false
}

// crErrorKind is a failed look's kind for the log (never its message).
func crErrorKind(err error) string {
	if errors.Is(err, cmdrequest.ErrMalformed) {
		return "malformed"
	}
	if k := ai.KindOf(err); k != "" {
		return string(k)
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return "canceled"
	}
	return "error"
}

func hashPrefix(h string) string { return h[:min(12, len(h))] }

// logCommandRequestSkip is the diagnostic line of a settled turn the
// command requests do not look at (#213).
func (h *Hub) logCommandRequestSkip(id string, c *followupCand, why string) {
	h.log.Info("command request turn", "worker", id, "turn", c.turn.ID, "hash", hashPrefix(c.turn.Hash), "skip", why)
}

// logCommandRequestClosed is the diagnostic line of a request closing.
func (h *Hub) logCommandRequestClosed(id, hash, outcome, note string) {
	h.log.Info("command request closed", "worker", id, "hash", hashPrefix(hash), "outcome", outcome, "note", note)
}

// commandRequestDone takes one look's result (hub goroutine) and logs it in
// one line (#213): the gate, the extraction and what became of it, never
// the reply's text, a command or a working directory.
func (h *Hub) commandRequestDone(ctx context.Context, id string, c *followupCand, res crResult) {
	c.crAttempt++
	delete(h.cr.running[id], c.turn.Hash)
	w := h.workers[id]
	stale := h.cr.latest[id] != c.turn.ID || !h.commandRequestSourceCurrent(id, c.source) || w == nil || w.Status == statusWorking || h.commandRequestSkip(w) != ""
	extract := "skipped"
	if res.extracted {
		extract = "ok"
	}
	attrs := []any{"worker", id, "turn", c.turn.ID, "hash", hashPrefix(c.turn.Hash), "attempt", c.crAttempt,
		"score", math.Round(res.score*1000) / 1000, "threshold", cmdrequest.Threshold, "band", cmdrequest.Band,
		"gate", res.decision.Gate, "rule", res.decision.Rule}
	if res.err != nil {
		// A transient failure is retried (twice, after 30 s and 60 s), only
		// the command request; a reply still failing after that is
		// recorded as failed, so a restart does not ask again.
		transient := crTransient(res.err) && ctx.Err() == nil
		var retryIn time.Duration
		persisted := false
		if transient && !stale && c.crAttempt <= commandRequestRetries {
			retryIn = h.opts.CommandRequestRetry << (c.crAttempt - 1)
			c.crRetry, c.notBefore = true, h.opts.Now().Add(retryIn)
		} else if transient && !stale {
			if err := h.st.RecordCommandRequestSeen(ctx, id, c.turn.Hash, c.turn.ID, "", "failed"); err != nil {
				h.log.Error("recording command request", "err", err)
			} else {
				persisted = true
			}
		}
		if res.extracted {
			extract = "error"
		}
		h.turnPartDone(id, c)
		h.log.Info("command request turn", append(attrs, "extract", extract, "error_stage", res.stage, "error_kind", crErrorKind(res.err),
			"retry_in", retryIn.String(), "persisted", persisted, "published", false, "stale", stale)...)
		return
	}
	h.turnPartDone(id, c)
	commands := res.commands
	var raw, outcome string
	var req *proto.CommandRequest
	if len(commands) > 0 {
		for i := range commands {
			path := commands[i].Cwd
			if strings.HasPrefix(path, "~/") {
				if home, e := os.UserHomeDir(); e == nil {
					path = filepath.Join(home, path[2:])
				}
			}
			if filepath.IsAbs(path) {
				commands[i].Cwd = path
				commands[i].CwdNamed = true
			} else if w != nil {
				commands[i].Cwd = w.Cwd
				commands[i].CwdNamed = false
			}
		}
		req = &proto.CommandRequest{Key: c.turn.Hash, At: h.opts.Now().UnixMilli(), Commands: commands}
		b, _ := json.Marshal(storedCommandRequest{Request: req, Source: c.source})
		raw = string(b)
		if stale {
			outcome = "stale"
		}
	}
	persisted := true
	if err := h.st.RecordCommandRequestSeen(ctx, id, c.turn.Hash, c.turn.ID, raw, outcome); err != nil {
		h.log.Error("recording command request", "err", err)
		persisted = false
	}
	published := persisted && req != nil && !stale
	if published {
		h.setCommandRequest(id, req, c.turn.ID, c.source)
	}
	h.log.Info("command request turn", append(attrs, "extract", extract, "commands", len(commands), "rejected", res.rejected.Rejections(),
		"persisted", persisted, "published", published, "stale", stale)...)
}

func (h *Hub) commandRequestSourceCurrent(id string, source commandRequestSource) bool {
	w := h.workers[id]
	if w == nil || w.AgentSession != source.Agent {
		return false
	}
	session := w.AgentSession
	home, other := h.codexHomeOf(id)
	if other && home != "" && w.AgentKind == "codex" {
		session = h.childRoot(id, w.AgentSession)
	}
	return session == source.Session
}
func (h *Hub) startDismissCommandRequest(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.WorkerDismissCommandRequestArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if h.workers[a.ID] == nil {
		return fmt.Errorf("%w: %q", errUnknownWorker, a.ID)
	}
	s := h.cr.shown[a.ID].request
	if s == nil || s.Key != a.Key {
		return fmt.Errorf("%w: command request is no longer open", errStale)
	}
	h.closeCommandRequest(a.ID, a.Key, "dismissed")
	h.audit(ctx, c, cmd, nil)
	h.reply(c, cmd, nil, nil)
	return nil
}
