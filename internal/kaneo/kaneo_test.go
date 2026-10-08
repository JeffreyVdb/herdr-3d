package kaneo

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The provider is a leaf: the standard library, provider and tracker only
// (the app wires it in; nothing of the board layer imports it).
func TestKaneoIsAProviderLeaf(t *testing.T) {
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("no go tool")
	}
	const mod = "github.com/JeffreyVdb/herdr-3d/"
	out, err := exec.Command("go", "list", "-deps", mod+"internal/kaneo").CombinedOutput()
	if err != nil {
		t.Fatalf("go list: %v\n%s", err, out)
	}
	for _, dep := range strings.Fields(string(out)) {
		if strings.HasPrefix(dep, mod) && dep != mod+"internal/kaneo" && dep != mod+"internal/provider" && dep != mod+"internal/tracker" {
			t.Errorf("internal/kaneo depends on %s", dep)
		}
		if !strings.HasPrefix(dep, mod) && strings.Contains(strings.SplitN(dep, "/", 2)[0], ".") {
			t.Errorf("internal/kaneo depends on %s, outside the standard library", dep)
		}
	}
}

// DELETE /task/<id> deletes a task for good: no code here can send one.
func TestNoDelete(t *testing.T) {
	files, _ := filepath.Glob("*.go")
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(b), "MethodDelete") || strings.Contains(string(b), `"DELETE"`) {
			t.Errorf("%s can send a DELETE", f)
		}
	}
}
