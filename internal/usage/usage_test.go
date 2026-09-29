package usage

import (
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// The fixtures in testdata are synthetic (no real transcript content):
// the research's hand-computed files.
const (
	claudeID = "11111111-1111-4111-8111-111111111111"
	codexID  = "22222222-2222-4222-8222-222222222222"
)

var t0 = time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func pctOf(u proto.Usage) float64 {
	if u.ContextPct == nil {
		return -1
	}
	return *u.ContextPct
}

func poll(t *testing.T, s *Session, at time.Time) proto.Usage {
	t.Helper()
	u, ok := s.Poll(at)
	if !ok {
		t.Fatal("transcript not found")
	}
	return u
}

// Claude: msg_a's two records count once (its last: 200 output, not 20 +
// 200), the subagent's message is added, and the cost is the cost-state's
// (which includes the subagent: nothing is added on top of it).
func TestClaudeFixture(t *testing.T) {
	s := NewSession(Claude, claudeID, Roots{ClaudeProjects: "testdata/claude/projects"}, DefaultPricing())
	u := poll(t, s, t0)
	// Hand-computed (USD per million tokens): Opus 5.5 main 150 in × 4 +
	// 600 5m writes × 5 + 400 1h writes × 8 + 21000 reads × 0.20 + 300 out
	// × 20, Haiku 4.5 subagent 40 × 1 + 500 × 1.25 + 1000 × 0.10 + 80 × 5.
	wantCost := (150*4 + 600*5 + 400*8 + 21000*0.20 + 300*20 + 40*1 + 500*1.25 + 1000*0.10 + 80*5) / 1e6 // 0.018165
	want := proto.Usage{Tokens: 190 + 380 + 1500, Input: 190, Output: 380, CacheWrite: 1500, CacheRead: 22000,
		CostUSDEst: 0.018165, Priced: proto.PricedKnown, Model: "claude-opus-5-5", ContextWindow: 1_000_000}
	if !near(wantCost, 0.018165) {
		t.Fatalf("hand-computed %v", wantCost)
	}
	got := u
	got.ContextPct = nil
	if got != want {
		t.Fatalf("usage = %+v\nwant    %+v", got, want)
	}
	// The main transcript's last prompt: (50 + 0 + 12000) / 1M = 1.205 %.
	if p := pctOf(u); p != 1.2 {
		t.Errorf("context_pct = %v, want 1.2", p)
	}

	// Without the cost-state line, the estimate from the table is the same.
	dir := t.TempDir()
	proj := filepath.Join(dir, "proj")
	copyTree(t, "testdata/claude/projects/-synthetic-workspace", proj)
	main := filepath.Join(proj, claudeID+".jsonl")
	b, _ := os.ReadFile(main)
	lines := strings.SplitAfter(strings.TrimSuffix(string(b), "\n"), "\n")
	writeFile(t, main, strings.Join(lines[:len(lines)-1], "")+"\n")
	u = poll(t, NewSession(Claude, claudeID, Roots{ClaudeProjects: dir}, DefaultPricing()), t0)
	if !near(u.CostUSDEst, wantCost) || u.Tokens != want.Tokens || u.Priced != proto.PricedKnown {
		t.Errorf("without cost-state: %+v", u)
	}
}

// A cost-state is Claude Code's own cost up to it (it also counts side
// calls the transcript does not show). Messages after it, in the main
// transcript or a subagent's, are estimated on top.
func TestClaudeCostStateSnapshot(t *testing.T) {
	dir := t.TempDir()
	proj := filepath.Join(dir, "p")
	main := filepath.Join(proj, claudeID+".jsonl")
	sub := filepath.Join(proj, claudeID, "subagents", "agent-a1.jsonl")
	writeFile(t, main, assistant("m1", "claude-opus-5-5", "2026-09-29T10:00:00Z", 1000, 100, 0, 0)+
		`{"type":"cost-state","sessionId":"`+claudeID+`","totalCostUSD":0.5,"hasUnknownModelCost":false,"modelUsage":{}}`+"\n"+
		`{"type":"user","message":{"content":"resumed"},"timestamp":"2026-09-29T11:00:00Z"}`+"\n"+
		assistant("m2", "claude-opus-5-5", "2026-09-29T11:00:01Z", 2000, 200, 0, 0))
	writeFile(t, sub, assistant("s1", "claude-haiku-4-5-20251001", "2026-09-29T09:59:00Z", 500, 50, 0, 0)+
		assistant("s2", "claude-haiku-4-5-20251001", "2026-09-29T11:00:05Z", 700, 70, 0, 0))
	s := NewSession(Claude, claudeID, Roots{ClaudeProjects: dir}, DefaultPricing())
	u := poll(t, s, t0)
	// 0.5 + m2 (2000 × 4 + 200 × 20) + s2 (700 × 1 + 70 × 5); m1 and s1 are
	// in the snapshot.
	want := 0.5 + (2000*4+200*20)/1e6 + (700*1+70*5)/1e6
	if !near(u.CostUSDEst, roundCost(want)) || u.Input != 1000+2000+500+700 || u.Output != 420 {
		t.Fatalf("usage = %+v, want cost %v", u, want)
	}
	// A newer cost-state (the session exited again) covers everything.
	appendFile(t, main, `{"type":"cost-state","totalCostUSD":0.75,"hasUnknownModelCost":true}`+"\n")
	if u = poll(t, s, t0.Add(time.Second)); u.CostUSDEst != 0.75 || u.Priced != proto.PricedUnknownModel {
		t.Fatalf("after a new cost-state: %+v", u)
	}
}

// Codex: the last token_count with info wins (reasoning is already in the
// output), an info-less one changes nothing, and growth after a model
// switch is priced at the new model.
func TestCodexFixture(t *testing.T) {
	dir := t.TempDir()
	copyTree(t, "testdata/codex/sessions", dir)
	s := NewSession(Codex, codexID, Roots{CodexSessions: dir}, DefaultPricing())
	u := poll(t, s, t0)
	// GPT-6 Sol: (100000 − 60000 cached) × 2 + 60000 × 0.20 + 10000 × 10.
	want := proto.Usage{Tokens: 40000 + 10000, Input: 40000, Output: 10000, CacheRead: 60000, CostUSDEst: 0.192,
		Priced: proto.PricedKnown, Model: "gpt-6-sol", ContextWindow: 258400}
	got := u
	got.ContextPct = nil
	if !near((40000*2+60000*0.20+10000*10)/1e6, 0.192) || got != want {
		t.Fatalf("usage = %+v\nwant    %+v", got, want)
	}
	// Codex's own formula: (50000 − 12000) / (258400 − 12000) = 15.42 %.
	if p := pctOf(u); p != 15.4 {
		t.Errorf("context_pct = %v, want 15.4", p)
	}
	path := filepath.Join(dir, "2026", "09", "29", "rollout-2026-09-29T00-00-00-"+codexID+".jsonl")
	appendFile(t, path, `{"type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{}}}`+"\n")
	if again := poll(t, s, t0.Add(time.Second)); again.Tokens != u.Tokens || !near(again.CostUSDEst, u.CostUSDEst) {
		t.Fatalf("info null changed the usage: %+v", again)
	}
	appendFile(t, path, `{"type":"turn_context","payload":{"model":"gpt-6-luna"}}`+"\n"+
		tokenCount(110000, 60000, 12000, 120000, 5000))
	u = poll(t, s, t0.Add(2*time.Second))
	// + 10000 uncached input × 0.10 + 2000 output × 0.50 at Luna.
	if !near(u.CostUSDEst, roundCost(0.192+(10000*0.10+2000*0.50)/1e6)) || u.Model != "gpt-6-luna" || u.Tokens != 50000+12000 {
		t.Fatalf("after the switch: %+v", u)
	}
	// Counters that go down (a reset) start over, all at the current model.
	appendFile(t, path, tokenCount(1000, 0, 100, 1100, 1100))
	if u = poll(t, s, t0.Add(3*time.Second)); !near(u.CostUSDEst, roundCost((1000*0.10+100*0.50)/1e6)) || u.Tokens != 1100 {
		t.Fatalf("after a reset: %+v", u)
	}
}

// An unknown model is priced as the harness's most expensive known model
// and flagged; its context window is unknown.
func TestUnknownModel(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "p", claudeID+".jsonl"), assistant("m1", "claude-opus-9", "", 1000, 100, 0, 2000))
	u := poll(t, NewSession(Claude, claudeID, Roots{ClaudeProjects: dir}, DefaultPricing()), t0)
	// Fable 5.1: 1000 × 10 + 100 × 50 + 2000 × 0.25.
	if u.Priced != proto.PricedUnknownModel || !near(u.CostUSDEst, (1000*10+100*50+2000*0.25)/1e6) || u.ContextPct != nil ||
		u.ContextWindow != 0 || u.Model != "claude-opus-9" {
		t.Fatalf("claude = %+v", u)
	}
	// With the 1M suffix the window is known; the model is still unknown.
	writeFile(t, filepath.Join(dir, "p", claudeID+".jsonl"), assistant("m1", "claude-opus-5-5[1m]", "", 1000, 100, 0, 499000))
	if u = poll(t, NewSession(Claude, claudeID, Roots{ClaudeProjects: dir}, DefaultPricing()), t0); u.Priced != proto.PricedKnown ||
		pctOf(u) != 50 || u.ContextWindow != 1_000_000 {
		t.Fatalf("[1m] = %+v", u)
	}

	rollout := filepath.Join(dir, "codex", "2026", "09", "29", "rollout-x-"+codexID+".jsonl")
	writeFile(t, rollout, `{"type":"session_meta","payload":{"id":"`+codexID+`","cwd":"/w"}}`+"\n"+
		`{"type":"turn_context","payload":{"model":"gpt-9"}}`+"\n"+tokenCount(1000, 0, 100, 1100, 1100))
	u = poll(t, NewSession(Codex, codexID, Roots{CodexSessions: filepath.Join(dir, "codex")}, DefaultPricing()), t0)
	// GPT-6 Astra: 1000 × 10 + 100 × 50.
	if u.Priced != proto.PricedUnknownModel || !near(u.CostUSDEst, (1000*10+100*50)/1e6) {
		t.Fatalf("codex = %+v", u)
	}
	// No model at all: nothing to price.
	writeFile(t, filepath.Join(dir, "q", "33333333-3333-4333-8333-333333333333.jsonl"), `{"type":"user"}`+"\n")
	if u = poll(t, NewSession(Claude, "33333333-3333-4333-8333-333333333333", Roots{ClaudeProjects: dir}, DefaultPricing()), t0); u.Priced != proto.PricedNone || u.Tokens != 0 {
		t.Fatalf("empty = %+v", u)
	}
}

// Tailing reads only what was appended, keeps a partial last line for the
// next read, and starts over when the file is truncated or replaced.
func TestTailIncremental(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "p", claudeID+".jsonl")
	first := assistant("m1", "claude-opus-5-5", "", 100, 10, 0, 0) + `{"type":"user","message":{"content":"x"}}` + "\n"
	writeFile(t, path, first)
	s := NewSession(Claude, claudeID, Roots{ClaudeProjects: dir}, DefaultPricing())
	if u := poll(t, s, t0); u.Input != 100 || s.BytesRead() != int64(len(first)) {
		t.Fatalf("first read: %+v, %d bytes", u, s.BytesRead())
	}
	line := assistant("m2", "claude-opus-5-5", "", 200, 20, 0, 0)
	appendFile(t, path, line)
	if u := poll(t, s, t0.Add(time.Second)); u.Input != 300 || s.BytesRead() != int64(len(first)+len(line)) {
		t.Fatalf("after one line: %+v, read %d bytes, want %d", u, s.BytesRead(), len(first)+len(line))
	}
	// Half a line: read, not counted; the rest completes it.
	next := assistant("m3", "claude-opus-5-5", "", 400, 40, 0, 0)
	appendFile(t, path, next[:30])
	if u := poll(t, s, t0.Add(2*time.Second)); u.Input != 300 {
		t.Fatalf("partial line counted: %+v", u)
	}
	appendFile(t, path, next[30:])
	if u := poll(t, s, t0.Add(3*time.Second)); u.Input != 700 || s.BytesRead() != int64(len(first)+len(line)+len(next)) {
		t.Fatalf("completed line: %+v, %d bytes", u, s.BytesRead())
	}
	// Nothing new: nothing read.
	before := s.BytesRead()
	if poll(t, s, t0.Add(4*time.Second)); s.BytesRead() != before {
		t.Fatalf("read %d bytes of nothing", s.BytesRead()-before)
	}
	// Truncated to a shorter file: counted from scratch.
	short := assistant("m9", "claude-opus-5-5", "", 5, 1, 0, 0)
	writeFile(t, path, short)
	if u := poll(t, s, t0.Add(5*time.Second)); u.Input != 5 || u.Output != 1 {
		t.Fatalf("after truncation: %+v", u)
	}
	// Replaced by another file (even a longer one): from scratch too.
	repl := filepath.Join(dir, "new")
	writeFile(t, repl, short+assistant("m8", "claude-opus-5-5", "", 7, 1, 0, 0)+strings.Repeat(" ", 4096)+"\n")
	if err := os.Rename(repl, path); err != nil {
		t.Fatal(err)
	}
	if u := poll(t, s, t0.Add(6*time.Second)); u.Input != 12 || u.Output != 2 {
		t.Fatalf("after replacement: %+v", u)
	}
	// Gone: what was counted stays; back (after MissRescan): counted afresh.
	if err := os.Rename(path, repl); err != nil {
		t.Fatal(err)
	}
	if u := poll(t, s, t0.Add(7*time.Second)); u.Input != 12 {
		t.Fatalf("while gone: %+v", u)
	}
	writeFile(t, path, assistant("m7", "claude-opus-5-5", "", 3, 1, 0, 0))
	if u := poll(t, s, t0.Add(7*time.Second+MissRescan)); u.Input != 3 || u.Output != 1 {
		t.Fatalf("found again: %+v", u)
	}
}

// A transcript is looked for again at most every MissRescan; a symlink is
// never read.
func TestSessionFind(t *testing.T) {
	dir := t.TempDir()
	s := NewSession(Claude, claudeID, Roots{ClaudeProjects: dir}, DefaultPricing())
	if _, ok := s.Poll(t0); ok {
		t.Fatal("found a missing transcript")
	}
	writeFile(t, filepath.Join(dir, "p", claudeID+".jsonl"), assistant("m1", "claude-opus-5-5", "", 1, 1, 0, 0))
	if _, ok := s.Poll(t0.Add(MissRescan / 2)); ok {
		t.Fatal("looked again before MissRescan")
	}
	if u, ok := s.Poll(t0.Add(MissRescan)); !ok || u.Input != 1 {
		t.Fatalf("after MissRescan: %+v %v", u, ok)
	}

	other := t.TempDir()
	writeFile(t, filepath.Join(other, "real.jsonl"), assistant("m1", "claude-opus-5-5", "", 1, 1, 0, 0))
	if err := os.MkdirAll(filepath.Join(dir, "q"), 0o755); err != nil {
		t.Fatal(err)
	}
	link := "44444444-4444-4444-8444-444444444444"
	if err := os.Symlink(filepath.Join(other, "real.jsonl"), filepath.Join(dir, "q", link+".jsonl")); err != nil {
		t.Fatal(err)
	}
	if _, ok := NewSession(Claude, link, Roots{ClaudeProjects: dir}, DefaultPricing()).Poll(t0); ok {
		t.Fatal("followed a symlink")
	}
	for _, id := range []string{"../x", "", "a/b"} {
		if NewSession(Claude, id, Roots{}, DefaultPricing()) != nil {
			t.Errorf("session id %q accepted", id)
		}
	}
	if NewSession("gemini", claudeID, Roots{}, DefaultPricing()) != nil {
		t.Error("unknown harness accepted")
	}
}

// Old message ids are forgotten beyond MaxMessages; their tokens stay.
func TestClaudeForgetsOldIDs(t *testing.T) {
	c := newClaudeUsage()
	for i := range MaxMessages + 10 {
		c.line(true, []byte(assistant("m"+strconv.Itoa(i), "claude-opus-5-5", "", 1, 0, 0, 0)))
	}
	if len(c.msgs) != MaxMessages || c.usage(DefaultPricing()).Input != MaxMessages+10 {
		t.Fatalf("%d ids kept, input %d", len(c.msgs), c.usage(DefaultPricing()).Input)
	}
}

func TestPricing(t *testing.T) {
	p := DefaultPricing()
	if p.top[Claude] != "claude-fable-5-1" || p.top[Codex] != "gpt-6-astra" {
		t.Fatalf("most expensive = %v", p.top)
	}
	dir := t.TempDir()
	good := filepath.Join(dir, "p.json")
	writeFile(t, good, `{"models":{"claude-opus-5":{"input":5,"output":25,"cache_write":6.25,"cache_read":0.5,"context_window":1000000},
		"claude-opus-5-5":{"harness":"claude","input":1,"output":2,"cache_write":3,"cache_read":0.1},
		"my-model":{"input":100,"output":1000,"cache_write":0,"cache_read":0}}}`)
	p, err := LoadPricing(good)
	if err != nil {
		t.Fatal(err)
	}
	if pr, ok := p.Lookup(Claude, "claude-opus-5"); !ok || pr.Harness != Claude || pr.write1h() != 6.25 {
		t.Errorf("added model = %+v %v", pr, ok)
	}
	if pr, _ := p.Lookup(Claude, "claude-opus-5-5"); pr.Input != 1 || pr.ContextWindow != 0 {
		t.Errorf("replaced model = %+v", pr)
	}
	if pr, ok := p.Lookup(Claude, "claude-haiku-4-5-20251001"); !ok || pr.Input != 1 {
		t.Errorf("kept model = %+v", pr)
	}
	if _, ok := p.Lookup(Claude, "my-model"); ok || p.top[Codex] != "my-model" {
		t.Errorf("a codex model priced for claude, or not the dearest: %v", p.top)
	}
	for name, body := range map[string]string{
		"negative": `{"models":{"x":{"input":-1,"output":1,"cache_write":1,"cache_read":1}}}`,
		"unknown":  `{"models":{"x":{"input":1,"outptu":1}}}`,
		"harness":  `{"models":{"x":{"harness":"gemini","input":1}}}`,
		"window":   `{"models":{"x":{"input":1,"context_window":-5}}}`,
		"json":     `{"models":`,
	} {
		path := filepath.Join(dir, name+".json")
		writeFile(t, path, body)
		if _, err := LoadPricing(path); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func assistant(id, model, ts string, input, output, write, read int64) string {
	tsField := ""
	if ts != "" {
		tsField = `"timestamp":"` + ts + `",`
	}
	return `{"type":"assistant",` + tsField + `"message":{"id":"` + id + `","model":"` + model + `","usage":{"input_tokens":` +
		itoa(input) + `,"output_tokens":` + itoa(output) + `,"cache_creation_input_tokens":` + itoa(write) +
		`,"cache_read_input_tokens":` + itoa(read) + `},"content":[]}}` + "\n"
}

func tokenCount(input, cached, output, total, last int64) string {
	u := func(in, c, o, tot int64) string {
		return `{"input_tokens":` + itoa(in) + `,"cached_input_tokens":` + itoa(c) + `,"cache_write_input_tokens":0,"output_tokens":` +
			itoa(o) + `,"reasoning_output_tokens":0,"total_tokens":` + itoa(tot) + `}`
	}
	return `{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":` + u(input, cached, output, total) +
		`,"last_token_usage":` + u(last, 0, 0, last) + `,"model_context_window":258400}}}` + "\n"
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func appendFile(t *testing.T, path, content string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(content); err != nil {
		t.Fatal(err)
	}
}

func copyTree(t *testing.T, from, to string) {
	t.Helper()
	if err := os.CopyFS(to, os.DirFS(from)); err != nil {
		t.Fatal(err)
	}
}
