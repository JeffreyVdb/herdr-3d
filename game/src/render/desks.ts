import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Display } from '../world/derive';
import { CHAIR_IN_OFFSET, DESK_D, DESK_H, DESK_W, SEAT_OFFSET } from '../world/layout';
import { OFFICE } from './palette';

/**
 * Desks, chairs and laptops, instanced per part. Slot space: origin on the
 * floor under the seat, the worker faces +z, the desk centre is at
 * z = SEAT_OFFSET. Empty desks push their chair in, drop the laptop and grow
 * a floating green "+".
 */

export interface DeskState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  /** null = empty desk. */
  display: Display | null;
  cueColor: number;
  /** M4: false hides an empty desk's "+" (someone is walking in to it, or just packed up). */
  plus?: boolean;
}

type Key = 'top' | 'legs' | 'base' | 'lid' | 'screen' | 'sticker' | 'chair' | 'chairBase' | 'plus';

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const SCREEN: Record<Display, number> = {
  working: 0xcfe2ff,
  done: 0xbff0d8,
  needs_you: 0xffb2aa,
  idle: 0x8a96b3,
  asleep: 0x161a26,
};
const HINGE_Z = SEAT_OFFSET - 0.02;
const LID_TILT = 0.28;

/**
 * M5: the laptop screen in slot space, a plane on the open lid facing the
 * chair; `lift` raises it off the lid along its normal (a live screen's
 * texture sits a hair in front of the flat glow).
 */
export function screenGeometry(lift = 0): THREE.BufferGeometry {
  return new THREE.PlaneGeometry(0.31, 0.2)
    .rotateY(Math.PI)
    .translate(0, 0.118, -0.0065 - lift)
    .rotateX(LID_TILT)
    .translate(0, DESK_H + 0.018, HINGE_Z);
}

/** M5: the screen's size, centre, normal (towards the chair) and up, in slot space. */
export function screenFrame(): { width: number; height: number; center: THREE.Vector3; normal: THREE.Vector3; up: THREE.Vector3 } {
  const tilt = new THREE.Matrix4().makeRotationX(LID_TILT);
  const center = new THREE.Vector3(0, 0.118, -0.0065).applyMatrix4(tilt).add(new THREE.Vector3(0, DESK_H + 0.018, HINGE_Z));
  return { width: 0.31, height: 0.2, center, normal: new THREE.Vector3(0, 0, -1).applyMatrix4(tilt), up: new THREE.Vector3(0, 1, 0).applyMatrix4(tilt) };
}

/** The desk art in slot space (shared with your own desk on the mezzanine). */
export function deskGeometries(): Record<Key, THREE.BufferGeometry> {
  const legH = DESK_H - 0.045;
  const lid = new THREE.BoxGeometry(0.34, 0.23, 0.012).translate(0, 0.115, 0);
  return {
    top: new THREE.BoxGeometry(DESK_W, 0.045, DESK_D).translate(0, DESK_H - 0.0225, SEAT_OFFSET),
    legs: mergeGeometries([
      new THREE.BoxGeometry(0.05, legH, DESK_D - 0.08).translate(-DESK_W / 2 + 0.06, legH / 2, SEAT_OFFSET),
      new THREE.BoxGeometry(0.05, legH, DESK_D - 0.08).translate(DESK_W / 2 - 0.06, legH / 2, SEAT_OFFSET),
      new THREE.BoxGeometry(DESK_W - 0.16, 0.3, 0.025).translate(0, 0.33, SEAT_OFFSET + DESK_D / 2 - 0.05),
    ]),
    base: new THREE.BoxGeometry(0.34, 0.018, 0.24).translate(0, DESK_H + 0.009, HINGE_Z - 0.12),
    lid: lid.clone().rotateX(LID_TILT).translate(0, DESK_H + 0.018, HINGE_Z),
    screen: screenGeometry(),
    sticker: new THREE.CylinderGeometry(0.038, 0.038, 0.004, 14)
      .rotateX(Math.PI / 2)
      .translate(0.06, 0.13, 0.008)
      .rotateX(LID_TILT)
      .translate(0, DESK_H + 0.018, HINGE_Z),
    chair: mergeGeometries([
      new THREE.BoxGeometry(0.46, 0.06, 0.44).translate(0, 0.42, 0),
      new THREE.BoxGeometry(0.44, 0.4, 0.05).translate(0, 0.71, -0.24),
    ]),
    chairBase: mergeGeometries([
      new THREE.CylinderGeometry(0.028, 0.028, 0.36, 8).translate(0, 0.21, 0),
      new THREE.BoxGeometry(0.5, 0.03, 0.06).translate(0, 0.03, 0),
      new THREE.BoxGeometry(0.06, 0.03, 0.5).translate(0, 0.03, 0),
    ]),
    plus: mergeGeometries([new THREE.BoxGeometry(0.36, 0.11, 0.07), new THREE.BoxGeometry(0.11, 0.36, 0.07)]),
  };
}

export class DeskSet {
  readonly group = new THREE.Group();
  private readonly meshes: Record<Key, THREE.InstancedMesh>;
  private readonly states: Array<DeskState | null>;
  private readonly m = new THREE.Matrix4();
  private readonly base = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly c = new THREE.Color();
  private readonly camPos = new THREE.Vector3();

  constructor(
    readonly capacity: number,
    shadows: boolean,
    readonly withPlus: boolean,
  ) {
    const geo = deskGeometries();
    const mats: Record<Key, THREE.Material> = {
      top: new THREE.MeshToonMaterial({ color: OFFICE.deskTop }),
      legs: new THREE.MeshToonMaterial({ color: OFFICE.deskLeg }),
      base: new THREE.MeshToonMaterial({ color: OFFICE.laptop }),
      lid: new THREE.MeshToonMaterial({ color: OFFICE.laptop }),
      screen: new THREE.MeshBasicMaterial({ color: 0xffffff }),
      sticker: new THREE.MeshToonMaterial({ color: 0xffffff }),
      chair: new THREE.MeshToonMaterial({ color: OFFICE.chair }),
      chairBase: new THREE.MeshToonMaterial({ color: OFFICE.chairBase }),
      plus: new THREE.MeshToonMaterial({ color: OFFICE.plus, emissive: new THREE.Color(OFFICE.plus).multiplyScalar(0.45) }),
    };
    this.meshes = Object.fromEntries(
      (Object.keys(geo) as Key[]).map((k) => {
        const mesh = new THREE.InstancedMesh(geo[k], mats[k], Math.max(1, capacity));
        mesh.name = `desks.${k}`;
        mesh.frustumCulled = false;
        mesh.castShadow = shadows && k !== 'screen' && k !== 'sticker' && k !== 'plus';
        mesh.receiveShadow = k === 'top';
        for (let i = 0; i < mesh.count; i++) mesh.setMatrixAt(i, ZERO);
        if (k === 'screen' || k === 'sticker') for (let i = 0; i < mesh.count; i++) mesh.setColorAt(i, this.c.set(0xffffff));
        if (k !== 'plus' || withPlus) this.group.add(mesh);
        return [k, mesh];
      }),
    ) as Record<Key, THREE.InstancedMesh>;
    this.states = Array.from({ length: capacity }, () => null);
  }

  get(i: number): DeskState | null {
    return this.states[i] ?? null;
  }

  /** null hides the desk slot entirely. */
  set(i: number, d: DeskState | null): void {
    if (i < 0 || i >= this.capacity) return;
    this.states[i] = d;
    if (!d) {
      for (const mesh of Object.values(this.meshes)) mesh.setMatrixAt(i, ZERO);
    } else {
      this.q.setFromAxisAngle(this.v.set(0, 1, 0), d.yaw);
      this.base.compose(this.v.set(d.x, d.y, d.z), this.q, this.s.set(d.scale, d.scale, d.scale));
      const M = this.meshes;
      M.top.setMatrixAt(i, this.base);
      M.legs.setMatrixAt(i, this.base);
      M.chairBase.setMatrixAt(i, d.display ? this.base : this.chairIn());
      M.chair.setMatrixAt(i, d.display ? this.base : this.chairIn());
      for (const k of ['base', 'lid', 'screen', 'sticker'] as const) M[k].setMatrixAt(i, d.display ? this.base : ZERO);
      if (d.display) {
        M.screen.setColorAt(i, this.c.set(SCREEN[d.display]));
        M.sticker.setColorAt(i, this.c.set(d.cueColor));
      }
      if (d.display || d.plus === false) M.plus.setMatrixAt(i, ZERO);
    }
    for (const mesh of Object.values(this.meshes)) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  private chairIn(): THREE.Matrix4 {
    return this.m.multiplyMatrices(this.base, new THREE.Matrix4().makeTranslation(0, 0, CHAIR_IN_OFFSET));
  }

  /** Screen flicker for working desks, and the bobbing "+" turned to the camera. */
  update(t: number, camera: THREE.Camera | null): void {
    const M = this.meshes;
    let colors = false;
    let plus = false;
    if (camera) camera.getWorldPosition(this.camPos);
    for (let i = 0; i < this.capacity; i++) {
      const d = this.states[i];
      if (!d) continue;
      if (d.display === 'working') {
        const f = 0.82 + 0.18 * Math.abs(Math.sin(t * 9.1 + i * 1.7) * Math.sin(t * 3.3 + i));
        M.screen.setColorAt(i, this.c.set(SCREEN.working).multiplyScalar(f));
        colors = true;
      } else if (!d.display && this.withPlus && d.plus !== false) {
        // Desk centre in world space, then the "+" above it.
        const cx = d.x + Math.sin(d.yaw) * SEAT_OFFSET * d.scale;
        const cz = d.z + Math.cos(d.yaw) * SEAT_OFFSET * d.scale;
        const y = d.y + (1.3 + Math.sin(t * 2 + i) * 0.05) * d.scale;
        const face = camera ? Math.atan2(this.camPos.x - cx, this.camPos.z - cz) : 0;
        this.q.setFromAxisAngle(this.v.set(0, 1, 0), face);
        M.plus.setMatrixAt(i, this.m.compose(this.v.set(cx, y, cz), this.q, this.s.set(d.scale, d.scale, d.scale)));
        plus = true;
      }
    }
    if (colors && M.screen.instanceColor) M.screen.instanceColor.needsUpdate = true;
    if (plus) M.plus.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    for (const mesh of Object.values(this.meshes)) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
  }
}
