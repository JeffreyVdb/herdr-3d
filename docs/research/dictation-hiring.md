# Dictation command bar and background hiring

Investigated 2026-10-09 in worktree `h3d-scone-09ac3d`. This is research and a ticket specification; production code is unchanged. [Repository seams and background-hiring details](dictation-hiring-architecture.md).

Created [ticket #209](https://github.com/JeffreyVdb/herdr-3d/issues/209) covering the command bar, required effort dialogue and background-hiring setting.

Latest user requirement: every dictated hire must pass through a populated, editable human review dialog before launch. Missing fields open for selection; resolved values appear in collapsed accordion summaries and remain overridable. Background hiring starts only after explicit confirmation.

## Recommendation

Use the configured LLM for one structured intent-and-field interpretation, followed by deterministic validation and a small pending-hire dialogue. The current configuration is `anthropic/claude-haiku-5.5` through OpenRouter. Keep the feature behind the existing `ai.LLM` interface. Do not introduce another provider, a speech engine, a general agent planner or arbitrary tool execution. The existing Jev client remains available for future evaluation, but a mandatory Jev gate adds a call and rejected valid examples in these experiments.

Interpretation proposes values for review. Neither a complete parse nor a follow-up answer can directly authorize a launch.

Accept text supplied by Wispr Flow in a native text field. Its vendor documents support for text fields in apps and websites; actual insertion/focus behavior in the game's Mac browser still needs manual testing. [Wispr Flow features](https://wisprflow.ai/features).

Jev evaluates predefined typed decisions, rather than generating open-ended text. It can classify hire/other/unclear or select among catalog entries, but flexible task extraction still needs the LLM or a deterministic grammar. Its Noul API supports independent questions in one request; the existing bridge already implements that. This makes a combination technically possible, but does not make it preferable for this small feature. [TypeSafe System One](https://docs.typesafe.ai/concepts/system-one), [Noul API](https://docs.typesafe.ai/primitives/noul), [existing bridge client](../../internal/ai/jev.go).

## Live model experiment

The research harness calls the real configured providers through `internal/ai`, reads the live bridge's hiring catalog over its Unix-socket WebSocket, interprets synthetic dictated commands, validates the catalog tuple and missing fields, and records dry-run launch decisions. Credentials remain in the existing private configuration; neither provider settings nor the running bridge were changed. Only model/usage/status metadata and synthetic examples are saved. Both roles use the bridge's existing timeout/retry/concurrency policy; the LLM uses its configured provider-default reasoning, not an effort override for the hired worker.

**Scope:** end-to-end interpretation and validation with live providers, dry-run launch decisions. This does **not** verify Wispr recording, a new browser bar, an actual `worker.hire`, Claude/Codex startup, focus restoration, or the requested beep/toast. Those interactions require implementation and subsequent browser/real-harness tests. Both providers were called for every sample so their answers could be compared; observed individual call times are not measurements of an optimized, routed hybrid.

The benchmark's historical `ready` label means the interpreted fields are complete and valid. Under the updated requirement, this is **ready for review**, not a launch trigger. The model experiment remains relevant; the mandatory review UI and confirmation still need implementation tests.

84 paired samples were run: an exploratory 34-case pass, a revised pass on the same 34 cases, and 16 fresh cases after the prompt was fixed. The latter two are 50 distinct examples, not 84 independent examples. No transport/provider errors occurred. Jev reported resolved model `jev-1.13.0`; the configured alias is `jev-latest`. The LLM reported `anthropic/claude-haiku-5.5`.

| Evaluated strategy | Revised suite (34) | Fresh suite (16) | Combined (50) |
| --- | --- | --- | --- |
| LLM interpretation + catalog validation, expected outcome **and exact task** | 34/34 | 16/16 | 50/50 |
| Practical hybrid: Jev positive hire gate, deterministic pending-dialogue bypass, LLM extraction/validation | 33/34 | 14/16 | 47/50 |
| Jev strict two-question intent classification (`hire >= .9`, `other <= .1`, converse for other; else unclear) | 28/34 | 10/16 | 38/50 |

The third row measures intent classification only; Jev alone is not a complete free-form hiring pipeline. The revised practical hybrid no longer requires the other-action score to be below .1 when hire exceeds .9, and it bypasses Jev for pending clarification replies. It still blocks the research phrase and a clear unsupported command containing parser-injection text. These are conservative failures, not accidental launches. The gate could be tuned further; these results support choosing the simpler LLM path, not a universal claim about Jev's accuracy.

The exploratory LLM pass classified all 34 intents correctly, but omitted final task punctuation in five examples and treated one self-corrected effort as ambiguous. The revised prompt explicitly requires full source punctuation and applies the last explicit self-correction. Both fixed examples and fresh cases then passed. Baseline outputs retain the exploratory evaluator, which used golden task equality to block a `ready` decision. The final harness instead validates task containment against the original utterance/history and records golden equality separately. Golden labels are test expectations, never a product decision input.

Observed median latency: revised Jev **247 ms**, LLM **2,039 ms**; fresh Jev **226 ms**, LLM **2,300 ms**. Approximate sample p95: revised Jev 326 ms, LLM 2,733 ms; fresh Jev 419 ms, LLM 2,832 ms. These are small single runs, include network/provider variation and possible shared-slot wait, and cannot establish production latency guarantees. The background-hiring option hides launch readiness waiting; interpreting dictated prose still takes a model call.

OpenRouter reported LLM costs of **$0.0107301** for the revised 34 and **$0.0053715** for the fresh 16, approximately **$0.00032 per interpretation**. Jev used 23,550 input tokens for those 50, approximately **$0.00099 total** at the documented $0.042/M input-token rate. The latter is an estimate, not a billed amount. All three passes used about $0.0269454 reported LLM cost plus $0.00166 estimated Jev cost. The LLM includes the whole live catalog in the prompt; caching/pruning could change costs. [TypeSafe pricing and moving aliases](https://docs.typesafe.ai/models); provider-reported LLM usage is preserved in the result artifacts.

All five requested phrases passed in the fresh LLM suite with concrete task/model/effort selections:

- “Spawn an agent.”
- “Hire an agent.”
- “Let an agent research this for me.”
- “Hire a worker.”
- “Spawn a worker.”

They are intent examples, not mandatory syntax. A bare “Spawn an agent” correctly identifies hiring while asking for missing details. Also tested: missing effort, task-internal effort words, follow-up high/ultra, supported `extra high` alias, unsupported effort, contradictory/unknown model, missing task, multiple hires/actions, existing-worker commands, negation, history, hypothetical requests, quoted instructions, and commands inside the actual task. No tested unsupported/unclear/missing-effort case produced a `ready` decision. Fifty successful cases do not prove future commands safe or establish probability calibration.

The live launch catalog lists Claude Haiku 5.5 as `claude-haiku-5-5` with low/medium/high/xhigh/max, and GPT-6-Sol/GPT-6.1-Sol with an extra ultra effort. This is the **launch catalog**, separate from the parser LLM's OpenRouter catalog. Read the current launch catalog for every pending hire; do not freeze these IDs or effort lists in product code. The user's illustrative “Claude on GPT-5.5 Haiku” is contradictory and correctly asks for clarification rather than silently correcting it.

## Product behavior

Use a distinct natural-language mode/bar with mouse access and shortcut access. Ordinary palette fuzzy matching must not dispatch unrelated existing actions for dictated prose. Enter interprets the text, Shift+Enter can preserve task line breaks, and composition-aware input keeps dictation/paste stable. A small state machine is sufficient: editing → interpreting → review (including missing-field selection) → explicit confirmation → submitting → detached/pending or interactive → completion/error. Keep one pending hire per bar dialogue; unrelated independent hires can launch on other reserved-free desks.

Separate clear hire intent from completeness. Clear other game actions show “Not supported yet.” Ambiguous/negated/historical/quoted intent shows “Your intent is unclear.” Every clear hire opens the same editable review dialog, including a fully specified request. Missing or conflicting fields open for correction. Missing effort **always asks before launch**, even if existing floor settings/defaults name an effort. A task that merely contains the word “high” or “effort” does not select the worker's effort. A dictated reply like “high” applies to the pending hire, preserves its original task and validates against the selected model; it updates the review and emits zero hires. A standalone effort reply cannot hire. Cancel clears the pending request without launch.

Use accordion sections with resolved values visible in collapsed summaries and missing/invalid fields expanded. Support inspecting and overriding harness/model, selecting effort, editing the full task, and reviewing floor/desk and applicable folder/label/worktree values. Show which values were dictated, resolved, or supplied by context/defaults. Allow multiple sections open so selecting effort does not prevent changing the model. A model/harness change refreshes supported efforts: retain a valid explicit effort, or clear an incompatible effort and expand it for reselection. Preserve the task and other valid choices; late responses must not overwrite human edits.

Enable the final Hire action only when all required values are valid. The complete dialog presents all final values and requires explicit human confirmation. Completing a field, replying by dictation, or pressing Enter to submit a clarification cannot launch automatically. Reuse the existing populated Hire dialog where practical, extending it with dynamic sections rather than adding a separate second review.

For the smallest conservative first version, ask for a missing harness/model/task rather than inventing a selection. This is a recommendation, not an extra user requirement; if existing floor defaults are later used for omitted harness/model, show the selected tuple and retain the unconditional missing-effort follow-up. Unknown/contradictory explicit selections must never pass through permissive UI fallback helpers. Revalidate model/effort, floor, desk, capacity and prompt at the existing server boundary. Treat malformed/truncated/provider failures as errors, with no spawn. A future implementation should use a strict schema and validated source spans for task preservation; the experimental harness is not production-ready validation code.

Add a persisted browser-local **Hire in background** setting alongside the existing “Go to a new hire after hiring” preference, default off. In background mode, explicit Hire confirmation of the completed review reserves its desk and snapshots the final reviewed args/draft/mode, then immediately closes the dialog/bar and returns control. This setting never skips review. Launch/upload/readiness/prompt delivery continue through a shared coordinator. It never transitions to the new laptop, including after completion. When the final successful hire ack arrives, show **“Agent spawned successfully.”** and one short UI beep respecting mute/volume. Do not create an inbox item for spawn confirmation. Normal task/question inbox behavior remains independent.

The server already runs `runHire` asynchronously and sends the final ack after startup and prompt delivery. Reusing the existing final ack is enough for the basic UX; it must not be awaited by the visible dialog. Errors release the operation's reservation, retain its draft and show a direct toast. `prompted:false` means the worker exists but task delivery failed: report that partial outcome and preserve the task rather than encouraging a second spawn. Disconnect/timeouts have an unknown outcome and must not automatically relaunch; durable across-reload notification would require a separate recoverable operation protocol and is not necessary for this initial setting. [Async architecture and citations](dictation-hiring-architecture.md#configurable-background-hiring-added-user-scope).

## Artifacts and reproduction

- [Harness](dictation-hiring-bench/main.go), [34 labeled cases](dictation-hiring-bench/samples.json), [16 fresh cases](dictation-hiring-bench/holdout.json).
- [Exploratory results](dictation-hiring-bench/results-baseline.json), [revised results](dictation-hiring-bench/results-refined.json), [fresh results](dictation-hiring-bench/results-holdout.json), [revised prompt](dictation-hiring-bench/prompt.txt), [exploratory prompt](dictation-hiring-bench/prompt-baseline.txt).

From the repo root, with the existing configured bridge/providers:

```bash
go run ./docs/research/dictation-hiring-bench -out /tmp/dictation-revised.json
go run ./docs/research/dictation-hiring-bench -samples docs/research/dictation-hiring-bench/holdout.json -out /tmp/dictation-fresh.json
go vet ./docs/research/dictation-hiring-bench
```

The private config/socket defaults can be overridden using `-config` and `-socket`. Do not point credentials at an untrusted endpoint. Results may vary with provider changes and moving aliases. The revised artifact predates the independent source-containment check; all its labeled tasks were exact, so that check does not change its outcomes. The fresh artifact uses the final source check. `-prompt` and `-routing v1` replay the exploratory prompt/routing with the **final** evaluator, not the original golden-aware guard.
