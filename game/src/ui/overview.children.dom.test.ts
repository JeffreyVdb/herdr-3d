// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Child, Floor, Snapshot, Worker } from '../net/protocol';
import { WorldStore } from '../world/store';
import { buildCityOverview, buildOverview, cityCountItems, countItems } from '../world/overview';
import { NEST_MAX, OverviewOverlay, type OverviewHost } from './overview';
import { OverviewFilterPrefs, OverviewPrefs } from './overviewPrefs';

// #24 (phase 3 of #20): native child agents on the overview page, under the worker that owns them, to any depth.

const NOW = 1_790_000_000_000;

const worker = (id: string, over: Partial<Worker> = {}): Worker => ({ id, session: 'top', workspace_id: `ws-${id}`, label: id, name: id, status: 'idle', status_since: NOW - 60_000, child_generation: 1, ...over });

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
  started_at: NOW - 4 * 60_000 - 1000 + ++at,
  ...over,
});
const sub = (id: string, workerId: string, parent: string, over: Partial<Child> = {}) => child(id, workerId, { parent: 'child', parent_id: parent, ...over });

const CREW: Worker[] = [
  worker('o1', { role: 'orch', run: 'run', desk_index: 0, status: 'working' }),
  worker('f1', { role: 'code', run: 'run', orch_id: 'o1', round: 1, desk_index: 1 }),
  worker('emp', { desk_index: 2 }),
];
const KIDS: Child[] = [
  child('ch-o', 'o1', { type: 'Explore', description: 'Find the hub’s session handling' }),
  child('ch-f', 'f1', { provider: 'codex', name: 'Ada', type: 'worker' }),
  sub('ch-f2', 'f1', 'ch-f', { provider: 'codex', name: 'Bell' }),
  child('ch-e', 'emp', { state: 'completed', ended_at: NOW - 60_000, transcript: 'pending' }),
];

function setup(workers: Worker[] = CREW, children: Child[] = KIDS, over: Partial<OverviewHost> = {}) {
  const store = new WorldStore(NOW);
  const floors: Floor[] = [{ session: 'top', state: 'running', building: 'b1', index: 0 }];
  const snap: Snapshot = { t: 'world.snapshot', seq: 1, world: { buildings: [{ id: 'b1', name: 'Work', sort: 0, floors: ['top'] }], unassigned: [], floors, workers, children } };
  store.applySnapshot(snap, NOW);
  let now = NOW;
  const host: OverviewHost = {
    data: (s) => {
      const fv = store.floorView(s);
      return fv ? { tree: buildOverview(store, s), where: 'Floor 1 of 1 · Work', counts: countItems(fv.counts, fv.asleep), asleep: fv.asleep } : null;
    },
    cityData: () => ({ tree: buildCityOverview(store), where: '1 floor in 1 building', counts: cityCountItems(store.city().flatMap((b) => b.floors)) }),
    goToFloor: vi.fn(),
    goTo: vi.fn(),
    goToChild: vi.fn(),
    openTicket: vi.fn(),
    retrySummary: vi.fn(),
    hire: vi.fn(),
    calm: () => true,
    screenRect: () => null,
    floorName: (f) => f,
    closed: vi.fn(),
    now: () => now,
    ...over,
  };
  const ov = new OverviewOverlay(document.body, host, new OverviewPrefs(null), new OverviewFilterPrefs(null));
  let seq = 1;
  const upsert = (c: Child) => store.applyEvent({ t: 'child.upsert', seq: ++seq, child: c }, NOW);
  const removed = (c: Pick<Child, 'id' | 'worker_id' | 'generation'>) => store.applyEvent({ t: 'child.removed', seq: ++seq, ...c }, NOW);
  return { ov, host, store, upsert, removed, setNow: (t: number) => (now = t) };
}

const key = (k: string, o: KeyboardEventInit = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o }));
const keys = (ov: OverviewOverlay) => ov.info().rows.map((r) => `${'  '.repeat(r.depth)}${r.key}`);
const rowEl = (k: string) => document.querySelector<HTMLElement>(`.ov-row[data-key="${k}"]`);
const text = (ov: OverviewOverlay, k: string) => ov.info().rows.find((r) => r.key === k)?.text ?? '';

afterEach(() => void (document.body.innerHTML = ''));

describe('#24 child rows on the page', () => {
  it('render under an orchestrator (after its freelancers), a freelancer (to its subagent’s subagent) and an ordinary worker', () => {
    const { ov } = setup();
    ov.open('top');
    expect(keys(ov)).toEqual(['o1', '  f1', '    child:ch-f', '      child:ch-f2', '  child:ch-o', 'emp', '  child:ch-e']);
    expect(ov.info().rows.filter((r) => r.kind === 'child').map((r) => r.key)).toEqual(['child:ch-f', 'child:ch-f2', 'child:ch-o', 'child:ch-e']);
    // A tree: levels, the groups' state, a child with children is a group like any other.
    expect(rowEl('child:ch-f2')?.getAttribute('aria-level')).toBe('4');
    expect(rowEl('child:ch-f2')?.getAttribute('role')).toBe('treeitem');
    expect(rowEl('child:ch-f')?.getAttribute('aria-expanded')).toBe('true');
    expect(rowEl('f1')?.getAttribute('aria-expanded')).toBe('true');
    expect(rowEl('emp')?.getAttribute('aria-expanded')).toBe('true');
    expect(rowEl('child:ch-f2')?.hasAttribute('aria-expanded')).toBe(false);
    expect(rowEl('child:ch-f2')?.classList.contains('ov-row--nested')).toBe(true);
    expect(rowEl('child:ch-f2')?.style.getPropertyValue('--nest')).toBe('3');
  });

  it('a row says the provider, name (type beside it), task, state and time, and the transcript’s availability', () => {
    const { ov } = setup();
    ov.open('top');
    const f = rowEl('child:ch-f');
    expect(f?.querySelector('.ov-mark title')?.textContent).toBe('Codex');
    expect(f?.querySelector('.ov-name')?.textContent).toBe('Ada');
    expect(f?.querySelector('.ov-ctype')?.textContent).toBe('worker');
    expect(f?.dataset.state).toBe('running');
    expect(f?.querySelector('.ov-since .ov-doing')?.textContent).toBe('running 4m');
    expect(f?.querySelector('.ov-tx')?.textContent).toBe('transcript available');
    expect(f?.querySelector('.ov-meta')).toBeNull();
    expect(text(ov, 'child:ch-o')).toContain('Find the hub’s session handling');
    expect(rowEl('child:ch-o')?.querySelector('.ov-mark title')?.textContent).toBe('Claude');
    const e = rowEl('child:ch-e');
    expect(e?.querySelector('.ov-since .ov-doing')?.textContent).toBe('completed in 3m');
    expect(e?.querySelector('.ov-tx')?.textContent).toBe('transcript pending');
    expect(e?.querySelector('.ov-line .ov-text')?.textContent).toBe('No task description');
    expect(e?.getAttribute('aria-label')).toBe('Subagent Subagent · Claude · completed in 3m · transcript pending: open its conversation');
    expect(f?.getAttribute('aria-label')).toBe('Subagent Ada · worker · Codex · running 4m · transcript available: open its conversation');
  });

  it('keeps the six states apart in words; unknown says so, with no time', () => {
    const states = ['running', 'completed', 'idle', 'shut_down', 'interrupted', 'unknown'] as const;
    const { ov } = setup([worker('w')], states.map((s) => child(s, 'w', { state: s, transcript: 'unavailable' })));
    ov.open('top');
    expect(states.map((s) => [rowEl(`child:${s}`)?.dataset.state, rowEl(`child:${s}`)?.querySelector('.ov-state')?.textContent])).toEqual([
      ['running', 'running'],
      ['completed', 'completed'],
      ['idle', 'idle'],
      ['shut_down', 'shut down'],
      ['interrupted', 'interrupted'],
      ['unknown', 'state unknown'],
    ]);
    expect(rowEl('child:unknown')?.querySelector('.ov-time')?.textContent).toBe('');
    expect(rowEl('child:unknown')?.querySelector('.ov-tx')?.textContent).toBe('no transcript');
  });

  it('unresolved parentage: under the root worker, a detached dashed elbow and “parent unknown”, never drawn as the worker’s', () => {
    const { ov } = setup([worker('w')], [child('mine', 'w'), child('lost', 'w', { parent: 'unresolved' }), sub('dangling', 'w', 'nobody')]);
    ov.open('top');
    expect(keys(ov)).toEqual(['w', '  child:mine', '  child:lost', '  child:dangling']);
    for (const k of ['child:lost', 'child:dangling']) {
      const el = rowEl(k);
      expect(el?.querySelector('.ov-orphan')?.textContent).toBe('parent unknown');
      expect(el?.querySelector('.ov-wire-loose')).not.toBeNull();
      expect(el?.getAttribute('aria-label')).toContain('parent unknown');
    }
    // The resolved one's elbow meets its line; the unresolved last one's line does not reach it.
    expect(rowEl('child:mine')?.querySelector('.ov-orphan')).toBeNull();
    expect(rowEl('child:mine')?.querySelector('.ov-wire-loose')).toBeNull();
    const lines = [...(rowEl('child:dangling')?.querySelectorAll('.ov-wire line') ?? [])];
    expect(lines.map((l) => l.getAttribute('class'))).toEqual(['ov-wire-loose']);
  });

  it('activation (Enter, click) opens the child’s own conversation at the worker that owns it (#26): goToChild(worker, child), the page closes', () => {
    const { ov, host } = setup();
    ov.open('top');
    rowEl('child:ch-f2')?.focus();
    key('Enter');
    expect(host.goToChild).toHaveBeenCalledWith('f1', 'ch-f2');
    expect(host.goTo).not.toHaveBeenCalled();
    expect(ov.isOpen).toBe(false);
    ov.open('top');
    rowEl('child:ch-o')?.querySelector<HTMLElement>('.ov-name')?.click();
    expect(host.goToChild).toHaveBeenLastCalledWith('o1', 'ch-o');
  });

  it('keys at any depth: ↓/j ↑/k move, → opens then goes in, ← folds then goes to the parent, Shift+← / → fold and open every group', () => {
    const { ov } = setup();
    ov.open('top');
    const focused = () => ov.info().focused;
    key('j');
    key('ArrowDown');
    expect(focused()).toBe('child:ch-f');
    key('ArrowRight'); // expanded: into its first child
    expect(focused()).toBe('child:ch-f2');
    key('ArrowLeft'); // a leaf: to its parent
    expect(focused()).toBe('child:ch-f');
    key('ArrowLeft'); // folds it
    expect(keys(ov)).not.toContain('      child:ch-f2');
    expect(rowEl('child:ch-f')?.getAttribute('aria-expanded')).toBe('false');
    key('ArrowRight'); // opens it
    expect(keys(ov)).toContain('      child:ch-f2');
    key('ArrowLeft');
    key('ArrowLeft'); // folded: to its parent, the freelancer
    expect(focused()).toBe('f1');
    key('ArrowLeft', { shiftKey: true });
    expect(keys(ov)).toEqual(['o1', 'emp']);
    key('ArrowRight', { shiftKey: true });
    expect(keys(ov)).toEqual(['o1', '  f1', '    child:ch-f', '      child:ch-f2', '  child:ch-o', 'emp', '  child:ch-e']);
    key('End');
    expect(focused()).toBe('child:ch-e');
    key('k');
    expect(focused()).toBe('emp');
    key('Home');
    expect(focused()).toBe('o1');
  });

  it('an ended child’s own children start folded; the viewer can open them', () => {
    const { ov } = setup([worker('w')], [child('done', 'w', { state: 'completed' }), sub('d1', 'w', 'done', { state: 'completed' }), child('run', 'w'), sub('r1', 'w', 'run')]);
    ov.open('top');
    expect(keys(ov)).toEqual(['w', '  child:done', '  child:run', '    child:r1']);
    rowEl('child:done')?.querySelector<HTMLElement>('[data-fold]')?.click();
    expect(keys(ov)).toEqual(['w', '  child:done', '    child:d1', '  child:run', '    child:r1']);
  });

  it('updates with no transcript open: child.upsert adds a row, a new state redraws it, child.removed takes it away', () => {
    const { ov, upsert, removed, setNow } = setup([worker('w')], []);
    ov.open('top');
    expect(keys(ov)).toEqual(['w']);
    const c = child('new', 'w', { name: 'Curie', started_at: NOW - 60_000 });
    upsert(c);
    ov.refresh();
    expect(keys(ov)).toEqual(['w', '  child:new']);
    expect(rowEl('child:new')?.querySelector('.ov-since .ov-doing')?.textContent).toBe('running 1m');
    setNow(NOW + 5 * 60_000); // the 20 s refresh moves its time on in place
    ov.refresh();
    expect(rowEl('child:new')?.querySelector('.ov-since .ov-doing')?.textContent).toBe('running 6m');
    upsert({ ...c, state: 'completed', ended_at: NOW + 60_000 });
    ov.refresh();
    expect(rowEl('child:new')?.querySelector('.ov-since .ov-doing')?.textContent).toBe('completed in 2m');
    removed(c);
    ov.refresh();
    expect(keys(ov)).toEqual(['w']);
  });

  it('active only: a running child holds its idle worker up; the rest hide, said as subagents, never as idle workers', () => {
    const { ov } = setup([worker('w'), worker('q', { desk_index: 1 })], [child('run', 'w'), child('done', 'w', { state: 'completed' }), child('off', 'q', { state: 'shut_down' })]);
    ov.open('top');
    key('f');
    expect(ov.info().filter).toBe('active');
    expect(keys(ov)).toEqual(['w', '  child:run']);
    expect(ov.info().hidden).toBe('1 idle hidden · 2 subagents hidden');
    // The header's numbers are the workers'.
    expect(document.querySelector('.ov-where')?.textContent).toBe('Floor 1 of 1 · Work · 2 workers');
  });

  it('a long tree stays usable: every row in reading order, End reaches the last, the counts are the workers’', () => {
    const many = Array.from({ length: 30 }, (_, i) => child(`c${String(i).padStart(2, '0')}`, 'w', { state: i % 3 ? 'completed' : 'running' }));
    const { ov } = setup([worker('w')], many);
    ov.open('top');
    expect(ov.info().rows).toHaveLength(31);
    expect(document.querySelector('.ov-where')?.textContent).toBe('Floor 1 of 1 · Work · 1 worker');
    key('End');
    expect(ov.info().focused).toBe('child:c29');
    expect(document.activeElement).toBe(rowEl('child:c29'));
    // The last child's line stops at its elbow; every other one’s runs on.
    const own = (k: string) => [...(rowEl(k)?.querySelectorAll('.ov-wire line') ?? [])][0]?.getAttribute('y2');
    expect(own('child:c28')).toBe('100%');
    expect(own('child:c29')).toBe('17');
  });

  it(`a deep tree keeps readable text: the indent stops at ${NEST_MAX} levels and a deeper row says its level`, () => {
    const chain = [child('d1', 'w'), ...Array.from({ length: 6 }, (_, i) => sub(`d${i + 2}`, 'w', `d${i + 1}`))];
    const { ov } = setup([worker('w')], chain);
    ov.open('top');
    expect(ov.info().rows.map((r) => r.depth)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(rowEl('child:d7')?.style.getPropertyValue('--nest')).toBe(String(NEST_MAX));
    expect(rowEl('child:d7')?.getAttribute('aria-level')).toBe('8');
    expect(rowEl('child:d7')?.querySelector('.ov-level')?.textContent).toBe('level 7');
    // Its spoken label says the level too, also after the times' refresh in place.
    ov.refresh();
    expect(rowEl('child:d7')?.getAttribute('aria-label')).toContain('level 7');
    expect(rowEl('child:d4')?.querySelector('.ov-level')).toBeNull();
  });

  it('the all-floors page nests them a floor deeper', () => {
    const { ov } = setup();
    ov.openCity();
    if (ov.info().filter === 'active') key('f');
    expect(keys(ov)).toEqual(['floor:top', '  o1', '    f1', '      child:ch-f', '        child:ch-f2', '    child:ch-o', '  emp', '    child:ch-e']);
    expect(rowEl('child:ch-f2')?.style.getPropertyValue('--nest')).toBe('3');
    expect(rowEl('emp')?.style.getPropertyValue('--nest')).toBe('');
  });
});
