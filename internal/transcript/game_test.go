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
	{"codex.json", Codex, []string{"session.jsonl", "tools.jsonl", "apply_patch.jsonl", "image.jsonl", "view_image.jsonl", "generated.jsonl", "aborted.jsonl", "compacted.jsonl", "unknown.jsonl"}},
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
