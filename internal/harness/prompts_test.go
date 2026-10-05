package harness

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

func promptsFor(t *testing.T, probe Probe) *Prompts {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	c := NewCatalog(ctx, nil, map[string]Probe{"codex": probe, "claude": probe}, map[string][]proto.CommandEntry{"codex": CodexBuiltins()})
	t.Cleanup(func() {
		cancel()
		c.Wait()
	})
	return NewPrompts(c)
}

func TestPromptsTranslate(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.go"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	var probes int
	p := promptsFor(t, func(context.Context, string) ([]proto.CommandEntry, error) {
		probes++
		return []proto.CommandEntry{{Name: "grill", Kind: proto.CommandKindSkill}}, nil
	})
	ctx := context.Background()
	for _, tc := range []struct{ harness, in, want string }{
		{"codex", "/grill @a.go /compact @nope", "$grill a.go /compact @nope"},
		{"claude", "/grill @a.go", "/grill @a.go"},
		{"codex", "no tokens", "no tokens"},
		{"zed", "/grill", "/grill"},
	} {
		got, err := p.Translate(ctx, tc.harness, dir, tc.in)
		if err != nil || got != tc.want {
			t.Errorf("Translate(%q, %q) = %q, %v; want %q", tc.harness, tc.in, got, err, tc.want)
		}
	}
	// Claude and plain text did not ask the catalog.
	if probes != 1 {
		t.Errorf("%d probes, want 1 (codex, the first text with a /)", probes)
	}
	// A text with only a file asks no catalog either.
	before := probes
	if got, _ := p.Translate(ctx, "codex", dir, "@a.go"); got != "a.go" || probes != before {
		t.Errorf("file only: %q, probes %d -> %d", got, before, probes)
	}
}

// A catalog that cannot answer in time fails the translation open.
func TestPromptsTranslateFailsOpen(t *testing.T) {
	p := promptsFor(t, func(ctx context.Context, _ string) ([]proto.CommandEntry, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	})
	p.wait = 20 * time.Millisecond
	got, err := p.Translate(context.Background(), "codex", t.TempDir(), "/grill @a.go")
	if err == nil || got != "/grill @a.go" {
		t.Errorf("got %q, %v; want the text back and an error", got, err)
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("err = %v", err)
	}
}
