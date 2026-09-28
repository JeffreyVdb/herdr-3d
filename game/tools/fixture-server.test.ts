import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { WorldStore } from '../src/world/store';
import type { Snapshot, WorldEvent } from '../src/net/protocol';
import { loadFixture, startFixtureServer } from './fixture-server';

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
    expect(store.stack(null).map((f) => [f.session, f.counts.total])).toEqual([['scratchpad', 3]]);
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
