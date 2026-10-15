import { describe, expect, it } from 'vitest';
import { BINDINGS, type Scope } from '../input/shortcuts';
import type { Building, Floor, Snapshot, Worker } from '../net/protocol';
import { COMMAND_ORDER, filterCommands, floorList, floorRow, floorsNeedingYou, needsFloorPick, paletteCommands, parseQuery } from './palette';
import { WorldStore } from './store';

const floor = (session: string, building: string | null, over: Partial<Floor> = {}): Floor => ({ session, state: 'running', building, index: 0, ...over });
const worker = (id: string, session: string, status: string): Worker => ({ id, session, workspace_id: `ws-${id}`, label: id, status });

const world = (buildings: Building[], floors: Floor[], workers: Worker[] = [], unassigned: string[] = []): WorldStore => {
  const s = new WorldStore(0);
  const snap: Snapshot = { t: 'world.snapshot', seq: 1, world: { buildings, unassigned, floors, workers } };
  s.applySnapshot(snap);
  return s;
};

const B = (id: string, name: string, floors: string[], sort = 0): Building => ({ id, name, sort, floors });

// Zeta needs you; Acme's two floors do not (one is working); the lot's floor is asleep and needs nobody.
const city = () =>
  world(
    [B('zeta', 'Zeta Corp', ['z-top', 'z-low'], 1), B('acme', 'acme', ['a-two', 'a-one'], 0)],
    [floor('z-top', 'zeta'), floor('z-low', 'zeta', { index: 1 }), floor('a-two', 'acme'), floor('a-one', 'acme', { index: 1 }), floor('scratch', null, { state: 'asleep', index: null })],
    [worker('w1', 'z-low', 'blocked'), worker('w2', 'a-two', 'working'), worker('w3', 'a-one', 'idle'), worker('w4', 'z-top', 'blocked')],
    ['scratch'],
  );

const sessions = (s: WorldStore, q = '') => floorList(s, q).map((i) => i.session);

describe('floors: order', () => {
  it('floors that need you first, then the rest, both by "Building › floor" without regard to case', () => {
    expect(sessions(city())).toEqual(['z-low', 'z-top', 'a-one', 'a-two', 'scratch']);
    expect(floorList(city(), '').map((i) => i.label)).toEqual(['Zeta Corp › z-low', 'Zeta Corp › z-top', 'acme › a-one', 'acme › a-two', 'Unassigned › scratch']);
  });

  it('sorts case-insensitively inside a group', () => {
    const s = world([B('b', 'Beta', ['x-b']), B('a', 'alpha', ['x-a']), B('c', 'Charlie', ['x-c'])], [floor('x-b', 'b'), floor('x-a', 'a'), floor('x-c', 'c')]);
    expect(floorList(s, '').map((i) => i.label)).toEqual(['alpha › x-a', 'Beta › x-b', 'Charlie › x-c']);
  });

  it('a query only filters: the order of the unfiltered list stays', () => {
    const s = city();
    const all = sessions(s);
    for (const q of ['a', 'z', 'one', 'top', '›', 'c']) {
      const some = sessions(s, q);
      expect(some, q).toEqual(all.filter((x) => some.includes(x)));
    }
    // The needs-you floors still lead a filtered list.
    expect(sessions(s, 'a')[0]).toBe('z-low');
  });

  it('matches the building or the floor, and says which characters', () => {
    const s = city();
    expect(floorList(s, 'acme').map((i) => i.session)).toEqual(['a-one', 'a-two']);
    expect(floorList(s, 'one')).toEqual([{ session: 'a-one', label: 'acme › a-one', hits: [9, 10, 11] }]);
    expect(floorList(s, 'zzz')).toEqual([]);
    expect(floorList(s, '  ')).toHaveLength(5);
  });

  it('stays put while counts change: the list is the order, the rows are read live', () => {
    const s = city();
    const list = floorList(s, '');
    const before = list.map((i) => i.session);
    // a-one's worker starts needing you, z-low's stops: a re-read of the rows changes their counts, not their places.
    s.applyEvent({ t: 'worker.status', seq: 2, id: 'w3', session: 'a-one', workspace_id: 'ws-w3', status: 'blocked' });
    s.applyEvent({ t: 'worker.status', seq: 3, id: 'w1', session: 'z-low', workspace_id: 'ws-w1', status: 'working' });
    const rows = list.map((i) => floorRow(s, i, null));
    expect(rows.map((r) => r?.session)).toEqual(before);
    expect(rows.find((r) => r?.session === 'a-one')?.counts.needsYou).toBe(1);
    expect(rows.find((r) => r?.session === 'z-low')?.counts).toMatchObject({ needsYou: 0, working: 1 });
    // Built again (a new query, a reopen), the order follows the counts.
    expect(sessions(s)).toEqual(['a-one', 'z-top', 'a-two', 'scratch', 'z-low']);
  });

  it('a row for a floor that is gone is null, and the "you are here" mark is the one floor', () => {
    const s = city();
    const list = floorList(s, '');
    expect(floorRow(s, list[0]!, 'z-low')).toMatchObject({ here: true, label: 'Zeta Corp › z-low' });
    expect(floorRow(s, list[1]!, 'z-low')?.here).toBe(false);
    s.applyEvent({ t: 'floor.removed', seq: 2, session: 'z-low' });
    expect(floorRow(s, list[0]!, null)).toBeNull();
    expect(floorRow(s, list[1]!, null)?.session).toBe('z-top');
  });

  it('carries the asleep state, and no floors at all is an empty list', () => {
    const s = city();
    expect(floorRow(s, floorList(s, 'scratch')[0]!, null)).toMatchObject({ asleep: true, label: 'Unassigned › scratch' });
    expect(floorList(new WorldStore(0), '')).toEqual([]);
  });

  it('counts the floors that need you', () => {
    expect(floorsNeedingYou(city())).toBe(2);
    expect(floorsNeedingYou(new WorldStore(0))).toBe(0);
  });
});

describe('modes', () => {
  it('a leading @ is the floor list; without it, commands', () => {
    expect(parseQuery('')).toEqual({ mode: 'commands', query: '' });
    expect(parseQuery(' hire ')).toEqual({ mode: 'commands', query: 'hire' });
    expect(parseQuery('@')).toEqual({ mode: 'floors', query: '' });
    expect(parseQuery('@ acme')).toEqual({ mode: 'floors', query: 'acme' });
    expect(parseQuery('a@b')).toEqual({ mode: 'commands', query: 'a@b' });
  });
});

describe('commands', () => {
  const live = (...s: Scope[]) => new Set<Scope>(['any', ...s]);
  const names = (active: Set<Scope>) => paletteCommands(active, false).map((c) => c.name);

  it('lists every palette row of the table, once, in the order the palette keeps', () => {
    const inTable = (BINDINGS as readonly { id: string; palette?: unknown }[]).filter((b) => b.palette).map((b) => b.id);
    for (const id of inTable) expect(COMMAND_ORDER, id).toContain(id);
    for (const id of COMMAND_ORDER) expect([...inTable, 'presets', 'about', 'overview.all', 'bridge.switch'], id).toContain(id);
    expect(new Set(COMMAND_ORDER).size).toBe(COMMAND_ORDER.length);
  });

  it('on a floor: the floor’s rows too; in the city: the buildings, and no floor-only rows', () => {
    const floorNames = names(live('floor'));
    expect(floorNames).toEqual(expect.arrayContaining(['Hire', 'Issues', 'Pull requests', 'Start a run', 'Overview', 'Elevator', 'Buildings', 'Inbox', 'Next who needs you', 'Settings', 'Floor plan', 'Back to the city', 'Team presets', 'About']));
    expect(floorNames.slice(0, 5)).toEqual(['Hire', 'Issues', 'Pull requests', 'Start a run', 'Overview']);
    const cityNames = names(live('city'));
    // The floor-scoped commands are still there (they ask which floor); the ones that need you on a floor are not.
    expect(cityNames).toEqual(expect.arrayContaining(['Hire', 'Issues', 'Pull requests', 'Start a run', 'Overview', 'Buildings', 'Settings', 'Inbox']));
    for (const n of ['Elevator', 'Floor plan', 'Back to the city', 'Level the view']) expect(cityNames, n).not.toContain(n);
  });

  it('leaves out the aimed rows, the Esc rows and the read-only ones', () => {
    const all = names(live('floor', 'city', 'sitting', 'selected', 'plan', 'changes', 'aim:worker', 'aim:desk'));
    for (const n of ['Worker: sit at their laptop', 'Stand up', 'Get up from your desk', 'Close the floor plan', 'Walk']) expect(all).not.toContain(n);
    expect(all).not.toContain('Hire a worker at the first free desk');
  });

  it('shows each row’s key as the ? dialog draws it, per platform', () => {
    const hire = (mac: boolean) => paletteCommands(live('floor'), mac).find((c) => c.id === 'hire');
    expect(hire(false)?.caps).toEqual(['H']);
    const run = paletteCommands(live('floor'), true).find((c) => c.id === 'run');
    expect(run?.caps).toEqual(['Shift', 'R']);
    expect(paletteCommands(live('floor'), false).find((c) => c.id === 'about')?.caps).toEqual([]);
  });

  it('asks which floor only for a floor-scoped row, and only off an office floor', () => {
    const cmds = paletteCommands(live('city'), false);
    const get = (id: string) => cmds.find((c) => c.id === id)!;
    for (const id of ['hire', 'issues', 'prs', 'run', 'overview']) {
      expect(needsFloorPick(get(id), null), id).toBe(true);
      expect(needsFloorPick(get(id), 'z-top'), id).toBe(false);
    }
    for (const id of ['buildings', 'settings', 'inbox', 'next-need', 'about']) expect(needsFloorPick(get(id), null), id).toBe(false);
    expect(get('hire').pick).toBe('Hire on which floor?');
  });
});

describe('commands: matching', () => {
  const cmds = paletteCommands(new Set<Scope>(['any', 'floor', 'city']), false);
  const find = (q: string) => filterCommands(cmds, q).map((m) => m.command.id);

  it('an empty query keeps them all', () => {
    expect(find('')).toEqual(cmds.map((c) => c.id));
    expect(find('   ')).toEqual(cmds.map((c) => c.id));
  });

  it('"hire" finds Hire first, by its name', () => {
    expect(find('hire')[0]).toBe('hire');
    expect(filterCommands(cmds, 'hire')[0]?.hits).toEqual([0, 1, 2, 3]);
  });

  it('matches by prefix, then word start, then anywhere', () => {
    expect(find('req')).toEqual(['prs']);
    expect(find('who')).toEqual(['next-need']);
    const q = find('s');
    expect(q.indexOf('settings')).toBeLessThan(q.indexOf('prs')); // prefix before a word start before a substring
  });

  it('finds a command by an alias, with nothing highlighted', () => {
    const m = filterCommands(cmds, 'new worker');
    expect(m.map((x) => x.command.id)).toEqual(['hire']);
    expect(m[0]?.hits).toEqual([]);
    expect(find('tickets')).toEqual(['issues']);
    expect(find('lift')).toEqual(['elevator']);
    expect(find('preferences')).toEqual(['settings']);
  });

  it('lists a command once however many of its names match', () => {
    const ids = find('e');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ignores case and matches nothing for nonsense', () => {
    expect(find('HIRE')[0]).toBe('hire');
    expect(find('zzzz')).toEqual([]);
  });
});
