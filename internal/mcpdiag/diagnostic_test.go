package mcpdiag_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/mcpdiag"
)

func TestTerminalEvidenceIsNarrowAndBounded(t *testing.T) {
	for _, tc := range []struct{ screen, name, category string }{
		{"MCP client for `code-intel` timed out after 10 seconds", "code-intel", "timeout"},
		{"required MCP servers failed to initialize: slow:\n timed out handshaking with MCP server after 2s", "slow", "timeout"},
		{"MCP client for 'tools' failed to start: authentication failed https://user:PRIVATE@example.test", "tools", "auth"},
		{"random PRIVATE config and error", "", ""},
		{"MCP client for `https://user:PRIVATE@example.test` timed out", "", ""},
	} {
		rows := mcpdiag.Terminal(tc.screen)
		if tc.name == "" {
			if len(rows) != 0 {
				t.Fatalf("unrecognized screen: %+v", rows)
			}
			continue
		}
		if len(rows) != 1 || rows[0].Name != tc.name || rows[0].Category != tc.category {
			t.Fatalf("evidence %+v", rows)
		}
		b, _ := json.Marshal(rows)
		if strings.Contains(string(b), "PRIVATE") {
			t.Fatal("raw screen exposed")
		}
	}
	if got := mcpdiag.Terminal("MCP client for `old` timed out\n" + strings.Repeat("x", 33<<10)); len(got) != 0 {
		t.Fatal("unbounded screen parse")
	}
}
