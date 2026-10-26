package server

import (
	"context"
	"fmt"
	"strings"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

func (h *Hub) terminalTarget(id string) (session, pane string, f *floorState, err error) {
	if !strings.HasPrefix(id, "mp:") {
		w, floor, e := h.termWorker(id)
		if e != nil {
			return "", "", nil, e
		}
		return w.Session, w.PaneID, floor, nil
	}
	session, pane, ok := h.manualPane(strings.TrimPrefix(id, "mp:"))
	if !ok || pane == "" {
		return "", "", nil, fmt.Errorf("%w: manual process terminal is gone", errInvalidState)
	}
	f, err = h.floorFor(session)
	if err != nil {
		return "", "", nil, err
	}
	if !f.running || h.opts.Term == nil {
		return "", "", nil, fmt.Errorf("%w: terminal is unavailable", errInvalidState)
	}
	return session, pane, f, nil
}

func (h *Hub) startTerminalInput(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.TerminalInputArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if !strings.HasPrefix(a.ID, "mp:") || (a.Text == nil) == (a.Bytes == nil) {
		return bad("manual process id and exactly one of text or bytes required")
	}
	n := 0
	if a.Text != nil {
		n = len(*a.Text)
	} else {
		n = len(*a.Bytes)
	}
	if n > 16<<10 {
		return bad("input exceeds 16 KiB")
	}
	if _, _, _, err := h.terminalTarget(a.ID); err != nil {
		return err
	}
	_, cs, err := h.ownedStream(c, a.ID)
	if err == nil {
		h.toLive(a.ID)
		if a.Text != nil {
			err = cs.Input(*a.Text)
		} else {
			err = cs.InputBytes(*a.Bytes)
		}
		if err != nil {
			err = fmt.Errorf("%w: terminal input failed", errInputFailed)
		}
	}
	h.audit(ctx, c, cmd, err)
	if err != nil {
		return err
	}
	h.reply(c, cmd, nil, nil)
	return nil
}
