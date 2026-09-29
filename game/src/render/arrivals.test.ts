import '../test/fakeCanvas';
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { buildingPlan } from '../world/building';
import { DROP_S, FALL_S, PACK_S, PLUS_BACK_AFTER_M, STAND_S, WALK_SPEED } from '../world/arrival';
import { floorY } from '../world/building';
import { deskKit } from '../world/deskKit';
import { floorLayout, outlineOf } from '../world/layout';
import { walkOutRoute } from '../world/route';
import { Arrivals, type ArrivalSpec } from './arrivals';

const counts = [12, 8];
const outline = outlineOf(counts);
const floors = counts.map((n) => floorLayout(n, outline));
const plan = buildingPlan(outline, counts.length, floors[0]!.fireDoor);
const DESK = 5;

function spec(id: string, kind: 'in' | 'out'): ArrivalSpec {
  const slot = floors[1]!.slots[DESK]!;
  const route = kind === 'out' ? walkOutRoute(floors[1]!, plan, 1, DESK) : [{ x: slot.seat.x, y: floorY(1), z: slot.seat.z }];
  return { id, kind, session: 'f', desk: DESK, name: id, route, seatYaw: slot.yaw, tint: 0x88aaff, cue: { family: 'opus', color: 0xff8844, hat: 'none' }, display: 'working', phase: 0, harness: 'codex' };
}

const zero = (m: THREE.InstancedMesh, i: number) => {
  const e = new THREE.Matrix4();
  m.getMatrixAt(i, e);
  return e.elements.every((x, k) => (k === 15 ? x === 1 : x === 0));
};

describe('Arrivals', () => {
  it('a hire dropping in to the desk a worker is still leaving: the desk is the new hire’s at once (not away), only its figure drops', () => {
    const a = new Arrivals(false);
    a.start(spec('pip', 'out'), 0);
    // Packing: the desk is Pip's, busy, with its codex sticker, the first things packed as they go.
    expect(a.update(0.1, 0)).toEqual([{ session: 'f', desk: DESK, away: { show: 'busy', display: 'working', cue: 0xff8844, harness: 'codex', packed: 0 } }]);
    const packing = a.update(1.2, 1.2)[0]!.away!;
    expect(packing.packed).toBeGreaterThan(0);
    expect(packing.packed).toBeLessThanOrEqual(deskKit({ index: DESK, yaw: floors[1]!.slots[DESK]!.yaw }).items.length);
    // Pip is past the point where the desk gets its "+" back: the desk is as the world says...
    const past = PACK_S + STAND_S + (PLUS_BACK_AFTER_M + 1) / WALK_SPEED;
    expect(a.update(past, 0)).toEqual([{ session: 'f', desk: DESK, away: null }]);
    // ...and the world now seats Gumdrop there, who drops in: never away, the figure falling onto the seat.
    a.start(spec('gumdrop', 'in'), past);
    const first = a.update(past, past);
    expect(first).toEqual([{ session: 'f', desk: DESK, away: null, drop: { dy: expect.any(Number), squash: expect.any(Number) } }]);
    expect(first[0]!.drop!.dy).toBeGreaterThan(1);
    const landed = a.update(past + FALL_S + 0.05, past)[0]!;
    expect(landed).toMatchObject({ away: null, drop: { dy: 0 } });
    expect(landed.drop!.squash).toBeLessThan(1);
    // Done in under a second: the desk as the world says, sitting as usual.
    expect(a.update(past + DROP_S + 0.01, past)).toEqual([{ session: 'f', desk: DESK, away: null, drop: null }]);
    expect(a.log.at(-1)).toMatchObject({ id: 'gumdrop', kind: 'in', played: true });
    expect(a.count).toBe(1);
  });

  it('draws the props as one InstancedMesh per part, one instance per walker, hidden when nobody walks', () => {
    const a = new Arrivals(false);
    const meshes: THREE.Object3D[] = [];
    a.group.traverse((o) => o instanceof THREE.Mesh && meshes.push(o));
    expect(meshes.length).toBeGreaterThan(10);
    expect(meshes.every((m) => m instanceof THREE.InstancedMesh)).toBe(true);
    expect(a.group.visible).toBe(false);
    const props = meshes.filter((m) => m.name.startsWith('arrivals.')) as THREE.InstancedMesh[];
    expect(props.map((m) => m.name).sort()).toEqual(['body', 'flaps', 'laptop', 'mug', 'notebook', 'pens', 'photo', 'plant', 'puff', 'shadow', 'sticker', 'tape'].map((k) => `arrivals.${k}`).sort());
    for (let i = 0; i < 8; i++) a.start(spec(`w${i}`, 'out'), 0);
    // A ninth walker at once is skipped (the desk resolves at once), with no new objects.
    expect(a.start(spec('w8', 'out'), 0)).toBe(false);
    a.update(1, 1);
    expect(a.group.visible).toBe(true);
    let after = 0;
    a.group.traverse((o) => o instanceof THREE.Mesh && after++);
    expect(after).toBe(meshes.length);
    const body = props.find((m) => m.name === 'arrivals.body')!;
    expect(body.count).toBe(8);
    for (let i = 0; i < 8; i++) expect(zero(body, i)).toBe(false);
    a.clear();
    for (let i = 0; i < 8; i++) expect(zero(body, i)).toBe(true);
    expect(a.group.visible).toBe(false);
  });
});
