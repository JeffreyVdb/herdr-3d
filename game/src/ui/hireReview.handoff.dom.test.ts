// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../net/client';
import type { AgentHandoff, HandoffCandidate, HandoffEntry, HireGit, HireInterpretation, HirePrepare, LLMHandoff, Worker } from '../net/protocol';
import { hireWithHandoffTask } from '../world/handoff';
import { fromHandoff } from '../world/hireReview';
import { CAT } from '../world/hireReviewFixtures';
import { HIRE_PROMPT_MAX_BYTES } from './composer/model';
import type { HandoffPlan, HireCarry } from './handoffFiling';
import type { HireHost } from './hire';
import { carriedSeed, HireReviewDialog } from './hireReview';
import { HirePrefs } from './hirePrefs';
import type { PromptSecretsFlow } from './secretsFlow';

// #198: "Hire with handoff", step 2: the review's Hire files the handoff, waits for its op to be filed, reads its final
// path, then hires once with the composed task. Every command is answered by hand, so each wait is observable.

const CAND: HandoffCandidate = { id: 'cand-1', session: 'sess', revision: 'rev-1', harness: 'claude', message: 'msg_1', source: 'message', bytes: 300 };
const PATH = '/home/u/my handoffs/herdr-3d/20261025-0800-pixel-loader.md';
const ENTRY: HandoffEntry = { id: 7, floor: 'floor', worker_id: 'A', worker_name: 'Pixel', path: PATH, title: 'Loader', created_at: 0, source: 'agent', bytes: 300 };
const TASK = 'Fix the issue\n\n- keep the tests green\n  - and the docs';
const INTERP: HireInterpretation = { sources: [], harness: { provenance: 'missing' }, model: { provenance: 'missing' }, effort: { provenance: 'missing' }, task: { provenance: 'missing' }, questions: [], ready_for_review: true };

const prep = (over: Partial<HirePrepare> = {}): HirePrepare => ({
  cwd: '/w/pixel',
  label: 'Nibble',
  git: null,
  choice: { harness: 'codex', model: 'gpt-6-luna', effort: 'high' },
  choice_source: 'floor_default',
  capacity: { floor: { count: 1, soft: 10, hard: 20 }, host: { count: 1, soft: 10, hard: 20 } },
  ...over,
});

const flush = async () => {
  for (let n = 0; n < 30; n++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

interface Pending {
  t: string;
  args: Record<string, unknown>;
  answer: (r: CommandResult) => void;
}

function setup(o: { background?: boolean; secrets?: PromptSecretsFlow; git?: HireGit; back?: HireHost['handoffBack'] } = {}) {
  const seats: Array<{ name: string } | null> = Array(6).fill(null);
  seats[0] = { name: 'Pixel' };
  const held = new Set<number>();
  const sent: Pending[] = [];
  const toasts: Array<{ text: string; kind: string }> = [];
  const holds: Array<[string, string]> = [];
  const goTos: string[] = [];
  const prefs = new HirePrefs(null);
  prefs.hireInBackground = o.background === true;
  const source: Worker = { id: 'A', session: 'floor', workspace_id: 'w', label: 'pixel', status: 'idle', handoff: CAND } as Worker;
  const workers = new Map<string, Worker>([['A', source]]);
  const store = {
    floorName: (id: string) => id,
    hireOptions: CAT,
    floorView: () => ({ seats, asleep: false, transition: null, level: { number: 2, count: 3 }, building: { name: 'HQ' } }),
    limits: { version: 0, list: () => [] },
    workerView: () => null,
    workers,
  };
  const host = {
    store,
    send: (t: string, args: Record<string, unknown>) => {
      // The folder as asked for (none: the source's), and its repository.
      if (t === 'hire.prepare') return Promise.resolve({ ok: true, data: prep({ ...(args.cwd ? { cwd: String(args.cwd) } : {}), ...(o.git ? { git: o.git } : {}) }) } as CommandResult);
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
    beep: () => {},
    holdTask: (id: string, text: string) => (holds.push([id, text]), true),
    hirePrefs: prefs,
    now: () => Date.now(),
    ...(o.secrets ? { secrets: o.secrets } : {}),
    ...(o.back ? { handoffBack: o.back } : {}),
  } as unknown as HireHost;
  const rv = new HireReviewDialog(document.body, host);
  const of = (t: string) => sent.filter((s) => s.t === t);
  const last = (t: string) => of(t).at(-1)!;
  const answer = async (t: string, r: CommandResult) => {
    const p = sent.find((s) => s.t === t && !(s as { done?: boolean }).done)!;
    (p as { done?: boolean }).done = true;
    p.answer(r);
    await flush();
  };
  /** The source worker changed (the world's update reaches the review through `refresh`). */
  const update = async (w: Partial<Worker>) => {
    workers.set('A', { ...source, ...w });
    rv.refresh();
    await flush();
  };
  const open = async (plan: Partial<HandoffPlan> = {}, task = TASK, from = { harness: 'claude', model: 'claude-opus-5-5' }) => {
    const seed = fromHandoff(from, task, CAT);
    const p: HandoffPlan = { worker: 'A', name: 'Pixel', floorName: 'floor', mode: 'agent', candidate: null, instruction: 'focus on the tests', sendHome: false, ...plan };
    expect(rv.open('floor', INTERP, 1, { choice: { ...seed, origin: { ...seed.origin, task: 'chosen' } }, cwd: '/w/pixel', handoff: p })).toBe(true);
    await flush();
  };
  return { rv, sent, of, last, answer, update, open, toasts, holds, goTos, seats, held, prefs, workers };
}

const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const hireBtn = () => q<HTMLButtonElement>('[data-key="hire"]')!;
const pickEffort = (v: string) => q<HTMLInputElement>(`[data-key="effort:${v}"]`)!.click();
const req = (over: Partial<AgentHandoff> = {}): AgentHandoff => ({ op: '', state: 'pending', started_at: 0, ...over });
const job = (over: Partial<LLMHandoff> = {}): LLMHandoff => ({ op: '', state: 'running', started_at: 0, updated_at: 0, ...over });
const ok = (data: unknown): CommandResult => ({ ok: true, data }) as CommandResult;

describe('HireReviewDialog: hire with handoff (#198)', () => {
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

  it('shows the task as the agent gets it, the path a placeholder; the effort is asked before anything is filed', async () => {
    const e = await (async () => {
      const e = setup();
      await e.open();
      return e;
    })();
    const s = e.rv.summary()!;
    expect(s.handoff).toMatchObject({ worker: 'A', mode: 'agent', filed: null });
    expect(q('#review-title')?.textContent).toBe('Hire with a handoff at Desk 2');
    expect(q('[data-hook="composed"]')?.textContent).toBe(hireWithHandoffTask('‹the handoff’s path, once it is filed›', TASK));
    expect(q('#review-task-label')?.textContent).toBe('Task for the new agent');
    expect(s.form).toMatchObject({ harness: 'claude', model: 'claude-opus-5-5', effort: '', cwd: '/w/pixel' });
    // Effort is never guessed: Hire is off and nothing is sent.
    expect(s.blocker).toBe('Choose an effort.');
    hireBtn().click();
    await flush();
    expect(e.sent).toEqual([]);
    pickEffort('high');
    expect(hireBtn().textContent).toBe('File handoff and hire');
  });

  it('agent: one submission files the handoff, waits for its op, then hires once with the composed task and the final path', async () => {
    const e = setup();
    await e.open();
    pickEffort('high');
    hireBtn().click();
    await flush();
    const ask = e.last('worker.handoff');
    // The instruction goes to the source worker's agent; the new agent's task never does.
    expect(ask.args).toMatchObject({ worker: 'A', mode: 'agent', instruction: 'focus on the tests' });
    expect(JSON.stringify(ask.args)).not.toContain('Fix the issue');
    const op = String(ask.args.op);
    expect(op).toMatch(/^ho-/);
    expect(e.rv.summary()).toMatchObject({ state: 'filing', status: 'Asking Pixel’s agent…' });
    expect(q('[data-key="cancel-request"]')).not.toBeNull();
    // The choices are locked while it is made.
    expect(q<HTMLInputElement>('[data-key="effort:low"]')!.disabled).toBe(true);
    await e.answer('worker.handoff', ok({ request: req({ op }) }));
    expect(e.rv.summary()?.status).toContain('filed once its turn ends');
    // Delayed generation: an older request of another op still shown, a double click, pending updates: no hire.
    await e.update({ agent_handoff: req({ op: 'ho-other', state: 'filed', handoff: 99 }) });
    hireBtn().click();
    await e.update({ agent_handoff: req({ op, state: 'filing' }) });
    expect(e.of('worker.hire')).toHaveLength(0);
    expect(e.of('handoff.get')).toHaveLength(0);
    expect(e.of('worker.handoff')).toHaveLength(1);
    await e.update({ agent_handoff: req({ op, state: 'filed', handoff: 7 }) });
    // Repeated completion events: one read, one hire.
    await e.update({ agent_handoff: req({ op, state: 'filed', handoff: 7 }) });
    expect(e.of('handoff.get').map((s) => s.args)).toEqual([{ id: 7 }]);
    expect(e.of('worker.hire')).toHaveLength(0);
    await e.answer('handoff.get', ok({ handoff: ENTRY, body: '# Loader' }));
    await e.update({ agent_handoff: req({ op, state: 'filed', handoff: 7 }) });
    expect(e.of('worker.hire')).toHaveLength(1);
    expect(e.last('worker.hire').args).toMatchObject({ floor: 'floor', desk_index: 1, harness: 'claude', model: 'claude-opus-5-5', effort: 'high', cwd: '/w/pixel', prompt: hireWithHandoffTask(PATH, TASK) });
    expect(e.rv.summary()?.handoff?.filed).toBe(PATH);
    expect(q('[data-hook="rv-handoff-path"]')?.textContent).toBe(PATH);
    await e.answer('worker.hire', ok({ id: 'N', prompted: true }));
    expect(e.rv.isOpen).toBe(false);
    expect(e.goTos).toEqual(['N']);
    expect(e.toasts.at(-1)?.text).toMatch(/^Hired Nibble at Desk 2/);
    await e.update({ agent_handoff: req({ op, state: 'filed', handoff: 7 }) });
    expect(e.of('worker.hire')).toHaveLength(1);
  });

  it('literal: the reply step 1 previewed is filed with its candidate; send home only when ticked, the hire never at the source’s desk', async () => {
    const e = setup();
    await e.open({ mode: 'literal', candidate: CAND, instruction: '', sendHome: true });
    expect(q('[data-hook="rv-handoff-home"]')?.textContent).toContain('never takes Pixel’s desk');
    pickEffort('low');
    hireBtn().click();
    await flush();
    expect(e.rv.summary()?.status).toBe('Saving Pixel’s last message…');
    expect(e.last('worker.handoff').args).toMatchObject({ worker: 'A', mode: 'literal', session: 'sess', candidate: 'cand-1', revision: 'rev-1', send_home: true });
    expect(e.last('worker.handoff').args.instruction).toBeUndefined();
    await e.answer('worker.handoff', ok({ handoff: { ...ENTRY, source: 'literal' }, send_home: 'started' }));
    // The source going home frees desk 1 only later: the hire keeps the desk it was given.
    expect(e.last('worker.hire').args).toMatchObject({ desk_index: 1, prompt: hireWithHandoffTask(PATH, TASK) });
  });

  it('literal: a reply that changed since step 1 is refused; nobody is hired, the task and settings stay', async () => {
    const e = setup();
    await e.open({ mode: 'literal', candidate: CAND, instruction: '' });
    pickEffort('low');
    hireBtn().click();
    await flush();
    const op1 = e.last('worker.handoff').args.op;
    await e.answer('worker.handoff', { ok: false, code: 'handoff_unavailable', message: 'the candidate is not current' } as CommandResult);
    expect(e.rv.summary()).toMatchObject({ state: 'ready', error: true, form: { effort: 'low', prompt: TASK } });
    expect(e.rv.summary()?.status).toContain('Nobody was hired');
    expect(e.of('worker.hire')).toHaveLength(0);
    expect(q('[data-key="back"]')).toBeNull(); // no handoffBack in this host
    hireBtn().click();
    await flush();
    expect(e.last('worker.handoff').args.op).not.toBe(op1);
  });

  it('LLM: the job of its op is followed until filed; the path read back is the one in the task', async () => {
    const e = setup();
    await e.open({ mode: 'llm', candidate: CAND, instruction: '', llmModel: 'gpt-x' });
    pickEffort('high');
    hireBtn().click();
    await flush();
    const op = String(e.last('worker.handoff').args.op);
    expect(e.last('worker.handoff').args).toEqual({ worker: 'A', mode: 'llm', session: 'sess', candidate: 'cand-1', revision: 'rev-1', op });
    expect(e.rv.summary()?.status).toBe('The LLM (gpt-x) is writing the handoff…');
    await e.answer('worker.handoff', ok({ job: job({ op, state: 'queued' }) }));
    await e.update({ llm_handoff: job({ op, state: 'filed', handoff: 7 }) });
    await e.answer('handoff.get', ok({ handoff: { ...ENTRY, source: 'llm' }, body: '' }));
    expect(e.last('worker.hire').args.prompt).toBe(hireWithHandoffTask(PATH, TASK));
  });

  it('a generation that fails or times out hires nobody; Hire again is a new request', async () => {
    const e = setup();
    await e.open({ mode: 'llm', candidate: CAND, instruction: '' });
    pickEffort('high');
    hireBtn().click();
    await flush();
    const op = String(e.last('worker.handoff').args.op);
    await e.answer('worker.handoff', ok({ job: job({ op }) }));
    await e.update({ llm_handoff: job({ op, state: 'failed', code: 'timeout', message: 'The LLM did not answer within 90 seconds; nothing was filed.' }) });
    expect(e.rv.summary()).toMatchObject({ state: 'ready', error: true, form: { prompt: TASK } });
    expect(e.rv.summary()?.status).toContain('within 90 seconds');
    expect(e.of('worker.hire')).toHaveLength(0);
    hireBtn().click();
    await flush();
    expect(e.last('worker.handoff').args.op).not.toBe(op);
  });

  it('no answer about the request: Hire again sends the same op (it is filed once)', async () => {
    const e = setup();
    await e.open();
    pickEffort('high');
    hireBtn().click();
    await flush();
    const op = e.last('worker.handoff').args.op;
    await e.answer('worker.handoff', { ok: false, code: 'disconnected', message: '' } as CommandResult);
    expect(e.rv.summary()?.status).toContain('it is filed once');
    hireBtn().click();
    await flush();
    expect(e.of('worker.handoff').map((s) => s.args.op)).toEqual([op, op]);
  });

  it('Cancel request cancels the agent’s request and hires nobody, even when its filed update comes later', async () => {
    const e = setup();
    await e.open();
    pickEffort('high');
    hireBtn().click();
    await flush();
    const op = String(e.last('worker.handoff').args.op);
    await e.answer('worker.handoff', ok({ request: req({ op }) }));
    q<HTMLButtonElement>('[data-key="cancel-request"]')!.click();
    await flush();
    expect(e.last('worker.handoff_cancel').args).toEqual({ worker: 'A', op });
    await e.answer('worker.handoff_cancel', ok(req({ op, state: 'failed', reason: 'cancelled' })));
    expect(e.rv.summary()).toMatchObject({ state: 'ready', error: true });
    expect(e.rv.summary()?.status).toContain('Cancelled');
    await e.update({ agent_handoff: req({ op, state: 'filed', handoff: 7 }) });
    expect(e.of('handoff.get')).toHaveLength(0);
    expect(e.of('worker.hire')).toHaveLength(0);
  });

  it('Cancel request stops the hire at once: the filed update and its path answered before the cancel’s ack hire nobody', async () => {
    const e = setup();
    await e.open();
    pickEffort('high');
    hireBtn().click();
    await flush();
    const op = String(e.last('worker.handoff').args.op);
    await e.answer('worker.handoff', ok({ request: req({ op }) }));
    await e.update({ agent_handoff: req({ op, state: 'filed', handoff: 7 }) });
    q<HTMLButtonElement>('[data-key="cancel-request"]')!.click();
    await flush();
    expect(e.of('worker.handoff_cancel')).toHaveLength(1);
    // Cancelled on the click: the review is back, before the bridge answers anything.
    expect(e.rv.summary()).toMatchObject({ state: 'ready', error: true });
    await e.answer('handoff.get', ok({ handoff: ENTRY, body: '' }));
    expect(e.of('worker.hire')).toHaveLength(0);
    // The bridge only dismissed it: it was filed. The review says so; nobody is hired from it, Hire files a new one.
    await e.answer('worker.handoff_cancel', ok(req({ op, state: 'filed', handoff: 7 })));
    expect(e.of('worker.hire')).toHaveLength(0);
    expect(e.rv.summary()?.status).toContain('in the cabinet');
    expect(e.rv.summary()).toMatchObject({ state: 'ready', handoff: { filed: null } });
    expect(e.rv.summary()?.handoff?.op).not.toBe(op);
  });

  it('Cancel request the bridge refuses: still nobody is hired; the review says it may still be filed', async () => {
    const e = setup();
    await e.open({ mode: 'llm', candidate: CAND });
    pickEffort('high');
    hireBtn().click();
    await flush();
    const op = String(e.last('worker.handoff').args.op);
    await e.answer('worker.handoff', ok({ job: job({ op }) }));
    q<HTMLButtonElement>('[data-key="cancel-request"]')!.click();
    q<HTMLButtonElement>('[data-key="cancel-request"]')?.click();
    await flush();
    expect(e.of('worker.handoff_cancel')).toHaveLength(1);
    await e.update({ llm_handoff: job({ op, state: 'filed', handoff: 7 }) });
    await e.answer('worker.handoff_cancel', { ok: false, code: 'busy', message: 'the handoff is being filed' } as CommandResult);
    expect(e.of('handoff.get')).toHaveLength(0);
    expect(e.of('worker.hire')).toHaveLength(0);
    expect(e.rv.summary()?.status).toContain('may still be filed');
  });

  it('closed while the handoff is made: no agent is hired, ever; the toast says the handoff is still filed', async () => {
    const e = setup();
    await e.open();
    pickEffort('high');
    hireBtn().click();
    await flush();
    const op = String(e.last('worker.handoff').args.op);
    await e.answer('worker.handoff', ok({ request: req({ op }) }));
    e.rv.close();
    expect(e.toasts.map((t) => t.text)).toEqual(['No agent hired. Pixel’s handoff will still be filed to the cabinet; hire from it there.']);
    // Reopened for the same worker (a new submission), then the old request is filed: nothing launches from it.
    await e.open({}, 'another task');
    await e.update({ agent_handoff: req({ op, state: 'filed', handoff: 7 }) });
    expect(e.of('handoff.get')).toHaveLength(0);
    expect(e.of('worker.hire')).toHaveLength(0);
    expect(e.rv.summary()).toMatchObject({ state: 'ready', handoff: { filed: null } });
    expect(e.rv.summary()?.handoff?.op).not.toBe(op);
    expect(e.toasts).toHaveLength(1);
  });

  it('closed while the request is still on its way: its ack is not followed', async () => {
    const e = setup();
    await e.open({ mode: 'literal', candidate: CAND, instruction: '' });
    pickEffort('high');
    hireBtn().click();
    await flush();
    q<HTMLButtonElement>('[data-key="cancel"]')!.click();
    expect(e.toasts.at(-1)?.text).toContain('No agent hired.');
    await e.answer('worker.handoff', ok({ handoff: ENTRY }));
    expect(e.of('worker.hire')).toHaveLength(0);
  });

  it('a hire refused after filing keeps the filed path and task: Hire again hires only, never files again', async () => {
    const e = setup();
    await e.open({ mode: 'literal', candidate: CAND, instruction: '' });
    pickEffort('high');
    hireBtn().click();
    await flush();
    await e.answer('worker.handoff', ok({ handoff: ENTRY }));
    await e.answer('worker.hire', { ok: false, code: 'capacity', message: 'floor floor is full (20 workers)' } as CommandResult);
    const s = e.rv.summary()!;
    expect(s).toMatchObject({ state: 'ready', error: true, handoff: { filed: PATH } });
    expect(s.status).toContain(`The handoff is saved at ${PATH}.`);
    expect(s.status).toContain('Hire again hires only');
    expect(hireBtn().textContent).toBe('Hire Nibble');
    hireBtn().click();
    await flush();
    expect(e.of('worker.handoff')).toHaveLength(1);
    expect(e.of('worker.hire')).toHaveLength(2);
    expect(e.last('worker.hire').args.prompt).toBe(hireWithHandoffTask(PATH, TASK));
    await e.answer('worker.hire', ok({ id: 'N', prompted: true }));
    expect(e.rv.isOpen).toBe(false);
  });

  it('an unknown hire outcome after filing says to look at the desk before hiring again', async () => {
    const e = setup();
    await e.open({ mode: 'literal', candidate: CAND, instruction: '' });
    pickEffort('high');
    hireBtn().click();
    await flush();
    await e.answer('worker.handoff', ok({ handoff: ENTRY }));
    await e.answer('worker.hire', { ok: false, code: 'timeout', message: 'no answer' } as CommandResult);
    expect(e.rv.summary()?.status).toContain('Look at the desk before you hire again.');
    expect(e.rv.summary()?.status).toContain(PATH);
  });

  it('the desk taken while the handoff was made: rechecked at launch, nobody hired, the handoff kept', async () => {
    const e = setup();
    await e.open();
    pickEffort('high');
    hireBtn().click();
    await flush();
    const op = String(e.last('worker.handoff').args.op);
    await e.answer('worker.handoff', ok({ request: req({ op }) }));
    e.seats[1] = { name: 'Zippy' };
    await e.update({ agent_handoff: req({ op, state: 'filed', handoff: 7 }) });
    await e.answer('handoff.get', ok({ handoff: ENTRY, body: '' }));
    expect(e.of('worker.hire')).toHaveLength(0);
    expect(e.rv.summary()?.status).toContain('Zippy sits at Desk 2');
    expect(e.rv.summary()?.status).toContain(`saved at ${PATH}`);
  });

  it('created but not prompted: the composed task is held for that worker; no replacement is hired', async () => {
    const e = setup();
    await e.open({ mode: 'literal', candidate: CAND, instruction: '' });
    pickEffort('high');
    hireBtn().click();
    await flush();
    await e.answer('worker.handoff', ok({ handoff: ENTRY }));
    await e.answer('worker.hire', ok({ id: 'N', prompted: false, prompt_error: 'the pane did not answer' }));
    expect(e.holds).toEqual([['N', hireWithHandoffTask(PATH, TASK)]]);
    expect(e.toasts.at(-1)?.text).toContain('the task is in their prompt');
    expect(e.of('worker.hire')).toHaveLength(1);
    expect(e.rv.isOpen).toBe(false);
  });

  it('created but not prompted after the review closed and another opened: the composed task of that hire is held', async () => {
    const e = setup();
    await e.open({ mode: 'literal', candidate: CAND, instruction: '' });
    pickEffort('high');
    hireBtn().click();
    await flush();
    await e.answer('worker.handoff', ok({ handoff: ENTRY }));
    expect(e.of('worker.hire')).toHaveLength(1);
    e.rv.close();
    expect(e.rv.open('floor', INTERP, 2, { choice: fromHandoff({ harness: 'claude', model: 'claude-opus-5-5' }, 'A different task', CAT) })).toBe(true);
    await flush();
    await e.answer('worker.hire', ok({ id: 'N', prompted: false, prompt_error: 'the pane did not answer' }));
    expect(e.holds).toEqual([['N', hireWithHandoffTask(PATH, TASK)]]);
    expect(e.of('worker.hire')).toHaveLength(1);
  });

  it('“Hire in background” applies once the handoff is filed; a refusal gives back the review with the filed path', async () => {
    const e = setup({ background: true });
    await e.open();
    pickEffort('high');
    hireBtn().click();
    await flush();
    const op = String(e.last('worker.handoff').args.op);
    await e.answer('worker.handoff', ok({ request: req({ op }) }));
    // The review stays open while the handoff is made.
    expect(e.rv.isOpen).toBe(true);
    await e.update({ agent_handoff: req({ op, state: 'filed', handoff: 7 }) });
    await e.answer('handoff.get', ok({ handoff: ENTRY, body: '' }));
    expect(e.rv.isOpen).toBe(false);
    expect(e.toasts).toEqual([]);
    await e.answer('worker.hire', { ok: false, code: 'capacity', message: 'the host is full' } as CommandResult);
    expect(e.rv.isOpen).toBe(true);
    expect(e.rv.summary()?.handoff?.filed).toBe(PATH);
    expect(e.rv.summary()?.status).toContain(`saved at ${PATH}`);
    hireBtn().click();
    await flush();
    expect(e.of('worker.handoff')).toHaveLength(1);
    expect(e.of('worker.hire')).toHaveLength(2);
  });

  it('Back to the handoff keeps the hire’s choices: Continue opens the review with them, and step 1’s task', async () => {
    const backs: Array<[HandoffPlan, string, HireCarry]> = [];
    const git: HireGit = { repo_root: '/w', default_branch: 'main', base_sha: 'abcdef1234', base_time: Date.now(), fetched: true };
    const e = setup({ git, back: (p, t, c) => void backs.push([p, t, c]) });
    await e.open({ mode: 'literal', candidate: CAND, instruction: '' });
    const before = e.rv.summary()!;
    // The human's choices: another model and an effort, a label, another folder, the worktree flipped.
    q<HTMLInputElement>('[data-key="model:claude-sonnet-5-5"]')!.click();
    pickEffort('low');
    q<HTMLButtonElement>('[data-key="sec:where"]')!.click();
    const type = (sel: string, v: string) => {
      const el = q<HTMLInputElement>(sel)!;
      el.value = v;
      el.dispatchEvent(new Event('input'));
      el.dispatchEvent(new Event('change'));
    };
    type('#review-label', 'Pip');
    type('#review-cwd', '/w/other');
    await flush();
    const worktree = !before.form.worktree;
    q<HTMLInputElement>('#review-worktree')!.click();
    const chosen = e.rv.summary()!;
    expect(chosen.choice).toMatchObject({ harness: 'claude', model: 'claude-sonnet-5-5', effort: 'low' });
    expect(chosen.form).toMatchObject({ label: 'Pip', cwd: '/w/other', worktree });
    // Back (a stale reply, another mode): step 1 gets the plan, the task and the hire's choices; nothing was sent.
    q<HTMLButtonElement>('[data-key="back"]')!.click();
    expect(e.rv.isOpen).toBe(false);
    expect(backs).toHaveLength(1);
    const [plan, task, carry] = backs[0]!;
    expect(task).toBe(TASK);
    expect(carry).toMatchObject({ floor: 'floor', desk: 1, label: 'Pip', cwd: '/w/other', worktree });
    expect(e.of('worker.handoff')).toHaveLength(0);
    // Continue (the task edited in step 1): the review as it was reviewed, the task step 1's.
    expect(e.rv.open('floor', INTERP, carry.desk, carriedSeed(carry, 'Fix it, then the docs', plan))).toBe(true);
    await flush();
    const after = e.rv.summary()!;
    expect(after.desk).toBe(1);
    expect(after.choice).toMatchObject({ harness: 'claude', model: 'claude-sonnet-5-5', effort: 'low', task: 'Fix it, then the docs' });
    expect(after.choice.origin).toMatchObject({ model: 'chosen', effort: 'chosen', task: 'chosen' });
    expect(after.form).toMatchObject({ label: 'Pip', cwd: '/w/other', worktree });
    expect(after.blocker).toBeNull();
    expect(after.handoff).toMatchObject({ mode: 'literal', filed: null });
    // Its Hire files the handoff, then hires with those choices.
    hireBtn().click();
    await flush();
    await e.answer('worker.handoff', ok({ handoff: ENTRY }));
    expect(e.last('worker.hire').args).toMatchObject({ harness: 'claude', model: 'claude-sonnet-5-5', effort: 'low', label: 'Pip', cwd: '/w/other', worktree, prompt: hireWithHandoffTask(PATH, 'Fix it, then the docs') });
  });

  it('agent: another harness and model for the new agent; the source’s agent still writes the handoff', async () => {
    const e = setup();
    // Pixel runs Codex: the review starts from its harness and model.
    await e.open({}, TASK, { harness: 'codex', model: 'gpt-6-luna' });
    const s = e.rv.summary()!;
    expect(s.form).toMatchObject({ harness: 'codex', model: 'gpt-6-luna' });
    // Resolved from the source, yet shown open: another harness is one click away, and focused first.
    expect(s.sections.find((x) => x.id === 'agent')).toMatchObject({ open: true, origin: 'From the handoff' });
    expect(document.activeElement).toBe(q('[data-key="sec:agent"]'));
    q<HTMLInputElement>('[data-key="harness:claude"]')!.click();
    q<HTMLInputElement>('[data-key="model:claude-sonnet-5-5"]')!.click();
    pickEffort('high');
    expect(e.rv.summary()).toMatchObject({ blocker: null, form: { harness: 'claude', model: 'claude-sonnet-5-5', effort: 'high' } });
    hireBtn().click();
    await flush();
    const op = String(e.last('worker.handoff').args.op);
    expect(e.last('worker.handoff').args).toMatchObject({ worker: 'A', mode: 'agent' });
    await e.answer('worker.handoff', ok({ request: req({ op }) }));
    await e.update({ agent_handoff: req({ op, state: 'filed', handoff: 7 }) });
    await e.answer('handoff.get', ok({ handoff: ENTRY, body: '# Loader' }));
    await e.update({ agent_handoff: req({ op, state: 'filed', handoff: 7 }) });
    expect(e.of('worker.hire')).toHaveLength(1);
    expect(e.last('worker.hire').args).toMatchObject({ harness: 'claude', model: 'claude-sonnet-5-5', effort: 'high', prompt: hireWithHandoffTask(PATH, TASK) });
  });

  it('back from step 1 with nothing chosen in the review: the bridge’s defaults stay defaults', async () => {
    const backs: HireCarry[] = [];
    const e = setup({ back: (_p, _t, c) => void backs.push(c) });
    await e.open({ mode: 'literal', candidate: CAND, instruction: '' });
    q<HTMLButtonElement>('[data-key="back"]')!.click();
    const carry = backs[0]!;
    // The folder was the source's (seeded, so chosen); label and worktree were the bridge's: not carried.
    expect(carry).toEqual({ floor: 'floor', desk: 1, choice: expect.objectContaining({ harness: 'claude', model: 'claude-opus-5-5', effort: '' }), cwd: '/w/pixel' });
    expect(carriedSeed(carry, TASK, { worker: 'A', name: 'Pixel', floorName: 'floor', mode: 'literal', candidate: CAND, instruction: '', sendHome: false })).not.toHaveProperty('label');
  });

  it('the task’s size counts the line that points to the handoff, before anything is filed', async () => {
    const e = setup();
    await e.open({}, 'x'.repeat(HIRE_PROMPT_MAX_BYTES - 200));
    pickEffort('high');
    expect(e.rv.summary()?.blocker).toBe('The task is too long to send with the line that points to the handoff.');
    hireBtn().click();
    await flush();
    expect(e.sent).toEqual([]);
  });

  it('#108: the composed task is reviewed; a cancelled review after filing keeps the path for a hire-only retry', async () => {
    const texts: string[] = [];
    let cancel = true;
    const flow = {
      on: true,
      onChange: () => {},
      review: async (r: { text: string }) => (texts.push(r.text), cancel ? { kind: 'kept', why: 'cancel', message: '' } : { kind: 'send', protects: 0, shown: r.text, review: null }),
      deliver: async (_r: unknown, go: unknown, send: (g: unknown) => Promise<CommandResult>) => ({ kind: 'answered', result: await send(go), go }),
    } as unknown as PromptSecretsFlow;
    const e = setup({ secrets: flow });
    await e.open({ mode: 'literal', candidate: CAND, instruction: '' });
    pickEffort('high');
    hireBtn().click();
    await flush();
    await e.answer('worker.handoff', ok({ handoff: ENTRY }));
    expect(texts).toEqual([hireWithHandoffTask(PATH, TASK)]);
    expect(e.of('worker.hire')).toHaveLength(0);
    expect(e.rv.summary()?.status).toContain(`saved at ${PATH}`);
    cancel = false;
    hireBtn().click();
    await flush();
    expect(e.of('worker.handoff')).toHaveLength(1);
    expect(e.last('worker.hire').args.prompt).toBe(hireWithHandoffTask(PATH, TASK));
  });
});
