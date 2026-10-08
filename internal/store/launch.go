package store

// M6 launch: team presets, each floor's last preset and the runs started
// from the game (run_launch).

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// migrationLaunch creates the M6 launch tables and seeds "Build team"
// (docs/decisions.md): coders claude opus medium, reviewers and UX codex
// sol high, researchers codex sol low, the orchestrator claude opus medium.
const migrationLaunch = `CREATE TABLE team_preset (
		id         TEXT PRIMARY KEY,
		name       TEXT NOT NULL,
		seeded     INTEGER NOT NULL DEFAULT 0,
		roles      TEXT NOT NULL,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);
	CREATE UNIQUE INDEX team_preset_name ON team_preset(lower(name));
	INSERT INTO team_preset (id, name, seeded, roles, created_at, updated_at) VALUES (
		'p_' || lower(hex(randomblob(6))), 'Build team', 1,
		'{"orch":{"harness":"claude","model":"claude-opus-5-5","effort":"medium"},' ||
		'"coder":{"harness":"claude","model":"claude-opus-5-5","effort":"medium"},' ||
		'"reviewer":{"harness":"codex","model":"gpt-6-sol","effort":"high"},' ||
		'"ux":{"harness":"codex","model":"gpt-6-sol","effort":"high"},' ||
		'"researcher":{"harness":"codex","model":"gpt-6-sol","effort":"low"}}',
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
	CREATE TABLE floor_preset_last (
		session_name TEXT PRIMARY KEY,
		preset_id    TEXT NOT NULL REFERENCES team_preset(id) ON DELETE CASCADE,
		updated_at   TEXT NOT NULL
	);
	CREATE TABLE run_launch (
		id             TEXT PRIMARY KEY,
		run_id         TEXT,
		session        TEXT NOT NULL,
		repo           TEXT,
		issue_number   INTEGER,
		ticket_text    TEXT,
		orch_worker_id TEXT NOT NULL,
		preset_id      TEXT NOT NULL,
		preset_name    TEXT NOT NULL,
		created_at     TEXT NOT NULL
	);
	CREATE INDEX run_launch_worker ON run_launch(orch_worker_id);`

// MaxPresetName bounds team preset names.
const MaxPresetName = 40

// PresetRoles are the harness/model/effort of each role of a team.
type PresetRoles struct {
	Orch, Coder, Reviewer, UX, Researcher Hire
}

// Preset is a stored team preset.
type Preset struct {
	ID     string
	Name   string
	Seeded bool // it is the "Build team" the first migration made
	Roles  PresetRoles
}

type hireJSON struct {
	Harness string `json:"harness"`
	Model   string `json:"model"`
	Effort  string `json:"effort"`
}

type rolesJSON struct {
	Orch       hireJSON `json:"orch"`
	Coder      hireJSON `json:"coder"`
	Reviewer   hireJSON `json:"reviewer"`
	UX         hireJSON `json:"ux"`
	Researcher hireJSON `json:"researcher"`
}

func encodeRoles(r PresetRoles) (string, error) {
	j := func(h Hire) hireJSON { return hireJSON(h) }
	b, err := json.Marshal(rolesJSON{j(r.Orch), j(r.Coder), j(r.Reviewer), j(r.UX), j(r.Researcher)})
	return string(b), err
}

func decodeRoles(s string) (PresetRoles, error) {
	var r rolesJSON
	if err := json.Unmarshal([]byte(s), &r); err != nil {
		return PresetRoles{}, err
	}
	h := func(j hireJSON) Hire { return Hire(j) }
	return PresetRoles{h(r.Orch), h(r.Coder), h(r.Reviewer), h(r.UX), h(r.Researcher)}, nil
}

// CleanPresetName trims and validates a preset name: 1-40 bytes of UTF-8
// without control characters.
func CleanPresetName(name string) (string, error) {
	name = strings.TrimSpace(name)
	bad := name == "" || len(name) > MaxPresetName || !utf8.ValidString(name)
	for _, r := range name {
		bad = bad || unicode.IsControl(r)
	}
	if bad {
		return "", fmt.Errorf("%w: preset name must be 1-%d bytes without control characters", ErrInvalid, MaxPresetName)
	}
	return name, nil
}

func presetNameTaken(ctx context.Context, tx *sql.Tx, name, exceptID string) error {
	var n int
	err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM team_preset WHERE lower(name) = lower(?) AND id != ?`, name, exceptID).Scan(&n)
	if err != nil {
		return err
	}
	if n > 0 {
		return fmt.Errorf("%w: a preset is called %q", ErrNameTaken, name)
	}
	return nil
}

// Presets returns every team preset, by name ignoring case.
func (s *Store) Presets(ctx context.Context) ([]Preset, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, seeded, roles FROM team_preset ORDER BY lower(name), id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Preset
	for rows.Next() {
		var p Preset
		var roles string
		if err := rows.Scan(&p.ID, &p.Name, &p.Seeded, &roles); err != nil {
			return nil, err
		}
		if p.Roles, err = decodeRoles(roles); err != nil {
			return nil, fmt.Errorf("team_preset %s: roles: %w", p.ID, err)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// CreatePreset adds a team preset. Roles are stored as given: the caller
// validates them.
func (s *Store) CreatePreset(ctx context.Context, id, name string, roles PresetRoles) (Preset, error) {
	name, err := CleanPresetName(name)
	if err != nil {
		return Preset{}, err
	}
	enc, err := encodeRoles(roles)
	if err != nil {
		return Preset{}, err
	}
	err = s.tx(ctx, func(tx *sql.Tx) error {
		if err := presetNameTaken(ctx, tx, name, ""); err != nil {
			return err
		}
		now := s.ts()
		_, err := tx.ExecContext(ctx, `INSERT INTO team_preset (id, name, seeded, roles, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)`,
			id, name, enc, now, now)
		return err
	})
	if err != nil {
		return Preset{}, err
	}
	return Preset{ID: id, Name: name, Roles: roles}, nil
}

// UpdatePreset replaces a preset's name (cleaned) and roles.
func (s *Store) UpdatePreset(ctx context.Context, p Preset) error {
	name, err := CleanPresetName(p.Name)
	if err != nil {
		return err
	}
	enc, err := encodeRoles(p.Roles)
	if err != nil {
		return err
	}
	return s.tx(ctx, func(tx *sql.Tx) error {
		if err := presetNameTaken(ctx, tx, name, p.ID); err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `UPDATE team_preset SET name = ?, roles = ?, updated_at = ? WHERE id = ?`, name, enc, s.ts(), p.ID)
		if err != nil {
			return err
		}
		return presetAffected(res, p.ID)
	})
}

// DeletePreset deletes a preset, and every floor's memory of it as the
// last one used.
func (s *Store) DeletePreset(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM team_preset WHERE id = ?`, id)
	if err != nil {
		return err
	}
	return presetAffected(res, id)
}

func presetAffected(res sql.Result, id string) error {
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return fmt.Errorf("%w: preset %q", ErrNotFound, id)
	}
	return nil
}

// LastPresets returns the preset of each floor's last run.start, by session.
func (s *Store) LastPresets(ctx context.Context) (map[string]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT session_name, preset_id FROM floor_preset_last ORDER BY session_name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var session, id string
		if err := rows.Scan(&session, &id); err != nil {
			return nil, err
		}
		out[session] = id
	}
	return out, rows.Err()
}

// SetLastPreset remembers the preset of a floor's last run.start; the
// preset must exist.
func (s *Store) SetLastPreset(ctx context.Context, session, presetID string) error {
	if session == "" || presetID == "" {
		return fmt.Errorf("%w: session and preset are required", ErrInvalid)
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO floor_preset_last (session_name, preset_id, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(session_name) DO UPDATE SET preset_id = excluded.preset_id, updated_at = excluded.updated_at`,
		session, presetID, s.ts())
	return err
}

// RunLaunch is a write-code run started from the game (run.start): the
// orchestrator worker it hired, its ticket (an issue, a provider's item
// (#184), or free text) and the preset it was started with. RunID is the
// h3d_run token that worker first showed ("" until then).
type RunLaunch struct {
	ID          string
	RunID       string
	Session     string
	Repo        string // with IssueNumber, for an issue ticket
	IssueNumber int
	TicketText  string // a free-text ticket
	// #184: an item of an issue provider that numbers no GitHub issue (a
	// Kaneo task): the provider, the item's opaque id and its readable key.
	ItemProvider string
	ItemID       string
	ItemKey      string
	OrchWorkerID string
	PresetID     string
	PresetName   string
	CreatedAt    time.Time
}

// RecordRunLaunch records a run started from the game.
func (s *Store) RecordRunLaunch(ctx context.Context, l RunLaunch) error {
	if l.ID == "" || l.Session == "" || l.OrchWorkerID == "" || l.PresetID == "" || l.PresetName == "" {
		return fmt.Errorf("%w: id, session, orchestrator and preset are required", ErrInvalid)
	}
	var number any
	if l.IssueNumber != 0 {
		number = l.IssueNumber
	}
	if (l.ItemProvider == "") != (l.ItemID == "") {
		return fmt.Errorf("%w: an item needs its provider and id", ErrInvalid)
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO run_launch (id, run_id, session, repo, issue_number, ticket_text, item_provider,
			item_id, item_key, orch_worker_id, preset_id, preset_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		l.ID, null(l.RunID), l.Session, null(l.Repo), number, null(l.TicketText), null(l.ItemProvider), null(l.ItemID),
		null(l.ItemKey), l.OrchWorkerID, l.PresetID, l.PresetName, s.ts())
	return err
}

// RunLaunchByWorker returns the latest run started with workerID as its
// orchestrator, if any.
func (s *Store) RunLaunchByWorker(ctx context.Context, workerID string) (RunLaunch, bool, error) {
	l := RunLaunch{OrchWorkerID: workerID}
	var created string
	err := s.db.QueryRowContext(ctx, `SELECT id, COALESCE(run_id, ''), session, COALESCE(repo, ''), COALESCE(issue_number, 0),
			COALESCE(ticket_text, ''), COALESCE(item_provider, ''), COALESCE(item_id, ''), COALESCE(item_key, ''), preset_id,
			preset_name, created_at
		FROM run_launch WHERE orch_worker_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`, workerID).
		Scan(&l.ID, &l.RunID, &l.Session, &l.Repo, &l.IssueNumber, &l.TicketText, &l.ItemProvider, &l.ItemID, &l.ItemKey,
			&l.PresetID, &l.PresetName, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return RunLaunch{}, false, nil
	}
	if err != nil {
		return RunLaunch{}, false, err
	}
	if l.CreatedAt, err = time.Parse(time.RFC3339Nano, created); err != nil {
		l.CreatedAt = time.Unix(0, 0)
	}
	return l, true, nil
}

// PendingRunLaunches returns the orchestrator workers of launches whose
// run id is not known yet.
func (s *Store) PendingRunLaunches(ctx context.Context) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT DISTINCT orch_worker_id FROM run_launch WHERE run_id IS NULL ORDER BY orch_worker_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// SetRunLaunchRun records the run id a launch's orchestrator first showed;
// a launch that has one keeps it.
func (s *Store) SetRunLaunchRun(ctx context.Context, workerID, runID string) error {
	if workerID == "" || runID == "" {
		return fmt.Errorf("%w: worker and run are required", ErrInvalid)
	}
	_, err := s.db.ExecContext(ctx, `UPDATE run_launch SET run_id = ? WHERE orch_worker_id = ? AND run_id IS NULL`, runID, workerID)
	return err
}
