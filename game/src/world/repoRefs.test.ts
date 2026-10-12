import { describe, expect, it } from 'vitest';
import { isWorldEvent, parseMessage, type Snapshot, type WorldEvent } from '../net/protocol';
import { RepoRefsBook, repoRefsFailureText, repoRefsStateOf } from './repoRefs';
import { WorldStore } from './store';

const snap = (world: Partial<Snapshot['world']>): Snapshot => ({ t: 'world.snapshot', seq: 1, world: { buildings: [], unassigned: [], floors: [], workers: [], ...world } });

describe('#247 the "Repositories from other buildings" switch', () => {
  it('reads a well-formed switch only', () => {
    expect(repoRefsStateOf({ all_buildings: true, extra: 1 })).toEqual({ all_buildings: true });
    expect(repoRefsStateOf({ all_buildings: 'yes' })).toBeNull();
    expect(repoRefsStateOf(null)).toBeNull();
  });

  it('the book: null from an older bridge, upserts tell the listeners', () => {
    const b = new RepoRefsBook();
    let heard = 0;
    b.onChange(() => heard++);
    b.reset(undefined);
    expect(b.state).toBeNull();
    expect(b.upsert({ all_buildings: 1 })).toBe(false);
    expect(b.upsert({ all_buildings: true })).toBe(true);
    expect(b.state).toEqual({ all_buildings: true });
    expect(heard).toBe(2);
  });

  it('the snapshot and repo_refs.update reach the store', () => {
    const s = new WorldStore();
    s.applySnapshot(snap({ repo_refs: { all_buildings: false } }));
    expect(s.repoRefs.state).toEqual({ all_buildings: false });
    const e = parseMessage(JSON.stringify({ t: 'repo_refs.update', seq: 2, all_buildings: true }));
    expect(e && isWorldEvent(e)).toBe(true);
    s.applyEvent(e as WorldEvent);
    expect(s.repoRefs.state).toEqual({ all_buildings: true });
    // A malformed one is not an event.
    const bad = parseMessage(JSON.stringify({ t: 'repo_refs.update', seq: 3 }));
    expect(bad && isWorldEvent(bad)).toBe(false);
  });

  it('says why a set failed', () => {
    expect(repoRefsFailureText('unknown_command', 'x')).toMatch(/Update it/);
    expect(repoRefsFailureText('internal', ' disk full ')).toBe('disk full');
  });
});
