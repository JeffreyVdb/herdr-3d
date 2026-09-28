# Contributing

## Layout

- `cmd/herdr-world` — server-side bridge daemon (Go).
- `cmd/h3d-helper` — Mac-side helper (Go, cross-compiled for `darwin/arm64`).
- `internal/` — shared Go packages. Bridge: `herdr` (the only herdr client, read-only), `watch` (session discovery and
  per-session watchers), `world` (floors/workers from snapshots and `session.json`, identity matching), `store` (SQLite),
  `server` (hub + WebSocket), `proto` (protocol v1 types and client), `app` (CLI).
- `deploy/` — `herdr-world.service` (systemd `--user`).
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
