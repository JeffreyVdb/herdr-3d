package handoff_test

import (
	"os"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/handoff"
)

// #62: the hire task is the game's Hire from handoff's, word for word:
// game/src/world/handoff.ts builds it from the same template.
func TestHireTaskIsTheGames(t *testing.T) {
	if got := handoff.HireTask("/h/f/a.md"); got != "Read /h/f/a.md and continue the work. Invoke the skills it suggests." {
		t.Fatalf("HireTask = %q", got)
	}
	src, err := os.ReadFile("../../game/src/world/handoff.ts")
	if err != nil {
		t.Fatal(err)
	}
	if tmpl := "`" + handoff.HireTask("${path}") + "`"; !strings.Contains(string(src), tmpl) {
		t.Fatalf("game/src/world/handoff.ts has no %s", tmpl)
	}
	if got := handoff.GoneTask("/h/f/a.md"); got != "The handoff /h/f/a.md this task referenced was deleted; continue without it." {
		t.Fatalf("GoneTask = %q", got)
	}
}
