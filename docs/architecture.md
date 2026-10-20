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
| Board wall (issues Kanban, pull requests) | the floor's issue tracker and code host, chosen apart — GitHub (Issues, Projects v2, PRs) or, #184, a Kaneo project for the issues with GitHub's PRs when the floor has a repo; later files in the repo or Monday.com | the provider, through the bridge's neutral `tracker` / `codehost` interfaces; last good boards, open PRs and announced merges cached in bridge SQLite |
| Building logo (entrance sign, reception wall, city sign) | an image the user picks for a building | bridge SQLite (`building_logo`: the normalised PNG); the building carries its hash |
| Whiteboard (north wall of every floor) | an Excalidraw board shared by the floor, agents pin on it (M14) | bridge files, `~/.local/share/herdr-3d/whiteboards/<floor>/` (versioned scenes, images by sha256, the current render) |
| Floor overview screen (west wall of every floor's lounge) | the floor's workers as one tree: who works, who waits on you, orchestrators over their freelancers, each one's ticket, task and what it does now (#118); its page, and the all-floors page (#188): every floor of the city over its workers, each worker once, active only by default | derived in the game from the world (`world/overview.ts`); the task / now lines from the bridge's `digest` (each worker's transcript), the ticket titles from the floor's board provider |
| Plan limits meter (top-right widget) | the Claude and Codex plan windows (5 h, week, per model) | the `claude` / `codex` CLIs, run as probes by the bridge (`internal/limits`), only while a client is connected |
| Inbox chip (under the limits meter, #100) | the workers that need you, and the employees that are done, across every floor; a click opens the list (who, `Building › floor`, why, how long), a row sits you at that worker's laptop, on its conversation | derived in the game from the world (`world/inbox.ts`); the bridge keeps only the dismissed finished rows (#106: SQLite `inbox_dismissed`, `inbox.dismiss`, snapshot `inbox_dismissed`, event `inbox.dismissed`) |
| Inbox pings (#100) | a desktop notification and the chime when someone starts needing you or an employee finishes, with the game open (in front: the chip pulses, a toast) | the game, on live world changes (`world/inboxPings.ts`, `ui/desktopNotify.ts`: the page's `Notification`, no service worker or push server) |
| Telegram notifications (#11) | a message on your phone when a worker needs you or finishes, the game open or not | the bridge (`internal/notify`: the inbox rule ported from the game and pinned by shared vectors, the episodes and the 5 s done settle; `internal/notify/telegram`: the Bot API, the token in `telegram.json`, pairing by a one-time code); settings in SQLite `notify_settings`, Settings → Telegram |

Worker states → animation:

| State | Visual |
|---|---|
| working | typing, screen flicker |
| idle / done | leaning back, coffee; `done` (unseen) gets a little "!" |
| blocked / `input_required` (not resolved: #215) | hand raised, speech bubble |
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
- Game is served from Mac `localhost` → secure context → WebGPU works. A plain `http://<server>:…` origin silently
  falls back to WebGL2 (verified), so never use it for real play.
- The helper's tunnel must use `-o ControlMaster=no -o ControlPath=none`: a tunnel that becomes the shared ControlMaster
  gets killed along with everyone's multiplexed sessions (happened during research, see §7).
- **No machine is built in.** The helper keeps a list of bridges (#57, below) in a 0600 `bridges.json` next to its
  token; Settings → Bridges edits it. An install from before has none yet: on its first start the helper takes
  `H3D_HELPER_HOST` (and optionally `H3D_HELPER_REMOTE_SOCKET`; unset, it asks the host for `$XDG_RUNTIME_DIR` over
  ssh) from its flags or the environment (on the Mac the LaunchAgent's `EnvironmentVariables`) as the list's only
  entry, named after the host, in use; from then on the file is the truth. With neither, the helper starts and serves
  the game, which says to add a bridge. `h3d-update` finds the Mac through `H3D_MAC`, from the environment or the
  private `~/.config/h3d/update.env` on the server. Both live outside the repository; `deploy/update.env.example` and
  the plist's placeholders show the shape with fictional values, and `docs/releasing.md` has the procedure.

### N bridges (#57)

```
Chrome window ── /ws, /logo, /upload, /screen, /whiteboard, /drops, /healthz, /api/open ──▶ h3d-helper
                                                                                          │ BridgeSet: the one in use
  Settings → Bridges, ⌘P → Switch bridge ── /api/bridges (list, add, edit, remove, activate) ─┤
                                                                                          ├─ devbox  ssh -N -L <cache>/bridges/<id>-<n>.sock (up)
                                                                                          ├─ gpu     ssh -N -L <cache>/bridges/<id>-<n>.sock (backoff)
                                                                                          └─ laptop  local unix socket, /healthz every 5 s
```

- The helper owns the list, because it owns the connection: a bridge cannot hold the list (it is unreachable while
  down) and the browser cannot (the helper must act on it). `helper.BridgeSet` implements the one seam every proxied
  route already went through (`helper.Bridge { Dial; Status }`) by handing it to the bridge in use, so all of them,
  `/healthz` and `/api/open`'s Kaneo host (#184) follow a switch.
- **Standby connections.** Every bridge keeps its own supervised connection: an ssh entry its own `Tunnel` (one idle
  `ssh -N` each, the same backoff and checks, `ControlMaster=no`), a local entry (a Linux machine running both the
  helper and the bridge) its socket dialled directly with a `/healthz` check every 5 s. The list therefore always has
  each bridge's state at hand: the palette and Settings read it, nothing waits on an ssh handshake, and switching to a
  bridge that is up is instant. With a handful of bridges that costs a handful of idle ssh processes
  (`docs/decisions.md`, #57). The set's lock never spans a dial, an ssh start or a check: one unreachable bridge holds
  up neither the others nor the helper.
- **A switch is a reload.** `activate` changes the bridge in use and closes every connection dialled to the old one
  (the game's `/ws` and the proxies' idle keep-alive ones); the game reloads and its same-origin `/ws` reaches the new
  bridge. Switching in place would need `App.url`, the closures that captured it and the resume epoch to change.
- **Per-bridge browser state.** Drafts, the seat's tab per worker, the overview's collapsed orchestrators and the hire
  dialog's model and level choices are kept under `h3d.b.<id>.` in the browser (`net/bridgeScope.ts`); client
  preferences and the helper token stay shared. A page no helper serves keeps the plain keys.

## 3. Server: `herdr-world` bridge (Go)

- **Discovery**: `herdr session list --json`; `herdr.sock` existing ≠ running — probe it.
- **Live state per running session**: one `events.subscribe` lifecycle stream + per-pane `pane.agent_status_changed`
  streams; bootstrap with `session.snapshot` (arrays in `result.snapshot`, includes agents) *after* subscribing; 30 s
  safety re-snapshot; re-snapshot on any stream EOF. Unfiltered status subs send no initial event; `workspace.closed`
  may lack the final snapshot; event latency is not bounded at 100 ms.
- **Stopped sessions**: parse `session.json` (guard `version==3`, tolerate unknown fields) for the sleeping floor.
- **Wake a floor**: `systemd-run --user --unit=herdr-s-<name> --collect -p KillMode=process <shell> -l -c 'exec herdr --session <name> server'`
  (login env → API-key wrappers, no CLAUDE* leakage). `<shell>` is the bridge's **shell policy** (#68): `bash` by its
  absolute path by default, `/bin/fish` only when `--shell fish` asks for it ([shell policy](protocol.md#shell-policy)). Agents auto-resumed in tests without a client attached; still
  confirm each, with a fallback. herdr 0.9 restores a pane's agent before it runs and sends no `pane.agent_detected` for
  a resume (M3, verified live), so the bridge confirms by the pane's foreground process (`pane process-info`) or a
  detection naming the agent; a detection without an agent means it exited. Codex may need `pane report-agent-session`
  to backfill its id. Sleep = `herdr session stop`. Details: `protocol.md` "Wake and sleep".
- **Hire** (M4, built; details in `protocol.md` "Hire and send home"): the desk is reserved and the worker id minted
  first; `workspace create --cwd … --label … --no-focus`, or for a worktree `git fetch origin` (a failed fetch refuses the hire: `fetch_failed`) then `herdr worktree
  create --cwd <repo> --branch h3d/<name>-<id6> --base origin/<default> --label … --no-focus` (never the local HEAD,
  agent-office #119) → the workspace is bound to that id (so it sits at the chosen desk) → pane-label marker
  `h3d-<12 hex>` → `agent start <name>-<id6> --kind claude|codex --pane … -- <args>` through the shell pane (the
  pane's own shell wrappers apply) → answer the trust dialog → optional first prompt. Capacity caps per floor and host (soft: warn,
  hard: refuse); a worktree hire counts one: the repository's main checkout herdr may open with it holds only a shell and is hidden (not a worker) while it has no agent and a worktree of the repository is open. The branch is
  recorded as the bridge's for that worker (SQLite `hire_branch`, with its base commit). A failed hire rolls back:
  the workspace closes; the checkout goes only if clean, the branch only if still at its base; then the idle main checkout herdr opened for it is closed too.
  - claude: `--model claude-opus-5-5|claude-fable-5-1|claude-sonnet-5-5 --effort low|medium|high|xhigh|max --permission-mode bypassPermissions --name <label>`
  - codex: `-m gpt-6-sol|gpt-6-luna|gpt-6-astra -c model_reasoning_effort=low…max (+ultra sol/astra) --dangerously-bypass-approvals-and-sandbox`
  - Native args are not persisted by herdr → bridge stores harness/model/effort, `hired_at`, the desk, and the last
    choice per floor (the dialog's default when the floor has no `default_hire`).
  - H3D-2: a worker's shown model/effort is observed over reported, per field: its current agent session's transcript
    (`usage.model`/`usage.effort`, kept in the hub's `usage`/`usageFor`, never stored) over the stored hire values or
    `h3d_*` tokens (the hub's `reported`, what `persist` and `metaOf` see), else unknown. This is what shows the model of a
    worker a coordinator started with a raw `herdr agent start`; `hireInstructions` also asks for `h3d_harness`/`h3d_model`/
    `h3d_effort` as the reported fallback (decisions.md, H3D-2).
  - Trust dialog (verified live, herdr 0.9.0): both agents ask about a folder they have not seen, and a fresh worktree
    always is one. Claude's dialog makes `agent start` fail with `agent_not_ready` (`blocked`); Codex's is not detected
    (herdr says `idle`). `herdr worktree create --trust-repository` is herdr's own git trust and does not help. The
    bridge reads the screen and answers the dialog only when it names the hired directory as a whole path (not a
    sibling or parent; long paths are unwrapped first) — Claude Down + Enter, Codex Enter.
    Right after that, Claude drops an Enter for a few seconds: the prompt and `/exit` press Enter again.
  - Prompts to Claude are typed, never pasted (#95; the hire's, the laptop's, after a cancelled ask, the wrap-up's):
    `herdr agent prompt` is a bracketed paste, which Claude Code wraps in `<pasted_content>` (the model may then ask
    to confirm, and a slash command in it never runs). Once herdr sees the agent idle or done, `pane send-text` chunks
    of ≤ 700 characters, 50 ms apart (a burst over 800 is a paste to Claude Code v2.1.287), then `send-keys enter`,
    on the worker's input lane. Codex keeps `agent prompt`. One that fails part way is erased (`ctrl+u backspace`
    pairs) on the lane before anything else is typed.
- **Fire (gentle)** ("Send home", M4, built): git state first (`status --porcelain`, `rev-list --count HEAD --not
  --remotes`; a worktree is deleted only when clean and pushed) → claude `/exit` (~1.3 s) / codex `/quit` + pause +
  Enter (~0.5 s) → confirm the agent released (pane back at its shell; Enter again, then Ctrl-C, never for a #155
  shared Codex worker unless its server is already gone, #158; still running → `fire_failed`, nothing closed) → `workspace close` (or `worktree remove`, + `git branch -D` of the branch recorded
  for that worker, only while the checkout is on it and its commits are on a remote) → `worker.removed` with
  `reason: "sent_home"`. Never for sleep: a
  graceful exit drops `agent_session` so it can't resume. herdr closes a main checkout with open linked worktrees only
  as a group; the bridge refuses that instead (for a main checkout with an agent: an agentless one is hidden). When the last bridge-hired worktree of a repository is sent home, its idle main checkout is closed too (`workspace close`, best effort).
- **Shared Codex workers** (epic #153: #154 research, #155 launch, #156 questions, #157 cards, #158 validation and
  rollout; protocol: "Shared Codex server", "Codex async questions"; evidence and limits:
  `docs/research/codex-shared-tui.md` §12). A Codex worker that runs Codex's own terminal against an app-server of
  its own, so herdr-world can join the same conversation and answer Codex's async questions from the transcript.
  - **Configuration and rollout: opt-in, off by default.** One bridge-wide switch, persisted (SQLite
    `codex_server_settings`): Settings → Codex workers ("Give new Codex workers their own Codex server"), on the wire
    `codex_server.set {enabled}`. It needs herdr-world's private run directory, `--codex-run`
    (`HERDR_WORLD_CODEX_RUN`, default `$XDG_RUNTIME_DIR/herdr-world/codex`, `-` for none: the switch then reports
    `available: false` and cannot be turned on). It applies to **hires made while it is on**; each such hire records
    its launch (`codex_launch`, shared or legacy and why) and keeps that mode for its whole life (sleep, wake, send
    home). A Codex hire made with it off writes no record and starts byte-for-byte as before; Claude hires never look
    at it. Orchestrator-created Codex workers (write-code, through the herdr CLI) bypass the bridge and stay embedded.
  - **Server ownership.** One `codex app-server` per worker, never the CODEX_HOME daemon (findings B1–B3). The bridge
    writes a launcher into the run directory and types `setsid -f <shell> <launcher>` into the worker's pane (`<shell>`
    is the [shell policy](protocol.md#shell-policy): bash's absolute path, or `fish`), so the server has that pane's exports,
    direnv and herdr environment and its `codex` wrapper; the launcher marks its processes with a per-launch
    token, records the pid and listens on `unix://<run>/<marker hex>.sock` with the cwd trusted in memory and
    `-c features.instant_interrupt=false` (`codexapp.ServerFeatures`, below). Then the
    TUI: `agent start … -- --remote unix://<socket> -C <dir> -m … -c model_reasoning_effort=…
    --dangerously-bypass-approvals-and-sandbox`. The bridge owns the server: send home and sleep stop it (only the
    token's processes, then its files), wake starts a new one from the pane and resumes the thread
    (`codex resume <thread> --remote … -C …`, without the bypass flag), and a dead one is reported. The bridge joins
    the thread as a passive second client (`thread/resume` with the id only): it never answers approvals or blocking
    questions, and sends only on a player's command (`worker.answer_async`, or `worker.prompt` to a worker an async
    question shows as blocked).
  - **Supported Codex: the verified release lines only**, each verified with the real TUI and the bridge's full stack
    (`make codex-shared-tui`, findings §12, §13 and §14): **0.160.x** (codex-cli 0.160.1, herdr 0.9.0, 2026-10-07,
    #155/#158), **0.161.x** (codex-cli 0.161.0, herdr 0.9.0, 2026-10-08, #186) and **0.162.x** (codex-cli 0.162.0,
    herdr 0.9.3, 2026-10-08). The set is explicit (`codexapp.SupportedLines`), not a range: 0.159 and 0.163 are
    refused until verified. Checked twice: `codex
    --version` before anything starts, and the server's `userAgent` before the TUI attaches; the patch must be numeric
    (no pre-releases). Capabilities relied on:
    `app-server --listen unix://`, the TUI's `--remote`, `thread/resume` by id, `thread/turns/list` (the newest turns' real ids after a restart), `turn/steer` with `expectedTurnId`,
    `turn/start`, `clientUserMessageId` echoed as the user message's `clientId`, and `request_user_input_async` items
    (`agentMessage`, `delivery: "async"`, `questions`, id = the call id). Any other version: the hire **succeeds** and
    starts the usual way, with `codex: {mode: "legacy", note}` in its ack, e.g. `shared Codex server: unsupported Codex
    version: "codex-cli 0.163.0" (supported: codex-cli 0.160.x, 0.161.x or 0.162.x); started the usual way`. The game shows it as
    a **warning** toast (#186: ink with a drawn triangle, not the red of a failed hire; a first task not sent beside it
    is still an error) and on the laptop's seat bar, in plain words: "No own Codex server: the shared Codex server is not
    verified with Codex 0.163.0 yet (verified: 0.160.x, 0.161.x or 0.162.x). It runs on Codex's built-in server, so its
    async questions can't be answered from the transcript."
  - **Instant interrupt is off on a shared server (0.162).** Codex 0.162 turns `instant_interrupt` on by default: a
    steer (the bridge's answer, or a line typed while a turn runs) cancels the model request in flight and is recorded
    at once. The bridge's delivery model (#158: a sent answer waits for the turn's next model request, and is dropped
    if the turn ends first) rests on 0.160's and 0.161's behaviour, so every shared server starts with
    `features.instant_interrupt=false`, their default (findings §14). The visible cost on 0.162: a line typed into a
    shared worker's terminal while it works waits for the model's current step, as on 0.161, instead of cutting it
    short. Workers hired the usual way keep Codex's default.
  - **Known limitation on 0.161 and 0.162 (upstream, outside the bridge):** Codex 0.161 and 0.162 run no
    `SessionStart` hook when a TUI re-attaches (`codex resume <id> --remote`) to a server that **still has the thread
    loaded**, so Herdr's Codex hook never reports the session id again and `herdr agent get` shows none (0.160 runs it
    at the first prompt). A resume on a **new** server reports it on every version. herdr-3d never re-attaches warm: sleep stops a shared worker's
    server and wake starts a new one, and the bridge keeps the thread it recorded. Only a terminal re-attached by hand,
    or an orchestrator's (#154 A9), is affected (findings §13 and §14; `MixedHarness` asserts it per version).
  - **What a worker hired the usual way (legacy) lacks:** its async questions cannot be answered from the transcript
    (no join, no `worker.answer_async`); it answers them in its terminal, as every Codex worker did before #155. The rest
    (prompts, slash commands, approvals, images, sleep, wake, send home) works as for any Codex worker.
  - **Getting shared mode after an upgrade.** A worker keeps the mode it was hired in for life: installing a verified
    Codex, or turning the switch on or off, never migrates a worker already hired. For a legacy worker (hired on an
    unverified Codex, or with the switch off): finish or hand over its work, **send it home and hire a new worker** with
    the switch on and a verified Codex installed (`codex --version`). Leaving the switch off only stops the fallback
    notice for future hires. A new Codex release is verified by adding its exact version to the fixture
    (`codexshare.VerifiedCodex`) and its line to `codexapp.SupportedLines`, then running `make codex-shared-tui`
    with no version skip.
  - **Failures and recovery** (each leaves the worker usable): a blocked `.envrc` (the note says to run `direnv allow`
    there), a path the launch cannot pass, a server that does not answer in 20 s, or a TUI that does not
    attach while the pane is back at its shell: started the usual way, with the reason. Codex's "Hooks need review"
    dialog: left for the player, the hire's first prompt not sent. A server that dies: `server: "down"` on the worker
    and its seat bar (herdr still says working); recovery is sleeping and waking the floor (the sleep quits the
    waiting terminal, #158). A wake whose server does not start: the thread resumes on Codex's built-in server, the
    worker stays shared with a note, and the next wake tries its server again. **Known issue (findings §14):** herdr
    0.9.3 refuses a woken pane (`agent_pane_busy`, "not an available shell") while a zombie child of its fish sits in
    the terminal's foreground process group, as an async prompt such as tide's leaves one; the bridge's own check
    (the shell owns the foreground group) calls that pane free, the attach and its embedded fallback are both
    refused, and the worker is not resumed. A shared terminal that does not quit
    on send home (and whose server still runs): `fire_failed`, nothing closed.
  - **Rollback.** Switch it off: only **later** hires change. Running shared workers are not terminated, migrated or
    relaunched: they keep their server, their join and their answers (verified, #158). To take one worker back to
    the usual launch, send it home and hire it again with the switch off. Switching on again affects only hires made
    after it.
  - **Delivered input vs verified native question resolution.** The bridge never reports more than it has seen.
    `sent` (ack `state: "sent"`, `via: turn/steer|turn/start`) means **Codex's server accepted the input**, nothing
    more: a steered answer reaches the model only with the turn's next model request, and is dropped if the turn ends
    first (`undelivered`: the player may send it again). `answered` is **verified resolution**: a user message whose
    whole text is the native reply envelope naming that question, seen live or in the thread's history, with
    `answered_by: "bridge"` only when it carries the bridge's own `clientUserMessageId`, else `other` (the terminal, or
    any other client). The terminal's own badge clears a question at the same moment, delivery, and only that
    question. The tool's `{"accepted":true}`, the turn ending and unrelated messages never count as answers. One
    reply from the transcript is one model-visible answer: a second submission for a question already sending, sent
    or answered is refused `stale`, and the server, which does not deduplicate, is never sent the same answer twice,
    **also across a herdr-world restart**: the history does not show an answer still queued in the running turn, so
    the bridge records each answer it sends (SQLite `codex_async_send`, before the request goes out) and a restarted
    bridge keeps such a question `sent` while its turn runs, `undelivered` (one resend) once that turn ended without
    it, and `sent`, `unconfirmed` (never resent) when the bridge stopped before the server's response to a
    `turn/start` (or to a steer whose turn ended meanwhile, which falls back to one): a turn the terminal starts at
    the same instant takes that input and shows it only with its next model request (#158, findings §12.1a; protocol
    "Across a bridge restart"). A restarted bridge reads the thread's newest turns with `thread/turns/list`, because
    `thread/resume` gives them under legacy item ids, not the question's call id; when that read fails, the join is
    unresolved: records are kept, an answer to an `item-N` batch is refused (the terminal can answer), and the bridge
    joins again every minute until a join reads the call ids. A record goes
    only on evidence that its answer cannot be delivered or was (its envelope seen, the answer refused, the thread
    changed, send home, or its batch absent from a whole, resolved history), never because the bridge's view (32
    batches per thread, dismissable) no longer shows its batch: the record outlives the batch's eviction and comes
    back with it. The one restart window that can still duplicate an answer is a record SQLite failed to write
    (logged): it is lost with the process.
    Known limits (findings §12): the terminal and the transcript both answering one question before delivery reach the
    model twice (the bridge cannot see the terminal's queued answer), approvals and Codex's blocking questions stay
    in the terminal, images reach Codex as their path in the text (as for any Codex worker).
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
  #52: a column's cards follow the provider's own order (GitHub: the project's item position, the order of an unsorted
  board view, read in the same feed and sent as each card's `position`); the overlay moves a card by dragging it
  (`game/src/ui/boards/drag.ts` the slot arithmetic, `cardDrag.ts` the pointer events) and `issue.set_status` with
  `after` puts it in that slot (the `order` capability: the status write when it changes, then
  `updateProjectV2ItemPosition`). A poll that was in flight when a write landed never becomes the latest board (a
  write that failed halfway, `provider.ErrPartial`, counts as one and refreshes too), and the game holds a drop's
  placement until a board polled after the write shows it; a failed drop says why inside the board.
  #184 **Kaneo**: a floor's settings choose its issue tracker (`tracker`: GitHub, or Kaneo with a workspace and
  project) apart from its repo. The bridge-wide Kaneo connection (instance, key in its own `0600` `kaneo.json`, default
  workspace, the test that gates a save, a generation) is `internal/kaneoconf`, which reaches Kaneo only through a
  `Connector` interface; `internal/kaneo` (the HTTP client and the `tracker.Tracker`) is wired in by `app` alone, like
  `github` (`TestBoardLayerIsProviderNeutral`). `server.BoardSource` names the tracker, the instance and generation,
  the workspace, the project and the repo (never the key), and the factory picks the tracker and the code host apart:
  a Kaneo floor has its issues board without a repo and GitHub's PR board with one. The Kaneo tracker reads one
  project: its workflow columns between the virtual Planned and Archived ones, every task up to 500 (no closed window:
  Kaneo gives no completion time), at most 12 calls a read; set status is `PUT /task/status` and an anchored move one
  `POST /task/reorder` checked against the board it was computed from. A new generation drops a Kaneo
  floor's board, its cache and any late poll. A run-time 401 (maybe the key's quota) pauses every Kaneo floor's polling
  for 5 minutes, ended by a passing re-test; a 403 is a permission problem. Kaneo's virtual `planned` and `archived`
  statuses are columns with a `kind`; `close` is off (completion is a final column; a task is never deleted). Runs on
  a Kaneo task keep `{provider, id}` in `run_launch` and name the task by its canonical URL in the prompt (#102): the
  agent reads it with its own tools; no description is copied in.
  "Open in Kaneo" from the helper works for the saved instance's host only, which the bridge names on its own
  `/healthz` for the helper.
- **Repository discovery** (#54, built; details in `protocol.md` "Repository discovery"): the bridge scans folders on
  its own host (scan roots, bridge-wide in SQLite with a refresh interval, 10 minutes by default) for Git working
  checkouts, so `@r:` offers local repositories no floor names. `internal/repodisc` owns a background catalog (wired
  by `app` with the bridge's context, like `fileindex`): one scan at a time, after startup, a change of roots, on
  request and on the interval; a settings change bumps a generation, cancels the scan in flight and drops its result.
  The walk checks `<dir>/.git` (folder, file or link) before listing a folder and stops at each checkout, with no
  depth cap and no name exclusions, never following a symlinked subfolder; git runs only for the candidates (8 at once,
  2 s each, local, `gitops` shapes in a clean environment). Checkouts merge into repositories by common directory and
  normalized GitHub origin; readers get an immutable snapshot whose revision moves only when its content does. A root
  that fails keeps its last result (stale). `worker.repos` / `hire.repos` merge the floors' rows with the snapshot off
  the hub goroutine, one row per repository (`RepoRef.id`, `source`); `repo_discovery.update` tells an open popup to
  ask again. Warm full scan of the two benchmark roots (135 candidates, 61 repositories): ~150 ms
  (`docs/research/repository-scan-bench`).
- **Scheduled agents** (#62, part 1 of the epic #61; details in `protocol.md` "Scheduled agents", `decisions.md`
  "#62"): one-shot hires at a wall-clock time, stored in SQLite `schedule` (`internal/store/schedule.go`) and kept in
  view by the hub (`internal/server/schedule.go`). The runner runs on the hub goroutine: every 30 s tick
  (`Options.ScheduleTick`) it compares due times with the wall clock (`Options.Now`, injectable), never a timer to a due
  time, which a suspended host would stop; it first looks once discovery's `world.Listed` (the sessions it may watch,
  sent after each changed list) says the floors are known, and again when a floor is first seen. A due schedule is
  decided against the 5 min grace and its `on_miss` / `max_lateness`, then fired as a hire the bridge starts itself:
  `beginHire` / `runHire`, worker.hire's path, under the bridge's own `Client` identity (`bridge:schedule`, never
  connected, so no reply goes anywhere) with a `hireWatch` that writes `running` and the worker id before herdr is
  called and settles the schedule from `finishHire`. The bridge picks the first free desk; an asleep floor wakes through
  `wakeFor`, the path a hire on an asleep virtual floor shares. The prompt's handoff line is `handoff.HireTask`, the
  game's Hire from handoff wording (`TestHireTaskIsTheGames` pins the two). No schedule path sends a worker home or
  deletes anything; a crash while `running` resolves on startup from whether the worker was ever seen. #63: a
  `scheduled` or `waiting` schedule holds the linked worktree its `cwd` is in (`internal/server/schedulehold.go`,
  derived from the schedules on each check, never cached): send-home prepare, fire and wrap-up refuse to delete it, and
  a wrap-up's CLEAN keeps it instead. #127: a schedule with `herdr_instructions` fires with the herdr hiring instructions for
  its own floor after its prompt: `fireSchedule` composes them through `hireLines` (`internal/server/hire.go`), the
  helper `worker.hire` uses, so the lines are in the prompt `hireShape` checks and `compose` translates the task alone;
  `applyScheduleSpec` checks the stored prompt with them at save. The game's form shares the box, the question and the
  classifier call with the Hire worker form (`ui/hireInstructions.ts`).
- **Schedule suggestions** (#66, part 5 of #61; `protocol.md` "Schedule suggestions", `decisions.md` "#66"): when an
  agent's final reply says a step must wait, the bridge drafts a schedule and the game offers it as a chip on that
  reply; nothing is scheduled until the schedule form is saved. `internal/schedsuggest` (only `internal/ai`,
  `TestScheduleSuggestUsesOnlyAIInterfaces`) holds the gate question, the extraction's request and its validation
  (`Parse`: RFC 3339 with an offset, in the future, at most 30 days out, kept in UTC) and the settings `Service` (the
  toggle, the threshold, the user's IANA zone the game sends, the env override). It rides the follow-up questions' turn
  end, no tracker of its own: `internal/server/followup.go`'s `considerFollowup` looks at a settled turn for each
  feature that is ready and has not seen the message, and `runTurn` (`internal/server/schedsuggest.go`) calls the
  models off the hub goroutine: both → one `ClassifyMany`, then the follow-up extraction, then the schedule's. The
  suggestion is `Worker.schedule_suggestion` (its row: `transcript.Turn.Message`, the handoff candidate's message id),
  recorded once per message in `schedsuggest_seen`, closed by a `schedule.create` from it, a dismiss or the transcript
  going on. The game: the chip in `laptop/transcriptRender.ts`, the form's prefill (`ScheduleFormPrefill.dueAt`,
  source `suggestion`), `ui/scheduleSuggestionsSection.ts`, `world/scheduleSuggest.ts`.
- **AI roles and their callers** (#92; `protocol.md` "AI integration"): `internal/ai` knows no feature; each takes
  `ai.Classifier` or `ai.LLM` through a `Roles` interface the hub fills from the one `ai.Service`, so the two global
  call slots, the timeouts and the one retry are shared. The **classifier**: the follow-up questions (#90) and the
  schedule suggestions (#66) on each settled turn end (one `ClassifyMany` when both look at a message), pack up on
  request (#110, `packup.detect`), "Classify unknown commands" (#98, `internal/activity`) and the hire presets' nudge
  (#95, `hire_preset.check`; #117 a plain Hire, #127 a schedule's Save). The **LLM**: the follow-up extraction (#90), the schedule suggestion's draft (#66), pack
  up's cut (#110), the floor overview summaries (#118, `internal/digest`), LLM handoffs (#9, `internal/handoffllm`) and
  the dictated hire (#211, `internal/hireintent`). A feature runs only while it is switched on and its roles are
  `ready`.
- **Hire presets** (#93; details in `protocol.md` "Hire presets", `decisions.md` "#93"): a named first prompt with its
  harness, model and effort, on one floor (a floor id) or global, stored in SQLite `hire_preset`
  (`internal/store/hirepreset.go`; a virtual floor's delete removes its own in the same transaction) and mirrored by the
  hub (`internal/server/hirepreset.go`: `hire_preset.*` persist first, then `hire_preset.upsert` / `.removed`; each field
  checked as `worker.hire` checks it, the tuple by `validHireIn`). Nothing in the bridge hires from a preset: the game's
  "Hire preset" tab (`game/src/ui/hirePresets.ts`, the third desk tab beside Hire worker and Hire orchestrator) opens the
  ordinary hire dialog with the preset's prompt and **exact** choice (`HirePrefill.preset`): the dialog then never
  resolves the choice (`resolveForm` and `prepare` leave it; `offeredOptions` keeps a model Settings hides; `pickExact`
  for the player's own picks), and `world/hirePresets.ts` `exactProblem` names what the whole catalog lacks, which blocks
  Hire until the player repairs it. The hire goes through `HireCoordinator` and `worker.hire` like any other. Save as
  preset… opens the editor over the form; the client's `HirePresetBook` follows the events (`known` false: an older
  bridge, the tab says hire presets are unavailable).
- **Native child agents** (#22, phase 1 of #20; details in `protocol.md` "Native child agents", `decisions.md` "#22"):
  the subagents a worker's own Claude Code or Codex session runs, kept by the hub in a `childagents.Registry`
  (`internal/server/children.go`), never in SQLite. Each worker refresh binds the worker to its root agent session and
  stamps its `child_generation` (a replaced session drops its children); sources (`Options.ChildSources`) report
  evidence keyed by that session, which becomes `child.upsert` / `child.removed`; a session bound anew is replayed by
  every source, so a restart rebuilds the graph from evidence. The game keeps them in `world/children.ts`' `ChildBook`;
  the floor overview (page and wall) nests them under their workers (#24, below). **Claude Code** (#23; `protocol.md` "Claude Code subagents", `decisions.md` "#23"):
  `internal/claudechild` gets each Claude worker's session files from the usage tracker's own reads (a `usage.Children`
  listener on its `usage.Session`: the main transcript, `subagents/agent-*.jsonl` and their meta files, one reader per
  file), keeps them as facts keyed by explicit ids and derives each child after every poll; it also tails the log of the
  bridge's own hooks, a `--settings` file (`-claude-hooks`) passed to the Claude workers it starts. **Codex** on the
  terminal path (#25; `protocol.md` "Codex subagents", `decisions.md` "#25"): `internal/codexchild` gets each Codex
  worker's root rollout and its child rollouts from the same tracker (`usage.Session` finds the children with
  `codex.ChildFinder`, by their first line's `thread_spawn` and root session), keeps facts per file keyed by explicit ids
  and derives each child after every poll; `codexchild.ReadTranscript` reads a child's own conversation. The shared
  app-server path: #27.
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
  A close whose save fails never drops the drawing: the board asks (retry, keep a draft in the browser, discard).
  `drops.list` reads Drop Zone's newest files for "Pin a drop".
- **Floor overview** (#118, built; `decisions.md` "#118"): a big screen on the west wall of every floor's
  lounge shows the floor as a departures board (`game/src/render/overviewScreen.ts`, one unlit canvas texture, no light
  of its own); E at it, O anywhere on the floor or the top bar's Overview opens the page over the whole viewport
  (`game/src/ui/overview.ts`). Both draw one tree built in the game from the world (`world/overview.ts`): orchestrators
  over their freelancers, ghost rows for an orchestrator on another floor, an Unlinked group, then everyone else. Its
  words come from the bridge: each worker's `digest` (task and now lines from its transcript, `transcript.DigestTracker`
  on the usage tracker's line tap: Claude's ai-title, the first prompt, the away_summary recap, else the terminal title)
  and the run's ticket title and URL (`issue` / `work_item`, from the board cache or one read of the item). Phase 2,
  opt-in ("Floor overview summaries", `internal/digest`): the configured LLM writes a one-off worker's task and every
  worker's now line from the same digest, after a settled turn, for viewed floors only, one call at a time, under a
  daily cap and cached by input hash; the page and the wall mark those lines AI. #188: the same page shows **all floors**
  (O in the city or a lobby, the Menu's City Overview, the palette, `a` on a floor's page): `buildCityOverview` puts
  every floor (Buildings-panel order, then the lot) over its tree, each worker once (a freelancer under its
  orchestrator's floor, no ghosts, Unlinked per floor); both pages filter **Active only / All** (`f`, remembered per
  view; the all-floors page starts active only), the header's counts never filtered. Page only: the wall stays per
  floor (`decisions.md` "#188"). #24 (phase 3 of #20; `decisions.md` "#24"): the tree is recursive: every worker row
  carries its native child agents (`ChildBook`, `childTree`'s order) after its freelancers, each child over its own, on
  both pages and the wall, as quieter conversation rows (state, task, time, transcript availability; an unresolved one
  marked, never drawn as the worker's); counts and totals stay the workers'; activating one seats at its worker with that child's own conversation open over the worker's (#26: its own transcript watch, read only, a breadcrumb and Esc back; `decisions.md` "#26"). #174: the feature's own reasoning effort (from the model's catalog) and completion budget (default 1,024), a bounded retry of a failed task line, per-call sanitized diagnostics (`truncated` / `empty_answer` apart from `bad_response`), and a status on the page's line while a fallback shows (`decisions.md` "#174").
- **Departures boards** (#65, part 4 of #61; `decisions.md` "#65"): the schedules in the office, beside the overview
  screen's world. Every floor has a board standing on its board partition, readable from the desks and from the
  elevator (prop `board.departures`, `game/src/render/departuresBoard.ts`): the floor's next three schedules (time on
  flaps, title, countdown or Boarding / Departing / Delayed +Xm) and a red attention line. Each building's lobby has one
  on its north wall with a group per floor of that building (`LobbyView`). Both draw a text model built from
  `store.schedules` (`world/departures.ts`) on one unlit canvas texture each, and redraw only when the model changes
  (a second while a departure is under an hour away, else the minute), never out of view; an idle frame is two
  comparisons. E at the floor's board or a lobby group opens the schedule dialog on that floor, elsewhere on the lobby's
  board on every floor (`openSchedules`).
- **Telegram notifications** (#11; details in `protocol.md` "Notifications"): `Hub.emit` hands `internal/notify` a look
  at the worker of every worker and floor event, from the hub's own `proto.Worker`, on the hub goroutine; `Observe`
  only appends to a bounded list, so the emit path never waits on the network. The service's loop applies the inbox
  rule (the game's, ported: `notify.Judge`, pinned to `WorldStore.workerView` / `inboxReason` / `inboxQueue` by
  `internal/notify/testdata/inbox_vectors.json`), keeps each worker's last episode (needs-you or done, and its since:
  a first sighting, and an episode that starts while it may not notify, are known silently), sends needs-you at once
  and done after a 5 s settle, through a 32-deep queue with backoff (429's `retry_after`, 5xx and network failures 1,
  2, 4 s; at most 4 attempts) and audits each send. The core is provider-neutral (no `net/http`, nothing of the
  module); `internal/notify/telegram` is the `Channel`: the bot token in `telegram.json` (0600) or the environment's
  key file, `sendMessage` as plain text, and pairing by a one-time code read with `getUpdates`, polled only while a
  pairing waits (no webhook, no inbound port). Only `internal/app` imports it (`TestNotifyCoreIsProviderNeutral`).
  Switched off, nothing leaves the machine; switching on needs a delivered test message.
- **Handoffs and the filing cabinet** (#223, part 1 of #11; details in `protocol.md` "Handoffs"): a worker's latest
  completed final reply is filed **literally**, no model call and nothing sent to the worker. `transcript.HandoffTracker`
  rides the usage tracker's line tap beside the follow-up and wrap-up trackers (the same `TurnEvents`, one parse per
  line) and keeps the reply's source identity (agent session, Claude's message/request/line ids or Codex's turn and
  message ids, byte spans, the text's SHA-256); the hub shows that identity as `Worker.handoff`, never the text, and
  `transcript.Resolve` reads the whole text back from the spans for the preview and the filing (same file, no
  shorter, same lines, same hash, or nothing), after `transcript.StillLatest` read the lines written since the
  tracker's last read with the tracker's rules (still the latest reply, or nothing). `internal/handoff` (standard library and the store only, `TestHandoffIsALeaf`) is the
  cabinet's one writer, for this mode and the later agent / LLM modes and `worker.fire`'s reserved `handoff`:
  `--handoff-dir` (default `~/handoff`, `-` none) / `<floor>/<yyyymmdd-hhmm>-<worker>-<slug>.md`, a synced `.tmp`
  linked to a free name (never over a file), the bridge's front matter over the unchanged text, a derived title, a
  1 MiB cap, deletion to `.trash/`, and the startup reconcile (gone rows, changed files, crash orphans, leftover `.tmp`).
  The store holds `handoff` (one row a file, with the source's ids, size and mtime, and the filing's `op` idempotency
  key) and `handoff_fts` (FTS5, `porter unicode61 remove_diacritics 2`, rowid = `handoff.id`): bm25 search on quoted
  terms, never raw FTS syntax, private-use snippet markers. A send home asked for with the filing runs only after it,
  through `worker.fire`'s path with its checks done again. The game: the transcript's inline Handoff button on the
  reply's own row (`world/handoff.handoffRow`), the filing dialog (`ui/handoffDialog.ts`; F at a worker), the cabinet
  overlay (E at the floor's filing cabinet, `ui/cabinet.ts`; sanitised Markdown, Copy path, Delete, Hire from handoff
  through the reviewed hire), the drawers filling with the floor's count and the worker's walk to the cabinet with a
  folder (the M6c delivery walk, `world/route.deskToCabinetRoute`).
- **Ask the agent** (#224, part 2 of #11; `protocol.md` "Ask the agent"): `worker.handoff` mode `agent` and the composer's
  exact `/handoff [instruction]` (read in `startPrompt` before translation) ask an idle or done worker's own agent to
  write a handoff with its `handoff` skill. `internal/server/agenthandoff.go` owns the flow: the catalog lists the skill
  (else `handoff_skill_missing`), `handoff.Reserve` gives a path under the cabinet's hidden `.pending/` (never
  registered by the reconcile), the request is stored (`handoff_request`, op-keyed, one pending per worker), the
  offset taken, one prompt sent (the skill in `harness.SkillCall`'s spelling through `PromptTranslator`, the path,
  the bridge's front matter values, a nonce marker). The usage tracker feeds a `transcript.NewMarkerTracker` (the
  wrap-up's turn rules) and checks the file every round; the hub files it (`handoff.Adopt`: the bridge's front matter
  through `File`) only once the turn ended with herdr idle **and** the file is complete, else fails it with why
  (timeout, cancel, session change, a person taking over, no file). The package stays a leaf. `Usage.cache`
  (`internal/usage`) is the main thread's prompt-cache evidence: Claude's direct 1h/5m writes per `requestId` with the
  request start as an interval, Codex's turn timing and model/route policy; its warm / expired / unknown state is
  estimated when shown (`usage.CacheState`, the game's `cacheState`), never published. The game: the F dialog's three
  modes (literal default, Ask the agent, Use configured LLM), the instruction, the estimate's copy, the
  request followed on `Worker.agent_handoff`.
- **LLM handoffs** (#9, part 3 of #3; `protocol.md` "LLM handoffs", `decisions.md` "#9"): `worker.handoff` mode `llm`
  has the configured LLM write a handoff from the worker's transcript; the worker is not prompted. `internal/handoffllm`
  holds both halves: the **reducer** (`Reduce`, `Scrub`, `EstimateTokens`; standard library, `internal/jsonl` and
  `internal/transcript` only, `TestReducerIsALeaf`; its policy and text layout in `internal/handoffllm/doc.go`) turns an
  immutable main-session snapshot ending at the worker's candidate into bounded, scrubbed source data with explicit
  coverage; the **feature** (`Service`: the switch off by default and bound to the config a passing `handoff_llm.test`
  ran with, the transcript and completion budgets, one call at a time, `Generate`; `Build`, the versioned prompt with
  nonce-delimited data blocks and the bridge's facts; `Validate`, the title-and-sections check) talks to `ai.LLM` only.
  It is not inside `internal/handoff`, which stays the cabinet's leaf writer. `internal/server/llmhandoff.go` owns the
  flow: the preview (the reducer off the hub goroutine, nothing sent), the job (`handoff_llm_job`, op-keyed, persisted
  before the call, failed at a restart and never resent), the call (its own 90 s timeout and no uncertain retry, both
  per request in `internal/ai`), the checks again on the hub (stopped, the worker's agent session, the LLM's
  fingerprint, the feature ready), the filing through `handoff.Service.File` with `source: llm` and the provenance
  front-matter keys (`handoff.ProvenanceKeys`), then the send home. Cancelled by `worker.handoff_cancel`, an AI config
  change (`trackAI`), another agent session (the worker's upsert) or the worker leaving. The game: the dialog's third
  mode (`ui/handoffDialog.ts`: the recipient, size, coverage, gaps, redactions, the focus, the job), the Settings
  section (`ui/handoffLlmSection.ts`, `world/handoffLlm.ts`), the cabinet's provenance line. `cmd/handoff-spike` is the
  quality spike's harness (dry by default).
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
  snapshot); workers carry `work_item{provider, id}` next to `issue` (#184: alone, with its `key`, for a Kaneo task).
  #184: `kaneo.update` (the Kaneo connection, never a key) and `world.snapshot`'s `kaneo`.
  #54: `repo_discovery.update` (settings and scan status, a catalog `revision`) and `world.snapshot`'s `repo_discovery`.
  #11: `notify.update` (the Telegram notifications' settings and channel, never a token) and `world.snapshot`'s `notify`.
- Commands (each with `req_id`, ack/err): `building.create/rename/delete`, `floor.assign`, `floor.wake/sleep`,
  `worker.hire{floor, harness, model, effort, label, cwd}`, `worker.fire`, `worker.prompt`, `worker.keys`,
  `terminal.watch/unwatch/zoom`, `terminal.open` (see below). M7: `board.watch/unwatch/refresh`, `issue.get/comment/close/
  set_status`, `pr.get/comment/merge`, `worker.open_pr.prepare/open_pr`; `run.prepare/start` take a `work_item`.
  #184: `kaneo.get/test/set/clear/workspaces/projects`; `floor.settings.set` takes `tracker` and `kaneo`.
  #11: `notify.get/set/test`, `notify.token.set/clear`, `notify.pair.start/cancel`, `notify.unpair`.
  #54: `repo_discovery.get/set/refresh`; `worker.repos` / `hire.repos` rows gain `id`, `source` and `checkouts`.
- **Open in Ghostty (optional escape hatch, not needed to play)**: all normal interaction happens in-game —
  laptop screen = live read-only terminal via `observe`; prompts, approvals and keys via `worker.prompt` / `worker.keys`.
  herdr servers run headless on the server; nothing on the Mac needs a terminal. Only for "let me type in the raw
  pane myself": bridge `agent.focus` → helper immediately opens a new Ghostty window via AppleScript
  `new window with configuration` + `command "herdr --remote <user@server> --session <s>"` (fresh attach lands
  on the focused workspace, 5/5 in tests; `+new-window` unsupported on macOS). Exact-pane alternative:
  `ssh -t … herdr --session <s> terminal attach <term_id>` (0.64 s). Focus marks `done` as seen — acceptable.
  herdr 0.9.1 also makes focus move attached clients.

## 5. Mac: game client

- **three.js r186 + TypeScript + Vite**, `WebGPURenderer` (auto WebGL2 fallback), HTML/CSS menus (hire dialog:
  harness → model → effort; #212: a dictated hire opens an accordion review of the same fields, and only its Hire launches),
  xterm.js 6 for laptop screens (render to texture only for the focused desk).
- **The laptop's conversation view** (M16; #126): a DOM overlay over the monitor (`laptop/transcriptRender.ts`, a
  module loaded when it first shows). Until the watch's ack it shows a conversation opening (`laptop/transcriptLoading.ts`,
  in the main bundle: the overlay's stand-in while the module loads, then the view's own until the ack), never "No
  conversation yet.". A fresh timeline builds its newest rows at once, stuck to the bottom, and the older ones above them
  in ~8 ms slices, one after each drawn frame, the reader's place held; hidden system rows are built when "Show system"
  shows them, a changed file's lines when it comes near the view and, once every row is built, all the others (so find in
  page finds them). With "Hide tool calls" on it stays opening until a row that shows is built. Counts read the items,
  never the rows (`decisions.md` "#126").
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
- **Fonts** (#59): the HUD, panels and dialogs are Recursive (Quiet UI; #216's Ubuntu UI draws them in Ubuntu and Ubuntu Mono, next bullet). Two hard-coded presets (Ubuntu, #172: the classic
  Ubuntu terminal purple `#300A24` with Ubuntu orange, Ubuntu Mono + Ubuntu; Quiet, the default: JetBrains Mono +
  Atkinson Hyperlegible Next), each a mono font, a prose font and colours, picked apart for the laptop's transcript (its fonts and colours: `--tx-mono`,
  `--tx-prose` and `--tx-*`; #216: no longer the shell's `--font-mono`) and for its terminal canvas (font and screen colours). Only Quiet's fonts come with the
  app: Ubuntu's stylesheet (Latin and Latin Extended `@font-face`s, split by Vite) loads when it is first picked, and the
  canvas repaints once its faces have loaded. Ubuntu Mono's missing glyphs (box drawing, arrows, shapes, check marks, braille) come from size-adjusted `local()` fallback faces, so a table with one stays aligned where the host has a monospace font with that glyph (a missing glyph shows as a box of the same width; `fonts/ubuntu.css`). Each view has its own font zoom (70–200 %); the HUD does not zoom.
  Every shipped font's licence goes with the build in full (`FONT_LICENSES.txt` next to the bundle, from
  `src/ui/fontCredits.ts`; the OFL, the Ubuntu Font Licence (the Ubuntu pair's, not OFL) and the Bitstream Vera licence ask it), linked from the credits panel, which keeps
  each font's copyright line. A stored `terminal` or `paper` preset (#59's, replaced in #172) opens as Ubuntu or Quiet.
- **Application UI theme** (#216): a third, independent browser pick beside the transcript's and the terminal's: Quiet
  (the default, today's navy shell) or Ubuntu (aubergine surfaces, orange actions, Ubuntu and Ubuntu Mono), `h3d.theme.ui`
  in `ViewPrefs` (`ui/themePrefs.ts`; an unknown value is Quiet, storage that is missing or throws keeps the pick in memory;
  nothing is copied from the other two keys). It is one attribute: `ThemeLoader` sets `data-ui-theme` on the root (not
  `data-theme`, the transcript's) and the inline script in `index.html` sets it before any CSS paints, so a saved Ubuntu
  never shows navy first. `ui/uiTheme.css` is the whole token set: `:root` is Quiet (the values the shell always had, the
  legacy `--ink` / `--sun` names kept as aliases), `:root[data-ui-theme='ubuntu']` overrides the same names (palette of the
  issue's table, pinned by `ui/uiTheme.test.ts`), and components ask for a **role** (`--surface`, `--chrome`, `--raised`,
  `--hover`, `--well`, `--text*`, `--border*`, `--action*` and `--on-action`, `--focus`, `--accent-text`, `--error-*`, the
  status colours and their `-chip` fills with `--on-chip`, `--btn-*`, `--font`, `--font-mono`, `--fvs-*`, and the per-surface
  tokens: 320 in all), never a hue. What Ubuntu needs that Quiet must not get (disabled without opacity, busy spinners,
  36 / 32 / 44 px targets, keylines on bright fills, forced-colors rules) sits at the end of each stylesheet between
  `/* ubuntu:begin */` and `/* ubuntu:end */`; `tools/ui-quiet-check.mjs` strips those blocks, expands the Quiet tokens
  and diffs each stylesheet against the commit before #216: it prints nothing but deliberate hunks, which is how "Quiet
  looks exactly as it did" is proved. A switch writes one attribute: no DOM is rebuilt, no focus, draft or session moves,
  the 3D scene is not touched, and the Ubuntu stylesheet and faces (`fonts/ubuntu.css`, one lazy import shared with the
  seated views) load for a UI pick even when both views stay Quiet. **Ownership:** the shell's fonts and colours are the UI
  theme's alone (`--font`, `--font-mono`); the transcript preset sets only `--tx-*`, `--tx-mono` and `--tx-prose`, and the
  terminal canvas its own. Inside the seated screen the app's widgets (seat tabs, the Conversation / Images bar, zoom and
  theme controls, composer, Send, question answers, tool toggles) read `--ctl-*` and the action tokens, while messages,
  code, diffs and status annotations keep `--tx-*`; every Ubuntu rule there is `:root[data-ui-theme='ubuntu'] .tx …`
  (0,3,0 and up), out-ranking the `.tx button { color: inherit }` reset (#111). Settings → Appearance
  (`ui/appearanceSection.ts`, browser-scoped) is a labelled radio group of exactly Quiet and Ubuntu. The whiteboard editor
  stays on Excalidraw's light theme (its dark theme filters the canvas); `whiteboard/editor.css` (lazy with the editor)
  overrides its UI custom properties, tooltips and the dialogs it mounts on `body`. `e2e/ui-theme*.spec.ts` and
  `e2e/ui-surfaces.ts` hold the surface inventory: screenshots, a stray-colour scan, contrast on the rendered surfaces,
  the eight combinations and the narrow, touch, forced-colors and reduced-motion checks.
- **Settings window** (#91): the gear in the top bar (or `,`) opens `game/src/ui/settings.ts`, `SettingsDialog`: everything
  the player can change, as sections in the About panel's frame. A section is
  `addSection(id, title, render, { store, group })`: the dialog draws the heading and the storage label (`'browser'`:
  "This browser", `localStorage` prefs; `'bridge'`: "Bridge", shared by every client) and lists the section in its
  navigator group, `render(body)` fills the body and may return `{ open, dispose }`; a feature adds its own from `App`
  without touching the dialog (#90's follow-up questions are the first "Bridge" section). #49: one section shows at a
  time, picked from a grouped vertical tablist down the side (General, Workers, AI, Integrations, in that order; within
  a group in the order added), below 800 px wide from a native picker above the section. Every section's DOM stays
  put (a switch only hides and shows), a section's `setHidden` takes it out of the navigator too, and `reveal(id)`
  shows its target from the top with its heading focused, over the section remembered from the last open. Display (the plan-limits switch) and
  Day and night (`ui/settingsSections.ts`) are the first two; #100's Notifications (`ui/notifySection.ts`: desktop
  notifications, the chime, which entries ping) is the third. About (`ui/about.ts`) is read-only build info.
  #155's **Codex workers** (`ui/codexServerSection.ts`, "Bridge") is one switch, off by default: "Give new Codex workers
  their own Codex server". On, a Codex worker hired from then on runs its usual terminal against a Codex app-server of
  its own, started from its pane, which herdr-world can join to follow the same conversation (approvals stay in the
  terminal); workers already at their desks keep the way they were started. A hire that could not get its own server
  (an unsupported Codex, a blocked `.envrc`, a server that did not answer) starts the usual way and says why in its
  toast and on the laptop's seat bar, which also says when such a worker's server stopped. Disabled, with why, on a
  bridge without its `--codex-run` directory. Protocol: [Shared Codex server](protocol.md#shared-codex-server).
- **Day and night** (M17): the game follows the viewer's local time, in the browser, with no bridge or protocol part.
  `game/src/world/daylight.ts` (pure) turns an instant, an IANA zone and an optional latitude into a daylight value
  0…1, the sun's altitude and bearing, a dawn/dusk warmth and the zone's clock; with a latitude the sun comes from the
  declination and the hour angle (solar noon at 12:00 standard time, no longitude), without one from a fixed curve
  (dawn 06:30–08:00, dusk 18:30–20:00). The zone and latitude are client settings (Settings, #91; `?tz=`, `?lat=` for a page
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
2. Metal verification: agent runs `ssh -o ControlMaster=no <the Mac>` (`$H3D_MAC`, or the private update config, `docs/releasing.md`) → `-L` forward of the Vite port →
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
