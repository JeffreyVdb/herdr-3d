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

// CodexServerSettings are the bridge-wide launch and compatibility preferences.
type CodexServerSettings struct {
	Enabled, AllowUnverified bool
}

const migrationCodexVersionPolicy = `ALTER TABLE codex_server_settings ADD COLUMN allow_unverified INTEGER NOT NULL DEFAULT 0;`

// LoadCodexServerSettings returns the preferences (ok false: never set).
func (s *Store) LoadCodexServerSettings(ctx context.Context) (settings CodexServerSettings, ok bool, err error) {
	err = s.db.QueryRowContext(ctx, `SELECT enabled, allow_unverified FROM codex_server_settings WHERE id = 1`).Scan(&settings.Enabled, &settings.AllowUnverified)
	if errors.Is(err, sql.ErrNoRows) {
		return CodexServerSettings{}, false, nil
	}
	return settings, err == nil, err
}

// SaveCodexServerSettings stores both preferences atomically.
func (s *Store) SaveCodexServerSettings(ctx context.Context, settings CodexServerSettings) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO codex_server_settings (id, enabled, allow_unverified, updated_at) VALUES (1, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, allow_unverified = excluded.allow_unverified, updated_at = excluded.updated_at`, settings.Enabled, settings.AllowUnverified, s.ts())
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

// migrationCodexAsyncSend creates codex_async_send (#158): the bridge's
// answers to a shared worker's async questions that Codex accepted (or may
// have) and that are not answered yet, one row per question. Codex keeps a
// steered input queued in the running turn until its next model request,
// where the thread's history does not show it, so a restarted bridge reads
// these to refuse a second answer while the first may still be delivered.
const migrationCodexAsyncSend = `CREATE TABLE codex_async_send (
		worker_uuid    TEXT NOT NULL,
		thread_id      TEXT NOT NULL,
		batch_id       TEXT NOT NULL,
		question_index INTEGER NOT NULL,
		client_id      TEXT NOT NULL,
		turn_id        TEXT NOT NULL DEFAULT '',
		confirmed      INTEGER NOT NULL DEFAULT 0,
		unconfirmed    INTEGER NOT NULL DEFAULT 0,
		created_at     TEXT NOT NULL,
		PRIMARY KEY (worker_uuid, batch_id, question_index)
	);`

// CodexAsyncSend is one question of an answer the bridge sent a shared
// worker (#158): recorded before the request goes out, then updated with
// the server's response.
type CodexAsyncSend struct {
	WorkerID, Thread, Batch string
	Index                   int
	// ClientID is the clientUserMessageId the answer carries.
	ClientID string
	// Turn is the turn it was steered into ("" for a turn it starts) until
	// the server responds, then the turn it reached.
	Turn string
	// Confirmed: the server accepted it (Turn is the turn it reached).
	// Unconfirmed: no response came, whether it took it is unknown.
	Confirmed, Unconfirmed bool
}

// RecordCodexAsyncSends stores (or replaces: a question's latest answer is
// the one that counts) the questions of one answer.
func (s *Store) RecordCodexAsyncSends(ctx context.Context, sends []CodexAsyncSend) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	now := s.ts()
	for _, x := range sends {
		if _, err := tx.ExecContext(ctx, `INSERT INTO codex_async_send (worker_uuid, thread_id, batch_id, question_index,
			client_id, turn_id, confirmed, unconfirmed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(worker_uuid, batch_id, question_index) DO UPDATE SET thread_id = excluded.thread_id,
				client_id = excluded.client_id, turn_id = excluded.turn_id, confirmed = excluded.confirmed,
				unconfirmed = excluded.unconfirmed, created_at = excluded.created_at`,
			x.WorkerID, x.Thread, x.Batch, x.Index, x.ClientID, x.Turn, x.Confirmed, x.Unconfirmed, now); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// CodexAsyncSends returns every recorded send, by worker id.
func (s *Store) CodexAsyncSends(ctx context.Context) (map[string][]CodexAsyncSend, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT worker_uuid, thread_id, batch_id, question_index, client_id, turn_id,
		confirmed, unconfirmed FROM codex_async_send ORDER BY worker_uuid, batch_id, question_index`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]CodexAsyncSend{}
	for rows.Next() {
		var x CodexAsyncSend
		if err := rows.Scan(&x.WorkerID, &x.Thread, &x.Batch, &x.Index, &x.ClientID, &x.Turn, &x.Confirmed,
			&x.Unconfirmed); err != nil {
			return nil, err
		}
		out[x.WorkerID] = append(out[x.WorkerID], x)
	}
	return out, rows.Err()
}

// ForgetCodexAsyncSend drops one question's send (answered, refused, or
// its batch is gone).
func (s *Store) ForgetCodexAsyncSend(ctx context.Context, workerID, batch string, index int) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM codex_async_send WHERE worker_uuid = ? AND batch_id = ? AND question_index = ?`,
		workerID, batch, index)
	return err
}

// ForgetCodexAsyncSends drops a worker's sends (its thread changed, or it
// was sent home).
func (s *Store) ForgetCodexAsyncSends(ctx context.Context, workerID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM codex_async_send WHERE worker_uuid = ?`, workerID)
	return err
}
