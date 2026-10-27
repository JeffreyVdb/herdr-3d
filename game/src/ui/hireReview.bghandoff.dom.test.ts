// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../net/client';
import type { AgentHandoff, HandoffCandidate, HandoffHire, HireInterpretation, HirePrepare, Worker } from '../net/protocol';
import { hireWithHandoffTask } from '../world/handoff';
import { HandoffHireBook } from '../world/handoffHire';
import { fromHandoff } from '../world/hireReview';
import { CAT } from '../world/hireReviewFixtures';
import type { HandoffPlan } from './handoffFiling';
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
const INTERP: HireInterpretation = { sources: [], harness: { provenance: 'missing' }, model: { provenance: 'missing' }, effort: { provenance: 'missing' }, task: { provenance: 'missing' }, questions: [], ready_for_review: true };

const prep = (): HirePrepare => ({
  cwd: '/w/pixel',
  label: 'Nibble',
  git: null,
  choice: { harness: 'codex', model: 'gpt-6-luna', effort: 'high' },
  choice_source: 'floor_default',
  capacity: { floor: { count: 1, soft: 10, hard: 20 }, host: { count: 1, soft: 10, hard: 20 } },
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

function setup(o: { background?: boolean; secrets?: PromptSecretsFlow; known?: boolean } = {}) {
  const seats: Array<{ name: string } | null> = Array(6).fill(null);
  seats[0] = { name: 'Pixel' };
  const held = new Set<number>();
  const sent: Pending[] = [];
  const toasts: Array<{ text: string; kind: string }> = [];
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
      if (t === 'hire.prepare') return Promise.resolve({ ok: true, data: prep() } as CommandResult);
      return new Promise<CommandResult>((answer) => sent.push({ t, args, answer }));
    },
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
    now: () => Date.now(),
    ...(o.secrets ? { secrets: o.secrets } : {}),
  } as unknown as HireHost;
  const rv = new HireReviewDialog(document.body, host);
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
  const flushTimers = () => {
    while (timers.length) timers.shift()?.();
  };
  return { rv, sent, of, last, answer, record, open, submit, accept, toasts, goTos, holds, beeps: () => beeps, announcer, book, held, flushTimers };
}

const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);

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
});
