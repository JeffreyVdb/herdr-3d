import type { HostDiskRate, HostStats } from '../net/protocol';

/**
 * #74: the server rack's logic: what the bridge host's frames turn into (the bars' colours, the LEDs' levels, the texts),
 * and when the game asks the bridge to sample (`HostWatchGate`). Pure, no three.js: the mesh is render/rack.ts.
 */

/** The bars turn amber above this share and red above the next. */
export const WARN_PCT = 75;
export const HOT_PCT = 90;
export type Tone = 'ok' | 'warn' | 'hot';

/** A bar's colour: green, amber above 75 %, red above 90 %. */
export function barTone(pct: number): Tone {
  return pct > HOT_PCT ? 'hot' : pct > WARN_PCT ? 'warn' : 'ok';
}

/** The rack holds this many servers, each with a read and a write LED. */
export const RACK_SERVERS = 5;
/** At this many operations a second an LED is near solid. */
export const FULL_IOPS = 5000;
/** Under this an LED is dark. */
const DARK_IOPS = 0.05;

/**
 * An activity LED's level, 0 (dark) to 1 (near solid), on a log scale of operations a second: none is dark, about one an
 * occasional blip (0.08), a hundred a steady flicker (0.54), 5000 or more near solid (1).
 */
export function ledLevel(iops: number): number {
  if (!(iops > DARK_IOPS)) return 0;
  return Math.min(1, Math.log10(1 + iops) / Math.log10(1 + FULL_IOPS));
}

/**
 * The levels of the rack's activity LEDs, `[read 0, write 0, read 1, write 1, …]`: disk i drives server i (the disks are
 * in the bridge's name order); the servers past the last disk mirror the total of all of them, so the whole rack looks
 * alive with one NVMe. `null` or no disks: all dark.
 */
export function rackLevels(disks: readonly HostDiskRate[] | null, servers = RACK_SERVERS): number[] {
  const out: number[] = [];
  let r = 0;
  let w = 0;
  for (const d of disks ?? []) {
    r += d.r_iops;
    w += d.w_iops;
  }
  for (let i = 0; i < servers; i++) {
    const d = disks?.[i];
    out.push(ledLevel(d ? d.r_iops : r), ledLevel(d ? d.w_iops : w));
  }
  return out;
}

/** A frame older than this is drawn stale once the rack is watched again, until the next frame. */
export const STALE_MS = 30_000;

/** `used / total` in GiB, one decimal each: `12.6 / 31.2 GiB`. */
export function memText(used: number, total: number): string {
  const g = (b: number) => (b / 2 ** 30).toFixed(1);
  return `${g(used)} / ${g(total)} GiB`;
}

/** A percentage as the screen's big number: `42%`, `—` when there is none yet. */
export function pctText(pct: number | null | undefined): string {
  return pct === null || pct === undefined || !Number.isFinite(pct) ? '—' : `${Math.round(pct)}%`;
}

/** The sample's time as `HH:MM:SS` in the viewer's time zone (static: the screen never redraws for a clock). */
export function sampleClock(sampledAt: string): string {
  const d = new Date(sampledAt);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** The updates line: `3 updates pending`, `1 update pending`, `Up to date`; null when the host reports none. */
export function updatesText(u: HostStats['updates']): string | null {
  if (!u) return null;
  return u.count === 0 ? 'Up to date' : `${u.count} update${u.count === 1 ? '' : 's'} pending`;
}

/** The HUD line when the rack is aimed at: `CPU 12% · Mem 41%`, or why there is no reading. */
export function hudLine(frame: HostStats | null, unsupported: boolean): string {
  if (unsupported) return 'No host stats on this bridge';
  if (!frame) return 'Reading the host…';
  return `CPU ${pctText(frame.cpu_pct)} · Mem ${pctText(frame.mem_used_pct)}`;
}

export type RackMode = 'unsupported' | 'idle' | 'waiting' | 'live' | 'dim' | 'stale';

/**
 * What the screen shows: the calm idle screen on a bridge without the command; with no frame yet, `waiting` while watched
 * and `idle` otherwise; with one, `live`, or `dim` (the last frame, dimmed) when not watched, or `stale` (grey) when it
 * was old (STALE_MS) as the watch began and no newer one has come.
 */
export function rackMode(i: { unsupported: boolean; hasFrame: boolean; watching: boolean; stale: boolean }): RackMode {
  if (i.unsupported) return 'unsupported';
  if (!i.hasFrame) return i.watching ? 'waiting' : 'idle';
  if (!i.watching) return 'dim';
  return i.stale ? 'stale' : 'live';
}

export interface GateOptions {
  /** How long the rack must stay wanted before `host.watch` goes out (default 300 ms). */
  onMs?: number;
  /** How long it must stay unwanted before `host.unwatch` goes out (default 10 s). */
  offMs?: number;
}

export type GateAction = 'watch' | 'unwatch' | null;

/**
 * When the game asks the bridge to sample: `host.watch` once the rack has been wanted (in view of the camera, on this
 * floor, tab visible, bridge connected) for `onMs`, `host.unwatch` once it has not been for `offMs`, so turning your head
 * does not flap it. `release` ends a watch at once (a hidden tab, another floor) and `reset` forgets it (the connection
 * dropped: the bridge forgot it too). Pure: the caller passes the clock and sends what `step` and `release` return.
 */
export class HostWatchGate {
  private on = false;
  private wantedSince: number | null = null;
  private unwantedSince: number | null = null;
  private readonly onMs: number;
  private readonly offMs: number;

  constructor(o: GateOptions = {}) {
    this.onMs = o.onMs ?? 300;
    this.offMs = o.offMs ?? 10_000;
  }

  /** Whether a `host.watch` was sent and not yet undone. */
  get watching(): boolean {
    return this.on;
  }

  step(now: number, wanted: boolean): GateAction {
    if (wanted) {
      this.unwantedSince = null;
      if (this.on) return null;
      this.wantedSince ??= now;
      if (now - this.wantedSince < this.onMs) return null;
      this.on = true;
      this.wantedSince = null;
      return 'watch';
    }
    this.wantedSince = null;
    if (!this.on) return null;
    this.unwantedSince ??= now;
    if (now - this.unwantedSince < this.offMs) return null;
    this.on = false;
    this.unwantedSince = null;
    return 'unwatch';
  }

  /** Ends the watch now: `unwatch` when there was one. */
  release(): GateAction {
    const was = this.on;
    this.reset();
    return was ? 'unwatch' : null;
  }

  /** Forgets the watch without a command (a dropped connection took it). */
  reset(): void {
    this.on = false;
    this.wantedSince = null;
    this.unwantedSince = null;
  }
}
