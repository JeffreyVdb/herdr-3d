import * as THREE from 'three/webgpu';
import { attribute, texture, uv, vec2 } from 'three/tsl';
import type { BoardSize, Placement } from '../../world/boards';
import { canvasSize, drawBackdrop, type Backdrop } from './paint';
import { meshKit, reuse, type FloorPool, type PoolKit } from '../floorPool';

/**
 * M7: one wall board: a cork backdrop (one texture, redrawn when the data changes) and its notes, drawn as one
 * instanced quad batch over it. Every note's face is a cell of a single text atlas (`CanvasTexture`), redrawn only when
 * that note's face changes; the instance buffers are written only when notes appear, move, leave or animate. The
 * board's group has its origin at the board's bottom-left front corner and faces +z.
 */

export interface NoteEntry<F> {
  id: string;
  place: Placement;
  face: F;
}

export interface NoteBoardOptions<F> {
  size: BoardSize;
  cell: { w: number; h: number };
  cols: number;
  rows: number;
  draw(g: CanvasRenderingContext2D, x: number, y: number, face: F): void;
  same(a: F | undefined, b: F): boolean;
  /** Gets the backdrop texture to put on the board's front. */
  backdrop(tex: THREE.Texture): void;
  /** #141: the notes' batch and atlas from there, as `key` (one per board); none: its own. */
  pool?: { pool: FloorPool; key: string } | undefined;
}

/** #141: a board's notes batch (`capacity` notes) and their atlas (see `FloorPool`). */
interface NotesKit extends PoolKit {
  mesh: THREE.InstancedMesh;
  atlas: HTMLCanvasElement;
  atlasG: CanvasRenderingContext2D;
  atlasTex: THREE.CanvasTexture;
  cellAttr: THREE.InstancedBufferAttribute;
  alphaAttr: THREE.InstancedBufferAttribute;
}

function notesKit(capacity: number, cell: { w: number; h: number }, cols: number, rows: number): NotesKit {
  const atlas = document.createElement('canvas');
  atlas.width = cell.w * cols;
  atlas.height = cell.h * rows;
  const atlasG = atlas.getContext('2d');
  if (!atlasG) throw new Error('2D canvas unavailable');
  const atlasTex = new THREE.CanvasTexture(atlas);
  atlasTex.colorSpace = THREE.SRGBColorSpace;
  atlasTex.anisotropy = 4;
  const geo = new THREE.PlaneGeometry(1, 1);
  const cellAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  const alphaAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
  cellAttr.setUsage(THREE.DynamicDrawUsage);
  alphaAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aCell', cellAttr);
  geo.setAttribute('aAlpha', alphaAttr);
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  const c = attribute('aCell', 'vec4');
  const t = texture(atlasTex, vec2(c.x.add(uv().x.mul(c.z)), c.y.add(uv().y.mul(c.w))));
  mat.colorNode = t.rgb;
  mat.opacityNode = t.a.mul(attribute('aAlpha', 'float'));
  const mesh = new THREE.InstancedMesh(geo, mat, capacity);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  return meshKit(capacity, [mesh], { mesh, atlas, atlasG, atlasTex, cellAttr, alphaAttr }, () => atlasTex.dispose());
}

/** What an animating note is at a moment. */
interface Pose {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  scale: number;
  alpha: number;
}

interface Note<F> {
  id: string;
  cell: number;
  face: F;
  /** Where it settles. */
  to: Placement;
  from: Pose;
  now: Pose;
  t0: number;
  ms: number;
  leaving: boolean;
}

const ENTER_MS = 380;
const MOVE_MS = 460;
const LEAVE_MS = 300;
const ease = (k: number) => 1 - (1 - Math.min(1, Math.max(0, k))) ** 3;
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

const poseOf = (p: Placement): Pose => ({ x: p.x, y: p.y, w: p.w, h: p.h, rot: p.rot, scale: 1, alpha: 1 });

/** A note as the test hook sees it (`face`: what its cell shows). */
export interface NoteInfo {
  face: unknown;
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cell: number;
  alpha: number;
  leaving: boolean;
}

export class NoteBoard<F> {
  readonly group = new THREE.Group();
  readonly mesh: THREE.InstancedMesh;
  private readonly back: HTMLCanvasElement;
  private readonly backG: CanvasRenderingContext2D;
  private readonly backTex: THREE.CanvasTexture;
  private readonly atlas: HTMLCanvasElement;
  private readonly atlasG: CanvasRenderingContext2D;
  private readonly atlasTex: THREE.CanvasTexture;
  private readonly cellAttr: THREE.InstancedBufferAttribute;
  private readonly alphaAttr: THREE.InstancedBufferAttribute;
  private readonly kit: NotesKit;
  private readonly notes = new Map<string, Note<F>>();
  private readonly free: number[] = [];
  private readonly capacity: number;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly axis = new THREE.Vector3(0, 0, 1);
  private dirty = true;
  private animating = false;
  /** Instance draws so far (test hook: proves a quiet frame writes nothing). */
  writes = 0;

  constructor(private readonly o: NoteBoardOptions<F>) {
    this.capacity = o.cols * o.rows;
    for (let i = this.capacity - 1; i >= 0; i--) this.free.push(i);
    const bs = canvasSize(o.size);
    this.back = document.createElement('canvas');
    this.back.width = bs.w;
    this.back.height = bs.h;
    const g = this.back.getContext('2d');
    if (!g) throw new Error('2D canvas unavailable');
    this.backG = g;
    this.backTex = new THREE.CanvasTexture(this.back);
    this.backTex.colorSpace = THREE.SRGBColorSpace;
    this.backTex.anisotropy = 4;
    o.backdrop(this.backTex);

    const make = () => notesKit(this.capacity, o.cell, o.cols, o.rows);
    this.kit = o.pool ? o.pool.pool.take(o.pool.key, this.capacity, this, make) : make();
    this.kit.holder = this;
    ({ mesh: this.mesh, atlas: this.atlas, atlasG: this.atlasG, atlasTex: this.atlasTex, cellAttr: this.cellAttr, alphaAttr: this.alphaAttr } = this.kit);
    // A new floor's board starts with a blank atlas and no notes, as a new one does.
    this.atlasG.clearRect(0, 0, this.atlas.width, this.atlas.height);
    reuse(this.mesh, 0);
    this.mesh.name = 'board.notes';
    this.group.add(this.mesh);
  }

  /** Draws the cork (title, column heads, the reason there is nothing to show). */
  setBackdrop(b: Backdrop): void {
    drawBackdrop(this.backG, this.o.size, b);
    this.backTex.needsUpdate = true;
  }

  private cellRect(cell: number): [number, number] {
    return [(cell % this.o.cols) * this.o.cell.w, Math.floor(cell / this.o.cols) * this.o.cell.h];
  }

  private alloc(): number {
    const c = this.free.pop();
    if (c !== undefined) return c;
    // Every cell is in use (notes still leaving): take the leaving note's.
    for (const n of this.notes.values()) {
      if (n.leaving) {
        this.notes.delete(n.id);
        return n.cell;
      }
    }
    return -1;
  }

  /**
   * The notes as they are now, in draw order (later notes over earlier ones). New ones fade in, notes with a new place
   * slide there, ones no longer listed leave. `animate: false` places everything at once (the first fill).
   */
  setNotes(entries: readonly NoteEntry<F>[], now: number, animate = true): void {
    // #141: a pooled board of a floor you left draws nothing.
    if (this.kit.holder !== this) return;
    const seen = new Set<string>();
    let drawn = false;
    for (const e of entries.slice(0, this.capacity)) {
      seen.add(e.id);
      const cur = this.notes.get(e.id);
      if (cur && !cur.leaving) {
        if (!this.o.same(cur.face, e.face)) {
          const [x, y] = this.cellRect(cur.cell);
          this.o.draw(this.atlasG, x, y, e.face);
          cur.face = e.face;
          drawn = true;
        }
        const moved = cur.to.x !== e.place.x || cur.to.y !== e.place.y || cur.to.w !== e.place.w || cur.to.h !== e.place.h || cur.to.rot !== e.place.rot;
        if (moved) {
          cur.from = { ...cur.now };
          cur.to = e.place;
          cur.t0 = now;
          cur.ms = animate ? MOVE_MS : 0;
        }
        continue;
      }
      const cell = cur ? cur.cell : this.alloc();
      if (cell < 0) continue;
      const [x, y] = this.cellRect(cell);
      this.o.draw(this.atlasG, x, y, e.face);
      drawn = true;
      const target = poseOf(e.place);
      const from: Pose = animate ? { ...target, y: target.y + 0.12, scale: 0.35, alpha: 0 } : target;
      this.notes.set(e.id, { id: e.id, cell, face: e.face, to: e.place, from, now: { ...from }, t0: now, ms: animate ? ENTER_MS : 0, leaving: false });
    }
    for (const n of this.notes.values()) {
      if (seen.has(n.id) || n.leaving) continue;
      if (animate) {
        n.leaving = true;
        n.from = { ...n.now };
        n.t0 = now;
        n.ms = LEAVE_MS;
      } else {
        this.notes.delete(n.id);
        this.free.push(n.cell);
      }
    }
    // The map's order is the draw order: rebuild it from the entries (leaving notes first, beneath).
    const order = new Map<string, Note<F>>();
    for (const n of this.notes.values()) if (n.leaving) order.set(n.id, n);
    for (const e of entries) {
      const n = this.notes.get(e.id);
      if (n && !n.leaving) order.set(e.id, n);
    }
    this.notes.clear();
    for (const [k, v] of order) this.notes.set(k, v);
    if (drawn) this.atlasTex.needsUpdate = true;
    this.dirty = true;
  }

  /** Takes a note off the board at once (it is carried off or flies away); its pose, face and cell are returned. */
  take(id: string): { place: Placement; face: F } | null {
    const n = this.notes.get(id);
    if (!n || n.leaving) return null;
    const place = { ...n.to, x: n.now.x, y: n.now.y };
    const face = n.face;
    this.notes.delete(id);
    this.free.push(n.cell);
    this.dirty = true;
    return { place, face };
  }

  has(id: string): boolean {
    const n = this.notes.get(id);
    return !!n && !n.leaving;
  }

  /** Whether anything moves (the caller keeps the frame rate up while it does). */
  get busy(): boolean {
    return this.animating;
  }

  /** Steps the animations and writes the instance buffers when something changed. Returns whether it is still animating. */
  frame(now: number): boolean {
    let moving = false;
    for (const n of this.notes.values()) {
      const k = n.ms <= 0 ? 1 : (now - n.t0) / n.ms;
      if (k >= 1 && !n.leaving && n.now.x === n.to.x && n.now.y === n.to.y && n.now.scale === 1 && n.now.alpha === 1 && n.now.w === n.to.w) continue;
      moving = true;
      const e = ease(k);
      if (n.leaving) {
        n.now = { ...n.from, y: n.from.y - 0.1 * e, alpha: 1 - e, scale: lerp(1, 0.9, e) };
        continue;
      }
      const t = poseOf(n.to);
      n.now = {
        x: lerp(n.from.x, t.x, e),
        y: lerp(n.from.y, t.y, e),
        w: lerp(n.from.w, t.w, e),
        h: lerp(n.from.h, t.h, e),
        rot: lerp(n.from.rot, t.rot, e),
        scale: lerp(n.from.scale, 1, e),
        alpha: lerp(n.from.alpha, 1, e),
      };
      if (k >= 1) n.now = t;
    }
    for (const n of [...this.notes.values()]) {
      if (n.leaving && (now - n.t0 >= n.ms || n.ms <= 0)) {
        this.notes.delete(n.id);
        this.free.push(n.cell);
        this.dirty = true;
      }
    }
    this.animating = moving;
    if (!moving && !this.dirty) return false;
    this.dirty = false;
    this.write();
    return moving;
  }

  private write(): void {
    if (this.kit.holder !== this) return;
    let k = 0;
    const W = this.atlas.width;
    const H = this.atlas.height;
    for (const n of this.notes.values()) {
      const { x, y, w, h, rot, scale, alpha } = n.now;
      this.p.set(x, y, 0.006 + k * 0.0004);
      this.q.setFromAxisAngle(this.axis, rot);
      this.s.set(w * scale, h * scale, 1);
      this.m.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(k, this.m);
      const [cx, cy] = this.cellRect(n.cell);
      this.cellAttr.setXYZW(k, cx / W, 1 - (cy + this.o.cell.h) / H, this.o.cell.w / W, this.o.cell.h / H);
      this.alphaAttr.setX(k, alpha);
      k++;
    }
    this.mesh.count = k;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.cellAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
    this.writes++;
  }

  /** The notes on the board (test hook). */
  info(): NoteInfo[] {
    return [...this.notes.values()].map((n) => ({ face: n.face as unknown, id: n.id, x: n.now.x, y: n.now.y, w: n.now.w, h: n.now.h, cell: n.cell, alpha: n.now.alpha, leaving: n.leaving }));
  }

  dispose(): void {
    this.backTex.dispose();
    // A pooled batch and atlas are the pool's: they stay.
    if (!this.o.pool) this.kit.dispose();
    this.group.removeFromParent();
  }
}
