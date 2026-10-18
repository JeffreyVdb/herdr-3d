# Held-out evaluation: results per detector revision (#108)

An independent evaluator wrote this corpus and froze its targets (`targets.md`, `freeze.json`) before the detector
existed, then ran phase 2 against the detector through `Scan(text, nil)` only (`harness/`). The corpus is not committed:
`python3 -I generate.py` regenerates it byte for byte (the frozen SHA-256s in `freeze.json` and `manifest.json` check
it). Re-run on any checkout with `harness/run.sh [<checkout>]` (default: this repository); it writes its results next to
the harness (git-ignored).

The detector was tuned between runs from cause descriptions only; the tuning coders never read this folder. The
categories whose causes were described to them (trailing punctuation, symbols inside credentials, shell escapes, quoted
prose passwords, placeholder-looking values) are therefore no longer fully independent evidence after the first run.

| Revision | Exact occurrences (in-limit) | Partial overlaps | Missed | False highlights on 320 clean prompts | Warm 16 KiB scan p50 / p95 (helper only, shared host) |
|---|---|---|---|---|---|
| `665b3d5` (round 1, first frozen detector) | 338 / 478 (70.7%) | 62 | 78 | 0 | 25.7 / 49.1 ms |
| `6aced52` (tuning) | 460 / 478 (96.2%) | 14 | 4 | 0 | 20.2 / 22.2 ms |
| `bc09045` (tuning fix 1) | 462 / 478 (96.7%) | 14 | 2 | 0 | 25.0 / 51.6 ms |
| `daa49b5` (tuning fix 2) | 464 / 478 (97.1%) | 14 | 0 | 0 | 21.2 / 37.6 ms |
| `256aacc` (tuning fix 3) | 464 / 478 (97.1%) | 14 | 0 | 0 | 21.1 / 36.4 ms |
| `acc9bc5` (final) | 464 / 478 (97.1%) | 14 | 0 | 0 | 25.9 / 40.8 ms |

The 14 remaining partial overlaps are two decided byte policies, not detector misses (decisions.md #108 row 5, decided by
the user on 2026-10-18): a YAML block scalar is proposed from its first content character to its last (8 cases; the
prompt keeps its YAML shape after replacement), and a connection string proposes its password only (6 cases; the user can
widen the range in the review). Counting those as the policy intends, every in-limit occurrence is found exactly.

Gates the detector API cannot measure stay UNMEASURED in every report: product rejection of over-limit prompts (the bridge
refuses `worker.prompt` over 16 KiB and `prompt_secrets.scan` over 32 KiB before `Scan` runs), complete-pipeline latency
with IPC, the scan timeout, real file bytes, and the review's usability. Timings are helper-only on a shared host
(i7-10750H, `host-lscpu.txt`) with other agents running; treat differences of a few milliseconds between runs as noise.

Reports: `reports/665b3d5-report.md` (the first run, with every miss grouped by cause) and `reports/acc9bc5-report.md`
(the final run).
