package telegram

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/notify"
)

const token = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"

var t0 = time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)

type req struct {
	method string
	body   map[string]any
}

// fakeTG is the Bot API in a test: getMe, sendMessage and getUpdates (a
// queue, offsets confirmed as Telegram does).
type fakeTG struct {
	srv *httptest.Server

	mu      sync.Mutex
	reqs    []req
	queue   []update
	nextID  int64
	pushed  chan struct{}
	reqC    chan struct{}
	failGet func(n int) (int, string) // getUpdates' n-th call (from 0): a status and a body, or 0
	failMsg func(n int) (int, string) // sendMessage's
	holdGet func(n int)               // runs before getUpdates' n-th call reads the queue
	gets    int
	msgs    int
	// #13: the getUpdates under way now, and the most there ever were.
	polling, maxPolling int
	// now dates the updates pushed (nil: 0).
	now func() time.Time
}

func newFakeTG(t *testing.T) *fakeTG {
	f := &fakeTG{nextID: 100, pushed: make(chan struct{}, 1), reqC: make(chan struct{}, 256)}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeTG) serve(w http.ResponseWriter, r *http.Request) {
	tok, method, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/bot"), "/")
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	f.mu.Lock()
	f.reqs = append(f.reqs, req{method, body})
	f.mu.Unlock()
	select {
	case f.reqC <- struct{}{}:
	default:
	}
	w.Header().Set("Content-Type", "application/json")
	if tok != token {
		w.WriteHeader(401)
		fmt.Fprint(w, `{"ok":false,"error_code":401,"description":"Unauthorized"}`)
		return
	}
	switch method {
	case "getMe":
		fmt.Fprint(w, `{"ok":true,"result":{"id":123456789,"is_bot":true,"first_name":"Herdr","username":"herdr3d_bot"}}`)
	case "sendMessage":
		f.mu.Lock()
		n := f.msgs
		f.msgs++
		fail := f.failMsg
		f.mu.Unlock()
		if fail != nil {
			if st, b := fail(n); st != 0 {
				w.WriteHeader(st)
				fmt.Fprint(w, b)
				return
			}
		}
		// Each message its own id (from 1), in the chat it went to.
		chatID, _ := body["chat_id"].(float64)
		fmt.Fprintf(w, `{"ok":true,"result":{"message_id":%d,"date":1,"chat":{"id":%d,"type":"private"}}}`, n+1, int64(chatID))
	case "setMessageReaction":
		fmt.Fprint(w, `{"ok":true,"result":true}`)
	case "getUpdates":
		f.mu.Lock()
		n := f.gets
		f.gets++
		fail := f.failGet
		f.polling++
		f.maxPolling = max(f.maxPolling, f.polling)
		f.mu.Unlock()
		defer func() {
			f.mu.Lock()
			f.polling--
			f.mu.Unlock()
		}()
		if fail != nil {
			if st, b := fail(n); st != 0 {
				w.WriteHeader(st)
				fmt.Fprint(w, b)
				return
			}
		}
		f.mu.Lock()
		hold := f.holdGet
		f.mu.Unlock()
		if hold != nil {
			hold(n)
		}
		offset, _ := body["offset"].(float64) // omitted: 0
		timeout, _ := body["timeout"].(float64)
		deadline := time.After(50 * time.Millisecond)
		for {
			f.mu.Lock()
			if offset == -1 {
				if len(f.queue) > 0 {
					f.queue = f.queue[len(f.queue)-1:]
				}
			} else {
				keep := f.queue[:0]
				for _, u := range f.queue {
					if u.UpdateID >= int64(offset) {
						keep = append(keep, u)
					}
				}
				f.queue = keep
			}
			out := append([]update(nil), f.queue...)
			f.mu.Unlock()
			if len(out) > 0 || timeout == 0 {
				b, _ := json.Marshal(struct {
					OK     bool     `json:"ok"`
					Result []update `json:"result"`
				}{true, out})
				w.Write(b)
				return
			}
			select {
			case <-f.pushed:
			case <-deadline:
				fmt.Fprint(w, `{"ok":true,"result":[]}`)
				return
			case <-r.Context().Done():
				return
			}
		}
	default:
		w.WriteHeader(404)
		fmt.Fprint(w, `{"ok":false,"error_code":404,"description":"Not Found"}`)
	}
}

func (f *fakeTG) push(from int64, chatType, text string, isBot bool) {
	f.pushMsg(&message{From: &user{ID: from, IsBot: isBot, FirstName: fmt.Sprintf("User%d", from)}, Chat: chat{ID: from, Type: chatType}, Text: text})
}

// pushMsg queues m as the next update (its id the update's; dated now).
func (f *fakeTG) pushMsg(m *message) int64 {
	f.mu.Lock()
	f.nextID++
	m.MessageID = f.nextID
	if f.now != nil && m.Date == 0 {
		m.Date = f.now().Unix()
	}
	f.queue = append(f.queue, update{UpdateID: f.nextID, Message: m})
	id := f.nextID
	f.mu.Unlock()
	select {
	case f.pushed <- struct{}{}:
	default:
	}
	return id
}

func (f *fakeTG) requests(method string) []req {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []req
	for _, r := range f.reqs {
		if method == "" || r.method == method {
			out = append(out, r)
		}
	}
	return out
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

type rig struct {
	ch    *Channel
	tg    *fakeTG
	clock *notify.FakeClock
	file  string
	log   *bytes.Buffer

	mu      sync.Mutex
	results []notify.PairResult
	// #13: the replies handed over; Listen at the start.
	replies       []notify.Reply
	listenAtStart bool
	// noRun: the test runs the channel itself (newRigBefore does not).
	noRun bool
}

func (r *rig) hookReply(rp notify.Reply) {
	r.mu.Lock()
	r.replies = append(r.replies, rp)
	r.mu.Unlock()
}

func (r *rig) gotReplies() []notify.Reply {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]notify.Reply(nil), r.replies...)
}

func (r *rig) pairResults() []notify.PairResult {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]notify.PairResult(nil), r.results...)
}

func newRig(t *testing.T, opts Options) *rig { return newRigBefore(t, opts, nil) }

// newRigBefore is newRig with before run on it before the channel's Run.
func newRigBefore(t *testing.T, opts Options, before func(*rig)) *rig {
	t.Helper()
	r := &rig{tg: newFakeTG(t), clock: notify.NewFakeClock(t0), log: &bytes.Buffer{}}
	if opts.File == "" {
		r.file = filepath.Join(t.TempDir(), "telegram.json")
		opts.File = r.file
	}
	opts.BaseURL, opts.Clock = r.tg.srv.URL, r.clock
	opts.PollTimeout = time.Second
	opts.Log = slog.New(slog.NewTextHandler(r.log, &slog.HandlerOptions{Level: slog.LevelDebug}))
	ch, err := New(opts)
	if err != nil {
		t.Fatal(err)
	}
	r.ch = ch
	if before != nil {
		before(r)
	}
	if r.noRun {
		return r
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		ch.Run(ctx, notify.Hooks{Pair: func(res notify.PairResult) {
			r.mu.Lock()
			r.results = append(r.results, res)
			r.mu.Unlock()
		}, Reply: r.hookReply, Listen: r.listenAtStart})
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	return r
}

func (r *rig) startPairing(t *testing.T) string {
	t.Helper()
	if err := r.ch.SetToken(context.Background(), token); err != nil {
		t.Fatal(err)
	}
	if err := r.ch.StartPairing(context.Background()); err != nil {
		t.Fatal(err)
	}
	p := r.ch.State().Pairing
	if p == nil || p.State != notify.PairWaiting || len(p.Code) != 9 || p.Code[4] != '-' {
		t.Fatalf("pairing %+v", p)
	}
	// The first poll (the newest update only, forgetting the rest) has gone out.
	waitFor(t, "the first poll", func() bool { return len(r.tg.requests("getUpdates")) >= 1 })
	return p.Code
}

func TestPairingStoresTheSendersUserID(t *testing.T) {
	r := newRig(t, Options{})
	code := r.startPairing(t)
	if st := r.ch.State(); st.Bot != "herdr3d_bot" || !st.KeySet || st.KeyHint != "saw"[0:0]+"Dsaw"[0:4] {
		t.Fatalf("state %+v", st)
	}
	// Another sender, the wrong text, a group, a bot: dropped without a word.
	r.tg.push(7, "private", "hello", false)
	r.tg.push(8, "private", code+"X", false)
	r.tg.push(9, "group", code, false)
	r.tg.push(10, "private", code, true)
	// The code, typed on a phone: lower case, no dash, spaces around.
	r.tg.push(42, "private", "  "+strings.ToLower(strings.ReplaceAll(code, "-", ""))+" ", false)
	waitFor(t, "the pairing", func() bool { return r.ch.Ready() })
	st := r.ch.State()
	if st.Paired == nil || st.Paired.Name != "User42" || st.Pairing != nil {
		t.Fatalf("state %+v", st)
	}
	waitFor(t, "the pair result", func() bool { return len(r.pairResults()) == 1 })
	if res := r.pairResults()[0]; res.Outcome != notify.PairedOK || res.Ignored != 4 {
		t.Fatalf("result %+v", res)
	}
	// Only the person who paired was written to: the greeting.
	msgs := r.tg.requests("sendMessage")
	if len(msgs) != 1 || msgs[0].body["chat_id"].(float64) != 42 || msgs[0].body["text"] != PairedText {
		t.Fatalf("messages %+v", msgs)
	}
	// Stored: from.id, 0600.
	var s Stored
	b, err := os.ReadFile(r.file)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &s); err != nil || s.UserID != 42 || s.Token != token || s.BotID != "123456789" {
		t.Fatalf("stored %+v %v", s, err)
	}
	if fi, _ := os.Stat(r.file); fi.Mode().Perm() != 0o600 {
		t.Fatalf("file mode %v", fi.Mode().Perm())
	}
	// Polling stops once paired.
	n := len(r.tg.requests("getUpdates"))
	time.Sleep(150 * time.Millisecond)
	if m := len(r.tg.requests("getUpdates")); m != n {
		t.Fatalf("still polling after pairing: %d → %d", n, m)
	}
	// Sends go to that user, plain text, no previews.
	if _, err := r.ch.Send(context.Background(), notify.Notification{Name: "Pixel", Reason: notify.ReasonFinished, Line: "Opened PR #12", Quiet: true}); err != nil {
		t.Fatal(err)
	}
	msgs = r.tg.requests("sendMessage")
	m := msgs[len(msgs)-1].body
	if m["chat_id"].(float64) != 42 || m["text"] != "Pixel · Finished\nOpened PR #12" || m["disable_notification"] != true {
		t.Fatalf("message %+v", m)
	}
	if _, ok := m["parse_mode"]; ok {
		t.Fatal("parse_mode sent")
	}
	if lp, _ := m["link_preview_options"].(map[string]any); lp["is_disabled"] != true {
		t.Fatalf("link previews not disabled: %+v", m)
	}
}

func TestPairingIgnoresWhatCameBefore(t *testing.T) {
	r := newRig(t, Options{})
	if err := r.ch.SetToken(context.Background(), token); err != nil {
		t.Fatal(err)
	}
	r.tg.push(7, "private", "old 1", false)
	r.tg.push(7, "private", "old 2", false)
	if err := r.ch.StartPairing(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "two polls", func() bool { return len(r.tg.requests("getUpdates")) >= 2 })
	first := r.tg.requests("getUpdates")[0].body
	if first["offset"].(float64) != -1 {
		t.Fatalf("the first poll does not skip the backlog: %+v", first)
	}
	if second := r.tg.requests("getUpdates")[1].body; second["offset"].(float64) != 103 {
		t.Fatalf("the newest update not confirmed: %+v", second)
	}
}

func TestPairingCodeExpires(t *testing.T) {
	r := newRig(t, Options{PairTTL: 10 * time.Minute})
	r.startPairing(t)
	r.tg.push(42, "private", "WRONG-CODE", false)
	waitFor(t, "the wrong code read", func() bool { return len(r.tg.requests("getUpdates")) >= 3 })
	if r.ch.Ready() {
		t.Fatal("a wrong code paired")
	}
	r.clock.Advance(10*time.Minute + time.Second)
	waitFor(t, "the expiry", func() bool { return len(r.pairResults()) == 1 })
	if res := r.pairResults()[0]; res.Outcome != notify.PairTimedOut || res.Ignored < 1 {
		t.Fatalf("result %+v", res)
	}
	if p := r.ch.State().Pairing; p == nil || p.State != notify.PairExpired || p.Code != "" {
		t.Fatalf("pairing %+v", p)
	}
	if len(r.tg.requests("sendMessage")) != 0 {
		t.Fatal("a message went out")
	}
}

// A code that arrives in a long poll answered after the deadline is too
// late: nothing is stored, nobody is greeted.
func TestPairingCodeExpiresInFlight(t *testing.T) {
	r := newRig(t, Options{PairTTL: 10 * time.Minute})
	inFlight, release := make(chan struct{}), make(chan struct{})
	r.tg.mu.Lock()
	r.tg.holdGet = func(n int) {
		if n == 1 { // the first long poll
			close(inFlight)
			<-release
		}
	}
	r.tg.mu.Unlock()
	code := r.startPairing(t)
	<-inFlight
	r.clock.Advance(10*time.Minute + time.Second)
	r.tg.push(42, "private", code, false)
	close(release)
	waitFor(t, "the expiry", func() bool { return len(r.pairResults()) == 1 })
	if res := r.pairResults()[0]; res.Outcome != notify.PairTimedOut {
		t.Fatalf("result %+v", res)
	}
	st := r.ch.State()
	if r.ch.Ready() || st.Paired != nil {
		t.Fatalf("paired after expiry: %+v", st)
	}
	if st.Pairing == nil || st.Pairing.State != notify.PairExpired {
		t.Fatalf("pairing %+v", st.Pairing)
	}
	if len(r.tg.requests("sendMessage")) != 0 {
		t.Fatal("a greeting went out")
	}
	if _, err := os.Stat(r.file); err == nil {
		var s Stored
		b, _ := os.ReadFile(r.file)
		if json.Unmarshal(b, &s) == nil && s.UserID != 0 {
			t.Fatalf("stored %+v", s)
		}
	}
}

func TestPairingCancelStopsPolling(t *testing.T) {
	r := newRig(t, Options{})
	r.startPairing(t)
	if err := r.ch.CancelPairing(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the cancel", func() bool { return len(r.pairResults()) == 1 })
	if r.pairResults()[0].Outcome != notify.PairCancelled || r.ch.State().Pairing != nil {
		t.Fatalf("result %+v", r.pairResults())
	}
	n := len(r.tg.requests("getUpdates"))
	time.Sleep(150 * time.Millisecond)
	if m := len(r.tg.requests("getUpdates")); m != n {
		t.Fatalf("polling after cancel: %d → %d", n, m)
	}
}

func TestPairingConflictBacksOff(t *testing.T) {
	r := newRig(t, Options{})
	r.tg.failGet = func(n int) (int, string) {
		if n >= 1 && n <= 2 {
			return 409, `{"ok":false,"error_code":409,"description":"Conflict: terminated by other getUpdates request; make sure that only one bot instance is running"}`
		}
		return 0, ""
	}
	code := r.startPairing(t)
	waitFor(t, "the conflict", func() bool { p := r.ch.State().Pairing; return p != nil && p.State == notify.PairConflict })
	if p := r.ch.State().Pairing; !strings.Contains(p.Message, "Another program") {
		t.Fatalf("message %q", p.Message)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	r.clock.WaitFor(ctx, 1)
	r.clock.Advance(2 * time.Second)
	r.clock.WaitFor(ctx, 1)
	r.clock.Advance(4 * time.Second)
	r.tg.push(42, "private", code, false)
	waitFor(t, "the pairing after the conflict", func() bool { return r.ch.Ready() })
	waitFor(t, "the result", func() bool { return len(r.pairResults()) == 1 })
	if res := r.pairResults()[0]; res.Outcome != notify.PairedOK || res.Errors != 2 || res.Status != 409 {
		t.Fatalf("result %+v", res)
	}
}

func TestSetTokenChecksIt(t *testing.T) {
	r := newRig(t, Options{})
	err := r.ch.SetToken(context.Background(), "not a token")
	if notify.CodeOf(err) != notify.CodeBadRequest || len(r.tg.requests("")) != 0 {
		t.Fatalf("bad token: %v, %d requests", err, len(r.tg.requests("")))
	}
	other := "987654321:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDzzz"
	err = r.ch.SetToken(context.Background(), other)
	if notify.CodeOf(err) != notify.CodeUnauthorized {
		t.Fatalf("refused token: %v", err)
	}
	if strings.Contains(err.Error(), other) || strings.Contains(err.Error(), "AAHdq") {
		t.Fatalf("token in the error: %q", err)
	}
	if r.ch.State().KeySet {
		t.Fatal("a refused token was saved")
	}
}

func TestEnvTokenIsLocked(t *testing.T) {
	dir := t.TempDir()
	kf := filepath.Join(dir, "token")
	if err := os.WriteFile(kf, []byte(token+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	r := newRig(t, Options{KeyFile: kf})
	st := r.ch.State()
	if !st.KeySet || !st.KeyEnv {
		t.Fatalf("state %+v", st)
	}
	if err := r.ch.SetToken(context.Background(), token); notify.CodeOf(err) != notify.CodeEnvLocked {
		t.Fatalf("set: %v", err)
	}
	if err := r.ch.ClearToken(); notify.CodeOf(err) != notify.CodeEnvLocked {
		t.Fatalf("clear: %v", err)
	}
	// It pairs, and the file keeps no token.
	if err := r.ch.StartPairing(context.Background()); err != nil {
		t.Fatal(err)
	}
	r.tg.push(42, "private", strings.ReplaceAll(r.ch.State().Pairing.Code, "-", ""), false)
	waitFor(t, "the pairing", func() bool { return r.ch.Ready() })
	b, _ := os.ReadFile(r.file)
	if bytes.Contains(b, []byte("AAHdq")) {
		t.Fatalf("the environment's token was written: %s", b)
	}
}

func TestErrorsClassified(t *testing.T) {
	r := newRig(t, Options{})
	r.startPairing(t)
	r.tg.push(42, "private", strings.ReplaceAll(r.ch.State().Pairing.Code, "-", ""), false)
	waitFor(t, "the pairing", func() bool { return r.ch.Ready() })
	cases := []struct {
		status int
		body   string
		code   string
		retry  time.Duration
	}{
		{429, `{"ok":false,"error_code":429,"description":"Too Many Requests: retry after 3","parameters":{"retry_after":3}}`, notify.CodeRateLimited, 3 * time.Second},
		{403, `{"ok":false,"error_code":403,"description":"Forbidden: bot was blocked by the user"}`, notify.CodeBlocked, 0},
		{400, `{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}`, notify.CodeBlocked, 0},
		{502, `<html>Bad Gateway</html>`, notify.CodeFailed, 0},
		{500, `{"ok":false,"error_code":500,"description":"Internal Server Error"}`, notify.CodeFailed, 0},
	}
	for _, c := range cases {
		r.tg.mu.Lock()
		r.tg.failMsg = func(int) (int, string) { return c.status, c.body }
		r.tg.mu.Unlock()
		_, err := r.ch.Send(context.Background(), notify.Notification{Name: "a", Reason: "b"})
		se, ok := err.(*notify.SendError)
		if !ok || se.Code != c.code || se.RetryAfter != c.retry || se.Status != c.status {
			t.Errorf("%d: %#v", c.status, err)
		}
		if c.status >= 500 && !se.Retryable() {
			t.Errorf("%d not retryable", c.status)
		}
	}
}

// The token is in every request's URL: no error, log line, state or audit
// may carry it, whatever failed.
func TestTokenNeverLeaks(t *testing.T) {
	r := newRig(t, Options{})
	r.startPairing(t)
	r.tg.push(42, "private", strings.ReplaceAll(r.ch.State().Pairing.Code, "-", ""), false)
	waitFor(t, "the pairing", func() bool { return r.ch.Ready() })
	secret := token[strings.IndexByte(token, ':')+1:]
	check := func(what, s string) {
		t.Helper()
		if strings.Contains(s, secret) || strings.Contains(s, token) {
			t.Errorf("%s holds the token: %q", what, s)
		}
	}
	// The provider echoing the token back in its description.
	r.tg.mu.Lock()
	r.tg.failMsg = func(int) (int, string) {
		return 400, `{"ok":false,"error_code":400,"description":"Bad Request: bad thing in /bot` + token + `/sendMessage"}`
	}
	r.tg.mu.Unlock()
	_, err := r.ch.Send(context.Background(), notify.Notification{Name: "a", Reason: "b"})
	check("an echoed description", err.Error())
	// A message with the token in it goes out without it.
	r.tg.mu.Lock()
	r.tg.failMsg = nil
	r.tg.mu.Unlock()
	if _, err := r.ch.Send(context.Background(), notify.Notification{Name: "a", Reason: "b", Line: "it printed " + token}); err != nil {
		t.Fatal(err)
	}
	msgs := r.tg.requests("sendMessage")
	check("a message's text", msgs[len(msgs)-1].body["text"].(string))

	// *url.Error: nothing listening (connection refused) prints the URL.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	dead := "http://" + ln.Addr().String()
	ln.Close()
	r.ch.api.base = dead
	_, err = r.ch.Send(context.Background(), notify.Notification{Name: "a", Reason: "b"})
	if notify.CodeOf(err) != notify.CodeUnreachable {
		t.Fatalf("refused: %v", err)
	}
	check("a refused connection's error", err.Error())
	err = r.ch.SetToken(context.Background(), token)
	check("a refused getMe's error", err.Error())
	err = r.ch.StartPairing(context.Background())
	check("a refused pairing's error", err.Error())
	// A timeout.
	stop := make(chan struct{})
	hang := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-stop:
		}
	}))
	defer hang.Close()
	defer close(stop)
	r.ch.api.base = hang.URL
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	_, err = r.ch.Send(ctx, notify.Notification{Name: "a", Reason: "b"})
	cancel()
	if notify.CodeOf(err) != notify.CodeTimeout {
		t.Fatalf("timeout: %v", err)
	}
	check("a timeout's error", err.Error())
	// The state, as the protocol carries it.
	b, _ := json.Marshal(r.ch.State())
	check("the state", string(b))
	check("the log", r.log.String())
}

// The whole path against the fake: a worker needing you sends one message
// at once, a worker done one after the settle; switched off nothing reaches
// Telegram at all.
func TestServiceAgainstTheFake(t *testing.T) {
	for _, on := range []bool{false, true} {
		t.Run(fmt.Sprintf("enabled=%v", on), func(t *testing.T) {
			r := newRig(t, Options{})
			if err := r.ch.SetToken(context.Background(), token); err != nil {
				t.Fatal(err)
			}
			r.ch.mu.Lock()
			r.ch.stored.UserID, r.ch.stored.UserName = 42, "Ada" // paired before
			r.ch.mu.Unlock()
			base := len(r.tg.requests(""))
			svc, err := notify.New(context.Background(), notify.Options{Channel: r.ch, Clock: r.clock, EnvEnabled: &on})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan struct{})
			go func() {
				defer close(done)
				svc.Run(ctx)
			}()
			defer func() {
				cancel()
				<-done
			}()
			w := func(id, status string, since int64) notify.Observation {
				return notify.Observation{Worker: notify.Worker{ID: id, Status: status, StatusSince: since}, Name: "Pixel", Line: "line"}
			}
			svc.Observe(w("a", "working", 1))
			svc.Observe(w("b", "working", 1))
			svc.Observe(w("a", "blocked", 2))
			svc.Observe(w("b", "done", 2))
			if !on {
				r.clock.Advance(time.Minute)
				time.Sleep(200 * time.Millisecond)
				if n := len(r.tg.requests("")); n != base {
					t.Fatalf("switched off, %d requests reached Telegram", n-base)
				}
				return
			}
			waitFor(t, "the needs-you message", func() bool { return len(r.tg.requests("sendMessage")) == 1 })
			if m := r.tg.requests("sendMessage")[0].body; m["text"] != "Pixel · Needs you\nline" {
				t.Fatalf("message %+v", m)
			}
			cctx, ccancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer ccancel()
			r.clock.WaitFor(cctx, 1)
			r.clock.Advance(4 * time.Second)
			time.Sleep(50 * time.Millisecond)
			if len(r.tg.requests("sendMessage")) != 1 {
				t.Fatal("done sent before 5 s")
			}
			r.clock.WaitFor(cctx, 1)
			r.clock.Advance(time.Second)
			waitFor(t, "the done message", func() bool { return len(r.tg.requests("sendMessage")) == 2 })
			if m := r.tg.requests("sendMessage")[1].body; m["text"] != "Pixel · Finished\nline" {
				t.Fatalf("message %+v", m)
			}
			time.Sleep(100 * time.Millisecond)
			if n := len(r.tg.requests("sendMessage")); n != 2 {
				t.Fatalf("%d messages, want exactly 2", n)
			}
		})
	}
}
