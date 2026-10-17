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
  (see [Wake and sleep](#wake-and-sleep)), #58 `session.create` (see [New herdr sessions](#new-herdr-sessions)), `worker.hire` / `worker.fire` / `worker.wrapup` (see [Hire and send
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
(`{"tunnel":{"state":"up|connecting|degraded|backoff",…}}`, `503` unless `up`). #57: it is the state of the bridge in
use (a local one is `up` or `down`); with no bridge configured it is `{"state":"none","last_error":"no bridge
configured: add one in Settings"}` (`503`), and `version` is always the helper's.

The helper also answers one request of its own, for the game's "Open in <provider>" buttons and the links in issue
bodies (M7): `POST /api/open` with `{"url":"https://github.com/…"}` opens that page in the helper machine's default browser
(`open <url>` on macOS, `xdg-open <url>` on Linux; #81). It needs the same `Host` and `Origin`, the token in an `X-H3D-Token` header (never in a URL) and
`Content-Type: application/json`, and accepts only an `https://` URL on a host of its allowlist (`github.com`; every
provider the bridge learns adds its own host), without credentials or a port. #184: a self-hosted provider's host
(the saved [Kaneo](#kaneo) instance's web host) is not built in: the bridge names it on its own `GET /healthz`, in the
`X-H3D-Open-Hosts` header (comma-separated host names; absent: none), which the helper reads through its ssh tunnel on
every 5 s check and adds to the allowlist while it is there (a save or a disconnect reaches the helper within one
check). No client can set it: the helper does not proxy `/healthz`. `204` opened; `400` a refused URL;
`403` a failed check; `502` the Mac's `open` failed. A game not served by the helper has no such endpoint (it has no
token either) and opens a new window itself (`https://` only); a game the helper serves opens nothing the helper
refuses and says so.

#### The helper's bridges (#57)

The helper can reach several bridges and tunnels the game to one at a time: the one **in use**. Every route above
(`/ws`, `/logo`, `/upload`, `/screen/frame`, the whiteboard's, `/drops`), `GET /healthz` and `/api/open`'s open hosts
are the bridge in use's. The list is the helper's, in a 0600 JSON file next to its token (`bridges.json`,
`--bridges-file`), and the game reads and edits it through `/api/bridges`:

| Request | Body | Answer |
|---|---|---|
| `GET /api/bridges` | | the list |
| `POST /api/bridges` | `{"name", "kind", "host"?, "remote_socket"?, "socket"?}` | the list (the first bridge added is put in use) |
| `PUT /api/bridges/{id}` | the same fields | the list (the id stays; a new address restarts that bridge's connection) |
| `DELETE /api/bridges/{id}` | | the list; `409` `in_use` for the bridge in use |
| `POST /api/bridges/{id}/activate` | | the list, with `{id}` in use |

The list is `{"active": "<id>", "bridges": [{"id", "name", "kind", "host"?, "remote_socket"?, "socket"?, "address",
"active", "state", "since"?, "last_error"?, "version"?}]}` in the order added: `id` is 10 random hex digits that never
change, `name` (1-40 characters, unique without regard to case) is display only. `kind` `ssh` has a `host`
(`[user@]host`, not starting with `-`, no whitespace) and an optional `remote_socket` (absolute; empty: the helper asks
the host for `$XDG_RUNTIME_DIR` over ssh, in that bridge's own supervisor); `kind` `local` has a `socket` on the
helper's machine (absolute, at most 103 bytes), dialled directly. `state` is that bridge's connection now (`up`,
`connecting`, `degraded`, `backoff`, `stopped`, or `down` for a local socket that does not answer), `version` its
build from its `/healthz`. The helper keeps one supervised connection per bridge (an ssh tunnel ending at
`<dir of --local-socket>/bridges/<id>-<n>.sock`, or the local socket's `/healthz` checked every 5 s), so the list
answers at once from what it last saw: no request waits on ssh.

The guards are `/api/open`'s: `Host`, the token in `X-H3D-Token` (never in a URL) and the page's own `Origin`; a
`GET` may come without one, since a browser sends none on a same-origin `GET`, and the token header keeps it a request
no other site can make (it is not a simple request, and the helper answers no CORS preflight). `POST` and `PUT` need
`Content-Type: application/json` and a body of at most 4 KiB with no other field. A refusal is the error object
(`{"t":"error","code","message"}`): `400` `invalid` (the message names the field and is shown as it is under the
Settings form), `400` `bad_request`, `403` `forbidden`, `404` `not_found`, `409` `in_use`, `415`, `500` `save_failed`;
other methods get `405`. The list is saved before a change takes effect.

`activate` closes every connection the helper dialled to the bridge in use before (the game's `/ws` and the proxies'
idle keep-alive connections), and the game reloads: its same-origin `/ws` then reaches the new bridge. A bridge that
is not `up` can be activated (the game asks first). The bridge in use cannot be removed. On its first start with no
list file, a helper given `-host` / `$H3D_HELPER_HOST` (and `-remote-socket`) makes that host the only bridge, named
after it, in use; once the file exists it is the truth. With neither, the list is empty and the game says so.

A page keeps the bridge its per-bridge keys were chosen for at start, and its `/ws` names it:
`/ws?token=<token>&bridge=<id>` (`bridge=none` when the helper had no bridge). The helper dials that bridge only:
another one in use (a switch made in another tab, or the first bridge added there) answers `409` with no connection to
any bridge, so the page never shows another bridge's world under its drafts and seats. The HTTP routes the page uses
(`/logo`, `/upload`, `/screen/frame`, `/whiteboard`, `/drops`) carry the same `bridge` (their URLs derive from the
`/ws` one) and are refused the same way, before anything reaches a bridge: `409` with the error object, code
`bridge_changed`. The helper never passes `bridge` on to the bridge. The page hears of the switch from the list
(Settings and the palette poll it while open) or, when its connection drops or a route answers `bridge_changed`, by
asking for the list, and reloads on the bridge in use ("Switching to <name>…"). A request without `bridge` (a page no
helper scope covers) is let through to the bridge in use, as before.

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

`model_labels` (#200, optional) maps a model's exact launch id to the readable name its harness reports (`displayName` of
Claude Code's initialize reply and of Codex's `model/list`), e.g. `{"claude-opus-5":"Opus 5"}`. It is presentation only:
`models`, `extra_efforts`, a hire's `model` and everything stored stay keyed by the exact id. A name is trimmed plain text
of at most 64 characters without control characters; a blank, longer or invalid one is left out, as is the generic
"Default (recommended)" of Claude's `default` alias when that alias resolves to a model another alias names (the first
usable name of the aliases of one id wins). The key is absent from an older bridge, from the Claude fallback catalog and
when no model has a name; the Codex fallback catalog names its models as `model/list` does (`gpt-6-sol` → "GPT-6-Sol",
#229). Without a name a client formats the ids it knows (`claude-opus-5-5` → "Opus 5.5", `gpt-6.1-sol` → "GPT 6.1 Sol")
and shows any other id as it is.

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

`handoff_llm` (#9) is the LLM handoffs' state (see [LLM handoffs](#llm-handoffs)), left out by a bridge without the AI
service or a handoff directory, or from before #9; a worker's job is its own `llm_handoff`.

`activity` (#98) is "Classify unknown commands"' state (see [Activity](#activity)), left out by a bridge without the AI
service or from before #98; a worker's own `activity` is in the worker.

`notify` (#11) is the Telegram notifications' settings and channel state (see [Notifications](#notifications)), left
out by a bridge without a notification channel or from before #11. It never holds the bot token: `key_set` and its
last four characters only.

`inbox_dismissed` (#106) holds the dismissed rows of the game's inbox: worker id → the `status_since` of the done episode
that was dismissed (see [Inbox](#inbox)); `{}` when there are none. A bridge from before #106 leaves the key out: a
client reads that as `{}`.

`codex_server` (#155) is the shared Codex server switch, `{"enabled", "available", "allow_unverified"}` (see
[Shared Codex server](#shared-codex-server)); a bridge from before #155 leaves it out.

`repo_refs` (#247) is the "Repositories from other buildings" switch, `{"all_buildings": bool}` (see
[Repositories on other floors](#repositories-on-other-floors)); a bridge from before #247 leaves it out.

`repo_discovery` (#54) is repository discovery's settings and status, `{"roots", "interval_minutes", "status"}` (see
[Repository discovery](#repository-discovery)); a bridge from before #54, or one that cannot run git, leaves it out.

`kaneo` (#184) is the Kaneo connection, never a key (see [Kaneo](#kaneo)); a bridge without the settings, or from
before #184, leaves it out.

`handoffs` (#223) is the filing cabinet, `{"counts": {floor: n}}` (floors without a handoff left out; see
[Handoffs](#handoffs)); a bridge without a handoff directory (`--handoff-dir -`), or from before #223, leaves it out.

`schedules` (#62) are the scheduled agents in view, by `due_at`: the upcoming ones (`scheduled`, `waiting`, `running`),
the `failed` and `skipped` ones not dismissed, and each floor's last 50 `done` ones (see [Scheduled
agents](#scheduled-agents)); `[]` when there are none. A bridge from before #62 leaves the key out: a client reads that
as `[]`.

`children` (#22) are every worker's native child agents (see [Native child agents](#native-child-agents-22)); `[]` when
there are none. A bridge from before #22 leaves the key out: a client reads that as `[]`.

`presets` are the team presets, by name ignoring case (see [Team presets and starting a
run](#team-presets-and-starting-a-run)); `[]` when there are none.

`hire_presets` (#93) are the hire presets of every floor and the global ones, by name ignoring case (see [Hire
presets](#hire-presets)); `[]` when there are none. A bridge from before #93 leaves the key out: a client reads that as
"hire presets are unavailable", not as an empty list.

`herdr_instructions` (#95) is `true` when the bridge adds the herdr hiring instructions (`worker.hire`'s and the hire
presets' `herdr_instructions`, `hire.prepare`'s lines; see [Hire presets](#hire-presets)). A bridge from before #95
leaves it out and refuses the field as unknown: a client never sends it there.

`screen` (M13) is `{"sharing": false}`, or `{"sharing": true, "surface": "browser|window|monitor"}` while a connected
game shares its screen (see [Screen share](#screen-share)); a bridge from before M13 leaves it out.

Order is meaningful: `buildings` are in `sort` order and each lists its floors top to bottom (`index` order);
`unassigned` is the lot of floors that are in no building, by floor id. #58: `floors`, `unassigned` and every
building's `floors` hold **floor ids** (a real floor's id is its session's name, so the examples here read the same);
every floor also carries `id`, `name`, `base_session`, `virtual` and `hidden`, and every worker `floor`, left out of the
examples (see [Virtual floors](#virtual-floors)). `floors` follows the same order (buildings, then the
lot), and `workers` follows the floors, each floor's workers in herdr's sidebar order.

### Building

| field | type | |
|---|---|---|
| `id` | string | bridge-generated, `b_<hex>` |
| `name` | string | 1–64 bytes, unique ignoring case |
| `sort` | int | 0-based position among buildings |
| `floors` | string[] | floor ids (#58) of the known floors in this building, in floor order (derived); a virtual floor stands in its base session's floor's building |
| `logo` | string? | M3d: the hash (lower-case hex sha256) of the building's logo PNG; absent without one. The image itself is `GET /logo/{id}`, never in an event or the snapshot. It changes when the image does, and is what a client caches the texture by. |

### Floor (a herdr session)

A floor is a herdr session's own floor (its **real floor**) or, #58, a **virtual floor** on it (see
[Virtual floors](#virtual-floors)).

| field | type | |
|---|---|---|
| `id` | string | #58: the floor id (the key): a real floor's is its session's name, a virtual floor's `v-` and 12 lower-case hex digits |
| `name` | string | #58: the display name: a real floor's session name, a virtual floor's own (free text, 1–64 bytes) |
| `session` | string | the herdr session the floor lives in (before #58 the key: on a real floor it still equals `id`) |
| `base_session` | string | #58: the same as `session` (named for virtual floors) |
| `virtual` | bool | #58: a virtual floor |
| `hidden` | bool | #58: the floor's stored hidden setting (decision 2): a client hides a hidden floor from its lists unless it has at least one worker, so a hidden floor never hides a worker |
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
| `floor` | string | #58: the floor id it belongs to: its session's real floor (`== session`) or a virtual floor on it (see [Virtual floors](#virtual-floors)) |
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
| `followup` | object, optional | #90: the open questions of its agent's final message, `{"turn_id", "questions": [{"id", "label"?, "question", "kind": "yes_no" \| "choice" \| "open", "options"?, "context"?, "recommendation"?: {"text", "why"?, "option"?, "cut"?}}], "score", "source": "parsed" \| "model" \| "fallback", "at", "tail"?, "error"?, "unlisted"?, "retries"?}` (#60: `label` … `retries`, `parsed`), until answered, dismissed or moot (see [Follow-up questions](#follow-up-questions)) |
| `handoff` | object, optional | #223: its agent's latest completed final reply a literal handoff can file, `{"id", "session", "revision", "harness", "message"?, "turn"?, "source": "message" \| "last_agent_message", "bytes", "images"?, "too_large"?}`: the bridge's identity of it, never its text (see [Handoffs](#handoffs)) |
| `llm_handoff` | object, optional | #9: its latest LLM handoff job, `{"op", "state": "queued" \| "running" \| "filed" \| "failed" \| "cancelled", "code"?, "message"?, "started_at", "updated_at", "model"?, "host"?, "send_home"?, "handoff"?, "send_home_result"?, "send_home_reason"?}`, while it runs and once settled until a new one starts or the worker leaves (see [LLM handoffs](#llm-handoffs)) |
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
| `child_generation` | int ≥ 1 | #22: the generation of its native child agents: it rises when its root agent session is replaced, and its children of an older one are gone (see [Native child agents](#native-child-agents-22)); absent from a bridge before #22 |
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
- **Floor** (#58): a freelancer nothing attributed takes its orchestrator's floor (a virtual floor too) on the
  observation its link resolves, and keeps it, stored, across restarts (see Freelancers in
  [Virtual floors](#virtual-floors)).
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
{"state":"ready","at":1790650000000,"input_required":"Accept the existing evidence?","input_for":"orchestrator","input_resolved":{"by":"orchestrator","note":"accepted as AC4 evidence","at":1790650090000}}
{"state":"invalid","at":1790650000000,"error":"not a JSON object"}
```

| field | |
|---|---|
| `state` | `pending` (no file yet), `ready`, `invalid` |
| `at` | unix ms, the file's mtime (absent for a bad name) |
| `verdict` | reviewers (`review`, `ux`) only: `PASS` \| `CHANGES_REQUIRED` \| `INCOMPLETE`; any other value, or none without `input_required`, is `invalid` |
| `blockers`, `issues` | reviewers: how many `issues_found` have `priority == "BLOCKER"`, and how many there are |
| `input_required` | the request the report makes (a decision, an acceptance, an answer), up to 8 KiB (UTF-8 safe; #215: it used to be cut to 500 bytes, losing the actual decision); absent when null or empty. It stays present after the request was resolved |
| `input_truncated` | `true` when `input_required` was longer than 8 KiB and was cut; absent otherwise |
| `input_for` | who the request is for, when the report says (`"input_for": "orchestrator"` \| `"user"`, case-insensitive); any other value is ignored; absent otherwise. Present only with `input_required` |
| `input_resolved` | `{by, note?, at}`: the orchestrator resolved the request (see below); absent while it asks. `by` is `resolved_by` of the sidecar (≤ 40 bytes, default `orchestrator`), `note` its note (≤ 300 bytes), `at` the sidecar's mtime in unix ms. Present only with `input_required` |
| `summary` | coders and researchers: their `summary`, cut to 300 bytes |
| `error` | why a report is `invalid`: a run id or report name not matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$`, not a regular file (a symlink is not followed), over 256 KiB, not a JSON object, a bad verdict |

**Resolving a request without resuming the worker (#215).** A report's `input_required` is a request the orchestrator
(or you) must settle, but a worker that has said it in its report and ended its turn is `done`: nothing changes in the
report file when the orchestrator accepts it and carries on. The orchestrator says so with a **sidecar** next to the
report: for `<run>/<stem>.json` it writes `<run>/<stem>.resolved.json` (the report name with `.json` replaced by
`.resolved.json`, or appended to a name without `.json`), atomically (temp file, then `mv`):

```sh
printf '{"report":"coder-r1.json","resolved_by":"orchestrator","note":"accepted as AC4 evidence"}' > run/coder-r1.resolved.json.tmp \
  && mv run/coder-r1.resolved.json.tmp run/coder-r1.resolved.json
```

The sidecar is a JSON object that must carry a string `"report"` **equal to the file name of the report it resolves**
(`coder-r1.json` above; for a report named `coder-r1` it is `coder-r1`), plus the optional strings `resolved_by` and
`note`. So the sidecar is bound to its report: two report names sharing a sidecar path (`coder-r1` and `coder-r1.json`)
cannot resolve each other, and another worker's report JSON is no acknowledgement. A missing or different `report`, or
a `report`, `resolved_by` or `note` that is not a string (`null` included), makes the sidecar **ignored**. It resolves
the report's request only when it is a regular file of at most 4 KiB (`Lstat`, `O_NOFOLLOW`, no symlink, FIFO or
directory), valid JSON (anything else is **ignored**: the request stays active), and its mtime is **at least the
report's**. So a report written again after the resolution (a new request) asks again, and a fresh `h3d_report` path
(a resume after an answer) starts over at `pending` as before. A name ending in `.resolved.json` is
**reserved for sidecars**: as an `h3d_report` it is an `invalid` report (`report name is reserved for resolutions`),
so a worker can never occupy a sidecar path. A report whose sidecar name would exceed 80 bytes has no sidecar. The poller stats both files and re-reads when either's size
or mtime changed (creating, replacing or deleting the sidecar is one `worker.upsert` within a second); the sidecar is
the only state, so a bridge restart changes nothing. Use it to accept a request in the ledger and go on without
resuming the freelancer; to *answer* a request and resume it, assign a fresh report path as before.

The game derives a freelancer's lifecycle from these (hired, onboarding, working, blocked on `status: blocked` or a
`report.input_required` that is not resolved, reporting on a `ready` report, leaving on `worker.removed`); nothing
else goes on the wire. An unresolved request makes the worker **needs you** whatever its `status` (even `done`); a
resolved one does not count anywhere (NEEDS YOU counts, N, inbox, badges, bubbles) and the lifecycle falls back to the
worker's own state. Card, look-at bar and inbox call it a **Report request**, never "Waiting for an answer" (the agent
asked no question), and say who is asked: `input_for`, else the worker's orchestrator (`orch_id`: "Asked of the
orchestrator (Cog)"), else you ("Asked of you"). The inbox row opens the complete text.

### Native child agents (#22)

#22, phase 1 of #20. The subagents a worker's own Claude Code or Codex session runs (Claude's `agentId`, a Codex child
thread's `thread.id`) are its **native child agents**: conversations inside the worker, not panes, freelancers or desks.
The bridge publishes them whether or not a transcript is open: `children` in the snapshot, `child.upsert` and
`child.removed` events, and each worker's `child_generation`. Phase 1 is the model and the protocol; the providers are
sources of evidence for it: Claude Code since #23 ([below](#claude-code-subagents-23)), Codex rollouts (#25) and the
shared Codex server (#27) to come. The board shows them from #24 on; opening a child's own transcript is #26.

```json
{"t":"child.upsert","seq":1210,"child":{"id":"ch_7f3a09c2e1d4b856","native_id":"a3f9c1e2","provider":"claude",
  "worker_id":"6db1905e-9e85-42f4-911c-b05e31b84c68","agent_session":"c6f58eef-ca04-4fe4-a564-3b15f8311bf3",
  "generation":4,"parent":"root","type":"Explore","description":"Find the hub's session handling","state":"running",
  "source":"hook","started_at":1792000000000,"last_activity_at":1792000005000,"transcript":"available"}}
{"t":"child.removed","seq":1211,"id":"ch_7f3a09c2e1d4b856","worker_id":"6db1905e-9e85-42f4-911c-b05e31b84c68","generation":4}
```

| field | type | |
|---|---|---|
| `id` | string | the bridge's row id, `ch_<16 hex>`: it never changes for the life of the row, also when `native_id` arrives |
| `native_id` | string, optional | the provider's id (Claude's `agentId`, Codex's child `thread.id`); absent while the row is **provisional** (see below) |
| `provider` | `claude` \| `codex` | |
| `worker_id` | string | the root worker that owns it |
| `agent_session` | string | that worker's root agent session it belongs to |
| `generation` | int ≥ 1 | the worker's `child_generation` the row belongs to |
| `parent` | `root` \| `child` \| `unresolved` | its immediate parent; always present (see below) |
| `parent_id` | string, optional | with `parent: "child"` only: that child's `id` |
| `name`, `type`, `description` | string, optional | as the provider gives them (Claude: the subagent type and the task's description; Codex: the nickname and role); at most 128, 128 and 1000 bytes |
| `state` | `running` \| `completed` \| `idle` \| `shut_down` \| `interrupted` \| `unknown` | its lifecycle (see below) |
| `source` | string | the evidence source that set `state`: `hook` (Claude's `SubagentStart`/`SubagentStop`), `transcript`, `app_server`, `rollout`, `fixture` (the test source); a client shows any other as it is |
| `started_at`, `last_activity_at`, `ended_at` | int, optional | unix **milliseconds**, from the evidence (the provider's clock, not the bridge's as `status_since`); absent when not known. `started_at` keeps the earliest seen, `last_activity_at` the latest |
| `transcript` | `available` \| `pending` \| `unavailable` | whether it has a transcript to open, one is expected but not written yet, or none is known (the default) |

**States** are kept apart: `running` (working now), `completed` (its task completed), `idle` (idle and reusable: it can be
messaged again), `shut_down` (closed for good), `interrupted` (stopped before it completed) and `unknown` (disconnected, or
no evidence of a state). Only evidence moves a child between them; nothing times out, so a child whose log goes quiet
keeps its state (quiet logs never imply completion; a lost process shows as `unknown` or `interrupted` once a source says
so). A child seen without a state, or with one this list does not have, is `unknown`, never a guess; a client reads a
value it does not know as `unknown` too. A child `running` again after it ended (resumed) loses its `ended_at`.

**The parent** comes from evidence only, never from timing, launch order or which child was running: `root` (the worker's
own session started it), `child` (another child, `parent_id`) or `unresolved` (not known yet: the evidence named no
parent, or one the bridge has not seen). `unresolved` is its own value: a client shows such a child directly under its
root worker until an upsert resolves it, and never reads it as `root`; a missing or unknown `parent`, or `child` without
`parent_id`, is `unresolved`. A removed parent leaves its children `unresolved` (resolved again should it come back);
evidence that would make a cycle is ignored. Children nest to any depth the provider shows.

**Generations.** A worker's `child_generation` (in the worker table) is from one bridge-wide counter: it only rises for a
worker, so compare it per worker, never across workers. A worker gets one when first seen and a new one when its root
agent session is **replaced**: `agent_session` changes from a value to another one or to none (a first session after none
is no replacement: nothing can have attached meanwhile). That `worker.upsert`, with the new `agent_session` and the
higher `child_generation`, is the replacement: the worker's children of the older generation are gone with it (no
`child.removed` is sent for them), and the bridge drops any later evidence of the old session, so a child of a replaced
session never attaches to the new one, even one whose native id the new session reuses (a new row). Every child and
`child.removed` carries its generation, and a client drops anything of a generation older than its worker's (the bridge
sends none; it guards the client's own state); a child of a newer one first drops the worker's children. A worker's
`worker.removed` takes its children too, again without `child.removed`; should it come back, its generation is higher.

**Provisional rows.** A child seen first from its dispatch (Claude's `Agent` tool call, Codex's spawn call), before the
provider named it, gets a row without `native_id`. When the native id arrives it is **the same row**: one `child.upsert`
with the same `id` and `native_id` set; never a second row, a flicker or a removal and an add. Later evidence by either id
is that row. One case does remove a row: a child seen both by its native id alone (a Claude `SubagentStart` hook names no
tool call) and from its dispatch before the evidence that links the two. The row seen first stays and the other merges
into it: a `child.removed` of the other first, then `child.upsert`s of the one that stays and of the merged row's children.
The row that stays keeps every field either row observed, as if one row had seen both rows' evidence in the order the
bridge observed it: a field only one has is kept; of a `name`, `type`, `description`, `transcript`, `ended_at` (a resumed
`running` clears it) or `state` (with its `source`) both have, the one observed later; the earliest `started_at` and the
latest `last_activity_at`. Its parent is the one of the two observed later if it is still a parent once they are one row,
else the other's, else `unresolved`: never the row itself (a parent that was the other row) nor a cycle; the merged row's
children go under it unless that would make a cycle (then `unresolved`). A client that is sent a row whose parent chain
comes back to it anyway shows it directly under its root worker, never hides it.

**Order.** The child events are ordinary events of the `seq` stream: replayed after a reconnect (`since_seq`) like every
other, and ordered per worker by the one `seq`, with the worker's own events too. The `worker.upsert` that raises a
`child_generation` comes before any child of the new generation; within one observation `child.removed` comes first, then
the upsert of the child observed, then those of the children it resolved or orphaned (so a new parent comes before the
children that waited for it). The snapshot's `children` follow the workers' order, each worker's children in the order
first seen: a parent may come after its child, so build the tree by `parent_id`, never by position.

**Restart.** Nothing of the children is persisted (no SQLite). A bridge starts with none and rebuilds them from the
providers' evidence alone: whenever it binds a worker to a root session it has not bound (every worker after a restart,
a worker's first session, a replacement), each source replays that session's evidence (what the provider still shows: its
transcripts, its server's threads) in observation order. A client sees the new epoch and takes a fresh snapshot anyway.
Row ids are made from the worker, the generation and the first id seen, so the same evidence makes the same rows, but a
client never keeps them across epochs. A root session has at most 500 children; evidence of a new one beyond is dropped.

The bridge's side is `internal/childagents` (`Registry`, the `Source` interface, `Evidence`), the game's
`game/src/world/children.ts` (`ChildBook`, `childTree`) with `decodeChild` in `net/protocol.ts`. The fixtures are
`internal/childagents/testdata/*.json` (scripts of evidence and session changes, with the trees each worker must end
with): `go test ./internal/server -run TestChildFixtures` plays each through a bridge and writes the frames a client gets
as `game/fixtures/children-<name>.jsonl` (`H3D_UPDATE_FIXTURES=1`), which Vitest feeds through the decoder and the store.
To build against them before a provider lands, the fixture bridge plays one: `make dev`, then
`?ws=%2Ffixture%2Fchildren-nested&floor=office` (one recorded event every 2.5 s; `%3Fplay%3Dall` at once).

#### Claude Code subagents (#23)

#23, phase 2 of #20. A Claude worker's children come from its own session's files, with Claude Code's native CLI and
JSONL transcripts (no SDK), observed on **Claude Code 2.1.302** (`docs/research/claude-subagents.md`: the records, the
identity timing, the hooks; a version with other records shows fewer children or fewer states, never wrong ones). The
transcript root is the configured one (`-claude-projects`, default `$CLAUDE_CONFIG_DIR/projects`, else
`~/.claude/projects`): the root's `<session>.jsonl`, and every child at any depth in `<session>/subagents/` as
`agent-<agentId>.jsonl` with its `agent-<agentId>.meta.json`. Nothing else changes on the wire: these are `child.upsert`
and `child.removed` as above, with `provider: "claude"`.

| field | from |
|---|---|
| `native_id` | the child's `agentId` |
| `name`, `type`, `description` | the Agent call's `name` (when given), `subagent_type` (else the meta's `agentType`, else a hook's `agent_type`), `description` (else the meta's) |
| `parent` | `root` when the call is in the root's transcript; `child` when it is in a child's transcript (that child), or by the meta's `parentAgentId`; `root` for a meta's `spawnDepth: 1` with no call seen; else `unresolved` |
| `state` | below |
| `source` | `transcript`, or `hook` while a call is known only from the bridge's hooks |
| `started_at`, `last_activity_at`, `ended_at` | the call's and the child's records' timestamps; `ended_at` the end's (below) |
| `transcript` | `available` once its file is seen; `pending` while it runs without one (just started); `unavailable` when it ended without one (a call that failed) |

**When a child shows.** From its call (the root's or a child's `Agent`/legacy `Task` `tool_use`, or the bridge's
`PreToolUse` hook), before it reports back, foreground and background alike: a provisional row (no `native_id`,
`running`, `pending`) that gets its `agentId` as soon as explicit evidence pairs them: the meta's `toolUseId` (about
0.1–1.6 s after the call), the call's result naming its `agentId` (a background launch: at once), a task notification
naming both, or a `PostToolUse` hook. Never by launch order, file time or `promptId`, so concurrent children keep their
own rows. A child file no evidence pairs yet waits up to 5 s (`HoldUnpaired`) while a call of the session is unpaired,
so it does not show as a row of its own first; then it shows alone (`parent` from its meta, else `unresolved`). The
bridge lists `subagents/` on the next read after a call whose file it has not seen (not only every 10 s).

**States.** `running` from the call on. `completed` by the call's `completed` result (foreground), a `completed` task
notification (background) or the meta's `finished` (at the meta's write). `interrupted` by a rejected or failed call
result (an interrupt: `is_error`) or a `killed`/`failed` notification (a TaskStop, a crash: phase 1 has no failed
state). The latest end wins; a prompt to the child after it (its file: a resume's message, `origin.kind`
`coordinator`, or its own background task waking it, `task-notification`) makes it `running` again, the same row, its
`ended_at` cleared. Nothing else ends a child: not quiet logs, not the root's turn ending or its `Stop`, not a
`SubagentStop` hook (a Stop hook may keep it working: `stop_hook_active`), not the root being interrupted unless the
call's own result says so. A child whose root process died without a result stays as its files left it.

**Not children.** An agent-team teammate (a call with `team_name`, a result with `teammate_id`; the layout is not
verified) and an internal helper (prompt suggestion, `/btw`: hooks with an empty `agent_type`, no call, no file) make no
row. A fork (`subagent_type: "fork"`) is a child; the copy of its spawning call at the start of its file is not a call.
A child file whose first records name another session or agent is ignored whole: no row of its own, and no call,
result or notification in it counts, also one read before a record named the other session or agent. Its file removed
(Claude Code's cleanup) removes its row (`child.removed`), also a running child's whose only pairing is its meta (kept
for that); the root's transcript gone removes them all.

**The bridge's hooks.** `-claude-hooks DIR` (`$HERDR_WORLD_CLAUDE_HOOKS`, default `claude-hooks` next to the database,
`-` for none) holds the bridge's own Claude settings file, `settings.json` (0600), and the log its hooks append to,
`events.jsonl`. The bridge passes it as **one** `--settings` to every Claude it starts (`worker.hire`) and types it into
the wake's fallback resume (`claude --settings '<file>' --resume <id>`); Claude merges it with the user's and the
project's hooks, which the bridge never reads or writes. Its hooks (`PreToolUse`/`PostToolUse` matcher `Agent|Task`,
`SubagentStart`, `SubagentStop`) are synchronous command hooks that append their input to the log under `flock`
(`flock -w 2 LOG cat >> LOG 2>> LOG.err || true`): they never block or fail the action. The bridge reads the log every
second (routed by `session_id`; one rotated file kept past 8 MiB, read again after a restart). They only add evidence the
transcripts give a moment later (the call, the pairing, the nested parent, the type): hook input has no time, so the
lifecycle is the transcripts'. Without them (a worker the bridge did not start, herdr's own resume of a session, hooks
disabled by the user's `disableAllHooks`, no `flock`, the log gone) the same children show from the transcripts alone.

**Restart.** Nothing is kept: the usage tracker reads every worker's files from their start again, and the same
evidence makes the same rows (`TestRestartAndReplay`).

## Events

Every change is an event with a strictly increasing `seq` (+1 per event, per epoch). Clients should apply them in order
and remember the last `seq` applied.

| `t` | fields | when |
|---|---|---|
| `building.upsert` | `building` | a building was created, renamed, reordered, its floor list changed, or (M3d) its `logo` was set, replaced or cleared |
| `building.removed` | `id` | a building was deleted (its floors got `floor.upsert` with `building: null` first) |
| `floor.upsert` | `floor` | a session appeared, started, stopped, was (re)assigned, or its `error`, `transition`, `settings` or `suggested` changed |
| `floor.removed` | `session`, `floor_id` | the session was deleted in herdr (its workers get `worker.removed` first), or (#58) a virtual floor was deleted. `floor_id` is the floor's id (`floor` is taken by `floor.upsert`'s object), `session` its herdr session: a session that goes away removes its real floor and every virtual floor on it, each with its own `floor.removed` (a client drops floors by `floor_id`, never the base floor by `session`) |
| `worker.upsert` | `worker` | a worker appeared, or anything besides `status`/`title` changed, e.g. its `resume` (full object) |
| `worker.status` | `id`, `session`, `floor_id`, `workspace_id`, `status`, `prev_status`, `status_since`, `title` | only `status` and/or `title` changed (the hot path). `title` is always present, `""` when cleared; on a title-only change `prev_status` equals `status` and `status_since` does not move. |
| `worker.removed` | `id`, `session`, `floor_id`, `workspace_id`, `reason`? | the workspace closed, the session was deleted, or the identity changed. `reason` is `"sent_home"` when the removal comes from `worker.fire` or a wrap-up's CLEAN (#83; the game plays the walk-out); absent otherwise. |
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
| `notify.update` | `enabled`, `state`, `missing`?, `env`, `tested`, `events`, `quiet`, `freelancers`, `replies`, `channel`, `last_error`?, `dropped`? | #11: the Telegram notifications' state changed (a setting, the token, a pairing, a test, a delivery's failure or the next success); the whole state, flat in the event, never a token (see [Notifications](#notifications)) |
| `handoff_llm.update` | `enabled`, `state`, `missing`?, `roles`, `env`, `tested`, `input_bytes`, `max_tokens`, `reasoning_effort`, `reasoning`, `effort_stale`, `timeout_s`, `prompt_version`, `categories` | #9: the LLM handoffs' state changed (a setting, a passing test, the LLM's state or config); the whole state, flat in the event (see [LLM handoffs](#llm-handoffs)) |
| `preset.upsert` | `preset` | a team preset was created, renamed or its roles changed (full object) |
| `preset.removed` | `id` | a team preset was deleted (floors whose `last_preset` it was get a `floor.upsert` next) |
| `screen.state` | `sharing`, `surface`? | M13: whether a connected game shares its screen changed, or what kind of surface the latest sharer shares (flat, see [Screen share](#screen-share)) |
| `codex_server.update` | `enabled`, `available`, `allow_unverified` | #155: the shared Codex server switch changed (flat in the event, see [Shared Codex server](#shared-codex-server)) |
| `repo_refs.update` | `all_buildings` | #247: the "Repositories from other buildings" switch changed (flat in the event, see [Repositories on other floors](#repositories-on-other-floors)) |
| `repo_discovery.update` | `roots`, `interval_minutes`, `status` | #54: repository discovery's settings or a scan's status changed (a scan started, progressed, ended); flat in the event. `status.revision` moves only when the discovered repositories did (see [Repository discovery](#repository-discovery)) |
| `handoff.added` | `floor_id`, `session`, `handoff`, `handoff_count` | #223: a handoff was filed: its file is complete and indexed (#58: `floor_id` is its floor, `session` that floor's session; before #58 `session` was the floor, which it still is for a real floor; `handoff_count` the floor's count now; see [Handoffs](#handoffs)) |
| `handoff.removed` | `floor_id`, `session`, `handoff_id`, `handoff_count` | #223: a handoff was deleted (its file is in the trash) |
| `schedule.upsert` | `schedule` | #62: a schedule was created or updated, or its state changed (a fire began, waits, ended); the whole schedule (see [Scheduled agents](#scheduled-agents)) |
| `schedule.removed` | `id`, `floor_id` | #62: a schedule left the view: cancelled, dismissed, or a `done` one pruned beyond its floor's last 50 |
| `hire_preset.upsert` | `hire_preset` | #93: a hire preset was created or changed; the whole preset (see [Hire presets](#hire-presets)) |
| `hire_preset.removed` | `id` | #93: a hire preset was deleted, or its virtual floor was |
| `child.upsert` | `child` | #22: a native child agent was seen first or changed (the whole child: see [Native child agents](#native-child-agents-22)) |
| `child.removed` | `id`, `worker_id`, `generation` | #22: a child went from the provider's evidence, or merged into the row seen first. A worker's children go with its `worker.removed` and with a `worker.upsert` that raises its `child_generation`, without one |
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
`screen.frame_request` and `screen.grabbed` ([Screen share](#screen-share)): they go only to the sharing game. Nor are #74's `host.stats` and `host.disk` ([Host stats](#host-stats)): they go only to the connections that sent `host.watch`.

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
| `floor.assign` | `{"floor"|"session": string, "building": string \| null, "index"?: int}`: `null` moves the floor to the unassigned lot; `index` inserts at that position (clamped), omitted appends | — | `floor.upsert` for every floor whose position changed, `building.upsert` for the buildings involved |
| `floor.settings.set` | `{"floor"|"session": string, "repo"?, "project"?, "status_field"?, "default_cwd"?, "default_hire"?}`: an absent key stays as it is, `null` clears it, a value sets it (see [Floor settings](#floor-settings)) | — | `floor.upsert` carrying the new `settings` (and `suggested`, when the chosen repo changes it); none when nothing changed |
| `floor.wake` | `{"floor"|"session": string}` | `{"workers": [{"id", "resume"}]}`: every worker of the floor in sidebar order, `resume` one of `confirmed`, `fallback`, `failed`, or `none` (no `agent_session`: nothing to resume) | `floor.upsert` with `transition: "waking"`, `worker.upsert` (`resume: "pending"`) for each resumable worker, then the floor running and its workers as the watcher sees them, `worker.upsert` as each `resume` settles, and a final `floor.upsert` without `transition` |
| `floor.sleep` | `{"floor"|"session": string}` | — | `floor.upsert` with `transition: "sleeping"` (and `worker.upsert` for workers whose `resume` is cleared), then `floor.upsert` with `state: "asleep"` and no `transition`, then the asleep workers |
| `session.create` | `{"name": string}`: #58, a new herdr session (see [New herdr sessions](#new-herdr-sessions)) | `{"session": string}`, once its floor is in the world | the new floor's `floor.upsert` (`state: "running"`, in the unassigned lot), before the ack |
| `floor.create` | `{"name": string, "base_session": string}`: #58, a virtual floor on a discovered session (see [Virtual floors](#virtual-floors)) | the new floor (a `Floor`) | its `floor.upsert` (and `building.upsert` when it joined its base's building), to every client |
| `floor.rename` | `{"floor": string, "name": string}`: a virtual floor's display name | — | `floor.upsert` |
| `floor.delete` | `{"floor": string, "move_workers"?: bool}`: a virtual floor; refused while it has workers unless `move_workers` is `true`, which moves them to its base session's real floor first | — | `floor.removed` (with `floor_id`), `building.upsert` when it was in a building, #93 `hire_preset.removed` for each of its own hire presets; with moved workers, their `worker.upsert` on the real floor (new `floor`, `desk_index`, maybe `name`) after the `floor.removed` |
| `floor.hide` | `{"floor": string, "hidden": bool}`: #58 decision 2, a floor's stored hidden setting (any floor; see [Virtual floors](#virtual-floors)) | — | `floor.upsert` with `hidden`, to every client; none when it was already so |
| `hire.prepare` | `{"floor"|"session": string, "cwd"?: string}` | what the hire dialog shows: `{"cwd", "choice", "choice_source", "label", "git", "capacity", "herdr_instructions"}` (see [Hire and send home](#hire-and-send-home)) | — |
| `worker.hire` | `{"floor"|"session", "desk_index": int, "harness", "model", "effort", "label"?, "cwd"?, "worktree"?: bool, "prompt"?, "herdr_instructions"?: bool}` | `{"id", "workspace_id", "branch"?, "base_sha"?, "trust", "prompted"?, "prompt_error"?}` (`fetch_error` is reserved: a failed fetch is `fetch_failed`) | `floor.upsert` (when `desks` changes), then `worker.upsert` of the new worker at `desk_index` with `hired_at`, `harness`, `model`, `effort`, then its later upserts / statuses (marker, agent). #58 decision 3: on a virtual floor whose base session is asleep, `floor.wake`'s events for every floor of the session come first (see [Virtual floors](#virtual-floors)) |
| `worker.fire.prepare` | `{"id": string}` | `{"name", "label", "branch"?, "worktree", "dirty", "unpushed", "can_delete", "can_delete_branch", "reason"?, "can_fire", "fire_blocked"?}` | — |
| `worker.fire` | `{"id": string, "worktree"?: "keep" \| "delete" \| "delete_branch"}` (default `keep`) | `{"worktree": "kept" \| "deleted" \| "deleted_branch", "released": bool, "note"?}` | `worker.removed` with `reason: "sent_home"`, then `floor.upsert` when `desks` changes |
| `worker.wrapup` | `{"id": string, "prompt": string, "worktree"?: "keep" \| "delete" \| "delete_branch"}` (default `keep`) | `{"queued"?: true}` | the worker's upsert with `wrapup` `armed` (before the ack); later, on CLEAN, `worker.removed` with `reason: "sent_home"` (see [Wrap up](#wrap-up)) |
| `worker.wrapup.cancel` | `{"id": string}` | — | the worker's upsert without `wrapup` |
| `worker.changes` | `{"id": string}` | the worker's git changes, `{"cwd", "branch", "head", "upstream", "ahead", "behind", "base", "files", "stat", "diff", "diff_bytes", "truncated", "omitted"}` (see [Changes](#changes)) | — |
| `worker.commands` | `{"id": string}` | #136: the slash commands and skills of the worker's harness in its checkout, `{"commands": [{"name", "description", "argument_hint", "kind"}…], "partial": bool}` (see [Commands and skills](#commands-and-skills)) | — |
| `worker.files` | `{"id": string, "query": string, "limit"?: 1–100}` (default 30) | #137: the files and directories of the worker's checkout ranked against `query`, `{"files": [{"path", "kind", "indices"}…], "source", "reason"}` (see [Files](#files)) | — |
| `worker.repos` | `{"id": string}` | #247: the repositories and folders stored on the other floors of the worker's building (every building's with `repo_refs.all_buildings`), then (#54) the discovered repositories no floor names, one row per repository: `{"repos": [{"id", "source", "session"?, "building", "same_building", "repo"?, "dir"?, "cloned", "checkouts"?}…]}` (see [Repositories on other floors](#repositories-on-other-floors)) | — |
| `hire.commands` | `{"floor"|"session": string, "harness": string, "cwd"?: string, "worktree"?: bool}` | #39: `worker.commands` for a hire with no worker yet: `harness`'s commands and skills in the folder the hire would get (see [Completion before a hire](#completion-before-a-hire)) | — |
| `hire.files` | `{"floor"|"session": string, "cwd"?: string, "worktree"?: bool, "query": string, "limit"?: 1–100}` | #39: `worker.files` for a hire with no worker yet, in that folder | — |
| `hire.repos` | `{"floor"|"session": string}` | #39: `worker.repos` for a hire on `session` with no worker yet | — |
| `terminal.watch` | `{"id": string, "fps"?: 1–30, "cols"?: 40–300, "rows"?: 10–100, "fullscreen"?: bool}` | `{"pane", "cols", "rows", "zoom"?}` | `terminal.frame`s to this connection only; with `fullscreen` (true or false), also `terminal.state` (see [Fullscreen](#fullscreen-74)) |
| `terminal.unwatch` | `{"id": string}` | — | — |
| `terminal.zoom` | `{"id": string, "on": bool}` | `{"pane", "cols", "rows", "zoom"}` | a `terminal.state` and, if the size changed, a full `terminal.frame` (see [Fullscreen](#fullscreen-74)) |
| `worker.keys` | `{"id": string, "input": [{"text": string} \| {"key": string}…]}` | — | — (see [Input](#input)) |
| `worker.prompt` | `{"id": string, "text": string, "op"?: string}` | `{"queued": bool, "retried": bool, "sent"?: string, "terminal"?: true, "handoff"?: AgentHandoff, "existing"?: true}` | the worker's statuses |
| `worker.answer` | `{"id": string, "hash": string, "choice"?: 1–9, "cancel"?: true}` | `{"sent": [string…], "resolved": bool}` | the worker's upsert without its `question` when it moves on |
| `worker.answer_ask` | `{"id": string, "tool_use_id": string, "answers"?: [{"question": int, "choices"?: [int…], "other"?: string}…], "cancel"?: true, "prompt"?: string}` | `{"sent": [string…], "resolved": bool, "prompted"?: bool}` | the worker's upsert without its `ask` once the transcript has the answer (before the ack) (see [Laptops: asks](#laptops-asks)) |
| `transcript.watch` | `{"id": string, "limit"?: 1–500}` | `{"harness", "session", "version", "cursor", "has_more", "pending", "items"}` | `transcript.items` to this connection only (see [Laptops: transcript](#laptops-transcript)) |
| `transcript.unwatch` | `{"id": string}` | — | — |
| `transcript.page` | `{"id": string, "before"?: cursor, "limit"?: 1–500, "agent"?: string}` | `{"items", "cursor", "has_more"}` | — |
| `transcript.item` | `{"id": string, "item": string, "agent"?: string}` | `{"item"}` | — |
| `preset.create` | `{"name": string, "roles": {…}}` | `{"id": string}` | `preset.upsert` (see [Team presets and starting a run](#team-presets-and-starting-a-run)) |
| `preset.update` | `{"id": string, "name"?: string, "roles"?: {…}}` (`roles` replaces all five) | — | `preset.upsert`; none when nothing changed |
| `preset.delete` | `{"id": string}` | — | `preset.removed`, then `floor.upsert` for the floors whose `last_preset` it was |
| `run.prepare` | `{"floor"|"session", "issue"? \| "text"? \| "work_item"?, "preset"?, "orch"?, "extra"?}` | what the start-run dialog shows: `{"prompt", "label", "ticket", "preset", "orch", "cwd", "git", "capacity"}` | — |
| `run.start` | `{"floor"|"session", "desk_index", "issue" \| "text" \| "work_item", "orch", "preset", "extra"?, "worktree"?, "label"?, "prompt"?}` | `worker.hire`'s ack plus `{"launch_id", "prompt"}` | `worker.hire`'s, then the orchestrator's `worker.upsert` with `issue` and `work_item`, and `floor.upsert` with `last_preset` |
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
| `followups.test` | `{"threshold"?: 0.05–0.99}` | `{"ok", "reason"?, "threshold", "samples": [{"name": "questions" \| "grill" \| "done", "expect", "score", "flagged", "questions"?, "source"?, "error"?, "unlisted"?}], "latency_ms"}` | `followups.update` when it changes `tested` |
| `packup.get` | `{}` | pack up on request's state (see [Pack up on request](#pack-up-on-request)) | — |
| `packup.set` | `{"enabled"?: bool, "threshold"?: 0.05–0.99}` | its state | `packup.update` (before the ack) |
| `packup.test` | `{"threshold"?: 0.05–0.99}` | `{"ok", "reason"?, "threshold", "samples": [{"text", "expect", "core"?, "score", "matched", "task"?, "want_task"?, "right", "error"?}], "right", "total", "latency_ms"}` | `packup.update` when it changes `tested` |
| `packup.detect` | `{"id", "text"}` | `{"matched", "task"?, "removed"?: [{"start", "end"}], "score"}`; `matched` false: send `text` as written | — |
| `hire.interpret` | `{"text", "pending"?}` | `{"text", "intent"?, "reason"?, "hire"?, "error"?}`: a hire proposal for review, `unsupported` or `unclear`, or an operational `error` (see [Hire interpretation](#hire-interpretation)); never hires | — |
| `worker.answer_followup` | `{"id", "turn_id", "answers": [{"id", "value", "note"?}…], "note"?}` | `worker.prompt`'s | the worker's upsert without its `followup` |
| `worker.dismiss_followup` | `{"id", "turn_id"}` | — | the worker's upsert without its `followup` (before the ack) |
| `worker.retry_followup` (#60) | `{"id", "turn_id"}` | `{"source", "error"?}` once the extraction ran again | the worker's upsert with the new `followup` (before the ack) |
| `worker.followup_message` (#60) | `{"id", "turn_id"}` | `{"text", "cut"?}`: the message the follow-up is of | — |
| `worker.handoff_preview` | `{"worker", "candidate"}` (#224 `mode: "agent"`, #9 `mode: "llm"`: see [Ask the agent](#ask-the-agent), [LLM handoffs](#llm-handoffs)) | `{"candidate", "text", "truncated"?, "title", "provenance", "can_send_home", "send_home_blocked"?}` (see [Handoffs](#handoffs)) | — |
| `worker.handoff` | `{"worker", "mode": "literal", "session", "candidate", "revision", "send_home"?, "op"}` | `{"handoff", "existing"?, "send_home"?: "started" \| "skipped", "send_home_reason"?}` | `handoff.added` (before the ack) when filed; `worker.removed` later when sent home |
| `worker.handoff` (#9) | `{"worker", "mode": "llm", "session", "candidate", "revision", "instruction"?, "send_home"?, "op"}` | `{"job", "existing"?}` at once; the job follows on `Worker.llm_handoff` (see [LLM handoffs](#llm-handoffs)) | `worker.upsert` (the job), `handoff.added` when filed, `worker.removed` later when sent home |
| `handoff.list` | `{"floor", "q"?, "limit"?: 1–500}` | `{"floor", "handoffs": [HandoffEntry…]}` | — |
| `handoff.get` | `{"id"}` | `{"handoff", "body", "llm"?}` (#9: an LLM handoff's provenance) | — |
| `handoff.delete` | `{"id", "confirm": true}` | `{"handoff"}`; the file goes to the trash | `handoff.removed` (before the ack) |
| `inbox.dismiss` | `{"id", "status_since"}` | `{"dismissed": bool}` (see [Inbox](#inbox)) | `inbox.dismissed` (before the ack) when the dismissal is new |
| `activity.get` | `{}` | "Classify unknown commands"' state (see [Activity](#activity)) | — |
| `activity.set` | `{"model_enabled"?: bool, "threshold"?: 0.05–0.99, "margin"?: 0–0.9, "daily_cap"?: 1–100000}` | its state | `activity.update` (before the ack) |
| `codex_server.get` | `{}` | `{"enabled", "available", "allow_unverified"}`, the shared Codex server switch (see [Shared Codex server](#shared-codex-server)) | — |
| `codex_server.set` | `{"enabled"?: bool, "allow_unverified"?: bool}` | the switch; switching on without `available` is `unsupported` | `codex_server.update` (before the ack) when it changes |
| `repo_refs.get` | `{}` | `{"all_buildings"}`, the "Repositories from other buildings" switch (see [Repositories on other floors](#repositories-on-other-floors)) | — |
| `repo_refs.set` | `{"all_buildings": bool}` | the switch | `repo_refs.update` (before the ack) when it changes |
| `repo_discovery.get` | `{}` | `{"roots", "interval_minutes", "status"}` (see [Repository discovery](#repository-discovery)) | — |
| `repo_discovery.set` | `{"roots"?: [absolute path…], "interval_minutes"?: 1–1440}` (at least one) | the state; a change of roots scans at once | `repo_discovery.update` (before the ack) when it changes |
| `repo_discovery.refresh` | `{}` | the state; a scan starts (after the one in flight) | `repo_discovery.update` (before the ack) |
| `digest.get` | `{}` | the floor overview summaries' state (see [Floor overview summaries](#floor-overview-summaries)); it reads the LLM model's reasoning from its catalog when that was not read lately (#174) | — |
| `digest.set` | `{"enabled"?: bool, "daily_cap"?: 1–10000, "reasoning_effort"?: string, "max_tokens"?: 64–16384}` | its state; `reasoning_effort` `""` is the provider's default, else one the model's catalog lists (`bad_request` otherwise) (#174) | `digest.update` (before the ack) |
| `digest.test` | `{}` | `{"ok", "reason"?, "samples": [{"kind": "task"\|"now", "line"?, "error"?, "diag"?}], "latency_ms"}` (`diag`: the call's sanitized [diagnostics](#floor-overview-summaries)) | `digest.update` when it changes `tested` |
| `digest.retry` | `{"id"?: worker id}` | `{"retried": n}`: the failed lines of that worker (every worker without an id) are due again, their attempts counted anew; `incomplete` while the feature is off or the LLM not ready; `unknown_worker` (#174) | `worker.upsert` of the workers whose line status changed |
| `notify.get` | `{}` | the notifications' state (see [Notifications](#notifications)) | — |
| `notify.set` | `{"enabled"?: bool, "events"?: {"needs_you"?: bool, "done"?: bool}, "quiet"?: bool, "freelancers"?: bool, "replies"?: bool}` | its state; switching on needs a token (`not_configured`), a paired account (`not_paired`) and a delivered `notify.test` of both within 30 minutes (`test_required`); `env_locked` while the environment sets it. #13: switching `replies` on needs a token and a paired account (no test) | `notify.update` (before the ack) |
| `notify.test` | `{}` | `{"ok": true, "latency_ms"}`: the test message reached Telegram for the paired account; else its delivery's code (`blocked`, `unauthorized`, `rate_limited`, `unreachable`, `timeout`, `provider_failed`) | `notify.update` when it changes `tested` or `last_error` |
| `notify.token.set` | `{"key": bot token}` | its state, once Telegram's `getMe` accepted the token (`bad_request`: not shaped like one; `unauthorized`); another bot's token unpairs; `env_locked` when the environment gives the token. Audited as `{"key_given": true}` | `notify.update` (before the ack) |
| `notify.token.clear` | `{}` | its state: the token and the paired account forgotten (`env_locked` as above) | `notify.update` (before the ack) |
| `notify.pair.start` | `{}` | its state with `channel.pairing`: a one-time code to send the bot (`not_configured` without a token; Telegram's `getMe` checks it first) | `notify.update` (before the ack, and as the pairing moves) |
| `notify.pair.cancel` | `{}` | its state: the bridge stops waiting for the code | `notify.update` (before the ack) |
| `notify.unpair` | `{}` | its state: the paired account forgotten (the token stays) | `notify.update` (before the ack) |
| `handoff_llm.get` | `{}` | the LLM handoffs' state (see [LLM handoffs](#llm-handoffs)); it reads the LLM model's reasoning from its catalog when that was not read lately | — |
| `handoff_llm.set` | `{"enabled"?: bool, "input_bytes"?: 16384–786432, "max_tokens"?: 1024–32768, "reasoning_effort"?: string}` | its state; switching on needs a passing `handoff_llm.test` of the config in use (`test_required`) and the LLM ready (`incomplete`); `env_locked` while the environment sets it | `handoff_llm.update` (before the ack) |
| `handoff_llm.test` | `{}` | `{"ok", "reason"?, "title"?, "bytes", "latency_ms", "diag"?}`: the LLM wrote a handoff of a synthetic session | `handoff_llm.update` when it changes `tested` or the binding |
| `whiteboard.get` | `{"floor"}` | the board's state, `{"floor", "version", "author", "at", "render_version", "render", "stale", "stale_pins"}` (its content is HTTP, see [Whiteboard](#whiteboard)) | — |
| `whiteboard.clear` | `{"floor", "confirm": true, "author"?}` | the new state | `whiteboard.updated` |
| `whiteboard.pin` | `{"floor", "author", "note", "request_id"?}` (an image: `POST /whiteboard/{floor}/pin`) | the new state plus `{"elements": [id…], "repeated"?}` | `whiteboard.updated` (none for a repeated `request_id`) |
| `drops.list` | `{"limit"?: 1–50}` (default 20) | `{"drops": [{"path", "name", "size", "mtime", "mime", "image", "reason"?}…]}` | — |
| `board.watch` | `{"floor"|"session"}` | `{"enabled": bool, "reason"?}`, then `board.issues` and `board.prs` to this connection (see [Boards](#boards-issues-and-pull-requests)) | — |
| `host.watch` | `{}`: #74, start sending this connection the host's stats (see [Host stats](#host-stats)) | — | `host.stats` after about a second and every 5 s, `host.disk` every second, to this connection only |
| `host.unwatch` | `{}` | — | the frames stop (when it was this connection's last watch, the bridge stops sampling) |
| `board.unwatch` | `{"floor"|"session"}` | — | — |
| `board.refresh` | `{"floor"|"session"}` | `{"queued": bool}` | the boards of the poll, to the watchers |
| `issue.get` | `{"floor"|"session", "id"}` | `{"card", "body", "author", "created_at", "comments", "comments_truncated"}` | — |
| `issue.comment` | `{"floor"|"session", "id", "body"}` | `{"comment"}` | boards after the refresh |
| `issue.close` | `{"floor"|"session", "id", "reason", "confirm": true}` | — | boards after the refresh |
| `issue.set_status` | `{"floor"|"session", "id", "column", "after"?}` (`after`: null or a card id, with the `order` capability) | — | boards after the refresh |
| `pr.get` | `{"floor"|"session", "id"}` | `{"pr", "body", "author", "created_at", "files", "files_truncated", "checks", "comments", "comments_truncated"}` | — |
| `pr.comment` | `{"floor"|"session", "id", "body"}` | `{"comment"}` | boards after the refresh |
| `pr.merge` | `{"floor"|"session", "id", "method", "confirm": true, "override"?, "confirm_override"?}` | `{"merged": true}` | boards after the refresh |
| `worker.open_pr.prepare` | `{"id"}` (worker id) | `{"can_open", "reason"?, "branch", "base", "ahead", "dirty", "existing"?, "title", "body"}` | — |
| `worker.open_pr` | `{"id", "title", "body", "confirm": true}` | `{"pr": {"id", "key", "url"}, "pushed", "existed"}` | boards after the refresh |
| `schedule.create` | #62: `{"floor", "title", "prompt", "due_at", "on_miss"?, "max_lateness_ms"?, "harness", "model", "effort", "cwd", "worktree"?, "wake_floor"?, "handoff_path"?, "source"?}` (see [Scheduled agents](#scheduled-agents)) | the schedule | `schedule.upsert` |
| `schedule.update` | `{"id", …}`: `schedule.create`'s args without `source`, the whole spec replaced; only while `scheduled`. `schedule.create`, `schedule.update` and `schedule.retry` answer `busy` while a send home removes the worktree `cwd` is in (#63, see "Worktree hold") | the schedule | `schedule.upsert` |
| `schedule.cancel` | `{"id"}`; only while `scheduled` or `waiting` | the schedule, `cancelled` | `schedule.removed` |
| `schedule.run_now` | `{"id"}`; only while `scheduled` | the schedule, as its fire left it (`running`, `waiting` or `failed`) | `schedule.upsert`, then the hire's |
| `schedule.retry` | `{"id"}`; only while `failed` or `skipped`: the same spec, fired now | the schedule, as its fire left it | `schedule.upsert`, then the hire's |
| `schedule.dismiss` | `{"id"}`; only while `failed` or `skipped` | the schedule, with `dismissed_at` | `schedule.removed` |
| `hire_preset.create` | #93: `{"name", "floor"?, "prompt", "harness", "model", "effort", "herdr_instructions"?: bool}`; `floor` empty or absent: global (see [Hire presets](#hire-presets)) | the preset | `hire_preset.upsert` |
| `hire_preset.update` | `{"id", …}`: `hire_preset.create`'s args, the whole spec replaced (its scope and #95 `herdr_instructions` too) | the preset | `hire_preset.upsert`; none when nothing changed |
| `hire_preset.delete` | `{"id"}` | — | `hire_preset.removed` |
| `hire_preset.check` | #95: `{"prompt"}` (1–32 KiB, not blank) | `{"delegates": bool, "score"}`; `delegates` false also when the classifier is not ready, fails or takes over 1.2 s | — |

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
not, is `unknown_session`. #58: a virtual floor's checks are its base session's (it wakes, sleeps and is busy with it).

**Floor ids in commands (#58).** Every floor-scoped command (`floor.assign`, `floor.settings.set`, `floor.wake`,
`floor.sleep`, `hire.prepare`, `hire.commands`, `hire.files`, `hire.repos`, `worker.hire`, `run.prepare`, `run.start`,
`board.*`, `issue.*`, `pr.*`, and `whiteboard.*`, `screen.grab` and `handoff.list`, which always took `floor`) names its
floor by `floor`, a floor id. A client from before #58 sends `session` instead: the bridge reads it as that session's
real floor (`floor` wins when both are set). The bridge resolves the floor's herdr session itself: herdr is only ever
called with a session, never with a virtual floor's id.

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
| `run.prepare`, `run.start` | `extra` | 8 KiB (`maxRunExtra`) | Start Run's Extra instructions; the bridge folds it, trimmed, into the orchestrator's first prompt, so `run.prepare`'s `prompt` shows the markers (#39: and `/skill`, `@path` as typed; `run.start` rewrites them for Codex when it sends the prompt) |
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

### Shell policy

Two commands of the bridge run a shell of the user's: the wake's login shell (`systemd-run … <shell> -l -c
"exec herdr --session '<name>' server"`) and a shared Codex worker's launcher (`setsid -f <shell> <launcher>`, typed
into the worker's pane). Which shell is a **two-value policy**, never a command (#68):

| Policy | Wake argv | Launcher (`<--codex-run>/<marker hex>…`) | Typed into the pane |
|---|---|---|---|
| `bash` (default) | `<abs bash> -l -c "exec herdr …"` | `.sh` | `setsid -f <abs bash> <launcher> </dev/null >/dev/null 2>&1` |
| `fish` (explicit compatibility) | `/bin/fish -l -c "exec herdr …"` | `.fish` | `setsid -f fish <launcher> </dev/null >/dev/null 2>&1` |

- **Setting it.** `herdr-world serve --shell bash|fish`, or `HERDR_WORLD_SHELL` (the flag wins); empty is `bash`. Any
  other value refuses the start. `$SHELL` is never read, and a fish that is merely installed, or an inherited
  `SHELL=…/fish`, never selects fish.
- **Finding it.** The absolute path of the policy's executable: `bash` is the first of `$PATH`, `/usr/bin`, `/bin` and
  `/usr/local/bin`; `fish` is `/bin/fish` when it exists (so its argv stays v1.45.0's), else the same search. It is
  resolved and checked **at startup**: a shell that is not installed refuses the start with an error that names the
  option and both fixes (install it, or choose the other one), and the path is checked again (one stat: it exists, is a
  regular file once symlinks are followed, has an execute bit) before every wake and launch, so the same error
  surfaces, with nothing dispatched, if the shell disappears or loses its execute bit later. The bridge never falls back to the other shell. The path is typed into a pane, so it
  must be plain characters (`ValidPlainDir`); `fish` is typed as `fish` (the pane's `PATH`), as before.
- **Wake.** Unchanged apart from the interpreter: `--working-directory`, `KillMode=process`, the unit name and
  `CleanEnv` are as before. A login shell reads the *login* files (`/etc/profile`, `~/.bash_profile` or `~/.profile`
  for bash; `config.fish` for fish), and the inner bare `herdr` is looked up on that shell's `PATH`: on a bash host
  `herdr` must be reachable from the login files (for example `~/.local/bin` added in `~/.profile`).
- **Launcher.** `Launch.Script()` follows the policy's shell; placeholder validation, `Write`, `Remove` and recovery
  agree on it. `Remove` deletes the launcher of **every** shell's format, so a launch v1.45.0 recorded (a `.fish`
  file; the stored record has no shell) is still cleaned up, stopped and recovered by a bash-default bridge; a
  launch is always started afresh from a new launcher, never by re-running an old one. The extension `.sh` is only
  a name: the launcher is always run explicitly by the policy's shell (`bash <file>`), never as `sh`.
- **Bash launcher.** A script run as `bash <file>` reads no startup file, so a `codex` function or alias of the
  user's `~/.bashrc` would silently be lost (fish reads `config.fish` even then). The bash launcher marks and
  records itself, then **re-executes itself as an interactive bash** (`exec "$BASH" -i +H -c '<one command line>'`):
  `~/.bashrc` is read as the pane's own shell reads it (behind the usual `[[ $- != *i* ]] && return` guard), the
  pane's exports (`PATH`, direnv's values, `HERDR_PANE_ID`) are inherited, and no terminal is needed. The pid in
  the pid file is that process: it stays the supervisor (a `codex` function runs as its child) and its own
  environment carries the `H3D_CODEX_SERVER` marker. `HISTFILE` is unset (a launch never rewrites the user's
  history) and history expansion is off. Supported: a `codex` shell function or alias defined in `~/.bashrc` (or
  the system's interactive startup file), also one that calls `command codex`. Not supported: anything that needs a
  controlling terminal or a prompt (a `.bashrc` that `exec`s another shell, asks a question or reads the tty),
  and functions or aliases that only a login file (`~/.bash_profile`) or the prompt (`PROMPT_COMMAND`, a direnv
  hook) defines: the pane's *exported* environment, direnv's included, reaches the server, but only `~/.bashrc`'s
  functions and aliases are re-created.
- **Fish compatibility.** `--shell fish` keeps v1.45.0's wake argv, launcher and `fish` wrapper loading exactly.
  It is a compatibility option for users whose `config.fish` holds their wrappers; nothing else changes.

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

0. #58: the bridge waits for the last server's unit `herdr-s-<name>` to unload, up to 15 s (it looks for its unit file
   under `systemd/transient/` in the user's runtime directory, `$XDG_RUNTIME_DIR`, else `/run/user/<uid>`, every
   100 ms). `herdr session stop` ends the server, but processes it started outside its panes (its update and
   agent-manifest `curl`s, bounded by their `--max-time`, 15 s / 20 s per attempt, with retries) stay in the unit
   (`KillMode=process`) and keep it loaded until they exit, and `systemd-run` refuses a unit name that is still loaded
   ("Unit herdr-s-<name>.service was already loaded or has a fragment file"). A wake right after a sleep therefore
   waits; a unit still loaded after 15 s is `wake_failed` ("the service herdr-s-<name>.service is still loaded: …"),
   with nothing started. The bridge does not kill them: they are herdr's.
1. `systemd-run --user --unit=herdr-s-<name> --collect -p KillMode=process --working-directory=$HOME <shell> -l -c
   "exec herdr --session '<name>' server"` (`<shell>`: the [shell policy](#shell-policy), bash by default): a
   supervised headless server with the user's login environment (their login-shell wrappers and API keys, none of the bridge's `CLAUDE*`/`HERDR_*` variables). It fails (`wake_failed`) if the unit
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

### New herdr sessions

#58: the Add floor dialog's "New herdr session". herdr has no `session create`: a session is created by starting a
server under a name herdr has not seen, so `session.create` runs the wake's launch (step 1 of the wake, the
`create-session` shape) for a new name, and the floor comes in through discovery like any other, empty and in the
unassigned lot. It never goes through the floor checks of the other floor commands: the floor does not exist yet.

```json
{"t":"session.create","req_id":"21","args":{"name":"billing-api"}}
{"t":"floor.upsert","seq":1110,"floor":{"session":"billing-api","state":"running","building":null,"index":null,"desks":6}}
{"t":"ack","req_id":"21","data":{"session":"billing-api"}}
```

1. **The name** (`bad_request`, the message says why in words a person can act on): `^[a-z0-9_-]+$` (stricter than
   herdr: no uppercase, no dots), no leading `-`, not `default`, not a virtual floor id's `v-<12 hex>` (#58: floor ids
   and session names share one namespace, so that shape is reserved; a real session that already has such a name is
   still a floor and a base like any other), and at most as long as this host allows: the
   session's `herdr-client.sock` must fit the 108-byte `sun_path`, so the cap is `108 − len(<sessions folder>) − 1 −
   len("/herdr-client.sock")` (56 for `/home/jeff/.config/herdr/sessions`). The sessions folder comes from `herdr
   session list` (a named session's parent folder, else `sessions/` in the default session's). With `--sessions` set,
   the name must match it too: a session outside it would never show as a floor.
2. **Free** (`name_taken`): not a floor (a virtual floor's id is refused by its shape, step 1), not in `herdr session list` in any state (starting a known name would wake
   that session instead: an asleep one is refused too), nothing at `<sessions folder>/<name>` (a stale folder, a
   backup), and no transient unit `herdr-s-<name>.service` still loaded (its unit file under `$XDG_RUNTIME_DIR`).
3. **One at a time** (`busy`): a second `session.create` of a name being created is refused.
4. **Started**: the server starts in its transient unit, the bridge asks the watcher to look again (every 250 ms) and
   acks once it sees the floor running. herdr lists a new session ~90 ms after the start. Not seen within
   `--wake-timeout` (10 s), or `systemd-run` fails: `session_create_failed` with herdr's error, after the bridge stopped
   the session (`herdr session stop`) and removed the session folder it made (there was none before, step 2).

The audit log row starts with the command and ends with the sessions folder, whether herdr was asked to start it, how
long until the floor was seen, and what a rollback did.

### Virtual floors

#58: a **virtual floor** is a user-defined floor inside an existing **base session**: its own name, desks, names,
settings (repository, board, default folder, default hire), last hire, last preset and whiteboard, while its workers'
workspaces live in the base session. Every discovered session keeps its **real floor** (floor id = session name).

```json
{"t":"floor.create","req_id":"31","args":{"name":"Frontend","base_session":"herdr-3d"}}
{"t":"floor.upsert","seq":1201,"floor":{"id":"v-3fa9c1d2e4b5","name":"Frontend","session":"herdr-3d",
  "base_session":"herdr-3d","virtual":true,"hidden":false,"state":"running","building":"b_3f09a1c2d4e5","index":2,"desks":6}}
{"t":"ack","req_id":"31","data":{"id":"v-3fa9c1d2e4b5","name":"Frontend","session":"herdr-3d", …}}
```

**Identity.** A virtual floor's id is `v-` and 12 lower-case hex digits, minted by the bridge: never a discovered or
starting session's name (`session.create` refuses the shape), and a safe single path component (its whiteboard folder
is named by it). Whether a floor is virtual is its `virtual` flag (the bridge: a stored definition), never its id's
shape: a session discovered with a `v-<12 hex>` name from before the shape was reserved is a real floor and can be a
base. The definition
(`virtual_floor`: id, name, base session) is stored and kept while the base session is away; the floor is in the world
(`floor.upsert`) only while its base session is: a session that goes away removes its real floor and its virtual floors
(`floor.removed` for each, `floor_id` naming it, after its workers' `worker.removed`), and they come back with it.
Every definition change goes to every client.

**Workers.** The bridge's store, never herdr, says which floor a worker is on (herdr keeps no session metadata, and
loses workspace tokens on a restart). `worker.hire` and `run.start` on a virtual floor create the workspace in the base
session and record the floor with the worker from its first observation, so it never shows on the base floor, and its
stored floor brings it back to its floor after a herdr restart, a sleep and wake, or a bridge restart (identity as in
[Worker](#worker-a-herdr-workspace)). A workspace with no stored floor (made in the herdr TUI, a helper an agent
spawned) is on its session's real floor; so is one whose stored floor was deleted (and the store is told). Nothing is
hidden. Desks, names, capacity (`--max-workers-per-floor`), repository suggestions and run links are per floor.

**Freelancers (stage 3).** A worker's floor is **attributed** when the bridge hired it (`hired_at`, whichever floor) or
its stored floor is a virtual floor; any other worker is on its session's real floor only because nothing said
otherwise. A worker that is not attributed takes, on the observation that decides it:

1. a freelancer (`code`, `review`, `ux`, `ground`), its orchestrator's floor as soon as its run links it to one (the
   `orch_id` link of [Runs and freelancers](#runs-and-freelancers): by run, `h3d_run` token or label); the
   orchestrator's floor is the one its `run.start` launch record names while that is a floor, else the floor it is on
   (`floor.delete` with `move_workers` leaves the record naming the deleted floor);
2. else the floor its `h3d_floor` token names (the prompt in
   [Team presets and starting a run](#team-presets-and-starting-a-run) asks the orchestrator for it), when that is a
   floor of the same session.

Only a floor of the workspace's own session counts (a run linking across sessions moves nobody; a token naming
another session's floor, an unknown floor or anything else is ignored). The floor is stored with the worker at once,
so the first `worker.upsert` after the link already names it, and after a herdr restart (tokens gone, the link may not
resolve again) or a bridge restart the stored floor keeps it there. An attributed worker is never moved by either.

**Buildings (decision 4).** A virtual floor always stands in its base session's floor's building: `floor.create` puts it
last in that building (unassigned when the base is), `floor.assign` of a virtual floor only moves it within that
building (another building or `null`: `bad_request`), assigning the base floor to another building takes its virtual
floors along right after it, and unassigning it unassigns them.

**Wake and sleep.** A floor's wake and sleep are its session's: `floor.wake` / `floor.sleep` on a virtual floor wake or
put to sleep the base session, and with it every floor on it; their `state` and `transition` are the base session's.

| command | rule, else |
|---|---|
| `floor.create` | `name`: trimmed, 1–64 bytes, no control characters (`bad_request`); `base_session`: a discovered session (`unknown_session`) the bridge watches (`--sessions`, `unknown_session`) |
| `floor.rename` | `floor`: a virtual floor (a real floor: `bad_request`; unknown: `not_found`); `name` as above |
| `floor.delete` | `floor` as above; without `move_workers`, refused with `invalid_state` while workers are on it ("floor “Frontend” has 2 workers: …", hires in flight count; while its base session is away, the workers stored on it). With `move_workers: true` its workers (in the world or only stored) go to the base session's real floor, which seats them at its lowest free desks and names them as newcomers (a name already taken there changes); `busy` while a hire on it is in flight. Its desks, names, settings, last hire, last preset, board cache, building place, hidden setting and (#93) its own hire presets go (`hire_preset.removed` each; global ones stay); its handoffs and its whiteboard folder stay (files are never deleted with a definition; the id is never minted again) |
| `floor.hide` | `floor`: a floor in the world (`unknown_session`), or a virtual floor whose session is away; `hidden`: the setting |

**Hidden (decision 2).** `hidden` is stored per floor (real or virtual) and set with `floor.hide`; the bridge only
stores it and broadcasts it on `floor.upsert`. A client hides a hidden floor from its lists while it has no worker, so
an unattributed workspace on a hidden base floor shows it again.

**Hiring on an asleep virtual floor (decision 3).** `worker.hire` and `run.start` on a virtual floor whose base session
is asleep wake the session first (its own `floor.wake` audit row), then hire as on a running floor; the hire's ack comes
after both. The wake is the client's "Waking floor…" stage: from the command until the floor is running, the hire's
floor (and every floor of the session) carries `transition: "waking"` on `floor.upsert`, as for a `floor.wake`. A wake
that fails fails the command with the wake's code and words (`wake_failed`, "waking floor “Frontend” (session herdr-3d)
before the hire: …"), and nothing is hired. The args a hire can be refused for without a floor (`desk_index`, harness,
model, effort, prompt; `run.start`'s `orch` and `preset`) are checked before the wake, the rest (desk, capacity, label,
cwd, ticket) after it. `hire.prepare` and `run.prepare` answer on an asleep virtual floor, so its dialogs open there. A
second hire while the session wakes is `busy`; on an asleep real floor a hire stays `invalid_state`. The ack can take
the wake (up to `--wake-timeout` plus twice the resume timeout) longer than a hire on a running floor.

### Hire and send home

Hire and send home act only on **running** floors the bridge watches (`--sessions`): an unwatched or unknown session is
`unknown_session`, an asleep floor `invalid_state` (#58: a virtual floor's hire wakes its session instead, see
[Virtual floors](#virtual-floors)), a floor that is waking or sleeping `busy`.

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
| `herdr_instructions` | #95: the herdr hiring instructions for this floor, exactly as `worker.hire` with `herdr_instructions` adds them after a blank line: `run.start`'s placement line and floor line (`h3d_floor=<this floor id>`; a client from before floor ids gets the session's). The hire form shows them before Hire. A bridge from before #95 leaves it out. |
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
| `floor` (or `session`) | a running, watched floor (#58: a floor id; a virtual floor's base session must run) |
| `desk_index` | `0 ≤ desk_index < max(floor.desks, max_desks)`, and free: no worker holds it and no other hire in flight reserved it (else `desk_taken`, also for an out-of-range desk). A desk beyond the current outline grows the floor when reserved, before its workspace appears; a floor shrinking while the form is open does not invalidate the hire. Pending hires count toward spare desks on their own floor. Two hires to one desk: the first accepted wins, the other is `desk_taken`. |
| `harness`, `model`, `effort` | one of `hire_options` (as `default_hire`) |
| `label` | 1–64 bytes, no control characters, not starting with `-`; default: the next generated name (`hire.prepare`'s `label`). The worker's name is the label when that is a free generated name, else the next generated name. |
| `cwd` | absolute, existing directory; default as in `hire.prepare` |
| `worktree` | `true`: hire into a new linked git worktree and branch of `cwd`'s repository (below); `cwd` must be in a git work tree with a known `origin/<default>` |
| `prompt` | optional first task, 1–32768 bytes of UTF-8 without NUL, not starting with `--` (herdr's CLI would read it as a flag). Sent once the agent is ready. For Claude it is typed (#95, step 5): no control characters but line ends (`\r\n` and `\r` go as `\n`) and tabs (four spaces each), at most 32768 bytes as typed, else `bad_request`. The game sends pasted images as `[Image #n: <absolute path>]` markers in the text, after uploading them (`POST /upload`, above). #39: it is what the dialog's composer holds (`/skill`, `@path`, plain repository paths and URLs): for Codex the bridge rewrites it once, when it sends it (see [Completion before a hire](#completion-before-a-hire)). |
| `herdr_instructions` | #95, optional: `true` appends a blank line and the herdr hiring instructions for the hire's floor (the floor after `floor`/`session` resolves, a virtual floor its own id) to `prompt`, in `run.start`'s order: the placement line, a blank line, the floor line. It needs a `prompt` (else `bad_request`). The whole composed prompt is held to `prompt`'s rules (size, typed for Claude), so a task that fits alone and not with the lines is `bad_request`; #39's Codex rewrite touches the typed task only, never the lines. Only to a bridge whose snapshot says `herdr_instructions` (see [Hire presets](#hire-presets)). |
| `handoff`, `stop_services` | reserved (#11, #14); refused like any unknown field |

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
   command into the pane's shell, so the user's own shell wrappers apply. Native args, exactly:
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
   `Enter` (up to 3 times) until the worker is working; #39: for a prompt that ends in a `$skill` (Codex's skill popup
   takes the Enter) each press is `esc` then `enter`, as `worker.prompt`'s retry. A prompt that fails does not undo the
   hire: the ack has `prompted: false` and `prompt_error`.
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
| `can_delete` | the worker is in a linked worktree, the tree is clean, nothing is unpushed and no schedule holds it (#63, below). Only then may `worker.fire` delete the worktree. |
| `can_delete_branch` | `can_delete`, and the bridge recorded making a branch for this worker (`hire_branch`), the checkout is on that branch now, and every commit of that branch is on a remote. Only then may `worker.fire` use `delete_branch`: offer "delete worktree + branch" only when this is `true`. |
| `reason` | why `can_delete` is false. #63: a worktree a schedule holds reads `used by scheduled agent '<title>' at <due>`, with `and <n> more` when several do (the earliest due is named); this comes before any dirty or unpushed reason. |
| `can_fire`, `fire_blocked` | `false` (and why) when herdr would refuse to close the workspace: a repository's main checkout with an agent in it whose linked worktree workspaces are still open on the floor (herdr's `workspace_group_close_required`; send those home first). The bridge never closes a group. (An agentless main checkout is not a worker while worktrees are open, so there is nothing to send home: below.) |

**`worker.fire`** sends the worker home:

```json
{"t":"worker.fire","req_id":"41","args":{"id":"a58752ea-6511-4318-be9a-59e41c09d7c5","worktree":"keep"}}
{"t":"worker.removed","seq":1300,"id":"a58752ea-6511-4318-be9a-59e41c09d7c5","session":"herdr-3d","workspace_id":"w9","reason":"sent_home"}
{"t":"ack","req_id":"41","data":{"worktree":"kept","released":true}}
```

1. `worktree` `delete` / `delete_branch` need a worker in a linked worktree (else `bad_request`), no schedule holding
   it (#63: `invalid_state`, the `message` ending in `worker.fire.prepare`'s `reason`; checked against the checkout
   when the command arrives and against the tree's top before anything is touched, and nothing happens) and a clean,
   fully pushed tree, checked again now (else `not_clean`, and nothing happens). `delete_branch` also needs a branch the
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
   branch or the branch got unpushed commits during the exit, the worktree is kept and `note` says so. #63: so is a
   worktree a schedule came to hold during the exit (`note`: `used by scheduled agent '<title>' at <due>: the worktree
   is kept`), for a wrap-up's send home too.
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

`handoff` (#11) and `stop_services` (#14) are reserved `worker.fire` arguments; today they are refused like any unknown
field. When `handoff` comes it files through the same filing service as `worker.handoff` (see [Handoffs](#handoffs)):
the same path, front matter, index, audit and "send home only after a successful filing" rule, never a second writer.
Today a handoff with a send home is `worker.handoff` with `send_home: true`.

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
   reports it (`not_clean`, nothing sent), and no schedule may hold it (#63: `invalid_state` with
   `worker.fire.prepare`'s `reason`, nothing sent; `keep` may still be armed). `prompt` is 1 byte to 16 KiB minus the footer, without NUL, and for Claude
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
   | `CLEAN`, armed with a delete, and a schedule holds the worktree now (#63; made after the arm) | **Kept**: the worker is sent home with `keep` (the workspace closes, the worktree and branch stay; never a delete), and the note `used by scheduled agent '<title>' at <due>: the worktree is kept` is in the `worker.fire` row's `result`, as `wrapup.reason` and a step. Whether the tree is clean does not matter then. |
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
| `floor` (or `session`) | a running, watched floor (as `hire.prepare`) |
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

The **prompt** (#39: the skill call is the orchestrator harness's, `/write-code` for Claude, `$write-code` for Codex):

```
/write-code https://github.com/JeffreyVdb/lab/issues/3

Team:
- coders: claude claude-opus-5-5, effort medium
- reviewers: codex gpt-6-sol, reasoning high
- ux reviewers: codex gpt-6-sol, reasoning high
- researchers: codex gpt-6-sol, reasoning low

Start every agent you hire in its own herdr workspace or tab, never in a split pane of your tab or of another agent's tab: a laptop shows a pane at its own size, and a fullscreen terminal is wanted.

Also tag every herdr workspace you create with the token h3d_floor=<floor id>, in the same herdr workspace report-metadata call as its other h3d_ tokens: it puts that agent on your floor.

Move the ticket status accordingly, pull request always means QA, merging the PR always means Done.

<extra, trimmed>
```

The first line is `/write-code <ticket>` for a Claude orchestrator and `$write-code <ticket>` for a Codex one;
`<ticket>` is the issue URL, or the text. A role line says `effort <e>` for a claude role and `reasoning <e>` for a codex
one. The placement line (#74: a laptop shows a pane at its own size, so every agent goes in its own workspace or tab,
never in a split) is always there, and after it the floor line (#58) naming the floor the run starts on (its id: a
session name or a virtual floor's `v-…`). The floor line is a hint for the run's workspaces nothing else places (see
Freelancers in [Virtual floors](#virtual-floors)): freelancers land on their orchestrator's floor through their run
link whether or not the orchestrator tags them, and the write-code skill itself never names a floor. The status line is there for an issue ticket only (the orchestrator then moves the issue's status:
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

#39: what a person typed reaches a Codex orchestrator as `worker.hire`'s first task does (see [Completion before a
hire](#completion-before-a-hire)): the `extra` inside the composed prompt, or an edited `prompt` whole, rewritten once
when the hire sends it; the ticket the bridge composes around the extra (an issue's URL, a Kaneo task's title and
description) never is, whatever it holds. The ack's `prompt` is the text sent (rewritten). `run.prepare`'s `prompt` is
the preview as typed (never rewritten).

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
| `session` | the floor's herdr session |
| `floor` | #58: the floor id whose board it is (a virtual floor has its own board) |
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
| `board.watch` | `{floor\|session}` | `{"enabled": bool, "reason"?}`: `enabled: false` with a `reason` (`"no repo linked"`, `"boards are not configured"`; #184, a Kaneo floor: `"Kaneo is not connected: connect it in Settings"`, `"no Kaneo project linked"`, `"this bridge has no Kaneo settings"`, `"this bridge cannot read Kaneo boards"`: no tracker could be made of the saved connection, e.g. it changed meanwhile; watch again) and no messages; else the messages follow (`board.prs` only with a code host) |
| `board.unwatch` | `{floor\|session}` | — |
| `board.refresh` | `{floor\|session}` | `{"queued": bool}`; `unsupported` on a floor with no board |
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
directory per floor, named by its floor id (#58: a real floor's session name, a virtual floor's `v-…`; a deleted
virtual floor's directory stays), `0700`, files `0600`, every write a temp file renamed into place:

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

The saved instance's web host is what the helper may open "Open in Kaneo" links on (see [Through
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

#39: a hire's first prompt is rewritten by the same rules, once, when the hire sends it (see [Completion before a
hire](#completion-before-a-hire)):

| Route | Rewritten for Codex |
|---|---|
| `worker.prompt` `text`, `worker.answer_ask` `prompt` | yes: the composer's text, on the worker's lane |
| `worker.hire` `prompt` | #39 yes: the dialog's first task, when the hire sends it |
| `run.start` `extra` | #39 yes: inside the composed prompt; the ticket around it never |
| `run.start` `prompt` | #39 yes: an edited First prompt, whole |
| `worker.answer_followup`, `worker.wrap_up` | no: the bridge builds them |

#224: an exact top-level **`/handoff [instruction]`** (the text, trimmed, starts with `/handoff` and then a blank or
its end; read before any translation) is not sent as typed: it becomes an agent handoff request (see [Ask the
agent](#ask-the-agent)) with that instruction and the optional `op` (1–64 of `[A-Za-z0-9_-]`; none: the bridge makes
one). The ack has `handoff` (the request) and `existing: true` when the op was known or the worker's running request
was answered: nothing is sent again. A known op is answered with its request as it is now (pending, filed or failed;
a settled one from the store, across restarts), so the game resends an unanswered `/handoff` (its ack lost: the
connection dropped or it timed out) with the same op while the text and the worker are the same, and never asks twice. Prose, a quoted example, `/handoff/x` and `/handoffs` are prompts as typed, and
so is every `/handoff` to a bridge without a filing cabinet. Typed directly into the worker's terminal it is the
agent's own, native command.

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

#### Repositories on other floors

#247. **`worker.repos`** lists the repositories and folders configured on the **other floors of the worker's
building**, read-only, for the composer's `@r:` (the game asks once per popup and ranks the rows itself). #54 merges in
the repositories [discovered](#repository-discovery) under the bridge's scan roots, one row per repository:

```json
{"t":"worker.repos","req_id":"58","args":{"id":"a58752ea-6511-4318-be9a-59e41c09d7c5"}}
{"t":"ack","req_id":"58","data":{"repos":[
  {"id":"gh:acme/api-server","source":"floor","session":"api","building":"Work","same_building":true,"repo":"acme/api-server","dir":"/home/me/src/api","cloned":true},
  {"id":"gh:acme/web","source":"floor","session":"web","building":"Work","same_building":true,"repo":"acme/web","dir":"/home/me/devel/web","cloned":true,"checkouts":2},
  {"id":"dir:/home/me/notes","source":"floor","session":"notes","building":"Work","same_building":true,"dir":"/home/me/notes","cloned":false},
  {"id":"gh:acme/lib","source":"floor","session":"lib","building":"Home","same_building":false,"repo":"acme/lib","dir":"/home/me/src/other","cloned":false},
  {"id":"git:/home/me/devel/tool/.git","source":"discovered","building":null,"same_building":false,"dir":"/home/me/devel/tool","cloned":false,"checkouts":1}]}}
```

| field | |
|---|---|
| `repos` | never `null`, in display order: the worker's building's floors by their index in it, then, with the switch on, the other buildings' floors (buildings by `sort`, floors by index) and the unassigned lot's (by name), then (#54) the discovered repositories no listed floor names, by name (case-insensitively), then `id`. The worker's own floor is never listed (its repository can be, discovered) |
| `id` | #54: the row's identity, stable across asks, opaque (it is the repository's merge key: `gh:<owner/repo>` lowercased, `git:<common dir>`, `checkout:<path>`, `dir:<path>`). A bridge from before #54 sends none: the game keys such a row `floor:<session>` |
| `source` | #54: `floor` (a floor names it: `session` is the floor) or `discovered` (no floor names it) |
| `session` | the floor's herdr session; absent from a discovered row |
| `floor` | #58: the floor id; absent from a discovered row |
| `building` | the floor's building's **name** (not its id); `null` for the unassigned lot and a discovered row |
| `same_building` | the floor is in the worker's building (false for every row of a worker in the unassigned lot, which is in no building) |
| `repo` | the floor's stored `settings.repo` (`owner/repo`); absent when it has none |
| `dir` | the folder a pick puts in: the floor's stored `settings.default_cwd`, or (#54), when no floor of the row has a usable checkout of its `repo` and one was discovered, that checkout (below); absent when there is none |
| `cloned` | `repo` is set, `dir` exists (the bridge's `StatDir`) and its GitHub origin (`git -C <dir> remote get-url origin`, the lookup of the floor suggestions) is `repo`, ignoring case and a `.git` suffix. A subfolder of the checkout counts (git finds the origin from it). A discovered checkout of `repo` is cloned |
| `checkouts` | #54: how many checkouts of the repository were discovered (clones and worktrees); absent when none |

**One row per repository** (#54). Rows merge by identity: a floor with a `repo` is that GitHub repository (`gh:`,
case and a `.git` suffix ignored, as for an origin); a floor with only a folder is the discovered repository of the checkout the folder is in (the nearest folder up from it
with a `.git` marker, symlinks resolved: a subfolder or an alias of a checkout matches it), else that checkout's GitHub
origin, else the checkout, else the folder itself. A discovered repository is its checkouts that share a Git common
directory (worktrees) or a GitHub origin (clones, whatever the remote's spelling). The merged row stands at the first
floor's place and offers, in order: the first of its floors (in floor order) with a usable folder (a checkout of its
`repo`, or an existing folder of a folder-only floor), else the discovered checkout (the main checkout first, then by
path), else the GitHub address (`cloned` false). Its `session` is the floor whose folder it offers, else the first.
Repositories that cannot be told apart safely stay apart: two folders named `api` with different common directories
and no GitHub origin, or two clones of one non-GitHub remote, are two rows.

Only **stored** settings count: a floor's `suggested` values (what the bridge guessed from its workers' checkouts) are
ignored, and a floor with neither a stored `repo` nor a stored `default_cwd` is not listed. A floor with only a folder
is listed only when the folder exists. Asleep floors are listed (their settings persist), and so is a Kaneo-tracked
floor that still carries a GitHub `repo`.

The stat, the checkout lookups (an `Lstat` walk up from each folder) and the origin lookups run off the hub, all at once, each origin lookup at most 3 s (a slower one is "not
cloned" for this answer) and reused for 30 s; a lookup that fails is "not cloned", never an error of the list.

**The switch** "Repositories from other buildings" (bridge-wide, SQLite `repo_refs_settings`, off by default and when
never set): `repo_refs.get` answers it, the snapshot's `repo_refs` holds it (always present), `repo_refs.update`
carries it flat. `repo_refs.set {all_buildings}` needs `all_buildings` (`bad_request`); every change goes to every
client (before the ack) and is one audit row.

```json
{"t":"repo_refs.set","req_id":"r1","args":{"all_buildings":true}}
{"t":"repo_refs.update","seq":2211,"all_buildings":true}
{"t":"ack","req_id":"r1","data":{"all_buildings":true}}
```

Errors: `unknown_worker`, `bad_request` (unknown `args` fields). Each call is one audit row.

#### Repository discovery

#54. The bridge scans folders **on its host** (scan roots) for Git working checkouts and merges what it finds into
`worker.repos` and `hire.repos` (above). The roots and the refresh interval are bridge-wide settings (SQLite
`repo_discovery_settings`, one row: none set is no roots and 10 minutes); no roots is discovery off (the floors are
listed as before). `repo_discovery.get` answers the state, the snapshot's `repo_discovery` holds it (absent on a bridge
without discovery), and `repo_discovery.update` carries it flat whenever the settings or a scan's status change.

```json
{"t":"repo_discovery.set","req_id":"r1","args":{"roots":["/home/me/devel","/mnt/usb/src"],"interval_minutes":10}}
{"t":"repo_discovery.update","seq":2212,"roots":["/home/me/devel","/mnt/usb/src"],"interval_minutes":10,"status":{"state":"scanning","revision":7,"repositories":61,"checkouts":134,"last_scan_at":1760520000000,"last_success_at":1760520000000,"last_duration_ms":152,"progress":{"phase":"walking","done":0,"total":2},"roots":[{"path":"/home/me/devel","state":"ok","checkouts":134,"last_success_at":1760520000000},{"path":"/mnt/usb/src","state":"pending","checkouts":0,"last_success_at":null}]}}
{"t":"ack","req_id":"r1","data":{"roots":["/home/me/devel","/mnt/usb/src"],"interval_minutes":10,"status":{"state":"scanning","…":"…"}}}
```

| field | |
|---|---|
| `roots` | the scan roots as set: absolute paths, cleaned (`filepath.Clean`: a trailing slash goes), in the order set; never `null` |
| `interval_minutes` | how often they are scanned again, 1–1440 |
| `status.state` | `off` (no roots), `idle`, `scanning` |
| `status.revision` | moves whenever the discovered repositories change (a new or removed checkout, origin or root), never for progress or timestamps: a client listing them (an open `@r:` popup) asks `worker.repos` again then |
| `status.repositories`, `status.checkouts` | what is discovered now (one repository can have several checkouts) |
| `status.last_scan_at`, `status.last_success_at` | unix ms of the end of the last scan, and of the last one in which no root failed; `null` before |
| `status.last_duration_ms` | how long the last scan took |
| `status.next_scan_at` | unix ms of the next scheduled scan (absent: off or scanning) |
| `status.progress` | the scan in flight: `{"phase": "walking", "done", "total"}` over the roots, then `{"phase": "checking", …}` over the checkouts found; at most every 250 ms |
| `status.roots[]` | per root, in `roots` order: `path`, `canonical` (the folder it resolves to, when another), `state` (`pending` not scanned yet, `ok`, `stale` its last scan failed and its previous result is kept, `error` failed and never succeeded), `error` (why, in words), `warning` (folders below it that could not be read), `checkouts` (its checkouts in the catalog), `last_success_at` |

**Settings.** `repo_discovery.set {roots?, interval_minutes?}` needs at least one (`bad_request`); a root must be
absolute, without a line break, at most 4096 bytes and listed once after cleaning; at most 32 roots. The refusal is
`bad_request` with the field in words (`Scan folder 2 is the same as folder 1 (/home/me/devel).`). Whether a root
exists is not checked: a missing one (an unmounted disk) is a scan error. A change of roots drops the removed roots'
repositories at once, cancels the scan in flight (its result is thrown away, so a removed root never comes back) and
scans again; an interval change only moves the next scan. `repo_discovery.refresh` asks for a scan now (one in flight
first finishes). Each call is one audit row; a bridge without discovery answers all three `unsupported`.

**Scans.** After the bridge starts (from the stored settings), after a change of roots, on `repo_discovery.refresh`,
and `interval_minutes` after the last one ended. One at a time, off the hub (commands never wait for one), bounded to
a minute (past it, the roots not finished fail). Each root is resolved (`EvalSymlinks`: aliases of one folder are
walked once) and walked: a folder with a `.git` marker (a folder, a file, a link: linked worktrees and submodules
have a file) is a candidate checkout and the walk **stops there**, never listing a checkout's contents; any other
folder is walked into, at any depth, whatever its name (no dependency-folder exclusions); symlinked subfolders are not
followed. A repository inside a checkout (a submodule, a vendored repo) is found only from a root of its own, which is
always walked even when another root's checkout encloses it. Bare repositories (no `.git`) are not listed. Then git,
for the candidates only, at most 8 calls at once, 2 s each, local (no network), in a clean environment (no inherited
`GIT_DIR` and the like): `rev-parse --path-format=absolute --show-toplevel --git-dir --git-common-dir` (a candidate
whose top level is not itself is dropped; it is a main checkout when its Git directory is the common one, wherever
that is, so a `--separate-git-dir` checkout is one, and a linked worktree otherwise) and `remote get-url origin` (optional: a repository without an origin, or with a
non-GitHub one, is listed all the same). A candidate git could not answer for (a timeout) keeps its previous entry;
a root where git answered for none, or that cannot be read, fails: its previous result stays, marked `stale`, and the
other roots are not touched. A folder below a root that cannot be read is skipped (`warning`).

#### Completion before a hire

#39. The Hire worker dialog's First task and Start run's Extra instructions and First prompt complete `/` skills, `@`
files and `@r:` repositories before there is a worker: **`hire.commands`**, **`hire.files`** and **`hire.repos`** are
`worker.commands`, `worker.files` and `worker.repos` keyed by what the hire would get instead of a worker id. They
answer the same data (`{"commands", "partial"}`, `{"files", "source", "reason"}`, `{"repos"}`), from the same command
catalog, file index and repository scope, read-only. (The Prompt overlay has a worker: it asks the `worker.*` ops, and
shares the transcript's list of commands.)

```json
{"t":"hire.commands","req_id":"59","args":{"session":"lab","harness":"codex","cwd":"/home/me/src/lab","worktree":true}}
{"t":"ack","req_id":"59","data":{"commands":[{"name":"write-code","description":"…","argument_hint":"","kind":"skill","terminal":""}],"partial":false}}
{"t":"hire.files","req_id":"60","args":{"session":"lab","query":"read","limit":30}}
{"t":"hire.repos","req_id":"61","args":{"session":"lab"}}
```

| arg | rule, else `bad_request` |
|---|---|
| `session` | a floor the bridge knows (`unknown_session`); for `hire.commands` and `hire.files` a running one (`invalid_state`), as `worker.commands` and `worker.files`. `hire.repos` lists stored settings only and answers for an asleep floor too, as `worker.repos`. None waits for the floor's wake, sleep or another hire (never `busy`): a lookup changes nothing |
| `harness` | `hire.commands` only: `claude` or `codex` of `hire_options` |
| `cwd` | as `worker.hire`'s: absolute, an existing folder; absent: the floor's effective default cwd |
| `worktree` | true: the hire makes a worktree, which does not exist yet, so the lookups are made in the folder's **repository root** (`git rev-parse --show-toplevel`, as the hire does; not a git work tree: `bad_request`). Its files are the main checkout's: what is not committed there is not in the new worktree, and an `@path` to such a file reaches Codex as typed |
| `query`, `limit` | `hire.files` only, as `worker.files` |

A **lookup context** is the floor, the harness and the folder (with `worktree`, the repository root). The catalog and
the index are cached per harness and folder, so the context a dialog completed in is the one the first prompt is
translated with (below). The game asks nothing when a dialog opens: a lookup goes out only when a `/` or `@` popup
opens, and holds only the popup ("Loading skills…", then the rows, or why it failed and "Try again"); the dialog, its
typing and its Hire / Start run never wait for it. A change of the floor, harness, folder or worktree choice is a new
context: the popup asks again, and a reply or a row of the old context is never shown or put in. The Hire dialog's
`cwd` and `worktree` are the ones its `worker.hire` would carry at that moment: a Folder typed in is the context at once,
before (or without) its `hire.prepare` check, and a Folder cleared sends no `cwd` (the floor's default), so the folder
completed in is always the folder hired.

`/` lists the harness's catalog (its skills, global ones too, and its commands); `@` the files of the context's folder
only: a skill's own file outside it is not offered as a file. The popup's footers say which is which.

**The first prompt.** What was typed (`worker.hire`'s `prompt`; `run.start`'s `extra` or edited `prompt`) is rewritten
for a Codex hire once, by the [`worker.prompt` rules](#input), when the hire sends it: the skills from the catalog the
bridge **already holds** for the lookup context (however old; the hire never waits for a probe: with none cached,
`/skill` goes as typed), the files of the new worker's checkout (a worktree's own). Claude gets the text as typed. A
repository picked with `@r:` is a plain path or URL in the text, and stays so.

Errors: `unknown_session`, `invalid_state` (asleep), `bad_request` (unknown `args` fields, a bad harness, cwd, `limit`
or `query`, a worktree outside a git work tree), `files_failed` (`hire.files`, as `worker.files`), `internal` (not
configured, or the catalog failed). Each call is one audit row.

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
| `cache` | #224: the main thread's prompt-cache **evidence** (below), absent before a relevant request was read (and from older bridges). Never a state: a reader estimates it when it shows it. |
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

**Prompt-cache evidence** (#224, `usage.cache`): what the transcript showed of the main thread's prompt cache, so
the filing dialog can say whether asking the agent likely reuses it. An estimate, never a measurement: no request is
ever made to learn it.

```json
"cache":{"estimated":true,"provider":"anthropic","model":"claude-opus-5-5","policy":"observed_1h","ttl_min_ms":3600000,"ttl_max_ms":3600000,
         "request_from":1790859600000,"request_to":1790859603400,"expires_from":1790863200000,"expires_to":1790863203400,"cache_read":41000,"context_tokens":48200}
```

| field | |
|---|---|
| `provider`, `model`, `auth` | the route: `anthropic` / Codex's `model_provider`; the model of the last relevant request; Codex's `auth.json` `auth_mode` (`chatgpt`, `apikey`; only that key is read), absent when unknown |
| `policy` | where the retention comes from: `observed_1h`, `observed_5m`, `observed_mixed` (the latest request that wrote the cache wrote those entries), `documented` (the provider's documented default for the route and model), `assumed` (a route whose lifetime is not documented), `unknown` (nothing since a compaction or a model change) |
| `ttl_min_ms`, `ttl_max_ms` | the retention range (equal when one; `ttl_max_ms` absent: no documented upper bound) |
| `request_from`, `request_to` | the last relevant request's **start**, as an interval (unix ms; `request_from` absent: unknown) |
| `expires_from`, `expires_to` | `request_from + ttl_min`, `request_to + ttl_max` (absent when a part is unknown) |
| `cache_read` | the cache-read tokens of that request: what the previous call reused, not what the next one will |
| `context_tokens` | the context the dialog's "about N tokens" uses (`usage.context_tokens`, never the transcript file's size) |
| `reason` | why it is unknown or assumed (`compacted`, `model changed`, a start that is unknown, an undocumented route or provider) |

The state is computed by its reader at a time (`usage.CacheState`; the game's `cacheState`): **`warm`** only before
`expires_from`, **`expired`** only after `expires_to`, else **`unknown`**. `worker.handoff_preview` (mode `agent`)
sends it computed by the bridge, as `cache: {state, estimated: true, evidence}`.

- **Claude**, main thread only (subagents' files and sidechain lines never count): `cache_creation.ephemeral_1h_input_tokens`
  and `ephemeral_5m_input_tokens` are read directly (not the cost's inference). A request is a `requestId`; it started
  between the latest main prompt or tool result before its first line and that first line (its later lines, a long
  response, never move it; there is no fixed deduction). The last relevant request read or wrote the cache; the policy
  is the latest writing request's (1h only, 5m only, both), a read-only request refreshes the time and keeps it, and
  with no writes seen it is `documented` (5 min with an API key or cloud provider, 1 h with a subscription: 5–60 min).
  A `compact_boundary` makes it `unknown` until the next request; so does a main request on another model than the last
  relevant one's (`model changed`: another model, another prefix), until a relevant request on the new model. The
  statusline's `prompt_cache` (Claude Code 2.1.251+) reaches only a statusline command's input: the bridge cannot read
  it and does not try.
- **Codex**: the model from `turn_context`, the request interval from the turn's `task_started.started_at` and
  `task_complete.completed_at` (unix seconds), `cached_input_tokens` from `token_count`; a `compacted` record or
  `context_compacted` resets, and so does a `turn_context` naming another model than the last relevant request's
  (`model changed`), as does a `session_meta` naming another provider (`provider changed`), until the next cache read. OpenAI's policies apply only when `session_meta.model_provider` is
  `openai`; another provider (a local or third-party server) or none named is `unknown`, with no TTL. On the API
  (`auth_mode` not `chatgpt`): GPT-5.6 and later at least 30 min after the last write or reuse, no upper bound
  (`documented`, so never `expired`); earlier models 5–60 min. Signed in with ChatGPT: not documented, `assumed` with
  no TTL (always `unknown`). No `auth.json`: the model's range, `assumed`.

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
| `answers` | #183, Codex `user` items only: the message is the reply to Codex's async questions ([Codex async questions](#codex-async-questions)). One `{"question", "answer"}` per answer, in the envelope's order, both plain text (not markdown); never a question id or a call id. Set only when the message's text parts, joined, are one complete validated reply envelope (`codexreply.ParseReply`, the rule the bridge's question reconciler uses: the whole text but its surrounding whitespace, at least one entry, and in every entry a `questionItemId` string that is the async tool's id with a non-null integer index ≥ 0, plus `question` and `answer` keys that are JSON strings (an empty string is valid; a missing key, `null` or another type is not); all or nothing, so one bad entry makes the whole message an ordinary `user` item; keys beyond those three are ignored, as the TUI does; a message with an image is not one). A prompt that quotes an envelope, a cut or malformed one and another tool's are ordinary `user` items. `parts` still holds the envelope's text as sent (one text part, no image parts), so a client that does not read `answers` shows today's bubble; the game shows the readable entry and keeps the raw reply behind a collapsed "Raw reply". The same independent of who answered (the terminal or herdr-world) and of `worker.codex.questions`: the entry is read from the text alone. Capped like a part's text in lists (each question and answer at 64 KiB, `truncated` set), whole in `transcript.item` |
| `truncated` | a part's or the notice's text was cut for the list (`transcript.item` has it all) |
| `tool` | `tool` / `subagent`: `name` (Codex: `namespace.name` when namespaced, but a collaboration call, #56, is its bare name: `spawn_agent`), `input_summary` (the input's first line, at most 200 characters: the command, file path, pattern, URL…; Codex `exec` scripts: their first `cmd`; `apply_patch`: the files), `input` (the raw input as JSON; in lists only when at most 4 KiB), `status` (`running` until the result comes, then `ok`, `error`, `interrupted` or, #171, `denied`: the user rejected the call, which an older bridge sent as `error`), `output_text` (the result's text, at most 64 KiB in lists: then `output_truncated: true`), `images` (`[{"image": ImageRef}, …]`, the images in the result: what the agent viewed; the game shows them under the collapsed row, #70), `diff` (`{path, hunks, truncated?, op?, to?, no_diff?}`: Claude `Edit`/`Write`'s `structuredPatch`, a created file as all added lines; #171: a Claude `Bash` call's `bashEditDiff` files; #21: what Codex recorded a patch did, with the record's line numbers, and a Codex patch's own text, whose hunks have no line numbers: 0), `diffs` (every file, when a call changes more than one; `diff` is the first), `changes` (#171, below). Diff lines are capped at 64 KiB in lists (`truncated`: `transcript.item` has them all). |
| `diff.op` | #171: what happened to the file, when the source says: `edit` (Claude `Edit`, a `Bash` file that is neither created nor deleted), `create` (`Write` with `type: "create"`, a `Bash` file with `created`), `overwrite` (`Write` with `type: "update"`), `delete` (a `Bash` file with `deleted`); #21: a Codex patch's `add` / `*** Add File` is `create`, `delete` / `*** Delete File` `delete`, `update` / `*** Update File` `edit`, and one with a `move_path` / `*** Move to` `rename` (`to`: the new path; `path` is the old one). Absent: not known (older bridges). Never derived from `originalFile` (null on most edits and on some overwrites). |
| `diff.no_diff` | #171: the source recorded the change but no lines for it (`hunks` is `[]`): a `Write` over a file with an empty `structuredPatch` (Claude Code keeps none when nothing changed, the old file was over about 10 MB, or the diff timed out), a `Bash` file that is neither created nor deleted with no hunks; #21: a file a Codex patch's text deletes (the text names it, not its lines). Not a cut of ours (that is `truncated`); never shown as a new file nor as removed lines. |
| `changes` | #171, a Claude `Bash` call's `bashEditDiff` beyond its diffs, best effort (Claude Code 2.1.269+): `paths` (changed files with no diff: `changedFiles` less the diffed ones; the source lists at most 200), `more_files` (how many changed files have no diff, `moreFiles`: more than `paths` when the list was cut), `unavailable` (the record is incomplete or could not be taken; the diffs it has are real), `skipped` (a git command that moves the working tree, like `git checkout` or `git stash`: no diff taken), `shared` (another Bash call ran in the same repository at the same time: some listed changes may be its); #21: `computed` (how many patches a Codex `exec` script that is still running builds itself: their changes show once Codex records them, nothing is made up before). Each only when set; `changes` only when one is. A Bash result without `bashEditDiff` (an older Claude Code, recording off, a failed command: its result is a string) has neither `diff` nor `changes`: unknown, not "no changes". The bridge never runs `git diff` for a call, and never reads or writes Claude Code's `bashEditDiffEnabled`. |
| `collab` | #56, Codex only: a collaboration call (a `tool` item: `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `close_agent`) or a message from another agent (a `notice` item, `source: "agent_message"`), read for the view: `kind` (`spawn`, `send`, `followup`, `wait`, `close`, `inbound`), `task_name` (a spawn's), `target` (the agent a send, followup or close names), `agent_path` (`/root/<name>`, from the call's output `{"task_name": "/root/<name>"}` or its `SubAgentActivity` event; inbound: the sender), `agent_type` (a spawn's role), `model`, `effort` (the arguments' `model` / `reasoning_effort`, else the `SubAgentActivity` event's), `fork_turns` (`none`, `all` or a number of turns, as written), `thread_id` (the child's thread: the event's `agent_thread_id`, a v1 output's `agent_id`), `nickname` (a v1 output's; never read from the child's rollout), `recipient` and `message_type` (inbound: its header's `NEW_TASK`, `MESSAGE`, `FINAL_ANSWER`, …), `encrypted` (the message is ciphertext: multi-agent v2 has the Responses API encrypt it, openai/codex#26210, and nothing local can read it; a `gAAAAA` message argument or an `encrypted_content` part), `prompt` (the message in plain text: a v1 spawn, a plain payload such as a final answer; capped like a part's text in lists, `truncated` set). Each only when the source says it. The call's `tool` stays whole (`input` with the ciphertext, `output_text`), so a client that does not read `collab` shows a tool row; `input_summary` is the task or target, never the message. The game shows "Spawn subagent `<name>` on `<model>` `<effort>`", "Message to", "Wait for subagents", "Close", "Reply from" (a parent's message down: "Task from" / "Message from"), the facts, the message or a note that it is encrypted, and the call behind a collapsed "Raw request", unclipped (arguments the list left out, or an output it cut, load with `transcript.item` when it opens; a cut message has the same link). |
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
  `interrupted`, `agentId`, #171: `bashEditDiff`) or `*_tool_result` block that answers it updates that item.
  `is_error` is `error`; #171: `denied` when the line has `toolDenialKind` (`"user-rejected"`) or the text starts "The
  user doesn't want to proceed with this tool use"; a result starting "[Request interrupted by user" is
  `interrupted`. A user line "[Request interrupted by user…]" is a
  notice and interrupts every call still running. `system` `compact_boundary` is a `compaction` (the items before it
  stay: the view shows the whole history, not the model's context); the summary line after it (`isCompactSummary`) a
  notice. `/command` lines are user items (`/clear`), their output (`<local-command-stdout>`, `!` shell output) a
  notice.
- **Codex.** `response_item`s: `message` (`user` / `assistant`; the `<image …>` wrapper text around a pasted image is
  dropped), `reasoning` (its summary), `function_call` / `custom_tool_call` / `local_shell_call` and their `_output`
  (paired by `call_id`; an output `{"success": false}` is `error`), `agent_message` (a notice: sender → recipient, then
  a plain payload; #56: with `collab`).
  #56, collaboration: a `function_call` in the `collaboration` namespace (or with none, older builds) named
  `spawn_agent`, `send_message`, `followup_task`, `wait_agent` or `close_agent` is a `tool` item with `collab`, named
  by its bare name. Its `event_msg` `item_completed` with a `SubAgentActivity` item (`id` the call's `call_id`, `kind`
  `started` / `interacted`, `model`, `reasoning_effort`, `agent_thread_id`, `agent_path`) or a `CollabAgentToolCall`
  (seen for `wait_agent`; its `prompt` when plain) fills what the arguments leave out; it never makes a row of its
  own, and a `SubAgentActivity` of a subagent finishing (`kind: "completed"`, an id of its own) belongs to no call.
  An `agent_message`'s first text part is a header (`Message Type: …\nTask name: …\nSender: …\nPayload:\n`); its
  payload is the text after it, the text parts after that, or an `encrypted_content` part (encrypted). A child's
  `session_meta` (`agent_nickname`, `agent_path`, `source.subagent.thread_spawn`) stays hidden: linking a child's
  rollout to its call is #25 / #26 / #27.
  #151: the MCP calls an `exec` script makes have no response item, only `event_msg` `item_started` /
  `item_completed` with an `McpToolCall` item (`id` `exec-<uuid>`, `server`, `tool`, `arguments`, `status`, `result`
  `{content, isError, structuredContent}` or `error {message}`, `duration`): a `tool` item named `server.tool` whose
  id is the item's (a completion alone is enough; a start is `running`, and one id is one row, also when a response
  item has it). `failed`, `isError` and `error` are `error`; the output is the result's text parts (else its
  `structuredContent`, else the error's message). The duration is not shown. The other item types (`Reasoning`,
  `CommandExecution`, `AgentMessage`, …) stay hidden.
  #21, code changes. What a patch did is what Codex recorded: an `event_msg` `item_completed` with a `FileChange` item
  (codex-cli 0.147+: `{id, changes: {<path>: {type: add, content} | {type: delete, content} | {type: update,
  unified_diff, move_path}}, status: completed|failed|declined, stdout, stderr}`) or, 0.145-0.146, a `patch_apply_end`
  (`call_id`, the same `changes`, `status` / `success`). Its files are `diffs`, **sorted by path** (`changes` is a map:
  the patch's order is not recorded), a created file all added lines from line 1, a deleted one all removed lines, an
  update the hunks of its `unified_diff` with their `@@ -a,b +c,d @@` numbers. `completed` is `ok`, `failed` `error`,
  `declined` `denied`; the output is `stdout` then `stderr`. Its row is the record's id: a direct `apply_patch`'s
  `call_id` (0.145-0.151; the record's diffs replace the ones read from its input), else a nested id (`exec-<uuid>`, a
  `tools.apply_patch` call inside a code-mode `exec` script, which no field links to the script): a `tool` item named
  `apply_patch` of its own, where its line is (after the script, before the script's output). A direct `apply_patch`
  whose output starts "apply_patch verification failed" is `error` with no diffs; an `exec` output starting "Script
  failed" is `error`. An `exec` script's own text gives only what it proposes: the plain string literals it passes to
  `tools.apply_patch` (`"…"`, `'…'`, or a template literal without `${…}`) are decoded by hand (JavaScript escapes,
  identity escapes such as `\+` included), never run, and are its `diffs` (no line numbers) only while it is `running`;
  any other argument (a concatenation, a variable) is `changes.computed`. Its output, or the first record inside it,
  takes them away: an `exec` row never shows a change as applied (its success does not say its patches succeeded). The
  record inside it is the newest `exec` still running when its line is indexed (the index reads the file in order;
  scripts do not overlap in Codex's rollouts). `turn_diff`, `patch_apply_begin` and `item_started` are not recorded.
  `compacted` is a `compaction` (its `replacement_history` is never read). `event_msg` `turn_aborted` is a notice and
  interrupts every call still running; `task_complete` a notice ("Turn took 13.8s"); `error` a notice.

**Hidden** (sent with `hidden: true`, as `notice`s whose `source` is the type):

| Claude Code | Codex |
|---|---|
| every `attachment` line (reminders, hook context, tool lists, dates…), **except** a prompt the user queued while the agent worked (`queued_command` from a human): that is a `user` item | `message` of role `developer` (or `system`) |
| `isMeta` user lines (skill bodies, caveats) and user text that is only `<system-reminder>` wrappers (wrappers are cut from other text) | the injected user context: `# AGENTS.md instructions…`, `<environment_context>`, `<user_instructions>` |
| metadata lines: `last-prompt`, `mode`, `permission-mode`, `bridge-session`, `atis-latch`, `ai-title`, `custom-title`, `agent-name`, `cost-state`, `pr-link`, `file-history-*`, `queue-operation`, `frame-link`, `artifact-*`, `summary`, `progress`, `tag` | `session_meta`, `turn_context`, `world_state`, `token_usage_record`, `inter_agent_communication_metadata` |
| `system` `stop_hook_summary`, and a `local_command` with no output | `event_msg`s that repeat response items or keep books: `token_count`, `item_completed` (but an `McpToolCall`'s and, #21, a `FileChange`'s: `tool` items; #56: a `SubAgentActivity` or `CollabAgentToolCall` is hidden too, and adds to its call's `collab`), `thread_settings_applied`, `task_started`, `user_message`, `agent_message`, `agent_reasoning*`, `exec_command_*`, `patch_apply_begin` (#21: `patch_apply_end` is a patch's record), … |

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
"followup":{"turn_id":"9b2e4d6a803f9c1a","score":0.89,"source":"parsed","at":1792064661000,
  "questions":[{"id":"q2","label":"Q9","question":"Asleep floor at fire time","kind":"choice",
                "options":["(a) Auto-wake the floor, then hire.","(b) Mark the schedule `failed: floor_asleep` and notify.","(c) Per-schedule checkbox \"wake floor if asleep\", default on."],
                "context":"A hire on an asleep floor returns `invalid_state`. …",
                "recommendation":{"text":"(c), default on. The whole point is not having to remember. …","option":2}}, …]}
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
- **`followups.test`** runs three sample messages with the models in use: one ending in open questions and one "Done,
  PR merged." through the whole pipeline, and (#60) `grill`, a real ten-question grill round (Q8–Q17, each with a
  recommendation), through the classifier and then the LLM itself (never the round reader below, so the model in use
  is what is tried). It passes when the first and the grill round score at or over the threshold, the LLM lists the
  first's questions and all ten of the round's, each with its recommendation, and "Done" scores under it. A test that
  ran but did not pass is `ok: false` with `reason` (and the scores); a call that failed is its error (`auth_failed`,
  `timeout`…; `incomplete` without both models `ready`).
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
4. **Extract**. #60: a **grill round** is read as it is, with no LLM call (`source: "parsed"`): blocks
   `❓ **Q9** - **Title**: body` (or `❓ **Q9 - Title.** body`; a hyphen, en or em dash, colon or period between),
   each its own question: `label` `Q9`, the title as `question`, the rest of the body as `context` (Markdown), options
   from lettered bullets `- (a) …` (else letters inline, `(a) … (b) …`, else plain bullets none of which is itself a
   question: a bullet with a `?` is a sub-question and stays in `context`, the question `open`), and the `➡️` line with
   the lines right under it (to a blank line) as `recommendation.text`; one that starts with an option's letter
   (`(c), default on.`) names it (`option`, its index). Up to 30 questions, the rest counted in `unlisted`. A ❓ line in
   any other shape (outside a code fence) makes the message no round: the LLM reads it. Anything else goes to the
   **LLM** (JSON mode, `source: "model"`): `{"questions":[{"label","question","kind","options","context",
   "recommendation","recommended_option","why"}],"more"}`, validated: up to 16 questions (more, and the `more` it
   reports, are counted in `unlisted`), each 1–300 characters (whitespace folded), `kind` `yes_no`, `choice` (2–8
   options of 1–300 characters) or `open`; options of the other kinds are dropped. One invalid question does not cost
   the round: an empty, over-long or unknown-kind question is left out and counted in `unlisted`; a choice with bad
   options becomes `open`, its options listed in `context`. `context` is cut at 1,200 characters, `why` at 600.
   By either reader, `recommendation.text` is kept whole up to 8,000 bytes, an answer's bound, so accepting it sends
   all of it; a longer one is its first 8,000 bytes (ending `…`) with `cut: true`: shown, never filled in as an answer
   nor called the agent's recommendation (an `option` it names still is: the option goes whole). The call: an 8,192-token completion budget, reasoning effort `low` when the model's
   catalog lists it (never sent when the catalog does not describe the model), no partial answer, its own 45 s
   timeout and no retry of a call that may have reached the provider; cut off at the budget or empty, it is asked once
   more with effort `none` (or `minimal`, the first the model takes). An answer with no valid question, or an LLM
   failure, is the **fallback**: one `open` item ("The agent asked you something") with the message's last 1,200
   characters as `tail` and why as `error`. A positive gate is never dropped.
5. **Once**: each message looked at is recorded by worker and SHA-256 (`followup_seen`, with its follow-up while it is
   open, the last 20 per worker). A restart or a re-read never classifies it again; an open follow-up comes back as it
   was, a cleared one never. A classifier failure is not recorded (logged; a later restart may try again). A fallback is
   never extracted again by itself: only on request (`worker.retry_followup`, below).

The calls run off the hub goroutine, under the AI integration's bounds (two calls in flight over the whole bridge).
`turn_id` is 16 hex digits of the turn's identity (#223): its place among the transcript's turns, the message's ids
(Claude's `message.id`; Codex's `turn_id` and message id) and the text's SHA-256, so two turns with the same reply are
two turns (`followup_seen` still keys on the text's hash: the same text is never classified twice).

**Clearing.** `followup` goes (the worker's upsert, the record cleared) when it is answered, dismissed, on any
`worker.prompt`, `worker.keys` or answer to it, when herdr says `working` again, when the transcript goes on to a new
prompt or turn (however short: herdr may never report it `working`), and when the worker is gone. A result that comes
back after one of these (or after a new prompt was read, or after herdr said `working` while it was being looked at,
even when the worker is idle again by then) is recorded but not shown. The feature's state is checked again before the
extraction: switched off or a model `invalid` while the classifier ran, the message never goes to the LLM.

**Answering.** **`worker.answer_followup {id, turn_id, answers: [{id, value, note?}], note?}`** is `stale` unless the
worker's follow-up is of `turn_id` (answered, dismissed or a newer turn meanwhile), `bad_request` for an unknown or
repeated question id, an empty answer, no answer and no `note`, a `yes_no` value other than `Yes` / `No` (any case), or
a value or note over 8,000 bytes, or (#60) a value or note that is a question's `cut` recommendation sent back: its
text with or without the `…`, however its spaces and line breaks fold (`<label or "question n">'s recommendation was
too long to send whole: read the whole message and write your answer`; nothing is sent and the follow-up stays open,
whatever the client offered; the option a `cut` recommendation names is sent whole as before). It sends **exactly one prompt** through `worker.prompt`'s lane and rules (typed for
Claude, #95; queued for an agent at work; `invalid_state` with an `ask`), checked again when its turn on the lane
comes, and clears the follow-up once it went:

```
Answers to your open questions:
1. Does the legacy importer still need the v1 format? → No
2. Ship this already, or wait for the e2e-live run? → Wait for e2e-live <optional note>
Unanswered: 3
```

Only the answered questions are listed, numbered as asked; a note follows its value after a space. #60: a question with
a `label` (a grill round's) is named by it and its question instead, so the agent pairs each answer with its own
question; an answer that is the question's recommendation as it was (its option, or an open question's whole text, no
note; never a `cut` one's text) says so; the questions left unanswered follow on one line; the request's `note` ends the prompt after a blank
line:

```
Answers to your open questions:
- Q9 Asleep floor at fire time → (c) Per-schedule checkbox "wake floor if asleep", default on. (your recommendation)
- Q17 Defining "missed" → 10 min grace.
Unanswered: Q8, Q10, Q11, Q12, Q13, Q14, Q15, Q16

<note>
```

A fallback's one free answer is sent as it is (its `note` after it). **`worker.dismiss_followup {id, turn_id}`** clears
it (`stale` likewise). The audit log keeps the ids and each answer's lengths, never the text.

**The message and a retry** (#60). **`worker.followup_message {id, turn_id}`** answers the message the open follow-up
is of (`text`, its last 96,000 characters; `cut` when it is longer), kept in memory with it (also after a restart:
the transcript has it), never in the worker's upsert; `stale` likewise. **`worker.retry_followup {id, turn_id}`** runs
the extraction of a fallback again (the round reader, then the LLM; never the classifier) and replaces the follow-up of
the same turn with what it made of it (in `followup_seen` too: a restart brings back the recovered questions): the
questions, or the fallback again with the new `error`; `retries` counts them. The ack is `{source, error?}` once it
ran. `stale` likewise (also when it was answered, dismissed or moot meanwhile), `bad_request` when its questions were
read (no fallback), `busy` while a retry of it runs, `invalid_state` after 3 retries or while the feature is not
`ready`.

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


### Hire interpretation

#211 (phase 2 of #209: dictated hiring). **`hire.interpret {text, pending?}`** reads one dictated sentence ("Hire a
Claude Code agent on Haiku 5.5 with high effort. Task: fix the login bug.") with the [AI integration](#ai-integration)'s
LLM and answers a **hire proposal for review**, or that the sentence is not a hire. It never hires: it sends no
`worker.hire`, calls no herdr and keeps nothing on the bridge. A complete, valid proposal is only `ready_for_review`;
the game's review dialog and your explicit confirmation are what hire (phases 3 and 4). (#212, phase 3: the game's review dialog opens with this proposal, asks for a missing or invalid value and sends one `worker.hire` only on Hire; a follow-up reply goes back here with the proposal as `pending`. #213, phase 4: the game's dictation bar sends it,
Ctrl/⌘+Shift+Space or the Menu's "Dictate a command…": a hire opens that review (or, with one open, is applied to it as
a follow-up, sent with its proposal as `pending`); `unsupported` and `unclear` are a line in the bar, as is an `error`,
with the text kept. The client waits 40 s for the ack.)

```json
{"t":"hire.interpret","req_id":"i1","args":{"text":"Hire a Claude Code agent on Haiku 5.5 to fix the login bug."}}
{"t":"ack","req_id":"i1","data":{"text":"Hire a Claude Code agent on Haiku 5.5 to fix the login bug.","intent":"hire","hire":{"sources":["Hire a Claude Code agent on Haiku 5.5 to fix the login bug."],"harness":{"provenance":"dictated","value":"claude"},"model":{"provenance":"resolved","value":"claude-haiku-5-5"},"effort":{"provenance":"missing"},"task":{"provenance":"dictated","value":"fix the login bug.","span":{"source":0,"start":41,"end":59}},"questions":[{"field":"effort","text":"What effort level should this agent use?","efforts":["low","medium","high","xhigh","max"]}],"ready_for_review":false}}}
{"t":"hire.interpret","req_id":"i2","args":{"text":"High effort, please.","pending":<the hire of i1>}}
{"t":"ack","req_id":"i2","data":{"text":"High effort, please.","intent":"hire","hire":{"sources":["Hire a Claude Code agent on Haiku 5.5 to fix the login bug.","High effort, please."],"harness":{…},"model":{…},"effort":{"provenance":"dictated","value":"high"},"task":{…},"questions":[],"ready_for_review":true}}}
```

**One call, then rules.** The LLM gets the research's prompt (`internal/hireintent/prompt.txt`, from
`docs/research/dictation-hiring-bench`) and `{"command": text, "pending_hire"?: [the pending proposal's sources],
"hire_options": <the bridge's current catalog>}`, in JSON mode with a 1,400-token budget, no partial answer and the
provider's default reasoning; the AI integration's timeout, retry and concurrency limit apply, and the bridge bounds
the whole at 35 s. Its answer must be exactly `{intent, harness, model, effort, task, multiple, selection_unclear}`
(`intent` `hire` | `unsupported` | `unclear`, `harness` `claude` | `codex` | null, booleans for the last two, short
strings or null for the others); anything else is the error `bad_answer`. Then, deterministically:

- **`intent`** `unsupported` (a clear request for another game action, one to an existing worker) and `unclear`
  (no clear request: a bare task, a mention, a quote, a negation, a hypothetical, history, a question about hiring,
  nothing said) carry nothing else. More than one action or new worker is `unsupported` with `reason: "multiple"`:
  never a part of it. Only hiring is understood.
- **Fields.** `harness`, `model` and `effort` each have a `provenance`: `dictated` (said, and its `value` is the word
  said), `resolved` (`value` taken from the catalog for what was said: a readable label such as "Haiku 5.5", "extra
  high", the harness of an unambiguous model), `missing` (not said), `invalid` (said but not valid: unknown, of the
  other harness, contradictory such as "Claude on GPT-5.5 Haiku", an effort the model does not support, or a harness
  with no models in the current catalog; `said` keeps the words, there is no `value`). `value` is always an exact
  launch id of the **current** catalog; nothing is ever defaulted (not from the floor's settings, the last hire or
  `hire.prepare`'s choice) or substituted. A model is never chosen from a harness. An effort counts only when its word
  is said outside the task ("Task: make the high effort setting visible" has no effort); before the model is valid it
  is only checked against the catalog's levels.
- **`task`** is `dictated` with its `span` — `sources[source]` from `start` to `end` in **UTF-16 code units**
  (packup's units) — or `missing`. It is always an exact part of what was said, punctuation and later sentences
  included; commands inside it are its content. A task the LLM read that is not in the sentences is the error
  `bad_span`. Said twice, the span is in the latest sentence holding it, at its last occurrence there.
- **`questions`**, in order, never null: `model` (missing or invalid: "Which model should this agent use?" / "Which
  model did you mean by “…”?", with `choices` `[{harness, model, label?}]`: the harness's models, every model without
  one), `effort` (missing: exactly "What effort level should this agent use?"; unsupported: a correction; `efforts`
  are the selected model's levels, none before a model is valid), `task` ("What should this agent work on?"), and
  `selection` when the LLM found the selection unclear though every value validated. **`ready_for_review`** is true
  only with every field valid and no question.

**Follow-ups.** A reply ("high", "High effort, please.", "Use Sonnet 5.5 instead.") is sent with the pending proposal
as `pending`, exactly as it came; its `sources` grow by the reply (at most 6). The pending proposal is checked in full
first (its sources, its task's span against them, its fields' shape, a valid harness `claude` or `codex`; else the
error `bad_pending`, no call) and its values are resolved again against the **current** catalog: a model that left it
is `invalid` again, and so is a harness with no models left (its model question offering every model of the catalog).
The reply fills or changes only what it targets: a field the LLM leaves out keeps the pending one, and the task
changes only to a part of the reply. A model change keeps a still-supported effort; an effort it does not support is
`missing` again. A cancellation is `unclear` (drop the pending proposal), and a reply without a pending proposal
("high") is `unclear`: it never makes a proposal ready.

**Errors.** The command itself fails only on its args: unknown fields (a client catalog is refused) or a `text` over
8 KiB, not UTF-8 or with NUL: `bad_request`. Everything else is an ack. An **operational error** is `error {code,
message}` with `text` kept and no `intent` nor `hire`: `not_ready` (no LLM ready, or no AI integration: no call),
`timeout`, `provider_failed`, `truncated`, `empty_answer`, `rate_limited`, `auth_failed`, `unreachable`,
`bad_response` (the AI integration's kinds), `bad_answer`, `bad_span`, `bad_pending`. The message is fixed text, never
the provider's.

**Privacy.** Every sentence and the pending proposal's sources go to the LLM endpoint, with the hire catalog. The
bridge logs only the intent, whether it is ready, how many questions and the error code; the audit keeps the text's
length and the pending sources' count, never a sentence.

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
| `now_at` | int, optional | unix ms (bridge clock) the `now` line was written: a `recap`'s time, or when the model wrote an `llm` line (#198: its generation time, not the time of the activity it sums up; a client shows its age, e.g. "2m ago" after the line's AI sparkle, #232) |
| `task_status`, `now_status` | object, optional | #174: what became of the model's line while a fallback is shown in its place (absent while nothing is awaited or the feature is off or not ready). Never with `task_source` `llm`. With `now_source` `llm` (#198) only `retrying` or `failed`: a refresh of the line from newer steps failed, and the line shown is still the model's previous one, written at `now_at`; never `pending` there (a refresh on its way is not shown). Shape: `{"state": "pending"\|"retrying"\|"failed", "reason"?, "attempts"?, "retry_at"?}`. `pending`: a call is out, or it waits for the daily budget (`reason` `daily_cap`); `retrying`: the last attempt failed and the next goes at `retry_at` (unix ms); `failed`: it failed and nothing is scheduled by itself (the task: its attempts are used up; the now line: its steps failed and it waits for newer ones, or its attempts are used up and it waits for the turn to end). `reason` is the failure's kind: `truncated`, `empty_answer`, `bad_response`, `provider_failed`, `timeout`, `rate_limited`, `auth_failed`, `unreachable`, `bad_config`, `no_line` (the answer held no line) or `failed`; `attempts` how many calls failed. A client shows it beside the line (beside its AI mark for an `llm` line) and offers `digest.retry` |

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

**When.** The now line whenever the last 5 steps differ from the ones last sent (#198), at most once every **60 s**
per worker: the first look at a floor summarizes a turn still running, a long turn is summarized again each 60 s while
it has new steps, and steps that come in while a call is out are summarized after it. Right after a turn ends
(Claude's `turn_duration`, Codex's `task_complete`) it waits for the turn to settle **2 s**, so the final message is
in; a turn that keeps going never has to be quiet first. The same steps are never sent twice by themselves (their key
leaves out the context line, so a task line that changes alone costs nothing), whoever views, reconnects or polls.
Of the lines due, a one-off worker's task line goes first, then the now line of a worker with no model line, then the
oldest. The task as soon as the prompt is known. **Only for a worker on a floor a client stands on** (its `board.watch`, or a
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
toward `daily_cap`, its input is not cached, and a cached input still costs nothing. The now line (#198) keeps the
previous line, or the fallback, when its call fails, and its `now_status` says so (also beside a kept `llm` line); its
steps are not sent again by themselves. Newer steps are,
after the same delays (**1, 5 and 15 minutes** after the 1st, 2nd and 3rd failure in a row, and the 60 s gap; its
`now_status` is `retrying` with that time while newer steps wait), up to **4 attempts**; then `failed`, and nothing
more goes by itself until the turn ends. A turn end, a change of the feature's config, `digest.retry` (which sends the
same steps again at once), a `/clear` or another agent session start the count again. A retry, like every call, is
one at a time and for a floor someone is viewing.

**Cost.** One call at a time for the feature (the AI integration's other slot stays free for the follow-up questions
and pack up); `daily_cap` calls a day (default **300**, 1–10,000; `calls_today` counts them, the bridge's local day),
past it no call until tomorrow (or a higher cap) and the lines written stay, a cached line still applies, and a line
that waits for the budget is written once there is some again; and a cache of the lines by the SHA-256 of what is sent, in
SQLite `digest_cache (key, line, used_at)`, the newest 2,000: the same input again (a restart's re-read of a transcript
included) costs nothing, and its line keeps the time the model wrote it (`used_at`; #198: a cached `llm` now line's
`now_at` is that time, not when it was found again). Only the hash, the line and that time are stored, never a
transcript's text.

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
"codex_server":{"enabled":false,"available":true,"allow_unverified":false}
{"t":"codex_server.set","req_id":"c1","args":{"enabled":true}}
{"t":"codex_server.update","seq":2210,"enabled":true,"available":true,"allow_unverified":false}
{"t":"ack","req_id":"c1","data":{"enabled":true,"available":true,"allow_unverified":false}}
```

**The switch** (bridge-wide, SQLite `codex_server_settings`): `codex_server.get` answers it, the snapshot's
`codex_server` holds it (always present), `codex_server.update` carries it flat. `codex_server.set` patches `enabled` and/or `allow_unverified`; at least one boolean is required
(`bad_request`). Omitted fields retain their saved values; switching on a bridge whose `available` is false (no `--codex-run` directory) is
`unsupported`. The `enabled` switch applies to **new hires only**: every Codex worker keeps the mode it was launched with (SQLite
`codex_launch`), so switching never migrates, interrupts or relaunches a running worker, and a worker launched the
old way keeps today's exact resume. Claude hires are not affected.

**Compatibility preference.** Settings → Codex workers → **Allow unverified Codex versions** sets
`allow_unverified` (default false, persisted across bridge restarts and Codex upgrades). It permits unverified
release versions in the CLI preflight, the server handshake on hire/wake, and the bridge's thread connection.
Changing it refreshes those bridge connections without restarting the terminal, server or model turn. It does not
change the launch mode of existing workers. A worker that already fell back must be rehired to get its own server.
Malformed version identities, failed commands, blocked `.envrc`, thread identity checks and server failures still
fail normally. This preference accepts compatibility risk; it does not mark an untested version as verified.
Old clients' `enabled`-only updates preserve it. The game hides this preference on older bridges that omit the field.

**A shared hire** (`worker.hire` with `harness: "codex"` while the switch is on), in place of step 3's `agent start`:

1. Checks: `codex --version` is a verified release (0.160.x–0.163.x), or `allow_unverified` is on; the hire's directory (the
   worktree's checkout for a worktree hire) passes the launch's path rule (letters, digits and `._/+@,=:-`), and its
   `.envrc`, if any, is allowed (`direnv status --json`; a blocked one would leave the server without its variables
   and Codex would say nothing).
2. The bridge writes the worker's launcher, `<--codex-run>/<marker hex>.sh` (`.fish` under `--shell fish`; 0600,
   directory 0700), and types `setsid -f <shell> <launcher> </dev/null >/dev/null 2>&1` into the pane (`pane run`;
   `<shell>`: the [shell policy](#shell-policy)): the server starts from the pane's initialized shell, so it has the
   pane's direnv exports, the user's `codex` wrapper function and herdr's
   `HERDR_PANE_ID` (whose session-id hook then reports to this pane). The launcher marks every process of the server
   with a random token, records its pid, and runs `codex app-server -c 'projects={"<dir>"={trust_level="trusted"}}'
   --listen unix://<--codex-run>/<marker hex>.sock` (the directory is trusted in memory; `config.toml` is not written).
3. The socket must answer within 20 s with a supported server (the same compatibility policy applied to `initialize`'s `userAgent`); its process
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

### Handoffs

#223, part 1 of #11. A **literal handoff** files a worker's latest completed final reply, exactly as written, as a
Markdown file in its floor's **filing cabinet**. No model is called and nothing is sent to the worker: the reply is
already complete, so the worker is not woken. Later modes (#224: the agent writes one, [Ask the agent](#ask-the-agent); #9: the configured LLM writes one, [LLM handoffs](#llm-handoffs)) and
`worker.fire`'s reserved `handoff` file through the same service: one path rule, front matter, index, audit and
send-home rule.

```json
"handoff":{"id":"4a71102e7ae8ef34","session":"7a7b7c7d-…","revision":"9267469792d9bd31…","harness":"claude","message":"msg_01ABC","source":"message","bytes":5120,"images":1}
"handoffs":{"counts":{"herdr-3d":3}}
```

**The candidate** (`Worker.handoff`; absent: none now, or the bridge has no handoff directory) is the bridge's
identity of the reply, never its text. The usage tracker reads it from the same lines and `TurnEvents` as the
follow-up and wrap-up trackers (`transcript.HandoffTracker`):

- **Claude**: a message is every main-thread line of one `message.id`; its text blocks are joined in order with
  `"\n"`. It is a candidate once it is closed (the next line is not one of its own) and its last line's `stop_reason`
  is `end_turn` or `stop_sequence`, or it is null and `system/turn_duration` confirms the turn ended (headless `claude
  -p` has no `turn_duration`: `end_turn` is the marker there). Never `tool_use`, `refusal`, `max_tokens`, a
  thinking-only message, a sidechain or subagent line, a compaction summary or meta line. A new prompt, a tool result,
  another assistant message or an interruption ends it.
- **Codex**: text from `response_item` assistant messages only (the `event_msg` `agent_message` and `item_completed`
  copies are never read, so a reply has one button). A turn runs from `task_started` to `task_complete`; its candidate
  is its last `phase: final_answer` message, in a legacy rollout without phases its last assistant message, else
  `task_complete.last_agent_message` (`source: "last_agent_message"`, no transcript row). Never a `commentary`, an
  aborted (`turn_aborted`) or unfinished turn, a subagent's rollout (`session_meta.source` names one) or a child turn
  (`root_turn_id` is not its `turn_id`).
- `id` is 16 hex digits of the identity: harness, agent session, Claude's `message.id`, `requestId` and final line's
  `uuid` or Codex's `turn_id` and message id, the source, the byte spans of its lines and the text's SHA-256
  (`revision`). Two turns with the same reply have different ids. `message` names its transcript row: Claude's row id
  is `<message>#<n>` (the last assistant row of that message), Codex's is the message id. `bytes` is the text's size,
  `images` the image blocks it leaves out, `too_large` a text over 1 MiB.

**`worker.handoff_preview {worker, candidate}`** reads the candidate's text back from its lines in the transcript
(the file the tail read, checked to be the same file, its lines re-parsed and joined, the hash checked against the
revision) and answers `{candidate, text, truncated?, title, provenance, can_send_home, send_home_blocked?}`: the first
64 KiB of the text (`truncated` when cut, on a character), the title the handoff would get, where it comes from
(`floor`, `worker_name`, `label`, `harness`, `model`, `branch`, `cwd`, `session`), and whether "send home after
filing" can be offered now.

**`worker.handoff {worker, mode: "literal", session, candidate, revision, send_home?, op}`** files it:

1. The candidate must be the worker's current one, with that session and revision, read under the agent session herdr
   reports of the worker now (a session change withdraws `Worker.handoff` at once; else `handoff_unavailable`; a Codex
   agent whose rollout was found by its cwd, none reported, is offered under none, and again under the session once
   herdr reports it); `op`
   is 1–64 characters of `[A-Za-z0-9_-]`, one per dialog. A second `worker.handoff` with an `op` being filed is
   `busy`.
2. Off the hub goroutine the lines that made the reply the candidate (from its message's, or its Codex turn's, first
   line through the line that completed it) must be byte for byte what the bridge read (`handoff_source` otherwise:
   a transcript truncated and grown again past its old size is caught here), and the transcript lines written after
   them are read with the tracker's own rules: a new prompt, another message or turn or an interruption there makes the
   reply not the latest any more (`handoff_unavailable`, also for the preview), although the bridge's next read has
   not come yet. Then the text is read back as for the preview (`handoff_source` when it is not what it was or the
   transcript is shorter than when the reply was seen, `too_large` above 1 MiB: a literal handoff is never clipped).
3. An `op` filed before, or the same reply (candidate and revision) of the worker whose file is still there, answers
   that handoff (`existing: true`): nothing is filed twice.
4. The file `<handoff_dir>/<floor>/<yyyymmdd-hhmm>-<worker>-<slug>.md` (`--handoff-dir`, default `~/handoff`; the
   worker's floor id (#58: a virtual floor's `v-…`, its session's name on a real floor) with anything but `[A-Za-z0-9._-]` a `-` and no leading dot; the worker's name and the title's slug in
   lowercase ASCII) is written as a dot-named `.tmp` in the floor's directory, synced, and linked to the first free name
   (`-2`, `-3`, … when taken: never over a file; 0600 files, 0700 directories; the path is checked to stay in the
   directory), then the `.tmp` goes. Its front matter is the bridge's (`date` RFC3339 local, `floor`, `worker`,
   `worker_id`, `label`, `branch`, `harness`, `model`, `session`, `cwd`, `source: literal`, `source_turn`,
   `source_items`, `source_hash`, `op`; each a quoted string), followed by the text unchanged: no heading is added. A
   file a crash left without its row is registered at startup with that op and source, so a retry answers it. The
   floor's directory (and the trash's) must be a real directory, never a symlink: nothing is read, moved or written
   through one (`handoff_failed`, and the startup reconcile forgets such a row).
5. The row (`handoff`, with `created_at` the cabinet's order and the source's ids and spans) and its `handoff_fts` row
   are added in one transaction; if that fails the file is removed again (`handoff_failed`). Then `handoff.added`.
6. With `send_home`, the worker is sent home through `worker.fire`'s own path (worktree kept, its own `worker.fire`
   audit row), only now and only if it may go now: not `working`, not `blocked`, no `ask`, and `worker.fire`'s checks.
   The ack says `send_home: "started"` (`worker.removed` follows) or `"skipped"` with `send_home_reason`; the handoff
   is filed either way. No failure in steps 1–5 sends anyone home.

The ack is `{handoff, existing?, send_home?, send_home_reason?}`. The audit row has the ids, the path and the size,
never the text.

**The title** is derived, never generated: the text's first H1 (outside code fences), else its first nonempty line
(heading marks off), else the worker's name and the date; blanks collapsed, at most 80 characters.

**The cabinet.** `handoff.list {floor, q?, limit?}` answers `{floor, handoffs}`: without a query (or only blanks) the
floor's handoffs newest first; with one, the matches by FTS5 `bm25` (title 10, label and worker 3, branch 2, body 1),
each with `snippet`, the body's matching text with each match between U+E000 and U+E001 and cuts marked `…` (text: a
client builds text nodes, never HTML). The query is never FTS5 syntax: it is cut to 256 bytes, control characters made
blanks, split on blanks into at most 8 terms, each quoted (`"` doubled), the last a prefix, all required. `limit`
defaults to 100, at most 500. The index (`tokenize='porter unicode61 remove_diacritics 2'`) stems and folds
diacritics; there is no typo tolerance or substring search. `handoff.get {id}` answers `{handoff, body}`: the file
without its front matter (Markdown: sanitise before showing), at most 1 MiB plus front matter. `handoff.delete {id,
confirm: true}` moves the file to `<handoff_dir>/.trash/<floor>/` (a free name there too) and removes the row and its
index row in one transaction, then `handoff.removed`. A `HandoffEntry` is `{id, floor, worker_id, worker_name, label,
harness, model, cwd, branch, agent_session, path, title, created_at, source, bytes, snippet?}`; `source` is `literal`
(later `agent`, `llm`).

**Startup reconcile.** When the bridge starts it forgets rows whose file is gone, reads a changed file again (size or
mtime) into the index, registers a handoff file it has no row of (a crash between the file and its row: the front
matter says what it is) and removes leftover `.tmp` files. The snapshot's `handoffs.counts` has each floor's count.

#### Ask the agent

#224, part 2 of #11. The worker's own agent writes the handoff with its own `handoff` skill;
the bridge files it. Only an idle or done Claude or Codex worker with no question and no request or wrap-up running,
on a bridge with a cabinet and its transcripts, can be asked.

```json
{"t":"worker.handoff","req_id":"7","args":{"worker":"a58752ea-…","mode":"agent","instruction":"focus on the open review comments","send_home":true,"op":"ho-k2…"}}
{"t":"ack","req_id":"7","data":{"request":{"op":"ho-k2…","state":"pending","started_at":1790859600000,"instruction":"focus on the open review comments","send_home":true}}}
"agent_handoff":{"op":"ho-k2…","state":"filed","started_at":1790859600000,"handoff":12,"send_home_result":"started"}
```

1. **Check.** `op` as for a literal handoff; `instruction` at most 4 KiB (blank: `summarize the conversation`, the
   default; a custom one replaces it). An `op` known answers its request (`existing: true`) and sends nothing; a
   worker with a request running, or a wrap-up armed, is `busy`; not idle or done, or with an `ask`, `invalid_state`.
   The worker's command catalog (`worker.commands`') must list a skill `handoff` no built-in shadows:
   `handoff_skill_missing` otherwise (a partial catalog: its skills could not be listed). Nothing is sent then.
2. **Reserve.** The file the agent writes is `<handoff_dir>/.pending/<floor>/<op>.md` (whatever is there for that op
   goes first), and the request is stored (SQLite `handoff_request`: op, worker, floor, harness, agent session,
   transcript and offset, path, nonce, instruction, send home, state `pending`/`filed`/`failed`, reason, handoff id;
   one `pending` per worker). The startup reconcile never registers from `.pending`.
3. **Prompt.** Once the transcript offset is taken (a request's transcript is looked for every 2 s; one not found within
   about 6 s, as an agent never prompted has none yet, is `invalid_state`, nothing sent), one prompt on the worker's input lane, sent only while it is still
   idle or done: the skill in the harness's spelling (Claude `/handoff`, Codex `$handoff`), the instruction, "write it
   to `<path>.tmp` first, then rename that file to `<path>`" (not the skill's temporary directory), the front matter
   values the bridge supplies (`date` the request's time, `floor`, `worker`, `branch`, `harness`, `model`, `session`,
   `source: "agent"`), "one specific H1 title of at most 80 characters", and a last line `(H3D-HANDOFF <nonce>)`. It
   must fit a prompt (16 KiB) and, for Claude, be typed. The ack follows the prompt: `{request, existing?}`.
4. **Watch.** The transcript from the offset (the wrap-up's rules): the bridge's prompt is the first user prompt that
   contains the marker (Claude records `/handoff …` as its command tags, read as typed; the skill's own text, Claude's
   meta line or Codex's `<skill>` message, is not a prompt), every later prompt or interruption is a person's.
5. **File** once both hold, in either order: the prompt's turn ended, the transcript quiet and herdr `idle` or `done`
   with no `ask`, each for the debounce (2 s), **and** the file is complete (a regular file, its `.tmp` gone). The
   file's own front matter is dropped; its text is filed as a handoff with the bridge's front matter (`source:
   agent`, the request's date and op, the worker's metadata), its title the first H1 else #223's fallback, through the
   same writer, row and index (`handoff.added`), and the reserved file goes. Then, with `send_home`, the send home of
   #223 (worktree kept). A failure to file fails the request.
6. **Fail**, keeping the worker, filing nothing, never sending it home, the reason on `agent_handoff`: no handoff within
   10 minutes; `worker.handoff_cancel`; the transcript gone or the agent session changed; a person prompting, typing
   or answering the worker (`worker.prompt`, `worker.keys`, `worker.answer`, `worker.answer_ask`,
   `worker.answer_followup`, or in the transcript); the turn ending without the file (after 5 s), or with only its
   `.tmp`. The agent's file, if any, goes to `<handoff_dir>/.trash/<floor>/agent-<op>.md`. Asking again is a new request
   (a new op).
7. **Restart.** A request whose prompt was sent resumes from its offset while its 10 minutes run; one never sent, or
   out of time, fails ("restarted"). Reserved files of no pending request go to the trash.

**`Worker.agent_handoff`** is the worker's request while it runs and after it settled (until dismissed or a new one
starts): `{op, state, reason?, started_at, instruction?, send_home?, handoff?, send_home_result?, send_home_reason?}`,
`state` `starting` (checked, not sent), `pending`, `filing`, `filed` (`handoff`: its id) or `failed`.
**`worker.handoff_cancel {worker, op}`** fails a running request as cancelled (`busy` while it is being filed) or
dismisses a settled one; its ack is the request. **`worker.handoff_preview {worker, mode: "agent", candidate?}`**
answers `{provenance, can_send_home, send_home_blocked?, agent: {call?, can_ask, cannot_ask?, harness?, model?,
instruction}, cache?: {state, estimated, evidence}}` and, when `candidate` names the current one, its text as for a
literal preview. The audit row has the op, nonce, path and offset, never the text of the instruction's request.

#### LLM handoffs

#9, part 3 of #3. The configured LLM (the [AI integration](#ai-integration)'s `llm` role; never the classifier, never
the worker's agent) writes a handoff from the worker's transcript, which the bridge reduces and scrubs first; the
worker is not prompted, whatever its cache estimate says. It is filed in #223's cabinet like the other modes. Opt-in
and gated like the [floor overview summaries](#floor-overview-summaries): configuring the AI alone sends nothing.

```json
"handoff_llm":{"enabled":true,"state":"ready","roles":{"llm":"ready"},"env":[],"tested":true,"input_bytes":98304,"max_tokens":4096,"reasoning_effort":"","reasoning":{"support":"unknown","efforts":["low","medium","high"],"listed":false},"effort_stale":false,"timeout_s":90,"prompt_version":"h3d-handoff-llm-1","categories":["your prompts to the worker","…"]}
{"t":"worker.handoff","req_id":"8","args":{"worker":"a58752ea-…","mode":"llm","session":"7a7b7c7d-…","candidate":"4a71102e7ae8ef34","revision":"9267469792d9bd31…","instruction":"the open review comments","send_home":true,"op":"ho-k3…"}}
{"t":"ack","req_id":"8","data":{"job":{"op":"ho-k3…","state":"running","started_at":1790859600000,"updated_at":1790859600000,"model":"gpt-6-sol","host":"llm.example:8443","send_home":true}}}
"llm_handoff":{"op":"ho-k3…","state":"filed","started_at":1790859600000,"updated_at":1790859641000,"model":"gpt-6-sol","host":"llm.example:8443","send_home":true,"handoff":13,"send_home_result":"started"}
```

**The feature** (`World.handoff_llm`, every change a `handoff_llm.update` event with the state flat in it; absent
without the AI integration or a handoff directory). `state`: `off` (the default), `incomplete` (on, the LLM not
ready), `untested` (on, but the LLM's config, the effort or the completion budget changed since the test the switch
was turned on with: nothing is sent until a test passes again, which binds it to the config in use), `ready`.
**`handoff_llm.get`**, **`handoff_llm.set {enabled?, input_bytes?, max_tokens?, reasoning_effort?}`** (a field left
out is kept; `input_bytes` the transcript budget 16–768 KiB, default 96 KiB; `max_tokens` the completion budget,
reasoning included, 1,024–32,768, default 4,096; `reasoning_effort` as for the summaries) and **`handoff_llm.test`**
answer as `digest.*` do: switching on needs the LLM `ready` and a passing test, within 30 minutes, of exactly the
config then in use (`incomplete`, `test_required`); `HERDR_WORLD_HANDOFF_LLM_ENABLED` (`--handoff-llm-enabled`) owns
the switch while set (`env_locked`; it needs no test, still the LLM ready). The test writes a handoff of a short
synthetic session (never a transcript) and acks `{ok, reason?, title?, bytes, latency_ms, diag?}`. Switching off
cancels a handoff that is out. `categories` say what a handoff sends; `timeout_s` and `prompt_version` are the bridge's.

**`worker.handoff_preview {worker, mode: "llm", candidate?}`** (the current candidate when none is named) runs the
reducer and sends nothing: `{candidate, provenance, can_send_home, send_home_blocked?, llm}`, `llm` being `{ready,
unavailable?, model, host, payload_bytes, est_tokens, budget_bytes, max_tokens, timeout_s, prompt_version, reduced,
coverage, redactions, categories, artifacts, verified}`: the recipient (the model and the endpoint's host, never its
path or key), the reduced transcript's size and conservative token estimate, the coverage (`{messages, kept, omitted:
[{from, to, why}], compaction, gaps, abandoned?, sidechains?, deduplicated?, skipped?, complete}`: what of the
snapshot is in it and what was left out), the redaction counts by category (never the text), and the observed
artifact references (and how many a result showed succeeded). `ready` false says why in `unavailable`: the feature not
ready, another LLM handoff out (one at a time), or the reduction refused (the prompts and the final reply alone do not
fit the budget; the transcript changed; a subagent's or an empty one).

**`worker.handoff {worker, mode: "llm", session, candidate, revision, instruction?, send_home?, op}`**:

1. **Check.** `op` as for a literal handoff; the candidate the worker's current one under its agent session
   (`handoff_unavailable` otherwise); `instruction` (the focus, optional) at most 4 KiB of UTF-8. A known `op` answers
   its job (`existing: true`) and sends nothing; the same op with another worker or other arguments is `bad_request`.
   The feature not ready: `handoff_llm_unavailable`, nothing sent; another LLM handoff out: `busy`.
2. **Store.** The job (SQLite `handoff_llm_job`: op, worker, floor, agent session, candidate, a hash of the
   arguments, the LLM config's fingerprint, the prompt version, send home, state, code, message, handoff id, times;
   never the instruction, the transcript or the document) as `running`; the ack is `{job, existing?}` at once and the
   job follows on **`Worker.llm_handoff`**: `{op, state, code?, message?, started_at, updated_at, model?, host?,
   send_home?, handoff?, send_home_result?, send_home_reason?}`, `state` `queued`, `running`, `filed`, `failed` or
   `cancelled`. The job and its audit row are stored together: when either cannot be, the command fails (`internal`)
   with nothing stored or sent, and the op may be used again.
3. **Reduce** (off the hub): the candidate checked to be the transcript's latest completed reply still, then the
   snapshot up to it (where the bridge read that reply to end) reduced and scrubbed within `input_bytes`
   (`internal/handoffllm`, its policy in `internal/handoffllm/doc.go`: the active branch only, no sidechains or
   subagents, streamed copies merged, every genuine prompt and the final reply whole, bounded tool evidence, the
   newest compaction summary or Codex's retained messages, omitted runs marked).
4. **Prompt.** The bridge's versioned system prompt (`prompt_version`), then one user turn of data blocks, each
   between `<<<NAME-<nonce>` and `NAME-<nonce>>>>` with a nonce drawn per request and absent from the data: the
   bridge's facts (time, floor, worker, its agent and model, session, the snapshot boundary, the checkout, the branch
   herdr reported, the git branch and `git status` captured now and labelled so, the skills the command catalog has
   cached for the worker if any, the artifacts observed as verified or unverified (never verified by the absence of a
   failure: a run still running or a result with no outcome is unverified), the coverage gaps), the transcript, and
   the instruction (scrubbed like the transcript). The configured key is replaced in the messages too.
5. **Call.** One completion through the AI integration: at most one handoff call over the bridge, its own timeout
   (`timeout_s`, 90 s, provisional), no second attempt after an outcome the provider may have processed (a timeout, a
   dropped connection, a 5xx; a refused connection may be retried), `max_tokens` with the budget winning over an
   `extra_body` one, the effort; an answer cut off at the budget is `truncated`, never clipped.
6. **Validate.** Markdown with exactly one leading `# ` title of at most 80 characters, every section `## Goal and
   current state`, `## Decisions`, `## Verification`, `## Open questions`, `## Next steps`, `## Suggested skills`,
   some text, at most the budget's bytes and 1 MiB (one code fence around the whole answer is taken off). Else
   `handoff_llm_invalid` (the message says which rule, never the answer).
7. **File**, after checking again on the hub that the job was not stopped, the worker is there under the same agent
   session, the LLM's config is the one it started with and the feature still ready (`handoff_llm_stale`,
   `handoff_llm_unavailable` otherwise): `source: "llm"`, its date the writing's, `op`, the worker's metadata, and in
   the front matter `llm_model`, `llm_host`, `prompt_version`, `snapshot` (`<candidate>@<offset>`), `coverage` and
   `redactions` (a JSON object of counts); `handoff.added`; then, with `send_home`, #223's send home.
8. **Fail**, keeping the worker, filing nothing, never sending it home or trying another mode or model, the code and
   a short message on the job: the AI's codes (`timeout`, `auth_failed`, `rate_limited`, `provider_failed`,
   `truncated`, `empty_answer`, `unreachable`, …), `handoff_llm_invalid`, `handoff_llm_stale` (the LLM's config, the
   agent session or the worker changed while it was written), `handoff_llm_unavailable`, `too_large`,
   `handoff_source`, `handoff_unavailable`, `handoff_failed`, `cancelled` (state `cancelled`, by
   **`worker.handoff_cancel {worker, op}`**, which dismisses a settled job). Trying again is a new job (a new op).
9. **Restart.** A job that was out is failed (`handoff_llm_interrupted`) and never sent again; its op still answers it.
   Settled jobs are kept 30 days.

`handoff.get` of an LLM handoff adds `llm: {model, host, prompt_version, snapshot, coverage, redactions}` from its
front matter. The audit row of `worker.handoff` keeps the instruction's length only (in every mode); an LLM job's
result has the model, host, prompt version, sizes (payload, sent, answer, document), the elapsed time, the outcome
code, the redaction counts, the coverage numbers and the call's sanitized diagnostics; never text.

### Scheduled agents

#62 (part 1 of the epic #61). A schedule is a one-shot hire at a wall-clock time: when it is due the bridge hires a
fresh worker on its floor with its prompt, with no client connected. The original worker is never prompted, and no
schedule path ever sends a worker home or deletes a worktree, a branch or a workspace.

```json
{"t":"schedule.create","req_id":"s1","args":{"floor":"herdr-3d","title":"After the soak","due_at":1792061100000,
 "prompt":"The 24h soak is over. Delete the backups, attach the evidence and close the ticket.",
 "harness":"claude","model":"claude-opus-5-5","effort":"high","cwd":"/home/dev/devel/herdr-3d","worktree":true,
 "handoff_path":"/home/dev/handoff/herdr-3d/20261016-1045-flicker-vector-rollout.md",
 "source":{"kind":"transcript","worker":"6db1905e-9e85-42f4-911c-b05e31b84c68","message":"msg_01"}}}
{"t":"schedule.upsert","seq":2210,"schedule":{"id":"sch_5f3c9a1e7b2d4086","floor":"herdr-3d","title":"After the soak",
 "prompt":"The 24h soak is over. …","due_at":1792061100000,"on_miss":"run_late","harness":"claude",
 "model":"claude-opus-5-5","effort":"high","cwd":"/home/dev/devel/herdr-3d","worktree":true,"wake_floor":true,
 "handoff_path":"/home/dev/handoff/herdr-3d/20261016-1045-flicker-vector-rollout.md",
 "source":{"kind":"transcript","worker":"6db1905e-9e85-42f4-911c-b05e31b84c68","message":"msg_01"},
 "state":"scheduled","created_at":1791974700000,"updated_at":1791974700000}}
```

**The spec.** `floor` is a floor id the bridge knows (a virtual floor too); it cannot change. `title`: 1–200 bytes, no
control characters. `due_at`: unix ms, UTC, in the future on create and update (relative input such as "in 24h" is the
client's to resolve). `prompt`: `worker.hire`'s rules (at most 32 KiB, not starting with `--`, typeable for Claude); it
may be empty only with a `handoff_path`. `harness`, `model` and `effort` are checked against `hire_options` as a hire's
are. `cwd`: an absolute directory that exists now; a schedule never falls back to another one. `worktree` (default
false) makes the fire a worktree hire from `cwd`'s repository. `wake_floor` (default true) wakes the floor when it is
asleep. `handoff_path`: an absolute path to a handoff the worker reads. `on_miss` (`run_late`, the default, or `skip`)
and `max_lateness_ms` (positive, `run_late` only; absent: no limit) are the missed-window policy below. `source` (create
only; default `{"kind":"manual"}`): `manual`, `transcript` or `suggestion`, with the source `worker` and `message` ids
when known.

**States.** `scheduled` (not due) → `waiting` (due, its fire waits: the floor wakes, is busy, is not seen yet, or has no
free desk; `state_reason` says which) → `running` (the hire is in flight; `worker_id`, `fired_at` set) → `done`
(hired) | `failed` | `skipped` | `cancelled`. `failed` and `skipped` carry a `state_reason` that names the flag or path
and stay in view, as *needs attention*, until `schedule.dismiss` (which sets `dismissed_at`) or `schedule.retry`.
`cancelled` and dismissed schedules are kept in the database but leave the view (`schedule.removed`). Every transition
is written to SQLite first (`updated_at`), so a restart resumes them.

| command | allowed from | then |
|---|---|---|
| `schedule.update` | `scheduled` | the new spec |
| `schedule.cancel` | `scheduled`, `waiting` | `cancelled` |
| `schedule.run_now` | `scheduled` | fires now, without the grace check |
| `schedule.retry` | `failed`, `skipped` | fires the same spec now, without the grace check |
| `schedule.dismiss` | `failed`, `skipped` | out of view |

Any other transition answers `invalid_state` (also a command on a cancelled or dismissed schedule); an unknown id is
`not_found`.

**The runner.** The bridge looks at the wall clock every 30 s, and once on startup as soon as discovery has listed the
sessions (and again when a floor is first seen). It never waits on one long monotonic timer, which stops while the host
is suspended: a host that was suspended or a bridge that was down catches up on its next look.

**Grace and the missed window.** A schedule first seen due at most **5 minutes** after `due_at` fires normally. Past
that it was missed:

- `on_miss: "skip"` → `skipped`, `"missed: bridge was offline at 2026-10-17 10:45 UTC (seen 2026-10-17 11:20 UTC)"`.
- `on_miss: "run_late"` later than `max_lateness_ms` → `skipped`, `"missed: 2h late, more than its max_lateness of 1h
  (due …, seen …)"`.
- otherwise it fires late, and its prompt starts with: `This task was scheduled for 2026-10-17 10:45 UTC and is running
  at 2026-10-17 13:05 UTC, 2h 20m late. Check whether anything below is stale before acting.`

`run_now` and `retry` skip the grace check (a retry of a late schedule still gets the late notice).

**Worktree hold.** #63 (part 2 of #61). A schedule that is `scheduled` or `waiting` **holds** the linked worktree its
`cwd` is in (the worktree's top level or any directory under it, compared as canonical paths: cleaned, symlinks
resolved where they exist, on separator boundaries, so `/x/wt` does not hold `/x/wt2`), whatever its `worktree` flag
(a worktree hire still needs `cwd` to find the repository). Nothing in the bridge deletes a held worktree:

- `worker.fire.prepare`: `can_delete` and `can_delete_branch` are `false`, and `reason` is `used by scheduled agent
  '<title>' at <due>`; several holders: the earliest due is named, `… and <n> more`. `<due>` is the bridge's local time,
  `2006-01-02 15:04 MST` (the zone of the bridge's clock, `TZ` / the host's zone), e.g. `used by scheduled agent 'After
  the soak' at 2026-10-17 12:45 CEST and 2 more`. Clients may recognise a hold by the prefix `used by scheduled agent '`
  (at the start of `reason`, or after `invalid state: ` in an error's `message`); the game does.
- `worker.fire` with `delete` / `delete_branch` and `worker.wrapup` with a delete: `invalid_state`, the same reason
  (checked when the command arrives, not only in the dialog). A hold that comes while a send home's agent exits keeps
  the worktree, with a `note`.
- The last check comes right before `herdr worktree remove`, in the same step of the bridge that marks the worktree as
  being removed: a schedule acknowledged before it keeps the worktree (`note` as above; a wrap-up's `CLEAN` falls back
  to keep), and until the removal ends (removed or failed) `schedule.create`, `schedule.update` and `schedule.retry`
  whose `cwd` is that worktree's top or under it answer `busy`: `busy: cwd <cwd> is in the worktree <top>, which is
  being removed (sending <worker> home)`. Retry once the send home is answered; a removed worktree's `cwd` then no
  longer exists (`bad_request`). The mark is in memory: a send home does not survive a restart, so neither does it.
- An armed wrap-up whose worktree is held at its `CLEAN` is sent home keeping it, with a note (see
  [Wrap up](#wrap-up)).
- `keep`, and sending the worker home, always work.

The hold is read from the schedules each time: cancelling a schedule, its fire (`running`, then `done` or `failed`),
`skipped` and `schedule.dismiss` release it. Removals outside the bridge (`git worktree remove`, `rm`) are not
prevented: the schedule then fails when it fires (`working directory <cwd> no longer exists`). Each schedule fires
once: the fire writes `running` before herdr is called, and a schedule a crash left `running` is resolved on startup:
`done` if the bridge ever saw its worker, else `failed` `"bridge stopped while hiring"`. It is never fired again.

**The fire** is `worker.hire`'s path, started by the bridge itself (audited as `worker.hire` by `bridge:schedule`, with
the schedule's id in its args and `req_id` `schedule:<id>`; no client gets a reply). Every client sees it exactly as a
hire: `floor.upsert` when the floor grows a desk, the new worker's `worker.upsert` with `hired_at`, its statuses.

1. The floor is gone (a virtual floor deleted, or a session discovery no longer lists) → `failed` `"floor <id> is gone"`.
2. The floor is asleep: with `wake_floor` the bridge wakes it (`floor.wake`'s path, its own audited `floor.wake` row) and
   the schedule waits; it fires once the wake ends (a failed wake fails it with the wake's error). Without `wake_floor`
   → `failed` `"floor asleep: wake_floor is off"`. While the floor wakes or sleeps (`busy`) the schedule waits and is
   tried again on the next look.
3. `cwd` missing → `failed` `"working directory <cwd> no longer exists"`.
4. A hard cap → `failed` with the hire's message, which names `--max-workers-per-floor` or `--max-workers`.
5. The desk is the bridge's pick: the first desk no worker holds and no hire is on its way to; the floor grows its desks
   as with any hire. None free (hires in flight hold them all) → the schedule waits.
6. The prompt: the late notice (if any), the schedule's `prompt`, then, with a `handoff_path`, the cabinet's Hire from
   handoff line, `Read <path> and continue the work. Invoke the skills it suggests.`, or, if that file is gone, `The
   handoff <path> this task referenced was deleted; continue without it.`; the parts separated by a blank line. A
   prompt that grows over 32 KiB this way fails the fire with the hire's `bad_request` message.
7. The hire succeeds → `done` with `worker_id` and `fired_at`. A hire error → `failed` with its message (as
   `worker.hire` would answer it; a hire that fails after herdr made its workspace rolls that workspace back, as any
   failed hire does). A worker hired whose prompt was not sent → `failed`, `"hired <name>, but its prompt was not sent:
   …"`: the worker stays at its desk.

Stored in SQLite `schedule (id, floor, title, prompt, due_at, on_miss, max_lateness_ms, harness, model, effort, cwd,
worktree, wake_floor, handoff_path, source, source_worker, source_message, state, state_reason, seen_at, fired_at,
worker_id, created_at, updated_at, dismissed_at)`; `seen_at` is when the runner first saw it due (a late run's mark).
A floor keeps its last 50 `done` schedules, by `fired_at`; older ones are deleted.

### Hire presets

#93. A hire preset is a named first prompt with the harness, model and effort to hire it with: a job that comes back
("Deploy a release to A, B and C") saved once and hired again whenever it is needed. It has one of two scopes: **one
floor** (`floor`, a floor id: a session's real floor or a virtual floor, never a building or a base session) or
**global** (no `floor`: every floor of every building this bridge serves; there is no building scope, and nothing is
shared across bridges). Hire presets are not team presets (`preset.*`: five roles of a run) and not the game's task
levels (a named choice without a prompt, kept in the browser). Nothing here hires: using a preset is an ordinary
`worker.hire` the client sends with the preset's prompt and choice, after the player reviewed them, so every hire rule
(desks, caps, worktrees, a virtual floor's wake, the background hire) is `worker.hire`'s.

```json
{"t":"hire_preset.create","req_id":"h1","args":{"name":"Deploy release","floor":"herdr-3d",
 "prompt":"Deploy the release to A, B and C, and report each one.","harness":"claude","model":"claude-sonnet-5-5","effort":"low"}}
{"t":"hire_preset.upsert","seq":2301,"hire_preset":{"id":"hp_3c9a1e7b2d4086f5","name":"Deploy release","floor":"herdr-3d",
 "prompt":"Deploy the release to A, B and C, and report each one.","harness":"claude","model":"claude-sonnet-5-5","effort":"low",
 "created_at":1792237523778,"updated_at":1792237523778}}
{"t":"ack","req_id":"h1","data":{"id":"hp_3c9a1e7b2d4086f5","name":"Deploy release","floor":"herdr-3d","…":"…"}}
```

**The spec**, checked on create and on every update (`bad_request` unless said otherwise):

- `name`: trimmed, 1–40 bytes of UTF-8 without control characters (the team presets' rule), unique ignoring case
  (the bridge compares names with full Unicode case folding: `Équipe` and `équipe`, `ΟΣ` and `ος` are one name, and so
  are `STRASSE` and `straße`, which the game's `toLowerCase` keeps apart, so a client may only learn of that clash from
  the bridge's `name_taken`) **within its scope** (`name_taken`): the same name on two floors, or on a floor and globally, is allowed, and the two
  stay separate presets (a floor's never hides a global one).
- `floor`: absent or `""` is global; otherwise a floor the bridge knows (a real floor it sees, or a defined virtual
  floor; `unknown_session` otherwise). An update that keeps the preset's floor does not check it again, so a floor
  discovery does not list for now keeps its presets editable.
- `prompt`: required, `worker.hire`'s first-prompt rules: 1–32 KiB of UTF-8, not blank, no NUL, not starting with `--`;
  for Claude (typed) no control characters other than line ends and tabs.
- `harness`, `model`, `effort`: one of `hire_options` (the catalog's own check, an effort of the model's included); a
  harness the bridge cannot start is refused.
- `herdr_instructions` (#95): optional bool, "Add herdr hiring instructions"; off (and left out of the preset) unless
  sent, off for every preset made before #95.

`hire_preset.update` replaces the whole spec (moving a preset between a floor and global too); one that changes nothing
sends no event. An unknown id is `not_found`. `created_at` and `updated_at` are unix ms; an update moves `updated_at`
(clients use it to tell an editor that the preset changed elsewhere).

**Lifecycle.** Presets are keyed by floor id: renaming a floor, moving it to another building, hiding it, putting it to
sleep or its session going away for a while change none of them. Deleting a virtual floor (`floor.delete`) deletes its
own presets in the same transaction (`hire_preset.removed` each); global ones stay, and none moves to the base floor.
A catalog that later lacks a preset's model or effort leaves the preset as stored: the client shows the saved values
and why they cannot be hired, and `worker.hire` would refuse them as usual.

**Herdr hiring instructions (#95).** A worker hired from a preset whose prompt starts other agents ("for each pull
request, spawn a subagent") should give each its own herdr workspace or tab and tag it with the worker's floor, as
`run.start`'s orchestrators are told. A preset with `herdr_instructions` makes the client's hire send `worker.hire`'s
`herdr_instructions: true`: the bridge appends the instructions **for the floor the preset is used on** (never a floor
stored in the preset, so a global one fits every floor). They are never part of the preset's `prompt`, and the flag
means "the current hiring instructions", so presets pick up a later change of the text with no migration. The client
shows the exact lines from `hire.prepare`'s `herdr_instructions`, and a hire form may untick them for one hire. Only a
bridge whose snapshot says `herdr_instructions: true` takes the field (an older one refuses it as unknown).

`hire_preset.check {"prompt"}` asks the AI integration's classifier (#92) "Does this task tell the AI coding agent to
start, spawn, hire or hand work to other AI agents (subagents, workers, coders, reviewers) instead of doing all of it
itself?" with state `{"prompt"}`: `delegates` is `score ≥ 0.7`. It fails open: no classifier, one not ready (no call),
an error or 1.2 s gone by answer `{"delegates": false, "score": 0}`. The game asks it on a preset's Save with the box
off (never on Use or Hire) and, on a "yes", asks the player whether to tick the box; it gives up after 1.5 s. The
audit log keeps the prompt's length only (`prompt_bytes`), never its text.

```json
{"t":"hire_preset.check","req_id":"c1","args":{"prompt":"For each pull request, spawn a subagent that merges it."}}
{"t":"ack","req_id":"c1","data":{"delegates":true,"score":0.93}}
{"t":"worker.hire","req_id":"h2","args":{"floor":"v-43c5d831ba4c","desk_index":0,"harness":"codex","model":"gpt-6-luna",
 "effort":"high","prompt":"For each pull request, spawn a subagent that merges it.","herdr_instructions":true}}
```

The worker's first prompt is then the task, a blank line, the placement line, a blank line and `Also tag every herdr
workspace you create with the token h3d_floor=v-43c5d831ba4c, …`.

Stored in SQLite `hire_preset (id, name, name_key, floor, prompt, harness, model, effort, created_at, updated_at,
herdr_instructions)`, `floor` NULL for a global one, with a unique index on (scope, `name_key`): the name case-folded
by the bridge (x/text's full Unicode case folding, then `strings.ToLower`), not SQLite's ASCII-only `lower()`. It joins
at least every two names the game's `toLowerCase` joins. `herdr_instructions` is 0 or 1 (#95's migration adds it, 0).

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

### Notifications

#11. The bridge sends a Telegram message to your phone when a worker **needs you** or **finishes**, by the inbox's
own rule: the game's (`WorldStore.workerView`, `inboxReason`, `inboxQueue`), ported to the bridge
(`internal/notify`) and pinned to it by shared vectors (`internal/notify/testdata/inbox_vectors.json`). The bridge
reads the bot's messages only while a pairing waits or (#13) **replies** are on: then a reply to a notification is
typed into its worker, and (#14) a worker's question comes with buttons that answer it. Nothing leaves the machine
while it is off.

- **Who notifies**: a worker needing you (any role: blocked, an `ask`, a `followup`, a wrap-up `needs_you`, an
  orchestrator over its cap, a freelancer's report request), at once; a worker `done`, after **5 seconds** if it is
  still the same done episode (cancelled when it leaves done; it settles again if it comes back). A freelancer's done
  only with `freelancers` on (off by default, as the inbox's). Waiting workers (#98) and asleep floors never notify.
  The inbox's read and dismissed rows (#106) are the browser's; the bridge ignores them.
- **Once per episode**: an episode is the worker, needs-you or done, and its `since` (`ask.since`, else `followup.at`,
  else `status_since`). What the bridge sees of a worker first (its start, a herdr session back) is known without a
  message, so a restart sends nothing old; so is an episode that starts while the feature, its event or the channel
  is off, or the floor sleeps: switching on later, or a floor waking, sends nothing old either.
- **The message** (plain text, no link previews; `quiet` delivers it without a sound): the worker's name, the reason
  (`Question`, `Follow-up`, `Wrap-up stuck`, `Report request`, `Needs you`, `Finished`) and one line: the overview's
  now line (else its task line), else the last line of the agent's last text, else none, with anything shaped like a
  key or token removed (`digest.Scrub`), at most 200 characters. A worker whose `ask` has a `secret` question gets no
  line at all.
- **The token**: from @BotFather. `notify.token.set` checks it with Telegram's `getMe` and keeps it in `telegram.json`
  (0600, next to the database; `--telegram-file`, `HERDR_WORLD_TELEGRAM_FILE`), never in SQLite, never in a view, an
  event, an error, a log line or an audit row (`channel.key_set`, `channel.key_hint`: its last four characters).
  `--telegram-key-file` / `HERDR_WORLD_TELEGRAM_KEY_FILE` gives it from a file instead: `channel.key_env`, `env` lists
  `token`, and `notify.token.*` are `env_locked`.
- **Pairing**: `notify.pair.start` shows `channel.pairing` `{"state": "waiting", "code": "ABCD-EFGH", "expires_at"}`
  (a one-time code, 10 minutes). Send it to the bot (`channel.bot`, its username) from your Telegram account: the
  first private message whose text is the code (any case, spaces and dashes ignored) pairs **its sender** (Telegram's
  `from.id`), and every message then goes to that account (`channel.paired {"name", "at"}`: a first name and when;
  never the id). Every other message, from anyone, is ignored without a reply. The bridge long-polls Telegram's
  `getUpdates` only while the code waits (or replies are read, below: one poll loop serves both, so there is never a
  second reader); a poll that fails shows `state` `error`, another program reading the bot's updates (a webhook, a
  second bridge with that token: Telegram's 409) `conflict`, both retried with a backoff; an unused code ends as
  `{"state": "expired"}`. `notify.pair.cancel` stops it, `notify.unpair` forgets the account.
- **Settings** (bridge-wide, SQLite `notify_settings`): `enabled`, `events {"needs_you", "done"}`, `quiet`,
  `freelancers`, `replies` (#13, off by default, apart from `enabled`: no environment override). `HERDR_WORLD_NOTIFY_ENABLED` / `--notify-enabled` (`true` / `false`) wins over the stored switch and
  lists `enabled` in `env` (`env_locked`); it needs no test, the channel must still be ready. Otherwise switching on
  needs a token, a paired account and a `notify.test` delivered with them in the last 30 minutes (`tested`).
- **State**: `off`; `incomplete` (on, `missing` lists `token` and/or `recipient`: nothing is sent); `ready`; `blocked`
  (on, but Telegram refused the last message: the bot blocked or never started, or the token revoked; `last_error`
  says which, until a delivery works).
- **Delivery**: a queue of 32 messages (a full one drops and counts it, `dropped`); at most 4 attempts; Telegram's
  `retry_after` is honoured on a 429 (more than 2 minutes: given up), a 5xx or a network failure waits 1, 2 then 4 s.
  A Telegram outage never holds up the bridge.
- **Replies** (#13; `replies` on, a paired account): **reply** (Telegram's reply-to) to a notification and the bridge
  types your text into that notification's worker, through `worker.prompt`'s own checks, input lane and herdr calls,
  so the transcript shows it as your next prompt and typing from the game and the phone is serialised. The bridge
  remembers which worker each delivered notification was about (SQLite `notify_message`, keyed on Telegram's chat and
  message id: the newest 500, none older than 7 days). Only messages in your private chat with the bot, from the
  paired account (`from.id`), typed by you, count: another sender, a group, a bot, a message on behalf of a chat are
  dropped without a word; a forward or a message through another bot is refused. Typed into its worker, your reply
  gets a 👍 reaction; otherwise the bot answers it (as a reply) with one fixed sentence, never your text: not a reply
  to a notification or no text (how to reply), a notification it no longer knows ("I no longer know which worker
  this was, reply to a newer notification"), the worker's ask (#57: "This worker has a question, tap an answer or
  answer in the game"), over 4096 characters ("too long (N characters)"), more than 6 replies to one worker or 20 in
  all within a minute, the worker gone, asleep or without an agent, its input lane full (32 waiting), herdr failing
  it, a `/handoff` (ask for it in the game). The bot's answers are bounded too (10 a minute; more are not sent).
  Switched on, nothing sent while replies were off is typed (the first poll forgets the backlog, and only a message
  dated after the second of the switch is typed: Telegram's dates are whole seconds, so one sent in that very second
  is dropped too); switched off, unpaired or paired anew, nothing read before is typed, a poll or a reply already
  under way included (the change waits for a reply being handed to its worker's lane).
  Replies on when the bridge starts (a restart, a release): what came while it was away is read, and typed when sent
  within the last 2 minutes; older is answered as not sent. Telegram keeps updates 24 hours at most. Replies stay on
  across unpairing: they read only the account paired at the time, and pause while there is none.
- **Answer buttons** (#14; `replies` on): a notification about an `ask` or a `followup` is followed (quietly) by a
  **card** per question: the question (its header, its text), each option with its description and its preview cut
  to one short line, and a button for each option; then **Other…** when the question takes a typed answer, **Done**
  for a multi-select and **Cancel** for an ask. A follow-up's `yes_no` question is **Yes** / **No**, a `choice` its
  options and **Other…**, an `open` one **Answer…**; a follow-up has no Cancel. **Other…** and **Answer…** send a
  prompt that opens the reply field (Telegram's force reply, a message of its own); your reply to it is that
  question's typed answer (an ask's: one line, at most 4 KiB; a follow-up's: at most 8000 bytes), confirmed with a
  👍, and never typed as a prompt; a reply to the card itself gets the ask's hint. A single-choice tap answers its
  question; a multi-select's taps toggle (the card shows ☑ / ☐) until **Done**. Once every question has its answer,
  the bridge answers the worker as the game does: `worker.answer_ask` (1-based `choices`, `other`) or `cancel: true`,
  `worker.answer_followup` (`Yes` / `No`, the option's text, the typed text), with their checks on the worker's input
  lane, no client: no command reply, no row of those commands. A secret question is never relayed: an ask with one
  gets one card, "Its answer is secret. Answer this one in the game.", none of its texts, no button. An ask or
  follow-up of more than 4 questions gets no cards. Every tap is answered at once (the button's spinner stops), and
  the cards are edited to their end: the answer, Cancelled, "Answered in the game." once the ask or follow-up left
  the worker another way, "No longer open" when the bridge found it answered or replaced meanwhile, why it was not
  sent (the reply refusals' sentences), or "Replies are off" when they are switched off. A button's data is a short
  token of the bridge's and an action (never an id); a tap on a card the bridge no longer knows (a restart: cards
  are kept in memory, at most 32 asks and follow-ups) is answered "No longer open" and its buttons are taken away.
  Taps count only from the paired account in your private chat with the bot, under the replies' switch and
  recipient (switched off, unpaired or paired anew: nothing read before answers a worker); anyone else's tap is
  answered without a word. At most 30 taps a minute on one worker's cards, 60 in all.
- **Menu buttons** (#88; `replies` on): a worker `blocked` on a `permission` or `trust` menu its screen shows
  (`worker.question` with choices; not a `choice` one) gets one card after its notification: "Permission" or "Trust
  folder", what such a menu asks in a fixed line (not the screen's question line), a note that what it is about is not
  sent, each choice and a button for each; no Cancel (each such menu has its own No or Quit). The question is read off
  the screen a moment after the worker turns blocked, so the card comes once both are there for the same blocked spell
  (`status_since`): a worker first seen blocked (a restart) rings nothing and gets no card. Of the menu only its
  choices' labels go: one that says what not to ask about again is cut where its command would start ("Yes, and
  don't ask again for …", a one-letter key such as "(p)" kept), any other that may name a command ("ask again",
  "command") is "…" unless known to name none, a span in backticks elsewhere is `` `…` ``, and anything shaped
  like a key or token is removed; never a line above the menu (its question, the command, the edit, a trust dialog's
  folder) nor the rest of the screen. A tap answers as the game's
  `worker.answer` does, with the card's `hash` and the choice's number, on the worker's input lane, no client: the
  screen is read again first, and a menu no longer shown (another hash, the worker no longer blocked) sends no key and
  the card says "No longer open"; it says "Answered in the game." once the bridge sees the menu leave first. A new
  menu in the same blocked spell closes the old card and gets its own. Keys sent and the worker still blocked after
  `AnswerTimeout` (3 s): the card says "✓ Sent: <choice>" and "It still waits on its menu: look at it in the game."
  and offers nothing more for that menu. A menu gets one card while the blocked spell lasts, though its screen read
  fails a while and it comes back or other menus come between; a spell's first 32 menus get cards, and past that it
  opens none (the notification went; answer in the game). The gates, the taps' answers and the windows are the cards'
  above.
- **Audit**: the bridge's own rows, client `bridge`: `notify.send` `{"id", "kind", "attempts", "status"?, "code"?}`,
  `notify.pair` `{"outcome": "paired" | "cancelled" | "expired", "ignored"?, "errors"?, "status"?}` and (#13)
  `notify.reply` `{"id"?, "text_bytes", "text_runes", "outcome"}` (`sent`, else the refusal: `not_a_reply`,
  `no_text`, `relayed`, `stale`, `too_long`, `unknown`, `rate_limited`, `ask`, `gone`, `invalid_state`, `busy`,
  `bad_text`, `handoff`, `failed`; #14: `typed_answer`, a card's typed answer taken). A reply's prompt writes no
  `worker.prompt` row. #14: `notify.tap` `{"id"?, "kind"?: "ask" | "followup" | "menu" (#88), "question"?, "action"?: "option" |
  "type" | "done" | "cancel", "option"?, "outcome"}` (`ok`, `off`, `unknown`, `closed`, `rate_limited`, `busy`,
  `empty`) and `notify.answer` `{"id", "kind", "questions", "choices"?, "typed_bytes"?, "typed_runes"?, "cancel"?,
  "outcome"}` (`sent`, else the refusal of a reply's, or `closed`; #88: `unresolved`, a menu's keys sent and the
  worker still blocked, not an error); a card's answer writes no `worker.answer_ask`, `worker.answer_followup` or
  (#88) `worker.answer` row. Never a message's text, an answer, a label, a code, a token or a Telegram id.

### Host stats

#74. The game's server rack shows the CPU and memory of the machine the bridge runs on, the number of pending system
updates on an Arch-based host, and its disks' activity. All of it is sampled **only while a game watches**: the game sends
`host.watch` while the rack is in view on the floor you stand on (the tab visible, the bridge connected) and
`host.unwatch` when it is not. With no watcher the bridge reads nothing under `/proc` or `/sys` and never runs
`checkupdates`.

- **`host.watch {}` / `host.unwatch {}`**: idempotent per connection, acked with no data. The sampler is one per bridge:
  the first watching connection starts it, the last one leaving (an `unwatch`, or a disconnect, which drops the watch)
  stops it. A connection that joins a running sampler gets the latest `host.stats` at once. A bridge from before them
  answers `unknown_command`; the game then shows a calm idle screen ("No host stats on this bridge"), never an error.
  They are not written to the audit log: a game flaps them as the player turns.
- **`host.stats`** (bridge → each watching connection, no `seq`, never replayed, not in the ring or the snapshot): the
  first one about a second after sampling starts, then every 5 s (`Options.HostStatsPoll`).

```json
{"t":"host.stats","cpu_pct":12.4,"cpus":12,"load1":0.82,"mem_used_pct":41.3,"mem_used_bytes":13523000000,
 "mem_total_bytes":33547000000,"sampled_at":"2026-10-16T12:00:05Z",
 "updates":{"count":3,"checked_at":"2026-10-16T11:31:10Z"}}
```

| field | meaning |
|---|---|
| `cpu_pct` | share of CPU time in use over all cores since the previous sample, in percent, one decimal: `1 − Δidle/Δtotal` over the aggregate `cpu` line of `/proc/stat` (`idle` is idle + iowait; `total` is user + nice + system + idle + iowait + irq + softirq + steal, leaving out guest time, which is already in user). `null` until two samples exist; when `Δtotal ≤ 0` (a counter reset, a suspend) the previous value is kept |
| `cpus` | the CPU count |
| `load1` | the 1-minute load average |
| `mem_used_pct`, `mem_used_bytes`, `mem_total_bytes` | `MemTotal − MemAvailable` of `/proc/meminfo`, exactly the `used` column of `free`, its share, and `MemTotal` |
| `sampled_at` | when the sample was taken, RFC 3339, UTC |
| `updates` | pending pacman updates: the last good count and when it was taken (`checked_at`). **Absent** on a host that is not Arch-based (`/etc/os-release` `ID=arch` or `arch` in `ID_LIKE`) or lacks `checkupdates` or `fakeroot` (found like the other CLIs, `PATH` then `~/.local/bin`), and until a check has worked |

- **Updates**: `checkupdates` (pacman-contrib) syncs a throwaway copy of the sync database, so it can never cause a partial
  upgrade, needs no root and never touches the real database; the bridge never runs `pacman -Sy`, never runs anything as
  root and never upgrades. `CHECKUPDATES_DB` is `checkupdates/` next to the bridge's database, so the run never meets another
  `checkupdates`' `db.lck` (a bar module, a cron job). A check starts only while somebody watches, never more often than every
  12 hours since the last one began (a failed, timed-out or cancelled run counts: watching, unwatching and watching again
  starts one run, not several), one at a time, with a 60 s timeout, and stops with the last watcher (SIGTERM to its process
  group, SIGKILL after 3 s; a stopped run's `db.lck` in that directory is removed once it is reaped). Exit 0 is the updates (one line each), 2 none, 1 or a timeout keeps the last good count with its `checked_at`: the
  bridge never invents one.
- **`host.disk`** (bridge → each watching connection, no `seq`, every second while sampling): the physical disks' activity
  over the last second. `/proc/diskstats` counters (reads and writes completed, 512-byte sectors) are differenced per disk.
  A device counts when `/sys/block/<dev>/device` exists, so `loop*`, `ram*`, `zram*`, `dm-*` and `md*` and the partitions
  (not in `/sys/block`) are left out; `/sys/block` is read again only when a device name appears in diskstats that was not
  seen before. A counter that goes backwards resets that disk's baseline: it reports zero for that second, never a negative
  rate. `disks` is sorted by name and is `[]` when the host has no physical disk.

```json
{"t":"host.disk","disks":[{"name":"nvme0n1","r_iops":12.0,"w_iops":240.0,"r_bps":49152,"w_bps":8388608}]}
```

### Errors

```json
{"t":"error","req_id":"9","code":"unknown_command","message":"unknown command \"worker.prompt\""}
```

| code | meaning |
|---|---|
| `bad_request` | not a JSON object with `t`; missing `req_id`; bad or unknown `args` fields; invalid name; a second `hello` |
| `auth_failed`, `no_models_endpoint`, `unreachable`, `timeout`, `bad_response`, `truncated`, `empty_answer`, `incomplete`, `test_required`, `env_locked` | #92 `ai.*` (see [AI integration](#ai-integration)); `rate_limited` and `provider_failed` are used there too; #90 `followups.*` and #110 `packup.*` use `incomplete`, `test_required`, `env_locked` and, from their tests' calls, the `ai.*` ones (`packup.detect` never fails on a model: no match); #98 `activity.set` uses `env_locked`; #118 `digest.*` use `incomplete`, `test_required`, `env_locked`, `bad_request` (#174: also a reasoning effort or budget the model or the range refuses; `digest.retry` also `unknown_worker`) and, from its test's calls, the `ai.*` ones (`truncated`, `empty_answer`); #211 `hire.interpret` never fails with them: they are its result's `error` (see [Hire interpretation](#hire-interpretation)) |
| `bad_url`, `key_required`, `not_configured`, `unauthorized`, `forbidden` | #184 `kaneo.*` and a floor's Kaneo link (see [Kaneo](#kaneo)); `unauthorized` (the provider refused the key, HTTP 401, maybe its quota) and `forbidden` (a permission problem, HTTP 403) also from the board commands of a provider that tells them apart; `unreachable`, `timeout`, `test_required`, `rate_limited` and `provider_failed` are used there too |
| `not_paired`, `blocked`, `conflict`, `dropped` | #11 `notify.*` (see [Notifications](#notifications)): no Telegram account is paired; Telegram will not deliver to it (the bot blocked or never started, HTTP 403, or 400 "chat not found"); another program reads the bot's updates (409; a pairing's state, never a command's answer); an alert the full queue dropped (an audit row's code only). `test_required`, `env_locked`, `not_configured` (no token), `unauthorized` (Telegram refused the token), `bad_request`, `rate_limited`, `unreachable`, `timeout` and `provider_failed` are used there too |
| `unknown_command` | `t` is not a command of this protocol version. The connection stays open. |
| `not_found` | no building with that id; #62 no schedule with that id; a `transcript.item` id that is not in the transcript, a `transcript.image` hash this connection was not sent (or an image that can no longer be read), or a subagent (`agent`) without a transcript; no team preset with that id (`preset.update`, `preset.delete`, `run.prepare`, `run.start`); a board item id that is not on the floor's provider, or a `work_item` that is not on its board |
| `name_taken` | another building, or another team preset, already has that name (ignoring case); #58 `session.create`: a floor, a herdr session (also an asleep one), a session folder or a loaded `herdr-s-<name>` unit has that name |
| `unknown_session` | a floor command for a session the bridge does not know or does not watch (`--sessions`) |
| `unknown_worker` | `worker.fire.prepare` / `worker.fire` / the laptop commands for a worker id the bridge does not know (or on an unwatched floor) |
| `busy` | `transcript.image` with 16 reads already in flight for that watch; a floor command while that floor's wake or sleep is in progress; `floor.wake` / `floor.sleep` while a hire or send-home on it is in progress; `worker.fire*` for a worker that is still being hired or already being sent home; #83: `worker.wrapup` for a worker already armed, `worker.wrapup.cancel` once its CLEAN's send home started; #224: an agent handoff for a worker with a request running or a wrap-up armed, a wrap-up while a request runs, `worker.handoff_cancel` while it is being filed; #58: `session.create` of a name already being created; #60: `worker.retry_followup` while a retry of that follow-up runs; #63: `schedule.create` / `schedule.update` / `schedule.retry` whose `cwd` is in a worktree a send home is removing now |
| `invalid_state` | `worker.open_pr` for a worker that is not a plain worker in the branch the bridge made, or whose tree is dirty or has nothing to open; `floor.wake` on a running floor, `floor.sleep` on an asleep one, hire or send home on an asleep floor; a laptop command for a worker on an asleep floor or without a pane, `worker.prompt` to a plain shell, a blocked worker (but one blocked only by a Codex async question) or one with an `ask`, #156 `worker.answer_async` / `worker.dismiss_async` for a worker that is not a shared Codex worker, a `conflict` batch, or (answer) a batch under a legacy `item-N` id or a thread the bridge is not attached to, `worker.commands` for a worker running no Claude or Codex agent, `worker.answer` to a worker not blocked; `transcript.page` / `transcript.item` / `transcript.image` / `transcript.images` for a worker this connection does not watch or whose transcript is pending, or whose transcript changed while it was read; #60 `worker.retry_followup` after 3 retries of that follow-up, or while follow-up questions are not `ready`; #62 a `schedule.*` command in a state it does not allow (see [Scheduled agents](#scheduled-agents)), or on a cancelled or dismissed schedule; #63 `worker.fire` with `delete` / `delete_branch` or `worker.wrapup` with a delete of a worktree a schedule holds (the message ends in `used by scheduled agent '<title>' at <due>`, see "Worktree hold") |
| `desk_taken` | `worker.hire` at a desk someone holds or a hire in flight reserved, or outside `0 … desks-1` |
| `whiteboard_conflict` | M13: a save whose `base` is not the board's current version (HTTP `409`, with the current `version`) |
| `whiteboard_invalid`, `whiteboard_too_large`, `whiteboard_unsupported`, `whiteboard_hash_mismatch`, `whiteboard_missing_file` | M13: a scene, file, render or pin the bridge refuses (see [Whiteboard](#whiteboard)) |
| `drops_unavailable` | `drops.list` without a Drop Zone data directory, or one that cannot be read |
| `too_large` | `transcript.image` with `size: "full"` for an image whose base64 is over 12 MiB (its thumbnail is still served); #223 `worker.handoff_preview` / `worker.handoff` for a reply over 1 MiB (never clipped) |
| `handoff_llm_unavailable`, `handoff_llm_invalid`, `handoff_llm_stale`, `handoff_llm_interrupted` | #9 (see [LLM handoffs](#llm-handoffs)): LLM handoffs are off, their LLM not ready or untested (nothing was sent); the model's answer is not a handoff of the agreed shape; the LLM's config, the agent session or the worker changed while it was written; the bridge restarted while it was written (never sent again). Nothing was filed and nobody was sent home on any of them; the last three are a job's `code` |
| `handoff_skill_missing` | #224: the worker's harness lists no `handoff` skill in its checkout (or its skills could not be listed), so its agent cannot be asked for a handoff; nothing was sent (see [Ask the agent](#ask-the-agent)) |
| `handoff_unavailable`, `handoff_source`, `handoff_failed` | #223 (see [Handoffs](#handoffs)): the worker has no candidate or not the one named (stale: a newer turn, another session or revision); the candidate's lines in the transcript, or those that completed it, are not what they were (replaced, truncated, changed); writing or registering the file failed. Nothing was filed and nobody was sent home on any of them |
| `capacity` | `worker.hire` above `--max-workers-per-floor` or `--max-workers`, `terminal.watch` above `--max-watches` or `--max-observers`, `transcript.watch` above `--max-transcript-watches`; the message says which |
| `not_clean` | #83: `worker.wrapup` with a delete for a tree that is not clean and pushed now; `worker.fire` asked to delete a worktree whose tree is dirty or has unpushed commits; for `delete_branch` also when the checkout is no longer on the branch the bridge made or that branch has commits on no remote |
| `fetch_failed` | `worker.hire` with `worktree: true` whose `git fetch origin` failed (no `origin`, offline, timed out after 20 s, …); the message is git's error. Nothing was made. (After the accept, like `bad_request` for a missing default branch.) |
| `hire_failed`, `fire_failed` | herdr or git failed during a hire / send-home; the message says which step and why. `fire_failed` also when the agent did not exit (still running, or its processes could not be read): then nothing was closed or removed. `hire_failed` names what its rollback kept. |
| `wake_failed` | the last server's unit did not unload within 15 s, or the server did not start, did not answer `ping` or was not seen running within `--wake-timeout`; the message says why |
| `session_create_failed` | #58 `session.create`: `herdr session list` could not be read, `systemd-run` failed, or the new floor was not seen running within `--wake-timeout`; the message carries herdr's error, and whatever the call started was stopped and removed |
| `sleep_failed` | `herdr session stop` failed (the message has herdr's error), or the floor was not seen asleep within 15 s |
| `input_failed` | #156 `worker.answer_async`: the worker's app-server refused the answer (nothing delivered; the question is `pending` again with its `error`); `worker.keys` / `worker.answer` / `worker.answer_ask`: herdr refused the keys or text (`terminal.zoom`: herdr refused the zoom), the screen could not be read, or 32 commands already wait for that worker; `worker.answer_ask` also when the dialog was not where it should be before a step, or still there after the last one; the message says why |
| `prompt_failed` | `worker.prompt` was not submitted: herdr failed, or the agent did not start working even after Enter was pressed again |
| `stale` | #184 `issue.set_status` with `after` on a Kaneo board that changed since it was read (Kaneo's 409), `floor.settings.set` whose floor's tracker or Kaneo link, or the Kaneo connection, changed while it was checked, and `run.start` whose `work_item` was being read when the floor's board source changed; #156 `worker.answer_async` / `worker.dismiss_async` for a `thread` that is not the worker's now, an unknown batch, or a question not in a state it can take (answered, dismissed, sending, sent; checked again on the input lane); #90 `worker.answer_followup` / `worker.dismiss_followup` (#60: `worker.retry_followup` / `worker.followup_message`) for a `turn_id` that is not the worker's follow-up (answered, dismissed, or a newer turn); `worker.answer` for a question the worker's screen no longer asks (another `hash`), or a worker no longer blocked; `worker.answer_ask` for an ask the worker no longer has (another `tool_use_id`, or none), also when it was answered or replaced while its keys were being pressed, or (`cancel`) the screen shows another question; `pr.merge` whose head moved since it was read |
| `changes_failed` | `worker.changes` whose git calls failed, or took longer than 10 s together; the message is git's error |
| `not_a_repo` | `worker.changes` for a worker whose directory is not in a git work tree |
| `files_failed` | #137 `worker.files` (#39: `hire.files`) whose listing failed (git's error, rg's, or the listing could not start) with no earlier index of that checkout to answer from |
| `confirmation_required` | `issue.close`, `pr.merge`, `worker.open_pr` or #223 `handoff.delete` without `confirm: true` (see [Boards](#boards-issues-and-pull-requests)) |
| `unsupported` | the floor has no board (no repo linked, no provider), or the provider or the card cannot do it (a capability is off); `worker.open_pr*` on a floor that cannot open pull requests; #58 `session.create` on a bridge without herdr control |
| `provider_failed` | the provider call failed (`gh` missing, not logged in, the network, GitHub's refusal, a failed `git push`); the message is short and never has a token |
| `rate_limited` | the provider's rate limit |
| `checks_not_green`, `not_mergeable` | `pr.merge` of a pull request whose checks are not green, or that is not mergeable (also a conflicting one, always); an override is `override` and `confirm_override` together |
| `hello_required`, `unsupported_proto` | handshake failures; the connection is then closed with status 1008 |
| `no_client`, `not_sharing` | M13 `screen.grab`: no game is connected (or the sharing one went away mid-grab); a game is connected and shares nothing (or stopped mid-grab) |
| `frame_timeout`, `frame_invalid`, `frame_too_large`, `frame_unavailable` | M13 `screen.grab`: the game sent no frame within 5 s; what it sent is not a valid JPEG; it is over 8 MiB, or wider than 1920 or taller than 4096 pixels; the game said it has no frame (the source is paused, sharing stopped while it encoded). The last three are also the answers of `POST /screen/frame/{req_id}` |
| `logo_too_large`, `logo_unsupported`, `logo_invalid`, `logo_busy` | M3d, only on the `/logo` HTTP routes (see [Building logos](#building-logos)): an upload over the size limit, of an unsupported kind (an SVG that took too long to draw included), undecodable, or no conversion slot in time |
| `bridge_changed` | #57, the helper's own, on its HTTP routes (`409`): the page names another bridge than the one in use (a switch made in another tab); the page reloads on that one (see [The helper's bridges](#the-helpers-bridges-57)) |
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
herdr-world cmd session.create '{"name":"h3d-scratch2"}'
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
