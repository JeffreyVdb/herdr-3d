// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import type { PackupOutcome } from '../world/packup';
import { PromptSecretsBook } from '../world/promptSecrets';
import { type PromptHost, PromptOverlay } from './prompt';
import { PromptSecretsFlow } from './secretsFlow';
import type { SecretsReviewOutcome, SecretsReviewRequest } from './secretsReview';

// #108: the P overlay's send with "Review prompt secrets before sending": the scan first (before pack up's check), the
// review over the overlay, nothing sent before Confirm, a stale review reviewed again, the switch off as today.

const TEXT = 'Deploy with TOKEN=ghp_abc123 and pw=hunter2';
const at = (v: string) => ({ start: TEXT.indexOf(v), end: TEXT.indexOf(v) + v.length });
const SCAN = { revision: 'rev-1', candidates: [{ id: 'c1', ...at('ghp_abc123'), kinds: ['assignment'] }, { id: 'c2', ...at('hunter2'), kinds: ['assignment'] }] };

function setup(o: { on?: boolean; scans?: CommandResult[]; prompts?: CommandResult[] } = {}) {
  document.body.replaceChildren();
  const sent: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  const scans = [...(o.scans ?? [])];
  const prompts = [...(o.prompts ?? [])];
  const book = new PromptSecretsBook();
  book.reset({ enabled: o.on ?? true, available: true });
  const send = (cmd: string, args: Record<string, unknown>): Promise<CommandResult> => {
    sent.push({ cmd, args });
    if (cmd === 'prompt_secrets.scan') return Promise.resolve(scans.shift() ?? { ok: true, data: SCAN });
    return Promise.resolve(prompts.shift() ?? { ok: true, data: { queued: false, retried: false } });
  };
  // The review, held until the test answers it.
  const reviews: Array<{ req: SecretsReviewRequest; answer(o: SecretsReviewOutcome): void }> = [];
  const flow = new PromptSecretsFlow({ book, send: send as never, unsupported: () => false, review: (req) => new Promise((answer) => reviews.push({ req, answer })) });
  const packups: string[] = [];
  const view = (id: string) => ({ name: 'Pebble', desk: 0, harness: 'claude', display: 'idle', worker: { id, session: 's', agent_kind: 'claude', status: 'idle' } });
  const host = {
    store: { floorName: (id: string) => id, workerView: view, floorView: () => ({ asleep: false }), workers: new Map([['A', {}]]) },
    unsupported: () => false,
    toast: () => {},
    upload: () => Promise.resolve({ ok: true, data: { path: '/drops/image.png' } }),
    send,
    secrets: flow,
    packup: (_id: string, text: string) => (packups.push(text), Promise.resolve<PackupOutcome>('send')),
  } as unknown as PromptHost;
  const overlay = new PromptOverlay(document.body, host);
  const inner = overlay as unknown as { composer: { insertText(t: string): void }; dialog: HTMLDialogElement; form: HTMLFormElement };
  const flush = async () => {
    for (let n = 0; n < 20; n++) await Promise.resolve();
  };
  overlay.open('A');
  inner.composer.insertText(TEXT);
  const press = (key: string) => (document.querySelector(`[data-key="${key}"]`) as HTMLElement).click();
  const cmds = () => sent.map((s) => s.cmd);
  return { overlay, book, sent, cmds, reviews, packups, flush, press, form: inner.form };
}

describe('PromptOverlay and prompt secrets (#108)', () => {
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

  it('off: today’s send, no scan, no "Review secrets"', async () => {
    const e = setup({ on: false });
    expect(document.querySelector('[data-key="review"]')).toBeNull();
    e.press('send');
    await e.flush();
    expect(e.sent).toEqual([{ cmd: 'worker.prompt', args: { id: 'A', text: TEXT } }]);
    expect(e.packups).toEqual([TEXT]);
  });

  it('on, nothing found: scanned, then sent as today (pack up’s check after the scan), no review', async () => {
    const e = setup({ scans: [{ ok: true, data: { revision: 'clean', candidates: [] } }] });
    expect(document.querySelector('[data-key="review"]')!.textContent).toBe('Review secrets');
    e.press('send');
    await e.flush();
    expect(e.cmds()).toEqual(['prompt_secrets.scan', 'worker.prompt']);
    expect(e.sent[1]!.args).toEqual({ id: 'A', text: TEXT });
    expect(e.reviews).toHaveLength(0);
    expect(e.packups).toEqual([TEXT]);
  });

  it('on, found: the review opens, nothing goes before Confirm; Confirm sends the decisions and skips pack up', async () => {
    const e = setup();
    e.press('send');
    await e.flush();
    expect(e.reviews).toHaveLength(1);
    expect(e.reviews[0]!.req.target).toBe('Pebble');
    expect(e.overlay.summary()!.state).toBe('reviewing');
    expect(document.querySelector('[data-key="send"]')!.textContent).toBe('Reviewing…');
    expect(e.cmds()).toEqual(['prompt_secrets.scan']);
    // A second Send meanwhile does nothing.
    e.press('send');
    await e.flush();
    expect(e.reviews).toHaveLength(1);
    const review = e.reviews[0]!.req.review;
    review.setState('c2', 'ignore');
    e.reviews[0]!.answer({ kind: 'confirm', review });
    await e.flush();
    expect(e.sent[1]).toEqual({
      cmd: 'worker.prompt',
      args: { id: 'A', text: TEXT, secrets: { revision: 'rev-1', decisions: [{ candidate: 'c1', action: 'protect', ...at('ghp_abc123') }, { candidate: 'c2', action: 'ignore' }] } },
    });
    // Pack up's LLM never saw a protected value.
    expect(e.packups).toEqual([]);
    expect(e.overlay.summary()!.state).toBe('sent');
  });

  it('every candidate ignored: a valid review, and pack up’s check runs on the text (it is all plain text)', async () => {
    const e = setup();
    e.press('send');
    await e.flush();
    const review = e.reviews[0]!.req.review;
    review.setState('c1', 'ignore');
    review.setState('c2', 'ignore');
    e.reviews[0]!.answer({ kind: 'confirm', review });
    await e.flush();
    expect(e.packups).toEqual([TEXT]);
    expect((e.sent[1]!.args.secrets as { decisions: unknown[] }).decisions).toEqual([{ candidate: 'c1', action: 'ignore' }, { candidate: 'c2', action: 'ignore' }]);
  });

  it('cancel: nothing sent, the note kept and said so', async () => {
    const e = setup();
    e.press('send');
    await e.flush();
    e.reviews[0]!.answer({ kind: 'cancel' });
    await e.flush();
    expect(e.cmds()).toEqual(['prompt_secrets.scan']);
    const s = e.overlay.summary()!;
    expect(s.state).toBe('ready');
    expect(s.text).toBe(TEXT);
    expect(s.status).toBe('Not sent: the prompt is still here.');
  });

  it('stale: scanned and reviewed again with a note, sent only on the new Confirm; the switch gone off keeps the note', async () => {
    const e = setup({ scans: [{ ok: true, data: SCAN }, { ok: true, data: { ...SCAN, revision: 'rev-2' } }], prompts: [{ ok: false, code: 'secrets_review_stale', message: 'stale' }] });
    e.press('send');
    await e.flush();
    e.reviews[0]!.answer({ kind: 'confirm', review: e.reviews[0]!.req.review });
    await e.flush();
    expect(e.reviews).toHaveLength(2);
    expect(e.reviews[1]!.req.notice).toMatch(/Look it over again/);
    expect(e.cmds()).toEqual(['prompt_secrets.scan', 'worker.prompt', 'prompt_secrets.scan']);
    e.reviews[1]!.answer({ kind: 'confirm', review: e.reviews[1]!.req.review });
    await e.flush();
    expect((e.sent[3]!.args.secrets as { revision: string }).revision).toBe('rev-2');

    const off = setup({ prompts: [{ ok: false, code: 'secrets_review_off', message: 'off' }] });
    off.press('send');
    await off.flush();
    off.reviews[0]!.answer({ kind: 'confirm', review: off.reviews[0]!.req.review });
    await off.flush();
    expect(off.cmds()).toEqual(['prompt_secrets.scan', 'worker.prompt']);
    expect(off.overlay.summary()!).toMatchObject({ state: 'ready', text: TEXT, status: expect.stringMatching(/switched off.*nothing was sent/), error: false });
  });

  it('"Review secrets" and Ctrl+Shift+X open the review even when nothing is found', async () => {
    const e = setup({ scans: [{ ok: true, data: { revision: 'clean', candidates: [] } }, { ok: true, data: { revision: 'clean', candidates: [] } }] });
    e.press('review');
    await e.flush();
    expect(e.reviews.map((r) => r.req.manual)).toEqual([true]);
    e.reviews[0]!.answer({ kind: 'cancel' });
    await e.flush();
    e.form.dispatchEvent(new KeyboardEvent('keydown', { key: 'X', code: 'KeyX', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    await e.flush();
    expect(e.reviews).toHaveLength(2);
    // The switch goes off: the control goes.
    e.book.upsert({ enabled: false, available: true });
    e.reviews[1]!.answer({ kind: 'cancel' });
    await e.flush();
    expect(document.querySelector('[data-key="review"]')).toBeNull();
  });
});
