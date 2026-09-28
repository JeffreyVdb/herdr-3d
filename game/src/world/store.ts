import type { Building, Floor, Snapshot, Worker, WorldEvent } from '../net/protocol';
import {
  assignDesks,
  deskCountFallback,
  displayName,
  displayStatus,
  resolveHarness,
  type Display,
} from './derive';

export interface WorkerView {
  worker: Worker;
  name: string;
  desk: number;
  harness: string | undefined;
  /** When the current status started (unix ms). */
  since: number;
  display: Display;
}

export interface Counts {
  working: number;
  needsYou: number;
  /** idle + done + plain shells */
  idle: number;
  done: number;
  total: number;
}

export interface FloorView {
  session: string;
  floor: Floor;
  building: Building | null;
  /** 1-based from the ground and the number of floors, null in the unassigned lot. */
  level: { number: number; count: number } | null;
  asleep: boolean;
  desks: number;
  /** Index = desk slot. */
  seats: Array<WorkerView | null>;
  workers: WorkerView[];
  counts: Counts;
}

export interface BuildingView {
  building: Building | null; // null = the unassigned lot
  /** Ground floor first. */
  floors: FloorView[];
}

/** What an update touched, so the renderer can do the least work. */
export interface Change {
  /** Buildings/floors/desks/worker membership changed: rebuild what shows them. */
  structure: boolean;
  /** Sessions whose floor views changed in any way. */
  sessions: Set<string>;
  /** Workers whose shown state (status, title, …) changed without moving desks. */
  workers: Set<string>;
}

const emptyChange = (): Change => ({ structure: false, sessions: new Set(), workers: new Set() });

/**
 * The client's copy of the bridge world: applies snapshots and events, and
 * fills in everything an older bridge does not send (names, desks, desk count,
 * harness, status age).
 */
export class WorldStore {
  readonly buildings = new Map<string, Building>();
  readonly floors = new Map<string, Floor>();
  /** In arrival order (snapshot order, then new workers). */
  readonly workers = new Map<string, Worker>();
  seq = 0;
  snapshots = 0;
  /** Bumped on every structural change. */
  structureVersion = 0;
  private readonly localDesks = new Map<string, number>();
  private readonly since = new Map<string, number>();
  private readonly deskCache = new Map<string, Map<string, number>>();

  constructor(readonly loadedAt: number = Date.now()) {}

  applySnapshot(s: Snapshot, now: number = Date.now()): Change {
    const prevSince = new Map(this.since);
    const prevStatus = new Map([...this.workers].map(([id, w]) => [id, w.status]));
    this.buildings.clear();
    this.floors.clear();
    this.workers.clear();
    this.since.clear();
    this.deskCache.clear();
    for (const b of s.world.buildings) if (b && typeof b.id === 'string') this.buildings.set(b.id, b);
    for (const f of s.world.floors) if (f && typeof f.session === 'string') this.floors.set(f.session, f);
    for (const w of s.world.workers) {
      if (!w || typeof w.id !== 'string' || typeof w.session !== 'string') continue;
      this.workers.set(w.id, w);
      const keep = prevStatus.get(w.id) === w.status ? prevSince.get(w.id) : undefined;
      this.since.set(w.id, w.status_since ?? keep ?? (this.snapshots === 0 ? this.loadedAt : now));
    }
    for (const id of [...this.localDesks.keys()]) if (!this.workers.has(id)) this.localDesks.delete(id);
    this.seq = s.seq;
    this.snapshots++;
    this.structureVersion++;
    const c = emptyChange();
    c.structure = true;
    for (const f of this.floors.keys()) c.sessions.add(f);
    return c;
  }

  applyEvent(e: WorldEvent, now: number = Date.now()): Change {
    const c = emptyChange();
    this.seq = Math.max(this.seq, e.seq);
    switch (e.t) {
      case 'building.upsert':
        this.buildings.set(e.building.id, e.building);
        c.structure = true;
        for (const s of e.building.floors ?? []) c.sessions.add(s);
        break;
      case 'building.removed':
        c.structure = this.buildings.delete(e.id);
        break;
      case 'floor.upsert': {
        this.floors.set(e.floor.session, e.floor);
        c.structure = true;
        c.sessions.add(e.floor.session);
        this.deskCache.delete(e.floor.session);
        break;
      }
      case 'floor.removed':
        if (this.floors.delete(e.session)) {
          c.structure = true;
          c.sessions.add(e.session);
          for (const [id, w] of this.workers) if (w.session === e.session) this.dropWorker(id);
          this.deskCache.delete(e.session);
        }
        break;
      case 'worker.upsert': {
        const w = e.worker;
        const old = this.workers.get(w.id);
        if (!old || old.status !== w.status) this.since.set(w.id, w.status_since ?? now);
        else if (w.status_since !== undefined) this.since.set(w.id, w.status_since);
        this.workers.set(w.id, w);
        c.sessions.add(w.session);
        if (!old || old.session !== w.session || old.desk_index !== w.desk_index) {
          c.structure = true;
          if (old) {
            c.sessions.add(old.session);
            this.deskCache.delete(old.session);
          }
          this.deskCache.delete(w.session);
        } else {
          c.workers.add(w.id);
        }
        break;
      }
      case 'worker.status': {
        const old = this.workers.get(e.id);
        if (!old) break;
        const next: Worker = { ...old, status: e.status };
        if (typeof e.title === 'string') {
          if (e.title) next.title = e.title;
          else delete next.title;
        }
        if (old.status !== e.status || e.status_since !== undefined) {
          next.status_since = e.status_since ?? now;
          this.since.set(e.id, next.status_since);
        }
        this.workers.set(e.id, next);
        c.workers.add(e.id);
        c.sessions.add(old.session);
        break;
      }
      case 'worker.removed': {
        const old = this.workers.get(e.id);
        if (!old) break;
        this.dropWorker(e.id);
        this.deskCache.delete(old.session);
        c.structure = true;
        c.sessions.add(old.session);
        break;
      }
    }
    if (c.structure) this.structureVersion++;
    return c;
  }

  private dropWorker(id: string): void {
    this.workers.delete(id);
    this.since.delete(id);
    this.localDesks.delete(id);
  }

  private desksFor(session: string): Map<string, number> {
    let m = this.deskCache.get(session);
    if (m) return m;
    const ws = [...this.workers.values()].filter((w) => w.session === session);
    m = assignDesks(ws, this.localDesks);
    for (const w of ws) {
      const d = m.get(w.id);
      if (d !== undefined && d !== w.desk_index) this.localDesks.set(w.id, d);
    }
    this.deskCache.set(session, m);
    return m;
  }

  workerView(id: string): WorkerView | null {
    const w = this.workers.get(id);
    if (!w) return null;
    const f = this.floors.get(w.session);
    const desk = this.desksFor(w.session).get(id) ?? 0;
    return {
      worker: w,
      name: displayName(w),
      desk,
      harness: resolveHarness(w),
      since: this.since.get(id) ?? this.loadedAt,
      display: displayStatus(w.status, f?.state === 'asleep'),
    };
  }

  /** Floor position within its building: number counts from the ground. */
  level(session: string): { number: number; count: number } | null {
    const f = this.floors.get(session);
    if (!f || f.building === null) return null;
    const b = this.buildings.get(f.building);
    if (!b) return null;
    const order = this.buildingFloors(b, f.building);
    const i = order.indexOf(session);
    if (i < 0) return null;
    return { number: order.length - i, count: order.length };
  }

  /** Sessions of a building, top floor first (bridge order, else by `index`). */
  private buildingFloors(b: Building, id: string): string[] {
    const known = (s: string) => this.floors.get(s)?.building === id;
    const listed = (b.floors ?? []).filter(known);
    const extra = [...this.floors.values()]
      .filter((f) => f.building === id && !listed.includes(f.session))
      .sort((x, y) => (x.index ?? 0) - (y.index ?? 0))
      .map((f) => f.session);
    return [...listed, ...extra];
  }

  floorView(session: string): FloorView | null {
    const floor = this.floors.get(session);
    if (!floor) return null;
    const asleep = floor.state === 'asleep';
    const desks = this.desksFor(session);
    const workers: WorkerView[] = [];
    let maxDesk = -1;
    for (const w of this.workers.values()) {
      if (w.session !== session) continue;
      const v = this.workerView(w.id);
      if (!v) continue;
      workers.push(v);
      maxDesk = Math.max(maxDesk, desks.get(w.id) ?? 0);
    }
    const bridgeDesks = typeof floor.desks === 'number' && floor.desks >= 0 ? floor.desks : null;
    const n = Math.max(bridgeDesks ?? deskCountFallback(workers.length, maxDesk), maxDesk + 1);
    const seats: Array<WorkerView | null> = Array.from({ length: n }, () => null);
    for (const v of workers) seats[v.desk] = v;
    workers.sort((a, b) => a.desk - b.desk);
    const counts: Counts = { working: 0, needsYou: 0, idle: 0, done: 0, total: workers.length };
    for (const v of workers) {
      if (v.display === 'working') counts.working++;
      else if (v.display === 'needs_you') counts.needsYou++;
      else if (v.display === 'done') {
        counts.done++;
        counts.idle++;
      } else if (v.display === 'idle') counts.idle++;
    }
    return {
      session,
      floor,
      building: floor.building === null ? null : (this.buildings.get(floor.building) ?? null),
      level: this.level(session),
      asleep,
      desks: n,
      seats,
      workers,
      counts,
    };
  }

  /** Buildings in `sort` order, then the unassigned lot (if any floors are in it). */
  city(): BuildingView[] {
    const out: BuildingView[] = [];
    const bs = [...this.buildings.values()].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
    for (const b of bs) {
      const floors = this.buildingFloors(b, b.id)
        .reverse()
        .map((s) => this.floorView(s))
        .filter((v): v is FloorView => v !== null);
      out.push({ building: b, floors });
    }
    const lot = [...this.floors.values()]
      .filter((f) => f.building === null || !this.buildings.has(f.building))
      .map((f) => f.session)
      .sort()
      .map((s) => this.floorView(s))
      .filter((v): v is FloorView => v !== null);
    if (lot.length) out.push({ building: null, floors: lot });
    return out;
  }
}
