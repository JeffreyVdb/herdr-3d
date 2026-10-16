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
	// hold is Hold's: taken before mu by what changes the epoch.
	hold sync.Mutex
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
	epoch   uint64

	confirmed []Ref
	answered  []FakeAnswer
	// #14: the cards (by ref, as shown now), in the order sent; the taps
	// answered, the prompts sent, the messages whose buttons were taken.
	cardN   int64
	cards   []Ref
	shown   map[Ref]Card
	edits   int
	tapAns  []FakeTapAnswer
	prompts []FakePrompt
	cleared []Ref
}

// FakeCardBase is the first message id of a FakeChannel's cards and
// prompts (its notifications are 1, 2, …).
const FakeCardBase = 100000

// FakeTapAnswer is a tap's answer.
type FakeTapAnswer struct {
	ID, Text string
}

// FakePrompt is a reply prompt sent.
type FakePrompt struct {
	Ref, To           Ref
	Text, Placeholder string
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
	f := &FakeChannel{st: ChannelState{Provider: "fake"}, change: make(chan struct{}, 1), sentC: make(chan struct{}, 64),
		cardN: FakeCardBase - 1, shown: map[Ref]Card{}}
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
	f.hold.Lock()
	f.mu.Lock()
	f.st = st
	f.epoch++
	f.mu.Unlock()
	f.hold.Unlock()
	f.signal()
}

func (f *FakeChannel) signal() {
	select {
	case f.change <- struct{}{}:
	default:
	}
}

func (f *FakeChannel) SetToken(_ context.Context, token string) error {
	f.hold.Lock()
	defer f.hold.Unlock()
	f.mu.Lock()
	if f.st.KeyEnv {
		f.mu.Unlock()
		return &Error{CodeEnvLocked, "the bot token is set by the bridge environment"}
	}
	f.st.KeySet, f.st.KeyHint, f.st.Paired = true, token[max(0, len(token)-4):], nil
	f.epoch++
	f.mu.Unlock()
	f.signal()
	return nil
}

func (f *FakeChannel) ClearToken() error {
	f.hold.Lock()
	f.mu.Lock()
	f.st = ChannelState{Provider: f.st.Provider}
	f.epoch++
	f.mu.Unlock()
	f.hold.Unlock()
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
	f.hold.Lock()
	f.mu.Lock()
	f.st.Pairing, f.st.Paired = nil, &Recipient{Name: name, At: 2}
	f.epoch++
	pair := f.hooks.Pair
	f.mu.Unlock()
	f.hold.Unlock()
	if pair != nil {
		pair(PairResult{Outcome: PairedOK, Ignored: 1})
	}
	f.signal()
}

func (f *FakeChannel) Unpair() error {
	f.hold.Lock()
	f.mu.Lock()
	f.st.Paired = nil
	f.epoch++
	f.mu.Unlock()
	f.hold.Unlock()
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
	f.hold.Lock()
	f.mu.Lock()
	if f.listen != on {
		f.listen = on
		f.epoch++
	}
	f.mu.Unlock()
	f.hold.Unlock()
}

// Listening: replies are read (Run has started, Listen on, paired).
func (f *FakeChannel) Listening() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.listenLocked() && f.hooks.Reply != nil
}

func (f *FakeChannel) listenLocked() bool {
	return f.listen && f.st.KeySet && f.st.Paired != nil
}

// Stamp is r as read now (its Epoch), for a test that hands the service a
// reply itself.
func (f *FakeChannel) Stamp(r Reply) Reply {
	f.mu.Lock()
	defer f.mu.Unlock()
	r.Epoch = f.epoch
	return r
}

// Deliver hands the service r as the recipient's message, if replies are
// read (false: dropped, as a channel that does not listen does).
func (f *FakeChannel) Deliver(r Reply) bool {
	if !f.Listening() {
		return false
	}
	f.mu.Lock()
	h := f.hooks.Reply
	r.Epoch = f.epoch
	f.mu.Unlock()
	h(r)
	return true
}

func (f *FakeChannel) Hold(r Reply, fn func()) bool {
	f.hold.Lock()
	defer f.hold.Unlock()
	f.mu.Lock()
	ok := f.listenLocked() && r.Epoch == f.epoch
	f.mu.Unlock()
	if ok {
		fn()
	}
	return ok
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

// SendCard records c as the next card (FakeCardBase, …).
func (f *FakeChannel) SendCard(_ context.Context, c Card) (Ref, error) {
	f.mu.Lock()
	f.cardN++
	ref := Ref{FakeChatID, f.cardN}
	f.cards = append(f.cards, ref)
	f.shown[ref] = c
	f.mu.Unlock()
	f.tick()
	return ref, nil
}

// EditCard records c as what msg shows now.
func (f *FakeChannel) EditCard(_ context.Context, msg Ref, c Card) error {
	f.mu.Lock()
	f.shown[msg] = c
	f.edits++
	f.mu.Unlock()
	f.tick()
	return nil
}

func (f *FakeChannel) ClearButtons(_ context.Context, msg Ref) error {
	f.mu.Lock()
	f.cleared = append(f.cleared, msg)
	if c, ok := f.shown[msg]; ok {
		c.Buttons = nil
		f.shown[msg] = c
	}
	f.mu.Unlock()
	f.tick()
	return nil
}

func (f *FakeChannel) AnswerTap(_ context.Context, id, text string) error {
	f.mu.Lock()
	f.tapAns = append(f.tapAns, FakeTapAnswer{id, text})
	f.mu.Unlock()
	f.tick()
	return nil
}

// AskText records a prompt (its ref is the next card's).
func (f *FakeChannel) AskText(_ context.Context, msg Ref, text, placeholder string) (Ref, error) {
	f.mu.Lock()
	f.cardN++
	ref := Ref{FakeChatID, f.cardN}
	f.prompts = append(f.prompts, FakePrompt{ref, msg, text, placeholder})
	f.mu.Unlock()
	f.tick()
	return ref, nil
}

// Cards is every card sent, in order; Card what one shows now.
func (f *FakeChannel) Cards() []Ref {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Ref(nil), f.cards...)
}

func (f *FakeChannel) Card(ref Ref) Card {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.shown[ref]
}

// Edits counts the cards' edits.
func (f *FakeChannel) Edits() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.edits
}

// TapAnswers is every tap's answer; Prompts every prompt; Cleared the
// messages whose buttons were taken away.
func (f *FakeChannel) TapAnswers() []FakeTapAnswer {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]FakeTapAnswer(nil), f.tapAns...)
}

func (f *FakeChannel) Prompts() []FakePrompt {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]FakePrompt(nil), f.prompts...)
}

func (f *FakeChannel) Cleared() []Ref {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Ref(nil), f.cleared...)
}

// Tap hands the service a tap on msg's button with data, as the
// recipient's, if replies are read (false: dropped, as a channel that
// does not listen does). One the service refuses is answered without a
// word, as the Telegram channel does.
func (f *FakeChannel) Tap(id string, msg Ref, data string) bool {
	if !f.Listening() {
		return false
	}
	f.mu.Lock()
	h := f.hooks.Tap
	t := Tap{ID: id, Msg: msg, Data: data, Epoch: f.epoch}
	f.mu.Unlock()
	if h == nil {
		return false
	}
	if !h(t) {
		_ = f.AnswerTap(context.Background(), id, "")
	}
	return true
}

// WaitFor waits until ok (false: not within d), looking again on each
// call the fake records.
func (f *FakeChannel) WaitFor(ok func() bool, d time.Duration) bool {
	deadline := time.After(d)
	for !ok() {
		select {
		case <-f.sentC:
		case <-deadline:
			return ok()
		case <-time.After(5 * time.Millisecond):
		}
	}
	return true
}
