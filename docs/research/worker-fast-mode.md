# Opt-in fast mode for hired workers

Checked 2026-10-21 using Alterlab MCP search and page extraction of official OpenAI and Anthropic documentation. Local observations use Codex CLI 0.163.0 and repository HEAD `458105a94641e2528cf3b3efc6a7db4a175d152a`; the parent investigation also observed Claude Code 2.1.306. This is research for a ticket, not an implementation. No inference request or paid fast session was run.

## Findings

Both harnesses support fast mode, including the requested exact model `gpt-6.1-sol` in Codex. Support depends on model, account, client, and organization policy. Speed should be a separate control from model and reasoning effort, defaulting to **off for each new hire**. Neither vendor's persisted personal preference meets that requirement by itself. [Codex Speed](https://learn.chatgpt.com/docs/agent-configuration/speed), [Claude Code fast mode](https://code.claude.com/docs/en/fast-mode).

| Harness | Supported models relevant to hiring | Documented surfaces and restrictions | Cost implication |
|---|---|---|---|
| Codex | GPT-6.1 Sol, GPT-6 Astra, GPT-6 Sol, GPT-6 Luna; GPT-5.6 also documented | ChatGPT desktop app, CLI, IDE extension with ChatGPT sign-in; actual selected model must advertise Fast. GPT-6.1 Sol launched on Plus, Pro, Business, Enterprise, Edu in desktop and CLI; Enterprise/Edu require administrator enablement, Free/Go excluded at launch. | Fast consumes included subscription usage at 2.5× Standard; purchased credits and Enterprise pay-as-you-go at 2×. API-key runs use separate API token pricing. |
| Claude Code | Opus 5.5, Opus 5, Opus 4.8 | CLI, VS Code command, cloud sessions; Anthropic subscription/Console only. Pro/Max/Team/Enterprise require usage credits, and Team/Enterprise require owner enablement. Console requires paid account and provisioned fast-mode access. | Up to 2.5× faster. Input/output per million tokens: Opus 5.5 $8/$40; Opus 5 and 4.8 $10/$50. Subscription fast usage draws directly from usage credits even when included usage remains. |

Sources: [Codex Speed](https://learn.chatgpt.com/docs/agent-configuration/speed), [exact GPT-6.1 Sol availability](https://learn.chatgpt.com/docs/models#gpt-61-sol), [Codex CLI catalog-driven Fast command](https://learn.chatgpt.com/docs/developer-commands#toggle-fast-mode-with-fast), [Claude Code fast mode](https://code.claude.com/docs/en/fast-mode).

Do not infer universal IDE access to GPT-6.1 Sol from the generic Codex Fast surfaces list: its model launch list names desktop/CLI and states that controls vary by client, plan, rollout, and workspace. Use runtime capabilities and handle rejection. [Models](https://learn.chatgpt.com/docs/models#gpt-61-sol).

Claude Sonnet, Haiku, and Opus 4.7 are unsupported. Opus 4.7 fast mode was removed July 24, 2026. Claude Code fast mode is unavailable through Amazon Bedrock, Google Cloud's Agent Platform, Microsoft Foundry, and Claude Platform on AWS. Current Code documentation describes fast mode as research preview, with changing availability and prices. [Claude Code fast mode](https://code.claude.com/docs/en/fast-mode).

## Codex integration and explicit off

The documented CLI opt-in is `service_tier = "fast"` with `[features].fast_mode = true`; `/fast` toggles and saves the preference. Command-line `-c key=value` overrides configuration defaults for that invocation. [Speed](https://learn.chatgpt.com/docs/agent-configuration/speed), [CLI reference](https://learn.chatgpt.com/docs/developer-commands).

Candidate launch arguments:

```text
# Explicitly chosen Fast
-c 'service_tier="fast"' -c 'features.fast_mode=true'

# Off/default hire; override an inherited fast or ultrafast tier
-c 'service_tier="default"'
```

The **off value was checked locally without inference**: launched `codex -c 'service_tier="default"' app-server --stdio`, sent `initialize`/`initialized`, then `config/read`; the effective configuration returned `service_tier: "default"` with no error. Codex's generated 0.163.0 `TurnStartParams` explicitly documents `"default"` as standard speed. This confirms configuration acceptance, not end-to-end backend routing.

The installed CLI can generate matching protocol bindings with `codex app-server generate-ts --experimental --out <temporary-directory>`. Local output established:

- `Model.serviceTiers` contains `{id, name, description}` entries; `defaultServiceTier` is separate; `additionalSpeedTiers` is deprecated.
- `ThreadStartParams`, `ThreadResumeParams`, and `TurnStartParams` accept `serviceTier`.
- `serviceTierForTurn` overrides only a newly started turn, with omitted/null inheriting the thread tier. It does not update the persistent thread choice.
- `ThreadStartResponse.serviceTier` reports the effective tier.

This is version-specific local schema evidence. [Official app-server documentation](https://learn.chatgpt.com/docs/app-server) recommends generating schemas from the installed version and describes `model/list`, thread creation/resumption, and turn overrides.

The bundled 0.163.0 catalog's exact `gpt-6.1-sol` entry advertises:

```json
{
  "service_tiers": [
    {"id": "priority", "name": "Fast", "description": "2x speed, increased usage"}
  ],
  "additional_speed_tiers": ["fast"],
  "default_service_tier": null
}
```

Read with `codex debug models --bundled`, which uses bundled metadata without refreshing the remote endpoint. Prefer the advertised tier ID in protocol integration; normalize the `fast`/`priority` aliases at the boundary. Actual account eligibility still needs validation. The official API Fast guide accepts both `fast` and `priority`; this is separate API evidence, not proof of Codex account entitlement. [Codex debug models](https://learn.chatgpt.com/docs/developer-commands), [API Fast mode](https://developers.openai.com/api/docs/guides/fast-mode).

Herdr must apply the worker's explicit choice at the thread/turn boundary of a shared server, rather than changing a process-wide default that other workers inherit. Test start, resume, wake, remote TUI, per-worker app-server, and legacy launch paths. Omitting a tier or sending null does not establish standard speed where an inherited tier exists. This is an integration recommendation from the protocol above.

For API-key authentication, OpenAI API projects can themselves default to Fast, so omission is also insufficient there. API response `service_tier` records the actual processing tier; ramp-rate limiting may downgrade requests to `default` and standard pricing. [API Fast mode](https://developers.openai.com/api/docs/guides/fast-mode).

## Claude integration and explicit off

Claude's persisted `fastMode: true` normally carries across sessions. Pass an explicit Boolean through the session's existing `--settings` JSON, preserving Herdr's hooks and other settings:

```json
{"fastMode": false}
```

Use `true` only for an explicitly approved eligible hire. `--settings` accepts a JSON file path or inline JSON, overrides project and user settings, and applies only to that session. Managed settings have higher precedence and can prohibit fast mode. [CLI reference](https://code.claude.com/docs/en/cli-reference#cli-flags), [settings precedence](https://code.claude.com/docs/en/settings#settings-precedence), [fastMode reference](https://code.claude.com/docs/en/settings-reference#fastmode).

`CLAUDE_CODE_DISABLE_FAST_MODE=1` disables the feature for a session and cannot be overridden by `fastMode: true`. Respect that environment and organization policy. `fastModePerSessionOptIn: true` suppresses persisted preference; an explicit `--settings` true still counts as per-session opt-in unless this opt-in policy is managed. A managed opt-in requirement refuses activation outside interactive terminal sessions, including headless and cloud sessions. Therefore it is not sufficient to add that policy universally and assume automated workers can opt in. [settings reference](https://code.claude.com/docs/en/settings-reference#fastmodepersessionoptin), [fast mode requirements](https://code.claude.com/docs/en/fast-mode#requirements).

Noninteractive `claude -p --settings '{"fastMode":true}'` support requires Claude Code 2.1.205 or later; cloud fast mode requires 2.1.271 or later. Do not send `/fast` into the prompt as the primary configuration mechanism. Enabling Fast while an unsupported model is selected can automatically switch Claude to Opus; Herdr should instead gate the control and reject incompatible combinations. [Claude Code fast mode](https://code.claude.com/docs/en/fast-mode).

The Claude Agent SDK shares the runtime: fast-mode usage-credit exhaustion appears in SDK and headless `stream-json` output as a `system` notification (2.1.221+). Fast requests then retry at standard speed/pricing. Ordinary fast rate limits enter a cooldown at standard speed and automatically resume Fast afterward. Treat requested mode and effective speed as distinct states. [rate-limit handling](https://code.claude.com/docs/en/fast-mode#handle-rate-limits).

## Product requirements recommended for the ticket

- Add an unchecked Fast mode control wherever a worker is hired; keep it independent of reasoning effort and display the increased usage/cost before opt-in.
- Every fresh hire starts off, including opening a new dialog after a fast hire. Existing data and omitted fields resolve to off. A preset, floor default, browser cache, inherited CLI config, or parent model preference must not silently opt a new worker in.
- Preserve an explicit choice for the same worker across wake/resume; an explicitly configured future scheduled hire can retain its own approved choice. Rehire/new run should ask for a new choice. These are proposed semantics of the user's off-by-default requirement, not vendor behavior.
- Capability changes must clear an enabled toggle or visibly require a supported model; never silently change the selected model or upgrade to Ultrafast.
- Validate both clients and server boundaries, including non-UI hire requests. Make unavailable account/policy/provider combinations understandable and distinguish requested Fast from fallback standard execution.
- Preserve settings hooks, avoid writing personal global CLI defaults, and test off against preexisting global/project Fast defaults as well as resumes from a previously Fast thread.

## Evidence limits

Web retrieval used Alterlab MCP only, with successful searches followed by full first-party page extraction. Some additional searches timed out; their snippets are not evidence for a claim above. Public pages and the local bundled catalog may evolve independently.

No live Fast request, account entitlement probe, throughput benchmark, or cost measurement was performed. Exact backend behavior for Codex aliases on all supported versions, authoritative account-aware capability reporting, shared-server resume overrides, and Claude managed-settings precedence in Herdr's deployed environments remain implementation validation work. The local Codex off check only reads effective configuration.

Ultrafast is a separate product tier and should be outside this ticket: Codex supports it on GPT-6.1 Sol/GPT-6 Astra with additional Pro $500 or eligible Enterprise/Edu restrictions and materially higher usage. Do not confuse it with the requested Fast toggle. [Codex Speed](https://learn.chatgpt.com/docs/agent-configuration/speed#ultrafast-mode).

## Repository scope and ticket

Created [#172: Add opt-in Fast mode to every worker hiring flow (Codex and Claude Code)](https://github.com/JeffreyVdb/herdr-3d/issues/172). The live Herdr 3D floor links `JeffreyVdb/herdr-3d` with the default GitHub tracker. No existing Fast-mode issue was found there.

At the inspected revision, production hiring types and launch commands have no speed option. Relevant seams:

- `internal/proto/proto.go`: `Hire` (harness/model/effort), `HarnessOptions` and `WorkerHireArgs`; related launch, hire-preset and schedule protocol types and store records; `game/src/net/protocol.ts`. Adding a field to the shared tuple must not silently make paid Fast mode sticky through floor defaults or presets.
- `game/src/ui/{hire,hireReview,startRun,presets,hirePresets,scheduleForm}.ts` and the corresponding world state. `game/src/app.ts` routes desk hires, board Ask/Review/conflict actions and dictated review into these dialogs. Include compact forms, background coordination and handoff/rehire entry points.
- `internal/server/hire.go`: `beginHire` serves direct hires, run orchestrators and schedule firing. `launch.go`, `schedule.go` and `hirepreset.go` copy choices along their respective routes. `runprompt.go` currently passes only harness/model/effort to delegated team workers; an orchestrator's speed must not silently opt its team in.
- `internal/herdr/{hire,control,codexremote}.go`: `Agent` and the allowlisted launch commands carry model/effort without a tier override. `internal/server/codexserver.go` starts a per-worker shared app-server and remote TUI, with legacy fallback; `internal/codexapp` and `internal/store/codexlaunch.go` cover launch/resume persistence. Verify explicit off and on through remote and embedded wake/resume paths, applying the setting to the inference owner.
- `docs/protocol.md` states the current API-equivalent cost estimate excludes Fast premiums; preserve that disclosure unless the estimator is explicitly extended.

The ticket is self-contained: support/pricing sources, these integration seams, fresh-hire default-off semantics, explicit schedule opt-in, model/account gating, and acceptance checks against inherited Fast defaults. Only this research note was added locally; application code and provider configuration were unchanged.
