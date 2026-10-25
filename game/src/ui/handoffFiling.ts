import type { CommandResult } from '../net/client';
import type { AgentHandoff, AgentHandoffAck, CommandArgs, HandoffAck, HandoffCandidate, HandoffEntry, HandoffGetAck, LLMHandoff, LLMHandoffAck, Worker } from '../net/protocol';
import { jobText } from '../world/handoffLlm';
import type { HandoffMode } from './handoffDialog';
import { failureText } from './messages';
import type { Go, PromptSecretsFlow } from './secretsFlow';

/**
 * #198: one handoff filed for "Hire with handoff", from the request to the filed entry and its final path. No DOM: the
 * hire review drives it from its Hire (`run`), feeds it the source worker on every world change (`feed`), and stops it
 * when it closes (`stop`). It sends `worker.handoff` once per op (a resend with the same op is the same request on the
 * bridge), follows `Worker.agent_handoff` / `Worker.llm_handoff` with that op only (never `handoff.added`, never the
 * next handoff that appears), and reads the entry with `handoff.get`: never an interim or `.pending` path. It resolves
 * once; what comes after (a repeated update, a late ack) changes nothing.
 */

/** What step 1 chose: the source worker and how its handoff is made. The new agent's task is not in it (AC3). */
export interface HandoffPlan {
  /** The source worker's id and name. */
  worker: string;
  name: string;
  /** Its floor's name, for the messages. */
  floorName: string;
  mode: HandoffMode;
  /** The candidate step 1 previewed (literal and LLM: its session, id and revision go with the request). */
  candidate: HandoffCandidate | null;
  /** What to put in the handoff (agent and LLM only; "" for the default). Never the new agent's task. */
  instruction: string;
  /** "Send home after filing", ticked. */
  sendHome: boolean;
  /** The configured LLM's model, for the progress line. */
  llmModel?: string;
}

export type FilingOutcome =
  /** Filed: the entry as the cabinet has it (its final path). */
  | { kind: 'filed'; entry: HandoffEntry }
  /**
   * Not filed, or not known to be. `retry`: a new Hire may send the same op again (the outcome was not known, or the
   * filed entry could not be read back); else the next request needs a new op. `stale`: step 1's reply is no longer
   * the worker's latest.
   */
  | { kind: 'failed'; message: string; retry: boolean; stale?: boolean }
  /** Stopped waiting (the review closed or opened again): nothing is said here, and nothing is hired from it. */
  | { kind: 'gone' };

export interface HandoffFilingHost {
  send<T extends 'worker.handoff' | 'worker.handoff_cancel' | 'handoff.get'>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  /** The source worker as the world has it now. */
  worker(id: string): Worker | undefined;
  /** #108: the instruction's review, as the filing dialog does it (absent: none). */
  secrets?: PromptSecretsFlow | undefined;
  /** The phase moved on (the progress line changes). */
  moved?(): void;
}

export type FilingPhase = 'sending' | 'waiting' | 'reading' | 'done';

/** A send whose answer never came: it may have gone. */
const UNANSWERED = new Set(['timeout', 'disconnected']);

export class HandoffFiling {
  phase: FilingPhase = 'sending';
  /** The worker has shown this op's request or job (an ack alone does not count: the worker's update may come later). */
  private seen = false;
  private settle: ((o: FilingOutcome) => void) | null = null;
  private readonly out: Promise<FilingOutcome>;
  private started = false;

  constructor(
    private readonly host: HandoffFilingHost,
    readonly plan: Readonly<HandoffPlan>,
    readonly op: string,
    /** The submission is still the one that asked (the review open, the same opening). */
    private readonly live: () => boolean,
  ) {
    this.out = new Promise((r) => (this.settle = r));
  }

  /** Sends the request (once) and resolves how it ended. */
  run(): Promise<FilingOutcome> {
    if (!this.started) {
      this.started = true;
      void this.send().catch((e: unknown) => this.end({ kind: 'failed', message: String(e), retry: true }));
    }
    return this.out;
  }

  /** What is happening now, as the review's status line says it. */
  progress(): string {
    const p = this.plan;
    if (this.phase === 'reading') return 'Filed. Reading its path…';
    if (p.mode === 'literal') return `Saving ${p.name}’s last message…`;
    if (p.mode === 'agent') return this.phase === 'waiting' ? `Asking ${p.name}’s agent… it is filed once its turn ends with the handoff written.` : `Asking ${p.name}’s agent…`;
    return `The LLM${p.llmModel ? ` (${p.llmModel})` : ''} is writing the handoff…`;
  }

  /** The source worker changed: the request or job with this op moved on (filed, failed), or the worker left. */
  feed(): void {
    if (this.phase !== 'waiting') return;
    const w = this.host.worker(this.plan.worker);
    if (!w) {
      this.end({ kind: 'failed', message: `${this.plan.name} left before its handoff was seen filed. Nobody was hired: if it was filed, hire from it in the cabinet.`, retry: false });
      return;
    }
    const cur = this.plan.mode === 'agent' ? w.agent_handoff : w.llm_handoff;
    if (!cur) return;
    if (cur.op !== this.op) {
      // Another request took its place after ours was seen: ours ended without this review seeing how.
      if (this.seen) this.end({ kind: 'failed', message: `${this.plan.name}’s handoff request was replaced by another before it was seen filed. Nobody was hired: if it was filed, hire from it in the cabinet.`, retry: false });
      return;
    }
    this.seen = true;
    this.follow(cur);
  }

  /** Stop waiting: no hire comes from it. The request keeps running on the bridge. */
  stop(): void {
    this.end({ kind: 'gone' });
  }

  /** Cancel the agent's request or the LLM's job (literal: nothing to cancel). Its outcome ends the filing as failed. */
  async cancel(): Promise<{ ok: boolean; message: string }> {
    if (this.plan.mode === 'literal' || this.phase === 'done') return { ok: false, message: '' };
    const r = await this.host.send('worker.handoff_cancel', { worker: this.plan.worker, op: this.op });
    if (!r.ok) return { ok: false, message: failureText('worker.handoff_cancel', r.code, r.message, { worker: this.plan.name }) };
    this.end({ kind: 'failed', message: 'Cancelled: nothing was filed and nobody was hired. Your task and settings are still here.', retry: false });
    return { ok: true, message: '' };
  }

  private end(o: FilingOutcome): void {
    if (this.phase === 'done' && o.kind !== 'gone') return;
    this.phase = 'done';
    const s = this.settle;
    this.settle = null;
    s?.(o);
  }

  private async send(): Promise<void> {
    const p = this.plan;
    const op = this.op;
    const home = p.sendHome ? { send_home: true } : {};
    if (p.mode === 'literal') {
      const c = p.candidate;
      if (!c) return this.end({ kind: 'failed', message: `${p.name} has no completed reply to file.`, retry: false, stale: true });
      const r = await this.host.send('worker.handoff', { worker: p.worker, mode: 'literal', session: c.session, candidate: c.id, revision: c.revision, op, ...home });
      if (!this.answered(r) || !r.ok) return;
      return this.end({ kind: 'filed', entry: (r.data as HandoffAck).handoff });
    }
    if (p.mode === 'llm' && !p.candidate) return this.end({ kind: 'failed', message: `${p.name} has no completed turn to hand off now.`, retry: false, stale: true });
    const instruction = p.instruction.trim();
    const args = (g: Go): CommandArgs['worker.handoff'] => {
      const extra = { op, ...(instruction ? { instruction } : {}), ...home, ...(g.secrets ? { secrets: g.secrets } : {}) };
      const c = p.candidate as HandoffCandidate;
      return p.mode === 'agent' ? { worker: p.worker, mode: 'agent', ...extra } : { worker: p.worker, mode: 'llm', session: c.session, candidate: c.id, revision: c.revision, ...extra };
    };
    const r = await this.reviewed(instruction, (g) => this.host.send('worker.handoff', args(g)));
    if (!r || !this.answered(r) || !r.ok) return;
    const now: AgentHandoff | LLMHandoff = p.mode === 'agent' ? (r.data as AgentHandoffAck).request : (r.data as LLMHandoffAck).job;
    if (now.op !== op) return this.end({ kind: 'failed', message: `${p.name} is already writing another handoff: nothing was sent. Hire from it in the cabinet once it is filed.`, retry: false });
    this.phase = 'waiting';
    this.host.moved?.();
    this.follow(now);
    // An update may have come before the ack.
    this.feed();
  }

  /** The answer to `worker.handoff`: false (and ended) when it was refused or never came. */
  private answered(r: CommandResult): boolean {
    if (this.phase === 'done') return false;
    if (r.ok) return true;
    const p = this.plan;
    const words = failureText('worker.handoff', r.code, r.message, { worker: p.name, floor: p.floorName });
    if (UNANSWERED.has(r.code)) this.end({ kind: 'failed', message: `${words} Nobody was hired. Hire again sends the same request: it is filed once.`, retry: true });
    else this.end({ kind: 'failed', message: `${words} Nobody was hired.`, retry: false, ...(r.code === 'handoff_unavailable' || r.code === 'handoff_source' ? { stale: true } : {}) });
    return false;
  }

  /** The request or job with this op, as it moves on. */
  private follow(a: AgentHandoff | LLMHandoff): void {
    if (this.phase !== 'waiting') return;
    if (a.state === 'filed' && a.handoff) {
      this.phase = 'reading';
      this.host.moved?.();
      void this.read(a.handoff);
      return;
    }
    if (a.state === 'failed' || a.state === 'cancelled') {
      const why = this.plan.mode === 'llm' ? jobText(a as LLMHandoff) : `${this.plan.name}’s agent handoff was not filed: ${(a as AgentHandoff).reason ?? 'it failed'}.`;
      this.end({ kind: 'failed', message: `${why} Nobody was hired.`, retry: false });
    }
  }

  private async read(id: number): Promise<void> {
    const r = await this.host.send('handoff.get', { id });
    if (this.phase === 'done') return;
    if (!r.ok) {
      this.end({ kind: 'failed', message: `The handoff was filed, but its path could not be read back (${failureText('handoff.get', r.code, r.message, { floor: this.plan.floorName })}). Nobody was hired: hire again to read it once more.`, retry: true });
      return;
    }
    this.end({ kind: 'filed', entry: (r.data as HandoffGetAck).handoff });
  }

  /**
   * #108 round 4: the instruction's review, as the filing dialog does it (the switch on: scanned, and reviewed when it
   * finds something), then `send` with it. A blank instruction is the default one: nothing to review. Null: kept or
   * closed meanwhile (ended).
   */
  private async reviewed(instruction: string, send: (g: Go) => Promise<CommandResult>): Promise<CommandResult | null> {
    const flow = this.host.secrets;
    const go: Go = { kind: 'send', protects: 0, shown: instruction, review: null };
    if (!flow || !instruction) return send(go);
    const req = { key: this.plan.worker, text: instruction, target: this.plan.name, manual: false, live: () => this.live() && this.phase !== 'done' };
    const kept = (why: string, message: string) => {
      if (why === 'gone') this.end({ kind: 'gone' });
      else this.end({ kind: 'failed', message: why === 'cancel' ? 'Not sent: the review of the handoff instruction was cancelled. Nothing was filed and nobody was hired.' : message, retry: false });
      return null;
    };
    let first = go;
    if (flow.on) {
      const out = await flow.review(req);
      if (out.kind === 'kept') return kept(out.why, out.message);
      first = out;
    }
    const d = await flow.deliver(req, first, send);
    return d.kind === 'kept' ? kept(d.why, d.message) : d.result;
  }
}
