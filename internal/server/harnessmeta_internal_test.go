package server

import (
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

func TestRememberedHarnessRecovery(t *testing.T) {
	for _, tc := range []struct {
		stored, observed, kind, want string
	}{
		{"claude-code", "", "", "claude"},
		{"unsupported", "", "claude", "claude"},
		{"claude-code", "", "claude", "claude"},
		{"claude", "codex", "claude", "codex"},
		{"codex", "", "", "codex"},
	} {
		got := nextMeta(workerMeta{harness: tc.stored}, world.WorkerObs{Harness: tc.observed, AgentKind: tc.kind}, 1)
		if got.harness != tc.want {
			t.Errorf("stored %q observed %q kind %q: got %q, want %q", tc.stored, tc.observed, tc.kind, got.harness, tc.want)
		}
	}
}
