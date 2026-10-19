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

Once the toolchain is available, that is the whole setup. `make setup` checks the toolchain (go, node 26.12, pnpm 11.7,
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

**direnv for the shared Codex server (#116).** A Codex hire with the shared-server switch on runs `direnv status --json` in
the worker's folder before it starts the worker's own Codex server (it refuses a folder whose `.envrc` is not allowed).
With direnv installed through mise and no version selected for that folder, mise's shim exits 1 with `No version is set
for shim: direnv`. The bridge cannot tell whether the `.envrc` is allowed, so it refuses; the hire still works, on Codex's
built-in server, and its laptop notice reads "direnv is installed with mise, but no version of it is selected for this
worker's folder". Two places need a selected direnv:

- **The bridge's environment.** The preflight runs inside `herdr-world`, in the worker's directory, with the bridge's
  environment minus the `HERDR_*` and `CLAUDE*` variables (`MISE_*` stays). mise reads the config files of that directory
  and its parents, so a worktree outside the main checkout's directories does not see the main checkout's `mise.local.toml`.
- **The worker's pane.** The shared server is started from the worker's own pane and takes that pane's environment,
  direnv's exports included (`codexapp.Launch`). If the pane's shell runs direnv's hook, direnv must resolve there too, for
  the worker's folder. The bridge's check passing does not prove the pane's, so check from the worker's folder as below.

Choose the narrowest option that covers both. Find the installed version first and check from the worker's folder:

```sh
mise ls direnv            # the installed versions
cd <worker folder> && mise which direnv   # prints a path once a version is selected
```

1. **Per worktree**, in the ignored `mise.local.toml` from above: add `direnv@<installed>` to the `mise use --path
   "$PWD/mise.local.toml" …` command. It needs no trust; it is only a `[tools]` entry. This only helps a folder that
   already exists: a hire that makes a new worktree checks it before any such file could be there.
2. **For every worktree in one folder**, including the ones hires create: a `mise.toml` holding only
   `[tools]` / `direnv = "<installed>"` in the folder that holds them (herdr's are under `~/.herdr/worktrees/<repo>/`).
   mise reads every parent directory's config, so each worktree below it, and both the bridge's check and the worker's
   pane there, select that version; a `[tools]`-only file needs no trust. Do the same in a parent of the main checkout
   if workers are hired there too.
3. **For the bridge**, when you want one answer for the bridge's own checks: `systemctl --user edit herdr-world`, then
   `[Service]` / `Environment=MISE_DIRENV_VERSION=<installed>`, and restart the service. This selects the version for the
   bridge's process only; the worker's pane still needs option 1, 2 or 4.
4. **For the whole host**, an explicit choice of yours: `mise use -g direnv@<installed>`. It affects every directory and
   every agent on the host.

herdr-3d never runs `mise use`, installs a tool, trusts a config or runs `direnv allow`: the selection is yours. mise's own
diagnostic is not in the note or on the laptop; the bridge logs it at Warn, with the worker and its folder
(`journalctl --user -u herdr-world`, look for "direnv has no version selected").

**A worker that already fell back stays on the built-in server.** Its launch is recorded as `legacy`: fixing the tool
selection, or switching the shared-server setting off and on, does not move it to its own server, and the bridge never
migrates a running worker. After the selection is fixed, send that worker home and hire a new one with the shared-server
setting on. Until then its async questions cannot be answered from the transcript.

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
