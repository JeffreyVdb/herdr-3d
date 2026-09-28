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

Worker states → animation:

| State | Visual |
|---|---|
| working | typing, screen flicker |
| idle / done | leaning back, coffee; `done` (unseen) gets a little "!" |
| blocked / `input_required` | hand raised, speech bubble |
| session stopped | floor lights off, workers asleep at desks (zZz) |
| hired | walks in, sits, opens laptop |
| fired | packs a cardboard box, takes laptop, walks out |
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
  hard: refuse); a worktree hire counts two when herdr will open the repository's main checkout too. The branch is
  recorded as the bridge's for that worker (SQLite `hire_branch`, with its base commit). A failed hire rolls back:
  the workspace closes; the checkout goes only if clean, the branch only if still at its base.
  - claude: `--model claude-opus-5-5|claude-fable-5-1 --effort low|medium|high|xhigh|max --permission-mode bypassPermissions --name <label>`
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
  as a group; the bridge refuses that instead.
- **Identity**: bridge-owned worker UUID; reconcile after restarts via persisted pane-label marker (written by the bridge
  on the workers it hires) → `agent_session` id → label+cwd → else new worker. Tokens vanish on herdr restart and workspace ids can be reused: re-apply tokens only
  after reconciliation.
- **Freelancers**: `h3d_role/run/round/report/harness/model/effort` tokens (write-code skill, applied), parent link =
  shared `h3d_run`; reports at `~/.local/state/write-code/runs/<run_id>/<h3d_report>`. Fallback: label regex
  `^(ORCH|CODE|REVIEW|UX|GROUND)\|…`.
- **Terminal screens**: `herdr terminal session observe` per watched pane only (on demand), bounded queues, kill stalled
  observers (0.9.0 has no 30 s stall timeout), reconnect → request full frame.
- **Security**: bridge = shell as dev. Narrow typed commands only (no raw exec): `herdr.Control`'s allowlisted shapes
  for herdr and `gitops`' for git, every variable validated and its own argv element. Confirm destructive ones in UI,
  audit log (hire, fire and cleanup choices with every step).

## 4. Protocol (WebSocket, JSON, versioned)

- `hello{proto, client}` → `welcome{proto, server_seq}` → `world.snapshot` (or replay since `seq` on reconnect).
- Events: `building.*`, `floor.upsert/removed`, `worker.upsert/removed`, `worker.status`, `freelancer.report`,
  `terminal.frame{pane, full|diff, ansi_b64}`.
- Commands (each with `req_id`, ack/err): `building.create/rename/delete`, `floor.assign`, `floor.wake/sleep`,
  `worker.hire{floor, harness, model, effort, label, cwd}`, `worker.fire`, `worker.prompt`, `worker.keys`,
  `terminal.watch/unwatch`, `terminal.open` (see below).
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
- **Assets**: Kenney (CC0) furniture / props. Quaternius: check the license per pack (QAL 2026-08-28 on new packs), and don't
  commit QAL files.

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
