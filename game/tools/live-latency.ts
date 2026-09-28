// Opt-in live check (not part of `pnpm test`): a status change in a real
// herdr reaches the rendered game within 1 s.
//
//   pnpm test:live
//
// It builds the bridge from this worktree (bin/herdr-world; H3D_LIVE_BRIDGE=<path>
// uses a prebuilt one instead, e.g. another branch's bridge), starts a
// throwaway herdr session h3d-m2game-<random>, a private bridge watching only
// that session (socket $XDG_RUNTIME_DIR/h3d-m2game/bridge.sock, db
// /tmp/h3d-m2game/world.db), the dev WS→unix proxy on a leased port, and then
// e2e-live/latency.spec.ts against the built game. Everything is stopped and
// the session deleted afterwards, also on failure or Ctrl-C.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Throwaway, cleanEnv } from './herdr-throwaway.ts';
import { startProxy } from './ws-unix-proxy.ts';

const GAME = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(GAME, '..');
const OUT = join(GAME, 'test-results', 'live');

const proxyPort = Number(process.env.PORTLEASE_PROXY_PORT);
const previewPort = Number(process.env.PORTLEASE_PREVIEW_PORT);
if (!proxyPort || !previewPort) {
  console.error('run via `pnpm test:live` (needs PORTLEASE_PROXY_PORT and PORTLEASE_PREVIEW_PORT)');
  process.exit(2);
}
// Same default the bridge uses; SSH/agent shells do not always export it.
const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`;
if (!existsSync(runtime)) {
  console.error(`no runtime dir (${runtime}); set XDG_RUNTIME_DIR`);
  process.exit(2);
}
const sockDir = join(runtime, 'h3d-m2game');
const sock = join(sockDir, 'bridge.sock');
const dbDir = '/tmp/h3d-m2game';

const log = (m: string) => console.log(`live: ${m}`);
const procs: ChildProcess[] = [];
let session: Throwaway | null = null;
let closeProxy: (() => void) | null = null;
let cleaned = false;

async function cleanup(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  closeProxy?.();
  for (const p of procs.reverse()) if (p.exitCode === null) p.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  if (session) {
    const problems = await session.cleanup();
    for (const p of problems) console.error(`live cleanup: ${p}`);
    log(`deleted throwaway session ${session.name}`);
  }
  rmSync(sockDir, { recursive: true, force: true });
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void cleanup().then(() => process.exit(130));
  });
}

function healthy(): Promise<boolean> {
  return new Promise((res) => {
    const r = request({ socketPath: sock, path: '/healthz' }, (x) => {
      x.resume();
      res(x.statusCode === 200);
    });
    r.on('error', () => res(false));
    r.end();
  });
}

async function main(): Promise<number> {
  mkdirSync(OUT, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'h3d-m2game-'));

  let bin = process.env.H3D_LIVE_BRIDGE;
  if (bin) log(`using the prebuilt bridge ${bin}`);
  else {
    bin = join(ROOT, 'bin', 'herdr-world');
    log('building bin/herdr-world from this worktree');
    execFileSync('go', ['build', '-o', bin, './cmd/herdr-world'], { cwd: ROOT, stdio: 'inherit' });
  }

  session = new Throwaway();
  await session.start(work, join(OUT, 'herdr-server.log'));
  log(`throwaway session ${session.name} is up`);

  rmSync(sockDir, { recursive: true, force: true });
  mkdirSync(dbDir, { recursive: true });
  rmSync(join(dbDir, 'world.db'), { force: true });
  const bridgeLog = openSync(join(OUT, 'bridge.log'), 'w');
  const bridge = spawn(
    bin,
    ['--socket', sock, '--db', join(dbDir, 'world.db'), '--sessions', `^${session.name}$`, '--log-level', 'debug'],
    { env: cleanEnv(), stdio: ['ignore', bridgeLog, bridgeLog] },
  );
  procs.push(bridge);
  for (let i = 0; !(await healthy()); i++) {
    if (i > 100 || bridge.exitCode !== null) throw new Error('bridge did not come up (see test-results/live/bridge.log)');
    await new Promise((r) => setTimeout(r, 100));
  }
  log(`bridge on ${sock}`);

  const proxy = await startProxy(proxyPort, sock);
  closeProxy = () => proxy.close();
  log(`proxy ws://127.0.0.1:${proxyPort}/ws`);

  const created = JSON.parse(
    session.run(['--session', session.name, 'workspace', 'create', '--cwd', work, '--label', 'CODE|latency|1|r1', '--no-focus']),
  ) as { result: { workspace: { workspace_id: string }; root_pane: { pane_id: string } } };
  const pane = created.result.root_pane.pane_id;
  log(`workspace ${created.result.workspace.workspace_id}, pane ${pane}`);

  const pw = spawn('pnpm', ['exec', 'playwright', 'test', '-c', 'playwright.live.config.ts'], {
    cwd: GAME,
    stdio: 'inherit',
    env: {
      ...process.env,
      H3D_LIVE_SESSION: session.name,
      H3D_LIVE_PANE: pane,
      H3D_LIVE_LABEL: 'CODE|latency|1|r1',
      H3D_LIVE_WS: `ws://127.0.0.1:${proxyPort}/ws`,
      H3D_LIVE_OUT: join(OUT, 'latency.json'),
    },
  });
  procs.push(pw);
  const code = await new Promise<number>((res) => pw.once('exit', (c) => res(c ?? 1)));
  rmSync(work, { recursive: true, force: true });
  return code;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error(`live: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await cleanup();
}
if (existsSync(join(OUT, 'latency.json'))) log(`results in ${join(OUT, 'latency.json')}`);
process.exit(code);
