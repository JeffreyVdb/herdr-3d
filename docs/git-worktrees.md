# Git worktrees

Work for this repo happens in a worktree, never in the main checkout. Agents on this host run in parallel.

## Create

```sh
git fetch origin
herdr worktree create --cwd <repo> --branch h3d/<name> [--base origin/main]   # -> ~/.herdr/worktrees/herdr-3d/<name>
# or: git worktree add -b h3d/<name> <path> origin/main
```

## Set up and verify

Run from the new worktree's root, with the required tool versions available. If the bridge host uses mise and
a tool reports that no version is set or selects the wrong version, follow the mise section below first.

```sh
make setup && make lint && make shot
```

Once the toolchain is available, that is the whole setup. `make setup` checks the toolchain (go, node 24.18, pnpm 11.7,
portlease, flock; pins read from `go.mod`, `game/.nvmrc`, `game/package.json`) and fails with a clear message
when one is missing or wrong. It then runs `make deps` (`game/node_modules`, ~3 s from the shared pnpm store), checks
that the Chromium revision the pinned Playwright expects is in `~/.cache/ms-playwright` (missing: it says to run
`make browsers`, the only target that downloads one) and runs `go mod download`. Safe to repeat. `make shot` takes seconds: it proves node_modules, Chromium, portlease and
WebGL2 work. It may wait for another worktree's e2e run (host-wide lock); that is normal.

### When the bridge host uses mise

Skip this section on hosts that do not use mise. Two things must be in place: tool versions selected for the
worktree, and a command environment that resolves those versions.

**Host shell setup.** Mise's [Bash activation](https://mise.jdx.dev/shell-setup.html) belongs in `~/.bashrc` for
interactive terminals:

```sh
eval "$(mise activate bash)"
```

Login and interactive are separate: `bash -lc` reads login startup files but does not display a prompt, and a
typical `.bashrc` returns early for noninteractive shells. Agent commands therefore need
[mise shims](https://mise.jdx.dev/dev-tools/shims.html) before concrete tool-install directories on `PATH`.
For Bash login shells, put the following in `~/.bash_profile`, after any `.bashrc` sourcing and PATH setup:

```sh
if command -v mise >/dev/null 2>&1; then
  eval "$(mise activate bash --shims)"
fi
```

This sets up command lookup without prompt hooks. For agents whose commands skip login startup files, ensure
their launcher supplies the same shims-first PATH. Restart affected agent processes after changing the host's
startup environment. Check inside an actual agent command, not only in an interactive terminal:

```sh
command -v go node pnpm   # should resolve through mise shims
mise config ls
mise ls --current
```

**Worktree versions.** A shim still needs a version: `No version is set for shim: go` means that installing Go
was not enough. A worktree does not copy untracked/ignored mise config and may sit outside the parent directories
whose config the main checkout inherits. This applies to Node, pnpm and other mise-managed tools too.

If the worktree has no suitable mise config, select this repository's pins once from its root:

```sh
# Keep this host-specific file out of commits (the exclude file is shared by the repo's worktrees).
exclude_file=$(git rev-parse --git-path info/exclude)
touch "$exclude_file"
rg -qxF '/mise.local.toml' "$exclude_file" || printf '%s\n' '/mise.local.toml' >> "$exclude_file"
mise use --path "$PWD/mise.local.toml" \
  "go@$(sed -n 's/^go //p' go.mod)" \
  "node@$(cat game/.nvmrc)" \
  "pnpm@$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' game/package.json)"
go version && node --version && pnpm --version
make toolchain
```

`mise use --path` reuses installed versions and installs missing ones. Create the local config separately in each
new worktree, and refresh it when the repository pins change. With shims on PATH, subsequent agent commands can
use ordinary `go`, `node`, `pnpm` and `make` commands, including the setup sequence above. Extend the tool list with
`tool@version` as needed; avoid `latest` and host-wide `mise use -g` changes that affect other agents.

If the host's shell environment cannot be changed, [`mise exec -- <command>`](https://mise.jdx.dev/cli/exec.html)
loads the worktree's config for one command and its children without shell activation. Use it as a fallback,
for example `mise exec -- sh -c 'make setup && make lint && make shot'`.

## Rules

- Never symlink or copy `node_modules` from another checkout. A later install in one tree would change the other.
- No `.env` and no music (`game/public/music`) needed to build, run vitest or run e2e.
- Ports only through `portlease` (`make dev`, `make shot`). Never hardcode one. Bind `127.0.0.1` only.
- Prefer `make` targets over bare `pnpm`: they carry `deps`, the e2e lock and the Playwright env. For a bare
  `pnpm -C game ...`, run `make deps` first. `make e2e-prebuilt` reruns the suite on the bundle you already built.
- Cheap checks first: the Go packages and Vitest files you touched while iterating, `make lint test` before handing
  over. `make e2e` is the smoke suite (~30 journeys); run it once for a change the game can show, with
  `make e2e-prebuilt SPEC=e2e/<feature>.spec.ts` for the feature itself (SPEC runs every test of the file). Go-only and
  docs-only changes need no browser run. `make e2e-extended` / `e2e-visual` / `e2e-perf` and the live suites only when
  the task asks for them; `make e2e-list PROFILE=<name>` shows what one would run (CONTRIBUTING.md, "Build and test").
- The first `go test ./...` takes ~2 min (`internal/server`). Run the packages you touched while iterating.
- `origin` is the public repository and the only push target. The private `JeffreyVdb/herdr-3d-archive` (the history
  before it; old `#NNN` references point there) may be added as a read-only extra remote for context, never pushed to
  (CONTRIBUTING.md, "Remotes").

## Teardown

```sh
herdr worktree remove --workspace <ws>
```

Or `git worktree remove <path>`, only when the tree is clean and its branch is pushed (the bridge's send-home rule).
