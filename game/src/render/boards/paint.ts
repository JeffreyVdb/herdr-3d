/**
 * M7: what the wall boards and their notes look like, drawn with the 2D canvas: the cork with its title strip and
 * column heads (one texture per board, redrawn when the data changes), and a note's face (a cell of the board's text
 * atlas, redrawn when that note changes). Pure drawing: no THREE, no state.
 */

import { FONT } from '../cards/layout';
import { STAMP_INK } from '../cards/crewCard';
import { FOOT_H, HEADER_H, HEAD_H, columnCentre, type BoardSize } from '../../world/boards';
import type { Checks, ReviewState } from '../../net/protocol';

/** Texture pixels per metre of board. */
export const PPM = 412;

export const INK = '#1c2540';

/** A note cell's pixels (an issue note is 4 × 3, a PR note 6 × 1). */
export const ISSUE_CELL = { w: 288, h: 216 };
export const PR_CELL = { w: 576, h: 96 };

export interface HeadFace {
  name: string;
  count: number;
  more: number;
  done: boolean;
}

export type BackdropState =
  /** No board: why (an older bridge, no repo linked, no `gh`, …). */
  | { kind: 'off'; text: string; sub?: string }
  | { kind: 'loading'; text: string }
  | { kind: 'ready'; heads: HeadFace[] | null; empty: string; more: number; footer: string | null };

export interface Backdrop {
  title: string;
  note: string;
  accent: string;
  state: BackdropState;
}

export function canvasSize(size: BoardSize): { w: number; h: number } {
  return { w: Math.round(size.w * PPM), h: Math.round(size.h * PPM) };
}

function corkGrain(g: CanvasRenderingContext2D, w: number, h: number): void {
  g.fillStyle = '#c99d6b';
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 1400; i++) {
    g.fillStyle = i % 2 ? 'rgba(90,55,20,0.10)' : 'rgba(255,240,210,0.10)';
    g.fillRect((i * 97) % w, (i * 53) % h, 3, 3);
  }
}

/** Ellipsizes to `w` px in the current font. */
export function fit(g: CanvasRenderingContext2D, s: string, w: number): string {
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

/** Wraps to at most `lines` lines of `w` px (the last one ellipsized), in the current font. */
export function wrap(g: CanvasRenderingContext2D, s: string, w: number, lines: number): string[] {
  const words = s.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    const word = words[i] as string;
    const next = cur ? `${cur} ${word}` : word;
    if (g.measureText(next).width <= w || !cur) {
      cur = next;
      // A single word longer than the line is cut where it stops fitting.
      if (g.measureText(cur).width > w) {
        cur = fit(g, cur, w);
      }
      continue;
    }
    out.push(cur);
    cur = word;
    if (out.length === lines - 1) {
      cur = words.slice(i).join(' ');
      break;
    }
  }
  if (cur) out.push(fit(g, cur, w));
  return out.slice(0, lines);
}

/** The cork board: title strip, column heads, "+N more", or the reason there is nothing to show. */
export function drawBackdrop(g: CanvasRenderingContext2D, size: BoardSize, b: Backdrop): void {
  const { w, h } = canvasSize(size);
  corkGrain(g, w, h);
  const strip = HEADER_H * PPM;
  g.fillStyle = '#1c2540';
  g.fillRect(0, 0, w, strip);
  g.fillStyle = b.accent;
  g.fillRect(0, strip - 6, w, 6);
  g.fillStyle = '#ffffff';
  g.font = `800 ${Math.round(strip * 0.46)}px ${FONT}`;
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  g.fillText(b.title, 26, strip * 0.5 - 2);
  g.font = `600 ${Math.round(strip * 0.24)}px ${FONT}`;
  g.textAlign = 'right';
  g.fillStyle = 'rgba(255,255,255,0.74)';
  g.fillText(fit(g, b.note, w * 0.5), w - 24, strip * 0.5 - 2);
  g.textAlign = 'left';

  const s = b.state;
  if (s.kind !== 'ready') {
    g.textAlign = 'center';
    g.fillStyle = 'rgba(28,37,64,0.86)';
    g.font = `800 ${Math.round(h * 0.075)}px ${FONT}`;
    g.fillText(s.text, w / 2, strip + (h - strip) * 0.42);
    if (s.kind === 'off' && s.sub) {
      g.font = `600 ${Math.round(h * 0.048)}px ${FONT}`;
      g.fillStyle = 'rgba(28,37,64,0.68)';
      g.fillText(fit(g, s.sub, w - 120), w / 2, strip + (h - strip) * 0.42 + h * 0.1);
    }
    g.textAlign = 'left';
    return;
  }
  if (s.heads) {
    const n = s.heads.length;
    s.heads.forEach((c, i) => {
      const cc = columnCentre(size, i, n);
      const x = cc.x * PPM;
      const cw = cc.w * PPM - 14;
      const y = strip + 0.012 * PPM;
      const hh = HEAD_H * PPM - 8;
      g.fillStyle = c.done ? '#e2f5ea' : '#fbf7ee';
      g.beginPath();
      g.roundRect(x - cw / 2, y, cw, hh, hh / 2);
      g.fill();
      g.lineWidth = 3;
      g.strokeStyle = c.done ? '#0b8454' : INK;
      g.stroke();
      g.fillStyle = INK;
      g.font = `800 ${Math.round(hh * 0.5)}px ${FONT}`;
      g.textAlign = 'left';
      const count = String(c.count);
      const cw2 = g.measureText(count).width;
      g.fillText(fit(g, c.name, cw - cw2 - 44), x - cw / 2 + 18, y + hh / 2 + 1);
      g.textAlign = 'right';
      g.fillStyle = c.done ? '#0b8454' : '#4a5570';
      g.fillText(count, x + cw / 2 - 16, y + hh / 2 + 1);
      g.textAlign = 'left';
      if (c.more > 0) {
        g.font = `800 ${Math.round(FOOT_H * PPM * 0.5)}px ${FONT}`;
        const t = `+${c.more} more`;
        const tw = g.measureText(t).width + 30;
        const fy = h - FOOT_H * PPM * 0.5 - 2;
        g.fillStyle = INK;
        g.beginPath();
        g.roundRect(x - tw / 2, fy - FOOT_H * PPM * 0.36, tw, FOOT_H * PPM * 0.72, 999);
        g.fill();
        g.fillStyle = '#ffffff';
        g.textAlign = 'center';
        g.fillText(t, x, fy + 1);
        g.textAlign = 'left';
      }
    });
  } else if (s.more > 0) {
    g.font = `800 ${Math.round(FOOT_H * PPM * 0.5)}px ${FONT}`;
    const t = `+${s.more} more`;
    const tw = g.measureText(t).width + 30;
    const fy = h - FOOT_H * PPM * 0.5 - 2;
    g.fillStyle = INK;
    g.beginPath();
    g.roundRect(w / 2 - tw / 2, fy - FOOT_H * PPM * 0.36, tw, FOOT_H * PPM * 0.72, 999);
    g.fill();
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.fillText(t, w / 2, fy + 1);
    g.textAlign = 'left';
  }
  if (s.empty) {
    g.textAlign = 'center';
    g.fillStyle = 'rgba(28,37,64,0.62)';
    g.font = `700 ${Math.round(h * 0.06)}px ${FONT}`;
    g.fillText(s.empty, w / 2, strip + (h - strip) * 0.55);
    g.textAlign = 'left';
  }
  if (s.footer) {
    g.font = `600 ${Math.round(h * 0.036)}px ${FONT}`;
    g.textAlign = 'right';
    g.fillStyle = 'rgba(28,37,64,0.66)';
    g.fillText(fit(g, s.footer, w * 0.6), w - 22, h - 14);
    g.textAlign = 'left';
  }
}

// ---- notes ------------------------------------------------------------------------------------

export interface IssueFace {
  key: string;
  title: string;
  /** `#rrggbb` paper. */
  paper: string;
  /** `#rrggbb` pin. */
  pin: string;
  /** The live worker holding it: name, and the tint of its avatar. */
  holder: { id: string; name: string; tint: string } | null;
  done: boolean;
}

export interface PrFace {
  key: string;
  title: string;
  branch: string;
  checks: Checks;
  review: ReviewState;
  draft: boolean;
  /** "closes #7" (only issues on the issue board), '' when none. */
  closes: string;
  stamp: { tone: 'pass' | 'changes' | 'incomplete'; text: string } | null;
}

export function sameIssueFace(a: IssueFace | undefined, b: IssueFace): boolean {
  return !!a && a.key === b.key && a.title === b.title && a.paper === b.paper && a.pin === b.pin && a.done === b.done && a.holder?.id === b.holder?.id && a.holder?.name === b.holder?.name && a.holder?.tint === b.holder?.tint;
}

export function samePrFace(a: PrFace | undefined, b: PrFace): boolean {
  return !!a && a.key === b.key && a.title === b.title && a.branch === b.branch && a.checks === b.checks && a.review === b.review && a.draft === b.draft && a.closes === b.closes && a.stamp?.text === b.stamp?.text && a.stamp?.tone === b.stamp?.tone;
}

/** Where the holder's tag sits on a note's cell (px, y down): `by` is its centre line, `bx`/`bw` its left edge and width. */
export function holderPill(g: CanvasRenderingContext2D, holder: string): { name: string; bx: number; by: number; bw: number } {
  g.font = `750 21px ${FONT}`;
  const name = fit(g, holder, 118);
  const bw = g.measureText(name).width + 46;
  const m = 10;
  return { name, bx: ISSUE_CELL.w - m - 10 - bw, by: m + 22, bw };
}

/** A sticky note: paper with a soft shadow, a pin, the key, the title in up to three lines, the holder's tag. */
export function drawIssueNote(g: CanvasRenderingContext2D, x: number, y: number, f: IssueFace): void {
  const W = ISSUE_CELL.w;
  const H = ISSUE_CELL.h;
  g.clearRect(x, y, W, H);
  g.save();
  g.translate(x, y);
  const m = 10;
  g.fillStyle = 'rgba(28,20,8,0.28)';
  g.fillRect(m + 3, m + 5, W - m * 2, H - m * 2);
  g.fillStyle = f.paper;
  g.fillRect(m, m, W - m * 2, H - m * 2);
  // A fold of shade at the foot, like a pad's sheet.
  const grad = g.createLinearGradient(0, H * 0.72, 0, H - m);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.09)');
  g.fillStyle = grad;
  g.fillRect(m, H * 0.72, W - m * 2, H - m - H * 0.72);
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  g.fillStyle = INK;
  g.font = `850 32px ${FONT}`;
  const key = f.key;
  g.fillText(fit(g, key, 130), m + 16, m + 50);
  // Title.
  g.font = `700 27px ${FONT}`;
  const lines = wrap(g, f.title, W - m * 2 - 30, 3);
  lines.forEach((l, i) => g.fillText(l, m + 15, m + 90 + i * 31));
  // The pin, at the top centre.
  g.beginPath();
  g.arc(W / 2, m + 8, 11, 0, Math.PI * 2);
  g.fillStyle = 'rgba(0,0,0,0.3)';
  g.fill();
  g.beginPath();
  g.arc(W / 2 - 1, m + 6, 10, 0, Math.PI * 2);
  g.fillStyle = f.pin;
  g.fill();
  g.lineWidth = 2;
  g.strokeStyle = 'rgba(28,37,64,0.55)';
  g.stroke();
  g.beginPath();
  g.arc(W / 2 - 4, m + 3, 3, 0, Math.PI * 2);
  g.fillStyle = 'rgba(255,255,255,0.7)';
  g.fill();
  if (f.done) {
    g.strokeStyle = '#0b8454';
    g.lineWidth = 6;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(W - m - 60, m + 34);
    g.lineTo(W - m - 44, m + 50);
    g.lineTo(W - m - 16, m + 16);
    g.stroke();
  }
  // The holder: a tiny avatar and its name, top right (the next note covers the foot).
  if (f.holder) {
    const { name, bx, by, bw } = holderPill(g, f.holder.name);
    g.fillStyle = 'rgba(255,255,255,0.86)';
    g.beginPath();
    g.roundRect(bx, by - 18, bw, 34, 17);
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = 'rgba(28,37,64,0.5)';
    g.stroke();
    g.fillStyle = f.holder.tint;
    g.beginPath();
    g.arc(bx + 17, by - 1, 11, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = INK;
    g.lineWidth = 2;
    g.stroke();
    // Two dots for eyes: a face at a glance.
    g.fillStyle = INK;
    g.fillRect(bx + 13, by - 5, 3, 3);
    g.fillRect(bx + 19, by - 5, 3, 3);
    g.fillStyle = INK;
    g.fillText(name, bx + 34, by + 6);
  }
  g.restore();
}

const CHECK_COLOR: Record<Checks, string> = { success: '#12a26a', failure: '#e8413a', pending: '#f5a524', none: '#9aa3b8' };
const CHECK_WORD: Record<Checks, string> = { success: 'CI pass', failure: 'CI fail', pending: 'CI running', none: 'no CI' };
const REVIEW_COLOR: Record<ReviewState, string> = { approved: '#0b8454', changes_requested: '#c42a26', review_required: '#8a5a00', none: '#5d6478' };
const REVIEW_WORD: Record<ReviewState, string> = { approved: 'approved', changes_requested: 'changes asked', review_required: 'needs review', none: '' };

/** A PR's note: white slip, key and title, then CI dot, review, "closes #m", and the verdict stamp. */
export function drawPrNote(g: CanvasRenderingContext2D, x: number, y: number, f: PrFace): void {
  const W = PR_CELL.w;
  const H = PR_CELL.h;
  g.clearRect(x, y, W, H);
  g.save();
  g.translate(x, y);
  const m = 5;
  g.fillStyle = 'rgba(28,20,8,0.28)';
  g.fillRect(m + 2, m + 3, W - m * 2, H - m * 2);
  g.fillStyle = '#f7f4ff';
  g.fillRect(m, m, W - m * 2, H - m * 2);
  g.fillStyle = '#b9a5ff';
  g.fillRect(m, m, 8, H - m * 2);
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  g.fillStyle = INK;
  let right = W - m - 12;
  // The stamp goes first: the title gives way to it.
  if (f.stamp) {
    g.font = `850 20px ${FONT}`;
    const t = f.stamp.text.replace('_', ' ');
    const tw = g.measureText(t).width + 22;
    const ink = STAMP_INK[f.stamp.tone];
    g.save();
    g.translate(right - tw / 2, m + 30);
    g.rotate(-0.06);
    g.lineWidth = 3;
    g.strokeStyle = ink;
    g.strokeRect(-tw / 2, -16, tw, 32);
    g.fillStyle = ink;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(t, 0, 1);
    g.restore();
    right -= tw + 14;
  }
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  g.fillStyle = INK;
  g.font = `850 29px ${FONT}`;
  const kw = g.measureText(f.key).width;
  g.fillText(f.key, m + 22, m + 34);
  g.font = `700 28px ${FONT}`;
  g.fillText(fit(g, f.draft ? `[draft] ${f.title}` : f.title, right - (m + 22 + kw + 12)), m + 22 + kw + 12, m + 34);
  // Second line: CI dot, review, closes, branch.
  g.font = `700 22px ${FONT}`;
  let cx = m + 22;
  const cy = m + 64;
  g.beginPath();
  g.arc(cx + 8, cy - 6, 8, 0, Math.PI * 2);
  if (f.checks === 'none') {
    g.lineWidth = 3;
    g.strokeStyle = CHECK_COLOR.none;
    g.stroke();
  } else {
    g.fillStyle = CHECK_COLOR[f.checks];
    g.fill();
  }
  g.fillStyle = INK;
  g.fillText(CHECK_WORD[f.checks], cx + 24, cy);
  cx += 24 + g.measureText(CHECK_WORD[f.checks]).width + 18;
  const rev = REVIEW_WORD[f.review];
  if (rev) {
    g.fillStyle = REVIEW_COLOR[f.review];
    g.fillText(rev, cx, cy);
    cx += g.measureText(rev).width + 18;
  }
  if (f.closes) {
    g.fillStyle = INK;
    g.fillText(f.closes, cx, cy);
    cx += g.measureText(f.closes).width + 18;
  }
  g.font = `650 21px ${FONT}`;
  g.fillStyle = '#4a5570';
  g.fillText(fit(g, f.branch, Math.max(0, W - m - 12 - cx)), cx, cy);
  g.restore();
}

/** Whether a point of a note's cell (px, y down) is on the holder's tag. */
export function onHolderPill(g: CanvasRenderingContext2D, holder: string, u: number, v: number): boolean {
  const { bx, by, bw } = holderPill(g, holder);
  return u >= bx && u <= bx + bw && v >= by - 18 && v <= by + 16;
}
