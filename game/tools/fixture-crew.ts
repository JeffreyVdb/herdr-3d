// M6 crew: a scripted write-code freelancer for the fixture server's `sim=1`
// (tools/fixture-sim.ts hands `sim.crew` over). Like `sim.watches` it is the
// simulator's own command, not a bridge one: tests and `simcrew=<ms>` walk a
// freelancer through its whole lifecycle, the way the bridge would show it:
//
// - `{"step":"hire"}` (optionally `session`, `orch`: an orchestrator's worker
//   id; else the first orchestrator with a run on the first floor that has
//   one; M6c: `corner: true` hires for the simulator's own orchestrator in the
//   corner office, made on the first use: a `corner` worker sits up the
//   mezzanine stair, see docs/decisions.md): a `CODE|<descr>|<ticket>|r<N>` freelancer of that run shows up
//   (`worker.upsert`, no agent yet, a pending report) at the free desk
//   nearest its orchestrator's (same pod of 4 first, then by pod distance,
//   then lower index; the floor grows a desk when none is free).
// - `onboard`: its agent is there (`claude`, idle): it reads its brief.
// - `work`: it is `working`.
// - `report`: its report is ready (`summary`, or `verdict` / `blockers` /
//   `input_required` as given) and it is `done`. The game then walks the
//   folder over to the orchestrator's desk (M6c), hands it over, walks back
//   and sits; `leave` any time after that (or during: it finishes the
//   hand-over and walks out from where it stands).
// - `leave`: its workspace closes (`worker.removed`, no reason): it waves
//   and walks out with its briefcase.
//
// Every step but `hire` takes `id` (default: the last one hired) and acks
// `{id, step}`. `simcrew=<ms>` plays hire → onboard → work → report → leave
// by itself, one step every `<ms>`, over and over (M6c: every other round for
// the corner office's orchestrator).
import type { Floor, Worker, WorkerReport } from '../src/net/protocol.ts';

type Msg = Record<string, unknown>;
type Send = (m: Msg) => void;
type Obj = Record<string, unknown>;

export interface CrewHost {
  readonly workers: Worker[];
  readonly floors: Map<string, Floor>;
  emit(send: Send, m: Msg): void;
  after(ms: number, fn: () => void): void;
  now(): number;
  error(code: string, message: string): Error;
}

export const CREW_STEPS = ['hire', 'onboard', 'work', 'report', 'leave'] as const;
export type CrewStep = (typeof CREW_STEPS)[number];

/** The free desk nearest `orchDesk` (the bridge's rule: same pod of 4, then pod distance, then index); `taken` holds the used ones. */
export function nearestDesk(orchDesk: number, taken: ReadonlySet<number>, desks: number): number {
  const pod = Math.floor(orchDesk / 4);
  let best = -1;
  let key = Infinity;
  for (let d = 0; d < desks; d++) {
    if (taken.has(d)) continue;
    const k = Math.abs(Math.floor(d / 4) - pod) * 1000 + d;
    if (k < key) {
      key = k;
      best = d;
    }
  }
  return best >= 0 ? best : Math.max(desks, ...[...taken].map((d) => d + 1));
}

const NAMES = ['Sprig', 'Tumble', 'Quill', 'Dot', 'Brisket', 'Clover', 'Fennel', 'Marzipan'];

export class CrewSim {
  private readonly h: CrewHost;
  private last: string | null = null;
  private n = 0;
  private auto = 0;
  /** M6c: which round the auto script is on (every other one is for the corner office's orchestrator). */
  private round = 0;

  constructor(host: CrewHost) {
    this.h = host;
  }

  private bad(m: string): Error {
    return this.h.error('bad_request', `bad args: ${m}`);
  }

  /** `sim.crew`: one step of the script. */
  handle(a: Obj, send: Send): { id: string; step: CrewStep } {
    const step = a.step;
    if (typeof step !== 'string' || !(CREW_STEPS as readonly string[]).includes(step)) throw this.bad(`step must be one of ${CREW_STEPS.join(', ')}`);
    if (step === 'hire') return { id: this.hire(a, send), step };
    const id = typeof a.id === 'string' ? a.id : this.last;
    const w = id ? this.h.workers.find((x) => x.id === id) : undefined;
    if (!w) throw this.h.error('unknown_worker', `unknown worker: "${String(id)}"`);
    switch (step as CrewStep) {
      case 'onboard':
        Object.assign(w, { agent_kind: 'claude', agent_session: `sim-${w.id}`, status: 'idle', status_since: this.h.now() });
        this.h.emit(send, { t: 'worker.upsert', worker: w });
        break;
      case 'work': {
        const prev = w.status;
        Object.assign(w, { status: 'working', status_since: this.h.now(), title: 'Implementing the ticket' });
        this.h.emit(send, { t: 'worker.status', id: w.id, session: w.session, workspace_id: w.workspace_id, status: 'working', prev_status: prev, status_since: w.status_since, title: w.title });
        break;
      }
      case 'report': {
        const report: WorkerReport = { state: 'ready', at: this.h.now() };
        if (typeof a.verdict === 'string') {
          report.verdict = a.verdict;
          report.blockers = typeof a.blockers === 'number' ? a.blockers : 0;
          report.issues = report.blockers;
        } else report.summary = typeof a.summary === 'string' ? a.summary : 'Implemented and tested; head 3f9c2e1, all checks green.';
        report.input_required = typeof a.input_required === 'string' ? a.input_required : null;
        Object.assign(w, { status: 'done', status_since: this.h.now(), report });
        this.h.emit(send, { t: 'worker.upsert', worker: w });
        break;
      }
      case 'leave': {
        const i = this.h.workers.indexOf(w);
        this.h.workers.splice(i, 1);
        this.h.emit(send, { t: 'worker.removed', id: w.id, session: w.session, workspace_id: w.workspace_id });
        if (this.last === w.id) this.last = null;
        break;
      }
    }
    return { id: w.id, step: step as CrewStep };
  }

  private hire(a: Obj, send: Send): string {
    const orch = this.orchOf(a, send);
    const f = this.h.floors.get(orch.session) as Floor;
    const taken = new Set(this.h.workers.filter((x) => x.session === orch.session && typeof x.desk_index === 'number').map((x) => x.desk_index as number));
    const desks = f.desks ?? 6;
    const desk = nearestDesk(orch.desk_index ?? 0, taken, desks);
    if (desk >= desks) {
      f.desks = desk + 1;
      this.h.emit(send, { t: 'floor.upsert', floor: f });
    }
    const k = this.n++;
    const round = 1 + (k % 3);
    const descr = (orch.label.split('|')[1] ?? 'task').slice(0, 10);
    const ticket = orch.issue ? String(orch.issue.number) : undefined;
    const label = ticket ? `CODE|${descr}|${ticket}|r${round}` : `CODE|${descr}|r${round}`;
    const w: Worker = {
      id: `sim-crew-${(k + 1).toString(16).padStart(4, '0')}-4000-a000-000000000000`,
      session: orch.session,
      workspace_id: `wc${(k + 1).toString(36)}`,
      label,
      cwd: orch.cwd ?? '/home/dev/devel/lab',
      pane_id: `wc${(k + 1).toString(36)}:p1`,
      status: 'unknown',
      name: `${NAMES[k % NAMES.length]}${k >= NAMES.length ? ` ${Math.floor(k / NAMES.length) + 1}` : ''}`,
      desk_index: desk,
      harness: 'claude',
      model: 'claude-opus-5-5',
      effort: 'medium',
      status_since: this.h.now(),
      role: 'code',
      round,
      orch_id: orch.id,
      report: { state: 'pending' },
    };
    if (orch.run) w.run = orch.run;
    if (ticket) w.ticket = ticket;
    if (orch.issue) w.issue = orch.issue;
    this.h.workers.push(w);
    this.h.emit(send, { t: 'worker.upsert', worker: w });
    this.last = w.id;
    return w.id;
  }

  /** M6c: the simulator's orchestrator in the corner office (made on first use, at the first free desk of the first running floor). */
  private cornerOrch(send: Send): Worker {
    const have = this.h.workers.find((x) => x.corner === true && x.role === 'orch');
    if (have) return have;
    const host = this.h.workers.find((x) => x.role === 'orch' && x.run && this.h.floors.get(x.session)?.state === 'running');
    if (!host) throw this.h.error('invalid_state', 'invalid state: no running floor with a run to put a corner office on');
    const f = this.h.floors.get(host.session) as Floor;
    const taken = new Set(this.h.workers.filter((x) => x.session === host.session && typeof x.desk_index === 'number').map((x) => x.desk_index as number));
    const desks = f.desks ?? 6;
    const desk = nearestDesk(host.desk_index ?? 0, taken, desks);
    if (desk >= desks) {
      f.desks = desk + 1;
      this.h.emit(send, { t: 'floor.upsert', floor: f });
    }
    const w: Worker = {
      id: 'sim-orch-corner-4000-a000-000000000000',
      session: host.session,
      workspace_id: 'wcorner',
      label: 'ORCH|corner|9',
      cwd: host.cwd ?? '/home/dev/devel/lab',
      pane_id: 'wcorner:p1',
      status: 'working',
      name: 'Corner',
      desk_index: desk,
      harness: 'claude',
      model: 'claude-opus-5-5',
      effort: 'medium',
      status_since: this.h.now(),
      role: 'orch',
      run: 'sim-corner',
      phase: 'review',
      pass: 1,
      corner: true,
    };
    if (host.issue) w.issue = host.issue;
    this.h.workers.push(w);
    this.h.emit(send, { t: 'worker.upsert', worker: w });
    return w;
  }

  private orchOf(a: Obj, send?: Send): Worker {
    if (a.corner === true && send) return this.cornerOrch(send);
    if (typeof a.orch === 'string') {
      const o = this.h.workers.find((x) => x.id === a.orch && x.role === 'orch');
      if (!o) throw this.h.error('unknown_worker', `unknown orchestrator: "${a.orch}"`);
      return o;
    }
    const session = typeof a.session === 'string' ? a.session : null;
    const o = this.h.workers.find((x) => x.role === 'orch' && x.run && (!session || x.session === session) && this.h.floors.get(x.session)?.state === 'running');
    if (!o) throw this.h.error('invalid_state', `invalid state: no orchestrator with a run${session ? ` on ${session}` : ''}`);
    return o;
  }

  /** `simcrew=<ms>`: plays the script by itself, a step every `ms`, round and round. */
  start(send: Send, ms: number): void {
    if (!(ms > 0)) return;
    const next = () => {
      const step = CREW_STEPS[this.auto++ % CREW_STEPS.length] as CrewStep;
      try {
        this.handle(step === 'hire' ? { step, corner: this.round % 2 === 1 } : { step }, send);
        if (step === 'leave') this.round++;
      } catch {
        // No orchestrator (yet): try again next time round.
        this.auto = 0;
      }
      this.h.after(ms, next);
    };
    this.h.after(ms, next);
  }
}
