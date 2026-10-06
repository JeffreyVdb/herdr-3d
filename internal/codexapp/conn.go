// Package codexapp is the bridge's side of a Codex worker's own app-server
// (#155): the launch files of a shared-server worker, the processes it may
// stop, the checks before a launch, and the protocol adapter that joins the
// worker's thread as a second, passive client. Every Codex protocol detail
// the bridge knows lives here (docs/research/codex-shared-tui.md, Codex
// rust-v0.160.1).
package codexapp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"sync"

	"github.com/coder/websocket"
)

// Message is one JSON-RPC message of the Codex app-server protocol (which
// omits the "jsonrpc" member). A server request has both ID and Method.
type Message struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *RPCError       `json:"error,omitempty"`
}

// RPCError is a JSON-RPC error response.
type RPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *RPCError) Error() string { return fmt.Sprintf("app-server error %d: %s", e.Code, e.Message) }

// MaxMessage bounds one message read from an app-server.
const MaxMessage = 64 << 20

// DialWS opens the WebSocket an app-server started with `--listen
// unix://<sock>` serves at ws://localhost/rpc, as Codex's remote TUI does
// (rust-v0.160.1 app-server-client/src/remote.rs).
func DialWS(ctx context.Context, sock string) (*websocket.Conn, error) {
	hc := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", sock)
		},
	}}
	ws, _, err := websocket.Dial(ctx, "ws://localhost/rpc", &websocket.DialOptions{HTTPClient: hc})
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", sock, err)
	}
	ws.SetReadLimit(MaxMessage)
	return ws, nil
}

// conn is one connection to an app-server. It only ever sends requests
// with ids of its own and notifications: it has no way to answer a server
// request (D4: the terminal answers approvals and questions, the first
// answer wins).
type conn struct {
	ws       *websocket.Conn
	incoming func(Message) // notifications and server requests, on the read goroutine

	mu      sync.Mutex
	nextID  int
	pending map[string]chan Message
	err     error
	done    chan struct{}
}

func dial(ctx context.Context, sock string, incoming func(Message)) (*conn, error) {
	ws, err := DialWS(ctx, sock)
	if err != nil {
		return nil, err
	}
	c := &conn{ws: ws, incoming: incoming, pending: map[string]chan Message{}, done: make(chan struct{})}
	go c.readLoop()
	return c, nil
}

var errClosed = errors.New("connection closed")

func (c *conn) readLoop() {
	defer close(c.done)
	for {
		_, b, err := c.ws.Read(context.Background())
		if err != nil {
			c.mu.Lock()
			c.err = err
			for id, ch := range c.pending {
				close(ch)
				delete(c.pending, id)
			}
			c.mu.Unlock()
			return
		}
		var m Message
		if json.Unmarshal(b, &m) != nil {
			continue
		}
		if m.Method == "" && len(m.ID) > 0 {
			c.mu.Lock()
			if ch, ok := c.pending[string(m.ID)]; ok {
				ch <- m
				delete(c.pending, string(m.ID))
			}
			c.mu.Unlock()
			continue
		}
		if m.Method != "" && c.incoming != nil {
			c.incoming(m)
		}
	}
}

// call sends a request and decodes its result into out (when non-nil).
func (c *conn) call(ctx context.Context, method string, params, out any) error {
	c.mu.Lock()
	if c.err != nil {
		c.mu.Unlock()
		return fmt.Errorf("%s: %w: %v", method, errClosed, c.err)
	}
	c.nextID++
	n := c.nextID
	id := strconv.Itoa(n)
	ch := make(chan Message, 1)
	c.pending[id] = ch
	c.mu.Unlock()
	if err := c.write(ctx, map[string]any{"id": n, "method": method, "params": params}); err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return fmt.Errorf("%s: %w", method, err)
	}
	select {
	case m, ok := <-ch:
		if !ok {
			return fmt.Errorf("%s: %w", method, errClosed)
		}
		if m.Error != nil {
			return fmt.Errorf("%s: %w", method, m.Error)
		}
		if out != nil {
			return json.Unmarshal(m.Result, out)
		}
		return nil
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return fmt.Errorf("%s: %w", method, ctx.Err())
	}
}

// notify sends a notification.
func (c *conn) notify(ctx context.Context, method string) error {
	return c.write(ctx, map[string]any{"method": method})
}

func (c *conn) write(ctx context.Context, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.ws.Write(ctx, websocket.MessageText, b)
}

// close ends the connection (the server drops what is left of this
// client's subscriptions) and waits for the read loop.
func (c *conn) close() {
	_ = c.ws.Close(websocket.StatusNormalClosure, "")
	<-c.done
}
