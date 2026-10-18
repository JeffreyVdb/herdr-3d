import { describe, expect, it } from 'vitest';
import { Drafts, isEmptyDraft, type DraftStorage } from './drafts';

function fake(): DraftStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const boom: DraftStorage = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
  removeItem: () => {
    throw new Error('SecurityError');
  },
};

describe('Drafts', () => {
  it('#108: memory only while `persist` says no: nothing written, a stored copy removed once it is read', () => {
    const s = fake();
    let persist = true;
    const d = new Drafts('transcript', s, () => persist);
    s.data.set('h3d.draft.transcript.a', JSON.stringify({ v: 1, text: 'pw=hunter2' }));
    persist = false;
    expect(d.get('a')).toEqual({ text: 'pw=hunter2' });
    expect(s.data.size).toBe(0);
    d.set('b', { text: 'token=x' });
    expect(d.get('b')).toEqual({ text: 'token=x' });
    expect(s.data.size).toBe(0);
    // `forget`: the stored copy goes, the one in memory stays.
    persist = true;
    d.set('c', { text: 'c' });
    expect(s.data.has('h3d.draft.transcript.c')).toBe(true);
    d.forget('c');
    expect(s.data.has('h3d.draft.transcript.c')).toBe(false);
    expect(d.get('c')).toEqual({ text: 'c' });
  });

  it('keeps a draft per key, in memory and in storage', () => {
    const s = fake();
    const d = new Drafts('hire', s);
    d.set('pastry:5', { text: 'fix the header', fields: { label: 'Gum' } });
    d.set('pastry:6', { text: 'other' });
    expect(d.get('pastry:5')).toEqual({ text: 'fix the header', fields: { label: 'Gum' } });
    expect(d.get('pastry:6')).toEqual({ text: 'other' });
    // A fresh page (new store, same storage) gets it back.
    expect(new Drafts('hire', s).get('pastry:5')).toEqual({ text: 'fix the header', fields: { label: 'Gum' } });
    expect(new Drafts('run', s).get('pastry:5')).toBeNull();
  });

  it('treats an all-blank draft as none', () => {
    const s = fake();
    const d = new Drafts('hire', s);
    d.set('k', { text: 'x' });
    d.set('k', { text: '  ', fields: { label: '' } });
    expect(d.get('k')).toBeNull();
    expect(s.data.size).toBe(0);
    expect(isEmptyDraft({ text: '', segments: [{ kind: 'file', path: 'a.ts', dir: false }] })).toBe(false);
  });

  it('carries the composer’s segments under the same key, across a reload', () => {
    const s = fake();
    const segments = [{ kind: 'text' as const, text: 'see ' }, { kind: 'file' as const, path: 'my d/a b.ts', dir: false }];
    new Drafts('transcript', s).set('k', { text: 'see ', segments });
    expect(new Drafts('transcript', s).get('k')?.segments).toEqual(segments);
  });

  it('reads stored segments as untrusted: a bad part is left out, a bad list dropped (#141)', () => {
    const s = fake();
    s.setItem('h3d.draft.transcript.a', JSON.stringify({ v: 1, text: 'x', segments: [{ kind: 'text', text: 'x' }, { kind: 'file', path: 'a"b', dir: false }, { t: 'image', n: 1 }] }));
    s.setItem('h3d.draft.transcript.b', JSON.stringify({ v: 1, text: 'y', segments: 'nope' }));
    const d = new Drafts('transcript', s);
    expect(d.get('a')?.segments).toEqual([{ kind: 'text', text: 'x' }]);
    expect(d.get('b')).toEqual({ text: 'y' });
  });

  it('survives blocked, full and corrupt storage', () => {
    const d = new Drafts('hire', boom);
    d.set('k', { text: 'still here' });
    expect(d.get('k')).toEqual({ text: 'still here' });
    d.clear('k');
    expect(d.get('k')).toBeNull();
    const s = fake();
    s.data.set('h3d.draft.hire.k', '{not json');
    expect(new Drafts('hire', s).get('k')).toBeNull();
    s.data.set('h3d.draft.hire.k', JSON.stringify({ v: 2, text: 'future' }));
    expect(new Drafts('hire', s).get('k')).toBeNull();
    expect(new Drafts('hire', null).get('k')).toBeNull();
  });

  it('clears what was sent, but not a newer edit', () => {
    const d = new Drafts('hire', fake());
    d.set('k', { text: 'first task', fields: { label: 'A' } });
    d.clearIfUnchanged('k', { text: 'first task', fields: { label: 'A' } });
    expect(d.get('k')).toBeNull();
    d.set('k', { text: 'first task, then more' });
    d.clearIfUnchanged('k', { text: 'first task' });
    expect(d.get('k')).toEqual({ text: 'first task, then more' });
  });
});
