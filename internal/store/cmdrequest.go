package store

import (
	"context"
	"database/sql"
	"errors"
)

const migrationCommandRequest = `CREATE TABLE cmdrequest_seen (worker_uuid TEXT NOT NULL, text_sha TEXT NOT NULL, turn_id TEXT NOT NULL, request TEXT NOT NULL DEFAULT '', outcome TEXT NOT NULL DEFAULT '', PRIMARY KEY(worker_uuid,text_sha));`

type CommandRequestSeen struct{ Turn, Request, Outcome string }

func (s *Store) CommandRequestSeenOf(ctx context.Context, worker, sha string) (CommandRequestSeen, bool, error) {
	var v CommandRequestSeen
	err := s.db.QueryRowContext(ctx, `SELECT turn_id, request, outcome FROM cmdrequest_seen WHERE worker_uuid=? AND text_sha=?`, worker, sha).Scan(&v.Turn, &v.Request, &v.Outcome)
	if errors.Is(err, sql.ErrNoRows) {
		return v, false, nil
	}
	return v, err == nil, err
}
func (s *Store) RecordCommandRequestSeen(ctx context.Context, worker, sha, turn, request, outcome string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO cmdrequest_seen (worker_uuid,text_sha,turn_id,request,outcome) VALUES (?,?,?,?,?) ON CONFLICT(worker_uuid,text_sha) DO NOTHING`, worker, sha, turn, request, outcome)
	return err
}
func (s *Store) CloseCommandRequestSeen(ctx context.Context, worker, sha, outcome string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE cmdrequest_seen SET outcome=? WHERE worker_uuid=? AND text_sha=? AND outcome=''`, outcome, worker, sha)
	return err
}
