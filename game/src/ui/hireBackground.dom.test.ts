// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../net/client';
import type { Draft as PromptDraft } from './composer/draft';
import { HireDialog, type HireHost } from './hire';
import { HirePrefs } from './hirePrefs';

// #210: Hire in background: the dialog snapshots what was reviewed, holds the desk and closes at once; the outcome is
// one toast (and one beep on success), never a go-to, and it never touches a dialog opened since.

const prep = {
  cwd: '/home/test',
  label: 'default',
  git: null,
  choice: { harness: 'codex', model: 'gpt', effort: 'high' },
  choice_source: 'floor_default',
  capacity: { floor: { count: 0, soft: 10, hard: 20 }, host: { count: 0, soft: 10, hard: 20 } },
};

const tick = () => new Promise((r) => setTimeout(r, 0));
const key = (desk: number) => `h3d.draft.hire.floor:${desk}`;

interface Inner {
  editor: { draft: PromptDraft };
  hire(): Promise<void>;
}

function setup() {
  const hires: Array<{ args: Record<string, unknown>; answer: (r: CommandResult) => void }> = [];
  const holds = new Set<number>();
  const goTos: string[] = [];
  const toasts: Array<{ text: string; kind: string }> = [];
  let beeps = 0;
  const prefs = new HirePrefs(null);
  prefs.hireInBackground = true;
  const host = {
    store: { hireOptions: { codex: { models: ['gpt'], efforts: ['high'] } }, floorView: () => ({ seats: Array(10).fill(null) }), limits: { version: 0, list: () => [] }, workerView: () => null },
    send: (t: string, args: Record<string, unknown>) => (t === 'hire.prepare' ? Promise.resolve({ ok: true, data: prep }) : new Promise((answer) => hires.push({ args, answer }))),
    unsupported: () => false,
    reserve: (_s: string, d: number) => {
      holds.add(d);
      return () => holds.delete(d);
    },
    held: () => holds,
    toast: (text: string, kind: string) => void toasts.push({ text, kind }),
    goTo: (id: string) => void goTos.push(id),
    beep: () => void beeps++,
    hirePrefs: prefs,
    now: () => Date.now(),
    upload: () => new Promise(() => {}),
  } as unknown as HireHost;
  const dlg = new HireDialog(document.body, host);
  return { dlg, inner: dlg as unknown as Inner, prefs, hires, holds, goTos, toasts, beeps: () => beeps };
}

async function typed(t: ReturnType<typeof setup>, desk: number, text: string) {
  t.dlg.open('floor', desk);
  await tick();
  t.inner.editor.draft.replace(0, 0, text);
}

describe('HireDialog: Hire in background (#210)', () => {
  beforeEach(() => {
    localStorage.clear();
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

  it('closes at once with the desk held; on the ack: the exact toast, one beep, no go-to, the sent draft cleared', async () => {
    const t = setup();
    await typed(t, 0, 'label the loaves');
    const pending = t.inner.hire();
    expect(t.dlg.isOpen).toBe(false);
    expect(t.holds.has(0)).toBe(true);
    await tick();
    expect(t.hires).toHaveLength(1);
    expect(t.hires[0]!.args).toMatchObject({ desk_index: 0, prompt: 'label the loaves' });
    expect(t.toasts).toEqual([]);
    expect(t.beeps()).toBe(0);
    t.hires[0]!.answer({ ok: true, data: { id: 'w1', prompted: true } });
    await pending;
    expect(t.toasts).toEqual([{ text: 'Agent spawned successfully.', kind: 'info' }]);
    expect(t.beeps()).toBe(1);
    expect(t.goTos).toEqual([]);
    expect(t.holds.has(0)).toBe(false);
    expect(localStorage.getItem(key(0))).toBeNull();
  });

  it('reads the setting once, at Hire: switching it off on the way still ends in the background (no go-to, no dialog)', async () => {
    const t = setup();
    await typed(t, 0, 'go');
    const pending = t.inner.hire();
    t.prefs.hireInBackground = false;
    await tick();
    t.hires[0]!.answer({ ok: true, data: { id: 'w1', prompted: true } });
    await pending;
    expect(t.goTos).toEqual([]);
    expect(t.toasts.map((x) => x.text)).toEqual(['Agent spawned successfully.']);
  });

  it('a second Hire (Enter again) on the same dialog is the same hire: one worker.hire', async () => {
    const t = setup();
    await typed(t, 0, 'once');
    const a = t.inner.hire();
    const b = t.inner.hire();
    await tick();
    expect(t.hires).toHaveLength(1);
    t.hires[0]!.answer({ ok: true, data: { id: 'w1', prompted: true } });
    await Promise.all([a, b]);
    expect(t.toasts).toHaveLength(1);
    expect(t.beeps()).toBe(1);
  });

  it('two hires on their way; a third dialog being edited when they end keeps its edits and is told nothing', async () => {
    const t = setup();
    await typed(t, 0, 'first');
    const a = t.inner.hire();
    await typed(t, 1, 'second');
    const b = t.inner.hire();
    await tick();
    expect(t.hires.map((h) => h.args.desk_index)).toEqual([0, 1]);
    expect([...t.holds]).toEqual([0, 1]);
    await typed(t, 2, 'third, being written');
    t.hires[1]!.answer({ ok: true, data: { id: 'w2', prompted: true } });
    await b;
    expect([...t.holds]).toEqual([0]);
    expect(t.dlg.isOpen).toBe(true);
    expect(t.dlg.summary()).toMatchObject({ desk: 2, state: 'ready', status: '', error: false });
    t.inner.editor.draft.replace(t.inner.editor.draft.doc.text.length, t.inner.editor.draft.doc.text.length, ' more');
    t.hires[0]!.answer({ ok: false, code: 'hire_failed', message: 'claude exited' });
    await a;
    expect(t.dlg.summary()).toMatchObject({ desk: 2, state: 'ready', status: '', error: false });
    expect(t.inner.editor.draft.doc.text).toBe('third, being written more');
    expect(t.toasts.map((x) => x.kind)).toEqual(['info', 'error']);
    expect(t.toasts[1]!.text).toMatch(/^Desk 1 of floor · /);
    expect(t.beeps()).toBe(1);
    // The failed one's task is kept for a retry; the hired one's is cleared.
    expect(localStorage.getItem(key(0))).toContain('first');
    expect(localStorage.getItem(key(1))).toBeNull();
  });

  it('reopening the same desk and editing while its hire is on its way: the edit is kept, what was sent is what was reviewed', async () => {
    const t = setup();
    await typed(t, 0, 'as reviewed');
    const pending = t.inner.hire();
    t.dlg.open('floor', 0);
    await tick();
    // The desk is held by the hire: this dialog says so and does not hire it again.
    expect(t.dlg.summary()?.blocker).toMatch(/Another hire is already on its way to Desk 1/);
    const d = t.inner.editor.draft;
    d.replace(d.doc.text.length, d.doc.text.length, ' plus an edit');
    await tick();
    expect(t.hires[0]!.args.prompt).toBe('as reviewed');
    t.hires[0]!.answer({ ok: true, data: { id: 'w1', prompted: true } });
    await pending;
    expect(t.inner.editor.draft.doc.text).toBe('as reviewed plus an edit');
    expect(localStorage.getItem(key(0))).toContain('plus an edit');
    expect(t.toasts.map((x) => x.text)).toEqual(['Agent spawned successfully.']);
  });

  it('prompted:false keeps the task for a prompt by hand and says the task was not delivered; no beep', async () => {
    const t = setup();
    await typed(t, 0, 'deliver me');
    const pending = t.inner.hire();
    await tick();
    t.hires[0]!.answer({ ok: true, data: { id: 'w1', prompted: false, prompt_error: 'agent busy' } });
    await pending;
    expect(t.toasts).toHaveLength(1);
    expect(t.toasts[0]).toMatchObject({ kind: 'error', text: expect.stringContaining('The first task was not sent (agent busy)') });
    expect(t.beeps()).toBe(0);
    expect(t.hires).toHaveLength(1);
    expect(localStorage.getItem(key(0))).toContain('deliver me');
  });

  it('a dropped connection: an unknown outcome, the task kept, no second worker.hire', async () => {
    const t = setup();
    await typed(t, 0, 'maybe');
    const pending = t.inner.hire();
    await tick();
    t.hires[0]!.answer({ ok: false, code: 'disconnected', message: 'dropped' });
    await pending;
    expect(t.toasts).toEqual([{ kind: 'warn', text: expect.stringContaining('It may still have gone through') }]);
    expect(t.hires).toHaveLength(1);
    expect(t.holds.size).toBe(0);
    expect(localStorage.getItem(key(0))).toContain('maybe');
  });

  it('off (the default): the dialog waits for the ack as before and closes itself; the go-to fires', async () => {
    const t = setup();
    t.prefs.hireInBackground = false;
    await typed(t, 0, 'wait for it');
    const pending = t.inner.hire();
    await tick();
    expect(t.dlg.isOpen).toBe(true);
    expect(t.dlg.summary()?.state).toBe('hiring');
    t.hires[0]!.answer({ ok: true, data: { id: 'w1', prompted: true } });
    await pending;
    expect(t.dlg.isOpen).toBe(false);
    expect(t.goTos).toEqual(['w1']);
    expect(t.toasts).toHaveLength(1);
    expect(t.toasts[0]!.text).toMatch(/Here they come\.$/);
    expect(t.beeps()).toBe(0);
  });
});
