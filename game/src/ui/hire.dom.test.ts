// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../net/client';
import type { HireGit } from '../net/protocol';
import { FETCH_ORDERINGS, fetchedGit, ORIGIN_GIT, previewGit } from '../test/fetchOrderings';
import type { Draft as PromptDraft } from './composer/draft';
import { HireDialog, type HireHost } from './hire';

// #51: an acknowledged hire clears what it sent, never a newer draft that took the same desk meanwhile.

const prep = {
  cwd: '/home/test',
  label: 'default',
  git: null,
  choice: { harness: 'codex', model: 'gpt', effort: 'high' },
  choice_source: 'floor_default',
  capacity: { floor: { count: 0, soft: 10, hard: 20 }, host: { count: 0, soft: 10, hard: 20 } },
};

const tick = () => new Promise((r) => setTimeout(r, 0));
const KEY = 'h3d.draft.hire.floor:0';

/** What the test reaches into the dialog for. */
interface Inner {
  editor: { draft: PromptDraft };
  hire(): Promise<void>;
}

function setup() {
  let ack!: (r: unknown) => void;
  let finishUpload!: (r: unknown) => void;
  const holds = new Set<number>();
  const goTos: string[] = [];
  const toasts: string[] = [];
  const kinds: string[] = [];
  const host = {
    store: { floorName: (id: string) => id, hireOptions: { codex: { models: ['gpt'], efforts: ['high'] } }, floorView: () => ({ seats: Array(10).fill(null) }), limits: { version: 0, list: () => [] }, workerView: () => null },
    send: async (t: string) => (t === 'hire.prepare' ? { ok: true, data: prep } : await new Promise((r) => (ack = r))),
    unsupported: () => false,
    reserve: (_s: string, d: number) => {
      holds.add(d);
      return () => holds.delete(d);
    },
    held: () => holds,
    toast: (m: string, kind: string) => {
      toasts.push(m);
      kinds.push(kind);
    },
    goTo: (id: string) => void goTos.push(id),
    now: () => Date.now(),
    upload: () => new Promise((r) => (finishUpload = r)),
  } as unknown as HireHost;
  const dlg = new HireDialog(document.body, host);
  return { dlg, host, goTos, toasts, kinds, inner: dlg as unknown as Inner, ack: (r: unknown) => ack(r), finishUpload: (r: unknown) => finishUpload(r) };
}

describe('HireDialog: clearing after an acknowledged hire', () => {
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

  it.each([true, false])('requests a local preview only when the bridge supports it (%s)', async (supported) => {
    const { dlg, host } = setup();
    host.store.preparePreview = supported;
    const send = vi.spyOn(host, 'send');
    dlg.open('floor', 0);
    // The wait names origin only where the bridge fetches it.
    expect(dlg.summary()?.status).toBe(supported ? 'Checking the floor and the folder…' : 'Checking the floor, the folder and origin…');
    await tick();
    expect(send).toHaveBeenCalledWith('hire.prepare', { floor: 'floor', ...(supported ? { preview: true } : {}) });
    expect(dlg.summary()?.state).toBe('ready');
    dlg.close();
  });

  it('still checks a failed fetch and lets Fetch again retry origin after opening a preview', async () => {
    const { dlg, host, inner } = setup();
    host.store.preparePreview = true;
    const git = { repo_root: '/home/test', default_branch: 'main', base_sha: '1234567', base_time: 1, fetched: false };
    const send = vi.spyOn(host, 'send')
      .mockResolvedValueOnce({ ok: true, data: { ...prep, git: { ...git, preview: true } } })
      .mockResolvedValueOnce({ ok: false, code: 'fetch_failed', message: 'offline' })
      .mockResolvedValueOnce({ ok: true, data: { ...prep, git: { ...git, fetch_error: 'offline' } } })
      .mockResolvedValueOnce({ ok: true, data: { ...prep, git: { ...git, fetched: true } } });
    dlg.open('floor', 0);
    await tick();
    expect(dlg.summary()?.form.worktree).toBe(true);
    await inner.hire();
    await tick();
    expect(dlg.summary()?.form.worktree).toBe(false);
    document.querySelector<HTMLButtonElement>('[data-key="refetch"]')!.click();
    await tick();
    expect(send.mock.calls.filter(([t]) => t === 'hire.prepare').map(([, a]) => a)).toEqual([
      { floor: 'floor', preview: true },
      { floor: 'floor', cwd: '/home/test' },
      { floor: 'floor', cwd: '/home/test' },
    ]);
    expect(dlg.summary()?.form.worktree).toBe(true);
    dlg.close();
  });

  it('#134 R1: a recheck still on its way when a folder of the same repository is previewed: its failure is shown', async () => {
    const { dlg, host, inner } = setup();
    host.store.preparePreview = true;
    const git = { repo_root: '/home/test', default_branch: 'main', base_sha: '1234567', base_time: 1, fetched: false };
    let finishRecheck!: (r: CommandResult) => void;
    const send = vi.spyOn(host, 'send')
      .mockResolvedValueOnce({ ok: true, data: { ...prep, git: { ...git, preview: true } } })
      .mockResolvedValueOnce({ ok: false, code: 'fetch_failed', message: 'offline' })
      .mockImplementationOnce(() => new Promise((resolve) => { finishRecheck = resolve; }))
      .mockResolvedValueOnce({ ok: true, data: { ...prep, cwd: '/home/test/subdir', git: { ...git, preview: true } } });
    dlg.open('floor', 0);
    await tick();
    await inner.hire();
    await tick();
    const folder = document.querySelector<HTMLInputElement>('#hire-cwd')!;
    expect(folder.disabled).toBe(false);
    folder.value = '/home/test/subdir';
    folder.dispatchEvent(new Event('input'));
    folder.dispatchEvent(new Event('change'));
    await tick();
    finishRecheck({ ok: true, data: { ...prep, git: { ...git, fetch_error: 'offline' } } });
    await tick();
    expect(send.mock.calls.filter(([t]) => t === 'hire.prepare').map(([, a]) => a)).toEqual([
      { floor: 'floor', preview: true },
      { floor: 'floor', cwd: '/home/test' },
      { floor: 'floor', cwd: '/home/test/subdir', preview: true },
    ]);
    expect(dlg.summary()?.form.worktree).toBe(false);
    expect(document.querySelector('[data-key="refetch"]')).not.toBeNull();
    dlg.close();
  });

  it.each(FETCH_ORDERINGS)('#134 R1: $name: the worktree offered is $usable, and Fetch again fetches the folder', async (c) => {
    const { dlg, host, inner } = setup();
    host.store.preparePreview = true;
    const prepares: Array<{ args: unknown; answer: (r: CommandResult) => void }> = [];
    vi.spyOn(host, 'send').mockImplementation((t: string, args: unknown) => {
      if (t === 'worker.hire') return Promise.resolve({ ok: false, code: 'fetch_failed', message: 'offline' });
      return new Promise<CommandResult>((answer) => prepares.push({ args, answer }));
    });
    const answer = (git: HireGit, cwd = '/home/test') => ({ ok: true, data: { ...prep, cwd, git } }) as CommandResult;
    dlg.open('floor', 0);
    prepares.shift()!.answer(answer({ ...ORIGIN_GIT, preview: true }));
    await tick();
    await inner.hire();
    await tick();
    const recheck = prepares.shift()!;
    expect(recheck.args).toEqual({ floor: 'floor', cwd: '/home/test' });
    if (c.before) {
      recheck.answer(answer(fetchedGit(c.origin)));
      await tick();
    }
    const folder = document.querySelector<HTMLInputElement>('#hire-cwd')!;
    folder.value = c.folder;
    folder.dispatchEvent(new Event('input'));
    folder.dispatchEvent(new Event('change'));
    const preview = prepares.shift()!;
    expect(preview.args).toEqual({ floor: 'floor', cwd: c.folder, preview: true });
    for (const step of c.order) {
      if (step === 'recheck') recheck.answer(answer(fetchedGit(c.origin)));
      else preview.answer(answer(previewGit(c.folder), c.folder));
      await tick();
    }
    const s = dlg.summary()!;
    expect(s.form).toMatchObject({ cwd: c.folder, worktree: c.usable });
    expect(s.git).toMatchObject({ usable: c.usable, note: c.usable ? null : expect.stringContaining('git fetch origin failed: offline') });
    const again = document.querySelector<HTMLButtonElement>('[data-key="refetch"]');
    expect(!!again).toBe(!c.usable);
    if (again) {
      // Fetch again fetches the folder now in the form (never a preview), and origin is back: the worktree is offered again.
      again.click();
      const fetch = prepares.shift()!;
      expect(fetch.args).toEqual({ floor: 'floor', cwd: c.folder });
      fetch.answer(answer({ ...ORIGIN_GIT, fetched: true }, c.folder));
      await tick();
      expect(dlg.summary()?.form.worktree).toBe(true);
      expect(dlg.summary()?.git).toMatchObject({ usable: true, note: null });
      expect(document.querySelector('[data-key="refetch"]')).toBeNull();
    }
    expect(prepares).toEqual([]);
    dlg.close();
  });

  it('#134 R1: an older recheck answering after a newer one (two refused hires) is dropped', async () => {
    const { dlg, host, inner } = setup();
    host.store.preparePreview = true;
    const prepares: Array<(r: CommandResult) => void> = [];
    vi.spyOn(host, 'send').mockImplementation((t: string) => {
      if (t === 'worker.hire') return Promise.resolve({ ok: false, code: 'fetch_failed', message: 'offline' });
      return new Promise<CommandResult>((answer) => prepares.push(answer));
    });
    const answer = (git: HireGit) => ({ ok: true, data: { ...prep, git } }) as CommandResult;
    dlg.open('floor', 0);
    prepares.shift()!(answer({ ...ORIGIN_GIT, preview: true }));
    await tick();
    await inner.hire();
    await tick();
    await inner.hire();
    await tick();
    const [first, second] = prepares.splice(0);
    second!(answer(fetchedGit('up')));
    await tick();
    first!(answer(fetchedGit('down')));
    await tick();
    expect(dlg.summary()?.git).toMatchObject({ usable: true, note: null });
    expect(dlg.summary()?.form.worktree).toBe(true);
    dlg.close();
  });

  it('keeps a newer draft of the same desk: memory and storage (Esc during an upload, reopen with a first task, edit, then the old hire acks)', async () => {
    const { dlg, inner, ack, finishUpload } = setup();
    dlg.open('floor', 0);
    await tick();
    inner.editor.draft.replace(0, 0, 'old sent prompt');
    inner.editor.draft.addImages([new File([new Uint8Array([1, 2])], 'screenshot.png', { type: 'image/png' })]);
    const pending = inner.hire();
    await tick();
    dlg.close();
    dlg.open('floor', 0, { prompt: 'new prefill' });
    await tick();
    const end = inner.editor.draft.doc.text.length;
    inner.editor.draft.replace(end, end, ' edited');
    expect(localStorage.getItem(KEY)).toContain('new prefill edited');
    finishUpload({ ok: true, data: { path: '/tmp/img.png' } });
    await tick();
    ack({ ok: true, data: { id: 'worker', prompted: true } });
    await pending;
    expect(inner.editor.draft.doc.text).toBe('new prefill edited');
    expect(localStorage.getItem(KEY)).toContain('new prefill edited');
  });

  it('still clears the sent text (memory and storage) when nothing else took the desk', async () => {
    const { dlg, inner, ack } = setup();
    dlg.open('floor', 0);
    await tick();
    inner.editor.draft.replace(0, 0, 'ship it');
    expect(localStorage.getItem(KEY)).toContain('ship it');
    const pending = inner.hire();
    await tick();
    ack({ ok: true, data: { id: 'worker', prompted: true } });
    await pending;
    expect(localStorage.getItem(KEY)).toBeNull();
    dlg.open('floor', 0);
    expect(inner.editor.draft.doc.text).toBe('');
  });
  it('keeps a prefilled first task saved by a label typed before its first edit', async () => {
    const { dlg, inner, ack } = setup();
    dlg.open('floor', 0);
    await tick();
    inner.editor.draft.replace(0, 0, 'old sent prompt');
    const pending = inner.hire();
    await tick();
    dlg.close();
    dlg.open('floor', 0, { prompt: 'new prefill' });
    await tick();
    const label = document.querySelector<HTMLInputElement>('#hire-label')!;
    label.value = 'Nibble';
    label.dispatchEvent(new Event('input'));
    expect(localStorage.getItem(KEY)).toContain('new prefill');
    ack({ ok: true, data: { id: 'worker', prompted: true } });
    await pending;
    expect(localStorage.getItem(KEY)).toContain('new prefill');
  });

  it('keeps a prefilled first task with the very same text, saved only by its label (memory and storage)', async () => {
    const { dlg, inner, ack, finishUpload } = setup();
    dlg.open('floor', 0);
    await tick();
    inner.editor.draft.replace(0, 0, 'old sent prompt');
    inner.editor.draft.addImages([new File([new Uint8Array([1, 2])], 'screenshot.png', { type: 'image/png' })]);
    const pending = inner.hire();
    await tick();
    dlg.close();
    dlg.open('floor', 0, { prompt: 'old sent prompt' });
    await tick();
    const label = document.querySelector<HTMLInputElement>('#hire-label')!;
    label.value = 'Nibble';
    label.dispatchEvent(new Event('input'));
    finishUpload({ ok: true, data: { path: '/tmp/img.png' } });
    await tick();
    ack({ ok: true, data: { id: 'worker', prompted: true } });
    await pending;
    expect(inner.editor.draft.doc.text).toBe('old sent prompt');
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ text: 'old sent prompt', fields: { label: 'Nibble' } });
    dlg.close();
    dlg.open('floor', 0);
    expect(inner.editor.draft.doc.text).toBe('old sent prompt');
  });
});

describe('HireDialog: going to the new hire (#116)', () => {
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

  it('calls the hook once, with the ack’s id, when the dialog is still the one that sent the hire', async () => {
    const { dlg, inner, ack, goTos, toasts } = setup();
    dlg.open('floor', 0);
    await tick();
    const pending = inner.hire();
    await tick();
    ack({ ok: true, data: { id: 'new-worker', prompted: true } });
    await pending;
    expect(goTos).toEqual(['new-worker']);
    expect(toasts.some((t) => t.includes('Here they come.'))).toBe(true);
  });

  it('also calls it when the first task was not sent (prompted: false), the error toast kept', async () => {
    const { dlg, inner, ack, goTos, toasts } = setup();
    dlg.open('floor', 0);
    await tick();
    const pending = inner.hire();
    await tick();
    ack({ ok: true, data: { id: 'new-worker', prompted: false, prompt_error: 'no luck' } });
    await pending;
    expect(goTos).toEqual(['new-worker']);
    expect(toasts.some((t) => t.includes('The first task was not sent (no luck)'))).toBe(true);
  });

  it('does not call it for a late ack: the dialog was Esc’d (or reopened for another desk) meanwhile, only the toast', async () => {
    for (const reopen of [false, true]) {
      const { dlg, inner, ack, goTos, toasts } = setup();
      dlg.open('floor', 0);
      await tick();
      const pending = inner.hire();
      await tick();
      dlg.close();
      if (reopen) {
        dlg.open('floor', 1);
        await tick();
      }
      ack({ ok: true, data: { id: 'new-worker', prompted: true } });
      await pending;
      expect(goTos).toEqual([]);
      expect(toasts.some((t) => t.includes('Here they come.'))).toBe(true);
      dlg.close();
    }
  });

  // #186: hired, but on Codex's built-in server instead of its own: a warning, not a failed hire; a task not sent stays an error.
  it('a Codex fallback is a warning toast; a first task not sent beside it is still an error', async () => {
    const codex = { mode: 'legacy', note: 'shared Codex server: unsupported Codex version: "codex-cli 0.163.0" (supported: codex-cli 0.160.x, 0.161.x or 0.162.x); started the usual way' };
    for (const [data, kind] of [
      [{ id: 'new-worker', prompted: true }, 'info'],
      [{ id: 'new-worker', prompted: true, codex }, 'warn'],
      [{ id: 'new-worker', prompted: false, prompt_error: 'no luck', codex }, 'error'],
    ] as const) {
      const { dlg, inner, ack, toasts, kinds } = setup();
      dlg.open('floor', 0);
      await tick();
      const pending = inner.hire();
      await tick();
      ack({ ok: true, data });
      await pending;
      expect(kinds).toEqual([kind]);
      expect(toasts[0]?.includes('Codex 0.163.0')).toBe('codex' in data);
      dlg.close();
      document.body.replaceChildren();
    }
  });

  it('does not call it when the hire failed', async () => {
    const { dlg, inner, ack, goTos } = setup();
    dlg.open('floor', 0);
    await tick();
    const pending = inner.hire();
    await tick();
    ack({ ok: false, code: 'hire_failed', message: 'herdr said no' });
    await pending;
    expect(goTos).toEqual([]);
  });

  it('does not call it for an ack without an id', async () => {
    const { dlg, inner, ack, goTos } = setup();
    dlg.open('floor', 0);
    await tick();
    const pending = inner.hire();
    await tick();
    ack({ ok: true, data: {} });
    await pending;
    expect(goTos).toEqual([]);
  });
});
