import * as THREE from 'three/webgpu';
import { attribute, texture, uv, vec2 } from 'three/tsl';
import type { DeskSlot } from '../world/layout';
import { glassGeometry, screenGeometry } from './desks';

/**
 * A frozen screen's cell in the atlas (the monitor's terminal area, M6b: its
 * glance view's 5 lines stay legible at this size), and how many the atlas
 * keeps (least recently frozen go first): 2048 × 428, about 1.15× the M5
 * laptops' atlas.
 */
const CELL_W = 256;
const CELL_H = 107;
const COLS = 8;
export const FROZEN_CELLS = 32;
/** Uploads of the frozen atlas, at most this often (a freeze is rare; walking past a row can freeze a few at once). */
const ATLAS_UPLOAD_MS = 400;

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * M5: laptop screens over the desks' flat glow (M6b: on the desk monitors). A live screen is one plane
 * with its own canvas texture (a handful: the nearest laptops and the one
 * you sit at); every frozen screen is a cell of one canvas atlas drawn as a
 * single instanced batch (like the cards), so a floor full of once-seen
 * laptops is one draw call. A laptop never seen live keeps its glow (the
 * desk's own screen colour). Asleep, all of it goes dark.
 */
export class ScreenMeshes {
  readonly group = new THREE.Group();
  private readonly geo: THREE.BufferGeometry;
  /** The screen you sit at: the whole glass, the status bar under it. */
  private readonly fullGeo: THREE.BufferGeometry;
  /** Desks whose live screen covers the whole glass (the one you sit at). */
  private full: number | null = null;
  private readonly frozenGeo: THREE.BufferGeometry;
  private readonly live = new Map<number, THREE.Mesh>();
  private readonly frozenMesh: THREE.InstancedMesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly tex: THREE.CanvasTexture;
  private readonly cell: THREE.InstancedBufferAttribute;
  /** Desk → atlas cell, least recently frozen first. */
  private readonly frozen = new Map<number, number>();
  /** #98: desks whose monitor shows the activity card (or an image): their screens are hidden, frozen copies kept. */
  private readonly covered = new Set<number>();
  private atlasDirty = false;
  private lastUpload = -Infinity;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(private readonly slots: readonly DeskSlot[]) {
    this.group.name = 'screens';
    this.geo = screenGeometry(0.0015);
    this.fullGeo = glassGeometry(0.0015);
    this.frozenGeo = screenGeometry(0.001);
    this.canvas = document.createElement('canvas');
    this.canvas.width = CELL_W * COLS;
    this.canvas.height = CELL_H * Math.ceil(FROZEN_CELLS / COLS);
    const g = this.canvas.getContext('2d', { alpha: false });
    if (!g) throw new Error('2D canvas unavailable');
    this.g = g;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.generateMipmaps = false;
    this.tex.minFilter = THREE.LinearFilter;
    const n = Math.max(1, slots.length);
    this.cell = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.frozenGeo.setAttribute('aCell', this.cell);
    const mat = new THREE.MeshBasicNodeMaterial();
    const c = attribute('aCell', 'vec4');
    mat.colorNode = texture(this.tex, vec2(c.x.add(uv().x.mul(c.z)), c.y.add(uv().y.mul(c.w)))).rgb;
    this.frozenMesh = new THREE.InstancedMesh(this.frozenGeo, mat, n);
    this.frozenMesh.name = 'screens.frozen';
    this.frozenMesh.frustumCulled = false;
    for (let i = 0; i < n; i++) this.frozenMesh.setMatrixAt(i, ZERO);
    this.group.add(this.frozenMesh);
  }

  /** Whether the desk has a slot (a floor that shrank has fewer). */
  has(desk: number): boolean {
    return !!this.slots[desk];
  }

  /** A desk's slot transform (the same as its desk art). */
  slotMatrix(desk: number, out = this.m): THREE.Matrix4 {
    const s = this.slots[desk];
    if (!s) return out.copy(ZERO);
    this.q.setFromAxisAngle(this.up, s.yaw);
    return out.compose(this.v.set(s.seat.x, 0, s.seat.z), this.q, this.one);
  }

  /** Shows `tex` on a desk's laptop (null: back to its frozen copy or glow). */
  setLive(desk: number, tex: THREE.Texture | null): void {
    const cur = this.live.get(desk);
    if (!tex) {
      if (cur) {
        cur.removeFromParent();
        (cur.material as THREE.Material).dispose();
        this.live.delete(desk);
      }
      return;
    }
    if (cur) {
      const mat = cur.material as THREE.MeshBasicMaterial;
      if (mat.map !== tex) {
        mat.map = tex;
        mat.needsUpdate = true;
      }
      return;
    }
    const mesh = new THREE.Mesh(this.full === desk ? this.fullGeo : this.geo, new THREE.MeshBasicMaterial({ map: tex }));
    mesh.name = `screens.live.${desk}`;
    mesh.visible = !this.covered.has(desk);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(this.slotMatrix(desk, new THREE.Matrix4()));
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.live.set(desk, mesh);
  }

  /** The desk whose live screen covers the whole glass, status bar included (sitting at it); null: none. */
  setFull(desk: number | null): void {
    if (desk === this.full) return;
    const was = this.full === null ? undefined : this.live.get(this.full);
    if (was) was.geometry = this.geo;
    this.full = desk;
    const now = desk === null ? undefined : this.live.get(desk);
    if (now) now.geometry = this.fullGeo;
  }

  /** The live plane of a desk (test hook). */
  liveMesh(desk: number): THREE.Mesh | null {
    return this.live.get(desk) ?? null;
  }

  isLive(desk: number): boolean {
    return this.live.has(desk);
  }

  /** Keeps `src` (a live screen's canvas) as the desk's frozen screen. */
  freeze(desk: number, src: CanvasImageSource): void {
    if (!this.slots[desk]) return;
    let cell = this.frozen.get(desk);
    if (cell === undefined) {
      if (this.frozen.size >= FROZEN_CELLS) {
        // The one frozen longest ago goes back to its glow.
        const [oldDesk, oldCell] = this.frozen.entries().next().value as [number, number];
        this.frozen.delete(oldDesk);
        this.frozenMesh.setMatrixAt(oldDesk, ZERO);
        cell = oldCell;
      } else cell = this.freeCell();
    } else this.frozen.delete(desk);
    this.frozen.set(desk, cell);
    const x = (cell % COLS) * CELL_W;
    const y = Math.floor(cell / COLS) * CELL_H;
    this.g.drawImage(src, x, y, CELL_W, CELL_H);
    const H = this.canvas.height;
    this.cell.setXYZW(desk, x / this.canvas.width, 1 - (y + CELL_H) / H, CELL_W / this.canvas.width, CELL_H / H);
    this.cell.needsUpdate = true;
    this.frozenMesh.setMatrixAt(desk, this.covered.has(desk) ? ZERO : this.slotMatrix(desk));
    this.frozenMesh.instanceMatrix.needsUpdate = true;
    this.atlasDirty = true;
  }

  /**
   * #98: a desk's monitor shows its activity card (true) or its screen (false): covered, its live and frozen screens are
   * hidden (not dropped), so the card is the only thing on the glass and the screen comes back as it was.
   */
  setCovered(desk: number, on: boolean): void {
    if (on === this.covered.has(desk)) return;
    if (on) this.covered.add(desk);
    else this.covered.delete(desk);
    const live = this.live.get(desk);
    if (live) live.visible = !on;
    if (this.frozen.has(desk)) {
      this.frozenMesh.setMatrixAt(desk, on ? ZERO : this.slotMatrix(desk));
      this.frozenMesh.instanceMatrix.needsUpdate = true;
    }
  }

  isCovered(desk: number): boolean {
    return this.covered.has(desk);
  }

  private freeCell(): number {
    const used = new Set(this.frozen.values());
    for (let i = 0; i < FROZEN_CELLS; i++) if (!used.has(i)) return i;
    return 0;
  }

  isFrozen(desk: number): boolean {
    return this.frozen.has(desk);
  }

  /** Forgets a desk's frozen screen (its worker left; a new one there starts with a glow). */
  /** Test hook: the share (0–1) of a desk's frozen screen that is not black; null when it is not frozen. */
  frozenInk(desk: number): number | null {
    const cell = this.frozen.get(desk);
    if (cell === undefined) return null;
    const px = this.g.getImageData((cell % COLS) * CELL_W, Math.floor(cell / COLS) * CELL_H, CELL_W, CELL_H).data;
    let ink = 0;
    for (let i = 0; i < px.length; i += 4) if ((px[i] ?? 0) + (px[i + 1] ?? 0) + (px[i + 2] ?? 0) > 24) ink++;
    return ink / (px.length / 4);
  }

  unfreeze(desk: number): void {
    if (!this.frozen.delete(desk)) return;
    this.frozenMesh.setMatrixAt(desk, ZERO);
    this.frozenMesh.instanceMatrix.needsUpdate = true;
  }

  /** Once per frame: uploads the atlas if a screen froze (throttled). */
  update(now: number): void {
    if (!this.atlasDirty || now - this.lastUpload < ATLAS_UPLOAD_MS) return;
    this.atlasDirty = false;
    this.lastUpload = now;
    this.tex.needsUpdate = true;
  }

  /** Asleep: every screen dark (the desks show their asleep colour). */
  setVisible(on: boolean): void {
    this.group.visible = on;
  }

  get liveCount(): number {
    return this.live.size;
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const d of [...this.live.keys()]) this.setLive(d, null);
    this.geo.dispose();
    this.fullGeo.dispose();
    this.frozenGeo.dispose();
    (this.frozenMesh.material as THREE.Material).dispose();
    this.frozenMesh.dispose();
    this.tex.dispose();
  }
}
