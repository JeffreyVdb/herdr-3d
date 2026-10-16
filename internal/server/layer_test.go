package server_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
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
	t.Parallel()
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
			if dep == mod+"github" || dep == mod+"githubcli" || dep == mod+"kaneo" {
				t.Errorf("internal/%s depends on %s", pkg, dep)
			}
		}
	}
	found, kaneo := false, false
	for _, dep := range deps("app") {
		found = found || dep == mod+"github"
		kaneo = kaneo || dep == mod+"kaneo"
		if strings.HasSuffix(dep, "test") && strings.HasPrefix(dep, mod) {
			t.Errorf("internal/app depends on the test fake %s", dep)
		}
	}
	if !found {
		t.Error("internal/app does not wire the GitHub provider in")
	}
	if !kaneo {
		t.Error("internal/app does not wire the Kaneo provider in") // #184
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

// #184: the Kaneo settings (internal/kaneoconf) reach Kaneo only through
// their Connector interface: they import nothing of the module but the
// provider error kinds, so the hub, the protocol and the store that carry
// them stay away from the Kaneo client (internal/kaneo), which only the app
// wires in.
func TestKaneoSettingsIsProviderNeutral(t *testing.T) {
	t.Parallel()
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("no go tool")
	}
	const mod = "github.com/JeffreyVdb/herdr-3d/internal/"
	out, err := exec.Command("go", "list", "-deps", mod+"kaneoconf").CombinedOutput()
	if err != nil {
		t.Fatalf("go list -deps: %v\n%s", err, out)
	}
	for _, dep := range strings.Fields(string(out)) {
		if strings.HasPrefix(dep, mod) && dep != mod+"kaneoconf" && dep != mod+"provider" {
			t.Errorf("internal/kaneoconf depends on %s", dep)
		}
	}
}

// #11: the notifications' core (internal/notify: the inbox rule, the
// episodes, the settings, the queue) is provider neutral: it imports nothing
// of the module and no net/http, and reaches a provider only through its
// Channel. The Telegram Bot API (internal/notify/telegram) is the app's to
// wire in: the hub, the store and the protocol never import it.
func TestNotifyCoreIsProviderNeutral(t *testing.T) {
	t.Parallel()
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
	for _, dep := range deps("notify") {
		if dep == "net/http" || dep == "net" || (strings.HasPrefix(dep, mod) && dep != mod+"notify") {
			t.Errorf("internal/notify depends on %s", dep)
		}
	}
	for _, pkg := range []string{"server", "store", "proto"} {
		for _, dep := range deps(pkg) {
			if dep == mod+"notify/telegram" {
				t.Errorf("internal/%s depends on %s", pkg, dep)
			}
		}
	}
	wired := false
	for _, dep := range deps("app") {
		wired = wired || dep == mod+"notify/telegram"
	}
	if !wired {
		t.Error("internal/app does not wire the Telegram channel in")
	}
}

// #92: internal/ai is generic. It reaches no feature and no part of the
// bridge: only the standard library. The server, the protocol and the app
// carry its settings and its state; the features of later tickets take its
// two interfaces.
func TestAIIsFeatureAgnostic(t *testing.T) {
	t.Parallel()
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
	t.Parallel()
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

// #110: pack up on request takes only internal/ai's interfaces: it imports
// no vendor client and nothing of the bridge (only internal/ai from this
// module, no net/http), and never names the service or a provider. The hub
// hands it the models.
func TestPackupUsesOnlyAIInterfaces(t *testing.T) {
	t.Parallel()
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("no go tool")
	}
	const mod = "github.com/JeffreyVdb/herdr-3d/"
	out, err := exec.Command("go", "list", "-deps", mod+"internal/packup").CombinedOutput()
	if err != nil {
		t.Fatalf("go list -deps: %v\n%s", err, out)
	}
	for _, dep := range strings.Fields(string(out)) {
		if strings.HasPrefix(dep, mod) && dep != mod+"internal/packup" && dep != mod+"internal/ai" {
			t.Errorf("internal/packup depends on %s", dep)
		}
	}
	out, err = exec.Command("go", "list", "-f", `{{join .Imports " "}}`, mod+"internal/packup").CombinedOutput()
	if err != nil {
		t.Fatalf("go list -f: %v\n%s", err, out)
	}
	for _, imp := range strings.Fields(string(out)) {
		if strings.HasPrefix(imp, "net") {
			t.Errorf("internal/packup imports %s", imp)
		}
	}
	files, _ := filepath.Glob("../packup/*.go")
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

// #211: dictated hiring takes only internal/ai's LLM interface: it imports
// no vendor client and nothing of the bridge (only internal/ai from this
// module, no net/http; not proto: the server hands it the catalog), and
// never names the service or a provider.
func TestHireIntentUsesOnlyAIInterfaces(t *testing.T) {
	t.Parallel()
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("no go tool")
	}
	const mod = "github.com/JeffreyVdb/herdr-3d/"
	out, err := exec.Command("go", "list", "-deps", mod+"internal/hireintent").CombinedOutput()
	if err != nil {
		t.Fatalf("go list -deps: %v\n%s", err, out)
	}
	for _, dep := range strings.Fields(string(out)) {
		if strings.HasPrefix(dep, mod) && dep != mod+"internal/hireintent" && dep != mod+"internal/ai" {
			t.Errorf("internal/hireintent depends on %s", dep)
		}
	}
	out, err = exec.Command("go", "list", "-f", `{{join .Imports " "}}`, mod+"internal/hireintent").CombinedOutput()
	if err != nil {
		t.Fatalf("go list -f: %v\n%s", err, out)
	}
	for _, imp := range strings.Fields(string(out)) {
		if strings.HasPrefix(imp, "net") {
			t.Errorf("internal/hireintent imports %s", imp)
		}
	}
	files, _ := filepath.Glob("../hireintent/*.go")
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

// #118 phase 2: the floor overview summaries take only internal/ai's
// interfaces: no vendor client, nothing of the bridge (only internal/ai from
// this module, no net/http, not internal/transcript nor internal/activity),
// never the service or a provider. The hub hands it the LLM and the input.
func TestDigestUsesOnlyAIInterfaces(t *testing.T) {
	t.Parallel()
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("no go tool")
	}
	const mod = "github.com/JeffreyVdb/herdr-3d/"
	out, err := exec.Command("go", "list", "-deps", mod+"internal/digest").CombinedOutput()
	if err != nil {
		t.Fatalf("go list -deps: %v\n%s", err, out)
	}
	for _, dep := range strings.Fields(string(out)) {
		if strings.HasPrefix(dep, mod) && dep != mod+"internal/digest" && dep != mod+"internal/ai" {
			t.Errorf("internal/digest depends on %s", dep)
		}
	}
	out, err = exec.Command("go", "list", "-f", `{{join .Imports " "}}`, mod+"internal/digest").CombinedOutput()
	if err != nil {
		t.Fatalf("go list -f: %v\n%s", err, out)
	}
	for _, imp := range strings.Fields(string(out)) {
		if strings.HasPrefix(imp, "net") {
			t.Errorf("internal/digest imports %s", imp)
		}
	}
	files, _ := filepath.Glob("../digest/*.go")
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

// #9: the LLM handoffs' feature half (internal/handoffllm's generate*,
// prompt* and validate* files) takes only internal/ai's interfaces: no vendor
// client, no net, nothing else of the bridge (the reducer half has its own
// rule, TestReducerIsALeaf), never the service or a provider.
func TestHandoffLLMUsesOnlyAIInterfaces(t *testing.T) {
	t.Parallel()
	const mod = "github.com/JeffreyVdb/herdr-3d/"
	files, _ := filepath.Glob("../handoffllm/*.go")
	fset := token.NewFileSet()
	checked := 0
	for _, f := range files {
		base := filepath.Base(f)
		if strings.HasSuffix(f, "_test.go") || !(strings.HasPrefix(base, "generate") || strings.HasPrefix(base, "prompt") || strings.HasPrefix(base, "validate")) {
			continue
		}
		checked++
		file, err := parser.ParseFile(fset, f, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, im := range file.Imports {
			p := strings.Trim(im.Path.Value, `"`)
			if (strings.HasPrefix(p, mod) && p != mod+"internal/ai") || strings.HasPrefix(p, "net") {
				t.Errorf("%s imports %s", base, p)
			}
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
	if checked < 3 {
		t.Fatalf("checked %d files: the feature's files moved?", checked)
	}
}

// #98: the activity's rules and its model service take only internal/ai's
// interfaces: no vendor client, nothing of the bridge (only internal/ai from
// this module, no net/http), never the service or a provider. The hub hands
// it the classifier.
func TestActivityUsesOnlyAIInterfaces(t *testing.T) {
	t.Parallel()
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("no go tool")
	}
	const mod = "github.com/JeffreyVdb/herdr-3d/"
	out, err := exec.Command("go", "list", "-deps", mod+"internal/activity").CombinedOutput()
	if err != nil {
		t.Fatalf("go list -deps: %v\n%s", err, out)
	}
	for _, dep := range strings.Fields(string(out)) {
		if strings.HasPrefix(dep, mod) && dep != mod+"internal/activity" && dep != mod+"internal/ai" {
			t.Errorf("internal/activity depends on %s", dep)
		}
	}
	out, err = exec.Command("go", "list", "-f", `{{join .Imports " "}}`, mod+"internal/activity").CombinedOutput()
	if err != nil {
		t.Fatalf("go list -f: %v\n%s", err, out)
	}
	for _, imp := range strings.Fields(string(out)) {
		if strings.HasPrefix(imp, "net") || strings.HasPrefix(imp, "os") {
			t.Errorf("internal/activity imports %s", imp)
		}
	}
	files, _ := filepath.Glob("../activity/*.go")
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

// #136: worker.commands is provider-neutral: the server, the store and the
// protocol reach no harness probe; only the app wires internal/harness in
// through server.Options.Commands.
func TestCommandCatalogIsProviderNeutral(t *testing.T) {
	t.Parallel()
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
	for _, pkg := range []string{"server", "store", "proto"} {
		for _, dep := range deps(pkg) {
			if dep == mod+"harness" {
				t.Errorf("internal/%s depends on %s", pkg, dep)
			}
		}
	}
	found := false
	for _, dep := range deps("app") {
		found = found || dep == mod+"harness"
	}
	if !found {
		t.Error("internal/app does not wire internal/harness in")
	}
}

// #137: worker.files: the server, the store and the protocol reach neither
// the file index nor its scorer; only the app wires internal/fileindex in
// through server.Options.Files.
func TestFileIndexIsWiredByTheApp(t *testing.T) {
	t.Parallel()
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
	for _, pkg := range []string{"server", "store", "proto"} {
		for _, dep := range deps(pkg) {
			if dep == mod+"fileindex" || dep == mod+"fuzzy" {
				t.Errorf("internal/%s depends on %s", pkg, dep)
			}
		}
	}
	found := false
	for _, dep := range deps("app") {
		found = found || dep == mod+"fileindex"
	}
	if !found {
		t.Error("internal/app does not wire internal/fileindex in")
	}
}

// #138: a prompt is rewritten for its harness by internal/harness's rules
// table, wired in by the app through server.Options.Prompts: the server,
// the store and the protocol reach no harness package, and the prompt path
// holds no harness name of its own (translate.go and ask.go; input.go has
// only the #95 typing rule).
func TestPromptRulesAreInTheHarnessTable(t *testing.T) {
	t.Parallel()
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
	for _, pkg := range []string{"server", "store", "proto"} {
		for _, dep := range deps(pkg) {
			if dep == mod+"harness" {
				t.Errorf("internal/%s depends on %s", pkg, dep)
			}
		}
	}
	for _, file := range []string{"translate.go", "ask.go"} {
		src, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		for _, name := range []string{`"codex"`, `"claude"`} {
			if strings.Contains(string(src), name) {
				t.Errorf("%s names the harness %s: the rules belong in internal/harness's table", file, name)
			}
		}
	}
}
