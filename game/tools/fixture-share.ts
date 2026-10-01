// M13 screen share for the fixture simulator (`sim=1`, see tools/fixture-sim.ts), the way herdr-world does it
// (docs/protocol.md "Screen share"):
// - the snapshot carries `screen: {sharing}`; `screen.share {sharing, surface?}` acks and sends `screen.state` when
//   what is shared changed;
// - `screen.grab {floor, requester}` (a CLI's command; in a spec the game's own connection sends it) is refused with
//   `no_client` before a `screen.share` and `not_sharing` while not sharing; otherwise it sends this connection a
//   `screen.frame_request {req_id}` and waits up to `simgrabms` (default 5000) for the JPEG on
//   `POST /screen/frame/<req_id>` (this file's HTTP route), or a `screen.frame {req_id, error}`; the ack has a fake
//   path, the JPEG's size and dimensions, and a `screen.grabbed` goes out first (the toast);
// - the route checks what the bridge checks: the JPEG magic bytes, the 8 MiB cap, at most 1920 × 4096 pixels (read
//   from the SOF header; no decode), and answers 404 for a request nobody waits for. `GET /screen/_log` lists what it
//   received (id, size, dimensions, result; never bytes).
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

type Obj = Record<string, unknown>;
type Send = (m: Obj) => void;

export const FRAME_MAX = 8 << 20;

interface Waiting {
  done(r: { ok: true; bytes: number; w: number; h: number } | { ok: false; code: string; message: string }): void;
}

/** Frame requests waiting for their JPEG, by id: shared by every simulated world and the HTTP route. */
const waiting = new Map<string, Waiting>();
const log: Array<{ id: string; bytes: number; w: number; h: number; result: string }> = [];

/** The dimensions in a JPEG's SOF header, or null. */
export function jpegSize(b: Buffer): { w: number; h: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1] as number;
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(`${JSON.stringify(body)}\n`);
}

/** Serves `POST /screen/frame/<id>` and `GET /screen/_log`; false for any other path. */
export function screenRoute(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? '/', 'http://fixture');
  if (url.pathname === '/screen/_log') {
    json(res, 200, { data: log });
    return true;
  }
  const m = /^\/screen\/frame\/([^/]*)$/.exec(url.pathname);
  if (!m) return false;
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' }).end();
    return true;
  }
  const id = m[1] ?? '';
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size <= FRAME_MAX) chunks.push(c);
  });
  req.on('end', () => {
    const fail = (status: number, code: string, message: string) => {
      log.push({ id, bytes: size, w: 0, h: 0, result: code });
      waiting.get(id)?.done({ ok: false, code, message });
      json(res, status, { t: 'error', code, message });
    };
    if (!/^[0-9a-f]{32}$/.test(id)) return fail(400, 'bad_request', 'a frame request id is 32 hex digits');
    if (!waiting.has(id)) {
      log.push({ id, bytes: size, w: 0, h: 0, result: 'not_found' });
      return json(res, 404, { t: 'error', code: 'not_found', message: 'no screen grab is waiting for this frame' });
    }
    if (size > FRAME_MAX) return fail(413, 'frame_too_large', 'frame too large');
    const dims = jpegSize(Buffer.concat(chunks));
    if (!dims) return fail(422, 'frame_invalid', 'not a valid JPEG');
    if (dims.w > 1920 || dims.h > 4096) return fail(413, 'frame_too_large', `${dims.w} × ${dims.h} pixels, at most 1920 × 4096`);
    log.push({ id, bytes: size, ...dims, result: 'ok' });
    waiting.get(id)?.done({ ok: true, bytes: size, ...dims });
    json(res, 200, { t: 'ack', data: { bytes: size, ...dims } });
  });
  return true;
}

export class ShareSim {
  private game = false;
  private sharing = false;
  private surface: string | undefined;
  private readonly mine = new Set<string>();

  constructor(
    private readonly emit: (send: Send, m: Obj) => void,
    private readonly error: (code: string, message: string) => Error,
    private readonly hasFloor: (session: string) => boolean,
    private readonly grabMs = 5000,
  ) {}

  decorate(world: Obj): void {
    world.screen = this.sharing ? { sharing: true, ...(this.surface ? { surface: this.surface } : {}) } : { sharing: false };
  }

  handle(t: unknown, a: Obj, send: Send, ack: (d?: unknown) => void, fail: (e: unknown) => void): boolean {
    switch (t) {
      case 'screen.share': {
        const was = JSON.stringify([this.sharing, this.surface]);
        this.game = true;
        this.sharing = a.sharing === true;
        this.surface = this.sharing && typeof a.surface === 'string' ? a.surface : undefined;
        if (!this.sharing) for (const id of this.mine) waiting.get(id)?.done({ ok: false, code: 'not_sharing', message: 'screen sharing stopped before the frame was sent' });
        if (JSON.stringify([this.sharing, this.surface]) !== was) this.emit(send, { t: 'screen.state', sharing: this.sharing, ...(this.surface ? { surface: this.surface } : {}) });
        ack();
        return true;
      }
      case 'screen.frame': {
        const id = typeof a.req_id === 'string' ? a.req_id : '';
        if (!this.mine.has(id)) throw this.error('not_found', `no frame request "${id}" is waiting for this connection`);
        waiting.get(id)?.done({ ok: false, code: 'frame_unavailable', message: `the game could not take a frame: ${String(a.message ?? a.error)}` });
        ack();
        return true;
      }
      case 'screen.grab': {
        const floor = typeof a.floor === 'string' ? a.floor : '';
        const requester = typeof a.requester === 'string' ? a.requester : '';
        if (!requester || /[\p{Cc}\p{Cf}]/u.test(requester)) throw this.error('bad_request', 'bad args: requester');
        if (!this.hasFloor(floor)) throw this.error('unknown_session', `unknown session: "${floor}"`);
        if (!this.game) throw this.error('no_client', 'no game is connected, so there is no screen to look at');
        if (!this.sharing) throw this.error('not_sharing', 'screen sharing is off: ask the human to press Share screen');
        const id = randomBytes(16).toString('hex');
        const timer = setTimeout(() => waiting.get(id)?.done({ ok: false, code: 'frame_timeout', message: `the game sent no frame within ${this.grabMs}ms` }), this.grabMs);
        const surface = this.surface;
        this.mine.add(id);
        waiting.set(id, {
          done: (r) => {
            clearTimeout(timer);
            waiting.delete(id);
            this.mine.delete(id);
            if (!r.ok) return fail(this.error(r.code, r.message));
            const at = Date.now();
            send({ t: 'screen.grabbed', requester, floor, at });
            ack({ path: `/run/user/1000/herdr-world/screen/frame-${at}-${id}.jpg`, bytes: r.bytes, w: r.w, h: r.h, ...(surface ? { surface } : {}), at, expires: at + 600_000 });
          },
        });
        send({ t: 'screen.frame_request', req_id: id });
        return true;
      }
    }
    return false;
  }

  dispose(): void {
    for (const id of this.mine) waiting.delete(id);
    this.mine.clear();
  }
}
