# Contributing

Record decisions in the relevant feature file under [`docs/decisions/`](docs/decisions.md). The old log is a
historical lookup; new decisions do not need an entry there.

## Layout

- `cmd/herdr-world` — server-side bridge daemon (Go).
- `cmd/h3d-helper` — Mac-side helper (Go, cross-compiled for `darwin/arm64`).
- `internal/` — shared Go packages. Bridge: `herdr` (the only door to herdr: the read-only client and the allowlisted
  control surface for wake/sleep, hire/send home and the laptops), `watch` (session discovery and per-session watchers), `world`
  (floors/workers from snapshots and `session.json`, identity matching, worker names), `store` (SQLite), `server` (hub +
  WebSocket, wake/sleep, floor settings, hire/send home, M6 team presets and `run.start`), `proto` (protocol v1 types and client), `gitremote` (GitHub
  origin of a directory, for the repo suggestion), `gitops` (the typed git runner of hires, send-homes and the Changes
  panel; #137: a checkout's file listing), `fileindex` (#137 `worker.files`: an index of each worker checkout's files
  and directories from `git ls-files` or `rg --files`, cached per checkout and rebuilt in the background when git's
  index file changes or it grows old; never walks the disk), `repodisc` (#54 repository discovery: the scan roots'
  boundary walk, the bounded git lookups of the candidates, the identity merge and the background catalog with its
  generations; `server` reads its snapshot for `worker.repos`), `fuzzy` (#137: the pure fzf-style path scorer and bounded
  top-N search `fileindex` ranks with; `server`, `store` and `proto` import neither, `TestFileIndexIsWiredByTheApp`), `childagents` (#22: the native child agents of the workers' own sessions: the `Registry` the hub keeps them in, the `Source` interface the provider phases of #20 implement and the `Evidence` they report; nothing persisted; `childagents/childagentstest` is the fixture source and its scripts, test code only), `codex` (Codex session ids and rollout files, for the sleep backfill and usage), `codexapp` (#155: the bridge's side
  of a shared-server Codex worker's own app-server: the passive protocol adapter `Watcher` (initialize, `thread/resume`
  by id only, bounded reconnect, `thread/unsubscribe`, never answers a server request), the launcher (bash by default, fish by option), the
  processes it may stop (only those carrying the launch's marker token), and the checks before a launch; #27: a child
  thread's metadata and items, and the `Watcher`'s observational reads of them (`ChildReader`: never a resume); every
  Codex protocol detail the bridge knows; `server` uses it), `codexchild` (#25 / #27: the Codex `childagents.Source`: a
  worker's subagents from its rollouts, read by the usage tracker, and for a shared-server worker its own app-server's
  word on their state, through the hub's join, in one derivation), `codexreply` (#183: the native reply to Codex's async questions, its envelope built and recognised by one rule; standard library only, `codexapp` re-exports it and `transcript` reads the readable answer entries with it), `codexshare` (#154: test fixture only, imported by nothing; it
  imports `codexapp` (its dial, and #155's launch and adapter in the real-TUI suites): an isolated CODEX_HOME, a
  scripted Responses mock, an app-server client over its unix socket and a throwaway herdr session driver for the real
  Codex TUI; #158: its full-stack suites, under the `integration` tag only, also boot herdr-world through `app.Serve`
  and drive it with `proto`'s client, which keeps the rule: test imports are not in any package's graph;
  `docs/research/codex-shared-tui.md`), `usage` (M5: agents' token
  usage and cost from their transcripts, read incrementally, and the pricing table; #101: the main thread's context in use
  and its window, resolved from `[1m]`, observed context, the table and the model's family, cleared by a compaction; H3D-2: the model
  and effort a transcript reports (`Usage.Effort`, `CleanModel`, `CleanEffort`), which the hub shows as a worker's `model` and `effort` over its reported
  ones, per field, and never stores: `Hub.shownModel`, docs/decisions.md H3D-2), `jsonl` (the shared reading of
  those JSONL files: one tail per transcript, complete lines from byte offsets, no symlinks), `transcript` (M16: the
  Claude and Codex transcripts as one timeline of items, indexed by offset for the laptop's conversation view; phase 2:
  their images as `ImageRef`s, decoded, hashed and resolved through the allowlist of path roots; #57: the agents'
  structured questions, `AskTracker` knowing the one a session's latest turn waits on, fed the usage tail's lines, and
  the question cards of their tool items; #83: `WrapUpTracker`, an armed wrap-up's result line, fed the same lines with
  their byte offsets; #98: `ActivityTracker`, what each worker is doing and its open background tasks, fed the same
  lines; #118: `DigestTracker`, the floor overview's task and recap lines, the first prompt and the last assistant
  steps, fed the same lines), `activity` (#98: the pure rule classifier of tool calls and shell commands, and the opt-in model for the
  commands it can't place: normalise, scrub, cache, budget), `imgcache` (M16 phase 2:
  the bounded content-addressed image cache, memory LRU plus an optional 0600/0700 disk cache; the type sniff, the
  thumbnails (#125: JPEG or PNG by the policy in `MakeThumb`, kept on disk per algorithm variant under `t/`), the path
  allowlist; pure Go), `runs` (M6: write-code runs, the
  freelancers' reports in the runs directory, their links to their orchestrator and their desks next to it), `limits` (M10: the Claude and
  Codex plan limits, read by running the two CLIs as probes through a fake-able process runner), `logo` (M3d: PNG, WebP
  and restricted SVG in, one PNG of at most 1024 px out; pure Go, only the bridge uses it), `upload` (#51: one image
  streamed to Drop Zone as one multipart request, the type sniffed and the size capped on the bytes, its path returned
  verbatim; pure Go, a fake-able HTTP client, the bridge's `POST /upload` uses it); M13 (#15): `screenshare` (the check
  of a screen frame the game sends, a JPEG of at most 1920 × 4096 px and 8 MiB, and the frame store, a 0700 tmpfs
  directory of 0600 files removed after 10 minutes; pure Go, the hub's `screen.grab` uses it), `whiteboard` (each
floor's Excalidraw board: versioned scenes, the last 20 kept, image files once by sha256, each version's render, agents' pins as
complete Excalidraw elements with valid fractional indices; files only, pure Go, the bridge's `/whiteboard/` routes and
commands sit on it) and `drops` (Drop Zone's newest files, read only through imgcache's allowlist, for "Pin a drop"); #74: `hoststats` (the host the bridge runs on, read from `/proc` and `/sys` directly, no gopsutil: the CPU delta, memory, load, the physical disks' rates from `/proc/diskstats`, and the pending Arch updates through `checkupdates` behind a fake-able runner with its own `CHECKUPDATES_DB`; the hire capacity's `server.HostLoad` reads through it; the `Sampler` runs only between a `Start` and its stop, which the hub ties to the first `host.watch` and the last `host.unwatch` or disconnect, so nothing is read while nobody looks; `hoststatstest` is its fake clock; only `execpath` in the module, `TestHostStatsIsALeaf`); #196: `mcpinv` (the MCP & skills inventory: Claude Code's config files and `SKILL.md` folders read without a process, a fresh Codex app-server's `config/read` and `skills/list`, the connection checks that start the servers only on request, the cache per (harness, checkout, config home), display-safe by construction; its processes run through the `Runner` the app wires in, `harness.Run`, so `server` reaches no harness package); #92: `ai` (the classification model and the OpenAI-compatible LLM behind feature-agnostic `Classifier` / `LLM` interfaces with fakes, their keys in a 0600 file, the shared timeouts, one retry and two-call limit; standard library only, `TestAIIsFeatureAgnostic`); #90: `followup` (the follow-up questions: the classifier gate, the LLM extraction and its strict validation, the fallback item, the feature's switch, threshold and `followups.test`; it takes only `ai`'s interfaces, `TestFollowupUsesOnlyAIInterfaces`), and `transcript`'s `TurnEvents` / `FollowupTracker` (a turn's final assistant message, one parse per line shared with `WrapUpTracker`); #66: `schedsuggest` (schedule suggestions: the second gate question on the follow-up questions' turn end, the LLM's `{due_at, title, draft_prompt}` validated against the clock (RFC 3339 with an offset, in the future, at most 30 days out, UTC), the switch, threshold and the user's time zone; no test gate; golden cases in `testdata/`, a live run of them only with `H3D_SCHEDSUGGEST_LIVE=<ai.json>`; it takes only `ai`'s interfaces, `TestScheduleSuggestUsesOnlyAIInterfaces`); #110: `packup` (pack up on request: the classifier gate on a prompt you send, the LLM's spans to cut validated as exact substrings in order and never over an image, the tidied task, the labelled samples, the switch, threshold and `packup.test`; it takes only `ai`'s interfaces, `TestPackupUsesOnlyAIInterfaces`); #118 phase 2: `digest` (the floor overview summaries: the LLM's task and now lines from scrubbed, delimited input, their cleaning, the switch and `digest.test`, one call at a time, the daily cap and the cache by input hash; #174: its reasoning effort and completion budget settings, the bounded retry policy and the call diagnostics, `ai`'s `Request.ReasoningEffort` / `Report` and model reasoning metadata; it takes only `ai`'s LLM interface, `TestDigestUsesOnlyAIInterfaces`); #211: `hireintent` (dictated hiring, phase 2 of #209: one sentence read by the LLM with the research's prompt into a hire proposal for review, never a hire: the strict parse, the resolution against the current hire catalog (`Catalog.Check`, the one tuple rule `validHireIn` calls), the task's UTF-16 source span, the stateless follow-up merge; it takes only `ai`'s LLM interface, `TestHireIntentUsesOnlyAIInterfaces`); #223: `handoff` (the filing cabinet's one writer: a handoff as
`<handoff_dir>/<floor>/<yyyymmdd-hhmm>-<worker>-<slug>.md`, written as a synced `.tmp` linked to a free name, the
bridge's front matter over the unchanged text, the derived title, the size cap, deletion to `.trash/`, the startup
reconcile; #224: `Reserve` / `Written` / `Adopt` / `Discard` / `CleanPending`, the agent's file at
`<dir>/.pending/<floor>/<op>.md` filed with the bridge's front matter; the standard library and `store` only,
`TestHandoffIsALeaf`; no model anywhere), and `transcript`'s `HandoffTracker` / `Resolve` (a transcript's latest
completed final reply, its source identity and its whole text read back from its byte spans, on the same `TurnEvents`
as `FollowupTracker`; #224: `NewMarkerTracker`, an agent handoff request's turn by its marker); #224: `usage`'s
`Usage.cache` evidence and `CacheState` (pure, a fake clock's); #9: `handoffllm` (LLM handoffs: the reducer, `Reduce`
/ `Scrub` / `EstimateTokens`, a main-session snapshot to bounded scrubbed source data with its coverage, its policy in
`doc.go`, the standard library, `jsonl` and `transcript` only, `TestReducerIsALeaf`; and the feature, the switch bound
to a passing `handoff_llm.test`, the versioned prompt with nonce-delimited data, the answer's validation, one call at a
time, `ai`'s interfaces only, `TestHandoffLLMUsesOnlyAIInterfaces`);
#11: `notify` (the notifications' provider-neutral core: the inbox rule ported from the game and pinned to it by
`testdata/inbox_vectors.json` (the game's `notifyVectors.test.ts` reads it too), the episodes and the 5 s done settle,
the settings with their test gate and environment switch, the never-blocking sightings and the bounded sender with its
backoff, the `Destination` / `Channel` interfaces, `FakeChannel` and `FakeClock`; the standard library only, no
`net/http`) and `notify/telegram` (the Bot API behind `Channel`: the token's 0600 file, `sendMessage`, the one `getUpdates` poll
loop of the pairing and (#13) the replies, `setMessageReaction`; only `app` imports it,
`TestNotifyCoreIsProviderNeutral`); #13: `notify`'s `reply.go` (a reply to a notification checked, rate-limited,
typed through the hub's `Prompt` callback and confirmed or answered); #14: `notify`'s `buttons.go` (a card per question
of an ask or follow-up, the taps resolved and collected, answered through the hub's `Answer` callback, the cards edited
to their end; #88: one for a blocked worker's screen permission or trust menu, answered as `worker.answer`; #106:
one card per operation, kept through redraws and failed reads, ended replaced or no longer waiting); #106: `notify`'s
`limits.go` (the send budget per destination: the paced calls, the minute's alerts and cards, what waits for it);
H3D-1: `notify`'s `questions.go` (an episode named by its question in every mode, and Questions only: what qualifies,
a question's own text),
`server`'s `approval.go` (a menu's operation read off its screen, its redacted card lines, its native call) and
`transcript`'s `CallTracker` (the calls a Claude transcript waits on), `approval` (the unwired, off-by-default model
assessment of a permission prompt; the standard library and `ai`'s LLM interface only,
`TestApprovalUsesOnlyAIInterfaces`, `TestApprovalIsNotWired`);
#108: `promptsecret` (possible secrets in a prompt, for the user's review: Gitleaks v8.30.1's default rules generated into
`gitleaks_rules.go` by `tools/secretrules` (its own module, which downloads Gitleaks; `make secret-rules`, and `make
secret-rules-parity` checks them against Gitleaks itself) and run with the standard library, its MIT licence in
`LICENSE-gitleaks.txt`; the structural rules; candidates at exact byte ranges, never overlapping; UTF-16 offsets; the
HMAC revision, the decisions checked against a fresh scan, the file references, a stored prompt's plain record; the
standard library only, `TestPromptSecretIsALeaf`) and `secretfiles` (the protected files: a private runtime directory, owner directories
0700 and files 0600 by random names, fd-relative with no symlink followed, worker and pending owners, release, claim,
sweep, round 5's leases and revoke; their owners, holders and names in `store`, never a byte of a secret; Linux, a stub
elsewhere);
M7 boards:
  `provider` (what the two interfaces share: people, comments, rate, error kinds), `tracker` (the neutral issue
  interface) and `codehost` (the neutral pull request interface), `github` (the GitHub provider behind both: one feed per
  repository and project, the writes) and `githubcli` (the typed `gh` runner); #184: `kaneo` (the Kaneo provider of
  `tracker`: the instance URL's normalization, the REST client with its key, the settings' read-only calls and one
  project's board and writes; the standard library, `provider` and `tracker` only, `TestKaneoIsAProviderLeaf`;
  `kaneo/kaneotest`, a fake Kaneo instance over HTTP serving the provider's fixtures, for the tests above it) and
  `kaneoconf` (the bridge-wide Kaneo connection: instance, key in its own 0600 file, default workspace, the test that
  gates a save, the generation; it reaches Kaneo only through its `Connector` interface and imports nothing of the
  module but `provider`, `TestKaneoSettingsIsProviderNeutral`; `kaneoconf.FakeConnector` for tests). `server`, `store`
  and `proto` never import `github`, `githubcli` or `kaneo` (`TestBoardLayerIsProviderNeutral`): `app` wires the
  providers in (`app.Boards`; `app.Kaneo`: `KaneoConnector` behind the settings, `KaneoFloors` for the floors'
  trackers). Helper: `helper` (ssh tunnel
  supervisor, game server, `/ws` proxy). `app` holds both command lines.
- `deploy/` — `herdr-world.service` (systemd `--user`), `com.jeffreyvdb.h3d-helper.plist` (launchd user agent, Mac).
- `game/` — the game: Vite + strict TypeScript + three.js (`three/webgpu`), pnpm.

## Toolchain

Go 1.27 (see `go.mod`), Node 26.12 (`game/.nvmrc`), pnpm 11.7 (`packageManager` in `game/package.json`),
`portlease` for ports. CI uses the same pins. Node runs `game/tools/*.ts` itself, by stripping the types, so a module a tool
imports holds only erasable TypeScript: no parameter properties, enums or namespaces (#77; `tools/fixture-server.test.ts`
loads the fixture server's modules under plain `node`). Working in a git worktree (the default here)? Follow
[`docs/git-worktrees.md`](docs/git-worktrees.md): create, `make setup`, verify, teardown.

## Remotes

`origin` is the public `JeffreyVdb/herdr-3d`; push branches and tags there only. The history before the public
repository started lives in the private `JeffreyVdb/herdr-3d-archive`: old `#NNN` references in commit messages and
in these docs point at its issues and PRs. Where that context helps, add it as a read-only extra remote, never as a
push target:

```sh
git remote add archive git@github.com:JeffreyVdb/herdr-3d-archive.git
git remote set-url --push archive DISABLED   # pushing to it fails
```

## Build and test

```sh
make setup             # fresh worktree: toolchain check, game deps, Go modules (then make lint, make shot)
make build test lint   # Go binaries -> bin/, game bundle -> game/dist/, go test + vitest, vet/gofmt/tsc
make integration       # bridge against a real herdr (and systemd-run) in throwaway sessions (see below)
make codex-shared-tui  # #154/#155: real Codex TUI (codex-cli 0.160.1, 0.161.0, 0.162.0 or 0.163.0; any other skips) + a second app-server client, mock model, throwaway herdr sessions
                       # (H3D_CODEXSHARE_REAL=1 adds #155's and #158's real-model smokes on ~/.codex: costs inference)
make codex-shared-bridge  # #158 only: herdr-world itself (app.Serve) driven over its WebSocket against that fixture
make helper-darwin     # bin/darwin-arm64/h3d-helper (CGO off)
make secret-rules      # #108: regenerate internal/promptsecret/gitleaks_rules.go (tools/secretrules, its own module: downloads Gitleaks)
make secret-rules-parity  # #108: the generated rules against Gitleaks itself, and the generated file current (not in make test)
make dev               # Vite dev server on a portlease-leased port, 127.0.0.1 only
make shot              # headless WebGL2 screenshot -> game/test-results/shot.png (non-blank check), seconds
make e2e               # build, then the smoke suite: the 30 essential journeys tagged @smoke (H3D_WORKERS parallel, one run per host)
make e2e SPEC=e2e/m6b.spec.ts   # every test of that spec, whatever its tags (same lock and portlease)
make e2e-prebuilt      # the same against the bundle already in game/dist (no build; same lock and portlease; SPEC= PROFILE= GREP= too)
make e2e-extended      # on request: every functional test (all but @visual and @perf; the old full suite minus captures and benches)
make e2e-visual        # on request (CSS / theme work): theme captures (game/test-results/ui-theme/), every per-surface theme audit, all 8 theme combinations, screenshot tours
make e2e-perf          # on request: frame benches and long-task measurements (sets H3D_PERF=1 H3D_BENCH=1), minutes each
make e2e-component     # the composer in its test-only host (/?composer-demo), no 3D scene
make e2e-list          # list a selection without building, leasing a port or starting a browser (PROFILE= SPEC= GREP=)
make browsers          # download the Chromium revision the pinned Playwright expects (opt-in; make setup says when it is missing)
```

- Which checks to run (#42; agents too): while iterating, the Go packages and Vitest files you touch; `make lint test`
  before you hand work over. Browser runs only for changes a browser can see (the game's UI, rendering, the protocol
  between game and bridge): `make e2e` (smoke) once, plus `make e2e-prebuilt SPEC=e2e/<feature>.spec.ts` for the
  feature you changed. A Go-only, docs-only or tooling change needs no browser run. `make e2e-extended`, `e2e-visual`,
  `e2e-perf` and the live suites (`pnpm -C game test:live*`, `make integration`, `make codex-shared-*`) are for a task
  that asks for them (CSS / theme work: `e2e-visual`; a frame-budget change: `e2e-perf`).
- Selection is by Playwright tags in the specs (`test(title, { tag: '@smoke' }, ...)`): `@smoke`, `@visual`, `@perf`,
  `@component`, `@theme`; an untagged test is in `extended` only. `@theme` marks every per-surface theme audit and theme
  combination: the `visual` profile selects `@visual` and `@theme`, so `make e2e-visual` runs all of them, the
  representatives `extended` runs too (`@theme` alone keeps a test in `extended`). `H3D_E2E_PROFILE` (smoke by default, so `pnpm -C game e2e` is
  smoke too) picks one in `game/playwright.config.ts`; make passes `PROFILE=`. `SPEC=` alone runs every test of the
  file (profile `all`); with `PROFILE=` only that profile's tests of it; `GREP=<regex>` narrows further by title or tag
  (`make e2e-prebuilt SPEC=e2e/ui-theme.spec.ts GREP='audit at 390'`). A new test is untagged (extended) unless it is an
  essential journey (`@smoke`, keep the suite within 20–30), a capture or audit (`@visual`) or a bench (`@perf`).
  `docs/research/e2e-selection.md` says why each test is where it is and maps every case #42 moved or removed.
- `make shot` (only `e2e/shot.spec.ts`) and `make e2e` run Playwright against the **cached** Chromium in
  `~/.cache/ms-playwright` (`@playwright/test` is pinned to the version that matches it). Browsers are never downloaded (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`) except by `make browsers`; `make setup` fails naming it when that revision is missing. It forces the
  WebGL2 backend (`?backend=webgl2`) for consistent coverage. Chromium's ANGLE backend can use a hardware GPU or a
  software renderer such as Mesa llvmpipe; check the actual WebGL renderer when comparing performance across hosts.
- Every e2e target runs `H3D_WORKERS` tests in parallel (default 6, a positive integer; anything else falls back to it).
  Playwright runs with `fullyParallel`, so the tests of one spec file are spread over the workers too. Every test opens
  its own page against the shared preview server and writes only its own `test-results/<name>.png`, so keep it that
  way: no shared files, no fixed ports, no order between tests (also within a file: no `describe.serial`, no pages
  shared through `beforeAll`, no module-level mutable state). Keep functional waits tied to the state the next action
  needs: parallel rendering load can delay browser callbacks on either hardware or software rendering. State assertions
  have a 20 s default expectation budget and return as soon as they pass. Keep feature latency contracts explicit with
  their own elapsed-time checks or poll deadlines. Measure suite
  duration and first-attempt failures when choosing a worker count for a host; retain failures as evidence rather than
  relying on fewer workers to hide a readiness race. On Mesa software rendering, `LP_NUM_THREADS` (rasterizer threads
  per pool, default the CPU count) reaches the browser too; capping it alone made the historical llvmpipe run slower.
  Each run writes a JSON report beside the list output, `game/test-results/e2e-report.json` (`H3D_E2E_REPORT` moves it);
  `H3D_E2E_TMPDIR` sets `TMPDIR` for the test run only (browser profiles), never `TMPDIR` around make, since portlease
  keeps its shared state there.
- Every e2e target and `make shot` take a host-wide lock (`flock` on `$XDG_RUNTIME_DIR/herdr-3d-e2e.lock`, `/tmp` without
  it): one Playwright run at a time per host. Competing suites share CPU and rendering resources; historical llvmpipe
  runs dropped below 10 fps when two suites overlapped, slowing game time relative to wall time. A second run
  prints `waiting for another worktree's e2e run (…)` and starts when the first ends (or fails, or is interrupted).
  Without `flock` (util-linux), or when the lock can't be taken, they fail before Playwright starts, never
  run unlocked. Running `pnpm exec playwright` directly skips the lock (`make e2e-list` takes none: it runs nothing).
- The page exposes `window.__h3d` (`backend`, `frames`, `error`) for tests.
- M17: every spec's `openGame` pins the time (`&time=2026-09-30T12:00`, `NOON` in `e2e/game.ts`) unless the test passes its
  own `time=`, and `make shot` goes through it: no spec reads the wall clock's daylight. A test of the real clock fixes
  the browser's clock with `page.clock.setFixedTime` and its zone with `timezoneId` (`e2e/m17-daynight.spec.ts`).
- #216: the application UI theme (Quiet / Ubuntu): a stylesheet change must keep Quiet as it was, so `node tools/ui-quiet-check.mjs <css files>` (from `game/`) expands the Quiet tokens and diffs each file against the commit before #216 (no output hunk but a deliberate one). `e2e/ui-theme-shots.spec.ts` writes a screenshot of every surface in Quiet and Ubuntu, at 1280 and 390 px, to `game/test-results/ui-theme/<set>/<size>/` (`make e2e-visual SPEC=e2e/ui-theme-shots.spec.ts`; `H3D_UI_SET=before-quiet` with `H3D_DIST=<a build of the earlier commit>` and `make e2e-prebuilt` records the "before" set), and `node tools/ui-shot-diff.mjs <before> <after>` says how much of each differs. `e2e/ui-surfaces.ts` lists the surfaces once for those screenshots and for `e2e/ui-theme.spec.ts`'s per-surface audit (palette leftovers, contrast, targets, focus rings, narrow and zoomed layout, one boot per surface and size; a representative per component family runs in `extended`, every surface, with all 8 theme combinations, in `make e2e-visual`): a new dialog or panel belongs in it.
- Never hardcode ports. Use `portlease run` / `portlease reserve`, and bind `127.0.0.1` only. Other agents run in
  parallel worktrees on the same host.
- CI (`.github/workflows/ci.yml`) runs go vet/gofmt/test and the darwin cross-build only when a branch changes a Go input against main (`cmd/`, `internal/`, `game/fixtures/`, `go.mod`/`go.sum`, the Makefile, the workflow); pushes to main always run them. tsc and vitest run only when a branch changes a game input (`game/`, `docs/shortcuts.md`, `internal/whiteboard/testdata/`, `internal/notify/testdata/` (#11: the inbox vectors the game checks too), `internal/childagents/testdata/` (#22: the child-agent scripts the game checks too), the Makefile, the workflow). The shell deploy test always runs. No Playwright in CI.
- `go test ./internal/ai ./internal/server` never call a model (#92): `httptest` servers play Jev and an OpenAI-compatible
  endpoint, and a feature's tests take `ai.FakeClassifier` / `ai.FakeLLM`. `game/e2e/ai-integration.spec.ts` starts its own
  fake Jev and OpenAI servers on OS-leased loopback ports and the fixture bridge (`simjev=<url>`, `game/tools/fixture-ai.ts`)
  calls them; no spec reaches a real provider. #90: `go test ./internal/followup ./internal/server` take the fakes too (#60: `go test ./internal/followup -run Live` measures
the grill round's extraction against the configured LLM only with `H3D_FOLLOWUP_LIVE=<ai.json>` and
`H3D_FOLLOWUP_LIVE_PLAN=low:8192,…`; it costs inference)
  (the server's run the real transcript fixtures `internal/transcript/testdata/*/followup_*.jsonl` through the usage
  tracker), and `game/e2e/followups.spec.ts` starts its own fake Jev and OpenAI servers the same way. #110:
  `go test ./internal/packup ./internal/server` take the fakes, and `game/e2e/m110-packup.spec.ts` its own fake servers. #118 phase 2: `go test ./internal/digest ./internal/server` take `ai.FakeLLM`
  (the server's run the transcript fixtures `internal/transcript/testdata/*/digest_*.jsonl` through the usage tracker),
  and `game/e2e/m118-digest.spec.ts` starts its own fake OpenAI server (`tools/fixture-digest.ts` calls it). #211:
  `go test ./internal/hireintent ./internal/server` take `ai.FakeLLM`; `internal/hireintent/testdata/bench.json` replays the
  research's 50 cases with their recorded live answers. The live replay is `go run ./docs/research/dictation-hiring-bench/dryrun`
  (the configured LLM, the running bridge's catalog read-only; a dry-run interpretation check, never a hire). #213:
  `game/e2e/h213-dictation.spec.ts` starts its own fake OpenAI server; the fixture bridge's `hire.interpret`
  (`tools/fixture-interpret.ts`) calls it and passes its final result on, so no spec reaches a real provider. #214:
  `game/e2e/h214-full-path.spec.ts` (the whole dictated hire, background on and off) and `game/e2e/h214-edge-cases.spec.ts`
  (the cross-phase edge cases) start their own fake OpenAI server the same way (`e2e/dictation.ts`, shared with h213; the
  beep, toast and notification probe is `e2e/hireProbe.ts`, shared with h210) and hold the hire's ack with
  `simclock=manual`. The dry run also takes the e2e's sentences: `go run ./docs/research/dictation-hiring-bench/dryrun
  -extra docs/research/dictation-hiring-bench/e2e-phrases.json` (from the repo root; its result is not committed).
- #223: `go test ./internal/server -run Handoff` files literal handoffs from transcript files the usage tracker reads,
  with the AI fakes and the fake herdr's prompt and key calls counted (none may happen); `game/e2e/h223-handoff.spec.ts`
  drives the fixture bridge's handoffs (`tools/fixture-handoff.ts`: `sim.final`, `sim.prompt_turn`,
  `sim.handoff_fail`, `simhandoffs=<n>`, `simfail=no_handoff`).
- #64 schedules (part 3 of #61, the game's scheduled agents dialog): `game/src/world/scheduleTime.test.ts` checks the
  form's time parsing against Node's own `Temporal` (disambiguation `'compatible'`) across UTC, Brussels, New York,
  Kolkata and Lord Howe, with the zone a parameter (no `TZ`); the dialog and form have jsdom tests
  (`ui/schedules.dom.test.ts`, `ui/scheduleForm.dom.test.ts`); `game/e2e/schedules.spec.ts` drives the fixture bridge's
  schedules (`tools/fixture-schedule.ts`: `simschedules=<n>`, `sim.schedule_fire {id, late_ms?, fail?, skip?}`,
  `sim.schedule_fail {code}`, `simfail=no_schedules`). #127 a schedule's "Add herdr hiring instructions" and Save's
  question: `go test ./internal/store ./internal/server -run 'ScheduleInstructions|ScheduleHerdrInstructions'`,
  `ui/scheduleForm.instructions.dom.test.ts`, `tools/fixture-schedule.test.ts` (`simfail=no_schedule_instructions` plays
  a bridge whose schedules do not take it) and `game/e2e/h127-schedule-instructions.spec.ts`. For a UX look: `make dev`, then
  `?ws=%2Ffixture%2Fdemo-m5%3Fplay%3Dnone%26sim%3D1%26simusage%3D0%26simschedules%3D8&floor=herdr-3d`, Menu → Schedules
  (`window.__h3d.simSchedule('sim.schedule_fire', {id, late_ms: 10800000})` plays a late fire; close the dialog first to
  see its toast).
- #93 hire presets: `go test ./internal/store ./internal/server -run HirePreset` (persistence across a reopen and a
  bridge restart, scoped names compared with full Unicode case folding, never finer than the game's `toLowerCase`, a deleted virtual floor's own presets, every field checked against the fallback
  catalog); `game/src/world/hirePresets.test.ts`, `ui/hirePresets.dom.test.ts` (the list, Use and its replace question,
  the editor's scope, stale and repair states, a bridge-only `name_taken` shown on the name field, a late delete reply leaving a newer view alone, focus kept on live re-render) and `ui/hire.preset.dom.test.ts` (the hire form's exact choice: a hidden
  model kept, a removed one or a missing effort shown and blocking Hire, per-launch edits); `game/e2e/h93-hire-presets.spec.ts`
  drives the fixture bridge's presets (`tools/fixture-hirepreset.ts`: `simhirepresets=<key>` shares them between a key's
  connections and across a reload, `simfail=no_hire_presets` plays an older bridge; each test takes its own key). For a
  UX look: `make dev`, then `?ws=%2Ffixture%2Fdemo-m3%3Fplay%3Dnone%26sim%3D1%26simhirepresets%3Dlook&floor=pastry`, H
  (or the + of a free desk) → the Hire preset tab.
- #224: `go test ./internal/server -run AgentHandoff` asks the agent against fake transcripts the usage tracker reads
  (Claude's slash-command tags, Codex's `<skill>` message), a fake catalog and the fake herdr's typed and submitted
  prompts (exactly one per request), files and fails it every way; `go test ./internal/usage -run Cache` has the cache
  evidence on a fake clock; `game/e2e/h224-agent-handoff.spec.ts` drives the fixture bridge (`sim.agent_turn`,
  `sim.agent_skill`, `sim.cache`). `make codex-shared-tui` includes `TestCodexShareBridgeAgentHandoff`: the real Codex
  TUI, mock inference, the fixture's own `handoff` skill.
- #9: `go test ./internal/handoffllm` has the reducer's goldens (`-update` regenerates them) and the feature's gate,
  prompt and validation on `ai.FakeLLM`; `go test ./internal/server -run 'LLMHandoff|HandoffLLM'` runs LLM handoffs
  against transcript files with a fake LLM and a fake reducer (and once the real one), every failure, cancel, stale
  config or session, restart and the logs, audit rows, wire and job rows checked free of the transcript, instruction,
  document and secrets; `go test ./internal/ai -run 'Request|Uncertain'` the per-request timeout and no-uncertain-retry;
  `game/e2e/h9-llm-handoff.spec.ts` drives the fixture bridge against a fake OpenAI-compatible server and with no
  endpoint (`tools/fixture-handoff.ts`: `simhandoffllm=ready|off|untested|incomplete|none`, `simhandoffllmout=success|
  slow|too_large|busy|<code>`, `sim.handoff_llm`, `sim.llm_finish`). For a UX look with no endpoint:
  `make dev`, then `?ws=%2Ffixture%2Fdemo-m5%3Fplay%3Dnone%26sim%3D1%26simusage%3D0%26simhandoffllm%3Dready%26simhandoffllmout%3Dslow&floor=herdr-3d`
  (a worker needs a completed reply first: `window.__h3d.simHandoff('sim.final', {id, text})`).
  `go run ./cmd/handoff-spike FILE.jsonl…` is the spike's dry run (numbers only); `--send` costs money.
- #11: `go test ./internal/notify/...` never reaches Telegram: an `httptest` Bot API (`getMe`, `sendMessage`,
  `getUpdates` with offsets) and `notify.FakeClock` (the settle, the backoff and a code's expiry with no real sleep);
  `go test ./internal/server -run Notify` drives the hub with `notify.FakeChannel`. The inbox vectors are rewritten by
  `go test ./internal/server -run TestNotifyInboxVectors -update-notify-vectors` and checked by
  `game/src/world/notifyVectors.test.ts`; `game/e2e/h11-telegram.spec.ts` drives the fixture bridge's Telegram
  (`tools/fixture-telegram.ts`: `simtelegram=off|token|paired|on|env|old`, `simtelegrampair=<ms>`, `sim.telegram`).
- #108 round 3 (the game's review of prompt secrets): `game/src/world/promptSecrets.test.ts` (the switch, a scan read
  strictly, code point steps across astral characters and CRLF, the review's ignore, edges, manual marks and the
  decisions it sends), `ui/secretsFlow.test.ts` (scan, review, stale and required reviewed again, off and unavailable
  kept, the identical retry after a lost answer), `ui/secretsReview.dom.test.ts` (the dialog by keyboard and pointer, DOM
  positions to UTF-16 offsets, a 16 KiB prompt), `ui/prompt.secrets.dom.test.ts` and `laptop/transcriptMode.secrets.test.ts`
  (the P overlay and the laptop's prompt box through the flow: nothing sent before Confirm, pack up given the review
  (round 4), the masked pending row, memory-only drafts), `ui/promptSecretsSection.dom.test.ts`,
  `net/redact.test.ts` (the command log) and `tools/fixture-secrets.test.ts`. `game/e2e/h108-prompt-secrets.spec.ts`
  drives the fixture bridge (`tools/fixture-secrets.ts`, its own small deterministic detector: `simsecrets=<key>`,
  `simsecretson=1`, `simsecretsdir=none`, `simfail=no_secrets|secrets_review_stale|secrets_review_required|
  secrets_unavailable|secrets_review_off`, `sim.secret_files` through `window.__h3d.simSecretFiles()`): the review from
  the P overlay, the laptop's prompt box and a paste into its terminal, cancel, a stale review, the switch going off
  mid-review, localStorage and `window.__h3d.sent()` checked free of every protected value, and every control of the
  review reached by pointer and keyboard at 1280x720, 640x360 (200% zoom) and 390x844 (touch), none cut off by a box
  that does not scroll. For a UX look: `make
  dev`, then `?ws=%2Ffixture%2Fdemo-m5%3Fplay%3Dnone%26sim%3D1%26simusage%3D0%26simsecretson%3D1&floor=herdr-3d`, P on
  Pebble, and a prompt such as `deploy with TOKEN=ghp_abcdefghijklmnopqrstu1 and PASSWORD="hunter2x"`.
- #108 round 4 (every other composer): `ui/secretsFlow.test.ts` (the action word, stored prompts, a review per text),
  each composer's `*.secrets.dom.test.ts` through the real flow and dialog over the fixture's gate
  (`src/test/secretsBridge.ts`: `hire`, `hireReview`, `startRun`, `schedules` (the form and a failed schedule's repair),
  `hirePresets`, `handoffDialog`, `sendHome` (the wrap-up and pack up's hand-over), `laptop/transcriptMode.answers`),
  `ui/prompt.secrets.dom.test.ts` and `laptop/transcriptMode.secrets.test.ts` (pack up with the review and its
  hand-over), `net/redact.test.ts` (every route), `ui/drafts.test.ts`, `laptop/asyncDrafts.test.ts`,
  `laptop/followupDrafts.test.ts` and `ui/hire.secrets.dom.test.ts` (memory-only drafts per store),
  `world/promptSecrets.test.ts` (A1: the take-over's fixpoint, also checked in the random walk) and
  `tools/fixture-secrets.test.ts` (every route of the fixture). A composer closed, opened again or stood up from while
  its text is scanned sends nothing and opens no review (`SecretsRequest.live`): the tests hold the scan with
  `secretsBridge().holdScans()`, press Esc as the dialog's `cancel` event then `close()` with the toasts recorded, and
  hold the command itself with a pending answer for "still on its way" and for a newer opening; a stale hand-over ends its submission (`src/app.dictation.test.ts`,
  `ui/hireReview.secrets.dom.test.ts`). The e2e's round-4 cases (`GREP='round 4'`): a hire with
  a protected value, pack up's "Send as written (stay)" and "Send and go home" with the hand-over (the fake AI servers of
  `e2e/packupFakes.ts`, shared with `m110-packup.spec.ts`), a schedule saved with every match ignored and Protect
  refused, a reference as a masked chip in the conversation (its popover and a copy across it), revoke from the seat
  bar's chip and its absence on a bridge before round 5 (`simfail=no_revoke`). The chips are `world/secretRefs.ts` (the
  exact references, with `World.prompt_secrets.dir` or the shape alone) and `ui/secretChips.ts`, the revoke control
  `ui/revokeSecrets.ts` (its texts `world/revokeSecrets.ts`) and the seat bar's chip; their tests
  `world/secretRefs.test.ts`, `ui/secretChips.dom.test.ts`, `ui/secretChipPlaces.dom.test.ts`,
  `laptop/transcriptSecretChips.dom.test.ts`, `world/revokeSecrets.test.ts`, `ui/revokeSecrets.dom.test.ts`; the theme
  audits `secrets-review-stored`, `secret-chips`, `seat-secrets`, `revoke-secrets`, `send-home-wrapup` (and the
  composers' surfaces with the switch on). For a UX look of pack up: as round 3's, with `simjev=<a fake Jev>`, or the
  schedule form (Menu → Scheduled agents → New) with the same prompt; of the chips and revoke: send the prompt from
  Pebble's laptop box (E, then the conversation), then the seat bar's "protected file" chip.
- #207 manual processes: `go test ./internal/manual/... ./internal/cmdrequest` and `go test ./internal/server -run
  'Manual|Askpass|CommandRequest'` never run sudo or change Tailscale: credentials are synthetic markers and
  `internal/server/testdata/fake-sudo.sh` plays `sudo -A`. `go test -tags integration ./internal/app ./internal/server
  -run '^(TestIntegrationManualProcess|TestManualAskpassIntegration)$'` uses a throwaway Herdr session with isolated XDG
  dirs. The e2e is `e2e/h207-manual-processes.spec.ts` on `tools/fixture-manualproc.ts`: `simmanual=<key>` shares a
  key's records between connections (a key containing `cleanup`, `gone` or `all` seeds a gone worker's cleanup-needed
  Tailscale record), `simcmdreq=bridge|multi-line|sudo|other-host|tailscale-bg` puts a command request on Zippy's reply,
  and the fixture's password is `fixture-pass`. For a UX look: `make dev`, then
  `?ws=%2Ffixture%2Fdemo-m5%3Fplay%3Dnone%26sim%3D1%26simmanual%3Dlook%26simcmdreq%3Dsudo&floor=herdr-3d`, sit at Zippy.
- #213 (bridge side): `go test ./internal/manual/inputwatch` covers the input detector's matrix on a fake proc reader
  (syscalls readable, denied as under Yama `ptrace_scope=1`, and no `children` files) plus real parent-owned ptys
  (`BenchmarkObserveSystem` measures a sample on the live `/proc`); `go test ./internal/server -run
  'ManualInput|ManualCredentialAttention'` the episodes, and `TestManualInputAttentionEndToEnd` the running hub with a
  scripted proc reader, a terminal watch and the hygiene sweep. `go test ./internal/manual/askpass -run
  TestEligibilityVectors -update-eligibility` rewrites `testdata/eligibility.json` (the game's parity test reads it).
  `go test ./internal/server -run 'TestCommandRequest(MissedReply|Pipeline)'` feeds the missed 27 October reply
  (`internal/cmdrequest/testdata/reply-213-first.txt`, checked by its SHA-256) through the settled-turn path and the real
  `ai.Service`, with `httptest` servers for the classifier and the LLM.
- #213 command input: the suggestion card is `laptop/commandRequestCard.ts` (+ `.css`), the askpass rewrite the game shares
  with the fixture is `world/askpass.ts`, checked against the bridge's `internal/manual/askpass/testdata/eligibility.json`
  by `world/askpass.test.ts`. A run asking for you is `attention` on `ManualProcess` (`world/manualProcess.ts`
  `attentionOf`, the words by kind and certainty, `AttentionEpisodes` for one toast or notification per episode id) and
  `ui/manualAttention.ts` (the chips: top bar, the seat's notices row). The fixture adds `simcmdreq=sudo-k` (the user's
  `sudo -k …` launch with its trailing line break), `attention` on its password requests, `input_detection: 'hints'`
  on every run and `sim.manual_attention {id, attention: confirmed|uncertain|sudo|odd|clear}` for input episodes. The
  e2e is `e2e/h213-command-input.spec.ts` (`H3D_213_SHOTS=<dir>` keeps its screenshots: the card in the four theme
  pairings at desktop and 390 px, the chips and the list).
- `go test ./internal/helper` never runs ssh: the test binary stands in for it (`H3D_FAKE_SSH`) and forwards to an
  in-process bridge.

## Bridge (`herdr-world`)

Protocol: [`docs/protocol.md`](docs/protocol.md). Every herdr call goes through `internal/herdr`, in two allowlisted
parts:

- **Reads** (`herdr.Client`): the socket methods `ping`, `session.snapshot`, `events.subscribe` and (#176, the seated
  laptop's history offset) `pane.get`, plus `herdr session list --json`. `TestReadOnlyAllowlist` is the tripwire.
- **Writes** (`herdr.Control`), for `floor.wake` / `floor.sleep`, `session.create` (#58), `worker.hire` /
  `worker.fire` and the laptops (M5) only: exactly the command shapes in `controlShapes`.
  - Wake and sleep: `systemd-run --user --unit=herdr-s-<name> … <shell> -l -c "exec herdr --session '<name>'
    server"` (`<shell>`: the bridge's shell policy, `--shell bash|fish`, bash by default: [protocol.md](docs/protocol.md#shell-policy)), `herdr session stop <name> --json`, `herdr --session <name> pane run <pane> "claude --resume <id>"` /
    `"codex resume <id>"`, `herdr --session <name> pane report-agent-session <pane> --source herdr:codex --agent codex
    --agent-session-id <id>`, and the read-only `herdr --session <name> pane process-info --pane <pane>`.
  - New session (#58, `create-session`): the wake's `systemd-run` shape for a name herdr has not seen, after
    `herdr.CheckNewSessionName` (`^[a-z0-9_-]+$`, the host's `sun_path` cap) and `herdr.NewSessionTaken` (not listed in
    any state, no session folder, no loaded `herdr-s-<name>` unit); see docs/protocol.md "New herdr sessions".
  - Hire: `workspace create --cwd <dir> --label <label> --no-focus`, `worktree create --cwd <dir> --branch h3d/<…>
    --base origin/<…> --label <label> --no-focus`, `pane rename <pane> h3d-<hex>` (the marker), `agent start <name>
    --kind claude --pane <pane> --timeout 30000 -- --model <m> --effort <e> --permission-mode bypassPermissions --name
    <label>` / `--kind codex … -- -m <m> -c model_reasoning_effort=<e> --dangerously-bypass-approvals-and-sandbox`, the
    read-only `pane read <pane> --source visible` (trust dialog), `pane send-keys <pane> down|enter|ctrl+c`, `agent
    prompt <pane> <text> --wait --until working --until blocked --timeout 8000` (Codex), and for Claude (#95) the
    prompt typed: `pane send-text <pane> <chunk>` (`type-text`: at most 700 characters, `\n` its only control
    character, 50 ms apart) then `pane send-keys <pane> enter` (`Control.TypePrompt`); a prompt that fails part way
    is erased with the laptops' `pane send-keys <pane> ctrl+u backspace …` (`Control.EraseTyped`).
  - Send home: `pane send-text <pane> /exit` / `/quit`, `workspace close <ws>`, `worktree remove --workspace <ws>`
    (never `--force`, never `--group`).
  - #155 shared Codex server (a Codex hire with the `codex_server` switch on, its sleep and wake): `pane run <pane>
    "setsid -f <shell> <launcher> </dev/null >/dev/null 2>&1"` (the launcher the bridge wrote, in the policy's shell), `agent start <name> --kind
    codex --pane <pane> --timeout 30000 -- --remote unix://<socket> -C <dir> -m <m> -c model_reasoning_effort=<e>
    --dangerously-bypass-approvals-and-sandbox`, and on wake the same with `resume <id>` first and **no** bypass flag
    (a remote resume refuses permission overrides); a wake whose server does not start resumes on the embedded server
    with `agent start <name> --kind codex --pane <pane> --timeout 30000 -- resume <id> -m <m> -c
    model_reasoning_effort=<e> --dangerously-bypass-approvals-and-sandbox` (never an argument-free `codex resume`).
    The launcher and socket must sit directly in `Control.CodexRun`
    (`--codex-run`, default `$XDG_RUNTIME_DIR/herdr-world/codex`), with only `[A-Za-z0-9._/-]` and a `.sh` (`.fish` under the fish policy) / `.sock`
    name; `-C`'s directory only plain path characters (`ValidPlainDir`). Sleep quits the TUI with the send home's
    `/quit` + Enter, never Esc or Ctrl-C; a shared worker's send home sends no Ctrl-C either.
  - Laptops (M5, `terminal.watch`, `worker.keys` / `prompt` / `answer`): the read-only, long-running `terminal session
    observe <pane> --cols <40–300> --rows <10–100>` (its own process group; SIGTERM, SIGKILL after 1 s, always reaped),
    `pane send-keys <pane> <key>…` (only the key names in `docs/protocol.md` "Input", and the digits 1–9 of a menu),
    `pane send-text <pane> <text>` (no control characters) and the fixed sequences of delete / home / end / pageup /
    pagedown, `agent prompt <pane> <text>` with `--wait --until working --until blocked --timeout 8000` or without
    (queued for an agent at work; Codex only: a prompt to Claude is typed, as for the hire), and the hire's `pane read <pane> --source visible` (a blocked worker's question).
    #74's fullscreen laptop adds exactly two: `pane zoom <pane> --on` and `pane zoom <pane> --off` (explicit modes,
    never `--toggle`; `Control.SetZoom`), each write its own `pane.zoom` audit row (`{"session","pane","mode","why"}`).
    The hub's zoom code (`internal/server/zoom.go`) has two locks: `zoomTabs.write` serialises the zoom writes and the
    reads their decisions rest on (held across herdr calls, always taken first), `zoomTabs.mu` guards the refs and
    flags (never held across a herdr call; the hub goroutine takes it). A ref is held only by a watch that wants the
    tab fullscreen; `terminal.watch.fullscreen` is a `*bool` (absent: an old client, never followed).
    #57's `worker.answer_ask` uses these same shapes (digits, arrows, `tab`, `enter`, `esc`, `send-text`, `pane
    read` between steps): no new one.
    #176's seated laptop adds exactly one: the long-running `terminal session control <pane> --cols <40–300> --rows
    <10–100>` (`Control.ControlTerminal`; never `--takeover`; its own process group, stopped like an observer), with
    JSONL on its stdin limited to `terminal.resize` (40–300 × 10–100, a cell of 0–256 px), `terminal.scroll` (`up` /
    `down`, 1–1000 lines, `source: "wheel"`, a cell inside 300 × 100, modifiers 0–7), an empty `terminal.input` (no
    text, no bytes: herdr's reset to the live bottom) and `terminal.release`; each line at most 64 KiB, through a
    bounded queue the caller never waits on (`internal/herdr/termcontrol.go`). A refusal (`terminal.closed` with
    "already has an attached client") or a takeover makes the watch a read-only observer
    (`herdr.ControlRefused` / `ControlTakenOver`); `Close` resizes the PTY back to the pane's size before the attach
    (the session's snapshot), then releases, waits up to 1 s and stops it. The hub's part is
    `internal/server/termcontrol.go` (one controller per connection, counted under the observer caps; a new one waits
    for the worker's released one).
    Typed text is never quoted in an error or the audit log. A herdr CLI call takes about 10 ms, so input goes through
    the CLI (consecutive keys, and texts, batched into one call); the socket's `pane.send_input` is not used.

  Every variable is validated (session names, pane/workspace ids, agent session ids, absolute clean directories,
  labels without control characters or a leading `-`, `h3d/…` branches, `origin/…` bases, `h3d-<hex>` markers, models
  and efforts, prompts not starting with `--`, #155's launcher and socket paths and plain directories), every argument is its own argv element, sessions outside `--sessions`
  are refused, and commands run with the `HERDR_*`/`CLAUDE*` variables stripped. `TestControlAllowlist` pins the set,
  the argv and the exported methods; widening any needs review.
- **git** (`gitops.Git`, hires, send-homes, `worker.changes`, M7, `worker.open_pr` and #137 `worker.files`): exactly
  eighteen shapes (`shapes`, pinned by `TestGitAllowlist`): `git -C <dir>` `rev-parse --show-toplevel`, `fetch
  --quiet origin`, `symbolic-ref --quiet --short refs/remotes/origin/HEAD`, `log -1 --format=%H %ct origin/<…> --`, `status --porcelain`, `symbolic-ref --quiet --short
  HEAD`, `rev-list --count HEAD --not --remotes`, `rev-list --count refs/heads/h3d/<…> --not --remotes`, `rev-parse
  --verify --quiet refs/heads/h3d/<…>`, `branch -D h3d/<…>`, and for the Changes panel (M5, read-only) `status
  --porcelain=v2 --branch -z --untracked-files=all`, `merge-base HEAD origin/<…>` and `diff --numstat --patch -z
  --find-renames --no-color --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/ <commit id | HEAD> --`, and for
  opening a pull request (M7) `push -u origin refs/heads/h3d/<…>:refs/heads/h3d/<…>` (the branch name is validated
  and is only ever the one the bridge recorded for that worker; the one shape that writes outside the checkout),
  `rev-list --count HEAD --not origin/<…>` and `log --format=%s -n 20 HEAD --not origin/<…> --`, and for
  `worker.files` (#137, read-only, neither writes the index) `rev-parse --path-format=absolute --git-path index` and
  `ls-files -z --cached --others --exclude-standard --deduplicate`. A branch is deleted only when the bridge recorded
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
- **codex / direnv before a shared launch** (#155, `codexapp.Preflight`, only for a Codex hire with the switch on):
  `codex --version` (in a temp directory) and `direnv status --json` in the hire's directory, with the `HERDR_*` /
  `CLAUDE*` variables removed, 5 s each. (#116: a direnv that is a mise shim with no version selected exits 1 with mise's
  `No version is set for shim: direnv`; `Preflight` refuses it with the one-line `DirenvUnselectedError`, keeps mise's text as its `Detail`
  and `hireShared` logs that at Warn. A direnv that is not installed at all is still skipped. The worker falls back to Codex's built-in
  server, as for a blocked `.envrc`; the fix is a mise selection, see `docs/git-worktrees.md`. The fixture bridge plays it with
  `simfail=codex_direnv`, next to `simfail=codex_unverified`.) The bridge itself then only connects to the worker's own socket (its
  `Watcher`) and signals processes whose environment carries the launch's `H3D_CODEX_SERVER` token; it never starts,
  connects to or stops the CODEX_HOME daemon, and every `codex` it has the pane run names `--remote` with the worker's
  socket or is that server.
- **gh** (`githubcli.Client`, M7 boards): exactly one shape, `gh api graphql --method POST --input -`, with the request
  as JSON on stdin: `{"query": <one of the embedded documents in internal/githubcli/queries>, "variables": {…}}`.
  Never a query, a field or an argument from a client. `gh` keeps its own authentication (the bridge stores no
  token); the environment is the bridge's minus `HERDR_*` / `CLAUDE*`, plus `GH_PROMPT_DISABLED=1 NO_COLOR=1
  GH_NO_UPDATE_NOTIFIER=1`; 20 s per call, output capped at 8 MiB; GraphQL `errors` are read also when `gh` exits 0;
  401 / exit 4 is `provider_failed` "GitHub auth", a rate limit is `rate_limited`. `TestGitHubAllowlist` pins the argv,
  the set of documents and which of them write (seven mutations: addComment, addProjectV2ItemById,
  updateProjectV2ItemFieldValue, updateProjectV2ItemPosition, closeIssue, mergePullRequest, createPullRequest).

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
  "$(command -v bash)" -l -c "exec herdr --session '$s' server"  # the bridge's own start command (--shell bash, the default)
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
| `--codex-cli` | `HERDR_WORLD_CODEX_CLI` | `codex` on `PATH`, else `~/.local/bin/codex`: startup model discovery, `worker.commands` probes |
| `--claude-cli` | `HERDR_WORLD_CLAUDE_CLI` | `claude` on `PATH`, else `~/.local/bin/claude`: startup model discovery, `worker.commands` probes |
| `--systemd-run` | `HERDR_WORLD_SYSTEMD_RUN` | `systemd-run` on `PATH`: starts woken sessions |
| `--sessions` | `HERDR_WORLD_SESSIONS` | all; a regexp limits which sessions are watched, and the only ones commands may wake, sleep, configure, hire into or send workers home from |
| `--poll`, `--resnapshot` | `HERDR_WORLD_POLL`, `HERDR_WORLD_RESNAPSHOT` | `2s`, `30s` |
| `--max-desks` | `HERDR_WORLD_MAX_DESKS` | `96`: cap on the desks a floor renders beyond its occupied ones (`floor.desks`) |
| `--wrapup-timeout` | `HERDR_WORLD_WRAPUP_TIMEOUT` | `30m`: how long an armed wrap-up waits for the agent's result line before it needs you (#83, [`docs/protocol.md` "Wrap up"](docs/protocol.md#wrap-up)) |
| `--name-hold` | `HERDR_WORLD_NAME_HOLD` | `168h` (7 days): how long a worker's name stays held after the bridge sees it leave its floor; then a newcomer may take it (`worker.name`) |
| `--wake-timeout` | `HERDR_WORLD_WAKE_TIMEOUT` | `10s`: how long a woken server has to start, answer `ping` and be seen running (else `wake_failed`) |
| `--resume-timeout` | `HERDR_WORLD_RESUME_TIMEOUT` | `10s`: how long a wake waits for the agents before the fallback, and again for the fallback and its result (a wake acks within about `--wake-timeout` + 2 × this) |
| `--codex-sessions` | `HERDR_WORLD_CODEX_SESSIONS` | `$CODEX_HOME/sessions`, else `~/.codex/sessions`: Codex rollouts, for the sleep backfill and usage |
| `--claude-projects` | `HERDR_WORLD_CLAUDE_PROJECTS` | `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`: Claude Code transcripts, for usage (M5) and the workers' subagents (#23) |
| `--claude-hooks` | `HERDR_WORLD_CLAUDE_HOOKS` | `claude-hooks` next to `--db`; `-` for none: the bridge's own Claude Code settings file (observational hooks, passed with `--settings` to the Claude workers it starts) and their log (#23, [`docs/protocol.md` "Claude Code subagents"](docs/protocol.md#claude-code-subagents-23)); needs `flock` |
| `--runs-dir` | `H3D_RUNS_DIR` | `$XDG_STATE_HOME/write-code/runs`, else `~/.local/state/write-code/runs`: write-code's run directories, for the freelancers' reports (M6, [`docs/protocol.md` "Runs and freelancers"](docs/protocol.md#runs-and-freelancers)); read only |
| `--dropzone-url` | `HERDR_WORLD_DROPZONE_URL` | `http://127.0.0.1:8080`: Drop Zone, where pasted images are uploaded (#51, [`docs/protocol.md` "Image upload"](docs/protocol.md#image-upload)); the bridge's only client of it |
| `--screen-dir` | `HERDR_WORLD_SCREEN_DIR` | `$XDG_RUNTIME_DIR/herdr-world/screen` (else `/run/user/<uid>/…` when it exists): where `screen.grab` stores frames, 0700, 10 min each (M13, [`docs/protocol.md` "Screen share"](docs/protocol.md#screen-share)) |
| `--secrets-dir` | `HERDR_WORLD_SECRETS_DIR` | `$XDG_RUNTIME_DIR/herdr-world/secrets` (else `/run/user/<uid>/…` when it is ours): where protected prompt secrets are kept, 0700 directories and 0600 files, refused (never repaired) when unsafe; none usable: a review that protects anything is `secrets_unavailable` (#108, [`docs/protocol.md` "Prompt secrets"](docs/protocol.md#prompt-secrets)) |
| `--whiteboards` | `HERDR_WORLD_WHITEBOARDS` | `$XDG_DATA_HOME/herdr-3d/whiteboards`, else `~/.local/share/herdr-3d/whiteboards`: the floors' whiteboards (M13, [`docs/protocol.md` "Whiteboard"](docs/protocol.md#whiteboard)); `-` for none |
| `--ai-file` | `HERDR_WORLD_AI_FILE` | `ai.json` next to the database: the AI integration's settings and keys, 0600, never in the database (#92, [`docs/protocol.md` "AI integration"](docs/protocol.md#ai-integration)) |
| `--kaneo-file` | `HERDR_WORLD_KANEO_FILE` | `kaneo.json` next to the database: the Kaneo connection's settings and key, 0600, never in the database and apart from `ai.json` (#184, [`docs/protocol.md` "Kaneo"](docs/protocol.md#kaneo)) |
| `--ai-classifier-key-file`, `--ai-classifier-model` | `HERDR_WORLD_AI_CLASSIFIER_KEY_FILE`, `HERDR_WORLD_AI_CLASSIFIER_MODEL` | none: a file holding the classification model's (Jev) key, and its model. While set they win over the panel's and show there as "set by the bridge environment" |
| `--ai-llm-base-url`, `--ai-llm-key-file`, `--ai-llm-model` | `HERDR_WORLD_AI_LLM_BASE_URL`, `HERDR_WORLD_AI_LLM_KEY_FILE`, `HERDR_WORLD_AI_LLM_MODEL` | none: the OpenAI-compatible LLM's base URL, the file holding its key, and its model; same rules |
| `--followups-enabled` | `HERDR_WORLD_FOLLOWUPS_ENABLED` | none: `true` or `false` switches the follow-up questions on or off over the panel's toggle, which then shows it read-only (#90, [`docs/protocol.md` "Follow-up questions"](docs/protocol.md#follow-up-questions)); on, they still run only while both AI models are ready |
| `--schedule-suggestions-enabled` | `HERDR_WORLD_SCHEDULE_SUGGESTIONS_ENABLED` | none: `true` or `false` switches the schedule suggestions on or off over the panel's toggle, which then shows it read-only (#66, [`docs/protocol.md` "Schedule suggestions"](docs/protocol.md#schedule-suggestions)); on, they still run only while both AI models are ready |
| `--packup-enabled` | `HERDR_WORLD_PACKUP_ENABLED` | none: `true` or `false` switches pack up on request on or off over the panel's toggle, which then shows it read-only (#110, [`docs/protocol.md` "Pack up on request"](docs/protocol.md#pack-up-on-request)); on, it still runs only while both AI models are ready |
| `--digest-enabled` | `HERDR_WORLD_DIGEST_ENABLED` | none: `true` or `false` switches the floor overview summaries on or off over the panel's toggle, which then shows it read-only (#118, [`docs/protocol.md` "Floor overview summaries"](docs/protocol.md#floor-overview-summaries)); on, they still run only while the LLM is ready |
| `--telegram-file` | `HERDR_WORLD_TELEGRAM_FILE` | `telegram.json` next to the database: the Telegram bot token, its bot and the paired account, 0600, never in the database (#11, [`docs/protocol.md` "Notifications"](docs/protocol.md#notifications)) |
| `--telegram-key-file` | `HERDR_WORLD_TELEGRAM_KEY_FILE` | none: a file holding the Telegram bot token; it wins over the panel's, which then cannot change it, and `telegram.json` keeps no token (#11) |
| `--notify-enabled` | `HERDR_WORLD_NOTIFY_ENABLED` | none: `true` or `false` switches the Telegram notifications on or off over the panel's switch, which then shows it read-only; on, they still go only with a token and a paired account (#11) |
| `--activity-model` | `HERDR_WORLD_ACTIVITY_MODEL` | none: `true` or `false` switches "Classify unknown commands" (the desk monitor's activity, the classification model for the commands the rules cannot place) on or off over the panel's toggle, which then shows it read-only (#98, [`docs/protocol.md` "Activity"](docs/protocol.md#activity)); on, it still calls only while the classifier is ready |
| `--pricing` | `HERDR_WORLD_PRICING` | none: a JSON file of model prices merged over the built-in table (`internal/usage/pricing.json`; format in [`docs/protocol.md` "Usage and cost"](docs/protocol.md#usage-and-cost)) |
| `--warn-workers-per-floor`, `--max-workers-per-floor` | `HERDR_WORLD_WARN_WORKERS_PER_FLOOR`, `HERDR_WORLD_MAX_WORKERS_PER_FLOOR` | `12`, `24`: above the first the hire dialog warns, a hire above the second is refused (`capacity`) |
| `--warn-workers`, `--max-workers` | `HERDR_WORLD_WARN_WORKERS`, `HERDR_WORLD_MAX_WORKERS` | `48`, `96`: the same for all watched running floors together |
| `--git` | `HERDR_WORLD_GIT` | `git` on `PATH`: worktree hires, send-home checks and the repo suggestion |
| `--rg` | `HERDR_WORLD_RG` | `rg` on `PATH`: `worker.files` lists a checkout outside git with it (#137); without it such a checkout lists no files, with a reason |
| `--gh` | `HERDR_WORLD_GH` | `gh` on `PATH`: the issue and pull request boards (M7); without it boards say `gh not found` |
| `--shell` | `HERDR_WORLD_SHELL` | `bash`: the shell of a woken floor's login environment and of the shared Codex launchers (#68), `bash` or `fish` and nothing else; `$SHELL` is never read. A shell that is not installed refuses the start. See "Bash and Fish hosts" below |
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

#### Bash and Fish hosts (#68)

The bridge needs **bash, and no fish**. Wake runs `<bash> -l -c "exec herdr …"` and a shared Codex worker starts its
server through a bash launcher; nothing starts fish unless you ask, however fish is installed and whatever `SHELL`
the service inherits. On a Bash host:

- `herdr` must be on the **login** shell's `PATH` (bash reads `/etc/profile`, then `~/.bash_profile` or `~/.profile`,
  not `~/.bashrc`): `export PATH="$HOME/.local/bin:$PATH"` there. Set `HERDR_WORLD_HERDR` as the unit does for the
  bridge's own calls.
- The worker's server is started by an *interactive* bash, so a `codex` function or alias in `~/.bashrc` applies as it
  does in the worker's pane (keep the usual `[[ $- != *i* ]] && return` guard; a `.bashrc` that execs another shell
  or reads the terminal is not supported). Exported variables (direnv's, `PATH`, `HERDR_*`) always arrive; functions
  and aliases defined only in a login file or by a prompt hook do not. Details: [protocol.md](docs/protocol.md#shell-policy).
- An uninstalled bash refuses the start: `the configured shell "bash" was not found … install it, or set --shell (or
  $HERDR_WORLD_SHELL) to fish`.

To keep Fish's login environment and `config.fish` wrappers (v1.45.0's behaviour), opt in explicitly with
`systemctl --user edit herdr-world` and `[Service]` `Environment=HERDR_WORLD_SHELL=fish` (fish must be installed;
`/bin/fish` is used when it exists). In-flight Fish launches written by v1.45.0 are still recovered and cleaned up by a
bash-default bridge. Test fixtures: `H3D_CODEXSHARE_SHELL=fish make codex-shared-tui` runs the integration suites
under fish (skipped when fish is not installed; the default is bash).

### Integration test

`go test ./...` never touches herdr or systemd (fake socket server + recorded fixtures; `herdr.Control` gets a fake
`Runner` that plays herdr and systemd-run; hires and send-homes run against an in-memory herdr floor and git). Only
`internal/gitops`, `internal/fileindex` (#137, which also runs the real `rg` when installed), `internal/repodisc` (#54)
and the #54 hub tests (`internal/server/repodiscovery_test.go`) run the real `git`, on repositories in a temp dir (M5: `worker.changes` is checked against `git
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
- `TestIntegrationSessionCreate` (#58): creates a session `h3d-it-new-<random>` through `session.create` (the real
  `systemd-run` path), checks the ack comes with its floor in the world, herdr lists it, its unit runs and the bridge's
  unit check sees it, and a second create is `name_taken`; then stops and deletes it.

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

- `TestIntegrationSeatControl` (#176): a plain shell's pane owned through `terminal.watch` with `control`: the PTY
  takes the client's 100 × 30 and a `terminal.resize` to 120 × 35 (`stty size` in the pane), `seq 1 300` then a wheel
  of 20 lines up moves herdr's view (`terminal.history`, `pane.get` agrees), output while scrolled up grows the offset,
  `terminal.scroll` `bottom` and a `worker.keys` both bring it back to 0, a second connection is refused control and
  observes read only (`busy`), standing up (a watch without control) puts the PTY back to its size before (no TUI is
  attached), five sit / stand cycles and closed connections leave no `terminal session control` or observer process
  (a `/proc` scan, `--takeover` never in an argv). About 4 s, no agent.
- `TestIntegrationFullscreenLaptop` (#74): a two-pane tab watched with `fullscreen` against the real herdr: without it
  nothing is zoomed; headless the flag flips (`headless`, 120 × 40) and is put back on `terminal.unwatch`; with a TUI
  attached (a `python3` pty client at 140 × 50, skipped without python3) the watch is the tab's whole content area,
  a human unzooming is reported (`terminal.state`) and not undone, a tab the human zoomed is never put back, and the
  audit log has one `pane.zoom` row per write. About 4 s, no agent. (The ownership rules, their races and the
  error contract are pinned against a fake herdr floor in `internal/server/zoom_test.go`.)
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
  <host>`, restarts it with exponential backoff (0.5 s doubling to 30 s, ±20 % jitter, back to 0.5 s after
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
- (M7) `POST /api/open {"url": "https://github.com/…"}` opens a page in the default browser of the machine the helper runs
  on (`open <url>` on macOS, `xdg-open <url>` on Linux; #81), for
  the game's "Open in GitHub" buttons and the links in issue bodies. Same Host and Origin checks as `/ws`, the token in
  the `X-H3D-Token` header (never in a URL), `Content-Type: application/json`, a body of at most 4 KiB; only `https://`
  URLs on a listed host (`internal/helper.DefaultOpenHosts`: `github.com`; a provider added later adds its host there;
  #184: plus the self-hosted Kaneo instance the bridge names on its `/healthz` (`X-H3D-Open-Hosts`), read through the
  tunnel every check and dropped when the bridge stops naming it), no credentials or port, no control characters. `204` on success, `400` for a refused URL, `403` for a failed check,
  `502` when the opener failed (no such executable, a non-zero exit: the message carries the exit code and the first
  512 bytes of its output) or there is no browser to reach. A command still running after 3 s counts as launched
  (`xdg-open` can stay in the foreground as long as the app it started lives): it is neither killed nor reported as a failure
  (decision in `docs/decisions.md`, `internal/helper/open.go`). `go test ./internal/helper -run 'Open'` covers it with a fake opener and
  with fake `xdg-open`/`open` scripts on `PATH`, no real browser. A page not served by the helper
  (Vite on the server) has no endpoint, and the game opens a new window instead (`https://` only); a page the helper
  serves never falls back to a window: a URL it refuses gets a notice and is not opened.
- (#57) it keeps a **list of bridges** and tunnels the game to one at a time, the one in use. The list is a 0600
  `bridges.json` next to the token (`--bridges-file`), edited through `GET|POST /api/bridges`, `PUT|DELETE
  /api/bridges/{id}` and `POST /api/bridges/{id}/activate` (guarded like `/api/open`; an absent `Origin` passes on
  `GET`; docs/protocol.md "The helper's bridges"). `helper.BridgeSet` is the server's `Bridge`: every proxied route,
  `/healthz` and `/api/open`'s open hosts follow the bridge in use. Each bridge keeps its own supervised connection
  (`internal/helper/bridgeset.go`): an ssh bridge its own tunnel ending at `<dir of --local-socket>/bridges/<id>-<n>.sock`,
  a local bridge (`kind: local`, a socket on this machine: a Linux laptop running the bridge too) its socket dialled
  directly, `/healthz` checked every 5 s (`LocalBridge`, `internal/helper/health.go`). So the list always has each
  state and nothing waits on ssh. A switch closes every connection dialled to the old bridge (the game's `/ws`, the
  proxies' idle keep-alive ones) and the game reloads. Tests: `go test ./internal/helper -run 'Bridge|Switch|Health|Seed|Local'`
  (fake `Bridge`s, the list file, the API's guards and CRUD, one tunnel per entry through the fake ssh, a `/ws`
  closed by a switch), `go test ./internal/app -run 'Resolve|Helper'` (flag, env and list precedence).

It needs non-interactive SSH from the Mac to the host (`BatchMode=yes`: a key in the agent/keychain, host key known).
State goes to the log (stderr), each line with its `bridge=<name>`: `tunnel connecting`, `tunnel up`, `bridge not answering through the tunnel`,
`tunnel down, restarting … retry_in=…`, `local bridge up`, `local bridge not answering`, `bridge switched from=… to=…`. `curl http://127.0.0.1:7777/healthz` shows the tunnel state and both versions (`version` is the helper's, `tunnel.bridge` the bridge's); the helper logs a warning when they differ. The game shows `game … · helper … · bridge …` above the backend line, in amber when they differ.

| flag | env | default |
|---|---|---|
| `--bridges-file` | `H3D_HELPER_BRIDGES_FILE` | `~/Library/Application Support/h3d-helper/bridges.json` (0600): the bridge list Settings → Bridges edits; once it exists it is the truth |
| `--host` | `H3D_HELPER_HOST` | none. Flag, then env: seeds a missing or empty list (that host, named after it, in use); ignored once the list exists. Without any, the helper serves the game and the game asks for a bridge |
| `--remote-socket` | `H3D_HELPER_REMOTE_SOCKET` | flag, then env, for that first bridge; else the helper asks the host for its `$XDG_RUNTIME_DIR` over ssh (in that bridge's supervisor, with backoff) and uses `$XDG_RUNTIME_DIR/herdr-world/bridge.sock` (the bridge's default) |
| `--local-socket` | `H3D_HELPER_LOCAL_SOCKET` | `~/Library/Caches/h3d-helper/bridge.sock`: #57, its directory holds the tunnels' local ends, one per ssh bridge, `<dir>/bridges/<id>-<n>.sock` (`<n>` a new one per tunnel the helper starts, so an edited address never shares the old tunnel's socket) |
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

**No built-in machine.** The helper never guesses where the bridge is. #57: its bridges are its list
(`bridges.json`), which the game edits. A helper with no list takes `H3D_HELPER_HOST` (`user@host`) from the
LaunchAgent's `EnvironmentVariables` (launchd does not see shell exports; `deploy/com.jeffreyvdb.h3d-helper.plist`
carries `@H3D_HELPER_HOST@` and `@H3D_HELPER_REMOTE_SOCKET@` placeholders and its header says how to `sed` them in) or
`-host` as its first bridge, and writes the list; after that neither is read (a host the list does not have is logged).
It reads no other configuration (`helper.env` is still not one). Without a list or a host it starts, serves the game
and logs `no bridge configured`; the game says "No bridge configured" and to add one in Settings. An ssh bridge
without a socket runs `ssh <host> 'printf %s "$XDG_RUNTIME_DIR"'` (same no-multiplexing options as the tunnel) in its
own supervisor and refuses an empty, relative or odd answer (its state is `backoff`, the error its `last_error`;
set the socket in Settings). Real values live only in the installed plist and the list on the Mac, never in the
repository; `docs/releasing.md` ("Changing the Mac's bridge host") has the steps.

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
ssh -o ControlMaster=no -o ControlPath=none -N -L 5173:127.0.0.1:<leased dev port> <user@server> &
~/.local/bin/h3d-helper -dev-upstream http://127.0.0.1:5173
```

Agents test it without launchd and without a window: copy the binary and a `game/dist` to a temp dir such as
`~/h3d-tools/helper-<task>/`, run `./h3d-helper -no-open -host <user@server> -remote-socket <private bridge socket> -bundle <dir>/dist
-local-socket <dir>/bridge.sock -bridges-file <dir>/bridges.json -token-file <dir>/token` (it logs the game URL with its
token; the last two keep it off the real list and token), drive headless Chrome from `~/h3d-tools`
(`playwright-core`), and stop it with SIGTERM when done. Mac port 7777 is the helper's; others use their own.

#57, two bridges without a real one: the fixture server stands in for a bridge on a unix socket (`--socket`; it
answers `/healthz` like one). On Linux, with a short socket directory (unix socket paths are at most 103 bytes) and a
port of your own, from the repository root:

```sh
R=$XDG_RUNTIME_DIR/h3d-bridges-mytask; mkdir -p -m 700 $R; rm -f $R/*.sock
(cd game && node tools/fixture-server.ts --socket $R/a.sock --fixture demo-m6 --simulate) &
(cd game && node tools/fixture-server.ts --socket $R/b.sock --fixture demo --simulate) &
printf '%s\n' '{"active": "a0a0a0a0a0", "bridges": [' \
  "{\"id\": \"a0a0a0a0a0\", \"name\": \"Office A\", \"kind\": \"local\", \"socket\": \"$R/a.sock\"}," \
  "{\"id\": \"b0b0b0b0b0\", \"name\": \"Office B\", \"kind\": \"local\", \"socket\": \"$R/b.sock\"}," \
  '{"id": "c0c0c0c0c0", "name": "Nowhere", "kind": "ssh", "host": "nobody@bogus.invalid", "remote_socket": "/run/b.sock"}]}' \
  > $R/bridges.json && chmod 600 $R/bridges.json
go build -o $R/h3d-helper ./cmd/h3d-helper   # and a game/dist (make build, or make e2e built one)
$R/h3d-helper -no-open -listen 127.0.0.1:PORT -bundle game/dist -bridges-file $R/bridges.json -token-file $R/token -local-socket $R/tun/bridge.sock
```

Open the URL it logs, ⌘/Ctrl+P → Switch bridge: Office A's city has five floors (`lab` among them), Office B's three,
and Nowhere stays `backoff` without holding anything up.

### Linux user service

The helper also runs on Linux (`POST /api/open` opens links with `xdg-open`; the game-window launch stays macOS only, so
start it with `-no-open`). As a `systemd --user` service, for example `ExecStart=%h/.local/bin/h3d-helper -no-open`,
`WantedBy=default.target`, the opener needs what `xdg-open` needs from a desktop session, in the **helper's own
environment** (the helper passes its environment on unchanged and invents none of it):

- `WAYLAND_DISPLAY` or `DISPLAY`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS` and `XDG_CURRENT_DESKTOP`;
- a `PATH` that finds `xdg-open` (from `xdg-utils`).

A user service gets the user manager's environment, not the compositor's. The compositor must import it at startup
(`dbus-update-activation-environment --systemd WAYLAND_DISPLAY DISPLAY XDG_CURRENT_DESKTOP …`, or `systemctl --user
import-environment …`; Omarchy does this). A helper that started **before** that import has none of it: restart it
(`systemctl --user restart h3d-helper`) or order it `After=graphical-session.target`. Check with `systemctl --user
show-environment` (the manager) and `tr '\0' '\n' < /proc/$(systemctl --user show -p MainPID --value h3d-helper)/environ`
(the helper). Without a session, `/api/open` answers `502` with `xdg-open`'s message. A browser that `xdg-open` starts
cold is a child of the helper and in its service's cgroup, so restarting the helper closes it.
See `docs/research/linux-browser-opening.md`.

## Rule: never serve the game to the Mac over plain `http://<tailnet-host>`

WebGPU only exists in a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts).
`http://<server>:<port>` is a remote, insecure origin, so Chrome **silently** falls back to WebGL2 — the game
still renders, but on the wrong backend, and any Metal/perf check is meaningless
(see [`docs/research/engine.verify.md`](docs/research/engine.verify.md)).

Always reach the server from the Mac through an SSH forward and open it on loopback:

```sh
ssh -o ControlMaster=no -o ControlPath=none -N -L <port>:127.0.0.1:<port> <user@server>
# then open http://127.0.0.1:<port> (or http://localhost:<port>) on the Mac
```

`ControlMaster=no` matters: a tunnel that becomes the shared ControlMaster takes everyone's multiplexed SSH sessions
down with it when it is killed (`docs/architecture.md` §2, §7). Check the debug overlay says `backend: webgpu`.

## Game

- The corner-office monitor: E at your desk sits down; E again opens Patience and Minesweeper. Esc returns to the
  seated office view; Stand up exits the monitor and chair. `src/games/` owns the pure draw-one Klondike and beginner
  Minesweeper rules; `ui/deskGames.ts` owns their controls and independent in-memory games, retained across game
  switches and visits to the desk until the page reloads. Patience supports click-to-move stacks, stock recycling and
  undo; Minesweeper has a safe first reveal, flood fill, flags and chording. `e2e/desk-games.spec.ts` covers entry,
  keyboard ownership, progress, exit and both UI themes at desktop and narrow widths.

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
- #124 keyboard: `src/input/shortcuts.ts` is the one table of the floor and city keys (chord, exact modifiers, the scopes it is
  live in, what it does): `Game.onKey` dispatches from it (`findBinding` with the scopes `activeScopes()` says are live; a
  handler for each id is a compiler-checked `Record`), `ui/shortcutsDialog.ts` (the `?` reference: groups, ⌘ or Ctrl, keys as
  `navigator.keyboard.getLayoutMap()` labels them), `docs/shortcuts.md` (written from it by `shortcuts.test.ts`:
  `H3D_WRITE_SHORTCUTS_DOC=1 make game-test` after a change) and the hint lines and top bar titles (`keyName(id)`) all read it. Add a key
  there, not in `onKey`. `shortcuts.test.ts` fails on two bindings on one chord in overlapping scopes, a binding missing from the
  reference, Alt or a browser-reserved chord, and a seated chord that drifted from `laptop/keys.ts`. Rules: single keys pause while a
  field has focus (`input/typing.ts`, WCAG 2.1.4; `e2e/h124-fields.spec.ts` types every bound character into each kind of field),
  only a modifier chord (Ctrl/⌘+/) fires from one, letters match `e.code` (WASD's choice) and `?` `,` `/` match `e.key`, nothing
  fires on auto-repeat or during composition, and no seated key is a help key (Esc, then ?). T / Shift+T pick a worker, desk
  or prop without aiming (`OfficeView.keyTargets`, `App.cycleTarget`: the walker turns to it and it stays the target until you
  move, turn or press Esc); Page Up / Page Down / Home look up, down and level (`Walker`).
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
  building you are in first, oldest `status_since` first, and where to stand facing a worker; #100's inbox, `inbox.ts`: the same
  order without the building tier, a freelancer's done left out unless Settings says, and a row's reason, `Building › floor` and age), quick replies
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
  zone, from the page's overrides, the settings and the browser; see "Day and night" below); #98: what a desk monitor shows
  of its worker's `activity` (`activity.ts`: an unknown kind is `working`, a label that disagrees with the status is not
  shown, which view a monitor is in (`glance` / `card` / `image` / `rest`), the card's word, detail, waiting badge and
  pose, the elapsed counter's text and glyphs) and the `waiting` display status (idle or done, waiting on its own
  background tasks: its own band row and HUD count, never idle, never in N's queue); #118: the floor overview's tree
  (`overview.ts`: orchestrators over their freelancers, ghost rows, Unlinked, the order that never follows a status,
  each row's light, ticket, task, now and since, the top bar's counts as items; `layout.ts` `overviewScreenBox` sizes
  the lounge wall's screen); #64 schedules: the bridge's scheduled agents (`schedule.ts`: `ScheduleBook`, the dialog's
  sections, lateness past the 5-minute grace, the toasts, the form's checks and spec, refused commands in words) and the
  form's time (`scheduleTime.ts`: relative durations, wall clock in a given zone or UTC, Temporal's `'compatible'`
  disambiguation without Temporal). Pure logic, covered by vitest.
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
  #98: the desk monitors' activity cards (`monitorCards.ts`: every card of a floor one instanced draw: the mascot from
  one sprite sheet, its frame flipped in the shader from a time uniform and the desk's row / phase attributes, frame 0
  under reduced motion; the word and detail a text atlas cell drawn only when they change, uploaded at most every
  300 ms; the elapsed counter glyph indexes of a static atlas, written once a second; an image letterboxed over a
  caption strip, its textures counted) and the mascots (`mascotArt.ts`: an orange crab for Claude, a white and teal
  cloud with a `>_` face for Codex, a pose per kind and a resting one, 6 frames each, pure pixels drawn once;
  `H3D_MASCOT_SHEET=1 pnpm -C game exec vitest run src/render/mascotArt.test.ts` writes `test-results/mascots.png`).
  #86: `toonSun.ts` (every toon material lights with it: faces turned away from the sun stay flat and take no shadow from the sun's
  shadow map; `normalBiasFor` sizes the suns' `shadow.normalBias`). #118: `overviewScreen.ts`, the lounge wall's
  floor overview (a header canvas and a tall board canvas seen through a scrolling window, a cover layer for the blink:
  canvas work only when what it shows changes; `wallPlan` and `scrollAt` are pure).
- `src/laptop` — M5 screens and sitting at a worker's screen (M6b: on its desk monitor): `watches.ts` keeps the connection's
  `terminal.watch`es in step with what the game wants (a full frame first, a gap re-watches, `unknown_command` turns
  screens off with the reason), `terminal.ts` is one xterm.js 6 terminal per live screen (never opened: only its VT
  parser and buffer) painted by `paint.ts` into a canvas that is the monitor's texture (M6b: standing, the glance view,
  the last lines that say something, 22 columns × 5 lines, big, bold and lifted to 4.5:1, so it reads from the aisle,
  without the agent's footer: #98, Claude Code's statusline and mode line under its input, Codex's hints under its
  composer, each only in its own shape at the bottom and only under a mode line or hint row (a statusline alone, in
  Claude Code's default mode, stays: it looks like output), so output that looks like a footer in part stays;
  seated, the whole terminal), `keys.ts` maps a keydown to herdr
  keys and orders input (one command in flight, what is typed meanwhile goes in the next `worker.keys`), `index.ts`
  plans and ties it together; #98: `monitors.ts` gives every desk its activity card, resting mascot or glance once per
  plan (a covered desk's terminal is not watched; seated and packing-up desks keep their screens) and fetches the
  images of the few desks near you (`transcript.image` by hash, chosen like the live screens); the preference is
  `h3d.monitors` (`ui/monitorPrefs.ts`, Settings → Display → Desk monitors: Activity | Terminal). #116: `h3d.hire.goto` (`ui/hirePrefs.ts`, Settings → Display → Go to a new hire after hiring). #74: the seated watch asks for `fullscreen` (the bridge zooms the pane's herdr tab), `watches.ts`
  keeps its zoom state (the ack's `zoom`, `terminal.state`, `terminal.zoom`; a bridge without them: no chip, no error),
  `fullscreen.ts` (pure) turns it into the seat bar's chip (`Fullscreen` / `Split pane 60×40` / `Fullscreen unavailable`),
  the preference is `h3d.term.fullscreen` (`themePrefs.ts`; off is sent as `fullscreen: false`, which only follows the
  pane, and the ambient laptops send no field); #175: a narrow (split) pane at 100% is its whole grid, letterboxed
  (`paint.ts` `viewport`: only the user's zoom grows the cells). #176: sitting opens the full-window seated workspace
  (`ui/seat.ts`, the seat bar grown into it: header, notices, content area, keys; the game behind it inert and drawn at
  the covered rate) and its terminal is a real, opened xterm 6 (`seatTerm.ts`, with fit 0.11.0, web-links 0.12.0 and
  unicode11 0.9.0; its pure rules in `seatTermLogic.ts`): it fits its area at a fixed font size (the preset's mono × 1.2
  × the zoom), and that grid is the seated watch's `control` grid and its debounced `terminal.resize`; the wheel goes
  to `terminal.scroll` and `terminal.history` drives the "N lines up · Back to live" button; Ctrl/⌘+click opens an
  https link through `App.external`; Ctrl+Shift+C (⌘C) copies its selection. It never types (`disableStdin`, no
  `onData`, `swallowReplies`): every key is still `seatedKey` and the lanes. A control watch keeps its process (no
  restart for a new fps or grid; a frame gap asks for a full frame with a same-size resize); read only (another
  client owns the pane) it shows the pane at its own size and the #74 chip ("Zoom herdr tab") is back; while the seat
  owns the pane there is no chip and no zoom. The simulator plays the controller (`simcontrol=old|none|busy`,
  `sim.write` raw text on a screen, `sim.terminal` what a watch has). The simulator plays the zoom with `simzoom=old|single|split|headless`
  (`tools/fixture-screen.ts`; `sim.unzoom` is the human unzooming), and `simscreen=narrow` puts a split pane's 60×40
  screen (`fixtures/screens/narrow.jsonl`) on every laptop. #57: `askCard.ts` is the question card of the transcript view (the one in the questions'
  sheet while the worker waits, #187: `questionSheet.ts`, and its timeline entry), styled in `transcript.css`. #59: `paint.ts` draws each
  glyph in its own cell (no ligatures, no fallback advance moving a column) in the preset's font and colours, box
  drawing / block elements / braille as shapes (`glyphs.ts`), and seated at the zoom (`viewport`: the letterbox below
  100%, above it the pane's bottom-left, moved to keep the cursor in view); `keys.ts` `zoomKey` is Ctrl + = / + / − / 0 and `LOOK_KEY` Ctrl+, (the keyboard to the terminal's preset and zoom). Which laptops are live is `src/world/screens.ts` (pure, vitest); the textured planes and
  the frozen-screen atlas (one instanced batch) are `src/render/screens.ts`; the seat bar is `src/ui/seat.ts`. Recorded
  screens for the simulator are `fixtures/screens/{agent,shell,narrow}.jsonl` (real `herdr terminal session observe` output of
  synthetic screens, made by `node tools/record-screens.ts` in a throwaway `h3d-m5screen-*` session); `sim=1` replays
  them for `terminal.watch` (`tools/fixture-screen.ts`: an agent's recording for a worker with an agent, the shell's
  otherwise, each from its own point, looping; at most `fps` frames a second, diffs in between concatenated),
  `worker.keys` echoes what was typed (the screen first jumps to the end of its recording), and watches close on
  `worker.removed`, a floor going to sleep or a new pane; `sim.watches` (the simulator's own, not a bridge command)
  answers this connection's watch count. #52: `sim.swap {id, pane: true}` gives a worker a new pane (its watch closes
  with `pane_changed`), `sim.swap {id, name?}` closes its workspace and seats a new worker at its desk in the same
  observation (a new id and pane, no walk-in); `hold: <ms>` holds the new pane's first frame back.
- `src/ui` — the HUD (DOM over the canvas) and the M3 panels (`panels.ts`: elevator, buildings, floor settings,
  confirmations; modal `<dialog>`s that re-render live and keep focus); M4: the hire dialog (`hire.ts`) and the
  send-home dialog (`sendHome.ts`), styled in `hire.css`; M6: the start-run dialog (`startRun.ts`, the empty desk's
  "Hire orchestrator" tab from `deskTabs.ts`, the top bar's Run and Presets from `startButtons.ts`) and the team presets
  panel (`presets.ts`), styled in `start.css`, and the prompt bar's crew line (`crewBar.ts`, `crew.css`); #59: the
  two presets (`themes.ts`: typed constants, the zoom's clamp / step / reset; #172: Ubuntu and Quiet, a stored `terminal` or `paper` migrates in `themePrefs.ts` to `ubuntu` or `quiet`; the accent as text is its own `blue-text` token, `blue` is for fills and rings); Ubuntu's mono stack is Ubuntu Mono, H3D Box Ubuntu and three `H3D Symbols Ubuntu` `local()` faces sized to its 0.5 em advance (`fonts/ubuntu.css`; `e2e/h172-ubuntu.spec.ts` measures a symbol row against a row of letters at 70 to 200 %), and a filled control's colour rule must out-rank `.tx button`, so it sits under `.tx`, what the
  seated views remember (`themePrefs.ts`: the transcript's and the terminal's preset and zoom apart,
  `h3d.theme.{transcript,terminal}`, `h3d.zoom.{transcript,terminal}`, and `h3d.transcript.hideTools`, guarded like
  `limitsPrefs.ts`; M17's `timePrefs.ts` too: the timezone and latitude of About's Day and night) and the loader (`themeLoader.ts`: the transcript's preset as custom properties on the root, fonts
  from `src/fonts/` on first pick, the terminal told once its preset's faces are in; defaults in `themes.css`); the
  seat bar holds the terminal's preset and zoom (`seat.ts`); the shipped fonts (`fontCredits.ts`: the credits panel's
  rows and each one's licence file, which the build writes in full into `FONT_LICENSES.txt` next to the bundle); M5: the prompt overlay (`prompt.ts`, P: a modal like the M4
  dialogs, low on the screen), the Changes panel (`changes.ts`, C: a non-modal side panel in the HUD under the top bar,
  so the floor stays in view and walkable; its diff is drawn a window of lines at a time), the look-at bar's usage and
  Approve / Deny (`promptBar.ts`), styled in `m5.css`, and the seat bar (`seat.ts`, `seat.css`); #100: the inbox chip under the plan-limits plate
  that opens into its list (`inbox.ts`, `inbox.css`; a row's `App.goToWorker` teleports and sits you at that terminal) and the one rule of the corner
  both follow (`corner.ts`: what makes them step aside), what it remembers (`inboxPrefs.ts`, `h3d.inbox`), Settings →
  Notifications (`notifySection.ts`: desktop notifications and their permission, the chime and its Test) and its pings; #118:
  the floor overview page (`overview.ts`, `overview.css`: the `inset: 0` layer over everything, its grow out of the
  wall screen, the tree's keys, live rows; #145: the rows kept when the same view opens again, a row off the board's
  view skipped by `content-visibility`, endless motion on opacity and transform only: `e2e/h145-overview-rows.spec.ts`,
  and the page's own cost traced by the opt-in `e2e/h145-overview-perf.spec.ts`, `H3D_PERF=1`) and its collapsed groups (`overviewPrefs.ts`, `h3d.overview.collapsed`), and
  Settings → Floor overview summaries (`digestSection.ts`, its state in `world/digestSettings.ts`); #64 schedules: the scheduled agents
  dialog (`schedules.ts`: Upcoming, Needs attention, Scheduled successfully, All floors; `openSchedules({floor?, allFloors?,
  focus?})` in `app.ts` is every entry point's) and its create / edit form (`scheduleForm.ts`, shared by "New", Edit and the
  transcript's "Schedule follow-up…"), styled in `schedules.css`; `Hud.toast`'s optional action (a click opens what it is about); the
  desktop notification of a new entry with the game in the background (`desktopNotify.ts`; when one pings,
  `world/inboxPings.ts`: settle delay, snapshot silence, burst cap); #108 round 3: the review of a prompt's possible
  secrets (`secretsReview.ts`, `secretsReview.css`: the whole prompt in an edit-refusing `contenteditable`, a highlight
  per match, the strip of the match in hand), the send flow every composer goes through (`secretsFlow.ts`: scan, review,
  `worker.prompt` with `secrets`, a stale review reviewed again; the P overlay, the laptop's prompt box and a paste into
  its terminal use it; round 4: every other composer, with the action word, stored prompts and a review per text, its
  "Review secrets" control and chord shared; pack up's check with the review is `packupSend.ts`) and Settings → Workers
  → Prompt secrets
  (`promptSecretsSection.ts`); the switch and the review's model are `world/promptSecrets.ts`. Hidden, named hooks
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
  with 2 blockers; and a run with every other freelancer state, each verdict and an `input_required`), `demo-m118` (#118: demo-m6
  with the overview's lines: the runs' issue titles and URLs, every agent's `digest`), `demo-m188` (#188: demo-m118 with
  a run across two floors, Juniper's working coder Poppy on pastry, and Quince in the scratchpad whose orchestrator is
  gone), `demo-h171` (#171: demo-m5's world; with `sim=1` its transcript is code changes in every shape and state,
  see below), `perf-floor60`, `perf-floor96` (96
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
  (`verdict` / `blockers` / `input_required` / `summary`) and closes it; `simcrew=<ms>` plays that round by itself;
  #64 schedules: `fixture-schedule.ts`, the scheduled agents, whose rules are at its top (the spec's checks,
  the state rules and their errors, the fire through the simulator's own hire, `simschedules=<n>`, `sim.schedule_fire`);
  #93: `fixture-hirepreset.ts`, the hire presets, whose rules are at its top (the bridge's checks and codes, scoped
  names, `simhirepresets=<key>` sharing a key's presets, a deleted virtual floor's own presets going with it);
  #213: `fixture-interpret.ts`, `hire.interpret` for the dictation bar, whose rules are at its top: no resolution rule of
  `internal/hireintent`, one JSON-mode call through the AI integration (`fixture-ai.ts`) to the LLM the game set up, its
  answer `{intent, reason?, hire?}` checked (shape, the task's span) and passed on with the bridge's `sources`, errors as
  the bridge's acks (`not_ready` with no LLM, `provider_failed` for a non-200, `timeout` past 35 s or what
  `sim.interpret {timeout_ms}` sets, `bad_answer`, `bad_span`, `bad_pending`), `bad_request` only for its args), dev WebSocket → unix-socket proxy,
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
| `ws=<url or path>` | bridge endpoint (default same-origin `/ws`); fixtures take `?play=none\|all\|<ms>`, and `sim=1` to simulate commands (`simms=<ms>` between wake/sleep and hire/send-home steps, default 600; `simfail=wake_failed\|sleep_failed\|hire_failed\|fire_failed` fails the next one, `simfail=fetch_failed` makes origin unreachable for the whole run; `simcap=<session>:<soft>:<hard>[,…]` caps floors; #51: `simmodels=<n>` adds n Claude models to the hire options (a long model list); M6: `simcrew=<ms>` walks a scripted freelancer in and out; M3d (`tools/fixture-logo.ts`, `tools/logo-art.ts` draws the made-up test logo; no third-party logo ships): `simlogo=<key>` lets `/logo/<building>?simlogo=<key>` reach this connection's world, `simlogos=1` starts every building with a made-up logo, `simfail=logo_missing` makes the images 404, `simfail=logo_busy` fails the next upload; #108 (`tools/fixture-secrets.ts`): `simsecrets=<key>` shares the "Review prompt secrets before sending" switch between a key's connections, `simsecretson=1` starts it on, `simsecretsdir=none` plays a bridge host without a private runtime directory, `simfail=no_secrets` a bridge before it, `simfail=secrets_review_stale\|secrets_review_required\|secrets_unavailable\|secrets_review_off` refuses the next command that carries a review that way (any route: round 2 gates them all, the files' paths have the bridge's shape and `prompt_secrets` its `dir`), `simfail=secrets_pending_stale` the next one that carries a `secrets_pending` (an expired hand-over), `simfail=no_revoke` plays a bridge before round 5 (no `prompt_secrets.revoke`, no `Worker.secret_files`), `simfail=old_wrapup` one whose `worker.wrapup` refuses `secrets_pending` as an unknown field) |
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
#139 completion: `mountComposer({ complete: { sources, bounds? } })` turns on a suggestion popup under the caret
(`complete.ts`: token detection and the source interface, pure; `completion.ts`: the popup and its keys). Opt-in: without
`complete` the composer, its keys and its DOM are unchanged; the popup's DOM is made on its first open. The transcript's
prompt box opts in: #140 gives it the `/` source (the worker's commands and skills, see the transcript section), #141
the `@` source (the worker's files, see below); #39 the Hire, Start run and Prompt dialogs too (see #39 below). A
token is a trigger (`/` or `@`) at the start of the text, after whitespace or right after a chip (`/usr/bin`,
`a/b`, URLs and emails never open one), up to the caret: a `/` query has no whitespace; an `@` query may hold spaces
(file names) but ends at a newline, a chip or 80 characters. The nearest trigger before the caret decides; a pick
replaces the trigger and the whole word the caret is in. A source is `{ trigger, label?, items(query, signal), render(item),
insert(item, token, text) }` (`text`: the draft's text): `items` returns the rows or a promise of them (each new query aborts the previous `signal`
and a reply that is not the latest is dropped; pending shows "Loading…" or keeps the rows dimmed, `aria-disabled`,
none active and none pickable by key or click until the reply, empty "No match", a rejection "Could not load
matches."); `render` returns a Node or a string; `insert` returns a `ReplaceSpec` `{ text, chip?, start?, end? }` (default
range: the token), applied with one `Draft.replace` (with `chip`, #141: one `Draft.insertParts` of the atomic chip then
`text`), so one undo takes the pick back and the caret lands after it. #140, optional, for a source whose items live elsewhere: `available()` false opens
no popup (and closes an open one when the source says it changed), `opening()` hears that a session would open (to
refresh), `subscribe(changed)` says the items changed (an open session asks its query again, the active row kept by
`key(item)`), `footer()` is a note under the rows (`.cmp-pop-note`). #39, optional: `loading()` words the pending
state with no rows ("Loading skills…"), `failure()` the error, and `retry()` puts a "Try again" button (`.cmp-pop-retry`,
not focusable, a press keeps the editor's focus) by a failed load: it calls `retry` and asks the query again (Enter
still closes a failed popup). `world/rank.ts` `rankByName` is the filter
for named items: prefix, then word start (after `:`, `-`, `_`), then substring, stable within a tier, with the matched
characters for the row to highlight. A session opens only when text is typed (an `input`, an IME commit) into a token;
it follows the caret inside the token and closes when the caret leaves it or is scrolled out of the editor's visible
box or the bounds (no clamped popup pointing at nothing; scrolling back does not reopen it, and text typed out of view
gets one frame for the browser to scroll the caret back), on a pick, Esc, blur, `setBusy` /
`setDisabled`, `setDraft`, `dispose`, and while an IME composes (`compositionend` re-evaluates). Keys while open: ↑ ↓
move (wrapping), Tab and Enter pick; with nothing to pick (no rows, or an older query's dimmed rows) the arrows and Tab
are the editor's and Enter only closes; Esc closes the popup and is stopped there (the dialog, the transcript and the
seat never see it); Shift+Enter and every other key are the editor's as before, as is
every key while it is closed (`dialog.complete` in `input/shortcuts.ts` lists them). The rows are `role=option`
in a `role=listbox`, never focusable (a press on the popup keeps the editor's focus); the editor stays a multiline
`role=textbox` and, while open only, has `aria-autocomplete=list`, `aria-controls`, `aria-expanded` and
`aria-activedescendant`. Placed against `.cmp` at the trigger, under the caret's line or above it when there is no room
below, inside `bounds()` (default: the composer's dialog, else the window; the transcript passes its root).
`/?composer-demo` mounts it with stub sources (`/` commands at once; `@` files after `stub.delayMs`, per query
`stub.delays[q]` for a late reply, `stub.fail` to reject) for `e2e/composer-complete.spec.ts`.
#141 file chips: a chip is an image or a file (`model.ts` `Occurrence = ImageOccurrence | FileOccurrence`, `Doc.chips`;
both are one U+FFFC in `Doc.text`, so offsets, ranges, the arrows, Backspace/Delete beside a chip and undo/redo treat
them alike). A file chip holds its checkout path (relative, `/`-separated, a folder without a trailing `/`) and no
resource: nothing uploads, and image numbering (`[Image #n]`, `numberOf`, the failed-upload numbers), `MAX_IMAGES` and
`resourcesOf` count images only. Drawn as `.cmp-chip.cmp-file` (`data-kind=file|dir`): the file or folder icon and the
basename, `title` the full path, `role=img` named "File <path>" / "Folder <path>", nothing to press; removing one says
"File <path> removed.". `Draft.insertParts(start, end, parts)` puts text and file chips (`{ kind: 'file', path, dir }`,
fresh occurrence ids) in as one undo step; `Draft.hydrate(parts)` makes them the whole document with no history.
Serialised (`serializePrompt`, `Draft.resolve()`) as `@path`, or `@"path"` when the path holds whitespace (Go's
`unicode.IsSpace` exactly: NEL included, U+FEFF not, unlike JavaScript's `\s`), the same for every harness (the bridge strips it for Codex, #138, and leaves a path it
cannot find as it is: a deleted file still goes as text, no error); `joinMentions` puts a space before a mention that
would start mid-word (anything but whitespace or `([{"'` before it) and after one that text follows without a space.
Those bytes count toward the cap (`maxBytes`: 16 KiB for `worker.prompt`). A path with `"`, CR, LF or NUL cannot be
written so the bridge reads it back (no quote escaping, no line break in a quoted mention): `filePathProblem` keeps it
out of the popup, storage and paste. Clipboard: a copy or cut writes `text/plain` (the text with `@path` mentions,
images left out) and, when the selection holds a file chip, `application/x-h3d-composer+json` (`CLIP_TYPE`,
`{ v: 1, parts }` of `SavedPart`s); a paste reads that type first (validated with `readSavedParts`; anything off falls
back on the text), so file chips paste back as chips, one undo step. Images are not carried (as before).
`field.ts`: `hasContent` counts file chips, `markedText` writes their mentions; the hire dialog and the P overlay have
no `@` source and are unchanged.

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
severity bar) in the gutter right of the dialog, or, when the viewport leaves under 27 px there, away completely (a snug tab from 27 px, the full one from 48 px) (the hire
dialog, a near-full-screen sheet since #51, is one of them: its own limits line is inline). A click on
the tab or Shift+L then *peeks* the expanded panel above the dialog without touching the saved state (Shift+L again, the
plate's header, a click elsewhere or closing the dialog ends the peek; a meter hidden from About stays hidden); when the
dialog closes the plate is exactly as it was. The small centred dialogs (confirm, start-run, send-home, …) keep the
plate as it was, above them. Seated at a worker's laptop (E, #53) it is the same, measured against the monitor's glass (the
terminal's and the conversation's alike): the edge tab in the gutter right of the glass (the full 32 px one from 48 px of gutter, a snug 22 px one down to 27 px, which is what 800x600 to 1280x900 leave), else away (a phone-width glass fills the view); a
click on the tab (or Shift+L, anywhere but the terminal's own input, where it types an L; with no tab, Shift+L from the
conversation) peeks the panel, and standing up gives back the docked or open plate the saved state says. The #147 command palette is a small
dialog but gets the same treatment on any view (`dialog.palette[open]` is in `SCREEN`; it keeps a 56 px gutter; the tab is measured against the palette alone, so it shows over the hire sheet and the glass too, and Shift+L there is an L in the palette's field: click the tab). The Changes panel still makes it step left.

#138 Codex profiles: the bridge reads the Codex limits once per Codex home folder (docs/protocol.md "Codex profiles").
To have a second profile locally, sign a second home in: `CODEX_HOME=~/.codex-work codex login` (the folder must exist
first: `mkdir -p ~/.codex-work`); the bridge finds every `~/.codex-*` folder with an `auth.json` at its next poll, no
restart. A folder elsewhere is added in Settings → Codex profiles (Add folder). Tests: `go test ./internal/codexaccount
./internal/limits ./internal/server -run 'Codex|Profile|Limits'`, `game/src/world/limits.test.ts`,
`ui/limits.profiles.dom.test.ts`, `ui/codexProfilesSection.dom.test.ts`, `tools/fixture-codex-profiles.test.ts`. On the
simulating server, `simcodexprofiles=2` plays two visible profiles (`codex`, the default, fresh; `work`, stale from 50
minutes ago) plus a hidden one (`old`) and an added one not signed in (`spare`); `simcodexprofiles=1` only the default
(the meter as before profiles); without it the bridge is one from before profiles. For a UX look: `make dev`, then
`?ws=%2Ffixture%2Fdemo-m5%3Fplay%3Dnone%26sim%3D1%26simusage%3D0%26simcodexprofiles%3D2&floor=herdr-3d`: the meter
(click it for the panel) and Menu → Settings → Codex profiles (an added path ending in `/nothing` plays the bridge's
"no folder there").

#139 hiring on a Codex profile (docs/protocol.md "Hiring on a Codex profile"). Tests: `go test ./internal/codexaccount
./internal/codexapp ./internal/herdr ./internal/store ./internal/usage ./internal/server -run 'Profile|Prepare|Launch|Account|Control|RootThread|UsageCodex'`,
`game/src/world/codexProfiles.test.ts`, `ui/hire.profile.dom.test.ts`, `ui/hirePresets.dom.test.ts`, `ui/seat.test.ts`,
`tools/fixture-codex-profiles.test.ts` and `e2e/h139-codex-profile.spec.ts`. On the simulating server
`simcodexprofiles=2` also gives a Codex hire the "Codex profile" field (`codex`, the default, picked; `work`; `spare`,
not signed in, shown and not pickable; the hidden `old` not offered), and seeds the seat's profile line: sit at Pixel
(Desk 2 of herdr-3d, on `work`), Sprocket (Desk 4, woken on `codex` after its profile went) or Bean (Desk 10, signed in
to another account). Same URL as above:
`?ws=%2Ffixture%2Fdemo-m5%3Fplay%3Dnone%26sim%3D1%26simusage%3D0%26simcodexprofiles%3D2&floor=herdr-3d`, then E on an
empty desk (Desk 6) and pick Codex, or sit at one of those workers. Both modes start with a global preset "Review on
old-work" on a profile that is gone: Hire preset → Use (or Edit) shows that it hires on the default. With
`simcodexprofiles=1` the dialog is as before, but for that preset's note.

#140 Auto (docs/protocol.md "Auto: the bridge picks the Codex profile"; set in Settings only, no flag or env). Tests:
`go test ./internal/codexaccount ./internal/store ./internal/server -run 'Pick|Rules|AutoIs|CodexProfiles|AutoHire'`,
`game/src/world/codexProfiles.test.ts`, `ui/codexProfilesRules.dom.test.ts`, `ui/hire.profile.dom.test.ts`,
`ui/hirePresets.dom.test.ts`, `ui/hiredToast.test.ts`, `tools/fixture-codex-profiles.test.ts` and
`e2e/h140-auto-profile.spec.ts`. On the simulating server `simcodexprofiles=2` takes Auto: the hire dialog's first chip,
picked for a new Codex hire; one rule (`github.com/acme/*` → work, which no fixture folder matches) and `codex` may be
used for anything, so a hire's toast says "Account: codex (the only profile that may be used for anything)". A
fixture folder's origin is `JeffreyVdb/<its name>`: add the rule `github.com/JeffreyVdb/*` → work in Settings → Codex
profiles → Auto rules and the next Auto hire lands on work by that rule. Same URL as above.

#167 sharing a profile's setup (docs/protocol.md "Sharing a profile's setup"). Tests: `go test ./internal/codexaccount
./internal/codexapp ./internal/limits ./internal/server -run 'Share|Drift|MoveSkill|SetupNote|SeedHookTrust|AccountEqual|CodexShare|ProfileHire'`,
`game/src/world/codexProfiles.test.ts`, `ui/codexProfilesShare.dom.test.ts`, `ui/limits.profiles.dom.test.ts`,
`tools/fixture-codex-profiles.test.ts` and `e2e/h167-share-setup.spec.ts`; every Go test works on throwaway homes
(`t.TempDir()`), never on `~/.codex`. On the simulating server `simcodexprofiles=2` says the bridge shares: `work`
shares and has drifted (its config.toml replaced by a file, and a skill folder `infra` only on the default), the
hidden `old` shares and shows nothing, and `spare` does not share and holds its own config.toml. Same URL as above,
then Menu → Settings → Codex profiles: turn on "Share setup with codex" for spare (the confirm list, then the report),
Fix on work, "Move to ~/.agents/skills" on infra; the meter marks work's row "drifted".

#167 run profiles (docs/protocol.md "Run profiles"). Tests: `go test ./internal/store ./internal/server -run
'PresetRoleCodexProfile|TeamPrompt|RunPrompt|RunStartOrchProfile|RunStartTeam|PresetRoleProfiles|TaggedFreelancer'`,
`game/src/world/runProfiles.test.ts`, `ui/startRun.profile.dom.test.ts`, `tools/fixture-start.test.ts` and
`e2e/h167-orch-profile.spec.ts`. With `simcodexprofiles=2` the list says `runs`: Start a run → Hire orchestrator, switch
the orchestrator to codex, and the "Codex profile" chips appear under its effort; Presets → Edit shows them under each
Codex role, and a role on `work` puts "Codex profile work (CODEX_HOME=/home/u/.codex-work, …)" in the run's prompt
preview. Same URL as above.

M6 on the simulating server: presets and runs on any fixture (herdr-3d of demo-m4 has a suggested repo, pastry none);
`simfail=no_m6` plays a bridge without them. E.g. `?ws=%2Ffixture%2Fdemo-m4%3Fsim%3D1%26simms%3D300`.

M7 on the simulating server (`tools/fixture-boards.ts`, rules at its top): the boards of the floor you are on, from its
effective repo (`settings.repo ?? suggested.repo`; none: `board.watch` answers `enabled: false`). `JeffreyVdb/lab` and
`JeffreyVdb/herdr-3d` have a project (Todo / Doing / QA / Done), `JeffreyVdb/bench` (the `perf-boards` fixture) 100 issues
and 20 pull requests, any other repo no project (Open / Closed, no `set_status`). Lab issue #7 has a markdown body full of
script, handlers, `javascript:` links, svg, an iframe, a form and a tracking pixel: the sanitiser's fixture. Writes queue a
poll of the floor, as the bridge does. `sim.boards` (the simulator's own command, `simBoards(args)` in the hooks) merges a
PR (`{merge: id}`: gone from the open list, announced by the next poll, its issues closed and in Done), makes the next polls
fail (`{fail: "message"}`, or `head_moved` to make a merge answer `stale`; `{fail: null}` clears it), sets the rate limit
(`{rate: {remaining, reset_at}}`) or the paging flag (`{truncated: true}`), moves a card (`{card: {id, column}}`) or polls
(`{poll: true}`). #52: a project's cards carry `position` (seeded in the old urgency / closed order) and the board `order`;
`issue.set_status` takes `after` like the bridge; `{fail_write: "message"}` makes every `issue.set_status` fail
(`provider_failed`, null clears it) and `{no_refresh: true}` makes writes queue no poll (a late refresh). `simfail=no_m7` plays a bridge before M7 (every board command `unknown_command`). `open=none` in the page
URL makes "Open in …" record the page instead of opening a window. E.g.
`?ws=%2Ffixture%2Fdemo-m6%3Fsim%3D1%26simms%3D150&floor=lab`.

#184 on the simulating server (`tools/fixture-kaneo.ts`, rules at its top): Kaneo. `simkaneo=off` (default: nothing
saved), `connected` (https://kaneo.example.test saved, default workspace Studio), `unavailable` (a bridge without a
Kaneo client) or `old` (a bridge before #184); `simkaneoslow=<ms>` (default 1500) is how long the slow answers take.
Settings → Kaneo: any https address (`offline` in it: unreachable; http only to 127.0.0.1), a key starting `bad` is the
401 that may be a quota, `forbidden` a 403, `empty` reaches no workspace, `slow` answers slowly; any other key passes
with Studio, Home, Locked (its projects: 403), Empty (no projects) and Slow lane (its projects answer after
`simkaneoslow`: switch workspaces quickly to see a late list dropped). Floor settings → Issue tracker → Kaneo: Studio's
herdr-3d (HRD) and Website (WEB: a truncated board), Home's Garden; a project of another workspace or `gone` is
refused at save. A Kaneo floor's Issues overlay: Planned / To Do / In Progress / In Review / Done / Shipped / Archived,
no close, HRD-4's long description read on open. `sim.kaneo` (`window.__h3d.simKaneo(args)`): `{fail: "unauthorized"}`
pauses the board (a passing Test in Settings resumes it), `"forbidden"`, a message, or `null`; `{stale: true}` makes the
next placed move `stale` (409); `{poll: true}`. Hand to a worker / run.prepare on a task gives an `item` ticket.
`e2e/h184-kaneo.spec.ts` drives it. E.g.
`?ws=%2Ffixture%2Fdemo-m6%3Fsim%3D1%26simms%3D150%26simkaneo%3Dconnected%26simkaneoslow%3D1200&floor=lab&open=none`.

#57 on the simulating server (`tools/fixture-ask.ts`, rules at its top): `sim.ask {id, ask}` (`simAsk(args)` in the
hooks) makes a worker's agent ask (its card and the transcript's pending call), `{id, ask: null, answers?}` ends it as
the terminal would; `worker.answer_ask` answers it like the bridge (`stale`, `bad_request`, the ask gone and the call's
card answered before the ack); `simfail=answer_ask_failed` / `answer_unresolved`. `e2e/m16-ask.spec.ts` drives it.

#90 on the simulating server (`tools/fixture-followup.ts`, rules at its top): `followups.get` / `set` / `test` like the
bridge (the test really calls the AI integration's fakes), `sim.turn {id, text}` (`simTurn(args)` in the hooks) ends a
worker's turn with that message and runs the pipeline when the feature is ready (a `followup` upsert), and
`worker.answer_followup` sends the formatted answers as one `worker.prompt` (with `simecho=<ms>` it is echoed into the
transcript). `window.__h3d.followups()` is the feature's state. `e2e/followups.spec.ts` drives the settings and the card.
#60: `simfollowup=grill` seeds Pebble (demo-m5) with the incident's ten-question grill round as the bridge reads it
(`game/fixtures/followup-grill.json`), `simfollowup=fallback` with its fallback (Retry reads the round;
`fallback-fail`: it falls back again), no AI setup needed; `worker.retry_followup` and `worker.followup_message` work on
both. For a UX look: `make dev`, then `?ws=%2Ffixture%2Fdemo-m5%3Fplay%3Dnone%26sim%3D1%26simusage%3D0%26simfollowup%3Dgrill&floor=herdr-3d`
and sit at Pebble's laptop.

#66 on the simulating server (`tools/fixture-schedsuggest.ts`, rules at its top): `schedule_suggestions.get` / `set` /
`zone` and `worker.dismiss_schedule_suggestion` like the bridge; `simschedsuggest=on|off|incomplete|env|env-off|none`
fixes the setting's state with no models, `simsuggest=<key>` starts Zippy (demo-m5) with a finished rollout reply and
its suggestion (the chip; a dismissed or saved one stays gone across a reload with the same key), and `sim.suggest {id,
due_at?, title?, draft_prompt?}` gives any worker one on its current reply. `e2e/schedules.spec.ts` drives the chip. For
a UX look: `make dev`, then
`?ws=%2Ffixture%2Fdemo-m5%3Fplay%3Dnone%26sim%3D1%26simusage%3D0%26simschedsuggest%3Don%26simsuggest%3Dlook&floor=herdr-3d`,
sit at Zippy's laptop and switch to the transcript; Settings → AI → Schedule suggestions shows the state
(`simschedsuggest=incomplete` or `env` for the others).

#110 on the simulating server (`tools/fixture-packup.ts`, rules at its top): `packup.get` / `set` / `test` like the
bridge (the test runs a part of the labelled samples through the AI integration's fakes), and `packup.detect` cuts the
LLM's spans like `internal/packup` (exact substrings in order, never over an image, the bridge's 1.2 s bound, any failure no match); `sim.packup_lag {ms}` holds
its detect acks to test the game's own 1.5 s bound.
`window.__h3d.packup()` is the feature's state. `e2e/m110-packup.spec.ts` drives the settings, the P overlay and the
laptop's prompt box through the confirm.

#98 on the simulating server (`tools/fixture-activity-settings.ts`, rules at its top): `activity.get` / `activity.set`
like the bridge (Settings' "Classify unknown commands", `src/ui/activitySection.ts`: off by default, `incomplete` while
the AI integration's classifier is not ready, `capped` at the daily cap; absent with `simai=off`), and
`sim.activity_settings {env?, model_enabled?, calls_today?, cache_size?}` (`simActivitySettings(args)` in the hooks)
plays the environment's switch, the day's calls and the cache. `e2e/activity-settings.spec.ts` drives the section.

#83 on the simulating server (`tools/fixture-sim.ts`): `worker.wrapup` checks like `worker.fire` (a Claude or Codex
agent, a delete only on a clean tree) and arms the worker; `sim.wrapup {id, verdict: "clean" | "blocked" | "none",
reason?}` (`simWrapUp(args)` in the hooks) plays its transcript's result line: `clean` sends it home (`worker.removed`
`sent_home`), the others make it need you. `worker.wrapup.cancel` drops it. `e2e/m83-wrapup.spec.ts` drives the dialog
(delete preselected, Enter in the prompt, the confirm step), the desk tape and the toasts; the bridge's side is
`internal/server/wrapup_test.go` (real transcript files, the fake herdr floor: CLEAN to `worktree remove`, the decision
table, strict delete, restart).

#98 on the simulating server (`tools/fixture-activity.ts`, rules at its top): `sim.activity {id, activity?, status?,
image?}` (`simActivity(args)` in the hooks) sets a worker's activity as the bridge would send it (`worker.activity`;
null clears it), its status first when asked, or an image it looks at (a real PNG; `via: read | view_image | exec` for
a Claude `Read`, Codex's `view_image` and a code-mode `exec` calling `tools.view_image`), whose hash `transcript.image`
then serves without a watch; `simactivity=demo` labels every working agent on start (one idle Claude waits, one Codex
looks at an image), `simactivity=all` every working one. `window.__h3d.monitors()` is what each monitor shows and the
cards' ledger, `monitorRect(id)` where its terminal area is on screen. `e2e/m98-monitor.spec.ts` drives the card, the
waiting state, the three image cases, reduced motion, the preference and perf-floor60's canvas and upload counts. E.g.
`?ws=%2Ffixture%2Fdemo-m5%3Fsim%3D1%26simactivity%3Ddemo&floor=herdr-3d`.

M16 on the simulating server (`tools/fixture-transcript.ts`, rules at its top): sit at any agent for its conversation
(#98: what you sit down to at a Claude or Codex worker; Ctrl+Esc swaps it for the terminal and back, and a worker you
left in the terminal opens there next time, remembered per worker in `h3d.seat.terminal`; a plain shell, another
harness, a bridge without transcripts or a view that does not load open the terminal; e2e specs of the terminal sit
down with `leftInTerminal` / `seatMode` from `e2e/game.ts`). `transcript.watch` answers a demo timeline of every item
kind in the bridge's shape, the demo's Agent call pages the bridge's own output for its subagent fixture, and `sim.transcript` (`simTranscript(args)` in the
hooks) pushes items or updates to a watch (`{id, items, updates}`) or closes it (`{id, close: "session_changed"}`);
`simfail=no_m16` plays a bridge before M16. #171: `simtx=<name>` (default: the fixture's name) gives every watch another
timeline when one has that name: `demo-h171` (`?ws=%2Ffixture%2Fdemo-h171%3Fsim%3D1`, sit at Nibble) is the bridge's
own output for its #171 Claude fixtures (`fixtures/transcript/claude-changes.json`: Edit, Write create / overwrite with
and without hunks, Bash one / several files, files without a diff, incomplete, shared, skipped, failed, denied,
interrupted), a Codex patch, one still running and an Edit whose diff the list cut (`transcript.item` answers it whole);
`e2e/h171-changes.spec.ts` drives it. #21: `simtx=demo-h21` (`?ws=%2Ffixture%2Fdemo-h171%3Fsim%3D1%26simtx%3Ddemo-h21`, sit
at Nibble) is the bridge's own output for its Codex patch fixtures (`fixtures/transcript/codex-changes.json`: exec
scripts and the patches they ran, direct and legacy patches, failed, declined, renamed, interrupted, still running),
half of it older than a watch's window (the screenshot's "Jump to message" pages it in); `e2e/h21-codex-changes.spec.ts`
drives it. Code changes show under each call's header (`changesBlock` in
`laptop/transcriptRender.ts`), "Code changes" in the strip folds them (`h3d.transcript.showChanges`). The demo's `Read` of a PNG shows its two thumbnails under its collapsed header, and still does with Hide tools on (#70). #59: the view's top strip has the transcript's preset (two swatches:
Ubuntu, Quiet), Hide tools, the context meter (#101: `world/usage.ts` `contextMeter`, `TranscriptView.setUsage`, fed by `TranscriptMode.usageSeen`; `e2e/m101-context-meter.spec.ts`) and A− / 100% / A+; the seat bar has the terminal's own preset and zoom. Ctrl + = /
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
#140: `/` in the view's prompt box (at the start or mid-sentence, after whitespace) lists the worker's slash commands
and skills (`worker.commands`, #136). `laptop/commandCatalog.ts` keeps one list per worker for the page's life (at most
64; #39: one `CommandCatalogs` for the app, shared with the Prompt overlay and the hire dialogs, whose lists are keyed by
their context, `CommandCatalogs.context`): asked when the transcript view mounts (`TranscriptMode.sit(id, name, canRead, harness)`, a Claude or Codex harness
only) and again when the popup opens, one ask at a time; the last list shows at once and the rows follow the refresh.
`laptop/slashCommands.ts` is the source: `rankByName` on the name as you type; a row is `/name` (mono, matched letters
in the preset's sun), the argument hint dimmed, the description's first line cut with an ellipsis (its whole text is
the tooltip), and the kind (`command`, `skill`, `custom`); a pick puts `/name ` in as plain text (a space already after
the word is taken instead of adding one). A Codex skill is offered as `/name` too (the bridge sends `$name`, #138), and
the footer says "Codex: skills are sent as $name"; #39: with nothing else to say it says "Skills and commands · type @
for files" (`/` is the harness's catalog only, global skills too; files are `@`'s). States: no list yet "Loading
skills…"; a failed first ask "Could not load skills: <why>." with "Try again" (the next popup asks again too); a failed refresh keeps the rows with "Could not refresh: the list may be out of
date"; `partial: true` the built-ins with "Partial list: only the built-in commands so far"; `invalid_state` /
`unknown_worker` (no Claude or Codex agent, an asleep floor) no popup at all, asked again at most every 10 s; a worker
waiting on a question disables the box, so no popup. Terminal-only built-ins (the bridge's table,
`internal/harness/terminal.go`: Claude's `/usage`, `/status`, `/config`, `/mcp`, `/help` and a bare `/model` open a
dialog in the terminal and write nothing to the transcript; Codex's `/status`, `/diff`, `/pwd`, `/ps`, `/mcp` print
there only) carry a "terminal" badge (`terminal` on the row; its tooltip and the row's text say where the result
shows, and a bare-only one says that with arguments it runs here). When the ack of a sent prompt says `terminal: true`
(the bridge decides from the typed text, so aliases like `/cost` and a prompt typed by hand count too, and `/model
opus` does not), `TranscriptMode` drops its pending row (the transcript will show nothing of it), says "Sent to <name>:
it shows in the terminal" and switches the seat to the terminal, not remembered as where you left that worker (Ctrl+Esc
goes back). The simulator answers `simCommands` (`tools/fixture-panels.ts`, rows marked like the bridge's) and acks a
terminal-only prompt (`simTerminalOnly`) with no turn; `e2e/h140-slash-commands.spec.ts` drives a Claude and a Codex
worker (mid-sentence pick, Esc closes only the popup, Enter sends when closed), a blocked one, and the badge and the
switch (`/usage` shows the terminal, `/model opus` does not).
#141: `@` in the view's prompt box searches the worker's checkout (`laptop/fileSearch.ts` `fileSource`, label "Files and
folders"): each query goes to `worker.files` (#137, `limit` 30) after a `DEBOUNCE_MS` (40 ms) pause that an aborted
query never outlives, and the popup keeps the last rows dimmed until the latest reply; the bridge's order is kept. A
row is the icon, the basename bold (a folder's with `/`) and its folder dimmed, the bridge's `indices` (code points of
the whole path) marked `.tx-file-hit`. A pick inserts a file chip and a space (consuming one already there). The
bridge's `reason`, or "No file list for this checkout" for `source: 'none'`, is the footer; pending with no rows is
"Searching files…", an error "Could not search the files: <why>." with "Try again" (#39); nothing turns the source off. Drafts: `TranscriptMode` keeps one composer `Draft` per worker
(`laptop/transcriptDrafts.ts`, the 24 most recent live) and hands it to the view (`TranscriptRenderHost.draft`; the view
does not dispose a host's draft), so a desk switch gives back text, chips, caret and history; every change writes the
text and the file chips to `Drafts` (`h3d.draft.transcript.<worker id>`, `segments` typed and validated on read), so a
reload brings those back (images do not survive one). A sent prompt clears the draft by revision (`clearIf`, also when
the ack comes after the view went) and the stored copy with it. Its send gate (`SendGate`, `TranscriptRenderHost.sending`,
one per worker) is kept with it: a view made while a send is on its way is busy and sends nothing until the ack, and
`TranscriptMode` refuses a second `worker.prompt` to a worker that has one unanswered. The simulator answers `simFiles` (`SIM_FILES` in
`tools/fixture-panels.ts`); `e2e/h141-file-chips.spec.ts` drives a Claude and a Codex worker (`@comp`, a folder, a
quoted path, Backspace and undo, the sent `@path` text) and the copy/paste, desk switch and reload of a draft.
#247: `@r:` (or `@repo:`) in the same box lists the repositories and folders stored on the other floors of the worker's
building (every building's with the shared "Repositories from other buildings" switch, `repo_refs`). It is a query
prefix, not a trigger: `laptop/atSource.ts` `atSource(files, repos)` is the transcript's one `@` source (only when the
host passes `TranscriptRenderHost.repos`; #39: the dialogs' too), routing a query that starts `r:` / `repo:` to `laptop/repoSearch.ts`
`repoSource` with the prefix taken off and anything else to `fileSource`; its label follows the query, its keys are
`file:` / `repo:`-prefixed, and the files' empty footer becomes the `r:` hint (`REPO_HINT`, #39: "Files in this checkout
· type r: for repositories on other floors"). `repoSource` asks
`worker.repos` once per popup (`opening` marks the list stale, the first `r:` query asks; the known rows show at once and
follow the answer through `subscribe`), ranks with `rankByKeys` (`world/rank.ts`; keys: the repo name, `owner/repo`, the
folder's basename, the folder, the floor; `subsequence: true`, the opt-in tier the palette and `/` do not use), and
asks again when the switch changes (`RepoRefsBook`, `world/repoRefs.ts`), so an open popup follows another client.
"Loading…", a failed first ask, a failed refresh's note and the empty list's note ("No other floors in this building
have a repository or folder") follow the `/` source. A pick is plain text and a space: the folder (quoted with
whitespace) when the bridge says `cloned` or the floor has only a folder, else `https://github.com/owner/repo`; a folder
with `"` or a line break is never offered (`filePathProblem`). The switch is `ui/repoRefsSection.ts` (Settings,
`store: 'bridge'`). The simulator's `simrepos=<key>` (`tools/fixture-repos.ts`) sets demo-m5's floors up (a cloned repo
and a folder-only floor in Work, a repo in Personal; cloned when the folder's basename is the repo name) and shares the
switch between the key's connections; `e2e/h247-repo-completion.spec.ts` picks a folder and, after another client turns
the switch on, a URL from the other building.
#54: the bridge merges in the repositories it **discovered** under its scan roots (`internal/repodisc`, docs/protocol.md
"Repository discovery"), one row per repository: rows carry `id` (the popup's `key`) and `source`; a discovered row has
no floor (`repoRow` draws no `.tx-repo-floor`, its title says "found on the bridge host"), and every cloned row shows
the folder a pick puts in (`.tx-repo-dir`). A row without `id` (an older bridge) is keyed `floor:<session>`.
`repoSource` also listens to `RepoDiscoveryBook` (`world/repoDiscovery.ts`, the snapshot's `repo_discovery` and
`repo_discovery.update`): a new `status.revision` marks the list stale and tells an open popup, progress alone does not;
with roots set the label is "Repositories" and the empty notes name the scanned folders. Every surface passes the book
(`TranscriptModeHost.repoDiscovery`, `LookupHost.repoDiscovery`). The settings are `ui/repoDiscoverySection.ts`
(Settings → Integrations → Repository discovery, `store: 'bridge'`, hidden without the feature). The simulator's
`simrepos=<key>` simulates discovery too (`DISK`, `SCAN_MS` in `tools/fixture-repos.ts`; without a key it is an older
bridge); `e2e/h54-repo-discovery.spec.ts` adds the folder in one client and checks the other's open popup, Hire and
Prompt.
#39: the same `/`, `@` and `@r:` in the Hire worker First task, Start run's Extra instructions and First prompt, and the
Prompt (P) overlay. `ui/dialogCompletion.ts` `CompletionScope` gives a composer one proxy source per trigger over the
dialog's **lookup context**, read live: a hire's floor, harness, and the folder and worktree choice `worker.hire` would carry
(`hireArgs`: the Folder as typed, before its `hire.prepare` check; cleared: the floor's default; `hireSources`: `hire.commands`, `hire.files`, `hire.repos`, see docs/protocol.md "Completion before a hire"), or the P
overlay's worker (`workerSources`: the transcript's `worker.*` sources and its shared list). Each context keeps its own
sources (8 at most); a change bumps a generation: an open popup asks again (the new context's source is opened first),
a reply of the old one is dropped (`stale lookup context`), and every row carries its generation so a pick of an older
one puts nothing in. Nothing is asked before a popup opens; the dialogs never go busy, lose focus or change their draft
for a lookup (`ui/hire.completion.dom.test.ts` holds the lookups and hires before they answer; `prompt.completion` and
`startRun.completion` likewise). The dialogs bound the popup to their scrolling form (it flips above the caret there).
The rows' styles are `laptop/completionRows.css` (moved out of `transcript.css`, imported by the sources). The
simulator answers the `hire.*` ops (`tools/fixture-sim.ts` `hireLookup`); `e2e/h39-dialog-completion.spec.ts` drives
the Hire dialog, the P overlay, and "Hand to a worker" on a GitHub issue and a Kaneo task (`simkaneo=connected`) with a
repository picked in Extra and carried by `run.prepare` and `run.start`.
#147: ⌘P (Mac) / Ctrl+P (elsewhere) opens the command palette from every view: `Game.onPaletteKey`, a window **capture-phase**
listener next to `onHelpKey` that always `preventDefault`s the chord (no print dialog, repeats and the previews included),
calls `stopImmediatePropagation` (the seated terminal, the whiteboard's editor and the dialogs under it never see it) and
opens `ui/palette.ts`, or closes it when it is up (not during an IME composition). It opens over the image previews too
(`dialog.ilb`, `dialog.cmp-lightbox`): the palette is the topmost modal, and the previews' window capture-phase Esc / key handlers
leave a key from inside it alone (`inPalette` in `ui/dismiss.ts`, the same check the whiteboard's Esc uses), so Esc closes only the
palette and the preview stays up under it. A card being dragged is put back (`BoardsPanel.cancelDrag`, no drop) as it opens. It is the `palette` binding of the shortcut table
(`mod`+P, scope `any`, `typing`), and `seatedKey` (`laptop/keys.ts`) gives the chord to the game: Ctrl+P is no longer
readline's previous history in a seated terminal (↑ is; `docs/decisions.md`), and the table's `seat.palette` row and
`shortcuts.test.ts` keep the two in step. The window is a modal `<dialog>` (`.palette`, the credits frame; centred, 640 px, never into the right gutter) with a
`role=combobox` `<input>` and a `role=listbox`; the listbox keys and the active-row paint are `ui/listbox.ts`, shared with the
composer's popup (`completion.ts`): ↑ ↓ wrap, Enter picks, Esc closes only the palette and puts the keyboard back where it
was (the seat's input, a dialog's field; the whiteboard and the floor overview leave it out of their inert set, and the whiteboard ignores Esc from inside it). The plan-limits plate steps out of it into its edge tab like it does over a screen dialog: `dialog.palette[open]` is in `SCREEN` (`ui/corner.ts`), `topScreen()` is the palette whenever it is up (the widget lives inside the topmost modal, so the modal's inertness never reaches the tab), and `tabFit()` measures the palette alone (what is under it is dimmed and inert). Shift+L is a typed L in the palette's field; a click on the tab peeks, and closing the palette gives the plate back as it was. What it lists is
`world/palette.ts` (pure): plain text ranks **commands** with `world/rank.ts` (the #140 ranker, now in `world/`, where a
space and `›` start a word too) over the name and then the aliases; a leading `@` lists **floors**, "Building › floor" with
count pills in the badge colours (needs you, working, waiting, idle, done; zero hidden), "You are here" and an Asleep tape.
The commands are the table's: a binding with `palette: { name, aliases, where?, pick? }` is a row (names and keys cannot
drift; `COMMAND_ORDER` orders the empty palette and a test keeps it complete), `PALETTE_ONLY` adds the keyless Team presets
and About, and the aimed, Esc and read-only rows are left out. A row shows when one of its scopes is live (`activeScopes()`),
or always with `where: 'anywhere'` (Buildings) or `'floor'`: Hire, Issues, Pull requests, Start a run and Overview act on
`hereSession()`, so off an office floor Enter turns the list into the floor list under the question ("Hire on which
floor?") and the pick travels there and runs it. **Floor order**: floors with `counts.needsYou > 0` first, then the rest, each
by name without regard to case; a query filters and never reorders; the order is fixed when the palette opens and when the
query changes (`floorList`), while `refresh()` (the game's world events and connection changes) re-reads each listed row's
counts (`floorRow`), so a count moves and the row stays (the rule of `world/overview.ts`); a floor that goes drops its row,
a new one waits for the next query. An empty palette with floors that need you says "N floors need you · type @" in its
footer (a button: click types the `@`). Without a connection the floor rows grey out and cannot be picked; commands run. A command
(`runPaletteCommand`) closes the palette, then `dismissOverlays()` (the modals and the whiteboard, saved first), stands you up
from a seat, rides to the picked floor (`enterFloor`, the elevator doors) and calls the same `actions[id]` its key would; a
floor pick without a command is `dismissOverlays()` then `enterFloor`, and on the floor you are on it only closes. Tests:
`world/palette.test.ts`, `ui/palette.dom.test.ts`, `ui/listbox.test.ts`, the chord cases of `input/shortcuts.test.ts`, and
`e2e/palette.spec.ts` (city, floor, plan, lobby, seated terminal, whiteboard, floor overview, image preview, over the hire dialog, ⌘P on a Mac, the limits tab on each; each view
asserts the chord's keydown is `defaultPrevented`, since Playwright cannot see the print dialog).

#57: the helper's bridges in the game (`net/bridges.ts`: `BridgeApi` over `/api/bridges`, `BridgeBook` the list as last
read, polled every 2 s while something shows it). **Settings → Bridges** (`ui/bridgesSection.ts`, general group, store
"This helper") lists them with a state dot (the connection chip's colours, `ui/bridgeState.ts`), "In use", address and
state in words, Use / Rename / Edit / Remove (the bridge in use's Remove is `aria-disabled` and says why), and an add
form (ssh: host, optional remote socket; local: socket); the helper's refusals show under the form as it words them.
A poll redraws only a row that changed and never one with an open form. **⌘P → Switch bridge** (`PALETTE_ONLY`
`bridge.switch`) turns the palette into a third mode (`parseQuery(text, true)`, "Switch to which bridge?"): every
bridge but the one in use, online first, each group by name without regard to case (`bridgeList`), the order fixed
while it shows and the dots live (`bridgeRow`); with no other bridge one row, "No other bridges: add one in Settings",
opens Settings → Bridges. A pick (`App.switchBridge`) asks first for a bridge that is not up (`ui/bridgeSwitch.ts`,
"<name> is offline. Switch anyway?"), puts "Switching to <name>…" on the chip, activates it and reloads. The chip's
tooltip and About name the bridge in use; a helper with none gets the "No bridge configured" notice and a "No bridge"
chip. Neither the section nor the command exists on a page no helper serves (no token, or no list). `main.ts` reads
the list before the App so the per-bridge keys (`net/bridgeScope.ts`: drafts, the seat's tabs, the overview's
collapsed orchestrators, the hidden models and task levels, under `h3d.b.<id>.`) are scoped from the first read;
without a helper they stay unscoped, so specs that seed them are unchanged. Tests: `ui/bridgesSection.dom.test.ts`,
`ui/paletteBridges.dom.test.ts`, `net/bridgeScope.test.ts`, and `e2e/h57-bridges.spec.ts` (the helper faked with
`page.route`, `e2e/bridges.ts`).

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
a prompt is sent once its images are uploaded, and not at all when one failed; #39: the hire task completes `/` skills,
`@` files and `@r:` repositories of the hire's floor, harness and folder, see the composer section);
the dialog is a near-full-screen sheet, #51: the task editor takes the space and grows with the window, the options
sit beside it, or under it on a phone, and Hire / Cancel stay on screen; what you typed for a desk stays until a hire
is acknowledged),
harness → model → effort as chips (Tab into a group, ← → pick; the floor's default hire or the last hire on the floor
is preselected and marked so), the label (the next generated name), the folder (the floor's default; changing it
checks the new folder again), **Work in its own git worktree & branch** (on by default, configurable per browser in Settings → Display →
**Use a Git worktree and branch by default**, only when the folder is a git repo; each hire or run can override it) with the base `origin/<default> @ <sha>, <age>`, and the floor's and host's caps with the host load: a warning
above the soft cap, Hire refused at the hard cap. When `git fetch origin` failed the worktree option is off (a worktree
never branches from a stale origin; the bridge would refuse it with `fetch_failed`), the error sits above the buttons
with **Fetch again**, and hiring without a worktree still works. Warnings sit by the buttons, so they are in view
without scrolling. Hire hides the desk's "+" at once (each hire in flight holds its own desk, so Esc and another hire
meanwhile is fine: the top bar skips desks a hire is on its way to); the new
worker drops in to its chair from above (under a second, M6b); its desk is its own at once, so you can look at it, sit
at its screen and prompt it while it lands. #116: once its hire is acknowledged and the dialog is still the one that sent it, you are taken to the new worker (`App.goToNewHire` → `goToWorker(id, 'transcript')`): seated at its laptop, its conversation on screen, once it is in the store and its drop-in is over (6 s at most; never over an Esc'd dialog, another dialog, a seat you took, or once you moved, pressed anything or opened a dialog while it waited); Settings → Display → "Go to a new hire after hiring" (`ui/hirePrefs.ts`, `h3d.hire.goto`, on by default) turns it off. Look at a worker and press **X** to send it home: its branch and folder, what is left on the desk (uncommitted
changes, commits not on any remote) and, for a worker in a linked worktree of its own, keep / delete the worktree /
delete the worktree and branch (delete only when the bridge says the tree is clean and pushed, else a warning says
why; the branch too only when the bridge made it for this worker, `can_delete_branch`); a main checkout whose worktrees are still open cannot go yet. Focus starts on "keep", where Enter sends it home;
with a delete picked only the button confirms. The worker packs a cardboard box, takes the laptop, walks out down the
fire escape and away along the sidewalk, and the desk gets its "+" back. Walk-outs play for floors of the building you
are in (the interior only for the floor you are on), a drop-in only on the floor you are on; anywhere else they
resolve at once. Esc closes either dialog, and
the pointer lock is released while one is open. Dialogs never close by accident (#51): the ones that hold typed text or
a consequential choice (hire, start-run, presets, the P prompt, open-PR, the panels, send home, the board item, the MCP & skills overview) have no
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
status bar; a monitor keeps its last frame when it stops being live (frozen), or its status glow if it never was
(#52: a frame stays only while the same worker and pane are at that desk; a new worker there, or a new pane under the
same one, gets the glow, or a pending blank screen, until its own first frame, from the very next rendered frame; a
frozen frame goes on the glass with the frozen atlas's upload that carries it, at most 400 ms later, so an atlas cell
handed on never shows its previous owner's pixels);
asleep, they are dark. A nearer one takes over only from one out of view or clearly farther, one at a time, so walking
does not flicker. #98: a Claude or Codex worker's monitor shows what its agent is doing instead: its mascot (a crab
for Claude, a cloud for Codex) in a pose for the kind, the word (Testing, Writing, Thinking…), the detail
(`pytest -n auto`, a file name) and how long it has been at it; WAITING (a band of its own, a count of its own in the top
bar) when it ended its turn waiting on its background tasks, with what it waits on; the image it looks at on the desks
near you; resting (the crab asleep, the cloud drifting) when idle or done. A worker that needs you, a plain shell, or one
with nothing to say shows its terminal as before, and Settings → Display → Desk monitors: Terminal shows the terminal
everywhere. The worker's laptop stands closed in its dock, its sticker showing its harness. Look at a worker and
press **E** to sit at its screen: the worker steps aside, the camera glides in and the whole terminal fills the view,
at 10 fps. Everything you type goes to its terminal (letters, Enter, Tab and Shift+Tab, arrows,
Home / End / Page keys, F1–F12, Backspace, Delete, Ctrl+letter; the game's own keys too), **Cmd+V** (Ctrl+V off a Mac)
pastes (as a prompt to an agent, typed into a plain shell; a screenshot goes to an agent as `[Image #n: <path>]` markers once uploaded, a plain shell says it cannot take one and types nothing), **Shift+Esc** sends Esc, **Esc** (or the seat bar's Stand
up) gets you up; so do the elevator, another floor, a panel, the plan or a teleport. The world never does (#187): other
workers finishing, leaving or arriving, a floor's desk count or the building's outline changing, even the worker you sit at
leaving, its floor going to sleep or being removed, keep you seated with the conversation and your draft; the seat bar then
says it is offline ("… is no longer on the floor. Nothing you type is sent."), nothing is sent to it, and it recovers by itself
when the worker is back. Typing that fails shows in the seat bar. Getting up drops nothing you typed: what is
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
make -j2 test                 # overlap the independent Go, Vitest and shell suites
make shot                     # Playwright WebGL2, just the screenshot: game/test-results/shot.png
make e2e                      # the @smoke journeys of the specs below, WebGL2 (H3D_WORKERS parallel, one per host)
make e2e-extended             # on request: every functional spec below (the whole suite before #42 took ~38 min):
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
                              # {city,floor,clock,street}.png, m17-about-time.png. m17-shadow-acne.spec.ts (#86): ?lat=51 at 09:00-17:00,
                              # no vertical stripes (stripeScore) on the whiteboard, partition, sofa and the city's walls; floor shadows stay. m17-perf.spec.ts: perf-floor60
                              # at night against noon (H3D_M17_RUNS=<n> pairs, H3D_DIST=<build> for a baseline)
                              # #141 floor entry on demo-m6 (h141-floor-entry.spec.ts, __h3d.floorPool): a floor entered
                              # again (through the city, floor to floor, outgrowing the pool, asleep, shadows=0) draws
                              # what it draws entered first on a new page, mesh by mesh and by screenshot, each pooled
                              # mesh from its own buffers; live changes after a re-entry; ten rides A -> B -> A leave the
                              # renderer's memory flat; a resize, asleep or removal during a new page's first ride (its
                              # compile) leaves what the same change after the ride leaves. h141-floor-entry-perf.spec.ts (@perf): perf-floor60 and demo-m3b's
                              # floors entered and entered again (first frame, longest frame), and a new page's first
                              # ride through the doors (the longest frame shut, the first frame opening);
                              # test-results/h141-floor-{entry,ride}-perf[-<H3D_DIST>].json, H3D_141_RUNS=<n>
                              # #59 transcript presets on demo-m5 with sim=1 (m59-themes.spec.ts): the font files a
                              # fresh load fetches (Quiet's only; a stored preset's only), each transcript preset
                              # from its strip (computed fonts: mono vs prose; the limits widget; a box in tool
                              # output lined up) and the terminal's from the seat bar, apart (the terminal in Ubuntu
                              # fetches Ubuntu Mono, no Ubuntu), Hide tools and its chip, blocked storage, each view's zoom
                              # (keys, buttons, the prompt box, 200 % and 70 % laid out, Ctrl+wheel on the terminal,
                              # Ubuntu Mono on 14 / 28 px), keyboard reach; m59-{transcript,terminal}-<preset>,
                              # m59-transcript-<preset>-hidden, m59-mixed-{transcript,terminal} (Ubuntu over
                              # Quiet), m59-zoom-{200,70}, m59-terminal-zoom-200.png
                              # #98 desk monitors on demo-m5 with sim=1 (m98-monitor.spec.ts, sim.activity): the card
                              # (crab / cloud, word, detail, counter; unknown kind, resting, glance), WAITING (band,
                              # HUD count, not in N, badge), an image on a near monitor (Claude Read, Codex
                              # view_image, Codex exec), far and failed images, reduced motion, Settings' Desk
                              # monitors; perf-floor60 simactivity=all: no canvas draw, no upload, one draw;
                              # m98-{card-claude,card-codex,waiting,image,image-failed,perf-floor60}.png
                              # #74 fullscreen chip (h74-fullscreen.spec.ts, simzoom=): the seated watch asks for fullscreen, the chip
                              # toggles it through terminal.zoom, the human unzooming reaches it, headless, single pane and older
                              # bridges, keyboard, AA contrast at the three presets, the bar's height; h74-*.png
                              # (#176: on a bridge before it, simcontrol=old; a seat that owns its pane has no chip, a read-only one
                              # offers "Zoom herdr tab")
                              # #175 narrow pane (h175-narrow-fit.spec.ts, simscreen=narrow): an owned 60×40 pane takes the window's
                              # grid at 100%, A+ / Ctrl+0 change the cells, a resize; read only it shows at its own 60×40; h175-*.png
                              # #176 seated workspace (h176-seat-workspace.spec.ts): at 1280×800 the content area is >85% × >75%,
                              # the game inert, the PTY at the fitted grid, a narrower window fewer columns at the same font,
                              # standing up restores the focus; Ctrl+click links (plain, soft-wrapped, OSC 8; http not), the wheel
                              # and Back to live, typing back to live, drag + Ctrl+Shift+C, read only (simcontrol=busy) and an
                              # older bridge; h176-*.png
                              # #140 Auto (h140-auto-profile.spec.ts, simcodexprofiles=2): the hire dialog's Auto chip and
                              # its toast, Settings' "May be used for anything" and Auto rules (a refusal under its row,
                              # move, save) at 390 and desktop, Quiet and Ubuntu; h140-*.png
                              # #167 shared setup (h167-share-setup.spec.ts, simcodexprofiles=2): Settings' drift list
                              # with Fix and the skill move, the share confirm list and report, the meter's "drifted"
                              # mark and its note, at 390 and desktop, Quiet and Ubuntu;
                              # h167-{drift,confirm,report,move,meter}-*.png
                              # #167 run profiles (h167-orch-profile.spec.ts, simcodexprofiles=2): Hire orchestrator's
                              # Codex profile chips and run.start's pick, the team preset editor's per-role chips and the
                              # prompt naming the role's profile, at 390 and desktop, Quiet and Ubuntu;
                              # h167-{orch,preset}-profile-*.png
                              # M7 on demo-m6 with sim=1 (m7-boards.spec.ts, m7-actions.spec.ts, m7-perf.spec.ts): the
                              # corkboard and PR board (columns, paper, pins, holders, CI, verdict stamps), E and the
                              # top bar opening the overlays, no-project / no-repo / older-bridge floors, the watch
                              # (one floor, again after a reconnect), diff animations, the sanitised markdown, Hand to
                              # a worker and the peel-off, Ask, Close, Move, comment, Merge and its double confirmation,
                              # the gong, Open PR for a plain worker, 100 issues + 20 PRs; m7-*.png; #52 dragging
                              # cards: the slot line above / below a card, the exact set_status args, an empty column
                              # and a column's end, Esc / outside / own place cancel, a failed write snaps back, a
                              # stale board never moves it back, no project no drag, edge scroll, reduced motion, a
                              # finger (swipe scrolls, long press drags); m52-drag-preview.png
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

For order-dependent failures, keep the shuffle seed from the failing run. These runs bypass Go's result cache and
exercise the same tests with parallel or serial scheduling:

```sh
go test -count=3 -parallel=8 -shuffle=359 ./...
go test -count=1 -p=1 -parallel=1 -shuffle=359 ./...
pnpm -C game exec vitest run --maxWorkers=4 --sequence.shuffle --sequence.seed=359
pnpm -C game exec vitest run --maxWorkers=1 --sequence.shuffle --sequence.seed=359
```

Keep Vitest's per-file isolation and Playwright's zero retries. E2E command acknowledgements use
`expectCommandDone` to await both the successful result and the closed dialog: world events before the ack can rebuild
the scene under parallel rendering load. Performance measurements belong in benchmarks; for the largest
accepted SVGs, use `go test ./internal/logo -run '^$' -bench BenchmarkSVGWorstAccepted -benchtime=1x`.

If the host's `/tmp` quota is exhausted, use a short disk-backed temporary root such as `TMPDIR=/var/tmp` for unit
tests. Long temporary roots can exceed Unix socket path limits. For E2E, `H3D_E2E_TMPDIR=/var/tmp` moves browser and
preview-server temporary files while leaving portlease's shared lease state in its usual location.

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
127.0.0.1:P:127.0.0.1:P <the Mac>`, so the Mac page is on its own loopback (a secure context: WebGPU). The Mac is `$H3D_MAC`, else
`H3D_MAC=` in the private `~/.config/h3d/update.env` (`deploy/update.env.example`); there is no default, and without one `perf:mac` exits 2.
It pipes `tools/mac-runner.mjs` into `/opt/homebrew/bin/node` in `~/h3d-tools` (playwright-core, headless Chrome at
3024×1890) and runs `window.__h3d.bench()` — the engine-bench method: serialized update + render + GPU wait,
pipelined throughput, GPU timestamps, and rAF frames that include DOM layout. M3b jobs bench the outside of the
8-floor tower in `perf-city240`: `street8` (the facade from the sidewalk), `escape8` (the top landing, looking down),
`window8` (out of a top-floor window), and `floor60-street`; `bench()` reports the `area` it ran in. M3c jobs:
`floor60-mezz` (at the corner office's glass, looking down over 60 workers), `floor60-desk` (seated at your desk) and
`floor96-desk` (seated over 96 workers who all need you: every card shows).
#141 jobs: `floor60-entry` and `m3b-entry` time `enterFloor` to the next drawn frame, and the longest
long-animation-frame after it, for each floor's first entry (cold) and the ones after (warm), left for the city between.
#146 job: `startup` launches Chrome twice on one fresh profile (the second shows what it kept on disk) and loads the
demo city once per launch: `__h3d.startup` (the first frame that drew the city, ready, `renderer.info.memory.programs`
at each; on a build from before #146 the runner times ready itself), the long-animation-frame that drew the city first
and the longest one until ready. To compare with an older commit, run it from a detached worktree of that commit with
the current `tools/mac-*` copied in (`H3D_PERF_JOBS=startup`).
M5 jobs, on `perf-floor60` with the simulator: `floor60-screens` (the overview with four live laptop screens),
`floor60-screens0` (the same with `screens=0`) and `floor60-laptop` (seated at a laptop). On the server,
`H3D_BENCH=1` with the m5-screen spec runs the same comparison on WebGL2 (relative numbers only).
`bench(opts)` takes `frames` (300), `warm` (60), `sway` (true), and `pipelined` / `raf` (both true): false skips the
pipelined throughput run (`pipelinedMs` is null) or the 120 rAF frames (`rafMainMs`, `rafIntervalMs` null). The
default suite's perf specs (`m3d-perf`, `m7-perf`, the m6-crew frame budget) read only the serialized frame and the
draw counts, so they bench `{ frames: 40, warm: 10, pipelined: false, raf: false }` (m6-crew: 20 and 5), and they
close the first page before benching the baseline, so the two runs don't share the CPU. `perf:mac` and the
`H3D_BENCH` benches keep the defaults.

`window.__h3d` (tests, perf): `backend`, `frames`, `error`, `ready` (#146: a snapshot is in and the first city is compiled
and drawn whole), `startup` (#146: the first city frame and ready, with the renderer's programs), `view()`, `lookAt()` → `{kind, id, name?, label?}`
or null, `status(workerId)` → `{status, at}` as last rendered, `world()` (shown `name`/`desk` plus what the bridge
sent, `bridgeName`/`bridgeDesk`, null from an older bridge), `layout(session)`, `enterFloor(session, pose?)`,
`leaveFloor()`, `floorPool({data?, t?, hold?, resume?})` (#141: the pool's meshes as drawn, with the instances in use
and whether the renderer's state reads each mesh's own buffers, the lamps, the renderer's memory; `t`: after one frame at
that time, `hold`: the loop paused on it until `resume`), `inject(event)` (applies a protocol event as if the bridge sent it), `setPose({x, z, yaw, pitch})`,
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
`fps` it is watched at, else null; #52: its `pane`, and `shows`, whose screen is on that glass, `<worker id>@<pane>` of
its live terminal or its frozen frame once the GPU has it, null for none; `state` is the laptop's mode, so a
just-frozen screen is `frozen` with `shows` null until the upload), `screenTrace(on)` (#52: from `true` on, `screens()` taken right
after every rendered frame; `false` stops and returns them), `simSwap(args)` (#52: the simulator's `sim.swap`), `seated()` (the worker whose laptop you sit at, or null), `sitAt(workerId)` (as E;
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
`openBoardItem(which, id)`, `injectBoard(message)`, `boardMessage(which)` (#52: a copy of the last board message of the
floor you are on), `boardLog()` (the `board.watch` / `unwatch` / `refresh` the game sent
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
played late, and muted or without sound the lines are timed by the lock's clip lengths. #100's inbox chimes are
`playUi('needs' | 'finished', volume)`: not positional and not files, two short tones synthesized per call (oscillator
and gain envelope) under the master mute and volume.

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

