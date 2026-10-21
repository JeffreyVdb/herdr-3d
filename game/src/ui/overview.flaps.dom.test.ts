// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Floor, Snapshot, Worker, WorkerDigest } from '../net/protocol';
import { WorldStore } from '../world/store';
import { buildCityOverview, buildOverview, cityCountItems, countItems } from '../world/overview';
import { OverviewOverlay, type OverviewHost } from './overview';
import { OverviewFilterPrefs, OverviewPrefs } from './overviewPrefs';

// #119: the now line's split-flap loading state, its arrival, a model's line being refreshed, and a "Working on" column
// that keeps its place (and its motion) through the row's refreshes.

const NOW = 1_790_000_000_000;
const LINE = 'Reading the lift code before the door fix';

const worker = (id: string, over: Partial<Worker> = {}): Worker => ({ id, session: 'top', workspace_id: `ws-${id}`, label: id, name: id, status: 'working', status_since: NOW - 60_000, ...over });

function setup(workers: Worker[], calm = false) {
  const store = new WorldStore(NOW);
  const floors: Floor[] = [{ session: 'top', state: 'running', building: 'b1', index: 0 }];
  const snap: Snapshot = { t: 'world.snapshot', seq: 1, world: { buildings: [{ id: 'b1', name: 'Work', sort: 0, floors: ['top'] }], unassigned: [], floors, workers } };
  store.applySnapshot(snap, NOW);
  const state = { calm };
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
    calm: () => state.calm,
    screenRect: () => null,
    floorName: (f) => f,
    closed: vi.fn(),
    now: () => NOW,
  };
  const ov = new OverviewOverlay(document.body, host, new OverviewPrefs(null), new OverviewFilterPrefs(null));
  let seq = 1;
  /** A worker.upsert of `id` with these fields, then the page's refresh (as the app does on a world change). */
  const upsert = (id: string, over: Partial<Worker>) => {
    const cur = store.workers.get(id) as Worker;
    store.applyEvent({ t: 'worker.upsert', seq: ++seq, worker: { ...cur, ...over } }, NOW);
    ov.refresh();
  };
  const row = (id: string) => document.querySelector<HTMLElement>(`.ov-row[data-key="${id}"]`) as HTMLElement;
  return { ov, store, upsert, row, state };
}

const pending = { state: 'pending' } as const;
const titleNow = (over: Partial<WorkerDigest> = {}): WorkerDigest => ({ now_source: 'title', now_status: pending, ...over });
const llmNow = (now: string, over: Partial<WorkerDigest> = {}): WorkerDigest => ({ now, now_source: 'llm', now_at: NOW - 60_000, ...over });
const tick = (n: number) => ({ activity: { kind: 'testing' as const, detail: `pytest -k t${n}`, since: NOW, source: 'rule' as const } });

beforeEach(() => void vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] }));
afterEach(() => {
  // The calm test spies on a fake frame function: restore it before replacing the clock.
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('the overview’s now line while the model writes it (#119)', () => {
  it('a first summary on its way: split-flap cells over the fallback, busy for assistive tech, the label says it loads', () => {
    const { ov, row } = setup([
      worker('a', { title: 'Reading hub.go', digest: titleNow() }),
      worker('b', { title: '', digest: titleNow() }),
      worker('cap', { title: 'Reading hub.go', digest: titleNow({ now_status: { state: 'pending', reason: 'daily_cap' } }) }),
      worker('retry', { title: 'Reading hub.go', digest: titleNow({ now_status: { state: 'retrying', reason: 'timeout', retry_at: NOW + 60_000 } }) }),
      worker('none', { title: '', digest: { now_source: 'recap', now_status: { state: 'pending', reason: 'daily_cap' } } }),
    ]);
    ov.open('top');
    for (const id of ['a', 'b']) {
      const line = row(id).querySelector<HTMLElement>('.ov-now') as HTMLElement;
      expect(line.classList.contains('ov-now--loading')).toBe(true);
      expect(line.getAttribute('aria-busy')).toBe('true');
      const flaps = line.querySelector<HTMLElement>('.ov-flaprow');
      expect(flaps?.getAttribute('aria-hidden')).toBe('true');
      expect(flaps?.querySelectorAll('.ov-fc')).toHaveLength(40);
      // The glyphs are drawn from data-g (no text of the page's); the slot says what it is, in the labels' capitals.
      expect(flaps?.textContent).toBe('');
      expect(line.querySelector('.ov-ai-meta')?.textContent).toBe('summarizing');
      expect(line.querySelector('.ov-now-text')).toBeNull();
      expect(row(id).textContent).not.toContain('Reading hub.go');
      expect(row(id).getAttribute('aria-label')).toContain(' · Now: AI summary loading · ');
    }
    // Not when nothing is being written: the daily cap and a retry show the fallback with their words, as before.
    expect(row('cap').querySelector('.ov-now-text')?.textContent).toBe('Reading hub.go');
    expect(row('cap').querySelector('.ov-now .ov-ai-meta')?.textContent).toBe('AI waiting');
    expect(row('retry').querySelector('.ov-now-text')?.textContent).toBe('Reading hub.go');
    expect(row('retry').querySelector('.ov-now .ov-ai-state')?.textContent).toMatch(/^AI retry/);
    for (const id of ['cap', 'retry']) expect(row(id).querySelector('.ov-flaprow, [aria-busy]'), id).toBeNull();
    // Nothing to show and waiting for the cap: no summary yet, in the line's place, with its words.
    expect(row('none').querySelector('.ov-now-text')?.textContent).toBe('No summary yet');
    expect(row('none').querySelector('.ov-now .ov-ai-meta')?.textContent).toBe('AI waiting');
    expect(row('none').getAttribute('aria-label')).toContain('Now: no summary yet (AI waiting)');
  });

  it('the skeleton turns, and the model’s line resolves into its place flap by flap, then is one text node', () => {
    const { ov, upsert, row } = setup([worker('a', { title: 'Reading hub.go', digest: titleNow() })]);
    ov.open('top');
    const line = row('a').querySelector<HTMLElement>('.ov-now') as HTMLElement;
    const cells = [...line.querySelectorAll<HTMLElement>('.ov-fc')];
    const before = cells.map((c) => c.dataset.g);
    vi.advanceTimersByTime(400);
    expect(cells.map((c) => c.dataset.g)).not.toEqual(before);
    upsert('a', { digest: llmNow(LINE) });
    // The same line element, now the model's: its text in cells of its own letters, settling left to right.
    expect(row('a').querySelector('.ov-now')).toBe(line);
    expect(line.hasAttribute('aria-busy')).toBe(false);
    const text = line.querySelector<HTMLElement>('.ov-now-text') as HTMLElement;
    expect(text.querySelectorAll('.ov-ch[data-g]').length).toBe(LINE.replace(/ /g, '').length);
    expect(text.textContent).toBe(LINE);
    expect(text.title).toBe(LINE);
    expect(row('a').getAttribute('aria-label')).toContain(`Now: ${LINE} (AI summary, 1m ago)`);
    vi.advanceTimersByTime(600);
    expect(text.querySelector('.ov-ch')).toBeNull();
    expect(text.childNodes).toHaveLength(1);
    expect(text.textContent).toBe(LINE);
    expect(line.querySelector('.ov-age')?.textContent).toBe('1m ago');
    expect(line.classList.contains('ov-flip-in')).toBe(false); // a model's line resolves, it does not flip
  });

  it('activity ticks keep the "Working on" column and do not restart the skeleton or a resolve', () => {
    const { ov, upsert, row } = setup([worker('a', { title: 'Reading hub.go', digest: titleNow(), ...tick(0) })]);
    ov.open('top');
    const what = row('a').querySelector('.ov-what');
    const line = row('a').querySelector<HTMLElement>('.ov-now') as HTMLElement;
    const cells = [...line.querySelectorAll('.ov-fc')];
    const since = row('a').querySelector('.ov-since');
    upsert('a', tick(1));
    // The rest of the row was built again (its since column says the new activity); the column and its cells stayed.
    expect(row('a').querySelector('.ov-since')).not.toBe(since);
    expect(row('a').querySelector('.ov-since')?.textContent).toContain('pytest -k t1');
    expect(row('a').querySelector('.ov-what')).toBe(what);
    expect([...row('a').querySelectorAll('.ov-fc')]).toEqual(cells);
    // The model's line arrives; ticks during its resolve go on from where it was.
    upsert('a', { digest: llmNow(LINE) });
    const chars = [...line.querySelectorAll<HTMLElement>('.ov-ch')];
    vi.advanceTimersByTime(260);
    const settled = () => chars.filter((c) => !c.dataset.g).length;
    const mid = settled();
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(chars.length);
    for (let n = 2; n < 6; n++) upsert('a', tick(n));
    expect(row('a').querySelector('.ov-what')).toBe(what);
    expect([...line.querySelectorAll('.ov-ch')]).toEqual(chars);
    expect(settled()).toBeGreaterThanOrEqual(mid);
    vi.advanceTimersByTime(400);
    expect(line.querySelector('.ov-now-text')?.textContent).toBe(LINE);
    expect(line.querySelector('.ov-ch')).toBeNull();
  });

  it('a refresh keeps the model’s line readable with a busy mark, then the new line resolves in; the same line again does not', () => {
    const { ov, upsert, row } = setup([worker('a', { digest: llmNow('Editing the door timer') })]);
    ov.open('top');
    const line = row('a').querySelector<HTMLElement>('.ov-now') as HTMLElement;
    upsert('a', { digest: llmNow('Editing the door timer', { now_status: pending }) });
    expect(row('a').querySelector('.ov-now')).toBe(line);
    expect(line.classList.contains('ov-now--refreshing')).toBe(true);
    expect(line.querySelector('.ov-now-text')?.textContent).toBe('Editing the door timer');
    expect(line.querySelector('.ov-now-text .ov-ch, .ov-flaprow')).toBeNull(); // never a skeleton over a readable line
    expect(line.querySelector('.ov-ai-meta > .ov-busy')).not.toBeNull();
    upsert('a', { digest: llmNow(LINE, { now_at: NOW }) });
    expect(line.classList.contains('ov-now--refreshing')).toBe(false);
    expect(line.querySelectorAll('.ov-ch[data-g]').length).toBeGreaterThan(0);
    vi.advanceTimersByTime(600);
    expect(line.querySelector('.ov-ai-meta')?.textContent).toBe('just now');
    // The same text written again (a newer time): no motion.
    upsert('a', { digest: llmNow(LINE, { now_status: pending }) });
    upsert('a', { digest: llmNow(LINE, { now_at: NOW + 1 }) });
    expect(line.querySelector('.ov-ch')).toBeNull();
  });

  it('a title’s now line flips in only when more than its spinner changed (#119: titleKey)', () => {
    const { ov, upsert, row } = setup([worker('a', { title: 'Fix the lift doors ⠋', digest: { now_source: 'title' } })]);
    ov.open('top');
    const line = row('a').querySelector<HTMLElement>('.ov-now') as HTMLElement;
    for (const f of ['⠙', '⠹', '⠸']) {
      upsert('a', { title: `Fix the lift doors ${f}` });
      expect(line.classList.contains('ov-flip-in'), f).toBe(false);
    }
    upsert('a', { title: '[ ! ] Action Required' });
    line.classList.remove('ov-flip-in');
    upsert('a', { title: '[ . ] Action Required' });
    expect(line.classList.contains('ov-flip-in')).toBe(false);
    upsert('a', { title: 'Fix the stairs ⠋' });
    expect(line.classList.contains('ov-flip-in')).toBe(true);
  });

  it('calm: a still bar that says it, no job and no frame; the model’s line shows at once', () => {
    const { ov, upsert, row, state } = setup([worker('a', { title: 'Reading hub.go', digest: titleNow() })], true);
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame');
    ov.open('top');
    const line = row('a').querySelector<HTMLElement>('.ov-now') as HTMLElement;
    expect(line.querySelector('.ov-fc')).toBeNull();
    expect(line.querySelector('.ov-flapbar')?.textContent).toBe('summarizing…');
    expect(line.querySelector('.ov-ai-meta')?.textContent).toBe('');
    expect(line.getAttribute('aria-busy')).toBe('true');
    upsert('a', { digest: llmNow(LINE) });
    expect(line.querySelector('.ov-ch')).toBeNull();
    expect(line.querySelector('.ov-now-text')?.textContent).toBe(LINE);
    expect(line.classList.contains('ov-flip-in')).toBe(false);
    expect(raf).not.toHaveBeenCalled();
    // Battery saver off again: a skeleton turns.
    state.calm = false;
    upsert('a', { digest: titleNow() });
    expect(row('a').querySelectorAll('.ov-now .ov-fc')).toHaveLength(40);
    expect(raf).toHaveBeenCalled();
  });

  it('a task line whose model line is on its way keeps its text and shows the busy mark (no skeleton)', () => {
    const { ov, row } = setup([worker('a', { digest: { task: 'Port the importer', task_source: 'prompt', task_status: pending, now: 'Reading the importer', now_source: 'llm', now_at: NOW } })]);
    ov.open('top');
    const task = row('a').querySelector<HTMLElement>('.ov-task') as HTMLElement;
    expect(task.querySelector('.ov-task-text')?.textContent).toBe('Port the importer');
    expect(task.querySelector('.ov-ai-meta > .ov-busy')).not.toBeNull();
    expect(task.querySelector('.ov-flaprow')).toBeNull();
    expect(task.hasAttribute('aria-busy')).toBe(false);
  });

  it('the label keeps the sparkle’s room only while its line awaits the model’s: the skeleton, a pending fallback (now and task)', () => {
    const capped = { state: 'pending', reason: 'daily_cap' } as const;
    const { ov, row, upsert } = setup([
      // Settled fallbacks (no status, retrying, failed): no room, no dead space after the label (#232).
      worker('settled', { digest: { task: 'Port the importer', task_source: 'prompt', now: 'Waiting for review', now_source: 'recap' } }),
      worker('failed', { digest: { task: 'Port it', task_source: 'prompt', task_status: { state: 'retrying' }, now: 'Waiting', now_source: 'recap', now_status: { state: 'failed' } } }),
      // Awaiting: the skeleton with a pending task fallback; the daily cap's wait over a fallback.
      worker('loading', { digest: { task: 'Port the importer', task_source: 'prompt', task_status: pending, ...titleNow() }, title: 'Reading' }),
      worker('capped', { digest: { task: 'Port it', task_source: 'prompt', task_status: capped, now: 'Waiting', now_source: 'recap', now_status: capped } }),
      // The model's lines: the sparkle itself, no room.
      worker('llm', { digest: { task: 'x', task_source: 'llm', ...llmNow(LINE, { now_status: pending }) } }),
    ]);
    ov.open('top');
    const rooms = (id: string) => ['.ov-task', '.ov-now'].map((l) => row(id).querySelectorAll(`${l} > b > .ov-ai-room`).length);
    expect(rooms('settled')).toEqual([0, 0]);
    expect(rooms('failed')).toEqual([0, 0]);
    expect(row('loading').querySelector('.ov-now')?.classList.contains('ov-now--loading')).toBe(true);
    expect(rooms('loading')).toEqual([1, 1]);
    expect(rooms('capped')).toEqual([1, 1]);
    expect(rooms('llm')).toEqual([0, 0]);
    expect(row('llm').querySelectorAll('b > .ov-ai')).toHaveLength(2);
    // The room is for no one: hidden from assistive tech, no name, no text.
    for (const r of document.querySelectorAll('.ov-ai-room')) {
      expect(r.getAttribute('aria-hidden')).toBe('true');
      expect(r.hasAttribute('role') || r.hasAttribute('title') || r.hasAttribute('aria-label')).toBe(false);
      expect(r.textContent).toBe('');
    }
    // A settled fallback's task gets the room once the model's line is on its way, and loses it if the call fails.
    upsert('settled', { digest: { task: 'Port the importer', task_source: 'prompt', task_status: pending, now: 'Waiting for review', now_source: 'recap' } });
    expect(rooms('settled')).toEqual([1, 0]);
    upsert('settled', { digest: { task: 'Port the importer', task_source: 'prompt', task_status: { state: 'failed' }, now: 'Waiting for review', now_source: 'recap' } });
    expect(rooms('settled')).toEqual([0, 0]);
  });
});
