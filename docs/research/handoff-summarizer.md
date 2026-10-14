# Handoffs written by the configured LLM: the quality and size spike

#9, part 3 of #3. The bridge can have the AI integration's LLM write a handoff from a worker's reduced, scrubbed
transcript ("Use configured LLM", `docs/protocol.md` "LLM handoffs", `docs/decisions.md` "#9"). This page is how we
decide whether that is good enough to recommend, and what it costs.

**Go/no-go: pending — the feature ships off by default; the spike (paid, run by the user) decides rollout.**

No paid model call has been made yet. What is here: the method, the rubric, the billing assumptions, the dry-run
reduction numbers on real local sessions, and an empty results table.

## What is compared

For each session, two handoffs of the same snapshot (the transcript up to the same completed reply):

1. **Native**: the worker's own agent with its `handoff` skill ("Ask the agent", #224), or the skill run by hand in
   that session when the worker is gone.
2. **Configured LLM**: `cmd/handoff-spike --send` (the bridge's own reducer, prompt `h3d-handoff-llm-1`, bounds and
   validation; the same code path as the dialog), with the model under test. Run it with two models where the budget
   allows: a cheap fast one and the premium one the worker used.

## Sessions (about five, authorized by their owner)

Pick sessions you may send to the endpoint under test (their content leaves the machine, scrubbed by pattern only):

| # | Harness | Why it is in the set |
|---|---|---|
| 1 | Claude | long (100+ messages), no compaction |
| 2 | Claude | compacted at least once (`isCompactSummary`) |
| 3 | Codex | compacted (`codex_retained` or `opaque`) |
| 4 | Codex or Claude | a failure in it: a red test, a reverted approach, a correction by the user |
| 5 | either | heavy tool evidence: many edits, test runs, commits or a PR |

## Method

1. Dry run first, nothing sent: `go run ./cmd/handoff-spike --json FILE…` (add `--budget` to try 48, 96 and 200 KiB).
   Record the payload, prompt and token estimates, kept/omitted, gaps and redactions per file.
2. Paid run, per session and model:
   `go run ./cmd/handoff-spike --send --base-url URL --model M --key-file F --out DIR FILE` (optionally `--focus`,
   `--max-tokens`). It records the answer's size, latency, validity and the provider's reported usage
   (`prompt_tokens`, `completion_tokens`, `reasoning_tokens` in `diag`); the document goes to `DIR`.
3. The native handoff of the same snapshot, its time and (where the harness reports it) its token use.
4. Score both blind (strip the provenance, shuffle) against the rubric below; note every failure condition hit.

## Rubric (0–2 each; 2 = complete and correct, 1 = partly, 0 = missing or wrong)

| Criterion | What earns a 2 |
|---|---|
| Goal and constraints | the original goal and every constraint the user set, including later corrections, stated exactly |
| Artifacts and files | the files, branches, commits, PRs, issues and specs that matter, referenced rather than restated |
| Decisions and reasons | each real decision with its reason; abandoned approaches said as abandoned |
| Completed vs unverified | what was done and shown to work apart from what was only attempted or is unverified |
| Tests and failures | the test runs and their outcomes, the failures still open, as the transcript shows them |
| Open questions | the questions left for the user or the next agent |
| Next steps | concrete, ordered, actionable steps |
| Suggested skills | only skills the transcript evidences or the bridge supplied as available |

**Failure conditions** (any one fails the handoff, whatever its score): it fabricates success (says a test passed, an
edit landed or a PR exists without evidence); it loses a critical decision or constraint; it invents a skill, a file
or an artifact; it carries a secret through.

**Proceed** only if, over the set, the configured-LLM handoffs hit no failure condition and score within about 2
points of the native ones per session, and the cost and latency below are acceptable. Otherwise keep the feature off
and say why here. Map-reduce (several calls per handoff) is in scope only if measured context limits force it; there
is no extra call by default.

## Billing assumptions

- The summarizer's first read is **cold**: a different model, account, provider or system prefix does not reuse the
  worker's cached conversation (`docs/research/handoff-cache.md`). Repeated requests with the same stable prefix may hit
  the provider's own cache; success does not depend on it.
- The cheap model is not necessarily the cheapest handoff: a warm cached read on the worker's premium model can cost
  less than a cold read on a cheap one, and output, reasoning and cache-write tokens are billed too.
- Subscription quota (Claude Code, ChatGPT-signed Codex) is not API dollars; "Ask the agent" spends the worker's
  quota, this feature the configured endpoint's.
- The input estimate is `ceil(asciiBytes/3) + nonASCIIRunes` (`handoffllm.EstimateTokens`), deliberately high; the
  provider's `prompt_tokens` is the measurement. Record both.

## Dry-run reduction numbers (no content, nothing sent)

Coder A's sanity run (read-only, stats only): about 200 Claude and 110 Codex main sessions reduce at 48, 96 and 200 KiB
with zero refusals (`too_large`) and nothing skipped; only Codex subagent rollouts are refused, by design. All three
local Claude compactions seed from their summary; 30 compacted Codex rollouts read as `codex_retained`, no gaps. The
largest Claude file (118 MB) reduces in about 0.6 s, the worst Codex one (26 MB) in about 2.8 s.

`cmd/handoff-spike` on eight of the largest local sessions (2026-10-14; payload = reduced transcript; prompt tokens =
the whole request's estimate):

| Harness | File | Budget | Payload | Est. prompt tokens | Kept / messages | Omitted runs | Compaction | Reduce |
|---|---|---|---|---|---|---|---|---|
| Claude | 4.7 MB | 48 / 96 / 200 KiB | 27.8 KB (all) | 10.5k | 85 / 85 | 0 | none | 0.08 s |
| Claude | 6.2 MB | 48 / 96 / 200 KiB | 43.8 KB (all) | 19.2k | 104 / 104 | 0 | none | 0.3 s |
| Claude | 9.4 MB | 48 / 96 / 200 KiB | 19.3 KB (all) | 7.5k | 44 / 44 | 0 | none | 0.13 s |
| Claude | 121 MB | 48 KiB | 48.7 KB | 17.1k | 106 / 106 | 2 | none | 0.6 s |
| Claude | 121 MB | 96 / 200 KiB | 66.5 KB (all) | 23.0k | 106 / 106 | 0 | none | 0.6 s |
| Codex | 29 MB | 48 / 96 / 200 KiB | 12.4 KB (all) | 5.2k | 16 / 16 | 0 | none (1 gap) | 0.35 s |
| Codex | 27 MB | 48 KiB | 49.1 KB | 18.4k | 115 / 191 | 17 | codex_retained | 2.9 s |
| Codex | 27 MB | 96 KiB | 96.8 KB | 34.2k | 191 / 191 | 11 | codex_retained | 2.9 s |
| Codex | 27 MB | 200 KiB | 204 KB | 70.2k | 191 / 191 | 21 | codex_retained | 3.1 s |
| Codex | 24 MB | 48 KiB | 49.1 KB | 17.9k | 167 / 466 | 35 | codex_retained | 1.5 s |
| Codex | 24 MB | 96 KiB | 98.1 KB | 34.1k | 355 / 466 | 28 | codex_retained | 1.4 s |
| Codex | 24 MB | 200 KiB | 205 KB | 69.4k | 466 / 466 | 16 | codex_retained | 1.5 s |
| Codex | 24 MB | 48 / 96 / 200 KiB | 45.9 / 97.3 / 155 KB | 17.0k / 34.1k / 53.1k | 82 / 82 | 7 / 8 / 0 | codex_retained | 2.4 s |

"Omitted runs" with every message kept are excerpts (tool output and older assistant detail cut inside a kept
message). Reading: Claude sessions shrink to a few tens of KB because their tool output is left out; long Codex
sessions fill whatever budget they get, and the 96 KiB default (about 34k estimated prompt tokens) keeps every message
of all but one of them. Smaller sessions (200–400 KB files) reduce to 0.2–24 KB. The default stays 96 KiB until the
paid run says the larger budget buys quality.

## Results (to fill)

| # | Harness | Model | Input tokens (est. / reported) | Output tokens | Latency | Cost (assumption) | Valid | Score LLM / native | Failure conditions |
|---|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | | |
| 2 | | | | | | | | | |
| 3 | | | | | | | | | |
| 4 | | | | | | | | | |
| 5 | | | | | | | | | |

Also record: whether the 90 s timeout (`handoffllm.Timeout`, provisional) held, and the largest output against the
4,096-token default completion budget.
