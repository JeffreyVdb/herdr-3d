/**
 * M13 screen share: the JPEG a frame request is answered with goes over HTTP (a WebSocket message is capped at
 * 256 KiB), the same door as `/upload` (`upload.ts`): `POST /screen/frame/<req_id>` beside the WebSocket URL, keeping
 * its query (the token), through the helper's Host/Origin/token guards to the bridge. The answer is
 * `{"data":{"bytes","w","h"}}`, or `{"t":"error","code","message"}` with a non-2xx status (the bridge has then failed
 * the grab with the same code). docs/protocol.md "Screen share".
 */

import type { CommandResult } from './client';
import type { Fetcher } from './upload';

/** How long one frame upload may take: the bridge gives the whole grab 5 s. */
export const FRAME_POST_TIMEOUT_MS = 5_000;

/** `ws://h/ws?token=t` → `http://h/screen/frame/<id>?token=t`. */
export function frameUrl(wsUrl: string, reqId: string): string {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = `/screen/frame/${encodeURIComponent(reqId)}`;
  u.hash = '';
  return u.toString();
}

/** Sends one frame; never rejects. */
export async function postFrame(wsUrl: string, reqId: string, jpeg: Blob, fetcher: Fetcher = (u, i) => fetch(u, i), timeoutMs = FRAME_POST_TIMEOUT_MS): Promise<CommandResult> {
  const timeout = AbortSignal.timeout(timeoutMs);
  let res: Awaited<ReturnType<Fetcher>>;
  try {
    res = await fetcher(frameUrl(wsUrl, reqId), { method: 'POST', body: jpeg, headers: { 'Content-Type': 'image/jpeg' }, signal: timeout });
  } catch {
    if (timeout.aborted) return { ok: false, code: 'frame_timeout', message: 'the frame took too long to send' };
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
  const code = typeof o.code === 'string' ? o.code : res.status === 502 ? 'offline' : 'internal';
  return { ok: false, code, message: typeof o.message === 'string' ? o.message : `HTTP ${res.status}` };
}
