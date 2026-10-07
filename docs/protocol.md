# herdr-world protocol v1

The bridge (`herdr-world`) serves one WebSocket to game clients. This document is the contract; the Go types live in
[`internal/proto`](../internal/proto/proto.go). Design background: [`architecture.md`](architecture.md) §3–4.

## Transport

- A unix socket at `$XDG_RUNTIME_DIR/herdr-world/bridge.sock` (`--socket` / `HERDR_WORLD_SOCKET` to override). The
  directory is `0700`, the socket `0600`: access is "can act as this unix user", which for the Mac means "has SSH access"
  (`ssh -N -L <local.sock>:<bridge.sock>`). Nothing listens on TCP.
- HTTP/1.1 on that socket: `GET /ws` upgrades to the WebSocket, `GET|PUT|DELETE /logo/{building}` carry building logos
  (M3d, see [Building logos](#building-logos)), `POST /upload` carries one image to Drop Zone (see [Image upload](#image-upload)), `POST /screen/frame/{req_id}` carries the one JPEG a screen grab asked for (M13, see [Screen share](#screen-share)), `GET /healthz` answers `ok` and carries the bridge's build version in the `X-H3D-Version` header (the body stays `ok`: a helper from an older release checks it exactly). `welcome.server` is the same build as a banner, `herdr-world <version>`.
  ```sh
  curl --unix-socket "$XDG_RUNTIME_DIR/herdr-world/bridge.sock" http://herdr-world/healthz
  ```
- M13: `/whiteboard/{floor}/…` carry a floor's whiteboard (scene, image files, render) and `GET /drops/file` a recent
  drop's bytes, over HTTP on the same socket (see [Whiteboard](#whiteboard)).
- Text frames, one JSON object per frame. Every object has a string field `t`, its type. Client messages are limited to
  256 KiB (M7: a comment body is up to 64 KiB of text, escaped).
- The bridge reads herdr (`ping`, `session.snapshot`, `events.subscribe`, `herdr session list`, and for the laptop
  screens the read-only `herdr terminal session observe`). Its only writes to herdr are `floor.wake` / `floor.sleep`
  (see [Wake and sleep](#wake-and-sleep)), `worker.hire` / `worker.fire` / `worker.wrapup` (see [Hire and send
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

The helper proxies `POST /screen/frame/{req_id}` (M13, see [Screen share](#screen-share)) under the same rules as
`/upload` (`Host`, `token`, `Origin` when present; `403` `forbidden` as the error object; anything else under `/screen/`
is `405` with `Allow: POST`). Only the path goes on, no query. An id that is not 32 lowercase hex digits is `400`
`bad_request`; a body over 8 MiB + 4 KiB is `413` `frame_too_large`, by `Content-Length` and by counting while it
streams.

M13: the helper proxies the whiteboard's routes the browser uses (see [Whiteboard](#whiteboard)): `GET
/whiteboard/{floor}`, `POST /whiteboard/{floor}/save`, `GET /whiteboard/{floor}/render.png`, `GET|PUT
/whiteboard/{floor}/files/{id}` and `GET /drops/file`, under the same rules as `/logo` (`Host`, `token`, `Origin` when
present). Only their own query parameters go on (`version`; `base`, `author`; `v`; `path`, `thumb`). A save body is
let through up to 32 MiB + 128 KiB, a file up to 8 MiB + 4 KiB (`413` `whiteboard_too_large` past that).
`POST /whiteboard/{floor}/pin` (the agents' pins, for the office CLI on the bridge's host) and anything else under
`/whiteboard/` or `/drops/` answer `404` there and never reach the bridge.

A `502` means the tunnel is down; the helper's own `GET /healthz` reports the tunnel state
(`{"tunnel":{"state":"up|connecting|degraded|backoff",…}}`, `503` unless `up`).

The helper also answers one request of its own, for the game's "Open in <provider>" buttons and the links in issue
bodies (M7): `POST /api/open` with `{"url":"https://github.com/…"}` opens that page in the Mac's default browser
(`open <url>`). It needs the same `Host` and `Origin`, the token in an `X-H3D-Token` header (never in a URL) and
`Content-Type: application/json`, and accepts only an `https://` URL on a host of its allowlist (`github.com`; every
provider the bridge learns adds its own host), without credentials or a port. #184: a self-hosted provider's host
(the saved [Kaneo](#kaneo) instance's web host) is not built in: the bridge names it on its own `GET /healthz`, in the
`X-H3D-Open-Hosts` header (comma-separated host names; absent: none), which the helper reads through its ssh tunnel on
every 5 s check and adds to the allowlist while it is there (a save or a disconnect reaches the helper within one
check). No client can set it: the helper does not proxy `/healthz`. `204` opened; `400` a refused URL;
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

`ai` (#92) is the AI integration's state, never a key (see [AI integration](#ai-integration)); the key is left out by a
bridge without the service, as by one from before #92: a client's Settings then says the bridge has no AI integration.

`followups` (#90) is the follow-up questions feature's state (see [Follow-up questions](#follow-up-questions)), left
out by a bridge without the AI service or from before #90.

`packup` (#110) is pack up on request's state (see [Pack up on request](#pack-up-on-request)), left out by a bridge
without the AI service or from before #110.

`digest` (#118) is the floor overview summaries' state (see [Floor overview summaries](#floor-overview-summaries)),
left out by a bridge without the AI service or from before #118 phase 2; a worker's own `digest` (its lines) is in the
worker.

`activity` (#98) is "Classify unknown commands"' state (see [Activity](#activity)), left out by a bridge without the AI
service or from before #98; a worker's own `activity` is in the worker.

`inbox_dismissed` (#106) holds the dismissed rows of the game's inbox: worker id → the `status_since` of the done episode
that was dismissed (see [Inbox](#inbox)); `{}` when there are none. A bridge from before #106 leaves the key out: a
client reads that as `{}`.

`codex_server` (#155) is the shared Codex server switch, `{"enabled", "available"}` (see
[Shared Codex server](#shared-codex-server)); a bridge from before #155 leaves it out.

`kaneo` (#184) is the Kaneo connection, never a key (see [Kaneo](#kaneo)); a bridge without the settings, or from
before #184, leaves it out.

`presets` are the team presets, by name ignoring case (see [Team presets and starting a
run](#team-presets-and-starting-a-run)); `[]` when there are none.

`screen` (M13) is `{"sharing": false}`, or `{"sharing": true, "surface": "browser|window|monitor"}` while a connected
game shares its screen (see [Screen share](#screen-share)); a bridge from before M13 leaves it out.

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
| `followup` | object, optional | #90: the open questions of its agent's final message, `{"turn_id", "questions": [{"id", "question", "kind": "yes_no" \| "choice" \| "open", "options"?}], "score", "source": "model" \| "fallback", "at", "tail"?}`, until answered, dismissed or moot (see [Follow-up questions](#follow-up-questions)) |
| `activity` | object, optional | #98: what its agent is doing right now, `{"kind", "detail"?, "since", "source", "image"?, "tasks"?}`: while `status` is `working`, and while `idle` or `done` only as `waiting` on open background tasks; absent otherwise and for harnesses other than Claude and Codex (see [Activity](#activity)) |
| `digest` | object, optional | #118: what the floor overview says of it, `{"task"?, "task_source"?, "now"?, "now_source", "now_at"?, "task_status"?, "now_status"?}`: its task and what it does now in words, each with its source, and (#174) what became of a model line that is awaited or failed; absent until its transcript has a prompt or an assistant step, and for harnesses other than Claude and Codex (see [Floor overview digest](#floor-overview-digest)) |
| `wrapup` | object, optional | #83: its wrap-up, `{"state": "armed" \| "needs_you", "worktree": "keep" \| "delete" \| "delete_branch", "armed_at": int, "reason"?: string}` (unix ms, bridge clock; `reason` with `needs_you`), while armed or needing you (see [Wrap up](#wrap-up)) |
| `round` | int ≥ 1, optional | write-code round: the `h3d_round` token, else the label's trailing `\|r<N>` (see [Runs and freelancers](#runs-and-freelancers)) |
| `ticket` | string ≤ 32 bytes, optional | the `h3d_ticket` token, else the label's ticket field (`CODE\|descr\|<ticket>\|r<N>`, likewise `REVIEW` and `UX`) |
| `issue` | object, optional | `{"repo":"owner/name","number":7,"title"?,"url"?}`: the GitHub issue of the worker's run, when a repo is known. #118: `title` and `url` come from the floor's board provider when it has them (see [Ticket titles](#ticket-titles)) |
| `work_item` | object, optional | `{"provider":"github","id":"JeffreyVdb/herdr-3d#7","title"?,"url"?,"key"?}`: `issue` in the neutral form, present whenever `issue` is and the floor has a board provider (see [Boards](#boards-issues-and-pull-requests)). The `id` is a board card's `id`; #118: `title` and `url` as on `issue`. #184: a run started on an item of a provider that numbers no GitHub issues (a Kaneo task) has `work_item` **without** `issue`: `{"provider":"kaneo","id":"<task id>","key":"HRD-12","title"?,"url"?}`, from its launch record (kept across restarts), for the orchestrator and its crew; a Kaneo floor's numeric `ticket`s are never read as GitHub issues. |
| `orch_id` | string, optional | freelancers: the worker id of their orchestrator |
| `phase`, `pass` | string, int ≥ 0, optional | orchestrators: the `h3d_phase` / `h3d_pass` tokens (`research\|coding\|review\|fixing\|waiting_user\|pr\|done`, others passed through, ≤ 32 bytes), remembered like `harness` |
| `over_cap` | bool, optional | orchestrators: `true` past write-code's review-pass cap (`pass > 3`, or `pass == 3` and `phase == "waiting_user"`); absent when false |
| `report` | object, optional | freelancers: their write-code report (see [Runs and freelancers](#runs-and-freelancers)) |
| `codex` | object, optional | #155: how a Codex worker the bridge hired was launched, `{"mode": "shared" \| "legacy", "server"?: "starting" \| "running" \| "down" \| "stopped", "note"?, "attached"?, "thread"?, "turn"?, "questions"?, "async_blocked"?}` (see [Shared Codex server](#shared-codex-server); #156: `thread`, `turn` and `questions` in [Codex async questions](#codex-async-questions); #157: `async_blocked` there too); absent for other workers, and for Codex hires made with the switch off |

`harness`, `model` and `effort` are remembered once seen: herdr drops tokens when it restarts and asleep floors have
none, so the bridge keeps the last known value until a new one shows up. They are absent when never known.

**Identity.** When a workspace appears (bridge start, herdr restart, reconnect), the bridge matches it to a stored worker
by, in order: a pane-label marker `h3d-<short uuid>`; the native `agent_session` id; label + identity directory (only for
workers it has not seen closing). Otherwise it is a new worker. The bridge writes a marker only on the workers it hires
(`worker.hire` labels their root pane `h3d-<first 12 hex of the worker id>`); it never writes tokens to herdr.

### Hidden main checkouts

`herdr worktree create` opens one more workspace, for the repository's **main checkout**, when none is open on the
floor (its worktree group needs it as the primary workspace). It holds only a shell, so it is **not a worker**: the
bridge leaves it out of `worker.upsert`s and the snapshot, it takes no desk, and it does not count in `deskCount`,
`capacity` or the caps. The rule is derived from herdr's state on every observation, so it holds across bridge
restarts: a workspace is hidden when it is a repository's main checkout (`worktree.linked` false, a `repo_root`), has
**no agent** (no agent kind, name or session in its primary pane), and a linked worktree workspace of the same
repository is open on the same floor. It is also held hidden while a worktree hire of that repository is being made
(rollback included) or a bridge-hired worktree worker is being sent home, so the shell never shows between steps. When an
agent starts in it, or the last linked worktree of its repository goes (and the bridge did not close it), it is a
worker like any other: `worker.upsert`, a desk. When an agent in it exits while worktrees are open, it is
`worker.removed` (no `reason`) and its desk is freed. A hire's own workspace is never hidden.

### Desks and names

Each worker holds a **desk** on its floor: `desk_index` is stored in SQLite (`desk_assignment`) under the worker's id,
so it survives bridge and herdr restarts whenever the identity reconciles to the same worker. A worker new to its floor
takes the **lowest free** index, in sidebar order; a worker the bridge hires (`worker.hire`) takes the desk it was hired
at, which is reserved from the moment the hire is accepted. A desk is freed when its worker leaves the floor
(`worker.removed`: workspace closed, identity lost, session deleted), and the next newcomer reuses it. Workers of an
asleep floor keep their desks.

Each worker also gets a **name** from a built-in list of original names ("Nibble", "Pixel", "Mochi", …). Names are
unique among the floor's workers and never contain a digit. A name belongs to one
worker of its floor at a time (SQLite `worker_name`), and comes back with it after a restart or when its workspace
reopens. When the bridge sees the worker leave the floor (`worker.removed`: workspace closed, identity lost, session
deleted), the name stays **held** for `--name-hold` (default 7 days) from that moment: no newcomer gets it, so a
worker that returns within the hold always has its name. A worker that leaves while the bridge is down is seen leaving
when the bridge next observes its floor, so the hold starts late, never early.

The hold gives way when the list runs out. When every name is held, a newcomer takes the held name **released longest
ago** (its hold ends early; its old owner gets a new name if it ever returns), so a name is never suffixed. A name of a
worker on the floor is never taken; only if the floor has more workers than the list has names does a newcomer get a
two-word name of two list entries (`"Pixel Mochi"`). A worker sent home on purpose (`worker.fire`, a wrap-up's send
home) will not return, so its name is **free at once**, with no hold; closing a pane, a crash, a restart or sleep keep
the hold. Workers named before this (`"Pixel 2"`) keep their stored name for as long as they live; none is handed out
again.

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
| `worker.removed` | `id`, `session`, `workspace_id`, `reason`? | the workspace closed, the session was deleted, or the identity changed. `reason` is `"sent_home"` when the removal comes from `worker.fire` or a wrap-up's CLEAN (#83; the game plays the walk-out); absent otherwise. |
| `worker.usage` | `id`, `session`, `usage` | the worker's `usage` changed; at most once per 5 s per worker (see [Usage and cost](#usage-and-cost)) |
| `whiteboard.updated` | `floor`, `version`, `author`, `at`, `render_version`, `render`, `stale`, `stale_pins` | M13: a floor's whiteboard has a new version (a save, a clear, an agent's pin; flat in the event, see [Whiteboard](#whiteboard)) |
| `limits.update` | `provider`, `plan`, `windows`, `at`, `stale`, `error`?, `source`?, `reached`?, `credits`? | a provider's plan limits were read (flat in the event, see [Plan limits](#plan-limits)); one per provider per read, about every 2 minutes while a client is connected |
| `ai.update` | `classifier`, `llm`, `last_error`? | #92: the AI integration's state changed (a role saved or cleared, a test passed or failed, a key rejected); the whole state, flat in the event (see [AI integration](#ai-integration)) |
| `followups.update` | `enabled`, `threshold`, `state`, `missing`?, `roles`, `env`, `tested` | #90: the follow-up questions' state changed (a setting, a passing test, a model's state); the whole state, flat in the event (see [Follow-up questions](#follow-up-questions)) |
| `inbox.dismissed` | `id`, `status_since` | #106: a finished worker's inbox row was dismissed, by any client (see [Inbox](#inbox)); sent to every client, only when the dismissal is new |
| `packup.update` | `enabled`, `threshold`, `state`, `missing`?, `roles`, `env`, `tested` | #110: pack up on request's state changed (a setting, a passing test, a model's state); the whole state, flat in the event, the follow-up questions' fields: decode it by its `t` (see [Pack up on request](#pack-up-on-request)) |
| `worker.activity` | `id`, `session`, `workspace_id`, `activity`? | #98: the worker's `activity` changed (absent: cleared); only on a change, at most twice a second per worker. A change that comes with a status change is in that `worker.upsert` instead (see [Activity](#activity)) |
| `activity.update` | `model_enabled`, `threshold`, `margin`, `daily_cap`, `calls_today`, `cache_size`, `state`, `classifier`, `env` | #98: "Classify unknown commands"' state changed (a setting, a call counted, the classifier's state); the whole state, flat in the event. Its `classifier` is a role's state (a string), not `ai.update`'s object: decode it by its `t` (see [Activity](#activity)) |
| `digest.update` | `enabled`, `state`, `missing`?, `roles`, `env`, `tested`, `daily_cap`, `calls_today`, `reasoning_effort`, `max_tokens`, `reasoning`, `effort_stale` | #118: the floor overview summaries' state changed (a setting, a call counted, a passing test, the LLM's state); the whole state, flat in the event. Its `roles` has `llm` only: decode it by its `t` (see [Floor overview summaries](#floor-overview-summaries)) |
| `preset.upsert` | `preset` | a team preset was created, renamed or its roles changed (full object) |
| `preset.removed` | `id` | a team preset was deleted (floors whose `last_preset` it was get a `floor.upsert` next) |
| `screen.state` | `sharing`, `surface`? | M13: whether a connected game shares its screen changed, or what kind of surface the latest sharer shares (flat, see [Screen share](#screen-share)) |
| `codex_server.update` | `enabled`, `available` | #155: the shared Codex server switch changed (flat in the event, see [Shared Codex server](#shared-codex-server)) |
| `kaneo.update` | the fields of the Kaneo state | #184: the Kaneo connection changed (saved, cleared, paused by a refused key, resumed); flat in the event, never a key (see [Kaneo](#kaneo)). Like `packup.update`, decode it by its `t`: its `state` and `last_error` are not `ai.update`'s |

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

`terminal.frame`, `terminal.state` and `terminal.closed` ([Laptop screens](#laptop-screens)) are not events: they go only to the
connection that watches, have no `seq`, are not in the replay ring and are never replayed. Neither are M13's
`screen.frame_request` and `screen.grabbed` ([Screen share](#screen-share)): they go only to the sharing game.

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
| `worker.wrapup` | `{"id": string, "prompt": string, "worktree"?: "keep" \| "delete" \| "delete_branch"}` (default `keep`) | `{"queued"?: true}` | the worker's upsert with `wrapup` `armed` (before the ack); later, on CLEAN, `worker.removed` with `reason: "sent_home"` (see [Wrap up](#wrap-up)) |
| `worker.wrapup.cancel` | `{"id": string}` | — | the worker's upsert without `wrapup` |
| `worker.changes` | `{"id": string}` | the worker's git changes, `{"cwd", "branch", "head", "upstream", "ahead", "behind", "base", "files", "stat", "diff", "diff_bytes", "truncated", "omitted"}` (see [Changes](#changes)) | — |
| `worker.commands` | `{"id": string}` | #136: the slash commands and skills of the worker's harness in its checkout, `{"commands": [{"name", "description", "argument_hint", "kind"}…], "partial": bool}` (see [Commands and skills](#commands-and-skills)) | — |
| `worker.files` | `{"id": string, "query": string, "limit"?: 1–100}` (default 30) | #137: the files and directories of the worker's checkout ranked against `query`, `{"files": [{"path", "kind", "indices"}…], "source", "reason"}` (see [Files](#files)) | — |
| `terminal.watch` | `{"id": string, "fps"?: 1–30, "cols"?: 40–300, "rows"?: 10–100, "fullscreen"?: bool}` | `{"pane", "cols", "rows", "zoom"?}` | `terminal.frame`s to this connection only; with `fullscreen` (true or false), also `terminal.state` (see [Fullscreen](#fullscreen-74)) |
| `terminal.unwatch` | `{"id": string}` | — | — |
| `terminal.zoom` | `{"id": string, "on": bool}` | `{"pane", "cols", "rows", "zoom"}` | a `terminal.state` and, if the size changed, a full `terminal.frame` (see [Fullscreen](#fullscreen-74)) |
| `worker.keys` | `{"id": string, "input": [{"text": string} \| {"key": string}…]}` | — | — (see [Input](#input)) |
| `worker.prompt` | `{"id": string, "text": string}` | `{"queued": bool, "retried": bool, "sent"?: string, "terminal"?: true}` | the worker's statuses |
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
| `ai.get` | `{}` | the AI state (see [AI integration](#ai-integration)) | — |
| `ai.models` | `{"role", "key"?, "base_url"?}` | `{"models": [{"id", "description"?}], "base_url"?}` | — |
| `ai.test` | `{"role", "key"?, "base_url"?, "model"?, "extra_body"?}` | `{"ok": true, "latency_ms", "json_mode"?, "base_url"?, "score"?}` | `ai.update` when it changes the role in use |
| `ai.set` | `{"role", "key"?, "base_url"?, "model"?, "extra_body"?}` | the AI state | `ai.update` |
| `ai.clear` | `{"role"}` | the AI state | `ai.update` |
| `kaneo.get` | `{}` | the Kaneo state | — |
| `kaneo.test` | `{"url"?, "key"?}` | `{"ok": true, "latency_ms", "url", "api_base", "web_origin", "workspaces": [{id, name, slug?}], "user"?}` | `kaneo.update` when it ends a pause |
| `kaneo.set` | `{"url"?, "key"?, "default_workspace"?: string \| null}` | the Kaneo state | `kaneo.update` |
| `kaneo.clear` | `{}` | the Kaneo state | `kaneo.update` |
| `kaneo.workspaces` | `{}` | `{"workspaces", "generation"}` | — |
| `kaneo.projects` | `{"workspace_id"}` | `{"workspace_id", "projects": [{id, workspace_id, name, slug?}], "generation"}` | — |
| `followups.get` | `{}` | the follow-up questions' state (see [Follow-up questions](#follow-up-questions)) | — |
| `followups.set` | `{"enabled"?: bool, "threshold"?: 0.05–0.99}` | the follow-up questions' state | `followups.update` (before the ack) |
| `followups.test` | `{"threshold"?: 0.05–0.99}` | `{"ok", "reason"?, "threshold", "samples": [{"name", "expect", "score", "flagged", "questions"?, "source"?, "error"?}], "latency_ms"}` | `followups.update` when it changes `tested` |
| `packup.get` | `{}` | pack up on request's state (see [Pack up on request](#pack-up-on-request)) | — |
| `packup.set` | `{"enabled"?: bool, "threshold"?: 0.05–0.99}` | its state | `packup.update` (before the ack) |
| `packup.test` | `{"threshold"?: 0.05–0.99}` | `{"ok", "reason"?, "threshold", "samples": [{"text", "expect", "core"?, "score", "matched", "task"?, "want_task"?, "right", "error"?}], "right", "total", "latency_ms"}` | `packup.update` when it changes `tested` |
| `packup.detect` | `{"id", "text"}` | `{"matched", "task"?, "removed"?: [{"start", "end"}], "score"}`; `matched` false: send `text` as written | — |
| `worker.answer_followup` | `{"id", "turn_id", "answers": [{"id", "value", "note"?}…]}` | `worker.prompt`'s | the worker's upsert without its `followup` |
| `worker.dismiss_followup` | `{"id", "turn_id"}` | — | the worker's upsert without its `followup` (before the ack) |
| `inbox.dismiss` | `{"id", "status_since"}` | `{"dismissed": bool}` (see [Inbox](#inbox)) | `inbox.dismissed` (before the ack) when the dismissal is new |
| `activity.get` | `{}` | "Classify unknown commands"' state (see [Activity](#activity)) | — |
| `activity.set` | `{"model_enabled"?: bool, "threshold"?: 0.05–0.99, "margin"?: 0–0.9, "daily_cap"?: 1–100000}` | its state | `activity.update` (before the ack) |
| `codex_server.get` | `{}` | `{"enabled", "available"}`, the shared Codex server switch (see [Shared Codex server](#shared-codex-server)) | — |
| `codex_server.set` | `{"enabled": bool}` | the switch; switching on without `available` is `unsupported` | `codex_server.update` (before the ack) when it changes |
| `digest.get` | `{}` | the floor overview summaries' state (see [Floor overview summaries](#floor-overview-summaries)); it reads the LLM model's reasoning from its catalog when that was not read lately (#174) | — |
| `digest.set` | `{"enabled"?: bool, "daily_cap"?: 1–10000, "reasoning_effort"?: string, "max_tokens"?: 64–16384}` | its state; `reasoning_effort` `""` is the provider's default, else one the model's catalog lists (`bad_request` otherwise) (#174) | `digest.update` (before the ack) |
| `digest.test` | `{}` | `{"ok", "reason"?, "samples": [{"kind": "task"\|"now", "line"?, "error"?, "diag"?}], "latency_ms"}` (`diag`: the call's sanitized [diagnostics](#floor-overview-summaries)) | `digest.update` when it changes `tested` |
| `digest.retry` | `{"id"?: worker id}` | `{"retried": n}`: the failed lines of that worker (every worker without an id) are due again, their attempts counted anew; `incomplete` while the feature is off or the LLM not ready; `unknown_worker` (#174) | `worker.upsert` of the workers whose line status changed |
| `whiteboard.get` | `{"floor"}` | the board's state, `{"floor", "version", "author", "at", "render_version", "render", "stale", "stale_pins"}` (its content is HTTP, see [Whiteboard](#whiteboard)) | — |
| `whiteboard.clear` | `{"floor", "confirm": true, "author"?}` | the new state | `whiteboard.updated` |
| `whiteboard.pin` | `{"floor", "author", "note", "request_id"?}` (an image: `POST /whiteboard/{floor}/pin`) | the new state plus `{"elements": [id…], "repeated"?}` | `whiteboard.updated` (none for a repeated `request_id`) |
| `drops.list` | `{"limit"?: 1–50}` (default 20) | `{"drops": [{"path", "name", "size", "mtime", "mime", "image", "reason"?}…]}` | — |
| `board.watch` | `{"session"}` | `{"enabled": bool, "reason"?}`, then `board.issues` and `board.prs` to this connection (see [Boards](#boards-issues-and-pull-requests)) | — |
| `board.unwatch` | `{"session"}` | — | — |
| `board.refresh` | `{"session"}` | `{"queued": bool}` | the boards of the poll, to the watchers |
| `issue.get` | `{"session", "id"}` | `{"card", "body", "author", "created_at", "comments", "comments_truncated"}` | — |
| `issue.comment` | `{"session", "id", "body"}` | `{"comment"}` | boards after the refresh |
| `issue.close` | `{"session", "id", "reason", "confirm": true}` | — | boards after the refresh |
| `issue.set_status` | `{"session", "id", "column", "after"?}` (`after`: null or a card id, with the `order` capability) | — | boards after the refresh |
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

#51, #13, #64. An image for an agent's prompt (a screenshot pasted into any field that prompts an agent: the hire
dialog's first task, the Start Run dialog's Extra instructions and First prompt, the transcript view's prompt box, the
desk's prompt overlay (P) and a paste at a laptop's terminal) is stored by **Drop Zone**, a small upload service that runs beside the bridge on the server, and the agent gets its path. Like the
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

#### Markers in prompts (#64)

Every prompt that can carry an image carries it as `[Image #n: <path>]` **inside its text**, after `POST /upload`
answered; there is no image field on any command. `n` counts the images in the document in order (1, 2, …), whatever
order the uploads finished in. The bridge never reads a marker: it passes the text on byte for byte, counts it against
the cap of the field like any other characters, and refuses only what it refuses in any text (a NUL byte). The
paths are the game's to check before it sends (absolute, no `]`, no line break or control character: the same grammar
the transcript reads back into an image, `[Image #\d+: [^\]\n]+]`); the bridge does not repeat that check, so a
client must not put a path in a marker that did not come from `POST /upload`. The Go tests
(`internal/server/imagemarker_test.go`) pin each row:

| command | field | cap (bytes, markers included) | sent |
|---|---|---|---|
| `worker.hire` | `prompt` | 32 KiB (`herdr.MaxPrompt`) | the hire dialog's first task |
| `worker.prompt` | `text` | 16 KiB (`herdr.MaxMessage`) | the P overlay, the transcript view's prompt box, a paste at a laptop's terminal (an agent only: a plain shell answers `invalid_state`, so the game says an image cannot be pasted there before it uploads anything) |
| `run.prepare`, `run.start` | `extra` | 8 KiB (`maxRunExtra`) | Start Run's Extra instructions; the bridge folds it, trimmed, into the orchestrator's first prompt, so `run.prepare`'s `prompt` shows the markers |
| `run.start` | `prompt` | 32 KiB (the hire's) | an edited First prompt, as it is; never sent when not edited (the bridge composes it) |

An image is uploaded as soon as it is pasted (a chip shows the progress), under a label per surface so files from
different prompts tell apart: `hire`, `prompt-<worker>` (P), `transcript-<worker>`, `terminal-<worker>`, `run-extra`,
`run-prompt`, i.e. `h3d-<label>-<n>` with the bridge's cleaning (`n` is the image's sequence in that draft). A prompt
with an image that is still uploading waits for it; one with an image that failed (`upload_too_large`,
`upload_unsupported`, `upload_busy`, `dropzone_unavailable`, or refused in the game before any upload: over 25 MiB, not
a PNG, JPEG, GIF or WebP) is **not sent at all**, and the field says which image and why. A file refused in the game never becomes a chip, so the fields that prompt an agent (P, Start Run, the transcript box) hold the refusal as a message with a dismiss button and send nothing while it is up; the user's dismissal is what lets the prompt go, without that file (the hire dialog lists the file in its notice and sends the rest; the terminal paste pre-checks every file and sends none of them).

### Screen share

M13 (#15). The TV on every floor shows the Mac's shared screen, and an agent can look at it once when asked to ("look
at my screen"; the office CLI of M14, #16). **The share stays on the Mac**: the game plays it on the TV from the
capture's own `<video>`; nothing of it leaves the browser except one JPEG per `screen.grab`, sent only in answer to the
bridge's request for that grab, while the game shows a red LIVE badge. A grab is refused while nothing is shared, every
grab is audited, and the game shows who looked.

**Sharing** (the game). "Share screen" in the top bar calls `getDisplayMedia` from the click (a user activation is
required; localhost is a secure context), so Chrome's own picker offers a Chrome tab, a window or an entire screen, as
in Google Meet: `selfBrowserSurface: "exclude"` (the game's own tab is not offered), `surfaceSwitching: "include"`
("Share this tab instead" works while sharing), `monitorTypeSurfaces: "include"`, `preferCurrentTab: false`, no audio,
the video bounded to at most 1920 × 1080 at 15 fps (30 at most), and a fresh `CaptureController` set to
`no-focus-change` where Chrome has one (the focus stays on the game). While sharing the top bar has a red **LIVE** tape,
what is shared (`a tab`, `a window`, `your screen`, from the track's `displaySurface`) and **Stop**, which stops every
track. Chrome's own "Stop sharing" bar, a source that closes and Stop all end the share the same way; a cancelled
picker does nothing. A refusal by macOS (`NotAllowedError` with Chrome's "by system" message, or one that comes back
faster than the picker can be seen) says where to allow Chrome: System Settings → Privacy & Security → Screen & System
Audio Recording (Screen Recording on older macOS). A muted track (the source is unavailable for now) shows "Paused" on
the TV and refuses frames; a resize or a switched surface is followed (the TV's texture is remade at the new size).
The TV shows the share letterboxed on its screen, unlit and not tone mapped, on the WebGPU backend and the WebGL2
fallback alike.

**Commands**

| `t` | args | ack `data` |
|---|---|---|
| `screen.share` | `sharing` (bool), `surface`? (`browser` \| `window` \| `monitor`, while sharing) | none. The game sends it after **every** (re)connect, sharing or not (that makes its connection a game, one a grab can ask: a connection that never sent it, a CLI's, is not), and again on every change. Audited. |
| `screen.grab` | `floor` (a session the bridge knows), `requester` (the worker's name the toast shows: 1–64 bytes of UTF-8, no control or format characters, no U+FFFD, no leading or trailing space) | `{"path","bytes","w","h","surface"?,"at","expires"}`: the stored JPEG (`at`, `expires` in unix ms). Errors above, plus `bad_request`, `unknown_session`, `busy` (four grabs already wait), `internal` (no frame directory) |
| `screen.frame` | `req_id` (of a `screen.frame_request` this connection was sent), `error` (a short code: `not_sharing`, `unavailable`, `stopped`, `encode_failed`, `upload_failed`), `message`? | none; the grab fails at once with `frame_unavailable` and the message (control characters removed, at most 200 bytes). `not_found` for a request that is not this connection's or no longer waits |

**A grab, step by step**

1. `screen.grab` on any connection (M14's CLI: `herdr-world cmd screen.grab '{"floor":"herdr-3d","requester":"Nibble"}'`,
   or in Go `(*proto.Conn).ScreenGrab`, or in-process `(*server.Hub).GrabScreen`). No game connected: `no_client`; a
   game that shares nothing: `not_sharing`.
2. The bridge sends the game that started sharing last a `{"t":"screen.frame_request","req_id":"<32 hex>"}` (128
   random bits; on that connection only, no `seq`).
3. The game draws the video's current frame to a canvas at most 1920 px wide and 4096 tall (aspect kept, never
   upscaled) and encodes a JPEG at quality 0.8. A request belongs to the capture that is live when it arrives: one
   that is still waiting when that capture ends (Stop, then perhaps a new Share of another source) is dropped, never
   encoded or uploaded, and a Stop during an encode sends nothing. It answers requests one at a time, and `POST`s the bytes to `/screen/frame/<req_id>`
   (beside `/ws`, with its token, through the helper; `Content-Type: image/jpeg`). When it has no frame it answers
   `screen.frame` instead.
4. The bridge accepts the body only while a grab waits for that id. It checks the JPEG magic bytes, at most 8 MiB on the
   bytes that arrive, at most 1920 × 4096 pixels from the header, then decodes it fully; a refusal fails the grab at
   once with the same code (`frame_invalid` `422`, `frame_too_large` `413`; `not_found` `404` for an id nobody waits
   for, `bad_request` `400` for a malformed one). `200` `{"t":"ack","data":{"bytes","w","h"}}`.
5. The JPEG goes to `<screen dir>/frame-<unix ms>-<req_id>.jpg` (`0600`, written to a temporary name and renamed),
   the grab's audit row is written (`screen.grab`, the caller's client name, `floor`, `requester`, `bytes`, `w`, `h`,
   `surface`; also for every refusal), the game is sent `{"t":"screen.grabbed","requester","floor","at"}` and shows "<requester>
   looked at your screen", and the ack carries the path.

The whole grab has **5 s** (`server.DefaultScreenTimeout`; the target round trip is under 2 s): after that it is
`frame_timeout` and a late frame is refused. The bridge ends a request after those 5 s even when its caller has stopped
waiting (an in-process `GrabScreen` whose context ended), and a grab cancelled before its request was registered asks
the game nothing, so an abandoned grab never holds one of the 4 slots. The game disconnecting fails its waiting grabs at once with `no_client`,
stopping the share with `not_sharing`. A `screen.share {sharing:false}` or a disconnect also ends `screen.state`'s
`sharing` when no other game shares.

**Storage.** The screen directory is `$XDG_RUNTIME_DIR/herdr-world/screen` (tmpfs; `--screen-dir` /
`HERDR_WORLD_SCREEN_DIR` to override), created `0700` and refused if it is not a directory owned by the bridge's user
(a symlink included). Without `XDG_RUNTIME_DIR` the bridge uses `/run/user/<uid>/herdr-world/screen` when that runtime
directory exists, and says so in its log; with neither, it starts anyway and every grab is `internal` with "no runtime
directory for screen frames: set XDG_RUNTIME_DIR or --screen-dir" (frames never go to a disk-backed `/tmp`). A frame
lives **10 minutes**: a janitor removes expired ones every 30 s, and the bridge removes them (and any half-written
temporary file) when it starts.

**Manual check on a Mac** (the picker, macOS and Chrome's own UI cannot run in CI; the e2e test replaces
`getDisplayMedia` by a canvas stream): open the game in the helper's `--app` window with another normal Chrome window
of two tabs open, press Share screen, and check the picker offers Chrome Tab (the other tabs, not the game's), Window
and Entire Screen; share a tab and use "Share this tab instead"; the focus stays on the game; the LIVE badge names what
is shared; Chrome's "Stop sharing" bar and the top bar's Stop both end it; minimise and restore a shared window (the TV
shows Paused, or keeps the last frame where macOS does not mute it); turn off Chrome in System Settings → Privacy &
Security → Screen & System Audio Recording and check the message, then turn it on again; run `herdr-world cmd
screen.grab '{"floor":"<a floor>","requester":"Nibble"}'` on the server and check the toast, the path, the picture, the
audit row (`sqlite3 world.db "select * from audit_log where cmd = 'screen.grab'"`) and that the file is gone 10 minutes
later; with `?backend=webgl2` and without, check the TV's colours and letterboxing, and a portrait and a Retina source.

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
| `tracker` | `"github"` \| `"kaneo"` | #184: the floor's issue tracker; `null` and `"github"` are GitHub, which every floor from before is (absent in `settings`). `"kaneo"` needs a `kaneo` link (stored or in the same call) |
| `kaneo` | `{"workspace_id", "project_id"}` | #184: ids 1–200 bytes; the bridge asks Kaneo (the saved connection: `not_configured` without one) that the project is a live project of that workspace before it saves (`not_found`: deleted or invisible to the key; `bad_request`: another workspace's, or archived; `unauthorized`, `forbidden`, `unreachable`, `timeout` as Kaneo answered). Settings show it as `{"workspace_id", "workspace_name"?, "project_id", "project_name"?}` (the names as they were at the save) |

Objects must not have other keys. Settings live in SQLite `floor_repo`.

#184: the issue tracker and the repository are chosen apart. A Kaneo floor's `repo` stays its code (checkouts, pull
requests); its issues come from the Kaneo project. The inactive tracker's settings are kept: a Kaneo floor keeps its
`project` and `status_field`, and a floor switched back to GitHub keeps its `kaneo` link (`settings.kaneo` without
`tracker`), so switching back finds them. A save that stores a new link, or switches to Kaneo, is checked with Kaneo off
the bridge's main loop (the ack follows the check; it is `stale` when, meanwhile, the floor's tracker or Kaneo link
changed (another save landed first: an older save never undoes a newer one) or the Kaneo connection did (another
instance or key saved, or cleared: the project was checked with the old one); a save of the floor's other settings
meanwhile does not make it stale); one that does not touch the link asks Kaneo nothing. The bridge's default workspace is only a prefill: a
saved floor keeps its own `(workspace_id, project_id)` whatever the default becomes.

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
| `capacity` | workers on this floor (`floor.count`, hires in flight included; a repository's idle main checkout is not a worker, see "Hidden main checkouts") and on every running floor the bridge watches (`host.count`), with the configured caps (`--warn-workers-per-floor` / `--max-workers-per-floor`, `--warn-workers` / `--max-workers`). A hire that would reach above `hard` is refused (`capacity`); above `soft` the dialog should warn. `load` is the host's 1-minute load average, CPU count and memory in use (`/proc`); absent when unreadable. |

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
| `prompt` | optional first task, 1–32768 bytes of UTF-8 without NUL, not starting with `--` (herdr's CLI would read it as a flag). Sent once the agent is ready. For Claude it is typed (#95, step 5): no control characters but line ends (`\r\n` and `\r` go as `\n`) and tabs (four spaces each), at most 32768 bytes as typed, else `bad_request`. The game sends pasted images as `[Image #n: <absolute path>]` markers in the text, after uploading them (`POST /upload`, above). |
| `handoff`, `stop_services` | reserved (M9, #14); refused like any unknown field |

Capacity: a hire that would put the floor above `--max-workers-per-floor` or the host above `--max-workers` is
`capacity` (the `message` says which). A worktree hire needs room for **one** worker, like any hire: the main
checkout herdr may open with it (step 1) is not a worker. Then, in order (each step bounded; the whole hire usually takes 4–10 s):

1. **Worktree hires**: `git fetch origin` in the repository. If it fails, the hire is refused with `fetch_failed`
   (the `message` is git's error) and nothing is made: a branch from the last fetched, possibly stale
   `origin/<default>` would revert what was merged since. Then `herdr worktree create --cwd <repo_root> --branch h3d/<name>-<id6> --base origin/<default> --label <label>
   --no-focus`. `<name>` is the worker's name lower-cased with every run of other characters as `-`, `<id6>` the first 6
   hex of its id. The base is always the freshly fetched `origin/<default>`, **never the local `HEAD`** (a stale local
   `HEAD` makes every new branch revert what was merged since; agent-office #119). herdr puts the checkout at
   `~/.herdr/worktrees/<repo>/<branch with / as ->`. The branch is recorded in SQLite (table `hire_branch`: worker id,
   repository, branch, the base commit it was made from): only a branch recorded for a worker is ever deleted, by that
   worker's send home or by its hire's rollback. When no workspace of the repository's main checkout is open on the
   floor, herdr opens one too (its worktree group needs it, and it holds only a shell): the bridge does not report it
   as a worker while it has no agent (below). Plain hires: `herdr workspace create --cwd <cwd> --label <label> --no-focus`.
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
5. The optional `prompt`. **Claude** (#95): typed, never pasted. `agent prompt` sends a bracketed paste, which Claude
   Code wraps in `<pasted_content>` and tells the model may hold instructions the user did not write (a hired
   orchestrator asked to confirm its run), and a slash command in a paste is never run. Once herdr sees the agent
   `idle` or `done` (within the trust timeout, 10 s; text typed before its input box is up is lost), the bridge types
   the prompt on the worker's input lane (no laptop key lands in between): normalized (`\r\n` and `\r` as `\n`, a
   tab as four spaces), in chunks of at most 700 characters, one `herdr pane send-text <pane> <chunk>` each, 50 ms
   apart (Claude Code v2.1.287 takes an input burst of more than 800 characters as a paste), then `herdr pane
   send-keys <pane> enter`. A typed line end is a new line in Claude's input, not Enter. It then waits up to 5 s for
   the worker to start (`working` or `blocked`); an agent just past its trust dialog can drop that Enter, so the bridge
   presses `Enter` (up to 3 times) until it does. A prompt of 32 KiB takes about 2.5 s to type. Typing that fails
   part way is erased from Claude's input box (`ctrl+u backspace` pairs, as for `worker.prompt`). **Codex**: `herdr
   agent prompt <pane> <prompt> --wait --until working --until blocked --timeout 8000`, retried while herdr says the
   agent is not ready; when it took the text but dropped the Enter (herdr: `agent_prompt_stalled`) the bridge presses
   `Enter` (up to 3 times) until the worker is working. A prompt that fails does not undo the hire: the ack has
   `prompted: false` and `prompt_error`.
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
| `can_fire`, `fire_blocked` | `false` (and why) when herdr would refuse to close the workspace: a repository's main checkout with an agent in it whose linked worktree workspaces are still open on the floor (herdr's `workspace_group_close_required`; send those home first). The bridge never closes a group. (An agentless main checkout is not a worker while worktrees are open, so there is nothing to send home: below.) |

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
   `Ctrl-C`s; a shared Codex worker, #155, gets none unless its own server is already gone, #158); `released` says whether the agent left by itself. **The workspace is closed only once the agent is
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
   Then, for a worker the bridge hired into a linked worktree (it has a `hire_branch` record, whichever cleanup was
   chosen): when no linked worktree workspace of that repository is open on the floor any more, the repository's main
   checkout workspace herdr opened for it, if it is still idle (below), is closed with `herdr workspace close
   <workspace>`. This is best effort: a failure is logged and noted in the audit row, never fails the send home, and
   the workspace then shows as a worker (nothing hides it any more). A workspace with an agent is never closed.
   No group close is involved: the last linked worktree is gone by then, which is what herdr's
   `workspace_group_close_required` waits for.
5. The audit row is completed with each step (exit keys, released or not, the git state, the cleanup choice and
   outcome) and the ack sent. A failure is `fire_failed` with what went wrong.

`handoff` (M9) and `stop_services` (#14) are reserved `worker.fire` arguments; today they are refused like any unknown
field.

#### Wrap up

#83. **`worker.wrapup`** gives a worker's agent one last cleanup prompt and sends the worker home **once the agent
reports, in its transcript, that it is clean**. The agent only decides whether the send home goes ahead; the teardown
is `worker.fire`'s, step by step, with the worktree choice made up front.

```json
{"t":"worker.wrapup","req_id":"42","args":{"id":"a58752ea-…","prompt":"Stop every server, background process, pane and freelancer you started in this session. Don't touch anything else.","worktree":"delete"}}
{"t":"worker.upsert","seq":1310,"worker":{"id":"a58752ea-…",…,"wrapup":{"state":"armed","worktree":"delete","armed_at":1790859600000}}}
{"t":"ack","req_id":"42","data":{}}
```

1. **Arm.** Checked like `worker.fire` (`worktree` as there; the floor running, no hire or send home of it in flight,
   not a main checkout whose worktrees are open), plus: the worker runs a Claude or Codex agent whose transcript the
   bridge reads (`--claude-projects` / `--codex-sessions`; else `invalid_state`, or `internal` when this bridge reads
   none), it is not blocked and has no `ask` (`invalid_state`), and it is not armed already (`busy`; one that needs you
   may be armed again). For `delete` / `delete_branch` the tree must be clean and pushed now, as `worker.fire.prepare`
   reports it (`not_clean`, nothing sent). `prompt` is 1 byte to 16 KiB minus the footer, without NUL, and for Claude
   (typed, #95) with no control characters but line ends and tabs (`bad_request`).
   Then a fresh nonce (16 hex digits) is made, the transcript offset the bridge reads from is taken (where its tail
   of that transcript is now, within about 2 s), and `{worker, nonce, worktree, armed_at, transcript, offset}` is
   stored (SQLite `worker_wrapup`), so a restart resumes the watch.
2. **Prompt.** `prompt` + a blank line + the footer, through the worker's input lane like `worker.prompt` (queued for
   an agent at work: `queued`; a failed prompt disarms and fails the command as `worker.prompt` would). The footer,
   exactly:
   ```
   When you are done, end your final message with exactly one line:
   H3D-WRAPUP <nonce> CLEAN
   or, if the task did not complete, anything could not be stopped or needs a decision:
   H3D-WRAPUP <nonce> BLOCKED: <one-line reason>
   ```
   Clients never see the nonce or the footer.
3. **Watch.** The bridge reads the transcript from the offset (the same tail as usage and `ask`), only after the
   bridge's prompt (the first user prompt from the offset that ends with the nonce's footer; an earlier turn never
   counts, and every later user prompt is a person's, even one quoting the marker), and only the **last non-empty line
   of the final assistant message of a turn**, matched strictly against the line as it is (only a trailing `\r`
   dropped): `^H3D-WRAPUP <nonce> (CLEAN|BLOCKED: .{1,200})$`. Leading or trailing whitespace, quotes, backticks, list
   markers, an indented code block or a code fence still open make it no result, as does the same marker anywhere else
   in that message. A fence is read as CommonMark reads one: only a run of its own character (backticks or tildes), at
   least as long, indented at most 3 spaces and with nothing after it closes it, so four backticks are not closed by
   three, nor backticks by tildes; a top-level fence closes at any indent up to 3, whatever its opener's. Lists are not
   parsed: the fences are read as top-level ones and again with list items in mind (a fence opened at or past the
   content indent of a list marker line before it closes only at the opener's own indent, and any line left of that
   indent before its close leaves it open), and still open either way is no result. A
   Claude turn ends with an assistant message whose `stop_reason` is not `tool_use` (or `system/turn_duration`), a Codex
   one with `task_complete`.
4. **Decide**, once the turn ended in the transcript, no line came since and herdr has said `idle` (or `done`), each for
   `WrapUpDebounce` (2 s), with no `ask`:

   | Seen | What follows |
   |---|---|
   | `CLEAN` | The tree is checked again (clean and pushed, for a delete). Still fine: `worker.fire`'s steps with the armed choice, strict (below), audited as a `worker.fire` row whose `result` has `"wrapup": {"nonce", "verdict": "clean"}`; then `worker.removed` with `reason: "sent_home"`. Not fine, or the send home fails: `needs_you` with why, nothing removed. |
   | `BLOCKED: <reason>` | `needs_you` with the agent's reason. Nothing is touched. |
   | no result line, a malformed one, a wrong nonce, two markers | `needs_you`, `"did not report a wrap-up result"`. |
   | herdr says `blocked`, or the worker has an `ask` | keep waiting: the question shows as ever. |
   | a person prompts or types into the worker (`worker.prompt`, `worker.keys`; or a prompt or interruption typed in herdr, seen in the transcript after the bridge's), also after a `CLEAN` while its tree check runs, until the send home starts | disarmed, `wrapup` gone: the person took over; nothing is sent home. |
   | no result within `--wrapup-timeout` (30 min) | `needs_you`, `"no wrap-up result within 30m0s"`. |
   | the transcript is gone or replaced, or the agent session changed | `needs_you`, `"its transcript is gone, …"`. |
   | the worker closed in herdr, or sent home | the wrap-up is forgotten. |

   `needs_you` is disarmed for good: its nonce is dead, a later `CLEAN` does nothing, and a reply to the agent (a plain
   `worker.prompt`) leaves it as it is. Only a new `worker.wrapup` (the game's "Wrap up again", a short follow-up with
   a fresh nonce) can lead to a send home; **`worker.wrapup.cancel`** drops it (armed or needing you; `busy` once a
   CLEAN's send home started, `invalid_state` without one).
5. **Strict.** A wrap-up's send home deletes the worktree or leaves the worker at its desk, never half of it: when the
   tree changed while the agent exited (step 3 of `worker.fire`), `worker.fire` keeps the worktree and sends the worker
   home with a `note`; a wrap-up's fails instead (`not_clean`: nothing is closed or removed, the worker stays, with the
   agent exited) and needs you. So a worktree goes only through `herdr worktree remove` (never `--force`) after four
   clean-and-pushed checks: at the arm, after `CLEAN`, and `worker.fire`'s pair.
6. **Restart.** A stored wrap-up comes back with the bridge: an armed one is read again from its stored offset (the
   transcript is read from its start; lines before the offset never count), one needing you stays. A transcript that
   is gone then needs you; nothing is sent home without a verdict read after the restart.

A wrap-up only touches the worker it was armed on (an orchestrator's freelancers are its prompt's business, never
the bridge's), and the verdict only ever comes from the transcript: no command reports one.

**Audit log.** `hire.prepare` and `worker.fire.prepare` get one row each. `worker.hire` and `worker.fire` get a row when
they start, completed with their outcome and a JSON `result`: for a hire the worker id, workspace, desk, cwd, branch,
base, fetch, trust, the prompt outcome and any rollback; for a fire the git state it saw, how the agent exited, the
cleanup choice and what happened to the worktree and branch. #83: `worker.wrapup` gets one row for the arm (the prompt
by its length only; `result` the nonce, choice, transcript and offset), `worker.wrapup.cancel` one row, and a CLEAN's send
home its `worker.fire` row (client: whoever armed it).

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
{"t":"ack","req_id":"40","data":{"prompt":"/write-code https://github.com/JeffreyVdb/lab/issues/3\n\nTeam:\n- coders: claude claude-opus-5-5, effort medium\n- reviewers: codex gpt-6-sol, reasoning high\n- ux reviewers: codex gpt-6-sol, reasoning high\n- researchers: codex gpt-6-sol, reasoning low\n\nStart every agent you hire in its own herdr workspace or tab, never in a split pane of your tab or of another agent's tab: a laptop shows a pane at its own size, and a fullscreen terminal is wanted.\n\nMove the ticket status accordingly, pull request always means QA, merging the PR always means Done.",
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
| `ticket` | `{"kind":"issue","repo","number","url"}` or `{"kind":"text","text"}` (trimmed); #184: `{"kind":"item","url","item":{"provider","id","key","title","url"},"provider_name"}` for an item of a provider that numbers no GitHub issues (a Kaneo task) |
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

Start every agent you hire in its own herdr workspace or tab, never in a split pane of your tab or of another agent's tab: a laptop shows a pane at its own size, and a fullscreen terminal is wanted.

Move the ticket status accordingly, pull request always means QA, merging the PR always means Done.

<extra, trimmed>
```

The first line is `/write-code <ticket>` for a Claude orchestrator and `$write-code <ticket>` for a Codex one;
`<ticket>` is the issue URL, or the text. A role line says `effort <e>` for a claude role and `reasoning <e>` for a codex
one. The placement line (#74: a laptop shows a pane at its own size, so every agent goes in its own workspace or tab,
never in a split) is always there. The status line is there for an issue ticket only (the orchestrator then moves the issue's status:
a pull request means QA, its merge means Done); a free-text ticket has none. With no `extra`, the blank line before it is
left out too. (A pure function, `server.RunPrompt`.)

#184: an `item` ticket (a Kaneo task) is one an agent cannot read where it lives (no `gh`, and the integration key never
reaches an agent), so the prompt carries what the provider gave: `/write-code Kaneo task HRD-12: <title>`, the task's
URL on the next line, then its description (the first 6000 bytes, then "[The description goes on in Kaneo; this is its
first part.]"); in place of the status line, "This ticket is a Kaneo task, not a GitHub issue: everything the bridge
read of it is above. Don't look it up with gh, and leave its status on the Kaneo board to people." The label is
`ORCH|<key>` in lower case (`ORCH|hrd-12`). (`server.TicketPrompt`; the issue and text prompts are `RunPrompt`'s, byte for
byte.) The game's "Ask a worker…" on a Kaneo task likewise puts the title and the description in the first prompt.

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
as its first prompt (typed into Claude, pasted into Codex with `herdr agent prompt`; either way a multi-line prompt
arrives as one prompt, and Claude runs a leading `/write-code` as its slash command). When the hire
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
status columns, and its **pull requests**. #184: a floor whose `tracker` is `kaneo` has its issues board from its Kaneo
project (no repo needed) and the pull requests board only when it has a repo (GitHub's); see "Kaneo boards" below. They come from a provider behind two neutral interfaces (the bridge's
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
 "capabilities":{"comment":true,"close":true,"set_status":true,"order":true},
 "columns":[{"id":"49294ed0","name":"Todo","done":false},{"id":"ae6334b4","name":"Doing","done":false},
            {"id":"64e1b0ac","name":"QA","done":false},{"id":"ccf5765b","name":"Done","done":true}],
 "cards":[{"id":"JeffreyVdb/herdr-3d#9","key":"#9","title":"M7: Issues Kanban + Pull Requests board (GitHub)",
           "state":"open","column":"ae6334b4","url":"https://github.com/JeffreyVdb/herdr-3d/issues/9",
           "labels":[{"name":"bridge","color":"#1d76db"}],"priority":"high",
           "assignees":[{"name":"JeffreyVdb","avatar_url":"https://…"}],"author":"JeffreyVdb",
           "updated_at":1790670000000,"closed_at":null,"position":2}]}
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
| `error_code`, `paused_until` | #184, `board.issues` only, while `stale`: the failed poll's error code (`unauthorized`, `forbidden`, `rate_limited`, `provider_failed`, …), and, when the provider refused the key (`unauthorized`), when polling resumes (unix ms) |
| `truncated` | the provider hit its paging limit (500 open issues or pull requests, or a nested list past 100): the board is incomplete |
| `rate` | optional, `{remaining, reset_at}` (unix ms) of the provider's rate limit, to show "rate limit: next refresh 14:05" |
| `capabilities` | the board's; a card may carry its own `capabilities` that replace them (a closed issue: `close: false`). `comment`, `close`, `set_status`, and `order` (#52): `issue.set_status` can also place the card in its column, and the cards carry `position`. GitHub: `set_status` and `order` with a project, neither without one. |
| `columns` | in order. GitHub project: the Status field's options as they are now, `done: true` for the option named "Done" (ignoring case). No project: `open`, and `closed` (done). Issues with no status in the project go to a leading `{"id":"","name":"No status"}` column that is there only when it has cards. #184: a column may carry `kind`: `planned` or `archived`, a provider's virtual status rather than a workflow column (Kaneo's); archived is never done. GitHub never sets it. |
| card `state` | `open` \| `closed`; the cards are the open issues and the ones closed in the last 7 days (exact cut-off) of this repo |
| card `column` | a column `id` |
| card `labels` | `{name, color: "#rrggbb"}`, in the provider's order, priority labels included |
| card `priority` | optional `urgent` \| `high` \| `medium` \| `low` from the labels (ignoring case): `p0`, `critical`, `urgent` → urgent; `p1`, `high`; `p2`, `medium`; `p3`, `p4`, `low`; also as `priority: x`, `priority/x`, `priority-x`; the most urgent one wins |
| card `closed_at`, `updated_at` | unix ms, `closed_at` null while open. #184: `updated_at` `0` is unknown (Kaneo gives none) and `closed_at` stays null: a client shows no time and no "closed recently" from them |
| card `position` | optional (#52): the card's rank in the provider's own order, `0` first, across all columns; absent for a card that has none (GitHub: an issue that is not in the project). A column lists its cards by `position`, done columns too; the ones without one come after them (most urgent, then most recently updated; done columns: latest closed). A provider without an order sends none, and that old sort is the whole order. GitHub: the project's items in manual position order (`items(orderBy: POSITION)`, the order of an unsorted board view, which GitHub shares between all statuses), paged 100 at a time up to 500; a project with more items sends no position at all (never a partial order) and the board is `truncated`. Drafts, pull requests, items of other repositories and issues that are not on the board are skipped; the ranks are those of the cards. |
| PR `checks` | `success` \| `failure` \| `pending` \| `none` (no checks at all is `none`, never green) |
| PR `review` | `approved` \| `changes_requested` \| `review_required` \| `none` |
| PR `mergeable` | `mergeable` \| `conflicting` \| `unknown` |
| PR `closes` | ids of the issues it closes, in the issue id format (other repositories' issues too) |
| `merged` | the pull requests that were **open at the previous good poll and are merged now**, announced exactly once ever (SQLite, so across restarts too), never on `initial: true`; `[]` otherwise. The game rings the gong for each. |

**Polling.** A floor is polled every **60 s while at least one connection watches it**, every **10 min** otherwise (asleep
floors too). Floors linking the same repository and project share one fetch. `board.refresh` polls now, joins a poll in
flight, and starts at most one poll per 10 s per floor (else `queued: false` and the cache is sent to the caller again,
`initial: true`). After a successful write (`issue.comment`, `issue.close`, `issue.set_status`, `pr.comment`, `pr.merge`,
`worker.open_pr`), and after one that failed once part of it had landed (a move whose status was written but not its
place: `provider_failed`), the bridge queues a refresh of that floor; the boards follow the reply. A poll that was already in
flight when the write landed may have read the board from before it: it is dropped (never sent, never the cache) and
the refresh runs instead, so every non-initial `board.issues` a connection gets after a write's ack was polled after the
write (#52; the game relies on it to hold a dragged card in its new place). An `initial: true` replay can still be older. The cache is in SQLite
(`board_cache`, the open pull requests of the last good poll in `board_open_pr`, announced merges in
`board_merge_announced`): `board.watch` answers at once from it, also right after a restart.

**Rate limit.** Every poll reads the provider's rate (GitHub: `rateLimit { cost remaining resetAt }`, about 12 points a
poll; the project's first 100 items for `position` ride in the same query, measured at no extra point, and each further
page of 100 is a call of its own, about 1 point). Below what one more round of every board-enabled repository plus a reserve of 100 needs, only floors somebody
watches are polled; below 50 left, or after a rate-limit error, nothing is until `reset_at`; a secondary limit that names no
reset waits 60 s, then twice as long each time, up to 10 min. The messages carry `rate` and, after a failed poll, `stale`.

**Commands.** All of them are audited like the others; comment and pull request **bodies are never logged** (the row
keeps the target `id` and the byte counts). `session` is the floor. Bodies are 1–65 536 bytes of UTF-8 (a pull request's
body may be empty), titles 1–256 bytes, no control characters but `\n` and `\t` in a body; ids at most 200 bytes. A write
on a floor with no board (no repo, no provider) is `unsupported`.

| `t` | args | `ack.data` |
|---|---|---|
| `board.watch` | `{session}` | `{"enabled": bool, "reason"?}`: `enabled: false` with a `reason` (`"no repo linked"`, `"boards are not configured"`; #184, a Kaneo floor: `"Kaneo is not connected: connect it in Settings"`, `"no Kaneo project linked"`, `"this bridge has no Kaneo settings"`, `"this bridge cannot read Kaneo boards"`: no tracker could be made of the saved connection, e.g. it changed meanwhile; watch again) and no messages; else the messages follow (`board.prs` only with a code host) |
| `board.unwatch` | `{session}` | — |
| `board.refresh` | `{session}` | `{"queued": bool}`; `unsupported` on a floor with no board |
| `issue.get` | `{session, id}` | `{"card", "body": markdown, "author": {name, avatar_url}, "created_at", "comments": [{id, author, body, created_at}], "comments_truncated"}`: the first 100 comments; the body is raw markdown, **the client sanitises** |
| `issue.comment` | `{session, id, body}` | `{"comment": {id, author, body, created_at}}` |
| `issue.close` | `{session, id, reason: "completed" \| "not_planned" \| "duplicate", confirm: true}` | — |
| `issue.set_status` | `{session, id, column, after?}` (an issue not in the project is added to it first). `after` (#52, needs `order`): absent, the status only and the card keeps its place in the order; `null`, the top of the column; a card id (opaque, like `id`), right after that card. | — |
| `pr.get` | `{session, id}` | `{"pr", "body", "author", "created_at", "files": [{path, additions, deletions, change}], "files_truncated", "checks": [{name, state: success \| failure \| pending \| neutral \| skipped, url}], "comments", "comments_truncated"}` |
| `pr.comment` | `{session, id, body}` | `{"comment"}` |
| `pr.merge` | `{session, id, method: "merge" \| "squash" \| "rebase", confirm: true, override?, confirm_override?}` | `{"merged": true}` |
| `worker.open_pr.prepare` | `{id}` (worker id) | `{"can_open", "reason"?, "branch", "base", "ahead", "dirty", "existing"?: {id, key, url}, "title", "body"}`: the title is the latest commit's subject, the body the list of the commits' subjects |
| `worker.open_pr` | `{id, title, body, confirm: true}` | `{"pr": {id, key, url}, "pushed": bool, "existed": bool}` |

- **`issue.set_status` with `after`** (#52): the card lands at that place of the column; within its own column it is a
  reorder. `after` must be another card of the target column on the last board (or one a write since moved there),
  else `bad_request`; any `after` on a board or card without `order` is `unsupported`. GitHub writes the status only
  when it changes, then `updateProjectV2ItemPosition`, which knows only "after this item" in the project's one order:
  `after` a card is after its item; the top of a column is right after the item before the column's first card (none
  when that card is the project's first); an empty column is the top of the project. The two writes are not one
  transaction: when the place fails after the status changed, the error says so (`provider_failed`: "its status
  changed, but its place in the column did not"), and the bridge refreshes the board all the same (polls in flight are
dropped as after a successful write), so it shows what GitHub has. An anchor the provider no
  longer has in the project's order is `stale`. **Moving a card into a done column changes its status only: the issue
  stays open** (closing is `issue.close`), the same as without `after`.
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
  item of the floor's board (not on the last board, once one was read): `not_found`. #184: an item of a provider that
  numbers no GitHub issues (Kaneo) is read with the provider's `issue.get` (its key, title, URL and description) into an
  `item` ticket, and the launch keeps `{provider, id}` and the key (never a repo or a number); see [Team presets and
  starting a run](#team-presets-and-starting-a-run). A `run.start` whose item is still being read when the floor's
  board source changes (another tracker, Kaneo connection or project) starts nothing and is `stale`.

**Kaneo boards** (#184). A Kaneo floor's `board.issues` has `provider: "kaneo"`, `provider_name: "Kaneo"`, the
project's workflow columns in order (`done: true` for every final column: a task in one is `closed`, the one meaning
of completion) between a leading `planned` and a trailing `archived` column (`kind`, always present, also empty;
archived tasks are `open`), cards keyed `<project slug>-<number>` with the task's canonical page as `url`, priority,
labels and assignees, and `updated_at: 0`, `closed_at: null`, `author: ""`. Capabilities: `comment`, `set_status` and
`order`; never `close` (`issue.close` is `unsupported`: a task is done by moving it to a final column, and is never
deleted). A board read is bounded (pages of tasks and of their related metadata up to a budget): one that stopped early
is `truncated`, and a placed move (`after`) on it is `unsupported` (the status-only move works). A description the list
left out (over 64 KiB) is read by `issue.get`. `issue.set_status` with `after` sends Kaneo the board it read: a board
that changed since is `stale` (refresh, then move again). A poll that Kaneo refuses with a **401** (a bad or revoked key,
**or the key's request quota**) pauses every Kaneo floor's polling for 5 minutes (`paused_until`; `board.refresh` does
not poll meanwhile) and pauses the connection (`kaneo.update` `state: "paused"`); a passing `kaneo.test` of the saved
connection, or a new connection, resumes at once. A **403** is `forbidden` (a permission problem in Kaneo, not an
outage). A **429** is `rate_limited` and backs the Kaneo floors off (Kaneo names no reset: the secondary-limit back-off).
`issue.comment` on a Kaneo task is at most 10,000 UTF-16 code units (Kaneo's own limit; a longer one is `bad_request`
before anything is sent, under the bridge's 64 KiB cap for every provider). The fetch is named by the instance, the
connection's generation, the workspace, the project and the repo (never the key): a new key, instance, workspace or project drops the floor's board and its cache, and a poll that was in flight
for the old one is never shown. The pull request board of a Kaneo floor with a repo is GitHub's, on GitHub's rate limit
(its `rate` is GitHub's; the issues board's is absent, Kaneo sends none), and a failure of it (GitHub's limit, `gh`
refusing) is GitHub's: it never backs Kaneo off or pauses the connection.
- **Errors** (also in [Errors](#errors)): `confirmation_required`, `unsupported`, `provider_failed`, `rate_limited`,
  `checks_not_green`, `not_mergeable`, and `not_found` (an id that is not on this floor's provider), `stale`,
  `bad_request`, `unknown_session`, `unknown_worker`, `invalid_state`, `busy`.

**Audit log.** Each board command gets a row; the slow ones (everything that calls the provider) are begun when they start
and completed with a result: `issue.comment` / `pr.comment` the target id, the byte count and the comment id, `issue.close`
the reason, `issue.set_status` the column (and `after`, when it was set), `pr.merge` the method, the checks and mergeability it read, `override` and `gate`
when the override was needed, and `merged`, `worker.open_pr` the worker, the branch, the base, `pushed`, `pr` and
`existed`.

The bridge runs `gh` (flag `--gh`, env `HERDR_WORLD_GH`, default `gh` on `PATH`; its own login, no token stored) through
one typed shape, `gh api graphql --method POST --input -`, with a fixed set of embedded documents (never a query from a
client), 20 s per call, in a clean environment. Without `gh` the boards say `gh not found` and the write commands answer
`provider_failed`.

### Whiteboard

M13 (#15). Every floor has a whiteboard on its north wall: look at it and press E, and an
[Excalidraw](https://github.com/excalidraw/excalidraw) 0.18.1 editor opens over the game (loaded on that first open
only, its fonts served by the game itself). The bridge keeps each floor's board: a versioned Excalidraw scene, its image
files stored once by the sha256 of their bytes, and a PNG render the room's board shows. Agents pin images and notes on
it (the office CLI, M14 #16).

The board's bytes are HTTP on the bridge's socket, like the logos and `/upload` (a scene with its render is far over
the 256 KiB a message may be); the WebSocket carries the commands without bytes and `whiteboard.updated`. Through the
helper every URL has `token=` like `/ws`.

**Storage** (`--whiteboards` / `HERDR_WORLD_WHITEBOARDS`, default `$XDG_DATA_HOME/herdr-3d/whiteboards`, else
`~/.local/share/herdr-3d/whiteboards`; `-` for none: the commands answer `unsupported`, the routes `501`), one
directory per floor, `0700`, files `0600`, every write a temp file renamed into place:

| file | |
|---|---|
| `<floor>/head.json` | the current `version`, its `author` and `at`, `render_version` / `render`, the newest 100 `stale_pins`, the kept versions (`version`, `author`, `at`), the last 64 pin request ids. Bounded (at most 1 MiB, and a commit refuses a head over it before it writes anything). Written last: until it is, the previous version stays current with its own render. |
| `<floor>/v/<n>.json` | version `n`: `{"schema":1,"floor","version","author","at","excalidraw_version","scene":{"type":"excalidraw","version":2,"source":"herdr-3d","elements":[…],"appState":{…}},"files":{"<sha256>":{"mimeType","size","created"}}}`. The **last 20** are kept; older ones are deleted. |
| `<floor>/v/<n>.files.json` | the ids of the image files version `n` uses (`["<sha256>",…]`), for the file collection |
| `<floor>/files/<sha256>` | an image's bytes; the name is the sha256 (hex) of exactly these bytes. A file no kept version uses is deleted an hour after it was last written (it may be on its way into a save). |
| `<floor>/renders/<n>.png` | the client's export of version `n`; the current one is `render_version`'s. A save writes its own (it never replaces the current render), and the others are deleted once `head.json` names the new one (a clear names none). |

`<floor>` is a herdr session name (`[A-Za-z0-9._-]`, 1 to 64, not starting with `-`, not only dots): one path
component, never `..`. Reads need only a valid name; writes (save, file, clear, pin) need a floor the bridge watches
(`unknown_session`, `404` over HTTP).

**The scene.** `elements` are Excalidraw's, verbatim and in order, **deletion tombstones included** (an open editor
needs them to reconcile a delete), at most 20000, the scene's JSON at most 16 MiB. Each is checked: a JSON object with
an `id` (`[A-Za-z0-9_-]`, 1 to 64, unique), a known `type` (`rectangle`, `diamond`, `ellipse`, `arrow`, `line`,
`freedraw`, `text`, `image`, `frame`, `magicframe`, `embeddable`, `iframe`), `version` ≥ 1, numeric coordinates within
±10⁷, an `index` that is a valid fractional index or null, and for an image a `fileId` of 64 lower-case hex digits. A
live image's file must be stored (`whiteboard_missing_file`); a tombstone's may be gone. Of `appState` only the four
keys Excalidraw itself stores with a scene are kept, each checked (`viewBackgroundColor`, `gridSize`, `gridStep`,
`gridModeEnabled`); selection, zoom, tools, menus and collaborators are the session's, never the board's.

| request | |
|---|---|
| `GET /whiteboard/{floor}[?version=N]` | `{"t":"ack","data":{"state": <state>, "version", "scene", "files", "excalidraw_version", "history": [{"version","author","at"}…]}}`: the current version, or kept version `N` (`404` when it is not kept). A board never saved is version 0 with no elements. |
| `PUT /whiteboard/{floor}/files/{sha256}` | an image's raw bytes, before the save that uses it. The id must be the sha256 of the body (`422` `whiteboard_hash_mismatch`), the type by the bytes PNG, JPEG, GIF or WebP (`415`), at most 8 MiB (`413`), and a floor's files at most 256 MiB together (`413`). `{"id","mime","size","stored"}`: `stored` is `false` for a file already there (nothing is written again, and no audit row). |
| `GET /whiteboard/{floor}/files/{sha256}` | its bytes, `Cache-Control: private, max-age=31536000, immutable` (the name is the content), `nosniff`, a sandbox CSP |
| `POST /whiteboard/{floor}/save?base=N&author=<name>` | `multipart/form-data` with a `scene` part (`{"elements","appState"}`) and a `render` part (the PNG: at most 2400 px a side, 16 MiB). `N` is the version the scene is based on (0 for a new board). `200` with the new state: version `N+1`, `render_version` = it, no stale pins. `409` `{"t":"error","code":"whiteboard_conflict","message","version": <current>}` when `N` is not the current version: nothing is stored. |
| `GET /whiteboard/{floor}/render.png[?v=N]` | the latest render, `X-Render-Version: <n>`; with `?v=` only that version (`404` once there is a newer one: a cache never files the new picture under the old URL), cached for good; without, `no-store`. `404` when there is none (an empty or cleared board). |
| `POST /whiteboard/{floor}/pin?author=<name>&request_id=<id>` | an agent's pin: the body is an image (PNG, JPEG, GIF, WebP, ≤ 8 MiB) or, with `Content-Type: text/plain`, a note (UTF-8, ≤ 4 KiB, ≤ 200 lines). `{"t":"ack","data": <state> + {"elements":[id…], "repeated"?}}`. The bridge's socket only: the helper does not proxy it. |
| `GET /drops/file?path=<abs>[&thumb=1]` | a recent drop's bytes (or a thumbnail of at most 480 px), for the editor's "Pin a drop" |

The state (`whiteboard.get`'s ack, `whiteboard.updated`, the saves' and the pins' answers):

```json
{"t":"whiteboard.updated","seq":1203,"floor":"herdr-3d","version":12,"author":"Nibble","at":1790841600000,
 "render_version":11,"render":true,"stale":true,
 "stale_pins":[{"id":"pin_8c1e…","kind":"note","author":"Nibble","note":"Use the blue CTA","version":12,"at":1790841600000}]}
```

`stale` is `render_version != version`: agents pinned since the render (a clear renders an empty board: `render`
false, not stale). `stale_pins` lists what the render does not show yet (newest last), until a client saves the board
again; the room's board shows them on a sticky note, the editor in its ledge.

**Saving and merging** (the game, `game/src/whiteboard/editor.ts`). The editor saves 1.2 s after the last change, never
during a stroke, a drag or a text edit: it uploads the image files the bridge does not have yet, exports the PNG
(`exportToBlob`, at most 2400 px, `exportScale` 1, the background, light theme) and posts the save on the version it
has. On `409`, and on a `whiteboard.updated` of a version it has not seen (an agent's pin, another window), it fetches
the board, restores the remote elements on their own and reconciles them into the live scene (Excalidraw's
`reconcileElements`: the higher element `version` wins, a stroke in progress is kept, `CaptureUpdateAction.NEVER`), then
saves again. A fetched board older than the version the session already has (a newer merge or save landed while it
waited on image bytes) is dropped: the version only goes up. A save is one snapshot: the elements, files and appState it sends and the PNG it renders are taken at one
moment, and it is posted on the version they were based on; when a merge moved the board on while the files went up or
the PNG was made, the round starts over on the new version (a stroke drawn meanwhile goes in the next save). The
board's appState (background, grid) is saved like the elements, and a merge takes the remote one unless it was changed
here since the last save. Closing the board saves what is left first, the changes made during a save in flight
included (bounded: 8 s). When that fails (the bridge is unreachable), the board stays open and asks: **Retry**,
**Close, keep a draft** (the changes stay in this browser, in memory and in `localStorage` key
`h3d.wb.draft.<bridge>|<floor>` when they fit, and come back, reconciled with the board, the next time it opens, then
are saved; a save drops the draft only once it has all of it, and a closed board's late save never does), or
**Discard changes**.

**Image ids.** An image's file id is the sha256 of the bytes the bridge stores, and the bridge checks it. Excalidraw
hashes a pasted file before it scales it down (1440 px), so before a save the editor re-hashes each file's bytes and
re-files one whose id does not match under its hash (an SVG or another type the bridge does not store becomes PNG
first). The same picture pasted or pinned twice is one file.

**Agents' pins** (`whiteboard.Store.Pin`, which the office CLI of M14 calls through `whiteboard.pin` for a note or the
HTTP pin for an image; `Hub.PinWhiteboard` in Go): the bridge appends one complete Excalidraw element, every field of
0.18.1 present: an `image` (the file stored once by hash, scaled to fit 640 × 480, `status: "saved"`) or a `text`
(Excalifont 20, line height 1.25, left/top, `autoResize`, a provisional width the editor measures with the font
loaded before it renders). It goes on top of everything (the fractional index after the highest one, tombstones
included: fractional-indexing 3.2.0's `generateKeyBetween(last, null)`), in a column 80 units right of the drawing,
below the pins already in that column (a pin moved into the drawing counts as drawing), with `customData.herdr`
`{"author","kind":"agent-pin","requestId"?,"at"}`. The render goes stale. A repeated `request_id` pins nothing new
(`repeated: true`, the same element ids, no event).

**Clear** (`whiteboard.clear`, `confirm: true`, else `confirmation_required`; the game asks first): a new version in
which every element is a tombstone (the open editors delete them) and there is no render. The versions before stay in
the history (`GET …?version=N`).

**Recent drops** (`drops.list`, for "Pin a drop"; #13's composer can use it too): the newest regular files, by
modification time, in Drop Zone's data directory (`--dropzone-data`, the root the transcripts' path images use) and
its folders one level down (Drop Zone's month folders), hidden files, links and anything but regular files skipped.
Read only: the bridge never writes there. Each is `{"path","name","size","mtime","mime","image","reason"?}`; only
`image: true` drops (PNG, JPEG, GIF, WebP of at most 25 MiB, by their first bytes) can be pinned, the others are listed
greyed with their `reason` (`not_image`, `too_large`). `GET /drops/file` reads a path only under that directory, with
the transcripts' allowlist (absolute, clean, no link out, walked down without following one), `404` otherwise.

**Audit** rows (client `http` for the HTTP routes): `whiteboard.save` `{"floor","base","author","scene_bytes",
"render_bytes","version"}`, `whiteboard.file` `{"floor","id","size","stored"}` (only when a file was written, or
refused), `whiteboard.pin` `{"floor","author","kind","bytes","request_id","version"}`, `whiteboard.clear`
`{"floor","confirm"}`, and the commands' own rows. Never an image or a note's text.

| status | `code` | when |
|---|---|---|
| `400` | `whiteboard_invalid`, `bad_request` | a scene, element, note or multipart body that is not well-formed; `base` missing |
| `404` | `not_found`, `unknown_session` | not a floor name, a version not kept, no render, no such file; a write to a floor the bridge does not watch |
| `409` | `whiteboard_conflict` | a save on a version that is not the current one (with `version`) |
| `413` | `whiteboard_too_large` | over a cap: scene 16 MiB or 20000 elements, file 8 MiB, a floor's files 256 MiB, render 16 MiB or 2400 px a side, note 4 KiB or 200 lines |
| `415` | `whiteboard_unsupported` | an image that is not PNG, JPEG, GIF or WebP; a render that is not a PNG |
| `422` | `whiteboard_hash_mismatch`, `whiteboard_missing_file` | a file id that is not the sha256 of its bytes; a live image whose file was not uploaded |
| `501` | `unsupported` | the bridge keeps no whiteboards (`--whiteboards -`) |
| `503` | `drops_unavailable` | no Drop Zone data directory |

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

### AI integration

#92. Two bridge-wide models, configured once and used by features (#90 follow-up questions, see [Follow-up questions](#follow-up-questions)): the **classifier**
(Jev, by TypeSafe: a score in [0,1] for a yes/no question about some state) and the **LLM** (any OpenAI-compatible
endpoint: OpenRouter, LiteLLM, vLLM, Ollama, Xiaomi MiMo…). `internal/ai` holds them and knows no feature: a feature
takes the `ai.Classifier` or `ai.LLM` interface (with fakes for its tests). **Configuring a model sends nothing.** The
only calls the bridge makes by itself are `ai.models` (a model list) and `ai.test` (one tiny round trip), both asked for.

```json
{"classifier":{"state":"ready","model":"jev-latest","key_set":true,"key_hint":"d1f9","env":[]},
 "llm":{"state":"incomplete","base_url":"https://api.xiaomimimo.com/v1","model":"","key_set":true,"key_hint":"3a7c",
        "json_mode":null,"extra_body":{"thinking":{"type":"disabled"}},"env":["key"]},
 "last_error":{"role":"llm","kind":"auth_failed","message":"the key was rejected (HTTP 401)","at":1790702330276,"runtime":true}}
```

`ai.get` answers it, `world.snapshot`'s `ai` holds it, `ai.update` carries it flat. A bridge without the service has no
`ai` key and answers `unsupported` (a bridge before #92: `unknown_command`).

- **`state`** per role: `off` (nothing configured), `incomplete` (a part is missing: the classifier needs a key and a
  model, the LLM a base URL and a model; an LLM's key is optional, for Ollama or vLLM without one), `invalid` (the last
  test or a feature's call failed), `ready`. A role that is not `ready` makes **no call at all**, for any feature.
- **Keys** are sent by the game in `ai.models`, `ai.test` and `ai.set` and nowhere else. The bridge never sends one back:
  only `key_set` and `key_hint` (the last four characters, `""` for a key under 8). A blank or absent `key` means "the
  current key". Keys live in one `0600` file next to the database (`ai.json`, `--ai-file` / `HERDR_WORLD_AI_FILE`), not
  in it, written atomically, never logged. They are scrubbed from every error (the provider's own text is clipped and
  cleaned: the key, however short, `Bearer …` and key-shaped strings go) and from the model ids and descriptions of
  `ai.models` (the key itself only: a long id that is no key stays whole). The game's own command log
  (`window.__h3d.sent()`) records an `ai.*` command with `key` replaced by `[redacted]`. The audit log has the role, base URL, model and whether a
  key was given, never a key or its length. A file that is not valid JSON stops the bridge (it is never overwritten).
- **`env`** lists the fields the bridge environment sets (`HERDR_WORLD_AI_CLASSIFIER_KEY_FILE`,
  `HERDR_WORLD_AI_CLASSIFIER_MODEL`, `HERDR_WORLD_AI_LLM_BASE_URL`, `HERDR_WORLD_AI_LLM_KEY_FILE`,
  `HERDR_WORLD_AI_LLM_MODEL`; the keys are files, so a key is not in the environment). They win over the stored values
  and are read-only: naming one in `ai.test` / `ai.set` is `env_locked`. `ai.clear` removes the stored role; the
  environment stays in force.
- **`ai.models`** `{role, key?, base_url?}`. Classifier: `GET https://api.typesafe.ai/v1/models` →
  `models[].name`; a 401 is `auth_failed`. LLM: `GET {base}/models` → `data[].id` (sorted), the base URL normalised
  (trailing slash removed; `/v1` added **only** if `{base}/models` is 404 and `{base}/v1/models` works, the result's
  `base_url` says what was used); no `/models` at all is `no_models_endpoint` and the client lets the user type a model
  id. A base URL is `http(s)://host…` without credentials, query or fragment; redirects are never followed. A load takes
  one of the two global call slots like a feature's call. An LLM model's entry may carry `reasoning` (#174): what the
  endpoint's catalog says of its reasoning effort (OpenRouter's per-model `reasoning` metadata and
  `supported_parameters`; see [Floor overview summaries](#floor-overview-summaries)); absent when the catalog lists the
  id only. The model's entry is also read, and kept for 30 minutes, by `digest.get` and when a feature sends an effort.
- **`ai.test`** `{role, key?, base_url?, model?, extra_body?}` (fields left out are the current ones). The classifier
  gets a trivial yes/no question and must answer a score in [0,1] (`score`). The LLM gets a one-line JSON request with
  `response_format: {"type":"json_object"}`; on a 400 it is repeated without, and `json_mode` says which works. A
  failure is an error (`auth_failed`, `unreachable`, `timeout`, `bad_response`, `rate_limited`, `provider_failed`,
  `incomplete`, `bad_request`). A test takes one of the two global call slots and is bounded by its role's request
  timeout (3 s classifier, 15 s LLM, per request). A pass is remembered for 30 minutes, for exactly that config (a
  fingerprint of base URL, model, key and `extra_body`) **and**, when the base URL was resolved (`/v1` added), for the
  config with the resolved URL: the panel shows the resolved URL after a test and submits it to `ai.set`. A test of the config **in use** that fails makes the role `invalid`; one that passes lifts
  `invalid`. A test of anything else changes no state.
- **`ai.set`** `{role, key?, base_url?, model?, extra_body?}` saves a role and returns the state; fields left out are
  kept. It is `test_required` unless exactly that config passed `ai.test`: **a role never becomes `ready` untested**.
  `extra_body` (LLM only) is a JSON object of at most 4 KiB merged into every chat request (`{"thinking":{"type":"disabled"}}`
  for MiMo); it cannot set `messages`, `model` or `stream`; `null` clears it. Nothing is hardcoded per vendor. When the
  base URL is the environment's (`HERDR_WORLD_AI_LLM_BASE_URL`), the URL a passing test resolved it to is remembered
  (`env_base` in `ai.json`, only while the environment URL is the same) and is what the view shows and calls use.
- **`ai.clear`** `{role}` removes a role's settings and key.
- **Bounds** (shared by every feature and both roles): a timeout per attempt (3 s classifier, 15 s LLM; model lists 15 s;
  tests use their role's bound), **at most one retry** (a network failure, a timeout or a 5xx; the `response_format` fallback is that one
  retry; a 401/403 or a 429 is never retried; a classifier retry checks the role again first: no longer `ready`, it is
  not sent, and it uses the config in use then), and **two calls in flight at most** over the whole bridge, model-list
  loads and tests included; a waiting call gives up with its context, holds no slot and is not sent.
- **Runtime 401/403** makes that role `invalid`, with `last_error {role, kind: "auth_failed", runtime: true}`, and
  every consumer pauses (they get `ErrNotReady`, no request goes out) until a passing `ai.test` of the config in use, an
  `ai.set` or an `ai.clear`. A rejection that comes back for a config no longer in use (the key was replaced while the
  request was out) is ignored. The game shows a toast ("AI integration paused: classification key rejected") on
  the `ai.update` that carries it, and a chip in the top bar while a role is configured but not `ready`.
- Error codes besides the usual: `auth_failed`, `no_models_endpoint`, `unreachable`, `timeout`, `bad_response`,
  `rate_limited`, `provider_failed`, `incomplete`, `test_required`, `env_locked`; and (#174), from a feature's call,
  `truncated` (the answer was cut off at the token limit: with no text at all, or, for a feature that asks for it, with
  some) and `empty_answer` (a well-formed answer with no text), both of which were `bad_response` before.

### Kaneo

#184. One bridge-wide connection to a [Kaneo](https://kaneo.app) instance (self-hosted or not), which a floor can use as
its issue tracker instead of GitHub (`floor.settings.set` `tracker: "kaneo"` with a `kaneo` link, see [Floor
settings](#floor-settings) and [Boards](#boards-issues-and-pull-requests)). `internal/kaneoconf` holds it; the bridge
reaches Kaneo only through its `Connector` interface (the app adapts the Kaneo client to it), with every call a read
(`GET`) except the board writes. **Testing and configuring change nothing on Kaneo.**

```json
{"state":"ready","available":true,"url":"https://tasks.example.com","api_base":"https://tasks.example.com/api",
 "web_origin":"https://tasks.example.com","key_set":true,"default_workspace":{"id":"…","name":"Studio","slug":"studio"},
 "generation":3}
```

`kaneo.get` answers it, `world.snapshot`'s `kaneo` holds it, `kaneo.update` carries it flat. A bridge without the
settings has no `kaneo` key (a bridge before #184: every `kaneo.*` is `unknown_command`).

- **`state`**: `off` (nothing saved), `ready`, `paused` (Kaneo refused the saved key at run time: `paused_until` (unix
  ms) is when the Kaneo floors poll again, `last_error {kind: "unauthorized", message, at, runtime: true}`).
  `available: false`: the bridge has no Kaneo client, nothing can be tested (saved settings still show).
- **The key** is sent by the game in `kaneo.test` and `kaneo.set` and nowhere else; the bridge never sends it back (only
  `key_set`, no hint). It lives in one `0600` file next to the database (`kaneo.json`, `--kaneo-file` /
  `HERDR_WORLD_KANEO_FILE`; not the AI integration's file), written atomically (a temporary file, synced, renamed); a
  file others can read is tightened, a malformed one stops the bridge and is never overwritten. Errors are scrubbed of
  it; the audit log has the address and whether a key was given (`key_given`), never a key; the game's command log
  (`window.__h3d.sent()`) records `key` as `[redacted]`. It is in no board cache key, event or prompt.
- **`url`** is the instance as entered: its origin (`https://tasks.example.com`) or its API base (`…/api`, never
  doubled); `api_base` and `web_origin` are what it resolved to. https only (plain http only to a loopback host), no
  credentials, query or fragment (`bad_url`).
- **A blank or absent `key` is the saved key, and only for the saved instance**: a draft whose address resolves to
  another API base without a key typed is `key_required`, before anything is sent, so the saved key never goes to
  another host, not even in a test.
- **`kaneo.test`** `{url?, key?}` (absent fields are the saved ones) lists the workspaces the key reaches (Kaneo's
  authenticated `GET /auth/organization/list`; never a public health check): `workspaces: []` is a working key that
  cannot link a floor yet. A pass is remembered (the instance and the key's hash, in memory) for 30 minutes, with its
  workspaces. A pass of the saved connection ends a pause. A failure changes nothing saved.
- **`kaneo.set`** `{url?, key?, default_workspace?}` is `test_required` unless that very instance and key passed a test
  within 30 minutes; `default_workspace` must be one that test found (`bad_request`), `null` clears it, absent keeps the
  saved one while the test found it. The answer comes after the file is written (a failed write is `internal` and
  changes nothing). `generation` moves when the instance or the key changes (or on `kaneo.clear`): every Kaneo floor's
  board and cache of the older one is dropped. The default workspace is a prefill for floors not yet linked; it never
  moves a saved floor.
- **`kaneo.clear`** `{}` disconnects: the address, the key and the default go (Kaneo floors keep their link and show no
  board until a connection is saved again).
- **`kaneo.workspaces`** `{}` and **`kaneo.projects`** `{workspace_id}` (archived projects left out) use the saved
  connection (`not_configured` without one), for a floor's dropdowns; a list is answered from memory for 30 s per
  generation (switching back and forth calls Kaneo once). A list's `generation` is the connection's that read it: a
  client drops one whose `generation` is not the connection it shows, and asks again on the `kaneo.update` of a new
  one.
- **Bounds**: 15 s per call, two calls in flight at most (a waiting one gives up with its client's request), every call
  off the bridge's main loop.
- **Error codes**: `bad_url`, `key_required`, `test_required`, `not_configured`, `unauthorized` (401: a wrong or revoked
  key, **or its request quota**: try again after a minute), `forbidden` (403), `unreachable`, `timeout`, `rate_limited`,
  `provider_failed`, `not_found`, `bad_request`, `unsupported` (no Kaneo client).

The saved instance's web host is what the Mac helper may open "Open in Kaneo" links on (see [Through
`h3d-helper`](#through-h3d-helper-the-mac)).

### Laptops: screens, input, changes and usage

Every laptop command takes the bridge's worker `id`, never a pane id: the bridge uses the worker's own `pane_id`
(its primary pane) as it is when the command runs. A worker on an asleep floor, or one without a pane, is
`invalid_state`; an unknown id, or a worker on a floor the bridge does not watch, `unknown_worker`. Every command is
audit-logged like the others; for `worker.keys` and `worker.prompt` the audit row keeps the lengths of the text and the
key names, **never the text**.

#### Laptop screens

```json
{"t":"terminal.watch","req_id":"50","args":{"id":"6db1905e-…","fps":4}}
{"t":"ack","req_id":"50","data":{"pane":"w1:p1","cols":120,"rows":40,"zoom":{"state":"single","applied":false}}}
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
  known one. A pane in a split shows at its split size (60 columns of a 120-column tab): see [Fullscreen](#fullscreen-74).
  `zoom` in the ack (always, when the bridge could read the pane's tab) says what the pane's tab does with it.
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

##### Fullscreen (#74)

A pane in a split shows at its own size: the agent really renders at that width, and the observer cannot reflow it. herdr
has **pane zoom**, a per-tab flag that makes the tab show its focused pane alone, so a `terminal.watch` with
`"fullscreen": true` zooms the pane's tab while it is watched and puts it back after (this is the bridge's one write
that changes what a human's herdr TUI shows; `terminal.watch` without `fullscreen` behaves exactly as before).

`fullscreen` is a **tri-state**. *Absent* is the watch of a client from before #74: nothing is zoomed, the bridge does
not look at the pane's tab again and sends no `terminal.state`, whatever happens to the tab. `true` zooms. `false` does
not zoom and takes no ownership, but says that the client wants the chip's truth: the watch follows the pane's zoom,
focus and size like a `true` one (`terminal.state`, the observer at the new size) and can zoom later with
`terminal.zoom`. A client sends `false` for the preference "no fullscreen" and leaves the field out for the screens it
only shows (the ambient laptops).

```json
{"t":"terminal.watch","req_id":"51","args":{"id":"6db1905e-…","fullscreen":true}}
{"t":"ack","req_id":"51","data":{"pane":"w1:p1","cols":134,"rows":49,"zoom":{"state":"zoomed","applied":true}}}
{"t":"terminal.state","id":"6db1905e-…","pane":"w1:p1","cols":67,"rows":49,"zoom":{"state":"split","applied":false}}
{"t":"terminal.zoom","req_id":"52","args":{"id":"6db1905e-…","on":true}}
{"t":"ack","req_id":"52","data":{"pane":"w1:p1","cols":134,"rows":49,"zoom":{"state":"zoomed","applied":true}}}
```

- **`zoom`** (the ack of `terminal.watch` and `terminal.zoom`, and `terminal.state`): `state` is `single` (the tab has
  one pane: nothing to zoom, and `fullscreen` writes nothing), `zoomed` (the tab is zoomed on this pane) or `split` (the
  tab has several panes and this one shows at its split size: not zoomed, or zoomed on another pane). `applied` is true
  when the bridge zoomed the tab itself and will put it back (false for a tab the human zoomed). `headless` (only with
  `zoomed`) is true when the tab's area is herdr's headless 120 × 40, which means most likely no herdr TUI is attached:
  the zoom flag is set but herdr resizes no terminal without a client, so the pane did not grow (upstream herdrdev/herdr#1709).
  The ack has no `zoom` when the bridge could not read the pane's tab (an old bridge never has it).
- **Size.** In a zoomed tab the pane's size is the tab's content area (`session.snapshot` keeps reporting the split
  rectangles, but its layout has `zoomed`, `focused_pane_id` and the tab's `area`), so `cols` × `rows` of the ack and of
  the frames are the area. herdr makes the real terminal about 3 columns and 2 rows smaller than the area (borders and
  scrollbar: area 114 × 49 gave a 111 × 47 terminal); the observer pads that difference, which is better than cutting off
  the rows a prompt is on. Observer frames carry the size that was asked for, not the pane's real one, so the bridge
  cannot correct this guess. An explicit `cols` / `rows` is the client's own and is never changed by a zoom.
- **Ownership.** The bridge remembers per (session, tab) that it zoomed the tab, counted by the watches that want the
  tab fullscreen (`fullscreen: true`, or `terminal.zoom` on) over all connections. A watch that follows only
  (`fullscreen: false`) or that turned fullscreen off with `terminal.zoom` is not counted: it is no owner and its
  ending puts nothing back, nor stops the last real owner from doing so. When the last counted watch ends
  (`terminal.unwatch`, a re-watch without `fullscreen: true`, a closed connection, `terminal.closed`, the bridge shutting
  down) and the tab is still zoomed, it runs the `--off`. It does not, when the tab was already zoomed before the watch
  (the human's), when the human unzoomed it since, when the pane is no longer in the tab the bridge zoomed (it is
  looked at again before the write; a pane the human moved to another tab leaves that tab alone), or when the floor is
  asleep (no herdr call is made). Every decision to write is made on the pane's state read under the write lock that
  serialises the bridge's zoom writes, never on one read before waiting for it.
  The bridge **never zooms again on its own** after the first time: if the human changes the focus or unzooms while
  seated, the laptop is told and the player decides. A re-watch of the same worker (the game does it for a new fps, on a
  frame gap) takes over the watch it replaces with its decision: the tab is not put back and zoomed again in between,
  and it is **not zoomed again** even with `fullscreen: true` when the human unzoomed or moved the focus meanwhile.
  Only `terminal.zoom` with `on: true` zooms again.
  `--on` always focuses the pane in herdr (that is how zoom picks the pane to show): a watcher that zooms moves the
  human's TUI focus. Two watchers of different panes of one tab take turns at being the visible one.
- **`terminal.state`** goes to a watch that sent `fullscreen` (true or false) or used `terminal.zoom`, like `terminal.frame`: no
  `seq`, not replayed, dropped when the connection has no room. It is sent when the pane's `zoom` or size changed
  (the bridge looks at the session's snapshot every 2 s while such a watch lives). A size that was not set by the
  client follows the pane: the observer starts over at the new `cols` × `rows` and the next `terminal.frame` is a full
  one (`n` from 1 again, like a resync). It repeats nothing the ack or the previous state said.
- **`terminal.zoom`** `{id, on}` (the worker must be watched by the connection: `bad_request` otherwise, also for a
  missing `on`): `on: true` zooms the tab on the pane and takes ownership as `fullscreen` does (a watch without it
  starts following); `on: false` unzooms the tab, also one the human zoomed (the player asked), and the bridge owns
  nothing of it afterwards (the watch is no longer counted, see Ownership). `input_failed` when herdr refused the
  zoom or the pane/tab could not be read, or when the watch ended while the command was in flight (a command never
  zooms, or takes ownership for, a watch that is gone); a refused command changes nothing. The ack is the new state,
  `cols` × `rows` included.
- **Failures never fail a watch.** A tab that cannot be read, a failed `pane zoom`, a single-pane tab or a headless
  session leave the watch at the best known size (`zoom` says `split`, or `zoomed` with `headless`). This is for the
  zoom at `terminal.watch` only: an explicit `terminal.zoom` reports a failure as `input_failed`.
- **Audit.** Every zoom write is its own audit row `pane.zoom` with `{"session","pane","mode":"on"|"off","why"}`
  (`why` is `watch`, `command`, `stand-up`), apart from the row of the `terminal.watch` / `terminal.zoom` command.
  The bridge runs exactly two zoom commands, `herdr --session <s> pane zoom <pane> --on` and `--off`: never `--toggle`,
  never without a mode.

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
arrived, so two quick `worker.keys` never interleave (#156: `worker.answer_async` too); at most 32 wait per worker (then `input_failed`). herdr
refusing is `input_failed` (the message says which step and why).

**`worker.prompt`** submits a prompt to the worker's agent. `text` is 1 byte to 16 KiB of UTF-8 without NUL (herdr
0.9.0 takes a leading `--` as text, too). Only for a worker with an agent (`agent_kind`); a plain shell is
`invalid_state` (use `worker.keys`), and so is a `blocked` worker (answer its question first; herdr would refuse with
`agent_blocked`), except a shared Codex worker blocked only by an async question (#156: sent through its app-server,
see [Codex async questions](#codex-async-questions)). The game uses it for paste too.

**Claude** (#95): the prompt is **typed**, as in the hire's step 5 (chunks of at most 700 characters via `herdr pane
send-text`, 50 ms apart, then `herdr pane send-keys <pane> enter`; the whole of it on the worker's input lane), so
Claude takes it as the user's own words: no `<pasted_content>` wrapper, and a leading `/command` runs. `text` must hold
no control characters but line ends (`\r\n` and `\r` are typed as `\n`, a new line, not Enter) and tabs (Claude
drops a typed tab: each goes as four spaces), and be at most 16 KiB as typed; else `bad_request` (the message gives
its length, never the text). 16 KiB takes about 1.3 s to type.

- Worker `working`: typed and Enter at once, without waiting: Claude queues it for its next turn (`queued: true`).
- `idle` or `done`: typed, then the bridge waits up to 5 s for the worker to start (`working` or `blocked`, or a turn
  it saw start and end). Not started: Enter **once** more and up to 5 s more: `retried: true`. Still not, or herdr
  failing: `prompt_failed`.
- Any other state (`unknown`: herdr cannot tell yet): waited for up to 5 s to become one of those (text typed before
  Claude's input box is up is lost), else `prompt_failed`.
- Typing that fails once it began (herdr failing between chunks, the bridge stopping): `prompt_failed`, and what was
  typed is erased from Claude's input box first (`herdr pane send-keys <pane> ctrl+u backspace …`, on the input lane),
  so a retry is not appended to it. When that fails too, the worker's next prompt erases first and is `prompt_failed`
  with nothing typed while it cannot.

**Codex**: `herdr agent prompt <pane> <text>` (bracketed paste, then Enter; Codex keeps a paste as typed text).

- Worker `working`: the agent takes it for its next turn (Codex queues it). Sent without waiting; the ack says
  `queued: true`.
- Otherwise herdr waits (up to 8 s) until the worker is `working` or `blocked`. When the text is in the agent's input
  but its Enter was dropped (the known paste quirk; herdr: `agent_prompt_stalled` after 5 s), the bridge presses Enter
  **once** more and waits up to 5 s for `working` / `blocked`: `retried: true`. Still not submitted, or herdr failing
  otherwise: `prompt_failed`.

**The bridge rewrites a Codex prompt (#138).** The composer keeps harness-neutral text; for a worker whose agent is
Codex the bridge rewrites these tokens on the worker's input lane, just before the text is sent (direct and queued;
also `worker.answer_ask`'s `prompt`), and nothing else:

| In `text` | Codex gets | Only when |
|---|---|---|
| `/name` | `$name` | `name` is a skill in the worker's `worker.commands` (never a built-in, `/compact` stays) and the `/` starts a word; `/usr/bin/env`, `http://x/y`, `a/b`, `/name/more` stay |
| `@path` | `path` | the `@` starts a word and `path` is a file or directory inside the worker's checkout (symlinks and `..` that lead out do not count); `@someone`, `me@x.com` stay |
| `@"a b/c.txt"` | `a b/c.txt` | as `@path`: a path with spaces is written in quotes (Claude only attaches it that way) |

Text to Claude goes through untouched, so a client writes the mention for Claude itself: `@path`, or
`@"path with spaces/file.txt"` when the path has spaces. `[Image #n: …]` markers are never touched. The 16 KiB limit is
for the text **after** the rewrite: a Codex text up to 64 KiB (4 x the limit: no rewrite shortens a text past a quarter)
is read, translated and then checked, in `worker.prompt` and in `worker.answer_ask`'s `prompt` alike (the latter is
refused before the dialog is touched). When the bridge changed the text, the ack of `worker.prompt` (direct or
`queued`) has `sent`: the text it sent, which is what the agent's transcript shows; absent when it sent the text as
typed. A client matches its pending row against the typed or the sent text. When the catalog or the file check fails, the text goes as typed. A Codex prompt that ends in a `$skill`
leaves Codex's skill popup open and its Enter is taken: the retry presses `esc` then `enter` instead of `enter` alone,
unless the worker started meanwhile (the prompt was only slow): then nothing is pressed, as Esc aborts a running turn.
The transcript view of a Codex worker shows the rewritten text (what Codex received).

#140: the ack (direct or `queued`) has `"terminal": true` when the typed text runs a built-in whose output or dialog
shows only in the worker's terminal (the table under [Commands and skills](#commands-and-skills): the text, trimmed,
is `/name` or, for an `always` built-in, `/name args`; the name ends at the first whitespace of any kind, so
`/model\topus` has an argument; aliases count, so `/cost` is Claude's `/usage`); absent otherwise. The transcript will
show nothing of it: a client shows the worker's terminal instead.

Such a prompt starts no turn (a dialog opens, or a card prints, and herdr says `idle` / `done` meanwhile), so the bridge
decides this **before** it sends, from the text as typed, and sends it differently: Claude's is typed with its Enter
(after the same wait for the agent to be ready, and the same erase), Codex's pasted with `herdr agent prompt` without
waiting. The ack comes as soon as herdr delivered it; nothing waits for `working`, and Enter is **never** pressed again
(it would act on the open dialog), so `retried` is always false. herdr failing to deliver it is `prompt_failed`, as
for any prompt. A worker `blocked` or with an ask refuses it (`invalid_state`); to a worker `working` it goes as any
queued prompt (`queued: true`, with `terminal`): the CLI runs it, or refuses it, in its terminal when it takes it.

The bridge's transcript reader (the usage tracker) warns in its log when a prompt it typed into Claude reaches the
transcript wrapped as a paste anyway (Claude Code's paste threshold changed): it keeps a hash of each typed prompt's
words for 10 minutes, never the text.

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

#### Commands and skills

#136. **`worker.commands`** lists the slash commands and skills the worker's harness offers in the worker's checkout,
read-only, for the composer to offer them:

```json
{"t":"worker.commands","req_id":"56","args":{"id":"a58752ea-6511-4318-be9a-59e41c09d7c5"}}
{"t":"ack","req_id":"56","data":{"commands":[
  {"name":"compact","description":"Free up context by summarizing the conversation so far","argument_hint":"<optional custom summarization instructions>","kind":"command","terminal":""},
  {"name":"usage","description":"Show session cost, plan usage, and what's contributing to your limits","argument_hint":"","kind":"command","terminal":"always"},
  {"name":"caveman:caveman-commit","description":"(caveman) Ultra-compressed commit message generator. …","argument_hint":"","kind":"skill","terminal":""},
  {"name":"deploy","description":"Deploy to the test host (project)","argument_hint":"<host>","kind":"custom","terminal":""}],
  "partial":false}}
```

| field | |
|---|---|
| `commands` | never `null` (`[]` when there are none). One row per name and kind, in the harness's order. |
| `name` | without the leading slash, with its namespace (`caveman:caveman-commit`, `humanizer:humanizer`). A Claude command is typed as `/name`, a Codex skill as `$name`, a Codex built-in as `/name`. |
| `description` | the harness's description. Claude appends where a skill or command comes from (`(user)`, `(project)`, `(claude.ai sync)`); for a Codex skill it is its short description (`interface.shortDescription`, else the legacy `shortDescription`, else `description`) |
| `argument_hint` | `""` when there is none; a required argument is `<…>`, an optional one `[…]` |
| `kind` | `command`: the harness's own; `custom`: a legacy command file; `skill`: everything else |
| `terminal` | #140, a `command` only: `always` when its output or dialog shows only in the worker's terminal, never in its transcript; `bare` when that is so only for `/name` alone (with arguments it works inline); `""` otherwise (below) |
| `partial` | `true` while no probe of the harness has succeeded for this checkout: `commands` then holds only the bridge's static built-ins (Codex's, below; Claude has none: `[]`) |

The worker's harness is its `harness` (else `agent_kind`), `claude` or `codex`; its checkout is
`worktree.checkout_path`, else its `cwd`. The bridge asks the installed CLI (`--claude-cli`, `--codex-cli`; found on
`PATH`, then `~/.local/bin`), **in the checkout** (project skills and `.claude/commands` are per project), with the
hardening of the startup model discovery: only a protocol initialization (and a list), never a user or model turn;
the clean environment of a herdr launch; at most 10 s, 8 MiB of output and 1 MiB per line; the process group is
killed and reaped.

- **Claude Code**: the `commands` of the SDK's `initialize` control reply (`supportedCommands()`), with the model
  probe's flags (`--print`, stream-json in and out, `--no-session-persistence`, `--strict-mcp-config`, `--tools ""`,
  hooks off; not `--setting-sources` or `--disable-slash-commands`, which would hide the user's and the project's
  skills). Skills marked `user-invocable: false` are not listed. A row Claude marks `builtin` is a `command` (when a
  name has several rows, the `builtin` one, the one `/name` runs; else the first); aliases are not rows. Claude does
  not say where an unmarked row comes from, so it is `custom` when its name matches a `*.md` file under
  `.claude/commands` of the checkout or an ancestor up to the git root (a directory with `.git`), or under
  `~/.claude/commands` (nested directories namespace it: `sub/x.md` is `sub:x`), and a `skill` otherwise. **Known
  limitation**: plugin commands, synced skills and MCP prompts are reported as `skill`, and a skill whose name equals
  a command file's is reported as `custom`.
- **Codex**: `codex app-server`, `initialize`, `initialized`, then `skills/list {"cwds": [checkout]}` (never
  `forceReload`: each probe is a new app-server, with no cache to bypass). The checkout's group (or the only one);
  `enabled: false` skills are dropped; every other one is a `skill` with `argument_hint` `""`. A skill that failed to
  load (the group's `errors`) is left out and logged; the others are listed. Then Codex's **built-ins**, `kind:
  "command"`, a static list in `internal/harness/codex_builtins.go` taken from `codex-rs/tui/src/slash_command.rs` at
  `rust-v0.160.0` (checked 2026-10-04 against codex-cli 0.160.0), with upstream's descriptions: only the commands that
  do their work when pasted as a prompt (`init`, `compact`, `recap`, `review <instructions>`, `rename <name>`, `plan
  [prompt]`, `goal <objective|pause|resume|clear>`, `diff`, `status`, `pwd`, `mcp [verbose]`, `ps`, `stop`), none
  that only opens a picker, ends or replaces the session, or is for debugging. A skill named like a built-in keeps
  its own row (`$name` and `/name` differ).

**Caching**, per harness and checkout (at most 64, the least recently used dropped): a list at most **30 s** old is
answered at once. An older one is answered at once too, and one probe refreshes it in the background for the next
ask. The first ask for a checkout waits for its probe; asks meanwhile share it. A failed or timed-out probe keeps the
previous list (the next probe is 30 s later); with no previous list the answer is the built-ins with `partial:
true`, and an ask 30 s later probes again (in the background: it answers the built-ins at once).

**Terminal-only built-ins** (#140): a static table per harness in `internal/harness/terminal.go`, since neither CLI
says which commands these are (Claude's `supportedCommands()` rows have no such field) and herdr reports the agent
`done` while such a dialog is open. Observed on Claude Code 2.1.289 and codex-cli 0.160.0:

| harness | `always` | `bare` |
|---|---|---|
| `claude` | `usage` (aliases `cost`, `stats`), `status`, `config`, `mcp`, `help`: a modal window (Esc closes it), nothing in the JSONL | `model`: the picker; `/model <name>` switches inline |
| `codex` | `status` (an inline card), `pwd`, `ps`, `mcp` (inline lines), `diff` (a full-screen viewer: `q` closes it, and it takes the prompts typed meanwhile): nothing in the rollout | |

Claude's `context` prints inline and is transcribed: not in the table. The mark is on the harness's own row only (a
skill named `status` is not the dialog). `worker.prompt`'s ack says when a sent prompt is one of these (above).

Errors: `unknown_worker`, `invalid_state` (its floor is asleep, it has no directory, or it runs no Claude or Codex
agent), `bad_request` (unknown `args` fields), `internal` (not configured). A failed probe is not an error (above).
Each call is one audit row.

#### Files

#137. **`worker.files`** ranks the files and directories of the worker's checkout against a query, read-only, fast
enough to ask on every keystroke (the composer's `@` mentions; either harness):

```json
{"t":"worker.files","req_id":"57","args":{"id":"a58752ea-6511-4318-be9a-59e41c09d7c5","query":"my fi","limit":3}}
{"t":"ack","req_id":"57","data":{"files":[
  {"path":"docs/my files","kind":"dir","indices":[5,6,7,8,9]},
  {"path":"notes/my first.txt","kind":"file","indices":[6,7,8,9,10]},
  {"path":"docs/my file #1?.md","kind":"file","indices":[5,6,7,8,9]}],
  "source":"git","reason":null}}
```

| field | |
|---|---|
| `query` | one pattern, every character literal: **a space is a character to match**, not fzf's "AND" (`my file` matches `docs/my file.md`, with the space highlighted). Smart case: case-insensitive unless it has an uppercase letter. At most 256 characters (code points). `""`: the shallowest paths (below) |
| `limit` | the most matches: absent or `0` is 30, above 100 is 100, negative is `bad_request` |
| `files` | never `null`, best first |
| `path` | relative to the worker's checkout, `/`-separated, no leading `./`, a directory without a trailing `/` (its `kind` says so). Returned verbatim as a plain string: spaces, `#`, `?`, `%` and non-ASCII are not quoted or escaped (quoting it for a prompt or a link is the client's job). Paths that are not valid UTF-8 are not listed |
| `kind` | `file` or `dir`. A symlink is a `file` (it is never followed, whatever it points at) |
| `indices` | the positions in `path` of the matched query characters, ascending, one per query character: **Unicode code point offsets**, not UTF-16 or byte offsets. A JavaScript client highlights with `Array.from(path)` (`[...path]`), never `path[i]` or `path.slice`, which count UTF-16 units and split an emoji or other astral character. `[]` for an empty query |
| `source` | what listed the checkout: `git`, `rg` (outside git) or `none` (outside git and no `rg`: `files` is `[]`) |
| `reason` | `null`, or why the list is empty or may be incomplete or stale, several joined with `; `: no `rg`; the checkout has no files to search (nothing listed: an empty checkout, everything ignored, every path dropped; for every query, `""` included); the listing timed out (20 s) or passed its output cap (git 32 MiB, rg 20 MiB: the complete paths before that are searched); more than 500 000 files and directories (the first are searched); a refresh failed (the older index answers). A query that matches nothing in a checkout with files is `files: []` with `reason: null`, the normal answer to a keystroke |

The worker's checkout is `worktree.checkout_path`, else its `cwd` (a subdirectory of a repository lists only what is
under it, relative to it).

**Listing.** Inside git: `git ls-files -z --cached --others --exclude-standard --deduplicate`, run in the checkout:
tracked files plus untracked files that are not ignored (`.gitignore`, `.git/info/exclude`, the global excludes); an
ignored file never appears. A submodule is its own path; a tracked file deleted from disk is still listed until the
index forgets it. Outside a git work tree (not an error): `rg --no-config --files --null --no-require-git` (what rg
would search: its ignore files honored, hidden files skipped, symlinks not followed); without `rg` (`--rg`) the answer
is empty with `source: "none"` and a `reason`. The bridge never walks the disk itself, and never stats or opens a listed
path. Both run argv-only in the clean environment of a herdr launch (`GIT_OPTIONAL_LOCKS=0`: listing never writes git's
index), at most 20 s each (rg gets SIGTERM, then SIGKILL 2 s later). Every path is checked: relative, clean, no `..`
or `.git` component; anything else is dropped. Every directory above a listed file is added as a `dir`, so `@src/ui`
can pick a folder.

**Ranking** (fzf's path scheme, adapted): the query must be a subsequence of the path. Each matched character scores,
with bonuses for a match at a boundary (the path's start, after `/`, after `-` `_` `.` or a space, a camelCase hump, a
letter-to-digit step) and for consecutive characters (a run keeps its first character's bonus), and penalties for gaps
(the first skipped character −3, each next one −1); the first query character's bonus counts double. A character matched
in the **basename** scores a little more, so a basename hit beats the same hit in a directory (`foo` ranks
`src/foo.go` above `foo/bar.go`) while a boundary hit in a directory still beats a mid-word one in the basename (`ui`
ranks `src/ui/index.ts` above `src/build.ts`, and the folder `src/ui` above both). Of the possible alignments the best
scoring one is highlighted. Ties: the shorter path (in code points), then byte order.

**Empty query**: the shallowest paths first (fewest `/`), a depth's directories before its files, then byte order; no
file is stat'ed.

**Index and refresh**, per checkout (at most 32, the least recently asked dropped, and any not asked for 10 minutes):
the first ask for a checkout waits for its listing; every later ask answers at once from the current index. A rebuild
starts in the background (asks meanwhile answer from the old index; one rebuild per checkout at a time), at most every
**5 s** (from the end of the last), when git's index file of the checkout changed (its mtime or size; a linked worktree's
own, found once with `git rev-parse --path-format=absolute --git-path index`), or when the index is **30 s** old (new
untracked files and ignore-rule changes do not touch git's index file; an `rg` listing has none). A failed rebuild keeps
the previous index and says so in `reason`; a failed first listing is `files_failed`, retried by an ask 5 s later.

Errors: `unknown_worker`, `invalid_state` (its floor is asleep, or it has no directory), `bad_request` (unknown `args`
fields, a negative `limit`, a `query` over 256 characters), `files_failed` (the listing failed and there is no earlier
index; the message says why), `internal` (not configured). Not being in a git work tree is not an error (above). Each
call is one audit row.

#### Usage and cost

Worker field **`usage`** (in snapshots and `worker.upsert`) and event **`worker.usage`**:

```json
"usage":{"tokens":37210,"input":1200,"output":9010,"cache_write":27000,"cache_read":812000,
         "cost_usd_est":0.4824,"priced":"known","model":"claude-opus-5-5",
         "context_pct":4.2,"context_window":1000000,"context_tokens":42000,"context_window_estimated":true,
         "updated_at":1790601900984}
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
| `context_tokens` | #101: the main thread's context in use, in tokens: what the next turn starts with, the same definition for Claude and Codex (below). 0 when unknown (no usage read yet, or just after a `/compact`): never a measured 0. Not `tokens`, which is cumulative. Additive: an older bridge does not send it (the game then shows the share and the window only). |
| `context_window_estimated` | #101: `true` when `context_window` was **assumed** (the model table's, or its family's), `false`/absent when it was seen (a `[1m]` on the model, context above 200K) or is the agent's own (Codex). Additive, as above. |
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
- Context: the main transcript's last message's prompt (`input + cache_creation + cache_read`: `context_tokens`) over
  the window. An estimate of what the next turn starts with, not Claude Code's own figure; subagents' contexts are not
  in it. The transcript does not say how big the window is (`message.model` has no `[1m]` even in a 1M session), so it
  is resolved, in this order: (1) a `[1m]` on the **main** transcript's model: 1M, not assumed; (2) the main context
  seen above 200,000 at any time: 1M, not assumed (it proves the long window, and stays through a `/compact` for as
  long as the main model does not change); (3) the model's `context_window` in the table: assumed; (4) the model's
  **family**, by id prefix, for a model the table does not list: `claude-opus-`, `claude-sonnet-` and `claude-fable-`
  1M, `claude-haiku-` 200K: assumed; (5) unknown (`null` share, 0 window). A subagent's `resolvedModel`, `settings.json`
  and the environment are not consulted: they are not the main session's (a `/model` or a launch flag overrides them). A
  table entry **with no window** (a `--pricing` override that leaves it out) is unknown at step 3, not the family's. The
  family fallback is for the window only: the model's price stays unknown (`priced` `unknown_model`).
- `/compact`: a `type: "system"`, `subtype: "compact_boundary"` line in the main transcript clears the context
  (`context_tokens` 0, `context_pct` `null`: the summary's size is not known, and the line's `preTokens` is the old
  context's) until the next main assistant message with usage; counts and cost carry on. `/clear` and `/new` start another
  agent session: the worker's usage follows that session (above).

**Codex** rollouts: `<--codex-sessions>/YYYY/MM/DD/rollout-*-<agent_session>.jsonl` whose first line's
`session_meta.payload.id` is the session. Codex does not report its session to herdr, so a live Codex worker usually
has no `agent_session` (until the sleep backfill tells herdr). For its usage the bridge then picks the rollout the
backfill would: the newest whose `session_meta.payload.cwd` is the worker's `cwd` and whose session no other worker of
its floor has (their own `agent_session`, or one picked this way first, in worker id order). It looks again every 30 s
(a newer rollout there, e.g. after `/new`, takes over) and remembers each rollout's first line, so a lookup reads only
new files. This is read-only and only for `usage`: herdr is not told, and the worker's `agent_session` stays empty.
Two Codex agents started in the same folder can get each other's rollout (so the context meter of one can show the
other's: a known limit, #101).

- The last `event_msg` of `payload.type: "token_count"` with an `info` holds the totals: `info.total_token_usage` with
  `input_tokens` (cached input and cache writes included), `cached_input_tokens`, `cache_write_input_tokens`,
  `output_tokens` (reasoning included: `reasoning_output_tokens` is not added again). One with `info: null` changes
  nothing. The model is the last `turn_context`'s `payload.model`; growth between two token counts is priced at the
  model active then, and counters that go down (a reset) start the sums over.
- Cost: per model, `(input − cached − cache writes) × input + cached × cache_read + cache writes × cache_write + output
  × output`. GPT-6's long-context rates (requests over 272K input tokens) never apply: Codex's window is 258,400.
- Context: Codex's own formula, `(last_token_usage.total_tokens − 12000) / (model_context_window − 12000)` (12K is its
  baseline), clamped to 0–100; `context_window` is `model_context_window` (never assumed: `context_window_estimated`
  false) and `context_tokens` is the raw `last_token_usage.total_tokens`, so **`context_pct` is not
  `context_tokens / context_window`** for Codex (50,000 of 258,400 is 15.4 %, not 19.4 %); the game's tooltip says so.
  A token count with no request in it (0) is unknown, not 0 %. A compaction (a top-level `compacted` line, or an
  `event_msg` `context_compacted`) clears the context until the next `token_count`.

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
Claude, GPT-6 Astra for Codex) and flagged `unknown_model`; a Claude one may still get a **window** from its family
(above). `gpt-6.1-sol` is not in the table either (its window comes from the rollout; its price is not verified here, so
it stays `unknown_model`). Older models seen in transcripts (`claude-opus-5`,
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
(not 30 s) when it is not found yet, and a Codex worker's rollout is picked again every 2 s. While any transcript is watched the tail reads every **1 s** instead of every 2 s, so a pasted screenshot is in the view within 3 s of its line being written (1 s to read it, at most 250 ms to push it, then the thumbnail). A `worker.prompt` that succeeded, and a watched worker turning `working`, have the tail read at once instead of on its next tick (#58): the prompt's `user` item is pushed in well under a second, the 250 ms between two pushes of a watch at most (`TestPromptEchoLatency`).

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
| `parts` | `user` / `assistant` / `thinking`: in order, each `{"text": markdown}` or `{"image": ImageRef}`. A `[Image #n: /path]` marker in a user's text is an image part of its own (`source: "path"`, resolved only under the roots below); the text around it stays. Thinking with no text (Claude's redacted thinking, Codex's encrypted reasoning with an empty summary) has no parts: a muted, non-expandable "reasoning" chip. Thinking with text is shown inline, dimmed and labelled "summary" (the agent's narration, not hidden by "Hide tool calls"). |
| `truncated` | a part's or the notice's text was cut for the list (`transcript.item` has it all) |
| `tool` | `tool` / `subagent`: `name` (Codex: `namespace.name` when namespaced), `input_summary` (the input's first line, at most 200 characters: the command, file path, pattern, URL…; Codex `exec` scripts: their first `cmd`; `apply_patch`: the files), `input` (the raw input as JSON; in lists only when at most 4 KiB), `status` (`running` until the result comes, then `ok`, `error` or `interrupted`), `output_text` (the result's text, at most 64 KiB in lists: then `output_truncated: true`), `images` (`[{"image": ImageRef}, …]`, the images in the result: what the agent viewed; the game shows them under the collapsed row, #70), `diff` (`{path, hunks, truncated?}`: Claude `Edit`/`Write`'s `structuredPatch`, a created file as all added lines; Codex `apply_patch`, whose hunks have no line numbers: 0), `diffs` (every file, when a patch changes more than one; `diff` is the first). Diff lines are capped at 64 KiB in lists (`truncated`). |
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
  #151: the MCP calls an `exec` script makes have no response item, only `event_msg` `item_started` /
  `item_completed` with an `McpToolCall` item (`id` `exec-<uuid>`, `server`, `tool`, `arguments`, `status`, `result`
  `{content, isError, structuredContent}` or `error {message}`, `duration`): a `tool` item named `server.tool` whose
  id is the item's (a completion alone is enough; a start is `running`, and one id is one row, also when a response
  item has it). `failed`, `isError` and `error` are `error`; the output is the result's text parts (else its
  `structuredContent`, else the error's message). The duration is not shown. The other item types (`Reasoning`,
  `CommandExecution`, `AgentMessage`, …) stay hidden.
  `compacted` is a `compaction` (its `replacement_history` is never read). `event_msg` `turn_aborted` is a notice and
  interrupts every call still running; `task_complete` a notice ("Turn took 13.8s"); `error` a notice.

**Hidden** (sent with `hidden: true`, as `notice`s whose `source` is the type):

| Claude Code | Codex |
|---|---|
| every `attachment` line (reminders, hook context, tool lists, dates…), **except** a prompt the user queued while the agent worked (`queued_command` from a human): that is a `user` item | `message` of role `developer` (or `system`) |
| `isMeta` user lines (skill bodies, caveats) and user text that is only `<system-reminder>` wrappers (wrappers are cut from other text) | the injected user context: `# AGENTS.md instructions…`, `<environment_context>`, `<user_instructions>` |
| metadata lines: `last-prompt`, `mode`, `permission-mode`, `bridge-session`, `atis-latch`, `ai-title`, `custom-title`, `agent-name`, `cost-state`, `pr-link`, `file-history-*`, `queue-operation`, `frame-link`, `artifact-*`, `summary`, `progress`, `tag` | `session_meta`, `turn_context`, `world_state`, `token_usage_record`, `inter_agent_communication_metadata` |
| `system` `stop_hook_summary`, and a `local_command` with no output | `event_msg`s that repeat response items or keep books: `token_count`, `item_completed` (but an `McpToolCall`'s, a `tool` item), `thread_settings_applied`, `task_started`, `user_message`, `agent_message`, `agent_reasoning*`, `exec_command_*`, `patch_apply_*`, … |

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

#98: the **thumbnail** of the image a worker's `activity` shows now (`kind: "image"`) is served without a watch, to a
connection that stands on the worker's floor (see [Activity](#activity)): `{id, hash, size: "thumb"}` with `hash` equal
to the worker's current `activity.image.hash`. Any other hash, `size: "full"`, or a connection not on that floor gets
the rules above (no watch: `invalid_state`). At most 8 such reads are in flight over the bridge (`busy`).

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
- A watch's pushes come only after its ack: the old watch sends nothing once the new `transcript.watch` is taken, and
  the new one pushes only what changed after its ack's page. So a `transcript.items` for a worker that arrives while
  its (re-)watch's ack is still to come is from the watch it replaced (or one unwatched) and older than the ack's
  items: drop it, the ack has it.
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
action; to Claude it is typed like `worker.prompt`'s, #95, once herdr no longer sees the agent `blocked`, within 5 s). It is `stale` when the worker has no ask or another `tool_use_id` (answered in the terminal meanwhile, or
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
pressed; for `other`, notes open on "None of the above" that are empty take the text, then Enter, notes holding exactly
that text take Enter, and notes holding anything else are `input_failed`, nothing pressed (Enter would submit them).
The dialog is the ask's when it shows one of its questions (its text) with its options (each option row shown has
that option's label), or (Claude) its review with a tab per question header and each question's text listed in its
place (however it wraps; cut, its start; a review cut too short to tell, or listing fewer, is not the ask's). After the last key (the one question's,
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

### Follow-up questions

#90. An agent often ends its turn with free text that asks you things ("## Open questions for you …"). That is no
AskUserQuestion (#57 has no card for it) and herdr says `idle` or `done`, so the bridge looks at the final message of
every turn, **once the feature is switched on and both AI models are `ready`** (see [AI integration](#ai-integration)),
and flags the worker as needing you with the questions it found.

```json
"followups":{"enabled":true,"threshold":0.7,"state":"ready","roles":{"classifier":"ready","llm":"ready"},"env":[],"tested":true}
"followup":{"turn_id":"3f9c1a7b2e4d6a80","score":0.96,"source":"model","at":1790859600000,
  "questions":[{"id":"q1","question":"Does the legacy importer still need the v1 format?","kind":"yes_no"},
               {"id":"q2","question":"Ship this already, or wait for the e2e-live run?","kind":"choice","options":["Ship now","Wait for e2e-live"]}]}
```

**Settings** (bridge-wide, in the database): `followups.get` answers them, the snapshot's `followups` holds them,
`followups.update` carries them flat.

- `enabled` is off by default: configuring the AI integration does **not** switch it on (a model set up for another
  feature must not start sending every agent's final message anywhere). `HERDR_WORLD_FOLLOWUPS_ENABLED` /
  `--followups-enabled` (`true` / `false`) wins over the stored toggle and lists `enabled` in `env`; changing it then is
  `env_locked`.
- `threshold` (default 0.7, 0.05–0.99): the classifier's score at which a message asks something.
- `state`: `off` (switched off), `incomplete` (on, but a model is not `ready`: `missing` lists `classifier` / `llm`;
  nothing runs), `ready`. **Only `ready` runs the pipeline**; with anything else there are zero calls on turn end. A
  model that turns `invalid` at runtime (a rejected key) pauses it with the `ai.update` that says so (a
  `followups.update` follows). `roles` are both models' states, for the panel's status line.
- **`followups.test`** runs two sample messages (one ending in open questions, one "Done, PR merged.") through the
  whole pipeline with the models in use: it passes when the first scores at or over the threshold and the LLM lists its
  questions, and the second scores under it. A test that ran but did not pass is `ok: false` with `reason` (and the
  scores); a call that failed is its error (`auth_failed`, `timeout`…; `incomplete` without both models `ready`).
- **`followups.set {enabled: true}` needs a passing test** of the models in use (their config fingerprints, as `ai.set`
  does) from the last 30 minutes, else `test_required` (`incomplete` while a model is not ready); `tested` says whether
  one covers them now. Switching off and the threshold need none.

**Detection.** The usage tracker's tail of every Claude and Codex worker's transcript (the same lines as the ask and
wrap-up trackers, parsed once for both turn trackers) gives the latest turn's final assistant message: Claude's last
assistant message id with text, ended by its `stop_reason` (not `tool_use`) or `system/turn_duration`; Codex's last
assistant `response_item` (else `task_complete`'s `last_agent_message`). A new prompt (typed or queued), a tool result or
`task_started` resets it; an interrupted turn (`[Request interrupted by user]`, `turn_aborted`) has none. Then:

1. It waits until the ended turn and herdr's not-`working` status both held for 2 s.
2. It skips (no call at all): the feature not `ready`; an `ask` pending (#57 covers it); the worker `blocked` (its
   `question` covers it); a freelancer (`code`, `review`, `ux`, `ground`: their questions are for the orchestrator, and
   a real need for a human comes through the report's `input_required`); a harness other than Claude or Codex; an
   empty message. Orchestrators and regular workers are looked at.
3. **Gate**: the classifier scores `state {"last_agent_message": <the message's last 96,000 characters, ~24k tokens at
   4 characters a token>}` for "Does the message ask the user one or more questions or decisions they are expected to answer, even when the agent proposes a recommended answer for each?". Under the
   threshold: nothing, and no LLM call.
4. **Extract**: the LLM (JSON mode) lists `{"questions":[{"question","kind","options"}]}`, validated strictly: 1–8
   questions, each 1–300 characters (whitespace folded), `kind` `yes_no`, `choice` (2–8 options of 1–120 characters)
   or `open`; options of the other kinds are dropped. Anything else, or an LLM failure, is the **fallback**: one `open`
   item ("The agent asked you something") with the message's last 1,200 characters as `tail`. A positive gate is never
   dropped.
5. **Once**: each message looked at is recorded by worker and SHA-256 (`followup_seen`, with its follow-up while it is
   open, the last 20 per worker). A restart or a re-read never classifies it again; an open follow-up comes back as it
   was, a cleared one never. A classifier failure is not recorded (logged; a later restart may try again).

The calls run off the hub goroutine, under the AI integration's bounds (two calls in flight over the whole bridge).
`turn_id` is the message's first 16 hex SHA-256 digits.

**Clearing.** `followup` goes (the worker's upsert, the record cleared) when it is answered, dismissed, on any
`worker.prompt`, `worker.keys` or answer to it, when herdr says `working` again, when the transcript goes on to a new
prompt or turn (however short: herdr may never report it `working`), and when the worker is gone. A result that comes
back after one of these (or after a new prompt was read, or after herdr said `working` while it was being looked at,
even when the worker is idle again by then) is recorded but not shown. The feature's state is checked again before the
extraction: switched off or a model `invalid` while the classifier ran, the message never goes to the LLM.

**Answering.** **`worker.answer_followup {id, turn_id, answers: [{id, value, note?}]}`** is `stale` unless the worker's
follow-up is of `turn_id` (answered, dismissed or a newer turn meanwhile), `bad_request` for an unknown or repeated
question id, an empty answer, a `yes_no` value other than `Yes` / `No` (any case), or a value or note over 4,000
bytes. It sends **exactly one prompt** through `worker.prompt`'s lane and rules (typed for Claude, #95; queued for an
agent at work; `invalid_state` with an `ask`), checked again when its turn on the lane comes, and clears the follow-up
once it went:

```
Answers to your open questions:
1. Does the legacy importer still need the v1 format? → No
2. Ship this already, or wait for the e2e-live run? → Wait for e2e-live <optional note>
```

Only the answered questions are listed, numbered as asked; a note follows its value after a space. A fallback's one
free answer is sent as it is. **`worker.dismiss_followup {id, turn_id}`** clears it (`stale` likewise). The audit log
keeps the ids and each answer's lengths, never the text.

**Privacy.** With the feature on, every agent's final message goes to TypeSafe (the classifier), and to the configured
LLM endpoint when the classifier says yes. Messages can contain code, paths and internal details: that is why it is
opt-in on its own toggle, only the final assistant message is sent (never the transcript or tool output), and the
game's Settings say so above the toggle. A self-hosted OpenAI-compatible endpoint keeps the extraction in-house.

The game ORs `followup` into needs-you (the counts, N, the desk's NEEDS YOU and its card: "N questions: answer at the
laptop (E)"), and the transcript view pins a card above the prompt box, which stays on (typing a prompt there clears
it): a tab per question, Yes / No and a note, a choice's options and Other, a text for an open one, Send answers and
Dismiss, and "Detected automatically". Keys: digits pick and ← → change question (on the timeline and the tab list,
which is one Tab stop); Tab moves the focus through the card to Dismiss, Send and the prompt box; Enter sends from the
card's options and texts, while on the timeline it goes to the prompt box as ever. On a very short screen (a phone's
laptop) the timeline and the strip fold away while the card is up, and the card scrolls above a one-line prompt box.

### Pack up on request

#110. A prompt you send a worker sometimes also tells it to leave once the task is done ("make a PR, then go home and
clean up the worktree"). With the feature on, the game asks the bridge before such a prompt goes out; the leaving part
is cut from what the agent reads, only the task is sent, and the worker is sent home after it. **You confirm, always.**
Two models do it, both from the [AI integration](#ai-integration): the classifier answers one yes/no question, the LLM
says which parts to remove. Nothing is sent to a model until the toggle is on and both models are `ready`.

```json
"packup":{"enabled":true,"threshold":0.85,"state":"ready","roles":{"classifier":"ready","llm":"ready"},"env":[],"tested":true}
{"t":"packup.detect","req_id":"d1","args":{"id":"<worker>","text":"Please make a PR and end your turn"}}
{"t":"ack","req_id":"d1","data":{"matched":true,"task":"Please make a PR","removed":[{"start":16,"end":34}],"score":0.97}}
```

**Settings** (bridge-wide, SQLite `packup_settings`): the follow-up questions' shape and rules. `packup.get` answers
them, the snapshot's `packup` holds them, `packup.update` carries them flat (its own event type: the fields are
`followups.update`'s).

- `enabled` is off by default; configuring the AI integration does not switch it on. `HERDR_WORLD_PACKUP_ENABLED` /
  `--packup-enabled` (`true` / `false`) wins over the stored toggle and lists `enabled` in `env` (`env_locked`).
- `threshold` (default **0.85**, 0.05–0.99): high on purpose. A false positive costs one dismiss of the confirm, a
  false negative is the behaviour without the feature. The default is a conservative pick, not yet calibrated against
  the real models: run `packup.test` with them and move it with its results.
- `state`: `off`, `incomplete` (`missing`), `ready`; only `ready` runs, a model `invalid` at runtime pauses it.
- **`packup.test`** runs the labelled sample prompts (`internal/packup` `Samples`: the ticket's four examples, then
  paraphrases, another language, and prompts that stop, end, clean up or leave something inside the task) through the
  classifier at the threshold, and the core matches through the LLM too. It passes when the four core samples come out
  as expected (each match cut to its exact task); `right` of `total` says how many of all came out as expected, for
  choosing the threshold. A pass covers the models in use for 30 minutes, as `followups.test`'s does, and
  **`packup.set {enabled: true}` needs one** (`test_required`).

**Detection: `packup.detect {id, text}`.** The game sends it when you press Send in the laptop's prompt box or the P
overlay, with the feature `ready` and the worker one it applies to; the prompt waits meanwhile, **1.5 s at most**: past
that the game sends it as written and drops a later ack, a match included. Then, on the bridge, off the hub goroutine
and bounded at **1.2 s** (so its answer has 0.3 s to reach the game):

1. **Skip** (no call, `matched: false`): the feature not `ready`; a freelancer; a worker without a Claude or Codex
   agent (the wrap-up's rule: only those can be sent home after a task). Unknown worker: `unknown_worker`; an empty or
   over-16-KiB text: `bad_request`.
2. **Gate**: the classifier scores `state {"prompt": <the text's last 8,000 characters>}` for "After the task, does the
   prompt tell the AI coding agent to wrap up and leave (go home, leave the office, clean up its worktree, end its
   session)?". Under the threshold:
   `matched: false`, no LLM call.
3. **Cut**: the LLM (JSON mode) lists `{"remove": ["..."]}`, the **spans to remove**, never a rewrite. Each must be an
   exact substring of what the models saw, found in order (each after the one before), and 1–8 of them, each not blank.
   They are cut out of the text; at each join the spaces go, a separator (`, ; : – —`) left dangling before the end or
   before punctuation goes, and the pieces meet with one space or the line break one of them has. The task's own words
   never change. `removed` is the cut parts, `[start, end)` in **UTF-16 code units** of `text` (JavaScript's string
   indexes). Nothing left of the text: `matched: true` without `task` (the game opens the send-home dialog).
4. **Fail open**: bad JSON, no span, a span not in the text or out of order, a classifier or LLM failure, the 1.2 s
   gone: `matched: false`, and the game sends the prompt as written. **A failure never eats a prompt.**

Image markers (`[Image #n: path]`, #64) are protected: the models see each as `[Image #n]`, never its path, and a span
over one is invalid (no match). The prompt is never logged, nor is a model's error text (a provider may quote the
prompt in it; the log has only a fixed code: the failure's kind, or `llm_<kind>`, `bad_answer`, `bad_part` for the cut),
and the audit log keeps only its length. The readiness is
checked again before the LLM: switched off or a model `invalid` meanwhile, the prompt never goes to it.

**Confirm** (the game): a match always opens the send home's pack-up mode, "Send the task, then send <name> home": the
prompt as you sent it with the cut parts struck out, the task in an editable box, the worktree choice preselected to
the worktree and its branch (`delete_branch`), else the worktree (`delete`), else `keep`, with the send home's warnings
(a dirty or unpushed tree, a branch herdr-world did not make). **Send and go home** is a `worker.wrapup` (see
[Wrap up](#wrap-up)) with `prompt` = the task, a blank line, and the cleanup request ("Once that is done: Stop every
server, background process, pane and freelancer you started in this session. Don’t touch anything else."); the bridge
adds its footer, whose BLOCKED covers a task that did not complete, and on CLEAN sends the worker home through
`worker.fire`'s strict teardown (a tree that changed meanwhile: `not_clean`, the worker stays). **Send as written
(stay)** sends the original through `worker.prompt`. Cancel and Esc send nothing; the draft stays. While the check runs
the composer shows "Checking the prompt…", keeps the draft read-only and sends nothing on another Enter; Esc then
cancels the send. Prompts typed straight into herdr (the terminal) are not looked at.

**Privacy.** With the feature on, every prompt you send a Claude or Codex worker from the game goes to TypeSafe (the
classifier), and to the LLM endpoint when the classifier says yes, before it is sent. Images are never sent. That is
why it is opt-in on its own toggle, and the game's Settings say so above it.

### Activity

#98. The desk monitor says what each agent is doing right now, in one word, with a short detail and, when the agent
looks at an image, that image. The bridge works it out for **every** Claude and Codex worker (not only watched ones)
from the transcript lines the usage tracker already reads (the same tap as the ask, wrap-up and follow-up trackers,
parsed by the transcript parsers), and sends it in the worker:

```json
"activity":{"kind":"testing","detail":"pytest -n auto","since":1790881200500,"source":"rule"}
"activity":{"kind":"image","detail":"needs-you-desk.png","since":1790909303541,"source":"rule","image":{"hash":"9f2c…","w":1280,"h":720}}
"activity":{"kind":"waiting","detail":"Testing in the background","since":1790882452331,"source":"derived","tasks":5}
```

| field | |
|---|---|
| `kind` | `thinking`, `replying`, `writing`, `investigating`, `testing`, `building`, `shipping`, `researching`, `delegating`, `planning`, `waiting`, `image`, `working` (a client treats one it does not know as `working`) |
| `detail` | short and safe, at most 32 characters (40 for waiting while idle): a file's basename (`a.ts +1` for more), a test runner (`pytest -n auto`), a command's head, clipped and scrubbed; never a whole command line, never a commit message. Waiting while idle: `<Kind> in the background`, `Running in the background`, `Monitor: <description>`, `Subagent: <description>`, `Wakes at 14:05` (the bridge's local time) |
| `since` | when this label started, unix ms (bridge clock); waiting while idle: when the turn ended |
| `source` | `rule` (the rules placed the tool call), `model` (the classification model placed its command), `derived` (the turn's state: thinking, replying, waiting while idle) |
| `image` | `{hash, w, h}`, `kind: "image"` only: fetch its thumbnail with `transcript.image` (below) |
| `tasks` | waiting while idle only: how many background tasks are open |

**While `working`** (#58's policy, on the bridge; anything else but idle or done has no activity: `blocked` has its
`question`, an `ask` its card):

- Only the **current turn** counts: a prompt or Codex's `task_started` opens it, Claude's `system/turn_duration` or
  Codex's `task_complete` closes it, and herdr reporting `working` after an `idle` or `done` that began once the turn had
  opened starts a new one there (a turn with no prompt line, such as a wake by a task notification). The previous
  turn's last tool never shows.
- A **running** tool of the turn (the latest started: concurrent calls may be earlier than the last item) is its rule
  label; a **finished** one keeps it 1.5 s, then **Thinking**. A prompt, a thinking or reasoning item, or nothing yet is
  **Thinking**; assistant text is **Replying**; a synchronous subagent is **Delegating** (an `async_launched` one is
  done at once). `Skill`, `ToolSearch` and other meta tools, and the ask tools, keep the current label.
- A label stays at least **1.5 s**. An **image** a tool result of the turn viewed (`origin: agent`, `kind: viewed`: a
  Claude `Read` of an image, a Codex `view_image`, a Codex code-mode `exec` with `tools.view_image`) or the agent
  generated stays **6 s**, or until the next image or the turn's end.

**The rules** (pure, local, nothing sent): the tool name first (`Write`/`Edit`/`MultiEdit`/`NotebookEdit`/`apply_patch`
writing with the file's basename; `Read`/`Grep`/`Glob`/`LS` investigating; `WebSearch`/`WebFetch`/Codex `web*`
researching; `Agent`/`Task`/`Workflow`/`spawn_agent` delegating; `TodoWrite`/`EnterPlanMode`/`update_plan` planning;
`Monitor`/`TaskOutput`/`ScheduleWakeup`/`wait_agent` waiting), then the shell: Claude's `Bash` command, Codex's
`exec_command` cmd and legacy `shell` argv (`bash -lc cmd` unwrapped), and in a Codex code-mode `exec` script **every**
nested `tools.<name>(` call (`view_image` is an image, `apply_patch` writing, then the shell rules over every
`exec_command`'s cmd; only `write_stdin`, `wait` or `sleep` is waiting). A command line is split on `&&`, `||`, `;`, `|`
and line ends (quote aware, a heredoc's body with its command); `cd`, `export`, `VAR=val`, `env`, `time`, `timeout N`,
`sudo`, `nice`, … and the runners `uv run`, `poetry run`, `pnpm exec`, `npx`, `bunx`, … are taken off; each command is
placed by its head and arguments, and **the strongest wins**: testing > building > shipping > writing > investigating >
waiting. A filter after a `|` says nothing, a redirect into a file (not `/dev/…`) writes, an inline script (`python3 -
<<'PY'`, `python -c`, `node -e`, `node --input-type=module <<`) is writing when its body writes a file, else
investigating; a polling loop (`until …; do sleep N; done`) is waiting, testing when it waits on a test log. Dev
servers (`portlease run … -- npm run dev`, `npm run dev`, `vite`, `go run`, `make dev`) are building, `agent-browser`
is testing. A Codex `write_stdin` poll of a session an `exec_command` started ("Process running with session ID N", a
code-mode result's `session_id`) keeps that command's label; an unknown session keeps the current one. What the rules
cannot place is **Working**.

**Waiting while idle** (Claude). A turn often ends on purpose while a `Bash` `run_in_background`, a `Monitor` or an async
subagent still runs, or after a `ScheduleWakeup`: herdr says `idle` or `done`, but the agent wakes up by itself. The
bridge keeps each worker's open background tasks: opened by the call's result (`toolUseResult.backgroundTaskId`;
`taskId` with `timeoutMs` and `persistent`; `isAsync` / `status: "async_launched"` with `agentId`; `scheduledFor`),
closed by a `<task-notification>` with that `<task-id>` and a final `<status>` (`completed`, `failed`, `killed`,
`stopped`, …; a Monitor's events have none and close nothing), in a `queue-operation`, a user line or a queued command,
by `TaskStop` (`KillShell`), when a Monitor's `timeoutMs` passes (unless persistent) or the wakeup's time, and after
2 hours. They are read from the whole transcript, so a bridge restart has them again. While herdr says `idle` or `done`
and one is open, the activity is `waiting` with `tasks` and a detail of what is awaited (the strongest label first: a
background `pytest` is "Testing in the background", a Monitor its description, a subagent its description, a wakeup its
time). When `working`, they do not change the label. Codex has no equivalent.

**Publishing.** The bridge publishes `activity` only on a change: in the worker's `worker.upsert` when its status
changes (so status and activity always agree), else as a **`worker.activity`** event, at most twice a second per worker
(a change in between goes out at the end of the half second). The snapshot's workers have it too.

**The image.** `transcript.image {id, hash, size: "thumb"}` serves the thumbnail (480 px, as the transcript view's) of
the hash in the worker's **current** `activity.image`, to a connection that stands on the worker's floor: it sent
`board.watch` for that floor (the game does for the floor you stand on, whether or not it has a board; `board.unwatch`
or a watch of another floor ends it), or it watches the laptop or the transcript of one of its workers. Nothing else:
another hash, a connection elsewhere, never a path.

**Classify unknown commands** (opt-in). The classification model (#92's classifier, Jev) can place the commands the
rules cannot (a script, a CLI the rules do not know). Its settings are bridge-wide, in the database; `activity.get`
answers them, the snapshot's `activity` holds them (absent without an AI integration), `activity.update` carries them
flat:

```json
"activity":{"model_enabled":false,"threshold":0.6,"margin":0.2,"daily_cap":2000,"calls_today":0,"cache_size":0,"state":"off","classifier":"ready","env":[]}
```

- `model_enabled` is **off by default**: configuring the AI integration sends nothing. `HERDR_WORLD_ACTIVITY_MODEL` /
  `--activity-model` (`true` / `false`) wins over the stored toggle and lists `model_enabled` in `env`; changing it then
  is `env_locked`.
- `state`: `off`, `incomplete` (on, the classifier not `ready`: nothing is sent), `ready`, `capped` (the `daily_cap`
  reached: rules only until tomorrow, the bridge's local day; the count survives a restart). `classifier` is the
  classifier role's state. Only `ready` makes calls; a cached answer shows while `ready` or `capped`.
- A command is asked about **once**: normalised first (anything after the first `<<` dropped but a heredoc's
  delimiter, whatever it is: quoted or not, digits and punctuation too; after a here-string's `<<<`, an open quote or
  a delimiter over 24 bytes, all of it; `VAR=` values,
  absolute paths to their basenames, run ids, hex ids and numbers taken out, scrubbed of keys and tokens, at most 400
  bytes), and its answer cached by the SHA-256 of the tool and that text (the newest 2,000, in the database: never the
  command's text). The same normalised command again is the cache's answer, with no call.
- One call asks all the kinds at once, `state {"tool", "command"}` (the normalised text: never the tool's output), one
  `noul` question per kind (investigating, writing, testing, building, shipping, waiting, researching). The top score
  wins when it is at least `threshold` (default 0.6) **and** beats the runner-up by `margin` (default 0.2); otherwise
  it stays `working`. The answer shows as `source: "model"` while that call is still the worker's current one.
- **Budget**: at most **one** call in flight (the AI integration has two slots for every feature, so #90 always finds
  one), only for a worker that is `working` on a floor a client stands on, and a candidate that is no longer current
  when the slot frees (its tool finished and a newer item replaced it) is never asked about, nor one of a turn that is
  over (herdr is working again and the new turn is not read yet).
- **Switching it off** (`activity.set {"model_enabled": false}`) cancels a call still waiting for a slot or out, and
  is acknowledged once that call is over: nothing is sent after the ack. The day's count is saved apart from the
  settings, so a call counted meanwhile never undoes them (the toggle stays off after a restart).

**Privacy.** Rules run locally and send nothing. With "Classify unknown commands" on, the text of shell commands the rules
can't place goes to TypeSafe (Jev). After normalising and scrubbing it can still contain paths, hostnames or script
names. It is opt-in, separate from configuring the AI integration, never includes tool output, and the Settings section
says so above the toggle.

### Floor overview digest

#118: every Claude and Codex worker's `digest` is what the floor overview (the lounge's wall screen and its page)
says of it, on one line each. The bridge reads it from the worker's transcript, on the same tap as asks and activity
(`transcript.DigestTracker`), and sends it in `worker.upsert` and the snapshot, only when a line or a source changed
(a prompt, an ai-title, a recap, the first step: rarely). The task goes out as soon as it is known (the first prompt
is enough); the now line only once the transcript has an assistant step: before it, `now_source` is absent and a
client shows no now line. A worker with neither a prompt nor a step has no digest.

| field | | |
|---|---|---|
| `task`, `task_source` | string ≤ 80 chars, optional | what the worker was asked to do. `ai_title`: Claude Code's own `ai-title` metadata line (the latest); `prompt`: else the first genuine prompt (system reminders out, a paste unwrapped, `[image]` for an image marker) cut to its first sentence, or (#174), when that sentence says nothing of the task ("Please investigate.", "Please create a ticket."), joined with the sentences after it up to and including the first that does (greetings left out, a leading "please" dropped), at most 80 characters. Codex has no ai-title: `prompt` only. A slash command counts as the prompt `/name args` only when it has arguments. Absent when there is neither. |
| `now`, `now_source` | string ≤ 100 chars, `now_source` set from the first assistant step | what it is doing now. `recap`: Claude Code's latest `system/away_summary` (without its "(disable recaps in /config)"), only while no prompt, turn start or assistant step came after it; `now_at` is its time (unix ms). `title`: no `now` text: the line is the worker's own `title`, which moves on the hot `worker.status` path and is never copied into the digest. |
| `now_at` | int, optional | unix ms the `now` line was written (`recap` only) |
| `task_status`, `now_status` | object, optional | #174: what became of the model's line while a fallback is shown in its place (never with source `llm`; absent while nothing is awaited or the feature is off or not ready): `{"state": "pending"\|"retrying"\|"failed", "reason"?, "attempts"?, "retry_at"?}`. `pending`: a call is out, or it waits for the daily budget (`reason` `daily_cap`); `retrying`: the last attempt failed and the next goes at `retry_at` (unix ms); `failed`: it failed and nothing is scheduled by itself (the task: its attempts are used up; the now line: it waits for the next turn). `reason` is the failure's kind: `truncated`, `empty_answer`, `bad_response`, `provider_failed`, `timeout`, `rate_limited`, `auth_failed`, `unreachable`, `bad_config`, `no_line` (the answer held no line) or `failed`; `attempts` how many calls failed. A client shows it beside the line and offers `digest.retry` |

`llm` is the source of a line the configured LLM wrote, with [floor overview summaries](#floor-overview-summaries) on:
it takes the place of `ai_title` / `prompt` (a one-off worker's task) or `recap` / `title` (the now line; `now_at` is
when it was written), and a client marks it as written by a model. Off, not ready or failing, the lines above show.
`/clear` (and another agent session) starts the digest over: no task, no
recap, absent again until the next prompt or assistant step. The bridge also keeps, per worker, the first prompt and a ring of
the last 5 assistant steps (their texts, and their tool calls as name and input summary; never a tool's output, never
thinking), what the summaries are written from; it is sent only with them on.

### Floor overview summaries

#118 phase 2. With the feature on, the configured LLM (the [AI integration](#ai-integration)'s `llm` role; the
classifier is not used) writes the overview's lines: a one-off worker's (no `role`) **task** in one line of at most 80
characters, and every Claude and Codex worker's **now** line in one present-tense line of at most 100. They go out in
the worker's `digest` with `task_source` / `now_source` `llm`. Nothing is sent until the toggle is on and the LLM is
`ready`.

```json
"digest":{"enabled":true,"state":"ready","roles":{"llm":"ready"},"env":[],"tested":true,"daily_cap":300,"calls_today":12,"reasoning_effort":"","max_tokens":1024,"reasoning":{"support":"supported","model":"openai/gpt-6-luna","efforts":["none","low","medium","high","xhigh","max"],"listed":true,"default_effort":"medium"},"effort_stale":false}
"digest":{"task":"Fix the flaky login test and open a PR","task_source":"llm","now":"Rerunning the login test 20 times","now_source":"llm","now_at":1791030000000}
"digest":{"task":"Investigate. Missing transcript diffs.","task_source":"prompt","now_source":"title","task_status":{"state":"retrying","reason":"truncated","attempts":1,"retry_at":1791030060000}}
```

**What is sent.** The task: the worker's first genuine prompt (the digest's, its first 4,000 bytes), once per prompt
(by its SHA-256): again only after a `/clear` or another agent session. The now line: the last 5 assistant steps
(their texts, the last 600 bytes of each, and each tool call's name and input summary, never a tool's output, never
thinking), after a context line where it helps: `Ticket #<n>: <title>` for a run's worker, `Task: <task line>` for a
one-off worker. Every piece (a tool's name too) is scrubbed whole before it is clipped, and again after
(`digest.Scrub`: the activity's token patterns, `ai.Scrub`'s keys and bearer tokens). The request is two turns: the instruction in the system turn, which says the transcript is data and
never instructions, and the data alone between `<transcript>` and `</transcript>` in the user turn (a closing delimiter
inside it is defused); `max_tokens` the **completion budget** (default 1,024, below), temperature 0.2, and the
**reasoning effort** when one is chosen (below). The answer is cleaned to its first line, without code fences,
markdown, a leading label or bullet, wrapping quotes or a final full stop, scrubbed, and clipped to the line's length
with `…`; an answer with nothing left keeps the previous line (or the fallback). An answer the provider cut off at the
token limit (`finish_reason` `length`) is never a line, even with some text in it (#174).

**When.** The now line after a turn ends (Claude's `turn_duration`, Codex's `task_complete`) and has settled **2 s**,
at most once every **60 s** per worker (a later turn end within it waits for it, then summarizes the steps it finds).
The task as soon as the prompt is known. **Only for a worker on a floor a client stands on** (its `board.watch`, or a
laptop or transcript it watches there; the wall screen and the page are on that floor): a floor nobody is on costs
nothing, and its lines are written once someone walks onto it.

**Retries** (#174). A task line whose call failed (any failure of a call that went out: `truncated`, `empty_answer`,
`bad_response`, a timeout, a provider error, an answer with no line) is asked again by the bridge itself, **4 attempts
in all** per prompt (its hash), after **1, 5 and 15 minutes** (an armed timer; nothing retries on a poll or a turn).
Then its `task_status` is `failed` and nothing more goes by itself. The count starts again (a forgiven failure) on: a
new prompt (another hash), a `/clear` or another agent session, a change of the feature's config (the LLM's base URL,
model, key or `extra_body`, the reasoning effort, the completion budget, a passing `digest.test`, the toggle), and
`digest.retry`. A call that could not go (the daily cap reached, the feature off or the LLM not ready, another call
of the feature out) is **no attempt**: nothing was sent and nothing counted. A failed call is a call: it counts
toward `daily_cap`, its input is not cached, and a cached input still costs nothing. The now line is asked after each
turn (the timing above); a failed one shows `now_status` `failed` until the next turn or `digest.retry`. A retry,
like every call, is one at a time and for a floor someone is viewing.

**Cost.** One call at a time for the feature (the AI integration's other slot stays free for the follow-up questions
and pack up); `daily_cap` calls a day (default **300**, 1–10,000; `calls_today` counts them, the bridge's local day),
past it no call until tomorrow (or a higher cap) and the lines written stay, a cached line still applies, and a line
that waits for the budget is written once there is some again; and a cache of the lines by the SHA-256 of what is sent, in
SQLite `digest_cache (key, line)`, the newest 2,000: the same input again (a restart's re-read of a transcript
included) costs nothing. Only the hash and the line are stored, never a transcript's text.

**Settings** (bridge-wide, SQLite `digest_settings`): `digest.get` answers them, the snapshot's `digest` holds them,
`digest.update` carries them flat.

- `enabled` is off by default; configuring the LLM does not switch it on. `HERDR_WORLD_DIGEST_ENABLED` /
  `--digest-enabled` (`true` / `false`) wins over the stored toggle and lists `enabled` in `env` (`env_locked`); it
  still needs the LLM `ready`.
- `state`: `off`, `incomplete` (`missing: ["llm"]`), `ready`; a cap reached is `ready` with `calls_today` ≥
  `daily_cap`.
- **`reasoning_effort`** (#174; `""`, the **provider's default**, nothing sent, unless chosen) and **`max_tokens`**
  (the **completion budget**, 64–16,384, default **1,024**) are this feature's own settings: the follow-up
  questions, pack up and classification keep their own limits and send no effort, and the AI integration's
  `extra_body` stays what it is. The budget is the provider's `max_tokens`: the most the model may generate for one
  line, **reasoning included**; it is not the line's length (task 80, now 100 characters). A reasoning model that
  spends it all thinking answers with no text and `finish_reason` `length`. The bridge sends **one** effort control, the
  top-level `reasoning_effort` (OpenRouter, OpenAI, LiteLLM, vLLM and Ollama accept it); the endpoint's `extra_body`
  `reasoning` object is dropped from a request that carries an effort, and left alone when none is chosen. An
  The budget sent for the **summaries** is always this setting's, in the field the `extra_body` names: with `max_completion_tokens` there it is sent as `max_completion_tokens` (and no `max_tokens`), with `max_tokens` there it replaces that value, with neither it is `max_tokens`; the `extra_body`'s own number never shadows it. This holds for the summaries only: the connection test (`ai.test`'s 64-token probe), the follow-up questions and pack up keep deferring to a budget in the `extra_body` (`max_completion_tokens` over `max_tokens`), their own limit applying only when it names none. `reasoning` in the state is what the
  model's catalog says (`{"support": "supported"\|"unsupported"\|"unknown", "model"?, "efforts": [...lowest first],
  "listed", "default_effort"?, "mandatory"?}`, read from OpenRouter's `GET {base}/models` entry: `reasoning.supported_efforts`,
  `default_effort`, `mandatory`, else `supported_parameters`; other endpoints list ids only: `unknown`, offered the
  generic `low`, `medium`, `high`, and any effort the gateway knows is accepted by `digest.set`). `listed` says the
  efforts are the catalog's own allowlist: another is `bad_request`, as is any effort for a model with no reasoning
  and `none` for a mandatory one. A saved effort the model no longer takes is `effort_stale`: it is shown, **not
  sent** (the provider's default applies). A model the provider answers 400 to with an effort set is `bad_request`
  (`bad_config` in the audit), never silent. The test and the state's `tested` cover the LLM in use **and** the
  effort and budget it ran with: changing either needs a new test before switching on.
- **`digest.test`** has the LLM write a sample task line and a sample now line (one call at a time, not counted, not
  cached). It passes when both come back with a line. A pass covers the LLM in use for 30 minutes, and
  **`digest.set {enabled: true}` needs one** (`test_required`; the LLM not ready: `incomplete`). A sample's `diag`
  says how its call ended and what it spent (below), never any text.
- **`digest.retry`** (#174) makes a worker's failed lines due again (every worker's without an `id`): the task's
  attempts start anew and it is asked at once, the now line as if its turn had just ended. The ack's `retried` counts the
  lines; the feature off or the LLM not ready is `incomplete`.

**Audit and logs.** Each call writes an audit row `digest.summarize` (client `bridge`) with the worker, the kind,
`sent_bytes`, `answer_bytes`, the model and the endpoint's host, `reasoning_effort` and `max_tokens` as sent, and,
when an answer came back, its sanitized `diag` (#174): `{status, finish_reason?, native_finish_reason?, prompt_tokens?,
completion_tokens?, total_tokens?, reasoning_tokens?, content: "absent"\|"empty"\|"nonempty", content_chars}`; a count
the provider did not report is absent, a zero is a zero. The finish reasons are a known one (lowercase: `stop`, `length`,
`tool_calls`, `content_filter`, `error`, `end_turn`, `max_tokens`, …) or `other`: the provider's own text is never kept. A failure's error is its kind only (`truncated`, `empty_answer`,
`bad_response`, `timeout`, `no_line`, …): `truncated` is an answer the provider cut off at the token limit (an
empty `length` answer says how much of the budget went on reasoning), `empty_answer` one with no text, and
`bad_response` a malformed answer. Never the text sent or answered, nor any reasoning, nor a key. The log has the
failure's kind only.

### Ticket titles

#118: a run's `issue` and `work_item` carry the item's `title` and `url` when the floor's board provider has them, so
a client never builds a provider URL. They come from the floor's last good board (the card with the work item's id);
on a miss (no board polled yet, or a card no longer on it, e.g. closed long ago) the bridge reads the item once with
the provider (as `issue.get` does) and keeps the answer, hit or miss, for its lifetime: never asked again. The `url`
falls back to the provider's own link of the item. A poll that changes a card's title or URL sends `worker.upsert`
for every worker of that floor whose ticket it is. Without a board provider there is no title.

### Shared Codex server

#155 (epic #153, phase 2). With the switch on, a Codex worker hired from then on runs Codex's own terminal against a
Codex app-server **of its own**, started from its pane, which the bridge can join as a second client. The terminal
stays the place you work: herdr's start, prompt, read, wait and send-keys work on it as before. Off by default.

```json
"codex_server":{"enabled":false,"available":true}
{"t":"codex_server.set","req_id":"c1","args":{"enabled":true}}
{"t":"codex_server.update","seq":2210,"enabled":true,"available":true}
{"t":"ack","req_id":"c1","data":{"enabled":true,"available":true}}
```

**The switch** (bridge-wide, SQLite `codex_server_settings`): `codex_server.get` answers it, the snapshot's
`codex_server` holds it (always present), `codex_server.update` carries it flat. `codex_server.set {enabled}` needs
`enabled` (`bad_request`); switching on a bridge whose `available` is false (no `--codex-run` directory) is
`unsupported`. It applies to **new hires only**: every Codex worker keeps the mode it was launched with (SQLite
`codex_launch`), so switching never migrates, interrupts or relaunches a running worker, and a worker launched the
old way keeps today's exact resume. Claude hires are not affected.

**A shared hire** (`worker.hire` with `harness: "codex"` while the switch is on), in place of step 3's `agent start`:

1. Checks: `codex --version` is `codex-cli 0.160.x` (the release line #154 verified), the hire's directory (the
   worktree's checkout for a worktree hire) passes the launch's path rule (letters, digits and `._/+@,=:-`), and its
   `.envrc`, if any, is allowed (`direnv status --json`; a blocked one would leave the server without its variables
   and Codex would say nothing).
2. The bridge writes the worker's launcher, `<--codex-run>/<marker hex>.fish` (0600, directory 0700), and types
   `setsid -f fish <launcher> </dev/null >/dev/null 2>&1` into the pane (`pane run`): the server starts from the
   pane's initialized fish, so it has the pane's direnv exports, the user's `codex` wrapper function and herdr's
   `HERDR_PANE_ID` (whose session-id hook then reports to this pane). The launcher marks every process of the server
   with a random token, records its pid, and runs `codex app-server -c 'projects={"<dir>"={trust_level="trusted"}}'
   --listen unix://<--codex-run>/<marker hex>.sock` (the directory is trusted in memory; `config.toml` is not written).
3. The socket must answer within 20 s with a supported server (`initialize`'s `userAgent`, `…/0.160.x`); its process
   is found by its token and recorded with its start time.
4. `agent start <name> --kind codex --pane <pane> --timeout 30000 -- --remote unix://<socket> -C <dir> -m <model> -c
   model_reasoning_effort=<effort> --dangerously-bypass-approvals-and-sandbox`.

Any failure before step 4 starts the worker **the usual way** (step 3's `agent start`), stopping whatever of the server
started; the hire then succeeds with `codex: {"mode": "legacy", "note": "shared Codex server: <why>; started the usual
way"}` in its ack, and the worker carries the same `codex`. A step 4 that fails stops the server and falls back too when
the pane is back at its shell, else the hire fails (and rolls back). A successful one acks with
`codex: {"mode": "shared", "server": "running"}`. Codex's "Hooks need review" startup dialog (herdr reads it as idle) is
left for you: the hire's first prompt is then not sent (`prompted: false`, `prompt_error` says so).

**The thread.** The bridge keeps the thread id herdr's `agent_session` reports for the worker's pane. herdr forgets it
when the TUI exits and reports it again only after a resumed thread's first turn, so an empty one changes nothing, and
an id that is another worker's is never taken: two workers never share or swap a thread.

**The bridge's join.** While a shared worker's server runs and its thread is known, the bridge joins the thread as a
second app-server client (#156: whether or not its transcript is open, so an async question asked meanwhile is seen and
can be answered; #155 joined only while `transcript.watch` was open): `initialize` (client `herdr_3d`, the
experimental API on, the server's version checked), then `thread/resume` with the thread id **and nothing else** (no
model, cwd, sandbox, approval or instruction override: joining starts no turn and changes no setting), and
`thread/unsubscribe` when it leaves (the server stops, the thread changes, the worker is sent home). The join reads
the thread's history from the `thread/resume` response, and for a paginated thread one more page of up to 50 older
turns (`thread/turns/list`). A lost connection is retried with a bounded backoff (0.25 s doubling to 5 s, 8 attempts).
The bridge is **passive** towards server requests: it never answers one (command approvals, Codex's blocking
questions); the terminal does, and the first answer wins. Its only sends are `turn/steer` and `turn/start`, each on a
command of yours ([Codex async questions](#codex-async-questions)). `worker.codex.attached` says whether it is joined.
A join refused for good (an ephemeral thread, another thread, an unsupported server) is not tried again until the
transcript is opened, the thread changes or the worker has a new server; one that only spent its retries is tried again
after 60 s too. The transcript still comes from the rollout under `~/.codex/sessions`, as before.

**Lifecycle.** The server outlives its pane and herdr's `session stop`, so the bridge owns it:

- **Send home** stops it once the agent exited (only its token's processes, then its files), and forgets the launch.
  A shared worker's terminal that does not quit after `/quit` and the Enters gets **no** `Ctrl-C` (on a dialog the
  bridge did not expect it opens Codex's agent command center, which lists your other threads): the send home is
  `fire_failed`, nothing is closed and the server keeps running; quit it in its terminal and send it home again.
  #158: the one exception is a worker whose server is already gone (its pid gone or another process under it). Its
  terminal only waits to reconnect, ignores `/quit` and offers "ctrl+c quit"; it gets the `Ctrl-C`s a legacy worker
  gets, and with its server gone there is no turn to interrupt.
- **`floor.sleep`** quits each shared worker's TUI (`/quit`, Enter; #158: one `Ctrl-C` after them when its server is
  already gone, as above, else herdr would keep its session and resume it its own way on wake), waits until herdr no longer names its session
  (herdr forgets it a moment after the quit; a session stopped before would save the id and resume the pane its own
  way, without the server), stops the server, and only then stops the session. Shared workers are never backfilled
  (`report-agent-session`). The sleep's audit result lists them under `shared`.
- **`floor.wake`** resumes them itself, alongside herdr's own resumes: the pane back at its shell (a Codex herdr
  resumed its own way anyway is quit first), the server started again as above (a fresh token), then `agent start
  <name> … -- resume <thread> --remote unix://<socket> -C <dir> -m <model> -c model_reasoning_effort=<effort>`,
  **without** `--dangerously-bypass-approvals-and-sandbox` (a remote resume refuses any permission override; the thread
  keeps the permissions it was started with). Their `resume` is `fallback` ("relaunched"). A worker that slept
  before herdr reported its thread gets a **new** terminal attached to its server instead (the hire's `agent start …
  -- --remote …`); no thread is resumed or guessed.
- When the server does not start on wake (or the terminal does not attach and the pane is at its shell), the worker
  resumes its thread **on Codex's built-in server**: `agent start <name> --kind codex --pane <pane> --timeout 30000 --
  resume <thread> -m <model> -c model_reasoning_effort=<effort> --dangerously-bypass-approvals-and-sandbox` (never an
  argument-free `codex resume`, which would join the CODEX_HOME daemon), or starts the usual way when it has no
  thread; a "Trust this folder?" dialog is answered as a hire answers it. It stays shared, `server: "stopped"`, with
  `note: "shared Codex server: <why>; resumed without its own server, on Codex's built-in one"` (or `started …`); its
  next sleep and wake treat it as any shared worker and try its server again.
- The bridge checks each shared server every 3 s: one that died is `server: "down"` (herdr would still show the TUI as
  working: it waits to reconnect). Sleeping and waking the floor starts it again (verified through the bridge, #158:
  the sleep quits the waiting terminal with `Ctrl-C`, the wake resumes the thread attached to a new server).

Orchestrators that start Codex workers through the herdr CLI (write-code) bypass the bridge; such a worker is
launched the same way with the same two calls, `pane run <pane> '<server start>'` then `agent start … -- --remote
unix://<socket> -C <dir> …` (findings §8, D7). Until the skill adopts it, those workers stay embedded.

#### Codex async questions

#156 (epic #153, phase 3). Codex asks **async** questions with `request_user_input_async` and goes on working: the
terminal shows them as "Queued follow-up inputs · N questions", herdr shows the worker as `blocked` while the asking
turn runs ("Action Required"), and the tool's `{"accepted":true}` result only means the question was scheduled. This
is **not** a blocking ask: no `ask` ([Laptops: asks](#laptops-asks)), no screen `question`, and prompts keep working.
For a shared worker the bridge's join sees each question and can answer it in the same thread, while the turn runs or
after it ended (then only the bridge can: the terminal drops its pending questions when the asking turn ends).

```json
"codex":{"mode":"shared","server":"running","attached":true,"thread":"01a1112a-85b8-7bf2-…","turn":"01a1112a-9c23-…",
  "questions":[{"batch":"call_3","turn":"01a1112a-9c23-…","seen":["live","history"],"at":1790766523807,
    "questions":[{"index":0,"title":"Which fixture color?","options":["Green","Blue"],"state":"sent"},
                 {"index":1,"title":"Any context for the fixture?","state":"answered","answer":"typed-in-terminal","answered_by":"other"}]}],
  "async_blocked":true}
{"t":"worker.answer_async","req_id":"a1","args":{"id":"6db1905e-…","thread":"01a1112a-85b8-7bf2-…","batch":"call_3",
  "answers":[{"index":0,"answer":"Green"}]}}
{"t":"ack","req_id":"a1","data":{"state":"sent","via":"turn/steer","turn":"01a1112a-9c23-…"}}
{"t":"worker.dismiss_async","req_id":"a2","args":{"id":"6db1905e-…","thread":"01a1112a-85b8-7bf2-…","batch":"call_3","indexes":[1]}}
{"t":"ack","req_id":"a2"}
```

**The model.** `worker.codex.questions` lists the batches of the worker's thread (its `thread`; a `/new` in the
terminal is another thread, and the old one's questions go), oldest first, at most 32 (the oldest whose questions are
all answered or dismissed goes first, else the oldest). A **batch** is one async question message: `batch` is its id,
Codex's function `call_id`, the same live, in the history and after a cold resume; `turn` the turn that asked it; `seen`
how it was seen (`live`: the join's `item/completed`; `history`: the thread's turns read on a join), in order; `at` when
the bridge first saw it. Each question has its `index` in the batch, its `title`, and its `options` (suggested answers;
none: free text). `turn` on `codex` is the thread's running turn while attached ("" or absent: idle). Caps: a title
2000 bytes, 16 options of 1000 bytes, an answer 4096 bytes; `truncated` says one was cut.

| `state` | |
|---|---|
| `pending` | asked, not answered; `error` says why the bridge's last answer was refused, nothing delivered |
| `sending` | the bridge's answer is on the worker's input lane, its request in flight |
| `sent` | the server **accepted** the bridge's answer (`turn/steer` or `turn/start` returned). Not answered yet: a steered input is delivered with the turn's next model request. `unconfirmed: true`: no response came, so whether the server took it is unknown; it is **not** sent again (the server does not deduplicate: a second envelope is a second answer). `undelivered: true`: the turn it went to ended without it (below); it may be answered again |
| `answered` | a user message holding the reply envelope for this `(batch, index)` was seen, live or in the history: the bridge's, the terminal's or any client's. `answer` is the envelope's text, `answered_by` `bridge` (the user message carries a client id the bridge made, `clientUserMessageId` `herdr_3d-<hex>`) or `other` |
| `dismissed` | put away with `worker.dismiss_async`, in the bridge only: Codex still holds it, and a later envelope still makes it `answered` |

Only the envelope answers a question. The tool's `{"accepted":true}`, the turn ending and any other user message
(an ordinary prompt included) change nothing. What the protocol cannot prove stays a flag (`unconfirmed`,
`undelivered`, `twin`, `conflict`): `twin` names another batch
of the same turn with the same questions seen only the other way under another id (both kept: in every observed case
the ids were equal); `conflict: true` is an id whose live and history questions differ (the first ones are kept, and
it cannot be answered). A bridge restart forgets `dismissed` (the bridge's only) and rebuilds the rest from the
history, where only `answered` is visible (the envelope, with `answered_by` from its client id), **and from the
bridge's own record of its answers** (below), so an answer Codex may still deliver stays `sent`.

**Recovery.** The bridge joins every shared worker's thread while its server runs (above), so a question asked while
the transcript is closed is seen live. Every (re)join reconciles the history (the turns `thread/resume` returns, and
one more page of up to 50 older turns for a paginated thread) with what the bridge knew: new batches are added, known
ones keep their state, envelopes there answer theirs. `thread/resume` gives a client that was not subscribed the
thread's newest turn (running or interrupted) under its legacy item ids (`item-1`, `item-2`, …), not the question's
`call_id`; the join reads such turns again with `thread/turns/list`, which has the `call_id`. If that read fails, or
has nothing for the turn, the batch shows under its `item-N` id and the join is **unresolved**: that batch cannot be
answered (`invalid_state`: Codex does not know the id; answer in the terminal or wait), the bridge's records of its
answers are kept (below), and the bridge joins again after a minute (`CodexRejoin`) for as long as it stays so.
Unresolved is the join's (the history it read), not the questions shown: dismissing or dropping the `item-N` batch does
not clear it, only a join that reads every id does. Each join replaces the last one's `item-N` batches: those ids are
one join's. At most 32 batches are kept per thread (dismissed and answered ones dropped first, never one whose answer
is `sending`); a join reading more keeps the newest. Questions are kept per worker and thread, not per join: a lost
connection, a sleep and a wake keep them; send home forgets them.

**Across a bridge restart** (#158). Codex holds a steered answer in the running turn until its next model request, and
the history shows it only then, so the history alone would make such a question `pending` again and a retry would be
a second answer the model sees. The bridge therefore records every answer it sends, per question, in its store: the
`clientUserMessageId`, the turn it is steered into (none for a `turn/start`) **before the request goes out**, then the
turn it reached, or that no response came. On the next join, after the history, a question the history leaves
`pending` that has such a record becomes:

| Record | After the restart |
|---|---|
| the turn it went to is the thread's running turn | `sent`: a retry is `stale`; `undelivered` once that turn ends without it |
| the server confirmed it into a turn that is not running (it ended meanwhile) | `sent`, `undelivered`: it may be answered again, once |
| no response came | `sent`, `unconfirmed`, as before the restart: never sent again by the bridge |
| recorded, its response never recorded (the bridge stopped in between): a `turn/start`, or a steer into a turn that is not running | `sent`, `unconfirmed`: never sent again by the bridge. The history lacking its envelope is no evidence it was not taken: a turn the terminal starts at the same instant takes a `turn/start`'s input (the steer's fallback included) and shows it only with its next model request |

A record goes only on evidence that its answer can no longer be delivered, or was: an envelope naming its question
(live or in a join's history, whether or not the bridge still shows the batch), the server refusing the answer, the
thread changing, send home (or the worker no longer shared at startup), and, on a join, its batch missing from a
history that is the **whole** thread (no older turns left unread) with no `item-N` id. What the bridge shows is not
evidence: a batch dropped from the view (32 per thread, dismissed and answered ones first; never one whose answer is in
flight), dismissed, or under an `item-N` id keeps its record, and a join or live event that shows the batch again makes
it `sent` again. Nor is a history without the envelope of a send whose response never came (the table's last
row). So there is at most one record per
question the bridge answered, kept until one of those causes. A dismissed question's record is kept (the dismissal
itself is not), so after a restart it shows `sent`, not `pending`. What remains: a bridge that stops after recording
an answer and before its response is recorded shows it `sent` until the turn it was steered into ends (then
`undelivered`), or, for a `turn/start` or a steer into a turn no longer running, `sent`, `unconfirmed` until its
envelope shows (the terminal can answer it; the bridge never sends it again, even if the request never went out), and
an unresolved join keeps its `item-N` batch unanswerable until a join reads it: waits, never a second answer. A batch
the bridge no longer shows cannot be answered from the bridge (`stale`, unknown batch; the terminal can). A record the
store failed to write is logged and lasts only until the bridge stops: a restart before that answer is delivered
admits a retry, and the model can see the answer twice (the one window left).

**`worker.answer_async`** `{id, thread, batch, answers: [{index, answer}]}` answers one or more questions of one batch
in one envelope (the native format, which the terminal shows as an answer, not as raw text, and the transcript as the
user's input). Each `index` once; a question with `options` takes one of them exactly, one without any text that is not
blank (1–4096 bytes of UTF-8 without control characters but line ends and tabs). Refused before anything is queued:
`bad_request` (the answer does not fit), `unknown_worker`, `invalid_state` (not a shared worker, the batch is a
`conflict` or under a legacy `item-N` id (Recovery), or the bridge is **not attached** to the thread: never queued
blind), `stale` (`thread` is not the worker's
thread now, the batch is unknown, or a question is not `pending`: `sending`, `sent` (unless `undelivered`),
`answered` or `dismissed`). It
runs on the worker's input lane ([Input](#input)) and is **checked again** there, then marked `sending` in the same
step (any other answer to the same question submitted before that one is `stale` from then on, whatever comes of
it: queued duplicates send once), and sent:

- a turn runs: `turn/steer` with `expectedTurnId` (the running turn as the join last saw it);
- none runs: `turn/start` with the input only (no override: the thread's settings stay).
- **The completion race**: the server refusing the steer (the turn ended between the bridge's view and the server's)
  delivered nothing, so the bridge sends `turn/start` **once** instead (`fallback: true`). A `turn/start` refused too
  is `input_failed`, the questions `pending` again with `error`. A send that got no response is `sent` with
  `unconfirmed: true` in the ack and on the question, and is not sent again.

The ack is `{state: "sent", via: "turn/steer" | "turn/start", turn?, fallback?, unconfirmed?}`: the server took it.
`answered` comes later, as a `worker.upsert`, when the envelope's user message is seen: Codex records a steered input
as a user message only when it delivers it, with the turn's next model request. Checked with the real terminal
(`TestCodexShareAsyncAnswers`, docs/research/codex-shared-tui.md §11): a steer the server accepted whose turn then
ends before that request (an interrupt) is **dropped**: no user message, nothing reaches the model, and the next turn
does not carry it. Such a question stays `sent` with **`undelivered: true`** (set when the turn the answer went to ends
without its user message, live or in the history), is never sent again by itself, and `worker.answer_async` may send it
again (it then counts as `pending`): a submission made after it went undelivered, not one queued before. A `turn/start` while a turn runs is accepted into that turn (its id comes back),
so the fallback never starts a second delivery path.

**`worker.dismiss_async`** `{id, thread, batch, indexes?}` puts `pending` or `sent` questions away (no `indexes`:
every one that can be); `stale` for an unknown batch or another state, `invalid_state` for a worker that is not
shared. Nothing goes to Codex.

**`async_blocked`** (#157): `true` while the bridge would take a prompt through the app-server (below): attached, the
thread's running turn asked a question Codex still holds (not `answered`; a `dismissed` one counts, Codex still has
it), and **no server request open**. It says whether a `blocked` herdr shows is only an async question's; absent
(false) with an approval or a blocking question open, while idle, while not attached, and for legacy workers. It is
part of the worker's `codex`, so each flip is a `worker.upsert`: a question asked, a server request opened or resolved,
the envelope seen, the turn's start or end, a join or its loss, another thread. It does not depend on `status`: the
game reads `status: "blocked"` with `async_blocked: true` as working (its prompts are queued, nothing waits on a key),
and `blocked` without it as a real block, as before.

**Prompts stay usable.** herdr refuses `agent prompt` while it shows the worker `blocked` (B7), and the asking turn
is still running then. A `worker.prompt` to a shared worker that is `blocked`, attached, with a running turn that asked
a question Codex still holds (not `answered`) and **no server request open** (an approval or a blocking question is a
real block: the terminal answers it, and the prompt is `invalid_state` as before) goes through the app-server:
`turn/steer` into the running turn, as Codex's own composer queues a message during a turn ("Messages to be submitted
after next tool call"), with the same one `turn/start` fallback. Its ack has `queued: true` (steered) and
`via: "app_server"`. Such a worker's screen is not read as a `question` either (there is nothing to answer with keys).
A prompt never answers a question. A terminal-only built-in (`/status`, #140) to such a worker stays `invalid_state`:
it has to be typed into the terminal, which herdr refuses while it says `blocked`.

The audit log keeps the ids, the indexes and each answer's length (`answer_bytes`), never the text.

### Inbox

The game's inbox (#100) is derived in the client from the world: the workers that need you and the employees that are
done. The bridge keeps one thing for it (#106): which **done** rows were dismissed, so a dismissal survives a reload, a
bridge restart and a second browser.

- **`inbox.dismiss {"id", "status_since"}`** hides a done worker's row until that worker's next working → done. It is
  recorded only while the worker is `done` **and** its present `status_since` equals the one sent; otherwise it is
  ignored: the ack is `{"dismissed": false}`, nothing is stored and no event is sent (the client's view was stale: the
  worker went back to work, or it was dismissed from another browser and has moved on). An unknown worker is ignored
  the same way. A missing `id`, or a `status_since` that is not positive, is `bad_request`. Dismissing an episode
  twice acks `{"dismissed": true}` the second time and sends nothing.
- **`inbox.dismissed {"id", "status_since"}`** goes to every client, the sender too, before its ack, when a dismissal
  is new. A client hides that worker's row while its own `status_since` for the worker equals the event's.
- **`inbox_dismissed`** in the snapshot is the whole map, `{<worker id>: <status_since>}`.
- **Episode semantic**: a dismissal is the done episode's `status_since`, not "the worker". It holds while the worker
  is `done` with that same `status_since`; when the worker works again its `status_since` moves, the bridge forgets the
  dismissal (on that status change, on startup, when the worker's workspace closes, and with the worker's row in the
  database), and the next working → done is a new episode that is listed again. A client applies the same rule to what
  it holds, so it never needs a "removed" event: a dismissal whose `status_since` is not the worker's current one is
  inert.
- **Needs-you rows cannot be dismissed**: they leave when the need is answered. Only a `done` worker is accepted.
- The game sends `inbox.dismiss` for the × on a Finished row, and also when a successful go-to (a row's click or its
  desktop notification) reaches a worker whose display is `done`: going to it reads it (see `docs/decisions.md`
  "#106: dismissing finished rows").

Stored in SQLite `inbox_dismissed (worker_uuid PRIMARY KEY REFERENCES worker(id) ON DELETE CASCADE, status_since,
dismissed_at)`.

### Errors

```json
{"t":"error","req_id":"9","code":"unknown_command","message":"unknown command \"worker.prompt\""}
```

| code | meaning |
|---|---|
| `bad_request` | not a JSON object with `t`; missing `req_id`; bad or unknown `args` fields; invalid name; a second `hello` |
| `auth_failed`, `no_models_endpoint`, `unreachable`, `timeout`, `bad_response`, `truncated`, `empty_answer`, `incomplete`, `test_required`, `env_locked` | #92 `ai.*` (see [AI integration](#ai-integration)); `rate_limited` and `provider_failed` are used there too; #90 `followups.*` and #110 `packup.*` use `incomplete`, `test_required`, `env_locked` and, from their tests' calls, the `ai.*` ones (`packup.detect` never fails on a model: no match); #98 `activity.set` uses `env_locked`; #118 `digest.*` use `incomplete`, `test_required`, `env_locked`, `bad_request` (#174: also a reasoning effort or budget the model or the range refuses; `digest.retry` also `unknown_worker`) and, from its test's calls, the `ai.*` ones (`truncated`, `empty_answer`) |
| `bad_url`, `key_required`, `not_configured`, `unauthorized`, `forbidden` | #184 `kaneo.*` and a floor's Kaneo link (see [Kaneo](#kaneo)); `unauthorized` (the provider refused the key, HTTP 401, maybe its quota) and `forbidden` (a permission problem, HTTP 403) also from the board commands of a provider that tells them apart; `unreachable`, `timeout`, `test_required`, `rate_limited` and `provider_failed` are used there too |
| `unknown_command` | `t` is not a command of this protocol version. The connection stays open. |
| `not_found` | no building with that id; a `transcript.item` id that is not in the transcript, a `transcript.image` hash this connection was not sent (or an image that can no longer be read), or a subagent (`agent`) without a transcript; no team preset with that id (`preset.update`, `preset.delete`, `run.prepare`, `run.start`); a board item id that is not on the floor's provider, or a `work_item` that is not on its board |
| `name_taken` | another building, or another team preset, already has that name (ignoring case) |
| `unknown_session` | a floor command for a session the bridge does not know or does not watch (`--sessions`) |
| `unknown_worker` | `worker.fire.prepare` / `worker.fire` / the laptop commands for a worker id the bridge does not know (or on an unwatched floor) |
| `busy` | `transcript.image` with 16 reads already in flight for that watch; a floor command while that floor's wake or sleep is in progress; `floor.wake` / `floor.sleep` while a hire or send-home on it is in progress; `worker.fire*` for a worker that is still being hired or already being sent home; #83: `worker.wrapup` for a worker already armed, `worker.wrapup.cancel` once its CLEAN's send home started |
| `invalid_state` | `worker.open_pr` for a worker that is not a plain worker in the branch the bridge made, or whose tree is dirty or has nothing to open; `floor.wake` on a running floor, `floor.sleep` on an asleep one, hire or send home on an asleep floor; a laptop command for a worker on an asleep floor or without a pane, `worker.prompt` to a plain shell, a blocked worker (but one blocked only by a Codex async question) or one with an `ask`, #156 `worker.answer_async` / `worker.dismiss_async` for a worker that is not a shared Codex worker, a `conflict` batch, or (answer) a batch under a legacy `item-N` id or a thread the bridge is not attached to, `worker.commands` for a worker running no Claude or Codex agent, `worker.answer` to a worker not blocked; `transcript.page` / `transcript.item` / `transcript.image` / `transcript.images` for a worker this connection does not watch or whose transcript is pending, or whose transcript changed while it was read |
| `desk_taken` | `worker.hire` at a desk someone holds or a hire in flight reserved, or outside `0 … desks-1` |
| `whiteboard_conflict` | M13: a save whose `base` is not the board's current version (HTTP `409`, with the current `version`) |
| `whiteboard_invalid`, `whiteboard_too_large`, `whiteboard_unsupported`, `whiteboard_hash_mismatch`, `whiteboard_missing_file` | M13: a scene, file, render or pin the bridge refuses (see [Whiteboard](#whiteboard)) |
| `drops_unavailable` | `drops.list` without a Drop Zone data directory, or one that cannot be read |
| `too_large` | `transcript.image` with `size: "full"` for an image whose base64 is over 12 MiB (its thumbnail is still served) |
| `capacity` | `worker.hire` above `--max-workers-per-floor` or `--max-workers`, `terminal.watch` above `--max-watches` or `--max-observers`, `transcript.watch` above `--max-transcript-watches`; the message says which |
| `not_clean` | #83: `worker.wrapup` with a delete for a tree that is not clean and pushed now; `worker.fire` asked to delete a worktree whose tree is dirty or has unpushed commits; for `delete_branch` also when the checkout is no longer on the branch the bridge made or that branch has commits on no remote |
| `fetch_failed` | `worker.hire` with `worktree: true` whose `git fetch origin` failed (no `origin`, offline, timed out after 20 s, …); the message is git's error. Nothing was made. (After the accept, like `bad_request` for a missing default branch.) |
| `hire_failed`, `fire_failed` | herdr or git failed during a hire / send-home; the message says which step and why. `fire_failed` also when the agent did not exit (still running, or its processes could not be read): then nothing was closed or removed. `hire_failed` names what its rollback kept. |
| `wake_failed` | the server did not start, did not answer `ping` or was not seen running within `--wake-timeout`; the message says why |
| `sleep_failed` | `herdr session stop` failed (the message has herdr's error), or the floor was not seen asleep within 15 s |
| `input_failed` | #156 `worker.answer_async`: the worker's app-server refused the answer (nothing delivered; the question is `pending` again with its `error`); `worker.keys` / `worker.answer` / `worker.answer_ask`: herdr refused the keys or text (`terminal.zoom`: herdr refused the zoom), the screen could not be read, or 32 commands already wait for that worker; `worker.answer_ask` also when the dialog was not where it should be before a step, or still there after the last one; the message says why |
| `prompt_failed` | `worker.prompt` was not submitted: herdr failed, or the agent did not start working even after Enter was pressed again |
| `stale` | #184 `issue.set_status` with `after` on a Kaneo board that changed since it was read (Kaneo's 409), `floor.settings.set` whose floor's tracker or Kaneo link, or the Kaneo connection, changed while it was checked, and `run.start` whose `work_item` was being read when the floor's board source changed; #156 `worker.answer_async` / `worker.dismiss_async` for a `thread` that is not the worker's now, an unknown batch, or a question not in a state it can take (answered, dismissed, sending, sent; checked again on the input lane); #90 `worker.answer_followup` / `worker.dismiss_followup` for a `turn_id` that is not the worker's follow-up (answered, dismissed, or a newer turn); `worker.answer` for a question the worker's screen no longer asks (another `hash`), or a worker no longer blocked; `worker.answer_ask` for an ask the worker no longer has (another `tool_use_id`, or none), also when it was answered or replaced while its keys were being pressed, or (`cancel`) the screen shows another question; `pr.merge` whose head moved since it was read |
| `changes_failed` | `worker.changes` whose git calls failed, or took longer than 10 s together; the message is git's error |
| `not_a_repo` | `worker.changes` for a worker whose directory is not in a git work tree |
| `files_failed` | #137 `worker.files` whose listing failed (git's error, rg's, or the listing could not start) with no earlier index of that checkout to answer from |
| `confirmation_required` | `issue.close`, `pr.merge` or `worker.open_pr` without `confirm: true` (see [Boards](#boards-issues-and-pull-requests)) |
| `unsupported` | the floor has no board (no repo linked, no provider), or the provider or the card cannot do it (a capability is off); `worker.open_pr*` on a floor that cannot open pull requests |
| `provider_failed` | the provider call failed (`gh` missing, not logged in, the network, GitHub's refusal, a failed `git push`); the message is short and never has a token |
| `rate_limited` | the provider's rate limit |
| `checks_not_green`, `not_mergeable` | `pr.merge` of a pull request whose checks are not green, or that is not mergeable (also a conflicting one, always); an override is `override` and `confirm_override` together |
| `hello_required`, `unsupported_proto` | handshake failures; the connection is then closed with status 1008 |
| `no_client`, `not_sharing` | M13 `screen.grab`: no game is connected (or the sharing one went away mid-grab); a game is connected and shares nothing (or stopped mid-grab) |
| `frame_timeout`, `frame_invalid`, `frame_too_large`, `frame_unavailable` | M13 `screen.grab`: the game sent no frame within 5 s; what it sent is not a valid JPEG; it is over 8 MiB, or wider than 1920 or taller than 4096 pixels; the game said it has no frame (the source is paused, sharing stopped while it encoded). The last three are also the answers of `POST /screen/frame/{req_id}` |
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
