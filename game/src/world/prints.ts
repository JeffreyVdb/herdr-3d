/**
 * M16 phase 2: the prints on a worker's desk. The images the conversation has held, lying tossed in two trays in the
 * free strip at the front of the desk, between the keyboard and the desk's edge: what the user sent in the IN tray (a
 * cream tray, prints with a white border) on the worker's left, what the agent viewed or made in the OUT tray (a sun
 * tray, prints with a coloured border) on its right. At most `MAX_TRAY` of each, the newest on top.
 *
 * Slot space, as world/deskKit.ts: origin on the floor under the seat, the worker faces +z, the desk centre at
 * z = SEAT_OFFSET, its top at DESK_H. So IN is on slot +x, which is the left of anyone looking at the desk from the chair.
 * Pure: vitest checks every print of every desk keeps to the desktop and clear of the desk's things.
 */

import type { ImageRef } from '../net/protocol';
import { hash32 } from './derive';
import { DESK_H, SEAT_OFFSET, type DeskSlot, type Rect } from './layout';
import { footOf } from './deskKit';

/** Desks with prints at a time (the nearest, in view). */
export const PRINT_DESKS = 2;
/** Prints per tray: 5 in + 5 out is at most 10 on a desk. */
export const MAX_TRAY = 5;
/** The longest side of a picture, in metres. */
export const PRINT_LONG = 0.08;
/** The white/coloured paper around a picture. */
export const PRINT_MARGIN = 0.0045;
/** Prints at rest stack this much apart (no z-fighting), on the tray's floor. */
export const PRINT_STEP = 0.0009;
export const TRAY_H = 0.006;
/** Most a print turns from square, in radians. */
export const MAX_TURN = 0.3;

export type Tray = 'in' | 'out';

/** The trays: centred at ±0.17 in the strip in front of the keyboard (slot space). */
export const TRAY_RECT: Record<Tray, Rect> = {
  in: { x0: 0.04, z0: SEAT_OFFSET - 0.3375, x1: 0.3, z1: SEAT_OFFSET - 0.2225 },
  out: { x0: -0.3, z0: SEAT_OFFSET - 0.3375, x1: -0.04, z1: SEAT_OFFSET - 0.2225 },
};

export const trayOf = (r: Pick<ImageRef, 'origin'>): Tray => (r.origin === 'input' ? 'in' : 'out');

/** What a picked ref needs to be drawn. */
export interface PrintPick {
  /** Stable across lists: the image's hash, else "item:index" for one with no bytes. */
  key: string;
  tray: Tray;
  ref: ImageRef;
  /** Nothing to show (unavailable, binary): a blank tinted card. */
  blank: boolean;
}

const blankRef = (r: ImageRef) => !!r.unavailable || !r.hash || r.mime === 'binary';

/**
 * The prints of a session's image list (oldest first, as `transcript.images` sends it): the same image once (its newest
 * showing), split by origin, the newest `MAX_TRAY` of each, oldest first (so the last is on top).
 */
export function pickPrints(refs: readonly ImageRef[]): PrintPick[] {
  const seen = new Set<string>();
  const out: PrintPick[] = [];
  for (let i = refs.length - 1; i >= 0; i--) {
    const r = refs[i] as ImageRef;
    const blank = blankRef(r);
    const key = !blank && r.hash ? r.hash : `${r.item_id ?? ''}:${r.path ?? ''}:${i}`;
    const dedupe = `${trayOf(r)}:${key}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({ key, tray: trayOf(r), ref: r, blank });
  }
  const take = (t: Tray) => out.filter((p) => p.tray === t).slice(0, MAX_TRAY).reverse();
  return [...take('in'), ...take('out')];
}

export interface PrintPlace {
  key: string;
  tray: Tray;
  /** Centre of the picture on the desk top (slot space), and how high it lies. */
  x: number;
  y: number;
  z: number;
  /** Turn about y. */
  yaw: number;
  /** The picture's size, and the paper around it. */
  w: number;
  h: number;
  paperW: number;
  paperH: number;
  /** Its footprint on the desk (axis-aligned, conservative). */
  foot: Rect;
}

const jit = (h: number, shift: number) => (((h >>> shift) & 0xff) / 255) * 2 - 1;

/** The picture's size on the paper: its aspect, longest side `PRINT_LONG` (a blank one is a landscape card). */
export function printSize(ref: Pick<ImageRef, 'width' | 'height'>): { w: number; h: number } {
  const iw = ref.width && ref.width > 0 ? ref.width : 4;
  const ih = ref.height && ref.height > 0 ? ref.height : 3;
  const k = PRINT_LONG / Math.max(iw, ih);
  // Slivers (a 1 x 400 strip) keep a minimum thickness.
  return { w: Math.max(0.03, Math.round(iw * k * 1e4) / 1e4), h: Math.max(0.03, Math.round(ih * k * 1e4) / 1e4) };
}

/**
 * Where each print lies: in its tray, tossed (a turn and an offset from the worker's id and the image), the newest on
 * top. Deterministic, so a print stays where it fell when others come and go.
 */
export function layoutPrints(worker: string, picks: readonly PrintPick[]): PrintPlace[] {
  const out: PrintPlace[] = [];
  const count: Record<Tray, number> = { in: 0, out: 0 };
  for (const p of picks) {
    const n = count[p.tray]++;
    const r = TRAY_RECT[p.tray];
    const h = hash32(`print:${worker}:${p.key}`);
    const { w, h: ph } = printSize(p.ref);
    const paperW = w + 2 * PRINT_MARGIN;
    const paperH = ph + 2 * PRINT_MARGIN;
    const yaw = Math.round(jit(h, 0) * MAX_TURN * 1e3) / 1e3;
    const cx = (r.x0 + r.x1) / 2;
    const cz = (r.z0 + r.z1) / 2;
    // A little spread across the tray, later ones a little to the front: a scatter, not a grid.
    const x = Math.round((cx + jit(h, 8) * 0.055 + (n - 2) * 0.004) * 1e4) / 1e4;
    const z = Math.round((cz + jit(h, 16) * 0.003) * 1e4) / 1e4;
    const y = Math.round((DESK_H + TRAY_H + 0.0012 + n * PRINT_STEP) * 1e5) / 1e5;
    out.push({ key: p.key, tray: p.tray, x, y, z, yaw, w, h: ph, paperW, paperH, foot: footOf(x, z, paperW, paperH, yaw) });
  }
  return out;
}

/** A print's corners are on the tray? (tests: every print rests in its tray's rect, give or take a centimetre). */
export const TRAY_SLACK = 0.012;
export type SlotLike = Pick<DeskSlot, 'index' | 'yaw'>;
