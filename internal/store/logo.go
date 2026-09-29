package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// migrationLogo adds M3d's building logos: the normalised PNG itself, kept
// with its hash (sha256 of those bytes) and size. A building's delete takes
// its logo with it.
const migrationLogo = `CREATE TABLE building_logo (
		building_id TEXT PRIMARY KEY REFERENCES building(id) ON DELETE CASCADE,
		hash        TEXT NOT NULL,
		data        BLOB NOT NULL,
		w           INTEGER NOT NULL,
		h           INTEGER NOT NULL,
		updated_at  TEXT NOT NULL
	);`

// Logo is a building's stored logo: PNG bytes and their hash.
type Logo struct {
	Hash string
	PNG  []byte
	W, H int
}

// SetLogo stores (or replaces) the logo of a building. It returns ErrNotFound
// when the building does not exist.
func (s *Store) SetLogo(ctx context.Context, buildingID string, l Logo) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if err := buildingExists(ctx, tx, buildingID); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO building_logo (building_id, hash, data, w, h, updated_at) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(building_id) DO UPDATE SET hash = excluded.hash, data = excluded.data, w = excluded.w, h = excluded.h, updated_at = excluded.updated_at`,
			buildingID, l.Hash, l.PNG, l.W, l.H, s.ts())
		return err
	})
}

// ClearLogo removes the logo of a building. A building without one is not an
// error; a missing building is (ErrNotFound).
func (s *Store) ClearLogo(ctx context.Context, buildingID string) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if err := buildingExists(ctx, tx, buildingID); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `DELETE FROM building_logo WHERE building_id = ?`, buildingID)
		return err
	})
}

// LogoOf returns the logo of a building, or ErrNotFound when the building or
// its logo does not exist.
func (s *Store) LogoOf(ctx context.Context, buildingID string) (Logo, error) {
	var l Logo
	err := s.db.QueryRowContext(ctx, `SELECT hash, data, w, h FROM building_logo WHERE building_id = ?`, buildingID).Scan(&l.Hash, &l.PNG, &l.W, &l.H)
	if errors.Is(err, sql.ErrNoRows) {
		return Logo{}, fmt.Errorf("%w: no logo for building %q", ErrNotFound, buildingID)
	}
	return l, err
}

func buildingExists(ctx context.Context, tx *sql.Tx, id string) error {
	var n int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM building WHERE id = ?`, id).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		return fmt.Errorf("%w: building %q", ErrNotFound, id)
	}
	return nil
}
