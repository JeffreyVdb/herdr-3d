import { describe, expect, it } from 'vitest';
import { decodeChild, isWorldEvent, parseMessage, type Child, type Snapshot, type Worker, type WorldEvent } from '../net/protocol';
import { ChildBook, childTree } from './children';
import { WorldStore } from './store';

const worker = (id: string, gen?: number): Worker => ({
  id,
  session: 'office',
  workspace_id: `ws-${id}`,
  label: id,
  status: 'working',
  ...(gen === undefined ? {} : { child_generation: gen }),
});

const child = (id: string, over: Partial<Child> = {}): Child => ({
  id,
  provider: 'claude',
  worker_id: 'w1',
  agent_session: 's1',
  generation: 1,
  parent: 'root',
  state: 'running',
  source: 'hook',
  transcript: 'unavailable',
  ...over,
});

const snap = (workers: Worker[], children?: Child[], seq = 10): Snapshot => ({
  t: 'world.snapshot',
  seq,
  world: { buildings: [], unassigned: ['office'], floors: [{ session: 'office', state: 'running', building: null, index: null }], workers, children },
});

/** One frame as the client gets it: through the decoder. */
const ev = (o: Record<string, unknown>): WorldEvent => {
  const m = parseMessage(JSON.stringify(o));
  if (!m || !isWorldEvent(m)) throw new Error(`not an event: ${JSON.stringify(o)}`);
  return m;
};

describe('#22 ChildBook in the world store', () => {
  it('drops an old-generation upsert that arrives after its worker’s session was replaced', () => {
    const s = new WorldStore(0);
    s.applySnapshot(snap([worker('w1', 1)], [child('ch_a')]), 0);
    expect(s.children.of('w1').map((c) => c.id)).toEqual(['ch_a']);
    // The new session: its worker.upsert raises the generation, the old children go.
    s.applyEvent(ev({ t: 'worker.upsert', seq: 11, worker: { ...worker('w1', 3), agent_session: 's2' } }), 0);
    expect(s.children.of('w1')).toEqual([]);
    expect(s.children.generation('w1')).toBe(3);
    // Late, of the old session: dropped; and so is a removal of it.
    s.applyEvent(ev({ t: 'child.upsert', seq: 12, child: child('ch_a', { state: 'completed' }) }), 0);
    s.applyEvent(ev({ t: 'child.upsert', seq: 13, child: child('ch_old2') }), 0);
    expect(s.children.of('w1')).toEqual([]);
    // The new session's child attaches.
    s.applyEvent(ev({ t: 'child.upsert', seq: 14, child: child('ch_new', { generation: 3, agent_session: 's2' }) }), 0);
    expect(s.children.of('w1').map((c) => [c.id, c.generation])).toEqual([['ch_new', 3]]);
    expect(s.children.removed({ id: 'ch_new', worker_id: 'w1', generation: 1 })).toBe(false);
    expect(s.children.of('w1')).toHaveLength(1);
  });

  it('a child of a newer generation than its worker’s drops the older children first', () => {
    const b = new ChildBook();
    b.reset([child('ch_a'), child('ch_b')], [worker('w1', 1)]);
    expect(b.upsert(child('ch_c', { generation: 2 }))).toBe(true);
    expect(b.of('w1').map((c) => c.id)).toEqual(['ch_c']);
    expect(b.upsert(child('ch_a'))).toBe(false);
  });

  it('removes a child by its row, worker and generation; its worker’s removal takes them all', () => {
    const s = new WorldStore(0);
    s.applySnapshot(snap([worker('w1', 1), worker('w2', 2)], [child('ch_a'), child('ch_b'), child('ch_c', { worker_id: 'w2', generation: 2 })]), 0);
    s.applyEvent(ev({ t: 'child.removed', seq: 11, id: 'ch_a', worker_id: 'w1', generation: 1 }), 0);
    expect(s.children.of('w1').map((c) => c.id)).toEqual(['ch_b']);
    s.applyEvent(ev({ t: 'worker.removed', seq: 12, id: 'w1', session: 'office', workspace_id: 'ws-w1' }), 0);
    expect(s.children.of('w1')).toEqual([]);
    // Something late of it stays out; the other worker's children are untouched.
    s.applyEvent(ev({ t: 'child.upsert', seq: 13, child: child('ch_b', { state: 'idle' }) }), 0);
    expect(s.children.of('w1')).toEqual([]);
    expect(s.children.of('w2').map((c) => c.id)).toEqual(['ch_c']);
    // Back with a newer generation (the bridge's counter only rises): its children attach again.
    s.applyEvent(ev({ t: 'worker.upsert', seq: 14, worker: worker('w1', 5) }), 0);
    s.applyEvent(ev({ t: 'child.upsert', seq: 15, child: child('ch_d', { generation: 5 }) }), 0);
    expect(s.children.of('w1').map((c) => c.id)).toEqual(['ch_d']);
  });

  it('a snapshot replaces everything; one from a bridge before #22 has none', () => {
    const s = new WorldStore(0);
    s.applySnapshot(snap([worker('w1', 1)], [child('ch_a')]), 0);
    s.applySnapshot(snap([worker('w1')]), 0);
    expect(s.children.known).toBe(false);
    expect(s.children.of('w1')).toEqual([]);
    // An older bridge's worker.upsert has no child_generation: nothing moves.
    s.applySnapshot(snap([worker('w1', 4)], [child('ch_a', { generation: 4 })]), 0);
    s.applyEvent(ev({ t: 'worker.upsert', seq: 11, worker: worker('w1') }), 0);
    expect(s.children.of('w1')).toHaveLength(1);
  });
});

describe('#22 decodeChild', () => {
  it('never guesses a parent, a state or a transcript', () => {
    expect(decodeChild({ id: 'ch_a', worker_id: 'w1', generation: 1 })).toEqual({
      id: 'ch_a',
      provider: '',
      worker_id: 'w1',
      agent_session: '',
      generation: 1,
      parent: 'unresolved',
      state: 'unknown',
      source: '',
      transcript: 'unavailable',
    });
    const odd = decodeChild({ ...child('ch_a'), parent: 'child', state: 'done', transcript: 'maybe', name: '', started_at: 1.5 });
    expect(odd).toMatchObject({ parent: 'unresolved', state: 'unknown', transcript: 'unavailable' });
    expect(odd).not.toHaveProperty('parent_id');
    expect(odd).not.toHaveProperty('name');
    expect(odd).not.toHaveProperty('started_at');
    expect(decodeChild({ ...child('ch_a'), parent: '' })?.parent).toBe('unresolved');
    expect(decodeChild({ ...child('ch_a'), parent: 'child', parent_id: 'ch_p' })).toMatchObject({ parent: 'child', parent_id: 'ch_p' });
    for (const s of ['running', 'completed', 'idle', 'shut_down', 'interrupted', 'unknown']) expect(decodeChild({ ...child('ch_a'), state: s })?.state).toBe(s);
    expect(decodeChild({ id: 'ch_a', worker_id: 'w1' })).toBeNull();
    expect(decodeChild({ worker_id: 'w1', generation: 1 })).toBeNull();
  });

  it('isWorldEvent takes the child events with their keys only', () => {
    const ok = (o: Record<string, unknown>) => {
      const m = parseMessage(JSON.stringify(o));
      return !!m && isWorldEvent(m);
    };
    expect(ok({ t: 'child.upsert', seq: 1, child: child('ch_a') })).toBe(true);
    expect(ok({ t: 'child.upsert', seq: 1, child: { id: 'ch_a', worker_id: 'w1' } })).toBe(false);
    expect(ok({ t: 'child.removed', seq: 1, id: 'ch_a', worker_id: 'w1', generation: 2 })).toBe(true);
    expect(ok({ t: 'child.removed', seq: 1, id: 'ch_a', worker_id: 'w1' })).toBe(false);
  });
});

describe('#22 childTree', () => {
  it('nests by parent, keeps the unresolved and the orphaned at the top, siblings by start', () => {
    const t = childTree([
      child('ch_b', { parent: 'child', parent_id: 'ch_a', started_at: 20 }),
      child('ch_u', { parent: 'unresolved', started_at: 5 }),
      child('ch_a', { started_at: 10 }),
      child('ch_o', { parent: 'child', parent_id: 'ch_gone', started_at: 30 }),
      child('ch_c', { parent: 'child', parent_id: 'ch_b', started_at: 15 }),
    ]);
    const shape = (n: ReturnType<typeof childTree>): unknown => n.map((x) => [x.child.id, shape(x.children)]);
    expect(shape(t)).toEqual([
      ['ch_u', []],
      ['ch_a', [['ch_b', [['ch_c', []]]]]],
      ['ch_o', []],
    ]);
  });
});
