# Playwright E2E bench (#241, stages 4–5)

Research harness, not game code. Results and conclusions: [testing-performance.md](../testing-performance.md),
"Results (stages 4–5)".

- `bench.mjs`: runs the full suite (or `--spec`) through `make e2e-prebuilt`, so every run takes the host-wide e2e
  `flock` and leases its preview port from portlease, and appends one JSON line per run to `--out`.
  - `--config <workers>:<LP_NUM_THREADS|unset>`, repeatable. With several configs, each `--rounds` round runs every
    config once, the order rotated by one per round.
  - `--cache warm` (default) uses the Mesa shader cache the host already has (`$XDG_CACHE_HOME/mesa_shader_cache`,
    `~/.cache/mesa_shader_cache`). `--cache cold` points `MESA_SHADER_CACHE_DIR` at a new empty directory for that run
    and deletes it afterwards; the user's cache is never touched.
  - `--tmp shm` makes a new directory under `/dev/shm` (tmpfs) for that run, passes it as `H3D_E2E_TMPDIR` and
    removes it afterwards; `playwright.config.ts` sets `TMPDIR` from it, so Playwright creates each Chromium profile
    there (`os.tmpdir()`). Not `TMPDIR` around make: portlease keeps its shared lease state in
    `$TMPDIR/portlease-<uid>`, and a private one would hand out ports other worktrees hold. `--tmp default` (default)
    leaves everything as the caller has it (unset: `/tmp`). A config can carry its own: `--config 6:unset:shm`.
  - `--build` times `make game-build` once before the batch (recorded on the batch's first line); `--build-only N`
    times N builds and writes `kind: "build"` lines.
  - Each run is its own transient systemd user scope (`systemd-run --user --scope`), so the run's CPU time, browsers
    included, comes from its cgroup's `cpu.stat`. User-space CPU the rest of the host used meanwhile (the top-level
    cgroups' `cpu.stat` minus the run's) is `cpu.foreign_s`; kernel threads (`/proc/stat` busy time outside every
    cgroup: kswapd, dm-crypt and btrfs workers, much of it caused by the run itself) are `cpu.kernel_s`. The first
    two batches (`results/control.jsonl`, `results/sweep.jsonl`) predate that split: their `foreign_s` is `/proc/stat`
    minus the run, kernel threads included, and no `cpu.metric` field.
  - Before each run it waits up to 240 s (`cooldown_s`) for the 1-minute load average to fall under 2.0: the
    previous run's own load takes minutes to decay. The first two batches had no cooldown, so their back-to-back
    runs show a high `loadavg_before` from the run before.
  - A run is `contaminated` (kept, with `contamination_reasons`) when it waited on the e2e lock (make printed
    `waiting for another worktree's e2e run`), when the 1-minute load average was above 2.0 before it started, or when
    other user-space processes used more than 1.0 core on average while it ran.
  - Per run it keeps the Playwright JSON report and the make/Playwright log under `game/test-results/bench/`
    (gitignored); the line names both.
- `gpu-probe.mjs <seconds>`: while a run goes on, finds Playwright's Chromium GPU processes and counts their threads by
  name. Mesa's rasterizer threads are `llvmpipe-<n>`. Used to show that `LP_NUM_THREADS` reaches the GPU process.
- `results/*.jsonl`: every run cited in the doc, raw.

## Fields of a `kind: "run"` line

| Field | Meaning |
| --- | --- |
| `git_sha`, `git_dirty`, `git_describe` | Commit tested (`dirty` ignores `results/`) |
| `playwright`, `chromium`, `mesa` | Playwright version, `chrome-headless-shell --version`, `rpm -q mesa-vulkan-drivers` |
| `host` | CPU model, `nproc`, RAM (GiB), kernel |
| `renderer` | WebGL renderer string `shot.spec.ts` logged in that run (`gl=...`) |
| `workers`, `lp_num_threads` | `H3D_WORKERS`; `LP_NUM_THREADS` (`null`: unset) |
| `shader_cache` | `mode` (warm/cold), Mesa cache dir, bytes before and after the run |
| `tmp` | `mode` (default/shm), `TMPDIR` used, its filesystem type (`stat -f`), peak bytes in it (shm only) |
| `cooldown_s`, `loadavg_before`, `loadavg_after` | Seconds waited for the load to settle; `/proc/loadavg` 1/5/15 min |
| `lock_waited`, `start_delay_s` | Whether make waited on the e2e lock; seconds from launching make to Playwright's start |
| `cpu` | Host busy CPU seconds, the run's own (cgroup), other user space (`foreign_s`, `foreign_cores` = per wall second), kernel threads (`kernel_s`) |
| `mem` | Lowest `MemAvailable` seen (sampled every 5 s), pages swapped in and out during the run |
| `contaminated`, `contamination_reasons` | See above |
| `build_s` | `make game-build` seconds, on the line after the build it timed; `null` otherwise |
| `suite_s` | Playwright JSON `stats.duration` (includes starting the preview server) |
| `wall_s` | `make e2e-prebuilt` from launch to exit (lock wait, portlease, deps check, Playwright) |
| `exit_code` | make's exit code |
| `tests` | `expected` (passed), `unexpected` (failed), `flaky`, `skipped`, `total` |
| `first_attempt_failures` | Every test whose first attempt did not pass: title path, line, status, first error line |
| `report`, `log` | Paths of the JSON report and the log (under `game/test-results/bench/`) |

## Reproduce

From the repository root, on a clean tree (the lines record the SHA):

```sh
make setup
node docs/research/e2e-bench/bench.mjs --out /tmp/e2e.jsonl --build --config 6:unset          # one control run
node docs/research/e2e-bench/bench.mjs --out /tmp/e2e.jsonl --config 6:unset --config 8:4 --rounds 10
node docs/research/e2e-bench/bench.mjs --out /tmp/e2e.jsonl --config 6:unset --cache cold
node docs/research/e2e-bench/bench.mjs --out /tmp/e2e.jsonl --build-only 10
LP_NUM_THREADS=2 sh -c 'node docs/research/e2e-bench/gpu-probe.mjs 20 & make e2e-prebuilt SPEC=e2e/shot.spec.ts; wait'
```

Each run takes the e2e lock for its own length; between runs other worktrees may take it (and a run that then waits
is flagged). Do not run other
heavy work on the host meanwhile; the `cpu.foreign_*` fields show it when it happens.
