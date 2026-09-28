# Contributing

## Layout

- `cmd/herdr-world` — server-side bridge daemon (Go).
- `cmd/h3d-helper` — Mac-side helper (Go, cross-compiled for `darwin/arm64`).
- `internal/` — shared Go packages.
- `game/` — the game: Vite + strict TypeScript + three.js (`three/webgpu`), pnpm.

## Toolchain

Go 1.27 (see `go.mod`), Node 24.18 (`game/.nvmrc`), pnpm 11.7 (`packageManager` in `game/package.json`),
`portlease` for ports. CI uses the same pins.

## Build and test

```sh
make build test lint   # Go binaries -> bin/, game bundle -> game/dist/, go test + vitest, vet/gofmt/tsc
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
