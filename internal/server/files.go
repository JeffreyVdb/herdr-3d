package server

import (
	"context"
	"errors"
	"fmt"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// FileIndex ranks the files and directories of a checkout against a query,
// for worker.files (*fileindex.Index: an index cached per checkout, git
// ls-files or rg --files, rebuilt in the background). It fails only when
// the checkout has no index at all.
type FileIndex interface {
	Files(ctx context.Context, dir, query string, limit int) (*proto.WorkerFiles, error)
}

// startFiles answers worker.files: the index answers off the hub goroutine,
// for the worker's checkout as the bridge knows it.
func (h *Hub) startFiles(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.WorkerFilesArgs
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
	if h.opts.Files == nil {
		return errors.New("worker.files is not configured")
	}
	h.startAsync(ctx, c, cmd, func(ctx context.Context) (any, error) {
		res, err := h.opts.Files.Files(ctx, dir, a.Query, a.Limit)
		if err != nil {
			return nil, &codedError{proto.ErrFilesFailed, err}
		}
		return res, nil
	})
	return nil
}
