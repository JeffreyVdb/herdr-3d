package app

import (
	"context"
	"log/slog"

	"github.com/JeffreyVdb/herdr-3d/internal/harness"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

// discoverHireOptions queries both harnesses concurrently at bridge startup.
// Each failed probe keeps only that harness's legacy fallback catalog.
func discoverHireOptions(ctx context.Context, log *slog.Logger, codexBin, claudeBin string) proto.HireOptions {
	type result struct {
		name    string
		options proto.HarnessOptions
		err     error
	}
	results := make(chan result, 2)
	go func() {
		opts, err := harness.Codex(ctx, codexBin)
		results <- result{"codex", opts, err}
	}()
	go func() {
		opts, err := harness.Claude(ctx, claudeBin)
		results <- result{"claude", opts, err}
	}()
	out := server.HireOptions()
	for range 2 {
		r := <-results
		if r.err != nil {
			log.Warn("model discovery failed; using fallback catalog", "harness", r.name, "err", r.err)
			continue
		}
		if r.name == "codex" {
			out.Codex = r.options
		} else {
			out.Claude = r.options
		}
		log.Info("discovered harness models", "harness", r.name, "models", r.options.Models)
	}
	return out
}
