/**
 * M5: which laptops get a live screen. The nearest `n` laptops you can see
 * are watched (`terminal.watch` at a low fps); everything else shows its last
 * frame or its glow. Hysteresis keeps walking from churning watches: a live
 * screen stays live while it is in range and was seen within `graceMs`, a
 * nearer laptop only takes over from one that has been live `minHoldMs` and
 * is `swapMargin` farther (or out of view), and at most one swap happens per
 * plan. Pure logic.
 */

export interface ScreenConfig {
  /** Laptops with a live screen around you (0: none; sitting at one still watches it). */
  live: number;
  /** Frames per second a live screen asks for, and the one you sit at. */
  fps: number;
  seatedFps: number;
  /** A laptop starts live within `range` metres and stays live out to `keepRange`. */
  range: number;
  keepRange: number;
  /** A live laptop out of view stays live this long. */
  graceMs: number;
  /** A nearer laptop takes over only from a live one this much farther (metres). */
  swapMargin: number;
  /** A live laptop is not swapped out before this. */
  minHoldMs: number;
  /** After a refused or failed watch, that worker is not tried again for this long. */
  retryMs: number;
}

export const DEFAULT_SCREENS: ScreenConfig = {
  live: 4,
  fps: 4,
  seatedFps: 10,
  range: 9,
  keepRange: 12,
  graceMs: 2500,
  swapMargin: 1.5,
  minHoldMs: 3000,
  retryMs: 10_000,
};

/** Most live screens `screens=<n>` may ask for (the bridge's default per-connection cap is 6, one is for sitting). */
export const MAX_LIVE = 5;

/** `?screens=<n>`: how many laptops around you are live (0 turns ambient screens off). */
export function screensParam(v: string | null, def = DEFAULT_SCREENS.live): number {
  if (v === null || v.trim() === '') return def;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? Math.min(MAX_LIVE, n) : def;
}

/** A laptop the planner may watch: its worker, how far its screen is, whether it is in view. */
export interface Candidate {
  id: string;
  dist: number;
  visible: boolean;
}

export interface Plan {
  watch: string[];
  unwatch: string[];
}

interface Held {
  since: number;
  seen: number;
  dist: number;
}

export class WatchPlanner {
  private readonly held = new Map<string, Held>();
  private readonly retryAt = new Map<string, number>();

  constructor(readonly cfg: ScreenConfig = DEFAULT_SCREENS) {}

  /** Worker ids with a live screen, nearest first. */
  get live(): string[] {
    return [...this.held].sort((a, b) => a[1].dist - b[1].dist).map(([id]) => id);
  }

  has(id: string): boolean {
    return this.held.has(id);
  }

  /** The next set for `n` live screens; `cands` are the laptops of the floor you are on (with a pane, awake). */
  plan(now: number, cands: readonly Candidate[], n = this.cfg.live): Plan {
    const c = this.cfg;
    const byId = new Map(cands.map((x) => [x.id, x]));
    const unwatch: string[] = [];
    const drop = (id: string) => {
      this.held.delete(id);
      unwatch.push(id);
    };
    for (const [id, h] of this.held) {
      const x = byId.get(id);
      if (!x || x.dist > c.keepRange) {
        drop(id);
        continue;
      }
      h.dist = x.dist;
      if (x.visible) h.seen = now;
      else if (now - h.seen > c.graceMs) drop(id);
    }
    // Fewer allowed than held (n went down): the farthest go.
    for (const id of this.live.slice(Math.max(0, n)).reverse()) drop(id);
    const fresh = cands
      .filter((x) => x.visible && x.dist <= c.range && !this.held.has(x.id) && (this.retryAt.get(x.id) ?? -Infinity) <= now)
      .sort((a, b) => a.dist - b.dist || (a.id < b.id ? -1 : 1));
    const watch: string[] = [];
    let swapped = false;
    for (const x of fresh) {
      if (this.held.size < n) {
        this.held.set(x.id, { since: now, seen: now, dist: x.dist });
        watch.push(x.id);
        continue;
      }
      if (swapped || n <= 0) break;
      // Out of view (in its grace) goes first, else the farthest, if this one is clearly nearer.
      const order = this.live.reverse();
      const far = order.find((id) => (this.held.get(id)?.seen ?? now) < now) ?? order[0];
      const fh = far !== undefined ? this.held.get(far) : undefined;
      if (far === undefined || !fh || now - fh.since < c.minHoldMs) break;
      if (fh.seen === now && x.dist + c.swapMargin >= fh.dist) break;
      drop(far);
      this.held.set(x.id, { since: now, seen: now, dist: x.dist });
      watch.push(x.id);
      swapped = true;
    }
    for (const [id, t] of this.retryAt) if (t <= now) this.retryAt.delete(id);
    return { watch, unwatch: unwatch.filter((id) => !watch.includes(id)) };
  }

  /** A watch was refused or its observer failed: not live, and not retried for `retryMs`. */
  failed(id: string, now: number): void {
    this.held.delete(id);
    this.retryAt.set(id, now + this.cfg.retryMs);
  }

  /** Its watch ended on the bridge's side (closed): plan it again from scratch. */
  forget(id: string): void {
    this.held.delete(id);
  }

  /** Nothing is live any more (the connection dropped, you left the floor). */
  clear(): void {
    this.held.clear();
  }
}
