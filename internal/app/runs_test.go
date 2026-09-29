package app

import "testing"

// M6 runs
func TestDefaultRunsDir(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", "/home/u/.state")
	if got := DefaultRunsDir(); got != "/home/u/.state/write-code/runs" {
		t.Errorf("DefaultRunsDir = %q", got)
	}
	t.Setenv("XDG_STATE_HOME", "")
	t.Setenv("HOME", "/home/u")
	if got := DefaultRunsDir(); got != "/home/u/.local/state/write-code/runs" {
		t.Errorf("DefaultRunsDir fallback = %q", got)
	}
}
