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
  const handed: Array<{ id: string; text: string; from: unknown }> = [];
  const mcp: Array<{ floor: string; cwd: string; profile: string }> = [];
  let beeps = 0;
  const prefs = new HirePrefs(null);
  prefs.hireInBackground = true;
  const host = {
    store: { floorName: (id: string) => id, hireOptions: { codex: { models: ['gpt'], efforts: ['high'] } }, floorView: () => ({ seats: Array(10).fill(null) }), limits: { version: 0, list: () => [] }, workerView: () => null },
    send: (t: string, args: Record<string, unknown>) => (t === 'hire.prepare' ? Promise.resolve({ ok: true, data: prep }) : new Promise((answer) => hires.push({ args, answer }))),
    unsupported: () => false,
    reserve: (_s: string, d: number) => {
      holds.add(d);
      return () => holds.delete(d);
    },
    held: () => holds,
    toast: (text: string, kind: string) => void toasts.push({ text, kind }),
    goTo: (id: string) => void goTos.push(id),
    mcpDetails: (floor: string, cwd: string, profile: string) => void mcp.push({ floor, cwd, profile }),
    beep: () => void beeps++,
    hirePrefs: prefs,
    now: () => Date.now(),
    upload: (...a: unknown[]) => upload(...a),
    holdTask: (id: string, text: string, from: unknown) => {
      handed.push({ id, text, from });
      return true;
    },
  } as unknown as HireHost;
  let upload: (...a: unknown[]) => Promise<CommandResult> = () => new Promise(() => {});
  const dlg = new HireDialog(document.body, host);
  const uploads = (fn: typeof upload) => void (upload = fn);
  return { dlg, inner: dlg as unknown as Inner, prefs, hires, holds, goTos, toasts, handed, mcp, uploads, beeps: () => beeps };
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

  it('returns a refused background hire to its editable form with the entire prompt and images', async () => {
    const t = setup();
    t.uploads(async () => ({ ok: true, data: { path: '/drops/task.png' } }));
    await typed(t, 8, 'The task I spent time writing ');
    t.inner.editor.draft.addImages([new File([new Uint8Array([1, 2])], 'task.png', { type: 'image/png' })]);
    const doc = t.inner.editor.draft;
    const label = document.querySelector<HTMLInputElement>('#hire-label')!;
    label.value = 'Keep me';
    label.dispatchEvent(new Event('input'));
    const pending = t.inner.hire();
    await tick();
    t.hires[0]!.answer({ ok: false, code: 'desk_taken', message: 'desk 8 is not on the floor (0-7)' });
    await pending;
    expect(t.dlg.isOpen).toBe(true);
    expect(t.dlg.summary()).toMatchObject({ state: 'ready', error: true, form: { label: 'Keep me' } });
    expect(t.inner.editor.draft).toBe(doc);
    expect(t.inner.editor.draft.doc.text).toContain('The task I spent time writing');
    expect(t.dlg.summary()!.images).toMatchObject([{ name: 'task.png', path: '/drops/task.png' }]);
    expect(localStorage.getItem(key(8))).toContain('The task I spent time writing');
    expect(t.holds.size).toBe(0);
    expect(t.hires).toHaveLength(1);
    expect(t.goTos).toEqual([]);
    expect(t.beeps()).toBe(0);
  });

  it('does not resurrect an older failed hire after a newer dialog was opened and closed', async () => {
    const t = setup();
    await typed(t, 0, 'first task');
    const pending = t.inner.hire();
    await tick();
    await typed(t, 1, 'newer task');
    t.dlg.close();
    t.hires[0]!.answer({ ok: false, code: 'hire_failed', message: 'could not start' });
    await pending;
    expect(t.dlg.isOpen).toBe(false);
    expect(localStorage.getItem(key(0))).toContain('first task');
    expect(localStorage.getItem(key(1))).toContain('newer task');
  });

  it('keeps a failed hire saved without opening over another modal', async () => {
    const t = setup();
    await typed(t, 0, 'keep this task');
    const pending = t.inner.hire();
    await tick();
    const other = document.createElement('dialog');
    document.body.append(other);
    other.showModal();
    t.hires[0]!.answer({ ok: false, code: 'hire_failed', message: 'could not start' });
    await pending;
    expect(t.dlg.isOpen).toBe(false);
    expect(other.open).toBe(true);
    expect(localStorage.getItem(key(0))).toContain('keep this task');
    other.close();
    t.dlg.open('floor', 0);
    expect(t.inner.editor.draft.doc.text).toBe('keep this task');
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

  it('prompted:false hands the task to the new worker’s prompt (P), says so, and keeps the draft; no beep', async () => {
    const t = setup();
    await typed(t, 0, 'deliver me');
    const pending = t.inner.hire();
    await tick();
    t.hires[0]!.answer({ ok: true, data: { id: 'w1', prompted: false, prompt_error: 'agent busy' } });
    await pending;
    expect(t.handed).toEqual([{ id: 'w1', text: 'deliver me', from: t.inner.editor.draft }]);
    expect(t.toasts).toHaveLength(1);
    expect(t.toasts[0]).toMatchObject({ kind: 'error', text: expect.stringMatching(/The first task was not sent \(agent busy\): prompt them yourself \(P\); the task is in their prompt\.$/) });
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

  it('off: the images go up before the desk is held, as before; Esc while they upload leaves the desk free', async () => {
    const t = setup();
    t.prefs.hireInBackground = false;
    let finish!: (r: CommandResult) => void;
    t.uploads(() => new Promise((r) => (finish = r)));
    await typed(t, 0, 'see ');
    t.inner.editor.draft.addImages([new File([new Uint8Array([137, 80, 78, 71])], 'grill.png', { type: 'image/png' })]);
    const pending = t.inner.hire();
    await tick();
    expect(t.dlg.summary()).toMatchObject({ state: 'hiring', status: expect.stringMatching(/^Uploading the image/) });
    expect(t.holds.has(0)).toBe(false);
    t.dlg.close();
    expect(t.holds.has(0)).toBe(false);
    expect(t.hires).toHaveLength(0);
    finish({ ok: true, data: { path: '/drops/grill.png' } });
    await tick();
    await tick();
    // Up: now the desk is held for worker.hire, and it goes.
    expect(t.holds.has(0)).toBe(true);
    expect(t.hires).toHaveLength(1);
    expect(t.hires[0]!.args.prompt).toBe('see [Image #1: /drops/grill.png]');
    t.hires[0]!.answer({ ok: true, data: { id: 'w1', prompted: true } });
    await pending;
    expect(t.holds.has(0)).toBe(false);
  });

  it('off: prompted:false is the dialog’s as before (no hand-over to the prompt)', async () => {
    const t = setup();
    t.prefs.hireInBackground = false;
    await typed(t, 0, 'deliver me');
    const pending = t.inner.hire();
    await tick();
    t.hires[0]!.answer({ ok: true, data: { id: 'w1', prompted: false, prompt_error: 'agent busy' } });
    await pending;
    expect(t.handed).toEqual([]);
    expect(t.toasts).toEqual([{ kind: 'error', text: expect.stringMatching(/the text stays in this desk’s hire dialog\.$/) }]);
  });
  it('keeps named startup failure beside the task after close and permits exactly one settled retry', async () => {
    const t = setup();
    await typed(t, 0, 'Keep the entire task.');
    const pending = t.inner.hire();
    await tick();
    t.hires[0]!.answer({ ok: false, code: 'hire_failed', message: 'Codex did not become ready within 30 seconds.', data: { operation: 'op1', delivery: 'not_sent', retryable: true, startup: [{ name: 'code-intel', stage: 'failed', category: 'timeout', source: 'terminal' }] } });
    await pending;
    expect(document.querySelector('[data-hook="hire-recovery"]')?.textContent).toContain('code-intel timed out');
    expect(document.querySelector('[data-hook="hire-recovery"]')?.textContent).toContain('Your prompt has not been sent');
    const details = document.querySelector<HTMLDetailsElement>('[data-hook="hire-recovery"] details')!;
    details.open = true;
    document.querySelector<HTMLButtonElement>('[data-key="recovery-copy"]')!.focus();
    t.dlg.refresh();
    expect(document.activeElement?.getAttribute('data-key')).toBe('recovery-copy');
    expect(document.querySelector<HTMLDetailsElement>('[data-hook="hire-recovery"] details')!.open).toBe(true);
    t.dlg.close();
    expect(document.querySelector('.hire-recovery-tray')?.hasAttribute('hidden')).toBe(false);
    (document.querySelector('.hire-recovery-tray button') as HTMLButtonElement).click();
    await tick();
    expect(t.inner.editor.draft.doc.text).toBe('Keep the entire task.');
    expect(document.querySelector('[data-hook="hire-recovery"]')?.textContent).toContain('code-intel');
    const retry = t.inner.hire();
    const duplicate = t.inner.hire();
    await tick();
    expect(t.hires).toHaveLength(2);
    t.hires[1]!.answer({ ok: true, data: { id: 'w1', prompted: true, delivery: 'accepted' } });
    await Promise.all([retry, duplicate]);
    expect(localStorage.getItem(key(0))).toBeNull();
    expect(document.querySelector('.hire-recovery-tray')?.hasAttribute('hidden')).toBe(true);
  });

  it('persists the failed operation, hire options and uploaded image paths across reload', async () => {
    const t = setup();
    t.uploads(async () => ({ ok: true, data: { path: '/drops/kept.png' } }));
    await typed(t, 0, 'Examine this ');
    t.inner.editor.draft.addImages([new File([new Uint8Array([1])], 'kept.png', { type: 'image/png' })]);
    const label = document.querySelector<HTMLInputElement>('#hire-label')!;
    label.value = 'Remember'; label.dispatchEvent(new Event('input'));
    const pending = t.inner.hire(); await tick();
    t.hires[0]!.answer({ ok: false, code: 'hire_failed', message: 'Startup failed', data: { operation: 'op2', delivery: 'not_sent', retryable: true } });
    await pending;
    t.dlg.close(); document.body.replaceChildren();
    const reloaded = setup();
    (document.querySelector('.hire-recovery-tray button') as HTMLButtonElement).click();
    await tick();
    expect(reloaded.dlg.summary()?.form).toMatchObject({ label: 'Remember', harness: 'codex', model: 'gpt', effort: 'high', cwd: '/home/test' });
    expect(reloaded.inner.editor.draft.doc.text).toContain('/drops/kept.png');
    expect(document.querySelector('[data-hook="hire-recovery"]')?.textContent).toContain('Startup failed');
    const retry = reloaded.inner.hire(); await tick();
    expect(reloaded.hires[0]!.args.prompt).toContain('/drops/kept.png');
    reloaded.hires[0]!.answer({ ok: true, data: { id: 'w1', prompted: true } });
    await retry;
  });

  it('keeps recovery behind another modal and preserves newer edits when the old hire fails', async () => {
    const t = setup();
    await typed(t, 0, 'Original task');
    const pending = t.inner.hire(); await tick();
    await typed(t, 0, 'Newer edit: ');
    t.dlg.close();
    const other = document.createElement('dialog'); document.body.append(other); other.showModal();
    t.hires[0]!.answer({ ok: false, code: 'hire_failed', message: 'MCP failed', data: { operation: 'op3', delivery: 'not_sent', retryable: true } });
    await pending;
    expect(other.open).toBe(true);
    const recovery = document.querySelector('.hire-recovery-tray button') as HTMLButtonElement;
    recovery.click(); expect(t.dlg.isOpen).toBe(false);
    other.close(); recovery.click(); await tick();
    expect(t.inner.editor.draft.doc.text).toContain('Newer edit: ');
    expect(t.inner.editor.draft.doc.text).toContain('Original task');
  });

  it('keeps unknown delivery blocked after reload, without offering a duplicate hire', async () => {
    const t = setup(); await typed(t, 0, 'Maybe delivered');
    const pending = t.inner.hire(); await tick();
    t.hires[0]!.answer({ ok: false, code: 'disconnected', message: 'dropped' }); await pending;
    document.body.replaceChildren();
    const reloaded = setup(); reloaded.dlg.open('floor', 0); await tick();
    expect(reloaded.dlg.summary()?.blocker).toContain('Check the existing worker');
    await reloaded.inner.hire();
    expect(reloaded.hires).toHaveLength(0);
    expect(reloaded.inner.editor.draft.doc.text).toBe('Maybe delivered');
  });

  it('opens MCP details for the failed launch’s resolved profile and cwd, retaining the task', async () => {
    const t = setup(); await typed(t, 0, 'Keep this task');
    const pending = t.inner.hire(); await tick();
    t.hires[0]!.answer({ ok: false, code: 'hire_failed', message: 'Startup failed', data: { operation: 'op4', delivery: 'not_sent', retryable: true, cwd: '/failed/checkout', codex_profile: 'work' } });
    await pending;
    [...document.querySelectorAll<HTMLButtonElement>('[data-hook="hire-recovery"] button')].find((b) => b.textContent === 'MCP details')!.click();
    expect(t.mcp).toEqual([{ floor: 'floor', cwd: '/failed/checkout', profile: 'work' }]);
    expect(t.dlg.isOpen).toBe(false);
    t.dlg.open('floor', 0); await tick();
    expect(t.inner.editor.draft.doc.text).toBe('Keep this task');
  });

  it('blocks a recovered task with unuploaded images until the attachments are repaired', async () => {
    const t = setup(); await typed(t, 0, 'Check this image ');
    t.uploads(async (file) => (file as File).name === 'already.png' ? { ok: true, data: { path: '/drops/already.png' } } : await new Promise(() => {}));
    t.inner.editor.draft.addImages(['already.png', 'pending.png'].map((name) => new File([new Uint8Array([1])], name, { type: 'image/png' })));
    await tick(); await tick();
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(true);
    document.body.replaceChildren();
    const reloaded = setup(); reloaded.dlg.open('floor', 0); await tick();
    expect(reloaded.inner.editor.draft.doc.text).toContain('/drops/already.png');
    expect(reloaded.dlg.summary()?.blocker).toContain('images');
    await reloaded.inner.hire(); expect(reloaded.hires).toHaveLength(0);
    expect(document.querySelector('[data-hook="hire-recovery"]')?.textContent).toContain('Reattach the images');
  });

});
