import { describe, expect, it } from 'vitest';
import { isWorldEvent, parseMessage, type RepoDiscoveryState, type Snapshot, type WorldEvent } from '../net/protocol';
import { cleanRoot, intervalProblem, RepoDiscoveryBook, repoDiscoveryFailureText, repoDiscoveryStateOf, rootProblem } from './repoDiscovery';
import { WorldStore } from './store';

const snap = (world: Partial<Snapshot['world']>): Snapshot => ({ t: 'world.snapshot', seq: 1, world: { buildings: [], unassigned: [], floors: [], workers: [], ...world } });

const wire = {
  roots: ['/home/me/dev', '/gone'],
  interval_minutes: 10,
  status: {
    state: 'scanning',
    revision: 4,
    repositories: 61,
    checkouts: 134,
    last_scan_at: 1760000000000,
    last_success_at: null,
    last_duration_ms: 151,
    progress: { phase: 'checking', done: 3, total: 135 },
    roots: [
      { path: '/home/me/dev', canonical: '/data/dev', state: 'ok', checkouts: 134, last_success_at: 1760000000000, warning: '1 folder could not be read (x)' },
      { path: '/gone', state: 'stale', error: 'the folder does not exist on the bridge host', checkouts: 0, last_success_at: 1 },
      { path: 7, state: 'ok' },
    ],
    extra: true,
  },
};

describe('#54 repository discovery', () => {
  it('reads a well-formed state: malformed roots left out, unknown keys dropped', () => {
    const st = repoDiscoveryStateOf(wire);
    expect(st?.status.roots.map((r) => r.state)).toEqual(['ok', 'stale']);
    expect(st?.status.progress).toEqual({ phase: 'checking', done: 3, total: 135 });
    expect(st?.status.roots[0]?.canonical).toBe('/data/dev');
    expect(st?.status).not.toHaveProperty('extra');
    expect(st?.status.last_success_at).toBeNull();
    expect(repoDiscoveryStateOf({ ...wire, interval_minutes: 0 })).toBeNull();
    expect(repoDiscoveryStateOf({ ...wire, roots: [1] })).toBeNull();
    expect(repoDiscoveryStateOf({ ...wire, status: { ...wire.status, state: 'busy' } })).toBeNull();
    expect(repoDiscoveryStateOf(null)).toBeNull();
  });

  it('the snapshot and repo_discovery.update reach the store; an older bridge has none', () => {
    const s = new WorldStore();
    s.applySnapshot(snap({}));
    expect(s.repoDiscovery.state).toBeNull();
    expect(s.repoDiscovery.revision).toBeNull();
    s.applySnapshot(snap({ repo_discovery: repoDiscoveryStateOf(wire) as RepoDiscoveryState }));
    expect(s.repoDiscovery.revision).toBe(4);
    let heard = 0;
    s.repoDiscovery.onChange(() => heard++);
    const e = parseMessage(JSON.stringify({ t: 'repo_discovery.update', seq: 2, ...wire, status: { ...wire.status, revision: 5, state: 'idle' } }));
    expect(e && isWorldEvent(e)).toBe(true);
    s.applyEvent(e as WorldEvent);
    expect(s.repoDiscovery.revision).toBe(5);
    expect(heard).toBe(1);
    const bad = parseMessage(JSON.stringify({ t: 'repo_discovery.update', seq: 3, roots: [] }));
    expect(bad && isWorldEvent(bad)).toBe(false);
    const b = new RepoDiscoveryBook();
    expect(b.upsert({ roots: [] })).toBe(false);
  });

  it('checks a root and an interval as the bridge does', () => {
    expect(rootProblem('', [])).toMatch(/Type the folder/);
    expect(rootProblem('dev', [])).toMatch(/absolute path/);
    expect(rootProblem('/a\nb', [])).toMatch(/line break/);
    expect(rootProblem('/home/me/dev/', ['/home/me/dev'])).toMatch(/already scanned/);
    expect(rootProblem('/home/me/./dev', ['/home/me/dev'])).toMatch(/already scanned/);
    expect(rootProblem('/srv/my repos ü', ['/home/me/dev'])).toBeNull();
    expect(rootProblem('/x', Array.from({ length: 32 }, (_, i) => `/r${i}`))).toMatch(/At most 32/);
    expect(cleanRoot('//a/b/../c/')).toBe('/a/c');
    expect(cleanRoot('/')).toBe('/');
    expect(intervalProblem('10')).toBeNull();
    for (const bad of ['0', '1441', '1.5', 'ten', '']) expect(intervalProblem(bad)).toMatch(/1 to 1440/);
  });

  it('says why a command failed', () => {
    expect(repoDiscoveryFailureText('unsupported', 'x')).toMatch(/Update it/);
    expect(repoDiscoveryFailureText('bad_request', ' Scan folder 1 must be… ')).toBe('Scan folder 1 must be…');
  });
});
