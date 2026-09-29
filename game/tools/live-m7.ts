// Opt-in live check for M7, the boards (not part of `pnpm test`):
//
//   pnpm test:live:m7                       # bridge built from this worktree
//   H3D_LIVE_BRIDGE=/path/to/herdr-world pnpm test:live:m7
//
// Starts a throwaway herdr session h3d-m7game-<random> (one plain-shell workspace in a fresh clone of the throwaway
// GitHub repository JeffreyVdb/h3d-lab), the dev WS→unix proxy on a leased port to a private bridge's socket, and
// e2e-live/m7.spec.ts against the built game. The spec runs the private bridge itself (`--sessions ^<session>$`, its
// own socket and database under this run's directories). It READS JeffreyVdb/herdr-3d and its project 2 for the look
// (nothing is written there), and WRITES only to JeffreyVdb/h3d-lab and its project 3: two probe issues made here, a
// comment, a status change and a close on them, a run started on one (a cheap Codex orchestrator given a harmless
// prompt: never a /write-code run), and a pull request opened from a plain worker's branch and merged. What it
// created is written to test-results/live-m7/created.json and cleaned up (issues closed, the branch deleted,
// the clone and herdr's worktrees removed), also on failure or Ctrl-C.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Throwaway } from './herdr-throwaway.ts';
import { makeRunPaths, removeRunPaths, runPaths, type RunPaths } from './live-paths.ts';
import { startProxy } from './ws-unix-proxy.ts';

const GAME = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(GAME, '..');
const OUT = join(GAME, 'test-results', 'live-m7');
const PREFIX = 'h3d-m7game-';
const lab = 'JeffreyVdb/h3d-lab';

const proxyPort = Number(process.env.PORTLEASE_PROXY_PORT);
const previewPort = Number(process.env.PORTLEASE_PREVIEW_PORT);
if (!proxyPort || !previewPort) {
  console.error('run via `pnpm test:live:m7` (needs PORTLEASE_PROXY_PORT and PORTLEASE_PREVIEW_PORT)');
  process.exit(2);
}
const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`;
if (!existsSync(runtime)) {
  console.error(`no runtime dir (${runtime}); set XDG_RUNTIME_DIR`);
  process.exit(2);
}
let paths: RunPaths | null = null;

const log = (m: string) => console.log(`live-m7: ${m}`);
const procs: ChildProcess[] = [];
let session: Throwaway | null = null;
let closeProxy: (() => void) | null = null;
let work: string | null = null;
let toyDir: string | null = null;
let cleaned = false;
const probeIssues: number[] = [];

/** `gh`, with the herdr / Claude variables out of its environment; throws with its stderr. */
function gh(args: string[]): string {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('HERDR_') || k.startsWith('CLAUDE')) delete env[k];
  return execFileSync('gh', args, { env, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
}

function killStrayBridge(): void {
  if (!paths) return;
  try {
    execFileSync('pkill', ['-TERM', '-f', '--', `--socket ${paths.sock} `], { stdio: 'ignore' });
  } catch {
    // none running
  }
}

/** Everything the run made on the lab repository, from the spec's own list. */
function createdByTheSpec(): { branches: string[]; prs: number[] } {
  try {
    const c = JSON.parse(readFileSync(join(OUT, 'created.json'), 'utf8')) as { branches?: string[]; prs?: number[] };
    return { branches: c.branches ?? [], prs: c.prs ?? [] };
  } catch {
    return { branches: [], prs: [] };
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
    for (const p of await session.cleanup()) console.error(`live-m7 cleanup: ${p}`);
    log(`deleted throwaway session ${session.name}`);
  }
  // The lab repository: probe issues closed, PRs the run left open closed, its branches deleted. Only what this run made.
  const made = createdByTheSpec();
  for (const n of probeIssues) {
    try {
      if (gh(['issue', 'view', String(n), '-R', lab, '--json', 'state', '-q', '.state']).trim() === 'OPEN') gh(['issue', 'close', String(n), '-R', lab, '--reason', 'not planned']);
    } catch (e) {
      console.error(`live-m7 cleanup: issue #${n}: ${String(e).split('\n')[0]}`);
    }
  }
  for (const n of made.prs) {
    try {
      if (gh(['pr', 'view', String(n), '-R', lab, '--json', 'state', '-q', '.state']).trim() === 'OPEN') gh(['pr', 'close', String(n), '-R', lab]);
    } catch {
      // gone
    }
  }
  for (const b of made.branches) {
    if (!/^h3d\/[\w.-]+$/.test(b)) continue;
    try {
      gh(['api', '-X', 'DELETE', `repos/${lab}/git/refs/heads/${b}`]);
      log(`deleted the lab branch ${b}`);
    } catch {
      // already deleted (a merge may have)
    }
  }
  if (toyDir) rmSync(join(homedir(), '.herdr', 'worktrees', basename(toyDir)), { recursive: true, force: true });
  if (paths) removeRunPaths(paths);
  if (work) rmSync(work, { recursive: true, force: true });
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void cleanup().then(() => process.exit(130));
  });
}

async function main(): Promise<number> {
  mkdirSync(OUT, { recursive: true });
  rmSync(join(OUT, 'bridge.log'), { force: true });
  rmSync(join(OUT, 'created.json'), { force: true });
  work = mkdtempSync(join(tmpdir(), PREFIX));
  const run = runPaths('h3d-m7game', basename(work), runtime);
  paths = run;
  const sock = run.sock;

  let bin = process.env.H3D_LIVE_BRIDGE;
  if (bin) log(`using the prebuilt bridge ${bin}`);
  else {
    bin = join(ROOT, 'bin', 'herdr-world');
    log('building bin/herdr-world from this worktree');
    execFileSync('go', ['build', '-o', bin, './cmd/herdr-world'], { cwd: ROOT, stdio: 'inherit' });
  }

  // A clone of the lab repository with a name of its own: herdr keeps worktrees under ~/.herdr/worktrees/<name>.
  const name = `m7game-lab-${randomBytes(3).toString('hex')}`;
  toyDir = join(work, name);
  gh(['repo', 'clone', lab, toyDir]);
  log(`cloned ${lab} to ${toyDir}`);

  // Two probe issues on the lab repository, in its project (the board shows them under Status).
  const tag = basename(work).slice(-6);
  const issues: Array<{ number: number; title: string }> = [];
  for (const what of ['comment, move and close', 'hand to a worker']) {
    const title = `m7 live ${tag}: ${what}`;
    const url = gh(['issue', 'create', '-R', lab, '--title', title, '--body', 'Made by `pnpm test:live:m7` to try the game’s boards. Safe to close.']).trim();
    const number = Number(url.split('/').pop());
    probeIssues.push(number);
    gh(['project', 'item-add', '3', '--owner', 'JeffreyVdb', '--url', url]);
    issues.push({ number, title });
  }
  log(`lab issues ${issues.map((i) => `#${i.number}`).join(', ')}`);

  session = new Throwaway(undefined, PREFIX);
  await session.start(work, join(OUT, 'herdr-server.log'));
  log(`throwaway session ${session.name} is up`);
  session.run(['--session', session.name, 'workspace', 'create', '--cwd', toyDir, '--label', 'live-shell', '--no-focus']);

  makeRunPaths(run);
  const proxy = await startProxy(proxyPort, sock);
  closeProxy = () => proxy.close();
  log(`proxy ws://127.0.0.1:${proxyPort}/ws -> ${sock}`);

  const shots = process.env.H3D_LIVE_SHOTS ?? join(OUT, 'shots');
  mkdirSync(shots, { recursive: true });
  const pw = spawn('pnpm', ['exec', 'playwright', 'test', '-c', 'playwright.live.config.ts', 'e2e-live/m7.spec.ts'], {
    cwd: GAME,
    stdio: 'inherit',
    env: {
      ...process.env,
      H3D_LIVE_SESSION: session.name,
      H3D_LIVE_WS: `ws://127.0.0.1:${proxyPort}/ws`,
      H3D_LIVE_BRIDGE_BIN: bin,
      H3D_LIVE_SOCKET: sock,
      H3D_LIVE_DB: run.db,
      H3D_LIVE_CWD: toyDir,
      H3D_LIVE_OUT: OUT,
      H3D_LIVE_SHOTS: shots,
      H3D_LIVE_TOY_ISSUES: JSON.stringify(issues),
    },
  });
  procs.push(pw);
  return new Promise<number>((res) => pw.once('exit', (c) => res(c ?? 1)));
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error(`live-m7: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await cleanup();
  if (existsSync(join(OUT, 'created.json'))) log(`created: ${readFileSync(join(OUT, 'created.json'), 'utf8').replace(/\s+/g, ' ')}`);
  writeFileSync(join(OUT, 'exit-code'), String(code));
}
process.exit(code);
