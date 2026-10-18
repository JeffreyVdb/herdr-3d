# Frozen phase-1 evaluation targets

Declared 2026-10-18 before reading or executing the candidate detector. These are proposed pass/fail gates for the reviewed candidate workflow in issue #108, not measured results or promises of production coverage. All gates must pass independently; an aggregate score cannot erase a failing category. No detector, local detector rules, pilot corpus/generator/results, or feature worktree was inspected. The public provider grammar references are in sources.md.

## Denominators and exact-span recall

Evaluate occurrence-level exact half-open UTF-8 byte spans on all in-limit positive prompts. A target is met only by a candidate with both endpoints equal to the annotation. Count repeated literal values independently. Use one-to-one matching, so duplicate predictions cannot inflate recall; report duplicate candidates separately as review burden. Kind classification is diagnostic, not required to count an otherwise exact span. For each category report numerator, denominator, recall, full coverage, partial overlaps, overbroad spans, misses, and needed boundary corrections. Report macro family recall as well as micro occurrence recall; these related templates are not independent samples.

| Category | Exact-span recall gate | Reason |
| --- | ---: | --- |
| provider-valid | 100% | Known documented lexical grammars are baseline coverage, including legacy/current generations. |
| provider-malformed | >=90% | Explicit credential context still matters when a provider prefix or alphabet is invalid. |
| trailing-punctuation | 100% | Sentence delimiters must not defeat a known valid credential. |
| weak-password | 100% | Actual supplied weak values must not be discarded as placeholders. |
| json-escapes | 100% | Structured literal boundaries and unescaping are deterministic. |
| shell-escapes | 100% | Quotes/backslashes inside a credential must not create partial extraction. |
| url-encoding | 100% | Structured userinfo, query-value, and full-DSN slots have explicit semantics. |
| unicode | 100% | Byte and UTF-16 conversion cannot drop multibyte or astral characters. |
| crlf | 100% | Windows line endings cannot affect credential boundaries. |
| multiline | 100% | Entire PEM blocks and explicit YAML scalar slots must survive extraction. |
| repeated-values | 100% | Each source occurrence needs its own review decision. |
| adjacent-values | 100% | Nearby independent secrets must remain separately selectable. |
| meaningful-punctuation | 100% | Meaningful punctuation belongs to the file even when it resembles a delimiter. |
| generic-prose | >=90% | Unknown token prose is intrinsically broader but explicit credential intent merits high recall. |
| jwt | 100% | Complete signed token structure gives an exact boundary. |
| length (in limit) | 100% | No truncation at the limit or internal chunk boundary is acceptable. |

Apply percentages without rounding down the gate: required exact count = ceil(rate * category occurrence denominator). Also require >=98% pooled in-limit exact-span recall. This strict proposed bar intentionally exposes unsupported syntax; report it as failing/unsupported rather than changing annotations or targets after seeing results. Manual marking remains available but does not count as detector recall. Every supported occurrence claimed by the detector must satisfy the byte correctness gates below.

## Span and file-byte policy

Offsets are half-open. `start`/`end` count UTF-8 bytes, `start_u16`/`end_u16` count UTF-16 code units, without normalization. `raw` is the exact source substring; `decoded` always exists and equals raw unless a defined transformation differs. Highlight source bytes exactly, even when the eventual file contains decoded bytes. All emitted offsets must land on UTF-8 and UTF-16 character boundaries (100% required). Report invalid/out-of-range/overlapping outputs explicitly.

| Syntax | Annotation extent and assumed file bytes |
| --- | --- |
| plain, prose, header | Raw literal only; exclude natural-language wrappers, header name, Bearer scheme and delimiters. A quoted final dot/colon/semicolon explicitly inside the value stays included. No trimming or normalization. |
| env-assignment | Value content, excluding assignment prefix and outer quotes. These fixtures have no environment escape decoding. A DATABASE_URL slot explicitly contains the complete DSN: preserve the entire raw DSN, including percent escapes. |
| json-string | Interior source bytes, excluding outer JSON quotes; file contains JSON-unescaped UTF-8, including embedded newline, quote, slash and Unicode characters. |
| shell-single | Source interior including any close-quote/backslash-quote/reopen-quote sequence; omit only the outermost wrapping quotes. File contains the literal POSIX concatenated word. No command is executed. |
| shell-double | Interior source bytes; file contains POSIX double-quote backslash decoding for dollar, backtick, quote and backslash. Generated values escape all expansion triggers; no variable/command expansion. |
| url-userinfo | Password component only, excluding username, colon, @ and host. Percent-decode once as UTF-8; no plus-to-space conversion. |
| url-query | Credential query value only, excluding parameter name, equals sign, ampersand and other fields. Percent-decode once as UTF-8; literal plus remains plus. |
| pem | Entire BEGIN through END block, including internal newlines, excluding surrounding context and newline after END. Preserve raw bytes, including line-ending style; no appended newline. Synthetic PKCS8 Ed25519 envelope contains a generated private seed. |
| yaml | Raw span includes the two-space indentation of scalar content and its final newline; excludes `password: |` / `password: |-` and the next key. File contains deindented content, retaining one terminal newline for clip, none for strip. This is the explicitly generated subset of YAML literal scalars. |
| toml | Quoted basic-string interior. Fixtures contain Unicode but no TOML escapes; file bytes equal raw. |

Manual selections, if separately exercised later, preserve exactly selected source bytes regardless of inferred syntax. This corpus defines no automatic decoding for arbitrary shell programs, YAML features beyond its subset, or unmodeled TOML strings.

Require 100% raw-span agreement for exact matches and 100% expected file-byte agreement for all claimed extractions. Report BOTH raw and decoded agreement counts, with their denominators, even when the product chooses raw preservation. If the implementation's frozen syntax policy intentionally differs, display that policy and the incompatibility against this proposal; do not silently relabel it as decoded success. A raw-only adapter cannot establish decoded file correctness, and detector output alone cannot demonstrate actual materialization. Mark those integration claims unmeasured in phase 2 unless the interface exposes them.

Partial-leak tolerance is ZERO for values the detector claims: fail on any strict partial overlap, even if another output fully covers that occurrence. For exact synthetic all-approved replacement replay, check that no annotated source bytes remain outside protected intervals; full coverage is a separate metric and cannot substitute for exact boundaries. Deliberately ignored occurrences are excluded from a later user-decision replay, not counted as detector misses. Overbroad spans also fail byte correctness, even when they fully hide the secret. Missed occurrences remain counted as false negatives, separately from claimed partial extraction.

## Clean-prompt review burden

Count every candidate highlight on each of the 320 clean prompts; do not deduplicate repeated highlights out of burden. Targets: <=0.02 false highlights per clean prompt (at most 6 total), and <=2% of clean prompts opening review (at most 6 prompts). Require zero highlights across the template-reference, function-reference, placeholder and secret-length prose families; they have deterministic nonliteral intent. Report false highlights, review-open share and per-family counts across ALL clean prompts, plus exact precision and correction counts across positives. Clean prompts have no universal appended identifier. Manual highlighting is not an automatic false positive.

Review completion time, correction effort in real use, keyboard/touch usability, and consent/lifecycle behavior need a separate integration/user study. This synthetic detector corpus does not measure them; do not imply a usability benefit from passing these burden thresholds.

## Length and explicit rejection

The supported product limit is 16,384 UTF-8 bytes according to the issue. All 34 exact-limit cases must scan completely: start, middle, end, and one secret crossing each internal multiple of 512 (512 through 15,872). A straddling probe begins 13 bytes before its named boundary and ends 13 bytes after it. It probes a fixed byte grid, not every possible tokenization or implementation chunk size. Report each boundary separately.

The 16,385-, 32,768- and 32,769-byte prompts are all marked `over_limit: true`. Require 100% explicit recoverable rejection at the product entry point; no truncation, forwarding, partial success, or reported clean scan. These three cases are excluded from recall denominators. A lower-level detector accepting them is diagnostic only: acceptance cannot establish product rejection, so report that gate unmeasured if product preflight is unavailable. The exact 32,768-byte case is a deliberate double-limit stress case, not a newly supported size.

## Declared hardware and measurement budget

Host observed with `lscpu` and `free -h`: Intel Core i7-10750H CPU @ 2.60 GHz, 1 socket, 6 cores / 12 logical CPUs; 31 GiB RAM, 62 GiB swap. At declaration: roughly 15 GiB memory available; 10 GiB swap in use. Full command outputs are in host-lscpu.txt and host-memory.txt. This is a shared host; record CPU contention, available memory, runtime/toolchain, OS, process affinity and configured concurrency at measurement time. Do not treat dynamic availability as a fixed host property.

Mandatory full warm local scan of a 16 KiB prompt, including all enabled detectors and IPC: p50 <=25 ms, p95 <=75 ms, p99 <=150 ms, maximum <=500 ms. Absolute isolated detector/helper peak RSS <=256 MiB; additional peak RSS for four simultaneous scans over idle loaded baseline <=128 MiB. Four concurrent scans must each have p95 <=250 ms with a bounded queue. Cold initialization <=2 seconds and explicit recoverable timeout by 1 second for the mandatory warm scan. These are proposed interactive budgets for CPU scanning, not numbers inferred from measured detector behavior. Optional inference must be reported separately and must not change a submitted candidate set after review.

Phase 2 protocol: one persistent process, fixed frozen configuration, no provider/network verification; 10 unmeasured warmups per exact-limit case, then 100 measured scans per case, round-robin across all 34 positions, concurrency one, perf_counter_ns timing and nearest-rank percentiles. Include a length-matched clean 16 KiB diagnostic built from public build-log padding; declare its construction before running and exclude it from frozen accuracy counts. Test four-way bounded concurrency separately with at least 100 scans per worker, and 10 fresh-process cold loads. Report process peak RSS via Linux resource accounting for a fresh isolated process; state whether child-process memory is included. Do not subtract interpreter memory from absolute RSS. Instrumentation overhead and host contention remain visible. If a product pipeline is unavailable, label helper-only timing as such and leave complete-pipeline/timeout/concurrency gates unmeasured. No latency or RSS results are collected in phase 1.

A pass on this held-out corpus is necessary evidence for the proposed categories, not a release signoff. The setting, review UI, authoritative per-occurrence decisions, real file creation/cleanup and credential-consuming tool route remain separate issue #108 delivery gates.
