// M13 whiteboard for the fixture server: what the bridge's /whiteboard/{floor}/… routes, its whiteboard.get /
// .clear commands, drops.list and GET /drops/file do (internal/whiteboard, internal/server/whiteboard.go), in memory.
// The checks that matter to the game are the bridge's: a file's id must be the sha256 of its bytes and of a stored
// type, a save names the version it is based on (409 whiteboard_conflict with the current one), a live image's file
// must be stored first, and the render is a PNG of at most 2400 px a side. Every change is announced to the
// simulated world as `whiteboard.updated`.
//
// A request finds its boards by `wb_key=<key>`, a query parameter of the `?ws=` URL the game keeps on every HTTP URL
// (net/whiteboard.ts): specs running in parallel each have their own. Boards outlive a connection (a reload of the
// page finds its drawing again, as after a bridge restart). Test-only routes:
//   - `POST /whiteboard/_pin?wb_key=&floor=&author=&note=` appends an agent's note the way internal/whiteboard's Pin
//     does (the element is the Go-made one in internal/whiteboard/testdata/pinned-scene.json, with a fresh id and
//     index), and `GET /whiteboard/_state?wb_key=&floor=` says what is stored (versions, files by hash, the render).
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { imageType } from './fixture-upload.ts';

export const WB_MAX_FILE = 8 << 20;
export const WB_MAX_SCENE = 16 << 20;
const KEEP = 20;

type Msg = Record<string, unknown>;

interface StoredFile {
  bytes: Buffer;
  mimeType: string;
  created: number;
}

interface StalePin {
  id: string;
  kind: string;
  author: string;
  note?: string;
  version: number;
  at: number;
}

export interface FixtureBoard {
  version: number;
  author: string;
  at: number;
  renderVersion: number;
  render: Buffer | null;
  stalePins: StalePin[];
  elements: Msg[];
  appState: Msg;
  files: Map<string, StoredFile>;
  history: Array<{ version: number; author: string; at: number; elements: Msg[] }>;
  saves: number;
}

const boards = new Map<string, FixtureBoard>();
const worlds = new Map<string, (m: Msg) => void>();

/** The simulated world of `key` announces whiteboard changes through `emit` (a whiteboard.updated with its seq). */
export function registerWhiteboardWorld(key: string, emit: (m: Msg) => void): () => void {
  worlds.set(key, emit);
  return () => {
    if (worlds.get(key) === emit) worlds.delete(key);
  };
}

function boardOf(key: string, floor: string): FixtureBoard {
  const id = `${key}\u0000${floor}`;
  let b = boards.get(id);
  if (!b) {
    b = { version: 0, author: '', at: 0, renderVersion: 0, render: null, stalePins: [], elements: [], appState: { viewBackgroundColor: '#ffffff', gridSize: 20, gridStep: 5, gridModeEnabled: false }, files: new Map(), history: [], saves: 0 };
    boards.set(id, b);
  }
  return b;
}

export function stateOf(floor: string, b: FixtureBoard): Msg {
  return { floor, version: b.version, author: b.author, at: b.at, render_version: b.renderVersion, render: !!b.render, stale: b.renderVersion !== b.version, stale_pins: b.stalePins };
}

function announce(key: string, floor: string, b: FixtureBoard): void {
  worlds.get(key)?.({ t: 'whiteboard.updated', ...stateOf(floor, b) });
}

function commit(b: FixtureBoard, author: string, elements: Msg[]): void {
  b.version++;
  b.author = author || 'someone';
  b.at = Date.now();
  b.elements = elements;
  b.history.push({ version: b.version, author: b.author, at: b.at, elements });
  if (b.history.length > KEEP) b.history.splice(0, b.history.length - KEEP);
}

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** generateKeyBetween(last, null) of fractional-indexing 3.2.0, as internal/whiteboard's AppendIndex (same vectors). */
export function appendIndex(last: string): string {
  if (last === '') return 'a0';
  const head = last.charCodeAt(0);
  const n = head >= 97 && head <= 122 ? head - 97 + 2 : head >= 65 && head <= 90 ? 90 - head + 2 : 0;
  if (!n || last.length < n || [...last.slice(1)].some((c) => !DIGITS.includes(c)) || last === `A${'0'.repeat(26)}` || (last.length > n && last.endsWith('0'))) throw new Error(`bad index ${last}`);
  const int = [...last.slice(0, n)];
  for (let i = n - 1; i >= 1; i--) {
    const d = DIGITS.indexOf(int[i] as string) + 1;
    if (d < DIGITS.length) {
      int[i] = DIGITS[d] as string;
      return int.join('');
    }
    int[i] = '0';
  }
  if (last[0] === 'Z') return 'a0';
  if (last[0] === 'z') {
    let frac = last.slice(n);
    let suffix = '';
    for (;;) {
      const d = frac.length ? DIGITS.indexOf(frac[0] as string) : 0;
      if (DIGITS.length - d > 1) {
        suffix += DIGITS[(d + DIGITS.length + 1) >> 1];
        break;
      }
      suffix += DIGITS[d];
      frac = frac.slice(1);
    }
    return last.slice(0, n) + suffix;
  }
  const next = String.fromCharCode(head + 1);
  return next > 'a' ? next + int.slice(1).join('') + '0' : next + int.slice(1, -1).join('');
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, PUT, OPTIONS', 'access-control-allow-headers': 'content-type' };
const json = (res: ServerResponse, status: number, body: unknown): void => void res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS }).end(`${JSON.stringify(body)}\n`);
const fail = (res: ServerResponse, status: number, code: string, message: string, extra: Msg = {}): void => json(res, status, { t: 'error', code, message, ...extra });

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n <= limit) parts.push(c);
    });
    req.on('end', () => resolve(n > limit ? null : Buffer.concat(parts)));
    req.on('error', reject);
  });
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// ---- recent drops ----------------------------------------------------------------------------------------------

const DROPS_DIR = '/home/fixture/drops/2026-10';

function pngOf(w: number, h: number, paint: (x: number, y: number) => [number, number, number]): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y);
      const i = (y * w + x) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  return PNG.sync.write(png);
}

interface FixtureDrop {
  name: string;
  minutes: number;
  bytes: Buffer;
}

let dropFiles: FixtureDrop[] | null = null;
/** Three images and a document, newest first: what drops.list answers (the same for every key). */
function drops(): FixtureDrop[] {
  dropFiles ??= [
    { name: 'checkout-flow.png', minutes: 3, bytes: pngOf(480, 300, (x, y) => (y < 48 ? [28, 37, 64] : x > 40 && x < 440 && y > 80 && y < 260 ? [47, 107, 240] : [244, 246, 251])) },
    { name: 'error-state.png', minutes: 40, bytes: pngOf(320, 320, (x, y) => ((x - 160) ** 2 + (y - 160) ** 2 < 90 ** 2 ? [232, 65, 58] : [255, 255, 255])) },
    { name: 'notes.md', minutes: 90, bytes: Buffer.from('# notes\n') },
    { name: 'palette.png', minutes: 600, bytes: pngOf(400, 120, (x) => [[255, 194, 51], [47, 196, 106], [138, 90, 200], [28, 37, 64]][Math.floor(x / 100)] as [number, number, number]) },
  ];
  return dropFiles;
}

export function dropsList(limit: number): Msg {
  const now = Date.now();
  return {
    drops: drops()
      .slice(0, limit)
      .map((d) => {
        const t = imageType(d.bytes);
        return { path: `${DROPS_DIR}/${d.name}`, name: d.name, size: d.bytes.length, mtime: now - d.minutes * 60_000, mime: t?.mime ?? '', image: !!t, ...(t ? {} : { reason: 'not_image' }) };
      }),
  };
}

// ---- the agents' note, as Go makes it --------------------------------------------------------------------------

const GO_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'internal', 'whiteboard', 'testdata', 'pinned-scene.json');

/** The note element internal/whiteboard's Pin made, re-identified and re-indexed for this board. */
function goNote(b: FixtureBoard, author: string, note: string): Msg {
  const scene = JSON.parse(readFileSync(GO_FIXTURE, 'utf8')) as { elements: Msg[] };
  const tpl = scene.elements.find((e) => e.type === 'text');
  if (!tpl) throw new Error('no text element in the Go fixture');
  const last = b.elements.map((e) => (typeof e.index === 'string' ? e.index : '')).reduce((a, i) => (i > a ? i : a), '');
  const right = b.elements.filter((e) => !e.isDeleted).reduce((a, e) => Math.max(a, Number(e.x) + Number(e.width)), Number.NEGATIVE_INFINITY);
  const lines = note.split('\n');
  return {
    ...tpl,
    id: `pin_${randomBytes(10).toString('hex')}`,
    index: appendIndex(last),
    x: Number.isFinite(right) ? right + 80 : 0,
    y: 0,
    text: note,
    originalText: note,
    width: Math.max(20, Math.round(Math.max(...lines.map((l) => l.length)) * 12)),
    height: lines.length * 25,
    updated: Date.now(),
    customData: { herdr: { author, kind: 'agent-pin', at: Date.now() } },
  };
}

// ---- WebSocket commands (the simulated world's) ----------------------------------------------------------------

/** whiteboard.get, whiteboard.clear and drops.list for the simulated world of `key`; false for other commands. */
export function whiteboardCommand(key: string, t: unknown, a: Msg, ack: (data?: unknown) => void, error: (code: string, message: string) => never, client: string): boolean {
  if (t === 'drops.list') {
    const limit = a.limit === undefined ? 20 : Number(a.limit);
    if (!Number.isInteger(limit) || limit < 0 || limit > 50) error('bad_request', 'limit is 1-50');
    ack(dropsList(limit || 20));
    return true;
  }
  if (t !== 'whiteboard.get' && t !== 'whiteboard.clear') return false;
  const floor = typeof a.floor === 'string' ? a.floor : '';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(floor)) error('unknown_session', `unknown session: "${floor}"`);
  const b = boardOf(key, floor);
  if (t === 'whiteboard.get') {
    ack(stateOf(floor, b));
    return true;
  }
  if (a.confirm !== true) error('confirmation_required', 'clearing the whiteboard needs confirm: true');
  const now = Date.now();
  commit(
    b,
    typeof a.author === 'string' && a.author ? a.author : client,
    b.elements.filter((e) => !e.isDeleted).map((e) => ({ ...e, isDeleted: true, version: Number(e.version) + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: now })),
  );
  b.render = null;
  b.renderVersion = b.version;
  b.stalePins = [];
  announce(key, floor, b);
  ack(stateOf(floor, b));
  return true;
}

// ---- HTTP ------------------------------------------------------------------------------------------------------

/** Serves /whiteboard/… and /drops/file. Returns false for any other path. */
export function whiteboardRoute(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? '/', 'http://fixture');
  const p = url.pathname;
  if (!p.startsWith('/whiteboard/') && p !== '/drops/file') return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS).end();
    return true;
  }
  const key = url.searchParams.get('wb_key') ?? '';
  void serve(req, res, url, key).catch((err: unknown) => fail(res, 500, 'internal', String(err)));
  return true;
}

async function serve(req: IncomingMessage, res: ServerResponse, url: URL, key: string): Promise<void> {
  const p = url.pathname;
  const q = url.searchParams;
  if (p === '/drops/file') {
    const d = drops().find((x) => `${DROPS_DIR}/${x.name}` === q.get('path'));
    const t = d && imageType(d.bytes);
    if (!d || !t) return fail(res, 404, 'not_found', 'no such drop');
    res.writeHead(200, { 'content-type': t.mime, 'cache-control': 'no-cache', ...CORS }).end(d.bytes);
    return;
  }
  if (p === '/whiteboard/_pin' && req.method === 'POST') {
    const floor = q.get('floor') ?? '';
    const b = boardOf(key, floor);
    const author = q.get('author') ?? 'Nibble';
    const el = goNote(b, author, q.get('note') ?? 'Look at this');
    commit(b, author, [...b.elements, el]);
    b.stalePins.push({ id: el.id as string, kind: 'note', author, note: el.text as string, version: b.version, at: Date.now() });
    announce(key, floor, b);
    return json(res, 200, { t: 'ack', data: { ...stateOf(floor, b), elements: [el.id] } });
  }
  if (p === '/whiteboard/_state') {
    const b = boardOf(key, q.get('floor') ?? '');
    return json(res, 200, { data: { ...stateOf(q.get('floor') ?? '', b), files: [...b.files.keys()], renderSha: b.render ? sha(b.render) : null, saves: b.saves, elements: b.elements, history: b.history.map((h) => h.version) } });
  }
  const m = /^\/whiteboard\/([^/]+)(?:\/(save|render\.png|files\/([^/]+)))?$/.exec(p);
  if (!m) return fail(res, 404, 'not_found', 'no such route');
  const floor = decodeURIComponent(m[1] as string);
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(floor) || floor.replace(/\./g, '') === '') return fail(res, 404, 'not_found', 'no such floor');
  const b = boardOf(key, floor);
  const what = m[2] ?? '';
  if (what === '' && req.method === 'GET') {
    const files = Object.fromEntries([...b.files].map(([id, f]) => [id, { mimeType: f.mimeType, size: f.bytes.length, created: f.created }]));
    return json(res, 200, {
      t: 'ack',
      data: { state: stateOf(floor, b), version: b.version, scene: { type: 'excalidraw', version: 2, source: 'herdr-3d', elements: b.elements, appState: b.appState }, files, excalidraw_version: '0.18.1', history: b.history.map(({ version, author, at }) => ({ version, author, at })) },
    });
  }
  if (what === 'render.png' && req.method === 'GET') {
    if (!b.render) return fail(res, 404, 'not_found', 'no render');
    if (q.get('v') && q.get('v') !== String(b.renderVersion)) return fail(res, 404, 'not_found', 'the render has changed since that version');
    res.writeHead(200, { 'content-type': 'image/png', 'x-render-version': String(b.renderVersion), 'cache-control': 'no-store', ...CORS }).end(b.render);
    return;
  }
  if (what.startsWith('files/')) {
    const id = decodeURIComponent(m[3] as string);
    if (req.method === 'GET') {
      const f = b.files.get(id);
      if (!f) return fail(res, 404, 'not_found', `file ${id}`);
      res.writeHead(200, { 'content-type': f.mimeType, ...CORS }).end(f.bytes);
      return;
    }
    if (req.method === 'PUT') {
      const body = await readBody(req, WB_MAX_FILE);
      if (!body) return fail(res, 413, 'whiteboard_too_large', 'an image is at most 8 MiB');
      if (!/^[0-9a-f]{64}$/.test(id)) return fail(res, 400, 'whiteboard_invalid', 'a file id is 64 lower-case hex digits');
      if (sha(body) !== id) return fail(res, 422, 'whiteboard_hash_mismatch', 'the file id is not the sha256 of its bytes');
      const t = imageType(body);
      if (!t) return fail(res, 415, 'whiteboard_unsupported', 'only PNG, JPEG, GIF and WebP images are stored');
      const stored = !b.files.has(id);
      if (stored) b.files.set(id, { bytes: body, mimeType: t.mime, created: Date.now() });
      return json(res, 200, { t: 'ack', data: { id, mime: t.mime, size: body.length, stored } });
    }
  }
  if (what === 'save' && req.method === 'POST') {
    const base = Number(q.get('base'));
    const body = await readBody(req, WB_MAX_SCENE * 2);
    if (!body) return fail(res, 413, 'whiteboard_too_large', 'the save is too large');
    if (!Number.isInteger(base) || base < 0) return fail(res, 400, 'bad_request', 'base is the version the save is based on');
    if (base !== b.version) return fail(res, 409, 'whiteboard_conflict', `the whiteboard is at version ${b.version}: merge it and save again`, { version: b.version });
    const form = await new Response(new Uint8Array(body), { headers: { 'content-type': req.headers['content-type'] ?? '' } }).formData().catch(() => null);
    const scenePart = form?.get('scene');
    const renderPart = form?.get('render');
    if (!form || !(scenePart instanceof Blob) || !(renderPart instanceof Blob)) return fail(res, 400, 'whiteboard_invalid', 'a save needs a scene and a render part');
    let scene: { elements?: unknown; appState?: unknown };
    try {
      scene = JSON.parse(await scenePart.text()) as typeof scene;
    } catch {
      return fail(res, 400, 'whiteboard_invalid', 'the scene is not JSON');
    }
    if (!Array.isArray(scene.elements)) return fail(res, 400, 'whiteboard_invalid', 'the scene has no elements');
    const elements = scene.elements as Msg[];
    for (const e of elements) {
      if (e.type === 'image' && !e.isDeleted && typeof e.fileId === 'string' && !b.files.has(e.fileId)) return fail(res, 422, 'whiteboard_missing_file', `${e.fileId} (upload it first)`);
    }
    const render = Buffer.from(await renderPart.arrayBuffer());
    if (imageType(render)?.mime !== 'image/png') return fail(res, 415, 'whiteboard_unsupported', 'the render must be a PNG');
    const w = render.readUInt32BE(16);
    const h = render.readUInt32BE(20);
    if (w > 2400 || h > 2400) return fail(res, 413, 'whiteboard_too_large', `render.png is ${w} x ${h} px, at most 2400 a side`);
    const app = (scene.appState ?? {}) as Msg;
    b.appState = { viewBackgroundColor: app.viewBackgroundColor ?? '#ffffff', gridSize: app.gridSize ?? 20, gridStep: app.gridStep ?? 5, gridModeEnabled: app.gridModeEnabled === true };
    commit(b, q.get('author') ?? '', elements);
    b.render = render;
    b.renderVersion = b.version;
    b.stalePins = [];
    b.saves++;
    announce(key, floor, b);
    return json(res, 200, { t: 'ack', data: stateOf(floor, b) });
  }
  fail(res, 405, 'not_found', 'method not allowed');
}
