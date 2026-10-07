package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/kaneoconf"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// #184 Kaneo: the bridge-wide connection to a Kaneo instance. The hub only
// carries it: internal/kaneoconf holds the settings, the key and the calls
// (through the Connector the app wires in). A key arrives in kaneo.test and
// kaneo.set and is never put in an ack, an event, the audit log or a log
// line. Every call to Kaneo runs off the hub goroutine, bounded by the
// service's timeout.

// kaneoState is the hub's Kaneo bookkeeping (hub goroutine only).
type kaneoState struct {
	last string // the View last published
}

// startKaneo answers kaneo.get, kaneo.test, kaneo.set, kaneo.clear,
// kaneo.workspaces and kaneo.projects.
func (h *Hub) startKaneo(ctx context.Context, c *Client, cmd proto.Command) error {
	svc := h.opts.Kaneo
	if svc == nil {
		return fmt.Errorf("%w: the bridge has no Kaneo settings", errUnsupported)
	}
	var work func(context.Context) (any, error)
	switch cmd.T {
	case proto.CmdKaneoGet:
		if err := decodeArgs(cmd.Args, &struct{}{}); err != nil {
			return err
		}
		work = func(context.Context) (any, error) { return svc.View(), nil }
	case proto.CmdKaneoTest:
		var a proto.KaneoTestArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return err
		}
		work = func(ctx context.Context) (any, error) {
			res, err := svc.Test(ctx, kaneoconf.Draft{URL: a.URL, Key: a.Key})
			if err != nil {
				return nil, err
			}
			ws := res.Workspaces
			if ws == nil {
				ws = []proto.KaneoWorkspace{}
			}
			return proto.KaneoTestResult{OK: true, LatencyMS: res.LatencyMS, URL: res.URL, APIBase: res.APIBase, WebOrigin: res.WebOrigin,
				Workspaces: ws, User: res.User}, nil
		}
	case proto.CmdKaneoSet:
		var a proto.KaneoSetArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return err
		}
		def := kaneoconf.DefaultArg{Set: a.DefaultWorkspace.Set, ID: a.DefaultWorkspace.Value}
		work = func(context.Context) (any, error) { return svc.Save(kaneoconf.Draft{URL: a.URL, Key: a.Key}, def) }
	case proto.CmdKaneoClear:
		if err := decodeArgs(cmd.Args, &struct{}{}); err != nil {
			return err
		}
		work = func(context.Context) (any, error) { return svc.Clear() }
	case proto.CmdKaneoWorkspaces:
		if err := decodeArgs(cmd.Args, &struct{}{}); err != nil {
			return err
		}
		work = func(ctx context.Context) (any, error) {
			ws, gen, err := svc.Workspaces(ctx)
			if err != nil {
				return nil, err
			}
			if ws == nil {
				ws = []proto.KaneoWorkspace{}
			}
			return proto.KaneoWorkspacesResult{Workspaces: ws, Generation: gen}, nil
		}
	case proto.CmdKaneoProjects:
		var a proto.KaneoProjectsArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return err
		}
		work = func(ctx context.Context) (any, error) {
			ps, gen, err := svc.Projects(ctx, a.WorkspaceID)
			if err != nil {
				return nil, err
			}
			if ps == nil {
				ps = []proto.KaneoProject{}
			}
			return proto.KaneoProjectsResult{WorkspaceID: a.WorkspaceID, Projects: ps, Generation: gen}, nil
		}
	default:
		return fmt.Errorf("%w: %q", errUnknownCommand, cmd.T)
	}
	h.startAsync(ctx, c, cmd, work)
	return nil
}

// kaneoView is the connection for the snapshot (nil: no Kaneo settings).
func (h *Hub) kaneoView() *proto.Kaneo {
	if h.opts.Kaneo == nil {
		return nil
	}
	v := h.opts.Kaneo.View()
	return &v
}

// trackKaneo publishes the connection whenever the service says it changed
// (a save, a clear, a run-time 401, a test that ended a pause) and looks at
// the Kaneo floors' boards again.
func (h *Hub) trackKaneo(ctx context.Context) {
	defer h.wg.Done()
	for {
		select {
		case <-ctx.Done():
			return
		case <-h.opts.Kaneo.Changes():
		}
		_ = h.doWait(ctx, func() {
			h.publishKaneo()
			h.kaneoChanged(ctx)
		})
	}
}

// publishKaneo sends the connection as a kaneo.update when it changed.
func (h *Hub) publishKaneo() {
	v := h.opts.Kaneo.View()
	b, err := json.Marshal(v)
	if err != nil || string(b) == h.kn.last {
		return
	}
	h.kn.last = string(b)
	h.seq++
	msg := mustJSON(proto.KaneoUpdate{T: proto.EvKaneoUpdate, Seq: h.seq, Kaneo: v})
	h.ring.add(h.seq, msg)
	for c := range h.clients {
		h.deliver(c, msg)
	}
}

// kaneoErrorCode maps an error of internal/kaneoconf to its protocol code;
// "" when it is none.
func kaneoErrorCode(err error) string {
	return string(kaneoconf.KindOf(err))
}

// auditKaneo is what a Kaneo command leaves in the audit log: the instance
// and whether a key was given, never the key (not even its length).
func auditKaneo(cmd proto.Command) json.RawMessage {
	var a struct {
		URL              *string         `json:"url"`
		Key              *string         `json:"key"`
		DefaultWorkspace json.RawMessage `json:"default_workspace"`
		WorkspaceID      string          `json:"workspace_id"`
	}
	if json.Unmarshal(cmd.Args, &a) != nil {
		return redacted(cmd.Args)
	}
	out := struct {
		URL              string          `json:"url,omitempty"`
		KeyGiven         bool            `json:"key_given,omitempty"`
		DefaultWorkspace json.RawMessage `json:"default_workspace,omitempty"`
		WorkspaceID      string          `json:"workspace_id,omitempty"`
	}{KeyGiven: a.Key != nil && *a.Key != "", WorkspaceID: clip(a.WorkspaceID)}
	if a.URL != nil {
		out.URL = clip(safeURL(*a.URL))
	}
	if len(a.DefaultWorkspace) > 0 && len(a.DefaultWorkspace) <= 256 {
		out.DefaultWorkspace = a.DefaultWorkspace
	}
	return mustJSON(out)
}

// safeURL is a URL for the log: without credentials, a query or a fragment
// (somebody may paste a key into one).
func safeURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "(not a URL)"
	}
	u.User, u.RawQuery, u.Fragment, u.ForceQuery = nil, "", "", false
	return u.String()
}

// KaneoOpenHost is the host of the saved Kaneo instance's web pages ("":
// none, or not https): the one host besides the built-in ones a Mac helper
// may open "Open in Kaneo" links on. It goes to the helper only through the
// bridge's own socket (/healthz), never through a client.
func (h *Hub) KaneoOpenHost() string {
	if h.opts.Kaneo == nil {
		return ""
	}
	l, ok := h.opts.Kaneo.Link()
	if !ok {
		return ""
	}
	u, err := url.Parse(l.WebOrigin)
	if err != nil || u.Scheme != "https" || u.Port() != "" || u.Hostname() == "" {
		return ""
	}
	return u.Hostname()
}

// kaneoChanged looks at the Kaneo floors again after the connection
// changed: a new generation drops their boards (boardOf: what was fetched
// with the old one is never shown again), and a pause that ended (a test of
// the saved connection passed, a new key was saved) lets them poll now.
func (h *Hub) kaneoChanged(ctx context.Context) {
	if !h.opts.Kaneo.PausedUntil().IsZero() {
		return
	}
	if g := h.boards.gates[kaneoGate]; g != nil {
		g.until, g.backoff = time.Time{}, 0
	}
	now := h.opts.Now()
	for _, session := range sortedFloors(h.floors) {
		if bf := h.boardOf(session); bf != nil && bf.src.Tracker == TrackerKaneo && !bf.paused.IsZero() {
			bf.paused, bf.nextAt = time.Time{}, now
		}
	}
	h.boardTick(ctx)
}
