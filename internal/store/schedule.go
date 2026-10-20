package store

// #62: scheduled agents. A schedule is a one-shot hire at a wall-clock
// time: the bridge's runner fires it (a fresh worker with its prompt) once
// it is due, with no client connected. The hub is the only writer; it keeps
// the schedules in view in memory and writes every transition here first,
// so a restart resumes them.

import (
	"context"
	"database/sql"
	"errors"
)

// migrationSchedule creates schedule: one row per schedule. due_at,
// seen_at (when the runner first saw it due), fired_at, created_at,
// updated_at and dismissed_at are unix ms; max_lateness_ms NULL is no
// limit; worker_id is the worker its fire hired (set once the hire began).
const migrationSchedule = `CREATE TABLE schedule (
		id              TEXT PRIMARY KEY,
		floor           TEXT NOT NULL,
		title           TEXT NOT NULL,
		prompt          TEXT NOT NULL DEFAULT '',
		due_at          INTEGER NOT NULL,
		on_miss         TEXT NOT NULL DEFAULT 'run_late' CHECK (on_miss IN ('run_late', 'skip')),
		max_lateness_ms INTEGER CHECK (max_lateness_ms IS NULL OR max_lateness_ms > 0),
		harness         TEXT NOT NULL,
		model           TEXT NOT NULL,
		effort          TEXT NOT NULL,
		cwd             TEXT NOT NULL,
		worktree        INTEGER NOT NULL DEFAULT 0 CHECK (worktree IN (0, 1)),
		wake_floor      INTEGER NOT NULL DEFAULT 1 CHECK (wake_floor IN (0, 1)),
		handoff_path    TEXT NOT NULL DEFAULT '',
		source          TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'transcript', 'suggestion')),
		source_worker   TEXT NOT NULL DEFAULT '',
		source_message  TEXT NOT NULL DEFAULT '',
		state           TEXT NOT NULL CHECK (state IN ('scheduled', 'waiting', 'running', 'done', 'failed', 'skipped', 'cancelled')),
		state_reason    TEXT NOT NULL DEFAULT '',
		seen_at         INTEGER,
		fired_at        INTEGER,
		worker_id       TEXT NOT NULL DEFAULT '',
		created_at      INTEGER NOT NULL,
		updated_at      INTEGER NOT NULL,
		dismissed_at    INTEGER
	);
	CREATE INDEX schedule_floor_state ON schedule (floor, state);`

// migrationScheduleInstructions adds #127's "Add herdr hiring
// instructions" to schedules: off for every schedule made before it.
const migrationScheduleInstructions = `ALTER TABLE schedule ADD COLUMN herdr_instructions INTEGER NOT NULL DEFAULT 0;`

// Schedule states (#62).
const (
	ScheduleScheduled = "scheduled"
	ScheduleWaiting   = "waiting"
	ScheduleRunning   = "running"
	ScheduleDone      = "done"
	ScheduleFailed    = "failed"
	ScheduleSkipped   = "skipped"
	ScheduleCancelled = "cancelled"
)

// Schedule is a stored schedule. The optional instants and MaxLateness are
// 0 when unset.
type Schedule struct {
	ID, Floor, Title, Prompt string
	DueAt                    int64
	OnMiss                   string
	MaxLateness              int64 // ms
	Harness, Model, Effort   string
	Cwd                      string
	Worktree, WakeFloor      bool
	HandoffPath              string
	Source                   string
	SourceWorker             string
	SourceMessage            string
	State, StateReason       string
	SeenAt, FiredAt          int64
	WorkerID                 string
	CreatedAt, UpdatedAt     int64
	DismissedAt              int64
	// SecretsReview (#108): the record that Prompt was reviewed for
	// possible secrets with every one left as typed ("": never reviewed;
	// see migrationPromptSecretsReviewed).
	SecretsReview string
	// HerdrInstructions (#127): its fire adds the herdr hiring
	// instructions for its floor after its prompt (never stored in Prompt).
	HerdrInstructions bool
}

const scheduleCols = `id, floor, title, prompt, due_at, on_miss, max_lateness_ms, harness, model, effort, cwd, worktree,
	wake_floor, handoff_path, source, source_worker, source_message, state, state_reason, seen_at, fired_at, worker_id,
	created_at, updated_at, dismissed_at, secrets_review, herdr_instructions`

func scanSchedule(sc interface{ Scan(...any) error }) (Schedule, error) {
	var s Schedule
	var maxLate, seen, fired, dismissed sql.NullInt64
	err := sc.Scan(&s.ID, &s.Floor, &s.Title, &s.Prompt, &s.DueAt, &s.OnMiss, &maxLate, &s.Harness, &s.Model, &s.Effort,
		&s.Cwd, &s.Worktree, &s.WakeFloor, &s.HandoffPath, &s.Source, &s.SourceWorker, &s.SourceMessage, &s.State,
		&s.StateReason, &seen, &fired, &s.WorkerID, &s.CreatedAt, &s.UpdatedAt, &dismissed, &s.SecretsReview, &s.HerdrInstructions)
	s.MaxLateness, s.SeenAt, s.FiredAt, s.DismissedAt = maxLate.Int64, seen.Int64, fired.Int64, dismissed.Int64
	return s, err
}

// AddSchedule stores a new schedule.
func (s *Store) AddSchedule(ctx context.Context, sc Schedule) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO schedule (`+scheduleCols+`)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		sc.ID, sc.Floor, sc.Title, sc.Prompt, sc.DueAt, sc.OnMiss, nullID(sc.MaxLateness), sc.Harness, sc.Model, sc.Effort,
		sc.Cwd, sc.Worktree, sc.WakeFloor, sc.HandoffPath, sc.Source, sc.SourceWorker, sc.SourceMessage, sc.State,
		sc.StateReason, nullID(sc.SeenAt), nullID(sc.FiredAt), sc.WorkerID, sc.CreatedAt, sc.UpdatedAt, nullID(sc.DismissedAt),
		sc.SecretsReview, sc.HerdrInstructions)
	return err
}

// SaveSchedule writes every field of a stored schedule but its id, floor,
// source and created_at (ErrNotFound: no such schedule).
func (s *Store) SaveSchedule(ctx context.Context, sc Schedule) error {
	res, err := s.db.ExecContext(ctx, `UPDATE schedule SET title = ?, prompt = ?, due_at = ?, on_miss = ?, max_lateness_ms = ?,
		harness = ?, model = ?, effort = ?, cwd = ?, worktree = ?, wake_floor = ?, handoff_path = ?, state = ?, state_reason = ?,
		seen_at = ?, fired_at = ?, worker_id = ?, updated_at = ?, dismissed_at = ?, secrets_review = ?,
		herdr_instructions = ? WHERE id = ?`,
		sc.Title, sc.Prompt, sc.DueAt, sc.OnMiss, nullID(sc.MaxLateness), sc.Harness, sc.Model, sc.Effort, sc.Cwd, sc.Worktree,
		sc.WakeFloor, sc.HandoffPath, sc.State, sc.StateReason, nullID(sc.SeenAt), nullID(sc.FiredAt), sc.WorkerID, sc.UpdatedAt,
		nullID(sc.DismissedAt), sc.SecretsReview, sc.HerdrInstructions, sc.ID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ScheduleByID is the schedule id.
func (s *Store) ScheduleByID(ctx context.Context, id string) (Schedule, error) {
	sc, err := scanSchedule(s.db.QueryRowContext(ctx, `SELECT `+scheduleCols+` FROM schedule WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Schedule{}, ErrNotFound
	}
	return sc, err
}

// Schedules are the schedules in view, by due time: the upcoming ones
// (scheduled, waiting, running), the failed and skipped ones not dismissed,
// and the done ones. Cancelled and dismissed ones are kept but not listed.
func (s *Store) Schedules(ctx context.Context) ([]Schedule, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+scheduleCols+` FROM schedule
		WHERE state IN ('scheduled', 'waiting', 'running', 'done') OR (state IN ('failed', 'skipped') AND dismissed_at IS NULL)
		ORDER BY due_at, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Schedule
	for rows.Next() {
		sc, err := scanSchedule(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sc)
	}
	return out, rows.Err()
}

// PruneDoneSchedules deletes the done schedules of floor beyond the keep
// fired last, and returns their ids.
func (s *Store) PruneDoneSchedules(ctx context.Context, floor string, keep int) ([]string, error) {
	var ids []string
	err := s.tx(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `SELECT id FROM schedule WHERE floor = ? AND state = 'done'
			ORDER BY fired_at DESC, due_at DESC, id DESC LIMIT -1 OFFSET ?`, floor, keep)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			ids = append(ids, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, id := range ids {
			if _, err := tx.ExecContext(ctx, `DELETE FROM schedule WHERE id = ?`, id); err != nil {
				return err
			}
		}
		return nil
	})
	return ids, err
}

// WorkerExists reports whether the bridge has ever recorded the worker id
// (it was seen on its floor; it may have left since).
func (s *Store) WorkerExists(ctx context.Context, id string) (bool, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM worker WHERE id = ?`, id).Scan(&n)
	return n > 0, err
}
