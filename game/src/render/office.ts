import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { pickNearest, rayBox, type Pickable, type V3 } from '../world/collide';
import { hash32, modelCue, resolveHarness, type Display } from '../world/derive';
import { deskKit, type DeskKit } from '../world/deskKit';
import { DESK_H, floorLayout, MEZZ_Y, SEAT_OFFSET, seatRect, slotBoxes, wallPieces, type Box3, type DeskSlot, type FloorLayout, type Opening, type Outline, type Rect } from '../world/layout';
import type { StampTone } from '../world/crew';
import type { FloorView, WorkerView } from '../world/store';
import { AtlasCards } from './cards/atlasCards';
import { cardOf } from './cards/cardOf';
import { CARD_RANGE, cardWeight, OVERLOOK_CARD_RANGE } from './cards/select';
import type { CardData } from './cards/types';
import { Crowd, type Member } from './crowd';
import { DeskSet } from './desks';
import { TrayView } from './tray';
import { MezzanineView } from './mezzanine';
import { BODY_TINTS, OFFICE } from './palette';
import { buildProps, signTexture, type PropMeshes } from './props';
import type { ClockFace } from './clock';
import type { OverviewData } from '../world/overview';

/** #118: the wall screen draws and pages only while it spans at least this share of the view's height (readable). */
const OVERVIEW_READABLE = 0.3;
import { lookOf, NOON, type Look } from './daylook';
// M7: the corkboard, the pull request board and the merge gong.
import { BoardsView } from './boards/boards';
// M6: write-code crews.
import { crewLookOf, type CrewLook } from './crewLook';

export type Target =
  | { kind: 'worker'; id: string; name: string; label: string; desk: number }
  | { kind: 'desk'; id: string; desk: number; label: string }
  | { kind: 'board' | 'prop'; id: string; label: string; milestone: string | null }
  /** #20: your own desk in the corner office (never a worker desk slot: E sits you down). */
  | { kind: 'own-desk'; id: 'own-desk'; label: string; name: string };

/** M6: a crew member as the office draws it (test hook). */
export interface CrewInfo {
  id: string;
  name: string;
  desk: number;
  role: string;
  life: string | null;
  overCap: boolean;
  stamp: string | null;
  run: string | null;
  display: Display;
  parts: string[];
  /** M6c: out of its chair delivering a report (its desk and card stay). */
  out: boolean;
}

/** M6c: a worker away from its chair with a report: how far its chair is pushed back (0..1). */
export interface OutPose {
  chair: number;
}

/** M6c: an orchestrator swivelled in its chair this far (radians) to the freelancer, reaching for the folder (0..1). */
export interface SwivelPose {
  turn: number;
  reach: number;
}

/**
 * M6c: the slot a worker sits at. An orchestrator flagged `corner` (game-only, docs/decisions.md) sits up in the
 * corner office at the mezzanine's orchestrator desk, whatever its desk index says.
 */
export function seatOf(layout: FloorLayout, i: number, v: Pick<WorkerView, 'worker' | 'crew'> | null): { slot: DeskSlot; y: number; corner: boolean } | null {
  const base = layout.slots[i];
  if (!base) return null;
  if (v?.worker.corner === true && v.crew?.role === 'orch') return { slot: { index: i, pod: base.pod, ...layout.mezzanine.orch }, y: MEZZ_Y, corner: true };
  return { slot: base, y: 0, corner: false };
}

export const SEAT_Y = 0.45;
export const CARD_Y = 1.62;
export const REACH = 3;
/** #124: the props T can pick, in the order it goes through them. */
const KEY_PROPS = ['board.issues', 'board.prs', 'whiteboard', 'radio', 'elevator', 'screen.overview', 'filing'];

export interface OfficeOptions {
  shadows: boolean;
  /** The building's outline: every floor of a building is this big (see `outlineOf`). */
  outline?: Outline;
  /** #20: the name on your desk's name plate. */
  owner?: string;
}

/**
 * M4: a desk shown other than the world says while someone packs up at it
 * (`busy`: chair out, laptop in its dock, the worker drawn by the walk
 * animation) or has just left it (`empty`: chair in, no laptop, no "+").
 */
export interface AwaySeat {
  show: 'busy' | 'empty';
  display: Display;
  cue: number;
  /** M6b, packing: the sticker's harness, and how many of the desk's things are in the box already. */
  harness?: string | undefined;
  packed?: number;
}

/** M6b: a worker dropping in to its chair (see `world/arrival.ts`): how high above the seat, how squashed. */
export interface DropPose {
  dy: number;
  squash: number;
}

/** Glass seen from inside: a light tint over the street. */
export const GLASS_IN = { color: 0x9fd3f0, opacity: 0.16 };

/**
 * M17: the office's own lamps, a constant set of non-shadow spot lights under
 * the ceiling shining down on the desk area (a point light that high lights
 * the ceiling more than the desks). Adding, removing or hiding a light
 * recompiles the scene's materials, dimming one does not: they stay and only
 * their intensity moves. Two, measured on the WebGL2 fallback
 * (docs/decisions.md). Full at night, a little by day, off on an asleep floor.
 */
export const LAMPS = { count: 2, intensity: 80, night: 1, day: 0.3, below: 0.4, angle: 1.2, penumbra: 0.85, color: 0xffe4bf } as const;

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
let officeSerial = 0;

export class OfficeView {
  readonly root = new THREE.Group();
  /** Counts the offices built (test hook: a board update must not build another). */
  readonly serial = ++officeSerial;
  readonly layout: FloorLayout;
  readonly session: string;
  readonly cards: AtlasCards;
  /** Worker id → status as last applied to the scene. */
  readonly applied = new Map<string, Display>();
  private readonly crowd: Crowd;
  private readonly desks: DeskSet;
  private readonly props: PropMeshes;
  /** M7: the boards on the board wall (notes, flights, gong). */
  readonly boards: BoardsView;
  private readonly seats: Array<WorkerView | null>;
  private readonly anchors: Array<THREE.Vector3 | null>;
  private readonly static: THREE.Object3D[] = [];
  private readonly ceiling: THREE.Group;
  private readonly glow: THREE.MeshBasicMaterial[] = [];
  /** M17: the lamps, the window glass, and the time of day they follow. */
  private readonly lamps: THREE.SpotLight[] = [];
  private readonly glassMat: THREE.MeshBasicNodeMaterial;
  private look: Look = lookOf(NOON);
  private readonly door: THREE.Mesh;
  private readonly doorClosedZ: number;
  private doorOpen = 0;
  private readonly outlineKey: string;
  private readonly propTargets: Array<Pickable<Target>>;
  private readonly blockers: Box3[];
  private readonly mezz: MezzanineView;
  private readonly ownDesk: Pickable<Target>;
  private overlook = false;
  /** M7: notes, flights or the gong moved on the last frame (the game keeps its frame rate up meanwhile). */
  boardsBusy = false;
  private asleep = false;
  private cardsDirty = true;
  /** Walking obstacles and pick targets, until a seat changes. */
  private obstacleCache: Rect[] | null = null;
  private targetCache: Array<Pickable<Target>> | null = null;
  private targetOwnCache: Array<Pickable<Target>> | null = null;
  private cardCam: THREE.PerspectiveCamera | null = null;
  /** M4: desks someone is packing up at or has just left (see `setAway`). */
  private readonly away = new Map<number, AwaySeat>();
  /** M6b: workers dropping in to their chairs (see `setDrop`). */
  private readonly drops = new Map<number, DropPose>();
  /** M6b: each desk's things. */
  readonly kits: DeskKit[];
  /** M6c: the in-trays, and what each orchestrator's holds (by desk, oldest first). */
  private readonly tray: TrayView;
  private readonly trayTones = new Map<number, ReadonlyArray<StampTone | null>>();
  /** M6c: freelancers out of their chairs with a report, orchestrators swivelled to take one, reports waiting their turn. */
  private readonly outs = new Map<number, OutPose>();
  private readonly swivels = new Map<number, SwivelPose>();
  private readonly waiting = new Set<number>();
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
    this.glassMat = glassMat;
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
    // The lamps: evenly across the desk area's width, under the ceiling panels.
    const da = L.deskArea;
    for (let i = 0; i < LAMPS.count; i++) {
      const lamp = new THREE.SpotLight(LAMPS.color, 0, 0, LAMPS.angle, LAMPS.penumbra, 2);
      lamp.name = `office.lamp${i}`;
      lamp.castShadow = false;
      const x = da.x0 + ((i + 0.5) * (da.x1 - da.x0)) / LAMPS.count;
      const z = (da.z0 + da.z1) / 2;
      lamp.position.set(x, L.height - LAMPS.below, z);
      lamp.target.position.set(x, 0, z);
      this.lamps.push(lamp);
      this.root.add(lamp, lamp.target);
    }

    this.props = buildProps(L.props, L, view.level ? `${view.level.number}` : '·');
    this.root.add(this.props.group);
    this.boards = new BoardsView(L.props, L.height, (id, tex) => this.props.swapBoard(id, tex));
    this.root.add(this.boards.group);

    this.kits = L.slots.map((s) => deskKit(s));
    this.desks = new DeskSet(L.desks, o.shadows, { plus: true, kits: this.kits });
    this.crowd = new Crowd(L.desks, o.shadows);
    this.tray = new TrayView(L.desks, o.shadows);
    this.root.add(this.desks.group, this.crowd.group, this.tray.group);

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

  /** M4: shows a desk as `a` says instead of as the world does (null: as the world does again). M6b: each thing packed leaves the desk as it goes. */
  setAway(desk: number, a: AwaySeat | null): void {
    const cur = this.away.get(desk) ?? null;
    if (cur === a || (cur && a && cur.show === a.show && cur.display === a.display && cur.cue === a.cue && cur.harness === a.harness && cur.packed === a.packed)) return;
    if (!this.layout.slots[desk]) return;
    if (a) this.away.set(desk, a);
    else this.away.delete(desk);
    this.setSeat(desk, this.seats[desk] ?? null);
  }

  /**
   * M6b: the worker at `desk` drops in to its chair (null: sitting as usual).
   * Only its figure moves: the desk stays the worker's, card, look-at and all.
   */
  setDrop(desk: number, d: DropPose | null): void {
    const cur = this.drops.get(desk) ?? null;
    if (cur === d || (cur && d && cur.dy === d.dy && cur.squash === d.squash)) return;
    if (d) this.drops.set(desk, d);
    else this.drops.delete(desk);
    const at = seatOf(this.layout, desk, this.seats[desk] ?? null);
    const v = this.seats[desk];
    if (!at || !v || this.away.has(desk) || this.lean === desk || this.outs.has(desk)) return;
    this.crowd.set(desk, this.seated(desk, at.slot, memberOf(v), at.y));
  }

  /**
   * M6c: the freelancer at `desk` is out of its chair with its report (null: back, or never left). Its desk is still
   * its own: the laptop screen stays live, its card shows, picking it reaches it; only the figure is the walker's
   * (drawn by the arrivals) and the chair is pushed back `chair` of the way.
   */
  setOut(desk: number, o: OutPose | null): void {
    const cur = this.outs.get(desk) ?? null;
    if (cur === o || (cur && o && cur.chair === o.chair)) return;
    const toggled = !cur !== !o;
    if (o) this.outs.set(desk, o);
    else this.outs.delete(desk);
    const v = this.seats[desk] ?? null;
    if (toggled || !v) this.setSeat(desk, v);
    else {
      // Only the chair moved.
      const d = this.desks.get(desk);
      if (d) this.desks.set(desk, { ...d, chair: o?.chair ?? 0 });
    }
  }

  /** M6c: the orchestrator at `desk` swivels in its chair to the freelancer at its side (null: facing its desk). */
  setSwivel(desk: number, sw: SwivelPose | null): void {
    const cur = this.swivels.get(desk) ?? null;
    if (cur === sw || (cur && sw && cur.turn === sw.turn && cur.reach === sw.reach)) return;
    if (sw) this.swivels.set(desk, sw);
    else this.swivels.delete(desk);
    const v = this.seats[desk];
    const at = seatOf(this.layout, desk, v ?? null);
    if (!at || !v || this.away.has(desk) || this.lean === desk) return;
    this.crowd.set(desk, this.seated(desk, at.slot, memberOf(v), at.y));
  }

  /** M6c: reports waiting their turn to be handed in: these freelancers sit with the folder held out towards the orchestrator. */
  setWaiting(desks: Iterable<number>): void {
    const next = new Set(desks);
    const changed = [...next, ...this.waiting].filter((d) => next.has(d) !== this.waiting.has(d));
    this.waiting.clear();
    for (const d of next) this.waiting.add(d);
    for (const d of changed) this.setSeat(d, this.seats[d] ?? null);
  }

  /** M6c: what an orchestrator's in-tray holds (verdict tones, oldest first). */
  setTray(desk: number, tones: ReadonlyArray<StampTone | null>): void {
    const cur = this.trayTones.get(desk);
    if (cur && cur.length === tones.length && cur.every((t, i) => t === tones[i])) return;
    this.trayTones.set(desk, tones);
    this.drawTray(desk);
    // The freelancers of this desk's orchestrator hold nothing out any more once its tray is on this floor.
    this.seats.forEach((w, i) => {
      if (w?.crew?.life === 'reporting' && w.crew.orchId && w.crew.orchId === this.seats[desk]?.worker.id) this.setSeat(i, w);
    });
  }

  /** M6c: the in-tray of the orchestrator seated at `desk` (none for anyone else). */
  private drawTray(desk: number): void {
    const v = this.seats[desk] ?? null;
    const at = seatOf(this.layout, desk, v);
    if (!v || !at || v.crew?.role !== 'orch') {
      this.tray.set(desk, null);
      return;
    }
    this.tray.set(desk, { x: at.slot.seat.x, y: at.y, z: at.slot.seat.z, yaw: at.slot.yaw, side: this.kits[desk]?.side ?? 1 }, this.trayTones.get(desk) ?? []);
  }

  /** M6c: the in-tray of desk `desk` (test hook). */
  trayInfo(desk: number): ReturnType<TrayView['info']> {
    return this.tray.info(desk);
  }

  /** M6c: the desks whose orchestrator sits in the corner office (their screens, cards and prints are not drawn on the floor slot). */
  cornerDesks(): number[] {
    return this.seats.flatMap((v, i) => (seatOf(this.layout, i, v)?.corner ? [i] : []));
  }

  /** M6c: the desks whose worker is out delivering a report (test hook). */
  outDesks(): number[] {
    return [...this.outs.keys()];
  }

  /** M6c: the desk (index) where this orchestrator worker sits on this floor, -1 when not here. */
  deskOf(workerId: string): number {
    return this.seats.findIndex((w) => w?.worker.id === workerId);
  }

  /** M6b: desks with a worker dropping in (test hook). */
  dropping(): number[] {
    return [...this.drops.keys()];
  }

  /** A worker in its chair (dropping in, if it is; M6c: swivelled to take a report, if it is). `y`: the floor level (the corner office's). */
  private seated(i: number, s: DeskSlot, mem: ReturnType<typeof memberOf>, y = 0): Member {
    const d = this.drops.get(i);
    const sw = this.swivels.get(i);
    const side = this.kits[i]?.side ?? 1;
    return {
      x: s.seat.x,
      y: y + SEAT_Y + (d?.dy ?? 0),
      z: s.seat.z,
      yaw: s.yaw,
      scale: 1,
      ...mem,
      deskSide: side,
      ...(d && d.squash !== 1 ? { squash: d.squash } : {}),
      ...(sw ? { swivel: sw.turn, reach: sw.reach } : {}),
    };
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
    const at = seatOf(this.layout, i, v);
    if (!at) return;
    const { slot: s, y: y0 } = at;
    this.seats[i] = v;
    this.obstacleCache = this.targetCache = this.targetOwnCache = null;
    const mem = v ? memberOf(v) : null;
    if (mem?.crew && v?.crew?.life === 'reporting' && v.crew.orchId) {
      const o = this.seats.findIndex((x) => x?.worker.id === v.crew?.orchId);
      // M6c: its orchestrator is on this floor: the report was handed over (or is waiting its turn: held out towards the orchestrator).
      // Otherwise (another floor) it keeps holding the folder out, as ever.
      if (o < 0) mem.crew.turn = 0;
      else if (this.waiting.has(i)) mem.crew.turn = turnTowards(s, seatOf(this.layout, o, this.seats[o] ?? null)?.slot);
      else mem.crew = { ...mem.crew, life: 'idle', stamp: null };
    }
    const away = this.away.get(i);
    if (away) {
      // Someone is packing up or has just left: the animation draws them, the desk waits without its "+".
      const busy = away.show === 'busy';
      this.desks.set(i, { x: s.seat.x, y: 0, z: s.seat.z, yaw: s.yaw, scale: 1, display: busy ? away.display : null, cueColor: away.cue, plus: false, harness: away.harness, packed: away.packed ?? 0 });
      this.crowd.set(i, null);
      this.anchors[i] = null;
      this.cards.setCard(i, null);
      this.tray.set(i, null);
      if (v) this.applied.set(v.worker.id, v.display);
      this.cardsDirty = true;
      return;
    }
    const out = this.outs.get(i);
    this.desks.set(i, {
      x: s.seat.x,
      y: y0,
      z: s.seat.z,
      yaw: s.yaw,
      scale: 1,
      display: mem?.display ?? null,
      cueColor: mem?.cue.color ?? 0xffffff,
      harness: v ? resolveHarness(v.worker) : undefined,
      // M6b: a freelancer brings its briefcase, no keepsakes.
      personal: !v?.crew?.freelancer,
      // M6c: an orchestrator's in-tray stands where its notebook would.
      ...(v?.crew?.role === 'orch' ? { notebook: false } : {}),
      ...(out ? { chair: out.chair } : {}),
    });
    if (v && mem && this.lean === i) {
      // M5: you sit at its laptop; it stands beside the chair, turned to watch the screen.
      const fx = Math.sin(s.yaw);
      const fz = Math.cos(s.yaw);
      const x = s.seat.x - fz * 0.62 + fx * 0.3;
      const z = s.seat.z + fx * 0.62 + fz * 0.3;
      const yaw = Math.atan2(s.seat.x + fx * SEAT_OFFSET - x, s.seat.z + fz * SEAT_OFFSET - z);
      this.crowd.set(i, { x, y: y0, z, yaw, scale: 1, ...mem, stride: 0, deskSide: this.kits[i]?.side ?? 1 });
      this.anchors[i] = new THREE.Vector3(x, y0 + CARD_Y + 0.25, z);
      this.cards.setCard(i, cardOf(v, v.worker.id === this.focusId));
      this.applied.set(v.worker.id, v.display);
    } else if (v && mem) {
      // M6c: out of its chair with a report, only the walker is drawn; the desk, the card and the pick stay.
      this.crowd.set(i, out ? null : this.seated(i, s, mem, y0));
      this.anchors[i] = new THREE.Vector3(s.seat.x, y0 + CARD_Y, s.seat.z);
      this.cards.setCard(i, cardOf(v, v.worker.id === this.focusId));
      this.applied.set(v.worker.id, v.display);
    } else {
      this.crowd.set(i, null);
      this.anchors[i] = null;
      this.cards.setCard(i, null);
    }
    this.drawTray(i);
    this.cardsDirty = true;
  }

  /** Lights off on an asleep floor: the ceiling panels and the lamps here, the room light in the walk scene. */
  private setAsleep(asleep: boolean): void {
    this.asleep = asleep;
    for (const m of this.glow) m.color.set(asleep ? 0x3a3f58 : 0xfff6dd);
    this.applyLight();
  }

  /** M17: the time of day: the lamps (with the asleep state, neither overwrites the other) and the window glass. */
  setDaylight(look: Look): void {
    this.look = look;
    this.applyLight();
    this.props.clock?.setDay(look.day);
  }

  private applyLight(): void {
    const k = this.asleep ? 0 : LAMPS.intensity * (LAMPS.night + (LAMPS.day - LAMPS.night) * this.look.day);
    for (const l of this.lamps) l.intensity = k;
    this.glassMat.color.copy(this.look.glass);
    this.glassMat.opacity = this.look.glassOpacity;
  }

  /** M17: what the wall clock shows. */
  setClock(face: Pick<ClockFace, 'time' | 'date'>): void {
    this.props.clock?.set(face);
  }

  /** M17: the clock's face and the lamps' intensity (test hook). */
  lightInfo(): { lamps: number[]; clock: ClockFace | null } {
    return { lamps: this.lamps.map((l) => +l.intensity.toFixed(3)), clock: this.props.clock?.shown ?? null };
  }

  /** M13: the whiteboard's render (null: the placeholder); `whiteboardShown` says which (test hook). */
  setWhiteboard(tex: THREE.Texture | null): void {
    this.props.setWhiteboard(tex);
    this.whiteboardShown = tex ? (tex.userData.key as string | undefined) ?? 'render' : null;
  }

  whiteboardShown: string | null = null;

  /** #223: the filing cabinet's drawers fill with the floor's handoffs. */
  setDrawers(fill: readonly [number, number, number]): void {
    this.props.setDrawers(fill);
  }

  /** #223: the folder tabs each drawer shows (test hook). */
  drawers(): [number, number, number] | null {
    return this.props.drawers();
  }

  /** M15: what the radio's display says (null: off) and whether its LED glows. */
  setRadio(display: string | null, playing: boolean): void {
    this.props.radio?.set(display, playing);
  }

  /** M13: what the screen-share TV shows: the share's texture (`w × h` video), or its sign (null). */
  setScreen(tex: THREE.Texture | null, w: number, h: number, paused: boolean): void {
    this.props.tv?.show(tex, w, h, paused);
  }

  /** M13: what the TV shows (test hook); null without one. */
  screenInfo(): ReturnType<NonNullable<PropMeshes['tv']>['info']> | null {
    return this.props.tv?.info() ?? null;
  }

  /** #118: what the lounge wall's overview screen shows (null: the floor sleeps); `calm`: no blinking. */
  setOverview(data: OverviewData | null, calm: boolean, now: number): void {
    this.props.overview?.set(data, this.session, calm, now);
  }

  /** #118: the wall screen's blink and paging (only while `camera` sees it); true when its picture changed. */
  tickOverview(now: number, camera: THREE.Camera): boolean {
    const ov = this.props.overview;
    if (!ov) return false;
    const p = this.layout.props.find((x) => x.id === 'screen.overview');
    let view = false;
    if (p && this.root.visible) {
      this.ovBox.min.fromArray(p.box.min);
      this.ovBox.max.fromArray(p.box.max);
      this.ovBox.applyMatrix4(this.root.matrixWorld);
      this.ovFrustum.setFromProjectionMatrix(this.ovMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      // In view and big enough to read: the share of the view's height its middle spans (a far glimpse pages nothing).
      if (this.ovFrustum.intersectsBox(this.ovBox)) {
        const c = this.ovBox.getCenter(this.ovV.set(0, 0, 0));
        const h = (this.ovBox.max.y - this.ovBox.min.y) / 2;
        const top = this.ovV2.set(c.x, c.y + h, c.z).project(camera).y;
        const bottom = this.ovV.set(c.x, c.y - h, c.z).project(camera).y;
        this.ovShare = Math.abs(top - bottom) / 2;
        view = this.ovShare >= OVERVIEW_READABLE;
      } else this.ovShare = 0;
    }
    return ov.tick(now, view);
  }

  /** #118: the share of the view's height the wall screen spans (test hook). */
  ovShare = 0;
  private readonly ovV = new THREE.Vector3();
  private readonly ovV2 = new THREE.Vector3();

  private readonly ovBox = new THREE.Box3();
  private readonly ovFrustum = new THREE.Frustum();
  private readonly ovMat = new THREE.Matrix4();

  /** #118: what the wall screen shows (test hook); null without one. */
  overviewInfo(): (ReturnType<NonNullable<PropMeshes['overview']>['info']> & { share: number }) | null {
    const i = this.props.overview?.info();
    return i ? { ...i, share: +this.ovShare.toFixed(3) } : null;
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
        // M6c: a corner seat is up on the mezzanine, and the desk it left is not there to bump into.
        if (seatOf(this.layout, i, v)?.corner) out[i] = { x0: -99, z0: -99, x1: -98, z1: -98 };
        else if ((v || this.away.get(i)?.show === 'busy') && s) out.push(seatRect(s));
      });
      this.obstacleCache = out;
    }
    return this.obstacleCache;
  }

  /** Everything a look can pick: the props, the workers and the free desks. */
  private pickables(): Array<Pickable<Target>> {
    if (!this.targetCache) {
      const targets: Array<Pickable<Target>> = [...this.propTargets];
      this.layout.slots.forEach((slot, i) => {
        const v = this.seats[i];
        const at = seatOf(this.layout, i, v ?? null);
        const s = at?.slot ?? slot;
        const b = at?.y ? liftBoxes(slotBoxes(s), at.y) : slotBoxes(s);
        if (v) targets.push({ boxes: [b.seat, b.desk], value: { kind: 'worker', id: v.worker.id, name: v.name, label: v.worker.label, desk: i } });
        // A desk someone is packing up at, or a hire is on its way to, is not free to hire at.
        else if (!this.away.has(i)) targets.push({ boxes: [b.desk, b.plus], value: { kind: 'desk', id: `desk-${i}`, desk: i, label: `Desk ${i + 1}` } });
      });
      this.targetCache = targets;
    }
    return this.targetCache;
  }

  /** What the centre of the screen looks at, within reach; `ownDesk: false` leaves your desk out (#20). */
  pick(origin: V3, dir: V3, reach = REACH, ownDesk = true): Target | null {
    const targets = this.pickables();
    this.targetOwnCache ??= [...targets, this.ownDesk];
    return pickNearest(origin, dir, ownDesk ? this.targetOwnCache : targets, reach, this.blockers)?.value ?? null;
  }

  /**
   * #124: what the keyboard can pick (T) without aiming: every worker and free desk in desk order, then your desk (`ownDesk`),
   * the Issues and Pull requests boards, the whiteboard, the radio, the elevator and the lounge's overview screen (the things E, P, C, X or R do
   * something to), each with the point to turn to.
   */
  keyTargets(ownDesk: boolean): Array<{ target: Target; at: V3 }> {
    const centre = (b: Box3): V3 => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    const all = ownDesk ? [...this.pickables(), this.ownDesk] : this.pickables();
    const rank = (t: Target): number => {
      if (t.kind === 'worker' || t.kind === 'desk') return 0;
      if (t.kind === 'own-desk') return 1;
      const i = KEY_PROPS.indexOf(t.id);
      return i < 0 ? -1 : 2 + i;
    };
    return all
      .flatMap((p) => {
        const box = p.value.kind === 'desk' ? p.boxes[1] : p.boxes[0];
        return box && rank(p.value) >= 0 ? [{ target: p.value, at: centre(box), r: rank(p.value), d: p.value.kind === 'worker' || p.value.kind === 'desk' ? p.value.desk : 0 }] : [];
      })
      .sort((x, y) => x.r - y.r || x.d - y.d)
      .map(({ target, at }) => ({ target, at }));
  }

  /** Is this still there to act on (the worker still sits at that desk, the desk is still free)? */
  stillPickable(t: Target): boolean {
    if (t.kind === 'worker') return this.seats[t.desk]?.worker.id === t.id;
    if (t.kind === 'desk') return !this.seats[t.desk] && !this.away.has(t.desk);
    return true;
  }

  /** Cards on screen with what they say (tests); M5: `tall` when drawn with the question / usage room. */
  shownCards(): Array<CardData & { desk: number; tall: boolean }> {
    const tall = new Set(this.cards.shownTall());
    return this.cards.shown().flatMap((desk) => {
      const c = this.cards.card(desk);
      return c ? [{ desk, ...c, tall: tall.has(desk) }] : [];
    });
  }

  /** M6: the crew members seated here with what is drawn at their desks, and the crew parts drawn at all (test hook). */
  crewInfo(): { members: CrewInfo[]; shown: string[] } {
    const members = this.seats.flatMap((v, i) =>
      v?.crew
        ? [{ id: v.worker.id, name: v.name, desk: i, role: v.crew.role, life: v.crew.life, overCap: v.crew.overCap, stamp: v.crew.stamp?.text ?? null, run: v.crew.run, display: v.display, parts: this.crowd.crewAt(i), out: this.outs.has(i) }]
        : [],
    );
    return { members, shown: this.crowd.crewShown() };
  }

  seat(i: number): WorkerView | null {
    return this.seats[i] ?? null;
  }

  /** M6b: what desk `i` draws (test hook): its parts, and the docked laptop's sticker. */
  deskInfo(i: number): { parts: Record<string, number>; sticker: { logo: string; rim: number } | null; side: 1 | -1; band: string | null } | null {
    const k = this.kits[i];
    if (!k) return null;
    return { parts: this.desks.drawn(i) as Record<string, number>, sticker: this.desks.sticker(i), side: k.side, band: this.desks.band(i) };
  }

  /** Animates and lays out cards; call once per rendered frame. */
  frame(t: number, camera: THREE.PerspectiveCamera | THREE.OrthographicCamera, cardCam: THREE.PerspectiveCamera, vp: { width: number; height: number }, moved: boolean): void {
    this.crowd.update(t);
    this.desks.update(t, camera);
    this.boardsBusy = this.boards.frame(performance.now());
    this.cardCam = cardCam;
    this.cards.update(cardCam, this.anchors, vp, moved || this.cardsDirty);
    this.cardsDirty = false;
  }

  dispose(): void {
    this.cards.dispose();
    this.mezz.dispose();
    this.crowd.dispose();
    this.desks.dispose();
    this.tray.dispose();
    this.boards.dispose();
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

/** Pick boxes lifted `dy` (a desk up in the corner office). */
function liftBoxes<T extends Record<string, Box3>>(b: T, dy: number): T {
  return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, { min: [v.min[0], v.min[1] + dy, v.min[2]], max: [v.max[0], v.max[1] + dy, v.max[2]] }])) as T;
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
