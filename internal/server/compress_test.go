package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// countingConn counts the bytes read from the bridge: what crossed the wire.
type countingConn struct {
	net.Conn
	read *atomic.Int64
}

func (c countingConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	c.read.Add(int64(n))
	return n, err
}

// dialWith dials the bridge socket with opts (their HTTPClient is set here)
// and counts the bytes read into read.
func dialWith(t *testing.T, sock string, opts websocket.DialOptions, read *atomic.Int64) (*websocket.Conn, *http.Response) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	opts.HTTPClient = &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			c, err := d.DialContext(ctx, "unix", sock)
			if err != nil {
				return nil, err
			}
			return countingConn{c, read}, nil
		},
	}}
	ws, resp, err := websocket.Dial(ctx, "ws://herdr-world/ws", &opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ws.CloseNow() })
	ws.SetReadLimit(proto.MaxMessage)
	return ws, resp
}

// bigTitle is worker i's title on bigFloor.
func bigTitle(i, n int) string {
	return fmt.Sprintf("worker %d of %d reads the transcript index of run %x and checks every row against the store", i, n, i*7919)
}

// bigFloor publishes a floor of n workers with long titles and waits until a
// new client's snapshot holds them all (a client that heard them one by one
// would be cut off as a slow consumer).
func bigFloor(b *bridge, n int) {
	b.t.Helper()
	workers := make([]world.WorkerObs, n)
	for i := range workers {
		w := worker(fmt.Sprintf("w%04d", i), fmt.Sprintf("CODE|big|%d|r%d", i, i%7), fmt.Sprintf("sess-%d", i), "working")
		w.Title = bigTitle(i, n)
		workers[i] = w
	}
	b.floor("big", true, workers...)
	deadline := time.Now().Add(5 * time.Second)
	for len(b.connect(proto.Hello{}).snapshot().World.Workers) < n {
		if time.Now().After(deadline) {
			b.t.Fatal("the big floor never reached a snapshot")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestWebSocketCompression(t *testing.T) {
	t.Parallel()
	b := startBridge(t, "", server.Options{})
	const n = 2000
	bigFloor(b, n)

	var wire atomic.Int64
	ws, resp := dialWith(t, b.sock, websocket.DialOptions{CompressionMode: websocket.CompressionContextTakeover}, &wire)
	if ext := resp.Header.Get("Sec-WebSocket-Extensions"); !strings.Contains(ext, "permessage-deflate") {
		t.Fatalf("Sec-WebSocket-Extensions = %q, want permessage-deflate", ext)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	hello, _ := json.Marshal(proto.Hello{T: proto.THello, Proto: proto.Version, Client: "deflate-test"})
	if err := ws.Write(ctx, websocket.MessageText, hello); err != nil {
		t.Fatal(err)
	}
	if _, raw, err := ws.Read(ctx); err != nil || !strings.Contains(string(raw), `"t":"welcome"`) {
		t.Fatalf("welcome = %s, %v", raw, err)
	}
	before := wire.Load()
	_, raw, err := ws.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var snap proto.Snapshot
	if err := json.Unmarshal(raw, &snap); err != nil || snap.T != proto.TSnapshot {
		t.Fatalf("snapshot: %v", err)
	}
	if len(snap.World.Workers) != n {
		t.Fatalf("snapshot has %d workers, want %d", len(snap.World.Workers), n)
	}
	for _, w := range snap.World.Workers {
		var i int
		if _, err := fmt.Sscanf(w.WorkspaceID, "w%04d", &i); err != nil || w.Title != bigTitle(i, n) {
			t.Fatalf("worker %s: title %q", w.WorkspaceID, w.Title)
		}
	}
	// The snapshot is first-page sized and crossed the wire deflated.
	if got := wire.Load() - before; len(raw) < 400<<10 || got > int64(len(raw))/3 {
		t.Fatalf("snapshot of %d bytes took %d bytes on the wire", len(raw), got)
	}

	// Go clients (proto.Dial: default options) negotiate nothing.
	var plain atomic.Int64
	_, resp = dialWith(t, b.sock, websocket.DialOptions{}, &plain)
	if ext := resp.Header.Get("Sec-WebSocket-Extensions"); ext != "" {
		t.Fatalf("default dial: Sec-WebSocket-Extensions = %q, want none", ext)
	}
}

// A deflated client message is bounded by what it inflates to, not by its
// size on the wire.
func TestWebSocketCompressedReadLimit(t *testing.T) {
	t.Parallel()
	b := startBridge(t, "", server.Options{})
	var wire atomic.Int64
	ws, _ := dialWith(t, b.sock, websocket.DialOptions{CompressionMode: websocket.CompressionContextTakeover}, &wire)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	hello, _ := json.Marshal(proto.Hello{T: proto.THello, Proto: proto.Version, Client: "deflate-test"})
	if err := ws.Write(ctx, websocket.MessageText, hello); err != nil {
		t.Fatal(err)
	}
	for range 2 { // welcome, snapshot
		if _, _, err := ws.Read(ctx); err != nil {
			t.Fatal(err)
		}
	}
	// A megabyte of spaces deflates to a few kilobytes.
	bomb := `{"t":"floor.note.set","req_id":"x","args":{"text":"` + strings.Repeat(" ", 1<<20) + `"}}`
	if err := ws.Write(ctx, websocket.MessageText, []byte(bomb)); err != nil {
		t.Fatal(err)
	}
	var err error
	for err == nil {
		_, _, err = ws.Read(ctx)
	}
	if s := websocket.CloseStatus(err); s != websocket.StatusMessageTooBig {
		t.Fatalf("read after the bomb: %v (status %d), want message too big", err, s)
	}
}
