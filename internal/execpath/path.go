// Package execpath locates user-installed CLIs for bridge subprocesses.
package execpath

import (
	"os"
	"os/exec"
	"path/filepath"
)

// Resolve prefers PATH, then ~/.local/bin for a bare executable name. A user
// systemd manager often omits that directory, where native harnesses live.
// Explicit paths do not fall back to a different installation. Relative paths
// are resolved before the caller changes to a probe's private working directory.
// A missing executable is left unchanged so starting it reports the usual error.
func Resolve(bin string) string {
	if path, err := exec.LookPath(bin); err == nil {
		if abs, err := filepath.Abs(path); err == nil {
			return abs
		}
		return path
	}
	if filepath.Base(bin) == bin {
		if home, err := os.UserHomeDir(); err == nil {
			if path, err := exec.LookPath(filepath.Join(home, ".local", "bin", bin)); err == nil {
				return path
			}
		}
	}
	return bin
}
