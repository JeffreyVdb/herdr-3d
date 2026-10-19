package store

// #66: schedule suggestions' bridge-wide settings (with the user's time zone
// the extraction reads clock times in), and the final messages they looked
// at (by worker and the message's SHA-256), as followup_seen does for the
// follow-up questions: a restart or a re-read of a transcript never asks the
// models about the same message twice. A suggestion is kept with its message
// until it is accepted, dismissed or otherwise closed (outcome), so a
// restart shows an open one again and never one that was dealt with.

import (
	"context"
	"database/sql"
	"errors"
)

// migrationScheduleSuggest creates schedsuggest_settings (one row) and
// schedsuggest_seen. suggestion is the worker's ScheduleSuggestion as JSON,
// ” when the message had none; outcome is ” while it is open (or there is
// none), else why it closed (ScheduleSuggestAccepted …).
const migrationScheduleSuggest = `CREATE TABLE schedsuggest_settings (
		id         INTEGER PRIMARY KEY CHECK (id = 1),
		enabled    INTEGER NOT NULL,
		threshold  REAL NOT NULL,
		zone       TEXT NOT NULL DEFAULT '',
		updated_at TEXT NOT NULL
	);
	CREATE TABLE schedsuggest_seen (
		worker_uuid TEXT NOT NULL,
		text_sha    TEXT NOT NULL,
		suggestion  TEXT NOT NULL DEFAULT '',
		outcome     TEXT NOT NULL DEFAULT '',
		seen_at     TEXT NOT NULL,
		PRIMARY KEY (worker_uuid, text_sha)
	);`

// Why a suggestion closed (ScheduleSuggestSeen.Outcome).
const (
	ScheduleSuggestAccepted  = "accepted"  // a schedule.create from it
	ScheduleSuggestDismissed = "dismissed" // worker.dismiss_schedule_suggestion
	ScheduleSuggestMoved     = "moved"     // the transcript went on (a prompt, another turn)
	ScheduleSuggestStale     = "stale"     // made after its turn was superseded: never shown
	ScheduleSuggestGone      = "gone"      // its worker went
)

// LoadScheduleSuggestSettings returns the stored settings (ok false: none
// yet).
func (s *Store) LoadScheduleSuggestSettings(ctx context.Context) (enabled bool, threshold float64, zone string, ok bool, err error) {
	err = s.db.QueryRowContext(ctx, `SELECT enabled, threshold, zone FROM schedsuggest_settings WHERE id = 1`).Scan(&enabled, &threshold, &zone)
	if errors.Is(err, sql.ErrNoRows) {
		return false, 0, "", false, nil
	}
	return enabled, threshold, zone, err == nil, err
}

// SaveScheduleSuggestSettings stores the settings.
func (s *Store) SaveScheduleSuggestSettings(ctx context.Context, enabled bool, threshold float64, zone string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO schedsuggest_settings (id, enabled, threshold, zone, updated_at) VALUES (1, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, threshold = excluded.threshold, zone = excluded.zone,
			updated_at = excluded.updated_at`,
		enabled, threshold, zone, s.ts())
	return err
}

// ScheduleSuggestSeen is a message the feature looked at.
type ScheduleSuggestSeen struct {
	Suggestion string // the ScheduleSuggestion as JSON, "" when it had none
	Outcome    string // "" while open
}

// ScheduleSuggestSeenOf returns what was recorded for a worker's message (ok
// false: never looked at).
func (s *Store) ScheduleSuggestSeenOf(ctx context.Context, workerID, sha string) (ScheduleSuggestSeen, bool, error) {
	var f ScheduleSuggestSeen
	err := s.db.QueryRowContext(ctx, `SELECT suggestion, outcome FROM schedsuggest_seen WHERE worker_uuid = ? AND text_sha = ?`,
		workerID, sha).Scan(&f.Suggestion, &f.Outcome)
	if errors.Is(err, sql.ErrNoRows) {
		return f, false, nil
	}
	return f, err == nil, err
}

// RecordScheduleSuggestSeen records that a worker's message was looked at,
// with its suggestion ("" when none) and outcome ("": open), and forgets the
// worker's oldest beyond the last 20.
func (s *Store) RecordScheduleSuggestSeen(ctx context.Context, workerID, sha, suggestion, outcome string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `INSERT INTO schedsuggest_seen (worker_uuid, text_sha, suggestion, outcome, seen_at) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(worker_uuid, text_sha) DO UPDATE SET suggestion = excluded.suggestion, outcome = excluded.outcome`,
		workerID, sha, suggestion, outcome, s.ts()); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM schedsuggest_seen WHERE worker_uuid = ? AND rowid NOT IN
		(SELECT rowid FROM schedsuggest_seen WHERE worker_uuid = ? ORDER BY seen_at DESC, rowid DESC LIMIT ?)`,
		workerID, workerID, followupSeenKeep); err != nil {
		return err
	}
	return tx.Commit()
}

// CloseScheduleSuggestSeen marks a worker's suggestion as dealt with
// (outcome): a restart does not show it again. An already closed one keeps
// its first outcome.
func (s *Store) CloseScheduleSuggestSeen(ctx context.Context, workerID, sha, outcome string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE schedsuggest_seen SET outcome = ? WHERE worker_uuid = ? AND text_sha = ? AND outcome = ''`,
		outcome, workerID, sha)
	return err
}
