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

// PackupSettings is the persisted row, independent of the AI feature.
type PackupSettings struct {
	Enabled         bool
	Threshold       float64
	ReasoningEffort string
	MaxTokens       int
}

// migrationPackupReasoning preserves existing toggles and thresholds.
const migrationPackupReasoning = `ALTER TABLE packup_settings ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT '';
	ALTER TABLE packup_settings ADD COLUMN max_tokens INTEGER NOT NULL DEFAULT 600;`

func (s *Store) LoadPackupSettings(ctx context.Context) (v PackupSettings, ok bool, err error) {
	err = s.db.QueryRowContext(ctx, `SELECT enabled, threshold, reasoning_effort, max_tokens FROM packup_settings WHERE id = 1`).Scan(&v.Enabled, &v.Threshold, &v.ReasoningEffort, &v.MaxTokens)
	if errors.Is(err, sql.ErrNoRows) {
		return v, false, nil
	}
	return v, err == nil, err
}

func (s *Store) SavePackupSettings(ctx context.Context, v PackupSettings) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO packup_settings (id, enabled, threshold, reasoning_effort, max_tokens, updated_at) VALUES (1, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, threshold=excluded.threshold, reasoning_effort=excluded.reasoning_effort, max_tokens=excluded.max_tokens, updated_at=excluded.updated_at`, v.Enabled, v.Threshold, v.ReasoningEffort, v.MaxTokens, s.ts())
	return err
}
