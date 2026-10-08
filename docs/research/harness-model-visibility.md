# Harness model visibility in the hire dialog

Checked 2026-10-08 against repository source. This is a proposed feature; no implementation or live model availability probe was performed.

Ticket: [#194 — Configure model visibility per harness in the hire dialog](https://github.com/JeffreyVdb/herdr-3d/issues/194).

## Finding

The hire dialog already has a dynamic model catalog. A personal, per-harness hidden-model preference can filter that catalog without changing discovery, launch validation, stored floor defaults, or presets. Recommended first scope: **Settings → Harness models**, grouped by harness, stored **This browser**, applied across floors to the worker hire dialog.

The user's preference examples are to retain GPT-6.1-Sol for Codex and Claude-Sonnet-5.5, Claude-Opus-5.5, claude-fable-5-1, and Claude-Haiku-5-5 for Claude Code. They are preference examples, not verified catalog entries or defaults to hardcode. Settings must use the exact slugs provided by each harness.

## Existing behavior and seams

| Concern | Source and implication |
| --- | --- |
| Catalog discovery | [`internal/app/models.go:12`](../../internal/app/models.go#L12) probes both harnesses at bridge startup. A failed probe keeps only that harness's legacy fallback. Discovery details are documented in [harness-model-discovery.md](harness-model-discovery.md). |
| Catalog contents | [`internal/harness/models.go:187`](../../internal/harness/models.go#L187) queries Codex `model/list`; [`internal/harness/models.go:277`](../../internal/harness/models.go#L277) reads Claude's SDK initialization response. [`internal/harness/models.go:41`](../../internal/harness/models.go#L41) preserves order, deduplicates slugs, validates launch bounds, and encodes model effort capabilities. |
| Protocol and validation | [`internal/proto/proto.go:217`](../../internal/proto/proto.go#L217) defines `HireOptions` and `HarnessOptions`. [`internal/server/hub.go:1833`](../../internal/server/hub.go#L1833) publishes `world.hire_options`; [`internal/server/settings.go:44`](../../internal/server/settings.go#L44) validates accepted model/effort combinations against the raw catalog. |
| Browser catalog | [`game/src/world/store.ts:131`](../../game/src/world/store.ts#L131) accepts well-shaped snapshot catalogs, with legacy fallback for invalid/missing catalogs. Keep this raw catalog available to Settings, including hidden models. |
| Hire picker | [`game/src/ui/hire.ts:548`](../../game/src/ui/hire.ts#L548) renders harness, model, and effort controls. [`game/src/ui/hire.ts:674`](../../game/src/ui/hire.ts#L674) chooses chips or a searchable grid based on model count. [`game/src/ui/hire.ts:118`](../../game/src/ui/hire.ts#L118) implements the grid search and always keeps the selected model visible, so filtering only the DOM would leave a hidden selected model exposed. |
| Choice resolution | [`game/src/world/hire.ts:26`](../../game/src/world/hire.ts#L26) keeps a requested valid choice, otherwise chooses the harness's first model and a supported effort. [`game/src/ui/hire.ts:400`](../../game/src/ui/hire.ts#L400) resolves both prepare choices and reviewer prefill; [`game/src/ui/hire.ts:762`](../../game/src/ui/hire.ts#L762) resolves picker changes. All these hire-specific paths need visibility-aware options. |
| Remembered defaults | [`internal/server/hire.go:256`](../../internal/server/hire.go#L256) prefers a valid floor default, then last hire. [`internal/store/settings.go:128`](../../internal/store/settings.go#L128) persists last hires, while [`internal/server/settings.go:169`](../../internal/server/settings.go#L169) applies floor default settings. Visibility must resolve locally without rewriting these stored values. |
| Personal Settings | [`game/src/ui/settings.ts:27`](../../game/src/ui/settings.ts#L27) explicitly labels browser vs bridge storage. [`game/src/ui/settings.ts:105`](../../game/src/ui/settings.ts#L105) provides section registration. [`game/src/app.ts:346`](../../game/src/app.ts#L346) registers browser and bridge sections; [`game/src/ui/hirePrefs.ts:18`](../../game/src/ui/hirePrefs.ts#L18) is the existing guarded localStorage/listener pattern for a personal hire preference. |
| Render invalidation | [`game/src/ui/hire.ts:511`](../../game/src/ui/hire.ts#L511) memoizes rendering by form/status/limits inputs. A visibility preference change must invalidate this key and reconcile selection; changing only the model array will not reliably redraw an open dialog. |
| Other pickers | [`game/src/ui/startRun.ts:487`](../../game/src/ui/startRun.ts#L487), [`game/src/ui/presets.ts:209`](../../game/src/ui/presets.ts#L209), and [`game/src/ui/panels.ts:986`](../../game/src/ui/panels.ts#L986) use the same catalog. Keep these outside the initial hire-dialog scope; avoid modifying shared `modelsFor` or `store.hireOptions` in a way that silently affects them. |

## Recommended semantics

- Persist an exact-slug denylist keyed by harness, for example `{ codex: ['older-model'], claude: ['older-model'] }`. An absent/empty list means all discovered models are visible. Newly discovered models therefore appear automatically, leaving their retention to the user.
- Hide means omitted from this browser's hire model chooser, not forbidden by the bridge. Preserve the full discovery catalog, server validators, pricing, existing workers, saved presets, and floor defaults.
- Derive a hire-specific visible catalog by filtering model arrays in their existing order. Preserve model effort metadata and resolve the selected model and effort against the visible choices, including prepare results and reviewer prefills.
- Keep unknown/disappeared hidden slugs in storage across catalog refreshes. Never intersect the persisted denylist with today's catalog during load/save. If a model returns later, it remains hidden until explicitly restored.
- Settings shows a checkbox per discovered model under Claude Code and Codex, with explicit wording such as “Show in the hire dialog.” Include visible/total counts and “Show all” per harness. Add search for long lists. No manual slug typing is required.
- Show persisted hidden slugs missing from the current catalog as “Not in the current catalog,” with a restore/remove action; this makes preserved preferences discoverable. Catalog absence must not manufacture selectable launch models.
- If a remembered/default/prefilled model is hidden, select the first visible model in the same harness and re-resolve effort. Do not claim that the resulting choice is the floor default or last hire unless it matches the original prepared choice; consider a short explanation that the preferred model is hidden.
- Allow all models in a harness to be hidden. Keep its harness control reachable and show “All models for this harness are hidden” with a Settings link. Disable Hire until the user enables a model or chooses another harness; never restore a hidden model automatically. If all harnesses are empty, show the same actionable empty state. `resolveChoice` currently returns `null` for an empty selected harness and does not switch to another populated harness, so this behavior needs explicit handling.
- Preference changes apply on the next dialog open and to an already-open idle dialog, with selection reconciliation and render invalidation. Preserve the prompt, label, folder, and editor focus where possible. An already-submitted hire proceeds with its submitted arguments.
- Guard malformed/unavailable localStorage as existing preferences do. The setting applies across floors in this browser and survives reloads. Bridge-wide or per-user server persistence would require separate storage/protocol design and is a future scope choice.

## Suggested verification

- Pure preference/filter tests: harness isolation, exact matching, order preservation, all-visible default, new models visible, deduplicated persistence, missing hidden slugs retained, restore behavior, malformed storage, and storage read/write exceptions.
- Choice tests: hidden floor default, last hire and reviewer prefill fall back within the same harness; effort remains valid for the replacement model; all-hidden harness and globally empty options block submission rather than reviving hidden entries.
- DOM tests: keyboard-operable model checkboxes/search, raw catalog still visible in Settings, counts and unavailable rows, “Show all,” persistence after reload, filtered chips/grid thresholds, and empty-state Settings navigation.
- Hire regression tests: change visibility while open, invalidate cached rendering, suppress inaccurate “Floor default”/“Last hire here” notes, retain unrelated draft fields, and leave an in-flight hire untouched.
- Scope regression: raw `hire_options` remains unchanged; stored defaults/presets and other pickers retain their prior behavior; a model hidden locally is still valid through the bridge API.

No provider API change or new discovery mechanism is needed for this feature. No tests were run because this research adds documentation only.
