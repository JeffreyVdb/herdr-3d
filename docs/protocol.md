# herdr-world protocol v1

The bridge (`herdr-world`) serves one WebSocket to game clients. This document is the contract; the Go types live in
[`internal/proto`](../internal/proto/proto.go). Design background: [`architecture.md`](architecture.md) §3–4.

## Transport

- A unix socket at `$XDG_RUNTIME_DIR/herdr-world/bridge.sock` (`--socket` / `HERDR_WORLD_SOCKET` to override). The
  directory is `0700`, the socket `0600`: access is "can act as this unix user", which for the Mac means "has SSH access"
  (`ssh -N -L <local.sock>:<bridge.sock>`). Nothing listens on TCP.
- HTTP/1.1 on that socket: `GET /ws` upgrades to the WebSocket, `GET /healthz` answers `ok`.
  ```sh
  curl --unix-socket "$XDG_RUNTIME_DIR/herdr-world/bridge.sock" http://herdr-world/healthz
  ```
- Text frames, one JSON object per frame. Every object has a string field `t`, its type. Client messages are limited to
  64 KiB.
- The bridge reads herdr (`ping`, `session.snapshot`, `events.subscribe`, `herdr session list`, and for the laptop
  screens the read-only `herdr terminal session observe`). Its only writes to herdr are `floor.wake` / `floor.sleep`
  (see [Wake and sleep](#wake-and-sleep)), `worker.hire` / `worker.fire` (see [Hire and send
  home](#hire-and-send-home)) and typing into a pane for `worker.keys`, `worker.prompt` and `worker.answer` (see
  [Laptops](#laptops-screens-input-changes-and-usage)), through a narrow allowlist of `herdr` / `systemd-run` command
  shapes (CONTRIBUTING "Bridge" lists them), plus a few typed `git` commands for hiring into a worktree, checking a
  tree before sending its worker home and reading a worker's changes. Every other command only changes the bridge's
  own SQLite database.

### Through `h3d-helper` (the Mac)

The game does not dial the socket itself. `h3d-helper` forwards it over SSH and serves the game on
`http://127.0.0.1:7777`; the game opens `ws://${location.host}/ws?token=<token>` on that same origin and the helper
proxies it to the bridge's `/ws` unchanged (see CONTRIBUTING "Helper"). The helper answers `403` without upgrading
unless all three hold:

- `Host` is `127.0.0.1:<port>` or `localhost:<port>` (or `<ip>:<port>` when `--listen` is another literal loopback
  IP, e.g. `[::1]:<port>`);
- `Origin` is `http://127.0.0.1:<port>` or `http://localhost:<port>` (or `http://<ip>:<port>` likewise);
- `token` is the token of this helper run. The helper makes a random one at every start and opens the game at
  `http://127.0.0.1:<port>/#token=<token>`; the game keeps it in `sessionStorage` (`h3d.token`) and strips it from the
  URL.

A `502` means the tunnel is down; the helper's own `GET /healthz` reports the tunnel state
(`{"tunnel":{"state":"up|connecting|degraded|backoff",…}}`, `503` unless `up`).

## Handshake

The first client message must be `hello`. Anything else gets an `error` with code `hello_required` and the connection
is closed (status 1008). A `proto` other than `1` gets `unsupported_proto` and is closed the same way.

```json
{"t":"hello","proto":1,"client":"herdr-3d-mac/0.1"}
```

`client` is a free-form label for logs and the audit log (not trusted, not authentication). The bridge answers
`welcome`, then either a `world.snapshot` or a replay (see [Reconnecting](#reconnecting-since_seq)), then live events:

```json
{"t":"welcome","proto":1,"server_seq":1042,"epoch":"0fc8ba663c9c83d9","resume":"snapshot","server":"herdr-world v0.2.0"}
```

| field | meaning |
|---|---|
| `server_seq` | seq of the last event emitted so far (0 before the first) |
| `epoch` | identifies this bridge process; changes on every restart. Keep it for reconnects. |
| `resume` | `snapshot`: a `world.snapshot` follows. `replay`: the missed events follow, up to `server_seq`. |

## The world

```json
{"t":"world.snapshot","seq":1042,"world":{
  "buildings":[
    {"id":"b_3f09a1c2d4e5","name":"Work","sort":0,"floors":["code-review","depot-manager"]},
    {"id":"b_77aa01b2c3d4","name":"Personal","sort":1,"floors":[]}
  ],
  "unassigned":["pastry","herdr-3d"],
  "floors":[
    {"session":"code-review","state":"running","building":"b_3f09a1c2d4e5","index":0,"desks":16},
    {"session":"depot-manager","state":"asleep","building":"b_3f09a1c2d4e5","index":1,"desks":9},
    {"session":"pastry","state":"asleep","building":null,"index":null,"desks":6},
    {"session":"herdr-3d","state":"running","building":null,"index":null,"desks":6,
     "settings":{"repo":"JeffreyVdb/herdr-3d","project":{"owner":"JeffreyVdb","number":1},
                 "status_field":{"name":"Status","options":["Todo","Doing","QA","Done"]}},
     "suggested":{"repo":"JeffreyVdb/herdr-3d","default_cwd":"/home/dev/devel/herdr-3d"}}
  ],
  "workers":[
    {"id":"6db1905e-9e85-42f4-911c-b05e31b84c68","session":"herdr-3d","workspace_id":"w1","label":"CODE|m2-go|3|r1",
     "cwd":"/home/dev/devel/herdr-3d-wt/m2-go","pane_id":"w1:p1","agent_kind":"claude",
     "agent_session":"c6f58eef-ca04-4fe4-a564-3b15f8311bf3","status":"working",
     "title":"M2: Go helper tunnel and bridge additions",
     "tokens":{"h3d_role":"code","h3d_run":"20260928-1455-m2-city","h3d_harness":"claude",
               "h3d_model":"claude-opus-5-5","h3d_effort":"xhigh"},
     "worktree":{"repo_root":"/home/dev/devel/herdr-3d","repo_name":"herdr-3d",
                 "checkout_path":"/home/dev/devel/herdr-3d-wt/m2-go","linked":true},
     "role":"code","run":"20260928-1455-m2-city",
     "name":"Flicker","desk_index":1,"harness":"claude","model":"claude-opus-5-5","effort":"xhigh",
     "status_since":1790601900984}
  ],
  "hire_options":{
    "claude":{"models":["claude-opus-5-5","claude-fable-5-1"],"efforts":["low","medium","high","xhigh","max"]},
    "codex":{"models":["gpt-6-sol","gpt-6-luna","gpt-6-astra"],"efforts":["low","medium","high","xhigh","max"],
             "extra_efforts":{"gpt-6-sol":["ultra"],"gpt-6-astra":["ultra"]}}}
}}
```

`seq` is the seq of the last event the snapshot includes: apply live events with a higher `seq` on top of it.

`hire_options` lists what can be hired: models and efforts per harness, `extra_efforts` being efforts only some models
take. `floor.settings.set` validates `default_hire` against it; clients should read it rather than hardcode the lists.

Order is meaningful: `buildings` are in `sort` order and each lists its floors top to bottom (`index` order);
`unassigned` is the lot of sessions that are in no building, by name. `floors` follows the same order (buildings, then the
lot), and `workers` follows the floors, each floor's workers in herdr's sidebar order.

### Building

| field | type | |
|---|---|---|
| `id` | string | bridge-generated, `b_<hex>` |
| `name` | string | 1–64 bytes, unique ignoring case |
| `sort` | int | 0-based position among buildings |
| `floors` | string[] | known sessions in this building, in floor order (derived) |

### Floor (a herdr session)

| field | type | |
|---|---|---|
| `session` | string | herdr session name (the key) |
| `state` | `running` \| `asleep` | `running` = its server answers on its socket; a leftover socket file does not count |
| `default` | bool, optional | herdr's default session |
| `building` | string \| null | building id, `null` = in the unassigned lot |
| `index` | int \| null | floor position within the building, `null` when unassigned. Positions also count assigned sessions that currently do not exist, so there can be gaps: order by `index`. |
| `error` | string, optional | why the floor cannot be read: e.g. `unsupported session.json version 4`, or `herdr: …` for a running session that answers ping but cannot be snapshotted (its workers are kept as last seen) |
| `desks` | int | desks the floor renders: `max(highest desk_index + 1, min(cap, max(6, workers + 2)))`, `cap` = `--max-desks` (default 96). So there are always spare desks to hire into, and every worker has a desk even past the cap. |
| `transition` | `waking` \| `sleeping`, optional | a `floor.wake` / `floor.sleep` is in progress (see [Wake and sleep](#wake-and-sleep)) |
| `settings` | object, optional | the floor's stored settings, only the keys that are set: `repo`, `project`, `status_field`, `default_cwd`, `default_hire` (shapes as in [`floor.settings.set`](#floor-settings)) |
| `suggested` | object, optional | bridge-derived defaults: `repo` and `default_cwd` (see [Floor settings](#floor-settings)). What a client shows for a setting is `settings.X ?? suggested.X`. |

An asleep floor's workers come from herdr's saved `session.json` (format version 3 only; any other version leaves the
floor with no workers and an `error`).

### Worker (a herdr workspace)

| field | type | |
|---|---|---|
| `id` | string | bridge-owned UUID, stable across bridge and herdr restarts (see below) |
| `session`, `workspace_id` | string | where it is now (`workspace_id` alone is not an identity: herdr can reuse ids) |
| `label` | string | workspace label (herdr's automatic label when unnamed) |
| `cwd` | string, optional | working directory of the primary pane |
| `pane_id` | string, optional | primary pane: the first pane with an agent, else the first pane |
| `pane_label` | string, optional | its pane label |
| `agent_kind` | string, optional | `claude`, `codex`, … (empty: a plain shell) |
| `agent_name` | string, optional | herdr agent name |
| `agent_session` | string, optional | native agent session id; present on sleeping workers that can resume |
| `status` | string | herdr agent status of the primary pane: `idle` \| `working` \| `blocked` \| `done` \| `unknown` (`done` = idle, not yet seen). Workers on an asleep floor are `unknown`. |
| `status_since` | int | when `status` last changed, unix **milliseconds** on the bridge's clock (herdr has no timestamp). See [Desks and names](#desks-and-names) for restarts. |
| `title` | string, optional | terminal title, herdr's `terminal_title_stripped` (Claude Code keeps it set to the current task) |
| `tokens` | object, optional | the workspace's `h3d_*` metadata tokens (live only; herdr does not persist tokens) |
| `worktree` | object, optional | `repo_root`, `repo_name`, `checkout_path`, `linked` |
| `role`, `run` | string, optional | write-code role and run: from the `h3d_role` / `h3d_run` tokens, else from a label `ROLE\|descr\|…` with ROLE one of `ORCH`, `CODE`, `REVIEW`, `UX`, `GROUND` (role lower-cased, run = `descr`) |
| `name` | string | display name, unique among the floor's workers (see below) |
| `desk_index` | int ≥ 0 | the worker's desk on its floor (see below) |
| `harness` | string, optional | `claude`, `codex`, …: the `h3d_harness` token, else `agent_kind` when that is `claude` or `codex` |
| `model`, `effort` | string, optional | the `h3d_model` / `h3d_effort` tokens (e.g. `claude-opus-5-5` / `xhigh`, `gpt-6-sol` / `high`) |
| `resume` | `pending` \| `confirmed` \| `fallback` \| `failed`, optional | only during and after a wake, for workers with an `agent_session`: how their agent came back (see [Wake and sleep](#wake-and-sleep)). Cleared by the next sleep and by a bridge restart. |
| `hired_at` | int, optional | unix ms when the bridge hired this worker (`worker.hire`; stored). A client that first sees a worker with a recent `hired_at` (the game: under ~15 s) plays its walk-in. |
| `branch` | string, optional | the checked-out branch of a worker in a linked worktree (`worktree.linked`), when known (read from the checkout's git `HEAD`; absent on a detached `HEAD`) |
| `usage` | object, optional | its agent session's token counts and cost estimate (see [Usage and cost](#usage-and-cost)); absent without an `agent_session` (a running Codex excepted), or until the bridge found its transcript |
| `question` | object, optional | what the screen of a `blocked` worker asks, while it is blocked (see [Blocked workers](#blocked-workers-question-quick-reply-approve--deny)) |

`harness`, `model` and `effort` are remembered once seen: herdr drops tokens when it restarts and asleep floors have
none, so the bridge keeps the last known value until a new one shows up. They are absent when never known.

**Identity.** When a workspace appears (bridge start, herdr restart, reconnect), the bridge matches it to a stored worker
by, in order: a pane-label marker `h3d-<short uuid>`; the native `agent_session` id; label + identity directory (only for
workers it has not seen closing). Otherwise it is a new worker. The bridge writes a marker only on the workers it hires
(`worker.hire` labels their root pane `h3d-<first 12 hex of the worker id>`); it never writes tokens to herdr.

### Desks and names

Each worker holds a **desk** on its floor: `desk_index` is stored in SQLite (`desk_assignment`) under the worker's id,
so it survives bridge and herdr restarts whenever the identity reconciles to the same worker. A worker new to its floor
takes the **lowest free** index, in sidebar order; a worker the bridge hires (`worker.hire`) takes the desk it was hired
at, which is reserved from the moment the hire is accepted. A desk is freed when its worker leaves the floor
(`worker.removed`: workspace closed, identity lost, session deleted), and the next newcomer reuses it. Workers of an
asleep floor keep their desks.

Each worker also gets a **name** from a built-in list of original names ("Nibble", "Pixel", "Mochi", …). Names are
unique among the floor's workers; past the end of the list they get a suffix (`"Pixel 2"`). A name belongs to one
worker of its floor at a time (SQLite `worker_name`), and comes back with it after a restart or when its workspace
reopens. When the bridge sees the worker leave the floor (`worker.removed`: workspace closed, identity lost, session
deleted), the name stays **held** for `--name-hold` (default 7 days) from that moment: no newcomer gets it, so a
worker that returns within the hold always has its name. A worker that leaves while the bridge is down is seen leaving
when the bridge next observes its floor, so the hold starts late, never early.

After the hold a newcomer may take the name. The worker that left then no longer owns it and gets a new name if it
ever comes back: that is the one intended name change. A worker returning after its hold whose name nobody took keeps
it. Besides that, only a failed database write (after the next bridge restart) or, once, a name that an earlier
development build stored twice on a floor (the most recently seen worker keeps it) can change a worker's name.

`status_since` is stored with the status it belongs to. After a bridge restart a worker whose status is unchanged
keeps its `status_since` (idle ages don't reset); one whose status changed while the bridge was down starts at the
time the bridge sees it.

## Events

Every change is an event with a strictly increasing `seq` (+1 per event, per epoch). Clients should apply them in order
and remember the last `seq` applied.

| `t` | fields | when |
|---|---|---|
| `building.upsert` | `building` | a building was created, renamed, reordered, or its floor list changed |
| `building.removed` | `id` | a building was deleted (its floors got `floor.upsert` with `building: null` first) |
| `floor.upsert` | `floor` | a session appeared, started, stopped, was (re)assigned, or its `error`, `transition`, `settings` or `suggested` changed |
| `floor.removed` | `session` | the session was deleted in herdr (its workers get `worker.removed` first) |
| `worker.upsert` | `worker` | a worker appeared, or anything besides `status`/`title` changed, e.g. its `resume` (full object) |
| `worker.status` | `id`, `session`, `workspace_id`, `status`, `prev_status`, `status_since`, `title` | only `status` and/or `title` changed (the hot path). `title` is always present, `""` when cleared; on a title-only change `prev_status` equals `status` and `status_since` does not move. |
| `worker.removed` | `id`, `session`, `workspace_id`, `reason`? | the workspace closed, the session was deleted, or the identity changed. `reason` is `"sent_home"` when the removal comes from `worker.fire` (the game plays the walk-out); absent otherwise. |
| `worker.usage` | `id`, `session`, `usage` | the worker's `usage` changed; at most once per 5 s per worker (see [Usage and cost](#usage-and-cost)) |

```json
{"t":"floor.upsert","seq":1043,"floor":{"session":"herdr-3d","state":"running","building":null,"index":null,"desks":7}}
{"t":"worker.upsert","seq":1044,"worker":{"id":"a58752ea-6511-4318-be9a-59e41c09d7c5","session":"herdr-3d","workspace_id":"wE","label":"CODE|lobby|7|r1","pane_id":"wE:p1","status":"unknown","role":"code","run":"lobby","name":"Mochi","desk_index":4,"status_since":1790601900972}}
{"t":"worker.status","seq":1045,"id":"a58752ea-6511-4318-be9a-59e41c09d7c5","session":"herdr-3d","workspace_id":"wE","status":"working","prev_status":"unknown","status_since":1790601903410,"title":"Reading hub.go"}
{"t":"worker.status","seq":1046,"id":"a58752ea-6511-4318-be9a-59e41c09d7c5","session":"herdr-3d","workspace_id":"wE","status":"working","prev_status":"working","status_since":1790601903410,"title":"Writing tests"}
{"t":"worker.removed","seq":1047,"id":"a58752ea-6511-4318-be9a-59e41c09d7c5","session":"herdr-3d","workspace_id":"wE"}
{"t":"building.upsert","seq":1048,"building":{"id":"b_3f09a1c2d4e5","name":"Work","sort":0,"floors":["code-review"]}}
{"t":"building.removed","seq":1049,"id":"b_77aa01b2c3d4"}
{"t":"floor.removed","seq":1050,"session":"pastry"}
```

`terminal.frame` and `terminal.closed` ([Laptop screens](#laptop-screens)) are not events: they go only to the
connection that watches, have no `seq`, are not in the replay ring and are never replayed.

A status or title change can also arrive inside a `worker.upsert` (when something else changed at the same time), so
take `status`, `status_since` and `title` from both. When one observation changes a floor and its workers, the
`floor.upsert` (e.g. a new `desks`) comes first, then the worker events. Latency: status and lifecycle changes normally show up well under a second; sessions starting or
stopping within ~2 s (a stopping session is noticed as soon as its event stream ends). The bridge re-reads every running
session every 30 s as a safety net.

## Reconnecting (`since_seq`)

The bridge keeps the last 4096 events in memory. To resume after a disconnect, send the `epoch` from the last `welcome`
and the last `seq` you applied:

```json
{"t":"hello","proto":1,"client":"herdr-3d-mac/0.1","since_seq":1047,"epoch":"0fc8ba663c9c83d9"}
```

- If `epoch` matches and every event after `since_seq` is still buffered, `welcome.resume` is `replay` and exactly the
  events `since_seq+1 … server_seq` follow, then live events. With nothing missed (`since_seq == server_seq`), no
  events are replayed.
- Otherwise (bridge restarted so the epoch differs, no `epoch` sent, `since_seq` too old or in the future, or a replay
  too large for the client queue) `welcome.resume` is `snapshot` and a fresh `world.snapshot` follows: drop local state
  and rebuild from it.

```json
{"t":"welcome","proto":1,"server_seq":1050,"epoch":"0fc8ba663c9c83d9","resume":"replay","server":"herdr-world v0.2.0"}
{"t":"building.upsert","seq":1048,"building":{"id":"b_3f09a1c2d4e5","name":"Work","sort":0,"floors":["code-review"]}}
{"t":"building.removed","seq":1049,"id":"b_77aa01b2c3d4"}
{"t":"floor.removed","seq":1050,"session":"pastry"}
```

## Commands

```json
{"t":"building.create","req_id":"7","args":{"name":"Work"}}
```

`req_id` (a non-empty string of the client's choosing) is required. Each command is answered with exactly one `ack` or
`error` carrying the same `req_id`. The events a command causes are sent **before** its `ack`, so when the ack arrives
the client's world already reflects it. Every command, accepted or not, is written to the audit log, a known `t`
without `req_id` too (an unknown `t` is not a command and is not logged).
`args` must not contain unknown fields.

| `t` | `args` | `ack.data` | events |
|---|---|---|---|
| `building.create` | `{"name": string}` | `{"id": string}` | `building.upsert` |
| `building.rename` | `{"id": string, "name": string}` | — | `building.upsert` |
| `building.delete` | `{"id": string}` | — | `floor.upsert` for each of its floors (now unassigned), `building.upsert` for buildings whose `sort` shifted, then `building.removed` |
| `building.reorder` | `{"ids": [string…]}`: every building id exactly once, in the new order | — | `building.upsert` for each moved building |
| `floor.assign` | `{"session": string, "building": string \| null, "index"?: int}`: `null` moves the floor to the unassigned lot; `index` inserts at that position (clamped), omitted appends | — | `floor.upsert` for every floor whose position changed, `building.upsert` for the buildings involved |
| `floor.settings.set` | `{"session": string, "repo"?, "project"?, "status_field"?, "default_cwd"?, "default_hire"?}`: an absent key stays as it is, `null` clears it, a value sets it (see [Floor settings](#floor-settings)) | — | `floor.upsert` carrying the new `settings` (and `suggested`, when the chosen repo changes it); none when nothing changed |
| `floor.wake` | `{"session": string}` | `{"workers": [{"id", "resume"}]}`: every worker of the floor in sidebar order, `resume` one of `confirmed`, `fallback`, `failed`, or `none` (no `agent_session`: nothing to resume) | `floor.upsert` with `transition: "waking"`, `worker.upsert` (`resume: "pending"`) for each resumable worker, then the floor running and its workers as the watcher sees them, `worker.upsert` as each `resume` settles, and a final `floor.upsert` without `transition` |
| `floor.sleep` | `{"session": string}` | — | `floor.upsert` with `transition: "sleeping"` (and `worker.upsert` for workers whose `resume` is cleared), then `floor.upsert` with `state: "asleep"` and no `transition`, then the asleep workers |
| `hire.prepare` | `{"session": string, "cwd"?: string}` | what the hire dialog shows: `{"cwd", "choice", "choice_source", "label", "git", "capacity"}` (see [Hire and send home](#hire-and-send-home)) | — |
| `worker.hire` | `{"session", "desk_index": int, "harness", "model", "effort", "label"?, "cwd"?, "worktree"?: bool, "prompt"?}` | `{"id", "workspace_id", "branch"?, "base_sha"?, "trust", "prompted"?, "prompt_error"?}` (`fetch_error` is reserved: a failed fetch is `fetch_failed`) | `floor.upsert` (when `desks` changes), then `worker.upsert` of the new worker at `desk_index` with `hired_at`, `harness`, `model`, `effort`, then its later upserts / statuses (marker, agent) |
| `worker.fire.prepare` | `{"id": string}` | `{"name", "label", "branch"?, "worktree", "dirty", "unpushed", "can_delete", "can_delete_branch", "reason"?, "can_fire", "fire_blocked"?}` | — |
| `worker.fire` | `{"id": string, "worktree"?: "keep" \| "delete" \| "delete_branch"}` (default `keep`) | `{"worktree": "kept" \| "deleted" \| "deleted_branch", "released": bool, "note"?}` | `worker.removed` with `reason: "sent_home"`, then `floor.upsert` when `desks` changes |
| `worker.changes` | `{"id": string}` | the worker's git changes, `{"cwd", "branch", "head", "upstream", "ahead", "behind", "base", "files", "stat", "diff", "diff_bytes", "truncated", "omitted"}` (see [Changes](#changes)) | — |
| `terminal.watch` | `{"id": string, "fps"?: 1–30, "cols"?: 40–300, "rows"?: 10–100}` | `{"pane", "cols", "rows"}` | `terminal.frame`s to this connection only (see [Laptop screens](#laptop-screens)) |
| `terminal.unwatch` | `{"id": string}` | — | — |
| `worker.keys` | `{"id": string, "input": [{"text": string} \| {"key": string}…]}` | — | — (see [Input](#input)) |
| `worker.prompt` | `{"id": string, "text": string}` | `{"queued": bool, "retried": bool}` | the worker's statuses |
| `worker.answer` | `{"id": string, "hash": string, "choice"?: 1–9, "cancel"?: true}` | `{"sent": [string…], "resolved": bool}` | the worker's upsert without its `question` when it moves on |

```json
{"t":"floor.assign","req_id":"8","args":{"session":"code-review","building":"b_3f09a1c2d4e5","index":0}}
{"t":"floor.upsert","seq":1051,"floor":{"session":"code-review","state":"running","building":"b_3f09a1c2d4e5","index":0,"desks":16}}
{"t":"building.upsert","seq":1052,"building":{"id":"b_3f09a1c2d4e5","name":"Work","sort":0,"floors":["code-review"]}}
{"t":"ack","req_id":"8"}
```

Buildings, their order, floor assignments and floor settings are stored in SQLite
(`$XDG_STATE_HOME/herdr-world/world.db`) and survive bridge restarts. Assignments and settings are kept for sessions
that are currently gone, so a re-created session returns to its floor with its settings.

Floor commands (`floor.assign`, `floor.settings.set`, `floor.wake`, `floor.sleep`) and the hire and fire commands on a
floor whose wake or sleep is in progress answer `busy`; so do `floor.wake` / `floor.sleep` while a hire or a send-home on
that floor is in progress. They only act on sessions the bridge watches (`--sessions`); any other name, known to herdr or
not, is `unknown_session`.

### Floor settings

```json
{"t":"floor.settings.set","req_id":"12","args":{"session":"herdr-3d","repo":"JeffreyVdb/herdr-3d",
  "project":{"owner":"JeffreyVdb","number":1},"status_field":{"name":"Status","options":["Todo","Doing","QA","Done"]},
  "default_cwd":null,"default_hire":{"harness":"claude","model":"claude-opus-5-5","effort":"medium"}}}
{"t":"floor.upsert","seq":1060,"floor":{"session":"herdr-3d","state":"running","building":null,"index":null,"desks":6,
  "settings":{"repo":"JeffreyVdb/herdr-3d","project":{"owner":"JeffreyVdb","number":1},
              "status_field":{"name":"Status","options":["Todo","Doing","QA","Done"]},
              "default_hire":{"harness":"claude","model":"claude-opus-5-5","effort":"medium"}},
  "suggested":{"repo":"JeffreyVdb/herdr-3d","default_cwd":"/home/dev/devel/herdr-3d"}}}
{"t":"ack","req_id":"12"}
```

| key | value (`null` clears) | rule, else `bad_request` |
|---|---|---|
| `repo` | `"owner/repo"` | a GitHub name: owner `[A-Za-z0-9-]{1,39}`, repo `[A-Za-z0-9._-]{1,100}` |
| `project` | `{"owner": string, "number": int}` | a GitHub Project (v2): owner as above, number ≥ 1 |
| `status_field` | `{"name": string, "options": [string…]}` | name 1–64 bytes; 1–20 options, each 1–64 bytes, unique (not blank). A client may pre-fill `{"name":"Status","options":["Todo","Doing","QA","Done"]}`. Stored for the issue boards (M7). |
| `default_cwd` | absolute path | an existing directory on the bridge host; stored cleaned (no trailing `/`) |
| `default_hire` | `{"harness", "model", "effort"}` | one of `hire_options`: a model of that harness, an effort of it or an `extra_efforts` entry of that model (`ultra` only for `gpt-6-sol` / `gpt-6-astra`) |

Objects must not have other keys. Settings live in SQLite `floor_repo`.

`suggested` is computed by the bridge, never stored:

- `repo`: the most common GitHub `owner/repo` among the origins (`git -C <cwd> remote get-url origin`) of the floor's
  workers' `cwd` (asleep floors: the cwds in `session.json`); ties go to the one that comes first in sidebar order. ssh
  (`git@github.com:o/r(.git)`, `ssh://git@github.com/o/r`) and https (`https://github.com/o/r(.git)`) remotes count;
  others are ignored. Lookups run in the background, are cached per directory for 5 minutes and repeated when the
  floor's cwds change, so `suggested` can arrive in a later `floor.upsert`.
- `default_cwd`: the `worktree.repo_root` (the root checkout, not a linked worktree) of the first worker whose origin is
  the effective repo (`settings.repo`, else `suggested.repo`).

Either is absent when there is nothing to suggest.

### Wake and sleep

A floor wakes and sleeps through herdr itself. The bridge acts only on sessions it watches, with validated names
(`[A-Za-z0-9._-]{1,64}`, no leading `-`), and passes every argument as its own argv element. An abbreviated wake
(`…` stands for the usual fields):

```json
{"t":"floor.wake","req_id":"20","args":{"session":"h3d-scratch"}}
{"t":"floor.upsert","seq":1100,"floor":{"session":"h3d-scratch","state":"asleep","building":null,"index":null,"desks":6,"transition":"waking"}}
{"t":"worker.upsert","seq":1101,"worker":{"id":"4de7…","name":"Jingle","desk_index":0,"agent_session":"03d8…","status":"unknown","resume":"pending",…}}
{"t":"floor.upsert","seq":1102,"floor":{"session":"h3d-scratch","state":"running",…,"transition":"waking"}}
{"t":"worker.status","seq":1103,…}
{"t":"worker.upsert","seq":1104,"worker":{"id":"4de7…",…,"resume":"confirmed"}}
{"t":"floor.upsert","seq":1105,"floor":{"session":"h3d-scratch","state":"running",…}}
{"t":"ack","req_id":"20","data":{"workers":[{"id":"4de7…","resume":"confirmed"},{"id":"5863…","resume":"none"}]}}
```

**Wake** (the floor must be asleep, else `invalid_state`):

1. `systemd-run --user --unit=herdr-s-<name> --collect -p KillMode=process --working-directory=$HOME /bin/fish -l -c
   "exec herdr --session '<name>' server"`: a supervised headless server with the user's login environment (their fish
   wrappers and API keys, none of the bridge's `CLAUDE*`/`HERDR_*` variables). It fails (`wake_failed`) if the unit
   cannot start, e.g. a `herdr-s-<name>` unit still exists.
2. `ping` on the session's socket, backing off up to 1 s: no answer is `wake_failed` (the message says why). The
   workers' `resume` is then cleared again; the floor stays asleep.
3. The bridge follows the session at once (no 2 s poll) and waits until it sees it running; a floor not seen running in
   time is `wake_failed` too. Steps 1–3 together have `--wake-timeout` (10 s). herdr resumes every pane that had an
   `agent_session` by itself (`claude --resume <id>` / `codex resume <id>`).
4. Each such worker is `pending` until its agent is back: herdr reports `pane.agent_detected` naming the agent for its
   pane, or `herdr pane process-info` shows the agent (`claude` / `codex`, or its session id) in the pane's foreground
   for 1.5 s in a row. herdr 0.9 restores a pane's agent before the agent runs and sends no detection for a resume, so
   the process is the usual evidence. It then turns `confirmed`.
5. After `--resume-timeout` (10 s), each worker still pending whose pane is back at its shell prompt (the shell is the
   foreground process group) gets its resume command typed in once: `herdr pane run <pane> "claude --resume <id>"` or
   `"codex resume <id>"`. A pane running something else is left alone. The fallback and the wait after it share one
   more `--resume-timeout`: workers whose agent then comes back are `fallback` (or `confirmed`, when herdr's own
   resume was just slow), the rest `failed`.
6. The transition ends and the ack lists every worker. Each phase's deadline bounds every herdr call in it, and the
   panes are watched side by side, so worst case the ack takes about `--wake-timeout` + 2 × `--resume-timeout` (30 s),
   however many workers the floor has: show progress from `transition` and `resume`, not from the ack.

**Sleep** (the floor must be running, else `invalid_state`):

1. Each Codex worker without an `agent_session` is backfilled, so it can resume: the id comes from the newest
   `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (`$CODEX_HOME`, `--codex-sessions`) whose `session_meta` cwd is the
   pane's cwd and that no other worker of the floor uses, reported with `herdr pane report-agent-session <pane>
   --source herdr:codex --agent codex --agent-session-id <id>`. No such rollout: skipped.
2. `herdr session stop <name> --json`: herdr saves the session, ends the panes' processes and keeps each pane's
   `agent_session`. A failure is `sleep_failed` (the floor stays running). The bridge never `/exit`s agents and never
   uses `systemctl stop`: both lose the resume link.
3. The ack follows once the floor is seen asleep (its workers from `session.json`, at the same desks with the same
   names; up to 15 s). A floor not seen asleep in time is `sleep_failed`.

Workers keep their ids, desks and names through a sleep and a wake (the identity rules of [Worker](#worker-a-herdr-workspace)).

**Audit log.** Each wake and sleep writes its `audit_log` row when it starts (not done yet) and completes it with the
outcome and a JSON `result`: for a wake the time until `ping` answered and, per worker, its pane, final `resume` and
what happened (`agent process running`, `pane.agent_detected`, `fallback: ran the resume command`, `no fallback: the
pane is not at its shell prompt`, …); for a sleep each backfill (`agent_session`, `skipped` or `error`), herdr's `stop`
output and whether the floor was seen asleep. Rejected commands are logged like any other.

### Hire and send home

Hire and send home act only on **running** floors the bridge watches (`--sessions`): an unwatched or unknown session is
`unknown_session`, an asleep floor `invalid_state`, a floor that is waking or sleeping `busy`.

**`hire.prepare`** fills the hire dialog. It changes nothing (it does run `git fetch origin`, which only updates
remote-tracking refs) and is audited like any command.

```json
{"t":"hire.prepare","req_id":"30","args":{"session":"herdr-3d"}}
{"t":"ack","req_id":"30","data":{"cwd":"/home/dev/devel/herdr-3d",
  "choice":{"harness":"claude","model":"claude-opus-5-5","effort":"medium"},"choice_source":"floor_default",
  "label":"Mochi",
  "git":{"repo_root":"/home/dev/devel/herdr-3d","default_branch":"main",
         "base_sha":"8739ddc5f3e1d0c4b2a8e7f6d5c4b3a2918e7d6c","base_time":1790600000000,"fetched":true},
  "capacity":{"floor":{"count":7,"soft":10,"hard":20},"host":{"count":23,"soft":30,"hard":60},
              "load":{"load1":2.41,"cpus":16,"mem_used_pct":61.5}}}}
```

| field | |
|---|---|
| `cwd` | `args.cwd` when given (an absolute, existing directory, else `bad_request`), else the floor's effective default cwd (`settings.default_cwd ?? suggested.default_cwd`), else the bridge user's home directory |
| `choice`, `choice_source` | the harness/model/effort to pre-select: the floor's `default_hire` (`"floor_default"`), else the last choice hired on this floor (`"last"`, stored per floor in SQLite, table `floor_hire_last`), else `null` (`"none"`). A remembered choice no longer in `hire_options` is skipped. |
| `label` | the next generated worker name (a name no worker of the floor owns or holds): the default label, and the new worker's name when the hire keeps it |
| `git` | `null` when `cwd` is not in a git work tree. Else `repo_root` (the work tree's top level), `default_branch` (from `origin/HEAD`, else `main` / `master` when `origin/<that>` exists; `""` when unknown), `base_sha` and `base_time` (unix ms, commit time) of `origin/<default_branch>` **after** `git fetch origin`, `fetched` and, when the fetch failed (no `origin`, offline, …, bounded at 20 s), `fetch_error`. A failed fetch is not an error of `hire.prepare` (the base shown is then the last fetched one), but the dialog should warn: a worktree hire now would be refused with `fetch_failed`. A plain hire is unaffected. |
| `capacity` | workers on this floor (`floor.count`, hires in flight included; a worktree hire as two while herdr may open its repository's main checkout too) and on every running floor the bridge watches (`host.count`), with the configured caps (`--warn-workers-per-floor` / `--max-workers-per-floor`, `--warn-workers` / `--max-workers`). A hire that would reach above `hard` is refused (`capacity`); above `soft` the dialog should warn. `load` is the host's 1-minute load average, CPU count and memory in use (`/proc`); absent when unreadable. |

**`worker.hire`** hires a worker at a free desk:

```json
{"t":"worker.hire","req_id":"31","args":{"session":"herdr-3d","desk_index":4,"harness":"claude","model":"claude-opus-5-5",
  "effort":"medium","label":"Mochi","worktree":true,"prompt":"Read CONTRIBUTING.md and summarise it."}}
{"t":"worker.upsert","seq":1200,"worker":{"id":"a58752ea-6511-4318-be9a-59e41c09d7c5","session":"herdr-3d","workspace_id":"w9",
  "label":"Mochi","cwd":"/home/dev/.herdr/worktrees/herdr-3d/h3d-mochi-a58752","status":"unknown","name":"Mochi","desk_index":4,
  "harness":"claude","model":"claude-opus-5-5","effort":"medium","hired_at":1790601900000,"status_since":1790601900050,
  "worktree":{"repo_root":"/home/dev/devel/herdr-3d","repo_name":"herdr-3d",
              "checkout_path":"/home/dev/.herdr/worktrees/herdr-3d/h3d-mochi-a58752","linked":true},"branch":"h3d/mochi-a58752"}}
{"t":"worker.upsert","seq":1201,"worker":{"id":"a58752ea-…","pane_label":"h3d-a58752ea6511",…}}
{"t":"worker.status","seq":1202,"id":"a58752ea-…","status":"idle",…}
{"t":"ack","req_id":"31","data":{"id":"a58752ea-6511-4318-be9a-59e41c09d7c5","workspace_id":"w9","branch":"h3d/mochi-a58752",
  "base_sha":"8739ddc5f3e1d0c4b2a8e7f6d5c4b3a2918e7d6c","trust":"approved","prompted":true}}
```

| arg | rule, else `bad_request` |
|---|---|
| `session` | a running, watched floor |
| `desk_index` | `0 ≤ desk_index < floor.desks`, and free: no worker holds it and no other hire in flight reserved it (else `desk_taken`, also for an out-of-range desk). Two hires to one desk: the first accepted wins, the other is `desk_taken`. |
| `harness`, `model`, `effort` | one of `hire_options` (as `default_hire`) |
| `label` | 1–64 bytes, no control characters, not starting with `-`; default: the next generated name (`hire.prepare`'s `label`). The worker's name is the label when that is a free generated name, else the next generated name. |
| `cwd` | absolute, existing directory; default as in `hire.prepare` |
| `worktree` | `true`: hire into a new linked git worktree and branch of `cwd`'s repository (below); `cwd` must be in a git work tree with a known `origin/<default>` |
| `prompt` | optional first task, 1–32768 bytes of UTF-8 without NUL, not starting with `--` (herdr's CLI would read it as a flag). Sent once the agent is ready. |
| `handoff`, `stop_services` | reserved (M9, #14); refused like any unknown field |

Capacity: a hire that would put the floor above `--max-workers-per-floor` or the host above `--max-workers` is
`capacity` (the `message` says which). A worktree hire counts as **two** workers when no workspace of the
repository's main checkout is open on the floor, because herdr then opens one too (step 1). That is checked when the
hire is accepted (the main checkout counts as open when `cwd` is inside the `worktree.repo_root` of an open,
non-linked worker) and again once git named the repository, before herdr makes anything; a `capacity` then comes
after the accept, like the `bad_request` for a missing default branch. Then, in order (each step bounded; the whole hire usually takes 4–10 s):

1. **Worktree hires**: `git fetch origin` in the repository. If it fails, the hire is refused with `fetch_failed`
   (the `message` is git's error) and nothing is made: a branch from the last fetched, possibly stale
   `origin/<default>` would revert what was merged since. Then `herdr worktree create --cwd <repo_root> --branch h3d/<name>-<id6> --base origin/<default> --label <label>
   --no-focus`. `<name>` is the worker's name lower-cased with every run of other characters as `-`, `<id6>` the first 6
   hex of its id. The base is always the freshly fetched `origin/<default>`, **never the local `HEAD`** (a stale local
   `HEAD` makes every new branch revert what was merged since; agent-office #119). herdr puts the checkout at
   `~/.herdr/worktrees/<repo>/<branch with / as ->`. The branch is recorded in SQLite (table `hire_branch`: worker id,
   repository, branch, the base commit it was made from): only a branch recorded for a worker is ever deleted, by that
   worker's send home or by its hire's rollback. When no workspace of the repository's main checkout is open on the
   floor, herdr opens one too (its worktree group needs it): it shows up as one more worker, in the main checkout, at the
   lowest free desk. Plain hires: `herdr workspace create --cwd <cwd> --label <label> --no-focus`.
2. The new workspace is bound to the worker id minted for this hire, so it appears at `desk_index` with its name,
   `hired_at`, `harness`, `model` and `effort` (`worker.upsert`). Its root pane gets the identity marker
   `herdr pane rename <pane> h3d-<12 hex>`.
3. `herdr agent start <name>-<id6> --kind claude|codex --pane <pane> --timeout 30000 -- <native args>`. herdr types the
   command into the pane's shell, so the user's fish wrappers apply. Native args, exactly:
   - claude: `--model <model> --effort <effort> --permission-mode bypassPermissions --name <label>`
   - codex: `-m <model> -c model_reasoning_effort=<effort> --dangerously-bypass-approvals-and-sandbox`
4. **Trust dialog.** Both agents ask whether to trust a folder they have not seen, and a fresh worktree is always new
   to them. Claude's dialog is `blocked` for herdr (`agent start` fails with `agent_not_ready`); Codex's is not detected
   at all (herdr reports it `idle`). `herdr worktree create --trust-repository` does **not** help: it is herdr's own git
   trust, not the agents'. So the bridge reads the pane's screen (`herdr pane read --source visible`) and, when it shows
   the agent's trust question naming the hire's directory as a whole path, answers it the way a person would: Claude `Down` + `Enter`
   ("Yes, I trust this folder"), Codex `Enter` ("1. Trust and continue"). The user chose that directory in the hire
   dialog, which is the consent. "As a whole path": lines the agent hard-wrapped are joined first (a line that
   reaches about the screen's width runs on into the next; both agents break a long path one column short of the pane
   width and indent the rest), and the directory must then start after the line start, whitespace or a quote and end
   before the line end, whitespace or a quote: `/tmp/repo` does not match a dialog for `/tmp/repo-other`,
   `/tmp/repo/sub` or `/x/tmp/repo`. A screen that cannot be read that way is left for the player. `trust` in the ack is `approved` when it did, `none` when no dialog showed.
   (`avoided` is reserved for a later way of avoiding it.) Any other `blocked` state is left for the player.
5. The optional `prompt`: `herdr agent prompt <pane> <prompt> --wait --until working --until blocked --timeout 8000`,
   retried while herdr says the agent is not ready. An agent just past its trust dialog can take the text but drop the
   Enter (herdr: `agent_prompt_stalled`); the bridge then presses `Enter` (up to 3 times) until the worker is working.
   A prompt that fails does not undo the hire: the ack has `prompted: false` and `prompt_error`.
6. The choice is remembered for the floor, the audit row completed, and the ack sent (after the worker's
   `worker.upsert`).

A hire that fails after its workspace exists is rolled back, and the error is `hire_failed` with what went wrong.
Plain hires: `herdr workspace close`. Worktree hires lose nothing: the checkout is removed (`herdr worktree remove`)
only when `git status --porcelain` there is clean, else only the workspace is closed and checkout and branch are kept;
the branch is deleted (`git branch -D`) only when it still points at the base commit it was made from (`git rev-parse
--verify --quiet refs/heads/<branch>`), else it is kept. Whatever is kept is named in the error message (`…; rolling
back, the branch h3d/… is kept (it has commits since …)`) and in the audit row's `rollback`.

**`worker.fire.prepare`** fills the send-home dialog. It only reads (`git status --porcelain`, `git rev-list --count HEAD
--not --remotes`, `git symbolic-ref --quiet --short HEAD` in the worker's checkout: `worktree.checkout_path`, else its
`cwd`; `git rev-list --count refs/heads/<branch> --not --remotes` for the branch the bridge made):

```json
{"t":"worker.fire.prepare","req_id":"40","args":{"id":"a58752ea-6511-4318-be9a-59e41c09d7c5"}}
{"t":"ack","req_id":"40","data":{"name":"Mochi","label":"Mochi","branch":"h3d/mochi-a58752",
  "worktree":{"path":"/home/dev/.herdr/worktrees/herdr-3d/h3d-mochi-a58752","linked":true},
  "dirty":[" M internal/server/hub.go","?? notes.txt"],"unpushed":2,"can_delete":false,"can_delete_branch":false,
  "reason":"2 uncommitted changes, 2 commits not on any remote","can_fire":true}}
```

| field | |
|---|---|
| `branch` | the branch checked out in the worker's linked worktree, read now (not the `worker.branch` last shown, which may be up to 15 s old); absent on a detached HEAD |
| `worktree` | `{"path", "linked"}` of the worker's git checkout, `null` when its directory is not in a git work tree |
| `dirty` | `git status --porcelain` lines (at most 50) |
| `unpushed` | commits reachable from `HEAD` that are on no remote-tracking branch |
| `can_delete` | the worker is in a linked worktree, the tree is clean and nothing is unpushed. Only then may `worker.fire` delete the worktree. |
| `can_delete_branch` | `can_delete`, and the bridge recorded making a branch for this worker (`hire_branch`), the checkout is on that branch now, and every commit of that branch is on a remote. Only then may `worker.fire` use `delete_branch`: offer "delete worktree + branch" only when this is `true`. |
| `reason` | why `can_delete` is false |
| `can_fire`, `fire_blocked` | `false` (and why) when herdr would refuse to close the workspace: a repository's main checkout whose linked worktree workspaces are still open on the floor (herdr's `workspace_group_close_required`; send those home first). The bridge never closes a group. |

**`worker.fire`** sends the worker home:

```json
{"t":"worker.fire","req_id":"41","args":{"id":"a58752ea-6511-4318-be9a-59e41c09d7c5","worktree":"keep"}}
{"t":"worker.removed","seq":1300,"id":"a58752ea-6511-4318-be9a-59e41c09d7c5","session":"herdr-3d","workspace_id":"w9","reason":"sent_home"}
{"t":"ack","req_id":"41","data":{"worktree":"kept","released":true}}
```

1. `worktree` `delete` / `delete_branch` need a worker in a linked worktree (else `bad_request`) and a clean, fully
   pushed tree, checked again now (else `not_clean`, and nothing happens). `delete_branch` also needs a branch the
   bridge recorded making for this worker (`hire_branch`; an `h3d/…` name alone is not enough, else `bad_request`),
   the checkout still on that branch (read now), and every commit of that branch on a remote (`git rev-list --count
   refs/heads/<branch> --not --remotes`); else `not_clean`, and nothing happens.
2. Graceful exit, when the pane runs the agent: Claude `herdr pane send-text <pane> /exit` + `Enter`, Codex `/quit`, a
   short pause (its command popup takes the first Enter otherwise), `Enter`. The bridge waits up to 8 s for the pane to
   be back at its shell (`herdr pane process-info`), pressing `Enter` again up to 3 times on the way (an agent still
   starting up drops it), then tries `Ctrl-C` twice (an agent the bridge has no exit command for gets only the
   `Ctrl-C`s); `released` says whether the agent left by itself. **The workspace is closed only once the agent is
   gone**: if it is still running after all that, or its pane's processes cannot be read, nothing is closed or
   removed and the answer is `fire_failed` (the message says the agent is still running; audited with the keys
   sent). The worker stays; send it home again, or deal with it in herdr. A graceful exit ends the agent's resume
   link, which is what sending home means (never used for sleep).
3. `herdr workspace close <workspace>`, or for a deleted worktree `herdr worktree remove --workspace <workspace>`
   (it closes the workspace; never `--force`). If the tree became dirty, or (`delete_branch`) the checkout left the
   branch or the branch got unpushed commits during the exit, the worktree is kept and `note` says so.
4. `worker.removed` with `reason: "sent_home"`, once the bridge sees the workspace gone (up to 5 s); the desk is free
   again and the name held as for any worker that leaves. For `delete_branch`, then — its commits counted once
   more — `git branch -D <recorded branch>` in the main checkout (safe: every commit is on a remote), and its
   `hire_branch` record is dropped. If the count is not 0 the branch is kept and `note` says so.
5. The audit row is completed with each step (exit keys, released or not, the git state, the cleanup choice and
   outcome) and the ack sent. A failure is `fire_failed` with what went wrong.

`handoff` (M9) and `stop_services` (#14) are reserved `worker.fire` arguments; today they are refused like any unknown
field.

**Audit log.** `hire.prepare` and `worker.fire.prepare` get one row each. `worker.hire` and `worker.fire` get a row when
they start, completed with their outcome and a JSON `result`: for a hire the worker id, workspace, desk, cwd, branch,
base, fetch, trust, the prompt outcome and any rollback; for a fire the git state it saw, how the agent exited, the
cleanup choice and what happened to the worktree and branch.

### Laptops: screens, input, changes and usage

Every laptop command takes the bridge's worker `id`, never a pane id: the bridge uses the worker's own `pane_id`
(its primary pane) as it is when the command runs. A worker on an asleep floor, or one without a pane, is
`invalid_state`; an unknown id, or a worker on a floor the bridge does not watch, `unknown_worker`. Every command is
audit-logged like the others; for `worker.keys` and `worker.prompt` the audit row keeps the lengths of the text and the
key names, **never the text**.

#### Laptop screens

```json
{"t":"terminal.watch","req_id":"50","args":{"id":"6db1905e-…","fps":4}}
{"t":"ack","req_id":"50","data":{"pane":"w1:p1","cols":120,"rows":40}}
{"t":"terminal.frame","id":"6db1905e-…","pane":"w1:p1","n":1,"full":true,"cols":120,"rows":40,"data":"G1s/MjAyNmgb…"}
{"t":"terminal.frame","id":"6db1905e-…","pane":"w1:p1","n":2,"full":false,"cols":120,"rows":40,"data":"G1syOzFI…"}
{"t":"terminal.closed","id":"6db1905e-…","reason":"worker_removed"}
```

- The bridge starts `herdr --session <s> terminal session observe <pane> --cols C --rows R` for the watch: a
  read-only observer (it cannot type, resize, scroll or take over the pane). Its first frame is the full screen, then
  diffs, each only when the screen changes. `data` is the frame's ANSI bytes in base64; a `full:false` frame applies on
  top of the ones before it (a VT emulator such as xterm.js takes them in order). `n` counts the frames of this watch
  from 1; `cols` × `rows` is the observer's size.
- `cols` / `rows` default to **the pane's own size** (herdr's layout for it, from `session.snapshot`; 120 × 40, herdr's
  headless size, when that is unknown). The observer does not reflow: a smaller one shows the pane's top-left part and
  cuts off its bottom lines (where the prompt or a menu is), a larger one pads. So ask for another size only to match a
  known one.
- `fps` (default 4) is the most frames a second the bridge forwards. Diffs that arrive faster are concatenated in order
  into one `full:false` frame (ANSI diffs compose); a full frame replaces whatever is pending.
- Per connection: watching a worker again **restarts** its watch (a new observer, a fresh `full:true` frame, `n` from 1
  again); that is also how to ask for a full frame. `terminal.unwatch` stops it (a no-op for a worker not watched), and
  closing the connection stops them all. After a reconnect, watch again: frames are never replayed.
- Caps: `--max-watches` per connection (default 6), `--max-observers` for the whole bridge (default 16); above either
  `terminal.watch` is `capacity`. Each watch has its own observer.
- **Never block, never leak.** Each observer's output is read continuously. Pending diffs merge into one frame of at
  most 512 KiB. Frames are only queued while the connection's send queue is at most half full, so they never push a
  connection into the `slow consumer` disconnect: when the queue is over half full or the pending frame outgrows
  512 KiB, the bridge drops what is pending, stops the observer and, once the connection has room again, starts a new
  one (a resync: its first frame is full). An observer that exits, or sends no first frame within 5 s (herdr 0.9.0 drops
  no stalled observer itself), is restarted after 250 ms, 500 ms, 1 s; after a 4th failure within 30 s the watch ends
  with `observer_failed`. Silence after the first frame is normal (frames only come on change). Stopping an observer is
  SIGTERM to its process group, SIGKILL after 1 s, and it is always reaped (the kernel also kills it should the bridge
  die). Nothing survives an unwatch, a closed connection or a bridge shutdown.

`terminal.closed` ends a watch the client did not stop itself: `reason` is `worker_removed` (the worker is gone or was
sent home), `asleep` (its floor went to sleep), `pane_changed` (its primary pane changed: watch again) or
`observer_failed`. It is not sent for a `terminal.unwatch`, a re-watch or a closed connection.

#### Input

```json
{"t":"worker.keys","req_id":"51","args":{"id":"6db1905e-…","input":[{"text":"ls -la"},{"key":"enter"}]}}
{"t":"ack","req_id":"51"}
{"t":"worker.prompt","req_id":"52","args":{"id":"6db1905e-…","text":"Run the tests and fix what fails."}}
{"t":"ack","req_id":"52","data":{"queued":false,"retried":false}}
```

**`worker.keys`** types into the worker's pane, in order. `input` has 1–64 items, each exactly one of `{"text":
string}` (typed literally: 1–4096 bytes of UTF-8 without control characters, which must be keys; at most 8 KiB of text
in one command) or `{"key": string}`, one of:

| keys | sent as (xterm, checked on herdr 0.9.0) |
|---|---|
| `enter`, `esc`, `tab`, `shift+tab`, `backspace`, `space` | `\r`, `\e`, `\t`, `\e[Z`, `\x7f`, a space |
| `up`, `down`, `left`, `right` | `\e[A` … `\e[D` (`\eOA` … when the application asked for cursor keys mode) |
| `shift+up`, `shift+down`, `shift+left`, `shift+right`, `ctrl+left`, `ctrl+right`, `alt+left`, `alt+right` | `\e[1;2A` …, `\e[1;5D`, `\e[1;5C`, `\e[1;3D`, `\e[1;3C` |
| `shift+enter`, `alt+enter`, `alt+backspace` | `\e[27;2;13~`, `\e\r`, `\e\x7f` |
| `ctrl+a` … `ctrl+z` | `\x01` … `\x1a` |
| `f1` … `f12` | `\eOP` … `\eOS`, `\e[15~` … `\e[24~` |
| `delete`, `home`, `end`, `pageup`, `pagedown` | `\e[3~`, `\e[H`, `\e[F`, `\e[5~`, `\e[6~`: herdr 0.9.0 has no names for these (`unsupported key`), so the bridge types these fixed sequences |

Anything else (digits and letters are text) is `bad_request`. Consecutive keys go to herdr as one `pane send-keys`,
consecutive texts as one `pane send-text` (a herdr call takes about 10 ms). Input to one worker is serialized: commands
for the same worker (`worker.keys`, `worker.prompt`, `worker.answer`) run one after the other in the order they
arrived, so two quick `worker.keys` never interleave; at most 32 wait per worker (then `input_failed`). herdr
refusing is `input_failed` (the message says which step and why).

**`worker.prompt`** submits a prompt to the worker's agent (`herdr agent prompt <pane> <text>`: bracketed paste, then
Enter). `text` is 1 byte to 16 KiB of UTF-8 without NUL (herdr 0.9.0 takes a leading `--` as text, too). Only for a
worker with an agent (`agent_kind`); a plain shell is `invalid_state` (use `worker.keys`), and so is a `blocked`
worker (answer its question first; herdr would refuse with `agent_blocked`). The game uses it for paste too.

- Worker `working`: the agent takes it for its next turn (Claude and Codex queue it). Sent without waiting; the ack
  says `queued: true`.
- Otherwise herdr waits (up to 8 s) until the worker is `working` or `blocked`. When the text is in the agent's input
  but its Enter was dropped (the known paste quirk; herdr: `agent_prompt_stalled` after 5 s), the bridge presses Enter
  **once** more and waits up to 5 s for `working` / `blocked`: `retried: true`. Still not submitted, or herdr failing
  otherwise: `prompt_failed`.

#### Blocked workers: question, quick reply, approve / deny

```json
"question":{"kind":"permission","text":"Do you want to proceed?",
  "excerpt":["Bash command","touch notes.txt","Create empty file notes.txt","Do you want to proceed?","❯ 1. Yes",
             "2. Yes, and always allow access to /tmp/x from this project","3. No","Esc to cancel · Tab to amend"],
  "choices":[{"n":1,"label":"Yes"},{"n":2,"label":"Yes, and always allow access to /tmp/x from this project"},{"n":3,"label":"No"}],
  "selected":1,"hash":"cdecbf4fcde864bc"}
```

When a worker turns `blocked`, the bridge reads its screen (`herdr pane read --source visible`), and again every 2 s
while it stays blocked; a new question is a `worker.upsert`. `question` is on the worker in snapshots and upserts only
while it is `blocked` and its screen could be read; the upsert of the worker leaving `blocked` has none. Detection is
heuristic, tested on screens captured from Claude Code 2.1 and Codex 0.158 (`internal/server/testdata/screens`):

| field | |
|---|---|
| `kind` | `trust` (the agent's trust-this-folder dialog), `permission` (a menu whose first choice starts with "Yes" and one with "No": a tool or command approval), `choice` (any other menu, e.g. Claude's AskUserQuestion), `other` (blocked, no menu recognised) |
| `text` | the line above the menu that asks ("Do you want to proceed?", "Would you like to run the following command?"), cut after its first `?`; `""` if none |
| `excerpt` | the screen's last ≤ 8 non-empty lines, trimmed, each ≤ 200 characters |
| `choices` | the menu, top to bottom, `n` from 1: the digits shown (`❯ 1. Yes  2. …  3. No`), or for a menu without digits (Claude's trust dialog) the cursor line and the lines aligned with it; `[]` without a menu |
| `selected` | the choice the cursor (`❯` / `›`) is on, when seen |
| `hash` | 16 hex over `kind`, `text`, `choices`, the lines above the menu (what it is about: up to the dialog's top rule, at most 12 lines, e.g. `Bash command` / `touch notes.txt`) and the worker's `status_since` (when it turned `blocked`); not the cursor, not the rest of the excerpt. It is which question an answer is for: an approval never approves another command, file or folder asked with the same words, nor anything asked after the worker was blocked again, even on the same screen. |

What herdr 0.9.0 reports, and what picks a choice (checked live):

| screen | herdr status | picks choice n | Esc |
|---|---|---|---|
| Claude trust dialog (`❯ No, exit` / `Yes, I trust this folder`, no digits) | `blocked` | arrows from `selected`, Enter (a digit does nothing) | cancels |
| Claude tool permission (`❯ 1. Yes` / `2. Yes, and …` / `3. No`) | `blocked` | the digit | rejects (then `done`) |
| Claude AskUserQuestion (`❯ 1. Tea` …, `n. Chat about this`) | `blocked` | the digit | cancels |
| Codex approval (`› 1. Yes, proceed (y)` / `2. …` / `3. No, and tell Codex …`) | `blocked` | the digit | "No" |
| Codex trust dialog (`› 1. Trust and continue` / `2. Quit`) | **`idle`**: never a question | Enter / Down + Enter (a digit does nothing) | quits |

Note that the first choice of Claude's trust dialog is "No, exit": to approve a `trust` question, pick the choice that
trusts (its label starts with "Yes" or "Trust").

**`worker.answer`** answers the question: exactly one of `choice` (1–9, one of the question's `choices`) or `cancel:
true` (Esc: deny / dismiss). The worker must be `blocked` (else `invalid_state`). When its turn on the worker's input
lane comes, the bridge reads the screen again: if the worker is no longer blocked or the question there has another
`hash`, it is `stale` (and the question the screen shows now goes out as a `worker.upsert`). Otherwise it presses the
keys that pick the choice on that kind of menu (above), returned in `sent`, and waits up to 3 s for the worker to leave
`blocked`: `resolved`. A screen that cannot be read, or herdr refusing the keys, is `input_failed`.

```json
{"t":"worker.answer","req_id":"53","args":{"id":"6db1905e-…","hash":"cdecbf4fcde864bc","choice":1}}
{"t":"ack","req_id":"53","data":{"sent":["1"],"resolved":true}}
{"t":"worker.answer","req_id":"54","args":{"id":"6db1905e-…","hash":"210cbd9cf0ff47af","cancel":true}}
{"t":"ack","req_id":"54","data":{"sent":["esc"],"resolved":true}}
```

#### Changes

**`worker.changes`** reads a worker's git state, read-only:

```json
{"t":"worker.changes","req_id":"55","args":{"id":"a58752ea-6511-4318-be9a-59e41c09d7c5"}}
{"t":"ack","req_id":"55","data":{"cwd":"/home/dev/.herdr/worktrees/herdr-3d/mochi","branch":"h3d/mochi-a1b2c3",
  "head":"3f09a1c…","upstream":"origin/h3d/mochi-a1b2c3","ahead":2,"behind":0,
  "base":{"ref":"origin/main","sha":"0d8c09d…"},
  "files":[{"path":"internal/server/term.go","index":"A","worktree":".","insertions":210,"deletions":0,"binary":false},
    {"path":"internal/server/hub.go","index":".","worktree":"M","insertions":12,"deletions":3,"binary":false},
    {"path":"notes.txt","untracked":true,"insertions":4,"deletions":0,"binary":false}],
  "stat":{"files":2,"insertions":222,"deletions":3},
  "diff":"diff --git a/internal/server/hub.go b/internal/server/hub.go\n…","diff_bytes":18230,"truncated":false,"omitted":[]}}
```

| field | |
|---|---|
| `cwd` | where it was read: the worker's checkout (`worktree.checkout_path`), else its `cwd`. Git runs in that directory's work tree top level. |
| `branch` | the checked-out branch, `null` on a detached `HEAD` |
| `head` | `HEAD`'s commit; `""` on an unborn branch |
| `upstream`, `ahead`, `behind` | the branch's upstream (`null`: none) and the commits it is ahead of / behind it (0 without one) |
| `base` | `{"ref": "origin/<default>", "sha"}`: the merge-base of `HEAD` and `origin/<default>` (the default branch as in `hire.prepare`: `origin/HEAD`, else `main` / `master`). `null` when there is no such ref or no common history: the diff is then against `HEAD` (an unborn branch: against the empty tree). There is no fetch: `origin/<default>` is as last fetched. |
| `files` | every changed path, in git's diff order (against the base), then the paths only `git status` lists (changed against `HEAD`, not against the base), then untracked files. `path` is relative to the work tree top level (unquoted); `orig_path` is a rename's old path. `index` and `worktree` are `git status`'s X and Y (`.` unchanged, `M`, `T`, `A`, `D`, `R`, `C`, `U`); both are `.` for a file changed only by commits since the base. An untracked file has `untracked: true` instead. `insertions` / `deletions` are against the base (`--numstat`); a binary file has 0 / 0 and `binary: true`; an untracked text file's `insertions` are its lines (counted up to 1 MiB, else 0). At most 5000 files (then `truncated`). |
| `stat` | the summary line of `git diff --stat <base>`: `files`, `insertions`, `deletions` of the tracked changes (untracked files are not in it) |
| `diff` | the working tree (staged changes included) against the base, exactly as `git diff --find-renames <base>` prints it (no external diff or textconv runs), then a new-file diff for each untracked text file up to 64 KiB (as `git diff --no-index /dev/null <file>` prints it, without the `index` line). At most **256 KiB**: whole files only, in `files` order; a file whose diff does not fit in what is left is listed in `omitted` (a later, smaller one can still fit). A binary file shows git's `Binary files … differ`; untracked binary files, untracked files over 64 KiB, symlinks and anything else that is not a regular file inside the work tree get no content. |
| `diff_bytes` | the size of the whole diff, uncapped, in bytes (the JSON string can differ: invalid UTF-8 is replaced) |
| `truncated`, `omitted` | whether anything was left out (the cap, or files beyond 5000) and the files whose diff was left out for the cap |

The git commands (`internal/gitops`, allowlisted like the rest): `rev-parse --show-toplevel`, `status --porcelain=v2
--branch -z --untracked-files=all`, the default-branch lookup of `hire.prepare` (`symbolic-ref … refs/remotes/origin/HEAD`,
`log -1 origin/<b>`), `merge-base HEAD origin/<default>`, and one `diff --numstat --patch -z --find-renames --no-color
--no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/ <base> --` (numbers and patches from one snapshot of the
tree), with `GIT_OPTIONAL_LOCKS=0` (status does not even refresh the index). Nothing changes the repository. All of it
runs off the hub (other commands are not held up) and shares a **10 s** deadline: past it, `changes_failed`.
Untracked files are read by the bridge, inside the work tree only (no symlink out of it is followed).

Errors: `unknown_worker` (unknown id, or a worker on an unwatched floor), `invalid_state` (its floor is asleep, or it has
no directory), `not_a_repo` (its directory is not in a git work tree), `changes_failed`, `bad_request` (unknown `args`
fields), `internal` (git not configured). Each call is one audit row.

#### Usage and cost

Worker field **`usage`** (in snapshots and `worker.upsert`) and event **`worker.usage`**:

```json
"usage":{"tokens":37210,"input":1200,"output":9010,"cache_write":27000,"cache_read":812000,
         "cost_usd_est":0.4824,"priced":"known","model":"claude-opus-5-5",
         "context_pct":4.2,"context_window":1000000,"updated_at":1790601900984}
{"t":"worker.usage","seq":1200,"id":"a58752ea-6511-4318-be9a-59e41c09d7c5","session":"herdr-3d","usage":{…}}
```

| field | |
|---|---|
| `tokens` | the headline count ("37k tokens"): `input + output + cache_write`. Cache reads are left out: they are the same context read again every turn (a long session reads tens of millions), and Codex's own "tokens used" leaves them out too. |
| `input` | uncached input tokens, summed over the agent session and its subagents |
| `output` | output tokens (Codex: reasoning included, as Codex counts it) |
| `cache_write`, `cache_read` | cache writes (Claude: 5-minute and 1-hour together) and cache reads (Codex: cached input) |
| `cost_usd_est` | an API-equivalent **estimate** in USD, 6 decimals (below): standard API rates, not what a subscription costs; fast mode, batch, tool fees and discounts are not in it. The game labels it `≈$`. |
| `priced` | `known`; `unknown_model` when some tokens are of a model the table does not know (priced as the most expensive model of that harness, the game flags it) or Claude Code's own cost says so; `none` while no model was seen |
| `model` | the model the transcript reports last (Claude: the main transcript's last message; Codex: the last `turn_context`) |
| `context_pct`, `context_window` | how full the context window is (below), 0–100 with one decimal, and the window used; `null` and 0 when unknown |
| `updated_at` | when the bridge saw this usage change, unix ms (bridge clock) |

- `worker.usage` is a world event (it has a `seq` and is replayed). It goes out when the usage changed (anything but
  `updated_at`), and **at most once per 5 s per worker**: a change within 5 s of the last one waits, then goes out as
  the latest value. A worker's first usage goes out as soon as it is read. A worker that loses its `agent_session`
  loses its `usage` (`worker.upsert` without it). Workers without an `agent_session` have none (plain shells), except
  a running Codex (below).
- The bridge checks every worker's transcripts every 2 s, reading from a stored byte offset: complete lines only (an
  incomplete last line waits for the next read), so appending a line reads only that line. A file that shrank or was
  replaced is read again from the start and its session counted afresh. A transcript not found is looked for again at
  most every 30 s (paths found are kept); a session's subagents directory is listed every 10 s. Symlinks are not
  followed; lines over 16 MiB are skipped. Per session it remembers the last 8192 message ids.

**Claude Code** transcripts: `<--claude-projects>/*/<agent_session>.jsonl` (the project directory is looked up, not
derived from the cwd) and its subagents' `<that directory>/<agent_session>/subagents/agent-*.jsonl`.

- Each `type: "assistant"` line has `message.id`, `message.model` and `message.usage` (`input_tokens`, `output_tokens`,
  `cache_creation_input_tokens` with its `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`
  split, `cache_read_input_tokens`). A message streams as several lines with the same `message.id` and a growing
  `output_tokens`: its **last** line counts, once. Subagent messages have ids of their own (never the main
  transcript's) and are added. `<synthetic>` messages (Claude Code's own error notes) have no usage and are skipped.
- **`cost-state` lines exist**: Claude Code writes one when a session ends (`totalCostUSD`, `modelUsage`,
  `hasUnknownModelCost`). A resumed session (a woken floor) appends after it, and the next one is cumulative. Its
  total also counts calls the transcript does not show (titles and other side calls, typically well under 1 %). So
  after a `cost-state`, `cost_usd_est` is its `totalCostUSD` plus the estimate of the messages after it: main
  transcript messages after it, and subagent messages timestamped after the main transcript's last message before it.
  Token counts are always the transcript's.
- Cost: per model, `input × input + output × output + 5m writes × cache_write + 1h writes × cache_write_1h + reads ×
  cache_read` (rates per million tokens); cache writes the 5m/1h split does not account for are priced as 1-hour
  writes (the dearer). On 36 real sessions using only models of the table this gives Claude Code's own `totalCostUSD`
  to the cent.
- Context: the main transcript's last message's prompt (`input + cache_creation + cache_read`) over the model's window
  (`context_window` in the table; a model id ending in `[1m]` has 1M; an unknown model's is unknown: `null`). An
  estimate of what the next turn starts with, not Claude Code's own figure; subagents' contexts are not in it.

**Codex** rollouts: `<--codex-sessions>/YYYY/MM/DD/rollout-*-<agent_session>.jsonl` whose first line's
`session_meta.payload.id` is the session. Codex does not report its session to herdr, so a live Codex worker usually
has no `agent_session` (until the sleep backfill tells herdr). For its usage the bridge then picks the rollout the
backfill would: the newest whose `session_meta.payload.cwd` is the worker's `cwd` and whose session no other worker of
its floor has (their own `agent_session`, or one picked this way first, in worker id order). It looks again every 30 s
(a newer rollout there, e.g. after `/new`, takes over) and remembers each rollout's first line, so a lookup reads only
new files. This is read-only and only for `usage`: herdr is not told, and the worker's `agent_session` stays empty.
Two Codex agents started in the same folder can get each other's rollout.

- The last `event_msg` of `payload.type: "token_count"` with an `info` holds the totals: `info.total_token_usage` with
  `input_tokens` (cached input and cache writes included), `cached_input_tokens`, `cache_write_input_tokens`,
  `output_tokens` (reasoning included: `reasoning_output_tokens` is not added again). One with `info: null` changes
  nothing. The model is the last `turn_context`'s `payload.model`; growth between two token counts is priced at the
  model active then, and counters that go down (a reset) start the sums over.
- Cost: per model, `(input − cached − cache writes) × input + cached × cache_read + cache writes × cache_write + output
  × output`. GPT-6's long-context rates (requests over 272K input tokens) never apply: Codex's window is 258,400.
- Context: Codex's own formula, `(last_token_usage.total_tokens − 12000) / (model_context_window − 12000)` (12K is its
  baseline), clamped to 0–100; `context_window` is `model_context_window`.

**Pricing table** (USD per million tokens, standard API rates, retrieved 2026-09-29; the built-in
`internal/usage/pricing.json`):

| model | harness | input | output | cache write (Claude: 5m) | cache write 1h | cache read | context window |
|---|---|---:|---:|---:|---:|---:|---:|
| `claude-fable-5-1` | claude | 10 | 50 | 12.5 | 20 | 0.25 | 1M |
| `claude-opus-5-5` | claude | 4 | 20 | 5 | 8 | 0.20 | 1M |
| `claude-sonnet-5-5` | claude | 2 | 10 | 2.5 | 4 | 0.20 | 1M |
| `claude-haiku-4-5-20251001` | claude | 1 | 5 | 1.25 | 2 | 0.10 | 200K |
| `gpt-6-astra` | codex | 10 | 50 | 12.5 | — | 1 | (rollout) |
| `gpt-6-sol` | codex | 2 | 10 | 2.5 | — | 0.20 | (rollout) |
| `gpt-6-luna` | codex | 0.10 | 0.50 | 0.125 | — | 0.01 | (rollout) |

An unknown model is priced as the most expensive model of its harness (by output, then input price: Fable 5.1 for
Claude, GPT-6 Astra for Codex) and flagged `unknown_model`. Older models seen in transcripts (`claude-opus-5`,
`claude-fable-5`, `claude-opus-4-8`, `gpt-5.6-*`) are not in the table; add them with `--pricing`.

`--pricing <file>` (`HERDR_WORLD_PRICING`) merges a file of the same format over the built-in table (a model of the same
name is replaced, a new one added). Unknown fields, negative rates or a harness other than `claude` / `codex` stop the
bridge at start:

```json
{"models":{"claude-opus-5":{"harness":"claude","input":5,"output":25,"cache_write":6.25,"cache_write_1h":10,
  "cache_read":0.5,"context_window":1000000}}}
```

`harness` defaults to `claude` for a `claude-…` name, else `codex`; `cache_write_1h` defaults to `cache_write`;
`context_window` (Claude only) to unknown. Account-level plan limits are #12, not this.

### Errors

```json
{"t":"error","req_id":"9","code":"unknown_command","message":"unknown command \"worker.prompt\""}
```

| code | meaning |
|---|---|
| `bad_request` | not a JSON object with `t`; missing `req_id`; bad or unknown `args` fields; invalid name; a second `hello` |
| `unknown_command` | `t` is not a command of this protocol version. The connection stays open. |
| `not_found` | no building with that id |
| `name_taken` | another building already has that name (ignoring case) |
| `unknown_session` | a floor command for a session the bridge does not know or does not watch (`--sessions`) |
| `unknown_worker` | `worker.fire.prepare` / `worker.fire` / the laptop commands for a worker id the bridge does not know (or on an unwatched floor) |
| `busy` | a floor command while that floor's wake or sleep is in progress; `floor.wake` / `floor.sleep` while a hire or send-home on it is in progress; `worker.fire*` for a worker that is still being hired or already being sent home |
| `invalid_state` | `floor.wake` on a running floor, `floor.sleep` on an asleep one, hire or send home on an asleep floor; a laptop command for a worker on an asleep floor or without a pane, `worker.prompt` to a plain shell or a blocked worker, `worker.answer` to a worker not blocked |
| `desk_taken` | `worker.hire` at a desk someone holds or a hire in flight reserved, or outside `0 … desks-1` |
| `capacity` | `worker.hire` above `--max-workers-per-floor` or `--max-workers`, `terminal.watch` above `--max-watches` or `--max-observers`; the message says which |
| `not_clean` | `worker.fire` asked to delete a worktree whose tree is dirty or has unpushed commits; for `delete_branch` also when the checkout is no longer on the branch the bridge made or that branch has commits on no remote |
| `fetch_failed` | `worker.hire` with `worktree: true` whose `git fetch origin` failed (no `origin`, offline, timed out after 20 s, …); the message is git's error. Nothing was made. (After the accept, like `bad_request` for a missing default branch.) |
| `hire_failed`, `fire_failed` | herdr or git failed during a hire / send-home; the message says which step and why. `fire_failed` also when the agent did not exit (still running, or its processes could not be read): then nothing was closed or removed. `hire_failed` names what its rollback kept. |
| `wake_failed` | the server did not start, did not answer `ping` or was not seen running within `--wake-timeout`; the message says why |
| `sleep_failed` | `herdr session stop` failed (the message has herdr's error), or the floor was not seen asleep within 15 s |
| `input_failed` | `worker.keys` / `worker.answer`: herdr refused the keys or text, the screen could not be read, or 32 commands already wait for that worker; the message says why |
| `prompt_failed` | `worker.prompt` was not submitted: herdr failed, or the agent did not start working even after Enter was pressed again |
| `stale` | `worker.answer` for a question the worker's screen no longer asks (another `hash`), or a worker no longer blocked |
| `changes_failed` | `worker.changes` whose git calls failed, or took longer than 10 s together; the message is git's error |
| `not_a_repo` | `worker.changes` for a worker whose directory is not in a git work tree |
| `hello_required`, `unsupported_proto` | handshake failures; the connection is then closed with status 1008 |
| `internal` | the bridge failed (database error, or waking, sleeping, hiring and firing is not configured); safe to retry |

Errors not tied to a command have no `req_id`.

## Flow control and closing

Each client has a bounded send queue (1024 messages). The bridge never waits for a slow client: if the queue fills up,
the client is disconnected with close status 1008, reason `slow consumer`. Reconnect with `since_seq`. Laptop frames
never fill it past half (they resync instead, see [Laptop screens](#laptop-screens)). On shutdown the bridge closes
connections with status 1001 (`going away`) and removes its socket.

## Versioning

`proto` is negotiated in `hello`; this document is version 1. Within a version the bridge only adds: new optional
fields and new event types. Clients must ignore fields and event types they do not know. Removing or changing the
meaning of a field needs a new version.

## Tools

```sh
herdr-world dump                  # snapshot, then events as JSON lines until Ctrl-C
herdr-world dump --once | jq .    # snapshot only
herdr-world dump --once --since 1047 --epoch 0fc8ba663c9c83d9   # replay instead of a snapshot
herdr-world cmd building.create '{"name":"Work"}'
herdr-world cmd floor.assign '{"session":"code-review","building":"b_3f09a1c2d4e5","index":0}'
herdr-world cmd floor.settings.set '{"session":"herdr-3d","repo":"JeffreyVdb/herdr-3d","default_cwd":null}'
herdr-world cmd floor.sleep '{"session":"h3d-scratch"}'
herdr-world cmd floor.wake '{"session":"h3d-scratch"}'
herdr-world cmd hire.prepare '{"session":"h3d-scratch"}'
herdr-world cmd worker.hire '{"session":"h3d-scratch","desk_index":0,"harness":"codex","model":"gpt-6-luna","effort":"low"}'
herdr-world cmd worker.fire.prepare '{"id":"a58752ea-…"}'
herdr-world cmd worker.fire '{"id":"a58752ea-…","worktree":"keep"}'
herdr-world cmd worker.keys '{"id":"a58752ea-…","input":[{"text":"git status"},{"key":"enter"}]}'
herdr-world cmd worker.prompt '{"id":"a58752ea-…","text":"Run the tests."}'
herdr-world cmd worker.answer '{"id":"a58752ea-…","hash":"cdecbf4fcde864bc","choice":1}'
```

`dump` prints the `welcome` line on stderr. `cmd` prints the `ack` or `error` and exits 1 on error; it waits up to
`--timeout` (1 min) for a reply. All three take `--socket`.
