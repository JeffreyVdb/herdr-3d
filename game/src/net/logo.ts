/**
 * M3d building logos over HTTP (not the WebSocket): the URL a logo is fetched
 * from, the client-side pre-check of a chosen file, and the upload / clear
 * requests. The URLs derive from the bridge WebSocket URL, so a logo goes
 * through the same door (and the same token) as `/ws`: the helper's origin,
 * or `?ws=` for fixture servers. The bridge stays the authority on what it
 * accepts; the pre-check only gives a friendly message before a 1 MiB upload.
 */

import { routeRefusal } from './bridgeChanged';
import type { CommandResult } from './client';

/** The bridge's upload cap (`logo.MaxInput`). */
export const LOGO_MAX_BYTES = 1 << 20;
export const LOGO_TYPES = ['image/png', 'image/webp', 'image/svg+xml'] as const;
/** The `accept` of the file input. */
export const LOGO_ACCEPT = LOGO_TYPES.join(',');

/**
 * `/logo/{id}` beside the WebSocket URL, keeping its query (the token, and for
 * a fixture server the parameters that say which simulated world it is):
 * `ws://h/ws?token=t` → `http://h/logo/b_1?token=t&h=<hash>`.
 */
export function logoUrl(wsUrl: string, building: string, hash?: string | null): string {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = `/logo/${encodeURIComponent(building)}`;
  u.searchParams.delete('h');
  if (hash) u.searchParams.set('h', hash);
  u.hash = '';
  return u.toString();
}

export interface PickedFile {
  name: string;
  size: number;
  type: string;
}

/**
 * What is wrong with a file before it is sent, in words for the panel; null
 * when it may go. The type is the browser's guess from the name (an SVG or
 * WebP may come with none): the bridge decides from the bytes.
 */
export function precheckLogo(f: PickedFile): string | null {
  if (f.size === 0) return `${f.name || 'That file'} is empty. Pick a PNG, WebP or SVG image.`;
  if (f.size > LOGO_MAX_BYTES) return `${f.name || 'That file'} is ${(f.size / (1 << 20)).toFixed(1)} MB. Logos can be up to 1 MB: export it smaller, or as an SVG.`;
  const ext = /\.([a-z0-9]+)$/i.exec(f.name)?.[1]?.toLowerCase() ?? '';
  const typeOk = (LOGO_TYPES as readonly string[]).includes(f.type);
  const extOk = ['png', 'webp', 'svg'].includes(ext);
  if (!typeOk && !extOk) return `${f.name || 'That file'} is not a PNG, WebP or SVG image.`;
  return null;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

/** The bridge's answer to a `/logo` request as a command result. */
async function result(fetcher: Fetcher, url: string, init: RequestInit): Promise<CommandResult> {
  let res: Awaited<ReturnType<Fetcher>>;
  try {
    res = await fetcher(url, init);
  } catch {
    return { ok: false, code: 'offline', message: 'could not reach herdr-world' };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Not JSON: a proxy error page.
  }
  const o = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  if (res.ok) return { ok: true, data: o.data ?? null };
  const { code, message } = routeRefusal(
    typeof o.code === 'string' ? o.code : res.status === 502 ? 'offline' : res.status === 403 ? 'forbidden' : 'internal',
    typeof o.message === 'string' ? o.message : `HTTP ${res.status}`,
  );
  return { ok: false, code, message };
}

/** Sends a logo file for a building. */
export function putLogo(wsUrl: string, building: string, file: Blob, fetcher: Fetcher = (u, i) => fetch(u, i)): Promise<CommandResult> {
  return result(fetcher, logoUrl(wsUrl, building), { method: 'PUT', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
}

/** Removes a building's logo. */
export function deleteLogo(wsUrl: string, building: string, fetcher: Fetcher = (u, i) => fetch(u, i)): Promise<CommandResult> {
  return result(fetcher, logoUrl(wsUrl, building), { method: 'DELETE' });
}
