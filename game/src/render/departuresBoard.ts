import * as THREE from 'three/webgpu';
import type { Box3 } from '../world/layout';
import type { DepartureRow, FloorBoard, LobbyGroup, LobbyPlan } from '../world/departures';
import { STATUS_CHIP_CSS, STATUS_CSS, WALL, type WallPalette } from './palette';
import { fitText, glass, pictureMaterial, WALL_MIN_MS } from './overviewScreen';

/**
 * #65 (part 4 of #61): the departures boards. A floor's stands on its board partition (both faces: the desks' and the
 * elevator's side) and shows the floor's next three schedules; a building's lobby has one on its north wall with a
 * group per floor. They read like the overview's wall screen (#118), its glass, its sun-yellow and its split-flap
 * tiles: the time of each departure is four flaps, a group's floor number one.
 *
 * One canvas texture each, unlit (`MeshBasicMaterial`, not tone mapped, its own program key): it adds no light (M17).
 * The board draws a text model (world/departures.ts) and **redraws only when that model differs** from the one it drew
 * last, at most once a second, and never while out of view (after its first picture). Between the model's ticks
 * (`nextAt`: a second while a departure is under an hour away, else the minute) and with the schedules unchanged
 * (`ScheduleBook.version`) a frame costs two comparisons (`due`): nothing is computed, allocated, drawn or uploaded.
 */

/** Resolution per metre of a board. */
const PX_PER_M = 320;
const BEZEL = 0.05;
/** The floor board's posts: this tall, its face above them. */
const POSTS = 0.12;

/** The model a board draws: its key is what decides a redraw (`nextAt` is not drawn). */
interface Model {
  nextAt: number;
}

/** A board's canvas, texture and the redraw rule; `paint` draws a model whose key differs from the last one drawn. */
class Face<M extends Model> {
  readonly canvas: HTMLCanvasElement;
  readonly texture: THREE.CanvasTexture;
  readonly material: THREE.MeshBasicMaterial;
  private seen = -1;
  private nextAt = 0;
  private drawnKey = '';
  private drawnAt = -Infinity;
  draws = 0;
  shown: M | null = null;

  constructor(
    readonly w: number,
    readonly h: number,
    private readonly paint: (g: CanvasRenderingContext2D, W: number, H: number, m: M, c: Readonly<WallPalette>) => void,
    private readonly colors: Readonly<WallPalette>,
  ) {
    const scale = Math.min(PX_PER_M, 2048 / Math.max(w, h));
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.max(1, Math.round(w * scale));
    this.canvas.height = Math.max(1, Math.round(h * scale));
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.material = pictureMaterial(this.texture, false, 'h3d-departures');
  }

  /** The schedules changed (`version`) or the clock reached the model's next change: a look is due. */
  due(version: number, now: number): boolean {
    return version !== this.seen || now >= this.nextAt;
  }

  /** Something the model reads besides the schedules changed (the lobby's floors, the logo): look again. */
  invalidate(): void {
    this.seen = -1;
  }

  /** Looks when due: computes the model, draws it if it differs from the last one drawn; true when it drew. */
  tick(version: number, now: number, view: boolean, model: (now: number) => M, key: (m: M) => string): boolean {
    if (!this.due(version, now)) return false;
    // Out of view: no work until it is back (its first picture is drawn anyway, so it never shows blank).
    if (this.draws > 0 && !view) return false;
    // At most one picture a second, on the clock's seconds (where the countdowns turn), so a tick is never pushed late.
    if (Math.floor(now / WALL_MIN_MS) === Math.floor(this.drawnAt / WALL_MIN_MS)) return false;
    this.seen = version;
    const m = model(now);
    this.nextAt = m.nextAt;
    const k = key(m);
    // The same picture: what it shows is this model (its ids too: a row replaced by one that reads the same).
    if (k === this.drawnKey) {
      this.shown = m;
      return false;
    }
    const g = this.canvas.getContext('2d');
    if (!g) return false;
    this.drawnKey = k;
    this.drawnAt = now;
    this.draws++;
    this.shown = m;
    this.paint(g, this.canvas.width, this.canvas.height, m, this.colors);
    this.texture.needsUpdate = true;
    return true;
  }

  get next(): number {
    return this.nextAt;
  }

  dispose(): void {
    this.texture.dispose();
    this.material.dispose();
  }
}

/** The face's housing, and the posts the floor board stands on. */
const housing = (c: Readonly<WallPalette>) => new THREE.MeshToonMaterial({ color: c.housing });

/** What a floor board shows (test hook). */
export interface DeparturesInfo {
  draws: number;
  nextAt: number;
  model: FloorBoard | null;
  screenW: number;
  screenH: number;
}

export interface FloorDeparturesMesh {
  group: THREE.Group;
  /** Whether a look is due: two comparisons, the whole of an idle frame. */
  due(version: number, now: number): boolean;
  /** Looks (when due) at `model`'s board; `view`: in view and big enough to read. True when the picture changed. */
  tick(version: number, now: number, view: boolean, model: (now: number) => FloorBoard): boolean;
  info(): DeparturesInfo;
  dispose(): void;
}

/** The floor's board on its partition: `box` is the prop's (posts and face), the face readable from -z and +z. */
export function buildFloorDepartures(box: Box3, c: Readonly<WallPalette> = WALL): FloorDeparturesMesh {
  const group = new THREE.Group();
  group.name = 'board.departures';
  const [x0, y0, z0] = box.min;
  const [x1, y1, z1] = box.max;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const fy0 = y0 + POSTS;
  const body = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - fy0, z1 - z0), housing(c));
  body.position.set(cx, (fy0 + y1) / 2, cz);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);
  for (const x of [x0 + 0.45, x1 - 0.45]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, POSTS, 0.08), housing(c));
    post.position.set(x, y0 + POSTS / 2, cz);
    group.add(post);
  }
  const screenW = x1 - x0 - 2 * BEZEL;
  const screenH = y1 - fy0 - 2 * BEZEL;
  const face = new Face<FloorBoard>(screenW, screenH, paintFloorBoard, c);
  // One texture on both faces: the desks' (north, -z) and the elevator's (south, +z).
  const geo = new THREE.PlaneGeometry(screenW, screenH);
  const south = new THREE.Mesh(geo, face.material);
  south.position.set(cx, (fy0 + y1) / 2, z1 + 0.003);
  const north = new THREE.Mesh(geo.clone().rotateY(Math.PI), face.material);
  north.position.set(cx, (fy0 + y1) / 2, z0 - 0.003);
  group.add(south, north);
  return {
    group,
    due: (v, now) => face.due(v, now),
    tick: (v, now, view, model) => face.tick(v, now, view, model, floorKey),
    info: () => ({ draws: face.draws, nextAt: face.next, model: face.shown, screenW, screenH }),
    dispose() {
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          if (o.material !== face.material) (o.material as THREE.Material).dispose();
        }
      });
      face.dispose();
      group.removeFromParent();
    },
  };
}

/** What a row draws: its id is not (a row replaced by one that reads the same is no redraw). */
const rowKey = (r: DepartureRow) => [r.time, r.title, r.state, r.status];

const floorKey = (m: FloorBoard) => JSON.stringify([m.known, m.rows.map(rowKey), m.attention, m.later]);

/** The lobby board's model: the building's groups as planned for its face. */
export interface LobbyBoardModel {
  known: boolean;
  building: string;
  groups: LobbyGroup[];
  plan: LobbyPlan;
  /** The building's logo (null: its name alone). */
  logo: { hash: string; image: CanvasImageSource; width: number; height: number } | null;
  /** The page of floors `groups` are (0-based) and how many there are (`lobbyPage`). */
  page: number;
  pages: number;
  nextAt: number;
}

/** What the lobby board draws; a group's floor id too, which its pick box opens. */
const lobbyKey = (m: LobbyBoardModel) =>
  JSON.stringify([m.known, m.building, m.page, m.pages, m.groups.map((g) => [g.floor, g.name, g.level, g.attention, g.later, g.rows.map(rowKey)]), m.plan.lines, m.plan.cols, m.logo?.hash ?? null]);

export interface LobbyDeparturesMesh {
  group: THREE.Group;
  /** The face (inside the bezel): the groups' cells are on it. */
  screen: Box3;
  due(version: number, now: number): boolean;
  /** Look again on the next tick: what it shows besides the schedules changed (the floors, the logo). */
  invalidate(): void;
  tick(version: number, now: number, view: boolean, model: (now: number) => LobbyBoardModel): boolean;
  /** The model on the board now (null before its first picture): its groups are what the pick boxes open. */
  shown(): LobbyBoardModel | null;
  info(): { draws: number; nextAt: number; model: Omit<LobbyBoardModel, 'logo'> & { logo: string | null } | null };
  dispose(): void;
}

/** The lobby's board on a north wall: `box`'s front is at max z, facing +z. */
export function buildLobbyDepartures(box: Box3, c: Readonly<WallPalette> = WALL): LobbyDeparturesMesh {
  const group = new THREE.Group();
  group.name = 'lobby.departures';
  const [x0, y0, z0] = box.min;
  const [x1, y1, z1] = box.max;
  const body = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), housing(c));
  body.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  group.add(body);
  const screen: Box3 = { min: [x0 + BEZEL, y0 + BEZEL, z0], max: [x1 - BEZEL, y1 - BEZEL, z1] };
  const sw = screen.max[0] - screen.min[0];
  const sh = screen.max[1] - screen.min[1];
  const face = new Face<LobbyBoardModel>(sw, sh, paintLobbyBoard, c);
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh), face.material);
  plane.position.set((x0 + x1) / 2, (y0 + y1) / 2, z1 + 0.003);
  group.add(plane);
  return {
    group,
    screen,
    due: (v, now) => face.due(v, now),
    invalidate: () => face.invalidate(),
    tick: (v, now, view, model) => face.tick(v, now, view, model, lobbyKey),
    shown: () => face.shown,
    info: () => {
      const m = face.shown;
      return { draws: face.draws, nextAt: face.next, model: m ? { ...m, logo: m.logo?.hash ?? null } : null };
    },
    dispose() {
      body.geometry.dispose();
      (body.material as THREE.Material).dispose();
      plane.geometry.dispose();
      face.dispose();
      group.removeFromParent();
    },
  };
}

// ---- painting ---------------------------------------------------------------------------------------------------------

/** "1 needs attention", "3 need attention". */
export function attentionText(n: number): string {
  return `${n} ${n === 1 ? 'needs' : 'need'} attention`;
}

/** What a board says when its bridge is older than scheduled agents (the dialog's words). */
export const OLD_BRIDGE = 'This herdr-world can’t schedule agents yet';
export const EMPTY = 'No departures scheduled';

/** A countdown keeps room for its widest (`in 59m 59s` and `in 6d 23h` are narrower), so a title is not cut anew each second. */
const COUNTDOWN_ROOM = 'in 23h 59m';

/** A row's measures, in px: the time's flaps and the gap after them, the title's and the status's sizes. */
interface RowStyle {
  /** A flap's width and height; the time is four of them. */
  flapW: number;
  flapH: number;
  title: number;
  status: number;
  /** Room for a day before the flaps (`Sun`, `24 Oct`); 0 when no row has one. */
  day: number;
}

/** Where a row's parts go: the flaps from `x`, the title, the status right-aligned at `right`. Pure (for its test). */
export function rowColumns(x: number, right: number, s: RowStyle, statusRoom: number): { flaps: number; title: number; titleMax: number; statusLeft: number } {
  const flaps = x + s.day;
  const title = flaps + flapsWidth(s) + s.flapW * 0.9;
  const statusLeft = right - statusRoom;
  return { flaps, title, titleMax: Math.max(0, statusLeft - s.flapW * 0.9 - title), statusLeft };
}

/** Between two flaps, and the colon's room between the hours and the minutes (both shares of a flap's width). */
const FLAP_GAP = 0.12;
const COLON = 0.42;

const flapsWidth = (s: Pick<RowStyle, 'flapW'>) => s.flapW * (4 + 2 * FLAP_GAP + COLON);

/** Split-flap tiles of `text` (one character each) from `x`, centred on `mid`; a colon is its two dots. Returns the width. */
function flaps(g: CanvasRenderingContext2D, c: Readonly<WallPalette>, text: string, x: number, mid: number, w: number, h: number, ink: string): number {
  let at = x;
  let prev = false; // a flap before: the next starts a gap after it
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  for (const ch of text) {
    if (ch === ':') {
      g.fillStyle = c.text2;
      const r = Math.max(1, w * 0.07);
      for (const dy of [-h * 0.17, h * 0.17]) {
        g.beginPath();
        g.arc(at + (w * COLON) / 2, mid + dy, r, 0, Math.PI * 2);
        g.fill();
      }
      at += w * COLON;
      prev = false;
      continue;
    }
    if (prev) at += w * FLAP_GAP;
    g.fillStyle = c.flap;
    g.beginPath();
    g.roundRect(at, mid - h / 2, w, h, w * 0.12);
    g.fill();
    g.fillStyle = ink;
    g.font = `700 ${Math.round(h * 0.72)}px ${c.font}`;
    g.fillText(ch, at + w / 2, mid + h * 0.27);
    // The flap's seam, across the character.
    g.fillStyle = c.ink;
    g.fillRect(at, mid - Math.max(0.5, h * 0.02), w, Math.max(1, h * 0.04));
    at += w;
    prev = true;
  }
  g.textAlign = 'left';
  return at - x;
}

/** A status chip's width (its text in `size` px, half that either side). */
function chipW(g: CanvasRenderingContext2D, c: Readonly<WallPalette>, text: string, size: number): number {
  g.font = `700 ${Math.round(size)}px ${c.font}`;
  return g.measureText(text).width + size;
}

/** A status chip, right-aligned at `right` and centred on `mid`; returns its width. */
function chip(g: CanvasRenderingContext2D, c: Readonly<WallPalette>, text: string, right: number, mid: number, size: number, bg: string): number {
  const w = chipW(g, c, text, size);
  const padX = size * 0.5;
  const h = size * 1.55;
  g.fillStyle = bg;
  g.beginPath();
  g.roundRect(right - w, mid - h / 2, w, h, size * 0.25);
  g.fill();
  g.fillStyle = '#ffffff';
  g.textAlign = 'left';
  g.fillText(text, right - w + padX, mid + size * 0.36);
  return w;
}

/** A departure row: `[day] HH:MM  title……  status`, centred on `mid`, from `x` to `right`. */
function paintRow(g: CanvasRenderingContext2D, c: Readonly<WallPalette>, r: DepartureRow, x: number, right: number, mid: number, s: RowStyle, statusRoom: number): void {
  const col = rowColumns(x, right, s, statusRoom);
  const sp = r.time.lastIndexOf(' ');
  const day = sp < 0 ? '' : r.time.slice(0, sp);
  const clock = sp < 0 ? r.time : r.time.slice(sp + 1);
  if (day) {
    g.font = `600 ${Math.round(s.flapH * 0.42)}px ${c.font}`;
    g.fillStyle = c.text2;
    g.textAlign = 'right';
    g.fillText(day, col.flaps - s.flapW * 0.35, mid + s.flapH * 0.15);
    g.textAlign = 'left';
  }
  flaps(g, c, clock, col.flaps, mid, s.flapW, s.flapH, r.state === 'departing' ? c.text3 : c.accent);
  g.font = `600 ${Math.round(s.title)}px ${c.font}`;
  g.fillStyle = r.state === 'departing' ? c.text2 : c.text;
  fitText(g, r.title, col.title, mid + s.title * 0.36, col.titleMax);
  switch (r.state) {
    case 'boarding':
      chip(g, c, r.status, right, mid, s.status * 0.86, STATUS_CHIP_CSS.waiting);
      break;
    case 'departing':
      chip(g, c, r.status, right, mid, s.status * 0.86, STATUS_CHIP_CSS.working);
      break;
    case 'delayed':
      chip(g, c, r.status, right, mid, s.status * 0.86, STATUS_CHIP_CSS.needs_you);
      break;
    default:
      g.font = `${r.state === 'due' ? 700 : 500} ${Math.round(s.status)}px ${c.font}`;
      g.fillStyle = r.state === 'due' ? c.accent : c.text2;
      g.textAlign = 'right';
      g.fillText(r.status, right, mid + s.status * 0.36);
      g.textAlign = 'left';
  }
}

/**
 * The status column's room: what the widest of the rows' statuses takes (a chip's text as it is, a countdown its widest
 * form), so every title of the board or the group is cut at the same place, and that place moves only when a row's
 * state does, never with a countdown's seconds.
 */
function statusRoom(g: CanvasRenderingContext2D, c: Readonly<WallPalette>, size: number, rows: readonly DepartureRow[]): number {
  let room = 0;
  for (const r of rows) {
    if (r.state === 'boarding' || r.state === 'departing' || r.state === 'delayed') room = Math.max(room, chipW(g, c, r.status, size * 0.86));
    else {
      g.font = `${r.state === 'due' ? 700 : 500} ${Math.round(size)}px ${c.font}`;
      room = Math.max(room, g.measureText(r.state === 'due' ? r.status : COUNTDOWN_ROOM).width);
    }
  }
  return room;
}

/** The room a day before the flaps takes, when a row has one. */
function dayRoom(g: CanvasRenderingContext2D, c: Readonly<WallPalette>, rows: readonly DepartureRow[], flapH: number, flapW: number): number {
  if (!rows.some((r) => r.time.includes(' '))) return 0;
  g.font = `600 ${Math.round(flapH * 0.42)}px ${c.font}`;
  return g.measureText('30 Sep').width + flapW * 0.35;
}

/** The attention line: a red light and "N need attention", from `x` on `base`; returns its width. */
function attention(g: CanvasRenderingContext2D, c: Readonly<WallPalette>, n: number, x: number, base: number, size: number, max: number): number {
  const r = size * 0.3;
  g.fillStyle = STATUS_CSS.needs_you;
  g.beginPath();
  g.arc(x + r, base - size * 0.34, r, 0, Math.PI * 2);
  g.fill();
  g.font = `700 ${Math.round(size)}px ${c.font}`;
  return r * 2 + size * 0.45 + fitText(g, attentionText(n), x + r * 2 + size * 0.45, base, max - r * 2 - size * 0.45);
}

/**
 * The floor board: "Departures", then a row per departure (its time on flaps, its title cut to the room before the
 * status column, its status), then the attention line and how many more come later. Exported for its test.
 */
export function paintFloorBoard(g: CanvasRenderingContext2D, W: number, H: number, m: FloorBoard, c: Readonly<WallPalette> = WALL): void {
  glass(g, W, H, c);
  const u = H / 100;
  const pad = u * 5;
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  g.fillStyle = c.accent;
  g.font = `800 ${Math.round(u * 12)}px ${c.font}`;
  g.fillText('Departures', pad, u * 15.5);
  g.fillStyle = c.ink3;
  g.fillRect(pad, u * 21, W - pad * 2, Math.max(2, u * 0.4));
  const top = u * 23;
  const rowH = u * 20;
  if (!m.known || !m.rows.length) {
    g.fillStyle = c.text2;
    g.font = `600 ${Math.round(u * 8)}px ${c.font}`;
    fitText(g, m.known ? EMPTY : OLD_BRIDGE, pad, top + u * 15, W - pad * 2);
    if (m.known) {
      g.fillStyle = c.text3;
      g.font = `500 ${Math.round(u * 5.5)}px ${c.font}`;
      fitText(g, 'Look here and press E to schedule an agent.', pad, top + u * 26, W - pad * 2);
    }
  }
  const style: RowStyle = { flapW: u * 8, flapH: u * 13, title: u * 8, status: u * 7, day: 0 };
  style.day = dayRoom(g, c, m.rows, style.flapH, style.flapW);
  const room = statusRoom(g, c, style.status, m.rows);
  m.rows.forEach((r, i) => {
    const mid = top + rowH * i + rowH / 2;
    paintRow(g, c, r, pad, W - pad, mid, style, room);
    if (i < m.rows.length - 1) {
      g.fillStyle = `rgba(${c.rule},0.10)`;
      g.fillRect(pad, top + rowH * (i + 1), W - pad * 2, Math.max(1, u * 0.25));
    }
  });
  const foot = H - u * 5;
  let left = pad;
  if (m.attention > 0) left += attention(g, c, m.attention, pad, foot, u * 6.5, W * 0.6);
  if (m.later > 0) {
    g.font = `500 ${Math.round(u * 5.5)}px ${c.font}`;
    g.fillStyle = c.text3;
    g.textAlign = 'right';
    const text = `+${m.later} later`;
    if (g.measureText(text).width < W - pad - left - u * 4) g.fillText(text, W - pad, foot);
    g.textAlign = 'left';
  }
}

/**
 * The lobby board: "Departures" and the building (its logo when it has one; which floors and page, when they take more
 * than one), then a group per floor of the page in the plan's cells: the floor's number on a flap, its name, its
 * attention count, and its departures as the floor board's rows.
 * Exported for its test.
 */
export function paintLobbyBoard(g: CanvasRenderingContext2D, W: number, H: number, m: LobbyBoardModel, c: Readonly<WallPalette> = WALL): void {
  glass(g, W, H, c);
  const u = H / 100;
  const pad = m.plan.cells[0] ? m.plan.cells[0].u0 * W : u * 5;
  const head = m.plan.head * H;
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  // The header: the board's name, the building's after it, the logo at the right.
  let logoW = 0;
  if (m.logo && m.logo.width > 0 && m.logo.height > 0) {
    const lh = head * 0.62;
    const lw = Math.min(W * 0.3, (lh * m.logo.width) / m.logo.height);
    const lhh = (lw * m.logo.height) / m.logo.width;
    try {
      g.drawImage(m.logo.image, W - pad - lw, (head - lhh) / 2 + u, lw, lhh);
      logoW = lw + u * 3;
    } catch {
      // A logo the cache let go of meanwhile: the name alone (the next set brings the new one).
    }
  }
  const base = head * 0.68;
  // More floors than a page holds: which ones these are and the page, by the logo (`Floors 12–7 · 1/2`).
  let pageW = 0;
  const first = m.groups[0];
  const last = m.groups[m.groups.length - 1];
  if (m.pages > 1 && first && last) {
    g.fillStyle = c.text2;
    g.font = `600 ${Math.round(head * 0.26)}px ${c.font}`;
    g.textAlign = 'right';
    const text = `${first === last ? `Floor ${first.level}` : `Floors ${first.level}–${last.level}`} · ${m.page + 1}/${m.pages}`;
    g.fillText(text, W - pad - logoW, base);
    g.textAlign = 'left';
    pageW = g.measureText(text).width + u * 3;
  }
  g.fillStyle = c.accent;
  g.font = `800 ${Math.round(head * 0.5)}px ${c.font}`;
  const w = fitText(g, 'Departures', pad, base, W - pad * 2 - logoW - pageW);
  g.fillStyle = c.text2;
  g.font = `600 ${Math.round(head * 0.26)}px ${c.font}`;
  fitText(g, m.building, pad + w + u * 3, base, W - pad * 2 - logoW - pageW - w - u * 3);
  g.fillStyle = c.ink3;
  g.fillRect(pad, head, W - pad * 2, Math.max(2, u * 0.35));
  if (!m.known) {
    g.fillStyle = c.text3;
    g.font = `500 ${Math.round(u * 3.4)}px ${c.font}`;
    g.textAlign = 'right';
    g.fillText(OLD_BRIDGE, W - pad, head - u * 1.2);
    g.textAlign = 'left';
  }
  const line = m.plan.line * H;
  m.groups.forEach((gr, i) => {
    const cell = m.plan.cells[i];
    if (!cell) return;
    const x = cell.u0 * W;
    const right = cell.u1 * W;
    const y = cell.v0 * H;
    // The floor's line: its number on a flap, its name, its attention count at the right.
    const mid = y + line / 2;
    const fw = line * 0.62;
    const fh = line * 0.86;
    const nw = flaps(g, c, String(gr.level), x, mid, fw, fh, c.text);
    let r = right;
    if (gr.attention > 0) {
      g.font = `700 ${Math.round(line * 0.42)}px ${c.font}`;
      const text = attentionText(gr.attention);
      const tw = Math.min(g.measureText(text).width + line * 0.5, (right - x) * 0.5);
      attention(g, c, gr.attention, right - tw, mid + line * 0.15, line * 0.42, tw);
      r = right - tw - line * 0.4;
    }
    if (gr.later > 0) {
      g.font = `500 ${Math.round(line * 0.36)}px ${c.font}`;
      g.fillStyle = c.text3;
      const text = `+${gr.later} later`;
      const tw = g.measureText(text).width;
      if (tw < (r - x) * 0.3) {
        g.textAlign = 'right';
        g.fillText(text, r, mid + line * 0.13);
        g.textAlign = 'left';
        r -= tw + line * 0.4;
      }
    }
    g.fillStyle = c.text;
    g.font = `700 ${Math.round(line * 0.5)}px ${c.font}`;
    fitText(g, gr.name, x + nw + line * 0.3, mid + line * 0.18, r - x - nw - line * 0.3);
    g.fillStyle = `rgba(${c.rule},0.16)`;
    g.fillRect(x, y + line, right - x, Math.max(1, u * 0.2));
    if (!gr.rows.length) {
      g.fillStyle = c.text3;
      g.font = `500 ${Math.round(line * 0.42)}px ${c.font}`;
      fitText(g, m.known ? EMPTY : '—', x, y + line * 1.5 + line * 0.15, right - x);
      return;
    }
    const style: RowStyle = { flapW: line * 0.4, flapH: line * 0.72, title: line * 0.46, status: line * 0.42, day: 0 };
    style.day = dayRoom(g, c, gr.rows, style.flapH, style.flapW);
    const room = statusRoom(g, c, style.status, gr.rows);
    gr.rows.forEach((row, k) => paintRow(g, c, row, x, right, y + line * (1.5 + k), style, room));
  });
}
