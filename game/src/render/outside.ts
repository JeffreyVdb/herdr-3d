import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { attribute, dot, mix, step, uniform, vec3 } from 'three/tsl';
import { FACE, floorY, RAIL_H, RISE, RISERS, SLAB, TREAD, type BuildingPlan } from '../world/building';
import { ROOM_HEIGHT, WALL_T, wallPieces, type Box3, type Opening } from '../world/layout';
import { Baker, bakedMaterial } from './bake';
import type { Look } from './daylook';
import { LobbyView } from './lobby';
import { canvasTexture } from './props';

/**
 * The building from outside and the street around it, in absolute
 * coordinates (street at y 0; the walk scene shifts it under the floor you
 * are on). Everything static is baked into one vertex-coloured mesh: facade
 * shells of every floor, slab bands, the fire escape, the street, lamps,
 * trees, hedges, bollards and the neighbour blocks. The window panes are a
 * second baked mesh so a floor's windows can go dark when it sleeps, and
 * the fire-escape doors of the closed floors a small instanced mesh (the
 * floor you are on draws its own door, which opens).
 *
 * The panes face outwards and are opaque: from outside you can't see in;
 * from inside, back-face culling hides them and you look out.
 *
 * M17: the time of day tints the baked street and facade by their
 * material's colour (never a re-bake). What glows keeps out of that tint:
 * the lamp globes and the neighbours' lit windows are a mesh of their own,
 * the lobby's interior another (its own lights keep it bright), and the
 * panes turn warm at night where a floor is running and stay dark where it
 * sleeps. Pools of lamp light on the ground fade in at dusk.
 */

/** Street palette: the city view's colours, walked at full size. */
export const STREET = {
  sidewalk: 0xe4e0d6,
  tile: 0xd8d2c5,
  curb: 0xc9c3b6,
  road: 0x9aa1ad,
  line: 0xf5f2ea,
  grass: 0x8fcf7f,
  hedge: 0x3f8f4f,
  hedgeTop: 0x55a862,
  trunk: 0x8a5a3b,
  crown: 0x3f9e55,
  crown2: 0x5cb86a,
  grate: 0x6d7383,
  ink: 0x1c2540,
  navy: 0x24406e,
  iron: 0x2a3143,
  yellow: 0xffc233,
  lamp: 0xfff2c4,
  sky: 0xcfe6f6,
};

/** Window colours as the city view draws them: lit when running, dark when asleep. */
export const WINDOW = { lit: 0xcfeaff, litStrip: 0xfff2c4, dark: 0x1d2447, darkStrip: 0x2b2f45 };

export interface BuildingLook {
  name: string;
  tint: number;
  /** Ground floor first. */
  floors: Array<{ session: string; asleep: boolean }>;
}

const color = new THREE.Color();
const mixHex = (a: number, b: number, k: number) => color.set(a).lerp(new THREE.Color(b), k).getHex();

function mergeAll(gs: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = mergeGeometries(gs);
  for (const g of gs) g.dispose();
  return out;
}

/** Deterministic 0..1 noise for placing backdrop details. */
function noise(i: number, salt = 0): number {
  let h = (i * 374761393 + salt * 668265263) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

type V = { x: number; y: number; z: number };
const v = (x: number, y: number, z: number): V => ({ x, y, z });

export class OutsideView {
  readonly group = new THREE.Group();
  readonly lobby: LobbyView;
  private readonly baked: THREE.Mesh;
  private readonly panes: THREE.Mesh;
  /** M17: lamp globes and lit neighbour windows, the lobby's interior, and the lamps' pools of light. */
  private readonly glow: THREE.Mesh;
  private readonly inner: THREE.Mesh;
  private readonly pools: THREE.Mesh;
  /** 1 by day, 0 at night: the panes' own mix (see `paneMaterial`). */
  private readonly paneDay = uniform(1);
  private readonly doorBase: THREE.Color;
  /** Pane vertex ranges per storey: [glass start, count, strip start, count]. */
  private readonly paneRanges: Array<Array<[number, number, boolean]>> = [];
  private readonly doors: THREE.InstancedMesh;
  private readonly doorMatrices: THREE.Matrix4[] = [];
  private readonly textures: THREE.Texture[] = [];
  private loaded: number | null = null;
  private asleep: boolean[] = [];

  constructor(
    readonly plan: BuildingPlan,
    private readonly openings: readonly Opening[],
    look: BuildingLook,
  ) {
    this.group.name = 'outside';
    const b = new Baker();
    const panes = new Baker();
    const glow = new Baker();
    const inner = new Baker();
    const pools: THREE.BufferGeometry[] = [];
    const tint = look.tint;
    this.buildFacade(b, panes, tint);
    this.buildFireEscape(b);
    this.buildStreet(b, glow, pools);
    this.buildNeighbours(b, glow);
    this.lobby = new LobbyView(plan, b, inner, look.name, tint, look.floors.map((f) => f.session));
    this.baked = new THREE.Mesh(b.build(), bakedMaterial());
    this.baked.name = 'outside.baked';
    this.panes = new THREE.Mesh(panes.build(), this.paneMaterial());
    this.panes.name = 'outside.panes';
    this.glow = new THREE.Mesh(glow.build(), bakedMaterial());
    this.glow.name = 'outside.glow';
    this.inner = new THREE.Mesh(inner.build(), bakedMaterial());
    this.inner.name = 'outside.lobby';
    const poolTex = canvasTexture(128, 128, (g) => {
      const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      r.addColorStop(0, 'rgba(255,255,255,1)');
      r.addColorStop(0.45, 'rgba(255,255,255,0.45)');
      r.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = r;
      g.fillRect(0, 0, 128, 128);
    });
    this.textures.push(poolTex);
    this.pools = new THREE.Mesh(
      pools.length ? mergeAll(pools) : new THREE.BufferGeometry(),
      new THREE.MeshBasicNodeMaterial({ map: poolTex, color: 0xffc27a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.pools.name = 'outside.pools';
    this.pools.renderOrder = 1;
    this.group.add(this.baked, this.panes, this.glow, this.inner, this.pools, this.lobby.group);

    // Closed fire-escape doors, one per floor (the loaded floor's is hidden).
    const e = plan.escape;
    const dh = e.door.height;
    const dw = e.door.z1 - e.door.z0;
    const doorGeo = new THREE.BoxGeometry(0.04, dh, dw).translate(0, dh / 2, 0);
    this.doorBase = new THREE.Color(mixHex(STREET.navy, 0x000000, 0.12));
    this.doors = new THREE.InstancedMesh(doorGeo, new THREE.MeshBasicNodeMaterial({ color: this.doorBase.clone() }), plan.floors);
    this.doors.name = 'outside.doors';
    for (let s = 0; s < plan.floors; s++) {
      const m = new THREE.Matrix4().makeTranslation(-WALL_T - 0.02, floorY(s), (e.door.z0 + e.door.z1) / 2);
      this.doorMatrices.push(m);
      this.doors.setMatrixAt(s, m);
    }
    this.doors.instanceMatrix.needsUpdate = true;
    this.doors.computeBoundingSphere();
    this.group.add(this.doors);
    for (const o of [this.baked, this.panes, this.glow, this.inner, this.pools, this.doors]) {
      o.castShadow = false;
      o.receiveShadow = false;
    }
    this.setFloors(look.floors.map((f) => f.asleep));
  }

  // ---- facade ------------------------------------------------------------------

  private buildFacade(b: Baker, panes: Baker, tint: number): void {
    const { width: W, depth: D, floors: n } = this.plan;
    const band = mixHex(tint, 0xffffff, 0.55);
    const reveal = mixHex(tint, STREET.ink, 0.12);
    const frame = mixHex(tint, STREET.ink, 0.45);
    const base = mixHex(tint, STREET.ink, 0.62);
    const T = WALL_T;
    for (let s = 0; s < n; s++) {
      const y0 = floorY(s);
      const y1 = y0 + ROOM_HEIGHT;
      // Slab band under the floor: a ring standing a little proud of the skin.
      this.ring(b, y0 - SLAB, y0, 0.06, band);
      // Skin on the four sides, cut around the windows and the door.
      const skins: Array<[Opening['wall'], Box3, 0 | 2, string]> = [
        ['north', { min: [-FACE, y0, -FACE], max: [W + FACE, y1, -T] }, 0, 'pz'],
        ['south', { min: [-FACE, y0, D + T], max: [W + FACE, y1, D + FACE] }, 0, 'nz'],
        ['west', { min: [-FACE, y0, -T], max: [-T, y1, D + T] }, 2, 'px'],
        ['east', { min: [W + T, y0, -T], max: [W + FACE, y1, D + T] }, 2, 'nx'],
      ];
      for (const [side, box, axis, inner] of skins) {
        const holes = this.openings.filter((o) => o.wall === side).map((o) => ({ ...o, y0: y0 + o.y0, y1: y0 + o.y1 }));
        for (const p of wallPieces(box, axis, holes)) b.box(p.min[0], p.min[1], p.min[2], p.max[0], p.max[1], p.max[2], tint, inner);
        // Reveals (the hole sides) read darker; outward panes, a mullion and a sill per window.
        const ranges: Array<[number, number, boolean]> = (this.paneRanges[s] ??= []);
        for (const o of this.openings.filter((w) => w.wall === side)) {
          if (o.kind === 'door') continue;
          this.windowOutside(b, panes, side, o, y0, reveal, frame, ranges);
        }
      }
    }
    // The lobby storey: a darker plinth, glass across the front (lobby.ts).
    const y1 = ROOM_HEIGHT;
    b.box(-FACE, 0, -FACE, W + FACE, y1, -T, base, 'pz');
    b.box(-FACE, 0, -T, -T, y1, D + T, base, 'px');
    b.box(W + T, 0, -T, W + FACE, y1, D + T, base, 'nx');
    // Roof: the top slab band, a parapet, the roof deck, a rooftop box.
    const top = floorY(n - 1) + ROOM_HEIGHT;
    this.ring(b, top, top + SLAB, 0.06, band);
    const ry = top + SLAB;
    const par = 0.55;
    b.box(-FACE - 0.06, ry, -FACE - 0.06, W + FACE + 0.06, ry + par, -FACE + 0.2, reveal);
    b.box(-FACE - 0.06, ry, D + FACE - 0.2, W + FACE + 0.06, ry + par, D + FACE + 0.06, reveal);
    b.box(-FACE - 0.06, ry, -FACE + 0.2, -FACE + 0.2, ry + par, D + FACE - 0.2, reveal);
    b.box(W + FACE - 0.2, ry, -FACE + 0.2, W + FACE + 0.06, ry + par, D + FACE - 0.2, reveal);
    b.quad(v(-FACE, ry + 0.01, D + FACE), v(W + FACE, ry + 0.01, D + FACE), v(W + FACE, ry + 0.01, -FACE), v(-FACE, ry + 0.01, -FACE), 0xb7bcc6);
    b.box(W * 0.62, ry, D * 0.25, W * 0.62 + 3, ry + 1.6, D * 0.25 + 2.2, 0xd6dae2);
    // Elevator shaft up the front, a shade darker, with its machine room on the roof.
    const sh = this.plan.shaft;
    const shTop = ry + 1.4;
    b.box(sh.x0, 0, D + FACE, sh.x1, shTop, sh.z1, reveal, 'nz');
    b.box(sh.x0 - 0.05, shTop, D + FACE - 0.4, sh.x1 + 0.05, shTop + 0.18, sh.z1 + 0.05, band);
    // A slim lit strip up the shaft, one lamp per storey.
    for (let s = -1; s < n; s++) {
      const y = floorY(s) + 1.3;
      b.box((sh.x0 + sh.x1) / 2 - 0.12, y, sh.z1, (sh.x0 + sh.x1) / 2 + 0.12, y + 0.9, sh.z1 + 0.03, s < 0 ? STREET.yellow : frame, 'nz');
    }
  }

  /** A ring of four boxes around the outline at y0..y1, `out` proud of the skin. */
  private ring(b: Baker, y0: number, y1: number, out: number, hex: number): void {
    const { width: W, depth: D } = this.plan;
    const o = FACE + out;
    const i = WALL_T;
    b.box(-o, y0, -o, W + o, y1, -i, hex);
    b.box(-o, y0, D + i, W + o, y1, D + o, hex);
    b.box(-o, y0, -i, -i, y1, D + i, hex);
    b.box(W + i, y0, -i, W + o, y1, D + i, hex);
  }

  private windowOutside(b: Baker, panes: Baker, side: Opening['wall'], o: Opening, y0: number, reveal: number, frame: number, ranges: Array<[number, number, boolean]>): void {
    const { width: W, depth: D } = this.plan;
    // Outward normal, the plane of the pane (just behind the skin face), and the along-wall axis.
    const out = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] }[side] as [number, number];
    const face = { north: -FACE, south: D + FACE, west: -FACE, east: W + FACE }[side];
    const at = (u: number, d: number, y: number): V => {
      // d: distance outward from the skin face (negative: recessed).
      const w = face + d * (out[0] || out[1]);
      return side === 'north' || side === 'south' ? v(u, y, w) : v(w, y, u);
    };
    const ya = y0 + o.y0;
    const yb = y0 + o.y1;
    // The pane, then a warm ceiling-light strip along its top (seen through the glass).
    const quadOut = (bk: Baker, u0: number, u1: number, lo: number, hi: number, d: number, hex: number) => {
      // Counter-clockwise seen from outside.
      const flip = side === 'south' || side === 'west';
      const [a, c] = flip ? [u0, u1] : [u1, u0];
      bk.quad(at(a, d, lo), at(c, d, lo), at(c, d, hi), at(a, d, hi), hex, true);
    };
    const start = panes.mark();
    quadOut(panes, o.u0, o.u1, ya, yb, -0.03, WINDOW.lit);
    ranges.push([start, panes.mark() - start, false]);
    const s2 = panes.mark();
    quadOut(panes, o.u0, o.u1, yb - 0.16, yb - 0.08, -0.025, WINDOW.litStrip);
    ranges.push([s2, panes.mark() - s2, true]);
    // Mullion and sill in the frame colour; the sill's top catches the light.
    const mid = (o.u0 + o.u1) / 2;
    const boxAt = (u0: number, u1: number, lo: number, hi: number, d0: number, d1: number, hex: number) => {
      const p = at(u0, d0, lo);
      const q = at(u1, d1, hi);
      b.box(Math.min(p.x, q.x), lo, Math.min(p.z, q.z), Math.max(p.x, q.x), hi, Math.max(p.z, q.z), hex);
    };
    boxAt(mid - 0.035, mid + 0.035, ya, yb, -0.03, 0.0, frame);
    boxAt(o.u0 - 0.08, o.u1 + 0.08, ya - 0.08, ya, -0.03, 0.08, reveal);
    boxAt(o.u0, o.u1, yb - 0.04, yb, -0.03, 0.0, frame);
  }

  // ---- fire escape ---------------------------------------------------------------

  private buildFireEscape(b: Baker): void {
    const e = this.plan.escape;
    const n = this.plan.floors;
    const deck = STREET.iron;
    const rail = STREET.yellow;
    const x0 = e.outer.x0;
    const x1 = e.inner.x1;
    const xr = x0 - 0.05; // outer rail line
    const post = (x: number, z: number, y: number, h = RAIL_H) => b.box(x - 0.03, y, z - 0.03, x + 0.03, y + h, z + 0.03, rail, 'ny');
    const bar = (a: V, c: V, t = 0.05) => this.beam(b, a, c, t, t, rail);
    for (let s = 0; s < n; s++) {
      const y = floorY(s);
      const yh = y - RISERS * RISE;
      // Landing and half landing decks, with slats (a grating) and brackets to the wall.
      b.box(x0, y - 0.08, e.landing.z0, x1, y, e.landing.z1, deck);
      b.box(x0, yh - 0.08, e.half.z0, x1, yh, e.half.z1, deck);
      for (const [yy, z0, z1] of [
        [y, e.landing.z0, e.landing.z1],
        [yh, e.half.z0, e.half.z1],
      ] as const) {
        for (let z = z0 + 0.25; z < z1 - 0.1; z += 0.3) b.box(x0 + 0.05, yy, z - 0.02, x1 - 0.05, yy + 0.012, z + 0.02, 0x3a4257, 'ny');
        this.beam(b, v(x1, yy - 0.9, (z0 + z1) / 2), v(x0 + 0.3, yy - 0.08, (z0 + z1) / 2), 0.08, 0.08, deck);
      }
      // Landing rails: west and south edges.
      for (const h of [0.55, RAIL_H]) {
        bar(v(xr, y + h, e.landing.z0), v(xr, y + h, e.landing.z1 + 0.05));
        bar(v(xr, y + h, e.landing.z1 + 0.05), v(x1, y + h, e.landing.z1 + 0.05));
        bar(v(xr, yh + h, e.half.z0 - 0.05), v(xr, yh + h, e.half.z1));
        bar(v(xr, yh + h, e.half.z0 - 0.05), v(x1, yh + h, e.half.z0 - 0.05));
      }
      for (const z of [e.landing.z1 + 0.05, (e.landing.z0 + e.landing.z1) / 2, e.half.z0 - 0.05]) post(xr, z, z < e.landing.z0 ? yh : y);
      post((x0 + x1) / 2, e.landing.z1 + 0.05, y);
      post(x1 - 0.05, e.landing.z1 + 0.05, y);
      post(x1 - 0.05, e.half.z0 - 0.05, yh);
      post((x0 + x1) / 2, e.half.z0 - 0.05, yh);
      // Treads, open risers.
      for (const t of e.treads.filter((q) => q.storey === s)) b.box(t.rect.x0 + 0.04, t.y - 0.045, t.rect.z0 + 0.01, t.rect.x1 - 0.04, t.y, t.rect.z1 - 0.01, deck);
      // Stringers and hand rails along both flights (they slope with the nosings).
      const zTop = e.landing.z0;
      const zBot = e.flights.z0;
      const f1 = [v(0, y, zTop), v(0, yh, zBot)] as const; // flight 1: outer lane, down north
      const f2 = [v(0, yh, zBot), v(0, y - 2 * RISERS * RISE, zTop)] as const; // flight 2: inner lane, down south
      const along = (x: number, [a, c]: readonly [V, V], dy: number, t = 0.05, hex = rail) => this.beam(b, v(x, a.y + dy, a.z), v(x, c.y + dy, c.z), t, t, hex);
      along(e.outer.x0 + 0.04, f1, -0.12, 0.08);
      along(e.outer.x1 - 0.04, f1, -0.12, 0.08);
      along(e.inner.x0 + 0.04, f2, -0.12, 0.08);
      along(e.inner.x1 - 0.04, f2, -0.12, 0.08);
      for (const h of [0.55, 0.95]) {
        along(xr, f1, h);
        along((e.rail.x0 + e.rail.x1) / 2, f1, h);
        along((e.rail.x0 + e.rail.x1) / 2, f2, h);
      }
      // Balusters: along the outer rail, and between the two flights on the centre rail.
      const drop = (RISERS * RISE) / (RISERS - 1);
      for (let i = 0; i <= RISERS - 1; i += 2) {
        const z = zTop - i * TREAD;
        const y1 = y - i * drop;
        const y2 = yh - (RISERS - 1 - i) * drop;
        post(xr, z, y1 - 0.02, 0.97);
        b.box((e.rail.x0 + e.rail.x1) / 2 - 0.025, y2 - 0.02, z - 0.025, (e.rail.x0 + e.rail.x1) / 2 + 0.025, y1 + 0.95, z + 0.025, rail, 'ny');
      }
    }
    // The top landing's inner lane: a rail where no flight goes up.
    const top = floorY(n - 1);
    for (const h of [0.55, RAIL_H]) this.beam(b, v(e.inner.x0, top + h, e.landing.z0 - 0.05), v(x1, top + h, e.landing.z0 - 0.05), 0.05, 0.05, rail);
    // At street level, a low gate across the outer lane under the flights.
    for (const h of [0.5, 1.0]) this.beam(b, v(e.outer.x0, h, e.landing.z0), v(e.outer.x1, h, e.landing.z0), 0.05, 0.05, rail);
    // Uprights from the street to the top landing at the outer corners.
    for (const z of [e.half.z0 - 0.05, e.landing.z1 + 0.05]) b.box(xr - 0.05, 0, z - 0.05, xr + 0.05, top + RAIL_H, z + 0.05, deck);
  }

  /** A box beam from a to c (its length along the line), w wide and h tall. */
  private beam(b: Baker, a: V, c: V, w: number, h: number, hex: number): void {
    const dir = new THREE.Vector3(c.x - a.x, c.y - a.y, c.z - a.z);
    const len = dir.length();
    if (len < 1e-4) return;
    const g = new THREE.BoxGeometry(w, h, len);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize());
    const m = new THREE.Matrix4().compose(new THREE.Vector3((a.x + c.x) / 2, (a.y + c.y) / 2, (a.z + c.z) / 2), q, new THREE.Vector3(1, 1, 1));
    b.geo(g, hex, m);
    g.dispose();
  }

  // ---- street -------------------------------------------------------------------

  private buildStreet(b: Baker, glow: Baker, pools: THREE.BufferGeometry[]): void {
    const P = this.plan;
    const { width: W, depth: D, fence: f, road } = P;
    const FAR = 90;
    // Ground: tiles on the sidewalks (front and fire-escape side), grass behind and east.
    const tiles = (x0: number, z0: number, x1: number, z1: number) => {
      const s = 1.5;
      for (let x = x0, i = 0; x < x1 - 1e-6; x += s, i++) {
        for (let z = z0, j = 0; z < z1 - 1e-6; z += s, j++) {
          const hex = (i + j) % 2 ? STREET.tile : STREET.sidewalk;
          const xa = Math.min(x1, x + s);
          const za = Math.min(z1, z + s);
          b.quad(v(x, 0.002, za), v(xa, 0.002, za), v(xa, 0.002, z), v(x, 0.002, z), hex);
        }
      }
    };
    const flat = (x0: number, z0: number, x1: number, z1: number, y: number, hex: number) => b.quad(v(x0, y, z1), v(x1, y, z1), v(x1, y, z0), v(x0, y, z0), hex);
    tiles(f.west, D + FACE, f.east, f.curb);
    tiles(f.west, f.north, -FACE, D + FACE);
    flat(-FACE, f.north, f.east, -FACE, 0.002, STREET.grass);
    flat(W + FACE, -FACE, f.east, D + FACE, 0.002, STREET.grass);
    // Beyond the fences: the sidewalk runs on (backdrop), grass everywhere else.
    flat(-FAR, D - 30, f.west, f.curb, 0.0, STREET.sidewalk);
    flat(f.east, D + FACE, W + FAR, f.curb, 0.0, STREET.sidewalk);
    flat(-FAR, -FAR, W + FAR, f.curb, -0.03, STREET.grass);
    flat(-FAR, road.z1 + 4, W + FAR, road.z1 + FAR, -0.03, STREET.grass);
    // Curb, road (with its centre line), the far curb and sidewalk.
    b.box(-FAR, -0.16, f.curb - 0.02, W + FAR, 0.01, road.z0, STREET.curb, 'ny');
    flat(-FAR, road.z0, W + FAR, road.z1, -0.14, STREET.road);
    const mid = (road.z0 + road.z1) / 2;
    for (let x = -FAR; x < W + FAR; x += 3) flat(x, mid - 0.07, x + 1.6, mid + 0.07, -0.135, STREET.line);
    for (const z of [road.z0 + 0.35, road.z1 - 0.35]) flat(-FAR, z - 0.05, W + FAR, z + 0.05, -0.135, STREET.line);
    b.box(-FAR, -0.16, road.z1, W + FAR, 0.01, road.z1 + 0.25, STREET.curb, 'ny');
    flat(-FAR, road.z1 + 0.25, W + FAR, road.z1 + 4, 0.0, STREET.sidewalk);

    // West fence: iron posts and two rails.
    for (let z = f.north; z <= f.curb + 1e-6; z += 1.5) b.box(f.west - 0.05, 0, z - 0.05, f.west + 0.05, 1.25, z + 0.05, STREET.iron, 'ny');
    for (const y of [0.45, 1.15]) b.box(f.west - 0.03, y, f.north, f.west + 0.03, y + 0.06, f.curb, STREET.iron);
    // Hedges north and east (a lighter top, a narrower upper tier: rounder).
    const hedge = (x0: number, z0: number, x1: number, z1: number) => {
      b.box(x0, 0, z0, x1, 0.9, z1, STREET.hedge, 'ny');
      b.box(x0 + 0.08, 0.9, z0 + 0.08, x1 - 0.08, 1.2, z1 - 0.08, STREET.hedgeTop, 'ny');
    };
    hedge(f.west + 0.1, f.north - 0.3, f.east + 0.3, f.north + 0.3);
    hedge(f.east - 0.3, f.north + 0.3, f.east + 0.3, f.curb - 0.3);
    // Bollards along the curb, a chain slung between them.
    const bollard = new THREE.CylinderGeometry(0.1, 0.12, 0.9, 10).translate(0, 0.45, 0);
    const cap = new THREE.SphereGeometry(0.1, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 0.9, 0);
    const band = new THREE.CylinderGeometry(0.105, 0.105, 0.08, 10).translate(0, 0.72, 0);
    let prev: number | null = null;
    for (let x = f.west + 0.6; x <= f.east - 0.3; x += 1.5) {
      const m = new THREE.Matrix4().makeTranslation(x, 0, f.curb);
      b.geo(bollard, STREET.navy, m);
      b.geo(cap, STREET.navy, m);
      b.geo(band, STREET.yellow, m);
      if (prev !== null) {
        const sag = 0.1;
        this.beam(b, v(prev, 0.62, f.curb), v((prev + x) / 2, 0.62 - sag, f.curb), 0.025, 0.025, STREET.iron);
        this.beam(b, v((prev + x) / 2, 0.62 - sag, f.curb), v(x, 0.62, f.curb), 0.025, 0.025, STREET.iron);
      }
      prev = x;
    }
    bollard.dispose();
    cap.dispose();
    band.dispose();

    // Street lamps: a navy pole, an arm out over the sidewalk, a warm globe.
    const pole = new THREE.CylinderGeometry(0.06, 0.09, 4.2, 10).translate(0, 2.1, 0);
    const foot = new THREE.CylinderGeometry(0.16, 0.2, 0.35, 10).translate(0, 0.175, 0);
    const globe = new THREE.SphereGeometry(0.24, 14, 10);
    for (const l of P.lamps) {
      const m = new THREE.Matrix4().makeTranslation(l.x, 0, l.z);
      b.geo(pole, STREET.navy, m);
      b.geo(foot, STREET.navy, m);
      const tip = v(l.x, 4.05, l.z + 0.75); // the arm reaches out over the road
      this.beam(b, v(l.x, 4.1, l.z), tip, 0.07, 0.07, STREET.navy);
      const gm = new THREE.Matrix4().makeTranslation(tip.x, tip.y - 0.28, tip.z);
      glow.geo(globe, STREET.lamp, gm);
      pools.push(new THREE.PlaneGeometry(5.2, 5.2).rotateX(-Math.PI / 2).translate(tip.x, 0.03, tip.z));
      b.box(tip.x - 0.16, tip.y - 0.08, tip.z - 0.16, tip.x + 0.16, tip.y + 0.02, tip.z + 0.16, STREET.navy);
    }
    pole.dispose();
    foot.dispose();
    globe.dispose();

    // Trees: a grate on the sidewalk (grass in the yard), a trunk, two round crowns.
    const trunk = new THREE.CylinderGeometry(0.1, 0.15, 2.3, 8).translate(0, 1.15, 0);
    const crown = new THREE.IcosahedronGeometry(1.15, 1);
    const crown2 = new THREE.IcosahedronGeometry(0.8, 1);
    P.trees.forEach((t, i) => {
      const s = 0.85 + noise(i, 7) * 0.35;
      const onWalk = t.z > D;
      if (onWalk) {
        b.box(t.x - 0.65, 0.0, t.z - 0.65, t.x + 0.65, 0.012, t.z + 0.65, STREET.grate, 'ny');
        b.box(t.x - 0.5, 0.012, t.z - 0.5, t.x + 0.5, 0.02, t.z + 0.5, 0x5b4636, 'ny');
      }
      const m = new THREE.Matrix4().makeTranslation(t.x, 0, t.z).multiply(new THREE.Matrix4().makeScale(s, s, s));
      b.geo(trunk, STREET.trunk, m);
      b.geo(crown, i % 2 ? STREET.crown : STREET.crown2, new THREE.Matrix4().makeTranslation(t.x, 2.7 * s, t.z).multiply(new THREE.Matrix4().makeScale(s, s * 0.95, s)));
      b.geo(crown2, i % 2 ? STREET.crown2 : STREET.crown, new THREE.Matrix4().makeTranslation(t.x + 0.45 * s, 3.45 * s, t.z - 0.2 * s).multiply(new THREE.Matrix4().makeScale(s, s, s)));
    });
    trunk.dispose();
    crown.dispose();
    crown2.dispose();
  }

  // ---- backdrop -------------------------------------------------------------------

  private buildNeighbours(b: Baker, glow: Baker): void {
    const P = this.plan;
    const { width: W, depth: D, fence: f, road } = P;
    const TINTS = [0xd9c8b4, 0xb9c7d6, 0xc9d8c0, 0xe0c6c0, 0xcfc5de, 0xd6d0b8, 0xc4d3d9];
    let k = 0;
    const block = (x0: number, z0: number, x1: number, z1: number, h: number, faces: string) => {
      const i = k++;
      const hex = TINTS[i % TINTS.length] as number;
      const trim = mixHex(hex, STREET.ink, 0.25);
      b.box(x0, -0.03, z0, x1, h, z1, hex, 'ny');
      b.box(x0 - 0.15, h, z0 - 0.15, x1 + 0.15, h + 0.35, z1 + 0.15, trim, 'ny');
      if (noise(i, 3) > 0.45) {
        const cx = x0 + (x1 - x0) * (0.25 + noise(i, 4) * 0.5);
        const cz = z0 + (z1 - z0) * (0.3 + noise(i, 5) * 0.4);
        b.geo(new THREE.CylinderGeometry(0.9, 0.9, 1.6, 10).translate(cx, h + 1.35 + 0.8, cz), 0x9a7a5a);
        b.geo(new THREE.ConeGeometry(1.0, 0.6, 10).translate(cx, h + 3.25, cz), 0x7a5a3a);
        for (const [dx, dz] of [
          [-0.6, -0.6],
          [0.6, -0.6],
          [-0.6, 0.6],
          [0.6, 0.6],
        ] as const)
          b.box(cx + dx - 0.05, h + 0.35, cz + dz - 0.05, cx + dx + 0.05, h + 1.35, cz + dz + 0.05, STREET.iron, 'ny');
      }
      // Window grid on the faces that look at us.
      const win = (u0: number, u1: number, face: string) => {
        const rows = Math.floor((h - 1.5) / 3.3);
        const cols = Math.max(1, Math.floor((u1 - u0 - 1) / 2.6));
        const pitch = (u1 - u0) / cols;
        for (let r = 0; r < rows; r++) {
          const y = 1.4 + r * 3.3;
          for (let c = 0; c < cols; c++) {
            const u = u0 + (c + 0.5) * pitch;
            const lit = noise(i * 131 + r * 17 + c, 9);
            const glass = lit > 0.86 ? STREET.lamp : lit > 0.45 ? 0x7f95b0 : 0x5d6f8c;
            // Somebody's lit window glows at night like the lamps (M17).
            const bk = lit > 0.86 ? glow : b;
            const [a, cc] = [u - 0.7, u + 0.7];
            if (face === 'pz') bk.quad(v(a, y, z1 + 0.02), v(cc, y, z1 + 0.02), v(cc, y + 1.6, z1 + 0.02), v(a, y + 1.6, z1 + 0.02), glass, true);
            if (face === 'nz') bk.quad(v(cc, y, z0 - 0.02), v(a, y, z0 - 0.02), v(a, y + 1.6, z0 - 0.02), v(cc, y + 1.6, z0 - 0.02), glass, true);
            if (face === 'px') bk.quad(v(x1 + 0.02, y, cc), v(x1 + 0.02, y, a), v(x1 + 0.02, y + 1.6, a), v(x1 + 0.02, y + 1.6, cc), glass, true);
            if (face === 'nx') bk.quad(v(x0 - 0.02, y, a), v(x0 - 0.02, y, cc), v(x0 - 0.02, y + 1.6, cc), v(x0 - 0.02, y + 1.6, a), glass, true);
          }
        }
      };
      for (const face of faces.split(' ')) win(face.endsWith('z') ? x0 : z0, face.endsWith('z') ? x1 : z1, face);
    };
    // Across the road: a row of blocks facing us (north faces).
    const zs = road.z1 + 4.5;
    let x = -34;
    while (x < W + 34) {
      const w = 9 + noise(k, 1) * 8;
      block(x, zs, x + w, zs + 12, 8 + Math.round(noise(k, 2) * 5) * 3.3, 'nz');
      x += w + 1.2 + noise(k, 6) * 2;
    }
    // West, beyond an alley; east, beyond the hedge; north, behind.
    block(f.west - 18, -16, f.west - 4, D * 0.45, 11 + noise(1, 8) * 12, 'px');
    block(f.west - 16, D * 0.45 + 1.5, f.west - 4, f.curb - 0.5, 8 + noise(2, 8) * 8, 'px');
    block(f.east + 4, -14, f.east + 17, D * 0.5, 14 + noise(3, 8) * 10, 'nx');
    block(f.east + 4, D * 0.5 + 1.5, f.east + 15, f.curb - 0.5, 9 + noise(4, 8) * 6, 'nx');
    for (let xx = -20; xx < W + 20; xx += 15) block(xx, f.north - 20, xx + 12.5, f.north - 5, 10 + noise(k, 8) * 14, 'pz');
  }

  // ---- state ----------------------------------------------------------------------

  /**
   * The panes' material: by day their painted colours (a running floor's pale
   * sky, a sleeping one's navy); at night a running floor's panes glow warm,
   * a sleeping one's go nearly black. One node graph, one uniform to move.
   */
  private paneMaterial(): THREE.MeshBasicNodeMaterial {
    const m = new THREE.MeshBasicNodeMaterial();
    const painted = attribute('color', 'vec3');
    const lit = step(0.3, dot(painted, vec3(0.2126, 0.7152, 0.0722)));
    const night = mix(painted.mul(0.3), vec3(1.0, 0.72, 0.36), lit);
    m.colorNode = mix(night, painted, this.paneDay);
    return m;
  }

  /** M17: the time of day on the baked outside (see the class comment). */
  setDaylight(look: Look): void {
    (this.baked.material as THREE.MeshBasicNodeMaterial).color.copy(look.outside);
    (this.inner.material as THREE.MeshBasicNodeMaterial).color.copy(look.inside);
    (this.doors.material as THREE.MeshBasicNodeMaterial).color.copy(this.doorBase).multiply(look.outside);
    // The globes and lit windows are glowing colour already: the dark around them and the pools say they are on.
    (this.pools.material as THREE.MeshBasicNodeMaterial).opacity = 0.5 * look.lamps;
    this.paneDay.value = look.day;
    this.lobby.setDaylight(look);
  }

  /** Running floors' windows lit, asleep floors' dark (ground floor first). */
  setFloors(asleep: boolean[]): void {
    const geo = this.panes.geometry;
    this.paneRanges.forEach((ranges, s) => {
      const a = asleep[s] ?? false;
      if (this.asleep[s] === a) return;
      for (const [start, count, strip] of ranges) Baker.paint(geo, start, count, a ? (strip ? WINDOW.darkStrip : WINDOW.dark) : strip ? WINDOW.litStrip : WINDOW.lit);
    });
    this.asleep = [...asleep];
  }

  /** The floor with an interior draws its own door; hide its closed one here. */
  setLoaded(storey: number | null): void {
    if (storey === this.loaded) return;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    if (this.loaded !== null && this.doorMatrices[this.loaded]) this.doors.setMatrixAt(this.loaded, this.doorMatrices[this.loaded] as THREE.Matrix4);
    if (storey !== null && this.doorMatrices[storey]) this.doors.setMatrixAt(storey, zero);
    this.doors.instanceMatrix.needsUpdate = true;
    this.loaded = storey;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.lobby.dispose();
    for (const o of [this.baked, this.panes, this.glow, this.inner, this.pools, this.doors]) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
    for (const t of this.textures) t.dispose();
  }
}
