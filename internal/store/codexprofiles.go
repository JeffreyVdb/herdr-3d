package store

// #138 Codex profiles: what the user set for the Codex home folders (a
// name, hidden; #140 "may be used for anything"), the folders they added
// and (#140) the Auto hire's rules (bridge-wide). One row; none is nothing
// set. The settings are one JSON object; a field it lacks (one stored
// before #140) is its zero value.

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
	Path     string `json:"path"`
	Name     string `json:"name,omitempty"`
	Hidden   bool   `json:"hidden,omitempty"`
	Anything bool   `json:"anything,omitempty"` // #140
}

// CodexRule is one of the Auto hire's rules (#140): a match (a GitHub
// owner or repo, or a folder) and the profile key it hires on.
type CodexRule struct {
	Match   string `json:"match"`
	Profile string `json:"profile"`
}

// CodexProfiles are the stored settings.
type CodexProfiles struct {
	Profiles []CodexProfile `json:"profiles"`
	// Added are the folders the user added, in the order added.
	Added []string `json:"added"`
	// Rules (#140), in order.
	Rules []CodexRule `json:"rules"`
}

// LoadCodexProfiles returns the settings (never set: none).
func (s *Store) LoadCodexProfiles(ctx context.Context) (CodexProfiles, error) {
	out := CodexProfiles{Profiles: []CodexProfile{}, Added: []string{}, Rules: []CodexRule{}}
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
	if out.Rules == nil {
		out.Rules = []CodexRule{}
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
	if set.Rules == nil {
		set.Rules = []CodexRule{}
	}
	b, err := json.Marshal(set)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO codex_profiles_settings (id, settings, updated_at) VALUES (1, ?, ?)
		ON CONFLICT(id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`, string(b), s.ts())
	return err
}
