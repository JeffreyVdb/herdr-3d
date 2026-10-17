package store

// #93 hire presets: a named first prompt with the harness, model and effort
// to hire it with, on one floor (by floor id: a session's real floor or a
// virtual floor) or global (every floor of the bridge). They are no team
// presets (team_preset): one worker, one prompt, nothing about runs.

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"golang.org/x/text/cases"
)

// migrationHirePreset creates hire_preset: floor NULL is a global preset.
// created_at and updated_at are unix ms. A name is unique ignoring case
// within its scope: name_key is the name case-folded in Go
// (hirePresetNameKey), not by SQLite's lower(), which folds ASCII only. The index reads a global
// one's floor as the empty string, which no floor id is.
const migrationHirePreset = `CREATE TABLE hire_preset (
		id         TEXT PRIMARY KEY,
		name       TEXT NOT NULL,
		name_key   TEXT NOT NULL,
		floor      TEXT CHECK (floor IS NULL OR floor <> ''),
		prompt     TEXT NOT NULL,
		harness    TEXT NOT NULL,
		model      TEXT NOT NULL,
		effort     TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE UNIQUE INDEX hire_preset_name ON hire_preset(COALESCE(floor, ''), name_key);`

// migrationHirePresetInstructions adds #95's "Add herdr hiring
// instructions": off for every preset made before it.
const migrationHirePresetInstructions = `ALTER TABLE hire_preset ADD COLUMN herdr_instructions INTEGER NOT NULL DEFAULT 0;`

// HirePreset is a stored hire preset. Floor is "" for a global one. The
// caller validates the prompt and the tuple; the store checks the name.
// HerdrInstructions (#95): a hire from it gets the herdr hiring
// instructions for the floor it is used on (never stored in Prompt).
type HirePreset struct {
	ID, Name, Floor        string
	Prompt                 string
	Harness, Model, Effort string
	HerdrInstructions      bool
	CreatedAt, UpdatedAt   int64
}

// hirePresetNameKey folds a name's case for uniqueness (full Unicode case
// folding, a Caser per call: x/text does not let goroutines share one). It
// must join every two names the game's toLowerCase joins (its nameTaken),
// or the bridge stores two names the game then refuses to save: Go's
// strings.ToLower alone differs on a final sigma (ς) and on İ. Full folding
// covers those and joins more (STRASSE and straße), which only makes the
// bridge stricter: it answers name_taken. ToLower after the fold because
// x/text folds Cherokee upper to lower and lower to upper (Ꭰ and ꭰ would
// differ).
func hirePresetNameKey(name string) string { return strings.ToLower(cases.Fold().String(name)) }

func hirePresetNameTaken(ctx context.Context, tx *sql.Tx, name, floor, exceptID string) error {
	var n int
	err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM hire_preset WHERE COALESCE(floor, '') = ? AND name_key = ? AND id != ?`,
		floor, hirePresetNameKey(name), exceptID).Scan(&n)
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
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, COALESCE(floor, ''), prompt, harness, model, effort, herdr_instructions, created_at, updated_at
		FROM hire_preset ORDER BY name_key, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []HirePreset
	for rows.Next() {
		var p HirePreset
		if err := rows.Scan(&p.ID, &p.Name, &p.Floor, &p.Prompt, &p.Harness, &p.Model, &p.Effort, &p.HerdrInstructions, &p.CreatedAt, &p.UpdatedAt); err != nil {
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
		_, err := tx.ExecContext(ctx, `INSERT INTO hire_preset (id, name, name_key, floor, prompt, harness, model, effort, herdr_instructions, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, p.ID, name, hirePresetNameKey(name), null(p.Floor), p.Prompt, p.Harness, p.Model, p.Effort,
			p.HerdrInstructions, p.CreatedAt, p.UpdatedAt)
		return err
	})
}

// UpdateHirePreset replaces a hire preset's name (cleaned), scope, prompt,
// tuple, hiring instructions flag and updated_at; its created_at stays.
func (s *Store) UpdateHirePreset(ctx context.Context, p HirePreset) error {
	name, err := CleanPresetName(p.Name)
	if err != nil {
		return err
	}
	return s.tx(ctx, func(tx *sql.Tx) error {
		if err := hirePresetNameTaken(ctx, tx, name, p.Floor, p.ID); err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `UPDATE hire_preset SET name = ?, name_key = ?, floor = ?, prompt = ?, harness = ?, model = ?, effort = ?,
			herdr_instructions = ?, updated_at = ? WHERE id = ?`, name, hirePresetNameKey(name), null(p.Floor), p.Prompt, p.Harness, p.Model, p.Effort,
			p.HerdrInstructions, p.UpdatedAt, p.ID)
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
