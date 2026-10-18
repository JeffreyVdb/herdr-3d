# Prompt-secret extraction: benchmark hardening

Investigated 2026-10-18 at `d24562ac5ec42ec9e9fa2a560683b5ff46ee73de` for
[#108](https://github.com/JeffreyVdb/herdr-3d/issues/108). Research adapters and
synthetic fixtures only; no product code, dependencies or behavior changed.

## Decision

The workflow is viable with mandatory user confirmation whenever a detector finds
candidate secrets. Show the complete original prompt with each occurrence
highlighted; let the user protect, ignore, correct or manually add individual
spans before explicitly confirming the send. This applies to high-confidence
pattern matches as well as model predictions. File handling then preserves the
approved exact values in private owned files with references and lifecycle
cleanup. A large resident model need not be a dependency of the first delivery.

The original pilot can be improved considerably, but fresh examples expose why
its headline score must not become the release gate. Source-backed tokenization,
span-width, runtime and fixture findings are in the
[follow-up source review](prompt-secret-followup-sources.md).

## Confirmed review interaction

Gate the entire feature behind an opt-in **Review prompt secrets before sending**
setting, off by default, persisted with the bridge's normal settings. When off,
use the existing prompt flow without feature scans, review, new secret files or
optional model loading/downloads. When on, all detected candidates use the review
flow below. Changing the setting invalidates affected pending confirmation;
turning it off during review returns to the in-memory draft without submitting.
Existing files keep their normal ownership/lease/cleanup lifecycle after disabling.

The user clarified the intended workflow after the benchmark investigation. On
Send, scan locally before AI preprocessing or raw persistence. Any findings open
a dedicated review screen containing the entire original prompt, preserving
Unicode, whitespace and newlines. Highlights show proposed exact value boundaries;
they are interactive by keyboard and touch, with visible protected/ignored states.
Navigation between matches must not replace the full-prompt view with snippets.

Each occurrence starts proposed for protection, pending the final confirmation.
Selecting a highlight offers **Ignore this occurrence**, **Protect as file**, and
boundary correction; ignored matches can be restored. Repeated identical values
remain independently controllable. Ignore applies only to that occurrence in
the current prompt revision, never a global allowlist. Ignored text remains
unchanged plain text when the user confirms. The screen also supports manual
marking of missed values and shows how many occurrences will be protected/ignored.
It must remain possible to confirm with every match ignored.
Materialization uses the reviewed ranges, never global string replacement that
would also rewrite an explicitly ignored copy of the same value.

**Confirm and send** applies the reviewed decisions and creates files only for
approved spans. Cancelling returns to the in-memory draft without submitting or
creating retained files. Removing the final protected match never auto-submits.
Prompt edits or changed findings invalidate stale confirmation; a late model
result or retry cannot apply new replacements behind the user's back. A completed
scan with no matches follows the normal send path without an empty review screen.
Routes without the review screen must return a review-required state when they
find candidates, rather than bypassing the gate.

The original prompt and review choices remain in memory during review. After
confirmation, protection guarantees cover the approved spans; explicitly ignored
candidates are ordinary text under the normal submission/persistence rules.
No raw review text may reach an external LLM, AI preprocessing or durable storage
before confirmation. Afterwards every approved occurrence is replaced; an
explicitly ignored copy of the same literal remains plain text by user choice.
Subsequent credential consumption and cleanup retain the requirements below.

Confirmation changes detector evaluation: false positives become review and
correction effort, so a broader contextual candidate layer may be viable even
though it fails unattended-extraction criteria. Measure findings/false highlights
per prompt, boundary corrections, review completion time and latency alongside
recall and exact bytes. The benchmark results below have not changed and include
no measured review usability. Confirmation does not fix missed values, incomplete
spans or scan truncation; manual marking and exact-byte validation remain needed.

## What improved, and where it breaks

The original pilot has 54 prompts, 36 secret occurrences and 22 clean prompts.
Exact precision counts a span as wrong if it drops a character **or** includes
extra text. The following comparisons use that same pilot:

| Configuration | Exact | Precision | Clean prompts flagged | Short p50/p95 |
| --- | ---: | ---: | ---: | ---: |
| Original Gitleaks + GLiNER2, .7 | 30/36 | 68.2% | 8/22 | Original components only |
| Gitleaks + exploratory structure rules | 34/36 | 100% | 0/22 | 0.22/1.42 ms combined |
| Structure/Gitleaks + GLiNER2 with literal-value descriptions, .7 | 35/36 | 83.3% | 7/22 | Model component 220/280 ms |

The disposable structure probe handles assignment/quoted values, bearer headers,
URL credentials/query values, PEM/fenced multiline values and limited English/Dutch
prose. It prefers structural spans to overlapping candidates and repeats known
literals. It was developed against this pilot: 34/36 is a **development result**,
not evidence of production precision. Both bare unlabeled pilot values are missed.
The described model adds the bare token but misses the complete bare password.
The replayed hybrid has no partial-only overlap on this pilot at .7.

After freezing the recognizer at SHA-256
`b5e774ccda42dd5f56b6e13dfe6c2e730493d1f1b74329473741a64fcbcc41d3`,
a fresh challenge was authored: 138 prompts, 84 secret occurrences, 60 negatives,
35 positive families and 30 negative families. Same investigator, repeated
templates, synthetic values: this is **not an independent production holdout**.
An annotation error that labeled an incidental occurrence of the word `password`
was corrected using explicit inserted slots; recognizer rules were not changed.

The frozen Gitleaks/structure probe drops to **62/84 exact (73.8% recall), 76.5%
precision, 16/60 clean prompts flagged and two partial-only overlaps**. Template
references, redaction placeholders, function expressions and prose such as “the
secret is 42 lines long” produce false positives. Escaped quotes and a meaningful
trailing dot produce partial extraction. Blanket placeholder exclusions miss
real weak passwords such as `example`; uppercase and dollar-prefixed real values
also fail. French/Spanish prose, unlabeled tokens, YAML blocks and recovery codes
remain gaps. These are recorded failures, not fixes hidden in the challenge.

Adding the described GLiNER2 at .7 increases challenge extraction to 75/84, but
precision falls to 46.3%, with 59/60 clean prompts flagged and three partial-only
overlaps. Each challenge negative includes an appended nine-character generated
request ID. This is an adversarial identifier stressor shared across templates;
the 59/60 rate must **not** be presented as a representative real-world rate.
A paired ablation removes only that metadata and deduplicates the clean templates:
the unchanged .7 model still flags **15/30** clean texts, or **18/30** combined
with structure rules (the pattern rules alone flag 8/30). At .9 the raw model
still flags 11/30. One unchanged positive anchor is included only to keep the
shared recall evaluator defined. No rules, model/schema or thresholds were tuned
from this check. Both the identifier sensitivity and ordinary clean-text errors
prevent automatic deployment at these measured operating points.

## CPU inference experiments

CPU-only i7-10750H, four PyTorch/ONNX intra-op threads, ONNX inter-op one,
three repeats per prompt (pattern probe five). Models ran sequentially, but this
is still a shared workstation and the original pilot had more interference.
Latency comparisons are indicative, not deployment SLAs.

| Model configuration | Pilot exact at .5 | Clean flagged | Short p50/p95 | Peak process RSS |
| --- | ---: | ---: | ---: | ---: |
| Original PyTorch GLiNER PII small | 24/36 | 16/22 | 77/230 ms | 1.13 GiB |
| Edge ONNX float32 | 25/36 | 17/22 | 16/25 ms | 829 MiB |
| Edge published ONNX UINT8 | 3/36 | 3/22 | 13/23 ms | 540 MiB |
| Small published ONNX UINT8 | 21/36 | 16/22 | 32/67 ms | 635 MiB |

The float32 edge checkpoint is a useful low-latency **suggestion** candidate; it
does not improve clean-prompt precision. The published UINT8 export loses most
recall at the same threshold. At .3 it recovers 16/36 but flags 15/22 clean prompts.
At .7 it predicts no pilot secrets. A smaller download must not be presented as
an equivalent detector without calibration and export-equivalence checks. The
float32 and UINT8 edge runs use the same labels, model revision and chunking.
The original small PyTorch comparison changes both checkpoint/runtime; no speedup
is attributed solely to quantization. ONNX process RSS includes the Python,
PyTorch and Transformers imports used by this adapter.

The small UINT8 export is also faster than the earlier small PyTorch measurement,
but it extracts 21/36 at .5 rather than 24/36; it offers no clean-prompt improvement.
At .7 it extracts 11/36 and flags 6/22 clean prompts. On the new challenge its .5
raw predictions flag all 60 clean prompts. These runtimes are usable for optional
suggestions, but the measured accuracy prevents automatic deployment.

GLiNER2's five-label 128-word/32-overlap/batch-one configuration takes about
4.69 s on the 8,644-byte input and 9.13 s on the 17,064-byte input (medians of
three). The previous 384/64/default-batch follow-up took 6.6/10.8 s once; the
unchunked run took roughly 44–50 s on the largest input. Narrowing to three labels
with 384/64/batch-one measured about 3.74/7.50 s. These are configuration bundles,
not isolated proof of which knob caused the timing difference. Cold load remains
about 10.5–11.4 s and peak RSS about 2.86 GiB. Model residency and asynchronous,
bounded work remain necessary if GLiNER2 is used.

## Corrections and acceptance cases

- The original provider group contains 11 credential-like occurrences; it does
  not demonstrate 11 format-valid provider keys. The generated OpenAI project key
  lacks the dedicated scanner grammar's marker/length, and the generated HF key
  allows digits where that grammar expects letters. Generic rules detected them.
- Gitleaks 8.30.1 detects a fresh grammar-valid HF token at end-of-input, before
  whitespace, quotes and semicolons, but misses that same value before a period,
  comma or right parenthesis. Prefix recognition alone is not prompt coverage.
  [Pinned scanner grammar](https://github.com/gitleaks/gitleaks/blob/v8.30.1/cmd/generate/config/rules/huggingface.go).
- GLiNER2's atomic HTTP URL tokens and this checkpoint's `max_width=8` rule out
  some exact raw model spans regardless of threshold. Validate a separate
  structural boundary stage. [Pinned tokenizer/config sources](prompt-secret-followup-sources.md).
- `internal/herdr/term.go` currently limits worker prompts to 16,384 bytes; the
  17,064-byte pilot is an over-limit stress case. Additional probes place a quoted
  password at the beginning, middle and end of a prompt of exactly 16,384 bytes.
  The pattern/structure probe extracts each exactly, taking roughly 11–12 ms
  including Go-helper IPC in five repeats. This is not an integrated send test.
- Source-span coordinates cannot by themselves specify JSON/shell unescaping or
  URL percent decoding. Before enabling each format, define what exact file bytes
  mean for that syntax. Manual selection preserves selected plaintext bytes.
- Deterministic overlap preference is also fallible: a wrong structural span can
  suppress an otherwise correct model result. Compare before/after resolution.

## Implementation gates to put in the ticket

1. Gate the feature behind the persisted setting, off by default. When enabled,
   deliver one sanitizer boundary before AI preprocessing and persistence, with
   memory-only raw drafts, manual selection/correction, owned files/references,
   retries and lifecycle cleanup. Define “local” as bridge-host inference and no
   external detector/provider verification. Preserve the existing permission,
   symlink, ownership and failed-send requirements.
2. Require the full-prompt confirmation screen for every detected match, including
   validated provider patterns. Keep per-occurrence ignore/restore and boundary
   correction, explicit final send, revision-bound decisions and manual marking.
   Validate the syntax byte policy per family. Do not promote this disposable
   regular-expression probe to production.
3. Require a separately authored evaluation corpus and a substantially larger
   clean set before expanding candidate coverage. Freeze rules, model, schema,
   thresholds and overlap policy before evaluation; report every partial leak,
   unsupported case, per-family precision/recall and prompt-level false positives.
4. Set and measure bridge-hardware p95/RSS/cold-start/concurrency budgets before
   choosing a model. Measure current accepted input bounds, all chunk boundary
   positions and subword limits; never silently truncate or forward after a failed
   mandatory scan. Compare the complete pipeline, including IPC and startup.
5. Define the initial guarantee as replacing **user-approved secret occurrences**
   in supported initial/follow-up model inputs and persistence, respecting ignored
   occurrences even when literals repeat. Safe later
   consumption needs a concrete harness/tool path that injects bytes without
   returning them to the model. Arbitrary shell access, other same-UID workers and
   unrestricted output cannot be protected merely by a private file. A stronger
   end-to-end claim is blocked on that design, not solved by detector accuracy.

## Artifacts and reproduction

[Benchmark README](prompt-secret-bench/README.md),
[frozen challenge manifest](prompt-secret-bench/followup/challenge-manifest.json),
[verified summary and per-family results](prompt-secret-bench/followup/summary.json),
[delimiter/accepted-limit probe](prompt-secret-bench/followup/boundaries.json).
All new adapters and raw outputs live under `prompt-secret-bench/`; model files
and added Python packages stay in the temporary benchmark environment/cache.
Raw outputs contain synthetic credential values; never run these diagnostic
report writers on real secrets.

`summarize_followup.py` checks corpus hashes, span bounds, stored metrics and the
unchanged frozen recognizer, and replays model unions using that frozen version.
An early window experiment records an earlier probe hash; its raw inference is
retained and the summary explicitly recomputes its current union. Model-union
latency is not measured as a combined pipeline. Memory uses Linux `/proc` VmHWM;
`ru_maxrss` fields are retained only for diagnosis because launcher history can
inflate them. Source notes and earlier pilot reports are retained for provenance.
