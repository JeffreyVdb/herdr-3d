package server

// #106 the inbox's dismissals: a finished worker's row hidden until the
// worker's next working → done. A dismissal is the worker's status_since at
// the time; it holds while that is still the worker's status_since and the
// worker is done. Kept in SQLite (inbox_dismissed), so it survives a bridge
// restart, and shown to every client (World.InboxDismissed, inbox.dismissed).

import (
	"context"
	"fmt"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// loadInbox reads the dismissals back, dropping the stale ones.
func (h *Hub) loadInbox(ctx context.Context) error {
	if _, err := h.st.PruneInboxDismissed(ctx); err != nil {
		return err
	}
	m, err := h.st.InboxDismissed(ctx)
	if err != nil {
		return err
	}
	h.dismissed = m
	return nil
}

// startInboxDismiss answers inbox.dismiss: recorded and sent to every
// client when the worker is done since status_since; ignored (dismissed:
// false, no event) when it is not, or is gone.
func (h *Hub) startInboxDismiss(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.InboxDismissArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if a.ID == "" || a.StatusSince <= 0 {
		return bad("id and status_since are required")
	}
	w := h.workers[a.ID]
	if w == nil || w.Status != statusDone || w.StatusSince != a.StatusSince {
		h.audit(ctx, c, cmd, nil)
		h.reply(c, cmd, proto.InboxDismissResult{}, nil)
		return nil
	}
	if h.dismissed[a.ID] != a.StatusSince {
		if err := h.st.DismissInbox(ctx, a.ID, a.StatusSince); err != nil {
			return fmt.Errorf("saving the dismissal: %w", err)
		}
		h.dismissed[a.ID] = a.StatusSince
		h.emit(proto.Event{T: proto.EvInboxDismissed, ID: a.ID, StatusSince: a.StatusSince})
	}
	h.audit(ctx, c, cmd, nil)
	h.reply(c, cmd, proto.InboxDismissResult{Dismissed: true}, nil)
	return nil
}

// pruneDismissed drops a worker's dismissal once the worker is no longer
// done in the episode it hid (hub goroutine).
func (h *Hub) pruneDismissed(ctx context.Context, w *proto.Worker) {
	if since, ok := h.dismissed[w.ID]; ok && (w.Status != statusDone || w.StatusSince != since) {
		h.forgetDismissed(ctx, w.ID)
	}
}

// forgetDismissed drops a worker's dismissal.
func (h *Hub) forgetDismissed(ctx context.Context, id string) {
	if _, ok := h.dismissed[id]; !ok {
		return
	}
	delete(h.dismissed, id)
	if err := h.st.ForgetInboxDismissed(ctx, id); err != nil {
		h.log.Error("forgetting a dismissal failed", "worker", id, "err", err)
	}
}

// inboxDismissedView is the dismissals for the snapshot (never nil).
func (h *Hub) inboxDismissedView() map[string]int64 {
	m := make(map[string]int64, len(h.dismissed))
	for id, since := range h.dismissed {
		m[id] = since
	}
	return m
}
