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
// - a `worker.prompt` or `worker.keys` to the worker clears it too;
// - #60: `simfollowup=grill` seeds Pebble (demo-m5) with the incident's grill round as the bridge reads it
//   (game/fixtures/followup-grill.json: ten questions, Q8–Q17, with their recommendations), `simfollowup=fallback` with
//   that round's fallback (the budget ran out), whose Retry then reads the round (`simfollowupretry=fail`: it falls
//   back again, at most 3 times); neither needs the AI integration set up. `worker.followup_message` answers the message
//   a follow-up is of (`sim.turn`'s text, or the seeded round), `worker.retry_followup` reads it again like the bridge
//   (the round as it is, else the LLM), and `followups.test` runs the grill round through the LLM too.
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import { readFileSync } from 'node:fs';
import type { Followup, FollowupQuestion, FollowupRecommendation, TranscriptItem, Worker } from '../src/net/protocol.ts';
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

/** #60: the incident's round (the bridge's own sample) and what the bridge reads of it. */
const fromRoot = (p: string) => new URL(`../../${p}`, import.meta.url);
export const GRILL_TEXT = readFileSync(fromRoot('internal/followup/grill_sample.md'), 'utf8');
const GRILL = JSON.parse(readFileSync(fromRoot('game/fixtures/followup-grill.json'), 'utf8')) as Followup;
const BUDGET = 'the model used its whole completion budget (8192 of 8192 tokens, 8192 of them reasoning) before writing any text: raise the completion budget or lower the reasoning effort';
const FALLBACK_Q: FollowupQuestion[] = [{ id: 'q1', question: 'The agent asked you something', kind: 'open' }];

interface Run {
  score: number;
  flagged: boolean;
  questions?: FollowupQuestion[];
  source?: 'parsed' | 'model' | 'fallback';
  error?: string;
  unlisted?: number;
}

/**
 * The LLM's answer, validated like internal/followup.Parse (null: no valid question, the fallback stands in): up to 16
 * questions (the rest and the reported `more` counted), an invalid one left out and counted, a choice with bad options
 * open; #60's label, context and recommendation kept.
 */
export function parseQuestions(text: string): { questions: FollowupQuestion[]; unlisted: number } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const all = isObj(raw) && Array.isArray(raw.questions) ? raw.questions : null;
  if (!all || !all.length) return null;
  let unlisted = Math.min(100, Math.max(0, isObj(raw) && typeof raw.more === 'number' ? Math.floor(raw.more) : 0)) + Math.max(0, all.length - 16);
  const out: FollowupQuestion[] = [];
  const md = (v: unknown, n: number) => (typeof v === 'string' ? [...v.replace(/\r\n/g, '\n').trim()].slice(0, n).join('') : '');
  for (const q of all.slice(0, 16)) {
    const question = isObj(q) && typeof q.question === 'string' ? q.question.replace(/\s+/g, ' ').trim() : '';
    if (!isObj(q) || !question || [...question].length > 300 || !['yes_no', 'choice', 'open'].includes(String(q.kind))) {
      unlisted++;
      continue;
    }
    const x: FollowupQuestion = { id: `q${out.length + 1}`, question, kind: q.kind as FollowupQuestion['kind'] };
    const label = typeof q.label === 'string' ? q.label.trim() : '';
    if (/^[A-Za-z#]{0,3}\d{1,3}[a-z]?$/.test(label)) x.label = label;
    let context = md(q.context, 1200);
    if (q.kind === 'choice') {
      const opts = Array.isArray(q.options) ? q.options.map((o) => (typeof o === 'string' ? o.replace(/\s+/g, ' ').trim() : '')) : [];
      if (opts.length >= 2 && opts.length <= 8 && opts.every((o) => o && [...o].length <= 300)) x.options = opts;
      else {
        x.kind = 'open';
        context = [context, opts.filter(Boolean).map((o) => `- ${o}`).join('\n')].filter(Boolean).join('\n\n');
      }
    }
    if (context) x.context = context;
    const rec = md(q.recommendation, 1200);
    if (rec) {
      const r: FollowupRecommendation = { text: rec };
      const why = md(q.why, 600);
      if (why) r.why = why;
      const k = typeof q.recommended_option === 'number' ? q.recommended_option - 1 : -1;
      if (x.options && k >= 0 && k < x.options.length) r.option = k;
      x.recommendation = r;
    }
    out.push(x);
  }
  return out.length ? { questions: out, unlisted } : null;
}

export class FollowupSim {
  private enabled = false;
  private threshold = 0.7;
  private passed: { fp: string; at: number } | null = null;
  private last = '';
  private turns = 0;
  /** #60: the message each worker's follow-up is of, and the retries that fail (`simfollowupretry=fail`). */
  private readonly texts = new Map<string, string>();
  private retryFails = false;

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
    else {
      delete w.followup;
      this.texts.delete(w.id);
    }
    this.h.emit(send, { t: 'worker.upsert', worker: structuredClone(w) });
  }

  /**
   * #60: `simfollowup=grill|fallback`: Pebble starts with the grill round, read or fallen back (`fallback-fail`: its
   * retries fail too). Its upsert is in the snapshot: no event.
   */
  seed(mode: string): void {
    const w = this.h.workers.find((x) => x.name === 'Pebble') ?? this.h.workers[0];
    if (!w) return;
    this.retryFails = mode === 'fallback-fail';
    const at = this.h.now() - 90_000;
    this.texts.set(w.id, GRILL_TEXT);
    w.followup =
      mode === 'grill'
        ? { ...structuredClone(GRILL), at }
        : { turn_id: GRILL.turn_id, questions: structuredClone(FALLBACK_Q), score: GRILL.score, source: 'fallback', at, tail: GRILL_TEXT.slice(-1200), error: BUDGET };
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

  private async pipeline(text: string, threshold: number, llmOnly = false): Promise<Run> {
    const score = await this.h.ai.classify({ last_agent_message: text.slice(-96_000) }, GATE);
    if (score < threshold) return { score, flagged: false };
    return { score, ...(await this.extract(text, llmOnly)) };
  }

  /** The extraction like the bridge's: the grill round as it is (the only one this simulator reads), else the LLM. */
  private async extract(text: string, llmOnly = false): Promise<Omit<Run, 'score'>> {
    if (!llmOnly && text === GRILL_TEXT) return { flagged: true, questions: structuredClone(GRILL.questions), source: 'parsed' };
    try {
      const out = await this.h.ai.complete(
        [
          { role: 'system', content: 'List the questions the agent asks the user, as {"questions":[{"question","kind":"yes_no"|"choice"|"open","options":[]}]}.' },
          { role: 'user', content: `The agent's final message:\n\n${text}` },
        ],
        true,
      );
      const qs = parseQuestions(out);
      if (qs) return { flagged: true, questions: qs.questions, source: 'model', ...(qs.unlisted ? { unlisted: qs.unlisted } : {}) };
      return { flagged: true, questions: structuredClone(FALLBACK_Q), source: 'fallback', error: 'the LLM did not answer with a question list' };
    } catch (e) {
      return { flagged: true, questions: structuredClone(FALLBACK_Q), source: 'fallback', error: e instanceof Error ? e.message : String(e) };
    }
  }

  private prompt(f: Followup, answers: unknown, note: unknown): string {
    const extra = typeof note === 'string' ? note.replace(/\r\n/g, '\n').trim() : '';
    if (!Array.isArray(answers) || (!answers.length && !extra)) throw this.h.error('bad_request', 'bad args: answers must answer at least one question');
    const by = new Map<string, { value: string; note: string }>();
    for (const [i, x] of answers.entries()) {
      if (!isObj(x) || typeof x.id !== 'string' || !f.questions.some((q) => q.id === x.id) || by.has(x.id)) throw this.h.error('bad_request', `bad args: answers[${i}].id is not a question of this follow-up`);
      const value = typeof x.value === 'string' ? x.value.replace(/\r\n/g, '\n').trim() : '';
      const note = typeof x.note === 'string' ? x.note.replace(/\r\n/g, '\n').trim() : '';
      if (!value && !note) throw this.h.error('bad_request', `bad args: answers[${i}] is empty`);
      by.set(x.id, { value, note });
    }
    const join = (a: { value: string; note: string }) => (!a.value ? a.note : !a.note ? a.value : `${a.value} ${a.note}`);
    const withNote = (t: string) => (!extra ? t : !t ? extra : `${t}\n\n${extra}`);
    if (f.source === 'fallback' && f.questions.length === 1) {
      const a = by.get(f.questions[0]!.id);
      return withNote(a ? join(a) : '');
    }
    const lines = ['Answers to your open questions:'];
    const left: string[] = [];
    f.questions.forEach((q, i) => {
      const a = by.get(q.id);
      if (!a) return void left.push(q.label ?? String(i + 1));
      if (q.kind === 'yes_no' && !['yes', 'no'].includes(a.value.toLowerCase())) throw this.h.error('bad_request', `bad args: question ${q.id} is yes or no`);
      const r = q.recommendation;
      const recommended =
        !!r && !a.note && (q.kind === 'choice' && r.option !== undefined ? a.value === q.options?.[r.option] : q.kind === 'open' && a.value === r.text.trim());
      const v = join(a) + (recommended ? ' (your recommendation)' : '');
      lines.push(q.label ? `- ${q.label} ${q.question} → ${v}` : `${i + 1}. ${q.question} → ${v}`);
    });
    if (left.length) lines.push(`Unanswered: ${left.join(', ')}`);
    return withNote(lines.join('\n'));
  }

  /** #60: `worker.retry_followup`, like the bridge's: a fallback's extraction again, at most 3 times; the next follow-up. */
  private async retry(w: Worker, f: Followup): Promise<Followup> {
    const text = this.texts.get(w.id) ?? '';
    let ex: Omit<Run, 'score'>;
    if (this.retryFails) ex = { flagged: true, questions: structuredClone(FALLBACK_Q), source: 'fallback', error: BUDGET };
    else if (text === GRILL_TEXT) ex = await this.extract(text);
    else if (!this.missing().length && this.enabled) ex = await this.extract(text);
    else throw this.h.error('invalid_state', 'invalid state: follow-up questions are not ready (switched off, or a model is not ready)');
    if (w.followup?.turn_id !== f.turn_id) throw this.h.error('stale', 'stale: the questions were answered, dismissed or replaced meanwhile');
    const next: Followup = { ...f, questions: ex.questions ?? structuredClone(FALLBACK_Q), source: ex.source ?? 'fallback', retries: (f.retries ?? 0) + 1 };
    delete next.error;
    delete next.unlisted;
    if (ex.error) next.error = ex.error;
    if (ex.unlisted) next.unlisted = ex.unlisted;
    if (next.source !== 'fallback') delete next.tail;
    return next;
  }

  handle(t: unknown, a: Obj, send: Send, ack: (d?: unknown) => void, fail: (e: unknown) => void): boolean {
    const ours = ['followups.get', 'followups.set', 'followups.test', 'worker.answer_followup', 'worker.dismiss_followup', 'worker.retry_followup', 'worker.followup_message', 'sim.turn'];
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
          const g = await this.pipeline(GRILL_TEXT, th, true); // #60: the LLM itself, never the round reader
          const samples = [
            { name: 'questions', expect: 'flag', ...q },
            { name: 'grill', expect: 'flag', ...g },
            { name: 'done', expect: 'skip', ...d },
          ];
          let reason: string | undefined;
          const recs = g.questions?.filter((x) => x.recommendation).length ?? 0;
          if (!q.flagged) reason = `the message with questions scored ${q.score.toFixed(2)}, under the threshold ${th.toFixed(2)}`;
          else if (d.flagged) reason = `the message without questions scored ${d.score.toFixed(2)}, at or over the threshold ${th.toFixed(2)}`;
          else if (q.source !== 'model') reason = `the LLM did not extract the questions: ${q.error ?? ''}`;
          else if (!g.flagged) reason = `the grill round scored ${g.score.toFixed(2)}, under the threshold ${th.toFixed(2)}`;
          else if (g.source !== 'model') reason = `the LLM did not extract the grill round: ${g.error ?? ''}`;
          else if (g.questions?.length !== 10) reason = `the LLM listed ${g.questions?.length ?? 0} of the grill round's 10 questions`;
          else if (recs !== 10) reason = `the LLM kept no recommendation for ${10 - recs} of the grill round's 10 questions`;
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
              if (r.source === 'fallback') {
                f.tail = text.slice(-1200);
                if (r.error) f.error = r.error;
              }
              if (r.unlisted) f.unlisted = r.unlisted;
              this.setFollowup(send, w, f);
              this.texts.set(w.id, text);
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
      case 'worker.followup_message': {
        const w = this.worker(a);
        if (!w.followup || w.followup.turn_id !== a.turn_id) throw this.h.error('stale', 'stale: the worker has no open follow-up of that turn');
        const text = this.texts.get(w.id) ?? w.followup.tail ?? '';
        ack({ text: text.slice(-96_000), ...(text.length > 96_000 ? { cut: true } : {}) });
        return true;
      }
      case 'worker.retry_followup': {
        const w = this.worker(a);
        const f = w.followup;
        if (!f || f.turn_id !== a.turn_id) throw this.h.error('stale', 'stale: the worker has no open follow-up of that turn');
        if (f.source !== 'fallback') throw this.h.error('bad_request', 'bad args: its questions were read: there is nothing to retry');
        if ((f.retries ?? 0) >= 3) throw this.h.error('invalid_state', `invalid state: retried ${f.retries} times already: answer in your own words, or read the whole message`);
        this.retry(w, f).then(
          (next) => {
            this.setFollowup(send, w, next);
            ack({ source: next.source, ...(next.error ? { error: next.error } : {}) });
          },
          (e) => fail(this.conv(e)),
        );
        return true;
      }
      default: {
        // worker.answer_followup
        const w = this.worker(a);
        if (!w.followup || w.followup.turn_id !== a.turn_id) throw this.h.error('stale', 'stale: the worker has no open follow-up of that turn');
        const text = this.prompt(w.followup, a.answers, a.note);
        this.setFollowup(send, w, null);
        this.h.prompt({ id: w.id, text }, send, ack, fail);
        return true;
      }
    }
  }
}
