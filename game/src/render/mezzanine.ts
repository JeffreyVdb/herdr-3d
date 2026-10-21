import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { DESK_D, DESK_H, GLASS_H, POST_W, SEAT_OFFSET, type Mezzanine } from '../world/layout';
import { FONT } from './cards/atlasCards';
import { deskGeometries, keyboardPieces, monitorPieces, screenGeometry } from './desks';
import { KEYBOARD, MONITOR } from '../world/deskKit';
import { OFFICE, type OfficePalette } from './palette';
import { canvasTexture } from './props';

/**
 * The corner office (#20): the mezzanine with its posts, the open stair, the
 * glass walls' frames and your desk, merged into two vertex-coloured toon
 * meshes (what stands on the floor, and what is up there) under one
 * material. The glass panes join the office's window glass (one material,
 * one transparent mesh); the sliding door is its own small mesh. The floor
 * plan hides the upper part and draws its outline instead, so the desks
 * under the mezzanine stay visible.
 */

export const MEZZ_COLORS = {
  /** Warm oak: the office floor and the stair treads. */
  oak: 0xcf9a62,
  soffit: 0xf4efe4,
  steel: OFFICE.boardWall,
  /** Handrails and the glass's safety stripe: the fire-door yellow. */
  rail: 0xffc233,
  frame: 0x1c2540,
  screen: 0x2d4a7c,
};

/** The corner office in an office palette: its steel, rails and frames follow the UI theme; oak and soffit stay. */
export function mezzColors(P: Readonly<OfficePalette>): typeof MEZZ_COLORS {
  return { ...MEZZ_COLORS, steel: P.boardWall, rail: P.accent, frame: P.frame };
}

const css = (hex: number) => `#${hex.toString(16).padStart(6, '0')}`;

/** Geometry parts with a colour each, merged into one non-indexed buffer (position, normal, color). */
class Parts {
  private readonly list: THREE.BufferGeometry[] = [];
  private readonly c = new THREE.Color();

  add(g: THREE.BufferGeometry, hex: number, m?: THREE.Matrix4): void {
    const geo = g.index ? g.toNonIndexed() : g.clone();
    g.dispose();
    geo.deleteAttribute('uv');
    if (m) geo.applyMatrix4(m);
    this.c.set(hex);
    const n = geo.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([this.c.r, this.c.g, this.c.b], i * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.list.push(geo);
  }

  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, hex: number): void {
    this.add(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0).translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), hex);
  }

  /** A box beam from a to c, w wide and h tall. */
  beam(a: THREE.Vector3, c: THREE.Vector3, w: number, h: number, hex: number): void {
    const dir = c.clone().sub(a);
    const len = dir.length();
    if (len < 1e-4) return;
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.normalize());
    this.add(new THREE.BoxGeometry(w, h, len), hex, new THREE.Matrix4().compose(a.clone().add(c).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)));
  }

  build(): THREE.BufferGeometry {
    const g = mergeGeometries(this.list);
    for (const p of this.list) p.dispose();
    this.list.length = 0;
    return g;
  }
}

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** A pane seen from both sides (two front-facing quads, no DoubleSide pass). */
function pane(w: number, h: number, m: THREE.Matrix4): THREE.BufferGeometry[] {
  return [new THREE.PlaneGeometry(w, h).applyMatrix4(m), new THREE.PlaneGeometry(w, h).rotateY(Math.PI).applyMatrix4(m)];
}

/** The name plate on your desk (top half, opaque) and the name on the glass by the door (bottom half, cut out). */
function nameTexture(owner: string, plate: string, ink: string): THREE.CanvasTexture {
  return canvasTexture(512, 256, (g) => {
    const name = owner.length > 22 ? `${owner.slice(0, 21)}…` : owner;
    g.fillStyle = plate;
    g.fillRect(0, 0, 512, 128);
    g.fillStyle = ink;
    g.fillRect(0, 118, 512, 10);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `800 ${name.length > 12 ? 44 : 60}px ${FONT}`;
    g.fillText(name, 256, 62, 480);
    g.clearRect(0, 128, 512, 128);
    g.fillStyle = ink;
    g.font = `800 ${name.length > 12 ? 40 : 52}px ${FONT}`;
    g.fillText(name === 'You' ? 'Your office' : name, 256, 176, 490);
    g.font = `600 26px ${FONT}`;
    g.fillText('corner office · mezzanine', 256, 226, 490);
  });
}

export class MezzanineView {
  readonly group = new THREE.Group();
  /** Glass panes for the office's glass mesh (same material as the windows). */
  readonly glass: THREE.BufferGeometry[] = [];
  private readonly lower: THREE.Mesh;
  private readonly upper: THREE.Mesh;
  private readonly plate: THREE.Mesh;
  private readonly plan: THREE.Mesh;
  private readonly door: THREE.Group;
  private readonly doorClosedX: number;
  private readonly doorTravel: number;
  private doorOpen = 0;
  private readonly material: THREE.MeshToonMaterial;

  constructor(
    readonly m: Mezzanine,
    owner: string,
    glassMat: THREE.Material,
    shadows: boolean,
    P: Readonly<OfficePalette> = OFFICE,
  ) {
    this.group.name = 'mezzanine';
    const C = mezzColors(P);
    const { rect, y, under, stair } = m;
    const lo = new Parts();
    const up = new Parts();

    // ---- on the floor: posts and the open stair ---------------------------------
    for (const p of m.posts) {
      lo.add(new THREE.CylinderGeometry(POST_W * 0.42, POST_W * 0.42, under - 0.3, 12).translate(p.x, (under - 0.3) / 2 + 0.03, p.z), C.steel);
      lo.box(p.x - 0.15, 0, p.z - 0.15, p.x + 0.15, 0.03, p.z + 0.15, C.frame);
      lo.box(p.x - 0.13, under - 0.3, p.z - 0.13, p.x + 0.13, under, p.z + 0.13, C.steel);
    }
    for (const t of stair.treads) lo.box(t.rect.x0 + 0.02, t.y - 0.05, t.rect.z0 + 0.004, t.rect.x1 - 0.02, t.y, t.rect.z1 - 0.004, C.oak);
    // Stringers under both edges, along the nosings.
    const foot = v3(0, 0.08, stair.bottom);
    const head = v3(0, y - 0.12, stair.top);
    const xr = stair.x0 - 0.035;
    for (const x of [xr, stair.x1 - 0.04]) lo.beam(foot.clone().setX(x), head.clone().setX(x), 0.06, 0.26, C.steel);
    // Railing on the open side: balusters, a yellow hand rail, a newel at the foot; a wall rail on the other side.
    for (let j = 1; j < stair.treads.length; j += 2) {
      const t = stair.treads[j] as (typeof stair.treads)[number];
      const z = (t.rect.z0 + t.rect.z1) / 2;
      lo.box(xr - 0.015, t.y, z - 0.015, xr + 0.015, t.y + 0.93, z + 0.015, C.steel);
    }
    const rail = (x: number, dy: number, hex: number, w = 0.055) => lo.beam(v3(x, stair.rise + dy, stair.bottom), v3(x, y + dy, stair.top), w, w, hex);
    rail(xr, 0.95, C.rail);
    rail(xr, 0.5, C.steel, 0.03);
    rail(stair.x1 + 0.0, 0.9, C.rail, 0.05);
    lo.box(xr - 0.045, 0, stair.bottom - 0.09, xr + 0.045, 1.08, stair.bottom, C.steel);
    lo.box(xr - 0.06, 1.08, stair.bottom - 0.105, xr + 0.06, 1.13, stair.bottom + 0.015, C.rail);

    // ---- up there: the slab, glass frames, your desk ---------------------------------
    up.box(rect.x0, under, rect.z0, rect.x1, y - 0.02, rect.z1, C.soffit);
    up.box(rect.x0, y - 0.02, rect.z0, rect.x1, y, rect.z1, C.oak);
    // Deep steel fascias on the open edges: the edge beams that carry the corner.
    up.box(rect.x0 - 0.05, under - 0.15, rect.z1, rect.x1, y + 0.02, rect.z1 + 0.05, C.steel);
    up.box(rect.x0 - 0.05, under - 0.15, rect.z0, rect.x0, y + 0.02, rect.z1 + 0.05, C.steel);
    // Glass walls: kick rail, head rail, mullions, and a yellow safety stripe at eye height (standing).
    const gy1 = y + GLASS_H;
    for (const g of m.glass) {
      const alongX = g.max[0] - g.min[0] > g.max[2] - g.min[2];
      const [a0, a1] = alongX ? [g.min[0], g.max[0]] : [g.min[2], g.max[2]];
      const c = alongX ? (g.min[2] + g.max[2]) / 2 : (g.min[0] + g.max[0]) / 2;
      const seg = (u0: number, u1: number, y0: number, y1: number, d: number, hex: number) =>
        alongX ? up.box(u0, y0, c - d, u1, y1, c + d, hex) : up.box(c - d, y0, u0, c + d, y1, u1, hex);
      seg(a0, a1, y, y + 0.1, 0.05, C.frame);
      seg(a0, a1, gy1 - 0.07, gy1, 0.05, C.frame);
      seg(a0, a1, y + 1.46, y + 1.51, 0.012, C.rail);
      const k = Math.max(1, Math.round((a1 - a0) / 1.45));
      for (let i = 0; i <= k; i++) {
        const u = a0 + ((a1 - a0) * i) / k;
        seg(Math.max(a0, u - 0.03), Math.min(a1, u + 0.03), y, gy1, 0.04, C.frame);
      }
      const len = a1 - a0;
      const h = GLASS_H - 0.17;
      const at = new THREE.Matrix4().makeTranslation(alongX ? (a0 + a1) / 2 : c, y + 0.1 + h / 2, alongX ? c : (a0 + a1) / 2);
      if (!alongX) at.multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2));
      this.glass.push(...pane(len, h, at));
    }
    // The door at the head of the stair: jambs, a header, glass over it.
    const d = m.door;
    const dz = d.z - 0.025;
    up.box(d.x0 - 0.07, y, dz - 0.05, d.x0, gy1, dz + 0.05, C.frame);
    up.box(d.x1, y, dz - 0.05, d.x1 + 0.05, gy1, dz + 0.05, C.frame);
    up.box(d.x0 - 0.07, y + d.height, dz - 0.05, d.x1 + 0.05, y + d.height + 0.08, dz + 0.05, C.frame);
    up.box(d.x0 - 0.07, gy1 - 0.07, dz - 0.05, d.x1 + 0.05, gy1, dz + 0.05, C.frame);
    const th = GLASS_H - d.height - 0.15;
    this.glass.push(...pane(d.x1 - d.x0, th, new THREE.Matrix4().makeTranslation((d.x0 + d.x1) / 2, y + d.height + 0.08 + th / 2, dz)));

    // Your desk: the worker desk art with the office's monitor and keyboard (M6b, as on every desk; nothing live), and a mug.
    const desk = new THREE.Matrix4().compose(v3(m.desk.seat.x, y, m.desk.seat.z), new THREE.Quaternion().setFromAxisAngle(v3(0, 1, 0), m.desk.yaw), v3(1, 1, 1));
    const art = deskGeometries();
    const colors: Partial<Record<keyof typeof art, number>> = { top: P.deskTop, legs: P.deskLeg, chair: P.chair, chairBase: P.chairBase };
    for (const [k, g] of Object.entries(art) as Array<[keyof typeof art, THREE.BufferGeometry]>) {
      const hex = colors[k];
      if (hex === undefined) g.dispose();
      else up.add(g, hex, desk);
    }
    const inDesk = (g: THREE.BufferGeometry, hex: number) => up.add(g, hex, desk);
    // The monitor sits at the desk's north end, turned in a little: sitting, you look past it at the floor.
    const about = (x: number, z: number, turn: number, ox: number, oz: number) =>
      desk.clone().multiply(new THREE.Matrix4().makeTranslation(x, 0, z)).multiply(new THREE.Matrix4().makeRotationY(turn)).multiply(new THREE.Matrix4().makeTranslation(-ox, 0, -oz));
    const mon = about(-0.3, MONITOR.z - 0.06, 0.35, 0, MONITOR.z);
    for (const p of monitorPieces()) up.add(p.geo, p.color, mon);
    up.add(screenGeometry(), C.screen, mon);
    const kb = about(-0.22, SEAT_OFFSET - 0.19, 0.18, KEYBOARD.x, KEYBOARD.z);
    for (const p of keyboardPieces()) up.add(p.geo, p.color, kb);
    inDesk(new THREE.CylinderGeometry(0.038, 0.034, 0.1, 12).translate(0.5, DESK_H + 0.05, SEAT_OFFSET - 0.14), C.rail);
    const plateX = 0.28;
    const plateZ = SEAT_OFFSET + DESK_D / 2 - 0.05;
    inDesk(new THREE.BoxGeometry(0.36, 0.1, 0.05).translate(plateX, DESK_H + 0.05, plateZ), C.frame);
    // A plant in the back corner.
    const pl = m.plant;
    up.add(new THREE.CylinderGeometry(0.2, 0.16, 0.36, 12).translate(pl.x, y + 0.18, pl.z), P.pot);
    up.add(new THREE.IcosahedronGeometry(0.34, 0).translate(pl.x, y + 0.72, pl.z), P.plant);
    up.add(new THREE.IcosahedronGeometry(0.22, 0).translate(pl.x + 0.12, y + 1.02, pl.z + 0.05), 0x5cbf73);

    this.material = new THREE.MeshToonMaterial({ color: 0xffffff, vertexColors: true });
    this.lower = new THREE.Mesh(lo.build(), this.material);
    this.lower.name = 'mezzanine.lower';
    this.upper = new THREE.Mesh(up.build(), this.material);
    this.upper.name = 'mezzanine.upper';
    for (const o of [this.lower, this.upper]) o.castShadow = o.receiveShadow = shadows;

    // Name plate and the name on the glass: one texture, one draw.
    const tex = nameTexture(owner, css(C.rail), css(C.frame));
    const half = (g: THREE.PlaneGeometry, top: boolean) => {
      const uv = g.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setY(i, top ? 0.5 + uv.getY(i) * 0.5 : uv.getY(i) * 0.5);
      return g;
    };
    const plateFace = half(new THREE.PlaneGeometry(0.34, 0.085), true).translate(plateX, DESK_H + 0.05, plateZ + 0.026).applyMatrix4(desk);
    const sign = half(new THREE.PlaneGeometry(1.2, 0.3), false).translate(d.x0 - 0.9, y + 1.5, d.z + 0.004);
    this.plate = new THREE.Mesh(mergeGeometries([plateFace, sign]), new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.5 }));
    this.plate.name = 'mezzanine.names';

    // The sliding glass door (slides west, inside the fixed glass), with a steel pull.
    const dw = d.x1 - d.x0 - 0.04;
    this.door = new THREE.Group();
    this.door.name = 'mezzanine.door';
    const leaf = new THREE.Mesh(mergeGeometries(pane(dw, d.height - 0.02, new THREE.Matrix4().makeTranslation(0, (d.height - 0.02) / 2, 0))), glassMat);
    const pull = new Parts();
    pull.box(dw / 2 - 0.16, 0.8, -0.05, dw / 2 - 0.12, 1.35, 0.05, C.steel);
    const handle = new THREE.Mesh(pull.build(), this.material);
    this.door.add(leaf, handle);
    this.doorClosedX = (d.x0 + d.x1) / 2;
    this.doorTravel = dw + 0.02;
    this.door.position.set(this.doorClosedX, y + 0.01, d.z - 0.1);

    // Floor plan: the outline of the mezzanine (dashed), its glass, and your desk.
    const pp = new Parts();
    const py = y + 0.02;
    const dash = (x0: number, z0: number, x1: number, z1: number) => {
      const len = Math.hypot(x1 - x0, z1 - z0);
      for (let s = 0; s < len; s += 0.8) {
        const e = Math.min(len, s + 0.5);
        const ax = x0 + ((x1 - x0) * s) / len;
        const az = z0 + ((z1 - z0) * s) / len;
        const bx = x0 + ((x1 - x0) * e) / len;
        const bz = z0 + ((z1 - z0) * e) / len;
        pp.box(Math.min(ax, bx) - 0.05, py, Math.min(az, bz) - 0.05, Math.max(ax, bx) + 0.05, py + 0.02, Math.max(az, bz) + 0.05, C.steel);
      }
    };
    // Inside the glass line, so both read.
    dash(rect.x0 + 0.3, rect.z1 - 0.3, rect.x1 - 0.3, rect.z1 - 0.3);
    dash(rect.x0 + 0.3, rect.z0 + 0.3, rect.x0 + 0.3, rect.z1 - 0.3);
    dash(rect.x0 + 0.3, rect.z0 + 0.3, rect.x1 - 0.3, rect.z0 + 0.3);
    dash(rect.x1 - 0.3, rect.z0 + 0.3, rect.x1 - 0.3, rect.z1 - 0.3);
    for (const g of m.glass) pp.box(g.min[0] - 0.03, py, g.min[2] - 0.03, g.max[0] + 0.03, py + 0.03, g.max[2] + 0.03, 0x7fc4ec);
    const dr = { w: DESK_D, d: 1.4 };
    const dc = m.desk.desk;
    pp.box(dc.x - dr.w / 2, py, dc.z - dr.d / 2, dc.x + dr.w / 2, py + 0.05, dc.z + dr.d / 2, P.deskTop);
    pp.box(dc.x - dr.w / 2, py + 0.05, dc.z - dr.d / 2, dc.x - dr.w / 2 + 0.08, py + 0.07, dc.z + dr.d / 2, C.rail);
    pp.box(m.desk.seat.x - 0.24, py, m.desk.seat.z - 0.24, m.desk.seat.x + 0.24, py + 0.05, m.desk.seat.z + 0.24, P.chair);
    this.plan = new THREE.Mesh(pp.build(), this.material);
    this.plan.name = 'mezzanine.plan';
    this.plan.visible = false;

    this.group.add(this.lower, this.upper, this.plate, this.door, this.plan);
  }

  /** The glass door: 0 shut, 1 open. */
  setDoor(open: number): void {
    const k = Math.max(0, Math.min(1, open));
    if (k === this.doorOpen) return;
    this.doorOpen = k;
    this.door.position.x = this.doorClosedX - k * this.doorTravel;
  }

  get door01(): number {
    return this.doorOpen;
  }

  setPlan(on: boolean): void {
    this.upper.visible = this.plate.visible = this.door.visible = !on;
    this.plan.visible = on;
  }

  dispose(): void {
    for (const o of [this.lower, this.upper, this.plate, this.plan, ...this.door.children]) {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    }
    (this.plate.material as THREE.MeshBasicMaterial).map?.dispose();
    (this.plate.material as THREE.Material).dispose();
    this.material.dispose();
    for (const g of this.glass) g.dispose();
  }
}
