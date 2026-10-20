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

// row is what a test checks of a tool row (#132): term is its Terminal as
// termText says it.
type row struct{ summary, term, status, body string }

// termText is a Terminal in short: "running 30", "running", "exited 1", ""
// (none).
func termText(t *proto.TranscriptTerminal) string {
	switch {
	case t == nil:
		return ""
	case t.ExitCode != nil:
		return fmt.Sprintf("%s %d", t.State, *t.ExitCode)
	case t.WallSeconds != nil:
		return fmt.Sprintf("%s %g", t.State, *t.WallSeconds)
	}
	return t.State
}

// rowsOf are the tool rows of items, by id.
func rowsOf(its []proto.TranscriptItem) map[string]row {
	m := map[string]row{}
	for _, it := range its {
		if t := it.Tool; t != nil {
			m[it.ID] = row{t.InputSummary, termText(t.Terminal), t.Status, t.OutputText}
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
		case g.summary != w.summary || g.term != w.term || g.status != w.status || (w.body != "" && g.body != w.body):
			t.Errorf("%s: %s = %+v, want %+v", name, id, g, w)
		}
	}
}

// #132: a poll of a background terminal names the command it waits on and
// what happened; the raw script stays the row's input.
func TestCodexPolls(t *testing.T) {
	its := items(t, Codex, "polls.jsonl")
	checkRows(t, "code mode", rowsOf(its), map[string]row{
		"call_p132start2":    {"pnpm exec vitest run (+1 more)", "", proto.ToolOK, ""},
		"call_p132running":   {"Waited for pnpm exec vitest run", "running 30", proto.ToolOK, " ✓ src/tide.test.ts (12 tests) 41ms"},
		"call_p132exit0":     {"Waited for pnpm build", "exited 0", proto.ToolOK, "✓ built in 3.41s"},
		"call_p132exit1":     {"Waited for pnpm exec vitest run", "exited 1", proto.ToolError, " ❯ src/moon.test.ts (3 tests | 1 failed) 12ms\n Tests  1 failed | 14 passed (15)"},
		"call_p132ctrlc":     {"Sent ^C to uv run pytest -x", "exited 130", proto.ToolError, "KeyboardInterrupt"},
		"call_p132typed":     {"Sent y⏎ to npm create vite@latest tide-app", "running 2", proto.ToolOK, "◆  Select a framework:"},
		"call_p132unknown":   {"Waited for background terminal 39999", "running 5", proto.ToolOK, ""},
		"call_p132two":       {"Waited for npm create vite@latest tide-app (+1 more)", "running 1", proto.ToolOK, ""},
		"call_p132image":     {"Waited for npm create vite@latest tide-app", "exited 0", proto.ToolOK, "Done. Now run:\n  cd tide-app"},
		"call_p132withcmd":   {"git status --short", "", proto.ToolOK, ""},
		"call_p132wrapped":   {"docker compose up db (+1 more)", "", proto.ToolOK, ""},
		"call_p132truncated": {"Waited for pnpm dev", "running 10", proto.ToolOK, "Warning: truncated output (original token count: 4000)\nTotal output lines: 812\n\n  ➜  Local:   http://localhost:5173/\n…"},
		"call_p132variable":  {"Waited for background terminal", "running 1", proto.ToolOK, ""},
		"call_p132plain":     {"Waited for docker compose up db", "", proto.ToolOK, "Script completed\nWall time 5.1 seconds\nOutput:\n\ndb-1  | {\"level\":\"info\",\"msg\":\"ready\"}\n"},
		"call_p132waiting":   {"Waited for pnpm exec vitest run", "", proto.ToolRunning, ""},
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
		"call_p132dstart":   {"cargo build --release", "", proto.ToolOK, ""},
		"call_p132drun":     {"Waited for cargo build --release", "running 30.0013", proto.ToolOK, ""},
		"call_p132dexit":    {"Waited for cargo build --release", "exited 0", proto.ToolOK, "    Finished `release` profile [optimized] target(s) in 52.4s\n"},
		"call_p132dunknown": {"Sent ^D to background terminal 52999", "exited 0", proto.ToolOK, ""},
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
		"call_poll_cut":    {"Waited for background terminal 12", "", proto.ToolRunning, ""},
		"call_poll_orphan": {"Waited for background terminal 77", "", proto.ToolRunning, ""},
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
		"call_early": {"Waited for make first", "", proto.ToolRunning, ""},
		"call_late":  {"Waited for background terminal 1000", "", proto.ToolRunning, ""},
		"call_kept":  {"Waited for make step1", "", proto.ToolRunning, ""},
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
	checkRows(t, "inherited", rowsOf(p.Items), map[string]row{"call_child_poll": {"Waited for background terminal 5", "", proto.ToolRunning, ""}})
}

// #132: a summary keeps "(+N more)" within the cap: the command gives way,
// and typed text is clipped, scrubbed and readable.
func TestPollSummary(t *testing.T) {
	long := strings.Repeat("x", 300)
	p := &pollCall{sessions: []int64{1, 2}}
	got := p.summary(long)
	if n := utf8.RuneCountInString(got); n != maxSummary || !strings.HasSuffix(got, "x… (+1 more)") {
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
		if got := (&pollCall{sessions: []int64{1}, chars: c.chars}).summary("t"); got != c.want {
			t.Errorf("%q: %q, want %q", c.chars, got, c.want)
		}
	}
	if got := (&pollCall{sessions: []int64{0}}).summary(""); got != "Waited for background terminal" {
		t.Errorf("no session: %q", got)
	}
}

// #132: a poll's output, read: chunks (a cut one too), several polls, the
// direct form, and text that is neither.
func TestPollOutput(t *testing.T) {
	script := &pollCall{sessions: []int64{1}}
	two := &pollCall{sessions: []int64{1, 2}}
	chunk := func(s string) string { return "{\"chunk_id\":\"a\",\"wall_time_seconds\":1.5," + s + "}" }
	runs := chunk(`"session_id":1,"output":"up\n"`)
	ok0 := chunk(`"exit_code":0,"output":"ok\n"`)
	fail1 := chunk(`"exit_code":1,"output":"failed\n"`)
	fail2 := chunk(`"exit_code":2,"output":"worse\n"`)
	scripted := func(lines ...string) string { return "Script completed\nOutput:\n" + strings.Join(lines, "\n") }
	cases := []struct {
		name   string
		p      *pollCall
		text   string
		term   string
		status string
		body   string
	}{
		{"running", script, "Script completed\nWall time 30.1 seconds\nOutput:\n" + `{"chunk_id":"a","wall_time_seconds":30.0,"session_id":1,"original_token_count":1,"output":"x\n"}`,
			"running 30", proto.ToolOK, "x"},
		{"exited", script, "Script completed\nOutput:\n" + `{"chunk_id":"a","wall_time_seconds":0.1,"exit_code":2,"output":"boom\n"}`, "exited 2", proto.ToolError, "boom"},
		{"cut", script, "Script completed\nOutput:\n\n" + `{"chunk_id":"a","wall_time_seconds":0.1,"exit_code":0,"output":"one\ntwo \"q\" \u00e9\`,
			"exited 0", proto.ToolOK, "one\ntwo \"q\" é…"},
		{"cut before the output", script, "Script completed\nOutput:\n" + `{"chunk_id":"a","wall_ti`, "", proto.ToolOK, "Script completed\nOutput:\n" + `{"chunk_id":"a","wall_ti`},
		{"text, not chunks", script, "Script completed\nOutput:\nhello\n", "", proto.ToolOK, "Script completed\nOutput:\nhello\n"},
		{"failed", script, "Script failed\nError: boom", "", proto.ToolOK, "Script failed\nError: boom"},
		// Several polls: any that exited other than 0 is the row's error and
		// its process; else the first's.
		{"running, exited 0", two, scripted(runs, ok0), "running 1.5", proto.ToolOK, "up\nok"},
		{"exited 0, exited 1", two, scripted(ok0, fail1), "exited 1", proto.ToolError, "ok\nfailed"},
		{"exited 1, running", two, scripted(fail1, runs), "exited 1", proto.ToolError, "failed\nup"},
		{"exited 1, exited 2", two, scripted(fail1, fail2), "exited 1", proto.ToolError, "failed\nworse"},
		{"one poll printed no chunk", two, scripted("plain text", fail1), "exited 1", proto.ToolError, "plain text\nfailed"},
		{"a chunk that says neither, then one that does", two, scripted(chunk(`"output":"?"`), runs), "running 1.5", proto.ToolOK, "?\nup"},
		{"direct, running", &pollCall{sessions: []int64{1}, direct: true},
			"Chunk ID: a\nWall time: 5.0004 seconds\nProcess running with session ID 1\nOriginal token count: 0\nOutput:\nmore\n", "running 5.0004", proto.ToolOK, "more\n"},
		{"direct, exited", &pollCall{sessions: []int64{1}, direct: true},
			"Chunk ID: a\nWall time: 5.0 seconds\nProcess exited with code -1\nOutput:\n", "exited -1", proto.ToolError, ""},
		{"direct, other", &pollCall{sessions: []int64{1}, direct: true}, "write_stdin failed: Unknown process id 1", "", proto.ToolOK, "write_stdin failed: Unknown process id 1"},
	}
	for _, c := range cases {
		r := c.p.pollOutput(c.text)
		if termText(r.term) != c.term || r.status(proto.ToolOK) != c.status || r.body != c.body {
			t.Errorf("%s: %q, %s, %q; want %q, %s, %q", c.name, termText(r.term), r.status(proto.ToolOK), r.body, c.term, c.status, c.body)
		}
	}
}

// #132: tool-looking text a poll types (a string literal of the script) is
// typed text: the row is a poll, its input scrubbed and clipped.
func TestPollTypedCode(t *testing.T) {
	line := func(id, script string) string {
		return codexLineOf("response_item", fmt.Sprintf(`{"type":"custom_tool_call","call_id":%q,"name":"exec","input":%q}`, id, script))
	}
	got := rowsOf(itemsOf(t, Codex,
		line("call_code", `text(await tools.write_stdin({session_id:12,chars:"await tools.exec_command({cmd:'echo hi'})\n"}));`)+
			line("call_key", "text(await tools.write_stdin({session_id:12,chars:`tools.exec_command({cmd:'export K=ghp_"+strings.Repeat("A", 36)+"'})`}));")))
	checkRows(t, "typed code", got, map[string]row{
		"call_code": {"Sent await tools.exec_command({cmd:'echo hi'}… to background terminal 12", "", proto.ToolRunning, ""},
		"call_key":  {"Sent tools.exec_command({cmd:'export K=[key]'… to background terminal 12", "", proto.ToolRunning, ""},
	})
}

// #132: a quote in a regex literal is not a string's: the poll between two
// such regexes is still a poll, with its process.
func TestPollBetweenRegexes(t *testing.T) {
	call := codexLineOf("response_item", fmt.Sprintf(`{"type":"custom_tool_call","call_id":"call_re","name":"exec","input":%q}`,
		`const quote = /"/; text(await tools.write_stdin({session_id:12,chars:''})); const quote2 = /"/;`))
	result := codexLineOf("response_item", `{"type":"custom_tool_call_output","call_id":"call_re","output":"Script completed\nOutput:\n{\"chunk_id\":\"a\",\"exit_code\":1,\"output\":\"failed\"}"}`)
	checkRows(t, "regexes", rowsOf(itemsOf(t, Codex, call+result)), map[string]row{
		"call_re": {"Waited for background terminal 12", "exited 1", proto.ToolError, ""},
	})
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
		if it.ID == "call_p132image" && (it.Tool.InputSummary != full.Tool.InputSummary || it.Tool.InputSummary != "Waited for npm create vite@latest tide-app" ||
			termText(it.Tool.Terminal) != termText(full.Tool.Terminal) || termText(it.Tool.Terminal) != "exited 0") {
			t.Errorf("capped %q %s, full %q %s", it.Tool.InputSummary, termText(it.Tool.Terminal), full.Tool.InputSummary, termText(full.Tool.Terminal))
		}
	}
}
