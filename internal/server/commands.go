package server

import (
	"context"
	"errors"
	"fmt"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// CommandCatalog lists the slash commands and skills a harness offers in a
// checkout, for worker.commands (*harness.Catalog: cached per harness and
// checkout; a failed probe still answers, with the built-ins and Partial).
// It fails for a harness it does not know.
type CommandCatalog interface {
	Commands(ctx context.Context, harness, dir string) (*proto.WorkerCommands, error)
}

// startCommands answers worker.commands: the catalog runs off the hub
// goroutine, for the worker's harness in its checkout as the bridge knows it.
func (h *Hub) startCommands(ctx context.Context, c *Client, cmd proto.Command) error {
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
	harness := w.Harness
	if harness == "" {
		harness = w.AgentKind
	}
	if !herdr.CanStart(harness) {
		return fmt.Errorf("%w: %s runs no Claude or Codex agent", errInvalidState, w.Name)
	}
	if h.opts.Commands == nil {
		return errors.New("worker.commands is not configured")
	}
	h.startAsync(ctx, c, cmd, func(ctx context.Context) (any, error) {
		res, err := h.opts.Commands.Commands(ctx, harness, dir)
		if err != nil {
			return nil, err
		}
		return res, nil
	})
	return nil
}
