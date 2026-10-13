# E2E selection: what routine verification runs, and where every moved case went (#42)

#42 trimmed what an unqualified `make e2e` runs from the whole historical Playwright matrix to the essential journeys,
and put visual audits, captures and benchmarks behind explicit commands. This file is the assertion-to-coverage map the
issue asks for: for every case removed from default selection or deleted, where its assertion now lives. It is kept up
to date as tests move; a test that changes profile changes here too.

## Baseline (before #42)

At `6d68d06` (main after #40), `playwright test --list --reporter=json`: **1236 cases in 86 files**, all selected by
`make e2e`, `make e2e-prebuilt` and `pnpm e2e`. The issue's inventory was taken at `66dba79` (1212 / 85); since then #40
added `h40-task-levels.spec.ts` (12) and a case to `h248-resolve-levels.spec.ts` (6), and new surfaces in
`e2e/ui-surfaces.ts` grew the generated theme files:

| File | Issue (`66dba79`) | Baseline (`6d68d06`) |
| --- | ---: | ---: |
| `ui-theme.spec.ts` | 426 | 433 |
| `ui-theme-shots.spec.ts` | 220 | 224 |
| `ui-theme-shots-states.spec.ts` | 54 | 54 |
| `h40-task-levels.spec.ts` | — | 12 |
| `h248-resolve-levels.spec.ts` | 5 | 6 |
| everything else | 507 | 507 |
| **total** | **1212 / 85 files** | **1236 / 86 files** |

## The mechanism

Every test's selection is visible in its source as a Playwright tag: `test(title, { tag: '@smoke' }, ...)`.
`game/playwright.config.ts` turns `H3D_E2E_PROFILE` into the config's `grep` / `grepInvert`:

| Profile | Selects | Run with |
| --- | --- | --- |
| `smoke` (default) | `@smoke` | `make e2e`, `make e2e-prebuilt`, `pnpm -C game e2e` |
| `extended` | everything but `@visual` and `@perf` (smoke and component included) | `make e2e-extended`, `PROFILE=extended` |
| `visual` | `@visual` | `make e2e-visual`, `PROFILE=visual` |
| `perf` | `@perf` (with `H3D_PERF=1 H3D_BENCH=1` for the opt-in benches) | `make e2e-perf`, `PROFILE=perf` |
| `component` | `@component`: the `/?composer-demo` host, no 3D scene | `make e2e-component`, `PROFILE=component` |
| `all` | everything | `SPEC=...` alone, `PROFILE=all` |

- `make e2e SPEC=e2e/x.spec.ts` runs **every** test of that file (profile `all`), whatever its tags.
  `SPEC=... PROFILE=smoke` runs only that profile's tests of the file. `GREP=<regex>` adds Playwright's `--grep`, which
  must match too (title or tag): `make e2e-prebuilt SPEC=e2e/ui-theme.spec.ts GREP='audit .*: hire'`.
- `make e2e-list [PROFILE=...] [SPEC=...] [GREP=...]` lists a selection without a build, a leased port, a preview server
  or a browser (the config needs `PORTLEASE_PREVIEW_PORT` only when it runs tests). It passes `--reporter=list`, so a
  listing never overwrites `game/test-results/e2e-report.json`.
- Every run keeps the host-wide `flock`, the portlease-leased preview port, `H3D_WORKERS`, `H3D_DIST`, `H3D_E2E_REPORT`
  and `H3D_E2E_TMPDIR`. `make shot` still runs only `e2e/shot.spec.ts`.
- CI (`.github/workflows/ci.yml`) still runs no Playwright. `game/e2e-live/*` (the `test:live*` scripts) and the Go
  `integration` / `live` build tags are untouched and stay opt-in.

## Selection counts (`make e2e-list`)

| Stage | smoke | extended | visual | perf | component | all |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline (`6d68d06`, no profiles) | — | — | — | — | — | 1236 / 86 |
| (i) mechanism + smoke / component tags | 27 / 25 | 1236 / 86 | 0 | 0 | 28 / 2 | 1236 / 86 |

## The smoke suite

The essential journeys of the issue's §4, one test each where one test proves the journey. `@smoke` marks them in
their files.

| Journey (issue §4) | Test |
| --- | --- |
| The built game renders without errors | `shot.spec.ts` "the game renders the fixture city with WebGL2" |
| A live update reaches the view | `m2.spec.ts` "a status event from the fixture stream reaches the rendered state" |
| City → floor → hire → worker → conversation → Issues → Inbox, keyboard only | `h124-keyboard.spec.ts` "keyboard only: from the city into a floor, hire, …" |
| Hire from the keyboard through the ack to the new worker | `m4.spec.ts` "E on an empty desk: the hire dialog from the keyboard, then the worker drops in to its chair" |
| An unknown hire outcome keeps the draft and never hires twice | `h210-hire-background.spec.ts` "a dropped connection while the hire is on its way: …" |
| Dictated hire → review → confirmed once, background outcome | `h214-full-path.spec.ts` "background on: dictated, reviewed and changed, …" |
| Dictated hire: repeated Enter sends one request, one hire | `h214-edge-cases.spec.ts` "repeated Enter: …" |
| Start an orchestrated run | `m6-start.spec.ts` "E on an empty desk: Hire orchestrator from the keyboard, …" |
| Sit, read the transcript, Ctrl+Esc to the terminal and back | `m16-transcript.spec.ts` "sitting down opens the conversation over the monitor, …" |
| Type in the terminal, stand | `m5-screen.spec.ts` "E sits at a worker’s laptop: typed input echoes in its terminal, …" |
| Send a prompt: Sending → Sent → the real item | `m16-transcript-activity.spec.ts` "a prompt shows at once, Sending → Sent → …" |
| Watch clean-up across sit / toggle / stand | `m16-transcript.spec.ts` "sit / toggle / stand cycles leave no transcript watches or overlays behind" |
| A live floor rebuild keeps the seat and the draft | `h187-keep-seat.spec.ts` "the issue’s repro: a floor.upsert with more desks keeps you at the laptop, …" |
| A blocking question answered | `m16-ask.spec.ts` "a two-question ask: …" |
| An async question answered, no duplicate send | `h157-async-questions.spec.ts` "answered from the transcript while Codex works on: …" |
| Paste → upload → send in the transcript | `prompt-images.spec.ts` "transcript: a pasted screenshot is a chip in the prompt box; …" |
| A failed upload keeps the draft (component host) | `composer.spec.ts` "a failed upload blocks the send, keeps the draft, …" |
| A failed upload keeps the hire's prompt (Hire host) | `hire-composer.spec.ts` "a failed upload blocks the hire, keeps the prompt …" |
| A representative board write, Close with its confirmation | `m7-actions.spec.ts` "Move to…, comment and Close issue… (confirm and reason) …" |
| Hand a card to an agent | `m7-actions.spec.ts` "Hand to a worker: …" |
| Inbox leads to the right worker | `m100-inbox.spec.ts` "the inbox: the chip opens a list of who and where …" |
| Overview leads to the right worker | `m188-overview-all.spec.ts` "Enter on a worker on another floor sits you at its laptop; …" |
| Whiteboard edit survives close and reload (#32: known flaky) | `m13-whiteboard.spec.ts` "draw, close, reload: …" |
| Screen capture starts and stops cleanly | `m13-screen.spec.ts` "Share → LIVE and the TV plays it; …" |
| Wrap up / send home does not lose work | `m83-wrapup.spec.ts` "wrap up: delete preselected, …" |
| File a handoff, then send home | `h223-handoff.spec.ts` "the inline button on the last reply files it as written, …" |
| Typing in fields never fires game keys | `h124-fields.spec.ts` "the hire dialog: the task composer (contenteditable) and the model filter (a search input)" |

## Assertion-to-coverage map

Filled in as cases move. Columns: the case (file, title), where it went (profile, or deleted), and where its
assertion lives now.
