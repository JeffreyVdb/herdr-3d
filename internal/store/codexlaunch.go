package store

// #155: the shared Codex server switch (bridge-wide) and how each Codex
// worker the bridge hired was launched. A worker keeps the mode it was
// launched with: switching never migrates, interrupts or relaunches it. A
// shared-server worker's record is what the bridge owns of it: its launch
// files and token (the processes it may stop), its server process and the
// thread it last saw Herdr report, which survives the TUI's exit (Herdr
// forgets the id then) and is what a wake resumes.

import (
	"context"
	"database/sql"
	"errors"
)

// migrationCodexLaunch creates codex_server_settings (one row) and
// codex_launch. No foreign key: the row is written during the hire, before
// herdr's workspace is seen (and the worker row exists).
const migrationCodexLaunch = `CREATE TABLE codex_server_settings (
		id         INTEGER PRIMARY KEY CHECK (id = 1),
		enabled    INTEGER NOT NULL,
		updated_at TEXT NOT NULL
	);
	CREATE TABLE codex_launch (
		worker_uuid  TEXT PRIMARY KEY,
		session_name TEXT NOT NULL,
		mode         TEXT NOT NULL CHECK (mode IN ('shared', 'legacy')),
		note         TEXT NOT NULL DEFAULT '',
		agent_name   TEXT NOT NULL DEFAULT '',
		cwd          TEXT NOT NULL DEFAULT '',
		model        TEXT NOT NULL DEFAULT '',
		effort       TEXT NOT NULL DEFAULT '',
		run_dir      TEXT NOT NULL DEFAULT '',
		name         TEXT NOT NULL DEFAULT '',
		token        TEXT NOT NULL DEFAULT '',
		server_pid   INTEGER NOT NULL DEFAULT 0,
		server_start INTEGER NOT NULL DEFAULT 0,
		thread_id    TEXT NOT NULL DEFAULT '',
		created_at   TEXT NOT NULL,
		updated_at   TEXT NOT NULL
	);`

// LoadCodexServerSettings returns whether new Codex workers get their own
// shared app-server (ok false: never set, the default is off).
func (s *Store) LoadCodexServerSettings(ctx context.Context) (enabled, ok bool, err error) {
	err = s.db.QueryRowContext(ctx, `SELECT enabled FROM codex_server_settings WHERE id = 1`).Scan(&enabled)
	if errors.Is(err, sql.ErrNoRows) {
		return false, false, nil
	}
	return enabled, err == nil, err
}

// SaveCodexServerSettings stores the switch.
func (s *Store) SaveCodexServerSettings(ctx context.Context, enabled bool) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO codex_server_settings (id, enabled, updated_at) VALUES (1, ?, ?)
		ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`, enabled, s.ts())
	return err
}

// Codex launch modes.
const (
	CodexShared = "shared"
	CodexLegacy = "legacy"
)

// CodexLaunch is how the bridge launched a Codex worker.
type CodexLaunch struct {
	WorkerID, Session string
	Mode              string // CodexShared or CodexLegacy
	// Note says why a worker asked for shared runs legacy, or what last
	// went wrong with its server.
	Note string
	// AgentName, Cwd, Model and Effort relaunch it.
	AgentName, Cwd, Model, Effort string
	// RunDir, Name and Token are its launch files' directory and name and
	// its processes' marker (codexapp.Launch).
	RunDir, Name, Token string
	// ServerPID and ServerStart identify its running app-server (0: none).
	ServerPID   int
	ServerStart uint64
	// Thread is the thread Herdr last reported for its pane.
	Thread string
}

// RecordCodexLaunch stores (or replaces) a worker's launch.
func (s *Store) RecordCodexLaunch(ctx context.Context, l CodexLaunch) error {
	now := s.ts()
	_, err := s.db.ExecContext(ctx, `INSERT INTO codex_launch (worker_uuid, session_name, mode, note, agent_name, cwd,
		model, effort, run_dir, name, token, server_pid, server_start, thread_id, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(worker_uuid) DO UPDATE SET session_name = excluded.session_name, mode = excluded.mode,
			note = excluded.note, agent_name = excluded.agent_name, cwd = excluded.cwd, model = excluded.model,
			effort = excluded.effort, run_dir = excluded.run_dir, name = excluded.name, token = excluded.token,
			server_pid = excluded.server_pid, server_start = excluded.server_start, thread_id = excluded.thread_id,
			updated_at = excluded.updated_at`,
		l.WorkerID, l.Session, l.Mode, l.Note, l.AgentName, l.Cwd, l.Model, l.Effort, l.RunDir, l.Name, l.Token,
		l.ServerPID, int64(l.ServerStart), l.Thread, now, now)
	return err
}

// CodexLaunches returns every recorded launch, by worker id.
func (s *Store) CodexLaunches(ctx context.Context) (map[string]CodexLaunch, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT worker_uuid, session_name, mode, note, agent_name, cwd, model, effort,
		run_dir, name, token, server_pid, server_start, thread_id FROM codex_launch`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]CodexLaunch{}
	for rows.Next() {
		var l CodexLaunch
		var start int64
		if err := rows.Scan(&l.WorkerID, &l.Session, &l.Mode, &l.Note, &l.AgentName, &l.Cwd, &l.Model, &l.Effort,
			&l.RunDir, &l.Name, &l.Token, &l.ServerPID, &start, &l.Thread); err != nil {
			return nil, err
		}
		l.ServerStart = uint64(start)
		out[l.WorkerID] = l
	}
	return out, rows.Err()
}

// ForgetCodexLaunch drops a worker's launch (it was sent home).
func (s *Store) ForgetCodexLaunch(ctx context.Context, workerID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM codex_launch WHERE worker_uuid = ?`, workerID)
	return err
}
