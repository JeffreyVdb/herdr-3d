package server_test

import (
	"os/exec"
	"strings"
	"testing"
)

// The poller, the cache, the commands and the audit sit above the neutral
// interfaces: nothing they import may lead to the GitHub packages, so
// another provider (files in the repository, Monday.com) can be dropped in
// through server.Options.Boards. Only the app wires GitHub in.
func TestBoardLayerIsProviderNeutral(t *testing.T) {
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("no go tool")
	}
	const mod = "github.com/JeffreyVdb/herdr-3d/internal/"
	deps := func(pkg string) []string {
		out, err := exec.Command("go", "list", "-deps", mod+pkg).CombinedOutput()
		if err != nil {
			t.Fatalf("go list -deps %s: %v\n%s", pkg, err, out)
		}
		return strings.Fields(string(out))
	}
	for _, pkg := range []string{"server", "store", "proto", "tracker", "codehost", "provider"} {
		for _, dep := range deps(pkg) {
			if dep == mod+"github" || dep == mod+"githubcli" {
				t.Errorf("internal/%s depends on %s", pkg, dep)
			}
		}
	}
	found := false
	for _, dep := range deps("app") {
		found = found || dep == mod+"github"
	}
	if !found {
		t.Error("internal/app does not wire the GitHub provider in")
	}
	// The neutral packages do not know each other's provider either.
	for _, pkg := range []string{"tracker", "codehost"} {
		for _, dep := range deps(pkg) {
			if dep == mod+"server" || dep == mod+"store" || dep == mod+"proto" {
				t.Errorf("internal/%s depends on %s", pkg, dep)
			}
		}
	}
}
