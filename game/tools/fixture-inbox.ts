// #106: the inbox's dismissals for the fixture server's `sim=1` (tools/fixture-sim.ts hands these commands over).
// Rules, like herdr-world's (docs/protocol.md "Inbox"):
// - `inbox.dismiss {id, status_since}` is recorded only while the worker is `done` with that very `status_since`, and
//   sends `inbox.dismissed {id, status_since}` (before the ack) when it is new; otherwise it acks `{dismissed: false}`
//   and sends nothing; a missing id or a `status_since` that is not positive is `bad_request`;
// - the snapshot's `inbox_dismissed` is the map, leaving out what the workers no longer match (a dismissal is the done
//   episode's `status_since`), `{}` when none;
// - `simfail=no_inbox` plays a bridge before #106: `inbox.dismiss` is `unknown_command`, the snapshot has no map;
// - `sim.status {id, status}` (the simulator's own, not a bridge command) moves a worker to a status as herdr would:
//   a `worker.status` with a new `status_since`.
// One simulated bridge per connection: a second browser does not share it (the Go hub's tests cover the broadcast).
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import type { Worker } from '../src/net/protocol.ts';

type Obj = Record<string, unknown>;
type Send = (m: Obj) => void;

export interface InboxHost {
  readonly workers: Worker[];
  emit(send: Send, m: Obj): void;
  error(code: string, message: string): Error;
  now(): number;
}

export class InboxSim {
  private readonly dismissed = new Map<string, number>();

  constructor(
    private readonly h: InboxHost,
    private readonly present: boolean,
  ) {}

  /** The dismissals that still hold. */
  private current(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, since] of this.dismissed) {
      const w = this.h.workers.find((x) => x.id === id);
      if (w?.status === 'done' && w.status_since === since) out[id] = since;
    }
    return out;
  }

  decorate(world: Obj): void {
    if (this.present) world.inbox_dismissed = this.current();
  }

  handle(t: unknown, a: Obj, send: Send, ack: (d?: unknown) => void): boolean {
    if (t === 'sim.status') {
      const w = this.h.workers.find((x) => x.id === a.id);
      if (!w || typeof a.status !== 'string') throw this.h.error('bad_request', 'sim.status needs a worker id and a status');
      const prev = w.status;
      w.status = a.status as Worker['status'];
      w.status_since = this.h.now();
      this.h.emit(send, { t: 'worker.status', id: w.id, session: w.session, workspace_id: w.workspace_id, status: w.status, prev_status: prev, status_since: w.status_since, title: w.title ?? '' });
      ack();
      return true;
    }
    if (t !== 'inbox.dismiss' || !this.present) return false;
    if (typeof a.id !== 'string' || !a.id || typeof a.status_since !== 'number' || !(a.status_since > 0)) throw this.h.error('bad_request', 'bad args: id and status_since are required');
    const w = this.h.workers.find((x) => x.id === a.id);
    if (!w || w.status !== 'done' || w.status_since !== a.status_since) {
      ack({ dismissed: false });
      return true;
    }
    if (this.dismissed.get(w.id) !== a.status_since) {
      this.dismissed.set(w.id, a.status_since);
      this.h.emit(send, { t: 'inbox.dismissed', id: w.id, status_since: a.status_since });
    }
    ack({ dismissed: true });
    return true;
  }
}
