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
import type { Counts, WorkerView } from './store';

/** Where a task or now line came from (docs/protocol.md "Floor overview digest"); `report` is a freelancer's summary. */
export type LineSource = 'ai_title' | 'prompt' | 'recap' | 'title' | 'report' | 'llm';

export interface OverviewLine {
  text: string;
  source: LineSource;
  /** Written by the configured LLM (a later phase): the page marks it. */
  llm: boolean;
  /** #174: the model's line is awaited or failed while this fallback shows (pending, retrying, failed); absent otherwise. */
  status?: DigestLineStatus;
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
  key: 'unlinked';
}

export type OverviewRow = OverviewWorkerRow | OverviewGhostRow | OverviewUnlinkedRow;

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

/** What the tree reads of the world (`WorldStore` fits). */
export interface OverviewSource {
  readonly workers: ReadonlyMap<string, Worker>;
  workerView(id: string): WorkerView | null;
  floorView(session: string): { workers: WorkerView[]; floor: { building: string | null } } | null;
  level(session: string): { number: number; count: number } | null;
  readonly floors: ReadonlyMap<string, { building: string | null }>;
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
  return line(d.now, d.now_source, d.now_status);
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

/** What the page and the wall show of a floor, read again on every change. */
export interface OverviewData {
  tree: OverviewTree;
  /** `Floor 3 of 3 · Work`. */
  where: string;
  counts: CountItem[];
  asleep: boolean;
}

/** The working light's blink period, on the page and the wall: the transcript's busy dot's rhythm (`tx-pulse`). */
export const BLINK_MS = 1100;

/** A row as shown: its depth, and whether it has children and they show. */
export interface VisibleRow {
  row: OverviewRow;
  depth: 0 | 1;
  /** The key of the group it is nested in. */
  parent: string | null;
  expandable: boolean;
  expanded: boolean;
}

/** The rows in reading order, a collapsed group's children left out. */
export function visibleRows(t: OverviewTree, collapsed: ReadonlySet<string>): VisibleRow[] {
  const out: VisibleRow[] = [];
  for (const n of t.nodes) {
    const expandable = n.children.length > 0;
    const expanded = expandable && !collapsed.has(n.row.key);
    out.push({ row: n.row, depth: 0, parent: null, expandable, expanded });
    if (expanded) for (const c of n.children) out.push({ row: c, depth: 1, parent: n.row.key, expandable: false, expanded: false });
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

/** `working 4m`: the status and how long it has held (`<1m`, `4m`, `2h 05m`, `3d`). */
export function sinceText(d: Display, since: number, now: number): string {
  const m = Math.floor(Math.max(0, now - since) / 60_000);
  const t = m < 1 ? '<1m' : m < 60 ? `${m}m` : m < 24 * 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${Math.floor(m / 1440)}d`;
  return `${STATUS_WORD[d]} ${t}`;
}
