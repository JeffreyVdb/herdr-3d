package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// #58 virtual floors. A floor id names a floor: a real floor's id is its
// herdr session's name, a virtual floor's id is "v-" and 12 lower-case hex
// digits. Every floor-keyed table (desk_assignment.floor, worker_name.floor,
// floor_repo, floor_hire_last, floor_preset_last, board_cache, board_open_pr,
// board_merge_announced, floor_assignment, handoff*.floor) holds floor ids
// in its old session_name / floor column: a real floor's id is the name it
// was stored under, so no existing row changes. worker.session_name and
// run_launch.session stay the herdr session (where the workspace lives);
// their new floor_id is the floor the worker belongs to.
//
// floor_hidden is the per-floor "hidden" setting (decision 2): a row means
// the floor is hidden. It is its own table because a floor_repo row goes
// away when every setting is cleared.
const migrationVirtualFloors = `CREATE TABLE virtual_floor (
		id           TEXT PRIMARY KEY,
		name         TEXT NOT NULL,
		base_session TEXT NOT NULL,
		created_at   TEXT NOT NULL
	);
	CREATE INDEX virtual_floor_base ON virtual_floor(base_session);
	CREATE TABLE floor_hidden (
		floor      TEXT PRIMARY KEY,
		updated_at TEXT NOT NULL
	);
	ALTER TABLE worker ADD COLUMN floor_id TEXT NOT NULL DEFAULT '';
	UPDATE worker SET floor_id = session_name;
	CREATE INDEX worker_floor ON worker(floor_id);
	ALTER TABLE run_launch ADD COLUMN floor_id TEXT NOT NULL DEFAULT '';
	UPDATE run_launch SET floor_id = session;`

// MaxFloorNameLen bounds a virtual floor's display name, in bytes.
const MaxFloorNameLen = 64

var virtualFloorIDRe = regexp.MustCompile(`^v-[0-9a-f]{12}$`)

// IsVirtualFloorID reports whether id has the shape of a virtual floor's id.
// Such an id is also a safe single path component. The shape checks an id
// being minted; it does not say a floor is virtual (a real session may have
// such a name from before herdr.CheckNewSessionName reserved it): a virtual
// floor is one virtual_floor defines.
func IsVirtualFloorID(id string) bool { return virtualFloorIDRe.MatchString(id) }

// ErrFloorExists is a virtual floor id that is already taken.
var ErrFloorExists = errors.New("floor exists")

// ErrFloorHasWorkers refuses to delete a virtual floor that still has
// workers.
var ErrFloorHasWorkers = errors.New("floor has workers")

// VirtualFloor is a user-defined floor on a base herdr session.
type VirtualFloor struct {
	ID          string
	Name        string
	BaseSession string
	CreatedAt   time.Time
}

// CleanFloorName trims and validates a virtual floor's display name: free
// text, 1-64 bytes, no control characters.
func CleanFloorName(name string) (string, error) {
	name = strings.TrimSpace(name)
	switch {
	case name == "":
		return "", fmt.Errorf("%w: floor name is required", ErrInvalid)
	case len(name) > MaxFloorNameLen:
		return "", fmt.Errorf("%w: floor name is longer than %d bytes", ErrInvalid, MaxFloorNameLen)
	case !utf8.ValidString(name) || strings.ContainsFunc(name, unicode.IsControl):
		return "", fmt.Errorf("%w: floor name has control characters", ErrInvalid)
	}
	return name, nil
}

// VirtualFloors returns every virtual floor, oldest first.
func (s *Store) VirtualFloors(ctx context.Context) ([]VirtualFloor, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, base_session, created_at FROM virtual_floor ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []VirtualFloor
	for rows.Next() {
		var v VirtualFloor
		var created string
		if err := rows.Scan(&v.ID, &v.Name, &v.BaseSession, &created); err != nil {
			return nil, err
		}
		if v.CreatedAt, err = time.Parse(time.RFC3339Nano, created); err != nil {
			v.CreatedAt = time.Unix(0, 0)
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// CreateVirtualFloor stores a new virtual floor. The caller mints the id and
// checks it against the herdr sessions; this refuses an id of the wrong
// shape or one already taken, and a base that is itself a virtual floor.
// When the base session's floor is in a building, the new floor joins that
// building last (decision 4).
func (s *Store) CreateVirtualFloor(ctx context.Context, id, name, base string) (VirtualFloor, error) {
	if !IsVirtualFloorID(id) {
		return VirtualFloor{}, fmt.Errorf("%w: virtual floor id %q", ErrInvalid, id)
	}
	if base == "" {
		return VirtualFloor{}, fmt.Errorf("%w: base session is required", ErrInvalid)
	}
	name, err := CleanFloorName(name)
	if err != nil {
		return VirtualFloor{}, err
	}
	now := s.now().UTC()
	err = s.tx(ctx, func(tx *sql.Tx) error {
		var n int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM virtual_floor WHERE id = ?`, id).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			return fmt.Errorf("%w: %q", ErrFloorExists, id)
		}
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM virtual_floor WHERE id = ?`, base).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			return fmt.Errorf("%w: base session %q is a virtual floor", ErrInvalid, base)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO virtual_floor (id, name, base_session, created_at) VALUES (?, ?, ?, ?)`,
			id, name, base, now.Format(time.RFC3339Nano)); err != nil {
			return err
		}
		building, err := assignedBuilding(ctx, tx, base)
		if err != nil || building == "" {
			return err
		}
		floors, err := buildingFloors(ctx, tx, building)
		if err != nil {
			return err
		}
		return writeFloors(ctx, tx, building, append(floors, id))
	})
	if err != nil {
		return VirtualFloor{}, err
	}
	return VirtualFloor{ID: id, Name: name, BaseSession: base, CreatedAt: now}, nil
}

// RenameVirtualFloor sets a virtual floor's display name.
func (s *Store) RenameVirtualFloor(ctx context.Context, id, name string) error {
	name, err := CleanFloorName(name)
	if err != nil {
		return err
	}
	res, err := s.db.ExecContext(ctx, `UPDATE virtual_floor SET name = ? WHERE id = ?`, name, id)
	if err != nil {
		return err
	}
	if n, err := res.RowsAffected(); err != nil || n == 0 {
		if err == nil {
			err = fmt.Errorf("%w: virtual floor %q", ErrNotFound, id)
		}
		return err
	}
	return nil
}

// FloorWorkers returns the open (not closed) stored workers attributed to a
// floor.
func (s *Store) FloorWorkers(ctx context.Context, floor string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id FROM worker WHERE floor_id = ? AND closed_at IS NULL ORDER BY id`, floor)
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

// SetWorkerFloor attributes a stored worker to a floor.
func (s *Store) SetWorkerFloor(ctx context.Context, workerID, floor string) error {
	if floor == "" {
		return fmt.Errorf("%w: floor is required", ErrInvalid)
	}
	_, err := s.db.ExecContext(ctx, `UPDATE worker SET floor_id = ? WHERE id = ?`, floor, workerID)
	return err
}

// DeleteVirtualFloor removes a virtual floor and the rows keyed by it:
// desks, names, settings, last hire, last preset, board caches, its place in
// a building and its hidden flag. Unless moveWorkers, it refuses
// (ErrFloorHasWorkers) while an open stored worker is attributed to it;
// with it, they go back to their session's real floor, as closed ones
// always do. Handoffs are kept.
func (s *Store) DeleteVirtualFloor(ctx context.Context, id string, moveWorkers bool) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		var n int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM virtual_floor WHERE id = ?`, id).Scan(&n); err != nil {
			return err
		}
		if n == 0 {
			return fmt.Errorf("%w: virtual floor %q", ErrNotFound, id)
		}
		if moveWorkers {
			n = 0
		} else if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM worker WHERE floor_id = ? AND closed_at IS NULL`, id).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			return fmt.Errorf("%w: %s", ErrFloorHasWorkers, workerCount(n))
		}
		building, err := assignedBuilding(ctx, tx, id)
		if err != nil {
			return err
		}
		for _, q := range []string{
			`UPDATE worker SET floor_id = session_name WHERE floor_id = ?`,
			`DELETE FROM desk_assignment WHERE floor = ?`,
			`DELETE FROM worker_name WHERE floor = ?`,
			`DELETE FROM floor_repo WHERE session_name = ?`,
			`DELETE FROM floor_hire_last WHERE session_name = ?`,
			`DELETE FROM floor_preset_last WHERE session_name = ?`,
			`DELETE FROM board_cache WHERE session_name = ?`,
			`DELETE FROM board_open_pr WHERE session_name = ?`,
			`DELETE FROM board_merge_announced WHERE session_name = ?`,
			`DELETE FROM floor_assignment WHERE session_name = ?`,
			`DELETE FROM floor_hidden WHERE floor = ?`,
			`DELETE FROM virtual_floor WHERE id = ?`,
		} {
			if _, err := tx.ExecContext(ctx, q, id); err != nil {
				return err
			}
		}
		if building != "" {
			return writeFloors(ctx, tx, building, nil)
		}
		return nil
	})
}

func workerCount(n int) string {
	if n == 1 {
		return "1 worker"
	}
	return fmt.Sprintf("%d workers", n)
}

// HiddenFloors returns the floors whose hidden setting is on.
func (s *Store) HiddenFloors(ctx context.Context) (map[string]bool, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT floor FROM floor_hidden`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var f string
		if err := rows.Scan(&f); err != nil {
			return nil, err
		}
		out[f] = true
	}
	return out, rows.Err()
}

// SetFloorHidden turns a floor's hidden setting on or off.
func (s *Store) SetFloorHidden(ctx context.Context, floor string, hidden bool) error {
	if floor == "" {
		return fmt.Errorf("%w: floor is required", ErrInvalid)
	}
	if !hidden {
		_, err := s.db.ExecContext(ctx, `DELETE FROM floor_hidden WHERE floor = ?`, floor)
		return err
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO floor_hidden (floor, updated_at) VALUES (?, ?)
		ON CONFLICT(floor) DO UPDATE SET updated_at = excluded.updated_at`, floor, s.ts())
	return err
}

// assignedBuilding is the building a floor is in, "" when none.
func assignedBuilding(ctx context.Context, tx *sql.Tx, floor string) (string, error) {
	var b string
	err := tx.QueryRowContext(ctx, `SELECT building_id FROM floor_assignment WHERE session_name = ?`, floor).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return b, err
}

// virtualBase is a virtual floor's base session ("" for any other floor).
func virtualBase(ctx context.Context, tx *sql.Tx, floor string) (string, error) {
	var b string
	err := tx.QueryRowContext(ctx, `SELECT base_session FROM virtual_floor WHERE id = ?`, floor).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return b, err
}

// virtualFloorsOf lists a session's virtual floors in the order they stand
// in their building (unplaced ones last, oldest first).
func virtualFloorsOf(ctx context.Context, tx *sql.Tx, base string) ([]string, error) {
	rows, err := tx.QueryContext(ctx, `SELECT v.id FROM virtual_floor v LEFT JOIN floor_assignment a ON a.session_name = v.id
		WHERE v.base_session = ? ORDER BY a.floor_index IS NULL, a.floor_index, v.created_at, v.id`, base)
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
