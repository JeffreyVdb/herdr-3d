package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

type ManualSource struct {
	Kind  string `json:"kind"`
	Key   string `json:"key,omitempty"`
	Index int    `json:"index"`
}
type ManualEffect struct {
	Kind           string `json:"kind"`
	Endpoint       string `json:"endpoint"`
	CleanupCommand string `json:"cleanup_command"`
	State          string `json:"state"`
}
type ManualProcess struct {
	ID          string         `json:"id"`
	Op          string         `json:"op"`
	Worker      string         `json:"worker"`
	WorkerName  string         `json:"worker_name"`
	Floor       string         `json:"floor"`
	Session     string         `json:"session"`
	WorkspaceID string         `json:"workspace_id"`
	TabID       string         `json:"tab_id"`
	PaneID      string         `json:"pane_id"`
	Host        string         `json:"host"`
	Cwd         string         `json:"cwd"`
	Command     string         `json:"command"`
	Launched    string         `json:"launched,omitempty"`
	Title       string         `json:"title"`
	Source      ManualSource   `json:"source"`
	State       string         `json:"state"`
	ExitCode    *int           `json:"exit_code,omitempty"`
	Error       string         `json:"error,omitempty"`
	Cleanup     string         `json:"cleanup"`
	CleanupNote string         `json:"cleanup_note,omitempty"`
	Effects     []ManualEffect `json:"effects,omitempty"`
	CreatedAt   int64          `json:"created_at"`
	StartedAt   int64          `json:"started_at"`
	EndedAt     int64          `json:"ended_at"`
}

const migrationManualProcess = `CREATE TABLE manual_process (
 id TEXT PRIMARY KEY, op TEXT NOT NULL UNIQUE, worker TEXT NOT NULL,
 created_at INTEGER NOT NULL, record TEXT NOT NULL, dismissed INTEGER NOT NULL DEFAULT 0
);`

// CreateManualProcess atomically reserves op, returning the existing record on retry.
func (s *Store) CreateManualProcess(ctx context.Context, p ManualProcess) (ManualProcess, bool, error) {
	b, err := json.Marshal(p)
	if err != nil {
		return p, false, err
	}
	result, err := s.db.ExecContext(ctx, `INSERT INTO manual_process(id, op, worker, created_at, record) VALUES (?, ?, ?, ?, ?) ON CONFLICT(op) DO NOTHING`, p.ID, p.Op, p.Worker, p.CreatedAt, string(b))
	if err != nil {
		return p, false, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return p, false, err
	}
	if n == 1 {
		return p, true, nil
	}
	var data string
	if err := s.db.QueryRowContext(ctx, `SELECT record FROM manual_process WHERE op = ?`, p.Op).Scan(&data); err != nil {
		return p, false, err
	}
	err = json.Unmarshal([]byte(data), &p)
	return p, false, err
}

func (s *Store) SaveManualProcess(ctx context.Context, p ManualProcess) error {
	b, err := json.Marshal(p)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `UPDATE manual_process SET record = ? WHERE id = ?`, string(b), p.ID)
	return err
}

func (s *Store) ManualProcess(ctx context.Context, id string) (ManualProcess, bool, error) {
	var p ManualProcess
	var data string
	err := s.db.QueryRowContext(ctx, `SELECT record FROM manual_process WHERE id = ?`, id).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return p, false, nil
	}
	if err != nil {
		return p, false, err
	}
	err = json.Unmarshal([]byte(data), &p)
	return p, err == nil, err
}

func (s *Store) DeleteManualProcess(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE manual_process SET dismissed = 1 WHERE id = ?`, id)
	return err
}

// KeptManualProcesses returns all actionable records and recent terminal history.
// openWorkers identifies the owners that still exist.
func (s *Store) KeptManualProcesses(ctx context.Context, openWorkers map[string]bool) ([]ManualProcess, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT record FROM manual_process WHERE dismissed = 0 ORDER BY created_at DESC, rowid DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ManualProcess{}
	counts := map[string]int{}
	gone := 0
	for rows.Next() {
		var data string
		var p ManualProcess
		if err := rows.Scan(&data); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(data), &p); err != nil {
			return nil, err
		}
		if !terminalManualProcess(p.State) || p.Cleanup == "needed" || p.Cleanup == "failed" {
			out = append(out, p)
			continue
		}
		if openWorkers[p.Worker] {
			if counts[p.Worker] < 20 {
				out = append(out, p)
			}
			counts[p.Worker]++
		} else {
			if gone < 20 {
				out = append(out, p)
			}
			gone++
		}
	}
	return out, rows.Err()
}

// ManualProcessByOp also finds dismissed records, preserving idempotency.
func (s *Store) ManualProcessByOp(ctx context.Context, op string) (ManualProcess, bool, error) {
	var p ManualProcess
	var data string
	err := s.db.QueryRowContext(ctx, `SELECT record FROM manual_process WHERE op = ?`, op).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return p, false, nil
	}
	if err != nil {
		return p, false, err
	}
	err = json.Unmarshal([]byte(data), &p)
	return p, err == nil, err
}

// AllManualProcesses loads every visible record for in-memory reconciliation.
func (s *Store) AllManualProcesses(ctx context.Context) ([]ManualProcess, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT record FROM manual_process WHERE dismissed = 0 ORDER BY created_at DESC, rowid DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ManualProcess
	for rows.Next() {
		var data string
		var p ManualProcess
		if err := rows.Scan(&data); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(data), &p); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func terminalManualProcess(state string) bool {
	return state == "exited" || state == "stopped" || state == "failed"
}
