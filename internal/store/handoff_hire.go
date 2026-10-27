package store

// #219: the restart marker of a pending handoff hire. The hire itself (its
// task, its secrets review, the desk it holds) lives only in the bridge's
// memory; the agent request or LLM job it follows keeps a small marker
// (where it was to hire and for whom, never the task, a secret or review
// data) from its insert on, so a bridge that restarts meanwhile can say
// the hire was interrupted. It never hires for it. When the hire ends the
// marker says how (state, code, reason) and stays: the request had a hire
// (a resumed one sends nobody home on its own), and a replay of its op is
// compared with it.

import (
	"context"
	"database/sql"
	"encoding/json"
)

// migrationHandoffHire adds the marker column to both tables ("": none).
const migrationHandoffHire = `ALTER TABLE handoff_request ADD COLUMN hire TEXT NOT NULL DEFAULT '';
	ALTER TABLE handoff_llm_job ADD COLUMN hire TEXT NOT NULL DEFAULT '';`

// HandoffHireMarker is what a pending handoff hire keeps in the store: the
// target floor and desk, the label, harness, model and effort asked for,
// the client's origin, the source worker's name, whether the source goes
// home after it, when it was accepted (unix ms), the pending owners of its
// task's protected files (ids: a restart releases them); once it ended,
// its state, code and reason (the record's), and no owner.
type HandoffHireMarker struct {
	Floor      string   `json:"floor"`
	Desk       int      `json:"desk"`
	Label      string   `json:"label,omitempty"`
	Harness    string   `json:"harness"`
	Model      string   `json:"model"`
	Effort     string   `json:"effort"`
	Origin     string   `json:"origin,omitempty"`
	WorkerName string   `json:"worker_name"`
	SendHome   bool     `json:"send_home,omitempty"`
	StartedAt  int64    `json:"started_at"`
	Owners     []string `json:"owners,omitempty"`
	State      string   `json:"state,omitempty"`
	Code       string   `json:"code,omitempty"`
	Reason     string   `json:"reason,omitempty"`
}

// Ended reports whether the marker's hire ended.
func (m HandoffHireMarker) Ended() bool { return m.State != "" }

// Modes of a marked row (HandoffHireRow.Mode).
const (
	HandoffHireAgent = "agent"
	HandoffHireLLM   = "llm"
)

// HandoffHireRow is a request or job a restart publishes a hire for: its op,
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

// HandoffHireRows are the requests and jobs whose hire had not ended, and
// the pending agent requests whose hire ended (they resume), oldest first.
func (s *Store) HandoffHireRows(ctx context.Context) ([]HandoffHireRow, error) {
	const open = `hire != '' AND (CASE WHEN json_valid(hire) THEN json_extract(hire, '$.state') END) IS NULL`
	rows, err := s.db.QueryContext(ctx, `SELECT op, 'agent', worker_uuid, state, handoff_id, hire, created_at FROM handoff_request
		WHERE `+open+` OR (hire != '' AND state = ?)
		UNION ALL SELECT op, 'llm', worker_uuid, state, handoff_id, hire, created_at FROM handoff_llm_job WHERE `+open+`
		ORDER BY 7, 1`, HandoffRequestPending)
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

// EndHandoffHire replaces op's marker with m (its hire ended: m says how),
// on whichever table has one.
func (s *Store) EndHandoffHire(ctx context.Context, op string, m HandoffHireMarker) error {
	text := markerText(&m)
	if _, err := s.db.ExecContext(ctx, `UPDATE handoff_request SET hire = ? WHERE op = ? AND hire != ''`, text, op); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `UPDATE handoff_llm_job SET hire = ? WHERE op = ? AND hire != ''`, text, op)
	return err
}
