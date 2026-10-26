package manual

import (
	"errors"
	"os"
	"path/filepath"
)

// TabClosed records that the original manual tab was observed or closed. A
// later retry can then clean a detached process even while its floor is asleep.
func TabClosed(dir string) (bool, error) {
	_, err := os.Stat(filepath.Join(dir, "tab-closed"))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

func MarkTabClosed(dir string) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".tab-closed-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err := f.Chmod(0600); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), filepath.Join(dir, "tab-closed"))
}
