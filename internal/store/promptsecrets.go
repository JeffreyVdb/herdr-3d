package store

// #108: "Review prompt secrets before sending" (bridge-wide, one row; none
// is off), and the ownership of the protected files: which opaque owner
// directory belongs to which worker (or pending owner, with its expiry),
// and the opaque names of its files. Never a secret byte, and never a path's
// contents: the files live in a private runtime directory (secretfiles).

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// migrationPromptSecrets creates the switch and the ownership tables.
const migrationPromptSecrets = `CREATE TABLE prompt_secrets_settings (
		id         INTEGER PRIMARY KEY CHECK (id = 1),
		enabled    INTEGER NOT NULL,
		updated_at TEXT NOT NULL
	);
	CREATE TABLE prompt_secret_owner (
		dir        TEXT PRIMARY KEY,
		kind       TEXT NOT NULL CHECK (kind IN ('worker', 'pending')),
		owner_id   TEXT NOT NULL,
		created_at TEXT NOT NULL,
		expires_at INTEGER
	);
	CREATE INDEX prompt_secret_owner_by_owner ON prompt_secret_owner (kind, owner_id);
	CREATE TABLE prompt_secret_file (
		dir        TEXT NOT NULL REFERENCES prompt_secret_owner(dir) ON DELETE CASCADE,
		name       TEXT NOT NULL,
		created_at TEXT NOT NULL,
		PRIMARY KEY (dir, name)
	);`

// migrationPromptSecretsReviewed (#108 round 2) records on a stored prompt
// (a schedule's, a hire preset's) that it was reviewed with the switch on
// and every possible secret in it left as typed: a digest of the rule set,
// the text and its candidates (promptsecret.StoredDigest; the prompt is
// stored as plain text beside it, so the digest tells nothing more). An
// empty one is none: saved before the switch was on, or while it was off.
const migrationPromptSecretsReviewed = `ALTER TABLE schedule ADD COLUMN secrets_review TEXT NOT NULL DEFAULT '';
	ALTER TABLE hire_preset ADD COLUMN secrets_review TEXT NOT NULL DEFAULT '';`

// migrationPromptSecretsLeases (#108 round 5): a lease is a worker that
// holds a protected file it does not own (a handoff's successor): the file
// lives while its owner or any of its holders does, and goes with every
// holder's row when it is removed. A handoff's files are the protected
// files its text named when it was filed (the document and the instruction
// it was written from), for a worker hired from it to hold. Both are opaque
// names only, and go with the file (and the handoff) they belong to.
const migrationPromptSecretsLeases = `CREATE TABLE prompt_secret_lease (
		dir        TEXT NOT NULL,
		name       TEXT NOT NULL,
		worker_id  TEXT NOT NULL,
		created_at TEXT NOT NULL,
		PRIMARY KEY (dir, name, worker_id),
		FOREIGN KEY (dir, name) REFERENCES prompt_secret_file(dir, name) ON DELETE CASCADE
	);
	CREATE INDEX prompt_secret_lease_by_worker ON prompt_secret_lease (worker_id);
	CREATE TABLE prompt_secret_handoff (
		handoff_id INTEGER NOT NULL REFERENCES handoff(id) ON DELETE CASCADE,
		dir        TEXT NOT NULL,
		name       TEXT NOT NULL,
		PRIMARY KEY (handoff_id, dir, name),
		FOREIGN KEY (dir, name) REFERENCES prompt_secret_file(dir, name) ON DELETE CASCADE
	);`

// LoadPromptSecrets returns whether prompts are reviewed for secrets
// (never set: off).
func (s *Store) LoadPromptSecrets(ctx context.Context) (enabled bool, err error) {
	err = s.db.QueryRowContext(ctx, `SELECT enabled FROM prompt_secrets_settings WHERE id = 1`).Scan(&enabled)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return enabled, err
}

// SavePromptSecrets stores the switch.
func (s *Store) SavePromptSecrets(ctx context.Context, enabled bool) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO prompt_secrets_settings (id, enabled, updated_at) VALUES (1, ?, ?)
		ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`, enabled, s.ts())
	return err
}

// Kinds of SecretOwner.
const (
	SecretOwnerWorker  = "worker"
	SecretOwnerPending = "pending"
)

// SecretOwner is one owner directory of protected files: its opaque name,
// whose it is (a worker's id, or a pending owner's token) and, for a pending
// owner, when it expires.
type SecretOwner struct {
	Dir       string
	Kind      string
	OwnerID   string
	CreatedAt time.Time
	ExpiresAt time.Time // zero: none
}

// AddSecretOwner records a new owner directory.
func (s *Store) AddSecretOwner(ctx context.Context, o SecretOwner) error {
	var exp any
	if !o.ExpiresAt.IsZero() {
		exp = o.ExpiresAt.UnixMilli()
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO prompt_secret_owner (dir, kind, owner_id, created_at, expires_at)
		VALUES (?, ?, ?, ?, ?)`, o.Dir, o.Kind, o.OwnerID, s.ts(), exp)
	return err
}

// SecretOwners returns every owner directory, by name.
func (s *Store) SecretOwners(ctx context.Context) ([]SecretOwner, error) {
	return s.secretOwners(ctx, `SELECT dir, kind, owner_id, created_at, expires_at FROM prompt_secret_owner ORDER BY dir`)
}

// SecretOwnersOf returns one owner's directories.
func (s *Store) SecretOwnersOf(ctx context.Context, kind, ownerID string) ([]SecretOwner, error) {
	return s.secretOwners(ctx, `SELECT dir, kind, owner_id, created_at, expires_at FROM prompt_secret_owner
		WHERE kind = ? AND owner_id = ? ORDER BY dir`, kind, ownerID)
}

func (s *Store) secretOwners(ctx context.Context, q string, args ...any) ([]SecretOwner, error) {
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SecretOwner
	for rows.Next() {
		var o SecretOwner
		var created string
		var exp sql.NullInt64
		if err := rows.Scan(&o.Dir, &o.Kind, &o.OwnerID, &created, &exp); err != nil {
			return nil, err
		}
		o.CreatedAt, _ = time.Parse(time.RFC3339Nano, created)
		if exp.Valid {
			o.ExpiresAt = time.UnixMilli(exp.Int64)
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// ClaimSecretOwner gives a pending owner's directories that have not
// expired by now to a worker, for good (no expiry): how many there were.
func (s *Store) ClaimSecretOwner(ctx context.Context, token, workerID string, now time.Time) (int, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE prompt_secret_owner SET kind = 'worker', owner_id = ?, expires_at = NULL
		WHERE kind = 'pending' AND owner_id = ? AND (expires_at IS NULL OR expires_at > ?)`, workerID, token, now.UnixMilli())
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	return int(n), err
}

// RemoveSecretOwner forgets an owner directory and its files.
func (s *Store) RemoveSecretOwner(ctx context.Context, dir string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM prompt_secret_owner WHERE dir = ?`, dir)
	return err
}

// AddSecretFile records a file of an owner directory.
func (s *Store) AddSecretFile(ctx context.Context, dir, name string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO prompt_secret_file (dir, name, created_at) VALUES (?, ?, ?)`, dir, name, s.ts())
	return err
}

// RemoveSecretFile forgets one file.
func (s *Store) RemoveSecretFile(ctx context.Context, dir, name string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM prompt_secret_file WHERE dir = ? AND name = ?`, dir, name)
	return err
}

// SecretFiles returns an owner directory's file names.
func (s *Store) SecretFiles(ctx context.Context, dir string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT name FROM prompt_secret_file WHERE dir = ? ORDER BY name`, dir)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// SecretFile is one protected file by its owner directory's and its own
// names.
type SecretFile struct{ Dir, Name string }

// SecretLease is a worker that holds a file it does not own (round 5).
type SecretLease struct {
	SecretFile
	WorkerID string
}

// AddSecretLease lets worker hold a file it does not own: false when the
// file has no row, the worker owns its directory, or holds it already.
func (s *Store) AddSecretLease(ctx context.Context, f SecretFile, workerID string) (bool, error) {
	res, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO prompt_secret_lease (dir, name, worker_id, created_at)
		SELECT f.dir, f.name, ?, ? FROM prompt_secret_file f JOIN prompt_secret_owner o ON o.dir = f.dir
		WHERE f.dir = ? AND f.name = ? AND NOT (o.kind = 'worker' AND o.owner_id = ?)`, workerID, s.ts(), f.Dir, f.Name, workerID)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// SecretLeases returns every lease, by file.
func (s *Store) SecretLeases(ctx context.Context) ([]SecretLease, error) {
	return s.secretLeases(ctx, `SELECT dir, name, worker_id FROM prompt_secret_lease ORDER BY dir, name, worker_id`)
}

// SecretLeasesOf returns the files a worker holds by a lease.
func (s *Store) SecretLeasesOf(ctx context.Context, workerID string) ([]SecretLease, error) {
	return s.secretLeases(ctx, `SELECT dir, name, worker_id FROM prompt_secret_lease WHERE worker_id = ? ORDER BY dir, name`, workerID)
}

func (s *Store) secretLeases(ctx context.Context, q string, args ...any) ([]SecretLease, error) {
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SecretLease
	for rows.Next() {
		var l SecretLease
		if err := rows.Scan(&l.Dir, &l.Name, &l.WorkerID); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// RemoveSecretLeasesOf forgets every lease of a worker.
func (s *Store) RemoveSecretLeasesOf(ctx context.Context, workerID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM prompt_secret_lease WHERE worker_id = ?`, workerID)
	return err
}

// SecretFileCounts returns how many protected files each worker holds: in
// its own directories and by a lease (a worker with none is absent).
func (s *Store) SecretFileCounts(ctx context.Context) (map[string]int, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT worker, COUNT(*) FROM (
			SELECT o.owner_id AS worker, f.dir, f.name FROM prompt_secret_file f JOIN prompt_secret_owner o ON o.dir = f.dir
			WHERE o.kind = 'worker'
			UNION SELECT worker_id, dir, name FROM prompt_secret_lease
		) GROUP BY worker`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var id string
		var n int
		if err := rows.Scan(&id, &n); err != nil {
			return nil, err
		}
		out[id] = n
	}
	return out, rows.Err()
}

// AddHandoffSecrets records the protected files a filed handoff names (those
// with a row): how many were new.
func (s *Store) AddHandoffSecrets(ctx context.Context, handoffID int64, files []SecretFile) (int, error) {
	n := 0
	err := s.tx(ctx, func(tx *sql.Tx) error {
		for _, f := range files {
			res, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO prompt_secret_handoff (handoff_id, dir, name)
				SELECT ?, dir, name FROM prompt_secret_file WHERE dir = ? AND name = ?`, handoffID, f.Dir, f.Name)
			if err != nil {
				return err
			}
			k, err := res.RowsAffected()
			if err != nil {
				return err
			}
			n += int(k)
		}
		return nil
	})
	return n, err
}

// HandoffSecretsAt returns the protected files the handoff filed at path
// names that are still there.
func (s *Store) HandoffSecretsAt(ctx context.Context, path string) ([]SecretFile, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT r.dir, r.name FROM prompt_secret_handoff r JOIN handoff h ON h.id = r.handoff_id
		WHERE h.path = ? ORDER BY r.dir, r.name`, path)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SecretFile
	for rows.Next() {
		var f SecretFile
		if err := rows.Scan(&f.Dir, &f.Name); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// OpenWorkers returns the ids of the workers not closed (a worker on an
// asleep floor, or of a herdr session that is gone, is open).
func (s *Store) OpenWorkers(ctx context.Context) (map[string]bool, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id FROM worker WHERE closed_at IS NULL`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}
