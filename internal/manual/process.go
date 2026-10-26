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

// CheckIdentity distinguishes a vanished or reused PID from an unreadable
// process. An error must not be treated as proof that a process is gone.
func CheckIdentity(pid int, ticks uint64) (bool, error) {
	if pid <= 0 || ticks == 0 {
		return false, fmt.Errorf("invalid process identity")
	}
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	end := strings.LastIndexByte(string(b), ')')
	if end < 0 {
		return false, fmt.Errorf("invalid proc stat")
	}
	fields := strings.Fields(string(b[end+1:]))
	if len(fields) == 0 {
		return false, fmt.Errorf("invalid proc stat")
	}
	got, err := ParseStartTicks(string(b))
	if err != nil {
		return false, err
	}
	return got == ticks && fields[0] != "Z" && fields[0] != "X", nil
}

func IdentityAlive(pid int, ticks uint64) bool { alive, _ := CheckIdentity(pid, ticks); return alive }

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

// StopGroup escalates while at least one re-identified original group member
// remains in the group. This still reaches ordinary children if the launcher
// exits on SIGINT, without signalling a reused group ID.
func StopGroup(ctx context.Context, status Status, grace time.Duration) error {
	alive, err := CheckIdentity(status.PID, status.StartTicks)
	if err != nil || !alive {
		return err
	}
	if status.PGID <= 1 || status.PGID == syscall.Getpgrp() {
		return fmt.Errorf("unsafe process group")
	}
	pgid, err := syscall.Getpgid(status.PID)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	if err != nil {
		return err
	}
	if pgid != status.PGID {
		return fmt.Errorf("process group changed")
	}
	members, err := GroupProcesses(status.PGID)
	if err != nil {
		return err
	}
	found := false
	for _, p := range members {
		if p.PID == status.PID && p.StartTicks == status.StartTicks {
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("cannot verify original process group")
	}
	groupAlive := func() (bool, error) {
		for _, p := range members {
			alive, err := CheckIdentity(p.PID, p.StartTicks)
			if err != nil {
				return false, err
			}
			if !alive {
				continue
			}
			current, err := syscall.Getpgid(p.PID)
			if errors.Is(err, syscall.ESRCH) {
				continue
			}
			if err != nil {
				return false, err
			}
			if current == status.PGID {
				return true, nil
			}
		}
		return false, nil
	}
	for _, sig := range []syscall.Signal{syscall.SIGINT, syscall.SIGTERM, syscall.SIGKILL} {
		alive, err = groupAlive()
		if err != nil || !alive {
			return err
		}
		if err := syscall.Kill(-status.PGID, sig); err != nil && !errors.Is(err, syscall.ESRCH) {
			return err
		}
		deadline := time.NewTimer(grace)
		ticker := time.NewTicker(50 * time.Millisecond)
		waiting := true
		for waiting {
			alive, err = groupAlive()
			if err != nil || !alive {
				ticker.Stop()
				deadline.Stop()
				return err
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
	alive, err = groupAlive()
	if err != nil {
		return err
	}
	if alive {
		return fmt.Errorf("process group still running after SIGKILL")
	}
	return nil
}

// StopTagged retries cleanup of precisely the currently tagged, re-identified
// processes. It does not use process names or an unchecked PID.
func StopTagged(ctx context.Context, id string, grace time.Duration) ([]Identity, error) {
	found, err := TaggedProcesses(id)
	if err != nil {
		return nil, err
	}
	for _, sig := range []syscall.Signal{syscall.SIGTERM, syscall.SIGKILL} {
		for _, p := range found {
			alive, err := CheckIdentity(p.PID, p.StartTicks)
			if err != nil {
				return found, err
			}
			if !alive {
				continue
			}
			if err := syscall.Kill(p.PID, sig); err != nil && !errors.Is(err, syscall.ESRCH) {
				return found, err
			}
		}
		timer := time.NewTimer(grace)
		select {
		case <-ctx.Done():
			timer.Stop()
			return found, ctx.Err()
		case <-timer.C:
		}
		alive := false
		for _, p := range found {
			running, err := CheckIdentity(p.PID, p.StartTicks)
			if err != nil {
				return found, err
			}
			alive = alive || running
		}
		if !alive {
			break
		}
	}
	return TaggedProcesses(id)
}

// GroupProcesses lists live members visible in /proc, including members whose
// environment cannot be read. The group ID is evidence for verification only;
// callers must still check an individual identity before signalling it.
func GroupProcesses(pgid int) ([]Identity, error) {
	if pgid <= 1 {
		return nil, fmt.Errorf("invalid process group")
	}
	dirs, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	var out []Identity
	for _, d := range dirs {
		pid, err := strconv.Atoi(d.Name())
		if err != nil || pid <= 0 {
			continue
		}
		b, err := os.ReadFile(filepath.Join("/proc", d.Name(), "stat"))
		if err != nil {
			continue
		}
		end := strings.LastIndexByte(string(b), ')')
		if end < 0 {
			continue
		}
		fields := strings.Fields(string(b[end+1:]))
		if len(fields) < 20 || fields[0] == "Z" || fields[0] == "X" {
			continue
		}
		group, err := strconv.Atoi(fields[2])
		if err != nil || group != pgid {
			continue
		}
		ticks, err := strconv.ParseUint(fields[19], 10, 64)
		if err == nil && ticks != 0 {
			out = append(out, Identity{PID: pid, StartTicks: ticks})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].PID < out[j].PID })
	return out, nil
}
