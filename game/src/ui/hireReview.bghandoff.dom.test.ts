// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../net/client';
import type { AgentHandoff, HandoffCandidate, HandoffHire, HireInterpretation, HirePrepare, Worker } from '../net/protocol';
import { hireWithHandoffTask } from '../world/handoff';
import { HandoffHireBook } from '../world/handoffHire';
import { fromHandoff } from '../world/hireReview';
import { CAT } from '../world/hireReviewFixtures';
import type { HandoffPlan } from './handoffFiling';
import type { Draft as PromptDraft } from './composer/draft';
import { HandoffHireAnnouncer, ORPHAN_WAIT_MS } from './handoffHires';
import type { HireHost } from './hire';
import { SPAWNED_TEXT } from './hireCoordinator';
import { HireReviewDialog } from './hireReview';
import { HirePrefs } from './hirePrefs';
import type { PromptSecretsFlow } from './secretsFlow';

// #219: "Hire with handoff" with a bridge that hires once it is filed (`world.handoff_hires`): the review sends one
// `worker.handoff` with `hire` (its task reviewed first), closes on the ack with Hire in background on, offers Continue
// in background with it off, follows the op's record while open, cancels both with Cancel request, and gives the task
// back through the announcer when it was closed. It never sends `worker.hire` for it.

const CAND: HandoffCandidate = { id: 'cand-1', session: 'sess', revision: 'rev-1', harness: 'claude', message: 'msg_1', source: 'message', bytes: 300 };
const PATH = '/home/u/handoff/floor/20261027-1600-pixel-loader.md';
const TASK = 'Fix the issue\n\n- keep the tests green';
/** B-R6: the status line of a request that got no answer (it is asked again until the bridge says). */
const UNANSWERED = 'No answer from herdr-world yet: it may have taken the request. Asking it again until it says… then Nibble is hired at Desk 2.';
const INTERP: HireInterpretation = { sources: [], harness: { provenance: 'missing' }, model: { provenance: 'missing' }, effort: { provenance: 'missing' }, task: { provenance: 'missing' }, questions: [], ready_for_review: true };

const prep = (capacity: HirePrepare['capacity'] = { floor: { count: 1, soft: 10, hard: 20 }, host: { count: 1, soft: 10, hard: 20 } }): HirePrepare => ({
  cwd: '/w/pixel',
  label: 'Nibble',
  git: null,
  choice: { harness: 'codex', model: 'gpt-6-luna', effort: 'high' },
  choice_source: 'floor_default',
  capacity,
});

const flush = async () => {
  for (let n = 0; n < 30; n++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

interface Pending {
  t: string;
  args: Record<string, unknown>;
  answer: (r: CommandResult) => void;
  done?: boolean;
}

function setup(o: { background?: boolean; secrets?: PromptSecretsFlow; known?: boolean; capacity?: HirePrepare['capacity'] } = {}) {
  const seats: Array<{ name: string } | null> = Array(6).fill(null);
  seats[0] = { name: 'Pixel' };
  const held = new Set<number>();
  const sent: Pending[] = [];
  const toasts: Array<{ text: string; kind: string }> = [];
  const uploads: Array<{ label: string; answer(r: CommandResult): void }> = [];
  const goTos: string[] = [];
  const holds: Array<[string, string]> = [];
  let beeps = 0;
  const prefs = new HirePrefs(null);
  prefs.hireInBackground = o.background === true;
  const source: Worker = { id: 'A', session: 'floor', workspace_id: 'w', label: 'pixel', status: 'idle', handoff: CAND } as Worker;
  const workers = new Map<string, Worker>([['A', source]]);
  const book = new HandoffHireBook();
  if (o.known !== false) book.reset([]);
  const store = {
    floorName: (id: string) => id,
    hireOptions: CAT,
    floorView: () => ({ seats, asleep: false, transition: null, level: { number: 2, count: 3 }, building: { name: 'HQ' } }),
    limits: { version: 0, list: () => [] },
    workerView: (id: string) => (id === 'N' ? { name: 'Nibble', desk: 1 } : null),
    workers,
    handoffHires: book,
  };
  const timers: Array<() => void> = [];
  /** The review's own timers (B-R6: the replay of a request that got no answer, after a while). */
  const retries: Array<() => void> = [];
  const announcer = new HandoffHireAnnouncer({
    records: () => book.all(),
    toast: (text, kind) => void toasts.push({ text, kind }),
    beep: () => void beeps++,
    floorName: (id) => id,
    workerView: (id) => store.workerView(id),
    holdTask: (id, text) => (holds.push([id, text]), true),
    storage: localStorage,
    later: (fn) => void timers.push(fn),
  });
  const host = {
    store,
    send: (t: string, args: Record<string, unknown>) => {
      if (t === 'hire.prepare') return Promise.resolve({ ok: true, data: prep(o.capacity) } as CommandResult);
      return new Promise<CommandResult>((answer) => sent.push({ t, args, answer }));
    },
    upload: (_file: Blob, hint: { label: string }) => new Promise<CommandResult>((answer) => uploads.push({ label: hint.label, answer })),
    unsupported: () => false,
    reserve: (_s: string, d: number) => {
      held.add(d);
      return () => held.delete(d);
    },
    held: () => held,
    toast: (text: string, kind: string) => void toasts.push({ text, kind }),
    goTo: (id: string) => void goTos.push(id),
    beep: () => void beeps++,
    holdTask: (id: string, text: string) => (holds.push([id, text]), true),
    hirePrefs: prefs,
    handoffHires: announcer,
    later: (fn: () => void) => void retries.push(fn),
    now: () => Date.now(),
    ...(o.secrets ? { secrets: o.secrets } : {}),
  } as unknown as HireHost;
  const rv = new HireReviewDialog(document.body, host);
  const draft = () => (rv as unknown as { composer: { getDraft(): PromptDraft } }).composer.getDraft();
  const of = (t: string) => sent.filter((s) => s.t === t);
  const last = (t: string) => of(t).at(-1)!;
  const answer = async (t: string, r: CommandResult) => {
    const p = sent.find((s) => s.t === t && !s.done)!;
    p.done = true;
    p.answer(r);
    await flush();
  };
  /** A record from the bridge: the store, then the app's two listeners (the review, the announcer). */
  const record = async (r: Partial<HandoffHire> & { op: string }) => {
    book.upsert({ worker: 'A', worker_name: 'Pixel', mode: 'agent', floor: 'floor', desk_index: 1, harness: 'claude', model: 'claude-opus-5-5', effort: 'high', origin: announcer.origin, state: 'waiting', started_at: 1, ...r });
    rv.refresh();
    announcer.sync();
    await flush();
  };
  const open = async (plan: Partial<HandoffPlan> = {}) => {
    const seed = fromHandoff({ harness: 'claude', model: 'claude-opus-5-5' }, TASK, CAT);
    const p: HandoffPlan = { worker: 'A', name: 'Pixel', floorName: 'floor', mode: 'agent', candidate: null, instruction: 'focus on the tests', sendHome: false, ...plan };
    expect(rv.open('floor', INTERP, 1, { choice: { ...seed, origin: { ...seed.origin, task: 'chosen' } }, cwd: '/w/pixel', handoff: p })).toBe(true);
    await flush();
  };
  /** Opens, picks the effort, presses File handoff and hire: the request is on its way. */
  const submit = async (plan: Partial<HandoffPlan> = {}) => {
    await open(plan);
    q<HTMLInputElement>('[data-key="effort:high"]')!.click();
    q<HTMLButtonElement>('[data-key="hire"]')!.click();
    await flush();
    const ask = last('worker.handoff');
    return { op: String(ask.args.op), ask };
  };
  const accept = async (op: string, kind: 'agent' | 'llm' = 'agent') => {
    const rec: HandoffHire = { op, worker: 'A', worker_name: 'Pixel', mode: kind, floor: 'floor', desk_index: 1, harness: 'claude', model: 'claude-opus-5-5', effort: 'high', origin: announcer.origin, state: 'waiting', started_at: 1 };
    book.upsert(rec);
    const data = kind === 'agent' ? { request: { op, state: 'pending', started_at: 0 } as AgentHandoff, handoff_hire: rec } : { job: { op, state: 'running', started_at: 0, updated_at: 0 }, handoff_hire: rec };
    await answer('worker.handoff', { ok: true, data } as CommandResult);
  };
  /** A reconnect's snapshot: the store's records as the bridge has them, then the app's two listeners. */
  const snapshot = async (list: HandoffHire[] = []) => {
    book.reset(list);
    rv.refresh();
    announcer.sync();
    await flush();
  };
  const flushTimers = () => {
    while (timers.length) timers.shift()?.();
  };
  /** The review's waits run out (a replay of a request that got no answer goes). */
  const retry = async () => {
    while (retries.length) retries.shift()?.();
    await flush();
  };
  return { retry, retries, rv, sent, of, last, answer, record, open, submit, accept, toasts, goTos, holds, beeps: () => beeps, announcer, book, held, flushTimers, uploads, draft, workers, snapshot };
}

const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const png = () => new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
/** The floor at its hard cap (20 of 20), the host not. */
const FULL_FLOOR: HirePrepare['capacity'] = { floor: { count: 20, soft: 10, hard: 20 }, host: { count: 20, soft: 30, hard: 40 } };

describe('HireReviewDialog: hire with handoff in the background (#219)', () => {
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

  it('one request carries the hire (the task without the path line); background on, it closes on the ack; filed → hired once', async () => {
    const e = setup({ background: true });
    const { op, ask } = await e.submit();
    expect(ask.args).toMatchObject({ worker: 'A', mode: 'agent', instruction: 'focus on the tests', op });
    expect(ask.args.hire).toEqual({ floor: 'floor', desk_index: 1, harness: 'claude', model: 'claude-opus-5-5', effort: 'high', label: 'Nibble', cwd: '/w/pixel', prompt: TASK, origin: e.announcer.origin });
    expect(e.rv.isOpen).toBe(true);
    expect(e.rv.summary()?.handoff?.bridge).toEqual({ op, accepted: false });
    await e.accept(op);
    expect(e.rv.isOpen).toBe(false);
    expect(e.toasts).toEqual([{ text: 'Writing Pixel’s handoff. Nibble is hired at Desk 2 once it is filed.', kind: 'info' }]);
    // You play on; the bridge files and hires.
    await e.record({ op, state: 'hiring', path: PATH, handoff: 7 });
    expect(e.toasts).toHaveLength(1);
    await e.record({ op, state: 'hired', path: PATH, handoff: 7, hired: 'N', prompted: true });
    // A repeated update, a reconnect's snapshot: said once.
    await e.record({ op, state: 'hired', path: PATH, handoff: 7, hired: 'N', prompted: true });
    e.announcer.sync();
    expect(e.toasts.slice(1)).toEqual([{ text: SPAWNED_TEXT, kind: 'info' }]);
    expect(e.beeps()).toBe(1);
    expect(e.of('worker.hire')).toHaveLength(0);
    expect(e.of('handoff.get')).toHaveLength(0);
  });

  it('background off: progress, Continue in background (Close and Esc the same), Cancel request; closing leaves the hire running', async () => {
    const e = setup();
    const { op } = await e.submit();
    await e.accept(op);
    expect(e.rv.isOpen).toBe(true);
    expect(e.rv.summary()).toMatchObject({ state: 'filing', status: 'Asking Pixel’s agent… it is filed once its turn ends with the handoff written; then Nibble is hired at Desk 2.' });
    const cont = q<HTMLButtonElement>('[data-key="background"]')!;
    expect(cont.textContent).toBe('Continue in background');
    expect(cont.title).toBe('Closes this review; Nibble is still hired at Desk 2 once the handoff is filed');
    expect(q<HTMLButtonElement>('[data-key="cancel-request"]')!.disabled).toBe(false);
    expect(q('[data-key="cancel"]')).toBeNull();
    await e.record({ op, state: 'hiring', path: PATH });
    expect(e.rv.summary()?.status).toBe(`Filed ${PATH}. Hiring Nibble at Desk 2…`);
    cont.click();
    expect(e.rv.isOpen).toBe(false);
    expect(e.toasts).toEqual([{ text: 'Writing Pixel’s handoff. Nibble is hired at Desk 2 once it is filed.', kind: 'info' }]);
    await e.record({ op, state: 'hired', path: PATH, hired: 'N', prompted: true });
    expect(e.toasts.at(-1)).toEqual({ text: SPAWNED_TEXT, kind: 'info' });
    expect(e.of('worker.hire')).toHaveLength(0);
  });

  it('background off, Esc while it waits: the same as Continue in background', async () => {
    const e = setup();
    const { op } = await e.submit();
    await e.accept(op);
    q('dialog')!.dispatchEvent(new Event('cancel'));
    e.rv.close();
    expect(e.toasts.map((t) => t.text)).toEqual(['Writing Pixel’s handoff. Nibble is hired at Desk 2 once it is filed.']);
    expect(e.of('worker.handoff_cancel')).toHaveLength(0);
  });

  it('ended while open: hired closes the review and goes to the worker; the announcer stays quiet', async () => {
    const e = setup();
    const { op } = await e.submit();
    await e.accept(op);
    await e.record({ op, state: 'hired', path: PATH, hired: 'N', prompted: true });
    expect(e.rv.isOpen).toBe(false);
    expect(e.goTos).toEqual(['N']);
    expect(e.toasts).toEqual([{ text: 'Hired Nibble at Desk 2. Here they come.', kind: 'info' }]);
    e.flushTimers();
    e.announcer.sync();
    expect(e.toasts).toHaveLength(1);
    expect(e.beeps()).toBe(0);
  });

  it('filed, not hired, while open: the task stays with the path; Hire again hires only (the client’s worker.hire, once)', async () => {
    const e = setup();
    const { op } = await e.submit();
    await e.accept(op);
    await e.record({ op, state: 'failed', code: 'desk_taken', reason: 'Desk 2 of floor was taken while the handoff was written.', path: PATH, handoff: 7 });
    expect(e.rv.isOpen).toBe(true);
    expect(e.rv.summary()).toMatchObject({ state: 'ready', error: true, status: `The handoff is saved at ${PATH}. Desk 2 of floor was taken while the handoff was written. Nobody was hired. Hire again hires only: the handoff is not made again.` });
    expect(e.rv.summary()?.handoff?.filed).toBe(PATH);
    expect(q<HTMLButtonElement>('[data-key="hire"]')!.textContent).toBe('Hire Nibble');
    q<HTMLButtonElement>('[data-key="hire"]')!.click();
    await flush();
    expect(e.of('worker.handoff')).toHaveLength(1);
    expect(e.of('worker.hire')).toHaveLength(1);
    expect(e.last('worker.hire').args.prompt).toBe(hireWithHandoffTask(PATH, TASK));
    expect(e.last('worker.hire').args).not.toHaveProperty('origin');
  });

  it('the handoff failed while open: nobody hired, the task and settings stay; the next press is a new request', async () => {
    const e = setup();
    const { op } = await e.submit();
    await e.accept(op);
    await e.record({ op, state: 'failed', code: 'handoff_failed', reason: 'Pixel’s agent handoff was not filed: a person took over.' });
    expect(e.rv.summary()).toMatchObject({ state: 'ready', status: 'Pixel’s agent handoff was not filed: a person took over. Nobody was hired. Your task and settings are still here.' });
    expect(e.rv.summary()?.form.prompt).toBe(TASK);
    q<HTMLButtonElement>('[data-key="hire"]')!.click();
    await flush();
    expect(e.of('worker.handoff')).toHaveLength(2);
    expect(e.last('worker.handoff').args.op).not.toBe(op);
  });

  it('Cancel request cancels the request and the hire together; the record says it, nobody is hired', async () => {
    const e = setup();
    const { op } = await e.submit();
    await e.accept(op);
    q<HTMLButtonElement>('[data-key="cancel-request"]')!.click();
    await flush();
    expect(e.last('worker.handoff_cancel').args).toEqual({ worker: 'A', op });
    await e.record({ op, state: 'cancelled', code: 'cancelled', reason: 'Cancelled: nothing was filed and nobody was hired.' });
    await e.answer('worker.handoff_cancel', { ok: true, data: { op, state: 'failed', reason: 'cancelled', started_at: 0 } } as CommandResult);
    expect(e.rv.summary()).toMatchObject({ state: 'ready', error: true, status: 'Cancelled: nothing was filed and nobody was hired. Your task and settings are still here.' });
    expect(e.of('worker.hire')).toHaveLength(0);
  });

  it('Cancel request refused once filing began: the hire still follows, and the review says so', async () => {
    const e = setup();
    const { op } = await e.submit();
    await e.accept(op);
    q<HTMLButtonElement>('[data-key="cancel-request"]')!.click();
    await flush();
    await e.answer('worker.handoff_cancel', { ok: false, code: 'busy', message: 'busy: it is being filed' });
    expect(e.rv.summary()?.status).toContain('It is being filed already; Nibble is hired at Desk 2 once it is.');
    expect(e.rv.summary()?.state).toBe('filing');
  });

  it('closed, then it fails: the task and settings come back through the give-back, with the reason (and the path)', async () => {
    const e = setup();
    const { op } = await e.submit();
    await e.accept(op);
    q<HTMLButtonElement>('[data-key="background"]')!.click();
    await e.record({ op, state: 'failed', code: 'desk_taken', reason: 'Desk 2 of floor was taken while the handoff was written.', path: PATH, handoff: 7 });
    // Nothing else open: the review opens again with the task, and the path for a hire-only retry.
    expect(e.rv.isOpen).toBe(true);
    const s = e.rv.summary()!;
    expect(s.form.prompt).toBe(TASK);
    expect(s.handoff?.filed).toBe(PATH);
    expect(s.status).toContain(`The handoff is saved at ${PATH}. Desk 2 of floor was taken while the handoff was written. Nobody was hired.`);
    expect(s.status).toContain('Hire again hires only: the handoff is not made again.');
    // Said once.
    e.rv.close();
    await e.record({ op, state: 'failed', code: 'desk_taken', reason: 'x', path: PATH });
    e.flushTimers();
    expect(e.rv.isOpen).toBe(false);
  });

  it('closed, then cancelled from the F dialog while another dialog is open: held behind Review again', async () => {
    const e = setup();
    const { op } = await e.submit();
    await e.accept(op);
    e.rv.close();
    const other = document.createElement('dialog');
    other.setAttribute('open', '');
    document.body.append(other);
    await e.record({ op, state: 'cancelled', code: 'cancelled', reason: 'Cancelled: nothing was filed and nobody was hired.' });
    expect(e.rv.isOpen).toBe(false);
    expect(e.toasts.at(-1)?.text).toBe('Cancelled: nothing was filed and nobody was hired. Your task and settings are kept. The task is kept: review it again here or from the command palette.');
    expect(e.rv.heldReviews()).toHaveLength(1);
    other.remove();
    expect(e.rv.reopenHeld(e.rv.heldReviews()[0]!.id)).toBe(true);
    expect(e.rv.summary()?.form.prompt).toBe(TASK);
    expect(e.rv.summary()?.handoff?.filed).toBeNull();
  });

  it('#108: the task is reviewed before anything is sent, apart from the instruction; a stale task review is reviewed again', async () => {
    const texts: string[] = [];
    let n = 0;
    const flow = {
      on: true,
      onChange: () => {},
      review: async (r: { text: string }) => (texts.push(r.text), { kind: 'send', protects: 1, shown: r.text, review: null, secrets: { revision: `rev-${++n}`, decisions: [] } }),
      deliver: async (req: { text: string }, go: { secrets?: unknown }, send: (g: unknown) => Promise<CommandResult>) => {
        let g = go;
        for (;;) {
          const r = await send(g);
          if (r.ok || r.code !== 'secrets_review_stale') return { kind: 'answered', result: r, go: g };
          texts.push(`again:${req.text}`);
          g = { ...g, secrets: { revision: `rev-${++n}`, decisions: [] } };
        }
      },
    } as unknown as PromptSecretsFlow;
    const e = setup({ secrets: flow, background: true });
    const { op, ask } = await e.submit();
    // The task (as typed, no path line) first, then the instruction: two reviews, two `secrets`.
    expect(texts).toEqual([TASK, 'focus on the tests']);
    expect(ask.args.secrets).toEqual({ revision: 'rev-2', decisions: [] });
    expect((ask.args.hire as Record<string, unknown>).secrets).toEqual({ revision: 'rev-1', decisions: [] });
    await e.answer('worker.handoff', { ok: false, code: 'secrets_review_stale', message: 'hire.prompt: secrets review: review it again' });
    expect(texts).toEqual([TASK, 'focus on the tests', `again:${TASK}`]);
    const again = e.last('worker.handoff');
    expect(again.args.op).toBe(op);
    expect((again.args.hire as Record<string, unknown>).secrets).toEqual({ revision: 'rev-3', decisions: [] });
    expect(again.args.secrets).toEqual({ revision: 'rev-2', decisions: [] });
    await e.accept(op);
    expect(e.rv.isOpen).toBe(false);
  });

  it('LLM: the job’s ack carries the record; it is followed the same way', async () => {
    const e = setup();
    const { op, ask } = await e.submit({ mode: 'llm', candidate: CAND, llmModel: 'gpt-x' });
    expect(ask.args).toMatchObject({ mode: 'llm', session: 'sess', candidate: 'cand-1', revision: 'rev-1', hire: { prompt: TASK } });
    await e.accept(op, 'llm');
    expect(e.rv.summary()?.status).toBe('The LLM (gpt-x) is writing the handoff… then Nibble is hired at Desk 2.');
    await e.record({ op, mode: 'llm', state: 'hired', path: PATH, hired: 'N', prompted: true });
    expect(e.rv.isOpen).toBe(false);
  });

  it('refused at the accept: nobody hired, the task stays; a request that got no answer is reconciled from the world', async () => {
    const e = setup();
    const { op } = await e.submit();
    await e.answer('worker.handoff', { ok: false, code: 'desk_taken', message: 'Desk 2 is held for Mochi’s handoff hire.' });
    expect(e.rv.summary()).toMatchObject({ state: 'ready', error: true });
    expect(e.rv.summary()?.status).toContain('Nobody was hired.');
    q<HTMLButtonElement>('[data-key="hire"]')!.click();
    await flush();
    const op2 = String(e.last('worker.handoff').args.op);
    expect(op2).not.toBe(op);
    // No answer, but the bridge took it: its record is in the world.
    await e.record({ op: op2 });
    await e.answer('worker.handoff', { ok: false, code: 'timeout', message: 'timeout' });
    expect(e.rv.summary()).toMatchObject({ state: 'filing', handoff: { bridge: { op: op2, accepted: true } } });
  });

  it('without the bridge’s handoff_hires: the #198 flow (no hire on the request)', async () => {
    const e = setup({ known: false });
    await e.submit();
    expect(e.last('worker.handoff').args).not.toHaveProperty('hire');
  });

  it('after a reload: the outcome is a toast with the reason and path, once; never a hire', async () => {
    const e = setup();
    await e.record({ op: 'ho-old', state: 'failed', code: 'desk_taken', reason: 'Desk 2 of floor was taken.', path: PATH });
    expect(e.toasts).toEqual([]);
    e.flushTimers();
    expect(e.toasts).toEqual([{ text: `Desk 2 of floor · Desk 2 of floor was taken. Pixel’s handoff is saved at ${PATH}: hire from it in the cabinet.`, kind: 'error' }]);
    expect(e.rv.isOpen).toBe(false);
    expect(ORPHAN_WAIT_MS).toBeGreaterThan(0);
    expect(e.sent).toEqual([]);
  });
  it('B-R2: not prompted while open: their Prompt note gets the task as it was sent (the image’s Drop Zone path), not the editor’s placeholder', async () => {
    const e = setup();
    await e.open();
    q<HTMLInputElement>('[data-key="effort:high"]')!.click();
    e.draft().addImages([png()]);
    expect(e.rv.summary()!.form.prompt).toBe(`${TASK}[Image #1]`);
    q<HTMLButtonElement>('[data-key="hire"]')!.click();
    await flush();
    e.uploads[0]!.answer({ ok: true, data: { path: '/drop/h3d-Nibble-1.png' } } as CommandResult);
    await flush();
    await flush();
    const ask = e.last('worker.handoff');
    const sentTask = String((ask.args.hire as Record<string, unknown>).prompt);
    expect(sentTask).toContain('/drop/h3d-Nibble-1.png');
    expect(sentTask).not.toContain('[Image #1]');
    const op = String(ask.args.op);
    await e.accept(op);
    await e.record({ op, state: 'hired', path: PATH, hired: 'N', prompted: false, prompt_error: 'the pane was busy' });
    expect(e.rv.isOpen).toBe(false);
    expect(e.holds).toEqual([['N', hireWithHandoffTask(PATH, sentTask)]]);
    expect(e.toasts.at(-1)?.text).toContain('the task is in their prompt');
  });

  it('B-R1: with Send home after filing, the source leaving frees its place: a full floor does not block the bridge’s hire', async () => {
    const e = setup({ capacity: FULL_FLOOR });
    await e.open({ sendHome: true });
    q<HTMLInputElement>('[data-key="effort:high"]')!.click();
    expect(e.rv.summary()!.blocker).toBeNull();
    q<HTMLButtonElement>('[data-key="hire"]')!.click();
    await flush();
    expect(e.last('worker.handoff').args).toMatchObject({ send_home: true, hire: { desk_index: 1 } });
  });

  it('B-R1: the source on another floor frees a host place only; without send home, or without the bridge’s hire (#198), the cap blocks', async () => {
    const other = setup({ capacity: FULL_FLOOR });
    other.workers.set('A', { ...other.workers.get('A')!, session: 'elsewhere' } as Worker);
    await other.open({ sendHome: true });
    q<HTMLInputElement>('[data-key="effort:high"]')!.click();
    expect(other.rv.summary()!.blocker).toBe('Over the hard cap: send someone home first.');
    other.rv.close();
    document.body.replaceChildren();
    const stays = setup({ capacity: FULL_FLOOR });
    await stays.open({ sendHome: false });
    q<HTMLInputElement>('[data-key="effort:high"]')!.click();
    expect(stays.rv.summary()!.blocker).toBe('Over the hard cap: send someone home first.');
    stays.rv.close();
    document.body.replaceChildren();
    const old = setup({ capacity: FULL_FLOOR, known: false });
    await old.open({ sendHome: true });
    q<HTMLInputElement>('[data-key="effort:high"]')!.click();
    expect(old.rv.summary()!.blocker).toBe('Over the hard cap: send someone home first.');
  });
  it('B-R3: no answer, its record later: the review keeps following the op (progress, Cancel request), never a second request', async () => {
    const e = setup();
    const { op } = await e.submit();
    await e.answer('worker.handoff', { ok: false, code: 'timeout', message: 'herdr-world did not answer worker.handoff within 30 s' });
    const s = e.rv.summary()!;
    expect(s).toMatchObject({ state: 'filing', error: false, handoff: { op, bridge: { op, accepted: false } } });
    expect(s.status).toBe(UNANSWERED);
    expect(s.status).not.toMatch(/nobody was hired|not hired/i);
    expect(q<HTMLButtonElement>('[data-key="cancel-request"]')!.disabled).toBe(false);
    q<HTMLButtonElement>('[data-key="hire"]')!.click();
    await flush();
    expect(e.of('worker.handoff')).toHaveLength(1);
    // The bridge took it after all: its record comes, and how it ends is said here.
    await e.record({ op });
    expect(e.rv.summary()).toMatchObject({ state: 'filing', handoff: { bridge: { op, accepted: true } } });
    await e.record({ op, state: 'hired', path: PATH, hired: 'N', prompted: true });
    expect(e.rv.isOpen).toBe(false);
    expect(e.toasts).toEqual([{ text: 'Hired Nibble at Desk 2. Here they come.', kind: 'info' }]);
    e.flushTimers();
    e.announcer.sync();
    expect(e.toasts).toHaveLength(1);
    expect(e.of('worker.hire')).toHaveLength(0);
  });

  // B-R6: the bridge reviews a request's secrets off its hub before it starts it, so neither a snapshot without the op
  // nor Cancel request's `invalid_state` says it was never taken. Only the bridge's answer to the same request does.
  it('B-R6: no answer, a snapshot without the op, then its waiting record: the review follows it', async () => {
    const e = setup();
    const { op } = await e.submit();
    await e.answer('worker.handoff', { ok: false, code: 'disconnected', message: 'the connection to herdr-world closed' });
    await e.snapshot([]);
    expect(e.rv.summary()).toMatchObject({ state: 'filing', error: false, handoff: { op, bridge: { op, accepted: false } } });
    expect(e.rv.summary()?.status).toBe(UNANSWERED);
    expect(q<HTMLButtonElement>('[data-key="cancel-request"]')!.disabled).toBe(false);
    // The gate let it through: its record comes, and the review follows it to the end.
    await e.record({ op });
    expect(e.rv.summary()).toMatchObject({ state: 'filing', handoff: { bridge: { op, accepted: true } } });
    await e.record({ op, state: 'hired', path: PATH, hired: 'N', prompted: true });
    expect(e.rv.isOpen).toBe(false);
    expect(e.toasts).toEqual([{ text: 'Hired Nibble at Desk 2. Here they come.', kind: 'info' }]);
    // Known now: nothing is asked again.
    await e.retry();
    expect(e.of('worker.handoff')).toHaveLength(1);
    expect(e.of('worker.hire')).toHaveLength(0);
  });

  it('B-R6: the request is asked again with the same op and the very args that went (its reviews’ decisions too), never reviewed again', async () => {
    const texts: string[] = [];
    let n = 0;
    const flow = {
      on: true,
      onChange: () => {},
      review: async (r: { text: string }) => (texts.push(r.text), { kind: 'send', protects: 1, shown: r.text, review: null, secrets: { revision: `rev-${++n}`, decisions: [] } }),
      deliver: async (req: { text: string }, go: { secrets?: unknown }, send: (g: unknown) => Promise<CommandResult>) => {
        let g = go;
        for (;;) {
          const r = await send(g);
          if (r.ok || r.code !== 'secrets_review_stale') return { kind: 'answered', result: r, go: g };
          texts.push(`again:${req.text}`);
          g = { ...g, secrets: { revision: `rev-${++n}`, decisions: [] } };
        }
      },
    } as unknown as PromptSecretsFlow;
    const e = setup({ secrets: flow });
    const { op } = await e.submit();
    await e.answer('worker.handoff', { ok: false, code: 'secrets_review_stale', message: 'hire.prompt: secrets review: review it again' });
    const went = e.last('worker.handoff').args;
    await e.answer('worker.handoff', { ok: false, code: 'timeout', message: 'timeout' });
    expect(e.of('worker.handoff')).toHaveLength(2);
    await e.retry();
    expect(e.of('worker.handoff')).toHaveLength(3);
    expect(e.last('worker.handoff').args).toEqual(went);
    expect(e.last('worker.handoff').args.op).toBe(op);
    expect(texts).toEqual([TASK, 'focus on the tests', `again:${TASK}`]);
    // The bridge has it (it answers the same request with its request and record): followed.
    await e.accept(op);
    expect(e.rv.summary()).toMatchObject({ state: 'filing', error: false, handoff: { bridge: { op, accepted: true } } });
    expect(e.rv.summary()?.status).toBe('Asking Pixel’s agent… it is filed once its turn ends with the handoff written; then Nibble is hired at Desk 2.');
    await e.record({ op, state: 'hired', path: PATH, hired: 'N', prompted: true });
    expect(e.rv.isOpen).toBe(false);
    await e.retry();
    expect(e.of('worker.handoff')).toHaveLength(3);
  });

  it('B-R6: asked again and refused: nothing was taken, said with the bridge’s reason; the task stays', async () => {
    const e = setup();
    const { op } = await e.submit();
    await e.answer('worker.handoff', { ok: false, code: 'timeout', message: 'timeout' });
    await e.snapshot([]);
    await e.retry();
    expect(e.of('worker.handoff')).toHaveLength(2);
    await e.answer('worker.handoff', { ok: false, code: 'capacity', message: 'the floor is full' });
    const s = e.rv.summary()!;
    expect(s).toMatchObject({ state: 'ready', error: true });
    expect(s.status).toBe('Over the hard cap: the floor is full. Send someone home first. Nothing was filed and nobody was hired. Your task and settings are still here.');
    expect(s.form.prompt).toBe(TASK);
    await e.retry();
    expect(e.of('worker.handoff')).toHaveLength(2);
    // Hire sends it again, with the same op (the bridge never had it).
    q<HTMLButtonElement>('[data-key="hire"]')!.click();
    await flush();
    expect(e.of('worker.handoff')).toHaveLength(3);
    expect(e.last('worker.handoff').args.op).toBe(op);
  });

  it('B-R6: asked again and told it went with other settings: the bridge has the op, so it is followed, never "not taken"', async () => {
    const e = setup();
    const { op } = await e.submit();
    await e.answer('worker.handoff', { ok: false, code: 'timeout', message: 'timeout' });
    await e.retry();
    await e.answer('worker.handoff', { ok: false, code: 'bad_request', message: 'bad args: This request was already sent with other settings.' });
    expect(e.rv.summary()).toMatchObject({ state: 'filing', error: false, handoff: { bridge: { op, accepted: true } } });
    await e.record({ op, state: 'hired', path: PATH, hired: 'N', prompted: true });
    expect(e.rv.isOpen).toBe(false);
    expect(e.toasts).toEqual([{ text: 'Hired Nibble at Desk 2. Here they come.', kind: 'info' }]);
  });

  it('B-R6: asked again without an answer: asked once more on the next connection or after a while, one at a time, same op', async () => {
    const e = setup();
    const { op } = await e.submit();
    await e.answer('worker.handoff', { ok: false, code: 'disconnected', message: 'closed' });
    // Still connecting: not sent.
    await e.retry();
    await e.answer('worker.handoff', { ok: false, code: 'offline', message: 'not connected to herdr-world' });
    expect(e.rv.summary()).toMatchObject({ state: 'filing', error: false });
    expect(e.rv.summary()?.status).toBe(UNANSWERED);
    // Connected again: asked at once; a second connection meanwhile asks nothing more while one is on its way.
    e.rv.online();
    e.rv.online();
    await flush();
    expect(e.of('worker.handoff')).toHaveLength(3);
    await e.answer('worker.handoff', { ok: false, code: 'timeout', message: 'timeout' });
    expect(e.rv.summary()).toMatchObject({ state: 'filing', error: false });
    await e.retry();
    expect(e.of('worker.handoff')).toHaveLength(4);
    expect(new Set(e.of('worker.handoff').map((s) => s.args.op))).toEqual(new Set([op]));
    await e.accept(op);
    expect(e.rv.summary()).toMatchObject({ state: 'filing', handoff: { bridge: { op, accepted: true } } });
  });

  it('B-R6: Cancel request answered invalid_state: still unknown; asked again, and cancelled once the bridge has it', async () => {
    const e = setup();
    const { op } = await e.submit();
    await e.answer('worker.handoff', { ok: false, code: 'timeout', message: 'timeout' });
    q<HTMLButtonElement>('[data-key="cancel-request"]')!.click();
    await flush();
    expect(e.last('worker.handoff_cancel').args).toEqual({ worker: 'A', op });
    await e.answer('worker.handoff_cancel', { ok: false, code: 'invalid_state', message: `invalid state: Pixel has no handoff request "${op}"` });
    expect(e.rv.summary()).toMatchObject({ state: 'filing', error: false, handoff: { bridge: { op, accepted: false } } });
    expect(e.rv.summary()?.status).toBe('herdr-world has not started Pixel’s handoff request (yet): asking it again whether it has it, to cancel it then…');
    // Asked again at once, the same request.
    expect(e.of('worker.handoff')).toHaveLength(2);
    expect(e.last('worker.handoff').args).toEqual(e.of('worker.handoff')[0]!.args);
    await e.accept(op);
    // It has it: the cancel goes again, now for a request it has.
    expect(e.of('worker.handoff_cancel')).toHaveLength(2);
    await e.answer('worker.handoff_cancel', { ok: true, data: { op, state: 'failed', reason: 'cancelled', started_at: 0 } } as CommandResult);
    await e.record({ op, state: 'cancelled', code: 'cancelled', reason: 'The handoff request was cancelled; nobody was hired.' });
    expect(e.rv.summary()).toMatchObject({ state: 'ready', error: true });
    expect(e.rv.summary()?.status).toContain('The handoff request was cancelled; nobody was hired.');
  });

  it('B-R6: Cancel request answered invalid_state, then the op’s waiting record comes: followed (the reviewer’s case), the cancel goes again; busy means it has it', async () => {
    const e = setup();
    const { op } = await e.submit();
    await e.answer('worker.handoff', { ok: false, code: 'timeout', message: 'timeout' });
    q<HTMLButtonElement>('[data-key="cancel-request"]')!.click();
    await flush();
    await e.answer('worker.handoff_cancel', { ok: false, code: 'invalid_state', message: `invalid state: Pixel has no handoff request "${op}"` });
    await e.record({ op });
    expect(e.rv.summary()).toMatchObject({ state: 'filing', handoff: { bridge: { op, accepted: true } } });
    expect(e.of('worker.handoff_cancel')).toHaveLength(2);
    // The replay's answer that comes after the record changes nothing.
    await e.answer('worker.handoff', { ok: false, code: 'timeout', message: 'timeout' });
    await e.retry();
    expect(e.of('worker.handoff')).toHaveLength(2);
    await e.answer('worker.handoff_cancel', { ok: false, code: 'busy', message: 'busy: the handoff is being filed' });
    expect(e.rv.summary()).toMatchObject({ state: 'filing', handoff: { bridge: { op, accepted: true } } });
    expect(e.rv.summary()?.status).toContain('It is being filed already; Nibble is hired at Desk 2 once it is.');
    await e.record({ op, state: 'hired', path: PATH, hired: 'N', prompted: true });
    expect(e.rv.isOpen).toBe(false);
  });

  it('B-R6: asked again, and the record already left (the ack has none): it ended a while ago; said once, never a hire', async () => {
    const e = setup();
    const { op } = await e.submit();
    await e.answer('worker.handoff', { ok: false, code: 'timeout', message: 'timeout' });
    await e.retry();
    await e.answer('worker.handoff', { ok: true, data: { request: { op, state: 'filed', handoff: 7, started_at: 0 }, existing: true } } as CommandResult);
    expect(e.rv.summary()).toMatchObject({ state: 'ready', error: true });
    expect(e.rv.summary()?.status).toBe('herdr-world had Pixel’s handoff request already, and it has ended; how is no longer known. Look for Nibble at Desk 2, and for the handoff in the cabinet.');
    q<HTMLButtonElement>('[data-key="hire"]')!.click();
    await flush();
    expect(e.last('worker.handoff').args.op).not.toBe(op);
    expect(e.of('worker.hire')).toHaveLength(0);
  });

  it('B-R6: no answer, then closed: the session (and the task) stays until the bridge says; refused, the task comes back once', async () => {
    const e = setup();
    const { op } = await e.submit();
    await e.answer('worker.handoff', { ok: false, code: 'timeout', message: 'timeout' });
    q<HTMLButtonElement>('[data-key="background"]')!.click();
    expect(e.rv.isOpen).toBe(false);
    expect(e.toasts).toEqual([{ text: 'herdr-world did not answer about Pixel’s handoff request. If it took it, Nibble is hired at Desk 2 once it is filed; if not, your task comes back.', kind: 'warn' }]);
    // A snapshot without it says nothing, and gives nothing back.
    await e.snapshot([]);
    e.flushTimers();
    expect(e.rv.isOpen).toBe(false);
    expect(e.toasts).toHaveLength(1);
    await e.retry();
    expect(e.last('worker.handoff').args).toEqual(e.of('worker.handoff')[0]!.args);
    await e.answer('worker.handoff', { ok: false, code: 'capacity', message: 'the floor is full' });
    expect(e.rv.isOpen).toBe(true);
    const s = e.rv.summary()!;
    expect(s.form.prompt).toBe(TASK);
    expect(s.handoff?.op).toBe(op);
    expect(s.status).toContain('Over the hard cap: the floor is full. Send someone home first. Nothing was filed and nobody was hired.');
    // Once: nothing more is asked, said or given back.
    e.rv.close();
    await e.retry();
    await e.snapshot([]);
    e.flushTimers();
    expect(e.rv.isOpen).toBe(false);
    expect(e.of('worker.handoff')).toHaveLength(2);
  });

  it('B-R6: no answer, then closed: asked again and taken; its outcome is said once by the announcer, a failure gives the task back', async () => {
    const e = setup();
    const { op } = await e.submit();
    await e.answer('worker.handoff', { ok: false, code: 'disconnected', message: 'closed' });
    q<HTMLButtonElement>('[data-key="background"]')!.click();
    await e.snapshot([]);
    e.rv.online();
    await flush();
    await e.accept(op);
    expect(e.rv.isOpen).toBe(false);
    await e.record({ op, state: 'failed', code: 'handoff_failed', reason: 'Nobody was hired, the handoff was not filed: the agent stopped.' });
    expect(e.rv.isOpen).toBe(true);
    expect(e.rv.summary()?.form.prompt).toBe(TASK);
    expect(e.rv.summary()?.status).toContain('Nobody was hired, the handoff was not filed: the agent stopped.');
    e.rv.close();
    await e.record({ op, state: 'failed', code: 'handoff_failed', reason: 'Nobody was hired, the handoff was not filed: the agent stopped.' });
    e.flushTimers();
    await e.retry();
    expect(e.rv.isOpen).toBe(false);
    expect(e.of('worker.handoff')).toHaveLength(2);

    document.body.replaceChildren();
    localStorage.clear();
    const b = setup();
    const { op: op2 } = await b.submit();
    await b.answer('worker.handoff', { ok: false, code: 'timeout', message: 'timeout' });
    q<HTMLButtonElement>('[data-key="background"]')!.click();
    await b.retry();
    await b.accept(op2);
    await b.record({ op: op2, state: 'hired', path: PATH, hired: 'N', prompted: true });
    expect(b.toasts.at(-1)).toEqual({ text: SPAWNED_TEXT, kind: 'info' });
    expect(b.toasts.filter((t) => t.text === SPAWNED_TEXT)).toHaveLength(1);
    expect(b.of('worker.hire')).toHaveLength(0);
  });
});
