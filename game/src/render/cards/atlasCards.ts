import * as THREE from 'three/webgpu';
import { attribute, texture, uv, vec2 } from 'three/tsl';
import { CHIP_TEXT } from '../../world/derive';
import { STATUS_CSS } from '../palette';
import { CARD_RANGE, selectCards, type CardRange } from './select';
import { sameCard, type CardData, type Viewport } from './types';

const CELL_W = 512;
const CELL_H = 152;
const COLS = 4;
/** On-screen width of a card at scale 1 (CSS px). */
const CARD_CSS_W = 256;
export const FONT = '"Recursive Variable", system-ui, sans-serif';

/**
 * Draws one card into a 2D context at (x, y), cell-sized. Shared by the atlas
 * layer.
 */
export function drawCard(g: CanvasRenderingContext2D, x: number, y: number, c: CardData): void {
  g.clearRect(x, y, CELL_W, CELL_H);
  const red = c.display === 'needs_you';
  const asleep = c.display === 'asleep';
  const ink = red ? '#ffffff' : '#1c2540';
  const bg = red ? STATUS_CSS.needs_you : asleep ? '#e6e8f4' : '#ffffff';
  const bx = x + 6;
  const by = y + 6;
  const bw = CELL_W - 12;
  const bh = CELL_H - 34;
  g.save();
  g.beginPath();
  g.roundRect(bx, by, bw, bh, 24);
  g.moveTo(x + CELL_W / 2 - 16, by + bh - 1);
  g.lineTo(x + CELL_W / 2, y + CELL_H - 6);
  g.lineTo(x + CELL_W / 2 + 16, by + bh - 1);
  g.closePath();
  g.fillStyle = bg;
  g.fill();
  g.lineWidth = 4;
  g.strokeStyle = red ? '#9e1f19' : 'rgba(28,37,64,0.85)';
  g.stroke();
  // Status tape.
  g.font = `700 22px ${FONT}`;
  const chip = CHIP_TEXT[c.display];
  const tw = g.measureText(chip).width + 22;
  const tx = bx + bw - 18 - tw;
  g.translate(tx + tw / 2, by + 34);
  g.rotate(-0.03);
  g.fillStyle = red ? '#ffffff' : STATUS_CSS[c.display];
  g.fillRect(-tw / 2, -17, tw, 34);
  g.fillStyle = red ? STATUS_CSS.needs_you : '#ffffff';
  g.textBaseline = 'middle';
  g.textAlign = 'center';
  g.fillText(chip, 0, 1);
  g.setTransform(1, 0, 0, 1, 0, 0);
  // Name and task.
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.fillStyle = ink;
  g.font = `800 32px ${FONT}`;
  g.fillText(ellipsize(g, c.name, tx - bx - 36), bx + 24, by + 46);
  g.font = `500 25px ${FONT}`;
  g.globalAlpha = red ? 1 : 0.82;
  g.fillText(ellipsize(g, c.task, bw - 48), bx + 24, by + 92);
  g.restore();
}

function ellipsize(g: CanvasRenderingContext2D, s: string, w: number): string {
  if (g.measureText(s).width <= w) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (g.measureText(`${s.slice(0, mid)}…`).width <= w) lo = mid;
    else hi = mid - 1;
  }
  return `${s.slice(0, lo).trimEnd()}…`;
}

/**
 * Speech-bubble cards drawn into one canvas atlas (a cell per desk, redrawn only when that
 * worker's card changes) and rendered as a single instanced quad batch facing
 * the camera, always on top.
 */
export class AtlasCards {
  readonly object: THREE.InstancedMesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly tex: THREE.CanvasTexture;
  private readonly cell: THREE.InstancedBufferAttribute;
  private readonly alpha: THREE.InstancedBufferAttribute;
  private readonly cards = new Map<number, CardData>();
  private readonly drawn = new Map<number, CardData>();
  private readonly v = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly m = new THREE.Matrix4();
  private readonly s = new THREE.Vector3();
  private dirty = true;
  private showing: number[] = [];

  constructor(
    readonly slots: number,
    private readonly range: CardRange = CARD_RANGE,
    private readonly weight: (slot: number) => number = () => 1,
    private readonly occluded: (slot: number, dist: number) => boolean = () => false,
  ) {
    const rows = Math.max(1, Math.ceil(slots / COLS));
    this.canvas = document.createElement('canvas');
    this.canvas.width = CELL_W * COLS;
    this.canvas.height = CELL_H * rows;
    const g = this.canvas.getContext('2d');
    if (!g) throw new Error('2D canvas unavailable');
    this.g = g;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;

    const geo = new THREE.PlaneGeometry(1, CELL_H / CELL_W).translate(0, CELL_H / CELL_W / 2, 0);
    this.cell = new THREE.InstancedBufferAttribute(new Float32Array(range.cap * 4), 4);
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(range.cap), 1);
    this.cell.setUsage(THREE.DynamicDrawUsage);
    this.alpha.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aCell', this.cell);
    geo.setAttribute('aAlpha', this.alpha);
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false });
    const cell = attribute('aCell', 'vec4');
    const t = texture(this.tex, vec2(cell.x.add(uv().x.mul(cell.z)), cell.y.add(uv().y.mul(cell.w))));
    mat.colorNode = t.rgb;
    mat.opacityNode = t.a.mul(attribute('aAlpha', 'float'));
    this.object = new THREE.InstancedMesh(geo, mat, range.cap);
    this.object.name = 'cards.atlas';
    this.object.count = 0;
    this.object.frustumCulled = false;
    this.object.renderOrder = 10;
    this.object.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }

  setCard(slot: number, card: CardData | null): void {
    if (slot < 0 || slot >= this.slots) return;
    const prev = this.cards.get(slot) ?? null;
    if (sameCard(prev, card)) return;
    if (card) this.cards.set(slot, card);
    else this.cards.delete(slot);
    this.dirty = true;
  }

  setVisible(v: boolean): void {
    this.object.visible = v;
    this.dirty = true;
  }

  /** Desk slots currently showing a card. */
  shown(): number[] {
    return [...this.showing];
  }

  card(slot: number): CardData | null {
    return this.cards.get(slot) ?? null;
  }

  private cellXY(slot: number): [number, number] {
    return [(slot % COLS) * CELL_W, Math.floor(slot / COLS) * CELL_H];
  }

  update(camera: THREE.PerspectiveCamera, anchors: ReadonlyArray<THREE.Vector3 | null>, vp: Viewport, force: boolean): void {
    if (!this.object.visible || (!force && !this.dirty)) return;
    this.dirty = false;
    camera.getWorldDirection(this.fwd);
    const eff = anchors.map((a, i) => (a && this.cards.has(i) ? a : null));
    const chosen = selectCards(camera.position, this.fwd, eff, this.range, this.weight, this.occluded);
    let upload = false;
    for (const c of chosen) {
      const card = this.cards.get(c.index);
      if (card && !sameCard(this.drawn.get(c.index) ?? null, card)) {
        const [x, y] = this.cellXY(c.index);
        drawCard(this.g, x, y, card);
        this.drawn.set(c.index, card);
        upload = true;
      }
    }
    if (upload) this.tex.needsUpdate = true;
    // Far to near: one draw, blended in order.
    const order = [...chosen].reverse();
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    order.forEach((c, k) => {
      const a = anchors[c.index];
      if (!a) return;
      const scale = Math.max(0.62, Math.min(1, 4.2 / Math.max(0.1, c.dist)));
      // View depth, not distance: a camera-facing quad's screen size follows depth.
      const d = Math.max(0.1, this.v.copy(a).sub(camera.position).dot(this.fwd));
      // World width for a card CARD_CSS_W px wide on screen (at scale 1).
      const w = (CARD_CSS_W * scale * 2 * d * tanHalf) / Math.max(1, vp.height);
      this.m.compose(a, camera.quaternion, this.s.set(w, w, w));
      this.object.setMatrixAt(k, this.m);
      const [x, y] = this.cellXY(c.index);
      const H = this.canvas.height;
      this.cell.setXYZW(k, x / this.canvas.width, 1 - (y + CELL_H) / H, CELL_W / this.canvas.width, CELL_H / H);
      this.alpha.setX(k, c.alpha);
    });
    this.object.count = order.length;
    this.object.instanceMatrix.needsUpdate = true;
    this.cell.needsUpdate = true;
    this.alpha.needsUpdate = true;
    this.showing = chosen.map((c) => c.index);
  }

  dispose(): void {
    this.tex.dispose();
    this.object.geometry.dispose();
    (this.object.material as THREE.Material).dispose();
    this.object.dispose();
  }
}
