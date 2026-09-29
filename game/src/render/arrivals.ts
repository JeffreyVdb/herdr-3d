import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { deskOwners, poseAt, timeline, type ArrivalKind, type ArrivalPose, type Carry, type DeskShow, type Timeline } from '../world/arrival';
import type { CrewLook } from './crewLook';
import type { Display, ModelCue } from '../world/derive';
import { DESK_H, SEAT_OFFSET } from '../world/layout';
import type { Waypoint } from '../world/route';
import { Crowd } from './crowd';
import type { AwaySeat } from './office';
import { OFFICE } from './palette';

/**
 * M4: workers walking in (a fresh hire, carrying its box with the laptop on
 * top) and out (sent home: packs a cardboard box at the desk, takes the
 * laptop, walks the fire escape down and away along the sidewalk). The
 * timeline is `world/arrival.ts`; this draws it: a small crowd of standing
 * workers, and a box, its three keepsakes and a closed laptop per walker —
 * one InstancedMesh per prop part (instance = the walker's crowd slot), like
 * the crowd's own parts. Everything is in absolute building coordinates
 * (y = feet above the street); the app shifts `group` down by the walk
 * scene's base.
 */

export interface ArrivalSpec {
  id: string;
  kind: ArrivalKind;
  session: string;
  desk: number;
  name: string;
  /** The walk-out route (`out`) or walk-in route (`in`). */
  route: Waypoint[];
  seatYaw: number;
  tint: number;
  cue: ModelCue;
  /** The status the worker had (the laptop screen while packing). */
  display: Display;
  phase: number;
  /** M6: a freelancer carries its briefcase (and waves goodbye) instead of the box. */
  carry?: Carry;
  /** M6: its crew look (worn by the walker). */
  crew?: CrewLook;
}

interface Active {
  spec: ArrivalSpec;
  tl: Timeline;
  t0: number;
  slot: number;
  last: ArrivalPose | null;
}

/** What the arrivals ask of the office: a desk shown as `away` (null: as the world says again). */
export interface DeskAway {
  session: string;
  desk: number;
  away: AwaySeat | null;
}

/** Test hook view of one walker. */
export interface ArrivalInfo {
  id: string;
  kind: ArrivalKind;
  session: string;
  desk: number;
  name: string;
  phase: ArrivalPose['phase'];
  t: number;
  total: number;
  x: number;
  y: number;
  z: number;
  walked: number;
  length: number;
  desk_show: DeskShow;
  box: ArrivalPose['box'];
  laptop: ArrivalPose['laptop'];
  items: number;
  /** M6 */
  carry: Carry;
  briefcase: ArrivalPose['briefcase'];
  wave: boolean;
}

const CAPACITY = 8;
const BOX = { w: 0.44, h: 0.28, d: 0.32 };
/** The carried box, in worker space (origin at the seat/hips, facing +z). */
const CARRY = new THREE.Vector3(0, 0.36, 0.34);
/** The desk's laptop hinge sits a little towards the seat from the desk centre (desks.ts). */
const LAPTOP_BACK = 0.14;
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

/** The props' parts: one InstancedMesh each. `box` parts sit in the box's space, `item` ones too (keepsake `item`), `laptop` ones in the laptop's. */
type PropKey = 'body' | 'flaps' | 'tape' | 'mug' | 'pot' | 'leaves' | 'frame' | 'lapBase' | 'lapLid' | 'sticker';
const PROPS: Array<{ key: PropKey; on: 'box' | 'item' | 'laptop'; item?: number; at?: [number, number, number] }> = [
  { key: 'body', on: 'box' },
  { key: 'flaps', on: 'box' },
  { key: 'tape', on: 'box' },
  // The keepsakes poke out of the top: a mug, a little plant, a framed photo.
  { key: 'mug', on: 'item', item: 0, at: [-0.12, BOX.h - 0.05, 0.04] },
  { key: 'pot', on: 'item', item: 1, at: [0.12, BOX.h - 0.05, -0.03] },
  { key: 'leaves', on: 'item', item: 1, at: [0.12, BOX.h - 0.05, -0.03] },
  { key: 'frame', on: 'item', item: 2, at: [0.02, BOX.h - 0.04, -0.08] },
  { key: 'lapBase', on: 'laptop' },
  { key: 'lapLid', on: 'laptop' },
  // The sticker on the lid, in the worker's model colour.
  { key: 'sticker', on: 'laptop' },
];

function boxGeometry(): { body: THREE.BufferGeometry; flaps: THREE.BufferGeometry; tape: THREE.BufferGeometry } {
  const { w, h, d } = BOX;
  const body = new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0);
  // Two long flaps folded open, like a box being packed.
  const flap = (s: number) => new THREE.BoxGeometry(w * 0.96, 0.008, d / 2).translate(0, 0, s * (d / 4)).rotateX(s * 0.9).translate(0, h, s * (d / 2));
  const flaps = mergeGeometries([flap(1), flap(-1)]);
  // Parcel tape round the middle, and a hand hole on each end.
  const tape = mergeGeometries([
    new THREE.BoxGeometry(w + 0.004, 0.05, d + 0.004).translate(0, h * 0.55, 0),
    new THREE.BoxGeometry(0.1, 0.035, 0.01).translate(0, h * 0.72, d / 2 + 0.003),
    new THREE.BoxGeometry(0.1, 0.035, 0.01).translate(0, h * 0.72, -d / 2 - 0.003),
  ]);
  return { body, flaps, tape };
}

export class Arrivals {
  readonly group = new THREE.Group();
  private readonly crowd: Crowd;
  /** The props' InstancedMeshes (only shown while someone walks). */
  private readonly props = new THREE.Group();
  private readonly parts: Record<PropKey, THREE.InstancedMesh>;
  /** Walks in the order they started, oldest first. */
  private readonly active: Active[] = [];
  private readonly free: number[] = Array.from({ length: CAPACITY }, (_, i) => CAPACITY - 1 - i);
  /** Finished (or skipped) arrivals, newest last (test hook). */
  readonly log: Array<{ id: string; kind: ArrivalKind; played: boolean; session: string; desk: number }> = [];
  /** Desks the office should show as the world says again (arrivals that just ended). */
  private released: DeskAway[] = [];
  private readonly local: Partial<Record<PropKey, THREE.Matrix4>> = {};
  private readonly boxM = new THREE.Matrix4();
  private readonly lapM = new THREE.Matrix4();
  private readonly m = new THREE.Matrix4();
  private readonly v = new THREE.Vector3();
  private readonly w = new THREE.Vector3();
  private readonly pos = new THREE.Vector3();
  private readonly scl = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly boxQ = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly color = new THREE.Color();
  private rate = 1;

  constructor(shadows: boolean) {
    this.group.name = 'arrivals';
    this.crowd = new Crowd(CAPACITY, shadows);
    this.props.name = 'arrivals.props';
    this.group.add(this.crowd.group, this.props);
    const b = boxGeometry();
    const geo: Record<PropKey, THREE.BufferGeometry> = {
      ...b,
      mug: new THREE.CylinderGeometry(0.045, 0.04, 0.1, 12).translate(0, 0.05, 0),
      pot: new THREE.CylinderGeometry(0.05, 0.04, 0.08, 10).translate(0, 0.04, 0),
      leaves: new THREE.IcosahedronGeometry(0.075, 0).translate(0, 0.13, 0),
      frame: new THREE.BoxGeometry(0.14, 0.11, 0.015).rotateX(-0.25).translate(0, 0.06, 0),
      lapBase: new THREE.BoxGeometry(0.34, 0.018, 0.24),
      lapLid: new THREE.BoxGeometry(0.34, 0.012, 0.24).translate(0, 0.016, 0),
      sticker: new THREE.CylinderGeometry(0.035, 0.035, 0.004, 14).translate(0.07, 0.024, 0.03),
    };
    const colors: Record<PropKey, number> = {
      body: 0xc9935a,
      flaps: 0xd9a86e,
      tape: 0xa87440,
      mug: 0xffffff,
      pot: OFFICE.pot,
      leaves: OFFICE.plant,
      frame: 0xffc233,
      lapBase: OFFICE.laptop,
      lapLid: OFFICE.laptop,
      sticker: 0xffffff,
    };
    const parts: Partial<Record<PropKey, THREE.InstancedMesh>> = {};
    for (const p of PROPS) {
      const mesh = new THREE.InstancedMesh(geo[p.key], new THREE.MeshToonMaterial({ color: colors[p.key] }), CAPACITY);
      mesh.name = `arrivals.${p.key}`;
      mesh.frustumCulled = false;
      mesh.castShadow = shadows && p.key !== 'sticker';
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      for (let i = 0; i < CAPACITY; i++) mesh.setMatrixAt(i, ZERO);
      if (p.key === 'sticker') for (let i = 0; i < CAPACITY; i++) mesh.setColorAt(i, this.color.set(0xffffff));
      if (p.at) this.local[p.key] = new THREE.Matrix4().makeTranslation(...p.at);
      this.props.add(mesh);
      parts[p.key] = mesh;
    }
    this.parts = parts as Record<PropKey, THREE.InstancedMesh>;
    this.showIfWalking();
  }

  /** Test hook: plays every walk `k` times as fast (1 = real time), from where each one is now (s). */
  setRate(k: number, now: number): void {
    const next = Math.max(0.01, k);
    for (const a of this.active) a.t0 = now - ((now - a.t0) * this.rate) / next;
    this.rate = next;
  }

  get count(): number {
    return this.active.length;
  }

  has(id: string): boolean {
    return this.active.some((a) => a.spec.id === id);
  }

  /** Starts a walk at time `now` (s); false when it cannot be shown (no route, too many at once). */
  start(spec: ArrivalSpec, now: number): boolean {
    this.cancel(spec.id);
    const slot = this.free.pop();
    if (slot === undefined || spec.route.length < 2) {
      if (slot !== undefined) this.free.push(slot);
      this.skip(spec);
      return false;
    }
    const tl = timeline(spec.kind, spec.route, spec.seatYaw, spec.carry ?? 'box');
    const sticker = this.parts.sticker;
    sticker.setColorAt(slot, this.color.set(spec.cue.color));
    if (sticker.instanceColor) sticker.instanceColor.needsUpdate = true;
    this.active.push({ spec, tl, t0: now, slot, last: null });
    this.showIfWalking();
    return true;
  }

  /** Records an arrival nobody sees (another building, the city): it resolves at once. */
  skip(spec: Pick<ArrivalSpec, 'id' | 'kind' | 'session' | 'desk'>): void {
    this.log.push({ id: spec.id, kind: spec.kind, played: false, session: spec.session, desk: spec.desk });
    if (this.log.length > 50) this.log.shift();
  }

  /** Ends a walk early (the worker is gone, or came back); its desk shows as the world says. */
  cancel(id: string): void {
    const i = this.active.findIndex((a) => a.spec.id === id);
    if (i < 0) return;
    this.finish(i, false);
  }

  /** Ends every walk (you left the building or the view). */
  clear(): void {
    while (this.active.length) this.finish(this.active.length - 1, false);
  }

  private finish(i: number, played: boolean): void {
    const a = this.active[i] as Active;
    this.active.splice(i, 1);
    this.crowd.set(a.slot, null);
    this.free.push(a.slot);
    for (const p of PROPS) this.parts[p.key].setMatrixAt(a.slot, ZERO);
    this.flag();
    this.showIfWalking();
    this.released.push({ session: a.spec.session, desk: a.spec.desk, away: null });
    this.log.push({ id: a.spec.id, kind: a.spec.kind, played, session: a.spec.session, desk: a.spec.desk });
    if (this.log.length > 50) this.log.shift();
  }

  /** Nobody walking: no draw calls for the props and the crowd. */
  private showIfWalking(): void {
    this.group.visible = this.active.length > 0;
  }

  private flag(): void {
    for (const p of PROPS) this.parts[p.key].instanceMatrix.needsUpdate = true;
  }

  /**
   * Advances every walk to time `now` (s) and draws it; returns what each
   * desk with a walk (or a walk that just ended) should show, one entry per
   * desk: the newest walk on a desk owns it (`deskOwners`).
   */
  update(now: number, t: number): DeskAway[] {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const a = this.active[i] as Active;
      if ((now - a.t0) * this.rate >= a.tl.total) this.finish(i, true);
    }
    const ended = this.released;
    this.released = [];
    const walking: DeskAway[] = [];
    for (const a of this.active) {
      const p = poseAt(a.tl, (now - a.t0) * this.rate);
      a.last = p;
      this.draw(a, p);
      const s = a.spec;
      walking.push({ session: s.session, desk: s.desk, away: p.desk === 'free' ? null : { show: p.desk, display: s.display, cue: s.cue.color } });
    }
    if (this.active.length) this.flag();
    this.crowd.update(t);
    return deskOwners(ended, walking);
  }

  /** Where the desk's laptop sits, in absolute coordinates (y: its base). */
  private deskPoint(a: Active, along: number, side: number, y: number, out: THREE.Vector3): THREE.Vector3 {
    const seat = a.spec.kind === 'out' ? a.tl.route[0] : a.tl.route[a.tl.route.length - 1];
    const yaw = a.spec.seatYaw;
    const sx = seat?.x ?? 0;
    const sz = seat?.z ?? 0;
    // Forward (+z in slot space) and the desk's own x axis.
    return out.set(sx + Math.sin(yaw) * along + Math.cos(yaw) * side, (seat?.y ?? 0) + y, sz + Math.cos(yaw) * along - Math.sin(yaw) * side);
  }

  private draw(a: Active, p: ArrivalPose): void {
    const s = a.spec;
    this.crowd.set(a.slot, {
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: p.yaw,
      scale: p.scale,
      tint: s.tint,
      cue: s.cue,
      // Packing at the desk: busy hands, like typing; otherwise a calm face.
      display: p.phase === 'pack' ? 'working' : 'idle',
      phase: s.phase,
      ...(p.seated ? {} : { stride: p.stride ?? 0 }),
      carry: p.box === 'carried',
      // M6: what the freelancer wears; no lifecycle props on the way.
      ...(s.crew ? { crew: { ...s.crew, life: null, turn: 0 } } : {}),
      briefcase: p.briefcase === 'hand',
      wave: p.wave,
    });
    const yawQ = this.q.setFromAxisAngle(this.up, p.yaw);
    // The box: on the desk beside the laptop while packing, else carried in front.
    if (p.box === 'desk') {
      this.deskPoint(a, SEAT_OFFSET, 0.44, DESK_H, this.pos);
      this.boxQ.setFromAxisAngle(this.up, s.seatYaw);
      this.scl.setScalar(Math.max(0.001, p.boxScale));
    } else {
      this.v.copy(CARRY).multiplyScalar(p.scale).applyQuaternion(yawQ);
      this.pos.set(p.x + this.v.x, p.y + this.v.y, p.z + this.v.z);
      this.boxQ.copy(yawQ);
      this.scl.setScalar(Math.max(0.001, p.scale * p.boxScale));
    }
    this.boxM.compose(this.pos, this.boxQ, this.scl);
    const boxOn = p.box !== 'none';
    // The laptop: the desk's own until it is taken (desks.ts draws it), then lifted onto the box and carried.
    const lapOn = p.laptop === 'lift' || p.laptop === 'carried';
    if (lapOn) {
      // On top of the box, over the keepsakes.
      this.w.set(0, BOX.h + 0.1, 0).applyMatrix4(this.boxM);
      if (p.laptop === 'lift') {
        this.deskPoint(a, SEAT_OFFSET - LAPTOP_BACK, 0, DESK_H + 0.02, this.v);
        const k = p.lift;
        // An arc: up off the desk, over, and down onto the box.
        this.w.lerpVectors(this.v, this.w, k);
        this.w.y += Math.sin(k * Math.PI) * 0.18;
      }
      this.lapM.compose(this.w, this.boxQ, this.scl);
    }
    for (const part of PROPS) {
      const mesh = this.parts[part.key];
      if (part.on === 'laptop') mesh.setMatrixAt(a.slot, lapOn ? this.lapM : ZERO);
      else if (!boxOn || (part.on === 'item' && (part.item ?? 0) >= p.items)) mesh.setMatrixAt(a.slot, ZERO);
      else {
        const local = this.local[part.key];
        mesh.setMatrixAt(a.slot, local ? this.m.multiplyMatrices(this.boxM, local) : this.boxM);
      }
    }
  }

  /** What each walker is doing (test hook). */
  info(now: number): ArrivalInfo[] {
    return this.active.map((a) => {
      const at = Math.min(a.tl.total, (now - a.t0) * this.rate);
      const p = poseAt(a.tl, at);
      return {
        id: a.spec.id,
        kind: a.spec.kind,
        session: a.spec.session,
        desk: a.spec.desk,
        name: a.spec.name,
        phase: p.phase,
        t: at,
        total: a.tl.total,
        x: p.x,
        y: p.y,
        z: p.z,
        walked: p.walked,
        length: a.tl.length,
        desk_show: p.desk,
        box: p.box,
        laptop: p.laptop,
        items: p.items,
        carry: a.tl.carry,
        briefcase: p.briefcase,
        wave: p.wave,
      };
    });
  }

  dispose(): void {
    this.clear();
    this.crowd.dispose();
    for (const mesh of Object.values(this.parts)) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
    this.group.removeFromParent();
  }
}
