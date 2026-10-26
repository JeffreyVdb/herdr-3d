package manual

import (
	"bufio"
	"context"
	"errors"
	"os"
	"os/exec"
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
