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

/** What this session knows about its own build, for the About dialog: the versions as they arrive, and the renderer backend. */
export class BuildInfo {
  helper: string | null = null;
  bridge: string | null = null;
  /** #57: the name of the helper's bridge in use (null: none, or no helper). */
  bridgeName: string | null = null;
  backend: string | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(readonly game: string = GAME_VERSION) {}

  setHelper(v: string | null): void {
    this.helper = v;
    this.emit();
  }

  setBridge(v: string | null): void {
    this.bridge = v;
    this.emit();
  }

  setBridgeName(v: string | null): void {
    if (v === this.bridgeName) return;
    this.bridgeName = v;
    this.emit();
  }

  setBackend(v: string | null): void {
    this.backend = v;
    this.emit();
  }

  summary(): Summary {
    return summarize({ game: this.game, helper: this.helper, bridge: this.bridge });
  }

  /** Calls `fn` on every change; returns the unsubscribe. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
