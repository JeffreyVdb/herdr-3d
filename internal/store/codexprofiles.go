package store

// #138 Codex profiles: what the user set for the Codex home folders (a
// name, hidden) and the folders they added (bridge-wide). One row; none is
// nothing set. The settings are one JSON object.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
)

// migrationCodexProfiles creates codex_profiles_settings (one row).
const migrationCodexProfiles = `CREATE TABLE codex_profiles_settings (
		id         INTEGER PRIMARY KEY CHECK (id = 1),
		settings   TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);`

// CodexProfile is what the user set for one profile, by its folder.
type CodexProfile struct {
	Path   string `json:"path"`
	Name   string `json:"name,omitempty"`
	Hidden bool   `json:"hidden,omitempty"`
}

// CodexProfiles are the stored settings.
type CodexProfiles struct {
	Profiles []CodexProfile `json:"profiles"`
	// Added are the folders the user added, in the order added.
	Added []string `json:"added"`
}

// LoadCodexProfiles returns the settings (never set: none).
func (s *Store) LoadCodexProfiles(ctx context.Context) (CodexProfiles, error) {
	out := CodexProfiles{Profiles: []CodexProfile{}, Added: []string{}}
	var raw string
	err := s.db.QueryRowContext(ctx, `SELECT settings FROM codex_profiles_settings WHERE id = 1`).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return out, nil
	}
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return out, fmt.Errorf("codex_profiles_settings.settings: %w", err)
	}
	if out.Profiles == nil {
		out.Profiles = []CodexProfile{}
	}
	if out.Added == nil {
		out.Added = []string{}
	}
	return out, nil
}

// SaveCodexProfiles stores the settings.
func (s *Store) SaveCodexProfiles(ctx context.Context, set CodexProfiles) error {
	if set.Profiles == nil {
		set.Profiles = []CodexProfile{}
	}
	if set.Added == nil {
		set.Added = []string{}
	}
	b, err := json.Marshal(set)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO codex_profiles_settings (id, settings, updated_at) VALUES (1, ?, ?)
		ON CONFLICT(id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`, string(b), s.ts())
	return err
}
