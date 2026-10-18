package codexchild

import (
	"context"
	"errors"

	"github.com/JeffreyVdb/herdr-3d/internal/codex"
	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
)

// ErrNoRollout says a child has no rollout of the root session's under
// the sessions directory (none yet, or the thread is not its child).
var ErrNoRollout = errors.New("codexchild: no rollout of that child in the session")

// Rollout is the rollout of root session's child thread under the Codex
// sessions directory root, and its first line: a spawned child of the
// session (never another session's thread, a root or a guardian).
func Rollout(root, session, thread string) (string, codex.Meta, error) {
	path, err := codex.FindRollout(root, thread)
	if err != nil {
		return "", codex.Meta{}, err
	}
	if path == "" {
		return "", codex.Meta{}, ErrNoRollout
	}
	m, _, ok := codex.ReadMeta(path)
	if !ok || !m.Child() || m.ID != thread || m.Session != session {
		return "", codex.Meta{}, ErrNoRollout
	}
	return path, m, nil
}

// ReadTranscript reads a child's conversation (#26 opens it): the Codex
// parser over its rollout, its parent's copied history (a forked child's
// records before its history start, the copied session_meta among them)
// hidden.
func ReadTranscript(ctx context.Context, root, session, thread string, opts ...transcript.Option) (*transcript.Log, error) {
	path, m, err := Rollout(root, session, thread)
	if err != nil {
		return nil, err
	}
	return transcript.Read(ctx, transcript.Codex, path, append(opts, transcript.CodexHistoryStart(m.HistoryStart))...)
}
