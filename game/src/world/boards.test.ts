import { describe, expect, it } from 'vitest';
import type { BoardIssues, BoardPrs, IssueCard, PullRequest, Worker } from '../net/protocol';
import { BoardBook, can, closesText, columnViews, holderOf, holdersOf, isPriorityLabel, issuePlacements, keysById, mergeBlocker, nearestDesk, paperLabel, paperOf, pinOf, prPlacements, reviewPrompt, askPrompt, tint, verdictOf, wallColumns, freshness } from './boards';

const card = (id: string, o: Partial<IssueCard> = {}): IssueCard => ({
  id,
  key: `#${id.split('#')[1]}`,
  title: `Title of ${id}`,
  state: 'open',
  column: 'todo',
  labels: [],
  assignees: [],
  updated_at: 1000,
  closed_at: null,
  ...o,
});

const issues = (cards: IssueCard[], o: Partial<BoardIssues> = {}): BoardIssues => ({
  t: 'board.issues',
  session: 'herdr-3d',
  provider: 'github',
  provider_name: 'GitHub',
  initial: false,
  fetched_at: 5,
  columns: [
    { id: 'todo', name: 'Todo' },
    { id: 'doing', name: 'Doing' },
    { id: 'done', name: 'Done', done: true },
  ],
  cards,
  ...o,
});

const pr = (id: string, o: Partial<PullRequest> = {}): PullRequest => ({ id, key: `#${id.split('#')[1]}`, title: 't', state: 'open', head_branch: 'feat/x', checks: 'success', review: 'approved', mergeable: 'mergeable', closes: [], ...o });

const prs = (list: PullRequest[], o: Partial<BoardPrs> = {}): BoardPrs => ({ t: 'board.prs', session: 'herdr-3d', provider: 'github', provider_name: 'GitHub', initial: false, fetched_at: 5, prs: list, merged: [], ...o });

describe('capabilities', () => {
  it('a card flag overrides the board, a missing flag is off', () => {
    expect(can({ capabilities: { close: true } }, undefined, 'close')).toBe(true);
    expect(can({ capabilities: { close: true } }, { capabilities: { close: false } }, 'close')).toBe(false);
    expect(can({ capabilities: {} }, undefined, 'close')).toBe(false);
    expect(can(null, undefined, 'comment')).toBe(false);
    expect(can({ capabilities: { comment: false } }, { capabilities: { comment: true } }, 'comment')).toBe(true);
  });
});

describe('paper and pins', () => {
  it('knows priority labels in every spelling', () => {
    for (const n of ['P0', 'p3', 'critical', 'Urgent', 'high', 'Medium', 'LOW', 'priority: high', 'priority/low', 'priority-urgent', 'Priority: P1'] as const) expect(isPriorityLabel(n), n).toBe(true);
    for (const n of ['bug', 'bridge', 'p5', 'priority', 'highlight', 'game'] as const) expect(isPriorityLabel(n), n).toBe(false);
  });

  it('takes the paper from the first label that is not a priority label', () => {
    const c = card('a/b#1', { labels: [{ name: 'P1', color: '#ff0000' }, { name: 'bridge', color: '#1D76DB' }, { name: 'game', color: '#00ff00' }] });
    expect(paperLabel(c)).toBe('#1d76db');
    expect(paperOf(c)).toBe(tint('#1d76db', 0.55));
    expect(paperLabel(card('a/b#2', { labels: [{ name: 'high', color: '#ff0000' }] }))).toBeNull();
    expect(paperOf(card('a/b#3'))).toBe('#ffe27a');
    // A label colour that is not #rrggbb never becomes paper.
    expect(paperLabel(card('a/b#4', { labels: [{ name: 'x', color: 'red' }] }))).toBeNull();
  });

  it('pins by priority', () => {
    expect(pinOf(card('a/b#1', { priority: 'urgent' }))).toBe('#e8413a');
    expect(pinOf(card('a/b#1', { priority: 'high' }))).not.toBe(pinOf(card('a/b#1', { priority: 'low' })));
    expect(pinOf(card('a/b#1'))).toBe('#f4f4f0');
  });
});

describe('holders', () => {
  const w = (id: string, o: Partial<Worker> = {}) => ({ worker: { id, session: 's', workspace_id: 'w', label: id, status: 'idle', ...o } as Worker, name: id.toUpperCase() });
  it('is the worker whose work_item is the card, an orchestrator first', () => {
    const wi = { provider: 'github', id: 'a/b#9' };
    const ws = [w('x', { work_item: wi }), w('o', { role: 'orch', work_item: wi }), w('y')];
    expect(holderOf('a/b#9', ws)).toEqual({ id: 'o', name: 'O', role: 'orch' });
    expect(holderOf('a/b#8', ws)).toBeNull();
    expect(holderOf('a/b#9', [ws[0] as (typeof ws)[number]])?.id).toBe('x');
    expect([...holdersOf([{ id: 'a/b#9' }, { id: 'a/b#1' }], ws)]).toEqual([['a/b#9', { id: 'o', name: 'O', role: 'orch' }]]);
  });
});

describe('columns', () => {
  it('sorts by urgency then recency, done by closing time, and drops an empty No status', () => {
    const cards = [
      card('a/b#1', { priority: 'low', updated_at: 9 }),
      card('a/b#2', { priority: 'urgent', updated_at: 1 }),
      card('a/b#3', { updated_at: 50 }),
      card('a/b#4', { updated_at: 20 }),
      card('a/b#5', { column: 'done', state: 'closed', closed_at: 10 }),
      card('a/b#6', { column: 'done', state: 'closed', closed_at: 30 }),
    ];
    const cols = columnViews(issues(cards, { columns: [{ id: '', name: 'No status' }, { id: 'todo', name: 'Todo' }, { id: 'doing', name: 'Doing' }, { id: 'done', name: 'Done', done: true }] }));
    expect(cols.map((c) => c.name)).toEqual(['Todo', 'Doing', 'Done']);
    expect(cols[0]?.cards.map((c) => c.key)).toEqual(['#2', '#1', '#3', '#4']);
    expect(cols[2]?.cards.map((c) => c.key)).toEqual(['#6', '#5']);
  });

  it('follows the provider’s order when cards have a position, done columns too; the unranked ones after them by the old rule', () => {
    const cards = [
      card('a/b#1', { priority: 'urgent', position: 4 }),
      card('a/b#2', { position: 1 }),
      card('a/b#3', { priority: 'low', updated_at: 9 }),
      card('a/b#4', { priority: 'high', updated_at: 1 }),
      card('a/b#5', { column: 'done', state: 'closed', closed_at: 10, position: 0 }),
      card('a/b#6', { column: 'done', state: 'closed', closed_at: 30, position: 7 }),
      card('a/b#7', { column: 'done', state: 'closed', closed_at: 50 }),
      card('a/b#8', { column: 'done', state: 'closed', closed_at: 40 }),
      card('a/b#9', { position: 0 }),
    ];
    const cols = columnViews(issues(cards));
    expect(cols[0]?.cards.map((c) => c.key)).toEqual(['#9', '#2', '#1', '#4', '#3']);
    expect(cols[2]?.cards.map((c) => c.key)).toEqual(['#5', '#6', '#7', '#8']);
    // A provider without an order keeps exactly the old sort.
    const plain = columnViews(issues(cards.map(({ position: _p, ...c }) => c)));
    expect(plain[0]?.cards.map((c) => c.key)).toEqual(['#1', '#4', '#3', '#2', '#9']);
    expect(plain[2]?.cards.map((c) => c.key)).toEqual(['#7', '#8', '#6', '#5']);
  });

  it('keeps a card of an unknown column in a No status column', () => {
    const cols = columnViews(issues([card('a/b#1', { column: 'gone' })]));
    expect(cols[0]).toMatchObject({ id: '', name: 'No status' });
    expect(cols[0]?.cards).toHaveLength(1);
  });

  it('shows four notes per column and counts the rest', () => {
    const cards = Array.from({ length: 9 }, (_, i) => card(`a/b#${i + 1}`, { updated_at: 100 - i }));
    const { columns } = wallColumns(issues(cards));
    expect(columns[0]?.shown).toHaveLength(4);
    expect(columns[0]?.more).toBe(5);
    expect(columns[1]?.more).toBe(0);
  });

  it('shows six columns at most', () => {
    const cols = Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, name: `C${i}` }));
    const w = wallColumns({ columns: cols, cards: [] });
    expect(w.columns).toHaveLength(6);
    expect(w.hiddenColumns).toBe(2);
  });
});

describe('placements', () => {
  const size = { w: 3.73, h: 1.5 };
  it('puts every shown note on the board, none over another column', () => {
    const cards = Array.from({ length: 100 }, (_, i) => card(`a/b#${i + 1}`, { column: ['todo', 'doing', 'done'][i % 3] as string, updated_at: i }));
    const { columns } = wallColumns(issues(cards));
    const ps = issuePlacements(columns, size);
    expect(ps).toHaveLength(12);
    for (const p of ps) {
      expect(p.x - p.w / 2).toBeGreaterThanOrEqual(0);
      expect(p.x + p.w / 2).toBeLessThanOrEqual(size.w);
      expect(p.y - p.h / 2).toBeGreaterThanOrEqual(0);
      expect(p.y + p.h / 2).toBeLessThanOrEqual(size.h - 0.3);
    }
    // Placements are stable for the same card.
    expect(issuePlacements(columns, size)).toEqual(ps);
  });

  it('lays PRs out in a grid and caps it', () => {
    const list = Array.from({ length: 24 }, (_, i) => pr(`a/b#${i + 1}`));
    const ps = prPlacements(list, size);
    expect(ps).toHaveLength(18);
    expect(new Set(ps.map((p) => `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`)).size).toBe(18);
    for (const p of ps) expect(p.x - p.w / 2).toBeGreaterThanOrEqual(0);
    for (const p of ps) expect(p.x + p.w / 2).toBeLessThanOrEqual(size.w);
    for (const p of ps) expect(p.y + p.h / 2).toBeLessThanOrEqual(size.h - 0.3);
  });
});

describe('pull requests', () => {
  it('names the issues it closes by their keys, and only those on the board', () => {
    const keys = keysById(issues([card('a/b#7'), card('a/b#9')]));
    expect(closesText(['a/b#7', 'other/repo#3', 'a/b#9'], keys)).toBe('closes #7, #9');
    expect(closesText(['other/repo#3'], keys)).toBe('');
    expect(closesText([], keys)).toBe('');
  });

  const rw = (o: Partial<Worker> & { id: string }) => ({ worker: { session: 's', workspace_id: 'w', label: o.id, status: 'idle', ...o } as Worker });
  it("stamps a run's PR with its freelancers' latest verdict", () => {
    const wi = { provider: 'github', id: 'a/b#7' };
    const workers = [
      rw({ id: 'o', role: 'orch', work_item: wi }),
      rw({ id: 'r1', role: 'review', orch_id: 'o', report: { state: 'ready', verdict: 'CHANGES_REQUIRED', blockers: 2, at: 10 } }),
      rw({ id: 'r2', role: 'review', orch_id: 'o', report: { state: 'ready', verdict: 'PASS', at: 20 } }),
      rw({ id: 'u', role: 'ux', orch_id: 'o', report: { state: 'pending' } }),
      rw({ id: 'x', role: 'review', orch_id: 'someone-else', report: { state: 'ready', verdict: 'CHANGES_REQUIRED', at: 99 } }),
    ];
    expect(verdictOf({ closes: ['a/b#7'] }, workers)?.text).toBe('PASS');
    expect(verdictOf({ closes: ['a/b#8'] }, workers)).toBeNull();
    expect(verdictOf({ closes: [] }, workers)).toBeNull();
    const first = [workers[0] as (typeof workers)[number], workers[1] as (typeof workers)[number]];
    expect(verdictOf({ closes: ['a/b#7'] }, first)).toMatchObject({ tone: 'changes', blockers: 2 });
  });

  it('refuses a merge on red checks or conflicts, offering an override only where GitHub would allow it', () => {
    expect(mergeBlocker(pr('a/b#1'))).toBeNull();
    expect(mergeBlocker(pr('a/b#1', { checks: 'failure' }))).toMatchObject({ overridable: true, why: expect.stringContaining('checks fail') });
    expect(mergeBlocker(pr('a/b#1', { checks: 'none' }))?.overridable).toBe(true);
    expect(mergeBlocker(pr('a/b#1', { mergeable: 'unknown' }))?.overridable).toBe(true);
    expect(mergeBlocker(pr('a/b#1', { mergeable: 'conflicting', checks: 'success' }))).toMatchObject({ overridable: false });
  });
});

describe('BoardBook', () => {
  it('keeps the last message per floor and kind', () => {
    const b = new BoardBook();
    b.apply(issues([card('a/b#1')]));
    b.apply(prs([pr('a/b#2')]));
    expect(b.get('herdr-3d').issues?.cards).toHaveLength(1);
    expect(b.get('herdr-3d').prs?.prs).toHaveLength(1);
    expect(b.get('other')).toEqual({ issues: null, prs: null });
    b.drop('herdr-3d');
    expect(b.get('herdr-3d').issues).toBeNull();
  });

  it('announces a merge once, never on the initial replay', () => {
    const b = new BoardBook();
    const m = { id: 'a/b#30', key: '#30', title: 't', merged_at: 9 };
    expect(b.apply(prs([], { initial: true, merged: [m] })).merged).toEqual([]);
    expect(b.apply(prs([], { merged: [m] })).merged).toEqual([m]);
    expect(b.apply(prs([], { merged: [m] })).merged).toEqual([]);
    // The same id on another floor is another merge.
    expect(b.apply(prs([], { session: 'other', merged: [m] })).merged).toEqual([m]);
  });
});

describe('the nearest free desk', () => {
  const slots = [0, 1, 2, 3].map((i) => ({ desk: { x: i * 4, z: 0 } }));
  it('is nearest to the player, not the first', () => {
    expect(nearestDesk(slots, [0, 2, 3], { x: 11, z: 1 })).toBe(3);
    expect(nearestDesk(slots, [0, 2], { x: 11, z: 1 })).toBe(2);
    expect(nearestDesk(slots, [], { x: 0, z: 0 })).toBeNull();
    expect(nearestDesk(slots, [0, 1], { x: 2, z: 0 })).toBe(0);
  });
});

describe('copy', () => {
  it('asks and reviews with the words the ticket gives', () => {
    expect(askPrompt('#9', 'https://x/9')).toBe("Investigate #9 (https://x/9) and report back. Don't change code.");
    expect(askPrompt('#9', undefined)).toBe("Investigate #9 and report back. Don't change code.");
    expect(reviewPrompt('claude', { key: '#3', url: 'https://x/pull/3' })).toBe('/mattpocock-skills:code-review https://x/pull/3');
    expect(reviewPrompt('codex', { key: '#3', url: 'https://x/pull/3' })).toBe('$code-review https://x/pull/3');
    expect(reviewPrompt('codex', { key: '#3' })).toBe('$code-review #3');
  });

  it('says when a board is stale, short or rate limited', () => {
    const clock = (ms: number) => `t${ms}`;
    expect(freshness({ provider_name: 'GitHub', fetched_at: 5 }, 10, clock)).toBeNull();
    expect(freshness({ provider_name: 'GitHub', fetched_at: 5, stale: true, error: 'auth' }, 10, clock)).toBe('GitHub did not answer (auth): this is the last good copy from t5.');
    expect(freshness({ provider_name: 'GitHub', fetched_at: 5, truncated: true }, 10, clock)).toMatch(/some items are missing/);
    expect(freshness({ provider_name: 'GitHub', fetched_at: 5, rate: { remaining: 10, reset_at: 20 } }, 10, clock)).toBe('GitHub rate limit: next refresh t20.');
    expect(freshness({ provider_name: 'GitHub', fetched_at: 5, rate: { remaining: 4000, reset_at: 20 } }, 10, clock)).toBeNull();
  });
});

import { readableInk, timeAgo } from './boards';

describe('overlay helpers', () => {
  it('picks the ink that reads on a label colour', () => {
    expect(readableInk('#ffffff')).toBe('#111a2e');
    expect(readableInk('#000000')).toBe('#ffffff');
    expect(readableInk('#1d76db')).toBe('#ffffff');
    expect(readableInk('#fbca04')).toBe('#111a2e');
    expect(readableInk('nope')).toBe('#111a2e');
  });

  it('says how long ago', () => {
    expect(timeAgo(1000, 1000 + 10_000)).toBe('just now');
    expect(timeAgo(0, 5)).toBe('');
    expect(timeAgo(1, 1 + 5 * 60_000)).toBe('5 min ago');
    expect(timeAgo(1, 1 + 3 * 3_600_000)).toBe('3 h ago');
    expect(timeAgo(1, 1 + 2 * 86_400_000)).toBe('2 d ago');
  });
});

describe('Kaneo wording (#184)', () => {
  it('asks a worker with the task itself, bounded, and sends nobody to gh', async () => {
    const { askItemPrompt, freshness } = await import('./boards');
    const p = askItemPrompt('Kaneo', { key: 'HRD-3', title: ' Lobby ', url: 'https://k.test/t' }, 'x'.repeat(5000));
    expect(p.startsWith('Investigate Kaneo task HRD-3: Lobby (https://k.test/t)')).toBe(true);
    expect(p).toContain('[The description goes on in Kaneo.]');
    expect(p).toContain("don't look it up with gh");
    expect(p.length).toBeLessThan(4300);
    const f = freshness({ stale: true, error: '403', error_code: 'forbidden', fetched_at: 0, provider_name: 'Kaneo' }, 0, () => 'now');
    expect(f).toContain('permission problem');
  });
});
