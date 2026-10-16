package hoststats

import (
	"os/exec"
	"strings"
	"testing"
)

// hoststats is read by server (hire capacity and the rack) and by nothing it
// may lead back to: its only module import is execpath (TestHostStatsIsALeaf).
func TestHostStatsIsALeaf(t *testing.T) {
	t.Parallel()
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("no go tool")
	}
	const mod = "github.com/JeffreyVdb/herdr-3d/"
	out, err := exec.Command("go", "list", "-deps", ".").CombinedOutput()
	if err != nil {
		t.Fatalf("go list -deps: %v\n%s", err, out)
	}
	for _, dep := range strings.Fields(string(out)) {
		if strings.HasPrefix(dep, mod) && dep != mod+"internal/hoststats" && dep != mod+"internal/execpath" {
			t.Errorf("internal/hoststats depends on %s", dep)
		}
	}
}
