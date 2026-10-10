package transcript

// #223: the latest completed final reply of a transcript, the source of a
// literal handoff. It is fed the same TurnEvents as FollowupTracker (one parse
// per line, txLines), with each line's byte span, and keeps the reply's
// source identity: the agent session, the message's (Claude) or turn's and
// message's (Codex) ids and the lines it came from. Resolve reads those
// lines again from the file and joins the reply's text blocks exactly as the
// tracker did, so the bridge saves the whole literal text, never a preview.
//
// The rules (docs/research, the #223 JSONL findings R1–R16):
//
//   - Claude: a message is every main-thread line of one message.id, its text
//     blocks joined in order with "\n" (HandoffSeparator). It is a candidate
//     once it is closed (the next line is not one of its own) when its last
//     line's stop_reason is end_turn or stop_sequence, or when it is null and
//     system/turn_duration confirms the turn ended; never tool_use, refusal,
//     max_tokens or a thinking-only message. Headless sessions have no
//     turn_duration: end_turn is enough there. A new prompt, a tool result,
//     another assistant message or an interruption ends the candidate.
//   - Codex: text from response_item assistant messages only (event_msg
//     copies are not read). A turn runs from task_started to task_complete
//     (or turn_aborted: never a candidate); its candidate is its last
//     final_answer message, in a legacy rollout without phases its last
//     assistant message, else task_complete's last_agent_message; never a
//     commentary. A subagent's rollout and a child turn (root_turn_id not its
//     turn_id) have none.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"strconv"
	"strings"

	"github.com/JeffreyVdb/herdr-3d/internal/jsonl"
)

// HandoffSeparator joins a message's text blocks (Claude's blocks, Codex's
// parts) in a literal handoff, as in FollowupTracker.
const HandoffSeparator = "\n"

// Sources of a handoff candidate's text.
const (
	// CandMessage is an assistant message's text blocks.
	CandMessage = "message"
	// CandLastAgentMessage is Codex's task_complete.last_agent_message, when
	// the turn had no final_answer or legacy message.
	CandLastAgentMessage = "last_agent_message"
)

// Span is a line of a transcript: the byte it starts at and its length
// (without the line end).
type Span struct {
	Off int64 `json:"off"`
	N   int   `json:"n"`
}

// End is where the line ends.
func (s Span) End() int64 { return s.Off + int64(s.N) }

// Candidate is a transcript's latest completed final reply.
type Candidate struct {
	// ID is 16 hex digits of the identity below and the body's hash: two
	// turns with the same reply have different ids.
	ID      string
	Harness string
	// Session is Claude's sessionId or Codex's session_meta id.
	Session string
	// Message is Claude's message.id or the Codex message's payload.id (""
	// for CandLastAgentMessage).
	Message string
	// Request and Line are Claude's requestId and the final line's uuid.
	Request, Line string
	// Turn is Codex's turn_id.
	Turn string
	// Source says where the text is: CandMessage or CandLastAgentMessage.
	Source string
	// Spans are the lines holding the text, in order.
	Spans []Span
	// Hash is the hex SHA-256 of Body: its revision.
	Hash string
	// Body is the text, as written: the blocks joined, never trimmed.
	Body string
	// Images counts the image blocks left out (not text).
	Images int
}

// claudeMsg is the Claude message being read.
type claudeMsg struct {
	id, request, line, session string
	texts                      []string
	spans                      []Span
	stop                       string
	images                     int
	has                        bool // a text block that is not blank
}

// codexMsg is a Codex assistant message read in the open turn.
type codexMsg struct {
	id, phase string
	texts     []string
	span      Span
}

// HandoffTracker follows one transcript's lines and knows its latest
// completed final reply (nil: none now). Not safe for concurrent use.
type HandoffTracker struct {
	harness string
	cand    *Candidate
	seq     int

	// Claude
	msg     *claudeMsg // the message being read (open)
	prev    *claudeMsg // the message closed last: a line of it may still come
	waiting *claudeMsg // closed with a null stop_reason: turn_duration decides
	session string

	// Codex
	subagent       bool
	codexSession   string
	turnID, rootID string
	open           bool
	final, last    *codexMsg
	phased         bool // a message of the turn had a phase
}

// NewHandoffTracker follows a harness's (claude or codex) transcript; nil
// for another harness.
func NewHandoffTracker(harness string) *HandoffTracker {
	if harness != Claude && harness != Codex {
		return nil
	}
	return &HandoffTracker{harness: harness}
}

// Candidate is the latest completed final reply (nil: none now). The caller
// must not change it.
func (t *HandoffTracker) Candidate() *Candidate { return t.cand }

// Seq counts the changes of Candidate.
func (t *HandoffTracker) Seq() int { return t.seq }

// Reset forgets what was read: the transcript was replaced (or went).
func (t *HandoffTracker) Reset() {
	had := t.cand != nil
	*t = HandoffTracker{harness: t.harness, seq: t.seq}
	if had {
		t.seq++
	}
}

// Line reads one line (tests): off is where it starts.
func (t *HandoffTracker) Line(off int64, b []byte) {
	t.Events(Span{Off: off, N: len(b)}, TurnEvents(t.harness, b))
}

func (t *HandoffTracker) set(c *Candidate) {
	if (t.cand == nil && c == nil) || (t.cand != nil && c != nil && t.cand.ID == c.ID) {
		return
	}
	t.cand = c
	t.seq++
}

// Events applies one line's events; sp is the line. Call it for every line,
// also one without events: a line that is not the open message's closes it.
func (t *HandoffTracker) Events(sp Span, evs []TurnEvent) {
	if t.harness == Claude {
		t.claude(sp, evs)
		return
	}
	for _, ev := range evs {
		t.codex(sp, ev)
	}
}

func (t *HandoffTracker) claude(sp Span, evs []TurnEvent) {
	if len(evs) == 0 {
		t.closeClaude()
		return
	}
	for _, ev := range evs {
		if ev.Session != "" {
			t.session = ev.Session
		}
		switch ev.Kind {
		case TurnAssistant:
			if t.msg != nil && t.msg.id == ev.MsgID && ev.MsgID != "" {
				t.msg.add(sp, ev)
				continue
			}
			t.closeClaude()
			if p := t.prev; p != nil && p.id == ev.MsgID && ev.MsgID != "" {
				// A line of the message closed last, after another line
				// (an attachment): it is open again.
				t.msg, t.prev, t.waiting = p, nil, nil
				t.set(nil)
				p.add(sp, ev)
				continue
			}
			t.waiting = nil
			t.set(nil) // the agent goes on: the earlier reply is not the latest
			t.msg = &claudeMsg{id: ev.MsgID, session: t.session}
			t.msg.add(sp, ev)
		case TurnDone:
			t.closeClaude()
			if w := t.waiting; w != nil {
				t.waiting = nil
				t.set(t.claudeCand(w))
			}
		default: // a prompt, a tool result, an interruption
			t.msg, t.prev, t.waiting = nil, nil, nil
			t.set(nil)
		}
	}
}

func (m *claudeMsg) add(sp Span, ev TurnEvent) {
	if ev.RequestID != "" {
		m.request = ev.RequestID
	}
	if ev.UUID != "" {
		m.line = ev.UUID
	}
	if ev.Session != "" {
		m.session = ev.Session
	}
	m.stop = ev.StopReason
	m.images += ev.Images
	if len(ev.Texts) > 0 {
		m.texts = append(m.texts, ev.Texts...)
		m.spans = append(m.spans, sp)
		for _, s := range ev.Texts {
			m.has = m.has || strings.TrimSpace(s) != ""
		}
	}
}

// closeClaude ends the open message: a candidate when it completed with
// text.
func (t *HandoffTracker) closeClaude() {
	m := t.msg
	if m == nil {
		return
	}
	t.msg, t.prev = nil, m
	if !m.has {
		return
	}
	switch m.stop {
	case "end_turn", "stop_sequence":
		t.set(t.claudeCand(m))
	case "":
		t.waiting = m // turn_duration says whether it completed
	}
}

func (t *HandoffTracker) claudeCand(m *claudeMsg) *Candidate {
	c := &Candidate{Harness: Claude, Session: m.session, Message: m.id, Request: m.request, Line: m.line,
		Source: CandMessage, Spans: m.spans, Body: strings.Join(m.texts, HandoffSeparator), Images: m.images}
	c.seal()
	return c
}

func (t *HandoffTracker) codex(sp Span, ev TurnEvent) {
	switch ev.Kind {
	case TurnSession:
		if ev.Session != "" && t.codexSession == "" {
			t.codexSession = ev.Session
		}
		t.subagent = t.subagent || ev.Subagent
	case TurnStarted:
		t.open, t.turnID, t.rootID = true, ev.TurnID, ev.RootTurnID
		t.final, t.last, t.phased = nil, nil, false
		t.set(nil)
	case TurnPrompt:
		t.set(nil) // a new prompt: the earlier reply is not the latest
	case TurnAssistant:
		m := &codexMsg{id: ev.ItemID, phase: ev.Phase, texts: ev.Texts, span: sp}
		if ev.Phase != "" {
			t.phased = true
		}
		if ev.Phase == "final_answer" {
			t.final = m
		}
		t.last = m
		t.set(nil)
	case TurnInterrupted:
		t.open, t.final, t.last = false, nil, nil
		t.set(nil)
	case TurnComplete:
		final, last, phased := t.final, t.last, t.phased
		turnID, root := t.turnID, t.rootID
		if ev.TurnID != "" {
			turnID = ev.TurnID
		}
		if ev.RootTurnID != "" {
			root = ev.RootTurnID
		}
		t.open, t.final, t.last = false, nil, nil
		if t.subagent || (root != "" && root != turnID) {
			t.set(nil)
			return
		}
		var c *Candidate
		switch {
		case final != nil:
			c = t.codexCand(final, turnID)
		case last != nil && !phased:
			c = t.codexCand(last, turnID)
		}
		if (c == nil || strings.TrimSpace(c.Body) == "") && !ev.Null && strings.TrimSpace(ev.Text) != "" {
			c = &Candidate{Harness: Codex, Session: t.codexSession, Turn: turnID, Source: CandLastAgentMessage,
				Spans: []Span{sp}, Body: ev.Text}
			c.seal()
		}
		if c != nil && strings.TrimSpace(c.Body) == "" {
			c = nil
		}
		t.set(c)
	}
}

func (t *HandoffTracker) codexCand(m *codexMsg, turnID string) *Candidate {
	c := &Candidate{Harness: Codex, Session: t.codexSession, Message: m.id, Turn: turnID, Source: CandMessage,
		Spans: []Span{m.span}, Body: strings.Join(m.texts, HandoffSeparator)}
	c.seal()
	return c
}

// seal sets Hash and ID.
func (c *Candidate) seal() {
	sum := sha256.Sum256([]byte(c.Body))
	c.Hash = hex.EncodeToString(sum[:])
	var b strings.Builder
	for _, s := range []string{c.Harness, c.Session, c.Message, c.Request, c.Line, c.Turn, c.Source, c.Hash} {
		b.WriteString(s)
		b.WriteByte(0)
	}
	for _, sp := range c.Spans {
		b.WriteString(strconv.FormatInt(sp.Off, 10))
		b.WriteByte(':')
		b.WriteString(strconv.Itoa(sp.N))
		b.WriteByte(0)
	}
	id := sha256.Sum256([]byte(b.String()))
	c.ID = hex.EncodeToString(id[:8])
}

// Why a candidate cannot be resolved.
var (
	// ErrSourceReplaced: the transcript is not the file the candidate was
	// read from, or it is shorter than it was then or than the candidate's
	// lines.
	ErrSourceReplaced = errors.New("the transcript was replaced or truncated")
	// ErrSourceChanged: the candidate's lines no longer say what they said.
	ErrSourceChanged = errors.New("the reply's lines changed")
	// ErrSourceTooLarge: the reply is larger than the cap.
	ErrSourceTooLarge = errors.New("the reply is too large")
	// ErrNotLatest: a prompt, another message or turn or an interruption
	// was written after the candidate: it is not the latest completed reply
	// any more.
	ErrNotLatest = errors.New("the reply is not the latest any more")
)

// maxSince bounds the bytes StillLatest reads: more written since the
// candidate was seen is a newer turn.
const maxSince = 64 << 20

// openSource opens the transcript at path, checked to be the file fi (nil:
// not checked) and no shorter than it was then.
func openSource(path string, fi fs.FileInfo) (*os.File, fs.FileInfo, error) {
	f, got, err := jsonl.Open(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil, fmt.Errorf("%w: %v", ErrSourceReplaced, err)
		}
		return nil, nil, err
	}
	if fi != nil && (!os.SameFile(fi, got) || got.Size() < fi.Size()) {
		f.Close()
		return nil, nil, ErrSourceReplaced
	}
	return f, got, nil
}

// StillLatest checks candidate c is still its transcript's latest completed
// reply: the complete lines written to path from from on (a line start:
// where the tracker that found c had read to) are read with the tracker's
// own rules, the tracker starting at c. fi is the file c was read from.
// ErrNotLatest when a prompt, another message or turn or an interruption
// came since; an incomplete last line is not read yet.
func StillLatest(path string, fi fs.FileInfo, c *Candidate, from int64) error {
	f, got, err := openSource(path, fi)
	if err != nil {
		return err
	}
	defer f.Close()
	size := got.Size()
	switch {
	case from < 0 || from > size:
		return ErrSourceReplaced
	case size-from > maxSince:
		return fmt.Errorf("%w: %d bytes were written since", ErrNotLatest, size-from)
	}
	t := resumeAt(c)
	if t == nil {
		return ErrNotLatest
	}
	if _, err := jsonl.Scan(f, from, size, 64<<10, t.Line, nil); err != nil {
		return err
	}
	if t.cand == nil || t.cand.ID != c.ID {
		return ErrNotLatest
	}
	return nil
}

// resumeAt is a tracker in the state it was in once candidate c completed
// (nil: not a harness's): every line that ends c ends it here too.
func resumeAt(c *Candidate) *HandoffTracker {
	t := NewHandoffTracker(c.Harness)
	if t == nil {
		return nil
	}
	t.cand = c
	if t.harness == Claude {
		// The message closed last: a line of it again reopens it (and
		// the reply is another then).
		t.session, t.prev = c.Session, &claudeMsg{id: c.Message, session: c.Session}
	} else {
		t.codexSession = c.Session
	}
	return t
}

// Resolve reads candidate c's text again from the transcript at path: fi is
// the file it was read from (nil: not checked; it may not have shrunk since),
// max the most bytes the text
// may have. The lines are parsed with TurnEvents and joined as the tracker
// joined them; the result must hash to c.Hash.
func Resolve(path string, fi fs.FileInfo, c *Candidate, max int) (string, error) {
	f, got, err := openSource(path, fi)
	if err != nil {
		return "", err
	}
	defer f.Close()
	total := 0
	for _, sp := range c.Spans {
		if sp.N <= 0 || sp.Off < 0 || sp.End() > got.Size() {
			return "", ErrSourceReplaced
		}
		total += sp.N
	}
	// The JSON lines hold at least the text (escapes only add): a cap on
	// them bounds what is read, generously.
	if max > 0 && total > 8*max+64<<10 {
		return "", ErrSourceTooLarge
	}
	var texts []string
	for _, sp := range c.Spans {
		b := make([]byte, sp.N)
		if _, err := f.ReadAt(b, sp.Off); err != nil && !errors.Is(err, io.EOF) {
			return "", err
		}
		if bytes.ContainsAny(b, "\n") {
			return "", ErrSourceChanged
		}
		ok := false
		for _, ev := range TurnEvents(c.Harness, b) {
			switch {
			case c.Source == CandLastAgentMessage && ev.Kind == TurnComplete && !ev.Null:
				texts, ok = append(texts, ev.Text), true
			case c.Source == CandMessage && ev.Kind == TurnAssistant && c.Harness == Claude && ev.MsgID == c.Message && len(ev.Texts) > 0:
				texts, ok = append(texts, ev.Texts...), true
			case c.Source == CandMessage && ev.Kind == TurnAssistant && c.Harness == Codex && ev.ItemID == c.Message:
				texts, ok = append(texts, ev.Texts...), true
			}
		}
		if !ok {
			return "", ErrSourceChanged
		}
	}
	body := strings.Join(texts, HandoffSeparator)
	if max > 0 && len(body) > max {
		return "", ErrSourceTooLarge
	}
	sum := sha256.Sum256([]byte(body))
	if hex.EncodeToString(sum[:]) != c.Hash {
		return "", ErrSourceChanged
	}
	return body, nil
}
