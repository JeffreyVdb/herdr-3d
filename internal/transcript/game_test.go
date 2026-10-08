package transcript

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// gameFixtures are the timelines the game's tests render
// (game/fixtures/transcript): what the bridge makes of this package's
// fixtures, so the two sides are tested against the same wire items.
// H3D_UPDATE_FIXTURES=1 writes them.
var gameFixtures = []struct {
	name, harness string
	files         []string
}{
	{"claude.json", Claude, []string{"message.jsonl", "bash.jsonl", "bash_error.jsonl", "edit.jsonl", "write.jsonl", "read_image.jsonl",
		"user.jsonl", "user_marker.jsonl", "agent.jsonl", "interrupted.jsonl", "system.jsonl", "compact.jsonl", "attachment.jsonl", "unknown.jsonl"}},
	{"claude-subagent.json", Claude, []string{"subagent.jsonl"}},
	// #171: what Edit, Write and Bash changed, every shape and state (bash_diff_skipped and write_update_nodiff are
	// synthetic: documented, never seen in a real transcript).
	{"claude-changes.json", Claude, []string{"edit.jsonl", "write.jsonl", "write_update.jsonl", "write_update_nodiff.jsonl",
		"bash_diff.jsonl", "bash_diff_multi.jsonl", "bash_diff_more.jsonl", "bash_diff_unavailable.jsonl", "bash_diff_shared.jsonl",
		"bash_diff_skipped.jsonl", "change_failed.jsonl", "bash.jsonl"}},
	// #57: question cards, answered every way and one pending.
	{"claude-ask.json", Claude, []string{"ask.jsonl", "ask_pending.jsonl"}},
	{"codex-ask.json", Codex, []string{"ask.jsonl", "ask_pending.jsonl"}},
	{"codex.json", Codex, []string{"session.jsonl", "tools.jsonl", "apply_patch.jsonl", "image.jsonl", "view_image.jsonl", "generated.jsonl", "aborted.jsonl", "compacted.jsonl", "unknown.jsonl"}},
	// #151: MCP calls that are events only, a failed one and the deduped ones.
	{"codex-mcp.json", Codex, []string{"mcp_exec.jsonl", "mcp_failed.jsonl", "mcp_dup.jsonl"}},
}

func TestGameFixtures(t *testing.T) {
	dir := filepath.Join("..", "..", "game", "fixtures", "transcript")
	update := os.Getenv("H3D_UPDATE_FIXTURES") == "1"
	for _, f := range gameFixtures {
		b, err := json.MarshalIndent(items(t, f.harness, f.files...), "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		b = append(b, '\n')
		path := filepath.Join(dir, f.name)
		if update {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, b, 0o644); err != nil {
				t.Fatal(err)
			}
			continue
		}
		old, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("%v (H3D_UPDATE_FIXTURES=1 go test ./internal/transcript writes it)", err)
		}
		if !bytes.Equal(old, b) {
			t.Errorf("%s is not what the bridge sends now: H3D_UPDATE_FIXTURES=1 go test ./internal/transcript, then check the game's tests", path)
		}
	}
}
