import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { WorldStore } from '../src/world/store';
import type { Building, Floor, Snapshot, WorldEvent } from '../src/net/protocol';
import { FIXTURES_DIR, loadFixture, startFixtureServer } from './fixture-server';
import { SimWorld } from './fixture-sim';

// No TCP port: the server listens on a unix socket in a temp dir.
let dir: string;
let srv: Server;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'h3d-fx-'));
  srv = await startFixtureServer(join(dir, 'fx.sock'), { defaultFixture: 'demo' });
});
afterAll(() => {
  srv.close();
  rmSync(dir, { recursive: true, force: true });
});

function session(path: string, hello: object, want: number): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws+unix://${join(dir, 'fx.sock')}:${path}`);
    const got: Array<Record<string, unknown>> = [];
    ws.on('open', () => ws.send(JSON.stringify(hello)));
    ws.on('message', (d) => {
      got.push(JSON.parse(String(d)) as Record<string, unknown>);
      if (got.length === want) {
        ws.close();
        resolve(got);
      }
    });
    ws.on('close', () => resolve(got));
    ws.on('error', reject);
  });
}

/** Sends `msgs` after the hello and collects `want` messages. */
function converse(path: string, msgs: object[], want: number): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws+unix://${join(dir, 'fx.sock')}:${path}`);
    const got: Array<Record<string, unknown>> = [];
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'hello', proto: 1, client: 'test' }));
      for (const m of msgs) ws.send(JSON.stringify(m));
    });
    ws.on('message', (d) => {
      got.push(JSON.parse(String(d)) as Record<string, unknown>);
      if (got.length === want) {
        ws.close();
        resolve(got);
      }
    });
    ws.on('close', () => resolve(got));
    ws.on('error', reject);
  });
}

describe('demo fixture', () => {
  it('is 2 buildings, 3 floors and ~40 workers in mixed states, with the M2 fields', () => {
    const { snapshot, events } = loadFixture('demo');
    const store = new WorldStore(0);
    store.applySnapshot(snapshot as unknown as Snapshot);
    const city = store.city();
    expect(city.map((b) => b.building?.name)).toEqual(['Work', 'Personal']);
    const floors = city.flatMap((b) => b.floors);
    expect(floors).toHaveLength(3);
    expect(floors.some((f) => f.asleep)).toBe(true);
    const workers = floors.flatMap((f) => f.workers);
    expect(workers.length).toBeGreaterThanOrEqual(36);
    expect(workers.length).toBeLessThanOrEqual(44);
    const shown = new Set(workers.map((w) => w.display));
    expect([...shown].sort()).toEqual(['asleep', 'done', 'idle', 'needs_you', 'working']);
    for (const w of workers) {
      expect(w.worker.name).toBeTruthy();
      expect(w.worker.desk_index).toBeTypeOf('number');
    }
    // Every running floor has an empty desk to hire into.
    for (const f of floors) expect(f.seats.some((s) => s === null)).toBe(true);
    for (const e of events) store.applyEvent(e as unknown as WorldEvent);
    expect(store.seq).toBe(events.at(-1)?.seq);
  });

  it('demo-m3 adds the M3 fields and a floor in the unassigned lot', () => {
    const store = new WorldStore(0);
    store.applySnapshot(loadFixture('demo-m3').snapshot as unknown as Snapshot);
    expect(store.stack(null).map((f) => [f.id, f.counts.total])).toEqual([['scratchpad', 3]]);
    expect(store.floorView('herdr-3d')).toMatchObject({ settings: {}, suggested: { repo: 'JeffreyVdb/herdr-3d' } });
    expect(store.floorView('depot-manager')?.settings.repo).toBe('fomra/depot-manager');
    expect(store.hireOptions.codex?.extra_efforts).toEqual({ 'gpt-6-sol': ['ultra'], 'gpt-6-astra': ['ultra'] });
  });

  it('perf fixtures have 60 workers on a floor and 240 across the city', () => {
    const s60 = new WorldStore(0);
    s60.applySnapshot(loadFixture('perf-floor60').snapshot as unknown as Snapshot);
    expect(s60.floorView('perf-floor')).toMatchObject({ desks: 62, counts: { total: 60 } });
    const s240 = new WorldStore(0);
    s240.applySnapshot(loadFixture('perf-city240').snapshot as unknown as Snapshot);
    const city = s240.city();
    expect(city.map((b) => b.floors.length)).toEqual([8, 6, 7, 4, 5]);
    expect(city.flatMap((b) => b.floors).reduce((n, f) => n + f.counts.total, 0)).toBe(240);
  });
});

// Like the bridge, a building lists its floors top to bottom, which is `index` order (index 0 on top). The sim (sim=1)
// rebuilds that list from `index`, so a fixture where the two disagree turns its building upside down with sim=1.
describe('every fixture', () => {
  const names = readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.slice(0, -'.jsonl'.length));

  it('finds them all', () => {
    expect(names).toEqual(expect.arrayContaining(['demo', 'demo-m3', 'demo-m3b', 'perf-floor60', 'perf-floor96', 'perf-city240']));
  });

  it.each(names)('%s: every building lists its floors in index order, and the sim builds the same one', (name) => {
    const { snapshot, events } = loadFixture(name);
    const w = (snapshot as unknown as Snapshot).world;
    // #58: keyed by floor id (an older fixture's floors by their session).
    const idOf = (f: Floor) => f.id ?? f.session;
    const floors = new Map<string, Floor>(w.floors.map((f) => [idOf(f), f]));
    const buildings = new Map<string, Building>(w.buildings.map((b) => [b.id, b]));
    const check = (when: string) => {
      for (const b of buildings.values()) {
        const mine = [...floors.values()].filter((f) => f.building === b.id).sort((x, y) => (x.index ?? 0) - (y.index ?? 0));
        expect(b.floors, `${name} ${when}: ${b.name}'s floors vs their index`).toEqual(mine.map(idOf));
        expect(new Set(mine.map((f) => f.index)).size, `${name} ${when}: two floors of ${b.name} at one index`).toBe(mine.length);
      }
    };
    check('snapshot');
    expect(w.floors.map(idOf), `${name}: world.floors follows the buildings, then the lot`).toEqual([
      ...w.buildings.flatMap((b) => b.floors),
      ...w.unassigned,
    ]);
    // The same floor numbers straight off the fixture and through the sim.
    const levels = (snap: unknown) => {
      const store = new WorldStore(0);
      store.applySnapshot(snap as Snapshot);
      return w.floors.map((f) => [idOf(f), store.level(idOf(f))]);
    };
    expect(levels(new SimWorld(snapshot as never).snapshot()), `${name}: floor numbers with sim=1`).toEqual(levels(snapshot));
    for (const e of events as unknown as WorldEvent[]) {
      if (e.t === 'floor.upsert') floors.set(idOf(e.floor), e.floor);
      if (e.t === 'building.upsert') buildings.set(e.building.id, e.building);
    }
    check('after its events');
  });
});

describe('fixture server', () => {
  it('speaks protocol v1: welcome, snapshot, then the recorded events', async () => {
    const { events } = loadFixture('demo');
    const got = await session('/fixture/demo?play=all', { t: 'hello', proto: 1, client: 'test' }, 2 + events.length);
    expect(got[0]).toMatchObject({ t: 'welcome', proto: 1, server_seq: 1042, resume: 'snapshot' });
    expect(got[1]).toMatchObject({ t: 'world.snapshot', seq: 1042 });
    expect(got.slice(2).map((m) => m.seq)).toEqual(events.map((e) => e.seq));
  });

  it('serves the default fixture on /ws and holds events with play=none', async () => {
    const got = await session('/ws?play=none', { t: 'hello', proto: 1, client: 'test' }, 2);
    expect(got.map((m) => m.t)).toEqual(['welcome', 'world.snapshot']);
  });

  it('rejects a missing hello and a wrong proto like the bridge', async () => {
    const a = await session('/fixture/demo', { t: 'building.create', req_id: '1' }, 1);
    expect(a[0]).toMatchObject({ t: 'error', code: 'hello_required' });
    const b = await session('/fixture/demo', { t: 'hello', proto: 2 }, 1);
    expect(b[0]).toMatchObject({ t: 'error', code: 'unsupported_proto' });
  });

  it('is read-only by default: commands get unknown_command', async () => {
    const got = await converse('/fixture/demo?play=none', [{ t: 'building.create', req_id: '1', args: { name: 'Lab' } }], 3);
    expect(got[2]).toEqual({ t: 'error', req_id: '1', code: 'unknown_command', message: 'the fixture server is read-only' });
  });

  it('simulates commands with sim=1: events, then the ack', async () => {
    const got = await converse('/fixture/demo?sim=1', [{ t: 'building.create', req_id: '1', args: { name: 'Lab' } }], 4);
    expect(got.map((m) => m.t)).toEqual(['welcome', 'world.snapshot', 'building.upsert', 'ack']);
    expect(got[2]).toMatchObject({ seq: 1043, building: { name: 'Lab', floors: [] } });
    expect(got[3]).toMatchObject({ req_id: '1', data: { id: expect.stringMatching(/^b_/) } });
  });

  it('refuses unknown fixtures and path tricks', async () => {
    await expect(session('/fixture/..%2Fpackage', { t: 'hello', proto: 1 }, 1)).rejects.toThrow(/404/);
    await expect(session('/fixture/nope', { t: 'hello', proto: 1 }, 1)).rejects.toThrow(/404/);
  });
});

// #77: `pnpm fixture-server` and CONTRIBUTING run this file with plain `node`, which only strips erasable TypeScript
// (no parameter properties, enums or namespaces) and has no flag to transform the rest since Node 26. Vitest transforms
// whatever it imports, so only a real `node` catches that. Without a port the server prints its usage and exits 2, after
// loading every module it imports: nothing listens.
it('#77 loads under plain node: every module it imports is erasable TypeScript', () => {
  const env = { ...process.env };
  delete env.PORTLEASE_FIXTURE_PORT;
  const r = spawnSync(process.execPath, ['fixture-server.ts'], { cwd: dirname(fileURLToPath(import.meta.url)), env, encoding: 'utf8' });
  expect(r.stderr).not.toMatch(/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX/);
  expect(r.stderr).toMatch(/^usage: fixture-server\.ts/);
  expect(r.status).toBe(2);
});
