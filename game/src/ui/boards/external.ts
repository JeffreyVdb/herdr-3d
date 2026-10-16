/**
 * M7: opens a provider's page (an issue, a pull request) in the user's browser. Served by the helper (macOS or Linux), the game
 * asks it to (`POST /api/open`, same origin, its token in `X-H3D-Token`): the helper opens https URLs of the providers
 * it knows in the default browser, not in this app window. The helper opens the game with its token, so a page with
 * none (Vite on the server, a fixture page) is not served by it: there is no such endpoint to ask, and the game opens
 * a new window itself. A page the helper serves never falls back to a window: a URL the helper refuses (a host it does
 * not know, anything but https) is not opened at all.
 */

export type OpenVia = 'helper' | 'window' | 'refused';

export interface OpenDeps {
  token: string | null;
  fetch?: (url: string, init: RequestInit) => Promise<{ status: number }>;
  open?: (url: string) => void;
}

/** Only absolute https URLs are ever opened. */
export function openable(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

export async function openExternal(url: string, d: OpenDeps): Promise<OpenVia> {
  if (!openable(url)) return 'refused';
  if (d.token) {
    const doFetch = d.fetch ?? ((u, init) => fetch(u, init));
    try {
      const r = await doFetch('/api/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-h3d-token': d.token },
        body: JSON.stringify({ url }),
      });
      return r.status === 204 ? 'helper' : 'refused';
    } catch {
      return 'refused';
    }
  }
  (d.open ?? ((u) => void window.open(u, '_blank', 'noopener,noreferrer')))(url);
  return 'window';
}
