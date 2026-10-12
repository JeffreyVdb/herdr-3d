package store

// #247: the "Repositories from other buildings" switch (bridge-wide):
// worker.repos lists the other buildings' floors too. One row; none is off.

import (
	"context"
	"database/sql"
	"errors"
)

// migrationRepoRefs creates repo_refs_settings (one row).
const migrationRepoRefs = `CREATE TABLE repo_refs_settings (
		id            INTEGER PRIMARY KEY CHECK (id = 1),
		all_buildings INTEGER NOT NULL,
		updated_at    TEXT NOT NULL
	);`

// LoadRepoRefs returns whether worker.repos lists every building's floors
// (never set: off).
func (s *Store) LoadRepoRefs(ctx context.Context) (allBuildings bool, err error) {
	err = s.db.QueryRowContext(ctx, `SELECT all_buildings FROM repo_refs_settings WHERE id = 1`).Scan(&allBuildings)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return allBuildings, err
}

// SaveRepoRefs stores the switch.
func (s *Store) SaveRepoRefs(ctx context.Context, allBuildings bool) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO repo_refs_settings (id, all_buildings, updated_at) VALUES (1, ?, ?)
		ON CONFLICT(id) DO UPDATE SET all_buildings = excluded.all_buildings, updated_at = excluded.updated_at`,
		allBuildings, s.ts())
	return err
}
