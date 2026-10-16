# Git worktrees

Work for this repo happens in a worktree, never in the main checkout. Agents on this host run in parallel.

## Create

```sh
git fetch origin
herdr worktree create --cwd <repo> --branch h3d/<name> [--base origin/main]   # -> ~/.herdr/worktrees/herdr-3d/<name>
# or: git worktree add -b h3d/<name> <path> origin/main
```

## Set up and verify

```sh
make setup && make lint && make shot
```

That is the whole setup, no other manual step. `make setup` checks the toolchain (go, node 26.12, pnpm 11.7,
portlease, flock; pins read from `go.mod`, `game/.nvmrc`, `game/package.json`) and fails with a clear message
when one is missing or wrong. It then runs `make deps` (`game/node_modules`, ~3 s from the shared pnpm store), checks
that the Chromium revision the pinned Playwright expects is in `~/.cache/ms-playwright` (missing: it says to run
`make browsers`, the only target that downloads one) and runs `go mod download`. Safe to repeat. `make shot` takes seconds: it proves node_modules, Chromium, portlease and
WebGL2 work. It may wait for another worktree's e2e run (host-wide lock); that is normal.

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
