package transcript

import (
	"testing"
)

// #224: an agent handoff request's turn. Claude Code records a "/handoff
// args" prompt as its command tags (checked on Claude Code 2.1.296: the
// arguments verbatim, line ends kept), followed by the skill's text as an
// isMeta line; Codex records "$handoff args" as plain text. The tracker
// takes either as the bridge's prompt by its marker, and the skill's own
// line is not a person's.
func TestMarkerTrackerSlashCommand(t *testing.T) {
	const marker = "(H3D-HANDOFF " + wrapUpNonce + ")"
	args := "summarize the conversation\n\nWrite it to /h/.pending/f/op.md.tmp, then rename it.\n\n" + marker
	claude := []string{
		`{"type":"user","isSidechain":false,"message":{"role":"user","content":"earlier"}}`,
		wrapUpJSON(map[string]any{"type": "user", "isSidechain": false, "message": map[string]any{"role": "user",
			"content": "<command-message>handoff</command-message>\n<command-name>/handoff</command-name>\n<command-args>" + args + "</command-args>"}}),
		wrapUpJSON(map[string]any{"type": "user", "isMeta": true, "isSidechain": false, "message": map[string]any{"role": "user",
			"content": []any{map[string]any{"type": "text", "text": "Base directory for this skill: /x\n\nARGUMENTS: " + args}}}}),
		`{"type":"assistant","isSidechain":false,"message":{"id":"m1","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Write","input":{}}],"stop_reason":"tool_use"}}`,
		`{"type":"user","isSidechain":false,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}`,
	}
	codex := []string{
		wrapUpPromptLine(Codex, "earlier"),
		wrapUpPromptLine(Codex, "$handoff "+args),
		`{"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{}","call_id":"c1"}}`,
	}
	for harness, lines := range map[string][]string{Claude: claude, Codex: codex} {
		tr := NewMarkerTracker(harness, wrapUpNonce, marker, 0)
		at := feedLines(tr, 0, lines...)
		if st := tr.State(); !st.Prompted || st.TookOver || st.Ended {
			t.Fatalf("%s: %+v, want prompted, the turn going on", harness, st)
		}
		at = feedLines(tr, at, wrapUpFinalLines(harness, "m2", "Wrote the handoff.")...)
		if st := tr.State(); !st.Ended || st.TookOver {
			t.Fatalf("%s: %+v, want ended", harness, st)
		}
		feedLines(tr, at, wrapUpPromptLine(harness, "thanks, now do X"))
		if st := tr.State(); !st.TookOver {
			t.Fatalf("%s: %+v, want took over", harness, st)
		}
	}
	// A prompt without the marker (a person's "/handoff") is not the
	// bridge's; nor is a prompt before the offset.
	tr := NewMarkerTracker(Claude, wrapUpNonce, marker, 1000)
	feedLines(tr, 0, claude[1])
	feedLines(tr, 1000, wrapUpJSON(map[string]any{"type": "user", "isSidechain": false, "message": map[string]any{"role": "user",
		"content": "<command-message>handoff</command-message>\n<command-name>/handoff</command-name>\n<command-args>x</command-args>"}}))
	if st := tr.State(); st.Prompted || st.TookOver {
		t.Fatalf("not the bridge's: %+v", st)
	}
	if NewMarkerTracker(Claude, wrapUpNonce, " ", 0) != nil || NewMarkerTracker("gemini", wrapUpNonce, marker, 0) != nil {
		t.Fatal("made a tracker without a marker or for another harness")
	}
}

func TestSlashCommand(t *testing.T) {
	for in, want := range map[string]string{
		"<command-message>handoff</command-message>\n<command-name>/handoff</command-name>\n<command-args>a\nb</command-args>": "/handoff a\nb",
		"<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>":         "/clear",
		"<local-command-stdout>x</local-command-stdout>":                                                                       "",
		"plain /handoff": "",
	} {
		got, ok := slashCommand(in)
		if got != want || ok != (want != "") {
			t.Errorf("slashCommand(%q) = %q, %v; want %q", in, got, ok, want)
		}
	}
}
