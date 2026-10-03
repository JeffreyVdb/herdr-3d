// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  const host = {
    store: { hireOptions: { codex: { models: ['gpt'], efforts: ['high'] } }, floorView: () => ({ seats: Array(10).fill(null) }), limits: { version: 0, list: () => [] }, workerView: () => null },
    send: async (t: string) => (t === 'hire.prepare' ? { ok: true, data: prep } : await new Promise((r) => (ack = r))),
    unsupported: () => false,
    reserve: (_s: string, d: number) => {
      holds.add(d);
      return () => holds.delete(d);
    },
    held: () => holds,
    toast: (m: string) => void toasts.push(m),
    goTo: (id: string) => void goTos.push(id),
    now: () => Date.now(),
    upload: () => new Promise((r) => (finishUpload = r)),
  } as unknown as HireHost;
  const dlg = new HireDialog(document.body, host);
  return { dlg, goTos, toasts, inner: dlg as unknown as Inner, ack: (r: unknown) => ack(r), finishUpload: (r: unknown) => finishUpload(r) };
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
