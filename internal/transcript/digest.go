package transcript

// #118: the floor overview's digest of a worker (DigestTracker), from the
// same lines as the ask, wrap-up, follow-up and activity trackers. Phase 1
// shows only what needs no model:
//
//   - the task: Claude's own `ai-title` metadata line (the latest), else the
//     first genuine prompt cut to its first sentence (Codex has no ai-title);
//   - the recap: Claude's `system/away_summary` line, valid until the next
//     prompt, turn start or assistant step after it.
//
// It also keeps what phase 2's summarizer (internal/digest) will read: the
// first genuine prompt and its sha256, and a ring of the last DigestSteps
// assistant steps (their texts, and their tool calls as name + input
// summary; never a tool's output, never thinking). `/clear` (and another
// agent session, which makes a new tracker) starts it over.
//
// Shapes checked against Claude Code 2.1.285 and codex-cli 0.159.2
// (testdata/*/digest_*.jsonl).

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// Digest limits.
const (
	// DigestSteps is how many assistant steps the ring keeps.
	DigestSteps = 5
	// DigestTaskMax and DigestNowMax are the longest task and now lines, in
	// runes ("…" included).
	DigestTaskMax = 80
	DigestNowMax  = 100
	// digestStepText is the most text a step keeps, in bytes.
	digestStepText = 2000
	// digestPromptMax is the most of the first prompt kept, in bytes.
	digestPromptMax = 8000
)

// DigestTool is a tool call of an assistant step: its name and input
// summary (as the transcript view shows it).
type DigestTool struct {
	Name, Summary string
}

// DigestStep is one assistant step: Claude's message (one id, its blocks on
// several lines), Codex's message and the calls after it.
type DigestStep struct {
	Texts []string
	Tools []DigestTool
}

// Digest is what a tracker knows of its worker now.
type Digest struct {
	// Steps counts the assistant steps read since the start (or /clear):
	// the overview shows a worker's digest once it is at least 1.
	Steps int
	// Ended counts the turns that ended since the start (or /clear):
	// Claude's turn_duration, Codex's task_complete. Phase 2 writes a now
	// line after each.
	Ended int
	// Prompt is the first genuine prompt (cleaned: no system reminders, no
	// paste wrapper, image markers as "[image]"), PromptHash its hex sha256.
	Prompt, PromptHash string
	// AITitle is Claude's latest ai-title.
	AITitle string
	// Recent is the last DigestSteps steps, oldest first.
	Recent []DigestStep
	// Recap is Claude's latest away_summary while no prompt, turn start or
	// assistant step came after it, RecapAt its time (unix ms).
	Recap   string
	RecapAt int64
	// Resets counts the tracker's resets (a /clear, the transcript
	// replaced): with the tracker itself, the identity of what the counts
	// and the prompt are of.
	Resets int
}

// Task is the phase-1 task line and its source (proto.Digest*): the
// ai-title, else the prompt's first informative sentence (taskFallback); ""
// when there is neither.
func (d Digest) Task() (string, string) {
	if t := oneLine(d.AITitle, DigestTaskMax); t != "" {
		return t, proto.DigestAITitle
	}
	if t := taskFallback(d.Prompt, DigestTaskMax); t != "" {
		return t, proto.DigestPrompt
	}
	return "", ""
}

// DigestTracker follows one transcript's lines (all of them, from its
// start). Not safe for concurrent use.
type DigestTracker struct {
	harness string
	parse   func(int64, []byte) ([]contrib, string)
	d       Digest
	ring    []DigestStep
	msgID   string // Claude: the message the newest step is
	open    bool   // Codex: the newest step takes the calls that follow (until a prompt)
	seq     int
	resets  int
}

// NewDigestTracker follows a harness's (claude or codex) transcript; nil for
// another harness.
func NewDigestTracker(harness string) *DigestTracker {
	if !Supported(harness) {
		return nil
	}
	return &DigestTracker{harness: harness, parse: parserOf(harness)}
}

// Reset forgets everything: the transcript was replaced (or went), or /clear.
func (t *DigestTracker) Reset() {
	t.d, t.ring, t.msgID, t.open = Digest{}, nil, "", false
	t.resets++
	t.seq++
}

// Seq counts the changes of View.
func (t *DigestTracker) Seq() int { return t.seq }

// View is the digest now (a copy).
func (t *DigestTracker) View() Digest {
	d := t.d
	d.Resets = t.resets
	d.Recent = make([]DigestStep, len(t.ring))
	for i, s := range t.ring {
		d.Recent[i] = DigestStep{Texts: append([]string(nil), s.Texts...), Tools: append([]DigestTool(nil), s.Tools...)}
	}
	return d
}

type digestClaudeLine struct {
	Type       string `json:"type"`
	Subtype    string `json:"subtype"`
	AITitle    string `json:"aiTitle"`
	Content    string `json:"content"`
	Timestamp  string `json:"timestamp"`
	CommandRun *struct {
		Command string `json:"command"`
	} `json:"commandRun"`
}

// Line reads one line and its turn events (TurnEvents, read once for all
// the trackers).
func (t *DigestTracker) Line(off int64, b []byte, evs []TurnEvent) {
	if t.harness == Claude {
		if bytes.Contains(b, []byte(`"isSidechain":true`)) {
			return // a subagent's line: not the worker's
		}
		if t.claudeMeta(b) {
			return
		}
	}
	tools := t.tools(off, b)
	for _, ev := range evs {
		switch ev.Kind {
		case TurnPrompt:
			t.prompt(ev.Text)
			t.open = false
		case TurnStarted:
			t.dropRecap()
		case TurnAssistant:
			t.assistant(ev, tools)
			tools = nil
		case TurnDone, TurnComplete:
			t.d.Ended++
			t.seq++
		}
	}
	if len(tools) > 0 && t.harness == Codex { // its calls are lines of their own (Claude's ride on their message)
		t.calls(tools)
	}
}

// claudeMeta reads the metadata and system lines the tracker uses (ai-title,
// away_summary, /clear's local_command); true when the line was one.
func (t *DigestTracker) claudeMeta(b []byte) bool {
	if !bytes.Contains(b, []byte(`"ai-title"`)) && !bytes.Contains(b, []byte(`"away_summary"`)) && !bytes.Contains(b, []byte(`"local_command"`)) {
		return false
	}
	var l digestClaudeLine
	if json.Unmarshal(b, &l) != nil {
		return false
	}
	switch {
	case l.Type == "ai-title":
		if s := strings.TrimSpace(l.AITitle); s != "" && s != t.d.AITitle {
			t.d.AITitle = s
			t.seq++
		}
		return true
	case l.Type == "system" && l.Subtype == "away_summary":
		s := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(l.Content), "(disable recaps in /config)"))
		if s = oneLine(s, DigestNowMax); s != "" {
			t.d.Recap, t.d.RecapAt = s, parseTS(l.Timestamp)
			t.seq++
		}
		return true
	case l.Type == "system" && l.Subtype == "local_command" && l.CommandRun != nil && l.CommandRun.Command == "clear":
		t.Reset()
		return true
	}
	return false
}

// tools are the tool calls a line holds (name and input summary), parsed
// only when the line may have one.
func (t *DigestTracker) tools(off int64, b []byte) []DigestTool {
	if t.harness == Claude && !bytes.Contains(b, []byte(`"tool_use"`)) {
		return nil
	}
	if t.harness == Codex && !bytes.Contains(b, []byte(`_call"`)) {
		return nil
	}
	cs, _ := t.parse(off, b)
	var out []DigestTool
	for k := range cs {
		c := &cs[k]
		if c.link == linkResult || c.link == linkAbort || c.hidden || (c.kind != proto.ItemTool && c.kind != proto.ItemSubagent) {
			continue
		}
		bl := newBuilder(c.id, 0, c)
		bl.add(c)
		if tool := bl.it.Tool; tool != nil && tool.Name != "" {
			out = append(out, DigestTool{Name: tool.Name, Summary: tool.InputSummary})
		}
	}
	return out
}

// prompt takes a genuine prompt: the first one is the task's; a slash
// command counts only with arguments, and /clear starts over.
func (t *DigestTracker) prompt(text string) {
	s, ok := promptText(text)
	if s == "/clear" {
		t.Reset()
		return
	}
	t.dropRecap()
	if !ok || t.d.Prompt != "" {
		return
	}
	if len(s) > digestPromptMax {
		s = cut(s, digestPromptMax)
	}
	sum := sha256.Sum256([]byte(s))
	t.d.Prompt, t.d.PromptHash = s, hex.EncodeToString(sum[:])
	t.seq++
}

func (t *DigestTracker) assistant(ev TurnEvent, tools []DigestTool) {
	var texts []string
	for _, s := range ev.Texts {
		if s = strings.TrimSpace(s); s != "" {
			texts = append(texts, s)
		}
	}
	if len(texts) == 0 && len(tools) == 0 {
		return // a thinking block, an empty message: nothing to keep
	}
	t.dropRecap()
	if t.harness == Claude && ev.MsgID != "" && ev.MsgID == t.msgID && len(t.ring) > 0 {
		t.add(&t.ring[len(t.ring)-1], texts, tools) // the next blocks of the newest step's message
		return
	}
	t.msgID = ev.MsgID
	t.step(texts, tools)
}

// calls takes a Codex line's tool calls: the newest step's while it is open
// (the calls after a message), else a step of their own.
func (t *DigestTracker) calls(tools []DigestTool) {
	t.dropRecap()
	if t.open && len(t.ring) > 0 {
		t.add(&t.ring[len(t.ring)-1], nil, tools)
		return
	}
	t.step(nil, tools)
}

// step starts a new step (the oldest goes when the ring is full).
func (t *DigestTracker) step(texts []string, tools []DigestTool) {
	if len(t.ring) == DigestSteps {
		t.ring = append(t.ring[:0], t.ring[1:]...)
	}
	t.ring = append(t.ring, DigestStep{})
	t.add(&t.ring[len(t.ring)-1], texts, tools)
	t.d.Steps++
	t.open = true
}

func (t *DigestTracker) add(s *DigestStep, texts []string, tools []DigestTool) {
	n := 0
	for _, x := range s.Texts {
		n += len(x)
	}
	for _, x := range texts {
		if n >= digestStepText {
			break
		}
		if n+len(x) > digestStepText {
			x = cut(x, digestStepText-n) + "…"
		}
		s.Texts = append(s.Texts, x)
		n += len(x)
	}
	s.Tools = append(s.Tools, tools...)
	t.seq++
}

func (t *DigestTracker) dropRecap() {
	if t.d.Recap == "" {
		return
	}
	t.d.Recap, t.d.RecapAt = "", 0
	t.seq++
}

// promptText cleans a prompt for the digest; ok false when it is not a
// prompt of a task (a slash command without arguments, a shell escape).
// A /clear comes back as "/clear".
func promptText(text string) (string, bool) {
	s := strings.TrimSpace(systemReminder.ReplaceAllString(text, ""))
	if strings.HasPrefix(s, "<") {
		tags := map[string]string{}
		for _, m := range xmlTag.FindAllStringSubmatch(s, -1) {
			if m[1] == m[3] {
				tags[m[1]] = strings.TrimSpace(m[2])
			}
		}
		if name := tags["command-name"]; name != "" {
			if name == "/clear" {
				return name, false
			}
			args := tags["command-args"]
			if args == "" {
				return "", false
			}
			s = name + " " + args
		} else if tags["bash-input"] != "" {
			return "", false
		}
	}
	s = pastedContent.ReplaceAllString(s, "\n$1\n") // what was pasted, on lines of its own
	s = imageMarker.ReplaceAllString(s, "[image]")
	s = strings.TrimSpace(s)
	return s, s != ""
}

// taskFallback is the task line taken from a prompt without a model (#174):
// its first sentence, on one line, at most max runes; when that sentence says
// nothing of the task ("Please investigate.", "Please create a ticket."), it
// is joined with the sentences after it up to and including the first that
// does, greetings and thanks left out, a leading "please" dropped. A prompt
// with no sentence that says more gives its first one, as before.
func taskFallback(s string, max int) string {
	sentences := promptSentences(s)
	if len(sentences) == 0 {
		return ""
	}
	var parts []string
	runes := 0
	for _, sen := range sentences {
		w := wordsOf(sen)
		if w.empty() && len(parts) == 0 && len(sentences) > 1 {
			continue // a greeting opens nothing
		}
		parts = append(parts, sen)
		runes += utf8.RuneCountInString(sen) + 1
		if !w.thin() || runes > max {
			break
		}
	}
	if len(parts) == 0 { // nothing but greetings: the first sentence, as it was
		parts = sentences[:1]
	}
	line := strings.Join(parts, " ")
	if len(parts) > 1 { // a joined line is a task, not a request: no "please"
		line = strings.TrimSpace(politeLead.ReplaceAllString(line, ""))
		if r, n := utf8.DecodeRuneInString(line); n > 0 && unicode.IsLower(r) {
			line = string(unicode.ToUpper(r)) + line[n:]
		}
	}
	return oneLine(line, max)
}

// politeLead is the "please" a task line does not need.
var politeLead = regexp.MustCompile(`(?i)^(?:please|kindly)[,:]?\s+`)

// The most of a prompt looked at for its sentences.
const (
	taskScanLines = 12
	taskScanBytes = 1500
)

// promptSentences are a prompt's first sentences, in order: each line split
// after ".", "?" or "!" followed by a space or the line's end, a bullet or
// heading mark dropped.
func promptSentences(s string) []string {
	var out []string
	lines, n := 0, 0
	for _, l := range strings.Split(s, "\n") {
		l = strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(l), "#>"))
		l = strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(l, "- "), "* "))
		if l == "" {
			continue
		}
		if lines++; lines > taskScanLines || n > taskScanBytes {
			break
		}
		n += len(l)
		start := 0
		for i := 0; i < len(l); i++ {
			if (l[i] == '.' || l[i] == '?' || l[i] == '!') && (i+1 == len(l) || l[i+1] == ' ') {
				if sen := strings.TrimSpace(l[start : i+1]); sen != "" {
					out = append(out, sen)
				}
				start = i + 1
			}
		}
		if rest := strings.TrimSpace(l[start:]); rest != "" {
			out = append(out, rest)
		}
	}
	return out
}

// sentenceWords counts what a sentence says: the words that are not filler,
// and whether one looks like an identifier (a path, a file, a number, a
// ticket).
type sentenceWords struct {
	content    int
	identifier bool
}

// thin: it says too little to be the task (two content words or fewer, none
// an identifier).
func (w sentenceWords) thin() bool { return w.content <= 2 && !w.identifier }

// empty: nothing but filler, a greeting or thanks.
func (w sentenceWords) empty() bool { return w.content == 0 && !w.identifier }

var taskFiller = func() map[string]bool {
	m := map[string]bool{}
	for _, w := range strings.Fields(`please kindly could can you would will me we us i to the a an this that it these those
		now just also then and or for of in on at with help there here is are do so my our your some any one go ahead
		hi hello hey thanks thank ok okay yes sure`) {
		m[w] = true
	}
	return m
}()

func wordsOf(sen string) sentenceWords {
	var w sentenceWords
	for _, f := range strings.Fields(sen) {
		bare := strings.Trim(f, ".,;:!?\"'()[]")
		if bare == "" {
			continue
		}
		if strings.ContainsAny(bare, "/\\_#@.") || strings.ContainsFunc(bare, unicode.IsDigit) {
			w.identifier = true
		}
		if !taskFiller[strings.ToLower(bare)] {
			w.content++
		}
	}
	return w
}

// oneLine is s on one line (runs of whitespace as one space), at most max
// runes with "…".
func oneLine(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) > max {
		s = strings.TrimSpace(string([]rune(s)[:max-1])) + "…"
	}
	return s
}
