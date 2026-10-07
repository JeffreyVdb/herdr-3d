import { describe, expect, it } from 'vitest';
import type { CodexBatch, Snapshot, Worker, WorkerCodex } from '../net/protocol';
import { cardOf } from '../render/cards/cardOf';
import { lifecycle } from './crew';
import { inboxQueue } from './inbox';
import { promptBlocker, willQueue } from './prompt';
import { WorldStore } from './store';

// #157: how a shared Codex worker that herdr calls blocked only because of an async question counts across the world:
// it works (the card, the counts, N's queue, the inbox, the crew), takes prompts, and shows that it asks; a real block
// (an approval open: the bridge's async_blocked is false) still needs you.

const questions: CodexBatch[] = [
  {
    batch: 'call_3',
    turn: 't1',
    seen: ['live'],
    at: 1000,
    questions: [
      { index: 0, title: 'Which fixture color?', options: ['Green', 'Blue'], state: 'pending' },
      { index: 1, title: 'Any context for the fixture?', state: 'sent' },
    ],
  },
];
const codex = (over: Partial<WorkerCodex> = {}): WorkerCodex => ({ mode: 'shared', server: 'running', attached: true, thread: 'th1', turn: 't1', questions, ...over });
const worker = (over: Partial<Worker> = {}): Worker => ({ id: 'a', session: 'top', workspace_id: 'w1', label: 'x', status: 'blocked', agent_kind: 'codex', harness: 'codex', name: 'Pixel', desk_index: 0, ...over });
const snap = (...workers: Worker[]): Snapshot => ({
  t: 'world.snapshot',
  seq: 10,
  world: { buildings: [{ id: 'b1', name: 'Work', sort: 0, floors: ['top'] }], unassigned: [], floors: [{ session: 'top', state: 'running', building: 'b1', index: 0 }], workers },
});
const floor = { asleep: false, transition: null } as const;

function store(...ws: Worker[]): WorldStore {
  const s = new WorldStore(0);
  s.applySnapshot(snap(...ws));
  return s;
}

describe('a Codex worker blocked only by an async question (#157)', () => {
  const s = store(worker({ codex: codex({ async_blocked: true }) }), worker({ id: 'b', workspace_id: 'w2', desk_index: 1, name: 'Pip', codex: codex({ async_blocked: false }) }));
  const asking = s.workerView('a');
  const real = s.workerView('b');

  it('works, with the count of its questions that want an answer; a real block still needs you', () => {
    expect(asking).toMatchObject({ display: 'working', asks: 1 });
    expect(real).toMatchObject({ display: 'needs_you' });
    expect(s.floorView('top')?.counts).toMatchObject({ working: 1, needsYou: 1 });
  });

  it('is not in the inbox or N’s queue (it does not need you); the real block is', () => {
    const cands = [asking, real].map((v) => ({ id: v?.worker.id ?? '', session: 'top', building: 'b1', display: v?.display ?? 'idle', since: 0, desk: 0, name: v?.name ?? '', role: null }));
    expect(inboxQueue(cands).map((x) => x.id)).toEqual(['b']);
  });

  it('takes a prompt, queued (the bridge steers it into the running turn)', () => {
    expect(promptBlocker(asking, floor as never, false)).toBeNull();
    expect(willQueue(asking)).toBe(true);
    expect(promptBlocker(real, floor as never, false)).toMatch(/waiting on its screen/);
  });

  it('is working in a crew, blocked when blocked for real', () => {
    expect(lifecycle(worker({ label: 'CODE|x|1|r1', codex: codex({ async_blocked: true }) }), true)).toBe('working');
    expect(lifecycle(worker({ label: 'CODE|x|1|r1', codex: codex({ async_blocked: false }) }), true)).toBe('blocked');
  });

  it('says on its desk card what it asks, its status chip still WORKING', () => {
    const c = cardOf(asking as NonNullable<typeof asking>);
    expect(c.display).toBe('working');
    expect(c.ask).toEqual({ text: 'Which fixture color?', choices: [], about: ['Codex asks 1 question · answer at the laptop (E)'] });
  });

  it('shows no cue for a legacy worker or one asleep, and none once nothing wants an answer', () => {
    const legacy = store(worker({ status: 'working', codex: { mode: 'legacy', questions } })).workerView('a');
    expect(legacy?.asks).toBe(0);
    expect(cardOf(legacy as NonNullable<typeof legacy>).ask).toBeUndefined();
    const sent = store(worker({ status: 'working', codex: codex({ questions: [{ ...(questions[0] as CodexBatch), questions: [{ index: 0, title: 'x', state: 'sent' }] }] }) })).workerView('a');
    expect(sent?.asks).toBe(0);
  });
});
