// M3d building logos for the fixture server: what the bridge's /logo/{id}
// routes do, in memory. PUT stores the bytes (no image conversion here: the
// fixture serves what it was given, so tests upload PNGs), hashes them
// (sha256, hex), and the simulated world announces the change with a
// `building.upsert`; DELETE clears; GET serves them.
//
// A request finds its world by `simlogo=<key>`, a query parameter of the
// `?ws=` URL that the game keeps on the logo URL (`logoUrl`). Worlds register
// under their key when the WebSocket has `simlogo=<key>`, so specs running in
// parallel do not share logos. `simfail=logo_missing` makes GET answer 404 for
// logos the world still announces (the game must show the name), and
// `simfail=logo_busy` makes the next PUT fail with 503 `logo_busy`.
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SimWorld } from './fixture-sim.ts';

export const LOGO_MAX = 1 << 20;

const worlds = new Map<string, SimWorld>();

export function registerLogoWorld(key: string, w: SimWorld): () => void {
  worlds.set(key, w);
  return () => {
    if (worlds.get(key) === w) worlds.delete(key);
  };
}

export interface StoredLogo {
  bytes: Buffer;
  hash: string;
  type: string;
}

/** The type of an upload from its bytes, or null (PNG, WebP, or an <svg> document). */
export function logoType(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'))) return 'image/png';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/.test(b.toString('utf8', 0, 512))) return 'image/svg+xml';
  return null;
}

export const hashOf = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS }).end(`${JSON.stringify(body)}\n`);
}

const fail = (res: ServerResponse, status: number, code: string, message: string) => json(res, status, { t: 'error', code, message });

/**
 * Serves `/logo/<id>` (GET, HEAD, PUT, DELETE). Returns false for any other
 * path, so it can sit in front of another handler.
 */
export function logoRoute(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? '/', 'http://fixture');
  const m = /^\/logo\/([^/]+)$/.exec(url.pathname);
  if (!m) return false;
  const id = decodeURIComponent(m[1] as string);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS).end();
    return true;
  }
  const world = worlds.get(url.searchParams.get('simlogo') ?? '');
  if (!world) {
    fail(res, 404, 'not_found', 'no simulated world for this logo request (simlogo=<key>)');
    return true;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    const l = world.logoOf(id);
    if (!l || world.failure() === 'logo_missing') return fail(res, 404, 'not_found', `no logo for building "${id}"`), true;
    const want = url.searchParams.get('h');
    // Like the bridge: a hash that is not the current one gets no image (the caller would cache it under the old hash).
    if (want && want !== l.hash) return fail(res, 404, 'not_found', 'the logo has changed since that hash'), true;
    const cache = want === l.hash ? 'public, max-age=31536000, immutable' : 'no-cache';
    res.writeHead(200, { 'content-type': l.type, 'content-length': l.bytes.length, 'cache-control': cache, etag: `"${l.hash}"`, ...CORS });
    res.end(req.method === 'HEAD' ? undefined : l.bytes);
    return true;
  }
  if (req.method === 'DELETE') {
    try {
      world.clearLogo(id);
      json(res, 200, { t: 'ack', data: { id } });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      fail(res, err.code === 'not_found' ? 404 : 500, err.code ?? 'internal', err.message ?? 'failed');
    }
    return true;
  }
  if (req.method === 'PUT') {
    const chunks: Buffer[] = [];
    let n = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > LOGO_MAX) over = true;
      else chunks.push(c);
    });
    req.on('end', () => {
      if (over) return fail(res, 413, 'logo_too_large', `the file is over ${LOGO_MAX} bytes`);
      const bytes = Buffer.concat(chunks);
      if (world.takeFailure('logo_busy')) return fail(res, 503, 'logo_busy', 'other logos are being converted');
      if (bytes.length === 0) return fail(res, 422, 'logo_invalid', 'empty upload');
      const type = logoType(bytes);
      if (!type) return fail(res, 415, 'logo_unsupported', 'not a PNG, WebP or SVG image');
      try {
        const stored = world.setLogo(id, { bytes, hash: hashOf(bytes), type });
        json(res, 200, { t: 'ack', data: { id, logo: stored.hash, bytes: bytes.length } });
      } catch (e) {
        const err = e as { code?: string; message?: string };
        fail(res, err.code === 'not_found' ? 404 : 500, err.code ?? 'internal', err.message ?? 'failed');
      }
    });
    return true;
  }
  res.writeHead(405, { allow: 'GET, HEAD, PUT, DELETE', ...CORS }).end();
  return true;
}
