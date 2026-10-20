// Metal/WebGPU perf run on the M2 Max (docs/architecture.md §6.2):
//
//   pnpm perf:mac
//
// Serves the built game (vite preview, 127.0.0.1, leased port P), opens a
// reverse tunnel so the Mac sees it on its own http://127.0.0.1:P (a secure
// context, so Chrome uses WebGPU), then pipes tools/mac-runner.mjs into node
// on the Mac: headless Chrome from ~/h3d-tools playwright-core runs the
// in-game benchmark on the perf fixtures and takes screenshots. Results land
// in game/test-results/perf/. Every ssh uses ControlMaster=no.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GAME = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(GAME, 'test-results', 'perf');

// The Mac is named by $H3D_MAC, else by H3D_MAC= in h3d-update's private config
// (${XDG_CONFIG_HOME:-~/.config}/h3d/update.env, deploy/update.env.example). No built-in default.
function macFromUpdateEnv(): string | undefined {
  const file = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'h3d', 'update.env');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?H3D_MAC\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]*))/.exec(line);
    if (m) return m[1] ?? m[2] ?? m[3] ?? undefined;
  }
  return undefined;
}
function noMac(): never {
  console.error('no Mac to run on: set H3D_MAC=<ssh destination of the Mac>, or H3D_MAC= in ~/.config/h3d/update.env (see deploy/update.env.example)');
  return process.exit(2);
}
const MAC: string = process.env.H3D_MAC || macFromUpdateEnv() || noMac();
const SSH = ['-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15'];
const port = Number(process.env.PORTLEASE_PREVIEW_PORT);
if (!port) {
  console.error('run via `pnpm perf:mac` (needs PORTLEASE_PREVIEW_PORT)');
  process.exit(2);
}
if (port === 7777) throw new Error('port 7777 belongs to the helper');

const log = (m: string) => console.log(`perf: ${m}`);
const procs: ChildProcess[] = [];
const cleanup = () => {
  for (const p of procs.reverse()) if (p.exitCode === null) p.kill('SIGTERM');
};
process.on('SIGINT', () => (cleanup(), process.exit(130)));
process.on('SIGTERM', () => (cleanup(), process.exit(143)));

const onMac = (cmd: string, input?: string) =>
  execFileSync('ssh', [...SSH, MAC, cmd], { encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024, timeout: 30 * 60_000 });

const fx = (name: string) => `ws=${encodeURIComponent(`/fixture/${name}?play=none`)}`;
const BENCH = { frames: 300, warm: 60 };
const jobs = [
  { name: 'floor60', path: `/?${fx('perf-floor60')}&ts`, floor: 'perf-floor', pose: 'overview', bench: BENCH, shot: true },
  { name: 'city240', path: `/?${fx('perf-city240')}&ts`, bench: BENCH, shot: true, settle: 2500 },
  { name: 'floor60-2', path: `/?${fx('perf-floor60')}&ts`, floor: 'perf-floor', pose: 'overview', bench: BENCH },
  { name: 'city240-2', path: `/?${fx('perf-city240')}&ts`, bench: BENCH, settle: 2500 },
  { name: 'city240-3', path: `/?${fx('perf-city240')}&ts`, bench: BENCH, settle: 2500 },
  // M3b: the outside of an 8-floor tower (facade, fire escape, street, neighbours).
  { name: 'street8', path: `/?${fx('perf-city240')}&ts`, floor: 'tower-a-8', pose: 'street', bench: BENCH, shot: true, settle: 2500 },
  { name: 'escape8', path: `/?${fx('perf-city240')}&ts`, floor: 'tower-a-8', pose: 'landing', bench: BENCH, shot: true, settle: 2500 },
  { name: 'window8', path: `/?${fx('perf-city240')}&ts`, floor: 'tower-a-8', pose: 'window', bench: BENCH, shot: true, settle: 2500 },
  // M3c: the tall room from the mezzanine, at the glass and seated at your desk.
  { name: 'floor60-mezz', path: `/?${fx('perf-floor60')}&ts`, floor: 'perf-floor', pose: 'mezz', bench: BENCH, shot: true },
  { name: 'floor60-desk', path: `/?${fx('perf-floor60')}&ts`, floor: 'perf-floor', pose: 'desk', bench: BENCH, shot: true },
  // #20: every card of a 96-desk floor needing you, from your desk (the overlook has no card cap).
  { name: 'floor96-desk', path: `/?${fx('perf-floor96')}&ts`, floor: 'perf-floor96', pose: 'desk', bench: BENCH, shot: true },
  // M5: the busy floor with four live laptop screens (the simulator plays recorded frames), none, and seated at one.
  { name: 'floor60-screens', path: `/?ws=${encodeURIComponent('/fixture/perf-floor60?play=none&sim=1')}&ts&screens=4`, floor: 'perf-floor', pose: 'overview', bench: BENCH, shot: true, settle: 4000 },
  { name: 'floor60-screens0', path: `/?ws=${encodeURIComponent('/fixture/perf-floor60?play=none&sim=1')}&ts&screens=0`, floor: 'perf-floor', pose: 'overview', bench: BENCH, settle: 4000 },
  { name: 'floor60-laptop', path: `/?ws=${encodeURIComponent('/fixture/perf-floor60?play=none&sim=1')}&ts&screens=4`, floor: 'perf-floor', pose: 'laptop', bench: BENCH, shot: true, settle: 4000 },
  // M7: the same floor with the boards holding 100 issues and 20 pull requests (the simulator), and without boards.
  { name: 'boards100', path: `/?ws=${encodeURIComponent('/fixture/perf-boards?play=none&sim=1&simusage=0')}&ts`, floor: 'perf-floor', pose: 'boards', bench: BENCH, shot: true, settle: 4000 },
  { name: 'boards0', path: `/?ws=${encodeURIComponent('/fixture/perf-boards?play=none&sim=1&simusage=0&simfail=no_m7')}&ts`, floor: 'perf-floor', pose: 'boards', bench: BENCH, settle: 4000 },
  { name: 'floor60-street', path: `/?${fx('perf-floor60')}&ts`, floor: 'perf-floor', pose: 'street', bench: BENCH, settle: 2500 },
  { name: 'demo-city', path: `/?${fx('demo')}`, shot: true, settle: 2500 },
  { name: 'demo-desk-row', path: `/?${fx('demo')}`, floor: 'herdr-3d', pose: 'row', shot: true },
  // #145: the overview page alone, the scene stopped (opt-in: H3D_PERF_JOBS=floor60-ov,city240-ov,floor96-ov): the busy
  // floor's page and the all-floors page left open 20 s, and the 96 needs-you rows' page opened four times.
  { name: 'floor60-ov', path: `/?${fx('perf-floor60')}`, floor: 'perf-floor', overview: { ms: 20_000 } },
  { name: 'city240-ov', path: `/?${fx('perf-city240')}`, overview: { ms: 20_000 }, settle: 2500 },
  { name: 'floor96-ov', path: `/?${fx('perf-floor96')}`, floor: 'perf-floor96', overview: { ms: 5000 } },
  // Diagnostics (select with H3D_PERF_JOBS=a,b,…).
  { name: 'city240-nobadges', path: `/?${fx('perf-city240')}&ts&badges=0`, bench: BENCH, settle: 2500 },
  { name: 'city240-noshadows', path: `/?${fx('perf-city240')}&ts&shadows=0`, bench: BENCH, settle: 2500 },
  { name: 'city240-nots', path: `/?${fx('perf-city240')}`, bench: BENCH, settle: 2500 },
].filter((j) => (process.env.H3D_PERF_JOBS ? process.env.H3D_PERF_JOBS.split(',').includes(j.name) : !j.name.startsWith('city240-no') && !('overview' in j)));

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const preview = spawn('pnpm', ['exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: GAME, stdio: 'ignore' });
  procs.push(preview);
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`);
      if (r.ok) break;
    } catch {}
    if (i > 100) throw new Error('vite preview did not come up');
    await new Promise((r) => setTimeout(r, 100));
  }
  log(`preview on 127.0.0.1:${port}`);

  const busy = onMac(`lsof -nP -iTCP:${port} -sTCP:LISTEN; true`).trim();
  if (busy) throw new Error(`port ${port} is in use on the Mac:\n${busy}`);
  const tunnel = spawn('ssh', [...SSH, '-o', 'ExitOnForwardFailure=yes', '-N', '-R', `127.0.0.1:${port}:127.0.0.1:${port}`, MAC], { stdio: 'inherit' });
  procs.push(tunnel);
  for (let i = 0; ; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (tunnel.exitCode !== null) throw new Error('reverse tunnel failed');
    const code = onMac(`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/; true`).trim();
    if (code === '200') break;
    if (i > 20) throw new Error(`Mac cannot reach the game through the tunnel (${code})`);
  }
  log(`Mac sees the game on http://127.0.0.1:${port}`);

  const cfg = Buffer.from(JSON.stringify({ base: `http://127.0.0.1:${port}`, jobs })).toString('base64');
  const runner = readFileSync(join(GAME, 'tools', 'mac-runner.mjs'), 'utf8');
  const out = onMac(`cd ~/h3d-tools; and /opt/homebrew/bin/node --input-type=module - ${cfg}`, runner);

  const baseline = readFileSync(join(GAME, '..', 'docs', 'research', 'engine-bench', 'results', 'bench-chrome.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { query: string; frameMs: { med: number }; pipelinedMs: number; gpuTimestampMs: { med: number } })
    .find((r) => r.query === 'backend=webgpu&kind=rigid&ts');
  const results: Record<string, unknown> = {};
  for (const line of out.split('\n').filter((l) => l.startsWith('{'))) {
    const r = JSON.parse(line) as { job: string; png?: string; bench?: unknown };
    if (r.png) {
      writeFileSync(join(OUT, `${r.job}-webgpu.png`), Buffer.from(r.png, 'base64'));
      r.png = `${r.job}-webgpu.png`;
    }
    writeFileSync(join(OUT, `${r.job}.json`), JSON.stringify(r, null, 2));
    results[r.job] = r;
    log(`${r.job}: ${JSON.stringify(r).slice(0, 400)}`);
  }
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ at: new Date().toISOString(), baseline, results }, null, 2));
  log(`results in ${OUT}`);
}

try {
  await main();
} finally {
  cleanup();
}
