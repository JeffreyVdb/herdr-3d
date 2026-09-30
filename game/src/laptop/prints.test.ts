// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../net/client';
import type { ImageRef } from '../net/protocol';
import { PrintMeshes } from '../render/prints';
import type { DeskSlot } from '../world/layout';
import { MAX_TRAY } from '../world/prints';
import type { Candidate } from '../world/screens';
import { ImageFeeds } from './imageFeed';
import { Prints, PRINT_CFG, RELIST_MS } from './prints';

/**
 * The desk prints' controller against a fake bridge: what is fetched and when, and that nothing outlives a desk that
 * stopped being near: textures made == disposed, bitmaps closed, object URLs revoked, no meshes left, no watch wanted.
 */

const hashOf = (n: number) => n.toString(16).padStart(64, '0');
const ref = (n: number, o: Partial<ImageRef> = {}): ImageRef => ({ source: 'inline', origin: n % 2 ? 'input' : 'agent', hash: hashOf(n), mime: 'image/png', width: 640, height: 400, item_id: `i${n}`, seq: n, ts: n, ...o });

const slots = (n: number): DeskSlot[] => Array.from({ length: n }, (_, i) => ({ index: i, pod: 0, desk: { x: i * 2, z: 0 }, seat: { x: i * 2, z: -0.85 }, chairIn: { x: i * 2, z: -0.6 }, yaw: 0 }));

let urls = { made: 0, revoked: 0 };

beforeEach(() => {
  urls = { made: 0, revoked: 0 };
  let n = 0;
  URL.createObjectURL = () => `blob:fake/${++n}${(urls.made++, '')}`;
  URL.revokeObjectURL = () => {
    urls.revoked++;
  };
});
afterEach(() => vi.restoreAllMocks());

function rig(list: ImageRef[], o: { failThumbs?: boolean } = {}) {
  const log: Array<{ t: string; hash?: string }> = [];
  const bitmaps: Array<{ closed: boolean; close(): void }> = [];
  const feeds = new ImageFeeds({
    send: (t, args) => {
      const a = args as { hash?: string };
      log.push({ t, ...(a.hash ? { hash: a.hash } : {}) });
      if (t === 'transcript.images') return Promise.resolve<CommandResult>({ ok: true, data: { images: list } });
      if (o.failThumbs) return Promise.resolve<CommandResult>({ ok: false, code: 'not_found', message: 'gone' });
      return Promise.resolve<CommandResult>({ ok: true, data: { mime: 'image/png', width: 100, height: 60, bytes: 3, size: 'thumb', data: btoa('abc') } });
    },
  });
  const ready = new Set<string>();
  const prints = new Prints({
    feeds,
    ready: (id) => ready.has(id),
    decode: () => {
      const b = { closed: false, close() { b.closed = true; } };
      bitmaps.push(b);
      return Promise.resolve(b as unknown as ImageBitmap);
    },
  });
  const meshes = new PrintMeshes(slots(4));
  prints.setMeshes(meshes);
  return { feeds, prints, meshes, ready, log, bitmaps };
}

const flush = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
};
const cand = (id: string, dist: number, visible = true): Candidate => ({ id, dist, visible });
const desks = new Map([
  ['a', 0],
  ['b', 1],
  ['c', 2],
]);

/** A watch was acked for these workers, and its images were noted. */
async function near(r: ReturnType<typeof rig>, now: number, ids: string[]) {
  for (const id of ids) {
    r.ready.add(id);
    r.feeds.get(id).reset();
  }
  r.prints.update(now, ids.map((id, i) => cand(id, 2 + i)), desks, null, true);
  await flush();
}

describe('the desks that have prints', () => {
  it('fetches nothing for a desk that is not near or not in view', async () => {
    const r = rig([ref(1), ref(2)]);
    r.prints.update(0, [cand('a', 9), cand('b', 3, false)], desks, null, true);
    r.prints.tick(1000);
    await flush();
    expect(r.prints.active).toEqual([]);
    expect(r.prints.wants()).toEqual([]);
    expect(r.log).toEqual([]);
    expect(r.meshes.deskIds()).toEqual([]);
  });

  it('a near desk: watch wanted, the list read once the watch is acked, one thumbnail per print, real textures on the pictures', async () => {
    const r = rig([ref(1), ref(2), ref(3, { unavailable: true, hash: '', reason: 'not_allowed', path: '/etc/x.png' })]);
    r.prints.update(0, [cand('a', 3)], desks, null, true);
    expect(r.prints.wants()).toEqual(['a']);
    // Not acked yet: the bridge would refuse transcript.images.
    await flush();
    expect(r.log).toEqual([]);
    await near(r, 300, ['a']);
    expect(r.log.filter((l) => l.t === 'transcript.images')).toHaveLength(1);
    expect(r.log.filter((l) => l.t === 'transcript.image').map((l) => l.hash).sort()).toEqual([hashOf(1), hashOf(2)]);
    const info = r.prints.info()[0];
    expect(info?.prints.map((p) => [p.tray, p.blank, p.loaded])).toEqual([
      ['in', false, true],
      ['in', true, false],
      ['out', false, true],
    ]);
    expect(r.prints.counts()).toMatchObject({ alive: 2, created: 2, disposed: 0 });
  });

  it('shows at most ten prints, the newest, and only the two nearest desks', async () => {
    const r = rig(Array.from({ length: 30 }, (_, i) => ref(i + 1)));
    await near(r, 0, ['a', 'b', 'c']);
    expect(r.prints.active).toHaveLength(2);
    for (const d of r.prints.info()) expect(d.prints.length).toBeLessThanOrEqual(2 * MAX_TRAY);
    expect(r.prints.info().every((d) => d.prints.length === 2 * MAX_TRAY)).toBe(true);
  });

  it('a new image makes a fresh list (after a moment), a burst is one read', async () => {
    const list = [ref(1)];
    const r = rig(list);
    await near(r, 0, ['a']);
    const reads = () => r.log.filter((l) => l.t === 'transcript.images').length;
    expect(reads()).toBe(1);
    list.push(ref(2), ref(4), ref(6));
    const feed = r.feeds.get('a');
    feed.changed();
    feed.changed();
    r.prints.tick(100);
    await flush();
    expect(reads()).toBe(1);
    r.prints.tick(100 + RELIST_MS + 1);
    await flush();
    expect(reads()).toBe(2);
    expect(r.prints.info()[0]?.prints).toHaveLength(4);
  });

  it('a failed thumbnail stays a blank card, and is not asked again', async () => {
    const r = rig([ref(1)], { failThumbs: true });
    await near(r, 0, ['a']);
    r.prints.tick(5000);
    await flush();
    expect(r.prints.info()[0]?.prints.map((p) => p.loaded)).toEqual([false]);
    expect(r.log.filter((l) => l.t === 'transcript.image')).toHaveLength(1);
  });

  it('the desk you sit at keeps its prints whatever the planner says', async () => {
    const r = rig([ref(1)]);
    r.ready.add('a');
    r.prints.update(0, [], desks, 'a', true);
    expect(r.prints.active).toEqual(['a']);
    r.prints.update(500, [cand('b', 40)], desks, 'a', true);
    expect(r.prints.active).toEqual(['a']);
    // Stood up and nothing near: they go.
    r.prints.update(1000, [cand('b', 40)], desks, null, true);
    expect(r.prints.active).toEqual([]);
  });
});

describe('nothing outlives a desk that lost its prints', () => {
  it('20 near/far cycles leave no texture, bitmap, mesh, object URL or watch behind', async () => {
    const r = rig(Array.from({ length: 12 }, (_, i) => ref(i + 1)));
    for (let i = 0; i < 20; i++) {
      const t = i * 100_000;
      await near(r, t, ['a', 'b']);
      expect(r.prints.counts().alive).toBeGreaterThan(0);
      // Out of range: gone at once (past the planner's keep range), the watch and the feed dropped as the laptop does.
      r.prints.update(t + 50_000, [cand('a', 30), cand('b', 30)], desks, null, true);
      expect(r.prints.wants()).toEqual([]);
      for (const id of ['a', 'b']) r.feeds.drop(id);
      r.ready.clear();
      expect(r.prints.counts().alive).toBe(0);
      expect(r.meshes.deskIds()).toEqual([]);
      expect(r.meshes.group.children).toHaveLength(0);
    }
    const c = r.prints.counts();
    expect(c.created).toBeGreaterThan(20);
    expect(c.disposed).toBe(c.created);
    expect(c.closed).toBe(c.created);
    expect(r.bitmaps.every((b) => b.closed)).toBe(true);
    expect(urls.made).toBeGreaterThan(0);
    expect(urls.revoked).toBe(urls.made);
    // Nothing of the picture materials either: dropping the meshes disposed them (no textures alive is the proof three has none).
    expect(r.meshes.texturesAlive).toBe(0);
  });

  it('a thumbnail that arrives after its desk was left is closed, not shown', async () => {
    const r = rig([ref(1)]);
    let release: (() => void) | undefined;
    const slow = new Promise<void>((res) => (release = res));
    const decode = vi.fn(async () => {
      await slow;
      const b = { closed: false, close() { b.closed = true; } };
      r.bitmaps.push(b);
      return b as unknown as ImageBitmap;
    });
    (r.prints as unknown as { host: { decode: typeof decode } }).host.decode = decode;
    await near(r, 0, ['a']);
    expect(decode).toHaveBeenCalledTimes(1);
    r.prints.update(60_000, [cand('a', 30)], desks, null, true);
    release?.();
    await flush();
    expect(r.bitmaps).toHaveLength(1);
    expect(r.bitmaps[0]?.closed).toBe(true);
    expect(r.prints.counts().alive).toBe(0);
  });

  it('going asleep, offline or to another floor takes every print away', async () => {
    const r = rig([ref(1), ref(2)]);
    await near(r, 0, ['a', 'b']);
    expect(r.prints.counts().alive).toBe(4);
    r.prints.update(300, [cand('a', 2)], desks, null, false);
    expect(r.prints.counts().alive).toBe(0);
    expect(r.prints.active).toEqual([]);
    await near(r, 600_000, ['a']);
    expect(r.prints.counts().alive).toBe(2);
    r.prints.setMeshes(null);
    expect(r.meshes.group.children).toHaveLength(0);
    expect(r.meshes.texturesAlive).toBe(0);
  });

  it('planner hysteresis: a desk just out of view keeps its prints for the grace time', async () => {
    const r = rig([ref(1)]);
    await near(r, 0, ['a']);
    r.prints.update(1000, [cand('a', 3, false)], desks, null, true);
    expect(r.prints.active).toEqual(['a']);
    r.prints.update(1000 + PRINT_CFG.graceMs + 500, [cand('a', 3, false)], desks, null, true);
    expect(r.prints.active).toEqual([]);
  });
});
