import { describe, expect, it } from 'vitest';
import type { Building, Floor, Snapshot, Worker } from '../net/protocol';
import { WorldStore } from './store';
import { buildCityOverview, buildOverview, cityCountItems, filterOverview, hiddenText, sleepyFloors, visibleRows, type CityOverviewTree, type OverviewTree } from './overview';

// #188: the all-floors overview: every floor of the city, its workers under it; and the active-only filter.

const NOW = 1_790_000_000_000;

const floor = (session: string, building: string | null, index: number | null, over: Partial<Floor> = {}): Floor => ({ session, state: 'running', building, index, ...over });

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
  worker(id, session, { role: 'orch', run: `run-${id}`, desk_index: desk, issue: { repo: 'o/r', number: 188, title: 'All floors' }, work_item: { provider: 'gh', id: 'o/r#188' }, ...over });
const free = (id: string, session: string, desk: number, role: string, orchId: string | undefined, over: Partial<Worker> = {}) =>
  worker(id, session, { role, run: 'run', desk_index: desk, ...(orchId ? { orch_id: orchId } : {}), round: 1, issue: { repo: 'o/r', number: 188 }, work_item: { provider: 'gh', id: 'o/r#188' }, ...over });

/** Two buildings (Work: top over bottom; Home: den, sorted after Work although listed first) and a floor in the lot. */
function store(workers: Worker[], over: Record<string, Partial<Floor>> = {}): WorldStore {
  const s = new WorldStore(NOW);
  const buildings: Building[] = [
    { id: 'b2', name: 'Home', sort: 1, floors: ['den'] },
    { id: 'b1', name: 'Work', sort: 0, floors: ['top', 'bottom'] },
  ];
  const floors = [floor('top', 'b1', 0), floor('bottom', 'b1', 1), floor('den', 'b2', 0), floor('lot', null, null)].map((f) => ({ ...f, ...over[f.session] }));
  const snap: Snapshot = { t: 'world.snapshot', seq: 1, world: { buildings, unassigned: ['lot'], floors, workers } };
  s.applySnapshot(snap, NOW);
  return s;
}

/** The tree as indented keys (every group expanded unless `collapsed` says so). */
const keys = (t: OverviewTree | CityOverviewTree, collapsed: ReadonlySet<string> = new Set()) => visibleRows(t, collapsed).map((r) => `${'  '.repeat(r.depth)}${r.row.key}`);

const ids = (t: CityOverviewTree) => t.floors.flatMap((f) => f.nodes.flatMap((n) => [n.row, ...n.children])).flatMap((r) => (r.kind === 'worker' ? [r.id] : []));

describe('buildCityOverview: the floors', () => {
  it('lists buildings by sort, each building’s floors top floor first (the Buildings panel’s order), then the lot', () => {
    const t = buildCityOverview(store([]));
    expect(t.floors.map((f) => f.row.key)).toEqual(['floor:top', 'floor:bottom', 'floor:den', 'floor:lot']);
  });

  it('a floor row: its label (`Floor 2 · Work`, the session in the lot), the top bar’s counts, asleep', () => {
    const s = store([worker('w', 'top', { status: 'working' }), worker('b', 'top', { status: 'blocked' }), worker('i', 'top'), worker('z', 'den', { status: 'working' })], { den: { state: 'asleep' } });
    const t = buildCityOverview(s);
    const [top, bottom, den, lot] = t.floors.map((f) => f.row);
    expect(top).toMatchObject({ kind: 'floor', key: 'floor:top', floor: 'top', name: 'top', label: 'Floor 2 · Work', asleep: false, total: 3 });
    expect(top?.counts.map((c) => [c.kind, c.n])).toEqual([
      ['working', 1],
      ['needs_you', 1],
      ['idle', 1],
    ]);
    expect(bottom).toMatchObject({ label: 'Floor 1 · Work', total: 0 });
    expect(den).toMatchObject({ label: 'Floor 1 · Home', asleep: true, total: 1, counts: [{ kind: 'asleep', n: 1, label: 'asleep' }] });
    expect(lot).toMatchObject({ label: 'lot', asleep: false });
    expect(t.total).toBe(4);
  });

  it('under each floor, that floor’s tree one level deeper: orchestrators over freelancers, Unlinked, everyone else', () => {
    const s = store([worker('emp', 'top', { desk_index: 0 }), orch('o1', 'top', 1), free('c1', 'top', 2, 'code', 'o1'), free('solo', 'top', 3, 'code', undefined), worker('d1', 'den')]);
    expect(keys(buildCityOverview(s))).toEqual(['floor:top', '  o1', '    c1', '  unlinked:top', '    solo', '  emp', 'floor:bottom', 'floor:den', '  d1', 'floor:lot']);
  });

  it('an empty city has no floors', () => {
    const s = new WorldStore(NOW);
    s.applySnapshot({ t: 'world.snapshot', seq: 1, world: { buildings: [], unassigned: [], floors: [], workers: [] } }, NOW);
    expect(buildCityOverview(s)).toEqual({ floors: [], total: 0 });
  });
});

describe('buildCityOverview: each worker exactly once', () => {
  // A run that spans two floors: Bramble orchestrates on top; Ash codes on the bottom floor, Elm reviews in the lot.
  const span = () =>
    store([
      orch('bramble', 'top', 0, { name: 'Bramble' }),
      free('here', 'top', 1, 'code', 'bramble'),
      free('ash', 'bottom', 0, 'code', 'bramble'),
      free('elm', 'lot', 0, 'review', 'bramble'),
      free('orphan', 'bottom', 1, 'review', 'gone'),
      worker('emp', 'bottom', { desk_index: 2 }),
    ]);

  it('a freelancer sits under its orchestrator, on the orchestrator’s floor, tagged with its own floor; no ghost rows', () => {
    const t = buildCityOverview(span());
    expect(keys(t)).toEqual(['floor:top', '  bramble', '    ash', '    here', '    elm', 'floor:bottom', '  unlinked:bottom', '    orphan', '  emp', 'floor:den', 'floor:lot']);
    const kids = t.floors[0]?.nodes[0]?.children ?? [];
    expect(kids.map((k) => [k.id, k.floor])).toEqual([
      ['ash', 'Floor 1'], // by round, role, then desk: wherever it sits
      ['here', null],
      ['elm', 'lot'],
    ]);
    expect(t.floors.flatMap((f) => f.nodes).some((n) => n.row.kind === 'ghost')).toBe(false);
  });

  it('lists every worker of the city once (the floor pages list the cross-floor run twice between them)', () => {
    const s = span();
    const t = buildCityOverview(s);
    const all = ids(t);
    expect(all.sort()).toEqual([...s.workers.keys()].sort());
    expect(new Set(all).size).toBe(all.length);
    expect(t.total).toBe(all.length);
    // The floor pages, unchanged: the bottom floor's still shows Ash under a ghost of Bramble.
    expect(keys(buildOverview(s, 'bottom'))).toEqual(['ghost:bramble', '  ash', 'unlinked', '  orphan', 'emp']);
  });

  it('Unlinked holds only freelancers whose orchestrator is truly gone (or none), under their own floor', () => {
    const s = store([free('a', 'top', 0, 'code', undefined), free('b', 'lot', 0, 'code', 'gone'), worker('notorch', 'den'), free('c', 'den', 1, 'code', 'notorch')]);
    expect(keys(buildCityOverview(s))).toEqual(['floor:top', '  unlinked:top', '    a', 'floor:bottom', 'floor:den', '  unlinked:den', '    c', '  notorch', 'floor:lot', '  unlinked:lot', '    b']);
  });

  it('a freelancer drops the ticket it shares with its orchestrator, as on the floor page', () => {
    const t = buildCityOverview(span());
    expect(t.floors[0]?.nodes[0]?.row).toMatchObject({ ticket: { key: '#188' } });
    expect(t.floors[0]?.nodes[0]?.children.every((c) => c.ticket === null)).toBe(true);
  });
});

describe('visibleRows: three levels', () => {
  const s = () => store([orch('o1', 'top', 0), free('c1', 'top', 1, 'code', 'o1'), worker('emp', 'top', { desk_index: 2 }), worker('d1', 'den')]);

  it('floor at depth 0, its orchestrators and employees at 1, freelancers at 2, each with its parent', () => {
    const rows = visibleRows(buildCityOverview(s()), new Set());
    expect(rows.map((r) => [r.row.key, r.depth, r.parent, r.expandable, r.expanded])).toEqual([
      ['floor:top', 0, null, true, true],
      ['o1', 1, 'floor:top', true, true],
      ['c1', 2, 'o1', false, false],
      ['emp', 1, 'floor:top', false, false],
      ['floor:bottom', 0, null, false, false],
      ['floor:den', 0, null, true, true],
      ['d1', 1, 'floor:den', false, false],
      ['floor:lot', 0, null, false, false],
    ]);
  });

  it('a collapsed floor hides everything under it, a collapsed orchestrator inside it included; opened again, the orchestrator stays folded', () => {
    const t = buildCityOverview(s());
    expect(keys(t, new Set(['floor:top', 'o1']))).toEqual(['floor:top', 'floor:bottom', 'floor:den', '  d1', 'floor:lot']);
    expect(keys(t, new Set(['o1']))).toEqual(['floor:top', '  o1', '  emp', 'floor:bottom', 'floor:den', '  d1', 'floor:lot']);
  });

  it('the floor page’s rows are as before: depth 0 and 1', () => {
    const rows = visibleRows(buildOverview(s(), 'top'), new Set());
    expect(rows.map((r) => [r.row.key, r.depth, r.parent])).toEqual([
      ['o1', 0, null],
      ['c1', 1, 'o1'],
      ['emp', 0, null],
    ]);
  });

  it('asleep floors are the ones that start collapsed', () => {
    const t = buildCityOverview(store([worker('d1', 'den')], { den: { state: 'asleep' }, lot: { state: 'asleep' } }));
    expect(sleepyFloors(t)).toEqual(['floor:den', 'floor:lot']);
  });
});

describe('filterOverview: active only', () => {
  it('keeps the active workers and every parent of one; drops the rest and counts them', () => {
    const s = store([
      orch('o1', 'top', 0), // idle, with a working freelancer: stays
      free('c1', 'top', 1, 'code', 'o1', { status: 'working' }),
      free('r1', 'top', 2, 'review', 'o1', { status: 'done' }),
      orch('o2', 'top', 3, { status: 'blocked' }), // needs you, its crew idle: stays alone
      free('u1', 'top', 4, 'ux', 'o2'),
      free('solo', 'top', 5, 'code', undefined, { status: 'idle' }),
      worker('emp', 'top', { desk_index: 6, status: 'idle', activity: { kind: 'waiting', since: NOW, source: 'derived', tasks: 1 } }),
      worker('lazy', 'top', { desk_index: 7 }),
    ]);
    const { tree, hidden } = filterOverview(buildOverview(s, 'top'));
    expect(keys(tree)).toEqual(['o1', '  c1', 'o2', 'emp']);
    expect(hidden).toEqual({ idle: 4, asleep: 0, floors: 0, asleepFloors: 0, asleepOnFloors: 0 });
    expect(tree.total).toBe(8); // the header's numbers are never filtered
    expect(hiddenText(hidden, 'floor')).toBe('4 idle hidden');
  });

  it('city: a floor stays while any of its workers is active, wherever the tree nests them; a quiet or asleep floor goes', () => {
    const s = store(
      [
        orch('o1', 'top', 0),
        free('far', 'bottom', 0, 'code', 'o1', { status: 'working' }), // nested on top: top stays, bottom has nobody active
        worker('b1', 'bottom', { desk_index: 1 }),
        worker('d1', 'den', { status: 'working' }),
        worker('l1', 'lot', { status: 'working' }),
        worker('l2', 'lot'),
      ],
      { den: { state: 'asleep' } },
    );
    const { tree, hidden } = filterOverview(buildCityOverview(s));
    expect(keys(tree)).toEqual(['floor:top', '  o1', '    far', 'floor:lot', '  l1']);
    expect(hidden).toEqual({ idle: 2, asleep: 1, floors: 2, asleepFloors: 1, asleepOnFloors: 1 });
    expect(hiddenText(hidden, 'city')).toBe('2 idle hidden · 1 floor asleep');
  });

  it('the hidden summary says what it hides, and nothing when nothing is', () => {
    expect(hiddenText({ idle: 12, asleep: 30, floors: 4, asleepFloors: 3, asleepOnFloors: 30 }, 'city')).toBe('12 idle hidden · 3 floors asleep');
    expect(hiddenText({ idle: 0, asleep: 8, floors: 1, asleepFloors: 1, asleepOnFloors: 8 }, 'city')).toBe('1 floor asleep');
    expect(hiddenText({ idle: 0, asleep: 0, floors: 1, asleepFloors: 0, asleepOnFloors: 0 }, 'city')).toBe('1 quiet floor hidden');
    expect(hiddenText({ idle: 0, asleep: 8, floors: 0, asleepFloors: 0, asleepOnFloors: 0 }, 'floor')).toBe('8 asleep hidden');
    expect(hiddenText({ idle: 1, asleep: 0, floors: 0, asleepFloors: 0, asleepOnFloors: 0 }, 'floor')).toBe('1 idle hidden');
    expect(hiddenText({ idle: 0, asleep: 0, floors: 0, asleepFloors: 0, asleepOnFloors: 0 }, 'city')).toBe('');
    // Asleep workers whose floor still shows (an active freelancer keeps their orchestrator's asleep floor up).
    expect(hiddenText({ idle: 0, asleep: 1, floors: 0, asleepFloors: 0, asleepOnFloors: 0 }, 'city')).toBe('1 asleep hidden');
    expect(hiddenText({ idle: 2, asleep: 5, floors: 2, asleepFloors: 1, asleepOnFloors: 3 }, 'city')).toBe('2 idle hidden · 2 asleep hidden · 1 floor asleep');
  });

  it('city: an asleep worker hidden under a floor that still shows is said, and the summary is never empty while anything is hidden', () => {
    const s = store(
      [
        orch('o', 'top', 0), // asleep, kept: its freelancer on another floor is working
        free('r', 'top', 1, 'review', 'o'), // asleep, hidden
        free('c', 'bottom', 0, 'code', 'o', { status: 'working' }),
        worker('b', 'bottom', { desk_index: 1, status: 'working' }),
        worker('d', 'den', { status: 'working' }),
        worker('l', 'lot', { status: 'working' }),
      ],
      { top: { state: 'asleep' } },
    );
    const { tree, hidden } = filterOverview(buildCityOverview(s));
    expect(keys(tree)).toEqual(['floor:top', '  o', '    c', 'floor:bottom', '  b', 'floor:den', '  d', 'floor:lot', '  l']);
    expect(hidden).toEqual({ idle: 0, asleep: 1, floors: 0, asleepFloors: 0, asleepOnFloors: 0 });
    expect(hiddenText(hidden, 'city')).toBe('1 asleep hidden');
  });

  it('never reorders: the filtered rows keep the tree’s order', () => {
    const ws = [worker('a', 'top', { desk_index: 0, status: 'working' }), worker('b', 'top', { desk_index: 1 }), worker('c', 'top', { desk_index: 2, status: 'blocked' })];
    expect(keys(filterOverview(buildOverview(store(ws), 'top')).tree)).toEqual(['a', 'c']);
  });
});

describe('cityCountItems: the whole system', () => {
  it('sums the awake floors’ counts and adds the asleep floors’ workers as asleep', () => {
    const s = store([worker('w', 'top', { status: 'working' }), worker('i', 'bottom'), worker('d', 'bottom', { status: 'done' }), worker('z1', 'den'), worker('z2', 'den')], { den: { state: 'asleep' } });
    expect(cityCountItems(s.city().flatMap((b) => b.floors)).map((c) => [c.kind, c.n, c.label])).toEqual([
      ['working', 1, 'working'],
      ['needs_you', 0, 'need you'],
      ['idle', 2, 'idle'],
      ['asleep', 2, 'asleep'],
    ]);
  });

  it('no asleep item while every floor is awake', () => {
    const s = store([worker('w', 'top', { status: 'working' })]);
    expect(cityCountItems(s.city().flatMap((b) => b.floors)).map((c) => c.kind)).toEqual(['working', 'needs_you', 'idle']);
  });
});
