package transcript

import (
	"strings"
	"testing"
)

func TestUnwrapPasted(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"no wrapper", "just typed", "just typed"},
		{"only a paste", "<pasted_content id=\"ed63\">\nMaybe Enter.\nAdd it.\n</pasted_content id=\"ed63\">\n", "Maybe Enter.\nAdd it."},
		{"typed text before, blank lines added", "on PR 1242: \n\n<pasted_content id=\"bc45\">\n╷\n│ Error\n</pasted_content id=\"bc45\">\n", "on PR 1242: ╷\n│ Error"},
		{"text on both sides", "see \n\n<pasted_content id=\"0a6d\">\nhttps://x/y\n</pasted_content id=\"0a6d\">\n\nand fix", "see https://x/y\nand fix"},
		{"two pastes", "<pasted_content id=\"aaaa\">\none one\n</pasted_content id=\"aaaa\">\n\n<pasted_content id=\"bbbb\">\ntwo two\n</pasted_content id=\"bbbb\">", "one one\ntwo two"},
		{"image marker kept", "[Image #1] \n\n<pasted_content id=\"993a\">\nFix it.\n\nNow.\n</pasted_content id=\"993a\">\n", "[Image #1] Fix it.\n\nNow."},
	}
	for _, c := range cases {
		if got := unwrapPasted(c.in); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
}

// A prompt the agent got as a paste is one user item with the text sent, in a message and as a queued prompt.
func TestClaudePastedPromptHasNoWrapper(t *testing.T) {
	const sent = "Maybe Enter should be behind a warning dialog.\nAdd it to the project board."
	wrapped := "<pasted_content id=\"ed63\">\n" + sent + "\n</pasted_content id=\"ed63\">\n"
	content := claudeUserLine(t, "u1", claudeText(wrapped)) +
		jl(t, m{"type": "attachment", "uuid": "q1", "timestamp": "2026-09-30T10:00:01.000Z", "attachment": m{
			"type": "queued_command", "commandMode": "prompt", "prompt": wrapped, "origin": m{"kind": "human"}}})
	items := all(t, openLog(t, Claude, content, newImages(t, 0), ""))
	if len(items) != 2 {
		t.Fatalf("%d items", len(items))
	}
	for i, it := range items {
		if len(it.Parts) != 1 || it.Parts[0].Text != sent {
			t.Errorf("item %d: %+v", i, it.Parts)
		}
		if strings.Contains(it.Parts[0].Text, "pasted_content") {
			t.Errorf("item %d keeps the wrapper", i)
		}
	}
}

// #95: ClaudePasted finds a person's prompt with pasted text, for the
// bridge's warning that a typed prompt arrived as a paste.
func TestClaudePasted(t *testing.T) {
	wrapped := `\n\n<pasted_content id=\"9fa6\">\n/run-crew https://x/1\nTeam: a\n</pasted_content id=\"9fa6\">\n`
	for name, c := range map[string]struct {
		line, want string
		ok         bool
	}{
		"user string": {`{"type":"user","message":{"role":"user","content":"` + wrapped + `"}}`, "/run-crew https://x/1\nTeam: a", true},
		"user blocks": {`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"see ` + wrapped + ` and fix it"}]}}`,
			"see /run-crew https://x/1\nTeam: a and fix it", true},
		"escaped": {`{"type":"user","message":{"content":"\u003cpasted_content id=\"ab\"\u003e\nhi there\n\u003c/pasted_content id=\"ab\"\u003e"}}`, "hi there", true},
		"queued": {`{"type":"attachment","attachment":{"type":"queued_command","commandMode":"prompt","prompt":"` + wrapped + `"}}`,
			"/run-crew https://x/1\nTeam: a", true},
		"typed":       {`{"type":"user","message":{"content":"/run-crew https://x/1"}}`, "", false},
		"meta":        {`{"type":"user","isMeta":true,"message":{"content":"` + wrapped + `"}}`, "", false},
		"sidechain":   {`{"type":"user","isSidechain":true,"message":{"content":"` + wrapped + `"}}`, "", false},
		"assistant":   {`{"type":"assistant","message":{"content":[{"type":"text","text":"` + wrapped + `"}]}}`, "", false},
		"tool result": {`{"type":"user","message":{"content":[{"type":"tool_result","content":"` + wrapped + `"}]}}`, "", false},
		"bad json":    {`{"type":"user", <pasted_content `, "", false},
	} {
		if got, ok := ClaudePasted([]byte(c.line)); ok != c.ok || got != c.want {
			t.Errorf("%s: %q, %v; want %q, %v", name, got, ok, c.want, c.ok)
		}
	}
}
