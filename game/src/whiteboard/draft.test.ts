import { describe, expect, it } from 'vitest';
import { draftKey, dropDraft, dropDraftIf, keepDraft, MAX_STORED_DRAFT, readDraft, type Draft } from './draft';

class MemStorage {
  readonly m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}
const store = () => new MemStorage() as unknown as Storage & MemStorage;
const draft = (text = 'x'): Draft => ({ v: 1, at: 1, elements: [{ id: 'a', text }], files: [], appState: null });

describe('whiteboard drafts', () => {
  it('are keyed by bridge and floor, never by the token', () => {
    expect(draftKey('ws://127.0.0.1:7000/ws?token=secret', 'herdr-3d')).toBe('127.0.0.1:7000/ws|herdr-3d');
  });

  it('are kept in memory and in storage, and read back from storage after a reload', () => {
    const s = store();
    expect(keepDraft('k1', draft(), s)).toBe('stored');
    expect(readDraft('k1', s)).toEqual(draft());
    dropDraft('k1', s);
    expect(readDraft('k1', s)).toBeNull();
    // A reload: the memory is gone, the stored copy comes back.
    s.setItem('h3d.wb.draft.k2', JSON.stringify(draft('stored')));
    expect(readDraft('k2', s)?.elements).toEqual([{ id: 'a', text: 'stored' }]);
    s.setItem('h3d.wb.draft.k3', '{"v":2}');
    expect(readDraft('k3', s)).toBeNull();
  });

  it('too large or refused by storage: memory only, and no older stored draft comes back instead', () => {
    const s = store();
    keepDraft('k4', draft('old'), s);
    expect(keepDraft('k4', draft('y'.repeat(MAX_STORED_DRAFT)), s)).toBe('memory');
    expect(s.getItem('h3d.wb.draft.k4')).toBeNull();
    expect((readDraft('k4', s)?.elements[0] as { text: string }).text).toHaveLength(MAX_STORED_DRAFT);
    const full = Object.assign(store(), {
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    });
    expect(keepDraft('k5', draft(), full)).toBe('memory');
    expect(readDraft('k5', full)).toEqual(draft());
    expect(keepDraft('k6', draft(), null)).toBe('memory');
    dropDraft('k4', s);
    dropDraft('k5', full);
    dropDraft('k6', null);
  });

  it('a save drops only the copies it has all of: a newer draft kept since stays', () => {
    const s = store();
    keepDraft('k7', draft('saved'), s);
    const has = (text: string) => (d: Draft) => (d.elements[0] as { text: string }).text === text;
    expect(dropDraftIf('k7', has('saved'), s)).toBe(true);
    expect(readDraft('k7', s)).toBeNull();
    // A close kept a newer draft after the save was taken: neither copy goes.
    keepDraft('k8', draft('newer'), s);
    expect(dropDraftIf('k8', has('saved'), s)).toBe(false);
    expect(readDraft('k8', s)?.elements).toEqual([{ id: 'a', text: 'newer' }]);
    expect(s.getItem('h3d.wb.draft.k8')).toContain('newer');
    // After a reload (no memory copy) the stored one is checked the same way.
    s.setItem('h3d.wb.draft.k9', JSON.stringify(draft('newer')));
    expect(dropDraftIf('k9', has('saved'), s)).toBe(false);
    expect(dropDraftIf('k9', has('newer'), s)).toBe(true);
    expect(s.getItem('h3d.wb.draft.k9')).toBeNull();
    dropDraft('k8', s);
  });
});
