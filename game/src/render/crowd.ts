import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Display, ModelCue } from '../world/derive';
import { INK } from './palette';
// M6: write-code crews' looks.
import { CREW_PARTS, crewGeometries, DESK_ITEM, DESK_TOP, FLOOR_Y, PIP_OFF, PIP_OVER, WORN, type CrewLook, type CrewPartKey } from './crewLook';
import { PASS_CAP } from '../world/crew';
import { crewSpot } from '../world/deskKit';

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
  /** M4: standing, legs swinging with this stride phase (radians; constant = standing still). Absent: seated. */
  stride?: number;
  /** M4: both arms forward, holding a box. */
  carry?: boolean;
  /** M6: a write-code crew member's role look and lifecycle props. */
  crew?: CrewLook;
  /** M6: waving goodbye (a freelancer leaving). */
  wave?: boolean;
  /** M6: its briefcase in the left hand (a freelancer walking out). */
  briefcase?: boolean;
  /** M6b: squash and stretch (height factor; the width keeps the volume), dropping in to its chair. */
  squash?: number;
  /** M6b: its desk's dock side (`world/deskKit.ts`): a crew member's desk things go on that desk's free corners. */
  deskSide?: 1 | -1;
}

interface CrewPart {
  mesh: THREE.InstancedMesh;
  per: number;
  /** Someone wears it this frame (else the mesh is hidden: no draw call). */
  used: boolean;
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
  /** M6: the crew parts (see crewLook.ts). */
  private readonly crewParts: Record<CrewPartKey, CrewPart>;
  private readonly armLM = new THREE.Matrix4();
  private readonly armRM = new THREE.Matrix4();
  /** M6: members with crew parts drawn (the others skip them every frame). */
  private readonly crewOn: boolean[];
  private readonly tmp3 = new THREE.Matrix4();

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
    const crewGeo = crewGeometries(low);
    const crewParts: Partial<Record<CrewPartKey, CrewPart>> = {};
    for (const d of CREW_PARTS) {
      const mat = new THREE.MeshToonMaterial({ color: 0xffffff, vertexColors: !d.tinted });
      if (d.emissive !== undefined) mat.emissive.set(d.emissive);
      const mesh = new THREE.InstancedMesh(crewGeo[d.key], mat, Math.max(1, capacity * d.per));
      mesh.name = `crowd.${d.key}`;
      mesh.frustumCulled = false;
      mesh.castShadow = shadows && d.shadow;
      mesh.visible = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      for (let i = 0; i < mesh.count; i++) mesh.setMatrixAt(i, ZERO);
      if (d.tinted) for (let i = 0; i < mesh.count; i++) mesh.setColorAt(i, this.color.set(0xffffff));
      this.group.add(mesh);
      crewParts[d.key] = { mesh, per: d.per, used: false };
    }
    this.crewParts = crewParts as Record<CrewPartKey, CrewPart>;
    this.crewOn = Array.from({ length: capacity }, () => false);
  }

  /** M6: the crew parts drawn for member `i` (test hook). */
  crewAt(i: number): CrewPartKey[] {
    const out: CrewPartKey[] = [];
    for (const [key, p] of Object.entries(this.crewParts) as Array<[CrewPartKey, CrewPart]>) {
      for (let k = 0; k < p.per; k++) {
        p.mesh.getMatrixAt(i * p.per + k, this.tmp3);
        if (Math.abs(this.tmp3.determinant()) > 1e-9) {
          out.push(key);
          break;
        }
      }
    }
    return out;
  }

  /** M6: crew parts drawn right now (test hook / frame budget). */
  crewShown(): CrewPartKey[] {
    return (Object.keys(this.crewParts) as CrewPartKey[]).filter((k) => this.crewParts[k].mesh.visible);
  }

  get(i: number): Member | null {
    return this.members[i] ?? null;
  }

  set(i: number, m: Member | null): void {
    if (i < 0 || i >= this.capacity) return;
    this.members[i] = m;
    if (!m) {
      for (const p of this.parts) for (let k = 0; k < p.per; k++) p.mesh.setMatrixAt(i * p.per + k, ZERO);
      for (const p of Object.values(this.crewParts)) for (let k = 0; k < p.per; k++) p.mesh.setMatrixAt(i * p.per + k, ZERO);
      this.crewOn[i] = false;
      this.flag(true, false);
      return;
    }
    this.color.set(m.tint);
    for (const key of TINTED) this.byKey[key].mesh.setColorAt(i, this.color);
    this.color.set(m.cue.color);
    for (const key of CUED) this.byKey[key].mesh.setColorAt(i, this.color);
    if (m.crew) this.crewColors(i, m.crew);
    this.flag(false, true);
  }

  /** M6: the run badge, the folder's stamp and the pass pips take their colours per member. */
  private crewColors(i: number, c: CrewLook): void {
    const P = this.crewParts;
    P.badge.mesh.setColorAt(i, this.color.set(c.run ?? 0xffffff));
    P.stamp.mesh.setColorAt(i, this.color.set(c.stamp ?? 0xffffff));
    const lit = Math.min(PASS_CAP, c.pass ?? 0);
    for (let k = 0; k < 3; k++) P.pips.mesh.setColorAt(i * 3 + k, this.color.set(c.overCap ? PIP_OVER : k < lit ? c.phaseColor : PIP_OFF));
    for (const key of ['badge', 'stamp', 'pips'] as const) {
      const col = P[key].mesh.instanceColor;
      if (col) col.needsUpdate = true;
    }
  }

  private flag(matrices: boolean, colors: boolean): void {
    for (const p of this.parts) {
      if (matrices) p.mesh.instanceMatrix.needsUpdate = true;
      if (colors && p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true;
    }
    if (matrices) for (const p of Object.values(this.crewParts)) if (p.mesh.visible) p.mesh.instanceMatrix.needsUpdate = true;
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
    for (const p of Object.values(this.crewParts)) p.used = false;
    for (let i = 0; i < this.capacity; i++) {
      const m = this.members[i];
      if (m) this.pose(i, m, t);
    }
    // M6: a crew part nobody wears is not drawn at all.
    for (const p of Object.values(this.crewParts)) p.mesh.visible = p.used;
    this.flag(true, false);
  }

  private pose(i: number, m: Member, t: number): void {
    const ph = m.phase;
    this.q.setFromAxisAngle(this.v.set(0, 1, 0), m.yaw);
    const sq = m.squash ?? 1;
    const wide = m.scale / Math.sqrt(sq);
    this.base.compose(this.v.set(m.x, m.y, m.z), this.q, this.s.set(wide, m.scale * sq, wide));

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
      case 'done':
      // #98: waiting on its background tasks, it leans back with its coffee too (the monitor says what it waits on).
      case 'waiting': {
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

    // M6: the crew's lifecycle poses (reading the brief, handing in the report) and waving goodbye.
    const crew = m.crew;
    const life = crew && m.display !== 'needs_you' && m.display !== 'asleep' && m.stride === undefined ? crew.life : null;
    let turn = 0;
    if (life === 'onboarding') {
      lean = 0.06;
      armL = armR = -1.05;
      armLz = 0.42;
      armRz = -0.42;
      lookY = -0.016;
      mug = false;
    } else if (life === 'reporting') {
      turn = crew?.turn ?? 0;
      lean = 0.04;
      armR = -1.45 + Math.sin(t * 2.2 + ph) * 0.05;
      armRz = 0.12;
      armL = -0.2;
      mug = false;
    }
    if (m.wave) {
      armR = -2.75;
      armRz = 0;
      wave = Math.sin(t * 9 + ph) * 0.55;
      mug = false;
    }
    if (m.briefcase) {
      lean = 0;
      mug = false;
      armL = -0.06;
      armLz = 0.12;
      // The free arm swings with the stride (a wave keeps it up).
      if (!m.wave) {
        armR = -0.15 + Math.sin(m.stride ?? 0) * 0.35;
        armRz = -0.12;
      }
    }
    if (turn) {
      this.q.setFromAxisAngle(this.v.set(0, 1, 0), m.yaw + turn);
      this.base.compose(this.v.set(m.x, m.y, m.z), this.q, this.s.set(wide, m.scale * sq, wide));
    }

    if (m.carry) {
      lean = 0;
      armL = armR = -1.3;
      armLz = 0.1;
      armRz = -0.1;
      wave = 0;
      mug = false;
    }
    const walking = m.stride !== undefined;
    if (walking) bob = Math.abs(Math.sin(m.stride ?? 0)) * 0.03;

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

    const armLM = this.armLM.copy(this.rot(armL, 0, armLz, -SHOULDER_X, SHOULDER_Y, 0.03));
    this.put('armL', i, this.body, armLM);
    const armRM = this.armRM.copy(this.rot(armR, 0, armRz + wave, SHOULDER_X, SHOULDER_Y, 0.03));
    this.put('armR', i, this.body, armRM);
    if (mug) {
      // Hand = end of the right arm; the mug stays upright.
      this.v.set(0, -0.29, 0.02).applyMatrix4(armRM);
      this.tmp2.makeTranslation(this.v.x, this.v.y + 0.03, this.v.z + 0.03);
      this.put('mug', i, this.body, this.tmp2);
    } else this.hide('mug', i);

    if (walking) {
      // Standing: legs straight down from the hips, swinging with the stride.
      const swing = Math.sin(m.stride ?? 0) * 0.55;
      this.put('legL', i, this.base, this.rot(swing, 0, 0.03, -HIP.x, HIP.y, 0));
      this.put('legR', i, this.base, this.rot(-swing, 0, -0.03, HIP.x, HIP.y, 0));
    } else {
      const legSwing = m.display === 'asleep' ? 0 : Math.sin(t * 2.2 + ph) * 0.12;
      this.put('legL', i, this.base, this.rot(-1.35 + legSwing, 0, 0.05, -HIP.x, HIP.y, HIP.z));
      this.put('legR', i, this.base, this.rot(-1.35 - legSwing, 0, -0.05, HIP.x, HIP.y, HIP.z));
    }

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

    this.poseCrew(i, m, t, life, armLM, armRM);
  }

  private crewPut(key: CrewPartKey, i: number, parent: THREE.Matrix4, local: THREE.Matrix4 | null, k = 0): void {
    const p = this.crewParts[key];
    p.used = true;
    p.mesh.setMatrixAt(i * p.per + k, local ? this.m.multiplyMatrices(parent, local) : parent);
  }

  private crewHide(key: CrewPartKey, i: number): void {
    const p = this.crewParts[key];
    for (let k = 0; k < p.per; k++) p.mesh.setMatrixAt(i * p.per + k, ZERO);
  }

  /** M6: what a crew member wears, has on its desk and holds (see crewLook.ts). */
  private poseCrew(i: number, m: Member, t: number, life: CrewLook['life'], armLM: THREE.Matrix4, armRM: THREE.Matrix4): void {
    const c = m.crew;
    // Not a crew member and nothing of it drawn: nothing to do (most workers, every frame).
    const any = !!c || !!m.briefcase;
    if (!any && !this.crewOn[i]) return;
    this.crewOn[i] = any;
    const seated = m.stride === undefined;
    const ph = m.phase;
    const worn = c ? WORN[c.role] : null;
    const desk = c && seated ? (DESK_ITEM[c.role] ?? null) : null;
    for (const key of ['headset', 'hood', 'bowtie', 'scarf', 'backpack'] as const) {
      if (key === worn) this.crewPut(key, i, this.body, null);
      else this.crewHide(key, i);
    }
    if (c?.run != null) this.crewPut('badge', i, this.body, null);
    else this.crewHide('badge', i);
    // Desk items sit on the desk top in front of the dock (M6b: where the others keep a notebook); the pass board at the other front corner.
    const side = m.deskSide ?? 1;
    const item = crewSpot('item', side);
    for (const key of ['clipboard', 'tablet', 'magnifier'] as const) {
      if (key === desk) this.crewPut(key, i, this.base, this.tmp2.makeTranslation(item.x, DESK_TOP, item.z));
      else this.crewHide(key, i);
    }
    if (c && seated && c.role === 'orch' && c.pass !== null) {
      const board = crewSpot('passBoard', side);
      this.crewPut('passBoard', i, this.base, this.tmp2.makeTranslation(board.x, DESK_TOP, board.z));
      const blink = c.overCap && Math.sin(t * 6 + ph) < -0.2;
      for (let k = 0; k < 3; k++) {
        this.tmp2.makeTranslation(board.x + (k - 1) * 0.08, DESK_TOP + 0.125, board.z - 0.03);
        if (blink) this.tmp2.scale(this.s.set(0.001, 0.001, 0.001));
        this.crewPut('pips', i, this.base, this.tmp2, k);
      }
    } else {
      this.crewHide('passBoard', i);
      this.crewHide('pips', i);
    }
    // Onboarding: the brief held open in both hands, in front of the chest.
    if (life === 'onboarding') this.crewPut('scroll', i, this.body, this.rot(-0.5, 0, 0, 0, 0.3, 0.42));
    else this.crewHide('scroll', i);
    // Reporting: the folder at the end of the outstretched right arm, its stamp on it.
    if (life === 'reporting') {
      this.v.set(0, -0.3, 0.02).applyMatrix4(armRM);
      this.q.setFromEuler(this.e.set(-0.35, 0, 0));
      this.tmp2.compose(this.v.setComponent(1, this.v.y + 0.12), this.q, this.s.set(1, 1, 1));
      this.crewPut('folder', i, this.body, this.tmp2);
      if (c?.stamp != null) this.crewPut('stamp', i, this.body, this.tmp2);
      else this.crewHide('stamp', i);
    } else {
      this.crewHide('folder', i);
      this.crewHide('stamp', i);
    }
    // The briefcase: in the left hand walking, else by the chair (freelancers).
    if (m.briefcase) {
      this.v.set(0, -0.3, 0.02).applyMatrix4(armLM);
      this.tmp2.makeTranslation(this.v.x, this.v.y, this.v.z);
      this.crewPut('briefcase', i, this.body, this.tmp2);
    } else if (c && c.role !== 'orch' && seated) {
      this.q.setFromEuler(this.e.set(0, 0.3, 0));
      this.tmp2.compose(this.v.set(-0.42, FLOOR_Y + 0.29, 0.08), this.q, this.s.set(1, 1, 1));
      this.crewPut('briefcase', i, this.base, this.tmp2);
    } else this.crewHide('briefcase', i);
    // Over the cap: sweat runs down its brow, a red alarm clock rings over its desk.
    if (c?.overCap && m.display !== 'asleep') {
      for (let k = 0; k < 2; k++) {
        const u = (t * 0.8 + ph / 6.283 + k * 0.5) % 1;
        const sc = u < 0.8 ? 1 : Math.max(0.001, 1 - (u - 0.8) * 5);
        this.tmp2.compose(this.v.set((k ? 1 : -1) * 0.2, 0.7 - u * 0.24, 0.17), this.q.identity(), this.s.set(sc, sc, sc));
        this.crewPut('sweat', i, this.body, this.tmp2, k);
      }
      const ring = Math.sin(t * 38) * 0.12;
      const hop = Math.abs(Math.sin(t * 19)) * 0.025;
      this.q.setFromEuler(this.e.set(0, Math.sin(t * 0.9 + ph) * 0.5, ring));
      // Beside its head over the desk's corner (the card sits right over its head).
      this.tmp2.compose(this.v.set(-0.46, 0.98 + hop, 0.32), this.q, this.s.set(1, 1, 1));
      this.crewPut('clock', i, this.base, this.tmp2);
      // The hands spin: the clock is past time.
      this.tmp.makeRotationZ(-t * 4);
      this.tmp.setPosition(0, 0, 0.045);
      this.crewPut('clockHands', i, this.tmp3.multiplyMatrices(this.base, this.tmp2), this.tmp);
    } else {
      this.crewHide('sweat', i);
      this.crewHide('clock', i);
      this.crewHide('clockHands', i);
    }
  }

  dispose(): void {
    for (const p of this.parts) {
      p.mesh.geometry.dispose();
      (p.mesh.material as THREE.Material).dispose();
      p.mesh.dispose();
    }
  }
}
