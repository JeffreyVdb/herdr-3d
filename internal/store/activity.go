package store

// #98: the "Classify unknown commands" settings (one row, with the day's
// call count), and the model's answers by normalised command (the key is
// the SHA-256 of the tool and the command as normalised: never the
// command's text), so a restart asks nothing again.

import (
	"context"
	"database/sql"
	"errors"
)

// migrationActivity creates activity_settings (one row) and activity_cache.
const migrationActivity = `CREATE TABLE activity_settings (
		id            INTEGER PRIMARY KEY CHECK (id = 1),
		model_enabled INTEGER NOT NULL,
		threshold     REAL NOT NULL,
		margin        REAL NOT NULL,
		daily_cap     INTEGER NOT NULL,
		calls_day     TEXT NOT NULL DEFAULT '',
		calls_today   INTEGER NOT NULL DEFAULT 0,
		updated_at    TEXT NOT NULL
	);
	CREATE TABLE activity_cache (
		key     TEXT PRIMARY KEY,
		kind    TEXT NOT NULL,
		used_at TEXT NOT NULL
	);`

// ActivitySettings are the feature's settings and the day's call count.
type ActivitySettings struct {
	ModelEnabled bool
	Threshold    float64
	Margin       float64
	DailyCap     int
	CallsDay     string
	CallsToday   int
}

// LoadActivitySettings returns the stored settings (ok false: none yet).
func (s *Store) LoadActivitySettings(ctx context.Context) (ActivitySettings, bool, error) {
	var a ActivitySettings
	err := s.db.QueryRowContext(ctx, `SELECT model_enabled, threshold, margin, daily_cap, calls_day, calls_today
		FROM activity_settings WHERE id = 1`).Scan(&a.ModelEnabled, &a.Threshold, &a.Margin, &a.DailyCap, &a.CallsDay, &a.CallsToday)
	if errors.Is(err, sql.ErrNoRows) {
		return a, false, nil
	}
	return a, err == nil, err
}

// SaveActivitySettings stores the settings, not the call count (the count
// too only when no row is stored yet): a count saved meanwhile stays.
func (s *Store) SaveActivitySettings(ctx context.Context, a ActivitySettings) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO activity_settings (id, model_enabled, threshold, margin, daily_cap, calls_day,
		calls_today, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET model_enabled = excluded.model_enabled, threshold = excluded.threshold,
		margin = excluded.margin, daily_cap = excluded.daily_cap, updated_at = excluded.updated_at`,
		a.ModelEnabled, a.Threshold, a.Margin, a.DailyCap, a.CallsDay, a.CallsToday, s.ts())
	return err
}

// SaveActivityCalls stores the call count, not the settings (they too only
// when no row is stored yet): settings saved meanwhile stay.
func (s *Store) SaveActivityCalls(ctx context.Context, a ActivitySettings) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO activity_settings (id, model_enabled, threshold, margin, daily_cap, calls_day,
		calls_today, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET calls_day = excluded.calls_day, calls_today = excluded.calls_today,
		updated_at = excluded.updated_at`,
		a.ModelEnabled, a.Threshold, a.Margin, a.DailyCap, a.CallsDay, a.CallsToday, s.ts())
	return err
}

// ActivityAnswer is the model's answer for one normalised command.
type ActivityAnswer struct {
	Key, Kind string
}

// ActivityCache returns the newest answers, newest first.
func (s *Store) ActivityCache(ctx context.Context, limit int) ([]ActivityAnswer, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT key, kind FROM activity_cache ORDER BY rowid DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ActivityAnswer
	for rows.Next() {
		var a ActivityAnswer
		if err := rows.Scan(&a.Key, &a.Kind); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// SaveActivityAnswer records an answer and forgets all but the newest limit.
func (s *Store) SaveActivityAnswer(ctx context.Context, a ActivityAnswer, limit int) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	// Deleted and inserted again: the newest row is the newest answer.
	if _, err := tx.ExecContext(ctx, `DELETE FROM activity_cache WHERE key = ?`, a.Key); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO activity_cache (key, kind, used_at) VALUES (?, ?, ?)`, a.Key, a.Kind, s.ts()); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM activity_cache WHERE rowid NOT IN
		(SELECT rowid FROM activity_cache ORDER BY rowid DESC LIMIT ?)`, limit); err != nil {
		return err
	}
	return tx.Commit()
}
