package server

// #39 completion before a hire (docs/protocol.md "Completion before a
// hire"): hire.commands, hire.files and hire.repos are worker.commands,
// worker.files and worker.repos for a hire that has no worker yet, keyed by
// the floor, the harness and the folder the hire would get. They ask the
// same services (Options.Commands, Options.Files, the repo scope), so a
// lookup made here warms what the hire's first prompt is translated with.
//
// Unlike worker.hire they do not wait for the floor to be free of wakes,
// sleeps and other hires (hireFloor's notBusy): a lookup changes nothing.
// hire.commands and hire.files want the floor running (as worker.commands
// and worker.files: no hire can be made on an asleep floor), hire.repos only
// a floor the bridge knows (as worker.repos: stored settings only).

import (
	"context"
	"errors"
	"fmt"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/gitops"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// lookupFloor is a running floor the bridge knows, for a pre-hire lookup.
func (h *Hub) lookupFloor(session string) (*floorState, error) {
	f, err := h.floorFor(session)
	if err != nil {
		return nil, err
	}
	if !f.running {
		return nil, fmt.Errorf("%w: floor %q is asleep", errInvalidState, session)
	}
	return f, nil
}

// lookupDir is the folder a hire's lookups are made in (off the hub
// goroutine): cwd (already hireCwd's) for a plain hire; for a worktree hire
// its repository root, the checkout the worktree is made from (runHire's
// TopLevel: the same key the first prompt's translation reads).
func (h *Hub) lookupDir(ctx context.Context, cwd string, worktree bool) (string, error) {
	if !worktree {
		return cwd, nil
	}
	if h.opts.Git == nil {
		return "", errors.New("worktree hires are not configured")
	}
	root, err := h.opts.Git.TopLevel(ctx, cwd)
	switch {
	case errors.Is(err, gitops.ErrNotRepo):
		return "", bad("worktree: %s is not in a git work tree", cwd)
	case err != nil:
		return "", err
	case !herdr.ValidDir(root):
		return "", fmt.Errorf("worktree: %s has no usable repository root", cwd)
	}
	return root, nil
}

// startHireCommands answers hire.commands: the catalog of harness in the
// folder a hire would get, off the hub goroutine.
func (h *Hub) startHireCommands(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.HireCommandsArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	f, err := h.lookupFloor(a.Session)
	if err != nil {
		return err
	}
	if _, ok := hireCatalog(h.hireOptions()).Harness(a.Harness); !ok || !herdr.CanStart(a.Harness) {
		return bad("harness must be claude or codex, got %q", a.Harness)
	}
	cwd, err := h.hireCwd(a.Session, f, a.Cwd)
	if err != nil {
		return err
	}
	if h.opts.Commands == nil {
		return errors.New("hire.commands is not configured")
	}
	h.startAsync(ctx, c, cmd, func(ctx context.Context) (any, error) {
		dir, err := h.lookupDir(ctx, cwd, a.Worktree)
		if err != nil {
			return nil, err
		}
		return h.opts.Commands.Commands(ctx, a.Harness, dir)
	})
	return nil
}

// startHireFiles answers hire.files: the file index of the folder a hire
// would get, off the hub goroutine, with worker.files's limits.
func (h *Hub) startHireFiles(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.HireFilesArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	switch {
	case a.Limit < 0:
		return bad("limit %d is negative", a.Limit)
	case a.Limit == 0:
		a.Limit = proto.FilesDefaultLimit
	case a.Limit > proto.FilesMaxLimit:
		a.Limit = proto.FilesMaxLimit
	}
	if n := utf8.RuneCountInString(a.Query); n > proto.FilesMaxQuery {
		return bad("query is %d characters, the most is %d", n, proto.FilesMaxQuery)
	}
	f, err := h.lookupFloor(a.Session)
	if err != nil {
		return err
	}
	cwd, err := h.hireCwd(a.Session, f, a.Cwd)
	if err != nil {
		return err
	}
	if h.opts.Files == nil {
		return errors.New("hire.files is not configured")
	}
	h.startAsync(ctx, c, cmd, func(ctx context.Context) (any, error) {
		dir, err := h.lookupDir(ctx, cwd, a.Worktree)
		if err != nil {
			return nil, err
		}
		res, err := h.opts.Files.Files(ctx, dir, a.Query, a.Limit)
		if err != nil {
			return nil, &codedError{proto.ErrFilesFailed, err}
		}
		return res, nil
	})
	return nil
}

// startHireRepos answers hire.repos: worker.repos for a worker of the
// floor (its scope and order now, the folders checked off the hub
// goroutine).
func (h *Hub) startHireRepos(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.HireReposArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if _, err := h.floorFor(a.Session); err != nil {
		return err
	}
	h.startAsync(ctx, c, cmd, h.reposFor(a.Session))
	return nil
}
