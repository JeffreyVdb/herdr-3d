package proto

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"

	"github.com/coder/websocket"
)

// MaxMessage bounds one message; a world snapshot of a busy host is well
// under this.
const MaxMessage = 64 << 20

// Conn is a protocol client over a unix-socket WebSocket.
type Conn struct {
	ws *websocket.Conn
}

// Dial connects to the bridge socket at path.
func Dial(ctx context.Context, path string) (*Conn, error) {
	client := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", path)
		},
	}}
	ws, _, err := websocket.Dial(ctx, "ws://herdr-world/ws", &websocket.DialOptions{HTTPClient: client})
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", path, err)
	}
	ws.SetReadLimit(MaxMessage)
	return &Conn{ws: ws}, nil
}

// Send writes one message.
func (c *Conn) Send(ctx context.Context, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.ws.Write(ctx, websocket.MessageText, b)
}

// Read returns the next message and its envelope.
func (c *Conn) Read(ctx context.Context) (Envelope, []byte, error) {
	_, b, err := c.ws.Read(ctx)
	if err != nil {
		return Envelope{}, nil, err
	}
	var env Envelope
	if err := json.Unmarshal(b, &env); err != nil {
		return Envelope{}, nil, fmt.Errorf("bad message: %w", err)
	}
	return env, b, nil
}

// Hello sends hello and returns the welcome.
func (c *Conn) Hello(ctx context.Context, h Hello) (Welcome, error) {
	h.T = THello
	if h.Proto == 0 {
		h.Proto = Version
	}
	if err := c.Send(ctx, h); err != nil {
		return Welcome{}, err
	}
	env, b, err := c.Read(ctx)
	if err != nil {
		return Welcome{}, err
	}
	if env.T == TError {
		var e Error
		_ = json.Unmarshal(b, &e)
		return Welcome{}, fmt.Errorf("hello rejected: %s: %s", e.Code, e.Message)
	}
	var w Welcome
	if env.T != TWelcome || json.Unmarshal(b, &w) != nil {
		return Welcome{}, fmt.Errorf("expected welcome, got %s", b)
	}
	return w, nil
}

// Close closes the connection normally.
func (c *Conn) Close() error { return c.ws.Close(websocket.StatusNormalClosure, "") }

// CloseNow closes the connection without a close handshake.
func (c *Conn) CloseNow() error { return c.ws.CloseNow() }
