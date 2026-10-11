#!/usr/bin/env node
// Watch Playwright's Chromium GPU processes while a run goes on and report their llvmpipe threads (#241).
//
//   node docs/research/e2e-bench/gpu-probe.mjs <seconds> [interval-ms]   (start it, then the run; prints JSON at the end)
//
// For every process running a Playwright browser binary (~/.cache/ms-playwright) with --type=gpu-process, it keeps
// the largest number of threads seen under each name. Mesa's llvmpipe/lavapipe rasterizer threads are llvmpipe-<n>.
// /proc/<pid>/environ is no help here: Chromium rewrites its children's process titles over the environment block.
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';

const secs = Number(process.argv[2] ?? die('usage: gpu-probe.mjs <seconds> [interval-ms]'));
const step = Number(process.argv[3] ?? 250);
const seen = new Map();
const end = Date.now() + secs * 1000;

while (Date.now() < end) {
  for (const pid of gpuPids()) {
    const names = threadNames(pid);
    if (!names) continue;
    const rec = seen.get(pid) ?? { pid, max_threads: 0, max_by_name: {} };
    rec.max_threads = Math.max(rec.max_threads, Object.values(names).reduce((a, b) => a + b, 0));
    for (const [n, c] of Object.entries(names)) rec.max_by_name[n] = Math.max(rec.max_by_name[n] ?? 0, c);
    seen.set(pid, rec);
  }
  await new Promise((r) => setTimeout(r, step));
}
const procs = [...seen.values()];
console.log(JSON.stringify({
  LP_NUM_THREADS: process.env.LP_NUM_THREADS ?? null,
  gpu_processes: procs.length,
  llvmpipe_threads_max: Math.max(0, ...procs.map((p) => p.max_by_name['llvmpipe-<n>'] ?? 0)),
  processes: procs,
}, null, 1));

function* gpuPids() {
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      if (!readlinkSync(`/proc/${d}/exe`).includes('ms-playwright')) continue;
      // Chromium's rewritten titles: the arguments arrive as one space-separated string.
      const cmd = readFileSync(`/proc/${d}/cmdline`, 'latin1').replaceAll('\0', ' ');
      if (cmd.includes(' --type=gpu-process')) yield Number(d);
    } catch { /* gone, or not ours */ }
  }
}

function threadNames(pid) {
  try {
    const names = {};
    for (const t of readdirSync(`/proc/${pid}/task`)) {
      const n = readFileSync(`/proc/${pid}/task/${t}/comm`, 'utf8').trim().replace(/\d+$/, '<n>');
      names[n] = (names[n] ?? 0) + 1;
    }
    return names;
  } catch { return null; }
}

function die(msg) { console.error(msg); process.exit(2); }
