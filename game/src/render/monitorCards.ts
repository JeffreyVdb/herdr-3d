import * as THREE from 'three/webgpu';
import { attribute, clamp, color, float, floor, fract, mix, mod, select, step, texture, uniform, uv, vec2 } from 'three/tsl';
import { SYSTEM_MONO } from '../ui/themes';
import { CLOCK_GLYPH, elapsedText, faceKey, TIMER_GLYPHS, TIMER_SLOTS, timerGlyphs, type CardFace, type Tone } from '../world/activity';
import { MONITOR, monitorFrame } from '../world/deskKit';
import type { DeskSlot } from '../world/layout';
import { FONT } from './cards/layout';
import { FRAMES, mascotPixels, POSE_FPS, SPRITE, SPRITE_COLS, SPRITE_ROWS, spriteRow } from './mascotArt';
import { bitmapTexture } from './prints';

/**
 * #98: the desk monitors' activity cards, every desk of a floor in one instanced draw, and the images agents look at
 * on the desks near you.
 *
 * A card fills the monitor's terminal area (under the status bar): on the left 40 % the mascot (`mascotArt.ts`) on a
 * little stage in the kind's colour, on the right the word in big type and the detail (or, waiting, what is awaited on
 * a strip of label tape), and under them the elapsed counter. Nothing is drawn per frame:
 *
 * - The mascots are one sprite sheet drawn at load; the shader picks the row (the desk's mascot and pose, an instance
 *   attribute) and the frame (`uTime` × the pose's fps + the desk's phase). Reduced motion holds frame 0.
 * - The word and the detail are a cell per desk of one text atlas, drawn only when they change (`faceKey`), and
 *   uploaded at most every `UPLOAD_MS` however many changed.
 * - The counter is 8 glyphs of a small static atlas; which glyph each slot shows is an instance attribute (two vec4),
 *   written once a second for the cards on the floor. So it ticks on every desk with no canvas drawn and only a few
 *   hundred bytes uploaded a second.
 *
 * An image (the near desks only: `laptop/monitors.ts` fetches its thumbnail) is a plane of its own, letterboxed over
 * the area above a caption strip with its file name; its card is hidden meanwhile. The textures are counted (`ledger`).
 */

/** Where the mascot ends and the text begins, in the area's width; the text cell's bottom; the counter's strip. */
export const SPLIT = 0.4;
export const TEXT_V0 = 0.27;
const TIMER = { u0: SPLIT + 0.035, v0: 0.075, h: 0.155 };
/** Text cells (px) and the atlas's columns. */
export const CELL_W = 256;
export const CELL_H = 128;
const COLS = 8;
/** The text atlas is uploaded at most this often (a floor's labels change a few times a second at most). */
export const UPLOAD_MS = 300;
/** Lifted off the glass like the screens (frozen 0.001, live 0.0015): over the glow, under the seat's full screen. */
const LIFT = 0.0011;
/** The counter's glyph cells (px). */
const GLYPH_W = 40;
const GLYPH_H = 64;
/** The caption strip under an image, in the area's height. */
const CAPTION_H = 0.16;

/** The screen's ground (the terminal glance's own), the text's colours. */
export const CARD_BG = 0x1a2138;
const INK = '#ffffff';
const SOFT = '#b9c3dc';
const MONO = `"JetBrains Mono Variable", ${SYSTEM_MONO}`;

/** A kind's colour (its stage and its counter), bright on the screen's ground (≥ 4.5:1). */
export const TONE_COLOR: Record<Tone, number> = {
  thinking: 0xb7a3ff,
  replying: 0x7cc4ff,
  writing: 0xffc233,
  investigating: 0x5fd4d0,
  testing: 0x9be05a,
  building: 0xff9b52,
  shipping: 0xff8fb8,
  researching: 0x74d99f,
  delegating: 0xffb38a,
  planning: 0xe8d36a,
  waiting: 0x4fd1c5,
  image: 0xffc233,
  working: 0xa9bce0,
  done: 0x4cd68f,
  idle: 0x9aa3b8,
};
/** The waiting badge's tape (white on it ≥ 4.5:1: the WAITING band's colour). */
const TAPE = '#0f7378';

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

let sprites: THREE.CanvasTexture | null = null;
let glyphs: THREE.CanvasTexture | null = null;

function canvas(w: number, h: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) throw new Error('2D canvas unavailable');
  return { c, g };
}

/** The mascot sheet as a texture, drawn once and shared by every floor: crisp up close, mipmapped away. */
export function spriteAtlas(): THREE.CanvasTexture {
  if (sprites) return sprites;
  const px = mascotPixels();
  const { c, g } = canvas(px.width, px.height);
  const img = g.createImageData(px.width, px.height);
  img.data.set(px.data);
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  // Premultiplied, so the smaller mips do not darken the art's edges.
  t.premultiplyAlpha = true;
  sprites = t;
  return t;
}

/** Draws the counter's little clock: a ring and two hands. */
function clockGlyph(g: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  g.strokeStyle = '#ffffff';
  g.lineWidth = r * 0.3;
  g.lineCap = 'round';
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  g.moveTo(cx, cy);
  g.lineTo(cx, cy - r * 0.6);
  g.moveTo(cx, cy);
  g.lineTo(cx + r * 0.45, cy + r * 0.2);
  g.stroke();
}

/** The counter's glyphs in white (`TIMER_GLYPHS`, then the clock), a cell each, drawn once. */
export function glyphAtlas(): THREE.CanvasTexture {
  if (glyphs) return glyphs;
  const n = TIMER_GLYPHS.length + 1;
  const { c, g } = canvas(GLYPH_W * n, GLYPH_H);
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `800 50px ${FONT}`;
  [...TIMER_GLYPHS].forEach((ch, i) => {
    if (ch !== ' ') g.fillText(ch, i * GLYPH_W + GLYPH_W / 2, GLYPH_H / 2 + 3);
  });
  clockGlyph(g, CLOCK_GLYPH * GLYPH_W + GLYPH_W / 2, GLYPH_H / 2, 13);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  // No mips: a slot's glyph changes between neighbouring pixels.
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearFilter;
  glyphs = t;
  return t;
}

/** A part of a monitor's terminal area (0–1 across from the chair's left, 0–1 up) as a plane in slot space. */
export function areaGeometry(u0: number, v0: number, u1: number, v1: number, lift: number): THREE.BufferGeometry {
  const f = monitorFrame(lift);
  const w = (u1 - u0) * f.width;
  const h = (v1 - v0) * f.height;
  // Turned half a turn to face the chair, so +x before the turn is the chair's right.
  return new THREE.PlaneGeometry(w, h)
    .translate(((u0 + u1) / 2 - 0.5) * f.width, ((v0 + v1) / 2 - 0.5) * f.height, 0)
    .rotateY(Math.PI)
    .rotateX(MONITOR.tilt)
    .translate(f.center.x, f.center.y, f.center.z);
}

/** The largest box of aspect `a` (w / h) in `box` (area units, the area's own aspect `area`), centred. */
export function letterbox(a: number, box: { u0: number; v0: number; u1: number; v1: number }, area: number): { u0: number; v0: number; u1: number; v1: number } {
  const bw = (box.u1 - box.u0) * area;
  const bh = box.v1 - box.v0;
  const k = a > 0 && Number.isFinite(a) ? a : bw / bh;
  const w = Math.min(bw, bh * k);
  const h = w / k;
  const cu = (box.u0 + box.u1) / 2;
  const cv = (box.v0 + box.v1) / 2;
  return { u0: cu - w / area / 2, v0: cv - h / 2, u1: cu + w / area / 2, v1: cv + h / 2 };
}

/** Fits `text` into `max` px at `font` (an ellipsis when it must). */
function fitText(g: CanvasRenderingContext2D, text: string, max: number): string {
  if (g.measureText(text).width <= max) return text;
  const cps = [...text];
  while (cps.length > 1 && g.measureText(`${cps.join('')}…`).width > max) cps.pop();
  return `${cps.join('').trimEnd()}…`;
}

/** Splits `text` into at most `n` lines of `max` px (the last one with an ellipsis when it must). */
function wrap(g: CanvasRenderingContext2D, text: string, max: number, n: number): string[] {
  const out: string[] = [];
  let line = '';
  const words = text.split(' ');
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string;
    const next = line ? `${line} ${w}` : w;
    if (g.measureText(next).width <= max || !line) {
      line = next;
      continue;
    }
    if (out.length === n - 1) {
      line = `${line} ${words.slice(i).join(' ')}`;
      break;
    }
    out.push(line);
    line = w;
  }
  out.push(line);
  return out.map((l) => fitText(g, l, max));
}

/** Draws a card's text cell: the word as big as it fits (two lines when it must), the detail or the badge under it. */
export function drawCell(g: CanvasRenderingContext2D, x: number, y: number, face: CardFace): void {
  const W = CELL_W;
  const H = CELL_H;
  const pad = 10;
  g.save();
  g.beginPath();
  g.rect(x, y, W, H);
  g.clip();
  g.fillStyle = `#${CARD_BG.toString(16).padStart(6, '0')}`;
  g.fillRect(x, y, W, H);
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  const max = W - 2 * pad;
  // What is awaited, on label tape (the HUD's status chips), up to two lines: it decides how much room the word has.
  let tape: string[] = [];
  if (face.badge !== null) {
    g.font = `700 17px ${FONT}`;
    tape = wrap(g, face.badge, max - 16, 2);
  }
  const under = tape.length > 0 || face.detail !== '';
  // The word: up to 56 px (46 over two lines of tape); a long one ("Looking at an image") on two lines rather than small.
  let size = tape.length > 1 ? 46 : 56;
  g.font = `800 ${size}px ${FONT}`;
  let lines = [face.word];
  const wide = g.measureText(face.word).width;
  if (wide > max) {
    const fit = Math.floor((size * max) / wide);
    const words = face.word.split(' ');
    if (fit < 34 && words.length > 1) {
      const half = Math.ceil(words.length / 2);
      lines = [words.slice(0, half).join(' '), words.slice(half).join(' ')];
      const w2 = Math.max(...lines.map((l) => g.measureText(l).width));
      size = Math.min(40, Math.floor((size * max) / w2));
    } else size = Math.max(26, fit);
  }
  g.font = `800 ${size}px ${FONT}`;
  g.fillStyle = INK;
  const lh = size * 0.98;
  // Baseline of the word's last line: high with something under it, else low (just over the counter).
  const last = under ? Math.min(tape.length > 1 ? 50 : 66, 8 + lines.length * lh - size * 0.2) : H - 30;
  lines.forEach((l, i) => g.fillText(fitText(g, l, max), x + pad, y + last - (lines.length - 1 - i) * lh));
  if (tape.length) {
    g.font = `700 17px ${FONT}`;
    const lineH = 21;
    const tw = Math.max(...tape.map((l) => g.measureText(l).width)) + 16;
    const th = tape.length * lineH + 8;
    const top = H - 10 - th;
    g.save();
    g.translate(x + pad + tw / 2, y + top + th / 2);
    g.rotate(-0.026);
    g.fillStyle = TAPE;
    g.fillRect(-tw / 2, -th / 2, tw, th);
    g.fillStyle = 'rgba(255,255,255,0.28)';
    g.fillRect(-tw / 2, -th / 2, tw, 2);
    g.fillStyle = INK;
    tape.forEach((l, i) => g.fillText(l, -tw / 2 + 8, -th / 2 + 4 + (i + 1) * lineH - 5));
    g.restore();
  } else if (face.detail) {
    g.font = `600 22px ${MONO}`;
    g.fillStyle = SOFT;
    g.fillText(fitText(g, face.detail, max), x + pad, y + 100);
  }
  g.restore();
}

/** Draws an image's caption strip: a little picture and the file name. */
function drawCaption(g: CanvasRenderingContext2D, w: number, h: number, caption: string): void {
  g.fillStyle = '#10162a';
  g.fillRect(0, 0, w, h);
  // A picture: a frame, the sky, a hill, the sun.
  const s = h * 0.56;
  const x0 = h * 0.3;
  const y0 = (h - s) / 2;
  g.fillStyle = '#fbf7ec';
  g.fillRect(x0, y0, s * 1.25, s);
  g.fillStyle = '#9fd3f0';
  g.fillRect(x0 + 3, y0 + 3, s * 1.25 - 6, s - 6);
  g.fillStyle = '#7ccf6a';
  g.beginPath();
  g.moveTo(x0 + 3, y0 + s - 3);
  g.lineTo(x0 + s * 0.5, y0 + s * 0.45);
  g.lineTo(x0 + s * 1.25 - 3, y0 + s - 3);
  g.fill();
  g.fillStyle = '#ffc233';
  g.fillRect(x0 + s * 0.85, y0 + 5, 6, 6);
  g.fillStyle = INK;
  g.font = `600 ${Math.round(h * 0.5)}px ${FONT}`;
  g.textBaseline = 'middle';
  const tx = x0 + s * 1.25 + h * 0.3;
  g.fillText(fitText(g, caption, w - tx - h * 0.3), tx, h / 2 + 1);
}

interface Shown {
  key: string;
  since: number | null;
  timer: string;
}

interface ImageDesk {
  group: THREE.Group;
  image: THREE.Texture;
  caption: THREE.CanvasTexture;
  mats: THREE.Material[];
  geos: THREE.BufferGeometry[];
  hash: string;
  aspect: number;
}

export interface MonitorLedger {
  /** Text cells drawn, atlas uploads, counter attribute writes (the cards'). */
  cells: number;
  uploads: number;
  timerWrites: number;
  /** Image textures made and disposed, bitmaps closed. */
  created: number;
  disposed: number;
  closed: number;
}

export class MonitorCards {
  readonly group = new THREE.Group();
  readonly ledger: MonitorLedger = { cells: 0, uploads: 0, timerWrites: 0, created: 0, disposed: 0, closed: 0 };
  private readonly mesh: THREE.InstancedMesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly atlas: THREE.CanvasTexture;
  private readonly aSprite: THREE.InstancedBufferAttribute;
  private readonly aTone: THREE.InstancedBufferAttribute;
  private readonly aCell: THREE.InstancedBufferAttribute;
  private readonly aT0: THREE.InstancedBufferAttribute;
  private readonly aT1: THREE.InstancedBufferAttribute;
  private readonly uTime = uniform(0);
  private readonly uMotion = uniform(1);
  private readonly shown = new Map<number, Shown>();
  private readonly images = new Map<number, ImageDesk>();
  private readonly bgMat = new THREE.MeshBasicMaterial({ color: CARD_BG });
  private atlasDirty = false;
  private lastUpload = -Infinity;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly c = new THREE.Color();

  constructor(private readonly slots: readonly DeskSlot[]) {
    this.group.name = 'monitors';
    const n = Math.max(1, slots.length);
    const rows = Math.ceil(n / COLS);
    const { c, g } = canvas(CELL_W * COLS, CELL_H * rows);
    this.canvas = c;
    this.g = g;
    this.atlas = new THREE.CanvasTexture(c);
    this.atlas.colorSpace = THREE.SRGBColorSpace;
    this.atlas.minFilter = THREE.LinearMipmapLinearFilter;
    this.atlas.anisotropy = 4;
    const geo = areaGeometry(0, 0, 1, 1, LIFT);
    const attr = (name: string, size: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(n * size), size);
      geo.setAttribute(name, a);
      return a;
    };
    this.aSprite = attr('aSprite', 3);
    this.aTone = attr('aTone', 3);
    this.aCell = attr('aCell', 4);
    this.aT0 = attr('aT0', 4);
    this.aT1 = attr('aT1', 4);
    for (let i = 0; i < n; i++) {
      const x = (i % COLS) * CELL_W;
      const y = Math.floor(i / COLS) * CELL_H;
      this.aCell.setXYZW(i, x / c.width, 1 - (y + CELL_H) / c.height, CELL_W / c.width, CELL_H / c.height);
    }
    this.mesh = new THREE.InstancedMesh(geo, this.material(), n);
    this.mesh.name = 'monitors.cards';
    this.mesh.frustumCulled = false;
    // No draw at all while no desk has a card (the Terminal preference, a floor of plain shells).
    this.mesh.visible = false;
    for (let i = 0; i < n; i++) this.mesh.setMatrixAt(i, ZERO);
    this.group.add(this.mesh);
  }

  private material(): THREE.MeshBasicNodeMaterial {
    const m = new THREE.MeshBasicNodeMaterial();
    const u = uv().x;
    const v = uv().y;
    const bg = color(CARD_BG);
    const tone = attribute('aTone', 'vec3');
    // The mascot: its row, and its frame from the time (frame 0 with reduced motion), on a pixel stage of the kind's colour.
    const sp = attribute('aSprite', 'vec3');
    const frame = floor(mod(this.uTime.mul(sp.z).add(sp.y), float(FRAMES))).mul(this.uMotion);
    const edge = 0.5 / SPRITE;
    const mu = clamp(u.div(SPLIT), edge, 1 - edge);
    const mv = clamp(v, edge, 1 - edge);
    const art = texture(spriteAtlas(), vec2(frame.add(mu).div(SPRITE_COLS), float(SPRITE_ROWS - 1).sub(sp.x).add(mv).div(SPRITE_ROWS)));
    const px = floor(mu.mul(SPRITE)).add(0.5).sub(SPRITE / 2).div(11);
    const py = floor(float(1).sub(mv).mul(SPRITE)).add(0.5).sub(28.5).div(2.5);
    const stage = step(px.mul(px).add(py.mul(py)), float(1));
    const left = mix(bg, tone, stage.mul(0.32)).mul(float(1).sub(art.a)).add(art.rgb);
    // The text cell, and under it the counter's glyphs (the slot's glyph from the two attributes) in the kind's colour.
    const cell = attribute('aCell', 'vec4');
    const tu = clamp(u.sub(SPLIT).div(1 - SPLIT), 0, 1);
    const tv = clamp(v.sub(TEXT_V0).div(1 - TEXT_V0), 0, 1);
    const text = mix(bg, texture(this.atlas, vec2(cell.x.add(tu.mul(cell.z)), cell.y.add(tv.mul(cell.w)))).rgb, step(float(TEXT_V0), v));
    const slotW = ((TIMER.h * monitorFrame().height) / monitorFrame().width) * (GLYPH_W / GLYPH_H);
    const lu = u.sub(TIMER.u0).div(slotW * TIMER_SLOTS);
    const lv = v.sub(TIMER.v0).div(TIMER.h);
    const inT = step(float(0), lu).mul(step(lu, float(1))).mul(step(float(0), lv)).mul(step(lv, float(1)));
    const at = clamp(lu, 0, 0.9999).mul(TIMER_SLOTS);
    const slot = floor(at);
    const a0 = attribute('aT0', 'vec4');
    const a1 = attribute('aT1', 'vec4');
    const code = select(
      slot.lessThan(1),
      a0.x,
      select(slot.lessThan(2), a0.y, select(slot.lessThan(3), a0.z, select(slot.lessThan(4), a0.w, select(slot.lessThan(5), a1.x, select(slot.lessThan(6), a1.y, select(slot.lessThan(7), a1.z, a1.w)))))),
    );
    const glyph = texture(glyphAtlas(), vec2(code.add(fract(at)).div(TIMER_GLYPHS.length + 1), clamp(lv, 0, 1)));
    const right = mix(text, tone, glyph.a.mul(inT));
    m.colorNode = mix(right, left, step(u, float(SPLIT)));
    return m;
  }

  /** A desk's slot transform (the same as its desk art). */
  private slotMatrix(desk: number, out = this.m): THREE.Matrix4 {
    const s = this.slots[desk];
    if (!s) return out.copy(ZERO);
    this.q.setFromAxisAngle(this.up, s.yaw);
    return out.compose(this.v.set(s.seat.x, 0, s.seat.z), this.q, this.one);
  }

  /**
   * A desk's card (null: none). The text cell is drawn only when the face changes; `phase` staggers the animation from
   * desk to desk; `now` (unix ms) is for the counter.
   */
  set(desk: number, face: CardFace | null, phase: number, now: number): void {
    if (!this.slots[desk]) return;
    const cur = this.shown.get(desk);
    if (!face) {
      if (!cur) return;
      this.shown.delete(desk);
      this.mesh.setMatrixAt(desk, ZERO);
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.visible = this.shown.size > 0;
      return;
    }
    const key = faceKey(face);
    if (!cur || cur.key !== key) {
      drawCell(this.g, (desk % COLS) * CELL_W, Math.floor(desk / COLS) * CELL_H, face);
      this.ledger.cells++;
      this.atlasDirty = true;
      this.aSprite.setXYZ(desk, spriteRow(face.mascot, face.pose), phase, POSE_FPS[face.pose]);
      this.aSprite.needsUpdate = true;
      this.c.set(TONE_COLOR[face.tone]);
      this.aTone.setXYZ(desk, this.c.r, this.c.g, this.c.b);
      this.aTone.needsUpdate = true;
    }
    const shown: Shown = { key, since: face.since, timer: cur?.since === face.since ? cur.timer : '\u0000' };
    this.shown.set(desk, shown);
    this.writeTimer(desk, shown, now);
    if (!cur) {
      this.mesh.setMatrixAt(desk, this.images.has(desk) ? ZERO : this.slotMatrix(desk));
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.visible = true;
    }
  }

  private writeTimer(desk: number, s: Shown, now: number): void {
    const text = s.since === null ? null : elapsedText(now - s.since);
    if ((text ?? '') === s.timer) return;
    s.timer = text ?? '';
    const g = timerGlyphs(text);
    this.aT0.setXYZW(desk, g[0] ?? 0, g[1] ?? 0, g[2] ?? 0, g[3] ?? 0);
    this.aT1.setXYZW(desk, g[4] ?? 0, g[5] ?? 0, g[6] ?? 0, g[7] ?? 0);
    this.aT0.needsUpdate = true;
    this.aT1.needsUpdate = true;
    this.ledger.timerWrites++;
  }

  /** Once a second (or sooner after a change): every card's counter. */
  tick(now: number): void {
    for (const [desk, s] of this.shown) this.writeTimer(desk, s, now);
  }

  /** Once per frame: the animation's time, and the text atlas's upload when a cell changed (throttled). */
  frame(t: number): void {
    this.uTime.value = t / 1000;
    if (!this.atlasDirty || t - this.lastUpload < UPLOAD_MS) return;
    this.atlasDirty = false;
    this.lastUpload = t;
    this.atlas.needsUpdate = true;
    this.ledger.uploads++;
  }

  /** prefers-reduced-motion: every mascot holds its first frame. */
  setMotion(on: boolean): void {
    this.uMotion.value = on ? 1 : 0;
  }

  get motion(): boolean {
    return this.uMotion.value === 1;
  }

  // --- images ---

  /** Shows a decoded thumbnail on a desk's monitor (the desk owns the bitmap from now on), letterboxed over its caption. */
  setImage(desk: number, hash: string, bitmap: ImageBitmap, caption: string): void {
    this.clearImage(desk);
    if (!this.slots[desk]) {
      bitmap.close();
      this.ledger.closed++;
      return;
    }
    const f = monitorFrame();
    const aspect = bitmap.width > 0 && bitmap.height > 0 ? bitmap.width / bitmap.height : 16 / 10;
    const box = letterbox(aspect, { u0: 0.02, v0: CAPTION_H + 0.03, u1: 0.98, v1: 0.97 }, f.width / f.height);
    const image = bitmapTexture(bitmap);
    this.ledger.created++;
    const cap = canvas(768, 64);
    drawCaption(cap.g, 768, 64, caption);
    const capTex = new THREE.CanvasTexture(cap.c);
    capTex.colorSpace = THREE.SRGBColorSpace;
    this.ledger.created++;
    const geos = [areaGeometry(0, 0, 1, 1, LIFT), areaGeometry(box.u0, box.v0, box.u1, box.v1, LIFT + 0.0001), areaGeometry(0, 0, 1, CAPTION_H, LIFT + 0.0001)];
    const mats: THREE.Material[] = [new THREE.MeshBasicMaterial({ map: image }), new THREE.MeshBasicMaterial({ map: capTex })];
    const group = new THREE.Group();
    group.name = `monitors.image.${desk}`;
    group.matrixAutoUpdate = false;
    this.slotMatrix(desk, group.matrix);
    group.add(new THREE.Mesh(geos[0], this.bgMat), new THREE.Mesh(geos[1], mats[0]), new THREE.Mesh(geos[2], mats[1]));
    for (const o of group.children) o.frustumCulled = false;
    this.group.add(group);
    this.images.set(desk, { group, image, caption: capTex, mats, geos: geos as THREE.BufferGeometry[], hash, aspect });
    this.mesh.setMatrixAt(desk, ZERO);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** The desk's image goes (its textures disposed, its bitmap closed); its card shows again if it has one. */
  clearImage(desk: number): void {
    const d = this.images.get(desk);
    if (!d) return;
    this.images.delete(desk);
    this.group.remove(d.group);
    for (const m of d.mats) m.dispose();
    for (const g of d.geos) g.dispose();
    const img = d.image.image as { close?: () => void } | null;
    d.image.dispose();
    d.caption.dispose();
    this.ledger.disposed += 2;
    if (img && typeof img.close === 'function') {
      img.close();
      this.ledger.closed++;
    }
    if (this.shown.has(desk)) {
      this.mesh.setMatrixAt(desk, this.slotMatrix(desk));
      this.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  imageOf(desk: number): { hash: string; aspect: number } | null {
    const d = this.images.get(desk);
    return d ? { hash: d.hash, aspect: d.aspect } : null;
  }

  imageDesks(): number[] {
    return [...this.images.keys()];
  }

  // --- test hooks ---

  has(desk: number): boolean {
    return this.shown.has(desk) && !this.images.has(desk);
  }

  timerText(desk: number): string | null {
    return this.shown.get(desk)?.timer ?? null;
  }

  /** The sprite row, phase and fps a desk's card animates with. */
  sprite(desk: number): { row: number; phase: number; fps: number } | null {
    if (!this.shown.has(desk)) return null;
    return { row: this.aSprite.getX(desk), phase: this.aSprite.getY(desk), fps: this.aSprite.getZ(desk) };
  }

  /** Versions of the shared textures (each upload bumps one). */
  textureVersions(): { text: number; sprites: number; glyphs: number } {
    return { text: this.atlas.version, sprites: spriteAtlas().version, glyphs: glyphAtlas().version };
  }

  /** Meshes drawn (every card is one instanced draw; an image adds its own planes). */
  drawn(): number {
    let n = 0;
    this.group.traverseVisible((o) => {
      if ((o as THREE.Mesh).isMesh) n++;
    });
    return this.group.visible ? n : 0;
  }

  get texturesAlive(): number {
    return this.ledger.created - this.ledger.disposed;
  }

  setVisible(on: boolean): void {
    this.group.visible = on;
  }

  dispose(): void {
    for (const d of [...this.images.keys()]) this.clearImage(d);
    this.group.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
    this.atlas.dispose();
    this.bgMat.dispose();
  }
}
