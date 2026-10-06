package codexapp

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
)

// #156: Codex's async questions and their answers, as the bridge's join of a
// worker's thread sees them (docs/research/codex-shared-tui.md §1, §2):
//
//   - A batch is an agentMessage item with delivery "async" and a questions
//     array; its id is the function call_id, the same in live events, in
//     thread/resume and thread/read history and after a cold resume.
//   - The tool's {"accepted":true} only schedules it. A question is answered
//     only by a user message whose text is the reply envelope naming its
//     (call_id, index), whoever sent it: the bridge or the terminal.
//   - The server does not deduplicate: the same envelope twice is two
//     deliveries. A question is therefore sent at most once (pending →
//     sending → sent) and never re-sent by itself.
//   - A steered input is delivered with the turn's next model request, as a
//     user message of that turn. A turn that ends first (interrupted) drops
//     it: it is not delivered and not carried into the next turn
//     (TestCodexShareAsyncAnswers). Such a question is sent and undelivered,
//     and only then may the user send it again.

// ThreadItem types and the async delivery the bridge reads.
const (
	ItemAgentMessage = "agentMessage"
	ItemUserMessage  = "userMessage"
	DeliveryAsync    = "async"
)

// Item is the part of an app-server ThreadItem the bridge reads.
type Item struct {
	Type      string          `json:"type"`
	ID        string          `json:"id"`
	Text      string          `json:"text,omitempty"`
	Delivery  string          `json:"delivery,omitempty"`
	Questions []AsyncQuestion `json:"questions,omitempty"`
	// Content and ClientID are a userMessage's: its inputs, and the
	// clientUserMessageId the client that sent it gave (none for some).
	Content  []UserInput `json:"content,omitempty"`
	ClientID string      `json:"clientId,omitempty"`
}

// AsyncQuestion is one question of a batch; no options means free text.
type AsyncQuestion struct {
	Title   string   `json:"title"`
	Options []string `json:"options"`
}

// UserInput is one input of a user message (text, an image, a skill, …).
type UserInput struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

// UserText is a user message's text inputs, joined.
func (it Item) UserText() string {
	var b strings.Builder
	for _, c := range it.Content {
		if c.Type == "text" {
			b.WriteString(c.Text)
		}
	}
	return b.String()
}

// Turn is the part of an app-server Turn the bridge reads.
type Turn struct {
	ID     string `json:"id"`
	Status string `json:"status"` // inProgress, completed, interrupted, failed
	Items  []Item `json:"items"`
}

// TurnInProgress is a running turn's status.
const TurnInProgress = "inProgress"

// ThreadActive is the status of a thread with a turn running.
const ThreadActive = "active"

// QuestionState is where one question is.
type QuestionState string

// Question states.
const (
	// QPending: asked, not answered; the bridge may answer it.
	QPending QuestionState = "pending"
	// QSending: the bridge's answer is on its way (on the worker's input
	// lane, its request in flight).
	QSending QuestionState = "sending"
	// QSent: the server accepted the bridge's answer (turn/steer or
	// turn/start returned). Not yet answered: a steered input is delivered
	// with the next model request.
	QSent QuestionState = "sent"
	// QAnswered: a user message holding the envelope for this question was
	// seen, live or in the history.
	QAnswered QuestionState = "answered"
	// QDismissed: put away by the user, in the bridge only (Codex still
	// holds it as pending; the terminal or a late envelope may answer it).
	QDismissed QuestionState = "dismissed"
)

// Where a batch was seen.
const (
	OriginLive    = "live"    // an item/started or item/completed of the join
	OriginHistory = "history" // the thread's turns, read on joining
)

// Who an answered question's envelope came from: the bridge (its user
// message carries a client id the bridge made, NewClientID) or anyone else
// (the terminal, another client, a bridge that did not name itself).
const (
	AnsweredByBridge = "bridge"
	AnsweredByOther  = "other"
)

// Question is one question of a batch and where it is.
type Question struct {
	Title   string
	Options []string
	State   QuestionState
	// Answer and AnsweredBy: the envelope's answer text, and who sent it
	// (QAnswered).
	Answer, AnsweredBy string
	// Unconfirmed: the bridge sent the answer but got no response, so it
	// cannot tell whether the server took it (QSent). It is not sent again.
	Unconfirmed bool
	// Undelivered: the turn the bridge's answer went to ended without its
	// user message (QSent): Codex dropped it. It may be answered again.
	Undelivered bool
	// Error: why the bridge's last answer was refused, nothing delivered
	// (QPending).
	Error string
	// reached is the turn the bridge's answer went to (QSent).
	reached string
}

// Batch is one async-question message.
type Batch struct {
	ID, Turn string
	// Seen lists where the batch was seen, in order (OriginLive,
	// OriginHistory).
	Seen []string
	// Twin: another batch in the same turn with the same questions, seen
	// only the other way (live or history) under another id. The ids were
	// equal in every case observed; when they are not, both are kept.
	Twin string
	// Conflict: live and history gave this id different questions. The
	// first ones are kept and the batch cannot be answered.
	Conflict bool
	// At is when the reconciler first saw it.
	At        time.Time
	Questions []Question
}

// MaxBatches bounds the batches kept per thread; the oldest resolved one
// (else the oldest) goes first.
const MaxBatches = 32

// maxEarly bounds the envelopes kept for batches not seen yet, maxEnded the
// turns remembered as ended.
const (
	maxEarly = 64
	maxEnded = 16
)

// Errors of answering and dismissing.
var (
	ErrUnknownBatch = errors.New("no such question batch")
	ErrNotPending   = errors.New("the question is not pending")
	ErrConflict     = errors.New("live and history disagree on this batch")
	ErrBadAnswer    = errors.New("invalid answer")
)

// BatchOf reads an item as an async-question batch of turn.
func BatchOf(turn string, it Item) (Batch, bool) {
	if it.Type != ItemAgentMessage || it.Delivery != DeliveryAsync || it.ID == "" || len(it.Questions) == 0 {
		return Batch{}, false
	}
	b := Batch{ID: it.ID, Turn: turn}
	for _, q := range it.Questions {
		b.Questions = append(b.Questions, Question{Title: q.Title, Options: slices.Clone(q.Options), State: QPending})
	}
	return b, true
}

type qkey struct {
	batch string
	index int
}

type early struct {
	answer, by string
}

// Questions reconciles one thread's batches and their answers, live and
// history. It is not safe for concurrent use.
type Questions struct {
	Thread  string
	batches map[string]*Batch
	order   []string
	early   map[qkey]early
	ended   []string // the last turns seen ending, newest last
}

// NewQuestions starts the reconciler of a thread.
func NewQuestions(thread string) *Questions {
	return &Questions{Thread: thread, batches: map[string]*Batch{}, early: map[qkey]early{}}
}

// Batch returns a copy of a batch, nil when unknown.
func (q *Questions) Batch(id string) *Batch {
	b := q.batches[id]
	if b == nil {
		return nil
	}
	c := b.clone()
	return &c
}

// Batches returns copies of the batches, oldest first.
func (q *Questions) Batches() []Batch {
	out := make([]Batch, 0, len(q.order))
	for _, id := range q.order {
		out = append(out, q.batches[id].clone())
	}
	return out
}

func (b *Batch) clone() Batch {
	c := *b
	c.Seen = slices.Clone(b.Seen)
	c.Questions = slices.Clone(b.Questions)
	for i := range c.Questions {
		c.Questions[i].Options = slices.Clone(b.Questions[i].Options)
	}
	return c
}

// Observe takes one item of turn, seen live or in the history; it reports
// whether anything changed. An async agentMessage is a batch; a user
// message whose text is a reply envelope answers the questions it names.
// Anything else changes nothing.
func (q *Questions) Observe(turn string, it Item, origin string) bool {
	if b, ok := BatchOf(turn, it); ok {
		return q.addBatch(b, origin)
	}
	if it.Type != ItemUserMessage {
		return false
	}
	answers, ok := ParseReply(it.UserText())
	if !ok {
		return false
	}
	by := AnsweredByOther
	if IsBridgeClientID(it.ClientID) {
		by = AnsweredByBridge
	}
	changed := false
	for _, a := range answers {
		b := q.batches[a.MessageID]
		if b == nil {
			if len(q.early) < maxEarly {
				q.early[qkey{a.MessageID, a.Index}] = early{answer: a.Answer, by: by}
			}
			continue
		}
		changed = b.answer(a.Index, a.Answer, by) || changed
	}
	return changed
}

// Hydrate takes a thread's turns (a join's history): its batches first,
// then the envelopes, so an answer never waits on its batch.
func (q *Questions) Hydrate(turns []Turn) bool {
	changed := false
	for _, t := range turns {
		for _, it := range t.Items {
			if it.Type == ItemAgentMessage {
				changed = q.Observe(t.ID, it, OriginHistory) || changed
			}
		}
	}
	for _, t := range turns {
		for _, it := range t.Items {
			if it.Type == ItemUserMessage {
				changed = q.Observe(t.ID, it, OriginHistory) || changed
			}
		}
	}
	for _, t := range turns {
		if t.Status != "" && t.Status != TurnInProgress {
			changed = q.TurnEnded(t.ID) || changed
		}
	}
	return changed
}

// TurnEnded takes the end of a turn (turn/completed, whatever its status;
// or an ended turn of the history): the bridge's answers that went to it
// and whose user message never came are undelivered.
func (q *Questions) TurnEnded(turn string) bool {
	if turn == "" {
		return false
	}
	if !slices.Contains(q.ended, turn) {
		if q.ended = append(q.ended, turn); len(q.ended) > maxEnded {
			q.ended = q.ended[1:]
		}
	}
	changed := false
	for _, id := range q.order {
		for i := range q.batches[id].Questions {
			x := &q.batches[id].Questions[i]
			if x.State == QSent && !x.Unconfirmed && !x.Undelivered && x.reached == turn {
				x.Undelivered, changed = true, true
			}
		}
	}
	return changed
}

func (b *Batch) answer(index int, text, by string) bool {
	if index < 0 || index >= len(b.Questions) {
		return false
	}
	x := &b.Questions[index]
	if x.State == QAnswered && x.Answer == text && x.AnsweredBy == by {
		return false
	}
	*x = Question{Title: x.Title, Options: x.Options, State: QAnswered, Answer: text, AnsweredBy: by}
	return true
}

func sameQuestions(a []Question, b []Question) bool {
	return slices.EqualFunc(a, b, func(x, y Question) bool { return x.Title == y.Title && slices.Equal(x.Options, y.Options) })
}

func (q *Questions) addBatch(b Batch, origin string) bool {
	if cur := q.batches[b.ID]; cur != nil {
		changed := false
		if !slices.Contains(cur.Seen, origin) {
			cur.Seen = append(cur.Seen, origin)
			changed = true
		}
		if !cur.Conflict && !sameQuestions(cur.Questions, b.Questions) {
			cur.Conflict, changed = true, true
		}
		return changed
	}
	b.Seen, b.At = []string{origin}, time.Now()
	for _, id := range q.order {
		o := q.batches[id]
		if o.Twin == "" && o.Turn == b.Turn && !slices.Contains(o.Seen, origin) && sameQuestions(o.Questions, b.Questions) {
			o.Twin, b.Twin = b.ID, o.ID
			break
		}
	}
	for i := range b.Questions {
		if e, ok := q.early[qkey{b.ID, i}]; ok {
			b.answer(i, e.answer, e.by)
			delete(q.early, qkey{b.ID, i})
		}
	}
	q.batches[b.ID] = &b
	q.order = append(q.order, b.ID)
	if len(q.order) > MaxBatches {
		q.drop()
	}
	return true
}

// drop forgets the oldest resolved batch (every question answered or
// dismissed), else the oldest.
func (q *Questions) drop() {
	at := 0
	for i, id := range q.order {
		if q.batches[id].resolved() {
			at = i
			break
		}
	}
	id := q.order[at]
	q.order = slices.Delete(q.order, at, at+1)
	if tw := q.batches[id].Twin; tw != "" && q.batches[tw] != nil {
		q.batches[tw].Twin = ""
	}
	delete(q.batches, id)
}

func (b *Batch) resolved() bool {
	for _, x := range b.Questions {
		if x.State != QAnswered && x.State != QDismissed {
			return false
		}
	}
	return true
}

// Unanswered reports whether a batch of turn has a question Codex still
// holds as pending: anything but answered (a dismissed one included).
func (q *Questions) Unanswered(turn string) bool {
	for _, id := range q.order {
		b := q.batches[id]
		if b.Turn != turn {
			continue
		}
		for _, x := range b.Questions {
			if x.State != QAnswered {
				return true
			}
		}
	}
	return false
}

// Reply is the user's answer to one question of a batch.
type Reply struct {
	Index int
	Text  string
}

// Begin checks replies against a batch and marks their questions sending:
// each names a distinct question that is pending (or sent and undelivered:
// the user sends it again), a question with options
// takes one of them exactly, one without takes any text that is not blank.
// It returns the answers to put in the envelope, in the replies' order.
func (q *Questions) Begin(batch string, replies []Reply) ([]Answer, error) {
	answers, err := q.Check(batch, replies)
	if err != nil {
		return nil, err
	}
	b := q.batches[batch]
	for _, r := range replies {
		x := &b.Questions[r.Index]
		x.State, x.Error, x.Undelivered, x.reached = QSending, "", false, ""
	}
	return answers, nil
}

// Check is Begin without marking anything.
func (q *Questions) Check(batch string, replies []Reply) ([]Answer, error) {
	b := q.batches[batch]
	switch {
	case b == nil:
		return nil, fmt.Errorf("%w: %s", ErrUnknownBatch, batch)
	case b.Conflict:
		return nil, fmt.Errorf("%w: %s", ErrConflict, batch)
	case len(replies) == 0:
		return nil, fmt.Errorf("%w: no answer", ErrBadAnswer)
	}
	seen := map[int]bool{}
	answers := make([]Answer, 0, len(replies))
	for _, r := range replies {
		if r.Index < 0 || r.Index >= len(b.Questions) {
			return nil, fmt.Errorf("%w: batch %s has no question %d", ErrBadAnswer, batch, r.Index)
		}
		if seen[r.Index] {
			return nil, fmt.Errorf("%w: question %d answered twice", ErrBadAnswer, r.Index)
		}
		seen[r.Index] = true
		x := b.Questions[r.Index]
		if x.State != QPending && !(x.State == QSent && x.Undelivered) {
			return nil, fmt.Errorf("%w: question %d of %s is %s", ErrNotPending, r.Index, batch, x.State)
		}
		if len(x.Options) > 0 && !slices.Contains(x.Options, r.Text) {
			return nil, fmt.Errorf("%w: question %d takes one of its %d options", ErrBadAnswer, r.Index, len(x.Options))
		}
		if strings.TrimSpace(r.Text) == "" {
			return nil, fmt.Errorf("%w: question %d's answer is blank", ErrBadAnswer, r.Index)
		}
		answers = append(answers, Answer{MessageID: batch, Index: r.Index, Question: x.Title, Answer: r.Text})
	}
	return answers, nil
}

// Sent records that the server accepted the bridge's answer into turn
// reached (unconfirmed: no response came, so whether it did is unknown, and
// reached is ""). Only questions still sending change; one whose turn
// already ended is undelivered at once.
func (q *Questions) Sent(batch string, indexes []int, reached string, unconfirmed bool) {
	q.each(batch, indexes, func(x *Question) {
		if x.State == QSending {
			x.State, x.Unconfirmed, x.reached = QSent, unconfirmed, reached
			x.Undelivered = !unconfirmed && reached != "" && slices.Contains(q.ended, reached)
		}
	})
}

// Failed records that the server refused the bridge's answer: nothing was
// delivered, the questions are pending again with the reason.
func (q *Questions) Failed(batch string, indexes []int, reason string) {
	q.each(batch, indexes, func(x *Question) {
		if x.State == QSending {
			x.State, x.Error = QPending, reason
		}
	})
}

func (q *Questions) each(batch string, indexes []int, fn func(*Question)) {
	b := q.batches[batch]
	if b == nil {
		return
	}
	for _, i := range indexes {
		if i >= 0 && i < len(b.Questions) {
			fn(&b.Questions[i])
		}
	}
}

// Dismiss puts questions of a batch away (all that can be when indexes is
// empty): pending or sent ones only.
func (q *Questions) Dismiss(batch string, indexes []int) error {
	b := q.batches[batch]
	if b == nil {
		return fmt.Errorf("%w: %s", ErrUnknownBatch, batch)
	}
	if len(indexes) == 0 {
		for i, x := range b.Questions {
			if x.State == QPending || x.State == QSent {
				indexes = append(indexes, i)
			}
		}
		if len(indexes) == 0 {
			return fmt.Errorf("%w: batch %s has nothing to dismiss", ErrNotPending, batch)
		}
	}
	for _, i := range indexes {
		if i < 0 || i >= len(b.Questions) {
			return fmt.Errorf("%w: batch %s has no question %d", ErrBadAnswer, batch, i)
		}
		if s := b.Questions[i].State; s != QPending && s != QSent {
			return fmt.Errorf("%w: question %d of %s is %s", ErrNotPending, i, batch, s)
		}
	}
	for _, i := range indexes {
		b.Questions[i].State = QDismissed
	}
	return nil
}

// bridgeClientPrefix starts every clientUserMessageId the bridge sends.
const bridgeClientPrefix = ClientName + "-"

// NewClientID makes the clientUserMessageId of one input the bridge sends:
// the server echoes it as the user message's clientId, which is how an
// envelope is known to be the bridge's.
func NewClientID() string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return bridgeClientPrefix + hex.EncodeToString(b[:])
}

// IsBridgeClientID reports whether a user message's clientId is one the
// bridge made.
func IsBridgeClientID(id string) bool { return strings.HasPrefix(id, bridgeClientPrefix) }
