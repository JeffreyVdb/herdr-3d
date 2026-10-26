package manual

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
)

func TestRecordSurvivorsPersistsReverifiedIdentities(t *testing.T) {
	dir := t.TempDir()
	ticks, err := StartTicks(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	id := Identity{PID: os.Getpid(), StartTicks: ticks}
	if err := RecordSurvivors(dir, []Identity{id, id}); err != nil {
		t.Fatal(err)
	}
	got, err := ReadSurvivors(dir)
	if err != nil || len(got) != 1 || got[0] != id {
		t.Fatalf("recorded: %+v %v", got, err)
	}
	if err := RecordSurvivors(dir, nil); err != nil {
		t.Fatal(err)
	}
	got, err = ReadSurvivors(dir)
	if err != nil || len(got) != 1 || got[0] != id {
		t.Fatalf("retained: %+v %v", got, err)
	}
	info, err := os.Stat(filepath.Join(dir, "survivors.json"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("mode: %v %v", info, err)
	}
}

func TestGroupSurvivorsRetainsOnlyAuthenticatedIdentities(t *testing.T) {
	cmd := exec.Command("sleep", "120")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	ticks, err := StartTicks(cmd.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	status := Status{PID: cmd.Process.Pid, StartTicks: ticks, PGID: cmd.Process.Pid}
	dir := t.TempDir()
	got, err := GroupSurvivors(dir, status)
	if err != nil || len(got) != 1 || got[0] != (Identity{PID: status.PID, StartTicks: ticks}) {
		t.Fatalf("authenticated: %v %v", got, err)
	}
	status.StartTicks++
	got, err = GroupSurvivors(dir, status)
	if err != nil || len(got) != 1 || got[0].StartTicks != ticks {
		t.Fatalf("recorded identity: %v %v", got, err)
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Wait(); err == nil {
		t.Fatal("expected killed process")
	}
	got, err = GroupSurvivors(dir, status)
	if err != nil || len(got) != 0 {
		t.Fatalf("gone identity: %v %v", got, err)
	}
}
