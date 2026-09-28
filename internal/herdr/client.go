// Package herdr is the bridge's only door to herdr, and it is read-only by
// construction: the socket methods and CLI subcommands it may use are
// allowlisted below (readOnlyMethods, listArgs), and every call goes through
// that check. Nothing in this package creates, closes, renames, focuses,
// starts, stops or labels anything in herdr.
//
// Wire format (herdr 0.9, protocol 22): newline-delimited JSON on a per-session
// unix socket, `{"id","method","params"}` → `{"id","result"}` or
// `{"id","error":{"code","message"}}`. One request per connection, except
// `events.subscribe`, which acks and then streams events on the same
// connection until the server goes away.
package herdr

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// readOnlyMethods is the complete set of socket methods the bridge may call.
var readOnlyMethods = map[string]bool{
	"ping":             true,
	"session.snapshot": true,
	"events.subscribe": true,
}

// listArgs is the only herdr CLI invocation the bridge makes.
var listArgs = []string{"session", "list", "--json"}

// maxLine bounds one NDJSON line (a snapshot of a busy session is ~100 KB).
const maxLine = 16 << 20

// ErrNotReadOnly is returned for any method outside readOnlyMethods.
var ErrNotReadOnly = errors.New("herdr: method is not on the read-only allowlist")

// APIError is an `error` response from herdr.
type APIError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *APIError) Error() string { return "herdr: " + e.Code + ": " + e.Message }

// Client talks to herdr session sockets and runs `herdr session list`.
type Client struct {
	// Bin is the herdr executable used for `session list` (default "herdr").
	Bin string
	// DialTimeout bounds connecting to a socket (default 1 s).
	DialTimeout time.Duration
	// CallTimeout bounds one request/response when ctx has no deadline
	// (default 10 s).
	CallTimeout time.Duration
}

var reqID atomic.Uint64

func (c *Client) bin() string {
	if c.Bin == "" {
		return "herdr"
	}
	return c.Bin
}

func (c *Client) dialTimeout() time.Duration {
	if c.DialTimeout <= 0 {
		return time.Second
	}
	return c.DialTimeout
}

func (c *Client) callTimeout() time.Duration {
	if c.CallTimeout <= 0 {
		return 10 * time.Second
	}
	return c.CallTimeout
}

// ListSessions runs `herdr session list --json`.
func (c *Client) ListSessions(ctx context.Context) ([]Session, error) {
	ctx, cancel := context.WithTimeout(ctx, c.callTimeout())
	defer cancel()
	cmd := exec.CommandContext(ctx, c.bin(), listArgs...)
	cmd.Env = CleanEnv(os.Environ())
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("herdr session list: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	var res struct {
		Sessions []Session `json:"sessions"`
	}
	if err := json.Unmarshal(out, &res); err != nil {
		return nil, fmt.Errorf("herdr session list: %w", err)
	}
	return res.Sessions, nil
}

// Ping checks that a session server answers on its socket. A socket file
// alone proves nothing: stopped sessions keep theirs.
func (c *Client) Ping(ctx context.Context, socket string) (*Pong, error) {
	var p Pong
	if err := c.call(ctx, socket, "ping", struct{}{}, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

// Snapshot returns the session's full topology, including agents.
func (c *Client) Snapshot(ctx context.Context, socket string) (*Snapshot, error) {
	var res struct {
		Type     string    `json:"type"`
		Snapshot *Snapshot `json:"snapshot"`
	}
	if err := c.call(ctx, socket, "session.snapshot", struct{}{}, &res); err != nil {
		return nil, err
	}
	if res.Snapshot == nil {
		return nil, fmt.Errorf("herdr: session.snapshot: result.snapshot missing (type %q)", res.Type)
	}
	return res.Snapshot, nil
}

// Stream is a live `events.subscribe` connection.
type Stream struct {
	conn net.Conn
	r    *bufio.Reader
	stop func() bool
}

// Subscribe opens a subscription and waits for herdr's ack. The stream ends
// (Next returns an error) when ctx is cancelled, Close is called, or the
// server goes away; there is no replay, so callers re-snapshot afterwards.
func (c *Client) Subscribe(ctx context.Context, socket string, subs []Subscription) (*Stream, error) {
	params := struct {
		Subscriptions []Subscription `json:"subscriptions"`
	}{subs}
	conn, r, result, err := c.roundTrip(ctx, socket, "events.subscribe", params)
	if err != nil {
		return nil, err
	}
	var ack struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(result, &ack); err != nil || ack.Type != "subscription_started" {
		conn.Close()
		return nil, fmt.Errorf("herdr: events.subscribe: unexpected ack %s", result)
	}
	_ = conn.SetDeadline(time.Time{})
	return &Stream{conn: conn, r: r, stop: context.AfterFunc(ctx, func() { conn.Close() })}, nil
}

// Next blocks for the next event.
func (s *Stream) Next() (Event, error) {
	line, err := readLine(s.r)
	if err != nil {
		return Event{}, err
	}
	var ev Event
	if err := json.Unmarshal(line, &ev); err != nil {
		return Event{}, fmt.Errorf("herdr: bad event line: %w", err)
	}
	return ev, nil
}

// Close ends the stream.
func (s *Stream) Close() error {
	s.stop()
	return s.conn.Close()
}

func (c *Client) call(ctx context.Context, socket, method string, params, out any) error {
	conn, _, result, err := c.roundTrip(ctx, socket, method, params)
	if err != nil {
		return err
	}
	conn.Close()
	if err := json.Unmarshal(result, out); err != nil {
		return fmt.Errorf("herdr: %s: decode result: %w", method, err)
	}
	return nil
}

// roundTrip is the single choke point for socket requests: it enforces the
// read-only allowlist, sends one request line and reads one response line.
// The connection is returned open for subscriptions; callers close it.
func (c *Client) roundTrip(ctx context.Context, socket, method string, params any) (net.Conn, *bufio.Reader, json.RawMessage, error) {
	if !readOnlyMethods[method] {
		return nil, nil, nil, fmt.Errorf("%w: %s", ErrNotReadOnly, method)
	}
	id := "h3d-" + strconv.FormatUint(reqID.Add(1), 10)
	req, err := json.Marshal(struct {
		ID     string `json:"id"`
		Method string `json:"method"`
		Params any    `json:"params"`
	}{id, method, params})
	if err != nil {
		return nil, nil, nil, err
	}
	d := net.Dialer{Timeout: c.dialTimeout()}
	conn, err := d.DialContext(ctx, "unix", socket)
	if err != nil {
		return nil, nil, nil, err
	}
	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(c.callTimeout())
	}
	_ = conn.SetDeadline(deadline)
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()

	if _, err := conn.Write(append(req, '\n')); err != nil {
		conn.Close()
		return nil, nil, nil, fmt.Errorf("herdr: %s: %w", method, err)
	}
	r := bufio.NewReaderSize(conn, 64<<10)
	line, err := readLine(r)
	if err != nil {
		conn.Close()
		if ctx.Err() != nil {
			err = ctx.Err()
		}
		return nil, nil, nil, fmt.Errorf("herdr: %s: %w", method, err)
	}
	var resp struct {
		ID     string          `json:"id"`
		Result json.RawMessage `json:"result"`
		Error  *APIError       `json:"error"`
	}
	if err := json.Unmarshal(line, &resp); err != nil {
		conn.Close()
		return nil, nil, nil, fmt.Errorf("herdr: %s: bad response: %w", method, err)
	}
	if resp.Error != nil {
		conn.Close()
		return nil, nil, nil, resp.Error
	}
	if resp.ID != id || resp.Result == nil {
		conn.Close()
		return nil, nil, nil, fmt.Errorf("herdr: %s: response id %q, want %q", method, resp.ID, id)
	}
	return conn, r, resp.Result, nil
}

// readLine reads one newline-terminated line of at most maxLine bytes.
func readLine(r *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		chunk, err := r.ReadSlice('\n')
		line = append(line, chunk...)
		if len(line) > maxLine {
			return nil, errors.New("herdr: line too long")
		}
		switch {
		case err == nil:
			return bytes.TrimRight(line, "\r\n"), nil
		case errors.Is(err, bufio.ErrBufferFull):
			continue
		case errors.Is(err, io.EOF) && len(bytes.TrimSpace(line)) > 0:
			return line, nil
		default:
			return nil, err
		}
	}
}

// paneEnv are variables herdr sets inside its own panes. They retarget the
// herdr CLI at the pane's session, so they are dropped before running it.
var paneEnv = []string{
	"HERDR_ENV", "HERDR_SESSION", "HERDR_SOCKET_PATH", "HERDR_CLIENT_SOCKET_PATH",
	"HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_BIN_PATH",
}

// CleanEnv returns env without herdr pane variables and Claude Code session
// markers (which leak into anything started from an agent pane).
func CleanEnv(env []string) []string {
	out := make([]string, 0, len(env))
next:
	for _, kv := range env {
		k, _, _ := strings.Cut(kv, "=")
		if strings.HasPrefix(k, "CLAUDE") {
			continue
		}
		for _, p := range paneEnv {
			if k == p {
				continue next
			}
		}
		out = append(out, kv)
	}
	return out
}
