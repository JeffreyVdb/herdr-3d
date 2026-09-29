package store

// M7 boards: the last good board of each floor (neutral JSON, as the
// bridge sent it), the provider-scoped ids of the requests that were open at
// the last good poll, and the merges already announced.

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"
)

// migrationBoards creates the M7 board tables and records the base branch
// of a worktree hire (worker.open_pr opens its pull request against it).
const migrationBoards = `CREATE TABLE board_cache (
		session_name TEXT NOT NULL,
		kind         TEXT NOT NULL CHECK (kind IN ('issues', 'prs')),
		source       TEXT NOT NULL,
		payload      TEXT NOT NULL,
		fetched_at   INTEGER NOT NULL,
		PRIMARY KEY (session_name, kind)
	);
	CREATE TABLE board_open_pr (
		session_name TEXT NOT NULL,
		pr_id        TEXT NOT NULL,
		PRIMARY KEY (session_name, pr_id)
	);
	CREATE TABLE board_merge_announced (
		session_name TEXT NOT NULL,
		pr_id        TEXT NOT NULL,
		merged_at    INTEGER NOT NULL,
		announced_at TEXT NOT NULL,
		PRIMARY KEY (session_name, pr_id, merged_at)
	);
	ALTER TABLE hire_branch ADD COLUMN base TEXT NOT NULL DEFAULT '';`

// BoardCache is what the store has of a floor's boards.
type BoardCache struct {
	Source    string // the provider link the data is for (a changed link drops it)
	Issues    []byte // board.issues, as sent (not initial, not stale)
	IssuesAt  int64
	PRs       []byte // board.prs, without its merged list
	PRsAt     int64
	OpenPRs   []string // ids of the requests open at the last good poll
	Announced map[string]bool
}

// MergeKey is the key of an announced merge.
func MergeKey(id string, mergedAt int64) string { return id + "@" + strconv.FormatInt(mergedAt, 10) }

// BoardMerge is a merge to record as announced.
type BoardMerge struct {
	ID       string
	MergedAt int64
}

// BoardCaches returns every floor's cache, by session.
func (s *Store) BoardCaches(ctx context.Context) (map[string]BoardCache, error) {
	out := map[string]BoardCache{}
	rows, err := s.db.QueryContext(ctx, `SELECT session_name, kind, source, payload, fetched_at FROM board_cache`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var session, kind, source, payload string
		var at int64
		if err := rows.Scan(&session, &kind, &source, &payload, &at); err != nil {
			return nil, err
		}
		c := out[session]
		c.Source = source
		if kind == "issues" {
			c.Issues, c.IssuesAt = []byte(payload), at
		} else {
			c.PRs, c.PRsAt = []byte(payload), at
		}
		out[session] = c
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	open, err := s.db.QueryContext(ctx, `SELECT session_name, pr_id FROM board_open_pr ORDER BY session_name, pr_id`)
	if err != nil {
		return nil, err
	}
	defer open.Close()
	for open.Next() {
		var session, id string
		if err := open.Scan(&session, &id); err != nil {
			return nil, err
		}
		c := out[session]
		c.OpenPRs = append(c.OpenPRs, id)
		out[session] = c
	}
	if err := open.Err(); err != nil {
		return nil, err
	}
	ann, err := s.db.QueryContext(ctx, `SELECT session_name, pr_id, merged_at FROM board_merge_announced`)
	if err != nil {
		return nil, err
	}
	defer ann.Close()
	for ann.Next() {
		var session, id string
		var at int64
		if err := ann.Scan(&session, &id, &at); err != nil {
			return nil, err
		}
		c := out[session]
		if c.Announced == nil {
			c.Announced = map[string]bool{}
		}
		c.Announced[MergeKey(id, at)] = true
		out[session] = c
	}
	return out, ann.Err()
}

// SaveBoardPoll records a good poll in one transaction: both boards, the
// open request ids, and the merges it announces. A nil prs payload (a floor
// with no code host) leaves no prs row.
func (s *Store) SaveBoardPoll(ctx context.Context, session, source string, issues, prs []byte, issuesAt, prsAt int64,
	open []string, merges []BoardMerge) error {
	if session == "" || source == "" {
		return fmt.Errorf("%w: session and source are required", ErrInvalid)
	}
	return s.tx(ctx, func(tx *sql.Tx) error {
		put := func(kind string, payload []byte, at int64) error {
			if payload == nil {
				_, err := tx.ExecContext(ctx, `DELETE FROM board_cache WHERE session_name = ? AND kind = ?`, session, kind)
				return err
			}
			_, err := tx.ExecContext(ctx, `INSERT INTO board_cache (session_name, kind, source, payload, fetched_at) VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(session_name, kind) DO UPDATE SET source = excluded.source, payload = excluded.payload,
					fetched_at = excluded.fetched_at`, session, kind, source, string(payload), at)
			return err
		}
		if err := put("issues", issues, issuesAt); err != nil {
			return err
		}
		if err := put("prs", prs, prsAt); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM board_open_pr WHERE session_name = ?`, session); err != nil {
			return err
		}
		for _, id := range open {
			if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO board_open_pr (session_name, pr_id) VALUES (?, ?)`, session, id); err != nil {
				return err
			}
		}
		now := s.ts()
		for _, m := range merges {
			if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO board_merge_announced (session_name, pr_id, merged_at, announced_at)
				VALUES (?, ?, ?, ?)`, session, m.ID, m.MergedAt, now); err != nil {
				return err
			}
		}
		return nil
	})
}

// ClearBoard drops a floor's cache and open request set (its provider link
// changed). Announced merges stay: they are keyed by request and time.
func (s *Store) ClearBoard(ctx context.Context, session string) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		for _, q := range []string{`DELETE FROM board_cache WHERE session_name = ?`, `DELETE FROM board_open_pr WHERE session_name = ?`} {
			if _, err := tx.ExecContext(ctx, q, session); err != nil {
				return err
			}
		}
		return nil
	})
}
