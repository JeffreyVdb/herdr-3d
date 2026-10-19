// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../net/client';
import { flush, installDialogs, secretsBridge } from '../test/secretsBridge';
import type { Draft as PromptDraft } from './composer/draft';
import { HireDialog, HIRE_ASK_TEXT, type HireHost } from './hire';
import { HirePrefs } from './hirePrefs';

// #117: a plain Hire asks the classifier (`hire_preset.check`) about the first task after the secrets review; on a "yes"
// with the box off the dialog asks "Hire with instructions" / "Hire without". Anything but a "yes" in time hires as typed.

const prep = {
  cwd: '/home/test',
  label: 'default',
  git: null,
  choice: { harness: 'codex', model: 'gpt', effort: 'high' },
  choice_source: 'floor_default',
  capacity: { floor: { count: 0, soft: 10, hard: 20 }, host: { count: 0, soft: 10, hard: 20 } },
};
const LINES = 'Start every agent you hire in its own herdr workspace or tab.\n\nAlso tag every herdr workspace you create with the token h3d_floor=v-0123456789ab.';
const TASK = 'Upgrade service per service. Start an agent for each service and let it roll out the upgrade.';
const SECRET_TASK = 'Start an agent per service with TOKEN=ghp_abcdefghijklmnopqrstu1 and report back';
const enc = new TextEncoder();

interface Inner {
  editor: { draft: PromptDraft };
}

interface Opts {
  lines?: string | null;
  /** The classifier's state in the store (`ready` by default). */
  classifier?: string;
  /** What `hire_preset.check` answers (default: a yes). */
  check?: (args: Record<string, unknown>) => CommandResult | Promise<CommandResult>;
  secrets?: boolean;
  background?: boolean;
  hires?: CommandResult[];
  unsupported?: string[];
}

function setup(o: Opts = {}) {
  document.body.replaceChildren();
  const b = o.secrets ? secretsBridge({ on: true }) : null;
  const sent: Array<{ t: string; args: Record<string, unknown> }> = [];
  const toasts: string[] = [];
  const holds = new Set<number>();
  const answers = [...(o.hires ?? [])];
  const prefs = new HirePrefs(null);
  prefs.hireInBackground = o.background === true;
  const lines = o.lines === undefined ? LINES : o.lines;
  const host = {
    store: {
      floorName: (id: string) => id,
      hireOptions: { codex: { models: ['gpt'], efforts: ['high'] } },
      floorView: () => ({ seats: Array(10).fill(null) }),
      limits: { version: 0, list: () => [] },
      workerView: () => null,
      hirePresets: { known: true, instructions: lines !== null },
      ai: { state: { classifier: { state: o.classifier ?? 'ready' } } },
    },
    send: (t: string, args: Record<string, unknown>) => {
      sent.push({ t, args });
      if (t === 'hire.prepare') return Promise.resolve({ ok: true, data: lines === null ? prep : { ...prep, herdr_instructions: lines } });
      if (t === 'hire_preset.check') return Promise.resolve(o.check ? o.check(args) : { ok: true, data: { delegates: true, score: 0.9 } });
      return Promise.resolve(answers.shift() ?? { ok: true, data: { id: 'w9', prompted: true } });
    },
    unsupported: (t: string) => !!o.unsupported?.includes(t),
    reserve: (_s: string, d: number) => {
      holds.add(d);
      return () => holds.delete(d);
    },
    held: () => holds,
    toast: (text: string) => void toasts.push(text),
    hirePrefs: prefs,
    now: () => Date.now(),
    upload: () => new Promise(() => {}),
    ...(b ? { secrets: b.flow } : {}),
  } as unknown as HireHost;
  const dlg = new HireDialog(document.body, host);
  const hires = () => sent.filter((s) => s.t === 'worker.hire').map((s) => s.args);
  const checks = () => sent.filter((s) => s.t === 'hire_preset.check').map((s) => s.args);
  return { b, dlg, inner: dlg as unknown as Inner, sent, hires, checks, holds, toasts };
}
type T = ReturnType<typeof setup>;

async function typed(t: T, text: string, desk = 0) {
  t.dlg.open('floor', desk);
  await flush();
  t.inner.editor.draft.replace(0, 0, text);
  await flush();
}

const press = (key: string) => document.querySelector<HTMLElement>(`.desk-dlg--hire [data-key="${key}"]`)!.click();
const hirePress = async () => {
  press('hire');
  await flush();
};
const ask = () => document.querySelector<HTMLElement>('[data-hook="hire-ask"]');
const box = () => document.querySelector<HTMLInputElement>('#hire-instructions');
const keydown = (el: Element, init: KeyboardEventInit) => el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
const esc = () => {
  const e = new Event('cancel', { cancelable: true });
  document.querySelector('dialog.desk-dlg--hire')!.dispatchEvent(e);
  return e;
};

describe('HireDialog asks about the herdr hiring instructions (#117)', () => {
  beforeEach(() => {
    localStorage.clear();
    installDialogs();
    vi.stubGlobal('CSS', { escape: (s: string) => s });
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('a task the classifier says starts agents: Hire asks in the dialog, nothing is hired, focus on the question', async () => {
    const t = setup();
    await typed(t, TASK);
    await hirePress();
    expect(t.checks()).toEqual([{ prompt: TASK }]);
    expect(t.hires()).toEqual([]);
    expect(ask()?.textContent).toContain(HIRE_ASK_TEXT);
    expect(document.activeElement?.getAttribute('data-key')).toBe('ask-with');
    expect(t.dlg.summary()).toMatchObject({ state: 'ready', asking: true, blocker: 'Answer the question above first.' });
    expect(t.holds.size).toBe(0);
    // Hire again (Enter in the task, a click) never answers it.
    keydown(document.querySelector('#hire-task')!, { key: 'Enter' });
    await hirePress();
    expect(t.hires()).toEqual([]);
    expect(t.checks()).toHaveLength(1);
    expect(ask()).not.toBeNull();
  });

  it('after the secrets review, and with its secrets', async () => {
    const t = setup({ secrets: true });
    await typed(t, SECRET_TASK);
    await hirePress();
    expect(t.b!.open()).not.toBeNull();
    expect(t.checks()).toEqual([]);
    t.b!.confirm();
    await flush();
    const [check] = t.checks();
    expect(check).toMatchObject({ prompt: SECRET_TASK, secrets: { decisions: [{ candidate: 'c1', action: 'protect' }] } });
    expect(ask()).not.toBeNull();
    expect(t.hires()).toEqual([]);
    press('ask-with');
    await flush();
    const [args] = t.hires();
    expect(args).toMatchObject({ prompt: SECRET_TASK, herdr_instructions: true, secrets: check!.secrets });
  });

  it('“Hire with instructions” ticks the box and sends the flag with the typed task, never the lines', async () => {
    const t = setup();
    await typed(t, TASK);
    await hirePress();
    press('ask-with');
    await flush();
    expect(t.hires()).toEqual([expect.objectContaining({ floor: 'floor', prompt: TASK, herdr_instructions: true })]);
    expect(JSON.stringify(t.hires())).not.toContain('h3d_floor');
    expect(t.dlg.isOpen).toBe(false);
  });

  it('“Hire without” hires as typed, and the same text is not asked about again (a failed hire, Hire again); another text is', async () => {
    const t = setup({ hires: [{ ok: false, code: 'hire_failed', message: 'nope' }] });
    await typed(t, TASK);
    await hirePress();
    press('ask-without');
    await flush();
    expect(t.hires()).toHaveLength(1);
    expect(t.hires()[0]).not.toHaveProperty('herdr_instructions');
    expect(t.dlg.summary()).toMatchObject({ state: 'ready', error: true });
    await hirePress();
    expect(t.checks()).toHaveLength(1);
    expect(ask()).toBeNull();
    expect(t.hires()).toHaveLength(2);
    expect(t.hires()[1]).not.toHaveProperty('herdr_instructions');
    // Another text on the same form asks again.
    t.dlg.open('floor', 1);
    await flush();
    t.inner.editor.draft.replace(0, 0, `${TASK} More.`);
    await flush();
    await hirePress();
    expect(t.checks()).toHaveLength(2);
    expect(ask()).not.toBeNull();
  });

  it('Esc on the question goes back to the form: not hired, the task and box kept, the dialog open', async () => {
    const t = setup();
    await typed(t, TASK);
    await hirePress();
    const e = esc();
    expect(e.defaultPrevented).toBe(true);
    expect(ask()).toBeNull();
    expect(t.hires()).toEqual([]);
    expect(t.dlg.isOpen).toBe(true);
    expect(t.dlg.summary()).toMatchObject({ state: 'ready', blocker: null, form: { prompt: TASK }, status: 'Not hired: the first task is still here.', instructions: { on: false } });
    expect(document.querySelector('[data-key="hire"]')?.getAttribute('aria-disabled')).toBeNull();
    // Not an answer: asked again at the next Hire.
    await hirePress();
    expect(ask()).not.toBeNull();
    expect(t.checks()).toHaveLength(2);
    // Esc once more with no question is the dialog's own.
    esc();
    const e2 = esc();
    expect(e2.defaultPrevented).toBe(false);
  });

  it('the Enter that pressed Hire does not answer it: only a fresh keydown on the question does, never a repeat', async () => {
    const t = setup();
    await typed(t, TASK);
    // Enter in the task starts the hire; the question only exists once the classifier answered.
    keydown(document.querySelector('#hire-task')!, { key: 'Enter' });
    expect(ask()).toBeNull();
    await flush();
    expect(ask()).not.toBeNull();
    expect(t.hires()).toEqual([]);
    // The key still down (repeat) and its release land on the question: nothing is answered.
    const withBtn = document.querySelector<HTMLElement>('[data-key="ask-with"]')!;
    expect(keydown(withBtn, { key: 'Enter', repeat: true })).toBe(false);
    withBtn.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    await flush();
    expect(t.hires()).toEqual([]);
    expect(ask()).not.toBeNull();
    // A fresh press is the player's answer (a button takes Enter as a click).
    expect(keydown(withBtn, { key: 'Enter' })).toBe(true);
    withBtn.click();
    await flush();
    expect(t.hires()).toEqual([expect.objectContaining({ herdr_instructions: true })]);
  });

  it('a task that does not fit with the lines: “with” returns to the form, box ticked, blocker said; Hire stays off until it fits', async () => {
    const t = setup();
    const room = 32 * 1024 - 2 - enc.encode(LINES).length;
    const task = `Start an agent. ${'x'.repeat(room - 16 + 1)}`;
    await typed(t, task);
    // Not over the limit as typed.
    expect(t.dlg.summary()!.blocker).toBeNull();
    await hirePress();
    expect(ask()).not.toBeNull();
    press('ask-with');
    await flush();
    expect(t.hires()).toEqual([]);
    expect(ask()).toBeNull();
    expect(box()?.checked).toBe(true);
    expect(t.dlg.summary()).toMatchObject({ state: 'ready', error: true, instructions: { on: true } });
    expect(t.dlg.summary()!.status).toContain('over 32 KiB');
    expect(t.dlg.summary()!.blocker).toContain('over 32 KiB');
  });

  it('fails open: a timeout, an error, an older bridge and a classifier not ready all hire as typed, with no question', async () => {
    const cases: Array<[string, Opts]> = [
      ['timeout', { check: () => ({ ok: false, code: 'timeout', message: 'no answer' }) }],
      ['error', { check: () => ({ ok: false, code: 'internal', message: 'boom' }) }],
      ['old bridge: unknown_command', { check: () => ({ ok: false, code: 'unknown_command', message: '' }) }],
      ['bridge without the check', { unsupported: ['hire_preset.check'] }],
      ['bridge without the box', { lines: null }],
      ['classifier not ready', { classifier: 'off' }],
      ['classifier says no', { check: () => ({ ok: true, data: { delegates: false, score: 0.1 } }) }],
    ];
    for (const [name, o] of cases) {
      const t = setup(o);
      await typed(t, TASK);
      await hirePress();
      expect(ask(), name).toBeNull();
      expect(t.hires(), name).toHaveLength(1);
      expect(t.hires()[0], name).not.toHaveProperty('herdr_instructions');
      expect(t.dlg.isOpen, name).toBe(false);
    }
  });

  it('asks nothing when the classifier is not called: the box ticked, the task names h3d_floor, a preset form, no task', async () => {
    const ticked = setup();
    await typed(ticked, TASK);
    box()!.checked = true;
    box()!.dispatchEvent(new Event('change'));
    await hirePress();
    expect(ticked.checks()).toEqual([]);
    expect(ticked.hires()).toEqual([expect.objectContaining({ herdr_instructions: true })]);
    const floor = setup();
    await typed(floor, `${TASK} Tag each with h3d_floor=x.`);
    await hirePress();
    expect(floor.checks()).toEqual([]);
    expect(floor.hires()).toHaveLength(1);
    const preset = setup();
    preset.dlg.open('floor', 0, { prompt: TASK, choice: { harness: 'codex', model: 'gpt', effort: 'high' }, preset: { id: 'hp_1', name: 'Deploy', scope: 'floor' } });
    await flush();
    await hirePress();
    expect(preset.checks()).toEqual([]);
    expect(preset.hires()).toHaveLength(1);
    const bare = setup();
    bare.dlg.open('floor', 0);
    await flush();
    await hirePress();
    expect(bare.checks()).toEqual([]);
    expect(bare.hires()).toHaveLength(1);
  });

  it('in the background: the check and the question come before the dialog closes; the answer closes it and hires', async () => {
    const t = setup({ background: true });
    await typed(t, TASK);
    await hirePress();
    expect(t.dlg.isOpen).toBe(true);
    expect(ask()).not.toBeNull();
    expect(t.hires()).toEqual([]);
    expect(t.holds.size).toBe(0);
    press('ask-with');
    await flush();
    expect(t.dlg.isOpen).toBe(false);
    expect(t.hires()).toEqual([expect.objectContaining({ herdr_instructions: true })]);
    // A "no" in the background closes the dialog at once, as before.
    const no = setup({ background: true, check: () => ({ ok: true, data: { delegates: false, score: 0 } }) });
    await typed(no, TASK);
    await hirePress();
    expect(no.dlg.isOpen).toBe(false);
    expect(no.hires()).toHaveLength(1);
  });

  it('closed while the classifier is asked: nobody is hired, and the toast says it was not checked', async () => {
    let answer: (r: CommandResult) => void = () => {};
    const t = setup({ check: () => new Promise<CommandResult>((r) => (answer = r)) });
    await typed(t, TASK);
    await hirePress();
    expect(t.dlg.summary()).toMatchObject({ state: 'hiring', status: 'Checking whether the first task starts other agents…' });
    esc();
    t.dlg.close();
    answer({ ok: true, data: { delegates: true, score: 0.9 } });
    await flush();
    expect(t.hires()).toEqual([]);
    expect(t.toasts).toEqual(['Not hired: it was closed before its first task was checked.']);
  });

  it('a change to the form takes the question back: Hire asks again with the form as it is', async () => {
    const t = setup();
    await typed(t, TASK);
    await hirePress();
    expect(ask()).not.toBeNull();
    t.inner.editor.draft.replace(0, 0, 'First, ');
    await flush();
    expect(ask()).toBeNull();
    expect(t.hires()).toEqual([]);
    await hirePress();
    expect(ask()).not.toBeNull();
    expect(t.checks()[1]).toEqual({ prompt: `First, ${TASK}` });
  });
});
