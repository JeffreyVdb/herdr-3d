/**
 * #118: the floor overview (the lounge wall's big screen and its page) as data: every worker of a floor as a tree,
 * orchestrators with their freelancers nested under them, and what each row says. Pure; the page (ui/overview.ts) and
 * the wall's texture (render/overviewScreen.ts) draw the same tree.
 *
 * Order (never a status: rows that jump while you read them are worse than any order): orchestrators by desk, each
 * with its freelancers by round, role (code, review, ux, ground) and desk; then a ghost row per orchestrator on another
 * floor that has freelancers here; then the Unlinked group (freelancers with no orchestrator, or one that is gone);
 * then everyone else by desk. A freelancer on another floor whose orchestrator is here stays under it, tagged with its
 * floor.
 *
 * #24 (phase 3 of #20): every worker row carries its native child agents (world/children.ts `childTree`) nested under it,
 * to any depth: a worker's own children after its freelancers (an orchestrator's crew keeps its shape), each child over
 * its own. They are conversation rows, never workers: no count, total or token sum takes them.
 */

import type { Child, ChildState, ChildTranscript, DigestLineStatus, Floor, HireOptions, Worker } from '../net/protocol';
import { ACTIVITY_WORD, activityOf } from './activity';
import { childTree, type ChildTreeNode } from './children';
import type { CrewRole } from './crew';
import { modelText, STATUS_WORD, type Display } from './derive';
import { floorNameOf, floorOf } from './floorName';
import type { BuildingView, Counts, FloorView, WorkerView } from './store';

/** Where a task or now line came from (docs/protocol.md "Floor overview digest"); `report` is a freelancer's summary. */
export type LineSource = 'ai_title' | 'prompt' | 'recap' | 'title' | 'report' | 'llm';

export interface OverviewLine {
  text: string;
  source: LineSource;
  /** Written by the configured LLM (a later phase): the page marks it. */
  llm: boolean;
  /**
   * #174: the model's line is awaited or failed while this fallback shows (pending, retrying, failed); absent otherwise.
   * #198: on a model's now line (`llm`), a refresh from newer activity failed (retrying, failed only) and this line is the
   * previous one.
   */
  status?: DigestLineStatus;
  /** #198: a model's now line: when it was written (unix ms, bridge clock: `now_at`), not when the activity it sums up happened. */
  at?: number;
}

export interface OverviewTicket {
  /** `#123`, else the run's ticket field. */
  key: string;
  title: string | null;
  /** The board card it opens (`boardsPanel.openItem('issues', floor, id)`); null when the bridge knows none. */
  item: { floor: string; id: string } | null;
  /** The issue's page, as the bridge sent it (the game never builds one). */
  url: string | null;
}

export interface OverviewWorkerRow {
  kind: 'worker';
  key: string;
  id: string;
  /** #58: the floor id it is on. */
  floorId: string;
  name: string;
  display: Display;
  /** When the current status began (unix ms). */
  since: number;
  harness: string | null;
  /** #229: the model's readable name and effort, `Opus 5.5 high` (the harness is the row's icon). */
  model: string;
  role: CrewRole | null;
  /** The role chip: `ORCH`, `CODE r2`. */
  tag: string | null;
  runColor: number | null;
  /** Orchestrators: the round (the wall's chip), over the pass cap (a chip). #229: the phase and pass are the crew card's. */
  orch: { round: number | null; overCap: boolean } | null;
  ticket: OverviewTicket | null;
  /** One-off workers (no run): what they were asked to do. */
  task: OverviewLine | null;
  /** What it does now (only once a turn of it was read). */
  now: OverviewLine | null;
  /** The live activity, `Testing · pytest` (#98): the row's spoken words and its no-summary line. */
  activity: string | null;
  /** #232: the same as the since column shows it while working: the verb, and its detail ('' for none), which gives way first. */
  act: { verb: string; detail: string } | null;
  /** The floor it is on, when not the overview's (`Floor 2`, or the floor's name outside this building). */
  floor: string | null;
}

/** An orchestrator on another floor, over the freelancers of it that are here. */
export interface OverviewGhostRow {
  kind: 'ghost';
  key: string;
  id: string;
  name: string;
  floor: string;
}

export interface OverviewUnlinkedRow {
  kind: 'unlinked';
  /** `unlinked` on a floor's page; `unlinked:<floor id>` on the all-floors page (#188), one group per floor. */
  key: string;
}

/**
 * #24: a native child agent (a Claude Code subagent, a Codex child thread) of the worker it is nested under: a
 * conversation inside that worker, not a desk. Its times are the provider's clock (`Child`), never the bridge's.
 */
export interface OverviewChildRow {
  kind: 'child';
  /** `child:<row id>` (the bridge's row id never changes for the life of the row). */
  key: string;
  id: string;
  /** The worker that owns it: activating the row goes there until #26 opens the child's own transcript. */
  workerId: string;
  provider: string;
  /** Its name, else its type, else `Subagent`. */
  name: string;
  /** Its type when the name is something else (Codex: the role beside the nickname). */
  type: string | null;
  description: string | null;
  state: ChildState;
  /**
   * Shown directly under its worker with no parent known (`parent: 'unresolved'`, or a parent the list does not have):
   * never drawn as if the worker started it.
   */
  unresolved: boolean;
  startedAt: number | null;
  endedAt: number | null;
  lastActivityAt: number | null;
  transcript: ChildTranscript;
}

export type OverviewRow = OverviewWorkerRow | OverviewGhostRow | OverviewUnlinkedRow | OverviewChildRow;

/** #188: a floor of the all-floors page, over its workers. */
export interface OverviewFloorRow {
  kind: 'floor';
  /** `floor:<floor id>` (the collapse key too; a real floor's id is its session's name, as before #58). */
  key: string;
  /** #58: the floor id. */
  floor: string;
  /** #58: the floor's name. */
  name: string;
  /** `Floor 2 · Work`, or the floor's name for a floor in the unassigned lot. */
  label: string;
  /** The top bar's numbers for that floor (`countItems`). */
  counts: CountItem[];
  asleep: boolean;
  /** Its workers (those the tree nests under an orchestrator on another floor included). */
  total: number;
}

/** Any row a page shows: the all-floors page adds the floors. */
export type OverviewAnyRow = OverviewRow | OverviewFloorRow;

export interface OverviewNode {
  row: OverviewRow;
  /**
   * Nested nodes: an orchestrator's freelancers, a ghost's, the Unlinked group's; (#24) a worker's native children after
   * those, and a child's own children. Empty for everyone else.
   */
  children: OverviewNode[];
}

export interface OverviewTree {
  /** #58: the floor id. */
  floor: string;
  nodes: OverviewNode[];
  /** Worker rows in the tree (#24: never its children). */
  total: number;
}

/** #188: a floor of the all-floors tree and its own tree under it (no ghosts: see `buildCityOverview`). */
export interface CityFloorNode {
  row: OverviewFloorRow;
  nodes: OverviewNode[];
}

/** #188: the all-floors overview: every floor of the city, in order, each over its workers. */
export interface CityOverviewTree {
  floors: CityFloorNode[];
  /** Worker rows in the tree: every worker of the city, once. */
  total: number;
}

/** What the tree reads of the world (`WorldStore` fits). */
export interface OverviewSource {
  readonly workers: ReadonlyMap<string, Worker>;
  workerView(id: string): WorkerView | null;
  floorView(floor: string): { workers: WorkerView[]; floor: { building: string | null } } | null;
  level(floor: string): { number: number; count: number } | null;
  /** #58: keyed by floor id. */
  readonly floors: ReadonlyMap<string, Pick<Floor, 'building' | 'session' | 'name' | 'virtual' | 'id'>>;
  /** #229: the bridge's harness catalog, for the models' readable names (`model_labels`). */
  readonly hireOptions: HireOptions;
  /** #24: each worker's native children (`WorldStore.children`, a `ChildBook`). */
  readonly children: { of(workerId: string): readonly Child[] };
}

/** #188: what the all-floors tree reads besides (`WorldStore` fits). */
export interface CityOverviewSource extends OverviewSource {
  city(): BuildingView[];
}

const ROLE_RANK: Record<string, number> = { code: 0, review: 1, ux: 2, ground: 3 };

const byDesk = (a: WorkerView, b: WorkerView) => a.desk - b.desk || a.worker.id.localeCompare(b.worker.id);
const freelancerOrder = (a: WorkerView, b: WorkerView) =>
  (a.crew?.round ?? 0) - (b.crew?.round ?? 0) || (ROLE_RANK[a.crew?.role ?? ''] ?? 9) - (ROLE_RANK[b.crew?.role ?? ''] ?? 9) || byDesk(a, b);

const STATES: readonly string[] = ['pending', 'retrying', 'failed'];

/**
 * A well-formed status of a line (unknown shapes are no status): of a fallback, or (#198) of a model's now line whose
 * refresh failed (`retrying`, `failed`: a model's line is never shown as pending, and its task line has none).
 */
function statusOf(v: unknown, source: string, kind: 'task' | 'now'): DigestLineStatus | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.state !== 'string' || !STATES.includes(o.state)) return null;
  if (source === 'llm' && (kind === 'task' || o.state === 'pending')) return null;
  return {
    state: o.state as DigestLineStatus['state'],
    ...(typeof o.reason === 'string' && o.reason ? { reason: o.reason } : {}),
    ...(typeof o.attempts === 'number' && o.attempts > 0 ? { attempts: o.attempts } : {}),
    ...(typeof o.retry_at === 'number' && o.retry_at > 0 ? { retry_at: o.retry_at } : {}),
  };
}

function line(text: string | undefined | null, source: string | undefined, status: unknown, kind: 'task' | 'now'): OverviewLine | null {
  const t = text?.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const s = (source ?? '') as LineSource;
  const st = statusOf(status, s, kind);
  return { text: t, source: s, llm: s === 'llm', ...(st ? { status: st } : {}) };
}

/** A worker's ticket: its run's issue (`#123 · title`) or board card. */
function ticketOf(w: Worker, ticket: string | null): OverviewTicket | null {
  const i = w.issue;
  const item = w.work_item;
  // #184: a Kaneo task has no GitHub number: its readable key (HRD-12), never a made-up "#".
  const key = i && typeof i.number === 'number' ? `#${i.number}` : item?.key?.trim() || ticket;
  if (!key) return null;
  return {
    key,
    title: i?.title?.trim() || item?.title?.trim() || null,
    item: item?.id ? { floor: floorOf(w), id: item.id } : null,
    url: i?.url || item?.url || null,
  };
}

const ticketId = (t: OverviewTicket | null) => (t ? (t.item?.id ?? t.key) : null);

/** The now line: a finished freelancer's report summary, else the digest's (the recap, the worker's title, the LLM's). */
function nowOf(v: WorkerView): OverviewLine | null {
  if (v.crew?.freelancer && v.crew.summary) return { text: v.crew.summary, source: 'report', llm: false };
  const d = v.worker.digest;
  if (!d || typeof d !== 'object') return null;
  if (d.now_source === 'title') return line(v.worker.title, 'title', d.now_status, 'now');
  const l = line(d.now, d.now_source, d.now_status, 'now');
  if (l?.llm && typeof d.now_at === 'number' && d.now_at > 0) l.at = d.now_at;
  return l;
}

export function overviewRow(v: WorkerView, floorTag: string | null, options: HireOptions = {}): OverviewWorkerRow {
  const w = v.worker;
  const crew = v.crew ?? null;
  const act = activityOf(w);
  const d = w.digest && typeof w.digest === 'object' ? w.digest : null;
  return {
    kind: 'worker',
    key: w.id,
    id: w.id,
    floorId: w.floor,
    name: v.name,
    display: v.display,
    since: v.since,
    harness: v.harness ?? null,
    model: modelText(v.harness, w.model, w.effort, options),
    role: crew?.role ?? null,
    tag: crew?.tag ?? null,
    runColor: crew?.runColor ?? null,
    orch: crew?.role === 'orch' ? { round: crew.round, overCap: crew.overCap } : null,
    ticket: crew ? ticketOf(w, crew.ticket) : null,
    task: crew ? null : line(d?.task, d?.task_source, d?.task_status, 'task'),
    now: nowOf(v),
    activity: act ? `${ACTIVITY_WORD[act.kind]}${act.detail ? ` · ${act.detail}` : ''}` : null,
    act: act ? { verb: ACTIVITY_WORD[act.kind], detail: act.detail } : null,
    floor: floorTag,
  };
}

/** #24: a native child's row; `top`: it is at the top of its worker's tree (the root's, or no parent known). */
export function childRow(c: Child, top: boolean): OverviewChildRow {
  const name = c.name ?? c.type ?? 'Subagent';
  return {
    kind: 'child',
    key: `child:${c.id}`,
    id: c.id,
    workerId: c.worker_id,
    provider: c.provider,
    name,
    type: c.type && c.type !== name ? c.type : null,
    description: c.description?.replace(/\s+/g, ' ').trim() || null,
    state: c.state,
    // childTree puts a child whose parent it lacks (or one in a cycle) at the top too: unresolved, whatever its field says.
    unresolved: top && c.parent !== 'root',
    startedAt: c.started_at ?? null,
    endedAt: c.ended_at ?? null,
    lastActivityAt: c.last_activity_at ?? null,
    transcript: c.transcript,
  };
}

/** #24: a worker's native children as nodes, in `childTree`'s order (deterministic, cycle-safe). */
function childNodes(src: OverviewSource, workerId: string): OverviewNode[] {
  const nodes = (t: ChildTreeNode[], top: boolean): OverviewNode[] => t.map((n) => ({ row: childRow(n.child, top), children: nodes(n.children, false) }));
  return nodes(childTree(src.children.of(workerId)), true);
}

/** #24: a worker's node: its freelancers' nodes (an orchestrator's), then its own native children. */
const workerNode = (src: OverviewSource, row: OverviewWorkerRow, crew: OverviewWorkerRow[] = []): OverviewNode => ({
  row,
  children: [...crew.map((r) => workerNode(src, r)), ...childNodes(src, row.id)],
});

/** A floor's name beside a row: `Floor 2` in the overview's building, else its name (the project name you know). */
function floorLabel(src: OverviewSource, here: string, floor: string): string {
  const lv = src.level(floor);
  const same = src.floors.get(here)?.building ?? null;
  return lv && same !== null && src.floors.get(floor)?.building === same ? `Floor ${lv.number}` : floorNameOf(src.floors, floor);
}

export function buildOverview(src: OverviewSource, floor: string): OverviewTree {
  const fv = src.floorView(floor);
  const here = fv ? [...fv.workers].sort(byDesk) : [];
  const orchs = here.filter((v) => v.crew?.role === 'orch');
  const orchIds = new Set(orchs.map((v) => v.worker.id));
  const freelancers = here.filter((v) => v.crew?.freelancer);
  const employees = here.filter((v) => !v.crew || (!v.crew.freelancer && v.crew.role !== 'orch'));

  // Freelancers on other floors whose orchestrator is here.
  const away: WorkerView[] = [];
  for (const w of src.workers.values()) {
    if (floorOf(w) === floor || !w.orch_id || !orchIds.has(w.orch_id)) continue;
    const v = src.workerView(w.id);
    if (v?.crew?.freelancer) away.push(v);
  }

  const nodes: OverviewNode[] = [];
  let total = 0;
  const rowOf = (v: WorkerView) => {
    total++;
    return overviewRow(v, v.worker.floor === floor ? null : floorLabel(src, floor, v.worker.floor), src.hireOptions);
  };
  const nested = (vs: WorkerView[], parent: OverviewTicket | null) =>
    vs.sort(freelancerOrder).map((v) => {
      const r = rowOf(v);
      if (parent && ticketId(r.ticket) === ticketId(parent)) r.ticket = null;
      return r;
    });

  for (const o of orchs) {
    const head = rowOf(o);
    const mine = [...freelancers, ...away].filter((v) => v.crew?.orchId === o.worker.id);
    nodes.push(workerNode(src, head, nested(mine, head.ticket)));
  }
  // Ghosts: orchestrators elsewhere, in the order of their first freelancer here.
  const ghosts = new Map<string, WorkerView[]>();
  const unlinked: WorkerView[] = [];
  for (const v of freelancers) {
    const oid = v.crew?.orchId ?? null;
    if (oid && orchIds.has(oid)) continue;
    const ov = oid ? src.workerView(oid) : null;
    if (oid && ov && ov.worker.floor !== floor) ghosts.set(oid, [...(ghosts.get(oid) ?? []), v]);
    else unlinked.push(v);
  }
  for (const [oid, vs] of ghosts) {
    const ov = src.workerView(oid);
    if (!ov) continue;
    const head: OverviewGhostRow = { kind: 'ghost', key: `ghost:${oid}`, id: oid, name: ov.name, floor: floorLabel(src, floor, ov.worker.floor) };
    nodes.push({ row: head, children: nested(vs, ticketOf(ov.worker, ov.crew?.ticket ?? null)).map((r) => workerNode(src, r)) });
  }
  if (unlinked.length) nodes.push({ row: { kind: 'unlinked', key: 'unlinked' }, children: nested(unlinked, null).map((r) => workerNode(src, r)) });
  for (const v of employees) nodes.push(workerNode(src, rowOf(v)));
  return { floor, nodes, total };
}

/**
 * #188: the all-floors overview. Floors in the city's order: buildings by `sort`, each building's floors **top floor
 * first** (the Buildings panel's `stack` order; `WorldStore.city()` gives them ground first), then the unassigned lot.
 * Under each floor its tree as `buildOverview` builds it, with one rule so that every worker appears exactly once: a
 * freelancer sits under its orchestrator, on the orchestrator's floor, tagged with its own floor when that is another;
 * there are no ghost rows; a floor's Unlinked group (`unlinked:<floor id>`) holds only its freelancers whose
 * orchestrator is truly gone (or none, or not an orchestrator).
 */
export function buildCityOverview(src: CityOverviewSource): CityOverviewTree {
  const floors = src.city().flatMap((b) => (b.building ? [...b.floors].reverse() : b.floors));
  const everyone = floors.flatMap((f) => f.workers);
  const orchIds = new Set(everyone.filter((v) => v.crew?.role === 'orch').map((v) => v.worker.id));
  const freelancers = everyone.filter((v) => v.crew?.freelancer);
  let total = 0;
  const out: CityFloorNode[] = [];
  for (const f of floors) {
    const floor = f.id;
    const here = [...f.workers].sort(byDesk);
    const rowOf = (v: WorkerView) => {
      total++;
      return overviewRow(v, v.worker.floor === floor ? null : floorLabel(src, floor, v.worker.floor), src.hireOptions);
    };
    const nested = (vs: WorkerView[], parent: OverviewTicket | null) =>
      vs.sort(freelancerOrder).map((v) => {
        const r = rowOf(v);
        if (parent && ticketId(r.ticket) === ticketId(parent)) r.ticket = null;
        return r;
      });
    const nodes: OverviewNode[] = [];
    for (const o of here.filter((v) => v.crew?.role === 'orch')) {
      const head = rowOf(o);
      nodes.push(workerNode(src, head, nested(freelancers.filter((v) => v.crew?.orchId === o.worker.id), head.ticket)));
    }
    const unlinked = here.filter((v) => v.crew?.freelancer && !(v.crew.orchId && orchIds.has(v.crew.orchId)));
    if (unlinked.length) nodes.push({ row: { kind: 'unlinked', key: `unlinked:${floor}` }, children: nested(unlinked, null).map((r) => workerNode(src, r)) });
    for (const v of here.filter((v) => !v.crew || (!v.crew.freelancer && v.crew.role !== 'orch'))) nodes.push(workerNode(src, rowOf(v)));
    out.push({ row: floorRow(f), nodes });
  }
  return { floors: out, total };
}

/** #188: a floor's row on the all-floors page. */
function floorRow(f: FloorView): OverviewFloorRow {
  return {
    kind: 'floor',
    key: `floor:${f.id}`,
    floor: f.id,
    name: f.name,
    label: f.level ? `Floor ${f.level.number} · ${f.building?.name ?? ''}` : f.name,
    counts: countItems(f.counts, f.asleep),
    asleep: f.asleep,
    total: f.workers.length,
  };
}

/** #188: the floors that start collapsed on the all-floors page: the asleep ones (the viewer can open them). */
export function sleepyFloors(t: CityOverviewTree): string[] {
  return t.floors.filter((f) => f.row.asleep).map((f) => f.row.key);
}

/** #24: a child that has ended: completed, shut down or interrupted (idle is reusable, unknown is no evidence). */
export const childEnded = (s: ChildState): boolean => s === 'completed' || s === 'shut_down' || s === 'interrupted';

/**
 * #24: the child groups that start collapsed, on the page and the wall: an ended child's own children (its work is
 * done, so a long finished tree folds into its row); the viewer can open them on the page. Every other group starts
 * expanded, a worker's children included.
 */
export function endedChildGroups(t: OverviewTree | CityOverviewTree): string[] {
  const out: string[] = [];
  const walk = (ns: readonly OverviewNode[]) => {
    for (const n of ns) {
      if (n.row.kind === 'child' && n.children.length && childEnded(n.row.state)) out.push(n.row.key);
      walk(n.children);
    }
  };
  walk('floors' in t ? t.floors.flatMap((f) => f.nodes) : t.nodes);
  return out;
}

/** #24: every node of the tree at any depth, in reading order (the floors of the all-floors tree are not nodes). */
export function allNodes(t: OverviewTree | CityOverviewTree): OverviewNode[] {
  const out: OverviewNode[] = [];
  const walk = (ns: readonly OverviewNode[]) => {
    for (const n of ns) {
      out.push(n);
      walk(n.children);
    }
  };
  walk('floors' in t ? t.floors.flatMap((f) => f.nodes) : t.nodes);
  return out;
}

/** #188: the whole system's numbers: the awake floors' counts summed, then every worker of an asleep floor as asleep. */
export function cityCountItems(floors: readonly FloorView[]): CountItem[] {
  const sum: Counts = { working: 0, needsYou: 0, idle: 0, done: 0, waiting: 0, total: 0 };
  let asleep = 0;
  for (const f of floors) {
    if (f.asleep) {
      asleep += f.counts.total;
      continue;
    }
    sum.working += f.counts.working;
    sum.needsYou += f.counts.needsYou;
    sum.idle += f.counts.idle;
    sum.done += f.counts.done;
    sum.waiting += f.counts.waiting;
    sum.total += f.counts.total;
  }
  return [...countItems(sum, false), ...(asleep ? [{ kind: 'asleep' as const, n: asleep, label: 'asleep' }] : [])];
}

// ---- #188: the filter ---------------------------------------------------------------------------------

/** Active: working, needs you, waiting. Idle (done included) and asleep are not. */
export const isActive = (d: Display): boolean => d === 'working' || d === 'needs_you' || d === 'waiting';

/** What "active only" left out. Floors' workers are counted too (as idle or asleep). */
export interface HiddenCounts {
  idle: number;
  asleep: number;
  floors: number;
  asleepFloors: number;
  /** The asleep workers (of `asleep`) whose whole floor went with them: the `floors asleep` part says them. */
  asleepOnFloors: number;
  /** #24: native children hidden (never counted as workers). */
  subagents: number;
}

/** #24: a row the filter keeps for itself: an active worker, a running child. */
const rowActive = (r: OverviewRow): boolean => (r.kind === 'worker' && isActive(r.display)) || (r.kind === 'child' && r.state === 'running');

function filterNodes(nodes: readonly OverviewNode[], h: HiddenCounts): OverviewNode[] {
  const out: OverviewNode[] = [];
  for (const n of nodes) {
    const children = filterNodes(n.children, h);
    const r = n.row;
    if (rowActive(r) || children.length) out.push({ row: r, children });
    else if (r.kind === 'worker') {
      if (r.display === 'asleep') h.asleep++;
      else h.idle++;
    } else if (r.kind === 'child') h.subagents++;
  }
  return out;
}

/**
 * Active only: the active workers and every row above one (an idle orchestrator over a working freelancer, a floor
 * with anyone active); the rest go and are counted. The order is the tree's, and `total` stays the unfiltered one.
 * #24: a running child is active too and keeps every row above it (an idle worker whose subagent still runs); any
 * other child goes, with its worker or alone, counted as a subagent, never as an idle or asleep worker.
 */
export function filterOverview<T extends OverviewTree | CityOverviewTree>(t: T): { tree: T; hidden: HiddenCounts } {
  const hidden: HiddenCounts = { idle: 0, asleep: 0, floors: 0, asleepFloors: 0, asleepOnFloors: 0, subagents: 0 };
  if (!('floors' in t)) return { tree: { ...t, nodes: filterNodes(t.nodes, hidden) }, hidden };
  const floors: CityFloorNode[] = [];
  for (const f of t.floors) {
    const asleep = hidden.asleep;
    const nodes = filterNodes(f.nodes, hidden);
    if (nodes.length) floors.push({ row: f.row, nodes });
    else {
      hidden.floors++;
      if (f.row.asleep) {
        hidden.asleepFloors++;
        hidden.asleepOnFloors += hidden.asleep - asleep;
      }
    }
  }
  return { tree: { ...t, floors }, hidden };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The header's line of what the filter hides (`12 idle hidden · 3 floors asleep`); empty when nothing is. #24: then the
 * subagents (`4 subagents hidden`), apart from the workers.
 */
export function hiddenText(h: HiddenCounts, view: 'city' | 'floor'): string {
  const parts: string[] = [];
  if (h.idle) parts.push(`${h.idle} idle hidden`);
  const subagents = h.subagents ? [`${plural(h.subagents, 'subagent', 'subagents')} hidden`] : [];
  if (view === 'floor') {
    if (h.asleep) parts.push(`${h.asleep} asleep hidden`);
    return [...parts, ...subagents].join(' · ');
  }
  // Asleep workers under a floor that still shows (an active freelancer keeps their orchestrator's asleep floor up).
  const asleep = h.asleep - h.asleepOnFloors;
  if (asleep) parts.push(`${asleep} asleep hidden`);
  if (h.asleepFloors) parts.push(plural(h.asleepFloors, 'floor asleep', 'floors asleep'));
  // Floors with nobody on them: said only when no idle or asleep worker already explains a hidden floor.
  const quiet = h.floors - h.asleepFloors;
  if (quiet && !h.idle && !asleep) parts.push(plural(quiet, 'quiet floor hidden', 'quiet floors hidden'));
  return [...parts, ...subagents].join(' · ');
}

/** What the page and the wall show of a floor, read again on every change. */
export interface OverviewData {
  tree: OverviewTree;
  /** `Floor 3 of 3 · Work`. */
  where: string;
  counts: CountItem[];
  asleep: boolean;
}

/** #188: what the all-floors page shows, read again on every change. */
export interface CityOverviewData {
  tree: CityOverviewTree;
  /** `5 floors in 2 buildings`. */
  where: string;
  /** The whole system's numbers (`cityCountItems`), never filtered. */
  counts: CountItem[];
}

/** The working light's blink period, on the page and the wall: the transcript's busy dot's rhythm (`tx-pulse`). */
export const BLINK_MS = 1100;

/** A row as shown: its depth, and whether it has children and they show. */
export interface VisibleRow {
  row: OverviewAnyRow;
  /**
   * 0 at the top of a floor's page, 1 under it, and so on (#24: a native child under a freelancer is at 2, its own
   * child at 3, …); the all-floors page puts its floors at 0, so everything else is one deeper (#188).
   */
  depth: number;
  /** The key of the group it is nested in. */
  parent: string | null;
  expandable: boolean;
  expanded: boolean;
  /**
   * #24: the tree's wires: for each level from 1 down to the row's own (`depth` entries), whether the row's ancestor at
   * that level (at its own: the row) has a sibling after it, so that level's line runs on below the row.
   */
  more: boolean[];
}

/** The rows in reading order, a collapsed group's children left out (a collapsed floor's whole tree, #188), at any depth. */
export function visibleRows(t: OverviewTree | CityOverviewTree, collapsed: ReadonlySet<string>): VisibleRow[] {
  const out: VisibleRow[] = [];
  const nodes = (ns: readonly OverviewNode[], depth: number, parent: string | null, more: boolean[]) => {
    ns.forEach((n, i) => {
      const expandable = n.children.length > 0;
      const expanded = expandable && !collapsed.has(n.row.key);
      const m = depth ? [...more, i < ns.length - 1] : [];
      out.push({ row: n.row, depth, parent, expandable, expanded, more: m });
      if (expanded) nodes(n.children, depth + 1, n.row.key, m);
    });
  };
  if (!('floors' in t)) {
    nodes(t.nodes, 0, null, []);
    return out;
  }
  for (const f of t.floors) {
    const expandable = f.nodes.length > 0;
    const expanded = expandable && !collapsed.has(f.row.key);
    out.push({ row: f.row, depth: 0, parent: null, expandable, expanded, more: [] });
    if (expanded) nodes(f.nodes, 1, f.row.key, []);
  }
  return out;
}

export interface CountItem {
  kind: Display;
  n: number;
  label: string;
}

/** The top bar's counts (`Hud.setCounts`): working, need(s) you, waiting while any are, idle (done included); asleep alone. */
export function countItems(c: Counts, asleep: boolean): CountItem[] {
  if (asleep) return [{ kind: 'asleep', n: c.total, label: 'asleep' }];
  return [
    { kind: 'working', n: c.working, label: 'working' },
    { kind: 'needs_you', n: c.needsYou, label: c.needsYou === 1 ? 'needs you' : 'need you' },
    ...(c.waiting > 0 ? [{ kind: 'waiting' as const, n: c.waiting, label: 'waiting' }] : []),
    { kind: 'idle', n: c.idle, label: 'idle' },
  ];
}

/** A time span in the overview's words: `<1m`, `4m`, `2h 05m`, `3d` (a negative one is `<1m`). */
export function spanText(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  return m < 1 ? '<1m' : m < 60 ? `${m}m` : m < 24 * 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${Math.floor(m / 1440)}d`;
}

/** `working 4m`: the status and how long it has held (`<1m`, `4m`, `2h 05m`, `3d`). */
export function sinceText(d: Display, since: number, now: number): string {
  return `${STATUS_WORD[d]} ${spanText(now - since)}`;
}

/** #24: a child's state in words: the six kept apart, and `unknown` said as such (never a guess at one of the others). */
export const CHILD_STATE_WORD: Record<ChildState, string> = {
  running: 'running',
  completed: 'completed',
  idle: 'idle',
  shut_down: 'shut down',
  interrupted: 'interrupted',
  unknown: 'state unknown',
};

/** #24: whether a child's transcript can be opened (#26), is expected, or none is known. */
export const CHILD_TRANSCRIPT_WORD: Record<ChildTranscript, string> = {
  available: 'transcript available',
  pending: 'transcript pending',
  unavailable: 'no transcript',
};

/**
 * #24: a child's state and its time where one means something: running, since it started (`4m`); idle, since its last
 * activity; ended, how long it ran (`in 3m`, `after 3m`), else how long ago it ended (`4m ago`); no time when it is not
 * known, and none for `unknown`. Its times are the provider's clock.
 */
export function childSince(r: Pick<OverviewChildRow, 'state' | 'startedAt' | 'endedAt' | 'lastActivityAt'>, now: number): { word: string; time: string | null } {
  const word = CHILD_STATE_WORD[r.state];
  if (r.state === 'running') return { word, time: r.startedAt ? spanText(now - r.startedAt) : null };
  if (r.state === 'idle') return { word, time: r.lastActivityAt ? spanText(now - r.lastActivityAt) : null };
  if (!childEnded(r.state)) return { word, time: null };
  if (r.startedAt && r.endedAt) return { word, time: `${r.state === 'completed' ? 'in' : 'after'} ${spanText(r.endedAt - r.startedAt)}` };
  return { word, time: r.endedAt ? ageText(r.endedAt, now) : null };
}

/** #24: `childSince` as one line: `running 4m`, `completed in 3m`, `state unknown`. */
export function childSinceText(r: Pick<OverviewChildRow, 'state' | 'startedAt' | 'endedAt' | 'lastActivityAt'>, now: number): string {
  const s = childSince(r, now);
  return s.time ? `${s.word} ${s.time}` : s.word;
}

/** #198: how long ago something was written: `just now`, `4m ago`, `2h 05m ago`, `3d ago`. */
export function ageText(at: number, now: number): string {
  const t = spanText(now - at);
  return t === '<1m' ? 'just now' : `${t} ago`;
}

/**
 * #198, #232: what a model's line is, in full (its sparkle's tooltip and its words for a screen reader): a now line sums
 * up the recent activity and says when it was written; a task line (no time) what the worker was asked.
 */
export function aiTitle(l: OverviewLine, now: number, kind: 'task' | 'now' = 'now'): string {
  if (kind === 'task') return 'AI-generated summary of what this worker was asked to do.';
  const what = 'AI-generated summary of this worker’s recent activity (its last 5 steps)';
  return l.at ? `${what}; generated ${ageText(l.at, now)}. The time is when the summary was written, not when the activity happened.` : `${what}.`;
}
