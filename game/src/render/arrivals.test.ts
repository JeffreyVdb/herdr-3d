import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { buildingPlan } from '../world/building';
import { PACK_S, PLUS_BACK_AFTER_M, STAND_S, WALK_SPEED, walkInRoute } from '../world/arrival';
import { floorLayout, outlineOf } from '../world/layout';
import { walkOutRoute } from '../world/route';
import { Arrivals, type ArrivalSpec } from './arrivals';

const counts = [12, 8];
const outline = outlineOf(counts);
const floors = counts.map((n) => floorLayout(n, outline));
const plan = buildingPlan(outline, counts.length, floors[0]!.fireDoor);
const DESK = 5;

function spec(id: string, kind: 'in' | 'out'): ArrivalSpec {
  const route = kind === 'out' ? walkOutRoute(floors[1]!, plan, 1, DESK) : walkInRoute(floors[1]!, plan, 1, DESK);
  return { id, kind, session: 'f', desk: DESK, name: id, route, seatYaw: floors[1]!.slots[DESK]!.yaw, tint: 0x88aaff, cue: { family: 'opus', color: 0xff8844, hat: 'none' }, display: 'working', phase: 0 };
}

const zero = (m: THREE.InstancedMesh, i: number) => {
  const e = new THREE.Matrix4();
  m.getMatrixAt(i, e);
  return e.elements.every((x, k) => (k === 15 ? x === 1 : x === 0));
};

describe('Arrivals', () => {
  it('a walk-in to the desk a worker is still walking out of owns that desk (no seated copy mid-walk)', () => {
    const a = new Arrivals(false);
    a.start(spec('pip', 'out'), 0);
    // Pip is past the point where the desk gets its "+" back: the desk is as the world says...
    const past = PACK_S + STAND_S + (PLUS_BACK_AFTER_M + 1) / WALK_SPEED;
    expect(a.update(past, 0)).toEqual([{ session: 'f', desk: DESK, away: null }]);
    // ...and the world now seats Gumdrop there, who is walking in: the desk must stay empty.
    a.start(spec('gumdrop', 'in'), past);
    for (const t of [past, past + 0.5, past + 2]) expect(a.update(t, t)).toEqual([{ session: 'f', desk: DESK, away: { show: 'empty', display: 'working', cue: 0xff8844 } }]);
  });

  it('draws the props as one InstancedMesh per part, one instance per walker, hidden when nobody walks', () => {
    const a = new Arrivals(false);
    const meshes: THREE.Object3D[] = [];
    a.group.traverse((o) => o instanceof THREE.Mesh && meshes.push(o));
    expect(meshes.length).toBeGreaterThan(10);
    expect(meshes.every((m) => m instanceof THREE.InstancedMesh)).toBe(true);
    expect(a.group.visible).toBe(false);
    const props = meshes.filter((m) => m.name.startsWith('arrivals.')) as THREE.InstancedMesh[];
    expect(props.map((m) => m.name).sort()).toEqual(['body', 'flaps', 'frame', 'lapBase', 'lapLid', 'leaves', 'mug', 'pot', 'sticker', 'tape'].map((k) => `arrivals.${k}`).sort());
    for (let i = 0; i < 8; i++) a.start(spec(`w${i}`, 'in'), 0);
    // A ninth walker at once is skipped (the desk resolves at once), with no new objects.
    expect(a.start(spec('w8', 'in'), 0)).toBe(false);
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
