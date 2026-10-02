import { describe, expect, it } from 'vitest';
import type { Display } from './derive';
import { inboxChip, inboxQueue, type InboxCandidate } from './inbox';
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

  it('leaves out working, idle, waiting and sleeping workers', () => {
    expect(inboxQueue([w('a', 'working', 1), w('b', 'idle', 2), w('c', 'waiting', 3), w('d', 'asleep', 4)])).toEqual([]);
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

describe('inboxChip', () => {
  it('counts the inbox and marks it when someone needs you', () => {
    expect(inboxChip(inboxQueue([w('a', 'needs_you', 1), w('b', 'done', 2)]))).toEqual({ count: 2, blocked: true });
    expect(inboxChip(inboxQueue([w('b', 'done', 2), w('c', 'done', 3)]))).toEqual({ count: 2, blocked: false });
  });
  it('is nothing at zero', () => {
    expect(inboxChip([])).toBeNull();
    expect(inboxChip(inboxQueue([w('c', 'done', 3, { role: 'code' })]))).toBeNull();
  });
});
