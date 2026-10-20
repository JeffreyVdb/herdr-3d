import { describe, expect, it } from 'vitest';
import type { TranscriptItem } from '../src/net/protocol';
import { watchAck } from '../src/laptop/transcriptWatches';
import { loadFixture } from './fixture-server';
import { SimWorld } from './fixture-sim';
import { SIM_MAX_TRANSCRIPT_WATCHES, SIM_SUBAGENT } from './fixture-transcript';

type Msg = Record<string, unknown>;

function rig(fail?: string, echoMs?: number) {
  const { snapshot } = loadFixture('demo-m4');
  const timers = new Map<number, () => void>();
  let t = 0;
  const sim = new SimWorld(snapshot as never, {
    fail,
    stepMs: 100,
    ...(echoMs !== undefined ? { echoMs } : {}),
    now: () => 1_000_000,
    setTimeout: (fn) => (timers.set(++t, fn), t),
    clearTimeout: (h) => timers.delete(h as number),
  });
  /** Runs every timer due, and the ones they start. */
  const settle = () => {
    for (let i = 0; i < 100 && timers.size; i++) {
      const [id, fn] = [...timers][0] as [number, () => void];
      timers.delete(id);
      fn();
    }
  };
  const out: Msg[] = [];
  let n = 0;
  const cmd = (t: string, args: unknown) => {
    const req_id = `r${++n}`;
    sim.handle({ t, req_id, args }, (m) => out.push(m));
    return out.find((m) => m.req_id === req_id) as Msg & { data?: Record<string, unknown>; code?: string };
  };
  return { sim, out, cmd, settle };
}

const world = loadFixture('demo-m4').snapshot as unknown as { world: { workers: Array<{ name?: string; id: string }> } };
const byName = (name: string) => world.world.workers.find((w) => w.name === name)?.id as string;
const agent = byName('Nibble'); // herdr-3d, claude
const asleep = byName('Muffin'); // depot-manager, asleep

describe('TranscriptSim', () => {
  it('#58 simecho: a prompt reaches the watch as its user item, taken at once when idle, mid-turn when queued', () => {
    const r = rig(undefined, 250);
    const idle = world.world.workers.find((w) => (w as { status?: string; agent_kind?: string }).status === 'idle' && (w as { agent_kind?: string }).agent_kind)?.id as string;
    for (const id of [agent, idle]) r.cmd('transcript.watch', { id });
    const users = (id: string) => r.out.filter((m) => m.t === 'transcript.items' && m.id === id).flatMap((m) => m.items as TranscriptItem[]).filter((it) => it.kind === 'user');
    const queued = r.cmd('worker.prompt', { id: agent, text: '  and the docs\n' });
    expect(queued.data).toEqual({ queued: true, retried: false });
    r.cmd('worker.prompt', { id: idle, text: 'fix it' });
    expect(users(agent)).toEqual([]);
    r.settle();
    expect(users(agent).map((it) => it.parts)).toEqual([[{ text: 'and the docs' }]]);
    expect(users(idle).map((it) => it.parts)).toEqual([[{ text: 'fix it' }]]);
    // After the timeline it was watched with (a new watch has the same demo, without it).
    const top = Math.max(...watchAck(r.cmd('transcript.watch', { id: idle }).data).items.map((it) => it.seq));
    expect(users(idle)[0]?.seq).toBe(top + 1);
  });

  it('#58 without simecho, prompts never show in the transcript', () => {
    const r = rig();
    r.cmd('transcript.watch', { id: agent });
    r.cmd('worker.prompt', { id: agent, text: 'x' });
    r.settle();
    expect(r.out.filter((m) => m.t === 'transcript.items')).toEqual([]);
  });

  it('acks a watch with the demo timeline in the bridge’s shape', () => {
    const r = rig();
    const a = r.cmd('transcript.watch', { id: agent, limit: 200 });
    expect(a.t).toBe('ack');
    const ack = watchAck(a.data);
    expect(ack).toMatchObject({ harness: 'claude', pending: false, has_more: false });
    expect(ack.items.length).toBe((a.data?.items as unknown[]).length);
    const kinds = new Set(ack.items.map((it) => it.kind));
    for (const k of ['user', 'assistant', 'thinking', 'tool', 'subagent', 'compaction', 'notice', 'unknown']) expect(kinds).toContain(k);
    expect(ack.items.find((it) => it.kind === 'subagent')?.subagent?.agent_id).toBe(SIM_SUBAGENT);
    expect(r.cmd('sim.transcripts', {}).data).toEqual({ watches: 1, ids: [agent] });
    expect(r.cmd('transcript.unwatch', { id: agent }).t).toBe('ack');
    expect(r.cmd('sim.transcripts', {}).data).toEqual({ watches: 0, ids: [] });
  });

  it('limits and refusals as the bridge: limit, unknown worker, asleep, capacity', () => {
    const r = rig();
    expect(r.cmd('transcript.watch', { id: agent, limit: 501 }).code).toBe('bad_request');
    expect(r.cmd('transcript.watch', { id: 'nope' }).code).toBe('unknown_worker');
    expect(r.cmd('transcript.watch', { id: asleep }).code).toBe('invalid_state');
    const awake = world.world.workers.filter((w) => w.id !== asleep).slice(0, SIM_MAX_TRANSCRIPT_WATCHES + 1);
    for (const w of awake.slice(0, SIM_MAX_TRANSCRIPT_WATCHES)) expect(r.cmd('transcript.watch', { id: w.id }).t).toBe('ack');
    // A re-watch replaces; a fifth worker is over the cap.
    expect(r.cmd('transcript.watch', { id: awake[0]?.id }).t).toBe('ack');
    expect(r.cmd('transcript.watch', { id: awake[SIM_MAX_TRANSCRIPT_WATCHES]?.id }).code).toBe('capacity');
  });

  it('a subagent is a page with agent; other pages need a cursor; only for a watched worker', () => {
    const r = rig();
    expect(r.cmd('transcript.page', { id: agent, before: '', agent: SIM_SUBAGENT }).code).toBe('invalid_state');
    r.cmd('transcript.watch', { id: agent });
    const sub = r.cmd('transcript.page', { id: agent, before: '', agent: SIM_SUBAGENT, limit: 500 });
    expect(sub.t).toBe('ack');
    expect(Object.keys(sub.data ?? {}).sort()).toEqual(['cursor', 'has_more', 'items']);
    expect((sub.data?.items as TranscriptItem[]).length).toBeGreaterThan(0);
    expect(r.cmd('transcript.page', { id: agent, before: '', agent: 'other' }).code).toBe('not_found');
    expect(r.cmd('transcript.page', { id: agent, before: '' }).code).toBe('bad_request');
    expect(r.cmd('transcript.page', { id: agent, before: 'c:1' }).data).toEqual({ items: [], cursor: 'c:1', has_more: false });
    expect((r.cmd('transcript.item', { id: agent, item: 'toolu_demo_edit' }).data?.item as TranscriptItem).tool?.name).toBe('Edit');
    expect(r.cmd('transcript.item', { id: agent, item: 'nope' }).code).toBe('not_found');
  });

  it('sim.transcript pushes items and closes; world events close the watches they end', () => {
    const r = rig();
    r.cmd('transcript.watch', { id: agent });
    r.cmd('sim.transcript', { id: agent, updates: [{ id: 'toolu_demo_bash2', seq: 14, ts: 0, kind: 'tool', tool: { name: 'Bash', input_summary: 'x', status: 'ok' } }] });
    expect(r.out.find((m) => m.t === 'transcript.items')).toMatchObject({ id: agent, items: [], updates: [{ id: 'toolu_demo_bash2' }] });
    r.cmd('sim.transcript', { id: agent, close: 'session_changed' });
    expect(r.out.find((m) => m.t === 'transcript.closed')).toEqual({ t: 'transcript.closed', id: agent, reason: 'session_changed' });
    expect(r.cmd('sim.transcripts', {}).data).toMatchObject({ watches: 0 });
    // The worker's floor falls asleep: asleep.
    r.cmd('transcript.watch', { id: agent });
    r.cmd('floor.sleep', { session: 'herdr-3d' });
    r.settle();
    expect(r.out.filter((m) => m.t === 'transcript.closed').at(-1)).toEqual({ t: 'transcript.closed', id: agent, reason: 'asleep' });
  });

  it('simfail=no_m16 plays a bridge before M16', () => {
    const r = rig('no_m16');
    expect(r.cmd('transcript.watch', { id: agent }).code).toBe('unknown_command');
  });

  it('#171 simtx: demo-h171 watches get the code-changes timeline, and transcript.item answers its cut change whole', () => {
    const { snapshot } = loadFixture('demo-h171');
    const out: Msg[] = [];
    let n = 0;
    const sim = new SimWorld(snapshot as never, { stepMs: 100, transcript: 'demo-h171', now: () => 1_000_000, setTimeout: () => 0, clearTimeout: () => {} });
    const cmd = (t: string, args: unknown) => {
      const req_id = `r${++n}`;
      sim.handle({ t, req_id, args }, (m) => out.push(m));
      return out.find((m) => m.req_id === req_id) as Msg & { data?: Record<string, unknown>; code?: string };
    };
    const id = (snapshot as unknown as typeof world).world.workers.find((w) => w.name === 'Nibble')?.id as string;
    const items = watchAck(cmd('transcript.watch', { id, limit: 500 }).data).items;
    expect(items.map((it) => it.seq)).toEqual(items.map((_, i) => i + 1));
    expect(items.some((it) => it.tool?.changes?.skipped)).toBe(true);
    expect(items.find((it) => it.id === 'h171-proposed')?.tool?.status).toBe('running');
    expect(items.some((it) => it.tool?.name === 'apply_patch' && it.tool.status === 'ok')).toBe(true);
    const cut = items.find((it) => it.id === 'h171-cut');
    expect(cut?.tool?.diff?.truncated).toBe(true);
    const whole = (cmd('transcript.item', { id, item: 'h171-cut' }).data as { item: TranscriptItem }).item;
    expect(whole.tool?.diff?.truncated).toBeUndefined();
    expect(whole.tool?.diff?.hunks[0]).toMatchObject({ old_start: 3 });
    expect((whole.tool?.diff?.hunks[0] as { lines: string[] }).lines.length).toBe(2500);
    expect(whole.seq).toBe(cut?.seq);
    // Any other name: the demo.
    const other = new SimWorld(snapshot as never, { stepMs: 100, transcript: 'demo-m5', now: () => 1_000_000, setTimeout: () => 0, clearTimeout: () => {} });
    const o: Msg[] = [];
    other.handle({ t: 'transcript.watch', req_id: 'x', args: { id } }, (m) => o.push(m));
    expect(watchAck((o.find((m) => m.req_id === 'x') as { data: unknown }).data).items.some((it) => it.id === 'toolu_demo_edit')).toBe(true);
  });

  it('#21 simtx: demo-h21 watches get Codex code changes, half of them past the window; a page brings them, each once', () => {
    const { snapshot } = loadFixture('demo-h171');
    const out: Msg[] = [];
    let n = 0;
    const sim = new SimWorld(snapshot as never, { stepMs: 100, transcript: 'demo-h21', now: () => 1_000_000, setTimeout: () => 0, clearTimeout: () => {} });
    const cmd = (t: string, args: unknown) => {
      const req_id = `r${++n}`;
      sim.handle({ t, req_id, args }, (m) => out.push(m));
      return out.find((m) => m.req_id === req_id) as Msg & { data?: Record<string, unknown>; code?: string };
    };
    const id = (snapshot as unknown as typeof world).world.workers.find((w) => w.name === 'Nibble')?.id as string;
    const ack = cmd('transcript.watch', { id }).data as { has_more: boolean; cursor: string };
    const items = watchAck(ack).items;
    expect(ack.has_more).toBe(true);
    expect(items.some((it) => it.id === 'call_c21direct0000000000000007')).toBe(true);
    expect(items.some((it) => it.id === 'exec-0c210001-0000-4000-8000-000000000001')).toBe(false);
    const older = (cmd('transcript.page', { id, before: ack.cursor }).data as { items: TranscriptItem[] }).items;
    expect(older[0]?.id).toBe('h21-ask');
    expect(older.find((it) => it.id === 'exec-0c210001-0000-4000-8000-000000000001')?.tool?.diff?.hunks[0]).toMatchObject({ old_start: 3, new_start: 3 });
    const ids = [...older, ...items].map((it) => it.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...older, ...items].map((it) => it.seq)).toEqual(ids.map((_, i) => i + 1));
  });

  it('#132 simtx: demo-h132 watches get Codex polls of background terminals, named by their commands', () => {
    const { snapshot } = loadFixture('demo-h171');
    const out: Msg[] = [];
    const sim = new SimWorld(snapshot as never, { stepMs: 100, transcript: 'demo-h132', now: () => 1_000_000, setTimeout: () => 0, clearTimeout: () => {} });
    const id = (snapshot as unknown as typeof world).world.workers.find((w) => w.name === 'Nibble')?.id as string;
    sim.handle({ t: 'transcript.watch', req_id: 'w', args: { id } }, (m) => out.push(m));
    const items = watchAck((out.find((m) => m.req_id === 'w') as { data: unknown }).data).items;
    expect(items[0]?.id).toBe('h132-ask');
    expect(items.find((it) => it.id === 'call_p132exit1')?.tool).toMatchObject({ input_summary: 'Waited for pnpm exec vitest run · exited 1', status: 'error' });
    expect(items.map((it) => it.seq)).toEqual(items.map((_, i) => i + 1));
  });
});

describe('TranscriptSim: #26 child targets', () => {
  /** The children-nested fixture simulated: Nibble over Ada (running), Bell (idle) and Curie (completed, no transcript). */
  function kids() {
    const rec = loadFixture('children-nested');
    const out: Msg[] = [];
    const sim = new SimWorld(rec.snapshot as never, { stepMs: 100, now: () => 1_000_000, childEvents: rec.events as Msg[] });
    let n = 0;
    const cmd = (t: string, args: unknown) => {
      const req_id = `r${++n}`;
      sim.handle({ t, req_id, args }, (m) => out.push(m));
      return out.find((m) => m.req_id === req_id) as Msg & { data?: Record<string, unknown>; code?: string };
    };
    const snap = sim.snapshot() as { world: { workers: Array<{ id: string; child_generation?: number }>; children?: Array<{ id: string; name?: string; generation: number; provider: string }> } };
    const worker = snap.world.workers[0] as { id: string };
    const child = (name: string) => {
      const c = snap.world.children?.find((x) => x.name === name) as { id: string; generation: number; provider: string };
      return { id: c.id, generation: c.generation, provider: c.provider };
    };
    return { sim, out, cmd, worker: worker.id, child, snap };
  }

  it('the world has the fixture’s children; a child’s watch is its own timeline beside the worker’s, its reads by its target', () => {
    const r = kids();
    expect(r.snap.world.children?.map((c) => c.name)).toEqual(['Ada', 'Bell', 'Curie']);
    const ada = r.child('Ada');
    expect(r.cmd('transcript.watch', { id: r.worker }).data?.pending).toBe(false);
    const ack = watchAck(r.cmd('transcript.watch', { id: r.worker, child: ada }).data);
    expect(ack).toMatchObject({ harness: 'codex', session: 'th-a', availability: 'available', pending: false, has_more: true });
    expect(ack.items).toHaveLength(200);
    const older = r.cmd('transcript.page', { id: r.worker, child: ada, before: ack.cursor });
    expect((older.data?.items as TranscriptItem[])[0]?.kind).toBe('user');
    expect(r.cmd('transcript.item', { id: r.worker, child: ada, item: ack.items[0]?.id }).data).toBeDefined();
    // Live: a push to the child's watch carries its target.
    r.cmd('sim.transcript', { id: r.worker, child: ada, items: [{ id: 'ada-new', seq: 999, ts: 0, kind: 'assistant', parts: [{ text: 'Done.' }] }] });
    expect(r.out.at(-2)).toMatchObject({ t: 'transcript.items', id: r.worker, child: ada });
    // Pending and unavailable say so; the worker's own watch is still one of four.
    expect(r.cmd('transcript.watch', { id: r.worker, child: r.child('Curie') }).data).toMatchObject({ pending: true, availability: 'unavailable', items: [] });
    expect(r.cmd('sim.transcripts', {}).data?.watches).toBe(3);
  });

  it('refuses a stale generation, another worker’s or provider’s row; a third child evicts the oldest; a replaced session closes it', () => {
    const r = kids();
    const ada = r.child('Ada');
    expect(r.cmd('transcript.watch', { id: r.worker, child: { ...ada, generation: ada.generation + 1 } }).code).toBe('stale');
    expect(r.cmd('transcript.watch', { id: r.worker, child: { ...ada, provider: 'claude' } }).code).toBe('not_found');
    expect(r.cmd('transcript.watch', { id: r.worker, child: { ...ada, id: 'ch_nope' } }).code).toBe('not_found');
    expect(r.cmd('transcript.watch', { id: r.worker, child: { id: ada.id } }).code).toBe('bad_request');
    for (const name of ['Ada', 'Bell', 'Curie']) r.cmd('transcript.watch', { id: r.worker, child: r.child(name) });
    expect(r.out.find((m) => m.t === 'transcript.closed')).toMatchObject({ id: r.worker, child: ada, reason: 'evicted' });
    r.cmd('sim.child_session', { id: r.worker });
    const closed = r.out.filter((m) => m.t === 'transcript.closed' && m.reason === 'session_changed');
    expect(closed.map((m) => (m.child as { id: string }).id)).toEqual([r.child('Bell').id, r.child('Curie').id]);
  });
});
