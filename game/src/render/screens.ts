import * as THREE from 'three/webgpu';
import { attribute, texture, uv, vec2 } from 'three/tsl';
import type { DeskSlot } from '../world/layout';
import { glassGeometry, screenGeometry } from './desks';
import { meshKit, reuse, type FloorPool, type PoolKit } from './floorPool';

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

const ownerKey = (o: ScreenOwner): string => `${o.id}@${o.pane}`;

/** #52: whose screen an image is: the worker, and the pane its frames came from. */
export interface ScreenOwner {
  id: string;
  pane: string;
}

/**
 * M5: laptop screens over the desks' flat glow (M6b: on the desk monitors). A live screen is one plane
 * with its own canvas texture (a handful: the nearest laptops and the one
 * you sit at); every frozen screen is a cell of one canvas atlas drawn as a
 * single instanced batch (like the cards), so a floor full of once-seen
 * laptops is one draw call. A laptop never seen live keeps its glow (the
 * desk's own screen colour). Asleep, all of it goes dark.
 */
/** #141: the frozen screens' batch (a cell of the atlas per desk, `capacity` desks) and its atlas (see `FloorPool`). */
interface FrozenKit extends PoolKit {
  mesh: THREE.InstancedMesh;
  cell: THREE.InstancedBufferAttribute;
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
}

function frozenKit(capacity: number): FrozenKit {
  const geo = screenGeometry(0.001);
  const canvas = document.createElement('canvas');
  canvas.width = CELL_W * COLS;
  canvas.height = CELL_H * Math.ceil(FROZEN_CELLS / COLS);
  const g = canvas.getContext('2d', { alpha: false });
  if (!g) throw new Error('2D canvas unavailable');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  const cell = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  geo.setAttribute('aCell', cell);
  const mat = new THREE.MeshBasicNodeMaterial();
  const c = attribute('aCell', 'vec4');
  mat.colorNode = texture(tex, vec2(c.x.add(uv().x.mul(c.z)), c.y.add(uv().y.mul(c.w)))).rgb;
  const mesh = new THREE.InstancedMesh(geo, mat, capacity);
  mesh.frustumCulled = false;
  return meshKit(capacity, [mesh], { mesh, cell, canvas, g, tex }, () => tex.dispose());
}

export class ScreenMeshes {
  readonly group = new THREE.Group();
  private readonly geo: THREE.BufferGeometry;
  /** The screen you sit at: the whole glass, the status bar under it. */
  private readonly fullGeo: THREE.BufferGeometry;
  /** Desks whose live screen covers the whole glass (the one you sit at). */
  private full: number | null = null;
  private readonly live = new Map<number, THREE.Mesh>();
  private readonly kit: FrozenKit;
  private readonly pooled: boolean;
  private readonly frozenMesh: THREE.InstancedMesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly tex: THREE.CanvasTexture;
  private readonly cell: THREE.InstancedBufferAttribute;
  /** Desk → atlas cell, least recently frozen first. */
  private readonly frozen = new Map<number, number>();
  /** #52: desk → whose screen its frozen image is. */
  private readonly owners = new Map<number, ScreenOwner>();
  /** #52: per atlas cell, whose image was last drawn into it (canvas), and whose the GPU has (the last upload's). */
  private readonly drawn: (string | null)[] = new Array<string | null>(FROZEN_CELLS).fill(null);
  private readonly uploaded: (string | null)[] = new Array<string | null>(FROZEN_CELLS).fill(null);
  /** #98: desks whose monitor shows the activity card (or an image): their screens are hidden, frozen copies kept. */
  private readonly covered = new Set<number>();
  private atlasDirty = false;
  private lastUpload = -Infinity;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly up = new THREE.Vector3(0, 1, 0);

  /** `pool`: the frozen screens' batch and atlas kept from floor to floor (#141); none: their own. */
  constructor(
    private readonly slots: readonly DeskSlot[],
    pool?: FloorPool,
  ) {
    this.group.name = 'screens';
    this.geo = screenGeometry(0.0015);
    this.fullGeo = glassGeometry(0.0015);
    const n = Math.max(1, slots.length);
    this.pooled = !!pool;
    this.kit = pool ? pool.take('screens.frozen', n, this, frozenKit) : frozenKit(n);
    this.kit.holder = this;
    ({ canvas: this.canvas, g: this.g, tex: this.tex, cell: this.cell, mesh: this.frozenMesh } = this.kit);
    // A new floor's atlas starts black, its cells unset, as a new one does.
    this.g.fillStyle = '#000';
    this.g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.cell.array.fill(0, 0, n * 4);
    this.cell.needsUpdate = true;
    reuse(this.frozenMesh, n);
    this.frozenMesh.name = 'screens.frozen';
    for (let i = 0; i < n; i++) this.frozenMesh.setMatrixAt(i, ZERO);
    this.group.add(this.frozenMesh);
  }

  /** #141: still the screens its batch draws (pooled screens of a floor you left write nothing). */
  private get drawing(): boolean {
    return this.kit.holder === this;
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

  /** Keeps `src` (a live screen's canvas, `owner`'s) as the desk's frozen screen. */
  freeze(desk: number, src: CanvasImageSource, owner: ScreenOwner): void {
    if (!this.slots[desk] || !this.drawing) return;
    let cell = this.frozen.get(desk);
    if (cell === undefined) {
      if (this.frozen.size >= FROZEN_CELLS) {
        // The one frozen longest ago goes back to its glow.
        const [oldDesk, oldCell] = this.frozen.entries().next().value as [number, number];
        this.frozen.delete(oldDesk);
        this.owners.delete(oldDesk);
        this.place(oldDesk);
        cell = oldCell;
      } else cell = this.freeCell();
    } else this.frozen.delete(desk);
    this.frozen.set(desk, cell);
    this.owners.set(desk, { ...owner });
    const x = (cell % COLS) * CELL_W;
    const y = Math.floor(cell / COLS) * CELL_H;
    this.g.drawImage(src, x, y, CELL_W, CELL_H);
    this.drawn[cell] = ownerKey(owner);
    const H = this.canvas.height;
    this.cell.setXYZW(desk, x / this.canvas.width, 1 - (y + CELL_H) / H, CELL_W / this.canvas.width, CELL_H / H);
    this.cell.needsUpdate = true;
    this.place(desk);
    this.atlasDirty = true;
  }

  /**
   * #52: whether a desk's frozen instance is on the glass: frozen, not covered, and its cell on the GPU holds its
   * owner's image. A reused cell keeps the previous owner's pixels until the (throttled) upload that carries the new
   * ones, so until then the desk shows its glow, never someone else's screen.
   */
  private shown(desk: number): boolean {
    const cell = this.frozen.get(desk);
    const owner = this.owners.get(desk);
    return cell !== undefined && !!owner && this.uploaded[cell] === ownerKey(owner);
  }

  /** Puts a desk's frozen instance where `shown` and `covered` say (its slot, or nowhere). */
  private place(desk: number): void {
    if (!this.drawing) return;
    this.frozenMesh.setMatrixAt(desk, this.shown(desk) && !this.covered.has(desk) ? this.slotMatrix(desk) : ZERO);
    this.frozenMesh.instanceMatrix.needsUpdate = true;
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
    if (this.frozen.has(desk)) this.place(desk);
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

  /** #52: whose screen the desk's frozen image is (null: not frozen). */
  frozenOwner(desk: number): ScreenOwner | null {
    return this.owners.get(desk) ?? null;
  }

  /**
   * #52: whose screen the desk's frozen image on the glass is: its owner once the GPU has that image (null: not frozen,
   * or its image not uploaded yet). Covered or asleep is not considered (test hook).
   */
  shownOwner(desk: number): ScreenOwner | null {
    return this.shown(desk) ? (this.owners.get(desk) ?? null) : null;
  }

  /** Test hook: the frozen atlas texture's version (it goes up with each upload). */
  atlasVersion(): number {
    return this.tex.version;
  }

  /** Test hook: the share (0–1) of a desk's frozen screen that is not black; null when it is not frozen. */
  frozenInk(desk: number): number | null {
    const cell = this.frozen.get(desk);
    if (cell === undefined) return null;
    const px = this.g.getImageData((cell % COLS) * CELL_W, Math.floor(cell / COLS) * CELL_H, CELL_W, CELL_H).data;
    let ink = 0;
    for (let i = 0; i < px.length; i += 4) if ((px[i] ?? 0) + (px[i + 1] ?? 0) + (px[i + 2] ?? 0) > 24) ink++;
    return ink / (px.length / 4);
  }

  /** Forgets a desk's frozen screen (its worker left; a new one there starts with a glow). */
  unfreeze(desk: number): void {
    this.owners.delete(desk);
    if (!this.frozen.delete(desk)) return;
    this.place(desk);
  }

  /**
   * Once per frame: uploads the atlas if a screen froze (throttled). #52: the frozen screens whose images this upload
   * carries go on the glass in the same frame (the texture and the instance matrices reach the GPU in the same render).
   */
  update(now: number): void {
    if (!this.atlasDirty || now - this.lastUpload < ATLAS_UPLOAD_MS || !this.drawing) return;
    this.atlasDirty = false;
    this.lastUpload = now;
    this.tex.needsUpdate = true;
    for (let i = 0; i < FROZEN_CELLS; i++) this.uploaded[i] = this.drawn[i] ?? null;
    for (const desk of this.frozen.keys()) this.place(desk);
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
    // A pooled batch and atlas are the pool's: they stay.
    if (!this.pooled) this.kit.dispose();
  }
}
