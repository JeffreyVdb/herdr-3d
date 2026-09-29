package server

// M7 boards: the issue and pull request commands. They all go through the
// hub's audit path (the comment and pull request bodies are never logged:
// auditArgs keeps the target id and the byte counts), run their provider
// call off the hub goroutine, and queue a refresh of the floor after a
// write. What a provider cannot do is refused here too (unsupported), also
// when a client ignores the capability flags.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/codehost"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/provider"
	"github.com/JeffreyVdb/herdr-3d/internal/tracker"
)

// Limits of the board commands.
const (
	maxBoardBody  = 65536
	maxBoardTitle = 256
	maxItemID     = 200
)

var (
	errUnsupported  = errors.New("unsupported")
	errConfirmation = errors.New("confirmation required")
)

// boardCode maps an error of a provider (or of the board commands) to its
// protocol code; "" when it is none of them.
func boardCode(err error) string {
	var rl *provider.RateLimitError
	switch {
	case errors.Is(err, errConfirmation):
		return proto.ErrConfirmationRequired
	case errors.Is(err, errUnsupported), errors.Is(err, provider.ErrUnsupported):
		return proto.ErrUnsupported
	case errors.As(err, &rl):
		return proto.ErrRateLimited
	case errors.Is(err, provider.ErrChecksNotGreen):
		return proto.ErrChecksNotGreen
	case errors.Is(err, provider.ErrNotMergeable):
		return proto.ErrNotMergeable
	case errors.Is(err, provider.ErrNotFound):
		return proto.ErrNotFound
	case errors.Is(err, provider.ErrStale):
		return proto.ErrStale
	case errors.Is(err, provider.ErrBadInput):
		return proto.ErrBadRequest
	case errors.Is(err, provider.ErrFailed):
		return proto.ErrProviderFailed
	}
	return ""
}

// validBoardText checks a comment or pull request body (min bytes: 1 for a
// comment, 0 for a pull request's): UTF-8 without control characters but
// newline and tab.
func validBoardText(what, s string, min int) error {
	if len(s) < min || len(s) > maxBoardBody || !utf8.ValidString(s) || (min > 0 && strings.TrimSpace(s) == "") {
		return bad("%s must be %d-%d bytes of text", what, max(min, 1), maxBoardBody)
	}
	for _, r := range s {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			return bad("%s must not hold control characters", what)
		}
	}
	return nil
}

func validBoardTitle(s string) error {
	if len(s) < 1 || len(s) > maxBoardTitle || !utf8.ValidString(s) || strings.TrimSpace(s) == "" {
		return bad("title must be 1-%d bytes", maxBoardTitle)
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			return bad("title must not hold control characters")
		}
	}
	return nil
}

func validItemID(id string) error {
	if id == "" || len(id) > maxItemID || !utf8.ValidString(id) || strings.IndexFunc(id, unicode.IsControl) >= 0 {
		return bad("id must be 1-%d bytes without control characters", maxItemID)
	}
	return nil
}

// boardCmdFloor is the board of a floor a command acts on.
func (h *Hub) boardCmdFloor(session string) (*boardFloor, error) {
	if _, err := h.floorFor(session); err != nil {
		return nil, err
	}
	bf := h.boardOf(session)
	if bf == nil {
		return nil, fmt.Errorf("%w: the floor has no board (no repo linked)", errUnsupported)
	}
	return bf, nil
}

// cardCaps is what an issue allows: its own capabilities, else the board's.
func cardCaps(bf *boardFloor, id string) tracker.Capabilities {
	if bf.issues != nil {
		for _, c := range bf.issues.Cards {
			if c.ID == id && c.Capabilities != nil {
				return *c.Capabilities
			}
		}
	}
	return bf.info.Capabilities
}

func (bf *boardFloor) noHost() error {
	return fmt.Errorf("%w: %s has no pull requests for this floor", errUnsupported, bf.info.Name)
}

// startBoardAsync runs a provider call off the hub goroutine, with its audit
// row begun now (args without bodies) and completed with the report when it
// ends. After a successful write the floor's refresh is queued.
func (h *Hub) startBoardAsync(ctx context.Context, c *Client, cmd proto.Command, session string, write bool,
	work func(context.Context) (data, report any, err error)) error {
	auditID, err := h.st.AuditBegin(ctx, c.name, cmd.T, auditArgs(cmd))
	if err != nil {
		return err
	}
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		data, report, err := work(ctx)
		if derr := h.doWait(ctx, func() {
			if aerr := h.st.AuditEnd(ctx, auditID, err, report); aerr != nil {
				h.log.Error("audit log write failed", "err", aerr)
			}
			h.reply(c, cmd, data, err)
			if write && err == nil {
				h.queueBoard(ctx, session)
			}
		}); derr != nil {
			h.log.Warn("command abandoned", "cmd", cmd.T, "err", derr)
		}
	}()
	return nil
}

func (h *Hub) startIssueGet(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.ItemArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if err := validItemID(a.ID); err != nil {
		return err
	}
	bf, err := h.boardCmdFloor(a.Session)
	if err != nil {
		return err
	}
	tr := bf.set.Tracker
	return h.startBoardAsync(ctx, c, cmd, a.Session, false, func(ctx context.Context) (any, any, error) {
		d, err := tr.Get(ctx, a.ID)
		if err != nil {
			return nil, nil, err
		}
		return d, nil, nil
	})
}

func (h *Hub) startIssueComment(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.CommentArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if err := validItemID(a.ID); err != nil {
		return err
	}
	if err := validBoardText("body", a.Body, 1); err != nil {
		return err
	}
	bf, err := h.boardCmdFloor(a.Session)
	if err != nil {
		return err
	}
	if !cardCaps(bf, a.ID).Comment {
		return fmt.Errorf("%w: %s issues cannot be commented on", errUnsupported, bf.info.Name)
	}
	tr := bf.set.Tracker
	return h.startBoardAsync(ctx, c, cmd, a.Session, true, func(ctx context.Context) (any, any, error) {
		cm, err := tr.Comment(ctx, a.ID, a.Body)
		if err != nil {
			return nil, nil, err
		}
		return proto.CommentResult{Comment: cm}, map[string]any{"id": a.ID, "bytes": len(a.Body), "comment": cm.ID}, nil
	})
}

func (h *Hub) startIssueClose(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.IssueCloseArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if err := validItemID(a.ID); err != nil {
		return err
	}
	if !tracker.ValidReason(a.Reason) {
		return bad("reason must be completed, not_planned or duplicate")
	}
	if !a.Confirm {
		return fmt.Errorf("%w: closing an issue needs confirm: true", errConfirmation)
	}
	bf, err := h.boardCmdFloor(a.Session)
	if err != nil {
		return err
	}
	if !cardCaps(bf, a.ID).Close {
		return fmt.Errorf("%w: this issue cannot be closed", errUnsupported)
	}
	tr := bf.set.Tracker
	return h.startBoardAsync(ctx, c, cmd, a.Session, true, func(ctx context.Context) (any, any, error) {
		if err := tr.Close(ctx, a.ID, a.Reason); err != nil {
			return nil, nil, err
		}
		return nil, map[string]any{"id": a.ID, "reason": a.Reason}, nil
	})
}

func (h *Hub) startIssueSetStatus(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.IssueSetStatusArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if err := validItemID(a.ID); err != nil {
		return err
	}
	if a.Column == "" || len(a.Column) > maxItemID || strings.IndexFunc(a.Column, unicode.IsControl) >= 0 {
		return bad("column must be 1-%d bytes", maxItemID)
	}
	bf, err := h.boardCmdFloor(a.Session)
	if err != nil {
		return err
	}
	if !cardCaps(bf, a.ID).SetStatus {
		return fmt.Errorf("%w: this board has no status to set", errUnsupported)
	}
	tr := bf.set.Tracker
	return h.startBoardAsync(ctx, c, cmd, a.Session, true, func(ctx context.Context) (any, any, error) {
		if err := tr.SetStatus(ctx, a.ID, a.Column); err != nil {
			return nil, nil, err
		}
		return nil, map[string]any{"id": a.ID, "column": a.Column}, nil
	})
}

func (h *Hub) startPRGet(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.ItemArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if err := validItemID(a.ID); err != nil {
		return err
	}
	bf, err := h.boardCmdFloor(a.Session)
	if err != nil {
		return err
	}
	if bf.set.Host == nil {
		return bf.noHost()
	}
	host := bf.set.Host
	return h.startBoardAsync(ctx, c, cmd, a.Session, false, func(ctx context.Context) (any, any, error) {
		d, err := host.Get(ctx, a.ID)
		if err != nil {
			return nil, nil, err
		}
		return d, nil, nil
	})
}

func (h *Hub) startPRComment(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.CommentArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if err := validItemID(a.ID); err != nil {
		return err
	}
	if err := validBoardText("body", a.Body, 1); err != nil {
		return err
	}
	bf, err := h.boardCmdFloor(a.Session)
	if err != nil {
		return err
	}
	if bf.set.Host == nil || !bf.host.Capabilities.Comment {
		return fmt.Errorf("%w: pull requests cannot be commented on", errUnsupported)
	}
	host := bf.set.Host
	return h.startBoardAsync(ctx, c, cmd, a.Session, true, func(ctx context.Context) (any, any, error) {
		cm, err := host.Comment(ctx, a.ID, a.Body)
		if err != nil {
			return nil, nil, err
		}
		return proto.CommentResult{Comment: cm}, map[string]any{"id": a.ID, "bytes": len(a.Body), "comment": cm.ID}, nil
	})
}

// mergeReport is the audit-log result of a pr.merge.
type mergeReport struct {
	ID       string `json:"id"`
	Method   string `json:"method"`
	Checks   string `json:"checks,omitempty"`
	Mergeble string `json:"mergeable,omitempty"`
	// Override is set when the merge went through only because of the
	// confirmed override: Gate is what the normal rule said.
	Override bool   `json:"override,omitempty"`
	Gate     string `json:"gate,omitempty"`
	Merged   bool   `json:"merged"`
}

func (h *Hub) startPRMerge(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.PRMergeArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if err := validItemID(a.ID); err != nil {
		return err
	}
	if !codehost.ValidMethod(a.Method) {
		return bad("method must be merge, squash or rebase")
	}
	if !a.Confirm {
		return fmt.Errorf("%w: merging needs confirm: true", errConfirmation)
	}
	bf, err := h.boardCmdFloor(a.Session)
	if err != nil {
		return err
	}
	if bf.set.Host == nil || !bf.host.Capabilities.Merge {
		return fmt.Errorf("%w: pull requests cannot be merged here", errUnsupported)
	}
	host := bf.set.Host
	// An override needs its own confirmation: one flag alone changes nothing.
	override := a.Override && a.ConfirmOverride
	return h.startBoardAsync(ctx, c, cmd, a.Session, true, func(ctx context.Context) (any, any, error) {
		rep := &mergeReport{ID: a.ID, Method: a.Method}
		// Fresh, right before merging: the board may be a minute old.
		d, err := host.Get(ctx, a.ID)
		if err != nil {
			return nil, rep, err
		}
		rep.Checks, rep.Mergeble = d.Request.Checks, d.Request.Mergeable
		if d.Request.State != "" && d.Request.State != "open" {
			return nil, rep, provider.Errorf(provider.ErrNotMergeable, "%s is %s, not open", d.Request.Key, d.Request.State)
		}
		if gate := codehost.Gate(d.Request, false); gate != nil && override {
			if err := codehost.Gate(d.Request, true); err != nil { // conflicts stay refused
				return nil, rep, err
			}
			rep.Override, rep.Gate = true, gate.Error()
		} else if gate != nil {
			if a.Override {
				return nil, rep, fmt.Errorf("%w (an override needs confirm_override: true as well)", gate)
			}
			return nil, rep, gate
		}
		if err := host.Merge(ctx, a.ID, a.Method, override); err != nil {
			return nil, rep, err
		}
		rep.Merged = true
		return proto.PRMergeResult{Merged: true}, rep, nil
	})
}
