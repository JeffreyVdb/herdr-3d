package codexshare

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"sync"

	"github.com/coder/websocket"

	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
)

// Message is one JSON-RPC message of the Codex app-server protocol (which
// omits the "jsonrpc" member).
type Message struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *RPCError       `json:"error,omitempty"`
}

// Param returns a top-level string parameter, "" when absent.
func (m Message) Param(key string) string {
	var p map[string]any
	_ = json.Unmarshal(m.Params, &p)
	s, _ := p[key].(string)
	return s
}

// RPCError is a JSON-RPC error response.
type RPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *RPCError) Error() string { return fmt.Sprintf("app-server error %d: %s", e.Code, e.Message) }

// Client is a second app-server client: a WebSocket over the server's unix
// socket, as the remote TUI connects (ws://localhost/rpc, rust-v0.160.1
// app-server-client/src/remote.rs). Every notification and server request
// is kept, so a wait can match one that arrived earlier. Unlike the
// bridge's passive codexapp.Watcher, it can answer server requests (the
// fixture's "bridge answers first" checks).
type Client struct {
	conn *websocket.Conn
	ctx  context.Context
	stop context.CancelFunc

	mu      sync.Mutex
	nextID  int
	pending map[string]chan Message
	log     []Message // notifications and server requests, in order
	changed chan struct{}
	err     error // set once the read loop ends
}

// Dial connects to the app-server listening on the unix socket path, the
// way the bridge's adapter does (codexapp.DialWS).
func Dial(ctx context.Context, sock string) (*Client, error) {
	conn, err := codexapp.DialWS(ctx, sock)
	if err != nil {
		return nil, err
	}
	cctx, stop := context.WithCancel(context.Background())
	c := &Client{conn: conn, ctx: cctx, stop: stop, pending: map[string]chan Message{}, changed: make(chan struct{})}
	go c.readLoop()
	return c, nil
}

// Close ends the connection; the server drops this client's subscriptions.
func (c *Client) Close() {
	c.stop()
	_ = c.conn.Close(websocket.StatusNormalClosure, "")
}

func (c *Client) readLoop() {
	for {
		_, b, err := c.conn.Read(c.ctx)
		if err != nil {
			c.mu.Lock()
			c.err = err
			for id, ch := range c.pending {
				close(ch)
				delete(c.pending, id)
			}
			close(c.changed)
			c.changed = make(chan struct{})
			c.mu.Unlock()
			return
		}
		var m Message
		if json.Unmarshal(b, &m) != nil {
			continue
		}
		c.mu.Lock()
		if m.Method == "" && len(m.ID) > 0 {
			if ch, ok := c.pending[string(m.ID)]; ok {
				ch <- m
				delete(c.pending, string(m.ID))
			}
		} else {
			c.log = append(c.log, m)
			close(c.changed)
			c.changed = make(chan struct{})
		}
		c.mu.Unlock()
	}
}

func (c *Client) write(ctx context.Context, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.conn.Write(ctx, websocket.MessageText, b)
}

// Call sends a request and decodes its result into out (when non-nil).
func (c *Client) Call(ctx context.Context, method string, params, out any) error {
	c.mu.Lock()
	if c.err != nil {
		c.mu.Unlock()
		return fmt.Errorf("%s: connection closed: %w", method, c.err)
	}
	c.nextID++
	n := c.nextID
	id := strconv.Itoa(n)
	ch := make(chan Message, 1)
	c.pending[id] = ch
	c.mu.Unlock()
	if err := c.write(ctx, map[string]any{"id": n, "method": method, "params": params}); err != nil {
		return fmt.Errorf("%s: %w", method, err)
	}
	select {
	case m, ok := <-ch:
		if !ok {
			return fmt.Errorf("%s: connection closed", method)
		}
		if m.Error != nil {
			return fmt.Errorf("%s: %w", method, m.Error)
		}
		if out != nil {
			return json.Unmarshal(m.Result, out)
		}
		return nil
	case <-ctx.Done():
		return fmt.Errorf("%s: %w", method, ctx.Err())
	}
}

// Notify sends a notification.
func (c *Client) Notify(ctx context.Context, method string, params any) error {
	m := map[string]any{"method": method}
	if params != nil {
		m["params"] = params
	}
	return c.write(ctx, m)
}

// Respond answers a server request.
func (c *Client) Respond(ctx context.Context, id json.RawMessage, result any) error {
	return c.write(ctx, map[string]any{"id": id, "result": result})
}

// Initialize performs the handshake as a named client with the experimental
// API enabled (the TUI enables it too), then sends "initialized".
func (c *Client) Initialize(ctx context.Context, name string) (map[string]any, error) {
	var res map[string]any
	err := c.Call(ctx, "initialize", map[string]any{
		"clientInfo":   map[string]any{"name": name, "title": nil, "version": "0.0.0"},
		"capabilities": map[string]any{"experimentalApi": true},
	}, &res)
	if err != nil {
		return nil, err
	}
	return res, c.Notify(ctx, "initialized", nil)
}

// Notifications returns every notification of method received so far ("" for all).
func (c *Client) Notifications(method string) []Message {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []Message
	for _, m := range c.log {
		if len(m.ID) == 0 && (method == "" || m.Method == method) {
			out = append(out, m)
		}
	}
	return out
}

// ServerRequests returns every server request of method received so far ("" for all).
func (c *Client) ServerRequests(method string) []Message {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []Message
	for _, m := range c.log {
		if len(m.ID) > 0 && (method == "" || m.Method == method) {
			out = append(out, m)
		}
	}
	return out
}

// Mark is the position in the message log now; WaitNotificationFrom with
// it ignores everything received before.
func (c *Client) Mark() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.log)
}

// wait returns the first logged message from index from that matches.
func (c *Client) wait(ctx context.Context, from int, what string, match func(Message) bool) (Message, error) {
	for {
		c.mu.Lock()
		for _, m := range c.log[min(from, len(c.log)):] {
			if match(m) {
				c.mu.Unlock()
				return m, nil
			}
		}
		ch, err := c.changed, c.err
		c.mu.Unlock()
		if err != nil {
			return Message{}, fmt.Errorf("waiting for %s: connection closed: %w", what, err)
		}
		select {
		case <-ch:
		case <-ctx.Done():
			return Message{}, fmt.Errorf("waiting for %s: %w", what, ctx.Err())
		}
	}
}

// WaitNotification waits for a notification of method matching ok (nil: any),
// including ones already received.
func (c *Client) WaitNotification(ctx context.Context, method string, ok func(Message) bool) (Message, error) {
	return c.WaitNotificationFrom(ctx, 0, method, ok)
}

// WaitNotificationFrom is WaitNotification over the messages from mark on.
func (c *Client) WaitNotificationFrom(ctx context.Context, mark int, method string, ok func(Message) bool) (Message, error) {
	return c.wait(ctx, mark, method, func(m Message) bool {
		return len(m.ID) == 0 && m.Method == method && (ok == nil || ok(m))
	})
}

// WaitServerRequest waits for a server request of method, including ones
// already received.
func (c *Client) WaitServerRequest(ctx context.Context, method string) (Message, error) {
	return c.wait(ctx, 0, method, func(m Message) bool { return len(m.ID) > 0 && m.Method == method })
}

// Err is why the connection ended, nil while it is open.
func (c *Client) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.err != nil && errors.Is(c.err, context.Canceled) {
		return nil
	}
	return c.err
}
