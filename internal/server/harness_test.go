package server_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

func quietLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// shortDir is a temp dir short enough for a unix socket path.
func shortDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "h3d")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

// bridge is a hub + WebSocket server on a temp socket and database.
type bridge struct {
	t       *testing.T
	hub     *server.Hub
	st      *store.Store
	sock    string
	stop    func()
	stopped chan struct{}
}

func startBridge(t *testing.T, db string, opts server.Options) *bridge {
	t.Helper()
	return startBridgeWith(t, db, opts, nil)
}

// startBridgeWith is startBridge that lets the test set up the server (before it serves).
func startBridgeWith(t *testing.T, db string, opts server.Options, setup func(*server.Server)) *bridge {
	t.Helper()
	if db == "" {
		db = filepath.Join(t.TempDir(), "world.db")
	}
	ctx, cancel := context.WithCancel(context.Background())
	st, err := store.Open(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if opts.Log == nil {
		opts.Log = quietLog()
	}
	hub, err := server.NewHub(ctx, st, opts)
	if err != nil {
		t.Fatal(err)
	}
	sock := filepath.Join(shortDir(t), "run", "bridge.sock")
	ln, err := server.Listen(sock)
	if err != nil {
		t.Fatal(err)
	}
	b := &bridge{t: t, hub: hub, st: st, sock: sock, stopped: make(chan struct{})}
	hubDone := make(chan struct{})
	go func() { hub.Run(ctx); close(hubDone) }()
	go func() {
		srv := server.NewServer(hub, quietLog())
		if setup != nil {
			setup(srv)
		}
		srv.Serve(ctx, ln)
		<-hubDone
		st.Close()
		close(b.stopped)
	}()
	b.stop = func() {
		cancel()
		<-b.stopped
	}
	t.Cleanup(b.stop)
	return b
}

func (b *bridge) publish(u world.Update) {
	b.t.Helper()
	select {
	case b.hub.Updates() <- u:
	case <-time.After(5 * time.Second):
		b.t.Fatal("hub not accepting updates")
	}
}

func (b *bridge) floor(session string, running bool, workers ...world.WorkerObs) {
	b.t.Helper()
	b.publish(world.FloorObs{Session: session, Running: running, Gen: world.NextGen(), Workers: workers})
}

type client struct {
	t       *testing.T
	conn    *proto.Conn
	welcome proto.Welcome
	seq     uint64
}

func (b *bridge) connect(hello proto.Hello) *client {
	b.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := proto.Dial(ctx, b.sock)
	if err != nil {
		b.t.Fatal(err)
	}
	b.t.Cleanup(func() { conn.CloseNow() })
	if hello.Client == "" {
		hello.Client = "test"
	}
	w, err := conn.Hello(ctx, hello)
	if err != nil {
		b.t.Fatal(err)
	}
	return &client{t: b.t, conn: conn, welcome: w, seq: w.ServerSeq}
}

type msg struct {
	env proto.Envelope
	raw []byte
}

func (c *client) next() msg {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	env, raw, err := c.conn.Read(ctx)
	if err != nil {
		c.t.Fatalf("read: %v", err)
	}
	if env.Seq != 0 && env.T != proto.TSnapshot {
		if env.Seq != c.seq+1 {
			c.t.Fatalf("seq %d after %d: %s", env.Seq, c.seq, raw)
		}
		c.seq = env.Seq
	}
	return msg{env, raw}
}

func (c *client) snapshot() proto.Snapshot {
	c.t.Helper()
	m := c.next()
	if m.env.T != proto.TSnapshot {
		c.t.Fatalf("expected world.snapshot, got %s", m.raw)
	}
	var s proto.Snapshot
	if err := json.Unmarshal(m.raw, &s); err != nil {
		c.t.Fatal(err)
	}
	c.seq = s.Seq
	return s
}

func (c *client) event() proto.Event {
	c.t.Helper()
	m := c.next()
	var ev proto.Event
	if m.env.T == proto.EvActivityUpdate { // #98: its flat fields are not Event's (classifier is a role's state)
		return proto.Event{T: m.env.T, Seq: m.env.Seq}
	}
	if err := json.Unmarshal(m.raw, &ev); err != nil {
		c.t.Fatal(err)
	}
	return ev
}

// events reads until it has n events.
func (c *client) events(n int) []proto.Event {
	c.t.Helper()
	out := make([]proto.Event, 0, n)
	for len(out) < n {
		out = append(out, c.event())
	}
	return out
}

// until reads events until one has type typ.
func (c *client) until(typ string) proto.Event {
	c.t.Helper()
	for {
		if ev := c.event(); ev.T == typ {
			return ev
		}
	}
}

func (c *client) send(v any) {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.conn.Send(ctx, v); err != nil {
		c.t.Fatal(err)
	}
}

// command sends a command and returns the events it caused and its reply.
func (c *client) command(typ, reqID string, args any) ([]proto.Event, msg) {
	c.t.Helper()
	cmd := proto.Command{T: typ, ReqID: reqID}
	if args != nil {
		b, err := json.Marshal(args)
		if err != nil {
			c.t.Fatal(err)
		}
		cmd.Args = b
	}
	c.send(cmd)
	var evs []proto.Event
	for {
		m := c.next()
		if m.env.T == proto.TAck || m.env.T == proto.TError {
			if m.env.ReqID != reqID {
				c.t.Fatalf("reply for %q, want %q: %s", m.env.ReqID, reqID, m.raw)
			}
			return evs, m
		}
		var ev proto.Event
		_ = json.Unmarshal(m.raw, &ev)
		evs = append(evs, ev)
	}
}

func (c *client) mustAck(typ string, args any) ([]proto.Event, proto.Ack) {
	c.t.Helper()
	evs, m := c.command(typ, typ, args)
	if m.env.T != proto.TAck {
		c.t.Fatalf("%s: %s", typ, m.raw)
	}
	var ack proto.Ack
	_ = json.Unmarshal(m.raw, &ack)
	return evs, ack
}

func (c *client) mustError(typ string, args any, code string) {
	c.t.Helper()
	_, m := c.command(typ, "e-"+typ, args)
	var e proto.Error
	_ = json.Unmarshal(m.raw, &e)
	if m.env.T != proto.TError || e.Code != code {
		c.t.Fatalf("%s: got %s, want error %s", typ, m.raw, code)
	}
}

func createBuilding(c *client, name string) string {
	c.t.Helper()
	_, ack := c.mustAck(proto.CmdBuildingCreate, proto.BuildingCreateArgs{Name: name})
	return ack.Data.(map[string]any)["id"].(string)
}

func ptr[T any](v T) *T { return &v }

func worker(ws, label, agentSession, status string) world.WorkerObs {
	return world.WorkerObs{WorkspaceID: ws, Label: label, IdentityCwd: "/home/u/" + ws, Cwd: "/home/u/" + ws,
		PaneID: ws + ":p1", AgentSession: agentSession, Status: status}
}
