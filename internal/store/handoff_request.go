package store

// #224: agent handoff requests. A worker's agent is asked, through its own
// handoff skill, to write a handoff to a path the bridge reserved; the
// request is kept here from before the prompt is sent until it is filed or
// failed, so a retry of its op never prompts twice, a restart resumes the
// watch, and an agent-written file is never filed without its row.

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

// migrationHandoffRequest creates handoff_request: one row per operation
// (op), at most one pending per worker. transcript and transcript_offset
// are where the bridge's prompt is read from (-1: not taken yet); path is
// the reserved file the agent writes; handoff_id the handoff it was filed
// as.
const migrationHandoffRequest = `CREATE TABLE handoff_request (
		op                TEXT PRIMARY KEY,
		worker_uuid       TEXT NOT NULL REFERENCES worker(id) ON DELETE CASCADE,
		floor             TEXT NOT NULL,
		harness           TEXT NOT NULL CHECK (harness IN ('claude', 'codex')),
		agent_session     TEXT NOT NULL DEFAULT '',
		transcript        TEXT NOT NULL DEFAULT '',
		transcript_offset INTEGER NOT NULL DEFAULT -1 CHECK (transcript_offset >= -1),
		path              TEXT NOT NULL UNIQUE,
		nonce             TEXT NOT NULL,
		instruction       TEXT NOT NULL DEFAULT '',
		send_home         INTEGER NOT NULL DEFAULT 0 CHECK (send_home IN (0, 1)),
		state             TEXT NOT NULL CHECK (state IN ('pending', 'filed', 'failed')),
		reason            TEXT NOT NULL DEFAULT '',
		handoff_id        INTEGER,
		created_at        INTEGER NOT NULL,
		updated_at        TEXT NOT NULL
	);
	CREATE UNIQUE INDEX handoff_request_pending ON handoff_request (worker_uuid) WHERE state = 'pending';`

// Handoff request states.
const (
	HandoffRequestPending = "pending"
	HandoffRequestFiled   = "filed"
	HandoffRequestFailed  = "failed"
)

// ErrRequestTaken: the op has a row already, or the worker a pending one.
var ErrRequestTaken = errors.New("a handoff request with that op, or a pending one of that worker, exists")

// HandoffRequest is a stored agent handoff request.
type HandoffRequest struct {
	Op, WorkerID, Floor, Harness, AgentSession string
	Transcript                                 string
	Offset                                     int64 // -1: not taken yet
	Path, Nonce, Instruction                   string
	SendHome                                   bool
	State, Reason                              string
	HandoffID                                  int64 // 0: none
	CreatedAt                                  int64 // unix ms
	// Hire (#219) is the marker of the hire that follows its filing (nil:
	// none; it says how the hire ended once it did).
	Hire *HandoffHireMarker
}

const handoffRequestCols = `op, worker_uuid, floor, harness, agent_session, transcript, transcript_offset, path, nonce,
	instruction, send_home, state, reason, handoff_id, created_at, hire`

func scanHandoffRequest(sc interface{ Scan(...any) error }) (HandoffRequest, error) {
	var r HandoffRequest
	var id sql.NullInt64
	var hire string
	err := sc.Scan(&r.Op, &r.WorkerID, &r.Floor, &r.Harness, &r.AgentSession, &r.Transcript, &r.Offset, &r.Path, &r.Nonce,
		&r.Instruction, &r.SendHome, &r.State, &r.Reason, &id, &r.CreatedAt, &hire)
	r.HandoffID, r.Hire = id.Int64, markerOf(hire)
	return r, err
}

// AddHandoffRequest stores a new request: ErrRequestTaken when its op has a
// row, or its worker a pending one.
func (s *Store) AddHandoffRequest(ctx context.Context, r HandoffRequest) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO handoff_request (`+handoffRequestCols+`, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.Op, r.WorkerID, r.Floor, r.Harness, r.AgentSession, r.Transcript, r.Offset, r.Path, r.Nonce, r.Instruction, r.SendHome,
		r.State, r.Reason, nullID(r.HandoffID), r.CreatedAt, markerText(r.Hire), s.ts())
	if err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed") {
		return ErrRequestTaken
	}
	return err
}

// UpdateHandoffRequest records a request's transcript, offset, state,
// reason and handoff (by op).
func (s *Store) UpdateHandoffRequest(ctx context.Context, r HandoffRequest) error {
	res, err := s.db.ExecContext(ctx, `UPDATE handoff_request SET transcript = ?, transcript_offset = ?, state = ?, reason = ?,
		handoff_id = ?, updated_at = ? WHERE op = ?`, r.Transcript, r.Offset, r.State, r.Reason, nullID(r.HandoffID), s.ts(), r.Op)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			return ErrRequestTaken
		}
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// HandoffRequestByOp is the request of op.
func (s *Store) HandoffRequestByOp(ctx context.Context, op string) (HandoffRequest, error) {
	r, err := scanHandoffRequest(s.db.QueryRowContext(ctx, `SELECT `+handoffRequestCols+` FROM handoff_request WHERE op = ?`, op))
	if errors.Is(err, sql.ErrNoRows) {
		return HandoffRequest{}, ErrNotFound
	}
	return r, err
}

// HandoffRequests are the requests in state (oldest first).
func (s *Store) HandoffRequests(ctx context.Context, state string) ([]HandoffRequest, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+handoffRequestCols+` FROM handoff_request WHERE state = ?
		ORDER BY created_at, op`, state)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []HandoffRequest
	for rows.Next() {
		r, err := scanHandoffRequest(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// PruneHandoffRequests forgets the settled (filed or failed) requests
// created before ms; a pending one stays.
func (s *Store) PruneHandoffRequests(ctx context.Context, before int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM handoff_request WHERE state != 'pending' AND created_at < ?`, before)
	return err
}

func nullID(id int64) any {
	if id == 0 {
		return nil
	}
	return id
}
