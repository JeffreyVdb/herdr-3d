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
    expect(isEmptyDraft({ text: '', segments: [{ image: 1 }] })).toBe(false);
  });

  it('carries the composer’s segments under the same key', () => {
    const d = new Drafts('hire', fake());
    d.set('k', { text: '', segments: [{ t: 'text', v: 'a' }, { t: 'image', n: 1 }] });
    expect(d.get('k')?.segments).toHaveLength(2);
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
