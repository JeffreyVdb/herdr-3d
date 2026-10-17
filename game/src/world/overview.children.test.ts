import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSnapshot, isWorldEvent, parseMessage, type Child, type Floor, type Snapshot, type Worker } from '../net/protocol';
import { WorldStore } from './store';
import {
  buildCityOverview,
  buildOverview,
  childSinceText,
  cityCountItems,
  countItems,
  endedChildGroups,
  filterOverview,
  hiddenText,
  visibleRows,
  type CityOverviewTree,
  type OverviewChildRow,
  type OverviewTree,
} from './overview';

// #24 (phase 3 of #20): native child agents on the board's tree, under the worker that owns them, to any depth.

const NOW = 1_790_000_000_000;

const worker = (id: string, session: string, over: Partial<Worker> = {}): Worker => ({
  id,
  session,
  workspace_id: `ws-${id}`,
  label: `label-${id}`,
  name: id,
  status: 'idle',
  status_since: NOW - 60_000,
  child_generation: 1,
  ...over,
});
const orch = (id: string, session: string, desk: number) => worker(id, session, { role: 'orch', run: `run-${id}`, desk_index: desk, status: 'working' });
const free = (id: string, session: string, desk: number, orchId: string, over: Partial<Worker> = {}) =>
  worker(id, session, { role: 'code', run: 'run', desk_index: desk, orch_id: orchId, round: 1, ...over });

let at = 0;
const child = (id: string, workerId: string, over: Partial<Child> = {}): Child => ({
  id,
  provider: 'claude',
  worker_id: workerId,
  agent_session: `s-${workerId}`,
  generation: 1,
  parent: 'root',
  state: 'running',
  source: 'fixture',
  transcript: 'available',
  started_at: NOW - 600_000 + ++at,
  ...over,
});
const sub = (id: string, workerId: string, parent: string, over: Partial<Child> = {}) => child(id, workerId, { parent: 'child', parent_id: parent, ...over });

const unstarted = (c: Child): Child => {
  delete c.started_at;
  return c;
};

function store(workers: Worker[], children: Child[] = []): WorldStore {
  const s = new WorldStore(NOW);
  const floors: Floor[] = [
    { session: 'top', state: 'running', building: 'b1', index: 0 },
    { session: 'bottom', state: 'running', building: 'b1', index: 1 },
  ];
  const snap: Snapshot = {
    t: 'world.snapshot',
    seq: 1,
    world: { buildings: [{ id: 'b1', name: 'Work', sort: 0, floors: ['top', 'bottom'] }], unassigned: [], floors, workers, children },
  };
  s.applySnapshot(snap, NOW);
  return s;
}

const keys = (t: OverviewTree | CityOverviewTree, collapsed: ReadonlySet<string> = new Set()) => visibleRows(t, collapsed).map((r) => `${'  '.repeat(r.depth)}${r.row.key}`);
const childRows = (t: OverviewTree) => visibleRows(t, new Set()).flatMap((v) => (v.row.kind === 'child' ? [v.row] : []));

/** An orchestrator with two freelancers, one of them over a subagent over its own; the orchestrator's own subagent; an employee's. */
function crew(): WorldStore {
  return store(
    [orch('o1', 'top', 0), free('f1', 'top', 1, 'o1'), free('f2', 'top', 2, 'o1'), worker('emp', 'top', { desk_index: 3 })],
    [child('ch-o', 'o1'), child('ch-f1', 'f1'), sub('ch-f1a', 'f1', 'ch-f1'), sub('ch-f1b', 'f1', 'ch-f1a'), child('ch-e', 'emp')],
  );
}

describe('#24 buildOverview: native children', () => {
  it('nest under the worker that owns them: an ordinary worker, an orchestrator (after its freelancers) and a freelancer, to any depth', () => {
    expect(keys(buildOverview(crew(), 'top'))).toEqual([
      'o1',
      '  f1',
      '    child:ch-f1',
      '      child:ch-f1a',
      '        child:ch-f1b',
      '  f2',
      '  child:ch-o',
      'emp',
      '  child:ch-e',
    ]);
  });

  it('on the all-floors page too, a floor deeper: a freelancer’s subagent at 3, its own at 4 and 5', () => {
    const t = buildCityOverview(crew());
    expect(keys(t)).toEqual([
      'floor:top',
      '  o1',
      '    f1',
      '      child:ch-f1',
      '        child:ch-f1a',
      '          child:ch-f1b',
      '    f2',
      '    child:ch-o',
      '  emp',
      '    child:ch-e',
      'floor:bottom',
    ]);
  });

  it('a freelancer on another floor brings its children along under its orchestrator', () => {
    const s = store([orch('o1', 'top', 0), free('away', 'bottom', 0, 'o1')], [child('ch-a', 'away')]);
    expect(keys(buildOverview(s, 'top'))).toEqual(['o1', '  away', '    child:ch-a']);
  });

  it('a row says what the child is: provider, name else type, type beside a name, description, state, times, transcript', () => {
    const s = store(
      [worker('w', 'top')],
      [
        child('a', 'w', { provider: 'codex', name: 'Ada', type: 'explorer', description: '  Map the\nhub  ', state: 'idle', last_activity_at: NOW - 120_000, transcript: 'pending' }),
        child('b', 'w', { type: 'Explore', state: 'completed', ended_at: NOW - 60_000 }),
        child('c', 'w', { state: 'unknown', transcript: 'unavailable' }),
      ],
    );
    const [a, b, c] = childRows(buildOverview(s, 'top'));
    expect(a).toMatchObject({ kind: 'child', key: 'child:a', id: 'a', workerId: 'w', provider: 'codex', name: 'Ada', type: 'explorer', description: 'Map the hub', state: 'idle', unresolved: false, transcript: 'pending' });
    expect(b).toMatchObject({ name: 'Explore', type: null, description: null, state: 'completed' });
    expect(c).toMatchObject({ name: 'Subagent', type: null, state: 'unknown', transcript: 'unavailable' });
  });

  it('keeps the order of childTree (start, native id, name, row id), not the order they came in', () => {
    const s = store([worker('w', 'top')], [child('late', 'w', { started_at: NOW - 1000 }), child('early', 'w', { started_at: NOW - 9000 }), unstarted(child('nostart', 'w'))]);
    expect(keys(buildOverview(s, 'top'))).toEqual(['w', '  child:nostart', '  child:early', '  child:late']);
  });

  it('unresolved: shown at the top of the worker’s tree, marked, never as if the worker started it; a dangling parent too', () => {
    const s = store(
      [worker('w', 'top')],
      [child('root', 'w'), child('lost', 'w', { parent: 'unresolved' }), sub('dangling', 'w', 'gone'), sub('kid', 'w', 'root')],
    );
    const t = buildOverview(s, 'top');
    expect(keys(t)).toEqual(['w', '  child:root', '    child:kid', '  child:lost', '  child:dangling']);
    const by = new Map(childRows(t).map((r) => [r.id, r]));
    expect([...by.values()].map((r) => [r.id, r.unresolved])).toEqual([
      ['root', false],
      ['kid', false],
      ['lost', true],
      ['dangling', true],
    ]);
  });

  it('a ghost orchestrator shows none of its own children here (they are on its floor’s board)', () => {
    const s = store([orch('far', 'bottom', 0), free('here', 'top', 0, 'far')], [child('ch-far', 'far'), child('ch-here', 'here')]);
    expect(keys(buildOverview(s, 'top'))).toEqual(['ghost:far', '  here', '    child:ch-here']);
  });
});

describe('#24 totals and counts: workers only', () => {
  it('total, the counts, the city’s numbers and a floor row’s total are the same with children and without', () => {
    const workers = [orch('o1', 'top', 0), free('f1', 'top', 1, 'o1', { status: 'working' }), worker('emp', 'top', { desk_index: 3, status: 'blocked' }), worker('b', 'bottom')];
    const kids = [child('a', 'o1'), child('b', 'f1'), sub('c', 'f1', 'b'), child('d', 'emp', { state: 'completed' }), child('e', 'b')];
    const without = store(workers);
    const withKids = store(workers, kids);
    expect(withKids.children.of('f1')).toHaveLength(2);
    for (const f of ['top', 'bottom']) {
      expect(buildOverview(withKids, f).total).toBe(buildOverview(without, f).total);
      const [a, b] = [withKids.floorView(f), without.floorView(f)];
      expect(countItems(a!.counts, a!.asleep)).toEqual(countItems(b!.counts, b!.asleep));
    }
    expect(buildOverview(withKids, 'top').total).toBe(3);
    const city = (s: WorldStore) => {
      const t = buildCityOverview(s);
      return { total: t.total, floors: t.floors.map((f) => [f.row.total, f.row.counts]), counts: cityCountItems(s.city().flatMap((b) => b.floors)) };
    };
    expect(city(withKids)).toEqual(city(without));
    expect(city(withKids).total).toBe(4);
  });
});

describe('#24 active only', () => {
  it('a running child is active and keeps its idle worker (and its orchestrator) up; the others go, counted as subagents', () => {
    const s = store(
      [orch('o1', 'top', 0), free('f1', 'top', 1, 'o1'), worker('emp', 'top', { desk_index: 2 }), worker('quiet', 'top', { desk_index: 3 })],
      [child('run', 'f1'), sub('done', 'f1', 'run', { state: 'completed' }), child('idle', 'emp', { state: 'idle' }), child('off', 'quiet', { state: 'shut_down' }), child('o-run', 'o1')],
    );
    const { tree, hidden } = filterOverview(buildOverview(s, 'top'));
    expect(keys(tree)).toEqual(['o1', '  f1', '    child:run', '  child:o-run']);
    expect(hidden).toEqual({ idle: 2, asleep: 0, floors: 0, asleepFloors: 0, asleepOnFloors: 0, subagents: 3 });
    expect(hiddenText(hidden, 'floor')).toBe('2 idle hidden · 3 subagents hidden');
    expect(hiddenText({ ...hidden, idle: 0, subagents: 1 }, 'city')).toBe('1 subagent hidden');
    expect(hiddenText({ ...hidden, subagents: 0 }, 'floor')).toBe('2 idle hidden');
  });

  it('unknown and idle children are not active (no evidence of work, reusable): they never hold a worker up', () => {
    const s = store([worker('w', 'top')], [child('u', 'w', { state: 'unknown' }), child('i', 'w', { state: 'idle' })]);
    const { tree, hidden } = filterOverview(buildOverview(s, 'top'));
    expect(tree.nodes).toEqual([]);
    expect(hidden).toMatchObject({ idle: 1, subagents: 2 });
  });
});

describe('#24 visibleRows: depth, wires and default folds', () => {
  it('says, for each level down to the row’s own, whether a sibling follows (the wires run on)', () => {
    const rows = visibleRows(buildOverview(crew(), 'top'), new Set());
    expect(rows.map((r) => [r.row.key, r.depth, r.parent, r.more])).toEqual([
      ['o1', 0, null, []],
      ['f1', 1, 'o1', [true]],
      ['child:ch-f1', 2, 'f1', [true, false]],
      ['child:ch-f1a', 3, 'child:ch-f1', [true, false, false]],
      ['child:ch-f1b', 4, 'child:ch-f1a', [true, false, false, false]],
      ['f2', 1, 'o1', [true]],
      ['child:ch-o', 1, 'o1', [false]],
      ['emp', 0, null, []],
      ['child:ch-e', 1, 'emp', [false]],
    ]);
    expect(rows.filter((r) => r.expandable).map((r) => r.row.key)).toEqual(['o1', 'f1', 'child:ch-f1', 'child:ch-f1a', 'emp']);
  });

  it('collapses at any depth: a collapsed child hides its whole subtree, a collapsed freelancer its children', () => {
    const t = buildOverview(crew(), 'top');
    expect(keys(t, new Set(['child:ch-f1a']))).toContain('      child:ch-f1a');
    expect(keys(t, new Set(['child:ch-f1a']))).not.toContain('        child:ch-f1b');
    expect(keys(t, new Set(['f1']))).toEqual(['o1', '  f1', '  f2', '  child:ch-o', 'emp', '  child:ch-e']);
  });

  it('an ended child’s own children start folded (endedChildGroups); a running or idle one’s, and a worker’s, do not', () => {
    const s = store(
      [worker('w', 'top')],
      [child('done', 'w', { state: 'completed' }), sub('d1', 'w', 'done', { state: 'completed' }), child('run', 'w'), sub('r1', 'w', 'run'), child('int', 'w', { state: 'interrupted' }), child('leaf', 'w', { state: 'shut_down' })],
    );
    const t = buildOverview(s, 'top');
    expect(endedChildGroups(t)).toEqual(['child:done']);
    expect(endedChildGroups(buildCityOverview(s))).toEqual(['child:done']);
  });
});

describe('#24 childSinceText', () => {
  const r = (over: Partial<OverviewChildRow>) => ({ state: 'running' as const, startedAt: null, endedAt: null, lastActivityAt: null, ...over });
  it('keeps the six states apart in words, with a time only where one means something', () => {
    expect(childSinceText(r({ startedAt: NOW - 4 * 60_000 }), NOW)).toBe('running 4m');
    expect(childSinceText(r({}), NOW)).toBe('running');
    expect(childSinceText(r({ state: 'completed', startedAt: NOW - 600_000, endedAt: NOW - 420_000 }), NOW)).toBe('completed in 3m');
    expect(childSinceText(r({ state: 'interrupted', startedAt: NOW - 600_000, endedAt: NOW - 300_000 }), NOW)).toBe('interrupted after 5m');
    expect(childSinceText(r({ state: 'shut_down', endedAt: NOW - 120_000 }), NOW)).toBe('shut down 2m ago');
    expect(childSinceText(r({ state: 'shut_down' }), NOW)).toBe('shut down');
    expect(childSinceText(r({ state: 'idle', lastActivityAt: NOW - 120_000 }), NOW)).toBe('idle 2m');
    expect(childSinceText(r({ state: 'idle' }), NOW)).toBe('idle');
    expect(childSinceText(r({ state: 'unknown', startedAt: NOW - 600_000, lastActivityAt: NOW - 1000 }), NOW)).toBe('state unknown');
  });
});

/** A recorded child fixture (game/fixtures/children-<name>.jsonl) played into a store. */
function played(name: string): WorldStore {
  const frames = readFileSync(resolve(import.meta.dirname, `../../fixtures/children-${name}.jsonl`), 'utf8').trim().split('\n').map((l) => parseMessage(l));
  const s = new WorldStore(0);
  const [first, ...rest] = frames;
  if (!first || !isSnapshot(first)) throw new Error('no snapshot');
  s.applySnapshot(first, 0);
  for (const m of rest) if (m && isWorldEvent(m)) s.applyEvent(m, 0);
  return s;
}

describe('#24 the fixtures on the tree', () => {
  it('children-nested: a worker over three generations of Codex children', () => {
    const t = buildOverview(played('nested'), 'office');
    const rows = visibleRows(t, new Set(endedChildGroups(t)));
    expect(rows.map((v) => [v.depth, v.row.kind === 'child' ? `${v.row.name} ${v.row.state}` : v.row.kind])).toEqual([
      [0, 'worker'],
      [1, 'Ada running'],
      [2, 'Bell idle'],
      [3, 'Curie completed'],
    ]);
    expect(t.total).toBe(1);
  });

  it('children-many: thirty children, nested four deep, one unresolved; a finished one’s children folded; the total one worker', () => {
    const t = buildOverview(played('many'), 'office');
    expect(t.total).toBe(1);
    const all = visibleRows(t, new Set());
    expect(all).toHaveLength(31);
    expect(Math.max(...all.map((v) => v.depth))).toBe(4);
    const unresolved = all.flatMap((v) => (v.row.kind === 'child' && v.row.unresolved ? [v.row.description] : []));
    expect(unresolved).toEqual(['Plan the filter for subagents']);
    const review = all.find((v) => v.row.kind === 'child' && v.row.description === 'Review the child row design');
    expect(endedChildGroups(t)).toEqual([review?.row.key]);
    expect(visibleRows(t, new Set(endedChildGroups(t)))).toHaveLength(29);
    const { tree, hidden } = filterOverview(t);
    expect(visibleRows(tree, new Set()).filter((v) => v.row.kind === 'child')).toHaveLength(6); // the six running ones
    expect(hidden).toMatchObject({ idle: 0, subagents: 24 });
  });
});
