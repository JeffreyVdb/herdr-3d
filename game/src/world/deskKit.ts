/**
 * M6b: what stands on a desk and where. Every desk has the office's
 * furniture: a monitor in the middle facing the chair, a wireless keyboard in
 * front of it with a mouse beside it, and a vertical laptop dock at the
 * desk's back corner on the pod's outer side (so the docked laptop's lid, and
 * its sticker, face the aisle), with two cables from the dock's end along the
 * back edge to the back of the monitor. A worker's own things sit on the
 * other side: a framed photo or two, the mug and the little plant the
 * walk-out packs, and a notebook with a pen or two in front of the dock.
 *
 * Which items, a small offset and turn, the frame and notebook colours come
 * from the desk index, so a row does not look copy-pasted. The front corner
 * on the items' side stays clear for the orchestrator's pass board, and the
 * one in front of the dock is where a freelancer's clipboard, tablet or
 * magnifier goes (freelancers bring no keepsakes: they have their briefcase).
 *
 * Slot space, as the desk art: origin on the floor under the seat, the worker
 * faces +z, the desk centre is at z = SEAT_OFFSET, its top at DESK_H. Pure:
 * vitest checks every desk of every desk count keeps its things on the
 * desktop and clear of each other.
 */

import { hash32 } from './derive';
import { DESK_D, DESK_H, DESK_W, SEAT_OFFSET, type DeskSlot, type Rect } from './layout';

export type DockSide = 1 | -1;

export interface V3 {
  x: number;
  y: number;
  z: number;
}

/** The desk top, in slot space. */
export const DESK_TOP_RECT: Rect = { x0: -DESK_W / 2, z0: SEAT_OFFSET - DESK_D / 2, x1: DESK_W / 2, z1: SEAT_OFFSET + DESK_D / 2 };

/**
 * The monitor: a 16:9 panel on a stand, its glass `glassW` × `glassH` in a
 * thin bezel, tilted back `tilt` (radians). The top `bandH` of the glass is
 * the status bar (its colour and word); the terminal is the rest.
 */
export const MONITOR = {
  glassW: 0.74,
  glassH: 0.4,
  bezel: 0.016,
  depth: 0.024,
  bandH: 0.09,
  /** Panel centre above the floor and along the desk. */
  y: DESK_H + 0.33,
  z: SEAT_OFFSET + 0.21,
  tilt: 0.08,
  /** The stand's foot plate (centred under the panel, a little behind it). */
  footW: 0.26,
  footD: 0.16,
  footZ: SEAT_OFFSET + 0.23,
} as const;

/** The wireless keyboard and the mouse. */
export const KEYBOARD = { w: 0.42, d: 0.135, h: 0.016, x: 0, z: SEAT_OFFSET - 0.15 } as const;
export const MOUSE = { w: 0.062, d: 0.104, h: 0.03, x: 0.3, z: SEAT_OFFSET - 0.14 } as const;

/**
 * The vertical dock, turned `turn` so the laptop's lid faces the aisle and a
 * little towards the chair; the laptop stands in it on its long edge.
 */
export const DOCK = { w: 0.085, len: 0.25, h: 0.045, plate: 0.006, x: 0.56, z: SEAT_OFFSET + 0.17, turn: 0.3 } as const;
export const LAPTOP = { len: 0.32, h: 0.225, t: 0.016, sit: DOCK.plate + 0.012 } as const;
/** The sticker on the laptop's lid (diameter). */
export const STICKER_D = 0.1;
/** Cable radius. */
export const CABLE_R = 0.0042;

/** Where a freelancer's desk item and the orchestrator's pass board go (dock side +1; mirrored with the dock). */
export const CREW_SPOTS = { item: { x: 0.5, z: SEAT_OFFSET - 0.17 }, passBoard: { x: -0.48, z: SEAT_OFFSET - 0.12 } } as const;
/**
 * M6c: the orchestrator's in-tray stands on the front corner on the dock's side (where the other workers keep a
 * notebook: an orchestrator has none), a little in from the desk's edge. Slot space with the dock on side +1.
 */
export const TRAY_SPOT = { x: 0.5, z: SEAT_OFFSET - 0.16 } as const;
export const TRAY_BOX = { w: 0.21, d: 0.17, h: 0.045 } as const;

/**
 * The front corners they take (dock side +1): the pass board's stays clear on
 * every desk; a freelancer's item goes where everyone else keeps a notebook.
 */
export const CREW_ITEM_ZONE: Rect = { x0: 0.34, z0: SEAT_OFFSET - 0.33, x1: 0.66, z1: SEAT_OFFSET - 0.01 };
export const PASS_BOARD_ZONE: Rect = { x0: -0.64, z0: SEAT_OFFSET - 0.24, x1: -0.32, z1: SEAT_OFFSET + 0.01 };

/** The box the walk-out packs, on the keyboard at the front of the desk (its base centre). */
export const PACK_BOX = { x: 0, y: DESK_H + KEYBOARD.h, z: SEAT_OFFSET - 0.16 } as const;

export type ItemKind = 'photo' | 'mug' | 'plant' | 'notebook';

export interface DeskItem {
  kind: ItemKind;
  /** Photos: 0 (the big one) or 1. */
  n: number;
  x: number;
  z: number;
  /** Turn about y (0: square to the desk, facing the chair). */
  yaw: number;
  /** Footprint on the desk (axis-aligned, conservative). */
  foot: Rect;
  /** Frame, notebook cover or mug colour. */
  tint: number;
  /** Size factor (the second photo is smaller). */
  size: number;
  /** Notebooks: pens on it (1 or 2); else 0. */
  pens: number;
}

export interface Placed {
  x: number;
  z: number;
  yaw: number;
  foot: Rect;
}

export interface DeskKit {
  /** Which way the dock is: +1 on the slot's +x side, -1 mirrored. */
  side: DockSide;
  monitor: Rect;
  keyboard: Placed;
  mouse: Placed;
  dock: Placed;
  /** The laptop standing in the dock (its footprint takes in the dock's). */
  laptop: Placed;
  /** The sticker's tilt on the lid. */
  stickerTilt: number;
  /** Two cables, dock end to the back of the monitor (points along each, slot space, y above the floor). */
  cables: V3[][];
  /** The worker's own things, in the order the walk-out packs them. */
  items: DeskItem[];
  /** Always clear: the orchestrator's pass board (see CREW_SPOTS). */
  keepClear: Rect[];
  /** A freelancer's desk item (it has no notebook). */
  crewItem: Rect;
}

/** Photo frame colours: sun, navy, tomato, leaf, white, oak. */
export const FRAME_TINTS = [0xffc233, 0x24406e, 0xe8413a, 0x12a26a, 0xfdfdfb, 0xb98552];
/** Notebook covers: navy, tomato, leaf, plum, sun. */
export const COVER_TINTS = [0x24406e, 0xe8413a, 0x1f8c8c, 0x7b4fc0, 0xf0b43c];
/** Mugs: white, sun, sky, blush. */
export const MUG_TINTS = [0xffffff, 0xffc233, 0x9fd3f0, 0xffb3c1];

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** The axis-aligned footprint of a `w` × `d` rectangle centred at (x, z), turned `yaw`. */
export function footOf(x: number, z: number, w: number, d: number, yaw: number): Rect {
  const c = Math.abs(Math.cos(yaw));
  const s = Math.abs(Math.sin(yaw));
  const hx = (w * c + d * s) / 2;
  const hz = (w * s + d * c) / 2;
  return { x0: r4(x - hx), z0: r4(z - hz), x1: r4(x + hx), z1: r4(z + hz) };
}

/** A footprint mirrored to the other side of the desk. */
function mirror(r: Rect, side: DockSide): Rect {
  return side === 1 ? r : { x0: -r.x1, z0: r.z0, x1: -r.x0, z1: r.z1 };
}

/**
 * The dock side of a slot: the pod's outer side (desks 0 and 2 of a pod are
 * on its west half, 1 and 3 on its east; south-facing desks are turned
 * round, so their slot +x is west).
 */
export function dockSide(slot: Pick<DeskSlot, 'index' | 'yaw'>): DockSide {
  const west = slot.index % 2 === 0;
  const flip = Math.cos(slot.yaw) < 0;
  return west !== flip ? -1 : 1;
}

/** Small per-desk jitter in [-1, 1] from bits of the desk's hash. */
const jit = (h: number, shift: number) => (((h >>> shift) & 0xff) / 255) * 2 - 1;

/** A desk's things (see the module comment); the desk art leaves the worker's own out on an empty desk and a freelancer's. */
export function deskKit(slot: Pick<DeskSlot, 'index' | 'yaw'>): DeskKit {
  const side = dockSide(slot);
  const h = hash32(`desk:${slot.index}`);
  const sx = (x: number) => r4(x * side);

  const M = MONITOR;
  const panelHalf = (M.glassW + 2 * M.bezel) / 2;
  const monitor: Rect = { x0: -panelHalf - 0.005, z0: M.footZ - M.footD / 2, x1: panelHalf + 0.005, z1: M.footZ + M.footD / 2 };
  const keyboard: Placed = { x: KEYBOARD.x, z: KEYBOARD.z, yaw: 0, foot: footOf(KEYBOARD.x, KEYBOARD.z, KEYBOARD.w, KEYBOARD.d, 0) };
  const mouseX = sx(MOUSE.x);
  const mouseYaw = -side * 0.12;
  const mouse: Placed = { x: mouseX, z: MOUSE.z, yaw: mouseYaw, foot: footOf(mouseX, MOUSE.z, MOUSE.w, MOUSE.d, mouseYaw) };

  // The dock: turned so the laptop's outward lid swings a little towards the chair (the same on every desk: it is furniture).
  const dockYaw = r4(side * DOCK.turn);
  const dx = sx(DOCK.x);
  const dock: Placed = { x: dx, z: DOCK.z, yaw: dockYaw, foot: footOf(dx, DOCK.z, DOCK.w, DOCK.len, dockYaw) };
  const laptopFoot = footOf(dx, DOCK.z, Math.max(DOCK.w, LAPTOP.t), LAPTOP.len, dockYaw);
  const laptop: Placed = { x: dx, z: DOCK.z, yaw: dockYaw, foot: laptopFoot };

  // Cables: out of the ports on the dock's back end, down onto the desk, along the back edge, up into the monitor.
  const back = { x: dx + Math.sin(dockYaw) * (DOCK.len / 2), z: DOCK.z + Math.cos(dockYaw) * (DOCK.len / 2) };
  const cables = [0, 1].map((k) => {
    const o = k * 0.013;
    const edge = SEAT_OFFSET + DESK_D / 2 - 0.016 - o;
    const px = back.x - side * (0.012 - k * 0.022);
    const inX = side * (0.045 + k * 0.03);
    const y0 = DESK_H + CABLE_R + 0.001;
    return [
      { x: px, y: DESK_H + 0.024 + k * 0.004, z: back.z - 0.004 },
      { x: px + side * 0.004, y: y0 + 0.006, z: back.z + 0.02 },
      { x: px - side * 0.02, y: y0, z: edge },
      { x: (px + inX) / 2, y: y0, z: edge + 0.002 },
      { x: inX + side * 0.05, y: y0, z: edge },
      { x: inX, y: y0 + 0.02, z: edge - 0.012 },
      { x: inX, y: DESK_H + 0.09, z: M.z + 0.05 },
      { x: inX * 0.8, y: DESK_H + 0.15, z: M.z + 0.035 },
    ].map((p) => ({ x: r4(p.x), y: r4(p.y), z: r4(p.z) }));
  });

  // The worker's things: which, and a little offset and turn, from the desk's hash.
  const items: DeskItem[] = [];
  const add = (kind: ItemKind, n: number, x0: number, z: number, w: number, d: number, yaw0: number, tint: number, size: number, bits: number, pens = 0) => {
    const x = sx(x0 + jit(h, bits) * 0.006);
    const zz = r4(z + jit(h, bits + 4) * 0.006);
    const yaw = r4(side * (yaw0 + jit(h, bits + 2) * 0.1));
    items.push({ kind, n, x, z: zz, yaw, foot: footOf(x, zz, w * size, d * size, yaw), tint, size, pens });
  };
  const two = (h & 1) === 1;
  const plant = ((h >>> 1) & 3) !== 0;
  const pens = ((h >>> 3) & 1) + 1;
  const frame = (k: number) => FRAME_TINTS[(h >>> (8 + k * 3)) % FRAME_TINTS.length] as number;
  // The big photo at the back, turned in towards the chair; a second, smaller one in front of it and out a little.
  add('photo', 0, -0.48, SEAT_OFFSET + 0.26, 0.135, 0.065, -0.3, frame(0), 1, 12);
  if (two) add('photo', 1, -0.625, SEAT_OFFSET + 0.08, 0.135, 0.065, -0.55, frame(1), 0.78, 16);
  add('mug', 0, -0.475, SEAT_OFFSET + 0.08, 0.1, 0.1, 0, MUG_TINTS[(h >>> 20) % MUG_TINTS.length] as number, 1, 20);
  if (plant) add('plant', 0, -0.63, SEAT_OFFSET + 0.27, 0.115, 0.115, 0, 0xffffff, 1, 24);
  add('notebook', 0, 0.49, SEAT_OFFSET - 0.17, 0.15, 0.2, 0.22, COVER_TINTS[(h >>> 26) % COVER_TINTS.length] as number, 1, 28, pens);

  return {
    side,
    monitor,
    keyboard,
    mouse,
    dock,
    laptop,
    stickerTilt: r4(jit(h, 5) * 0.14),
    cables,
    items,
    keepClear: [mirror(PASS_BOARD_ZONE, side)],
    crewItem: mirror(CREW_ITEM_ZONE, side),
  };
}

/** A crew spot of a desk (CREW_SPOTS mirrored with its dock). */
export function crewSpot(which: keyof typeof CREW_SPOTS, side: DockSide): { x: number; z: number } {
  const s = CREW_SPOTS[which];
  return { x: s.x * side, z: s.z };
}

export const overlaps = (a: Rect, b: Rect, gap = 0) => a.x0 < b.x1 + gap && a.x1 > b.x0 - gap && a.z0 < b.z1 + gap && a.z1 > b.z0 - gap;
export const inside = (a: Rect, b: Rect) => a.x0 >= b.x0 && a.x1 <= b.x1 && a.z0 >= b.z0 && a.z1 <= b.z1;

/**
 * The monitor's terminal area in slot space: its size, centre, the normal
 * (towards the chair) and up; `lift` moves it off the glass along the normal.
 * The status bar is the strip above it (`band`); `glass` is the whole panel,
 * bar and terminal area together (what a screen you sit at fills).
 */
export function monitorFrame(lift = 0): { width: number; height: number; center: V3; normal: V3; up: V3; band: { height: number; center: V3 }; glass: { height: number; center: V3 } } {
  const M = MONITOR;
  const c = Math.cos(M.tilt);
  const s = Math.sin(M.tilt);
  const up = { x: 0, y: c, z: s };
  const normal = { x: 0, y: s, z: -c };
  const face = M.depth / 2 + 0.0008 + lift;
  const at = (dy: number): V3 => ({ x: 0, y: r4(M.y + up.y * dy + normal.y * face), z: r4(M.z + up.z * dy + normal.z * face) });
  const termH = M.glassH - M.bandH;
  return {
    width: M.glassW,
    height: r4(termH),
    center: at(-M.glassH / 2 + termH / 2),
    normal,
    up,
    band: { height: M.bandH, center: at(M.glassH / 2 - M.bandH / 2) },
    glass: { height: M.glassH, center: at(0) },
  };
}
