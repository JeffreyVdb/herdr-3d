package app

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

func TestModelDiscoveryFallback(t *testing.T) {
	var logs bytes.Buffer
	log := slog.New(slog.NewTextHandler(&logs, nil))
	missing := filepath.Join(t.TempDir(), "missing")
	got := discoverHireOptions(context.Background(), log, missing, missing)
	if !reflect.DeepEqual(got, server.HireOptions()) || strings.Count(logs.String(), "using fallback catalog") != 2 {
		t.Fatalf("fallback = %+v; logs = %s", got, &logs)
	}
}

func TestModelDiscoveryPartialSuccess(t *testing.T) {
	// A tiny fake Codex returns a future catalog. Claude is unavailable, so
	// only its catalog should use the fallback. The game must not be offered
	// obsolete Codex entries from the fallback alongside the discovered one.
	bin := filepath.Join(t.TempDir(), "codex")
	script := `#!/bin/sh
read -r init
printf '%s\n' '{"id":1,"result":{}}'
read -r initialized
read -r list
printf '%s\n' '{"id":2,"result":{"data":[{"model":"gpt-future","supportedReasoningEfforts":[{"reasoningEffort":"high"}]}],"nextCursor":null}}'
while read -r request; do :; done
`
	if err := os.WriteFile(bin, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	got := discoverHireOptions(context.Background(), slog.New(slog.NewTextHandler(&logs, nil)), bin, bin+"-missing")
	if !reflect.DeepEqual(got.Claude, server.HireOptions().Claude) || !reflect.DeepEqual(got.Codex.Models, []string{"gpt-future"}) ||
		!reflect.DeepEqual(got.Codex.Efforts, []string{"high"}) || strings.Count(logs.String(), "using fallback catalog") != 1 {
		t.Fatalf("partial discovery = %+v; logs = %s", got, &logs)
	}
}
