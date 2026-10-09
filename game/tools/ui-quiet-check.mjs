#!/usr/bin/env node
/*
 * #216: proves Quiet did not move. For each CSS file given (relative to game/), it takes the working copy, drops the
 * `/* ubuntu:begin *\/ ... /* ubuntu:end *\/` blocks (Ubuntu-only rules), replaces every `var(--token)` the Quiet
 * block of src/ui/uiTheme.css (plus any `--tokens <dir>` JSON files of tokens not merged yet) defines by its Quiet
 * value, and diffs the result against the same file at `--base <rev>` (default 34de1c6, #216's start) after the same
 * expansion. No output = Quiet's CSS is byte-for-byte equivalent after normalisation; every remaining hunk is a
 * change that needs a reason (a deliberate fix, a new rule).
 *
 *   node tools/ui-quiet-check.mjs [--base REV] [--tokens DIR] src/ui/hud.css ...
 *
 * Token JSON: { "--name": { "quiet": "<value>", "ubuntu": "<value>", "role": "<what it is for>" }, ... }
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
let base = '34de1c6';
let tokensDir = null;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--base') base = args[++i];
  else if (args[i] === '--tokens') tokensDir = args[++i];
  else files.push(args[i]);
}

/** The custom properties of the first `:root { ... }` block of uiTheme.css (Quiet), as name -> value. */
function quietTokens() {
  const map = new Map();
  // uiTheme.css (the shell's) and themes.css (the transcript's `--tx-*` as Quiet sets them), their first `:root` blocks.
  for (const file of ['src/ui/uiTheme.css', 'src/ui/themes.css']) {
    const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const start = css.indexOf(':root {');
    const body = css.slice(start + 7, css.indexOf('\n}', start));
    for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) map.set(m[1], m[2].trim());
  }
  if (tokensDir) {
    for (const f of readdirSync(tokensDir).filter((n) => n.endsWith('.json'))) {
      const j = JSON.parse(readFileSync(join(tokensDir, f), 'utf8'));
      for (const [k, v] of Object.entries(j)) if (!map.has(k)) map.set(k, String(v.quiet).trim());
    }
  }
  return map;
}

const tokens = quietTokens();

function expand(text) {
  let prev;
  let n = 0;
  do {
    prev = text;
    text = text.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g, (all, name) => (tokens.has(name) ? tokens.get(name) : all));
  } while (text !== prev && ++n < 12);
  return text;
}

function normalise(css) {
  return expand(css.replace(/\/\*[\s\S]*?\*\//g, ''))
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};,>])\s*/g, '$1')
    .replace(/#([0-9a-fA-F]{3})\b(?![0-9a-fA-F])/g, (_m, h) => `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`)
    .replace(/#([0-9a-fA-F]{3,8})\b/g, (m) => m.toLowerCase())
    .replace(/\s*\/\s*/g, '/')
    .replace(/([{};])/g, '$1\n');
}

function strip(css) {
  return css.replace(/\/\*\s*ubuntu:begin\s*\*\/[\s\S]*?\/\*\s*ubuntu:end\s*\*\//g, '');
}

const dir = mkdtempSync(join(tmpdir(), 'quiet-check-'));
let bad = 0;
for (const f of files) {
  let old = '';
  try {
    old = execFileSync('git', ['show', `${base}:game/${f}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    console.log(`${f}: new file (nothing to compare)`);
    continue;
  }
  const a = join(dir, 'old.css');
  const b = join(dir, 'new.css');
  writeFileSync(a, normalise(old));
  writeFileSync(b, normalise(strip(readFileSync(f, 'utf8'))));
  const d = spawnSync('diff', ['-u', '--label', `${f}@${base}`, '--label', `${f}@work`, a, b], { encoding: 'utf8' });
  if (d.status === 0) console.log(`${f}: Quiet identical`);
  else {
    bad++;
    console.log(`${f}: DIFFERS\n${d.stdout}`);
  }
}
process.exit(bad ? 1 : 0);
