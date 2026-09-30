// #51 image uploads for the fixture server: what the bridge's `POST /upload` does, without Drop Zone. The body is the
// raw image; the type is decided from its bytes (PNG, JPEG, GIF, WebP), the cap is 25 MiB on the bytes actually read,
// and the answer is `{"data":{"path","mime","size"}}` with a deterministic absolute path
// (`/home/fixture/drops/2026-09/h3d-<label>-<n>.<ext>`), or `{"t":"error","code","message"}` with the contract's
// codes (upload_too_large 413, upload_unsupported 415, bad_request 400, dropzone_unavailable 502).
//
// A test forces failures with the query of the `?ws=` URL, which the game keeps on the upload URL (`uploadUrl`):
// `fail_upload=<N>` fails the first N uploads (`all`: every one) with `dropzone_unavailable`, counted per
// `upload_key=<key>` so specs running in parallel do not share the count. `GET /upload/_log?upload_key=<key>` lists
// what the fixture received (label, n, size, mime, result; never bytes), for a spec to check that a retry did not
// send an image that was already stored. #64: `fail_code=upload_busy` makes those failures the bridge's `429
// upload_busy` instead (the fourth upload at once), and `upload_delay=<ms>` holds every answer back that long (a
// pending upload a spec can look at).
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import type { IncomingMessage, ServerResponse } from 'node:http';

/** The bridge's cap (`upload.MaxBytes`) and the client's `UPLOAD_MAX_BYTES`. */
export const UPLOAD_MAX = 25 << 20;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS }).end(`${JSON.stringify(body)}\n`);
}
const fail = (res: ServerResponse, status: number, code: string, message: string) => json(res, status, { t: 'error', code, message });

/** The image type of a body from its first bytes, with the extension of its file name; null if it is none of the four. */
export function imageType(b: Buffer): { mime: string; ext: string } | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'))) return { mime: 'image/png', ext: 'png' };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b.length >= 6 && (b.toString('latin1', 0, 6) === 'GIF87a' || b.toString('latin1', 0, 6) === 'GIF89a')) return { mime: 'image/gif', ext: 'gif' };
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

/** The label as the bridge cleans it: `[a-z0-9-]`, at most 24 characters, "hire" when nothing is left. */
export function cleanLabel(s: string | null): string {
  const c = (s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '');
  return c || 'hire';
}

export interface UploadLogEntry {
  label: string;
  n: number;
  size: number;
  mime: string | null;
  result: string;
}

const logs = new Map<string, UploadLogEntry[]>();
const counts = new Map<string, number>();

/** Forgets what a key received (tests). */
export function resetUploads(key = ''): void {
  logs.delete(key);
  counts.delete(key);
}

/**
 * Serves `POST /upload` and `GET /upload/_log`. Returns false for any other path, so it can sit in front of another
 * handler.
 */
export function uploadRoute(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? '/', 'http://fixture');
  const isLog = url.pathname === '/upload/_log';
  if (url.pathname !== '/upload' && !isLog) return false;
  const key = url.searchParams.get('upload_key') ?? '';
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS).end();
    return true;
  }
  if (isLog) {
    if (req.method !== 'GET') res.writeHead(405, { allow: 'GET', ...CORS }).end();
    else json(res, 200, { data: logs.get(key) ?? [] });
    return true;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST', ...CORS }).end();
    return true;
  }
  const label = cleanLabel(url.searchParams.get('label'));
  const nParam = url.searchParams.get('n');
  const n = nParam !== null && /^[1-9]\d{0,8}$/.test(nParam) ? Number(nParam) : 0;
  const record = (size: number, mime: string | null, result: string) => {
    const l = logs.get(key) ?? [];
    l.push({ label, n, size, mime, result });
    logs.set(key, l);
  };
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > UPLOAD_MAX) over = true;
    else chunks.push(c);
  });
  req.on('end', () => {
    if (over) {
      record(size, null, 'upload_too_large');
      return fail(res, 413, 'upload_too_large', `the image is over ${UPLOAD_MAX >> 20} MB`);
    }
    if (nParam !== null && n === 0) {
      record(size, null, 'bad_request');
      return fail(res, 400, 'bad_request', 'n must be a positive integer');
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length === 0) {
      record(0, null, 'bad_request');
      return fail(res, 400, 'bad_request', 'the upload is empty');
    }
    const type = imageType(bytes);
    if (!type) {
      record(bytes.length, null, 'upload_unsupported');
      return fail(res, 415, 'upload_unsupported', 'that is not a PNG, JPEG, GIF or WebP image');
    }
    const want = url.searchParams.get('fail_upload');
    const seen = counts.get(key) ?? 0;
    counts.set(key, seen + 1);
    const delay = Math.min(30_000, Math.max(0, Number(url.searchParams.get('upload_delay')) || 0));
    const answer = (): void => {
      if (want !== null && (want === 'all' || seen < Number(want))) {
        if (url.searchParams.get('fail_code') === 'upload_busy') {
          record(bytes.length, type.mime, 'upload_busy');
          return fail(res, 429, 'upload_busy', 'too many uploads at once: try again in a moment');
        }
        record(bytes.length, type.mime, 'dropzone_unavailable');
        return fail(res, 502, 'dropzone_unavailable', 'Drop Zone is not answering');
      }
      record(bytes.length, type.mime, 'ok');
      json(res, 200, { data: { path: `/home/fixture/drops/2026-09/h3d-${label}-${n || 1}.${type.ext}`, mime: type.mime, size: bytes.length } });
    };
    if (delay > 0) setTimeout(answer, delay);
    else answer();
  });
  return true;
}
