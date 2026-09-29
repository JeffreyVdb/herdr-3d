import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { pickNearest, rayBox, type Pickable, type V3 } from '../world/collide';
import { hash32, modelCue, type Display } from '../world/derive';
import { DESK_H, floorLayout, MEZZ_Y, SEAT_OFFSET, seatRect, slotBoxes, wallPieces, type Box3, type FloorLayout, type Opening, type Outline, type Rect } from '../world/layout';
import type { FloorView, WorkerView } from '../world/store';
import { AtlasCards } from './cards/atlasCards';
import { cardOf } from './cards/cardOf';
import { CARD_RANGE, cardWeight, OVERLOOK_CARD_RANGE } from './cards/select';
import type { CardData } from './cards/types';
import { Crowd } from './crowd';
import { DeskSet } from './desks';
import { MezzanineView } from './mezzanine';
import { BODY_TINTS, OFFICE } from './palette';
import { buildProps, signTexture, type PropMeshes } from './props';
// M6: write-code crews.
import { crewLookOf, type CrewLook } from './crewLook';

export type Target =
  | { kind: 'worker'; id: string; name: string; label: string; desk: number }
  | { kind: 'desk'; id: string; desk: number; label: string }
  | { kind: 'board' | 'prop'; id: string; label: string; milestone: string }
  /** #20: your own desk in the corner office (never a worker desk slot: E sits you down). */
  | { kind: 'own-desk'; id: 'own-desk'; label: string; name: string };

export const SEAT_Y = 0.45;
export const CARD_Y = 1.62;
export const REACH = 3;

export interface OfficeOptions {
  shadows: boolean;
  /** The building's outline: every floor of a building is this big (see `outlineOf`). */
  outline?: Outline;
  /** #20: the name on your desk's name plate. */
  owner?: string;
}

/**
 * M4: a desk shown other than the world says while someone packs up at it
 * (`busy`: chair out, laptop open, the worker drawn by the walk animation) or
 * walks in to it / has just left it (`empty`: chair in, no laptop, no "+").
 */
export interface AwaySeat {
  show: 'busy' | 'empty';
  display: Display;
  cue: number;
}

/** Glass seen from inside: a light tint over the street. */
export const GLASS_IN = { color: 0x9fd3f0, opacity: 0.16 };

/** Visual state for a worker (shared by the office and the city). */
export function memberOf(v: WorkerView): { tint: number; cue: ReturnType<typeof modelCue>; display: Display; phase: number; crew?: CrewLook } {
  const h = hash32(v.worker.id);
  const m = {
    tint: BODY_TINTS[h % BODY_TINTS.length] ?? 0xffd84a,
    cue: modelCue(v.harness, v.worker.model),
    display: v.display,
    phase: ((h >>> 8) % 6283) / 1000,
  };
  // M6: a crew member's role look (the model cue stays).
  return v.crew ? { ...m, crew: crewLookOf(v.crew, v.worker.phase) } : m;
}

/**
 * M6: how far a reporting freelancer at `slot` turns in its chair to hold
 * its folder out towards its orchestrator's desk (0: not on this floor).
 */
export function turnTowards(slot: { seat: { x: number; z: number }; yaw: number }, orch: { seat: { x: number; z: number } } | undefined): number {
  if (!orch) return 0;
  const want = Math.atan2(orch.seat.x - slot.seat.x, orch.seat.z - slot.seat.z);
  let d = (want - slot.yaw) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return Math.max(-1.3, Math.min(1.3, d));
}

/**
 * One office floor in first person: static room + instanced desks/workers +
 * cards, under `root` at the floor's own origin (the walk scene lights it and
 * places the building around it). Windows are holes with glass you see out
 * of; the fire-escape door in the west wall slides open (`setDoor`).
 */
export class OfficeView {
  readonly root = new THREE.Group();
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
  private readonly glow: THREE.MeshBasicMaterial[] = [];
  private readonly door: THREE.Mesh;
  private readonly doorClosedZ: number;
  private doorOpen = 0;
  private readonly outlineKey: string;
  private readonly propTargets: Array<Pickable<Target>>;
  private readonly blockers: Box3[];
  private readonly mezz: MezzanineView;
  private readonly ownDesk: Pickable<Target>;
  private overlook = false;
  private asleep = false;
  private cardsDirty = true;
  /** Walking obstacles and pick targets, until a seat changes. */
  private obstacleCache: Rect[] | null = null;
  private targetCache: Array<Pickable<Target>> | null = null;
  private targetOwnCache: Array<Pickable<Target>> | null = null;
  private cardCam: THREE.PerspectiveCamera | null = null;
  /** M4: desks someone is walking in to or packing up at (see `setAway`). */
  private readonly away = new Map<number, AwaySeat>();
  /** M5: the desk whose worker stands aside while you sit at its laptop. */
  private lean: number | null = null;
  private atLaptop = false;
  private planOn = false;
  /** M5: the looked-at worker, whose card shows its usage. */
  private focusId: string | null = null;

  constructor(view: FloorView, o: OfficeOptions) {
    this.session = view.session;
    const L = (this.layout = floorLayout(view.desks, o.outline));
    this.outlineKey = outlineKey(o.outline);
    this.seats = Array.from({ length: L.desks }, () => null);
    this.anchors = Array.from({ length: L.desks }, () => null);
    this.root.name = `office:${view.session}`;

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
    // Outer walls cut around the windows and the fire-escape door.
    const sides: Array<[Opening['wall'], 0 | 2]> = [
      ['north', 0],
      ['south', 0],
      ['west', 2],
      ['east', 2],
    ];
    const pieces = sides.flatMap(([side, axis], i) => {
      const b = L.walls[i] as Box3;
      return wallPieces(b, axis, L.openings.filter((w) => w.wall === side));
    });
    const walls = new THREE.Mesh(mergeGeometries(pieces.map(boxGeo)), new THREE.MeshToonMaterial({ color: OFFICE.wall }));
    walls.receiveShadow = true;
    const partition = L.walls[4];
    const board = partition ? new THREE.Mesh(boxGeo(partition), new THREE.MeshToonMaterial({ color: OFFICE.boardWall })) : null;
    if (board) {
      board.castShadow = board.receiveShadow = true;
      this.addStatic(board);
    }
    // Skirting in the partition colour ties the room together.
    const door = L.fireDoor;
    const trim: THREE.BufferGeometry[] = [
      new THREE.BoxGeometry(L.width, 0.12, 0.03).translate(L.width / 2, 0.06, 0.015),
      new THREE.BoxGeometry(0.03, 0.12, L.depth).translate(L.width - 0.015, 0.06, L.depth / 2),
      new THREE.BoxGeometry(0.03, 0.12, door.z0).translate(0.015, 0.06, door.z0 / 2),
      new THREE.BoxGeometry(0.03, 0.12, L.depth - door.z1).translate(0.015, 0.06, (door.z1 + L.depth) / 2),
      new THREE.BoxGeometry(L.width, 0.12, 0.03).translate(L.width / 2, 0.06, L.depth - 0.015),
    ];
    // Window frames and sills (navy, like the skirting), and the glass you see out through.
    const glass: THREE.BufferGeometry[] = [];
    for (const w of L.openings) {
      const { along, inset, turn } = wallFrame(w.wall, L);
      const u = (w.u0 + w.u1) / 2;
      const len = w.u1 - w.u0;
      const place = (g: THREE.BufferGeometry, du: number, y: number, d: number) => {
        g.rotateY(turn);
        const [x, z] = along === 'x' ? [u + du, inset(d)] : [inset(d), u + du];
        return g.translate(x, y, z);
      };
      if (w.kind === 'door') {
        trim.push(place(new THREE.BoxGeometry(len + 0.16, 0.08, 0.05), 0, w.y1 + 0.04, 0.02));
        for (const k of [-1, 1]) trim.push(place(new THREE.BoxGeometry(0.08, w.y1, 0.05), (k * (len + 0.08)) / 2, w.y1 / 2, 0.02));
        continue;
      }
      const h = w.y1 - w.y0;
      trim.push(place(new THREE.BoxGeometry(len + 0.1, 0.05, 0.16), 0, w.y0 + 0.025, 0.06));
      trim.push(place(new THREE.BoxGeometry(len, 0.05, 0.05), 0, w.y1 - 0.025, 0.1));
      for (const k of [-1, 1]) trim.push(place(new THREE.BoxGeometry(0.05, h, 0.05), (k * (len - 0.05)) / 2, (w.y0 + w.y1) / 2, 0.1));
      if (len > 2) trim.push(place(new THREE.BoxGeometry(0.04, h, 0.04), 0, (w.y0 + w.y1) / 2, 0.1));
      // Tall windows: a transom at the mezzanine's floor level.
      if (w.y0 < MEZZ_Y - 0.5 && w.y1 > MEZZ_Y + 0.5) trim.push(place(new THREE.BoxGeometry(len, 0.06, 0.06), 0, MEZZ_Y, 0.1));
      glass.push(place(new THREE.PlaneGeometry(len, h), 0, (w.y0 + w.y1) / 2, 0.1));
    }
    const skirting = new THREE.Mesh(mergeGeometries(trim), new THREE.MeshToonMaterial({ color: OFFICE.boardWall }));
    this.addStatic(walls, skirting);
    // One glass material: the windows, the corner office's walls and its door.
    const glassMat = new THREE.MeshBasicNodeMaterial({ color: GLASS_IN.color, transparent: true, opacity: GLASS_IN.opacity, depthWrite: false });
    this.mezz = new MezzanineView(L.mezzanine, o.owner ?? 'You', glassMat, o.shadows);
    this.addStatic(this.mezz.group);
    const pane = new THREE.Mesh(mergeGeometries([...glass, ...this.mezz.glass]), glassMat);
    for (const g of [...glass, ...this.mezz.glass]) g.dispose();
    pane.name = 'office.glass';
    this.addStatic(pane);

    // The fire-escape door: it slides south into the wall when you walk up to it.
    const leaf = mergeGeometries([
      new THREE.BoxGeometry(0.05, door.height, door.z1 - door.z0).translate(0, door.height / 2, 0),
    ]);
    this.door = new THREE.Mesh(leaf, new THREE.MeshToonMaterial({ color: OFFICE.boardWall }));
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, (door.z1 - door.z0) * 0.7).translate(0.05, 1.05, 0), new THREE.MeshToonMaterial({ color: 0xffc233 }));
    this.door.add(bar);
    this.doorClosedZ = (door.z0 + door.z1) / 2;
    this.door.position.set(-0.11, 0, this.doorClosedZ);
    this.door.castShadow = true;
    this.addStatic(this.door);
    const exitTex = signTexture('Fire escape', 'walk up to the door', '#1c2540', '#ffc233', 512, 160);
    const exit = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.28).rotateY(Math.PI / 2), new THREE.MeshBasicMaterial({ map: exitTex }));
    exit.position.set(0.02, door.height + 0.3, this.doorClosedZ);
    this.addStatic(exit);

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
    this.root.add(this.ceiling);

    this.props = buildProps(L.props, L, view.level ? `${view.level.number}` : '·');
    this.root.add(this.props.group);

    this.desks = new DeskSet(L.desks, o.shadows, true);
    this.crowd = new Crowd(L.desks, o.shadows);
    this.root.add(this.desks.group, this.crowd.group);

    const weight = (slot: number) => cardWeight(this.seats[slot]?.display === 'needs_you', this.overlook);
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
    this.root.add(this.cards.object);

    this.propTargets = L.props.map((p) => ({
      boxes: [p.box],
      value: { kind: p.id.startsWith('board.') ? 'board' : 'prop', id: p.id, label: p.label, milestone: p.milestone } as Target,
    }));
    // Walls and the mezzanine's slab stop look-at; its glass does not.
    this.blockers = [...L.walls, L.mezzanine.slab];
    const md = L.mezzanine.desk;
    const my = L.mezzanine.y;
    const box = (cx: number, cz: number, hx: number, hz: number, y0: number, y1: number): Box3 => ({ min: [cx - hx, y0, cz - hz], max: [cx + hx, y1, cz + hz] });
    this.ownDesk = {
      // The desk (turned: its long side runs north-south) with the monitor, and the chair.
      boxes: [box(md.desk.x, md.desk.z, 0.35, 0.7, my, my + DESK_H + 0.6), box(md.seat.x, md.seat.z, 0.3, 0.3, my + 0.3, my + 1.2)],
      value: { kind: 'own-desk', id: 'own-desk', label: 'Your desk', name: o.owner ?? 'You' },
    };

    for (let i = 0; i < L.desks; i++) this.setSeat(i, null);
    this.apply(view, o.outline);
  }

  private addStatic(...objs: THREE.Object3D[]): void {
    for (const o of objs) {
      this.static.push(o);
      this.root.add(o);
    }
  }

  /** Fire-escape door: 0 shut, 1 open (slid into the wall); eased by the caller. */
  setDoor(open: number): void {
    const k = Math.max(0, Math.min(1, open));
    if (k === this.doorOpen) return;
    this.doorOpen = k;
    const d = this.layout.fireDoor;
    this.door.position.z = this.doorClosedZ + k * (d.z1 - d.z0 + 0.05);
  }

  get door01(): number {
    return this.doorOpen;
  }

  get isAsleep(): boolean {
    return this.asleep;
  }

  get desksCount(): number {
    return this.layout.desks;
  }

  /** Applies a floor view with the same desk count and outline; false means rebuild. */
  apply(view: FloorView, outline?: Outline): boolean {
    if (view.desks !== this.layout.desks || outlineKey(outline) !== this.outlineKey) return false;
    this.setAsleep(view.asleep);
    // M6: every seat is known before any is set (a reporting freelancer turns towards its orchestrator's).
    for (let i = 0; i < this.seats.length; i++) this.seats[i] = view.seats[i] ?? null;
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

  /** M5: the worker you look at: its card adds its usage line (null: nobody). */
  setFocus(id: string | null): void {
    if (id === this.focusId) return;
    const prev = this.focusId;
    this.focusId = id;
    this.seats.forEach((v, i) => {
      if (v && (v.worker.id === prev || v.worker.id === id)) this.setSeat(i, v);
    });
  }

  /** M4: shows a desk as `a` says instead of as the world does (null: as the world does again). */
  setAway(desk: number, a: AwaySeat | null): void {
    const cur = this.away.get(desk) ?? null;
    if (cur === a || (cur && a && cur.show === a.show && cur.display === a.display && cur.cue === a.cue)) return;
    if (!this.layout.slots[desk]) return;
    if (a) this.away.set(desk, a);
    else this.away.delete(desk);
    this.setSeat(desk, this.seats[desk] ?? null);
  }

  /** M5: the worker at `desk` stands aside while you sit at its laptop (null: back in its chair). */
  setLean(desk: number | null): void {
    if (desk === this.lean) return;
    const prev = this.lean;
    this.lean = desk;
    if (prev !== null) this.setSeat(prev, this.seats[prev] ?? null);
    if (desk !== null) this.setSeat(desk, this.seats[desk] ?? null);
  }

  get leaning(): number | null {
    return this.lean;
  }

  /** M4: desks shown away from what the world says (test hook). */
  awayDesks(): Map<number, AwaySeat['show']> {
    return new Map([...this.away].map(([d, a]) => [d, a.show]));
  }

  private setSeat(i: number, v: WorkerView | null): void {
    const s = this.layout.slots[i];
    if (!s) return;
    this.seats[i] = v;
    this.obstacleCache = this.targetCache = this.targetOwnCache = null;
    const mem = v ? memberOf(v) : null;
    if (mem?.crew && v?.crew?.life === 'reporting' && v.crew.orchId) {
      const o = this.seats.findIndex((x) => x?.worker.id === v.crew?.orchId);
      mem.crew.turn = turnTowards(s, o >= 0 ? this.layout.slots[o] : undefined);
    }
    const away = this.away.get(i);
    if (away) {
      // Someone is walking in or packing up: the animation draws them, the desk waits without its "+".
      const busy = away.show === 'busy';
      this.desks.set(i, { x: s.seat.x, y: 0, z: s.seat.z, yaw: s.yaw, scale: 1, display: busy ? away.display : null, cueColor: away.cue, plus: false });
      this.crowd.set(i, null);
      this.anchors[i] = null;
      this.cards.setCard(i, null);
      if (v) this.applied.set(v.worker.id, v.display);
      this.cardsDirty = true;
      return;
    }
    this.desks.set(i, { x: s.seat.x, y: 0, z: s.seat.z, yaw: s.yaw, scale: 1, display: mem?.display ?? null, cueColor: mem?.cue.color ?? 0xffffff });
    if (v && mem && this.lean === i) {
      // M5: you sit at its laptop; it stands beside the chair, turned to watch the screen.
      const fx = Math.sin(s.yaw);
      const fz = Math.cos(s.yaw);
      const x = s.seat.x - fz * 0.62 + fx * 0.3;
      const z = s.seat.z + fx * 0.62 + fz * 0.3;
      const yaw = Math.atan2(s.seat.x + fx * SEAT_OFFSET - x, s.seat.z + fz * SEAT_OFFSET - z);
      this.crowd.set(i, { x, y: 0, z, yaw, scale: 1, ...mem, stride: 0 });
      this.anchors[i] = new THREE.Vector3(x, CARD_Y + 0.25, z);
      this.cards.setCard(i, cardOf(v, v.worker.id === this.focusId));
      this.applied.set(v.worker.id, v.display);
    } else if (v && mem) {
      this.crowd.set(i, { x: s.seat.x, y: SEAT_Y, z: s.seat.z, yaw: s.yaw, scale: 1, ...mem });
      this.anchors[i] = new THREE.Vector3(s.seat.x, CARD_Y, s.seat.z);
      this.cards.setCard(i, cardOf(v, v.worker.id === this.focusId));
      this.applied.set(v.worker.id, v.display);
    } else {
      this.crowd.set(i, null);
      this.anchors[i] = null;
      this.cards.setCard(i, null);
    }
    this.cardsDirty = true;
  }

  /** Lights off on an asleep floor: the ceiling panels here, the room light in the walk scene. */
  private setAsleep(asleep: boolean): void {
    this.asleep = asleep;
    for (const m of this.glow) m.color.set(asleep ? 0x3a3f58 : 0xfff6dd);
  }

  setPlan(on: boolean): void {
    this.planOn = on;
    this.ceiling.visible = !on;
    this.cards.setVisible(!on && !this.atLaptop);
    this.mezz.setPlan(on);
  }

  /** M5: sitting at a laptop, the cards stay out of the way (they draw on top of everything). */
  setAtLaptop(on: boolean): void {
    this.atLaptop = on;
    this.cards.setVisible(!on && !this.planOn);
  }

  /** #20: up on the mezzanine, cards are measured as though you were nearer, and all of them can show. */
  setOverlook(on: boolean): void {
    if (on === this.overlook) return;
    this.overlook = on;
    this.cards.setRange(on ? OVERLOOK_CARD_RANGE : CARD_RANGE);
    this.cardsDirty = true;
  }

  get overlooking(): boolean {
    return this.overlook;
  }

  /** #20: the corner office's glass door: 0 shut, 1 open. */
  setMezzDoor(open: number): void {
    this.mezz.setDoor(open);
  }

  get mezzDoor01(): number {
    return this.mezz.door01;
  }

  /** Walking obstacles: the layout plus occupied seats. */
  obstacles(): readonly Rect[] {
    if (!this.obstacleCache) {
      const out = [...this.layout.colliders];
      this.seats.forEach((v, i) => {
        const s = this.layout.slots[i];
        if ((v || this.away.get(i)?.show === 'busy') && s) out.push(seatRect(s));
      });
      this.obstacleCache = out;
    }
    return this.obstacleCache;
  }

  /** What the centre of the screen looks at, within reach; `ownDesk: false` leaves your desk out (#20). */
  pick(origin: V3, dir: V3, reach = REACH, ownDesk = true): Target | null {
    if (!this.targetCache) {
      const targets: Array<Pickable<Target>> = [...this.propTargets];
      this.layout.slots.forEach((s, i) => {
        const b = slotBoxes(s);
        const v = this.seats[i];
        if (v) targets.push({ boxes: [b.seat, b.desk], value: { kind: 'worker', id: v.worker.id, name: v.name, label: v.worker.label, desk: i } });
        // A desk someone is packing up at, or walking in to, is not free to hire at.
        else if (!this.away.has(i)) targets.push({ boxes: [b.desk, b.plus], value: { kind: 'desk', id: `desk-${i}`, desk: i, label: `Desk ${i + 1}` } });
      });
      this.targetCache = targets;
    }
    this.targetOwnCache ??= [...this.targetCache, this.ownDesk];
    return pickNearest(origin, dir, ownDesk ? this.targetOwnCache : this.targetCache, reach, this.blockers)?.value ?? null;
  }

  /** Cards on screen with what they say (tests); M5: `tall` when drawn with the question / usage room. */
  shownCards(): Array<CardData & { desk: number; tall: boolean }> {
    const tall = new Set(this.cards.shownTall());
    return this.cards.shown().flatMap((desk) => {
      const c = this.cards.card(desk);
      return c ? [{ desk, ...c, tall: tall.has(desk) }] : [];
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
    this.mezz.dispose();
    this.crowd.dispose();
    this.desks.dispose();
    this.props.dispose();
    this.root.removeFromParent();
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          (m as THREE.MeshBasicMaterial).map?.dispose();
          (m as THREE.Material).dispose();
        }
      }
    });
  }
}

function outlineKey(o: Outline | undefined): string {
  return o ? `${o.width}x${o.depth}` : '';
}

/**
 * Where an opening's frame goes on its wall: `u` runs along x or z, and
 * `inset(d)` is the coordinate `d` metres into the wall from its room face;
 * `turn` rotates a +z-facing plane to face into the room.
 */
function wallFrame(side: Opening['wall'], L: { width: number; depth: number }): { along: 'x' | 'z'; inset: (d: number) => number; turn: number } {
  switch (side) {
    case 'north':
      return { along: 'x', inset: (d) => -d, turn: 0 };
    case 'south':
      return { along: 'x', inset: (d) => L.depth + d, turn: Math.PI };
    case 'west':
      return { along: 'z', inset: (d) => -d, turn: Math.PI / 2 };
    case 'east':
      return { along: 'z', inset: (d) => L.width + d, turn: -Math.PI / 2 };
  }
}
