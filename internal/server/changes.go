package server

import (
	"context"
	"errors"
	"fmt"

	"github.com/JeffreyVdb/herdr-3d/internal/gitops"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// ChangesGit reads a worker's git changes for worker.changes
// (*gitops.Git: read-only git, all calls within 10 s together).
// Changes returns gitops.ErrNotRepo outside a git work tree.
type ChangesGit interface {
	Changes(ctx context.Context, dir string) (*proto.WorkerChanges, error)
}

// codedError is an error with its protocol error code.
type codedError struct {
	code string
	err  error
}

func (e *codedError) Error() string { return e.err.Error() }
func (e *codedError) Unwrap() error { return e.err }

// startChanges answers worker.changes: git runs off the hub goroutine, in
// the worker's checkout as the bridge knows it.
func (h *Hub) startChanges(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.WorkerArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	w := h.workers[a.ID]
	if w == nil {
		return fmt.Errorf("%w: %q", errUnknownWorker, a.ID)
	}
	f, err := h.floorFor(w.Session)
	if err != nil {
		return fmt.Errorf("%w: %q", errUnknownWorker, a.ID)
	}
	if !f.running {
		return fmt.Errorf("%w: floor %q is asleep", errInvalidState, w.Session)
	}
	dir := checkoutOf(w)
	if !herdr.ValidDir(dir) {
		return fmt.Errorf("%w: %s has no working directory", errInvalidState, w.Name)
	}
	if h.opts.Changes == nil {
		return errors.New("worker.changes is not configured")
	}
	h.startAsync(ctx, c, cmd, func(ctx context.Context) (any, error) {
		res, err := h.opts.Changes.Changes(ctx, dir)
		switch {
		case errors.Is(err, gitops.ErrNotRepo):
			return nil, &codedError{proto.ErrNotARepo, fmt.Errorf("%s is not in a git work tree", dir)}
		case err != nil:
			return nil, &codedError{proto.ErrChangesFailed, err}
		}
		return res, nil
	})
	return nil
}
