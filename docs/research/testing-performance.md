# Testing performance investigation

Ticket: [#241 — Reduce CI and E2E feedback time](https://github.com/JeffreyVdb/herdr-3d/issues/241).

Research date: 2026-10-10. Local checkout: `ad3db71b76ceef621a6edb0c62d68cdc309be8b0`.
Web research used the requested Alterlab MCP and first-party documentation. No implementation changes are part of this investigation.

## Finding

Optimize the existing Go/Vitest CI and the Playwright suite as separate workloads. The checked-in GitHub workflows **do not run Playwright**: [ci.yml](../../.github/workflows/ci.yml) runs Go, Vitest and shell checks; [release.yml](../../.github/workflows/release.yml) runs those checks followed by release builds. [Makefile](../../Makefile) defines `game-test` as Vitest and exposes Playwright separately through `make e2e`. Faster browser software alone cannot shorten these existing Actions runs.

Keep Playwright initially. The suite already uses test-level parallelism, but software-rendered WebGL makes additional workers compete for CPU. Independent-machine sharding is a promising next experiment; a framework rewrite has no demonstrated benefit for this repository.

## Measured baseline

Two successful Actions runs at the same commit, `12c0e9fd450b93b2a7f30bd3e1ed25c8768854a4`, establish the observed bottlenecks. These are individual observations, not p50/p95 estimates. Job steps overlap between CI jobs; do not add every table cell to derive workflow duration.

| Measurement | [CI run 38036209695](https://github.com/JeffreyVdb/herdr-3d/actions/runs/38036209695) | [Release run 38036484952](https://github.com/JeffreyVdb/herdr-3d/actions/runs/38036484952) |
| --- | ---: | ---: |
| Workflow duration | 6m 13s | 8m 40s |
| Go lint / combined release lint | 30s | 39s |
| Go tests / combined release tests | 211s | 327s |
| Build | 94s | 98s |
| Game lint | 8s | Included above |
| Game test step | 96s | Included above |
| Vitest reported duration | 94.31s | 113.16s |
| `internal/server` package | 170.726s | 170.709s |

Both runs had Go and pnpm cache hits. The CI Vitest run reported 207 files and 2,673 tests; its reported phase-time distribution was approximately environment 41%, tests 38%, import 15%, transform 6% and worker startup 1% (rounding). These phase totals describe aggregate work and can overlap; they are not a serial decomposition of the 94.31s elapsed time. [game/vite.config.ts](../../game/vite.config.ts) defaults to Node; DOM test files explicitly select jsdom.

A fresh local `go test -json -count=1 ./internal/server` passed all 408 top-level tests in 179.753s package time / 185.61s command wall time. The temporary raw captures were `/tmp/herdr-server-tests.jsonl` and `/tmp/herdr-server-time.txt`.

| Slow local top-level test | Duration |
| --- | ---: |
| `TestPromptEchoLatency` | 16.22s |
| `TestAsyncSendRecordInvariant` | 12.33s |
| `TestActivityModelOptIn` | 8.25s |
| `TestActivityModelBudget` | 7.57s |

There are no `t.Parallel()` calls in `internal/server`. [activity_test.go](../../internal/server/activity_test.go) repeatedly sleeps for `transcript.LabelHold` or twice that duration; [activity.go](../../internal/transcript/activity.go) sets the hold to 1.5s. Faster CPUs will not eliminate those fixed waits. Some latency tests deliberately exercise the real system and must retain meaningful wall-clock coverage.

A temporary Go overlay added `t.Parallel()` to only the four tests listed above, without modifying repository source. Running those four tests took **44.347s serially versus 16.300s in parallel** (45.90s versus 20.83s command wall time). A race-detector run of the parallel variant also passed (22.214s package time). This demonstrates a useful isolation-audit direction; it is not a full-suite speedup claim. Evidence: `/tmp/herdr-go-selected-{baseline,parallel}.jsonl`, `/tmp/herdr-go-selected-race.log`, and `/tmp/herdr-go-parallel-overlay/overlay.json`.

The current Playwright inventory lists 453 tests across 70 files, including optional/skipped coverage. [CONTRIBUTING.md](../../CONTRIBUTING.md) documents approximately 7.5 minutes for a full local suite. That is an existing estimate, **not a newly measured full-suite baseline**. Subset benchmarks cannot establish the full-suite latency or flake rate.

## Changes worth testing

### 1. Shorten the existing CI critical path

* Audit Go fixtures for isolation, then add `t.Parallel()` only where ports, temporary files, environment and shared server state are independent. Package parallelism already occurs through `go test ./...`; the bottleneck is serial work within `internal/server`. Validate selected changes with the race detector and repeated runs.
* Move extensive timer/hold semantics to an injected clock or test-configurable durations, following the existing clock-driven transcript tests. Preserve a small real-time latency/integration smoke test. Go's [`testing/synctest`](https://pkg.go.dev/testing/synctest) supports fake time for isolated concurrency, but real network/file I/O does not participate in its durable-blocking model. Do not blanket-wrap the real-socket server tests and assume their waits become virtual.
* Investigate the 94-second Go build and build-cache freshness. The logs show the same dependency-keyed cache hit in CI and release. [setup-go cache-save source](https://github.com/actions/setup-go/blob/main/src/cache-save.ts) skips saving on an exact primary-key hit; [cache-restore source](https://github.com/actions/setup-go/blob/main/src/cache-restore.ts) derives the key from platform, architecture, toolchain and dependency-file hash. Thus an unchanged dependency key does not prove recent application or Darwin cross-build entries are cached. Benchmark a separately refreshed, source/toolchain/target-keyed `GOCACHE` with restore prefixes and bounded retention; cache staleness is a hypothesis here, not an established cause of all 94 seconds.
* Run Vitest's performance diagnostic and compare worker counts and pools before changing configuration. Official [Vitest performance guidance](https://vitest.dev/guide/improving-performance.html) identifies environment setup and isolation as costs, provides `vitest doctor`, and describes pool/isolation tradeoffs. Version 5.0.2 is installed here; its local CLI help confirms the `doctor` command. Benchmark Node-only and jsdom files separately; any isolation opt-out, VM pool or DOM implementation change needs compatibility and state-leak validation.
* Parallelize independent release validation branches while keeping publication gated on all checks for the exact tag SHA. Go tests and Vitest need not execute serially merely because they currently share one release job. Keep game building before embedding the bundle into the helper; preserve tag validation, version assertions and checksums.

### 2. Scale Playwright across independent machines

[game/playwright.config.ts](../../game/playwright.config.ts) pins Chromium, six workers by default, `fullyParallel: true`, 120s timeout and zero retries. Every test owns its page, and `H3D_WORKERS` permits a sweep. Chromium renders WebGL2 through ANGLE/Vulkan and Mesa llvmpipe on these CPU-only hosts. [Makefile](../../Makefile) uses a host-wide `flock` because competing suite processes degrade frame rate; retain that lock and portlease.

Playwright's official [sharding documentation](https://playwright.dev/docs/test-sharding) supports `--shard=N/M`, test-level distribution with `fullyParallel`, and merging blob reports. Its built-in balancing uses test counts, not historical test durations. Separate machines avoid the existing host-lock bottleneck.

Start with a 2/4/8-shard matrix and 1–2 workers per private hosted runner. On larger machines, sweep 2/4/6 workers before choosing a default. Playwright's [CI guidance](https://playwright.dev/docs/ci) recommends one worker for resource-constrained CI and sharding for wider parallelism. Six software-rendering browsers on a small runner should be measured, not assumed optimal.

Build the app once for the tested SHA, then reuse the immutable bundle across shards. Today `make e2e` depends on `game-build`, so directly launching that target in every shard rebuilds it. Provide a supported path to run the suite against the prepared artifact while retaining locking and leased ports. Install the browser matching the pinned Playwright version explicitly: this repository exports `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, which assumes a prepared browser cache. Follow [Playwright's browser installation guidance](https://playwright.dev/docs/browsers). Its [CI guidance](https://playwright.dev/docs/ci) generally discourages caching browser binaries because restore cost can rival downloading and OS dependencies still need installation.

Include a renderer-thread experiment in the worker sweep: Mesa documents [`LP_NUM_THREADS`](https://docs.mesa3d.org/envvars.html) as the software-renderer thread count (default: CPU core count). Multiple browsers can therefore create competing renderer pools. Benchmark an explicit limit alongside the default; do not assume a limit improves this Vulkan/ANGLE path. Shader-cache state also needs to be recorded when interpreting repeated render timings.

Collect per-test duration and status as JSON plus a blob report per shard. Retain failure traces/screenshots and merge reports into one inspectable result. Separate rendering/visual/performance contracts from DOM/state contracts when coverage genuinely allows it; blanket disabling of rendering would invalidate this game's tests. Preserve all existing correctness assertions and do not mask new flakes by adding retries.

### 3. Evaluate hardware and orchestration without rewriting tests

This is a private repository under a personal account. GitHub's [hosted-runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) lists the standard private Linux runner as 2 vCPU / 8GB, versus 4 vCPU / 16GB for public repositories. Larger GitHub-hosted runners require an eligible organization plan. Account eligibility constrains a direct runner upgrade.

| Option | Assessment |
| --- | --- |
| Native Playwright sharding | First choice: existing framework, independent runner capacity, no test rewrite. |
| Modern x86 AWS test runner | Benchmark the existing app and suite on m8a/m8i; compare elapsed time and total cost, including provisioning. CPU-only rendering still competes for cores. |
| Graviton c9g runner | Potential price/performance experiment, but ARM changes architecture. Validate the full toolchain and pinned Chromium/OS support before treating it as interchangeable. |
| Currents orchestration | [Currents documents](https://docs.currents.dev/guides/ci-optimization/playwright-parallelization) duration-aware scheduling with the existing Playwright tests. Consider if native shards leave a measurable long tail; vendor speed claims are not repository benchmarks. |
| Depot | [Depot GitHub Actions runners](https://depot.dev/docs/github-actions/overview) require a GitHub organization, so they are not directly eligible for this personal repository. Depot CI is a separate product with personal-account support; assess migration effort separately. |
| Cypress Cloud | [Cypress parallelization](https://docs.cypress.io/cloud/features/smart-orchestration/parallelization) balances spec files, but adopting it requires rewriting this Playwright suite. There is no evidence here of faster equivalent WebGL execution. Defer migration. |

## Hardware benchmark

The same built game, source snapshot, Playwright 1.61.1, Chromium 149.0.7827.55 and fixtures were tested on the current host and an depot-manager instance in `us-east-2`. The instance initially ran as `m8a.2xlarge`, then was resized to `m8i.8xlarge`. AWS could not supply `m8a.8xlarge` in the selected availability zone. The bundle entrypoint and Playwright configuration hashes matched on both hosts.

| Host | Exposed vCPUs | RAM | CPU |
| --- | ---: | ---: | --- |
| Current host | 32 | approximately 38 GiB | Intel Xeon E5-2660 v3 |
| m8a.2xlarge | 8 | 32 GiB | AMD EPYC 9R45 |
| m8i.8xlarge | 32 | 128 GiB | Intel Xeon 6975P-C; 16 cores / 32 threads |

These are **Playwright-reported execution durations**, including runner/preview startup but excluding app build, dependency/browser installation, machine boot and transfer. Each cell is one measured suite execution. The render test opens the actual game against recorded WebSocket fixtures and validates screenshots; the navigation set exercises the city and floor UI against fixtures. Both are browser E2E workloads with mocked backend data.

| Test subset, six workers, default renderer threads | Current host | m8a.2xlarge | m8i.8xlarge |
| --- | ---: | ---: | ---: |
| `shot.spec.ts`, repeated 12 times | 14.0s, 12/12 passed | 27.0s, 12/12 passed | 22.0s, 12/12 passed |
| `m2.spec.ts`, repeated twice (24 tests) | 42.6s, 24/24 passed | 29.5s, 24/24 passed | 25.6s, 24/24 passed |

For the equal-vCPU comparison, m8i navigation was about 40% shorter, while screenshots took about 57% longer. Newer CPU hardware is not a universal speedup at the same worker setting. The 8-vCPU m8a was also tried with two workers: screenshots took 12.4s (12/12 passed), navigation 39.2s (24/24 passed). On the current host, two-worker screenshots took 27.6s (12/12 passed); two-worker navigation took 94.6s with **23/24 passed**, failing the keyboard-focus assertion at `m2.spec.ts:123`. Keep that failed run in the evidence; do not use it as a clean speedup baseline. A separate current-host combined six-worker run of the two specs repeated twice passed all 26 tests in 48.5s.

The current host and Ubuntu 26.04 instance differ in OS/driver environment. Both reported ANGLE/Vulkan/Mesa llvmpipe with LLVM 21.1.8, but Vulkan versions differed (1.4.318 versus 1.4.335). Runs occurred sequentially, and shader caches were not cleared between them. Core topology, memory and background load also differ. These are directional environment comparisons, not controlled CPU-generation benchmarks or full-suite performance forecasts.

A follow-up changed only the renderer-thread setting to `LP_NUM_THREADS=2`, retaining six Playwright workers and the same two subsets:

| Test subset, six workers, `LP_NUM_THREADS=2` | Current host | m8i.8xlarge |
| --- | ---: | ---: |
| 12 render/screenshot tests | 15.0s, 12/12 passed | 6.9s, 12/12 passed |
| 24 navigation tests | 50.7s, 24/24 passed | 26.2s, 24/24 passed |

With identical explicit thread limits, the m8i run took about 54% less time for screenshots and 48% less for navigation. Against each host's best observed configuration, the current machine's default-thread baselines (14.0s screenshots / 42.6s navigation) compare with m8i's limited-thread screenshot result (6.9s) and default-thread navigation result (25.6s). Treat these best observations as candidate selection, not stable latency estimates. The limited-thread m8i screenshot follow-up took 6.9s versus the earlier 22.0s, while navigation was similar and current-host observations were slower. Because shader caches were not reset and configuration order was not alternated, this does not isolate the thread limit as the sole cause of the improvement. The effect is environment/workload-dependent; repeat cold/warm runs before adopting a default. Evidence: `/tmp/herdr-{shot,m2}-lp2-local.json` and `/tmp/herdr-m8i-lp2-results/`.

Reproduce the subsets with `H3D_WORKERS=6 make e2e SPEC='e2e/shot.spec.ts --repeat-each=12 --reporter=json'` and `H3D_WORKERS=6 make e2e SPEC='e2e/m2.spec.ts --repeat-each=2 --reporter=json'`. Use the JSON `stats.duration` to exclude Make build time. For a prepared artifact on the instance, the equivalent command ran through portlease and flock without rebuilding.

Evidence: `/tmp/herdr-shot-local.json`, `/tmp/herdr-m2-local.json`, `/tmp/herdr-shot-w2-local.json`, `/tmp/herdr-m2-w2-local.json`, `/tmp/herdr-remote-results/`, `/tmp/herdr-m8i-results/`, and `/tmp/herdr-run-{remote,large}-bench.sh`. Estimated EC2+root-disk rates from depot-manager were $0.4913/hour for m8a.2xlarge and $1.6978/hour for m8i.8xlarge; these are regional estimates, not the final billed spend. depot-manager confirmed the test instance terminated at 2026-10-10 18:53:59 UTC. The investigation leaves no running benchmark instance.

## Proposed implementation ticket and acceptance criteria

Implement in stages: timing instrumentation and Go wait reduction; Vitest profiling; release-job parallelism; then a Playwright shard/worker sweep and a runner selection based on measured cost. Keeping these stages separate makes their effects attributable.

Use the same SHA and pinned tools/Chromium for every comparison. Record host CPU/architecture/RAM, renderer, worker/shard count, cache state, build/setup/test duration, test inventory, failures and retries. Measure queue and cold-start time separately from execution. Compare cold and warm runs explicitly; disable Go's result cache for test benchmarks with `-count=1`. Run each shortlisted full configuration at least ten times; subset results only select candidates.

Suggested targets, subject to the measured full-suite baseline:

* Existing CI: p50 at most 3 minutes and p95 at most 4 minutes.
* Full Playwright suite: p50 at most 3 minutes and p95 at most 5 minutes, including required setup/build in the user-visible feedback measurement.
* Identical test inventory and correctness/visual assertions; no added skips or retry policy that conceals regressions. Track first-attempt failures and repeat-run flakes.
* Report total cost per passing run, not just the fastest shard. Sharding may reduce elapsed feedback while increasing aggregate runner minutes.

These are proposed product targets, not achieved results or promises. The first deliverable is a reproducible baseline and an agreed budget; the strongest measured bottleneck today is the Go server package, not Playwright in Actions.

## Results (stages 1–3)

Implemented on branch `h3d/241-ci-speed` from `573cf68`. Local numbers are from this host pinned to two CPUs
(`taskset -c 0,1 env GOMAXPROCS=2`, or `taskset -c 2,3` for Vitest) to approximate a 2-vCPU runner.

### Go: `internal/server`

| `taskset -c 0,1 env GOMAXPROCS=2 go test -count=1 -json ./internal/server` | Package time |
| --- | ---: |
| Base `573cf68` | 187.97s (3m09s wall; 22.5s user CPU) |
| Close-grace seam + activity clock, still serial | 125.63s |
| All but 12 tests `t.Parallel()` (two more turned serial later), `-parallel 2` (the 2-CPU default) | 78.17s |
| … `-parallel 4` / `8` / `16` / `32` | 52.77s / 42.61s / 39.94s / 39.09s |
| Adopted: `-parallel 8`, 14 serial, ten validation runs | 41.5–45.1s, all green |

What changed:

* `Serve` waited a fixed second for clients to answer its close handshake; test clients never do, so every bridge
  restart in a test cost 1s (about 60s of the package). It is now `Server.SetCloseGrace`, default
  `DefaultCloseGrace = 1s` unchanged; the test harness sets 20ms. The cut-off path still runs on each restart.
* The activity tests slept `transcript.LabelHold` (1.5s) or twice that, 15s in all. The bridge clock they already
  injected now moves on at once (`actBridge.wait`); a late tracker read falls back to the real hold. The
  production `LabelHold` is unchanged.
* Every top-level test calls `t.Parallel()` except 14 marked `// Not parallel:` (wall-clock bounds or rates,
  including the un-mocked `TestPromptEchoLatency`; `TestNoTCPListener`, which reads the whole process's sockets;
  `TestIssueGetCommentClose`, which counts polls). Serial tests run alone before the parallel ones. Each test
  already had its own bridge, store, socket and temp dirs. No test sets the environment or a package variable.
* `make go-test` passes `-parallel 8`. The tests wait rather than compute, so the 2-CPU default of 2 left most of the
  win unused. Only `internal/server` uses `t.Parallel()` today, so the flag affects nothing else.
* Under load, three tests exposed races with background work that already existed. Each now waits for that work,
  and their assertions are unchanged: `TestAsyncAnswerRecordedBeforeTheResponse` (restarted before reading its
  command's ack), `TestDigestOnTheWire` and `TestFollowupsSettings` (assumed the usage tracker's first read had
  landed). `TestFollowupsSettings` failed once serially under `-shuffle`, so the race did not depend on parallelism.
* A flake on main's CI (`TestHandoffStillLatest/replaced`, run 38075802606) came from ext4 reusing a freed inode.
  The test now writes the replacement file before renaming it over the original.

Validation, all on two CPUs: ten runs of `go test -count=1 -parallel 8 ./internal/server` after the last fix, five
of them with `-shuffle=on`, all passed (41.5–45.1s). `go test -race -count=3 ./internal/server` (unconstrained
host) passed in 438.6s with no races reported. On two CPUs, `-race -count=1 -timeout 30m` at the default
`-parallel` passed in 276.4s. One 2-CPU `-race -count=3 -parallel 8` run hit the default 10m timeout with one
failure: `TestHeldNamesAreRecycledOldestFirst` at `names_test.go:382`. That is the harness's 5s read in
`bridge.world` → `connect` → `snapshot` (`client.next`). The race-instrumented package wanted about 1.5 CPUs of
work on 2 CPUs (943s CPU in 623s), and the hub's snapshot reply missed 5s. Without `-race`, the package uses about
25% of two CPUs, and no 5s wait was missed in 25 runs at `-parallel 8` (the earlier failures in those runs were the three races above and `TestNoTCPListener`). CI does not run `-race`. Test timeouts were
not raised. These local runs exercise `./internal/server` alone; in CI, `go test ./...` shares the 2 vCPUs with
other packages, and the nine CI runs below are the evidence for that configuration (all green). `go test -list . ./internal/... ./cmd/...` lists the same 1170 names before and after.

### Go build and cache

setup-go's cache key hashes `go.sum` only, and it saves nothing after an exact hit. The entry in use dated from
2026-09-30, so every run recompiled whatever had changed since. The `-trimpath` linux build and the darwin
helper each compiled modernc sqlite again. On two cores, with only the test build cached, `make go-build` took 54s
and `make helper-darwin` 46s; fully warm, both took 0s.

`ci.yml`'s go job now turns setup-go's cache off and restores `GOCACHE`/`GOMODCACHE` with `actions/cache` (key: OS,
arch, hash of `go.mod`, `go.sum`, `Makefile` and the Go sources; restore prefix: OS and arch). Only pushes to main
and manual runs save a new entry. Branch pushes restore main's entry, so they do not churn the repository's 10 GB
cache. Go's own trim drops build entries unused for five days. The first main push after merge runs cold (about
5m on x64, about 3.5m on arm64) and saves the first entry.

### Vitest

`vitest doctor` on two cores (one run each): baseline forks + isolate 166.7s; `pool: 'threads'` 152.9s (−8%);
`isolate: false` **failed** (`src/render/deskArt.test.ts` sees state left by another file); `fsModuleCache` 165.2s
(−1%). Doctor recommended keeping the configuration.

Vitest's default is `maxWorkers` = CPUs − 1, which means **one worker** on a 2-core runner. Two-core sweep (wall
time of `vitest run`):

| Pool / workers | Runs |
| --- | --- |
| forks, default (1) | 193.7s, 191.0s, 187.8s |
| threads, default (1) | 172.7s, 164.1s, 164.7s |
| forks, 2 | 115.1s, 103.6s |
| threads, 2 | 117.4s, 102.2s |
| forks, 3 / threads, 3 | 114.0s, 113.9s / 136.5s, 108.8s |

Adopted: `maxWorkers: Math.max(2, availableParallelism() - 1)`. Bigger machines keep the default; the pool and
isolation are unchanged, since threads gave nothing over forks once there were two workers. With the new config
on two cores, 109.8s. Shuffling files (`--sequence.shuffle.files`, seeds 101/202/303) passed 3/3. A full shuffle
(files and tests) fails within files in `src/laptop/transcriptImages.test.ts` and `src/ui/overview.dom.test.ts`
(module-level counters / order-dependent cases). The 1-worker control with the same seed (2447) fails the same two
files, so the worker count did not cause it. Left as is: fixing it is not in scope. Inventory is unchanged at
211 files / 2,698 tests (re-measured at base; the ticket's 207 / 2,673 predates later commits).

### Release workflow

`release.yml` now runs as five jobs:

* `tag` checks the tag format and that the tag is on main, then pins the tag's SHA.
* `go`, `game` and `shell` check out that SHA and run the same make targets as `ci.yml`, side by side, on
  `ubuntu-26.04-arm`.
* `publish` needs all four. It refuses a tag that moved, builds `release-assets` (game before the embedding
  helper), asserts the version and SHA256SUMS, and publishes draft-then-final. Only `publish` gets
  `contents: write`.

`publish` stays on x64 `ubuntu-26.04`, so the version assertion runs the very `linux-amd64` binary that ships. On
arm64 it could only check a separate native build. It builds the Go code without a cache, because CI saves arm64
entries only. A release has not been run: tags publish, so the workflow was validated with actionlint 1.7.12 only.
That version does not know the 26.04 labels yet, so `-ignore 'label "ubuntu-26\.04(-arm)?" is unknown'` was passed.

### CI timing (`ci.yml`, workflow_dispatch and push on the branch)

Per-job duration; the total is created → updated. The baseline is main's run 38036209695 (`12c0e9f`, x64
ubuntu-24.04, stale setup-go cache hit).

| Run | Total | go job (lint / test / build) | game job (Vitest) | shell |
| --- | ---: | --- | --- | ---: |
| Baseline x64 | 373s | 360s (30 / 211 / 94) | 136s (96s) | 12s |
| x64 `b368c3f`, cold, no cache to restore (push; dispatch) | 327s; 327s | 311s (97 / 88–89 / 103–105) | 143–156s | 11–12s |
| x64 `b368c3f`, warm (dispatch) | 162s | 83s (2 / 53 / 2) | 146s (110s) | 12s |
| x64 `b4a3ef2`, Vitest 2 workers, warm (push; dispatch) | 154s; 149s | 73s; 88s (2 / 46–55 / 1–2) | 137s; 135s (104s; 100s) | 11–12s |
| arm64 `348c029`, cold (push; dispatch) | 214s; 231s | 193s; 211s (52–57 / 64–68 / 56–62) | 99s; 96s (63–64s) | 10–11s |
| arm64 `348c029`, warm (dispatch ×2) | 119s; 122s | 74s; 76s (2 / 41–42 / 1) | 100s; 102s (63–68s) | 9–12s |
| arm64 `2cda9c8`, warm (push, branch cache) | 109s | 73s (2 / 42 / 1) | 89s (59s) | 11s |

`internal/server` in CI: 170.7s at baseline, 44.5s on x64, 38.7–38.9s on arm64. Vitest's own reported duration:
94.3s at baseline, 97.9–108.2s on x64, 61.7–66.1s on arm64. On x64 the second worker gained little, probably
because the 2 vCPUs are SMT siblings of one core (not verified).

Arm64 is faster, not slower. Warm arm64 runs take about 120s against about 150s for warm x64 at the same config.
Cold runs take 214–231s against 327s. Billed minutes per run (each job rounded up): warm arm64 6 min × $0.005 =
$0.030; warm x64 7 min × $0.006 = $0.042; baseline 11 min × $0.006 = $0.066. On arm64 the setup actions,
shellcheck, Node 24.18 and pnpm all worked; so did the CGO-off darwin cross-build (`make helper-darwin`). The
linux-amd64 release build was not run on arm64, since `publish` builds it natively on x64. Every run listed passed.

The game job (setup about 20s, lint 8s, Vitest 63–68s on arm64) is now the CI critical path. The next step is
ticket item 4 or a Vitest environment-setup cut (40% of its phase time).
