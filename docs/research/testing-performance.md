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
