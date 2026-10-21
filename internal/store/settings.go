package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
)

// FloorSettings are a floor's stored settings (table floor_repo). A zero
// field is unset. The hire fields are set together or not at all, as are
// the status field and its options, and the project owner and number.
type FloorSettings struct {
	Repo          string // GitHub "owner/repo"
	ProjectOwner  string
	ProjectNumber int // GitHub Project v2 number; 0 = none
	StatusField   string
	StatusOptions []string
	DefaultCwd    string
	HireHarness   string
	HireModel     string
	HireEffort    string
	// #184: Tracker is the floor's issue tracker: "" (GitHub, also every
	// floor from before it) or "kaneo". The Kaneo link (workspace and
	// project ids, with the names they had when saved) is kept while the
	// floor uses GitHub, and the GitHub fields while it uses Kaneo.
	Tracker            string
	KaneoWorkspaceID   string
	KaneoWorkspaceName string
	KaneoProjectID     string
	KaneoProjectName   string
}

// migrationKaneo adds #184's columns: a floor's issue tracker and Kaneo
// link (NULL tracker: GitHub, what every older floor keeps), and a run
// launched on a provider's item ({provider, id}, its readable key).
const migrationKaneo = `ALTER TABLE floor_repo ADD COLUMN tracker TEXT;
	ALTER TABLE floor_repo ADD COLUMN kaneo_workspace_id TEXT;
	ALTER TABLE floor_repo ADD COLUMN kaneo_workspace_name TEXT;
	ALTER TABLE floor_repo ADD COLUMN kaneo_project_id TEXT;
	ALTER TABLE floor_repo ADD COLUMN kaneo_project_name TEXT;
	ALTER TABLE run_launch ADD COLUMN item_provider TEXT;
	ALTER TABLE run_launch ADD COLUMN item_id TEXT;
	ALTER TABLE run_launch ADD COLUMN item_key TEXT;`

// IsZero reports whether nothing is set.
func (f FloorSettings) IsZero() bool {
	return f.Repo == "" && f.ProjectOwner == "" && f.ProjectNumber == 0 && f.StatusField == "" &&
		len(f.StatusOptions) == 0 && f.DefaultCwd == "" && f.HireHarness == "" && f.HireModel == "" && f.HireEffort == "" &&
		f.Tracker == "" && f.KaneoWorkspaceID == "" && f.KaneoWorkspaceName == "" && f.KaneoProjectID == "" && f.KaneoProjectName == ""
}

// FloorSettings returns the stored settings of every floor, by session,
// including sessions that currently do not exist.
func (s *Store) FloorSettings(ctx context.Context) (map[string]FloorSettings, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT session_name, COALESCE(repo, ''), COALESCE(project_owner, ''),
			COALESCE(project_number, 0), COALESCE(status_field, ''), COALESCE(status_options, ''), COALESCE(default_cwd, ''),
			COALESCE(hire_harness, ''), COALESCE(hire_model, ''), COALESCE(hire_effort, ''), COALESCE(tracker, ''),
			COALESCE(kaneo_workspace_id, ''), COALESCE(kaneo_workspace_name, ''), COALESCE(kaneo_project_id, ''),
			COALESCE(kaneo_project_name, '')
		FROM floor_repo ORDER BY session_name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]FloorSettings{}
	for rows.Next() {
		var session, options string
		var f FloorSettings
		if err := rows.Scan(&session, &f.Repo, &f.ProjectOwner, &f.ProjectNumber, &f.StatusField, &options, &f.DefaultCwd,
			&f.HireHarness, &f.HireModel, &f.HireEffort, &f.Tracker, &f.KaneoWorkspaceID, &f.KaneoWorkspaceName,
			&f.KaneoProjectID, &f.KaneoProjectName); err != nil {
			return nil, err
		}
		if options != "" {
			if err := json.Unmarshal([]byte(options), &f.StatusOptions); err != nil {
				return nil, fmt.Errorf("floor_repo %s: status_options: %w", session, err)
			}
		}
		out[session] = f
	}
	return out, rows.Err()
}

// SetFloorSettings replaces a floor's settings; all-unset removes its row.
// Values are stored as given: the caller validates them.
func (s *Store) SetFloorSettings(ctx context.Context, session string, f FloorSettings) error {
	if session == "" {
		return fmt.Errorf("%w: session is required", ErrInvalid)
	}
	if f.IsZero() {
		_, err := s.db.ExecContext(ctx, `DELETE FROM floor_repo WHERE session_name = ?`, session)
		return err
	}
	var options any
	if len(f.StatusOptions) > 0 {
		b, err := json.Marshal(f.StatusOptions)
		if err != nil {
			return err
		}
		options = string(b)
	}
	var number any
	if f.ProjectNumber != 0 {
		number = f.ProjectNumber
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO floor_repo (session_name, repo, project_owner, project_number, status_field,
			status_options, default_cwd, hire_harness, hire_model, hire_effort, tracker, kaneo_workspace_id,
			kaneo_workspace_name, kaneo_project_id, kaneo_project_name, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(session_name) DO UPDATE SET repo = excluded.repo, project_owner = excluded.project_owner,
			project_number = excluded.project_number, status_field = excluded.status_field,
			status_options = excluded.status_options, default_cwd = excluded.default_cwd,
			hire_harness = excluded.hire_harness, hire_model = excluded.hire_model, hire_effort = excluded.hire_effort,
			tracker = excluded.tracker, kaneo_workspace_id = excluded.kaneo_workspace_id,
			kaneo_workspace_name = excluded.kaneo_workspace_name, kaneo_project_id = excluded.kaneo_project_id,
			kaneo_project_name = excluded.kaneo_project_name, updated_at = excluded.updated_at`,
		session, null(f.Repo), null(f.ProjectOwner), number, null(f.StatusField), options, null(f.DefaultCwd),
		null(f.HireHarness), null(f.HireModel), null(f.HireEffort), null(f.Tracker), null(f.KaneoWorkspaceID),
		null(f.KaneoWorkspaceName), null(f.KaneoProjectID), null(f.KaneoProjectName), s.ts())
	return err
}

// null stores "" as NULL.
func null(v string) sql.NullString { return sql.NullString{String: v, Valid: v != ""} }

// Hire is a harness, model and effort.
type Hire struct {
	Harness, Model, Effort string
	// CodexProfile (#167) is a team preset role's Codex profile (a key or
	// "auto"; "": the default); never a floor's last hire's.
	CodexProfile string
}

// LastHires returns the last choice hired on each floor, by session.
func (s *Store) LastHires(ctx context.Context) (map[string]Hire, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT session_name, harness, model, effort FROM floor_hire_last ORDER BY session_name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]Hire{}
	for rows.Next() {
		var session string
		var h Hire
		if err := rows.Scan(&session, &h.Harness, &h.Model, &h.Effort); err != nil {
			return nil, err
		}
		out[session] = h
	}
	return out, rows.Err()
}

// SetLastHire remembers the choice last hired on a floor.
func (s *Store) SetLastHire(ctx context.Context, session string, h Hire) error {
	if session == "" || h.Harness == "" || h.Model == "" || h.Effort == "" {
		return fmt.Errorf("%w: session, harness, model and effort are required", ErrInvalid)
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO floor_hire_last (session_name, harness, model, effort, updated_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(session_name) DO UPDATE SET harness = excluded.harness, model = excluded.model,
			effort = excluded.effort, updated_at = excluded.updated_at`,
		session, h.Harness, h.Model, h.Effort, s.ts())
	return err
}

// HireBranch is a branch the bridge made for a worktree hire.
type HireBranch struct {
	WorkerID string
	Session  string
	RepoRoot string // the repository's main checkout
	Branch   string
	BaseSHA  string // the commit it was made from
	Base     string // the branch it was made from ("main"), "" for a record from before M7
}

// RecordHireBranch records the branch the bridge made for a worker.
func (s *Store) RecordHireBranch(ctx context.Context, b HireBranch) error {
	if b.WorkerID == "" || b.Session == "" || b.RepoRoot == "" || b.Branch == "" || b.BaseSHA == "" {
		return fmt.Errorf("%w: worker, session, repo root, branch and base are required", ErrInvalid)
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO hire_branch (worker_uuid, session_name, repo_root, branch, base_sha, base, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, b.WorkerID, b.Session, b.RepoRoot, b.Branch, b.BaseSHA, b.Base, s.ts())
	return err
}

// HireBranchOf returns the branch the bridge made for a worker, if any.
func (s *Store) HireBranchOf(ctx context.Context, workerID string) (HireBranch, bool, error) {
	b := HireBranch{WorkerID: workerID}
	err := s.db.QueryRowContext(ctx, `SELECT session_name, repo_root, branch, base_sha, base FROM hire_branch WHERE worker_uuid = ?`,
		workerID).Scan(&b.Session, &b.RepoRoot, &b.Branch, &b.BaseSHA, &b.Base)
	if errors.Is(err, sql.ErrNoRows) {
		return HireBranch{}, false, nil
	}
	if err != nil {
		return HireBranch{}, false, err
	}
	return b, true, nil
}

// ForgetHireBranch drops a worker's branch record (the branch is gone).
func (s *Store) ForgetHireBranch(ctx context.Context, workerID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM hire_branch WHERE worker_uuid = ?`, workerID)
	return err
}
