/**
 * Where the game's WebSocket goes, and the helper token it carries.
 *
 * The Mac helper opens `http://127.0.0.1:7777/#token=<token>`. The game moves
 * the token into localStorage (`h3d.token`; the installed app reuses it and
 * the helper keeps its token across restarts), strips it from the URL, and
 * sends it as `?token=` on the same-origin `/ws`. `?ws=<url>` overrides the
 * endpoint for fixture servers and dev proxies.
 */

export const TOKEN_KEY = 'h3d.token';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface LocationLike {
  protocol: string;
  host: string;
  pathname: string;
  search: string;
  hash: string;
}

/**
 * Reads the token from `#token=` (then remembers it and removes it from the
 * address bar via `replaceUrl`), else from storage.
 */
export function takeToken(
  loc: LocationLike,
  storage: StorageLike | null,
  replaceUrl: (url: string) => void,
): string | null {
  const hash = new URLSearchParams(loc.hash.replace(/^#/, ''));
  const fromHash = hash.get('token');
  if (fromHash) {
    try {
      storage?.setItem(TOKEN_KEY, fromHash);
    } catch {
      // Storage can be unavailable (private mode); the token still works for this load.
    }
    hash.delete('token');
    const rest = hash.toString();
    replaceUrl(loc.pathname + loc.search + (rest ? `#${rest}` : ''));
    return fromHash;
  }
  try {
    return storage?.getItem(TOKEN_KEY) ?? null;
  } catch {
    return null;
  }
}

/**
 * The bridge WebSocket URL: `?ws=` override (absolute or path), else same-origin `/ws`. #57: a page the helper serves
 * names the bridge its per-bridge keys belong to (`bridge`, `none` for a helper that had none), and the helper connects
 * it to that bridge only: after a switch made in another tab it is refused until it reloads.
 */
export function bridgeUrl(loc: LocationLike, token: string | null, bridge: string | null = null): string {
  const wsScheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const override = new URLSearchParams(loc.search).get('ws');
  let url: URL;
  if (override) {
    url = new URL(override, `${loc.protocol}//${loc.host}${loc.pathname}`);
    if (url.protocol === 'http:') url.protocol = 'ws:';
    if (url.protocol === 'https:') url.protocol = 'wss:';
  } else {
    url = new URL(`${wsScheme}//${loc.host}/ws`);
  }
  if (token && !url.searchParams.has('token')) url.searchParams.set('token', token);
  if (token && bridge) url.searchParams.set('bridge', bridge);
  return url.toString();
}
