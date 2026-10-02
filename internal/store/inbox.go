package store

// #106: dismissed inbox rows. A finished worker's row is hidden until its
// next working → done; the dismissal is the worker's status_since at the
// time and holds while the worker's current status_since is the same one.

import (
	"context"
)

// migrationInbox creates inbox_dismissed: one dismissal per worker.
const migrationInbox = `CREATE TABLE inbox_dismissed (
		worker_uuid  TEXT PRIMARY KEY REFERENCES worker(id) ON DELETE CASCADE,
		status_since INTEGER NOT NULL,
		dismissed_at TEXT NOT NULL
	);`

// InboxDismissed returns every dismissal: worker id → the status_since of
// the done episode it hides.
func (s *Store) InboxDismissed(ctx context.Context) (map[string]int64, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT worker_uuid, status_since FROM inbox_dismissed`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int64{}
	for rows.Next() {
		var id string
		var since int64
		if err := rows.Scan(&id, &since); err != nil {
			return nil, err
		}
		out[id] = since
	}
	return out, rows.Err()
}

// DismissInbox records that a worker's done episode (its status_since) was
// dismissed, replacing an older one. The worker must be stored.
func (s *Store) DismissInbox(ctx context.Context, workerID string, statusSince int64) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO inbox_dismissed (worker_uuid, status_since, dismissed_at) VALUES (?, ?, ?)
		ON CONFLICT(worker_uuid) DO UPDATE SET status_since = excluded.status_since, dismissed_at = excluded.dismissed_at`,
		workerID, statusSince, s.ts())
	return err
}

// ForgetInboxDismissed removes a worker's dismissal.
func (s *Store) ForgetInboxDismissed(ctx context.Context, workerID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM inbox_dismissed WHERE worker_uuid = ?`, workerID)
	return err
}

// PruneInboxDismissed removes the dismissals the stored workers no longer
// match: a worker that is not done, or done since another moment. It
// returns the worker ids it removed.
func (s *Store) PruneInboxDismissed(ctx context.Context) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `DELETE FROM inbox_dismissed WHERE NOT EXISTS (
			SELECT 1 FROM worker w WHERE w.id = inbox_dismissed.worker_uuid AND w.status = 'done'
				AND w.status_since = inbox_dismissed.status_since)
		RETURNING worker_uuid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}
