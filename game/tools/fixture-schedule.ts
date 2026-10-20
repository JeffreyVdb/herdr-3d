// #64 schedules (part 3 of #61): scheduled agents for the fixture server's `sim=1` (tools/fixture-sim.ts hands these
// commands over). Rules, like herdr-world's (#62, docs/protocol.md "Scheduled agents"):
// - the snapshot's `schedules` is the view: the upcoming, the failed and skipped not dismissed, each floor's last 50
//   done (absent with `simfail=no_schedules`, and then every command below answers `unknown_command`);
//   `simschedules=<n>` seeds n schedules across the first two floors, cycling through scheduled (in 2 h, tomorrow),
//   waiting, running, done (on time, by a worker who is at a desk), done 3 h late (by a worker who is gone), failed
//   and skipped;
// - `schedule.create` / `schedule.update` check the spec like the bridge (`bad_request`: title 1–200 bytes without
//   control characters, `due_at` in the future, `on_miss`, `max_lateness_ms` positive and `run_late` only, the
//   harness / model / effort of the hire options, the prompt at most 32 KiB, not starting with `--`, empty only with
//   a `handoff_path`, `cwd` absolute and existing: a cwd with `/gone` in it does not exist, `handoff_path` absolute);
//   update replaces the whole spec, its floor must be the schedule's (or empty) and `source` is refused;
// - the state rules: update and run_now from `scheduled`, cancel from `scheduled` / `waiting`, retry and dismiss from
//   `failed` / `skipped`, else `invalid_state` ("schedule <id> is <state>; <cmd> needs it …"); an unknown id is
//   `not_found`; a cancelled or dismissed one is `invalid_state` too. Every change is a `schedule.upsert`; cancel and
//   dismiss a `schedule.removed {id, floor_id}`;
// - the fire (when due, by run_now or retry): a gone floor fails it, an asleep floor without `wake_floor` fails it
//   ("floor asleep: wake_floor is off"), with it the schedule waits ("waking floor <id>") until fired again, no free
//   desk waits too; else `running` (`fired_at`) and the simulator's own `worker.hire` at the first free desk with the
//   prompt (and the handoff line): `done` with the hired `worker_id`, or `failed` with the hire's message. A scheduled
//   one fires by itself when its `due_at` comes (a timer on the sim's clock);
// - `sim.schedule_fire {id, late_ms?, fail?, skip?}` (the simulator's own) plays an outcome now, whatever the clock:
//   `fail` (a reason, or true) fails it, `skip` (a reason, or true) skips it as missed, `late_ms` fires it that late
//   (`fired_at = due_at + late_ms`), else it fires as above; `sim.schedule_fail {code, message?}` makes the next
//   create, update or retry answer that error (`busy`: a send home removes the worktree its cwd is in, #63);
// - #127: the snapshot says `schedule_herdr_instructions: true` (left out with `simfail=no_schedule_instructions`, or
//   `no_herdr_instructions`: then the field is refused as unknown, `bad_request`); create / update store
//   `herdr_instructions` (a bool; on, the prompt with a blank line and the floor's lines must fit 32 KiB) and the view
//   echoes it; the fire hires with `herdr_instructions`, so the simulator's worker.hire adds the floor's lines last.
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import type { HireOptions, Schedule, ScheduleSource, Worker } from '../src/net/protocol.ts';

type Obj = Record<string, unknown>;
type Send = (m: Obj) => void;

export interface ScheduleHost {
  /** Every floor id, in the city's order. */
  floors(): string[];
  floor(id: string): { state?: string; transition?: string | null } | undefined;
  readonly hire: HireOptions;
  readonly workers: Worker[];
  emit(send: Send, m: Obj): void;
  /** The connection's send, for a fire on the sim's clock (null before the snapshot went out). */
  out(): Send | null;
  error(code: string, message: string): Error;
  now(): number;
  later(fn: () => void, ms: number): unknown;
  cancel(h: unknown): void;
  /** The first desk of the floor nobody holds or is on the way to (null: none). */
  freeDesk(floor: string): number | null;
  /** The simulator's worker.hire (its args with `session` the floor id). */
  hireWorker(a: Obj, send: Send, ack: (d?: unknown) => void, fail: (e: unknown) => void): void;
  /** #108: why a fire with the switch on refuses the stored prompt (its candidates not reviewed), or null: it goes. */
  stored?(s: Schedule): string | null;
  /** #127: the herdr hiring instructions for a floor (its worker.hire's), when schedules take the flag. */
  lines?(floor: string): string;
}

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s).length;
const MAX_PROMPT = 32 << 10;
const MAX_TITLE = 200;
const KEEP_DONE = 50;
const HOUR = 3_600_000;
const ALLOWED: Record<string, string[]> = {
  'schedule.update': ['scheduled'],
  'schedule.cancel': ['scheduled', 'waiting'],
  'schedule.run_now': ['scheduled'],
  'schedule.retry': ['failed', 'skipped'],
  'schedule.dismiss': ['failed', 'skipped'],
};
const OURS = ['schedule.create', ...Object.keys(ALLOWED), 'sim.schedule_fire', 'sim.schedule_fail'];

const utc = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

export class ScheduleSim {
  private readonly h: ScheduleHost;
  readonly enabled: boolean;
  /** #127: schedules take `herdr_instructions` (the snapshot's `schedule_herdr_instructions`). */
  readonly instructions: boolean;
  /** In view and out of it (cancelled, dismissed), by id. */
  private readonly all = new Map<string, Schedule>();
  private readonly timers = new Map<string, unknown>();
  private next = 0;
  private failNext: { code: string; message: string } | null = null;

  constructor(h: ScheduleHost, enabled: boolean, seed = 0, instructions = true) {
    this.h = h;
    this.enabled = enabled;
    this.instructions = enabled && instructions;
    if (enabled && seed > 0) this.seed(seed);
  }

  decorate(world: Obj): void {
    if (this.enabled) world.schedules = this.view();
    if (this.instructions) world.schedule_herdr_instructions = true; // #127
  }

  /** The view (#62 decision 10). */
  view(): Schedule[] {
    const done = new Map<string, Schedule[]>();
    const out: Schedule[] = [];
    for (const s of this.all.values()) {
      if (s.state === 'cancelled' || s.dismissed_at) continue;
      if (s.state === 'done') done.set(s.floor, [...(done.get(s.floor) ?? []), s]);
      else out.push(structuredClone(s));
    }
    for (const list of done.values()) out.push(...list.sort((a, b) => (b.fired_at ?? 0) - (a.fired_at ?? 0)).slice(0, KEEP_DONE).map((s) => structuredClone(s)));
    return out;
  }

  handle(t: unknown, a: Obj, send: Send, ack: (d?: unknown) => void, fail: (e: unknown) => void): boolean {
    if (typeof t !== 'string' || !OURS.includes(t)) return false;
    if (!this.enabled) throw this.h.error('unknown_command', `unknown command: ${t}`);
    if (t === 'sim.schedule_fail') {
      this.failNext = { code: String(a.code ?? 'busy'), message: typeof a.message === 'string' ? a.message : '' };
      ack();
      return true;
    }
    if (t === 'sim.schedule_fire') {
      const s = this.get(a.id);
      this.play(s, a, send);
      ack(structuredClone(s));
      return true;
    }
    if ((t === 'schedule.create' || t === 'schedule.update' || t === 'schedule.retry') && this.failNext) {
      const f = this.failNext;
      this.failNext = null;
      const words: Record<string, string> = { busy: 'busy: cwd is in the worktree being removed (sending Pixel home)', bad_request: 'bad request', invalid_state: 'invalid state', not_found: 'not found' };
      throw this.h.error(f.code, f.message || words[f.code] || f.code);
    }
    if (t === 'schedule.create') {
      const now = this.h.now();
      const s: Schedule = {
        id: `sch_${(++this.next).toString(16).padStart(16, '0')}`,
        floor: '',
        title: '',
        prompt: '',
        due_at: 0,
        on_miss: 'run_late',
        harness: '',
        model: '',
        effort: '',
        cwd: '',
        worktree: false,
        wake_floor: true,
        source: this.source(a.source),
        state: 'scheduled',
        created_at: now,
        updated_at: now,
      };
      const floor = typeof a.floor === 'string' ? a.floor : '';
      if (!this.h.floors().includes(floor)) throw this.bad(`unknown floor ${JSON.stringify(floor)}`);
      s.floor = floor;
      this.apply(s, a);
      this.all.set(s.id, s);
      this.arm(s);
      this.upsert(send, s);
      ack(structuredClone(s));
      return true;
    }
    const s = this.get(a.id);
    const ok = ALLOWED[t] ?? [];
    if (s.state === 'cancelled' || s.dismissed_at) throw this.h.error('invalid_state', `invalid state: schedule ${s.id} is ${s.dismissed_at ? 'dismissed' : s.state}`);
    if (!ok.includes(s.state)) throw this.h.error('invalid_state', `invalid state: schedule ${s.id} is ${s.state}; ${t} needs it ${ok.join(' or ')}`);
    const now = this.h.now();
    switch (t) {
      case 'schedule.update': {
        if (typeof a.floor === 'string' && a.floor && a.floor !== s.floor) throw this.bad(`a schedule's floor cannot change (it is ${s.floor})`);
        if (a.source !== undefined) throw this.bad("a schedule's source cannot change");
        const next = { ...s };
        this.apply(next, a);
        for (const k of Object.keys(s) as Array<keyof Schedule>) if (!(k in next)) delete s[k];
        Object.assign(s, next, { updated_at: now });
        this.arm(s);
        this.upsert(send, s);
        break;
      }
      case 'schedule.cancel':
        this.disarm(s.id);
        Object.assign(s, { state: 'cancelled', updated_at: now });
        delete s.state_reason;
        this.h.emit(send, { t: 'schedule.removed', id: s.id, floor_id: s.floor });
        break;
      case 'schedule.dismiss':
        Object.assign(s, { dismissed_at: now, updated_at: now });
        this.h.emit(send, { t: 'schedule.removed', id: s.id, floor_id: s.floor });
        break;
      case 'schedule.run_now':
      case 'schedule.retry':
        this.disarm(s.id);
        delete s.fired_at;
        delete s.worker_id;
        this.fire(s, send, null);
        break;
    }
    ack(structuredClone(s));
    return true;
  }

  /** #108: a schedule's stored prompt (undefined: no such schedule), for the review of its retry. */
  promptOf(id: unknown): string | undefined {
    return typeof id === 'string' ? this.all.get(id)?.prompt : undefined;
  }

  private get(id: unknown): Schedule {
    const s = typeof id === 'string' ? this.all.get(id) : undefined;
    if (!s) throw this.h.error('not_found', `not found: schedule ${JSON.stringify(id)}`);
    return s;
  }

  private bad(msg: string): Error {
    return this.h.error('bad_request', `bad request: ${msg}`);
  }

  private source(v: unknown): ScheduleSource {
    if (v === undefined) return { kind: 'manual' };
    const o = v as Obj;
    if (!o || typeof o !== 'object' || !['manual', 'transcript', 'suggestion'].includes(o.kind as string)) throw this.bad('source.kind must be manual, transcript or suggestion');
    if (o.worker !== undefined && (typeof o.worker !== 'string' || bytes(o.worker) > 128)) throw this.bad('source.worker must be at most 128 bytes');
    if (o.message !== undefined && (typeof o.message !== 'string' || bytes(o.message) > 256)) throw this.bad('source.message must be at most 256 bytes');
    return { kind: o.kind as ScheduleSource['kind'], ...(o.worker ? { worker: o.worker as string } : {}), ...(o.message ? { message: o.message as string } : {}) };
  }

  /** The bridge's `applyScheduleSpec`: the spec into `s`, or `bad_request`. */
  private apply(s: Schedule, a: Obj): void {
    const title = typeof a.title === 'string' ? a.title.trim() : '';
    if (!title || bytes(title) > MAX_TITLE || /[\u0000-\u001f\u007f]/.test(title)) throw this.bad(`title must be 1-${MAX_TITLE} bytes of text without control characters`);
    const now = this.h.now();
    const due = a.due_at;
    if (typeof due !== 'number' || !Number.isInteger(due) || due <= now) throw this.bad(`due_at must be in the future (now ${now}, got ${String(due)})`);
    const onMiss = a.on_miss === undefined || a.on_miss === '' ? 'run_late' : a.on_miss;
    if (onMiss !== 'run_late' && onMiss !== 'skip') throw this.bad(`on_miss must be run_late or skip, got ${JSON.stringify(onMiss)}`);
    const max = a.max_lateness_ms;
    if (max !== undefined && max !== null && onMiss !== 'run_late') throw this.bad('max_lateness_ms is for on_miss run_late only');
    if (max !== undefined && max !== null && (typeof max !== 'number' || max <= 0)) throw this.bad('max_lateness_ms must be positive');
    const [harness, model, effort] = [a.harness, a.model, a.effort].map((x) => (typeof x === 'string' ? x : '')) as [string, string, string];
    const o = this.h.hire[harness];
    if (!o) throw this.bad(`unknown harness ${harness}`);
    if (!o.models.includes(model)) throw this.bad(`${harness} has no model ${model}`);
    if (![...o.efforts, ...(o.extra_efforts?.[model] ?? [])].includes(effort)) throw this.bad(`${model} has no effort ${effort}`);
    const prompt = typeof a.prompt === 'string' ? a.prompt : '';
    const handoff = typeof a.handoff_path === 'string' ? a.handoff_path : '';
    if (!prompt && !handoff) throw this.bad('prompt is required without a handoff_path');
    if (prompt && (bytes(prompt) > MAX_PROMPT || prompt.startsWith('--'))) throw this.bad(`prompt must be 1-${MAX_PROMPT} bytes of text, not starting with "--"`);
    const cwd = typeof a.cwd === 'string' ? a.cwd : '';
    if (!cwd.startsWith('/')) throw this.bad(`cwd must be an absolute path, got ${JSON.stringify(cwd)}`);
    if (cwd.includes('/gone')) throw this.bad(`cwd ${JSON.stringify(cwd)}: stat ${cwd}: no such file or directory`);
    if (handoff && !handoff.startsWith('/')) throw this.bad(`handoff_path must be an absolute path, got ${JSON.stringify(handoff)}`);
    if (a.worktree !== undefined && typeof a.worktree !== 'boolean') throw this.bad('worktree must be a bool');
    if (a.wake_floor !== undefined && typeof a.wake_floor !== 'boolean') throw this.bad('wake_floor must be a bool');
    // #127: an older bridge refuses the unknown field; on, the prompt fits with the floor's lines.
    if (a.herdr_instructions !== undefined && !this.instructions) throw this.bad('json: unknown field "herdr_instructions"');
    if (a.herdr_instructions !== undefined && typeof a.herdr_instructions !== 'boolean') throw this.bad('herdr_instructions must be a bool');
    const lines = a.herdr_instructions === true ? (this.h.lines?.(s.floor) ?? '') : '';
    if (prompt && lines && bytes(prompt) + 2 + bytes(lines) > MAX_PROMPT) throw this.bad(`prompt with the herdr hiring instructions must be at most ${MAX_PROMPT} bytes, got ${bytes(prompt) + 2 + bytes(lines)}`);
    Object.assign(s, { title, prompt, due_at: due, on_miss: onMiss, harness, model, effort, cwd, worktree: a.worktree === true, wake_floor: a.wake_floor !== false });
    if (typeof max === 'number') s.max_lateness_ms = max;
    else delete s.max_lateness_ms;
    if (handoff) s.handoff_path = handoff;
    else delete s.handoff_path;
    if (a.herdr_instructions === true) s.herdr_instructions = true;
    else delete s.herdr_instructions;
  }

  private upsert(send: Send, s: Schedule): void {
    this.h.emit(send, { t: 'schedule.upsert', schedule: structuredClone(s) });
  }

  /**
   * A scheduled one fires by itself at its due time (on the sim's clock). A timer waits at most 2^31−1 ms (~24.8 days):
   * one cut short by that arms again, as the bridge fires only once `due_at` has come.
   */
  private arm(s: Schedule): void {
    this.disarm(s.id);
    if (s.state !== 'scheduled') return;
    const wait = Math.max(0, s.due_at - this.h.now());
    const ms = Math.min(2 ** 31 - 1, wait);
    this.timers.set(
      s.id,
      this.h.later(() => {
        this.timers.delete(s.id);
        if (s.state !== 'scheduled') return;
        if (ms < wait) return this.arm(s);
        const out = this.h.out();
        if (out) this.fire(s, out, null);
      }, ms),
    );
  }

  private disarm(id: string): void {
    const t = this.timers.get(id);
    if (t !== undefined) this.h.cancel(t);
    this.timers.delete(id);
  }

  /** `sim.schedule_fire`: an outcome, now. */
  private play(s: Schedule, a: Obj, send: Send): void {
    this.disarm(s.id);
    const now = this.h.now();
    if (a.skip) {
      Object.assign(s, { state: 'skipped', state_reason: typeof a.skip === 'string' ? a.skip : `missed: bridge was offline at ${utc(s.due_at)} (seen ${utc(Math.max(now, s.due_at + 6 * 60_000))})`, updated_at: now });
      this.upsert(send, s);
      return;
    }
    if (a.fail) {
      Object.assign(s, { state: 'failed', state_reason: typeof a.fail === 'string' ? a.fail : 'hire_failed: herdr agent start: claude exited during startup (simulated)', updated_at: now });
      this.upsert(send, s);
      return;
    }
    this.fire(s, send, typeof a.late_ms === 'number' ? s.due_at + a.late_ms : null);
  }

  /** The fire (#62 "The fire"): `firedAt` null is now. */
  private fire(s: Schedule, send: Send, firedAt: number | null): void {
    const now = this.h.now();
    const f = this.h.floor(s.floor);
    const end = (state: Schedule['state'], reason?: string) => {
      s.state = state;
      if (reason) s.state_reason = reason;
      else delete s.state_reason;
      s.updated_at = this.h.now();
      this.upsert(send, s);
    };
    if (!f) return end('failed', `floor ${s.floor} is gone`);
    if (f.state !== 'running' || f.transition) {
      if (!s.wake_floor && f.state !== 'running') return end('failed', 'floor asleep: wake_floor is off');
      return end('waiting', `waking floor ${s.floor}`);
    }
    const desk = this.h.freeDesk(s.floor);
    if (desk === null) return end('waiting', `no free desk on ${s.floor}`);
    const parts = [s.prompt.trim(), s.handoff_path ? `Read ${s.handoff_path} and continue the work. Invoke the skills it suggests.` : ''].filter(Boolean);
    s.fired_at = firedAt ?? now;
    delete s.worker_id;
    end('running');
    // #108: with the switch on, a stored prompt goes only as a review left it: else the fire fails, nothing hired.
    const unreviewed = this.h.stored?.(s) ?? null;
    if (unreviewed) return end('failed', unreviewed);
    try {
      this.h.hireWorker(
        { session: s.floor, desk_index: desk, harness: s.harness, model: s.model, effort: s.effort, cwd: s.cwd, worktree: s.worktree, prompt: parts.join('\n\n'), ...(s.herdr_instructions ? { herdr_instructions: true } : {}) },
        send,
        (d) => {
          s.worker_id = String((d as Obj | undefined)?.id ?? '');
          end('done');
        },
        (e) => end('failed', e instanceof Error ? e.message : String(e)),
      );
    } catch (e) {
      end('failed', e instanceof Error ? e.message : String(e));
    }
  }

  /** `simschedules=<n>`: a mix of every state across the first two floors. */
  private seed(n: number): void {
    const floors = this.h.floors().slice(0, 2);
    if (!floors.length) return;
    const now = this.h.now();
    const plans: Array<(floor: string) => Partial<Schedule>> = [
      () => ({ title: 'After the soak', due_at: now + 2 * HOUR, prompt: 'The 24h soak is over. Delete the backups, attach the evidence and close the ticket.', worktree: true }),
      () => ({ title: 'Nightly dependency check', due_at: now + 26 * HOUR, on_miss: 'skip', handoff_path: '/home/dev/handoff/herdr-3d/20261016-1045-flicker-vector-rollout.md', prompt: '' }),
      (floor) => ({ title: 'Release notes draft', due_at: now - 4 * 60_000, state: 'waiting', state_reason: `waking floor ${floor}`, max_lateness_ms: 2 * HOUR }),
      () => ({ title: 'Rotate the staging keys', due_at: now - 60_000, state: 'running', fired_at: now - 20_000 }),
      (floor) => ({ title: 'Re-run the flaky e2e', due_at: now - 3 * HOUR, state: 'done', fired_at: now - 3 * HOUR + 40_000, worker_id: this.h.workers.find((w) => (w.floor ?? w.session) === floor)?.id ?? '' }),
      () => ({ title: 'Morning triage', due_at: now - 9 * HOUR, state: 'done', fired_at: now - 6 * HOUR, worker_id: 'gone-worker-0001' }),
      () => ({ title: 'Clean the old worktrees', due_at: now - 2 * HOUR, state: 'failed', state_reason: 'working directory /home/dev/devel/old-wt no longer exists' }),
      () => ({ title: 'Weekly digest', due_at: now - 30 * HOUR, state: 'skipped', on_miss: 'skip', state_reason: `missed: bridge was offline at ${utc(now - 30 * HOUR)} (seen ${utc(now - 29 * HOUR)})` }),
    ];
    for (let i = 0; i < n; i++) {
      const floor = floors[i % floors.length] as string;
      const opts = this.h.hire;
      const harness = opts.claude ? 'claude' : (Object.keys(opts)[0] ?? 'claude');
      const o = opts[harness];
      const p = plans[i % plans.length]?.(floor) ?? {};
      const s: Schedule = {
        id: `sch_seed${String(i).padStart(12, '0')}`,
        floor,
        title: 'Task',
        prompt: 'Check the dashboard and report.',
        due_at: now + HOUR,
        on_miss: 'run_late',
        harness,
        model: o?.models[0] ?? '',
        effort: o?.efforts.includes('high') ? 'high' : (o?.efforts[0] ?? ''),
        cwd: '/home/dev/devel/herdr-3d',
        worktree: false,
        wake_floor: true,
        source: i % 3 === 1 ? { kind: 'transcript', worker: 'seed-worker', message: `msg_seed${i}` } : { kind: 'manual' },
        state: 'scheduled',
        created_at: now - 26 * HOUR,
        updated_at: now - (i + 1) * 60_000,
        ...p,
      };
      if (i >= plans.length) s.title = `${s.title} ${Math.floor(i / plans.length) + 1}`;
      if (!s.handoff_path) delete s.handoff_path;
      if (!s.worker_id) delete s.worker_id;
      this.all.set(s.id, s);
      this.arm(s);
    }
  }
}
