package store

// #219: the restart marker of a pending handoff hire. The hire itself (its
// task, its secrets review, the desk it holds) lives only in the bridge's
// memory; the agent request or LLM job it follows keeps a small marker
// (where it was to hire and for whom, never the task, a secret or review
// data) from its insert until the hire ended, so a bridge that restarts
// meanwhile can say the hire was interrupted. It never hires for it.

import (
	"context"
	"database/sql"
	"encoding/json"
)

// migrationHandoffHire adds the marker column to both tables ("": none, or
// the hire ended).
const migrationHandoffHire = `ALTER TABLE handoff_request ADD COLUMN hire TEXT NOT NULL DEFAULT '';
	ALTER TABLE handoff_llm_job ADD COLUMN hire TEXT NOT NULL DEFAULT '';`

// HandoffHireMarker is what a pending handoff hire keeps in the store: the
// target floor and desk, the label, harness, model and effort asked for,
// the client's origin, the source worker's name, whether the source goes
// home after it, and when it was accepted (unix ms).
type HandoffHireMarker struct {
	Floor      string `json:"floor"`
	Desk       int    `json:"desk"`
	Label      string `json:"label,omitempty"`
	Harness    string `json:"harness"`
	Model      string `json:"model"`
	Effort     string `json:"effort"`
	Origin     string `json:"origin,omitempty"`
	WorkerName string `json:"worker_name"`
	SendHome   bool   `json:"send_home,omitempty"`
	StartedAt  int64  `json:"started_at"`
}

// Modes of a marked row (HandoffHireRow.Mode).
const (
	HandoffHireAgent = "agent"
	HandoffHireLLM   = "llm"
)

// HandoffHireRow is a request or job whose hire had not ended: its op,
// mode, source worker, its own state and the handoff it was filed as (0:
// none yet), and the marker.
type HandoffHireRow struct {
	Op, Mode, WorkerID, State string
	HandoffID                 int64
	Marker                    HandoffHireMarker
}

func markerText(m *HandoffHireMarker) string {
	if m == nil {
		return ""
	}
	b, _ := json.Marshal(m)
	return string(b)
}

func markerOf(s string) *HandoffHireMarker {
	if s == "" {
		return nil
	}
	var m HandoffHireMarker
	if json.Unmarshal([]byte(s), &m) != nil {
		return &HandoffHireMarker{}
	}
	return &m
}

// HandoffHireRows are the requests and jobs still marked, oldest first.
func (s *Store) HandoffHireRows(ctx context.Context) ([]HandoffHireRow, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT op, 'agent', worker_uuid, state, handoff_id, hire, created_at FROM handoff_request WHERE hire != ''
		UNION ALL SELECT op, 'llm', worker_uuid, state, handoff_id, hire, created_at FROM handoff_llm_job WHERE hire != ''
		ORDER BY 7, 1`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []HandoffHireRow
	for rows.Next() {
		var r HandoffHireRow
		var id sql.NullInt64
		var marker string
		var at int64
		if err := rows.Scan(&r.Op, &r.Mode, &r.WorkerID, &r.State, &id, &marker, &at); err != nil {
			return nil, err
		}
		r.HandoffID = id.Int64
		if m := markerOf(marker); m != nil {
			r.Marker = *m
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ClearHandoffHire drops op's marker (its hire ended), on whichever table
// has it.
func (s *Store) ClearHandoffHire(ctx context.Context, op string) error {
	if _, err := s.db.ExecContext(ctx, `UPDATE handoff_request SET hire = '' WHERE op = ? AND hire != ''`, op); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `UPDATE handoff_llm_job SET hire = '' WHERE op = ? AND hire != ''`, op)
	return err
}
