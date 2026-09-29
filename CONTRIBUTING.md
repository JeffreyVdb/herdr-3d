# Contributing

## Layout

- `cmd/herdr-world` — server-side bridge daemon (Go).
- `cmd/h3d-helper` — Mac-side helper (Go, cross-compiled for `darwin/arm64`).
- `internal/` — shared Go packages. Bridge: `herdr` (the only door to herdr: the read-only client and the allowlisted
  control surface for wake/sleep and hire/send home), `watch` (session discovery and per-session watchers), `world`
  (floors/workers from snapshots and `session.json`, identity matching, worker names), `store` (SQLite), `server` (hub +
  WebSocket, wake/sleep, floor settings, hire/send home), `proto` (protocol v1 types and client), `gitremote` (GitHub
  origin of a directory, for the repo suggestion), `gitops` (the typed git runner of hires, send-homes and the Changes
  panel), `codex` (Codex session ids and rollout files, for the sleep backfill and usage), `usage` (M5: agents' token
  usage and cost from their transcripts, read incrementally, and the pricing table). Helper: `helper` (ssh tunnel
  supervisor, game server, `/ws` proxy). `app` holds both command lines.
- `deploy/` — `herdr-world.service` (systemd `--user`), `com.jeffreyvdb.h3d-helper.plist` (launchd user agent, Mac).
- `game/` — the game: Vite + strict TypeScript + three.js (`three/webgpu`), pnpm.

## Toolchain

Go 1.27 (see `go.mod`), Node 24.18 (`game/.nvmrc`), pnpm 11.7 (`packageManager` in `game/package.json`),
`portlease` for ports. CI uses the same pins.

## Build and test

```sh
make build test lint   # Go binaries -> bin/, game bundle -> game/dist/, go test + vitest, vet/gofmt/tsc
make integration       # bridge against a real herdr (and systemd-run) in throwaway sessions (see below)
make helper-darwin     # bin/darwin-arm64/h3d-helper (CGO off)
make dev               # Vite dev server on a portlease-leased port, 127.0.0.1 only
make shot              # headless WebGL2 screenshot -> game/test-results/shot.png (non-blank check)
```

- `make shot` runs Playwright against the **cached** Chromium in `~/.cache/ms-playwright` (`@playwright/test` is pinned
  to the version that matches it). Browsers are never downloaded (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`). It forces the
  WebGL2 backend (`?backend=webgl2`) because the server has no GPU; rendering goes through ANGLE → Vulkan → mesa llvmpipe.
- The page exposes `window.__h3d` (`backend`, `frames`, `error`) for tests.
- Never hardcode ports. Use `portlease run` / `portlease reserve`, and bind `127.0.0.1` only. Other agents run in
  parallel worktrees on the same host.
- CI (`.github/workflows/ci.yml`) runs go vet/gofmt/test, the darwin cross-build, tsc and vitest. No Playwright in CI.
- `go test ./internal/helper` never runs ssh: the test binary stands in for it (`H3D_FAKE_SSH`) and forwards to an
  in-process bridge.

## Bridge (`herdr-world`)

Protocol: [`docs/protocol.md`](docs/protocol.md). Every herdr call goes through `internal/herdr`, in two allowlisted
parts:

- **Reads** (`herdr.Client`): the socket methods `ping`, `session.snapshot` and `events.subscribe`, plus `herdr session
  list --json`. `TestReadOnlyAllowlist` is the tripwire.
- **Writes** (`herdr.Control`), for `floor.wake` / `floor.sleep` and `worker.hire` / `worker.fire` only: exactly the
  command shapes in `controlShapes`.
  - Wake and sleep: `systemd-run --user --unit=herdr-s-<name> … /bin/fish -l -c "exec herdr --session '<name>'
    server"`, `herdr session stop <name> --json`, `herdr --session <name> pane run <pane> "claude --resume <id>"` /
    `"codex resume <id>"`, `herdr --session <name> pane report-agent-session <pane> --source herdr:codex --agent codex
    --agent-session-id <id>`, and the read-only `herdr --session <name> pane process-info --pane <pane>`.
  - Hire: `workspace create --cwd <dir> --label <label> --no-focus`, `worktree create --cwd <dir> --branch h3d/<…>
    --base origin/<…> --label <label> --no-focus`, `pane rename <pane> h3d-<hex>` (the marker), `agent start <name>
    --kind claude --pane <pane> --timeout 30000 -- --model <m> --effort <e> --permission-mode bypassPermissions --name
    <label>` / `--kind codex … -- -m <m> -c model_reasoning_effort=<e> --dangerously-bypass-approvals-and-sandbox`, the
    read-only `pane read <pane> --source visible` (trust dialog), `pane send-keys <pane> down|enter|ctrl+c`, `agent
    prompt <pane> <text> --wait --until working --until blocked --timeout 8000`.
  - Send home: `pane send-text <pane> /exit` / `/quit`, `workspace close <ws>`, `worktree remove --workspace <ws>`
    (never `--force`, never `--group`).

  Every variable is validated (session names, pane/workspace ids, agent session ids, absolute clean directories,
  labels without control characters or a leading `-`, `h3d/…` branches, `origin/…` bases, `h3d-<hex>` markers, models
  and efforts, prompts not starting with `--`), every argument is its own argv element, sessions outside `--sessions`
  are refused, and commands run with the `HERDR_*`/`CLAUDE*` variables stripped. `TestControlAllowlist` pins the set,
  the argv and the exported methods; widening any needs review.
- **git** (`gitops.Git`, hires, send-homes and `worker.changes` only): exactly thirteen shapes (`shapes`, pinned by
  `TestGitAllowlist`):
  `git -C <dir>` `rev-parse --show-toplevel`, `fetch --quiet origin`, `symbolic-ref --quiet --short
  refs/remotes/origin/HEAD`, `log -1 --format=%H %ct origin/<…> --`, `status --porcelain`, `symbolic-ref --quiet --short
  HEAD`, `rev-list --count HEAD --not --remotes`, `rev-list --count refs/heads/h3d/<…> --not --remotes`, `rev-parse
  --verify --quiet refs/heads/h3d/<…>`, `branch -D h3d/<…>`, and for the Changes panel (M5, read-only) `status
  --porcelain=v2 --branch -z --untracked-files=all`, `merge-base HEAD origin/<…>` and `diff --numstat --patch -z
  --find-renames --no-color --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/ <commit id | HEAD> --`. A
  branch is deleted only when the bridge recorded
  making it for that worker (SQLite `hire_branch`, with its base commit; the name alone proves nothing) and either
  still points at that base (a hire's rollback, clean tree) or has all its commits on a remote (send home, the
  checkout still on it). Same clean environment, plus `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`.

Everything else the bridge changes is its own SQLite database. How a wake and a sleep go, and what they log:
[`docs/protocol.md` "Wake and sleep"](docs/protocol.md#wake-and-sleep); hiring and sending home:
[`docs/protocol.md` "Hire and send home"](docs/protocol.md#hire-and-send-home).

Run a private instance next to (or instead of) the real one; `dump` and `cmd` take the same `--socket`:

```sh
make go-build
sock=$XDG_RUNTIME_DIR/h3d-dev/bridge.sock   # unix socket paths must stay under ~107 bytes
bin/herdr-world --socket "$sock" --db /tmp/h3d-dev/world.db --log-level debug
bin/herdr-world dump --socket "$sock"            # snapshot, then events as JSON lines until Ctrl-C
bin/herdr-world dump --socket "$sock" --once | jq '.world.floors'
bin/herdr-world cmd --socket "$sock" building.create '{"name":"Work"}'
bin/herdr-world cmd --socket "$sock" floor.assign '{"session":"herdr-3d","building":"b_…"}'
bin/herdr-world cmd --socket "$sock" floor.settings.set '{"session":"herdr-3d","repo":"JeffreyVdb/herdr-3d"}'
bin/herdr-world cmd --socket "$sock" worker.changes '{"id":"<worker id>"}' | jq '.data | {branch, base, stat, omitted}'
bin/herdr-world dump --socket "$sock" | jq -c 'select(.t == "worker.usage") | {id, usage}'
```

`worker.changes` and usage only read (git in the worker's checkout, transcripts under `--claude-projects` and
`--codex-sessions`), so a private bridge may show them for any session it watches.

A private bridge acts on real sessions as soon as it is sent `floor.sleep`, `floor.wake`, `worker.hire` or
`worker.fire`. Always start it with a
`--sessions` that matches only your throwaway sessions (e.g. `'^h3d-mytask-'`), so it cannot even see the sessions
everyone works in. To try wake and sleep safely:

```sh
s=h3d-mytask-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')
systemd-run --user --unit=herdr-s-$s --collect -p KillMode=process --working-directory=$HOME \
  /bin/fish -l -c "exec herdr --session '$s' server"            # the bridge's own start command
env -u HERDR_ENV -u HERDR_SESSION -u HERDR_SOCKET_PATH herdr --session $s workspace create --cwd /tmp --label demo --no-focus
bin/herdr-world --socket "$sock" --db /tmp/h3d-mytask/world.db --sessions '^h3d-mytask-' &
bin/herdr-world cmd --socket "$sock" floor.sleep "{\"session\":\"$s\"}"   # herdr session stop
bin/herdr-world cmd --socket "$sock" floor.wake  "{\"session\":\"$s\"}"   # systemd-run, resume checks
sqlite3 /tmp/h3d-mytask/world.db 'select cmd, ok, error, result from audit_log'
bin/herdr-world cmd --socket "$sock" floor.sleep "{\"session\":\"$s\"}" && herdr session delete $s
systemctl --user list-units --all 'herdr-s-*'                     # the unit is gone (--collect)
```

Real agents in such a session must be cheap: `claude --model claude-haiku-4-5-20251001 --effort low`, `codex -m
gpt-6-luna -c model_reasoning_effort=low`, one short turn. Never sleep or wake a session you did not create, and never
`systemctl stop` a `herdr-s-*` unit that `herdr session stop` can stop (it loses the agents' resume link).

To try hiring and sending home, in such a throwaway session (the real `hire_options` have no Claude model cheap enough
for trying things: use Codex `gpt-6-luna` / `low`, and give a Claude worker no prompt, so it is never asked
anything):

```sh
repo=/tmp/h3d-mytask/repo; git init -q --bare /tmp/h3d-mytask/origin.git && git clone -q /tmp/h3d-mytask/origin.git $repo
git -C $repo commit -q --allow-empty -m init && git -C $repo push -q origin HEAD:main && git -C $repo remote set-head origin main
bin/herdr-world cmd --socket "$sock" hire.prepare "{\"session\":\"$s\",\"cwd\":\"$repo\"}"
bin/herdr-world cmd --socket "$sock" worker.hire "{\"session\":\"$s\",\"desk_index\":2,\"harness\":\"codex\",\"model\":\"gpt-6-luna\",\"effort\":\"low\",\"cwd\":\"$repo\",\"worktree\":true,\"prompt\":\"Reply with exactly the word: pong\"}"
bin/herdr-world cmd --socket "$sock" worker.fire.prepare '{"id":"<id from the ack>"}'
bin/herdr-world cmd --socket "$sock" worker.fire '{"id":"<id>","worktree":"delete_branch"}'   # only when clean and pushed
sqlite3 /tmp/h3d-mytask/world.db 'select cmd, ok, error, result from audit_log'
```

herdr puts worktrees in `~/.herdr/worktrees/<repo name>/`: give a throwaway repository a unique name and remove that
directory when done. Answering a trust dialog is remembered by the agent (`~/.claude.json`, `~/.codex/config.toml`) for
that directory.

| flag | env | default |
|---|---|---|
| `--socket` | `HERDR_WORLD_SOCKET` | `$XDG_RUNTIME_DIR/herdr-world/bridge.sock` |
| `--db` (serve) | `HERDR_WORLD_DB` | `$XDG_STATE_HOME/herdr-world/world.db`, else `~/.local/state/herdr-world/world.db` |
| `--herdr` | `HERDR_WORLD_HERDR` | `herdr` on `PATH` (a woken server runs `herdr` from the login shell's `PATH`) |
| `--systemd-run` | `HERDR_WORLD_SYSTEMD_RUN` | `systemd-run` on `PATH`: starts woken sessions |
| `--sessions` | `HERDR_WORLD_SESSIONS` | all; a regexp limits which sessions are watched, and the only ones commands may wake, sleep, configure, hire into or send workers home from |
| `--poll`, `--resnapshot` | `HERDR_WORLD_POLL`, `HERDR_WORLD_RESNAPSHOT` | `2s`, `30s` |
| `--max-desks` | `HERDR_WORLD_MAX_DESKS` | `96`: cap on the desks a floor renders beyond its occupied ones (`floor.desks`) |
| `--name-hold` | `HERDR_WORLD_NAME_HOLD` | `168h` (7 days): how long a worker's name stays held after the bridge sees it leave its floor; then a newcomer may take it (`worker.name`) |
| `--wake-timeout` | `HERDR_WORLD_WAKE_TIMEOUT` | `10s`: how long a woken server has to start, answer `ping` and be seen running (else `wake_failed`) |
| `--resume-timeout` | `HERDR_WORLD_RESUME_TIMEOUT` | `10s`: how long a wake waits for the agents before the fallback, and again for the fallback and its result (a wake acks within about `--wake-timeout` + 2 × this) |
| `--codex-sessions` | `HERDR_WORLD_CODEX_SESSIONS` | `$CODEX_HOME/sessions`, else `~/.codex/sessions`: Codex rollouts, for the sleep backfill and usage |
| `--claude-projects` | `HERDR_WORLD_CLAUDE_PROJECTS` | `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`: Claude Code transcripts, for usage (M5) |
| `--pricing` | `HERDR_WORLD_PRICING` | none: a JSON file of model prices merged over the built-in table (`internal/usage/pricing.json`; format in [`docs/protocol.md` "Usage and cost"](docs/protocol.md#usage-and-cost)) |
| `--warn-workers-per-floor`, `--max-workers-per-floor` | `HERDR_WORLD_WARN_WORKERS_PER_FLOOR`, `HERDR_WORLD_MAX_WORKERS_PER_FLOOR` | `12`, `24`: above the first the hire dialog warns, a hire above the second is refused (`capacity`) |
| `--warn-workers`, `--max-workers` | `HERDR_WORLD_WARN_WORKERS`, `HERDR_WORLD_MAX_WORKERS` | `48`, `96`: the same for all watched running floors together |
| `--git` | `HERDR_WORLD_GIT` | `git` on `PATH`: worktree hires, send-home checks and the repo suggestion |
| `--log-level`, `--log-format` | `HERDR_WORLD_LOG_LEVEL`, `HERDR_WORLD_LOG_FORMAT` | `info`, `text` (or `json`) |

Install as a user service:

```sh
install -Dm755 bin/herdr-world ~/.local/bin/herdr-world
install -Dm644 deploy/herdr-world.service ~/.config/systemd/user/herdr-world.service
systemctl --user daemon-reload && systemctl --user enable --now herdr-world
journalctl --user -u herdr-world -f
```

### Integration test

`go test ./...` never touches herdr or systemd (fake socket server + recorded fixtures; `herdr.Control` gets a fake
`Runner` that plays herdr and systemd-run; hires and send-homes run against an in-memory herdr floor and git). Only
`internal/gitops` runs the real `git`, on repositories in a temp dir (M5: `worker.changes` is checked against `git
status` and `git diff --stat` there, byte for byte against `git diff`). `internal/usage` reads synthetic transcripts
(`testdata/`, no real content) and temp files. `make integration` runs, with build tag `integration`, against the
installed herdr:

- `TestIntegrationThrowawaySession`: starts a headless server for a fresh session `h3d-it-<random>`, creates
  workspaces, reports a custom agent's states through `herdr pane report-agent` (no real coding agent), closes a
  workspace, stops the session, and asserts the bridge's events.
- `TestIntegrationSleepWake`: puts a throwaway floor with two workspaces to sleep with `floor.sleep`, wakes it with
  `floor.wake` through the real `systemd-run` path, and checks the workers keep their ids, desks and names, the
  transient unit `herdr-s-h3d-it-…` runs the server, and that server has none of the test's `CLAUDE*`/`HERDR_*`
  variables.

- `TestIntegrationHireAndSendHome`: hires a Codex worker (`gpt-6-luna`, `low`) into a worktree of a local repository
  whose bare "origin" got a commit the local clone lacks, and checks the worktree has it; hires a Claude worker
  (`claude-haiku-4-5-20251001`, `low`, allowed by a test-only `ServeConfig.HireOptions`) into a fresh directory; both
  with a one-line prompt and through their trust dialogs. Then checks desks, markers, native args, the remembered
  choice, the capacity guard, and sends both home: a dirty and an unpushed worktree are refused a delete, a pushed one
  goes with its branch, the agents exit gracefully and the audit log has every step. It removes
  `~/.herdr/worktrees/h3d-it-repo-<random>` afterwards. The agents remember the trust of the test's temporary
  directories.

All of them always name the `h3d-it-…` session explicitly, and the bridge under test watches only that session. They strip
`HERDR_*`/`CLAUDE*` pane variables from herdr's environment and in `t.Cleanup`, also on failure, stop the session with
`herdr session stop`, wait for the `herdr-s-h3d-it-…` unit to be collected (stopping it only as a last resort) and
delete the session. They never touch any other session, so they are safe to run from inside a herdr pane. If a run is
killed hard, check `herdr session list` for a leftover `h3d-it-*` session (`herdr session stop`/`delete` it) and
`systemctl --user list-units --all 'herdr-s-h3d-it-*'`.

## Helper (`h3d-helper`, Mac)

`h3d-helper` is what makes the game playable on the Mac:

- it owns `ssh -N -o ControlMaster=no -o ControlPath=none -o ExitOnForwardFailure=yes … -L <local.sock>:<bridge.sock>
  dev@devbox`, restarts it with exponential backoff (0.5 s doubling to 30 s, ±20 % jitter, back to 0.5 s after
  30 s up) and checks the bridge's `/healthz` through it every 5 s (3 failures in a row restart ssh). On exit it kills
  ssh's process group and removes the local socket;
- it serves the game on `http://127.0.0.1:7777` (loopback only; a secure context, so WebGPU works) from a built
  `game/dist`, or proxies a Vite dev server with `-dev-upstream`;
- it proxies `GET /ws` to the bridge, after checking Host, Origin and a per-start token (`docs/protocol.md`
  "Through h3d-helper");
- it opens a Chrome `--app` window on `http://127.0.0.1:7777/#token=…` with its own profile (`-no-open` skips that).
  The token changes at every start: after a restart, use the new window.

It needs non-interactive SSH from the Mac to the host (`BatchMode=yes`: a key in the agent/keychain, host key known).
State goes to the log (stderr): `tunnel connecting`, `tunnel up`, `bridge not answering through the tunnel`,
`tunnel down, restarting … retry_in=…`. `curl http://127.0.0.1:7777/healthz` shows the tunnel state.

| flag | env | default |
|---|---|---|
| `--host` | `H3D_HELPER_HOST` | `dev@devbox` |
| `--remote-socket` | `H3D_HELPER_REMOTE_SOCKET` | `/run/user/1000/herdr-world/bridge.sock` (the bridge's default) |
| `--local-socket` | `H3D_HELPER_LOCAL_SOCKET` | `~/Library/Caches/h3d-helper/bridge.sock` |
| `--listen` | `H3D_HELPER_LISTEN` | `127.0.0.1:7777`; anything but a loopback IP is refused |
| `--bundle` | `H3D_HELPER_BUNDLE` | `~/Library/Application Support/h3d-helper/dist` |
| `--dev-upstream` | `H3D_HELPER_DEV_UPSTREAM` | off; e.g. `http://127.0.0.1:5173` |
| `--no-open` | `H3D_HELPER_NO_OPEN` | `false` |
| `--chrome`, `--chrome-profile` | `H3D_HELPER_CHROME`, `H3D_HELPER_CHROME_PROFILE` | `Google Chrome`, `~/Library/Application Support/h3d-helper/chrome` |
| `--ssh` | `H3D_HELPER_SSH` | `ssh` on `PATH` |
| `--log-level`, `--log-format` | `H3D_HELPER_LOG_LEVEL`, `H3D_HELPER_LOG_FORMAT` | `info`, `text` (or `json`) |

Install as a launchd user agent, from the server (always `-o ControlMaster=no -o ControlPath=none`, see the rule below):

```sh
make helper-darwin game-build
mac=devmac; ssh="ssh -o ControlMaster=no -o ControlPath=none"
$ssh $mac 'mkdir -p ~/.local/bin ~/Library/LaunchAgents "Library/Application Support/h3d-helper" && rm -rf "Library/Application Support/h3d-helper/dist"'
scp -o ControlMaster=no -o ControlPath=none bin/darwin-arm64/h3d-helper $mac:.local/bin/h3d-helper
tar -C game -cf - dist | $ssh $mac 'tar -C "Library/Application Support/h3d-helper" -xf -'
$ssh $mac 'sed "s|@HOME@|$HOME|g" > Library/LaunchAgents/com.jeffreyvdb.h3d-helper.plist' < deploy/com.jeffreyvdb.h3d-helper.plist
$ssh $mac 'launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jeffreyvdb.h3d-helper.plist'
```

Then on the Mac: `tail -f ~/Library/Logs/h3d-helper.log`. After an update, copy the binary/bundle again and
`launchctl kickstart -k gui/$(id -u)/com.jeffreyvdb.h3d-helper`. Uninstall:

```sh
launchctl bootout gui/$(id -u)/com.jeffreyvdb.h3d-helper
rm ~/Library/LaunchAgents/com.jeffreyvdb.h3d-helper.plist ~/.local/bin/h3d-helper
rm -rf ~/Library/Application\ Support/h3d-helper ~/Library/Caches/h3d-helper
```

Development: forward a Vite dev server (`make dev` on the server) to the Mac and point a helper at it (stop the agent
first, or give it another `-listen` port); HMR goes through the helper too:

```sh
ssh -o ControlMaster=no -o ControlPath=none -N -L 5173:127.0.0.1:<leased dev port> dev@devbox &
~/.local/bin/h3d-helper -dev-upstream http://127.0.0.1:5173
```

Agents test it without launchd and without a window: copy the binary and a `game/dist` to a temp dir such as
`~/h3d-tools/helper-<task>/`, run `./h3d-helper -no-open -remote-socket <private bridge socket> -bundle <dir>/dist
-local-socket <dir>/bridge.sock` (it logs the game URL with its token), drive headless Chrome from `~/h3d-tools`
(`playwright-core`), and stop it with SIGTERM when done. Mac port 7777 is the helper's; others use their own.

## Rule: never serve the game to the Mac over plain `http://<tailnet-host>`

WebGPU only exists in a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts).
`http://devbox:<port>` is a remote, insecure origin, so Chrome **silently** falls back to WebGL2 — the game
still renders, but on the wrong backend, and any Metal/perf check is meaningless
(see [`docs/research/engine.verify.md`](docs/research/engine.verify.md)).

Always reach the server from the Mac through an SSH forward and open it on loopback:

```sh
ssh -o ControlMaster=no -o ControlPath=none -N -L <port>:127.0.0.1:<port> dev@devbox
# then open http://127.0.0.1:<port> (or http://localhost:<port>) on the Mac
```

`ControlMaster=no` matters: a tunnel that becomes the shared ControlMaster takes everyone's multiplexed SSH sessions
down with it when it is killed (`docs/architecture.md` §2, §7). Check the debug overlay says `backend: webgpu`.

## Game

`game/` is Vite + strict TypeScript + three.js r186 (`three/webgpu`, WebGL2 fallback). Layout:

- `src/net` — protocol v1 client (hello → welcome → snapshot | replay → events, reconnect with backoff from
  `since_seq` + `epoch`; commands through `request(t, args)`, matched to their `ack` / `error` by `req_id`, with a
  per-command timeout: 10 s, `floor.sleep` 30 s, `floor.wake` 60 s since its ack waits for every agent; M4:
  `hire.prepare` 30 s, `worker.hire` 90 s, `worker.fire.prepare` 20 s, `worker.fire` 45 s; a drop fails what is in
  flight) and the endpoint: same-origin `/ws?token=…` (the helper opens `/#token=<token>`; the game
  keeps it in `sessionStorage` as `h3d.token` and strips it from the URL), `?ws=<url>` to point elsewhere.
- `src/world` — the world store (snapshot + events, fallbacks for an older bridge without `name`, `desk_index`,
  `harness`, `model`, `effort`, `status_since`, `floor.desks`, and M3's `transition`, `settings`, `suggested`,
  `resume`, `hire_options`), the deterministic office layout for a desk count in its building's outline, the building
  around the floors (`building.ts`: storeys, the lobby, the fire escape, the street), M3c's corner office on its
  mezzanine (`FloorLayout.mezzanine`: posts, stair, glass, your desk, its walking supports and solids), height-aware walking collision
  and ray picking, the M4 walk-out route (`route.ts`), floor-settings validation and diffing (`settings.ts`),
  building/floor reordering (`arrange.ts`); M4: the hire / send-home dialogs' state (`hire.ts`: the preselected
  choice, capacity states, the base's age, which send-home options are enabled, the first task's keys, the command
  args) and the walk-in / walk-out timeline (`arrival.ts`: the walk-in is `walkOutRoute` reversed; heights come from
  its waypoints). Pure logic, covered by vitest.
- `src/render` — city dollhouse, office floor, instanced rigid-part workers / desks, speech-bubble cards, frame policy;
  M3b: the walk scene (`walk.ts`), the building and street from outside (`outside.ts`, baked into one mesh by
  `bake.ts`) and the lobby (`lobby.ts`). M3c: the corner office (`mezzanine.ts`: two merged vertex-coloured toon
  meshes, its glass merged into the office's window glass, one material). M4: `arrivals.ts` draws the walks (standing
  workers, the cardboard box with a mug, a plant and a photo, the closed laptop); the office shows a desk someone packs
  up at or walks in to without its "+" (`OfficeView.setAway`).
  Cards and city badges are canvas atlases drawn as one instanced quad batch each (a cell per worker / floor, redrawn
  only when it changes). A DOM layer was benchmarked on the Mac and lost: moving DOM elements over the canvas cost
  2.6–4.3 ms of main thread per frame for 24 cards and ~8 ms for 30 city badges, against 0.5 ms for the atlas. The DOM
  keeps a static floor list for keyboards and screen readers.
- `src/ui` — the HUD (DOM over the canvas) and the M3 panels (`panels.ts`: elevator, buildings, floor settings,
  confirmations; modal `<dialog>`s that re-render live and keep focus); M4: the hire dialog (`hire.ts`) and the
  send-home dialog (`sendHome.ts`), styled in `hire.css`. Hidden, named hooks wait for later tickets:
  `renderPlanLimits(harness)` (#12), `renderHandoff` (M9) and `renderServices` (#14), each returning null for now.
  `src/input` — first-person walking.
- `fixtures/` — recorded bridge streams (`herdr-world dump` format): `demo` (2 buildings, 3 floors, 40 workers; an M2
  bridge), `demo-m3` (the same city as an M3 bridge sends it: settings, suggestions, hire options, a floor in the
  unassigned lot; no events), `demo-m3b` (demo-m3 with all three floors in Work: herdr-3d on top, depot-manager asleep
  in the middle, pastry at the bottom), `demo-m4` (demo-m3b with linked git worktrees and branches on some workers of
  herdr-3d and pastry, and herdr-3d's docs worker in the repo's main checkout), `perf-floor60`, `perf-floor96` (96
  desks, every worker needs you: the corner office's worst case), `perf-city240`. `pnpm fixtures` regenerates them,
  `pnpm fixtures:check` flags stale files.
  Like the bridge, a building lists its floors top to bottom, which is `index` order (index 0 on top); vitest fails
  a fixture where the two disagree, since the simulator (`sim=1`) rebuilds the list from `index`.
- `tools/` — fixture server (read-only by default; with `sim=1` it simulates the bridge's commands in memory,
  `fixture-sim.ts`, M4's four included: a cwd is a git repo unless it has `/scratch` in it, `offline` in it fails every
  fetch (prepare reports it, a worktree hire is refused with `fetch_failed`); a `working` worker has uncommitted changes and 2 unpushed commits, a `blocked` one 1 unpushed commit; caps
  24 / 32 per floor and 60 / 80 for the host unless `simcap` says otherwise; hires are acked one step later with the
  worker walking in, a first task sets it working the step after; branches are `h3d/<name>-<id6>`; `delete_branch` only for
  a branch the simulator made or a fixture `h3d/…` one, like the bridge's recorded branches), dev WebSocket → unix-socket proxy, throwaway-herdr helper, live and Mac perf drivers.

Run it:

```sh
make dev   # then open http://127.0.0.1:<port>/?ws=/fixture/demo   (Vite serves fixtures at /fixture/<name>)
           # M3 panels without a bridge: ?ws=%2Ffixture%2Fdemo-m3%3Fsim%3D1   (the ws value URL-encoded)
           # M4 hire / send home: ?ws=%2Ffixture%2Fdemo-m4%3Fsim%3D1%26simcap%3Dscratchpad%3A3%3A4
pnpm -C game fixture-server   # standalone fixture server on a leased port: ?ws=ws://127.0.0.1:<port>/ws
pnpm -C game fixture-server --simulate --fixture demo-m3   # the same, answering commands on every connection
# against a private bridge: node game/tools/ws-unix-proxy.ts --port <leased> --socket <bridge.sock>, then ?ws=ws://127.0.0.1:<leased>/ws
```

| query param | effect |
|---|---|
| `ws=<url or path>` | bridge endpoint (default same-origin `/ws`); fixtures take `?play=none\|all\|<ms>`, and `sim=1` to simulate commands (`simms=<ms>` between wake/sleep and hire/send-home steps, default 600; `simfail=wake_failed\|sleep_failed\|hire_failed\|fire_failed` fails the next one, `simfail=fetch_failed` makes origin unreachable for the whole run; `simcap=<session>:<soft>:<hard>[,…]` caps floors) |
| `backend=webgl2` | force WebGL2 |
| `floor=<session>`, `plan=1` | enter a floor on load, open its floor plan |
| `ts` | GPU timestamp queries (for `bench`) |
| `shadows=0`, `badges=0`, `battery=1` | no shadows; no city badges (perf comparisons); start in battery saver |
| `me=<name>` | M3c: the name on your desk's name plate and the office glass (default "You": the bridge sends no user name yet) |

Controls: in the city, drag to orbit, scroll to zoom, click a building to focus it and open its elevator panel, and a
floor of the focused building (or any floor's badge) to go inside. **M** or the Buildings button opens the buildings
panel: create, rename, delete (confirmed: it names the building and how many floors go back to the lot), move buildings
and floors up / down, and move a floor to another building (on top) or to the unassigned lot. Changes save at once;
Esc closes a panel (and cancels a rename first). On a floor, click for mouse look (Pointer Lock), WASD / ↑ ↓ to walk,
← → to turn on the spot (A / D strafe), Shift to run, Esc releases the mouse,
Tab toggles the floor plan (click the plan to walk there; it is also the fallback when pointer lock is refused),
Backspace or the City button goes back, B toggles battery saver (60 Hz moving / 30 Hz idle instead of 120 / 60).
Look at the elevator (south wall, behind you on arrival) and press **E**, or press **L** / the top bar's Elevator
button from anywhere on the floor, for the elevator panel: the building's floors
top to bottom (the lot's floors by name), lit where you are, with running / asleep, working / needs you / idle (asleep:
the worker count), **Wake floor** / **Sleep floor** (confirmed: it names the floor and who is working or waiting), wake
and sleep progress with each agent's resume, and **Settings** per floor. Pick a floor (click, or ↑ / ↓ and Enter) to
ride the doors there. Floor settings: linked repo (the bridge's suggestion is pre-filled and marked until saved),
GitHub Project owner + number, the status field (its name and one row per status, in board order: add, move up / down,
remove; any label round-trips, commas included; it needs no project; the default Status / Todo, Doing, QA, Done is
marked as such and only stored once changed; emptying the name and every status clears it), default folder and
default hire (harness → model → effort from the bridge's `hire_options`); validated like the bridge, and Save sends
only the keys that changed (`null` clears; statuses nobody touched are never re-sent). On an
older bridge a command it does not know shows why and its button stays disabled after that.
Keyboard: in the city, Tab reaches the floor list (Enter goes inside), then the building list (Enter opens that
building's elevator panel, the lot's too).
Hire and send home (M4): look at an empty desk's green "+" and press **E** ("Hire a worker at Desk 11"), or press the
top bar's **Hire** (on an office floor; Shift+Tab, then Tab past Elevator) for the first free desk. The dialog asks the
bridge first (`hire.prepare`), then offers: an optional first task (**Enter** hires, **Shift+Enter** adds a line),
harness → model → effort as chips (Tab into a group, ← → pick; the floor's default hire or the last hire on the floor
is preselected and marked so), the label (the next generated name), the folder (the floor's default; changing it
checks the new folder again), **Work in its own git worktree & branch** (on by default, only when the folder is a git
repo) with the base `origin/<default> @ <sha>, <age>`, and the floor's and host's caps with the host load: a warning
above the soft cap, Hire refused at the hard cap. When `git fetch origin` failed the worktree option is off (a worktree
never branches from a stale origin; the bridge would refuse it with `fetch_failed`), the error sits above the buttons
with **Fetch again**, and hiring without a worktree still works. Warnings sit by the buttons, so they are in view
without scrolling. Hire hides the desk's "+" at once (each hire in flight holds its own desk, so Esc and another hire
meanwhile is fine: the top bar skips desks a hire is on its way to); the new
worker walks in from the street, up the fire escape to its desk, carrying its box with the laptop on top, and sits
down. Look at a worker and press **X** to send it home: its branch and folder, what is left on the desk (uncommitted
changes, commits not on any remote) and, for a worker in a linked worktree of its own, keep / delete the worktree /
delete the worktree and branch (delete only when the bridge says the tree is clean and pushed, else a warning says
why; the branch too only when the bridge made it for this worker, `can_delete_branch`); a main checkout whose worktrees are still open cannot go yet. Focus starts on "keep", where Enter sends it home;
with a delete picked only the button confirms. The worker packs a cardboard box, takes the laptop, walks out down the
fire escape and away along the sidewalk, and the desk gets its "+" back. Walks play for floors of the building you are
in (the interior only for the floor you are on); anywhere else they resolve at once. Esc closes either dialog, and
the pointer lock is released while one is open.
Outside (M3b): every floor has a door at the south end of its west wall; it slides open as you walk up to it, onto the
fire escape. Walk down (or up) the flights to another floor's landing and in through its door: that floor gets the
interior (as elevator travel would), the top bar shows it while you stand on its landing. The last flight comes down
to the sidewalk by the lobby's front. The street is bounded (bollards along the curb, a fence on the fire-escape side,
hedges behind): about 6–8 m round the building. Through the lobby's glass doors on the south side: the reception desk
(look at it and press **E** for the floor directory, the elevator panel), a bench, the elevator. The elevator panel
has a **Lobby** stop under the floors, from anywhere; **L** opens it from the street and the fire escape too. The
floor plan (Tab) is for office floors only. On a floor, Shift+Tab moves focus to the top
bar (City, Issues, PRs, Elevator, battery saver); Tab / Shift+Tab then move between its buttons as usual and Enter
presses one. **L** opens the elevator directly and ← → turn, so travel, wake / sleep and floor settings need no mouse.
Tab toggles the plan only while nothing but the scene has focus; clicking the scene gives it focus back. Panels
re-render live and keep focus, the header's Back / Close included.
Corner office (M3c): every floor is 6.5 m tall (a storey is 6.8 m; the fire escape has 18 risers a flight and still a
half landing). In the north-east corner, over the filing cabinet, a mezzanine (~7 × 5 m, its floor at 3 m, 2.75 m
headroom under it) carries a glass office; an open stair climbs the east wall from the south to its glass door, which
slides open as you come up. Its floor blocks nothing below; its posts, the stair and the glass do. Look at your desk
(the one with the name plate) and press **E** to sit: you turn to face the floor over the glass; **Esc** or walking
(WASD) gets you up. Up there look-at reaches across the whole room (`overlookReach`, its diagonal; the glass does not
stop it, the mezzanine's floor does), so pointing at any worker or empty desk below shows it in the HUD, and cards are
measured as though you stood nearer, with no cap on how many show (on the floor it stays 24), so the whole floor's
show. The floor plan shows the mezzanine's outline, the stair and your desk.

Tests:

```sh
make test lint                # vitest + tsc (protocol client and requests, store, layout, collision, cards, frame
                              # policy, fixtures, settings validation/diffing, reordering, the command simulation)
make shot                     # Playwright WebGL2: game/test-results/{shot,m2-city,m2-floor-plan,m2-desk-row}.png,
                              # scripted look-at path, floor entry, keyboard focus, live plan labels, events
                              # during the elevator ride, held keys across floors, small-window plan; M3 on the
                              # simulating fixture server: m3-{buildings,elevator,settings,statuses,sleep-confirm,
                              # wake-progress,topbar-elevator}.png, buildings from the keyboard, elevator via E
                              # (turning with the arrows), L, the top bar and a city click, keyboard-only travel /
                              # wake / sleep / settings, the status rows, header focus across live updates,
                              # sleep/wake, a failed wake, and an older read-only bridge; M3b on demo-m3b
                              # (m3b.spec.ts): walked with held keys out of the top floor, down the fire escape,
                              # in and out of the asleep middle floor, to the street (blocked at the curb and the
                              # fence) and back in at the bottom floor; in through the lobby's front door (the
                              # greeting once, not again inside the cooldown), E at the desk, the Lobby stop both
                              # ways; the same floor numbers with sim=1, and the top bar at 1024 wide (the counts
                              # drop their words, the name stays whole); m3b-{window-bottom,window-top,
                              # fire-escape,facade,fire-escape-street,lobby,lobby-greeting}.png; M3c on demo-m3b
                              # (m3c.spec.ts): walked with held keys from the elevator up the stair into the
                              # corner office, E at your desk, Esc and walking to get up; from the glass,
                              # lookAt() picks a worker below; the plan's labels; m3c-{mezzanine,desk-view,plan}.png; M4 on demo-m4 with
                              # sim=1 (m4.spec.ts): E at a desk's "+", the dialog from the keyboard (task keys,
                              # chips, Tab order), hire → the walk-in on the reversed route → seated at that desk;
                              # the last choice preselected next time; X on a dirty worker (delete off, the
                              # warning), a clean one sent home with worktree + branch deleted (packing, the box,
                              # the laptop, down the stairs, the "+" back); the top bar's Hire (first free desk);
                              # a worker without a worktree, a blocked main checkout; capacity warn / refuse at
                              # 1024×640; two hires at once (Esc on a pending one), each on its own desk; a failed
                              # fetch at 1024×640 (worktree off, Fetch again, a plain hire); a clean worktree on
                              # the user's own branch (delete the worktree only); walks you cannot see; a
                              # read-only bridge; m4-{hire-dialog,send-home-dirty,send-home-clean,walk-in,
                              # walk-out-pack,walk-out,hire-capacity-warn,hire-capacity-full,
                              # hire-fetch-failed}.png
pnpm -C game test:live        # opt-in: status latency against a throwaway herdr session (see below)
pnpm -C game test:live:m3     # opt-in: buildings across a bridge restart, sleep/wake at the same desks (see below)
pnpm -C game perf:mac         # opt-in: Metal/WebGPU perf + screenshots on the Mac -> game/test-results/perf/
```

`test:live` builds `bin/herdr-world` from the worktree (or runs `H3D_LIVE_BRIDGE=<path>`, e.g. another branch's
bridge built elsewhere), starts `herdr --session h3d-m2game-<random> server` (with
`HERDR_*`/`CLAUDE*` stripped), a private bridge on `$XDG_RUNTIME_DIR/h3d-m2game/bridge.sock` watching only that session,
and the WebSocket → unix-socket proxy on a leased 127.0.0.1 port. The spec flips a custom agent's state with
`herdr pane report-agent` and asserts each change is on screen within 1 s. It accepts an M1 bridge (name falls back
to the label, desk to the lowest free local slot) and the M2 bridge (its own `name` and `desk_index`). The session is stopped and deleted
afterwards; after a hard kill, check `herdr session list` for a leftover `h3d-m2game-*` session.

`test:live:m3` builds the bridge the same way (or `H3D_LIVE_BRIDGE=<path>`), starts `h3d-m3game-<random>` with two
plain-shell workspaces (no coding agents) and the proxy to `$XDG_RUNTIME_DIR/h3d-m3game/bridge.sock`; the spec
(`e2e-live/m3.spec.ts`) runs its own private bridge on it (db `/tmp/h3d-m3game/world.db`, `--sessions
'^h3d-m3game-…$'`) so it can restart it. It creates a building and moves the floor into it from the UI, restarts the
bridge and checks both are still there, then sleeps the floor and wakes it from the elevator panel and checks every
worker kept its desk, and saves floor settings from the panel (a status with a comma among them) and checks the
restarted bridge still has them and that saving one other key sends only that key. On a
bridge without `floor.wake` / `floor.settings.set` (it answers `unknown_command`) those tests are skipped and say so. Afterwards the session is stopped and deleted and the `herdr-s-h3d-m3game-…` unit a wake started is
removed; after a hard kill, check `herdr session list` and `systemctl --user list-units 'herdr-s-h3d-*'`.

`perf:mac` serves `game/dist` on a leased port P and opens `ssh -o ControlMaster=no -o ControlPath=none -N -R
127.0.0.1:P:127.0.0.1:P devmac`, so the Mac page is on its own loopback (a secure context: WebGPU).
It pipes `tools/mac-runner.mjs` into `/opt/homebrew/bin/node` in `~/h3d-tools` (playwright-core, headless Chrome at
3024×1890) and runs `window.__h3d.bench()` — the engine-bench method: serialized update + render + GPU wait,
pipelined throughput, GPU timestamps, and rAF frames that include DOM layout. M3b jobs bench the outside of the
8-floor tower in `perf-city240`: `street8` (the facade from the sidewalk), `escape8` (the top landing, looking down),
`window8` (out of a top-floor window), and `floor60-street`; `bench()` reports the `area` it ran in. M3c jobs:
`floor60-mezz` (at the corner office's glass, looking down over 60 workers), `floor60-desk` (seated at your desk) and
`floor96-desk` (seated over 96 workers who all need you: every card shows).

`window.__h3d` (tests, perf): `backend`, `frames`, `error`, `ready`, `view()`, `lookAt()` → `{kind, id, name?, label?}`
or null, `status(workerId)` → `{status, at}` as last rendered, `world()` (shown `name`/`desk` plus what the bridge
sent, `bridgeName`/`bridgeDesk`, null from an older bridge), `layout(session)`, `enterFloor(session, pose?)`,
`leaveFloor()`, `inject(event)` (applies a protocol event as if the bridge sent it), `setPose({x, z, yaw, pitch})`,
`pose()`, `plan(open)`, `focusBuilding(i)`, `cards()`, `badgePoint(session)`, `bench(opts)`. M3: `view().asleep`
(the office's lights are off), `world()[].building` (its name, null in the lot), `openElevator(building?)` (a building
id, null for the lot, nothing for the current floor's), `openBuildings()`, `openSettings(session)`, `panel()` (what the open panel shows:
elevator rows with state, transition, counts, current, wake/sleep and resume; buildings; the settings form, its
statuses one per row, and whether the repo is the suggestion / the status field the default; any
confirmation; the status line), `sent()` (commands sent, with their results), `floorPoint(session)` (a floor's screen
point in the city, to click its building), `connection()` → `{phase, epoch}`. M3b: `pose()` adds `y` (feet above the
street: the street and the lobby floor are 0, floor k is `(k + 1) × storey` up), `area` (`floor` | `lobby` |
`fire-escape` | `street`), `storey` (the floor you are on, or the landing's floor on the fire escape) and `floor` (its
session); `setPose({x, z, y?, yaw, pitch})` with `y` places you on any floor, landing, the street or in the lobby
(without it you stay at your level); `view()` adds `area` and `building` (and `floor` is the floor with an interior:
the one you are on, or outside the one you last left; null in the lobby); `layout(session)` is in its building's
outline; `building()` (the plan you walk around in: outline, `storey`, fire escape, lobby, fence, road), `where()`
(building id, name, floors ground first, the floor with an interior), `enterLobby(building?)`, `route(session, desk)`
(the M4 walk-out waypoints), `reception()` (the receptionist's `said`, `clips`, `cooldownUntil`, `goodbyeUntil`,
`bubble`) and `receptionEvents()` (front door in / out, elevator arrival, E at the desk, as the game detected them);
`panel()` of the elevator adds `lobby: {current}`. M3c: `layout(session).mezzanine` (the corner office: `rect`, `y`,
`under`, `posts`, `stair` with its treads, `glass`, `door`, `desk`, `sit`, `slab`), `view()` adds `seated` and
`overlook` (up on the mezzanine: whole-floor look-at, nearer and uncapped cards), `pose()` adds `seated`, `sit()` (sits you at your desk as
E does; false unless you stand in your office), and `lookAt()` returns `{kind: 'own-desk', id: 'own-desk', name}` for
your desk (never a worker desk slot, so M4's E-on-"+" hire does not collide with it). `route(session, desk)` walks
the taller storeys past the mezzanine's posts and stair. M4: `openHire(desk?)` (a desk, 0-based, of the floor you are on;
none: the first free one, like the top bar's Hire), `openSendHome(workerId)`, `dialog()` (what the open hire or
send-home dialog shows: its state, the form, the git base, the preselection's note, the capacity view and why Hire is
off; or the fire prepare, which worktree options are enabled, the warning, whether it is blocked, the choice; with the
status line), `arrivals()` (walkers now: kind, desk, phase, position, distance walked of the route's length, what their
desk shows, box / laptop / items), `arrivalLog()` (finished walks, `played: false` for ones nobody could see),
`arrivalRate(k)` (plays walks k times as fast, from where they are), `desks()` (the floor with an interior: who sits at
each desk, whether its "+" shows, what a walk holds it as).

### Audio and voice lines

The game's only sound so far is the lobby receptionist (`src/reception/`), played by a small Web Audio module
(`src/audio/`): positional (the voice comes from the desk), clips fetched and decoded the first time they play, the
AudioContext created on the first click, key or pointer lock (Chrome's autoplay rule), and a no-op without Web Audio
(headless tests). The top bar's mute toggle and volume slider are remembered per browser (`localStorage`
`h3d.audio`); muted, the speech bubbles still show. `src/reception/lines.ts` holds the rules (time-of-day welcome on the
local clock, the elevator line, goodbye, a nudge whose audio stays generic while the bubble lists the waiting floors,
the quiet-building line, the desk line; no variant twice in a row; a 2-minute cooldown each for greetings and goodbyes,
never for the desk), covered by vitest. `src/reception/sequence.ts` says the lines of one event one after the other on
the audio that actually plays (`playAt` returns a handle that resolves when the clip starts and ends): a bubble shows
with its clip, the next line waits for that clip to end, a clip that takes over 1.5 s to load is dropped rather than
played late, and muted or without sound the lines are timed by the lock's clip lengths.

The lines are data: `game/voices/receptionist.json` (`id`, `kind`, `text`; a leading MiMo style tag such as
`(Happy)` is allowed and never shown in the bubble) plus the voice settings. The clips are committed
(`game/public/voices/receptionist/<id>.mp3`), so the game never calls a TTS service. Regenerate them with Xiaomi
MiMo-V2.5-TTS:

```sh
pnpm -C game voices --dry-run   # what would be generated; reads no key, calls nothing
pnpm -C game voices             # generate the lines that are new or changed
pnpm -C game voices --check     # exit 1 on a missing, orphan, stale, broken or changed clip (no calls)
pnpm -C game voices --relock    # after editing a clip by hand: re-record its sha256/size/length (no key, no calls)
node game/tools/voices.ts design --takes 4 --out <dir>   # voice-design takes of the reference script
node game/tools/voices.ts info  # duration, bitrate and size per clip
```

- **Key:** read at run time from `/tmp/xiaomi`, only when a call is about to be made; sent only in the `api-key`
  header, never logged, written or passed to a child process. Never copy it anywhere. Run the generator in its own
  herdr workspace (not a coding agent's), and check with `git grep -F -f /tmp/xiaomi` there so a match is never
  printed where an agent reads it.
- **Voice:** designed once with `mimo-v2.5-tts-voicedesign` from the manifest's description (an original friendly,
  upbeat receptionist), the chosen take committed as `game/voices/receptionist-reference.mp3`, then every line spoken
  with `mimo-v2.5-tts-voiceclone` from that clip, so the receptionist always sounds the same. `voice.use: "builtin"`
  switches every line to one built-in voice (`voice.builtin.voice`, e.g. `Mia`) on `mimo-v2.5-tts` instead. Only ever
  clone the designed reference: the voice (like the art, `docs/decisions.md`) must not imitate the Minions or other
  Illumination characters, or any real person.
- **Idempotent:** `game/voices/receptionist.lock.json` stores per line a `hash` of its text, the performance
  direction, the model and the voice (the reference clip's hash, or the built-in name), and the `sha256`, `bytes` and
  `ms` of the clip it made. An unchanged line is not regenerated; editing a line regenerates only it, a new reference
  take or direction regenerates all, and a removed line's clip is deleted. The lock's `ms` per clip also times the
  bubbles. vitest (`tools/voices.test.ts`, the same audit as `--check`) fails when the manifest, the lock and the
  clips disagree: a line without a clip, a clip without a line, a line changed since its clip was made, a clip that
  isn't MP3, or a clip whose sha256, size or length isn't the lock's (swapped or edited). Edited a clip on purpose
  (trimmed its silence, say)? `--relock` records it; it keeps each line's `hash`, so it never makes a stale line
  current.
- **Size:** keep the clips under about 1 MB in total (the vitest check enforces 1 MiB). MiMo returns MP3 at ~56 kb/s,
  24 kHz, which the generator keeps as is: 27 lines are ~800 KB. Add variants sparingly, and keep lines short.
