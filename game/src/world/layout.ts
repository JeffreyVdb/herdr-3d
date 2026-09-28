import type { Solid, Support } from './collide';

/**
 * Procedural office floor layout, a pure function of the desk count.
 *
 * Coordinates in metres: x runs west → east, z north → south, y up. The room
 * spans [0, width] × [0, depth]. You arrive from the elevator in the middle of
 * the south wall, facing north at the board wall; desk pods fill the middle,
 * the lounge takes the north-west corner and the filing cabinet the north-east.
 *
 * Every floor of a building shares one outline (`outlineOf`): the room is at
 * least that big, the desk grid stays centred in it, and the windows and the
 * fire-escape door (west wall, south end) depend on the outline alone, so
 * they line up from floor to floor.
 *
 * The room is tall (#20): a mezzanine in the north-east corner carries your
 * corner office over the filing cabinet, with an open stair up the east wall.
 */

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface Box3 {
  min: [number, number, number];
  max: [number, number, number];
}

export interface Vec2 {
  x: number;
  z: number;
}

export interface DeskSlot {
  index: number;
  pod: number;
  /** Desk top centre. */
  desk: Vec2;
  /** Where the worker sits (and the chair stands when pulled out). */
  seat: Vec2;
  /** Where the chair sits when pushed in (empty desk). */
  chairIn: Vec2;
  /** Worker yaw: 0 faces south (+z), π faces north. */
  yaw: number;
}

export type PropKind =
  | 'board.issues'
  | 'board.prs'
  | 'board.services'
  | 'whiteboard'
  | 'tv'
  | 'filing'
  | 'lounge'
  | 'dropzone'
  | 'elevator';

export interface Prop {
  id: PropKind;
  label: string;
  /** Milestone that makes it do something, shown in the HUD. */
  milestone: string;
  box: Box3;
  /** Blocks walking (wall-mounted props do not). */
  solid: boolean;
}

export type Side = 'north' | 'south' | 'east' | 'west';

/**
 * A hole in an outer wall: `u0`..`u1` along the wall (x on the north and south
 * walls, z on the east and west ones), `y0`..`y1` above the floor.
 */
export interface Opening {
  wall: Side;
  kind: 'window' | 'door';
  u0: number;
  u1: number;
  y0: number;
  y1: number;
}

export interface Outline {
  width: number;
  depth: number;
}

export interface FloorLayout {
  desks: number;
  width: number;
  depth: number;
  height: number;
  slots: DeskSlot[];
  props: Prop[];
  /** Walls (north, south, west, east, whole) and the board partition, for rendering and line of sight. */
  walls: Box3[];
  /** Windows and the fire-escape door, the same on every floor of an outline. */
  openings: Opening[];
  /** The fire-escape door in the west wall (z range). */
  fireDoor: { z0: number; z1: number; height: number };
  /** Where the desk grid is centred (between the lounge, the east strip, the north strip and the board wall). */
  deskArea: Rect;
  /** Footprint of the board partition (the last of `walls`): the floor's lobby is south of it. */
  boardWall: Rect;
  /** 2D obstacles for walking (walls with the fire-escape doorway open, desks, solid props). */
  colliders: Rect[];
  /** Arrival point and yaw (0 = facing north, -z). */
  spawn: { x: number; z: number; yaw: number };
  /** Ceiling light panels. */
  lights: Vec2[];
  /** The lounge rug. */
  rug: Rect;
  /** The corner office on its mezzanine (#20). */
  mezzanine: Mezzanine;
}

/** A stair tread: its footprint and the height of its top. */
export interface Step {
  rect: Rect;
  y: number;
}

/**
 * The mezzanine in the north-east corner and the glass office on it, in the
 * floor's own coordinates (y above this floor). Its floor blocks nothing
 * below it; its posts and the stair do (`solids`), and its glass walls block
 * walking on top but not look-at.
 */
export interface Mezzanine {
  /** Footprint: the office on top. */
  rect: Rect;
  /** Top of its floor, and the underside of its slab (the headroom below). */
  y: number;
  under: number;
  /** Post centres (square posts POST_W wide), clear of desks and aisles. */
  posts: Vec2[];
  /** The open stair up the east wall: x range, top (at the office door) and bottom z, treads bottom to top. */
  stair: { x0: number; x1: number; top: number; bottom: number; rise: number; treads: Step[] };
  /** Glass walls on the open sides (south, west), from the mezzanine floor up GLASS_H. */
  glass: Box3[];
  /** The glass door in the south wall, at the head of the stair: x range. */
  door: { x0: number; x1: number; z: number; height: number };
  /** Your desk: the seat (floor under the chair), the desk centre (its long side runs north-south), and the desk-art yaw. */
  desk: { seat: Vec2; desk: Vec2; yaw: number };
  /** A potted plant in the office's back corner. */
  plant: Vec2;
  /** Sitting at your desk: where the walker goes and which way it looks (at the floor, over the glass). */
  sit: { x: number; z: number; yaw: number; pitch: number };
  /** The slab: blocks look-at from above and below (glass does not). */
  slab: Box3;
  /** Walking: the mezzanine floor and the treads (supports), posts, stair side, glass and desk (solids). */
  supports: Support[];
  solids: Solid[];
}

/** Floor to ceiling: tall enough for the mezzanine with standing room on it and under it (#20). */
export const ROOM_HEIGHT = 6.5;
export const WALL_T = 0.2;
export const DESK_W = 1.4;
export const DESK_D = 0.7;
export const DESK_H = 0.62;
export const SEAT_OFFSET = 0.85; // desk centre → seat, along the facing axis
export const CHAIR_IN_OFFSET = 0.42;
export const EYE_HEIGHT = 1.55;

const POD_W = 2 * DESK_W;
const POD_D = 2 * DESK_D + 2 * (SEAT_OFFSET + 0.3);
const AISLE_X = 1.8;
const AISLE_Z = 1.6;
const PITCH_X = POD_W + AISLE_X;
const PITCH_Z = POD_D + AISLE_Z;
const LOUNGE_W = 6;
const EAST_W = 2.4;
const NORTH_D = 1.6;
const LOBBY_D = 6.2;
const MARGIN = 1;
const MIN_W = 18;
const MIN_D = 14;
const BOARD_WALL_Z = 4.3; // distance of the board partition from the south wall
/** Fire-escape door: 1.2 m wide, its south jamb this far from the south wall. */
export const FIRE_DOOR_W = 1.2;
const FIRE_DOOR_S = 1.6;
export const DOOR_H = 2.3;
/** Windows run the full height of the room, so the outside shows from the mezzanine too. */
export const SILL = 0.6;
export const HEAD = ROOM_HEIGHT - 0.55;

/** The mezzanine: about 7 x 5 m in the north-east corner, its floor at 3 m on a 0.25 m slab. */
export const MEZZ_W = 7;
export const MEZZ_D = 5;
export const MEZZ_Y = 3;
export const MEZZ_SLAB = 0.25;
/** Glass walls: this tall above the mezzanine floor. */
export const GLASS_H = 2.6;
export const POST_W = 0.24;
/** The stair: this wide along the east wall, 17 risers up to the mezzanine, 0.28 m treads. */
export const STAIR_W = 1.2;
export const STAIR_RISERS = 17;
export const STAIR_TREAD = 0.28;
const STAIR_GAP = 0.05; // stair to the east wall
const STAIR_RAIL = 0.07;
/** Room kept round a post: to desks and chairs, props and the stair. */
const POST_CLEAR = 0.5;

const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Box3 => ({
  min: [x0, y0, z0],
  max: [x1, y1, z1],
});
const rectOf = (b: Box3): Rect => ({ x0: b.min[0], z0: b.min[2], x1: b.max[0], z1: b.max[2] });
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Pod grid for a desk count: 4 desks per pod, roughly 1.4:1 wide. */
export function podGrid(desks: number): { pods: number; cols: number; rows: number } {
  const pods = Math.max(1, Math.ceil(desks / 4));
  const cols = Math.max(1, Math.min(8, Math.round(Math.sqrt(pods * 1.4))));
  return { pods, cols, rows: Math.ceil(pods / cols) };
}

/** Room size a desk count needs on its own. */
function naturalSize(desks: number): Outline & { gridW: number; gridD: number; cols: number } {
  const { cols, rows } = podGrid(desks);
  const gridW = cols * PITCH_X - AISLE_X;
  const gridD = rows * PITCH_Z - AISLE_Z;
  return {
    width: r3(Math.max(MIN_W, LOUNGE_W + MARGIN + gridW + MARGIN + EAST_W)),
    depth: r3(Math.max(MIN_D, NORTH_D + MARGIN + gridD + LOBBY_D)),
    gridW,
    gridD,
    cols,
  };
}

/** A building's outline: big enough for its biggest floor in each direction (the unassigned lot too). */
export function outlineOf(deskCounts: readonly number[]): Outline {
  let width = MIN_W;
  let depth = MIN_D;
  for (const n of deskCounts) {
    const s = naturalSize(Math.max(0, Math.floor(n)));
    width = Math.max(width, s.width);
    depth = Math.max(depth, s.depth);
  }
  return { width, depth };
}

/**
 * #20: look-at reach while you are up on the mezzanine, looking down over the floor:
 * the room's diagonal, so every desk of the floor is in reach wherever you stand up there.
 */
export function overlookReach(L: Pick<FloorLayout, 'width' | 'depth' | 'height'>): number {
  return Math.hypot(L.width, L.depth, L.height);
}

/** Windows and the fire-escape door of an outline: the same on every floor that shares it. */
export function openingsFor(width: number, depth: number): Opening[] {
  const out: Opening[] = [];
  const win = (wall: Side, c: number, w: number) => out.push({ wall, kind: 'window', u0: r3(c - w / 2), u1: r3(c + w / 2), y0: SILL, y1: HEAD });
  // North: over the lounge sofa, and high up in the corner office on the mezzanine.
  win('north', 2.8, 3.6);
  out.push({ wall: 'north', kind: 'window', u0: r3(width - 4.6), u1: r3(width - 2.4), y0: MEZZ_Y + 0.6, y1: HEAD });
  // East: along the wall, clear of the filing cabinet.
  for (let z = 3.6; z + 1.1 < depth - 0.9; z += 3.2) win('east', z, 2.2);
  // South, either side of the elevator (and clear of the drop zone on its east).
  for (let x = 2.2; x + 1.1 < width / 2 - 1.9; x += 3.2) win('south', x, 2.2);
  for (let x = width - 2.2; x - 1.1 > width / 2 + 4.1; x -= 3.2) win('south', x, 2.2);
  // West: onto the fire escape, between the coffee counter and the door.
  for (let z = depth - FIRE_DOOR_S - FIRE_DOOR_W - 1.9; z - 1.1 > 5.2; z -= 3.2) win('west', z, 2.2);
  const dz1 = depth - FIRE_DOOR_S;
  out.push({ wall: 'west', kind: 'door', u0: r3(dz1 - FIRE_DOOR_W), u1: r3(dz1), y0: 0, y1: DOOR_H });
  return out;
}

export function floorLayout(deskCount: number, outline?: Outline): FloorLayout {
  const desks = Math.max(0, Math.floor(deskCount));
  const nat = naturalSize(desks);
  const { cols, gridW, gridD } = nat;
  const width = r3(Math.max(nat.width, outline?.width ?? 0));
  const depth = r3(Math.max(nat.depth, outline?.depth ?? 0));
  // Centre the grid between the lounge and the east strip, and between the
  // north strip and the lobby in front of the board wall.
  const deskArea: Rect = { x0: LOUNGE_W + MARGIN, z0: NORTH_D + MARGIN, x1: r3(width - MARGIN - EAST_W), z1: r3(depth - LOBBY_D) };
  const x0 = deskArea.x0 + (deskArea.x1 - deskArea.x0 - gridW) / 2;
  const z0 = deskArea.z0 + (deskArea.z1 - deskArea.z0 - gridD) / 2;
  const H = ROOM_HEIGHT;

  const slots: DeskSlot[] = [];
  const colliders: Rect[] = [];
  for (let i = 0; i < desks; i++) {
    const pod = Math.floor(i / 4);
    const k = i % 4;
    const cx = x0 + (pod % cols) * PITCH_X + POD_W / 2;
    const cz = z0 + Math.floor(pod / cols) * PITCH_Z + POD_D / 2;
    const north = k < 2;
    const dx = k % 2 === 0 ? -DESK_W / 2 : DESK_W / 2;
    const dz = north ? -DESK_D / 2 : DESK_D / 2;
    const out = north ? -1 : 1; // direction from the pod centre towards the worker
    const desk = { x: r3(cx + dx), z: r3(cz + dz) };
    slots.push({
      index: i,
      pod,
      desk,
      seat: { x: desk.x, z: r3(desk.z + out * SEAT_OFFSET) },
      chairIn: { x: desk.x, z: r3(desk.z + out * CHAIR_IN_OFFSET) },
      yaw: north ? 0 : Math.PI,
    });
    colliders.push({ x0: desk.x - DESK_W / 2, z0: desk.z - DESK_D / 2, x1: desk.x + DESK_W / 2, z1: desk.z + DESK_D / 2 });
  }

  const T = WALL_T;
  const bz = depth - BOARD_WALL_Z;
  const boardLen = Math.min(12, width - 6);
  const bx0 = width / 2 - boardLen / 2;
  const boardWall = box(bx0, 0, bz - 0.1, bx0 + boardLen, 2.5, bz + 0.1);
  const walls: Box3[] = [
    box(-T, 0, -T, width + T, H, 0), // north
    box(-T, 0, depth, width + T, H, depth + T), // south
    box(-T, 0, 0, 0, H, depth), // west
    box(width, 0, 0, width + T, H, depth), // east
    boardWall, // board partition
  ];
  const openings = openingsFor(width, depth);
  const door = openings.find((o) => o.kind === 'door') as Opening;
  // The west wall walks as two pieces either side of the fire-escape doorway.
  colliders.push(
    ...walls.filter((_, i) => i !== 2).map(rectOf),
    { x0: -T, z0: 0, x1: 0, z1: door.u0 },
    { x0: -T, z0: door.u1, x1: 0, z1: depth },
  );

  const boardW = (boardLen - 0.8) / 3;
  const board = (i: number) => box(bx0 + 0.2 + i * (boardW + 0.2), 0.8, bz + 0.1, bx0 + 0.2 + i * (boardW + 0.2) + boardW, 2.3, bz + 0.16);
  const gridMid = x0 + gridW / 2;
  const props: Prop[] = [
    { id: 'board.issues', label: 'Issues board', milestone: 'M7', box: board(0), solid: false },
    { id: 'board.prs', label: 'Pull requests board', milestone: 'M7', box: board(1), solid: false },
    { id: 'board.services', label: 'Services board', milestone: 'M12', box: board(2), solid: false },
    { id: 'whiteboard', label: 'Whiteboard', milestone: 'M13', box: box(gridMid - gridW * 0.25 - 1.6, 0.9, 0, gridMid - gridW * 0.25 + 1.6, 2.2, 0.08), solid: false },
    { id: 'tv', label: 'Screen-share TV', milestone: 'M13', box: box(gridMid + gridW * 0.22 - 1.1, 1.0, 0, gridMid + gridW * 0.22 + 1.1, 2.25, 0.12), solid: false },
    { id: 'filing', label: 'Filing cabinet', milestone: 'M9', box: box(width - 1.0, 0, 0.6, width - 0.3, 1.3, 1.7), solid: true },
    { id: 'lounge', label: 'Lounge', milestone: 'M8', box: box(0.6, 0, 0.45, 3.8, 0.85, 1.35), solid: true },
    { id: 'dropzone', label: 'Drop Zone inbox', milestone: 'M11', box: box(width / 2 + 2.4, 0, depth - 1.5, width / 2 + 3.6, 0.95, depth - 0.8), solid: true },
    { id: 'elevator', label: 'Elevator', milestone: 'M3', box: box(width / 2 - 1.1, 0, depth - 0.12, width / 2 + 1.1, 2.4, depth), solid: false },
  ];
  // Lounge furniture beyond the sofa: coffee table and the coffee counter.
  colliders.push(...props.filter((p) => p.solid).map((p) => rectOf(p.box)));
  colliders.push({ x0: 1.5, z0: 2.1, x1: 2.9, z1: 2.8 }, { x0: 0, z0: 3.4, x1: 0.65, z1: 4.8 });

  const lights: Vec2[] = [];
  const nx = Math.max(2, Math.round(width / 4.5));
  const nz = Math.max(2, Math.round(depth / 4.5));
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) lights.push({ x: r3(((i + 0.5) * width) / nx), z: r3(((j + 0.5) * depth) / nz) });

  return {
    desks,
    width,
    depth,
    height: H,
    slots,
    props,
    walls,
    openings,
    fireDoor: { z0: door.u0, z1: door.u1, height: DOOR_H },
    deskArea,
    boardWall: rectOf(boardWall),
    colliders,
    spawn: { x: r3(width / 2), z: r3(depth - 1.3), yaw: 0 },
    lights,
    rug: { x0: 0.4, z0: 0.3, x1: 5.2, z1: 3.3 },
    mezzanine: mezzanineFor(width, depth, slots, props, deskArea, {
      x0,
      x1: x0 + gridW,
      rows: desks ? Array.from({ length: Math.ceil(Math.ceil(desks / 4) / cols) }, (_, r) => ({ z0: z0 + r * PITCH_Z, z1: z0 + r * PITCH_Z + POD_D })) : [],
    }),
  };
}

const overlapsRect = (a: Rect, b: Rect) => a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;
const grow = (r: Rect, d: number): Rect => ({ x0: r.x0 - d, z0: r.z0 - d, x1: r.x1 + d, z1: r.z1 + d });

/** Footprint of a desk slot: the desk and its chair (pulled out, a worker in it). */
export function slotRect(s: DeskSlot): Rect {
  return {
    x0: s.desk.x - DESK_W / 2,
    x1: s.desk.x + DESK_W / 2,
    z0: Math.min(s.desk.z - DESK_D / 2, s.seat.z - 0.3),
    z1: Math.max(s.desk.z + DESK_D / 2, s.seat.z + 0.3),
  };
}

/**
 * The corner office: the mezzanine over the north-east corner, the open stair
 * up the east wall from the south to its door, the glass walls, your desk.
 * Posts go where the floor below is free: at the open corner when that is
 * clear of desks, chairs and the aisles people walk (a pod row's x-aisles
 * are fine, the z-aisles in front of the chairs are not); otherwise one along
 * each open edge, and the edge beams carry the corner.
 */
function mezzanineFor(
  width: number,
  depth: number,
  slots: readonly DeskSlot[],
  props: readonly Prop[],
  deskArea: Rect,
  grid: { x0: number; x1: number; rows: Array<{ z0: number; z1: number }> },
): Mezzanine {
  const rect: Rect = { x0: r3(width - MEZZ_W), z0: 0, x1: width, z1: MEZZ_D };
  const y = MEZZ_Y;
  const under = r3(MEZZ_Y - MEZZ_SLAB);
  const rise = MEZZ_Y / STAIR_RISERS;
  const sx1 = r3(width - STAIR_GAP);
  const sx0 = r3(sx1 - STAIR_W);
  const n = STAIR_RISERS - 1;
  const bottom = r3(rect.z1 + n * STAIR_TREAD);
  const treads: Step[] = [];
  for (let j = 1; j <= n; j++) {
    treads.push({ rect: { x0: sx0, x1: sx1, z0: r3(rect.z1 + (n - j) * STAIR_TREAD), z1: r3(rect.z1 + (n - j + 1) * STAIR_TREAD) }, y: r3(j * rise) });
  }
  const stairRect: Rect = { x0: sx0 - STAIR_RAIL, z0: rect.z1, x1: sx1, z1: bottom };

  // Posts: free of desks and chairs, props and the stair, and out of the z-aisles in front of the chairs.
  const avoid: Rect[] = [...slots.map(slotRect), ...props.map((p) => ({ x0: p.box.min[0], z0: p.box.min[2], x1: p.box.max[0], z1: p.box.max[2] })), stairRect];
  const h = POST_W / 2;
  const top = grid.rows[0]?.z0 ?? Infinity;
  const free = (p: Vec2) => {
    const r = { x0: p.x - h, z0: p.z - h, x1: p.x + h, z1: p.z + h };
    if (avoid.some((a) => overlapsRect(grow(r, POST_CLEAR), a))) return false;
    if (grid.rows.length && p.x > grid.x0 - POST_CLEAR - h && p.x < grid.x1 + POST_CLEAR + h) {
      // In the grid's x span: inside a pod row (so in an x-aisle), or well north of the first row's chairs.
      return p.z < top - 0.9 || grid.rows.some((row) => p.z > row.z0 + 0.15 && p.z < row.z1 - 0.15);
    }
    return true;
  };
  const inset = 0.15;
  const corner = { x: r3(rect.x0 + inset), z: r3(rect.z1 - inset) };
  const posts: Vec2[] = [];
  if (free(corner)) posts.push(corner);
  else {
    for (let x = corner.x + 0.05; x < sx0 - 0.3; x += 0.05)
      if (free({ x, z: corner.z })) {
        posts.push({ x: r3(x), z: corner.z });
        break;
      }
    for (let z = corner.z - 0.05; z > 0.3; z -= 0.05)
      if (free({ x: corner.x, z })) {
        posts.push({ x: corner.x, z: r3(z) });
        break;
      }
  }

  // Glass on the open sides; the door at the head of the stair.
  const gy1 = y + GLASS_H;
  const glass: Box3[] = [box(rect.x0, y, rect.z1 - 0.05, sx0 - STAIR_RAIL, gy1, rect.z1), box(rect.x0, y, rect.z0, rect.x0 + 0.05, gy1, rect.z1 - 0.05)];
  const door = { x0: sx0, x1: sx1, z: rect.z1, height: DOOR_H };

  // Your desk stands by the west glass, facing into the office (your back to the glass, as a
  // corner office has it). Sitting down swivels the chair round: you look out over the floor from
  // right at the glass, where the mezzanine's edge hides the least of it.
  const seat = { x: r3(rect.x0 + 0.65), z: r3(rect.z1 - 2.1) };
  const deskC = { x: r3(seat.x + SEAT_OFFSET), z: seat.z };
  const deskR: Rect = { x0: deskC.x - DESK_D / 2, z0: deskC.z - DESK_W / 2, x1: deskC.x + DESK_D / 2, z1: deskC.z + DESK_W / 2 };
  const look = { x: (deskArea.x0 + deskArea.x1) / 2 - seat.x, z: (deskArea.z0 + deskArea.z1) / 2 - seat.z };
  const sit = { x: seat.x, z: seat.z, yaw: r3(Math.atan2(-look.x, -look.z)), pitch: -0.45 };

  const plant = { x: r3(rect.x0 + 0.5), z: 0.5 };

  const supports: Support[] = [{ ...rect, y }, ...treads.map((t) => ({ ...t.rect, y: t.y }))];
  const solid = (r: Rect, y0: number, y1: number): Solid => ({ x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1, y0, y1 });
  const solids: Solid[] = [
    ...posts.map((p) => solid({ x0: p.x - h, z0: p.z - h, x1: p.x + h, z1: p.z + h }, 0, under)),
    // The stair's open side (stringer and railing), and the low part underneath it you'd walk your head into.
    solid({ x0: sx0 - STAIR_RAIL, z0: rect.z1, x1: sx0, z1: bottom }, 0, y + 1),
    solid({ x0: sx0, z0: rect.z1, x1: sx1, z1: bottom - STAIR_TREAD }, 0, 0.5),
    ...glass.map((g) => solid({ x0: g.min[0], z0: g.min[2], x1: g.max[0], z1: g.max[2] }, y, gy1)),
    solid(deskR, y, y + 1.1),
    solid({ x0: plant.x - 0.25, z0: plant.z - 0.25, x1: plant.x + 0.25, z1: plant.z + 0.25 }, y, y + 1.2),
  ];
  return {
    rect,
    y,
    under,
    posts,
    stair: { x0: sx0, x1: sx1, top: rect.z1, bottom, rise: r3(rise), treads },
    glass,
    door,
    desk: { seat, desk: deskC, yaw: Math.PI / 2 },
    plant,
    sit,
    slab: box(rect.x0, under, rect.z0, rect.x1, y, rect.z1),
    supports,
    solids,
  };
}

/** Pick volumes of a desk slot: the desk (with laptop) and the seated worker. */
export function slotBoxes(s: DeskSlot): { desk: Box3; seat: Box3; plus: Box3 } {
  return {
    desk: box(s.desk.x - DESK_W / 2, 0, s.desk.z - DESK_D / 2, s.desk.x + DESK_W / 2, DESK_H + 0.3, s.desk.z + DESK_D / 2),
    seat: box(s.seat.x - 0.32, 0.3, s.seat.z - 0.32, s.seat.x + 0.32, 1.4, s.seat.z + 0.32),
    plus: box(s.desk.x - 0.25, 1.05, s.desk.z - 0.25, s.desk.x + 0.25, 1.6, s.desk.z + 0.25),
  };
}

/** Walking obstacle of an occupied seat. */
export function seatRect(s: DeskSlot): Rect {
  return { x0: s.seat.x - 0.3, z0: s.seat.z - 0.3, x1: s.seat.x + 0.3, z1: s.seat.z + 0.3 };
}

/**
 * A wall box cut around its openings (`u` along axis 0 = x or 2 = z, as in
 * `Opening`): the pieces left standing, left to right, sill and lintel pieces
 * under and over each hole.
 */
export function wallPieces(b: Box3, axis: 0 | 2, holes: ReadonlyArray<{ u0: number; u1: number; y0: number; y1: number }>): Box3[] {
  const out: Box3[] = [];
  const piece = (u0: number, u1: number, y0: number, y1: number) => {
    if (u1 - u0 < 1e-6 || y1 - y0 < 1e-6) return;
    const min: [number, number, number] = [b.min[0], y0, b.min[2]];
    const max: [number, number, number] = [b.max[0], y1, b.max[2]];
    min[axis] = u0;
    max[axis] = u1;
    out.push({ min, max });
  };
  let u = b.min[axis];
  const y0 = b.min[1];
  const y1 = b.max[1];
  for (const h of [...holes].sort((a, c) => a.u0 - c.u0)) {
    piece(u, h.u0, y0, y1);
    piece(h.u0, h.u1, y0, Math.max(y0, h.y0));
    piece(h.u0, h.u1, Math.min(y1, h.y1), y1);
    u = h.u1;
  }
  piece(u, b.max[axis], y0, y1);
  return out;
}
