import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rayBox } from '../world/collide';
import type { Display } from '../world/derive';
import { floorLayout, ROOM_HEIGHT, type Box3, type FloorLayout } from '../world/layout';
import type { BuildingView, FloorView, WorkerView } from '../world/store';
import { FONT } from './cards/atlasCards';
import { Crowd } from './crowd';
import { DeskSet } from './desks';
import { memberOf, SEAT_Y } from './office';
import { BUILDING_TINTS, GRASS, LOT_TINT, OFFICE, ROAD } from './palette';

/**
 * The city: every building as a dollhouse of open-front floors (north and
 * west walls, knee walls to the south and east), each floor a scaled-down
 * copy of its office with the same desks and workers. Lights on for running
 * floors, dark with zZz for asleep ones, and a count badge per floor.
 */

export const CITY_SCALE = 0.22;
const S = CITY_SCALE;
// Dollhouse ceilings: taller than to scale, so a low camera sees to the back wall.
const FH = ROOM_HEIGHT * S * 2 + 0.08;
const GAP = 3.2;
const SLAB = 0.07;

interface FloorSlot {
  session: string;
  building: number;
  view: FloorView;
  layout: FloorLayout;
  /** World box of the floor (picking, framing). */
  box: Box3;
  origin: THREE.Vector3;
  deskBase: number;
  badge: HTMLButtonElement;
  anchor: THREE.Vector3;
}

export interface BuildingFrame {
  center: THREE.Vector3;
  radius: number;
  name: string;
}

type Part = 'slab' | 'wallN' | 'wallW' | 'kneeS' | 'kneeE' | 'pillar' | 'strip' | 'band' | 'rug';

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
  private readonly bySession = new Map<string, FloorSlot>();
  private buildings: BuildingFrame[] = [];
  private bounds = new THREE.Box3();
  private crowd: Crowd | null = null;
  private desks: DeskSet | null = null;
  private parts: Record<Part, THREE.InstancedMesh> | null = null;
  private dynamic = new THREE.Group();
  private readonly sun: THREE.DirectionalLight;
  private hover: string | null = null;
  private readonly v = new THREE.Vector3();
  private readonly workerSlot = new Map<string, number>();

  constructor(
    private readonly badgeParent: HTMLElement,
    private readonly shadows: boolean,
    private readonly onEnter: (session: string) => void,
  ) {
    this.scene.background = new THREE.Color(0x9fd6ff);
    this.scene.add(new THREE.HemisphereLight(0xeaf6ff, 0x7ba36a, 1.35));
    this.sun = new THREE.DirectionalLight(0xfff1dc, 2.3);
    this.sun.castShadow = shadows;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0008;
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(this.dynamic);
  }

  /** Rebuilds everything from the store's city (on structural changes). */
  build(city: BuildingView[]): void {
    this.clear();
    // Footprints first: a building is as big as its biggest floor.
    let x = 0;
    const plans = city.map((b, bi) => {
      const layouts = b.floors.map((f) => floorLayout(f.desks));
      const w = Math.max(18, ...layouts.map((l) => l.width)) * S;
      const d = Math.max(14, ...layouts.map((l) => l.depth)) * S;
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
    this.desks = new DeskSet(Math.max(1, deskTotal), this.shadows, false);
    this.crowd = new Crowd(Math.max(1, deskTotal), this.shadows);
    this.parts = this.makeParts(Math.max(1, floorsTotal));
    this.dynamic.add(this.desks.group, this.crowd.group, ...Object.values(this.parts));

    let deskBase = 0;
    let fi = 0;
    this.buildings = [];
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
        const badge = this.makeBadge(view);
        const slot: FloorSlot = {
          session: view.session,
          building: p.bi,
          view,
          layout,
          box,
          origin,
          deskBase,
          badge,
          anchor: new THREE.Vector3(bx0 + p.w + 0.12, oy + FH * 0.45, bz0 + p.d),
        };
        this.floors.push(slot);
        this.bySession.set(view.session, slot);
        this.placeFloor(fi, slot, tint);
        this.fillFloor(slot);
        deskBase += layout.desks;
        fi++;
      });
      const h = Math.max(1, p.b.floors.length) * FH;
      this.addRoof(bx0, bz0, p.w, p.d, h, p.b.building?.name ?? 'Unassigned', tint);
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
    const c = this.bounds.getCenter(new THREE.Vector3());
    const r = this.bounds.getSize(new THREE.Vector3()).length() / 2 + 6;
    this.sun.position.set(c.x + r * 0.5, r * 1.2, c.z + r * 0.8);
    this.sun.target.position.copy(c);
    Object.assign(this.sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 0.5, far: r * 3.5 });
    this.sun.shadow.camera.updateProjectionMatrix();
  }

  private makeParts(n: number): Record<Part, THREE.InstancedMesh> {
    const unit = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const toon = () => new THREE.MeshToonMaterial({ color: 0xffffff });
    const basic = () => new THREE.MeshBasicMaterial({ color: 0xffffff });
    const mk = (name: Part, mat: THREE.Material, shadow: boolean, geo: THREE.BufferGeometry = unit) => {
      const m = new THREE.InstancedMesh(geo, mat, n);
      m.name = `city.${name}`;
      m.castShadow = shadow;
      m.receiveShadow = true;
      m.frustumCulled = false;
      for (let i = 0; i < n; i++) m.setColorAt(i, color.set(0xffffff));
      return m;
    };
    return {
      slab: mk('slab', toon(), true),
      wallN: mk('wallN', toon(), true),
      wallW: mk('wallW', toon(), true),
      kneeS: mk('kneeS', toon(), true),
      kneeE: mk('kneeE', toon(), true),
      pillar: mk('pillar', toon(), true),
      strip: mk('strip', basic(), false),
      band: mk('band', basic(), false, new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0)),
      rug: mk('rug', new THREE.MeshToonMaterial({ color: OFFICE.rug }), false, new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)),
    };
  }

  private setPart(part: Part, i: number, x: number, y: number, z: number, sx: number, sy: number, sz: number, hex?: number): void {
    const m = this.parts?.[part];
    if (!m) return;
    m.setMatrixAt(i, new THREE.Matrix4().compose(this.v.set(x, y, z), new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz)));
    if (hex !== undefined) m.setColorAt(i, color.set(hex));
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
    this.desks.set(g, { x, y: f.origin.y, z, yaw: s.yaw, scale: S, display: mem?.display ?? null, cueColor: mem?.cue.color ?? 0xffffff });
    if (v && mem) {
      this.crowd.set(g, { x, y: f.origin.y + SEAT_Y * S, z, yaw: s.yaw, scale: S, ...mem });
      this.applied.set(v.worker.id, v.display);
      this.workerSlot.set(v.worker.id, g);
    } else this.crowd.set(g, null);
  }

  private makeBadge(view: FloorView): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'badge';
    b.dataset.session = view.session;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onEnter(view.session);
    });
    b.addEventListener('pointerenter', () => this.setHover(view.session));
    b.addEventListener('pointerleave', () => this.setHover(null));
    this.fillBadge(b, view);
    this.badgeParent.appendChild(b);
    return b;
  }

  private fillBadge(b: HTMLButtonElement, v: FloorView): void {
    b.dataset.state = v.asleep ? 'asleep' : 'running';
    const c = v.counts;
    b.replaceChildren();
    const name = document.createElement('span');
    name.className = 'badge-name';
    name.textContent = v.session;
    b.append(name);
    const counts = document.createElement('span');
    counts.className = 'badge-counts';
    if (v.asleep) {
      counts.innerHTML = `<span class="count count--asleep"><i></i>asleep · ${c.total}</span>`;
      b.setAttribute('aria-label', `${v.session}: asleep, ${c.total} workers. Enter floor`);
    } else {
      const item = (cls: string, n: number, label: string) => `<span class="count count--${cls}" title="${label}"><i></i>${n}</span>`;
      counts.innerHTML = item('working', c.working, 'working') + item('needs_you', c.needsYou, 'needs you') + item('idle', c.idle, 'idle');
      b.setAttribute('aria-label', `${v.session}: ${c.working} working, ${c.needsYou} need you, ${c.idle} idle. Enter floor`);
    }
    b.append(counts);
  }

  /** A floor's counts or a worker changed without structure changes. */
  updateFloor(v: FloorView): void {
    const f = this.bySession.get(v.session);
    if (!f) return;
    f.view = v;
    this.fillBadge(f.badge, v);
  }

  updateWorker(v: WorkerView): void {
    const f = this.bySession.get(v.worker.session);
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
    for (const f of this.floors) f.badge.remove();
    this.floors = [];
    this.bySession.clear();
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

  buildingOf(session: string): number | null {
    return this.bySession.get(session)?.building ?? null;
  }

  get buildingCount(): number {
    return this.buildings.length;
  }

  /** Floor under a camera ray. */
  pickFloor(origin: THREE.Vector3, dir: THREE.Vector3): string | null {
    let best: { s: string; t: number } | null = null;
    for (const f of this.floors) {
      const t = rayBox([origin.x, origin.y, origin.z], [dir.x, dir.y, dir.z], f.box);
      if (t !== null && (!best || t < best.t)) best = { s: f.session, t };
    }
    return best?.s ?? null;
  }

  setHover(session: string | null): void {
    if (this.hover === session) return;
    if (this.hover) this.bySession.get(this.hover)?.badge.classList.remove('is-hover');
    this.hover = session;
    if (session) this.bySession.get(session)?.badge.classList.add('is-hover');
  }

  get hovered(): string | null {
    return this.hover;
  }

  setVisible(v: boolean): void {
    for (const f of this.floors) f.badge.hidden = !v;
  }

  frame(t: number, camera: THREE.PerspectiveCamera, vp: { width: number; height: number }, moved: boolean): void {
    this.crowd?.update(t);
    this.desks?.update(t, null);
    if (!moved) return;
    // Project, then keep a building's badges from overlapping (top floor first).
    const placed = this.floors.map((f) => {
      this.v.copy(f.anchor).project(camera);
      return { f, on: this.v.z < 1 && Math.abs(this.v.x) < 1.1 && Math.abs(this.v.y) < 1.1, x: ((this.v.x + 1) / 2) * vp.width, y: ((1 - this.v.y) / 2) * vp.height };
    });
    const byBuilding = new Map<number, typeof placed>();
    for (const p of placed) byBuilding.set(p.f.building, [...(byBuilding.get(p.f.building) ?? []), p]);
    for (const list of byBuilding.values()) {
      list.sort((a, b) => a.y - b.y);
      for (let i = 1; i < list.length; i++) {
        const prev = list[i - 1];
        const cur = list[i];
        if (prev && cur && cur.y < prev.y + 32) cur.y = prev.y + 32;
      }
    }
    for (const p of placed) {
      p.f.badge.style.visibility = p.on ? 'visible' : 'hidden';
      if (p.on) p.f.badge.style.transform = `translate3d(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px,0) translate(0,-50%)`;
    }
  }
}
