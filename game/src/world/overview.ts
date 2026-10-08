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
 */

import type { DigestLineStatus, Worker } from '../net/protocol';
import { ACTIVITY_WORD, activityOf } from './activity';
import { passWords, type CrewRole } from './crew';
import { modelLabel, STATUS_WORD, type Display } from './derive';
import type { BuildingView, Counts, FloorView, WorkerView } from './store';

/** Where a task or now line came from (docs/protocol.md "Floor overview digest"); `report` is a freelancer's summary. */
export type LineSource = 'ai_title' | 'prompt' | 'recap' | 'title' | 'report' | 'llm';

export interface OverviewLine {
  text: string;
  source: LineSource;
  /** Written by the configured LLM (a later phase): the page marks it. */
  llm: boolean;
  /** #174: the model's line is awaited or failed while this fallback shows (pending, retrying, failed); absent otherwise. */
  status?: DigestLineStatus;
  /** #198: a model's now line: when it was written (unix ms, bridge clock: `now_at`), not when the activity it sums up happened. */
  at?: number;
}

export interface OverviewTicket {
  /** `#123`, else the run's ticket field. */
  key: string;
  title: string | null;
  /** The board card it opens (`boardsPanel.openItem('issues', session, id)`); null when the bridge knows none. */
  item: { session: string; id: string } | null;
  /** The issue's page, as the bridge sent it (the game never builds one). */
  url: string | null;
}

export interface OverviewWorkerRow {
  kind: 'worker';
  key: string;
  id: string;
  session: string;
  name: string;
  display: Display;
  /** When the current status began (unix ms). */
  since: number;
  harness: string | null;
  /** `claude opus-5-5 high`. */
  model: string;
  role: CrewRole | null;
  /** The role chip: `ORCH`, `CODE r2`. */
  tag: string | null;
  runColor: number | null;
  /** Orchestrators: the phase in words, the round, the pass in words (`pass 2 of 3`), over the pass cap. */
  orch: { phase: string | null; round: number | null; pass: string | null; overCap: boolean } | null;
  ticket: OverviewTicket | null;
  /** One-off workers (no run): what they were asked to do. */
  task: OverviewLine | null;
  /** What it does now (only once a turn of it was read). */
  now: OverviewLine | null;
  /** The live activity chip, `Testing · pytest` (#98). */
  activity: string | null;
  /** The floor it is on, when not the overview's (`Floor 2`, or the session outside this building). */
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
  /** `unlinked` on a floor's page; `unlinked:<session>` on the all-floors page (#188), one group per floor. */
  key: string;
}

export type OverviewRow = OverviewWorkerRow | OverviewGhostRow | OverviewUnlinkedRow;

/** #188: a floor of the all-floors page, over its workers. */
export interface OverviewFloorRow {
  kind: 'floor';
  /** `floor:<session>` (the collapse key too). */
  key: string;
  session: string;
  /** `Floor 2 · Work`, or the session for a floor in the unassigned lot. */
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
  /** Nested rows (an orchestrator's freelancers, a ghost's, the Unlinked group's); empty for everyone else. */
  children: OverviewWorkerRow[];
}

export interface OverviewTree {
  session: string;
  nodes: OverviewNode[];
  /** Worker rows in the tree. */
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
  floorView(session: string): { workers: WorkerView[]; floor: { building: string | null } } | null;
  level(session: string): { number: number; count: number } | null;
  readonly floors: ReadonlyMap<string, { building: string | null }>;
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

/** A well-formed status of a line that is not the model's (unknown shapes are no status). */
function statusOf(v: unknown, source: string): DigestLineStatus | null {
  if (source === 'llm' || typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.state !== 'string' || !STATES.includes(o.state)) return null;
  return {
    state: o.state as DigestLineStatus['state'],
    ...(typeof o.reason === 'string' && o.reason ? { reason: o.reason } : {}),
    ...(typeof o.attempts === 'number' && o.attempts > 0 ? { attempts: o.attempts } : {}),
    ...(typeof o.retry_at === 'number' && o.retry_at > 0 ? { retry_at: o.retry_at } : {}),
  };
}

function line(text: string | undefined | null, source: string | undefined, status?: unknown): OverviewLine | null {
  const t = text?.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const s = (source ?? '') as LineSource;
  const st = statusOf(status, s);
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
    item: item?.id ? { session: w.session, id: item.id } : null,
    url: i?.url || item?.url || null,
  };
}

const ticketId = (t: OverviewTicket | null) => (t ? (t.item?.id ?? t.key) : null);

/** The now line: a finished freelancer's report summary, else the digest's (the recap, the worker's title, the LLM's). */
function nowOf(v: WorkerView): OverviewLine | null {
  if (v.crew?.freelancer && v.crew.summary) return { text: v.crew.summary, source: 'report', llm: false };
  const d = v.worker.digest;
  if (!d || typeof d !== 'object') return null;
  if (d.now_source === 'title') return line(v.worker.title, 'title', d.now_status);
  const l = line(d.now, d.now_source, d.now_status);
  if (l?.llm && typeof d.now_at === 'number' && d.now_at > 0) l.at = d.now_at;
  return l;
}

export function overviewRow(v: WorkerView, floorTag: string | null): OverviewWorkerRow {
  const w = v.worker;
  const crew = v.crew ?? null;
  const act = activityOf(w);
  const d = w.digest && typeof w.digest === 'object' ? w.digest : null;
  return {
    kind: 'worker',
    key: w.id,
    id: w.id,
    session: w.session,
    name: v.name,
    display: v.display,
    since: v.since,
    harness: v.harness ?? null,
    model: modelLabel(v.harness, w.model, w.effort),
    role: crew?.role ?? null,
    tag: crew?.tag ?? null,
    runColor: crew?.runColor ?? null,
    orch: crew?.role === 'orch' ? { phase: crew.phase, round: crew.round, pass: passWords(crew.pass ?? undefined), overCap: crew.overCap } : null,
    ticket: crew ? ticketOf(w, crew.ticket) : null,
    task: crew ? null : line(d?.task, d?.task_source, d?.task_status),
    now: nowOf(v),
    activity: act ? `${ACTIVITY_WORD[act.kind]}${act.detail ? ` · ${act.detail}` : ''}` : null,
    floor: floorTag,
  };
}

/** An orchestrator's run in words, for its meta line: `waiting for you`, `round 2`, `pass 3 of 3` (over cap is a chip). */
export function orchWords(o: OverviewWorkerRow['orch']): string[] {
  if (!o) return [];
  return [o.phase, o.round ? `round ${o.round}` : null, o.pass].filter((x): x is string => !!x);
}

/** A floor's name beside a row: `Floor 2` in the overview's building, else its session (the project name you know). */
function floorLabel(src: OverviewSource, here: string, session: string): string {
  const lv = src.level(session);
  const same = src.floors.get(here)?.building ?? null;
  return lv && same !== null && src.floors.get(session)?.building === same ? `Floor ${lv.number}` : session;
}

export function buildOverview(src: OverviewSource, session: string): OverviewTree {
  const fv = src.floorView(session);
  const here = fv ? [...fv.workers].sort(byDesk) : [];
  const orchs = here.filter((v) => v.crew?.role === 'orch');
  const orchIds = new Set(orchs.map((v) => v.worker.id));
  const freelancers = here.filter((v) => v.crew?.freelancer);
  const employees = here.filter((v) => !v.crew || (!v.crew.freelancer && v.crew.role !== 'orch'));

  // Freelancers on other floors whose orchestrator is here.
  const away: WorkerView[] = [];
  for (const w of src.workers.values()) {
    if (w.session === session || !w.orch_id || !orchIds.has(w.orch_id)) continue;
    const v = src.workerView(w.id);
    if (v?.crew?.freelancer) away.push(v);
  }

  const nodes: OverviewNode[] = [];
  let total = 0;
  const rowOf = (v: WorkerView) => {
    total++;
    return overviewRow(v, v.worker.session === session ? null : floorLabel(src, session, v.worker.session));
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
    nodes.push({ row: head, children: nested(mine, head.ticket) });
  }
  // Ghosts: orchestrators elsewhere, in the order of their first freelancer here.
  const ghosts = new Map<string, WorkerView[]>();
  const unlinked: WorkerView[] = [];
  for (const v of freelancers) {
    const oid = v.crew?.orchId ?? null;
    if (oid && orchIds.has(oid)) continue;
    const ov = oid ? src.workerView(oid) : null;
    if (oid && ov && ov.worker.session !== session) ghosts.set(oid, [...(ghosts.get(oid) ?? []), v]);
    else unlinked.push(v);
  }
  for (const [oid, vs] of ghosts) {
    const ov = src.workerView(oid);
    if (!ov) continue;
    const head: OverviewGhostRow = { kind: 'ghost', key: `ghost:${oid}`, id: oid, name: ov.name, floor: floorLabel(src, session, ov.worker.session) };
    nodes.push({ row: head, children: nested(vs, ticketOf(ov.worker, ov.crew?.ticket ?? null)) });
  }
  if (unlinked.length) nodes.push({ row: { kind: 'unlinked', key: 'unlinked' }, children: nested(unlinked, null) });
  for (const v of employees) nodes.push({ row: rowOf(v), children: [] });
  return { session, nodes, total };
}

/**
 * #188: the all-floors overview. Floors in the city's order: buildings by `sort`, each building's floors **top floor
 * first** (the Buildings panel's `stack` order; `WorldStore.city()` gives them ground first), then the unassigned lot.
 * Under each floor its tree as `buildOverview` builds it, with one rule so that every worker appears exactly once: a
 * freelancer sits under its orchestrator, on the orchestrator's floor, tagged with its own floor when that is another;
 * there are no ghost rows; a floor's Unlinked group (`unlinked:<session>`) holds only its freelancers whose
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
    const session = f.session;
    const here = [...f.workers].sort(byDesk);
    const rowOf = (v: WorkerView) => {
      total++;
      return overviewRow(v, v.worker.session === session ? null : floorLabel(src, session, v.worker.session));
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
      nodes.push({ row: head, children: nested(freelancers.filter((v) => v.crew?.orchId === o.worker.id), head.ticket) });
    }
    const unlinked = here.filter((v) => v.crew?.freelancer && !(v.crew.orchId && orchIds.has(v.crew.orchId)));
    if (unlinked.length) nodes.push({ row: { kind: 'unlinked', key: `unlinked:${session}` }, children: nested(unlinked, null) });
    for (const v of here.filter((v) => !v.crew || (!v.crew.freelancer && v.crew.role !== 'orch'))) nodes.push({ row: rowOf(v), children: [] });
    out.push({ row: floorRow(f), nodes });
  }
  return { floors: out, total };
}

/** #188: a floor's row on the all-floors page. */
function floorRow(f: FloorView): OverviewFloorRow {
  return {
    kind: 'floor',
    key: `floor:${f.session}`,
    session: f.session,
    label: f.level ? `Floor ${f.level.number} · ${f.building?.name ?? ''}` : f.session,
    counts: countItems(f.counts, f.asleep),
    asleep: f.asleep,
    total: f.workers.length,
  };
}

/** #188: the floors that start collapsed on the all-floors page: the asleep ones (the viewer can open them). */
export function sleepyFloors(t: CityOverviewTree): string[] {
  return t.floors.filter((f) => f.row.asleep).map((f) => f.row.key);
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
}

function filterNodes(nodes: readonly OverviewNode[], h: HiddenCounts): OverviewNode[] {
  const hide = (r: OverviewWorkerRow) => {
    if (r.display === 'asleep') h.asleep++;
    else h.idle++;
  };
  const out: OverviewNode[] = [];
  for (const n of nodes) {
    const children: OverviewWorkerRow[] = [];
    for (const c of n.children) {
      if (isActive(c.display)) children.push(c);
      else hide(c);
    }
    const self = n.row.kind === 'worker' && isActive(n.row.display);
    if (self || children.length) out.push({ row: n.row, children });
    else if (n.row.kind === 'worker') hide(n.row);
  }
  return out;
}

/**
 * Active only: the active workers and every row above one (an idle orchestrator over a working freelancer, a floor
 * with anyone active); the rest go and are counted. The order is the tree's, and `total` stays the unfiltered one.
 */
export function filterOverview<T extends OverviewTree | CityOverviewTree>(t: T): { tree: T; hidden: HiddenCounts } {
  const hidden: HiddenCounts = { idle: 0, asleep: 0, floors: 0, asleepFloors: 0, asleepOnFloors: 0 };
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

/** The header's line of what the filter hides (`12 idle hidden · 3 floors asleep`); empty when nothing is. */
export function hiddenText(h: HiddenCounts, view: 'city' | 'floor'): string {
  const parts: string[] = [];
  if (h.idle) parts.push(`${h.idle} idle hidden`);
  if (view === 'floor') {
    if (h.asleep) parts.push(`${h.asleep} asleep hidden`);
    return parts.join(' · ');
  }
  // Asleep workers under a floor that still shows (an active freelancer keeps their orchestrator's asleep floor up).
  const asleep = h.asleep - h.asleepOnFloors;
  if (asleep) parts.push(`${asleep} asleep hidden`);
  if (h.asleepFloors) parts.push(plural(h.asleepFloors, 'floor asleep', 'floors asleep'));
  // Floors with nobody on them: said only when no idle or asleep worker already explains a hidden floor.
  const quiet = h.floors - h.asleepFloors;
  if (quiet && !h.idle && !asleep) parts.push(plural(quiet, 'quiet floor hidden', 'quiet floors hidden'));
  return parts.join(' · ');
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
  /** 0 and 1 on a floor's page; the all-floors page puts its floors at 0, so its freelancers are at 2 (#188). */
  depth: 0 | 1 | 2;
  /** The key of the group it is nested in. */
  parent: string | null;
  expandable: boolean;
  expanded: boolean;
}

/** The rows in reading order, a collapsed group's children left out (a collapsed floor's whole tree, #188). */
export function visibleRows(t: OverviewTree | CityOverviewTree, collapsed: ReadonlySet<string>): VisibleRow[] {
  const out: VisibleRow[] = [];
  const nodes = (ns: readonly OverviewNode[], depth: 0 | 1, parent: string | null) => {
    for (const n of ns) {
      const expandable = n.children.length > 0;
      const expanded = expandable && !collapsed.has(n.row.key);
      out.push({ row: n.row, depth, parent, expandable, expanded });
      if (expanded) for (const c of n.children) out.push({ row: c, depth: depth === 0 ? 1 : 2, parent: n.row.key, expandable: false, expanded: false });
    }
  };
  if (!('floors' in t)) {
    nodes(t.nodes, 0, null);
    return out;
  }
  for (const f of t.floors) {
    const expandable = f.nodes.length > 0;
    const expanded = expandable && !collapsed.has(f.row.key);
    out.push({ row: f.row, depth: 0, parent: null, expandable, expanded });
    if (expanded) nodes(f.nodes, 1, f.row.key);
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
function spanText(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  return m < 1 ? '<1m' : m < 60 ? `${m}m` : m < 24 * 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${Math.floor(m / 1440)}d`;
}

/** `working 4m`: the status and how long it has held (`<1m`, `4m`, `2h 05m`, `3d`). */
export function sinceText(d: Display, since: number, now: number): string {
  return `${STATUS_WORD[d]} ${spanText(now - since)}`;
}

/** #198: how long ago something was written: `just now`, `4m ago`, `2h 05m ago`, `3d ago`. */
export function ageText(at: number, now: number): string {
  const t = spanText(now - at);
  return t === '<1m' ? 'just now' : `${t} ago`;
}

/** #198: the AI mark of a model's line, on the page and the wall: `AI · 2m ago` with its time (a now line), else `AI`. */
export function aiLabel(l: OverviewLine, now: number): string {
  return l.at ? `AI · ${ageText(l.at, now)}` : 'AI';
}

/** #198: what a model's now line is, in full (the mark's tooltip and its words for a screen reader). */
export function aiTitle(l: OverviewLine, now: number): string {
  const what = 'Summarised by the AI model from this worker’s recent activity (its last 5 steps)';
  return l.at ? `${what} ${ageText(l.at, now)}. The time is when the summary was written, not when the activity happened.` : `${what}.`;
}
