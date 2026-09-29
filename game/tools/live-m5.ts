// Opt-in live check for M5 (not part of `pnpm test`): the game against a real
// bridge and a real herdr.
//
//   pnpm test:live:m5                       # bridge built from this worktree
//   H3D_LIVE_BRIDGE=/path/to/herdr-world pnpm test:live:m5
//
// Starts a throwaway herdr session h3d-m5integ-<random> (HERDR_* / CLAUDE*
// stripped) with three workspaces: a plain shell in a temporary git
// repository (staged, unstaged, untracked and committed-but-unpushed files, a
// local bare `origin`), and two cheap Claude agents (haiku, low effort,
// `--permission-mode default`) in fresh folders, so each stops at its trust
// dialog. Then a private bridge watching only that session (socket
// $XDG_RUNTIME_DIR/h3d-m5integ/<run>/bridge.sock, db
// /tmp/h3d-m5integ/<run>/world.db: <run> is this run's own, so runs in other
// worktrees never share them), the WebSocket → unix-socket proxy on a leased
// port, and e2e-live/m5.spec.ts
// against the built game. Everything is stopped and the session deleted
// afterwards, also on failure or Ctrl-C.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeHealthy } from './live-bridge.ts';
import { makeRunPaths, removeRunPaths, runPaths, type RunPaths } from './live-paths.ts';
import { Throwaway, cleanEnv, startScoped } from './herdr-throwaway.ts';
import { startProxy } from './ws-unix-proxy.ts';

const GAME = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(GAME, '..');
const OUT = join(GAME, 'test-results', 'live-m5');
const PREFIX = 'h3d-m5integ-';
/** The cheapest Claude, as every live test uses. */
const CLAUDE_ARGS = ['--model', 'claude-haiku-4-5-20251001', '--effort', 'low', '--permission-mode', 'default'];

const proxyPort = Number(process.env.PORTLEASE_PROXY_PORT);
const previewPort = Number(process.env.PORTLEASE_PREVIEW_PORT);
if (!proxyPort || !previewPort) {
  console.error('run via `pnpm test:live:m5` (needs PORTLEASE_PROXY_PORT and PORTLEASE_PREVIEW_PORT)');
  process.exit(2);
}
const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`;
if (!existsSync(runtime)) {
  console.error(`no runtime dir (${runtime}); set XDG_RUNTIME_DIR`);
  process.exit(2);
}
const log = (m: string) => console.log(`live-m5: ${m}`);
const procs: ChildProcess[] = [];
let session: Throwaway | null = null;
let closeProxy: (() => void) | null = null;
let work: string | null = null;
/** This run's bridge socket and database (made once `work` names the run). */
let paths: RunPaths | null = null;
let cleaned = false;

async function cleanup(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  closeProxy?.();
  for (const p of procs.reverse()) if (p.exitCode === null) p.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  if (session) {
    const problems = await session.cleanup();
    for (const p of problems) console.error(`live-m5 cleanup: ${p}`);
    log(`deleted throwaway session ${session.name}`);
  }
  if (paths) removeRunPaths(paths);
  if (work) rmSync(work, { recursive: true, force: true });
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void cleanup().then(() => process.exit(130));
  });
}

/** A repository with every kind of change the Changes panel lists, and an `origin` whose default branch is main. */
function makeRepo(dir: string): string {
  const repo = join(dir, 'repo');
  const origin = join(dir, 'origin.git');
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: cleanEnv() });
  execFileSync('git', ['clone', '-q', origin, repo], { env: cleanEnv(), stdio: 'ignore' });
  git('config', 'user.name', 'h3d live');
  git('config', 'user.email', 'h3d-live@example.invalid');
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'README.md'), '# live repo\n\nA throwaway repository for the M5 live test.\n');
  writeFileSync(join(repo, 'src', 'app.txt'), Array.from({ length: 40 }, (_, i) => `line ${i + 1}\n`).join(''));
  writeFileSync(join(repo, 'src', 'gone.txt'), 'this file is deleted in the working tree\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  git('push', '-q', 'origin', 'main');
  git('remote', 'set-head', 'origin', 'main');
  git('branch', '-q', '--set-upstream-to=origin/main');
  // Committed, not pushed.
  writeFileSync(join(repo, 'src', 'feature.txt'), 'a feature\nin two lines\n');
  git('add', 'src/feature.txt');
  git('commit', '-q', '-m', 'feature');
  // Staged.
  writeFileSync(join(repo, 'staged.txt'), 'staged one\nstaged two\nstaged three\n');
  git('add', 'staged.txt');
  // Unstaged: a modification and a deletion.
  writeFileSync(join(repo, 'src', 'app.txt'), Array.from({ length: 40 }, (_, i) => (i % 10 === 3 ? `changed ${i + 1}\n` : `line ${i + 1}\n`)).join('') + 'appended\n');
  rmSync(join(repo, 'src', 'gone.txt'));
  // Untracked.
  writeFileSync(join(repo, 'scratch.txt'), 'untracked\nnotes\n');
  return repo;
}

interface Created {
  result: { workspace: { workspace_id: string }; root_pane: { pane_id: string } };
}

async function main(): Promise<number> {
  mkdirSync(OUT, { recursive: true });
  work = mkdtempSync(join(tmpdir(), PREFIX));
  const run = runPaths('h3d-m5integ', basename(work), runtime);
  paths = run;
  const sock = run.sock;

  let bin = process.env.H3D_LIVE_BRIDGE;
  if (bin) log(`using the prebuilt bridge ${bin}`);
  else {
    bin = join(ROOT, 'bin', 'herdr-world');
    log('building bin/herdr-world from this worktree');
    execFileSync('go', ['build', '-o', bin, './cmd/herdr-world'], { cwd: ROOT, stdio: 'inherit' });
  }

  const repo = makeRepo(work);
  const dirs = { alpha: join(work, 'alpha'), beta: join(work, 'beta') };
  for (const d of Object.values(dirs)) mkdirSync(d);

  const s = new Throwaway(undefined, PREFIX);
  session = s;
  await s.start(work, join(OUT, 'herdr-server.log'));
  log(`throwaway session ${s.name} is up`);

  makeRunPaths(run);
  const bridgeLog = openSync(join(OUT, 'bridge.log'), 'w');
  const bridge = spawn(bin, ['--socket', sock, '--db', run.db, '--sessions', `^${s.name}$`, '--log-level', 'debug'], {
    env: cleanEnv(),
    stdio: ['ignore', bridgeLog, bridgeLog],
  });
  procs.push(bridge);
  for (let i = 0; !(await bridgeHealthy(sock)); i++) {
    if (i > 100 || bridge.exitCode !== null) throw new Error('bridge did not come up (see test-results/live-m5/bridge.log)');
    await new Promise((r) => setTimeout(r, 100));
  }
  log(`bridge on ${sock}`);

  const labels = { shell: 'shell', alpha: 'alpha', beta: 'beta' };
  const panes: Record<string, string> = {};
  for (const [k, cwd] of [['shell', repo], ['alpha', dirs.alpha], ['beta', dirs.beta]] as const) {
    const c = JSON.parse(s.run(['--session', s.name, 'workspace', 'create', '--cwd', cwd, '--label', labels[k], '--no-focus'])) as Created;
    panes[k] = c.result.root_pane.pane_id;
  }
  log(`workspaces ${JSON.stringify(panes)}`);
  // Both stop at their trust dialog (a folder they have never seen), which fails `agent start`: expected.
  for (const k of ['alpha', 'beta'] as const) {
    void startScoped(s.name, ['--session', s.name, 'agent', 'start', `h3d-${k}`, '--kind', 'claude', '--pane', panes[k] as string, '--timeout', '30000', '--', ...CLAUDE_ARGS]).then((r) =>
      log(`agent start ${k}: exit ${r.code} ${r.out.trim().slice(0, 300)}`),
    );
  }

  const proxy = await startProxy(proxyPort, sock);
  closeProxy = () => proxy.close();
  log(`proxy ws://127.0.0.1:${proxyPort}/ws -> ${sock}`);

  const pw = spawn('pnpm', ['exec', 'playwright', 'test', '-c', 'playwright.live.config.ts', 'e2e-live/m5.spec.ts', ...process.argv.slice(2)], {
    cwd: GAME,
    stdio: 'inherit',
    env: {
      ...process.env,
      H3D_LIVE_SESSION: s.name,
      H3D_LIVE_WS: `ws://127.0.0.1:${proxyPort}/ws`,
      H3D_LIVE_REPO: repo,
      H3D_LIVE_DIRS: JSON.stringify(dirs),
      H3D_LIVE_OUT: OUT,
    },
  });
  procs.push(pw);
  return new Promise<number>((res) => pw.once('exit', (c) => res(c ?? 1)));
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error(`live-m5: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await cleanup();
}
process.exit(code);
