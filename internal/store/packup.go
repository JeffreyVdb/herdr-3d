package store

// #110 pack up on request: the feature's bridge-wide settings. Nothing of a
// prompt is ever stored.

import (
	"context"
	"database/sql"
	"errors"
)

// migrationPackup creates packup_settings (one row).
const migrationPackup = `CREATE TABLE packup_settings (
		id         INTEGER PRIMARY KEY CHECK (id = 1),
		enabled    INTEGER NOT NULL,
		threshold  REAL NOT NULL,
		updated_at TEXT NOT NULL
	);`

// LoadPackupSettings returns the stored settings (ok false: none yet).
func (s *Store) LoadPackupSettings(ctx context.Context) (enabled bool, threshold float64, ok bool, err error) {
	err = s.db.QueryRowContext(ctx, `SELECT enabled, threshold FROM packup_settings WHERE id = 1`).Scan(&enabled, &threshold)
	if errors.Is(err, sql.ErrNoRows) {
		return false, 0, false, nil
	}
	return enabled, threshold, err == nil, err
}

// SavePackupSettings stores the settings.
func (s *Store) SavePackupSettings(ctx context.Context, enabled bool, threshold float64) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO packup_settings (id, enabled, threshold, updated_at) VALUES (1, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, threshold = excluded.threshold, updated_at = excluded.updated_at`,
		enabled, threshold, s.ts())
	return err
}
