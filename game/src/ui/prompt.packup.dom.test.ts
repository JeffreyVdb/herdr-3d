// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PackupOutcome } from '../world/packup';
import { type PromptHost, PromptOverlay } from './prompt';

// #110: the P overlay's send through the pack-up check: "checking…" with the note kept, no second send meanwhile,
// Esc cancels it (nothing sent, the overlay stays), and each outcome does what it says.

function setup(gate: ((id: string, text: string, signal: AbortSignal) => Promise<PackupOutcome> | null) | undefined) {
  document.body.replaceChildren();
  const sent: Array<{ cmd: string; args: unknown }> = [];
  const view = (id: string) => ({ name: id, desk: 0, harness: 'claude', display: 'idle', worker: { id, session: 's', agent_kind: 'claude', status: 'idle' } });
  const host = {
    store: { floorName: (id: string) => id, workerView: view, floorView: () => ({ asleep: false }), workers: new Map([['A', {}]]) },
    unsupported: () => false,
    toast: () => {},
    upload: () => Promise.resolve({ ok: true, data: { path: '/drops/image.png' } }),
    send: (cmd: string, args: unknown) => {
      sent.push({ cmd, args });
      return Promise.resolve({ ok: true, data: {} });
    },
    ...(gate ? { packup: gate } : {}),
  } as unknown as PromptHost;
  const overlay = new PromptOverlay(document.body, host);
  const inner = overlay as unknown as { composer: { insertText(t: string): void }; send(): Promise<void>; dialog: HTMLDialogElement };
  const flush = async () => {
    for (let n = 0; n < 10; n++) await Promise.resolve();
  };
  overlay.open('A');
  inner.composer.insertText('Please make a PR and end your turn');
  return { overlay, sent, flush, send: () => inner.send(), dialog: inner.dialog };
}

/** A gate that answers when told to, and records what it was asked. */
function heldGate() {
  const calls: Array<{ id: string; text: string; signal: AbortSignal; answer(o: PackupOutcome): void }> = [];
  const gate = (id: string, text: string, signal: AbortSignal) => new Promise<PackupOutcome>((answer) => calls.push({ id, text, signal, answer }));
  return { gate, calls };
}

describe('PromptOverlay and pack up on request (#110)', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  });
  afterEach(() => document.body.replaceChildren());

  it('checks first: "checking…", the note kept, a second Enter sends nothing; "send" sends it as written', async () => {
    const g = heldGate();
    const e = setup(g.gate);
    void e.send();
    await e.flush();
    expect(g.calls.map((c) => [c.id, c.text])).toEqual([['A', 'Please make a PR and end your turn']]);
    const s = e.overlay.summary()!;
    expect(s.state).toBe('checking');
    expect(s.status).toBe('Checking the prompt…');
    expect(s.text).toBe('Please make a PR and end your turn');
    expect(document.querySelector('[data-key="send"]')!.textContent).toBe('Checking…');
    void e.send();
    await e.flush();
    expect(g.calls).toHaveLength(1);
    expect(e.sent).toEqual([]);
    g.calls[0]!.answer('send');
    await e.flush();
    expect(e.sent).toEqual([{ cmd: 'worker.prompt', args: { id: 'A', text: 'Please make a PR and end your turn' } }]);
    expect(e.overlay.summary()!.state).toBe('sent');
  });

  it('Esc while checking sends nothing and keeps the overlay and the note', async () => {
    const g = heldGate();
    const e = setup(g.gate);
    void e.send();
    await e.flush();
    const esc = new Event('cancel', { cancelable: true });
    e.dialog.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(g.calls[0]!.signal.aborted).toBe(true);
    g.calls[0]!.answer('send');
    await e.flush();
    expect(e.sent).toEqual([]);
    const s = e.overlay.summary()!;
    expect(s.state).toBe('ready');
    expect(s.text).toBe('Please make a PR and end your turn');
    expect(s.status).toBe('Not sent: the prompt is still here.');
  });

  it('closing while checking sends nothing', async () => {
    const g = heldGate();
    const e = setup(g.gate);
    void e.send();
    await e.flush();
    e.overlay.close();
    expect(g.calls[0]!.signal.aborted).toBe(true);
    g.calls[0]!.answer('send');
    await e.flush();
    expect(e.sent).toEqual([]);
  });

  it('done: the task went as a wrap-up, the note is cleared; cancel: nothing sent, the note stays', async () => {
    const g = heldGate();
    const e = setup(g.gate);
    void e.send();
    await e.flush();
    g.calls[0]!.answer('done');
    await e.flush();
    expect(e.sent).toEqual([]);
    expect(e.overlay.summary()!.state).toBe('sent');
    expect(e.overlay.summary()!.text).toBe('');
    expect(e.overlay.summary()!.status).toContain('goes home once it reports CLEAN');

    const h = heldGate();
    const f = setup(h.gate);
    void f.send();
    await f.flush();
    h.calls[0]!.answer('cancel');
    await f.flush();
    expect(f.sent).toEqual([]);
    expect(f.overlay.summary()!.state).toBe('ready');
    expect(f.overlay.summary()!.text).toBe('Please make a PR and end your turn');
  });

  it('no check (the feature off): it sends at once, never "checking"', async () => {
    const e = setup(() => null);
    void e.send();
    await e.flush();
    expect(e.sent).toEqual([{ cmd: 'worker.prompt', args: { id: 'A', text: 'Please make a PR and end your turn' } }]);
  });
});
