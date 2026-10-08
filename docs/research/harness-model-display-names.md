# Harness model display names

Checked 2026-10-08 against repository source, installed Claude Code 2.1.294 / Codex 0.161.0, and official OpenAI documentation. Research only; no feature implementation.

Ticket: [#200 — Show friendly model names in the hire dialog](https://github.com/JeffreyVdb/herdr-3d/issues/200).

## Finding

**Both existing discovery protocols already return `displayName`.** A full manually maintained model-name catalog is unnecessary. The bridge currently discards that field and sends only model slugs. Claude supplies the exact requested `claude-opus-5` → `Opus 5` mapping.

The official [Codex app-server model-list documentation](https://developers.openai.com/codex/app-server#list-models-modellist) includes a `displayName` field. The installed Anthropic Agent SDK 0.3.183 declares `ModelInfo.displayName: string` as a human-readable name in `sdk.d.ts:1149–1157` at `/home/dev/.local/lib/node_modules/@agentmemory/agentmemory/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`. The [Anthropic TypeScript SDK reference](https://platform.claude.com/docs/en/agent-sdk/typescript) could not be fetched by the web tool; its installed first-party declarations and the live initialization response provide the evidence here.

## Live metadata evidence

Both probes ran in private temporary directories with the same environment cleaning and arguments as [`internal/harness/models.go`](../../internal/harness/models.go). Claude hooks, tools, MCP connections, and session persistence were disabled. Only protocol initialization and Codex `model/list` were sent, with no user turn or inference request.

| Harness | Returned launch identity | Returned `displayName` |
| --- | --- | --- |
| Claude | `value=claude-opus-5`, `resolvedModel=claude-opus-5` | `Opus 5` |
| Claude | `value=opus`, `resolvedModel=claude-opus-5-5` | `Opus 5.5` |
| Claude | `value=fable`, `resolvedModel=claude-fable-5-1` | `Fable 5.1` |
| Claude | `value=default`, `resolvedModel=claude-sonnet-5-5` | `Default (recommended)` |
| Claude | `value=sonnet`, `resolvedModel=claude-sonnet-5-5` | `Sonnet 5.5` |
| Claude | `value=haiku`, `resolvedModel=claude-haiku-5-5` | `Haiku 5.5` |
| Claude | `value=claude-haiku-4-5-20251001`, same `resolvedModel` | `Haiku 4.5` |
| Codex | `model=gpt-6.1-sol` | `GPT-6.1-Sol` |
| Codex | `model=gpt-6-astra` | `GPT-6-Astra` |
| Codex | `model=gpt-6-sol` | `GPT-6-Sol` |
| Codex | `model=gpt-6-luna` | `GPT-6-Luna` |

Codex's actual labels retain some hyphens, unlike the docs example `GPT-6.1 Sol`. Using provider labels automatically solves the Claude request. For Codex, a narrow formatter for the known GPT naming pattern can present `GPT-6.1-Sol` as `GPT 6.1 Sol`. Do not replace every hyphen globally or infer decimal versions from arbitrary slugs: names can contain dates, variants, and provider-specific identifiers.

## Recommended implementation

- Decode `displayName` in both existing probes, carry it alongside each launchable ID, and add optional `model_labels: { [slug]: label }` to `HarnessOptions`. Preserve `models: string[]`, efforts, launch validation, ordering, stored choices, and all submission values. This is an additive protocol change, with no storage migration or new SDK dependency.
- Handle Claude duplicate canonical IDs deliberately: the `default` entry arrives before `sonnet`, and today's first-entry deduplication would show `Default (recommended)` for the concrete Sonnet slug. Keep the existing ID order and prefer a non-default model-specific display name when aliases resolve to one ID. Use the label associated with the actual accepted ID when falling back to a valid alias.
- Add a shared label lookup that trims a valid label and otherwise returns the slug. Unknown models then remain selectable and identifiable. A small explicit fallback-label table can cover the built-in legacy catalog if pretty labels are required when discovery fails or an older bridge omits metadata; this is a convenience fallback, not a catalog to maintain for every release.
- Render labels as text in both hire chips and the searchable grid, while radio values, keys, selected state, visibility preferences, and requests keep raw IDs. Search both label and slug. Expose the exact slug in a tooltip or secondary detail, especially when distinct IDs share a label.
- Validate optional label metadata without discarding an otherwise valid model/effort catalog. Avoid inserting provider names as HTML. Reuse the lookup in Harness models Settings for consistency with the visibility work in [#194](https://github.com/JeffreyVdb/herdr-3d/issues/194).

Relevant seams: [`internal/harness/models.go`](../../internal/harness/models.go), [`internal/proto/proto.go`](../../internal/proto/proto.go), [`game/src/world/store.ts`](../../game/src/world/store.ts), [`game/src/world/hire.ts`](../../game/src/world/hire.ts), and [`game/src/ui/hire.ts`](../../game/src/ui/hire.ts). Catalogs refresh at bridge startup in [`internal/app/models.go`](../../internal/app/models.go); names therefore follow the same lifecycle as model availability. Codex can use a bundled or cached catalog, as noted in the official [Models and inference guidance](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).

## Difficulty and verification

Estimate: **small change, about 3–5 hours including focused tests** for metadata plumbing, the hire chooser, and narrow Codex label formatting; allow up to a day for all other picker surfaces or broader formatting rules. This is an estimate, not a measured implementation duration.

Verify provider-label decoding, Claude default/concrete alias deduplication, missing/blank labels, old-bridge compatibility, malformed metadata, duplicate labels, search by label/slug, both chip/grid paths, and submission of the unchanged exact slug. No automated tests were run for this documentation-only investigation; the two live initialization probes are the verification performed.
