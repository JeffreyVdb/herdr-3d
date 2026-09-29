/**
 * Which build each side of the game is: this bundle, the Mac helper that
 * serves it, and the bridge behind the tunnel. They ship in one release, so
 * any difference between them is a stale install; the badge says so.
 */

declare const __H3D_VERSION__: string | undefined;

/** Set at build time from `H3D_VERSION` (the Makefile passes `git describe`); "dev" when unstamped. */
export const GAME_VERSION: string = typeof __H3D_VERSION__ === 'string' ? __H3D_VERSION__ : 'dev';

/** The version in a bridge banner "herdr-world v0.2.0"; null for anything else (the fixture server has its own banner). */
export function bannerVersion(banner: string | undefined): string | null {
  return /^herdr-world\s+(\S+)\s*$/.exec(banner ?? '')?.[1] ?? null;
}

export interface Versions {
  game: string;
  helper: string | null;
  bridge: string | null;
}

export interface Summary {
  text: string;
  /** Two or more known sides disagree. */
  mismatch: boolean;
}

export function summarize(v: Versions): Summary {
  const known = [v.game, v.helper, v.bridge].filter((x): x is string => x !== null && x !== 'unknown');
  const mismatch = new Set(known).size > 1;
  const parts = [`game ${v.game}`];
  if (v.helper) parts.push(`helper ${v.helper}`);
  if (v.bridge) parts.push(`bridge ${v.bridge}`);
  if (mismatch) parts.push('versions differ');
  return { text: parts.join(' · '), mismatch };
}

/** The helper's own version from its `/healthz`; null when the page is not served by a helper (dev, fixtures) or it is too old to say. */
export async function loadHelperVersion(fetchFn: typeof fetch = fetch): Promise<string | null> {
  try {
    const r = await fetchFn('/healthz', { cache: 'no-store' });
    const body: unknown = await r.json();
    const v = (body as { version?: unknown } | null)?.version;
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}

/** The small line above the debug overlay. Empty (and hidden by CSS) until it has something to say. */
export class VersionBadge {
  private helper: string | null = null;
  private bridge: string | null = null;

  constructor(
    private readonly el: HTMLElement | null,
    private readonly game: string = GAME_VERSION,
  ) {
    this.render();
  }

  setHelper(v: string | null): void {
    this.helper = v;
    this.render();
  }

  setBridge(v: string | null): void {
    this.bridge = v;
    this.render();
  }

  private render(): void {
    if (!this.el) return;
    const s = summarize({ game: this.game, helper: this.helper, bridge: this.bridge });
    this.el.textContent = s.text;
    this.el.classList.toggle('warn', s.mismatch);
  }
}
