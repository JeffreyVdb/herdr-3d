package ai

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// Stored is what the bridge keeps between runs: both roles' settings and
// their keys, in one 0600 file of their own, next to the database and never
// in it (the database is read by more tools than the bridge needs to trust
// with a key).
type Stored struct {
	Classifier *StoredClassifier `json:"classifier,omitempty"`
	LLM        *StoredLLM        `json:"llm,omitempty"`
	// EnvBase remembers what a passing test resolved the environment's LLM
	// base URL to (/v1 added). It is a cache keyed by the environment's URL:
	// it applies only while that URL is unchanged, and Clear keeps it.
	EnvBase *ResolvedBase `json:"env_base,omitempty"`
}

// ResolvedBase is a base URL and what it was resolved to.
type ResolvedBase struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// StoredClassifier is the classifier's settings.
type StoredClassifier struct {
	Model string `json:"model,omitempty"`
	Key   string `json:"key,omitempty"`
}

// StoredLLM is the LLM's settings.
type StoredLLM struct {
	BaseURL   string          `json:"base_url,omitempty"`
	Model     string          `json:"model,omitempty"`
	Key       string          `json:"key,omitempty"`
	ExtraBody json.RawMessage `json:"extra_body,omitempty"`
	JSONMode  *bool           `json:"json_mode,omitempty"`
}

func (s Stored) clone() Stored {
	var c Stored
	if s.EnvBase != nil {
		v := *s.EnvBase
		c.EnvBase = &v
	}
	if s.Classifier != nil {
		v := *s.Classifier
		c.Classifier = &v
	}
	if s.LLM != nil {
		v := *s.LLM
		v.ExtraBody = append(json.RawMessage(nil), v.ExtraBody...)
		if v.JSONMode != nil {
			b := *v.JSONMode
			v.JSONMode = &b
		}
		c.LLM = &v
	}
	return c
}

// fileStore reads and writes the file.
type fileStore struct{ path string }

// load reads the file: an absent one is empty, a malformed one an error (it
// must never be overwritten blindly: it holds keys).
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
		return Stored{}, fmt.Errorf("%s is not valid (fix or remove it): %w", f.path, err)
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
