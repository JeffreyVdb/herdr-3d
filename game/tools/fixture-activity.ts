// #98: what the agents are doing, simulated for the fixture server (`sim=1`, see tools/fixture-sim.ts). Rules, like
// herdr-world's (docs/protocol.md "Activity"):
// - `sim.activity {id, activity?, status?, image?}` (the simulator's own) sets the worker's activity and sends
//   `worker.activity` (absent or null: cleared, the event without `activity`). `status` (working | idle | done | blocked)
//   sends a `worker.status` first when it changes it. `activity.since` defaults to now. Acks `{activity}`.
// - `image: {seed?, w?, h?, name?, via?}` makes a real PNG (tools/fixture-transcript.ts) and sets
//   `{kind: 'image', image: {hash, w, h}, detail: name}`. The three ways an agent looks at an image (`via`: a Claude
//   `Read` of a png, Codex's `view_image`, a Codex code-mode `exec` whose script calls `tools.view_image`) are the same
//   activity to the game; `via` only picks the default name and source.
// - A worker's current `activity.image.hash` is served by `transcript.image` to the connection without a transcript
//   watch (the bridge's floor rule); any other hash keeps the watch's rule (`activityHash` in the transcript sim).
// - `simactivity=demo` gives every working Claude or Codex worker an activity when the world starts (the kinds in turn,
//   each with its detail, started a while ago), the first idle Claude one waiting on two background tasks and the third
//   working Codex one an image; `simactivity=all` gives every working one an activity (perf runs).
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import type { Activity, ActivityKind, Floor, Worker } from '../src/net/protocol.ts';
import { simImage } from './fixture-transcript.ts';

type Obj = Record<string, unknown>;
type Send = (m: Obj) => void;

export interface ActivityHost {
  workers: Worker[];
  floors: Map<string, Floor>;
  emit(send: Send, m: Obj): void;
  now(): number;
  error(code: string, message: string): Error;
}

const KINDS = new Set<string>(['thinking', 'replying', 'writing', 'investigating', 'testing', 'building', 'shipping', 'researching', 'delegating', 'planning', 'waiting', 'image', 'working']);
const STATUSES = new Set(['working', 'idle', 'done', 'blocked']);
const VIA: Record<string, { name: string; source: Activity['source'] }> = {
  read: { name: 'needs-you-desk.png', source: 'rule' },
  view_image: { name: 'monitor-card.png', source: 'rule' },
  exec: { name: 'waiting-band.png', source: 'rule' },
};

/** The demo's labels, in turn: a detail like the bridge's (basenames, runners, clipped command heads). */
export const DEMO: ReadonlyArray<{ kind: ActivityKind; detail?: string }> = [
  { kind: 'testing', detail: 'pytest -n auto' },
  { kind: 'writing', detail: 'store.ts +2' },
  { kind: 'investigating', detail: 'rg activityOf game/src' },
  { kind: 'thinking' },
  { kind: 'building', detail: 'go build ./...' },
  { kind: 'shipping', detail: 'git push' },
  { kind: 'researching', detail: 'web search' },
  { kind: 'delegating', detail: 'Agent: review the diff' },
  { kind: 'planning', detail: 'update_plan' },
  { kind: 'replying' },
  { kind: 'working', detail: 'herdr agent get' },
];

const harnessOf = (w: Worker) => w.harness ?? (w.agent_kind === 'claude' || w.agent_kind === 'codex' ? w.agent_kind : undefined);

export class ActivitySim {
  private readonly h: ActivityHost;

  constructor(h: ActivityHost, mode: string | undefined) {
    this.h = h;
    if (mode === 'demo' || mode === 'all') this.seed(mode);
  }

  private seed(mode: 'demo' | 'all'): void {
    const now = this.h.now();
    let i = 0;
    let codex = 0;
    let waiting = false;
    for (const w of this.h.workers) {
      const harness = harnessOf(w);
      if (harness !== 'claude' && harness !== 'codex') continue;
      if (w.status === 'working') {
        if (mode === 'demo' && harness === 'codex' && ++codex === 3) {
          w.activity = this.imageActivity({ seed: 31, via: 'view_image' }, now - 4_000);
          continue;
        }
        const d = DEMO[i++ % DEMO.length] as (typeof DEMO)[number];
        w.activity = { kind: d.kind, ...(d.detail ? { detail: d.detail } : {}), since: now - (7 + i * 13) * 1000, source: 'rule' };
      } else if (mode === 'demo' && !waiting && harness === 'claude' && w.status === 'idle') {
        waiting = true;
        w.activity = { kind: 'waiting', detail: 'Testing in the background', since: now - 95_000, source: 'derived', tasks: 2 };
      }
    }
  }

  /** The hash `transcript.image` serves for this worker without a watch (its current activity's image). */
  hash(id: string): string | undefined {
    return this.h.workers.find((w) => w.id === id)?.activity?.image?.hash;
  }

  /** Handles `sim.activity`; false for anything else. */
  handle(t: unknown, a: Obj, send: Send, ack: (d?: unknown) => void, fail: (e: unknown) => void): boolean {
    if (t !== 'sim.activity') return false;
    try {
      ack(this.set(a, send));
    } catch (e) {
      fail(e);
    }
    return true;
  }

  private imageActivity(spec: Obj, since: number): Activity {
    const via = VIA[typeof spec.via === 'string' ? spec.via : 'read'] ?? (VIA.read as { name: string; source: Activity['source'] });
    const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(2400, Math.round(v)) : d);
    const ref = simImage({ seed: num(spec.seed, 7), w: num(spec.w, 1280), h: num(spec.h, 800) });
    const name = typeof spec.name === 'string' && spec.name ? spec.name : via.name;
    return { kind: 'image', detail: name, since, source: via.source, image: { hash: ref.hash as string, w: ref.width ?? 0, h: ref.height ?? 0 } };
  }

  private set(a: Obj, send: Send): Obj {
    const id = a.id;
    if (typeof id !== 'string' || !id) throw this.h.error('bad_request', 'bad args: id must be a string');
    const w = this.h.workers.find((x) => x.id === id);
    if (!w) throw this.h.error('unknown_worker', `unknown worker: "${id}"`);
    const now = this.h.now();
    if (a.status !== undefined) {
      if (typeof a.status !== 'string' || !STATUSES.has(a.status)) throw this.h.error('bad_request', 'bad args: status must be working, idle, done or blocked');
      if (a.status !== w.status) {
        const prev = w.status;
        w.status = a.status;
        w.status_since = now;
        this.h.emit(send, { t: 'worker.status', id, session: w.session, workspace_id: w.workspace_id, status: w.status, prev_status: prev, status_since: now });
      }
    }
    let next: Activity | null = null;
    if (a.image !== undefined && a.image !== null) {
      if (typeof a.image !== 'object' || Array.isArray(a.image)) throw this.h.error('bad_request', 'bad args: image must be an object');
      next = this.imageActivity(a.image as Obj, now);
    } else if (a.activity !== undefined && a.activity !== null) {
      const o = a.activity as Obj;
      if (typeof o !== 'object' || Array.isArray(o) || typeof o.kind !== 'string') throw this.h.error('bad_request', 'bad args: activity needs a kind');
      // An unknown kind goes out as it is: the game must read it as working.
      next = { ...(o as unknown as Activity), since: typeof o.since === 'number' ? o.since : now, source: (o.source as Activity['source']) ?? (KINDS.has(o.kind) ? 'rule' : 'model') };
    }
    if (next) w.activity = next;
    else delete w.activity;
    this.h.emit(send, { t: 'worker.activity', id, session: w.session, workspace_id: w.workspace_id, ...(next ? { activity: next } : {}) });
    return { activity: next };
  }
}
