package store

// #90: the follow-up questions feature's bridge-wide settings, and the final
// messages it has looked at (by worker and the message's SHA-256), so a
// restart or a re-read of a transcript never classifies or flags the same
// message twice. A flagged message's follow-up is kept with it until it is
// answered, dismissed or otherwise cleared, so a restart shows it again.

import (
	"context"
	"database/sql"
	"errors"
)

// migrationFollowup creates followup_settings (one row) and followup_seen.
// followup is the worker's Followup as JSON, ” when the message was not
// flagged; cleared is set once it was answered, dismissed or cleared.
const migrationFollowup = `CREATE TABLE followup_settings (
		id         INTEGER PRIMARY KEY CHECK (id = 1),
		enabled    INTEGER NOT NULL,
		threshold  REAL NOT NULL,
		updated_at TEXT NOT NULL
	);
	CREATE TABLE followup_seen (
		worker_uuid TEXT NOT NULL,
		text_sha    TEXT NOT NULL,
		followup    TEXT NOT NULL DEFAULT '',
		cleared     INTEGER NOT NULL DEFAULT 0,
		seen_at     TEXT NOT NULL,
		PRIMARY KEY (worker_uuid, text_sha)
	);`

// followupSeenKeep is how many messages are remembered per worker (only the
// latest turn is ever looked at; a few more cover a re-read).
const followupSeenKeep = 20

// LoadFollowupSettings returns the stored settings (ok false: none yet).
func (s *Store) LoadFollowupSettings(ctx context.Context) (enabled bool, threshold float64, ok bool, err error) {
	err = s.db.QueryRowContext(ctx, `SELECT enabled, threshold FROM followup_settings WHERE id = 1`).Scan(&enabled, &threshold)
	if errors.Is(err, sql.ErrNoRows) {
		return false, 0, false, nil
	}
	return enabled, threshold, err == nil, err
}

// SaveFollowupSettings stores the settings.
func (s *Store) SaveFollowupSettings(ctx context.Context, enabled bool, threshold float64) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO followup_settings (id, enabled, threshold, updated_at) VALUES (1, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, threshold = excluded.threshold, updated_at = excluded.updated_at`,
		enabled, threshold, s.ts())
	return err
}

// FollowupSeen is a message the feature looked at.
type FollowupSeen struct {
	Followup string // the Followup as JSON, "" when not flagged
	Cleared  bool
}

// FollowupSeenOf returns what was recorded for a worker's message (ok false:
// never looked at).
func (s *Store) FollowupSeenOf(ctx context.Context, workerID, sha string) (FollowupSeen, bool, error) {
	var f FollowupSeen
	err := s.db.QueryRowContext(ctx, `SELECT followup, cleared FROM followup_seen WHERE worker_uuid = ? AND text_sha = ?`,
		workerID, sha).Scan(&f.Followup, &f.Cleared)
	if errors.Is(err, sql.ErrNoRows) {
		return f, false, nil
	}
	return f, err == nil, err
}

// RecordFollowupSeen records that a worker's message was looked at, with its
// follow-up ("" when not flagged), and forgets the worker's oldest beyond
// the last 20.
func (s *Store) RecordFollowupSeen(ctx context.Context, workerID, sha, followup string, cleared bool) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `INSERT INTO followup_seen (worker_uuid, text_sha, followup, cleared, seen_at) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(worker_uuid, text_sha) DO UPDATE SET followup = excluded.followup, cleared = excluded.cleared`,
		workerID, sha, followup, cleared, s.ts()); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM followup_seen WHERE worker_uuid = ? AND rowid NOT IN
		(SELECT rowid FROM followup_seen WHERE worker_uuid = ? ORDER BY seen_at DESC, rowid DESC LIMIT ?)`,
		workerID, workerID, followupSeenKeep); err != nil {
		return err
	}
	return tx.Commit()
}

// ClearFollowupSeen marks a worker's flagged message as dealt with: a
// restart does not show its follow-up again.
func (s *Store) ClearFollowupSeen(ctx context.Context, workerID, sha string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE followup_seen SET cleared = 1 WHERE worker_uuid = ? AND text_sha = ?`, workerID, sha)
	return err
}
