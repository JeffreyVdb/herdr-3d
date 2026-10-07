// #118 floor overview summaries for the fixture server's `sim=1` (tools/fixture-sim.ts hands these commands over).
// Rules, like herdr-world's (docs/protocol.md "Floor overview summaries"):
// - the snapshot's `digest` is the feature's state (absent with `simai=off` or `simfail=no_ai`): `off` until
//   `digest.set {enabled: true}`, which is `test_required` unless `digest.test` passed with the LLM in use
//   (tools/fixture-ai.ts), `incomplete` (with `missing`) while the LLM is not ready; every change is a
//   `digest.update` with the state flat in it;
// - `digest.test` has the LLM (the AI integration's endpoint, really called) write a task line and a now line from
//   samples; it passes when both come back with a line;
// - while ready, every worker with a digest on the floor the game stands on (its `board.watch`, passed on to the
//   boards) gets its lines written by the LLM, one call at a time, under the daily cap: a one-off worker's task from
//   its task line, every worker's now from its lines and title; each goes out as a `worker.upsert` with the sources
//   `llm`. Off, or the LLM failing: the fixture's own lines stay.
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import type { Worker } from '../src/net/protocol.ts';
import type { AiSim } from './fixture-ai.ts';

type Obj = Record<string, unknown>;
type Send = (m: Obj) => void;

export interface DigestHost {
  readonly workers: Worker[];
  readonly ai: AiSim;
  emit(send: Send, m: Obj): void;
  error(code: string, message: string): Error;
  now(): number;
}

const TASK_SYSTEM = 'You label the task of an AI coding agent for a status board. Write what the agent was asked to do, as one short imperative line of at most 80 characters. Reply with the line only.';
const NOW_SYSTEM = 'You write the status line of an AI coding agent for a status board. Say what the agent is doing now, as one line of at most 100 characters in the present tense. Reply with the line only.';
const FREELANCERS = ['code', 'review', 'ux', 'ground'];

/** The LLM's answer as a line: its first line, without quotes or markdown, clipped (the bridge's digest.Clean, simply). */
export function cleanLine(out: string, max: number): string | null {
  const first = out.split('\n').map((l) => l.trim()).find((l) => l && l.replace(/`/g, '') !== '') ?? '';
  let s = first.replace(/[*`]+/g, '').replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').replace(/[. ]+$/, '').replace(/\s+/g, ' ').trim();
  if (!/[\p{L}\p{N}]/u.test(s)) return null;
  if ([...s].length > max) s = `${[...s].slice(0, max - 1).join('').trimEnd()}…`;
  return s;
}

export class DigestSim {
  private enabled = false;
  private dailyCap = 300;
  /** #174: the reasoning effort ('': the provider's default) and the completion budget. */
  private effort = '';
  private maxTokens = 1024;
  private calls = 0;
  private passed: { fp: string; at: number } | null = null;
  private last = '';
  /** The floor the game stands on (its board.watch). */
  private viewing = '';
  /** Workers whose lines were written (their id → the input they were written for). */
  private readonly done = new Map<string, string>();
  private busy = false;

  constructor(private readonly h: DigestHost) {}

  private ready(): boolean {
    return this.h.ai.ready('llm');
  }

  private tested(): boolean {
    return !!this.passed && this.passed.fp === this.h.ai.fingerprint('llm') && this.h.now() - this.passed.at <= 30 * 60_000;
  }

  view(): Obj {
    const state = !this.enabled ? 'off' : !this.ready() ? 'incomplete' : 'ready';
    const llm = (this.h.ai.view() as { llm: { state: string } }).llm.state;
    return {
      enabled: this.enabled,
      state,
      ...(this.ready() ? {} : { missing: ['llm'] }),
      roles: { llm },
      env: [],
      tested: this.tested(),
      daily_cap: this.dailyCap,
      calls_today: this.calls,
      reasoning_effort: this.effort,
      max_tokens: this.maxTokens,
      // The fixture's endpoint lists model ids only: nothing is known of the model's reasoning.
      reasoning: { support: 'unknown', efforts: ['low', 'medium', 'high'], listed: false },
      effort_stale: false,
    };
  }

  decorate(world: Obj): void {
    if (this.h.ai.present) world.digest = this.view();
  }

  /** Emits digest.update when the state changed (also after the AI integration's). */
  changed(send: Send): void {
    const v = JSON.stringify(this.view());
    if (v === this.last) return;
    this.last = v;
    this.h.emit(send, { t: 'digest.update', ...this.view() });
  }

  private async line(system: string, data: string, max: number): Promise<string | null> {
    const out = await this.h.ai.complete(
      [
        { role: 'system', content: system },
        { role: 'user', content: `<transcript>\n${data}\n</transcript>` },
      ],
      false,
    );
    return cleanLine(out, max);
  }

  /** Writes the lines of the workers on the floor the game stands on, one call at a time. */
  private pump(send: Send): void {
    if (this.busy || !this.enabled || !this.ready()) return;
    const w = this.h.workers.find((x) => x.session === this.viewing && x.digest && !this.done.has(x.id));
    if (!w || !w.digest) return;
    const d = w.digest;
    const oneOff = !w.role;
    const input = `${d.task ?? ''}|${d.now ?? w.title ?? ''}`;
    this.done.set(w.id, input);
    this.busy = true;
    void (async () => {
      const next = { ...d };
      const take = async (kind: 'task' | 'now') => {
        if (this.calls >= this.dailyCap) return;
        this.calls++;
        const data = kind === 'task' ? d.task ?? '' : `Step 1:\n${d.now ?? w.title ?? ''}${w.issue?.title ? `\nContext: Ticket #${w.issue.number}: ${w.issue.title}` : ''}`;
        const line = await this.line(kind === 'task' ? TASK_SYSTEM : NOW_SYSTEM, data, kind === 'task' ? 80 : 100);
        if (!line) return;
        if (kind === 'task') Object.assign(next, { task: line, task_source: 'llm' });
        else Object.assign(next, { now: line, now_source: 'llm', now_at: this.h.now() });
      };
      try {
        if (oneOff && d.task && !FREELANCERS.includes(w.role ?? '')) await take('task');
        if (d.now_source) await take('now');
      } catch {
        // The LLM failing: the fixture's own lines stay.
      }
      this.busy = false;
      const cur = this.h.workers.find((x) => x.id === w.id);
      if (cur && this.enabled && JSON.stringify(next) !== JSON.stringify(cur.digest)) {
        cur.digest = next;
        this.h.emit(send, { t: 'worker.upsert', worker: cur });
      }
      this.changed(send);
      this.pump(send);
    })();
  }

  handle(t: unknown, a: Obj, send: Send, ack: (d?: unknown) => void, fail: (e: unknown) => void): boolean {
    if (t === 'board.watch') {
      // The floor the game stands on; the boards answer the command.
      if (typeof a.session === 'string') this.viewing = a.session;
      setTimeout(() => this.pump(send), 0);
      return false;
    }
    const ours = ['digest.get', 'digest.set', 'digest.test', 'digest.retry'];
    if (typeof t !== 'string' || !ours.includes(t)) return false;
    if (!this.h.ai.present) throw this.h.error('unsupported', 'unsupported: the bridge has no AI integration');
    switch (t) {
      case 'digest.get':
        ack(this.view());
        return true;
      case 'digest.retry':
        ack({ retried: 0 });
        return true;
      case 'digest.set': {
        const efforts = ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
        if (a.reasoning_effort !== undefined && (typeof a.reasoning_effort !== 'string' || !efforts.includes(a.reasoning_effort))) throw this.h.error('bad_request', 'reasoning_effort is not an effort');
        const tokens = a.max_tokens;
        if (tokens !== undefined && (typeof tokens !== 'number' || !Number.isInteger(tokens) || tokens < 64 || tokens > 16_384)) throw this.h.error('bad_request', 'max_tokens must be 64-16384');
        if (typeof a.reasoning_effort === 'string') this.effort = a.reasoning_effort;
        if (typeof tokens === 'number') this.maxTokens = tokens;
        const cap = a.daily_cap;
        if (cap !== undefined && (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 1 || cap > 10_000)) throw this.h.error('bad_request', 'daily_cap must be 1-10000');
        if (a.enabled === true && !this.enabled) {
          if (!this.ready()) throw this.h.error('incomplete', 'floor overview summaries need the LLM to be ready');
          if (!this.tested()) throw this.h.error('test_required', 'run the summaries test first: it must pass with the LLM in use');
        }
        if (typeof a.enabled === 'boolean') this.enabled = a.enabled;
        if (typeof cap === 'number') this.dailyCap = cap;
        this.changed(send);
        ack(this.view());
        this.pump(send);
        return true;
      }
      default: {
        // digest.test
        if (!this.ready()) throw this.h.error('incomplete', 'the summaries test needs the LLM to be ready');
        const fp = this.h.ai.fingerprint('llm');
        const t0 = Date.now();
        void (async () => {
          const task = await this.line(TASK_SYSTEM, 'Fix the flaky login test in e2e/auth.spec.ts and open a PR.', 80);
          const now = await this.line(NOW_SYSTEM, 'Step 1:\n- tool Bash: pnpm exec playwright test e2e/auth.spec.ts --repeat-each 20', 100);
          const samples = [
            { kind: 'task', ...(task ? { line: task } : { error: 'the LLM’s answer holds no line' }) },
            { kind: 'now', ...(now ? { line: now } : { error: 'the LLM’s answer holds no line' }) },
          ];
          const reason = !task ? 'the LLM’s task line was empty' : !now ? 'the LLM’s now line was empty' : undefined;
          if (!reason) this.passed = { fp, at: this.h.now() };
          this.changed(send);
          return { ok: !reason, ...(reason ? { reason } : {}), samples, latency_ms: Date.now() - t0 };
        })().then(ack, (e) => fail(e instanceof Error && typeof (e as Error & { code?: unknown }).code === 'string' ? this.h.error((e as Error & { code: string }).code, e.message) : e));
        return true;
      }
    }
  }
}
