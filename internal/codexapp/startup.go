package codexapp

import (
	"context"
	"encoding/json"
	"reflect"
	"sort"
	"sync"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/mcpdiag"
)

// Startup observes one fresh worker server before the TUI starts. An
// initialized client gets thread/started, but MCP events require a thread
// subscription, unavailable before the first turn. It polls thread-scoped
// status during that gap (verified by codexshare). It never
// creates a thread, sends a turn or lists MCP status without a thread.
type Startup struct {
	c      *conn
	cancel context.CancelFunc
	done   chan struct{}
	mu     sync.Mutex
	rows   []mcpdiag.Diagnostic
}

func ObserveStartup(ctx context.Context, socket, cwd string, changed func([]mcpdiag.Diagnostic)) (*Startup, error) {
	ctx, cancel := context.WithTimeout(ctx, 35*time.Second)
	s := &Startup{cancel: cancel, done: make(chan struct{})}
	threads := make(chan string, 1)
	var threadMu sync.Mutex
	thread := ""
	c, err := dial(ctx, socket, func(m Message) {
		if len(m.ID) != 0 {
			return
		} // approvals remain the terminal's
		if m.Method == "thread/started" {
			var n struct {
				Thread *Thread `json:"thread"`
			}
			if json.Unmarshal(m.Params, &n) == nil && n.Thread != nil && n.Thread.isRoot() && n.Thread.Cwd == cwd {
				select {
				case threads <- n.Thread.ID:
				default:
				}
			}
		}
		threadMu.Lock()
		id := thread
		threadMu.Unlock()
		if d, ok := StartupNotification(id, m.Method, m.Params); ok {
			s.update([]mcpdiag.Diagnostic{d}, changed)
		}
	})
	if err != nil {
		cancel()
		return nil, err
	}
	s.c = c
	iCtx, stop := context.WithTimeout(ctx, 2*time.Second)
	err = c.call(iCtx, "initialize", initParams("startup"), nil)
	if err == nil {
		err = c.notify(iCtx, "initialized")
	}
	var names []string
	if err == nil {
		names, err = mcpNames(iCtx, c, cwd)
	}
	stop()
	if err != nil {
		cancel()
		c.close()
		return nil, err
	}
	go func() {
		defer close(s.done)
		defer c.close()
		defer cancel()
		var id string
		select {
		case id = <-threads:
		case <-ctx.Done():
			return
		case <-c.done:
			return
		}
		threadMu.Lock()
		thread = id
		threadMu.Unlock()
		// Before its first turn the TUI's thread has no rollout: thread/resume
		// is refused. Thread-scoped status reads still reuse its connections.
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		for {
			cctx, stop := context.WithTimeout(ctx, 10*time.Second)
			rows, err := startupStatus(cctx, c, id, names)
			stop()
			if err == nil {
				s.update(rows, changed)
			}
			select {
			case <-ticker.C:
			case <-ctx.Done():
				return
			case <-c.done:
				return
			}
		}
	}()

	return s, nil
}

func (s *Startup) update(rows []mcpdiag.Diagnostic, changed func([]mcpdiag.Diagnostic)) {
	s.mu.Lock()
	next := mcpdiag.Merge(s.rows, rows...)
	if reflect.DeepEqual(next, s.rows) {
		s.mu.Unlock()
		return
	}
	s.rows = next
	copy := mcpdiag.Merge(nil, s.rows...)
	s.mu.Unlock()
	if changed != nil {
		changed(copy)
	}
}

func (s *Startup) Snapshot() []mcpdiag.Diagnostic {
	s.mu.Lock()
	defer s.mu.Unlock()
	return mcpdiag.Merge(nil, s.rows...)
}

func (s *Startup) Close() { s.cancel(); <-s.done }

// StartupNotification drops unrelated threads and all unrecognized data.
func StartupNotification(thread, method string, params json.RawMessage) (mcpdiag.Diagnostic, bool) {
	var n struct{ ThreadID, Name, Status, Error, FailureReason string }
	if thread == "" || method != "mcpServer/startupStatus/updated" || json.Unmarshal(params, &n) != nil || n.ThreadID != thread || mcpdiag.Name(n.Name) == "" {
		return mcpdiag.Diagnostic{}, false
	}
	switch n.Status {
	case "starting", "ready", "failed", "cancelled":
	default:
		return mcpdiag.Diagnostic{}, false
	}
	d := mcpdiag.Diagnostic{Name: n.Name, Stage: n.Status, Source: "notification"}
	if n.Status == "failed" || n.Status == "cancelled" {
		d.Category = mcpdiag.Category(n.Error)
		if n.FailureReason == "reauthenticationRequired" {
			d.Category = "auth"
		}
	}
	return d, true
}

// Codex 0.163 requires BOTH threadId and serverName to reuse the
// connection. A bare threadId still performs a fresh connection check.
func startupStatus(ctx context.Context, c *conn, id string, names []string) ([]mcpdiag.Diagnostic, error) {
	rows, err := mcpStatuses(ctx, c, id, names)
	return StartupStatuses(rows), err
}

func mcpStatuses(ctx context.Context, c *conn, id string, names []string) ([]MCPServerStatus, error) {
	var out []MCPServerStatus
	for _, name := range names {
		var res struct {
			Data []MCPServerStatus `json:"data"`
		}
		if err := c.call(ctx, "mcpServerStatus/list", map[string]any{"threadId": id, "serverName": name, "detail": "toolsAndAuthOnly", "limit": 1}, &res); err != nil {
			return out, err
		}
		out = append(out, res.Data...)
	}
	return out, nil
}

func mcpNames(ctx context.Context, c *conn, cwd string) ([]string, error) {
	var res struct {
		Config struct {
			Servers map[string]struct {
				Enabled *bool `json:"enabled"`
			} `json:"mcp_servers"`
		} `json:"config"`
	}
	params := map[string]any{"includeLayers": false}
	if cwd != "" {
		params["cwd"] = cwd
	}
	if err := c.call(ctx, "config/read", params, &res); err != nil {
		return nil, err
	}
	names := []string{}
	for name, cfg := range res.Config.Servers {
		if mcpdiag.Name(name) != "" && (cfg.Enabled == nil || *cfg.Enabled) {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names[:min(len(names), mcpdiag.Limit)], nil
}

func StartupStatuses(rows []MCPServerStatus) []mcpdiag.Diagnostic {
	var out []mcpdiag.Diagnostic
	for _, r := range rows {
		if r.RuntimeStatus == nil {
			continue
		}
		d := mcpdiag.Diagnostic{Name: r.Name, Source: "thread_status"}
		switch *r.RuntimeStatus {
		case "starting":
			d.Stage = "starting"
		case "connected":
			d.Stage = "ready"
		case "failed", "cancelled":
			d.Stage, d.Category = *r.RuntimeStatus, "startup"
			if r.ToolsError != nil {
				d.Category = mcpdiag.Category(*r.ToolsError)
			}
		case "authenticationRequired":
			d.Stage, d.Category = "failed", "auth"
		default:
			continue
		}
		out = mcpdiag.Merge(out, d)
	}
	return out
}

// StartupDiagnostics reconciles warnings missed before a watcher joined.
func (w *Watcher) StartupDiagnostics(ctx context.Context) ([]mcpdiag.Diagnostic, error) {
	rows, err := w.MCPStatus(ctx)
	return StartupStatuses(rows), err
}
