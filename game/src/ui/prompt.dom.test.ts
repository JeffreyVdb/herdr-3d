// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PromptHost, PromptOverlay } from './prompt';

// #64: the P overlay's sends. A send that outlives its overlay leaves the overlay on screen alone; a file the note
// refused holds the send until the user dismisses the refusal.

interface Req {
  cmd: string;
  args: { id: string; text: string };
  ack(r: unknown): void;
}

function setup() {
  document.body.replaceChildren();
  const requests: Req[] = [];
  const toasts: Array<[string, string]> = [];
  const view = (id: string) => ({ name: id, desk: 0, harness: 'claude', display: 'idle', worker: { id, session: 's', agent_kind: 'claude', status: 'idle' } });
  const host = {
    store: { workerView: view, floorView: () => ({ asleep: false }), workers: new Map([['A', {}], ['B', {}]]) },
    unsupported: () => false,
    toast: (m: string, k: string) => toasts.push([m, k]),
    upload: () => Promise.resolve({ ok: true, data: { path: '/drops/image.png' } }),
    send: (cmd: string, args: Req['args']) => new Promise((resolve) => requests.push({ cmd, args, ack: resolve })),
  } as unknown as PromptHost;
  const overlay = new PromptOverlay(document.body, host);
  const inner = overlay as unknown as { composer: ReturnType<typeof Object>; send(): Promise<void> };
  const composer = inner.composer as unknown as {
    insertText(t: string): void;
    insertFiles(f: File[]): { errors: string[] };
    editor: HTMLElement;
    getDraft(): { refusal: string | null };
  };
  const flush = async () => {
    for (let n = 0; n < 10; n++) await Promise.resolve();
  };
  return { overlay, requests, toasts, composer, flush, send: () => inner.send() };
}

describe('PromptOverlay', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} }));
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('a stale ack leaves the newer send of the reopened overlay alone (no second send of its prompt)', async () => {
    const e = setup();
    e.overlay.open('A');
    e.composer.insertText('first');
    const a = e.send();
    await e.flush();
    e.overlay.close();
    e.overlay.open('B');
    e.composer.insertText('second');
    void e.send();
    await e.flush();
    expect(e.overlay.summary()?.state).toBe('sending');
    expect(e.requests).toHaveLength(2);

    e.requests[0]!.ack({ ok: true, data: {} });
    await a;
    // A's answer is a toast; B's send is still in flight: the state, the busy composer and the guard are B's.
    expect(e.toasts).toEqual([['Sent: A is on it.', 'info']]);
    expect(e.overlay.summary()?.state).toBe('sending');
    e.overlay.refresh();
    expect(e.composer.editor.getAttribute('contenteditable')).toBe('false');
    void e.send();
    await e.flush();
    expect(e.requests.map((r) => r.args)).toEqual([
      { id: 'A', text: 'first' },
      { id: 'B', text: 'second' },
    ]);

    e.requests[1]!.ack({ ok: true, data: {} });
    await e.flush();
    expect(e.overlay.summary()?.state).toBe('sent');
  });

  it('a stale refusal of the send (the bridge says no) also leaves the current overlay alone', async () => {
    const e = setup();
    e.overlay.open('A');
    e.composer.insertText('first');
    const a = e.send();
    await e.flush();
    e.overlay.close();
    e.overlay.open('B');
    e.composer.insertText('second');
    void e.send();
    await e.flush();
    e.requests[0]!.ack({ ok: false, code: 'internal', message: 'boom' });
    await a;
    expect(e.toasts.at(-1)?.[1]).toBe('error');
    expect(e.overlay.summary()?.state).toBe('sending');
    expect(e.composer.editor.getAttribute('contenteditable')).toBe('false');
  });

  it('a file the note refused holds the send, with the text kept, until the refusal is dismissed', async () => {
    const e = setup();
    e.overlay.open('A');
    e.composer.insertText('look at this');
    const r = e.composer.insertFiles([new File(['bad'], 'doc.pdf', { type: 'application/pdf' })]);
    expect(r.errors).toHaveLength(1);
    await e.send();
    await e.flush();
    expect(e.requests).toHaveLength(0);
    const s = e.overlay.summary()!;
    expect(s.state).toBe('ready');
    expect(s.error).toBe(true);
    expect(s.status).toMatch(/^Nothing was sent: doc\.pdf is not a PNG/);
    expect(s.text).toBe('look at this');
    expect(document.querySelector('.cmp-refusal')?.hasAttribute('hidden')).toBe(false);

    document.querySelector<HTMLButtonElement>('.cmp-dismiss')!.click();
    void e.send();
    await e.flush();
    expect(e.requests.map((q) => q.args)).toEqual([{ id: 'A', text: 'look at this' }]);
  });

  it('the refusal belongs to the worker’s note: it is still held after the overlay is closed and reopened', async () => {
    const e = setup();
    e.overlay.open('A');
    e.composer.insertText('x');
    e.composer.insertFiles([new File(['bad'], 'doc.pdf', { type: 'application/pdf' })]);
    e.overlay.close();
    e.overlay.open('A');
    expect(document.querySelector('.cmp-refusal')?.hasAttribute('hidden')).toBe(false);
    await e.send();
    expect(e.requests).toHaveLength(0);
  });
});
