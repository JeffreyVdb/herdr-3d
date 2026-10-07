// #90: follow-up questions for the fixture server's `sim=1` (tools/fixture-sim.ts hands these commands over). Rules,
// like herdr-world's (docs/protocol.md "Follow-up questions"):
// - the snapshot's `followups` is the feature's state (absent with `simai=off` or `simfail=no_ai`): `off` until
//   `followups.set {enabled: true}`, which is `test_required` unless `followups.test` passed with the models in use
//   (tools/fixture-ai.ts), `incomplete` (with `missing`) while a model is not ready; every change is a
//   `followups.update` with the state flat in it;
// - `followups.test` runs the two sample messages through the pipeline: the classifier (Jev at `simjev=<url>`) and
//   the LLM (the AI integration's endpoint), really called, like the bridge;
// - `sim.turn {id, text}` (the simulator's own, not a bridge command) plays a worker's agent ending its turn with
//   `text`: an assistant item in its transcript (pushed to a watch of it) and, when the feature is `ready` and the
//   worker is no freelancer, the pipeline: a score at or over the threshold gets it a `followup` (a worker.upsert);
//   the ack says `{flagged}`;
// - `worker.answer_followup {id, turn_id, answers}` checks like the bridge (`stale`, `bad_request`), clears the
//   follow-up (the upsert first) and sends the formatted answers as one `worker.prompt` (tools/fixture-panels.ts:
//   with `simecho=<ms>` the prompt's user item reaches the transcript); `worker.dismiss_followup` clears it;
// - a `worker.prompt` or `worker.keys` to the worker clears it too.
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import type { Followup, FollowupQuestion, TranscriptItem, Worker } from '../src/net/protocol.ts';
import type { AiSim } from './fixture-ai.ts';

type Obj = Record<string, unknown>;
type Send = (m: Obj) => void;

export interface FollowupHost {
  readonly workers: Worker[];
  readonly ai: AiSim;
  emit(send: Send, m: Obj): void;
  error(code: string, message: string): Error;
  now(): number;
  /** Pushes to the worker's transcript watch (false: not watched). */
  push(id: string, items: TranscriptItem[], updates: TranscriptItem[]): boolean;
  nextSeq(id: string): number;
  /** The bridge's worker.prompt. */
  prompt(a: Obj, send: Send, ack: (d?: unknown) => void, fail: (e: unknown) => void): void;
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const GATE =
  'Does the message ask the user one or more questions or decisions they are expected to answer, even when the agent proposes a recommended answer for each?';
const SAMPLE_QUESTIONS =
  'I refactored the session loader and all tests pass.\n\n## Open questions for you\n- Does the legacy importer still need the v1 format?\n- Do you want to ship this already, or wait for the e2e-live run?';
const SAMPLE_DONE = 'Done, PR merged. CI is green and the branch is deleted.';
const FREELANCERS = ['code', 'review', 'ux', 'ground'];

interface Run {
  score: number;
  flagged: boolean;
  questions?: FollowupQuestion[];
  source?: 'model' | 'fallback';
  error?: string;
}

/** The LLM's answer, validated like internal/followup.Parse (null: invalid, the fallback stands in). */
export function parseQuestions(text: string): FollowupQuestion[] | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const qs = isObj(raw) && Array.isArray(raw.questions) ? raw.questions : null;
  if (!qs || qs.length < 1 || qs.length > 8) return null;
  const out: FollowupQuestion[] = [];
  for (const [i, q] of qs.entries()) {
    if (!isObj(q) || typeof q.question !== 'string') return null;
    const question = q.question.replace(/\s+/g, ' ').trim();
    if (!question || [...question].length > 300) return null;
    if (q.kind === 'yes_no' || q.kind === 'open') out.push({ id: `q${i + 1}`, question, kind: q.kind });
    else if (q.kind === 'choice' && Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 8 && q.options.every((o) => typeof o === 'string' && o.trim()))
      out.push({ id: `q${i + 1}`, question, kind: 'choice', options: (q.options as string[]).map((o) => o.trim()) });
    else return null;
  }
  return out;
}

export class FollowupSim {
  private enabled = false;
  private threshold = 0.7;
  private passed: { fp: string; at: number } | null = null;
  private last = '';
  private turns = 0;

  constructor(private readonly h: FollowupHost) {}

  private missing(): Array<'classifier' | 'llm'> {
    return (['classifier', 'llm'] as const).filter((r) => !this.h.ai.ready(r));
  }

  private fp(): string {
    return this.h.ai.fingerprint('classifier') + '|' + this.h.ai.fingerprint('llm');
  }

  private tested(): boolean {
    return !!this.passed && this.passed.fp === this.fp() && this.h.now() - this.passed.at <= 30 * 60_000;
  }

  view(): Obj {
    const missing = this.missing();
    const state = !this.enabled ? 'off' : missing.length ? 'incomplete' : 'ready';
    const view = this.h.ai.view() as { classifier: { state: string }; llm: { state: string } };
    return {
      enabled: this.enabled,
      threshold: this.threshold,
      state,
      ...(missing.length ? { missing } : {}),
      roles: { classifier: view.classifier.state, llm: view.llm.state },
      env: [],
      tested: this.tested(),
    };
  }

  decorate(world: Obj): void {
    if (this.h.ai.present) world.followups = this.view();
  }

  /** Emits followups.update when the state changed (also after the AI integration's). */
  changed(send: Send): void {
    const v = JSON.stringify(this.view());
    if (v === this.last) return;
    this.last = v;
    this.h.emit(send, { t: 'followups.update', ...this.view() });
  }

  private worker(a: Obj): Worker {
    const w = this.h.workers.find((x) => x.id === a.id);
    if (!w) throw this.h.error('unknown_worker', `unknown worker: "${String(a.id)}"`);
    return w;
  }

  private setFollowup(send: Send, w: Worker, f: Followup | null): void {
    if (!f && !w.followup) return;
    if (f) w.followup = f;
    else delete w.followup;
    this.h.emit(send, { t: 'worker.upsert', worker: structuredClone(w) });
  }

  /** A prompt or keys went to the worker: its follow-up is moot. */
  clear(id: unknown, send: Send): void {
    const w = this.h.workers.find((x) => x.id === id);
    if (w?.followup) this.setFollowup(send, w, null);
  }

  /** The AI integration's error (its own class) as the simulator's. */
  private conv(e: unknown): unknown {
    return e instanceof Error && typeof (e as Error & { code?: unknown }).code === 'string' ? this.h.error((e as Error & { code: string }).code, e.message) : e;
  }

  private async pipeline(text: string, threshold: number): Promise<Run> {
    const score = await this.h.ai.classify({ last_agent_message: text.slice(-96_000) }, GATE);
    if (score < threshold) return { score, flagged: false };
    try {
      const out = await this.h.ai.complete(
        [
          { role: 'system', content: 'List the questions the agent asks the user, as {"questions":[{"question","kind":"yes_no"|"choice"|"open","options":[]}]}.' },
          { role: 'user', content: `The agent's final message:\n\n${text}` },
        ],
        true,
      );
      const qs = parseQuestions(out);
      if (qs) return { score, flagged: true, questions: qs, source: 'model' };
      return { score, flagged: true, questions: [{ id: 'q1', question: 'The agent asked you something', kind: 'open' }], source: 'fallback', error: 'the LLM did not answer with a question list' };
    } catch (e) {
      return { score, flagged: true, questions: [{ id: 'q1', question: 'The agent asked you something', kind: 'open' }], source: 'fallback', error: e instanceof Error ? e.message : String(e) };
    }
  }

  private prompt(f: Followup, answers: unknown): string {
    if (!Array.isArray(answers) || !answers.length) throw this.h.error('bad_request', 'bad args: answers must answer at least one question');
    const by = new Map<string, { value: string; note: string }>();
    for (const [i, x] of answers.entries()) {
      if (!isObj(x) || typeof x.id !== 'string' || !f.questions.some((q) => q.id === x.id) || by.has(x.id)) throw this.h.error('bad_request', `bad args: answers[${i}].id is not a question of this follow-up`);
      const value = typeof x.value === 'string' ? x.value.trim() : '';
      const note = typeof x.note === 'string' ? x.note.trim() : '';
      if (!value && !note) throw this.h.error('bad_request', `bad args: answers[${i}] is empty`);
      by.set(x.id, { value, note });
    }
    const join = (a: { value: string; note: string }) => (!a.value ? a.note : !a.note ? a.value : `${a.value} ${a.note}`);
    if (f.source === 'fallback' && f.questions.length === 1) return join(by.get(f.questions[0]!.id)!);
    const lines = ['Answers to your open questions:'];
    f.questions.forEach((q, i) => {
      const a = by.get(q.id);
      if (!a) return;
      if (q.kind === 'yes_no' && !['yes', 'no'].includes(a.value.toLowerCase())) throw this.h.error('bad_request', `bad args: question ${q.id} is yes or no`);
      lines.push(`${i + 1}. ${q.question} → ${join(a)}`);
    });
    return lines.join('\n');
  }

  handle(t: unknown, a: Obj, send: Send, ack: (d?: unknown) => void, fail: (e: unknown) => void): boolean {
    const ours = ['followups.get', 'followups.set', 'followups.test', 'worker.answer_followup', 'worker.dismiss_followup', 'sim.turn'];
    if (typeof t !== 'string' || !ours.includes(t)) return false;
    if (t.startsWith('followups.') && !this.h.ai.present) throw this.h.error('unsupported', 'unsupported: the bridge has no AI integration');
    switch (t) {
      case 'followups.get':
        ack(this.view());
        return true;
      case 'followups.set': {
        const th = a.threshold;
        if (th !== undefined && (typeof th !== 'number' || th < 0.05 || th > 0.99)) throw this.h.error('bad_request', 'threshold must be 0.05-0.99');
        if (a.enabled === true && !this.enabled) {
          if (this.missing().length) throw this.h.error('incomplete', 'follow-up questions need the classification model and the LLM to be ready');
          if (!this.tested()) throw this.h.error('test_required', 'run the follow-up test first: it must pass with the models in use');
        }
        if (typeof a.enabled === 'boolean') this.enabled = a.enabled;
        if (typeof th === 'number') this.threshold = th;
        this.changed(send);
        ack(this.view());
        return true;
      }
      case 'followups.test': {
        if (this.missing().length) throw this.h.error('incomplete', 'the follow-up test needs the classification model and the LLM to be ready');
        const th = typeof a.threshold === 'number' ? a.threshold : this.threshold;
        const fp = this.fp();
        const t0 = Date.now();
        void (async () => {
          const q = await this.pipeline(SAMPLE_QUESTIONS, th);
          const d = await this.pipeline(SAMPLE_DONE, th);
          const samples = [
            { name: 'questions', expect: 'flag', ...q },
            { name: 'done', expect: 'skip', ...d },
          ];
          let reason: string | undefined;
          if (!q.flagged) reason = `the message with questions scored ${q.score.toFixed(2)}, under the threshold ${th.toFixed(2)}`;
          else if (d.flagged) reason = `the message without questions scored ${d.score.toFixed(2)}, at or over the threshold ${th.toFixed(2)}`;
          else if (q.source !== 'model') reason = `the LLM did not extract the questions: ${q.error ?? ''}`;
          if (!reason) this.passed = { fp, at: this.h.now() };
          this.changed(send);
          return { ok: !reason, ...(reason ? { reason } : {}), threshold: th, samples, latency_ms: Date.now() - t0 };
        })().then(ack, (e) => fail(this.conv(e)));
        return true;
      }
      case 'sim.turn': {
        const w = this.worker(a);
        const text = typeof a.text === 'string' ? a.text : '';
        const item: TranscriptItem = { id: `sim-turn-${++this.turns}`, seq: this.h.nextSeq(w.id), ts: this.h.now(), kind: 'assistant', parts: [{ text }] };
        this.h.push(w.id, [item], []);
        const ready = !this.missing().length && this.enabled;
        if (!ready || !text.trim() || w.ask || w.status === 'blocked' || FREELANCERS.includes(w.role ?? '')) {
          ack({ flagged: false });
          return true;
        }
        const turnId = `sim${String(this.turns).padStart(14, '0')}`;
        this.pipeline(text, this.threshold).then(
          (r) => {
            if (r.flagged && r.questions) {
              const f: Followup = { turn_id: turnId, questions: r.questions, score: r.score, source: r.source ?? 'model', at: this.h.now() };
              if (r.source === 'fallback') f.tail = text.slice(-1200);
              this.setFollowup(send, w, f);
            }
            ack({ flagged: r.flagged });
          },
          (e) => fail(this.conv(e)),
        );
        return true;
      }
      case 'worker.dismiss_followup': {
        const w = this.worker(a);
        if (!w.followup || w.followup.turn_id !== a.turn_id) throw this.h.error('stale', 'stale: the worker has no open follow-up of that turn');
        this.setFollowup(send, w, null);
        ack();
        return true;
      }
      default: {
        // worker.answer_followup
        const w = this.worker(a);
        if (!w.followup || w.followup.turn_id !== a.turn_id) throw this.h.error('stale', 'stale: the worker has no open follow-up of that turn');
        const text = this.prompt(w.followup, a.answers);
        this.setFollowup(send, w, null);
        this.h.prompt({ id: w.id, text }, send, ack, fail);
        return true;
      }
    }
  }
}
