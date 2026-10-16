// #57: agents' structured questions for the fixture server's `sim=1` (tools/fixture-sim.ts hands these commands
// over). Rules, like herdr-world's (docs/protocol.md "Laptops: asks"):
// - `sim.ask {id, ask}` (the simulator's own, not a bridge command): the worker gets `ask` (a `worker.upsert`, its
//   status left as it is: herdr may call it idle) and its transcript the pending call as a tool item (id = the ask's
//   tool_use_id, `tool.ask` outcome `pending`), pushed to a watch of it, or in the timeline of the next watch.
//   `{id, ask: null, answers?}` ends it as the terminal would: the upsert without it, and the item updated
//   (`answered` with `answers`, `[{question, answer}]`, else `declined`).
// - `worker.answer_ask {id, tool_use_id, answers? | cancel, prompt?}`: validated like the bridge (`bad_request`;
//   `stale` when the worker asks nothing or something else); a worker on a sleeping floor is `invalid_state`.
//   One step later the ask goes (the upsert first, as the bridge sends it before its ack), the item gets the answers
//   (labels joined with ", " like Claude, the typed text), and the ack says `{sent, resolved: true}` (the keys the
//   bridge would press; typed text is "text"). A cancel with a prompt starts the agent working on it.
//   `simfail=answer_ask_failed` fails the next one with `input_failed` (the ask stays);
//   `simfail=answer_unresolved` acks it `resolved: false` and keeps the ask.
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import type { Ask, AskAnswer, AskQuestion, Floor, TranscriptAsk, TranscriptItem, Worker } from '../src/net/protocol.ts';

type Obj = Record<string, unknown>;
type Msg = Record<string, unknown>;
type Send = (m: Msg) => void;

export interface AskHost {
  readonly workers: Worker[];
  readonly floors: Map<string, Floor>;
  readonly stepMs: number;
  emit(send: Send, m: Msg): void;
  after(ms: number, fn: () => void): void;
  now(): number;
  takeFail(code: string): boolean;
  error(code: string, message: string): Error;
  /** Pushes to the worker's transcript watch (false: not watched). */
  push(id: string, items: TranscriptItem[], updates: TranscriptItem[]): boolean;
  nextSeq(id: string): number;
  /** The worker starts a turn (a cancel's prompt). */
  work(send: Send, w: Worker, title: string): void;
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export class AskSim {
  /** The ask calls of each worker's transcript, by worker id. */
  private readonly items = new Map<string, TranscriptItem[]>();

  private readonly h: AskHost;

  constructor(h: AskHost) {
    this.h = h;
  }

  /** The worker's ask items (the next transcript watch's timeline has them). */
  extra(id: string): TranscriptItem[] {
    return this.items.get(id) ?? [];
  }

  handle(t: unknown, a: Obj, send: Send, ack: (d?: unknown) => void, fail: (e: unknown) => void): boolean {
    if (t !== 'sim.ask' && t !== 'worker.answer_ask') return false;
    try {
      if (t === 'sim.ask') ack(this.sim(a, send));
      else this.answer(a, send, ack, fail);
    } catch (e) {
      fail(e);
    }
    return true;
  }

  private bad(m: string): Error {
    return this.h.error('bad_request', `bad args: ${m}`);
  }

  private worker(a: Obj): Worker {
    const id = a.id;
    if (typeof id !== 'string') throw this.bad('id must be a string');
    const w = this.h.workers.find((x) => x.id === id);
    if (!w) throw this.h.error('unknown_worker', `unknown worker: "${id}"`);
    const f = this.h.floors.get(w.session);
    if (!f || f.state !== 'running' || f.transition) throw this.h.error('invalid_state', `invalid state: ${w.session} is ${f?.transition ?? 'asleep'}`);
    return w;
  }

  private card(ask: Ask): TranscriptAsk {
    return { agent: ask.agent, questions: ask.questions, outcome: 'pending' };
  }

  private item(w: Worker, ask: Ask): TranscriptItem {
    const name = ask.agent === 'codex' ? 'request_user_input' : 'AskUserQuestion';
    const input = { questions: ask.questions.map((q) => ({ header: q.header, question: q.question, multiSelect: q.multi, options: q.options })) };
    return { id: ask.tool_use_id, seq: this.h.nextSeq(w.id), ts: ask.since, kind: 'tool', tool: { name, input_summary: '', input, status: 'running', ask: this.card(ask) } };
  }

  /** Ends the worker's ask: the upsert without it, its item answered (or dismissed). */
  private end(send: Send, w: Worker, outcome: string, answers: AskAnswer[]): void {
    const ask = w.ask;
    delete w.ask;
    this.h.emit(send, { t: 'worker.upsert', worker: w });
    if (!ask) return;
    const list = this.items.get(w.id) ?? [];
    const at = list.findIndex((it) => it.id === ask.tool_use_id);
    const old = list[at];
    if (!old?.tool) return;
    const status = outcome === 'answered' ? 'ok' : 'error';
    const next: TranscriptItem = { ...old, tool: { ...old.tool, status, ask: { ...(old.tool.ask as TranscriptAsk), outcome, answers } } };
    list[at] = next;
    this.h.push(w.id, [], [next]);
  }

  private sim(a: Obj, send: Send): Obj {
    const id = a.id;
    const w = this.h.workers.find((x) => x.id === id);
    if (!w) throw this.h.error('unknown_worker', `unknown worker: "${String(id)}"`);
    if (a.ask === null) {
      const answers = Array.isArray(a.answers) ? (a.answers as AskAnswer[]) : [];
      this.end(send, w, answers.length ? 'answered' : 'declined', answers);
      return { ended: true };
    }
    if (!isObj(a.ask)) throw this.bad('ask must be an object or null');
    const ask = { source: 'transcript', agent: 'claude', since: this.h.now(), ...a.ask } as Ask;
    w.ask = ask;
    this.h.emit(send, { t: 'worker.upsert', worker: w });
    const it = this.item(w, ask);
    const list = (this.items.get(w.id) ?? []).filter((x) => x.id !== it.id);
    list.push(it);
    this.items.set(w.id, list);
    this.h.push(w.id, [it], []);
    return { asked: ask.tool_use_id };
  }

  private answer(a: Obj, send: Send, ack: (d?: unknown) => void, fail: (e: unknown) => void): void {
    for (const k of Object.keys(a)) if (!['id', 'tool_use_id', 'answers', 'cancel', 'prompt'].includes(k)) throw this.bad(`json: unknown field "${k}"`);
    if (typeof a.tool_use_id !== 'string' || !a.tool_use_id) throw this.bad("tool_use_id must be the ask's tool_use_id");
    const cancel = a.cancel === true;
    const answers = Array.isArray(a.answers) ? (a.answers as Obj[]) : [];
    if (cancel === answers.length > 0) throw this.bad('want answers (one per question) or cancel: true');
    const prompt = typeof a.prompt === 'string' ? a.prompt : '';
    if (prompt && !cancel) throw this.bad('a prompt goes only with cancel');
    const w = this.worker(a);
    const ask = w.ask;
    if (!ask) throw this.h.error('stale', `stale: ${w.name ?? w.id} is not asking anything now`);
    if (ask.tool_use_id !== a.tool_use_id) throw this.h.error('stale', `stale: ${w.name ?? w.id} asks another question now (tool_use_id ${ask.tool_use_id})`);
    const recorded: AskAnswer[] = [];
    const sent: string[] = [];
    if (!cancel) {
      if (answers.length !== ask.questions.length) throw this.bad(`answers must answer each of the ${ask.questions.length} questions once, got ${answers.length}`);
      const seen = new Set<number>();
      for (const [i, x] of answers.entries()) {
        const qi = x.question;
        if (typeof qi !== 'number' || !Number.isInteger(qi) || qi < 0 || qi >= ask.questions.length || seen.has(qi)) throw this.bad(`answers[${i}].question must be a question's index, once each`);
        seen.add(qi);
        const q = ask.questions[qi] as AskQuestion;
        const choices = Array.isArray(x.choices) ? (x.choices as unknown[]) : [];
        if (!choices.every((c) => typeof c === 'number' && Number.isInteger(c) && c >= 1 && c <= q.options.length) || new Set(choices).size !== choices.length) throw this.bad(`answers[${i}].choices must be option numbers 1-${q.options.length}, once each`);
        const other = x.other;
        if (other !== undefined && (typeof other !== 'string' || !other.trim() || !q.other || /[\u0000-\u001f\u007f]/.test(other))) throw this.bad(`answers[${i}].other must be one line of text, on a question that takes one`);
        const n = choices.length + (other !== undefined ? 1 : 0);
        if (!n) throw this.bad(`answers[${i}] picks nothing`);
        if (!q.multi && n > 1) throw this.bad(`question ${qi} takes one answer`);
        const labels = (choices as number[]).map((c) => q.options[c - 1]?.label ?? String(c));
        const parts = other !== undefined ? [...labels, other.trim()] : labels;
        recorded.push({ question: qi, answer: parts.join(', '), labels, ...(other !== undefined ? { other: other.trim() } : {}) });
        if (q.multi) {
          for (const c of choices as number[]) sent.push(String(c));
          if (other !== undefined) sent.push('down', 'text', 'tab', 'enter');
          else sent.push('right');
        } else if (other !== undefined) sent.push(String(q.options.length + 1), 'text', 'enter');
        else sent.push(String(choices[0]));
      }
      recorded.sort((x, y) => x.question - y.question);
      if (ask.questions.length > 1 || ask.questions.some((q) => q.multi)) sent.push('enter');
    } else sent.push('esc');
    if (this.h.takeFail('answer_ask_failed')) {
      this.h.after(this.h.stepMs, () => fail(this.h.error('input_failed', `input_failed: the dialog did not show question 1 (keys sent: ); look at the terminal (simulated)`)));
      return;
    }
    if (this.h.takeFail('answer_unresolved')) {
      this.h.after(this.h.stepMs, () => ack({ sent, resolved: false }));
      return;
    }
    this.h.after(this.h.stepMs, () => {
      if (w.ask?.tool_use_id !== ask.tool_use_id) return fail(this.h.error('stale', 'stale: the question was answered or replaced meanwhile (no more keys pressed)'));
      this.end(send, w, cancel ? 'declined' : 'answered', recorded);
      if (cancel && prompt) this.h.work(send, w, prompt.split('\n')[0]?.slice(0, 80) ?? '');
      ack({ sent, resolved: true, ...(cancel && prompt ? { prompted: true } : {}) });
    });
  }
}
