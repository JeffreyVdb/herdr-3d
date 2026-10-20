import '../test/fakeCanvas';
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { Floor, Worker } from '../net/protocol';
import { WorldStore } from '../world/store';
import { FloorPool, poolCapacity, POOL_STEP } from './floorPool';
import { MonitorCards } from './monitorCards';
import { LAMPS, officeLamps, OfficeView } from './office';

const STATUS = ['working', 'idle', 'blocked', 'done'] as const;

/** A tiny seeded PRNG (mulberry32): the same sequences every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A world of floors with these desk counts, each about half full of workers. */
function world(desks: number[], rand: () => number): WorldStore {
  const floors: Floor[] = desks.map((d, i) => ({ session: `f${i}`, state: rand() < 0.2 ? 'asleep' : 'running', building: 'b1', index: i, desks: d }));
  const workers: Worker[] = floors.flatMap((f) =>
    Array.from({ length: f.desks }, (_, k) => k)
      .filter(() => rand() < 0.5)
      .map((k) => ({ id: `${f.session}-w${k}`, session: f.session, workspace_id: `ws-${f.session}-${k}`, label: `w${k}`, name: `W${k}`, desk_index: k, harness: 'claude', model: 'claude-opus-5-5', status: STATUS[Math.floor(rand() * STATUS.length)] as Worker['status'] })),
  );
  const s = new WorldStore(1000);
  s.applySnapshot({ t: 'world.snapshot', seq: 1, world: { buildings: [{ id: 'b1', name: 'Work', sort: 0, floors: floors.map((f) => f.session) }], unassigned: [], floors, workers } });
  return s;
}

interface Snap {
  mesh: THREE.InstancedMesh;
  matrix: THREE.InstancedBufferAttribute;
  matrixArray: ArrayLike<number>;
  color: THREE.InstancedBufferAttribute | null;
  colorArray: ArrayLike<number> | null;
  capacity: number;
}

const snap = (pool: FloorPool): Map<string, Snap[]> =>
  new Map(
    pool.kits().map(({ key, kit }) => [
      key,
      kit.meshes.map((mesh) => ({ mesh, matrix: mesh.instanceMatrix, matrixArray: mesh.instanceMatrix.array, color: mesh.instanceColor, colorArray: mesh.instanceColor?.array ?? null, capacity: kit.capacity })),
    ]),
  );

describe('FloorPool (#141)', () => {
  it('sizes kits in steps, half as much again when one is outgrown', () => {
    expect(poolCapacity(1)).toBe(POOL_STEP);
    expect(poolCapacity(POOL_STEP)).toBe(POOL_STEP);
    expect(poolCapacity(POOL_STEP + 1)).toBe(2 * POOL_STEP);
    expect(poolCapacity(62)).toBe(64);
    // Outgrowing 16 for 17 desks: 24 rounded up, not just room for the one more.
    expect(poolCapacity(17, 16)).toBe(32);
    expect(poolCapacity(65, 64)).toBe(96);
    for (let need = 1; need < 300; need += 7) for (const had of [0, 16, 48, 64]) expect(poolCapacity(need, had)).toBeGreaterThanOrEqual(need);
  });

  it('keeps every mesh and its buffers from floor to floor unless a floor outgrows it, and an office disposes nothing of it', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const rand = rng(seed);
      const desks = Array.from({ length: 5 }, () => 1 + Math.floor(rand() * 70));
      const store = world(desks, rand);
      const pool = new FloorPool(officeLamps);
      const disposed = new Set<object>();
      const watch = (o: THREE.EventDispatcher<{ dispose: object }>) => o.addEventListener('dispose', () => disposed.add(o));
      const watched = new WeakSet<object>();
      let prev: Map<string, Snap[]> | null = null;
      let lampAt: Array<{ index: number; targetIndex: number }> | null = null;
      let office: OfficeView | null = null;
      let cards: MonitorCards | null = null;
      // Offices left, disposed one load later (the app disposes them after the next office's first frame).
      let retired: OfficeView[] = [];
      for (let step = 0; step < 16; step++) {
        const f = Math.floor(rand() * desks.length);
        const next = new OfficeView(store.floorView(`f${f}`) as NonNullable<ReturnType<WorldStore['floorView']>>, { shadows: rand() < 0.5, pool });
        const nextCards = new MonitorCards(next.layout.slots, pool);
        next.root.add(nextCards.group);
        if (office) retired.push(office);
        cards?.dispose();
        for (const o of retired.splice(0, rand() < 0.5 ? retired.length : 0)) o.dispose();
        office = next;
        cards = nextCards;
        const now = snap(pool);
        const need = office.layout.desks;
        for (const [key, slots] of now) {
          for (const s of slots) {
            // count within capacity; matrices and colours sized for it.
            expect(s.mesh.count, `${key} ${s.mesh.name}`).toBeLessThanOrEqual(s.matrix.count);
            if (s.color) expect(s.color.count).toBe(s.matrix.count);
            if (!watched.has(s.mesh)) {
              watched.add(s.mesh);
              watch(s.mesh);
              watch(s.mesh.material as THREE.Material);
              watch(s.mesh.geometry);
            }
          }
          expect(slots[0]?.capacity).toBeGreaterThanOrEqual(need);
          const before = prev?.get(key);
          if (!before) continue;
          const grew = (slots[0]?.capacity ?? 0) > (before[0]?.capacity ?? 0);
          // A kit grows only for a floor it has no room for.
          expect(grew, key).toBe(need > (before[0]?.capacity ?? 0));
          if (!grew) expect(slots[0]?.capacity).toBe(before[0]?.capacity);
          slots.forEach((s, i) => {
            const b = before[i] as Snap;
            if (grew) {
              // A new, larger kit: new meshes (new uuids); the old one is disposed.
              expect(s.mesh.uuid).not.toBe(b.mesh.uuid);
              expect(disposed.has(b.mesh)).toBe(true);
            } else {
              expect(s.mesh).toBe(b.mesh);
              expect(s.matrix).toBe(b.matrix);
              expect(s.matrixArray).toBe(b.matrixArray);
              expect(s.color).toBe(b.color);
              expect(s.colorArray).toBe(b.colorArray);
            }
          });
        }
        // Nothing the pool holds now was disposed (by an office's dispose, a crowd's, the cards'...).
        for (const slots of now.values()) for (const s of slots) for (const o of [s.mesh, s.mesh.material, s.mesh.geometry]) expect(disposed.has(o as object), `${s.mesh.name}`).toBe(false);
        // One live mesh per uuid, and every pooled mesh is drawn by the office of now.
        const uuids = new Map<string, number>();
        office.root.traverse((o) => {
          if ((o as THREE.InstancedMesh).isInstancedMesh) uuids.set(o.uuid, (uuids.get(o.uuid) ?? 0) + 1);
        });
        expect([...uuids.values()].every((n) => n === 1)).toBe(true);
        for (const slots of now.values()) for (const s of slots) expect(uuids.has(s.mesh.uuid), s.mesh.name).toBe(true);
        // The lamps: the same two lights, at the same place in the office's tree, their targets in it too.
        expect(pool.lamps.length).toBe(LAMPS.count);
        const at = pool.lamps.map((l) => ({ index: office!.root.children.indexOf(l), targetIndex: office!.root.children.indexOf(l.target) }));
        for (const a of at) expect(a.index >= 0 && a.targetIndex >= 0).toBe(true);
        if (lampAt) expect(at).toEqual(lampAt);
        lampAt = at;
        for (const l of pool.lamps) expect(disposed.has(l)).toBe(false);
        prev = now;
      }
      for (const o of retired) o.dispose();
      office?.dispose();
      for (const slots of snap(pool).values()) for (const s of slots) expect(disposed.has(s.mesh)).toBe(false);
      pool.dispose();
    }
  }, 60_000);

  it('an office left behind writes nothing into the meshes the next one draws with', () => {
    const rand = rng(7);
    const store = world([12, 12], rand);
    const pool = new FloorPool(officeLamps);
    const a = new OfficeView(store.floorView('f0')!, { shadows: false, pool });
    const b = new OfficeView(store.floorView('f1')!, { shadows: false, pool });
    const copy = () => pool.kits().flatMap(({ kit }) => kit.meshes.map((m) => [m.name, Array.from(m.instanceMatrix.array), m.instanceColor ? Array.from(m.instanceColor.array) : null, m.visible, m.count]));
    const cam = new THREE.PerspectiveCamera();
    b.frame(1, cam, cam, { width: 100, height: 100 }, true);
    const before = copy();
    const lamps = pool.lamps.map((l) => l.intensity);
    // The old office goes through what the app may still call on it: a seat, a lean, a frame, the time of day.
    a.apply(store.floorView('f0')!);
    a.setLean(3);
    a.setPlan(true);
    a.frame(2, cam, cam, { width: 100, height: 100 }, true);
    a.setDaylight({ ...(a as unknown as { look: Parameters<OfficeView['setDaylight']>[0] }).look, day: 0 });
    expect(copy()).toEqual(before);
    expect(pool.lamps.map((l) => l.intensity)).toEqual(lamps);
    a.dispose();
    b.dispose();
    pool.dispose();
  });
});
