//go:build integration

package limits

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codex"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/usage"
)

// TestIntegrationProbesCreateNoSession runs the real claude and codex probes
// ten times, as the signed-in user, and looks for anything they left of a
// session: a Claude project named after the probe's temp directory (Claude
// names a project after the cwd), or a Codex rollout recorded in it. Other
// agents write their own files at the same time, so it looks for the
// probes' cwd, not for "any new file". Skipped without the CLIs.
func TestIntegrationProbesCreateNoSession(t *testing.T) {
	c := Config{}
	c.defaults()
	c.CodexSessions = codex.DefaultSessionsDir()
	projects := usage.DefaultClaudeProjects()
	if _, err := os.Stat(projects); err != nil {
		t.Skipf("no Claude projects directory: %v", err)
	}
	ctx := context.Background()
	var claudeOK, codexOK int
	for range 10 {
		if l, err := c.probeClaude(ctx); err == nil {
			claudeOK++
			t.Logf("claude %s: %+v", l.Plan, l.Windows)
		} else {
			t.Logf("claude probe: %v", err)
		}
		if l, err := c.probeCodex(ctx, nil); err == nil {
			codexOK++
			t.Logf("codex %s: %+v", l.Plan, l.Windows)
		} else {
			t.Logf("codex probe: %v", err)
		}
	}
	if claudeOK == 0 && codexOK == 0 {
		t.Skip("neither CLI answered")
	}
	// The probes' cwd is os.TempDir()/h3d-limits-<n>: Claude's project name for it is that path with / and . as -.
	marker := "h3d-limits-"
	entries, _ := os.ReadDir(projects)
	for _, e := range entries {
		if strings.Contains(e.Name(), marker) {
			t.Errorf("a Claude project was created for a probe: %s", filepath.Join(projects, e.Name()))
		}
	}
	for _, path := range codex.NewestRollouts(c.CodexSessions, 200) {
		b, err := readHead(path)
		if err == nil && strings.Contains(b, marker) {
			t.Errorf("a Codex rollout was recorded for a probe: %s", path)
		}
	}
	t.Logf("%d claude and %d codex probes answered", claudeOK, codexOK)
}

func readHead(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	buf := make([]byte, 64<<10)
	n, err := io.ReadFull(f, buf)
	if n == 0 {
		return "", err
	}
	return string(buf[:n]), nil
}

// TestIntegrationCodexTranscript reads the newest real rollouts.
func TestIntegrationCodexTranscript(t *testing.T) {
	l, ok := fromTranscript(codex.DefaultSessionsDir())
	if !ok {
		t.Skip("no rate_limits in the newest Codex rollouts")
	}
	if l.Source != proto.LimitsTranscript || !l.Stale || len(l.Windows) == 0 || time.Since(time.UnixMilli(l.At)) < 0 {
		t.Fatalf("got %+v", l)
	}
	t.Logf("as of %s: %+v", time.UnixMilli(l.At), l.Windows)
}
