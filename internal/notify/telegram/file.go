package telegram

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// Stored is what the bridge keeps between runs, in one 0600 file of its own
// next to the database (never in it): the bot token (unless the environment
// gives it), the bot it is of, and the paired recipient.
type Stored struct {
	Token string `json:"token,omitempty"`
	// BotID is the token's numeric prefix and Bot the bot's username, from
	// getMe: a recipient is the paired one only for this bot.
	BotID string `json:"bot_id,omitempty"`
	Bot   string `json:"bot,omitempty"`
	// UserID is the paired person's Telegram user id (message.from.id; in
	// a private chat it is also the chat's id), UserName their first name.
	UserID   int64  `json:"user_id,omitempty"`
	UserName string `json:"user_name,omitempty"`
	PairedAt int64  `json:"paired_at,omitempty"` // unix ms
}

// fileStore reads and writes the file.
type fileStore struct{ path string }

// load reads the file: an absent one is empty, a malformed one an error (it
// must never be overwritten blindly: it holds a token).
func (f fileStore) load() (Stored, error) {
	if f.path == "" {
		return Stored{}, nil
	}
	b, err := os.ReadFile(f.path)
	if errors.Is(err, fs.ErrNotExist) {
		return Stored{}, nil
	}
	if err != nil {
		return Stored{}, fmt.Errorf("read %s: %w", f.path, err)
	}
	// A file somebody else could read is tightened, not trusted.
	if fi, err := os.Stat(f.path); err == nil && fi.Mode().Perm()&0o077 != 0 {
		_ = os.Chmod(f.path, 0o600)
	}
	var s Stored
	if err := json.Unmarshal(b, &s); err != nil {
		return Stored{}, fmt.Errorf("%s is not valid (fix or remove it)", f.path)
	}
	return s, nil
}

// save writes the file atomically: a 0600 temporary file in the same
// directory, synced, renamed over it.
func (f fileStore) save(s Stored) error {
	if f.path == "" {
		return nil
	}
	dir := filepath.Dir(f.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create %s: %w", dir, err)
	}
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, filepath.Base(f.path)+".*.tmp") // 0600
	if err != nil {
		return fmt.Errorf("write %s: %w", f.path, err)
	}
	name := tmp.Name()
	fail := func(err error) error {
		tmp.Close()
		os.Remove(name)
		return fmt.Errorf("write %s: %w", f.path, err)
	}
	if err := tmp.Chmod(0o600); err != nil {
		return fail(err)
	}
	if _, err := tmp.Write(append(b, '\n')); err != nil {
		return fail(err)
	}
	if err := tmp.Sync(); err != nil {
		return fail(err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(name)
		return fmt.Errorf("write %s: %w", f.path, err)
	}
	if err := os.Rename(name, f.path); err != nil {
		os.Remove(name)
		return fmt.Errorf("write %s: %w", f.path, err)
	}
	return nil
}
