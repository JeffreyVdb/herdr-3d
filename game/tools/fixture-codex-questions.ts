// #157: shared Codex workers' async questions for the fixture server's `sim=1` (tools/fixture-sim.ts hands these
// commands over). Rules, like herdr-world's (docs/protocol.md "Codex async questions"):
// - `simcodex=ask` seeds Pixel (demo-m5's working Codex worker) on every connection, so a reconnect's snapshot
//   replays it: a shared launch, attached, its running turn `turn-1` asked batch `call_3` (a question with suggested
//   answers, one without); herdr says `blocked`, the bridge `async_blocked`.
// - `sim.codex {id, ask?, codex?, approval?, fail?, deliver?}` (the simulator's own): `ask` adds a batch
//   (`{batch, questions: [{title, options?}], turn?, twin?, conflict?}`, pending) to the worker's thread, making it a
//   shared worker first if it is not one; `codex` merges fields into its launch (`attached`, `thread`, `turn`, `questions`);
//   `approval` opens (true) or resolves (false) a server request: a real block; `fail` makes its next answer fail
//   (`input_failed`, `stale`, `unconfirmed`, `undelivered`; also `simfail=async_<kind>` once); `deliver: false` holds
//   answers at `sent` (true, the default: answered by the bridge `deliverMs` after the ack). Every change is one
//   `worker.upsert`, with `async_blocked` (attached, a turn runs, no approval open, a question of that turn not answered)
//   and the status herdr would show (`blocked` while asked or approval-blocked, `working` while a turn runs, else idle).
// - `sim.codex_answer {id, batch, index, answer, by?}`: the envelope seen (the terminal's, `by` "other" by default):
//   answered.
// - `sim.codex_turn_end {id}`: the running turn ends: an answer sent to it and not answered is `undelivered`.
// - `worker.answer_async`: checked like the bridge (`bad_request`, `unknown_worker`, `invalid_state` for a worker that
//   is not shared, a `conflict` batch or a thread not attached, `stale` for another thread, an unknown batch or a question
//   not pending (or sent and undelivered)); the questions go `sending` at once, a step later `sent` and the ack
//   `{state: "sent", via, turn}` (via `turn/steer` while a turn runs, else `turn/start`), then `answered` by `bridge`.
//   `input_failed`: pending again with `error`, refused; `unconfirmed`: sent and unconfirmed, never answered;
//   `undelivered`: sent, then the turn ends without it.
// - `worker.dismiss_async`: pending or sent questions go `dismissed` (`stale` otherwise).
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import type { CodexBatch, CodexQuestion, Floor, Worker, WorkerCodex } from '../src/net/protocol.ts';

type Obj = Record<string, unknown>;
type Msg = Record<string, unknown>;
type Send = (m: Msg) => void;

export interface CodexQuestionsHost {
  readonly workers: Worker[];
  readonly floors: Map<string, Floor>;
  readonly stepMs: number;
  emit(send: Send, m: Msg): void;
  after(ms: number, fn: () => void): void;
  now(): number;
  takeFail(code: string): boolean;
  error(code: string, message: string): Error;
}

/** demo-m5's Pixel: a working Codex worker on herdr-3d. */
export const SIM_CODEX_WORKER = 'fc018d58-4789-46c2-afac-c062bc9fff9e';
export const SIM_CODEX_THREAD = '01a1112a-85b8-7bf2-9d6e-sim000000001';

const FAILS = ['input_failed', 'stale', 'unconfirmed', 'undelivered'] as const;
type Fail = (typeof FAILS)[number];

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const BATCH = /^[A-Za-z0-9_.:-]{1,128}$/;
// Go's unicode.IsControl but line ends and tabs.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

interface State {
  approval: boolean;
  fail: Fail | null;
  deliver: boolean;
}

export class CodexQuestionsSim {
  private readonly st = new Map<string, State>();
  /** The turn each sent answer went to (worker, batch, index). */
  private readonly sentTo = new Map<string, string>();
  /** How long after its ack a sent answer is seen answered (default three steps). */
  deliverMs: number;

  constructor(private readonly h: CodexQuestionsHost) {
    this.deliverMs = h.stepMs * 3;
  }

  /** `simcodex=<scenario>`: the world as it starts (no events: the snapshot has it). */
  seed(scenario: string): void {
    if (scenario !== 'ask') return;
    const w = this.h.workers.find((x) => x.id === SIM_CODEX_WORKER);
    if (!w) return;
    this.share(w, { turn: 'turn-1' });
    this.add(w, { batch: 'call_3', questions: [{ title: 'Which fixture color?', options: ['Green', 'Blue'] }, { title: 'Any context for the fixture?' }] });
    this.settle(w);
  }

  handle(t: unknown, a: Obj, send: Send, ack: (d?: unknown) => void, fail: (e: unknown) => void): boolean {
    switch (t) {
      case 'sim.codex':
      case 'sim.codex_answer':
      case 'sim.codex_turn_end':
      case 'worker.answer_async':
      case 'worker.dismiss_async':
        break;
      default:
        return false;
    }
    try {
      if (t === 'sim.codex') ack(this.sim(a, send));
      else if (t === 'sim.codex_answer') ack(this.terminalAnswer(a, send));
      else if (t === 'sim.codex_turn_end') ack(this.turnEnd(this.find(a), send));
      else if (t === 'worker.answer_async') this.answer(a, send, ack, fail);
      else ack(this.dismiss(a, send));
    } catch (e) {
      fail(e);
    }
    return true;
  }

  private bad(m: string): Error {
    return this.h.error('bad_request', `bad args: ${m}`);
  }

  private find(a: Obj): Worker {
    const id = a.id;
    if (typeof id !== 'string') throw this.bad('id must be a string');
    const w = this.h.workers.find((x) => x.id === id);
    if (!w) throw this.h.error('unknown_worker', `unknown worker: "${id}"`);
    return w;
  }

  private state(id: string): State {
    let s = this.st.get(id);
    if (!s) this.st.set(id, (s = { approval: false, fail: null, deliver: true }));
    return s;
  }

  /** Makes w a shared Codex worker (attached, a thread) if it is not one. */
  private share(w: Worker, over: Partial<WorkerCodex> = {}): WorkerCodex {
    if (w.codex?.mode !== 'shared') w.codex = { mode: 'shared', server: 'running', attached: true, thread: SIM_CODEX_THREAD, questions: [] };
    Object.assign(w.codex, over);
    this.state(w.id);
    return w.codex;
  }

  private add(w: Worker, b: Obj): void {
    const c = this.share(w);
    if (typeof b.batch !== 'string' || !BATCH.test(b.batch)) throw this.bad('ask.batch must be a question message id');
    if (!Array.isArray(b.questions) || !b.questions.length) throw this.bad('ask.questions must be a list');
    const questions: CodexQuestion[] = b.questions.map((x, index) => {
      if (!isObj(x) || typeof x.title !== 'string') throw this.bad('a question needs a title');
      const opts = Array.isArray(x.options) ? x.options.filter((o): o is string => typeof o === 'string') : [];
      return { index, title: x.title, ...(opts.length ? { options: opts } : {}), state: 'pending' };
    });
    const batch: CodexBatch = {
      batch: b.batch,
      turn: typeof b.turn === 'string' ? b.turn : (c.turn ?? ''),
      seen: [b.seen === 'history' ? 'history' : 'live'],
      at: this.h.now(),
      questions,
      ...(typeof b.twin === 'string' ? { twin: b.twin } : {}),
      ...(b.conflict === true ? { conflict: true } : {}),
    };
    c.questions = [...(c.questions ?? []).filter((x) => x.batch !== batch.batch), batch];
  }

  /** async_blocked and the status herdr would show, from the launch. */
  private settle(w: Worker): void {
    const c = w.codex;
    if (c?.mode !== 'shared') return;
    const s = this.state(w.id);
    const turn = c.attached ? (c.turn ?? '') : '';
    if (!c.attached) delete c.turn;
    const asked = !!turn && (c.questions ?? []).some((b) => b.turn === turn && b.questions.some((q) => q.state !== 'answered'));
    if (asked && !s.approval) c.async_blocked = true;
    else delete c.async_blocked;
    w.status = asked || s.approval ? 'blocked' : turn ? 'working' : w.status === 'blocked' || w.status === 'working' ? 'idle' : w.status;
  }

  private upsert(send: Send, w: Worker): void {
    this.settle(w);
    this.h.emit(send, { t: 'worker.upsert', worker: w });
  }

  private sim(a: Obj, send: Send): Obj {
    const w = this.find(a);
    const s = this.state(w.id);
    if (a.codex !== undefined) {
      if (!isObj(a.codex)) throw this.bad('codex must be an object');
      const c = this.share(w);
      for (const k of ['attached', 'thread', 'turn', 'questions'] as const) if (a.codex[k] !== undefined) (c as unknown as Obj)[k] = structuredClone(a.codex[k]);
    }
    if (a.ask !== undefined) {
      if (!isObj(a.ask)) throw this.bad('ask must be an object');
      this.add(w, a.ask);
    }
    if (typeof a.approval === 'boolean') s.approval = a.approval;
    if (a.fail !== undefined) {
      if (a.fail !== null && !FAILS.includes(a.fail as Fail)) throw this.bad(`fail must be one of ${FAILS.join(', ')}`);
      s.fail = (a.fail as Fail | null) ?? null;
    }
    if (typeof a.deliver === 'boolean') s.deliver = a.deliver;
    this.upsert(send, w);
    return { codex: w.codex, status: w.status };
  }

  private question(w: Worker, batch: unknown, index: unknown): [CodexBatch, CodexQuestion] {
    const b = w.codex?.questions?.find((x) => x.batch === batch);
    const q = typeof index === 'number' ? b?.questions[index] : undefined;
    if (!b || !q) throw this.h.error('stale', `stale: no question ${String(index)} of batch ${String(batch)}`);
    return [b, q];
  }

  private terminalAnswer(a: Obj, send: Send): Obj {
    const w = this.find(a);
    const [, q] = this.question(w, a.batch, a.index);
    if (typeof a.answer !== 'string') throw this.bad('answer must be a string');
    Object.assign(q, { state: 'answered', answer: a.answer, answered_by: a.by === 'bridge' ? 'bridge' : 'other' });
    delete q.error;
    delete q.undelivered;
    delete q.unconfirmed;
    this.upsert(send, w);
    return { answered: true };
  }

  private turnEnd(w: Worker, send: Send): Obj {
    const c = w.codex;
    const turn = c?.turn ?? '';
    if (!c || !turn) return { ended: false };
    // An answer steered into this turn and not delivered by its end is dropped.
    for (const b of c.questions ?? []) for (const q of b.questions) if (q.state === 'sent' && this.sentTo.get(this.qkey(w, b, q)) === turn) q.undelivered = true;
    c.turn = '';
    this.upsert(send, w);
    return { ended: true };
  }

  private qkey(w: Worker, b: CodexBatch, q: CodexQuestion): string {
    return `${w.id}\u0000${b.batch}\u0000${q.index}`;
  }

  private takeFail(w: Worker): Fail | null {
    const s = this.state(w.id);
    if (s.fail) {
      const f = s.fail;
      s.fail = null;
      return f;
    }
    for (const f of FAILS) if (this.h.takeFail(`async_${f}`)) return f;
    return null;
  }

  private answer(a: Obj, send: Send, ack: (d?: unknown) => void, fail: (e: unknown) => void): void {
    for (const k of Object.keys(a)) if (!['id', 'thread', 'batch', 'answers'].includes(k)) throw this.bad(`json: unknown field "${k}"`);
    if (typeof a.thread !== 'string' || !a.thread || typeof a.batch !== 'string' || !BATCH.test(a.batch)) throw this.bad('thread and batch (a question message id) are required');
    const answers = a.answers;
    if (!Array.isArray(answers) || !answers.length || answers.length > 16) throw this.bad(`answers must have 1-16 items, got ${Array.isArray(answers) ? answers.length : 0}`);
    const replies = answers.map((x, i) => {
      if (!isObj(x) || typeof x.index !== 'number' || !Number.isInteger(x.index)) throw this.bad(`answers[${i}].index is required`);
      const text = typeof x.answer === 'string' ? x.answer : '';
      if (bytes(text) > 4096 || CONTROL.test(text)) throw this.bad(`answers[${i}].answer must be at most 4096 bytes of UTF-8 without control characters but line ends and tabs, got ${bytes(text)} bytes`);
      return { index: x.index, text };
    });
    const w = this.find(a);
    const f = this.h.floors.get(w.session);
    if (!f || f.state !== 'running' || f.transition) throw this.h.error('invalid_state', `invalid state: ${w.session} is ${f?.transition ?? 'asleep'}`);
    const c = w.codex;
    if (c?.mode !== 'shared') throw this.h.error('invalid_state', `invalid state: ${w.name ?? w.id} is not a Codex worker with its own server`);
    if (c.thread !== a.thread) throw this.h.error('stale', `stale: ${w.name ?? w.id}'s thread is "${c.thread ?? ''}" now, not "${a.thread}"`);
    const b = c.questions?.find((x) => x.batch === a.batch);
    if (!b) throw this.h.error('stale', `stale: unknown batch "${a.batch}"`);
    if (b.conflict) throw this.h.error('invalid_state', `invalid state: batch ${b.batch} is a conflict: it cannot be answered`);
    const seen = new Set<number>();
    const qs = replies.map((r) => {
      const q = b.questions[r.index];
      if (!q || seen.has(r.index)) throw this.bad(`answers: question ${r.index} is not one of the batch's, or named twice`);
      seen.add(r.index);
      if (!(q.state === 'pending' || (q.state === 'sent' && q.undelivered))) throw this.h.error('stale', `stale: question ${r.index} of ${b.batch} is ${q.state}`);
      if (q.options?.length ? !q.options.includes(r.text) : !r.text.trim()) throw this.bad(`answers: question ${r.index} takes ${q.options?.length ? 'one of its options exactly' : 'text that is not blank'}`);
      return [q, r.text] as const;
    });
    if (!c.attached) throw this.h.error('invalid_state', 'invalid state: the bridge is not attached to the worker\'s thread (its server: running)');
    const failure = this.takeFail(w);
    if (failure === 'stale') throw this.h.error('stale', `stale: question ${replies[0]?.index ?? 0} of ${b.batch} is sending (simulated)`);
    for (const [q] of qs) {
      q.state = 'sending';
      delete q.error;
      delete q.undelivered;
      delete q.unconfirmed;
    }
    this.upsert(send, w);
    const turn = c.turn ?? '';
    const via = turn ? 'turn/steer' : 'turn/start';
    const reached = turn || `turn-${Math.floor(this.h.now())}`;
    this.h.after(this.h.stepMs, () => {
      if (failure === 'input_failed') {
        for (const [q] of qs) Object.assign(q, { state: 'pending', error: `${via} refused the answer: the server is busy (simulated)` });
        this.upsert(send, w);
        fail(this.h.error('input_failed', `input_failed: ${via} refused the answer: the server is busy (simulated)`));
        return;
      }
      for (const [q] of qs) {
        q.state = 'sent';
        if (failure === 'unconfirmed') q.unconfirmed = true;
        this.sentTo.set(this.qkey(w, b, q), reached);
      }
      if (!turn && failure !== 'unconfirmed') c.turn = reached; // turn/start began a turn
      this.upsert(send, w);
      ack(failure === 'unconfirmed' ? { state: 'sent', via, unconfirmed: true } : { state: 'sent', via, turn: reached });
      if (failure === 'undelivered') {
        this.h.after(this.h.stepMs, () => this.turnEnd(w, send));
        return;
      }
      if (failure === 'unconfirmed' || !this.state(w.id).deliver) return;
      this.h.after(this.deliverMs, () => {
        let changed = false;
        for (const [q, text] of qs) {
          if (q.state !== 'sent' || q.undelivered) continue;
          Object.assign(q, { state: 'answered', answer: text, answered_by: 'bridge' });
          changed = true;
        }
        if (changed) this.upsert(send, w);
      });
    });
  }

  private dismiss(a: Obj, send: Send): undefined {
    for (const k of Object.keys(a)) if (!['id', 'thread', 'batch', 'indexes'].includes(k)) throw this.bad(`json: unknown field "${k}"`);
    if (typeof a.thread !== 'string' || !a.thread || typeof a.batch !== 'string' || !BATCH.test(a.batch)) throw this.bad('thread and batch (a question message id) are required');
    const w = this.find(a);
    const c = w.codex;
    if (c?.mode !== 'shared') throw this.h.error('invalid_state', `invalid state: ${w.name ?? w.id} is not a Codex worker with its own server`);
    if (c.thread !== a.thread) throw this.h.error('stale', `stale: ${w.name ?? w.id}'s thread is "${c.thread ?? ''}" now, not "${a.thread}"`);
    const b = c.questions?.find((x) => x.batch === a.batch);
    if (!b) throw this.h.error('stale', `stale: unknown batch "${a.batch}"`);
    const can = (q: CodexQuestion) => q.state === 'pending' || q.state === 'sent';
    let qs: CodexQuestion[];
    if (Array.isArray(a.indexes)) {
      qs = a.indexes.map((i) => {
        const q = typeof i === 'number' ? b.questions[i] : undefined;
        if (!q || !can(q)) throw this.h.error('stale', `stale: question ${String(i)} of ${b.batch} cannot be dismissed`);
        return q;
      });
    } else qs = b.questions.filter(can);
    for (const q of qs) q.state = 'dismissed';
    this.upsert(send, w);
    return undefined;
  }
}
