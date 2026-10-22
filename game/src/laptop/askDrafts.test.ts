import { describe, expect, it } from 'vitest';
import type { Ask } from '../net/protocol';
import { AskDrafts } from './askDrafts';

const mem = () => {
  const m = new Map<string, string>();
  return { m, s: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } };
};

const ask = (id: string, secret = false): Ask => ({
  tool_use_id: id,
  source: 'transcript',
  agent: 'claude',
  since: 1,
  questions: [
    { header: 'Lib', question: 'Which?', multi: false, other: true, options: [{ label: 'a' }, { label: 'b' }] },
    { header: 'Feat', question: 'Which ones?', multi: true, other: false, secret, options: [{ label: 'x' }, { label: 'y' }, { label: 'z' }] },
  ],
});

describe('AskDrafts (#187)', () => {
  it('keeps one ask per worker, by tool_use_id, across instances (storage)', () => {
    const { s } = mem();
    const a = new AskDrafts(s);
    a.set('w1', ask('t1'), [{ choices: [], other: 'mine' }, { choices: [1, 3], other: null }]);
    const b = new AskDrafts(s);
    expect(b.get('w1', ask('t1'))).toEqual([{ choices: [], other: 'mine' }, { choices: [1, 3], other: null }]);
    expect(b.get('w1', ask('t2'))).toBeNull();
    expect(b.get('w2', ask('t1'))).toBeNull();
    b.clear('w1', 't2'); // another ask's: kept
    expect(b.get('w1', ask('t1'))).not.toBeNull();
    b.set('w1', ask('t2'), [{ choices: [2], other: null }, { choices: [], other: null }]); // another ask replaces it
    expect(new AskDrafts(s).get('w1', ask('t1'))).toBeNull();
    b.set('w1', ask('t2'), [{ choices: [], other: null }, { choices: [], other: null }]); // nothing picked: gone
    expect(new AskDrafts(s).get('w1', ask('t2'))).toBeNull();
  });

  it('reads storage as untrusted: picks that do not fit the ask are dropped or refused', () => {
    const { m, s } = mem();
    const a = new AskDrafts(s);
    a.set('w1', ask('t1'), [{ choices: [1], other: null }, { choices: [2], other: null }]);
    const k = [...m.keys()][0] as string;
    const stored = JSON.parse(m.get(k) as string) as { fields: Record<string, string> };
    stored.fields.picks = JSON.stringify([{ choices: [1, 2, 9, 'x'], other: 5 }, { choices: [3, 3, 0], other: 'no other here' }]);
    m.set(k, JSON.stringify(stored));
    expect(new AskDrafts(s).get('w1', ask('t1'))).toEqual([{ choices: [1], other: null }, { choices: [3], other: null }]);
    stored.fields.picks = JSON.stringify([{ choices: [1], other: null }]); // another shape: the ask changed
    m.set(k, JSON.stringify(stored));
    expect(new AskDrafts(s).get('w1', ask('t1'))).toBeNull();
    stored.fields.picks = '{not json';
    m.set(k, JSON.stringify(stored));
    expect(new AskDrafts(s).get('w1', ask('t1'))).toBeNull();
  });

  it('never writes an ask with a secret question to storage (memory only), nor any while “Review prompt secrets” is on', () => {
    const { m, s } = mem();
    let on = false;
    const a = new AskDrafts(s, () => !on);
    a.set('w1', ask('t1', true), [{ choices: [], other: 'hunter2' }, { choices: [1], other: null }]);
    expect(m.size).toBe(0);
    expect(a.get('w1', ask('t1', true))?.[0]?.other).toBe('hunter2');
    a.set('w1', ask('t2'), [{ choices: [], other: 'plain' }, { choices: [], other: null }]);
    expect(m.size).toBe(1);
    expect(a.get('w1', ask('t1', true))).toBeNull(); // replaced by the other ask
    on = true;
    a.persistChanged();
    expect(m.size).toBe(0);
    a.set('w1', ask('t2'), [{ choices: [], other: 'token=abc123' }, { choices: [], other: null }]);
    expect([...m.values()].some((v) => v.includes('abc123'))).toBe(false);
    expect(a.get('w1', ask('t2'))?.[0]?.other).toBe('token=abc123');
    a.clear('w1', 't2');
    expect(a.get('w1', ask('t2'))).toBeNull();
  });
});
