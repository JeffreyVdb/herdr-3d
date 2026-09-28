import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { poseAt, timeline, type ArrivalKind, type ArrivalPose, type DeskShow, type Timeline } from '../world/arrival';
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
 * workers, and a box, its three keepsakes and a closed laptop per walker.
 * Everything is in absolute building coordinates (y = feet above the
 * street); the app shifts `group` down by the walk scene's base.
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
}

interface Active {
  spec: ArrivalSpec;
  tl: Timeline;
  t0: number;
  slot: number;
  props: THREE.Group;
  box: THREE.Object3D;
  items: THREE.Object3D[];
  laptop: THREE.Object3D;
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
}

const CAPACITY = 8;
const BOX = { w: 0.44, h: 0.28, d: 0.32 };
/** The carried box, in worker space (origin at the seat/hips, facing +z). */
const CARRY = new THREE.Vector3(0, 0.36, 0.34);
/** The desk's laptop hinge sits a little towards the seat from the desk centre (desks.ts). */
const LAPTOP_BACK = 0.14;

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
  private readonly active: Active[] = [];
  private readonly free: number[] = Array.from({ length: CAPACITY }, (_, i) => CAPACITY - 1 - i);
  /** Finished (or skipped) arrivals, newest last (test hook). */
  readonly log: Array<{ id: string; kind: ArrivalKind; played: boolean; session: string; desk: number }> = [];
  /** Desks the office should show as the world says again (arrivals that just ended). */
  private released: DeskAway[] = [];
  private readonly geo: Record<'body' | 'flaps' | 'tape' | 'mug' | 'pot' | 'leaves' | 'frame' | 'lapBase' | 'lapLid', THREE.BufferGeometry>;
  private readonly mat: Record<'card' | 'flap' | 'tape' | 'mug' | 'pot' | 'leaves' | 'frame' | 'laptop', THREE.Material>;
  private readonly sticker = new THREE.MeshToonMaterial({ color: 0xffffff });
  private readonly v = new THREE.Vector3();
  private readonly w = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private rate = 1;

  constructor(private readonly shadows: boolean) {
    this.group.name = 'arrivals';
    this.crowd = new Crowd(CAPACITY, shadows);
    this.group.add(this.crowd.group);
    const b = boxGeometry();
    this.geo = {
      ...b,
      mug: new THREE.CylinderGeometry(0.045, 0.04, 0.1, 12).translate(0, 0.05, 0),
      pot: new THREE.CylinderGeometry(0.05, 0.04, 0.08, 10).translate(0, 0.04, 0),
      leaves: new THREE.IcosahedronGeometry(0.075, 0).translate(0, 0.13, 0),
      frame: new THREE.BoxGeometry(0.14, 0.11, 0.015).rotateX(-0.25).translate(0, 0.06, 0),
      lapBase: new THREE.BoxGeometry(0.34, 0.018, 0.24),
      lapLid: new THREE.BoxGeometry(0.34, 0.012, 0.24).translate(0, 0.016, 0),
    };
    this.mat = {
      card: new THREE.MeshToonMaterial({ color: 0xc9935a }),
      flap: new THREE.MeshToonMaterial({ color: 0xd9a86e }),
      tape: new THREE.MeshToonMaterial({ color: 0xa87440 }),
      mug: new THREE.MeshToonMaterial({ color: 0xffffff }),
      pot: new THREE.MeshToonMaterial({ color: OFFICE.pot }),
      leaves: new THREE.MeshToonMaterial({ color: OFFICE.plant }),
      frame: new THREE.MeshToonMaterial({ color: 0xffc233 }),
      laptop: new THREE.MeshToonMaterial({ color: OFFICE.laptop }),
    };
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
    const tl = timeline(spec.kind, spec.route, spec.seatYaw);
    const props = new THREE.Group();
    props.name = `arrival:${spec.id}`;
    const mesh = (g: THREE.BufferGeometry, m: THREE.Material) => {
      const x = new THREE.Mesh(g, m);
      x.castShadow = this.shadows;
      return x;
    };
    const box = new THREE.Group();
    box.add(mesh(this.geo.body, this.mat.card), mesh(this.geo.flaps, this.mat.flap), mesh(this.geo.tape, this.mat.tape));
    // The keepsakes poke out of the top: a mug, a little plant, a framed photo.
    const mug = mesh(this.geo.mug, this.mat.mug);
    mug.position.set(-0.12, BOX.h - 0.05, 0.04);
    const plant = new THREE.Group();
    plant.add(mesh(this.geo.pot, this.mat.pot), mesh(this.geo.leaves, this.mat.leaves));
    plant.position.set(0.12, BOX.h - 0.05, -0.03);
    const photo = mesh(this.geo.frame, this.mat.frame);
    photo.position.set(0.02, BOX.h - 0.04, -0.08);
    const items = [mug, plant, photo];
    box.add(...items);
    const laptop = new THREE.Group();
    const sticker = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.004, 14).translate(0.07, 0.024, 0.03), this.sticker.clone());
    (sticker.material as THREE.MeshToonMaterial).color.set(spec.cue.color);
    laptop.add(mesh(this.geo.lapBase, this.mat.laptop), mesh(this.geo.lapLid, this.mat.laptop), sticker);
    props.add(box, laptop);
    this.group.add(props);
    this.active.push({ spec, tl, t0: now, slot, props, box, items, laptop, last: null });
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
    a.props.removeFromParent();
    a.props.traverse((o) => {
      if (o instanceof THREE.Mesh && o.material instanceof THREE.MeshToonMaterial && !Object.values(this.mat).includes(o.material)) {
        o.geometry.dispose();
        o.material.dispose();
      }
    });
    this.released.push({ session: a.spec.session, desk: a.spec.desk, away: null });
    this.log.push({ id: a.spec.id, kind: a.spec.kind, played, session: a.spec.session, desk: a.spec.desk });
    if (this.log.length > 50) this.log.shift();
  }

  /**
   * Advances every walk to time `now` (s) and draws it; returns what each
   * walker's desk should show (and the desks of walks that just ended, as null).
   */
  update(now: number, t: number): DeskAway[] {
    const out: DeskAway[] = this.released;
    this.released = [];
    for (let i = this.active.length - 1; i >= 0; i--) {
      const a = this.active[i] as Active;
      const at = (now - a.t0) * this.rate;
      if (at >= a.tl.total) {
        this.finish(i, true);
        continue;
      }
      const p = poseAt(a.tl, at);
      a.last = p;
      this.draw(a, p);
      const s = a.spec;
      out.push({ session: s.session, desk: s.desk, away: p.desk === 'free' ? null : { show: p.desk, display: s.display, cue: s.cue.color } });
    }
    // Released desks come first; a walk still running on the same desk wins (it is later in the list).
    this.crowd.update(t);
    return out;
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
    });
    const yawQ = this.q.setFromAxisAngle(this.up, p.yaw);
    // The box: on the desk beside the laptop while packing, else carried in front.
    a.box.visible = p.box !== 'none';
    if (p.box === 'desk') {
      this.deskPoint(a, SEAT_OFFSET, 0.44, DESK_H, a.box.position);
      a.box.quaternion.setFromAxisAngle(this.up, s.seatYaw);
      a.box.scale.setScalar(Math.max(0.001, p.boxScale));
    } else if (p.box === 'carried') {
      const k = p.scale * p.boxScale;
      this.v.copy(CARRY).multiplyScalar(p.scale).applyQuaternion(yawQ);
      a.box.position.set(p.x + this.v.x, p.y + this.v.y, p.z + this.v.z);
      a.box.quaternion.copy(yawQ);
      a.box.scale.setScalar(Math.max(0.001, k));
    }
    a.items.forEach((it, i) => (it.visible = i < p.items));
    // The laptop: the desk's own until it is taken (desks.ts draws it), then lifted onto the box and carried.
    a.laptop.visible = p.laptop === 'lift' || p.laptop === 'carried';
    if (a.laptop.visible) {
      a.box.updateMatrixWorld();
      // On top of the box, over the keepsakes.
      this.w.set(0, BOX.h + 0.1, 0).applyMatrix4(a.box.matrix);
      if (p.laptop === 'lift') {
        this.deskPoint(a, SEAT_OFFSET - LAPTOP_BACK, 0, DESK_H + 0.02, this.v);
        const k = p.lift;
        // An arc: up off the desk, over, and down onto the box.
        a.laptop.position.lerpVectors(this.v, this.w, k);
        a.laptop.position.y += Math.sin(k * Math.PI) * 0.18;
      } else a.laptop.position.copy(this.w);
      a.laptop.quaternion.copy(a.box.quaternion);
      a.laptop.scale.copy(a.box.scale);
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
      };
    });
  }

  dispose(): void {
    this.clear();
    this.crowd.dispose();
    for (const g of Object.values(this.geo)) g.dispose();
    for (const m of Object.values(this.mat)) m.dispose();
    this.sticker.dispose();
    this.group.removeFromParent();
  }
}
