/**
 * #98: the desk monitors' mascots, original pixel art drawn once at load into one sprite sheet (pure: pixels in, no
 * canvas, so vitest can check every frame). An orange crab for Claude workers, a white and teal cloud with a `>_` face
 * for Codex workers; a row per mascot and pose, `FRAMES` frames each, `SPRITE` pixels square. The monitor's shader picks
 * the row (an instance attribute) and the frame (a time uniform and the desk's phase): no canvas is drawn after load.
 *
 * Coordinates are a cell's pixels, y down. A pose sets the rig (where the body, the eyes and the claws or arms are) and
 * draws its prop; the body and its prop each get a one-pixel outline of their own, so they read on the dark screen.
 */

import { MASCOTS, POSES, type Mascot, type Pose } from '../world/activity';

export const SPRITE = 32;
export const FRAMES = 6;
/** Columns in the sheet (`FRAMES` used) and rows (mascots × poses, padded to a power of two). */
export const SPRITE_COLS = 8;
export const SPRITE_ROWS = 32;

/** The sheet row of a mascot's pose (top row 0). */
export const spriteRow = (m: Mascot, p: Pose): number => MASCOTS.indexOf(m) * POSES.length + POSES.indexOf(p);

/** Frames a second per pose (Thinking's dots take a second to cycle; resting breathes slowly). */
export const POSE_FPS: Record<Pose, number> = {
  thinking: 3,
  replying: 5,
  writing: 8,
  investigating: 4,
  testing: 5,
  building: 6,
  shipping: 5,
  researching: 5,
  delegating: 5,
  planning: 3,
  waiting: 4,
  image: 2,
  working: 4,
  rest: 2,
};

const CRAB = { body: 0xec7a3e, hi: 0xffa76b, shade: 0xc25a27, leg: 0xa9461d, line: 0x5e220d };
const CLOUD = { body: 0xf1f9fa, hi: 0xffffff, shade: 0xbfe4e1, line: 0x13817a, face: 0x1c2540 };
const EYE = 0xffffff;
const PUPIL = 0x1c2540;
/** Props' outline, and their shared colours. */
const INK = 0x0b1020;
const C = {
  paper: 0xfbf7ec,
  glass: 0xdcebff,
  steel: 0x8f97a8,
  steelHi: 0xc3cad6,
  wood: 0xb98552,
  woodDark: 0x8a5a32,
  sun: 0xffc233,
  sky: 0x9fd3f0,
  leaf: 0x7ccf6a,
  ocean: 0x3b8fe0,
  lime: 0x7ad151,
  limeDeep: 0x4fae35,
  bubble: 0xd9f7b8,
  card: 0xc8924f,
  cardDark: 0xa8743a,
  tape: 0xead7a6,
  dot: 0x1c2540,
  dotOff: 0xb9c3dc,
  bubbleLine: 0x8d97b5,
  zzz: 0xc9d2e6,
  spark: 0xfff1a8,
};

/** One cell's pixels: 0 is empty, else 0xff000000 | rgb. */
class Layer {
  readonly px = new Uint32Array(SPRITE * SPRITE);

  set(x: number, y: number, rgb: number): void {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= SPRITE || iy >= SPRITE) return;
    this.px[iy * SPRITE + ix] = (0xff000000 | rgb) >>> 0;
  }

  get(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= SPRITE || y >= SPRITE) return 0;
    return this.px[y * SPRITE + x] ?? 0;
  }

  clear(x: number, y: number): void {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix >= 0 && iy >= 0 && ix < SPRITE && iy < SPRITE) this.px[iy * SPRITE + ix] = 0;
  }

  rect(x: number, y: number, w: number, h: number, rgb: number): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, rgb);
  }

  /** Pixels whose centre lies in the ellipse; `shade` colours its lower rows, `hi` its upper left. */
  ellipse(cx: number, cy: number, rx: number, ry: number, rgb: number, o: { hi?: number; shade?: number } = {}): void {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const u = (x + 0.5 - cx) / rx;
        const v = (y + 0.5 - cy) / ry;
        if (u * u + v * v > 1) continue;
        let c = rgb;
        if (o.shade !== undefined && v > 0.45) c = o.shade;
        else if (o.hi !== undefined && v < -0.35 && u < 0.2) c = o.hi;
        this.set(x, y, c);
      }
  }

  disc(cx: number, cy: number, r: number, rgb: number): void {
    this.ellipse(cx, cy, r, r, rgb);
  }

  line(x0: number, y0: number, x1: number, y1: number, rgb: number): void {
    const n = Math.max(1, Math.round(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    for (let i = 0; i <= n; i++) this.set(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, rgb);
  }

  /** A one-pixel outline round what is drawn (4-neighbours). */
  outline(rgb: number): this {
    const was = this.px.slice();
    const at = (x: number, y: number) => (x < 0 || y < 0 || x >= SPRITE || y >= SPRITE ? 0 : (was[y * SPRITE + x] ?? 0));
    for (let y = 0; y < SPRITE; y++)
      for (let x = 0; x < SPRITE; x++) {
        if (at(x, y)) continue;
        if (at(x - 1, y) || at(x + 1, y) || at(x, y - 1) || at(x, y + 1)) this.px[y * SPRITE + x] = (0xff000000 | rgb) >>> 0;
      }
    return this;
  }

  /** `top` drawn over this one. */
  over(top: Layer): this {
    top.px.forEach((c, i) => {
      if (c) this.px[i] = c;
    });
    return this;
  }

  /** A small pixel map (`#` sets `rgb`, anything else is skipped) at x, y. */
  map(x: number, y: number, rows: readonly string[], rgb: number): void {
    rows.forEach((r, j) => [...r].forEach((ch, i) => ch === '#' && this.set(x + i, y + j, rgb)));
  }
}

type P2 = [number, number];

/** Where a pose puts the mascot: body offset, eyes, the two claws (Claude) or arms (Codex), a lifted foot. */
interface Rig {
  dx: number;
  dy: number;
  eyes: 'open' | 'closed' | 'up';
  /** Pupils to the left (-1), ahead (0) or right (1). */
  look: -1 | 0 | 1;
  /** Claw / arm centres, relative to the body centre; null: the default raised pair. */
  armL: P2 | null;
  armR: P2 | null;
  /** The pincers open (the crab), or a little smile (both): what a pose says with its face. */
  open: boolean;
  mouth: 'smile' | 'open' | 'flat';
  tap: boolean;
  /** The claws (arms) in front of the body (over it: typing, a claw at the chin), else behind it. */
  front: boolean;
}

const rig = (): Rig => ({ dx: 0, dy: 0, eyes: 'open', look: 0, armL: null, armR: null, open: true, mouth: 'smile', tap: false, front: false });
/** Body centres in the cell, before the rig's offset. */
const CENTRE: Record<Mascot, P2> = { crab: [16, 21], cloud: [16, 19] };
/** A cell point as a claw / arm position (relative to the rigged body's centre). */
const at = (r: Rig, m: Mascot, x: number, y: number): P2 => [x - (CENTRE[m][0] + r.dx), y - (CENTRE[m][1] + r.dy)];

function crab(r: Rig): Layer {
  const cx = CENTRE.crab[0] + r.dx;
  const cy = CENTRE.crab[1] + r.dy;
  const legs = new Layer();
  for (const s of [-1, 1])
    for (let k = 0; k < 3; k++) {
      const x0 = cx + s * (3 + k * 2.2);
      const lift = r.tap && s === -1 && k === 2 ? 2 : 0;
      legs.line(x0, cy + 3, x0 + s * 2, cy + 6 - lift, CRAB.leg);
    }
  const body = new Layer();
  body.ellipse(cx, cy, 8, 5, CRAB.body, { hi: CRAB.hi, shade: CRAB.shade });
  // Eyes on stalks.
  for (const ex of [cx - 4, cx + 2]) {
    if (r.eyes === 'closed') {
      body.set(ex + 0.5, cy - 5, CRAB.body);
      continue;
    }
    body.line(ex + 0.5, cy - 5, ex + 0.5, cy - 6, CRAB.body);
    body.rect(ex, cy - 8, 2, 2, EYE);
  }
  body.outline(CRAB.line);
  for (const ex of [cx - 4, cx + 2]) {
    if (r.eyes === 'closed') body.rect(ex, cy - 6, 2, 1, CRAB.line);
    else body.set(ex + (r.look > 0 ? 1 : r.look < 0 ? 0 : ex < cx ? 1 : 0), cy - (r.eyes === 'up' ? 8 : 7), PUPIL);
  }
  face(body, cx, cy + 1, r.mouth, CRAB.line);
  // The arms and claws, behind the body or (outlined on their own, so a claw held over it still reads) in front.
  const arms = new Layer();
  const L: P2 = r.armL ?? [-10, -6];
  const R: P2 = r.armR ?? [10, -6];
  for (const [s, a] of [
    [-1, L],
    [1, R],
  ] as const) {
    arms.line(cx + s * 6.5, cy - 1, cx + a[0], cy + a[1], CRAB.body);
    arms.disc(cx + a[0] + 0.5, cy + a[1] + 0.5, 2.3, CRAB.body);
    arms.set(cx + a[0] - s, cy + a[1] - 1, CRAB.hi);
    if (r.open) {
      // The pincer's notch, facing up and out.
      arms.clear(cx + a[0] + s, cy + a[1] - 1);
      arms.clear(cx + a[0] + s, cy + a[1] - 2);
    }
  }
  arms.outline(CRAB.line);
  return r.front ? legs.over(body).over(arms) : legs.over(arms).over(body);
}

function cloud(r: Rig): Layer {
  const cx = CENTRE.cloud[0] + r.dx;
  const cy = CENTRE.cloud[1] + r.dy;
  const b = new Layer();
  const shade = { hi: CLOUD.hi, shade: CLOUD.shade };
  b.ellipse(cx - 5.5, cy + 1, 4.3, 4.1, CLOUD.body, shade);
  b.ellipse(cx + 5.5, cy + 0.5, 4.7, 4.5, CLOUD.body, shade);
  b.ellipse(cx, cy - 2.5, 5.8, 5.6, CLOUD.body, { hi: CLOUD.hi });
  b.rect(cx - 8, cy + 1, 17, 3, CLOUD.body);
  b.rect(cx - 7, cy + 4, 15, 1, CLOUD.shade);
  b.outline(CLOUD.line);
  // The face: a prompt chevron and a cursor (`>_`); asleep, `-_`.
  const fy = cy + (r.eyes === 'up' ? -1 : 0);
  const fx = cx + r.look;
  if (r.eyes === 'closed') b.rect(fx - 5, fy, 3, 1, CLOUD.face);
  else b.map(fx - 5, fy - 2, ['#..', '.#.', '..#', '.#.', '#..'], CLOUD.face);
  b.rect(fx, fy + 2, 4, 1, r.mouth === 'open' && r.eyes !== 'closed' ? CLOUD.line : CLOUD.face);
  // Arms: two little puffs of their own.
  const arms = new Layer();
  for (const a of [r.armL ?? [-10.5, 2], r.armR ?? [10.5, 2]] as const) arms.disc(cx + a[0] + 0.5, cy + a[1] + 0.5, 1.7, CLOUD.body);
  arms.outline(CLOUD.line);
  return r.front ? b.over(arms) : arms.over(b);
}

/** The crab's mouth (the cloud's face is its prompt). */
function face(l: Layer, cx: number, y: number, mouth: Rig['mouth'], rgb: number): void {
  if (mouth === 'open') {
    l.rect(cx - 1, y, 2, 2, rgb);
    return;
  }
  if (mouth === 'flat') {
    l.rect(cx - 1, y, 2, 1, rgb);
    return;
  }
  l.set(cx - 2, y, rgb);
  l.rect(cx - 1, y + 1, 2, 1, rgb);
  l.set(cx + 1, y, rgb);
}

/** A 4 × 4 "z" for the resting mascot. */
const ZED = ['####', '..#.', '.#..', '####'];

/** Draws a pose's prop (in `p`, outlined in ink) and sets its rig, for frame `f`. */
type PoseArt = (f: number, r: Rig, p: Layer, m: Mascot) => void;

const POSE_ART: Record<Pose, PoseArt> = {
  // A thought bubble with three dots lighting in turn; still, looking up at it, claws folded low: unlike any tool pose.
  thinking: (f, r, p, m) => {
    r.dx = -2;
    r.eyes = 'up';
    r.look = 1;
    r.mouth = 'flat';
    r.open = false;
    r.armL = [-8, 2];
    // A claw (an arm) at the chin.
    r.armR = m === 'crab' ? [3, 2] : [4, 3];
    r.front = true;
    const t = new Layer();
    t.disc(19.5, 12.5, 0.9, C.paper);
    t.disc(21.5, 9.5, 1.4, C.paper);
    t.ellipse(25.5, 5, 5.6, 3.8, C.paper);
    t.outline(C.bubbleLine);
    const lit = (f % 3) + 1;
    for (let k = 0; k < 3; k++) t.rect(22.5 + k * 3, 4.5, 2, 2, k < lit ? C.dot : C.dotOff);
    p.over(t);
  },
  // A speech bubble whose lines type themselves.
  replying: (f, r, p) => {
    r.dx = -2;
    r.mouth = 'open';
    r.look = 1;
    r.armR = [9, f % 2 ? -7 : -6];
    const t = new Layer();
    t.rect(19, 2, 12, 8, C.paper);
    t.set(20, 10, C.paper);
    t.set(19, 11, C.paper);
    t.outline(C.bubbleLine);
    const lengths = [
      [2, 0],
      [4, 0],
      [6, 0],
      [8, 2],
      [8, 4],
      [8, 6],
    ][f] as [number, number];
    lengths.forEach((n, row) => {
      for (let i = 0; i < n; i++) if (i % 3 !== 2) t.set(21 + i, 4 + row * 3, C.dot);
    });
    p.over(t);
  },
  // Typing at a tiny keyboard, claws taking turns.
  writing: (f, r, p, m) => {
    r.look = 0;
    r.front = true;
    r.armL = m === 'crab' ? [-5, 2 + (f % 2)] : [-6, 4 + (f % 2)];
    r.armR = m === 'crab' ? [5, 2 + ((f + 1) % 2)] : [6, 4 + ((f + 1) % 2)];
    const k = new Layer();
    k.rect(8, 26, 16, 3, C.steelHi);
    k.outline(INK);
    for (let i = 0; i < 7; i++) k.set(9 + i * 2, 26, 0xf4f6fb);
    k.set(f % 2 ? 11 : 21, 27, C.sun);
    p.over(k);
  },
  // A magnifying glass sweeping across.
  investigating: (f, r, p, m) => {
    r.dx = -3;
    r.look = 1;
    r.mouth = 'flat';
    const lx = [22, 23, 24, 24, 23, 22][f] as number;
    const ly = 12;
    r.armR = at(r, m, lx + 4, ly + 6);
    const g = new Layer();
    g.line(lx + 2, ly + 2, lx + 4, ly + 5, C.woodDark);
    g.line(lx + 3, ly + 2, lx + 5, ly + 5, C.woodDark);
    g.disc(lx, ly, 3.4, 0x2b2f3a);
    g.disc(lx, ly, 2.4, 0xbfe6ff);
    g.set(lx - 1, ly - 1, 0xffffff);
    g.outline(INK);
    p.over(g);
  },
  // A flask, bubbling.
  testing: (f, r, p) => {
    r.dx = -4;
    r.look = 1;
    r.armR = [8, -3];
    r.armL = [-9, -7];
    const g = new Layer();
    g.rect(25, 10, 3, 5, C.glass);
    for (let y = 15; y <= 23; y++) {
      const w = 1 + (y - 15) * 0.5;
      for (let x = Math.ceil(26.5 - w); x <= Math.floor(26.5 + w); x++) g.set(x, y, y >= 19 ? (y === 23 ? C.limeDeep : C.lime) : C.glass);
    }
    g.outline(INK);
    for (let k = 0; k < 2; k++) {
      const by = 22 - ((f + k * 3) % 6) * 2;
      const bx = 26 + k;
      if (by >= 19) g.set(bx, by, C.bubble);
      else if (by >= 10) g.set(bx, by, 0xffffff);
    }
    p.over(g);
  },
  // A hammer coming down on a nail.
  building: (f, r, p, m) => {
    r.dx = -4;
    r.look = 1;
    r.mouth = 'flat';
    const grip: P2 = [22, 17];
    r.armR = at(r, m, grip[0], grip[1]);
    const heads: P2[] = [
      [25, 8],
      [26, 9],
      [29, 13],
      [28, 21],
      [29, 14],
      [26, 9],
    ];
    const h = heads[f] as P2;
    const g = new Layer();
    g.rect(21, 26, 10, 2, C.wood);
    g.rect(27, 24, 1, 2, C.steel);
    g.line(grip[0], grip[1], h[0], h[1], C.woodDark);
    g.rect(h[0] - 2, h[1] - 1, 4, 3, C.steel);
    g.rect(h[0] - 2, h[1] - 1, 4, 1, C.steelHi);
    g.outline(INK);
    if (f === 3) for (const [x, y] of [[25, 23], [31, 23], [26, 25], [30, 25], [28, 24]] as P2[]) g.set(x, y, C.spark);
    p.over(g);
  },
  // A parcel pushed out with an arrow: off it goes.
  shipping: (f, r, p, m) => {
    r.dx = -5;
    r.look = 1;
    const x0 = 18 + ([0, 1, 2, 3, 2, 1][f] as number);
    r.armR = at(r, m, x0 - 1, 21);
    const g = new Layer();
    g.rect(x0, 17, 8, 8, C.card);
    g.rect(x0, 17, 8, 2, C.cardDark);
    g.rect(x0 + 3, 17, 2, 8, C.tape);
    g.outline(INK);
    const a = new Layer();
    const ax = x0 + 10;
    a.rect(ax, 20, 2, 2, C.sun);
    a.rect(ax + 2, 18, 1, 6, C.sun);
    a.rect(ax + 3, 19, 1, 4, C.sun);
    a.rect(ax + 4, 20, 1, 2, C.sun);
    a.outline(INK);
    p.over(g).over(a);
  },
  // A globe on its stand, turning.
  researching: (f, r, p) => {
    r.dx = -4;
    r.eyes = 'up';
    r.look = 1;
    r.armR = [9, -8];
    const gx = 25;
    const gy = 12;
    const land = ['..##......', '.####...#.', '..###..###', '...#...##.', '.......#..', '..##......', '.####..#..', '..##...##.', '.......#..'];
    const g = new Layer();
    g.rect(gx, gy + 5, 1, 4, C.steel);
    g.rect(gx - 3, gy + 9, 7, 1, C.steel);
    for (let y = -4; y <= 4; y++)
      for (let x = -4; x <= 4; x++) {
        if (x * x + y * y > 21) continue;
        const row = land[y + 4] as string;
        const ch = row[(((x + 4 + f * 2) % 10) + 10) % 10];
        g.set(gx + x, gy + y, ch === '#' ? C.leaf : C.ocean);
      }
    g.outline(INK);
    g.set(gx - 2, gy - 2, 0xd6ecff);
    p.over(g);
  },
  // Handing a note on: it flies off, a new one comes.
  delegating: (f, r, p) => {
    r.dx = -3;
    r.look = 1;
    const notes: Array<P2 | null> = [[23, 12], [25, 10], [27, 8], [29, 6], null, [23, 12]];
    const claws: P2[] = [
      [8, -6],
      [9, -7],
      [10, -8],
      [10, -8],
      [9, -7],
      [8, -6],
    ];
    r.armR = claws[f] as P2;
    const n = notes[f];
    const g = new Layer();
    if (n) {
      g.rect(n[0], n[1], 5, 4, C.paper);
      g.outline(INK);
      g.rect(n[0] + 1, n[1] + 1, 3, 1, C.steel);
      g.rect(n[0] + 1, n[1] + 2, 2, 1, C.steel);
    }
    if (f === 2 || f === 3) {
      const t = notes[f] as P2;
      g.set(t[0] - 2, t[1] + 4, C.dotOff);
      g.set(t[0] - 3, t[1] + 5, C.dotOff);
    }
    p.over(g);
  },
  // A clipboard, its list ticked off line by line.
  planning: (f, r, p) => {
    r.dx = -4;
    r.look = 1;
    r.armR = [9, -3];
    r.armL = [-9, -6];
    const g = new Layer();
    g.rect(20, 10, 9, 13, C.wood);
    g.outline(INK);
    g.rect(21, 12, 7, 10, C.paper);
    g.rect(23, 9, 3, 2, C.steel);
    for (let k = 0; k < 3; k++) {
      const y = 14 + k * 3;
      g.set(22, y, f >= 2 * k + 1 ? 0x3ccf8e : C.steel);
      const n = Math.max(0, Math.min(3, f - 2 * k + 1));
      for (let i = 0; i < n; i++) g.set(24 + i, y, C.dot);
    }
    p.over(g);
  },
  // An hourglass running, a foot (or an arm) tapping.
  waiting: (f, r, p, m) => {
    r.dx = -4;
    r.look = 1;
    r.mouth = 'flat';
    r.tap = f % 2 === 0;
    if (m === 'cloud') r.armR = [9, f % 2 ? -1 : 0];
    const g = new Layer();
    g.rect(22, 9, 7, 1, C.woodDark);
    g.rect(22, 23, 7, 1, C.woodDark);
    for (let y = 10; y <= 22; y++) {
      const d = Math.abs(y - 16);
      const w = d === 0 ? 0 : Math.min(2, Math.ceil(d / 2));
      for (let x = 25 - w; x <= 25 + w; x++) g.set(x, y, C.glass);
    }
    g.outline(INK);
    // Sand: the top empties, the bottom fills, a grain falls between.
    const top = 5 - f;
    for (let y = 16 - top; y < 16; y++) {
      const w = Math.min(2, Math.ceil(Math.abs(y - 16) / 2));
      for (let x = 25 - w; x <= 25 + w; x++) if (y > 10) g.set(x, y, C.sun);
    }
    const bottom = 1 + Math.floor(f * 0.8);
    for (let y = 22; y > 22 - bottom; y--) {
      const w = Math.min(2, Math.ceil(Math.abs(y - 16) / 2));
      for (let x = 25 - w; x <= 25 + w; x++) g.set(x, y, C.sun);
    }
    if (f % 2) g.set(25, 17, C.sun);
    p.over(g);
  },
  // Nothing particular: a busy little bob.
  working: (f, r) => {
    r.dy = [0, -1, -1, 0, 0, 0][f] as number;
    r.armL = [-10, -6 + (f % 2)];
    r.armR = [10, -6 + ((f + 1) % 2)];
  },
  // Holding up a picture (where the image itself is not on the monitor).
  image: (f, r, p, m) => {
    r.dx = -3;
    r.dy = [0, 0, -1, -1, 0, 0][f] as number;
    r.look = 1;
    const y0 = 9 + r.dy;
    r.armL = at(r, m, 19, y0 + 9);
    r.armR = at(r, m, 29, y0 + 9);
    const g = new Layer();
    g.rect(19, y0, 11, 9, C.paper);
    g.outline(INK);
    g.rect(20, y0 + 1, 9, 7, C.sky);
    g.disc(26.5, y0 + 2.5, 1.3, C.sun);
    for (let x = 20; x <= 28; x++) {
      const h = y0 + 5 - Math.round(1.6 * Math.sin((x - 20) / 1.6));
      for (let y = h; y <= y0 + 7; y++) g.set(x, y, C.leaf);
    }
    p.over(g);
  },
  // The crab asleep, the cloud drifting: eyes shut, a z or two rising.
  rest: (f, r, p, m) => {
    r.eyes = 'closed';
    r.mouth = 'flat';
    r.open = false;
    r.armL = m === 'crab' ? [-9, 2] : [-10, 3];
    r.armR = m === 'crab' ? [9, 2] : [10, 3];
    if (m === 'crab') r.dy = 1;
    else {
      r.dx = [-1, -1, 0, 1, 1, 0][f] as number;
      r.dy = [0, 0, 1, 1, 1, 0][f] as number;
    }
    const z = new Layer();
    for (let k = 0; k < 2; k++) {
      const t = (f + k * 3) % 6;
      const zy = Math.round(12 - t * 1.8);
      if (zy >= 0) z.map(20 + t, zy, ZED, C.zzz);
    }
    p.over(z);
  },
};

/** One frame of a mascot's pose, as cell pixels (0: transparent). */
export function framePixels(m: Mascot, pose: Pose, f: number): Uint32Array {
  const r = rig();
  const prop = new Layer();
  POSE_ART[pose](f, r, prop, m);
  const body = m === 'crab' ? crab(r) : cloud(r);
  return body.over(prop).px;
}

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, row by row from the top. */
  data: Uint8ClampedArray;
}

/** The whole sheet: `SPRITE_COLS` × `SPRITE_ROWS` cells of `SPRITE` pixels; cell (frame, spriteRow(m, p)). */
export function mascotPixels(): Pixels {
  const width = SPRITE * SPRITE_COLS;
  const height = SPRITE * SPRITE_ROWS;
  const data = new Uint8ClampedArray(width * height * 4);
  for (const m of MASCOTS)
    for (const pose of POSES)
      for (let f = 0; f < FRAMES; f++) {
        const px = framePixels(m, pose, f);
        const ox = f * SPRITE;
        const oy = spriteRow(m, pose) * SPRITE;
        for (let y = 0; y < SPRITE; y++)
          for (let x = 0; x < SPRITE; x++) {
            const c = px[y * SPRITE + x] ?? 0;
            if (!c) continue;
            const i = ((oy + y) * width + ox + x) * 4;
            data[i] = (c >>> 16) & 0xff;
            data[i + 1] = (c >>> 8) & 0xff;
            data[i + 2] = c & 0xff;
            data[i + 3] = 0xff;
          }
      }
  return { width, height, data };
}
