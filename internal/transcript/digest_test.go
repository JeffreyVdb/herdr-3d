package transcript

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// The digest fixtures (testdata/{claude,codex}/digest_*.jsonl) are synthetic, in the shapes of Claude Code 2.1.285
// and codex-cli 0.159.2: Claude's turn has a message in three lines (thinking, text, a call), a message with text and
// a call, the final message, its ai-title and a recap; digest_clear.jsonl is a /clear, a command without arguments
// and one with; Codex's two turns have calls before and after a message.

func feedDigest(t *testing.T, d *DigestTracker, harness, name string) {
	t.Helper()
	for i, l := range followupLines(t, harness, name) {
		d.Line(int64(i), l, TurnEvents(harness, l))
	}
}

func TestDigestClaudeTurn(t *testing.T) {
	d := NewDigestTracker(Claude)
	feedDigest(t, d, Claude, "digest_turns.jsonl")
	v := d.View()
	prompt := "Add a floor overview to the lounge wall. It should list every worker.\n\nThe details are in the ticket."
	sum := sha256.Sum256([]byte(prompt))
	if v.Prompt != prompt || v.PromptHash != hex.EncodeToString(sum[:]) {
		t.Fatalf("prompt = %q (%s)", v.Prompt, v.PromptHash)
	}
	want := []DigestStep{
		{Texts: []string{"I'll start by reading the layout."}, Tools: []DigestTool{{"Read", "game/src/world/layout.ts"}}},
		{Texts: []string{"The lounge wall is free. Running the tests."}, Tools: []DigestTool{{"Bash", "go test ./..."}}},
		{Texts: []string{"Done: the screen is up and the tests pass."}},
	}
	if v.Steps != 3 || !reflect.DeepEqual(v.Recent, want) {
		t.Fatalf("steps %d, recent = %+v", v.Steps, v.Recent)
	}
	if v.Ended != 1 { // its turn_duration
		t.Fatalf("ended = %d", v.Ended)
	}
	if v.AITitle != "Floor overview on the lounge wall" {
		t.Fatalf("ai-title = %q", v.AITitle)
	}
	if v.Recap != "Built the floor overview screen; the tests pass. Next: a review." || v.RecapAt != 1791021900000 {
		t.Fatalf("recap = %q at %d", v.Recap, v.RecapAt)
	}
	if task, src := v.Task(); task != "Floor overview on the lounge wall" || src != proto.DigestAITitle {
		t.Fatalf("task = %q (%s)", task, src)
	}
	// Without the ai-title: the prompt's first sentence.
	v.AITitle = ""
	if task, src := v.Task(); task != "Add a floor overview to the lounge wall." || src != proto.DigestPrompt {
		t.Fatalf("task = %q (%s)", task, src)
	}
	// The recap holds until the agent moves on: the next prompt.
	seq := d.Seq()
	d.Line(100, []byte(`{"type":"user","isSidechain":false,"message":{"role":"user","content":"Now the review."}}`), TurnEvents(Claude, []byte(`{"type":"user","message":{"role":"user","content":"Now the review."}}`)))
	if v := d.View(); v.Recap != "" || v.RecapAt != 0 || v.Prompt != prompt || d.Seq() == seq {
		t.Fatalf("after a prompt: recap %q, prompt %q", v.Recap, v.Prompt)
	}
}

func TestDigestRecapGoesWithAStep(t *testing.T) {
	d := NewDigestTracker(Claude)
	feedDigest(t, d, Claude, "digest_turns.jsonl")
	l := []byte(`{"type":"assistant","isSidechain":false,"message":{"id":"msg_x","role":"assistant","content":[{"type":"text","text":"Back at it."}],"stop_reason":null}}`)
	d.Line(100, l, TurnEvents(Claude, l))
	if v := d.View(); v.Recap != "" || v.Steps != 4 {
		t.Fatalf("recap %q, %d steps", v.Recap, v.Steps)
	}
}

func TestDigestClearAndCommands(t *testing.T) {
	d := NewDigestTracker(Claude)
	feedDigest(t, d, Claude, "digest_turns.jsonl")
	if v := d.View(); v.Resets != 0 {
		t.Fatalf("resets before /clear = %d", v.Resets)
	}
	feedDigest(t, d, Claude, "digest_clear.jsonl")
	v := d.View()
	// The reset counts: the hub tells a /clear by it, whatever the counts.
	if v.Resets == 0 {
		t.Fatal("/clear did not count as a reset")
	}
	// /clear forgot the turn, its ai-title and recap; /model (no arguments) is no prompt; /implement with arguments is.
	if v.AITitle != "" || v.Recap != "" || v.Prompt != "/implement Fix the elevator doors in the lobby. Then push." {
		t.Fatalf("after /clear: %+v", v)
	}
	want := []DigestStep{{Texts: []string{"Reading the elevator code."}, Tools: []DigestTool{{"Grep", "game/src"}}}}
	if v.Steps != 1 || v.Ended != 0 || !reflect.DeepEqual(v.Recent, want) {
		t.Fatalf("steps %d, ended %d: %+v", v.Steps, v.Ended, v.Recent)
	}
	if task, src := v.Task(); task != "/implement Fix the elevator doors in the lobby." || src != proto.DigestPrompt {
		t.Fatalf("task = %q (%s)", task, src)
	}
	// A /clear alone (the system line) starts over too.
	l := []byte(`{"type":"system","subtype":"local_command","content":"<local-command-stdout></local-command-stdout>","commandRun":{"command":"clear","args":""}}`)
	d.Line(200, l, TurnEvents(Claude, l))
	if w := d.View(); w.Steps != 0 || w.Prompt != "" || len(w.Recent) != 0 || w.Resets != v.Resets+1 {
		t.Fatalf("after the clear line: %+v", w)
	}
}

func TestDigestCodexTurns(t *testing.T) {
	d := NewDigestTracker(Codex)
	feedDigest(t, d, Codex, "digest_turns.jsonl")
	v := d.View()
	if v.Prompt != "Port the importer to v2? Keep v1 working.\nThanks." || v.AITitle != "" || v.Recap != "" {
		t.Fatalf("digest = %+v", v)
	}
	want := []DigestStep{
		{Tools: []DigestTool{{"exec_command", "rg importer"}}},
		{Texts: []string{"Ported; running the tests."}, Tools: []DigestTool{{"exec_command", "go test ./..."}}},
		{Texts: []string{"All green."}},
		{Tools: []DigestTool{{"exec_command", "gh pr create --fill"}}}, // a new prompt: its calls are a step of their own
		{Texts: []string{"PR opened."}},
	}
	if v.Steps != 5 || v.Ended != 2 || !reflect.DeepEqual(v.Recent, want) { // two task_complete
		t.Fatalf("steps %d, ended %d: %+v", v.Steps, v.Ended, v.Recent)
	}
	if task, src := v.Task(); task != "Port the importer to v2?" || src != proto.DigestPrompt {
		t.Fatalf("task = %q (%s)", task, src)
	}
}

func TestDigestRingKeepsTheLastSteps(t *testing.T) {
	d := NewDigestTracker(Codex)
	for i := range 8 {
		l := []byte(fmt.Sprintf(`{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"step %d"}]}}`, i))
		d.Line(int64(i), l, TurnEvents(Codex, l))
	}
	v := d.View()
	if v.Steps != 8 || len(v.Recent) != DigestSteps || v.Recent[0].Texts[0] != "step 3" || v.Recent[4].Texts[0] != "step 7" {
		t.Fatalf("steps %d: %+v", v.Steps, v.Recent)
	}
	// The view is a copy.
	v.Recent[0].Texts[0] = "changed"
	if d.View().Recent[0].Texts[0] != "step 3" {
		t.Fatal("the view shares the ring")
	}
	// A long text is clipped.
	long := strings.Repeat("a", 3*digestStepText)
	l := []byte(`{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"` + long + `"}]}}`)
	d.Line(9, l, TurnEvents(Codex, l))
	if got := d.View().Recent[4].Texts[0]; len(got) > digestStepText+len("…") {
		t.Fatalf("a step's text is %d bytes", len(got))
	}
}

func TestDigestPromptCleaning(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"Look at this: [Image #1: /tmp/a.png] and fix it.", "Look at this: [image] and fix it."},
		{"Fix this.\n\n<pasted_content id=\"ab12\">\npanic: boom\n</pasted_content id=\"ab12\">\n", "Fix this.\npanic: boom"},
		{"<bash-input>ls</bash-input>", ""},
	} {
		got, _ := promptText(tc.in)
		if got != tc.want {
			t.Errorf("promptText(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
	if got := firstSentence("   \n"+strings.Repeat("word ", 40), DigestTaskMax); len([]rune(got)) != DigestTaskMax || !strings.HasSuffix(got, "…") {
		t.Errorf("long first sentence = %q", got)
	}
	if NewDigestTracker("other") != nil {
		t.Error("a tracker for another harness")
	}
}
