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
- The bridge only ever *reads* herdr (`ping`, `session.snapshot`, `events.subscribe`, `herdr session list`). The only
  state that commands change is the bridge's own SQLite database.

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
    {"session":"herdr-3d","state":"running","building":null,"index":null,"desks":6}
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
  ]
}}
```

`seq` is the seq of the last event the snapshot includes: apply live events with a higher `seq` on top of it.

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

`harness`, `model` and `effort` are remembered once seen: herdr drops tokens when it restarts and asleep floors have
none, so the bridge keeps the last known value until a new one shows up. They are absent when never known.

**Identity.** When a workspace appears (bridge start, herdr restart, reconnect), the bridge matches it to a stored worker
by, in order: a pane-label marker `h3d-<short uuid>`; the native `agent_session` id; label + identity directory (only for
workers it has not seen closing). Otherwise it is a new worker. The bridge never writes markers or tokens to herdr.

### Desks and names

Each worker holds a **desk** on its floor: `desk_index` is stored in SQLite (`desk_assignment`) under the worker's id,
so it survives bridge and herdr restarts whenever the identity reconciles to the same worker. A worker new to its floor
takes the **lowest free** index, in sidebar order. A desk is freed when its worker leaves the floor
(`worker.removed`: workspace closed, identity lost, session deleted), and the next newcomer reuses it. Workers of an
asleep floor keep their desks.

Each worker also gets a **name** from a built-in list of original names ("Nibble", "Pixel", "Mochi", …), stored with
the worker and never changed: it comes back with the worker after a restart or when its workspace reopens. Names are
unique among the floor's workers. A newcomer never gets the name of a worker the floor ever had, since that worker may
come back, so past the end of the list (sooner on a floor with much churn) names get a suffix (`"Pixel 2"`). The one
exception is two workers of a floor stored with the same name, which only a database from an earlier development build
or a failed database read or write can cause: while both are on the floor, one keeps it (a worker that already had a
desk before a newcomer, then sidebar order) and the other gets a new name, which it then keeps.

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
| `floor.upsert` | `floor` | a session appeared, started, stopped, was (re)assigned, or its `error` changed |
| `floor.removed` | `session` | the session was deleted in herdr (its workers get `worker.removed` first) |
| `worker.upsert` | `worker` | a worker appeared, or anything besides `status`/`title` changed (full object) |
| `worker.status` | `id`, `session`, `workspace_id`, `status`, `prev_status`, `status_since`, `title` | only `status` and/or `title` changed (the hot path). `title` is always present, `""` when cleared; on a title-only change `prev_status` equals `status` and `status_since` does not move. |
| `worker.removed` | `id`, `session`, `workspace_id` | the workspace closed, the session was deleted, or the identity changed |

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
the client's world already reflects it. Every building/floor command, accepted or not, is written to the audit log.
`args` must not contain unknown fields.

| `t` | `args` | `ack.data` | events |
|---|---|---|---|
| `building.create` | `{"name": string}` | `{"id": string}` | `building.upsert` |
| `building.rename` | `{"id": string, "name": string}` | — | `building.upsert` |
| `building.delete` | `{"id": string}` | — | `floor.upsert` for each of its floors (now unassigned), `building.upsert` for buildings whose `sort` shifted, then `building.removed` |
| `building.reorder` | `{"ids": [string…]}`: every building id exactly once, in the new order | — | `building.upsert` for each moved building |
| `floor.assign` | `{"session": string, "building": string \| null, "index"?: int}`: `null` moves the floor to the unassigned lot; `index` inserts at that position (clamped), omitted appends | — | `floor.upsert` for every floor whose position changed, `building.upsert` for the buildings involved |

```json
{"t":"floor.assign","req_id":"8","args":{"session":"code-review","building":"b_3f09a1c2d4e5","index":0}}
{"t":"floor.upsert","seq":1051,"floor":{"session":"code-review","state":"running","building":"b_3f09a1c2d4e5","index":0,"desks":16}}
{"t":"building.upsert","seq":1052,"building":{"id":"b_3f09a1c2d4e5","name":"Work","sort":0,"floors":["code-review"]}}
{"t":"ack","req_id":"8"}
```

Buildings, their order and floor assignments are stored in SQLite (`$XDG_STATE_HOME/herdr-world/world.db`) and survive
bridge restarts. Assignments are kept for sessions that are currently gone, so a re-created session returns to its
floor.

### Errors

```json
{"t":"error","req_id":"9","code":"unknown_command","message":"unknown command \"worker.hire\""}
```

| code | meaning |
|---|---|
| `bad_request` | not a JSON object with `t`; missing `req_id`; bad or unknown `args` fields; invalid name; a second `hello` |
| `unknown_command` | `t` is not a command of this protocol version. The connection stays open. |
| `not_found` | no building with that id |
| `name_taken` | another building already has that name (ignoring case) |
| `unknown_session` | `floor.assign` for a session the bridge does not know |
| `hello_required`, `unsupported_proto` | handshake failures; the connection is then closed with status 1008 |
| `internal` | the bridge failed (database error); safe to retry |

Errors not tied to a command have no `req_id`.

## Flow control and closing

Each client has a bounded send queue (1024 messages). The bridge never waits for a slow client: if the queue fills up,
the client is disconnected with close status 1008, reason `slow consumer`. Reconnect with `since_seq`. On shutdown the
bridge closes connections with status 1001 (`going away`) and removes its socket.

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
```

`dump` prints the `welcome` line on stderr. `cmd` prints the `ack` or `error` and exits 1 on error. All three take
`--socket`.
