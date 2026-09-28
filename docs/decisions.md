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
