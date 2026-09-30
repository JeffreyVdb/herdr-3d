// M16: the transcript view's commands, simulated for the fixture server (`sim=1`, see tools/fixture-sim.ts). Rules,
// like herdr-world's (docs/protocol.md "Laptops: transcript"):
// - `transcript.watch {id, limit?}` (limit 1-500, 0/absent: 200) acks the worker's timeline (the demo one below: every
//   item kind, in the bridge's shape) as `{harness, session, version, cursor, has_more, pending: false, items}`; at
//   most 4 per connection (`capacity`); a worker on a sleeping floor is `invalid_state`, an unknown one
//   `unknown_worker`. A re-watch of the same worker replaces the watch.
// - `transcript.unwatch {id}`: always acked.
// - `transcript.page {id, before, limit?, agent?}` and `transcript.item {id, item, agent?}` answer only for a watched
//   worker (`invalid_state` otherwise). With `agent`, the subagent's own timeline: the bridge's items for its
//   fixture (fixtures/transcript/claude-subagent.json) for the demo's Agent call, `not_found` for any other id.
//   Without `agent`, `before` must be a cursor (`c:<seq>`): the demo is one page, so older pages are empty.
// - World events end the watches they concern: `worker.removed` → `transcript.closed {worker_removed}`, the floor
//   falling asleep → `{asleep}`.
// - `sim.transcript {id, items?, updates?, close?}` (the simulator's own): pushes `transcript.items` to the worker's
//   watch, or closes it with `close` as the reason. `sim.transcripts {}` answers `{watches, ids}`.
// - `simfail=no_m16` plays a bridge before M16: every transcript command is `unknown_command`.
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Floor, TranscriptItem, Worker } from '../src/net/protocol.ts';

type Obj = Record<string, unknown>;
type Send = (m: Obj) => void;

export const SIM_MAX_TRANSCRIPT_WATCHES = 4;
/** The agent id of the demo's subagent: the one fixtures/transcript/claude-subagent.json was read from. */
export const SIM_SUBAGENT = 'aa3716c63ba631707';

export interface TranscriptHost {
  worker(id: string): Worker | undefined;
  floor(session: string): Floor | undefined;
  now(): number;
  error(code: string, message: string): Error;
}

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'transcript');

let subagent: TranscriptItem[] | null = null;
const subagentItems = (): TranscriptItem[] => (subagent ??= JSON.parse(readFileSync(join(FIXTURES, 'claude-subagent.json'), 'utf8')) as TranscriptItem[]);

/** The demo timeline at `now`: every kind the bridge sends, a few of each worth looking at (and some hostile text). */
export function demoTimeline(now: number): TranscriptItem[] {
  let seq = 0;
  const it = (kind: TranscriptItem['kind'], extra: Partial<TranscriptItem>, id?: string): TranscriptItem => {
    seq++;
    return { id: id ?? `demo-${seq}`, seq, ts: now - (40 - seq) * 20_000, kind, ...extra };
  };
  return [
    it('notice', { hidden: true, notice: { text: 'claude 2.1.0', source: 'system/init' } }),
    it('user', { parts: [{ text: 'The HUD overlaps the laptop screen on small windows. Can you fix it and add a test?' }, { image_omitted: true }] }),
    it('thinking', { parts: [{ text: 'The seat pose uses `insets()`; the overlap is probably the seat bar height.' }] }),
    it('assistant', { parts: [{ text: "I'll look at how the seated camera is placed. The relevant code is in `seatPose`:\n\n```ts\nconst top = Math.min(H * 0.3, ins.top + 10);\nconst bottom = Math.min(H * 0.35, ins.bottom + 10);\n```" }] }),
    it('tool', { tool: { name: 'Grep', input_summary: 'insets\\(\\) in src/', status: 'ok', output_text: 'src/app.ts:361\nsrc/laptop/index.ts:343' } }, 'toolu_demo_grep'),
    it('tool', { tool: { name: 'Read', input_summary: 'src/laptop/index.ts', status: 'ok', output_text: '…' } }, 'toolu_demo_read'),
    it('notice', { hidden: true, notice: { text: 'Turn took 41s', source: 'system/turn_duration' } }),
    it(
      'tool',
      {
        tool: {
          name: 'Edit',
          input_summary: 'src/laptop/index.ts',
          status: 'ok',
          diff: {
            path: 'src/laptop/index.ts',
            hunks: [
              {
                old_start: 341,
                old_lines: 4,
                new_start: 341,
                new_lines: 4,
                lines: ['     const H = Math.max(1, window.innerHeight);', '     const ins = this.host.insets();', '-    const top = Math.min(H * 0.3, ins.top + 10);', '+    const top = Math.min(H * 0.3, ins.top + 14);', '     const bottom = Math.min(H * 0.35, ins.bottom + 10);'],
              },
            ],
          },
        },
      },
      'toolu_demo_edit',
    ),
    it('compaction', { notice: { text: 'Conversation compacted', source: 'system/compact_boundary' } }),
    it('subagent', { tool: { name: 'Agent', input_summary: 'Check the other seated overlays', status: 'ok' }, subagent: { agent_id: SIM_SUBAGENT, description: 'Check the other seated overlays', status: 'completed' } }, 'toolu_demo_agent'),
    it('tool', { tool: { name: 'Bash', input_summary: 'pnpm vitest run src/laptop', status: 'error', output_text: '\u001b[31m FAIL \u001b[39m src/laptop/keys.test.ts > seatedKey\n\u001b[2mAssertionError: expected none(true)\u001b[22m\n\n Tests  1 failed | 41 passed' } }, 'toolu_demo_bash1'),
    it('notice', { notice: { text: 'Interrupted by user', source: 'user/interrupt' } }),
    it('assistant', { parts: [{ text: 'One test fails because of **the Esc mapping**. See <script>window.__pwned = 1</script> [details](javascript:window.__pwned=2) and <img src=x onerror="window.__pwned=3">.' }] }),
    it('tool', { tool: { name: 'Bash', input_summary: 'pnpm vitest run src/laptop --reporter dot', status: 'running' } }, 'toolu_demo_bash2'),
    it('unknown', { hidden: true, raw_type: 'queue-operation' }),
  ];
}

interface Watch {
  send: Send;
  items: TranscriptItem[];
}

export class TranscriptSim {
  readonly watches = new Map<string, Watch>();
  private readonly host: TranscriptHost;
  private readonly on: boolean;

  constructor(host: TranscriptHost, on = true) {
    this.host = host;
    this.on = on;
  }

  /** Handles the transcript commands; false for anything else. */
  handle(t: unknown, a: Obj, send: Send, ack: (d?: unknown) => void, fail: (e: unknown) => void): boolean {
    if (typeof t !== 'string' || !(t.startsWith('transcript.') || t === 'sim.transcript' || t === 'sim.transcripts')) return false;
    try {
      if (!this.on && t.startsWith('transcript.')) throw this.host.error('unknown_command', `unknown command: "${t}"`);
      if (t === 'transcript.watch') ack(this.watch(a, send));
      else if (t === 'transcript.unwatch') {
        this.watches.delete(this.str(a, 'id'));
        ack();
      } else if (t === 'transcript.page') ack(this.page(a));
      else if (t === 'transcript.item') ack(this.item(a));
      else if (t === 'sim.transcript') ack(this.sim(a));
      else if (t === 'sim.transcripts') ack({ watches: this.watches.size, ids: [...this.watches.keys()] });
      else throw this.host.error('unknown_command', `unknown command: "${t}"`);
      return true;
    } catch (e) {
      fail(e);
      return true;
    }
  }

  private str(a: Obj, k: string, optional = false): string {
    const v = a[k];
    if (optional && (v === undefined || v === '')) return '';
    if (typeof v !== 'string' || !v) throw this.host.error('bad_request', `bad args: ${k} must be a string`);
    return v;
  }

  private limit(a: Obj): number {
    const v = a.limit ?? 0;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 500) throw this.host.error('bad_request', 'limit must be 1-500');
    return v || 200;
  }

  private worker(id: string): Worker {
    const w = this.host.worker(id);
    if (!w) throw this.host.error('unknown_worker', `unknown worker: "${id}"`);
    if (this.host.floor(w.session)?.state === 'asleep') throw this.host.error('invalid_state', `floor "${w.session}" is asleep`);
    return w;
  }

  private watch(a: Obj, send: Send): Obj {
    const id = this.str(a, 'id');
    const limit = this.limit(a);
    this.worker(id);
    const n = this.watches.size - (this.watches.has(id) ? 1 : 0);
    if (n >= SIM_MAX_TRANSCRIPT_WATCHES) throw this.host.error('capacity', `capacity: this connection already watches ${n} transcripts (--max-transcript-watches)`);
    const items = demoTimeline(this.host.now());
    this.watches.set(id, { send, items });
    const visible = items.filter((it) => !it.hidden);
    const from = visible.length > limit ? items.indexOf(visible[visible.length - limit] as TranscriptItem) : 0;
    return { harness: 'claude', session: `sim-${id}`, version: '2.1.0', cursor: `c:${items[from]?.seq ?? 1}`, has_more: from > 0, pending: false, items: items.slice(from) };
  }

  private watched(a: Obj): Watch {
    const id = this.str(a, 'id');
    const w = this.watches.get(id);
    if (!w) {
      this.worker(id);
      throw this.host.error('invalid_state', 'invalid state: this connection does not watch that transcript');
    }
    return w;
  }

  private page(a: Obj): Obj {
    const w = this.watched(a);
    const before = this.str(a, 'before', true);
    const agent = this.str(a, 'agent', true);
    this.limit(a);
    if (before && !/^c:[1-9]\d*$/.test(before)) throw this.host.error('bad_request', 'before must be a cursor');
    if (!agent) {
      if (!before) throw this.host.error('bad_request', 'before is needed (it is optional with agent)');
      const seq = Number(before.slice(2));
      return { items: w.items.filter((it) => it.seq < seq), cursor: 'c:1', has_more: false };
    }
    if (agent !== SIM_SUBAGENT) throw this.host.error('not_found', `no transcript for subagent "${agent}"`);
    return { items: subagentItems(), cursor: 'c:1', has_more: false };
  }

  private item(a: Obj): Obj {
    const w = this.watched(a);
    const want = this.str(a, 'item');
    const agent = this.str(a, 'agent', true);
    const from = agent === SIM_SUBAGENT ? subagentItems() : agent ? null : w.items;
    const it = from?.find((x) => x.id === want);
    if (!it) throw this.host.error('not_found', `no item "${want}" in the transcript`);
    return { item: it };
  }

  private sim(a: Obj): Obj {
    const id = this.str(a, 'id');
    const w = this.watches.get(id);
    if (!w) throw this.host.error('invalid_state', `no transcript watch of "${id}"`);
    if (typeof a.close === 'string' && a.close) {
      this.close(id, a.close);
      return { closed: true };
    }
    const items = Array.isArray(a.items) ? (a.items as TranscriptItem[]) : [];
    const updates = Array.isArray(a.updates) ? (a.updates as TranscriptItem[]) : [];
    for (const it of [...items, ...updates]) {
      const at = w.items.findIndex((x) => x.id === it.id);
      if (at >= 0) w.items[at] = it;
      else w.items.push(it);
    }
    w.send({ t: 'transcript.items', id, items, updates });
    return { pushed: items.length + updates.length };
  }

  private close(id: string, reason: string): void {
    const w = this.watches.get(id);
    if (!w) return;
    this.watches.delete(id);
    w.send({ t: 'transcript.closed', id, reason });
  }

  /** World events end the watches they concern (as the bridge's syncTranscriptWatches). */
  onEvent(m: Obj): void {
    if (!this.watches.size || typeof m.seq !== 'number') return;
    if (m.t === 'worker.removed' && typeof m.id === 'string') this.close(m.id, 'worker_removed');
    else if (m.t === 'floor.upsert') {
      const f = m.floor as Floor | undefined;
      if (f?.state !== 'asleep') return;
      for (const id of [...this.watches.keys()]) if (this.host.worker(id)?.session === f.session) this.close(id, 'asleep');
    }
  }
}
