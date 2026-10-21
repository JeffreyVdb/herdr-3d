import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { StampTone } from '../world/crew';
import { TRAY_CAP, TRAY_FOLDER_SCALE, trayAt, trayFolderAt, type TrayPose } from '../world/delivery';
import { TRAY_BOX } from '../world/deskKit';
import { STAMP_3D } from './crewLook';
import { meshKit, reuse, type FloorPool, type PoolKit } from './floorPool';

/**
 * M6c: the orchestrator's in-tray: a small steel tray on the desk's front corner and the reports handed in lying
 * in it, one folder each, the verdict's stamp colour on the folder's front edge, at most `TRAY_CAP` of them. One
 * InstancedMesh per part (tray, folders, edges), an instance per desk (per folder), like the crew's props; the
 * parts nobody has are hidden, so a floor without a run draws nothing of it. Slot `i` is desk `i`'s.
 */

export const FOLDER = { w: 0.24 * TRAY_FOLDER_SCALE, h: 0.3 * TRAY_FOLDER_SCALE, t: 0.011 } as const;
export const MANILA = 0xf2c46b;
const MANILA_TAB = 0xe0ae4f;
/** A folder with no verdict (a coder's): a neutral edge. */
export const NO_VERDICT = 0xc9a45a;

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

function paint(g: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  const c = new THREE.Color(color);
  const n = geo.getAttribute('position').count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  geo.deleteAttribute('uv');
  return geo;
}

/** The tray (a steel pan, low walls, a lip at the front), origin at its base centre. */
export function trayGeometry(): THREE.BufferGeometry {
  const { w, d, h } = TRAY_BOX;
  const steel = 0x8d97a8;
  const wall = 0.008;
  const box = (bw: number, bh: number, bd: number, x: number, y: number, z: number, c: number) => paint(new THREE.BoxGeometry(bw, bh, bd).translate(x, y, z), c);
  return mergeGeometries([
    box(w, 0.006, d, 0, 0.003, 0, steel),
    box(wall, h, d, -w / 2 + wall / 2, h / 2, 0, steel),
    box(wall, h, d, w / 2 - wall / 2, h / 2, 0, steel),
    box(w, h, wall, 0, h / 2, -d / 2 + wall / 2, steel),
    box(w, h * 0.55, wall, 0, h * 0.275, d / 2 - wall / 2, 0x6f7a8e),
  ]) as THREE.BufferGeometry;
}

/** A folder lying flat: a manila sheet with its tab at the back. Origin at its middle, front edge at +z. */
export function folderGeometry(): THREE.BufferGeometry {
  const { w, h, t } = FOLDER;
  return mergeGeometries([
    paint(new THREE.BoxGeometry(w, t, h).translate(0, t / 2, 0), MANILA),
    paint(new THREE.BoxGeometry(w * 0.34, t, 0.03).translate(-w * 0.2, t / 2, -h / 2 - 0.015), MANILA_TAB),
  ]) as THREE.BufferGeometry;
}

/** The stamp's colour strip on the folder's front edge (tinted per instance). */
export function edgeGeometry(): THREE.BufferGeometry {
  const { w, h, t } = FOLDER;
  return new THREE.BoxGeometry(w * 0.98, t * 1.25, 0.034).translate(0, t / 2, h / 2 - 0.014);
}

/** A stamp tone's colour on a folder's edge. */
export const toneColor = (tone: StampTone | null): number => (tone ? STAMP_3D[tone] : NO_VERDICT);

/** #141: the trays' meshes, sized for `capacity` desks (see `FloorPool`). */
interface TrayKit extends PoolKit {
  trays: THREE.InstancedMesh;
  folders: THREE.InstancedMesh;
  edges: THREE.InstancedMesh;
}

function trayKit(capacity: number): TrayKit {
  const n = Math.max(1, capacity);
  const make = (geo: THREE.BufferGeometry, mat: THREE.Material, count: number) => {
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    return mesh;
  };
  const trays = make(trayGeometry(), new THREE.MeshToonMaterial({ color: 0xffffff, vertexColors: true }), n);
  const folders = make(folderGeometry(), new THREE.MeshToonMaterial({ color: 0xffffff, vertexColors: true }), n * TRAY_CAP);
  const edges = make(edgeGeometry(), new THREE.MeshToonMaterial({ color: 0xffffff }), n * TRAY_CAP);
  // The edges' verdict colours are there from the start (the shader is built with them).
  edges.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * TRAY_CAP * 3).fill(1), 3);
  return meshKit(n, [trays, folders, edges], { trays, folders, edges });
}

export class TrayView {
  readonly group = new THREE.Group();
  private readonly kit: TrayKit;
  private readonly pooled: boolean;
  private readonly trays: THREE.InstancedMesh;
  private readonly folders: THREE.InstancedMesh;
  private readonly edges: THREE.InstancedMesh;
  /** How many folders each tray holds (test hook). */
  private readonly held: number[];
  /** Which desks have a tray at all. */
  private readonly on: boolean[];
  private readonly color = new THREE.Color();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3(1, 1, 1);

  /** `pool`: the office's trays, their meshes kept from floor to floor (#141); none: their own. */
  constructor(
    readonly capacity: number,
    shadows: boolean,
    pool?: FloorPool,
  ) {
    const n = Math.max(1, capacity);
    this.held = Array.from({ length: n }, () => 0);
    this.on = Array.from({ length: n }, () => false);
    this.pooled = !!pool;
    this.kit = pool ? pool.take('trays', n, this, trayKit) : trayKit(n);
    this.kit.holder = this;
    const init = (name: string, mesh: THREE.InstancedMesh, count: number, shadow: boolean) => {
      reuse(mesh, count);
      mesh.name = `tray.${name}`;
      mesh.castShadow = shadows && shadow;
      mesh.visible = false;
      for (let i = 0; i < count; i++) mesh.setMatrixAt(i, ZERO);
      this.group.add(mesh);
      return mesh;
    };
    this.trays = init('body', this.kit.trays, n, true);
    this.folders = init('folders', this.kit.folders, n * TRAY_CAP, true);
    this.edges = init('edges', this.kit.edges, n * TRAY_CAP, false);
    for (let i = 0; i < n * TRAY_CAP; i++) this.edges.setColorAt(i, this.color.set(NO_VERDICT));
    this.group.name = 'trays';
  }

  /** Desk `i`'s tray with these folders (oldest first; null: no tray - a desk with no orchestrator at it). */
  set(i: number, pose: TrayPose | null, tones: ReadonlyArray<StampTone | null> = []): void {
    // #141: pooled trays of a floor you left write nothing.
    if (i < 0 || i >= this.capacity || this.kit.holder !== this) return;
    if (!pose) {
      this.trays.setMatrixAt(i, ZERO);
      for (let k = 0; k < TRAY_CAP; k++) {
        this.folders.setMatrixAt(i * TRAY_CAP + k, ZERO);
        this.edges.setMatrixAt(i * TRAY_CAP + k, ZERO);
      }
      this.held[i] = 0;
    } else {
      const c = trayAt(pose);
      this.q.setFromAxisAngle(this.v.set(0, 1, 0), pose.yaw);
      this.trays.setMatrixAt(i, this.m.compose(this.v.set(c.x, c.y, c.z), this.q, this.s));
      const shown = tones.slice(-TRAY_CAP);
      for (let k = 0; k < TRAY_CAP; k++) {
        const at = i * TRAY_CAP + k;
        if (k >= shown.length) {
          this.folders.setMatrixAt(at, ZERO);
          this.edges.setMatrixAt(at, ZERO);
          continue;
        }
        const f = trayFolderAt(pose, k);
        this.q.setFromAxisAngle(this.v.set(0, 1, 0), f.yaw);
        this.m.compose(this.v.set(f.x, f.y, f.z), this.q, this.s);
        this.folders.setMatrixAt(at, this.m);
        this.edges.setMatrixAt(at, this.m);
        this.edges.setColorAt(at, this.color.set(toneColor(shown[k] ?? null)));
      }
      this.held[i] = shown.length;
    }
    this.on[i] = !!pose;
    this.trays.visible = this.on.some(Boolean);
    this.folders.visible = this.edges.visible = this.held.some((n) => n > 0);
    for (const mesh of [this.trays, this.folders, this.edges]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  /** Test hook: folders in desk `i`'s tray, and the edge colours, oldest first. */
  info(i: number): { tray: boolean; folders: number; edges: number[] } {
    const edges: number[] = [];
    for (let k = 0; k < (this.held[i] ?? 0); k++) {
      this.edges.getColorAt(i * TRAY_CAP + k, this.color);
      edges.push(this.color.getHex());
    }
    return { tray: this.on[i] ?? false, folders: this.held[i] ?? 0, edges };
  }

  /** Pooled trays' meshes are the pool's: they stay. */
  dispose(): void {
    if (!this.pooled) this.kit.dispose();
  }
}
