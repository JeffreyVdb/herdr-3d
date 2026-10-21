package server

// #176 part 2: what the seated laptop puts into the pane it owns through
// herdr's controller: a paste (worker.paste: one bracketed paste, inserted,
// never submitted: #38) and a mouse click (terminal.mouse, herdr 0.9.2+).
// Both are input to the worker, so both wait their turn on its input lane,
// in order with what was typed (worker.keys) before and after them.

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"time"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/promptsecret"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/secretfiles"
)

// TermMouse is a TermController that knows whether its controller takes
// mouse clicks (*herdr.Control: its CLI is herdr 0.9.2 or later).
type TermMouse interface {
	MouseClicks(ctx context.Context) bool
}

// Clicks per control watch: at most maxClicks within clickWindow (a double
// click is two; a held button repeating is not a click).
const (
	maxClicks   = 10
	clickWindow = time.Second
)

// errNoMouse refuses a click to a controller whose herdr takes none.
var errNoMouse = fmt.Errorf("%w: mouse clicks need herdr %s or newer", errInvalidState, herdr.MouseVersion)

// mouseClicks reports whether the hub's controllers take mouse clicks (off
// the hub goroutine: it may run `herdr --version` once).
func (h *Hub) mouseClicks(ctx context.Context) bool {
	m, ok := h.opts.Term.(TermMouse)
	return ok && m.MouseClicks(ctx)
}

// startPaste validates worker.paste and queues it on the worker's lane
// (hub goroutine). It needs the connection's control watch of the worker
// owning its pane, then and when its turn comes. Unlike worker.prompt it
// types nothing else and submits nothing, so it goes to a shell, to an
// agent at work and into a question's or an approval's input alike. #108:
// with prompt secrets reviewed, an agent's paste goes through the same
// gate as its prompt (the text scanned on the lane, a review's protected
// ranges sent as file references, checked again right before it goes).
func (h *Hub) startPaste(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.WorkerPasteArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if !utf8.ValidString(a.Text) {
		return bad("text must be UTF-8 (%d bytes)", len(a.Text))
	}
	text := herdr.PasteStrip(a.Text) // NUL and paste markers: herdr would write the line raw
	if len(text) > herdr.MaxMessage {
		return bad("text must be at most %d bytes, got %d", herdr.MaxMessage, len(text))
	}
	wk, _, err := h.termWorker(a.ID)
	if err != nil {
		return err
	}
	if _, _, err := h.ownedStream(c, a.ID); err != nil {
		return err
	}
	// #108: an agent's paste is reviewed like its prompt; a review given is
	// applied to a shell's too.
	gate := a.Secrets != nil || (wk.AgentKind != "" && h.gated(false))
	var rev *promptsecret.Reviewer
	if gate {
		if !h.ps.enabled {
			return fmt.Errorf("%w: prompt secrets are no longer reviewed: paste again", errSecretsReviewStale)
		}
		if err := scannable(text, "text"); err != nil {
			return err
		}
		rev = h.ps.rev
	}
	h.tookOver(ctx, a.ID)      // #83: a person types: an armed wrap-up is off
	h.agentTookOver(ctx, a.ID) // #224: and a handoff request
	h.clearFollowup(ctx, a.ID) // #90: and its follow-up questions are moot
	owner := secretfiles.Worker(a.ID)
	return h.startInput(ctx, c, cmd, a.ID, func(ctx context.Context, _, _ string) (any, error) {
		if text == "" {
			return proto.PasteResult{}, nil
		}
		p := protected{text: text}
		if gate {
			var err error
			if p, err = h.protectText(ctx, rev, owner, time.Time{}, text, a.Secrets); err != nil {
				return nil, err
			}
		}
		var (
			cs  herdr.ControlStream
			err error
		)
		if derr := h.doWait(ctx, func() {
			if gate {
				if err = h.reviewHolds(rev, p.text); err != nil {
					return
				}
			}
			_, cs, err = h.ownedStream(c, a.ID)
		}); derr != nil {
			err = derr
		}
		if err == nil {
			if perr := cs.Paste(ctx, p.text); perr != nil {
				err = fmt.Errorf("%w: %v", errInputFailed, perr)
			}
		}
		if gate {
			if err != nil {
				h.unprotect(ctx, p)
			} else {
				h.sentReview(p, owner)
			}
		}
		if err != nil {
			return nil, err
		}
		res := proto.PasteResult{Protected: len(p.files)}
		if p.text != text {
			res.Sent = p.text
		}
		return res, nil
	})
}

// startMouse validates terminal.mouse and queues the click on the worker's
// lane (hub goroutine): a click on a cell of the pane the connection's
// control watch owns, with herdr 0.9.2 or later. herdr gives it to the
// application only when it has mouse reporting on (a shell gets nothing).
func (h *Hub) startMouse(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.TerminalMouseArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if a.Button == "" {
		a.Button = "left"
	}
	switch {
	case !slices.Contains(herdr.MouseButtons, a.Button):
		return bad(`button must be "left", "right" or "middle"`)
	case a.Column < 0 || a.Row < 0:
		return bad("column and row must be 0 or more")
	case a.Modifiers < 0 || a.Modifiers > 7:
		return bad("modifiers must be 0-7")
	}
	if _, _, err := h.termWorker(a.ID); err != nil {
		return err
	}
	if err := h.clickFits(c, a, true); err != nil {
		return err
	}
	h.tookOver(ctx, a.ID)      // #83: a person acts on the pane: an armed wrap-up is off
	h.agentTookOver(ctx, a.ID) // #224: and a handoff request
	h.clearFollowup(ctx, a.ID) // #90: and its follow-up questions are moot
	return h.startInput(ctx, c, cmd, a.ID, func(ctx context.Context, _, _ string) (any, error) {
		var (
			cs  herdr.ControlStream
			err error
		)
		if derr := h.doWait(ctx, func() {
			if err = h.clickFits(c, a, false); err == nil {
				_, cs, err = h.ownedStream(c, a.ID)
			}
		}); derr != nil {
			return nil, derr
		}
		if err != nil {
			return nil, err
		}
		if cerr := cs.Click(ctx, a.Button, a.Column, a.Row, a.Modifiers); cerr != nil {
			return nil, fmt.Errorf("%w: %v", errInputFailed, cerr)
		}
		return nil, nil
	})
}

// clickFits refuses a click the connection's control watch of the worker
// cannot take: none that owns the pane, a herdr without mouse clicks, a
// cell outside its grid (herdr would drop it without a word), or (count:
// the click is new) more than maxClicks within clickWindow.
func (h *Hub) clickFits(c *Client, a proto.TerminalMouseArgs, count bool) error {
	w, _, err := h.ownedStream(c, a.ID)
	if err != nil {
		return err
	}
	h.term.mu.Lock()
	defer h.term.mu.Unlock()
	switch {
	case !w.ctl.mouse:
		return errNoMouse
	case a.Column >= w.ctl.cols || a.Row >= w.ctl.rows:
		return bad("the cell %d,%d is outside the terminal (%d × %d)", a.Column, a.Row, w.ctl.cols, w.ctl.rows)
	}
	if !count {
		return nil
	}
	now := h.opts.Now()
	w.ctl.clicks = slices.DeleteFunc(w.ctl.clicks, func(t time.Time) bool { return now.Sub(t) >= clickWindow })
	if len(w.ctl.clicks) >= maxClicks {
		return fmt.Errorf("%w: more than %d clicks a second", errCapacity, maxClicks)
	}
	w.ctl.clicks = append(w.ctl.clicks, now)
	return nil
}

// auditPaste is what the audit log keeps of a worker.paste: its lengths and
// (#108) its review's decisions by their counts, never the text.
func auditPaste(cmd proto.Command) json.RawMessage {
	var a proto.WorkerPasteArgs
	if json.Unmarshal(cmd.Args, &a) != nil {
		return redacted(cmd.Args)
	}
	return mustJSON(struct {
		ID        string        `json:"id"`
		TextBytes int           `json:"text_bytes"`
		TextRunes int           `json:"text_runes"`
		Secrets   *secretsAudit `json:"secrets,omitempty"`
	}{clip(a.ID), len(a.Text), utf8.RuneCountInString(a.Text), auditReviews(a.Secrets)})
}
