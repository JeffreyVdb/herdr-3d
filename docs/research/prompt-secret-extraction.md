# Local prompt-secret extraction into session files

Investigated 2026-10-18 on `d24562ac5ec42ec9e9fa2a560683b5ff46ee73de`.
Research and synthetic benchmarking only; no product behavior changed.
Ticket: [#108 — Extract prompt secrets locally into session-scoped files](https://github.com/JeffreyVdb/herdr-3d/issues/108).

## Conclusion

The file-reference workflow is feasible. A persistent Gitleaks detector is a good
high-precision first layer in this Go bridge. Credential-aware GLiNER models can
find more ordinary-language secrets, but none of the tested configurations is
ready for unconditional automatic extraction: partial values, extra surrounding
text, false positives and long-input behavior all need work. Use contextual
detection as a reviewed suggestion, retain explicit mark-as-secret,
and validate a held-out prompt corpus before expanding candidate coverage.
This recommendation follows the local measurements below, not vendor PII scores.

The user subsequently specified a mandatory full-prompt review whenever any
secrets are detected: highlight every occurrence, allow individual ignore/restore
and boundary correction, then require explicit confirmation before applying the
approved replacements and sending. High-confidence patterns also use this gate.
Repeated values are individually controllable; ignore applies only to the current
occurrence/revision. See the follow-up's confirmed interaction for the complete
flow and revised benchmark interpretation.
The entire feature is opt-in through **Review prompt secrets before sending** in
Settings, off by default. Disabled mode uses the existing prompt flow without
feature scans/review/new files or optional model loading. Turning it off during
pending review returns to the in-memory draft without sending; existing owned
files retain their normal lifecycle.

The [benchmark-hardening follow-up](prompt-secret-benchmark-followup.md) adds
structure/model ablations, ONNX measurements, a frozen-rule challenge corpus and
provider delimiter/accepted-input-bound tests. It supersedes the pilot's
unmeasured-ONNX status and narrows its provider-coverage claim.

The requested outcome is: paste a normal prompt, detect candidate values locally,
review the entire highlighted prompt, confirm which occurrences to protect,
write their exact bytes to private files on the bridge host, and send a prompt
such as `Use the API credential in this file: /run/user/<uid>/h3d-secrets/<owner>/<id>`.
Cleanup follows the owning agent session/run, with recovery for crashes. No manual
SSH, file creation or remembering filenames should be necessary.

## Measured pilot

[Benchmark methodology and reproduction](prompt-secret-bench/README.md),
[fixtures](prompt-secret-bench/corpus.json),
[raw reports and summary](prompt-secret-bench/summary.json).
54 synthetic prompts: 36 credential occurrences in 32 positive prompts, plus 22
clean prompts. Seeds, complete expected spans, revisions, thresholds, versions,
raw predictions and timings are saved. No real credentials were used or sent to
a verifier. This is a small diagnostic corpus, not an independent production
benchmark; no tuning/holdout split exists. Timings are indicative measurements
on a shared i7-10750H workstation, CPU only, four PyTorch threads.

| Detector | Exact extraction | Exact precision | Full-secret coverage | Clean prompts flagged | Short p50 / p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Gitleaks 8.30.1, persistent Go API | 18/36 (50.0%) | 100.0% | 18/36 | 0/22 | 0.16 / 0.74 ms |
| detect-secrets 1.5.0, entropy thresholds applied | 14/36 (38.9%) | 43.8% | 22/36 | 6/22 | 1.9 / 5.4 ms |
| GLiNER PII small, threshold .5 | 24/36 (66.7%) | 42.1% | 25/36 | 16/22 | 77 / 230 ms |
| GLiNER2 privacy PII multi, threshold .5 | 27/36 (75.0%) | 42.9% | 30/36 | 13/22 | 244 / 584 ms |
| Gitleaks + GLiNER2, threshold .7 | 30/36 (83.3%) | 68.2% | 31/36 | 8/22 | Union of the above detectors; no combined timer |

Exact extraction requires identical start/end boundaries. Full coverage permits
overbroad spans, which may hide all characters while writing a broken credential
to the file. It is therefore not interchangeable with successful extraction.
The union merges overlapping predictions without application-specific repairs;
threshold .7 is one measured sensitivity point, not a threshold selected on held-out data.
Both GLiNER model revisions and all three thresholds are in the raw reports.

Gitleaks found all 11 credential-like occurrences in the pilot's provider group,
including both members of the AWS pair. This is not 11 format-valid provider
keys: the OpenAI/HF generators do not match their dedicated scanner grammars,
and generic rules detected them (see the follow-up). It missed ordinary passwords, unknown prose tokens and
some URL credentials. Its CLI and persistent Go helper produced identical
predictions. Starting the CLI per prompt cost roughly 907 ms p50 / 1,365 ms p95;
the persistent helper compiled default rules once in 39 ms and used about 39 MiB
peak child RSS. The Go API is the practical integration route; per-prompt CLI
startup would misrepresent its scanning cost.

The small model added ordinary-language extraction but also treated benign
references, example placeholders and code as secrets. Higher thresholds traded
recall for precision; at .7 it still flagged 9/22 clean prompts and extracted
18/36 occurrences exactly. Raw model spans sometimes dropped password punctuation,
split Unicode passwords, or included the next assignment's name. GLiNER2 at .7
still predicted only `Saffron8` for `Saffron8!` and split a multiline value into
two independently matched lines. Both errors break the requested file contents.

Default long-input results were materially worse for latency than the short
numbers imply:

| Detector | 8,644-byte prompt | 17,064-byte prompt | Whole-process peak RSS |
| --- | ---: | ---: | ---: |
| Persistent Gitleaks | about 4 ms | about 18–20 ms | about 39 MiB (Go child) |
| detect-secrets | about 69 ms | about 134 ms | about 31 MiB |
| GLiNER PII small | about 3.8–6.2 s | about 4.3–6.4 s | about 1.13 GiB |
| GLiNER2 privacy PII multi, default API | about 10.8–12.6 s | about 43.7–49.9 s | about 5.74 GiB |
| GLiNER2 documented long API, single-repeat follow-up | 6.6 s | 10.8 s | about 2.86 GiB |

The small model warned that it truncated 3,323 word tokens to 2,048 and missed
the final credential in the longest prompt. GLiNER2's default API covered both
long-tail values but its full-window cost is unsuitable for this feature. Explicit
chunking, overlap handling and no-silent-truncation checks are required. RSS includes
the interpreter, dependencies and the largest input, not just model weights.
The CLI Gitleaks run inherited historical rusage peaks from the chained runner;
its RSS fields are not used for conclusions.

The documented GLiNER2 chunked API reduced the long-input cost, but it still took
seconds and changed one long-tail prediction at thresholds .5/.7. Its .7 hybrid
extracted 29/36 exactly, with 30/36 fully covered and the same 8/22 clean prompts
flagged. Chunking is necessary engineering work, not an automatic accuracy fix.
Cached model imports/load took about 12–14 seconds, so an eventual model must stay
resident rather than start with each prompt. The follow-up used one repeat and
default 384-word windows/64-word overlap; there was no parameter optimization.

## Candidate viability beyond the measured set

The [primary-source review](prompt-secret-detectors-sources.md) covers licenses,
span APIs and alternatives. Gitleaks is MIT. Both tested model cards and
detect-secrets are Apache-2.0. Presidio is an MIT recognizer framework that can
compose regex and GLiNER, rather than a separate credential detector. TruffleHog
has broad provider coverage but brings AGPL-3.0 distribution considerations and
must run without active verification. Those two were reviewed, not locally benchmarked.
[Gitleaks](https://github.com/gitleaks/gitleaks),
[small model card](https://huggingface.co/knowledgator/gliner-pii-small-v1.0),
[GLiNER2 privacy model card](https://huggingface.co/fastino/gliner2-privacy-filter-PII-multi),
[detect-secrets](https://github.com/Yelp/detect-secrets),
[Presidio](https://github.com/microsoft/presidio),
[TruffleHog](https://github.com/trufflesecurity/trufflehog).

Knowledgator publishes UINT8 ONNX artifacts of roughly 46 MB for edge and 83 MB
for small, so a lower-cost local deployment is plausible. Neither quantized
accuracy, edge-model accuracy nor ONNX performance was measured in the initial pilot;
the follow-up now measures edge float32/UINT8 and small UINT8. Smaller
download sizes do not establish reliable credential extraction or runtime RAM.
[Edge ONNX files](https://huggingface.co/knowledgator/gliner-pii-edge-v1.0/tree/main/onnx),
[small ONNX files](https://huggingface.co/knowledgator/gliner-pii-small-v1.0/tree/main/onnx).

## Integration findings

- `game/src/ui/drafts.ts` saves text and composer segments to browser localStorage.
  Sanitizing only on Send leaves earlier secret copies on disk. Secret-capable
  draft handling must become memory-only until safely transformed, or use a local
  pre-persistence detection path. Rewritten drafts must also clear old raw copies.
- `internal/server/packup.go` sends prompt text to an AI classifier before the
  final worker command. `internal/server/hireintent.go` sends dictated hiring text
  and pending proposal sources to the configured LLM. Sanitization must precede
  these calls; protecting only `h.prompt` is too late.
- `internal/server/input.go` queues worker prompts and handles answer routes;
  `hire.go` sends first prompts, while `launch.go` constructs previews, stores free
  text in `run_launch`, and sends edited/composed launch prompts. These routes need
  one sanitizer contract, including retries and failed hires.
- `translate.go` documents translated versus bridge-composed routes. Sanitized
  references need to survive harness translation without an `@file` expansion
  that automatically reads secret bytes into model context. Direct terminal input
  and existing remote transcripts are separate boundaries, not silently protected
  by a composer feature.
- Existing prompt audit helpers often store lengths rather than content; preserve
  that property. Audit labels, errors, SQLite launch records, notifications, AI
  roles, transcripts and returned prompt previews must receive text with approved
  secrets replaced. Explicitly ignored occurrences remain ordinary plaintext;
  the original full-prompt review is memory-only.

## File consumption and lifecycle

File references keep secret literals out of the initial prompt. A generic Read
tool or `cat` that returns file contents exposes them again to the model. Prefer
native file-consuming tool inputs or a narrowly scoped credential broker which
injects bytes in the tool process without returning them. Commands must avoid
echo, shell tracing and verbose credential output. Provider responses can also
echo credentials; output filtering is another boundary that plain files do not solve.

Create files outside repositories and shared Drop Zones under private runtime
directories (0700; files 0600, exclusive creation, no symlink following), with
random names containing no secret fragments. Preserve exact bytes, Unicode and
line endings; do not append a newline. Replace spans back-to-front after validating
offsets across Go UTF-8 bytes, Python characters and JavaScript UTF-16. Resolve
overlaps using deterministic format/structure boundaries rather than blindly
merging credentials or accepting overbroad model spans.

Mode 0600 protects against other Unix users, not other workers running under the
same UID. Bridge handles can enforce owner checks for bridge operations, but true
cross-worker filesystem isolation requires separate sandboxes/users or brokered
access. Do not advertise plain files as providing that isolation. Likewise, unlink
on termination is cleanup, not proof of secure erasure from SSDs, backups or swap.

Define the owner as an agent run/workspace, not the long-lived project/floor or an
idle turn. Keep files through idle/reconnect and supported resumes; revoke on real
termination or explicit user deletion. Delegated workers need explicit leases so
parent exit does not delete a child's still-needed credential. Failed sends,
cancelled previews and failed launches must release temporary files. Track only
ownership, expiry and opaque file IDs in persistence, with a startup/orphan sweeper,
bounded expiry and a visible expired-file state on resume. This is a proposed
design, not an implemented lifecycle guarantee.

## Work required for reviewed secret extraction

1. Improve exact-value extraction using structure-aware recognizers for PEM,
   authorization headers, credential URLs, assignment/quoted values and multiline
   blocks. Keep model detection distinct from deciding complete value boundaries.
2. Add an independent held-out prompt set, including a larger clean set, realistic
   provider token generations and adversarial boundary cases. Evaluate all
   operating thresholds, conflict resolution, chunk boundaries, language variants,
   cold/warm memory and latency on representative bridge hosts. Quantized edge/small
   are useful candidates if quality improves. Do not reuse this pilot as a holdout.
3. Build the mandatory full-prompt review screen with individually actionable
   highlights, ignore/restore, boundary correction, manual marking and explicit
   final confirmation. Show masked file chips after approved replacements.
   If local detection
   is unavailable or ambiguous, preserve text in memory and show an explicit state;
   do not silently forward the original to an external classifier or agent.
4. Integrate secure file consumption and owner-based cleanup end-to-end, with
   sentinel tests proving approved occurrences are replaced in prompts, tool output,
   drafts, logs, database records and notifications, with explicit ignore choices
   preserved even for repeated literals. Include retry/reconnect/crash recovery
   and both Claude/Codex prompt paths.
