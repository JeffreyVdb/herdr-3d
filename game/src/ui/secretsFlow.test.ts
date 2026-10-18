import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import type { CommandName } from '../net/protocol';
import { PromptSecretsBook } from '../world/promptSecrets';
import { PromptSecretsFlow, type Go } from './secretsFlow';
import type { SecretsReviewOutcome, SecretsReviewRequest } from './secretsReview';

const TEXT = 'deploy with token=ghp_abc123 and pw=hunter2';
const at = (v: string) => ({ start: TEXT.indexOf(v), end: TEXT.indexOf(v) + v.length });
const SCAN = { revision: 'rev-1', candidates: [{ id: 'c1', ...at('ghp_abc123'), kinds: ['assignment'] }, { id: 'c2', ...at('hunter2'), kinds: ['assignment'] }] };

/** A flow over a fake bridge: scans answer from `scans` in turn, the review from `outcomes` (a function of the request). */
function rig(o: { on?: boolean; scans?: CommandResult[]; review?: (req: SecretsReviewRequest) => SecretsReviewOutcome; unsupported?: CommandName[] } = {}) {
  const book = new PromptSecretsBook();
  book.reset({ enabled: o.on ?? true, available: true });
  const sent: Array<{ t: string; args: unknown }> = [];
  const reviews: SecretsReviewRequest[] = [];
  const scans = [...(o.scans ?? [])];
  const flow = new PromptSecretsFlow({
    book,
    unsupported: (t) => (o.unsupported ?? []).includes(t),
    send: (t, args) => {
      sent.push({ t, args });
      return Promise.resolve(scans.shift() ?? { ok: true, data: SCAN });
    },
    review: (req) => {
      reviews.push(req);
      return Promise.resolve(o.review ? o.review(req) : { kind: 'cancel' });
    },
  });
  return { flow, book, sent, reviews };
}

const confirmIgnoring = (...ignore: string[]) => (req: SecretsReviewRequest): SecretsReviewOutcome => {
  // The dialog's own model: take the request's review and decide.
  const r = req.review;
  for (const k of ignore) r.setState(k, 'ignore');
  return { kind: 'confirm', review: r };
};

const req = { key: 'w1', text: TEXT, target: 'Pebble' };

describe('#108 the send flow of a prompt with possible secrets', () => {
  it('off (or an older bridge): today’s send, no scan', async () => {
    for (const r of [rig({ on: false }), rig({ unsupported: ['prompt_secrets.scan'] })]) {
      const out = await r.flow.review(req);
      expect(out).toEqual({ kind: 'send', protects: 0, shown: TEXT, review: null });
      expect(r.sent).toEqual([]);
      expect(r.reviews).toEqual([]);
    }
  });

  it('on, nothing found: sent as today without a review (no empty dialog)', async () => {
    const r = rig({ scans: [{ ok: true, data: { revision: 'clean', candidates: [] } }] });
    const out = await r.flow.review(req);
    expect(out).toMatchObject({ kind: 'send', protects: 0, shown: TEXT, review: null });
    expect((out as Go).secrets).toBeUndefined();
    expect(r.sent).toEqual([{ t: 'prompt_secrets.scan', args: { text: TEXT } }]);
    expect(r.reviews).toEqual([]);
  });

  it('on, found: the review opens over the whole text; Confirm gives the decisions, the shown text masked', async () => {
    const r = rig({ review: confirmIgnoring('c2') });
    const out = (await r.flow.review(req)) as Go;
    expect(r.reviews).toHaveLength(1);
    expect(r.reviews[0]).toMatchObject({ target: 'Pebble', notice: null, manual: false, action: 'Confirm and send' });
    expect(r.reviews[0]?.review.text).toBe(TEXT);
    expect(out.secrets).toEqual({ revision: 'rev-1', decisions: [{ candidate: 'c1', action: 'protect', ...at('ghp_abc123') }, { candidate: 'c2', action: 'ignore' }] });
    expect(out.protects).toBe(1);
    expect(out.shown).toBe('deploy with token=[secret] and pw=hunter2');
  });

  it('cancel keeps the draft and sends nothing', async () => {
    const r = rig();
    expect(await r.flow.review(req)).toEqual({ kind: 'kept', why: 'cancel', message: expect.any(String) });
    expect(r.sent.map((s) => s.t)).toEqual(['prompt_secrets.scan']);
  });

  it('the switch changed while the review was open: nothing is sent, the reason is said', async () => {
    const r = rig({ review: () => ({ kind: 'changed', message: 'Review prompt secrets was switched off in Settings.' }) });
    expect(await r.flow.review(req)).toEqual({ kind: 'kept', why: 'changed', message: 'Review prompt secrets was switched off in Settings.' });
  });

  it('the switch went off while the scan ran: kept, never a send', async () => {
    const book = new PromptSecretsBook();
    book.reset({ enabled: true, available: true });
    const flow = new PromptSecretsFlow({
      book,
      unsupported: () => false,
      send: () => {
        book.upsert({ enabled: false, available: true });
        return Promise.resolve({ ok: true, data: SCAN });
      },
      review: () => Promise.resolve({ kind: 'cancel' }),
    });
    expect(await flow.review(req)).toMatchObject({ kind: 'kept', why: 'changed' });
  });

  it('a scan that fails or cannot be read keeps the draft, with why', async () => {
    for (const [scan, why] of [
      [{ ok: false, code: 'secrets_review_off', message: 'off' }, 'off'],
      [{ ok: false, code: 'secrets_unavailable', message: 'the scan took over 10 s' }, 'failed'],
      [{ ok: false, code: 'timeout', message: 'x' }, 'failed'],
      [{ ok: true, data: { revision: 'r', candidates: [{ id: 'c1', start: 5, end: 99, kinds: [] }] } }, 'failed'],
    ] as const) {
      const r = rig({ scans: [scan] });
      const out = await r.flow.review(req);
      expect(out, JSON.stringify(scan)).toMatchObject({ kind: 'kept', why });
      expect(r.reviews).toEqual([]);
    }
  });

  it('by hand: the review opens even with nothing found; off, it says to switch it on', async () => {
    const r = rig({ scans: [{ ok: true, data: { revision: 'clean', candidates: [] } }], review: (q) => (q.review.mark(0, 6), { kind: 'confirm', review: q.review }) });
    const out = (await r.flow.review({ ...req, manual: true })) as Go;
    expect(r.reviews[0]?.manual).toBe(true);
    expect(out.secrets).toEqual({ revision: 'clean', decisions: [{ action: 'protect', start: 0, end: 6 }] });
    expect(await rig({ on: false }).flow.review({ ...req, manual: true })).toMatchObject({ kind: 'kept', why: 'off' });
  });

  it('a review that protects nothing and ignores nothing is no review: sent without `secrets`', async () => {
    const r = rig({ scans: [{ ok: true, data: { revision: 'clean', candidates: [] } }], review: (q) => ({ kind: 'confirm', review: q.review }) });
    const out = (await r.flow.review({ ...req, manual: true })) as Go;
    expect(out.secrets).toBeUndefined();
  });
});

describe('#108 delivering a reviewed prompt', () => {
  const ok: CommandResult = { ok: true, data: { queued: false, retried: false, sent: 'x', protected: 1 } };

  it('stale or required: scanned and reviewed again (the earlier choices taken over), never sent on its own', async () => {
    for (const code of ['secrets_review_stale', 'secrets_review_required']) {
      const r = rig({ scans: [{ ok: true, data: SCAN }, { ok: true, data: { ...SCAN, revision: 'rev-2' } }], review: confirmIgnoring('c2') });
      const first = (await r.flow.review(req)) as Go;
      const answers: CommandResult[] = [{ ok: false, code, message: 'no' }, ok];
      const tried: Go[] = [];
      const out = await r.flow.deliver(req, first, (go) => (tried.push(go), Promise.resolve(answers.shift() as CommandResult)));
      expect(out).toMatchObject({ kind: 'answered', result: ok });
      expect(tried.map((g) => g.secrets?.revision)).toEqual(['rev-1', 'rev-2']);
      expect(r.reviews).toHaveLength(2);
      expect(r.reviews[1]?.notice).toMatch(/again|cover/);
      // The second review started from the first one's choices.
      expect(r.reviews[1]?.review.get('c2')?.state).toBe('ignore');
    }
  });

  it('stale, then cancel: kept, sent once', async () => {
    let n = 0;
    const r = rig({ review: (q) => (n++ === 0 ? { kind: 'confirm', review: q.review } : { kind: 'cancel' }) });
    const first = (await r.flow.review(req)) as Go;
    let sends = 0;
    const out = await r.flow.deliver(req, first, () => (sends++, Promise.resolve({ ok: false, code: 'secrets_review_stale', message: 'stale' })));
    expect(out).toMatchObject({ kind: 'kept', why: 'cancel' });
    expect(sends).toBe(1);
  });

  it('a stale re-scan that finds nothing still opens the review (confirm or mark by hand)', async () => {
    const r = rig({ scans: [{ ok: true, data: SCAN }, { ok: true, data: { revision: 'clean', candidates: [] } }], review: (q) => ({ kind: 'confirm', review: q.review }) });
    const first = (await r.flow.review(req)) as Go;
    const answers: CommandResult[] = [{ ok: false, code: 'secrets_review_stale', message: 'stale' }, ok];
    await r.flow.deliver(req, first, () => Promise.resolve(answers.shift() as CommandResult));
    expect(r.reviews).toHaveLength(2);
    expect(r.reviews[1]?.review.marks()).toEqual([]);
  });

  it('off or unavailable: kept with a note, no automatic send', async () => {
    for (const [code, why] of [
      ['secrets_review_off', 'off'],
      ['secrets_unavailable', 'failed'],
    ] as const) {
      const r = rig({ review: (q) => ({ kind: 'confirm', review: q.review }) });
      const first = (await r.flow.review(req)) as Go;
      let sends = 0;
      const out = await r.flow.deliver(req, first, () => (sends++, Promise.resolve({ ok: false, code, message: 'no private runtime directory' })));
      expect(out).toMatchObject({ kind: 'kept', why });
      expect(sends).toBe(1);
    }
  });

  it('other answers go back to the composer as they are', async () => {
    const r = rig({ review: (q) => ({ kind: 'confirm', review: q.review }) });
    const first = (await r.flow.review(req)) as Go;
    const busy: CommandResult = { ok: false, code: 'invalid_state', message: 'invalid state: blocked' };
    expect(await r.flow.deliver(req, first, () => Promise.resolve(busy))).toMatchObject({ kind: 'answered', result: busy });
  });

  it('unanswered (a timeout, a dropped connection): the identical Send again carries the same revision and decisions', async () => {
    const r = rig({ review: confirmIgnoring('c1') });
    const first = (await r.flow.review(req)) as Go;
    const lost = await r.flow.deliver(req, first, () => Promise.resolve({ ok: false, code: 'timeout', message: 'no answer' }));
    expect(lost).toMatchObject({ kind: 'answered', result: { ok: false, code: 'timeout' } });
    // The person presses Send again: no scan, no dialog.
    const again = (await r.flow.review(req)) as Go;
    expect(again.retry).toBe(true);
    expect(again.secrets).toEqual(first.secrets);
    expect(r.sent).toHaveLength(1);
    expect(r.reviews).toHaveLength(1);
    // Answered for sure this time: the next Send of it is a new review.
    await r.flow.deliver(req, again, () => Promise.resolve(ok));
    await r.flow.review(req);
    expect(r.sent).toHaveLength(2);
    // Another text is never a retry.
    const other = rig({ review: (q) => ({ kind: 'confirm', review: q.review }) });
    const g = (await other.flow.review(req)) as Go;
    await other.flow.deliver(req, g, () => Promise.resolve({ ok: false, code: 'disconnected', message: 'x' }));
    await other.flow.review({ ...req, text: `${TEXT}!` });
    expect(other.sent).toHaveLength(2);
  });
});

describe('#108 round 4: the flow for every other composer', () => {
  /** A scan of `text` from the fixture's rules is not needed here: a scan per text, by its value. */
  const scanOfText = (text: string, values: string[]) => {
    let from = 0;
    return {
      revision: `rev:${text}`,
      candidates: values.map((v, i) => {
        const start = text.indexOf(v, from);
        from = start + v.length;
        return { id: `c${i + 1}`, start, end: start + v.length, kinds: ['assignment'] };
      }),
    };
  };

  it('the action word: “Confirm and continue” before an AI step, “Confirm and save” for a stored prompt', async () => {
    const r = rig({ review: (q) => ({ kind: 'confirm', review: q.review }) });
    await r.flow.review({ ...req, action: 'Confirm and continue' });
    await r.flow.review({ ...req, key: 's1', stored: true });
    expect(r.reviews.map((q) => q.action)).toEqual(['Confirm and continue', 'Confirm and save']);
    expect(r.reviews.map((q) => q.stored)).toEqual([null, expect.stringMatching(/^A saved prompt keeps no protected file/)]);
  });

  it('a stored prompt opens with every match ignored: Confirm saves the all-ignore review; Cancel says “Not saved”', async () => {
    const r = rig({ review: (q) => ({ kind: 'confirm', review: q.review }) });
    const out = (await r.flow.review({ ...req, stored: true })) as Go;
    expect(out.secrets).toEqual({ revision: 'rev-1', decisions: [{ candidate: 'c1', action: 'ignore' }, { candidate: 'c2', action: 'ignore' }] });
    expect(out.protects).toBe(0);
    const c = rig();
    expect(await c.flow.review({ ...req, stored: true })).toEqual({ kind: 'kept', why: 'cancel', message: 'Not saved: the review was cancelled.' });
  });

  it('several texts: each scanned alone and reviewed in turn (its field named), only those that decided anything keyed in `secrets`', async () => {
    const texts = { text: 'ticket: token=abc123', extra: 'no secret here', prompt: '' };
    const scans: Record<string, ReturnType<typeof scanOfText>> = { 'ticket: token=abc123': scanOfText(texts.text, ['abc123']), 'no secret here': scanOfText(texts.extra, []) };
    const book = new PromptSecretsBook();
    book.reset({ enabled: true, available: true });
    const sent: string[] = [];
    const reviews: SecretsReviewRequest[] = [];
    const flow = new PromptSecretsFlow({
      book,
      unsupported: () => false,
      send: (_t, args) => {
        sent.push(args.text);
        return Promise.resolve({ ok: true, data: scans[args.text] });
      },
      review: (q) => {
        reviews.push(q);
        return Promise.resolve({ kind: 'confirm', review: q.review });
      },
    });
    const freq = {
      key: 'run:f1:3',
      target: 'Desk 4',
      fields: [
        { path: 'text', text: texts.text, label: 'the ticket' },
        { path: 'extra', text: texts.extra, label: 'the extra instructions' },
        { path: 'prompt', text: texts.prompt, label: 'the edited prompt' },
      ],
    };
    const go = await flow.reviewFields(freq);
    // The empty text is not scanned; the clean one opens nothing.
    expect(sent).toEqual([texts.text, texts.extra]);
    expect(reviews.map((q) => q.field)).toEqual(['the ticket']);
    expect(go).toMatchObject({ kind: 'send', protects: 1, secrets: { text: { revision: `rev:${texts.text}`, decisions: [{ candidate: 'c1', action: 'protect', start: 14, end: 20 }] } }, shown: { text: 'ticket: token=[secret]', extra: texts.extra } });
    expect(Object.keys((go as { secrets: object }).secrets)).toEqual(['text']);
    // Refused as stale: reviewed again, the text with decisions opened again (its choices taken over), the clean one not.
    let n = 0;
    const d = await flow.deliverFields(freq, go as never, () => Promise.resolve(n++ ? { ok: true, data: {} } : { ok: false, code: 'secrets_review_stale', message: 'stale' }));
    expect(d).toMatchObject({ kind: 'answered', result: { ok: true } });
    expect(reviews.map((q) => [q.field, q.notice !== null])).toEqual([
      ['the ticket', false],
      ['the ticket', true],
    ]);
    // Cancel on any text keeps them all.
    const cancel = new PromptSecretsFlow({ book, unsupported: () => false, send: (_t, args) => Promise.resolve({ ok: true, data: scans[args.text] }), review: () => Promise.resolve({ kind: 'cancel' }) });
    expect(await cancel.reviewFields(freq)).toMatchObject({ kind: 'kept', why: 'cancel' });
  });

  it('several texts, the switch off: today’s send, nothing scanned, no `secrets`', async () => {
    const r = rig({ on: false });
    const go = await r.flow.reviewFields({ key: 'a', target: 'Pebble', fields: [{ path: 'note', text: 'pw=hunter2', label: 'your note' }] });
    expect(go).toEqual({ kind: 'send', protects: 0, shown: { note: 'pw=hunter2' }, reviews: { note: null } });
    expect(r.sent).toEqual([]);
  });

  it('several texts unanswered: the identical answers again carry the same reviews (no scan, no dialog)', async () => {
    const r = rig({ review: (q) => ({ kind: 'confirm', review: q.review }) });
    const freq = { key: 'w1:ask', target: 'Pebble', fields: [{ path: 'prompt', text: TEXT, label: 'your prompt' }] };
    const first = await r.flow.reviewFields(freq);
    await r.flow.deliverFields(freq, first as never, () => Promise.resolve({ ok: false, code: 'timeout', message: 'x' }));
    const again = await r.flow.reviewFields(freq);
    expect(again).toMatchObject({ retry: true, secrets: (first as { secrets: unknown }).secrets });
    expect(r.reviews).toHaveLength(1);
  });
});

describe('#108 round 4: a composer gone meanwhile (`live`)', () => {
  const ok: CommandResult = { ok: true, data: {} };
  const stale: CommandResult = { ok: false, code: 'secrets_review_stale', message: 'stale' };
  /** `alive` read by the request's `live`; `onScan` runs as each scan is asked (before it answers). */
  function gone(o: { review?: (req: SecretsReviewRequest) => SecretsReviewOutcome; onScan?: (n: number) => void } = {}) {
    const state = { alive: true, scans: 0 };
    const book = new PromptSecretsBook();
    book.reset({ enabled: true, available: true });
    const reviews: SecretsReviewRequest[] = [];
    const flow = new PromptSecretsFlow({
      book,
      unsupported: () => false,
      send: () => {
        o.onScan?.(++state.scans);
        return Promise.resolve({ ok: true, data: SCAN });
      },
      review: (q) => {
        reviews.push(q);
        return Promise.resolve(o.review ? o.review(q) : { kind: 'confirm', review: q.review });
      },
    });
    return { flow, state, reviews, req: { ...req, live: () => state.alive } };
  }

  it('gone before its scan: nothing is scanned or reviewed', async () => {
    const r = gone();
    r.state.alive = false;
    expect(await r.flow.review(r.req)).toMatchObject({ kind: 'kept', why: 'gone' });
    expect(r.state.scans).toBe(0);
  });

  it('gone while its scan ran: no review opens over whatever is there now', async () => {
    const r = gone({ onScan: () => (r.state.alive = false) });
    expect(await r.flow.review(r.req)).toMatchObject({ kind: 'kept', why: 'gone' });
    expect(r.reviews).toEqual([]);
  });

  it('gone while the review was open: its Confirm sends nothing', async () => {
    const r = gone({ review: (q) => ((r.state.alive = false), { kind: 'confirm', review: q.review }) });
    expect(await r.flow.review(r.req)).toMatchObject({ kind: 'kept', why: 'gone' });
  });

  it('deliver: gone before the send, or before the send after a review again, sends nothing', async () => {
    const r = gone();
    const first = (await r.flow.review(r.req)) as Go;
    r.state.alive = false;
    let sends = 0;
    expect(await r.flow.deliver(r.req, first, () => (sends++, Promise.resolve(ok)))).toMatchObject({ kind: 'kept', why: 'gone' });
    expect(sends).toBe(0);
    // Refused as stale, and gone while it was scanned again: sent once, no second review.
    const s = gone({ onScan: (n) => n === 2 && (s.state.alive = false) });
    const go = (await s.flow.review(s.req)) as Go;
    const tried: Go[] = [];
    expect(await s.flow.deliver(s.req, go, (g) => (tried.push(g), Promise.resolve(stale)))).toMatchObject({ kind: 'kept', why: 'gone' });
    expect(tried).toHaveLength(1);
    expect(s.reviews).toHaveLength(1);
  });

  it('several texts: gone between them, or before a send after a review again, sends nothing', async () => {
    const fields = [
      { path: 'text', text: TEXT, label: 'the ticket' },
      { path: 'extra', text: TEXT, label: 'the extra instructions' },
    ];
    const r = gone({ review: (q) => ((r.state.alive = false), { kind: 'confirm', review: q.review }) });
    expect(await r.flow.reviewFields({ key: 'run', target: 'Desk 4', fields, live: r.req.live })).toMatchObject({ kind: 'kept', why: 'gone' });
    expect(r.reviews).toHaveLength(1);
    const s = gone({ onScan: (n) => n === 3 && (s.state.alive = false) });
    const freq = { key: 'run', target: 'Desk 4', fields, live: s.req.live };
    const go = await s.flow.reviewFields(freq);
    let sends = 0;
    expect(await s.flow.deliverFields(freq, go as never, () => (sends++, Promise.resolve(stale)))).toMatchObject({ kind: 'kept', why: 'gone' });
    expect(sends).toBe(1);
  });

  it('live all along: as without it', async () => {
    const r = gone();
    const first = (await r.flow.review(r.req)) as Go;
    expect(await r.flow.deliver(r.req, first, () => Promise.resolve(ok))).toMatchObject({ kind: 'answered', result: ok });
  });
});
