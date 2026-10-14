package handoffllm

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// TestReducerIsALeaf: the reducer half of the package (reduce*.go,
// scrub*.go, budget*.go, doc.go) reads transcripts and nothing else: the
// standard library, internal/jsonl and internal/transcript only. No AI
// client, server, store or protocol: the wiring half (prompt, generate,
// validate) is the one that talks to ai.LLM. Checked per file, since both
// halves share the package.
func TestReducerIsALeaf(t *testing.T) {
	const module = "github.com/JeffreyVdb/herdr-3d/"
	allowed := map[string]bool{module + "internal/jsonl": true, module + "internal/transcript": true}
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	checked := 0
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") || !(strings.HasPrefix(f, "reduce") || strings.HasPrefix(f, "scrub") ||
			strings.HasPrefix(f, "budget") || f == "doc.go") {
			continue
		}
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		af, err := parser.ParseFile(token.NewFileSet(), f, src, parser.ImportsOnly)
		if err != nil {
			t.Fatal(err)
		}
		checked++
		for _, im := range af.Imports {
			p, _ := strconv.Unquote(im.Path.Value)
			std := !strings.Contains(strings.SplitN(p, "/", 2)[0], ".")
			if !std && !allowed[p] {
				t.Errorf("%s imports %s: the reducer may import only the standard library, internal/jsonl and internal/transcript", f, p)
			}
		}
	}
	if checked < 4 {
		t.Fatalf("checked %d files: the reducer's files moved?", checked)
	}
}
