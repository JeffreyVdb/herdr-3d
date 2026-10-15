/**
 * #57: browser state that belongs to one bridge's world. Drafts, the seat's tab per worker, the overview's collapsed
 * orchestrators and the hire dialog's model and level choices name floors, workers and models of whichever bridge was in
 * use; after a switch they would leak into another bridge's world. Each is kept under the bridge in use's id instead:
 * `h3d.draft.…` becomes `h3d.b.<id>.draft.…`. Client preferences (sound, theme, zoom, time, limits, notifications, the
 * hire defaults) stay shared, and so does the helper's token.
 *
 * The scope is set once at start, before anything reads these keys (main.ts, from the helper's list). A page no helper
 * serves (Vite, the e2e preview, fixtures) has none: the keys are read as they always were. The first time a helper
 * names a bridge, the keys kept before #57 move into the first bridge's namespace (the one an install from before came
 * up with), once.
 */

/** Exact per-bridge keys. */
const KEYS = ['h3d.seat.terminal', 'h3d.seat.images', 'h3d.overview.collapsed', 'h3d.hire.hiddenModels', 'h3d.hire.taskLevels'] as const;
/** Per-bridge key families (one key per draft). */
const PREFIXES = ['h3d.draft.', 'h3d.wb.draft.'] as const;

/** Set once the pre-#57 keys have moved (to the id it holds); shared. */
export const MIGRATED_KEY = 'h3d.bridges.migrated';

let scope: string | null = null;

/** The bridge in use's id, or null (no helper: keys stay as they were). */
export function setBridgeScope(id: string | null): void {
  scope = id && /^[0-9a-z]+$/.test(id) ? id : null;
}

export function bridgeScope(): string | null {
  return scope;
}

/** `base` (an `h3d.` key or key prefix) under the bridge `id` (default: the one in use). */
export function bridgeKey(base: string, id: string | null = scope): string {
  return id && base.startsWith('h3d.') ? `h3d.b.${id}.${base.slice(4)}` : base;
}

/** Is `key` one of the per-bridge keys as kept before #57 (unscoped)? */
export function isBridgeKey(key: string): boolean {
  return (KEYS as readonly string[]).includes(key) || PREFIXES.some((p) => key.startsWith(p));
}

type MigrateStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key'> & { readonly length: number };

/**
 * Moves the unscoped per-bridge keys into bridge `id`'s namespace, once per browser (a key already there is kept and
 * the old one dropped). Returns how many moved. Blocked or full storage leaves what it could not move where it was.
 */
export function migrateBridgeKeys(storage: MigrateStorage | null, id: string): number {
  if (!storage) return 0;
  try {
    if (storage.getItem(MIGRATED_KEY)) return 0;
    const old: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && isBridgeKey(k)) old.push(k);
    }
    let moved = 0;
    for (const k of old) {
      const v = storage.getItem(k);
      const to = bridgeKey(k, id);
      if (v !== null && storage.getItem(to) === null) storage.setItem(to, v);
      storage.removeItem(k);
      moved++;
    }
    storage.setItem(MIGRATED_KEY, id);
    return moved;
  } catch {
    return 0;
  }
}
