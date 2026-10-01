package transcript

import (
	"bytes"
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

// A prompt without the nonce after the bridge's: a person took over.
func TestWrapUpTrackerTakeover(t *testing.T) {
	for _, harness := range []string{Claude, Codex} {
		tr := NewWrapUpTracker(harness, wrapUpNonce, 0)
		feedWrapUp(t, tr, harness, "wrapup_takeover.jsonl")
		if st := tr.State(); !st.TookOver {
			t.Errorf("%s: %+v, want took over", harness, st)
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
		{"  H3D-WRAPUP " + n + " CLEAN  ", WrapUpClean, ""},
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
		"or, if anything could not be stopped or needs a decision:\n" +
		"H3D-WRAPUP " + wrapUpNonce + " BLOCKED: <one-line reason>"
	if got := WrapUpFooter(wrapUpNonce); got != want {
		t.Errorf("footer:\n%s", got)
	}
	// The footer's own lines are never a verdict: "<one-line reason>" is a reason, so only the user line's place guards it.
	if NewWrapUpTracker("shell", wrapUpNonce, 0) != nil || NewWrapUpTracker(Claude, "xyz", 0) != nil {
		t.Error("tracker for a bad harness or nonce")
	}
}
