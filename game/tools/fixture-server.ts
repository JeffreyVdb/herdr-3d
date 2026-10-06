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
// plan limits' readings (tools/fixture-limits.ts), `simfail=no_m10` plays a bridge without them. #155: `simfail=no_codex_run` a bridge that cannot start Codex workers' own servers (tools/fixture-codex-server.ts). #51: `simmodels=<n>` adds n
// Claude models to the hire options (a long model list). #74: `simzoom=old|single|split|headless` plays the bridge's pane zoom
// (tools/fixture-screen.ts). #58: `simecho=<ms>` writes a prompt's `user` item to its
// worker's transcript watch that long after the turn takes it (tools/fixture-panels.ts; absent: never).
// #92: `simjev=<url>` is where the simulated bridge calls Jev (the e2e's fake), `simai=off` a bridge without the AI service, `simfail=no_ai` one before it
// (tools/fixture-ai.ts). #90: `sim.turn {id, text}` ends a worker's turn with that message, and follow-up questions
// run on it once switched on (tools/fixture-followup.ts).
// #110: `sim.packup_lag {ms}` holds each later `packup.detect` ack that long after its answer (tools/fixture-packup.ts).
// #106: `inbox.dismiss` records a done episode's dismissal, `sim.status {id, status}` moves a worker's status, `simfail=no_inbox` plays a
// bridge before it (tools/fixture-inbox.ts).
// #157: `simcodex=ask` seeds Pixel (demo-m5) as a shared Codex worker whose running turn asked async questions, on every
// connection (a reconnect replays it); `sim.codex`, `sim.codex_answer`, `sim.codex_turn_end`, `worker.answer_async` and
// `worker.dismiss_async`, `simfail=async_input_failed|async_stale|async_unconfirmed|async_undelivered`
// (tools/fixture-codex-questions.ts).
// #51: `POST /upload` stores nothing and answers a fake Drop Zone path (tools/fixture-upload.ts); the query of the ws URL
// carries `fail_upload=<N|all>&upload_key=<key>` to make uploads fail.
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { logoRoute, registerLogoWorld } from './fixture-logo.ts';
import { uploadRoute } from './fixture-upload.ts';
import { screenRoute } from './fixture-share.ts';
import { registerWhiteboardWorld, whiteboardCommand, whiteboardRoute } from './fixture-whiteboard.ts';
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

function play(ws: WebSocket, rec: Recorded, mode: string, epoch: string, sim: SimOptions | null, logoKey: string | null, seedLogos = false, wbKey: string | null = null): void {
  const send = (m: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  let greeted = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const world = sim ? new SimWorld(rec.snapshot, sim) : null;
  // M3d: /logo requests with the same `simlogo=<key>` belong to this world.
  if (world && seedLogos) world.seedLogos();
  const unregister = world && logoKey !== null ? registerLogoWorld(logoKey, world) : null;
  // M13: /whiteboard requests with the same `wb_key=<key>` announce their changes in this world.
  const unregisterWb = world && wbKey !== null ? registerWhiteboardWorld(wbKey, (m) => world.announce(m)) : null;
  ws.on('close', () => {
    timers.forEach(clearTimeout);
    unregister?.();
    unregisterWb?.();
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
      // M13: the whiteboard's commands (tools/fixture-whiteboard.ts), with `wb_key=<key>`.
      if (wbKey !== null && typeof m.req_id === 'string' && whiteboardKnown(m.t)) {
        const reqId = m.req_id;
        const args = ((m as { args?: unknown }).args ?? {}) as Record<string, unknown>;
        try {
          whiteboardCommand(wbKey, m.t, args, (data) => send(data === undefined ? { t: 'ack', req_id: reqId } : { t: 'ack', req_id: reqId, data }), (code, message) => {
            throw Object.assign(new Error(message), { code });
          }, 'herdr-3d-game');
        } catch (err) {
          send({ t: 'error', req_id: reqId, code: (err as { code?: string }).code ?? 'internal', message: (err as Error).message });
        }
        return;
      }
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

const whiteboardKnown = (t: unknown) => t === 'whiteboard.get' || t === 'whiteboard.clear' || t === 'drops.list';

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
            // #92: AI integration: Jev's address (the e2e's fake) and a bridge without the service.
            ...(q.get('simjev') ? { jev: q.get('simjev') as string } : {}),
            ...(q.get('simai') === 'off' ? { ai: 'off' as const } : {}),
            // #51: a long model list in the hire dialog.
            ...(q.get('simmodels') ? { models: Math.min(200, Math.max(0, Number(q.get('simmodels')) || 0)) } : {}),
            ...(q.get('simcrew') !== null ? { crewMs: Math.max(0, Number(q.get('simcrew')) || 0) } : {}),
            // #58: prompts show in the transcript, a while after they were taken.
            // #74: the bridge's pane zoom (tools/fixture-screen.ts).
            ...(['old', 'single', 'split', 'headless'].includes(q.get('simzoom') ?? '') ? { zoom: q.get('simzoom') as 'old' | 'single' | 'split' | 'headless' } : {}),
            ...(q.get('simecho') !== null ? { echoMs: Math.max(0, Number(q.get('simecho')) || 0) } : {}),
            // #98: the agents' activities on the desk monitors (tools/fixture-activity.ts).
            ...(q.get('simactivity') ? { activity: q.get('simactivity') as string } : {}),
            // #157: a shared Codex worker's async questions, on every connection (tools/fixture-codex-questions.ts).
            ...(q.get('simcodex') ? { codex: q.get('simcodex') as string } : {}),
          }
        : null;
    wss.handleUpgrade(req, socket, head, (ws) => {
      o.log?.(`fixture ${name}: client connected (${sim ? `simulating, step ${sim.stepMs} ms` : `play=${mode}`})`);
      play(ws, rec, mode, epoch, sim, q.get('simlogo'), q.get('simlogos') === '1', q.get('wb_key'));
    });
    return true;
  };
}

/** Listens on 127.0.0.1:`port`, or on a unix socket path (tests). */
export function startFixtureServer(port: number | string, o: FixtureOptions = {}): Promise<Server> {
  const handler = fixtureUpgradeHandler(o);
  const srv = createServer((req, res) => {
    if (logoRoute(req, res) || uploadRoute(req, res) || screenRoute(req, res) || whiteboardRoute(req, res)) return;
    res.writeHead(404, { 'content-type': 'text/plain' }).end('herdr-3d fixture server: WebSocket only (/fixture/<name>, /ws), /logo/<building> and /upload\n');
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
