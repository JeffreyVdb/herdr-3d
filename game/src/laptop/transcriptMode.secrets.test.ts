import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import { PromptSecretsBook } from '../world/promptSecrets';
import type { PackupOutcome } from '../world/packup';
import { PromptSecretsFlow } from '../ui/secretsFlow';
import type { SecretsReviewOutcome, SecretsReviewRequest } from '../ui/secretsReview';
import { TranscriptMode, type MountTranscript, type TranscriptRenderHost } from './transcriptMode';
import type { PendingPrompt } from './transcriptActivity';

// #108: the laptop's prompt box with "Review prompt secrets before sending": the review before anything goes, the pending
// row never showing a protected value, pack up skipped for a protected prompt, drafts in memory only.

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

async function harness(o: { on?: boolean; scans?: CommandResult[] } = {}) {
  const storage = new MemStorage();
  const book = new PromptSecretsBook();
  book.reset({ enabled: o.on ?? true, available: true });
  const scans = [...(o.scans ?? [])];
  const scanned: string[] = [];
  const reviews: Array<{ req: SecretsReviewRequest; answer(x: SecretsReviewOutcome): void }> = [];
  const flow = new PromptSecretsFlow({
    book,
    unsupported: () => false,
    send: (_t, args) => (scanned.push(args.text), Promise.resolve(scans.shift() ?? { ok: true, data: SCAN })),
    review: (req) => new Promise((answer) => reviews.push({ req, answer })),
  });
  const prompts: Array<{ args: Record<string, unknown>; resolve(r: CommandResult): void }> = [];
  const status: Array<[string, string | null]> = [];
  const packups: string[] = [];
  const pending: Array<readonly PendingPrompt[]> = [];
  let host: TranscriptRenderHost | null = null;
  const mount: MountTranscript = (_box, h) => {
    host = h;
    return { setItems() {}, applyUpdates() {}, setBlocked() {}, setAsk() {}, setFollowup() {}, setCodex() {}, setUsage() {}, setActivity() {}, setPending: (rows: readonly PendingPrompt[]) => pending.push(rows), attachTabs() {}, hasItem: () => false, scrollToItem: () => false, focus() {}, focusPrompt() {}, destroy() {} } as never;
  };
  const tx = new TranscriptMode({
    feed: () => null,
    send: ((t: string, args: Record<string, unknown>) => (t === 'worker.prompt' ? new Promise((resolve) => prompts.push({ args, resolve })) : Promise.resolve({ ok: true, data: {} }))) as never,
    renderer: () => Promise.resolve(mount),
    overlay: () => ({ hidden: false, style: {}, remove() {}, focus() {} }) as unknown as HTMLElement,
    storage: storage as unknown as Storage,
    status: (kind, text) => status.push([kind, text]),
    modeChanged: () => {},
    packup: (_id: string, text: string) => (packups.push(text), Promise.resolve<PackupOutcome>('send')),
    secrets: flow,
  });
  tx.sit('a', 'Ada', true, 'claude');
  await flush();
  return { tx, book, storage, scanned, reviews, prompts, status, packups, pending, host: () => host as unknown as TranscriptRenderHost };
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
    expect(h.prompts.map((p) => p.args)).toEqual([{ id: 'a', text: TEXT, secrets: { revision: 'rev-1', decisions: [{ candidate: 'c1', action: 'protect', ...at('ghp_abc123') }, { candidate: 'c2', action: 'ignore' }] } }]);
    expect(h.packups).toEqual([]);
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
});
