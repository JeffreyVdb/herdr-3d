import * as THREE from 'three/webgpu';
import { attribute, texture, uv, vec2 } from 'three/tsl';
import { CHIP_TEXT } from '../../world/derive';
import { STATUS_CHIP_CSS } from '../palette';
import { ABOUT_FONT, CELL_H, CELL_W, CHOICE_FONT, cardLayout, compactOf, FONT, isTall, KEY_FONT, KEY_W, NAME_FONT, QUESTION_FONT, TALL_H, TASK_FONT, USAGE_FONT, type CardLayout } from './layout';
import { CARD_RANGE, selectCards, type CardRange } from './select';
// M6: crew tags and verdict stamps.
import { drawStamp, drawTag, stampWidth } from './crewCard';
import { CREW_FONT } from './layout';
import { sameCard, type CardData, type Viewport } from './types';

const COLS = 4;
/** On-screen width of a card at scale 1 (CSS px). */
const CARD_CSS_W = 256;
export { FONT };
/** M5: tall cells (a question with its choices, the looked-at worker's usage) for the nearest cards that need one. */
export const TALL_CELLS = 8;
const TALL_COLS = 4;

/** The bubble, its tail and the status tape; returns the tape's left edge (the name stops there). */
function drawBubble(g: CanvasRenderingContext2D, x: number, y: number, c: CardData, height: number): number {
  const red = c.display === 'needs_you';
  const asleep = c.display === 'asleep';
  const bg = red ? STATUS_CHIP_CSS.needs_you : asleep ? '#e6e8f4' : '#ffffff';
  const bx = x + 6;
  const by = y + 6;
  const bw = CELL_W - 12;
  const bh = height - 34;
  g.beginPath();
  g.roundRect(bx, by, bw, bh, 24);
  g.moveTo(x + CELL_W / 2 - 16, by + bh - 1);
  g.lineTo(x + CELL_W / 2, y + height - 6);
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
  g.fillStyle = red ? '#ffffff' : STATUS_CHIP_CSS[c.display];
  g.fillRect(-tw / 2, -17, tw, 34);
  g.fillStyle = red ? STATUS_CHIP_CSS.needs_you : '#ffffff';
  g.textBaseline = 'middle';
  g.textAlign = 'center';
  g.fillText(chip, 0, 1);
  g.setTransform(1, 0, 0, 1, 0, 0);
  return tx;
}

/**
 * Draws one card into a 2D context at (x, y), cell-sized. Shared by the atlas
 * layer.
 */
export function drawCard(g: CanvasRenderingContext2D, x: number, y: number, c: CardData): void {
  g.clearRect(x, y, CELL_W, CELL_H);
  const red = c.display === 'needs_you';
  const ink = red ? '#ffffff' : '#1c2540';
  const bx = x + 6;
  const by = y + 6;
  const bw = CELL_W - 12;
  g.save();
  const tx = drawBubble(g, x, y, c, CELL_H);
  // Name and task.
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.fillStyle = ink;
  g.font = NAME_FONT;
  g.fillText(ellipsize(g, c.name, tx - bx - 36), bx + 24, by + 46);
  // M6: a crew member's role tag leads the task line, a reviewer's stamp ends it.
  let taskX = bx + 24;
  let taskW = bw - 48;
  if (c.stamp) taskW -= stampWidth(g, c.stamp) + 10;
  if (c.tag) {
    const w = drawTag(g, taskX, by + 92, c.tag, Math.min(250, taskW * 0.6));
    taskX += w + 10;
    taskW -= w + 10;
  }
  g.font = TASK_FONT;
  g.globalAlpha = red ? 1 : 0.82;
  g.fillText(ellipsize(g, c.task, taskW), taskX, by + 92);
  g.globalAlpha = 1;
  if (c.stamp) drawStamp(g, bx + bw - 16, by + 84, c.stamp);
  g.restore();
}

/** M5: a tall card as `cardLayout` lays it out: the question and its numbered key caps, or the task, and the usage line. */
export function drawTallCard(g: CanvasRenderingContext2D, x: number, y: number, c: CardData, L: CardLayout): void {
  g.clearRect(x, y, CELL_W, TALL_H);
  const red = c.display === 'needs_you';
  const ink = red ? '#ffffff' : '#1c2540';
  const bx = x + 6;
  const by = y + 6;
  g.save();
  const tx = drawBubble(g, x, y, c, L.height);
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.fillStyle = ink;
  g.font = NAME_FONT;
  g.fillText(ellipsize(g, c.name, tx - bx - 36), bx + 24, by + 46);
  // What the question is about, as terminal text on a dark plate: the operation you approve.
  const about = L.rows.filter((r) => r.kind === 'about');
  if (about.length) {
    const top = y + (about[0] as (typeof about)[number]).y - 25;
    const bottom = y + (about.at(-1) as (typeof about)[number]).y + 10;
    g.beginPath();
    g.roundRect(bx + 24, top, CELL_W - 12 - 48, bottom - top, 8);
    g.fillStyle = red ? 'rgba(40,4,4,0.34)' : 'rgba(28,37,64,0.09)';
    g.fill();
  }
  for (const r of L.rows) {
    const rx = x + r.x;
    const ry = y + r.y;
    g.globalAlpha = 1;
    g.fillStyle = ink;
    if (r.kind === 'question') {
      g.font = QUESTION_FONT;
      g.fillText(r.text, rx, ry);
    } else if (r.kind === 'about') {
      g.font = ABOUT_FONT;
      g.globalAlpha = red ? 0.96 : 0.86;
      g.fillText(r.text, rx, ry);
    } else if (r.kind === 'task') {
      g.font = TASK_FONT;
      g.globalAlpha = red ? 1 : 0.82;
      g.fillText(r.text, rx, ry);
    } else if (r.kind === 'choice') {
      // A key cap with the digit that answers it; the menu's cursor sits on the selected one.
      const kx = x + 30;
      const ky = ry - 23;
      g.beginPath();
      g.roundRect(kx, ky, KEY_W, KEY_W, 7);
      g.fillStyle = red ? '#ffffff' : '#1c2540';
      g.fill();
      g.fillStyle = red ? 'rgba(80,10,8,0.35)' : 'rgba(0,0,0,0.3)';
      g.fillRect(kx + 3, ky + KEY_W - 3, KEY_W - 6, 3);
      g.font = KEY_FONT;
      g.textAlign = 'center';
      g.fillStyle = red ? STATUS_CHIP_CSS.needs_you : '#ffffff';
      g.fillText(String(r.n ?? ''), kx + KEY_W / 2, ky + 22);
      g.textAlign = 'left';
      if (r.selected) {
        g.beginPath();
        g.moveTo(kx - 16, ky + 7);
        g.lineTo(kx - 6, ky + KEY_W / 2);
        g.lineTo(kx - 16, ky + KEY_W - 7);
        g.closePath();
        g.fillStyle = red ? '#ffe08a' : '#2f6bf0';
        g.fill();
      }
      g.font = CHOICE_FONT;
      g.fillStyle = ink;
      g.fillText(r.text, rx, ry);
    } else if (r.kind === 'more') {
      g.font = CHOICE_FONT;
      g.globalAlpha = 0.78;
      g.fillText(r.text, rx, ry);
    } else if (r.kind === 'tag') {
      // M6: the role tag, and a reviewer's verdict stamp at the right.
      if (c.tag) drawTag(g, rx, ry, c.tag, CELL_W - 12 - 48 - (c.stamp ? 200 : 0));
      if (c.stamp) drawStamp(g, x + CELL_W - 26, ry - 8, c.stamp);
    } else if (r.kind === 'crew') {
      g.font = CREW_FONT;
      g.globalAlpha = red ? 0.96 : 0.8;
      g.fillText(r.text, rx, ry);
    } else if (r.kind === 'usage') {
      // A hairline above: the usage is about the worker, not its question.
      g.globalAlpha = red ? 0.4 : 0.18;
      g.fillRect(rx, ry - 30, CELL_W - 12 - 48, 2);
      g.globalAlpha = red ? 0.92 : 0.72;
      g.font = USAGE_FONT;
      g.fillText(r.text, rx, ry);
    }
  }
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

/** One instanced quad batch sampling cells of an atlas texture: `aCell` is the cell's UV rect, `aAlpha` its fade. */
interface Batch {
  mesh: THREE.InstancedMesh;
  cell: THREE.InstancedBufferAttribute;
  alpha: THREE.InstancedBufferAttribute;
}

function batch(tex: THREE.Texture, geo: THREE.BufferGeometry, instances: number, name: string, order: number): Batch {
  const cell = new THREE.InstancedBufferAttribute(new Float32Array(instances * 4), 4);
  const alpha = new THREE.InstancedBufferAttribute(new Float32Array(instances), 1);
  cell.setUsage(THREE.DynamicDrawUsage);
  alpha.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aCell', cell);
  geo.setAttribute('aAlpha', alpha);
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false });
  const c = attribute('aCell', 'vec4');
  const t = texture(tex, vec2(c.x.add(uv().x.mul(c.z)), c.y.add(uv().y.mul(c.w))));
  mat.colorNode = t.rgb;
  mat.opacityNode = t.a.mul(attribute('aAlpha', 'float'));
  const mesh = new THREE.InstancedMesh(geo, mat, instances);
  mesh.name = name;
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.renderOrder = order;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  return { mesh, cell, alpha };
}

function atlasCanvas(w: number, h: number): { canvas: HTMLCanvasElement; g: CanvasRenderingContext2D; tex: THREE.CanvasTexture } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('2D canvas unavailable');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { canvas, g, tex };
}

/**
 * Speech-bubble cards drawn into one canvas atlas (a cell per desk, redrawn only when that
 * worker's card changes) and rendered as a single instanced quad batch facing
 * the camera, always on top. M5: the nearest cards that need more room (a
 * blocked worker's question and choices, the looked-at worker's usage) get
 * one of `TALL_CELLS` tall cells of a second, small atlas instead, drawn as a
 * second batch over the first (a child of `object`); a tall card with no
 * free tall cell shows compact, its question as the task line.
 */
export class AtlasCards {
  readonly object: THREE.InstancedMesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly tex: THREE.CanvasTexture;
  private readonly cell: THREE.InstancedBufferAttribute;
  private readonly alpha: THREE.InstancedBufferAttribute;
  private readonly cards = new Map<number, CardData>();
  /** What each compact cell shows now. */
  private readonly drawn = new Map<number, CardData>();
  private readonly tall: Batch;
  private readonly tallCanvas: HTMLCanvasElement;
  private readonly tallG: CanvasRenderingContext2D;
  private readonly tallTex: THREE.CanvasTexture;
  /** Desk slot → tall cell, while its card is tall and shown. */
  private readonly tallCell = new Map<number, number>();
  /** Tall cell → what it shows now (slot, card, layout). */
  private readonly tallDrawn = new Map<number, { slot: number; card: CardData; layout: CardLayout }>();
  private readonly v = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly m = new THREE.Matrix4();
  private readonly s = new THREE.Vector3();
  private dirty = true;
  private showing: number[] = [];

  constructor(
    readonly slots: number,
    private range: CardRange = CARD_RANGE,
    private readonly weight: (slot: number) => number = () => 1,
    private readonly occluded: (slot: number, dist: number) => boolean = () => false,
  ) {
    const rows = Math.max(1, Math.ceil(slots / COLS));
    ({ canvas: this.canvas, g: this.g, tex: this.tex } = atlasCanvas(CELL_W * COLS, CELL_H * rows));
    // An instance per desk: whatever the range's cap, every card of the floor can show at once.
    const instances = Math.max(1, slots);
    const compact = batch(this.tex, new THREE.PlaneGeometry(1, CELL_H / CELL_W).translate(0, CELL_H / CELL_W / 2, 0), instances, 'cards.atlas', 10);
    this.object = compact.mesh;
    this.cell = compact.cell;
    this.alpha = compact.alpha;
    ({ canvas: this.tallCanvas, g: this.tallG, tex: this.tallTex } = atlasCanvas(CELL_W * TALL_COLS, TALL_H * Math.ceil(TALL_CELLS / TALL_COLS)));
    // A unit quad standing on its bottom edge: each instance is scaled to its card's height.
    this.tall = batch(this.tallTex, new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0), TALL_CELLS, 'cards.tall', 11);
    this.object.add(this.tall.mesh);
  }

  setCard(slot: number, card: CardData | null): void {
    if (slot < 0 || slot >= this.slots) return;
    const prev = this.cards.get(slot) ?? null;
    if (sameCard(prev, card)) return;
    if (card) this.cards.set(slot, card);
    else this.cards.delete(slot);
    this.dirty = true;
  }

  /** Swaps the range (e.g. uncapped from the mezzanine, #20). */
  setRange(range: CardRange): void {
    if (range === this.range) return;
    this.range = range;
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

  /** M5: desk slots currently showing a tall card. */
  shownTall(): number[] {
    return [...this.tallCell.keys()];
  }

  card(slot: number): CardData | null {
    return this.cards.get(slot) ?? null;
  }

  private cellXY(slot: number): [number, number] {
    return [(slot % COLS) * CELL_W, Math.floor(slot / COLS) * CELL_H];
  }

  private tallXY(cell: number): [number, number] {
    return [(cell % TALL_COLS) * CELL_W, Math.floor(cell / TALL_COLS) * TALL_H];
  }

  /** Gives the nearest tall cards a tall cell (keeping the cells they had), frees the rest. */
  private assignTall(chosen: ReadonlyArray<{ index: number }>): void {
    const want = chosen.filter((c) => {
      const card = this.cards.get(c.index);
      return !!card && isTall(card);
    });
    const keep = new Set(want.slice(0, TALL_CELLS).map((c) => c.index));
    for (const slot of [...this.tallCell.keys()]) if (!keep.has(slot)) this.tallCell.delete(slot);
    const used = new Set(this.tallCell.values());
    for (const slot of keep) {
      if (this.tallCell.has(slot)) continue;
      let cell = 0;
      while (used.has(cell)) cell++;
      used.add(cell);
      this.tallCell.set(slot, cell);
    }
  }

  update(camera: THREE.PerspectiveCamera, anchors: ReadonlyArray<THREE.Vector3 | null>, vp: Viewport, force: boolean): void {
    if (!this.object.visible || (!force && !this.dirty)) return;
    this.dirty = false;
    camera.getWorldDirection(this.fwd);
    const eff = anchors.map((a, i) => (a && this.cards.has(i) ? a : null));
    const chosen = selectCards(camera.position, this.fwd, eff, this.range, this.weight, this.occluded);
    this.assignTall(chosen);
    let upload = false;
    let uploadTall = false;
    const measure = (font: string, text: string) => {
      this.tallG.font = font;
      return this.tallG.measureText(text).width;
    };
    for (const c of chosen) {
      const card = this.cards.get(c.index);
      if (!card) continue;
      const cell = this.tallCell.get(c.index);
      if (cell !== undefined) {
        const had = this.tallDrawn.get(cell);
        if (had && had.slot === c.index && sameCard(had.card, card)) continue;
        const L = cardLayout(card, measure);
        const [x, y] = this.tallXY(cell);
        drawTallCard(this.tallG, x, y, card, L);
        this.tallDrawn.set(cell, { slot: c.index, card, layout: L });
        uploadTall = true;
        continue;
      }
      const shown = compactOf(card);
      if (!sameCard(this.drawn.get(c.index) ?? null, shown)) {
        const [x, y] = this.cellXY(c.index);
        drawCard(this.g, x, y, shown);
        this.drawn.set(c.index, shown);
        upload = true;
      }
    }
    if (upload) this.tex.needsUpdate = true;
    if (uploadTall) this.tallTex.needsUpdate = true;
    // Far to near: one draw per batch, blended in order.
    const order = [...chosen].reverse();
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    let k = 0;
    let kt = 0;
    for (const c of order) {
      const a = anchors[c.index];
      if (!a) continue;
      const scale = Math.max(0.62, Math.min(1, 4.2 / Math.max(0.1, c.dist)));
      // View depth, not distance: a camera-facing quad's screen size follows depth.
      const d = Math.max(0.1, this.v.copy(a).sub(camera.position).dot(this.fwd));
      // World width for a card CARD_CSS_W px wide on screen (at scale 1).
      const w = (CARD_CSS_W * scale * 2 * d * tanHalf) / Math.max(1, vp.height);
      const cell = this.tallCell.get(c.index);
      const drawnTall = cell !== undefined ? this.tallDrawn.get(cell) : undefined;
      if (cell !== undefined && drawnTall) {
        const hpx = drawnTall.layout.height;
        this.m.compose(a, camera.quaternion, this.s.set(w, (w * hpx) / CELL_W, w));
        this.tall.mesh.setMatrixAt(kt, this.m);
        const [x, y] = this.tallXY(cell);
        const W = this.tallCanvas.width;
        const H = this.tallCanvas.height;
        this.tall.cell.setXYZW(kt, x / W, 1 - (y + hpx) / H, CELL_W / W, hpx / H);
        this.tall.alpha.setX(kt, c.alpha);
        kt++;
        continue;
      }
      this.m.compose(a, camera.quaternion, this.s.set(w, w, w));
      this.object.setMatrixAt(k, this.m);
      const [x, y] = this.cellXY(c.index);
      const H = this.canvas.height;
      this.cell.setXYZW(k, x / this.canvas.width, 1 - (y + CELL_H) / H, CELL_W / this.canvas.width, CELL_H / H);
      this.alpha.setX(k, c.alpha);
      k++;
    }
    this.object.count = k;
    this.object.instanceMatrix.needsUpdate = true;
    this.cell.needsUpdate = true;
    this.alpha.needsUpdate = true;
    this.tall.mesh.count = kt;
    this.tall.mesh.instanceMatrix.needsUpdate = true;
    this.tall.cell.needsUpdate = true;
    this.tall.alpha.needsUpdate = true;
    this.showing = chosen.map((c) => c.index);
  }

  dispose(): void {
    this.tex.dispose();
    this.tallTex.dispose();
    for (const mesh of [this.tall.mesh, this.object]) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
  }
}
