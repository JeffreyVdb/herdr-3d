package transcript

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The handoff fixtures (testdata/{claude,codex}/handoff_*.jsonl) are real
// lines of Claude Code 2.1.267–2.1.296 and codex-cli 0.145.0–0.162.1, their
// prose redacted to "Synthetic run N." (identical texts stay identical), from
// the #223 JSONL research; three are synthesized in part: the fenced reply's
// text, the final followed by a prompt, and the two-line final of
// handoff_multi_text_blocks.

// turnDurationLine closes a Claude message at a file's end, as the
// interactive TUI writes it after the stop hooks.
const turnDurationLine = `{"type":"system","subtype":"turn_duration","durationMs":5,"isSidechain":false}`

// feedFile feeds a transcript file's lines (and extra lines after it) to a
// tracker, and returns the bytes it read.
func feedFile(t *testing.T, tr *HandoffTracker, path string, extra ...string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(extra) > 0 {
		if !bytes.HasSuffix(raw, []byte("\n")) {
			raw = append(raw, '\n')
		}
		raw = append(raw, []byte(strings.Join(extra, "\n")+"\n")...)
	}
	var off int64
	for _, l := range bytes.SplitAfter(raw, []byte("\n")) {
		if line := bytes.TrimRight(l, "\n"); len(line) > 0 {
			tr.Line(off, line)
		}
		off += int64(len(l))
	}
	return raw
}

func TestHandoffFixtures(t *testing.T) {
	for _, tc := range []struct {
		harness, file string
		close         bool   // a turn_duration line after it (the file ends inside the turn)
		body          string // "": no candidate
		msg           string
	}{
		{Claude, "handoff_multiblock_final.jsonl", false, "Synthetic run 8.", "msg_SYN0006"},
		{Claude, "handoff_headless_no_turn_duration.jsonl", false, "Synthetic run 12.", "msg_SYN0028"},
		{Claude, "handoff_thinking_only_end_turn.jsonl", true, "Synthetic run 10.", "msg_SYN0019"},
		{Claude, "handoff_multi_text_blocks.jsonl", true, "Synthetic run 65.\n" + HandoffSeparator + "Synthetic run 66.\n", "msg_SYN0096"},
		{Claude, "handoff_fenced_whitespace_reply.jsonl", true,
			"  Synthetic lead line.\n\n```text\nsynthetic code line\n```\n\nSynthetic trailing line.\n\n  ", "msg_SYN0078"},
		{Claude, "handoff_identical_replies.jsonl", false, "Synthetic run 49.", "msg_SYN0072"},
		{Claude, "handoff_interrupted.jsonl", true, "", ""},
		{Claude, "handoff_sidechain_subagent.jsonl", true, "", ""},
		{Claude, "handoff_compaction_summary.jsonl", true, "", ""},
		{Claude, "handoff_final_then_prompt.jsonl", true, "", ""}, // the new prompt: not the latest any more
		{Codex, "handoff_phase_commentary_final.jsonl", false, "Synthetic run 131.", "msg_SYN0114"},
		{Codex, "handoff_legacy_no_phase.jsonl", false, "Synthetic run 156.", "msg_SYN0122"},
		{Codex, "handoff_duplicate_agent_message.jsonl", false, "Synthetic run 178.", "msg_SYN0124"},
		{Codex, "handoff_identical_replies.jsonl", false, "Synthetic run 200.", "msg_SYN0149"},
		{Codex, "handoff_aborted_turn.jsonl", false, "", ""},
		{Codex, "handoff_null_last_agent_message.jsonl", false, "", ""},
	} {
		t.Run(tc.harness+"/"+tc.file, func(t *testing.T) {
			tr := NewHandoffTracker(tc.harness)
			var extra []string
			if tc.close {
				extra = []string{turnDurationLine}
			}
			path := filepath.Join("testdata", tc.harness, tc.file)
			feedFile(t, tr, path, extra...)
			c := tr.Candidate()
			if tc.body == "" {
				if c != nil {
					t.Fatalf("a candidate: %+v", c)
				}
				return
			}
			if c == nil || c.Body != tc.body || c.Message != tc.msg || c.Source != CandMessage || (c.Session == "" && tc.harness == Claude) {
				t.Fatalf("candidate = %+v, want body %q of %s", c, tc.body, tc.msg)
			}
			sum := sha256.Sum256([]byte(tc.body))
			if c.Hash != hex.EncodeToString(sum[:]) || len(c.ID) != 16 {
				t.Fatalf("hash %q id %q", c.Hash, c.ID)
			}
			// The same lines read again (a restart): the same candidate.
			again := NewHandoffTracker(tc.harness)
			feedFile(t, again, path, extra...)
			if again.Candidate().ID != c.ID {
				t.Fatalf("re-read: %+v", again.Candidate())
			}
			if !tc.close {
				// Resolve reads the whole text again from the file.
				fi, err := os.Stat(path)
				if err != nil {
					t.Fatal(err)
				}
				body, err := Resolve(path, fi, c, 1<<20)
				if err != nil || body != tc.body {
					t.Fatalf("Resolve = %q, %v", body, err)
				}
			}
		})
	}
}

// Two turns with the same reply are two candidates (and two follow-up
// turns), not one.
func TestHandoffIdenticalReplies(t *testing.T) {
	for _, h := range []string{Claude, Codex} {
		raw, err := os.ReadFile(filepath.Join("testdata", h, "handoff_identical_replies.jsonl"))
		if err != nil {
			t.Fatal(err)
		}
		tr, fu := NewHandoffTracker(h), NewFollowupTracker(h)
		cands, turns := map[string]string{}, map[string]string{}
		var off int64
		for _, l := range bytes.SplitAfter(raw, []byte("\n")) {
			if line := bytes.TrimRight(l, "\n"); len(line) > 0 {
				evs := TurnEvents(h, line)
				tr.Events(Span{Off: off, N: len(line)}, line, evs)
				fu.Events(evs)
				if c := tr.Candidate(); c != nil {
					cands[c.ID] = c.Hash
				}
				if tu := fu.Turn(); tu != nil {
					turns[tu.ID] = tu.Hash
				}
			}
			off += int64(len(l))
		}
		if len(cands) != 2 || len(turns) != 2 {
			t.Fatalf("%s: candidates %v, follow-up turns %v: want two of each", h, cands, turns)
		}
		var hashes []string
		for _, x := range cands {
			hashes = append(hashes, x)
		}
		if hashes[0] != hashes[1] {
			t.Fatalf("%s: the replies differ: %v", h, hashes)
		}
	}
}

func claudeSay(id, uuid string, blocks, stop string) string {
	s := `null`
	if stop != "" {
		s = `"` + stop + `"`
	}
	return `{"type":"assistant","isSidechain":false,"uuid":"` + uuid + `","requestId":"req_` + id + `","sessionId":"sess-1","message":{"id":"` +
		id + `","role":"assistant","content":[` + blocks + `],"stop_reason":` + s + `}}`
}

func textBlock(s string) string { return `{"type":"text","text":"` + s + `"}` }

func feedHandoff(tr *HandoffTracker, lines ...string) {
	var off int64
	for _, l := range lines {
		tr.Line(off, []byte(l))
		off += int64(len(l)) + 1
	}
}

func TestHandoffClaudeRules(t *testing.T) {
	user := `{"type":"user","isSidechain":false,"message":{"role":"user","content":"Go."}}`
	hook := `{"type":"system","subtype":"stop_hook_summary","isSidechain":false}`
	for _, tc := range []struct {
		name  string
		lines []string
		body  string
	}{
		{"end_turn closed by the stop hook", []string{user, claudeSay("m1", "u1", textBlock("Done."), "end_turn"), hook}, "Done."},
		{"open at the end: not yet", []string{user, claudeSay("m1", "u1", textBlock("Done."), "end_turn")}, ""},
		{"stop_sequence", []string{user, claudeSay("m1", "u1", textBlock("Done."), "stop_sequence"), hook}, "Done."},
		{"refusal", []string{user, claudeSay("m1", "u1", textBlock("No."), "refusal"), turnDurationLine}, ""},
		{"max_tokens", []string{user, claudeSay("m1", "u1", textBlock("Cut"), "max_tokens"), turnDurationLine}, ""},
		{"tool_use", []string{user, claudeSay("m1", "u1", textBlock("Looking."), "tool_use"), turnDurationLine}, ""},
		{"null confirmed by turn_duration", []string{user, claudeSay("m1", "u1", textBlock("Done."), ""), turnDurationLine}, "Done."},
		{"null, no turn_duration", []string{user, claudeSay("m1", "u1", textBlock("Done."), ""), hook}, ""},
		{"null, then a prompt", []string{user, claudeSay("m1", "u1", textBlock("Done."), ""), user, turnDurationLine}, ""},
		{"thinking only", []string{user, claudeSay("m1", "u1", `{"type":"thinking","thinking":"hm"}`, "end_turn"), turnDurationLine}, ""},
		{"blank text", []string{user, claudeSay("m1", "u1", textBlock("  "), "end_turn"), turnDurationLine}, ""},
		{"sidechain", []string{user, strings.Replace(claudeSay("m1", "u1", textBlock("Sub."), "end_turn"), `"isSidechain":false`, `"isSidechain":true`, 1), turnDurationLine}, ""},
		{"a later message of the agent", []string{user, claudeSay("m1", "u1", textBlock("Done."), "end_turn"), hook,
			claudeSay("m2", "u2", textBlock("Also…"), "tool_use")}, ""},
		{"a line of it after an attachment", []string{user, claudeSay("m1", "u1", textBlock("One."), "end_turn"),
			`{"type":"attachment","isSidechain":false,"attachment":{"type":"date"}}`, claudeSay("m1", "u2", textBlock("Two."), "end_turn"), hook},
			"One." + HandoffSeparator + "Two."},
		{"interrupted", []string{user, claudeSay("m1", "u1", textBlock("Done."), "end_turn"),
			`{"type":"user","isSidechain":false,"message":{"role":"user","content":"[Request interrupted by user]"}}`}, ""},
		{"compaction summary after it", []string{user, claudeSay("m1", "u1", textBlock("Done."), "end_turn"),
			`{"type":"user","isSidechain":false,"isCompactSummary":true,"message":{"role":"user","content":"This session is being continued…"}}`},
			"Done."},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tr := NewHandoffTracker(Claude)
			feedHandoff(tr, tc.lines...)
			c := tr.Candidate()
			switch {
			case tc.body == "" && c != nil:
				t.Fatalf("a candidate: %+v", c)
			case tc.body != "" && (c == nil || c.Body != tc.body):
				t.Fatalf("candidate = %+v, want %q", c, tc.body)
			}
		})
	}
	t.Run("identity and images", func(t *testing.T) {
		tr := NewHandoffTracker(Claude)
		feedHandoff(tr, user, claudeSay("m1", "u1", textBlock("See:")+`,{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AA=="}}`, "end_turn"), hook)
		c := tr.Candidate()
		if c == nil || c.Session != "sess-1" || c.Request != "req_m1" || c.Line != "u1" || c.Images != 1 || len(c.Spans) != 1 {
			t.Fatalf("candidate = %+v", c)
		}
		seq := tr.Seq()
		tr.Reset()
		if tr.Candidate() != nil || tr.Seq() == seq {
			t.Fatal("not reset")
		}
	})
}

func cxLine(typ, payload string) string {
	return `{"timestamp":"2026-10-10T00:00:00Z","type":"` + typ + `","payload":` + payload + `}`
}

func codexSay(id, phase, text string) string {
	ph := ""
	if phase != "" {
		ph = `,"phase":"` + phase + `"`
	}
	return cxLine("response_item", `{"type":"message","id":"`+id+`","role":"assistant","content":[{"type":"output_text","text":"`+text+`"}]`+ph+`}`)
}

func TestHandoffCodexRules(t *testing.T) {
	meta := cxLine("session_meta", `{"id":"sess-c","source":"cli"}`)
	start := func(id, root string) string {
		return cxLine("event_msg", `{"type":"task_started","turn_id":"`+id+`","root_turn_id":"`+root+`"}`)
	}
	done := func(id, last string) string {
		l := `null`
		if last != "" {
			l = `"` + last + `"`
		}
		return cxLine("event_msg", `{"type":"task_complete","turn_id":"`+id+`","last_agent_message":`+l+`}`)
	}
	for _, tc := range []struct {
		name   string
		lines  []string
		body   string
		source string
	}{
		{"two finals: the last", []string{meta, start("t1", "t1"), codexSay("a", "final_answer", "First."), codexSay("b", "commentary", "More."),
			codexSay("c", "final_answer", "Second."), done("t1", "Second.")}, "Second.", CandMessage},
		{"commentary only", []string{meta, start("t1", "t1"), codexSay("a", "commentary", "Looking."), done("t1", "")}, "", ""},
		{"final, null last_agent_message", []string{meta, start("t1", "t1"), codexSay("a", "final_answer", "Done."), done("t1", "")}, "Done.", CandMessage},
		{"no message: last_agent_message", []string{meta, start("t1", "t1"), done("t1", "From the event.")}, "From the event.", CandLastAgentMessage},
		{"aborted", []string{meta, start("t1", "t1"), codexSay("a", "final_answer", "Done."), cxLine("event_msg", `{"type":"turn_aborted","turn_id":"t1"}`)}, "", ""},
		{"unfinished", []string{meta, start("t1", "t1"), codexSay("a", "final_answer", "Done.")}, "", ""},
		{"child turn", []string{meta, start("t2", "t1"), codexSay("a", "final_answer", "Done."), done("t2", "Done.")}, "", ""},
		{"subagent rollout", []string{cxLine("session_meta", `{"id":"sess-s","source":{"subagent":{"other":"guardian"}}}`), start("t1", "t1"),
			codexSay("a", "final_answer", "Done."), done("t1", "Done.")}, "", ""},
		{"a new turn", []string{meta, start("t1", "t1"), codexSay("a", "final_answer", "Done."), done("t1", "Done."), start("t2", "t2")}, "", ""},
		{"a new prompt", []string{meta, start("t1", "t1"), codexSay("a", "final_answer", "Done."), done("t1", "Done."),
			cxLine("response_item", `{"type":"message","role":"user","content":[{"type":"input_text","text":"Next."}]}`)}, "", ""},
		{"event copies are not read", []string{meta, start("t1", "t1"), cxLine("event_msg", `{"type":"agent_message","message":"Copy.","phase":"final_answer"}`),
			codexSay("a", "final_answer", "Done."), cxLine("event_msg", `{"type":"item_completed","turn_id":"t1","item":{"id":"a","phase":"final_answer","content":[{"type":"output_text","text":"Done."}]}}`),
			done("t1", "Done.")}, "Done.", CandMessage},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tr := NewHandoffTracker(Codex)
			feedHandoff(tr, tc.lines...)
			c := tr.Candidate()
			switch {
			case tc.body == "" && c != nil:
				t.Fatalf("a candidate: %+v", c)
			case tc.body != "" && (c == nil || c.Body != tc.body || c.Source != tc.source || c.Session != "sess-c" || c.Turn == ""):
				t.Fatalf("candidate = %+v, want %q (%s)", c, tc.body, tc.source)
			}
		})
	}
}

func TestHandoffResolve(t *testing.T) {
	dir := t.TempDir()
	long := strings.Repeat("x", 9000) // past any preview
	lines := []string{
		`{"type":"user","isSidechain":false,"message":{"role":"user","content":"Go."}}`,
		claudeSay("m1", "u1", textBlock("# Title\\n\\n  keep   spaces  \\n```go\\nfunc x() {}\\n```\\n"), "end_turn"),
		claudeSay("m1", "u2", textBlock(long), "end_turn"),
		turnDurationLine,
	}
	path := filepath.Join(dir, "s.jsonl")
	write := func(lines []string) {
		if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(lines)
	tr := NewHandoffTracker(Claude)
	feedFile(t, tr, path)
	c := tr.Candidate()
	want := "# Title\n\n  keep   spaces  \n```go\nfunc x() {}\n```\n" + HandoffSeparator + long
	if c == nil || c.Body != want || len(c.Spans) != 2 {
		t.Fatalf("candidate = %+v", c)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	body, err := Resolve(path, fi, c, 1<<20)
	if err != nil || body != want {
		t.Fatalf("Resolve = %d bytes, %v", len(body), err)
	}
	if _, err := Resolve(path, fi, c, 100); !errors.Is(err, ErrSourceTooLarge) {
		t.Fatalf("above the cap: %v", err)
	}
	stale := *c
	stale.Hash = strings.Repeat("0", 64)
	if _, err := Resolve(path, fi, &stale, 1<<20); !errors.Is(err, ErrSourceChanged) {
		t.Fatalf("another revision: %v", err)
	}
	other := *c
	other.Message = "m2"
	if _, err := Resolve(path, fi, &other, 1<<20); !errors.Is(err, ErrSourceChanged) {
		t.Fatalf("another message: %v", err)
	}
	// Replaced: another file at the path (another inode), same content.
	tmp := path + ".new"
	if err := os.WriteFile(tmp, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, path); err != nil {
		t.Fatal(err)
	}
	if _, err := Resolve(path, fi, c, 1<<20); !errors.Is(err, ErrSourceReplaced) {
		t.Fatalf("replaced: %v", err)
	}
	// Truncated in place.
	fi, _ = os.Stat(path)
	if err := os.Truncate(path, c.Spans[1].Off+10); err != nil {
		t.Fatal(err)
	}
	if _, err := Resolve(path, fi, c, 1<<20); !errors.Is(err, ErrSourceReplaced) {
		t.Fatalf("truncated: %v", err)
	}
	// Rewritten in place with other text of the same length.
	write(append([]string{lines[0], strings.Replace(lines[1], "Title", "Tutle", 1)}, lines[2:]...))
	fi, _ = os.Stat(path)
	if _, err := Resolve(path, fi, c, 1<<20); !errors.Is(err, ErrSourceChanged) {
		t.Fatalf("rewritten: %v", err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, err := Resolve(path, fi, c, 1<<20); !errors.Is(err, ErrSourceReplaced) {
		t.Fatalf("gone: %v", err)
	}
}

// Truncated below the size it had when the candidate was read, the reply's
// lines still there but its completion (turn_duration) gone: replaced.
func TestHandoffResolveTruncatedSuffix(t *testing.T) {
	path := filepath.Join(t.TempDir(), "s.jsonl")
	final := claudeSay("m1", "u1", textBlock("Done."), "end_turn")
	if err := os.WriteFile(path, []byte(final+"\n"+turnDurationLine+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	tr := NewHandoffTracker(Claude)
	feedFile(t, tr, path)
	c := tr.Candidate()
	fi, err := os.Stat(path)
	if err != nil || c == nil {
		t.Fatalf("candidate %+v, %v", c, err)
	}
	if err := os.Truncate(path, int64(len(final)+1)); err != nil {
		t.Fatal(err)
	}
	if body, err := Resolve(path, fi, c, 1<<20); !errors.Is(err, ErrSourceReplaced) {
		t.Fatalf("Resolve = %q, %v", body, err)
	}
	if err := StillLatest(path, fi, c, fi.Size()); !errors.Is(err, ErrSourceReplaced) {
		t.Fatalf("StillLatest: %v", err)
	}
}

// StillLatest reads the lines written after the candidate was seen with the
// tracker's own rules: a new prompt, another message or turn makes it stale;
// lines that leave it the latest do not.
func TestHandoffStillLatest(t *testing.T) {
	user := `{"type":"user","isSidechain":false,"message":{"role":"user","content":"Go."}}`
	hook := `{"type":"system","subtype":"stop_hook_summary","isSidechain":false}`
	meta := cxLine("session_meta", `{"id":"sess-c","source":"cli"}`)
	cxTurn := []string{meta, cxLine("event_msg", `{"type":"task_started","turn_id":"t1","root_turn_id":"t1"}`),
		codexSay("a", "final_answer", "Done."), cxLine("event_msg", `{"type":"task_complete","turn_id":"t1","last_agent_message":"Done."}`)}
	for _, tc := range []struct {
		name    string
		harness string
		lines   []string
		after   []string
		stale   bool
	}{
		{"claude: nothing since", Claude, []string{user, claudeSay("m1", "u1", textBlock("Done."), "end_turn"), turnDurationLine}, nil, false},
		{"claude: a stop hook and an attachment", Claude, []string{user, claudeSay("m1", "u1", textBlock("Done."), "end_turn"), hook},
			[]string{`{"type":"attachment","isSidechain":false,"attachment":{"type":"date"}}`, turnDurationLine}, false},
		{"claude: a new prompt", Claude, []string{user, claudeSay("m1", "u1", textBlock("Done."), "end_turn"), turnDurationLine},
			[]string{user}, true},
		{"claude: another message", Claude, []string{user, claudeSay("m1", "u1", textBlock("Done."), "end_turn"), hook},
			[]string{claudeSay("m2", "u2", textBlock("Also…"), "tool_use")}, true},
		{"claude: a line of it again", Claude, []string{user, claudeSay("m1", "u1", textBlock("One."), "end_turn"), hook},
			[]string{claudeSay("m1", "u2", textBlock("Two."), "end_turn"), hook}, true},
		{"claude: an interruption", Claude, []string{user, claudeSay("m1", "u1", textBlock("Done."), "end_turn"), hook},
			[]string{`{"type":"user","isSidechain":false,"message":{"role":"user","content":"[Request interrupted by user]"}}`}, true},
		{"codex: nothing since", Codex, cxTurn, nil, false},
		{"codex: a new prompt", Codex, cxTurn,
			[]string{cxLine("response_item", `{"type":"message","role":"user","content":[{"type":"input_text","text":"Next."}]}`)}, true},
		{"codex: a new turn", Codex, cxTurn, []string{cxLine("event_msg", `{"type":"task_started","turn_id":"t2","root_turn_id":"t2"}`)}, true},
		{"codex: an event copy", Codex, cxTurn, []string{cxLine("event_msg", `{"type":"token_count","info":null}`)}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "s.jsonl")
			if err := os.WriteFile(path, []byte(strings.Join(tc.lines, "\n")+"\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			tr := NewHandoffTracker(tc.harness)
			feedFile(t, tr, path)
			c := tr.Candidate()
			fi, err := os.Stat(path)
			if err != nil || c == nil {
				t.Fatalf("candidate %+v, %v", c, err)
			}
			if len(tc.after) > 0 {
				f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
				if err != nil {
					t.Fatal(err)
				}
				f.WriteString(strings.Join(tc.after, "\n") + "\n")
				f.Close()
			}
			// The tracker's verdict on the same lines is the reference.
			again := NewHandoffTracker(tc.harness)
			feedFile(t, again, path)
			if latest := again.Candidate() != nil && again.Candidate().ID == c.ID; latest == tc.stale {
				t.Fatalf("the tracker says latest=%v", latest)
			}
			err = StillLatest(path, fi, c, fi.Size())
			switch {
			case tc.stale && !errors.Is(err, ErrNotLatest):
				t.Fatalf("stale: %v", err)
			case !tc.stale && err != nil:
				t.Fatalf("still the latest: %v", err)
			}
			// A partial line at the end is not read yet.
			if !tc.stale {
				f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
				f.WriteString(user[:20])
				f.Close()
				if err := StillLatest(path, fi, c, fi.Size()); err != nil {
					t.Fatalf("a partial line: %v", err)
				}
			}
		})
	}
	t.Run("replaced", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "s.jsonl")
		os.WriteFile(path, []byte(strings.Join(cxTurn, "\n")+"\n"), 0o600)
		tr := NewHandoffTracker(Codex)
		feedFile(t, tr, path)
		fi, _ := os.Stat(path)
		// The new file is written while the old one still exists, then renamed
		// over it: a remove first would free the old inode, which the
		// filesystem may hand straight to the new file (ext4 does).
		os.WriteFile(path+".new", []byte(strings.Join(cxTurn, "\n")+"\n"), 0o600)
		os.Rename(path+".new", path)
		if err := StillLatest(path, fi, tr.Candidate(), fi.Size()); !errors.Is(err, ErrSourceReplaced) {
			t.Fatalf("replaced: %v", err)
		}
	})
}

// Truncated below what was read and grown again past it, the same file: the
// lines that completed the candidate (and those read after it) must still be
// what they were, not only the reply's own lines. A regrown file the tracker
// would find no candidate in is rejected.
func TestHandoffTruncateRegrow(t *testing.T) {
	user := `{"type":"user","isSidechain":false,"message":{"role":"user","content":"Go."}}`
	hook := `{"type":"system","subtype":"stop_hook_summary","isSidechain":false}`
	pad := func(n int) string {
		return `{"type":"attachment","isSidechain":false,"attachment":{"type":"date","padding":"` + strings.Repeat("x", n) + `"}}`
	}
	cxTurn := []string{cxLine("session_meta", `{"id":"sess-c","source":"cli"}`),
		cxLine("event_msg", `{"type":"task_started","turn_id":"t1","root_turn_id":"t1"}`), codexSay("a", "final_answer", "Done."),
		cxLine("event_msg", `{"type":"task_complete","turn_id":"t1","last_agent_message":"Done."}`)}
	for _, tc := range []struct {
		name    string
		harness string
		lines   []string
		keep    int    // the lines kept by the truncation
		regrow  string // the line written after it
		want    error  // nil: still the candidate
	}{
		{"claude: the turn_duration that confirmed a null stop_reason", Claude,
			[]string{user, claudeSay("m1", "u1", textBlock("Done."), ""), turnDurationLine}, 2, pad(len(turnDurationLine)), ErrSourceChanged},
		{"claude: the line that closed an end_turn reply, now a line of it", Claude,
			[]string{user, claudeSay("m1", "u1", textBlock("Done."), "end_turn"), hook}, 2,
			claudeSay("m1", "u2", textBlock("More."), "tool_use"), ErrSourceChanged},
		{"claude: a line read after the reply, now a prompt", Claude,
			[]string{user, claudeSay("m1", "u1", textBlock("Done."), "end_turn"), hook, pad(40)}, 3,
			`{"type":"user","isSidechain":false,"message":{"role":"user","content":"Next, at length: ` + strings.Repeat("y", 60) + `"}}`, ErrNotLatest},
		{"codex: the task_complete", Codex, cxTurn, 3, pad(len(cxTurn[3])), ErrSourceChanged},
		{"claude: the same lines again", Claude,
			[]string{user, claudeSay("m1", "u1", textBlock("Done."), ""), turnDurationLine}, 2, turnDurationLine + "\n" + pad(10), nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "s.jsonl")
			if err := os.WriteFile(path, []byte(strings.Join(tc.lines, "\n")+"\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			tr := NewHandoffTracker(tc.harness)
			feedFile(t, tr, path)
			c := tr.Candidate()
			fi, err := os.Stat(path)
			if err != nil || c == nil {
				t.Fatalf("candidate %+v, %v", c, err)
			}
			if err := os.Truncate(path, int64(len(strings.Join(tc.lines[:tc.keep], "\n"))+1)); err != nil {
				t.Fatal(err)
			}
			f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
			if err != nil {
				t.Fatal(err)
			}
			f.WriteString(tc.regrow + "\n")
			f.Close()
			if now, _ := os.Stat(path); !os.SameFile(fi, now) || now.Size() < fi.Size() {
				t.Fatalf("not regrown in place: %d < %d", now.Size(), fi.Size())
			}
			// The tracker's verdict on the regrown file is the reference.
			fresh := NewHandoffTracker(tc.harness)
			feedFile(t, fresh, path)
			if latest := fresh.Candidate() != nil && fresh.Candidate().ID == c.ID; latest != (tc.want == nil) {
				t.Fatalf("the tracker says latest=%v", latest)
			}
			latest := StillLatest(path, fi, c, fi.Size())
			body, err := Resolve(path, fi, c, 1<<20)
			if tc.want == nil {
				if latest != nil || err != nil || body != c.Body {
					t.Fatalf("StillLatest %v, Resolve %q, %v", latest, body, err)
				}
				return
			}
			if !errors.Is(latest, tc.want) {
				t.Fatalf("StillLatest = %v, want %v", latest, tc.want)
			}
			if tc.want == ErrSourceChanged && !errors.Is(err, ErrSourceChanged) {
				t.Fatalf("Resolve = %q, %v", body, err)
			}
		})
	}
}

// A tracker reset (its transcript replaced) and fed the new file seals its
// candidates as a new one does.
func TestHandoffRegionAfterReset(t *testing.T) {
	path := filepath.Join(t.TempDir(), "s.jsonl")
	lines := []string{claudeSay("m1", "u1", textBlock("Done."), ""), turnDurationLine}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	tr := NewHandoffTracker(Claude)
	feedHandoff(tr, claudeSay("m0", "u0", textBlock("Earlier."), "end_turn"), turnDurationLine, turnDurationLine)
	tr.Reset()
	feedFile(t, tr, path)
	c := tr.Candidate()
	fresh := NewHandoffTracker(Claude)
	feedFile(t, fresh, path)
	if f := fresh.Candidate(); c == nil || f == nil || c.ID != f.ID || c.Region != f.Region || c.RegionFrom != f.RegionFrom || c.Through != f.Through {
		t.Fatalf("after a reset %+v, fresh %+v", c, fresh.Candidate())
	}
	fi, _ := os.Stat(path)
	if body, err := Resolve(path, fi, c, 1<<20); err != nil || body != "Done." {
		t.Fatalf("Resolve = %q, %v", body, err)
	}
	if err := StillLatest(path, fi, c, fi.Size()); err != nil {
		t.Fatalf("StillLatest: %v", err)
	}
}

// #66: a follow-up turn's Message names the same transcript row as the
// handoff candidate of the same reply (the schedule suggestion's chip goes
// on it).
func TestFollowupTurnMessageIsTheCandidates(t *testing.T) {
	for _, tc := range []struct{ harness, file string }{
		{Claude, "followup_questions.jsonl"},
		{Codex, "followup_questions.jsonl"},
		{Claude, "followup_summary.jsonl"},
		{Codex, "followup_summary.jsonl"},
	} {
		raw, err := os.ReadFile(filepath.Join("testdata", tc.harness, tc.file))
		if err != nil {
			t.Fatal(err)
		}
		tr, fu := NewHandoffTracker(tc.harness), NewFollowupTracker(tc.harness)
		var off int64
		for _, l := range bytes.SplitAfter(raw, []byte("\n")) {
			if line := bytes.TrimRight(l, "\n"); len(line) > 0 {
				evs := TurnEvents(tc.harness, line)
				tr.Events(Span{Off: off, N: len(line)}, line, evs)
				fu.Events(evs)
			}
			off += int64(len(l))
		}
		c, turn := tr.Candidate(), fu.Turn()
		if c == nil || turn == nil || turn.Message == "" || turn.Message != c.Message {
			t.Fatalf("%s/%s: candidate %+v, turn %+v", tc.harness, tc.file, c, turn)
		}
	}
}
