package store

// #9: LLM handoffs. The feature's settings (one row) and its jobs: one row
// per operation, from before the model is called until the handoff is filed
// or the job failed or was cancelled, so a repeated submit of an op never
// calls the model twice and a restart marks a job that was out as failed,
// never sending it again. A job keeps ids, a hash of its arguments, the
// LLM config's fingerprint (a hash), a short error code and message; never
// the transcript, the instruction, the document or a key.

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

// migrationHandoffLLM creates handoff_llm_settings and handoff_llm_job.
const migrationHandoffLLM = `CREATE TABLE handoff_llm_settings (
		id               INTEGER PRIMARY KEY CHECK (id = 1),
		enabled          INTEGER NOT NULL CHECK (enabled IN (0, 1)),
		input_bytes      INTEGER NOT NULL,
		max_tokens       INTEGER NOT NULL,
		reasoning_effort TEXT NOT NULL DEFAULT '',
		bound            TEXT NOT NULL DEFAULT '',
		updated_at       TEXT NOT NULL
	);
	CREATE TABLE handoff_llm_job (
		op             TEXT PRIMARY KEY,
		worker_uuid    TEXT NOT NULL,
		floor          TEXT NOT NULL,
		agent_session  TEXT NOT NULL DEFAULT '',
		candidate      TEXT NOT NULL,
		args_hash      TEXT NOT NULL,
		config         TEXT NOT NULL DEFAULT '',
		prompt_version TEXT NOT NULL,
		send_home      INTEGER NOT NULL DEFAULT 0 CHECK (send_home IN (0, 1)),
		state          TEXT NOT NULL CHECK (state IN ('queued', 'running', 'filed', 'failed', 'cancelled')),
		code           TEXT NOT NULL DEFAULT '',
		message        TEXT NOT NULL DEFAULT '',
		handoff_id     INTEGER,
		created_at     INTEGER NOT NULL,
		updated_at     INTEGER NOT NULL
	);
	CREATE INDEX handoff_llm_job_worker ON handoff_llm_job (worker_uuid, created_at);`

// HandoffLLMSettings are the feature's settings. Bound names the LLM config
// the switch was turned on for (a hash).
type HandoffLLMSettings struct {
	Enabled         bool
	InputBytes      int
	MaxTokens       int
	ReasoningEffort string
	Bound           string
}

// LoadHandoffLLMSettings returns the stored settings (ok false: none yet).
func (s *Store) LoadHandoffLLMSettings(ctx context.Context) (HandoffLLMSettings, bool, error) {
	var h HandoffLLMSettings
	err := s.db.QueryRowContext(ctx, `SELECT enabled, input_bytes, max_tokens, reasoning_effort, bound FROM handoff_llm_settings WHERE id = 1`).
		Scan(&h.Enabled, &h.InputBytes, &h.MaxTokens, &h.ReasoningEffort, &h.Bound)
	if errors.Is(err, sql.ErrNoRows) {
		return h, false, nil
	}
	return h, err == nil, err
}

// SaveHandoffLLMSettings stores the settings.
func (s *Store) SaveHandoffLLMSettings(ctx context.Context, h HandoffLLMSettings) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO handoff_llm_settings (id, enabled, input_bytes, max_tokens, reasoning_effort, bound, updated_at)
		VALUES (1, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, input_bytes = excluded.input_bytes, max_tokens = excluded.max_tokens,
		reasoning_effort = excluded.reasoning_effort, bound = excluded.bound, updated_at = excluded.updated_at`,
		h.Enabled, h.InputBytes, h.MaxTokens, h.ReasoningEffort, h.Bound, s.ts())
	return err
}

// LLM handoff job states.
const (
	HandoffJobQueued    = "queued"
	HandoffJobRunning   = "running"
	HandoffJobFiled     = "filed"
	HandoffJobFailed    = "failed"
	HandoffJobCancelled = "cancelled"
)

// HandoffLLMJob is a stored LLM handoff job.
type HandoffLLMJob struct {
	Op, WorkerID, Floor, AgentSession, Candidate string
	// ArgsHash identifies the job's arguments (a reused op with others is
	// refused); Config is the LLM's fingerprint when it started.
	ArgsHash, Config, PromptVersion string
	SendHome                        bool
	State, Code, Message            string
	HandoffID                       int64 // 0: none
	CreatedAt, UpdatedAt            int64 // unix ms
	// Hire (#219) is the marker of the hire that follows its filing (nil:
	// none, or it ended).
	Hire *HandoffHireMarker
}

const handoffLLMJobCols = `op, worker_uuid, floor, agent_session, candidate, args_hash, config, prompt_version, send_home, state, code,
	message, handoff_id, created_at, updated_at, hire`

func scanHandoffLLMJob(sc interface{ Scan(...any) error }) (HandoffLLMJob, error) {
	var j HandoffLLMJob
	var id sql.NullInt64
	var hire string
	err := sc.Scan(&j.Op, &j.WorkerID, &j.Floor, &j.AgentSession, &j.Candidate, &j.ArgsHash, &j.Config, &j.PromptVersion, &j.SendHome,
		&j.State, &j.Code, &j.Message, &id, &j.CreatedAt, &j.UpdatedAt, &hire)
	j.HandoffID, j.Hire = id.Int64, markerOf(hire)
	return j, err
}

// AddHandoffLLMJob stores a new job: ErrRequestTaken when its op has a row.
func (s *Store) AddHandoffLLMJob(ctx context.Context, j HandoffLLMJob) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO handoff_llm_job (`+handoffLLMJobCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		j.Op, j.WorkerID, j.Floor, j.AgentSession, j.Candidate, j.ArgsHash, j.Config, j.PromptVersion, j.SendHome, j.State, j.Code,
		j.Message, nullID(j.HandoffID), j.CreatedAt, j.UpdatedAt, markerText(j.Hire))
	if err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed") {
		return ErrRequestTaken
	}
	return err
}

// UpdateHandoffLLMJob records a job's state, code, message and handoff (by
// op).
func (s *Store) UpdateHandoffLLMJob(ctx context.Context, j HandoffLLMJob) error {
	res, err := s.db.ExecContext(ctx, `UPDATE handoff_llm_job SET state = ?, code = ?, message = ?, handoff_id = ?, updated_at = ? WHERE op = ?`,
		j.State, j.Code, j.Message, nullID(j.HandoffID), j.UpdatedAt, j.Op)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// HandoffLLMJobByOp is the job of op.
func (s *Store) HandoffLLMJobByOp(ctx context.Context, op string) (HandoffLLMJob, error) {
	j, err := scanHandoffLLMJob(s.db.QueryRowContext(ctx, `SELECT `+handoffLLMJobCols+` FROM handoff_llm_job WHERE op = ?`, op))
	if errors.Is(err, sql.ErrNoRows) {
		return HandoffLLMJob{}, ErrNotFound
	}
	return j, err
}

// LatestHandoffLLMJobs is each worker's newest job.
func (s *Store) LatestHandoffLLMJobs(ctx context.Context) ([]HandoffLLMJob, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+handoffLLMJobCols+` FROM handoff_llm_job j
		WHERE NOT EXISTS (SELECT 1 FROM handoff_llm_job n WHERE n.worker_uuid = j.worker_uuid
			AND (n.created_at > j.created_at OR (n.created_at = j.created_at AND n.op > j.op)))
		ORDER BY created_at, op`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []HandoffLLMJob
	for rows.Next() {
		j, err := scanHandoffLLMJob(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

// FailUnfinishedHandoffLLMJobs marks every queued or running job failed with
// code and message (a restart: the call that was out is never sent again)
// and says how many.
func (s *Store) FailUnfinishedHandoffLLMJobs(ctx context.Context, code, message string, at int64) (int, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE handoff_llm_job SET state = 'failed', code = ?, message = ?, updated_at = ?
		WHERE state IN ('queued', 'running')`, code, message, at)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

// PruneHandoffLLMJobs forgets the settled jobs created before ms.
func (s *Store) PruneHandoffLLMJobs(ctx context.Context, before int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM handoff_llm_job WHERE state NOT IN ('queued', 'running') AND created_at < ?`, before)
	return err
}
