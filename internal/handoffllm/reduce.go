package handoffllm

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/jsonl"
)

// Input is one reduction request: an immutable snapshot of a worker's
// main-session transcript that ends at a completed turn.
type Input struct {
	Harness string      // "claude" or "codex"
	Path    string      // the main-session JSONL (never a subagent/sidechain file)
	File    fs.FileInfo // the file as the bridge's tail saw it; a replaced/truncated file => ErrChanged
	Through int64       // snapshot end (byte offset): transcript.Candidate.Through of the current candidate
	Budget  int         // max bytes of Payload.Text
	Secrets []string    // extra literal secrets to scrub (e.g. the configured API key)
}

// Payload is the reduced, scrubbed transcript data to embed (as untrusted
// data) in the prompt.
type Payload struct {
	Text       string // reduced transcript, message-delimited; never cut inside a rune or a kept message
	Bytes      int    // len(Text)
	EstTokens  int    // conservative token estimate of Text (EstimateTokens)
	Coverage   Coverage
	Artifacts  []Artifact     // references actually observed in the snapshot
	Redactions map[string]int // category -> count; never the secret text
}

// Coverage says what of the snapshot made it into Payload.Text.
type Coverage struct {
	Messages     int      // main-thread messages in the snapshot after branch selection + dedup
	Kept         int      // messages (wholly or excerpted) in Text
	Omitted      []Range  // what was left out, for preview/provenance
	Compaction   string   // "none" | "claude_summary" | "codex_retained" | "opaque" | "missing"
	Gaps         []string // human-readable coverage gaps
	Abandoned    int      // rows on abandoned branches left out
	Sidechains   int      // sidechain/subagent rows left out
	Deduplicated int      // duplicate/streamed copies merged
	Skipped      int      // unreadable/oversized lines skipped
	Complete     bool     // true only when nothing material was omitted and no gap exists
}

// Range is a run of message ordinals left out of Text.
type Range struct {
	From, To int    // message ordinals (1-based, inclusive) within Coverage.Messages
	Why      string // short reason, e.g. "older assistant detail", "tool output"
}

// Artifact is a reference observed in the snapshot.
type Artifact struct {
	Kind     string // "file" | "commit" | "pr" | "issue" | "url" | "test"
	Ref      string // path, sha, URL, test name… (scrubbed)
	Verified bool   // true only when a result shows success; tool-call intent alone is false
}

var (
	// ErrChanged reports that the file was replaced/truncated/is not the snapshot any more.
	ErrChanged = errors.New("handoffllm: transcript changed since the snapshot")
	// ErrTooLarge reports that the pinned content (first goal, user corrections,
	// final reply) cannot fit the budget.
	ErrTooLarge = errors.New("handoffllm: pinned transcript content exceeds the budget")
	// ErrUnsupported reports an unknown harness or transcript format.
	ErrUnsupported = errors.New("handoffllm: unsupported transcript")
)

// Compaction states (Coverage.Compaction).
const (
	CompactionNone          = "none"
	CompactionClaudeSummary = "claude_summary"
	CompactionCodexRetained = "codex_retained"
	CompactionOpaque        = "opaque"
	CompactionMissing       = "missing"
)

// Harnesses Reduce reads.
const (
	harnessClaude = "claude"
	harnessCodex  = "codex"
)

// readChunk is how much of the transcript one read takes.
const readChunk = 256 << 10

// lineParser reads one harness's transcript lines (line: false when a line is
// not readable JSON) and then builds the main thread's messages.
type lineParser interface {
	line(off int64, b []byte) bool
	build(b *builder) error
}

// Reduce reads the snapshot described by in (the main-session transcript
// up to in.Through, never past it) and returns it reduced to at most
// in.Budget bytes of scrubbed, message-delimited text, with what it covers.
// See the package documentation for the policy.
func Reduce(ctx context.Context, in Input) (Payload, error) {
	var p lineParser
	switch in.Harness {
	case harnessClaude:
		if filepath.Base(filepath.Dir(in.Path)) == "subagents" {
			return Payload{}, fmt.Errorf("%w: %s is a subagent transcript", ErrUnsupported, filepath.Base(in.Path))
		}
		p = newClaudeParser()
	case harnessCodex:
		p = newCodexParser()
	default:
		return Payload{}, fmt.Errorf("%w: harness %q", ErrUnsupported, in.Harness)
	}
	if in.Budget <= 0 {
		return Payload{}, fmt.Errorf("%w: budget %d", ErrTooLarge, in.Budget)
	}
	skipped, err := readSnapshot(ctx, in, p.line)
	if err != nil {
		return Payload{}, err
	}
	b := newBuilder(in.Secrets)
	if err := p.build(b); err != nil {
		return Payload{}, err
	}
	b.finish()
	if b.messages == 0 {
		return Payload{}, fmt.Errorf("%w: no conversation in the snapshot", ErrUnsupported)
	}
	if err := ctx.Err(); err != nil {
		return Payload{}, err
	}
	text, kept, omitted, red, err := fit(ctx, b.entries, in.Budget, in.Secrets)
	if err != nil {
		return Payload{}, err
	}
	cov := b.cov
	cov.Messages, cov.Kept, cov.Omitted = b.messages, kept, omitted
	cov.Skipped += skipped
	if cov.Skipped > 0 {
		cov.Gaps = append(cov.Gaps, plural(cov.Skipped, "unreadable or oversized transcript line")+" skipped")
	}
	if cov.Compaction == "" {
		cov.Compaction = CompactionNone
	}
	cov.Complete = len(cov.Omitted) == 0 && len(cov.Gaps) == 0 && cov.Skipped == 0
	addCounts(red, b.artRed)
	return Payload{
		Text:       text,
		Bytes:      len(text),
		EstTokens:  EstimateTokens(text),
		Coverage:   cov,
		Artifacts:  b.arts.list,
		Redactions: red,
	}, nil
}

// readSnapshot hands fn every line of the transcript up to in.Through, after
// checking the file is the one the snapshot was taken of (the same file,
// not shorter than the snapshot). It returns how many lines were skipped:
// over jsonl.MaxLine (never handed out) or not readable JSON.
func readSnapshot(ctx context.Context, in Input, fn func(off int64, b []byte) bool) (int, error) {
	if in.File == nil {
		return 0, fmt.Errorf("%w: no file identity for the snapshot", ErrChanged)
	}
	if in.Through <= 0 {
		return 0, fmt.Errorf("%w: empty snapshot", ErrUnsupported)
	}
	f, fi, err := jsonl.Open(in.Path)
	if errors.Is(err, fs.ErrNotExist) {
		return 0, fmt.Errorf("%w: %v", ErrChanged, err)
	}
	if err != nil {
		return 0, err
	}
	defer f.Close()
	if !os.SameFile(in.File, fi) || fi.Size() < in.Through {
		return 0, fmt.Errorf("%w: the file was replaced or truncated", ErrChanged)
	}
	skipped := 0
	expect := int64(0)
	next, err := jsonl.Scan(f, 0, in.Through, readChunk, func(off int64, line []byte) {
		if off != expect {
			skipped++ // a line over jsonl.MaxLine was dropped before this one
		}
		expect = off + int64(len(line)) + 1
		if len(bytes.TrimSpace(line)) > 0 && !fn(off, line) {
			skipped++
		}
	}, ctx.Err)
	if err != nil {
		return 0, err
	}
	if next != in.Through {
		return 0, fmt.Errorf("%w: the file ends before the snapshot", ErrChanged)
	}
	if expect != in.Through {
		skipped++ // the snapshot's last line was over jsonl.MaxLine
	}
	return skipped, nil
}

// Roles of a message.
const (
	roleUser      = "user"
	roleAssistant = "assistant"
	roleSummary   = "summary" // a compaction summary
)

// msg is one main-thread message of the snapshot, after branch selection
// and deduplication.
type msg struct {
	role   string
	ts     string
	raw    strings.Builder // the text as read (finish cleans and scrubs it into text)
	text   string
	red    map[string]int // the text's redactions
	images int
	tools  []*tool
	// retained: a Codex user message kept across a compaction (read from
	// the compaction's replacement history).
	retained bool
	// early: a Claude prompt from before the compaction summary that seeds
	// the rest (kept while it fits, never pinned).
	early bool
	// turnFinal: a turn's final reply; final: the snapshot's (pinned).
	turnFinal, final bool
}

func (m *msg) label() string {
	switch {
	case m.role == roleSummary:
		return "compaction summary"
	case m.retained:
		return "user (kept across compaction)"
	case m.early:
		return "user (before compaction)"
	case m.final:
		return "assistant (final reply)"
	}
	return m.role
}

func (m *msg) addText(s string) {
	if strings.TrimSpace(s) == "" {
		return
	}
	if m.raw.Len() > 0 {
		m.raw.WriteByte('\n')
	}
	m.raw.WriteString(s)
}

func (m *msg) hasEvidence() bool {
	for _, t := range m.tools {
		if len(t.evidence) > 0 {
			return true
		}
	}
	return false
}

// tool is a tool call of an assistant message: its name, input summary,
// result status and the bounded evidence kept from its result.
type tool struct {
	name, input string
	status      string // "" (no result read) or a status of the result (statusOK…, "exit N")
	failing     bool   // the result showed a failure
	exit        *int   // the exit status the harness reported apart from the result
	evidence    []string
	red, evRed  map[string]int
	// What the call would produce (files it edits, the test run it is):
	// verified only when its result shows success, never when it shows
	// nothing (still running, no output).
	files []string
	test  string
}

// entry is a message or a note (a coverage remark at its place, e.g. where
// the conversation was compacted).
type entry struct {
	m    *msg
	note string
}

// builder collects the main thread's messages in order, harness-neutral.
type builder struct {
	secrets  []string
	entries  []entry
	messages int
	cov      Coverage
	arts     artifacts
	artRed   map[string]int
	calls    map[string]*tool
}

func newBuilder(secrets []string) *builder {
	return &builder{secrets: secrets, calls: map[string]*tool{}, artRed: map[string]int{}}
}

func (b *builder) add(m *msg) *msg {
	b.entries = append(b.entries, entry{m: m})
	b.messages++
	return m
}

// user adds a user message (nil when it holds nothing).
func (b *builder) user(text, ts string, images int) *msg {
	if strings.TrimSpace(text) == "" && images == 0 {
		return nil
	}
	m := &msg{role: roleUser, ts: stamp(ts), images: images}
	m.addText(text)
	return b.add(m)
}

// early adds a person's prompt from before a compaction summary.
func (b *builder) early(text, ts string) {
	if m := b.user(text, ts, 0); m != nil {
		m.early = true
	}
}

func (b *builder) assistant(ts string) *msg {
	return b.add(&msg{role: roleAssistant, ts: stamp(ts)})
}

func (b *builder) summary(text, ts string) {
	m := &msg{role: roleSummary, ts: stamp(ts)}
	m.addText(text)
	b.add(m)
}

func (b *builder) note(text string) {
	b.entries = append(b.entries, entry{note: text})
}

func (b *builder) gap(text string) {
	for _, g := range b.cov.Gaps {
		if g == text {
			return
		}
	}
	b.cov.Gaps = append(b.cov.Gaps, text)
}

// call adds a tool call to m (an assistant message).
func (b *builder) call(m *msg, id, name, input string) *tool {
	t := &tool{name: name, input: input}
	m.tools = append(m.tools, t)
	if id != "" {
		b.calls[id] = t
	}
	return t
}

// editsFiles marks a call as one that changes files: they are artifacts,
// verified when its result shows it succeeded.
func (b *builder) editsFiles(t *tool, files ...string) {
	for _, f := range files {
		if f = strings.TrimSpace(f); f != "" {
			t.files = append(t.files, f)
			b.arts.add("file", f, false)
		}
	}
}

// runsTests marks a call that runs a test command.
func (b *builder) runsTests(t *tool, cmd string) {
	if testCmd.MatchString(cmd) {
		t.test = cmd
		b.arts.add("test", cmd, false)
	}
}

// result reads a tool's result into the call's status and evidence; the
// artifacts it shows (commits, pull requests) are verified, and the call's
// own when the result shows it succeeded (a test: that it ran and passed).
func (b *builder) result(id, text string, failed bool) {
	t := b.calls[id]
	if t == nil {
		return
	}
	ev := readEvidence(text, failed)
	t.status, t.evidence, t.failing = ev.status, ev.lines, ev.failing
	if t.exit != nil {
		b.exited(t) // the exit came first
		return
	}
	for _, f := range t.files {
		b.arts.add("file", f, ev.ok())
	}
	if t.test != "" {
		b.arts.set("test", t.test, ev.testPassed())
	}
	for _, c := range ev.commits {
		b.arts.add("commit", c, true)
	}
	for _, u := range ev.urls {
		b.arts.add(urlKind(u), u, true)
	}
}

// exit records an exit status a harness reported apart from the output
// (Codex's exec_command_end): the command ended, whatever its output said.
func (b *builder) exit(id string, code int) {
	t := b.calls[id]
	if t == nil {
		return
	}
	t.exit = &code
	b.exited(t)
}

// exited settles a call by its reported exit: an exit 0 is a success unless
// its output showed a failure.
func (b *builder) exited(t *tool) {
	ok := *t.exit == 0 && !t.failing
	switch {
	case *t.exit != 0:
		t.status = fmt.Sprintf("exit %d", *t.exit)
	case ok:
		t.status = statusOK
	}
	for _, f := range t.files {
		b.arts.add("file", f, ok)
	}
	if t.test != "" {
		b.arts.set("test", t.test, ok)
	}
}

// finish marks the final reply, then cleans and scrubs every kept string
// (the text whole, then again after a clip) and the artifacts' refs.
func (b *builder) finish() {
	for i := len(b.entries) - 1; i >= 0; i-- {
		if m := b.entries[i].m; m != nil && m.role == roleAssistant && strings.TrimSpace(m.raw.String()) != "" {
			m.final = true
			break
		}
	}
	for _, e := range b.entries {
		if e.m == nil {
			continue
		}
		m := e.m
		m.text, m.red = Scrub(clean(strings.TrimSpace(m.raw.String())), b.secrets...)
		m.raw.Reset()
		if m.role != roleSummary {
			for _, u := range prURL.FindAllString(m.text, 32) {
				b.arts.add(urlKind(u), u, false)
			}
		}
		for _, t := range m.tools {
			t.red = map[string]int{}
			t.name = b.line(t.name, 80, t.red)
			t.input = b.line(t.input, maxInput, t.red)
			t.evRed = map[string]int{}
			for i, l := range t.evidence {
				t.evidence[i] = b.line(l, maxEvidenceLine, t.evRed)
			}
		}
	}
	for i := range b.arts.list {
		b.arts.list[i].Ref = b.line(b.arts.list[i].Ref, maxRef, b.artRed)
	}
}

// Bounds of the one-line pieces of a message.
const (
	maxInput        = 300 // a tool call's input summary
	maxEvidenceLine = 200 // a line of a tool result
	maxRef          = 300 // an artifact's ref
)

// line is s as one clean line of at most n bytes: scrubbed whole, clipped,
// scrubbed again (a secret cut by the clip was already gone); counts go to
// red.
func (b *builder) line(s string, n int, red map[string]int) string {
	s = strings.Join(strings.Fields(clean(s)), " ")
	s, r := Scrub(s, b.secrets...)
	addCounts(red, r)
	s, r = Scrub(clip(s, n), b.secrets...)
	addCounts(red, r)
	return s
}

var delimLine = regexp.MustCompile(`(?m)^===`)

// clean makes text safe to embed: valid UTF-8, no control characters but
// newline and tab (no carriage returns, escape sequences, bidi overrides),
// and no line that starts like the Text's own delimiter lines ("===").
func clean(s string) string {
	s = strings.ToValidUTF8(s, "�")
	s = strings.Map(func(r rune) rune {
		switch {
		case r == '\n' || r == '\t':
			return r
		case r == ' ' || r == ' ':
			return '\n'
		case r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0),
			r >= 0x202a && r <= 0x202e, r >= 0x2066 && r <= 0x2069, r == 0xfeff:
			return -1
		}
		return r
	}, s)
	return delimLine.ReplaceAllString(s, " ===")
}

// stamp is a line's timestamp as UTC seconds ("" when it has none).
func stamp(ts string) string {
	t, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		return ""
	}
	return t.UTC().Format("2006-01-02T15:04:05Z")
}

// norm is text compared for duplicates: its words.
func norm(s string) string { return strings.Join(strings.Fields(s), " ") }
