package codexapp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
)

// ClientName is how the bridge names itself to an app-server (clientInfo;
// the server echoes it at the start of its userAgent).
const ClientName = "herdr_3d"

// Defaults of a Watcher's Options.
const (
	DefaultMinBackoff  = 250 * time.Millisecond
	DefaultMaxBackoff  = 5 * time.Second
	DefaultMaxRetries  = 8
	DefaultCallTimeout = 10 * time.Second
)

// Errors that end a Watcher without a retry: they would not change by
// reconnecting.
var (
	ErrUnsupported = errors.New("unsupported Codex version")
	ErrEphemeral   = errors.New("the thread is ephemeral")
	ErrWrongThread = errors.New("the app-server joined another thread")
)

// Options configure a Watcher.
type Options struct {
	// Socket is the worker's app-server socket; Thread the thread to join
	// (the id Herdr's agent_session reported for the worker's pane, as the
	// bridge last saw it: never a guess among the loaded threads).
	Socket, Thread string
	// ClientVersion is the bridge's version, sent in clientInfo.
	ClientVersion string
	// OnEvent receives the watcher's events in order, on its goroutine. It
	// must not block for long.
	OnEvent func(Event)
	// Reconnecting waits MinBackoff, doubling up to MaxBackoff, and gives up
	// after MaxRetries attempts in a row that did not join.
	MinBackoff, MaxBackoff time.Duration
	MaxRetries             int
	// CallTimeout bounds each request (initialize, thread/resume,
	// thread/unsubscribe).
	CallTimeout time.Duration
}

// EventKind is what an Event reports.
type EventKind string

// Event kinds.
const (
	// EvJoined: the watcher is subscribed to the thread (Thread is set).
	EvJoined EventKind = "joined"
	// EvNotification: a notification of the joined connection.
	EvNotification EventKind = "notification"
	// EvServerRequest: the server asked its clients something (an approval,
	// a blocking question). Observed only: the watcher never answers.
	EvServerRequest EventKind = "server_request"
	// EvDisconnected: the connection ended; a reconnect follows.
	EvDisconnected EventKind = "disconnected"
	// EvFailed: the watcher gave up (Err says why); it is done.
	EvFailed EventKind = "failed"
	// EvClosed: Close ended the watcher; it is done.
	EvClosed EventKind = "closed"
)

// Event is one thing a Watcher saw.
type Event struct {
	Kind EventKind
	// Method, Params: a notification's or server request's; RequestID a
	// server request's id.
	Method    string
	Params    json.RawMessage
	RequestID json.RawMessage
	// Thread is the joined thread (EvJoined), with its history: the turns
	// thread/resume returned, and one more page of older ones when the
	// thread is paginated (HistoryPage).
	Thread *Thread
	// UserAgent is the server's (EvJoined).
	UserAgent string
	// Err is why (EvDisconnected, EvFailed).
	Err error
}

// Thread is the part of an app-server thread the bridge reads.
type Thread struct {
	ID        string `json:"id"`
	Cwd       string `json:"cwd"`
	Path      string `json:"path"`
	Ephemeral bool   `json:"ephemeral"`
	Status    struct {
		Type string `json:"type"` // notLoaded, idle, systemError, active
	} `json:"status"`
	Turns []Turn `json:"turns"`
	// Partial: the thread has older turns than Turns (#158): a batch
	// missing from them may still be in the thread.
	Partial bool `json:"-"`
}

// ActiveTurn is the thread's turn in progress ("" when none runs).
func (t *Thread) ActiveTurn() string {
	if t == nil || t.Status.Type != ThreadActive {
		return ""
	}
	for i := len(t.Turns) - 1; i >= 0; i-- {
		if t.Turns[i].Status == TurnInProgress {
			return t.Turns[i].ID
		}
	}
	return ""
}

// HistoryPage is how many older turns a join reads with thread/turns/list
// when thread/resume says there are more (a paginated thread): one page, so
// a join stays bounded. Batches older than the turns read are not
// recovered.
const HistoryPage = 50

// State is where a Watcher is.
type State string

// Watcher states.
const (
	StateConnecting State = "connecting"
	StateJoined     State = "joined"
	StateRetrying   State = "retrying"
	StateFailed     State = "failed"
	StateClosed     State = "closed"
)

// Watcher keeps one thread of a worker's app-server joined as a passive
// second client (D3, D4): it initializes, rejoins the thread with
// thread/resume {threadId} and nothing else (the thread's model, cwd, MCP
// configuration, instructions, sandbox and approval policy stay as they
// are, and no turn starts), forwards what it receives, reconnects with a
// bounded backoff, and on Close leaves with thread/unsubscribe. It never
// starts a turn, changes a setting or answers a server request.
type Watcher struct {
	o      Options
	cancel context.CancelFunc
	done   chan struct{}

	mu     sync.Mutex
	state  State
	cur    *conn
	joined bool // cur has joined the thread
}

// Watch validates o and starts watching in the background.
func Watch(o Options) (*Watcher, error) {
	if o.Socket == "" || o.Thread == "" {
		return nil, errors.New("codexapp: watch needs a socket and a thread")
	}
	if o.MinBackoff <= 0 {
		o.MinBackoff = DefaultMinBackoff
	}
	if o.MaxBackoff < o.MinBackoff {
		o.MaxBackoff = max(DefaultMaxBackoff, o.MinBackoff)
	}
	if o.MaxRetries <= 0 {
		o.MaxRetries = DefaultMaxRetries
	}
	if o.CallTimeout <= 0 {
		o.CallTimeout = DefaultCallTimeout
	}
	if o.ClientVersion == "" {
		o.ClientVersion = "dev"
	}
	if o.OnEvent == nil {
		o.OnEvent = func(Event) {}
	}
	ctx, cancel := context.WithCancel(context.Background())
	w := &Watcher{o: o, cancel: cancel, done: make(chan struct{}), state: StateConnecting}
	go w.run(ctx)
	return w, nil
}

// State reports where the watcher is.
func (w *Watcher) State() State {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.state
}

func (w *Watcher) setState(s State) {
	w.mu.Lock()
	w.state = s
	w.mu.Unlock()
}

// Close leaves the thread (thread/unsubscribe, bounded by CallTimeout),
// closes the connection and waits until the watcher is done. It releases
// this client's subscription only: the terminal's stays.
func (w *Watcher) Close() {
	w.cancel()
	<-w.done
}

// Done is closed once the watcher has ended (failed or closed).
func (w *Watcher) Done() <-chan struct{} { return w.done }

func (w *Watcher) run(ctx context.Context) {
	defer close(w.done)
	backoff := w.o.MinBackoff
	for failures := 0; ; {
		err := w.session(ctx)
		if ctx.Err() != nil {
			w.setState(StateClosed)
			w.o.OnEvent(Event{Kind: EvClosed})
			return
		}
		if errors.Is(err, errJoinedThenLost) {
			failures, backoff = 0, w.o.MinBackoff
		}
		if errors.Is(err, ErrUnsupported) || errors.Is(err, ErrEphemeral) || errors.Is(err, ErrWrongThread) {
			w.fail(err)
			return
		}
		if failures++; failures > w.o.MaxRetries {
			w.fail(fmt.Errorf("gave up after %d attempts: %w", w.o.MaxRetries, err))
			return
		}
		w.setState(StateRetrying)
		w.o.OnEvent(Event{Kind: EvDisconnected, Err: err})
		select {
		case <-ctx.Done():
			w.setState(StateClosed)
			w.o.OnEvent(Event{Kind: EvClosed})
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, w.o.MaxBackoff)
	}
}

func (w *Watcher) fail(err error) {
	w.setState(StateFailed)
	w.o.OnEvent(Event{Kind: EvFailed, Err: err})
}

// errJoinedThenLost wraps the end of a connection that had joined: the
// retry count starts again.
var errJoinedThenLost = errors.New("connection lost")

// session is one connection: join, forward until it ends or ctx does, and
// then leave.
func (w *Watcher) session(ctx context.Context) error {
	w.setState(StateConnecting)
	events := make(chan Event, 256)
	overflow := make(chan struct{})
	var once sync.Once
	incoming := func(m Message) {
		ev := Event{Kind: EvNotification, Method: m.Method, Params: m.Params}
		if len(m.ID) > 0 {
			ev.Kind, ev.RequestID = EvServerRequest, m.ID
		}
		select {
		case events <- ev:
		default:
			once.Do(func() { close(overflow) })
		}
	}
	dctx, cancel := context.WithTimeout(ctx, w.o.CallTimeout)
	c, err := dial(dctx, w.o.Socket, incoming)
	cancel()
	if err != nil {
		return err
	}
	w.mu.Lock()
	w.cur = c
	w.mu.Unlock()
	defer func() {
		w.mu.Lock()
		w.cur, w.joined = nil, false
		w.mu.Unlock()
		c.close()
	}()

	th, ua, err := w.join(ctx, c)
	if err != nil {
		return err
	}
	w.mu.Lock()
	w.joined = true
	w.mu.Unlock()
	w.setState(StateJoined)
	w.o.OnEvent(Event{Kind: EvJoined, Thread: th, UserAgent: ua})
	for {
		select {
		case ev := <-events:
			w.o.OnEvent(ev)
		case <-overflow:
			return fmt.Errorf("%w: events overflowed", errJoinedThenLost)
		case <-c.done:
			// Drain what arrived before the end.
			for {
				select {
				case ev := <-events:
					w.o.OnEvent(ev)
				default:
					c.mu.Lock()
					cerr := c.err
					c.mu.Unlock()
					return fmt.Errorf("%w: %v", errJoinedThenLost, cerr)
				}
			}
		case <-ctx.Done():
			w.leave(c)
			return ctx.Err()
		}
	}
}

// join initializes the connection and subscribes it to the thread.
func (w *Watcher) join(ctx context.Context, c *conn) (*Thread, string, error) {
	cctx, cancel := context.WithTimeout(ctx, w.o.CallTimeout)
	defer cancel()
	var init struct {
		UserAgent string `json:"userAgent"`
	}
	if err := c.call(cctx, "initialize", map[string]any{
		"clientInfo":   map[string]any{"name": ClientName, "title": "herdr-3d", "version": w.o.ClientVersion},
		"capabilities": map[string]any{"experimentalApi": true},
	}, &init); err != nil {
		return nil, "", err
	}
	if err := CheckUserAgent(init.UserAgent); err != nil {
		return nil, init.UserAgent, err
	}
	if err := c.notify(cctx, "initialized"); err != nil {
		return nil, init.UserAgent, err
	}
	// The thread id and nothing else: no model, cwd, sandbox, approval or
	// instruction override, so joining changes nothing (D3).
	var res struct {
		Thread *Thread         `json:"thread"`
		Older  json.RawMessage `json:"turnsBackwardsCursor"`
	}
	if err := c.call(cctx, "thread/resume", map[string]any{"threadId": w.o.Thread}, &res); err != nil {
		return nil, init.UserAgent, err
	}
	switch {
	case res.Thread == nil || res.Thread.ID != w.o.Thread:
		got := ""
		if res.Thread != nil {
			got = res.Thread.ID
		}
		return nil, init.UserAgent, fmt.Errorf("%w: asked for %s, got %q", ErrWrongThread, w.o.Thread, got)
	case res.Thread.Ephemeral:
		return nil, init.UserAgent, fmt.Errorf("%w: %s", ErrEphemeral, w.o.Thread)
	}
	if cur := string(res.Older); cur != "" && cur != "null" {
		res.Thread.Partial = !w.olderTurns(cctx, c, res.Thread, res.Older)
	}
	w.legacyTurns(cctx, c, res.Thread)
	return res.Thread, init.UserAgent, nil
}

// legacyTurns reads again, with thread/turns/list, the turns thread/resume
// gave with its legacy history builder's item ids (item-1, item-2, …) and
// puts them in place (#158). Codex 0.160.1 does so for the thread's newest
// turn, running or interrupted, to a client that was not subscribed: an
// async question there is not under its call_id, which the live events,
// thread/read and thread/turns/list give it
// (TestCodexShareBridgeRestartSent/*-raw-history-*). A failure leaves the
// turns as they are.
func (w *Watcher) legacyTurns(ctx context.Context, c *conn, th *Thread) {
	first := -1
	for i, t := range th.Turns {
		if first < 0 && slices.ContainsFunc(t.Items, func(it Item) bool { return legacyItemID.MatchString(it.ID) }) {
			first = i
		}
	}
	if first < 0 {
		return
	}
	var page struct {
		Data []Turn `json:"data"`
	}
	if err := c.call(ctx, "thread/turns/list", map[string]any{"threadId": w.o.Thread, "sortDirection": "desc",
		"itemsView": "full", "limit": min(len(th.Turns)-first, HistoryPage)}, &page); err != nil {
		return
	}
	for _, t := range page.Data {
		for i := first; i < len(th.Turns); i++ {
			if th.Turns[i].ID == t.ID {
				th.Turns[i] = t
			}
		}
	}
}

// legacyItemID is an item id of Codex's legacy history builder.
var legacyItemID = regexp.MustCompile(`^item-\d+$`)

// olderTurns reads one page of turns before those thread/resume returned
// (thread/turns/list, newest first, from its cursor) and puts the ones it
// did not have in front of th.Turns. A failure leaves the history as it is.
// It reports whether the history is whole now: the page read, and no
// cursor to older turns after it (nextCursor, as Codex 0.160.1 gives it:
// TestCodexShareBridgeRestartSent/*-thread-turns-list).
func (w *Watcher) olderTurns(ctx context.Context, c *conn, th *Thread, cursor json.RawMessage) bool {
	var page struct {
		Data []Turn          `json:"data"`
		Next json.RawMessage `json:"nextCursor"`
	}
	if err := c.call(ctx, "thread/turns/list", map[string]any{"threadId": w.o.Thread, "cursor": cursor,
		"sortDirection": "desc", "itemsView": "full", "limit": HistoryPage}, &page); err != nil {
		return false
	}
	have := map[string]bool{}
	for _, t := range th.Turns {
		have[t.ID] = true
	}
	var older []Turn
	for i := len(page.Data) - 1; i >= 0; i-- { // oldest first
		if t := page.Data[i]; !have[t.ID] {
			older = append(older, t)
		}
	}
	th.Turns = append(older, th.Turns...)
	next := string(page.Next)
	return next == "" || next == "null"
}

// Errors of the watcher's sends.
var (
	// ErrNotAttached: the watcher has not joined the thread now (it is
	// connecting, retrying, failed or closed); nothing was sent.
	ErrNotAttached = errors.New("not attached to the thread")
)

// Refused reports whether a send's error is the server refusing the
// request (a JSON-RPC error response): nothing was delivered. A send that
// failed otherwise was either not sent (ErrNotAttached) or has an unknown
// outcome (ErrNoResponse).
func Refused(err error) bool {
	var e *RPCError
	return errors.As(err, &e)
}

// Steer adds user input to the thread's running turn expectedTurn
// (turn/steer): the server refuses it when that is not the turn running.
// The input is delivered with the turn's next model request. clientID is
// the input's clientUserMessageId (NewClientID). This and StartTurn are the
// only things the watcher sends besides joining and leaving, each on an
// explicit request: it never answers a server request (D4).
func (w *Watcher) Steer(ctx context.Context, expectedTurn, text, clientID string) (string, error) {
	var res struct {
		TurnID string `json:"turnId"`
	}
	err := w.send(ctx, "turn/steer", map[string]any{"threadId": w.o.Thread, "expectedTurnId": expectedTurn,
		"clientUserMessageId": clientID, "input": textInput(text)}, &res)
	return res.TurnID, err
}

// StartTurn starts a turn on the thread with user input (turn/start, no
// override: the thread's settings stay) and returns its id.
func (w *Watcher) StartTurn(ctx context.Context, text, clientID string) (string, error) {
	var res struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	err := w.send(ctx, "turn/start", map[string]any{"threadId": w.o.Thread, "clientUserMessageId": clientID,
		"input": textInput(text)}, &res)
	return res.Turn.ID, err
}

func textInput(text string) []any {
	return []any{map[string]any{"type": "text", "text": text, "text_elements": []any{}}}
}

// send makes one request on the joined connection, bounded by CallTimeout.
func (w *Watcher) send(ctx context.Context, method string, params, out any) error {
	w.mu.Lock()
	c, joined := w.cur, w.joined
	w.mu.Unlock()
	if c == nil || !joined {
		return fmt.Errorf("%s: %w", method, ErrNotAttached)
	}
	cctx, cancel := context.WithTimeout(ctx, w.o.CallTimeout)
	defer cancel()
	err := c.call(cctx, method, params, out)
	if errors.Is(err, errClosed) && !errors.Is(err, ErrNoResponse) {
		return fmt.Errorf("%s: %w", method, ErrNotAttached) // closed before it was written
	}
	return err
}

// leave unsubscribes this client from the thread, bounded by CallTimeout.
func (w *Watcher) leave(c *conn) {
	ctx, cancel := context.WithTimeout(context.Background(), w.o.CallTimeout)
	defer cancel()
	_ = c.call(ctx, "thread/unsubscribe", map[string]any{"threadId": w.o.Thread}, nil)
}

// SupportedMinor is the Codex release line the shared launch was verified
// against (codex-cli 0.160.1, docs/research/codex-shared-tui.md).
const SupportedMinor = "0.160"

// CheckVersion checks `codex --version` output ("codex-cli 0.160.1").
func CheckVersion(out string) error {
	f := strings.Fields(strings.TrimSpace(out))
	if len(f) != 2 || f[0] != "codex-cli" || !supported(f[1]) {
		return fmt.Errorf("%w: %q (supported: codex-cli %s.x)", ErrUnsupported, strings.TrimSpace(out), SupportedMinor)
	}
	return nil
}

// CheckUserAgent checks the version in an app-server's userAgent
// ("<client>/0.160.1 (…) …", the client name first).
func CheckUserAgent(ua string) error {
	first, _, _ := strings.Cut(ua, " ")
	_, v, ok := strings.Cut(first, "/")
	if !ok || !supported(v) {
		return fmt.Errorf("%w: app-server %q (supported: %s.x)", ErrUnsupported, ua, SupportedMinor)
	}
	return nil
}

func supported(v string) bool {
	rest, ok := strings.CutPrefix(v, SupportedMinor+".")
	if !ok || rest == "" {
		return false
	}
	for _, r := range rest {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
