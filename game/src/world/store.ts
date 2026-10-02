import type {
  Building,
  Floor,
  FloorSettings,
  FloorSuggested,
  FloorTransition,
  HireOptions,
  Snapshot,
  Worker,
  WorldEvent,
} from '../net/protocol';
import {
  assignDesks,
  deskCountFallback,
  displayName,
  displayStatus,
  resolveHarness,
  type Display,
} from './derive';
// #57: asks
import { askOf } from './ask';
// #83: wrap-ups
import { wrapUpOf } from './wrapup';
// M6 start
import { AiBook } from './ai';
// #90: follow-up questions
import { followupOf, FollowupsBook } from './followup';
// #98: "Classify unknown commands" (the activity settings)
import { ActivitySettingsBook } from './activitySettings';
import { LimitBook } from './limits';
import { PresetBook } from './presets';
// M6 crew: write-code roles, freelancer lifecycles, over-cap orchestrators.
import { CrewMemory, crewView, type CrewView } from './crew';
// #98: what the agent is doing (the waiting display status).
import { isWaiting } from './activity';

export interface WorkerView {
  worker: Worker;
  name: string;
  desk: number;
  harness: string | undefined;
  /** When the current status started (unix ms). */
  since: number;
  display: Display;
  /** M6: a write-code crew member's role, lifecycle, report and run (null for everyone else). */
  crew?: CrewView | null;
}

export interface Counts {
  working: number;
  needsYou: number;
  /** idle + done + plain shells (#98: not those waiting on their background tasks) */
  idle: number;
  done: number;
  /** #98: idle or done, waiting on their own background tasks (a count of its own, never idle). */
  waiting: number;
  total: number;
}

/** Workers of a floor by `resume` state (only those that report one). */
export interface ResumeCounts {
  pending: number;
  confirmed: number;
  fallback: number;
  failed: number;
  total: number;
}

export interface FloorView {
  session: string;
  floor: Floor;
  /** M3: a wake/sleep in progress, null otherwise (and from an older bridge). */
  transition: FloorTransition | null;
  /** M3: stored settings ({} from an older bridge). */
  settings: FloorSettings;
  /** M3: bridge suggestions ({} from an older bridge). */
  suggested: FloorSuggested;
  /** M3: resume progress after a wake, null when no worker reports one. */
  resume: ResumeCounts | null;
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

/** `world.hire_options` of an older bridge: the lists in the M3 contract. */
export const DEFAULT_HIRE_OPTIONS: HireOptions = {
  claude: { models: ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  codex: {
    models: ['gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    extra_efforts: { 'gpt-6-sol': ['ultra'], 'gpt-6-astra': ['ultra'] },
  },
};

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** The bridge's hire options when they have the expected shape, else the built-in ones. */
function hireOptionsOf(v: unknown): HireOptions {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return DEFAULT_HIRE_OPTIONS;
  const entries = Object.entries(v as Record<string, unknown>);
  if (!entries.length) return DEFAULT_HIRE_OPTIONS;
  for (const [, h] of entries) {
    const o = h as Record<string, unknown> | null;
    if (typeof o !== 'object' || o === null || !strings(o.models) || !strings(o.efforts)) return DEFAULT_HIRE_OPTIONS;
    if (o.extra_efforts !== undefined && (typeof o.extra_efforts !== 'object' || o.extra_efforts === null || !Object.values(o.extra_efforts).every(strings))) {
      return DEFAULT_HIRE_OPTIONS;
    }
  }
  return v as HireOptions;
}

const transitionOf = (v: unknown): FloorTransition | null => (v === 'waking' || v === 'sleeping' ? v : null);
const objectOf = <T extends object>(v: unknown): T => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as T) : ({} as T));

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
  /** Models and efforts a default hire may use (M3), else the built-in lists. */
  hireOptions: HireOptions = DEFAULT_HIRE_OPTIONS;
  /** M6 start: team presets (`known` false from an older bridge). */
  readonly presets = new PresetBook();
  /** M10 limits: the plan limits (`known` false from an older bridge); the widget renders on `limits.version`. */
  readonly limits = new LimitBook();
  /** #92: the AI integration's settings and state (`known` false from an older bridge); no part of the scene. */
  readonly ai = new AiBook();
  /** #90: the follow-up questions feature's settings and state (`known` false from an older bridge). */
  readonly followups = new FollowupsBook();
  /** #98: the "Classify unknown commands" settings and state (`known` false from an older bridge). */
  readonly activitySettings = new ActivitySettingsBook();
  /** #106: the inbox's dismissed finished rows, worker id → the `status_since` of the done episode hidden. */
  readonly inboxDismissed = new Map<string, number>();
  private readonly localDesks = new Map<string, number>();
  private readonly since = new Map<string, number>();
  private readonly deskCache = new Map<string, Map<string, number>>();
  /** M6: who has worked since first seen (a freelancer's onboarding ends there). */
  private readonly crewSeen = new CrewMemory();

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
    this.crewSeen.snapshot(this.workers.values());
    this.hireOptions = hireOptionsOf(s.world.hire_options);
    this.presets.reset(s.world.presets);
    this.limits.reset(s.world.limits);
    this.ai.reset(s.world.ai);
    this.followups.reset(s.world.followups);
    this.activitySettings.reset(s.world.activity); // #98
    this.inboxDismissed.clear(); // #106
    for (const [id, since] of Object.entries(s.world.inbox_dismissed ?? {})) if (Number.isInteger(since)) this.inboxDismissed.set(id, since);
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
        this.crewSeen.observe(w);
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
        this.crewSeen.observe(next);
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
      // M5: usage and cost changed; the rest of the worker stays.
      case 'worker.usage': {
        const old = this.workers.get(e.id);
        if (!old) break;
        this.workers.set(e.id, { ...old, usage: e.usage });
        c.workers.add(e.id);
        c.sessions.add(old.session);
        break;
      }
      // M6 start: presets are no part of the scene; dialogs re-render on `presets.version`.
      case 'preset.upsert':
        this.presets.upsert(e.preset);
        break;
      case 'preset.removed':
        this.presets.remove(e.id);
        break;
      // M10 limits: no part of the scene either.
      case 'limits.update':
        this.limits.upsert(e);
        break;
      // #92: no part of the scene either.
      case 'ai.update':
        this.ai.upsert(e);
        break;
      case 'followups.update': // #90
        this.followups.upsert(e);
        break;
      // #98: what the agent is doing changed (absent: cleared); its status stays.
      case 'worker.activity': {
        const old = this.workers.get(e.id);
        if (!old) break;
        const next: Worker = { ...old };
        if (e.activity && typeof e.activity === 'object') next.activity = e.activity;
        else delete next.activity;
        this.workers.set(e.id, next);
        c.workers.add(e.id);
        c.sessions.add(old.session);
        break;
      }
      case 'activity.update': // #98 activity settings
        this.activitySettings.upsert(e);
        break;
      // #106: the inbox hides that worker's done episode. Not part of the scene, but the inbox's pings follow it (a
      // dismissed done must not ping when its settle delay ends), so the worker counts as changed.
      case 'inbox.dismissed': {
        this.inboxDismissed.set(e.id, e.status_since);
        const w = this.workers.get(e.id);
        if (!w) break;
        c.workers.add(e.id);
        c.sessions.add(w.session);
        break;
      }
    }
    if (c.structure) this.structureVersion++;
    return c;
  }

  private dropWorker(id: string): void {
    this.workers.delete(id);
    this.inboxDismissed.delete(id);
    this.since.delete(id);
    this.localDesks.delete(id);
    this.crewSeen.forget(id);
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
    const asleep = f?.state === 'asleep';
    // M6: an over-cap orchestrator, or a freelancer whose report asks, needs you whatever its agent's status.
    const crew = crewView(w, this.crewSeen.has(id));
    // #57: so does an agent waiting on its structured question (herdr may call it idle), since it asked.
    const ask = asleep ? null : askOf(w);
    // #83: and a wrap-up that stopped without sending it home.
    const wrapStuck = wrapUpOf(w)?.state === 'needs_you';
    // #90: and an agent whose final message asked you something, since the bridge found it.
    const followup = asleep || ask ? null : followupOf(w);
    return {
      worker: w,
      name: displayName(w),
      desk,
      harness: resolveHarness(w),
      since: ask ? ask.since : followup ? followup.at : (this.since.get(id) ?? this.loadedAt),
      // #98: an agent that ended its turn on purpose, waiting on its own background tasks, is not idle; needing you wins.
      display: (crew?.needsYou || ask || followup || wrapStuck) && !asleep ? 'needs_you' : !asleep && isWaiting(w) ? 'waiting' : displayStatus(w.status, asleep),
      crew,
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
    const counts: Counts = { working: 0, needsYou: 0, idle: 0, done: 0, waiting: 0, total: workers.length };
    let resume: ResumeCounts | null = null;
    for (const v of workers) {
      const r = v.worker.resume;
      if (r === 'pending' || r === 'confirmed' || r === 'fallback' || r === 'failed') {
        resume ??= { pending: 0, confirmed: 0, fallback: 0, failed: 0, total: 0 };
        resume[r]++;
        resume.total++;
      }
      if (v.display === 'working') counts.working++;
      else if (v.display === 'needs_you') counts.needsYou++;
      else if (v.display === 'done') {
        counts.done++;
        counts.idle++;
      } else if (v.display === 'idle') counts.idle++;
      else if (v.display === 'waiting') counts.waiting++;
    }
    return {
      session,
      floor,
      transition: transitionOf(floor.transition),
      settings: objectOf<FloorSettings>(floor.settings),
      suggested: objectOf<FloorSuggested>(floor.suggested),
      resume,
      building: floor.building === null ? null : (this.buildings.get(floor.building) ?? null),
      level: this.level(session),
      asleep,
      desks: n,
      seats,
      workers,
      counts,
    };
  }

  /** Buildings in city order (`sort`, then name). */
  sortedBuildings(): Building[] {
    return [...this.buildings.values()].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  }

  /** A building's floors top to bottom, or (null) the unassigned lot's by name. */
  stack(building: string | null): FloorView[] {
    if (building === null) return this.lot();
    const b = this.buildings.get(building);
    if (!b) return [];
    return this.buildingFloors(b, building)
      .map((s) => this.floorView(s))
      .filter((v): v is FloorView => v !== null);
  }

  private lot(): FloorView[] {
    return [...this.floors.values()]
      .filter((f) => f.building === null || !this.buildings.has(f.building))
      .map((f) => f.session)
      .sort()
      .map((s) => this.floorView(s))
      .filter((v): v is FloorView => v !== null);
  }

  /** Buildings in `sort` order, then the unassigned lot (if any floors are in it). */
  city(): BuildingView[] {
    const out: BuildingView[] = [];
    for (const b of this.sortedBuildings()) {
      const floors = this.buildingFloors(b, b.id)
        .reverse()
        .map((s) => this.floorView(s))
        .filter((v): v is FloorView => v !== null);
      out.push({ building: b, floors });
    }
    const lot = this.lot();
    if (lot.length) out.push({ building: null, floors: lot });
    return out;
  }
}
