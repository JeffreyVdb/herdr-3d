package transcript

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// row is what a test checks of a tool row (#132).
type row struct{ summary, status, body string }

// rowsOf are the tool rows of items, by id.
func rowsOf(its []proto.TranscriptItem) map[string]row {
	m := map[string]row{}
	for _, it := range its {
		if t := it.Tool; t != nil {
			m[it.ID] = row{t.InputSummary, t.Status, t.OutputText}
		}
	}
	return m
}

func checkRows(t *testing.T, name string, got map[string]row, want map[string]row) {
	t.Helper()
	for id, w := range want {
		g, ok := got[id]
		switch {
		case !ok:
			t.Errorf("%s: no row %s", name, id)
		case g.summary != w.summary || g.status != w.status || (w.body != "" && g.body != w.body):
			t.Errorf("%s: %s = %+v, want %+v", name, id, g, w)
		}
	}
}

// #132: a poll of a background terminal names the command it waits on and
// what happened; the raw script stays the row's input.
func TestCodexPolls(t *testing.T) {
	its := items(t, Codex, "polls.jsonl")
	checkRows(t, "code mode", rowsOf(its), map[string]row{
		"call_p132start2":    {"pnpm exec vitest run (+1 more)", proto.ToolOK, ""},
		"call_p132running":   {"Waited for pnpm exec vitest run · still running · 30s", proto.ToolOK, " ✓ src/tide.test.ts (12 tests) 41ms"},
		"call_p132exit0":     {"Waited for pnpm build · exited 0", proto.ToolOK, "✓ built in 3.41s"},
		"call_p132exit1":     {"Waited for pnpm exec vitest run · exited 1", proto.ToolError, " ❯ src/moon.test.ts (3 tests | 1 failed) 12ms\n Tests  1 failed | 14 passed (15)"},
		"call_p132ctrlc":     {"Sent ^C to uv run pytest -x · exited 130", proto.ToolError, "KeyboardInterrupt"},
		"call_p132typed":     {"Sent y⏎ to npm create vite@latest tide-app · still running · 2s", proto.ToolOK, "◆  Select a framework:"},
		"call_p132unknown":   {"Waited for background terminal 39999 · still running · 5s", proto.ToolOK, ""},
		"call_p132two":       {"Waited for npm create vite@latest tide-app (+1 more) · still running · 1s", proto.ToolOK, ""},
		"call_p132image":     {"Waited for npm create vite@latest tide-app · exited 0", proto.ToolOK, "Done. Now run:\n  cd tide-app"},
		"call_p132withcmd":   {"git status --short", proto.ToolOK, ""},
		"call_p132wrapped":   {"docker compose up db (+1 more)", proto.ToolOK, ""},
		"call_p132truncated": {"Waited for pnpm dev · still running · 10s", proto.ToolOK, "Warning: truncated output (original token count: 4000)\nTotal output lines: 812\n\n  ➜  Local:   http://localhost:5173/\n…"},
		"call_p132variable":  {"Waited for background terminal · still running · 1s", proto.ToolOK, ""},
		"call_p132plain":     {"Waited for docker compose up db", proto.ToolOK, "Script completed\nWall time 5.1 seconds\nOutput:\n\ndb-1  | {\"level\":\"info\",\"msg\":\"ready\"}\n"},
		"call_p132waiting":   {"Waited for pnpm exec vitest run", proto.ToolRunning, ""},
	})
	for _, it := range its {
		if t2 := it.Tool; t2 != nil && strings.Contains(t2.InputSummary, "tools.") {
			t.Errorf("%s: a script line as the summary: %q", it.ID, t2.InputSummary)
		}
		if it.ID == "call_p132image" && len(it.Tool.Images) != 1 {
			t.Errorf("poll + view_image: %d images, want its strip", len(it.Tool.Images))
		}
		if it.ID == "call_p132running" && !strings.Contains(string(it.Tool.Input), "write_stdin") {
			t.Errorf("the script is no longer the input: %s", it.Tool.Input)
		}
	}
	// Unverified: no local rollout has a direct exec_command or write_stdin;
	// polls_direct.jsonl is built from codex-rs's own strings.
	checkRows(t, "direct", rowsOf(items(t, Codex, "polls_direct.jsonl")), map[string]row{
		"call_p132dstart":   {"cargo build --release", proto.ToolOK, ""},
		"call_p132drun":     {"Waited for cargo build --release · still running · 30s", proto.ToolOK, ""},
		"call_p132dexit":    {"Waited for cargo build --release · exited 0", proto.ToolOK, "    Finished `release` profile [optimized] target(s) in 52.4s\n"},
		"call_p132dunknown": {"Sent ^D to background terminal 52999 · exited 0", proto.ToolOK, ""},
	})
}

// codexLine is a rollout line of a synthetic test.
func codexLineOf(typ string, payload string) string {
	return fmt.Sprintf(`{"timestamp":"2026-10-20T08:00:00.000Z","type":%q,"payload":%s}`, typ, payload) + "\n"
}

func pollScript(call string, session int64) string {
	return codexLineOf("response_item", fmt.Sprintf(`{"type":"custom_tool_call","call_id":%q,"name":"exec","input":%q}`, call,
		fmt.Sprintf(`text(await tools.write_stdin({session_id:%d,chars:"",yield_time_ms:1000}));`, session)))
}

func startScript(call, cmd string, session int64) string {
	out := fmt.Sprintf(`{"chunk_id":"c","wall_time_seconds":1.0,"session_id":%d,"output":""}`, session)
	return codexLineOf("response_item", fmt.Sprintf(`{"type":"custom_tool_call","call_id":%q,"name":"exec","input":%q}`, call,
		fmt.Sprintf(`text(await tools.exec_command({cmd:%q}));`, cmd))) +
		codexLineOf("response_item", fmt.Sprintf(`{"type":"custom_tool_call_output","call_id":%q,"output":[{"type":"input_text","text":"Script completed\nOutput:\n"},{"type":"input_text","text":%q}]}`, call, out))
}

// #132: where a session's start is not in the transcript, its polls name
// the terminal: inherited history, a start whose output is cut or says no
// session, a result without its call, a session the log forgot.
func TestCodexPollFallbacks(t *testing.T) {
	cutStart := codexLineOf("response_item", `{"type":"custom_tool_call","call_id":"call_cut","name":"exec","input":"text(await tools.exec_command({cmd:\"make\"}));"}`) +
		codexLineOf("response_item", `{"type":"custom_tool_call_output","call_id":"call_cut","output":"Script completed\nOutput:\n{\"chunk_id\":\"c\",\"wall_time_seconds\":1.0,\"output\":\"make: Entering directory\"}"}`)
	orphan := codexLineOf("response_item", `{"type":"custom_tool_call_output","call_id":"call_orphan","output":"Script completed\nOutput:\n{\"chunk_id\":\"c\",\"wall_time_seconds\":1.0,\"session_id\":77,\"output\":\"\"}"}`)
	got := rowsOf(itemsOf(t, Codex, cutStart+pollScript("call_poll_cut", 12)+orphan+pollScript("call_poll_orphan", 77)))
	checkRows(t, "no start", got, map[string]row{
		"call_poll_cut":    {"Waited for background terminal 12", proto.ToolRunning, ""},
		"call_poll_orphan": {"Waited for background terminal 77", proto.ToolRunning, ""},
	})

	// The log remembers maxTermSessions sessions: the oldest is forgotten
	// for later polls, a poll indexed before keeps its command.
	var b strings.Builder
	b.WriteString(startScript("call_s0", "make first", 1000))
	b.WriteString(pollScript("call_early", 1000))
	for i := 1; i <= maxTermSessions; i++ {
		b.WriteString(startScript(fmt.Sprintf("call_s%d", i), fmt.Sprintf("make step%d", i), int64(1000+i)))
	}
	b.WriteString(pollScript("call_late", 1000))
	b.WriteString(pollScript("call_kept", 1001))
	got = rowsOf(itemsOf(t, Codex, b.String()))
	checkRows(t, "evicted", got, map[string]row{
		"call_early": {"Waited for make first", proto.ToolRunning, ""},
		"call_late":  {"Waited for background terminal 1000", proto.ToolRunning, ""},
		"call_kept":  {"Waited for make step1", proto.ToolRunning, ""},
	})

	// A subagent's rollout: its parent's history (the start among it) is
	// inherited, never its own.
	path := filepath.Join(t.TempDir(), "child.jsonl")
	inherited := strings.ReplaceAll(startScript("call_parent", "pnpm dev", 5), `{"timestamp"`, `{"ordinal":1,"timestamp"`)
	own := strings.ReplaceAll(pollScript("call_child_poll", 5), `{"timestamp"`, `{"ordinal":9,"timestamp"`)
	meta := `{"ordinal":0,"timestamp":"2026-10-20T08:00:00.000Z","type":"session_meta","payload":{"id":"x","cli_version":"0.163.0"}}` + "\n"
	if err := os.WriteFile(path, []byte(meta+inherited+own), 0o644); err != nil {
		t.Fatal(err)
	}
	l, err := Read(context.Background(), Codex, path, CodexHistoryStart(5))
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	p, err := l.Before(0, MaxTranscriptLimit)
	if err != nil {
		t.Fatal(err)
	}
	checkRows(t, "inherited", rowsOf(p.Items), map[string]row{"call_child_poll": {"Waited for background terminal 5", proto.ToolRunning, ""}})
}

// #132: a summary keeps its outcome within the cap: the command gives way,
// and typed text is clipped, scrubbed and readable.
func TestPollSummary(t *testing.T) {
	long := strings.Repeat("x", 300)
	p := &pollCall{sessions: []int64{1, 2}}
	got := p.summary(long, " · still running · 30s")
	if n := utf8.RuneCountInString(got); n != maxSummary || !strings.HasSuffix(got, "… (+1 more) · still running · 30s") {
		t.Errorf("long: %d runes, %q", n, got)
	}
	for _, c := range []struct{ chars, want string }{
		{"\x03", "Sent ^C to t"},
		{"\x04", "Sent ^D to t"},
		{"q\r", "Sent q⏎ to t"},
		{"\x1b[A\t\x7f", "Sent ^[[A^I^? to t"},
		{strings.Repeat("ab ", 20), "Sent " + strings.Repeat("ab ", 13) + "a… to t"},
		{"export TOKEN=ghp_" + strings.Repeat("A", 36) + "\n", "Sent export TOKEN=[key]⏎ to t"},
	} {
		if got := (&pollCall{sessions: []int64{1}, chars: c.chars}).summary("t", ""); got != c.want {
			t.Errorf("%q: %q, want %q", c.chars, got, c.want)
		}
	}
	if got := (&pollCall{sessions: []int64{0}}).summary("", ""); got != "Waited for background terminal" {
		t.Errorf("no session: %q", got)
	}
	for _, c := range []struct {
		s    float64
		want string
	}{{30.0, "30s"}, {1.0021, "1s"}, {1.45, "1.5s"}, {0.0001, "0s"}, {130.2, "2m 10s"}} {
		if got := seconds(c.s); got != c.want {
			t.Errorf("seconds(%v) = %q, want %q", c.s, got, c.want)
		}
	}
}

// #132: a poll's output, read: chunks (a cut one too), the direct form,
// and text that is neither.
func TestPollOutput(t *testing.T) {
	script := &pollCall{sessions: []int64{1}}
	cases := []struct {
		name    string
		p       *pollCall
		text    string
		outcome string
		body    string
	}{
		{"running", script, "Script completed\nWall time 30.1 seconds\nOutput:\n" + `{"chunk_id":"a","wall_time_seconds":30.0,"session_id":1,"original_token_count":1,"output":"x\n"}`,
			" · still running · 30s", "x"},
		{"exited", script, "Script completed\nOutput:\n" + `{"chunk_id":"a","wall_time_seconds":0.1,"exit_code":2,"output":"boom\n"}`, " · exited 2", "boom"},
		{"cut", script, "Script completed\nOutput:\n\n" + `{"chunk_id":"a","wall_time_seconds":0.1,"exit_code":0,"output":"one\ntwo \"q\" \u00e9\`,
			" · exited 0", "one\ntwo \"q\" é…"},
		{"cut before the output", script, "Script completed\nOutput:\n" + `{"chunk_id":"a","wall_ti`, "", "Script completed\nOutput:\n" + `{"chunk_id":"a","wall_ti`},
		{"text, not chunks", script, "Script completed\nOutput:\nhello\n", "", "Script completed\nOutput:\nhello\n"},
		{"failed", script, "Script failed\nError: boom", "", "Script failed\nError: boom"},
		{"direct, running", &pollCall{sessions: []int64{1}, direct: true},
			"Chunk ID: a\nWall time: 5.0004 seconds\nProcess running with session ID 1\nOriginal token count: 0\nOutput:\nmore\n", " · still running · 5s", "more\n"},
		{"direct, exited", &pollCall{sessions: []int64{1}, direct: true},
			"Chunk ID: a\nWall time: 5.0 seconds\nProcess exited with code -1\nOutput:\n", " · exited -1", ""},
		{"direct, other", &pollCall{sessions: []int64{1}, direct: true}, "write_stdin failed: Unknown process id 1", "", "write_stdin failed: Unknown process id 1"},
	}
	for _, c := range cases {
		r := c.p.pollOutput(c.text)
		if r.outcome() != c.outcome || r.body != c.body {
			t.Errorf("%s: %q, %q; want %q, %q", c.name, r.outcome(), r.body, c.outcome, c.body)
		}
	}
}

// #132: the session → command link is the index's, in file order: a log
// built from the file and one fed line by line (the tail's) give the same
// rows, and so do a capped list item of a big line and the item in full.
func TestPollsLiveAndCapped(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("testdata", Codex, "polls.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	content := string(b)
	built := readLog(t, Codex, writeTranscript(t, content))
	want, err := built.items(allIdx(built), false)
	if err != nil {
		t.Fatal(err)
	}

	path := writeTranscript(t, "")
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	live, err := Follow(Codex, path, fi, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer live.Close()
	ready(t, live)
	writeLines(t, path, content)
	off := int64(0)
	for line := range strings.Lines(content) {
		live.Line(off, []byte(strings.TrimSuffix(line, "\n")))
		off += int64(len(line))
	}
	got, err := live.items(allIdx(live), false)
	if err != nil {
		t.Fatal(err)
	}
	if jsonOf(t, got) != jsonOf(t, want) {
		t.Error("the live log's items differ from the built one's")
	}

	// The poll + view_image line made big: its list item is capped.
	var sb strings.Builder
	for line := range strings.Lines(content) {
		if strings.Contains(line, `"ctco_call_p132image"`) {
			var v map[string]any
			if err := json.Unmarshal([]byte(line), &v); err != nil {
				t.Fatal(err)
			}
			v["zzPad"] = base64Text(bigLine)
			line = jl(t, v)
		}
		sb.WriteString(line)
	}
	capped, items := sameCapped(t, Codex, writeTranscript(t, sb.String()))
	if len(capped.big) != 1 {
		t.Fatalf("%d records, want 1", len(capped.big))
	}
	full, ok, err := capped.Item("call_p132image")
	if err != nil || !ok {
		t.Fatal(ok, err)
	}
	for _, it := range items {
		if it.ID == "call_p132image" && (it.Tool.InputSummary != full.Tool.InputSummary || it.Tool.InputSummary != "Waited for npm create vite@latest tide-app · exited 0") {
			t.Errorf("capped %q, full %q", it.Tool.InputSummary, full.Tool.InputSummary)
		}
	}
}
