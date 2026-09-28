import * as THREE from 'three/webgpu';
import { attribute, texture, uv, vec2 } from 'three/tsl';
import type { Counts } from '../world/store';
import { FONT } from './cards/atlasCards';
import { STATUS_CSS } from './palette';

const CELL_W = 640;
const CELL_H = 112;
const COLS = 3;
/** World height of a badge at scale 1 (m); scaled up with distance, capped under a floor's height. */
export const BADGE_H = 0.42;

export interface BadgeData {
  session: string;
  asleep: boolean;
  counts: Counts;
  hover: boolean;
}

const same = (a: BadgeData | undefined, b: BadgeData) =>
  !!a &&
  a.session === b.session &&
  a.asleep === b.asleep &&
  a.hover === b.hover &&
  a.counts.working === b.counts.working &&
  a.counts.needsYou === b.counts.needsYou &&
  a.counts.idle === b.counts.idle &&
  a.counts.total === b.counts.total;

/** Draws a floor badge (name + working · needs you · idle, or "asleep · n") into a cell. */
function drawBadge(g: CanvasRenderingContext2D, x: number, y: number, b: BadgeData): void {
  g.clearRect(x, y, CELL_W, CELL_H);
  g.save();
  g.font = `800 42px ${FONT}`;
  const nameW = Math.min(g.measureText(b.session).width, 300);
  g.font = `700 38px ${FONT}`;
  const items: Array<[string, string]> = b.asleep
    ? [[STATUS_CSS.asleep, `asleep · ${b.counts.total}`]]
    : [
        [STATUS_CSS.working, String(b.counts.working)],
        [STATUS_CSS.needs_you, String(b.counts.needsYou)],
        [STATUS_CSS.idle, String(b.counts.idle)],
      ];
  const itemsW = items.reduce((w, [, t]) => w + 30 + g.measureText(t).width + 18, 0);
  const w = Math.min(CELL_W - 8, 28 + 22 + nameW + 22 + itemsW + 8);
  const top = y + 14;
  const h = CELL_H - 28;
  // Pointer at the left edge, pointing at the floor.
  g.beginPath();
  g.moveTo(x + 4, y + CELL_H / 2);
  g.lineTo(x + 26, top + 16);
  g.lineTo(x + 26, top + h - 16);
  g.closePath();
  g.roundRect(x + 22, top, w - 22, h, 20);
  g.fillStyle = b.asleep ? '#2c2f5c' : '#1c2540';
  g.fill();
  if (b.hover) {
    g.lineWidth = 6;
    g.strokeStyle = '#ffc233';
    g.beginPath();
    g.roundRect(x + 22, top, w - 22, h, 20);
    g.stroke();
  }
  let cx = x + 46;
  const mid = top + h / 2 + 2;
  g.textBaseline = 'middle';
  g.fillStyle = '#eef2fb';
  g.font = `800 42px ${FONT}`;
  g.fillText(b.session, cx, mid, 300);
  cx += nameW + 22;
  g.font = `700 38px ${FONT}`;
  for (const [color, text] of items) {
    g.fillStyle = color;
    g.beginPath();
    g.arc(cx + 10, mid - 1, 10, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = b.asleep ? '#b9c3dc' : '#eef2fb';
    g.fillText(text, cx + 28, mid);
    cx += 30 + g.measureText(text).width + 18;
  }
  g.restore();
}

/**
 * The per-floor count badges of the city: one canvas atlas (a cell per floor,
 * redrawn only when its counts or hover change) drawn as a single instanced
 * batch of camera-facing quads. Moving DOM elements over the canvas every
 * frame cost ~8 ms/frame on the Mac, so badges live in the scene; the DOM
 * keeps a static, screen-reader-friendly floor list instead.
 */
export class BadgeLayer {
  readonly object: THREE.InstancedMesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly tex: THREE.CanvasTexture;
  private readonly cell: THREE.InstancedBufferAttribute;
  private readonly drawn: BadgeData[] = [];
  private readonly anchors: THREE.Vector3[] = [];
  private readonly sizes: number[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly s = new THREE.Vector3();
  private readonly v = new THREE.Vector3();
  private upload = false;

  constructor(readonly capacity: number, private readonly maxH: number) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = CELL_W * COLS;
    this.canvas.height = CELL_H * Math.max(1, Math.ceil(capacity / COLS));
    const g = this.canvas.getContext('2d');
    if (!g) throw new Error('2D canvas unavailable');
    this.g = g;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    const aspect = CELL_W / CELL_H;
    // Pivot at the pointer tip (left, middle).
    const geo = new THREE.PlaneGeometry(aspect, 1).translate(aspect / 2, 0, 0);
    this.cell = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, capacity) * 4), 4);
    geo.setAttribute('aCell', this.cell);
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false });
    const c = attribute('aCell', 'vec4');
    const t = texture(this.tex, vec2(c.x.add(uv().x.mul(c.z)), c.y.add(uv().y.mul(c.w))));
    mat.colorNode = t.rgb;
    mat.opacityNode = t.a;
    this.object = new THREE.InstancedMesh(geo, mat, Math.max(1, capacity));
    this.object.name = 'city.badges';
    this.object.count = 0;
    this.object.frustumCulled = false;
    this.object.renderOrder = 10;
  }

  private cellXY(i: number): [number, number] {
    return [(i % COLS) * CELL_W, Math.floor(i / COLS) * CELL_H];
  }

  set(i: number, anchor: THREE.Vector3, b: BadgeData): void {
    if (i >= this.capacity) return;
    this.anchors[i] = anchor;
    if (!same(this.drawn[i], b)) {
      const [x, y] = this.cellXY(i);
      drawBadge(this.g, x, y, b);
      this.drawn[i] = { ...b, counts: { ...b.counts } };
      this.upload = true;
      const W = this.canvas.width;
      const H = this.canvas.height;
      this.cell.setXYZW(i, x / W, 1 - (y + CELL_H) / H, CELL_W / W, CELL_H / H);
      this.cell.needsUpdate = true;
    }
    this.object.count = Math.max(this.object.count, i + 1);
  }

  /** Faces the camera; grows with distance so the overview stays readable, never taller than `maxH`. */
  update(camera: THREE.PerspectiveCamera): void {
    if (this.upload) {
      this.tex.needsUpdate = true;
      this.upload = false;
    }
    camera.getWorldDirection(this.v);
    const fwd = this.v.clone();
    for (let i = 0; i < this.object.count; i++) {
      const a = this.anchors[i];
      if (!a) continue;
      const depth = Math.max(0.1, this.v.copy(a).sub(camera.position).dot(fwd));
      const h = Math.min(this.maxH, BADGE_H * Math.max(1, depth / 14));
      this.sizes[i] = h;
      this.m.compose(a, camera.quaternion, this.s.set(h, h, h));
      this.object.setMatrixAt(i, this.m);
    }
    this.object.instanceMatrix.needsUpdate = true;
  }

  /** Index of the badge under a screen point (CSS px), topmost first. */
  hit(camera: THREE.PerspectiveCamera, px: number, py: number, vp: { width: number; height: number }): number | null {
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const toPx = (p: THREE.Vector3) => {
      const q = p.clone().project(camera);
      return { x: ((q.x + 1) / 2) * vp.width, y: ((1 - q.y) / 2) * vp.height, z: q.z };
    };
    for (let i = this.object.count - 1; i >= 0; i--) {
      const a = this.anchors[i];
      const h = this.sizes[i];
      const d = this.drawn[i];
      if (!a || !h || !d) continue;
      // The drawn part of the cell: roughly the left 80 %.
      const w = h * (CELL_W / CELL_H) * 0.8;
      const p0 = toPx(a.clone().addScaledVector(up, h * 0.38));
      const p1 = toPx(a.clone().addScaledVector(right, w).addScaledVector(up, -h * 0.38));
      if (p0.z > 1 || p1.z > 1) continue;
      if (px >= Math.min(p0.x, p1.x) && px <= Math.max(p0.x, p1.x) && py >= Math.min(p0.y, p1.y) && py <= Math.max(p0.y, p1.y)) return i;
    }
    return null;
  }

  /** Screen centre of badge `i` (CSS px), for tests. */
  center(camera: THREE.PerspectiveCamera, i: number, vp: { width: number; height: number }): { x: number; y: number } | null {
    const a = this.anchors[i];
    const h = this.sizes[i];
    if (!a || !h) return null;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const q = a.clone().addScaledVector(right, h * (CELL_W / CELL_H) * 0.3).project(camera);
    return { x: ((q.x + 1) / 2) * vp.width, y: ((1 - q.y) / 2) * vp.height };
  }

  dispose(): void {
    this.tex.dispose();
    this.object.geometry.dispose();
    (this.object.material as THREE.Material).dispose();
    this.object.dispose();
  }
}
