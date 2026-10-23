# MCP and skills office display

Investigated 2026-10-23. This is a proposal for the virtual office in Herdr 3D.

Ticket: [GitHub #196](https://github.com/JeffreyVdb/herdr-3d/issues/196).

## Finding

Feasible, with substantial existing plumbing for skills and the display interaction. The difficult part is reporting the right scope and distinguishing configuration from live connectivity. A modest first version should show MCP configuration, observed connection/authentication state where available, and available skills for a selected repository and harness/profile. It must label incomplete or stale observations explicitly.

No model turn is needed to enumerate configuration, skills or connection metadata. Therefore the proposed implementation should add no model-token charge for those operations. This is an engineering conclusion about avoiding inference, not a promise that every MCP service is free: starting server processes and fetching discovery metadata uses local resources and network traffic, and provider-specific hosting, quotas or charges can still apply. Display refresh must never invoke an MCP business tool or ask a model to describe its setup.

## Verified capabilities

### Codex

The official app-server protocol exposes `skills/list` scoped by `cwds`, `forceReload`, and `skills/changed` invalidation notifications. `mcpServerStatus/list` supports pagination, a smaller `toolsAndAuthOnly` response, optional server selection and reuse of a thread's connection through `threadId`. `config/read` resolves configuration layers; startup-status notifications are available for loaded threads. These are control operations separate from `turn/start`. [Official app-server documentation](https://learn.chatgpt.com/docs/app-server)

The installed CLI reports **0.163.0**. Its protocol schema was generated locally with `codex app-server generate-json-schema --out <temporary-directory>`, without starting a session or connecting to an MCP server. The generated stable schema confirms:

- `ListMcpServerStatusParams`: `cursor`, `limit`, `detail`, `serverName`, `threadId`.
- `McpServerStatus`: `name`, `authStatus`, tools/resources, optional `runtimeStatus`, `toolsError`, `httpOrigin`, `pluginId` and server metadata. `runtimeStatus` can be null when unavailable or configuration changed.
- Runtime states: `notStarted`, `starting`, `connected`, `authenticationRequired`, `failed`, `cancelled`, `disabled`. Auth states: `unknown`, `unsupported`, `notLoggedIn`, `bearerToken`, `oAuth`. Auth state is not proof of reachability; unsupported auth need not be an error.
- Startup notification states: `starting`, `ready`, `failed`, `cancelled`, with optional error/failure reason. Startup readiness is an observation, not perpetual health.
- `SkillsListResponse`: per-cwd skills plus load errors; each skill includes `enabled`, name, description, path and scope (`user`, `repo`, `system`, `admin`), with optional plugin ownership and dependencies.

These field details come from the installed binary's generated schema, which is more specific than the public narrative docs. No incompatibility with the documented methods was found. Feature-detect absent fields/methods on older binaries; do not reinterpret absence as an empty or healthy list. Schema generation is reproducible and was the only Codex operation beyond version/help checks.

### Claude Code

The installed CLI reports **2.1.309**. The official SDK documents `supportedCommands()` and `mcpServerStatus()`. Commands expose name, description, argument hint, optional aliases and a builtin marker, but no universal enabled flag or skill provenance. MCP results include `connected`, `failed`, `needs-auth`, `pending`, `disabled`, optional errors, scope/source and tools. Raw configuration may also be included and should never be forwarded wholesale to the browser. The TypeScript reference was fetched as Markdown because the HTML exceeded the browser retrieval limit. [Official TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript.md)

The Python SDK's `get_mcp_status()` obtains current configured-server status through the control connection. Its `get_server_info()` exposes initialization data, including commands. The implementation sends an `mcp_status` control request; this is not a prompt. [Official Python client](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/client.py), [control implementation](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py)

`claude mcp list` provides health information but connects to servers to obtain it; project approval/rejection/disabled states are configuration decisions. Configuration is scoped to user, project and local settings. Cached discovery can expose tools before a current connection exists. Consequently a CLI discovery probe is not a passive observation of an already-running worker. [Official MCP reference](https://code.claude.com/docs/en/mcp)

Skills have separate user/model invocation rules: a model-only skill need not appear in a slash-command menu, while a manually invokable skill can prohibit automatic invocation. `skillOverrides: off` also hides entries from SDK command lists. Thus `supportedCommands()` alone cannot prove a complete installed/enabled-skill inventory or distinguish disabled from absent. Preserve uncertainty; supplement with supported metadata/config discovery where needed. [Official skill reference](https://code.claude.com/docs/en/skills)

When using the SDK, working directory and setting sources affect discovery; explicitly excluding user/project sources excludes their skills. Match the intended worker's settings context. [Official SDK skills guide](https://code.claude.com/docs/en/agent-sdk/skills)

## Existing Herdr integration and gaps

- [Command probes](../../internal/harness/commands.go) already read Claude initialization commands and Codex `skills/list` without a model turn. The Codex projection discards disabled skills and only logs load errors; preserve those in a new inventory model. Claude's classification is heuristic: plugin commands and MCP prompts can be marked as skills. Do not present these as verified skill origins.
- [Probe setup](../../internal/harness/models.go) deliberately launches Claude with `--strict-mcp-config`, no tools and hooks disabled. That probe is appropriate for its current purpose but cannot report the user's actual MCP connections. A separate adapter is needed; do not simply remove isolation from every existing command probe.
- [The command catalog](../../internal/harness/catalog.go) caches by `(harness, checkout)` for 30 seconds. The new inventory needs profile/config-home and observation provenance in its identity, plus freshness and partial/error metadata. A bridge-default environment is not automatically a worker's environment.
- [Codex watcher](../../internal/codexapp/watch.go) already attaches to a worker-owned app-server; extend its read operations to observe that thread's MCP state where supported. [Worker launches](../../internal/codexapp/launch.go) support profile-specific environments. [Existing shared-server research](codex-shared-tui.md) documents why process environment matters.
- [Claude child tracking](../../internal/claudechild) primarily observes transcripts; it does not establish an SDK control connection to every interactive Claude session. A new probe can report its own observations, not claim access to an arbitrary existing TUI's live connections. Establish a supported session-control route in an implementation spike or show configuration/unknown for those sessions.

## Proposed display and status semantics

Use a compact wall preview showing each harness's MCP counts, problems and skill count. Interacting opens a readable overview with MCP/skills tabs, repository selection, Codex profile selection and observation time/source. Reuse [overview-screen rendering](../../game/src/render/overviewScreen.ts), [prop rendering](../../game/src/render/props.ts), and [app overlay interaction](../../game/src/app.ts).

The existing `screen.overview` occupies the west lounge wall and should remain available. In [the layout](../../game/src/world/layout.ts), the north wall gap above the server rack is a placement candidate: approximately x=4.9–7.0, y=1.9–3.1, facing +z. Validate all layouts, windows, whiteboard, mezzanine supports, sightlines and interaction reach before choosing final coordinates. This is a scene-code assessment, not a visual placement validation.

Keep these facts separate in the data model and UI:

| Fact/state | Meaning |
| --- | --- |
| Configured | A definition exists in the selected effective context. |
| Disabled / approval required | Definition exists but is intentionally unavailable or awaits trust/approval. |
| Connecting / not started | No completed live connection observation yet. |
| Connected | A specific runtime reports a connection at the observation time. |
| Needs authentication | Reported authentication problem; distinct from no definition. |
| Failed | Observed connection/discovery failure, with a sanitized reason. |
| Unknown / stale / unavailable | No reliable current observation, unsupported API, failed probe or missing CLI. |
| Not configured | An expected server has no definition in this scope. |

To detect a server missing from **both** harnesses, store an explicit expected-server list. Comparing only the union of discovered names cannot find it. A server configured in one harness and absent in the other can show “Not configured in Codex/Claude Code,” but intentional differences should not automatically raise an error. Do not merge different endpoints merely because their names match; retain harness and configuration identity.

An empty successful result means “No MCP servers configured” or “No skills reported.” A timeout, unreadable configuration or unsupported API means unknown/partial, never an empty success. Skills should show available/enabled/disabled/load-error when established; otherwise label them reported commands/skills with limited coverage. They have no meaningful connection-health status.

## Refresh, effort and validation

Prefer existing-session observations and config reads. Refresh only while useful: cache results, coalesce concurrent requests, use notifications where available, bound discovery timeouts and back off failures. A 30–60 second refresh interval is a reasonable initial design choice, not a benchmark result. An explicit health refresh may perform MCP initialization/discovery but must not call business tools or change config/authentication. Avoid respawning one server set per rendered frame or per browser viewer.

Proposed implementation estimate: **3–5 engineering days** for a scoped read-only first version with configuration inventory, supported live observations, skills, wall preview, accessible overlay and meaningful tests. Allow **roughly 1–2 weeks total** for broad session/profile coverage, Claude skill provenance/completeness, version compatibility and polished failure handling. These are planning estimates; the main uncertainty is observing existing Claude sessions without launching a different runtime. The narrower version remains useful when live status is honestly unknown.

Acceptance coverage should include absent-in-both expected MCPs; one-harness-only configuration; disabled, auth, startup and failure states; unsupported/missing CLI; stale and partial results; pagination; per-repository/profile isolation; malformed/disabled skills; duplicate names; secret redaction; keyboard access and both office layouts. Fake protocol tests should assert inventory refresh sends no user turns and no business-tool invocations.

This investigation read repository source and official documentation, checked installed versions/help and generated an offline schema. It did not start model turns, connect to the user's MCP servers, inspect credential contents, benchmark discovery or validate wall placement in a running scene.
