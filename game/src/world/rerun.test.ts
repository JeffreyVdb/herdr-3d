import { describe, expect, it } from 'vitest';
import { rerunSiblings } from './rerun';
import type { StoredWorker } from './store';

const w = (id: string, rerun_of?: string, hired_at?: number): StoredWorker =>
  ({ id, session: 's', floor: 's', workspace_id: id, status: 'idle', status_since: 0, ...(rerun_of ? { rerun_of } : {}), ...(hired_at ? { hired_at } : {}) }) as StoredWorker;

describe('rerunSiblings', () => {
  const thimble = w('a', undefined, 1);
  const clover = w('b', 'a', 30);
  const nutmeg = w('c', 'a', 20);
  const other = w('d', undefined, 5);

  it('on the original: its reruns, oldest hire first', () => {
    expect(rerunSiblings('a', [thimble, clover, nutmeg, other]).map((x) => x.id)).toEqual(['c', 'b']);
  });

  it('on a rerun: the original first, then the other reruns of it', () => {
    expect(rerunSiblings('b', [clover, other, nutmeg, thimble]).map((x) => x.id)).toEqual(['a', 'c']);
  });

  it('a rerun of a rerun belongs to both', () => {
    const pip = w('e', 'b', 40);
    expect(rerunSiblings('b', [thimble, clover, pip]).map((x) => x.id)).toEqual(['a', 'e']);
  });

  it('none: a worker nobody repeats, or one not known', () => {
    expect(rerunSiblings('d', [thimble, clover, other])).toEqual([]);
    expect(rerunSiblings('zz', [thimble, clover])).toEqual([]);
  });

  it('the original gone: the other reruns still find each other', () => {
    expect(rerunSiblings('b', [clover, nutmeg]).map((x) => x.id)).toEqual(['c']);
  });
});
