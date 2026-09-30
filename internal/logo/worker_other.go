//go:build !unix

package logo

import (
	"os"
	"os/exec"
)

// No rlimits or process groups here; the parent's deadline still kills the
// child.
func limitSelf(int) {}

func killable(cmd *exec.Cmd) {}

func workerExecutable() (string, error) { return os.Executable() }
