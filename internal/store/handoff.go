package store

// #223: the filing cabinet's handoffs and their full-text index. A row is a
// Markdown file internal/handoff wrote under the handoff directory; the file
// is the record, the row and its handoff_fts row (rowid = handoff.id) what
// the cabinet lists and searches. A handoff outlives its worker (no foreign
// key): worker_uuid and worker_name are as they were when it was filed.

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"
)

// migrationHandoff creates handoff and handoff_fts. source is literal (#223)
// or the later generated modes, agent and llm; op is the filing operation's
// idempotency key (NULL for a file registered by the startup reconcile).
const migrationHandoff = `CREATE TABLE handoff (
		id            INTEGER PRIMARY KEY,
		floor         TEXT NOT NULL,
		worker_uuid   TEXT NOT NULL DEFAULT '',
		worker_name   TEXT NOT NULL DEFAULT '',
		label         TEXT NOT NULL DEFAULT '',
		harness       TEXT NOT NULL DEFAULT '',
		model         TEXT NOT NULL DEFAULT '',
		cwd           TEXT NOT NULL DEFAULT '',
		branch        TEXT NOT NULL DEFAULT '',
		agent_session TEXT NOT NULL DEFAULT '',
		path          TEXT NOT NULL UNIQUE,
		title         TEXT NOT NULL,
		created_at    INTEGER NOT NULL,
		source        TEXT NOT NULL CHECK (source IN ('literal', 'agent', 'llm')),
		source_turn   TEXT NOT NULL DEFAULT '',
		source_items  TEXT NOT NULL DEFAULT '',
		source_hash   TEXT NOT NULL DEFAULT '',
		size          INTEGER NOT NULL DEFAULT 0,
		mtime         INTEGER NOT NULL DEFAULT 0,
		op            TEXT UNIQUE
	);
	CREATE INDEX handoff_floor ON handoff(floor, created_at);
	CREATE INDEX handoff_source ON handoff(worker_uuid, source_turn, source_hash);
	CREATE VIRTUAL TABLE handoff_fts USING fts5(title, label, worker_name, branch, body,
		tokenize = 'porter unicode61 remove_diacritics 2');`

// Handoff sources.
const (
	HandoffLiteral = "literal"
	HandoffAgent   = "agent"
	HandoffLLM     = "llm"
)

// Handoff is a filed handoff.
type Handoff struct {
	ID           int64
	Floor        string
	WorkerID     string
	WorkerName   string
	Label        string
	Harness      string
	Model        string
	Cwd          string
	Branch       string
	AgentSession string
	Path         string
	Title        string
	CreatedAt    int64 // unix ms: the cabinet's order
	Source       string
	SourceTurn   string // the source's candidate id (literal: the transcript reply's)
	SourceItems  string // JSON: the source's ids and byte spans
	SourceHash   string // the hex SHA-256 of the source text
	Size         int64  // the file as indexed
	MTime        int64  // unix ns
	Op           string
}

// HandoffHit is a listed handoff and, for a search, its body's snippet: the
// matches between U+E000 and U+E001, cuts marked with "…".
type HandoffHit struct {
	Handoff
	Snippet string
}

// Snippet markers: a match starts at SnippetOpen and ends at SnippetClose.
const (
	SnippetOpen  = "\uE000"
	SnippetClose = "\uE001"
)

// Query limits: the most bytes of a search and its terms.
const (
	MaxHandoffQuery = 256
	MaxHandoffTerms = 8
	// DefaultHandoffLimit and MaxHandoffLimit bound a listing.
	DefaultHandoffLimit = 100
	MaxHandoffLimit     = 500
)

const handoffCols = `h.id, h.floor, h.worker_uuid, h.worker_name, h.label, h.harness, h.model, h.cwd, h.branch,
	h.agent_session, h.path, h.title, h.created_at, h.source, h.source_turn, h.source_items, h.source_hash, h.size,
	h.mtime, COALESCE(h.op, '')`

type scanner interface{ Scan(...any) error }

func scanHandoff(r scanner, extra ...any) (Handoff, error) {
	var h Handoff
	err := r.Scan(append([]any{&h.ID, &h.Floor, &h.WorkerID, &h.WorkerName, &h.Label, &h.Harness, &h.Model, &h.Cwd, &h.Branch,
		&h.AgentSession, &h.Path, &h.Title, &h.CreatedAt, &h.Source, &h.SourceTurn, &h.SourceItems, &h.SourceHash, &h.Size,
		&h.MTime, &h.Op}, extra...)...)
	return h, err
}

// AddHandoff records a filed handoff and indexes its body, in one
// transaction; it returns the handoff with its id.
func (s *Store) AddHandoff(ctx context.Context, h Handoff, body string) (Handoff, error) {
	var op any
	if h.Op != "" {
		op = h.Op
	}
	err := s.tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `INSERT INTO handoff (floor, worker_uuid, worker_name, label, harness, model, cwd, branch,
				agent_session, path, title, created_at, source, source_turn, source_items, source_hash, size, mtime, op)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			h.Floor, h.WorkerID, h.WorkerName, h.Label, h.Harness, h.Model, h.Cwd, h.Branch, h.AgentSession, h.Path, h.Title,
			h.CreatedAt, h.Source, h.SourceTurn, h.SourceItems, h.SourceHash, h.Size, h.MTime, op)
		if err != nil {
			return err
		}
		if h.ID, err = res.LastInsertId(); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO handoff_fts (rowid, title, label, worker_name, branch, body) VALUES (?, ?, ?, ?, ?, ?)`,
			h.ID, h.Title, h.Label, h.WorkerName, h.Branch, body)
		return err
	})
	if err != nil {
		return Handoff{}, err
	}
	return h, nil
}

// ReindexHandoff takes a handoff's file as it is now (the startup
// reconcile: it changed on disk): its title, size, mtime and body.
func (s *Store) ReindexHandoff(ctx context.Context, id int64, title string, size, mtime int64, body string) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `UPDATE handoff SET title = ?, size = ?, mtime = ? WHERE id = ?`, title, size, mtime, id)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrNotFound
		}
		var label, worker, branch string
		if err := tx.QueryRowContext(ctx, `SELECT label, worker_name, branch FROM handoff WHERE id = ?`, id).Scan(&label, &worker, &branch); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM handoff_fts WHERE rowid = ?`, id); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO handoff_fts (rowid, title, label, worker_name, branch, body) VALUES (?, ?, ?, ?, ?, ?)`,
			id, title, label, worker, branch, body)
		return err
	})
}

// DeleteHandoff forgets a handoff and its index row, in one transaction.
func (s *Store) DeleteHandoff(ctx context.Context, id int64) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `DELETE FROM handoff WHERE id = ?`, id)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrNotFound
		}
		_, err = tx.ExecContext(ctx, `DELETE FROM handoff_fts WHERE rowid = ?`, id)
		return err
	})
}

// HandoffByID is a handoff by its id (ErrNotFound: none).
func (s *Store) HandoffByID(ctx context.Context, id int64) (Handoff, error) {
	return s.oneHandoff(ctx, `h.id = ?`, id)
}

// HandoffByOp is the handoff a filing operation made (ErrNotFound: none).
func (s *Store) HandoffByOp(ctx context.Context, op string) (Handoff, error) {
	if op == "" {
		return Handoff{}, ErrNotFound
	}
	return s.oneHandoff(ctx, `h.op = ?`, op)
}

// HandoffBySource is a worker's handoff of a source (its candidate id and
// hash), the newest (ErrNotFound: none).
func (s *Store) HandoffBySource(ctx context.Context, worker, turn, hash string) (Handoff, error) {
	return s.oneHandoff(ctx, `h.worker_uuid = ? AND h.source_turn = ? AND h.source_hash = ?`, worker, turn, hash)
}

func (s *Store) oneHandoff(ctx context.Context, where string, args ...any) (Handoff, error) {
	h, err := scanHandoff(s.db.QueryRowContext(ctx, `SELECT `+handoffCols+` FROM handoff h WHERE `+where+
		` ORDER BY h.created_at DESC, h.id DESC LIMIT 1`, args...))
	if errors.Is(err, sql.ErrNoRows) {
		return Handoff{}, ErrNotFound
	}
	return h, err
}

// AllHandoffs is every handoff (the startup reconcile), by id.
func (s *Store) AllHandoffs(ctx context.Context) ([]Handoff, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+handoffCols+` FROM handoff h ORDER BY h.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Handoff
	for rows.Next() {
		h, err := scanHandoff(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// HandoffCounts is how many handoffs each floor has.
func (s *Store) HandoffCounts(ctx context.Context) (map[string]int, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT floor, COUNT(*) FROM handoff GROUP BY floor`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var f string
		var n int
		if err := rows.Scan(&f, &n); err != nil {
			return nil, err
		}
		out[f] = n
	}
	return out, rows.Err()
}

// Handoffs lists a floor's handoffs: without a query (only blanks) the
// newest first; with one, the matches by bm25 (title first, then label,
// worker and branch, then body), each with its body's snippet. The query is
// never FTS5 syntax: HandoffQuery quotes its terms.
func (s *Store) Handoffs(ctx context.Context, floor, q string, limit int) ([]HandoffHit, error) {
	if limit <= 0 {
		limit = DefaultHandoffLimit
	}
	limit = min(limit, MaxHandoffLimit)
	match := HandoffQuery(q)
	var rows *sql.Rows
	var err error
	if match == "" {
		rows, err = s.db.QueryContext(ctx, `SELECT `+handoffCols+`, '' FROM handoff h WHERE h.floor = ?
			ORDER BY h.created_at DESC, h.id DESC LIMIT ?`, floor, limit)
	} else {
		rows, err = s.db.QueryContext(ctx, `SELECT `+handoffCols+`,
				snippet(handoff_fts, 4, char(57344), char(57345), char(8230), 16)
			FROM handoff_fts JOIN handoff h ON h.id = handoff_fts.rowid
			WHERE handoff_fts MATCH ? AND h.floor = ?
			ORDER BY bm25(handoff_fts, 10.0, 3.0, 3.0, 2.0, 1.0), h.created_at DESC LIMIT ?`, match, floor, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []HandoffHit{}
	for rows.Next() {
		var hit HandoffHit
		if hit.Handoff, err = scanHandoff(rows, &hit.Snippet); err != nil {
			return nil, err
		}
		out = append(out, hit)
	}
	return out, rows.Err()
}

// HandoffQuery makes a person's search a safe FTS5 query: the input cut to
// MaxHandoffQuery bytes (on a rune), control characters made blanks, split
// on blanks into at most MaxHandoffTerms terms, each a quoted string (an
// embedded " doubled), the last a prefix ("term"*), joined by spaces (every
// term must match). "" when there is no term: the plain list.
func HandoffQuery(q string) string {
	if len(q) > MaxHandoffQuery {
		q = q[:MaxHandoffQuery]
		for len(q) > 0 && !utf8.ValidString(q) {
			q = q[:len(q)-1]
		}
	}
	q = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, strings.ToValidUTF8(q, " "))
	terms := strings.Fields(q)
	if len(terms) > MaxHandoffTerms {
		terms = terms[:MaxHandoffTerms]
	}
	for i, t := range terms {
		terms[i] = `"` + strings.ReplaceAll(t, `"`, `""`) + `"`
	}
	if len(terms) == 0 {
		return ""
	}
	terms[len(terms)-1] += "*"
	return strings.Join(terms, " ")
}
