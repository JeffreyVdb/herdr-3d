// @vitest-environment jsdom
// #58: the elevator and Buildings panels on virtual floors: names (never ids), wake and sleep that say they are the
// session's and confirm with every floor a sleep takes down, and a virtual floor's Move menu that only reorders it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../net/client';
import type { Floor, Snapshot, Worker } from '../net/protocol';
import { WorldStore } from '../world/store';
import { Panels, wakeSleepWords, type PanelHost } from './panels';

const W = 'b_work';
const P = 'b_home';
const V = 'v-0123456789ab';
const D = 'v-ba9876543210';

const floor = (id: string, over: Partial<Floor> = {}): Floor => ({ id, name: id, session: id, base_session: id, virtual: false, hidden: false, state: 'running', building: W, index: 0, ...over });
const vfloor = (id: string, name: string, base: string, over: Partial<Floor> = {}): Floor => floor(id, { name, session: base, base_session: base, virtual: true, ...over });
const worker = (id: string, floorId: string, session: string, status = 'working'): Worker => ({ id, session, floor: floorId, workspace_id: `w-${id}`, label: id, status, name: id, desk_index: 0 });

function setup() {
  const store = new WorldStore(0);
  const snap: Snapshot = {
    t: 'world.snapshot',
    seq: 1,
    world: {
      buildings: [
        { id: W, name: 'Work', sort: 0, floors: ['main', V, 'other', D] },
        { id: P, name: 'Home', sort: 1, floors: [] },
      ],
      unassigned: [],
      floors: [floor('main'), vfloor(V, 'Frontend', 'main', { index: 1 }), floor('other', { index: 2 }), vfloor(D, 'Docs', 'other', { index: 3, state: 'asleep' })],
      workers: [worker('a', 'main', 'main'), worker('b', V, 'main', 'blocked')],
    },
  };
  store.applySnapshot(snap);
  const send = vi.fn(async (): Promise<CommandResult> => ({ ok: true, data: {} }) as CommandResult);
  const host: PanelHost = {
    store,
    here: () => null,
    inLobby: () => false,
    send: send as unknown as PanelHost['send'],
    unsupported: () => false,
    travel: () => {},
    travelLobby: () => {},
    toast: () => {},
    logoUrl: () => '',
    logoFailed: () => false,
    setLogo: async () => ({ ok: true }) as CommandResult,
    clearLogo: async () => ({ ok: true }) as CommandResult,
  };
  const panels = new Panels(document.body, host);
  return { store, panels, send };
}

const row = (id: string) => document.querySelector<HTMLElement>(`.lift-row[data-floor="${id}"]`) as HTMLElement;

beforeEach(() => {
  // jsdom has no modal dialogs: open / close are what the game's code looks at.
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('Panels: virtual floors (#58)', () => {
  it('lists a virtual floor in its base’s building by its name, its wake and sleep the session’s', () => {
    const t = setup();
    t.panels.openElevator(W);
    const s = t.panels.summary();
    expect(s?.kind === 'elevator' && s.rows.map((r) => [r.floor, r.name, r.number, r.state])).toEqual([
      ['main', 'main', 4, 'running'],
      [V, 'Frontend', 3, 'running'],
      ['other', 'other', 2, 'running'],
      [D, 'Docs', 1, 'asleep'],
    ]);
    expect(row(V).querySelector('.lift-session')?.textContent).toBe('Frontend');
    expect(row(V).dataset.session).toBe('main');
    const sleep = row(V).querySelector<HTMLElement>(`[data-key="ws:${V}"]`) as HTMLElement;
    expect(sleep.textContent).toBe('Sleep session');
    expect(sleep.getAttribute('aria-label')).toBe('Sleep session main (main and Frontend)');
    // A virtual floor whose base is asleep shows asleep, and its wake says it wakes the base.
    const wake = row(D).querySelector<HTMLElement>(`[data-key="ws:${D}"]`) as HTMLElement;
    expect(wake.textContent).toBe('Wake session');
    expect(wake.title).toBe('Docs is a virtual floor on herdr session other: waking it starts that session and wakes every floor on it: other and Docs');
    // No v- id anywhere a person reads.
    expect(document.body.innerText ?? document.body.textContent).not.toMatch(/v-[0-9a-f]{12}/);
    for (const el of document.querySelectorAll('[aria-label], [title]')) {
      expect(`${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''}`).not.toMatch(/v-[0-9a-f]{12}/);
    }
  });

  it('wakes a virtual floor by its id: the bridge wakes the base session', async () => {
    const t = setup();
    t.panels.openElevator(W);
    (row(D).querySelector(`[data-key="ws:${D}"]`) as HTMLElement).click();
    await Promise.resolve();
    expect(t.send).toHaveBeenCalledWith('floor.wake', { floor: D });
  });

  it('confirms a sleep with every floor of the session before sending it', async () => {
    const t = setup();
    t.panels.openElevator(W);
    (row(V).querySelector(`[data-key="ws:${V}"]`) as HTMLElement).click();
    const s = t.panels.summary();
    expect(s?.confirm?.title).toBe('Put main and Frontend to sleep?');
    expect(s?.confirm?.body).toBe(
      'These floors share herdr session main and all go to sleep: main, Frontend. 1 agent is working and 1 needs you right now. herdr saves and stops the session; the agents pick their conversations back up when you wake the floor.',
    );
    expect(document.querySelector('#confirm-body')?.textContent).toContain('main, Frontend');
    expect(t.send).not.toHaveBeenCalled();
    const ok = [...document.querySelectorAll<HTMLButtonElement>('.sheet-actions button')].find((b) => b.textContent === 'Sleep 2 floors') as HTMLButtonElement;
    ok.click();
    await Promise.resolve();
    expect(t.send).toHaveBeenCalledWith('floor.sleep', { floor: V });
  });

  it('confirms a lone floor’s sleep as before', () => {
    const t = setup();
    t.store.applyEvent({ t: 'floor.removed', seq: 2, session: 'main', floor_id: V });
    t.panels.openElevator(W);
    (row('main').querySelector('[data-key="ws:main"]') as HTMLElement).click();
    expect(t.panels.summary()?.confirm?.title).toBe('Put main to sleep?');
  });

  it('a virtual floor’s Move menu only reorders it within its building', async () => {
    const t = setup();
    t.panels.openBuildings();
    (document.querySelector(`[data-key="move:${V}"]`) as HTMLElement).click();
    const menu = document.querySelector<HTMLElement>(`.dir-floor[data-floor="${V}"] .dir-move`) as HTMLElement;
    expect(menu.getAttribute('aria-label')).toBe('Move Frontend within Work');
    expect([...menu.querySelectorAll<HTMLElement>('[data-key]')].map((b) => b.dataset.key)).toEqual([`to:${V}:up`, `to:${V}:down`, `to:${V}:note`, `to:${V}:cancel`]);
    expect(menu.textContent).not.toContain('Home');
    expect(menu.textContent).not.toContain('Unassigned lot');
    (menu.querySelector(`[data-key="to:${V}:up"]`) as HTMLElement).click();
    await Promise.resolve();
    expect(t.send).toHaveBeenCalledWith('floor.assign', { floor: V, building: W, index: 0 });
  });

  it('a real floor’s Move menu still offers the other buildings and the lot', () => {
    const t = setup();
    t.panels.openBuildings();
    (document.querySelector('[data-key="move:main"]') as HTMLElement).click();
    const keys = [...document.querySelectorAll<HTMLElement>('.dir-floor[data-floor="main"] .dir-move [data-key]')].map((b) => b.dataset.key);
    expect(keys).toEqual([`to:main:${P}`, 'to:main:lot', 'to:main:cancel']);
  });

  it('leaves a hidden floor with no workers out of the elevator, and shows it once one is on it', () => {
    const t = setup();
    t.store.applyEvent({ t: 'floor.upsert', seq: 2, floor: floor('other', { index: 2, hidden: true }) });
    t.panels.openElevator(W);
    let s = t.panels.summary();
    expect(s?.kind === 'elevator' && s.rows.map((r) => r.floor)).toEqual(['main', V, D]);
    t.store.applyEvent({ t: 'worker.upsert', seq: 3, worker: worker('tui', 'other', 'other', 'idle') });
    s = t.panels.summary();
    expect(s?.kind === 'elevator' && s.rows.map((r) => r.floor)).toEqual(['main', V, 'other', D]);
  });
});

describe('wakeSleepWords', () => {
  const f = (over: Partial<{ name: string; virtual: boolean; baseSession: string }> = {}) => ({ name: 'main', virtual: false, baseSession: 'main', ...over });
  it('says floor on a floor that has its session to itself', () => {
    expect(wakeSleepWords(f(), [{ id: 'main', name: 'main', session: 'main', virtual: false }], 'sleep')).toEqual({
      text: 'Sleep floor',
      title: "Stop main's herdr session; its agents resume on the next wake",
      aria: 'Sleep floor main',
    });
  });
});
