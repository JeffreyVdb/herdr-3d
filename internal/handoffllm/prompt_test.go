package handoffllm_test

import (
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/handoffllm"
)

func TestBuildDelimitsTheDataWithAFreshNonce(t *testing.T) {
	p := handoffllm.SamplePayload()
	f := handoffllm.SampleFacts(time.Unix(1_800_000_000, 0))
	a, err := handoffllm.Build(f, p, "focus on the CI failure")
	if err != nil {
		t.Fatal(err)
	}
	b, err := handoffllm.Build(f, p, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(a.Messages) != 2 || a.Messages[0].Role != "system" || a.Messages[0].Content != handoffllm.SystemPrompt {
		t.Fatalf("%+v", a.Messages)
	}
	u := a.Messages[1].Content
	nonce := between(u, "<<<TRANSCRIPT-", "\n")
	if len(nonce) < 16 || strings.Contains(b.Messages[1].Content, nonce) {
		t.Fatalf("nonce %q is not per request", nonce)
	}
	for _, blk := range []string{"BRIDGE-FACTS", "TRANSCRIPT", "INSTRUCTION"} {
		if !strings.Contains(u, "<<<"+blk+"-"+nonce+"\n") || !strings.Contains(u, "\n"+blk+"-"+nonce+">>>") {
			t.Fatalf("block %s is not delimited:\n%s", blk, u)
		}
	}
	if got := between(u, "<<<TRANSCRIPT-"+nonce+"\n", "\nTRANSCRIPT-"+nonce+">>>"); got != strings.TrimRight(p.Text, "\n") {
		t.Fatalf("the transcript block is not the payload: %q", got)
	}
	if got := between(u, "<<<INSTRUCTION-"+nonce+"\n", "\nINSTRUCTION-"+nonce+">>>"); got != "focus on the CI failure" || a.FocusBytes != len(got) {
		t.Fatalf("%q", got)
	}
	if strings.Contains(b.Messages[1].Content, "<<<INSTRUCTION") {
		t.Fatal("an empty instruction got a block")
	}
	if a.Bytes != len(a.Messages[0].Content)+len(u) {
		t.Fatal("Bytes is not what is sent")
	}
}

func TestTheFactsSayWhatIsCurrentAndWhatIsUnknown(t *testing.T) {
	f := handoffllm.SampleFacts(time.Unix(1_800_000_000, 0))
	p := handoffllm.SamplePayload()
	p.Coverage = handoffllm.Coverage{Messages: 40, Kept: 12, Compaction: "opaque", Gaps: []string{"pre-compaction assistant replies unavailable (Codex)"},
		Omitted: []handoffllm.Range{{From: 3, To: 20, Why: "older assistant detail"}}}
	p.Artifacts = []handoffllm.Artifact{{Kind: "commit", Ref: "0123456789abcdef0123456789abcdef01234567", Verified: true}, {Kind: "file", Ref: "a.go"}}
	pr, err := handoffllm.Build(f, p, "")
	if err != nil {
		t.Fatal(err)
	}
	u := pr.Messages[1].Content
	for _, want := range []string{
		"Git, captured now: branch: fix/flaky-login",
		"M e2e/auth.spec.ts",
		"Branch as herdr reported it: fix/flaky-login",
		"commit 0123456789abcdef0123456789abcdef01234567 (verified)",
		"file a.go (intent)",
		"12 of 40 messages kept",
		"left out: messages 3–20 (older assistant detail)",
		"gap: pre-compaction assistant replies unavailable (Codex)",
		"Compaction: opaque",
		"completed turn 0000000000000000",
	} {
		if !strings.Contains(u, want) {
			t.Fatalf("missing %q in\n%s", want, u)
		}
	}
	f.GitKnown, f.Skills = false, []string{"handoff", "tdd"}
	pr, _ = handoffllm.Build(f, p, "")
	u = pr.Messages[1].Content
	if !strings.Contains(u, "Git, captured now: unknown") || !strings.Contains(u, "Skills available to the worker's agent: handoff, tdd") {
		t.Fatal(u)
	}
}

func TestTheSystemPromptNamesEverySection(t *testing.T) {
	for _, s := range handoffllm.Sections {
		if !strings.Contains(handoffllm.SystemPrompt, `"## `+s+`"`) {
			t.Fatalf("%q", s)
		}
	}
	if handoffllm.PromptVersion == "" {
		t.Fatal("no prompt version")
	}
}

func between(s, a, b string) string {
	i := strings.Index(s, a)
	if i < 0 {
		return ""
	}
	s = s[i+len(a):]
	j := strings.Index(s, b)
	if j < 0 {
		return ""
	}
	return s[:j]
}
