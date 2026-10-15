// @vitest-environment jsdom
// #58 decision 3: a hire on a virtual floor whose session is asleep is not refused: the bridge wakes the session first,
// and the dialog says "Waking floor…" until the floor is up. A real asleep floor still takes nobody.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HireDialog, type HireHost } from './hire';

const prep = {
  cwd: '/home/test',
  label: 'Nibble',
  git: null,
  choice: { harness: 'codex', model: 'gpt', effort: 'high' },
  choice_source: 'floor_default',
  capacity: { floor: { count: 0, soft: 10, hard: 20 }, host: { count: 0, soft: 10, hard: 20 } },
};

const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(state: { asleep: boolean; virtual: boolean; transition: 'waking' | null }) {
  let ack!: (r: unknown) => void;
  const toasts: string[] = [];
  const sent: Array<[string, unknown]> = [];
  const view = () => ({ seats: Array(10).fill(null), name: 'Frontend', ...state });
  const host = {
    store: { floorName: () => 'Frontend', hireOptions: { codex: { models: ['gpt'], efforts: ['high'] } }, floorView: view, limits: { version: 0, list: () => [] }, workerView: () => null },
    send: async (t: string, a: unknown) => {
      sent.push([t, a]);
      return t === 'hire.prepare' ? { ok: true, data: prep } : await new Promise((r) => (ack = r));
    },
    unsupported: () => false,
    reserve: () => () => {},
    held: () => new Set<number>(),
    toast: (m: string) => void toasts.push(m),
    now: () => Date.now(),
    upload: () => Promise.resolve(),
  } as unknown as HireHost;
  const dlg = new HireDialog(document.body, host);
  return { dlg, toasts, sent, state, inner: dlg as unknown as { hire(): Promise<void> }, ack: (r: unknown) => ack(r) };
}

describe('HireDialog on an asleep virtual floor (#58 decision 3)', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
    vi.stubGlobal('CSS', { escape: (s: string) => s });
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('stays open, hires by the floor id, and says "Waking floor…" until the session is up', async () => {
    const t = setup({ asleep: true, virtual: true, transition: null });
    t.dlg.open('v-0123456789ab', 2);
    await tick();
    t.dlg.refresh();
    expect(t.dlg.summary()).toMatchObject({ kind: 'hire', floor: 'v-0123456789ab', state: 'ready' });
    const done = t.inner.hire();
    await tick();
    expect(t.sent.find(([c]) => c === 'worker.hire')?.[1]).toMatchObject({ floor: 'v-0123456789ab', desk_index: 2 });
    expect(document.querySelector('.dd-status')?.textContent).toBe('Waking floor Frontend… then Hiring Nibble: starting codex…');
    // The bridge's wake: the floor is waking, then up.
    Object.assign(t.state, { transition: 'waking' });
    t.dlg.refresh();
    expect(document.querySelector('.dd-status')?.textContent).toMatch(/^Waking floor Frontend…/);
    Object.assign(t.state, { asleep: false, transition: null });
    t.dlg.refresh();
    expect(document.querySelector('.dd-status')?.textContent).toBe('Hiring Nibble: starting codex…');
    t.ack({ ok: true, data: { id: 'w9', workspace_id: 'w9', trust: 'ok' } });
    await done;
    expect(t.toasts.some((m) => /asleep|went to sleep/.test(m))).toBe(false);
  });

  it('closes on a real floor that goes to sleep, as before', async () => {
    const t = setup({ asleep: false, virtual: false, transition: null });
    t.dlg.open('main', 0);
    await tick();
    Object.assign(t.state, { asleep: true });
    t.dlg.refresh();
    expect(t.dlg.summary()).toBeNull();
    expect(t.toasts).toEqual(['Frontend went to sleep; wake it to hire.']);
  });
});
