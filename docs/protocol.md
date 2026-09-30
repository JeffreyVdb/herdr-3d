# herdr-world protocol v1

The bridge (`herdr-world`) serves one WebSocket to game clients. This document is the contract; the Go types live in
[`internal/proto`](../internal/proto/proto.go). Design background: [`architecture.md`](architecture.md) §3–4.

## Transport

- A unix socket at `$XDG_RUNTIME_DIR/herdr-world/bridge.sock` (`--socket` / `HERDR_WORLD_SOCKET` to override). The
  directory is `0700`, the socket `0600`: access is "can act as this unix user", which for the Mac means "has SSH access"
  (`ssh -N -L <local.sock>:<bridge.sock>`). Nothing listens on TCP.
- HTTP/1.1 on that socket: `GET /ws` upgrades to the WebSocket, `GET|PUT|DELETE /logo/{building}` carry building logos
  (M3d, see [Building logos](#building-logos)), `POST /upload` carries one image to Drop Zone (see [Image upload](#image-upload)), `GET /healthz` answers `ok` and carries the bridge's build version in the `X-H3D-Version` header (the body stays `ok`: a helper from an older release checks it exactly). `welcome.server` is the same build as a banner, `herdr-world <version>`.
  ```sh
  curl --unix-socket "$XDG_RUNTIME_DIR/herdr-world/bridge.sock" http://herdr-world/healthz
  ```
- Text frames, one JSON object per frame. Every object has a string field `t`, its type. Client messages are limited to
  256 KiB (M7: a comment body is up to 64 KiB of text, escaped).
- The bridge reads herdr (`ping`, `session.snapshot`, `events.subscribe`, `herdr session list`, and for the laptop
  screens the read-only `herdr terminal session observe`). Its only writes to herdr are `floor.wake` / `floor.sleep`
  (see [Wake and sleep](#wake-and-sleep)), `worker.hire` / `worker.fire` (see [Hire and send
  home](#hire-and-send-home)) and typing into a pane for `worker.keys`, `worker.prompt` and `worker.answer` (see
  [Laptops](#laptops-screens-input-changes-and-usage)), through a narrow allowlist of `herdr` / `systemd-run` command
  shapes (CONTRIBUTING "Bridge" lists them), plus (M10) two read-only probes of the `claude` and `codex` CLIs for the [plan
  limits](#plan-limits), plus a few typed `git` commands for hiring into a worktree, checking a
  tree before sending its worker home and reading a worker's changes. Every other command only changes the bridge's
  own SQLite database.

### Through `h3d-helper` (the Mac)

The game does not dial the socket itself. `h3d-helper` forwards it over SSH and serves the game on
`http://127.0.0.1:7777`; the game opens `ws://${location.host}/ws?token=<token>` on that same origin and the helper
proxies it to the bridge's `/ws` unchanged (see CONTRIBUTING "Helper"). The helper answers `403` without upgrading
unless all three hold (`/logo/{building}` has its own rule for `Origin`, below):

- `Host` is `127.0.0.1:<port>` or `localhost:<port>` (or `<ip>:<port>` when `--listen` is another literal loopback
  IP, e.g. `[::1]:<port>`);
- `Origin` is `http://127.0.0.1:<port>` or `http://localhost:<port>` (or `http://<ip>:<port>` likewise);
- `token` is the helper's token. The helper makes a random one the first time and keeps it in a 0600 file
  (`~/Library/Application Support/h3d-helper/token`, `--token-file`), so it survives restarts and updates; delete the
  file to rotate it. The helper opens the game at `http://127.0.0.1:<port>/#token=<token>` (`h3d-helper -print-url`
  prints it); the game keeps it in `localStorage` (`h3d.token`), which is what lets the installed app start from the
  Dock without that URL, and strips it from the address bar. Same trust as the file: anything that can read the user's
  files or that origin's storage can drive the bridge, which is already a shell as that user.

The helper also proxies `GET|PUT|DELETE /logo/{building}` to the bridge (M3d): it needs the right `Host`, the
`token` (`?token=`, checked in constant time) and, for the `Origin` header, this: a browser leaves `Origin` out of a
same-origin `GET` (an image or a `fetch` on the page's own origin), so an **absent** `Origin` passes on `GET`, while a
**present** one must be one of the helper's own, as for `/ws`. `PUT` and `DELETE` are non-`GET` requests, which a browser
always sends with `Origin`; it is checked when present, and a client that sends none (curl) still needs the token.
`POST` and the other methods get `405`. The token, `Origin`, `Cookie` and `Authorization` are not forwarded (only the
building id and `?h=`). The helper refuses an upload over 1 MiB with `413` `logo_too_large` before it reaches the tunnel,
and cuts a streamed one off at the limit; it does not link the image code (the bridge converts).

The helper proxies `POST /upload` (see [Image upload](#image-upload)) under the same rules as `/logo` (`Host`, the
`token` query parameter, `Origin` when present; `403` `forbidden` as the error object, and `405` for any other method
with `Allow: POST`). Only `label` and `n` go on to the bridge. It lets a body of at most 25 MiB + 4 KiB through (by
`Content-Length` at once, and by counting while it streams, so a chunked or unlabelled body too) and answers `413`
`upload_too_large` past that; the bridge decides the exact 25 MiB.

A `502` means the tunnel is down; the helper's own `GET /healthz` reports the tunnel state
(`{"tunnel":{"state":"up|connecting|degraded|backoff",…}}`, `503` unless `up`).

The helper also answers one request of its own, for the game's "Open in <provider>" buttons and the links in issue
bodies (M7): `POST /api/open` with `{"url":"https://github.com/…"}` opens that page in the Mac's default browser
(`open <url>`). It needs the same `Host` and `Origin`, the token in an `X-H3D-Token` header (never in a URL) and
`Content-Type: application/json`, and accepts only an `https://` URL on a host of its allowlist (`github.com`; every
provider the bridge learns adds its own host), without credentials or a port. `204` opened; `400` a refused URL;
`403` a failed check; `502` the Mac's `open` failed. A game not served by the helper has no such endpoint (it has no
token either) and opens a new window itself (`https://` only); a game the helper serves opens nothing the helper
refuses and says so.

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
    "claude":{"models":["claude-opus-5-5","claude-fable-5-1","claude-sonnet-5-5"],"efforts":["low","medium","high","xhigh","max"]},
    "codex":{"models":["gpt-6-sol","gpt-6-luna","gpt-6-astra"],"efforts":["low","medium","high","xhigh","max"],
             "extra_efforts":{"gpt-6-sol":["ultra"],"gpt-6-astra":["ultra"]}}},
  "limits":[
    {"provider":"claude","plan":"team","at":1790702330276,"stale":false,"source":"probe",
     "windows":[{"label":"5h","pct":11,"resets_at":1790711999725,"window_mins":300},
                {"label":"week","pct":61.5,"resets_at":1790719199725,"window_mins":10080}]}
  ],
  "presets":[
    {"id":"p_1a2b3c4d5e6f","name":"Build team","seeded":true,
     "roles":{"orch":{"harness":"claude","model":"claude-opus-5-5","effort":"medium"},
              "coder":{"harness":"claude","model":"claude-opus-5-5","effort":"medium"},
              "reviewer":{"harness":"codex","model":"gpt-6-sol","effort":"high"},
              "ux":{"harness":"codex","model":"gpt-6-sol","effort":"high"},
              "researcher":{"harness":"codex","model":"gpt-6-sol","effort":"low"}}}
  ]
}}
```

`seq` is the seq of the last event the snapshot includes: apply live events with a higher `seq` on top of it.

`hire_options` lists what can be hired: models and efforts per harness, `extra_efforts` being efforts only some models
take. `floor.settings.set` validates `default_hire` against it; clients should read it rather than hardcode the lists.
The bridge queries the installed Codex and Claude Code harnesses at startup; model order comes from each harness.
`efforts` contains their common effort levels and `extra_efforts` preserves each model's additional levels. Either
list may be empty. If discovery fails for one harness, only that harness uses the legacy fallback catalog.

`limits` (M10) is the latest reading of each provider's plan limits, Claude first (see [Plan limits](#plan-limits));
`[]` before the first reading. A bridge that does not read limits (`--no-limits`) leaves the key out, as a bridge from
before M10 does: a client shows no limits widget without it (and none inline in the hire and start-run dialogs), and
"Plan limits · reading…" only while the key is there and `[]`.

`presets` are the team presets, by name ignoring case (see [Team presets and starting a
run](#team-presets-and-starting-a-run)); `[]` when there are none.

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
| `logo` | string? | M3d: the hash (lower-case hex sha256) of the building's logo PNG; absent without one. The image itself is `GET /logo/{id}`, never in an event or the snapshot. It changes when the image does, and is what a client caches the texture by. |

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
| `last_preset` | string, optional | id of the team preset of the floor's last successful `run.start` (SQLite `floor_preset_last`); absent when none, or once that preset is deleted |

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
| `hired_at` | int, optional | unix ms when the bridge hired this worker (`worker.hire`; stored). A client that first sees a worker with a recent `hired_at` (the game: under ~15 s) plays its arrival (M6b: it drops in to its chair; M4: it walked in). |
| `branch` | string, optional | the checked-out branch of a worker in a linked worktree (`worktree.linked`), when known (read from the checkout's git `HEAD`; absent on a detached `HEAD`) |
| `usage` | object, optional | its agent session's token counts and cost estimate (see [Usage and cost](#usage-and-cost)); absent without an `agent_session` (a running Codex excepted), or until the bridge found its transcript |
| `question` | object, optional | what the screen of a `blocked` worker asks, while it is blocked (see [Blocked workers](#blocked-workers-question-quick-reply-approve--deny)) |
| `ask` | object, optional | #57: the structured question (Claude's AskUserQuestion, Codex's request_user_input) its agent's latest turn waits on, read from its transcript whatever `status` says (see [Laptops: asks](#laptops-asks)) |
| `round` | int ≥ 1, optional | write-code round: the `h3d_round` token, else the label's trailing `\|r<N>` (see [Runs and freelancers](#runs-and-freelancers)) |
| `ticket` | string ≤ 32 bytes, optional | the `h3d_ticket` token, else the label's ticket field (`CODE\|descr\|<ticket>\|r<N>`, likewise `REVIEW` and `UX`) |
| `issue` | object, optional | `{"repo":"owner/name","number":7}`: the GitHub issue of the worker's run, when a repo is known |
| `work_item` | object, optional | `{"provider":"github","id":"JeffreyVdb/herdr-3d#7"}`: `issue` in the neutral form, present whenever `issue` is and the floor has a board provider (see [Boards](#boards-issues-and-pull-requests)). The `id` is a board card's `id`. |
| `orch_id` | string, optional | freelancers: the worker id of their orchestrator |
| `phase`, `pass` | string, int ≥ 0, optional | orchestrators: the `h3d_phase` / `h3d_pass` tokens (`research\|coding\|review\|fixing\|waiting_user\|pr\|done`, others passed through, ≤ 32 bytes), remembered like `harness` |
| `over_cap` | bool, optional | orchestrators: `true` past write-code's review-pass cap (`pass > 3`, or `pass == 3` and `phase == "waiting_user"`); absent when false |
| `report` | object, optional | freelancers: their write-code report (see [Runs and freelancers](#runs-and-freelancers)) |

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

A write-code freelancer sits next to its orchestrator instead: see [Runs and freelancers](#runs-and-freelancers).

### Runs and freelancers

A write-code run is an orchestrator (`role: "orch"`, an employee) and its **freelancers** (`code`, `review`, `ux`,
`ground`), each in its own workspace. The skill tags every workspace with `h3d_*` tokens (`herdr workspace
report-metadata`); runs started without them are read from the labels (`ORCH|descr`, `CODE|descr|<ticket>|r<N>`,
`REVIEW|…`, `UX|…`, `GROUND|topic`), where the run is the label's `descr`.

- **Orchestrator** (`orch_id`): a freelancer's orchestrator has the same `run`, on the freelancer's floor if there is
  one there, else on another floor. With none, a freelancer whose run comes from its label (no `h3d_run` token) belongs
  to the only orchestrator of its floor, if there is exactly one.
- **Issue** (`issue`): the floor's repo is its `settings.repo`, else `suggested.repo`. A freelancer's issue is its own
  numeric `ticket` (`7`, `#7`) in its floor's repo, else its orchestrator's. An orchestrator's is the one the game
  started it with (`run.start`), else its own numeric `ticket`, else the most common numeric ticket of its
  freelancers (ties: the lowest) in its floor's repo. Without a repo there is no issue; a ticket like `m6` gives none.
  The orchestrator's issue is on the wire (`worker.upsert` with `issue` and `work_item`) **before** `run.start`'s ack.
- **Phase and pass**: an orchestrator's `phase` and `pass` are remembered (SQLite `worker_run`) when herdr drops the
  tokens, until new values show up; `over_cap` follows from them.
- **Desks**: desks come in pods of 4 (`desk_index / 4`). A freelancer new to a floor whose orchestrator is on that
  floor takes the free desk nearest the orchestrator's: the same pod first, then the other pods by their distance, then
  the lower index; the floor grows its desks when it needs to. A newcomer that took the lowest free desk because its
  link was not known yet (the tokens arrive just after `workspace create`) moves **once**, within 10 s of taking it,
  when that puts it nearer (an ordinary `worker.upsert` with the new `desk_index`). Hired workers keep the desk they were
  hired at; everyone else takes the lowest free desk as before.

**Reports.** A freelancer with an `h3d_run` and an `h3d_report` token has a `report`: the file
`<runs-dir>/<h3d_run>/<h3d_report>` (bridge flag `--runs-dir`, default `~/.local/state/write-code/runs`). The bridge
stats the report of every live freelancer about once a second and reads it only when its size or mtime changed; a
change is one `worker.upsert`. A new `h3d_report` value (the fresh path after `input_required`) starts over at
`pending`.

```json
{"state":"pending"}
{"state":"ready","at":1790650000000,"verdict":"CHANGES_REQUIRED","blockers":2,"issues":5,"summary":"…"}
{"state":"ready","at":1790650000000,"input_required":"Which port should the demo use?"}
{"state":"invalid","at":1790650000000,"error":"not a JSON object"}
```

| field | |
|---|---|
| `state` | `pending` (no file yet), `ready`, `invalid` |
| `at` | unix ms, the file's mtime (absent for a bad name) |
| `verdict` | reviewers (`review`, `ux`) only: `PASS` \| `CHANGES_REQUIRED` \| `INCOMPLETE`; any other value, or none without `input_required`, is `invalid` |
| `blockers`, `issues` | reviewers: how many `issues_found` have `priority == "BLOCKER"`, and how many there are |
| `input_required` | what the worker needs to go on, cut to 500 bytes (UTF-8 safe); absent when null or empty |
| `summary` | coders and researchers: their `summary`, cut to 300 bytes |
| `error` | why a report is `invalid`: a run id or report name not matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$`, not a regular file (a symlink is not followed), over 256 KiB, not a JSON object, a bad verdict |

The game derives a freelancer's lifecycle from these (hired, onboarding, working, blocked on `status: blocked` or a
`report.input_required`, reporting on a `ready` report, leaving on `worker.removed`); nothing else goes on the wire.

## Events

Every change is an event with a strictly increasing `seq` (+1 per event, per epoch). Clients should apply them in order
and remember the last `seq` applied.

| `t` | fields | when |
|---|---|---|
| `building.upsert` | `building` | a building was created, renamed, reordered, its floor list changed, or (M3d) its `logo` was set, replaced or cleared |
| `building.removed` | `id` | a building was deleted (its floors got `floor.upsert` with `building: null` first) |
| `floor.upsert` | `floor` | a session appeared, started, stopped, was (re)assigned, or its `error`, `transition`, `settings` or `suggested` changed |
| `floor.removed` | `session` | the session was deleted in herdr (its workers get `worker.removed` first) |
| `worker.upsert` | `worker` | a worker appeared, or anything besides `status`/`title` changed, e.g. its `resume` (full object) |
| `worker.status` | `id`, `session`, `workspace_id`, `status`, `prev_status`, `status_since`, `title` | only `status` and/or `title` changed (the hot path). `title` is always present, `""` when cleared; on a title-only change `prev_status` equals `status` and `status_since` does not move. |
| `worker.removed` | `id`, `session`, `workspace_id`, `reason`? | the workspace closed, the session was deleted, or the identity changed. `reason` is `"sent_home"` when the removal comes from `worker.fire` (the game plays the walk-out); absent otherwise. |
| `worker.usage` | `id`, `session`, `usage` | the worker's `usage` changed; at most once per 5 s per worker (see [Usage and cost](#usage-and-cost)) |
| `limits.update` | `provider`, `plan`, `windows`, `at`, `stale`, `error`?, `source`?, `reached`?, `credits`? | a provider's plan limits were read (flat in the event, see [Plan limits](#plan-limits)); one per provider per read, about every 2 minutes while a client is connected |
| `preset.upsert` | `preset` | a team preset was created, renamed or its roles changed (full object) |
| `preset.removed` | `id` | a team preset was deleted (floors whose `last_preset` it was get a `floor.upsert` next) |

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
| `worker.answer_ask` | `{"id": string, "tool_use_id": string, "answers"?: [{"question": int, "choices"?: [int…], "other"?: string}…], "cancel"?: true, "prompt"?: string}` | `{"sent": [string…], "resolved": bool, "prompted"?: bool}` | the worker's upsert without its `ask` once the transcript has the answer (before the ack) (see [Laptops: asks](#laptops-asks)) |
| `transcript.watch` | `{"id": string, "limit"?: 1–500}` | `{"harness", "session", "version", "cursor", "has_more", "pending", "items"}` | `transcript.items` to this connection only (see [Laptops: transcript](#laptops-transcript)) |
| `transcript.unwatch` | `{"id": string}` | — | — |
| `transcript.page` | `{"id": string, "before"?: cursor, "limit"?: 1–500, "agent"?: string}` | `{"items", "cursor", "has_more"}` | — |
| `transcript.item` | `{"id": string, "item": string, "agent"?: string}` | `{"item"}` | — |
| `preset.create` | `{"name": string, "roles": {…}}` | `{"id": string}` | `preset.upsert` (see [Team presets and starting a run](#team-presets-and-starting-a-run)) |
| `preset.update` | `{"id": string, "name"?: string, "roles"?: {…}}` (`roles` replaces all five) | — | `preset.upsert`; none when nothing changed |
| `preset.delete` | `{"id": string}` | — | `preset.removed`, then `floor.upsert` for the floors whose `last_preset` it was |
| `run.prepare` | `{"session", "issue"? \| "text"? \| "work_item"?, "preset"?, "orch"?, "extra"?}` | what the start-run dialog shows: `{"prompt", "label", "ticket", "preset", "orch", "cwd", "git", "capacity"}` | — |
| `run.start` | `{"session", "desk_index", "issue" \| "text" \| "work_item", "orch", "preset", "extra"?, "worktree"?, "label"?, "prompt"?}` | `worker.hire`'s ack plus `{"launch_id", "prompt"}` | `worker.hire`'s, then the orchestrator's `worker.upsert` with `issue` and `work_item`, and `floor.upsert` with `last_preset` |
| `limits.refresh` | `{}` | `{"queued": bool}`: `false` when the last refresh was less than 20 s ago | `limits.update` for both providers when queued (see [Plan limits](#plan-limits)) |
| `board.watch` | `{"session"}` | `{"enabled": bool, "reason"?}`, then `board.issues` and `board.prs` to this connection (see [Boards](#boards-issues-and-pull-requests)) | — |
| `board.unwatch` | `{"session"}` | — | — |
| `board.refresh` | `{"session"}` | `{"queued": bool}` | the boards of the poll, to the watchers |
| `issue.get` | `{"session", "id"}` | `{"card", "body", "author", "created_at", "comments", "comments_truncated"}` | — |
| `issue.comment` | `{"session", "id", "body"}` | `{"comment"}` | boards after the refresh |
| `issue.close` | `{"session", "id", "reason", "confirm": true}` | — | boards after the refresh |
| `issue.set_status` | `{"session", "id", "column"}` | — | boards after the refresh |
| `pr.get` | `{"session", "id"}` | `{"pr", "body", "author", "created_at", "files", "files_truncated", "checks", "comments", "comments_truncated"}` | — |
| `pr.comment` | `{"session", "id", "body"}` | `{"comment"}` | boards after the refresh |
| `pr.merge` | `{"session", "id", "method", "confirm": true, "override"?, "confirm_override"?}` | `{"merged": true}` | boards after the refresh |
| `worker.open_pr.prepare` | `{"id"}` (worker id) | `{"can_open", "reason"?, "branch", "base", "ahead", "dirty", "existing"?, "title", "body"}` | — |
| `worker.open_pr` | `{"id", "title", "body", "confirm": true}` | `{"pr": {"id", "key", "url"}, "pushed", "existed"}` | boards after the refresh |

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

### Building logos

M3d. A building can have a logo, shown on the lobby's entrance sign, on the reception wall and on a small sign in front
of the building in the city. The bridge stores the image itself (SQLite table `building_logo`: the normalised PNG bytes,
their hash and size; deleting the building deletes it). The building carries only the **hash** (`logo`); clients fetch the
image over HTTP and cache it by hash. Upload, clear and fetch are HTTP on the same socket as `/ws`, not WebSocket
commands: a WebSocket message is capped at 256 KiB and a logo may be 1 MiB.

| request | |
|---|---|
| `PUT /logo/{building}` | The raw file as the body (any `Content-Type`: the type is decided from the bytes). Cap: **1 MiB** (`1048576` bytes), enforced with `http.MaxBytesReader`: an upload over it is refused with `413`, never truncated. Answers `200` `{"t":"ack","data":{"id","logo","w","h","bytes"}}` (`logo` is the new hash; `w`,`h` the stored size), after the bridge stored it and sent the `building.upsert`. |
| `DELETE /logo/{building}` | Removes the logo. `200` `{"t":"ack","data":{"id"}}` also when there was none; `404` for an unknown building. The `building.upsert` (without `logo`) follows. |
| `GET /logo/{building}[?h=<hash>]` | The stored PNG (`Content-Type: image/png`, `nosniff`, `ETag: "<hash>"`, a sandboxing `Content-Security-Policy`). `404` without a logo. With `?h=` equal to the current hash it is `Cache-Control: public, max-age=31536000, immutable`; without `?h=` it is `no-cache` and the *current* image. **With `?h=` that is not the current hash** (the logo was replaced or cleared since the client read the `building.upsert`) it is `404` `not_found`, `no-store`, and no image: the URL names bytes, and the bridge never answers it with other bytes. The client asks again when the building's next `building.upsert` carries the new hash. `If-None-Match` gets `304`. |

A change goes through the hub like a command (audit log rows `building.logo.set` / `building.logo.clear`, with the hash and
sizes but no image), so every client gets the `building.upsert` with the new `logo`, also a replay after a reconnect.

**The pipeline** (`internal/logo`, pure Go, no cgo) turns the upload into one PNG with alpha, its long edge at most **1024
px**, aspect kept:

- The type comes from the bytes: the PNG signature, `RIFF….WEBP`, or an XML document whose root is `<svg>` (SVG has no
  signature); never from a file name or the client's `Content-Type`.
- **PNG** (`image/png`) and **WebP** (`golang.org/x/image/webp`, lossless and lossy, with alpha): the header is read
  first (`DecodeConfig`) and an image over **8192 px a side or 16 megapixels** is refused before it is decoded. A raster is
  downscaled with Catmull-Rom (alpha kept), never enlarged. An **animated** WebP is refused.
- **SVG** is rasterised straight at its stored size on a transparent background, its long edge 1024 px (a vector is drawn
  large, so a 24 × 24 icon is sharp on a 3 m sign). Only a flat subset of SVG (oksvg) is drawn, and the whole document is
  checked first: XML directives (DOCTYPE, entities) and processing instructions other than `<?xml?>`, `<use>`, `<image>`,
  `<text>`, `<script>`, `<foreignObject>`, `<style>`, filters, masks, nested `<svg>` roots, event handlers,
  `href`s other than `#fragment` gradient references and `url(…)` other than `url(#fragment)`, depth over 64, more than
  4096 elements, more than 32 attributes on one, path data over 128 KiB or 8192 path commands, a number over 1e6, scale
  chains over 1000×, and gradients of more than 64 stops. Convert text to outlines before exporting. **Dashed strokes are
  not supported**: `stroke-dasharray` and `stroke-dashoffset` (attribute or `style`) are dropped and the stroke is drawn
  solid (rasterx's dashing cost depends on numbers, the group and viewBox scales among them, that the check cannot
  bound). What the source cannot show about the cost of drawing is not bounded by any check: the drawing runs in a
  **render worker**, a child process that is killed at a hard deadline (see below). In the worker, best-effort early
  refusals remain (with a clear message, not as a bound): a document whose shapes are far more detailed than their size
  on the canvas (path values × how far they reach in output pixels, stroke width and miter limit included) is refused as
  too complex, and one not drawn within 1 s of starting a shape (thousands of shapes over the whole canvas) is refused.
  The renderer never sees the upload itself, only a **canonical copy** that the check writes: elements and attributes of
  any namespace other than SVG (Inkscape, Sodipodi, RDF metadata, anything else; oksvg matches local names and would
  otherwise read `<x:rect>` or `x:width` as SVG) are dropped with their content, as are text, comments, `class`, and every
  attribute oksvg does not read (matched by exact name, so `STROKE-DASHOFFSET` and `Style` are dropped too, as is every dash property), and
  prefixed SVG-namespace elements are written with plain names. A `style="…"` attribute is kept, but only its
  presentation declarations (`fill`, `stroke`, `stroke-*`, `opacity`, `fill-opacity`, `stroke-opacity`, `transform`), each
  checked exactly like the attribute of the same name (numbers, transforms, `url(#…)`); other declarations are
  dropped. The same attribute given twice (also under two prefixes) is refused as `logo_invalid`.
- The stored bytes are a freshly encoded PNG, so no metadata or trailing data survives; the **hash** is the sha256 of those
  bytes (the same picture uploaded twice has the same hash, a different picture never does).
- At most 2 conversions run at once; a request waits at most 10 s for a slot, else `503` `logo_busy`.
- **What keeps an upload from hurting the bridge** is two things. *What an SVG may contain* is decided by the allowlist
  check and the canonical copy (above), in the bridge. *What drawing it may cost* is decided by a killable child
  process: oksvg and rasterx take no context and no check of the source bounds their cost (a 65 KB document of nested
  transforms took over 20 s), so the bridge never runs them itself. It runs its own executable again as a hidden
  `logo-worker` (entered before anything else in the process: no database, socket or listener; the systemd unit needs
  no change), writes the canonical copy to its stdin and reads the PNG from its stdout. The worker gets a minimal
  environment (none of the bridge's variables), a CPU limit of the deadline plus 1 s and no core dumps, and is killed
  (`SIGKILL`, its whole process group) and reaped at the **deadline of 5 s**, or as soon as the caller goes away or it
  writes more than 8 MiB. A conversion holds its slot for the life of the child, so a hostile document ties a slot up
  for at most 5 s (two of them, both slots; an ordinary logo then waits at most that long). Its output is accepted only
  if it is a PNG of at most 1024 px with nothing after it. A worker that is killed for time is `415` `logo_unsupported`
  ("the SVG takes too long to draw": retrying does not help, the document has to be simpler); one that crashes, exits
  non-zero, writes garbage or too much is `422` `logo_invalid` ("cannot process this image", nothing of its own words
  is passed on); one that cannot be started at all is `500` `internal` and is logged. PNG and WebP are decoded in the
  bridge itself: their cost is bounded by the size and pixel caps read from the header before the decode.

Errors are the protocol's error object (`{"t":"error","code","message"}`) with an HTTP status:

| status | `code` | when |
|---|---|---|
| `404` | `not_found` | no such building (`PUT`, `DELETE`), no logo (`GET`), or `GET` with a `?h=` that is not the current hash |
| `413` | `logo_too_large` | the upload is over 1 MiB, or the image over 8192 px a side / 16 megapixels |
| `415` | `logo_unsupported` | not PNG, WebP or SVG; an animated WebP; an SVG feature that is not drawn (the message names it); an SVG that took over 5 s to draw (the render worker was killed) |
| `422` | `logo_invalid` | empty, corrupt or truncated; an SVG that is not well-formed or draws nothing, or whose render worker failed |
| `503` | `logo_busy` | no conversion slot in time (within 10 s); retry |
| `500` | `internal` | the bridge failed |
| `403` `502` | | the helper's own (token, host or origin refused; the tunnel is down) |

The game shows a logo when it has one and the image can be fetched; without one, or when the fetch fails, the sign shows
the building's name as before. It fetches each hash once and keeps one texture per hash, and files an image under a hash
only if the bytes have that sha256 (checked with `crypto.subtle`, else against the `ETag`): a `404` for a `?h=` hash, or
bytes of another hash, is a *stale* miss that is not cached and does not block another building that advertises the same
hash (it fetches with its own URL); the building's next `building.upsert` brings the new hash. A miss speaks only for
the request that got it: when a building advertises a hash again while a request for it is still on its way (`H1`, `H2`,
`H1`), that request's stale or failed answer is dropped and the hash is asked for again, once. `GET /logo/{building}?h=<hash>`
through the helper carries `token=` like `/ws`.

### Image upload

#51, #13. An image for an agent's prompt (a screenshot pasted into the hire dialog's first task) is stored by
**Drop Zone**, a small upload service that runs beside the bridge on the server, and the agent gets its path. Like the
logos it is HTTP on the bridge's socket and not a WebSocket command: a message is capped at 256 KiB and an image may be
25 MiB, and a plain request has its own status, body cap and cancellation.

| request | |
|---|---|
| `POST /upload?label=<hint>&n=<int>` | The **raw image bytes** as the body (not multipart). `Content-Type` is only a hint: the type is decided from the bytes. `n` is a positive integer (1 to 9999): the image's sequence in the draft or desk; `label` a hint for the file stem (optional). The bridge names the file `h3d-<label>-<n>`: the label lower-cased and cut down to `[a-z0-9-]` (anything else becomes a dash, at most 24 characters), `hire` when nothing is left. Through the helper the URL has `token=` like `/ws`. |

Answers `200` `{"t":"ack","data":{"path","mime","size"}}` with `path` the absolute path **exactly as Drop Zone returned
it** (only its one framing line feed is removed; Drop Zone picks the month folder and any collision suffix such as
`-2`, so a client never predicts it), `mime` one of `image/png`, `image/jpeg`, `image/gif`, `image/webp`, and `size` the
bytes stored. A failure is the protocol's error object with an HTTP status:

| status | `code` | when |
|---|---|---|
| `400` | `bad_request` | empty body, `n` missing or not 1 to 9999, or the upload was cut off |
| `413` | `upload_too_large` | over **25 MiB** (`25 << 20` = 26214400 bytes; `upload.MaxBytes` in Go, `UPLOAD_MAX_BYTES` in the game) |
| `415` | `upload_unsupported` | not PNG, JPEG, GIF or WebP, by the sniffed bytes (`http.DetectContentType`): SVG, HTML, TIFF, HEIC and octet-stream are refused whatever the client says |
| `429` | `upload_busy` | four uploads are already running (`Retry-After: 5`) |
| `502` | `dropzone_unavailable` | Drop Zone did not answer, answered an error, or the bridge has no Drop Zone |
| `502` | `dropzone_bad_response` | Drop Zone's answer is not one absolute path: empty, relative, several lines, control characters, a `]`, not UTF-8, over 4096 bytes; or it answered before it had the whole image |
| `504` | `upload_timeout` | the whole upload took over 2 minutes |
| `403` `502` | `forbidden`, `bridge_unreachable` | the helper's own (token, host or origin refused; the tunnel is down) |
| `500` | `internal` | the bridge failed |

A client maps a network failure (no answer at all) to `offline`, as for the logos.

- **The cap is on bytes, not on headers.** The bridge counts what arrives (`http.MaxBytesReader`, then again while it
  streams), whatever `Content-Length` says or whether there is one; one byte over is `413`, never a shortened image.
  Exactly 25 MiB is accepted.
- **Nothing is stored for an image that is refused.** The bridge forwards to Drop Zone (`POST <dropzone>/upload`,
  multipart, the `name` field **before** the one `file` part: Drop Zone ignores a late name, and a second file part would
  make it an archive; one request per image) while it reads, and never holds the image in memory. The `file` part
  carries the sniffed type and a safe file name. An image over the cap, a client that goes away, a deadline, or a
  failure of any kind ends the request **without the multipart footer**, so Drop Zone sees an incomplete body and stores
  nothing. The first 512 bytes are read first to decide the type, so an unsupported file never reaches Drop Zone.
- **Sniffing is not decoding.** A file that starts like a PNG is accepted whether or not it decodes; the bridge does not
  look at pixels.
- **The path is Drop Zone's answer, verbatim.** It is not rebuilt, quoted, trimmed or made relative; a path that could
  break the marker `[Image #n: <path>]` (a `]`, a line break, a control character) is refused, not repaired.
- **The Drop Zone URL** is the bridge's own (`--dropzone-url`, `HERDR_WORLD_DROPZONE_URL`, default
  `http://127.0.0.1:8080`); a request never names an upstream. Redirects are not followed. The bridge never writes
  Drop Zone's directory itself.
- **Audit and log** record the label, `n`, size, type and outcome (audit rows `image.upload`, client `http`), never the
  image and not the path.
- A lost answer (the connection drops after Drop Zone stored the file) leaves a file nobody references, and a retry
  stores another (`-2`). That is accepted: the bridge does not delete what it cannot prove is its own.

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
| `status_field` | `{"name": string, "options": [string…]}` | name 1–64 bytes; 1–20 options, each 1–64 bytes, unique (not blank). A client may pre-fill `{"name":"Status","options":["Todo","Doing","QA","Done"]}`. The issue board (M7) uses only the `name`, as the project field its columns come from (default `Status`); the columns are that field's live options, not these. |
| `default_cwd` | absolute path | an existing directory on the bridge host; stored cleaned (no trailing `/`) |
| `default_hire` | `{"harness", "model", "effort"}` | one of `hire_options`: a model of that harness, an effort of it or an `extra_efforts` entry of that model |

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
| `prompt` | optional first task, 1–32768 bytes of UTF-8 without NUL, not starting with `--` (herdr's CLI would read it as a flag). Sent once the agent is ready. The game sends pasted images as `[Image #n: <absolute path>]` markers in the text, after uploading them (`POST /upload`, above). |
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

### Team presets and starting a run

A **team preset** is the harness, model and effort of each role of a write-code run: the orchestrator the bridge
hires, and the coders, reviewers, UX reviewers and researchers the orchestrator hires itself.

```json
{"id":"p_1a2b3c4d5e6f","name":"Build team","seeded":true,
 "roles":{"orch":{"harness":"claude","model":"claude-opus-5-5","effort":"medium"},
          "coder":{"harness":"claude","model":"claude-opus-5-5","effort":"medium"},
          "reviewer":{"harness":"codex","model":"gpt-6-sol","effort":"high"},
          "ux":{"harness":"codex","model":"gpt-6-sol","effort":"high"},
          "researcher":{"harness":"codex","model":"gpt-6-sol","effort":"low"}}}
```

| field | |
|---|---|
| `id` | bridge-generated, `p_<12 hex>` |
| `name` | 1–40 bytes (trimmed), no control characters, unique ignoring case (else `name_taken`) |
| `seeded` | `true` for the "Build team" the bridge made itself |
| `roles` | `orch`, `coder`, `reviewer`, `ux`, `researcher`, all five required, each a `{"harness", "model", "effort"}` of `hire_options` (as `default_hire`, else `bad_request` naming the role) |

Presets are stored in SQLite (table `team_preset`) and survive restarts. The migration that makes the table seeds
**Build team** exactly as above (`docs/decisions.md`: coders claude opus medium, reviewers and UX reviewers codex sol
high, researchers codex sol low; the orchestrator claude opus medium), once: deleting it does not bring it back.
`preset.create`, `preset.update` (a `name`, and/or `roles` replacing all five; `not_found` for an unknown id) and
`preset.delete` answer as in [Commands](#commands).

**`run.prepare`** fills the start-run dialog and its prompt preview. It changes nothing (it runs `git fetch origin` as
`hire.prepare` does):

```json
{"t":"run.prepare","req_id":"40","args":{"session":"lab","issue":3}}
{"t":"ack","req_id":"40","data":{"prompt":"/write-code https://github.com/JeffreyVdb/lab/issues/3\n\nTeam:\n- coders: claude claude-opus-5-5, effort medium\n- reviewers: codex gpt-6-sol, reasoning high\n- ux reviewers: codex gpt-6-sol, reasoning high\n- researchers: codex gpt-6-sol, reasoning low\n\nMove the ticket status accordingly, pull request always means QA, merging the PR always means Done.",
  "label":"ORCH|issue-3",
  "ticket":{"kind":"issue","repo":"JeffreyVdb/lab","number":3,"url":"https://github.com/JeffreyVdb/lab/issues/3"},
  "preset":"p_1a2b3c4d5e6f","orch":{"harness":"claude","model":"claude-opus-5-5","effort":"medium"},
  "cwd":"/home/dev/devel/lab","git":{…as hire.prepare…},"capacity":{…as hire.prepare…}}}
```

| arg | rule, else `bad_request` |
|---|---|
| `session` | a running, watched floor (as `hire.prepare`) |
| `issue` | an int ≥ 1, or a string `"3"`, `"#3"` or `https://github.com/<owner>/<repo>/issues/<n>`. A number is an issue of the floor's effective repo (`settings.repo ?? suggested.repo`; none: `bad_request` "the floor has no linked repo"); a URL names its own. |
| `text` | free text instead of an issue: 1–4096 bytes once trimmed, may span lines. At most one of `issue` / `text` / `work_item` (a board card's `{provider, id}`, see [Boards](#boards-issues-and-pull-requests): it gives the same ticket as its issue URL); with neither, `prompt` and `label` are `""` and `ticket` is `null` (the dialog is not ready yet). |
| `preset` | a preset id (`not_found`); default: the floor's `last_preset`, else the preset named "Build team" (ignoring case), else the first by name; `""` when there is no preset (then no `prompt` either) |
| `orch` | `{"harness", "model", "effort"}` of `hire_options`; default: the preset's `orch` |
| `extra` | extra instructions for the prompt, at most 8192 bytes |

| field | |
|---|---|
| `prompt` | the orchestrator's first prompt, composed as below |
| `label` | the orchestrator's workspace label, write-code's `ORCH\|<descr>`: `ORCH\|issue-<n>`, or `ORCH\|` and the first words of the text as lower-case words joined by `-`; the descr is at most 10 bytes (a long issue number is cut: `ORCH\|issue-1234` for 123456) |
| `ticket` | `{"kind":"issue","repo","number","url"}` or `{"kind":"text","text"}` (trimmed) |
| `preset`, `orch` | the defaults above, as used for `prompt` |
| `cwd`, `git`, `capacity` | as in `hire.prepare` without a `cwd` (the floor's effective default cwd): where the orchestrator will work |

The **prompt**:

```
/write-code https://github.com/JeffreyVdb/lab/issues/3

Team:
- coders: claude claude-opus-5-5, effort medium
- reviewers: codex gpt-6-sol, reasoning high
- ux reviewers: codex gpt-6-sol, reasoning high
- researchers: codex gpt-6-sol, reasoning low

Move the ticket status accordingly, pull request always means QA, merging the PR always means Done.

<extra, trimmed>
```

The first line is `/write-code <ticket>` for a Claude orchestrator and `$write-code <ticket>` for a Codex one;
`<ticket>` is the issue URL, or the text. A role line says `effort <e>` for a claude role and `reasoning <e>` for a codex
one. The status line is there for an issue ticket only (the orchestrator then moves the issue's status:
a pull request means QA, its merge means Done); a free-text ticket has none. With no `extra`, the blank line before it is
left out too. (A pure function, `server.RunPrompt`.)

**`run.start`** hires the orchestrator and gives it the prompt:

```json
{"t":"run.start","req_id":"41","args":{"session":"lab","desk_index":2,"issue":3,"preset":"p_1a2b3c4d5e6f",
  "orch":{"harness":"claude","model":"claude-opus-5-5","effort":"medium"}}}
{"t":"worker.upsert","seq":1400,"worker":{"id":"6f1c…","session":"lab","label":"ORCH|issue-3","desk_index":2,"hired_at":1790650000000,…}}
{"t":"floor.upsert","seq":1403,"floor":{"session":"lab",…,"last_preset":"p_1a2b3c4d5e6f"}}
{"t":"ack","req_id":"41","data":{"id":"6f1c…","workspace_id":"w4","branch":"h3d/bloop-6f1c2d","base_sha":"8739dd…",
  "trust":"approved","prompted":true,"launch_id":"l_3b9e0c2a51f47d86","prompt":"/write-code https://github.com/JeffreyVdb/lab/issues/3\n\nTeam:\n…"}}
```

| arg | rule, else `bad_request` |
|---|---|
| `session`, `desk_index` | as `worker.hire` (`unknown_session`, `invalid_state`, `busy`, `desk_taken`, `capacity` likewise) |
| `issue` / `text` / `work_item` | exactly one, as in `run.prepare` |
| `orch` | required, `{"harness", "model", "effort"}` of `hire_options` |
| `preset` | required, an existing preset id (else `not_found`) |
| `extra` | optional, at most 8192 bytes |
| `worktree` | bool, default **true**: the orchestrator works in a new linked worktree of the cwd's repository |
| `label` | optional, as `worker.hire`'s `label`; default `run.prepare`'s |
| `prompt` | optional, the edited preview, as `worker.hire`'s `prompt`; absent: the bridge composes it from the ticket, the preset, `orch.harness` and `extra` |

It is the [`worker.hire`](#hire-and-send-home) hire, the same code path, events, rollback and audit: at `desk_index`,
with `orch`'s harness, model and effort, the `label`, `worktree`, in the floor's effective default cwd, and the prompt
as its first prompt (`herdr agent prompt` pastes it whole: a multi-line prompt arrives as one prompt). When the hire
succeeds the bridge records the launch (SQLite `run_launch`: launch id, session, the ticket's repo and issue number or
text, the orchestrator's worker id, the preset's id and name) and remembers the preset as the floor's `last_preset`
(`floor.upsert`), then acks: `worker.hire`'s ack plus `launch_id` (`l_<16 hex>`) and `prompt` (what was sent; see
`prompted` / `prompt_error` for whether it was). A failed hire records nothing. The launch's `run_id` is filled with the
first `h3d_run` token the orchestrator shows (write-code tags its workspace with it when it starts). `run.start` writes nothing to
the issue provider: the skill itself moves the ticket.

**Audit log.** `preset.*` and `run.prepare` get one row each; `run.start` gets a row when it starts, completed like a
`worker.hire`'s with its result, which also has the `launch` id.

### Boards: issues and pull requests

Every floor with an effective repo (`settings.repo ?? suggested.repo`) has two boards: its **issues**, as a Kanban of
status columns, and its **pull requests**. They come from a provider behind two neutral interfaces (the bridge's
`internal/tracker` for issues, `internal/codehost` for pull requests): **GitHub** (Issues, with Projects v2 for the
columns) is the one implemented. Nothing on the wire is GitHub's: items are addressed by an opaque `id`, scoped by the
`provider` (clients never parse an id, they show its `key`, `"#9"`); status columns have opaque ids; no GraphQL node ids,
project, field or option ids, head commits or `repo` / `number` pairs appear in the board messages and commands. What a
provider cannot do is a **capability** flag, on the board and on a card, and the bridge refuses the action (`unsupported`)
whatever a client sends. Another provider (files in the repository, Monday.com) adds its own settings key and needs no wire
change. The floor settings are unchanged: the GitHub provider reads `repo`, `project` (its Status field's options are the
columns, live) and the `name` of `status_field` (default `Status`).

Against a bridge from before M7 the commands answer `unknown_command`.

**Messages.** `board.issues` and `board.prs` are connection-scoped like `terminal.frame`: **no `seq`**, not in the replay
ring, not in `world.snapshot`, never counted as events. A connection that sent `board.watch` for a floor gets them: right
after the ack from the cache (`initial: true`; nothing cached yet: `columns: []`, `cards: []`, `fetched_at: 0`, and a poll
starts), then after every poll or failed poll (`initial: false`). Always both, the issues first, from the same poll. A
connection watches one floor at a time; a new `board.watch` replaces the old one, and a reconnect sends it again.

```json
{"t":"board.issues","session":"herdr-3d","provider":"github","provider_name":"GitHub","initial":false,
 "fetched_at":1790670000000,"stale":false,"truncated":false,"rate":{"remaining":4870,"reset_at":1790673600000},
 "capabilities":{"comment":true,"close":true,"set_status":true},
 "columns":[{"id":"49294ed0","name":"Todo","done":false},{"id":"ae6334b4","name":"Doing","done":false},
            {"id":"64e1b0ac","name":"QA","done":false},{"id":"ccf5765b","name":"Done","done":true}],
 "cards":[{"id":"JeffreyVdb/herdr-3d#9","key":"#9","title":"M7: Issues Kanban + Pull Requests board (GitHub)",
           "state":"open","column":"ae6334b4","url":"https://github.com/JeffreyVdb/herdr-3d/issues/9",
           "labels":[{"name":"bridge","color":"#1d76db"}],"priority":"high",
           "assignees":[{"name":"JeffreyVdb","avatar_url":"https://…"}],"author":"JeffreyVdb",
           "updated_at":1790670000000,"closed_at":null}]}
{"t":"board.prs","session":"herdr-3d","provider":"github","provider_name":"GitHub","initial":false,
 "fetched_at":1790670000000,"stale":false,"truncated":false,"rate":{"remaining":4870,"reset_at":1790673600000},
 "capabilities":{"comment":true,"merge":true,"open_from_branch":true},
 "prs":[{"id":"JeffreyVdb/herdr-3d#31","key":"#31","title":"…","state":"open","draft":false,
         "url":"https://github.com/JeffreyVdb/herdr-3d/pull/31","head_branch":"feat/7-m6","base_branch":"main",
         "author":"JeffreyVdb","checks":"success","review":"approved","mergeable":"mergeable",
         "closes":["JeffreyVdb/herdr-3d#7"],"additions":1200,"deletions":80,"changed_files":40,"updated_at":1790670000000}],
 "merged":[{"id":"JeffreyVdb/herdr-3d#30","key":"#30","title":"…","merged_at":1790669990000,"closes":["JeffreyVdb/herdr-3d#6"]}]}
```

| field | |
|---|---|
| `session` | the floor |
| `provider`, `provider_name` | the adapter's id and display name (the game says "Open in GitHub") |
| `initial` | `true`: the replay of the cache on `board.watch`; **never ring the gong for it** |
| `fetched_at` | unix ms of the data's poll; `0`: nothing fetched yet |
| `stale`, `error` | the last poll failed: this is the previous good data again (never emptied), with a short `error` (never a token). A failed poll is never a merge. |
| `truncated` | the provider hit its paging limit (500 open issues or pull requests, or a nested list past 100): the board is incomplete |
| `rate` | optional, `{remaining, reset_at}` (unix ms) of the provider's rate limit, to show "rate limit: next refresh 14:05" |
| `capabilities` | the board's; a card may carry its own `capabilities` that replace them (a closed issue: `close: false`) |
| `columns` | in order. GitHub project: the Status field's options as they are now, `done: true` for the option named "Done" (ignoring case). No project: `open`, and `closed` (done). Issues with no status in the project go to a leading `{"id":"","name":"No status"}` column that is there only when it has cards. |
| card `state` | `open` \| `closed`; the cards are the open issues and the ones closed in the last 7 days (exact cut-off) of this repo |
| card `column` | a column `id` |
| card `labels` | `{name, color: "#rrggbb"}`, in the provider's order, priority labels included |
| card `priority` | optional `urgent` \| `high` \| `medium` \| `low` from the labels (ignoring case): `p0`, `critical`, `urgent` → urgent; `p1`, `high`; `p2`, `medium`; `p3`, `p4`, `low`; also as `priority: x`, `priority/x`, `priority-x`; the most urgent one wins |
| card `closed_at`, `updated_at` | unix ms, `closed_at` null while open |
| PR `checks` | `success` \| `failure` \| `pending` \| `none` (no checks at all is `none`, never green) |
| PR `review` | `approved` \| `changes_requested` \| `review_required` \| `none` |
| PR `mergeable` | `mergeable` \| `conflicting` \| `unknown` |
| PR `closes` | ids of the issues it closes, in the issue id format (other repositories' issues too) |
| `merged` | the pull requests that were **open at the previous good poll and are merged now**, announced exactly once ever (SQLite, so across restarts too), never on `initial: true`; `[]` otherwise. The game rings the gong for each. |

**Polling.** A floor is polled every **60 s while at least one connection watches it**, every **10 min** otherwise (asleep
floors too). Floors linking the same repository and project share one fetch. `board.refresh` polls now, joins a poll in
flight, and starts at most one poll per 10 s per floor (else `queued: false` and the cache is sent to the caller again,
`initial: true`). After a successful write (`issue.comment`, `issue.close`, `issue.set_status`, `pr.comment`, `pr.merge`,
`worker.open_pr`) the bridge queues a refresh of that floor; the boards follow the ack. The cache is in SQLite
(`board_cache`, the open pull requests of the last good poll in `board_open_pr`, announced merges in
`board_merge_announced`): `board.watch` answers at once from it, also right after a restart.

**Rate limit.** Every poll reads the provider's rate (GitHub: `rateLimit { cost remaining resetAt }`, about 12 points a
poll). Below what one more round of every board-enabled repository plus a reserve of 100 needs, only floors somebody
watches are polled; below 50 left, or after a rate-limit error, nothing is until `reset_at`; a secondary limit that names no
reset waits 60 s, then twice as long each time, up to 10 min. The messages carry `rate` and, after a failed poll, `stale`.

**Commands.** All of them are audited like the others; comment and pull request **bodies are never logged** (the row
keeps the target `id` and the byte counts). `session` is the floor. Bodies are 1–65 536 bytes of UTF-8 (a pull request's
body may be empty), titles 1–256 bytes, no control characters but `\n` and `\t` in a body; ids at most 200 bytes. A write
on a floor with no board (no repo, no provider) is `unsupported`.

| `t` | args | `ack.data` |
|---|---|---|
| `board.watch` | `{session}` | `{"enabled": bool, "reason"?}`: `enabled: false` with a `reason` (`"no repo linked"`, `"boards are not configured"`) and no messages; else the two messages follow |
| `board.unwatch` | `{session}` | — |
| `board.refresh` | `{session}` | `{"queued": bool}`; `unsupported` on a floor with no board |
| `issue.get` | `{session, id}` | `{"card", "body": markdown, "author": {name, avatar_url}, "created_at", "comments": [{id, author, body, created_at}], "comments_truncated"}`: the first 100 comments; the body is raw markdown, **the client sanitises** |
| `issue.comment` | `{session, id, body}` | `{"comment": {id, author, body, created_at}}` |
| `issue.close` | `{session, id, reason: "completed" \| "not_planned" \| "duplicate", confirm: true}` | — |
| `issue.set_status` | `{session, id, column}` (an issue not in the project is added to it first) | — |
| `pr.get` | `{session, id}` | `{"pr", "body", "author", "created_at", "files": [{path, additions, deletions, change}], "files_truncated", "checks": [{name, state: success \| failure \| pending \| neutral \| skipped, url}], "comments", "comments_truncated"}` |
| `pr.comment` | `{session, id, body}` | `{"comment"}` |
| `pr.merge` | `{session, id, method: "merge" \| "squash" \| "rebase", confirm: true, override?, confirm_override?}` | `{"merged": true}` |
| `worker.open_pr.prepare` | `{id}` (worker id) | `{"can_open", "reason"?, "branch", "base", "ahead", "dirty", "existing"?: {id, key, url}, "title", "body"}`: the title is the latest commit's subject, the body the list of the commits' subjects |
| `worker.open_pr` | `{id, title, body, confirm: true}` | `{"pr": {id, key, url}, "pushed": bool, "existed": bool}` |

- **`confirm: true` is required** on `issue.close`, `pr.merge` and `worker.open_pr` (missing or false:
  `confirmation_required`, nothing happens). The game asks the user first; the flag makes a stray client call safe.
- **`pr.merge`** reads the pull request fresh right before merging and refuses with `checks_not_green` when its `checks`
  are not `success` and with `not_mergeable` when it is not `mergeable`, **unless** `override: true` **and**
  `confirm_override: true` (the game asks a second time; the audit row records the override and what the normal rule
  said). A `conflicting` pull request, or one that is no longer open, is never merged. The merge names the head it read: a
  head that moved meanwhile is `stale`.
- **`worker.open_pr`**: only a live **plain** worker (no `role`) whose checkout is on the `h3d/…` branch the bridge recorded
  making for it (SQLite `hire_branch`, which now also has the base branch it was made from), on a floor with a board, in a
  repository whose `origin` is the floor's repo. A dirty tree, no commits on top of `origin/<base>`, another branch or
  another origin: `invalid_state` (`worker.open_pr.prepare` answers `can_open: false` with the `reason` instead). It
  pushes the branch (`git push -u origin refs/heads/<branch>:refs/heads/<branch>`, the one git write), then opens the pull
  request against the hire's base branch, or returns the open one for that head (`existed: true`); a failed second step
  says the branch was pushed, and asking again is safe.
- **Run tickets**: `run.prepare` and `run.start` accept `work_item: {provider, id}` (a card's) as a third, exclusive
  alternative to `issue` and `text`. The bridge resolves it through the floor's issue provider (GitHub: to the M6 issue
  path, the URL in the prompt) and stores the launch as M6 does. A provider other than the floor's, an id that is not an
  item of the floor's board (not on the last board, once one was read): `not_found`.
- **Errors** (also in [Errors](#errors)): `confirmation_required`, `unsupported`, `provider_failed`, `rate_limited`,
  `checks_not_green`, `not_mergeable`, and `not_found` (an id that is not on this floor's provider), `stale`,
  `bad_request`, `unknown_session`, `unknown_worker`, `invalid_state`, `busy`.

**Audit log.** Each board command gets a row; the slow ones (everything that calls the provider) are begun when they start
and completed with a result: `issue.comment` / `pr.comment` the target id, the byte count and the comment id, `issue.close`
the reason, `issue.set_status` the column, `pr.merge` the method, the checks and mergeability it read, `override` and `gate`
when the override was needed, and `merged`, `worker.open_pr` the worker, the branch, the base, `pushed`, `pr` and
`existed`.

The bridge runs `gh` (flag `--gh`, env `HERDR_WORLD_GH`, default `gh` on `PATH`; its own login, no token stored) through
one typed shape, `gh api graphql --method POST --input -`, with a fixed set of embedded documents (never a query from a
client), 20 s per call, in a clean environment. Without `gh` the boards say `gh not found` and the write commands answer
`provider_failed`.

### Plan limits

M10 (#12). The bridge reads how much of the Claude and Codex plans is used, so the game can show it always and warn
before a hire or a run. It asks each CLI as a child of the bridge (the user's own sign-in; the bridge reads and stores
no credentials), on a schedule, and only while a client is connected. A probe starts no conversation, costs no tokens
and creates no session file (no new file under `~/.claude/projects`, no new Codex rollout).

`limits.update` carries the fields of one provider's reading flat, and `world.snapshot`'s `limits` holds the latest of
each (Claude, then Codex; a provider not read yet is absent):

```json
{"t":"limits.update","seq":1053,"provider":"claude","plan":"team","at":1790702330276,"stale":false,"source":"probe",
 "windows":[{"label":"5h","pct":11,"resets_at":1790711999725,"window_mins":300},
            {"label":"week","pct":61.5,"resets_at":1790719199725,"window_mins":10080},
            {"label":"week","model":"Fable","pct":3,"resets_at":1790719200000,"window_mins":10080}]}
{"t":"limits.update","seq":1054,"provider":"codex","plan":"prolite","at":1790702331876,"stale":false,"source":"probe",
 "windows":[{"label":"week","pct":19,"resets_at":1791053830000,"window_mins":10080}],
 "credits":{"has_credits":false,"unlimited":false,"balance":"0"}}
```

| field | meaning |
|---|---|
| `provider` | `claude` or `codex` |
| `plan` | the subscription plan (`team`, `prolite`…), `""` when unknown |
| `windows` | the usage windows: `label` (`5h`, `week`, or a length such as `3d`), `pct` (0–100, used), `resets_at` (unix ms, `0` unknown), `window_mins`, `reached` (a per-model window only, see below), and `model` on a per-model window (Claude's `model_scoped` weeks, or its older `seven_day_opus` / `seven_day_sonnet`; Codex's other limits from `rateLimitsByLimitId`). `[]` when there is no plan or no reading yet. |
| `at` | when the reading was taken, unix ms (a transcript reading: when the Codex rollout recorded it) |
| `stale` | not a fresh answer of the CLI: it comes from a transcript, or the last probe failed and this is the reading before. Clients also treat a reading older than 10 minutes as stale. |
| `error` | why there is no fresh reading: `no_plan` (an API key, or signed out), `not_installed`, `timeout`, `failed` |
| `source` | `probe`, or `transcript` |
| `reached` | Codex's `rateLimitReachedType` of the account's own limit, present while it is reached. The `rateLimitReachedType` of a model's own limit (`rateLimitsByLimitId`) is not here: it is `reached` on that limit's windows, so a client warns about it only for that model. A model limit with no windows has nothing to carry it and is dropped. |
| `credits` | Codex's `{"has_credits","unlimited","balance"}` |

Unknown keys of the CLIs are ignored; the fields above are only ever added to.

- **Claude**: `claude -p --input-format stream-json --output-format stream-json --verbose --tools '' --setting-sources ''
  --strict-mcp-config --disable-slash-commands --no-session-persistence` in an empty temporary directory, with
  `CLAUDECODE*` and `HERDR_*` removed from the environment. One line goes to its stdin, the `get_usage` control request;
  the bridge reads lines until the `control_response` with `request_id` `usage`, then closes stdin. It gives up after 30 s
  and kills the process 10 s after that (also when the process does not exit after answering).
  `rate_limits_available: false` is `error: "no_plan"`.
- **Codex**: `codex app-server` over stdio JSON-RPC: `initialize`, the `initialized` notification, then
  `account/rateLimits/read`. When that fails, the fallback is the last `token_count` `rate_limits` of the newest Codex
  rollouts (`--codex-sessions`), sent with `source: "transcript"`, `stale: true`, the time it was recorded as `at`, and
  the probe's `error`.
- **Schedule**: every 2 minutes while at least one client is connected (none: nothing is probed); `limits.refresh`
  reads both at once, at most once every 20 s (else `{"queued": false}`); after 3 failures in a row a provider is read
  every 10 minutes; one with no plan, or whose CLI is missing, every 30 minutes. `--claude` / `HERDR_WORLD_CLAUDE`,
  `--codex` / `HERDR_WORLD_CODEX` name the executables. Lookup prefers `PATH`, then `~/.local/bin`, as model
  discovery does, so native installs work with the systemd user manager's restricted `PATH`. Explicit paths are honored;
  `--no-limits` turns it off: `limits.refresh` is `unsupported` and the snapshot has no `limits` key (there is a `limits`
  key, `[]` at first, exactly when the bridge reads limits). A refresh acknowledged while a read is running is not lost:
  when that read ends, both providers are read again at once (the read that was running may predate the request).
  A Codex CLI that is missing still falls back to the rollouts, when there are any.

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
  `terminal.watch` is `capacity`. Each watch has its own observer. An observer that is stopping keeps its place under
  both caps until it has exited and been reaped: a re-watch, or a watch right after an unwatch, starts its observer (and
  is acked) once the old one is gone, waiting up to 3 s (then `capacity`).
- **Never block, never leak.** Each observer's output is read continuously, also while a frame is being sent. What
  is not sent yet merges into one pending frame of at most 512 KiB, the watch's only queue. Frames are only queued while the connection's send queue is at most half full, so they never push a
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

A Claude session started with `--name` (every hire) is **`idle`** (or `done`) to herdr 0.9.0 while its AskUserQuestion
dialog is up (the name's rule at the bottom of the screen hides the dialog from herdr's blocked-form rule), so it never
gets a `question`; its `ask` (read from the transcript, [Laptops: asks](#laptops-asks)) is what flags and answers it.

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
  loses its `usage` (`worker.upsert` without it), and so does one whose agent session (or the Codex rollout picked for
  it, below) changes, on the first check after it: that usage was the old session's. The new session's comes as a
  `worker.usage` once its transcript is read (still at most once per 5 s; read in that same check, it replaces the old
  one directly). Workers without an `agent_session` have none (plain shells), except
  a running Codex (below).
- The bridge checks every worker's transcripts every 2 s, reading from a stored byte offset: complete lines only (an
  incomplete last line waits for the next read), so appending a line reads only that line. A file that shrank or was
  replaced is read again from the start and its session counted afresh. A transcript not found is looked for again at
  most every 30 s (paths found are kept); a session's subagents directory is listed every 10 s. Symlinks are not
  followed; lines over 16 MiB are skipped. Per session it remembers the last 8192 message ids. A worker whose
  transcript is watched ([Laptops: transcript](#laptops-transcript)) is looked for every 2 s instead, and shares this
  read: the transcript view gets the lines as usage reads them.

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

### Laptops: transcript

A worker's agent conversation as one timeline of items, for the laptop's conversation view (M16): the same session as
the terminal, read from the agent's own transcript file, so the TUI is never touched. Claude Code and Codex both
become the same item model; the game never sees raw JSONL. Images are part of it since phase 2 (#56): an item carries
an `ImageRef` (below), never bytes; the bytes come from `transcript.image`, by hash, for a hash this connection was
sent.

```json
{"t":"transcript.watch","req_id":"60","args":{"id":"6db1905e-…","limit":200}}
{"t":"ack","req_id":"60","data":{"harness":"claude","session":"0a0b0c0d-…","version":"2.1.285","cursor":"c:18237","has_more":true,"pending":false,"items":[…]}}
{"t":"transcript.items","id":"6db1905e-…","items":[…],"updates":[…]}
{"t":"transcript.page","req_id":"61","args":{"id":"6db1905e-…","before":"c:18237","limit":200}}
{"t":"ack","req_id":"61","data":{"items":[…],"cursor":"c:18037","has_more":true}}
{"t":"transcript.item","req_id":"62","args":{"id":"6db1905e-…","item":"toolu_01…"}}
{"t":"ack","req_id":"62","data":{"item":{…}}}
{"t":"transcript.page","req_id":"63","args":{"id":"6db1905e-…","agent":"aa3716c63ba631707"}}
{"t":"transcript.image","req_id":"65","args":{"id":"6db1905e-…","hash":"9f2c…","size":"thumb"}}
{"t":"ack","req_id":"65","data":{"mime":"image/png","width":480,"height":270,"bytes":41230,"size":"thumb","data":"iVBORw0KGgo…"}}
{"t":"transcript.images","req_id":"66","args":{"id":"6db1905e-…"}}
{"t":"ack","req_id":"66","data":{"images":[{"hash":"9f2c…","mime":"image/png","bytes":183422,"width":1280,"height":720,"source":"inline","origin":"input","item_id":"msg_01a0…","seq":59,"ts":1790710517124}]}}
{"t":"transcript.unwatch","req_id":"64","args":{"id":"6db1905e-…"}}
{"t":"ack","req_id":"64"}
{"t":"transcript.closed","id":"6db1905e-…","reason":"session_changed"}
```

**Which file.** The worker's transcript is the one its usage is read from ([Usage and cost](#usage-and-cost)), found
by the bridge from the worker id alone (the client never names a file): Claude's
`<--claude-projects>/*/<agent_session>.jsonl`, Codex's rollout of its `agent_session`, or for a live Codex without
one the rollout picked by its `cwd` (with the same caveat for two Codex agents in one folder). The file is read by the
worker's one tail, the usage one: a watch adds no second tail. When a watch starts, the bridge indexes the part of the
file that tail read already, once, in the background (it never holds up other commands); after that every line the
tail reads goes into the index as it is read. While a worker is watched its transcript is looked for every **2 s**
(not 30 s) when it is not found yet, and a Codex worker's rollout is picked again every 2 s. While any transcript is watched the tail reads every **1 s** instead of every 2 s, so a pasted screenshot is in the view within 3 s of its line being written (1 s to read it, at most 250 ms to push it, then the thumbnail).

**The index**, not the transcript, is what the bridge keeps: for each item the byte offsets of its lines (and the few
ids that pair a call with its result). An item is read back from the file when it is sent. A 50 MB transcript, mostly
base64 images, indexes in about 0.3 s and adds a few MB to the bridge; its first page takes milliseconds, and paging to
the top never reads the file from the start again.

**`transcript.watch`** `{id, limit}` (`limit` 1–500, default 200) acks once the index has caught up, with the newest
`limit` visible items (hidden ones between them come along, see `hidden`) and:

| field | |
|---|---|
| `harness` | `claude`, `codex`, or the worker's harness (`""` for a shell) while `pending` |
| `session` | the agent session read (Claude's session id, the Codex rollout's), `""` while pending |
| `version` | the agent's version the transcript records last (Claude's `version`, Codex's `session_meta.cli_version`); `""` when none |
| `cursor` | `c:<seq>`: the oldest item sent; `transcript.page` with it as `before` returns the ones before |
| `has_more` | items older than those sent exist |
| `pending` | the worker has no transcript yet (a fresh hire, a plain shell, an agent that wrote nothing): `items` is `[]`. When one appears (a new `agent_session`, a first line), the first `transcript.items` push carries the newest page **and** these head fields (`harness` … `pending: false`), as the ack would have. |
| `items` | oldest first |

Then **`transcript.items`** pushes what changed, **at most 4 a second** per watch: `items` are new items (in `seq`
order), `updates` whole replacements of items sent before, by `id` (a tool's result came, an interrupted call, a
Claude message that got another text block, a block sent again). An update can be of an item the client has not
loaded (it paged less far): ignore it.

**`transcript.page`** `{id, before, limit}` returns up to `limit` visible items older than `before` (a cursor), with
`cursor` and `has_more` as above; `before` is required. With **`agent`** (a Claude subagent's `agent_id`, from a
`subagent` item) it pages that subagent's own timeline instead,
`<the session's directory>/<agent_session>/subagents/agent-<agent_id>.jsonl`, and `before` is optional (none: its
newest). A subagent's timeline is read on request, not pushed: page it again (the bridge reads only what was
appended since) when its `subagent` item's status changes. Each watch keeps the last 4 subagents it read indexed.

**`transcript.item`** `{id, item, agent?}` is one item in full: no caps (below) and the tool's raw `input`. Unknown
`item`: `not_found`.

A page is also cut at about 4 MiB of items (the older ones wait for the next page: `has_more`), and at 2000 items
hidden ones included. `transcript.page` and `transcript.item` are only for a worker this connection watches (else, or
while it is pending, `invalid_state`), run off the hub and are not audit-logged (they are reads of what the watch
shows). `transcript.watch` and `transcript.unwatch` are audit-logged with the worker id only, never content.

#### Items

```json
{"id":"toolu_01GpmLgfG4MErwKXAfTwBBy5","seq":57,"ts":1790713250750,"kind":"subagent",
 "tool":{"name":"Agent","input_summary":"Map logo touchpoints in repo","status":"ok","output_text":"Async agent launched…"},
 "subagent":{"agent_id":"aa3716c63ba631707","description":"Map logo touchpoints in repo","status":"async_launched"}}
{"id":"toolu_018mQCao59VwQiRK6L6zHu5h","seq":58,"ts":1790734485453,"kind":"tool",
 "tool":{"name":"Edit","input_summary":"/home/u/…/protocol.ts","input":{…},"status":"ok","output_text":"The file … has been updated.",
   "diff":{"path":"/home/u/…/protocol.ts","hunks":[{"old_start":369,"old_lines":6,"new_start":369,"new_lines":11,"lines":["   ctx","-old","+new"]}]}}}
{"id":"msg_01a0eeaa-0d84-…","seq":59,"ts":1790710517124,"kind":"user","parts":[{"image":{"hash":"9f2c…","mime":"image/png","bytes":183422,"width":1280,"height":720,"source":"inline","origin":"input","item_id":"msg_01a0eeaa-0d84-…","seq":59,"ts":1790710517124}},{"text":"[Image #1] what is this?"}]}
{"id":"o:10450","seq":60,"ts":1790659967485,"kind":"notice","hidden":true,"notice":{"text":"","source":"event_msg/item_completed"}}
```

| field | |
|---|---|
| `id` | stable for the transcript: Claude's `message.id` plus the index of the item's first block (`msg_…#1`), a `tool_use` id, a line's `uuid`; Codex's item `id` or a call's `call_id`; `o:<byte offset>` for a line without one |
| `seq` | the item's place in the transcript, from 1: the order in which items first appear |
| `ts` | unix ms of the item's first line (0 when it has no timestamp) |
| `kind` | `user`, `assistant`, `thinking`, `tool`, `subagent`, `compaction`, `notice`, `unknown` |
| `hidden` | `true` for what the view shows only with its "show system" toggle: the dropped lines (as notices, below) and `unknown` items. The bridge sends them all; the game filters. `limit` counts only items that are not hidden. |
| `parts` | `user` / `assistant` / `thinking`: in order, each `{"text": markdown}` or `{"image": ImageRef}`. A `[Image #n: /path]` marker in a user's text is an image part of its own (`source: "path"`, resolved only under the roots below); the text around it stays. Thinking with no text (Claude's redacted thinking, Codex's encrypted reasoning with an empty summary) has no parts: a "reasoning" chip. |
| `truncated` | a part's or the notice's text was cut for the list (`transcript.item` has it all) |
| `tool` | `tool` / `subagent`: `name` (Codex: `namespace.name` when namespaced), `input_summary` (the input's first line, at most 200 characters: the command, file path, pattern, URL…; Codex `exec` scripts: their first `cmd`; `apply_patch`: the files), `input` (the raw input as JSON; in lists only when at most 4 KiB), `status` (`running` until the result comes, then `ok`, `error` or `interrupted`), `output_text` (the result's text, at most 64 KiB in lists: then `output_truncated: true`), `images` (`[{"image": ImageRef}, …]`, the images in the result: what the agent viewed), `diff` (`{path, hunks, truncated?}`: Claude `Edit`/`Write`'s `structuredPatch`, a created file as all added lines; Codex `apply_patch`, whose hunks have no line numbers: 0), `diffs` (every file, when a patch changes more than one; `diff` is the first). Diff lines are capped at 64 KiB in lists (`truncated`). |
| `subagent` | a Claude `Agent` / `Task` call: `agent_id` (from its result, `""` until then), `description`, `status` (`running`, then the result's: `completed`, `async_launched`, … or `error` / `interrupted`) |
| `notice` | `notice` / `compaction`: `text` (at most 64 KiB in lists, 512 bytes for hidden ones) and `source`, the line type it came from |
| `raw_type` | `unknown`: the line or block type not recognised (`hologram-state`, `assistant/hologram`, `event_msg/…`, `(invalid line)`) |

**Parsing** (`internal/transcript`, fixtures of real lines in `internal/transcript/testdata`). Both formats are
internal and change between releases: nothing fails the parse; a line or block that is not recognised is an `unknown`
item, so drift shows up instead of being lost.

- **Claude Code.** An assistant message streams as several lines with the same `message.id`, one block each
  (`apiBlockIndex`): consecutive `text` blocks are one `assistant` item and consecutive `thinking` blocks one
  `thinking` item, parts in block order; a block sent again replaces its part. `tool_use` / `server_tool_use` is a
  `tool` item (an `Agent` / `Task` one a `subagent`), and the `tool_result` (with the line's `toolUseResult`: diffs,
  `interrupted`, `agentId`) or `*_tool_result` block that answers it updates that item. `is_error` is `error`; a
  result starting "[Request interrupted by user" is `interrupted`. A user line "[Request interrupted by user…]" is a
  notice and interrupts every call still running. `system` `compact_boundary` is a `compaction` (the items before it
  stay: the view shows the whole history, not the model's context); the summary line after it (`isCompactSummary`) a
  notice. `/command` lines are user items (`/clear`), their output (`<local-command-stdout>`, `!` shell output) a
  notice.
- **Codex.** `response_item`s: `message` (`user` / `assistant`; the `<image …>` wrapper text around a pasted image is
  dropped), `reasoning` (its summary), `function_call` / `custom_tool_call` / `local_shell_call` and their `_output`
  (paired by `call_id`; an output `{"success": false}` is `error`), `agent_message` (a notice: sender → recipient).
  `compacted` is a `compaction` (its `replacement_history` is never read). `event_msg` `turn_aborted` is a notice and
  interrupts every call still running; `task_complete` a notice ("Turn took 13.8s"); `error` a notice.

**Hidden** (sent with `hidden: true`, as `notice`s whose `source` is the type):

| Claude Code | Codex |
|---|---|
| every `attachment` line (reminders, hook context, tool lists, dates…), **except** a prompt the user queued while the agent worked (`queued_command` from a human): that is a `user` item | `message` of role `developer` (or `system`) |
| `isMeta` user lines (skill bodies, caveats) and user text that is only `<system-reminder>` wrappers (wrappers are cut from other text) | the injected user context: `# AGENTS.md instructions…`, `<environment_context>`, `<user_instructions>` |
| metadata lines: `last-prompt`, `mode`, `permission-mode`, `bridge-session`, `atis-latch`, `ai-title`, `custom-title`, `agent-name`, `cost-state`, `pr-link`, `file-history-*`, `queue-operation`, `frame-link`, `artifact-*`, `summary`, `progress`, `tag` | `session_meta`, `turn_context`, `world_state`, `token_usage_record`, `inter_agent_communication_metadata` |
| `system` `stop_hook_summary`, and a `local_command` with no output | `event_msg`s that repeat response items or keep books: `token_count`, `item_completed`, `thread_settings_applied`, `task_started`, `user_message`, `agent_message`, `agent_reasoning*`, `exec_command_*`, `patch_apply_*`, … |

Shown as notices: Claude `system` `turn_duration` ("Turn took 9m 52s"), `away_summary`, `informational`, `api_error`,
`local_command` output; Codex `task_complete`, `turn_aborted`, `error`.


#### Images

An `ImageRef` says what an image is and where it sits; it never has bytes.

```json
{"hash":"9f2c…","mime":"image/png","bytes":183422,"width":1280,"height":720,"source":"inline","origin":"input",
 "item_id":"msg_01a0eeaa-0d84-…","seq":59,"ts":1790710517124}
{"source":"path","path":"/etc/hosts.png","origin":"input","unavailable":true,"reason":"not_allowed","item_id":"…","seq":59,"ts":1790710517124}
```

| field | |
|---|---|
| `hash` | sha256 of the image bytes, hex: the key of `transcript.image`. The same image twice (Claude repeats payloads, a screenshot sent again) has the same hash. Absent when `unavailable`. |
| `mime` | `image/png`, `image/jpeg`, `image/gif` or `image/webp`, from the **bytes** (never the transcript's label); `binary` for inline bytes that are none of them (an SVG, a PDF): no thumbnail, no download. |
| `bytes`, `width`, `height` | of the original (width and height 0/absent when the header could not be read) |
| `source` | `inline` (base64 in the transcript) or `path` (a file the transcript names) |
| `path` | `source: "path"`: the path, or a URL, as **text** for the view. The client never sends it back. |
| `origin` | `input`: only what the user attached to a prompt (a paste, an `[Image #n: path]` marker in a user message). `agent`: everything else, what the LLM viewed or generated. |
| `kind` | `agent` images only, a detail for a badge: `generated` (Codex `image_generation_end`, an assistant `image` block, a file under `~/.codex/generated_images`) or `viewed` (a Claude `Read` of a PNG, a screenshot in a tool result, Codex `view_image`) |
| `item_id`, `seq`, `ts` | the item the image is in (the Images view links back to it) |
| `unavailable`, `reason` | the bridge did not take the image: `not_allowed` (a path outside the roots, or a symlink out of them; a URL), `missing`, `too_large` (over 25 MB), `not_image`, `invalid` (bad base64) |

**Where images come from.** Claude: `image` blocks with a base64 `source`, in user messages (`input`) and in
`tool_result.content[]` (`agent`/`viewed`; a `Read` of a PNG is the common case, shown inside the expanded tool row);
an assistant `image` block is `agent`/`generated`. Codex: `input_image` data URLs in user messages (`input`; the
`<image name=… path=…>` wrapper text around them is dropped) and in tool outputs (`agent`/`viewed`), an
`image_generation_end` event (`agent`/`generated`: its `result` base64, else its `saved_path`), and a `view_image` call
whose output has no image (the file it named, exactly that file). A `url` source (Claude) or a remote `image_url`
(Codex) is never fetched: it is an `unavailable` image whose `path` is the URL.

**Inline images** are decoded once, hashed and filed in a bounded content-addressed cache: **64 MiB** in memory (least
recently used out first), and in a `0600`-file / `0700`-directory disk cache under `$XDG_CACHE_HOME/herdr-world/img/`
(`--image-cache <dir>`, `-` for none; 512 MiB, oldest out first) so bytes that left memory come back without reading
the transcript again; if they are in neither, the bridge reads the transcript line they came from again, so the cache
never has to be complete. Items never hold base64. The original of an image over 25 MB is not kept.

**Path images** are read only under an **allowlist of roots**: Drop Zone's data directory (`--dropzone-data`, default
`$DROPZONE_DATA` or `~/drops`: where #13/#51's `[Image #n: /abs/path]` markers point), `~/.codex/generated_images` (beside
`--codex-sessions`), the worker's own `cwd`, and the exact file a Codex `view_image` call named. The path must be
absolute and clean, inside a root as written **and** after `EvalSymlinks` (a symlink that leaves the root is refused), a
regular file of at most 25 MB whose bytes are a PNG, JPEG, GIF or WebP. A path outside every root is refused before any
file system call, so the bridge does not even look at it; anything refused is an `unavailable` image whose `path` the
view shows as text with "not available". A path that vanished is the same. The client never names a path.

**`transcript.image`** `{id, hash, size, agent?}`, `size` `thumb` or `full`: the image with that hash, only for a worker
this connection watches and **only for a hash the bridge already sent this connection** (in the watch ack, a push, a
page, an item or the image list; else `not_found`, also for a hash that never was in the transcript). Ack:
`{mime, width, height, bytes, size, data}` with `data` the base64 of the image (`thumb`: at most **480 px** on the
longest side, PNG, or JPEG for a JPEG original; a GIF is its first frame). A `full` image whose base64 would be over
**12 MiB** is `too_large` (the view keeps the thumbnail and says so). An image that can no longer be read (a file
changed under its hash, gone) is `not_found`; `binary` never has bytes. `agent` reads a Claude subagent's timeline like
`transcript.page` does. A watch has at most 16 image reads in flight (`busy` above). Not audit-logged (a read of what the
watch shows), and nothing of the image is ever logged.

**`transcript.images`** `{id, before?, limit?}`: the images of the session, oldest first, as
`{"images": [ImageRef…], "cursor"?, "has_more"?}`, from the index (the whole file, not only the watch's window; each
item that has images is read back once and its images remembered). Without `before` the newest come; a page is whole
items (the newest ones, until `limit` refs, default 500, at most 2000 — `bad_request` above — or about 1 MiB of JSON;
never fewer than one item), and with `has_more` the `cursor` goes in the next request's `before` for the older ones, so
every image of a session of any size is reached by following it (a bad `before` is `bad_request`). No bytes; the hashes
count as sent.

#### Limits and lifecycle

- `--max-transcript-watches` (`HERDR_WORLD_MAX_TRANSCRIPT_WATCHES`, default 4) per connection: above it
  `transcript.watch` is `capacity`. These are not terminal watches: they do not count against `--max-watches`.
  Watching a worker again replaces its watch (a fresh ack); `transcript.unwatch` stops it (a no-op for a worker not
  watched), and closing the connection stops them all. After a reconnect, watch again: pushes are never replayed.
- **Never block, never leak**, as terminal frames: a push is only queued while the connection's send queue is at most
  half full. When it is fuller, or the watch fell 4096 changes behind, the bridge drops what is pending and ends the
  watch with `transcript.closed{reason: "resync"}`: watch again. Nothing of a watch outlives an unwatch, a closed
  connection or a bridge shutdown; the index goes when no connection watches the worker.
- A worker on an asleep floor is `invalid_state`; an unknown id `unknown_worker`.

**`transcript.closed`** ends a watch the client did not stop: `reason` is `worker_removed` (the worker is gone or was
sent home), `asleep` (its floor went to sleep), `session_changed` (another agent session: a new `agent_session`, or
another Codex rollout picked, e.g. after `/clear` or `/new`; watch again for the new one), `resync` (see above; also a
transcript file that was truncated or replaced) or `not_found` (the transcript file went). It is not sent for a
`transcript.unwatch`, a re-watch or a closed connection.

### Laptops: asks

#57. When an agent asks a structured question, the laptop's transcript view (and the quick reply where you stand)
answers it; the terminal stays the source of truth: the bridge types the answer into the agent's own dialog.

```json
"ask":{"tool_use_id":"toolu_01FuqDRbauxtx9cAAmN3o8ex","source":"transcript","agent":"claude","since":1790766523807,
  "questions":[{"header":"Drink","question":"Tea or coffee?","multi":false,"other":true,
    "options":[{"label":"Tea","description":"Hot tea"},{"label":"Coffee","description":"Hot coffee"}]}]}
```

**Reading it.** The usage tracker reads every worker's transcript anyway (its one tail, from the file's start, every
2 s, every second while one is watched; see [Usage and cost](#usage-and-cost)), and the same lines tell it the ask the
latest turn waits on:

- Claude Code: the last `AskUserQuestion` `tool_use` of the main conversation (`isSidechain` lines, a subagent's, are
  not the worker's dialog) that has no `tool_result` of its `tool_use_id` yet (an error result resolves it too: Esc is
  `is_error` with `toolUseResult: "User rejected tool use"`, "Chat about this" a clarification request), no genuine
  prompt after it (a reminder, a task notification or a meta line is not one) and no `[Request interrupted by user…]`.
- Codex: the last `response_item` `function_call` named `request_user_input` with no `function_call_output` of its
  `call_id` and no `turn_aborted` or new user message after it (its `arguments` are JSON in a string). Codex offers it
  in Plan mode (Default mode with `[features] default_mode_request_user_input = true`).
- A call whose questions have no options is not an ask (Codex refuses it at once; Claude never shows it).

So `ask` is on the worker **whatever herdr reports**: herdr 0.9.0 says `idle` (or `done`) for a Claude session started
with `--name` (every hire) while its dialog is up (see docs/decisions.md, 2026-09-30). It is in snapshots and
`worker.upsert`s, is cleared in the upsert where the result is read, and goes with the worker's session (a new one,
`/clear`, a new rollout). It is the ask, not a status: a client counts a worker with one as waiting on you, like
`blocked` (the game: its card, the counts, N), waiting since `since` (the call's timestamp; the bridge's clock when
the line has none). Its fields:

| field | |
|---|---|
| `tool_use_id` | Claude's `tool_use` id or Codex's `call_id`: which ask an answer is for |
| `source` | `transcript` |
| `agent` | `claude` \| `codex` |
| `questions` | 1–4, each `{id?, header, question, multi, other, secret?, options: [{label, description?, preview?}], truncated?}`: `id` is Codex's (its answers are keyed by it); `multi` picks several (Claude's `multiSelect`; Codex has none); `other` takes a typed answer (Claude's "Type something": every question but one with previews, whose dialog has no such row; Codex's "None of the above" with notes, on every question); `secret` is masked on its screen (Codex `isSecret`) |

Caps (it is in every snapshot): at most 4 questions and 8 options each, a header 64 bytes, a question 2000, a label
200, a description 1000, a preview 1024; `truncated` says one was cut. A transcript item of such a call has the same
questions as `tool.ask` (see below).

**Answering it.** **`worker.answer_ask`** takes one answer per question, `{question: <index>, choices: [1-based option
numbers…], other?: <text>}` (a single-select question takes one choice or `other`; a multi-select one choices and/or
`other`; `other` is 1–4096 bytes of one line without control characters, only where `other` is true), or `cancel: true`
(Esc on its dialog), optionally with a `prompt` sent once the dialog is gone ("I want to talk about this first" in one
action). It is `stale` when the worker has no ask or another `tool_use_id` (answered in the terminal meanwhile, or
something else asked); `bad_request` for answers that do not fit the questions. On the worker's input lane (after its
other input) it checks the ask again, then drives the dialog with the keys verified live (Claude Code 2.1.285, codex-cli
0.159.2, herdr 0.9.0; the screens are in `internal/server/testdata/screens/claude-ask-*`, `codex-ask-*`), reading the
screen before and after every step and pressing nothing unless the dialog shows what it expects: the question it is
answering (by its text, however it wraps), the cursor, the ticks, the typed text, the review:

| dialog | keys |
|---|---|
| Claude, a single-select question | its option's digit (it moves on by itself); a preview question: the digit (it only moves the cursor), Enter; `other`: the digit of "Type something.", the text, Enter; that row holding other text (typed in the terminal): arrows to it (its digit would submit that text), ctrl+e, ctrl+u (it empties), the text, Enter |
| Claude, a multi-select question | each option's digit, **one herdr call each** (several in one call were dropped live), ticks checked; the digit again of each row ticked before that the answer does not have ("Type something" too: its digit unticks it without moving the cursor); then → (the next question, or the review); with `other`: arrows to "Type something", ctrl+e, ctrl+u if it holds other text, the text (Enter if that left it unticked), Tab to the Submit / Next row, Enter |
| Claude, several questions or a multi-select one | then the review: Enter on "1. Submit answers" |
| Claude, `cancel` | Esc (Claude records a rejected call and an interruption) |
| Codex | per question, in order: its option's digit (the last one submits them all); `other`: arrows to "None of the above", Enter (its notes open), the text, Enter (a digit on "None of the above" would submit it without the text) |
| Codex, `cancel` | Esc (Codex interrupts the turn) |

The cursor left (in the terminal) on a Claude question's "Type something" row edits its text, where a digit is
typed (seen live): the arrows take it off before any digit. Codex notes left open take no digit: `input_failed`, nothing
pressed. The dialog is the ask's when it shows one of its questions (its text) with its options (each option row shown has
that option's label), or (Claude) its review with a tab per question header. After the last key (the one question's,
the review's Enter, Codex's last question's) the dialog must be gone within the step timeout (3 s). A dialog that is
not where it should be (another dialog, a question already answered in the terminal, a step that did not show, the
dialog still there after the last key) stops it with `input_failed` (the message names the step and the question by
number, and the key names sent so far: never a question's, option's or typed text, as it reaches the audit log and
the bridge's log); the ask answered or replaced while it drives stops it with `stale`, and no more keys go. `cancel`
presses Esc only on the ask's own dialog: another question on the screen (the terminal moved on before its transcript
said so) is `stale`, nothing pressed. `sent` lists the key names pressed,
`text` for typed text (never the text). `resolved` is true only when the transcript recorded the call's result within
8 s (the upsert without the `ask` comes before the ack); false means the keys went and the dialog took them, but the
agent has not recorded an answer yet. A prompt to a worker with an ask is `invalid_state` (its dialog would take the text). The audit log keeps
the ids, the picks and each typed text's length (`other_bytes`, `prompt_bytes`), never the text.

```json
{"t":"worker.answer_ask","req_id":"61","args":{"id":"6db1905e-…","tool_use_id":"toolu_013cY4rbTxmy3foDDYjPKtTL",
  "answers":[{"question":0,"choices":[1,3],"other":"Custom dashboards"},{"question":1,"other":"Green"}]}}
{"t":"ack","req_id":"61","data":{"sent":["1","3","down","down","down","text","tab","enter","3","text","enter","enter"],"resolved":true}}
{"t":"worker.answer_ask","req_id":"62","args":{"id":"6db1905e-…","tool_use_id":"toolu_01BUcPM6aQV2dWp9WtSoCD5W","cancel":true,"prompt":"Let's talk about it first."}}
{"t":"ack","req_id":"62","data":{"sent":["esc"],"resolved":true,"prompted":true}}
```

**In the transcript.** An `AskUserQuestion` / `request_user_input` tool item has `tool.ask`: `{agent, questions,
outcome, answers?}`, `outcome` one of `pending`, `answered`, `declined` (Esc; Codex's cancelled call), `clarify`
(Claude's "Chat about this"), `interrupted`, and `answers` `[{question, answer, labels?, other?, notes?}]` from the
result (Claude: `toolUseResult.answers`, keyed by the full question text, several labels joined with ", ";
`annotations` notes; Codex: the output's `answers` by question id, `"user_note: …"` the typed text). A secret's typed
text is `••••••`. The game shows it as a card whose answered form is `● You answered: <question> → <answer>`, also for
an answer typed in the terminal.

The screen parser of `worker.question` reads these dialogs with the same parsers: the whole question however it
wraps, the options' labels without their descriptions or previews, and a Yes / No question is `choice`, not
`permission`.

### Errors

```json
{"t":"error","req_id":"9","code":"unknown_command","message":"unknown command \"worker.prompt\""}
```

| code | meaning |
|---|---|
| `bad_request` | not a JSON object with `t`; missing `req_id`; bad or unknown `args` fields; invalid name; a second `hello` |
| `unknown_command` | `t` is not a command of this protocol version. The connection stays open. |
| `not_found` | no building with that id; a `transcript.item` id that is not in the transcript, a `transcript.image` hash this connection was not sent (or an image that can no longer be read), or a subagent (`agent`) without a transcript; no team preset with that id (`preset.update`, `preset.delete`, `run.prepare`, `run.start`); a board item id that is not on the floor's provider, or a `work_item` that is not on its board |
| `name_taken` | another building, or another team preset, already has that name (ignoring case) |
| `unknown_session` | a floor command for a session the bridge does not know or does not watch (`--sessions`) |
| `unknown_worker` | `worker.fire.prepare` / `worker.fire` / the laptop commands for a worker id the bridge does not know (or on an unwatched floor) |
| `busy` | `transcript.image` with 16 reads already in flight for that watch; a floor command while that floor's wake or sleep is in progress; `floor.wake` / `floor.sleep` while a hire or send-home on it is in progress; `worker.fire*` for a worker that is still being hired or already being sent home |
| `invalid_state` | `worker.open_pr` for a worker that is not a plain worker in the branch the bridge made, or whose tree is dirty or has nothing to open; `floor.wake` on a running floor, `floor.sleep` on an asleep one, hire or send home on an asleep floor; a laptop command for a worker on an asleep floor or without a pane, `worker.prompt` to a plain shell, a blocked worker or one with an `ask`, `worker.answer` to a worker not blocked; `transcript.page` / `transcript.item` / `transcript.image` / `transcript.images` for a worker this connection does not watch or whose transcript is pending, or whose transcript changed while it was read |
| `desk_taken` | `worker.hire` at a desk someone holds or a hire in flight reserved, or outside `0 … desks-1` |
| `too_large` | `transcript.image` with `size: "full"` for an image whose base64 is over 12 MiB (its thumbnail is still served) |
| `capacity` | `worker.hire` above `--max-workers-per-floor` or `--max-workers`, `terminal.watch` above `--max-watches` or `--max-observers`, `transcript.watch` above `--max-transcript-watches`; the message says which |
| `not_clean` | `worker.fire` asked to delete a worktree whose tree is dirty or has unpushed commits; for `delete_branch` also when the checkout is no longer on the branch the bridge made or that branch has commits on no remote |
| `fetch_failed` | `worker.hire` with `worktree: true` whose `git fetch origin` failed (no `origin`, offline, timed out after 20 s, …); the message is git's error. Nothing was made. (After the accept, like `bad_request` for a missing default branch.) |
| `hire_failed`, `fire_failed` | herdr or git failed during a hire / send-home; the message says which step and why. `fire_failed` also when the agent did not exit (still running, or its processes could not be read): then nothing was closed or removed. `hire_failed` names what its rollback kept. |
| `wake_failed` | the server did not start, did not answer `ping` or was not seen running within `--wake-timeout`; the message says why |
| `sleep_failed` | `herdr session stop` failed (the message has herdr's error), or the floor was not seen asleep within 15 s |
| `input_failed` | `worker.keys` / `worker.answer` / `worker.answer_ask`: herdr refused the keys or text, the screen could not be read, or 32 commands already wait for that worker; `worker.answer_ask` also when the dialog was not where it should be before a step, or still there after the last one; the message says why |
| `prompt_failed` | `worker.prompt` was not submitted: herdr failed, or the agent did not start working even after Enter was pressed again |
| `stale` | `worker.answer` for a question the worker's screen no longer asks (another `hash`), or a worker no longer blocked; `worker.answer_ask` for an ask the worker no longer has (another `tool_use_id`, or none), also when it was answered or replaced while its keys were being pressed, or (`cancel`) the screen shows another question; `pr.merge` whose head moved since it was read |
| `changes_failed` | `worker.changes` whose git calls failed, or took longer than 10 s together; the message is git's error |
| `not_a_repo` | `worker.changes` for a worker whose directory is not in a git work tree |
| `confirmation_required` | `issue.close`, `pr.merge` or `worker.open_pr` without `confirm: true` (see [Boards](#boards-issues-and-pull-requests)) |
| `unsupported` | the floor has no board (no repo linked, no provider), or the provider or the card cannot do it (a capability is off); `worker.open_pr*` on a floor that cannot open pull requests |
| `provider_failed` | the provider call failed (`gh` missing, not logged in, the network, GitHub's refusal, a failed `git push`); the message is short and never has a token |
| `rate_limited` | the provider's rate limit |
| `checks_not_green`, `not_mergeable` | `pr.merge` of a pull request whose checks are not green, or that is not mergeable (also a conflicting one, always); an override is `override` and `confirm_override` together |
| `hello_required`, `unsupported_proto` | handshake failures; the connection is then closed with status 1008 |
| `logo_too_large`, `logo_unsupported`, `logo_invalid`, `logo_busy` | M3d, only on the `/logo` HTTP routes (see [Building logos](#building-logos)): an upload over the size limit, of an unsupported kind (an SVG that took too long to draw included), undecodable, or no conversion slot in time |
| `internal` | the bridge failed (database error, or waking, sleeping, hiring and firing is not configured); safe to retry |

Errors not tied to a command have no `req_id`.

## Flow control and closing

Each client has a bounded send queue (1024 messages). The bridge never waits for a slow client: if the queue fills up,
the client is disconnected with close status 1008, reason `slow consumer`. Reconnect with `since_seq`. Laptop frames
never fill it past half (they resync instead, see [Laptop screens](#laptop-screens)), nor do transcript pushes
([Laptops: transcript](#laptops-transcript)). On shutdown the bridge closes
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
herdr-world dump --board herdr-3d           # also board.watch a floor: its board.issues / board.prs as JSON lines
herdr-world dump --board herdr-3d --once    # …until the first fetched pair
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
herdr-world cmd preset.create '{"name":"Cheap","roles":{"orch":{"harness":"codex","model":"gpt-6-luna","effort":"low"},…}}'
herdr-world cmd run.prepare '{"session":"h3d-scratch","issue":"#3"}' | jq -r .data.prompt
herdr-world cmd issue.comment '{"session":"h3d-scratch","id":"JeffreyVdb/h3d-lab#3","body":"hello"}'
herdr-world cmd pr.merge '{"session":"h3d-scratch","id":"JeffreyVdb/h3d-lab#4","method":"squash","confirm":true}'
herdr-world cmd run.start '{"session":"h3d-scratch","desk_index":1,"issue":3,"preset":"p_…","orch":{"harness":"codex","model":"gpt-6-luna","effort":"low"},"prompt":"Reply with OK."}'
```

`dump` prints the `welcome` line on stderr. `cmd` prints the `ack` or `error` and exits 1 on error; it waits up to
`--timeout` (1 min) for a reply. All three take `--socket`.
