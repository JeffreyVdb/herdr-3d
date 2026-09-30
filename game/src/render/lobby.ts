import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FACE, type BuildingPlan } from '../world/building';
import { pickNearest, type V3 } from '../world/collide';
import { ROOM_HEIGHT, WALL_T, type Box3 } from '../world/layout';
import type { Baker } from './bake';
import type { Look } from './daylook';
import { FONT } from './cards/atlasCards';
import { GLASS_IN } from './office';
import { OFFICE } from './palette';
import { LogoSign } from './logoSign';
import type { LogoEntry } from './logos';
import { canvasTexture, elevatorMeshes } from './props';

/**
 * The lobby on the ground storey: a glass front onto the sidewalk with
 * sliding doors, the reception desk facing them (the receptionist stands
 * behind it, in front of a navy feature wall with the building's name), a
 * bench, plants, a floor directory, and the elevator where it is on every
 * floor. Its static parts are baked: the front and the canopy into the
 * outside mesh, the room into a mesh of its own (M17: its own lights keep it
 * lit at night, when the street darkens); the glass, the doors, the elevator,
 * the signs and the receptionist are their own meshes.
 */

export type LobbyTarget = 'reception' | 'elevator';

const C = {
  floor: 0xece5d7,
  border: 0xd7cdb8,
  wall: 0xf4f1ea,
  ceiling: 0xfbfcff,
  panel: 0xfff6dd,
  navy: 0x24406e,
  ink: 0x1c2540,
  yellow: 0xffc233,
  mat: 0x2c3a5e,
};

export class LobbyView {
  readonly group = new THREE.Group();
  /** Where the receptionist stands (feet), facing +z: the reception's object goes in here. */
  readonly slot = new THREE.Group();
  private readonly leaves: THREE.Group[] = [];
  private readonly textures: THREE.Texture[] = [];
  private open = 0;
  private readonly targets: Array<{ boxes: Box3[]; value: LobbyTarget }>;
  private placeholder: THREE.Object3D | null = null;
  private readonly glassMat: THREE.MeshBasicNodeMaterial;
  /** M3d: the entrance sign and the reception wall, which show the logo when there is one. */
  readonly signs: { canopy: LogoSign; wall: LogoSign };

  constructor(
    private readonly plan: BuildingPlan,
    b: Baker,
    /** The room itself (floor, walls, ceiling, desk, bench, plants): baked apart from the front. */
    inner: Baker,
    name: string,
    tint: number,
    floors: string[],
  ) {
    this.group.name = 'lobby';
    const { width: W, depth: D } = plan;
    const L = plan.lobby;
    const T = WALL_T;
    const H = ROOM_HEIGHT;
    const v = (x: number, y: number, z: number) => ({ x, y, z });
    const flat = (x0: number, z0: number, x1: number, z1: number, y: number, hex: number) => inner.quad(v(x0, y, z1), v(x1, y, z1), v(x1, y, z0), v(x0, y, z0), hex);
    const base = new THREE.Color(tint).lerp(new THREE.Color(C.ink), 0.62).getHex();

    // Floor: pale terrazzo with a border, a mat inside the door and a runner up to the desk.
    flat(0, 0, W, D, 0.002, C.border);
    flat(0.45, 0.45, W - 0.45, D - 0.45, 0.004, C.floor);
    flat(L.front.x0 - 0.2, D - 1.8, L.front.x1 + 0.2, D - 0.05, 0.007, C.mat);
    flat(L.front.x0 + 0.15, L.desk.z1 + 0.25, L.front.x1 - 0.15, D - 1.8, 0.006, OFFICE.rug);
    // Walls: the room faces (the facade skin is outside.ts), navy skirting, the ceiling and its lights.
    inner.box(-T, 0, -T, W + T, H, 0, C.wall, 'nz');
    inner.box(-T, 0, 0, 0, H, D, C.wall, 'nx');
    inner.box(W, 0, 0, W + T, H, D, C.wall, 'px');
    inner.box(0, 0, 0, W, 0.12, 0.03, C.navy);
    inner.box(0, 0, 0, 0.03, 0.12, D, C.navy);
    inner.box(W - 0.03, 0, 0, W, 0.12, D, C.navy);
    inner.quad(v(0, H, 0), v(W, H, 0), v(W, H, D), v(0, H, D), C.ceiling, true);
    const nx = Math.max(2, Math.round(W / 4.5));
    const nz = Math.max(2, Math.round(D / 4.5));
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const x = ((i + 0.5) * W) / nx;
        const z = ((j + 0.5) * D) / nz;
        inner.quad(v(x - 0.7, H - 0.01, z - 0.3), v(x + 0.7, H - 0.01, z - 0.3), v(x + 0.7, H - 0.01, z + 0.3), v(x - 0.7, H - 0.01, z + 0.3), C.panel, true);
      }

    // The front: piers and a transom in the plinth colour, mullions, glass (see-through both ways).
    const sh = plan.shaft;
    const runs: Array<[number, number]> = [
      [0.2, L.front.x0 - 0.12],
      [L.front.x1 + 0.12, sh.x0 - 0.15],
      [sh.x1 + 0.15, W - 0.2],
    ];
    const zf = D + T / 2 + 0.02;
    b.box(-FACE, 0, D, 0.2, H, D + FACE, base);
    b.box(W - 0.2, 0, D, W + FACE, H, D + FACE, base);
    b.box(sh.x0 - 0.15, 0, D, sh.x1 + 0.15, H, D + FACE, base);
    b.box(L.front.x0 - 0.12, 0, D, L.front.x0, H, D + FACE, base);
    b.box(L.front.x1, 0, D, L.front.x1 + 0.12, H, D + FACE, base);
    b.box(L.front.x0, L.front.height, D, L.front.x1, H, D + FACE, base);
    const glass: THREE.BufferGeometry[] = [];
    for (const [x0, x1] of runs) {
      if (x1 - x0 < 0.3) continue;
      b.box(x0, 0, D, x1, 0.14, D + FACE, base);
      b.box(x0, H - 0.3, D, x1, H, D + FACE, base);
      const n = Math.max(1, Math.round((x1 - x0) / 1.9));
      for (let i = 1; i < n; i++) {
        const x = x0 + ((x1 - x0) * i) / n;
        b.box(x - 0.04, 0.14, zf - 0.05, x + 0.04, H - 0.3, zf + 0.05, base);
      }
      const w = x1 - x0;
      const h = H - 0.3 - 0.14;
      glass.push(new THREE.PlaneGeometry(w, h).translate((x0 + x1) / 2, 0.14 + h / 2, zf + 0.001));
      glass.push(new THREE.PlaneGeometry(w, h).rotateY(Math.PI).translate((x0 + x1) / 2, 0.14 + h / 2, zf - 0.001));
    }
    const glassMat = new THREE.MeshBasicNodeMaterial({ color: GLASS_IN.color, transparent: true, opacity: 0.22, depthWrite: false });
    this.glassMat = glassMat;
    const front = new THREE.Mesh(mergeAll(glass), glassMat);
    front.name = 'lobby.glass';
    this.group.add(front);

    // Sliding doors: two glass leaves in navy frames.
    const leafW = (L.front.x1 - L.front.x0) / 2;
    const lh = L.front.height;
    const frameMat = new THREE.MeshBasicNodeMaterial({ color: C.navy });
    const frameGeo = mergeAll([
      new THREE.BoxGeometry(leafW, 0.08, 0.06).translate(0, 0.04, 0),
      new THREE.BoxGeometry(leafW, 0.08, 0.06).translate(0, lh - 0.04, 0),
      new THREE.BoxGeometry(0.06, lh, 0.06).translate(-leafW / 2 + 0.03, lh / 2, 0),
      new THREE.BoxGeometry(0.06, lh, 0.06).translate(leafW / 2 - 0.03, lh / 2, 0),
      new THREE.BoxGeometry(leafW * 0.6, 0.05, 0.1).translate(0, 1.05, 0),
    ]);
    const paneGeo = mergeAll([new THREE.PlaneGeometry(leafW - 0.1, lh - 0.14).translate(0, lh / 2, 0.001), new THREE.PlaneGeometry(leafW - 0.1, lh - 0.14).rotateY(Math.PI).translate(0, lh / 2, -0.001)]);
    for (const k of [-1, 1]) {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(frameGeo, frameMat), new THREE.Mesh(paneGeo, glassMat));
      g.position.set((L.front.x0 + L.front.x1) / 2 + (k * leafW) / 2, 0, D + 0.07);
      g.userData.home = g.position.x;
      g.userData.dir = k;
      this.leaves.push(g);
      this.group.add(g);
    }

    // Canopy over the door, with the building's name facing the street.
    const cx0 = L.front.x0 - 0.8;
    const cx1 = L.front.x1 + 0.8;
    b.box(cx0, 2.64, D + FACE, cx1, 2.8, D + 1.7, C.navy);
    for (const x of [cx0 + 0.1, cx1 - 0.1]) b.box(x - 0.02, 2.8, D + 1.5, x + 0.02, 3.2, D + 1.54, C.navy);
    const canopyTex = this.tex(nameTexture(name, `${floors.length} ${floors.length === 1 ? 'floor' : 'floors'} · reception`, '#1c2540', '#ffffff', '#ffc233'));
    const cw = cx1 - cx0;
    const canopySign = new THREE.Mesh(new THREE.PlaneGeometry(cw, cw / 4), new THREE.MeshBasicNodeMaterial({ map: canopyTex }));
    canopySign.position.set((cx0 + cx1) / 2, 2.8 + cw / 8, D + 1.72);
    this.group.add(canopySign);
    const canopyLogo = new LogoSign(canopySign, cw, cw / 4, { plate: 0xfff6dd, bezel: C.navy, pad: 0.1, rim: 0.07 });

    // Reception: the feature wall, the desk (navy front, wood top, a yellow stripe), a monitor.
    const bw = L.backWall;
    inner.box(bw.x0, 0, bw.z0, bw.x1, 2.7, bw.z1, C.navy);
    inner.box(bw.x0, 2.7, bw.z0, bw.x1, 2.76, bw.z1, C.yellow);
    const wallTex = this.tex(nameTexture(name, 'Welcome · reception', '#24406e', '#ffffff', '#ffc233'));
    const ww = Math.min(3.2, bw.x1 - bw.x0 - 0.4);
    const wallSign = new THREE.Mesh(new THREE.PlaneGeometry(ww, ww / 4), new THREE.MeshBasicNodeMaterial({ map: wallTex }));
    wallSign.position.set((bw.x0 + bw.x1) / 2, 1.95, bw.z1 + 0.005);
    this.group.add(wallSign);
    const wallLogo = new LogoSign(wallSign, ww, 0.96, { plate: 0xfff6dd, bezel: C.yellow, pad: 0.1, rim: 0.05, lift: 0.07 });
    this.signs = { canopy: canopyLogo, wall: wallLogo };
    const d = L.desk;
    // Counter at 0.98 m: the receptionist (head top ~1.5 m) stands behind it, seen from the chest up.
    inner.box(d.x0, 0, d.z0, d.x1, 0.92, d.z1, C.navy);
    inner.box(d.x0 - 0.06, 0.92, d.z0 - 0.06, d.x1 + 0.06, 0.98, d.z1 + 0.06, OFFICE.wood);
    inner.box(d.x0 + 0.02, 0.52, d.z1, d.x1 - 0.02, 0.6, d.z1 + 0.01, C.yellow, 'nz');
    inner.box(d.x0, 0.74, d.z0 - 0.35, d.x1, 0.78, d.z0, OFFICE.wood);
    const mx = L.receptionist.x + 0.55;
    inner.box(mx - 0.26, 0.98, d.z0 + 0.12, mx + 0.26, 1.3, d.z0 + 0.16, 0x1b1f2b);
    inner.quad(v(mx + 0.23, 1.01, d.z0 + 0.119), v(mx - 0.23, 1.01, d.z0 + 0.119), v(mx - 0.23, 1.27, d.z0 + 0.119), v(mx + 0.23, 1.27, d.z0 + 0.119), 0x9fd6ff, true);
    inner.geo(new THREE.SphereGeometry(0.06, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).translate(d.x1 - 0.35, 0.98, d.z1 - 0.15), C.yellow);

    // Bench by the glass (facing into the lobby), plants.
    const be = L.bench;
    for (let i = 0; i < 3; i++) inner.box(be.x0, 0.42, be.z0 + i * 0.18, be.x1, 0.46, be.z0 + i * 0.18 + 0.14, OFFICE.wood);
    for (const y of [0.62, 0.8]) inner.box(be.x0, y, be.z1 - 0.05, be.x1, y + 0.12, be.z1, OFFICE.wood);
    for (const x of [be.x0 + 0.12, be.x1 - 0.12]) for (const z of [be.z0 + 0.06, be.z1 - 0.06]) inner.box(x - 0.03, 0, z - 0.03, x + 0.03, 0.42, z + 0.03, C.navy);
    const pot = new THREE.CylinderGeometry(0.24, 0.19, 0.46, 12).translate(0, 0.23, 0);
    const leaves = new THREE.IcosahedronGeometry(0.42, 1).translate(0, 0.9, 0);
    const leaves2 = new THREE.IcosahedronGeometry(0.3, 1).translate(0.16, 1.28, 0.05);
    for (const p of L.plants) {
      const m = new THREE.Matrix4().makeTranslation(p.x, 0, p.z);
      inner.geo(pot, OFFICE.pot, m);
      inner.geo(leaves, OFFICE.plant, m);
      inner.geo(leaves2, 0x55b86b, m);
    }
    pot.dispose();
    leaves.dispose();
    leaves2.dispose();

    // A floor directory on the east wall, near the elevator.
    const dirTex = this.tex(directoryTexture(name, floors));
    const dh = Math.min(1.6, 0.5 + floors.length * 0.22);
    const dir = new THREE.Mesh(new THREE.PlaneGeometry(1.5, dh).rotateY(-Math.PI / 2), new THREE.MeshBasicNodeMaterial({ map: dirTex }));
    dir.position.set(W - 0.01, 1.55, D - 3.2);
    this.group.add(dir);

    // The elevator, as on every floor.
    const lift = elevatorMeshes(L.elevator, 'L', 'lobby · press E');
    this.textures.push(lift.texture);
    this.group.add(lift.group);

    this.slot.position.set(L.receptionist.x, 0, L.receptionist.z);
    this.slot.name = 'lobby.receptionist';
    this.group.add(this.slot);
    this.targets = [
      { boxes: [L.deskBox, { min: [L.receptionist.x - 0.35, 0, L.receptionist.z - 0.35], max: [L.receptionist.x + 0.35, 1.7, L.receptionist.z + 0.35] }], value: 'reception' },
      { boxes: [L.elevator], value: 'elevator' },
    ];
  }

  private tex(t: THREE.Texture): THREE.Texture {
    this.textures.push(t);
    return t;
  }

  /** M3d: the building's logo on the entrance sign and the reception wall; null brings the name back. */
  setLogo(entry: LogoEntry | null): void {
    this.signs.canopy.set(entry);
    this.signs.wall.set(entry);
  }

  /** Puts the receptionist (its feet at its origin, facing +z) behind the desk. */
  setReceptionist(o: THREE.Object3D | null): void {
    this.slot.clear();
    if (o) this.slot.add(o);
    else this.slot.add((this.placeholder ??= placeholderReceptionist()));
  }

  /** Front doors: slide open as you come near (from either side). */
  update(dt: number, walker: { x: number; y: number; z: number }): boolean {
    const L = this.plan.lobby;
    const cx = (L.front.x0 + L.front.x1) / 2;
    const near = walker.y < 1 && Math.abs(walker.x - cx) < 2.2 && Math.abs(walker.z - this.plan.depth) < 2.6;
    const want = near ? 1 : 0;
    if (want === this.open) return false;
    const k = 1 - Math.exp(-dt * 10);
    this.open = Math.abs(want - this.open) < 0.01 ? want : this.open + (want - this.open) * k;
    const leafW = (L.front.x1 - L.front.x0) / 2;
    for (const g of this.leaves) g.position.x = (g.userData.home as number) + (g.userData.dir as number) * this.open * (leafW - 0.05);
    return true;
  }

  get doorOpen(): number {
    return this.open;
  }

  /** What the view ray hits in the lobby (absolute coordinates), within reach. */
  pick(o: V3, dir: V3, reach: number): LobbyTarget | null {
    return pickNearest(o, dir, this.targets, reach, this.plan.lobby.walls)?.value ?? null;
  }

  /** M17: the glass front takes the sky's colour (the room behind it is lit by its own lights). */
  setDaylight(look: Look): void {
    this.glassMat.color.copy(look.glass);
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    for (const t of this.textures) t.dispose();
  }
}

function mergeAll(gs: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = mergeGeometriesSafe(gs);
  for (const g of gs) g.dispose();
  return out;
}

function mergeGeometriesSafe(gs: THREE.BufferGeometry[]): THREE.BufferGeometry {
  return mergeGeometries(gs) ?? new THREE.BufferGeometry();
}

/** A name board: big name, a line under it, a yellow rule. */
function nameTexture(name: string, sub: string, bg: string, fg: string, accent: string): THREE.CanvasTexture {
  return canvasTexture(1024, 256, (g) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, 1024, 256);
    g.fillStyle = accent;
    g.fillRect(0, 232, 1024, 24);
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `800 112px ${FONT}`;
    g.fillText(name, 512, 104, 960);
    g.globalAlpha = 0.8;
    g.font = `600 40px ${FONT}`;
    g.fillText(sub, 512, 192, 960);
  });
}

/** The floor directory: every floor top to bottom, then the lobby. */
function directoryTexture(name: string, floors: string[]): THREE.CanvasTexture {
  const rows = [...floors.map((s, i) => [String(i + 1), s] as const).reverse(), ['L', 'Lobby · reception'] as const];
  const h = Math.round(Math.min(1.6, 0.5 + floors.length * 0.22) * 340);
  return canvasTexture(512, h, (g) => {
    g.fillStyle = '#1c2540';
    g.fillRect(0, 0, 512, h);
    g.fillStyle = '#ffc233';
    g.font = `800 40px ${FONT}`;
    g.textBaseline = 'middle';
    g.fillText(name, 28, 48, 456);
    const step = Math.min(56, (h - 110) / rows.length);
    rows.forEach(([n, s], i) => {
      const y = 104 + i * step + step / 2;
      g.fillStyle = n === 'L' ? '#ffc233' : '#ffffff';
      g.font = `800 ${Math.round(step * 0.55)}px ${FONT}`;
      g.fillText(n, 28, y);
      g.font = `600 ${Math.round(step * 0.5)}px ${FONT}`;
      g.fillStyle = 'rgba(255,255,255,0.88)';
      g.fillText(s, 96, y, 390);
    });
  });
}

/** Until the real receptionist arrives: a simple stand-in with a headset. */
function placeholderReceptionist(): THREE.Object3D {
  const g = new THREE.Group();
  g.name = 'receptionist.placeholder';
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.45, 6, 12).translate(0, 0.62, 0), new THREE.MeshToonMaterial({ color: 0x27a3a3 }));
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 16, 12).translate(0, 1.27, 0), new THREE.MeshToonMaterial({ color: 0xffc98f }));
  const set = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.03, 6, 20, Math.PI).translate(0, 1.3, 0), new THREE.MeshToonMaterial({ color: 0x1c2540 }));
  g.add(body, head, set);
  return g;
}
