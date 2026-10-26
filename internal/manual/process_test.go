package manual

import (
	"bufio"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestIdentityMatchesCurrentProcess(t *testing.T) {
	ticks, err := StartTicks(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	if !IdentityAlive(os.Getpid(), ticks) {
		t.Fatal("current identity not found")
	}
	if IdentityAlive(os.Getpid(), ticks+1) {
		t.Fatal("reused PID matched")
	}
	if IdentityAlive(0, ticks) {
		t.Fatal("invalid PID matched")
	}
}

func TestStopGroupRefusesUnsafeOrReusedIdentity(t *testing.T) {
	pid := os.Getpid()
	ticks, err := StartTicks(pid)
	if err != nil {
		t.Fatal(err)
	}
	if err := StopGroup(context.Background(), Status{PID: pid, StartTicks: ticks + 1, PGID: syscall.Getpgrp()}, time.Millisecond); err != nil {
		t.Fatalf("reused identity: %v", err)
	}
	if err := StopGroup(context.Background(), Status{PID: pid, StartTicks: ticks, PGID: syscall.Getpgrp()}, time.Millisecond); err == nil {
		t.Fatal("unsafe process group accepted")
	}
}

func TestStopGroupReportsTimeoutWithoutClaimingSuccess(t *testing.T) {
	cmd := exec.Command("/bin/sh", "-c", `trap '' INT TERM; printf 'ready\n'; while :; do sleep 1; done`)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	ticks, err := StartTicks(cmd.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if IdentityAlive(cmd.Process.Pid, ticks) {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
		<-done
	})
	line, err := bufio.NewReader(pipe).ReadString('\n')
	if err != nil || line != "ready\n" {
		t.Fatalf("fixture: %q %v", line, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err = StopGroup(ctx, Status{PID: cmd.Process.Pid, StartTicks: ticks, PGID: cmd.Process.Pid}, time.Second)
	if !errors.Is(err, context.Canceled) || !IdentityAlive(cmd.Process.Pid, ticks) {
		t.Fatalf("timeout: %v", err)
	}
}

func TestGroupProcessesIncludesCurrentIdentity(t *testing.T) {
	members, err := GroupProcesses(syscall.Getpgrp())
	if err != nil {
		t.Fatal(err)
	}
	ticks, err := StartTicks(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range members {
		if p.PID == os.Getpid() && p.StartTicks == ticks {
			return
		}
	}
	t.Fatalf("current process absent from group: %+v", members)
}

func TestStopGroupEscalatesAfterLauncherExits(t *testing.T) {
	dir := t.TempDir()
	pidfile := filepath.Join(dir, "child.pid")
	cmd := exec.Command("/bin/sh", "-c", `trap 'exit 0' INT; sh -c 'trap "" INT; echo $$ > "$1"; exec sleep 120' sh "$1" & wait`, "sh", pidfile)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	parentTicks, err := StartTicks(cmd.Process.Pid)
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	var child Identity
	t.Cleanup(func() {
		if child.PID > 0 && IdentityAlive(child.PID, child.StartTicks) {
			_ = syscall.Kill(child.PID, syscall.SIGKILL)
		}
		if IdentityAlive(cmd.Process.Pid, parentTicks) {
			_ = syscall.Kill(cmd.Process.Pid, syscall.SIGKILL)
		}
		<-done
	})
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		b, err := os.ReadFile(pidfile)
		if err == nil {
			child.PID, err = strconv.Atoi(strings.TrimSpace(string(b)))
			if err == nil {
				child.StartTicks, err = StartTicks(child.PID)
				if err == nil {
					break
				}
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if child.PID == 0 || child.StartTicks == 0 {
		t.Fatal("child did not start")
	}
	if err := StopGroup(context.Background(), Status{PID: cmd.Process.Pid, StartTicks: parentTicks, PGID: cmd.Process.Pid}, 200*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	if IdentityAlive(child.PID, child.StartTicks) {
		t.Fatal("foreground child survived escalation")
	}
}
