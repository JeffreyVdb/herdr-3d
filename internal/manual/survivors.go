package manual

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// ReadSurvivors returns identities reported by an earlier cleanup. A missing
// file means no identity has yet been approved for a retry.
func ReadSurvivors(dir string) ([]Identity, error) {
	return readIdentities(dir, "survivors.json")
}

func readIdentities(dir, name string) ([]Identity, error) {
	b, err := os.ReadFile(filepath.Join(dir, name))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var ids []Identity
	if err := json.Unmarshal(b, &ids); err != nil {
		return nil, err
	}
	for _, p := range ids {
		if p.PID <= 0 || p.StartTicks == 0 {
			return nil, fmt.Errorf("invalid recorded process identity")
		}
	}
	return ids, nil
}

// RecordSurvivors preserves still-live prior identities and adds newly seen
// tagged processes. They can only be signalled by a later explicit Stop.
func RecordSurvivors(dir string, current []Identity) error {
	return recordIdentities(dir, "survivors.json", current)
}

func recordIdentities(dir, name string, current []Identity) error {
	previous, err := readIdentities(dir, name)
	if err != nil {
		return err
	}
	seen := map[Identity]bool{}
	ids := make([]Identity, 0, len(previous)+len(current))
	for _, p := range previous {
		alive, err := CheckIdentity(p.PID, p.StartTicks)
		if err != nil {
			return err
		}
		if alive && !seen[p] {
			ids = append(ids, p)
			seen[p] = true
		}
	}
	for _, p := range current {
		if p.PID <= 0 || p.StartTicks == 0 {
			return fmt.Errorf("invalid process identity")
		}
		if !seen[p] {
			ids = append(ids, p)
			seen[p] = true
		}
	}
	if len(ids) == 0 {
		if err := os.Remove(filepath.Join(dir, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	b, err := json.Marshal(ids)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".survivors-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err := f.Chmod(0600); err != nil {
		_ = f.Close()
		return err
	}
	if _, err := f.Write(b); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), filepath.Join(dir, name))
}

// GroupSurvivors records group members only while the launcher identity is
// verified, and subsequently returns only those exact still-live identities.
func GroupSurvivors(dir string, status Status) ([]Identity, error) {
	alive, err := CheckIdentity(status.PID, status.StartTicks)
	if err != nil {
		return nil, err
	}
	var members []Identity
	if alive && status.PGID > 1 {
		pgid, err := syscall.Getpgid(status.PID)
		if err != nil && !errors.Is(err, syscall.ESRCH) {
			return nil, err
		}
		if err == nil && pgid == status.PGID {
			members, err = GroupProcesses(status.PGID)
			if err != nil {
				return nil, err
			}
			alive, err = CheckIdentity(status.PID, status.StartTicks)
			if err != nil {
				return nil, err
			}
			if !alive {
				members = nil
			}
		}
	}
	if err := recordIdentities(dir, "group.json", members); err != nil {
		return nil, err
	}
	return readIdentities(dir, "group.json")
}
