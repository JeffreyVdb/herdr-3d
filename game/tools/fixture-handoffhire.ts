// #219: "Hire with handoff" in the background, bridge-side, for the fixture server's `sim=1` (tools/fixture-handoff.ts
// hands these over; `simhandoffhires=1` turns it on, else the snapshot has no `handoff_hires` and the game hires after
// filing itself, as #198). Rules, like herdr-world's (docs/protocol.md "Handoffs", the run's contract §2):
// - `worker.handoff {mode: 'agent'|'llm', hire}` (`hire` with `literal`: `bad_request`) checks the hire before the ack the
//   way `worker.hire` does (`check`: the catalog, the floor, the desk in range, free, not on its way, not held, the
//   label, the caps counting the other holds and, with `send_home`, not the source; the task non-blank and, with a
//   1024-byte path allowance and the herdr instructions, within 32 KiB); its task's secrets went through the gate
//   (tools/fixture-secrets.ts, `hire.prompt: …` refusals). Accepted: a `waiting` record holds the desk, and the ack has
//   it (`handoff_hire`, also on an `existing` replay). A replay of the op with other args is `bad_request` ("This
//   request was already sent with other settings."), as are a blank task, a bad origin and a task too long.
// - Filed (`sim.agent_turn`, `sim.llm_finish`, a job that finishes by itself): `hiring`, then the simulator's own
//   worker.hire with `First read the handoff here: <path> and then follow these instructions:\n\n<task>`: `hired`
//   (its worker id, `prompted`, `delivery`) and only then the send home when asked (`skipped` unless the task reached
//   the new agent), or `failed` with the path set (`desk_taken`, `capacity`, `too_long`, `hire_failed`). `sim.handoff_hire
//   {fail?: code}` makes the next launch fail with that code (default `desk_taken`: someone sat down meanwhile).
// - The handoff failed or timed out: `failed` (`handoff_failed`, `timeout`); `worker.handoff_cancel`: `cancelled`; the
//   source worker gone: `failed` (`source_gone`); the target floor deleted: `failed` (`floor_gone`). Nothing hires
//   then, and the task's protected files go.
// - `handoff_hire.upsert {handoff_hire}` on every change, `handoff_hire.removed {op}` when a terminal record leaves
//   (10 minutes after it ended, at most 50 kept; pruned on the next change or snapshot). Never the task.
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import type { HandoffHire, Worker } from '../src/net/protocol.ts';

type Obj = Record<string, unknown>;
type Send = (m: Obj) => void;

/** A copy of game/src/world/handoff.ts `hireWithHandoffTask` (node runs this file as it is; a test keeps them equal). */
export function hireWithHandoffTask(path: string, task: string): string {
  const body = task.replace(/^(?:[ \t]*\r?\n)+/u, '').replace(/(?:\r?\n[ \t]*)+$/u, '');
  return `First read the handoff here: ${path} and then follow these instructions:\n\n${body}`;
}

export type HireResult = { ok: true; data: Obj } | { ok: false; code: string; message: string };

export interface HandoffHireHost {
  emit(send: Send, m: Obj): void;
  error(code: string, message: string): Error;
  now(): number;
  /** `hire`'s checks before anything is made, a refusal thrown; `source` (asked to go home): not counted toward the caps. */
  check(hire: Obj, op: string, source: string | null): void;
  /** The simulator's worker.hire for this op's hold: its ack's data, or its refusal. */
  hire(args: Obj, op: string, send: Send): Promise<HireResult>;
  /** The source's send home after the hire: '' when it started, else why not. */
  sendHome(worker: string, send: Send): string;
  /** #108: the task's protected files: the new worker's, or gone. */
  claim(hire: object, worker: string): void;
  release(hire: object): void;
  /** A floor's name for the messages. */
  floorName(id: string): string;
}

interface Rec {
  r: HandoffHire;
  /** `hire` as the gate left it (the task with its references), and what a replay is compared with. */
  hire: Obj;
  key: string;
}

const KEEP_MS = 10 * 60_000;
const KEEP_MAX = 50;
const HIRE_KEYS = ['session', 'floor', 'desk_index', 'harness', 'model', 'effort', 'label', 'cwd', 'worktree', 'prompt', 'herdr_instructions', 'secrets', 'secrets_pending', 'codex_profile', 'origin'];

/** The bridge's ": <why>." after a sentence's start. */
const because = (why: string) => `: ${why.trim().replace(/\.+$/, '')}.`;

const terminal = (r: HandoffHire) => r.state !== 'waiting' && r.state !== 'hiring';

export class HandoffHireSim {
  readonly enabled: boolean;
  private readonly h: HandoffHireHost;
  private readonly recs = new Map<string, Rec>();
  private failNext: string | null = null;

  constructor(h: HandoffHireHost, enabled: boolean) {
    this.h = h;
    this.enabled = enabled;
  }

  decorate(world: Obj): void {
    if (!this.enabled) return;
    this.prune(null);
    world.handoff_hires = [...this.recs.values()].map((x) => ({ ...x.r }));
  }

  /** The pending record that holds `desk` of `floor` (but `except`'s own), for worker.hire's `desk_taken`. */
  holder(floor: string, desk: number, except?: string): HandoffHire | undefined {
    for (const x of this.recs.values()) if (!terminal(x.r) && x.r.op !== except && x.r.floor === floor && x.r.desk_index === desk) return x.r;
    return undefined;
  }

  /** Waiting holds on `floor` (and on the host with null), but `except`'s own: they count toward an accept's caps. */
  waiting(floor: string | null, except?: string): number {
    let n = 0;
    for (const x of this.recs.values()) if (x.r.state === 'waiting' && x.r.op !== except && (floor === null || x.r.floor === floor)) n++;
    return n;
  }

  get(op: string): HandoffHire | undefined {
    return this.recs.get(op)?.r;
  }

  /** The args a replay must repeat (the task as typed only when nothing of it went to files). */
  private keyOf(hire: Obj, sealed: boolean): string {
    const { secrets: _s, secrets_pending: _p, prompt, ...rest } = hire;
    return JSON.stringify([Object.entries(rest).sort(([a], [b]) => a.localeCompare(b)), sealed ? null : prompt]);
  }

  /** `hire` before the request starts: its shape, then the hire's checks (a refusal is thrown). */
  check(hire: Obj, op: string, sendHome: string | null): void {
    for (const k of Object.keys(hire)) if (!HIRE_KEYS.includes(k)) throw this.h.error('bad_request', `bad args: json: unknown field "hire.${k}"`);
    if (hire.origin !== undefined && (typeof hire.origin !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(hire.origin))) throw this.h.error('bad_request', 'bad args: hire.origin must be 1–80 characters of A-Z, a-z, 0-9, _ and -');
    if (typeof hire.prompt !== 'string' || !hire.prompt.trim()) throw this.h.error('bad_request', 'bad args: hire.prompt is required: the task for the new agent');
    this.h.check(hire, op, sendHome);
  }

  /** A replay of `op`: its record when `hire` is the same, else `bad_request`; null when the op has none. */
  replay(op: string, hire: Obj | undefined, sealed: boolean): HandoffHire | null {
    const x = this.recs.get(op);
    if (!x && !hire) return null;
    if (!x || !hire || x.key !== this.keyOf(hire, sealed)) throw this.h.error('bad_request', 'bad args: This request was already sent with other settings.');
    // The replay's own files are not used (the first request's are).
    this.h.release(hire);
    return { ...x.r };
  }

  /** The request started: its record, `waiting`, holds the desk. */
  create(src: Worker, mode: 'agent' | 'llm', op: string, hire: Obj, sendHome: boolean, sealed: boolean, send: Send): HandoffHire {
    const r: HandoffHire = {
      op,
      worker: src.id,
      worker_name: src.name ?? src.id,
      mode,
      floor: String(hire.floor ?? hire.session ?? ''),
      desk_index: hire.desk_index as number,
      ...(typeof hire.label === 'string' && hire.label.trim() ? { label: hire.label.trim() } : {}),
      harness: String(hire.harness),
      model: String(hire.model),
      effort: String(hire.effort),
      ...(typeof hire.origin === 'string' ? { origin: hire.origin } : {}),
      state: 'waiting',
      ...(sendHome ? { send_home: true } : {}),
      started_at: this.h.now(),
    };
    this.recs.set(op, { r, hire, key: this.keyOf(hire, sealed) });
    this.changed(r, send);
    return { ...r };
  }

  /** `sim.handoff_hire {fail?}`: the next launch is refused with `fail` (default `desk_taken`). */
  failNextLaunch(code: string | undefined): void {
    this.failNext = code || 'desk_taken';
  }

  /**
   * The handoff was filed: hire once (a second call for the op changes nothing), then send the source home when asked
   * and the new agent has its task. Resolves the send home's outcome for the request (null: none was asked, or no hire).
   */
  async filed(op: string, handoff: { id: number; path: string }, send: Send): Promise<{ send_home_result: 'started' | 'skipped'; send_home_reason?: string } | null> {
    const x = this.recs.get(op);
    if (!x || x.r.state !== 'waiting') return null;
    Object.assign(x.r, { state: 'hiring', handoff: handoff.id, path: handoff.path });
    this.changed(x.r, send);
    const { origin: _o, ...args } = x.hire;
    args.prompt = hireWithHandoffTask(handoff.path, String(x.hire.prompt ?? ''));
    let res: HireResult;
    if (this.failNext) {
      const code = this.failNext;
      this.failNext = null;
      res = { ok: false, code, message: code === 'desk_taken' ? `Desk ${x.r.desk_index + 1} of ${this.h.floorName(x.r.floor)} was taken while the handoff was written` : `${code.replace(/_/g, ' ')} (simulated)` };
    } else res = await this.h.hire(args, op, send);
    const name = x.r.worker_name;
    if (!res.ok) {
      this.h.release(x.hire);
      const code = ['desk_taken', 'capacity', 'too_long', 'floor_gone'].includes(res.code) ? res.code : res.code === 'secrets_review_stale' ? 'secrets_stale' : res.code === 'bad_request' && /prompt/.test(res.message) ? 'too_long' : 'hire_failed';
      const home = x.r.send_home ? { send_home_result: 'skipped' as const, send_home_reason: `The new agent was not hired; ${name} stays.` } : null;
      this.end(x, { state: 'failed', code, reason: `The new agent was not hired${because(res.message)}`, ...(home ?? {}) }, send);
      return home;
    }
    const d = res.data;
    const id = typeof d.id === 'string' ? d.id : '';
    if (id) this.h.claim(x.hire, id);
    const prompted = d.prompted !== false;
    const done: Partial<HandoffHire> = { state: 'hired', hired: id, prompted, ...(typeof d.delivery === 'string' ? { delivery: d.delivery } : {}), ...(typeof d.prompt_error === 'string' ? { prompt_error: d.prompt_error } : {}) };
    let home: { send_home_result: 'started' | 'skipped'; send_home_reason?: string } | null = null;
    if (x.r.send_home) {
      // Only once the new agent has its task: else the source stays (its conversation is the way back).
      const why = prompted ? this.h.sendHome(x.r.worker, send) : `The new agent did not get its task; ${name} stays.`;
      home = why ? { send_home_result: 'skipped', send_home_reason: why } : { send_home_result: 'started' };
      Object.assign(done, home);
    }
    this.end(x, done, send);
    return home;
  }

  /** The handoff ended without a filing (`why`: the handoff's reason): nobody is hired. */
  failed(op: string, code: 'handoff_failed' | 'timeout' | 'cancelled', why: string, send: Send): void {
    const x = this.recs.get(op);
    if (!x || x.r.state !== 'waiting') return;
    this.h.release(x.hire);
    const reason = code === 'cancelled' ? 'The handoff request was cancelled; nobody was hired.' : `Nobody was hired, the handoff was not filed${because(why)}`;
    this.end(x, { state: code === 'cancelled' ? 'cancelled' : 'failed', code, reason }, send);
  }

  /** The source worker left: its waiting hires fail (the fixture's LLM does not file for a worker that is gone). */
  sourceGone(id: string, send: Send): void {
    for (const x of this.recs.values())
      if (x.r.worker === id && x.r.state === 'waiting') {
        this.h.release(x.hire);
        this.end(x, { state: 'failed', code: 'source_gone', reason: `${x.r.worker_name} left before the handoff was filed; nobody was hired.` }, send);
      }
  }

  /** The target floor was deleted: its waiting hires fail; a later filing hires nobody. */
  floorGone(floor: string, send: Send): void {
    for (const x of this.recs.values())
      if (x.r.floor === floor && x.r.state === 'waiting') {
        this.h.release(x.hire);
        this.end(x, { state: 'failed', code: 'floor_gone', reason: `The floor of Desk ${x.r.desk_index + 1} is gone; nobody was hired.` }, send);
      }
  }

  private end(x: Rec, done: Partial<HandoffHire>, send: Send): void {
    Object.assign(x.r, done, { ended_at: this.h.now() });
    this.changed(x.r, send);
  }

  private changed(r: HandoffHire, send: Send): void {
    this.h.emit(send, { t: 'handoff_hire.upsert', handoff_hire: { ...r } });
    this.prune(send);
  }

  /** Terminal records leave 10 minutes after they ended, and beyond the newest 50. */
  private prune(send: Send | null): void {
    const now = this.h.now();
    const ended = [...this.recs.values()].filter((x) => terminal(x.r)).sort((a, b) => (b.r.ended_at ?? 0) - (a.r.ended_at ?? 0));
    ended.forEach((x, i) => {
      if (i < KEEP_MAX && now - (x.r.ended_at ?? now) < KEEP_MS) return;
      this.recs.delete(x.r.op);
      if (send) this.h.emit(send, { t: 'handoff_hire.removed', op: x.r.op });
    });
  }
}
