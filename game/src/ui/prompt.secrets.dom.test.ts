// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import { HANDOVER_STALE, packupCheck } from './packupSend';
import { PromptSecretsBook } from '../world/promptSecrets';
import { type PromptHost, PromptOverlay } from './prompt';
import { PromptSecretsFlow } from './secretsFlow';
import type { SecretsReviewOutcome, SecretsReviewRequest } from './secretsReview';
import type { PackupChoice, PackupConfirm } from './sendHome';

// #108: the P overlay's send with "Review prompt secrets before sending": the scan first (before pack up's check), the
// review over the overlay, nothing sent before Confirm, a stale review reviewed again, the switch off as today.

const TEXT = 'Deploy with TOKEN=ghp_abc123 and pw=hunter2';
const at = (v: string) => ({ start: TEXT.indexOf(v), end: TEXT.indexOf(v) + v.length });
const SCAN = { revision: 'rev-1', candidates: [{ id: 'c1', ...at('ghp_abc123'), kinds: ['assignment'] }, { id: 'c2', ...at('hunter2'), kinds: ['assignment'] }] };

function setup(o: { on?: boolean; scans?: CommandResult[]; prompts?: CommandResult[]; detects?: CommandResult[]; confirm?: PackupChoice } = {}) {
  document.body.replaceChildren();
  const sent: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  const scans = [...(o.scans ?? [])];
  const prompts = [...(o.prompts ?? [])];
  const book = new PromptSecretsBook();
  book.reset({ enabled: o.on ?? true, available: true });
  // `hold()`: scans from then on wait until its release (a scan on its way).
  let held: Array<() => void> | null = null;
  const hold = () => {
    const mine: Array<() => void> = [];
    held = mine;
    return () => {
      held = null;
      for (const go of mine.splice(0)) go();
    };
  };
  const send = (cmd: string, args: Record<string, unknown>): Promise<CommandResult> => {
    sent.push({ cmd, args });
    if (cmd === 'prompt_secrets.scan') {
      const answer = scans.shift() ?? { ok: true as const, data: SCAN };
      return held ? new Promise((resolve) => held!.push(() => resolve(answer))) : Promise.resolve(answer);
    }
    return Promise.resolve(prompts.shift() ?? { ok: true, data: { queued: false, retried: false } });
  };
  // The review, held until the test answers it.
  const reviews: Array<{ req: SecretsReviewRequest; answer(o: SecretsReviewOutcome): void }> = [];
  const flow = new PromptSecretsFlow({ book, send: send as never, unsupported: () => false, review: (req) => new Promise((answer) => reviews.push({ req, answer })) });
  // The app's pack-up check over a scripted `packup.detect` (default: no match); the confirm answers `o.confirm`.
  const packups: string[] = [];
  const detects: Array<Record<string, unknown>> = [];
  const confirms: PackupConfirm[] = [];
  const answers = [...(o.detects ?? [])];
  const check = packupCheck({
    applies: () => true,
    detect: (args) => (packups.push(args.text), detects.push(args), Promise.resolve(answers.shift() ?? { ok: true, data: { matched: false, score: 0.1 } })),
    sendHome: () => {},
    confirm: (_id, pk) => (confirms.push(pk), Promise.resolve(o.confirm ?? 'cancel')),
  });
  const toasts: string[] = [];
  const view = (id: string) => ({ name: 'Pebble', desk: 0, harness: 'claude', display: 'idle', worker: { id, session: 's', agent_kind: 'claude', status: 'idle' } });
  const host = {
    store: { floorName: (id: string) => id, workerView: view, floorView: () => ({ asleep: false }), workers: new Map([['A', {}]]) },
    unsupported: () => false,
    toast: (m: string) => void toasts.push(m),
    upload: () => Promise.resolve({ ok: true, data: { path: '/drops/image.png' } }),
    send,
    secrets: flow,
    packup: check,
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
  return { overlay, book, sent, cmds, reviews, packups, detects, confirms, toasts, flush, hold, press, form: inner.form };
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

  it('on, found: the review opens, nothing goes before Confirm; Confirm gives pack up’s check the review, then sends the decisions', async () => {
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
    // Round 4: pack up's check had the review (the bridge gives its models the references): "Confirm and continue".
    expect(e.reviews[0]!.req.action).toBe('Confirm and continue');
    expect(e.detects).toEqual([{ id: 'A', text: TEXT, secrets: e.sent[1]!.args.secrets }]);
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

  describe('round 4: pack up’s check with the review, and its hand-over', () => {
    const REF = '[secret in file /run/user/1000/herdr-world/secrets/AAAAAAAAAAAAAAAAAAAAAAAAAA/BBBBBBBBBBBBBBBBBBBBBBBBBB]';
    const SENT = TEXT.replace('ghp_abc123', REF);
    const reviewed = async (e: ReturnType<typeof setup>) => {
      e.press('send');
      await e.flush();
      const review = e.reviews.at(-1)!.req.review;
      review.setState('c2', 'ignore');
      e.reviews.at(-1)!.answer({ kind: 'confirm', review });
      await e.flush();
    };

    it('no match: the text the check read goes with its hand-over, no review again (the files become the worker’s)', async () => {
      const e = setup({ detects: [{ ok: true, data: { matched: false, score: 0.1, sent: SENT, protected: 1, secrets_pending: 'tok-1' } }] });
      await reviewed(e);
      expect(e.cmds()).toEqual(['prompt_secrets.scan', 'worker.prompt']);
      expect(e.sent[1]!.args).toEqual({ id: 'A', text: SENT, secrets_pending: 'tok-1' });
      expect(e.overlay.summary()!.state).toBe('sent');
    });

    it('a match: the confirm shows what the models read (the references, `removed` in it); “Send as written (stay)” sends that with the hand-over', async () => {
      const task = SENT.slice(0, SENT.indexOf(' and pw'));
      const removed = [{ start: task.length, end: SENT.length }];
      const e = setup({ detects: [{ ok: true, data: { matched: true, task, removed, score: 0.97, sent: SENT, protected: 1, secrets_pending: 'tok-2' } }], confirm: 'stay' });
      await reviewed(e);
      expect(e.confirms).toEqual([{ original: SENT, task, removed, pending: 'tok-2' }]);
      expect(e.sent[1]!.args).toEqual({ id: 'A', text: SENT, secrets_pending: 'tok-2' });
    });

    it('the hand-over refused as stale (expired, the switch changed): nothing more is sent, the note stays for a new review', async () => {
      const e = setup({ detects: [{ ok: true, data: { matched: false, score: 0.1, sent: SENT, protected: 1, secrets_pending: 'tok-3' } }], prompts: [{ ok: false, code: 'secrets_review_stale', message: 'stale' }] });
      await reviewed(e);
      expect(e.cmds()).toEqual(['prompt_secrets.scan', 'worker.prompt']);
      const s = e.overlay.summary()!;
      expect(s.state).toBe('failed');
      expect(s.status).toBe(HANDOVER_STALE);
      expect(s.text).toBe(TEXT);
      expect(e.reviews).toHaveLength(1);
    });

    it('the check refuses the review as stale: reviewed again (“Confirm and continue”), checked again, never sent on its own', async () => {
      const e = setup({ scans: [{ ok: true, data: SCAN }, { ok: true, data: { ...SCAN, revision: 'rev-2' } }], detects: [{ ok: false, code: 'secrets_review_stale', message: 'stale' }] });
      await reviewed(e);
      expect(e.reviews).toHaveLength(2);
      expect(e.reviews[1]!.req).toMatchObject({ notice: expect.stringMatching(/^This review no longer fits/), action: 'Confirm and continue' });
      expect(e.cmds()).toEqual(['prompt_secrets.scan', 'prompt_secrets.scan']);
      const again = e.reviews[1]!.req.review;
      e.reviews[1]!.answer({ kind: 'confirm', review: again });
      await e.flush();
      expect(e.detects.map((d) => (d.secrets as { revision: string }).revision)).toEqual(['rev-1', 'rev-2']);
      expect(e.sent.at(-1)).toEqual({ cmd: 'worker.prompt', args: { id: 'A', text: TEXT, secrets: { revision: 'rev-2', decisions: again.decisions() } } });
    });

    it('a check that fails or comes too late: the prompt goes as written with its own review', async () => {
      const e = setup({ detects: [{ ok: false, code: 'timeout', message: 'no answer' }] });
      await reviewed(e);
      expect(e.sent[1]).toEqual({ cmd: 'worker.prompt', args: { id: 'A', text: TEXT, secrets: e.detects[0]!.secrets } });
    });
  });

  // #108 round 4 fix (D1's audit): pack up's check refused as stale is reviewed again only while the overlay is open.
  it('pack up’s check refused as stale, then closed while it is scanned again: nothing more is checked, sent or said', async () => {
    const e = setup({ detects: [{ ok: false, code: 'secrets_review_stale', message: 'stale' }] });
    e.press('send');
    await e.flush();
    const release = e.hold();
    e.reviews[0]!.answer({ kind: 'confirm', review: e.reviews[0]!.req.review });
    await e.flush();
    expect(e.detects).toHaveLength(1);
    e.overlay.close();
    release();
    await e.flush();
    expect(e.reviews).toHaveLength(1);
    expect(e.detects).toHaveLength(1);
    expect(e.cmds()).not.toContain('worker.prompt');
    expect(e.toasts).toEqual([]);
  });
});
