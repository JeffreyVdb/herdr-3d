import { afterEach, describe, expect, it } from 'vitest';
import { loadFixture } from './fixture-server.ts';
import { SimWorld } from './fixture-sim.ts';
import { ReposSim } from './fixture-repos.ts';

// #247: the fixture's `worker.repos` and shared switch, on demo-m5 set up for `@r:` (`simrepos`).

type Msg = Record<string, unknown>;
const worlds: SimWorld[] = [];
afterEach(() => worlds.splice(0).forEach((w) => w.dispose()));

function world(repos?: string) {
  const rec = loadFixture('demo-m5');
  const w = new SimWorld(rec.snapshot, { stepMs: 20, usageMs: 0, ...(repos !== undefined ? { repos } : {}) });
  worlds.push(w);
  const heard: Msg[] = [];
  w.start((m) => heard.push(m as Msg));
  let n = 0;
  const run = (t: string, args: Msg = {}) => {
    const out: Msg[] = [];
    w.handle({ t, req_id: `r${++n}`, args }, (m) => out.push(m as Msg));
    const reply = out.at(-1) as Msg;
    return { reply, events: out.slice(0, -1), data: reply.data as Msg };
  };
  const snap = w.snapshot() as { world: { workers: { id: string; name: string }[]; repo_refs?: unknown } };
  const id = (name: string) => snap.world.workers.find((x) => x.name === name)?.id as string;
  return { w, run, id, heard, snap };
}

describe('the fixture’s repositories on other floors (#247)', () => {
  it('lists the other floors of the worker’s building with a stored repo or folder, cloned by the basename rule', () => {
    const { run, id, snap } = world('k1');
    expect(snap.world.repo_refs).toEqual({ all_buildings: false });
    // Pebble is on herdr-3d (Work): depot-manager (repo, its folder a checkout) and pastry (a folder only).
    expect(run('worker.repos', { id: id('Pebble') }).data).toEqual({
      repos: [
        { session: 'depot-manager', building: 'Work', same_building: true, repo: 'fomra/depot-manager', dir: '/home/dev/devel/fomra/depot-manager', cloned: true },
        { session: 'pastry', building: 'Work', same_building: true, dir: '/home/dev/pastry', cloned: false },
      ],
    });
  });

  it('the switch on lists the other buildings too; errors', () => {
    const { run, id } = world('k2');
    const set = run('repo_refs.set', { all_buildings: true });
    expect(set.events).toEqual([{ t: 'repo_refs.update', all_buildings: true, seq: expect.any(Number) }]);
    expect(set.data).toEqual({ all_buildings: true });
    const repos = (run('worker.repos', { id: id('Pebble') }).data.repos as Msg[]).map((r) => [r.session, r.building, r.same_building, r.cloned]);
    expect(repos).toEqual([
      ['depot-manager', 'Work', true, true],
      ['pastry', 'Work', true, false],
      ['scratchpad', 'Personal', false, false],
    ]);
    expect(run('worker.repos', { id: 'nope' }).reply).toMatchObject({ t: 'error', code: 'unknown_worker' });
    expect(run('worker.repos', { id: id('Pebble'), query: 'x' }).reply).toMatchObject({ t: 'error', code: 'bad_request' });
    expect(run('repo_refs.set', {}).reply).toMatchObject({ t: 'error', code: 'bad_request' });
  });

  it('the connections of one key share the switch; another key and no key do not', () => {
    const a = world('shared');
    const b = world('shared');
    const other = world('else');
    const plain = world();
    a.run('repo_refs.set', { all_buildings: true });
    expect(b.heard.filter((m) => m.t === 'repo_refs.update')).toEqual([{ t: 'repo_refs.update', all_buildings: true, seq: expect.any(Number) }]);
    expect(b.run('repo_refs.get').data).toEqual({ all_buildings: true });
    expect(other.run('repo_refs.get').data).toEqual({ all_buildings: false });
    expect(plain.run('repo_refs.get').data).toEqual({ all_buildings: false });
    // Without a key the floors are as recorded: nothing stored on Pebble's building's other floors but depot-manager's repo.
    expect(plain.run('worker.repos', { id: plain.id('Pebble') }).data).toEqual({
      repos: [{ session: 'depot-manager', building: 'Work', same_building: true, repo: 'fomra/depot-manager', cloned: false }],
    });
  });
});

it('a folder-only floor whose folder went missing is hidden; a repo whose folder did is not cloned', () => {
  const floors: Record<string, { session: string; building: string | null; index: number | null; settings?: { repo?: string; default_cwd?: string } }> = {
    me: { session: 'me', building: 'b', index: 0 },
    gone: { session: 'gone', building: 'b', index: 1, settings: { default_cwd: '/src/missing/x' } },
    api: { session: 'api', building: 'b', index: 2, settings: { repo: 'o/api', default_cwd: '/src/missing/api' } },
  };
  const s = new ReposSim(
    {
      layout: () => ({ buildings: [{ id: 'b', name: 'B', floors: ['me', 'gone', 'api'] }], unassigned: [] }),
      floor: (x) => floors[x],
      sessionOf: () => 'me',
      emit: (send, m) => send(m),
      error: (code, message) => Object.assign(new Error(message), { code }),
    },
    null,
  );
  expect(s.repos('me')).toEqual([{ session: 'api', building: 'B', same_building: true, repo: 'o/api', dir: '/src/missing/api', cloned: false }]);
});
