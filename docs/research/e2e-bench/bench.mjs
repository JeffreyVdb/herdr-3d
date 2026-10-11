#!/usr/bin/env node
// Playwright E2E bench (#241): runs the full suite through `make e2e-prebuilt` (host-wide flock + portlease) for one
// or more configurations and appends one JSON line per run. See README.md next to it.
//
//   node docs/research/e2e-bench/bench.mjs --out <file.jsonl> --config <workers>:<lp> [--config ...]
//        [--rounds N] [--cache warm|cold] [--tmp default|shm] [--build] [--spec <e2e/x.spec.ts>] [--note <text>]
//   node docs/research/e2e-bench/bench.mjs --out <file.jsonl> --build-only N
//
// <lp> is an LP_NUM_THREADS value or `unset` (the variable is removed from the run's environment). With several
// --config, each round runs every configuration once, the order rotated by one per round (A B C, B C A, C A B, ...),
// so drift and other agents' load spread over all of them. A config may end in :shm (e.g. 6:unset:shm) to run with
// TMPDIR on tmpfs, whatever --tmp says. Run from the repository root.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, homedir, loadavg, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';

// A run is flagged contaminated (kept, never dropped) when it waited on another worktree's e2e lock, when the host's
// 1-minute load average was above LOAD_LIMIT before it started, or when processes outside the run used more than
// FOREIGN_CORES_LIMIT cores on average while it ran (host CPU time from /proc/stat minus the run's own cgroup).
const LOAD_LIMIT = 2.0;
const FOREIGN_CORES_LIMIT = 1.0;
const LOCK_WAIT_MSG = "waiting for another worktree's e2e run";

const args = parseArgs(process.argv.slice(2));
const root = process.cwd();
if (!existsSync(join(root, 'game/playwright.config.ts'))) die('run from the repository root');
const benchDir = join(root, 'game/test-results/bench');
mkdirSync(benchDir, { recursive: true });

const out = resolve(args.out ?? die('--out <file.jsonl> is required'));
const benchId = new Date().toISOString().replace(/[:.]/g, '-');
const env0 = facts();

if (args.buildOnly) {
  for (let i = 0; i < args.buildOnly; i++) {
    const b = build();
    write({ kind: 'build', bench_id: benchId, round: i, ...env0, ...b });
  }
  process.exit(0);
}

const configs = args.configs.length ? args.configs : die('at least one --config <workers>:<lp> is required');
let buildS = null;
if (args.build) {
  const b = build();
  if (b.exit_code !== 0) die(`make game-build failed (exit ${b.exit_code})`);
  buildS = b.build_s;
}
if (!existsSync(join(root, 'game', process.env.H3D_DIST || 'dist', 'index.html'))) die('no build: pass --build or run make game-build');

for (let round = 0; round < args.rounds; round++) {
  for (let k = 0; k < configs.length; k++) {
    const c = configs[(round + k) % configs.length];
    const rec = await runOnce(c, round);
    rec.build_s = buildS; // the one build this batch tested (null: built before the batch)
    write(rec);
    buildS = null;
    const f = rec.first_attempt_failures.length;
    console.log(`[bench] ${rec.label} round ${round}: suite ${rec.suite_s}s wall ${rec.wall_s}s, ` +
      `${rec.tests.expected} passed / ${rec.tests.unexpected} failed / ${rec.tests.flaky} flaky / ${rec.tests.skipped} skipped` +
      (f ? `, first-attempt failures: ${f}` : '') + (rec.contaminated ? `, CONTAMINATED (${rec.contamination_reasons.join('; ')})` : ''));
  }
}

async function runOnce(c, round) {
  const tmpMode = c.tmp ?? args.tmp;
  const label = `w${c.workers}-lp${c.lp}${tmpMode === 'shm' ? '-shm' : ''}`;
  const id = `${benchId}-${label}-r${round}`;
  const reportPath = join(benchDir, `${id}.json`);
  const logPath = join(benchDir, `${id}.log`);
  const cpuStatPath = join(benchDir, `${id}.cpu.stat`);

  const env = { ...process.env, H3D_WORKERS: String(c.workers), H3D_E2E_REPORT: reportPath };
  if (c.lp === 'unset') delete env.LP_NUM_THREADS;
  else env.LP_NUM_THREADS = c.lp;
  let cacheDir = mesaCacheDir(process.env);
  let coldTmp = null;
  if (args.cache === 'cold') {
    // A fresh, empty Mesa disk cache for this run only; the user's cache is never touched.
    coldTmp = mkdtempSync(join(benchDir, 'mesa-cold-'));
    env.MESA_SHADER_CACHE_DIR = coldTmp;
    cacheDir = join(coldTmp, 'mesa_shader_cache');
  }
  const cacheBefore = duBytes(cacheDir);
  // TMPDIR of the test run: where Playwright puts each Chromium profile (os.tmpdir()). shm: a new directory on
  // /dev/shm (tmpfs) for this run only, removed afterwards, passed as H3D_E2E_TMPDIR (playwright.config.ts sets
  // TMPDIR from it; TMPDIR around make would move portlease's shared state too); default: the caller's TMPDIR or /tmp.
  let shmTmp = null;
  if (tmpMode === 'shm') {
    shmTmp = mkdtempSync('/dev/shm/h3d-e2e-bench-');
    env.H3D_E2E_TMPDIR = shmTmp;
  }
  const tmpDir = env.H3D_E2E_TMPDIR || env.TMPDIR || '/tmp';
  const tmpFs = fsType(tmpDir);
  let tmpPeak = 0;
  const tmpTimer = shmTmp ? setInterval(() => { tmpPeak = Math.max(tmpPeak, duBytes(shmTmp)); }, 5000) : null;

  const loadBefore = loadavg();
  const statBefore = procStat();
  const t0 = Date.now();
  // The run gets its own cgroup (a transient systemd user scope), so its CPU time, browsers included, is exact.
  const makeArgs = ['e2e-prebuilt', ...(args.spec ? [`SPEC=${args.spec}`] : [])];
  const inner = `make ${makeArgs.map(shq).join(' ')}; rc=$?; ` +
    `cat "/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup | head -n1)/cpu.stat" > ${shq(cpuStatPath)}; exit $rc`;
  const code = await new Promise((res) => {
    const p = spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', `--unit=h3d-e2e-bench-${process.pid}-${Date.now()}`,
      'sh', '-c', inner], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => chunks.push(d));
    p.on('close', (code) => { writeFileSync(logPath, Buffer.concat(chunks)); res(code); });
  });
  const t1 = Date.now();
  const statAfter = procStat();
  const loadAfter = loadavg();
  const cacheAfter = duBytes(cacheDir);
  if (coldTmp) rmSync(coldTmp, { recursive: true, force: true });
  if (tmpTimer) clearInterval(tmpTimer);
  if (shmTmp) rmSync(shmTmp, { recursive: true, force: true });

  const log = readFileSync(logPath, 'utf8');
  const wallS = (t1 - t0) / 1000;
  const hostBusyS = (statAfter.busy - statBefore.busy) / clkTck();
  const runCpuS = cpuStatUsage(cpuStatPath);
  const foreignS = runCpuS === null ? null : Math.max(0, hostBusyS - runCpuS);
  const foreignCores = foreignS === null ? null : foreignS / wallS;

  const rep = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
  const st = rep?.stats ?? {};
  const lockWaited = log.includes(LOCK_WAIT_MSG);
  const startDelayS = st.startTime ? (Date.parse(st.startTime) - t0) / 1000 : null;

  const reasons = [];
  if (lockWaited) reasons.push('waited on the e2e lock');
  if (loadBefore[0] > LOAD_LIMIT) reasons.push(`loadavg1 before ${loadBefore[0].toFixed(2)} > ${LOAD_LIMIT}`);
  if (foreignCores !== null && foreignCores > FOREIGN_CORES_LIMIT)
    reasons.push(`foreign CPU ${foreignCores.toFixed(2)} cores > ${FOREIGN_CORES_LIMIT}`);
  if (!rep) reasons.push('no JSON report');

  const tests = {
    expected: st.expected ?? null, unexpected: st.unexpected ?? null, flaky: st.flaky ?? null, skipped: st.skipped ?? null,
  };
  tests.total = rep ? tests.expected + tests.unexpected + tests.flaky + tests.skipped : null;

  return {
    kind: 'run', bench_id: benchId, label, round, ...env0,
    renderer: rep ? renderer(rep) : null,
    workers: c.workers, lp_num_threads: c.lp === 'unset' ? null : Number(c.lp),
    spec: args.spec ?? null,
    shader_cache: { mode: args.cache, dir: cacheDir, bytes_before: cacheBefore, bytes_after: cacheAfter },
    tmp: { mode: tmpMode, dir: tmpDir, fs: tmpFs, peak_bytes: shmTmp ? tmpPeak : null },
    loadavg_before: loadBefore.map(r2), loadavg_after: loadAfter.map(r2),
    lock_waited: lockWaited, start_delay_s: startDelayS === null ? null : r2(startDelayS),
    cpu: { host_busy_s: r2(hostBusyS), run_s: runCpuS === null ? null : r2(runCpuS), foreign_s: foreignS === null ? null : r2(foreignS),
      foreign_cores: foreignCores === null ? null : r2(foreignCores) },
    contaminated: reasons.length > 0, contamination_reasons: reasons,
    build_s: null,
    suite_s: st.duration === undefined ? null : r2(st.duration / 1000),
    wall_s: r2(wallS),
    exit_code: code,
    tests,
    global_errors: rep ? rep.errors.length : null,
    first_attempt_failures: rep ? firstAttemptFailures(rep) : [],
    started_at: new Date(t0).toISOString(),
    report: rel(reportPath), log: rel(logPath),
    note: args.note ?? null,
  };
}

function build() {
  const t0 = Date.now();
  const r = spawnSync('make', ['game-build'], { stdio: ['ignore', 'pipe', 'pipe'] });
  return { build_s: r2((Date.now() - t0) / 1000), exit_code: r.status, started_at: new Date(t0).toISOString() };
}

// Every test whose first (with retries: 0, only) attempt did not pass, with its title path and first error line.
function firstAttemptFailures(rep) {
  const outl = [];
  const walk = (suite, path) => {
    const here = suite.title ? [...path, suite.title] : path;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const r = t.results?.[0];
        if (!r || r.status === 'passed' || (r.status === 'skipped' && t.expectedStatus === 'skipped')) continue;
        const err = (r.error?.message ?? r.errors?.[0]?.message ?? '').replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0].slice(0, 300);
        outl.push({ title: [...here, spec.title].join(' › '), line: spec.line, status: r.status, duration_s: r2(r.duration / 1000), error: err });
      }
    }
    for (const s of suite.suites ?? []) walk(s, here);
  };
  for (const s of rep.suites ?? []) walk(s, []);
  return outl;
}

// shot.spec.ts logs the WebGL renderer (gl=...); the first one found.
function renderer(rep) {
  let found = null;
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) for (const t of spec.tests ?? []) for (const r of t.results ?? [])
      for (const o of r.stdout ?? []) { const m = /gl=(.*)/.exec(o.text ?? ''); if (m && !found) found = m[1].trim(); }
    for (const s of suite.suites ?? []) walk(s);
  };
  for (const s of rep.suites ?? []) walk(s);
  return found;
}

// Facts that hold for the whole batch.
function facts() {
  const sh = (cmd, a, opts = {}) => { try { return execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim(); } catch { return null; } };
  const sha = sh('git', ['rev-parse', 'HEAD']);
  // The results this bench appends to do not make the tree dirty.
  const dirty = sh('git', ['status', '--porcelain', '--untracked-files=no', '--', '.', ':!docs/research/e2e-bench/results']);
  const gameDir = join(root, 'game');
  const playwright = sh('pnpm', ['exec', 'playwright', '--version'], { cwd: gameDir })?.replace(/^Version /, '') ?? null;
  const exe = sh('node', ['-e', "process.stdout.write(require('@playwright/test').chromium.executablePath())"], { cwd: gameDir });
  // Headless runs use chromium_headless_shell; both builds share the revision and version.
  const shell = exe?.replace(/chromium-(\d+)\/chrome-linux64\/chrome$/, 'chromium_headless_shell-$1/chrome-headless-shell-linux64/chrome-headless-shell');
  const chromium = shell && existsSync(shell) ? sh(shell, ['--version']) : (exe ? sh(exe, ['--version']) : null);
  const mesa = sh('rpm', ['-q', 'mesa-vulkan-drivers']) ?? sh('sh', ['-c', "vulkaninfo --summary 2>/dev/null | grep -m1 driverInfo"]);
  const gitDescribe = sh('git', ['describe', '--tags', '--always', '--dirty']);
  return {
    git_sha: sha, git_dirty: !!dirty, git_describe: gitDescribe,
    playwright, chromium, mesa,
    host: { cpu: cpus()[0]?.model ?? null, nproc: availableParallelism(), ram_gib: r2(totalmem() / 2 ** 30), kernel: release() },
  };
}

function mesaCacheDir(env) {
  if (env.MESA_SHADER_CACHE_DIR) return join(env.MESA_SHADER_CACHE_DIR, 'mesa_shader_cache');
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'mesa_shader_cache');
}

function duBytes(dir) {
  let n = 0;
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of ents) {
    const p = join(dir, e.name);
    try {
      if (e.isDirectory()) n += duBytes(p);
      else if (e.isFile()) n += statSync(p).size;
    } catch { /* removed while we looked (a browser profile going away) */ }
  }
  return n;
}

function fsType(dir) {
  try { return execFileSync('stat', ['-f', '-c', '%T', dir], { encoding: 'utf8' }).trim(); } catch { return null; }
}

// Busy jiffies of all CPUs: everything but idle and iowait.
function procStat() {
  const f = readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const [user, nice, system, idle, iowait, irq, softirq, steal] = f;
  return { busy: user + nice + system + irq + softirq + steal, idle: idle + iowait };
}

function clkTck() {
  return Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()) || 100;
}

function cpuStatUsage(p) {
  if (!existsSync(p)) return null;
  const m = /usage_usec (\d+)/.exec(readFileSync(p, 'utf8'));
  return m ? Number(m[1]) / 1e6 : null;
}

function write(rec) {
  appendFileSync(out, JSON.stringify(rec) + '\n');
}

function parseArgs(a) {
  const o = { configs: [], rounds: 1, cache: 'warm', tmp: 'default', build: false, buildOnly: 0 };
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    const v = () => a[++i] ?? die(`${k} needs a value`);
    if (k === '--out') o.out = v();
    else if (k === '--config') {
      const m = /^([1-9]\d*):(unset|\d+)(?::(shm|default))?$/.exec(v());
      if (!m) die('--config is <workers>:<LP_NUM_THREADS|unset>[:shm|:default], e.g. 6:unset or 8:4:shm');
      o.configs.push({ workers: Number(m[1]), lp: m[2], tmp: m[3] });
    } else if (k === '--rounds') o.rounds = Number(v());
    else if (k === '--cache') { o.cache = v(); if (!['warm', 'cold'].includes(o.cache)) die('--cache is warm or cold'); }
    else if (k === '--tmp') { o.tmp = v(); if (!['default', 'shm'].includes(o.tmp)) die('--tmp is default or shm'); }
    else if (k === '--build') o.build = true;
    else if (k === '--build-only') o.buildOnly = Number(v());
    else if (k === '--spec') o.spec = v();
    else if (k === '--note') o.note = v();
    else die(`unknown argument ${k}`);
  }
  return o;
}

function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
function rel(p) { return p.startsWith(root + '/') ? p.slice(root.length + 1) : p; }
function r2(x) { return Math.round(x * 100) / 100; }
function die(msg) { console.error(`bench: ${msg}`); process.exit(2); }
