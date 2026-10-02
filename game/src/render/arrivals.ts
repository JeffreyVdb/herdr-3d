import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { attribute, mix, texture, uv, vec2 } from 'three/tsl';
import { deliveryTimeline, deskOwners, poseAt, timeline, type ArrivalKind, type ArrivalPose, type Carry, type DeskShow, type Timeline } from '../world/arrival';
import type { CrewLook } from './crewLook';
import type { Display, ModelCue } from '../world/derive';
import { deskKit, LAPTOP, PACK_BOX, STICKER_D, type DeskItem, type DeskKit, type ItemKind } from '../world/deskKit';
import type { Waypoint } from '../world/route';
import { Crowd } from './crowd';
import { stickerAtlas, stickerLogo, STICKER_LOGOS } from './deskArt';
import { itemGeometry, itemMatrix, laptopGeometry, laptopMatrix, PEN_AT, penGeometry, tintMaterial } from './desks';
import type { AwaySeat, DropPose, OutPose, SwivelPose } from './office';
import { edgeGeometry, folderGeometry } from './tray';
import { TRAY_FOLDER_SCALE } from '../world/delivery';

/**
 * M4: workers walking out (sent home: packs a cardboard box at the desk,
 * takes the laptop, walks the fire escape down and away along the sidewalk).
 * The timeline is `world/arrival.ts`; this draws it: a small crowd of
 * standing workers, and a box, the desk's keepsakes and the closed laptop per
 * walker — one InstancedMesh per prop part (instance = the walker's crowd
 * slot), like the crowd's own parts. Everything is in absolute building
 * coordinates (y = feet above the street); the app shifts `group` down by the
 * walk scene's base.
 *
 * M6b: the box stands on the keyboard, and the packing takes the desk's own
 * things (its photos, mug, plant, notebook and pens, `world/deskKit.ts`) one
 * by one from where they stand, in an arc into the box, then lifts the laptop
 * out of its dock and lays it on top. A new hire drops in instead of walking:
 * the office draws the worker itself (it is at its desk from the first frame,
 * `OfficeView.setDrop` only moves the figure); this adds the landing shadow on
 * the seat and the puff of dust as it lands.
 */

export interface ArrivalSpec {
  id: string;
  kind: ArrivalKind;
  session: string;
  desk: number;
  name: string;
  /** The walk-out route (`out`); the seat (`in`). */
  route: Waypoint[];
  seatYaw: number;
  tint: number;
  cue: ModelCue;
  /** The status the worker had (the monitor while packing). */
  display: Display;
  phase: number;
  /** M6: a freelancer carries its briefcase (and waves goodbye) instead of the box. */
  carry?: Carry;
  /** M6: its crew look (worn by the walker). */
  crew?: CrewLook;
  /** M6b: the harness on its laptop's sticker. */
  harness?: string | undefined;
  /** M6c, `deliver`: the report's walk (`route`: seat → hand-over spot; it comes back the same way). Absolute building coordinates. */
  deliver?: DeliverSpec;
  /** M6c, `out`: it starts standing at `route[0]` (mid-delivery), not at its desk. */
  standing?: boolean;
}

/** M6c: what a report's walk needs besides the route. */
export interface DeliverSpec {
  /** The delivery's key in the book (`world/delivery.ts`). */
  key: string;
  /** The facing at the hand-over spot. */
  handYaw: number;
  /** The orchestrator turns in its chair to take the folder (else the freelancer puts it on the tray). */
  swivels: boolean;
  /** The orchestrator's desk index (on the freelancer's floor), and how far its chair swivels to the spot (radians). */
  orchDesk: number;
  turn: number;
  /** Where its hand takes the folder, where the folder lands on the tray, and that folder's turn; the verdict's colour on its edge. */
  hand: { x: number; y: number; z: number };
  tray: { x: number; y: number; z: number; yaw: number };
  edge: number;
}

interface Active {
  spec: ArrivalSpec;
  tl: Timeline;
  t0: number;
  slot: number;
  last: ArrivalPose | null;
  /** M6b: the desk's things (packing), in slot space. */
  kit: DeskKit | null;
  /** M6b: someone else sits at the desk now (`yieldDesk`): the walk never shows the desk again. */
  yielded: boolean;
  /** M6b: the things in its box when it gave the desk up (null: as the packing goes). */
  kept: number | null;
  /** M6c: a delivery whose folder has landed (reported once). */
  landed: boolean;
  /** M6c: a walk-out to start the moment this delivery's hand-over is done (its freelancer's workspace closed meanwhile). */
  then: ArrivalSpec | null;
}

/** What the arrivals ask of the office: a desk shown as `away` (null: as the world says again); M6b: a worker dropping in (null: seated). */
export interface DeskAway {
  session: string;
  desk: number;
  away: AwaySeat | null;
  drop?: DropPose | null;
  /** M6c: a freelancer out of its chair with a report (null: back in it). */
  out?: OutPose | null;
}

/** M6c: an orchestrator swivelled to take a report (null: facing its desk again). */
export interface SwivelOut {
  session: string;
  desk: number;
  swivel: SwivelPose | null;
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
  /** M6b: dropping in: the height over the seat. */
  dy: number;
  /** M6b: gave its desk up to whoever sits there now (see `Arrivals.yieldDesk`). */
  yielded: boolean;
  /** M6c, deliveries: the folder, how far the orchestrator has swivelled and reaches, the chair. */
  folder: ArrivalPose['folder'];
  swivel: number;
  reach: number;
  chair: number;
  landed: boolean;
  key: string | null;
}

const CAPACITY = 8;
const BOX = { w: 0.44, h: 0.28, d: 0.32 };
/** The carried box, in worker space (origin at the seat/hips, facing +z). */
const CARRY = new THREE.Vector3(0, 0.36, 0.34);
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
/** M6b: the dust puff: this many balls, and the landing shadow's radius. */
const PUFFS = 10;
const SHADOW_R = 0.3;

/** The props' parts: one InstancedMesh each (`per` instances a walker). */
type PropKey = 'body' | 'flaps' | 'tape' | 'photo' | 'mug' | 'plant' | 'notebook' | 'pens' | 'laptop' | 'sticker' | 'puff' | 'shadow' | 'fold' | 'foldEdge';
const PER: Record<PropKey, number> = { body: 1, flaps: 1, tape: 1, photo: 2, mug: 1, plant: 1, notebook: 1, pens: 2, laptop: 1, sticker: 1, puff: PUFFS, shadow: 1, fold: 1, foldEdge: 1 };

/** Where each keepsake goes in the box (box space: origin at its base centre), poking out of the top. */
function inBox(item: DeskItem): THREE.Matrix4 {
  const h = BOX.h;
  const s = item.size;
  const at: Record<ItemKind, [number, number, number, number]> = {
    photo: item.n ? [-0.11, h - 0.07, -0.09, 0.1] : [0.03, h - 0.06, -0.07, -0.08],
    mug: [-0.12, h - 0.07, 0.05, 0.4],
    plant: [0.12, h - 0.09, 0.02, 0],
    notebook: [0, 0.01, 0.05, 0.1],
  };
  const [x, y, z, yaw] = at[item.kind];
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(s, s, s));
}

/** The laptop lying on top of the box, lid up (laptop space → box space). */
const LAPTOP_FLAT = new THREE.Matrix4().makeTranslation(LAPTOP.h / 2, BOX.h + 0.1, 0).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
const STICKER_AT = new THREE.Matrix4().makeTranslation(LAPTOP.t / 2 + 0.0009, LAPTOP.h * 0.56, 0.035);

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
  private readonly tints: Record<'photo' | 'notebook', THREE.InstancedBufferAttribute>;
  private readonly rim: THREE.InstancedBufferAttribute;
  private readonly logo: THREE.InstancedBufferAttribute;
  /** Walks in the order they started, oldest first. */
  private readonly active: Active[] = [];
  private readonly free: number[] = Array.from({ length: CAPACITY }, (_, i) => CAPACITY - 1 - i);
  /** Finished (or skipped) arrivals, newest last (test hook). */
  readonly log: Array<{ id: string; kind: ArrivalKind; played: boolean; session: string; desk: number }> = [];
  /** Desks the office should show as the world says again (arrivals that just ended). */
  private released: DeskAway[] = [];
  /** M6c: orchestrators that swivelled for a walk that has ended, and those swivelled now. */
  private swivelEnded: Array<{ session: string; desk: number }> = [];
  private readonly swiveled = new Map<string, { session: string; desk: number }>();
  /** M6c: orchestrator swivels as of the last `update` (null: facing its desk again). */
  swivels: SwivelOut[] = [];
  /** M6c: deliveries whose folder landed on the tray since the last `takeLanded` (their keys). */
  private landedKeys: string[] = [];
  /** M6c: the ids of the walks that ended since the last `takeEnded`. */
  private endedIds: string[] = [];
  private readonly slotM = new THREE.Matrix4();
  private readonly boxM = new THREE.Matrix4();
  private readonly lapM = new THREE.Matrix4();
  private readonly m = new THREE.Matrix4();
  private readonly m2 = new THREE.Matrix4();
  private readonly penM = new THREE.Matrix4();
  private readonly v = new THREE.Vector3();
  private readonly pos = new THREE.Vector3();
  private readonly scl = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly boxQ = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly color = new THREE.Color();
  private readonly eul = new THREE.Euler();
  private readonly a = { p: new THREE.Vector3(), q: new THREE.Quaternion(), s: new THREE.Vector3() };
  private readonly b = { p: new THREE.Vector3(), q: new THREE.Quaternion(), s: new THREE.Vector3() };
  private rate = 1;

  constructor(shadows: boolean) {
    this.group.name = 'arrivals';
    this.crowd = new Crowd(CAPACITY, shadows);
    this.props.name = 'arrivals.props';
    this.group.add(this.crowd.group, this.props);
    const b = boxGeometry();
    const geo: Record<PropKey, THREE.BufferGeometry> = {
      ...b,
      photo: itemGeometry('photo'),
      mug: itemGeometry('mug'),
      plant: itemGeometry('plant'),
      notebook: itemGeometry('notebook'),
      pens: penGeometry(),
      laptop: laptopGeometry(),
      sticker: new THREE.CircleGeometry(STICKER_D / 2, 18).rotateY(Math.PI / 2),
      puff: new THREE.IcosahedronGeometry(0.075, 1),
      shadow: new THREE.CircleGeometry(SHADOW_R, 24).rotateX(-Math.PI / 2),
      fold: folderGeometry(),
      foldEdge: edgeGeometry(),
    };
    this.tints = {
      photo: new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 2 * 3), 3),
      notebook: new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3),
    };
    geo.photo.setAttribute('aTint', this.tints.photo);
    geo.notebook.setAttribute('aTint', this.tints.notebook);
    this.rim = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3);
    this.logo = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY), 1);
    geo.sticker.setAttribute('aRim', this.rim);
    geo.sticker.setAttribute('aLogo', this.logo);
    const stickerMat = new THREE.MeshToonNodeMaterial();
    const t = texture(stickerAtlas(), vec2(attribute('aLogo', 'float').add(uv().x).div(STICKER_LOGOS.length), uv().y));
    stickerMat.colorNode = mix(attribute('aRim', 'vec3'), t.rgb, t.a);
    const toon = (hex: number) => new THREE.MeshToonMaterial({ color: hex });
    const mats: Record<PropKey, THREE.Material> = {
      body: toon(0xc9935a),
      flaps: toon(0xd9a86e),
      tape: toon(0xa87440),
      photo: tintMaterial(),
      notebook: tintMaterial(),
      mug: new THREE.MeshToonMaterial({ color: 0xffffff, vertexColors: true }),
      plant: new THREE.MeshToonMaterial({ color: 0xffffff, vertexColors: true }),
      pens: new THREE.MeshToonMaterial({ color: 0xffffff, vertexColors: true }),
      laptop: new THREE.MeshToonMaterial({ color: 0xffffff, vertexColors: true }),
      sticker: stickerMat,
      puff: new THREE.MeshToonMaterial({ color: 0xf6f3ea }),
      shadow: new THREE.MeshBasicMaterial({ color: 0x1c2540, transparent: true, opacity: 0.3, depthWrite: false }),
      fold: new THREE.MeshToonMaterial({ color: 0xffffff, vertexColors: true }),
      foldEdge: new THREE.MeshToonMaterial({ color: 0xffffff }),
    };
    const parts: Partial<Record<PropKey, THREE.InstancedMesh>> = {};
    for (const key of Object.keys(PER) as PropKey[]) {
      const mesh = new THREE.InstancedMesh(geo[key], mats[key], CAPACITY * PER[key]);
      mesh.name = `arrivals.${key}`;
      mesh.frustumCulled = false;
      mesh.castShadow = shadows && (key === 'body' || key === 'flaps' || key === 'tape' || key === 'fold');
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      for (let i = 0; i < mesh.count; i++) mesh.setMatrixAt(i, ZERO);
      if (key === 'mug' || key === 'pens' || key === 'foldEdge') for (let i = 0; i < mesh.count; i++) mesh.setColorAt(i, this.color.set(0xffffff));
      this.props.add(mesh);
      parts[key] = mesh;
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
    // M6b: a new hire's desk is its own from the first frame, whatever a walk-out there still has to do (shown or not).
    if (spec.kind === 'in') this.yieldDesk(spec.session, spec.desk, spec.id, now);
    const slot = this.free.pop();
    if (slot === undefined || spec.route.length < (spec.kind === 'in' ? 1 : 2) || (spec.kind === 'deliver' && !spec.deliver)) {
      if (slot !== undefined) this.free.push(slot);
      this.skip(spec);
      return false;
    }
    const carry = spec.carry ?? 'box';
    const kit = spec.kind === 'out' && carry === 'box' ? deskKit({ index: spec.desk, yaw: spec.seatYaw }) : null;
    const d = spec.deliver;
    const tl =
      spec.kind === 'deliver' && d
        ? deliveryTimeline(spec.route, spec.seatYaw, { handYaw: d.handYaw, swivels: d.swivels })
        : timeline(spec.kind, spec.route, spec.seatYaw, carry, kit?.items.length ?? 0, spec.standing === true);
    this.color.set(spec.cue.color);
    this.rim.setXYZ(slot, this.color.r, this.color.g, this.color.b);
    this.logo.setX(slot, STICKER_LOGOS.indexOf(stickerLogo(spec.harness)));
    this.rim.needsUpdate = this.logo.needsUpdate = true;
    kit?.items.forEach((item) => {
      this.color.set(item.tint);
      if (item.kind === 'photo') this.tints.photo.setXYZ(slot * 2 + item.n, this.color.r, this.color.g, this.color.b);
      else if (item.kind === 'notebook') this.tints.notebook.setXYZ(slot, this.color.r, this.color.g, this.color.b);
      else if (item.kind === 'mug') this.parts.mug.setColorAt(slot, this.color);
    });
    this.tints.photo.needsUpdate = this.tints.notebook.needsUpdate = true;
    if (this.parts.mug.instanceColor) this.parts.mug.instanceColor.needsUpdate = true;
    this.active.push({ spec, tl, t0: now, slot, last: null, kit, yielded: false, kept: null, landed: false, then: null });
    this.showIfWalking();
    return true;
  }

  /** Records an arrival nobody sees (another floor, the city): it resolves at once. */
  skip(spec: Pick<ArrivalSpec, 'id' | 'kind' | 'session' | 'desk'>): void {
    this.log.push({ id: spec.id, kind: spec.kind, played: false, session: spec.session, desk: spec.desk });
    if (this.log.length > 50) this.log.shift();
  }

  /**
   * M6b: someone else (`by`) sits at `desk` now: a new hire dropping in, or
   * a worker the world moved there while the one sent home is still leaving
   * (the bridge frees a desk as its worker goes). Every walk there by
   * another worker gives the desk up for good: it never shows it `away`
   * again, not even once the newer walk is over. A walk-out still at the
   * desk gets up and goes at once, so it never packs the new worker's
   * things: its box keeps what it packed so far, its laptop on top. True
   * when a walk gave the desk up (the desk shows as the world says from the
   * next `update`).
   */
  yieldDesk(session: string, desk: number, by: string, now: number): boolean {
    let any = false;
    for (const a of this.active) {
      if (a.yielded || a.spec.id === by || a.spec.session !== session || a.spec.desk !== desk) continue;
      a.yielded = true;
      any = true;
      if (a.spec.kind !== 'out') continue;
      const at = (now - a.t0) * this.rate;
      const p = poseAt(a.tl, at);
      a.kept = p.items + (p.itemLift > 0 ? 1 : 0);
      const walk = a.tl.stages.find((s) => s.phase === 'walk');
      if (walk && at < walk.t0) a.t0 = now - walk.t0 / this.rate;
    }
    if (any) this.released.push({ session, desk, away: null, drop: null });
    return any;
  }

  /** Ends a walk early (the worker is gone, or came back); its desk shows as the world says. */
  cancel(id: string): void {
    const i = this.active.findIndex((a) => a.spec.id === id);
    if (i < 0) return;
    this.finish(i, false);
  }

  /**
   * M6c: delivery `id`'s freelancer is leaving (its workspace closed) while it is at the hand-over: when that is
   * done (its folder on the tray), `then` (the walk-out, from where it stands) takes over.
   */
  chain(id: string, then: ArrivalSpec): boolean {
    const a = this.active.find((x) => x.spec.id === id && x.spec.kind === 'deliver');
    if (!a) return false;
    a.then = then;
    return true;
  }

  /** M6c: the ids of the walks that ended (finished or cancelled) since the last call. */
  takeEnded(): string[] {
    const out = this.endedIds;
    this.endedIds = [];
    return out;
  }

  /** M6c: the keys of the deliveries whose folder landed on the tray since the last call. */
  takeLanded(): string[] {
    const out = this.landedKeys;
    this.landedKeys = [];
    return out;
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
    for (const key of Object.keys(PER) as PropKey[]) for (let k = 0; k < PER[key]; k++) this.parts[key].setMatrixAt(a.slot * PER[key] + k, ZERO);
    this.flag();
    this.showIfWalking();
    // A delivery that ends before its folder landed (cancelled): it never will; the caller says where it went.
    if (a.spec.kind === 'deliver' && a.spec.deliver) {
      if (!a.landed && played) this.landedKeys.push(a.spec.deliver.key);
      this.swivelEnded.push({ session: a.spec.session, desk: a.spec.deliver.orchDesk });
    }
    this.released.push({ session: a.spec.session, desk: a.spec.desk, away: null, drop: null, ...(a.spec.kind === 'deliver' ? { out: null } : {}) });
    this.log.push({ id: a.spec.id, kind: a.spec.kind, played, session: a.spec.session, desk: a.spec.desk });
    if (this.log.length > 50) this.log.shift();
    this.endedIds.push(a.spec.id);
  }

  /** Nobody walking: no draw calls for the props and the crowd. */
  private showIfWalking(): void {
    this.group.visible = this.active.length > 0;
  }

  private flag(): void {
    for (const key of Object.keys(PER) as PropKey[]) this.parts[key].instanceMatrix.needsUpdate = true;
  }

  /**
   * Advances every walk to time `now` (s) and draws it; returns what each
   * desk with a walk (or a walk that just ended) should show, one entry per
   * desk: the newest walk on a desk owns it (`deskOwners`), and a walk that
   * gave its desk up (`yieldDesk`) has no say in it any more.
   */
  update(now: number, t: number): DeskAway[] {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const a = this.active[i] as Active;
      const at = (now - a.t0) * this.rate;
      if (a.then) {
        // M6c: its freelancer is leaving: once the hand-over is done, it goes on from where it stands.
        const hand = a.tl.stages.find((x) => x.phase === 'hand');
        if (hand && at >= hand.t1) {
          const then = a.then;
          this.finish(i, true);
          this.start(then, now);
          continue;
        }
      }
      if (at >= a.tl.total) this.finish(i, true);
    }
    const ended = this.released;
    this.released = [];
    const walking: DeskAway[] = [];
    const swiveled = new Map<string, SwivelOut>();
    for (const a of this.active) {
      const p = poseAt(a.tl, (now - a.t0) * this.rate);
      a.last = p;
      const s = a.spec;
      if (s.kind === 'deliver' && s.deliver) {
        this.drawDeliver(a, p, s.deliver);
        if (p.landed && !a.landed) {
          a.landed = true;
          this.landedKeys.push(s.deliver.key);
        }
        walking.push({ session: s.session, desk: s.desk, away: null, out: { chair: p.chair } });
        if (s.deliver.swivels && (p.swivel > 0 || p.reach > 0)) swiveled.set(`${s.session}:${s.deliver.orchDesk}`, { session: s.session, desk: s.deliver.orchDesk, swivel: { turn: p.swivel * s.deliver.turn, reach: p.reach } });
        continue;
      }
      if (s.kind === 'in') {
        this.drawDrop(a, p);
        if (!a.yielded) walking.push({ session: s.session, desk: s.desk, away: null, drop: { dy: p.dy, squash: p.squash } });
        continue;
      }
      this.draw(a, p);
      if (a.yielded) continue;
      const packed = p.items + (p.itemLift > 0 ? 1 : 0);
      walking.push({ session: s.session, desk: s.desk, away: p.desk === 'free' ? null : { show: p.desk, display: s.display, cue: s.cue.color, harness: s.harness, packed } });
    }
    if (this.active.length) this.flag();
    this.crowd.update(t);
    const out = deskOwners(ended, walking);
    // A drop that just ended hands its figure back to the chair even when an older walk still owns that desk; M6c: so does a delivery.
    for (const e of ended) {
      const o = out.find((d) => d.session === e.session && d.desk === e.desk);
      if (o && o.drop === undefined) o.drop = null;
      if (o && e.out === null && o.out === undefined) o.out = null;
    }
    // M6c: the orchestrators swivelled now, and those that were and are not any more.
    this.swivels = [...swiveled.values()];
    for (const key of this.swiveled.keys()) if (!swiveled.has(key)) this.swivels.push({ ...(this.swiveled.get(key) as { session: string; desk: number }), swivel: null });
    for (const e of this.swivelEnded) if (!swiveled.has(`${e.session}:${e.desk}`) && !this.swivels.some((w) => w.session === e.session && w.desk === e.desk)) this.swivels.push({ ...e, swivel: null });
    this.swivelEnded = [];
    this.swiveled.clear();
    for (const [k, w] of swiveled) this.swiveled.set(k, { session: w.session, desk: w.desk });
    return out;
  }

  /** The desk slot's transform in absolute coordinates (the seat, turned the desk's way). */
  private slotMatrix(a: Active, out: THREE.Matrix4): THREE.Matrix4 {
    const seat = a.tl.route[0] ?? { x: 0, y: 0, z: 0 };
    this.q.setFromAxisAngle(this.up, a.spec.seatYaw);
    return out.compose(this.v.set(seat.x, seat.y, seat.z), this.q, this.scl.set(1, 1, 1));
  }

  /** `from` → `to` `k` of the way, on an arc `lift` high (position, turn and size). */
  private arc(from: THREE.Matrix4, to: THREE.Matrix4, k: number, lift: number, out: THREE.Matrix4): THREE.Matrix4 {
    from.decompose(this.a.p, this.a.q, this.a.s);
    to.decompose(this.b.p, this.b.q, this.b.s);
    const e = k * k * (3 - 2 * k);
    this.pos.lerpVectors(this.a.p, this.b.p, e);
    this.pos.y += Math.sin(k * Math.PI) * lift;
    return out.compose(this.pos, this.a.q.slerp(this.b.q, e), this.scl.lerpVectors(this.a.s, this.b.s, e));
  }

  /** M6b: the landing shadow on the seat while it falls, the dust puffing out round the chair as it lands. */
  private drawDrop(a: Active, p: ArrivalPose): void {
    const seat = a.tl.route[0] ?? { x: 0, y: 0, z: 0 };
    const sh = this.parts.shadow;
    if (p.shadow > 0) sh.setMatrixAt(a.slot, this.m.compose(this.v.set(seat.x, seat.y + 0.457, seat.z), this.q.identity(), this.scl.setScalar(p.shadow)));
    else sh.setMatrixAt(a.slot, ZERO);
    const puff = this.parts.puff;
    for (let k = 0; k < PUFFS; k++) {
      if (p.puff === null) {
        puff.setMatrixAt(a.slot * PUFFS + k, ZERO);
        continue;
      }
      // A ring of dust balls round the seat, billowing out and up, shrinking away.
      const u = p.puff;
      const ang = (k / PUFFS) * Math.PI * 2 + a.spec.phase;
      const out = 1 - (1 - u) ** 3;
      const r = 0.3 + 0.38 * out;
      const size = Math.max(0.001, (1 - u) ** 1.5 * (0.9 + 0.35 * (k % 3)) + 0.25 * out * (1 - u));
      this.v.set(seat.x + Math.cos(ang) * r, seat.y + 0.4 + out * 0.2 + (k % 2) * 0.06, seat.z + Math.sin(ang) * r);
      puff.setMatrixAt(a.slot * PUFFS + k, this.m.compose(this.v, this.q.identity(), this.scl.setScalar(size)));
    }
  }

  /** M6c: a freelancer walking its report over: the walker with the folder, and the folder flying to the tray. */
  private drawDeliver(a: Active, p: ArrivalPose, d: DeliverSpec): void {
    const s = a.spec;
    this.crowd.set(a.slot, {
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: p.yaw,
      scale: 1,
      tint: s.tint,
      cue: s.cue,
      display: 'idle',
      phase: s.phase,
      ...(p.seated ? {} : { stride: p.stride ?? 0 }),
      ...(s.crew ? { crew: { ...s.crew, life: null, turn: 0 } } : {}),
      ...(p.folder === 'carry' || p.folder === 'out' ? { folder: p.folder } : {}),
    });
    const P = this.parts;
    for (const key of Object.keys(PER) as PropKey[]) if (key !== 'fold' && key !== 'foldEdge') for (let k = 0; k < PER[key]; k++) P[key].setMatrixAt(a.slot * PER[key] + k, ZERO);
    if (p.folder !== 'flight') {
      P.fold.setMatrixAt(a.slot, ZERO);
      P.foldEdge.setMatrixAt(a.slot, ZERO);
      return;
    }
    // From the freelancer's hand (to the orchestrator's, if it takes it) to its place on the tray, on an arc, laying itself flat.
    const u = p.flight;
    const hand0 = { x: p.x + Math.sin(p.yaw) * 0.33 + Math.cos(p.yaw) * 0.265, y: p.y + 0.52, z: p.z + Math.cos(p.yaw) * 0.33 - Math.sin(p.yaw) * 0.265 };
    const lerp = (a0: number, a1: number, k: number) => a0 + (a1 - a0) * k;
    const e = (k: number) => k * k * (3 - 2 * k);
    let k: number;
    let from: { x: number; y: number; z: number } = hand0;
    let to: { x: number; y: number; z: number } = d.tray;
    let lift = 0.3;
    if (d.swivels) {
      if (u < 0.42) {
        k = e(u / 0.42);
        to = d.hand;
        lift = 0.06;
      } else {
        k = e((u - 0.42) / 0.58);
        from = d.hand;
        lift = 0.12;
      }
    } else k = e(u);
    const x = lerp(from.x, to.x, k);
    const y = lerp(from.y, to.y, k) + Math.sin(k * Math.PI) * lift;
    const z = lerp(from.z, to.z, k);
    // Upright and tilted in the hand, flat on the tray; turning to the tray's yaw as it goes.
    const flat = e(u);
    const yaw = p.yaw + (((d.tray.yaw - p.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * flat;
    this.q.setFromEuler(this.eul.set((Math.PI / 2 - 0.35) * (1 - flat), yaw, 0, 'YXZ'));
    const size = lerp(1 / TRAY_FOLDER_SCALE, 1, flat);
    this.m.compose(this.v.set(x, y, z), this.q, this.scl.setScalar(size));
    P.fold.setMatrixAt(a.slot, this.m);
    P.foldEdge.setMatrixAt(a.slot, this.m);
    P.foldEdge.setColorAt(a.slot, this.color.set(d.edge));
    if (P.foldEdge.instanceColor) P.foldEdge.instanceColor.needsUpdate = true;
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
    const P = this.parts;
    const slotM = this.slotMatrix(a, this.slotM);
    // The box: on the keyboard while packing, else carried in front.
    if (p.box === 'desk') {
      this.boxM.multiplyMatrices(slotM, this.m.makeTranslation(PACK_BOX.x, PACK_BOX.y, PACK_BOX.z));
      this.boxM.multiply(this.m.makeScale(Math.max(0.001, p.boxScale), Math.max(0.001, p.boxScale), Math.max(0.001, p.boxScale)));
    } else {
      const yawQ = this.q.setFromAxisAngle(this.up, p.yaw);
      this.v.copy(CARRY).multiplyScalar(p.scale).applyQuaternion(yawQ);
      this.pos.set(p.x + this.v.x, p.y + this.v.y, p.z + this.v.z);
      this.boxQ.copy(yawQ);
      this.boxM.compose(this.pos, this.boxQ, this.scl.setScalar(Math.max(0.001, p.scale)));
    }
    const boxOn = p.box !== 'none';
    for (const key of ['body', 'flaps', 'tape'] as const) P[key].setMatrixAt(a.slot, boxOn ? this.boxM : ZERO);
    // The desk's things: in the box once packed, on their way in an arc, else still on the desk (the office draws them).
    for (const key of ['photo', 'mug', 'plant', 'notebook', 'pens'] as const) for (let k = 0; k < PER[key]; k++) P[key].setMatrixAt(a.slot * PER[key] + k, ZERO);
    const kit = a.kit;
    // Gave the desk up (`yieldDesk`): what it packed so far, nothing more off the new worker's desk.
    const packed = a.kept ?? p.items;
    if (kit && boxOn) {
      kit.items.forEach((item, n) => {
        const moving = a.kept === null && n === p.items && p.itemLift > 0;
        if (n >= packed && !moving) return;
        const box = this.m2.multiplyMatrices(this.boxM, inBox(item));
        const m = moving ? this.arc(this.m.multiplyMatrices(slotM, itemMatrix(item)), box.clone(), p.itemLift, 0.16, this.m) : box;
        const idx = item.kind === 'photo' ? a.slot * 2 + item.n : a.slot;
        if (item.kind === 'notebook') {
          P.notebook.setMatrixAt(idx, m);
          // Each pen from the notebook's own matrix (`m` may be `m2`).
          for (let k = 0; k < item.pens; k++) P.pens.setMatrixAt(a.slot * 2 + k, this.penM.multiplyMatrices(m, PEN_AT[k] as THREE.Matrix4));
        } else P[item.kind].setMatrixAt(idx, m);
      });
    }
    // The laptop: in its dock until it is taken (the office draws it), then lifted out and laid on the box, and carried.
    const lapOn = p.laptop === 'lift' || p.laptop === 'carried';
    if (lapOn) {
      const onBox = this.lapM.multiplyMatrices(this.boxM, LAPTOP_FLAT);
      if (p.laptop === 'lift' && kit) this.arc(this.m.multiplyMatrices(slotM, laptopMatrix(kit)), onBox.clone(), p.lift, 0.2, this.lapM);
      P.laptop.setMatrixAt(a.slot, this.lapM);
      P.sticker.setMatrixAt(a.slot, this.m.multiplyMatrices(this.lapM, STICKER_AT));
    } else {
      P.laptop.setMatrixAt(a.slot, ZERO);
      P.sticker.setMatrixAt(a.slot, ZERO);
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
        items: a.kept ?? p.items,
        carry: a.tl.carry,
        briefcase: p.briefcase,
        wave: p.wave,
        dy: p.dy,
        yielded: a.yielded,
        folder: p.folder,
        swivel: p.swivel,
        reach: p.reach,
        chair: p.chair,
        landed: p.landed,
        key: a.spec.deliver?.key ?? null,
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
