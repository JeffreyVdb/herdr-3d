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
| `visual` | `@visual` and `@theme` (`@theme`: every per-surface theme audit and all 8 theme combinations, the representatives `extended` runs included): what CSS / theme work runs | `make e2e-visual`, `PROFILE=visual` |
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
| (ii) captures, tours and benches out | 27 / 25 | 946 / 79 | 281 / 5 | 11 / 10 | 28 / 2 | 1238 / 86 |
| (iii) theme matrix reduced | 29 / 26 | 545 / 79 | 453 / 6 | 11 / 10 | 28 / 2 | 1009 / 86 |
| (iv) duplicates removed | 29 / 26 | 540 / 79 | 453 / 6 | 11 / 10 | 26 / 2 | 1004 / 86 |
| (vi) the narrow Hire audit joins smoke | 30 / 26 | 540 / 79 | 453 / 6 | 11 / 10 | 26 / 2 | 1004 / 86 |
| (vii) `@theme`: visual also runs the 9 representative audits and 2 routine combinations | 30 / 26 | 540 / 79 | 464 / 6 | 11 / 10 | 26 / 2 | 1004 / 86 |

Since 1236 → 1004 discovered cases: 232 removed by merging or deleting (229 from the theme matrix, 5 duplicates, +2 from
splitting the two mixed perf cases). Captures, audits and benches (464) left the routine selection; `make e2e` runs 30.

## The smoke run, measured (one run, 2026-10-13)

`make e2e` once at `1efde20` on the 32-vCPU development host (Xeon E5-2660 v3, llvmpipe), default 6 workers, lines
timestamped as they came; suite time is the JSON report's `stats.duration`.

| | |
| --- | ---: |
| Cases | 29 (27 passed, 2 failed); the narrow Hire audit was tagged @smoke after this run (30 now) |
| Build (`pnpm build` + `check-bundle`) | 6.2 s |
| Lock wait | 0 s (no other run held it; no "waiting" line) |
| Preview server start + Playwright load | 5.4 s |
| Suite (`stats.duration`) | 101.1 s |
| **Total wall time, `make e2e`** | **109.0 s (1 min 49 s)**, within the 5-minute target |

The longest cases: `m16-transcript.spec.ts` "sitting down opens the conversation …" 37.1 s, `m13-whiteboard.spec.ts`
"draw, close, reload: …" 33.3 s, `h157-async-questions.spec.ts` 25.9 s.

The two failures were `m4.spec.ts` "E on an empty desk: the hire dialog from the keyboard, then the worker drops in to its
chair" and `hire-composer.spec.ts` "a failed upload blocks the hire, keeps the prompt and shows a retry; …", both at
`expect.poll(() => dialog(page)).toBeNull()` after Enter: the dialog still said "The hire is on its way." after the
poll's default 5 s. Both passed when run alone right after (`make e2e-prebuilt SPEC='e2e/m4.spec.ts
e2e/hire-composer.spec.ts' PROFILE=smoke`, 2 passed, 17.6 s). They are load-dependent and older than #42: the
#241 bench runs (`docs/research/e2e-bench/results/`) record the same `toBeNull()` failure of `hire-composer.spec.ts:232`
at 6, 8, 12 and 16 workers and of `m4.spec.ts:108` at 12 and 16. Not rerun to improve the number. After this run those
two polls got a 20 s timeout; #43 investigated where the delay occurs.

The #43 audit on 2026-10-20 reproduced the same "The hire is on its way" failure in a smaller scenario: open
`demo-m4`, hire at pastry's desk 14, and require the dialog to close within 5 s. Five of twelve simultaneous copies
failed (29.4 s for the batch). Browser WebSocket timestamps show the first `floor.upsert` arriving 152–209 ms after
`worker.hire`, while the following world events and acknowledgement take several seconds to reach the page's
handlers. The fixture uses Node's `setTimeout` unless `simclock=manual` is requested; it sends the floor update,
worker update and acknowledgement in the same timer callback. A second batch removed the first task entirely and
timed each browser message handler. The floor update took 147–441 ms, the worker update 45–128 ms, and the ack
handler under 0.2 ms, while the ack reached that handler 2.74–5.13 s after sending the hire. Most delay falls between
browser callbacks under rendering load. Two of twelve copies exceeded the original 5 s assertion; both then passed
the shared acknowledgement expectation, and all twelve completed (24.8 s). This rules out the task classifier and
the fixture's timer as the cause in this reproduction.

`e2e/game.ts` now provides `expectCommandDone`: a shared 20 s bound for successful hire, send-home and run
acknowledgements, checking both the successful command result and the closed dialog. Corresponding success polls
use it; ordinary UI and Escape assertions keep their existing bounds. This accommodates page processing under
parallel rendering load without adding sleeps or retries. Renderer performance work is separate.
The original three affected scenarios also passed all twelve cases at twelve workers (four repetitions each,
40.4 s for the batch), then all three at one worker (18.5 s). The current browser reported
`ANGLE (NVIDIA, Vulkan 1.4.351 (NVIDIA NVIDIA GeForce RTX 2060 (0x00001F15)), NVIDIA)` through
`WEBGL_debug_renderer_info`; this audit used hardware rendering. The earlier llvmpipe measurements above describe
their historical environment.

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
| Theme switch from the keyboard, applied and saved at once | `ui-theme.spec.ts` "keyboard: arrows move the UI theme between Quiet and Ubuntu, …" |
| A saved theme survives a reload, no navy first frame | `ui-theme.spec.ts` "a saved Ubuntu survives a reload and no frame paints navy first" |
| One narrow layout / keyboard-focus journey (added after the measured run) | `ui-theme.spec.ts` "audit at 390x844: hire in Ubuntu: no sideways overflow or clipped control; the focus ring on every operable widget, …" (8 s alone) |
| Typing in fields never fires game keys | `h124-fields.spec.ts` "the hire dialog: the task composer (contenteditable) and the model filter (a search input)" |

## Assertion-to-coverage map

Filled in as cases move. Columns: the case (file, title), where it went (profile, or deleted), and where its
assertion lives now.

### Theme captures (`@visual`)

| Case | Now | Coverage |
| --- | --- | --- |
| `ui-theme-shots.spec.ts`, all 224 (`<set> <size>: <surface>`) | visual | Screenshot-only: no baseline comparison, its only assertions are a clean boot and no page error. Explicit decision: the PNGs are not a routine check; they stay for design work (`make e2e-visual`, `H3D_UI_SET` / `H3D_DIST` / `tools/ui-shot-diff.mjs`). Rendering without errors stays in smoke (`shot.spec.ts`, every smoke test's `watchErrors`). |
| `ui-theme-shots-states.spec.ts` states (20: focus, busy, disabled, invalid, offline × 2 themes × 2 sizes) | visual | Their setup assertions are kept in functional tests: Hiring… busy and aria-busy in `ui-theme.spec.ts` "states: a hire in flight …"; disabled AI buttons and the invalid Timezone (`aria-invalid`) in "states: disabled controls keep their label readable …"; a lost connection in `h210-hire-background.spec.ts` / `h214-edge-cases.spec.ts` (reconnect) and `m7-*` (offline boards). |
| `ui-theme-shots-states.spec.ts` mixed themes (24) | visual | Screenshot-only. The independence of UI / transcript / terminal themes is asserted by `ui-theme.spec.ts` "combination …" and "a seated switch leaves the transcript and the terminal exactly as they were …". |
| `ui-theme-shots-states.spec.ts` switch before / after (10) | visual | Screenshot-only. Live switching without reload or loss: `ui-theme.spec.ts` "a switch restyles the open Settings dialog …", "a switch with the Hire dialog open …", "a live switch leaves the terminal’s screen, …", "a live switch leaves the whiteboard’s drawing …". |

### Screenshot tours (`@visual`)

| Case | Now | Coverage of its non-image assertions |
| --- | --- | --- |
| `m3b.spec.ts` "screenshots: out of the windows, the fire escape, the facade, the lobby" | visual | Only `lookAt()` null at the end. Walking the fire escape and the lobby: `m3b.spec.ts` "fire escape: …" and "lobby: …". |
| `m6b.spec.ts` "a row while walking, a desk up close, the stickers, an empty desk, the drop-in" | visual | Live screens and the drop-in (look-at says the new worker): `m6b.spec.ts` "a hire drops in at an empty desk, …" and "a live screen is on the desk monitor, …". |
| `m6c.spec.ts` "stand-up, mid-walk, the hand-over, the tray and two reviewers queueing" | visual | The delivery's phases and tray count: `m6c.spec.ts` "a report walks over to the orchestrator’s desk and back …"; the queue: "two reviewers finishing together queue: …". |

### Benchmarks (`@perf`)

`make e2e-perf` sets `H3D_PERF=1 H3D_BENCH=1`, so the cases that skip without them run there.

| Case | Now | Structural invariant kept in a functional test |
| --- | --- | --- |
| `m3d-perf.spec.ts` "logos on every building of the city / lobby stay in the frame budget" (2) | perf | The logos showing and clearing: `m3d-logos.spec.ts`. The draw / triangle budget needs the 240-worker city twice (with and without logos): perf only. |
| `m17-perf.spec.ts` "the office at night … stays in the frame budget of noon" | perf | Night lighting itself: `m17-daynight.spec.ts`. Equal day / night draws need two perf-floor60 boots: perf only. |
| `m6c-perf.spec.ts` "two reports … on a full floor stay in the frame budget …" | perf | One walk at a time and the waiting tray: `m6c.spec.ts` "two orchestrators on one floor: … one walk at a time …", "two reviewers finishing together queue: …". |
| `m7-perf.spec.ts` "100 issue notes and 20 PR notes stay in the frame budget: …" | perf | Two instanced batches: `m7-boards.spec.ts` "the wall boards are two instanced batches …"; nothing written on a quiet poll: "a board update animates by diff …". |
| `m58-activity-perf.spec.ts` "the live cue adds no paint, …" | perf (already `H3D_PERF`-gated) | The cue's one opacity animation: `m16-transcript-activity.spec.ts`. |
| `m15-radio.spec.ts` "bench: the radio playing on perf-floor60 against off" | perf (already `H3D_BENCH`-gated) | — (bench only). |
| `m5-screen.spec.ts` "bench: 4 live screens on perf-floor60 against none" | perf (already `H3D_BENCH`-gated) | — (bench only). |
| `h206-diff-highlight.spec.ts` "highlighting causes no long task: …" | perf | The highlighting itself (colours, plain context, unknown files): `h206-diff-highlight.spec.ts` "diff rows gain syntax colours: …". |
| `m6-crew.spec.ts` "frame budget: crew parts are instanced, …" | perf (the draw-call bench) | Split: new functional `m6-crew.spec.ts` "crew parts are instanced: one mesh per part kind for the floor, none on a floor without a run or once nobody is crew" keeps every mesh assertion without the bench. |
| `m98-monitor.spec.ts` "a floor of 60 desks animates every card …; one draw for all of them" | split | The functional case keeps its ledger, canvas-draw, texture and one-mesh / zero-mesh assertions (title now "… one mesh for all of them"); the draw-call and frame-time comparison is the new perf case "bench: the cards of a 60-desk floor cost a draw or two …". |

### The theme matrix (`ui-theme.spec.ts`, 433 → 204: 2 smoke, 32 extended, 172 visual only; the visual profile runs 183)

The five generated families were one full game boot per surface per check. They are now one boot per surface and
viewport that runs every check of that viewport (`expect.soft`, so one run reports all of them), "audit at <size>:
<surface> in Ubuntu: …". Same probes (`ui-theme-probe.ts`), same roots, same thresholds; the focus walk runs last.

| Case(s) (baseline count) | Now | Coverage |
| --- | --- | --- |
| "coverage: <surface> has no Quiet navy, yellow or Recursive left in Ubuntu" (58) | merged | "audit at 1280x720: <surface> …" (stray colours / fonts) |
| "contrast: text on <surface> is 4.5:1 …" (58) | merged | "audit at 1280x720: <surface> …" (contrast) |
| "targets: every control of <surface> is >= 32 x 32 px …" (58) | merged | "audit at 1280x720: <surface> …" (targets) |
| "focus at 1280x720: every operable widget of <surface> …" (58) | merged | "audit at 1280x720: <surface> …" (focus ring, last). A surface with no widget of its own no longer shows as skipped: the ring check is left out for it. |
| "focus at 390x844: …" (54) | merged | "audit at 390x844: <surface> …" (focus ring) |
| "layout at 390px wide: <surface> …" (54) | merged | "audit at 390x844: <surface> …" (overflow) |
| "layout at 200% browser zoom (640x360): <surface> …" (54) | merged | "audit at 200% browser zoom (640x360): <surface> …" |
| the audits above, per family | extended | Representatives: 1280x720 settings, hire, seat-transcript, seat-terminal, board-issues, overview, whiteboard (the issue's component families); 390x844 hire; 640x360 settings. Every other surface’s audit (157) is `@visual`. Every audit is `@theme` too, so `make e2e-visual` runs all 166 (`make e2e-list PROFILE=visual SPEC=e2e/ui-theme.spec.ts GREP='audit at'`). |
| "Settings → Appearance (This browser): a labelled UI theme radio group of exactly Quiet and Ubuntu, Quiet selected, the exact copy" | deleted | Copy, legend, hint, labels, descriptions, the store and Quiet for a fresh browser: `src/ui/appearanceSection.dom.test.ts` "is a browser-scoped section titled Appearance …", "has Quiet selected for a fresh browser"; the copy in `src/ui/uiTheme.test.ts` "are exactly Quiet and Ubuntu, …"; transcript/terminal-only picks leave the UI Quiet: `src/ui/themePrefs.test.ts` "is Quiet for a fresh browser and for one with only transcript or terminal picks; …". The wiring is the smoke keyboard test. |
| "missing, invalid, blocked and throwing storage is safe: …" | reduced | The four invalid-value page boots are gone: invalid / missing values in `src/ui/themePrefs.test.ts` "falls back to Quiet for a missing or invalid stored value" (now also `UBUNTU`) and, **added**, the pre-frame script of `index.html` in `src/ui/uiTheme.test.ts` "the pre-frame UI theme script in index.html": only a stored `ubuntu` marks the root, blocked or throwing storage is left alone. The integrated throwing-storage start-up stays: "blocked and throwing storage is safe: Quiet at start-up, …" (extended). |
| "combination ui=… transcript=… terminal=…" (8) | 2 extended, 6 visual | `ubuntu/quiet/ubuntu` and `quiet/ubuntu/quiet` (every pick apart from its neighbour) run in every functional run; all eight are `@theme`, so `make e2e-visual` runs all eight (`make e2e-list PROFILE=visual SPEC=e2e/ui-theme.spec.ts GREP=combination`: 8). |
| "layout at 1280x720: the seated conversation’s timeline and prompt box …" | visual | The 200% zoom case of the same check stays extended. |
| "view zoom and a mode switch leave the shell’s fonts, colours and sizes unchanged (Ubuntu UI)" | visual | Fine-grained theme regression for CSS work; the transcript zoom one ("transcript zoom 100 → 200 leaves the seated widgets …") stays extended. |
| "the completion popup’s commands and paths are the UI’s Ubuntu Mono at 14px …" | visual | Popup behaviour: `composer-complete.spec.ts` (component), `h141-file-chips.spec.ts`. |
| "the empty whiteboard’s welcome (heading, hints) is Ubuntu UI text …" | visual | Whiteboard theming: "audit at 1280x720: whiteboard …", "a live switch leaves the whiteboard’s drawing …". |
| "states: inside the transcript the composer’s Send, the selected tab and its count keep the UI theme’s colours (#111)" | visual | The seat-transcript audit's contrast check; the button states: "states: the primary, secondary and busy buttons …" (extended). |
| "states: the review’s Hire in flight (#212) is busy like the hire dialog’s: …" | visual | The busy / no-second-hire guarantee: "states: a hire in flight …" (extended); the dictated review's single hire: `h214-edge-cases.spec.ts` "repeated Enter: …" (smoke). |
| "states: a preset being deleted …", "states: a reviewer’s verdict stamps …", "states: the elevator’s floor plates …" | visual | Exact palette values for CSS work. The palette anchors on the real elements: "Ubuntu UI: exact palette anchors …" (extended). |
| everything else in the file (focus, switching, fonts, palette, touch, forced colours, the whiteboard, the hire in flight) | extended | unchanged |

32 extended theme cases is more than the issue's "roughly 25": seven of them are the family representatives the issue
lists (Settings and Hire, transcript and terminal, board and overview, whiteboard), and the live-switch, font-loading and
forced-colour cases are the real-CSS / data-loss regressions it asks to keep.

### Duplicates removed (issue §3)

| Case | Now | Coverage |
| --- | --- | --- |
| `ui-theme.spec.ts` copy / defaults, invalid storage values | see the theme matrix above | |
| `composer-complete.spec.ts` "mid-word / and @ do not open; after a space they do" | deleted | `src/ui/composer/complete.test.ts` "never opens mid-word: paths, a/b, URLs, emails", "opens right after a space, a tab or a newline"; the `Files` list label is now asserted by the async case below. |
| `composer-complete.spec.ts` "an async source: loading, rows, a late reply dropped, a failure, No match" | replaced | One real asynchronous pick stays (component): "an async source: Loading… while the reply is on its way, then its rows; Enter picks one" (no fixed 1.1 s wait). The state matrix: `src/ui/composer/completion.dom.test.ts` "shows loading, then the rows", "a late reply is dropped and its signal aborted; the latest wins", "a rejected reply says so and is not stuck loading; …", "filters as the query grows, and says "No match" for nothing". |
| `composer.spec.ts` "refused files say why, and nothing is added; the limit stops at twenty" | deleted | `src/ui/composer/composer.test.ts` "refuses an unsupported or empty file with a message and adds nothing", "takes the good files of a mixed paste …" (SVG), and, **added**, "stops at twenty images by default, one paste at a time, and says so". Refusal shown by a real host: `prompt-images.spec.ts` "P: a file the note refused holds the send …", "transcript: a file the box refused holds the send …". |
| `m10-limits.spec.ts` "the panel opens and closes when browser storage is unavailable" | folded | `src/ui/limitsPrefs.test.ts` "work without storage: missing, or throwing on every access, …"; the integrated start-up with throwing storage is now one shared case, `ui-theme.spec.ts` "blocked and throwing storage is safe: …; the limits panel opens, closes and hides" (click, Shift+L, Hide and back). |
| `prompt-images.spec.ts` "terminal: a plain shell says an image can’t be pasted there and nothing is typed" | deleted | `src/laptop/pasteImages.test.ts` "a plain shell says it cannot take an image; nothing is uploaded, nothing is typed"; text paste in a terminal: `src/laptop/keys.test.ts`. The seat bar note, its error state and the error toast of a refused terminal paste stay in "terminal: a failed upload (Drop Zone down), a refused file and a pending upload: …" (kept, extended, the issue's one no-send-on-failure check); the paste-to-command integration "terminal: an image pasted at an agent’s laptop …" is kept. Not covered below the browser any more: the plain shell is told apart by the worker's `agent_kind` (`src/laptop/index.ts`, one line). |
| `h124-fields.spec.ts` "the table binds the letters and digits the field tests type" | moved | `src/input/shortcuts.test.ts` "binds the characters the field tests type: …" (it opened no browser). The typing-in-fields cases stay. |

### Left in extended on purpose

The issue's further candidates (`m10-limits.spec.ts`' permutations, the editor permutations across `composer*`,
`hire-composer` and `prompt-images`, `m59-themes` / `h172-ubuntu` font checks, the overview label specs, the
`h157-async-questions.spec.ts` 290 / 303 / 320 / 340 / 883 px widths and `m16-ask.spec.ts`' three viewports) need a
scenario-by-scenario check against their bug history. They are out of the smoke run already and stay in `extended`
unchanged; none was deleted without that check.

### Known failures (#32, #34, #35, #36)

Moving a test does not fix its bug. Where each one is now:

| Issue | Test | Profile |
| --- | --- | --- |
| #32 whiteboard save / upload race (load-dependent 422) | `m13-whiteboard.spec.ts` "draw, close, reload: …" | **smoke** (the issue's whiteboard journey): it can fail a smoke run under load until #32 is fixed |
| #34 Codex 0.163 fallback / version | `h155-codex-server.spec.ts` "a hire that falls back to Codex’s built-in server is a warning, not an error" | extended |
| #35 stale "shown in Hire" copy | `h194-harness-models.spec.ts` "a model hidden in Settings leaves the Hire dialog, …", "every model of the harness hidden: …" | extended |
| #36 limits panel at 390x640 | `m10-limits.spec.ts` "at 390x640 an open panel folds away while a dialog is open, and comes back when it closes" | extended |

## Verification of the migration

- Unit: `make lint`, `make test` (Vitest 221 files / 2824 tests, Go, shell) pass; the touched Vitest files
  (`src/ui/uiTheme.test.ts`, `src/ui/themePrefs.test.ts`, `src/ui/composer/composer.test.ts`, `src/input/shortcuts.test.ts`)
  each pass alone.
- Browser, scoped (`make e2e-prebuilt`, the lock and a leased port): every test of `composer`, `composer-complete`,
  `h124-fields`, `m6-crew` (both split cases) and `m98-monitor` (both split cases): 49 passed. `ui-theme.spec.ts`
  extended: 32 passed (9 audits, 23 others, including the merged storage / limits case). 12 `@visual` audits
  (toast-info, palette, menu, elevator at all three sizes): passed. `m10-limits` and `prompt-images` whole: 48 passed,
  3 failed, all three older than #42 and in the #241 bench history: `m10-limits` "at 390x640 an open panel folds away …"
  (#36, every bench run), "seated on a narrow viewport the glass leaves no gutter: …" (failed at 16 workers in the
  bench) and `prompt-images` "Start Run: a screenshot pasted in Extra instructions is a chip; …" (the same
  "The run is starting." ack poll as the two hire flakes above, in 4 bench runs).
- The other spec files changed only by a tag: every profile lists them (`make e2e-list`, the module loads) and their
  `@smoke` tests passed or failed as above in the measured run.
