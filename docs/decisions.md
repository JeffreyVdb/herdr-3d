# Decisions log

## 2026-09-28 — answers to server-model open questions

| # | Question | Decision |
|---|---|---|
| 1 | Which devices may connect to the bridge? | Any device that has SSH access to the herdr server (devbox). Auth = SSH access, not a Tailscale device allowlist. Primary target: **great performance on MacBooks** (M2 Max). |
| 2 | Which terminal app on the Mac? | **Ghostty**. Used for "open in real terminal": game launches Ghostty running `herdr --remote dev@devbox --session <s>`. |
| 3 | How to show stopped sessions? | Workers **sleeping behind their desks (zZz)**. |
| 4 | "Fire" semantics / visual | Worker takes their laptop and **leaves the building carrying a cardboard box with their stuff**; workspace is closed. |
| 5 | Initial building seeding | **Manual**: user creates buildings and assigns sessions to them. |
| 6 | Bridge language | **Go** (fast compilation, good performance). |

Implications:
- (1) Bridge listens on localhost / a 0600 unix socket on the server only; clients reach it through an SSH tunnel. Anyone who can SSH in is authorized; nothing is exposed on the tailnet directly.
- (1)+(2) A plain browser tab cannot open an SSH tunnel or launch Ghostty → likely thin native shell (e.g. Tauri) or a small Mac helper. Pending follow-up research.

## 2026-09-28 — answers to engine open questions

| # | Question | Decision |
|---|---|---|
| 1 | Browser-based game OK? | Yes, **if performance is acceptable** on MacBooks (to be proven by benchmark). |
| 2 | Install `playwright-core` on the Mac (~/h3d-tools)? | **Approved.** |
| 3 | Install mesa on the server? | Approved if useful. Only needed for Godot pixel output on server, or possibly WebGPU-backend screenshots via lavapipe; not needed for the three.js WebGL2 test path. |
| 4 | Art style | **Cartoon, "Minions"-like**: small, round, goofy workers. Original characters inspired by that vibe — no Illumination/Minions IP (names, exact designs, likeness). |

## 2026-09-28 — write-code skill

| # | Question | Decision |
|---|---|---|
| 1 | Add h3d metadata conventions to write-code skill? | **Yes, small edits only — skill must stay lean and simple.** Design pending write-code verifier (80-char token value limit). |
| 2 | gpt-5.6 vs gpt-6 in research section | **gpt-6.** Fixed in `~/.agents/skills/write-code/SKILL.md` (lines 146-147). |
| 3 | Over the 3-pass review cap | Orchestrator worker **sweats, red clock above desk, "needs you" bubble**. |
| 4 | Codex vs Claude ORCH run-dir location | Bridge scans both locations. |
- write-code skill edit **applied**: "Game metadata (herdr-3d)" section — run id + durable run dir `~/.local/state/write-code/runs/<run_id>/`; `h3d_*` tokens on ORCH (role/run/phase/pass) and workers (role/run/round/report basename/harness/model/effort). Parent link = shared `h3d_run`. Backup of original in orchestrator scratchpad.

## 2026-09-28 — Ghostty + herdr upgrade

- **Ghostty is optional**, not part of the core loop. herdr servers run headless on the server; all play happens in-game
  (live laptop screens, prompt/approve/keys through the bridge). Ghostty only backs an optional "open raw terminal" button.
- **herdr 0.9.1 upgrade approved.** Mac upgraded via brew (0.9.0 → 0.9.1). Server `herdr update` refuses to run inside a
  herdr pane → Theo runs it from a plain SSH shell, then `herdr integration install claude`.

## 2026-09-28 — architecture proposal decisions

| # | Question | Decision |
|---|---|---|
| 2 | Mac shell | **Go helper + Chrome `--app` window.** Tauri deferred. |
| 3 | Frame-rate policy | **Agreed**: 120 Hz interacting, 30–60 Hz idle, paused when hidden, battery-saver toggle. |
| 4 | Worker art | **Procedural rigid-part workers** now; hand-modelled Blender parts optional later. |
| 5 | Godot benchmark | **Skip.** three.js stays. |

## 2026-09-28 — identity marker, build team, repo

- **Pane-label identity marker** (`h3d-<short uuid>` on each worker's root pane): **approved**.
- **Build team** (write-code): coders = claude `claude-opus-5-5` effort medium; reviewers = codex `gpt-6-sol` reasoning high.
- **Repo**: own git repo at `herdr-3d/`, private GitHub repo `JeffreyVdb/herdr-3d` + GitHub Project.

## 2026-09-29 — M6b (#28): arrival style and the desk monitor

| # | Question | Decision |
|---|---|---|
| 1 | Drop from the sky, or step out of a void? | **Drop from above.** The hire falls into its chair from 1.6 m over the seat (0.36 s, a little stretched, its shadow growing on the seat), lands flattened, springs back and settles, with a puff of dust round the chair: 0.85 s in all, one `drop` phase. It suits the cartoon crew and needs no new material (a portal wants transparency and a shader). The desk is the worker's from the first frame (never `away`): look-at, the card, sitting at its screen and prompts work while it plays; only the figure moves. Only the floor you are on shows it; anywhere else it resolves at once. |
| 2 | Where the monitor sits, how big | **Centred, facing the chair; the dock on the pod's outer side.** Glass 0.74 × 0.40 m (a 32" monitor; the M5 lid was 0.31 × 0.2) under the worker's hat line: its top is at 1.17 m, so the hat (the model cue) shows over it from across the pod, and the cards (1.62 m) and the empty desk's "+" (raised to 1.45 m) stay clear. The docks sit at the pods' outer corners, so every docked laptop's lid (and sticker) faces an aisle; the worker's photos, mug and plant stand on the other side, towards the neighbour. |
| 3 | Readable at a glance | Standing, a monitor shows the **glance view**: the last lines that say something (no blank rows, empty frames or agent footer), wrapped at 22 columns, 5 lines, bold and lifted to 4.5:1, under a status bar with the status's word. At the Mac's 3024 × 1890 that is ~12 px text at 4 m, ~16 px at 3 m. Straight behind a worker its own body hides its monitor (it sits right in front of it), so monitors read diagonally along the aisles. Seated, the whole terminal. |
| 4 | A new worker at a desk someone is still leaving | **The walk-out gives the desk up for good.** The bridge frees a desk as its worker goes, so a hire (or a freelancer re-seated by its orchestrator) can land on it while the old worker is still packing. From the moment the world seats someone else there, the older walk never shows that desk `away` again, not even after the 0.85 s drop is over (`Arrivals.yieldDesk`). It gets up and walks off at once (no more packing or waving in the new worker's chair); its box keeps what it had packed, the laptop on top, and the rest of the desk's things stay put as the new worker's. |
