package store

// #83: armed wrap-ups, so a bridge restart resumes the watch from the
// transcript offset it was armed at instead of forgetting it (or firing
// without a verdict).

import (
	"context"
)

// migrationWrapUp creates worker_wrapup: one wrap-up per worker. transcript
// is the agent session (harness/id) the offset is in; state is armed or
// needs_you.
const migrationWrapUp = `CREATE TABLE worker_wrapup (
		worker_uuid       TEXT PRIMARY KEY REFERENCES worker(id) ON DELETE CASCADE,
		session_name      TEXT NOT NULL,
		nonce             TEXT NOT NULL,
		worktree          TEXT NOT NULL CHECK (worktree IN ('keep', 'delete', 'delete_branch')),
		armed_at          INTEGER NOT NULL,
		transcript        TEXT NOT NULL,
		transcript_offset INTEGER NOT NULL CHECK (transcript_offset >= 0),
		state             TEXT NOT NULL CHECK (state IN ('armed', 'needs_you')),
		reason            TEXT NOT NULL DEFAULT '',
		updated_at        TEXT NOT NULL
	);`

// WrapUp is a stored wrap-up.
type WrapUp struct {
	WorkerID   string
	Session    string
	Nonce      string
	Worktree   string
	ArmedAt    int64 // unix ms
	Transcript string
	Offset     int64
	State      string
	Reason     string
}

// WrapUps returns every stored wrap-up.
func (s *Store) WrapUps(ctx context.Context) ([]WrapUp, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT worker_uuid, session_name, nonce, worktree, armed_at, transcript,
		transcript_offset, state, reason FROM worker_wrapup ORDER BY worker_uuid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []WrapUp
	for rows.Next() {
		var w WrapUp
		if err := rows.Scan(&w.WorkerID, &w.Session, &w.Nonce, &w.Worktree, &w.ArmedAt, &w.Transcript, &w.Offset, &w.State,
			&w.Reason); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

// SetWrapUp records a worker's wrap-up, replacing the one it had.
func (s *Store) SetWrapUp(ctx context.Context, w WrapUp) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO worker_wrapup (worker_uuid, session_name, nonce, worktree, armed_at, transcript,
			transcript_offset, state, reason, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(worker_uuid) DO UPDATE SET session_name = excluded.session_name, nonce = excluded.nonce,
			worktree = excluded.worktree, armed_at = excluded.armed_at, transcript = excluded.transcript,
			transcript_offset = excluded.transcript_offset, state = excluded.state, reason = excluded.reason,
			updated_at = excluded.updated_at`,
		w.WorkerID, w.Session, w.Nonce, w.Worktree, w.ArmedAt, w.Transcript, w.Offset, w.State, w.Reason, s.ts())
	return err
}

// DeleteWrapUp forgets a worker's wrap-up.
func (s *Store) DeleteWrapUp(ctx context.Context, workerID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM worker_wrapup WHERE worker_uuid = ?`, workerID)
	return err
}
