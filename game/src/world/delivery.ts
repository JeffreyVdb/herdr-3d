/**
 * M6c: a freelancer's report walks over to the orchestrator's desk. This is the book of those walks and of what
 * lands on the orchestrator's in-tray. Pure; vitest covers it.
 *
 * - A report plays once: keyed by the worker's id and the report's `at`. A report that is already `ready` in a
 *   snapshot plays nothing (`sync`): its folder is on the tray and the freelancer sits empty-handed.
 * - Reports queue: one delivery at a time on a floor (`next`), the others wait at their desks, so walkers never
 *   overlap and never cross one another, on the hand-over spot or in the aisles.
 * - A report that was seen is remembered (`played`) for as long as its freelancer is in the world, whatever the
 *   tray holds: a report that goes pending and ready again with the same `at` (a reconnect) never plays twice.
 * - A delivery's folder lands on the tray when the hand-over is done (`land`); it goes when its freelancer's
 *   workspace closes (`close`), or, when it closed mid-delivery, once the freelancer has left (`settle`).
 * - The tray shows the last `TRAY_CAP` folders; the rest are under them.
 */

import type { WorkerReport } from '../net/protocol';
import { inputRequired, stampOf, type StampTone } from './crew';
import { DESK_H } from './layout';
import { TRAY_SPOT, type DockSide } from './deskKit';
import type { WorkerView } from './store';

/** Folders the in-tray shows at most. */
export const TRAY_CAP = 5;

/** One report handed in, or on its way. */
export interface ReportFact {
  /** The freelancer. */
  id: string;
  /** #58: its floor id. */
  floor: string;
  /** Its desk. */
  desk: number;
  /** The orchestrator's worker id. */
  orch: string;
  /** The report's `at`. */
  at: number;
  /** The verdict's stamp colour on the folder's edge (null: none, a coder's). */
  tone: StampTone | null;
}

export const deliveryKey = (id: string, at: number): string => `${id}@${at}`;

/** The report a freelancer hands in: ready, without a question (a report that asks stays at the desk), for an orchestrator. */
export function reportFact(v: Pick<WorkerView, 'worker' | 'desk' | 'crew'>): ReportFact | null {
  const c = v.crew;
  const r = v.worker.report;
  if (!c?.freelancer || !c.orchId || r?.state !== 'ready' || inputRequired(r)) return null;
  return { id: v.worker.id, floor: v.worker.floor, desk: v.desk, orch: c.orchId, at: r.at ?? 0, tone: stampOf(r)?.tone ?? null };
}

/** Whether a worker's report became ready (or a new one did): `prev` → `now`. */
export const reportArrived = (prev: WorkerReport | undefined, now: WorkerReport | undefined): boolean =>
  now?.state === 'ready' && !(prev?.state === 'ready' && prev.at === now.at);

export type Stage = 'queued' | 'active' | 'tray';

export interface Entry extends ReportFact {
  key: string;
  stage: Stage;
  /** Its workspace closed while it was on its way: the folder stays on the tray until it has left (`settle`). */
  leaving: boolean;
}

export class DeliveryBook {
  private readonly entries = new Map<string, Entry>();
  /** Every report seen (keys), whether its folder is on a tray now or not. */
  private readonly played = new Set<string>();

  /**
   * A report: `play` (a live change somebody watches) queues its delivery, else its folder is on the tray at
   * once. `known`: this report is in the book already; one played before whose folder is gone (a snapshot had it
   * pending meanwhile) lands on the tray without playing again.
   */
  add(f: ReportFact, play: boolean): 'queued' | 'tray' | 'known' {
    const key = deliveryKey(f.id, f.at);
    if (this.entries.has(key)) return 'known';
    if (this.played.has(key)) play = false;
    this.played.add(key);
    // A newer report of the same freelancer takes the place of its older folder.
    for (const [k, e] of this.entries) if (e.id === f.id && e.stage === 'tray' && !e.leaving) this.entries.delete(k);
    this.entries.set(key, { ...f, key, stage: play ? 'queued' : 'tray', leaving: false });
    return play ? 'queued' : 'tray';
  }

  /**
   * A snapshot (the first, or a reconnect's): `facts` are every ready report now. Each is on the tray, none plays;
   * what the book had of workers that are not there any more goes.
   */
  sync(facts: readonly ReportFact[], alive?: ReadonlySet<string>): void {
    // What was played is kept for every freelancer still in the world, even with its report pending right now.
    if (alive) for (const key of this.played) if (!alive.has(key.slice(0, key.lastIndexOf('@')))) this.played.delete(key);
    const keys = new Set(facts.map((f) => deliveryKey(f.id, f.at)));
    for (const [key] of this.entries) if (!keys.has(key)) this.entries.delete(key);
    for (const f of facts) {
      const e = this.entries.get(deliveryKey(f.id, f.at));
      if (e) Object.assign(e, { floor: f.floor, desk: f.desk, orch: f.orch });
      else this.add(f, false);
      // What the snapshot knows is on the tray; one still walking is overtaken by it.
      const cur = this.entries.get(deliveryKey(f.id, f.at));
      if (cur) cur.stage = 'tray';
    }
  }

  get(key: string): Entry | undefined {
    return this.entries.get(key);
  }

  /**
   * The next delivery to `orch` to start: the oldest queued one, unless one is under way for it or its floor is
   * `busy` (the floors with a delivery under way: one walk at a time on a floor).
   */
  next(orch: string, busy?: ReadonlySet<string>): Entry | null {
    let first: Entry | null = null;
    for (const e of this.entries.values()) {
      if (e.orch !== orch) continue;
      if (e.stage === 'active') return null;
      if (e.stage === 'queued' && !first) first = e;
    }
    if (!first || busy?.has(first.floor)) return null;
    first.stage = 'active';
    return first;
  }

  /** The floors with a delivery under way. */
  activeFloors(): Set<string> {
    return new Set([...this.entries.values()].filter((e) => e.stage === 'active').map((e) => e.floor));
  }

  /** Returns `key`'s delivery to the queue's front (it could not be shown after all). */
  unstart(key: string): void {
    const e = this.entries.get(key);
    if (e?.stage === 'active') e.stage = 'queued';
  }

  /** The folder is on the tray. */
  land(key: string): void {
    const e = this.entries.get(key);
    if (e) e.stage = 'tray';
  }

  /** Nobody sees these walks (another floor, the city, a sleeping floor): every delivery on `floor` resolves at once. */
  resolve(floor?: string): Entry[] {
    const out: Entry[] = [];
    for (const e of this.entries.values()) {
      if (e.stage === 'tray' || (floor !== undefined && e.floor !== floor)) continue;
      e.stage = 'tray';
      out.push(e);
    }
    return out;
  }

  /**
   * A freelancer's workspace closed. Its folders on the tray go; one still on its way lands and stays until the
   * freelancer has left (`settle`). Returns the keys that landed. `walking`: the key of its delivery walk still going
   * on (the hand-over finishing, or the walk back): its folder is on the tray already or not, and stays either way.
   */
  close(id: string, walking?: string): string[] {
    const landed: string[] = [];
    for (const [key, e] of this.entries) {
      if (e.id !== id) continue;
      if (e.stage === 'tray' && key === walking) e.leaving = true;
      else if (e.stage === 'tray') this.entries.delete(key);
      else {
        e.stage = 'tray';
        e.leaving = true;
        landed.push(key);
      }
    }
    return landed;
  }

  /** The freelancer that closed mid-delivery has left: its folder goes. */
  settle(id: string): void {
    for (const [key, e] of this.entries) if (e.id === id && e.leaving) this.entries.delete(key);
  }

  /** The worker is gone from the world: its reports are forgotten. */
  forget(id: string): void {
    for (const key of this.played) if (key.startsWith(`${id}@`)) this.played.delete(key);
  }

  /** The orchestrator is gone: its tray and the deliveries to it go. */
  dropOrch(orch: string): void {
    for (const [key, e] of this.entries) if (e.orch === orch) this.entries.delete(key);
  }

  /** The folders on `orch`'s tray, oldest first (at most `TRAY_CAP` shown: the last ones). */
  tray(orch: string): Entry[] {
    return [...this.entries.values()].filter((e) => e.orch === orch && e.stage === 'tray').slice(-TRAY_CAP);
  }

  /** Everything not yet on a tray, for `orch` (queued and active). */
  pending(orch?: string): Entry[] {
    return [...this.entries.values()].filter((e) => e.stage !== 'tray' && (orch === undefined || e.orch === orch));
  }

  /** The orchestrators with a delivery waiting its turn. */
  queuedOrchs(): string[] {
    return [...new Set([...this.entries.values()].filter((e) => e.stage === 'queued').map((e) => e.orch))];
  }

  /** The orchestrators with a folder on their tray. */
  orchs(): string[] {
    return [...new Set([...this.entries.values()].filter((e) => e.stage === 'tray').map((e) => e.orch))];
  }

  /** A freelancer is on its way with a report (queued or walking). */
  busy(id: string): boolean {
    return [...this.entries.values()].some((e) => e.id === id && e.stage !== 'tray');
  }

  get size(): number {
    return this.entries.size;
  }
}

// ---- the in-tray, in the world ---------------------------------------------------------

/** A tray folder is the held one at this scale. */
export const TRAY_FOLDER_SCALE = 0.62;
/** Folders lie in the tray one on top of another, this thick each. */
export const TRAY_FOLDER_STEP = 0.012;

/** Where a tray stands and which way it faces: the orchestrator's seat and facing, and its desk's dock side. */
export interface TrayPose {
  x: number;
  /** The floor level under the desk (the floor's own or the mezzanine's), absolute. */
  y: number;
  z: number;
  yaw: number;
  side: DockSide;
}

/** Desk space (x right, z ahead of the worker) → world, for a seat turned `yaw`. */
export function deskToWorld(p: { x: number; z: number; yaw: number }, dx: number, dz: number): { x: number; z: number } {
  return { x: p.x + dx * Math.cos(p.yaw) + dz * Math.sin(p.yaw), z: p.z - dx * Math.sin(p.yaw) + dz * Math.cos(p.yaw) };
}

/** The tray's middle on the desk top, in the world. */
export function trayAt(t: TrayPose): { x: number; y: number; z: number } {
  const w = deskToWorld(t, TRAY_SPOT.x * t.side, TRAY_SPOT.z);
  return { x: w.x, y: t.y + DESK_H + 0.006, z: w.z };
}

/** Where the `n`-th folder (0: the bottom one) lies in the tray, in the world, and its turn about y. */
export function trayFolderAt(t: TrayPose, n: number): { x: number; y: number; z: number; yaw: number } {
  const c = trayAt(t);
  // A hand-laid pile: each a little off and askew, deterministically.
  const jx = (((n * 7 + 3) % 5) - 2) * 0.004;
  const jz = (((n * 5 + 1) % 5) - 2) * 0.004;
  return { x: c.x + jx, y: c.y + 0.012 + n * TRAY_FOLDER_STEP, z: c.z + jz, yaw: t.yaw + t.side * (((n * 3) % 5) - 2) * 0.05 };
}
