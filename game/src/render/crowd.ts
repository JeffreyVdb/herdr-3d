import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Display, ModelCue } from '../world/derive';
import { INK } from './palette';

/**
 * Procedural rigid-part workers (docs/decisions.md): a round capsule body,
 * twin goggles on a strap, tiny arms and legs, a hat in the model colour.
 * One InstancedMesh per part for the whole crowd; animation is matrix math
 * on the CPU, no skinning.
 *
 * Worker space: origin at the chair seat, facing +z, 1 unit = 1 m.
 */

export interface Member {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  tint: number;
  cue: ModelCue;
  display: Display;
  /** 0..2π, desynchronises animation between workers. */
  phase: number;
}

type PartKey =
  | 'body'
  | 'pants'
  | 'strap'
  | 'rims'
  | 'lenses'
  | 'pupils'
  | 'mouth'
  | 'armL'
  | 'armR'
  | 'legL'
  | 'legR'
  | 'beanie'
  | 'cap'
  | 'mug'
  | 'exclaim'
  | 'zzz';

interface Part {
  key: PartKey;
  mesh: THREE.InstancedMesh;
  /** Instances per member (the zZz has two). */
  per: number;
}

const SHOULDER_Y = 0.4;
const SHOULDER_X = 0.265;
const HIP = new THREE.Vector3(0.1, 0.07, 0.15);
const EYE_Y = 0.6;

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

/** `low` is for the city, where a worker is a few pixels tall. */
function geometries(low: boolean): Record<PartKey, THREE.BufferGeometry> {
  const n = (hi: number, lo: number) => (low ? lo : hi);
  const arm = new THREE.CapsuleGeometry(0.048, 0.2, n(4, 2), n(8, 5)).translate(0, -0.15, 0);
  const leg = new THREE.CapsuleGeometry(0.062, 0.1, n(4, 2), n(8, 5)).translate(0, -0.1, 0);
  const goggles = (g: () => THREE.BufferGeometry, z: number, rotX: boolean) =>
    mergeGeometries(
      [-1, 1].map((s) => {
        const one = g();
        if (rotX) one.rotateX(Math.PI / 2);
        return one.translate(s * 0.095, EYE_Y, z);
      }),
    );
  const beanie = mergeGeometries([
    new THREE.SphereGeometry(0.215, n(16, 9), n(8, 3), 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 0.74, 0),
    new THREE.CylinderGeometry(0.222, 0.222, 0.06, n(16, 9)).translate(0, 0.745, 0),
    new THREE.SphereGeometry(0.055, n(10, 5), n(6, 3)).translate(0, 0.97, 0),
  ]);
  const cap = mergeGeometries([
    new THREE.SphereGeometry(0.222, n(16, 9), n(8, 3), 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 0.73, 0),
    new THREE.CylinderGeometry(0.15, 0.15, 0.02, n(16, 8), 1).scale(1, 1, 0.8).translate(0, 0.74, 0.2),
  ]);
  const exclaim = mergeGeometries([
    new THREE.BoxGeometry(0.06, 0.2, 0.06).translate(0, 0.14, 0),
    new THREE.BoxGeometry(0.06, 0.06, 0.06).translate(0, -0.02, 0),
  ]);
  const bar = (w: number) => new THREE.BoxGeometry(w, 0.025, 0.025);
  const zzz = mergeGeometries([
    bar(0.12).translate(0, 0.06, 0),
    bar(0.12).translate(0, -0.06, 0),
    bar(0.16).rotateZ(-Math.PI / 4.3).translate(0, 0, 0),
  ]);
  return {
    body: new THREE.CapsuleGeometry(0.255, 0.34, n(6, 3), n(16, 10)).translate(0, 0.43, 0),
    pants: new THREE.CylinderGeometry(0.262, 0.27, 0.22, n(16, 10)).translate(0, 0.13, 0),
    strap: new THREE.TorusGeometry(0.258, 0.026, n(6, 3), n(24, 10)).rotateX(Math.PI / 2).translate(0, EYE_Y, 0),
    rims: goggles(() => new THREE.CylinderGeometry(0.078, 0.078, 0.07, n(14, 7)), 0.22, true),
    lenses: goggles(() => new THREE.SphereGeometry(0.062, n(12, 6), n(8, 4)), 0.245, false),
    pupils: goggles(() => new THREE.SphereGeometry(0.026, n(8, 4), n(6, 3)), 0.3, false),
    mouth: new THREE.TorusGeometry(0.045, 0.011, n(5, 3), n(12, 5), Math.PI).rotateZ(Math.PI).translate(0, 0.47, 0.25),
    armL: arm,
    armR: arm.clone(),
    legL: leg,
    legR: leg.clone(),
    beanie,
    cap,
    mug: new THREE.CylinderGeometry(0.042, 0.038, 0.09, n(12, 6)),
    exclaim,
    zzz,
  };
}

const COLORS: Partial<Record<PartKey, number>> = {
  pants: 0x3a4d7a,
  strap: 0x2b2f3a,
  rims: 0xc3cad6,
  lenses: 0xffffff,
  pupils: INK,
  mouth: INK,
  legL: 0x3a4d7a,
  legR: 0x3a4d7a,
  mug: 0xffffff,
  exclaim: 0xffc233,
  zzz: 0xe3e6ff,
};
const TINTED: PartKey[] = ['body', 'armL', 'armR'];
const CUED: PartKey[] = ['beanie', 'cap'];
const NO_SHADOW: PartKey[] = ['pupils', 'mouth', 'lenses', 'zzz', 'exclaim'];

export class Crowd {
  readonly group = new THREE.Group();
  private readonly parts: Part[];
  private readonly byKey: Record<PartKey, Part>;
  private readonly members: Array<Member | null>;
  private readonly m = new THREE.Matrix4();
  private readonly base = new THREE.Matrix4();
  private readonly body = new THREE.Matrix4();
  private readonly tmp = new THREE.Matrix4();
  private readonly tmp2 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly color = new THREE.Color();

  constructor(
    readonly capacity: number,
    shadows: boolean,
    low = false,
  ) {
    const geo = geometries(low);
    this.parts = (Object.keys(geo) as PartKey[]).map((key) => {
      const per = key === 'zzz' ? 2 : 1;
      const tinted = TINTED.includes(key) || CUED.includes(key);
      const mat = new THREE.MeshToonMaterial({ color: tinted ? 0xffffff : (COLORS[key] ?? 0xffffff) });
      if (key === 'exclaim' || key === 'zzz') mat.emissive.set(COLORS[key] ?? 0xffffff).multiplyScalar(0.35);
      const mesh = new THREE.InstancedMesh(geo[key], mat, Math.max(1, capacity * per));
      mesh.name = `crowd.${key}`;
      mesh.frustumCulled = false;
      mesh.castShadow = shadows && !NO_SHADOW.includes(key);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      for (let i = 0; i < mesh.count; i++) mesh.setMatrixAt(i, ZERO);
      if (tinted) for (let i = 0; i < mesh.count; i++) mesh.setColorAt(i, this.color.set(0xffffff));
      this.group.add(mesh);
      return { key, mesh, per };
    });
    this.byKey = Object.fromEntries(this.parts.map((p) => [p.key, p])) as Record<PartKey, Part>;
    this.members = Array.from({ length: capacity }, () => null);
  }

  get(i: number): Member | null {
    return this.members[i] ?? null;
  }

  set(i: number, m: Member | null): void {
    if (i < 0 || i >= this.capacity) return;
    this.members[i] = m;
    if (!m) {
      for (const p of this.parts) for (let k = 0; k < p.per; k++) p.mesh.setMatrixAt(i * p.per + k, ZERO);
      this.flag(true, false);
      return;
    }
    this.color.set(m.tint);
    for (const key of TINTED) this.byKey[key].mesh.setColorAt(i, this.color);
    this.color.set(m.cue.color);
    for (const key of CUED) this.byKey[key].mesh.setColorAt(i, this.color);
    this.flag(false, true);
  }

  private flag(matrices: boolean, colors: boolean): void {
    for (const p of this.parts) {
      if (matrices) p.mesh.instanceMatrix.needsUpdate = true;
      if (colors && p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true;
    }
  }

  private put(key: PartKey, i: number, parent: THREE.Matrix4, local: THREE.Matrix4 | null, k = 0): void {
    const p = this.byKey[key];
    if (local) p.mesh.setMatrixAt(i * p.per + k, this.m.multiplyMatrices(parent, local));
    else p.mesh.setMatrixAt(i * p.per + k, parent);
  }

  private hide(key: PartKey, i: number): void {
    const p = this.byKey[key];
    for (let k = 0; k < p.per; k++) p.mesh.setMatrixAt(i * p.per + k, ZERO);
  }

  private rot(x: number, y: number, z: number, px = 0, py = 0, pz = 0): THREE.Matrix4 {
    this.q.setFromEuler(this.e.set(x, y, z));
    return this.tmp.compose(this.v.set(px, py, pz), this.q, this.s.set(1, 1, 1));
  }

  /** Recomputes every member's pose for time `t` (seconds). */
  update(t: number): void {
    for (let i = 0; i < this.capacity; i++) {
      const m = this.members[i];
      if (m) this.pose(i, m, t);
    }
    this.flag(true, false);
  }

  private pose(i: number, m: Member, t: number): void {
    const ph = m.phase;
    this.q.setFromAxisAngle(this.v.set(0, 1, 0), m.yaw);
    this.base.compose(this.v.set(m.x, m.y, m.z), this.q, this.s.set(m.scale, m.scale, m.scale));

    let bob = 0;
    let lean = 0;
    let armL = -0.2;
    let armR = -0.2;
    let armLz = 0.18;
    let armRz = -0.18;
    let lookX = Math.sin(t * 0.7 + ph) * 0.012;
    let lookY = 0;
    let mug = false;
    let wave = 0;
    switch (m.display) {
      case 'working': {
        bob = Math.abs(Math.sin(t * 7 + ph)) * 0.012;
        lean = 0.1;
        armL = -1.2 + Math.sin(t * 17 + ph) * 0.16;
        armR = -1.2 + Math.sin(t * 17 + ph + 1.9) * 0.16;
        armLz = armRz = 0;
        lookY = -0.012;
        lookX = Math.sin(t * 1.3 + ph) * 0.01;
        break;
      }
      case 'idle':
      case 'done': {
        lean = -0.2;
        mug = true;
        // Sip every few seconds.
        const c = (t * 0.45 + ph) % (Math.PI * 2);
        const sip = c < 1.2 ? Math.sin((c / 1.2) * Math.PI) : 0;
        armR = -0.9 - sip * 1.1;
        armRz = -0.1;
        armL = -0.15;
        bob = Math.sin(t * 1.4 + ph) * 0.006;
        break;
      }
      case 'needs_you': {
        bob = Math.abs(Math.sin(t * 5 + ph)) * 0.035;
        armR = -2.85;
        armRz = 0;
        wave = Math.sin(t * 7 + ph) * 0.35;
        armL = -0.3;
        lookY = 0.012;
        break;
      }
      case 'asleep': {
        lean = 0.5 + Math.sin(t * 0.9 + ph) * 0.02;
        bob = -0.03;
        armL = armR = -1.35;
        armLz = 0.25;
        armRz = -0.25;
        lookY = -0.02;
        break;
      }
    }

    // Upper body pivots at the seat.
    this.body.multiplyMatrices(this.base, this.rot(lean, 0, 0, 0, bob, 0));
    this.put('body', i, this.body, null);
    this.put('pants', i, this.body, null);
    this.put('strap', i, this.body, null);
    this.put('rims', i, this.body, null);
    this.put('lenses', i, this.body, null);
    this.put('mouth', i, this.body, null);
    this.put('pupils', i, this.body, this.rot(0, 0, 0, lookX, lookY, 0));
    if (m.cue.hat === 'beanie') this.put('beanie', i, this.body, null);
    else this.hide('beanie', i);
    if (m.cue.hat === 'cap') this.put('cap', i, this.body, null);
    else this.hide('cap', i);

    this.put('armL', i, this.body, this.rot(armL, 0, armLz, -SHOULDER_X, SHOULDER_Y, 0.03));
    const armRM = this.rot(armR, 0, armRz + wave, SHOULDER_X, SHOULDER_Y, 0.03);
    this.put('armR', i, this.body, armRM);
    if (mug) {
      // Hand = end of the right arm; the mug stays upright.
      this.v.set(0, -0.29, 0.02).applyMatrix4(armRM);
      this.tmp2.makeTranslation(this.v.x, this.v.y + 0.03, this.v.z + 0.03);
      this.put('mug', i, this.body, this.tmp2);
    } else this.hide('mug', i);

    const legSwing = m.display === 'asleep' ? 0 : Math.sin(t * 2.2 + ph) * 0.12;
    this.put('legL', i, this.base, this.rot(-1.35 + legSwing, 0, 0.05, -HIP.x, HIP.y, HIP.z));
    this.put('legR', i, this.base, this.rot(-1.35 - legSwing, 0, -0.05, HIP.x, HIP.y, HIP.z));

    if (m.display === 'done') {
      const b = Math.abs(Math.sin(t * 3 + ph)) * 0.06;
      this.put('exclaim', i, this.base, this.rot(0, Math.sin(t * 1.5) * 0.4, 0, 0, 1.2 + b, 0));
    } else this.hide('exclaim', i);

    if (m.display === 'asleep') {
      for (let k = 0; k < 2; k++) {
        const c = (t * 0.35 + ph / 6.283 + k * 0.5) % 1;
        const sc = 0.6 + c * 0.9;
        this.q.setFromEuler(this.e.set(0, 0, Math.sin(t + k) * 0.2));
        this.tmp2.compose(this.v.set(0.12 + c * 0.25, 0.95 + c * 0.55, 0.1), this.q, this.s.set(sc, sc, sc));
        this.put('zzz', i, this.base, this.tmp2, k);
      }
    } else this.hide('zzz', i);
  }

  dispose(): void {
    for (const p of this.parts) {
      p.mesh.geometry.dispose();
      (p.mesh.material as THREE.Material).dispose();
      p.mesh.dispose();
    }
  }
}
