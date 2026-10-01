import { describe, expect, it } from 'vitest';
import type { BoardIssues, BoardPrs, Snapshot, WorldEvent } from '../src/net/protocol';
import { WorldStore } from '../src/world/store';
import { loadFixture } from './fixture-server';
import { SimWorld } from './fixture-sim';

type Msg = Record<string, unknown>;

/** A sim on demo-m4 (herdr-3d: repo JeffreyVdb/herdr-3d with a project; pastry: no repo), manual timers. */
function rig(fail?: string) {
  const timers: Array<() => void> = [];
  const { snapshot } = loadFixture('demo-m4');
  const sim = new SimWorld(snapshot as never, { fail, setTimeout: (fn) => timers.push(fn), clearTimeout: () => {} });
  const store = new WorldStore(0);
  store.applySnapshot(sim.snapshot() as unknown as Snapshot);
  const out: Msg[] = [];
  let n = 0;
  const send = (m: Msg) => {
    out.push(m);
    if (typeof m.seq === 'number') store.applyEvent(m as unknown as WorldEvent);
  };
  const cmd = (t: string, args: unknown) => {
    const req_id = `r${++n}`;
    const from = out.length;
    sim.handle({ t, req_id, args }, send);
    const got = () => out.slice(from);
    return { got, ack: () => got().find((m) => m.t === 'ack' && m.req_id === req_id) as Msg | undefined, err: () => got().find((m) => m.t === 'error' && m.req_id === req_id) as Msg | undefined };
  };
  const settle = () => {
    while (timers.length) (timers.shift() as () => void)();
  };
  const boards = () => ({ issues: out.filter((m) => m.t === 'board.issues') as unknown as BoardIssues[], prs: out.filter((m) => m.t === 'board.prs') as unknown as BoardPrs[] });
  return { sim, store, cmd, settle, out, boards };
}

const HERDR = 'JeffreyVdb/herdr-3d';

describe('board.watch', () => {
  it('acks, then sends the cache with initial: true, issues first, without a seq', () => {
    const r = rig();
    const w = r.cmd('board.watch', { session: 'herdr-3d' });
    const got = w.got();
    expect(got.map((m) => m.t)).toEqual(['ack', 'board.issues', 'board.prs']);
    expect(w.ack()?.data).toEqual({ enabled: true });
    const [issues, prs] = [got[1] as unknown as BoardIssues, got[2] as unknown as BoardPrs];
    for (const m of [issues, prs]) {
      expect(m).not.toHaveProperty('seq');
      expect(m).toMatchObject({ session: 'herdr-3d', provider: 'github', provider_name: 'GitHub', initial: true, stale: false, truncated: false });
      expect(m.fetched_at).toBeGreaterThan(0);
    }
    expect(issues.columns.map((c) => c.name)).toEqual(['Todo', 'Doing', 'QA', 'Done']);
    expect(issues.columns.find((c) => c.name === 'Done')?.done).toBe(true);
    expect(issues.capabilities).toEqual({ comment: true, close: true, set_status: true, order: true });
    expect(prs.capabilities).toEqual({ comment: true, merge: true, open_from_branch: true });
    expect(prs.merged).toEqual([]);
    expect(issues.cards[0]?.id).toMatch(/^JeffreyVdb\/herdr-3d#\d+$/);
  });

  it('is enabled: false for a floor with no repo, and an unknown floor is an error', () => {
    const r = rig();
    expect(r.cmd('board.watch', { session: 'pastry' }).ack()?.data).toEqual({ enabled: false, reason: 'no repo linked' });
    expect(r.cmd('board.watch', { session: 'nope' }).err()).toMatchObject({ code: 'unknown_session' });
    expect(r.cmd('board.watch', { session: 'pastry', extra: 1 }).err()).toMatchObject({ code: 'bad_request' });
  });

  it('a repo without a project has Open / Closed and no set_status', () => {
    const r = rig();
    r.cmd('floor.settings.set', { session: 'pastry', repo: 'someone/else' });
    r.cmd('board.watch', { session: 'pastry' });
    const i = r.boards().issues[0] as BoardIssues;
    expect(i.columns.map((c) => c.id)).toEqual(['open', 'closed']);
    expect(i.capabilities).toEqual({ comment: true, close: true, set_status: false, order: false });
    expect(i.cards.some((c) => 'position' in c)).toBe(false);
    expect(r.cmd('issue.set_status', { session: 'pastry', id: 'someone/else#1', column: 'closed' }).err()).toMatchObject({ code: 'unsupported' });
  });

  it('is unknown_command for every board command on a bridge before M7', () => {
    const r = rig('no_m7');
    for (const t of ['board.watch', 'board.unwatch', 'board.refresh', 'issue.get', 'pr.merge', 'worker.open_pr']) {
      expect(r.cmd(t, { session: 'herdr-3d' }).err(), t).toMatchObject({ code: 'unknown_command' });
    }
  });

  it('decorates workers that have an issue with the neutral work_item', () => {
    const { snapshot } = loadFixture('demo-m6');
    const sim = new SimWorld(snapshot as never, {});
    const world = (sim.snapshot() as unknown as Snapshot).world;
    const orch = world.workers.find((w) => w.role === 'orch' && w.issue?.number === 3);
    expect(orch?.work_item).toEqual({ provider: 'github', id: 'JeffreyVdb/lab#3' });
    expect(world.workers.find((w) => !w.issue)?.work_item).toBeUndefined();
  });
});

describe('writes', () => {
  const watch = () => {
    const r = rig();
    r.cmd('board.watch', { session: 'herdr-3d' });
    return r;
  };

  it('every write queues a poll: issues then prs, initial: false', () => {
    const r = watch();
    const before = r.out.length;
    const c = r.cmd('issue.comment', { session: 'herdr-3d', id: `${HERDR}#12`, body: 'hello' });
    expect((c.ack()?.data as { comment: { body: string } }).comment.body).toBe('hello');
    expect(r.out.length).toBe(before + 1);
    r.settle();
    expect(r.out.slice(before + 1).map((m) => [m.t, m.initial])).toEqual([['board.issues', false], ['board.prs', false]]);
  });

  it('#52: cards carry their place in the project, seeded the way the game sorted them before', () => {
    const r = watch();
    const b = r.boards().issues.at(-1) as BoardIssues;
    const todo = b.cards.filter((c) => c.column === '49294ed0').sort((x, y) => (x.position ?? 0) - (y.position ?? 0));
    // Medium, then the two lows by recency, then the rest by recency.
    expect(todo.map((c) => c.key).slice(0, 4)).toEqual(['#12', '#14', '#23', '#13']);
    expect(new Set(b.cards.map((c) => c.position)).size).toBe(b.cards.length);
    expect(b.cards.every((c) => typeof c.position === 'number')).toBe(true);
  });

  it('#52: issue.set_status with after places the card, like the bridge', () => {
    const r = watch();
    const order = () => {
      r.settle();
      const b = r.boards().issues.at(-1) as BoardIssues;
      const col = (id: string) => b.cards.filter((c) => c.column === id).sort((x, y) => (x.position as number) - (y.position as number)).map((c) => c.key);
      return { todo: col('49294ed0'), doing: col('ae6334b4'), qa: col('64e1b0ac') };
    };
    const start = order();
    expect(start.doing).toEqual(['#9', '#20']);
    const set = (id: number, column: string, after?: unknown) => r.cmd('issue.set_status', { session: 'herdr-3d', id: `${HERDR}#${id}`, column, ...(after === undefined ? {} : { after }) });
    // Right after a card of another column, then the top of a column, then a reorder within one.
    expect(set(13, 'ae6334b4', `${HERDR}#9`).ack()).toBeDefined();
    expect(order().doing).toEqual(['#9', '#13', '#20']);
    expect(set(14, 'ae6334b4', null).ack()).toBeDefined();
    expect(order().doing).toEqual(['#14', '#9', '#13', '#20']);
    expect(set(20, 'ae6334b4', `${HERDR}#14`).ack()).toBeDefined();
    expect(order().doing).toEqual(['#14', '#20', '#9', '#13']);
    // Without after: the status only, the card keeps its place in the project's order.
    expect(set(9, '64e1b0ac').ack()).toBeDefined();
    expect(order().qa).toEqual(['#9', '#21', '#22']);
    // Refused like the bridge.
    for (const after of [`${HERDR}#404`, `${HERDR}#12`, `${HERDR}#20`, 3]) expect(set(20, 'ae6334b4', after).err()).toMatchObject({ code: 'bad_request' });
    // A failing write changes nothing.
    r.cmd('sim.boards', { fail_write: 'GitHub: Resource not accessible' });
    expect(set(13, '49294ed0', null).err()).toMatchObject({ code: 'provider_failed', message: expect.stringContaining('Resource not accessible') });
    r.cmd('sim.boards', { fail_write: null });
    expect(order().doing).toEqual(['#14', '#20', '#13']);
  });

  it('issue.close needs confirm: true and a reason, and moves the card to Done', () => {
    const r = watch();
    expect(r.cmd('issue.close', { session: 'herdr-3d', id: `${HERDR}#12`, reason: 'completed' }).err()).toMatchObject({ code: 'confirmation_required' });
    expect(r.cmd('issue.close', { session: 'herdr-3d', id: `${HERDR}#12`, reason: 'nope', confirm: true }).err()).toMatchObject({ code: 'bad_request' });
    expect(r.cmd('issue.close', { session: 'herdr-3d', id: 'x/y#1', reason: 'completed', confirm: true }).err()).toMatchObject({ code: 'not_found' });
    expect(r.cmd('issue.close', { session: 'herdr-3d', id: `${HERDR}#12`, reason: 'not_planned', confirm: true }).ack()).toBeDefined();
    r.settle();
    const card = r.boards().issues.at(-1)?.cards.find((c) => c.id === `${HERDR}#12`);
    expect(card).toMatchObject({ state: 'closed', column: 'ccf5765b', capabilities: { close: false } });
    expect(r.cmd('issue.close', { session: 'herdr-3d', id: `${HERDR}#12`, reason: 'completed', confirm: true }).err()).toMatchObject({ code: 'invalid_state' });
  });

  it('a body over 64 KiB or with control characters is refused', () => {
    const r = watch();
    expect(r.cmd('issue.comment', { session: 'herdr-3d', id: `${HERDR}#12`, body: 'x'.repeat(65_537) }).err()).toMatchObject({ code: 'bad_request' });
    expect(r.cmd('issue.comment', { session: 'herdr-3d', id: `${HERDR}#12`, body: 'a\u0007b' }).err()).toMatchObject({ code: 'bad_request' });
    expect(r.cmd('issue.comment', { session: 'herdr-3d', id: `${HERDR}#12`, body: 'a\n\tb' }).ack()).toBeDefined();
  });

  it('pr.merge: confirmation, red checks, conflicts, and the double-confirmed override', () => {
    const r = watch();
    const merge = (id: string, extra: Record<string, unknown> = {}) => r.cmd('pr.merge', { session: 'herdr-3d', id: `${HERDR}#${id}`, method: 'squash', confirm: true, ...extra });
    expect(r.cmd('pr.merge', { session: 'herdr-3d', id: `${HERDR}#32`, method: 'squash' }).err()).toMatchObject({ code: 'confirmation_required' });
    expect(merge('33').err()).toMatchObject({ code: 'checks_not_green' });
    expect(merge('33', { override: true }).err()).toMatchObject({ code: 'confirmation_required' });
    // Conflicts never merge, override or not.
    expect(merge('35').err()).toMatchObject({ code: 'not_mergeable' });
    expect(merge('35', { override: true, confirm_override: true }).err()).toMatchObject({ code: 'not_mergeable' });
    expect(merge('33', { override: true, confirm_override: true }).ack()?.data).toEqual({ merged: true });
    r.settle();
    const prs = r.boards().prs.at(-1) as BoardPrs;
    expect(prs.prs.map((p) => p.key)).not.toContain('#33');
    // Announced once: on this poll only.
    expect(prs.merged.map((m) => m.key)).toEqual(['#33']);
    r.cmd('sim.boards', { poll: true });
    r.settle();
    expect((r.boards().prs.at(-1) as BoardPrs).merged).toEqual([]);
  });

  it('a merge closes the issues the PR closes and moves them to Done', () => {
    const r = watch();
    r.cmd('pr.merge', { session: 'herdr-3d', id: `${HERDR}#32`, method: 'merge', confirm: true });
    r.settle();
    const c = r.boards().issues.at(-1)?.cards.find((x) => x.id === `${HERDR}#9`);
    expect(c).toMatchObject({ state: 'closed', column: 'ccf5765b' });
  });

  it('a failing poll sends the last good data as stale, with the error, and announces no merge', () => {
    const r = watch();
    r.cmd('sim.boards', { fail: 'GitHub auth' });
    r.settle();
    const i = r.boards().issues.at(-1) as BoardIssues;
    expect(i).toMatchObject({ stale: true, error: 'GitHub auth', initial: false });
    expect(i.cards.length).toBeGreaterThan(5);
  });

  it('worker.open_pr: only a plain worker on a branch the bridge made, retry-safe', () => {
    const r = watch();
    const fixtures = r.store.workers.get('2091a1a6-a768-4be0-a2b7-6878d1d82efc');
    expect(fixtures?.branch).toBe('h3d/waffle-fixtures');
    const prep = r.cmd('worker.open_pr.prepare', { id: fixtures?.id }).ack()?.data as Record<string, unknown>;
    expect(prep).toMatchObject({ can_open: true, branch: 'h3d/waffle-fixtures', base: 'main', dirty: false });
    expect(r.cmd('worker.open_pr', { id: fixtures?.id, title: 'T', body: 'B' }).err()).toMatchObject({ code: 'confirmation_required' });
    const first = r.cmd('worker.open_pr', { id: fixtures?.id, title: 'T', body: 'B', confirm: true }).ack()?.data as { pr: { key: string }; pushed: boolean; existed: boolean };
    expect(first).toMatchObject({ pushed: true, existed: false });
    const again = r.cmd('worker.open_pr', { id: fixtures?.id, title: 'T', body: 'B', confirm: true }).ack()?.data as { pr: { key: string }; existed: boolean };
    expect(again).toMatchObject({ existed: true, pr: { key: first.pr.key } });
    // A freelancer and a worker on a branch of the user's own are refused.
    expect(r.cmd('worker.open_pr.prepare', { id: 'fc018d58-4789-46c2-afac-c062bc9fff9e' }).err()).toMatchObject({ code: 'invalid_state' });
    expect(r.cmd('worker.open_pr.prepare', { id: 'ccc7f455-4cc6-4866-a047-cbe81c377989' }).err()).toMatchObject({ code: 'invalid_state' });
  });
});

describe('run.start with work_item', () => {
  it('starts on a card of the board: the orchestrator’s worker.upsert has work_item and issue, before the ack', () => {
    const r = rig();
    r.cmd('board.watch', { session: 'herdr-3d' });
    const prep = r.cmd('run.prepare', { session: 'herdr-3d', work_item: { provider: 'github', id: `${HERDR}#12` } }).ack()?.data as { prompt: string; ticket: { kind: string; url: string } };
    expect(prep.ticket).toMatchObject({ kind: 'issue', url: `https://github.com/${HERDR}/issues/12` });
    expect(prep.prompt.split('\n')[0]).toBe(`/write-code https://github.com/${HERDR}/issues/12`);
    const start = r.cmd('run.start', { session: 'herdr-3d', desk_index: 12, work_item: { provider: 'github', id: `${HERDR}#12` }, orch: { harness: 'claude', model: 'claude-opus-5-5', effort: 'medium' }, preset: 'p_5eedb0000001' });
    r.settle();
    const got = start.got();
    const upsert = got.findIndex((m) => m.t === 'worker.upsert' && (m.worker as { work_item?: unknown }).work_item !== undefined);
    const ack = got.findIndex((m) => m.t === 'ack');
    expect(upsert).toBeGreaterThanOrEqual(0);
    expect(ack).toBeGreaterThan(upsert);
    expect((got[upsert] as { worker: Msg }).worker).toMatchObject({ role: 'orch', work_item: { provider: 'github', id: `${HERDR}#12` }, issue: { repo: HERDR, number: 12 } });
  });

  it('refuses an id that is not on the board, another provider, and two tickets at once', () => {
    const r = rig();
    expect(r.cmd('run.prepare', { session: 'herdr-3d', work_item: { provider: 'github', id: `${HERDR}#999` } }).err()).toMatchObject({ code: 'not_found' });
    expect(r.cmd('run.prepare', { session: 'herdr-3d', work_item: { provider: 'monday', id: `${HERDR}#12` } }).err()).toMatchObject({ code: 'not_found' });
    expect(r.cmd('run.prepare', { session: 'herdr-3d', issue: 12, work_item: { provider: 'github', id: `${HERDR}#12` } }).err()).toMatchObject({ code: 'bad_request' });
  });
});
