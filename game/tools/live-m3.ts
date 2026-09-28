// Opt-in live check for M3 (not part of `pnpm test`):
//
//   pnpm test:live:m3                       # bridge built from this worktree
//   H3D_LIVE_BRIDGE=/path/to/herdr-world pnpm test:live:m3
//
// Starts a throwaway herdr session h3d-m3game-<random> with two plain-shell
// workspaces (no coding agents), the dev WS→unix proxy on a leased port to
// $XDG_RUNTIME_DIR/h3d-m3game/bridge.sock, and e2e-live/m3.spec.ts against the
// built game. The spec runs its own private bridge (db /tmp/h3d-m3game/world.db)
// watching only that session, restarts it, and drives buildings, sleep and
// wake from the UI. Afterwards the session is stopped and deleted and the
// herdr-s-<session> unit a wake created is removed, also on failure or Ctrl-C.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Throwaway } from './herdr-throwaway.ts';
import { startProxy } from './ws-unix-proxy.ts';

const GAME = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(GAME, '..');
const OUT = join(GAME, 'test-results', 'live-m3');
const PREFIX = 'h3d-m3game-';

const proxyPort = Number(process.env.PORTLEASE_PROXY_PORT);
const previewPort = Number(process.env.PORTLEASE_PREVIEW_PORT);
if (!proxyPort || !previewPort) {
  console.error('run via `pnpm test:live:m3` (needs PORTLEASE_PROXY_PORT and PORTLEASE_PREVIEW_PORT)');
  process.exit(2);
}
const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`;
if (!existsSync(runtime)) {
  console.error(`no runtime dir (${runtime}); set XDG_RUNTIME_DIR`);
  process.exit(2);
}
const sockDir = join(runtime, 'h3d-m3game');
const sock = join(sockDir, 'bridge.sock');
const dbDir = '/tmp/h3d-m3game';

const log = (m: string) => console.log(`live-m3: ${m}`);
const procs: ChildProcess[] = [];
let session: Throwaway | null = null;
let closeProxy: (() => void) | null = null;
let work: string | null = null;
let cleaned = false;

/** A bridge the spec left running (killed hard): only ours, found by its private socket. */
function killStrayBridge(): void {
  try {
    execFileSync('pkill', ['-TERM', '-f', '--', `--socket ${sock} `], { stdio: 'ignore' });
  } catch {
    // none running
  }
}

async function cleanup(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  closeProxy?.();
  for (const p of procs.reverse()) if (p.exitCode === null) p.kill('SIGTERM');
  killStrayBridge();
  await new Promise((r) => setTimeout(r, 300));
  if (session) {
    const problems = await session.cleanup();
    for (const p of problems) console.error(`live-m3 cleanup: ${p}`);
    log(`deleted throwaway session ${session.name}`);
  }
  rmSync(sockDir, { recursive: true, force: true });
  if (work) rmSync(work, { recursive: true, force: true });
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void cleanup().then(() => process.exit(130));
  });
}

async function main(): Promise<number> {
  mkdirSync(OUT, { recursive: true });
  work = mkdtempSync(join(tmpdir(), PREFIX));

  let bin = process.env.H3D_LIVE_BRIDGE;
  if (bin) log(`using the prebuilt bridge ${bin}`);
  else {
    bin = join(ROOT, 'bin', 'herdr-world');
    log('building bin/herdr-world from this worktree');
    execFileSync('go', ['build', '-o', bin, './cmd/herdr-world'], { cwd: ROOT, stdio: 'inherit' });
  }

  session = new Throwaway(undefined, PREFIX);
  await session.start(work, join(OUT, 'herdr-server.log'));
  log(`throwaway session ${session.name} is up`);
  const labels = ['CODE|m3-live|1|r1', 'REVIEW|m3-live|1|r1'];
  for (const label of labels) {
    session.run(['--session', session.name, 'workspace', 'create', '--cwd', work, '--label', label, '--no-focus']);
  }
  log(`workspaces ${labels.join(', ')}`);

  rmSync(sockDir, { recursive: true, force: true });
  mkdirSync(sockDir, { recursive: true, mode: 0o700 });
  mkdirSync(dbDir, { recursive: true });
  rmSync(join(dbDir, 'world.db'), { force: true });

  const proxy = await startProxy(proxyPort, sock);
  closeProxy = () => proxy.close();
  log(`proxy ws://127.0.0.1:${proxyPort}/ws -> ${sock}`);

  const pw = spawn('pnpm', ['exec', 'playwright', 'test', '-c', 'playwright.live.config.ts', 'e2e-live/m3.spec.ts'], {
    cwd: GAME,
    stdio: 'inherit',
    env: {
      ...process.env,
      H3D_LIVE_SESSION: session.name,
      H3D_LIVE_LABELS: JSON.stringify(labels),
      H3D_LIVE_WS: `ws://127.0.0.1:${proxyPort}/ws`,
      H3D_LIVE_BRIDGE_BIN: bin,
      H3D_LIVE_SOCKET: sock,
      H3D_LIVE_DB: join(dbDir, 'world.db'),
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
  console.error(`live-m3: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await cleanup();
}
process.exit(code);
