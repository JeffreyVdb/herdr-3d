/**
 * M13 whiteboard over HTTP (#15): the board's bytes go beside the WebSocket, through the same door as the logos and
 * `/upload` (the helper's Host/Origin/token guards), because a WebSocket message is capped at 256 KiB and a scene
 * with its render is not. The URLs derive from the bridge WebSocket URL and keep its query (the token; a fixture
 * server's parameters). docs/protocol.md "Whiteboard".
 *
 * - `GET  /whiteboard/{floor}`                 the board: state, scene (elements incl. tombstones, appState), files
 * - `PUT  /whiteboard/{floor}/files/{sha256}`  one image file, before a save that uses it (the id is its bytes' hash)
 * - `GET  /whiteboard/{floor}/files/{sha256}`  its bytes
 * - `POST /whiteboard/{floor}/save?base=N`     multipart: `scene` (JSON) + `render` (PNG); 409 when N is not current
 * - `GET  /whiteboard/{floor}/render.png?v=N`  the render of version N
 * - `GET  /drops/file?path=…[&thumb=1]`        a recent drop's bytes (M11's picker)
 */

import { routeRefusal } from './bridgeChanged';
import type { CommandResult } from './client';
import type { WhiteboardState } from './protocol';

/** The bridge's caps (internal/whiteboard): the client checks before it sends. */
export const WB_MAX_FILE = 8 << 20;
export const WB_MAX_SCENE = 16 << 20;
export const WB_RENDER_MAX_SIDE = 2400;
/** The image types the bridge stores; anything else is converted to PNG first. */
export const WB_FILE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/** Bridge URL for `path` beside the WebSocket URL, keeping its query: `ws://h/ws?token=t` → `http://h/whiteboard/f?token=t`. */
export function bridgeHttpUrl(wsUrl: string, path: string, params: Record<string, string | number | undefined> = {}): string {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = path;
  for (const [k, v] of Object.entries(params)) {
    u.searchParams.delete(k);
    if (v !== undefined && v !== '') u.searchParams.set(k, String(v));
  }
  u.hash = '';
  return u.toString();
}

const board = (floor: string) => `/whiteboard/${encodeURIComponent(floor)}`;

export const boardUrl = (wsUrl: string, floor: string) => bridgeHttpUrl(wsUrl, board(floor));
export const fileUrl = (wsUrl: string, floor: string, id: string) => bridgeHttpUrl(wsUrl, `${board(floor)}/files/${encodeURIComponent(id)}`);
export const renderUrl = (wsUrl: string, floor: string, version: number) => bridgeHttpUrl(wsUrl, `${board(floor)}/render.png`, { v: version });
export const dropUrl = (wsUrl: string, path: string, thumb = false) => bridgeHttpUrl(wsUrl, '/drops/file', { path, thumb: thumb ? 1 : undefined });

/** A file the board uses, as the bridge describes it. */
export interface FileMeta {
  mimeType: string;
  size: number;
  created: number;
}

/** `GET /whiteboard/{floor}`. */
export interface BoardData {
  state: WhiteboardState;
  version: number;
  scene: { type: 'excalidraw'; version: number; elements: unknown[]; appState: Record<string, unknown> };
  files: Record<string, FileMeta>;
  history: Array<{ version: number; author: string; at: number }>;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;
const defaultFetch: Fetcher = (u, i) => fetch(u, i);

/** The answer of a whiteboard route as a command result; a 409 carries the board's current version. */
async function result(fetcher: Fetcher, url: string, init: RequestInit = {}): Promise<CommandResult & { version?: number }> {
  let res: Awaited<ReturnType<Fetcher>>;
  try {
    res = await fetcher(url, { cache: 'no-store', ...init });
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
  return { ok: false, code, message, ...(typeof o.version === 'number' ? { version: o.version } : {}) };
}

export const isBoard = (d: unknown): d is BoardData => {
  const o = d as BoardData | null;
  return !!o && typeof o.version === 'number' && !!o.scene && Array.isArray(o.scene.elements) && typeof o.files === 'object' && !!o.state;
};

export async function getBoard(wsUrl: string, floor: string, fetcher = defaultFetch): Promise<CommandResult> {
  const r = await result(fetcher, boardUrl(wsUrl, floor));
  if (r.ok && !isBoard(r.data)) return { ok: false, code: 'internal', message: 'the bridge answered something that is not a board' };
  return r;
}

export function putFile(wsUrl: string, floor: string, id: string, bytes: Blob, fetcher = defaultFetch): Promise<CommandResult> {
  return result(fetcher, fileUrl(wsUrl, floor, id), { method: 'PUT', body: bytes, headers: { 'Content-Type': bytes.type || 'application/octet-stream' } });
}

/** `POST …/save`: the result carries `version` (the current one) on a `whiteboard_conflict`. */
export function saveBoard(
  wsUrl: string,
  floor: string,
  o: { base: number; author: string; scene: { elements: readonly unknown[]; appState: Record<string, unknown> }; render: Blob },
  fetcher = defaultFetch,
): Promise<CommandResult & { version?: number }> {
  const form = new FormData();
  form.append('scene', new Blob([JSON.stringify(o.scene)], { type: 'application/json' }), 'scene.json');
  form.append('render', o.render, 'render.png');
  const url = bridgeHttpUrl(wsUrl, `${board(floor)}/save`, { base: o.base, author: o.author });
  return result(fetcher, url, { method: 'POST', body: form });
}

/** SHA-256 of bytes, lower-case hex: an image file's id on the board. */
export async function sha256Hex(b: ArrayBuffer | Uint8Array): Promise<string> {
  const view = b instanceof Uint8Array ? b : new Uint8Array(b);
  const digest = await crypto.subtle.digest('SHA-256', view as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join('');
}
