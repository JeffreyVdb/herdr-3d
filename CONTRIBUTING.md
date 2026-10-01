# Contributing

## Layout

- `cmd/herdr-world` — server-side bridge daemon (Go).
- `cmd/h3d-helper` — Mac-side helper (Go, cross-compiled for `darwin/arm64`).
- `internal/` — shared Go packages. Bridge: `herdr` (the only door to herdr: the read-only client and the allowlisted
  control surface for wake/sleep, hire/send home and the laptops), `watch` (session discovery and per-session watchers), `world`
  (floors/workers from snapshots and `session.json`, identity matching, worker names), `store` (SQLite), `server` (hub +
  WebSocket, wake/sleep, floor settings, hire/send home, M6 team presets and `run.start`), `proto` (protocol v1 types and client), `gitremote` (GitHub
  origin of a directory, for the repo suggestion), `gitops` (the typed git runner of hires, send-homes and the Changes
  panel), `codex` (Codex session ids and rollout files, for the sleep backfill and usage), `usage` (M5: agents' token
  usage and cost from their transcripts, read incrementally, and the pricing table), `jsonl` (the shared reading of
  those JSONL files: one tail per transcript, complete lines from byte offsets, no symlinks), `transcript` (M16: the
  Claude and Codex transcripts as one timeline of items, indexed by offset for the laptop's conversation view; phase 2:
  their images as `ImageRef`s, decoded, hashed and resolved through the allowlist of path roots; #57: the agents'
  structured questions, `AskTracker` knowing the one a session's latest turn waits on, fed the usage tail's lines, and
  the question cards of their tool items), `imgcache` (M16 phase 2:
  the bounded content-addressed image cache, memory LRU plus an optional 0600/0700 disk cache; the type sniff, the
  thumbnails, the path allowlist; pure Go), `runs` (M6: write-code runs, the
  freelancers' reports in the runs directory, their links to their orchestrator and their desks next to it), `limits` (M10: the Claude and
  Codex plan limits, read by running the two CLIs as probes through a fake-able process runner), `logo` (M3d: PNG, WebP
  and restricted SVG in, one PNG of at most 1024 px out; pure Go, only the bridge uses it), `upload` (#51: one image
  streamed to Drop Zone as one multipart request, the type sniffed and the size capped on the bytes, its path returned
  verbatim; pure Go, a fake-able HTTP client, the bridge's `POST /upload` uses it); M7 boards:
  `provider` (what the two interfaces share: people, comments, rate, error kinds), `tracker` (the neutral issue
  interface) and `codehost` (the neutral pull request interface), `github` (the GitHub provider behind both: one feed per
  repository and project, the writes) and `githubcli` (the typed `gh` runner). `server`, `store` and `proto` never import
  `github` or `githubcli` (`TestBoardLayerIsProviderNeutral`): `app` wires the provider in. Helper: `helper` (ssh tunnel
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
make shot              # headless WebGL2 screenshot -> game/test-results/shot.png (non-blank check), seconds
make e2e               # the full Playwright suite (e2e/*.spec.ts), H3D_WORKERS parallel workers, ~7.5 min, one run per host
```

- `make shot` (only `e2e/shot.spec.ts`) and `make e2e` (every spec) run Playwright against the **cached** Chromium in
  `~/.cache/ms-playwright` (`@playwright/test` is pinned to the version that matches it). Browsers are never downloaded (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`). It forces the
  WebGL2 backend (`?backend=webgl2`) because the server has no GPU; rendering goes through ANGLE → Vulkan → mesa llvmpipe.
- `make e2e` runs `H3D_WORKERS` tests in parallel (default 6, a positive integer; anything else falls back to it).
  Playwright runs with `fullyParallel`, so the tests of one spec file are spread over the workers too. Every test opens
  its own page against the shared preview server and writes only its own `test-results/<name>.png`, so keep it that
  way: no shared files, no fixed ports, no order between tests (also within a file: no `describe.serial`, no pages
  shared through `beforeAll`, no module-level mutable state). Lower it on a loaded machine if timeouts appear.
- `make e2e` and `make shot` take a host-wide lock (`flock` on `$XDG_RUNTIME_DIR/herdr-3d-e2e.lock`, `/tmp` without
  it): one Playwright run at a time per host. Two suites side by side take about as long as two in a row, but both
  render below 10 fps on llvmpipe, where game time runs slower than wall time and fixed polls time out. A second run
  prints `waiting for another worktree's e2e run (…)` and starts when the first ends (or fails, or is interrupted).
  Without `flock` (util-linux), or when the lock can't be taken, both targets fail before Playwright starts, never
  run unlocked. Running `pnpm exec playwright` directly skips the lock.
- The page exposes `window.__h3d` (`backend`, `frames`, `error`) for tests.
- M17: every spec's `openGame` pins the time (`&time=2026-09-30T12:00`, `NOON` in `e2e/game.ts`) unless the test passes its
  own `time=`, and `make shot` goes through it: no spec reads the wall clock's daylight. A test of the real clock fixes
  the browser's clock with `page.clock.setFixedTime` and its zone with `timezoneId` (`e2e/m17-daynight.spec.ts`).
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
- **Writes** (`herdr.Control`), for `floor.wake` / `floor.sleep`, `worker.hire` / `worker.fire` and the laptops (M5)
  only: exactly the command shapes in `controlShapes`.
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
  - Laptops (M5, `terminal.watch`, `worker.keys` / `prompt` / `answer`): the read-only, long-running `terminal session
    observe <pane> --cols <40–300> --rows <10–100>` (its own process group; SIGTERM, SIGKILL after 1 s, always reaped),
    `pane send-keys <pane> <key>…` (only the key names in `docs/protocol.md` "Input", and the digits 1–9 of a menu),
    `pane send-text <pane> <text>` (no control characters) and the fixed sequences of delete / home / end / pageup /
    pagedown, `agent prompt <pane> <text>` with `--wait --until working --until blocked --timeout 8000` or without
    (queued for an agent at work), and the hire's `pane read <pane> --source visible` (a blocked worker's question).
    #74's fullscreen laptop adds exactly two: `pane zoom <pane> --on` and `pane zoom <pane> --off` (explicit modes,
    never `--toggle`; `Control.SetZoom`), each write its own `pane.zoom` audit row (`{"session","pane","mode","why"}`).
    #57's `worker.answer_ask` uses these same shapes (digits, arrows, `tab`, `enter`, `esc`, `send-text`, `pane
    read` between steps): no new one.
    Typed text is never quoted in an error or the audit log. A herdr CLI call takes about 10 ms, so input goes through
    the CLI (consecutive keys, and texts, batched into one call); the socket's `pane.send_input` is not used.

  Every variable is validated (session names, pane/workspace ids, agent session ids, absolute clean directories,
  labels without control characters or a leading `-`, `h3d/…` branches, `origin/…` bases, `h3d-<hex>` markers, models
  and efforts, prompts not starting with `--`), every argument is its own argv element, sessions outside `--sessions`
  are refused, and commands run with the `HERDR_*`/`CLAUDE*` variables stripped. `TestControlAllowlist` pins the set,
  the argv and the exported methods; widening any needs review.
- **git** (`gitops.Git`, hires, send-homes, `worker.changes` and, M7, `worker.open_pr`): exactly sixteen shapes (`shapes`,
  pinned by `TestGitAllowlist`):
  `git -C <dir>` `rev-parse --show-toplevel`, `fetch --quiet origin`, `symbolic-ref --quiet --short
  refs/remotes/origin/HEAD`, `log -1 --format=%H %ct origin/<…> --`, `status --porcelain`, `symbolic-ref --quiet --short
  HEAD`, `rev-list --count HEAD --not --remotes`, `rev-list --count refs/heads/h3d/<…> --not --remotes`, `rev-parse
  --verify --quiet refs/heads/h3d/<…>`, `branch -D h3d/<…>`, and for the Changes panel (M5, read-only) `status
  --porcelain=v2 --branch -z --untracked-files=all`, `merge-base HEAD origin/<…>` and `diff --numstat --patch -z
  --find-renames --no-color --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/ <commit id | HEAD> --`, and for
  opening a pull request (M7) `push -u origin refs/heads/h3d/<…>:refs/heads/h3d/<…>` (the branch name is validated
  and is only ever the one the bridge recorded for that worker; the one shape that writes outside the checkout),
  `rev-list --count HEAD --not origin/<…>` and `log --format=%s -n 20 HEAD --not origin/<…> --`. A
  branch is deleted only when the bridge recorded
  making it for that worker (SQLite `hire_branch`, with its base commit; the name alone proves nothing) and either
  still points at that base (a hire's rollback, clean tree) or has all its commits on a remote (send home, the
  checkout still on it). Same clean environment, plus `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`.

- **claude / codex** (`limits`, M10, read-only, no session): exactly two probes, each a child of the bridge in a fresh
  empty temp directory with `CLAUDECODE*` and `HERDR_*` removed from the environment, killed when it does not exit:
  `claude -p --input-format stream-json --output-format stream-json --verbose --tools '' --setting-sources ''
  --strict-mcp-config --disable-slash-commands --no-session-persistence` (one `get_usage` control request on stdin) and
  `codex app-server` (JSON-RPC `initialize`, `initialized`, `account/rateLimits/read`). They start no conversation, cost
  no tokens and write no session file; the bridge only reads Codex rollouts as a fallback. Nothing runs while no client
  is connected. Lookup prefers `PATH`, then `~/.local/bin`, as model discovery does. `--claude` / `--codex` name
  the executables, `--no-limits` turns it off (protocol: "Plan limits").
  `make integration` runs the live check that ten probes leave no Claude project and no Codex rollout behind.
- **gh** (`githubcli.Client`, M7 boards): exactly one shape, `gh api graphql --method POST --input -`, with the request
  as JSON on stdin: `{"query": <one of the embedded documents in internal/githubcli/queries>, "variables": {…}}`.
  Never a query, a field or an argument from a client. `gh` keeps its own authentication (the bridge stores no
  token); the environment is the bridge's minus `HERDR_*` / `CLAUDE*`, plus `GH_PROMPT_DISABLED=1 NO_COLOR=1
  GH_NO_UPDATE_NOTIFIER=1`; 20 s per call, output capped at 8 MiB; GraphQL `errors` are read also when `gh` exits 0;
  401 / exit 4 is `provider_failed` "GitHub auth", a rate limit is `rate_limited`. `TestGitHubAllowlist` pins the argv,
  the set of documents and which of them write (six mutations: addComment, addProjectV2ItemById,
  updateProjectV2ItemFieldValue, closeIssue, mergePullRequest, createPullRequest).

- **Logos** (M3d, `internal/logo`; SVGs are drawn by the bridge's own executable run again as a killable child, see below): the image libraries are `golang.org/x/image` (`webp`, `draw`; BSD-3),
  `github.com/srwiley/oksvg` and `rasterx` (BSD-3; pinned pseudo-versions, untagged upstream) and `golang.org/x/net`
  (their charset reader), all pure Go, so `make helper-darwin` (CGO off) still builds. `h3d-helper` shares the `app`
  package with the bridge and so links them, but never calls them. The PUT body is read with `http.MaxBytesReader`
  (1 MiB), converted by `logo.Converter` (2 at a time, 10 s to wait for a slot, a 5 s deadline for drawing an SVG), stored as PNG bytes in
  `building_logo` (migration after `migrationBoards`) and announced with a `building.upsert`. `go test ./internal/logo`
  has generated PNGs (alpha, wide, tall, oversize, truncated), the two WebP fixtures in `internal/logo/testdata` (lossless
  and lossy with alpha, from `golang.org/x/image`'s test data), an animated WebP, and a table of hostile SVGs. Extending
  the SVG subset means adding a test here first: the sanitiser in `svg.go` decides what a document may contain, oksvg does not. oksvg
  matches local names and reads every attribute (`style=`, upper-case names, foreign namespaces), so `sanitizeSVG` does
  not just check the upload: it re-serialises it (SVG-namespace elements from an allowlist, attributes from an allowlist
  by exact name, `style=` cut down to checked presentation properties, foreign markup and text dropped) and oksvg reads
  only that copy. A new element, attribute or style property therefore needs an entry in `svgElements`, `svgAttrs` or
  `svgStyleProps` and its checks in `checkProp`, plus a row in `TestSVGRefusals` or `TestSVGForeignMarkupIsDropped`.
  Dashes are not supported and stay out: `stroke-dasharray`/`stroke-dashoffset` are not in `svgAttrs`, so they are dropped
  and strokes render solid (`TestSVGDashesAreDropped`), because rasterx's dashing cost cannot be bounded from the source
  (it quantises dashes independently of the scales that enlarge the path).
  What drawing may cost is not decided by any check of the source (a 65 KB document of nested unit-column transforms
  took over 20 s in-process, and oksvg/rasterx take no context), so it is bounded by killing a process, not by
  estimating: `logo.Converter` hands the sanitised copy to a **render worker**, `/proc/self/exe logo-worker` (the
  bridge's own binary; `os.Executable` elsewhere) with `H3D_LOGO_WORKER=1`, over stdin/stdout. `worker.go` enters worker
  mode from `init`, before `main` and any bridge setup (no store, no socket), so it also works in `go test`: the test
  binary re-executes itself, and no package needs a `TestMain` for it. The parent (`convert.go`) kills the worker's process
  group at `DefaultRenderTimeout` (5 s; `Converter.SetRenderTimeout`, `Server.SetLogoRenderTimeout`), on the caller's
  cancellation and at 8 MiB of output, always reaps it, holds the conversion slot only as long as it lives, gives it
  a minimal environment, and accepts only a PNG of at most 1024 px. In the worker, `RLIMIT_CPU` (deadline + 1 s),
  no core dumps and `debug.SetMemoryLimit` are defence in depth (an address-space limit does not work with the Go
  runtime). Timeout is `logo_unsupported` (`logo.ErrTimeout` together with `ErrUnsupported`), a crash or garbage is
  `logo_invalid`, a worker that cannot start is `internal`. `svgMaxWork`, `svgMaxStops` and `svgRenderBudget` stay as best-effort
  early refusals with clear messages (`TestSVGCostBounds`), not as a bound; PNG and WebP stay in-process (the pixel
  caps read from the header bound them). `worker_test.go` has the slow document (`TestSlowSVGIsKilledAtTheDeadline`:
  refused at the injected deadline, the child gone, the slot free), two hostile conversions not blocking a third, a
  table of misbehaving workers (crash, exit codes, garbage, oversize output, a worker that never reads or never ends,
  a grandchild) and the CPU limit. `deploy/herdr-world.service` needs nothing for this (no `noexec` or syscall
  filter that would stop the bridge executing itself); keep it that way.
  A `GET /logo/{id}?h=` with a hash that is not the current one is `404` (never the new image under the old hash), and
  the game's `LogoCache` never files bytes under a hash they do not have.

Everything else the bridge changes is its own SQLite database. How a wake and a sleep go, and what they log:
[`docs/protocol.md` "Wake and sleep"](docs/protocol.md#wake-and-sleep); hiring and sending home:
[`docs/protocol.md` "Hire and send home"](docs/protocol.md#hire-and-send-home).

At startup, the bridge discovers hire models from the installed harnesses: Codex `app-server`'s `model/list` and
Claude Code's SDK initialization response. Both probes run concurrently, with a 10 s timeout each, in temporary
directories. They send no prompt, start no agent turn, and are reaped after discovery; Claude tools, MCP servers,
hooks and session persistence are disabled for the probe. The resulting `hire_options` is shared by hiring, floor
defaults and team presets. Model-specific effort levels are retained. Each failed probe logs a warning and keeps
that harness's legacy fallback list. Restart the bridge after updating a harness or changing its account/config
to load its new catalog. Research and protocol details: [`docs/research/harness-model-discovery.md`](docs/research/harness-model-discovery.md).
Executable lookup prefers `PATH`, then `~/.local/bin`, so native harness installations also work under systemd's
restricted `PATH`. Use `--codex-cli` / `--claude-cli` for other installation paths.

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

To try starting a run (M6), in the same throwaway session and repository: link the floor to a repo name (the bridge never
calls GitHub) and send an explicit, harmless `prompt` with a cheap `orch`, so no write-code run starts:

```sh
bin/herdr-world cmd --socket "$sock" floor.settings.set "{\"session\":\"$s\",\"repo\":\"h3d/lab\",\"default_cwd\":\"$repo\"}"
bin/herdr-world cmd --socket "$sock" run.prepare "{\"session\":\"$s\",\"issue\":3}" | jq -r .data.prompt
bin/herdr-world cmd --socket "$sock" run.start "{\"session\":\"$s\",\"desk_index\":3,\"issue\":3,\"preset\":\"<id from run.prepare>\",\"orch\":{\"harness\":\"codex\",\"model\":\"gpt-6-luna\",\"effort\":\"low\"},\"prompt\":\"Reply with exactly the word: pong\"}"
sqlite3 /tmp/h3d-mytask/world.db 'select id, run_id, repo, issue_number, preset_name from run_launch'
```

To try the boards (M7), link a floor to a repository and, for Status columns, a Projects v2 project (both settings the
bridge already had), and watch it. **Read** a real repository freely, but **write only to a throwaway one**
(`JeffreyVdb/h3d-lab`, project 3): a comment, a status change, a close, a merge or a push on a real repository is real.
`dump --board` prints the messages of a watch, `cmd` sends the commands:

```sh
bin/herdr-world cmd --socket "$sock" floor.settings.set "{\"session\":\"$s\",\"repo\":\"JeffreyVdb/herdr-3d\",\"project\":{\"owner\":\"JeffreyVdb\",\"number\":2}}"
bin/herdr-world dump --socket "$sock" --board $s --once | jq -c 'select(.t == "board.issues" and .fetched_at > 0) | {columns: [.columns[].name], cards: [.cards[] | {key, column, state}]}'
gh project item-list 2 --owner JeffreyVdb --format json | jq '.items[] | {n: .content.number, status}'   # the same, from gh
# on the lab repo (link it first: repo JeffreyVdb/h3d-lab, project {JeffreyVdb, 3}):
bin/herdr-world cmd --socket "$sock" issue.comment "{\"session\":\"$s\",\"id\":\"JeffreyVdb/h3d-lab#3\",\"body\":\"hello\"}"
bin/herdr-world cmd --socket "$sock" issue.close "{\"session\":\"$s\",\"id\":\"JeffreyVdb/h3d-lab#3\",\"reason\":\"completed\",\"confirm\":true}"
bin/herdr-world cmd --socket "$sock" worker.open_pr.prepare '{"id":"<a plain worktree hire on the lab repo>"}'
bin/herdr-world cmd --socket "$sock" pr.merge "{\"session\":\"$s\",\"id\":\"JeffreyVdb/h3d-lab#5\",\"method\":\"squash\",\"confirm\":true}"
sqlite3 /tmp/h3d-mytask/world.db 'select cmd, ok, error, args, result from audit_log where cmd like "issue.%" or cmd like "pr.%" or cmd like "worker.open_pr%"'
```

`go test -tags live ./internal/github -run TestLiveBoard -v` reads a repository through the real `gh` (default
`JeffreyVdb/herdr-3d` and its project 2; `H3D_LIVE_REPO`, `H3D_LIVE_PROJECT=owner/number`) and writes nothing.

herdr puts worktrees in `~/.herdr/worktrees/<repo name>/`: give a throwaway repository a unique name and remove that
directory when done. Answering a trust dialog is remembered by the agent (`~/.claude.json`, `~/.codex/config.toml`) for
that directory.

| flag | env | default |
|---|---|---|
| `--socket` | `HERDR_WORLD_SOCKET` | `$XDG_RUNTIME_DIR/herdr-world/bridge.sock` |
| `--db` (serve) | `HERDR_WORLD_DB` | `$XDG_STATE_HOME/herdr-world/world.db`, else `~/.local/state/herdr-world/world.db` |
| `--herdr` | `HERDR_WORLD_HERDR` | `herdr` on `PATH` (a woken server runs `herdr` from the login shell's `PATH`) |
| `--codex-cli` | `HERDR_WORLD_CODEX_CLI` | `codex` on `PATH`, else `~/.local/bin/codex`: startup model discovery |
| `--claude-cli` | `HERDR_WORLD_CLAUDE_CLI` | `claude` on `PATH`, else `~/.local/bin/claude`: startup model discovery |
| `--systemd-run` | `HERDR_WORLD_SYSTEMD_RUN` | `systemd-run` on `PATH`: starts woken sessions |
| `--sessions` | `HERDR_WORLD_SESSIONS` | all; a regexp limits which sessions are watched, and the only ones commands may wake, sleep, configure, hire into or send workers home from |
| `--poll`, `--resnapshot` | `HERDR_WORLD_POLL`, `HERDR_WORLD_RESNAPSHOT` | `2s`, `30s` |
| `--max-desks` | `HERDR_WORLD_MAX_DESKS` | `96`: cap on the desks a floor renders beyond its occupied ones (`floor.desks`) |
| `--name-hold` | `HERDR_WORLD_NAME_HOLD` | `168h` (7 days): how long a worker's name stays held after the bridge sees it leave its floor; then a newcomer may take it (`worker.name`) |
| `--wake-timeout` | `HERDR_WORLD_WAKE_TIMEOUT` | `10s`: how long a woken server has to start, answer `ping` and be seen running (else `wake_failed`) |
| `--resume-timeout` | `HERDR_WORLD_RESUME_TIMEOUT` | `10s`: how long a wake waits for the agents before the fallback, and again for the fallback and its result (a wake acks within about `--wake-timeout` + 2 × this) |
| `--codex-sessions` | `HERDR_WORLD_CODEX_SESSIONS` | `$CODEX_HOME/sessions`, else `~/.codex/sessions`: Codex rollouts, for the sleep backfill and usage |
| `--claude-projects` | `HERDR_WORLD_CLAUDE_PROJECTS` | `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`: Claude Code transcripts, for usage (M5) |
| `--runs-dir` | `H3D_RUNS_DIR` | `$XDG_STATE_HOME/write-code/runs`, else `~/.local/state/write-code/runs`: write-code's run directories, for the freelancers' reports (M6, [`docs/protocol.md` "Runs and freelancers"](docs/protocol.md#runs-and-freelancers)); read only |
| `--dropzone-url` | `HERDR_WORLD_DROPZONE_URL` | `http://127.0.0.1:8080`: Drop Zone, where pasted images are uploaded (#51, [`docs/protocol.md` "Image upload"](docs/protocol.md#image-upload)); the bridge's only client of it |
| `--pricing` | `HERDR_WORLD_PRICING` | none: a JSON file of model prices merged over the built-in table (`internal/usage/pricing.json`; format in [`docs/protocol.md` "Usage and cost"](docs/protocol.md#usage-and-cost)) |
| `--warn-workers-per-floor`, `--max-workers-per-floor` | `HERDR_WORLD_WARN_WORKERS_PER_FLOOR`, `HERDR_WORLD_MAX_WORKERS_PER_FLOOR` | `12`, `24`: above the first the hire dialog warns, a hire above the second is refused (`capacity`) |
| `--warn-workers`, `--max-workers` | `HERDR_WORLD_WARN_WORKERS`, `HERDR_WORLD_MAX_WORKERS` | `48`, `96`: the same for all watched running floors together |
| `--git` | `HERDR_WORLD_GIT` | `git` on `PATH`: worktree hires, send-home checks and the repo suggestion |
| `--gh` | `HERDR_WORLD_GH` | `gh` on `PATH`: the issue and pull request boards (M7); without it boards say `gh not found` |
| `--max-watches` | `HERDR_WORLD_MAX_WATCHES` | `6`: laptop screens (`terminal.watch`) one connection may watch at once (`capacity` above) |
| `--max-observers` | `HERDR_WORLD_MAX_OBSERVERS` | `16`: laptop screens watched at once over all connections, one `terminal session observe` each |
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
(`testdata/`, no real content) and temp files; `internal/runs` and the M6 hub tests read temp run directories and a
synthetic over-cap run (`game/fixtures/runs/20260928-1400-overcap`, the very run the game's `demo-m6` floor is built
from: `TestOverCapFixture` reads it in place). `make integration` runs,
with build tag `integration`, against the installed herdr (the board code is tested without GitHub: the `internal/github`
and board tests run a fake `gh` over recorded GraphQL fixtures in `internal/github/testdata`, and the server tests fake
both providers):

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

- `TestIntegrationLaptops` (M5): a plain-shell workspace's screen through `terminal.watch` (a full frame, then diffs
  showing what `worker.keys` typed), no `terminal session observe` process left (a `/proc` scan for the session's name,
  unreaped ones included) after 20 watch / unwatch cycles, a connection closed mid-watch and a workspace closed while
  watched (`terminal.closed` `worker_removed`); then a Claude (`claude-haiku-4-5-20251001`, `low`, `--permission-mode
  default`) in a folder it has not seen: its trust dialog is a `trust` question, a wrong hash is `stale`, the "Yes, I
  trust this folder" choice resolves it; a prompt is submitted, one sent while it works is `queued`; a Bash tool
  permission prompt is a `permission` question that choice 1 approves (the command ran). About 30 s, a few haiku turns.
  The agent remembers the trust of the test's temporary directory.

- `TestIntegrationFullscreenLaptop` (#74): a two-pane tab watched with `fullscreen` against the real herdr: without it
  nothing is zoomed; headless the flag flips (`headless`, 120 × 40) and is put back on `terminal.unwatch`; with a TUI
  attached (a `python3` pty client at 140 × 50, skipped without python3) the watch is the tab's whole content area,
  a human unzooming is reported (`terminal.state`) and not undone, a tab the human zoomed is never put back, and the
  audit log has one `pane.zoom` row per write. About 4 s, no agent.
- `TestIntegrationRunStart` (M6 launch): `run.prepare` on a floor linked to a made-up repo (Build team by default), then
  `run.start` twice into worktrees of a local repository with a bare "origin": a Claude orchestrator
  (`claude-haiku-4-5-20251001`, `low`) on an issue and a Codex one (`gpt-6-luna`, `low`) on free text, both chosen in
  the command over the preset's and given an explicit multi-line prompt (never `/write-code`) that only the whole text
  answers: each must reply with it, so the prompt arrived intact as one prompt. Checks the desk, label, ack, `run_launch`
  and `last_preset`, and that `herdr workspace report-metadata … --token h3d_run=…` fills `run_launch.run_id`. About
  30 s, one short turn each.
- `TestIntegrationRuns` (M6): a write-code run without agents: plain workspaces, an `ORCH|…`, a coder and a reviewer
  created and tagged with `workspace report-metadata` the way the skill does it, and a label-only coder; reports
  published by rename into a temporary `--runs-dir`. It checks the links, the issue from the floor's repo, the desks
  next to the orchestrator, the report states (pending, ready with verdict and counts, pending again for a new
  `h3d_report`, invalid) and `over_cap`.

The screens the question parser is tested on (`internal/server/testdata/screens`) were captured the same way, from
throwaway sessions (`herdr pane read <pane> --source visible`): Claude's trust dialog, its Bash and Write permission
prompts, an AskUserQuestion menu, Codex's approval (`-a on-request -s read-only`, a command outside the sandbox) and its
trust dialog. #57 adds every shape of the structured-question dialogs, `claude-ask-*` (one question, two and four with
tabs and the review, multi-select, Other typed, previews, long questions at 100 × 30 and 200 × 50, a `--name`d session
herdr called idle; `.status.json` beside a screen is `herdr agent list` at that moment) and `codex-ask-*` (Plan mode /
`default_mode_request_user_input`: one and three questions, Other with notes, long ones), which the dialog parsers
(`askscreen.go`) and `worker.answer_ask`'s drivers are tested on, each key step against the screen it led to live
(the grounding of #57 has the sequences). Recapture them when an agent's dialogs change; for a Claude that must write
its pending call to the transcript use Sonnet, or Haiku with `--strict-mcp-config` (Haiku with MCP servers does not).

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
- it serves the game on `http://127.0.0.1:7777` (loopback only; a secure context, so WebGPU works) from the game
  embedded in its binary (release builds; `make embed-game`), from a `game/dist` copy with `-bundle`, or proxies a Vite
  dev server with `-dev-upstream`;
- it proxies `GET /ws` to the bridge, after checking Host, Origin and the helper token (`docs/protocol.md`
  "Through h3d-helper");
- (M3d) it proxies `GET|PUT|DELETE /logo/{building}` (building logos) to the bridge: Host and the `?token=` as for `/ws`, but
  an **absent** `Origin` passes on a `GET`, because a browser does not send `Origin` on a same-origin `GET` (an `<img>` or
  a `fetch`); a present one must be the helper's own, on `PUT` and `DELETE` too. The token, `Origin`, `Cookie` and
  `Authorization` are not forwarded, an upload over 1 MiB is refused (`413`) at the helper, other methods get `405`, and the
  routes come before the game fallback (also with `-dev-upstream`). The image conversion is the bridge's: the helper only
  moves bytes. `go test ./internal/helper -run Logo` covers the checks with a fake bridge and once end to end;
- (#51) it proxies `POST /upload` (one image on its way to Drop Zone) to the bridge, guarded exactly like `/logo`
  (`checkLogo`), with the token, `Origin`, `Cookie` and `Authorization` not forwarded and only `label` and `n` kept. A
  body over `upload.MaxBytes` + 4 KiB is refused with `413` `upload_too_large`, by `Content-Length` and by counting a
  chunked one; its `403`, `413` and `502` are the protocol's error object, and other methods get `405`. The route comes
  before the game fallback. `go test ./internal/helper -run Upload`;
- it opens a Chrome `--app` window on `http://127.0.0.1:7777/#token=…` with its own profile (`-no-open` skips that; it also skips it when the game is installed as a Chrome app, see
  `docs/releasing.md`).
  The token is kept in a file and survives restarts, so an open game window reconnects by itself.
- (M7) `POST /api/open {"url": "https://github.com/…"}` opens a page in the Mac's default browser (`open <url>`), for
  the game's "Open in GitHub" buttons and the links in issue bodies. Same Host and Origin checks as `/ws`, the token in
  the `X-H3D-Token` header (never in a URL), `Content-Type: application/json`, a body of at most 4 KiB; only `https://`
  URLs on a listed host (`internal/helper.DefaultOpenHosts`: `github.com`; a provider added later adds its host there),
  no credentials or port, no control characters. `204` on success, `400` for a refused URL, `403` for a failed check,
  `502` when `open` failed; `go test ./internal/helper` covers it with a fake opener. A page not served by the helper
  (Vite on the server) has no endpoint, and the game opens a new window instead (`https://` only); a page the helper
  serves never falls back to a window: a URL it refuses gets a notice and is not opened.

It needs non-interactive SSH from the Mac to the host (`BatchMode=yes`: a key in the agent/keychain, host key known).
State goes to the log (stderr): `tunnel connecting`, `tunnel up`, `bridge not answering through the tunnel`,
`tunnel down, restarting … retry_in=…`. `curl http://127.0.0.1:7777/healthz` shows the tunnel state and both versions (`version` is the helper's, `tunnel.bridge` the bridge's); the helper logs a warning when they differ. The game shows `game … · helper … · bridge …` above the backend line, in amber when they differ.

| flag | env | default |
|---|---|---|
| `--host` | `H3D_HELPER_HOST` | `dev@devbox` |
| `--remote-socket` | `H3D_HELPER_REMOTE_SOCKET` | `/run/user/1000/herdr-world/bridge.sock` (the bridge's default) |
| `--local-socket` | `H3D_HELPER_LOCAL_SOCKET` | `~/Library/Caches/h3d-helper/bridge.sock` |
| `--listen` | `H3D_HELPER_LISTEN` | `127.0.0.1:7777`; anything but a loopback IP is refused |
| `--bundle` | `H3D_HELPER_BUNDLE` | the game embedded in the binary; else `~/Library/Application Support/h3d-helper/dist` |
| `--token-file` | `H3D_HELPER_TOKEN_FILE` | `~/Library/Application Support/h3d-helper/token` (0600, created on first start) |
| `--music-dir` | `H3D_HELPER_MUSIC_DIR` | `~/Library/Caches/h3d-helper/music`: radio tracks served under `/music/` (`music/<genre>/<id>.ogg`); absent is fine, the radio is silent |
| `--print-url` | | print the game URL with the token and exit |
| `--dev-upstream` | `H3D_HELPER_DEV_UPSTREAM` | off; e.g. `http://127.0.0.1:5173` |
| `--no-open` | `H3D_HELPER_NO_OPEN` | `false` |
| `--chrome`, `--chrome-profile` | `H3D_HELPER_CHROME`, `H3D_HELPER_CHROME_PROFILE` | `Google Chrome`, `~/Library/Application Support/h3d-helper/chrome` |
| `--ssh` | `H3D_HELPER_SSH` | `ssh` on `PATH` |
| `--log-level`, `--log-format` | `H3D_HELPER_LOG_LEVEL`, `H3D_HELPER_LOG_FORMAT` | `info`, `text` (or `json`) |

Installing and updating are one command, `deploy/h3d-update`, from a GitHub release: see
[`docs/releasing.md`](docs/releasing.md) (first install, updating, rolling back, installing the game as a Dock app).
It installs the launchd agent's binary at `~/.local/bin/h3d-helper` and restarts the agent with
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
  `hire.prepare` 30 s, `worker.hire` 90 s, `worker.fire.prepare` 20 s, `worker.fire` 45 s; M6: `run.prepare` 30 s,
  `run.start` 90 s; a drop fails what is in flight) and the endpoint: same-origin `/ws?token=…` (the helper opens `/#token=<token>`; the game
  keeps it in `localStorage` as `h3d.token` and strips it from the URL), `?ws=<url>` to point elsewhere.
- M3d logos: `src/net/logo.ts` (the `/logo` URL beside the WebSocket URL, the browser-side pre-check, the upload and
  clear requests), `src/render/logos.ts` (the texture cache: one mipmapped, premultiplied texture per hash, fetched once
  via `createImageBitmap`, disposed when no building has it), `src/render/logoFit.ts` (the letterbox), `src/render/logoSign.ts`
  (a lit plate with the logo letterboxed on it, over the name board it hides) used by `lobby.ts` for the entrance sign and
  the reception wall, and the city's signs in `city.ts` (`setLogos`; one instanced draw for the plates, a quad a logo,
  lit while a floor runs, dim when all sleep; a sleep or wake rebuilds the city, signs included, as it always did, and the
  textures are not reloaded since they are cached by hash). `App.syncLogos` follows the buildings' `logo` hashes (`LogoSync`, which tells the `LogoCache` when a hash changes, also back to an earlier one, so a slow stale answer cannot hide the hash advertised now); a
  texture swap in the lobby, not a rebuild of it (the hash is not in the building's `shape` key), and only the city's signs
  are rebuilt for the city. A logo that cannot be fetched leaves the name.
  The Buildings panel has the control (`panels.ts` `logoRow`).
- `src/world` — the world store (snapshot + events, fallbacks for an older bridge without `name`, `desk_index`,
  `harness`, `model`, `effort`, `status_since`, `floor.desks`, and M3's `transition`, `settings`, `suggested`,
  `resume`, `hire_options`), the deterministic office layout for a desk count in its building's outline, the building
  around the floors (`building.ts`: storeys, the lobby, the fire escape, the street), M3c's corner office on its
  mezzanine (`FloorLayout.mezzanine`: posts, stair, glass, your desk, its walking supports and solids), height-aware walking collision
  and ray picking, the M4 walk-out route (`route.ts`), floor-settings validation and diffing (`settings.ts`),
  building/floor reordering (`arrange.ts`); M4: the hire / send-home dialogs' state (`hire.ts`: the preselected
  choice, capacity states, the base's age, which send-home options are enabled, the command
  args) and the arrivals' timeline (`arrival.ts`: the walk-out's heights come from its waypoints; M6b: a hire drops in
  to its chair in under a second instead of walking in, never `away`). M6b: what stands on each desk (`deskKit.ts`:
  the monitor, keyboard, mouse, the dock on the pod's outer side and its cables, the worker's photos, mug, plant and
  notebook, varied by the desk index; vitest keeps them on the desktop and clear of each other at every desk count). M5: the usage line and the floor total (`usage.ts`: `≈$0.09 · 37k tokens · ctx 4%`, only the known
  parts, a `*` for a cost priced as an unknown model, never a bare `$`), N's queue (`next.ts`: blocked before done, the
  building you are in first, oldest `status_since` first, and where to stand facing a worker), quick replies
  (`answer.ts`: digits → a question's choice; Approve = the choice that says Yes / Trust / Allow / Proceed, else the
  first; Deny = the "No" choice, else a cancel; #57: `ask.ts`, an agent's structured question: the picks per question,
when they answer everything, the `worker.answer_ask` args, a recorded answer's lines, "waiting 3m"), the Changes panel's model (`changes.ts`: the diff split per file and
  classified per line, file states, branch / upstream / base / stat lines, the truncation notice), who can be prompted
  (`prompt.ts`, the 16 KiB rule) and which laptops are live (`screens.ts`). M6: team presets (`presets.ts`: the
  world's `presets` and their events, by name; `known` false from an older bridge, which sends none) and the start-run
  dialog's state (`startRun.ts`: the one ticket input read as an issue number of the floor's repo, an issue URL or free
  text; the prompt preview's generated / custom states; what blocks Start or a preset's Save; the args of
  `run.prepare`, `run.start` and `preset.update`); write-code crews (`crew.ts`: the
  role from `role` or the label, a freelancer's lifecycle hired → onboarding → working → blocked / reporting from its
  status, report and whether it worked since first seen, verdict stamps, the ORCH's phase / pass and over-cap; an
  over-cap ORCH and a freelancer whose report asks count as needing you); M17: the time of day (`daylight.ts`: an
  instant, a zone and an optional latitude to daylight, the sun and the zone's clock; `timeOfDay.ts`: which time and
  zone, from the page's overrides, the settings and the browser; see "Day and night" below). Pure logic, covered by vitest.
- `src/render` — city dollhouse, office floor, instanced rigid-part workers / desks, speech-bubble cards, frame policy;
  M3b: the walk scene (`walk.ts`), the building and street from outside (`outside.ts`, baked into one mesh by
  `bake.ts`) and the lobby (`lobby.ts`). M3c: the corner office (`mezzanine.ts`: two merged vertex-coloured toon
  meshes, its glass merged into the office's window glass, one material). M4: `arrivals.ts` draws the walks (standing
  workers, the cardboard box with a mug, a plant and a photo, the closed laptop); the office shows a desk someone packs
  up at without its "+" (`OfficeView.setAway`); M6b: the box on the keyboard, the desk's own things lifted into it
  one by one, the laptop out of its dock; a hire's drop-in (`OfficeView.setDrop` moves only the figure; the landing
  shadow and the puff of dust are `arrivals.ts`'). M6b desks (`desks.ts`): a monitor with a status bar (the status's
  colour and word, from a small atlas), a keyboard, mouse, dock and cables (one merged mesh per dock side), the
  laptop standing closed in the dock with its harness's sticker (Claude Code's spark or Codex's prompt, one atlas,
  the model family's colour as its ring: `deskArt.ts`), the worker's things; instanced per part, only the desk, chair
  and monitor cast shadows. M6: the crew's looks (`crewLook.ts`: role wear, desk
  items, the ORCH's pass board, the brief, the report folder with its verdict stamp, sweat and a red alarm clock over
  the cap, a run-coloured badge; one InstancedMesh per part on the crowd, hidden while nobody wears it, none in the
  city), the card's role tag, stamp and crew lines (`cards/crewCard.ts`), and freelancers dropping in (M6b) and walking
  out with a briefcase, waving goodbye (`arrival.ts` `carry: 'briefcase'`); a freelancer's desk has no keepsakes.
  Cards and city badges are canvas atlases drawn as one instanced quad batch each (a cell per worker / floor, redrawn
  only when it changes). A DOM layer was benchmarked on the Mac and lost: moving DOM elements over the canvas cost
  2.6–4.3 ms of main thread per frame for 24 cards and ~8 ms for 30 city badges, against 0.5 ms for the atlas. The DOM
  keeps a static floor list for keyboards and screen readers. M5: a blocked worker's card is tall
  (`cards/layout.ts`: what its question is about, the question with the numbered choices as key caps; the looked-at
  worker's usage line): the nearest tall cards get one of 8 tall cells of a second small atlas, drawn as a second
  instanced batch (`cards/atlasCards.ts`; the per-desk atlas stays as it was; a tall card without a free cell shows
  compact with what its question is about and the question as the task line). The screens are `screens.ts` (below).
  M17: `daylook.ts` (the eased light and the colours and intensities it gives every scene) and `clock.ts` (the wall clock).
- `src/laptop` — M5 screens and sitting at a worker's screen (M6b: on its desk monitor): `watches.ts` keeps the connection's
  `terminal.watch`es in step with what the game wants (a full frame first, a gap re-watches, `unknown_command` turns
  screens off with the reason), `terminal.ts` is one xterm.js 6 terminal per live screen (never opened: only its VT
  parser and buffer) painted by `paint.ts` into a canvas that is the monitor's texture (M6b: standing, the glance view,
  the last lines that say something, 22 columns × 5 lines, big, bold and lifted to 4.5:1, so it reads from the aisle;
  seated, the whole terminal), `keys.ts` maps a keydown to herdr
  keys and orders input (one command in flight, what is typed meanwhile goes in the next `worker.keys`), `index.ts`
  plans and ties it together. #57: `askCard.ts` is the question card of the transcript view (the one pinned above the
  prompt box while the worker waits, and its timeline entry), styled in `transcript.css`. #59: `paint.ts` draws each
  glyph in its own cell (no ligatures, no fallback advance moving a column) in the preset's font and colours, box
  drawing / block elements / braille as shapes (`glyphs.ts`), and seated at the zoom (`viewport`: the letterbox below
  100%, above it the pane's bottom-left, moved to keep the cursor in view); `keys.ts` `zoomKey` is Ctrl + = / + / − / 0 and `LOOK_KEY` Ctrl+, (the keyboard to the terminal's preset and zoom). Which laptops are live is `src/world/screens.ts` (pure, vitest); the textured planes and
  the frozen-screen atlas (one instanced batch) are `src/render/screens.ts`; the seat bar is `src/ui/seat.ts`. Recorded
  screens for the simulator are `fixtures/screens/{agent,shell}.jsonl` (real `herdr terminal session observe` output of
  synthetic screens, made by `node tools/record-screens.ts` in a throwaway `h3d-m5screen-*` session); `sim=1` replays
  them for `terminal.watch` (`tools/fixture-screen.ts`: an agent's recording for a worker with an agent, the shell's
  otherwise, each from its own point, looping; at most `fps` frames a second, diffs in between concatenated),
  `worker.keys` echoes what was typed (the screen first jumps to the end of its recording), and watches close on
  `worker.removed`, a floor going to sleep or a new pane; `sim.watches` (the simulator's own, not a bridge command)
  answers this connection's watch count.
- `src/ui` — the HUD (DOM over the canvas) and the M3 panels (`panels.ts`: elevator, buildings, floor settings,
  confirmations; modal `<dialog>`s that re-render live and keep focus); M4: the hire dialog (`hire.ts`) and the
  send-home dialog (`sendHome.ts`), styled in `hire.css`; M6: the start-run dialog (`startRun.ts`, the empty desk's
  "Hire orchestrator" tab from `deskTabs.ts`, the top bar's Run and Presets from `startButtons.ts`) and the team presets
  panel (`presets.ts`), styled in `start.css`, and the prompt bar's crew line (`crewBar.ts`, `crew.css`); #59: the
  three presets (`themes.ts`: typed constants, the zoom's clamp / step / reset, Departure Mono's 11 px grid), what the
  seated views remember (`themePrefs.ts`: the transcript's and the terminal's preset and zoom apart,
  `h3d.theme.{transcript,terminal}`, `h3d.zoom.{transcript,terminal}`, and `h3d.transcript.hideTools`, guarded like
  `limitsPrefs.ts`; M17's `timePrefs.ts` too: the timezone and latitude of About's Day and night) and the loader (`themeLoader.ts`: the transcript's preset as custom properties on the root, fonts
  from `src/fonts/` on first pick, the terminal told once its preset's faces are in; defaults in `themes.css`); the
  seat bar holds the terminal's preset and zoom (`seat.ts`); the shipped fonts (`fontCredits.ts`: the credits panel's
  rows and each one's licence file, which the build writes in full into `FONT_LICENSES.txt` next to the bundle); M5: the prompt overlay (`prompt.ts`, P: a modal like the M4
  dialogs, low on the screen), the Changes panel (`changes.ts`, C: a non-modal side panel in the HUD under the top bar,
  so the floor stays in view and walkable; its diff is drawn a window of lines at a time), the look-at bar's usage and
  Approve / Deny (`promptBar.ts`), styled in `m5.css`, and the seat bar (`seat.ts`, `seat.css`). Hidden, named hooks
  wait for later tickets:
  `renderPlanLimits(harness)` (#12), `renderHandoff` (M9) and `renderServices` (#14), each returning null for now.
  `src/input` — first-person walking.
- `fixtures/` — recorded bridge streams (`herdr-world dump` format): `demo` (2 buildings, 3 floors, 40 workers; an M2
  bridge), `demo-m3` (the same city as an M3 bridge sends it: settings, suggestions, hire options, a floor in the
  unassigned lot; no events), `demo-m3b` (demo-m3 with all three floors in Work: herdr-3d on top, depot-manager asleep
  in the middle, pastry at the bottom), `demo-m4` (demo-m3b with linked git worktrees and branches on some workers of
  herdr-3d and pastry, and herdr-3d's docs worker in the repo's main checkout), `demo-m5` (demo-m4 with a `question`
  on each blocked worker, shaped like the bridge's captured screens: Claude Code's trust dialog with "No, exit" first,
  its AskUserQuestion menu and a Bash permission, a Codex approval, one without a menu; and `usage` on most agents, one
  priced as an unknown model, one with no model yet), `demo-m6` (demo-m5 with a `lab` floor on top of Work holding
  two write-code runs built from the synthetic run dirs in `fixtures/runs/` (see its README) the way the bridge reads
  them: the over-cap ORCH at pass 3 waiting for you with its pass-3 crew in its pod, REVIEW r3 `CHANGES_REQUIRED`
  with 2 blockers; and a run with every other freelancer state, each verdict and an `input_required`), `perf-floor60`, `perf-floor96` (96
  desks, every worker needs you: the corner office's worst case), `perf-city240`. `pnpm fixtures` regenerates them,
  `pnpm fixtures:check` flags stale files.
  Like the bridge, a building lists its floors top to bottom, which is `index` order (index 0 on top); vitest fails
  a fixture where the two disagree, since the simulator (`sim=1`) rebuilds the list from `index`.
- `tools/` — fixture server (read-only by default; with `sim=1` it simulates the bridge's commands in memory,
  `fixture-sim.ts`, M4's four included: a cwd is a git repo unless it has `/scratch` in it, `offline` in it fails every
  fetch (prepare reports it, a worktree hire is refused with `fetch_failed`); a `working` worker has uncommitted changes and 2 unpushed commits, a `blocked` one 1 unpushed commit; caps
  24 / 32 per floor and 60 / 80 for the host unless `simcap` says otherwise; hires are acked one step later with the
  worker arriving, a first task sets it working the step after; branches are `h3d/<name>-<id6>`; `delete_branch` only for
  a branch the simulator made or a fixture `h3d/…` one, like the bridge's recorded branches; M5: the laptops in
  `fixture-screen.ts` (see `src/laptop`), the rest in `fixture-panels.ts`, whose rules are at its top: a prompt starts
  an idle agent working a step later and done three steps after, a working one queues it, a blocked one refuses it
  (`invalid_state`: answer first); an answer needs the question's hash (else `stale`, after an upsert with the current
  question), and trusting a folder leaves the agent idle; `worker.changes` has staged / unstaged / untracked /
  committed files for a `working` worker, a 1.6 MiB diff cut at 256 KiB for a `perf…` label, `not_a_repo` under
  `/scratch`; working agents send `worker.usage` every `simusage` ms); M6: `fixture-start.ts`, whose rules are at its
  top: "Build team" is seeded, presets are validated like the bridge's, `run.prepare` composes the prompt exactly like
  its prompt builder, `run.start` is the M4 hire (the ORCH gets `role: orch` and its `run` from the label, the floor its
  `last_preset`), and `simfail=no_m6` plays an M5 bridge (no `presets`, every M6 command `unknown_command`); `fixture-crew.ts`, a scripted freelancer:
  `sim.crew {step: hire|onboard|work|report|leave}` (the simulator's own, like `sim.watches`) seats a `CODE`
  freelancer of an ORCH's run at the free desk nearest it, gives it an agent, sets it working, hands in its report
  (`verdict` / `blockers` / `input_required` / `summary`) and closes it; `simcrew=<ms>` plays that round by itself), dev WebSocket → unix-socket proxy,
  throwaway-herdr helper, live (`live-*.ts`) and Mac perf drivers.

Run it:

```sh
make dev   # then open http://127.0.0.1:<port>/?ws=/fixture/demo   (Vite serves fixtures at /fixture/<name>)
           # M3 panels without a bridge: ?ws=%2Ffixture%2Fdemo-m3%3Fsim%3D1   (the ws value URL-encoded)
           # M4 hire / send home: ?ws=%2Ffixture%2Fdemo-m4%3Fsim%3D1%26simcap%3Dscratchpad%3A3%3A4
           # M6 crews: ?ws=%2Ffixture%2Fdemo-m6%3Fsim%3D1%26simcrew%3D4000&floor=lab
pnpm -C game fixture-server   # standalone fixture server on a leased port: ?ws=ws://127.0.0.1:<port>/ws
pnpm -C game fixture-server --simulate --fixture demo-m3   # the same, answering commands on every connection
# against a private bridge: node game/tools/ws-unix-proxy.ts --port <leased> --socket <bridge.sock>, then ?ws=ws://127.0.0.1:<leased>/ws
```

| query param | effect |
|---|---|
| `ws=<url or path>` | bridge endpoint (default same-origin `/ws`); fixtures take `?play=none\|all\|<ms>`, and `sim=1` to simulate commands (`simms=<ms>` between wake/sleep and hire/send-home steps, default 600; `simfail=wake_failed\|sleep_failed\|hire_failed\|fire_failed` fails the next one, `simfail=fetch_failed` makes origin unreachable for the whole run; `simcap=<session>:<soft>:<hard>[,…]` caps floors; #51: `simmodels=<n>` adds n Claude models to the hire options (a long model list); M6: `simcrew=<ms>` walks a scripted freelancer in and out; M3d (`tools/fixture-logo.ts`, `tools/logo-art.ts` draws the made-up test logo; no third-party logo ships): `simlogo=<key>` lets `/logo/<building>?simlogo=<key>` reach this connection's world, `simlogos=1` starts every building with a made-up logo, `simfail=logo_missing` makes the images 404, `simfail=logo_busy` fails the next upload) |
| `backend=webgl2` | force WebGL2 |
| `screens=<n>` | M5: how many laptops around you are live (default 4, at most 5; `0` watches none: only the laptop you sit at is watched) |
| `floor=<session>`, `plan=1` | enter a floor on load, open its floor plan |
| `ts` | GPU timestamp queries (for `bench`) |
| `shadows=0`, `badges=0`, `battery=1` | no shadows; no city badges (perf comparisons); start in battery saver |
| `me=<name>` | M3c: the name on your desk's name plate and the office glass (default "You": the bridge sends no user name yet) |
| `time=HH:MM`, `time=YYYY-MM-DDTHH:MM` | M17: pins the time of day (the clock time in the effective zone, today's date there unless given): the clock shows it, the light does not move, and it starts there (no easing). Invalid: ignored, with a console warning |
| `tz=<IANA zone>` | M17: the timezone for this page load, over the About setting and the browser's (`Europe/Brussels`, `UTC`, an alias like `Europe/Kiev`; a numeric offset is refused) |
| `lat=<degrees>` | M17: the latitude for this page load (−90…90), over the About setting: sunrise and sunset from the season; without one, the fixed dawn and dusk |

#51 prompt composer (`src/ui/composer/`, `src/net/upload.ts`): a `contenteditable` with image chips, shared by every prompt. `model.ts`
(document, serialiser: pure), `draft.ts` (the draft object a host keeps: history, images, upload queue, `resolve()`), `composer.ts`
(the view, `mountComposer`), `lightbox.ts` (the enlarged view), `tree.ts` (DOM ↔ offsets). Decisions: `docs/decisions.md`
(2026-09-30). A host mounts it with a `Draft` (or a `wsUrl`), asks `resolve()` for the final text on `onSubmit`, and keeps
the draft object to keep the prompt across a closed dialog. The fixture server answers `POST /upload` (`tools/fixture-upload.ts`:
a fake `/home/fixture/drops/2026-09/h3d-<label>-<n>.<ext>` path; `fail_upload=<N|all>&upload_key=<key>` in the `ws` query fails
the first N uploads of that key; `GET /upload/_log?upload_key=<key>` lists what it received). `/?composer-demo&ws=…` mounts the
composer in a test-only dialog with no game (`src/ui/composer/demo.ts`, loaded only on that parameter) for `e2e/composer.spec.ts`;
`H3D_EVIDENCE_DIR` sends its screenshots elsewhere than `test-results/composer`. The hire dialog mounts the composer for its first
task (`TaskEditor` in `src/ui/hire.ts`, `#hire-task` is the editable element): one `Draft` per desk in memory, the text mirrored
to `localStorage`, Hire waits for `draft.resolve()` before it sends `worker.hire`; `e2e/hire-composer.spec.ts` drives it (paste,
enlarged view, forced upload failure and retry, two markers in document order) on the simulating fixture server.
#64: every other field that prompts an agent mounts the same composer (paste a screenshot: a chip, the agent gets
`[Image #n: <path>]`; `field.ts` has what the fields share: `markedText`, the failure wording, `filesOf`, the hint).
The P overlay (`ui/prompt.ts`, `#prompt-text`, a `Draft` per worker), Start Run's Extra instructions and First prompt
(`ui/startRun.ts`, `#run-extra` and `#run-prompt`: two composers; the generated prompt is put into the second with
`Draft.replaceAll`, turning the markers of Extra's uploaded images into chips; the Ticket stays text), the transcript
view's prompt box (`laptop/transcriptRender.ts`, `.tx-input`, styled with `--tx-*` and `em` in `transcript.css`) and a
paste at a laptop's terminal (`ui/seat.ts` reads the clipboard's files, `laptop/pasteImages.ts` uploads through a `Draft`
and queues one `worker.prompt` of markers; a plain shell is told it cannot take an image). A field sends only when every
image is up (it waits for one that is uploading) and not at all when one failed or when a file it refused is still held (`Draft` option `holdRefused`: the refusal shows under the field with a dismiss button and only the user's dismissal lifts it; the hire dialog does not opt in). Start Run's First prompt is read-only while its generated text carries a bare `[Image #n]` of Extra (`previewLocked`). `e2e/prompt-images.spec.ts` drives all of
them (chips, markers sent, failed / pending / refused images, the desk drafts, the terminal and the plain shell); the
fixture's upload adds `fail_code=upload_busy` (the failures are the bridge's `429`) and `upload_delay=<ms>` (a pending
upload to look at).

M5 on the simulating server (`ws=…?sim=1…`): `simusage=<ms>` sends working agents' `worker.usage` that often
(default 5000, 0: never); `simfail=prompt_failed|prompt_retried|answer_unresolved|changes_failed` for the next prompt,
answer or changes, `simfail=input_failed` fails the next `worker.keys`, `simfail=observer_failed` closes the next watch
after its first frame. E.g. `?ws=%2Ffixture%2Fdemo-m5%3Fsim%3D1%26simms%3D300%26simusage%3D2000`.

M10 on the simulating server: the plan limits widget on any fixture. `simlimits=ok|hot|reached|old|transcript|noplan|none|model|off` picks
the readings (`tools/fixture-limits.ts` has the rules: `hot` is red, `reached` pulses, `old` and `transcript` are dimmed
with an "as of" time, `model` has a per-model week at 96 %, `none` is `limits: []` and says "reading…", `off` is
`--no-limits`), `limits.refresh` answers `{queued}` and sends fresh readings, `simfail=no_m10` plays a bridge
without limits (no widget). E.g. `?ws=%2Ffixture%2Fdemo-m4%3Fsim%3D1%26simlimits%3Dhot`. The widget: click it or press
Shift+L (plain L is the elevator) for the panel (it never grows past the viewport: the providers scroll, Refresh and Hide
stay); it is switched off in About, or with the panel's Hide. On a viewport under 760 px wide it steps out of an open
dialog or the Changes panel and comes back, panel as it was, when they close. Over a screen-filling dialog (`dialog.panel`,
the Issues / Pull requests boards and their item modal) it steps out at any width: a slim edge tab (worst percentage and a
severity bar) in the gutter right of the dialog, or, when the viewport leaves under 48 px there, away completely (the hire
dialog, a near-full-screen sheet since #51, is one of them: its own limits line is inline). A click on
the tab or Shift+L then *peeks* the expanded panel above the dialog without touching the saved state (Shift+L again, the
plate's header, a click elsewhere or closing the dialog ends the peek; a meter hidden from About stays hidden); when the
dialog closes the plate is exactly as it was. The small centred dialogs (confirm, start-run, send-home, …) keep the
plate as it was, above them. The Changes panel still makes it step left.

M6 on the simulating server: presets and runs on any fixture (herdr-3d of demo-m4 has a suggested repo, pastry none);
`simfail=no_m6` plays a bridge without them. E.g. `?ws=%2Ffixture%2Fdemo-m4%3Fsim%3D1%26simms%3D300`.

M7 on the simulating server (`tools/fixture-boards.ts`, rules at its top): the boards of the floor you are on, from its
effective repo (`settings.repo ?? suggested.repo`; none: `board.watch` answers `enabled: false`). `JeffreyVdb/lab` and
`JeffreyVdb/herdr-3d` have a project (Todo / Doing / QA / Done), `JeffreyVdb/bench` (the `perf-boards` fixture) 100 issues
and 20 pull requests, any other repo no project (Open / Closed, no `set_status`). lab issue #7 has a markdown body full of
script, handlers, `javascript:` links, svg, an iframe, a form and a tracking pixel: the sanitiser's fixture. Writes queue a
poll of the floor, as the bridge does. `sim.boards` (the simulator's own command, `simBoards(args)` in the hooks) merges a
PR (`{merge: id}`: gone from the open list, announced by the next poll, its issues closed and in Done), makes the next polls
fail (`{fail: "message"}`, or `head_moved` to make a merge answer `stale`; `{fail: null}` clears it), sets the rate limit
(`{rate: {remaining, reset_at}}`) or the paging flag (`{truncated: true}`), moves a card (`{card: {id, column}}`) or polls
(`{poll: true}`). `simfail=no_m7` plays a bridge before M7 (every board command `unknown_command`). `open=none` in the page
URL makes "Open in …" record the page instead of opening a window. E.g.
`?ws=%2Ffixture%2Fdemo-m6%3Fsim%3D1%26simms%3D150&floor=lab`.

#57 on the simulating server (`tools/fixture-ask.ts`, rules at its top): `sim.ask {id, ask}` (`simAsk(args)` in the
hooks) makes a worker's agent ask (its card and the transcript's pending call), `{id, ask: null, answers?}` ends it as
the terminal would; `worker.answer_ask` answers it like the bridge (`stale`, `bad_request`, the ask gone and the call's
card answered before the ack); `simfail=answer_ask_failed` / `answer_unresolved`. `e2e/m16-ask.spec.ts` drives it.

M16 on the simulating server (`tools/fixture-transcript.ts`, rules at its top): sit at any worker and press Ctrl+Esc
for its conversation. `transcript.watch` answers a demo timeline of every item kind in the bridge's shape, the demo's
Agent call pages the bridge's own output for its subagent fixture, and `sim.transcript` (`simTranscript(args)` in the
hooks) pushes items or updates to a watch (`{id, items, updates}`) or closes it (`{id, close: "session_changed"}`);
`simfail=no_m16` plays a bridge before M16. The demo's `Read` of a PNG shows its two thumbnails under its collapsed header, and still does with Hide tools on (#70). #59: the view's top strip has the transcript's preset (three swatches:
Terminal, Quiet, Paper), Hide tools and A− / 100% / A+; the seat bar has the terminal's own preset and zoom. Ctrl + = /
− / 0 and Ctrl+wheel zoom the view that is up, while seated only; Ctrl+, puts the keyboard on the terminal's controls (Esc goes back). `e2e/m59-themes.spec.ts` drives them. The game's tests read what the bridge makes of its own fixtures from
`game/fixtures/transcript/` (`H3D_UPDATE_FIXTURES=1 go test ./internal/transcript` writes them, and the Go test fails
when they are stale). E.g. `?ws=%2Ffixture%2Fdemo-m5%3Fsim%3D1&floor=herdr-3d`.
#58: the view says what the agent is doing and shows a prompt at once (`laptop/transcriptActivity.ts`, pure: the rules
from `docs/research/transcript-activity.md`). While the worker is `working` the timeline ends in a flashing
"Thinking…" (or "Working…" when the current turn's last item is assistant text) with the time since `status_since`;
a running tool or subagent in the turn speaks for itself (its row ticks), and there is nothing while idle, done,
blocked or under a question card. The turn starts after a watermark: the timeline's top when the status became
`working` (not coming back from `blocked`) or when you sent to a worker not at work; sat down at one already working,
the last item is taken as it is. The flash is one element animating opacity only (`tx-pulse`, CSS, compositor), in the
DOM only while it shows (not in terminal mode or the images tab, not with the overlay off the view), paused in a hidden
tab, still under `prefers-reduced-motion`; its time is a sibling span on the view's 1 s ticker, and a polite live
region announces state changes only. A sent prompt is a dimmed user row at once (`Sending…` → `Sent` / `Queued ·
<name> takes it when it can` / `Not sent: <reason>` with Dismiss, the text staying in the box); the first new `user`
item after it with its text (trimmed, CR/CRLF as LF, image markers apart; identical ones in order) replaces it, and
an item takes one prompt only however often a resync sends it again. Another session while seated (`/new`, `/clear`:
`session_changed`, its `seq`s from 1 again) starts that over: a prompt still waiting may be anywhere in it, and the
turn's watermark is dropped (the last item is taken as it is). Not
seen 15 s after the ack (`SENT_TIMEOUT_MS`; a queued one: 15 s after the turn it waited for ends) it says "not seen in
the transcript yet" and still waits. Your own send scrolls to the bottom and follows. On the simulator `simecho=<ms>`
writes a prompt's user item to the watch that long after the agent took it (a queued one mid-turn, as both CLIs do);
without it prompts never show. `e2e/m16-transcript-activity.spec.ts` drives it (`getAnimations()`: one running
animation, opacity only, none in terminal mode or once idle); `e2e/m58-activity-perf.spec.ts` (opt-in, `H3D_PERF=1`,
~4 min) traces 60 s idle / cue / idle for paints, layouts, long tasks, thread time and the label layer's paint count.

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
bridge first (`hire.prepare`), then offers: an optional first task (**Enter** hires, **Shift+Enter** adds a line; paste a screenshot and it goes into the text as a
thumbnail at the caret, click it to see it enlarged (**Esc** closes only that), the agent gets `[Image #n: <path>]` in its place (#64: the same in
Start Run's Extra instructions and First prompt, the P overlay and the transcript view's prompt box, and a screenshot pasted at an agent's laptop;
a prompt is sent once its images are uploaded, and not at all when one failed);
the dialog is a near-full-screen sheet, #51: the task editor takes the space and grows with the window, the options
sit beside it, or under it on a phone, and Hire / Cancel stay on screen; what you typed for a desk stays until a hire
is acknowledged),
harness → model → effort as chips (Tab into a group, ← → pick; the floor's default hire or the last hire on the floor
is preselected and marked so), the label (the next generated name), the folder (the floor's default; changing it
checks the new folder again), **Work in its own git worktree & branch** (on by default, only when the folder is a git
repo) with the base `origin/<default> @ <sha>, <age>`, and the floor's and host's caps with the host load: a warning
above the soft cap, Hire refused at the hard cap. When `git fetch origin` failed the worktree option is off (a worktree
never branches from a stale origin; the bridge would refuse it with `fetch_failed`), the error sits above the buttons
with **Fetch again**, and hiring without a worktree still works. Warnings sit by the buttons, so they are in view
without scrolling. Hire hides the desk's "+" at once (each hire in flight holds its own desk, so Esc and another hire
meanwhile is fine: the top bar skips desks a hire is on its way to); the new
worker drops in to its chair from above (under a second, M6b); its desk is its own at once, so you can look at it, sit
at its screen and prompt it while it lands. Look at a worker and press **X** to send it home: its branch and folder, what is left on the desk (uncommitted
changes, commits not on any remote) and, for a worker in a linked worktree of its own, keep / delete the worktree /
delete the worktree and branch (delete only when the bridge says the tree is clean and pushed, else a warning says
why; the branch too only when the bridge made it for this worker, `can_delete_branch`); a main checkout whose worktrees are still open cannot go yet. Focus starts on "keep", where Enter sends it home;
with a delete picked only the button confirms. The worker packs a cardboard box, takes the laptop, walks out down the
fire escape and away along the sidewalk, and the desk gets its "+" back. Walk-outs play for floors of the building you
are in (the interior only for the floor you are on), a drop-in only on the floor you are on; anywhere else they
resolve at once. Esc closes either dialog, and
the pointer lock is released while one is open. Dialogs never close by accident (#51): the ones that hold typed text or
a consequential choice (hire, start-run, presets, the P prompt, open-PR, the panels, send home, the board item) have no
backdrop dismissal, only their close button and Esc; the read-only sheets (About, credits, the HUD sheet, the boards)
close on the backdrop only when the press and the click both began there (`ui/dismiss.ts`; table in docs/decisions.md).

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

Screens (M5; M6b: on the desk monitors): the four nearest monitors you can see (and whose screens face you) show their
worker's terminal live, at 4 fps, in the glance view (the last lines, big enough to read from the aisle) under the
status bar; a monitor keeps its last frame when it stops being live (frozen), or its status glow if it never was;
asleep, they are dark. A nearer one takes over only from one out of view or clearly farther, one at a time, so walking
does not flicker. The worker's laptop stands closed in its dock, its sticker showing its harness. Look at a worker and
press **E** to sit at its screen: the worker steps aside, the camera glides in and the whole terminal fills the view,
at 10 fps. Everything you type goes to its terminal (letters, Enter, Tab and Shift+Tab, arrows,
Home / End / Page keys, F1–F12, Backspace, Delete, Ctrl+letter; the game's own keys too), **Cmd+V** (Ctrl+V off a Mac)
pastes (as a prompt to an agent, typed into a plain shell; a screenshot goes to an agent as `[Image #n: <path>]` markers once uploaded, a plain shell says it cannot take one and types nothing), **Shift+Esc** sends Esc, **Esc** (or the seat bar's Stand
up) gets you up; so do the elevator, another floor, a panel, the plan or a teleport, and the worker leaving or its floor
going to sleep (a toast says why). Typing that fails shows in the seat bar. Getting up drops nothing you typed: what is
still on its way (behind a slow paste, say) goes on, in order, and a failure then is a toast. E is disabled, with the reason, on an asleep
floor, for a worker without a pane, and against a bridge without `terminal.watch`.

Prompts, changes and quick replies (M5): look at a worker and press **P** to prompt it: the overlay sits low so the
worker stays in view; **Enter** sends, **Shift+Enter** adds a line, **Esc** closes (an unsent draft is kept per
worker, pasted screenshots included: **paste a screenshot to add it**, it sits in the note as a chip). It shows Sending, then Sent (or Queued: a working worker's agent takes it on its next turn, and a "Will queue"
chip says so before you send), or why it failed, with the text kept; the header's status tape follows the worker live.
P is off, with the reason on the key, for a plain shell, a worker waiting on a question (answer it first: the bridge
refuses a prompt then), an asleep floor, or a bridge without `worker.prompt`. **C** opens the worker's Changes panel on
the right (C again, or Esc, closes it): branch, upstream with ahead / behind, the base, `N files changed · +a −d`, the
files (staged, unstaged, untracked, committed; +/−) and the selected file's diff; ↑ ↓ Home End pick a file, Enter or →
reads its diff, ← goes back to the list, **R** refreshes; keys typed in it never reach the game, and the scene stays
walkable. A blocked worker's card shows what its question is about (the command, file or folder above the menu on
its screen, as terminal text), the question and its numbered choices; looking at it, **1**–**9** answer with that
choice and **0** denies (Esc on its screen); the look-at bar leads with Approve (the choice that says Yes / Trust /
Allow / Proceed, else the first: Claude's trust dialog lists "No, exit" first) and Deny (the menu's "No" choice, else
0); a stale question says what it is now. **N** goes to the next worker who needs you (blocked, oldest first, then
done), in your building first, cycling on repeated N: on the floor you are on it puts you facing the worker; for
another floor it opens the elevator with that floor picked (Enter rides there, and you arrive facing it). The look-at
line and the looked-at worker's card show its usage (`≈$0.09 · 37k tokens · ctx 4%`; `≈$1.50*` with a tooltip when
priced as an unknown model), the top bar the floor's `≈$` total and "N need you".

Starting a run (M6): on an empty desk's hire dialog (E on its "+") the **Hire orchestrator** tab (Shift+Tab to the
tabs, ← →), or the top bar's **Run** on an office floor (the first free desk; the Desk field changes it), opens the
start-run dialog: one **Ticket** input (`7` or `#7` is an issue of the floor's linked repo, an issue URL carries its
own, anything else is free text; the read-back under it says which), the desk, the **team preset** (the floor's last
one, else "Build team"), the orchestrator's harness → model → effort (the preset's, until you pick one), extra
instructions, the label, the worktree (on by default) and the **first prompt**. The prompt comes from the bridge
(`run.prepare`) a moment after every change; typing in it makes it yours ("Edited"): later changes never overwrite it
and a note says when the fields now make a different one, **Reset to generated** takes theirs again, and Start sends
yours as `run.start`'s `prompt` (a generated one is left to the bridge). **Ctrl+Enter** (⌘+Enter) starts from anywhere
in the dialog, plain Enter never does; Esc closes and focus goes back. #64: **paste a screenshot** into the extra
instructions or the first prompt and it is a chip; the generated first prompt then carries `[Image #n: <path>]` and shows
the chip too, Start waits for an image that is still uploading and does not start when one failed (the ticket takes
text only). Capacity and a failed fetch show as in the hire
dialog. The orchestrator drops in like a hire and you are turned to face its desk. **Presets** (in the dialog, and in
the city's top bar) lists the team presets: create, edit (the name and the five roles × harness / model / effort) and
delete (confirmed); a taken name or a bad choice is said by the field. Esc in the editor goes back to the list. An
older bridge (no `presets` in its world, or `unknown_command`) leaves Run, the tab and the presets off with the reason.
Below 1440 px wide the top bar's Hire and Run show only their icons (their words stay for screen readers and in the
tooltip), so the floor's name and the counts keep their room.

Day and night (M17): the game follows the viewer's local time. `src/world/daylight.ts` is pure (no DOM, no three):
an instant, a zone and an optional latitude give `daylight` 0…1, the sun's `elevation` / `azimuth`, `warmth` (dawn's
and dusk's tint) and the zone's clock (`civilAt`, from `Intl` parts). With a latitude, the sun's altitude comes from the
latitude, the declination of the day of the year and the hour angle, with solar noon at 12:00 local *standard* time
(13:00 on a summer clock; no longitude), and daylight ramps from −6° to +7°, so the day's length follows the season and
a polar day or night clamps; without one, the fixed curve: dawn 06:30–08:00, dusk 18:30–20:00 clock time.
`src/world/timeOfDay.ts` decides the time and the zone: `?time=` / `?tz=` / `?lat=` over the About settings
(`src/ui/timePrefs.ts`: `h3d.time.zone`, `h3d.time.lat`, guarded like `limitsPrefs.ts`, invalid input refused and not
stored) over the browser's zone. `App` reads it just past every minute, at once when a setting changes or the tab comes
back, and `render/daylook.ts` eases the light towards it over about three seconds (a first load or a pinned time starts
there). The scenes only move colours and intensities of lights they built once: the walk scene's sky, fog, hemisphere
and sun (composed with an asleep floor's dim: darker at every hour), the city's, the baked street's material colour (the
lamp globes, the neighbours' lit windows and the lobby's room are meshes of their own; the panes turn warm at night on a
running floor through their own node material), the lamps' pools of light, and the office's two non-shadow spot lamps
(`LAMPS` in `render/office.ts`, off on an asleep floor) and window glass. The wall clock (`clock` prop on the board
partition's desk side, `render/clock.ts`): HH:MM and `Wed 30 Sep` in the effective zone, backlit, drawn when that
changes. It is a look-only prop (`milestone: null`): the bar says what it shows and has no key. Settings: About →
Day and night (timezone, latitude; empty is the default, applied live).

The lounge radio (M15): on the coffee counter in the north-west corner (a `radio` prop). Look at it: the bar reads
"Radio: Melodic house · E next genre · R next track". **E** goes Off → Melodic house → Soft jazz → Rock → Pop → Rap → Off
(Off stops it), **R** skips the track; a toast names each new track (title · artist, about 3 s). The genre is the player's,
one for every floor, saved with the sound settings (first run: Melodic house, music volume 0.4). It plays only on the floor
itself: it fades out in 0.5 s in the lobby, on the street, on the fire escape and in the city, and back in with the same
track. The sound control in the top bar keeps its master mute and slider (everything), and gets a Music button: its popover has
the radio's own mute and volume and a button for the **Music credits** panel.

Tests:

```sh
make test lint                # vitest + tsc (protocol client and requests, store, layout, collision, cards, frame
                              # policy, fixtures, settings validation/diffing, reordering, the command simulation)
make shot                     # Playwright WebGL2, just the screenshot: game/test-results/shot.png
make e2e                      # the whole Playwright suite, WebGL2 (H3D_WORKERS parallel, ~7.5 min, one per host):
                              # game/test-results/{shot,m2-city,m2-floor-plan,m2-desk-row}.png,
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
                              # chips, Tab order), hire → the drop-in (M6b) → seated at that desk;
                              # the last choice preselected next time; X on a dirty worker (delete off, the
                              # warning), a clean one sent home with worktree + branch deleted (packing, the box,
                              # the laptop, down the stairs, the "+" back); the top bar's Hire (first free desk);
                              # a worker without a worktree, a blocked main checkout; capacity warn / refuse at
                              # 1024×640; two hires at once (Esc on a pending one), each on its own desk; a failed
                              # fetch at 1024×640 (worktree off, Fetch again, a plain hire); a clean worktree on
                              # the user's own branch (delete the worktree only); walks you cannot see; a
                              # read-only bridge; m4-{hire-dialog,send-home-dirty,send-home-clean,
                              # walk-out-pack,walk-out,hire-capacity-warn,hire-capacity-full,
                              # hire-fetch-failed}.png; M6 on demo-m4 with sim=1 (m6-start.spec.ts): the
                              # Hire orchestrator tab from the keyboard, an issue number, Ctrl+Enter, the drop-in
                              # and facing the orchestrator; the top bar's Run (first free desk, another desk),
                              # free text, extra instructions, Esc giving focus back, a floor without a repo; an
                              # edited prompt through field changes, reset, sent; presets create / edit / delete
                              # (name taken, live in the dialog, focus back); simfail=no_m6: m6-{start-run-issue,
                              # start-run-edited,presets-list,presets-edit}.png
                              # M5 laptops on demo-m4 with sim=1 (m5-screen.spec.ts): the nearest four laptops in
                              # view live and the rest glowing, screens=0 watching nothing, walking along a pod with
                              # screens=2 (screens swap one at a time, the passed ones frozen, no churn looking left
                              # and right) and a reconnect watching again; E at a plain shell's laptop, typing that
                              # echoes on its screen (checked in the xterm buffer), the game's keys (W, L, B, X, Tab,
                              # Shift+Tab, Backspace) going to the terminal instead, Shift+Esc, a paste, Esc back to
                              # the same pose; a paste into an agent's laptop as worker.prompt (#64: an image as its
                              # marker, a plain shell told it cannot take one: e2e/prompt-images.spec.ts), a failed key
                              # (simfail=input_failed) in the seat bar, the worker leaving; 20 sit / stand cycles with
                              # no watch left in the simulator; an older bridge and an asleep floor (E disabled and
                              # why); m5-screen-{live,seated,frozen}.png. M5 panels on demo-m5 with sim=1
                              # (m5-panels.spec.ts): P to an idle worker (sent, working, done on screen) and to a
                              # working one (queued, the chip back for the next one), a draft kept, the plain-shell /
                              # asleep / failed-prompt reasons; a bridge without the M5 commands; 1 / 2 / 3 / 0 on a
                              # Claude permission, Claude's trust dialog (Approve is its choice 2), a Codex approval
                              # and a question without a menu, and a stale hash; the Changes panel from the keyboard
                              # (staged / unstaged / untracked / committed, the diff, refresh keeps the file) and on a
                              # cut 256 KiB diff (the notice, a window of lines, not_a_repo); N across floors through
                              # the elevator and from the city; usage on the bar, the card and the top bar, flagged,
                              # updated by worker.usage; m5-{prompt,prompt-queued,changes,changes-truncated,
                              # quick-reply,usage,next-elevator}.png. M6b on demo-m4 with sim=1 (m6b.spec.ts): a
                              # hire at an empty desk drops in and you sit at its screen while it lands, within a
                              # second of the hire; the live screens on the desk monitors (in the glance view, over
                              # the terminal area) and every docked laptop's sticker its worker's harness, an empty
                              # desk's furniture; at 1512×945 @2x, the Mac's pixels: m6b-{row,desk,stickers,
                              # empty-desk,drop-in,drop-land}.png
                              # M15 radio on demo-m3b (m15-radio.spec.ts, generated tone clips instead of the real
                              # tracks): look-at bar, E through Off / genres, R, the now-playing toast, fade in
                              # the lobby and back, a missing file, the music popover (slider / mute), the Music credits panel;
                              # m15-{radio,radio-hint,radio-toast,audio-controls,credits}.png
                              # M17 day and night on demo-m3b (m17-daynight.spec.ts): ?time= noon and 23:00 (the
                              # city, a running floor, the clock and its bar, the street), an asleep floor darker
                              # than a running one by day and at night (canvas luma), ?lat= in June and December,
                              # the real clock (page.clock + timezoneId): the date over midnight without a reload,
                              # the light easing up, ?tz=, the About fields (refusals, live); m17-{day,night}-
                              # {city,floor,clock,street}.png, m17-about-time.png. m17-perf.spec.ts: perf-floor60
                              # at night against noon (H3D_M17_RUNS=<n> pairs, H3D_DIST=<build> for a baseline)
                              # #59 transcript presets on demo-m5 with sim=1 (m59-themes.spec.ts): the font files a
                              # fresh load fetches (Quiet's only; a stored preset's only), each transcript preset
                              # from its strip (computed fonts: mono vs prose; the limits widget; a box in tool
                              # output lined up) and the terminal's from the seat bar, apart (the terminal in Paper
                              # fetches no Newsreader), Hide tools and its chip, blocked storage, each view's zoom
                              # (keys, buttons, the prompt box, 200 % and 70 % laid out, Ctrl+wheel on the terminal,
                              # Departure Mono on 11 / 22 px), keyboard reach; m59-{transcript,terminal}-<preset>,
                              # m59-transcript-<preset>-hidden, m59-mixed-{transcript,terminal} (Paper over
                              # Terminal), m59-zoom-{200,70}, m59-terminal-zoom-200.png
                              # M7 on demo-m6 with sim=1 (m7-boards.spec.ts, m7-actions.spec.ts, m7-perf.spec.ts): the
                              # corkboard and PR board (columns, paper, pins, holders, CI, verdict stamps), E and the
                              # top bar opening the overlays, no-project / no-repo / older-bridge floors, the watch
                              # (one floor, again after a reconnect), diff animations, the sanitised markdown, Hand to
                              # a worker and the peel-off, Ask, Close, Move, comment, Merge and its double confirmation,
                              # the gong, Open PR for a plain worker, 100 issues + 20 PRs; m7-*.png
                              # M3d logos on demo-m3 with sim=1 and a world key (m3d-logos.spec.ts, m3d-perf.spec.ts):
                              # choosing e2e/fixtures/test-logo.png in the Buildings panel (from the keyboard) puts it on
                              # the entrance sign, the reception wall and the city; Clear brings the names back; a city
                              # sign lit while a floor runs and dim when all sleep; a missing image leaves the name
                              # and a reconnect tries again; type / size / busy refusals in the panel; perf-city240 with
                              # a logo on all five towers, in the city and in a lobby, against none; m3d-*.png.
                              # `H3D_DOC_SHOTS=1` also writes the PR screenshots to docs/img/m3d-logos/
pnpm -C game test:live        # opt-in: status latency against a throwaway herdr session (see below)
pnpm -C game test:live:m3     # opt-in: buildings across a bridge restart, sleep/wake at the same desks (see below)
pnpm -C game test:live:m5     # opt-in: the M5 laptops and panels against a real bridge and Claude (see below)
pnpm -C game perf:mac         # opt-in: Metal/WebGPU perf + screenshots on the Mac -> game/test-results/perf/
```

`test:live` builds `bin/herdr-world` from the worktree (or runs `H3D_LIVE_BRIDGE=<path>`, e.g. another branch's
bridge built elsewhere), starts `herdr --session h3d-m2game-<random> server` (with
`HERDR_*`/`CLAUDE*` stripped), a private bridge on `$XDG_RUNTIME_DIR/h3d-m2game/<run>/bridge.sock` (db
`/tmp/h3d-m2game/<run>/world.db`; every live check keeps its socket and db in a directory of its run's own, and removes
only that) watching only that session,
and the WebSocket → unix-socket proxy on a leased 127.0.0.1 port. The spec flips a custom agent's state with
`herdr pane report-agent` and asserts each change is on screen within 1 s. It accepts an M1 bridge (name falls back
to the label, desk to the lowest free local slot) and the M2 bridge (its own `name` and `desk_index`). The session is stopped and deleted
afterwards; after a hard kill, check `herdr session list` for a leftover `h3d-m2game-*` session.

`test:live:m3` builds the bridge the same way (or `H3D_LIVE_BRIDGE=<path>`), starts `h3d-m3game-<random>` with two
plain-shell workspaces (no coding agents) and the proxy to `$XDG_RUNTIME_DIR/h3d-m3game/<run>/bridge.sock`; the spec
(`e2e-live/m3.spec.ts`) runs its own private bridge on it (db `/tmp/h3d-m3game/<run>/world.db`, `--sessions
'^h3d-m3game-…$'`) so it can restart it. It creates a building and moves the floor into it from the UI, restarts the
bridge and checks both are still there, then sleeps the floor and wakes it from the elevator panel and checks every
worker kept its desk, and saves floor settings from the panel (a status with a comma among them) and checks the
restarted bridge still has them and that saving one other key sends only that key. On a
bridge without `floor.wake` / `floor.settings.set` (it answers `unknown_command`) those tests are skipped and say so. Afterwards the session is stopped and deleted and the `herdr-s-h3d-m3game-…` unit a wake started is
removed; after a hard kill, check `herdr session list` and `systemctl --user list-units 'herdr-s-h3d-*'`.

`test:live:m5` builds the bridge the same way (or `H3D_LIVE_BRIDGE=<path>`) and starts `h3d-m5integ-<random>` with a
plain shell in a temporary git repository (a commit not pushed to its local bare `origin`, a staged, a modified, a
deleted and an untracked file) and two cheap Claude agents (`claude-haiku-4-5-20251001`, `low`, `--permission-mode
default`) in new folders, so both stop at their trust dialogs; then a private bridge on
`$XDG_RUNTIME_DIR/h3d-m5integ/<run>/bridge.sock` (db `/tmp/h3d-m5integ/<run>/world.db`; `<run>` is the run's own, so
runs in parallel worktrees keep apart, and each removes only its own) watching only that session, and the proxy.
`e2e-live/m5.spec.ts` drives the real game UI against it, in order: the three laptops live (the real screens in the
xterm buffers, one `terminal session observe` each); E at the shell's laptop, typed text echoing there, Esc back to the
same pose, and after 20 sit / stand cycles no watch in the game and no observer process (`/proc`); the first agent's
trust dialog on its card, approved with its digit (2: "Yes, I trust this folder"); P: sent, working then idle / done
on screen, and a second prompt while it works queued; its usage from its real transcript (the look-at line, the card,
the top bar's `≈$`); a Bash permission prompt on the card, approved with 1 (the command ran); N to the blocked one
before the done one, and the blocked one approved from its bubble; C on the shell matching `git diff --shortstat` /
`--numstat` against the merge-base and `git status` (files, counts, chips), then over 256 KiB after two big staged files
and R: the truncation notice. About 1.5 min and a few haiku turns. Shots go to `game/test-results/live-m5/`. The session
is stopped and deleted afterwards, also on failure; Claude remembers the trust of the temporary folders.

`perf:mac` serves `game/dist` on a leased port P and opens `ssh -o ControlMaster=no -o ControlPath=none -N -R
127.0.0.1:P:127.0.0.1:P devmac`, so the Mac page is on its own loopback (a secure context: WebGPU).
It pipes `tools/mac-runner.mjs` into `/opt/homebrew/bin/node` in `~/h3d-tools` (playwright-core, headless Chrome at
3024×1890) and runs `window.__h3d.bench()` — the engine-bench method: serialized update + render + GPU wait,
pipelined throughput, GPU timestamps, and rAF frames that include DOM layout. M3b jobs bench the outside of the
8-floor tower in `perf-city240`: `street8` (the facade from the sidewalk), `escape8` (the top landing, looking down),
`window8` (out of a top-floor window), and `floor60-street`; `bench()` reports the `area` it ran in. M3c jobs:
`floor60-mezz` (at the corner office's glass, looking down over 60 workers), `floor60-desk` (seated at your desk) and
`floor96-desk` (seated over 96 workers who all need you: every card shows).
M5 jobs, on `perf-floor60` with the simulator: `floor60-screens` (the overview with four live laptop screens),
`floor60-screens0` (the same with `screens=0`) and `floor60-laptop` (seated at a laptop). On the server,
`H3D_BENCH=1` with the m5-screen spec runs the same comparison on WebGL2 (relative numbers only).
`bench(opts)` takes `frames` (300), `warm` (60), `sway` (true), and `pipelined` / `raf` (both true): false skips the
pipelined throughput run (`pipelinedMs` is null) or the 120 rAF frames (`rafMainMs`, `rafIntervalMs` null). The
default suite's perf specs (`m3d-perf`, `m7-perf`, the m6-crew frame budget) read only the serialized frame and the
draw counts, so they bench `{ frames: 40, warm: 10, pipelined: false, raf: false }` (m6-crew: 20 and 5), and they
close the first page before benching the baseline, so the two runs don't share the CPU. `perf:mac` and the
`H3D_BENCH` benches keep the defaults.

`window.__h3d` (tests, perf): `backend`, `frames`, `error`, `ready`, `view()`, `lookAt()` → `{kind, id, name?, label?}`
or null, `status(workerId)` → `{status, at}` as last rendered, `world()` (shown `name`/`desk` plus what the bridge
sent, `bridgeName`/`bridgeDesk`, null from an older bridge), `layout(session)`, `enterFloor(session, pose?)`,
`leaveFloor()`, `inject(event)` (applies a protocol event as if the bridge sent it), `setPose({x, z, yaw, pitch})`,
`pose()`, `plan(open)`, `focusBuilding(i)`, `cards()`, `badgePoint(session)`, `bench(opts)`. M3d: `logos()` → `{fetches, cached, city: [{building, hash, lit}], lobby: {canopy, wall}}` (`showing` `'logo'` | `'name'` and the
hash on each of the entrance sign and the reception wall; null outside a building). M3: `view().asleep`
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

M5: `screens()` (per worker of the floor you are on: `desk`, `state` live | pending | frozen | glow | dark, and the
`fps` it is watched at, else null), `seated()` (the worker whose laptop you sit at, or null), `sitAt(workerId)` (as E;
false with a toast when you cannot), `screenText(workerId)` (a live laptop's screen from its xterm buffer, a string per
row), `frozenInk(workerId)` (the share of its frozen screen that is not black, 0–1; null when not frozen), `seat()` (the seat bar: shown, tape, note, state ok | busy | error | offline), `watches()` (this connection's
watches as the game counts them and, with `sim=1`, as the simulator does), `reconnect()` (drops the connection and
connects again; the game re-watches) and `watchLog()` (the last 400 `terminal.watch` / `unwatch` the game sent by
itself, with their results: `sent()` keeps to what you did, so it has your `worker.keys` and `worker.prompt` but not
these). `panel()` also returns the prompt overlay (`kind: 'prompt'`: the worker, its status, `state` ready / sending /
sent / failed, the text, `queued`, the ack's `result`, `blocker`, `status`) or else the Changes panel (`kind:
'changes'`: `state`, error `code`, branch, upstream, base, stat, truncation notice, the files with their chips and
counts, the selected file's diff: `lines`, the lines drawn now, why there is none); the elevator's adds `pick` (the
floor N preselected). `cards()` entries add `ask` (a question: text, choices, selected), `usage` (the looked-at
worker's line) and `tall`. `needs()` (who needs you in N's order), `nextNeed()` (presses N: who it went to),
`openPrompt(id)`, `openChanges(id)`, `face(id)` (stands you facing a worker of your floor, as N does; true when look-at
picks it).

M6 crew: `crew()` (the floor with an interior: per crew member its `desk`, `role`, `life`, `overCap`, `stamp`, `run`,
`display` and the crew `parts` drawn at its desk; `shown`: the crew parts drawn at all), `simCrew(args)` (one
`sim.crew` step of the simulator's scripted freelancer). `cards()` entries add `tag`, `stamp` and `crew` (the
looked-at crew member's lines); `arrivals()` add `carry` (box | briefcase), `briefcase` and `wave`.

M6b: `deskArt(desk)` (a desk of the floor with an interior: the `parts` it draws, instances per part; the docked
laptop's `sticker`, `logo` claude | codex | plain and its `rim` colour, null without a laptop; the dock `side`;
`dropping`: a hire drops in there), `screenMesh(workerId)` (a live screen's plane: its `desk`, `mesh`, whether it
shows the terminal's `texture` and in the `glance` view, its world `center` and `size`, against the desk `monitor`'s
terminal area; null when not live). `arrivals()` add `dy` (a drop-in's height over the seat); `world()` workers add
`harness`.

M17: `daylight()` → `{daylight, target, warmth, zone, zoneSource, latitude, pinned, model, instant, clock, lamps, face}`
(`daylight` as eased and shown, `target` as read; `zoneSource` `override` | `setting` | `browser`; `model` `latitude` |
`fixed`; `lamps` the office lamps' intensities; `face` what the wall clock's canvas shows, with `day`), `clock()` → the
clock's text, `14:05 · Wed 30 Sep`.
M15 radio: `radio()` → `{genre, trackId, playing, volume, muted}` (`genre` is a genre id or `off`; `playing` is true while a track
sounds on the floor that has the radio, and false when it is off, muted, faded out (lobby, street, fire escape, city) or not
unlocked yet), `radioEvents()` (what the radio did, in order: `genre`, `select`, `start`, `skip`, `fade` in / out,
`unavailable`, each with `at`, and the genre / track / detail).
M7 boards: `boards()` (what the wall shows for the floor with an interior: `issues` / `prs` notes with their `id`, pose,
atlas `cell` and `face` (key, title, paper, pin, holder, done / CI, review, closes, stamp), `flights` in the air and
`flightLog` of those that landed, `gongRings`, `issuesWrites` / `prsWrites` (buffer writes: a quiet poll adds none),
`batches` (two instanced draws, however many notes), `office` (a counter: a board update must not build another floor),
`watched` and `off`), `board()` (the open overlay: its columns with the keys of their cards, the freshness notice, and
the open item modal with its visible `actions`, open confirmation, comments and body text), `openBoard(which)`,
`openBoardItem(which, id)`, `injectBoard(message)`, `boardLog()` (the `board.watch` / `unwatch` / `refresh` the game sent
by itself; `sent()` leaves them out), `opened()` (pages the game asked to open, and `via` `helper` or `window`),
`simBoards(args)`. `dialog()` also returns the Open PR dialog (`kind: 'open-pr'`), and a start-run dialog started from a
card has `ticket.kind === 'work_item'`.

### Audio and voice lines

The game's sound is the lobby receptionist (`src/reception/`) and, since M15, the lounge radio (below). The voice is played by a small Web Audio module
(`src/audio/`): positional (the voice comes from the desk), clips fetched and decoded the first time they play, the
AudioContext created on the first click, key or pointer lock (Chrome's autoplay rule), and a no-op without Web Audio
(headless tests). The top bar's mute toggle and volume slider are remembered per browser (`localStorage`
`h3d.audio`, `{muted, volume, music: {volume, muted, genre}}`); muted, the speech bubbles still show. `src/reception/lines.ts` holds the rules (time-of-day welcome on the
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

### The office radio (M15)

Real tracks by other artists on a small radio in the lounge; genres, not stations. Decisions on the issue's open questions:
the audio is git-ignored and fetched by a tool, with a release gate on claim status; one genre for the whole player, saved;
no ducking for the receptionist (the radio only plays on floors); Off is a stop of E's cycle, and the sound control also
has a music mute. The Web Audio graph gets a **music bus** (`src/audio/music.ts`, owned by `GameAudio` as `audio.music`):

```
deck A ─┐
        ├─ radio panner (HRTF, at the radio prop) ─ floor fade ─ music bus (own gain, mute) ─ master ─ speakers
deck B ─┘
```

- **Streaming.** A deck is an `HTMLAudioElement` through a `MediaElementAudioSourceNode`: nothing is decoded whole or
  cached (a 4-minute track would be tens of MB). Two decks crossfade over 1.5 s on a genre change and into the next track
  (which starts 1.5 s before the end). A file that is missing or not audio is skipped to the genre's next track (a `skip`
  event; a genre with no files at all gives up after one pass instead of looping).
- **Shuffle.** Each genre has a shuffled queue that plays every track before repeating, never opens a round with the last
  track, and keeps its place while another genre plays: jazz → rock → jazz plays jazz's *next* track.
- **Where and when.** `RadioLink` (`src/radio/link.ts`) tells the music where the radio prop is and whether you are on the
  floor that has it (`place.area === 'floor'`). Off the floor the floor fade takes it out over 0.5 s and the decks pause;
  back on, the same track resumes. `stop()` and the receptionist never touch the music bus. Nothing plays, and nothing
  throws, without Web Audio, before the first gesture or while the browser keeps the context locked; the first gesture
  after you are on a floor starts it. Distance model: inverse, `refDistance` 3 m, `rolloff` 0.7 (full level in the lounge,
  about 42 % at 10 m and 23 % at 20 m).
- **Prop.** `radio` in `world/layout.ts` (on the counter, no collider of its own), `render/radio.ts` (a retro box: speaker
  grille, a low-res display canvas that says the genre, a LED that glows while it plays; drawn only when they change).
  The look-at bar, E and R are in `ui/hud.ts` and `app.ts`.

**Tracks.** `game/music/manifest.json` has one row per recording (`id`, `genre`, `title`, `artist`, `sourceUrl`,
`downloadUrl`, `license`, `licenseUrl`, `attribution`, `claimStatus`, `verifiedAt`, `proof`, plus `claimUrl` / `claimProof`
for a cleared row, and the measured `sha256`, `durationSec`, `loudnessLufs`). The licensing rule is in
[`docs/architecture.md`](docs/architecture.md) §5; the research (sources, exact credits, what was rejected) is in issue #30.
`tools/music.test.ts` audits it and vitest fails on: an NC / ND license, a CC BY row without its attribution (title and
license link in it), a row without proof, a cleared row without its claim statement, a genre with fewer than 5 rows, a
lock that disagrees with the manifest.

```sh
pnpm -C game music                # fetch + transcode what is missing (Ogg Opus 96 kb/s, two-pass loudnorm to -16 LUFS) -> game/public/music/
pnpm -C game music --dry-run      # what would be fetched
pnpm -C game music --check        # exit 1 unless manifest, lock, proof pages and the transcoded files agree (no network, no ffmpeg)
pnpm -C game music --check --release   # the same, and fail while any row is claimStatus "hold"
pnpm -C game music --proof        # archive each row's page (and its claim statement page) into game/music/proof/
pnpm -C game music --pin --only <id>   # first fetch of a new row (or a reviewed upstream change): record sha256, length, loudness
pnpm -C game music credits        # MUSIC_CREDITS.txt (the build writes it into dist/ itself)
pnpm -C game music testclips      # the tiny tone clips of the Playwright spec (game/e2e/fixtures/music/)
H3D_RELEASE=1 pnpm -C game build  # fails while any row is on hold
```

- **ffmpeg** comes from `H3D_FFMPEG`, else `ffmpeg` on `PATH`, else the pinned `ffmpeg-static` devDependency (a static build,
  downloaded by its install script: pnpm 11 must allow it, see `game/pnpm-workspace.yaml` `allowBuilds`). The lock records
  which ffmpeg made the files: outputs of another build are checked by shape and length, not by hash.
- **The audio is not committed** (`game/public/music/`, `game/music/.cache/` and `game/music/incoming/` are git-ignored: about
  117 MB for 47 tracks). A fresh checkout runs `pnpm -C game music` once (about 10 minutes, `--jobs <n>` transcodes n at once).
  `music/.cache/` keeps the downloaded sources (about 450 MB) so a re-transcode needs no network: delete it freely. The
  build (`vite build`) copies whatever is in `public/music/` into `dist/`.
- **Add a track.** (1) Read its own page: the license must be CC0, CC BY or a written grant that names games; find the exact
  credit and, for a claim status of `cleared`, the publisher's statement that it is not registered in Content ID (else
  `hold`). (2) Add a row with `sha256: ""`, `durationSec: 0`, `loudnessLufs: 0`, a `proof` path (`music/proof/<id>.html`)
  and, for `cleared`, `claimUrl` + `claimProof`. (3) `pnpm -C game music --proof --only <id>`, read the archived page, then
  `pnpm -C game music --pin --only <id>`. (4) `pnpm -C game test` (the audit) and `pnpm -C game music --check`. Commit the
  manifest, the lock and the proof; never the audio. Tobu tracks stay out until there is a signed grant that covers a paid
  game, bundling and an in-world radio.
- **A source that needs a sign-in** (an empty `downloadUrl`): save the file as `game/music/incoming/<id>.<ext>`; the tool
  takes it from there and still checks it against the manifest's `sha256` (`--pin` for the first time). Free Stock Music
  only serves its files with its own pages as the referer (the tool sends the row's `sourceUrl`); Free Music Archive's
  `/download/` needs a sign-in, but its track pages carry the file its player streams (`data-track-info` `fileUrl`), which
  is what the rows use.
- **Release.** Every row must be `cleared`: the gate is `music --check --release` and `H3D_RELEASE=1` on the build. Recheck
  each page just before a release (`--proof` archives it again; look at what changed).
- **Playwright** (`e2e/m15-radio.spec.ts`) never plays the real tracks: it answers every `/music/<genre>/<id>.ogg` request
  with a 90-second generated tone of that genre (`e2e/fixtures/music/`), so it needs no fetch, and checks the look-at bar, E
  through the cycle, R, the toast, the fade in the lobby and back, a missing file, the music popover (slider, mute), and the
  credits panel. `H3D_BENCH=1` adds the frame-time comparison, radio playing against off, on `perf-floor60`.

