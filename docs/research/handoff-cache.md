# Handoff prompt-cache research

Checked 2026-10-09 through AlterLab MCP search and page extraction. Research and ticket planning only; no implementation or inference calls.

## Findings

Saving an existing completed assistant message literally requires no model call and is independent of cache state. Generating a handoff inside the existing agent session can reuse its prefix if the model, request shape, authentication boundary, and cache entry still match. A separate configured-model request constructed from JSONL should be budgeted as a cold read of its selected context. These are different actions and should have distinct labels.

| Route | Verified cache lifetime | What this means for a handoff |
| --- | --- | --- |
| Claude Code, subscription included usage, main conversation | One hour by default | An appended handoff skill can reuse the prefix. |
| Claude Code, API key/cloud provider or subscription usage credits | Five minutes by default; configurable to one hour | Do not infer one hour just from the harness name. |
| Claude Code helpers outside the main conversation | Five minutes by default, including forks and compaction, unless overridden | Their request TTL differs from the main conversation's TTL. |
| OpenAI API, GPT-5.6 and later | At least 30 minutes after last write/reuse; may remain longer | API eligibility is documented; routing/prefix compatibility still matter. |
| OpenAI API, earlier models with `in_memory` | Usually 5–10 minutes inactive, up to one hour | A maximum is not an assured warm period. |
| OpenAI API, earlier models with `24h` | Usually about 30 minutes, potentially up to 24 hours | Do not advertise a guaranteed 24-hour cache. |
| Codex signed in with ChatGPT | No Codex-specific subscription TTL established in the official sources checked | Display unknown rather than copying an API retention number. |

Claude Code defaults above come from [How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching#cache-lifetime). OpenAI API values come from the current [Prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching#cache-lifetime); it supersedes older guidance that treats every model as having the same retention behavior. Codex supports both ChatGPT sign-in and API keys, with different policies and billing, according to [Authentication](https://developers.openai.com/codex/auth).

## Claude Code evidence and estimation

Claude Code re-sends the full context for each request. Exact prefix matching saves server-side processing and input cost, not client-side transcript transmission. Loading skills appends instructions without changing the existing prefix. A skill specifying another model triggers a model switch and an uncached full read. A fork inherits the parent prefix; an ordinary subagent has different instructions/tools and starts its own cache. [Claude Code prompt caching](https://code.claude.com/docs/en/prompt-caching#cache-scope).

Inspect observed `usage.cache_creation.ephemeral_1h_input_tokens` and `ephemeral_5m_input_tokens` to identify TTLs used for writes. `cache_read_input_tokens` records actual hits. Mixed TTLs can occur, and no writes on a cached turn does not identify or reset the TTL by itself. [Claude Code TTL selection](https://code.claude.com/docs/en/prompt-caching#choose-the-ttl-yourself), [Claude API tracking](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#tracking-cache-performance).

The Claude API lifetime starts at the request's start, including generation time: a four-minute response leaves roughly one minute of a five-minute cache window. The Claude Code UI describes warmth using the most recent request or response. Prefer request-start timing where available; a transcript response timestamp alone can overestimate remaining time. [Claude API cache lifetime](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#how-prompt-caching-works), [Claude Code model switches](https://code.claude.com/docs/en/prompt-caching#switching-models).

Newer Claude Code exposes main-conversation `prompt_cache` statistics to a statusline script, including `warm`, `hit_ratio`, and an expiry timestamp. This appears after the first main-conversation API response and requires v2.1.251 or later. It is useful optional evidence, not proof that a future handoff request will hit. [Statusline prompt cache fields](https://code.claude.com/docs/en/statusline#prompt-cache-fields).

## Codex scope and uncertainty

Official OpenAI engineering guidance confirms that Codex keeps system instructions, tools, sandbox configuration, and environment context stable and appends changes to preserve prefixes. It does not establish a separate retention SLA for Codex subscription sessions. [Prompt Caching 201, Codex learnings](https://developers.openai.com/cookbook/examples/prompt_caching_201#42-stabilize-the-prefix).

The API's current GPT-5.6-and-later policy uses `prompt_cache_options.ttl: "30m"`. Earlier models use `prompt_cache_retention`, with availability/defaults dependent on the model and organization data policy. Cache entries reside on individual serving machines and are not shared between organizations or processing regions. [OpenAI cache lifetime and location](https://developers.openai.com/api/docs/guides/prompt-caching#cache-lifetime).

A related ChatGPT plan-usage preview explicitly rejects `prompt_cache_retention` and requires sending necessary input history for HTTP requests. This is evidence that API controls cannot be assumed to apply unchanged to all subscription routes; it is not a statement of native Codex's TTL. [ChatGPT plan-usage preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations#responses-api-requirements).

For a cache indicator, distinguish an observed historical hit from estimated present eligibility. A timestamp alone cannot detect an intervening model/prefix/configuration change, routing miss, or the actual auth-specific retention policy. Do not issue a keepalive or probe inference request solely to discover cache status.

## Configured-model JSONL handoffs

A cheaper configured model is a sensible option for offline or older sessions, but a lower uncached model price does not guarantee a lower price than a warm premium session. Each Claude model has its own cache; changing the system prompt or replacing messages with serialized JSONL also changes the prefix. OpenAI reuse likewise requires a matching prefix and compatible model/settings. A normalized JSONL handoff request therefore should assume no reuse of the source session's cache. [Claude model switches](https://code.claude.com/docs/en/prompt-caching#switching-models), [OpenAI matching requirements](https://developers.openai.com/api/docs/guides/prompt-caching#how-caching-works).

Cost planning should use selected input tokens, output tokens, configured model rates, and the actual write/read policy. GPT-5.6-and-later cache writes cost 1.25 times ordinary input; Claude five-minute writes cost 1.25 times and one-hour writes cost twice ordinary input. Repeated reads are much cheaper, with model-specific multipliers. [OpenAI cache pricing](https://developers.openai.com/api/docs/guides/prompt-caching#summary-of-model-differences), [Claude cache pricing](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing).

Recommended product behavior, inferred from these constraints:

- Literal: save the latest eligible completed final answer verbatim, with its source message/session identity and timestamp. Do not attempt semantic summary detection with another model.
- Agent-generated: append `/handoff` or equivalent skill instructions to the existing session and keep its current model/prefix. Present cache warmth as estimated or unknown.
- Configured model: select and normalize the active JSONL conversation, exclude envelope duplication and irrelevant tool output, and clearly present that this sends selected session context to the configured provider. Include objective, decisions, completed work, pending work, relevant files, validation, blockers, and uncertainties in the output specification.
- Large logs need an explicit context budget. Prefer an actual readable prior compaction summary plus later turns when available; do not assume every compacted event contains readable summary text. Report omitted/truncated context instead of silently claiming a complete handoff.
- Gate the cheaper-model choice on representative handoff quality/cost/latency checks. No quality benchmark was run during this research.

## Detecting the last final reply without inference

At repository revision `484b8e242069ef1ddc89edf50434b9ed5e50b0fa`, `internal/transcript/turn.go` already provides `TurnEvents`, message-block assembly and `FollowupTracker` for the latest completed main-thread reply. Claude uses assistant `message.id`/blocks and terminal `stop_reason`, with interactive `system/turn_duration`; Codex uses `task_complete.last_agent_message` and the preceding assistant response. Sidechains, new prompts and interruptions are handled. Extend these seams to retain source identity and raw text rather than inventing another semantic summary detector. [Shared turn parser](https://github.com/JeffreyVdb/herdr-3d/blob/484b8e242069ef1ddc89edf50434b9ed5e50b0fa/internal/transcript/turn.go).

Modern Codex assistant `phase: final_answer` identifies a closeout; `commentary` identifies an intermediate update. Prefer this distinction when present, with completed-turn fallbacks for legacy logs. It establishes finality, not completeness as a whole-session handoff. [Official Codex phase semantics](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide#phase).

The repository's empirical JSONL study found Claude thinking blocks can also carry `end_turn`, and headless sessions can omit `turn_duration`. Therefore a thinking record alone is not a final-message candidate. The renderer's “summary” reasoning label and Claude summary/title metadata are different from the final reply. [JSONL observations](https://github.com/JeffreyVdb/herdr-3d/blob/484b8e242069ef1ddc89edf50434b9ed5e50b0fa/docs/research/transcript-activity-jsonl.md), [Transcript renderer](https://github.com/JeffreyVdb/herdr-3d/blob/484b8e242069ef1ddc89edf50434b9ed5e50b0fa/game/src/laptop/transcriptRender.ts).

`FollowupTracker` trims its text and derives its turn ID from a content hash, which cannot distinguish identical replies from separate turns. Literal saving should use the actual session/turn/item/span identity and an expected revision, resolve all text from the bridge index, and preserve the raw body rather than taking this trimmed tracker value or rendered DOM text. List previews can be truncated; `transcript.Log` re-reads full source spans. Reject unavailable/oversized text rather than clipping it silently. [Turn tracker](https://github.com/JeffreyVdb/herdr-3d/blob/484b8e242069ef1ddc89edf50434b9ed5e50b0fa/internal/transcript/turn.go), [Transcript index](https://github.com/JeffreyVdb/herdr-3d/blob/484b8e242069ef1ddc89edf50434b9ed5e50b0fa/internal/transcript/log.go).

The checked Codex compaction fixture has an empty `payload.message` and selected `retained_context`, not a guaranteed readable complete summary. A configured-model reducer cannot blindly start after this marker and assume the prior work was preserved. Reduce earlier readable history or disclose/refuse missing coverage. [Compaction fixture](https://github.com/JeffreyVdb/herdr-3d/blob/484b8e242069ef1ddc89edf50434b9ed5e50b0fa/internal/transcript/testdata/codex/compacted.jsonl).

## Ticket outcome

Converted [#11](https://github.com/JeffreyVdb/herdr-3d/issues/11) to an epic with three actual GitHub sub-issues:

1. [#223: Literal transcript handoff and shared filing cabinet](https://github.com/JeffreyVdb/herdr-3d/issues/223).
2. [#224: Native agent handoff and evidence-based cache estimates](https://github.com/JeffreyVdb/herdr-3d/issues/224).
3. [#112: Configured-LLM handoffs from bounded session JSONL](https://github.com/JeffreyVdb/herdr-3d/issues/112), reusing the existing follow-up ticket.

Parts 2 and 3 depend on Part 1 and can proceed independently. The configured LLM is an explicit choice regardless of estimated source-cache state. No production files or user skills were edited, no handoff model experiment ran, and this research note was not committed or pushed.
