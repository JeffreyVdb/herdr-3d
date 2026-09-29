package server

// M5 term: what a blocked worker's screen asks (Worker.question), and
// answering it (worker.answer).

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// Defaults of the question timings.
const (
	DefaultQuestionPoll  = 2 * time.Second
	DefaultAnswerTimeout = 3 * time.Second
	answerPoll           = 50 * time.Millisecond
)

const (
	statusBlocked = "blocked"
	statusWorking = "working"

	maxExcerptLines = 8
	maxExcerptRunes = 200
	// A menu's last choice is at most this many non-empty lines above the
	// screen's last one (its key hints).
	maxMenuFooter = 3
	// How many lines above a menu its question is looked for in.
	questionReach = 12
)

var (
	// A numbered choice: "❯ 1. Yes", "  2. No" (Claude), "› 1. Yes,
	// proceed (y)" (Codex).
	numberedChoiceRe = regexp.MustCompile(`^\s*(?:([❯›>])\s*)?([1-9])[.)]\s+(\S.*)$`)
	// The cursor line of a menu without numbers ("❯ No, exit").
	cursorChoiceRe = regexp.MustCompile(`^(\s*)([❯›])\s+(\S.*)$`)
	// The key hints under a menu without numbers.
	menuHintRe = regexp.MustCompile(`(?i)enter to (confirm|select)|esc to cancel|to navigate|enter continue`)
	// Phrases the agents ask their questions with.
	knownQuestionRe = regexp.MustCompile(`(?i)\b(do you want to|would you like to|is this a project|trust this folder|do you trust)\b`)
)

// screenQuestion is a parsed question and how its menu is answered.
type screenQuestion struct {
	q proto.Question
	// numbered: the menu shows digits and takes them (Claude's permission
	// prompts and questions, Codex's approvals), else arrows and Enter.
	numbered bool
}

// parseQuestion reads what a blocked worker's screen asks (`pane read
// --source visible` text). Checked against screens captured from Claude
// Code and Codex under herdr 0.9.0 (testdata/screens): a menu is numbered
// choices (1…k) or a cursor line and its siblings above key hints, near
// the bottom of the screen; the question is the line above it that asks.
func parseQuestion(screen string) screenQuestion {
	lines := strings.Split(strings.ReplaceAll(screen, "\r", ""), "\n")
	for i, l := range lines {
		lines[i] = strings.TrimRightFunc(l, unicode.IsSpace)
	}
	var nonEmpty []int // indexes of the non-empty lines
	for i, l := range lines {
		if strings.TrimSpace(l) != "" {
			nonEmpty = append(nonEmpty, i)
		}
	}
	sq := screenQuestion{q: proto.Question{Kind: proto.QuestionOther, Excerpt: excerpt(lines, nonEmpty), Choices: []proto.Choice{}}}
	first := -1 // line of the first choice
	if choices, sel, at, ok := numberedMenu(lines, nonEmpty); ok {
		sq.q.Choices, sq.q.Selected, first, sq.numbered = choices, sel, at, true
	} else if choices, sel, at, ok := cursorMenu(lines, nonEmpty); ok {
		sq.q.Choices, sq.q.Selected, first = choices, sel, at
	}
	switch {
	case isTrustDialog(screen):
		sq.q.Kind = proto.QuestionTrust
	case len(sq.q.Choices) == 0:
	case strings.HasPrefix(sq.q.Choices[0].Label, "Yes") && slices.ContainsFunc(sq.q.Choices, func(c proto.Choice) bool {
		return strings.HasPrefix(c.Label, "No")
	}):
		sq.q.Kind = proto.QuestionPermission
	default:
		sq.q.Kind = proto.QuestionChoice
	}
	if first < 0 && len(nonEmpty) > 0 {
		first = nonEmpty[len(nonEmpty)-1] + 1 // no menu: the question is among the last lines
	}
	sq.q.Text = questionText(lines, first)
	sq.q.Hash = questionHash(sq.q)
	return sq
}

// numberedMenu finds choices 1…k whose last one is near the bottom of the
// screen, walking up from k to 1 (a description or a rule may sit between
// two choices). It returns them, the one the cursor is on (0: none seen)
// and the line of choice 1.
func numberedMenu(lines []string, nonEmpty []int) ([]proto.Choice, int, int, bool) {
	var choices []proto.Choice
	sel, want, gap := 0, 0, 0
	for j := len(nonEmpty) - 1; j >= 0; j-- {
		i := nonEmpty[j]
		m := numberedChoiceRe.FindStringSubmatch(lines[i])
		if want == 0 { // looking for the last choice
			if m == nil {
				if len(nonEmpty)-1-j >= maxMenuFooter {
					return nil, 0, 0, false
				}
				continue
			}
			want, _ = strconv.Atoi(m[2])
		}
		if m == nil {
			if gap++; gap > 2 {
				return nil, 0, 0, false
			}
			continue
		}
		n, _ := strconv.Atoi(m[2])
		if n != want {
			return nil, 0, 0, false
		}
		gap = 0
		choices = append(choices, proto.Choice{N: n, Label: strings.TrimSpace(m[3])})
		if m[1] != "" {
			sel = n
		}
		if want--; want == 0 {
			slices.Reverse(choices)
			return choices, sel, i, true
		}
	}
	return nil, 0, 0, false
}

// cursorMenu finds a menu without numbers: a cursor line ("❯ No, exit")
// and the lines next to it indented to its label, with key hints below
// ("Enter to confirm · Esc to cancel"), near the bottom of the screen.
// Choices are numbered from 1 top to bottom.
func cursorMenu(lines []string, nonEmpty []int) ([]proto.Choice, int, int, bool) {
	for j := len(nonEmpty) - 1; j >= 0 && len(nonEmpty)-1-j <= maxMenuFooter+2; j-- {
		i := nonEmpty[j]
		m := cursorChoiceRe.FindStringSubmatch(lines[i])
		if m == nil {
			continue
		}
		col := utf8.RuneCountInString(lines[i][:len(lines[i])-len(m[3])]) // the label's column
		sibling := func(k int) bool {
			l := lines[k]
			t := strings.TrimLeft(l, " ")
			return t != "" && utf8.RuneCountInString(l)-utf8.RuneCountInString(t) == col && !cursorChoiceRe.MatchString(l)
		}
		top, bottom := i, i
		for top > 0 && sibling(top-1) {
			top--
		}
		for bottom+1 < len(lines) && sibling(bottom+1) {
			bottom++
		}
		if bottom == top {
			return nil, 0, 0, false
		}
		hinted := false
		for k, seen := bottom+1, 0; k < len(lines) && seen < maxMenuFooter; k++ {
			if strings.TrimSpace(lines[k]) == "" {
				continue
			}
			seen++
			if menuHintRe.MatchString(lines[k]) {
				hinted = true
			}
		}
		if !hinted {
			return nil, 0, 0, false
		}
		var choices []proto.Choice
		sel := 0
		for k := top; k <= bottom; k++ {
			label := strings.TrimSpace(lines[k])
			if k == i {
				label, sel = strings.TrimSpace(m[3]), k-top+1
			}
			choices = append(choices, proto.Choice{N: k - top + 1, Label: label})
		}
		return choices, sel, top, true
	}
	return nil, 0, 0, false
}

// isTrustDialog reports whether screen is an agent's trust-this-folder
// dialog (trustDialog, without the directory check).
func isTrustDialog(screen string) bool {
	has := func(needles []string) bool {
		for _, n := range needles {
			if !strings.Contains(screen, n) {
				return false
			}
		}
		return true
	}
	return has(claudeTrust) || has(codexTrust)
}

// questionText is the line above line first (a menu's first choice) that
// asks: one with a phrase the agents ask with, else one ending in "?",
// else one with a "?" in it (cut after it); the nearest first, within
// questionReach lines and above no rule (a line of box drawing).
func questionText(lines []string, first int) string {
	var region []string // nearest first
	for i := first - 1; i >= 0 && first-i <= questionReach; i-- {
		t := strings.TrimSpace(lines[i])
		if isRule(t) {
			break
		}
		if t != "" {
			region = append(region, t)
		}
	}
	cut := func(t string) string {
		if i := strings.IndexByte(t, '?'); i >= 0 {
			return t[:i+1]
		}
		return t
	}
	for _, t := range region {
		if knownQuestionRe.MatchString(t) {
			return clip(cut(t))
		}
	}
	for _, t := range region {
		if strings.HasSuffix(t, "?") {
			return clip(t)
		}
	}
	for _, t := range region {
		if strings.Contains(t, "?") {
			return clip(cut(t))
		}
	}
	return ""
}

// isRule reports whether t is a horizontal rule: box drawing only.
func isRule(t string) bool {
	if utf8.RuneCountInString(t) < 8 {
		return false
	}
	for _, r := range t {
		if (r < 0x2500 || r > 0x257f) && r != '-' && r != '=' {
			return false
		}
	}
	return true
}

func excerpt(lines []string, nonEmpty []int) []string {
	from := max(0, len(nonEmpty)-maxExcerptLines)
	out := make([]string, 0, len(nonEmpty)-from)
	for _, i := range nonEmpty[from:] {
		out = append(out, clip(strings.TrimSpace(lines[i])))
	}
	return out
}

// clip shortens s to maxExcerptRunes runes.
func clip(s string) string {
	if utf8.RuneCountInString(s) <= maxExcerptRunes {
		return s
	}
	return string([]rune(s)[:maxExcerptRunes])
}

// questionHash identifies a question for worker.answer: 16 hex over its
// kind, text and choices (not the cursor, not the excerpt).
func questionHash(q proto.Question) string {
	h := sha256.New()
	fmt.Fprintf(h, "%s\x00%s\x00", q.Kind, q.Text)
	for _, c := range q.Choices {
		fmt.Fprintf(h, "%d\x1f%s\x00", c.N, c.Label)
	}
	return hex.EncodeToString(h.Sum(nil))[:16]
}

// answerKeys are the keys that pick choice n: its digit on a numbered
// menu (not a trust dialog: Codex's ignores digits), else arrows from the
// cursor and Enter.
func (sq screenQuestion) answerKeys(n int) []string {
	if sq.numbered && sq.q.Kind != proto.QuestionTrust {
		return []string{strconv.Itoa(n)}
	}
	sel := sq.q.Selected
	if sel == 0 {
		sel = 1
	}
	var keys []string
	for ; sel < n; sel++ {
		keys = append(keys, "down")
	}
	for ; sel > n; sel-- {
		keys = append(keys, "up")
	}
	return append(keys, "enter")
}

// questionState is a blocked worker's question, read from its pane.
type questionState struct {
	pane string
	q    *proto.Question
}

// withQuestion puts a worker's question on its view while it is blocked,
// and forgets it once it is not (hub goroutine).
func (h *Hub) withQuestion(next *proto.Worker) {
	qs, ok := h.questions[next.ID]
	if !ok {
		return
	}
	if next.Status != statusBlocked || next.PaneID != qs.pane {
		delete(h.questions, next.ID)
		return
	}
	next.Question = qs.q
}

// askQuestions starts reading the screen of every blocked worker that has
// no reader yet (hub goroutine, after each observation).
func (h *Hub) askQuestions(ctx context.Context) {
	if h.opts.Term == nil {
		return
	}
	for id, w := range h.workers {
		if w.Status != statusBlocked || w.PaneID == "" || h.asking[id] {
			continue
		}
		if f := h.floors[w.Session]; f == nil || !f.running {
			continue
		}
		h.asking[id] = true
		h.wg.Add(1)
		go h.questionLoop(ctx, id, w.Session, w.PaneID)
	}
}

// questionLoop reads a blocked worker's screen now and every QuestionPoll
// while it stays blocked in the same pane, and publishes what it asks.
func (h *Hub) questionLoop(ctx context.Context, id, session, pane string) {
	defer h.wg.Done()
	for {
		var q *proto.Question
		if screen, err := h.opts.Term.ReadPane(ctx, session, pane); err == nil {
			sq := parseQuestion(screen)
			q = &sq.q
		} else if ctx.Err() == nil {
			h.log.Debug("reading a blocked worker's screen failed", "worker", id, "err", err)
		}
		more, err := query(ctx, h, func() bool {
			w := h.workers[id]
			if w == nil || w.Status != statusBlocked || w.Session != session || w.PaneID != pane {
				delete(h.asking, id)
				return false
			}
			h.setQuestion(id, pane, q)
			return true
		})
		if err != nil || !more {
			return
		}
		sleepCtx(ctx, h.opts.QuestionPoll)
		if ctx.Err() != nil {
			return
		}
	}
}

// setQuestion publishes a blocked worker's question when it changed: a
// worker.upsert (hub goroutine).
func (h *Hub) setQuestion(id, pane string, q *proto.Question) {
	w := h.workers[id]
	if w == nil || reflect.DeepEqual(w.Question, q) {
		return
	}
	next := *w
	next.Question = q
	h.workers[id] = &next
	if q != nil {
		h.questions[id] = questionState{pane: pane, q: q}
	} else {
		delete(h.questions, id)
	}
	h.emit(proto.Event{T: proto.EvWorkerUpsert, Worker: &next})
}

var hashRe = regexp.MustCompile(`^[0-9a-f]{16}$`)

// startAnswer validates worker.answer and queues it on the worker's input
// lane: the screen is read again, the choice's keys pressed, and the
// worker watched for up to AnswerTimeout to leave blocked.
func (h *Hub) startAnswer(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.WorkerAnswerArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if !hashRe.MatchString(a.Hash) {
		return bad("hash must be 16 hex characters")
	}
	if (a.Choice != 0) == a.Cancel || a.Choice < 0 || a.Choice > 9 {
		return bad("want exactly one of choice (1-9) and cancel: true")
	}
	w, _, err := h.termWorker(a.ID)
	if err != nil {
		return err
	}
	if w.Status != statusBlocked {
		return fmt.Errorf("%w: %s is %s, not blocked", errInvalidState, w.Name, w.Status)
	}
	return h.startInput(ctx, c, cmd, a.ID, func(ctx context.Context, session, pane string) (any, error) {
		return h.answer(ctx, a, session, pane)
	})
}

func (h *Hub) answer(ctx context.Context, a proto.WorkerAnswerArgs, session, pane string) (any, error) {
	screen, err := h.opts.Term.ReadPane(ctx, session, pane)
	if err != nil {
		return nil, fmt.Errorf("%w: reading the screen failed: %v", errInputFailed, err)
	}
	sq := parseQuestion(screen)
	blocked, err := query(ctx, h, func() bool {
		w := h.workers[a.ID]
		if w == nil || w.Status != statusBlocked || w.PaneID != pane {
			return false
		}
		h.setQuestion(a.ID, pane, &sq.q) // what it asks now
		return true
	})
	switch {
	case err != nil:
		return nil, err
	case !blocked:
		return nil, fmt.Errorf("%w: the worker is no longer blocked", errStale)
	case sq.q.Hash != a.Hash:
		return nil, fmt.Errorf("%w: the screen asks %q now (hash %s)", errStale, sq.q.Text, sq.q.Hash)
	}
	var keys []string
	if a.Cancel {
		keys = []string{"esc"}
	} else {
		if !slices.ContainsFunc(sq.q.Choices, func(c proto.Choice) bool { return c.N == a.Choice }) {
			return nil, bad("the question has no choice %d", a.Choice)
		}
		keys = sq.answerKeys(a.Choice)
	}
	if err := h.opts.Term.SendKeys(ctx, session, pane, keys...); err != nil {
		return nil, fmt.Errorf("%w: %v", errInputFailed, err)
	}
	res := proto.AnswerResult{Sent: keys}
	for end := time.Now().Add(h.opts.AnswerTimeout); ; {
		still, err := query(ctx, h, func() bool {
			w := h.workers[a.ID]
			return w != nil && w.Status == statusBlocked
		})
		if err != nil {
			return nil, err
		}
		if !still {
			res.Resolved = true
			break
		}
		if time.Now().After(end) {
			break
		}
		sleepCtx(ctx, answerPoll)
	}
	return res, nil
}
