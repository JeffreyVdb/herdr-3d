// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import { PromptSecretsBook } from '../world/promptSecrets';
import { HANDOVER_STALE, packupCheck, type PackupCheck } from '../ui/packupSend';
import { PromptSecretsFlow } from '../ui/secretsFlow';
import type { SecretsReviewOutcome, SecretsReviewRequest } from '../ui/secretsReview';
import type { Followup } from '../net/protocol';
import { FollowupCard } from './followupCard';
import { TranscriptMode, type MountTranscript, type TranscriptRenderHost } from './transcriptMode';
import type { PendingPrompt } from './transcriptActivity';

// #108: the laptop's prompt box with "Review prompt secrets before sending": the review before anything goes, the pending
// row never showing a protected value, pack up's check given the review (round 4), drafts in memory only.

const TEXT = 'Deploy with TOKEN=ghp_abc123 and pw=hunter2';
const at = (v: string) => ({ start: TEXT.indexOf(v), end: TEXT.indexOf(v) + v.length });
const SCAN = { revision: 'rev-1', candidates: [{ id: 'c1', ...at('ghp_abc123'), kinds: ['assignment'] }, { id: 'c2', ...at('hunter2'), kinds: ['assignment'] }] };

class MemStorage {
  data = new Map<string, string>();
  getItem = (k: string) => this.data.get(k) ?? null;
  setItem = (k: string, v: string) => void this.data.set(k, v);
  removeItem = (k: string) => void this.data.delete(k);
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/**
 * The app's pack-up check over a scripted `packup.detect` (default: no match): `packups` the texts it was given, `detects`
 * their args. The confirm and the send home are not part of these tests.
 */
function scriptedCheck(answers: CommandResult[] = []) {
  const packups: string[] = [];
  const detects: Array<Record<string, unknown>> = [];
  const check: PackupCheck = packupCheck({
    applies: () => true,
    detect: (args) => (packups.push(args.text), detects.push(args), Promise.resolve(answers.shift() ?? { ok: true, data: { matched: false, score: 0.1 } })),
    sendHome: () => {},
    confirm: () => Promise.resolve('cancel'),
  });
  return { check, packups, detects };
}

async function harness(o: { on?: boolean; scans?: CommandResult[]; detects?: CommandResult[] } = {}) {
  const storage = new MemStorage();
  const book = new PromptSecretsBook();
  book.reset({ enabled: o.on ?? true, available: true });
  const scans = [...(o.scans ?? [])];
  const scanned: string[] = [];
  const reviews: Array<{ req: SecretsReviewRequest; answer(x: SecretsReviewOutcome): void }> = [];
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
  const flow = new PromptSecretsFlow({
    book,
    unsupported: () => false,
    send: (_t, args) => {
      scanned.push(args.text);
      const answer = scans.shift() ?? { ok: true as const, data: SCAN };
      return held ? new Promise((resolve) => held!.push(() => resolve(answer))) : Promise.resolve(answer);
    },
    review: (req) => new Promise((answer) => reviews.push({ req, answer })),
  });
  const prompts: Array<{ args: Record<string, unknown>; resolve(r: CommandResult): void }> = [];
  const status: Array<[string, string | null]> = [];
  const { check, packups, detects } = scriptedCheck(o.detects);
  const pending: Array<readonly PendingPrompt[]> = [];
  let host: TranscriptRenderHost | null = null;
  const mount: MountTranscript = (_box, h) => {
    host = h;
    return { setItems() {}, applyUpdates() {}, setBlocked() {}, setAsk() {}, setFollowup() {}, setCodex() {}, setUsage() {}, setActivity() {}, setPending: (rows: readonly PendingPrompt[]) => pending.push(rows), attachLead() {}, hasItem: () => false, scrollToItem: () => false, focus() {}, focusPrompt() {}, destroy() {} } as never;
  };
  const others: Array<{ t: string; args: Record<string, unknown> }> = [];
  const tx = new TranscriptMode({
    feed: () => null,
    send: ((t: string, args: Record<string, unknown>) => (t === 'worker.prompt' ? new Promise((resolve) => prompts.push({ args, resolve })) : (others.push({ t, args }), Promise.resolve({ ok: true, data: {} })))) as never,
    renderer: () => Promise.resolve(mount),
    overlay: () => ({ hidden: false, style: {}, remove() {}, focus() {} }) as unknown as HTMLElement,
    storage: storage as unknown as Storage,
    status: (kind, text) => status.push([kind, text]),
    modeChanged: () => {},
    packup: check,
    secrets: flow,
  });
  tx.sit('a', 'Ada', true, 'claude');
  await flush();
  return { tx, book, storage, scanned, reviews, prompts, others, status, packups, detects, pending, hold, host: () => host as unknown as TranscriptRenderHost };
}

describe('TranscriptMode and prompt secrets (#108)', () => {
  it('found: the review first, nothing sent or shown before Confirm; the row masks protected values until the ack’s references', async () => {
    const h = await harness();
    const sent = h.host().onPromptSubmit(TEXT);
    await flush();
    expect(h.scanned).toEqual([TEXT]);
    expect(h.reviews).toHaveLength(1);
    expect(h.prompts).toHaveLength(0);
    expect(h.tx.pending).toEqual([]);
    expect(h.status.at(-1)).toEqual(['ok', 'Looking for secrets in the prompt…']);
    // A second Enter meanwhile sends nothing.
    await expect(h.host().onPromptSubmit(TEXT)).resolves.toBe(false);
    const review = h.reviews[0]!.req.review;
    review.setState('c2', 'ignore');
    h.reviews[0]!.answer({ kind: 'confirm', review });
    await flush();
    const decisions = { revision: 'rev-1', decisions: [{ candidate: 'c1', action: 'protect', ...at('ghp_abc123') }, { candidate: 'c2', action: 'ignore' }] };
    // Round 4: pack up's check goes first with the review (its models read the references); no match and no hand-over
    // (a bridge before round 2): the prompt goes with its own review.
    expect(h.reviews[0]!.req.action).toBe('Confirm and continue');
    expect(h.detects).toEqual([{ id: 'a', text: TEXT, secrets: decisions }]);
    expect(h.prompts.map((p) => p.args)).toEqual([{ id: 'a', text: TEXT, secrets: decisions }]);
    expect(h.tx.pending.map((p) => [p.shown, p.state])).toEqual([['Deploy with TOKEN=[secret] and pw=hunter2', 'sending']]);
    // What the view draws of it: never the protected value.
    expect(h.pending.at(-1)?.every((p) => p.shown !== undefined && !p.shown.includes('ghp_abc123'))).toBe(true);
    const out = 'Deploy with TOKEN=[secret in file /run/user/1000/herdr-world/secrets/a/f1] and pw=hunter2';
    h.prompts[0]!.resolve({ ok: true, data: { queued: false, retried: false, sent: out, protected: 1 } });
    await expect(sent).resolves.toBe(true);
    expect(h.tx.pending.map((p) => [p.shown, p.sent, p.state])).toEqual([[out, out, 'sent']]);
  });

  it('cancel: false (the box keeps the draft), nothing sent, and why', async () => {
    const h = await harness();
    const sent = h.host().onPromptSubmit(TEXT);
    await flush();
    h.reviews[0]!.answer({ kind: 'cancel' });
    await expect(sent).resolves.toBe(false);
    expect(h.prompts).toHaveLength(0);
    expect(h.status.at(-1)).toEqual(['ok', 'Not sent: the prompt is still in the box.']);
  });

  it('nothing found: sent as today (pack up checked); "Review secrets" opens the review anyway', async () => {
    const clean = { ok: true as const, data: { revision: 'clean', candidates: [] } };
    const h = await harness({ scans: [clean, clean] });
    const sent = h.host().onPromptSubmit('hello there');
    await flush();
    expect(h.reviews).toHaveLength(0);
    expect(h.packups).toEqual(['hello there']);
    expect(h.prompts.map((p) => p.args)).toEqual([{ id: 'a', text: 'hello there' }]);
    expect(h.tx.pending[0]?.shown).toBeUndefined();
    h.prompts[0]!.resolve({ ok: true, data: { queued: false, retried: false } });
    await expect(sent).resolves.toBe(true);
    void h.host().onPromptSubmit('hello again', { review: true });
    await flush();
    expect(h.reviews.map((r) => r.req.manual)).toEqual([true]);
  });

  it('off: today’s send, no scan; its drafts are written as before', async () => {
    const h = await harness({ on: false });
    expect(h.host().secrets?.on).toBe(false);
    void h.host().onPromptSubmit(TEXT);
    await flush();
    expect(h.scanned).toEqual([]);
    expect(h.prompts.map((p) => p.args)).toEqual([{ id: 'a', text: TEXT }]);
    h.host().draft?.replace(0, 0, 'pw=hunter2');
    expect(h.storage.data.get('h3d.draft.transcript.a')).toContain('hunter2');
  });

  it('on: its drafts never reach storage; switched on, the stored copy goes at once', async () => {
    const h = await harness({ on: false });
    h.host().draft?.replace(0, 0, 'pw=hunter2');
    expect(h.storage.data.size).toBeGreaterThan(0);
    h.book.upsert({ enabled: true, available: true });
    expect([...h.storage.data.values()].some((v) => v.includes('hunter2'))).toBe(false);
    h.host().draft?.replace(10, 10, '!');
    expect([...h.storage.data.values()].some((v) => v.includes('hunter2'))).toBe(false);
  });

  it('round 4: pack up’s hand-over: the text the check read goes with it (the row shows the references), and a stale one keeps the draft', async () => {
    const REF = '[secret in file /run/user/1000/herdr-world/secrets/AAAAAAAAAAAAAAAAAAAAAAAAAA/BBBBBBBBBBBBBBBBBBBBBBBBBB]';
    const SENT = TEXT.replace('ghp_abc123', REF);
    const h = await harness({ detects: [{ ok: true, data: { matched: false, score: 0.1, sent: SENT, protected: 1, secrets_pending: 'tok-1' } }, { ok: true, data: { matched: false, score: 0.1, sent: SENT, protected: 1, secrets_pending: 'tok-2' } }] });
    const confirm = () => {
      const review = h.reviews.at(-1)!.req.review;
      h.reviews.at(-1)!.answer({ kind: 'confirm', review });
    };
    const sent = h.host().onPromptSubmit(TEXT);
    await flush();
    confirm();
    await flush();
    expect(h.prompts.map((p) => p.args)).toEqual([{ id: 'a', text: SENT, secrets_pending: 'tok-1' }]);
    // The row is the text that went (references, no value): nothing to mask.
    expect(h.tx.pending.map((p) => [p.text, p.shown, p.state])).toEqual([[SENT, undefined, 'sending']]);
    h.prompts[0]!.resolve({ ok: true, data: { queued: false, retried: false } });
    await expect(sent).resolves.toBe(true);
    // Refused as stale: false (the box keeps the draft), and why.
    const again = h.host().onPromptSubmit(TEXT);
    await flush();
    confirm();
    await flush();
    h.prompts[1]!.resolve({ ok: false, code: 'secrets_review_stale', message: 'the hand-over expired' });
    await expect(again).resolves.toBe(false);
    expect(h.status.at(-1)).toEqual(['error', HANDOVER_STALE]);
  });

  // #108 round 4 fix (D1's audit): an answer's (and a prompt's) review is the seat's: stood up meanwhile, nothing of it
  // goes and no review opens.
  it('an answer, stood up while it is scanned: nothing is answered, no review opens', async () => {
    const h = await harness({ scans: [{ ok: true, data: { revision: 'r', candidates: [{ id: 'c1', start: 3, end: 10, kinds: ['assignment'] }] } }] });
    const release = h.hold();
    const answered = h.host().onAnswerAsk({ id: 'a', tool_use_id: 'tu1', answers: [{ question: 0, other: 'pw=hunter2' }] } as never);
    await flush();
    expect(h.scanned).toEqual(['pw=hunter2']);
    h.tx.stand();
    release();
    // Not `stale` (the bridge's "the question moved on", which a card treats as answered): nothing happened to it.
    await expect(answered).resolves.toMatchObject({ ok: false, code: 'gone' });
    expect(h.reviews).toEqual([]);
    expect(h.others.filter((x) => x.t === 'worker.answer_ask')).toEqual([]);
  });

  // #108 round 4 fix 2 (R4P2-1's audit): a gone answer touches nothing the next seat has, the follow-up's draft included.
  it('a follow-up answer, stood up while it is scanned: nothing is answered, and its draft is the next seat’s again', async () => {
    const fu: Followup = { turn_id: 't1', score: 0.9, source: 'model', at: 0, questions: [{ id: 'q1', question: 'Which password?', kind: 'open' }] };
    const h = await harness({ scans: [{ ok: true, data: { revision: 'r', candidates: [{ id: 'c1', start: 3, end: 10, kinds: ['assignment'] }] } }] });
    // The card as the view makes it (transcriptRender.ts), over this seat's host.
    const card = (host: TranscriptRenderHost) =>
      new FollowupCard({ answer: (args, o) => host.onAnswerFollowup!(args, o), dismiss: (t) => host.onDismissFollowup!(t), secrets: host.secrets ?? null, drafts: host.followupDrafts!, focusTimeline() {}, resized() {} });
    const first = card(h.host());
    document.body.append(first.el);
    first.set(fu);
    const box = first.el.querySelector<HTMLTextAreaElement>('textarea.tx-fu-text')!;
    box.value = 'pw=hunter2';
    box.dispatchEvent(new Event('input'));
    const release = h.hold();
    first.el.querySelector<HTMLButtonElement>('.tx-ask-send')!.click();
    await flush();
    expect(h.scanned).toEqual(['pw=hunter2']);
    h.tx.stand();
    first.destroy();
    release();
    await flush();
    expect(h.reviews).toEqual([]);
    expect(h.others.filter((x) => x.t === 'worker.answer_followup')).toEqual([]);
    h.tx.sit('a', 'Ada', true, 'claude');
    await flush();
    const next = card(h.host());
    next.set(fu);
    expect(next.el.querySelector<HTMLTextAreaElement>('textarea.tx-fu-text')!.value).toBe('pw=hunter2');
    next.destroy();
  });

  it('a prompt refused as stale, stood up while it is scanned again: sent once, no review opens', async () => {
    const h = await harness();
    const sent = h.host().onPromptSubmit(TEXT);
    await flush();
    const review = h.reviews[0]!.req.review;
    h.reviews[0]!.answer({ kind: 'confirm', review });
    await flush();
    expect(h.prompts).toHaveLength(1);
    const release = h.hold();
    h.prompts[0]!.resolve({ ok: false, code: 'secrets_review_stale', message: 'stale' });
    await flush();
    h.tx.stand();
    release();
    await expect(sent).resolves.toBe(false);
    expect(h.reviews).toHaveLength(1);
    expect(h.prompts).toHaveLength(1);
  });
});
