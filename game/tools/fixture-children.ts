// #26: native child agents in the fixture simulation (`sim=1`): the children a children fixture's recorded events make
// (game/fixtures/children-*.jsonl, from internal/childagents/testdata), folded into the simulated world's snapshot so
// their own transcripts can be opened (tools/fixture-transcript.ts). The simulation does not play recorded events; these
// are its world from the start.
// - `sim.child {child}` upserts a child (the whole row, as `child.upsert` carries it); `sim.child {id, worker_id,
//   removed: true}` removes one (`child.removed`). `sim.child_session {id}` replaces a worker's root session: its child
//   generation goes up and its children go (a `worker.upsert`, no `child.removed`), as the bridge does.
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import type { Child, Worker } from '../src/net/protocol.ts';

type Obj = Record<string, unknown>;
type Send = (m: Obj) => void;

export interface ChildrenHost {
  readonly workers: Worker[];
  emit(send: Send, m: Obj): void;
  error(code: string, message: string): Error;
}

/** The rows the recorded events leave, in the order first seen (a removed one goes). */
export function foldChildren(events: readonly Obj[]): Child[] {
  const rows = new Map<string, Child>();
  for (const e of events) {
    if (e.t === 'child.upsert' && e.child && typeof e.child === 'object') {
      const c = e.child as Child;
      rows.set(c.id, c);
    } else if (e.t === 'child.removed' && typeof e.id === 'string') rows.delete(e.id);
  }
  return [...rows.values()];
}

export class ChildrenSim {
  private rows: Child[];
  private readonly h: ChildrenHost;

  constructor(h: ChildrenHost, events: readonly Obj[]) {
    this.h = h;
    this.rows = foldChildren(events);
  }

  get(worker: string, id: string): Child | undefined {
    return this.rows.find((c) => c.worker_id === worker && c.id === id);
  }

  decorate(world: Obj): void {
    if (this.rows.length) world.children = this.rows;
  }

  handle(t: unknown, a: Obj, send: Send, ack: (d?: unknown) => void): boolean {
    if (t === 'sim.child') {
      if (a.removed === true) {
        const c = typeof a.id === 'string' ? this.get(String(a.worker_id), a.id) : undefined;
        if (!c) throw this.h.error('not_found', 'sim.child: no such child');
        this.rows = this.rows.filter((x) => x !== c);
        this.h.emit(send, { t: 'child.removed', id: c.id, worker_id: c.worker_id, generation: c.generation });
        ack();
        return true;
      }
      const c = a.child as Child | undefined;
      if (!c || typeof c.id !== 'string' || typeof c.worker_id !== 'string') throw this.h.error('bad_request', 'sim.child needs a child row');
      const at = this.rows.findIndex((x) => x.id === c.id);
      if (at >= 0) this.rows[at] = c;
      else this.rows.push(c);
      this.h.emit(send, { t: 'child.upsert', child: c });
      ack();
      return true;
    }
    if (t === 'sim.child_session') {
      const w = this.h.workers.find((x) => x.id === a.id);
      if (!w) throw this.h.error('unknown_worker', 'sim.child_session: no such worker');
      w.child_generation = (w.child_generation ?? 0) + 1;
      w.agent_session = `${w.agent_session ?? 'sess'}-next`;
      this.rows = this.rows.filter((x) => x.worker_id !== w.id);
      this.h.emit(send, { t: 'worker.upsert', worker: w });
      ack({ child_generation: w.child_generation });
      return true;
    }
    return false;
  }
}
