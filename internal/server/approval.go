package server

// #106: what a permission or trust menu is about, read off the screen as
// its operation: the dialog's lines from its top, whole, without the lines
// that only say how long something has run. Its hash is what worker.answer
// checks (questionHash); its key (opKey) is what keeps one Telegram card
// for one approval through redraws, a rewrap and a failed read.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/notify"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
)

// maxOpLines bounds the lines of a dialog read as its operation (a screen
// has fewer; a pane read is never that tall).
const maxOpLines = 400

var (
	// opHeadRe is the first line of a dialog that asks above what it is
	// about (Codex's approvals and trust dialog), trimmed.
	opHeadRe = regexp.MustCompile(`(?i)^(would you like to\b|folder access$)`)
	// incidentalRe are lines a dialog or the screen around it may show that
	// say how long something has run or that it still runs, never what is
	// asked (TestIncidentalLines): Claude Code's background task line, a
	// spinner's status, "esc to interrupt", an elapsed time or a countdown,
	// each a whole line.
	incidentalRe = []*regexp.Regexp{
		regexp.MustCompile(`(?i)^\d*\s*background (tasks?|shells?|commands?) running( for)?( \d+(\.\d+)?\s?(ms|s|m|h))*\.?$`),
		regexp.MustCompile(`^[✻✶✳✢·✽*] [\p{L}-]+(…|\.\.\.)? \(\d+(\.\d+)?s\b[^)]*\)$`),
		regexp.MustCompile(`(?i)^\(?esc to interrupt\)?$`),
		regexp.MustCompile(`(?i)^\(?\d+(\.\d+)?\s?(ms|s|m|h)( \d+s)?\)?$`),
		regexp.MustCompile(`^\d{1,2}:\d{2}(:\d{2})?$`),
		regexp.MustCompile(`(?i)^(auto-?)?(deny|denies|denied|declines?|rejects?|cancels?|times? out)\b[\p{L} ]*\bin \d+(:\d{2})?\s?(s|secs?|seconds?|m|mins?|minutes?)?\.?$`),
	}
)

// shellChars are what an incidental line never has: a path, a quote, a
// variable, an operator (a command line that reads like a status line is
// the operation's).
const shellChars = "/\\$;|&=<>'\"`"

// isIncidental reports whether a trimmed line only says how long something
// has run (incidentalRe).
func isIncidental(t string) bool {
	if strings.ContainsAny(t, shellChars) {
		return false
	}
	for _, re := range incidentalRe {
		if re.MatchString(t) {
			return true
		}
	}
	return false
}

// onlyIncidental reports whether lines are empty or incidental, every one.
func onlyIncidental(lines []string) bool {
	for _, l := range lines {
		if t := strings.TrimSpace(l); t != "" && !isIncidental(t) {
			return false
		}
	}
	return true
}

// menuOp is what a permission or trust menu is about, as its screen shows
// it.
type menuOp struct {
	// lines are the operation's: the dialog's lines from its top down to
	// its question (Claude's dialog asks below them) or to its first choice
	// (Codex's asks above them), trimmed, whole (never clipped), without a
	// rule or an incidental line.
	lines []string
	// complete: the dialog's top is on the screen, so nothing of it is
	// above. Else lines are what the screen shows of its end.
	complete bool
	// key names the operation through a redraw: its kind, the blocked
	// spell, its choices' count and its lines joined without whitespace (a
	// rewrap or a resize moves only that).
	key string
}

// isLeftRule reports whether l, untrimmed, is a solid rule from the
// screen's left edge: Claude Code's dialog top. A rule inside a command is
// indented under the dialog's head.
func isLeftRule(l string) bool {
	if l == "" || l[0] == ' ' || l[0] == '\t' {
		return false
	}
	t := strings.TrimSpace(l)
	return isRule(t) && !strings.ContainsAny(t, "╌╍┄┅┈┉")
}

// opOf reads the operation of a permission or trust menu whose first choice
// is on line first and whose question is on line qline (-1: none found). A
// Claude dialog's top is its rule at the left edge, a Codex dialog's its
// first line (opHeadRe); a harness not known takes whichever comes first
// going up. Looked for up to the screen's top: not found, the operation is
// all the screen shows above the menu, and not complete.
func opOf(harness string, q proto.Question, lines []string, first, qline int, since int64) *menuOp {
	top, head := -1, false
	for i := first - 1; i >= 0 && first-i <= maxOpLines; i-- {
		t := strings.TrimSpace(lines[i])
		if harness != transcript.Codex && isLeftRule(lines[i]) {
			top = i
			break
		}
		if harness != transcript.Claude && opHeadRe.MatchString(t) {
			top, head = i, true
			break
		}
	}
	op := &menuOp{complete: top >= 0}
	from, to := top+1, first
	if top < 0 {
		from = max(0, first-maxOpLines)
	}
	switch {
	case head:
		from = top // Codex: its first line asks, and what follows is what it asks about
	case harness != transcript.Codex && qline >= from && qline < first && onlyIncidental(lines[qline+1:first]):
		to = qline // Claude: its question is right above the choices, what it is about above it
	}
	var bare strings.Builder
	for i := from; i < to; i++ {
		t := strings.TrimSpace(lines[i])
		if t == "" || isRule(t) || isIncidental(t) {
			continue
		}
		op.lines = append(op.lines, t)
		for _, r := range t {
			if !unicode.IsSpace(r) {
				bare.WriteRune(r)
			}
		}
	}
	h := sha256.New()
	fmt.Fprintf(h, "%s\x00%d\x00%d\x00%t\x00%s", q.Kind, since, len(q.Choices), op.complete, bare.String())
	op.key = hex.EncodeToString(h.Sum(nil))[:16]
	return op
}

// hashLines are what questionHash folds in of the operation: its lines,
// and whether its top was on the screen.
func (op *menuOp) hashLines() []string {
	out := append([]string(nil), op.lines...)
	if !op.complete {
		out = append(out, "\x01partial")
	}
	return out
}

// plainLine is t without control characters, for a line that leaves the
// bridge.
func plainLine(t string) string {
	if !utf8.ValidString(t) {
		t = strings.ToValidUTF8(t, "�")
	}
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, t)
}

// Bounds of what a menu's card shows of its operation.
const (
	aboutLineMax  = 300  // runes of one line
	aboutLinesMax = 24   // lines
	aboutMax      = 1800 // runes in all
)

// What a menu's card says of what it could not show.
const (
	aboutPartial = "⚠ Its start is off the screen: only its end is shown."
	aboutCut     = "… (%d more lines not shown)"
)

// aboutLines is what a menu's card shows of an operation's lines as the
// screen shows them: redacted together (redactLines, soft: a line break
// may be the screen's wrap), each cut to aboutLineMax, at most
// aboutLinesMax of them (what says the rest among them) and aboutMax runes
// in all, the rest said.
func aboutLines(lines []string) []string {
	return boundLines(redactLines(lines, true), aboutLinesMax, aboutMax)
}

// boundLines is lines (redacted) bounded: each to aboutLineMax runes, at
// most maxLines of them (what says the rest among them) and maxRunes in
// all, the rest said.
func boundLines(lines []string, maxLines, maxRunes int) []string {
	var out []string
	total := 0
	for i, l := range lines {
		if utf8.RuneCountInString(l) > aboutLineMax {
			l = string([]rune(l)[:aboutLineMax-1]) + "…"
		}
		n := utf8.RuneCountInString(l)
		if (len(out) == maxLines-1 && i < len(lines)-1) || total+n > maxRunes {
			out = append(out, fmt.Sprintf(aboutCut, len(lines)-i))
			break
		}
		out = append(out, l)
		total += n
	}
	return out
}

// menuFacts adds to a menu's facts what its operation tells (#106): its
// key, what its card shows (redacted and bounded: its native call's
// command, directory and the dialog's other lines when nc is known, else
// the dialog's lines), and for a permission whose dialog's top is off the
// screen and whose call is not known, its approving choices withheld:
// what the card shows of it is not all of it, so no tap approves it.
func menuFacts(m *notify.Menu, op *menuOp, nc *nativeCall) {
	if m == nil || op == nil {
		return
	}
	m.Op, m.Source = op.key, "screen"
	if nc != nil {
		m.Native, m.Source, m.About = nc.id, "native", nc.about(op)
		return
	}
	if op.complete {
		m.About = aboutLines(op.lines)
		return
	}
	m.About = append([]string{aboutPartial}, boundLines(redactLines(op.lines, true), aboutLinesMax-1, aboutMax)...)
	if m.Kind != proto.QuestionPermission {
		return
	}
	for i := range m.Choices {
		if approves(m.Choices[i].Label) {
			m.Choices[i].Withheld = true
		}
	}
}

// approves reports whether a permission menu's choice label approves (a
// Yes, as Claude Code and Codex write them).
func approves(label string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(label)), "yes")
}

// nativeCall is the agent's own pending call a menu is for (#106): read
// from its transcript (transcript.CallTracker), with its whole input.
type nativeCall struct {
	// id names it: 16 hex over its tool_use id, its input's sum and its
	// directory.
	id   string
	call transcript.PendingCall
	// in is its input's fields a card shows; mode the session's permission
	// mode.
	in   callInput
	mode string
	// cmd is how many of the operation's lines are its command (Bash).
	cmd int
}

type callInput struct {
	Command     string `json:"command"`
	Description string `json:"description"`
	FilePath    string `json:"file_path"`
}

// fileHeads are Claude Code's file dialogs' heads, and the tools they ask
// for.
var fileHeads = map[string][]string{"Create file": {"Write"}, "Edit file": {"Edit", "MultiEdit", "Write"}, "Overwrite file": {"Write"}}

// bare is s without whitespace.
func bare(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return r
	}, s)
}

// nativeOf is the one pending call of calls that op is about (nil: none,
// or more than one could be). A Bash dialog's command lines must draw its
// command word for word (drawn: whole; a dialog whose top is off the
// screen, its end, at least minNativeTail characters of it); a file
// dialog's path must be its file_path (or its end). Anything else is not
// matched.
func nativeOf(op *menuOp, calls []transcript.PendingCall, mode string) *nativeCall {
	if op == nil || len(op.lines) == 0 {
		return nil
	}
	var found *nativeCall
	for _, c := range calls {
		nc := matchCall(op, c)
		if nc == nil {
			continue
		}
		if found != nil {
			return nil
		}
		found = nc
	}
	if found != nil {
		found.mode = mode
		h := sha256.Sum256([]byte(found.call.ID + "\x00" + found.call.Sum + "\x00" + found.call.Cwd))
		found.id = hex.EncodeToString(h[:])[:16]
	}
	return found
}

// minNativeTail is the fewest characters (no whitespace) of a command's end
// that match a dialog whose top is off the screen.
const minNativeTail = 12

func matchCall(op *menuOp, c transcript.PendingCall) *nativeCall {
	var in callInput
	if c.Input == nil || json.Unmarshal(c.Input, &in) != nil {
		return nil
	}
	nc := &nativeCall{call: c, in: in}
	lines := op.lines
	if op.complete {
		head := lines[0]
		if tools, ok := fileHeads[head]; ok {
			if len(lines) < 2 || !slices.Contains(tools, c.Name) || in.FilePath == "" ||
				(in.FilePath != lines[1] && !strings.HasSuffix(in.FilePath, "/"+lines[1])) {
				return nil
			}
			return nc
		}
		if head != "Bash command" {
			return nil
		}
		lines = lines[1:]
	}
	if c.Name != "Bash" || in.Command == "" {
		return nil
	}
	cmd := words(in.Command)
	if op.complete {
		nc.cmd = drawn(lines, cmd)
	} else {
		for n := 1; n <= len(lines) && nc.cmd == 0; n++ {
			if len(bare(strings.Join(lines[:n], ""))) >= minNativeTail && drawnEnd(lines[:n], cmd) {
				nc.cmd = n
			}
		}
	}
	if nc.cmd == 0 {
		return nil
	}
	return nc
}

// words is s with each run of whitespace one space, trimmed.
func words(s string) string { return strings.Join(strings.Fields(s), " ") }

// drawn is how many of lines, a dialog's from the top, draw cmd (words')
// whole (0: they do not): their words its words, and where a line breaks,
// one of its spaces, or none (the wrap cut a word: the screen cannot tell
// the two apart).
func drawn(lines []string, cmd string) int {
	j := 0
	for k, l := range lines {
		if k > 0 && j < len(cmd) && cmd[j] == ' ' {
			j++
		}
		l = words(l)
		if !strings.HasPrefix(cmd[j:], l) {
			return 0
		}
		if j += len(l); j == len(cmd) {
			return k + 1
		}
	}
	return 0
}

// drawnEnd reports whether lines draw cmd's end as drawn does its whole
// (the first may start inside a word).
func drawnEnd(lines []string, cmd string) bool {
	j := len(cmd)
	for k := len(lines) - 1; k >= 0; k-- {
		if k < len(lines)-1 && j > 0 && cmd[j-1] == ' ' {
			j--
		}
		l := words(lines[k])
		if !strings.HasSuffix(cmd[:j], l) {
			return false
		}
		j -= len(l)
	}
	return true
}

// bypassRmRe is a removal Claude Code still asks about in bypass mode.
var bypassRmRe = regexp.MustCompile(`(^|[\s;&|(/])(rm|rmdir)\s`)

// What a native call's card adds.
const (
	nativeIn     = "In: "
	nativeSays   = "It also says: "
	nativeBypass = "Bypass mode: Claude Code still asks about this removal, and denies it if nobody answers within about 2 minutes."
	nativeFile   = "File: "
)

// about is what the card shows of a menu with its native call: the
// dialog's head, the call's command or file, its description and
// directory, the dialog's lines that are not the call's (why it asks), and
// in bypass mode, a removal's countdown; redacted and bounded.
func (nc *nativeCall) about(op *menuOp) []string {
	head, rest := "", op.lines
	if op.complete {
		head, rest = op.lines[0], op.lines[1:]
	}
	var main, extra []string
	switch {
	case nc.call.Name == "Bash":
		if head == "" {
			head = "Bash command"
		}
		main = strings.Split(strings.TrimRight(nc.in.Command, "\n"), "\n")
		rest = rest[min(nc.cmd, len(rest)):]
		if d := strings.TrimSpace(nc.in.Description); d != "" {
			extra = append(extra, d)
		}
	default:
		main = []string{nativeFile + nc.in.FilePath}
		rest = rest[min(1, len(rest)):]
	}
	if nc.call.Cwd != "" {
		extra = append(extra, nativeIn+nc.call.Cwd)
	}
	desc := bare(nc.in.Description)
	for _, l := range rest {
		if b := bare(l); b != "" && b != desc && nc.call.Name == "Bash" {
			extra = append(extra, nativeSays+l)
		}
	}
	if nc.mode == "bypassPermissions" && bypassRmRe.MatchString(nc.in.Command) {
		extra = append(extra, nativeBypass)
	}
	for i, l := range extra {
		extra[i] = redactLine(l)
	}
	more := boundLines(extra, 6, 600)
	out := append([]string{head}, boundLines(redactLines(main, false), aboutLinesMax-1-len(more), aboutMax-600)...)
	return append(out, more...)
}

// workerCalls are the calls a worker's transcript waits on, and its
// permission mode (#106).
type workerCalls struct {
	calls []transcript.PendingCall
	mode  string
}

// callsUpdate is a worker's calls as its transcript says them now.
type callsUpdate struct {
	id string
	workerCalls
}

// offerCalls queues a worker's pending calls when they changed (by their
// ids, sums and the mode).
func (tr *usageTracker) offerCalls(w usageWorker) {
	var wc workerCalls
	if t := tr.calls[w.id]; t != nil {
		wc = workerCalls{calls: t.Pending(), mode: t.Mode()}
	}
	var fp strings.Builder
	fp.WriteString(wc.mode)
	for _, c := range wc.calls {
		fp.WriteString("\x00" + c.ID + "\x00" + c.Sum)
	}
	if prev, ok := tr.callShown[w.id]; (ok && prev == fp.String()) || (!ok && fp.Len() == 0) {
		return
	}
	tr.callShown[w.id] = fp.String()
	tr.callUps = append(tr.callUps, callsUpdate{id: w.id, workerCalls: wc})
}

// setCalls keeps a worker's pending calls (hub goroutine). A worker blocked
// on a menu is looked at again: its question's hash follows the call its
// menu is for (bindNative: a worker.upsert when it changed), and its card
// learns the call.
func (h *Hub) setCalls(u callsUpdate) {
	if len(u.calls) == 0 && u.mode == "" {
		delete(h.calls, u.id)
	} else {
		h.calls[u.id] = u.workerCalls
	}
	qs, ok := h.questions[u.id]
	if !ok || qs.op == nil || qs.sq == nil {
		return
	}
	next := *qs.sq
	if h.bindNative(u.id, &next); next.q.Hash != qs.q.Hash {
		h.setQuestion(u.id, qs.pane, &next) // its emit looks at the worker again
		return
	}
	if h.nt.svc != nil {
		h.notifyWorker(u.id)
	}
}

// nativeFor is the pending call of worker id's transcript that op is about
// (hub goroutine; nil: none known).
func (h *Hub) nativeFor(id string, op *menuOp) *nativeCall {
	wc, ok := h.calls[id]
	if !ok {
		return nil
	}
	return nativeOf(op, wc.calls, wc.mode)
}

// bindNative folds into sq's hash the pending call of worker id's
// transcript its menu is for (hub goroutine; #106): an answer, the game's
// as a tap's, is then for that call only, and a call replaced (another
// tool_use, input or directory) is another hash. It returns the call (nil:
// none known).
func (h *Hub) bindNative(id string, sq *screenQuestion) *nativeCall {
	var nc *nativeCall
	if sq.op != nil {
		nc = h.nativeFor(id, sq.op)
	}
	sq.bind(nc)
	return nc
}

// bind sets sq's hash (questionHash): what its screen asks and (#106) the
// native call nc its menu is for (nil: none known).
func (sq *screenQuestion) bind(nc *nativeCall) {
	about := sq.about
	if nc != nil {
		about = append(slices.Clip(about), "\x02native "+nc.id)
	}
	sq.q.Hash = questionHash(sq.q, about, sq.since)
}

// partialApproval reports whether answering sq with choice approves a
// permission whose dialog's top is off the screen and whose call (nc) is
// not known: the screen shows only its end, so what it would approve is
// not known whole (#106: refused, for the game as for a tap; its No and a
// cancel are not).
func partialApproval(sq screenQuestion, nc *nativeCall, choice int) bool {
	if sq.op == nil || sq.op.complete || nc != nil || sq.q.Kind != proto.QuestionPermission {
		return false
	}
	i := slices.IndexFunc(sq.q.Choices, func(c proto.Choice) bool { return c.N == choice })
	return i >= 0 && approves(sq.q.Choices[i].Label)
}
