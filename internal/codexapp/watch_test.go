package codexapp

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// fakeServer plays a Codex app-server on a unix socket: it records every
// message a client sends, answers initialize and the thread calls, and lets
// a test push notifications and server requests or drop the connection.
type fakeServer struct {
	t    *testing.T
	sock string
	ua   string
	// thread is what thread/resume answers with (nil: an error).
	thread map[string]any

	mu    sync.Mutex
	got   []map[string]any // every message received, across connections
	conns []*websocket.Conn
	joins chan *websocket.Conn
}

func newFakeServer(t *testing.T) *fakeServer {
	t.Helper()
	dir, err := os.MkdirTemp("", "cxapp-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	f := &fakeServer{t: t, sock: filepath.Join(dir, "s.sock"), ua: ClientName + "/0.160.1 (Linux; x86_64) xterm",
		thread: map[string]any{"id": "th1", "cwd": "/w", "path": "/r/rollout.jsonl", "ephemeral": false},
		joins:  make(chan *websocket.Conn, 8)}
	ln, err := net.Listen("unix", f.sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(f.serve)}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return f
}

func (f *fakeServer) serve(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/rpc" {
		http.NotFound(w, r)
		return
	}
	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	f.mu.Lock()
	f.conns = append(f.conns, c)
	f.mu.Unlock()
	ctx := context.Background()
	for {
		_, b, err := c.Read(ctx)
		if err != nil {
			return
		}
		var m map[string]any
		if json.Unmarshal(b, &m) != nil {
			continue
		}
		f.mu.Lock()
		f.got = append(f.got, m)
		f.mu.Unlock()
		id, hasID := m["id"]
		method, _ := m["method"].(string)
		if !hasID || method == "" {
			continue
		}
		var res any = map[string]any{}
		var rpcErr any
		switch method {
		case "initialize":
			res = map[string]any{"userAgent": f.ua, "codexHome": "/h", "platformFamily": "unix", "platformOs": "linux"}
		case "thread/resume":
			if f.thread == nil {
				rpcErr = map[string]any{"code": -32600, "message": "no rollout found"}
			} else {
				res = map[string]any{"thread": f.thread, "model": "mock", "cwd": "/w"}
			}
		case "thread/unsubscribe":
			res = map[string]any{"status": "unsubscribed"}
		}
		out := map[string]any{"id": id, "result": res}
		if rpcErr != nil {
			out = map[string]any{"id": id, "error": rpcErr}
		}
		ob, _ := json.Marshal(out)
		_ = c.Write(ctx, websocket.MessageText, ob)
		if method == "thread/resume" && rpcErr == nil {
			f.joins <- c
		}
	}
}

func (f *fakeServer) send(c *websocket.Conn, v any) {
	f.t.Helper()
	b, _ := json.Marshal(v)
	if err := c.Write(context.Background(), websocket.MessageText, b); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fakeServer) joined() *websocket.Conn {
	f.t.Helper()
	select {
	case c := <-f.joins:
		return c
	case <-time.After(5 * time.Second):
		f.t.Fatal("no client joined")
		return nil
	}
}

func (f *fakeServer) messages() []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]map[string]any(nil), f.got...)
}

func (f *fakeServer) methods() []string {
	var out []string
	for _, m := range f.messages() {
		s, _ := m["method"].(string)
		out = append(out, s)
	}
	return out
}

// recorder collects a watcher's events.
type recorder struct {
	mu     sync.Mutex
	events []Event
	ch     chan Event
}

func newRecorder() *recorder { return &recorder{ch: make(chan Event, 256)} }

func (r *recorder) on(e Event) {
	r.mu.Lock()
	r.events = append(r.events, e)
	r.mu.Unlock()
	r.ch <- e
}

func (r *recorder) wait(t *testing.T, kind EventKind) Event {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case e := <-r.ch:
			if e.Kind == kind {
				return e
			}
		case <-deadline:
			t.Fatalf("no %s event", kind)
		}
	}
}

func watch(t *testing.T, f *fakeServer, r *recorder, mod func(*Options)) *Watcher {
	t.Helper()
	o := Options{Socket: f.sock, Thread: "th1", ClientVersion: "v9.9.9", OnEvent: r.on,
		MinBackoff: 10 * time.Millisecond, MaxBackoff: 40 * time.Millisecond, MaxRetries: 3, CallTimeout: 2 * time.Second}
	if mod != nil {
		mod(&o)
	}
	w, err := Watch(o)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	return w
}

// The handshake names the bridge, enables the experimental API the TUI
// enables too, and joins the thread by id alone: no setting rides along,
// no turn starts.
func TestWatcherHandshakeAndIdentity(t *testing.T) {
	f := newFakeServer(t)
	r := newRecorder()
	w := watch(t, f, r, nil)
	j := r.wait(t, EvJoined)
	if j.Thread == nil || j.Thread.ID != "th1" || j.Thread.Path != "/r/rollout.jsonl" || j.UserAgent != f.ua {
		t.Fatalf("joined %+v", j)
	}
	if w.State() != StateJoined {
		t.Fatalf("state %s", w.State())
	}
	msgs := f.messages()
	if len(msgs) != 3 {
		t.Fatalf("messages %v", msgs)
	}
	init := msgs[0]
	params := init["params"].(map[string]any)
	ci := params["clientInfo"].(map[string]any)
	if init["method"] != "initialize" || ci["name"] != ClientName || ci["version"] != "v9.9.9" ||
		params["capabilities"].(map[string]any)["experimentalApi"] != true {
		t.Fatalf("initialize %v", init)
	}
	if msgs[1]["method"] != "initialized" || msgs[1]["id"] != nil {
		t.Fatalf("initialized %v", msgs[1])
	}
	resume, _ := json.Marshal(msgs[2]["params"])
	if msgs[2]["method"] != "thread/resume" || string(resume) != `{"threadId":"th1"}` {
		t.Fatalf("thread/resume %v (params %s): it must carry the thread id only", msgs[2], resume)
	}
	w.Close()
	for _, m := range f.methods() {
		if m == "turn/start" || m == "turn/steer" || m == "turn/interrupt" || m == "thread/start" {
			t.Fatalf("the watcher sent %s", m)
		}
	}
}

// Server requests (approvals, blocking questions) are observed and never
// answered; their resolution arrives as an ordinary notification.
func TestWatcherIsPassiveToServerRequests(t *testing.T) {
	f := newFakeServer(t)
	r := newRecorder()
	w := watch(t, f, r, nil)
	c := f.joined()
	r.wait(t, EvJoined)
	f.send(c, map[string]any{"id": 77, "method": "item/commandExecution/requestApproval",
		"params": map[string]any{"threadId": "th1", "command": "rm -rf /"}})
	f.send(c, map[string]any{"id": "q1", "method": "item/tool/requestUserInput", "params": map[string]any{"threadId": "th1"}})
	f.send(c, map[string]any{"method": "serverRequest/resolved", "params": map[string]any{"threadId": "th1", "requestId": 77}})
	sr := r.wait(t, EvServerRequest)
	if sr.Method != "item/commandExecution/requestApproval" || string(sr.RequestID) != "77" {
		t.Fatalf("server request %+v", sr)
	}
	if sr = r.wait(t, EvServerRequest); string(sr.RequestID) != `"q1"` {
		t.Fatalf("second server request %+v", sr)
	}
	if n := r.wait(t, EvNotification); n.Method != "serverRequest/resolved" {
		t.Fatalf("notification %+v", n)
	}
	time.Sleep(100 * time.Millisecond)
	w.Close()
	for _, m := range f.messages() {
		if _, isAnswer := m["result"]; isAnswer {
			t.Fatalf("the watcher answered a server request: %v", m)
		}
		if _, isAnswer := m["error"]; isAnswer {
			t.Fatalf("the watcher answered a server request: %v", m)
		}
		if id, ok := m["id"]; ok && (id == float64(77) || id == "q1") {
			t.Fatalf("the watcher wrote with a server request's id: %v", m)
		}
	}
}

// Close leaves with thread/unsubscribe for its own thread, then ends.
func TestWatcherUnsubscribesOnClose(t *testing.T) {
	f := newFakeServer(t)
	r := newRecorder()
	w := watch(t, f, r, nil)
	r.wait(t, EvJoined)
	w.Close()
	r.wait(t, EvClosed)
	msgs := f.messages()
	last := msgs[len(msgs)-1]
	p, _ := json.Marshal(last["params"])
	if last["method"] != "thread/unsubscribe" || string(p) != `{"threadId":"th1"}` {
		t.Fatalf("last message %v", last)
	}
	if w.State() != StateClosed {
		t.Fatalf("state %s", w.State())
	}
	select {
	case <-w.Done():
	default:
		t.Fatal("not done after Close")
	}
}

// A lost connection is reported, and the watcher reconnects and rejoins the
// same thread the same way.
func TestWatcherReconnects(t *testing.T) {
	f := newFakeServer(t)
	r := newRecorder()
	watch(t, f, r, nil)
	c := f.joined()
	r.wait(t, EvJoined)
	_ = c.CloseNow()
	if d := r.wait(t, EvDisconnected); d.Err == nil {
		t.Fatal("disconnected without an error")
	}
	f.joined()
	r.wait(t, EvJoined)
	var resumes int
	for _, m := range f.messages() {
		if m["method"] == "thread/resume" {
			resumes++
			if p, _ := json.Marshal(m["params"]); string(p) != `{"threadId":"th1"}` {
				t.Fatalf("rejoin params %s", p)
			}
		}
	}
	if resumes != 2 {
		t.Fatalf("thread/resume sent %d times", resumes)
	}
}

// Reconnecting is bounded: a server that is gone ends the watcher.
func TestWatcherGivesUp(t *testing.T) {
	r := newRecorder()
	w, err := Watch(Options{Socket: filepath.Join(t.TempDir(), "gone.sock"), Thread: "th1", OnEvent: r.on,
		MinBackoff: time.Millisecond, MaxBackoff: 2 * time.Millisecond, MaxRetries: 2})
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	if e := r.wait(t, EvFailed); e.Err == nil {
		t.Fatal("failed without an error")
	}
	<-w.Done()
	if w.State() != StateFailed {
		t.Fatalf("state %s", w.State())
	}
	var disc int
	for _, e := range r.events {
		if e.Kind == EvDisconnected {
			disc++
		}
	}
	if disc != 2 {
		t.Fatalf("%d retries, want 2", disc)
	}
}

// An unsupported server, an ephemeral thread or another thread end the
// watcher at once: retrying would not change them.
func TestWatcherRefusesWithoutRetry(t *testing.T) {
	for name, mod := range map[string]func(*fakeServer){
		"unsupported": func(f *fakeServer) { f.ua = ClientName + "/0.161.0 (Linux)" },
		"ephemeral":   func(f *fakeServer) { f.thread["ephemeral"] = true },
		"other":       func(f *fakeServer) { f.thread["id"] = "th2" },
	} {
		t.Run(name, func(t *testing.T) {
			f := newFakeServer(t)
			mod(f)
			r := newRecorder()
			w := watch(t, f, r, nil)
			e := r.wait(t, EvFailed)
			if !errors.Is(e.Err, ErrUnsupported) && !errors.Is(e.Err, ErrEphemeral) && !errors.Is(e.Err, ErrWrongThread) {
				t.Fatalf("err %v", e.Err)
			}
			<-w.Done()
			for _, ev := range r.events {
				if ev.Kind == EvDisconnected || ev.Kind == EvJoined {
					t.Fatalf("event %+v", ev)
				}
			}
			if name == "unsupported" {
				for _, m := range f.methods() {
					if m == "thread/resume" {
						t.Fatal("joined an unsupported server")
					}
				}
			}
		})
	}
}

func TestVersionChecks(t *testing.T) {
	for v, ok := range map[string]bool{
		"codex-cli 0.160.1\n": true, "codex-cli 0.160.12": true, "codex-cli 0.161.0": false, "codex-cli 0.16.0": false,
		"codex-cli 0.160.": false, "codex-cli 0.160.1-alpha": false, "codex 0.160.1": false, "": false,
	} {
		if err := CheckVersion(v); (err == nil) != ok {
			t.Errorf("CheckVersion(%q) = %v", v, err)
		}
	}
	for ua, ok := range map[string]bool{
		"herdr_3d/0.160.1 (AlmaLinux 10.2.0; x86_64) xterm-256color (herdr_3d; v1)": true,
		"codex_cli_rs/0.160.3": true, "herdr_3d/0.159.9 (x)": false, "herdr_3d": false, "": false,
	} {
		if err := CheckUserAgent(ua); (err == nil) != ok {
			t.Errorf("CheckUserAgent(%q) = %v", ua, err)
		}
	}
}
