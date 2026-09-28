import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { pickNearest, rayBox, type Pickable, type V3 } from '../world/collide';
import { hash32, modelCue, taskLine, type Display } from '../world/derive';
import { floorLayout, seatRect, slotBoxes, type Box3, type FloorLayout, type Rect } from '../world/layout';
import type { FloorView, WorkerView } from '../world/store';
import { AtlasCards } from './cards/atlasCards';
import type { CardData } from './cards/types';
import { Crowd } from './crowd';
import { DeskSet } from './desks';
import { BODY_TINTS, OFFICE } from './palette';
import { buildProps, type PropMeshes } from './props';

export type Target =
  | { kind: 'worker'; id: string; name: string; label: string; desk: number }
  | { kind: 'desk'; id: string; desk: number; label: string }
  | { kind: 'board' | 'prop'; id: string; label: string; milestone: string };

export const SEAT_Y = 0.45;
export const CARD_Y = 1.62;
export const REACH = 3;

export interface OfficeOptions {
  shadows: boolean;
}

/** Visual state for a worker (shared by the office and the city). */
export function memberOf(v: WorkerView) {
  const h = hash32(v.worker.id);
  return {
    tint: BODY_TINTS[h % BODY_TINTS.length] ?? 0xffd84a,
    cue: modelCue(v.harness, v.worker.model),
    display: v.display,
    phase: ((h >>> 8) % 6283) / 1000,
  };
}

/** One office floor in first person: static room + instanced desks/workers + cards. */
export class OfficeView {
  readonly scene = new THREE.Scene();
  readonly layout: FloorLayout;
  readonly session: string;
  readonly cards: AtlasCards;
  /** Worker id → status as last applied to the scene. */
  readonly applied = new Map<string, Display>();
  private readonly crowd: Crowd;
  private readonly desks: DeskSet;
  private readonly props: PropMeshes;
  private readonly seats: Array<WorkerView | null>;
  private readonly anchors: Array<THREE.Vector3 | null>;
  private readonly static: THREE.Object3D[] = [];
  private readonly ceiling: THREE.Group;
  private readonly hemi: THREE.HemisphereLight;
  private readonly sun: THREE.DirectionalLight;
  private readonly glow: THREE.MeshBasicMaterial[] = [];
  private readonly windows: THREE.MeshBasicMaterial;
  private readonly propTargets: Array<Pickable<Target>>;
  private readonly blockers: Box3[];
  private asleep = false;
  private cardsDirty = true;
  /** Walking obstacles and pick targets, until a seat changes. */
  private obstacleCache: Rect[] | null = null;
  private targetCache: Array<Pickable<Target>> | null = null;
  private cardCam: THREE.PerspectiveCamera | null = null;

  constructor(view: FloorView, o: OfficeOptions) {
    this.session = view.session;
    const L = (this.layout = floorLayout(view.desks));
    this.seats = Array.from({ length: L.desks }, () => null);
    this.anchors = Array.from({ length: L.desks }, () => null);
    this.scene.background = new THREE.Color(0xdfe9f7);

    // Light: soft sky fill + a sun through the east windows for shadows.
    this.hemi = new THREE.HemisphereLight(0xffffff, 0xcdb58c, 1.5);
    this.sun = new THREE.DirectionalLight(0xfff3dc, 1.9);
    this.sun.position.set(L.width * 0.8, 9, L.depth * 0.35);
    this.sun.target.position.set(L.width / 2, 0, L.depth / 2);
    this.sun.castShadow = o.shadows;
    this.sun.shadow.mapSize.set(2048, 2048);
    const half = Math.max(L.width, L.depth) * 0.62;
    Object.assign(this.sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 0.5, far: 40 });
    this.sun.shadow.bias = -0.0006;
    this.scene.add(this.hemi, this.sun, this.sun.target);

    // Floor: office carpet, a lighter lobby south of the board wall.
    const boardZ = L.walls[4]?.min[2] ?? L.depth - 4.3;
    const floorMat = new THREE.MeshToonMaterial({ color: OFFICE.floor });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(L.width, L.depth).rotateX(-Math.PI / 2), floorMat);
    floor.position.set(L.width / 2, 0, L.depth / 2);
    floor.receiveShadow = true;
    const lobby = new THREE.Mesh(new THREE.PlaneGeometry(L.width, L.depth - boardZ).rotateX(-Math.PI / 2), new THREE.MeshToonMaterial({ color: OFFICE.lobby }));
    lobby.position.set(L.width / 2, 0.002, (boardZ + L.depth) / 2);
    lobby.receiveShadow = true;
    this.addStatic(floor, lobby);

    // Walls: outer walls in one mesh, the board partition in navy.
    const boxGeo = (b: Box3) =>
      new THREE.BoxGeometry(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]).translate(
        (b.min[0] + b.max[0]) / 2,
        (b.min[1] + b.max[1]) / 2,
        (b.min[2] + b.max[2]) / 2,
      );
    const walls = new THREE.Mesh(mergeGeometries(L.walls.slice(0, 4).map(boxGeo)), new THREE.MeshToonMaterial({ color: OFFICE.wall }));
    walls.receiveShadow = true;
    const partition = L.walls[4];
    const board = partition ? new THREE.Mesh(boxGeo(partition), new THREE.MeshToonMaterial({ color: OFFICE.boardWall })) : null;
    if (board) {
      board.castShadow = board.receiveShadow = true;
      this.addStatic(board);
    }
    // Skirting in the partition colour ties the room together.
    const skirting = new THREE.Mesh(
      mergeGeometries([
        new THREE.BoxGeometry(L.width, 0.12, 0.03).translate(L.width / 2, 0.06, 0.015),
        new THREE.BoxGeometry(0.03, 0.12, L.depth).translate(L.width - 0.015, 0.06, L.depth / 2),
        new THREE.BoxGeometry(0.03, 0.12, L.depth).translate(0.015, 0.06, L.depth / 2),
        new THREE.BoxGeometry(L.width, 0.12, 0.03).translate(L.width / 2, 0.06, L.depth - 0.015),
      ]),
      new THREE.MeshToonMaterial({ color: OFFICE.boardWall }),
    );
    this.addStatic(walls, skirting);

    // Windows on the east wall and above the lounge.
    this.windows = new THREE.MeshBasicMaterial({ color: 0xbfe6ff });
    const panes: THREE.BufferGeometry[] = [];
    for (let z = 3; z < L.depth - 5; z += 3.2) panes.push(new THREE.PlaneGeometry(2.2, 1.5).rotateY(-Math.PI / 2).translate(L.width - 0.012, 1.75, z + 1.1));
    panes.push(new THREE.PlaneGeometry(3.6, 1.2).translate(2.8, 1.95, 0.012));
    const win = new THREE.Mesh(mergeGeometries(panes), this.windows);
    this.addStatic(win);

    // Ceiling with light panels (hidden in the floor plan).
    this.ceiling = new THREE.Group();
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(L.width, L.depth).rotateX(Math.PI / 2), new THREE.MeshToonMaterial({ color: OFFICE.ceiling }));
    ceil.position.set(L.width / 2, L.height, L.depth / 2);
    const panelMat = new THREE.MeshBasicMaterial({ color: 0xfff6dd });
    this.glow.push(panelMat);
    const panels = new THREE.Mesh(
      mergeGeometries(L.lights.map((p) => new THREE.PlaneGeometry(1.4, 0.6).rotateX(Math.PI / 2).translate(p.x, L.height - 0.01, p.z))),
      panelMat,
    );
    this.ceiling.add(ceil, panels);
    this.scene.add(this.ceiling);

    this.props = buildProps(L.props, L, view.level ? `${view.level.number}` : '·');
    this.scene.add(this.props.group);

    this.desks = new DeskSet(L.desks, o.shadows, true);
    this.crowd = new Crowd(L.desks, o.shadows);
    this.scene.add(this.desks.group, this.crowd.group);

    const weight = (slot: number) => (this.seats[slot]?.display === 'needs_you' ? 0.7 : 1);
    // A card behind a wall (from the camera) is not shown.
    const occluded = (slot: number, dist: number) => {
      const a = this.anchors[slot];
      if (!a || !this.cardCam) return false;
      const c = this.cardCam.position;
      const d: V3 = [(a.x - c.x) / dist, (a.y - c.y) / dist, (a.z - c.z) / dist];
      return L.walls.some((w) => {
        const t = rayBox([c.x, c.y, c.z], d, w);
        return t !== null && t < dist - 0.05;
      });
    };
    this.cards = new AtlasCards(L.desks, undefined, weight, occluded);
    this.scene.add(this.cards.object);

    this.propTargets = L.props.map((p) => ({
      boxes: [p.box],
      value: { kind: p.id.startsWith('board.') ? 'board' : 'prop', id: p.id, label: p.label, milestone: p.milestone } as Target,
    }));
    this.blockers = L.walls;

    for (let i = 0; i < L.desks; i++) this.setSeat(i, null);
    this.apply(view);
  }

  private addStatic(...objs: THREE.Object3D[]): void {
    for (const o of objs) {
      this.static.push(o);
      this.scene.add(o);
    }
  }

  get isAsleep(): boolean {
    return this.asleep;
  }

  get desksCount(): number {
    return this.layout.desks;
  }

  /** Applies a floor view with the same desk count; false means rebuild. */
  apply(view: FloorView): boolean {
    if (view.desks !== this.layout.desks) return false;
    this.setAsleep(view.asleep);
    const seen = new Set<string>();
    for (let i = 0; i < view.seats.length; i++) {
      const v = view.seats[i] ?? null;
      if (v) seen.add(v.worker.id);
      this.setSeat(i, v);
    }
    for (const id of [...this.applied.keys()]) if (!seen.has(id)) this.applied.delete(id);
    return true;
  }

  /** A worker whose status/title changed without moving desks. */
  updateWorker(v: WorkerView): void {
    if (this.seats[v.desk]?.worker.id !== v.worker.id) return;
    this.setSeat(v.desk, v);
  }

  private setSeat(i: number, v: WorkerView | null): void {
    const s = this.layout.slots[i];
    if (!s) return;
    this.seats[i] = v;
    this.obstacleCache = this.targetCache = null;
    const mem = v ? memberOf(v) : null;
    this.desks.set(i, { x: s.seat.x, y: 0, z: s.seat.z, yaw: s.yaw, scale: 1, display: mem?.display ?? null, cueColor: mem?.cue.color ?? 0xffffff });
    if (v && mem) {
      this.crowd.set(i, { x: s.seat.x, y: SEAT_Y, z: s.seat.z, yaw: s.yaw, scale: 1, ...mem });
      this.anchors[i] = new THREE.Vector3(s.seat.x, CARD_Y, s.seat.z);
      this.cards.setCard(i, { name: v.name, display: v.display, task: taskLine(v.worker) });
      this.applied.set(v.worker.id, v.display);
    } else {
      this.crowd.set(i, null);
      this.anchors[i] = null;
      this.cards.setCard(i, null);
    }
    this.cardsDirty = true;
  }

  private setAsleep(asleep: boolean): void {
    this.asleep = asleep;
    this.hemi.intensity = asleep ? 0.5 : 1.5;
    this.hemi.color.set(asleep ? 0x8f9bd6 : 0xffffff);
    this.sun.intensity = asleep ? 0.35 : 1.9;
    this.sun.color.set(asleep ? 0x9fb0ff : 0xfff3dc);
    for (const m of this.glow) m.color.set(asleep ? 0x3a3f58 : 0xfff6dd);
    this.windows.color.set(asleep ? 0x1d2447 : 0xbfe6ff);
    (this.scene.background as THREE.Color).set(asleep ? 0x1d2447 : 0xdfe9f7);
  }

  setPlan(on: boolean): void {
    this.ceiling.visible = !on;
    this.cards.setVisible(!on);
  }

  /** Walking obstacles: the layout plus occupied seats. */
  obstacles(): readonly Rect[] {
    if (!this.obstacleCache) {
      const out = [...this.layout.colliders];
      this.seats.forEach((v, i) => {
        const s = this.layout.slots[i];
        if (v && s) out.push(seatRect(s));
      });
      this.obstacleCache = out;
    }
    return this.obstacleCache;
  }

  /** What the centre of the screen looks at, within reach. */
  pick(origin: V3, dir: V3, reach = REACH): Target | null {
    if (!this.targetCache) {
      const targets: Array<Pickable<Target>> = [...this.propTargets];
      this.layout.slots.forEach((s, i) => {
        const b = slotBoxes(s);
        const v = this.seats[i];
        if (v) targets.push({ boxes: [b.seat, b.desk], value: { kind: 'worker', id: v.worker.id, name: v.name, label: v.worker.label, desk: i } });
        else targets.push({ boxes: [b.desk, b.plus], value: { kind: 'desk', id: `desk-${i}`, desk: i, label: `Desk ${i + 1}` } });
      });
      this.targetCache = targets;
    }
    return pickNearest(origin, dir, this.targetCache, reach, this.blockers)?.value ?? null;
  }

  /** Cards on screen with what they say (tests). */
  shownCards(): Array<CardData & { desk: number }> {
    return this.cards.shown().flatMap((desk) => {
      const c = this.cards.card(desk);
      return c ? [{ desk, ...c }] : [];
    });
  }

  seat(i: number): WorkerView | null {
    return this.seats[i] ?? null;
  }

  /** Animates and lays out cards; call once per rendered frame. */
  frame(t: number, camera: THREE.PerspectiveCamera | THREE.OrthographicCamera, cardCam: THREE.PerspectiveCamera, vp: { width: number; height: number }, moved: boolean): void {
    this.crowd.update(t);
    this.desks.update(t, camera);
    this.cardCam = cardCam;
    this.cards.update(cardCam, this.anchors, vp, moved || this.cardsDirty);
    this.cardsDirty = false;
  }

  dispose(): void {
    this.cards.dispose();
    this.crowd.dispose();
    this.desks.dispose();
    this.props.dispose();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) (m as THREE.Material).dispose();
      }
    });
    this.sun.shadow.map?.dispose();
  }
}
