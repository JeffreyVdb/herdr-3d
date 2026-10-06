package codexshare

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// fakeAppServer accepts one WebSocket connection on a unix socket, the way
// `codex app-server --listen unix://PATH` does, and hands it to handle.
func fakeAppServer(t *testing.T, handle func(ctx context.Context, c *websocket.Conn)) string {
	t.Helper()
	sock := filepath.Join(t.TempDir(), "app.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/rpc" {
			http.NotFound(w, r)
			return
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		handle(r.Context(), c)
	})}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return sock
}

func readMsg(ctx context.Context, t *testing.T, c *websocket.Conn) map[string]any {
	_, b, err := c.Read(ctx)
	if err != nil {
		t.Errorf("server read: %v", err)
		return nil
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Errorf("server got %q", b)
	}
	return m
}

func writeMsg(ctx context.Context, c *websocket.Conn, m map[string]any) {
	b, _ := json.Marshal(m)
	_ = c.Write(ctx, websocket.MessageText, b)
}

func TestRPCInitializeCallNotificationsAndServerRequests(t *testing.T) {
	gotInitialized := make(chan bool, 1)
	answered := make(chan map[string]any, 1)
	sock := fakeAppServer(t, func(ctx context.Context, c *websocket.Conn) {
		init := readMsg(ctx, t, c)
		params := init["params"].(map[string]any)
		caps := params["capabilities"].(map[string]any)
		if init["method"] != "initialize" || caps["experimentalApi"] != true || params["clientInfo"].(map[string]any)["name"] != "h3d-test" {
			t.Errorf("initialize = %v", init)
		}
		writeMsg(ctx, c, map[string]any{"id": init["id"], "result": map[string]any{"userAgent": "fake/0.160.1"}})
		gotInitialized <- readMsg(ctx, t, c)["method"] == "initialized"

		call := readMsg(ctx, t, c)
		// A notification and a server request arrive before the response.
		writeMsg(ctx, c, map[string]any{"method": "turn/started", "params": map[string]any{"threadId": "th1"}})
		writeMsg(ctx, c, map[string]any{"id": 77, "method": "item/commandExecution/requestApproval", "params": map[string]any{"threadId": "th1"}})
		writeMsg(ctx, c, map[string]any{"id": call["id"], "result": map[string]any{"data": []string{"th1"}}})

		bad := readMsg(ctx, t, c)
		writeMsg(ctx, c, map[string]any{"id": bad["id"], "error": map[string]any{"code": -32600, "message": "no active turn"}})

		answered <- readMsg(ctx, t, c)
		<-ctx.Done()
	})

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := Dial(ctx, sock)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	res, err := c.Initialize(ctx, "h3d-test")
	if err != nil || res["userAgent"] != "fake/0.160.1" {
		t.Fatalf("initialize: %v %v", res, err)
	}
	if !<-gotInitialized {
		t.Fatal("no initialized notification")
	}

	var list struct {
		Data []string `json:"data"`
	}
	if err := c.Call(ctx, "thread/loaded/list", map[string]any{}, &list); err != nil || len(list.Data) != 1 || list.Data[0] != "th1" {
		t.Fatalf("loaded list %+v %v", list, err)
	}
	n, err := c.WaitNotification(ctx, "turn/started", func(m Message) bool { return m.Param("threadId") == "th1" })
	if err != nil || n.Method != "turn/started" {
		t.Fatalf("notification %+v %v", n, err)
	}
	if got := c.Notifications("turn/started"); len(got) != 1 {
		t.Fatalf("notifications %+v", got)
	}
	req, err := c.WaitServerRequest(ctx, "item/commandExecution/requestApproval")
	if err != nil || string(req.ID) != "77" {
		t.Fatalf("server request %+v %v", req, err)
	}

	err = c.Call(ctx, "turn/steer", map[string]any{"threadId": "th1"}, nil)
	var rpcErr *RPCError
	if err == nil || !errors.As(err, &rpcErr) || rpcErr.Message != "no active turn" {
		t.Fatalf("error = %v", err)
	}

	if err := c.Respond(ctx, req.ID, map[string]any{"decision": "accept"}); err != nil {
		t.Fatal(err)
	}
	a := <-answered
	if a["id"] != float64(77) || a["result"].(map[string]any)["decision"] != "accept" {
		t.Fatalf("answer %v", a)
	}
}

func TestRPCWaitNotificationSeesEarlierMessages(t *testing.T) {
	sock := fakeAppServer(t, func(ctx context.Context, c *websocket.Conn) {
		writeMsg(ctx, c, map[string]any{"method": "thread/started", "params": map[string]any{"thread": map[string]any{"id": "a"}}})
		<-ctx.Done()
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := Dial(ctx, sock)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	time.Sleep(100 * time.Millisecond) // the notification is already buffered
	if _, err := c.WaitNotification(ctx, "thread/started", nil); err != nil {
		t.Fatal(err)
	}
	mark := c.Mark()
	gone, cancel3 := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel3()
	if _, err := c.WaitNotificationFrom(gone, mark, "thread/started", nil); err == nil {
		t.Fatal("a wait from the mark matched an earlier notification")
	}
	short, cancel2 := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel2()
	if _, err := c.WaitNotification(short, "turn/completed", nil); err == nil {
		t.Fatal("waited for a notification that never came")
	}
}

func TestRPCClosedConnectionFailsPendingCalls(t *testing.T) {
	sock := fakeAppServer(t, func(ctx context.Context, c *websocket.Conn) {
		readMsg(ctx, t, c)
		_ = c.Close(websocket.StatusNormalClosure, "bye")
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := Dial(ctx, sock)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := c.Call(ctx, "thread/read", map[string]any{}, nil); err == nil {
		t.Fatal("call on a closed connection succeeded")
	}
}
