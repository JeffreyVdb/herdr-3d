# Phase 2 independent held-out evaluation

Detector `665b3d516b667cebc43c3b25c7e322e7eb7a2343`. Frozen hashes verified before and after; checkout clean before and after. Detector source, pilot corpora and feature worktrees were not read. API only: `Scan(text, nil)` via external Go test overlay.

**338/478 exact occurrences (70.71%); 0 false clean highlights on 0/320 clean prompts.** Gate counts: {"PASS": 14, "FAIL": 15, "UNMEASURED": 9}. Macro family recall 67.06% over 49 positive families. These template families do not support production precision or confidence-interval claims.

## Frozen gates

### recall/adjacent-values: PASS

Frozen: adjacent-values: 100% exact-span recall

24/24 exact; required 24; full coverage 24; partial overlaps 0; overbroad 0; misses 0

### recall/crlf: FAIL

Frozen: crlf: 100% exact-span recall

8/12 exact; required 12; full coverage 8; partial overlaps 4; overbroad 0; misses 0

### recall/generic-prose: PASS

Frozen: generic-prose: >=90% exact-span recall

12/12 exact; required 11; full coverage 12; partial overlaps 0; overbroad 0; misses 0

### recall/json-escapes: PASS

Frozen: json-escapes: 100% exact-span recall

12/12 exact; required 12; full coverage 12; partial overlaps 0; overbroad 0; misses 0

### recall/jwt: PASS

Frozen: jwt: 100% exact-span recall

9/9 exact; required 9; full coverage 9; partial overlaps 0; overbroad 0; misses 0

### recall/length: FAIL

Frozen: length: 100% exact-span recall

33/34 exact; required 34; full coverage 33; partial overlaps 0; overbroad 0; misses 1

### recall/meaningful-punctuation: FAIL

Frozen: meaningful-punctuation: 100% exact-span recall

0/12 exact; required 12; full coverage 0; partial overlaps 0; overbroad 0; misses 12

### recall/multiline: FAIL

Frozen: multiline: 100% exact-span recall

4/12 exact; required 12; full coverage 4; partial overlaps 8; overbroad 0; misses 0

### recall/provider-malformed: FAIL

Frozen: provider-malformed: >=90% exact-span recall

32/96 exact; required 87; full coverage 32; partial overlaps 32; overbroad 0; misses 32

### recall/provider-valid: PASS

Frozen: provider-valid: 100% exact-span recall

96/96 exact; required 96; full coverage 96; partial overlaps 0; overbroad 0; misses 0

### recall/repeated-values: PASS

Frozen: repeated-values: 100% exact-span recall

36/36 exact; required 36; full coverage 36; partial overlaps 0; overbroad 0; misses 0

### recall/shell-escapes: FAIL

Frozen: shell-escapes: 100% exact-span recall

8/24 exact; required 24; full coverage 8; partial overlaps 12; overbroad 0; misses 4

### recall/trailing-punctuation: FAIL

Frozen: trailing-punctuation: 100% exact-span recall

26/42 exact; required 42; full coverage 26; partial overlaps 0; overbroad 0; misses 16

### recall/unicode: FAIL

Frozen: unicode: 100% exact-span recall

8/12 exact; required 12; full coverage 8; partial overlaps 0; overbroad 0; misses 4

### recall/url-encoding: FAIL

Frozen: url-encoding: 100% exact-span recall

12/18 exact; required 18; full coverage 12; partial overlaps 6; overbroad 0; misses 0

### recall/weak-password: FAIL

Frozen: weak-password: 100% exact-span recall

18/27 exact; required 27; full coverage 18; partial overlaps 0; overbroad 0; misses 9

### pooled-recall: FAIL

Frozen: Also require >=98% pooled in-limit exact-span recall.

338/478 = 70.711297%; required 469

### offset-validity: PASS

Frozen: All emitted offsets must land on UTF-8 and UTF-16 character boundaries (100% required). Report invalid/out-of-range/overlapping outputs explicitly.

0 invalid/range/ordering/overlap errors across all 765 prompts. UTF-8 endpoints map to valid UTF-16 code-unit boundaries without normalization.

### exact-raw-agreement: PASS

Frozen: Require 100% raw-span agreement for exact matches

338/338 exact source slices equal annotated raw bytes; a detector-level check only.

### claimed-span-byte-correctness: FAIL

Frozen: Overbroad spans also fail byte correctness, even when they fully hide the secret.

0 occurrences have overbroad claims; 62 have nonexact claims; source/raw agreement 338/400 overlapping candidates.

### actual-file-bytes: UNMEASURED

Frozen: 100% expected file-byte agreement for all claimed extractions.

Scan returns offsets and Encoded, creates no files. Product policy supplied in phase-2 brief preserves raw typed bytes; frozen decoding assumption differs. Under raw replay, exact source slices equal frozen decoded bytes for 306/338 exact matches; transformed subset 0/32. This is diagnostic source agreement, not materialization evidence.

### partial-leak: FAIL

Frozen: Partial-leak tolerance is ZERO for values the detector claims: fail on any strict partial overlap, even if another output fully covers that occurrence.

62 in-limit occurrences with strict undercoverage; all overlap details retained.

### all-approved-source-replay: FAIL

Frozen: For exact synthetic all-approved replacement replay, check that no annotated source bytes remain outside protected intervals

338/478 completely covered; 5162 annotated bytes outside the union of claimed intervals. Interval replay uses raw source offsets; no actual files or user decisions exercised.

### clean-highlight-burden: PASS

Frozen: <=0.02 false highlights per clean prompt (at most 6 total)

0/320 = 0.000000 false highlights per clean prompt

### clean-review-openings: PASS

Frozen: <=2% of clean prompts opening review (at most 6 prompts)

0/320 = 0.000000% prompts contain a candidate; automatic review-opening proxy only

### deterministic-clean-intent: PASS

Frozen: Require zero highlights across the template-reference, function-reference, placeholder and secret-length prose families

0 highlights; per-family {"dollar-template": 0, "go-template": 0, "function-tokenizer": 0, "angle-placeholder": 0, "redacted-log": 0, "secret-length": 0}

### exact-limit-completeness: FAIL

Frozen: All 34 exact-limit cases must scan completely: start, middle, end, and one secret crossing each internal multiple of 512 (512 through 15,872).

33/34 exact; each case listed below and in results.json. Full coverage 33/34.

### over-limit-rejection: UNMEASURED

Frozen: The 16,385-, 32,768- and 32,769-byte prompts are all marked over_limit: true. Require 100% explicit recoverable rejection at the product entry point

Scan has no limit. worker.prompt accepts at most 16,384 UTF-8 bytes; prompt_secrets.scan and worker.hire accept at most 32,768. These differ from the frozen universal 16,384 assumption. Each over-limit Scan result is diagnostic only; no product endpoint was called.

### warm-p50: UNMEASURED

Frozen: Mandatory full warm local scan of a 16 KiB prompt, including all enabled detectors and IPC: p50 <=25 ms

Helper-only scan {"n": 3400, "p50_ms": 25.729692, "p95_ms": 49.090541, "p99_ms": 58.736952, "max_ms": 97.636763}; evaluator round trip {"n": 3400, "p50_ms": 26.043429, "p95_ms": 49.437637, "p99_ms": 60.074579, "max_ms": 98.03491}. Product pipeline and IPC absent.

### warm-p95: UNMEASURED

Frozen: Mandatory full warm local scan of a 16 KiB prompt, including all enabled detectors and IPC: p95 <=75 ms

Helper-only scan {"n": 3400, "p50_ms": 25.729692, "p95_ms": 49.090541, "p99_ms": 58.736952, "max_ms": 97.636763}; evaluator round trip {"n": 3400, "p50_ms": 26.043429, "p95_ms": 49.437637, "p99_ms": 60.074579, "max_ms": 98.03491}. Product pipeline and IPC absent.

### warm-p99: UNMEASURED

Frozen: Mandatory full warm local scan of a 16 KiB prompt, including all enabled detectors and IPC: p99 <=150 ms

Helper-only scan {"n": 3400, "p50_ms": 25.729692, "p95_ms": 49.090541, "p99_ms": 58.736952, "max_ms": 97.636763}; evaluator round trip {"n": 3400, "p50_ms": 26.043429, "p95_ms": 49.437637, "p99_ms": 60.074579, "max_ms": 98.03491}. Product pipeline and IPC absent.

### warm-max: UNMEASURED

Frozen: Mandatory full warm local scan of a 16 KiB prompt, including all enabled detectors and IPC: maximum <=500 ms

Helper-only scan {"n": 3400, "p50_ms": 25.729692, "p95_ms": 49.090541, "p99_ms": 58.736952, "max_ms": 97.636763}; evaluator round trip {"n": 3400, "p50_ms": 26.043429, "p95_ms": 49.437637, "p99_ms": 60.074579, "max_ms": 98.03491}. Product pipeline and IPC absent.

### absolute-helper-rss: PASS

Frozen: Absolute isolated detector/helper peak RSS <=256 MiB

22648 KiB = 22.117 MiB, maximum across persistent, four-way and ten cold isolated processes; RUSAGE_SELF, children excluded. The pre-Scan RUSAGE watermark exceeds /proc VmHWM; see memory caveat and separate post-exec VmHWM in RSS results.

### additional-four-scan-rss: PASS

Frozen: additional peak RSS for four simultaneous scans over idle loaded baseline <=128 MiB

Conservative peak-minus-idle-current 2188 KiB = 2.137 MiB; loaded idle VmRSS 20460 KiB; end peak 22648 KiB. Helper-only four fixed workers, 100 scans each; includes runtime allocations.

### concurrent-p95: UNMEASURED

Frozen: Four concurrent scans must each have p95 <=250 ms with a bounded queue.

Helper-only four fixed workers (no pending backlog), 100 scans each: [{"n": 100, "p50_ms": 46.420051, "p95_ms": 89.961242, "p99_ms": 107.79458, "max_ms": 124.688962}, {"n": 100, "p50_ms": 47.473564, "p95_ms": 97.899475, "p99_ms": 110.310369, "max_ms": 133.046783}, {"n": 100, "p50_ms": 45.808308, "p95_ms": 89.053734, "p99_ms": 102.09972, "max_ms": 113.08564}, {"n": 100, "p50_ms": 45.363647, "p95_ms": 78.085147, "p99_ms": 94.08516, "max_ms": 98.080425}]. No complete product pipeline or queue exercised.

### cold-init: PASS

Frozen: Cold initialization <=2 seconds

Ten fresh-process first Scan calls, full cold first scan upper-bounds initialization: {"n": 10, "p50_ms": 70.952392, "p95_ms": 93.672616, "p99_ms": 93.672616, "max_ms": 93.672616}; launch through response {"n": 10, "p50_ms": 77.883582, "p95_ms": 99.476671, "p99_ms": 99.476671, "max_ms": 99.476671}

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
| crlf | 8/12 | 66.67% | 8 | 4 | 0 | 0 | 4 |
| generic-prose | 12/12 | 100.00% | 12 | 0 | 0 | 0 | 0 |
| json-escapes | 12/12 | 100.00% | 12 | 0 | 0 | 0 | 0 |
| jwt | 9/9 | 100.00% | 9 | 0 | 0 | 0 | 0 |
| length | 33/34 | 97.06% | 33 | 0 | 0 | 1 | 0 |
| meaningful-punctuation | 0/12 | 0.00% | 0 | 0 | 0 | 12 | 0 |
| multiline | 4/12 | 33.33% | 4 | 8 | 0 | 0 | 8 |
| provider-malformed | 32/96 | 33.33% | 32 | 32 | 0 | 32 | 32 |
| provider-valid | 96/96 | 100.00% | 96 | 0 | 0 | 0 | 0 |
| repeated-values | 36/36 | 100.00% | 36 | 0 | 0 | 0 | 0 |
| shell-escapes | 8/24 | 33.33% | 8 | 12 | 0 | 4 | 12 |
| trailing-punctuation | 26/42 | 61.90% | 26 | 0 | 0 | 16 | 0 |
| unicode | 8/12 | 66.67% | 8 | 0 | 0 | 4 | 0 |
| url-encoding | 12/18 | 66.67% | 12 | 6 | 0 | 0 | 6 |
| weak-password | 18/27 | 66.67% | 18 | 0 | 0 | 9 | 0 |

Full-coverage, partial-overlap and overbroad flags are independent; an exact match never hides another partial claim. Exact recall uses one-to-one candidate assignment; repeated values remain distinct. Nonexact overlap diagnostics can refer to one overbroad candidate spanning several annotations. Correction counts are syntactic boundary repairs, not measured user effort. Per family, expected kind, detector kind and syntax denominators are in results.json.

## Source bytes and file policy

{
  "exact_match_denominator": 338,
  "exact_raw_source_agreement": 338,
  "exact_source_vs_decoded_agreement": 306,
  "exact_transformed_denominator": 32,
  "exact_transformed_source_vs_decoded_agreement": 0,
  "overlapping_claim_denominator": 400,
  "overlapping_claim_raw_agreement": 338,
  "overlapping_claim_source_vs_decoded_agreement": 306,
  "clean_claims_without_expected_value": 0,
  "positive_claims_without_expected_value": 0,
  "scope": "in-limit positive candidates/occurrences; clean no-expected-value claims reported separately",
  "actual_raw_file_materialization": "UNMEASURED",
  "actual_decoded_file_materialization": "UNMEASURED",
  "product_policy": "raw as typed, per phase-2 brief; differs from frozen decoded policy where transformations apply"
}

Exact candidate precision on in-limit positives: 338/400; 0 positive candidates overlap no annotated secret. Duplicates across all prompts: 0. No actual file creation was attempted. Frozen raw and decoded byte expectations remain unchanged. Encoded flags and every raw selected slice are in results.json. Claims on clean prompts have no expected credential bytes.

## Exact-limit probes

| ID | Position / boundary | Expected byte span | Outcome | Full coverage | Scan p95 ms |
| --- | --- | --- | --- | --- | ---: |
| heldout-00409 | start / None | [0, 26) | missed | False | 48.322 |
| heldout-00410 | middle / None | [8192, 8218) | exact | True | 48.451 |
| heldout-00411 | end / None | [16358, 16384) | exact | True | 48.726 |
| heldout-00412 | straddle / 512 | [499, 525) | exact | True | 48.307 |
| heldout-00413 | straddle / 1024 | [1011, 1037) | exact | True | 48.892 |
| heldout-00414 | straddle / 1536 | [1523, 1549) | exact | True | 48.634 |
| heldout-00415 | straddle / 2048 | [2035, 2061) | exact | True | 45.933 |
| heldout-00416 | straddle / 2560 | [2547, 2573) | exact | True | 46.725 |
| heldout-00417 | straddle / 3072 | [3059, 3085) | exact | True | 47.098 |
| heldout-00418 | straddle / 3584 | [3571, 3597) | exact | True | 49.156 |
| heldout-00419 | straddle / 4096 | [4083, 4109) | exact | True | 50.019 |
| heldout-00420 | straddle / 4608 | [4595, 4621) | exact | True | 49.272 |
| heldout-00421 | straddle / 5120 | [5107, 5133) | exact | True | 50.246 |
| heldout-00422 | straddle / 5632 | [5619, 5645) | exact | True | 47.915 |
| heldout-00423 | straddle / 6144 | [6131, 6157) | exact | True | 47.339 |
| heldout-00424 | straddle / 6656 | [6643, 6669) | exact | True | 47.956 |
| heldout-00425 | straddle / 7168 | [7155, 7181) | exact | True | 49.998 |
| heldout-00426 | straddle / 7680 | [7667, 7693) | exact | True | 50.014 |
| heldout-00427 | straddle / 8192 | [8179, 8205) | exact | True | 48.809 |
| heldout-00428 | straddle / 8704 | [8691, 8717) | exact | True | 50.878 |
| heldout-00429 | straddle / 9216 | [9203, 9229) | exact | True | 48.622 |
| heldout-00430 | straddle / 9728 | [9715, 9741) | exact | True | 47.027 |
| heldout-00431 | straddle / 10240 | [10227, 10253) | exact | True | 49.091 |
| heldout-00432 | straddle / 10752 | [10739, 10765) | exact | True | 47.177 |
| heldout-00433 | straddle / 11264 | [11251, 11277) | exact | True | 50.443 |
| heldout-00434 | straddle / 11776 | [11763, 11789) | exact | True | 46.946 |
| heldout-00435 | straddle / 12288 | [12275, 12301) | exact | True | 46.111 |
| heldout-00436 | straddle / 12800 | [12787, 12813) | exact | True | 48.093 |
| heldout-00437 | straddle / 13312 | [13299, 13325) | exact | True | 48.478 |
| heldout-00438 | straddle / 13824 | [13811, 13837) | exact | True | 48.980 |
| heldout-00439 | straddle / 14336 | [14323, 14349) | exact | True | 51.379 |
| heldout-00440 | straddle / 14848 | [14835, 14861) | exact | True | 48.646 |
| heldout-00441 | straddle / 15360 | [15347, 15373) | exact | True | 48.653 |
| heldout-00442 | straddle / 15872 | [15859, 15885) | exact | True | 48.587 |

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

### boundary extraction: header / crlf-header (4)

* `heldout-00329`: {"id": "heldout-00329", "category": "crlf", "family": "crlf-header", "outcome": "partial_overlap", "expected_raw": "FRdFiMB82YM5!.:", "predicted": ["FRdFiMB82YM5"], "context": "Inspect the captured Windows request:\r\nAuthorization: Bearer FRdFiMB82YM5!.:\r\nX-Retry: 0\r\n"}
* `heldout-00332`: {"id": "heldout-00332", "category": "crlf", "family": "crlf-header", "outcome": "partial_overlap", "expected_raw": "unR67Ukme3DO!.:", "predicted": ["unR67Ukme3DO"], "context": "Inspect the captured Windows request:\r\nAuthorization: Bearer unR67Ukme3DO!.:\r\nX-Retry: 0\r\n"}
* `heldout-00335`: {"id": "heldout-00335", "category": "crlf", "family": "crlf-header", "outcome": "partial_overlap", "expected_raw": "JeO6GTuA6qpg!.:", "predicted": ["JeO6GTuA6qpg"], "context": "Inspect the captured Windows request:\r\nAuthorization: Bearer JeO6GTuA6qpg!.:\r\nX-Retry: 0\r\n"}

### boundary extraction: header / provider-failing-request (32)

* `heldout-00015`: {"id": "heldout-00015", "category": "provider-malformed", "family": "provider-failing-request", "outcome": "partial_overlap", "expected_raw": "AKIAIWFG!XSBQO5K64TW", "predicted": ["AKIAIWFG"], "context": " aws adapter request:\nGET /status HTTP/1.1\nAuthorization: Bearer AKIAIWFG!XSBQO5K64TW\nAccept: application/json\n"}
* `heldout-00018`: {"id": "heldout-00018", "category": "provider-malformed", "family": "provider-failing-request", "outcome": "partial_overlap", "expected_raw": "AKIAJIQ5!KRWHE5MFV6K", "predicted": ["AKIAJIQ5"], "context": " aws adapter request:\nGET /status HTTP/1.1\nAuthorization: Bearer AKIAJIQ5!KRWHE5MFV6K\nAccept: application/json\n"}
* `heldout-00021`: {"id": "heldout-00021", "category": "provider-malformed", "family": "provider-failing-request", "outcome": "partial_overlap", "expected_raw": "AKIANY2Z!UJGVW2Q2DFF", "predicted": ["AKIANY2Z"], "context": " aws adapter request:\nGET /status HTTP/1.1\nAuthorization: Bearer AKIANY2Z!UJGVW2Q2DFF\nAccept: application/json\n"}

### boundary extraction: shell-single / shell-single-cli (4)

* `heldout-00287`: {"id": "heldout-00287", "category": "shell-escapes", "family": "shell-single-cli", "outcome": "partial_overlap", "expected_raw": "starlit-QoE5eHZkmfP4'\\''east", "predicted": ["starlit-QoE5eHZkmfP4"], "context": "Run the test with --password 'starlit-QoE5eHZkmfP4'\\''east'\n"}
* `heldout-00290`: {"id": "heldout-00290", "category": "shell-escapes", "family": "shell-single-cli", "outcome": "partial_overlap", "expected_raw": "starlit-wylaU8K4FTnx'\\''east", "predicted": ["starlit-wylaU8K4FTnx"], "context": "Run the test with --password 'starlit-wylaU8K4FTnx'\\''east'\n"}
* `heldout-00293`: {"id": "heldout-00293", "category": "shell-escapes", "family": "shell-single-cli", "outcome": "partial_overlap", "expected_raw": "starlit-sCkOYHq44O6e'\\''east", "predicted": ["starlit-sCkOYHq44O6e"], "context": "Run the test with --password 'starlit-sCkOYHq44O6e'\\''east'\n"}

### boundary extraction: shell-single / shell-single-export (4)

* `heldout-00286`: {"id": "heldout-00286", "category": "shell-escapes", "family": "shell-single-export", "outcome": "partial_overlap", "expected_raw": "starlit-KrH5dIJBs5Vm'\\''east", "predicted": ["starlit-KrH5dIJBs5Vm"], "context": "Reproduce my shell setup:\nPASSWORD='starlit-KrH5dIJBs5Vm'\\''east'\n"}
* `heldout-00289`: {"id": "heldout-00289", "category": "shell-escapes", "family": "shell-single-export", "outcome": "partial_overlap", "expected_raw": "starlit-4vUo0o2rl5vw'\\''east", "predicted": ["starlit-4vUo0o2rl5vw"], "context": "Reproduce my shell setup:\nPASSWORD='starlit-4vUo0o2rl5vw'\\''east'\n"}
* `heldout-00292`: {"id": "heldout-00292", "category": "shell-escapes", "family": "shell-single-export", "outcome": "partial_overlap", "expected_raw": "starlit-cl9iOe4JA6XY'\\''east", "predicted": ["starlit-cl9iOe4JA6XY"], "context": "Reproduce my shell setup:\nPASSWORD='starlit-cl9iOe4JA6XY'\\''east'\n"}

### boundary extraction: shell-single / shell-single-handoff (4)

* `heldout-00288`: {"id": "heldout-00288", "category": "shell-escapes", "family": "shell-single-handoff", "outcome": "partial_overlap", "expected_raw": "starlit-19zVAG3tXgPM'\\''east", "predicted": ["starlit-19zVAG3tXgPM"], "context": "The working deployment snippet is:\nexport DB_PASSWORD='starlit-19zVAG3tXgPM'\\''east'\n"}
* `heldout-00291`: {"id": "heldout-00291", "category": "shell-escapes", "family": "shell-single-handoff", "outcome": "partial_overlap", "expected_raw": "starlit-0zFa3t0pUFEO'\\''east", "predicted": ["starlit-0zFa3t0pUFEO"], "context": "The working deployment snippet is:\nexport DB_PASSWORD='starlit-0zFa3t0pUFEO'\\''east'\n"}
* `heldout-00294`: {"id": "heldout-00294", "category": "shell-escapes", "family": "shell-single-handoff", "outcome": "partial_overlap", "expected_raw": "starlit-QifVtJZzPAg6'\\''east", "predicted": ["starlit-QifVtJZzPAg6"], "context": "The working deployment snippet is:\nexport DB_PASSWORD='starlit-QifVtJZzPAg6'\\''east'\n"}

### boundary extraction: yaml / yaml-literal-clip (4)

* `heldout-00341`: {"id": "heldout-00341", "category": "multiline", "family": "yaml-literal-clip", "outcome": "partial_overlap", "expected_raw": "  6rPDsJoFBt\n  XPTH5DVudg\n", "predicted": ["6rPDsJoFBt\n  XPTH5DVudg"], "context": "Inspect this YAML credential config:\npassword: |\n  6rPDsJoFBt\n  XPTH5DVudg\nretries: 2\n"}
* `heldout-00344`: {"id": "heldout-00344", "category": "multiline", "family": "yaml-literal-clip", "outcome": "partial_overlap", "expected_raw": "  n8fxMGkeFI\n  xXLgOJpF4S\n", "predicted": ["n8fxMGkeFI\n  xXLgOJpF4S"], "context": "Inspect this YAML credential config:\npassword: |\n  n8fxMGkeFI\n  xXLgOJpF4S\nretries: 2\n"}
* `heldout-00347`: {"id": "heldout-00347", "category": "multiline", "family": "yaml-literal-clip", "outcome": "partial_overlap", "expected_raw": "  tKfLdr5hek\n  oBbJz5ct9A\n", "predicted": ["tKfLdr5hek\n  oBbJz5ct9A"], "context": "Inspect this YAML credential config:\npassword: |\n  tKfLdr5hek\n  oBbJz5ct9A\nretries: 2\n"}

### boundary extraction: yaml / yaml-literal-strip (4)

* `heldout-00342`: {"id": "heldout-00342", "category": "multiline", "family": "yaml-literal-strip", "outcome": "partial_overlap", "expected_raw": "  bLmymrbQ8r\n  vZdxeyjA02\n", "predicted": ["bLmymrbQ8r\n  vZdxeyjA02"], "context": "Repair this YAML config loader:\npassword: |-\n  bLmymrbQ8r\n  vZdxeyjA02\nretries: 2\n"}
* `heldout-00345`: {"id": "heldout-00345", "category": "multiline", "family": "yaml-literal-strip", "outcome": "partial_overlap", "expected_raw": "  PSzB1zwYSU\n  EBqHrkh4fK\n", "predicted": ["PSzB1zwYSU\n  EBqHrkh4fK"], "context": "Repair this YAML config loader:\npassword: |-\n  PSzB1zwYSU\n  EBqHrkh4fK\nretries: 2\n"}
* `heldout-00348`: {"id": "heldout-00348", "category": "multiline", "family": "yaml-literal-strip", "outcome": "partial_overlap", "expected_raw": "  DXEsRFMlBp\n  m06nvJhG1s\n", "predicted": ["DXEsRFMlBp\n  m06nvJhG1s"], "context": "Repair this YAML config loader:\npassword: |-\n  DXEsRFMlBp\n  m06nvJhG1s\nretries: 2\n"}

### no detection: length / length-start (1)

* `heldout-00409`: {"id": "heldout-00409", "category": "length", "family": "length-start", "outcome": "missed", "expected_raw": "edge-q3oTpPkLI0bGdYdy102b!", "predicted": [], "context": "edge-q3oTpPkLI0bGdYdy102b!\nThe preceding line is the actual deployment password.\nbuild: ass"}

### no detection: meaningful-punctuation / password-terminal-colon (4)

* `heldout-00377`: {"id": "heldout-00377", "category": "meaningful-punctuation", "family": "password-terminal-colon", "outcome": "missed", "expected_raw": "gQWvSUe3o8mvXkc:", "predicted": [], "context": "assword enclosed in these quotes, including the last character: \"gQWvSUe3o8mvXkc:\". Investigate the authentication failure."}
* `heldout-00380`: {"id": "heldout-00380", "category": "meaningful-punctuation", "family": "password-terminal-colon", "outcome": "missed", "expected_raw": "S9SElfFsejpv4j6:", "predicted": [], "context": "assword enclosed in these quotes, including the last character: \"S9SElfFsejpv4j6:\". Investigate the authentication failure."}
* `heldout-00383`: {"id": "heldout-00383", "category": "meaningful-punctuation", "family": "password-terminal-colon", "outcome": "missed", "expected_raw": "WNNBzHf2HjQU9su:", "predicted": [], "context": "assword enclosed in these quotes, including the last character: \"WNNBzHf2HjQU9su:\". Investigate the authentication failure."}

### no detection: meaningful-punctuation / password-terminal-dot (4)

* `heldout-00376`: {"id": "heldout-00376", "category": "meaningful-punctuation", "family": "password-terminal-dot", "outcome": "missed", "expected_raw": "zq0JDEN7rtYaEzB.", "predicted": [], "context": "assword enclosed in these quotes, including the last character: \"zq0JDEN7rtYaEzB.\". Investigate the authentication failure."}
* `heldout-00379`: {"id": "heldout-00379", "category": "meaningful-punctuation", "family": "password-terminal-dot", "outcome": "missed", "expected_raw": "wBkYLFfsX99VOmO.", "predicted": [], "context": "assword enclosed in these quotes, including the last character: \"wBkYLFfsX99VOmO.\". Investigate the authentication failure."}
* `heldout-00382`: {"id": "heldout-00382", "category": "meaningful-punctuation", "family": "password-terminal-dot", "outcome": "missed", "expected_raw": "EsrlMXxysycrtPC.", "predicted": [], "context": "assword enclosed in these quotes, including the last character: \"EsrlMXxysycrtPC.\". Investigate the authentication failure."}

### no detection: meaningful-punctuation / password-terminal-semicolon (4)

* `heldout-00378`: {"id": "heldout-00378", "category": "meaningful-punctuation", "family": "password-terminal-semicolon", "outcome": "missed", "expected_raw": "eFJUawTtzZT5lgP;", "predicted": [], "context": "assword enclosed in these quotes, including the last character: \"eFJUawTtzZT5lgP;\". Investigate the authentication failure."}
* `heldout-00381`: {"id": "heldout-00381", "category": "meaningful-punctuation", "family": "password-terminal-semicolon", "outcome": "missed", "expected_raw": "heQyuMLK0D2M1AK;", "predicted": [], "context": "assword enclosed in these quotes, including the last character: \"heQyuMLK0D2M1AK;\". Investigate the authentication failure."}
* `heldout-00384`: {"id": "heldout-00384", "category": "meaningful-punctuation", "family": "password-terminal-semicolon", "outcome": "missed", "expected_raw": "KbxEXJpBFW3ESOy;", "predicted": [], "context": "assword enclosed in these quotes, including the last character: \"KbxEXJpBFW3ESOy;\". Investigate the authentication failure."}

### no detection: provider-malformed / provider-handoff (32)

* `heldout-00013`: {"id": "heldout-00013", "category": "provider-malformed", "family": "provider-handoff", "outcome": "missed", "expected_raw": "AKIATWKF!EM7VGSFZT4N", "predicted": [], "context": " integration to the staging tenant. The actual API credential is AKIATWKF!EM7VGSFZT4N\nUse it for the acceptance check."}
* `heldout-00016`: {"id": "heldout-00016", "category": "provider-malformed", "family": "provider-handoff", "outcome": "missed", "expected_raw": "AKIAEQPO!BJLNS3F5OM2", "predicted": [], "context": " integration to the staging tenant. The actual API credential is AKIAEQPO!BJLNS3F5OM2\nUse it for the acceptance check."}
* `heldout-00019`: {"id": "heldout-00019", "category": "provider-malformed", "family": "provider-handoff", "outcome": "missed", "expected_raw": "AKIAKV3S!5KZY3F3S5TP", "predicted": [], "context": " integration to the staging tenant. The actual API credential is AKIAKV3S!5KZY3F3S5TP\nUse it for the acceptance check."}

### no detection: shell-escapes / shell-curl-double (4)

* `heldout-00274`: {"id": "heldout-00274", "category": "shell-escapes", "family": "shell-curl-double", "outcome": "missed", "expected_raw": "moon-WmRYEHLwKm\\\"\\$HOME\\`id\\`\\\\end", "predicted": [], "context": "Fix this curl command:\ncurl -u \"builder:moon-WmRYEHLwKm\\\"\\$HOME\\`id\\`\\\\end\"\n"}
* `heldout-00277`: {"id": "heldout-00277", "category": "shell-escapes", "family": "shell-curl-double", "outcome": "missed", "expected_raw": "moon-7SEILX3GXL\\\"\\$HOME\\`id\\`\\\\end", "predicted": [], "context": "Fix this curl command:\ncurl -u \"builder:moon-7SEILX3GXL\\\"\\$HOME\\`id\\`\\\\end\"\n"}
* `heldout-00280`: {"id": "heldout-00280", "category": "shell-escapes", "family": "shell-curl-double", "outcome": "missed", "expected_raw": "moon-tcIEIiCJaI\\\"\\$HOME\\`id\\`\\\\end", "predicted": [], "context": "Fix this curl command:\ncurl -u \"builder:moon-tcIEIiCJaI\\\"\\$HOME\\`id\\`\\\\end\"\n"}

### no detection: trailing-punctuation / punctuation-prose (8)

* `heldout-00193`: {"id": "heldout-00193", "category": "trailing-punctuation", "family": "punctuation-prose", "outcome": "missed", "expected_raw": "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", "predicted": [], "context": "Use this Hugging Face credential: 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.\nThen verify the returned model list."}
* `heldout-00196`: {"id": "heldout-00196", "category": "trailing-punctuation", "family": "punctuation-prose", "outcome": "missed", "expected_raw": "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", "predicted": [], "context": "Use this Hugging Face credential: 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.\nThen verify the returned model list."}
* `heldout-00199`: {"id": "heldout-00199", "category": "trailing-punctuation", "family": "punctuation-prose", "outcome": "missed", "expected_raw": "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", "predicted": [], "context": "Use this Hugging Face credential: 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,\nThen verify the returned model list."}

### no detection: trailing-punctuation / punctuation-review (8)

* `heldout-00194`: {"id": "heldout-00194", "category": "trailing-punctuation", "family": "punctuation-review", "outcome": "missed", "expected_raw": "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", "predicted": [], "context": "Review comment: retry with token (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.\nThen verify the returned model list."}
* `heldout-00197`: {"id": "heldout-00197", "category": "trailing-punctuation", "family": "punctuation-review", "outcome": "missed", "expected_raw": "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", "predicted": [], "context": "Review comment: retry with token (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.\nThen verify the returned model list."}
* `heldout-00200`: {"id": "heldout-00200", "category": "trailing-punctuation", "family": "punctuation-review", "outcome": "missed", "expected_raw": "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", "predicted": [], "context": "Review comment: retry with token (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,\nThen verify the returned model list."}

### no detection: unicode / unicode-chat (4)

* `heldout-00317`: {"id": "heldout-00317", "category": "unicode", "family": "unicode-chat", "outcome": "missed", "expected_raw": "clé-BChSMZ3🔐é.終", "predicted": [], "context": "��い 🔧 The literal password, including its punctuation, is «clé-BChSMZ3🔐é.終». Merci."}
* `heldout-00320`: {"id": "heldout-00320", "category": "unicode", "family": "unicode-chat", "outcome": "missed", "expected_raw": "clé-0Zl2Gof🔐é.終", "predicted": [], "context": "��い 🔧 The literal password, including its punctuation, is «clé-0Zl2Gof🔐é.終». Merci."}
* `heldout-00323`: {"id": "heldout-00323", "category": "unicode", "family": "unicode-chat", "outcome": "missed", "expected_raw": "clé-lGq5zvU🔐é.終", "predicted": [], "context": "��い 🔧 The literal password, including its punctuation, is «clé-lGq5zvU🔐é.終». Merci."}

### no detection: weak-password / weak-password-incident (9)

* `heldout-00237`: {"id": "heldout-00237", "category": "weak-password", "family": "weak-password-incident", "outcome": "missed", "expected_raw": "example", "predicted": [], "context": "Incident handoff: the temporary operator password was set to `example`. Use that exact value to reproduce ticket 2."}
* `heldout-00240`: {"id": "heldout-00240", "category": "weak-password", "family": "weak-password-incident", "outcome": "missed", "expected_raw": "example", "predicted": [], "context": "Incident handoff: the temporary operator password was set to `example`. Use that exact value to reproduce ticket 5."}
* `heldout-00243`: {"id": "heldout-00243", "category": "weak-password", "family": "weak-password-incident", "outcome": "missed", "expected_raw": "example", "predicted": [], "context": "Incident handoff: the temporary operator password was set to `example`. Use that exact value to reproduce ticket 8."}

## Timing and host conditions

Measurement plan was written before executing the detector: measurement-plan.md. Fixed GOMAXPROCS=4 and GOTOOLCHAIN=local. One persistent process; 10 unmeasured warmups per exact-limit case, then 100 round-robin scans per case (3,400 measured scans). Python perf_counter_ns records evaluator pipe/JSON round trips, Go monotonic timers record Scan calls. Both are helper-only. Clean diagnostic repeats the public build-log line, truncated to 16,384 ASCII bytes; 10 warmups and 100 measured scans, excluded from frozen accuracy. Four fixed goroutine workers run 100 synchronous scans each with no backlog. Ten fresh binary processes measure cold first-call Scan and launch-through-response time; compilation is excluded. No optional inference.

```json
{
  "warm_scan": {
    "n": 3400,
    "p50_ms": 25.729692,
    "p95_ms": 49.090541,
    "p99_ms": 58.736952,
    "max_ms": 97.636763
  },
  "warm_evaluator_roundtrip": {
    "n": 3400,
    "p50_ms": 26.043429,
    "p95_ms": 49.437637,
    "p99_ms": 60.074579,
    "max_ms": 98.03491
  },
  "clean_scan": {
    "n": 100,
    "p50_ms": 28.418425,
    "p95_ms": 35.144097,
    "p99_ms": 39.778664,
    "max_ms": 42.090923
  },
  "clean_evaluator_roundtrip": {
    "n": 100,
    "p50_ms": 28.821137,
    "p95_ms": 35.543406,
    "p99_ms": 40.171888,
    "max_ms": 42.502588
  },
  "cold_scan": {
    "n": 10,
    "p50_ms": 70.952392,
    "p95_ms": 93.672616,
    "p99_ms": 93.672616,
    "max_ms": 93.672616
  },
  "cold_launch_through_response": {
    "n": 10,
    "p50_ms": 77.883582,
    "p95_ms": 99.476671,
    "p99_ms": 99.476671,
    "max_ms": 99.476671
  },
  "four_worker_scan": [
    {
      "n": 100,
      "p50_ms": 46.420051,
      "p95_ms": 89.961242,
      "p99_ms": 107.79458,
      "max_ms": 124.688962
    },
    {
      "n": 100,
      "p50_ms": 47.473564,
      "p95_ms": 97.899475,
      "p99_ms": 110.310369,
      "max_ms": 133.046783
    },
    {
      "n": 100,
      "p50_ms": 45.808308,
      "p95_ms": 89.053734,
      "p99_ms": 102.09972,
      "max_ms": 113.08564
    },
    {
      "n": 100,
      "p50_ms": 45.363647,
      "p95_ms": 78.085147,
      "p99_ms": 94.08516,
      "max_ms": 98.080425
    }
  ],
  "rss": {
    "post_exec_proc_status_peak_kib": 22144,
    "rusage_caveat": "RUSAGE_SELF is already 22648 KiB before first Scan while initial /proc VmHWM is 8612 KiB. A launch/pre-exec high-water mark appears retained. Use RUSAGE as a conservative upper bound; post-exec VmHWM is reported separately, without subtraction.",
    "absolute_peak_kib": 22648,
    "persistent_peak_kib": 22648,
    "cold_peak_kib": [
      22648,
      22648,
      22648,
      22648,
      22648,
      22648,
      22648,
      22648,
      22648,
      22648
    ],
    "four_worker_baseline": {
      "VmHWM:": 20460,
      "VmRSS:": 20460,
      "ru_maxrss_kib": 22648
    },
    "four_worker_after": {
      "VmHWM:": 22144,
      "VmRSS:": 22144,
      "ru_maxrss_kib": 22648
    },
    "conservative_peak_minus_idle_current_kib": 2188,
    "four_worker_high_water_increase_kib": 0,
    "accounting": "Linux RUSAGE_SELF, entire isolated Go test process, no child-process RSS, no runtime/interpreter subtraction; Python driver and build excluded"
  },
  "runtime": {
    "cpus": 12,
    "go": "go1.27.0",
    "gomaxprocs": 4,
    "memory": {
      "VmHWM:": 8612,
      "VmRSS:": 8612,
      "ru_maxrss_kib": 22648
    }
  }
}
```

RUSAGE_SELF peak memory includes the entire isolated Go test process and harness, with no subtraction; children excluded. Driver Python and compiler are not part of detector process RSS. Concurrent peak-minus-current-baseline is a conservative upper bound, including runtime growth; both current and high-water baselines are retained. Instrumentation overhead and shared-host contention remain in the timing samples.

### host_start

UTC 2026-10-18T16:09:33Z; OS {'system': 'Linux', 'node': 'kiswe-omarchy', 'release': '7.2.8-9-omarchy', 'version': '#1 SMP PREEMPT_DYNAMIC Sat, 17 Oct 2026 22:09:33 +0000', 'machine': 'x86_64', 'processor': ''}; affinity [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]; load averages [8.033203125, 8.39404296875, 6.0341796875]; MemAvailable 15762264 kB; SwapFree 65518048 kB.

CPU pressure:
```
some avg10=3.19 avg60=7.34 avg300=9.51 total=152113394
full avg10=0.00 avg60=0.00 avg300=0.00 total=0
```
Memory pressure:
```
some avg10=0.00 avg60=0.00 avg300=0.00 total=74313
full avg10=0.00 avg60=0.00 avg300=0.00 total=72948
```
### host_end

UTC 2026-10-18T16:11:44Z; OS {'system': 'Linux', 'node': 'kiswe-omarchy', 'release': '7.2.8-9-omarchy', 'version': '#1 SMP PREEMPT_DYNAMIC Sat, 17 Oct 2026 22:09:33 +0000', 'machine': 'x86_64', 'processor': ''}; affinity [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]; load averages [11.24609375, 8.79296875, 6.44970703125]; MemAvailable 12982900 kB; SwapFree 65518048 kB.

CPU pressure:
```
some avg10=26.40 avg60=13.98 avg300=10.59 total=168652962
full avg10=0.00 avg60=0.00 avg300=0.00 total=0
```
Memory pressure:
```
some avg10=0.00 avg60=0.00 avg300=0.00 total=74314
full avg10=0.00 avg60=0.00 avg300=0.00 total=72948
```

CPU model, topology, /proc/stat CPU contention counters, full memory snapshots and affinity are preserved in measurements.json and results.json. Phase-1 declared machine: Intel i7-10750H, 6 cores / 12 logical CPUs, approximately 31 GiB RAM. Dynamic availability is reported at measurement start and end.

## Reproduction and artifacts

Run `/home/jeff/.local/state/write-code/runs/20261018-1321-secrets/eval/phase2/run.sh [checkout]` to rebuild the same external overlay harness and repeat against another requested SHA. Exact commands and environment overrides are in commands.json; build output is in build.log; all raw timings and observations in measurements.json; per-prompt/per-secret classifications, aggregates and gates in results.json; independent recomputation and frozen-hash/protocol validation in verify_results.py and verification.json. Frozen artifacts are checked before building and after measurements. The checkout is checked clean at both ends. Report generation alone: `python3 -I /home/jeff/.local/state/write-code/runs/20261018-1321-secrets/eval/phase2/analyze.py`.

This is detector evidence, not a release signoff. Integration delivery gates and a real usability study remain separate.
