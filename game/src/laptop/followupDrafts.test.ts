import { describe, expect, it } from 'vitest';
import { FollowupDrafts } from './followupDrafts';

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

describe('FollowupDrafts (#60)', () => {
  it('keeps one follow-up per worker, by turn and question id, across instances (storage)', () => {
    const s = mem();
    const a = new FollowupDrafts(s);
    a.set('w1', 't1', { picks: { q2: { value: '(c) Yes', text: '' }, q3: { value: null, text: 'mine' }, q4: { value: null, text: ' ' } }, note: 'later', source: 'parsed' });
    const b = new FollowupDrafts(s);
    expect(b.get('w1', 't1')).toEqual({ picks: { q2: { value: '(c) Yes', text: '' }, q3: { value: null, text: 'mine' } }, note: 'later', source: 'parsed' });
    expect(b.get('w1', 't2')).toBeNull();
    b.clear('w1', 't2'); // another turn's: kept
    expect(b.get('w1', 't1')).not.toBeNull();
    b.set('w1', 't1', { picks: {}, note: '', source: 'parsed' }); // nothing left: gone
    expect(new FollowupDrafts(s).get('w1', 't1')).toBeNull();
  });

  it('#108 round 4: memory only while “Review prompt secrets” is on (no storage key holds the note or an answer), written again once off', () => {
    const m = new Map<string, string>();
    const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    let on = false;
    const a = new FollowupDrafts(s, () => !on);
    a.set('w1', 't1', { picks: { q1: { value: null, text: 'old answer' } }, note: 'n', source: 'parsed' });
    expect(m.size).toBe(1);
    on = true;
    a.persistChanged();
    expect(m.size).toBe(0);
    a.set('w1', 't1', { picks: { q1: { value: null, text: 'pw=hunter2' } }, note: 'token=abc123', source: 'parsed' });
    expect([...m.values()].some((v) => v.includes('hunter2') || v.includes('abc123'))).toBe(false);
    expect(m.size).toBe(0);
    expect(a.get('w1', 't1')?.note).toBe('token=abc123');
    on = false;
    a.persistChanged();
    expect(new FollowupDrafts(s).get('w1', 't1')?.note).toBe('token=abc123');
  });
});
