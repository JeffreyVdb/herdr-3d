// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Worker } from '../net/protocol';
import type { Counts, FloorView, WorkerView } from '../world/store';
import { Hud, workerShown } from './hud';

const view = (over: Partial<Worker>, harness?: string): WorkerView => ({
  worker: { id: 'w', session: 's', floor: 's', workspace_id: 'ws', label: 'l', name: 'Pip', status: 'idle', status_since: 0, ...over },
  name: 'Pip',
  desk: 0,
  harness,
  since: 0,
  display: 'idle',
});

describe('the look-at bar’s key (#229)', () => {
  it('has the shown model (readable, no harness word) and still the exact id and the harness', () => {
    const k = workerShown(view({ model: 'claude-opus-5-5', effort: 'high' }, 'claude'), {});
    expect(k).toContain('Opus 5.5 high');
    expect(k).toContain('claude-opus-5-5');
    expect(k).toContain('claude');
    expect(k.join('\n')).not.toContain('claude opus');
  });

  it('a harness- or id-only change changes it, so the bar redraws', () => {
    const a = workerShown(view({ model: 'gpt-6-sol' }, 'codex'), {});
    expect(workerShown(view({ model: 'gpt-6-sol' }, 'claude'), {})).not.toEqual(a);
    const labelled = { codex: { models: ['gpt-6-sol', 'sol'], efforts: [], model_labels: { 'gpt-6-sol': 'Sol', sol: 'Sol' } } };
    expect(workerShown(view({ model: 'gpt-6-sol' }, 'codex'), labelled)).not.toEqual(workerShown(view({ model: 'sol' }, 'codex'), labelled));
  });
});

describe('the top bar’s counts (#144)', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', (f: () => void) => setTimeout(f, 0));
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  const usage = (tokens: number, cost: number) => ({ tokens, cost_usd_est: cost, priced: 'known' as const, model: 'claude-opus-5-5' });
  const floor = (counts: Partial<Counts>, workers: WorkerView[]): FloorView =>
    ({ id: 'top', name: 'Top', building: null, level: null, desks: 2, asleep: false, seats: workers, workers, counts: { working: 0, needsYou: 0, idle: 0, done: 0, waiting: 0, total: workers.length, ...counts } }) as FloorView;

  it('keeps its items when they say the same (a usage change), and the usage total still follows', () => {
    const hud = new Hud(document.body);
    const counts = document.querySelector<HTMLElement>('.topbar-counts')!;
    const total = document.querySelector<HTMLElement>('.topbar-usage')!;
    hud.setFloor(floor({ working: 1 }, [view({ usage: usage(1000, 0.5) })]));
    const first = counts.firstElementChild;
    expect(first).not.toBeNull();
    expect(total.textContent).toContain('0.50');
    hud.setFloor(floor({ working: 1 }, [view({ usage: usage(9000, 2.25) })]));
    expect(counts.firstElementChild).toBe(first); // not drawn again
    expect(total.textContent).toContain('2.25');
    // A count that changes draws them again; so does the city's.
    hud.setFloor(floor({ working: 0, idle: 1 }, [view({ usage: usage(9000, 2.25) })]));
    expect(counts.firstElementChild).not.toBe(first);
    expect(counts.textContent).toContain('1');
    const floorItems = counts.innerHTML;
    hud.setCity(1, 1, { working: 0, needsYou: 0, idle: 1, done: 0, waiting: 0, total: 1 });
    expect(counts.innerHTML).toBe(floorItems);
    hud.setFloor({ ...floor({ idle: 1 }, [view({})]), asleep: true });
    expect(counts.innerHTML).not.toBe(floorItems); // asleep says so
  });
});
