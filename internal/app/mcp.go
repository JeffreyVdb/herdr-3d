package app

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/JeffreyVdb/herdr-3d/internal/codex"
	"github.com/JeffreyVdb/herdr-3d/internal/harness"
	"github.com/JeffreyVdb/herdr-3d/internal/mcpinv"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// mcpInventory is #196's MCP & skills service for the installed Claude
// Code and Codex CLIs (bins as for worker.commands), with Claude Code's
// config dir and the default Codex home the hub keys it by. Its reads and
// checks run under ctx.
func mcpInventory(ctx context.Context, log *slog.Logger, claudeBin, codexBin string) (svc *mcpinv.Service, claudeDir, codexHome string) {
	userHome, _ := os.UserHomeDir()
	configDir := os.Getenv("CLAUDE_CONFIG_DIR")
	files := mcpinv.DefaultClaudeFiles(configDir, userHome)
	claude := mcpinv.ClaudeRunner{Bin: claudeBin, Run: harnessRun, Files: files, ConfigDirEnv: configDir}
	cx := mcpinv.CodexRunner{Bin: codexBin, Run: harnessRun, UserHome: userHome}
	codexHome = codex.DefaultHome()
	resolved, err := filepath.EvalSymlinks(codexHome)
	if err != nil {
		resolved = codexHome
	}
	// The default profile's home runs as a default worker does: without a
	// CODEX_HOME of the bridge's choosing.
	home := func(key mcpinv.Key) mcpinv.CodexHome {
		return mcpinv.CodexHome{Home: key.Home, Default: key.Home == codexHome || key.Home == resolved}
	}
	svc = mcpinv.New(ctx, mcpinv.Options{Log: log,
		Read: map[string]mcpinv.Reader{
			mcpinv.Claude: func(_ context.Context, key mcpinv.Key) (proto.MCPProvider, error) {
				if !claude.Available() {
					return mcpinv.Unavailable("Claude Code CLI not found on the bridge"), nil
				}
				return mcpinv.ReadClaude(files, key.Cwd), nil
			},
			mcpinv.Codex: func(ctx context.Context, key mcpinv.Key) (proto.MCPProvider, error) {
				return cx.ReadCodex(ctx, home(key), key.Cwd)
			},
		},
		Check: map[string]mcpinv.Checker{
			mcpinv.Claude: func(ctx context.Context, key mcpinv.Key) (mcpinv.CheckResult, error) {
				return claude.CheckClaude(ctx, key.Cwd)
			},
			mcpinv.Codex: func(ctx context.Context, key mcpinv.Key) (mcpinv.CheckResult, error) {
				return cx.CheckCodex(ctx, home(key), key.Cwd)
			},
		},
	})
	return svc, files.Dir, codexHome
}

// harnessRun is mcpinv's Runner: harness.Run's bounded, reaped process.
func harnessRun(ctx context.Context, sp mcpinv.Spawn, fn func(mcpinv.Stream) error) error {
	_, err := harness.Run(ctx, harness.Spawn{Bin: sp.Bin, Dir: sp.Dir, Args: sp.Args, Env: sp.Env, Timeout: sp.Timeout},
		func(s *harness.Stream) (struct{}, error) { return struct{}{}, fn(s) })
	return err
}
