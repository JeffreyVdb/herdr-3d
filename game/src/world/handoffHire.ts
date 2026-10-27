import type { HandoffHire } from '../net/protocol';

/**
 * #219: the bridge's pending handoff hires (`World.handoff_hires`, `handoff_hire.upsert` / `.removed`), by the handoff's
 * op. A `waiting` or `hiring` record holds its desk for every client (nobody hires into it) and puts a line on its source
 * worker's card; a terminal one stays a while so the browser that asked can say how it ended (ui/handoffHires.ts).
 * `known` is false from a bridge without them: the review then hires after filing itself, as #198 did.
 */

const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const STATES = new Set(['waiting', 'hiring', 'hired', 'failed', 'cancelled']);

/** Waiting for the handoff, or hiring now: its desk is held. */
export function pendingHire(r: Pick<HandoffHire, 'state'>): boolean {
  return r.state === 'waiting' || r.state === 'hiring';
}

/** The line on the source worker's card while its handoff hire is pending. */
export function handoffHireLine(r: Pick<HandoffHire, 'state' | 'desk_index'>): string {
  return r.state === 'hiring' ? `Hiring at Desk ${r.desk_index + 1}…` : `Writing handoff → hires at Desk ${r.desk_index + 1}`;
}

export function validHandoffHire(r: unknown): r is HandoffHire {
  return (
    obj(r) &&
    typeof r.op === 'string' &&
    !!r.op &&
    typeof r.worker === 'string' &&
    typeof r.floor === 'string' &&
    typeof r.desk_index === 'number' &&
    Number.isInteger(r.desk_index) &&
    r.desk_index >= 0 &&
    typeof r.state === 'string' &&
    STATES.has(r.state)
  );
}

export class HandoffHireBook {
  /** The bridge sends them (the snapshot had the key): `worker.handoff` may carry `hire`. */
  known = false;
  version = 0;
  private readonly byOp = new Map<string, HandoffHire>();

  reset(list: HandoffHire[] | undefined): void {
    this.known = Array.isArray(list);
    this.byOp.clear();
    for (const r of Array.isArray(list) ? list : []) if (validHandoffHire(r)) this.byOp.set(r.op, r);
    this.version++;
  }

  /** The record before this one (undefined: new), or null when `r` is not a record. */
  upsert(r: HandoffHire): HandoffHire | undefined | null {
    if (!validHandoffHire(r)) return null;
    this.known = true;
    const was = this.byOp.get(r.op);
    this.byOp.set(r.op, r);
    this.version++;
    return was;
  }

  /** The record that left (undefined: none). */
  removed(op: string): HandoffHire | undefined {
    this.known = true;
    const was = this.byOp.get(op);
    if (was) {
      this.byOp.delete(op);
      this.version++;
    }
    return was;
  }

  get(op: string): HandoffHire | undefined {
    return this.byOp.get(op);
  }

  all(): HandoffHire[] {
    return [...this.byOp.values()];
  }

  /** Desks of a floor a pending handoff hire holds. */
  held(floor: string): Set<number> {
    const out = new Set<number>();
    for (const r of this.byOp.values()) if (r.floor === floor && pendingHire(r)) out.add(r.desk_index);
    return out;
  }

  /** The pending handoff hire that holds `desk` of `floor` (undefined: none). */
  holding(floor: string, desk: number): HandoffHire | undefined {
    for (const r of this.byOp.values()) if (r.floor === floor && r.desk_index === desk && pendingHire(r)) return r;
    return undefined;
  }

  /** The source worker's pending handoff hire (the newest when there were several). */
  forWorker(id: string): HandoffHire | undefined {
    let best: HandoffHire | undefined;
    for (const r of this.byOp.values()) if (r.worker === id && pendingHire(r) && (!best || r.started_at > best.started_at)) best = r;
    return best;
  }
}
