/**
 * M7: the issues and pull request boards as the game shows them (docs/protocol.md "Boards: issues and pull requests").
 * Pure; vitest covers it. Nothing here knows which provider an item comes from: ids are opaque (never parsed), people see
 * `key`, and what a provider cannot do arrives as capability flags.
 */

import type { BoardCaps, BoardColumn, BoardIssues, BoardMessage, BoardPrs, IssueCard, MergedPullRequest, MergeMethod, Priority, PullRequest, Worker, WorkItem } from '../net/protocol';
import { crewRole, stampOf, type Stamp } from './crew';

// ---- capabilities -----------------------------------------------------------------------

export type Cap = keyof BoardCaps;

/** Whether an action is offered: the item's own flag, else the board's, else off (a missing flag is not a yes). */
export function can(board: { capabilities?: BoardCaps } | null | undefined, item: { capabilities?: BoardCaps } | null | undefined, cap: Cap): boolean {
  const own = item?.capabilities?.[cap];
  if (typeof own === 'boolean') return own;
  return board?.capabilities?.[cap] === true;
}

// ---- paper, pins, priority ----------------------------------------------------------------

/** The priority labels the bridge derives `priority` from (case-insensitive): `p0`…`p4`, `critical`, `urgent`, `high`, `medium`, `low`, and `priority: x`, `priority/x`, `priority-x`. */
const PRIORITY_NAME = /^(?:priority\s*[:/-]\s*)?(?:p[0-4]|critical|urgent|high|medium|low)$/i;

export const isPriorityLabel = (name: string): boolean => PRIORITY_NAME.test(name.trim());

const HEX = /^#[0-9a-f]{6}$/i;

/** The colour of the first label that is not a priority label; null: default paper. */
export function paperLabel(card: Pick<IssueCard, 'labels'>): string | null {
  for (const l of card.labels) if (!isPriorityLabel(l.name) && HEX.test(l.color)) return l.color.toLowerCase();
  return null;
}

/** Default paper (no label with a colour). */
export const DEFAULT_PAPER = '#ffe27a';

/** `#rrggbb` mixed towards white by `k` (0 = the colour, 1 = white): pastel paper that dark ink reads on. */
export function tint(hex: string, k: number): string {
  const n = HEX.test(hex) ? parseInt(hex.slice(1), 16) : parseInt(DEFAULT_PAPER.slice(1), 16);
  const ch = (shift: number) => Math.round(((n >> shift) & 255) * (1 - k) + 255 * k);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}

/** The paper of a note: its label's colour, softened. */
export function paperOf(card: Pick<IssueCard, 'labels'>): string {
  const l = paperLabel(card);
  return l ? tint(l, 0.55) : DEFAULT_PAPER;
}

export const PIN_COLOR: Record<Priority | 'none', string> = {
  urgent: '#e8413a',
  high: '#ff8a1f',
  medium: '#2f6bf0',
  low: '#7a8398',
  none: '#f4f4f0',
};

export const pinOf = (card: Pick<IssueCard, 'priority'>): string => PIN_COLOR[card.priority ?? 'none'] ?? PIN_COLOR.none;

const RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

/** Most urgent first, then the most recently changed. */
export function byUrgency(a: IssueCard, b: IssueCard): number {
  const r = (RANK[a.priority ?? ''] ?? 4) - (RANK[b.priority ?? ''] ?? 4);
  if (r) return r;
  const t = (b.updated_at ?? 0) - (a.updated_at ?? 0);
  return t || a.key.localeCompare(b.key, undefined, { numeric: true });
}

const byClosed = (a: IssueCard, b: IssueCard) => (b.closed_at ?? b.updated_at ?? 0) - (a.closed_at ?? a.updated_at ?? 0) || byUrgency(a, b);

/** #52: the provider's order (`position`) first; the cards without one after them, by `fallback`. */
const byPosition =
  (fallback: (a: IssueCard, b: IssueCard) => number) =>
  (a: IssueCard, b: IssueCard): number => {
    const pa = typeof a.position === 'number' ? a.position : null;
    const pb = typeof b.position === 'number' ? b.position : null;
    if (pa !== null && pb !== null) return pa - pb || fallback(a, b);
    if (pa !== null) return -1;
    if (pb !== null) return 1;
    return fallback(a, b);
  };
const BY_POSITION = byPosition(byUrgency);
const BY_POSITION_DONE = byPosition(byClosed);

// ---- holders ------------------------------------------------------------------------------

export interface Holder {
  id: string;
  name: string;
  role: string | null;
}

interface HolderWorker {
  worker: Pick<Worker, 'id' | 'role' | 'label' | 'work_item'> & { name?: string };
  name: string;
}

/** The live worker holding a card: the one whose `work_item` is the card's id (an orchestrator over anyone else). */
export function holderOf(cardId: string, workers: readonly HolderWorker[]): Holder | null {
  let best: Holder | null = null;
  for (const v of workers) {
    if (v.worker.work_item?.id !== cardId) continue;
    const role = crewRole(v.worker);
    const h: Holder = { id: v.worker.id, name: v.name, role };
    if (role === 'orch') return h;
    best ??= h;
  }
  return best;
}

/** card id → holder, for every card at once. */
export function holdersOf(cards: readonly Pick<IssueCard, 'id'>[], workers: readonly HolderWorker[]): Map<string, Holder> {
  const out = new Map<string, Holder>();
  const ids = new Set(cards.map((c) => c.id));
  const byItem = new Map<string, HolderWorker[]>();
  for (const v of workers) {
    const id = v.worker.work_item?.id;
    if (id && ids.has(id)) byItem.set(id, [...(byItem.get(id) ?? []), v]);
  }
  for (const [id, vs] of byItem) {
    const h = holderOf(id, vs);
    if (h) out.set(id, h);
  }
  return out;
}

// ---- columns ----------------------------------------------------------------------------------

/** What the wall board fits: notes per column (cascaded), columns across. The overlay shows everything. */
export const WALL_ROWS = 4;
export const WALL_COLUMNS = 6;

export interface ColumnView {
  id: string;
  name: string;
  done: boolean;
  /** #184: a provider's virtual status (`planned`, `archived`; archive is not completion); absent for a workflow column. */
  kind?: 'planned' | 'archived';
  /** Every card of the column, in board order. */
  cards: IssueCard[];
}

/**
 * The columns as the wall and the overlay list them. Cards follow the provider's order (`position`, #52); the ones without
 * a position come after them, most urgent first (done column: latest closed first). Empty "No status" is left out.
 */
export function columnViews(m: Pick<BoardIssues, 'columns' | 'cards'>): ColumnView[] {
  const known = new Set(m.columns.map((c) => c.id));
  const cols: BoardColumn[] = [...m.columns];
  // Cards pointing at no known column still show somewhere: in a leading column of their own.
  if (m.cards.some((c) => !known.has(c.column)) && !known.has('')) cols.unshift({ id: '', name: 'No status' });
  return cols
    .map((c) => {
      const cards = m.cards.filter((x) => (known.has(x.column) ? x.column === c.id : c.id === ''));
      cards.sort(c.done ? BY_POSITION_DONE : BY_POSITION);
      const kind = c.kind === 'planned' || c.kind === 'archived' ? c.kind : null;
      return { id: c.id, name: c.name, done: c.done === true, ...(kind ? { kind } : {}), cards };
    })
    .filter((c) => c.id !== '' || c.cards.length > 0);
}

/** A column of the wall: what shows, and how many more there are. */
export interface WallColumn extends ColumnView {
  shown: IssueCard[];
  more: number;
}

export function wallColumns(m: Pick<BoardIssues, 'columns' | 'cards'>, rows = WALL_ROWS, max = WALL_COLUMNS): { columns: WallColumn[]; hiddenColumns: number } {
  const all = columnViews(m);
  return {
    columns: all.slice(0, max).map((c) => ({ ...c, shown: c.cards.slice(0, rows), more: Math.max(0, c.cards.length - rows) })),
    hiddenColumns: Math.max(0, all.length - max),
  };
}

// ---- notes on the wall -----------------------------------------------------------------------------

/** A note's place on a board, in metres from the board's bottom-left corner (`x` and `y` are its centre). */
export interface Placement {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Radians, a small tilt (stable per id). */
  rot: number;
}

export interface BoardSize {
  w: number;
  h: number;
}

/** Headroom for the board's title strip and column heads, and the foot for "+N more". */
export const HEADER_H = 0.3;
export const HEAD_H = 0.13;
export const FOOT_H = 0.1;
/** A wall note: 4 × 3. */
export const NOTE_W = 0.5;
export const NOTE_H = 0.375;

/** A stable small number from an id (tilt, jitter). */
export function jitter(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}

const tilt = (id: string) => (jitter(id) - 0.5) * 0.07;

/** Centre x of column `i` of `n`. */
export function columnCentre(size: BoardSize, i: number, n: number): { x: number; w: number } {
  const pad = 0.1;
  const w = (size.w - pad * 2) / Math.max(1, n);
  return { x: pad + w * (i + 0.5), w };
}

/** Where the issue board's shown cards sit: down each column, each note over the bottom of the one above. */
export function issuePlacements(cols: readonly WallColumn[], size: BoardSize): Placement[] {
  const out: Placement[] = [];
  const top = size.h - HEADER_H - HEAD_H;
  const room = top - FOOT_H;
  cols.forEach((col, ci) => {
    const c = columnCentre(size, ci, cols.length);
    const w = Math.min(NOTE_W, c.w - 0.04);
    const h = w * 0.75;
    const n = col.shown.length;
    const step = n > 1 ? Math.min(h * 0.72, (room - h) / (n - 1)) : 0;
    col.shown.forEach((card, i) => {
      out.push({ id: card.id, x: c.x + (jitter(card.id + 'x') - 0.5) * 0.03, y: top - h / 2 - i * step - 0.02, w, h, rot: tilt(card.id) });
    });
  });
  return out;
}

/** The PR board: notes in a grid (row by row), `perRow` across. */
export const PR_COLUMNS = 3;
export const PR_ROWS = 6;
export const PR_CAP = PR_COLUMNS * PR_ROWS;

export function prPlacements(prs: readonly Pick<PullRequest, 'id'>[], size: BoardSize): Placement[] {
  const shown = prs.slice(0, PR_CAP);
  const pad = 0.1;
  const gap = 0.05;
  const w = (size.w - pad * 2 - gap * (PR_COLUMNS - 1)) / PR_COLUMNS;
  const top = size.h - HEADER_H - 0.04;
  const rowH = Math.min(0.2, (top - FOOT_H) / PR_ROWS);
  const h = rowH - 0.016;
  return shown.map((p, i) => ({
    id: p.id,
    x: pad + (w + gap) * (i % PR_COLUMNS) + w / 2 + (jitter(p.id) - 0.5) * 0.01,
    y: top - rowH * (Math.floor(i / PR_COLUMNS) + 0.5),
    w,
    h,
    rot: tilt(p.id) * 0.4,
  }));
}

// ---- pull requests -----------------------------------------------------------------------------------

/** The `key` of each issue of the board, by id: a PR names the issues it closes by these (ids of other boards are left out). */
export function keysById(issues: Pick<BoardIssues, 'cards'> | null): Map<string, string> {
  return new Map((issues?.cards ?? []).map((c) => [c.id, c.key]));
}

/** "closes #7, #9" from the ids a PR closes that are on the issue board; '' when none. */
export function closesText(closes: readonly string[], keys: ReadonlyMap<string, string>): string {
  const ks = closes.flatMap((id) => {
    const k = keys.get(id);
    return k ? [k] : [];
  });
  return ks.length ? `closes ${ks.join(', ')}` : '';
}

/**
 * The verdict stamp of a run's PR: an orchestrator holds one of the issues the PR closes, and its freelancers' latest
 * ready review / ux report says PASS, CHANGES_REQUIRED or INCOMPLETE. Null when the PR is not a run's or nobody reviewed.
 */
export function verdictOf(pr: Pick<PullRequest, 'closes'>, workers: ReadonlyArray<{ worker: Worker }>): Stamp | null {
  const closes = new Set(pr.closes);
  if (!closes.size) return null;
  const orchs = workers.filter((v) => crewRole(v.worker) === 'orch' && v.worker.work_item && closes.has(v.worker.work_item.id)).map((v) => v.worker.id);
  if (!orchs.length) return null;
  let best: { at: number; stamp: Stamp } | null = null;
  for (const v of workers) {
    const w = v.worker;
    const role = crewRole(w);
    if ((role !== 'review' && role !== 'ux') || !w.orch_id || !orchs.includes(w.orch_id)) continue;
    const stamp = stampOf(w.report);
    if (!stamp) continue;
    const at = w.report?.at ?? 0;
    if (!best || at >= best.at) best = { at, stamp };
  }
  return best?.stamp ?? null;
}

export const CHECKS_WORD: Record<PullRequest['checks'], string> = { success: 'checks pass', failure: 'checks fail', pending: 'checks running', none: 'no checks' };
export const REVIEW_WORD: Record<PullRequest['review'], string> = { approved: 'approved', changes_requested: 'changes requested', review_required: 'review needed', none: 'no review' };
export const MERGEABLE_WORD: Record<PullRequest['mergeable'], string> = { mergeable: 'mergeable', conflicting: 'conflicts', unknown: 'mergeability unknown' };

/** Why Merge is off (null: it is offered); conflicts are never mergeable, even with an override. */
export function mergeBlocker(pr: Pick<PullRequest, 'checks' | 'mergeable' | 'draft'>): { why: string; overridable: boolean } | null {
  if (pr.mergeable === 'conflicting') return { why: 'It has merge conflicts: resolve them first.', overridable: false };
  const why: string[] = [];
  if (pr.checks !== 'success') why.push(pr.checks === 'failure' ? 'its checks fail' : pr.checks === 'pending' ? 'its checks are still running' : 'it has no passing checks');
  if (pr.mergeable !== 'mergeable') why.push('its mergeability is not confirmed');
  return why.length ? { why: `Not ready: ${why.join(' and ')}.`, overridable: true } : null;
}

// ---- the store ----------------------------------------------------------------------------------------------

/** #58: the floor id a board message is for (an older bridge sends only `session`, which was the floor). */
export const boardFloor = (m: Pick<BoardMessage, 'floor' | 'session'>): string => m.floor ?? m.session;

export interface FloorBoards {
  issues: BoardIssues | null;
  prs: BoardPrs | null;
}

export interface BoardUpdate {
  /** #58: the floor id. */
  floor: string;
  kind: 'issues' | 'prs';
  /** PRs merged since the last poll (never on `initial`), each announced once. */
  merged: MergedPullRequest[];
}

/** The last board messages per floor (the bridge keeps the cache; this is what the game shows). */
export class BoardBook {
  private readonly floors = new Map<string, FloorBoards>();
  private readonly announced = new Set<string>();
  /** Bumped by every message. */
  version = 0;

  apply(m: BoardMessage): BoardUpdate {
    // #58: keyed by floor id (an older bridge's `session` is the floor).
    const floor = boardFloor(m);
    const cur = this.floors.get(floor) ?? { issues: null, prs: null };
    this.version++;
    if (m.t === 'board.issues') {
      this.floors.set(floor, { ...cur, issues: m });
      return { floor, kind: 'issues', merged: [] };
    }
    this.floors.set(floor, { ...cur, prs: m });
    const merged = m.initial ? [] : (m.merged ?? []).filter((x) => !this.announced.has(`${floor}\u0000${m.provider}\u0000${x.id}`));
    for (const x of merged) this.announced.add(`${floor}\u0000${m.provider}\u0000${x.id}`);
    return { floor, kind: 'prs', merged };
  }

  get(floor: string): FloorBoards {
    return this.floors.get(floor) ?? { issues: null, prs: null };
  }

  /** The game stopped watching a floor: what it had is stale until it watches again. */
  drop(floor: string): void {
    if (this.floors.delete(floor)) this.version++;
  }
}

// ---- the desk for "Hand to a worker" -------------------------------------------------------------------------------

/** The free desk nearest to `from` (floor coordinates, metres), by distance to the desk itself. */
export function nearestDesk(slots: ReadonlyArray<{ desk: { x: number; z: number } }>, free: Iterable<number>, from: { x: number; z: number }): number | null {
  let best: number | null = null;
  let bd = Infinity;
  for (const i of free) {
    const s = slots[i];
    if (!s) continue;
    const d = Math.hypot(s.desk.x - from.x, s.desk.z - from.z);
    if (d < bd - 1e-9) {
      bd = d;
      best = i;
    }
  }
  return best;
}

// ---- copy ---------------------------------------------------------------------------------------------------------------

/**
 * The first prompt of "Ask a worker…": investigate, don't change code. The item goes by its key and link, a Kaneo task
 * too (#102): the worker reads it with the tools it has.
 */
export const askPrompt = (key: string, url: string | undefined): string => `Investigate ${key}${url ? ` (${url})` : ''} and report back. Don't change code.`;

/** #184: what one item of the provider is called: GitHub's are issues, Kaneo's tasks. */
export const itemWord = (provider: string | undefined): string => (provider === 'kaneo' ? 'task' : 'issue');

/** #184: a closed card's word: GitHub closes an issue, a Kaneo task is done (it sits in a final column). */
export const closedWord = (provider: string | undefined): string => (provider === 'kaneo' ? 'done' : 'closed');

/** The reviewer's first prompt (`/mattpocock-skills:code-review <url>` for claude, `$code-review <url>` for codex). */
export function reviewPrompt(harness: string, target: { url?: string; key: string }): string {
  const ref = target.url ?? target.key;
  return harness === 'codex' ? `$code-review ${ref}` : `/mattpocock-skills:code-review ${ref}`;
}

/** The gh merge flag of each of the panel's merge methods, one to one. */
const MERGE_FLAG: Record<MergeMethod, string> = { squash: '--squash', merge: '--merge', rebase: '--rebase' };

/**
 * #248: the first prompt of "Resolve conflicts with a worker": resolve the PR's conflicts in a worktree of its own, push
 * them to the PR's branch, and merge with the method picked in the panel once the checks pass. Plain text, so one version
 * serves every harness. The number for gh comes from the PR's link or key (what a person reads), else gh takes the link.
 */
export function resolveConflictsPrompt(pr: Pick<PullRequest, 'key' | 'url' | 'head_branch' | 'base_branch'>, method: MergeMethod): string {
  const n = /\/pull\/(\d+)\/?$/.exec(pr.url ?? '')?.[1] ?? /^#(\d+)$/.exec(pr.key)?.[1] ?? pr.url ?? pr.key;
  const base = pr.base_branch ? `origin/${pr.base_branch}` : 'origin/<base>';
  return [
    `Resolve the merge conflicts of pull request ${pr.key}${pr.url ? ` (${pr.url})` : ''} and merge it. Its branch is ${pr.head_branch}; it merges into ${pr.base_branch ?? `its base branch (find it with \`gh pr view ${n} --json baseRefName\`)`}.`,
    '',
    'Work in a git worktree of your own: never switch the branch of a shared checkout, other workers use it. If you are not in a worktree of your own yet, make one first (`git worktree add --detach <path>`) and work there.',
    '',
    `1. Check the PR out detached: \`gh pr checkout ${n} --detach\`.`,
    `2. Merge its base in: \`git fetch origin && git merge ${base}\`.`,
    '3. Resolve the conflicts, keeping the intent of both sides.',
    "4. Run the project's tests.",
    `5. Push to the PR's branch: \`git push origin HEAD:${pr.head_branch}\`.`,
    '6. Wait for the checks to finish.',
    `7. Merge: \`gh pr merge ${n} ${MERGE_FLAG[method]}\`.`,
    '',
    'If a conflict is not mechanical (both sides changed the same logic in ways that do not fit together), stop and report instead of merging. If the tests or the checks fail, stop and report too; do not merge.',
  ].join('\n');
}

export const workItemOf =(card: Pick<IssueCard, 'id'>, provider: string): WorkItem => ({ provider, id: card.id });

export const CLOSE_REASONS: ReadonlyArray<{ id: 'completed' | 'not_planned' | 'duplicate'; label: string }> = [
  { id: 'completed', label: 'Completed' },
  { id: 'not_planned', label: 'Not planned' },
  { id: 'duplicate', label: 'Duplicate' },
];

/** The words for a poll that failed or came up short: null when the board is as fresh as it gets. */
export function freshness(
  m: Pick<BoardIssues | BoardPrs, 'stale' | 'error' | 'truncated' | 'rate' | 'fetched_at' | 'provider_name' | 'error_code' | 'paused_until'>,
  now: number,
  clock: (ms: number) => string,
): string | null {
  const parts: string[] = [];
  const copy = `this is the last good copy${m.fetched_at ? ` from ${clock(m.fetched_at)}` : ''}`;
  // #184: a refused key pauses the board (it may be the key's quota); a 403 is a permission problem, not an outage.
  if (m.stale && m.error_code === 'unauthorized') {
    const until = m.paused_until && m.paused_until > now ? ` until ${clock(m.paused_until)}` : '';
    parts.push(`${m.provider_name} refused herdr-world’s key (it may be out of its request quota): the board is paused${until}, and ${copy}. Test the connection again in Settings to resume now.`);
  } else if (m.stale && m.error_code === 'forbidden') {
    parts.push(`${m.provider_name} does not let this key read the board (a permission problem in ${m.provider_name}): ${copy}. Ask for access, or pick another project in Floor settings.`);
  } else if (m.stale) parts.push(`${m.provider_name} did not answer${m.error ? ` (${m.error})` : ''}: ${copy}.`);
  if (m.truncated) parts.push('The board is longer than the bridge fetches: some items are missing.');
  if (m.rate && m.rate.reset_at > now && m.rate.remaining < 100) parts.push(`${m.provider_name} rate limit: next refresh ${clock(m.rate.reset_at)}.`);
  return parts.length ? parts.join(' ') : null;
}

// ---- small helpers for the overlays ----------------------------------------------------------------------------------

/** Black or white ink for text on a `#rrggbb` label colour (WCAG relative luminance). */
export function readableInk(hex: string): '#111a2e' | '#ffffff' {
  const n = HEX.test(hex) ? parseInt(hex.slice(1), 16) : 0xcccccc;
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  // The ink (luminance ~0.011) wins where it has the better contrast ratio against the colour.
  return (l + 0.05) / 0.061 > 1.05 / (l + 0.05) ? '#111a2e' : '#ffffff';
}

/** "just now", "5 min ago", "3 h ago", "2 d ago"; '' for a missing time. */
export function timeAgo(at: number | null | undefined, now: number): string {
  if (!at || at <= 0) return '';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

export const PRIORITY_WORD: Record<Priority, string> = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };
