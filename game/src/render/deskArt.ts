import * as THREE from 'three/webgpu';
import type { Display } from '../world/derive';
import { FONT } from './cards/layout';
import { STATUS_CHIP_CSS } from './palette';

/**
 * M6b: the two small canvas atlases of the desks, drawn once and shared by
 * every floor (instances pick their cell with an attribute, so there is no
 * material per status or per harness):
 *
 * - The monitor's status bar: one row per status, a dot and the word in
 *   white, big and heavy, on a transparent ground the bar's colour shows
 *   through (the card chips' deepened hues, so white reads at 4.5:1).
 * - The docked laptop's sticker: the Claude Code spark (a terracotta
 *   starburst on cream), the Codex prompt (a white `>_` on ink), and a plain
 *   one; the ring round each is transparent, where the model family's colour
 *   shows (the hat's colour, as the old sticker was).
 */

/** The statuses with a bar (asleep, the monitor is dark). */
export type BandStatus = Exclude<Display, 'asleep'>;
export const BAND_WORDS: readonly BandStatus[] = ['working', 'needs_you', 'done', 'idle'];
const WORD: Record<BandStatus, string> = { working: 'WORKING', needs_you: 'NEEDS YOU', done: 'DONE', idle: 'IDLE' };
/** The bar's colour per status (0xRRGGBB). */
export const BAND_COLOR: Record<BandStatus, number> = Object.fromEntries(BAND_WORDS.map((d) => [d, Number.parseInt(STATUS_CHIP_CSS[d].slice(1), 16)])) as Record<BandStatus, number>;

export type StickerLogo = 'claude' | 'codex' | 'plain';
export const STICKER_LOGOS: readonly StickerLogo[] = ['claude', 'codex', 'plain'];
export const stickerLogo = (harness: string | undefined | null): StickerLogo => (harness === 'claude' ? 'claude' : harness === 'codex' ? 'codex' : 'plain');

const BAND_W = 1024;
const BAND_H = 128;
const STICKER = 128;

let band: THREE.CanvasTexture | null = null;
let sticker: THREE.CanvasTexture | null = null;

function canvas(w: number, h: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) throw new Error('2D canvas unavailable');
  return { c, g };
}

function texture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** The status bar atlas: row `i` (top first) is `BAND_WORDS[i]`. */
export function bandAtlas(): THREE.CanvasTexture {
  if (band) return band;
  const { c, g } = canvas(BAND_W, BAND_H * BAND_WORDS.length);
  BAND_WORDS.forEach((d, i) => {
    const y = i * BAND_H + BAND_H / 2;
    g.fillStyle = '#ffffff';
    // A status light, then the word: heavy, tracked out a little, as tall as the bar allows.
    g.beginPath();
    g.arc(58, y, 22, 0, Math.PI * 2);
    g.fill();
    g.font = `850 88px ${FONT}`;
    g.textBaseline = 'middle';
    (g as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '4px';
    g.fillText(WORD[d], 108, y + 4);
  });
  band = texture(c);
  return band;
}

/** Draws the Claude Code spark: rounded rays of two lengths round a small hub. */
function spark(g: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  g.strokeStyle = '#d97757';
  g.lineCap = 'round';
  const rays = 11;
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2 - Math.PI / 2 + (i % 3) * 0.05;
    const len = r * (i % 2 ? 0.78 : 1);
    g.lineWidth = r * (i % 2 ? 0.2 : 0.24);
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * r * 0.12, cy + Math.sin(a) * r * 0.12);
    g.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
    g.stroke();
  }
}

/** Draws a terminal prompt `>_`: a heavy chevron and a cursor bar. */
function prompt(g: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  g.strokeStyle = '#ffffff';
  g.fillStyle = '#ffffff';
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.lineWidth = r * 0.3;
  g.beginPath();
  g.moveTo(cx - r * 0.62, cy - r * 0.52);
  g.lineTo(cx - r * 0.02, cy - r * 0.02);
  g.lineTo(cx - r * 0.62, cy + r * 0.48);
  g.stroke();
  g.beginPath();
  g.roundRect(cx + r * 0.14, cy + r * 0.3, r * 0.62, r * 0.26, r * 0.1);
  g.fill();
}

/** The sticker atlas: cell `i` (left first) is `STICKER_LOGOS[i]`; alpha 0 is the ring (the model colour). */
export function stickerAtlas(): THREE.CanvasTexture {
  if (sticker) return sticker;
  const { c, g } = canvas(STICKER * STICKER_LOGOS.length, STICKER);
  const R = STICKER / 2;
  const inner = R * 0.78;
  STICKER_LOGOS.forEach((logo, i) => {
    const cx = i * STICKER + R;
    const cy = R;
    if (logo === 'plain') return;
    g.fillStyle = logo === 'claude' ? '#f6f1e7' : '#11141c';
    g.beginPath();
    g.arc(cx, cy, inner, 0, Math.PI * 2);
    g.fill();
    if (logo === 'claude') spark(g, cx, cy, inner * 0.72);
    else prompt(g, cx, cy, inner * 0.78);
  });
  sticker = texture(c);
  return sticker;
}
