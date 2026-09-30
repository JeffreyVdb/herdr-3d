/**
 * #51 / M11 image uploads over HTTP (not the WebSocket), the same door as the M3d logos (`logo.ts`): the URL
 * derives from the bridge WebSocket URL and keeps its query (the token, a fixture server's parameters), so an upload
 * goes through the helper's Host/Origin/token guards to the bridge, which hands the bytes to Drop Zone.
 *
 * `POST /upload?label=<hint>&n=<int>` with the raw image bytes as the body (`Content-Type` is only a hint). The
 * answer is `{"data":{"path","mime","size"}}`, the absolute path exactly as Drop Zone returned it, or a
 * `{"t":"error","code","message"}` with a non-2xx status. The bridge stays the authority on what it accepts (it decides
 * the type from the sniffed bytes); the pre-check only gives a friendly message before a 25 MiB upload.
 */

import type { CommandResult } from './client';

/** The bridge's cap per image (`upload.MaxBytes`), enforced there on the actual bytes. */
export const UPLOAD_MAX_BYTES = 25 << 20;
export const UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
const UPLOAD_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const;
/** The `accept` of a file input. */
export const UPLOAD_ACCEPT = UPLOAD_TYPES.join(',');
/** How long one upload may take before the client gives up (the bridge answers 504 itself before this). */
export const UPLOAD_TIMEOUT_MS = 120_000;

/** What the bridge answers for a stored image. */
export interface UploadedImage {
  path: string;
  mime: string;
  size: number;
}

/**
 * `/upload` beside the WebSocket URL, keeping its query:
 * `ws://h/ws?token=t` → `http://h/upload?token=t&label=nibble&n=2`.
 */
export function uploadUrl(wsUrl: string, o: { label?: string; n?: number } = {}): string {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = '/upload';
  u.searchParams.delete('label');
  u.searchParams.delete('n');
  if (o.label) u.searchParams.set('label', o.label);
  if (o.n !== undefined && Number.isInteger(o.n) && o.n > 0) u.searchParams.set('n', String(o.n));
  u.hash = '';
  return u.toString();
}

export interface PickedFile {
  name: string;
  size: number;
  type: string;
}

const name = (f: PickedFile) => f.name || 'That file';

/** `1.5 MB` style size in the units the cap is stated in. */
const mb = (n: number) => `${(n / (1 << 20)).toFixed(1)} MB`;

/**
 * What is wrong with a file before it is sent, in words for the composer; null when it may go. The type is the
 * browser's guess (a pasted screenshot has one; a file dropped from a file manager may have none, then the extension
 * decides); the bridge decides from the bytes.
 */
export function precheckUpload(f: PickedFile): string | null {
  if (f.size === 0) return `${name(f)} is empty.`;
  if (f.size > UPLOAD_MAX_BYTES) return `${name(f)} is ${mb(f.size)}. Images can be up to ${UPLOAD_MAX_BYTES >> 20} MB: export it smaller.`;
  const ext = /\.([a-z0-9]+)$/i.exec(f.name)?.[1]?.toLowerCase() ?? '';
  const typeOk = (UPLOAD_TYPES as readonly string[]).includes(f.type);
  // A type that is present and not an allowed one wins over an extension that says otherwise.
  const extOk = f.type === '' && (UPLOAD_EXTENSIONS as readonly string[]).includes(ext);
  if (!typeOk && !extOk) return `${name(f)} is not a PNG, JPEG, GIF or WebP image.`;
  return null;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

const isImage = (d: unknown): d is UploadedImage => {
  if (typeof d !== 'object' || d === null) return false;
  const o = d as Record<string, unknown>;
  return typeof o.path === 'string' && typeof o.mime === 'string' && typeof o.size === 'number';
};

/** The bridge's answer to an `/upload` request as a command result whose data is an `UploadedImage`. */
async function result(fetcher: Fetcher, url: string, init: RequestInit, outer: AbortSignal | undefined, timeout: AbortSignal): Promise<CommandResult> {
  let res: Awaited<ReturnType<Fetcher>>;
  try {
    res = await fetcher(url, init);
  } catch {
    if (outer?.aborted) return { ok: false, code: 'aborted', message: 'the upload was cancelled' };
    if (timeout.aborted) return { ok: false, code: 'upload_timeout', message: 'the upload took too long' };
    return { ok: false, code: 'offline', message: 'could not reach herdr-world' };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Not JSON: a proxy error page.
  }
  const o = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  if (res.ok) {
    if (isImage(o.data)) return { ok: true, data: { path: o.data.path, mime: o.data.mime, size: o.data.size } satisfies UploadedImage };
    return { ok: false, code: 'dropzone_bad_response', message: 'the upload answered with something that is not an image path' };
  }
  const code = typeof o.code === 'string' ? o.code : res.status === 502 ? 'offline' : res.status === 403 ? 'forbidden' : 'internal';
  const message = typeof o.message === 'string' ? o.message : `HTTP ${res.status}`;
  return { ok: false, code, message };
}

/**
 * Sends one image. `label` and `n` are hints for the stored file's name (`h3d-<label>-<n>`: the bridge cleans the
 * label and numbers nothing itself). `signal` cancels it: the result is then `aborted`, never a partial success.
 */
export function postUpload(
  wsUrl: string,
  file: Blob,
  o: { label?: string; n?: number } = {},
  signal?: AbortSignal,
  fetcher: Fetcher = (u, i) => fetch(u, i),
  timeoutMs = UPLOAD_TIMEOUT_MS,
): Promise<CommandResult> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const both = signal ? AbortSignal.any([signal, timeout]) : timeout;
  return result(
    fetcher,
    uploadUrl(wsUrl, o),
    { method: 'POST', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' }, signal: both },
    signal,
    timeout,
  );
}
