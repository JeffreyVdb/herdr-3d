// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Floor, Snapshot, Worker } from '../net/protocol';
import { WorldStore } from '../world/store';
import { buildCityOverview, buildOverview, cityCountItems, countItems } from '../world/overview';
import { OverviewOverlay, type OverviewHost } from './overview';
import { OverviewFilterPrefs, OverviewPrefs } from './overviewPrefs';

// #188: the all-floors page, and the filter on both pages.

const NOW = 1_790_000_000_000;

const worker = (id: string, session: string, over: Partial<Worker> = {}): Worker => ({ id, session, workspace_id: `ws-${id}`, label: id, name: id, status: 'idle', status_since: NOW - 60_000, ...over });

/** Work: top over bottom; den asleep in the lot. A run spans top and bottom. */
const CITY = [
  worker('o1', 'top', { role: 'orch', desk_index: 0, issue: { repo: 'o/r', number: 188, title: 'All floors' }, work_item: { provider: 'gh', id: 'o/r#188' } }),
  worker('c1', 'bottom', { role: 'code', orch_id: 'o1', round: 1, desk_index: 0, status: 'working' }),
  worker('r1', 'top', { role: 'review', orch_id: 'o1', round: 1, desk_index: 1 }),
  worker('emp', 'top', { desk_index: 2, status: 'blocked' }),
  worker('b1', 'bottom', { desk_index: 1 }),
  worker('z1', 'den'),
];

function world(workers: Worker[]): WorldStore {
  const s = new WorldStore(NOW);
  const floors: Floor[] = [
    { session: 'top', state: 'running', building: 'b1', index: 0 },
    { session: 'bottom', state: 'running', building: 'b1', index: 1 },
    { session: 'den', state: 'asleep', building: null, index: null },
  ];
  const snap: Snapshot = { t: 'world.snapshot', seq: 1, world: { buildings: [{ id: 'b1', name: 'Work', sort: 0, floors: ['top', 'bottom'] }], unassigned: ['den'], floors, workers } };
  s.applySnapshot(snap, NOW);
  return s;
}

function setup(workers: Worker[] = CITY, over: Partial<OverviewHost> = {}, filter = new OverviewFilterPrefs(null)) {
  const store = world(workers);
  document.body.appendChild(document.createElement('div')).className = 'hud';
  const host: OverviewHost = {
    data: (s) => {
      const fv = store.floorView(s);
      return fv ? { tree: buildOverview(store, s), where: 'Floor 2 of 2 · Work', counts: countItems(fv.counts, fv.asleep), asleep: fv.asleep } : null;
    },
    cityData: () => ({ tree: buildCityOverview(store), where: '3 floors in 1 building', counts: cityCountItems(store.city().flatMap((b) => b.floors)) }),
    goToFloor: vi.fn(),
    goTo: vi.fn(),
    openTicket: vi.fn(),
    retrySummary: vi.fn(),
    hire: vi.fn(),
    calm: () => true,
    screenRect: () => null,
    closed: vi.fn(),
    now: () => NOW,
    ...over,
  };
  const prefs = new OverviewPrefs(null);
  const ov = new OverviewOverlay(document.body, host, prefs, filter);
  return { ov, host, prefs, filter, store };
}

const key = (k: string, o: KeyboardEventInit = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o }));
const keys = (ov: OverviewOverlay) => ov.info().rows.map((r) => `${'  '.repeat(r.depth)}${r.key}`);
const focusRow = (ov: OverviewOverlay, k: string) => {
  (document.querySelector(`.ov-row[data-key="${k}"]`) as HTMLElement).focus();
  expect(ov.info().focused).toBe(k);
};

afterEach(() => void (document.body.innerHTML = ''));

describe('the all-floors page (#188)', () => {
  it('opens on active only: the floors with someone active, their active rows and the parents of those; the header counts everything', () => {
    const { ov } = setup();
    ov.openCity();
    const i = ov.info();
    expect(i).toMatchObject({ open: true, floor: null, view: 'city', filter: 'active', hidden: '2 idle hidden · 1 floor asleep' });
    expect(keys(ov)).toEqual(['floor:top', '  o1', '    c1', '  emp']);
    expect(document.querySelector('.ov-floor')?.textContent).toBe('All floors');
    expect(document.querySelector('.ov-where')?.textContent).toBe('3 floors in 1 building · 6 workers');
    expect([...document.querySelectorAll('.ov-counts .ov-count')].map((c) => c.getAttribute('title'))).toEqual(['1 working', '1 needs you', '3 idle', '1 asleep']);
    // No All floors button here (it is the page); the switch says what is on.
    expect((document.querySelector('.ov-btn--floors') as HTMLElement).hidden).toBe(true);
    expect([...document.querySelectorAll('.ov-seg')].map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['Active only', 'true'],
      ['All', 'false'],
    ]);
  });

  it('f shows everyone and back, remembered for this view only; a click on the hidden line shows everyone', () => {
    const { ov, filter } = setup();
    ov.openCity();
    key('f');
    expect(ov.info()).toMatchObject({ filter: 'all', hidden: '' });
    // Every worker once, the asleep floor collapsed (it starts so).
    expect(keys(ov)).toEqual(['floor:top', '  o1', '    c1', '    r1', '  emp', 'floor:bottom', '  b1', 'floor:den']);
    expect(ov.info().rows.find((r) => r.key === 'floor:den')?.expanded).toBe(false);
    expect(filter.activeOnly('city')).toBe(false);
    expect(filter.activeOnly('floor')).toBe(false);
    key('f');
    expect(ov.info().filter).toBe('active');
    (document.querySelector('.ov-hidden') as HTMLButtonElement).click();
    expect(ov.info().filter).toBe('all');
    expect((document.querySelector('.ov-hidden') as HTMLElement).hidden).toBe(true);
    (document.querySelector('.ov-seg[data-active="true"]') as HTMLButtonElement).click();
    expect(ov.info().filter).toBe('active');
  });

  it('a floor row: its name, its place, its counts as chips and the moon when it sleeps', () => {
    const { ov } = setup(CITY, {}, new OverviewFilterPrefs(null));
    ov.openCity();
    key('f');
    const top = document.querySelector('.ov-row[data-key="floor:top"]') as HTMLElement;
    expect(top.querySelector('.ov-name')?.textContent).toBe('top');
    expect(top.querySelector('.ov-floor-label')?.textContent).toBe('Floor 2 · Work');
    expect([...top.querySelectorAll('.ov-chip')].map((c) => c.textContent)).toEqual(['0working', '1needs you', '2idle']);
    expect(top.querySelector('.ov-chip--zero')?.textContent).toBe('0working');
    expect(top.querySelector('.ov-asleep')).toBeNull();
    const den = document.querySelector('.ov-row[data-key="floor:den"]') as HTMLElement;
    expect(den.querySelector('.ov-floor-label')).toBeNull(); // the lot: its session is its name
    expect(den.querySelector('.ov-asleep')?.textContent).toBe('Asleep');
    expect(den.getAttribute('aria-label')).toBe('den · asleep · 1 asleep: go to this floor');
  });

  it('an asleep floor opens on → and stays open; Shift+← / Shift+→ fold and unfold floors and orchestrators together', () => {
    const { ov } = setup();
    ov.openCity();
    key('f');
    focusRow(ov, 'floor:den');
    key('ArrowRight');
    expect(keys(ov).slice(-2)).toEqual(['floor:den', '  z1']);
    ov.refresh();
    expect(keys(ov).slice(-2)).toEqual(['floor:den', '  z1']);
    key('ArrowLeft', { shiftKey: true });
    expect(keys(ov)).toEqual(['floor:top', 'floor:bottom', 'floor:den']);
    key('ArrowRight', { shiftKey: true });
    expect(keys(ov)).toEqual(['floor:top', '  o1', '    c1', '    r1', '  emp', 'floor:bottom', '  b1', 'floor:den', '  z1']);
    // ← on a freelancer goes to its orchestrator, on the orchestrator to its floor.
    focusRow(ov, 'c1');
    key('ArrowLeft');
    expect(ov.info().focused).toBe('o1');
    key('ArrowLeft'); // folds o1
    key('ArrowLeft');
    expect(ov.info().focused).toBe('floor:top');
  });

  it('Enter on a floor row goes to that floor; on a worker, to it (another floor’s too); the page closes either way', () => {
    const { ov, host } = setup();
    ov.openCity();
    focusRow(ov, 'c1');
    key('Enter');
    expect(host.goTo).toHaveBeenCalledWith('c1');
    expect(ov.isOpen).toBe(false);
    ov.openCity();
    focusRow(ov, 'floor:top');
    key('Enter');
    expect(host.goToFloor).toHaveBeenCalledWith('top');
    expect(ov.isOpen).toBe(false);
    ov.openCity();
    (document.querySelector('.ov-row[data-key="floor:top"] .ov-name') as HTMLElement).click();
    expect(host.goToFloor).toHaveBeenCalledTimes(2);
  });

  it('an empty city: Nobody’s here yet, no Hire; a filter that hides everyone: All quiet, and Show everyone', () => {
    const { ov } = setup([]);
    ov.openCity();
    const empty = document.querySelector('.ov-empty') as HTMLElement;
    expect(ov.info().empty).toBe(true);
    expect(empty.querySelector('.ov-empty-title')?.textContent).toBe('Nobody’s here yet');
    expect([...empty.querySelectorAll('button')].filter((b) => !b.hidden)).toHaveLength(0);
    document.body.innerHTML = '';
    const quiet = setup([worker('i', 'top'), worker('z', 'den')]);
    quiet.ov.openCity();
    const e2 = document.querySelector('.ov-empty') as HTMLElement;
    expect(e2.querySelector('.ov-empty-title')?.textContent).toBe('All quiet');
    expect(e2.textContent).toContain('1 idle hidden · 1 floor asleep');
    const show = [...e2.querySelectorAll('button')].filter((b) => !b.hidden);
    expect(show.map((b) => b.textContent)).toEqual(['Show everyoneF']);
    show[0]?.click();
    expect(keys(quiet.ov)).toEqual(['floor:top', '  i', 'floor:bottom', 'floor:den']);
  });

  it('rows the filter hides fold away where they were, like a collapse; calm: at once', async () => {
    const anims: Array<{ el: Element; done: () => void }> = [];
    const proto = HTMLElement.prototype as unknown as { animate?: unknown };
    const had = proto.animate;
    proto.animate = function (this: Element) {
      let done = () => {};
      const finished = new Promise<void>((r) => (done = r));
      anims.push({ el: this, done });
      return { finished, cancel: () => done() } as unknown as Animation;
    };
    try {
      const { ov } = setup(CITY, { calm: () => false });
      ov.openCity();
      key('f'); // all
      anims.length = 0;
      key('f'); // active only: r1, the bottom floor and b1, the den go
      expect(keys(ov)).toEqual(['floor:top', '  o1', '    c1', '  emp']);
      const board = () => [...document.querySelectorAll<HTMLElement>('.ov-board > *')].map((e) => e.dataset.key);
      expect(board()).toEqual(['floor:top', 'o1', 'c1', 'r1', 'emp', 'floor:bottom', 'b1', 'floor:den']);
      expect(document.querySelectorAll('.ov-row--leaving')).toHaveLength(4);
      expect(anims.map((a) => (a.el as HTMLElement).dataset.key).sort()).toEqual(['b1', 'floor:bottom', 'floor:den', 'r1']);
      for (const a of anims) a.done();
      await vi.waitFor(() => expect(document.querySelectorAll('.ov-row--leaving')).toHaveLength(0));
      expect(board()).toEqual(['floor:top', 'o1', 'c1', 'emp']);
      // Shown again: they come back at once, in the tree's order.
      key('f');
      expect(board()).toEqual(['floor:top', 'o1', 'c1', 'r1', 'emp', 'floor:bottom', 'b1', 'floor:den']);
    } finally {
      proto.animate = had;
    }
  });
});

describe('a floor’s page with the filter (#188)', () => {
  it('starts on All (as before); f hides the idle and keeps the parents of active rows; its own setting', () => {
    const { ov, filter } = setup();
    ov.open('top');
    expect(ov.info()).toMatchObject({ view: 'floor', floor: 'top', filter: 'all', hidden: '' });
    expect(keys(ov)).toEqual(['o1', '  c1', '  r1', 'emp']);
    key('f');
    expect(keys(ov)).toEqual(['o1', '  c1', 'emp']);
    expect(ov.info().hidden).toBe('1 idle hidden');
    expect(filter.activeOnly('floor')).toBe(true);
    expect(filter.activeOnly('city')).toBe(true);
    // The header's counts stay the floor's, unfiltered.
    expect([...document.querySelectorAll('.ov-counts .ov-count')].map((c) => c.getAttribute('title'))).toEqual(['0 working', '1 needs you', '2 idle']);
  });

  it('a and the All floors button switch to every floor in place; Esc then closes the page', async () => {
    const { ov, host } = setup();
    ov.open('top');
    const btn = document.querySelector('.ov-btn--floors') as HTMLButtonElement;
    expect(btn.hidden).toBe(false);
    key('a');
    expect(ov.info()).toMatchObject({ open: true, view: 'city', floor: null, filter: 'active' });
    expect(document.querySelector('.ov-floor')?.textContent).toBe('All floors');
    key('a'); // nothing more on this page
    expect(ov.info().view).toBe('city');
    key('Escape');
    await vi.waitFor(() => expect(ov.isOpen).toBe(false));
    expect(host.closed).toHaveBeenCalledTimes(1);
    ov.open('top');
    btn.click();
    expect(ov.info().view).toBe('city');
  });
});
