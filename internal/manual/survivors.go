package manual

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// ReadSurvivors returns identities reported by an earlier cleanup. A missing
// file means no identity has yet been approved for a retry.
func ReadSurvivors(dir string) ([]Identity, error) {
	b, err := os.ReadFile(filepath.Join(dir, "survivors.json"))
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
	previous, err := ReadSurvivors(dir)
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
		if err := os.Remove(filepath.Join(dir, "survivors.json")); err != nil && !errors.Is(err, os.ErrNotExist) {
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
	return os.Rename(f.Name(), filepath.Join(dir, "survivors.json"))
}
