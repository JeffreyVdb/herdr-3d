/**
 * Procedural office floor layout, a pure function of the desk count.
 *
 * Coordinates in metres: x runs west → east, z north → south, y up. The room
 * spans [0, width] × [0, depth]. You arrive from the elevator in the middle of
 * the south wall, facing north at the board wall; desk pods fill the middle,
 * the lounge takes the north-west corner and the filing cabinet the north-east.
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

export interface FloorLayout {
  desks: number;
  width: number;
  depth: number;
  height: number;
  slots: DeskSlot[];
  props: Prop[];
  /** Walls and the board partition, for rendering. */
  walls: Box3[];
  /** 2D obstacles for walking (walls, desks, solid props). */
  colliders: Rect[];
  /** Arrival point and yaw (0 = facing north, -z). */
  spawn: { x: number; z: number; yaw: number };
  /** Ceiling light panels. */
  lights: Vec2[];
  /** The lounge rug. */
  rug: Rect;
}

export const ROOM_HEIGHT = 3;
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

export function floorLayout(deskCount: number): FloorLayout {
  const desks = Math.max(0, Math.floor(deskCount));
  const { cols, rows } = podGrid(desks);
  const gridW = cols * PITCH_X - AISLE_X;
  const gridD = rows * PITCH_Z - AISLE_Z;
  const width = r3(Math.max(MIN_W, LOUNGE_W + MARGIN + gridW + MARGIN + EAST_W));
  const depth = r3(Math.max(MIN_D, NORTH_D + MARGIN + gridD + LOBBY_D));
  // Centre the grid in the space between the lounge and the east strip.
  const x0 = LOUNGE_W + MARGIN + (width - (LOUNGE_W + MARGIN + gridW + MARGIN + EAST_W)) / 2;
  const z0 = NORTH_D + MARGIN;
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
  const walls: Box3[] = [
    box(-T, 0, -T, width + T, H, 0), // north
    box(-T, 0, depth, width + T, H, depth + T), // south
    box(-T, 0, 0, 0, H, depth), // west
    box(width, 0, 0, width + T, H, depth), // east
    box(bx0, 0, bz - 0.1, bx0 + boardLen, 2.5, bz + 0.1), // board partition
  ];
  colliders.push(...walls.map(rectOf));

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
    colliders,
    spawn: { x: r3(width / 2), z: r3(depth - 1.3), yaw: 0 },
    lights,
    rug: { x0: 0.4, z0: 0.3, x1: 5.2, z1: 3.3 },
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
