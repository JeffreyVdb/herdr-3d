import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rayBox } from '../world/collide';
import type { Display } from '../world/derive';
import { floorLayout, outlineOf, ROOM_HEIGHT, type Box3, type FloorLayout } from '../world/layout';
import type { BuildingView, FloorView, WorkerView } from '../world/store';
import { FONT } from './cards/atlasCards';
import { letterbox } from './logoFit';
import type { LogoEntry } from './logos';
import { logoMaterial } from './logoSign';
import { BadgeLayer } from './badges';
import { lookOf, NOON, sceneDir, type Look } from './daylook';
import { normalBiasFor, SHADOW_MAP } from './toonSun';
import { Crowd } from './crowd';
import { DeskSet } from './desks';
import { MEZZ_COLORS } from './mezzanine';
import { memberOf, SEAT_Y } from './office';
import { BUILDING_TINTS, GRASS, LOT_TINT, OFFICE, ROAD } from './palette';

/**
 * The city: every building as a dollhouse of open-front floors (north and
 * west walls, knee walls to the south and east), each floor a scaled-down
 * copy of its office with the same desks and workers. Lights on for running
 * floors, dark with zZz for asleep ones, and a count badge per floor (in the
 * scene, see badges.ts) plus a static, accessible floor list in the DOM.
 */

export const CITY_SCALE = 0.22;
const S = CITY_SCALE;
// Dollhouse ceilings to scale: the rooms are tall (#20), so a low camera still sees to the back wall.
const FH = ROOM_HEIGHT * S + 0.08;
const GAP = 3.2;
const SLAB = 0.07;

interface FloorSlot {
  /** #58: the floor id. */
  id: string;
  building: number;
  view: FloorView;
  layout: FloorLayout;
  /** World box of the floor (picking, framing). */
  box: Box3;
  origin: THREE.Vector3;
  deskBase: number;
  /** Entry in the accessible floor list. */
  button: HTMLButtonElement;
  index: number;
  anchor: THREE.Vector3;
}

export interface BuildingFrame {
  center: THREE.Vector3;
  radius: number;
  name: string;
}

/** M3d: the sign in front of a building, lit while any of its floors is running. */
const SIGN = { lit: 0xfff6dd, dim: 0x3a3f5c, logoLit: 0xffffff, logoDim: 0x5b6182, tilt: 0.38, thick: 0.035 };

interface SignSpot {
  /** Building id, null for the lot (which has no logo). */
  id: string | null;
  bi: number;
  /** Middle of the front edge, and the building's width. */
  x: number;
  z: number;
  w: number;
}

interface SignMark {
  spot: SignSpot;
  logo: THREE.Mesh;
  instance: number;
  entry: LogoEntry;
  lit: boolean;
}

/**
 * #146: the dollhouses' shadow-casting box parts (one geometry, one toon material, a colour per instance) are one
 * InstancedMesh: a floor's part `k` is its instance `k * floors + floor`. One mesh is one program (two with shadows),
 * where six were six. Drawn in the order the separate meshes were (all slabs, then all north walls, …). The mezzanine
 * stays its own mesh, drawn after the strips, bands and rugs as before: in the merged mesh it was drawn before them and
 * an edge where its deck meets a window band came out another colour (one pixel of the demo city).
 */
const BOX_PARTS = ['slab', 'wallN', 'wallW', 'kneeS', 'kneeE', 'pillar'] as const;
type BoxPart = (typeof BOX_PARTS)[number];
type Part = BoxPart | 'strip' | 'band' | 'rug' | 'mezz' | 'glow';
type Parts = Record<Exclude<Part, BoxPart> | 'box', THREE.InstancedMesh>;

const color = new THREE.Color();

function lighten(hex: number, k: number): number {
  return color.set(hex).lerp(new THREE.Color(0xffffff), k).getHex();
}

function darken(hex: number, k: number): number {
  return color.set(hex).lerp(new THREE.Color(0x262b45), k).getHex();
}

export class CityView {
  readonly scene = new THREE.Scene();
  readonly applied = new Map<string, Display>();
  private floors: FloorSlot[] = [];
  private readonly byFloor = new Map<string, FloorSlot>();
  private buildings: BuildingFrame[] = [];
  private bounds = new THREE.Box3();
  private crowd: Crowd | null = null;
  private desks: DeskSet | null = null;
  private parts: Parts | null = null;
  /** The floors `parts.box` holds of each box part. */
  private partFloors = 0;
  private badgeLayer: BadgeLayer | null = null;
  private dynamic = new THREE.Group();
  private readonly sun: THREE.DirectionalLight;
  /** M17: the sky light, and the time of day both follow (see `setDaylight`). */
  private readonly hemi = new THREE.HemisphereLight(0xeaf6ff, 0x7ba36a, 1.35);
  private look: Look = lookOf(NOON);
  /** Where the sun stood before M17 (its noon): its bearing and distance from the city's centre. */
  private sunFrame = { heading: 148, dist: 10, target: new THREE.Vector3() };
  private readonly tmp = new THREE.Vector3();
  /** M17: the running floors' room light at night, a warm haze inside each (additive; nothing by day). */
  private readonly glowMat = new THREE.MeshBasicMaterial({ color: 0xffb561, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  private hover: string | null = null;
  private readonly v = new THREE.Vector3();
  private readonly workerSlot = new Map<string, number>();
  /** Accessible building entries (M3): each opens the building's elevator panel. */
  private buildingButtons: HTMLButtonElement[] = [];
  /** Building id per city building index, null for the lot. */
  private buildingIds: Array<string | null> = [];
  /** M3d: logos by building id, and the signs built from them. */
  private logos = new Map<string, LogoEntry>();
  private spots: SignSpot[] = [];
  private readonly signs = new THREE.Group();
  private marks: SignMark[] = [];
  private plates: THREE.InstancedMesh | null = null;

  constructor(
    private readonly badgeParent: HTMLElement,
    private readonly shadows: boolean,
    private readonly onEnter: (floor: string) => void,
    private readonly buildingParent: HTMLElement | null = null,
    private readonly onBuilding: (building: string | null) => void = () => {},
  ) {
    this.scene.background = new THREE.Color(0x9fd6ff);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff1dc, 2.3);
    this.sun.castShadow = shadows;
    this.sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    this.sun.shadow.bias = -0.0008;
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(this.dynamic);
    this.signs.name = 'city.signs';
    this.scene.add(this.signs);
  }

  /**
   * M17: the time of day. The dollhouses are lit (toon), so the sky light and
   * the sun dim and warm; the running floors' window bands and ceiling strips
   * are unlit colour and keep glowing, so at night the city shows which
   * floors are alive. A moonlit fill keeps the rooms readable.
   */
  setDaylight(look: Look): void {
    this.look = look;
    const k = look.day;
    (this.scene.background as THREE.Color).copy(look.citySky);
    this.hemi.intensity = 0.42 + (1.4 - 0.42) * k;
    this.hemi.color.set(0x5a6aa8).lerp(new THREE.Color(0xeaf6ff), k);
    this.hemi.groundColor.set(0x1c2436).lerp(new THREE.Color(0x7ba36a), k);
    this.sun.intensity = 0.35 + (2.4 - 0.35) * k;
    this.sun.color.copy(look.sunColor);
    this.glowMat.opacity = 0.2 * look.lamps;
    this.placeSun();
  }

  private placeSun(): void {
    const f = this.sunFrame;
    sceneDir(this.look.sunDir, f.heading, this.tmp);
    this.sun.position.copy(f.target).addScaledVector(this.tmp, f.dist);
  }

  /** Rebuilds everything from the store's city (on structural changes). */
  build(city: BuildingView[]): void {
    this.clear();
    // Footprints first: every floor of a building shares its outline (its biggest floor), as walked.
    let x = 0;
    const plans = city.map((b, bi) => {
      const outline = outlineOf(b.floors.map((f) => f.desks));
      const layouts = b.floors.map((f) => floorLayout(f.desks, outline));
      const w = outline.width * S;
      const d = outline.depth * S;
      const plan = { b, bi, layouts, x0: x, w, d };
      x += w + GAP;
      return plan;
    });
    const totalW = Math.max(0, x - GAP);
    const maxD = Math.max(4, ...plans.map((p) => p.d));
    const offX = -totalW / 2;
    const offZ = -maxD / 2;

    let deskTotal = 0;
    for (const p of plans) for (const l of p.layouts) deskTotal += l.desks;
    const floorsTotal = plans.reduce((n, p) => n + p.layouts.length, 0);
    this.desks = new DeskSet(Math.max(1, deskTotal), this.shadows, { plus: false });
    this.crowd = new Crowd(Math.max(1, deskTotal), this.shadows, true);
    this.partFloors = Math.max(1, floorsTotal);
    this.parts = this.makeParts(this.partFloors);
    this.badgeLayer = new BadgeLayer(Math.max(1, floorsTotal), FH * 0.62);
    this.badgeLayer.object.visible = this.badges;
    this.dynamic.add(this.desks.group, this.crowd.group, ...Object.values(this.parts), this.badgeLayer.object);

    let deskBase = 0;
    let fi = 0;
    this.buildings = [];
    this.spots = [];
    for (const p of plans) {
      const bx0 = offX + p.x0;
      const bz0 = offZ + (maxD - p.d);
      const tint = p.b.building ? (BUILDING_TINTS[p.bi % BUILDING_TINTS.length] ?? 0xffb8b0) : LOT_TINT;
      p.b.floors.forEach((view, level) => {
        const layout = p.layouts[level] as FloorLayout;
        const oy = level * FH;
        const box: Box3 = { min: [bx0, oy, bz0], max: [bx0 + p.w, oy + FH, bz0 + p.d] };
        // Floor content is centred in the footprint.
        const origin = new THREE.Vector3(bx0 + (p.w - layout.width * S) / 2, oy + SLAB / 2, bz0 + (p.d - layout.depth * S) / 2);
        const button = this.makeButton(view);
        const slot: FloorSlot = {
          id: view.id,
          building: p.bi,
          view,
          layout,
          box,
          origin,
          deskBase,
          button,
          index: fi,
          anchor: new THREE.Vector3(bx0 + p.w + 0.12, oy + FH * 0.45, bz0 + p.d),
        };
        this.floors.push(slot);
        this.byFloor.set(view.id, slot);
        this.placeFloor(fi, slot, tint);
        this.fillFloor(slot);
        this.paintBadge(slot);
        deskBase += layout.desks;
        fi++;
      });
      this.addBuildingButton(p.b);
      const h = Math.max(1, p.b.floors.length) * FH;
      this.addRoof(bx0, bz0, p.w, p.d, h, p.b.building?.name ?? 'Unassigned', tint);
      this.spots.push({ id: p.b.building?.id ?? null, bi: p.bi, x: bx0 + p.w / 2, z: bz0 + p.d, w: p.w });
      this.buildings.push({
        center: new THREE.Vector3(bx0 + p.w / 2, h / 2, bz0 + p.d / 2),
        radius: Math.hypot(p.w, p.d, h) / 2 + 0.5,
        name: p.b.building?.name ?? 'Unassigned',
      });
    }
    if (this.parts) for (const m of Object.values(this.parts)) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }

    this.bounds.set(new THREE.Vector3(offX - 1, 0, offZ - 1), new THREE.Vector3(offX + totalW + 1, Math.max(FH, ...this.buildings.map((b) => b.center.y * 2)) + 1, offZ + maxD + 1));
    this.addGround(offX, offZ, totalW, maxD);
    this.rebuildSigns();
    const c = this.bounds.getCenter(new THREE.Vector3());
    const r = this.bounds.getSize(new THREE.Vector3()).length() / 2 + 6;
    // Before M17 the sun stood at c + r (0.5, 1.2, 0.8): that stays its noon.
    this.sunFrame = { heading: (Math.atan2(0.5, -0.8) * 180) / Math.PI, dist: r * Math.hypot(0.5, 1.2, 0.8), target: c.clone() };
    this.sun.target.position.copy(c);
    this.placeSun();
    Object.assign(this.sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 0.5, far: r * 3.5 });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sun.shadow.normalBias = normalBiasFor(r);
  }

  private makeParts(n: number): Parts {
    const unit = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const basic = () => new THREE.MeshBasicMaterial({ color: 0xffffff });
    const mk = (name: string, mat: THREE.Material, shadow: boolean, geo: THREE.BufferGeometry = unit, count = n) => {
      const m = new THREE.InstancedMesh(geo, mat, count);
      m.name = `city.${name}`;
      m.castShadow = shadow;
      m.receiveShadow = true;
      m.frustumCulled = false;
      for (let i = 0; i < count; i++) m.setColorAt(i, color.set(0xffffff));
      return m;
    };
    return {
      box: mk('box', new THREE.MeshToonMaterial({ color: 0xffffff }), true, unit, BOX_PARTS.length * n),
      strip: mk('strip', basic(), false),
      band: mk('band', basic(), false, new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0)),
      rug: mk('rug', new THREE.MeshToonMaterial({ color: OFFICE.rug }), false, new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)),
      mezz: mk('mezz', new THREE.MeshToonMaterial({ color: 0xffffff }), true),
      glow: mk('glow', this.glowMat, false),
    };
  }

  private setPart(part: Part, i: number, x: number, y: number, z: number, sx: number, sy: number, sz: number, hex?: number): void {
    if (!this.parts) return;
    const k = BOX_PARTS.indexOf(part as BoxPart);
    const m = k < 0 ? this.parts[part as Exclude<Part, BoxPart>] : this.parts.box;
    const at = k < 0 ? i : k * this.partFloors + i;
    m.setMatrixAt(at, new THREE.Matrix4().compose(this.v.set(x, y, z), new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz)));
    if (hex !== undefined) m.setColorAt(at, color.set(hex));
  }

  private placeFloor(i: number, f: FloorSlot, tint: number): void {
    const [x0, y0, z0] = f.box.min;
    const [x1, , z1] = f.box.max;
    const w = x1 - x0;
    const d = z1 - z0;
    const asleep = f.view.asleep;
    const wall = asleep ? darken(tint, 0.55) : tint;
    this.setPart('slab', i, x0 + w / 2, y0 - SLAB / 2, z0 + d / 2, w + 0.14, SLAB, d + 0.14, asleep ? 0x4a4f70 : lighten(tint, 0.55));
    this.setPart('wallN', i, x0 + w / 2, y0, z0 + 0.04, w + 0.14, FH - SLAB, 0.08, wall);
    this.setPart('wallW', i, x0 + 0.04, y0, z0 + d / 2, 0.08, FH - SLAB, d + 0.14, wall);
    this.setPart('kneeS', i, x0 + w / 2, y0, z1 - 0.03, w + 0.14, 0.14, 0.06, wall);
    this.setPart('kneeE', i, x1 - 0.03, y0, z0 + d / 2, 0.06, 0.14, d, wall);
    this.setPart('pillar', i, x1 - 0.05, y0, z1 - 0.05, 0.12, FH - SLAB, 0.12, wall);
    this.setPart('strip', i, x0 + w / 2, y0 + FH - SLAB - 0.03, z0 + d / 2, w * 0.7, 0.025, 0.08, asleep ? 0x2b2f45 : 0xfff2c4);
    this.setPart('band', i, x0 + w / 2, y0 + FH * 0.38, z0 + 0.085, w * 0.86, FH * 0.36, 1, asleep ? 0x1d2447 : 0xcfeaff);
    const L = f.layout;
    // The corner office's mezzanine (#20), a warm oak deck in the north-east corner.
    const M = L.mezzanine;
    this.setPart('mezz', i, f.origin.x + ((M.rect.x0 + M.rect.x1) / 2) * S, y0 + M.under * S, f.origin.z + ((M.rect.z0 + M.rect.z1) / 2) * S, (M.rect.x1 - M.rect.x0) * S, (M.y - M.under) * S * 1.6, (M.rect.z1 - M.rect.z0) * S, asleep ? 0x6a5a4a : MEZZ_COLORS.oak);
    // M17: a running floor's lamps (the haze fills the room; an asleep floor has none).
    this.setPart('glow', i, x0 + w / 2, y0 + 0.01, z0 + d / 2, asleep ? 0 : w - 0.2, asleep ? 0 : FH - SLAB - 0.06, asleep ? 0 : d - 0.2);
    this.setPart('rug', i, f.origin.x + ((L.rug.x0 + L.rug.x1) / 2) * S, y0 + 0.005, f.origin.z + ((L.rug.z0 + L.rug.z1) / 2) * S, (L.rug.x1 - L.rug.x0) * S, 1, (L.rug.z1 - L.rug.z0) * S);
  }

  private fillFloor(f: FloorSlot): void {
    for (let i = 0; i < f.layout.desks; i++) this.setDesk(f, i, f.view.seats[i] ?? null);
  }

  private setDesk(f: FloorSlot, i: number, v: WorkerView | null): void {
    const s = f.layout.slots[i];
    if (!s || !this.desks || !this.crowd) return;
    const g = f.deskBase + i;
    const x = f.origin.x + s.seat.x * S;
    const z = f.origin.z + s.seat.z * S;
    const mem = v ? memberOf(v) : null;
    // M6: a crew's looks are too small to see from the city: no draw calls for them here.
    if (mem) delete mem.crew;
    this.desks.set(g, { x, y: f.origin.y, z, yaw: s.yaw, scale: S, display: mem?.display ?? null, cueColor: mem?.cue.color ?? 0xffffff });
    if (v && mem) {
      this.crowd.set(g, { x, y: f.origin.y + SEAT_Y * S, z, yaw: s.yaw, scale: S, ...mem });
      this.applied.set(v.worker.id, v.display);
      this.workerSlot.set(v.worker.id, g);
    } else this.crowd.set(g, null);
  }

  private addBuildingButton(b: BuildingView): void {
    const id = b.building?.id ?? null;
    this.buildingIds.push(id);
    if (!this.buildingParent) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.building = id ?? 'lot';
    const n = b.floors.length;
    btn.textContent = `${b.building?.name ?? 'Unassigned lot'}: ${n} ${n === 1 ? 'floor' : 'floors'}. Open the elevator`;
    btn.addEventListener('click', () => this.onBuilding(id));
    this.buildingParent.appendChild(btn);
    this.buildingButtons.push(btn);
  }

  /** Building id (null: the lot) of the city building at index `i`. */
  buildingId(i: number): string | null | undefined {
    return this.buildingIds[i];
  }

  private makeButton(view: FloorView): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    // #58: the floor id (a virtual floor's `v-…`); `data-session` stays its herdr session.
    b.dataset.floor = view.id;
    b.dataset.session = view.baseSession;
    b.addEventListener('click', () => this.onEnter(view.id));
    b.addEventListener('focus', () => this.setHover(view.id));
    b.addEventListener('blur', () => this.setHover(null));
    this.label(b, view);
    this.badgeParent.appendChild(b);
    return b;
  }

  private label(b: HTMLButtonElement, v: FloorView): void {
    const c = v.counts;
    b.dataset.state = v.asleep ? 'asleep' : 'running';
    const doing = v.transition === 'waking' ? 'waking up, ' : v.transition === 'sleeping' ? 'going to sleep, ' : '';
    b.textContent = v.asleep
      ? `${v.name}: ${doing}asleep, ${c.total} workers. Enter floor`
      : `${v.name}: ${doing}${c.working} working, ${c.needsYou} need you, ${c.idle} idle${c.waiting > 0 ? `, ${c.waiting} waiting on background tasks` : ''}. Enter floor`;
  }

  private paintBadge(f: FloorSlot): void {
    this.badgeLayer?.set(f.index, f.anchor, { name: f.view.name, asleep: f.view.asleep, counts: f.view.counts, hover: this.hover === f.id, transition: f.view.transition });
  }

  /** A floor's counts or a worker changed without structure changes. */
  updateFloor(v: FloorView): void {
    const f = this.byFloor.get(v.id);
    if (!f) return;
    f.view = v;
    this.label(f.button, v);
    this.paintBadge(f);
    this.lightSigns();
  }

  updateWorker(v: WorkerView): void {
    const f = this.byFloor.get(v.worker.floor);
    if (!f || f.view.seats[v.desk]?.worker.id !== v.worker.id) return;
    this.setDesk(f, v.desk, v);
  }

  private addRoof(x0: number, z0: number, w: number, d: number, h: number, name: string, tint: number): void {
    const roof = new THREE.Mesh(
      mergeGeometries([
        new THREE.BoxGeometry(w + 0.3, 0.14, d + 0.3).translate(x0 + w / 2, h + 0.0, z0 + d / 2),
        new THREE.BoxGeometry(w + 0.3, 0.22, 0.08).translate(x0 + w / 2, h + 0.18, z0 - 0.11),
        new THREE.BoxGeometry(0.08, 0.22, d + 0.3).translate(x0 - 0.11, h + 0.18, z0 + d / 2),
        new THREE.BoxGeometry(w * 0.18, 0.4, d * 0.22).translate(x0 + w * 0.78, h + 0.27, z0 + d * 0.3),
      ]),
      new THREE.MeshToonMaterial({ color: darken(tint, 0.25) }),
    );
    roof.castShadow = roof.receiveShadow = true;
    this.dynamic.add(roof);
    const c = document.createElement('canvas');
    c.width = 768;
    c.height = 192;
    const g = c.getContext('2d');
    if (g) {
      g.fillStyle = '#1c2540';
      g.beginPath();
      g.roundRect(4, 4, 760, 184, 36);
      g.fill();
      g.fillStyle = '#ffffff';
      g.font = `800 104px ${FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(name, 384, 100, 700);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(w * 0.8, 4), Math.min(w * 0.8, 4) / 4), new THREE.MeshBasicMaterial({ map: t, transparent: true }));
    sign.position.set(x0 + w * 0.42, h + 0.62, z0 + d * 0.62);
    sign.rotation.y = 0.35;
    const posts = new THREE.Mesh(
      mergeGeometries([-0.3, 0.3].map((k) => new THREE.BoxGeometry(0.05, 0.5, 0.05).translate(x0 + w * 0.42 + k * Math.min(w * 0.8, 4), h + 0.25, z0 + d * 0.62))),
      new THREE.MeshToonMaterial({ color: 0x39425a }),
    );
    this.dynamic.add(sign, posts);
  }

  // ---- M3d: building logo signs ------------------------------------------------------

  /**
   * The logos to show, by building id: a low sign on the pavement in front of
   * each building that has one. Cheap to call again (it only rebuilds the
   * signs, never the buildings); the textures belong to the caller.
   */
  setLogos(logos: ReadonlyMap<string, LogoEntry>): void {
    this.logos = new Map(logos);
    this.rebuildSigns();
  }

  private disposeSigns(): void {
    for (const o of [...this.signs.children]) {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
        if (o instanceof THREE.InstancedMesh) o.dispose();
      }
    }
    this.signs.clear();
    this.marks = [];
    this.plates = null;
  }

  private rebuildSigns(): void {
    this.disposeSigns();
    const shown = this.spots.filter((s) => s.id !== null && this.logos.has(s.id));
    if (!shown.length) return;
    const plates = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }), shown.length);
    plates.name = 'city.signPlates';
    plates.frustumCulled = false;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-SIGN.tilt, 0, 0));
    shown.forEach((spot, i) => {
      const entry = this.logos.get(spot.id as string) as LogoEntry;
      const pw = Math.min(1.9, Math.max(0.8, spot.w * 0.7));
      const ph = pw / 3;
      const at = new THREE.Vector3(spot.x, ph * 0.5 * Math.cos(SIGN.tilt) + 0.02, spot.z + 0.3);
      plates.setMatrixAt(i, new THREE.Matrix4().compose(at, q, new THREE.Vector3(pw, ph, SIGN.thick)));
      const fit = letterbox(entry.width, entry.height, pw, ph, 0.1);
      const logo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), logoMaterial(entry.texture));
      logo.name = 'city.signLogo';
      logo.renderOrder = 1;
      logo.scale.set(fit.w, fit.h, 1);
      // On the plate's face: its own +z, a hair proud of the box.
      const local = new THREE.Vector3(fit.x + fit.w / 2 - pw / 2, ph / 2 - fit.y - fit.h / 2, SIGN.thick / 2 + 0.004).applyQuaternion(q);
      logo.position.copy(at).add(local);
      logo.quaternion.copy(q);
      this.signs.add(logo);
      this.marks.push({ spot, logo, instance: i, entry, lit: true });
    });
    this.signs.add(plates);
    this.plates = plates;
    this.lightSigns(true);
  }

  /**
   * Lit while any floor of the building runs, dim once every floor sleeps, as
   * the facade windows are. This only sets colours. A floor going to sleep or
   * waking is a structure change, so the city (signs included: `rebuildSigns`)
   * is rebuilt with it, as before logos; the logo textures are not reloaded,
   * because the cache holds them by hash.
   */
  private lightSigns(force = false): void {
    if (!this.plates) return;
    let changed = false;
    for (const m of this.marks) {
      const lit = this.floors.some((f) => f.building === m.spot.bi && !f.view.asleep);
      if (lit === m.lit && !force) continue;
      m.lit = lit;
      this.plates.setColorAt(m.instance, color.set(lit ? SIGN.lit : SIGN.dim));
      (m.logo.material as THREE.MeshBasicNodeMaterial).color.set(lit ? SIGN.logoLit : SIGN.logoDim);
      changed = true;
    }
    if (changed && this.plates.instanceColor) this.plates.instanceColor.needsUpdate = true;
  }

  /** What the city shows of each logo (test hook): building id, hash, lit. */
  signInfo(): Array<{ building: string; hash: string; lit: boolean }> {
    return this.marks.map((m) => ({ building: m.spot.id as string, hash: m.entry.hash, lit: m.lit }));
  }

  private addGround(offX: number, offZ: number, totalW: number, maxD: number): void {
    const grass = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), new THREE.MeshToonMaterial({ color: GRASS }));
    grass.position.y = -0.08;
    grass.receiveShadow = true;
    const roadZ = offZ + maxD + 2.2;
    const road = new THREE.Mesh(new THREE.PlaneGeometry(totalW + 40, 2.6).rotateX(-Math.PI / 2), new THREE.MeshToonMaterial({ color: ROAD }));
    road.position.set(offX + totalW / 2, -0.07, roadZ);
    road.receiveShadow = true;
    const walk = new THREE.Mesh(new THREE.PlaneGeometry(totalW + 40, maxD + 1.6).rotateX(-Math.PI / 2), new THREE.MeshToonMaterial({ color: 0xe4e0d6 }));
    walk.position.set(offX + totalW / 2, -0.075, offZ + maxD / 2 + 0.2);
    walk.receiveShadow = true;
    const dashes = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.9, 0.12).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff }), 40);
    for (let i = 0; i < 40; i++) dashes.setMatrixAt(i, new THREE.Matrix4().makeTranslation(offX - 20 + i * ((totalW + 40) / 40), -0.065, roadZ));
    const n = Math.max(6, Math.round((totalW + 16) / 3.2));
    const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.04, 0.055, 0.34, 6).translate(0, 0.17, 0), new THREE.MeshToonMaterial({ color: 0x8a5a3b }), n);
    const crown = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.28, 0).translate(0, 0.52, 0), new THREE.MeshToonMaterial({ color: 0x3f9e55 }), n);
    for (let i = 0; i < n; i++) {
      const m = new THREE.Matrix4().makeTranslation(offX - 8 + i * 3.2 + (i % 2) * 0.6, -0.07, roadZ + 2.1 + (i % 3) * 0.25);
      const s = 0.85 + ((i * 37) % 10) / 25;
      m.scale(new THREE.Vector3(s, s, s));
      trunk.setMatrixAt(i, m);
      crown.setMatrixAt(i, m);
    }
    trunk.castShadow = crown.castShadow = true;
    this.dynamic.add(grass, road, walk, dashes, trunk, crown);
  }

  private clear(): void {
    for (const f of this.floors) f.button.remove();
    for (const b of this.buildingButtons) b.remove();
    this.buildingButtons = [];
    this.buildingIds = [];
    this.badgeLayer = null;
    this.floors = [];
    this.byFloor.clear();
    this.workerSlot.clear();
    this.applied.clear();
    this.dynamic.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          (m as THREE.MeshBasicMaterial).map?.dispose();
          (m as THREE.Material).dispose();
        }
      }
    });
    this.dynamic.clear();
    this.disposeSigns();
    this.crowd = null;
    this.desks = null;
    this.parts = null;
  }

  get isEmpty(): boolean {
    return this.floors.length === 0;
  }

  frameAll(): { center: THREE.Vector3; radius: number } {
    const center = this.bounds.getCenter(new THREE.Vector3());
    return { center, radius: Math.max(6, this.bounds.getSize(new THREE.Vector3()).length() / 2) };
  }

  building(i: number): BuildingFrame | null {
    return this.buildings[i] ?? null;
  }

  buildingOf(floor: string): number | null {
    return this.byFloor.get(floor)?.building ?? null;
  }

  get buildingCount(): number {
    return this.buildings.length;
  }

  /** Floor under a camera ray. */
  pickFloor(origin: THREE.Vector3, dir: THREE.Vector3): string | null {
    let best: { s: string; t: number } | null = null;
    for (const f of this.floors) {
      const t = rayBox([origin.x, origin.y, origin.z], [dir.x, dir.y, dir.z], f.box);
      if (t !== null && (!best || t < best.t)) best = { s: f.id, t };
    }
    return best?.s ?? null;
  }

  setHover(floor: string | null): void {
    if (this.hover === floor) return;
    const prev = this.hover ? this.byFloor.get(this.hover) : undefined;
    this.hover = floor;
    if (prev) this.paintBadge(prev);
    const next = floor ? this.byFloor.get(floor) : undefined;
    if (next) this.paintBadge(next);
  }

  get hovered(): string | null {
    return this.hover;
  }

  setVisible(v: boolean): void {
    this.badgeParent.hidden = !v;
    if (this.buildingParent) this.buildingParent.hidden = !v;
  }

  /** Screen point (CSS px) of the middle of a floor's box, null when off screen. */
  floorPoint(camera: THREE.PerspectiveCamera, floor: string, vp: { width: number; height: number }): { x: number; y: number } | null {
    const f = this.byFloor.get(floor);
    if (!f) return null;
    const [x0, y0, z0] = f.box.min;
    const [x1, y1, z1] = f.box.max;
    // Towards the open front, at desk height: where a click lands on the floor.
    const p = this.v.set((x0 + x1) / 2, y0 + (y1 - y0) * 0.3, z0 + (z1 - z0) * 0.7).project(camera);
    if (p.z > 1 || Math.abs(p.x) > 1 || Math.abs(p.y) > 1) return null;
    return { x: ((p.x + 1) / 2) * vp.width, y: ((1 - p.y) / 2) * vp.height };
  }

  /** Floor badges on/off (`?badges=0`, for perf comparisons). */
  badges = true;

  frame(t: number, camera: THREE.PerspectiveCamera): void {
    this.crowd?.update(t);
    this.desks?.update(t, null);
    if (this.badges) this.badgeLayer?.update(camera);
  }

  /** Floor whose badge is under a screen point (CSS px). */
  pickBadge(camera: THREE.PerspectiveCamera, x: number, y: number, vp: { width: number; height: number }): string | null {
    if (!this.badges || !this.badgeLayer) return null;
    const i = this.badgeLayer.hit(camera, x, y, vp);
    return i === null ? null : (this.floors[i]?.id ?? null);
  }

  badgePoint(camera: THREE.PerspectiveCamera, floor: string, vp: { width: number; height: number }): { x: number; y: number } | null {
    const f = this.byFloor.get(floor);
    return f && this.badgeLayer ? this.badgeLayer.center(camera, f.index, vp) : null;
  }
}
