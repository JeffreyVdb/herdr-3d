# Server model: Mac game client ↔ herdr on devbox

Researcher: GROUND|server · Date: 2026-09-28 · herdr 0.9.0 (API protocol 22) · tailscale 1.98.10 (server) / 1.102.3 (Mac)

## TL;DR

- **Today's remote mode is "SSH-exec a bridge, render locally".** `herdr --remote dev@devbox --session X` on the Mac
  starts a local `herdr client` plus an OpenSSH ControlMaster that runs `exec herdr --session X remote-client-bridge` on
  the server (via Tailscale SSH). The bridge connects to that session's private `herdr-client.sock`. **One SSH process per
  attached session.** No machines are saved (`herdr machine list` → "No saved SSH machines.").
- **Every herdr session is its own `herdr server` process** with its own unix sockets
  (`~/.config/herdr/sessions/<name>/herdr.sock` = public JSON API, `herdr-client.sock` = private TUI protocol). There is no
  "all sessions" API; anything that wants the whole world must fan out over N sockets.
- The public socket API is **newline-delimited JSON, one request per connection**, plus a long-lived
  `events.subscribe` stream. It is fast: `ping` 0.5 ms, `session.snapshot` 1.5 ms (8 KB), `pane.read` 0.6–1.8 ms,
  whole-world poll of 11 running sessions / 63 workspaces / 61 agents = **37 ms, 163 KB**.
- **Recommendation: option (a), a small server-side bridge daemon ("herdr-world", Go)** that holds one subscription per
  running session, keeps an in-memory world model, stores the new building/group layer in **SQLite**, and exposes a single
  **WebSocket** (JSON, snapshot + versioned diffs) on the tailnet. Put it behind `tailscale serve` (HTTPS, tailnet only,
  identity headers) or bind it to the tailnet IP and check `WhoIs`; allow-list Theo's user + the Mac's node.
- In-game live terminal: bridge spawns `herdr --session <s> terminal session observe <pane> --cols C --rows R`
  (read-only observer; NDJSON `terminal.frame` = base64 ANSI, one full frame then incremental diffs — verified) only for
  panes the camera is looking at, and relays frames. Fallback: poll `pane.read format=ansi` at ~4 Hz. "Open in real terminal": game launches
  `herdr --remote dev@devbox --session <s>` in the user's terminal app, after the bridge focuses the target
  workspace/agent.
- Cost: negligible. 11 running herdr servers already use ~286 MB RSS total; the bridge adds ~20–40 MB and <1 % of one core.

## 1. How `herdr --remote` / `herdr machine` work today

### Evidence (server, `ps`)

```
tailscaled be-child ssh --login-shell=/bin/fish --uid=1000 ... --remote-user=JeffreyVdb@github --remote-ip=203.0.113.20
   --has-tty=false ... --cmd=exec /home/dev/.local/bin/herdr --session herdr-3d remote-client-bridge
/home/dev/.local/bin/herdr --session herdr-3d remote-client-bridge      (RSS ~4 MB)
/home/dev/.local/bin/herdr server                                         (RSS 20–40 MB, one per session)
```

Same pattern for sessions `common`, `livesub`, `sched`.

### Evidence (Mac, read-only `ps`)

```
herdr --remote dev@devbox --session common
/opt/homebrew/bin/herdr client
ssh -F $TMPDIR/herdr-ssh-77524-0/config -S $TMPDIR/herdr-ssh-77524-0/ctl -o ControlMaster=auto -o ControlPersist=yes \
    -T dev@devbox exec /home/dev/.local/bin/herdr --session common remote-client-bridge
ssh: $TMPDIR/herdr-ssh-77524-0/ctl [mux]
```

### What runs where

| Where | Process | Role |
|---|---|---|
| Mac | `herdr --remote …` | launcher; writes a private ssh config + control socket in `$TMPDIR/herdr-ssh-<pid>-0/` |
| Mac | `herdr client` | local TUI renderer, local keybindings (`--remote-keybindings local` default) |
| Mac | `ssh … -T … exec herdr … remote-client-bridge` | transport, no TTY, stdio pipe; ControlMaster mux so extra channels can reuse it |
| Server | `tailscaled be-child ssh` | Tailscale SSH (server has `RunSSH: true`); identity = `JeffreyVdb@github` from node 203.0.113.20 |
| Server | `herdr --session X remote-client-bridge` | relays stdio ↔ the session's private `herdr-client.sock` |
| Server | `herdr server` (per session) | owns PTYs, agents, state, `session.json` persistence |

The server log shows the client protocol is a semantic render stream, not raw PTY bytes:
`client connected client_id=2 cols=160 rows=56 ... render_encoding=SemanticFrame`.
So "remote mode" is **not** socket forwarding of the public API; it is an SSH-exec'd bridge speaking herdr's private
client protocol (versioned: `private_protocol: 22`, `endpoint_protocol_generation: 1`). `--handoff` opts into live
handoff (moving an attached client across a server binary upgrade; `server.live_handoff` API method,
`capabilities.live_handoff: true` in `ping`). `herdr machine add` "prepares the remote Herdr server and saves an SSH
machine" so the local TUI can list/switch machines; Theo doesn't use it (he uses `--remote` directly).

Docs (persistence-remote, v0.9.1) confirm: "the remote server owns the running panes and sends their terminal content and
session state over SSH. Your local Herdr draws the UI". `herdr --remote` uses a temporary SSH config (user config first,
plus keepalives) and a private per-attach ControlMaster socket (`[remote].manage_ssh_config = false` disables that); plain
OpenSSH auth. Saved machines (`herdr machine add`) show several hosts in one window: only the *selected* machine streams
pane screens, others stream workspace/agent state only; reconnect backoff up to 2 min; idle bridges closed after 1 min
without traffic (server keeps running).

**Implication for the game:** the private client protocol is undocumented and version-locked → don't build on it.
The **public socket API** (`herdr api schema --json`, 275 KB JSON Schema, `protocol: 22`) is the supported surface.

### Public socket API facts (verified by probe)

- Socket: `~/.config/herdr/sessions/<name>/herdr.sock`, mode `0600`, owner dev. Default session:
  `~/.config/herdr/herdr.sock`. `herdr session list --json` gives name, running, socket_path for all 24 sessions (11 running).
- Framing: write one JSON line `{"id":"1","method":"…","params":{…}}\n`, read one JSON line. The server closes the
  connection after the response (second write → `BrokenPipe`), **except** `events.subscribe`, which answers
  `{"result":{"type":"subscription_started"}}` and then streams events on the same connection.
- Subscribable events: `workspace.{created,updated,metadata_updated,renamed,moved,reordered,closed,focused}`,
  `worktree.*`, `tab.*`, `pane.{created,closed,updated,focused,moved,exited,agent_detected}`,
  `pane.agent_status_changed` (per `pane_id`, optional status filter), `pane.output_matched` (per pane, regex/substring),
  `pane.scroll_changed`, `layout.updated`. Agent status enum: `idle | working | blocked | done | unknown`.
- **No raw output stream in the JSON API.** A live ANSI stream exists via the CLI instead (see §4 "Live terminal").
  Snapshot terminal content = `pane.read {pane_id, source: visible|recent|recent_unwrapped|detection,
  format: text|ansi, lines}`. Responses carry `revision` (was `0` on every probe of a busy pane, so don't rely on it for
  change detection; hash the text instead — flag: needs confirmation from the herdr researcher).
- Commands relevant to the game: `workspace.create {cwd, label, env, focus}`, `agent.start {name, kind, pane_id, args}`
  (kinds incl. `claude`, `codex`, …), `agent.prompt`, `agent.send_keys`, `agent.wait`, `workspace.close`, `pane.close`,
  `workspace.focus`, `agent.focus`, `workspace.report_metadata` / `pane.report_metadata` (display-only tokens, max 16 keys,
  `ttl_ms` ≤ 24 h, values ≤ 80 chars, ≤ 32 keys per resource — docs: "Token metadata is not restored after a server
  restart"). Changes/expiry emit `workspace.metadata_updated`.
- Live handoff (server upgrade) keeps PTYs/agents but "subscription streams, client sockets … may be interrupted; clients
  should reconnect and retry" → the bridge must treat any socket EOF as "resnapshot".
- Timings (Python, one connection per call, server under normal load):

| call | latency | bytes |
|---|---|---|
| `ping` | 0.48 ms | 212 |
| `session.snapshot` (5 workspaces) | 1.49 ms | 8.2 KB |
| `pane.read visible text` | 1.7 ms | 2.7 KB |
| `pane.read visible ansi` | 0.6 ms | 5.2 KB |
| `agent.list` | 0.96 ms | — |
| snapshot + agent.list × 11 running sessions | 37 ms total | 163 KB |
| `herdr --session herdr-3d agent list` (CLI fork+exec) | 3.5 ms locally | — |

Tailnet RTT server → Mac: **22 ms, direct** (not DERP) via `tailscale ping`.

## 2. Transport options

| | (a) Bridge daemon, WS on tailnet | (b) SSH + forwarded unix sockets | (c) herdr CLI over ssh per command (or `--machine`, 0.9.1+) | (d1) tsnet-embedded bridge | (d2) gRPC |
|---|---|---|---|---|---|
| State latency | push; event → Mac ≈ RTT (22 ms) | push per socket | poll only; ssh exec per call ≈ 50–150 ms even with ControlMaster | same as (a) | same as (a) |
| Commands | 1 WS msg (~25 ms) | 1 socket msg, but a **new forwarded connection per request** (API closes after each response) → new SSH channel each time | 1 ssh exec each | same as (a) | same |
| Multi-session | bridge fans out N sockets locally (37 ms for all) | game must forward 11–25 sockets, track sessions starting/stopping, re-forward | loop over sessions per poll | same as (a) | same |
| Game-only data (buildings) | lives in bridge SQLite | needs a separate store anyway | same | same | same |
| Robustness | one reconnecting socket; bridge survives Mac sleep, keeps model warm; server-side watch of new sessions | fragile: many forwards, socket paths change as sessions come/go, unix-socket forwarding over Tailscale SSH needs checking | simple but slow, no events | + own node identity, no `tailscale serve` config | codegen, heavy for a Godot/Swift client |
| Security | tailnet-only + WhoIs allow-list; narrow command set | full API = full shell as dev | full shell as dev | node can be ACL-tagged separately | same as (a) |
| Effort | medium (≈1–2 k LOC) | high in game client | low, but ceiling is low | medium+ (Go only) | high |
| Client needs | WebSocket + JSON only | SSH lib in the game | SSH lib / spawn ssh | WS | gRPC lib |

**Recommend (a).** It is the only option that gives push updates for *all* sessions over one connection, has a natural
home for the building layer, keeps the game client dumb (WebSocket + JSON works in Godot, Unity, Swift/RealityKit,
Bevy, a browser), and lets us expose a narrow, typed command set instead of "anything herdr can do". Note: herdr **0.9.1** adds `herdr --machine <label> agent list|pane …|agent prompt …` which carries JSON API requests over
non-interactive SSH to a saved machine (no TUI needed, no auto-retry) — **not in the installed 0.9.0** (`unknown option:
--machine`) and still per-session request/response without cross-session events, so it doesn't change the recommendation.
(c) is fine as the bridge's **fallback** internally (e.g. for commands the socket API lacks) and for the first-day prototype.

**Language: Go.** Reasons: single static binary; first-class Tailscale libraries (`tailscale.com/client/local` WhoIs,
`tsnet` if we ever want the bridge to be its own tailnet node); good WebSocket libs (`github.com/coder/websocket`);
`modernc.org/sqlite` (pure Go, no cgo). Rust (tokio + axum + rusqlite) is equally good if the team prefers it — herdr is
itself Rust — but the Tailscale integration story is Go-native. Python/Node would work for a prototype; a long-lived
daemon with many streams is nicer in Go.

Deployment: `systemd --user` unit (`herdr-world.service`), `Restart=always`, after `tailscaled`. It must run as **dev**
(sockets are `0600 dev`).

## 3. Auth / security

The bridge can create workspaces and start agents that run with bypass permissions → **treat it as equivalent to a
shell as dev on devbox.**

1. **Never public.** No Funnel. Either
   - **Preferred: `tailscale serve --bg --https=<port> http://127.0.0.1:<port>`** (Theo already uses serve for 4 tailnet-only
     services on this box). Bridge listens on `127.0.0.1` only. Serve terminates TLS with the `*.example.net` cert and injects
     `Tailscale-User-Login` / `Tailscale-User-Name` headers (stripped from incoming requests to prevent spoofing; not set for
     tagged devices; Funnel traffic gets none) — source: https://tailscale.com/docs/features/tailscale-serve (identity headers).
     WebSocket upgrade passes through the HTTP proxy.
   - Or bind directly to `203.0.113.10:<port>` and call **LocalAPI WhoIs** on each connection's remote addr
     (`tailscale whois --json 203.0.113.20` works as dev; LocalAPI socket `/var/run/tailscale/tailscaled.sock` is `0666`).
     This also gives the **node** (`StableID example-stable-id`, `devmac`), so you can allow-list
     "Theo *and* the Mac" — headers only give the user. Plain `ws://` is still WireGuard-encrypted end to end.
2. **Allow-list:** user `JeffreyVdb@github` (ID 8966199681587026); optionally node StableID of the Mac. Reject everything
   else with 403 before upgrading the WebSocket.
3. **Residual risk of the localhost + headers pattern:** any local process can hit `127.0.0.1:<port>` with forged headers.
   On this box every local process runs as dev and can already use the herdr sockets directly, so this adds no new
   privilege — but it means **coding agents on the server can drive the bridge.** Mitigation: also require a per-install
   bearer token stored on the Mac (`~/Library/Application Support/herdr-3d/token`) and on the server
   (`~/.config/herdr-world/token`, 0600), or use the direct-bind + WhoIs variant which cannot be forged from localhost.
   **Recommend: direct bind to tailnet IP + WhoIs (user + node) + no token.** Simple and unforgeable.
4. **Narrow command surface.** Bridge exposes typed commands (hire, fire, prompt, focus, open-terminal), not a generic
   "call any herdr method" passthrough. Validate harness/model/effort against an allow-list; `cwd` must be under
   `~/devel`. Log every mutating command with user/node to an audit table.
5. **Destructive actions** (fire = close workspace while agent is `working`) require a `confirm: true` field the UI sets
   after a dialog. Never expose `server.stop`, `session delete`.
6. Tailscale ACLs (optional hardening): restrict port to `autogroup:owner` / the Mac in the tailnet policy.

## 4. Protocol sketch (bridge ↔ game)

Transport: one WebSocket, text frames, JSON (msgpack later if ever needed; volumes are tiny). Every message:
`{"v":1,"t":"<type>", ...}`. Server-to-client state messages carry a monotonically increasing `seq`.

### Handshake / resync

```jsonc
// client → server
{"v":1,"t":"hello","client":"herdr-3d-mac/0.1","proto":[1],"last_seq":1234,"epoch":"b7e1…"}
// server → client  (epoch changes when the bridge restarts)
{"v":1,"t":"welcome","proto":1,"epoch":"b7e1…","server":"devbox","herdr":"0.9.0","herdr_protocol":22}
// if epoch matches and last_seq is still in the ring buffer (e.g. last 5000 events):
... replays events seq 1235.. ...
// else:
{"v":1,"t":"world.snapshot","seq":5120,"world":{
  "buildings":[{"id":"b_personal","name":"Personal","pos":[0,0],"style":"cottage","floors":["games","claudia"]}],
  "floors":[{"session":"herdr-3d","running":true,"building":"b_work","order":3}],
  "workers":[{"key":"herdr-3d/w2","session":"herdr-3d","workspace_id":"w2","label":"GROUND|herdr",
              "status":"working","agents":[{"pane_id":"w2:p1","agent":"claude","name":"r-herdr",
              "title":"…","status":"working"}],"avatar":"frog-3","desk":2,"freelancer":false}]
}}
```

### Server → client events (upserts carry full objects; removals carry keys)

`building.upsert|removed`, `floor.upsert|removed` (session appeared, started, stopped, reassigned), `worker.upsert|removed`
(workspace), `agent.status` (`{key, pane_id, status, title}` — the hot path), `worker.focus`, `freelancer.spawned|finished`,
`terminal.frame` (see below), `cmd.result` (`{req_id, ok, error?, data?}`), `notice` (toast).

### Client → server commands (all carry `req_id`)

| cmd | params | bridge does |
|---|---|---|
| `hire` | session, label, harness (`claude`/`codex`), model, effort, cwd?, initial_prompt? | `workspace.create` → `agent.start {kind, args:[--model …]}` → optional `agent.prompt` |
| `fire` | worker key, confirm | `workspace.close` |
| `prompt` | worker key / pane_id, text | `agent.prompt` |
| `keys` | pane_id, keys | `agent.send_keys` (e.g. approve a blocked agent) |
| `focus` | worker key / pane | `workspace.focus` / `agent.focus` (moves the TUI focus for the next real attach) |
| `watch_terminal` / `unwatch_terminal` | pane_id, fps(≤5), rows? | starts/stops the pane.read poller |
| `open_terminal` | worker key | returns `{argv:["herdr","--remote","dev@devbox","--session",s]}` after focusing; Mac client launches it |
| `building.create/rename/move/delete`, `floor.assign {session, building, order}`, `worker.customize {avatar,…}` | | writes SQLite, emits upserts |
| `session.start` (open a floor) | name | `herdr --session <name>` headless start; flag: check the exact non-interactive start path with the herdr researcher |

Versioning: `v` = envelope version; `proto` negotiated in hello; unknown `t` ignored by both sides; additive fields only
within a proto version.

### Bridge internals

- **Discovery loop** every 2–5 s: `herdr session list --json` (or read the sessions dir) → start/stop per-session actors
  as sessions start/stop. Also `inotify` on `~/.config/herdr/sessions/` for instant pickup.
- **Per running session actor**: follow herdr's documented bootstrap to avoid a gap: open `events.subscribe` first, wait
  for `subscription_started`, buffer events, then `session.snapshot` + `agent.list`, apply buffered events in order.
  Hold that subscription connection
  (workspace.*, pane.*, layout.updated, and one `pane.agent_status_changed` subscription per agent pane — re-subscribe
  when panes are created). On disconnect/EOF: mark floor "lights off", backoff reconnect, re-snapshot and diff.
- **Safety net**: full re-poll of all sessions every 30 s (≈40 ms) and diff against the model, so a missed event can't
  leave the world stale.
- **Diffing**: model is keyed `session/workspace_id` and `session/pane_id`. Workspace ids are persisted in
  `session.json` (`"id":"w1"`), so they survive server restarts; still store `identity_cwd` + label to detect reuse.

### Live terminal in-game

**Primary: `herdr terminal session observe`** (documented for 0.9.1, present in installed 0.9.0, verified):

```
$ herdr --session herdr-3d terminal session observe w4:p1 --cols 120 --rows 40
{"type":"terminal.frame","seq":1,"full":true,"width":120,"height":40,"encoding":"ansi","bytes":"G1s/MjAyNmgb..."}   # 9.2 KB b64
{"type":"terminal.frame","seq":2,"full":false,...,"bytes":"..."}                                                   # 6.8 KB b64 diff
... terminal.closed when the server ends the stream
```

Docs (socket-api / persistence-remote, v0.9.1): "Multiple observers can watch the same terminal without taking input,
resize, scroll, or takeover ownership"; an observer is disconnected if a write makes no progress for 30 s, and a stalled
stream can end without `terminal.closed`. It rides herdr's numbered binary protocol internally ("same-install"), so the
bridge should **spawn the CLI as a subprocess** (stable contract) rather than speak that protocol itself. The bridge relays
frames verbatim over the WebSocket (`terminal.frame {pane_id, seq, full, w, h, b64}`); the Mac feeds the bytes into a VT
emulator (e.g. SwiftTerm, libvterm, xterm.js-in-webview, a Godot VT addon) and renders to a texture. On reconnect/new
viewer, restart the observer to get a fresh `full` frame. Cost: one ~few-MB process per watched pane; cap at ~4 concurrent.

Writable variant: `herdr terminal session control <pane> --takeover --cols --rows` (NDJSON stdin `terminal.input`,
`terminal.resize`, `terminal.scroll`, `terminal.release`; one controller at a time). **Don't use by default** — takeover
would steal input/size from Theo's attached TUI. Prefer `agent.prompt`/`agent.send_keys` for in-game input.

**Fallback (no subprocess):** while a pane is on screen (camera zoomed on a desk or a "monitor" UI open) the bridge
polls `pane.read {source:"visible", format:"ansi"}` at **4 Hz** (max 10 Hz), hashes the text, and sends
`terminal.frame {pane_id, rows, cols, ansi, hash}` only on change. A busy Claude pane ≈ 5 KB/frame → ≤ 20 KB/s per watched
pane; idle panes cost nothing. Cap concurrent watches (e.g. 4). Far-away workers show only status + title (from events).
The client renders ANSI into a texture (Godot/Unity/Swift all have simple VT parsers; or render text-only `format:text`
for a small "screen glow" preview). Use `pane.output_matched` subscriptions for special effects (e.g. "tests passed").
Upgrade path: if herdr later adds an output-stream subscription (ask upstream), swap the poller.

Input from the in-game terminal = `agent.prompt` / `agent.send_keys` — good for approvals and quick prompts. For real work
use "open in terminal".

### "Open this pane in my real terminal"

1. Game sends `open_terminal {worker}`.
2. Bridge calls `workspace.focus` (+ `agent.focus`) in that session, returns argv.
3. Mac client spawns the user's terminal: e.g. `open -na Ghostty --args -e herdr --remote dev@devbox --session herdr-3d`
   (or `osascript` for Terminal/iTerm). If a `herdr --remote … --session <s>` is already running (Theo often has several),
   just focusing is enough — the attached TUI follows the focus change. Detecting that is local to the Mac (`pgrep -f`).
4. Alternative for a single pane without the full TUI: `ssh -t dev@devbox herdr --session <s> agent attach <target>`
   (`--takeover` exists). Keep as an option; flag: check how it coexists with an attached TUI.

## 5. Where to persist buildings and other game-only data

Options:
- **herdr metadata** (`workspace.report_metadata` / `pane.report_metadata` tokens): display-only, ≤ 16 keys per report,
  ≤ 32 per resource, values ≤ 80 chars, `ttl_ms` ≤ 24 h, "not restored after a server restart" → **unsuitable** for durable data. Also it is per-workspace, while buildings group *sessions*,
  which have no metadata API at all.
- **Session naming convention** (e.g. `work.depot-manager`): zero storage but renames are disruptive and don't hold positions/avatars.
- **Bridge-owned SQLite** at `~/.local/share/herdr-world/world.db` (WAL mode). ✅ Recommended.

Schema sketch:

```sql
buildings(id TEXT PK, name TEXT, style TEXT, x REAL, z REAL, created_at, updated_at)
floors(session_name TEXT PK, building_id TEXT REFERENCES buildings, ord INT, color TEXT)
workers(session_name, workspace_id, identity_cwd, label, avatar TEXT, desk INT,
        hired_at, fired_at, harness, model, effort, freelancer INT, parent_key TEXT,
        PRIMARY KEY(session_name, workspace_id, hired_at))
audit(ts, who_user, who_node, cmd, params_json, ok, error)
kv(key TEXT PK, value TEXT)  -- camera, schema version
```

Unassigned sessions go to an automatic "Unzoned" building so nothing is hidden. Back it up with the rest of `~/.local/share`
(or commit an export to the repo). Optionally *also* push the building name as a workspace metadata token (refreshed
< ttl) so it shows up in the herdr TUI — purely cosmetic.

Freelancers: bridge recognises workspaces spawned by an orchestrator (label prefix convention from the write-code skill,
e.g. `GROUND|…`, `CODER|…`, or an env var/metadata token set at spawn) and flags them `freelancer:true, parent_key` so the
game can walk them in/out. Flag: coordinate the exact marker with the write-code researcher.

## 6. Resource cost on the server

Measured now: 24 sessions, **11 running**, 63 workspaces, 61 agents. 15 herdr processes ≈ **286 MB RSS, ~33 % of one core
total** (herdr servers 18–40 MB each; remote-client-bridge ~4 MB each; each tailscaled ssh child ~22 MB). Box: 32 cores,
39 GB RAM (10.5 GB available).

Bridge at ~25 running sessions / ~150 workspaces:
- 25 idle subscription sockets + a 30 s safety re-poll (~100 ms of work, ~400 KB) → effectively 0 CPU.
- Terminal observers: ≤ 4 `observe` subprocesses (a few MB each); traffic proportional to screen change, ~7–9 KB per
  full frame, smaller diffs; idle panes send nothing.
- Memory: Go daemon with SQLite and a 5 000-event ring buffer: ~20–40 MB.
- Compared to one extra `herdr --remote` attach (≈26 MB on the server, one SSH per session), the bridge is cheaper than
  attaching to all sessions from the Mac, which is the only other way to "see everything".
- The real load remains the agents themselves (Claude/Codex processes), not the bridge.

## Recommendation

Build **`herdr-world`, a Go bridge daemon** on devbox (systemd user unit), that
1. discovers sessions, keeps one `events.subscribe` per running session + periodic re-poll, and maintains a world model;
2. owns a SQLite DB for buildings, floor assignment, avatars, hire history, audit;
3. exposes one **WebSocket** bound to the tailnet IP, authorising each connection via Tailscale **WhoIs** (Theo's user +
   the Mac's node);
4. speaks a small versioned JSON protocol: `hello/welcome` → `world.snapshot` or replay → `*.upsert/removed/status`
   events; typed commands `hire/fire/prompt/keys/focus/watch_terminal/open_terminal/building.*`;
5. streams in-game terminals by relaying `herdr terminal session observe` (read-only, incremental ANSI) for on-screen panes,
   with `pane.read ansi` polling as fallback;
6. hands off to the real terminal by focusing and returning a `herdr --remote … --session …` argv the Mac client launches.

Prototype path: day 1 a 200-line Python/Go script that polls all sockets every second and serves `world.snapshot` over WS —
enough to drive the first 3D scene — then add subscriptions, SQLite and commands.

## Open questions for Theo

1. Is it OK for the bridge to run as a `systemd --user` service on devbox, reachable only from your tailnet (your
   user + the MacBook)? Any other devices (iPad/phone) that should be allowed?
2. Which terminal app on the Mac should "open in real terminal" launch (Ghostty / iTerm / Terminal / WezTerm)?
3. Should stopped sessions (13 of 24 today) appear as dark floors, or be hidden until started? Should the game be allowed
   to start them?
4. Fire semantics: close the workspace outright, or first ask the agent to wrap up / commit? Allowed while `working`?
5. Where should buildings come from initially — manual in-game, or seed from a config (e.g. Personal = games, claudia,
   bnb-prototype…; Work = depot-manager, code-review…)?
6. Go vs Rust for the bridge (recommend Go for Tailscale libs; Rust matches herdr).

## Sources

- Live inspection on devbox and the Mac (commands above), 2026-09-28.
- `herdr --help`, `herdr <cmd> --help`, `herdr api schema --json` (herdr 0.9.0, schema_version 1, protocol 22).
- Tailscale Serve identity headers: https://tailscale.com/docs/features/tailscale-serve
- Tailscale identity / `tailscale whois`: https://tailscale.com/docs/concepts/tailscale-identity, https://tailscale.com/docs/reference/tailscale-cli
- herdr docs (stable 0.9.1; installed is 0.9.0): https://herdr.dev/llms.txt → socket-api, persistence-remote,
  connecting-machines, session-state, cli-reference pages (raw: github.com/herdrdev/herdr/tree/v0.9.1/docs/next/website/src/content/docs).
  `remote-client-bridge` is not documented; its behaviour here is inferred from `ps` + server logs.
