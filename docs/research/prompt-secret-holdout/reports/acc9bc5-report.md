# Phase 2 independent held-out evaluation

Detector `acc9bc5845194248efb6cc85964218471605fb54`. Frozen hashes verified before and after; checkout clean before and after. Detector source, pilot corpora and feature worktrees were not read. API only: `Scan(text, nil)` via external Go test overlay.

**464/478 exact occurrences (97.07%); 0 false clean highlights on 0/320 clean prompts.** Gate counts: {"PASS": 23, "FAIL": 6, "UNMEASURED": 9}. Macro family recall 93.88% over 49 positive families. These template families do not support production precision or confidence-interval claims.

## Frozen gates

### recall/adjacent-values: PASS

Frozen: adjacent-values: 100% exact-span recall

24/24 exact; required 24; full coverage 24; partial overlaps 0; overbroad 0; misses 0

### recall/crlf: PASS

Frozen: crlf: 100% exact-span recall

12/12 exact; required 12; full coverage 12; partial overlaps 0; overbroad 0; misses 0

### recall/generic-prose: PASS

Frozen: generic-prose: >=90% exact-span recall

12/12 exact; required 11; full coverage 12; partial overlaps 0; overbroad 0; misses 0

### recall/json-escapes: PASS

Frozen: json-escapes: 100% exact-span recall

12/12 exact; required 12; full coverage 12; partial overlaps 0; overbroad 0; misses 0

### recall/jwt: PASS

Frozen: jwt: 100% exact-span recall

9/9 exact; required 9; full coverage 9; partial overlaps 0; overbroad 0; misses 0

### recall/length: PASS

Frozen: length: 100% exact-span recall

34/34 exact; required 34; full coverage 34; partial overlaps 0; overbroad 0; misses 0

### recall/meaningful-punctuation: PASS

Frozen: meaningful-punctuation: 100% exact-span recall

12/12 exact; required 12; full coverage 12; partial overlaps 0; overbroad 0; misses 0

### recall/multiline: FAIL

Frozen: multiline: 100% exact-span recall

4/12 exact; required 12; full coverage 4; partial overlaps 8; overbroad 0; misses 0

### recall/provider-malformed: PASS

Frozen: provider-malformed: >=90% exact-span recall

96/96 exact; required 87; full coverage 96; partial overlaps 0; overbroad 0; misses 0

### recall/provider-valid: PASS

Frozen: provider-valid: 100% exact-span recall

96/96 exact; required 96; full coverage 96; partial overlaps 0; overbroad 0; misses 0

### recall/repeated-values: PASS

Frozen: repeated-values: 100% exact-span recall

36/36 exact; required 36; full coverage 36; partial overlaps 0; overbroad 0; misses 0

### recall/shell-escapes: PASS

Frozen: shell-escapes: 100% exact-span recall

24/24 exact; required 24; full coverage 24; partial overlaps 0; overbroad 0; misses 0

### recall/trailing-punctuation: PASS

Frozen: trailing-punctuation: 100% exact-span recall

42/42 exact; required 42; full coverage 42; partial overlaps 0; overbroad 0; misses 0

### recall/unicode: PASS

Frozen: unicode: 100% exact-span recall

12/12 exact; required 12; full coverage 12; partial overlaps 0; overbroad 0; misses 0

### recall/url-encoding: FAIL

Frozen: url-encoding: 100% exact-span recall

12/18 exact; required 18; full coverage 12; partial overlaps 6; overbroad 0; misses 0

### recall/weak-password: PASS

Frozen: weak-password: 100% exact-span recall

27/27 exact; required 27; full coverage 27; partial overlaps 0; overbroad 0; misses 0

### pooled-recall: FAIL

Frozen: Also require >=98% pooled in-limit exact-span recall.

464/478 = 97.071130%; required 469

### offset-validity: PASS

Frozen: All emitted offsets must land on UTF-8 and UTF-16 character boundaries (100% required). Report invalid/out-of-range/overlapping outputs explicitly.

0 invalid/range/ordering/overlap errors across all 765 prompts. UTF-8 endpoints map to valid UTF-16 code-unit boundaries without normalization.

### exact-raw-agreement: PASS

Frozen: Require 100% raw-span agreement for exact matches

464/464 exact source slices equal annotated raw bytes; a detector-level check only.

### claimed-span-byte-correctness: FAIL

Frozen: Overbroad spans also fail byte correctness, even when they fully hide the secret.

0 occurrences have overbroad claims; 14 have nonexact claims; source/raw agreement 464/478 overlapping candidates.

### actual-file-bytes: UNMEASURED

Frozen: 100% expected file-byte agreement for all claimed extractions.

Scan returns offsets and Encoded, creates no files. Product policy supplied in phase-2 brief preserves raw typed bytes; frozen decoding assumption differs. Under raw replay, exact source slices equal frozen decoded bytes for 416/464 exact matches; transformed subset 0/48. This is diagnostic source agreement, not materialization evidence.

### partial-leak: FAIL

Frozen: Partial-leak tolerance is ZERO for values the detector claims: fail on any strict partial overlap, even if another output fully covers that occurrence.

14 in-limit occurrences with strict undercoverage; all overlap details retained.

### all-approved-source-replay: FAIL

Frozen: For exact synthetic all-approved replacement replay, check that no annotated source bytes remain outside protected intervals

464/478 completely covered; 258 annotated bytes outside the union of claimed intervals. Interval replay uses raw source offsets; no actual files or user decisions exercised.

### clean-highlight-burden: PASS

Frozen: <=0.02 false highlights per clean prompt (at most 6 total)

0/320 = 0.000000 false highlights per clean prompt

### clean-review-openings: PASS

Frozen: <=2% of clean prompts opening review (at most 6 prompts)

0/320 = 0.000000% prompts contain a candidate; automatic review-opening proxy only

### deterministic-clean-intent: PASS

Frozen: Require zero highlights across the template-reference, function-reference, placeholder and secret-length prose families

0 highlights; per-family {"dollar-template": 0, "go-template": 0, "function-tokenizer": 0, "angle-placeholder": 0, "redacted-log": 0, "secret-length": 0}

### exact-limit-completeness: PASS

Frozen: All 34 exact-limit cases must scan completely: start, middle, end, and one secret crossing each internal multiple of 512 (512 through 15,872).

34/34 exact; each case listed below and in results.json. Full coverage 34/34.

### over-limit-rejection: UNMEASURED

Frozen: The 16,385-, 32,768- and 32,769-byte prompts are all marked over_limit: true. Require 100% explicit recoverable rejection at the product entry point

Scan has no limit. worker.prompt accepts at most 16,384 UTF-8 bytes; prompt_secrets.scan and worker.hire accept at most 32,768. These differ from the frozen universal 16,384 assumption. Each over-limit Scan result is diagnostic only; no product endpoint was called.

### warm-p50: UNMEASURED

Frozen: Mandatory full warm local scan of a 16 KiB prompt, including all enabled detectors and IPC: p50 <=25 ms

Helper-only scan {"n": 3400, "p50_ms": 25.922804, "p95_ms": 40.767351, "p99_ms": 49.553292, "max_ms": 75.92267}; evaluator round trip {"n": 3400, "p50_ms": 26.277803, "p95_ms": 41.215084, "p99_ms": 49.996281, "max_ms": 76.272624}. Product pipeline and IPC absent.

### warm-p95: UNMEASURED

Frozen: Mandatory full warm local scan of a 16 KiB prompt, including all enabled detectors and IPC: p95 <=75 ms

Helper-only scan {"n": 3400, "p50_ms": 25.922804, "p95_ms": 40.767351, "p99_ms": 49.553292, "max_ms": 75.92267}; evaluator round trip {"n": 3400, "p50_ms": 26.277803, "p95_ms": 41.215084, "p99_ms": 49.996281, "max_ms": 76.272624}. Product pipeline and IPC absent.

### warm-p99: UNMEASURED

Frozen: Mandatory full warm local scan of a 16 KiB prompt, including all enabled detectors and IPC: p99 <=150 ms

Helper-only scan {"n": 3400, "p50_ms": 25.922804, "p95_ms": 40.767351, "p99_ms": 49.553292, "max_ms": 75.92267}; evaluator round trip {"n": 3400, "p50_ms": 26.277803, "p95_ms": 41.215084, "p99_ms": 49.996281, "max_ms": 76.272624}. Product pipeline and IPC absent.

### warm-max: UNMEASURED

Frozen: Mandatory full warm local scan of a 16 KiB prompt, including all enabled detectors and IPC: maximum <=500 ms

Helper-only scan {"n": 3400, "p50_ms": 25.922804, "p95_ms": 40.767351, "p99_ms": 49.553292, "max_ms": 75.92267}; evaluator round trip {"n": 3400, "p50_ms": 26.277803, "p95_ms": 41.215084, "p99_ms": 49.996281, "max_ms": 76.272624}. Product pipeline and IPC absent.

### absolute-helper-rss: PASS

Frozen: Absolute isolated detector/helper peak RSS <=256 MiB

22784 KiB = 22.250 MiB, maximum across persistent, four-way and ten cold isolated processes; RUSAGE_SELF, children excluded. The pre-Scan RUSAGE watermark exceeds /proc VmHWM; see memory caveat and separate post-exec VmHWM in RSS results.

### additional-four-scan-rss: PASS

Frozen: additional peak RSS for four simultaneous scans over idle loaded baseline <=128 MiB

Conservative peak-minus-idle-current 2100 KiB = 2.051 MiB; loaded idle VmRSS 20684 KiB; end peak 22784 KiB. Helper-only four fixed workers, 100 scans each; includes runtime allocations.

### concurrent-p95: UNMEASURED

Frozen: Four concurrent scans must each have p95 <=250 ms with a bounded queue.

Helper-only four fixed workers (no pending backlog), 100 scans each: [{"n": 100, "p50_ms": 20.054527, "p95_ms": 21.533692, "p99_ms": 21.970105, "max_ms": 22.736069}, {"n": 100, "p50_ms": 20.244263, "p95_ms": 21.706058, "p99_ms": 23.684225, "max_ms": 23.82382}, {"n": 100, "p50_ms": 20.323718, "p95_ms": 21.721006, "p99_ms": 22.114928, "max_ms": 22.343811}, {"n": 100, "p50_ms": 19.991885, "p95_ms": 21.680171, "p99_ms": 21.887384, "max_ms": 22.619039}]. No complete product pipeline or queue exercised.

### cold-init: PASS

Frozen: Cold initialization <=2 seconds

Ten fresh-process first Scan calls, full cold first scan upper-bounds initialization: {"n": 10, "p50_ms": 32.297163, "p95_ms": 34.785707, "p99_ms": 34.785707, "max_ms": 34.785707}; launch through response {"n": 10, "p50_ms": 35.357076, "p95_ms": 38.262578, "p99_ms": 38.262578, "max_ms": 38.262578}

### recoverable-timeout: UNMEASURED

Frozen: explicit recoverable timeout by 1 second for the mandatory warm scan

Scan has no timeout interface; no bridge timeout or recovery path exercised. Fast helper completion cannot establish timeout handling.

### integration-and-usability: UNMEASURED

Frozen: Review completion time, correction effort in real use, keyboard/touch usability, and consent/lifecycle behavior need a separate integration/user study.

Setting, review UI, authoritative per-occurrence decisions, real file creation/cleanup, credential-consuming tool route, optional inference behavior and manual selection were not exercised.

## Category evidence

| Category | Exact / denominator | Recall | Full coverage | Partial overlap | Overbroad | Miss | Corrections |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| adjacent-values | 24/24 | 100.00% | 24 | 0 | 0 | 0 | 0 |
| crlf | 12/12 | 100.00% | 12 | 0 | 0 | 0 | 0 |
| generic-prose | 12/12 | 100.00% | 12 | 0 | 0 | 0 | 0 |
| json-escapes | 12/12 | 100.00% | 12 | 0 | 0 | 0 | 0 |
| jwt | 9/9 | 100.00% | 9 | 0 | 0 | 0 | 0 |
| length | 34/34 | 100.00% | 34 | 0 | 0 | 0 | 0 |
| meaningful-punctuation | 12/12 | 100.00% | 12 | 0 | 0 | 0 | 0 |
| multiline | 4/12 | 33.33% | 4 | 8 | 0 | 0 | 8 |
| provider-malformed | 96/96 | 100.00% | 96 | 0 | 0 | 0 | 0 |
| provider-valid | 96/96 | 100.00% | 96 | 0 | 0 | 0 | 0 |
| repeated-values | 36/36 | 100.00% | 36 | 0 | 0 | 0 | 0 |
| shell-escapes | 24/24 | 100.00% | 24 | 0 | 0 | 0 | 0 |
| trailing-punctuation | 42/42 | 100.00% | 42 | 0 | 0 | 0 | 0 |
| unicode | 12/12 | 100.00% | 12 | 0 | 0 | 0 | 0 |
| url-encoding | 12/18 | 66.67% | 12 | 6 | 0 | 0 | 6 |
| weak-password | 27/27 | 100.00% | 27 | 0 | 0 | 0 | 0 |

Full-coverage, partial-overlap and overbroad flags are independent; an exact match never hides another partial claim. Exact recall uses one-to-one candidate assignment; repeated values remain distinct. Nonexact overlap diagnostics can refer to one overbroad candidate spanning several annotations. Correction counts are syntactic boundary repairs, not measured user effort. Per family, expected kind, detector kind and syntax denominators are in results.json.

## Source bytes and file policy

{
  "exact_match_denominator": 464,
  "exact_raw_source_agreement": 464,
  "exact_source_vs_decoded_agreement": 416,
  "exact_transformed_denominator": 48,
  "exact_transformed_source_vs_decoded_agreement": 0,
  "overlapping_claim_denominator": 478,
  "overlapping_claim_raw_agreement": 464,
  "overlapping_claim_source_vs_decoded_agreement": 416,
  "clean_claims_without_expected_value": 0,
  "positive_claims_without_expected_value": 0,
  "scope": "in-limit positive candidates/occurrences; clean no-expected-value claims reported separately",
  "actual_raw_file_materialization": "UNMEASURED",
  "actual_decoded_file_materialization": "UNMEASURED",
  "product_policy": "raw as typed, per phase-2 brief; differs from frozen decoded policy where transformations apply"
}

Exact candidate precision on in-limit positives: 464/478; 0 positive candidates overlap no annotated secret. Duplicates across all prompts: 0. No actual file creation was attempted. Frozen raw and decoded byte expectations remain unchanged. Encoded flags and every raw selected slice are in results.json. Claims on clean prompts have no expected credential bytes.

## Exact-limit probes

| ID | Position / boundary | Expected byte span | Outcome | Full coverage | Scan p95 ms |
| --- | --- | --- | --- | --- | ---: |
| heldout-00409 | start / None | [0, 26) | exact | True | 41.353 |
| heldout-00410 | middle / None | [8192, 8218) | exact | True | 36.845 |
| heldout-00411 | end / None | [16358, 16384) | exact | True | 44.534 |
| heldout-00412 | straddle / 512 | [499, 525) | exact | True | 39.340 |
| heldout-00413 | straddle / 1024 | [1011, 1037) | exact | True | 39.061 |
| heldout-00414 | straddle / 1536 | [1523, 1549) | exact | True | 42.505 |
| heldout-00415 | straddle / 2048 | [2035, 2061) | exact | True | 41.913 |
| heldout-00416 | straddle / 2560 | [2547, 2573) | exact | True | 37.473 |
| heldout-00417 | straddle / 3072 | [3059, 3085) | exact | True | 37.507 |
| heldout-00418 | straddle / 3584 | [3571, 3597) | exact | True | 40.965 |
| heldout-00419 | straddle / 4096 | [4083, 4109) | exact | True | 41.566 |
| heldout-00420 | straddle / 4608 | [4595, 4621) | exact | True | 39.164 |
| heldout-00421 | straddle / 5120 | [5107, 5133) | exact | True | 38.200 |
| heldout-00422 | straddle / 5632 | [5619, 5645) | exact | True | 43.949 |
| heldout-00423 | straddle / 6144 | [6131, 6157) | exact | True | 40.327 |
| heldout-00424 | straddle / 6656 | [6643, 6669) | exact | True | 40.846 |
| heldout-00425 | straddle / 7168 | [7155, 7181) | exact | True | 37.123 |
| heldout-00426 | straddle / 7680 | [7667, 7693) | exact | True | 39.445 |
| heldout-00427 | straddle / 8192 | [8179, 8205) | exact | True | 36.113 |
| heldout-00428 | straddle / 8704 | [8691, 8717) | exact | True | 38.218 |
| heldout-00429 | straddle / 9216 | [9203, 9229) | exact | True | 37.761 |
| heldout-00430 | straddle / 9728 | [9715, 9741) | exact | True | 36.785 |
| heldout-00431 | straddle / 10240 | [10227, 10253) | exact | True | 39.664 |
| heldout-00432 | straddle / 10752 | [10739, 10765) | exact | True | 40.673 |
| heldout-00433 | straddle / 11264 | [11251, 11277) | exact | True | 44.517 |
| heldout-00434 | straddle / 11776 | [11763, 11789) | exact | True | 41.580 |
| heldout-00435 | straddle / 12288 | [12275, 12301) | exact | True | 42.187 |
| heldout-00436 | straddle / 12800 | [12787, 12813) | exact | True | 39.870 |
| heldout-00437 | straddle / 13312 | [13299, 13325) | exact | True | 40.722 |
| heldout-00438 | straddle / 13824 | [13811, 13837) | exact | True | 39.468 |
| heldout-00439 | straddle / 14336 | [14323, 14349) | exact | True | 41.180 |
| heldout-00440 | straddle / 14848 | [14835, 14861) | exact | True | 38.948 |
| heldout-00441 | straddle / 15360 | [15347, 15373) | exact | True | 38.603 |
| heldout-00442 | straddle / 15872 | [15859, 15885) | exact | True | 40.455 |

Frozen over-limit prompts are excluded from all recall denominators. Scan diagnostic results:
* heldout-00443: 32768 bytes; 1 candidates; ['exact']. Product rejection UNMEASURED.
* heldout-00444: 16385 bytes; 1 candidates; ['exact']. Product rejection UNMEASURED.
* heldout-00445: 32769 bytes; 1 candidates; ['exact']. Product rejection UNMEASURED.

## Clean families

| Family | Prompts | False highlights | Prompts opening review |
| --- | ---: | ---: | ---: |
| angle-placeholder | 16 | 0 | 0 |
| artifact-hash | 16 | 0 | 0 |
| dollar-template | 16 | 0 | 0 |
| env-schema | 16 | 0 | 0 |
| function-tokenizer | 16 | 0 | 0 |
| git-review | 16 | 0 | 0 |
| go-template | 16 | 0 | 0 |
| image-fixture | 16 | 0 | 0 |
| lockfile-review | 16 | 0 | 0 |
| password-guidance | 16 | 0 | 0 |
| plain-settings | 16 | 0 | 0 |
| python-env-call | 16 | 0 | 0 |
| randomized-test | 16 | 0 | 0 |
| redacted-log | 16 | 0 | 0 |
| request-trace | 16 | 0 | 0 |
| secret-length | 16 | 0 | 0 |
| unicode-documentation | 16 | 0 | 0 |
| url-task | 16 | 0 | 0 |
| uuid-log | 16 | 0 | 0 |
| windows-clean-log | 16 | 0 | 0 |

## Observed miss and false-highlight patterns

No false highlights were observed on any clean family; there are no false-highlight causes or examples to attribute. Observed partial claims include malformed Bearer tokens cut at an internal exclamation mark, shell single-quoted values cut before the quote-splice sequence, YAML selections omitting leading indentation and the last newline, and password-only extraction from explicitly whole-DSN slots. Misses cluster in explicit but less direct prose, weak values, punctuation wrappers and Unicode chat. The start-limit probe places credential intent after the value, so its miss does not establish truncation. All false negatives and partial claims are grouped below.

Groups below describe black-box observations, not implementation root causes. All displayed values are frozen synthetic fixtures. Counts in no-detection/boundary groups count occurrences; false-highlight groups count affected prompts. Every result and overlap is retained in results.json.

### boundary extraction: env-assignment / url-entire-dsn (6)

* `heldout-00300`: {"id": "heldout-00300", "category": "url-encoding", "family": "url-entire-dsn", "outcome": "partial_overlap", "expected_raw": "postgresql://app:%C3%A9t%C3%A9%F0%9F%94%91%3AwjovefPGQ%40%2F%2B%25@db.invalid:5432/store", "predicted": ["%C3%A9t%C3%A9%F0%9F%94%91%3AwjovefPGQ%40%2F%2B%25"], "context": "complete connection-string credential from config:\nDATABASE_URL=\"postgresql://app:%C3%A9t%C3%A9%F0%9F%94%91%3AwjovefPGQ%40%2F%2B%25@db.invalid:5432/store\"\n"}
* `heldout-00303`: {"id": "heldout-00303", "category": "url-encoding", "family": "url-entire-dsn", "outcome": "partial_overlap", "expected_raw": "postgresql://app:%C3%A9t%C3%A9%F0%9F%94%91%3Ady4SgCw5C%40%2F%2B%25@db.invalid:5432/store", "predicted": ["%C3%A9t%C3%A9%F0%9F%94%91%3Ady4SgCw5C%40%2F%2B%25"], "context": "complete connection-string credential from config:\nDATABASE_URL=\"postgresql://app:%C3%A9t%C3%A9%F0%9F%94%91%3Ady4SgCw5C%40%2F%2B%25@db.invalid:5432/store\"\n"}
* `heldout-00306`: {"id": "heldout-00306", "category": "url-encoding", "family": "url-entire-dsn", "outcome": "partial_overlap", "expected_raw": "postgresql://app:%C3%A9t%C3%A9%F0%9F%94%91%3ASivTO9SbV%40%2F%2B%25@db.invalid:5432/store", "predicted": ["%C3%A9t%C3%A9%F0%9F%94%91%3ASivTO9SbV%40%2F%2B%25"], "context": "complete connection-string credential from config:\nDATABASE_URL=\"postgresql://app:%C3%A9t%C3%A9%F0%9F%94%91%3ASivTO9SbV%40%2F%2B%25@db.invalid:5432/store\"\n"}

### boundary extraction: yaml / yaml-literal-clip (4)

* `heldout-00341`: {"id": "heldout-00341", "category": "multiline", "family": "yaml-literal-clip", "outcome": "partial_overlap", "expected_raw": "  6rPDsJoFBt\n  XPTH5DVudg\n", "predicted": ["6rPDsJoFBt\n  XPTH5DVudg"], "context": "Inspect this YAML credential config:\npassword: |\n  6rPDsJoFBt\n  XPTH5DVudg\nretries: 2\n"}
* `heldout-00344`: {"id": "heldout-00344", "category": "multiline", "family": "yaml-literal-clip", "outcome": "partial_overlap", "expected_raw": "  n8fxMGkeFI\n  xXLgOJpF4S\n", "predicted": ["n8fxMGkeFI\n  xXLgOJpF4S"], "context": "Inspect this YAML credential config:\npassword: |\n  n8fxMGkeFI\n  xXLgOJpF4S\nretries: 2\n"}
* `heldout-00347`: {"id": "heldout-00347", "category": "multiline", "family": "yaml-literal-clip", "outcome": "partial_overlap", "expected_raw": "  tKfLdr5hek\n  oBbJz5ct9A\n", "predicted": ["tKfLdr5hek\n  oBbJz5ct9A"], "context": "Inspect this YAML credential config:\npassword: |\n  tKfLdr5hek\n  oBbJz5ct9A\nretries: 2\n"}

### boundary extraction: yaml / yaml-literal-strip (4)

* `heldout-00342`: {"id": "heldout-00342", "category": "multiline", "family": "yaml-literal-strip", "outcome": "partial_overlap", "expected_raw": "  bLmymrbQ8r\n  vZdxeyjA02\n", "predicted": ["bLmymrbQ8r\n  vZdxeyjA02"], "context": "Repair this YAML config loader:\npassword: |-\n  bLmymrbQ8r\n  vZdxeyjA02\nretries: 2\n"}
* `heldout-00345`: {"id": "heldout-00345", "category": "multiline", "family": "yaml-literal-strip", "outcome": "partial_overlap", "expected_raw": "  PSzB1zwYSU\n  EBqHrkh4fK\n", "predicted": ["PSzB1zwYSU\n  EBqHrkh4fK"], "context": "Repair this YAML config loader:\npassword: |-\n  PSzB1zwYSU\n  EBqHrkh4fK\nretries: 2\n"}
* `heldout-00348`: {"id": "heldout-00348", "category": "multiline", "family": "yaml-literal-strip", "outcome": "partial_overlap", "expected_raw": "  DXEsRFMlBp\n  m06nvJhG1s\n", "predicted": ["DXEsRFMlBp\n  m06nvJhG1s"], "context": "Repair this YAML config loader:\npassword: |-\n  DXEsRFMlBp\n  m06nvJhG1s\nretries: 2\n"}

## Timing and host conditions

Measurement plan was written before executing the detector: measurement-plan.md. Fixed GOMAXPROCS=4 and GOTOOLCHAIN=local. One persistent process; 10 unmeasured warmups per exact-limit case, then 100 round-robin scans per case (3,400 measured scans). Python perf_counter_ns records evaluator pipe/JSON round trips, Go monotonic timers record Scan calls. Both are helper-only. Clean diagnostic repeats the public build-log line, truncated to 16,384 ASCII bytes; 10 warmups and 100 measured scans, excluded from frozen accuracy. Four fixed goroutine workers run 100 synchronous scans each with no backlog. Ten fresh binary processes measure cold first-call Scan and launch-through-response time; compilation is excluded. No optional inference.

```json
{
  "warm_scan": {
    "n": 3400,
    "p50_ms": 25.922804,
    "p95_ms": 40.767351,
    "p99_ms": 49.553292,
    "max_ms": 75.92267
  },
  "warm_evaluator_roundtrip": {
    "n": 3400,
    "p50_ms": 26.277803,
    "p95_ms": 41.215084,
    "p99_ms": 49.996281,
    "max_ms": 76.272624
  },
  "clean_scan": {
    "n": 100,
    "p50_ms": 11.837282,
    "p95_ms": 12.604516,
    "p99_ms": 13.486189,
    "max_ms": 13.637927
  },
  "clean_evaluator_roundtrip": {
    "n": 100,
    "p50_ms": 12.064573,
    "p95_ms": 12.860486,
    "p99_ms": 13.693532,
    "max_ms": 13.890635
  },
  "cold_scan": {
    "n": 10,
    "p50_ms": 32.297163,
    "p95_ms": 34.785707,
    "p99_ms": 34.785707,
    "max_ms": 34.785707
  },
  "cold_launch_through_response": {
    "n": 10,
    "p50_ms": 35.357076,
    "p95_ms": 38.262578,
    "p99_ms": 38.262578,
    "max_ms": 38.262578
  },
  "four_worker_scan": [
    {
      "n": 100,
      "p50_ms": 20.054527,
      "p95_ms": 21.533692,
      "p99_ms": 21.970105,
      "max_ms": 22.736069
    },
    {
      "n": 100,
      "p50_ms": 20.244263,
      "p95_ms": 21.706058,
      "p99_ms": 23.684225,
      "max_ms": 23.82382
    },
    {
      "n": 100,
      "p50_ms": 20.323718,
      "p95_ms": 21.721006,
      "p99_ms": 22.114928,
      "max_ms": 22.343811
    },
    {
      "n": 100,
      "p50_ms": 19.991885,
      "p95_ms": 21.680171,
      "p99_ms": 21.887384,
      "max_ms": 22.619039
    }
  ],
  "rss": {
    "post_exec_proc_status_peak_kib": 22776,
    "rusage_caveat": "RUSAGE_SELF is already 22648 KiB before first Scan while initial /proc VmHWM is 8612 KiB. A launch/pre-exec high-water mark appears retained. Use RUSAGE as a conservative upper bound; post-exec VmHWM is reported separately, without subtraction.",
    "absolute_peak_kib": 22784,
    "persistent_peak_kib": 22784,
    "cold_peak_kib": [
      22784,
      22784,
      22784,
      22784,
      22784,
      22784,
      22784,
      22784,
      22784,
      22784
    ],
    "four_worker_baseline": {
      "VmHWM:": 20684,
      "VmRSS:": 20684,
      "ru_maxrss_kib": 22784
    },
    "four_worker_after": {
      "VmHWM:": 22772,
      "VmRSS:": 22772,
      "ru_maxrss_kib": 22784
    },
    "conservative_peak_minus_idle_current_kib": 2100,
    "four_worker_high_water_increase_kib": 0,
    "accounting": "Linux RUSAGE_SELF, entire isolated Go test process, no child-process RSS, no runtime/interpreter subtraction; Python driver and build excluded"
  },
  "runtime": {
    "cpus": 12,
    "go": "go1.27.0",
    "gomaxprocs": 4,
    "memory": {
      "VmHWM:": 8812,
      "VmRSS:": 8812,
      "ru_maxrss_kib": 22784
    }
  }
}
```

RUSAGE_SELF peak memory includes the entire isolated Go test process and harness, with no subtraction; children excluded. Driver Python and compiler are not part of detector process RSS. Concurrent peak-minus-current-baseline is a conservative upper bound, including runtime growth; both current and high-water baselines are retained. Instrumentation overhead and shared-host contention remain in the timing samples.

### host_start

UTC 2026-10-18T22:18:49Z; OS {'system': 'Linux', 'node': 'kiswe-omarchy', 'release': '7.2.8-9-omarchy', 'version': '#1 SMP PREEMPT_DYNAMIC Sat, 17 Oct 2026 22:09:33 +0000', 'machine': 'x86_64', 'processor': ''}; affinity [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]; load averages [6.84130859375, 3.27001953125, 3.1044921875]; MemAvailable 19304192 kB; SwapFree 56426152 kB.

CPU pressure:
```
some avg10=4.25 avg60=7.80 avg300=3.01 total=3170406272
full avg10=0.00 avg60=0.00 avg300=0.00 total=0
```
Memory pressure:
```
some avg10=0.00 avg60=0.00 avg300=0.00 total=18530285
full avg10=0.00 avg60=0.00 avg300=0.00 total=17298680
```
### host_end

UTC 2026-10-18T22:20:35Z; OS {'system': 'Linux', 'node': 'kiswe-omarchy', 'release': '7.2.8-9-omarchy', 'version': '#1 SMP PREEMPT_DYNAMIC Sat, 17 Oct 2026 22:09:33 +0000', 'machine': 'x86_64', 'processor': ''}; affinity [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]; load averages [8.4482421875, 5.36767578125, 3.90234375]; MemAvailable 20691508 kB; SwapFree 56426676 kB.

CPU pressure:
```
some avg10=4.16 avg60=12.46 avg300=6.47 total=3186170158
full avg10=0.00 avg60=0.00 avg300=0.00 total=0
```
Memory pressure:
```
some avg10=0.00 avg60=0.00 avg300=0.00 total=18530425
full avg10=0.00 avg60=0.00 avg300=0.00 total=17298713
```

CPU model, topology, /proc/stat CPU contention counters, full memory snapshots and affinity are preserved in measurements.json and results.json. Phase-1 declared machine: Intel i7-10750H, 6 cores / 12 logical CPUs, approximately 31 GiB RAM. Dynamic availability is reported at measurement start and end.

## Reproduction and artifacts

Run `/home/jeff/.local/state/write-code/runs/20261018-1321-secrets/eval/phase2-acc9bc5/run.sh [checkout]` to rebuild the same external overlay harness and repeat against another requested SHA. Exact commands and environment overrides are in commands.json; build output is in build.log; all raw timings and observations in measurements.json; per-prompt/per-secret classifications, aggregates and gates in results.json; independent recomputation and frozen-hash/protocol validation in verify_results.py and verification.json. Frozen artifacts are checked before building and after measurements. The checkout is checked clean at both ends. Report generation alone: `python3 -I /home/jeff/.local/state/write-code/runs/20261018-1321-secrets/eval/phase2-acc9bc5/analyze.py`.

This is detector evidence, not a release signoff. Integration delivery gates and a real usability study remain separate.
