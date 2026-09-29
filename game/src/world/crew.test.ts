import { describe, expect, it } from 'vitest';
import type { Snapshot, Worker, WorkerReport } from '../net/protocol';
import { CrewMemory, crewRole, crewView, inputRequired, lifecycle, overCap, passWords, phaseWords, runColor, RUN_COLORS, stampOf } from './crew';
import { needQueue } from './next';
import { WorldStore } from './store';

/** A worker; a key set to undefined is left out. */
const worker = (over: { [K in keyof Worker]?: Worker[K] | undefined } = {}): Worker => {
  const w: Record<string, unknown> = { ...base, ...over };
  for (const k of Object.keys(w)) if (w[k] === undefined) delete w[k];
  return w as unknown as Worker;
};
const base: Worker = {
  id: 'c1',
  session: 'lab',
  workspace_id: 'w2',
  label: 'CODE|lobby|3|r2',
  status: 'idle',
  agent_kind: 'claude',
  name: 'Pip',
  desk_index: 1,
};
const ready = (over: Partial<WorkerReport> = {}): WorkerReport => ({ state: 'ready', at: 1_790_650_000_000, ...over });

describe('crewRole', () => {
  it('takes the bridge role, else the label prefix, else none', () => {
    expect(crewRole({ role: 'review', label: 'whatever' })).toBe('review');
    expect(crewRole({ role: 'ORCH', label: '' })).toBe('orch');
    expect(crewRole({ label: 'GROUND|write-code' })).toBe('ground');
    expect(crewRole({ label: 'UX|m2-hud' })).toBe('ux');
    expect(crewRole({ label: 'bridge-ws' })).toBeNull();
    // A role the game does not know is not a crew member, whatever the label says.
    expect(crewRole({ role: 'janitor', label: 'CODE|x|r1' })).toBeNull();
    expect(crewRole({ label: 'CODEX|x' })).toBeNull();
  });
});

describe('lifecycle (contract 1.4)', () => {
  it('hired: no agent yet, or herdr does not know its status', () => {
    expect(lifecycle(worker({ agent_kind: undefined, status: 'unknown' }), false)).toBe('hired');
    expect(lifecycle(worker({ agent_kind: undefined, status: 'idle' }), false)).toBe('hired');
    expect(lifecycle(worker({ status: 'unknown' }), false)).toBe('hired');
  });

  it('onboarding: an agent that has not worked since it appeared', () => {
    expect(lifecycle(worker({ status: 'idle' }), false)).toBe('onboarding');
    // It worked once: now it waits (no report yet).
    expect(lifecycle(worker({ status: 'idle' }), true)).toBe('idle');
    // `done` means it finished a turn: not onboarding even when the game never saw it working.
    expect(lifecycle(worker({ status: 'done' }), false)).toBe('idle');
  });

  it('working', () => {
    expect(lifecycle(worker({ status: 'working' }), false)).toBe('working');
    expect(lifecycle(worker({ status: 'working', report: { state: 'pending' } }), true)).toBe('working');
  });

  it('blocked: its agent is, or its report asks (input_required)', () => {
    expect(lifecycle(worker({ status: 'blocked' }), true)).toBe('blocked');
    expect(lifecycle(worker({ status: 'idle', report: ready({ input_required: 'Which port should the demo use?' }) }), true)).toBe('blocked');
    // Blocked wins over a ready report and over working.
    expect(lifecycle(worker({ status: 'blocked', report: ready({ verdict: 'PASS' }) }), true)).toBe('blocked');
    expect(lifecycle(worker({ status: 'working', report: ready({ input_required: 'Port?' }) }), true)).toBe('blocked');
    // A blank or null input_required does not block.
    expect(lifecycle(worker({ report: ready({ input_required: '   ' }) }), true)).toBe('reporting');
    expect(lifecycle(worker({ report: ready({ input_required: null }) }), true)).toBe('reporting');
  });

  it('reporting: a ready report, whatever the agent does meanwhile', () => {
    expect(lifecycle(worker({ status: 'done', report: ready({ verdict: 'CHANGES_REQUIRED', blockers: 2, issues: 5 }) }), true)).toBe('reporting');
    expect(lifecycle(worker({ status: 'working', report: ready({ summary: 'head 821f4b3' }) }), true)).toBe('reporting');
    // Pending and invalid reports are not a hand-in.
    expect(lifecycle(worker({ status: 'idle', report: { state: 'pending' } }), true)).toBe('idle');
    expect(lifecycle(worker({ status: 'idle', report: { state: 'invalid', error: 'not a JSON object' } }), false)).toBe('onboarding');
  });

  it('input_required only counts on a ready report', () => {
    expect(inputRequired({ state: 'pending', input_required: 'x' })).toBeNull();
    expect(inputRequired(ready({ input_required: '  Port?  ' }))).toBe('Port?');
  });
});

describe('overCap', () => {
  it('trusts the bridge, and applies the same rule when it does not say', () => {
    expect(overCap({ over_cap: true })).toBe(true);
    expect(overCap({ pass: 3, phase: 'waiting_user' })).toBe(true);
    expect(overCap({ pass: 4, phase: 'fixing' })).toBe(true);
    expect(overCap({ pass: 3, phase: 'review' })).toBe(false);
    expect(overCap({ pass: 2, phase: 'waiting_user' })).toBe(false);
    expect(overCap({})).toBe(false);
  });
});

describe('stamps and words', () => {
  it('stamps each verdict, with the blocker count on CHANGES_REQUIRED', () => {
    expect(stampOf(ready({ verdict: 'PASS', blockers: 0, issues: 1 }))).toEqual({ tone: 'pass', text: 'PASS', blockers: 0 });
    expect(stampOf(ready({ verdict: 'CHANGES_REQUIRED', blockers: 2, issues: 5 }))).toEqual({ tone: 'changes', text: 'CHANGES · 2 BLOCKERS', blockers: 2 });
    expect(stampOf(ready({ verdict: 'CHANGES_REQUIRED', blockers: 1 }))?.text).toBe('CHANGES · 1 BLOCKER');
    expect(stampOf(ready({ verdict: 'CHANGES_REQUIRED', blockers: 0 }))?.text).toBe('CHANGES');
    expect(stampOf(ready({ verdict: 'INCOMPLETE' }))).toEqual({ tone: 'incomplete', text: 'INCOMPLETE', blockers: 0 });
    expect(stampOf(ready({ summary: 'coder report' }))).toBeNull();
    expect(stampOf({ state: 'pending', verdict: 'PASS' })).toBeNull();
  });

  it('phase and pass in words', () => {
    expect(phaseWords('waiting_user')).toBe('waiting for you');
    expect(phaseWords('review')).toBe('in review');
    expect(phaseWords('deploying')).toBe('deploying');
    expect(phaseWords('')).toBeNull();
    expect(passWords(2)).toBe('pass 2 of 3');
    expect(passWords(4)).toBe('pass 4 · cap 3');
    expect(passWords(undefined)).toBeNull();
  });

  it('gives a run one stable colour from its palette', () => {
    const c = runColor('20260928-1400-overcap');
    expect(RUN_COLORS).toContain(c);
    expect(runColor('20260928-1400-overcap')).toBe(c);
    expect(runColor('')).toBeNull();
  });
});

describe('crewView', () => {
  it('describes a freelancer: tag, issue, lifecycle, stamp, its orchestrator', () => {
    const v = crewView(
      worker({ label: 'REVIEW|overcap|3|r3', role: 'review', run: 'overcap', round: 3, ticket: '3', issue: { repo: 'JeffreyVdb/lab', number: 3 }, orch_id: 'o1', report: ready({ verdict: 'CHANGES_REQUIRED', blockers: 2, issues: 5 }) }),
      true,
    );
    expect(v).toMatchObject({ role: 'review', freelancer: true, life: 'reporting', tag: 'REVIEW r3', issue: 'JeffreyVdb/lab#3', orchId: 'o1', stamp: { tone: 'changes', blockers: 2 }, needsYou: false, phase: null });
    expect(v?.runColor).toBe(runColor('overcap'));
  });

  it('reads the round off the label from an older bridge', () => {
    expect(crewView(worker({ label: 'CODE|m2-go|3|r1' }), false)).toMatchObject({ round: 1, tag: 'CODE r1', life: 'onboarding' });
    expect(crewView(worker({ label: 'GROUND|write-code' }), false)).toMatchObject({ round: null, tag: 'GROUND' });
  });

  it('describes an orchestrator: phase, pass, over the cap (needs you)', () => {
    const o = crewView(worker({ id: 'o1', label: 'ORCH|overcap', role: 'orch', run: 'overcap', phase: 'waiting_user', pass: 3, over_cap: true }), true);
    expect(o).toMatchObject({ role: 'orch', freelancer: false, life: null, phase: 'waiting for you', pass: 3, overCap: true, needsYou: true, tag: 'ORCH', stamp: null });
    expect(crewView(worker({ label: 'ORCH|x', role: 'orch', phase: 'review', pass: 1 }), true)).toMatchObject({ overCap: false, needsYou: false });
    // An orchestrator's report fields (it has none) never stamp or ask.
    expect(crewView(worker({ label: 'ORCH|x', report: ready({ verdict: 'PASS', input_required: 'x' }) }), true)).toMatchObject({ stamp: null, ask: null, needsYou: false });
  });

  it('a freelancer whose report asks needs you', () => {
    expect(crewView(worker({ report: ready({ input_required: 'Which port?' }) }), true)).toMatchObject({ life: 'blocked', ask: 'Which port?', needsYou: true });
  });

  it('is null for everyone else', () => {
    expect(crewView(worker({ label: 'docs' }), true)).toBeNull();
  });
});

describe('CrewMemory', () => {
  it('remembers who worked since first seen, across snapshots, and forgets the gone', () => {
    const m = new CrewMemory();
    m.snapshot([worker({ id: 'a', status: 'idle' }), worker({ id: 'b', status: 'done' })]);
    expect(m.has('a')).toBe(false);
    expect(m.has('b')).toBe(true);
    m.observe(worker({ id: 'a', status: 'working' }));
    expect(m.has('a')).toBe(true);
    // Idle again: still worked. A new snapshot keeps it; one without it drops it.
    m.snapshot([worker({ id: 'a', status: 'idle' })]);
    expect(m.has('a')).toBe(true);
    expect(m.has('b')).toBe(false);
    m.forget('a');
    expect(m.has('a')).toBe(false);
  });
});

// ---- the store: lifecycle and over-cap as the game shows them ------------------

const snap = (workers: Worker[]): Snapshot => ({
  t: 'world.snapshot',
  seq: 10,
  world: {
    buildings: [{ id: 'b1', name: 'Work', sort: 0, floors: ['lab'] }],
    unassigned: [],
    floors: [{ session: 'lab', state: 'running', building: 'b1', index: 0, desks: 8 }],
    workers,
  },
});

describe('WorldStore crews (M6)', () => {
  const orch = worker({ id: 'o1', label: 'ORCH|overcap', role: 'orch', run: 'overcap', status: 'done', desk_index: 0, phase: 'waiting_user', pass: 3, over_cap: true });

  it('an over-cap orchestrator needs you: its display, the floor count and N', () => {
    const s = new WorldStore(0);
    s.applySnapshot(snap([orch]));
    const v = s.workerView('o1');
    expect(v?.display).toBe('needs_you');
    expect(v?.crew).toMatchObject({ overCap: true, needsYou: true });
    expect(s.floorView('lab')?.counts.needsYou).toBe(1);
    const q = needQueue([{ id: 'o1', session: 'lab', building: 'b1', display: v?.display ?? 'idle', since: 0, desk: 0, name: 'Pip' }]);
    expect(q[0]?.reason).toBe('blocked');
    // Back under the cap (the user said go on): what its status says again.
    s.applyEvent({ t: 'worker.upsert', seq: 11, worker: worker({ ...orch, pass: 4, phase: 'fixing', over_cap: undefined, status: 'working' }) });
    // pass 4 is still over the cap (> 3) ...
    expect(s.workerView('o1')?.display).toBe('needs_you');
    s.applyEvent({ t: 'worker.upsert', seq: 12, worker: worker({ ...orch, pass: 2, phase: 'fixing', over_cap: undefined, status: 'working' }) });
    expect(s.workerView('o1')?.display).toBe('working');
  });

  it('an asleep floor shows asleep, over the cap or not', () => {
    const s = new WorldStore(0);
    const sn = snap([orch]);
    (sn.world.floors[0] as { state: string }).state = 'asleep';
    s.applySnapshot(sn);
    expect(s.workerView('o1')?.display).toBe('asleep');
  });

  it('a freelancer goes hired → onboarding → working → reporting, and blocked on input_required', () => {
    const s = new WorldStore(0);
    s.applySnapshot(snap([orch]));
    const f = worker({ id: 'f1', role: 'code', run: 'overcap', orch_id: 'o1', status: 'unknown', agent_kind: undefined, desk_index: 1 });
    s.applyEvent({ t: 'worker.upsert', seq: 11, worker: f });
    expect(s.workerView('f1')?.crew?.life).toBe('hired');
    s.applyEvent({ t: 'worker.upsert', seq: 12, worker: { ...f, agent_kind: 'claude', status: 'idle' } });
    expect(s.workerView('f1')?.crew?.life).toBe('onboarding');
    s.applyEvent({ t: 'worker.status', seq: 13, id: 'f1', session: 'lab', workspace_id: 'w2', status: 'working' });
    expect(s.workerView('f1')?.crew?.life).toBe('working');
    s.applyEvent({ t: 'worker.status', seq: 14, id: 'f1', session: 'lab', workspace_id: 'w2', status: 'idle' });
    // It worked: idle now, not onboarding again.
    expect(s.workerView('f1')?.crew?.life).toBe('idle');
    s.applyEvent({ t: 'worker.upsert', seq: 15, worker: { ...f, agent_kind: 'claude', status: 'idle', report: ready({ input_required: 'Which port should the demo use?' }) } });
    expect(s.workerView('f1')).toMatchObject({ display: 'needs_you', crew: { life: 'blocked', ask: 'Which port should the demo use?' } });
    s.applyEvent({ t: 'worker.upsert', seq: 16, worker: { ...f, agent_kind: 'claude', status: 'done', report: ready({ summary: 'head 821f4b3, tests green' }) } });
    expect(s.workerView('f1')).toMatchObject({ display: 'done', crew: { life: 'reporting', summary: 'head 821f4b3, tests green' } });
  });

  it('plain workers have no crew view and keep their display', () => {
    const s = new WorldStore(0);
    s.applySnapshot(snap([worker({ id: 'p', label: 'docs', status: 'working' })]));
    expect(s.workerView('p')).toMatchObject({ display: 'working', crew: null });
  });
});
