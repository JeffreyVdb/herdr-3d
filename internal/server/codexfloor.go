package server

// #155: a shared-server Codex worker across floor sleep and wake. Herdr's
// own resume drops --remote and the workspace env and runs a plain `codex
// resume`, which would start the user's CODEX_HOME daemon (findings B2, B4),
// and `pane release-agent` does not keep it from resuming a pane (#155's
// gating check, TestCodexShareResumeSuppression). The TUI's own exit does:
// herdr then saves no agent session for the pane. So at sleep the bridge
// exits each shared worker's TUI and stops its server, keeping the thread
// id it last saw; on wake it starts the server from the pane again and
// resumes that thread attached to it.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// sharedSleep is a shared worker a sleep puts away, for its audit report.
type sharedSleep struct {
	Worker string `json:"worker"`
	Pane   string `json:"pane"`
	Note   string `json:"note,omitempty"`
}

// sleepShared exits a shared worker's TUI the way a person would (/quit,
// Enter) and stops its server (runSleep, before the session stops).
func (h *Hub) sleepShared(ctx context.Context, session string, s sharedSleep) string {
	var notes []string
	if herdr.ValidPaneID(s.Pane) {
		if ok, note := h.exitCodexTUI(ctx, session, s.Pane, s.Worker); !ok {
			notes = append(notes, note+": herdr may resume it its own way on wake, the bridge relaunches it then")
		} else {
			if note != "" {
				notes = append(notes, note)
			}
			if !h.awaitReleased(ctx, s.Worker) {
				notes = append(notes, "herdr still names its session: it may resume it its own way on wake, the bridge relaunches it then")
			}
		}
	}
	if note := h.stopSharedServer(ctx, s.Worker); note != "" {
		notes = append(notes, note)
	}
	return strings.Join(notes, "; ")
}

// awaitReleased waits (up to ExitTimeout) until herdr no longer reports an
// agent or its session for the worker's pane: herdr clears them a moment
// after the TUI quit, and a session stopped before would save the id and
// resume the pane its own way.
func (h *Hub) awaitReleased(ctx context.Context, id string) bool {
	deadline := time.Now().Add(h.opts.ExitTimeout)
	for {
		gone, err := query(ctx, h, func() bool {
			w := h.workers[id]
			return w == nil || (w.AgentSession == "" && w.AgentKind == "")
		})
		if gone || err != nil || time.Now().After(deadline) {
			return gone
		}
		sleepCtx(ctx, h.opts.HirePoll)
	}
}

// exitCodexTUI quits the Codex TUI in a pane (/quit, a pause, Enter, and
// Enter again up to twice while it is not gone) and waits for the pane's
// shell. Never Esc or Ctrl-C: on a dialog the bridge did not expect they
// open Codex's agent command center, which lists the user's other threads.
// The one exception (#158) is the TUI of a shared worker (id) whose own
// server is gone (codexQuitGone).
func (h *Hub) exitCodexTUI(ctx context.Context, session, pane, id string) (bool, string) {
	fh := h.opts.Herdr
	info, err := h.paneProcesses(ctx, session, pane)
	switch {
	case err != nil:
		return false, "reading the pane's processes failed: " + err.Error()
	case info.AtShell():
		return true, ""
	}
	if err := fh.TypeExit(ctx, session, pane, "codex"); err != nil {
		return false, "typing /quit failed: " + err.Error()
	}
	sleepCtx(ctx, h.opts.ExitPause)
	deadline := time.Now().Add(h.opts.ExitTimeout)
	for presses := 1; presses <= 3; presses++ {
		if err := fh.SendKey(ctx, session, pane, herdr.KeyEnter); err != nil {
			return false, "pressing Enter failed: " + err.Error()
		}
		next := time.Now().Add(h.opts.ExitTimeout / 3)
		if presses == 3 || next.After(deadline) {
			next = deadline
		}
		for {
			if info, err := h.paneProcesses(ctx, session, pane); err == nil && info.AtShell() {
				return true, fmt.Sprintf("its terminal quit (%d× Enter)", presses)
			}
			if time.Now().After(next) || ctx.Err() != nil {
				break
			}
			sleepCtx(ctx, h.opts.HirePoll)
		}
	}
	if id != "" && h.codexServerGone(ctx, id) {
		return h.codexQuitGone(ctx, session, pane)
	}
	return false, "its terminal did not quit"
}

// codexServerGone reports whether a shared worker's recorded server has
// died (its pid gone, or another process under it).
func (h *Hub) codexServerGone(ctx context.Context, id string) bool {
	l, err := query(ctx, h, func() store.CodexLaunch { return h.cx.launches[id] })
	return err == nil && l.Mode == store.CodexShared && l.ServerPID > 0 && h.opts.CodexHost != nil &&
		!h.opts.CodexHost.Alive(launchOf(l), serverOf(l))
}

// codexQuitGone quits the TUI of a shared worker whose server is gone with
// one Ctrl-C (#158). Such a TUI only waits to reconnect (B6) and ignores
// /quit; its own footer then says "ctrl+c quit", and one Ctrl-C exits it
// at once (TestCodexShareBridgeRegression, "the server killed"). With its
// server gone there is no turn left to interrupt. Without that quit herdr
// keeps the pane's session and resumes it its own way on wake.
func (h *Hub) codexQuitGone(ctx context.Context, session, pane string) (bool, string) {
	if err := h.opts.Herdr.SendKey(ctx, session, pane, herdr.KeyCtrlC); err != nil {
		return false, "its codex server is gone and pressing Ctrl-C failed: " + err.Error()
	}
	deadline := time.Now().Add(h.opts.ExitTimeout)
	for {
		if info, err := h.paneProcesses(ctx, session, pane); err == nil && info.AtShell() {
			return true, "its codex server was gone: its terminal quit on Ctrl-C"
		}
		if time.Now().After(deadline) || ctx.Err() != nil {
			return false, "its codex server is gone and its terminal did not quit, not even on Ctrl-C"
		}
		sleepCtx(ctx, h.opts.HirePoll)
	}
}

// resumeSharedAll resumes the woken floor's shared workers, each on its
// own, and returns a func that waits for them.
func (h *Hub) resumeSharedAll(ctx context.Context, op *floorOp) func() {
	type job struct {
		id, pane, thread string
	}
	jobs, _ := query(ctx, h, func() []job {
		var out []job
		for _, id := range h.floorOrder(op) {
			if w := op.waits[id]; w != nil && w.shared && w.state == proto.ResumePending {
				out = append(out, job{id: id, pane: w.pane, thread: w.agentSession})
			}
		}
		return out
	})
	var wg sync.WaitGroup
	for _, j := range jobs {
		wg.Go(func() {
			rctx, cancel := context.WithTimeout(ctx, codexResumeTimeout)
			defer cancel()
			ok, note := h.resumeShared(rctx, op.session, j.id, j.pane, j.thread)
			_ = h.doWait(ctx, func() {
				w := op.waits[j.id]
				if w == nil {
					return
				}
				w.note = joinNote(w.note, note)
				if ok {
					w.fallback = true
					h.resolveWait(op, j.id, "shared server: resumed attached to it")
				}
			})
		})
	}
	return wg.Wait
}

// resumeShared relaunches one shared worker on a woken floor: its pane back
// at its shell (a TUI herdr resumed its own way is quit first), its server
// started from it, then `codex resume <thread> --remote … -C …` with the
// model and effort but no permission override (B9), or, for a worker that
// slept before herdr reported its thread, a new TUI attached to it (no
// thread is guessed). When its server does not start, or the terminal does
// not attach and the pane is back at its shell, it resumes on Codex's
// embedded server instead (resumeEmbedded). It stays shared: the next wake
// tries its server again, and it never goes to herdr's own resume, an
// argument-free `codex resume` that joins the CODEX_HOME daemon (B2, B4).
func (h *Hub) resumeShared(ctx context.Context, session, id, pane, thread string) (bool, string) {
	fh := h.opts.Herdr
	var notes []string
	fail := func(why string) (bool, string) {
		notes = append(notes, why)
		_ = h.doWait(ctx, func() {
			h.updateLaunch(ctx, id, func(l *store.CodexLaunch) { l.Note = "resume failed: " + why })
			h.codexDone(id, proto.CodexServerStopped)
		})
		return false, strings.Join(notes, "; ")
	}
	// The pane comes back with the session; wait for its shell.
	for {
		info, err := h.paneProcesses(ctx, session, pane)
		if err == nil && info.AtShell() {
			break
		}
		if err == nil && info.Runs("codex", "") {
			if remoteTUI(info) {
				return fail("a Codex attached to a server already runs in the pane")
			}
			// herdr resumed it its own way (plain `codex resume`): quit it.
			ok, note := h.exitCodexTUI(ctx, session, pane, "")
			notes = append(notes, "herdr had resumed it without its server; "+note)
			if !ok {
				return fail("the Codex herdr resumed did not quit")
			}
			continue
		}
		if ctx.Err() != nil {
			return fail("the pane was not back at its shell")
		}
		sleepCtx(ctx, h.opts.ResumePoll)
	}
	rec, err := query(ctx, h, func() store.CodexLaunch { return h.cx.launches[id] })
	if err != nil || rec.Mode != store.CodexShared {
		return fail("no shared launch is recorded for it")
	}
	a := herdr.Agent{Harness: "codex", Model: rec.Model, Effort: rec.Effort}
	embedded := func(why string) (bool, string) {
		ok, note := h.resumeEmbedded(ctx, session, id, pane, thread, rec, why)
		if !ok {
			return fail(note)
		}
		notes = append(notes, note)
		return true, strings.Join(notes, "; ")
	}
	if h.opts.CodexHost == nil || h.opts.CodexRun == "" {
		return embedded("this bridge cannot start Codex servers")
	}
	sl := &sharedLaunch{id: id, session: session, pane: pane, agent: rec.AgentName, rec: rec}
	if err := h.startSharedServer(ctx, sl, fh); err != nil {
		return embedded(err.Error())
	}
	r := herdr.Remote{Socket: launchOf(sl.rec).Socket(), Cwd: rec.Cwd}
	how := "resumed " + thread
	if thread == "" {
		how = "no thread was recorded: started a new Codex session"
		err = fh.StartCodexRemote(ctx, session, pane, rec.AgentName, a, r)
	} else {
		err = fh.ResumeCodexRemote(ctx, session, pane, rec.AgentName, thread, a, r)
	}
	var api *herdr.APIError
	if err != nil && !(errors.As(err, &api) && api.Code == "agent_not_ready") {
		h.stopSharedServer(ctx, id)
		if info, perr := h.paneProcesses(ctx, session, pane); perr == nil && info.AtShell() {
			return embedded(fmt.Sprintf("the terminal did not attach (%v)", err))
		}
		return fail("resuming the terminal failed: " + err.Error())
	}
	if err != nil {
		notes = append(notes, "the terminal is blocked during startup: left for the player")
	}
	_ = h.doWait(ctx, func() {
		h.updateLaunch(ctx, id, func(l *store.CodexLaunch) { l.Note = "" })
		h.codexDone(id, proto.CodexServerRunning)
	})
	notes = append(notes, fmt.Sprintf("started its codex server (pid %d); %s", sl.rec.ServerPID, how))
	return true, strings.Join(notes, "; ")
}

// resumeEmbedded is a shared worker's wake without its own server (why):
// its thread resumed on Codex's embedded server with hire's model and
// permission arguments, or, with no thread, Codex started the way a legacy
// hire starts it, its trust dialog answered as a hire answers it. The
// worker stays shared, with the reason as its note and its server stopped.
func (h *Hub) resumeEmbedded(ctx context.Context, session, id, pane, thread string, rec store.CodexLaunch, why string) (bool, string) {
	a := herdr.Agent{Harness: "codex", Model: rec.Model, Effort: rec.Effort}
	var err error
	switch {
	case thread != "":
		err = h.opts.Herdr.ResumeCodexEmbedded(ctx, session, pane, rec.AgentName, thread, a)
	case h.opts.Hire != nil:
		err = h.opts.Hire.StartAgent(ctx, session, pane, rec.AgentName, a)
	default:
		err = errors.New("this bridge cannot start agents")
	}
	var api *herdr.APIError
	blocked := errors.As(err, &api) && api.Code == "agent_not_ready"
	if err != nil && !blocked {
		return false, why + "; starting it without its own server failed too: " + err.Error()
	}
	note := "shared Codex server: " + why + "; resumed without its own server, on Codex's built-in one"
	if thread == "" {
		note = "shared Codex server: " + why + "; started without its own server, on Codex's built-in one"
	}
	notes := []string{note}
	if blocked && h.opts.Hire != nil {
		_, tn := h.answerTrust(ctx, &hireOp{session: session, harness: "codex"}, pane, rec.Cwd)
		if tn == "" {
			tn = "the terminal is blocked during startup: left for the player"
		}
		notes = append(notes, tn)
	}
	_ = h.doWait(ctx, func() {
		h.updateLaunch(ctx, id, func(l *store.CodexLaunch) { l.Note = note })
		h.codexDone(id, proto.CodexServerStopped)
	})
	return true, strings.Join(notes, "; ")
}

// remoteTUI reports whether a pane's Codex is attached with --remote.
func remoteTUI(info *herdr.ProcessInfo) bool {
	for _, p := range info.Foreground {
		if strings.Contains(p.Cmdline, "--remote") {
			return true
		}
	}
	return false
}
