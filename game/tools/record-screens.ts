// Records the laptop-screen fixtures (fixtures/screens/<name>.jsonl) that the
// fixture simulator (tools/fixture-screen.ts, `sim=1`) replays for
// `terminal.watch`: real `herdr terminal session observe` output from a
// throwaway session `h3d-m5screen-<random>` (HERDR_* / CLAUDE* stripped),
// stopped and deleted afterwards, also on failure. Every screen is
// synthetic: a bare bash with a `$ ` prompt in an empty temp directory, and a
// scripted agent-style screen (tools/record-screens.ts `AGENT`), no real agent.
//
//   node tools/record-screens.ts            # rewrite fixtures/screens/{shell,agent}.jsonl
//
// File format: a meta line {name, cols, rows, herdr, frames}, then one line per
// observed frame {ms, full, data}: ms since the observer started, `data` the
// frame's base64 ANSI exactly as herdr sent it.
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanEnv, herdrBin, Throwaway } from './herdr-throwaway.ts';

export const COLS = 120;
export const ROWS = 36;
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'screens');

/** A scripted agent-style screen: a header, a transcript, a spinner that ticks, an input box with the cursor in it. */
const AGENT = `#!/bin/bash
e=$'\\033'
o="$e[38;2;215;119;87m"; g="$e[32m"; r="$e[31m"; d="$e[2m"; b="$e[1m"; z="$e[0m"; c="$e[36m"
printf '%s' "$e[2J$e[H"
printf '%s\n' "$o╭──────────────────────────────────────────────────────────╮$z"
printf '%s\n' "$o│$z $o✻$z \${b}Worker demo$z · a synthetic screen for the game's tests  $o│$z"
printf '%s\n' "$o│$z   \${d}cwd: ~/demo-repo$z                                       $o│$z"
printf '%s\n' "$o╰──────────────────────────────────────────────────────────╯$z"
printf '\n%s\n\n' "$d>$z Add a retry to the upload step and run the tests"
printf '%s\n' "$g●$z \${b}Read$z(src/upload.ts)" "  $d⎿  Read 84 lines$z"
printf '%s\n' "$g●$z \${b}Update$z(src/upload.ts)" "  $d⎿  Updated src/upload.ts with 12 additions and 3 removals$z"
printf '%s\n' "      $e[48;5;52m41 -   await put(url, body)                          $z"
printf '%s\n' "      $e[48;5;22m41 +   for (let i = 0; i < 3; i++) {                 $z"
printf '%s\n' "      $e[48;5;22m42 +     try { return await put(url, body) }         $z"
printf '%s\n' "      $e[48;5;22m43 +     catch (e) { await sleep(250 * 2 ** i) }     $z"
printf '%s\n' "      $e[48;5;22m44 +   }                                             $z"
printf '%s\n' "$g●$z \${b}Bash$z(pnpm test)" "  $d⎿$z  $g✓$z 42 passed $d(1.2s)$z"
echo
spin=(✻ ✶ ✳ ✢ · ✢ ✳ ✶)
box() {
  printf '%s' "$e[24;1H$d╭──────────────────────────────────────────────────────────────────────╮$z"
  printf '%s' "$e[25;1H$d│$z > $e[25;72H$d│$z"
  printf '%s' "$e[26;1H$d╰──────────────────────────────────────────────────────────────────────╯$z"
  printf '%s' "$e[27;3H$d? for shortcuts$z$e[27;60H\${c}bypass permissions on$z"
}
box
for i in $(seq 0 47); do
  s=$(( i / 4 ))
  printf '%s' "$e[21;1H$e[2K$o\${spin[$(( i % 8 ))]}$z \${o}Thinking…$z $d(\${s}s · ↓ $(( 300 + i * 25 )) tokens · esc to interrupt)$z$e[25;5H"
  sleep 0.25
done
printf '%s' "$e[21;1H$e[2K$g●$z Retries are in and the tests pass (42 passed). Anything else?$e[25;5H"
sleep 30
`;

/** The shell screen: a bare bash with a neutral prompt, a few commands with coloured output. */
const SHELL_STEPS: Array<[number, string]> = [
  [300, "printf '\\033[1mdemo-repo\\033[0m: a synthetic checkout for the game\\n'"],
  [900, 'ls -F --color=always'],
  [900, "printf '\\033[32m✓\\033[0m build  \\033[32m✓\\033[0m lint  \\033[33m!\\033[0m 2 todo\\n'"],
  [900, 'seq -s " " 1 12'],
  [900, "printf 'running tests…\\n'; sleep 1; printf '\\033[32m 42 passed\\033[0m \\033[2m(1.2s)\\033[0m\\n'"],
  [2200, "printf 'ready for input\\n'"],
];

interface Frame {
  ms: number;
  full: boolean;
  data: string;
}

function observe(bin: string, session: string, pane: string): { frames: Frame[]; stop: () => Promise<void> } {
  const frames: Frame[] = [];
  const t0 = Date.now();
  const p = spawn(bin, ['--session', session, 'terminal', 'session', 'observe', pane, '--cols', String(COLS), '--rows', String(ROWS)], { env: cleanEnv(), stdio: ['ignore', 'pipe', 'inherit'] });
  let buf = '';
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (chunk: string) => {
    buf += chunk;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line) as { type?: string; full?: boolean; width?: number; height?: number; bytes?: string };
      if (m.type !== 'terminal.frame' || typeof m.bytes !== 'string') continue;
      if (m.width !== COLS || m.height !== ROWS) throw new Error(`observer sent ${m.width}x${m.height}, asked for ${COLS}x${ROWS}`);
      frames.push({ ms: Date.now() - t0, full: m.full === true, data: m.bytes });
    }
  });
  const exited = new Promise<void>((res) => p.once('exit', () => res()));
  return {
    frames,
    stop: async () => {
      p.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 1000))]);
      p.kill('SIGKILL');
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function paneOf(out: string): string {
  const m = /"pane_id"\s*:\s*"([^"]+)"/.exec(out) ?? /\b(w[0-9a-z]+:p[0-9]+)\b/.exec(out);
  if (!m?.[1]) throw new Error(`no pane id in: ${out}`);
  return m[1];
}

async function record(t: Throwaway, bin: string, dir: string, name: string, script: (pane: string) => Promise<void>): Promise<Frame[]> {
  const pane = paneOf(t.run(['--session', t.name, 'workspace', 'create', '--cwd', dir, '--label', name, '--no-focus']));
  await sleep(800);
  // A bare bash: no rc files, no user or host in the prompt.
  const home = join(dir, 'home');
  t.run(['--session', t.name, 'pane', 'run', pane, `exec env -i HOME=${home} TERM=xterm-256color LANG=C.UTF-8 PATH=/usr/bin:/bin PS1='$ ' bash --norc --noprofile`]);
  await sleep(800);
  t.run(['--session', t.name, 'pane', 'run', pane, 'clear']);
  await sleep(500);
  const o = observe(bin, t.name, pane);
  try {
    await sleep(600);
    await script(pane);
  } finally {
    await o.stop();
  }
  if (!o.frames[0]?.full) throw new Error(`${name}: the first frame is not full`);
  return o.frames;
}

async function main(): Promise<void> {
  const bin = herdrBin();
  const version = execFileSync(bin, ['--version'], { env: cleanEnv(), encoding: 'utf8' }).trim();
  const dir = mkdtempSync(join(tmpdir(), 'h3d-m5screen-'));
  const repo = join(dir, 'demo-repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(dir, 'home'), { recursive: true });
  for (const f of ['README.md', 'package.json', 'src/upload.ts', 'src/retry.ts']) writeFileSync(join(repo, f), '\n');
  writeFileSync(join(dir, 'agent.sh'), AGENT, { mode: 0o755 });
  const t = new Throwaway(bin, 'h3d-m5screen-');
  await t.start(dir, join(dir, 'server.log'));
  const out: Record<string, Frame[]> = {};
  try {
    out.shell = await record(t, bin, repo, 'shell', async (pane) => {
      for (const [wait, cmd] of SHELL_STEPS) {
        await sleep(wait);
        t.run(['--session', t.name, 'pane', 'run', pane, cmd]);
      }
      await sleep(1500);
    });
    out.agent = await record(t, bin, repo, 'agent', async (pane) => {
      t.run(['--session', t.name, 'pane', 'run', pane, 'bash ../agent.sh']);
      await sleep(14_500);
    });
  } finally {
    const problems = await t.cleanup();
    if (problems.length) console.error(`cleanup: ${problems.join('; ')}`);
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(OUT, { recursive: true });
  for (const [name, frames] of Object.entries(out)) {
    // The recording starts at its first (full) frame.
    const t0 = frames[0]?.ms ?? 0;
    const lines = [JSON.stringify({ name, cols: COLS, rows: ROWS, herdr: version, frames: frames.length }), ...frames.map((f) => JSON.stringify({ ms: f.ms - t0, full: f.full, data: f.data }))];
    writeFileSync(join(OUT, `${name}.jsonl`), `${lines.join('\n')}\n`);
    console.log(`${name}: ${frames.length} frames, ${lines.join('\n').length} bytes`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
