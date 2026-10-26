package manual

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// IdentityAlive distinguishes PID reuse and treats zombies as no longer running.
func IdentityAlive(pid int, ticks uint64) bool {
	if pid <= 0 || ticks == 0 {
		return false
	}
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return false
	}
	end := strings.LastIndexByte(string(b), ')')
	if end < 0 {
		return false
	}
	fields := strings.Fields(string(b[end+1:]))
	if len(fields) == 0 || fields[0] == "Z" || fields[0] == "X" {
		return false
	}
	got, err := ParseStartTicks(string(b))
	return err == nil && got == ticks
}

type Identity struct {
	PID        int
	StartTicks uint64
}

// TaggedProcesses finds live descendants that retained the launch marker.
func TaggedProcesses(id string) ([]Identity, error) {
	dirs, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	marker := []byte("H3D_MANUAL_PROCESS=" + id)
	var result []Identity
	for _, d := range dirs {
		pid, err := strconv.Atoi(d.Name())
		if err != nil || pid <= 0 {
			continue
		}
		b, err := os.ReadFile(filepath.Join("/proc", d.Name(), "environ"))
		if err != nil {
			continue
		}
		match := false
		for _, v := range bytes.Split(b, []byte{0}) {
			if bytes.Equal(v, marker) {
				match = true
				break
			}
		}
		if !match {
			continue
		}
		ticks, err := StartTicks(pid)
		if err == nil && IdentityAlive(pid, ticks) {
			result = append(result, Identity{pid, ticks})
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].PID < result[j].PID })
	return result, nil
}

// StopGroup escalates signals while the launcher's identity still matches.
func StopGroup(ctx context.Context, status Status, grace time.Duration) error {
	if !IdentityAlive(status.PID, status.StartTicks) {
		return nil
	}
	if status.PGID <= 1 || status.PGID == syscall.Getpgrp() {
		return fmt.Errorf("unsafe process group")
	}
	for _, sig := range []syscall.Signal{syscall.SIGINT, syscall.SIGTERM, syscall.SIGKILL} {
		if !IdentityAlive(status.PID, status.StartTicks) {
			return nil
		}
		pgid, err := syscall.Getpgid(status.PID)
		if err != nil {
			if errors.Is(err, syscall.ESRCH) {
				return nil
			}
			return err
		}
		if pgid != status.PGID {
			return fmt.Errorf("process group changed")
		}
		if err := syscall.Kill(-pgid, sig); err != nil && !errors.Is(err, syscall.ESRCH) {
			return err
		}
		deadline := time.NewTimer(grace)
		ticker := time.NewTicker(50 * time.Millisecond)
		waiting := true
		for waiting {
			if !IdentityAlive(status.PID, status.StartTicks) {
				ticker.Stop()
				deadline.Stop()
				return nil
			}
			select {
			case <-ctx.Done():
				ticker.Stop()
				deadline.Stop()
				return ctx.Err()
			case <-ticker.C:
			case <-deadline.C:
				waiting = false
			}
		}
		ticker.Stop()
		deadline.Stop()
	}
	if IdentityAlive(status.PID, status.StartTicks) {
		return fmt.Errorf("process still running after SIGKILL")
	}
	return nil
}
