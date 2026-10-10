import * as THREE from 'three/webgpu';
import type { Display } from '../world/derive';
import { drawMark, type MarkId } from './brandMarks';
import { FONT } from './cards/layout';
import { STATUS_CHIP_CSS } from './palette';

/**
 * M6b: the two small canvas atlases of the desks, drawn once and shared by
 * every floor (instances pick their cell with an attribute, so there is no
 * material per status or per harness):
 *
 * - The monitor's status bar: one row per status, a dot and the word in
 *   white, big and heavy, on a transparent ground the bar's colour shows
 *   through (the card chips' deepened hues, so white reads at 4.5:1). #98:
 *   WAITING (idle or done on purpose, on its own background tasks) is a row
 *   of its own in a calm teal.
 * - The docked laptop's sticker (#229): the Claude mark for Claude, the
 *   OpenAI mark for Codex (render/brandMarks.ts), white on a dark disc, and a
 *   plain one; the ring round each is transparent, where the model family's
 *   colour shows (the hat's colour, as the old sticker was).
 */

/** The statuses with a bar (asleep, the monitor is dark). */
export type BandStatus = Exclude<Display, 'asleep'>;
export const BAND_WORDS: readonly BandStatus[] = ['working', 'needs_you', 'done', 'idle', 'waiting'];
const WORD: Record<BandStatus, string> = { working: 'WORKING', needs_you: 'NEEDS YOU', done: 'DONE', idle: 'IDLE', waiting: 'WAITING' };
/** The bar's colour per status (0xRRGGBB). */
export const BAND_COLOR: Record<BandStatus, number> = Object.fromEntries(BAND_WORDS.map((d) => [d, Number.parseInt(STATUS_CHIP_CSS[d].slice(1), 16)])) as Record<BandStatus, number>;

export type StickerLogo = 'claude' | 'codex' | 'plain';
export const STICKER_LOGOS: readonly StickerLogo[] = ['claude', 'codex', 'plain'];
export const stickerLogo = (harness: string | undefined | null): StickerLogo => (harness === 'claude' ? 'claude' : harness === 'codex' ? 'codex' : 'plain');
/** #229: the mark a sticker carries (the overview's: brandMarks.markFor), none on the plain one. */
export const STICKER_MARK: Readonly<Record<StickerLogo, MarkId | null>> = { claude: 'claude', codex: 'openai', plain: null };
/** The disc under a mark. */
const STICKER_DISC = '#11141c';

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

/** The sticker atlas: cell `i` (left first) is `STICKER_LOGOS[i]`; alpha 0 is the ring (the model colour). */
export function stickerAtlas(): THREE.CanvasTexture {
  if (sticker) return sticker;
  const { c, g } = canvas(STICKER * STICKER_LOGOS.length, STICKER);
  const R = STICKER / 2;
  const inner = R * 0.78;
  STICKER_LOGOS.forEach((logo, i) => {
    const cx = i * STICKER + R;
    const cy = R;
    const mark = STICKER_MARK[logo];
    if (!mark) return;
    g.fillStyle = STICKER_DISC;
    g.beginPath();
    g.arc(cx, cy, inner, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#ffffff';
    drawMark(g, mark, cx, cy, inner * 1.2);
  });
  sticker = texture(c);
  return sticker;
}
