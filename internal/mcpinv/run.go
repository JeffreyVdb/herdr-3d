package mcpinv

import (
	"context"
	"errors"
	"time"
)

// Spawn is how a harness CLI is started for one read or check.
type Spawn struct {
	Bin, Dir string
	Args     []string
	// Env is added to the clean environment herdr launches workers with
	// (a later entry of a name wins).
	Env     []string
	Timeout time.Duration
}

// Stream is a started CLI's protocol connection (*harness.Stream).
type Stream interface {
	Send(v any) error
	Next(v any) error
	RPC(id int, method string, params, result any) error
	CodexInit(reply any) error
	ClaudeInit(reply any) error
}

// Runner starts sp's CLI, hands its stream to fn and ends it: bounded by
// sp.Timeout (an exceeded one is context.DeadlineExceeded), its process
// group killed and reaped before it returns, also when fn fails. The app
// wires in harness.Run, so the hub reaches no harness package through
// this one.
type Runner func(ctx context.Context, sp Spawn, fn func(Stream) error) error

// rpcError is a JSON-RPC error reply (*harness.RPCError).
type rpcError interface {
	error
	RPCMethod() string
}

// run is r's exchange with a result.
func run[T any](ctx context.Context, r Runner, sp Spawn, fn func(Stream) (T, error)) (T, error) {
	var out T
	if r == nil {
		return out, errors.New("no process runner")
	}
	err := r(ctx, sp, func(s Stream) error {
		var err error
		out, err = fn(s)
		return err
	})
	return out, err
}
