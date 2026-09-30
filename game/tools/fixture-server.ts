// Plays a recorded bridge stream (game/fixtures/<name>.jsonl) over protocol
// v1, so the game can run without a bridge: hello → welcome → world.snapshot →
// the recorded events. Read-only by default: commands are answered with an
// error. With the simulation on (`sim=1`, or `--simulate` standalone) it
// answers the bridge's commands from an in-memory world instead
// (tools/fixture-sim.ts) and does not play the recorded events.
//
// Used two ways:
// - inside Vite (dev and preview) at `/fixture/<name>`, see vite.config.ts:
//   open the game with `?ws=/fixture/demo`;
// - standalone, bound to 127.0.0.1 on a leased port:
//     portlease run --name fixture -- sh -c 'node tools/fixture-server.ts --port "$PORTLEASE_FIXTURE_PORT"'
//   then `?ws=ws://127.0.0.1:<port>/fixture/demo` (or `/ws` for the default fixture).
//
// Query parameters on the WebSocket URL: `play=none|all|<ms>` (default 2500:
// one recorded event every 2.5 s after the snapshot); `sim=1` simulates
// commands, `simms=<ms>` sets the time between wake/sleep steps (default 600)
// and `simfail=wake_failed|sleep_failed` makes the next wake/sleep fail (M4:
// `hire_failed|fire_failed` the next hire / send-home; `fetch_failed` makes
// origin unreachable for the run: no fetch works, worktree hires are refused);
// `simcap=<session>:<soft>:<hard>[,…]` sets floors' worker caps. M5: `simusage=<ms>` sends working agents'
// `worker.usage` that often (default 5000, 0: never); `simfail=prompt_failed|prompt_retried|answer_unresolved|
// changes_failed` for the next prompt / answer / changes (tools/fixture-panels.ts).
// M6 crew: `simcrew=<ms>` walks a scripted freelancer through its lifecycle by
// itself (tools/fixture-crew.ts; `sim.crew` steps it on demand). M10: `simlimits=ok|hot|reached|old|transcript|noplan|none` picks the
// plan limits' readings (tools/fixture-limits.ts), `simfail=no_m10` plays a bridge without them.
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { logoRoute, registerLogoWorld } from './fixture-logo.ts';
import { SimWorld, type SimOptions } from './fixture-sim.ts';

export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const NAME = /^[a-z0-9][a-z0-9-]*$/;

interface Recorded {
  snapshot: { t: string; seq: number; world: Record<string, unknown> };
  events: Array<{ t: string; seq: number }>;
}

export function loadFixture(name: string, dir = FIXTURES_DIR): Recorded {
  if (!NAME.test(name)) throw new Error(`bad fixture name ${JSON.stringify(name)}`);
  const lines = readFileSync(join(dir, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { t: string; seq: number; world: Record<string, unknown> });
  const [snapshot, ...events] = lines;
  if (!snapshot || snapshot.t !== 'world.snapshot') throw new Error(`${name}: first line must be a world.snapshot`);
  return { snapshot, events };
}

export interface FixtureOptions {
  dir?: string;
  /** Fixture served on `/ws`. */
  defaultFixture?: string;
  /** Simulate commands on every connection, as if each had `sim=1`. */
  simulate?: boolean;
  log?: (msg: string) => void;
}

function play(ws: WebSocket, rec: Recorded, mode: string, epoch: string, sim: SimOptions | null, logoKey: string | null, seedLogos = false): void {
  const send = (m: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  let greeted = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const world = sim ? new SimWorld(rec.snapshot, sim) : null;
  // M3d: /logo requests with the same `simlogo=<key>` belong to this world.
  if (world && seedLogos) world.seedLogos();
  const unregister = world && logoKey !== null ? registerLogoWorld(logoKey, world) : null;
  ws.on('close', () => {
    timers.forEach(clearTimeout);
    unregister?.();
    world?.dispose();
  });
  ws.on('message', (data) => {
    let m: { t?: unknown; proto?: unknown; req_id?: unknown };
    try {
      m = JSON.parse(String(data)) as typeof m;
    } catch {
      send({ t: 'error', code: 'bad_request', message: 'not JSON' });
      return;
    }
    if (!greeted) {
      if (m.t !== 'hello') {
        send({ t: 'error', code: 'hello_required', message: 'first message must be hello' });
        ws.close(1008, 'hello required');
        return;
      }
      if (m.proto !== 1) {
        send({ t: 'error', code: 'unsupported_proto', message: `unsupported proto ${String(m.proto)}` });
        ws.close(1008, 'unsupported proto');
        return;
      }
      greeted = true;
      if (world) {
        send({ t: 'welcome', proto: 1, server_seq: world.seq, epoch, resume: 'snapshot', server: 'h3d-fixture-server (simulating)' });
        send(world.snapshot());
        world.start(send);
        return;
      }
      send({ t: 'welcome', proto: 1, server_seq: rec.snapshot.seq, epoch, resume: 'snapshot', server: 'h3d-fixture-server' });
      send(rec.snapshot);
      if (mode === 'all') rec.events.forEach(send);
      else if (mode !== 'none') {
        const every = Math.max(50, Number(mode) || 2500);
        rec.events.forEach((e, i) => timers.push(setTimeout(() => send(e), every * (i + 1))));
      }
      return;
    }
    if (world) {
      world.handle(m as Record<string, unknown>, send);
      return;
    }
    if (typeof m.req_id === 'string') {
      send({ t: 'error', req_id: m.req_id, code: 'unknown_command', message: 'the fixture server is read-only' });
    } else {
      send({ t: 'error', code: 'bad_request', message: 'missing req_id' });
    }
  });
}

/** `simcap=scratchpad:3:4,pastry:10:12` → per-floor caps (bad entries are skipped). */
export function parseCaps(v: string): Record<string, { soft: number; hard: number }> {
  const out: Record<string, { soft: number; hard: number }> = {};
  for (const part of v.split(',')) {
    const [session, soft, hard] = part.split(':');
    const s = Number(soft);
    const h = Number(hard);
    if (session && Number.isInteger(s) && Number.isInteger(h) && s >= 0 && h >= s) out[session] = { soft: s, hard: h };
  }
  return out;
}

/** An `upgrade` listener serving `/fixture/<name>` (and `/ws`); returns false for other paths. */
export function fixtureUpgradeHandler(o: FixtureOptions = {}) {
  const wss = new WebSocketServer({ noServer: true });
  const epoch = `fixture-${Date.now().toString(16)}`;
  return (req: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    const url = new URL(req.url ?? '/', 'http://fixture');
    let name: string | undefined;
    if (url.pathname.startsWith('/fixture/')) name = url.pathname.slice('/fixture/'.length);
    else if (url.pathname === '/ws' && o.defaultFixture) name = o.defaultFixture;
    else return false;
    let rec: Recorded;
    try {
      rec = loadFixture(name, o.dir);
    } catch (err) {
      o.log?.(`fixture ${name}: ${String(err)}`);
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return true;
    }
    const mode = url.searchParams.get('play') ?? '2500';
    const q = url.searchParams;
    const sim: SimOptions | null =
      o.simulate || q.get('sim') === '1'
        ? {
            stepMs: Math.max(20, Number(q.get('simms')) || 600),
            ...(q.get('simfail') ? { fail: q.get('simfail') as string } : {}),
            ...(q.get('simcap') ? { caps: parseCaps(q.get('simcap') as string) } : {}),
            ...(q.get('simusage') !== null ? { usageMs: Math.max(0, Number(q.get('simusage')) || 0) } : {}),
            // M6 crew: the scripted freelancer plays by itself (tools/fixture-crew.ts).
            // M10: the plan limits' readings (tools/fixture-limits.ts).
            ...(q.get('simlimits') ? { limits: q.get('simlimits') as string } : {}),
            ...(q.get('simcrew') !== null ? { crewMs: Math.max(0, Number(q.get('simcrew')) || 0) } : {}),
          }
        : null;
    wss.handleUpgrade(req, socket, head, (ws) => {
      o.log?.(`fixture ${name}: client connected (${sim ? `simulating, step ${sim.stepMs} ms` : `play=${mode}`})`);
      play(ws, rec, mode, epoch, sim, q.get('simlogo'), q.get('simlogos') === '1');
    });
    return true;
  };
}

/** Listens on 127.0.0.1:`port`, or on a unix socket path (tests). */
export function startFixtureServer(port: number | string, o: FixtureOptions = {}): Promise<Server> {
  const handler = fixtureUpgradeHandler(o);
  const srv = createServer((req, res) => {
    if (logoRoute(req, res)) return;
    res.writeHead(404, { 'content-type': 'text/plain' }).end('herdr-3d fixture server: WebSocket only (/fixture/<name>, /ws), and /logo/<building>\n');
  });
  srv.on('upgrade', (req, socket, head) => {
    if (!handler(req, socket, head)) socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    if (typeof port === 'string') srv.listen(port, () => resolve(srv));
    else srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const port = Number(opt('--port') ?? process.env.PORTLEASE_FIXTURE_PORT);
  if (!Number.isInteger(port) || port <= 0) {
    console.error('usage: fixture-server.ts --port <port> [--fixture demo] [--simulate]  (or PORTLEASE_FIXTURE_PORT)');
    process.exit(2);
  }
  const defaultFixture = opt('--fixture') ?? 'demo';
  const simulate = args.includes('--simulate');
  await startFixtureServer(port, { defaultFixture, simulate, log: (m) => console.log(m) });
  console.log(`fixture server on ws://127.0.0.1:${port}/ws (${defaultFixture}) and /fixture/<name>${simulate ? ', simulating commands' : ''}`);
}
