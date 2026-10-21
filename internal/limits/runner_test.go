package limits

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// A systemd user service can have a PATH without the native CLI install
// directory, even though both harnesses are installed for that user.
func TestPollerFindsUserLocalCLIs(t *testing.T) {
	home := t.TempDir()
	bin := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("PATH", t.TempDir())
	scripts := map[string]string{
		"claude": fmt.Sprintf("#!/bin/sh\nread -r request\nprintf '%%s\\n' '%s'\n", fixture(t, "claude_team.jsonl")),
		"codex":  fmt.Sprintf("#!/bin/sh\nread -r request\nprintf '%%s\\n' '{\"id\":1,\"result\":{}}'\nread -r request\nread -r request\nprintf '%%s\\n' '{\"id\":2,\"result\":%s}'\n", fixture(t, "codex_primary.json")),
	}
	for name, script := range scripts {
		if err := os.WriteFile(filepath.Join(bin, name), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	p := New(Config{Now: func() time.Time { return t0 }, Timeout: time.Second, Grace: time.Second})
	for _, name := range providers {
		t.Run(name, func(t *testing.T) {
			l := p.read(context.Background(), target{provider: name}, t0)
			if l.Error != "" || l.Stale || l.Source != proto.LimitsProbe || len(l.Windows) == 0 {
				t.Fatalf("installed CLI reported unavailable: %+v", l)
			}
		})
	}
}
