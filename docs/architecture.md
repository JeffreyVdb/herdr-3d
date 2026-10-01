# herdr-3d — architecture proposal (v1)

Status: proposal, 2026-09-28. Synthesised from `docs/research/*` (4 grounding docs, 4 verifications, 3 follow-ups)
and `docs/decisions.md`. Where a verifier and a follow-up disagree, the one with the live test wins; see the linked docs.

## 1. The world

| Game | herdr | Source of truth |
|---|---|---|
| City | herdr server host `devbox` | bridge |
| Building ("Personal", "Work") | group of sessions — **not a herdr concept** | bridge SQLite (created manually) |
| Floor | herdr session | `herdr session list` + per-session socket; stopped sessions from `~/.config/herdr/sessions/<name>/session.json` (v3) |
| Worker at a desk | herdr workspace (its agent pane) | `session.snapshot` + `events.subscribe` |
| Laptop screen | agent pane terminal | `herdr terminal session observe <pane>` (read-only ANSI frames) |
| Freelancer | write-code worker (`GROUND/CODE/REVIEW/UX`) | `h3d_*` workspace tokens + `~/.local/state/write-code/runs/<run_id>/` |
| Board wall (issues Kanban, pull requests) | the floor's issue tracker and code host — GitHub today (Issues, Projects v2, PRs), later files in the repo or Monday.com | the provider, through the bridge's neutral `tracker` / `codehost` interfaces; last good boards, open PRs and announced merges cached in bridge SQLite |
| Building logo (entrance sign, reception wall, city sign) | an image the user picks for a building | bridge SQLite (`building_logo`: the normalised PNG); the building carries its hash |
| Whiteboard (north wall of every floor) | an Excalidraw board shared by the floor, agents pin on it (M14) | bridge files, `~/.local/share/herdr-3d/whiteboards/<floor>/` (versioned scenes, images by sha256, `render.png`) |
| Plan limits meter (top-right widget) | the Claude and Codex plan windows (5 h, week, per model) | the `claude` / `codex` CLIs, run as probes by the bridge (`internal/limits`), only while a client is connected |

Worker states → animation:

| State | Visual |
|---|---|
| working | typing, screen flicker |
| idle / done | leaning back, coffee; `done` (unseen) gets a little "!" |
| blocked / `input_required` | hand raised, speech bubble |
| session stopped | floor lights off, workers asleep at desks (zZz) |
| hired | drops in to its chair from above (M6b; walked in until then), its laptop in the desk's dock |
| fired | packs a cardboard box (its things off the desk, the laptop out of its dock), walks out |
| freelancer finished | waves, leaves with briefcase; verdict stamp (PASS / CHANGES_REQUIRED) |
| ORCH over 3-pass cap | sweating, red clock over desk, "needs you" bubble |

## 2. Topology

```
MacBook (M2 Max)                                   devbox (Linux)
┌──────────────────────────────┐   ssh -N -L    ┌───────────────────────────────────────────┐
│ Chrome --app window          │  (OpenSSH →    │ herdr-world (Go, systemd --user)          │
│  http://127.0.0.1:7777       │  Tailscale SSH,│  • 0600 unix socket                       │
│  three.js game (WebGPU)      │  ControlMaster │    /run/user/1000/herdr-world/bridge.sock │
│        │ ws /ws              │  =no)          │  • SQLite: buildings, floors, workers,    │
│ h3d-helper (Go, launchd)     │═══════════════▶│    avatars, hire history, audit log       │
│  • owns + supervises tunnel  │                │  • per session: lifecycle subscription,   │
│  • serves game bundle        │                │    per-pane status subs, snapshot, observe│
│  • proxies /ws (Host/Origin/ │                │  • starts sessions via systemd-run        │
│    token checks)             │                └──────────────┬────────────────────────────┘
│  • (optional) opens Ghostty  │                               │ local unix sockets
│    for a raw terminal        │                ┌──────────────▼────────────────────────────┐
└──────────────────────────────┘                │ herdr session servers (one per session)   │
                                                │  ~/.config/herdr/sessions/<s>/herdr.sock  │
                                                └───────────────────────────────────────────┘
```

- **Auth = SSH access** (decision 1). Nothing listens on the tailnet. Tunnel overhead measured ~0 ms (RTT 22–24 ms).
- Game is served from Mac `localhost` → secure context → WebGPU works. A plain `http://devbox:…` origin silently
  falls back to WebGL2 (verified), so never use it for real play.
- The helper's tunnel must use `-o ControlMaster=no -o ControlPath=none`: a tunnel that becomes the shared ControlMaster
  gets killed along with everyone's multiplexed sessions (happened during research, see §7).

## 3. Server: `herdr-world` bridge (Go)

- **Discovery**: `herdr session list --json`; `herdr.sock` existing ≠ running — probe it.
- **Live state per running session**: one `events.subscribe` lifecycle stream + per-pane `pane.agent_status_changed`
  streams; bootstrap with `session.snapshot` (arrays in `result.snapshot`, includes agents) *after* subscribing; 30 s
  safety re-snapshot; re-snapshot on any stream EOF. Unfiltered status subs send no initial event; `workspace.closed`
  may lack the final snapshot; event latency is not bounded at 100 ms.
- **Stopped sessions**: parse `session.json` (guard `version==3`, tolerate unknown fields) for the sleeping floor.
- **Wake a floor**: `systemd-run --user --unit=herdr-s-<name> --collect -p KillMode=process /bin/fish -l -c 'exec herdr --session <name> server'`
  (login env → API-key wrappers, no CLAUDE* leakage). Agents auto-resumed in tests without a client attached; still
  confirm each, with a fallback. herdr 0.9 restores a pane's agent before it runs and sends no `pane.agent_detected` for
  a resume (M3, verified live), so the bridge confirms by the pane's foreground process (`pane process-info`) or a
  detection naming the agent; a detection without an agent means it exited. Codex may need `pane report-agent-session`
  to backfill its id. Sleep = `herdr session stop`. Details: `protocol.md` "Wake and sleep".
- **Hire** (M4, built; details in `protocol.md` "Hire and send home"): the desk is reserved and the worker id minted
  first; `workspace create --cwd … --label … --no-focus`, or for a worktree `git fetch origin` (a failed fetch refuses the hire: `fetch_failed`) then `herdr worktree
  create --cwd <repo> --branch h3d/<name>-<id6> --base origin/<default> --label … --no-focus` (never the local HEAD,
  agent-office #119) → the workspace is bound to that id (so it sits at the chosen desk) → pane-label marker
  `h3d-<12 hex>` → `agent start <name>-<id6> --kind claude|codex --pane … -- <args>` through the shell pane (fish
  wrappers apply) → answer the trust dialog → optional first prompt. Capacity caps per floor and host (soft: warn,
  hard: refuse); a worktree hire counts one: the repository's main checkout herdr may open with it holds only a shell and is hidden (not a worker) while it has no agent and a worktree of the repository is open. The branch is
  recorded as the bridge's for that worker (SQLite `hire_branch`, with its base commit). A failed hire rolls back:
  the workspace closes; the checkout goes only if clean, the branch only if still at its base; then the idle main checkout herdr opened for it is closed too.
  - claude: `--model claude-opus-5-5|claude-fable-5-1|claude-sonnet-5-5 --effort low|medium|high|xhigh|max --permission-mode bypassPermissions --name <label>`
  - codex: `-m gpt-6-sol|gpt-6-luna|gpt-6-astra -c model_reasoning_effort=low…max (+ultra sol/astra) --dangerously-bypass-approvals-and-sandbox`
  - Native args are not persisted by herdr → bridge stores harness/model/effort, `hired_at`, the desk, and the last
    choice per floor (the dialog's default when the floor has no `default_hire`).
  - Trust dialog (verified live, herdr 0.9.0): both agents ask about a folder they have not seen, and a fresh worktree
    always is one. Claude's dialog makes `agent start` fail with `agent_not_ready` (`blocked`); Codex's is not detected
    (herdr says `idle`). `herdr worktree create --trust-repository` is herdr's own git trust and does not help. The
    bridge reads the screen and answers the dialog only when it names the hired directory as a whole path (not a
    sibling or parent; long paths are unwrapped first) — Claude Down + Enter, Codex Enter.
    Right after that, Claude drops an Enter for a few seconds: the prompt and `/exit` press Enter again.
- **Fire (gentle)** ("Send home", M4, built): git state first (`status --porcelain`, `rev-list --count HEAD --not
  --remotes`; a worktree is deleted only when clean and pushed) → claude `/exit` (~1.3 s) / codex `/quit` + pause +
  Enter (~0.5 s) → confirm the agent released (pane back at its shell; Enter again, then Ctrl-C; still running →
  `fire_failed`, nothing closed) → `workspace close` (or `worktree remove`, + `git branch -D` of the branch recorded
  for that worker, only while the checkout is on it and its commits are on a remote) → `worker.removed` with
  `reason: "sent_home"`. Never for sleep: a
  graceful exit drops `agent_session` so it can't resume. herdr closes a main checkout with open linked worktrees only
  as a group; the bridge refuses that instead (for a main checkout with an agent: an agentless one is hidden). When the last bridge-hired worktree of a repository is sent home, its idle main checkout is closed too (`workspace close`, best effort).
- **Boards** (M7, built; details in `protocol.md` "Boards: issues and pull requests"): a floor with an effective repo
  has an issue board and a pull request board. The bridge talks to them only through two small neutral interfaces
  (`internal/tracker`, `internal/codehost`; opaque item ids, provider-defined columns, capability flags, optional URL
  and comments): the poller, the SQLite cache, the commands and the audit sit above them and never import a provider,
  and the wire has nothing GitHub-shaped. **GitHub** is the only provider (`internal/github`, behind the typed `gh`
  runner `internal/githubcli`: the one shape `gh api graphql --method POST --input -`, a fixed set of embedded
  documents, `gh`'s own login, clean environment): one GraphQL feed per repository and project (open issues and the
  ones closed in the last 7 days, the Status field's options as the columns, open PRs with checks, review and
  mergeability, and the merge state of the PRs that were open at the last poll), about 12 points a poll. Per floor:
  polled every 60 s while a connection watches it (`board.watch`), every 10 min otherwise; a failed poll keeps the last
  good data and marks it stale; a merge rings once (open at one poll, merged at the next; announced merges are in
  SQLite); a rate policy backs off before the limit. Writes (comment, close, set status, PR comment, merge, open a PR
  for a plain worker's `h3d/…` branch after `git push`) are typed commands with confirmation, the merge gate
  (green checks and mergeable, or a doubly confirmed override), capabilities, and audit rows without bodies.
- **Building logos** (M3d, built; details in `protocol.md` "Building logos"): a building can carry a logo, stored by the
  bridge itself (no remote URL, so the game never loads an image from a third-party host, it works offline and through
  the helper). Upload, clear and fetch are HTTP on the bridge socket, `PUT|DELETE|GET /logo/{building}`, not WebSocket
  commands (a message is capped at 256 KiB, a logo may be 1 MiB); `h3d-helper` proxies them behind the same token as
  `/ws`. `internal/logo` (pure Go: stdlib PNG, `x/image` WebP and Catmull-Rom, oksvg for a checked SVG subset) turns PNG,
  WebP or SVG into one alpha PNG of at most 1024 px, the bridge keeps those bytes and their sha256, and the
  `building.upsert` carries only the hash. Two conversions at a time, a wait limit, and everything checked before the
  costly step (size, pixel budget, SVG allowlist sanitiser). Drawing an SVG cannot be bounded from its source, so it runs
  in a child process, the bridge's own executable in a hidden worker mode, that is killed at a 5 s deadline: the sanitiser
  decides what a document may contain, the killed process what it may cost. PNG and WebP are decoded in the bridge. Clients fetch by hash (`?h=`, immutable when current) and keep one
  texture per hash.
- **Image upload** (#51, built; details in `protocol.md` "Image upload"): a screenshot pasted into a prompt reaches the
  agent as a file path. `POST /upload` (raw bytes, one image) is HTTP on the bridge socket, like the logos: `h3d-helper`
  guards it and proxies it, the bridge (`internal/upload`) sniffs the type, caps 25 MiB on the bytes and streams it as
  one multipart request to **Drop Zone** (`--dropzone-url`), which stores it and answers the absolute path; the game puts
  the path in an `[Image #n: <path>]` marker. Nothing is held in memory and nothing is stored for a refused or aborted
  image. #64: every prompt field mounts the same composer (`game/src/ui/composer/`) and sends the marker inside its
  text: hire, Start Run (Extra instructions and First prompt), the transcript view's prompt box and the P overlay; a paste
  at a laptop's terminal goes through the composer's draft without a view (`laptop/pasteImages.ts`). The bridge treats a
  marker as text on every command (`protocol.md` "Markers in prompts").
- **Whiteboard** (M13 #15, built; details in `protocol.md` "Whiteboard"): E on a floor's whiteboard opens Excalidraw
  (React 19), loaded by one dynamic import on the first open (`game/src/whiteboard/load.ts`; `tools/check-bundle.ts`
  fails the build when it reaches the entry chunk), its fonts served by the game. The bridge (`internal/whiteboard`,
  files, not SQLite) keeps each floor's scene versioned (the last 20), image files once by sha256 and the client's PNG
  render, which the room's board shows. The bytes are HTTP on the bridge socket (`/whiteboard/{floor}/…`, a save is scene
  plus render on a base version, `409` on a stale one and the client merges with Excalidraw's `reconcileElements`); the
  WebSocket has `whiteboard.get` / `.clear` / `.pin` and `whiteboard.updated`. Agents' pins are complete Excalidraw
  elements made in Go; until a client renders the board again the render is stale and the pins are listed beside it.
  `drops.list` reads Drop Zone's newest files for "Pin a drop".
- **Identity**: bridge-owned worker UUID; reconcile after restarts via persisted pane-label marker (written by the bridge
  on the workers it hires) → `agent_session` id → label+cwd → else new worker. Tokens vanish on herdr restart and workspace ids can be reused: re-apply tokens only
  after reconciliation.
- **Freelancers**: `h3d_role/run/round/report/harness/model/effort` tokens (write-code skill, applied), parent link =
  shared `h3d_run`; reports at `~/.local/state/write-code/runs/<run_id>/<h3d_report>`. Fallback: label regex
  `^(ORCH|CODE|REVIEW|UX|GROUND)\|…`.
- **Terminal screens**: `herdr terminal session observe` per watched pane only (on demand), bounded queues, kill stalled
  observers (0.9.0 has no 30 s stall timeout), reconnect → request full frame. #74: a laptop of a split pane is fullscreen:
  `terminal.watch{fullscreen}` zooms the pane's tab (herdr pane zoom, two allowlisted writes, audited) while it is
  watched and puts it back when the last fullscreen watch of the tab ends; `terminal.state` / `terminal.zoom` keep the
  seat bar true (docs/protocol.md "Fullscreen", docs/decisions.md 2026-10-01).
- **Security**: bridge = shell as dev. Narrow typed commands only (no raw exec): `herdr.Control`'s allowlisted shapes
  for herdr and `gitops`' for git, every variable validated and its own argv element. Confirm destructive ones in UI,
  audit log (hire, fire and cleanup choices with every step).

## 4. Protocol (WebSocket, JSON, versioned)

- `hello{proto, client}` → `welcome{proto, server_seq}` → `world.snapshot` (or replay since `seq` on reconnect).
- Events: `building.*`, `floor.upsert/removed`, `worker.upsert/removed`, `worker.status`, `freelancer.report`,
  `terminal.frame{pane, full|diff, ansi_b64}`. M7: `board.issues` / `board.prs{provider, initial, fetched_at, stale,
  columns, cards | prs, merged}` are connection-scoped like `terminal.frame` (no `seq`, not in the replay ring or the
  snapshot); workers carry `work_item{provider, id}` next to `issue`.
- Commands (each with `req_id`, ack/err): `building.create/rename/delete`, `floor.assign`, `floor.wake/sleep`,
  `worker.hire{floor, harness, model, effort, label, cwd}`, `worker.fire`, `worker.prompt`, `worker.keys`,
  `terminal.watch/unwatch/zoom`, `terminal.open` (see below). M7: `board.watch/unwatch/refresh`, `issue.get/comment/close/
  set_status`, `pr.get/comment/merge`, `worker.open_pr.prepare/open_pr`; `run.prepare/start` take a `work_item`.
- **Open in Ghostty (optional escape hatch, not needed to play)**: all normal interaction happens in-game —
  laptop screen = live read-only terminal via `observe`; prompts, approvals and keys via `worker.prompt` / `worker.keys`.
  herdr servers run headless on the server; nothing on the Mac needs a terminal. Only for "let me type in the raw
  pane myself": bridge `agent.focus` → helper immediately opens a new Ghostty window via AppleScript
  `new window with configuration` + `command "herdr --remote dev@devbox --session <s>"` (fresh attach lands
  on the focused workspace, 5/5 in tests; `+new-window` unsupported on macOS). Exact-pane alternative:
  `ssh -t … herdr --session <s> terminal attach <term_id>` (0.64 s). Focus marks `done` as seen — acceptable.
  herdr 0.9.1 also makes focus move attached clients.

## 5. Mac: game client

- **three.js r186 + TypeScript + Vite**, `WebGPURenderer` (auto WebGL2 fallback), HTML/CSS menus (hire dialog:
  harness → model → effort), xterm.js 6 for laptop screens (render to texture only for the focused desk).
- **Workers**: original procedural rigid-part characters (capsule body, goggle + strap, tiny limbs), one `InstancedMesh`
  per part, animation in code. Measured on M2 Max at 3024×1890 with shadows: **240 workers 1.2 ms/frame pipelined,
  600 workers 3.1 ms** (Chrome 153 WebGPU); 120 Hz budget is 8.33 ms. Skinned Kenney: 4.9 ms @240, 14 ms @600.
  Non-instanced meshes: 17–25 ms → **everything repeated must be instanced**.
- **Frame-rate policy**: 120 Hz while interacting, 30–60 Hz idle, paused when hidden, battery-saver toggle.
  Instancing + frame-rate policy dominate battery use (energy at 120 fps: rigid +26 vs skinned +67, `top` power).
- **Shell**: Chrome `--app` window on the helper's localhost URL. Chrome runs 120 Hz natively (even on battery), and it is
  the same browser the test loop uses. Tauri 2 stays an option for later; WKWebView is 0–25 % slower and needs a private
  WebKit toggle for 120 Hz.
- **Logos** (M3d): the entrance sign on the lobby canopy and the reception wall show the logo letterboxed on their own lit
  plate (the name board is hidden, not rebuilt); the city has a small tilted sign on the pavement in front of the building,
  its plate and logo dimmed while every floor sleeps (a sleep or wake rebuilds the city and its signs, as it does the
  rest of the city; the textures are not reloaded, the cache holds them by hash). One mipmapped, premultiplied texture per hash in a
  shared cache, one instanced draw for the city's plates and one quad per logo. A failed fetch leaves the name. Accent
  colours taken from the logo for a canopy stripe were left out.
- **Fonts** (#59): the HUD, panels and dialogs are Recursive. Three hard-coded presets (Terminal: Departure Mono +
  Archivo; Quiet, the default: JetBrains Mono + Atkinson Hyperlegible Next; Paper: Space Mono + Newsreader), each a
  mono font, a prose font and colours, picked apart for the laptop's transcript (its fonts and colours, and every
  `--font-mono` on the page) and for its terminal canvas (font and screen colours). Only Quiet's fonts come with the
  app: another preset's stylesheet (Latin-only `@font-face`s, split by Vite) loads when it is first picked, and the
  canvas repaints once its faces have loaded. Each view has its own font zoom (70–200 %); the HUD does not zoom.
  Every shipped font's licence goes with the build in full (`FONT_LICENSES.txt` next to the bundle, from
  `src/ui/fontCredits.ts`; the OFL and the Bitstream Vera licence ask it), linked from the credits panel, which keeps
  each font's copyright line.
- **Day and night** (M17): the game follows the viewer's local time, in the browser, with no bridge or protocol part.
  `game/src/world/daylight.ts` (pure) turns an instant, an IANA zone and an optional latitude into a daylight value
  0…1, the sun's altitude and bearing, a dawn/dusk warmth and the zone's clock; with a latitude the sun comes from the
  declination and the hour angle (solar noon at 12:00 standard time, no longitude), without one from a fixed curve
  (dawn 06:30–08:00, dusk 18:30–20:00). The zone and latitude are client settings (About; `?tz=`, `?lat=` for a page
  load), `?time=` pins the hour for tests and screenshots. The light is read about once a minute and eased over a few
  seconds. The scenes keep one light set and change only colours and intensities (three.js rebuilds pipelines when
  lights come or go): the sky, fog, sun and sky light, a runtime tint of the baked street (no night bake), warm panes on
  running floors, lamp pools, and in the office two non-shadow spot lamps that take over at night. An office wall clock
  shows the time and date. Decisions and the measured cost: `docs/decisions.md` (M17).
- **Assets**: Kenney (CC0) furniture / props. Quaternius: check the license per pack (QAL 2026-08-28 on new packs), and don't
  commit QAL files.
- **Music (M15, the lounge radio)**: real tracks by other artists, licensed per track. A track goes in only if its own
  page grants commercial use, use in a game we sell and redistribution in the game files: **CC0**, **CC BY** (the exact
  credit recorded) or a written / purchased license that names games. Never NC or ND, nothing for "YouTube / creators
  only", nothing ambiguous. Rejected for a sold game: NCS, StreamBeats and Uppbeat Basic (their free terms cover videos,
  not games), Incompetech and Josh Woodward (tracks pre-registered in Content ID), and **Tobu until Jeffrey has a signed
  grant** (his own pages say games need permission). Each recording is one row of `game/music/manifest.json`: source and
  download URLs, license and its URL, the attribution string, the archived proof page (`game/music/proof/`), the source's
  sha256, and the transcoded file's length and loudness. Each row also has a **claim status**: `cleared` (the publisher
  says in writing the track is not registered for fingerprinting; the statement is archived) or `hold` (license fine, claim
  status unverified: fine in dev builds). Streamers of the game would be claimed on a registered track, so **a release build
  must fail while any row is `hold`** (`pnpm -C game music --check --release`, and `H3D_RELEASE=1 vite build`). The audio
  itself (~2.5 MB a track: Ogg Opus, 96 kb/s, normalised to -16 LUFS) is not committed: `pnpm -C game music` fetches
  and transcodes it into the git-ignored `game/public/music/`; the manifest, the lock (source and output hashes) and the
  proof pages are committed. Credits: a Music credits panel in the sound control and `MUSIC_CREDITS.txt` next to the build
  output, both generated from the manifest. Sources and license findings: issue #30.

## 6. Dev / test loop (no Claude Code on the Mac)

1. Agents work on the server: `vitest` for logic; Playwright Chromium headless with **WebGL2 on mesa lavapipe/llvmpipe**
   (installed; 3.6× faster than SwiftShader) for screenshot tests. WebGPU screenshots don't work on the server.
2. Metal verification: agent runs `ssh -o ControlMaster=no devmac` → `-L` forward of the Vite port →
   headless Chrome via `~/h3d-tools` (playwright-core installed) → scp PNG + timing JSON back. Assert the backend
   `webgpu` + adapter `apple/metal-3` in results.
3. Theo plays via the helper + Chrome app window; the helper can point at the Vite dev server during development.
- Harness from research: `docs/research/engine-bench/` (reusable for perf regression checks).

## 7. Risks & notes

- **Incident (research)**: an `ssh -L` on the Mac became the shared ControlMaster (`ControlMaster auto`) and was killed
  during cleanup. Plain ssh sessions opened on the Mac ~12:44–13:00 may have dropped; `herdr --remote` clients were
  unaffected. Mitigation baked into §2.
- `session.json` format is internal → version guard + tests with fixtures.
- herdr 0.9.0 → 0.9.1: API same (+`pane.link.resolve`), adds observer stall timeout, focus moves clients, stricter
  session delete. Upgrade recommended (server `herdr update` without `--handoff`, Mac via brew, reinstall Claude integration).
- Bare `herdr server` starts are flagged as not surviving SSH loss → only start sessions via systemd-run.

## 8. Milestones

| M | Deliverable | Verifiable by |
|---|---|---|
| 0 | Repo scaffold: `bridge/` (Go), `helper/` (Go), `game/` (Vite+TS), CI-ish `just` targets | builds on server, cross-compiled helper runs on Mac |
| 1 | Bridge read-only: sessions (running + stopped), workspaces, agents, status stream, SQLite buildings | Go tests with recorded fixtures; `wscat` shows live snapshot + events |
| 2 | Helper tunnel + game renders city → building → floor → desks from live data, states animated | Playwright screenshots (server) + Mac Metal run |
| 3 | Buildings UI (create manually, assign sessions), wake/sleep floors | e2e on throwaway sessions |
| 4 | Hire menu + gentle fire | e2e on throwaway session; audit log entries |
| 5 | Laptop screens (observe) + in-game prompt/approve/keys; optional "open in Ghostty" button | manual + frame-stream tests |
| 6 | Freelancers: write-code runs, parent links, verdict stamps, over-cap orchestrator | run a real `/write-code` on a lab repo |
| 7 | Issues Kanban + Pull Requests board (GitHub behind neutral interfaces): board wall, merge gong, issue → worker, review with a worker, open PR | fake-runner GraphQL fixtures; private bridge against `JeffreyVdb/herdr-3d` (read) and the lab repo (writes) |
