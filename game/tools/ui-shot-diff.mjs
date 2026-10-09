#!/usr/bin/env node
/*
 * #216: compares two directories of same-named PNGs (the "before" Quiet shots and the Quiet shots of the work tree),
 * and prints for each file the share of pixels that differ by more than a few levels in any channel. The 3D world's
 * animation and the fixture clock move a few pixels between runs, so a UI regression shows as a block, not a speck:
 * `--rows` also prints the 16-pixel bands of the page where more than 2% of the pixels changed.
 *
 *   node tools/ui-shot-diff.mjs [--rows] <before-dir> <after-dir> [--out <dir of diff PNGs>]
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const args = process.argv.slice(2);
const rows = args.includes('--rows');
const outIdx = args.indexOf('--out');
const out = outIdx >= 0 ? args[outIdx + 1] : null;
const dirs = args.filter((a, i) => !a.startsWith('--') && (outIdx < 0 || i !== outIdx + 1));
const [a, b] = dirs;
if (!a || !b) throw new Error('usage: ui-shot-diff [--rows] <before> <after> [--out dir]');
if (out) mkdirSync(out, { recursive: true });
let worst = 0;
for (const f of readdirSync(a).filter((n) => n.endsWith('.png')).sort()) {
  if (!existsSync(join(b, f))) {
    console.log(`${f}: MISSING in ${b}`);
    continue;
  }
  const x = PNG.sync.read(readFileSync(join(a, f)));
  const y = PNG.sync.read(readFileSync(join(b, f)));
  if (x.width !== y.width || x.height !== y.height) {
    console.log(`${f}: size ${x.width}x${x.height} vs ${y.width}x${y.height}`);
    continue;
  }
  const diff = new PNG({ width: x.width, height: x.height });
  let n = 0;
  const band = new Map();
  for (let i = 0; i < x.data.length; i += 4) {
    const d = Math.max(Math.abs(x.data[i] - y.data[i]), Math.abs(x.data[i + 1] - y.data[i + 1]), Math.abs(x.data[i + 2] - y.data[i + 2]));
    const hit = d > 8;
    if (hit) {
      n++;
      const row = Math.floor(i / 4 / x.width);
      const k = Math.floor(row / 16);
      band.set(k, (band.get(k) ?? 0) + 1);
    }
    diff.data[i] = hit ? 255 : x.data[i] >> 2;
    diff.data[i + 1] = hit ? 0 : x.data[i + 1] >> 2;
    diff.data[i + 2] = hit ? 0 : x.data[i + 2] >> 2;
    diff.data[i + 3] = 255;
  }
  const pct = (100 * n) / (x.width * x.height);
  worst = Math.max(worst, pct);
  console.log(`${f}: ${pct.toFixed(2)}% differ`);
  if (rows) for (const [k, c] of [...band].sort((p, q) => p[0] - q[0])) if ((100 * c) / (16 * x.width) > 2) console.log(`    rows ${k * 16}-${k * 16 + 15}: ${((100 * c) / (16 * x.width)).toFixed(1)}%`);
  if (out && n) writeFileSync(join(out, f), PNG.sync.write(diff));
}
console.log(`worst: ${worst.toFixed(2)}%`);
