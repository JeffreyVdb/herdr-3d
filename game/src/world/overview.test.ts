import { describe, expect, it } from 'vitest';
import type { Floor, Snapshot, Worker } from '../net/protocol';
import { WorldStore } from './store';
import { buildOverview, countItems, sinceText, visibleRows, type OverviewWorkerRow } from './overview';

const NOW = 1_790_000_000_000;

const floor = (session: string, over: Partial<Floor> = {}): Floor => ({ session, state: 'running', building: 'b1', index: 0, ...over });

const worker = (id: string, session: string, over: Partial<Worker> = {}): Worker => ({
  id,
  session,
  workspace_id: `ws-${id}`,
  label: `label-${id}`,
  name: id,
  status: 'idle',
  status_since: NOW - 60_000,
  ...over,
});

const orch = (id: string, session: string, desk: number, over: Partial<Worker> = {}) =>
  worker(id, session, { role: 'orch', run: `run-${id}`, desk_index: desk, issue: { repo: 'o/r', number: 118, title: 'Floor overview', url: 'https://example.test/118' }, work_item: { provider: 'gh', id: 'o/r#118' }, ...over });
const free = (id: string, session: string, desk: number, role: string, orchId: string | undefined, over: Partial<Worker> = {}) =>
  worker(id, session, { role, run: 'run', desk_index: desk, ...(orchId ? { orch_id: orchId } : {}), round: 1, issue: { repo: 'o/r', number: 118 }, work_item: { provider: 'gh', id: 'o/r#118' }, ...over });

function store(workers: Worker[], floors: Floor[] = [floor('top'), floor('bottom', { index: 1 }), floor('lot', { building: null, index: null })]): WorldStore {
  const s = new WorldStore(NOW);
  const snap: Snapshot = {
    t: 'world.snapshot',
    seq: 1,
    world: { buildings: [{ id: 'b1', name: 'Work', sort: 0, floors: ['top', 'bottom'] }], unassigned: ['lot'], floors, workers },
  };
  s.applySnapshot(snap, NOW);
  return s;
}

const keys = (s: WorldStore, session = 'top', collapsed: ReadonlySet<string> = new Set()) => {
  const t = buildOverview(s, session);
  return visibleRows(t, collapsed).map((r) => `${'  '.repeat(r.depth)}${r.row.key}`);
};

describe('buildOverview: the tree', () => {
  it('is flat without orchestrators: employees by desk', () => {
    const s = store([worker('c', 'top', { desk_index: 2 }), worker('a', 'top', { desk_index: 0 }), worker('b', 'top', { desk_index: 1 }), worker('x', 'bottom')]);
    expect(keys(s)).toEqual(['a', 'b', 'c']);
  });

  it('nests freelancers under their orchestrator: orchestrators by desk, then round, role (code, review, ux, ground), desk; employees last', () => {
    const s = store([
      worker('emp', 'top', { desk_index: 0 }),
      orch('o2', 'top', 9),
      orch('o1', 'top', 1),
      free('rev1', 'top', 3, 'review', 'o1'),
      free('code2', 'top', 5, 'code', 'o1', { round: 2 }),
      free('ground1', 'top', 6, 'ground', 'o1'),
      free('codeA', 'top', 7, 'code', 'o1'),
      free('codeB', 'top', 4, 'code', 'o1'),
      free('ux1', 'top', 8, 'ux', 'o2'),
    ]);
    expect(keys(s)).toEqual(['o1', '  codeB', '  codeA', '  rev1', '  ground1', '  code2', 'o2', '  ux1', 'emp']);
  });

  it('a freelancer whose orchestrator is on another floor sits under a ghost row; one elsewhere whose orchestrator is here stays nested with its floor', () => {
    const s = store([
      orch('far', 'bottom', 0, { name: 'Bramble' }),
      free('lost', 'top', 2, 'code', 'far'),
      orch('home', 'top', 1),
      free('away', 'bottom', 3, 'review', 'home'),
      free('here', 'top', 4, 'code', 'home'),
    ]);
    expect(keys(s)).toEqual(['home', '  here', '  away', 'ghost:far', '  lost']);
    const t = buildOverview(s, 'top');
    const ghost = t.nodes.find((n) => n.row.kind === 'ghost')?.row;
    expect(ghost).toMatchObject({ kind: 'ghost', id: 'far', name: 'Bramble', floor: 'Floor 1' });
    const away = t.nodes[0]?.children.find((c) => c.id === 'away');
    expect(away?.floor).toBe('Floor 1');
    expect(t.nodes[0]?.children.find((c) => c.id === 'here')?.floor).toBeNull();
  });

  it('puts freelancers with no orchestrator (or one that is gone) in an Unlinked group, before the employees', () => {
    const s = store([worker('emp', 'top', { desk_index: 0 }), free('solo', 'top', 2, 'code', undefined), free('orphan', 'top', 1, 'review', 'gone')]);
    expect(keys(s)).toEqual(['unlinked', '  solo', '  orphan', 'emp']);
  });

  it('hides a collapsed group’s children', () => {
    const s = store([orch('o1', 'top', 0), free('c1', 'top', 1, 'code', 'o1'), worker('emp', 'top', { desk_index: 5 })]);
    expect(keys(s, 'top', new Set(['o1']))).toEqual(['o1', 'emp']);
    const rows = visibleRows(buildOverview(s, 'top'), new Set(['o1']));
    expect(rows[0]).toMatchObject({ expandable: true, expanded: false, depth: 0 });
    expect(rows[1]).toMatchObject({ expandable: false, depth: 0 });
  });

  it('keeps the order when only statuses change', () => {
    const ws = [orch('o1', 'top', 4), free('c1', 'top', 2, 'code', 'o1'), free('r1', 'top', 1, 'review', 'o1'), worker('emp', 'top', { desk_index: 0 })];
    const before = keys(store(ws));
    const busy = ws.map((w, i) => ({ ...w, status: ['working', 'blocked', 'done', 'idle'][i] as string, status_since: NOW - i * 1000 }));
    expect(keys(store(busy))).toEqual(before);
  });

  it('an empty floor has no rows', () => {
    const t = buildOverview(store([worker('x', 'bottom')]), 'top');
    expect(t.nodes).toEqual([]);
    expect(t.total).toBe(0);
  });
});

describe('buildOverview: a row', () => {
  const row = (s: WorldStore, id: string): OverviewWorkerRow => {
    const t = buildOverview(s, 'top');
    const all = t.nodes.flatMap((n) => [n.row, ...n.children]);
    const r = all.find((x) => x.kind === 'worker' && x.id === id);
    if (!r || r.kind !== 'worker') throw new Error(`no row ${id}`);
    return r;
  };

  it('takes its light from the store’s display (the top bar’s), with name, harness, model and since', () => {
    const s = store([worker('a', 'top', { status: 'working', harness: 'claude', model: 'claude-opus-5-5', effort: 'high', status_since: NOW - 4 * 60_000 })]);
    const r = row(s, 'a');
    expect(r).toMatchObject({ display: s.workerView('a')?.display, name: 'a', model: 'claude opus-5-5 high', role: null, tag: null });
    expect(sinceText(r.display, r.since, NOW)).toBe('working 4m');
  });

  it('an orchestrator: role, phase, pass, over-cap and its ticket with the issue’s title', () => {
    const s = store([orch('o', 'top', 0, { phase: 'waiting_user', pass: 3 })]);
    const r = row(s, 'o');
    expect(r).toMatchObject({ role: 'orch', tag: 'ORCH', orch: { phase: 'waiting for you', pass: 'pass 3 of 3', overCap: true } });
    expect(r.ticket).toEqual({ key: '#118', title: 'Floor overview', item: { session: 'top', id: 'o/r#118' }, url: 'https://example.test/118' });
    expect(r.display).toBe('needs_you');
  });

  it('a freelancer shows its ticket only when it differs from its orchestrator’s', () => {
    const s = store([
      orch('o', 'top', 0),
      free('same', 'top', 1, 'code', 'o'),
      free('other', 'top', 2, 'review', 'o', { issue: { repo: 'o/r', number: 7, title: 'Another' }, work_item: { provider: 'gh', id: 'o/r#7' } }),
    ]);
    expect(row(s, 'same').ticket).toBeNull();
    expect(row(s, 'other').ticket).toMatchObject({ key: '#7', title: 'Another' });
    expect(row(s, 'same').tag).toBe('CODE r1');
  });

  it('a one-off worker’s task, and every worker’s now line from the digest: the recap, else its title; the activity chip apart', () => {
    const s = store([
      worker('recap', 'top', { desk_index: 0, digest: { task: 'Fix the flaky e2e', task_source: 'ai_title', now: 'Waiting for review', now_source: 'recap', now_at: NOW } }),
      worker('title', 'top', { desk_index: 1, status: 'working', title: 'Reading hub.go', activity: { kind: 'testing', detail: 'pytest', since: NOW, source: 'rule' }, digest: { task: 'Port it', task_source: 'prompt', now_source: 'title' } }),
      worker('fresh', 'top', { desk_index: 2, title: 'Claude Code' }),
      worker('llm', 'top', { desk_index: 3, digest: { task: 'x', task_source: 'llm', now: 'y', now_source: 'llm' } }),
    ]);
    expect(row(s, 'recap')).toMatchObject({ task: { text: 'Fix the flaky e2e', source: 'ai_title', llm: false }, now: { text: 'Waiting for review', source: 'recap', llm: false }, activity: null });
    expect(row(s, 'title')).toMatchObject({ task: { text: 'Port it', source: 'prompt' }, now: { text: 'Reading hub.go', source: 'title' }, activity: 'Testing · pytest' });
    // No turn read yet (no digest): no task or now line.
    expect(row(s, 'fresh')).toMatchObject({ task: null, now: null });
    expect(row(s, 'llm')).toMatchObject({ task: { llm: true }, now: { llm: true } });
  });

  it('crew members have no task line; a finished freelancer’s now is its report’s summary', () => {
    const s = store([
      orch('o', 'top', 0, { digest: { task: 'orch task', task_source: 'prompt', now: 'Waiting', now_source: 'recap' } }),
      free('done', 'top', 1, 'code', 'o', { status: 'done', report: { state: 'ready', summary: 'Added the tracker and its tests.' }, digest: { now_source: 'title' }, title: 'Done' }),
    ]);
    expect(row(s, 'o').task).toBeNull();
    expect(row(s, 'o').now).toMatchObject({ text: 'Waiting', source: 'recap' });
    expect(row(s, 'done').now).toEqual({ text: 'Added the tracker and its tests.', source: 'report', llm: false });
  });

  it('an asleep floor’s workers are asleep', () => {
    const s = store([worker('a', 'top', { status: 'working' })], [floor('top', { state: 'asleep' })]);
    expect(row(s, 'a').display).toBe('asleep');
  });
});

describe('counts and times', () => {
  it('countItems are the top bar’s numbers', () => {
    const s = store([
      worker('w', 'top', { status: 'working' }),
      worker('b', 'top', { status: 'blocked' }),
      worker('d', 'top', { status: 'done' }),
      worker('i', 'top', { status: 'idle' }),
      worker('t', 'top', { status: 'idle', activity: { kind: 'waiting', since: NOW, source: 'derived', tasks: 1 } }),
    ]);
    const v = s.floorView('top');
    if (!v) throw new Error('no floor');
    expect(countItems(v.counts, false)).toEqual([
      { kind: 'working', n: 1, label: 'working' },
      { kind: 'needs_you', n: 1, label: 'needs you' },
      { kind: 'waiting', n: 1, label: 'waiting' },
      { kind: 'idle', n: 2, label: 'idle' },
    ]);
    expect(countItems({ ...v.counts, waiting: 0, needsYou: 2 }, false).map((c) => c.label)).toEqual(['working', 'need you', 'idle']);
    expect(countItems(v.counts, true)).toEqual([{ kind: 'asleep', n: 5, label: 'asleep' }]);
  });

  it('sinceText', () => {
    expect(sinceText('working', NOW - 20_000, NOW)).toBe('working <1m');
    expect(sinceText('needs_you', NOW - 4 * 60_000, NOW)).toBe('needs you 4m');
    expect(sinceText('idle', NOW - 125 * 60_000, NOW)).toBe('idle 2h 05m');
    expect(sinceText('done', NOW - 3 * 86_400_000, NOW)).toBe('done 3d');
    expect(sinceText('idle', NOW + 5000, NOW)).toBe('idle <1m');
  });
});
