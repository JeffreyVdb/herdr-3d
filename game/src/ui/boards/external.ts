/**
 * M7: opens a provider's page (an issue, a pull request) in the user's browser. Served by the Mac helper, the game
 * asks it to (`POST /api/open`, same origin, its token in `X-H3D-Token`): the helper opens https URLs of the providers
 * it knows in the default browser, not in this app window. Served by anything else (Vite on the server, a fixture
 * page) there is no such endpoint, and the game opens a new window itself.
 */

export type OpenVia = 'helper' | 'window' | 'refused';

export interface OpenDeps {
  token: string | null;
  fetch?: (url: string, init: RequestInit) => Promise<{ status: number }>;
  open?: (url: string) => void;
}

/** Only absolute http(s) URLs are ever opened. */
export function openable(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export async function openExternal(url: string, d: OpenDeps): Promise<OpenVia> {
  if (!openable(url)) return 'refused';
  const doFetch = d.fetch ?? ((u, init) => fetch(u, init));
  if (url.startsWith('https://')) {
    try {
      const r = await doFetch('/api/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(d.token ? { 'x-h3d-token': d.token } : {}) },
        body: JSON.stringify({ url }),
      });
      if (r.status === 204) return 'helper';
    } catch {
      // No helper behind this page: the window below.
    }
  }
  (d.open ?? ((u) => void window.open(u, '_blank', 'noopener,noreferrer')))(url);
  return 'window';
}
