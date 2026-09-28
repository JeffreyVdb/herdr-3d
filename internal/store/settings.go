package store

import (
	"context"
	"database/sql"
	"encoding/json"
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
}

// IsZero reports whether nothing is set.
func (f FloorSettings) IsZero() bool {
	return f.Repo == "" && f.ProjectOwner == "" && f.ProjectNumber == 0 && f.StatusField == "" &&
		len(f.StatusOptions) == 0 && f.DefaultCwd == "" && f.HireHarness == "" && f.HireModel == "" && f.HireEffort == ""
}

// FloorSettings returns the stored settings of every floor, by session,
// including sessions that currently do not exist.
func (s *Store) FloorSettings(ctx context.Context) (map[string]FloorSettings, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT session_name, COALESCE(repo, ''), COALESCE(project_owner, ''),
			COALESCE(project_number, 0), COALESCE(status_field, ''), COALESCE(status_options, ''), COALESCE(default_cwd, ''),
			COALESCE(hire_harness, ''), COALESCE(hire_model, ''), COALESCE(hire_effort, '')
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
			&f.HireHarness, &f.HireModel, &f.HireEffort); err != nil {
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
			status_options, default_cwd, hire_harness, hire_model, hire_effort, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(session_name) DO UPDATE SET repo = excluded.repo, project_owner = excluded.project_owner,
			project_number = excluded.project_number, status_field = excluded.status_field,
			status_options = excluded.status_options, default_cwd = excluded.default_cwd,
			hire_harness = excluded.hire_harness, hire_model = excluded.hire_model, hire_effort = excluded.hire_effort,
			updated_at = excluded.updated_at`,
		session, null(f.Repo), null(f.ProjectOwner), number, null(f.StatusField), options, null(f.DefaultCwd),
		null(f.HireHarness), null(f.HireModel), null(f.HireEffort), s.ts())
	return err
}

// null stores "" as NULL.
func null(v string) sql.NullString { return sql.NullString{String: v, Valid: v != ""} }
