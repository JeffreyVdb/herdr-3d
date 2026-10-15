package store

// #54 repository discovery: the folders on the bridge host scanned for Git
// checkouts and how often (bridge-wide). One row; none is no roots and the
// default interval. Roots are a JSON array, in the order set.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
)

// migrationRepoDiscovery creates repo_discovery_settings (one row).
const migrationRepoDiscovery = `CREATE TABLE repo_discovery_settings (
		id               INTEGER PRIMARY KEY CHECK (id = 1),
		roots            TEXT NOT NULL,
		interval_minutes INTEGER NOT NULL CHECK (interval_minutes > 0),
		updated_at       TEXT NOT NULL
	);`

// RepoDiscovery is the stored discovery settings.
type RepoDiscovery struct {
	Roots           []string
	IntervalMinutes int
}

// LoadRepoDiscovery returns the discovery settings (never set: no roots,
// defaultInterval minutes).
func (s *Store) LoadRepoDiscovery(ctx context.Context, defaultInterval int) (RepoDiscovery, error) {
	var roots string
	out := RepoDiscovery{Roots: []string{}, IntervalMinutes: defaultInterval}
	err := s.db.QueryRowContext(ctx, `SELECT roots, interval_minutes FROM repo_discovery_settings WHERE id = 1`).Scan(&roots, &out.IntervalMinutes)
	if errors.Is(err, sql.ErrNoRows) {
		return out, nil
	}
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal([]byte(roots), &out.Roots); err != nil {
		return out, fmt.Errorf("repo_discovery_settings.roots: %w", err)
	}
	if out.Roots == nil {
		out.Roots = []string{}
	}
	return out, nil
}

// SaveRepoDiscovery stores the discovery settings.
func (s *Store) SaveRepoDiscovery(ctx context.Context, set RepoDiscovery) error {
	roots := set.Roots
	if roots == nil {
		roots = []string{}
	}
	b, err := json.Marshal(roots)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO repo_discovery_settings (id, roots, interval_minutes, updated_at) VALUES (1, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET roots = excluded.roots, interval_minutes = excluded.interval_minutes, updated_at = excluded.updated_at`,
		string(b), set.IntervalMinutes, s.ts())
	return err
}
