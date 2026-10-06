package codexshare

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"syscall"
	"testing"
	"time"
)

// proc is a child process the test started; exited closes once it is reaped.
type proc struct {
	*exec.Cmd
	exited chan struct{}
}

// sleeper starts a shell that sleeps, with extra environment and args on
// its command line, in its own process group, and ends the group (and reaps
// the shell) when the test does.
func sleeper(t *testing.T, env []string, args ...string) proc {
	t.Helper()
	cmd := exec.Command("sh", append([]string{"-c", "sleep 60; :", "sleeper"}, args...)...)
	cmd.Env = append(os.Environ(), env...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	p := proc{cmd, make(chan struct{})}
	go func() { _ = cmd.Wait(); close(p.exited) }()
	t.Cleanup(func() {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		<-p.exited
	})
	return p
}

// Only a process carrying the fixture's exact owner marker is its own:
// naming the fixture's root, or a sibling of it, does not make it so.
func TestOwnedPIDsNeedTheMarker(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("reads /proc")
	}
	owner := NewOwner()
	root := t.TempDir()
	marked := sleeper(t, []string{OwnerVar + "=" + owner})
	markedNamed := sleeper(t, []string{OwnerVar + "=" + owner}, filepath.Join(root, "app.sock"))
	strangers := map[string]proc{
		"names the root":        sleeper(t, nil, filepath.Join(root, "app.sock")),
		"names a sibling":       sleeper(t, nil, root+"-unrelated/log"),
		"another owner":         sleeper(t, []string{OwnerVar + "=" + NewOwner()}, root),
		"marker as a prefix":    sleeper(t, []string{OwnerVar + "=" + owner + "x"}, root),
		"marker inside a value": sleeper(t, []string{"H3D_OTHER=" + OwnerVar + "=" + owner}, root),
	}

	all := OwnedPIDs(owner, "")
	for _, cmd := range []proc{marked, markedNamed} {
		if !slices.Contains(all, cmd.Process.Pid) {
			t.Errorf("marked process %d not selected: %v", cmd.Process.Pid, all)
		}
	}
	for name, cmd := range strangers {
		if slices.Contains(all, cmd.Process.Pid) {
			t.Errorf("%s: process %d selected", name, cmd.Process.Pid)
		}
	}
	if got := OwnedPIDs(owner, filepath.Join(root, "app.sock")); !slices.Equal(got, []int{markedNamed.Process.Pid}) {
		t.Errorf("OwnedPIDs(owner, sock) = %v, want [%d]", got, markedNamed.Process.Pid)
	}
	if got := OwnedPIDs("", ""); len(got) != 0 {
		t.Errorf("an empty owner selected %v", got)
	}
}

// KillOwned ends the marked processes and leaves every other one running.
func TestKillOwnedSparesStrangers(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("reads /proc")
	}
	owner := NewOwner()
	root := t.TempDir()
	marked := sleeper(t, []string{OwnerVar + "=" + owner}, root)
	stranger := sleeper(t, nil, root)
	sibling := sleeper(t, nil, root+"-unrelated/log")

	if left := KillOwned(owner); len(left) != 0 {
		t.Errorf("KillOwned left %v", left)
	}
	select {
	case <-marked.exited:
	case <-time.After(5 * time.Second):
		t.Errorf("marked process %d survived", marked.Process.Pid)
	}
	for _, p := range []proc{stranger, sibling} {
		select {
		case <-p.exited:
			t.Errorf("unmarked process %d was killed", p.Process.Pid)
		default:
		}
	}
}
