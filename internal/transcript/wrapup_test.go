package transcript

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The wrap-up fixtures (testdata/{claude,codex}/wrapup_*.jsonl) are
// synthetic, in the shapes of Claude Code 2.1.285 and codex-cli 0.159.2:
// a turn before the wrap-up (which printed an old nonce's line), the
// bridge's prompt with its footer (pasted, for Claude), a tool call, and
// the final message. The armed nonce is wrapUpNonce.
const (
	wrapUpNonce = "5f3c9a1e7b2d4086"
	oldNonce    = "0d1e2f3a4b5c6d7e"
)

// feedWrapUp feeds a fixture's lines with their byte offsets.
func feedWrapUp(t *testing.T, tr *WrapUpTracker, harness, name string) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", harness, name))
	if err != nil {
		t.Fatal(err)
	}
	var off int64
	for _, l := range bytes.SplitAfter(b, []byte("\n")) {
		if len(bytes.TrimSpace(l)) > 0 {
			tr.Line(off, bytes.TrimRight(l, "\n"))
		}
		off += int64(len(l))
	}
}

func TestWrapUpTrackerFixtures(t *testing.T) {
	cases := []struct {
		name, verdict, reason string
	}{
		{"wrapup_clean.jsonl", WrapUpClean, ""},
		{"wrapup_blocked.jsonl", WrapUpBlocked, "the preview server on port 4173 belongs to another session"},
		{"wrapup_quoted.jsonl", WrapUpNone, ""},
		{"wrapup_stale.jsonl", WrapUpNone, ""},
		{"wrapup_mid.jsonl", WrapUpNone, ""},
		{"wrapup_trailing.jsonl", WrapUpNone, ""},
		{"wrapup_two.jsonl", WrapUpNone, ""},
		{"wrapup_none.jsonl", WrapUpNone, ""},
		{"wrapup_multi.jsonl", WrapUpClean, ""},
		{"wrapup_multi_early.jsonl", WrapUpNone, ""},
		// #83 review: the result line as it is, never trimmed into one.
		{"wrapup_indented.jsonl", WrapUpNone, ""},
		{"wrapup_fenced.jsonl", WrapUpNone, ""},
		{"wrapup_spaces.jsonl", WrapUpNone, ""},
		{"wrapup_fenced_short.jsonl", WrapUpNone, ""}, // ```` "closed" by ```
	}
	for _, harness := range []string{Claude, Codex} {
		for _, tc := range cases {
			t.Run(harness+"/"+tc.name, func(t *testing.T) {
				tr := NewWrapUpTracker(harness, wrapUpNonce, 0)
				feedWrapUp(t, tr, harness, tc.name)
				st := tr.State()
				if !st.Prompted || !st.Ended || st.TookOver || st.Void {
					t.Fatalf("state %+v, want prompted and ended", st)
				}
				if st.Verdict != tc.verdict || st.Reason != tc.reason {
					t.Errorf("verdict %q %q, want %q %q", st.Verdict, st.Reason, tc.verdict, tc.reason)
				}
				// The old nonce's wrap-up is long over: its line (the turn before) and the new prompt never make it one.
				old := NewWrapUpTracker(harness, oldNonce, 0)
				feedWrapUp(t, old, harness, tc.name)
				if st := old.State(); st.Prompted || st.Verdict != "" {
					t.Errorf("the old nonce: %+v", st)
				}
			})
		}
	}
}

// A prompt after the bridge's: a person took over, also when it quotes the
// marker.
func TestWrapUpTrackerTakeover(t *testing.T) {
	for _, harness := range []string{Claude, Codex} {
		for _, name := range []string{"wrapup_takeover.jsonl", "wrapup_takeover_quoted.jsonl"} {
			tr := NewWrapUpTracker(harness, wrapUpNonce, 0)
			feedWrapUp(t, tr, harness, name)
			if st := tr.State(); !st.Prompted || !st.TookOver {
				t.Errorf("%s/%s: %+v, want took over", harness, name, st)
			}
		}
	}
	// An interruption (Esc) after the bridge's prompt, too.
	interrupt := map[string]string{
		Claude: `{"type":"user","isSidechain":false,"message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}`,
		Codex:  `{"type":"event_msg","payload":{"type":"turn_aborted","reason":"interrupted"}}`,
	}
	for harness, line := range interrupt {
		tr := NewWrapUpTracker(harness, wrapUpNonce, 0)
		feedWrapUp(t, tr, harness, "wrapup_none.jsonl")
		if tr.State().TookOver {
			t.Fatalf("%s: took over before the interruption", harness)
		}
		tr.Line(1<<20, []byte(line))
		if st := tr.State(); !st.TookOver {
			t.Errorf("%s: %+v after the interruption, want took over", harness, st)
		}
	}
}

// Transcript lines for the tests below, in the fixtures' shapes.
func wrapUpPromptLine(harness, text string) string {
	if harness == Claude {
		return wrapUpJSON(map[string]any{"type": "user", "isSidechain": false, "message": map[string]any{"role": "user", "content": text}})
	}
	return wrapUpJSON(map[string]any{"type": "response_item", "payload": map[string]any{"type": "message", "role": "user",
		"content": []any{map[string]any{"type": "input_text", "text": text}}}})
}

func wrapUpFinalLines(harness, id, text string) []string {
	if harness == Claude {
		return []string{wrapUpJSON(map[string]any{"type": "assistant", "isSidechain": false, "message": map[string]any{"id": id,
			"role": "assistant", "content": []any{map[string]any{"type": "text", "text": text}}, "stop_reason": "end_turn"}}),
			`{"type":"system","subtype":"turn_duration","durationMs":1000,"isSidechain":false}`}
	}
	return []string{`{"type":"event_msg","payload":{"type":"task_started"}}`,
		wrapUpJSON(map[string]any{"type": "response_item", "payload": map[string]any{"type": "message", "role": "assistant",
			"content": []any{map[string]any{"type": "output_text", "text": text}}}}),
		wrapUpJSON(map[string]any{"type": "event_msg", "payload": map[string]any{"type": "task_complete", "last_agent_message": text}})}
}

func wrapUpJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}

// feedLines feeds lines from byte offset at on, and returns the offset after
// them.
func feedLines(tr *WrapUpTracker, at int64, lines ...string) int64 {
	for _, l := range lines {
		tr.Line(at, []byte(l))
		at += int64(len(l)) + 1
	}
	return at
}

// Only the first prompt that ends with the nonce's footer is the bridge's;
// every later one is a person's, the footer quoted in full or not. The
// bridge's read once more (the same text) is not.
func TestWrapUpTrackerBridgePromptOnce(t *testing.T) {
	task := "Stop every server you started."
	footer := WrapUpFooter(wrapUpNonce)
	for _, harness := range []string{Claude, Codex} {
		// The marker without the footer at its end is not the bridge's prompt.
		tr := NewWrapUpTracker(harness, wrapUpNonce, 0)
		feedLines(tr, 0, wrapUpPromptLine(harness, "Why did you print H3D-WRAPUP "+wrapUpNonce+" CLEAN?"))
		if st := tr.State(); st.Prompted || st.TookOver {
			t.Errorf("%s: a quoted marker before the prompt: %+v", harness, st)
		}
		for _, later := range []string{
			"Do not send this worker home. Explain the line H3D-WRAPUP " + wrapUpNonce + " CLEAN instead.",
			"Keep the dev server.\n\n" + footer,
			footer,
		} {
			tr := NewWrapUpTracker(harness, wrapUpNonce, 0)
			at := feedLines(tr, 0, wrapUpPromptLine(harness, task+"\n\n"+footer))
			at = feedLines(tr, at, wrapUpFinalLines(harness, "m1", "Stopped.\n\nH3D-WRAPUP "+wrapUpNonce+" CLEAN")...)
			if st := tr.State(); !st.Prompted || st.TookOver || st.Verdict != WrapUpClean {
				t.Fatalf("%s: before the later prompt: %+v", harness, st)
			}
			feedLines(tr, at, wrapUpPromptLine(harness, later))
			if st := tr.State(); !st.TookOver {
				t.Errorf("%s: %q after the bridge's prompt: %+v, want took over", harness, later, st)
			}
		}
		tr = NewWrapUpTracker(harness, wrapUpNonce, 0)
		at := feedLines(tr, 0, wrapUpPromptLine(harness, task+"\n\n"+footer), wrapUpPromptLine(harness, task+"\n\n"+footer))
		feedLines(tr, at, wrapUpFinalLines(harness, "m1", "H3D-WRAPUP "+wrapUpNonce+" CLEAN")...)
		if st := tr.State(); st.TookOver || st.Verdict != WrapUpClean {
			t.Errorf("%s: the bridge's prompt twice: %+v", harness, st)
		}
	}
	// Claude: a prompt queued while the agent worked is an attachment, the
	// bridge's (pasted) or a person's.
	queued := func(text string) string {
		return wrapUpJSON(map[string]any{"type": "attachment", "isSidechain": false, "attachment": map[string]any{"type": "queued_command",
			"prompt": text, "commandMode": "prompt", "origin": map[string]any{"kind": "human"}}})
	}
	tr := NewWrapUpTracker(Claude, wrapUpNonce, 0)
	at := feedLines(tr, 0, queued("<pasted_content id=\"a1f3\">\n"+task+"\n\n"+footer+"\n</pasted_content id=\"a1f3\">\n"))
	if st := tr.State(); !st.Prompted || st.TookOver {
		t.Fatalf("claude: the bridge's prompt queued: %+v", st)
	}
	feedLines(tr, at, queued("Explain H3D-WRAPUP "+wrapUpNonce+" CLEAN first."))
	if st := tr.State(); !st.TookOver {
		t.Errorf("claude: a person's queued prompt: %+v, want took over", st)
	}
}

// "Wrap up again": a new tracker for a fresh nonce from where the
// transcript is now; the old wrap-up's prompt and result are before it, and
// its old nonce is no prompt of the new one.
func TestWrapUpTrackerRearm(t *testing.T) {
	const fresh = "a1b2c3d4e5f60718"
	for _, harness := range []string{Claude, Codex} {
		old := NewWrapUpTracker(harness, wrapUpNonce, 0)
		at := feedLines(old, 0, wrapUpPromptLine(harness, "Stop it.\n\n"+WrapUpFooter(wrapUpNonce)))
		at = feedLines(old, at, wrapUpFinalLines(harness, "m1", "H3D-WRAPUP "+wrapUpNonce+" BLOCKED: port 4173 is not mine")...)
		at = feedLines(old, at, wrapUpPromptLine(harness, "Kill the preview server, it is yours."))
		at = feedLines(old, at, wrapUpFinalLines(harness, "m2", "Killed it.")...)
		if st := old.State(); st.Verdict != WrapUpNone || !st.TookOver {
			t.Fatalf("%s: the old wrap-up: %+v", harness, st)
		}
		tr := NewWrapUpTracker(harness, fresh, at)
		next := feedLines(tr, at, wrapUpPromptLine(harness, "Check once more.\n\n"+WrapUpFooter(fresh)))
		feedLines(old, at, wrapUpPromptLine(harness, "Check once more.\n\n"+WrapUpFooter(fresh)))
		feedLines(tr, next, wrapUpFinalLines(harness, "m3", "All stopped.\n\nH3D-WRAPUP "+fresh+" CLEAN")...)
		if st := tr.State(); !st.Prompted || st.TookOver || st.Verdict != WrapUpClean {
			t.Errorf("%s: wrapped up again: %+v", harness, st)
		}
	}
}

// Lines before the armed offset are not read: the earlier turn, and here the
// prompt too (armed after it), so nothing is decided.
func TestWrapUpTrackerOffset(t *testing.T) {
	for _, harness := range []string{Claude, Codex} {
		b, err := os.ReadFile(filepath.Join("testdata", harness, "wrapup_clean.jsonl"))
		if err != nil {
			t.Fatal(err)
		}
		// From the bridge's prompt on: the same verdict as from the start.
		at := int64(bytes.Index(b, []byte("Stop every server")))
		at = int64(bytes.LastIndexByte(b[:at], '\n') + 1)
		tr := NewWrapUpTracker(harness, wrapUpNonce, at)
		feedWrapUp(t, tr, harness, "wrapup_clean.jsonl")
		if st := tr.State(); st.Verdict != WrapUpClean || st.Lines == 0 {
			t.Errorf("%s from the prompt: %+v", harness, st)
		}
		// From just after it: the prompt is never read, nothing counts.
		next := at + int64(bytes.IndexByte(b[at:], '\n')+1)
		tr = NewWrapUpTracker(harness, wrapUpNonce, next)
		feedWrapUp(t, tr, harness, "wrapup_clean.jsonl")
		if st := tr.State(); st.Prompted || st.Ended || st.Verdict != "" {
			t.Errorf("%s after the prompt: %+v", harness, st)
		}
	}
}

// Line by line: nothing is decided before the turn ends, and the end is the
// final message's.
func TestWrapUpTrackerTurnEnd(t *testing.T) {
	for _, harness := range []string{Claude, Codex} {
		b, err := os.ReadFile(filepath.Join("testdata", harness, "wrapup_multi.jsonl"))
		if err != nil {
			t.Fatal(err)
		}
		tr := NewWrapUpTracker(harness, wrapUpNonce, 0)
		var off int64
		lines := bytes.SplitAfter(b, []byte("\n"))
		endedAt := -1
		for i, l := range lines {
			if len(bytes.TrimSpace(l)) == 0 {
				continue
			}
			tr.Line(off, bytes.TrimRight(l, "\n"))
			off += int64(len(l))
			if st := tr.State(); st.Ended && endedAt < 0 {
				endedAt = i
				if st.Verdict != WrapUpClean {
					t.Errorf("%s: ended at line %d with %+v", harness, i+1, st)
				}
			}
		}
		// Claude: at the final text (its stop_reason), before the hook summary and turn_duration; Codex: at task_complete.
		want := len(lines) - 1 - 1
		if harness == Claude {
			want = len(lines) - 1 - 3
		}
		if endedAt != want {
			t.Errorf("%s: ended at line %d, want %d", harness, endedAt+1, want+1)
		}
	}
}

func TestWrapUpTrackerReset(t *testing.T) {
	tr := NewWrapUpTracker(Claude, wrapUpNonce, 0)
	feedWrapUp(t, tr, Claude, "wrapup_clean.jsonl")
	tr.Reset()
	feedWrapUp(t, tr, Claude, "wrapup_clean.jsonl")
	if st := tr.State(); !st.Void || st.Verdict != "" || st.Prompted {
		t.Errorf("after Reset %+v, want void for good", st)
	}
}

func TestWrapUpVerdict(t *testing.T) {
	n := wrapUpNonce
	long := strings.Repeat("x", MaxWrapUpReason)
	cases := []struct {
		text, verdict, reason string
	}{
		{"H3D-WRAPUP " + n + " CLEAN", WrapUpClean, ""},
		{"done\n\nH3D-WRAPUP " + n + " CLEAN\n\n  \n", WrapUpClean, ""},
		{"done\r\nH3D-WRAPUP " + n + " CLEAN\r\n", WrapUpClean, ""},
		{"done\nH3D-WRAPUP " + n + " CLEAN\r", WrapUpClean, ""},
		// The line as it is: whitespace around it, a list marker, an indented
		// or fenced code block is not the result line.
		{"  H3D-WRAPUP " + n + " CLEAN  ", WrapUpNone, ""},
		{"    H3D-WRAPUP " + n + " CLEAN", WrapUpNone, ""},
		{"Example:\n\n    H3D-WRAPUP " + n + " CLEAN\n", WrapUpNone, ""},
		{"\tH3D-WRAPUP " + n + " CLEAN", WrapUpNone, ""},
		{" H3D-WRAPUP " + n + " CLEAN", WrapUpNone, ""},
		{"H3D-WRAPUP " + n + " CLEAN ", WrapUpNone, ""},
		{"H3D-WRAPUP " + n + " CLEAN\t", WrapUpNone, ""},
		{"H3D-WRAPUP " + n + " BLOCKED: port 4173 is not mine ", WrapUpNone, ""},
		{"- H3D-WRAPUP " + n + " CLEAN", WrapUpNone, ""},
		{"1. H3D-WRAPUP " + n + " CLEAN", WrapUpNone, ""},
		{"'H3D-WRAPUP " + n + " CLEAN'", WrapUpNone, ""},
		{"\"H3D-WRAPUP " + n + " CLEAN\"", WrapUpNone, ""},
		{"I will print:\n```\nH3D-WRAPUP " + n + " CLEAN", WrapUpNone, ""},
		{"I will print:\n~~~text\nH3D-WRAPUP " + n + " CLEAN\n", WrapUpNone, ""},
		{"I will print:\n```\nH3D-WRAPUP " + n + " CLEAN\n```", WrapUpNone, ""},
		{"```sh\nkill %1\n```\n\nH3D-WRAPUP " + n + " CLEAN", WrapUpClean, ""},
		// #83 review: a fence closes only on a run of its own character, at
		// least as long, with nothing after it; an example in one still open
		// is no result.
		{"I could not stop the server. Example only:\n````text\n```\nH3D-WRAPUP " + n + " CLEAN", WrapUpNone, ""},
		{"I could not stop the server. Example only:\n```text\n~~~\nH3D-WRAPUP " + n + " CLEAN", WrapUpNone, ""},
		{"Example:\n~~~~\n~~~\nH3D-WRAPUP " + n + " CLEAN", WrapUpNone, ""},
		{"Example:\n```text\n```text\nH3D-WRAPUP " + n + " CLEAN", WrapUpNone, ""},
		{"Example:\n```\n```sh\nH3D-WRAPUP " + n + " CLEAN", WrapUpNone, ""},
		{"Example:\n```\n    ```\nH3D-WRAPUP " + n + " CLEAN", WrapUpNone, ""},
		{"Example:\n```\n\t```\nH3D-WRAPUP " + n + " CLEAN", WrapUpNone, ""},
		{"Example:\n   ```text\nH3D-WRAPUP " + n + " CLEAN", WrapUpNone, ""},
		{"Example:\n ~~~\nH3D-WRAPUP " + n + " CLEAN", WrapUpNone, ""},
		{"Example:\n   ````\n   ```\nH3D-WRAPUP " + n + " CLEAN", WrapUpNone, ""},
		// A list item's fence, closed in the list: the top-level run after it
		// opens one.
		{"- Stopped:\n  ```\n  ~~~\n```\nH3D-WRAPUP " + n + " CLEAN", WrapUpNone, ""},
		{"- ```\n  ```\n```\nH3D-WRAPUP " + n + " CLEAN", WrapUpNone, ""},
		{"- Stopped:\n  ```sh\n  kill %1\n ```\nH3D-WRAPUP " + n + " CLEAN", WrapUpNone, ""},
		{"1. Stopped:\n   ```sh\n   kill %1\n```\nH3D-WRAPUP " + n + " CLEAN", WrapUpNone, ""},
		{"- Stopped\nlazily:\n  ```\n```\nH3D-WRAPUP " + n + " CLEAN", WrapUpNone, ""},
		{"- Stopped.\n\n  ```\n```\nH3D-WRAPUP " + n + " CLEAN", WrapUpNone, ""},
		// A line left of the item's fence may end the item, and the fence
		// with it: the run after it may open one.
		{"- Stopped:\n  ```sh\nkill %1\n  ```\nH3D-WRAPUP " + n + " CLEAN", WrapUpNone, ""},
		{"2. Stopped:\n   ~~~\n```\n   ~~~~~\n- Done.\nH3D-WRAPUP " + n + " CLEAN", WrapUpNone, ""},
		// Closed fences before it: still the result.
		{"Stopped:\n```text\n````\n\nH3D-WRAPUP " + n + " CLEAN", WrapUpClean, ""},
		{"Stopped:\n````\n```\n````` \t\nH3D-WRAPUP " + n + " CLEAN", WrapUpClean, ""},
		{"Stopped:\n~~~ `kill` me\n```\n~~~\nH3D-WRAPUP " + n + " CLEAN", WrapUpClean, ""},
		{"Stopped:\n   ```sh\n   kill %1\n   ```\nH3D-WRAPUP " + n + " CLEAN", WrapUpClean, ""},
		{"1. Stopped:\n   ```sh\n   kill %1\n   ```\n2. Closed the pane.\n\nH3D-WRAPUP " + n + " CLEAN", WrapUpClean, ""},
		{"Stopped:\n```sh\nkill %1\n```\r\n```\nexit\n```\nH3D-WRAPUP " + n + " CLEAN", WrapUpClean, ""},
		// Not a fence: inline code, two backticks, an indented code block.
		{"Ran ```kill %1``` here.\nH3D-WRAPUP " + n + " CLEAN", WrapUpClean, ""},
		{"Ran ``kill``.\n``\nH3D-WRAPUP " + n + " CLEAN", WrapUpClean, ""},
		{"Ran:\n\n    ```\n\nH3D-WRAPUP " + n + " CLEAN", WrapUpClean, ""},
		{"H3D-WRAPUP " + n + " BLOCKED: port 4173 is not mine", WrapUpBlocked, "port 4173 is not mine"},
		{"H3D-WRAPUP " + n + " BLOCKED: " + long, WrapUpBlocked, long},
		{"H3D-WRAPUP " + n + " BLOCKED: " + long + "x", WrapUpNone, ""},
		{"H3D-WRAPUP " + n + " BLOCKED:", WrapUpNone, ""},
		{"H3D-WRAPUP " + n + " BLOCKED: ", WrapUpNone, ""},
		{"H3D-WRAPUP " + n + " BLOCKED:   ", WrapUpNone, ""},
		{"H3D-WRAPUP " + n + " clean", WrapUpNone, ""},
		{"H3D-WRAPUP " + n + " CLEAN.", WrapUpNone, ""},
		{"H3D-WRAPUP  " + n + " CLEAN", WrapUpNone, ""},
		{"**H3D-WRAPUP " + n + " CLEAN**", WrapUpNone, ""},
		{"> H3D-WRAPUP " + n + " CLEAN", WrapUpNone, ""},
		{"`H3D-WRAPUP " + n + " CLEAN`", WrapUpNone, ""},
		{"H3D-WRAPUP " + strings.ToUpper(n) + " CLEAN", WrapUpNone, ""},
		{"H3D-WRAPUP " + oldNonce + " CLEAN", WrapUpNone, ""},
		{"H3D-WRAPUP <nonce> CLEAN", WrapUpNone, ""},
		{"H3D-WRAPUP " + n + " CLEAN\nok", WrapUpNone, ""},
		{"H3D-WRAPUP " + n + " CLEAN\nH3D-WRAPUP " + n + " CLEAN", WrapUpNone, ""},
		{"said H3D-WRAPUP " + n + " CLEAN before\nH3D-WRAPUP " + n + " CLEAN", WrapUpNone, ""},
		// An old nonce's line before is not this one's marker.
		{"H3D-WRAPUP " + oldNonce + " CLEAN\nH3D-WRAPUP " + n + " CLEAN", WrapUpClean, ""},
		{"", WrapUpNone, ""},
		{"\n \n", WrapUpNone, ""},
	}
	// #83 review: a top-level fence closes at any indent up to 3, whatever
	// its opener's; so does one before a list, or after one but left of its
	// content.
	for open := 0; open <= 3; open++ {
		for closed := 0; closed <= 3; closed++ {
			if open != closed {
				fence := "Stopped.\n" + strings.Repeat(" ", open) + "```sh\nkill %1\n" + strings.Repeat(" ", closed) + "```\n"
				cases = append(cases, struct{ text, verdict, reason string }{fence + "H3D-WRAPUP " + n + " CLEAN", WrapUpClean, ""})
			}
		}
	}
	cases = append(cases, []struct{ text, verdict, reason string }{
		{"```sh\nkill %1\n ```\n- Closed the pane.\n\nH3D-WRAPUP " + n + " CLEAN", WrapUpClean, ""},
		{"1. Closed the pane.\n\n  ```sh\n  kill %1\n```\nH3D-WRAPUP " + n + " CLEAN", WrapUpClean, ""},
	}...)
	for _, tc := range cases {
		v, r := WrapUpVerdict(tc.text, n)
		if v != tc.verdict || r != tc.reason {
			t.Errorf("%q: %q %q, want %q %q", tc.text, v, r, tc.verdict, tc.reason)
		}
	}
	if v, _ := WrapUpVerdict("H3D-WRAPUP <nonce> CLEAN", "<nonce>"); v != WrapUpNone {
		t.Errorf("an invalid nonce matched")
	}
}

func TestWrapUpFooter(t *testing.T) {
	want := "When you are done, end your final message with exactly one line:\n" +
		"H3D-WRAPUP " + wrapUpNonce + " CLEAN\n" +
		"or, if the task did not complete, anything could not be stopped or needs a decision:\n" +
		"H3D-WRAPUP " + wrapUpNonce + " BLOCKED: <one-line reason>"
	if got := WrapUpFooter(wrapUpNonce); got != want {
		t.Errorf("footer:\n%s", got)
	}
	// The footer's own lines are never a verdict: "<one-line reason>" is a reason, so only the user line's place guards it.
	if NewWrapUpTracker("shell", wrapUpNonce, 0) != nil || NewWrapUpTracker(Claude, "xyz", 0) != nil {
		t.Error("tracker for a bad harness or nonce")
	}
}
