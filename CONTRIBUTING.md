# Contributing

## Layout

- `cmd/herdr-world` — server-side bridge daemon (Go).
- `cmd/h3d-helper` — Mac-side helper (Go, cross-compiled for `darwin/arm64`).
- `internal/` — shared Go packages. Bridge: `herdr` (the only herdr client, read-only), `watch` (session discovery and
  per-session watchers), `world` (floors/workers from snapshots and `session.json`, identity matching, worker names),
  `store` (SQLite), `server` (hub + WebSocket), `proto` (protocol v1 types and client). Helper: `helper` (ssh tunnel
  supervisor, game server, `/ws` proxy). `app` holds both command lines.
- `deploy/` — `herdr-world.service` (systemd `--user`), `com.jeffreyvdb.h3d-helper.plist` (launchd user agent, Mac).
- `game/` — the game: Vite + strict TypeScript + three.js (`three/webgpu`), pnpm.

## Toolchain

Go 1.27 (see `go.mod`), Node 24.18 (`game/.nvmrc`), pnpm 11.7 (`packageManager` in `game/package.json`),
`portlease` for ports. CI uses the same pins.

## Build and test

```sh
make build test lint   # Go binaries -> bin/, game bundle -> game/dist/, go test + vitest, vet/gofmt/tsc
make integration       # bridge against a real herdr in a throwaway session (see below)
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

Protocol: [`docs/protocol.md`](docs/protocol.md). The bridge only **reads** herdr: every herdr call goes through
`internal/herdr`, whose socket methods are allowlisted to `ping`, `session.snapshot` and `events.subscribe` (plus
`herdr session list --json`). `TestReadOnlyAllowlist` is the tripwire; widening it needs review. Its own state is the
SQLite database.

Run a private instance next to (or instead of) the real one; `dump` and `cmd` take the same `--socket`:

```sh
make go-build
sock=$XDG_RUNTIME_DIR/h3d-dev/bridge.sock   # unix socket paths must stay under ~107 bytes
bin/herdr-world --socket "$sock" --db /tmp/h3d-dev/world.db --log-level debug
bin/herdr-world dump --socket "$sock"            # snapshot, then events as JSON lines until Ctrl-C
bin/herdr-world dump --socket "$sock" --once | jq '.world.floors'
bin/herdr-world cmd --socket "$sock" building.create '{"name":"Work"}'
bin/herdr-world cmd --socket "$sock" floor.assign '{"session":"herdr-3d","building":"b_…"}'
```

| flag | env | default |
|---|---|---|
| `--socket` | `HERDR_WORLD_SOCKET` | `$XDG_RUNTIME_DIR/herdr-world/bridge.sock` |
| `--db` (serve) | `HERDR_WORLD_DB` | `$XDG_STATE_HOME/herdr-world/world.db`, else `~/.local/state/herdr-world/world.db` |
| `--herdr` | `HERDR_WORLD_HERDR` | `herdr` on `PATH` |
| `--sessions` | `HERDR_WORLD_SESSIONS` | all; a regexp limits which sessions are watched |
| `--poll`, `--resnapshot` | `HERDR_WORLD_POLL`, `HERDR_WORLD_RESNAPSHOT` | `2s`, `30s` |
| `--max-desks` | `HERDR_WORLD_MAX_DESKS` | `96`: cap on the desks a floor renders beyond its occupied ones (`floor.desks`) |
| `--name-hold` | `HERDR_WORLD_NAME_HOLD` | `168h` (7 days): how long a worker's name stays held after the bridge sees it leave its floor; then a newcomer may take it (`worker.name`) |
| `--log-level`, `--log-format` | `HERDR_WORLD_LOG_LEVEL`, `HERDR_WORLD_LOG_FORMAT` | `info`, `text` (or `json`) |

Install as a user service:

```sh
install -Dm755 bin/herdr-world ~/.local/bin/herdr-world
install -Dm644 deploy/herdr-world.service ~/.config/systemd/user/herdr-world.service
systemctl --user daemon-reload && systemctl --user enable --now herdr-world
journalctl --user -u herdr-world -f
```

### Integration test

`go test ./...` never touches herdr (fake socket server + recorded fixtures). `make integration` runs
`TestIntegrationThrowawaySession` (build tag `integration`) against the installed herdr: it starts a headless server for
a fresh session `h3d-it-<random>`, creates workspaces, reports a custom agent's states through `herdr pane report-agent`
(no real coding agent), closes a workspace, stops the session, and asserts the bridge's events. It always passes
`--session h3d-it-…` explicitly, strips `HERDR_*`/`CLAUDE*` pane variables from herdr's environment, and stops and deletes
the session in `t.Cleanup`, also on failure. It never touches any other session, so it is safe to run from inside a
herdr pane. If a run is killed hard, check `herdr session list` for a leftover `h3d-it-*` session and
`herdr session stop`/`delete` it.

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
