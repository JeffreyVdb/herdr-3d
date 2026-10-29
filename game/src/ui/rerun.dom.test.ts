// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HireDialog, type HireHost, type HirePrefill } from './hire';
import { RerunPicker, startChoice, type RerunPickerHost } from './rerunPicker';

// Run elsewhere: the picker over the seat (the other harness first, Enter hires, Edit first opens the dialog without
// hiring), and the Hire dialog's `go`: it hires once the floor is checked, with `rerun_of` to a bridge that takes it.

const tick = () => new Promise((r) => setTimeout(r, 0));

const OPTIONS = {
  claude: { models: ['claude-opus-5-5', 'claude-fable-5-1'], efforts: ['high', 'max'] },
  codex: { models: ['gpt-6-sol', 'gpt-6-luna'], efforts: ['high', 'xhigh'] },
};

beforeEach(() => {
  localStorage.clear();
  // jsdom has no modal dialogs.
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

describe('startChoice', () => {
  it('is the other harness, keeping the effort when that model takes it', () => {
    expect(startChoice(OPTIONS, { harness: 'claude', model: 'claude-opus-5-5', effort: 'high' })).toEqual({ harness: 'codex', model: 'gpt-6-sol', effort: 'high' });
    expect(startChoice(OPTIONS, { harness: 'codex', effort: 'xhigh' })).toEqual({ harness: 'claude', model: 'claude-opus-5-5', effort: 'high' });
  });

  it('is the same harness and model when the catalog has no other', () => {
    expect(startChoice({ claude: OPTIONS.claude }, { harness: 'claude', model: 'claude-fable-5-1', effort: 'max' })).toEqual({ harness: 'claude', model: 'claude-fable-5-1', effort: 'max' });
  });
});

describe('RerunPicker', () => {
  function setup(desk: { desk: number } | { why: string } = { desk: 6 }) {
    const hires: Array<{ floor: string; desk: number; prefill: HirePrefill }> = [];
    const worker = { id: 'w1', floor: 'f1', harness: 'claude', model: 'claude-opus-5-5', effort: 'high', cwd: '/repo/infra' };
    const host: RerunPickerHost = {
      store: { hireOptions: OPTIONS, workerView: (id: string) => (id === 'w1' ? { worker, name: 'Thimble', harness: 'claude' } : null) } as unknown as RerunPickerHost['store'],
      desk: () => desk,
      hire: (floor, d, prefill) => void hires.push({ floor, desk: d, prefill }),
    };
    const picker = new RerunPicker(document.body, host);
    return { picker, hires };
  }
  const checked = (name: string) => document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value;

  it('opens on the other harness and says what the worker runs now', () => {
    const { picker } = setup();
    expect(picker.open({ worker: 'w1', text: 'Read the logs', first: true, anchor: null })).toBe(true);
    expect(picker.keepsSeat).toBe(true);
    expect(checked('rerun-harness')).toBe('codex');
    expect(checked('rerun-model')).toBe('gpt-6-sol');
    expect(document.querySelector('#rerun-title')?.textContent).toBe('Run Thimble’s first message elsewhere');
    expect(document.querySelector('.rerun-now')?.textContent).toBe('Thimble runs Claude Code · Opus 5.5 · high.');
    expect(document.querySelector('.rerun-where')?.textContent).toContain('Desk 7');
  });

  it('Enter hires the picked model over the seat: the message, its folder, a worktree, rerun_of', () => {
    const { picker, hires } = setup();
    picker.open({ worker: 'w1', text: 'Read the logs', first: true, anchor: null });
    const luna = document.querySelector<HTMLInputElement>('input[name="rerun-model"][value="gpt-6-luna"]')!;
    luna.checked = true;
    luna.dispatchEvent(new Event('change'));
    picker.dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(hires).toEqual([
      {
        floor: 'f1',
        desk: 6,
        prefill: { prompt: 'Read the logs', choice: { harness: 'codex', model: 'gpt-6-luna', effort: 'high' }, worktree: true, seated: true, rerunOf: 'w1', cwd: '/repo/infra', go: true },
      },
    ]);
    expect(picker.isOpen).toBe(false);
  });

  it('Edit first opens the dialog without hiring; a later message says the turns before it stay', () => {
    const { picker, hires } = setup();
    picker.open({ worker: 'w1', text: 'Now the prefixes', first: false, anchor: null });
    expect(document.querySelector('.rerun-sub')?.textContent).toContain('the turns before it stay here');
    document.querySelector<HTMLButtonElement>('[data-key="rerun-edit"]')!.click();
    expect(hires[0]?.prefill.go).toBeUndefined();
    expect(hires[0]?.prefill.prompt).toBe('Now the prefixes');
  });

  it('says only the words go when the message has images', () => {
    const { picker } = setup();
    picker.open({ worker: 'w1', text: 'See the screenshot', first: true, anchor: null, images: true });
    expect(document.querySelector('.rerun-body')?.textContent).toContain('An image in this message is not text');
  });

  it('with no free desk: says why, and nothing hires', () => {
    const { picker, hires } = setup({ why: 'No free desk on Work right now.' });
    picker.open({ worker: 'w1', text: 'Read the logs', first: true, anchor: null });
    expect(document.querySelector('.rerun-where[data-error="true"]')?.textContent).toBe('No free desk on Work right now.');
    expect(document.querySelector<HTMLButtonElement>('[data-key="rerun-hire"]')!.disabled).toBe(true);
    picker.dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(hires).toEqual([]);
  });
});

describe('HireDialog go (Run elsewhere)', () => {
  const prep = {
    cwd: '/repo/infra',
    label: 'Clover',
    git: null,
    choice: { harness: 'claude', model: 'claude-opus-5-5', effort: 'high' },
    choice_source: 'floor_default',
    capacity: { floor: { count: 0, soft: 10, hard: 20 }, host: { count: 0, soft: 10, hard: 20 } },
  };
  function setup(rerun: boolean) {
    const sent: Array<[string, unknown]> = [];
    const host = {
      store: { floorName: (id: string) => id, hireOptions: OPTIONS, rerun, floorView: () => ({ seats: Array(10).fill(null) }), limits: { version: 0, list: () => [] }, workerView: () => null },
      send: async (t: string, args: unknown) => {
        sent.push([t, args]);
        return t === 'hire.prepare' ? { ok: true, data: prep } : await new Promise(() => undefined);
      },
      unsupported: () => false,
      reserve: () => () => undefined,
      held: () => new Set<number>(),
      toast: () => undefined,
      goTo: () => undefined,
      now: () => Date.now(),
    } as unknown as HireHost;
    return { dlg: new HireDialog(document.body, host), sent };
  }
  const fill: HirePrefill = { prompt: 'Read the logs', choice: { harness: 'codex', model: 'gpt-6-sol', effort: 'xhigh' }, cwd: '/repo/infra', rerunOf: 'w1', seated: true, go: true };

  it.each([true, false])('hires once the floor is checked, rerun_of only to a bridge that takes it (%s)', async (rerun) => {
    const { dlg, sent } = setup(rerun);
    dlg.open('f1', 6, fill);
    expect(dlg.keepsSeat).toBe(true);
    await tick();
    await tick();
    expect(sent[0]).toEqual(['hire.prepare', { floor: 'f1', cwd: '/repo/infra' }]);
    const hire = sent.find(([t]) => t === 'worker.hire')?.[1] as Record<string, unknown> | undefined;
    expect(hire).toMatchObject({ floor: 'f1', desk_index: 6, harness: 'codex', model: 'gpt-6-sol', effort: 'xhigh', prompt: 'Read the logs' });
    expect(hire?.rerun_of).toBe(rerun ? 'w1' : undefined);
    dlg.close();
  });

  it('without go it waits for Hire, and keeps no seat unless asked', async () => {
    const { dlg, sent } = setup(true);
    dlg.open('f1', 6, { prompt: 'Read the logs' });
    expect(dlg.keepsSeat).toBe(false);
    await tick();
    expect(sent.map(([t]) => t)).toEqual(['hire.prepare']);
    dlg.close();
  });
});
