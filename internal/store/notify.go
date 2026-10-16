package store

// #11: the notifications' settings (one row): the switch, which events
// notify, quiet and the freelancers' done. The bot token and the paired
// person are not here: they are the Telegram channel's own 0600 file.

import (
	"context"
	"database/sql"
	"errors"
)

// migrationNotify creates notify_settings (one row).
const migrationNotify = `CREATE TABLE notify_settings (
		id          INTEGER PRIMARY KEY CHECK (id = 1),
		enabled     INTEGER NOT NULL,
		needs_you   INTEGER NOT NULL,
		done        INTEGER NOT NULL,
		quiet       INTEGER NOT NULL,
		freelancers INTEGER NOT NULL,
		updated_at  TEXT NOT NULL
	);`

// NotifySettings are the notifications' settings.
type NotifySettings struct {
	Enabled, NeedsYou, Done, Quiet, Freelancers bool
}

// LoadNotifySettings returns the stored settings (ok false: none yet).
func (s *Store) LoadNotifySettings(ctx context.Context) (NotifySettings, bool, error) {
	var n NotifySettings
	err := s.db.QueryRowContext(ctx, `SELECT enabled, needs_you, done, quiet, freelancers FROM notify_settings WHERE id = 1`).
		Scan(&n.Enabled, &n.NeedsYou, &n.Done, &n.Quiet, &n.Freelancers)
	if errors.Is(err, sql.ErrNoRows) {
		return n, false, nil
	}
	return n, err == nil, err
}

// SaveNotifySettings stores the settings.
func (s *Store) SaveNotifySettings(ctx context.Context, n NotifySettings) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO notify_settings (id, enabled, needs_you, done, quiet, freelancers, updated_at)
		VALUES (1, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, needs_you = excluded.needs_you, done = excluded.done,
		quiet = excluded.quiet, freelancers = excluded.freelancers, updated_at = excluded.updated_at`,
		n.Enabled, n.NeedsYou, n.Done, n.Quiet, n.Freelancers, s.ts())
	return err
}
