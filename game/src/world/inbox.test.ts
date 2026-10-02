import { describe, expect, it } from 'vitest';
import type { Ask, Building, Floor, Followup, Worker } from '../net/protocol';
import { crewView } from './crew';
import type { Display } from './derive';
import { inboxAge, inboxQueue, inboxReason, inboxWhere, type InboxCandidate } from './inbox';
import { nextNeed } from './next';

const w = (id: string, display: Display, since: number, over: Partial<InboxCandidate> = {}): InboxCandidate => ({
  id,
  session: 'top',
  building: 'work',
  display,
  since,
  desk: 0,
  name: id,
  role: null,
  ...over,
});

describe('inboxQueue', () => {
  it('holds whoever needs you, any role, and the employees that are done', () => {
    const q = inboxQueue([
      w('code-done', 'done', 1, { role: 'code' }),
      w('review-done', 'done', 2, { role: 'review' }),
      w('code-asks', 'needs_you', 3, { role: 'code' }),
      w('orch-done', 'done', 4, { role: 'orch' }),
      w('orch-over-cap', 'needs_you', 5, { role: 'orch' }),
      w('plain-done', 'done', 6),
      w('plain-blocked', 'needs_you', 7),
    ]);
    expect(q.map((x) => x.id)).toEqual(['code-asks', 'orch-over-cap', 'plain-blocked', 'orch-done', 'plain-done']);
    expect(q.map((x) => x.reason)).toEqual(['blocked', 'blocked', 'blocked', 'done', 'done']);
    expect(q[0]).not.toHaveProperty('role');
  });

  it('lists the freelancers that are done too when asked (Settings: include freelancers)', () => {
    const all = [w('code-done', 'done', 1, { role: 'code' }), w('plain-done', 'done', 2), w('ux-working', 'working', 3, { role: 'ux' })];
    expect(inboxQueue(all, { freelancers: true }).map((x) => x.id)).toEqual(['code-done', 'plain-done']);
    expect(inboxQueue(all, { freelancers: false }).map((x) => x.id)).toEqual(['plain-done']);
    expect(inboxQueue(all, {}).map((x) => x.id)).toEqual(['plain-done']);
  });

  it('leaves out working, idle, waiting and sleeping workers', () => {
    expect(inboxQueue([w('a', 'working', 1), w('b', 'idle', 2), w('c', 'waiting', 3), w('d', 'asleep', 4)], { freelancers: true })).toEqual([]);
  });

  it('needs-you before done, the longest wait first, with no building of yours first', () => {
    const q = inboxQueue([
      w('here-done', 'done', 10),
      w('lot-done', 'done', 5, { building: null, session: 'lot' }),
      w('there-blocked', 'needs_you', 40, { building: 'other', session: 'far' }),
      w('here-blocked', 'needs_you', 30),
      w('lot-blocked', 'needs_you', 20, { building: null, session: 'lot' }),
    ]);
    expect(q.map((x) => x.id)).toEqual(['lot-blocked', 'here-blocked', 'there-blocked', 'lot-done', 'here-done']);
  });

  it('is empty with nobody in it', () => {
    expect(inboxQueue([])).toEqual([]);
  });

  it('walks along like N: the next one after the last visited, wrapping', () => {
    const q = inboxQueue([w('a', 'needs_you', 1), w('b', 'done', 2), w('c', 'done', 3, { role: 'ux' })]);
    expect(nextNeed(q, null)?.id).toBe('a');
    expect(nextNeed(q, 'a')?.id).toBe('b');
    expect(nextNeed(q, 'b')?.id).toBe('a');
  });
});

describe('inboxReason', () => {
  const worker = (over: Partial<Worker> = {}): Worker => ({ id: 'w1', session: 's', workspace_id: 'w1', label: 'Chirp', status: 'idle', ...over });
  const view = (display: Display, over: Partial<Worker> = {}) => {
    const wk = worker(over);
    return { display, worker: wk, crew: crewView(wk, true) };
  };
  const ask = { tool_use_id: 't1', questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }] }] } as unknown as Ask;
  const followup = { turn_id: 'u1', questions: [{ id: 'q1', question: 'Merge now?', kind: 'yes_no' }] } as unknown as Followup;

  it('says why it needs you, from the same fields that make it need you', () => {
    expect(inboxReason(view('needs_you', { status: 'blocked' }))).toBe('Needs you');
    expect(inboxReason(view('needs_you', { ask }))).toBe('Question');
    expect(inboxReason(view('needs_you', { followup }))).toBe('Follow-up');
    expect(inboxReason(view('needs_you', { wrapup: { state: 'needs_you', worktree: 'keep', armed_at: 1 } }))).toBe('Wrap-up stuck');
    expect(inboxReason(view('needs_you', { label: 'CODE|r1|#100', report: { state: 'ready', input_required: 'Which port?' } }))).toBe('Report asks');
  });

  it('the question first, as the card shows it; an armed wrap-up or an empty input_required is no reason', () => {
    expect(inboxReason(view('needs_you', { ask, followup, wrapup: { state: 'needs_you', worktree: 'keep', armed_at: 1 } }))).toBe('Question');
    expect(inboxReason(view('needs_you', { status: 'blocked', wrapup: { state: 'armed', worktree: 'keep', armed_at: 1 } }))).toBe('Needs you');
    expect(inboxReason(view('needs_you', { status: 'blocked', label: 'CODE|r1|#100', report: { state: 'ready', input_required: '  ' } }))).toBe('Needs you');
    // An orchestrator over its cap: no word of its own.
    expect(inboxReason(view('needs_you', { label: 'ORCH|r1|#100' }))).toBe('Needs you');
  });

  it('done is finished', () => {
    expect(inboxReason(view('done', { status: 'done' }))).toBe('Finished');
  });
});

describe('inboxWhere', () => {
  const store = {
    buildings: new Map<string, Building>([['work', { id: 'work', name: 'Herdr 3D', sort: 0, floors: ['h3d-sesame-3'] }]]),
    floors: new Map<string, Floor>([
      ['h3d-sesame-3', { session: 'h3d-sesame-3', state: 'running', building: 'work', index: 0 }],
      ['scratch', { session: 'scratch', state: 'running', building: null, index: null }],
      ['lost', { session: 'lost', state: 'running', building: 'gone', index: 0 }],
    ]),
  };
  it('names the building and the floor’s session', () => {
    expect(inboxWhere(store, 'h3d-sesame-3')).toBe('Herdr 3D › h3d-sesame-3');
  });
  it('the unassigned lot (or a building the store no longer has) is Unassigned', () => {
    expect(inboxWhere(store, 'scratch')).toBe('Unassigned › scratch');
    expect(inboxWhere(store, 'lost')).toBe('Unassigned › lost');
    expect(inboxWhere(store, 'nowhere')).toBe('Unassigned › nowhere');
  });
});

describe('inboxAge', () => {
  const now = 10_000_000;
  it('says how long, coarsely', () => {
    expect(inboxAge(now - 20_000, now)).toBe('now');
    expect(inboxAge(now + 5_000, now)).toBe('now');
    expect(inboxAge(now - 60_000, now)).toBe('1 min');
    expect(inboxAge(now - 4 * 60_000 - 30_000, now)).toBe('4 min');
    expect(inboxAge(now - 59 * 60_000, now)).toBe('59 min');
    expect(inboxAge(now - 2 * 3_600_000 - 1, now)).toBe('2 h');
    expect(inboxAge(now - 47 * 3_600_000, now)).toBe('47 h');
    expect(inboxAge(now - 3 * 86_400_000, now)).toBe('3 d');
  });
});
