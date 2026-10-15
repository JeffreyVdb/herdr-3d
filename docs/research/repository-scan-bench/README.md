# Repository discovery benchmark

Implementation ticket: [#54](https://github.com/JeffreyVdb/herdr-3d/issues/54).

Measured 2026-10-15 on the requested local directories, Linux 6.12.0-211.38.1.el10_2.x86_64, Go 1.27. The first
sections are the research harness (no product code); [Production measurements](#production-measurements-54) are the
shipped `internal/repodisc` on the same roots.

## Method and results

The Go harness checks `<directory>/.git` with `Lstat` **before** enumerating the directory. A directory or regular-file marker is a candidate checkout; stop there. Recursively enumerate only grouping directories above checkouts. Do not follow child directory symlinks. No dependency-name exclusions, fixed depth, network requests, or Git commands per ordinary directory. Deduplicate repeated directory paths across roots. Validate candidates with `git rev-parse --show-toplevel`, then read origins using `git remote get-url origin`, with bounded concurrency and a two-second timeout per command.

| Roots | Candidates / valid | Discovery median / p95 | Metadata median, 1 worker | 4 workers | 8 workers |
| --- | --- | --- | --- | --- | --- |
| `/home/jeff/devel/jeffreyvdb` | 34 / 34 | 0.163 / 0.227 ms | 178.806 ms | 49.088 ms | 28.673 ms |
| `/home/jeff/devel/kiswe` | 101 / 100 | 34.455 / 38.126 ms | 591.573 ms | 159.742 ms | 87.368 ms |
| Both roots | 135 / 134 | 34.478 / 36.828 ms | 781.522 ms | 214.503 ms | 115.079 ms |

These are separate stage timings: discovery plus eight-worker metadata is approximately **150 ms** for both roots (sum of medians, not a measured end-to-end percentile). Combined-root discovery read 1,826 grouping directories / 17,515 entries, without listing checkout contents. Of 135 markers, 74 were regular files, mainly worktrees. One marker did not validate. Of 134 valid checkouts, 112 have an origin and 22 have none. A separate inventory using absolute `git-common-dir` and normalized GitHub origins identified **61 repository identities**. That identity inventory is not included in the timed metadata stage.

For comparison, `find <root> -name .git -prune -print`, which still descends checkout contents, took **8.684 s** on the personal root (34 markers); Kiswe exceeded a **30 s** timeout. The baseline explores inside checkouts; it can find nested repositories the boundary-pruned scanner intentionally excludes. Its Kiswe count is unknown because it timed out. This is a comparison of traversal policies, not proof of equal coverage.

Discovery runs once followed by 20 warm iterations; report warm median and nearest-rank p95. Metadata runs five times per worker count, with median and maximum in [results.jsonl](results.jsonl). Each root and then both roots are measured in order, so caches/load differ: the combined run can be faster than a preceding single-root run. No OS cache flushing, controlled cold-cache measurement, CPU profiling, or filesystem-wide correctness oracle was attempted. Baseline traversal and the first harness run also warmed filesystem caches. Aggregate measurements reveal no repository names or origin credentials.

## Scope and recommendation

Use this algorithm in an asynchronous bridge-owned catalog, with **eight metadata workers initially**, one scan at a time, immutable cached results, and a **configurable ten-minute default**. Aim for **under one second** for warm discovery + validation + identity merging on these roots, while serving completion immediately from the previous snapshot. The measured stage sum leaves room for identity merging, status reporting, and disk contention; it is not a production latency guarantee. No watcher is needed for a ten-minute schedule.

Repository-boundary pruning is essential to the measured speed. It discovers arbitrarily nested grouping directories and `.git`-file worktrees, but does **not** search inside a checkout for embedded repositories/submodules. Add those paths as explicit additional roots when needed; explicitly configured roots are always scanned even when inside another root's checkout. Bare repositories without a `.git` marker are outside this initial working-checkout scope. Document both choices in Settings/help. Do not add arbitrary dependency-folder exclusions unless their coverage tradeoff is separately approved and measured.

Production must additionally canonicalize explicit roots and checkout paths (including symlink aliases), normalize repository identities without conflating same-name repos, clear inherited Git context as existing Git helpers do, cancel obsolete scans, bound pathological traversal duration, and report per-root errors. The harness is intentionally a small research comparison, not the production service.

## Production measurements (#54)

Measured 2026-10-15 with the shipped `internal/repodisc` code, same host, warm cache, other agents' work running
(load average ≈ 0.7 for run 1, ≈ 4 for runs 2–4). `TestBenchRoots` times the whole production scan the service
runs: the boundary walk, `git rev-parse --path-format=absolute --show-toplevel --git-common-dir` and
`git remote get-url origin` per candidate through `gitops` (8 workers, 2 s timeout each, clean environment), the
per-root assembly, and the identity merge into a `Catalog`. One warm-up scan, then 20 timed ones per row; four runs
([production-results.jsonl](production-results.jsonl)).

| Roots | Candidates / valid | Not main (worktrees, submodules) | With origin | Repositories | Median | p95 | Max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/home/jeff/devel/jeffreyvdb` | 34 / 34 | 9 | 19 | 25 | 29.3–31.2 ms | 30.1–33.5 ms | 49.5 ms |
| `/home/jeff/devel/kiswe` | 101 / 100 | 64 | 93 | 36 | 126.9–145.1 ms | 130.4–151.4 ms | 152.3 ms |
| Both roots | 135 / 134 | 73 | 112 | **61** | **151.5–168.9 ms** | 155.1–176.0 ms | 182.3 ms |

The target, **under one second for a warm combined scan including validation, metadata and identity merging**, holds
with a wide margin (≈ 0.17 s worst median). Git work is bounded: at most 8 calls at once (asserted in
`TestServiceCancel`), only for the 135 candidates, never per ordinary directory.

Coverage is the research harness's: the same 1,826 grouping folders and 17,515 entries read, the same 135 candidates,
the one candidate that is not a checkout of its own dropped, and the same **61 repository identities** (the harness
counted them in a separate inventory). The harness's 74 `.git` file markers are 73 non-main checkouts here: the
invalid candidate had a `.git` file. Production adds what the harness lacked, none of which changes these counts:
explicit roots are resolved (`EvalSymlinks`) and an alias walked once; a symlinked `.git` also counts as a marker
(it stops the walk; git then decides); a candidate's top level must be itself (resolved), else it is dropped; the
inherited `GIT_DIR` family is cleared; the scan is bounded (a minute) and cancellable. A walk of one root at a time
(rather than a shared visited set) is what lets an explicit root inside another root's checkout always be scanned.

To reproduce:

```sh
H3D_REPODISC_BENCH=/home/jeff/devel/jeffreyvdb:/home/jeff/devel/kiswe go test -count=1 -run TestBenchRoots -v ./internal/repodisc
```

## Reproduce

From the repository root:

```sh
go build -o /tmp/herdr-repository-scan ./docs/research/repository-scan-bench
/tmp/herdr-repository-scan /home/jeff/devel/jeffreyvdb /home/jeff/devel/kiswe
```

Temporary-fixture checks also passed: empty root; cloning a repository after the first scan; grouped worktree with a `.git` file; ignored symlink alias; overlapping roots without duplicated paths; worktree deletion reflected on rescan; candidate validation. Fixture repositories were removed afterward. The harness compiled successfully; production tests were not run because no application code changed.

See [architecture findings](../repository-discovery-architecture.md) for integration points and acceptance criteria.
