package notify

import (
	"context"
	"sync"
	"time"
)

var _ Channel = (*FakeChannel)(nil)

// FakeChannel is a Channel for tests: it records the messages it is asked
// to send and answers what SendErr says; (#13) Deliver hands the service a
// reply, while it listens, and the confirmations and answers are recorded.
// Safe for concurrent use.
type FakeChannel struct {
	mu   sync.Mutex
	st   ChannelState
	sent []Notification
	// SendErr, when set, is called before each send: its error is the
	// send's (nil: delivered). It may block (a provider that hangs).
	SendErr func(ctx context.Context, n int) error
	change  chan struct{}
	sentC   chan struct{}
	hooks   Hooks
	listen  bool

	confirmed []Ref
	answered  []FakeAnswer
}

// FakeChatID is the chat of a FakeChannel's messages.
const FakeChatID = 7

// FakeAnswer is an answer the service gave a reply.
type FakeAnswer struct {
	To   Ref
	Text string
}

// NewFakeChannel is a fake with a token and a paired recipient when ready.
func NewFakeChannel(ready bool) *FakeChannel {
	f := &FakeChannel{st: ChannelState{Provider: "fake"}, change: make(chan struct{}, 1), sentC: make(chan struct{}, 64)}
	if ready {
		f.st.KeySet, f.st.KeyHint, f.st.Paired = true, "abcd", &Recipient{Name: "Ada", At: 1}
	}
	return f
}

// Send records n: the k-th attempt (from 0) is message k+1 of FakeChatID.
func (f *FakeChannel) Send(ctx context.Context, n Notification) (Ref, error) {
	f.mu.Lock()
	hook, k := f.SendErr, len(f.sent)
	f.mu.Unlock()
	if hook != nil {
		if err := hook(ctx, k); err != nil {
			f.mu.Lock()
			f.sent = append(f.sent, Notification{Name: "(failed)"})
			f.mu.Unlock()
			f.tick()
			return Ref{}, err
		}
	}
	f.mu.Lock()
	f.sent = append(f.sent, n)
	ref := Ref{FakeChatID, int64(len(f.sent))}
	f.mu.Unlock()
	f.tick()
	return ref, nil
}

func (f *FakeChannel) tick() {
	select {
	case f.sentC <- struct{}{}:
	default:
	}
}

// Sent is every send attempt so far (a failed one as Name "(failed)").
func (f *FakeChannel) Sent() []Notification {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Notification(nil), f.sent...)
}

// WaitSent waits until n attempts were made (false: not within d).
func (f *FakeChannel) WaitSent(n int, d time.Duration) bool {
	deadline := time.After(d)
	for {
		if len(f.Sent()) >= n {
			return true
		}
		select {
		case <-f.sentC:
		case <-deadline:
			return len(f.Sent()) >= n
		}
	}
}

func (f *FakeChannel) State() ChannelState {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.st
}

func (f *FakeChannel) Ready() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.st.KeySet && f.st.Paired != nil
}

func (f *FakeChannel) Fingerprint() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.st.Paired == nil {
		return f.st.KeyHint
	}
	return f.st.KeyHint + "|" + f.st.Paired.Name
}

// SetState replaces the state (a token set elsewhere, a recipient paired).
func (f *FakeChannel) SetState(st ChannelState) {
	f.mu.Lock()
	f.st = st
	f.mu.Unlock()
	f.signal()
}

func (f *FakeChannel) signal() {
	select {
	case f.change <- struct{}{}:
	default:
	}
}

func (f *FakeChannel) SetToken(_ context.Context, token string) error {
	f.mu.Lock()
	if f.st.KeyEnv {
		f.mu.Unlock()
		return &Error{CodeEnvLocked, "the bot token is set by the bridge environment"}
	}
	f.st.KeySet, f.st.KeyHint, f.st.Paired = true, token[max(0, len(token)-4):], nil
	f.mu.Unlock()
	f.signal()
	return nil
}

func (f *FakeChannel) ClearToken() error {
	f.mu.Lock()
	f.st = ChannelState{Provider: f.st.Provider}
	f.mu.Unlock()
	f.signal()
	return nil
}

func (f *FakeChannel) StartPairing(context.Context) error {
	f.mu.Lock()
	f.st.Pairing = &Pairing{State: PairWaiting, Code: "ABCD-EFGH", ExpiresAt: 1}
	f.mu.Unlock()
	f.signal()
	return nil
}

func (f *FakeChannel) CancelPairing() error {
	f.mu.Lock()
	f.st.Pairing = nil
	pair := f.hooks.Pair
	f.mu.Unlock()
	if pair != nil {
		pair(PairResult{Outcome: PairCancelled})
	}
	f.signal()
	return nil
}

// CompletePairing pairs Name as if the code had arrived.
func (f *FakeChannel) CompletePairing(name string) {
	f.mu.Lock()
	f.st.Pairing, f.st.Paired = nil, &Recipient{Name: name, At: 2}
	pair := f.hooks.Pair
	f.mu.Unlock()
	if pair != nil {
		pair(PairResult{Outcome: PairedOK, Ignored: 1})
	}
	f.signal()
}

func (f *FakeChannel) Unpair() error {
	f.mu.Lock()
	f.st.Paired = nil
	f.mu.Unlock()
	f.signal()
	return nil
}

func (f *FakeChannel) Changes() <-chan struct{} { return f.change }

func (f *FakeChannel) Run(ctx context.Context, h Hooks) {
	f.mu.Lock()
	f.hooks = h
	f.mu.Unlock()
	f.signal()
	<-ctx.Done()
}

func (f *FakeChannel) Listen(on bool) {
	f.mu.Lock()
	f.listen = on
	f.mu.Unlock()
}

// Listening: replies are read (Run has started, Listen on, paired).
func (f *FakeChannel) Listening() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.listen && f.hooks.Reply != nil && f.st.KeySet && f.st.Paired != nil
}

// Deliver hands the service r as the recipient's message, if replies are
// read (false: dropped, as a channel that does not listen does).
func (f *FakeChannel) Deliver(r Reply) bool {
	if !f.Listening() {
		return false
	}
	f.mu.Lock()
	h := f.hooks.Reply
	f.mu.Unlock()
	h(r)
	return true
}

func (f *FakeChannel) Confirm(_ context.Context, msg Ref) error {
	f.mu.Lock()
	f.confirmed = append(f.confirmed, msg)
	f.mu.Unlock()
	f.tick()
	return nil
}

func (f *FakeChannel) Answer(_ context.Context, msg Ref, text string) error {
	f.mu.Lock()
	f.answered = append(f.answered, FakeAnswer{msg, text})
	f.mu.Unlock()
	f.tick()
	return nil
}

// Confirmed is every reply confirmed so far; Answered every answer.
func (f *FakeChannel) Confirmed() []Ref {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Ref(nil), f.confirmed...)
}

func (f *FakeChannel) Answered() []FakeAnswer {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]FakeAnswer(nil), f.answered...)
}

// WaitReplied waits until n replies were confirmed or answered in all.
func (f *FakeChannel) WaitReplied(n int, d time.Duration) bool {
	deadline := time.After(d)
	count := func() int { return len(f.Confirmed()) + len(f.Answered()) }
	for {
		if count() >= n {
			return true
		}
		select {
		case <-f.sentC:
		case <-deadline:
			return count() >= n
		}
	}
}

// FakeStore is a Store in memory. Safe for concurrent use.
type FakeStore struct {
	mu   sync.Mutex
	set  *Settings
	msgs map[Ref]fakeMsg
}

type fakeMsg struct {
	worker string
	at     time.Time
}

func NewFakeStore() *FakeStore { return &FakeStore{msgs: map[Ref]fakeMsg{}} }

func (s *FakeStore) LoadNotifySettings(context.Context) (Settings, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.set == nil {
		return Settings{}, false, nil
	}
	return *s.set, true, nil
}

func (s *FakeStore) SaveNotifySettings(_ context.Context, n Settings) error {
	s.mu.Lock()
	s.set = &n
	s.mu.Unlock()
	return nil
}

func (s *FakeStore) SaveNotifyMessage(_ context.Context, msg Ref, worker string, at time.Time) error {
	s.mu.Lock()
	s.msgs[msg] = fakeMsg{worker, at}
	s.mu.Unlock()
	return nil
}

func (s *FakeStore) NotifyMessage(_ context.Context, msg Ref) (string, time.Time, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, ok := s.msgs[msg]
	return m.worker, m.at, ok, nil
}
