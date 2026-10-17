package store

// #93 hire presets: a named first prompt with the harness, model and effort
// to hire it with, on one floor (by floor id: a session's real floor or a
// virtual floor) or global (every floor of the bridge). They are no team
// presets (team_preset): one worker, one prompt, nothing about runs.

import (
	"context"
	"database/sql"
	"fmt"
)

// migrationHirePreset creates hire_preset: floor NULL is a global preset.
// created_at and updated_at are unix ms. A name is unique ignoring case
// within its scope (the index reads a global one's floor as the empty
// string, which no floor id is).
const migrationHirePreset = `CREATE TABLE hire_preset (
		id         TEXT PRIMARY KEY,
		name       TEXT NOT NULL,
		floor      TEXT CHECK (floor IS NULL OR floor <> ''),
		prompt     TEXT NOT NULL,
		harness    TEXT NOT NULL,
		model      TEXT NOT NULL,
		effort     TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE UNIQUE INDEX hire_preset_name ON hire_preset(COALESCE(floor, ''), lower(name));`

// HirePreset is a stored hire preset. Floor is "" for a global one. The
// caller validates the prompt and the tuple; the store checks the name.
type HirePreset struct {
	ID, Name, Floor        string
	Prompt                 string
	Harness, Model, Effort string
	CreatedAt, UpdatedAt   int64
}

func hirePresetNameTaken(ctx context.Context, tx *sql.Tx, name, floor, exceptID string) error {
	var n int
	err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM hire_preset WHERE COALESCE(floor, '') = ? AND lower(name) = lower(?) AND id != ?`,
		floor, name, exceptID).Scan(&n)
	if err != nil {
		return err
	}
	if n > 0 {
		where := "global"
		if floor != "" {
			where = "on this floor"
		}
		return fmt.Errorf("%w: a hire preset %s is called %q", ErrNameTaken, where, name)
	}
	return nil
}

// HirePresets returns every hire preset, by name ignoring case.
func (s *Store) HirePresets(ctx context.Context) ([]HirePreset, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, COALESCE(floor, ''), prompt, harness, model, effort, created_at, updated_at
		FROM hire_preset ORDER BY lower(name), id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []HirePreset
	for rows.Next() {
		var p HirePreset
		if err := rows.Scan(&p.ID, &p.Name, &p.Floor, &p.Prompt, &p.Harness, &p.Model, &p.Effort, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// CreateHirePreset stores a new hire preset, its name cleaned
// (CleanPresetName) and unique in its scope.
func (s *Store) CreateHirePreset(ctx context.Context, p HirePreset) error {
	name, err := CleanPresetName(p.Name)
	if err != nil {
		return err
	}
	return s.tx(ctx, func(tx *sql.Tx) error {
		if err := hirePresetNameTaken(ctx, tx, name, p.Floor, ""); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO hire_preset (id, name, floor, prompt, harness, model, effort, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, p.ID, name, null(p.Floor), p.Prompt, p.Harness, p.Model, p.Effort, p.CreatedAt, p.UpdatedAt)
		return err
	})
}

// UpdateHirePreset replaces a hire preset's name (cleaned), scope, prompt,
// tuple and updated_at; its created_at stays.
func (s *Store) UpdateHirePreset(ctx context.Context, p HirePreset) error {
	name, err := CleanPresetName(p.Name)
	if err != nil {
		return err
	}
	return s.tx(ctx, func(tx *sql.Tx) error {
		if err := hirePresetNameTaken(ctx, tx, name, p.Floor, p.ID); err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `UPDATE hire_preset SET name = ?, floor = ?, prompt = ?, harness = ?, model = ?, effort = ?,
			updated_at = ? WHERE id = ?`, name, null(p.Floor), p.Prompt, p.Harness, p.Model, p.Effort, p.UpdatedAt, p.ID)
		if err != nil {
			return err
		}
		return hirePresetAffected(res, p.ID)
	})
}

// DeleteHirePreset deletes a hire preset.
func (s *Store) DeleteHirePreset(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM hire_preset WHERE id = ?`, id)
	if err != nil {
		return err
	}
	return hirePresetAffected(res, id)
}

func hirePresetAffected(res sql.Result, id string) error {
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return fmt.Errorf("%w: hire preset %q", ErrNotFound, id)
	}
	return nil
}
