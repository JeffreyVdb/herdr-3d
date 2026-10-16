package store

// #11: the notifications' settings (one row): the switch, which events
// notify, quiet and the freelancers' done. The bot token and the paired
// person are not here: they are the Telegram channel's own 0600 file.
// #13: the replies' switch, and which worker each sent notification was
// about (a reply to it is typed into that worker).

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
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

// migrationNotifyReplies adds the replies' switch (off) and the sent
// notifications: the provider's chat and message id, the worker, when
// (unix ms).
const migrationNotifyReplies = `ALTER TABLE notify_settings ADD COLUMN replies INTEGER NOT NULL DEFAULT 0;
	CREATE TABLE notify_message (
		chat       INTEGER NOT NULL,
		message    INTEGER NOT NULL CHECK (message <> 0),
		worker     TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		PRIMARY KEY (chat, message)
	);
	CREATE INDEX notify_message_created ON notify_message (created_at);`

// The sent notifications kept for replies: the newest NotifyMessagesKept,
// none older than NotifyMessageAge before the newest.
const (
	NotifyMessagesKept = 500
	NotifyMessageAge   = 7 * 24 * time.Hour
)

// NotifySettings are the notifications' settings.
type NotifySettings struct {
	Enabled, NeedsYou, Done, Quiet, Freelancers, Replies bool
}

// LoadNotifySettings returns the stored settings (ok false: none yet).
func (s *Store) LoadNotifySettings(ctx context.Context) (NotifySettings, bool, error) {
	var n NotifySettings
	err := s.db.QueryRowContext(ctx, `SELECT enabled, needs_you, done, quiet, freelancers, replies FROM notify_settings WHERE id = 1`).
		Scan(&n.Enabled, &n.NeedsYou, &n.Done, &n.Quiet, &n.Freelancers, &n.Replies)
	if errors.Is(err, sql.ErrNoRows) {
		return n, false, nil
	}
	return n, err == nil, err
}

// SaveNotifySettings stores the settings.
func (s *Store) SaveNotifySettings(ctx context.Context, n NotifySettings) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO notify_settings (id, enabled, needs_you, done, quiet, freelancers, replies, updated_at)
		VALUES (1, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, needs_you = excluded.needs_you, done = excluded.done,
		quiet = excluded.quiet, freelancers = excluded.freelancers, replies = excluded.replies, updated_at = excluded.updated_at`,
		n.Enabled, n.NeedsYou, n.Done, n.Quiet, n.Freelancers, n.Replies, s.ts())
	return err
}

// SaveNotifyMessage remembers that message in chat was a notification
// about worker, sent at at, and forgets what is past the bounds.
func (s *Store) SaveNotifyMessage(ctx context.Context, chat, message int64, worker string, at time.Time) error {
	if message == 0 {
		return fmt.Errorf("%w: no message id", ErrInvalid)
	}
	return s.tx(ctx, func(tx *sql.Tx) error {
		ms := at.UnixMilli()
		if _, err := tx.ExecContext(ctx, `INSERT INTO notify_message (chat, message, worker, created_at) VALUES (?, ?, ?, ?)
			ON CONFLICT(chat, message) DO UPDATE SET worker = excluded.worker, created_at = excluded.created_at`,
			chat, message, worker, ms); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM notify_message WHERE created_at < ?`, ms-NotifyMessageAge.Milliseconds()); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `DELETE FROM notify_message WHERE rowid NOT IN
			(SELECT rowid FROM notify_message ORDER BY created_at DESC, rowid DESC LIMIT ?)`, NotifyMessagesKept)
		return err
	})
}

// NotifyMessage is the worker message in chat was a notification about,
// and when it was sent (ok false: not one, or forgotten).
func (s *Store) NotifyMessage(ctx context.Context, chat, message int64) (string, time.Time, bool, error) {
	var worker string
	var ms int64
	err := s.db.QueryRowContext(ctx, `SELECT worker, created_at FROM notify_message WHERE chat = ? AND message = ?`, chat, message).
		Scan(&worker, &ms)
	if errors.Is(err, sql.ErrNoRows) {
		return "", time.Time{}, false, nil
	}
	if err != nil {
		return "", time.Time{}, false, err
	}
	return worker, time.UnixMilli(ms).UTC(), true, nil
}

// NotifyMessageCount is how many sent notifications are kept.
func (s *Store) NotifyMessageCount(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM notify_message`).Scan(&n)
	return n, err
}
