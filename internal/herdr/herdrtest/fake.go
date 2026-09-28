// Package herdrtest is a fake herdr session server for tests: it speaks the
// NDJSON socket protocol (one request per connection, long-lived
// `events.subscribe` streams), serves a settable snapshot, pushes scripted
// events and can drop its streams to simulate EOF. It records every method
// it is asked for, so tests can assert the bridge stays read-only.
package herdrtest

import (
	"bufio"
	"context"
	"embed"
	"encoding/json"
	"net"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
)

//go:embed testdata
var fixtures embed.FS

// Fixture returns the bytes of testdata/<name>.
func Fixture(t testing.TB, name string) []byte {
	t.Helper()
	b, err := fixtures.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatalf("fixture %s: %v", name, err)
	}
	return b
}

// SnapshotFixture returns `result.snapshot` of a recorded snapshot response.
func SnapshotFixture(t testing.TB, name string) json.RawMessage {
	t.Helper()
	var resp struct {
		Result struct {
			Snapshot json.RawMessage `json:"snapshot"`
		} `json:"result"`
	}
	if err := json.Unmarshal(Fixture(t, name), &resp); err != nil || resp.Result.Snapshot == nil {
		t.Fatalf("fixture %s: not a snapshot response: %v", name, err)
	}
	return resp.Result.Snapshot
}

// Server is a fake herdr session server on a unix socket.
type Server struct {
	Socket string

	ln       net.Listener
	mu       sync.Mutex
	snapshot json.RawMessage
	methods  []string
	subs     map[*sub]struct{}
	changed  chan struct{} // closed and replaced whenever subs changes
	failing  map[string]string
}

type sub struct {
	conn  net.Conn
	mu    sync.Mutex
	types map[string]bool
	panes map[string]bool
}

// Start listens on dir/herdr.sock. Keep dir short: unix socket paths are
// limited to ~108 bytes.
func Start(t testing.TB, dir string) *Server {
	t.Helper()
	s := &Server{
		Socket:   filepath.Join(dir, "herdr.sock"),
		snapshot: json.RawMessage(`{"version":"0.9.0","protocol":22,"workspaces":[],"tabs":[],"panes":[],"layouts":[],"agents":[]}`),
		subs:     map[*sub]struct{}{},
		changed:  make(chan struct{}),
		failing:  map[string]string{},
	}
	ln, err := net.Listen("unix", s.Socket)
	if err != nil {
		t.Fatal(err)
	}
	s.ln = ln
	go s.serve()
	t.Cleanup(s.Close)
	return s
}

// SetSnapshot replaces what `session.snapshot` returns (`result.snapshot`).
func (s *Server) SetSnapshot(snap json.RawMessage) {
	s.mu.Lock()
	s.snapshot = snap
	s.mu.Unlock()
}

// Fail makes method answer with an error of this code ("" to stop).
func (s *Server) Fail(method, code string) {
	s.mu.Lock()
	s.failing[method] = code
	s.mu.Unlock()
}

// Methods returns every method requested so far, in order.
func (s *Server) Methods() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.methods)
}

// Close stops listening and drops every stream.
func (s *Server) Close() {
	s.ln.Close()
	s.DropStreams()
}

// DropStreams closes every open subscription, as a server stop would.
func (s *Server) DropStreams() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for c := range s.subs {
		c.conn.Close()
		delete(s.subs, c)
	}
	s.notify()
}

// WaitStatusPane waits until some stream subscribes to status of paneID.
func (s *Server) WaitStatusPane(t testing.TB, paneID string) {
	t.Helper()
	s.waitFor(t, func() bool {
		for c := range s.subs {
			if c.panes[paneID] {
				return true
			}
		}
		return false
	})
}

// WaitStreams waits until n subscriptions are open.
func (s *Server) WaitStreams(t testing.TB, n int) {
	t.Helper()
	s.waitFor(t, func() bool { return len(s.subs) == n })
}

func (s *Server) waitFor(t testing.TB, ok func() bool) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		s.mu.Lock()
		done, ch := ok(), s.changed
		s.mu.Unlock()
		if done {
			return
		}
		select {
		case <-ch:
		case <-deadline:
			t.Fatal("herdrtest: timed out waiting for subscriptions")
		}
	}
}

// PushLifecycle sends a lifecycle event (e.g. "workspace_created") to every
// stream subscribed to its type ("workspace.created").
func (s *Server) PushLifecycle(event string, data any) {
	line := mustLine(map[string]any{"event": event, "data": data})
	typ := lifecycleType(event)
	s.push(line, func(c *sub) bool { return c.types[typ] })
}

// PushStatus sends a `pane.agent_status_changed` event to streams subscribed
// to that pane.
func (s *Server) PushStatus(paneID, workspaceID, status, agent string) {
	data := map[string]any{"pane_id": paneID, "workspace_id": workspaceID, "agent_status": status}
	if agent != "" {
		data["agent"] = agent
	}
	line := mustLine(map[string]any{"event": "pane.agent_status_changed", "data": data})
	s.push(line, func(c *sub) bool { return c.panes[paneID] })
}

// PushRaw sends one recorded event line to every stream.
func (s *Server) PushRaw(line []byte) {
	s.push(append(slices.Clone(line), '\n'), func(*sub) bool { return true })
}

func (s *Server) push(line []byte, match func(*sub) bool) {
	s.mu.Lock()
	var targets []*sub
	for c := range s.subs {
		if match(c) {
			targets = append(targets, c)
		}
	}
	s.mu.Unlock()
	for _, c := range targets {
		c.mu.Lock()
		_, _ = c.conn.Write(line)
		c.mu.Unlock()
	}
}

func (s *Server) notify() {
	close(s.changed)
	s.changed = make(chan struct{})
}

func (s *Server) serve() {
	for {
		conn, err := s.ln.Accept()
		if err != nil {
			return
		}
		go s.handle(conn)
	}
}

func (s *Server) handle(conn net.Conn) {
	r := bufio.NewReader(conn)
	line, err := r.ReadBytes('\n')
	if err != nil {
		conn.Close()
		return
	}
	var req struct {
		ID     string          `json:"id"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(line, &req); err != nil {
		conn.Close()
		return
	}
	s.mu.Lock()
	s.methods = append(s.methods, req.Method)
	snap, failCode := s.snapshot, s.failing[req.Method]
	s.mu.Unlock()
	if failCode != "" {
		_, _ = conn.Write(mustLine(map[string]any{"id": req.ID, "error": map[string]any{"code": failCode, "message": "herdrtest: failing on purpose"}}))
		conn.Close()
		return
	}

	reply := func(v any) { _, _ = conn.Write(mustLine(map[string]any{"id": req.ID, "result": v})) }
	switch req.Method {
	case "ping":
		reply(map[string]any{"type": "pong", "version": "0.9.0", "protocol": 22})
	case "session.snapshot":
		reply(map[string]any{"type": "session_snapshot", "snapshot": snap})
	case "events.subscribe":
		var p struct {
			Subscriptions []struct {
				Type   string `json:"type"`
				PaneID string `json:"pane_id"`
			} `json:"subscriptions"`
		}
		_ = json.Unmarshal(req.Params, &p)
		c := &sub{conn: conn, types: map[string]bool{}, panes: map[string]bool{}}
		for _, sb := range p.Subscriptions {
			if sb.PaneID != "" {
				c.panes[sb.PaneID] = true
			} else {
				c.types[sb.Type] = true
			}
		}
		// Register before replying: the client returns from Subscribe on the
		// reply, so an event pushed right after must find this stream. Holding
		// c.mu keeps any such push behind the reply on the wire.
		c.mu.Lock()
		s.mu.Lock()
		s.subs[c] = struct{}{}
		s.notify()
		s.mu.Unlock()
		reply(map[string]any{"type": "subscription_started"})
		c.mu.Unlock()
		// Like herdr, ignore anything else the client sends; the stream
		// ends when either side closes.
		_, _ = r.ReadBytes(0)
		s.mu.Lock()
		if _, ok := s.subs[c]; ok {
			delete(s.subs, c)
			s.notify()
		}
		s.mu.Unlock()
		conn.Close()
		return
	default:
		_, _ = conn.Write(mustLine(map[string]any{"id": req.ID, "error": map[string]any{
			"code": "unknown_method", "message": "herdrtest: " + req.Method + " is not faked",
		}}))
	}
	conn.Close()
}

// lifecycleType maps an event name ("workspace_created") to its
// subscription type ("workspace.created").
func lifecycleType(event string) string {
	for i := 0; i < len(event); i++ {
		if event[i] == '_' {
			return event[:i] + "." + event[i+1:]
		}
	}
	return event
}

func mustLine(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return append(b, '\n')
}

// Lister is a herdr client whose `session list` is scripted: socket calls
// go to real (fake-server) sockets through the embedded *herdr.Client.
type Lister struct {
	*herdr.Client
	mu       sync.Mutex
	sessions []herdr.Session
	err      error
}

// NewLister returns a Lister that lists nothing yet.
func NewLister() *Lister {
	return &Lister{Client: &herdr.Client{DialTimeout: 200 * time.Millisecond}}
}

// Set replaces the listed sessions.
func (l *Lister) Set(sessions ...herdr.Session) {
	l.mu.Lock()
	l.sessions, l.err = slices.Clone(sessions), nil
	l.mu.Unlock()
}

// Fail makes listing fail until the next Set.
func (l *Lister) Fail(err error) {
	l.mu.Lock()
	l.err = err
	l.mu.Unlock()
}

// ListSessions returns the scripted sessions.
func (l *Lister) ListSessions(context.Context) ([]herdr.Session, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return slices.Clone(l.sessions), l.err
}
