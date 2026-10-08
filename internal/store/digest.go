package store

// #118 phase 2: the floor overview summaries' settings (one row, with the
// day's call count), and the LLM's lines by input (the key is the SHA-256 of
// the input as sent: never its text), so a restart spends nothing again.
// Nothing of a transcript is ever stored.

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// migrationDigest creates digest_settings (one row) and digest_cache.
const migrationDigest = `CREATE TABLE digest_settings (
		id          INTEGER PRIMARY KEY CHECK (id = 1),
		enabled     INTEGER NOT NULL,
		daily_cap   INTEGER NOT NULL,
		calls_day   TEXT NOT NULL DEFAULT '',
		calls_today INTEGER NOT NULL DEFAULT 0,
		updated_at  TEXT NOT NULL
	);
	CREATE TABLE digest_cache (
		key     TEXT PRIMARY KEY,
		line    TEXT NOT NULL,
		used_at TEXT NOT NULL
	);`

// migrationDigestReasoning adds the summaries' reasoning effort ("": the
// provider's default, nothing sent) and completion budget (0: the default).
const migrationDigestReasoning = `ALTER TABLE digest_settings ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT '';
	ALTER TABLE digest_settings ADD COLUMN max_tokens INTEGER NOT NULL DEFAULT 0;`

// DigestSettings are the feature's settings and the day's call count.
type DigestSettings struct {
	Enabled  bool
	DailyCap int
	// ReasoningEffort and MaxTokens: #174.
	ReasoningEffort string
	MaxTokens       int
	CallsDay        string
	CallsToday      int
}

// LoadDigestSettings returns the stored settings (ok false: none yet).
func (s *Store) LoadDigestSettings(ctx context.Context) (DigestSettings, bool, error) {
	var d DigestSettings
	err := s.db.QueryRowContext(ctx, `SELECT enabled, daily_cap, reasoning_effort, max_tokens, calls_day, calls_today FROM digest_settings WHERE id = 1`).
		Scan(&d.Enabled, &d.DailyCap, &d.ReasoningEffort, &d.MaxTokens, &d.CallsDay, &d.CallsToday)
	if errors.Is(err, sql.ErrNoRows) {
		return d, false, nil
	}
	return d, err == nil, err
}

// SaveDigestSettings stores the settings, not the call count (the count too
// only when no row is stored yet): a count saved meanwhile stays.
func (s *Store) SaveDigestSettings(ctx context.Context, d DigestSettings) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO digest_settings (id, enabled, daily_cap, reasoning_effort, max_tokens, calls_day, calls_today, updated_at)
		VALUES (1, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, daily_cap = excluded.daily_cap,
		reasoning_effort = excluded.reasoning_effort, max_tokens = excluded.max_tokens, updated_at = excluded.updated_at`,
		d.Enabled, d.DailyCap, d.ReasoningEffort, d.MaxTokens, d.CallsDay, d.CallsToday, s.ts())
	return err
}

// SaveDigestCalls stores the call count, not the settings (they too only
// when no row is stored yet): settings saved meanwhile stay.
func (s *Store) SaveDigestCalls(ctx context.Context, d DigestSettings) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO digest_settings (id, enabled, daily_cap, reasoning_effort, max_tokens, calls_day, calls_today, updated_at)
		VALUES (1, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET calls_day = excluded.calls_day, calls_today = excluded.calls_today,
		updated_at = excluded.updated_at`,
		d.Enabled, d.DailyCap, d.ReasoningEffort, d.MaxTokens, d.CallsDay, d.CallsToday, s.ts())
	return err
}

// DigestLine is the LLM's line for one input, by the input's key, and when
// the LLM wrote it (#198: used_at, stamped by each call's save; zero: now).
type DigestLine struct {
	Key, Line string
	UsedAt    time.Time
}

// DigestCache returns the newest lines, newest first.
func (s *Store) DigestCache(ctx context.Context, limit int) ([]DigestLine, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT key, line, used_at FROM digest_cache ORDER BY rowid DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DigestLine
	for rows.Next() {
		var d DigestLine
		var at string
		if err := rows.Scan(&d.Key, &d.Line, &at); err != nil {
			return nil, err
		}
		d.UsedAt, _ = time.Parse(time.RFC3339Nano, at) // unreadable: zero, unknown
		out = append(out, d)
	}
	return out, rows.Err()
}

// SaveDigestLine records a line and forgets all but the newest limit.
func (s *Store) SaveDigestLine(ctx context.Context, d DigestLine, limit int) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	// Deleted and inserted again: the newest row is the newest line.
	if _, err := tx.ExecContext(ctx, `DELETE FROM digest_cache WHERE key = ?`, d.Key); err != nil {
		return err
	}
	at := s.ts()
	if !d.UsedAt.IsZero() {
		at = stamp(d.UsedAt)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO digest_cache (key, line, used_at) VALUES (?, ?, ?)`, d.Key, d.Line, at); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM digest_cache WHERE rowid NOT IN
		(SELECT rowid FROM digest_cache ORDER BY rowid DESC LIMIT ?)`, limit); err != nil {
		return err
	}
	return tx.Commit()
}
