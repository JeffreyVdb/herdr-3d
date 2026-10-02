/**
 * #100: when the inbox pings (a desktop notification or a toast, and the
 * chime). Fed the inbox after every world change; a ping is a new episode
 * (worker, reason, `since`) seen on a live change:
 * - into needs you (any role): at once;
 * - into done: an employee only (a freelancer with `freelancers` on), after a
 *   settle delay, and not when it went back to work meanwhile; a done that
 *   left the inbox before it pinged (#98: waiting on its background tasks, its
 *   status and `since` unchanged) settles again when it is back, once;
 * - never on a snapshot (the first or a reconnect's): what it lists is known
 *   silently, and what is new in it comes back as one "while you were away";
 * - never for the worker you are sat at (or reading);
 * - more than `burstMax` pings within `burstMs` of a burst's first collapse
 *   into one, updated as more arrive; one chime per burst.
 * A floor that falls asleep and wakes keeps its episodes: they are not new.
 * Pure but for the injected clock.
 */

import { isFreelancer, type CrewRole } from './crew';

export type PingKind = 'needs' | 'finished';

export interface PingEntry {
  id: string;
  name: string;
  session: string;
  /** The crew role; null: an employee. */
  role: CrewRole | null;
  reason: 'blocked' | 'done';
  /** When the episode started (unix ms): a new `since` is a new episode. */
  since: number;
}

/** Which pings are wanted (InboxSettings). */
export interface PingGates {
  onNeeds: boolean;
  onFinished: boolean;
  freelancers: boolean;
}

export type PingOut =
  /** One worker; `chime`: the first of its burst. */
  | { t: 'ping'; kind: PingKind; entry: PingEntry; chime: boolean }
  /** A collapsed burst so far (every ping of it, the first ones too); replaces the one before. */
  | { t: 'burst'; entries: PingEntry[]; needs: number; finished: number }
  /** A snapshot's new entries. */
  | { t: 'away'; needs: number; finished: number };

export interface PingClock {
  now(): number;
  /** Runs `fn` in `ms`; returns the cancel. */
  later(fn: () => void, ms: number): () => void;
}

export const realClock: PingClock = {
  now: () => Date.now(),
  later: (fn, ms) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

export interface PingOptions {
  emit(out: PingOut): void;
  /** The worker you are sat at or reading, now. */
  focus(): string | null;
  gates(): PingGates;
  clock?: PingClock;
  settleMs?: number;
  burstMs?: number;
  burstMax?: number;
}

const episode = (e: PingEntry) => `${e.reason}|${e.since}`;
const kindOf = (e: PingEntry): PingKind => (e.reason === 'blocked' ? 'needs' : 'finished');

export class InboxPings {
  /** The last episode seen per worker (kept while it is out of the inbox). */
  private readonly seen = new Map<string, string>();
  /** Done workers settling: the episode and its cancel. */
  private readonly settling = new Map<string, { entry: PingEntry; cancel: () => void }>();
  /** Done episodes that left the inbox while settling, not pinged yet: they settle again when back. */
  private readonly unfired = new Map<string, string>();
  private burst: { start: number; entries: PingEntry[] } | null = null;
  private readonly clock: PingClock;
  private readonly settleMs: number;
  private readonly burstMs: number;
  private readonly burstMax: number;

  constructor(private readonly o: PingOptions) {
    this.clock = o.clock ?? realClock;
    this.settleMs = o.settleMs ?? 5000;
    this.burstMs = o.burstMs ?? 10_000;
    this.burstMax = o.burstMax ?? 3;
  }

  /** The inbox after a change (needs you and done, every role); `snapshot`: the change was a snapshot. */
  update(entries: Iterable<PingEntry>, snapshot: boolean): void {
    const now = new Map<string, PingEntry>();
    for (const e of entries) now.set(e.id, e);
    for (const [id, s] of this.settling) {
      const e = now.get(id);
      if (e && episode(e) === episode(s.entry)) continue;
      if (!e) this.unfired.set(id, episode(s.entry));
      this.unsettle(id);
    }
    if (snapshot) return this.snapshot(now);
    for (const e of now.values()) {
      const key = episode(e);
      if (this.seen.get(e.id) === key && this.unfired.get(e.id) !== key) continue;
      this.seen.set(e.id, key);
      this.unfired.delete(e.id);
      if (e.reason === 'blocked') this.fire(e);
      else this.settling.set(e.id, { entry: e, cancel: this.clock.later(() => this.settled(e.id), this.settleMs) });
    }
  }

  /** Workers whose done is still settling (test hook). */
  pending(): string[] {
    return [...this.settling.keys()];
  }

  dispose(): void {
    for (const id of [...this.settling.keys()]) this.unsettle(id);
  }

  private snapshot(now: Map<string, PingEntry>): void {
    let needs = 0;
    let finished = 0;
    for (const e of now.values()) {
      const key = episode(e);
      const fresh = this.seen.get(e.id) !== key || this.settling.has(e.id);
      this.seen.set(e.id, key);
      this.unfired.delete(e.id);
      this.unsettle(e.id);
      if (!fresh) continue;
      if (e.reason === 'blocked') needs++;
      else if (!isFreelancer(e.role) || this.o.gates().freelancers) finished++;
    }
    if (needs || finished) this.o.emit({ t: 'away', needs, finished });
  }

  private unsettle(id: string): void {
    this.settling.get(id)?.cancel();
    this.settling.delete(id);
  }

  private settled(id: string): void {
    const s = this.settling.get(id);
    if (!s) return;
    this.settling.delete(id);
    this.fire(s.entry);
  }

  /** A new episode: pings unless gated off or it is yours already. */
  private fire(e: PingEntry): void {
    const g = this.o.gates();
    if (e.reason === 'blocked' ? !g.onNeeds : !g.onFinished || (isFreelancer(e.role) && !g.freelancers)) return;
    if (this.o.focus() === e.id) return;
    const t = this.clock.now();
    if (!this.burst || t - this.burst.start >= this.burstMs) this.burst = { start: t, entries: [] };
    const b = this.burst;
    const i = b.entries.findIndex((x) => x.id === e.id);
    if (i < 0) b.entries.push(e);
    else b.entries[i] = e; // the same worker again: one agent of the burst
    if (b.entries.length <= this.burstMax) return this.o.emit({ t: 'ping', kind: kindOf(e), entry: e, chime: b.entries.length === 1 && i < 0 });
    const needs = b.entries.filter((x) => x.reason === 'blocked').length;
    this.o.emit({ t: 'burst', entries: [...b.entries], needs, finished: b.entries.length - needs });
  }
}
