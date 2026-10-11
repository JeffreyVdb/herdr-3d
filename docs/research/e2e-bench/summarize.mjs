#!/usr/bin/env node
// Tables for testing-performance.md from bench.mjs's JSONL (#241).
//
//   node docs/research/e2e-bench/summarize.mjs [--base <isolation.jsonl>] [--merge-tmp] <file.jsonl> ...
//
// Per configuration (label + cache mode): runs, suite p50/p95/min/max, total feedback (suite + build) p50/p95, first-attempt
// failures (median, max) and those beyond the base set, contaminated runs. The base set (--base) is every test that
// failed in every run of that file: tests that fail on this host whatever the load. Percentiles are nearest-rank, so with
// ten runs p95 is the slowest run. --merge-tmp pools a config's /tmp and /dev/shm TMPDIR runs. Build time: the median of the `kind: "build"` lines, else of the runs' build_s.
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
let baseFile = null;
let mergeTmp = false;
const files = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--base') baseFile = argv[++i];
  else if (argv[i] === '--merge-tmp') mergeTmp = true;
  else files.push(argv[i]);
}
const read = (f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const lines = files.flatMap(read);
const runs = lines.filter((l) => l.kind === 'run' && !l.spec);
const builds = lines.filter((l) => l.kind === 'build' && l.exit_code === 0).map((l) => l.build_s);
const runBuilds = runs.map((r) => r.build_s).filter((b) => b !== null);
const buildS = median(builds.length ? builds : runBuilds) ?? 0;

let base = new Set();
if (baseFile) {
  const iso = read(baseFile).filter((l) => l.kind === 'run');
  const sets = iso.map((r) => new Set(r.first_attempt_failures.map((f) => f.title)));
  base = new Set([...sets[0]].filter((t) => sets.every((s) => s.has(t))));
  console.log(`Base failures (failed in all ${iso.length} isolation runs): ${base.size}`);
  for (const t of [...base].sort()) console.log(`  - ${t}`);
  console.log();
}

const groups = new Map();
for (const r of runs) {
  const key = keyOf(r);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

console.log(`Build (make game-build): median ${buildS}s over ${builds.length || runBuilds.length} builds` +
  (builds.length ? `, p95 ${pct(builds, 95)}s` : ''));
console.log();
console.log('| Config | Cache | Runs | Suite p50 | Suite p95 | Min–max | Feedback p50 | Feedback p95 | Failures median (max) | Beyond base median (max) | Contaminated |');
console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const [key, rs] of [...groups].sort((a, b) => median(a[1].map(s)) - median(b[1].map(s)))) {
  const [label, mode] = key.split(' ');
  const suite = rs.map(s);
  const fb = rs.map((r) => r.wall_s + buildS);
  const fails = rs.map((r) => r.first_attempt_failures.length);
  const extra = rs.map((r) => r.first_attempt_failures.filter((f) => !base.has(f.title)).length);
  console.log(`| ${label} | ${mode} | ${rs.length} | ${fmt(median(suite))} | ${fmt(pct(suite, 95))} | ${fmt(Math.min(...suite))}–${fmt(Math.max(...suite))} | ` +
    `${fmt(median(fb))} | ${fmt(pct(fb, 95))} | ${median(fails)} (${Math.max(...fails)}) | ${median(extra)} (${Math.max(...extra)}) | ` +
    `${rs.filter((r) => r.contaminated).length}/${rs.length} |`);
}

// Which tests failed where: tests that failed at least once, by configuration (failed runs / runs).
console.log();
const labels = [...groups.keys()];
const count = new Map();
for (const r of runs) for (const f of r.first_attempt_failures) {
  const k = keyOf(r);
  if (!count.has(f.title)) count.set(f.title, new Map());
  count.get(f.title).set(k, (count.get(f.title).get(k) ?? 0) + 1);
}
console.log(`| Test | Base | ${labels.join(' | ')} |`);
console.log(`| --- | --- | ${labels.map(() => '---:').join(' | ')} |`);
for (const [t, m] of [...count].sort((a, b) => sum(b[1]) - sum(a[1]))) {
  console.log(`| ${t.length > 110 ? t.slice(0, 107) + '...' : t} | ${base.has(t) ? 'yes' : ''} | ` +
    labels.map((k) => `${m.get(k) ?? 0}/${groups.get(k).length}`).join(' | ') + ' |');
}

function keyOf(r) { return `${mergeTmp ? r.label.replace(/-shm$/, '') : r.label} ${r.shader_cache.mode}`; }
function s(r) { return r.suite_s; }
function sum(m) { let n = 0; for (const v of m.values()) n += v; return n; }
function median(a) { return a.length ? pct(a, 50) : null; }
function pct(a, p) { const v = [...a].sort((x, y) => x - y); return v[Math.max(0, Math.ceil((p / 100) * v.length) - 1)]; }
function fmt(x) { if (x === null || x === undefined) return '–'; const m = Math.floor(x / 60); return `${x.toFixed(0)}s (${m}m${String(Math.round(x - m * 60)).padStart(2, '0')})`; }
