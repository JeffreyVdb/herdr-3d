import { describe, expect, it } from 'vitest';
import { isWorldEvent, parseMessage, type ServerMessage, type Snapshot, type Usage, type Worker } from '../net/protocol';
import { WorldStore } from './store';

const usage = (tokens: number): Usage => ({ tokens, cost_usd_est: tokens / 100_000, priced: 'known', model: 'claude-opus-5-5', context_pct: 4.2 });
const worker = (over: Partial<Worker> = {}): Worker => ({ id: 'a', session: 'top', workspace_id: 'w1', label: 'x', status: 'working', name: 'Nibble', desk_index: 0, ...over });
const snap = (w: Worker): Snapshot => ({
  t: 'world.snapshot',
  seq: 10,
  world: { buildings: [{ id: 'b1', name: 'Work', sort: 0, floors: ['top'] }], unassigned: [], floors: [{ session: 'top', state: 'running', building: 'b1', index: 0 }], workers: [w] },
});

describe('WorldStore usage and questions (M5)', () => {
  it('keeps usage and a question from snapshots and upserts', () => {
    const s = new WorldStore(0);
    s.applySnapshot(snap(worker({ usage: usage(37_210) })));
    expect(s.workers.get('a')?.usage?.tokens).toBe(37_210);
    const q = { kind: 'permission', text: 'Proceed?', excerpt: [], choices: [{ n: 1, label: 'Yes' }], hash: '9f2c01ab77d3e410' };
    const c = s.applyEvent({ t: 'worker.upsert', seq: 11, worker: worker({ status: 'blocked', question: q, usage: usage(40_000) }) });
    expect(c.workers.has('a')).toBe(true);
    expect(s.workerView('a')).toMatchObject({ display: 'needs_you', worker: { question: q, usage: { tokens: 40_000 } } });
    // Leaving blocked, the bridge sends the worker without its question.
    s.applyEvent({ t: 'worker.upsert', seq: 12, worker: worker({ usage: usage(40_000) }) });
    expect(s.workers.get('a')?.question).toBeUndefined();
  });

  it('applies worker.usage to the worker, keeping everything else, as a shown-state change', () => {
    const s = new WorldStore(0);
    s.applySnapshot(snap(worker({ title: 'Wire the HUD', usage: usage(1000) })));
    const c = s.applyEvent({ t: 'worker.usage', seq: 11, id: 'a', session: 'top', usage: usage(2000) });
    expect(c).toMatchObject({ structure: false });
    expect([...c.workers]).toEqual(['a']);
    expect([...c.sessions]).toEqual(['top']);
    expect(s.workers.get('a')).toMatchObject({ title: 'Wire the HUD', status: 'working', usage: { tokens: 2000 } });
    expect(s.seq).toBe(11);
    // An unknown worker is ignored.
    expect(s.applyEvent({ t: 'worker.usage', seq: 12, id: 'zz', usage: usage(1) }).workers.size).toBe(0);
  });
});

describe('WorldStore asks (#57)', () => {
  const ask = { tool_use_id: 'toolu_1', source: 'transcript', agent: 'claude', since: 5000, questions: [{ header: 'Drink', question: 'Tea or coffee?', multi: false, other: true, options: [{ label: 'Tea' }, { label: 'Coffee' }] }] };
  it('needs you while its agent asks, whatever herdr calls it, waiting since it asked; not on an asleep floor', () => {
    const s = new WorldStore(0);
    s.applySnapshot(snap(worker({ status: 'idle', status_since: 9000, ask })));
    expect(s.workerView('a')).toMatchObject({ display: 'needs_you', since: 5000 });
    expect(s.floorView('top')?.counts).toMatchObject({ needsYou: 1, idle: 0 });
    // A status change keeps it; the upsert without it ends it.
    s.applyEvent({ t: 'worker.status', seq: 11, id: 'a', status: 'done', prev_status: 'idle', status_since: 9500 } as never);
    expect(s.workerView('a')?.display).toBe('needs_you');
    s.applyEvent({ t: 'worker.upsert', seq: 12, worker: worker({ status: 'working', status_since: 9800 }) });
    expect(s.workerView('a')).toMatchObject({ display: 'working', since: 9800 });
    const asleep: Snapshot = { ...snap(worker({ status: 'idle', ask })) };
    asleep.world.floors = [{ session: 'top', state: 'asleep', building: 'b1', index: 0 }];
    s.applySnapshot(asleep);
    expect(s.workerView('a')?.display).toBe('asleep');
  });
});

describe('WorldStore follow-up questions (#90)', () => {
  const followup = { turn_id: 't1', score: 0.96, source: 'model' as const, at: 7000, questions: [{ id: 'q1', question: 'Ship it?', kind: 'yes_no' as const }] };
  it('needs you while its final message has open questions, since they were found; the desk card says how many', async () => {
    const { cardOf } = await import('../render/cards/cardOf');
    const s = new WorldStore(0);
    s.applySnapshot(snap(worker({ status: 'idle', status_since: 9000, followup })));
    const v = s.workerView('a')!;
    expect(v).toMatchObject({ display: 'needs_you', since: 7000 });
    expect(s.floorView('top')?.counts).toMatchObject({ needsYou: 1, idle: 0 });
    expect(cardOf(v).ask).toEqual({ text: 'Ship it?', choices: [], about: ['1 question: answer at the laptop (E)'] });
    s.applyEvent({ t: 'worker.upsert', seq: 11, worker: worker({ status: 'working', status_since: 9800 }) });
    expect(s.workerView('a')?.display).toBe('working');
  });

  it('keeps the feature’s state from the snapshot and followups.update', () => {
    const s = new WorldStore(0);
    const sn = snap(worker());
    sn.world.followups = { enabled: false, threshold: 0.7, state: 'off', roles: { classifier: 'off', llm: 'off' }, env: [], tested: false };
    s.applySnapshot(sn);
    expect(s.followups.state?.state).toBe('off');
    const m = parseMessage(JSON.stringify({ t: 'followups.update', seq: 11, enabled: true, threshold: 0.8, state: 'ready', roles: { classifier: 'ready', llm: 'ready' }, env: [], tested: true })) as ServerMessage;
    expect(isWorldEvent(m)).toBe(true);
    s.applyEvent(m as never);
    expect(s.followups.state).toMatchObject({ enabled: true, threshold: 0.8, state: 'ready' });
  });
});

describe('worker.usage on the wire', () => {
  it('is a world event (with a seq) the client applies', () => {
    const m = parseMessage(JSON.stringify({ t: 'worker.usage', seq: 1200, id: 'a', session: 'herdr-3d', usage: usage(37_210) })) as ServerMessage;
    expect(isWorldEvent(m)).toBe(true);
    expect(isWorldEvent({ t: 'worker.usage', seq: 1, id: 'a' } as ServerMessage)).toBe(false);
  });
});
