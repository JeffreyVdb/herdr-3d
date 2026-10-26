//go:build integration

package server

import (
	"os/exec"
	"path/filepath"
	"testing"
)

// Until the process core is merged this tests the real helper subcommand,
// private broker, WebSocket and fake sudo against the in-memory process seam.
func TestManualAskpassIntegration(t *testing.T) {
	r := newManualRig(t)
	r.bridgeExe = filepath.Join(r.root, "herdr-world")
	cmd := exec.Command("go", "build", "-o", r.bridgeExe, "../../cmd/herdr-world")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build helper: %v: %s", err, out)
	}
	runManualAskpassScenarios(t, r)
}
