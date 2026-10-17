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
// #58: floor names
import { floorName, floorNameOf } from './floorName';
// #57: asks
import { askOf } from './ask';
// #83: wrap-ups
import { wrapUpOf } from './wrapup';
// M6 start
import { AiBook } from './ai';
// #90: follow-up questions
import { followupOf, FollowupsBook } from './followup';
import { PackupBook } from './packup';
// #98: "Classify unknown commands" (the activity settings)
import { ActivitySettingsBook } from './activitySettings';
import { DigestBook } from './digestSettings';
import { HandoffLLMBook } from './handoffLlm';
// #155: the shared Codex server switch
import { CodexServerBook } from './codexServer';
import { RepoDiscoveryBook } from './repoDiscovery';
import { RepoRefsBook } from './repoRefs';
import { KaneoBook } from './kaneo';
import { NotifyBook } from './notifySettings';
import { HandoffBook } from './handoff';
import { ScheduleBook } from './schedule';
import { ChildBook } from './children';
import { floorGroups, FloorListBook } from './floorList';
import { LimitBook } from './limits';
import { PresetBook } from './presets';
import { HirePresetBook } from './hirePresets';
// M6 crew: write-code roles, freelancer lifecycles, over-cap orchestrators.
import { CrewMemory, crewView, type CrewView } from './crew';
// #98: what the agent is doing (the waiting display status).
import { isWaiting } from './activity';
// #157: a Codex worker herdr calls blocked only because of an async question keeps working.
import { asyncAttention, effectiveStatus } from './codexQuestions';

export { floorName, floorNameOf, floorOf, isVirtualFloorId } from './floorName';

export interface WorkerView {
  worker: StoredWorker;
  name: string;
  desk: number;
  harness: string | undefined;
  /** When the current status started (unix ms). */
  since: number;
  display: Display;
  /** M6: a write-code crew member's role, lifecycle, report and run (null for everyone else). */
  crew?: CrewView | null;
  /** #157: how many of a shared Codex worker's async questions want an answer (it works on meanwhile; 0: none). */
  asks?: number;
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

/** #58: a floor as the store keeps it: its id, name and base session are always set (an older bridge: the session's). */
export type StoredFloor = Floor & { id: string; name: string; base_session: string; virtual: boolean; hidden: boolean };
/** #58: a worker as the store keeps it: its floor is always set (an older bridge: its session). */
export type StoredWorker = Worker & { floor: string };


/** #58: fills in what an older bridge leaves out of a floor. */
function storedFloor(f: Floor): StoredFloor {
  return {
    ...f,
    id: f.id ?? f.session,
    name: f.name ?? f.session,
    base_session: f.base_session ?? f.session,
    virtual: f.virtual === true,
    hidden: f.hidden === true,
  };
}

const storedWorker = (w: Worker): StoredWorker => (typeof w.floor === 'string' && w.floor ? (w as StoredWorker) : { ...w, floor: w.session });

export interface FloorView {
  /** #58: the floor id (the key everywhere: commands, maps, the URL). */
  id: string;
  /** #58: the name a person sees (never the id). */
  name: string;
  /** #58: the herdr session the floor lives in (a virtual floor's base session): wake and sleep are its. */
  baseSession: string;
  /** #58: a user-defined floor on `baseSession`. */
  virtual: boolean;
  /** #58: the stored hidden setting (decision 2); a hidden floor with workers still shows. */
  hidden: boolean;
  floor: StoredFloor;
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
  /** Floors (ids) whose floor views changed in any way. */
  floors: Set<string>;
  /** Workers whose shown state (status, title, …) changed without moving desks. */
  workers: Set<string>;
}

const emptyChange = (): Change => ({ structure: false, floors: new Set(), workers: new Set() });

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
  return withValidLabels(v as HireOptions);
}

/**
 * `model_labels` (#200) are presentation only: a catalog whose labels are not an object of strings keeps its models and
 * efforts and loses the labels (the ids are then shown), and a non-string entry is skipped. Never throws.
 */
function withValidLabels(options: HireOptions): HireOptions {
  let out: HireOptions | null = null;
  for (const [harness, h] of Object.entries(options)) {
    const raw: unknown = h.model_labels;
    if (raw === undefined) continue;
    const plain = typeof raw === 'object' && raw !== null && !Array.isArray(raw);
    const kept = plain ? Object.entries(raw as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string') : [];
    if (plain && kept.length === Object.keys(raw as object).length) continue;
    out ??= { ...options };
    const { model_labels: _bad, ...rest } = h;
    out[harness] = kept.length ? { ...rest, model_labels: Object.fromEntries(kept) } : rest;
  }
  return out ?? options;
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
  /** #58: keyed by floor id. */
  readonly floors = new Map<string, StoredFloor>();
  /** In arrival order (snapshot order, then new workers). */
  readonly workers = new Map<string, StoredWorker>();
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
  /** #110: pack up on request's settings and state (`known` false from an older bridge). */
  readonly packup = new PackupBook();
  /** #98: the "Classify unknown commands" settings and state (`known` false from an older bridge). */
  readonly activitySettings = new ActivitySettingsBook();
  /** #118: the floor overview summaries' settings and state. */
  readonly digestSettings = new DigestBook();
  /** #9 LLM handoffs: the feature's settings and state. */
  readonly handoffLlm = new HandoffLLMBook();
  readonly codexServer = new CodexServerBook(); // #155
  readonly repoRefs = new RepoRefsBook(); // #247
  readonly repoDiscovery = new RepoDiscoveryBook(); // #54
  readonly kaneo = new KaneoBook(); // #184
  readonly notifySettings = new NotifyBook(); // #11
  readonly handoffs = new HandoffBook(); // #223
  readonly schedules = new ScheduleBook(); // #64 schedules
  /** #22 native child agents, per worker and generation (`known` false from a bridge before #22: none). */
  readonly children = new ChildBook();
  /** #93 hire presets (`known` false from a bridge before #93: unavailable). */
  readonly hirePresets = new HirePresetBook();
  /** #58 stage 4: Settings → Floors' rows, refreshed after every change that moves floors or workers. */
  readonly floorList = new FloorListBook(() => floorGroups(this.floors.values(), this.workers.values()));
  /** #58: the floor you stand on, listed even while hidden and empty (see `pin`). */
  private pinned: string | null = null;
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
    for (const f of s.world.floors) {
      if (!f || typeof f.session !== 'string') continue;
      const sf = storedFloor(f);
      this.floors.set(sf.id, sf);
    }
    for (const w of s.world.workers) {
      if (!w || typeof w.id !== 'string' || typeof w.session !== 'string') continue;
      this.workers.set(w.id, storedWorker(w));
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
    this.packup.reset(s.world.packup); // #110
    this.activitySettings.reset(s.world.activity); // #98
    this.digestSettings.reset(s.world.digest); // #118
    this.notifySettings.reset(s.world.notify); // #11
    this.handoffLlm.reset(s.world.handoff_llm); // #9
    this.codexServer.reset(s.world.codex_server); // #155
    this.repoRefs.reset(s.world.repo_refs); // #247
    this.repoDiscovery.reset(s.world.repo_discovery); // #54
    this.kaneo.reset(s.world.kaneo); // #184
    this.handoffs.reset(s.world.handoffs); // #223
    this.schedules.reset(s.world.schedules); // #64 schedules (a bridge before #62 sends none)
    this.children.reset(s.world.children, s.world.workers.filter((w) => w && typeof w.id === 'string')); // #22 (none before #22)
    this.hirePresets.reset(s.world.hire_presets, s.world.herdr_instructions); // #93 (a bridge before #93 sends none), #95
    this.inboxDismissed.clear(); // #106
    for (const [id, since] of Object.entries(s.world.inbox_dismissed ?? {})) if (Number.isInteger(since)) this.inboxDismissed.set(id, since);
    this.seq = s.seq;
    this.snapshots++;
    this.structureVersion++;
    const c = emptyChange();
    c.structure = true;
    for (const f of this.floors.keys()) c.floors.add(f);
    this.floorList.refresh();
    return c;
  }

  applyEvent(e: WorldEvent, now: number = Date.now()): Change {
    const c = emptyChange();
    this.seq = Math.max(this.seq, e.seq);
    switch (e.t) {
      case 'building.upsert':
        this.buildings.set(e.building.id, e.building);
        c.structure = true;
        for (const s of e.building.floors ?? []) c.floors.add(s);
        break;
      case 'building.removed':
        c.structure = this.buildings.delete(e.id);
        break;
      case 'floor.upsert': {
        const f = storedFloor(e.floor);
        this.floors.set(f.id, f);
        c.structure = true;
        c.floors.add(f.id);
        this.deskCache.delete(f.id);
        break;
      }
      case 'floor.removed': {
        // #58: by its id (an older bridge names the session: its real floor). A real floor goes with its session, and
        // so do the virtual floors on it (the bridge sends theirs too; none is left behind if one went missing).
        const id = e.floor_id ?? e.session;
        const f = this.floors.get(id);
        if (!f) break;
        const gone = f.virtual ? [f] : [...this.floors.values()].filter((x) => x.id === id || x.base_session === f.base_session);
        for (const x of gone) {
          this.floors.delete(x.id);
          c.floors.add(x.id);
          this.deskCache.delete(x.id);
          for (const [wid, w] of this.workers) if (w.floor === x.id) this.dropWorker(wid);
        }
        c.structure = true;
        break;
      }
      case 'worker.upsert': {
        const w = storedWorker(e.worker);
        const old = this.workers.get(w.id);
        if (!old || old.status !== w.status) this.since.set(w.id, w.status_since ?? now);
        else if (w.status_since !== undefined) this.since.set(w.id, w.status_since);
        this.workers.set(w.id, w);
        this.crewSeen.observe(w);
        this.children.worker(w.id, w.child_generation); // #22: a replaced session's children are gone
        c.floors.add(w.floor);
        // #58: a worker can move between floors of one session (a deleted virtual floor's workers go to the real one).
        if (!old || old.floor !== w.floor || old.desk_index !== w.desk_index) {
          c.structure = true;
          if (old) {
            c.floors.add(old.floor);
            this.deskCache.delete(old.floor);
          }
          this.deskCache.delete(w.floor);
        } else {
          c.workers.add(w.id);
        }
        break;
      }
      case 'worker.status': {
        const old = this.workers.get(e.id);
        if (!old) break;
        const next: StoredWorker = { ...old, status: e.status };
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
        c.floors.add(old.floor);
        break;
      }
      case 'worker.removed': {
        const old = this.workers.get(e.id);
        if (!old) break;
        this.dropWorker(e.id);
        this.deskCache.delete(old.floor);
        c.structure = true;
        c.floors.add(old.floor);
        break;
      }
      // M5: usage and cost changed; the rest of the worker stays.
      case 'worker.usage': {
        const old = this.workers.get(e.id);
        if (!old) break;
        this.workers.set(e.id, { ...old, usage: e.usage });
        c.workers.add(e.id);
        c.floors.add(old.floor);
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
      case 'packup.update': // #110
        this.packup.upsert(e);
        break;
      // #98: what the agent is doing changed (absent: cleared); its status stays.
      case 'worker.activity': {
        const old = this.workers.get(e.id);
        if (!old) break;
        const next: StoredWorker = { ...old };
        if (e.activity && typeof e.activity === 'object') next.activity = e.activity;
        else delete next.activity;
        this.workers.set(e.id, next);
        c.workers.add(e.id);
        c.floors.add(old.floor);
        break;
      }
      case 'activity.update': // #98 activity settings
        this.activitySettings.upsert(e);
        break;
      case 'digest.update': // #118 floor overview summaries
        this.digestSettings.upsert(e);
        break;
      case 'notify.update': // #11 Telegram notifications
        this.notifySettings.upsert(e);
        break;
      case 'handoff_llm.update': // #9 LLM handoffs
        this.handoffLlm.upsert(e);
        break;
      case 'codex_server.update': // #155 the shared Codex server switch
        this.codexServer.upsert(e);
        break;
      case 'repo_refs.update': // #247 the "Repositories from other buildings" switch
        this.repoRefs.upsert(e);
        break;
      case 'repo_discovery.update': // #54 repository discovery
        this.repoDiscovery.upsert(e);
        break;
      case 'kaneo.update': // #184 the Kaneo connection
        this.kaneo.upsert(e);
        break;
      // #223: the floor's drawers fill (the scene shows them), and a filing walk may follow.
      case 'handoff.added':
        this.handoffs.added(e);
        c.floors.add(e.floor_id ?? e.session);
        break;
      case 'handoff.removed':
        this.handoffs.removed(e);
        c.floors.add(e.floor_id ?? e.session);
        break;
      // #64 schedules
      case 'schedule.upsert':
        this.schedules.upsert(e.schedule);
        break;
      case 'schedule.removed':
        this.schedules.removed(e);
        break;
      // #93 hire presets: no part of the scene; dialogs re-render on `hirePresets.version`.
      case 'hire_preset.upsert':
        this.hirePresets.upsert(e.hire_preset);
        break;
      case 'hire_preset.removed':
        this.hirePresets.remove(e.id);
        break;
      // #22 native child agents: no part of the scene yet (the board, phase 3 of #20, reads `children.version`).
      case 'child.upsert':
        this.children.upsert(e.child);
        break;
      case 'child.removed':
        this.children.removed(e);
        break;
      // #106: the inbox hides that worker's done episode. Not part of the scene, but the inbox's pings follow it (a
      // dismissed done must not ping when its settle delay ends), so the worker counts as changed.
      case 'inbox.dismissed': {
        this.inboxDismissed.set(e.id, e.status_since);
        const w = this.workers.get(e.id);
        if (!w) break;
        c.workers.add(e.id);
        c.floors.add(w.floor);
        break;
      }
    }
    if (c.structure) this.structureVersion++;
    if (c.structure || c.workers.size) this.floorList.refresh();
    return c;
  }

  private dropWorker(id: string): void {
    this.workers.delete(id);
    this.children.removeWorker(id); // #22
    this.inboxDismissed.delete(id);
    this.since.delete(id);
    this.localDesks.delete(id);
    this.crewSeen.forget(id);
  }

  private desksFor(floor: string): Map<string, number> {
    let m = this.deskCache.get(floor);
    if (m) return m;
    const ws = [...this.workers.values()].filter((w) => w.floor === floor);
    m = assignDesks(ws, this.localDesks);
    for (const w of ws) {
      const d = m.get(w.id);
      if (d !== undefined && d !== w.desk_index) this.localDesks.set(w.id, d);
    }
    this.deskCache.set(floor, m);
    return m;
  }

  workerView(id: string): WorkerView | null {
    const w = this.workers.get(id);
    if (!w) return null;
    const f = this.floors.get(w.floor);
    const desk = this.desksFor(w.floor).get(id) ?? 0;
    const asleep = f?.state === 'asleep';
    // M6: an over-cap orchestrator, or a freelancer whose report asks, needs you whatever its agent's status.
    const orch = w.orch_id ? this.workers.get(w.orch_id) : undefined;
    const crew = crewView(w, this.crewSeen.has(id), orch ? displayName(orch) : null);
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
      display: (crew?.needsYou || ask || followup || wrapStuck) && !asleep ? 'needs_you' : !asleep && isWaiting(w) ? 'waiting' : displayStatus(effectiveStatus(w), asleep),
      crew,
      asks: asleep ? 0 : asyncAttention(w),
    };
  }

  /** #58: the name a person sees for a floor id, also once the floor is gone (a `v-` id never shows). */
  floorName(id: string): string {
    return floorNameOf(this.floors, id);
  }

  /** #58: every floor of a herdr session, its real floor first, then its virtual floors in building order: a wake or a sleep is theirs. */
  sessionFloors(session: string): StoredFloor[] {
    return [...this.floors.values()]
      .filter((f) => f.base_session === session)
      .sort((a, b) => Number(a.virtual) - Number(b.virtual) || (a.index ?? 0) - (b.index ?? 0) || floorName(a).localeCompare(floorName(b)));
  }

  /**
   * #58: keeps floor `id` in the lists while you stand on it (null: none), so hiding it, or its last worker leaving,
   * never takes the floor away under you; a `?floor=` link to a hidden floor opens it too. True when the lists change.
   */
  pin(id: string | null): boolean {
    if (id === this.pinned) return false;
    // Only a floor that shows by nothing but the pin comes or goes with it.
    const pinOnly = (x: string | null) => {
      const f = x === null ? undefined : this.floors.get(x);
      return !!f && !this.shownUnpinned(f);
    };
    const changed = pinOnly(this.pinned) || pinOnly(id);
    this.pinned = id;
    if (changed) this.structureVersion++;
    return changed;
  }

  /** Whether a floor shows by its own setting and workers, pin aside. */
  private shownUnpinned(f: StoredFloor): boolean {
    if (!f.hidden) return true;
    for (const w of this.workers.values()) if (w.floor === f.id) return true;
    return false;
  }

  /**
   * #58 decision 2: a floor the lists show: not hidden, or hidden with a worker on it (an unattributed workspace on a
   * hidden base floor shows it again), or the floor you stand on (`pin`).
   */
  private shown(f: StoredFloor): boolean {
    return f.id === this.pinned || this.shownUnpinned(f);
  }

  /** Floor position within its building: number counts from the ground. */
  level(id: string): { number: number; count: number } | null {
    const f = this.floors.get(id);
    if (!f || f.building === null) return null;
    const b = this.buildings.get(f.building);
    if (!b) return null;
    const order = this.buildingFloors(b, f.building);
    const i = order.indexOf(id);
    if (i < 0) return null;
    return { number: order.length - i, count: order.length };
  }

  /** Floor ids of a building the lists show, top floor first (bridge order, else by `index`). */
  private buildingFloors(b: Building, id: string): string[] {
    const known = (s: string) => {
      const f = this.floors.get(s);
      return f?.building === id && this.shown(f);
    };
    const listed = (b.floors ?? []).filter(known);
    const extra = [...this.floors.values()]
      .filter((f) => f.building === id && !listed.includes(f.id) && this.shown(f))
      .sort((x, y) => (x.index ?? 0) - (y.index ?? 0))
      .map((f) => f.id);
    return [...listed, ...extra];
  }

  floorView(id: string): FloorView | null {
    const floor = this.floors.get(id);
    if (!floor) return null;
    const asleep = floor.state === 'asleep';
    const desks = this.desksFor(id);
    const workers: WorkerView[] = [];
    let maxDesk = -1;
    for (const w of this.workers.values()) {
      if (w.floor !== id) continue;
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
      id,
      name: floorName(floor),
      baseSession: floor.base_session,
      virtual: floor.virtual,
      hidden: floor.hidden,
      floor,
      transition: transitionOf(floor.transition),
      settings: objectOf<FloorSettings>(floor.settings),
      suggested: objectOf<FloorSuggested>(floor.suggested),
      resume,
      building: floor.building === null ? null : (this.buildings.get(floor.building) ?? null),
      level: this.level(id),
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
      .filter((f) => (f.building === null || !this.buildings.has(f.building)) && this.shown(f))
      .sort((a, b) => (floorName(a) < floorName(b) ? -1 : floorName(a) > floorName(b) ? 1 : a.id < b.id ? -1 : 1))
      .map((f) => this.floorView(f.id))
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
