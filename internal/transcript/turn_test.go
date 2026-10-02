package transcript

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The follow-up fixtures (testdata/{claude,codex}/followup_*.jsonl) are
// synthetic, in the shapes of Claude Code 2.1.285 and codex-cli 0.159.2: a
// prompt, a tool call and its result, and the final message (Claude's in two
// lines of one message id: thinking, then text, stop_reason null), then the
// turn's end.
const fixtureQuestions = "I refactored the session loader and all 42 tests pass.\n\n## Open questions for you\n" +
	"- Does the legacy importer still need the v1 format?\n" +
	"- Do you want to ship this already, or wait for the e2e-live run?"

func followupLines(t *testing.T, harness, name string) [][]byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", harness, name))
	if err != nil {
		t.Fatal(err)
	}
	var out [][]byte
	for _, l := range bytes.Split(b, []byte("\n")) {
		if len(bytes.TrimSpace(l)) > 0 {
			out = append(out, l)
		}
	}
	return out
}

func TestFollowupTrackerFixtures(t *testing.T) {
	for _, tc := range []struct{ harness, file, text string }{
		{Claude, "followup_questions.jsonl", fixtureQuestions},
		{Codex, "followup_questions.jsonl", fixtureQuestions},
		{Claude, "followup_summary.jsonl", "Done, PR merged. CI is green and the branch is deleted."},
		{Codex, "followup_summary.jsonl", "Done, PR merged. CI is green and the branch is deleted."},
		{Claude, "followup_freelancer.jsonl", "Review round 1 is written to the report.\n\nQuestions for the orchestrator:\n" +
			"- Should the coder also cover the Codex path?\n- Is a second round needed?"},
	} {
		t.Run(tc.harness+"/"+tc.file, func(t *testing.T) {
			tr := NewFollowupTracker(tc.harness)
			lines := followupLines(t, tc.harness, tc.file)
			for i, l := range lines {
				tr.Line(l)
				if i < len(lines)-2 && tr.Turn() != nil {
					t.Fatalf("a turn ended at line %d: %+v", i+1, tr.Turn())
				}
			}
			turn := tr.Turn()
			if turn == nil || turn.Text != tc.text {
				t.Fatalf("turn = %+v, want text %q", turn, tc.text)
			}
			sum := sha256.Sum256([]byte(tc.text))
			if h := hex.EncodeToString(sum[:]); turn.Hash != h || turn.ID != h[:16] {
				t.Fatalf("hash %q id %q", turn.Hash, turn.ID)
			}
			// The same lines read again (a restart): the same turn.
			again := NewFollowupTracker(tc.harness)
			for _, l := range lines {
				again.Line(l)
			}
			if *again.Turn() != *turn {
				t.Fatalf("re-read: %+v", again.Turn())
			}
			// A new prompt resets it.
			seq := tr.Seq()
			if tc.harness == Claude {
				tr.Line([]byte(`{"type":"user","isSidechain":false,"message":{"role":"user","content":"Go on."}}`))
			} else {
				tr.Line([]byte(`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Go on."}]}}`))
			}
			if tr.Turn() != nil || tr.Seq() == seq {
				t.Fatalf("after a prompt: %+v (seq %d → %d)", tr.Turn(), seq, tr.Seq())
			}
		})
	}
}

func TestFollowupTrackerTurns(t *testing.T) {
	say := func(id, text, stop string) []byte {
		s := `null`
		if stop != "" {
			s = `"` + stop + `"`
		}
		return []byte(`{"type":"assistant","isSidechain":false,"message":{"id":"` + id + `","role":"assistant","content":[{"type":"text","text":"` +
			text + `"}],"stop_reason":` + s + `}}`)
	}
	turnEnd := []byte(`{"type":"system","subtype":"turn_duration","durationMs":5}`)
	user := func(text string) []byte {
		return []byte(`{"type":"user","isSidechain":false,"message":{"role":"user","content":"` + text + `"}}`)
	}

	t.Run("claude end_turn ends it", func(t *testing.T) {
		tr := NewFollowupTracker(Claude)
		tr.Line(user("Hi"))
		tr.Line(say("m1", "Shall I?", "end_turn"))
		if tr.Turn() == nil || tr.Turn().Text != "Shall I?" {
			t.Fatalf("turn = %+v", tr.Turn())
		}
		seq := tr.Seq()
		tr.Line(turnEnd) // the same turn
		if tr.Seq() != seq {
			t.Fatal("turn_duration after end_turn changed it")
		}
	})
	t.Run("only the final message", func(t *testing.T) {
		tr := NewFollowupTracker(Claude)
		tr.Line(user("Hi"))
		tr.Line(say("m1", "Should I look first?", ""))
		tr.Line(say("m2", "Done.", ""))
		tr.Line(turnEnd)
		if tr.Turn() == nil || tr.Turn().Text != "Done." {
			t.Fatalf("turn = %+v", tr.Turn())
		}
	})
	t.Run("interrupted", func(t *testing.T) {
		tr := NewFollowupTracker(Claude)
		tr.Line(user("Hi"))
		tr.Line(say("m1", "Shall I?", ""))
		tr.Line(user("[Request interrupted by user]"))
		tr.Line(turnEnd)
		if tr.Turn() != nil {
			t.Fatalf("an interrupted turn: %+v", tr.Turn())
		}
		codex := NewFollowupTracker(Codex)
		codex.Line([]byte(`{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Shall I?"}]}}`))
		codex.Line([]byte(`{"type":"event_msg","payload":{"type":"turn_aborted"}}`))
		if codex.Turn() != nil {
			t.Fatalf("an aborted Codex turn: %+v", codex.Turn())
		}
	})
	t.Run("sidechain and tool results", func(t *testing.T) {
		tr := NewFollowupTracker(Claude)
		tr.Line(user("Hi"))
		tr.Line([]byte(`{"type":"assistant","isSidechain":true,"message":{"id":"s1","role":"assistant","content":[{"type":"text","text":"Subagent?"}],"stop_reason":"end_turn"}}`))
		if tr.Turn() != nil {
			t.Fatal("a subagent's message ended the turn")
		}
		tr.Line(say("m1", "Done?", "end_turn"))
		tr.Line([]byte(`{"type":"user","isSidechain":false,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"x"}]}}`))
		if tr.Turn() != nil {
			t.Fatal("a tool result after it: the turn goes on")
		}
	})
	t.Run("codex last_agent_message", func(t *testing.T) {
		tr := NewFollowupTracker(Codex)
		tr.Line([]byte(`{"type":"event_msg","payload":{"type":"task_started"}}`))
		tr.Line([]byte(`{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"  Which one?  "}}`))
		if tr.Turn() == nil || tr.Turn().Text != "Which one?" {
			t.Fatalf("turn = %+v", tr.Turn())
		}
		tr.Line([]byte(`{"type":"event_msg","payload":{"type":"task_started"}}`))
		if tr.Turn() != nil {
			t.Fatal("a new task did not reset it")
		}
	})
	t.Run("empty", func(t *testing.T) {
		tr := NewFollowupTracker(Claude)
		tr.Line(user("Hi"))
		tr.Line(turnEnd)
		if tr.Turn() != nil {
			t.Fatal("a turn without text")
		}
		if NewFollowupTracker("pi") != nil {
			t.Fatal("a tracker for another harness")
		}
	})
	t.Run("reset", func(t *testing.T) {
		tr := NewFollowupTracker(Claude)
		tr.Line(say("m1", "Ok?", "end_turn"))
		tr.Reset()
		if tr.Turn() != nil {
			t.Fatal("not reset")
		}
	})
}

// One parse serves both trackers: the wrap-up tracker given TurnEvents reads
// what it reads from the line itself.
func TestTurnEventsShared(t *testing.T) {
	for _, harness := range []string{Claude, Codex} {
		a, b := NewWrapUpTracker(harness, wrapUpNonce, 0), NewWrapUpTracker(harness, wrapUpNonce, 0)
		raw, err := os.ReadFile(filepath.Join("testdata", harness, "wrapup_clean.jsonl"))
		if err != nil {
			t.Fatal(err)
		}
		var off int64
		for _, l := range bytes.SplitAfter(raw, []byte("\n")) {
			if line := bytes.TrimRight(l, "\n"); len(strings.TrimSpace(string(line))) > 0 {
				a.Line(off, line)
				b.Events(off, TurnEvents(harness, line))
			}
			off += int64(len(l))
		}
		if a.State() != b.State() || a.State().Verdict != WrapUpClean {
			t.Fatalf("%s: %+v vs %+v", harness, a.State(), b.State())
		}
	}
}
