package notify

// #14: tap-to-answer. While replies are on, a notification about an ask or
// a follow-up is followed by a card per question: its text, its options
// (each one's description, a preview cut short) and a button for each, plus
// Other… (a reply prompt for a typed answer), Done for a multi-select and
// Cancel for an ask. A follow-up's yes_no and choice questions are buttons,
// an open one a reply prompt. A secret ask gets one card that says to answer
// it in the game: no question, no option, no button.
//
// The answers are collected across the cards and handed to the hub at once
// (Options.Answer: worker.answer_ask, worker.answer_followup, the game's
// path and lane), since an ask is answered whole. A button's data is a
// session's short token and an action (resolved here, by the card it is
// on); the tool_use_id or turn_id never leaves the bridge. Every tap is
// answered at once (its spinner stops), then the cards are edited: the
// choice so far, then the answer, Cancelled, or Answered in the game once
// the ask or follow-up left the worker some other way. The state is the
// replier goroutine's and in memory, bounded: after a restart an old
// card's tap is answered "no longer open" and its buttons taken away. Each
// tap and each answer is audited by indices and lengths, never a text.
//
// #88: a worker blocked on a permission or folder-trust menu its screen
// shows (Worker.Menu) gets one card too, with a button per choice and no
// Cancel (each such menu has its own No or Quit choice; Esc differs by
// agent). The menu is read off the screen a moment after the worker turns
// blocked, mostly after its notification went: the card opens once both
// are there for the same blocked spell, once per menu (openMenu). A tap
// answers through worker.answer's path with the menu's hash, so a menu no
// longer on the screen is never answered. The card shows what the menu's
// kind asks, in a fixed line, and its choices' labels, as the bridge
// scrubbed them; never the screen's question line.
//
// #106: and what the menu is about (Menu.About: the command, the file, the
// folder, as the bridge redacted and bounded them). A card is one
// operation's (Menu.Op, its native call Menu.Native): it follows the
// menu's redraws and new hashes, a new keyboard with each new hash, stays
// while its worker stays blocked in its spell with no menu read, and ends
// replaced or no longer waited on, never "answered in the game". New cards
// draw on the send budget (limits.go).

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"
)

// Bounds of the cards.
const (
	// MaxCards is the most questions that get cards: an ask has at most 4;
	// a follow-up of more gets its notification only.
	MaxCards = 4
	// MaxSessions is how many asks and follow-ups keep their cards open;
	// past it the oldest is forgotten (a tap on it: no longer open).
	MaxSessions = 32
	// TapPerWorker taps on one worker's cards, and TapTotal in all, within
	// ReplyWindow; more are answered "too many".
	TapPerWorker = 30
	TapTotal     = 60
	// MaxAskOther bounds an ask's typed answer in bytes (the hub's
	// proto.MaxAskOther); MaxFollowupText a follow-up's (proto.MaxFollowupAnswer).
	MaxAskOther     = 4 << 10
	MaxFollowupText = 8000
	// CardTextMax bounds a card's text, in UTF-16 units (Telegram counts
	// those; 4096 at most).
	CardTextMax = 4000
	// What a card keeps of each text, in runes.
	cardQuestionMax = 800
	cardLabelMax    = 120
	cardDescMax     = 200
	cardPreviewMax  = 120
	cardContextMax  = 600
	cardRecMax      = 300
	cardTailMax     = 1000
	buttonMax       = 40
	placeholderMax  = 60
	// callRetryMax is the longest rate-limit wait a card's call waits, once.
	callRetryMax = 10 * time.Second
)

// What the cards say.
const (
	CardInGameAsk   = "Answer this one in the game."
	CardSecretText  = "Its answer is secret. " + CardInGameAsk
	CardInGameText  = "Answered in the game."
	CardClosedText  = "No longer open: it was answered in the game, or the agent moved on."
	CardOffText     = "Replies are off: answer in the game."
	CardCancelText  = "✗ Cancelled."
	CardWaitText    = "Waiting for your other answers."
	CardSendingText = "Sending…"
	cardMultiText   = "Pick one or more, then tap Done."
	// #88: a menu's.
	CardUnresolvedText = "It still waits on its menu: look at it in the game."
	// #106: a menu's whose operation the bridge could not read, one whose
	// approving choices have no button, and its ends but an answer.
	CardMenuAboutText = "What it is about could not be read here: see it in the game."
	CardWithheldText  = "Part of it is off its screen, so approving it has no button here: approve it in its terminal in the game."
	CardReplacedText  = "Replaced: it asks about something else now."
	CardGoneText      = "No longer waiting: it was answered elsewhere, or the agent moved on."
	CardRetryText     = "Not sent: it changed or could not be checked as you tapped. Check it and tap again."
	CardNextText      = "Its next card follows within a minute (too many messages lately)."
)

// #88: a menu card's head, and what it asks (fixed: never the screen's
// question line, which can be a command's).
var (
	menuHeads = map[string]string{"permission": "Permission", "trust": "Trust folder"}
	menuAsks  = map[string]string{"permission": "It asks for your permission.", "trust": "It asks whether to trust a folder."}
)

// What a tap is answered (at most 200 characters).
const (
	tapClosedText  = "No longer open"
	tapOffText     = "Replies are off: answer in the game"
	tapLimitedText = "Too many taps: wait a little"
	tapPickText    = "Pick at least one first"
	tapSendingText = "Sending…"
	tapBusyText    = "Already sent"
	tapTypeText    = "Type your answer as a reply"
	tapChangedText = "It changed: check the card and tap again" // #106
)

// Answers to a typed answer that is not taken (the prompt stays open).
const (
	typedSentText   = "Not taken: the answer was already sent."
	typedLineText   = "Not taken: this answer must be one line of text. Reply to the prompt again."
	typedLongText   = "Not taken: too long. Reply to the prompt again, shorter."
	typedBlankText  = "Not taken: the answer is empty. Reply to the prompt again."
	promptPlaceText = "Your answer"
)

// Kinds of a session.
const (
	kindAsk      = "ask"
	kindFollowup = "followup"
	kindMenu     = "menu" // #88
)

// Actions of a button (its data: token ":" action).
const (
	actOption = 'o' // o<n>: option n (1-based)
	actText   = 'x' // Other… / Answer…: a reply prompt
	actDone   = 'd' // a multi-select's Done
	actCancel = 'c' // an ask's Cancel
)

// Answer is what the recipient answered (#14), for the hub to answer the
// worker's ask or follow-up with (Options.Answer).
type Answer struct {
	WorkerID string
	// An ask's: its tool_use_id, and an answer for every question, or
	// Cancel.
	ToolUseID string
	Ask       []AskAnswer
	Cancel    bool
	// A follow-up's: its turn, and an answer for every question.
	TurnID   string
	Followup []FollowupAnswer
	// A screen menu's (#88): its hash, and the choice's number on the
	// screen; (#106) the native call its card was for ("": not known).
	Hash   string
	Choice int
	Native string
}

// AskAnswer answers one question of an ask: option numbers (1-based) and/or
// a typed answer.
type AskAnswer struct {
	Question int
	Choices  []int
	Other    *string
}

// FollowupAnswer answers one follow-up question: "Yes" or "No", an option,
// or the typed text.
type FollowupAnswer struct {
	ID, Value string
}

// questionKey names what a worker asks now: its ask's tool_use_id, its
// follow-up's turn or (#88) its screen menu's operation ("": none).
func questionKey(w Worker) string {
	switch {
	case validAsk(w.Ask):
		return "a|" + w.Ask.ToolUseID
	case validFollowup(w.Followup):
		return "f|" + w.Followup.TurnID
	case validMenu(w):
		return "m|" + menuID(w.Menu)
	}
	return ""
}

// menuID names a menu's operation through redraws (#106): its Op, else its
// hash.
func menuID(m *Menu) string {
	if m.Op != "" {
		return m.Op
	}
	return m.Hash
}

// cardID names what one menu card is for: its operation, and its native
// call when known.
func cardID(m *Menu) string { return menuID(m) + "|" + m.Native }

// menuSeen is a worker's screen menu as the loop saw it (#88): what its
// card shows, and the blocked spell (status_since) it is of; (H3D-1) the
// episode it is ("": its blocked spell's, a bare block's in the broader
// mode).
type menuSeen struct {
	menu  *Menu
	name  string
	since int64
	ep    string
}

// menuOf is what an observation's menu card would show (nil: it asks
// something else, or no menu).
func menuOf(o Observation) *menuSeen {
	w := o.Worker
	if validAsk(w.Ask) || validFollowup(w.Followup) || !validMenu(w) {
		return nil
	}
	return &menuSeen{menu: w.Menu, name: o.Name, since: w.StatusSince}
}

// blockedSpell is the blocked spell an observation's worker is in (its
// status_since; 0: not blocked, or its floor asleep).
func blockedSpell(o Observation) int64 {
	if w := o.Worker; !o.Gone && w.Status == "blocked" && !w.Asleep {
		return w.StatusSince
	}
	return 0
}

// maxCarded is how many menu operations of one blocked spell are kept as
// carded (the oldest forgotten): a bound on memory, not on cards (#106:
// the send budget bounds those).
const maxCarded = 64

// spell is a worker's blocked spell whose needs-you notification went
// (#88): its status_since, and the operations of its menus that got a card
// (cardID). An operation gets one card while the spell lasts, though the
// session is forgotten (an unresolved answer) or the screen read fails a
// while (the menu gone, then back). #106: ops counts the operations its
// menus asked about, for the diagnostics.
type spell struct {
	since  int64
	carded []string
	ops    []string
}

// card marks id as carded.
func (sp *spell) card(id string) {
	if !slices.Contains(sp.carded, id) {
		sp.carded = append(sp.carded, id)
	}
	if len(sp.carded) > maxCarded {
		sp.carded = sp.carded[1:]
	}
}

// saw counts op among the spell's operations.
func (sp *spell) saw(op string) {
	if !slices.Contains(sp.ops, op) && len(sp.ops) < maxCarded {
		sp.ops = append(sp.ops, op)
	}
}

// session is one ask's or follow-up's cards.
type session struct {
	tok          string
	worker, name string
	kind         string
	key          string // questionKey's
	ask          *Ask
	fu           *Followup
	menu         *Menu // #88
	secret       bool
	qs           []*qstate
	sending      bool
	cancel       bool // the answer sent is a Cancel
	done         bool // the hub took the answer
	// #106, a menu's: its blocked spell, the native call it is for (the
	// first one known), how many times its hash changed under it, and a
	// note its live card shows (an answer not sent).
	since   int64
	native  string
	redraws int
	note    string
}

// qstate is one question's card and its answer so far.
type qstate struct {
	card   Ref
	shown  Card
	dirty  bool
	picked map[int]bool // option indexes (from 0)
	text   *string      // the typed answer
	// answered: this question's answer is complete.
	answered bool
}

// at names a question of a session.
type at struct {
	s *session
	q int
}

// buttons is the cards' state: the replier goroutine's alone.
type buttons struct {
	sessions []*session // oldest first
	cards    map[Ref]at
	prompts  map[Ref]at
	// cur is what each worker asks now (questionKey), as the loop saw it.
	cur map[string]string
	// #88: each worker's screen menu, as the loop saw it, and the blocked
	// spell its last needs-you notification went for. #106: and the
	// blocked spell each worker is in (its status_since).
	menus      map[string]*menuSeen
	rang       map[string]*spell
	blocked    map[string]int64
	total      window
	workerTaps map[string]*window
	// #106: each worker's card set the send budget parked.
	parked map[string]*parked
}

func newButtons() buttons {
	return buttons{cards: map[Ref]at{}, prompts: map[Ref]at{}, cur: map[string]string{},
		menus: map[string]*menuSeen{}, rang: map[string]*spell{}, blocked: map[string]int64{},
		total: window{n: TapTotal, per: ReplyWindow}, workerTaps: map[string]*window{}, parked: map[string]*parked{}}
}

// live reports whether ss is still what its worker asks, as the loop saw
// it: its key, or (#106) a menu's blocked spell going on with no menu read
// now (a failed read, a redraw).
func (b *buttons) live(ss *session) bool {
	cur := b.cur[ss.worker]
	return cur == ss.key || (ss.kind == kindMenu && cur == "" && b.blocked[ss.worker] == ss.since)
}

func (b *buttons) of(worker string) *session {
	for _, s := range b.sessions {
		if s.worker == worker {
			return s
		}
	}
	return nil
}

func (b *buttons) forget(s *session) {
	for i, x := range b.sessions {
		if x == s {
			b.sessions = append(b.sessions[:i], b.sessions[i+1:]...)
			break
		}
	}
	for _, q := range s.qs {
		delete(b.cards, q.card)
	}
	for r, a := range b.prompts {
		if a.s == s {
			delete(b.prompts, r)
		}
	}
}

// tapAllowed counts a tap on worker's cards against the windows.
func (b *buttons) tapAllowed(worker string, now time.Time) bool {
	w := b.workerTaps[worker]
	if w == nil {
		if len(b.workerTaps) >= 256 {
			for id, x := range b.workerTaps {
				if n := len(x.at); n == 0 || now.Sub(x.at[n-1]) >= ReplyWindow {
					delete(b.workerTaps, id)
				}
			}
		}
		w = &window{n: TapPerWorker, per: ReplyWindow}
		b.workerTaps[worker] = w
	}
	return w.allow(now) && b.total.allow(now)
}

// tapAudit is a notify.tap row's args: the worker, which question, which
// button, how it went; never a text.
type tapAudit struct {
	ID       string `json:"id,omitempty"`
	Kind     string `json:"kind,omitempty"`
	Question *int   `json:"question,omitempty"`
	Action   string `json:"action,omitempty"`
	Option   int    `json:"option,omitempty"`
	Outcome  string `json:"outcome"`
}

// answerAudit is a notify.answer row's args: the worker, what kind, how
// many questions and choices, the typed answers' lengths; never a text.
type answerAudit struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`
	Questions  int    `json:"questions"`
	Choices    int    `json:"choices,omitempty"`
	TypedBytes int    `json:"typed_bytes,omitempty"`
	TypedRunes int    `json:"typed_runes,omitempty"`
	Cancel     bool   `json:"cancel,omitempty"`
	Outcome    string `json:"outcome"`
}

// Outcomes of a tap.
const (
	tapOK      = "ok"
	tapOff     = "off"
	tapUnknown = "unknown"
	tapClosed  = "closed"
	tapLimited = "rate_limited"
	tapBusy    = "busy"
	tapEmpty   = "empty"
	tapChanged = "changed" // #106: a menu card's old keyboard
)

// job runs fn on the replier goroutine, after what is queued already.
func (s *Service) job(fn func(context.Context)) {
	s.rp.mu.Lock()
	s.rp.jobs = append(s.rp.jobs, fn)
	s.rp.mu.Unlock()
	s.poke()
}

// tapped is the channel's Hooks.Tap: it never blocks. Past ReplyQueue
// waiting the tap is refused (false): the channel answers it.
func (s *Service) tapped(t Tap) bool {
	s.rp.mu.Lock()
	full := s.rp.taps >= ReplyQueue
	if !full {
		s.rp.taps++
		s.rp.jobs = append(s.rp.jobs, func(ctx context.Context) {
			s.rp.mu.Lock()
			s.rp.taps--
			s.rp.mu.Unlock()
			s.tap(ctx, t)
		})
	}
	s.rp.mu.Unlock()
	if full {
		s.opts.Log.Warn("notifications: a tap was refused (the replier is behind)")
		return false
	}
	s.poke()
	return true
}

// seen takes what worker id asks now (the loop's, on a change) and the
// blocked spell it is in (0: none): the cards of what it asked before are
// edited to answered in the game, unless their answer is on its way. #88:
// a menu's card opens if its notification went. #106: a menu's card stays
// while its worker stays blocked in its spell with no menu read, and
// follows its operation's redraws; it ends replaced (another question in
// the spell) or no longer waited on, never "answered in the game".
func (s *Service) seen(ctx context.Context, id, key string, menu *menuSeen, blocked int64) {
	if key == "" {
		delete(s.bt.cur, id)
	} else {
		s.bt.cur[id] = key
	}
	if menu == nil {
		delete(s.bt.menus, id)
	} else {
		s.bt.menus[id] = menu
		if sp := s.bt.rang[id]; sp != nil && sp.since == menu.since {
			sp.saw(menuID(menu.menu))
		}
	}
	if blocked == 0 {
		delete(s.bt.blocked, id)
	} else {
		s.bt.blocked[id] = blocked
	}
	if ss := s.bt.of(id); ss != nil && !ss.sending {
		switch {
		case ss.key == key && ss.kind == kindMenu:
			s.moved(ctx, ss, menu)
		case ss.key == key, s.bt.live(ss):
		case ss.kind == kindMenu:
			// What it asks now opens its own card first (ending this one as
			// replaced), unless it gets none now: then this one ends.
			s.openMenu(ctx, id, s.questionsOnly())
			if s.bt.of(id) == ss {
				s.endMenu(ctx, ss, "")
			}
			return
		default:
			s.closeCards(ctx, ss, CardInGameText)
		}
	}
	s.openMenu(ctx, id, s.questionsOnly())
}

// moved takes a menu's new look of the same operation (#106): its hash,
// labels or what it is about redrawn. Its card follows (re-rendered in the
// batch's flush) with a new keyboard whenever its hash or native call
// changed, so a tap answers only the hash its keyboard was shown with (one
// on an old keyboard: tapChangedText), even when the text reads the same
// (a change past what the card shows); a native call other than the one
// it was for is another operation: replaced.
func (s *Service) moved(ctx context.Context, ss *session, m *menuSeen) {
	if m == nil {
		return
	}
	if ss.native != "" && m.menu.Native != "" && m.menu.Native != ss.native {
		s.endMenu(ctx, ss, menuReplaced)
		return
	}
	if ss.native == "" && m.menu.Native != "" {
		ss.native = m.menu.Native
		if sp := s.bt.rang[ss.worker]; sp != nil && sp.since == ss.since {
			sp.card(cardID(m.menu))
		}
	}
	if m.menu.Hash != ss.menu.Hash {
		ss.redraws++
	}
	if m.menu.Hash != ss.menu.Hash || m.menu.Native != ss.menu.Native || !slices.Equal(m.menu.About, ss.menu.About) ||
		!slices.Equal(m.menu.Choices, ss.menu.Choices) {
		ss.tok = newToken()
	}
	ss.menu, ss.name = m.menu, m.name
	ss.qs[0].dirty = true
}

// Ends of a menu's card (#106; the notify.menu row's outcome).
const (
	menuAnswered   = "answered"
	menuUnresolved = "unresolved"
	menuReplaced   = "replaced"
	menuGone       = "gone"
	menuOff        = "replies_off"
	menuFailed     = "failed"
)

// menuAudit is a notify.menu row's args (#106): which worker, where its
// identity was from, how often its hash changed under one operation, how
// many operations its blocked spell asked about, how its card ended; never
// a text, a command or a hash.
type menuAudit struct {
	ID       string `json:"id"`
	Source   string `json:"source,omitempty"`
	Partial  bool   `json:"partial,omitempty"`
	Redraws  int    `json:"redraws,omitempty"`
	SpellOps int    `json:"spell_ops,omitempty"`
	Outcome  string `json:"outcome"`
}

// endMenu closes a menu's card with its end (""): replaced when its worker
// asks something else in the same blocked spell, else no longer waited on;
// and audits it.
func (s *Service) endMenu(ctx context.Context, ss *session, outcome string) {
	if outcome == "" {
		outcome = menuGone
		if s.bt.cur[ss.worker] != "" && s.bt.blocked[ss.worker] == ss.since {
			outcome = menuReplaced
		}
	}
	status := map[string]string{menuReplaced: CardReplacedText, menuGone: CardGoneText, menuOff: CardOffText}[outcome]
	if outcome == menuReplaced && s.bt.parked[ss.worker] != nil {
		status += "\n" + CardNextText
	}
	s.auditMenu(ctx, ss, outcome)
	s.closeCards(ctx, ss, status)
}

// releaseCards opens the parked card sets whose slot came (#106): a menu's
// as its worker's menu is now, any other's if it still asks it; else they
// are dropped.
func (s *Service) releaseCards(ctx context.Context) {
	now := s.now()
	for id, p := range s.bt.parked {
		if p.at.After(now) {
			continue
		}
		delete(s.bt.parked, id)
		var sent bool
		ok, back := s.rings(p.alert) // H3D-1: the gates and the form as they are now
		switch {
		case !ok:
		case p.alert.Menu != nil:
			sent = s.openMenu(ctx, id, p.alert.Ring)
		default:
			sent = s.openCards(ctx, p.alert)
		}
		if again := s.bt.parked[id]; again != nil {
			again.coalesced += p.coalesced // parked again: still the same wait
			continue
		}
		row := limitAudit{ID: id, Kind: "cards", Cause: p.cause, Coalesced: p.coalesced, Outcome: "dropped"}
		switch {
		case sent:
			row.Outcome = "sent"
		case back:
			row.Outcome = "returned"
		}
		s.audit(ctx, AuditLimit, row, nil)
	}
}

func (s *Service) auditMenu(ctx context.Context, ss *session, outcome string) {
	row := menuAudit{ID: ss.worker, Source: ss.menu.Source, Partial: slices.ContainsFunc(ss.menu.Choices, func(c MenuChoice) bool { return c.Withheld }),
		Redraws: ss.redraws, Outcome: outcome}
	if sp := s.bt.rang[ss.worker]; sp != nil && sp.since == ss.since {
		row.SpellOps = len(sp.ops)
	}
	var err error
	if outcome == menuFailed {
		err = errors.New(outcome)
	}
	s.audit(ctx, AuditMenu, row, err)
}

// rang takes a needs-you notification that went without cards of its own
// (#88): the worker's menu of that blocked spell gets its card, now or
// once the screen is read. H3D-1: a Ring one's card is the notification
// (it rings); a menu episode's seen again in another spell gets its card
// back silent.
func (s *Service) rang(ctx context.Context, a Alert) {
	if _, ok := s.bt.rang[a.WorkerID]; !ok && len(s.bt.rang) >= 256 {
		for id := range s.bt.rang {
			if _, asks := s.bt.cur[id]; !asks {
				delete(s.bt.rang, id)
			}
		}
	}
	if sp := s.bt.rang[a.WorkerID]; sp == nil || sp.since != a.Since {
		s.bt.rang[a.WorkerID] = &spell{since: a.Since}
	}
	s.openMenu(ctx, a.WorkerID, a.Ring)
}

// openMenu opens worker id's menu card (#88) when the loop saw its menu and
// the notification of the same blocked spell went, once an operation
// (openCards: replies on, not open already). H3D-1: ring: the card is the
// notification (Questions only): it rings.
func (s *Service) openMenu(ctx context.Context, id string, ring bool) bool {
	m := s.bt.menus[id]
	sp := s.bt.rang[id]
	if sp == nil || m == nil || sp.since != m.since || slices.Contains(sp.carded, cardID(m.menu)) {
		return false
	}
	sp.saw(menuID(m.menu))
	a := Alert{WorkerID: id, Name: m.name, Kind: KindNeedsYou, Reason: ReasonNeedsYou, About: aboutMenu, Since: m.since, Menu: m.menu,
		Key: m.ep, Asks: m.ep != "", Question: ring, Ring: ring}
	if !s.openCards(ctx, a) {
		return false
	}
	sp.card(cardID(m.menu))
	return true
}

// repliesOff edits every open card to say replies are off.
func (s *Service) repliesOff(ctx context.Context) {
	for len(s.bt.sessions) > 0 {
		if ss := s.bt.sessions[0]; ss.kind == kindMenu {
			s.endMenu(ctx, ss, menuOff)
			continue
		}
		s.closeCards(ctx, s.bt.sessions[0], CardOffText)
	}
}

// alertKey is the questionKey of what an alert is about ("": no cards).
func alertKey(a Alert) string {
	switch {
	case a.Ask != nil:
		return "a|" + a.Ask.ToolUseID
	case a.Followup != nil:
		return "f|" + a.Followup.TurnID
	case a.Menu != nil:
		return "m|" + menuID(a.Menu)
	}
	return ""
}

func newToken() string {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		return strconv.FormatInt(time.Now().UnixNano()&0xffffffff, 16)
	}
	return hex.EncodeToString(b)
}

// carded is how many cards of what alert a asks are open now (H3D-1: its
// notify.send row's): its ask's or follow-up's, else its blocked spell's
// menu's.
func (s *Service) carded(a Alert) int {
	ss := s.bt.of(a.WorkerID)
	switch {
	case ss == nil:
		return 0
	case a.Ask != nil || a.Followup != nil:
		if ss.key == alertKey(a) {
			return len(ss.qs)
		}
	case ss.kind == kindMenu && ss.since == a.Since:
		return len(ss.qs)
	}
	return 0
}

// openCards sends an alert's cards (after its notification), while
// replies are on and the worker still asks it; true: they went. H3D-1: a
// Ring alert's cards are the notification (Questions only): the first
// rings, unless Quiet, and they write its notify.send row. None goes once
// notifications, their needs-you event or the channel are off, checked
// again before each card (after its pace).
func (s *Service) openCards(ctx context.Context, a Alert) bool {
	key := alertKey(a)
	if on, _ := s.listening(); !on || key == "" || s.bt.cur[a.WorkerID] != key || !s.allowed(a.Kind) {
		return false
	}
	old := s.bt.of(a.WorkerID)
	if old != nil && old.key == key {
		return false
	}
	ss := &session{tok: newToken(), worker: a.WorkerID, name: a.Name, key: key}
	n := 0
	switch {
	case a.Ask != nil:
		ss.kind, ss.ask, ss.secret, n = kindAsk, a.Ask, Worker{Ask: a.Ask}.Secret(), len(a.Ask.Questions)
		if ss.secret {
			n = 1
		}
	case a.Menu != nil:
		ss.kind, ss.menu, ss.since, ss.native, n = kindMenu, a.Menu, a.Since, a.Menu.Native, 1
	default:
		ss.kind, ss.fu, n = kindFollowup, a.Followup, len(a.Followup.Questions)
	}
	if n == 0 || n > MaxCards {
		return false
	}
	// #106: the set goes whole within the budget, or waits whole (parked,
	// the latest of the worker's wins); the old one ends only when it goes.
	if ok, at, cause := s.lim.admitCards(a.WorkerID, n); !ok {
		park(s.bt.parked, a, at, cause)
		s.opts.Log.Debug("notifications: a worker's cards wait for their budget", "worker", a.WorkerID, "cause", cause)
		return false
	}
	if old != nil {
		if old.kind == kindMenu {
			s.endMenu(ctx, old, "")
		} else {
			s.closeCards(ctx, old, CardInGameText)
		}
	}
	for range n {
		ss.qs = append(ss.qs, &qstate{picked: map[int]bool{}})
	}
	row := sendAudit{ID: a.WorkerID, Kind: string(a.Kind), Reason: a.Reason, About: a.About, Via: viaCards}
	for i, q := range ss.qs {
		c := s.render(ss, i, "")
		c.Quiet = !a.Ring || i > 0 || s.quiet() // else the notification rang already
		var ref Ref
		off := false
		err := s.call(ctx, func(ctx context.Context) error {
			if off = !s.allowed(a.Kind); off {
				return nil
			}
			var err error
			ref, err = s.opts.Channel.SendCard(ctx, c)
			return err
		})
		if off {
			// H3D-1: switched off while it waited for its pace: the rest
			// of the set is not sent.
			s.lim.dropCards(a.WorkerID, n-i)
			ss.qs = ss.qs[:i]
			if i > 0 {
				s.closeCards(ctx, ss, CardInGameAsk)
			}
			return false
		}
		s.lim.sentCards(a.WorkerID, 1) // #106: its slot counts from now, sent or failed
		if err != nil || !ref.Valid() {
			s.lim.dropCards(a.WorkerID, n-i-1)
			s.opts.Log.Warn("notifications: a question's card was not delivered", "worker", a.WorkerID, "code", CodeOf(err))
			ss.qs = ss.qs[:i]
			if ss.kind == kindMenu {
				s.auditMenu(ctx, ss, menuFailed)
			}
			if a.Ring {
				row.Cards, row.Code = i, CodeOf(err)
				if row.Code == "" {
					row.Code = CodeFailed
				}
				s.audit(ctx, AuditSend, row, errors.New(row.Code))
			}
			s.closeCards(ctx, ss, CardInGameAsk)
			return false
		}
		q.card, q.shown = ref, c
		s.bt.cards[ref] = at{ss, i}
		// A text reply to a card is about its worker too.
		s.remember(ctx, ref, a.WorkerID)
	}
	s.bt.sessions = append(s.bt.sessions, ss)
	for len(s.bt.sessions) > MaxSessions {
		s.bt.forget(s.bt.sessions[0])
	}
	if a.Ring {
		row.Cards = n
		s.audit(ctx, AuditSend, row, nil)
	}
	return true
}

// closeCards edits a session's cards to their end, status, and forgets it.
func (s *Service) closeCards(ctx context.Context, ss *session, status string) {
	s.bt.forget(ss)
	for i := range ss.qs {
		s.edit(ctx, ss, i, s.render(ss, i, status))
	}
}

// flush edits the cards whose state changed since they were shown (the
// taps of one batch make one edit).
func (s *Service) flush(ctx context.Context) {
	for _, ss := range s.bt.sessions {
		for i, q := range ss.qs {
			if q.dirty {
				q.dirty = false
				s.edit(ctx, ss, i, s.render(ss, i, ""))
			}
		}
	}
}

// edit shows c on question i's card, unless it shows that already (a
// failed edit is tried again with the next one).
func (s *Service) edit(ctx context.Context, ss *session, i int, c Card) {
	q := ss.qs[i]
	if !q.card.Valid() || cardEqual(q.shown, c) {
		return
	}
	if err := s.call(ctx, func(ctx context.Context) error { return s.opts.Channel.EditCard(ctx, q.card, c) }); err != nil {
		s.opts.Log.Warn("notifications: a card was not edited", "worker", ss.worker, "code", CodeOf(err))
		return
	}
	q.shown = c
}

func cardEqual(a, b Card) bool {
	if a.Text != b.Text || len(a.Buttons) != len(b.Buttons) {
		return false
	}
	for i := range a.Buttons {
		if len(a.Buttons[i]) != len(b.Buttons[i]) {
			return false
		}
		for j := range a.Buttons[i] {
			if a.Buttons[i][j] != b.Buttons[i][j] {
				return false
			}
		}
	}
	return true
}

// call is one call to the channel, bounded and (#106) paced; a rate
// limit's wait (up to callRetryMax) is waited once, and pauses every
// paced call meanwhile.
func (s *Service) call(ctx context.Context, fn func(context.Context) error) error {
	for try := 0; ; try++ {
		if err := s.lim.wait(ctx); err != nil {
			return err
		}
		cctx, cancel := context.WithTimeout(ctx, SendTimeout)
		err := fn(cctx)
		cancel()
		s.lim.pause(retryAfter(err))
		var se *SendError
		if err == nil || try > 0 || !errors.As(err, &se) || se.Code != CodeRateLimited || se.RetryAfter > callRetryMax {
			return err
		}
		if Sleep(ctx, s.opts.Clock, max(se.RetryAfter, time.Second)) != nil {
			return err
		}
	}
}

// answerTap stops a tap's spinner, with text if any (never rate limited:
// every tap is answered).
func (s *Service) answerTap(ctx context.Context, id, text string) {
	actx, cancel := context.WithTimeout(ctx, SendTimeout)
	defer cancel()
	if err := s.opts.Channel.AnswerTap(actx, id, text); err != nil {
		s.opts.Log.Warn("notifications: a tap was not answered", "code", CodeOf(err))
	}
}

// parseData is a button's data: the session's token and the action.
func parseData(d string) (tok string, act byte, n int, ok bool) {
	tok, a, found := strings.Cut(d, ":")
	if !found || tok == "" || a == "" {
		return "", 0, 0, false
	}
	act = a[0]
	switch act {
	case actOption:
		v, err := strconv.Atoi(a[1:])
		if err != nil || v < 1 {
			return "", 0, 0, false
		}
		return tok, act, v, true
	case actText, actDone, actCancel:
		return tok, act, 0, len(a) == 1
	}
	return "", 0, 0, false
}

func data(tok string, act byte, n int) string {
	if act == actOption {
		return tok + ":" + string(act) + strconv.Itoa(n)
	}
	return tok + ":" + string(act)
}

var actNames = map[byte]string{actOption: "option", actText: "type", actDone: "done", actCancel: "cancel"}

// tap handles a tap on a card: answered at once, then the cards edited (in
// the batch's flush) or the answer handed to the hub.
func (s *Service) tap(ctx context.Context, t Tap) {
	row := tapAudit{}
	end := func(outcome, text string) {
		row.Outcome = outcome
		var err error
		if outcome != tapOK {
			err = errors.New(outcome)
		}
		s.answerTap(ctx, t.ID, text)
		s.audit(ctx, AuditTap, row, err)
	}
	// Replies off, unpaired or paired anew since it was read: not for a
	// worker.
	if on, _ := s.listening(); !on || !s.opts.Channel.Hold(Reply{Ref: t.Msg, Epoch: t.Epoch}, func() {}) {
		end(tapOff, tapOffText)
		return
	}
	tok, act, n, ok := parseData(t.Data)
	c, known := s.bt.cards[t.Msg]
	if ok && known && c.s.tok != tok && c.s.kind == kindMenu {
		// #106: its old keyboard, from before it changed: the card shows
		// the new one.
		row.ID, row.Kind = c.s.worker, c.s.kind
		end(tapChanged, tapChangedText)
		return
	}
	if !ok || !known || c.s.tok != tok {
		end(tapUnknown, tapClosedText)
		// A card of before a restart, or one forgotten: no buttons left.
		if err := s.call(ctx, func(ctx context.Context) error { return s.opts.Channel.ClearButtons(ctx, t.Msg) }); err != nil {
			s.opts.Log.Debug("notifications: an old card's buttons were not taken away", "code", CodeOf(err))
		}
		return
	}
	ss, qi := c.s, c.q
	row.ID, row.Kind, row.Question, row.Action = ss.worker, ss.kind, &qi, actNames[act]
	if act == actOption {
		row.Option = n
	}
	if !s.bt.tapAllowed(ss.worker, s.now()) {
		end(tapLimited, tapLimitedText)
		return
	}
	if !s.bt.live(ss) && !ss.sending {
		end(tapClosed, tapClosedText)
		if ss.kind == kindMenu {
			s.endMenu(ctx, ss, "")
		} else {
			s.closeCards(ctx, ss, CardInGameText)
		}
		return
	}
	if ss.sending {
		end(tapBusy, tapBusyText)
		return
	}
	q := ss.qs[qi]
	multi, options, text, cancel := ss.shape(qi)
	if act == actOption && ss.kind == kindMenu && n <= options && ss.menu.Choices[n-1].Withheld {
		options = 0 // #106: no button for it
	}
	ss.note = ""
	switch {
	case act == actCancel && cancel:
		ss.cancel = true
		end(tapOK, tapSendingText)
		s.submit(ctx, ss, t.Epoch)
		return
	case act == actText && text && !q.answered:
		end(tapOK, tapTypeText)
		s.askText(ctx, ss, qi)
		return
	case act == actDone && multi && !q.answered:
		if len(q.picked) == 0 && q.text == nil {
			end(tapEmpty, tapPickText)
			return
		}
		q.answered = true
	case act == actOption && n <= options && !q.answered:
		if multi {
			q.picked[n-1] = !q.picked[n-1]
			if !q.picked[n-1] {
				delete(q.picked, n-1)
			}
			q.dirty = true
			end(tapOK, "")
			return
		}
		q.picked, q.text, q.answered = map[int]bool{n - 1: true}, nil, true
	default:
		// Not a button this card has now (an old keyboard's).
		end(tapClosed, tapClosedText)
		q.dirty = true
		return
	}
	q.dirty = true
	if ss.complete() {
		end(tapOK, tapSendingText)
		s.submit(ctx, ss, t.Epoch)
		return
	}
	end(tapOK, "")
}

// shape is question i's buttons: multi-select, how many options, a typed
// answer taken, a Cancel.
func (ss *session) shape(i int) (multi bool, options int, text, cancel bool) {
	if ss.secret {
		return false, 0, false, false
	}
	switch ss.kind {
	case kindAsk:
		q := ss.ask.Questions[i]
		return q.Multi, len(q.Options), q.Other, true
	case kindMenu:
		return false, len(ss.menu.Choices), false, false
	}
	switch q := ss.fu.Questions[i]; q.Kind {
	case "yes_no":
		return false, 2, false, false
	case "choice":
		return false, len(q.Choices), true, false
	}
	return false, 0, true, false
}

func (ss *session) complete() bool {
	for _, q := range ss.qs {
		if !q.answered {
			return false
		}
	}
	return true
}

// askText sends question i's reply prompt: the recipient's reply to it is
// the typed answer.
func (s *Service) askText(ctx context.Context, ss *session, i int) {
	n := len(ss.qs)
	text := "Type your answer as a reply to this message."
	if n > 1 {
		text = fmt.Sprintf("Type your answer to question %d of %d as a reply to this message.", i+1, n)
	}
	place := promptPlaceText
	if ss.kind == kindAsk && ss.ask.Questions[i].Header != "" {
		place = OneLine(ss.ask.Questions[i].Header, placeholderMax)
	}
	var ref Ref
	err := s.call(ctx, func(ctx context.Context) error {
		var err error
		ref, err = s.opts.Channel.AskText(ctx, ss.qs[i].card, text, place)
		return err
	})
	if err != nil || !ref.Valid() {
		s.opts.Log.Warn("notifications: a reply prompt was not delivered", "worker", ss.worker, "code", CodeOf(err))
		return
	}
	s.bt.prompts[ref] = at{ss, i}
}

// typed takes a reply to a card's prompt as its question's typed answer.
func (s *Service) typed(ctx context.Context, r Reply, a at, row replyAudit) {
	ss, q := a.s, a.s.qs[a.q]
	row.ID = ss.worker
	refuse := func(outcome, text string) {
		row.Outcome = outcome
		s.audit(ctx, AuditReply, row, errors.New(outcome))
		s.answer(ctx, r.Ref, text)
	}
	multi, _, _, _ := ss.shape(a.q)
	limit := MaxFollowupText
	if ss.kind == kindAsk {
		limit = MaxAskOther
	}
	text := strings.TrimSpace(strings.ReplaceAll(r.Text, "\r\n", "\n"))
	switch {
	case ss.sending || q.answered:
		refuse(replyTyped, typedSentText)
		return
	case text == "":
		refuse(ReplyBadText, typedBlankText)
		return
	case len(text) > limit:
		refuse(ReplyBadText, typedLongText)
		return
	case ss.kind == kindAsk && !oneLine(text):
		refuse(ReplyBadText, typedLineText)
		return
	case !s.bt.tapAllowed(ss.worker, s.now()):
		refuse(replyLimited, answers[replyLimited])
		return
	}
	if !s.opts.Channel.Hold(r, func() {}) {
		return
	}
	q.text = &text
	if !multi {
		q.picked, q.answered = map[int]bool{}, true
	}
	q.dirty = true
	row.Outcome = replyTyped
	s.audit(ctx, AuditReply, row, nil)
	if err := s.call(ctx, func(ctx context.Context) error { return s.opts.Channel.Confirm(ctx, r.Ref) }); err != nil {
		s.opts.Log.Warn("notifications: a typed answer's confirmation was not delivered", "code", CodeOf(err))
	}
	if ss.complete() {
		s.submit(ctx, ss, r.Epoch)
	}
}

// oneLine: text has no line break or other control character (an ask's
// typed answer is typed into its dialog's one line).
func oneLine(text string) bool {
	for _, r := range text {
		if unicode.IsControl(r) {
			return false
		}
	}
	return utf8.ValidString(text)
}

// answer is the session's answer for the hub.
func (ss *session) answer() Answer {
	a := Answer{WorkerID: ss.worker}
	if ss.kind == kindMenu {
		a.Hash, a.Native = ss.menu.Hash, ss.menu.Native
		for o := range ss.qs[0].picked {
			a.Choice = ss.menu.Choices[o].N
		}
		return a
	}
	if ss.kind == kindAsk {
		a.ToolUseID, a.Cancel = ss.ask.ToolUseID, ss.cancel
		if ss.cancel {
			return a
		}
		for i, q := range ss.qs {
			aa := AskAnswer{Question: i, Other: q.text}
			for o := range ss.ask.Questions[i].Options {
				if q.picked[o] {
					aa.Choices = append(aa.Choices, o+1)
				}
			}
			a.Ask = append(a.Ask, aa)
		}
		return a
	}
	a.TurnID = ss.fu.TurnID
	for i, q := range ss.qs {
		a.Followup = append(a.Followup, FollowupAnswer{ID: ss.fu.Questions[i].ID, Value: ss.value(i, q)})
	}
	return a
}

// value is a follow-up question's answer: Yes or No, the option, or the
// typed text.
func (ss *session) value(i int, q *qstate) string {
	if q.text != nil {
		return *q.text
	}
	fq := ss.fu.Questions[i]
	for o := range q.picked {
		if fq.Kind == "yes_no" {
			return []string{"Yes", "No"}[o]
		}
		if o < len(fq.Choices) {
			return fq.Choices[o]
		}
	}
	return ""
}

// submit hands the session's answer to the hub, while the switch and the
// recipient it was given under hold.
func (s *Service) submit(ctx context.Context, ss *session, epoch uint64) {
	ss.sending = true
	for _, q := range ss.qs {
		q.dirty = true
	}
	if s.opts.Answer == nil {
		s.finish(ctx, ss, &ReplyError{Kind: ReplyFailed})
		return
	}
	a := ss.answer()
	var err error
	if !s.opts.Channel.Hold(Reply{Epoch: epoch}, func() {
		err = s.opts.Answer(ctx, a, func(err error) {
			s.job(func(ctx context.Context) { s.finish(ctx, ss, err) })
		})
	}) {
		if ss.kind == kindMenu {
			s.endMenu(ctx, ss, menuOff)
			return
		}
		s.closeCards(ctx, ss, CardOffText)
		return
	}
	if err != nil {
		s.finish(ctx, ss, err)
	}
}

// finish shows how the answer went on every card, audits it and forgets
// the session.
func (s *Service) finish(ctx context.Context, ss *session, err error) {
	a := ss.answer()
	row := answerAudit{ID: ss.worker, Kind: ss.kind, Questions: len(ss.qs), Cancel: ss.cancel}
	for _, x := range a.Ask {
		row.Choices += len(x.Choices)
	}
	if a.Choice != 0 {
		row.Choices = 1
	}
	for _, q := range ss.qs {
		if q.text != nil {
			row.TypedBytes += len(*q.text)
			row.TypedRunes += utf8.RuneCountInString(*q.text)
		}
	}
	ss.sending, ss.done = false, true
	var re *ReplyError
	if errors.As(err, &re) && re.Kind == ReplyUnresolved {
		// #88: the menu's keys went, and the worker still waits on it: the
		// card says so; the rest is the game's.
		row.Outcome = ReplyUnresolved
		s.audit(ctx, AuditAnswer, row, nil)
		s.opts.Log.Info("answer tapped in Telegram sent to its worker, which still waits", "worker", ss.worker, "kind", ss.kind)
		if ss.kind == kindMenu {
			s.auditMenu(ctx, ss, menuUnresolved)
		}
		s.closeCards(ctx, ss, "✓ Sent: "+ss.summary(0)+"\n"+CardUnresolvedText)
		return
	}
	if err == nil {
		row.Outcome = replySent
		s.audit(ctx, AuditAnswer, row, nil)
		s.opts.Log.Info("answer tapped in Telegram sent to its worker", "worker", ss.worker, "kind", ss.kind)
		if ss.kind == kindMenu {
			s.auditMenu(ctx, ss, menuAnswered)
		}
		s.closeCards(ctx, ss, "")
		return
	}
	kind := ReplyFailed
	if errors.As(err, &re) && answers[re.Kind] != "" {
		kind = re.Kind
	}
	s.opts.Log.Info("answer tapped in Telegram not sent", "worker", ss.worker, "kind", ss.kind, "outcome", kind)
	row.Outcome = kind
	s.audit(ctx, AuditAnswer, row, errors.New(kind))
	ss.done = false
	if ss.kind == kindMenu {
		s.unsent(ctx, ss, kind)
		return
	}
	status := answers[kind]
	if kind == ReplyClosed {
		status = CardClosedText
	}
	s.closeCards(ctx, ss, status)
}

// unsent takes a menu's answer that was not sent (#106): while the loop
// still sees its operation the card stays, its buttons back, and says why
// (the hub found the screen redrawn, its lane full, a read or a key
// failed: it is checked again at the next tap); else it ends as replaced
// or no longer waited on.
func (s *Service) unsent(ctx context.Context, ss *session, kind string) {
	if !s.bt.live(ss) || kind == ReplyGone || kind == ReplyState {
		s.endMenu(ctx, ss, "")
		return
	}
	ss.qs[0].picked, ss.qs[0].answered, ss.qs[0].dirty = map[int]bool{}, false, true
	ss.note = CardRetryText
	if kind != ReplyClosed {
		ss.note = answers[kind] + " " + CardRetryText
	}
}

// render is question i's card: live (status ""), or ended with status
// (sending, or answered: ""). The options and the end are kept whole (each
// option within its share of the text); the question gets what is left.
func (s *Service) render(ss *session, i int, status string) Card {
	n := len(ss.qs)
	q := ss.qs[i]
	head := ss.name + " · Question"
	switch ss.kind {
	case kindFollowup:
		head = ss.name + " · Follow-up"
	case kindMenu:
		head = ss.name + " · " + menuHeads[ss.menu.Kind]
	}
	if n > 1 {
		head += fmt.Sprintf(" %d of %d", i+1, n)
	}
	if ss.secret {
		if status == "" {
			status = CardSecretText
		}
		return Card{Text: clip16(head+"\n"+status, CardTextMax)}
	}
	ended := status != "" || ss.sending || ss.done
	var body, rest strings.Builder
	var opts, descs, previews []string
	switch ss.kind {
	case kindMenu:
		body.WriteString(menuAsks[ss.menu.Kind])
		if len(ss.menu.About) > 0 {
			body.WriteString("\n\n" + strings.Join(ss.menu.About, "\n"))
		} else if !ended {
			body.WriteString("\n\n" + CardMenuAboutText)
		}
		for _, c := range ss.menu.Choices {
			opts = append(opts, c.Label)
		}
	case kindAsk:
		aq := ss.ask.Questions[i]
		if h := OneLine(aq.Header, cardLabelMax); h != "" {
			head += " · " + h
		}
		body.WriteString(clipRunes(strings.TrimSpace(aq.Question), cardQuestionMax))
		for _, o := range aq.Options {
			opts = append(opts, o.Label)
			descs = append(descs, o.Description)
			previews = append(previews, o.Preview)
		}
	default:
		fq := ss.fu.Questions[i]
		if fq.Label != "" {
			body.WriteString(OneLine(fq.Label, cardLabelMax) + " ")
		}
		body.WriteString(clipRunes(strings.TrimSpace(fq.Question), cardQuestionMax))
		if !ended {
			if c := clipRunes(strings.TrimSpace(fq.Context), cardContextMax); c != "" {
				body.WriteString("\n\n" + c)
			}
			if t := clipRunes(strings.TrimSpace(ss.fu.Tail), cardTailMax); t != "" && n == 1 && fq.Kind == "open" {
				body.WriteString("\n\n" + t)
			}
			if r := OneLine(fq.Recommendation, cardRecMax); r != "" {
				body.WriteString("\n\nRecommended: " + r)
			}
		}
		if fq.Kind == "choice" {
			opts = fq.Choices
		}
	}
	card := func(rows [][]Button) Card {
		top, end := head+"\n", rest.String()
		room := max(CardTextMax-len16(top)-len16(end), 200)
		return Card{Text: clip16(top+clip16(body.String(), room)+end, CardTextMax), Buttons: rows}
	}
	switch {
	case ended:
		rest.WriteString("\n\n" + ss.ending(i, status))
		return card(nil)
	case q.answered:
		rest.WriteString("\n\n✓ " + ss.summary(i) + "\n" + CardWaitText)
		return card(nil)
	}
	share := (CardTextMax - 1000) / max(len(opts), 1)
	for o, label := range opts {
		var ob strings.Builder
		fmt.Fprintf(&ob, "\n\n%d. %s", o+1, OneLine(label, cardLabelMax))
		if o < len(descs) {
			if d := OneLine(descs[o], cardDescMax); d != "" {
				ob.WriteString("\n" + d)
			}
			if p := OneLine(previews[o], cardPreviewMax); p != "" {
				ob.WriteString("\nPreview: " + p)
			}
		}
		rest.WriteString(clip16(ob.String(), share))
	}
	multi, options, text, cancel := ss.shape(i)
	if multi {
		rest.WriteString("\n\n" + cardMultiText)
		if q.text != nil {
			rest.WriteString("\nTyped: " + OneLine(*q.text, cardRecMax))
		}
	}
	withheld := func(o int) bool { return ss.kind == kindMenu && ss.menu.Choices[o].Withheld }
	if ss.kind == kindMenu && slices.ContainsFunc(ss.menu.Choices, func(c MenuChoice) bool { return c.Withheld }) {
		rest.WriteString("\n\n" + CardWithheldText)
	}
	if ss.note != "" {
		rest.WriteString("\n\n" + ss.note)
	}
	var rows [][]Button
	if ss.kind == kindFollowup && ss.fu.Questions[i].Kind == "yes_no" {
		rows = append(rows, []Button{{"Yes", data(ss.tok, actOption, 1)}, {"No", data(ss.tok, actOption, 2)}})
	} else {
		for o := range options {
			if withheld(o) {
				continue
			}
			label := fmt.Sprintf("%d. %s", o+1, OneLine(opts[o], buttonMax))
			if multi {
				mark := "☐ "
				if q.picked[o] {
					mark = "☑ "
				}
				label = mark + label
			}
			rows = append(rows, []Button{{label, data(ss.tok, actOption, o+1)}})
		}
	}
	var last []Button
	if text {
		label := "Other…"
		if options == 0 {
			label = "Answer…"
		}
		last = append(last, Button{label, data(ss.tok, actText, 0)})
	}
	if multi {
		label := "Done"
		if k := len(q.picked); k > 0 {
			label = fmt.Sprintf("Done (%d)", k)
		}
		last = append(last, Button{label, data(ss.tok, actDone, 0)})
	}
	if cancel {
		last = append(last, Button{"Cancel", data(ss.tok, actCancel, 0)})
	}
	if len(last) > 0 {
		rows = append(rows, last)
	}
	return card(rows)
}

// ending is what an ended (or sending) card says under its question.
func (ss *session) ending(i int, status string) string {
	switch {
	case status != "":
		return status
	case ss.cancel && ss.done:
		return CardCancelText
	case ss.cancel:
		return "Cancelling… " + CardSendingText
	case ss.done:
		return "✓ Answered: " + ss.summary(i)
	}
	return "✓ " + ss.summary(i) + "\n" + CardSendingText
}

// summary is question i's answer as its card shows it: the options picked,
// the typed answer.
func (ss *session) summary(i int) string {
	q := ss.qs[i]
	var parts []string
	switch ss.kind {
	case kindFollowup:
		if q.text == nil {
			return ss.value(i, q)
		}
	case kindMenu:
		for o, c := range ss.menu.Choices {
			if q.picked[o] {
				parts = append(parts, OneLine(c.Label, cardLabelMax))
			}
		}
	default:
		for o, opt := range ss.ask.Questions[i].Options {
			if q.picked[o] {
				parts = append(parts, OneLine(opt.Label, cardLabelMax))
			}
		}
	}
	if q.text != nil {
		parts = append(parts, "“"+OneLine(*q.text, cardRecMax)+"”")
	}
	return strings.Join(parts, ", ")
}

// clipRunes is s at most n runes, with an ellipsis.
func clipRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return strings.TrimRight(string(r[:n-1]), " \n") + "…"
}

func len16(s string) int { return len(utf16.Encode([]rune(s))) }

// clip16 is s at most n UTF-16 units (what Telegram counts), with an
// ellipsis.
func clip16(s string, n int) string {
	if len16(s) <= n {
		return s
	}
	units := 0
	for i, r := range s {
		units += utf16.RuneLen(r)
		if units > n-1 {
			return s[:i] + "…"
		}
	}
	return s
}
