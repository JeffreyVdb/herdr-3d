package server_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os/exec"
	"path/filepath"
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

// #92: internal/ai is generic. It reaches no feature and no part of the
// bridge: only the standard library. The server, the protocol and the app
// carry its settings and its state; the features of later tickets take its
// two interfaces.
func TestAIIsFeatureAgnostic(t *testing.T) {
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("no go tool")
	}
	const mod = "github.com/JeffreyVdb/herdr-3d/"
	out, err := exec.Command("go", "list", "-deps", mod+"internal/ai").CombinedOutput()
	if err != nil {
		t.Fatalf("go list -deps: %v\n%s", err, out)
	}
	for _, dep := range strings.Fields(string(out)) {
		if strings.HasPrefix(dep, mod) && dep != mod+"internal/ai" {
			t.Errorf("internal/ai depends on %s", dep)
		}
	}
}

// #90: the follow-up feature takes only internal/ai's interfaces: it imports
// no vendor client and nothing of the bridge (only internal/ai from this
// module, no net/http), and never names the service or a provider. The hub
// hands it the models.
func TestFollowupUsesOnlyAIInterfaces(t *testing.T) {
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("no go tool")
	}
	const mod = "github.com/JeffreyVdb/herdr-3d/"
	out, err := exec.Command("go", "list", "-deps", mod+"internal/followup").CombinedOutput()
	if err != nil {
		t.Fatalf("go list -deps: %v\n%s", err, out)
	}
	for _, dep := range strings.Fields(string(out)) {
		if strings.HasPrefix(dep, mod) && dep != mod+"internal/followup" && dep != mod+"internal/ai" {
			t.Errorf("internal/followup depends on %s", dep)
		}
	}
	out, err = exec.Command("go", "list", "-f", `{{join .Imports " "}}`, mod+"internal/followup").CombinedOutput()
	if err != nil {
		t.Fatalf("go list -f: %v\n%s", err, out)
	}
	for _, imp := range strings.Fields(string(out)) {
		if strings.HasPrefix(imp, "net") {
			t.Errorf("internal/followup imports %s", imp)
		}
	}
	files, _ := filepath.Glob("../followup/*.go")
	fset := token.NewFileSet()
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, f, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(file, func(n ast.Node) bool {
			if sel, ok := n.(*ast.SelectorExpr); ok {
				if x, ok := sel.X.(*ast.Ident); ok && x.Name == "ai" {
					switch sel.Sel.Name {
					case "Service", "New", "Options", "Overrides", "Fields":
						t.Errorf("%s uses ai.%s: only the interfaces", fset.Position(sel.Pos()), sel.Sel.Name)
					}
				}
			}
			return true
		})
	}
}
