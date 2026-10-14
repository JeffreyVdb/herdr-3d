package main

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// The dry run prints numbers only, never transcript text, and sends nothing
// (no endpoint is configured).
func TestDryRunPrintsNumbersOnly(t *testing.T) {
	files := []string{"../../internal/handoffllm/testdata/claude_evidence.jsonl", "../../internal/handoffllm/testdata/codex_dedup.jsonl"}
	var out, errb bytes.Buffer
	if code := run(append([]string{"--json"}, files...), &out, &errb); code != 0 {
		t.Fatalf("%d %s", code, errb.String())
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("%q", out.String())
	}
	for i, l := range lines {
		var r Row
		if err := json.Unmarshal([]byte(l), &r); err != nil || r.Error != "" || r.Payload == 0 || r.EstTokens == 0 || r.PromptBytes <= r.Payload || r.Sent != nil {
			t.Fatalf("%s: %+v %v", l, r, err)
		}
		if want := []string{"claude", "codex"}[i]; r.Harness != want {
			t.Fatalf("harness %q", r.Harness)
		}
	}
	// No line of the transcripts' text is printed.
	src, _ := os.ReadFile(files[0])
	for _, l := range strings.Split(string(src), "\n") {
		var row struct {
			Message struct {
				Content any `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal([]byte(l), &row) == nil {
			if s, ok := row.Message.Content.(string); ok && len(s) > 12 && strings.Contains(out.String(), s) {
				t.Fatalf("printed transcript text %q", s)
			}
		}
	}
	out.Reset()
	if code := run(files, &out, &errb); code != 0 || !strings.Contains(out.String(), "claude_evidence.jsonl") {
		t.Fatalf("table: %d %s", code, out.String())
	}
	if code := run([]string{"--send", files[0]}, &out, &errb); code != 2 {
		t.Fatalf("--send without an endpoint ran: %d", code)
	}
}
