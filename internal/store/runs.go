package store

// M6 runs: what the bridge remembers of a worker's write-code run.

import (
	"context"
	"database/sql"
)

// WorkerRun is an orchestrator's last known phase and pass (Pass nil:
// unknown).
type WorkerRun struct {
	Phase string
	Pass  *int
}

// WorkerRuns returns the remembered runs of a session's stored workers, by
// worker id.
func (s *Store) WorkerRuns(ctx context.Context, session string) (map[string]WorkerRun, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT r.worker_uuid, r.phase, r.pass FROM worker_run r
		JOIN worker w ON w.id = r.worker_uuid WHERE w.session_name = ?`, session)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]WorkerRun{}
	for rows.Next() {
		var id string
		var r WorkerRun
		var pass sql.NullInt64
		if err := rows.Scan(&id, &r.Phase, &pass); err != nil {
			return nil, err
		}
		if pass.Valid {
			n := int(pass.Int64)
			r.Pass = &n
		}
		out[id] = r
	}
	return out, rows.Err()
}

// SetWorkerRun records a stored worker's phase and pass.
func (s *Store) SetWorkerRun(ctx context.Context, workerID string, r WorkerRun) error {
	var pass sql.NullInt64
	if r.Pass != nil {
		pass = sql.NullInt64{Int64: int64(*r.Pass), Valid: true}
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO worker_run (worker_uuid, phase, pass, updated_at) VALUES (?, ?, ?, ?)
		ON CONFLICT(worker_uuid) DO UPDATE SET phase = excluded.phase, pass = excluded.pass, updated_at = excluded.updated_at`,
		workerID, r.Phase, pass, s.ts())
	return err
}
