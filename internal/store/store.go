// Package store is herdr-world's own SQLite database (pure Go, no cgo):
// buildings, which building each floor (session) is in, floor settings,
// bridge-owned worker identities with their fingerprints, names and desks,
// and an audit log of commands.
package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite" // registers the "sqlite" driver
)

// Sentinel errors for command validation.
var (
	ErrNotFound  = errors.New("not found")
	ErrNameTaken = errors.New("name already used")
	ErrInvalid   = errors.New("invalid argument")
)

// MaxNameLen bounds building names.
const MaxNameLen = 64

// migrations are applied in order; PRAGMA user_version is the count applied.
var migrations = []string{
	`CREATE TABLE building (
		id         TEXT PRIMARY KEY,
		name       TEXT NOT NULL,
		sort       INTEGER NOT NULL,
		created_at TEXT NOT NULL
	);
	CREATE TABLE floor_assignment (
		session_name TEXT PRIMARY KEY,
		building_id  TEXT NOT NULL REFERENCES building(id) ON DELETE CASCADE,
		floor_index  INTEGER NOT NULL
	);
	CREATE INDEX floor_assignment_building ON floor_assignment(building_id, floor_index);
	CREATE TABLE worker (
		id           TEXT PRIMARY KEY,
		session_name TEXT NOT NULL,
		workspace_id TEXT NOT NULL,
		label        TEXT NOT NULL,
		created_at   TEXT NOT NULL,
		last_seen_at TEXT NOT NULL,
		closed_at    TEXT
	);
	CREATE INDEX worker_session ON worker(session_name);
	CREATE TABLE worker_fingerprint (
		worker_id    TEXT NOT NULL REFERENCES worker(id) ON DELETE CASCADE,
		kind         TEXT NOT NULL,
		value        TEXT NOT NULL,
		last_seen_at TEXT NOT NULL,
		PRIMARY KEY (worker_id, kind, value)
	);
	CREATE INDEX worker_fingerprint_lookup ON worker_fingerprint(kind, value);
	CREATE TABLE audit_log (
		id     INTEGER PRIMARY KEY AUTOINCREMENT,
		ts     TEXT NOT NULL,
		client TEXT NOT NULL,
		cmd    TEXT NOT NULL,
		args   TEXT NOT NULL,
		ok     INTEGER NOT NULL,
		error  TEXT
	);`,
	// 2: desks, names, status age and harness/model/effort (protocol v1
	// additions). status is the status status_since belongs to.
	`ALTER TABLE worker ADD COLUMN name TEXT NOT NULL DEFAULT '';
	ALTER TABLE worker ADD COLUMN status TEXT NOT NULL DEFAULT '';
	ALTER TABLE worker ADD COLUMN status_since INTEGER NOT NULL DEFAULT 0;
	ALTER TABLE worker ADD COLUMN harness TEXT NOT NULL DEFAULT '';
	ALTER TABLE worker ADD COLUMN model TEXT NOT NULL DEFAULT '';
	ALTER TABLE worker ADD COLUMN effort TEXT NOT NULL DEFAULT '';
	CREATE TABLE desk_assignment (
		floor       TEXT NOT NULL,
		desk_index  INTEGER NOT NULL CHECK (desk_index >= 0),
		worker_uuid TEXT NOT NULL UNIQUE REFERENCES worker(id) ON DELETE CASCADE,
		PRIMARY KEY (floor, desk_index)
	);`,
	// 3: names move to worker_name, where a name has one owner per floor
	// and stays held from when the owner left (released_at) for the name
	// hold. Names already stored go to their most recently seen worker,
	// held (released_at NULL): the hub releases the ones whose owner is not
	// on the floor when it next observes it.
	`CREATE TABLE worker_name (
		floor       TEXT NOT NULL,
		name        TEXT NOT NULL CHECK (name <> ''),
		worker_uuid TEXT NOT NULL UNIQUE REFERENCES worker(id) ON DELETE CASCADE,
		released_at TEXT,
		PRIMARY KEY (floor, name)
	);
	INSERT INTO worker_name (floor, name, worker_uuid)
		SELECT w.session_name, w.name, w.id FROM worker w WHERE w.name <> '' AND w.id = (
			SELECT o.id FROM worker o WHERE o.session_name = w.session_name AND o.name = w.name
			ORDER BY o.last_seen_at DESC, o.id LIMIT 1);
	ALTER TABLE worker DROP COLUMN name;`,
	// 4: floor settings (floor_repo, NULL = unset; kept for sessions that
	// are gone) and the outcome of long commands in the audit log: a row
	// is written when a wake or sleep starts (done_at NULL) and completed
	// with its result (JSON) when it ends.
	`CREATE TABLE floor_repo (
		session_name   TEXT PRIMARY KEY,
		repo           TEXT,
		project_owner  TEXT,
		project_number INTEGER CHECK (project_number IS NULL OR project_number >= 1),
		status_field   TEXT,
		status_options TEXT,
		default_cwd    TEXT,
		hire_harness   TEXT,
		hire_model     TEXT,
		hire_effort    TEXT,
		updated_at     TEXT NOT NULL
	);
	ALTER TABLE audit_log ADD COLUMN result TEXT;
	ALTER TABLE audit_log ADD COLUMN done_at TEXT;
	UPDATE audit_log SET done_at = ts;`,
	// 5: hiring (M4). hired_at (unix ms, 0 = not hired by the bridge) and
	// the last harness/model/effort hired on each floor, the hire dialog's
	// remembered choice.
	`ALTER TABLE worker ADD COLUMN hired_at INTEGER NOT NULL DEFAULT 0;
	CREATE TABLE floor_hire_last (
		session_name TEXT PRIMARY KEY,
		harness      TEXT NOT NULL,
		model        TEXT NOT NULL,
		effort       TEXT NOT NULL,
		updated_at   TEXT NOT NULL
	);`,
	// 6: the branches the bridge made for worktree hires, by worker, with
	// the commit each was made from: send home deletes only a branch
	// recorded here for that worker. No foreign key: the row is written
	// before herdr's workspace is seen (and the worker row exists).
	`CREATE TABLE hire_branch (
		worker_uuid  TEXT PRIMARY KEY,
		session_name TEXT NOT NULL,
		repo_root    TEXT NOT NULL,
		branch       TEXT NOT NULL,
		base_sha     TEXT NOT NULL,
		created_at   TEXT NOT NULL
	);`,
	// M6 launch: team presets (roles as JSON), seeded once with "Build
	// team" (deleting it does not bring it back), the preset of each
	// floor's last run.start, and the runs started from the game.
	migrationLaunch,
	// M6 runs: an orchestrator's last known write-code phase and pass
	// (pass NULL = unknown), remembered when herdr drops the tokens.
	`CREATE TABLE worker_run (
		worker_uuid TEXT PRIMARY KEY REFERENCES worker(id) ON DELETE CASCADE,
		phase       TEXT NOT NULL,
		pass        INTEGER CHECK (pass IS NULL OR pass >= 0),
		updated_at  TEXT NOT NULL
	);`,
	// M7 boards: each floor's last good boards, the open pull requests at the
	// last good poll, the merges announced, and a hire's base branch.
	migrationBoards,
	// M3d building logos: the normalised PNG per building.
	migrationLogo,
	// #83: armed wrap-ups (and those needing you), resumed after a restart.
	migrationWrapUp,
	// #90: follow-up questions: the settings and the messages looked at.
	migrationFollowup,
	// #98: "Classify unknown commands": the settings and the model's answers.
	migrationActivity,
	// #106: dismissed inbox rows (a finished worker's, until its next done).
	migrationInbox,
	// #110: pack up on request: the settings.
	migrationPackup,
}

// Fingerprint kinds.
const (
	FPMarker       = "marker"
	FPAgentSession = "agent_session"
	FPLabelCwd     = "label_cwd"
)

// Store is an open database.
type Store struct {
	db  *sql.DB
	now func() time.Time
}

// Building is a stored building.
type Building struct {
	ID   string
	Name string
	Sort int
	// Logo is the hash of the building's logo ("" without one). Buildings
	// fills it in; the bytes are read with LogoOf.
	Logo string
}

// Assignment places a session on a floor of a building.
type Assignment struct {
	Session    string
	BuildingID string
	Index      int
}

// Fingerprint is one piece of identity evidence for a worker.
type Fingerprint struct {
	Kind  string
	Value string
}

// Worker is a stored worker identity.
type Worker struct {
	ID           string
	Session      string
	WorkspaceID  string
	Label        string
	Closed       bool
	Fingerprints []Fingerprint
	// Status is the last status seen and StatusSince (unix ms) when it
	// began; 0 means unknown.
	Status      string
	StatusSince int64
	Harness     string
	Model       string
	Effort      string
	// HiredAt is when the bridge hired the worker (unix ms), 0 if it did
	// not. Once set it is kept.
	HiredAt int64
}

// Desk is one desk slot on a floor, held by a worker.
type Desk struct {
	Floor    string
	Index    int
	WorkerID string
}

// NameClaim is a worker's name on a floor. A name has at most one owner
// per floor and a worker owns at most one name.
type NameClaim struct {
	Floor    string
	Name     string
	WorkerID string
	// Released is when the bridge saw the owner leave the floor; zero
	// while the owner is on it.
	Released time.Time
}

// Open opens (creating if needed) the database at path and migrates it.
// The parent directory is created 0700.
func Open(ctx context.Context, path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	q := url.Values{}
	q.Add("_pragma", "foreign_keys(1)")
	q.Add("_pragma", "busy_timeout(5000)")
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "synchronous(NORMAL)")
	db, err := sql.Open("sqlite", "file:"+path+"?"+q.Encode())
	if err != nil {
		return nil, err
	}
	// One writer (the hub); a single connection also keeps pragmas uniform.
	db.SetMaxOpenConns(1)
	s := &Store{db: db, now: time.Now}
	if err := s.migrate(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate %s: %w", path, err)
	}
	_ = os.Chmod(path, 0o600)
	return s, nil
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate(ctx context.Context) error {
	var v int
	if err := s.db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&v); err != nil {
		return err
	}
	if v > len(migrations) {
		return fmt.Errorf("database schema version %d is newer than this binary (%d)", v, len(migrations))
	}
	for i := v; i < len(migrations); i++ {
		err := s.tx(ctx, func(tx *sql.Tx) error {
			if _, err := tx.ExecContext(ctx, migrations[i]); err != nil {
				return err
			}
			_, err := tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", i+1))
			return err
		})
		if err != nil {
			return fmt.Errorf("migration %d: %w", i+1, err)
		}
	}
	return nil
}

func (s *Store) tx(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

func (s *Store) ts() string { return stamp(s.now()) }

func stamp(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

// Buildings returns every building in sort order.
func (s *Store) Buildings(ctx context.Context) ([]Building, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT b.id, b.name, b.sort, COALESCE(l.hash, '') FROM building b
		LEFT JOIN building_logo l ON l.building_id = b.id ORDER BY b.sort, b.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Building
	for rows.Next() {
		var b Building
		if err := rows.Scan(&b.ID, &b.Name, &b.Sort, &b.Logo); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// Assignments returns every floor assignment, by building and floor index.
func (s *Store) Assignments(ctx context.Context) ([]Assignment, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT session_name, building_id, floor_index FROM floor_assignment ORDER BY building_id, floor_index`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Assignment
	for rows.Next() {
		var a Assignment
		if err := rows.Scan(&a.Session, &a.BuildingID, &a.Index); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// CleanName trims and validates a building name.
func CleanName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > MaxNameLen {
		return "", fmt.Errorf("%w: building name must be 1-%d bytes", ErrInvalid, MaxNameLen)
	}
	return name, nil
}

func nameTaken(ctx context.Context, tx *sql.Tx, name, exceptID string) error {
	var n int
	err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM building WHERE lower(name) = lower(?) AND id != ?`, name, exceptID).Scan(&n)
	if err != nil {
		return err
	}
	if n > 0 {
		return fmt.Errorf("%w: %q", ErrNameTaken, name)
	}
	return nil
}

// CreateBuilding adds a building at the end of the sort order.
func (s *Store) CreateBuilding(ctx context.Context, id, name string) (Building, error) {
	name, err := CleanName(name)
	if err != nil {
		return Building{}, err
	}
	b := Building{ID: id, Name: name}
	err = s.tx(ctx, func(tx *sql.Tx) error {
		if err := nameTaken(ctx, tx, name, ""); err != nil {
			return err
		}
		if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(sort) + 1, 0) FROM building`).Scan(&b.Sort); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO building (id, name, sort, created_at) VALUES (?, ?, ?, ?)`, b.ID, b.Name, b.Sort, s.ts())
		return err
	})
	return b, err
}

// RenameBuilding renames a building.
func (s *Store) RenameBuilding(ctx context.Context, id, name string) error {
	name, err := CleanName(name)
	if err != nil {
		return err
	}
	return s.tx(ctx, func(tx *sql.Tx) error {
		if err := nameTaken(ctx, tx, name, id); err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `UPDATE building SET name = ? WHERE id = ?`, name, id)
		if err != nil {
			return err
		}
		return mustAffect(res, id)
	})
}

// DeleteBuilding deletes a building; its floors return to the unassigned lot.
func (s *Store) DeleteBuilding(ctx context.Context, id string) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `DELETE FROM building WHERE id = ?`, id)
		if err != nil {
			return err
		}
		if err := mustAffect(res, id); err != nil {
			return err
		}
		return renumberBuildings(ctx, tx)
	})
}

// HasBuilding reports whether a building exists.
func (s *Store) HasBuilding(ctx context.Context, id string) (bool, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM building WHERE id = ?`, id).Scan(&n)
	return n > 0, err
}

// ReorderBuildings sets the sort order; ids must list every building once.
func (s *Store) ReorderBuildings(ctx context.Context, ids []string) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		var n int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM building`).Scan(&n); err != nil {
			return err
		}
		seen := map[string]bool{}
		for _, id := range ids {
			seen[id] = true
		}
		if len(ids) != n || len(seen) != n {
			return fmt.Errorf("%w: ids must list each of the %d buildings exactly once", ErrInvalid, n)
		}
		for i, id := range ids {
			res, err := tx.ExecContext(ctx, `UPDATE building SET sort = ? WHERE id = ?`, i, id)
			if err != nil {
				return err
			}
			if err := mustAffect(res, id); err != nil {
				return err
			}
		}
		return nil
	})
}

func renumberBuildings(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, `SELECT id FROM building ORDER BY sort, id`)
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	rows.Close()
	for i, id := range ids {
		if _, err := tx.ExecContext(ctx, `UPDATE building SET sort = ? WHERE id = ?`, i, id); err != nil {
			return err
		}
	}
	return rows.Err()
}

// AssignFloor moves session into building at index (clamped; negative
// appends), shifting the other floors; buildingID "" unassigns it. Floor
// indexes stay dense (0..n-1) in every building touched.
func (s *Store) AssignFloor(ctx context.Context, session, buildingID string, index int) error {
	if session == "" {
		return fmt.Errorf("%w: session is required", ErrInvalid)
	}
	return s.tx(ctx, func(tx *sql.Tx) error {
		var old string
		err := tx.QueryRowContext(ctx, `SELECT building_id FROM floor_assignment WHERE session_name = ?`, session).Scan(&old)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if buildingID != "" {
			var n int
			if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM building WHERE id = ?`, buildingID).Scan(&n); err != nil {
				return err
			}
			if n == 0 {
				return fmt.Errorf("%w: building %q", ErrNotFound, buildingID)
			}
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM floor_assignment WHERE session_name = ?`, session); err != nil {
			return err
		}
		if old != "" && old != buildingID {
			if err := writeFloors(ctx, tx, old, nil); err != nil {
				return err
			}
		}
		if buildingID == "" {
			return nil
		}
		floors, err := buildingFloors(ctx, tx, buildingID)
		if err != nil {
			return err
		}
		if index < 0 || index > len(floors) {
			index = len(floors)
		}
		floors = append(floors[:index], append([]string{session}, floors[index:]...)...)
		return writeFloors(ctx, tx, buildingID, floors)
	})
}

func buildingFloors(ctx context.Context, tx *sql.Tx, buildingID string) ([]string, error) {
	rows, err := tx.QueryContext(ctx, `SELECT session_name FROM floor_assignment WHERE building_id = ? ORDER BY floor_index, session_name`, buildingID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

// writeFloors rewrites a building's floors densely; nil re-reads them.
func writeFloors(ctx context.Context, tx *sql.Tx, buildingID string, floors []string) error {
	if floors == nil {
		var err error
		if floors, err = buildingFloors(ctx, tx, buildingID); err != nil {
			return err
		}
	}
	for i, name := range floors {
		_, err := tx.ExecContext(ctx, `INSERT INTO floor_assignment (session_name, building_id, floor_index) VALUES (?, ?, ?)
			ON CONFLICT(session_name) DO UPDATE SET building_id = excluded.building_id, floor_index = excluded.floor_index`,
			name, buildingID, i)
		if err != nil {
			return err
		}
	}
	return nil
}

func mustAffect(res sql.Result, id string) error {
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return fmt.Errorf("%w: building %q", ErrNotFound, id)
	}
	return nil
}

// Audit records one command that is done: accepted or rejected.
func (s *Store) Audit(ctx context.Context, client, cmd string, args json.RawMessage, cmdErr error) error {
	now := s.ts()
	_, err := s.db.ExecContext(ctx, `INSERT INTO audit_log (ts, client, cmd, args, ok, error, done_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		now, client, cmd, auditArgs(args), cmdErr == nil, errText(cmdErr), now)
	return err
}

// AuditBegin records a long command that was accepted and is starting; it
// stays in progress (not done, not ok) until AuditEnd. It returns the row.
func (s *Store) AuditBegin(ctx context.Context, client, cmd string, args json.RawMessage) (int64, error) {
	res, err := s.db.ExecContext(ctx, `INSERT INTO audit_log (ts, client, cmd, args, ok) VALUES (?, ?, ?, ?, 0)`,
		s.ts(), client, cmd, auditArgs(args))
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// AuditEnd completes a row from AuditBegin with the command's outcome and
// result (stored as JSON; nil for none).
func (s *Store) AuditEnd(ctx context.Context, id int64, cmdErr error, result any) error {
	var text any
	if result != nil {
		b, err := json.Marshal(result)
		if err != nil {
			return err
		}
		text = string(b)
	}
	_, err := s.db.ExecContext(ctx, `UPDATE audit_log SET ok = ?, error = ?, result = ?, done_at = ? WHERE id = ?`,
		cmdErr == nil, errText(cmdErr), text, s.ts(), id)
	return err
}

func auditArgs(args json.RawMessage) string {
	if len(args) == 0 {
		return "{}"
	}
	return string(args)
}

func errText(err error) any {
	if err == nil {
		return nil
	}
	return err.Error()
}

// AuditEntry is one audit_log row.
type AuditEntry struct {
	Client, Cmd, Args string
	OK                bool
	Error             string
	// Result is the JSON outcome of a long command ("" for none); Done is
	// false while it is still running (or the bridge stopped during it).
	Result string
	Done   bool
}

// AuditLog returns the audit log, oldest first.
func (s *Store) AuditLog(ctx context.Context) ([]AuditEntry, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT client, cmd, args, ok, COALESCE(error, ''), COALESCE(result, ''), done_at IS NOT NULL
		FROM audit_log ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AuditEntry
	for rows.Next() {
		var e AuditEntry
		if err := rows.Scan(&e.Client, &e.Cmd, &e.Args, &e.OK, &e.Error, &e.Result, &e.Done); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// SessionWorkers returns every stored worker of a session with its
// fingerprints: the identity candidates for reconciliation.
func (s *Store) SessionWorkers(ctx context.Context, session string) ([]Worker, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT w.id, w.workspace_id, w.label, w.closed_at IS NOT NULL,
			w.status, w.status_since, w.harness, w.model, w.effort, w.hired_at, f.kind, f.value
		FROM worker w LEFT JOIN worker_fingerprint f ON f.worker_id = w.id
		WHERE w.session_name = ? ORDER BY w.last_seen_at DESC, w.id, f.kind, f.value`, session)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Worker
	idx := map[string]int{}
	for rows.Next() {
		var w Worker
		var kind, value sql.NullString
		if err := rows.Scan(&w.ID, &w.WorkspaceID, &w.Label, &w.Closed,
			&w.Status, &w.StatusSince, &w.Harness, &w.Model, &w.Effort, &w.HiredAt, &kind, &value); err != nil {
			return nil, err
		}
		i, ok := idx[w.ID]
		if !ok {
			w.Session = session
			i = len(out)
			idx[w.ID] = i
			out = append(out, w)
		}
		if kind.Valid {
			out[i].Fingerprints = append(out[i].Fingerprints, Fingerprint{kind.String, value.String})
		}
	}
	return out, rows.Err()
}

// SaveWorker upserts a worker (reopening it if it was closed) and adds its
// current fingerprints; older fingerprints are kept as further evidence.
func (s *Store) SaveWorker(ctx context.Context, w Worker) error {
	now := s.ts()
	return s.tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO worker (id, session_name, workspace_id, label, created_at, last_seen_at,
				status, status_since, harness, model, effort, hired_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET session_name = excluded.session_name, workspace_id = excluded.workspace_id,
				label = excluded.label, last_seen_at = excluded.last_seen_at, closed_at = NULL,
				status = excluded.status, status_since = excluded.status_since,
				harness = excluded.harness, model = excluded.model, effort = excluded.effort,
				hired_at = CASE WHEN excluded.hired_at > 0 THEN excluded.hired_at ELSE worker.hired_at END`,
			w.ID, w.Session, w.WorkspaceID, w.Label, now, now, w.Status, w.StatusSince, w.Harness, w.Model, w.Effort, w.HiredAt)
		if err != nil {
			return err
		}
		for _, fp := range w.Fingerprints {
			_, err := tx.ExecContext(ctx, `INSERT INTO worker_fingerprint (worker_id, kind, value, last_seen_at) VALUES (?, ?, ?, ?)
				ON CONFLICT(worker_id, kind, value) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
				w.ID, fp.Kind, fp.Value, now)
			if err != nil {
				return err
			}
		}
		return nil
	})
}

// CloseWorker records that the bridge saw a worker's workspace close.
func (s *Store) CloseWorker(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE worker SET closed_at = ? WHERE id = ?`, s.ts(), id)
	return err
}

// SetWorkerStatus records a worker's status and since when it has it (unix
// ms): the hot path, cheaper than SaveWorker.
func (s *Store) SetWorkerStatus(ctx context.Context, id, status string, since int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE worker SET status = ?, status_since = ? WHERE id = ?`, status, since, id)
	return err
}

// Desks returns every desk assignment, by floor and index.
func (s *Store) Desks(ctx context.Context) ([]Desk, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT floor, desk_index, worker_uuid FROM desk_assignment ORDER BY floor, desk_index`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Desk
	for rows.Next() {
		var d Desk
		if err := rows.Scan(&d.Floor, &d.Index, &d.WorkerID); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// AssignDesk gives a stored worker desk index on floor, moving it off any
// desk it had. The desk must be free.
func (s *Store) AssignDesk(ctx context.Context, floor string, index int, workerID string) error {
	if index < 0 {
		return fmt.Errorf("%w: desk index %d", ErrInvalid, index)
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO desk_assignment (floor, desk_index, worker_uuid) VALUES (?, ?, ?)
		ON CONFLICT(worker_uuid) DO UPDATE SET floor = excluded.floor, desk_index = excluded.desk_index`,
		floor, index, workerID)
	return err
}

// FreeDesk frees whatever desk a worker holds.
func (s *Store) FreeDesk(ctx context.Context, workerID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM desk_assignment WHERE worker_uuid = ?`, workerID)
	return err
}

// FreeFloorDesks frees every desk of a floor.
func (s *Store) FreeFloorDesks(ctx context.Context, floor string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM desk_assignment WHERE floor = ?`, floor)
	return err
}

// Names returns every name claim, by floor and name. A released_at that
// does not parse reads as released long ago.
func (s *Store) Names(ctx context.Context) ([]NameClaim, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT floor, name, worker_uuid, released_at FROM worker_name ORDER BY floor, name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []NameClaim
	for rows.Next() {
		var c NameClaim
		var released sql.NullString
		if err := rows.Scan(&c.Floor, &c.Name, &c.WorkerID, &released); err != nil {
			return nil, err
		}
		if released.Valid {
			if c.Released, err = time.Parse(time.RFC3339Nano, released.String); err != nil {
				c.Released = time.Unix(0, 0)
			}
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ClaimName gives a stored worker a name on floor, held (not released):
// it takes the name from any previous owner and drops any other name the
// worker had.
func (s *Store) ClaimName(ctx context.Context, floor, name, workerID string) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `DELETE FROM worker_name WHERE worker_uuid = ? AND NOT (floor = ? AND name = ?)`,
			workerID, floor, name)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO worker_name (floor, name, worker_uuid) VALUES (?, ?, ?)
			ON CONFLICT(floor, name) DO UPDATE SET worker_uuid = excluded.worker_uuid, released_at = NULL`,
			floor, name, workerID)
		return err
	})
}

// ReleaseName records when the bridge saw a worker leave the floor of the
// name it owns. An earlier release time is kept.
func (s *Store) ReleaseName(ctx context.Context, workerID string, at time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE worker_name SET released_at = ? WHERE worker_uuid = ? AND released_at IS NULL`,
		stamp(at), workerID)
	return err
}
