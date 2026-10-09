// #213: `hire.interpret` for the fixture server's `sim=1` (tools/fixture-sim.ts hands it over), so the game's dictation
// bar can be driven end to end against fake providers. It is not the bridge's interpreter (internal/hireintent): no
// resolution rule is ported here. The LLM's answer is the final result, and the fixture only checks it and passes it on:
// - one call through the AI integration (tools/fixture-ai.ts `complete`, JSON mode) to the LLM endpoint the game set up
//   (the e2e's fake OpenAI-compatible server). The user message is JSON `{command, pending_hire, hire_options}`: the text,
//   the pending proposal as the game sent it (null without one; the bridge sends only its sources) and the catalog;
// - the answer must be `{intent: "hire" | "unsupported" | "unclear", reason?: "multiple", hire?}`, with `hire` (an
//   Interpretation whose dictated task is exactly its span of the sources) for `hire` only; anything else is
//   `bad_answer` (`bad_span` for a task not in the sentences). The ack echoes `text`, and the proposal's `sources` are
//   the pending ones plus `text` (only `text` without one), as the bridge makes them;
// - errors are acks `{text, error: {code, message}}`, as the bridge's: `not_ready` (no LLM ready, or no AI integration),
//   `provider_failed` (the endpoint answered non-200), `unreachable`, `bad_response`, and `timeout` when the answer takes
//   longer than the bound (35 s like the bridge; `sim.interpret {timeout_ms}` changes it, the simulator's own command);
// - the command itself fails only on its args (`bad_request`: unknown fields, a text that is empty, over 8 KiB or with
//   NUL); a pending proposal that is not one, or one with 6 sources already, is the ack's `bad_pending`, with no call.
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import type { HireOptions } from '../src/net/protocol.ts';
import type { AiSim } from './fixture-ai.ts';

type Obj = Record<string, unknown>;

export interface InterpretHost {
  readonly ai: AiSim;
  /** The launch catalog as the fixture's `hire.prepare` and snapshot have it. */
  hireOptions(): HireOptions;
  error(code: string, message: string): Error;
}

const MAX_TEXT = 8 * 1024;
const MAX_SOURCES = 6;
const PROVENANCE = ['dictated', 'resolved', 'missing', 'invalid'];
const INTENTS = ['hire', 'unsupported', 'unclear'];

/** Fixed messages, as the bridge's (never the provider's words). */
const MESSAGE: Record<string, string> = {
  not_ready: 'no LLM is ready to interpret commands',
  timeout: 'the LLM did not answer in time',
  provider_failed: 'the LLM provider failed',
  unreachable: 'the LLM endpoint cannot be reached',
  bad_response: 'the LLM answer was not usable',
  bad_answer: 'the LLM answer is not a valid interpretation',
  bad_span: 'the task is not a part of what was said',
  bad_pending: 'the pending proposal is not valid',
};

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const optStr = (v: unknown) => v === undefined || typeof v === 'string';

class Refused extends Error {
  readonly code: string;
  constructor(code: string) {
    super(MESSAGE[code] ?? code);
    this.code = code;
  }
}

/** Why `v` is not an Interpretation over `sources` (null: it is one). `span`: a dictated task's span is checked too. */
export function interpretationProblem(v: unknown): 'shape' | 'span' | null {
  if (!isObj(v)) return 'shape';
  const sources = v.sources;
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > MAX_SOURCES || !sources.every((s) => typeof s === 'string')) return 'shape';
  for (const k of ['harness', 'model', 'effort']) {
    const f = v[k];
    if (!isObj(f) || !PROVENANCE.includes(f.provenance as string) || !optStr(f.value) || !optStr(f.said)) return 'shape';
  }
  const t = v.task;
  if (!isObj(t) || !['dictated', 'missing'].includes(t.provenance as string) || !optStr(t.value)) return 'shape';
  if (!Array.isArray(v.questions) || !v.questions.every((q) => isObj(q) && typeof q.field === 'string' && typeof q.text === 'string')) return 'shape';
  if (typeof v.ready_for_review !== 'boolean') return 'shape';
  if (t.provenance === 'dictated') {
    const sp = t.span;
    if (typeof t.value !== 'string' || !isObj(sp) || typeof sp.source !== 'number' || typeof sp.start !== 'number' || typeof sp.end !== 'number') return 'shape';
    const src = (sources as string[])[sp.source];
    if (src === undefined || src.slice(sp.start, sp.end) !== t.value) return 'span';
  }
  return null;
}

export class InterpretSim {
  /** How long an interpretation may take (the bridge's bound); `sim.interpret {timeout_ms}` changes it. */
  private timeoutMs = 35_000;

  constructor(private readonly h: InterpretHost) {}

  handle(t: unknown, a: Obj, ack: (d?: unknown) => void, fail: (e: unknown) => void): boolean {
    if (t === 'sim.interpret') {
      const ms = a.timeout_ms;
      if (ms !== undefined && (typeof ms !== 'number' || !(ms > 0))) throw this.h.error('bad_request', 'sim.interpret needs timeout_ms > 0');
      if (typeof ms === 'number') this.timeoutMs = ms;
      ack();
      return true;
    }
    if (t !== 'hire.interpret') return false;
    for (const k of Object.keys(a)) if (k !== 'text' && k !== 'pending') throw this.h.error('bad_request', `bad args: json: unknown field "${k}"`);
    const text = a.text;
    if (typeof text !== 'string' || !text || Buffer.byteLength(text, 'utf8') > MAX_TEXT || text.includes('\u0000')) {
      throw this.h.error('bad_request', 'bad args: text must be 1-8192 bytes of UTF-8 without NUL');
    }
    const pending = a.pending;
    this.interpret(text, pending).then(ack, fail);
    return true;
  }

  private async interpret(text: string, pending: unknown): Promise<Obj> {
    try {
      if (pending !== undefined && (interpretationProblem(pending) !== null || (pending as { sources: string[] }).sources.length >= MAX_SOURCES)) throw new Refused('bad_pending');
      if (!this.h.ai.ready('llm')) throw new Refused('not_ready');
      const sources = pending === undefined ? [text] : [...(pending as { sources: string[] }).sources, text];
      const answer = await this.call(text, pending);
      return { text, ...this.result(answer, sources) };
    } catch (e) {
      const code = e instanceof Refused ? e.code : typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : 'bad_response';
      return { text, error: { code, message: MESSAGE[code] ?? 'the LLM call failed' } };
    }
  }

  /** The LLM's answer, or `timeout` past the bound (the call is not waited for any longer). */
  private call(text: string, pending: unknown): Promise<string> {
    const user = JSON.stringify({ command: text, pending_hire: pending ?? null, hire_options: this.h.hireOptions() });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, no) => (timer = setTimeout(() => no(new Refused('timeout')), this.timeoutMs)));
    const call = this.h.ai.complete(
      [
        { role: 'system', content: 'Interpret the dictated herdr-3d command. Answer {"intent":"hire"|"unsupported"|"unclear","reason"?:"multiple","hire"?:<Interpretation>} as JSON.' },
        { role: 'user', content: user },
      ],
      true,
    );
    return Promise.race([call, late]).finally(() => clearTimeout(timer));
  }

  /** The answer checked and passed on, the proposal's sources as the bridge makes them. */
  private result(answer: string, sources: string[]): Obj {
    let r: unknown;
    try {
      r = JSON.parse(answer);
    } catch {
      throw new Refused('bad_answer');
    }
    if (!isObj(r) || !INTENTS.includes(r.intent as string) || (r.reason !== undefined && r.reason !== 'multiple')) throw new Refused('bad_answer');
    if (r.intent !== 'hire') {
      if (r.hire !== undefined) throw new Refused('bad_answer');
      return { intent: r.intent, ...(r.reason ? { reason: r.reason } : {}) };
    }
    if (!isObj(r.hire)) throw new Refused('bad_answer');
    const hire = { ...r.hire, sources };
    const problem = interpretationProblem(hire);
    if (problem) throw new Refused(problem === 'span' ? 'bad_span' : 'bad_answer');
    return { intent: 'hire', hire };
  }
}
