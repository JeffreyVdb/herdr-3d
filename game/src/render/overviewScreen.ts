import * as THREE from 'three/webgpu';
import type { Box3 } from '../world/layout';
import { BLINK_MS, sinceText, visibleRows, type OverviewData, type OverviewWorkerRow, type VisibleRow } from '../world/overview';
import { STATUS_CSS, STATUS_CHIP_CSS } from './palette';
import { FONT } from './cards/atlasCards';

/**
 * #118: the floor overview's big screen on the lounge wall. A thin dark bezel box a few cm off the west wall, facing +x,
 * and in it the same tree as the page (ui/overview.ts) drawn on canvas textures: a header (the floor's name, the
 * counts) and under it the board, a line per worker with its light, name, ticket and now line. Unlit
 * (`MeshBasicMaterial`, not tone mapped), so it reads like a screen in any light, and it adds no light to the room (M17).
 *
 * Canvas work happens only when what it shows changes (at most once a second, the since column once a minute, never
 * for the live activity chip, which is the page's); nothing is drawn or uploaded to blink or to scroll:
 * - the board is one tall canvas of every row, shown through a window (the texture's repeat and offset): more rows
 *   than fit go one line a row, then the window scrolls down slowly and back to the top, so no row is cut off unsaid;
 * - the working lights blink by showing and hiding a second layer over the board, the same size, that holds only
 *   dark covers over those lights. Battery saver or reduced motion: steady lights, and the board jumps instead of
 *   gliding.
 * Out of view (or too small on it to read) it neither redraws nor scrolls.
 */

/** The screen's resolution, per metre of it, and the board canvas's tallest side (WebGL2's safe texture size). */
const PX_PER_M = 180;
const MAX_PX = 4096;
const BEZEL = 0.07;
/** The header's share of the screen's height. */
const HEAD = 0.27;
/** The board scrolls this many rows a second, and rests this long at the top and at the bottom. */
const SCROLL_ROWS_PER_S = 0.6;
const SCROLL_REST_MS = 4000;
/** The board is drawn at most this often: a busy floor's changes wait for the next one; the page is live. */
export const WALL_MIN_MS = 1000;

/** The departures board's own colours: the page's (overview.css). */
const INK = '#0b1022';
const INK_3 = '#1c2540';
const TEXT = '#eef2fb';
const TEXT_2 = '#b9c3dc';
const TEXT_3 = '#7d89ab';
const ACCENT = '#ffc233';
// The wall draws with the HUD's face, loaded with the game: the page's condensed Archivo and Departure Mono are fetched
// only when the page opens (a fresh load fetches the transcript preset's fonts only, #59).
const DISPLAY = FONT;
const MONO = FONT;

export interface WallPlan {
  compact: boolean;
  /** Rows the window shows at once. */
  fit: number;
  /** More rows than fit: the window scrolls through them. */
  scroll: boolean;
}

/** How `rows` fit `avail` px of board: two lines a row while they all fit, else one line a row, scrolling when even those do not. Pure. */
export function wallPlan(rows: number, avail: number, full: number, compact: number): WallPlan {
  const fitFull = Math.max(1, Math.floor(avail / full));
  if (rows <= fitFull) return { compact: false, fit: fitFull, scroll: false };
  const fit = Math.max(1, Math.floor(avail / compact));
  return { compact: true, fit, scroll: rows > fit };
}

/**
 * Where the window is (0 at the top, 1 at the bottom) `ms` into a scroll cycle of `extra` rows past the window: a
 * rest at the top, a slow scroll down, a rest at the bottom, a jump back (`glide` false: the scroll is a jump too). Pure.
 */
export function scrollAt(ms: number, extra: number, glide = true): number {
  if (extra <= 0) return 0;
  const run = (extra / SCROLL_ROWS_PER_S) * 1000;
  const cycle = SCROLL_REST_MS * 2 + run;
  const t = ((ms % cycle) + cycle) % cycle;
  if (t < SCROLL_REST_MS) return 0;
  if (t < SCROLL_REST_MS + run) return glide ? (t - SCROLL_REST_MS) / run : 1;
  return 1;
}

export interface OverviewScreenMesh {
  group: THREE.Group;
  /** What it shows (null: a sleeping floor's board); `calm`: no blinking, no gliding. */
  set(data: OverviewData | null, floor: string, calm: boolean, now: number): void;
  /** The blink and the scroll; true when the picture changed (a frame is due). `view`: it is in view and readable. */
  tick(now: number, view: boolean): boolean;
  info(): { lit: boolean; rows: number; compact: boolean; scroll: number; scrolling: boolean; draws: number; blinking: boolean; screenW: number; screenH: number };
  dispose(): void;
}

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function canvasTexture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** An unlit, not tone mapped picture material with its own program key (three r186: see render/tv.ts). */
function pictureMaterial(map: THREE.Texture, transparent: boolean): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ map, toneMapped: false, transparent, depthWrite: !transparent });
  const key = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => `${key()}|h3d-overview`;
  return m;
}

/** The screen on its wall: `box` is the prop's box, its front at max x, facing +x (into the lounge). */
export function buildOverviewScreen(box: Box3): OverviewScreenMesh {
  const group = new THREE.Group();
  group.name = 'screen.overview';
  const [x0, y0, z0] = box.min;
  const [x1, y1, z1] = box.max;
  const cz = (z0 + z1) / 2;
  const screenW = z1 - z0 - 2 * BEZEL;
  const screenH = y1 - y0 - 2 * BEZEL;
  const body = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), new THREE.MeshToonMaterial({ color: 0x141a2b }));
  body.position.set((x0 + x1) / 2, (y0 + y1) / 2, cz);
  body.receiveShadow = true;
  group.add(body);

  const scale = Math.min(PX_PER_M, 2048 / Math.max(screenW, screenH));
  const W = Math.round(screenW * scale);
  const H = Math.round(screenH * scale);
  const headH = Math.round(H * HEAD);
  const winH = H - headH;
  const u = H / 100; // a hundredth of the screen's height: the drawing's unit
  const fullRow = Math.max(40, H * 0.085);
  const compactRow = fullRow * 0.56;

  const plane = (h: number, mat: THREE.Material, top: number, dx: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(screenW, (h / H) * screenH).rotateY(Math.PI / 2), mat);
    m.position.set(x1 + dx, y1 - BEZEL - ((top + h / 2) / H) * screenH, cz);
    group.add(m);
    return m;
  };
  const headCanvas = canvas(W, headH);
  const headTex = canvasTexture(headCanvas);
  const headMat = pictureMaterial(headTex, false);
  plane(headH, headMat, 0, 0.003);
  // The board and its cover: canvases as tall as the rows need (made again when that changes), seen through a window.
  let boardCanvas = canvas(W, winH);
  let coverCanvas = canvas(W, winH);
  let boardTex = canvasTexture(boardCanvas);
  let coverTex = canvasTexture(coverCanvas);
  const boardMat = pictureMaterial(boardTex, false);
  const coverMat = pictureMaterial(coverTex, true);
  plane(winH, boardMat, headH, 0.003);
  const cover = plane(winH, coverMat, headH, 0.004);
  cover.visible = false;
  cover.renderOrder = 1;

  let data: OverviewData | null = null;
  let floor = '';
  let calm = false;
  let drawnKey = '';
  let draws = 0;
  let plan: WallPlan = { compact: false, fit: 1, scroll: false };
  let rows: VisibleRow[] = [];
  let minute = 0;
  let pending = false;
  let drawnAt = -Infinity;
  let inView = false;
  let lamps = 0;
  let scroll = 0;
  let scrollFrom = 0; // when the current scroll cycle began
  let coverOn = false;

  /** The window onto the board: its share of the canvas and where it is (0 the top, 1 the bottom). */
  const setWindow = (s: number) => {
    const rep = Math.min(1, winH / boardCanvas.height);
    for (const t of [boardTex, coverTex]) {
      t.repeat.set(1, rep);
      // Canvas y runs down, the texture's v up: the window's top is the board's top plus the scrolled part.
      t.offset.set(0, (1 - rep) * (1 - s));
    }
  };

  const resize = (h: number) => {
    if (boardCanvas.height === h) return;
    boardTex.dispose();
    coverTex.dispose();
    boardCanvas = canvas(W, h);
    coverCanvas = canvas(W, h);
    boardTex = canvasTexture(boardCanvas);
    coverTex = canvasTexture(coverCanvas);
    boardMat.map = boardTex;
    coverMat.map = coverTex;
    boardMat.needsUpdate = true;
    coverMat.needsUpdate = true;
  };

  const draw = (now: number) => {
    // Every row's since moves on the wall's own minute (not each row's), so a busy floor redraws once a minute.
    minute = Math.floor(now / 60_000);
    const at = minute * 60_000;
    const k = JSON.stringify([floor, data?.where, data?.counts, rows.map((v) => face(v, at)), plan, data === null]);
    if (k === drawnKey) return false;
    drawnKey = k;
    draws++;
    const rowH = plan.compact ? compactRow : fullRow;
    resize(Math.min(MAX_PX, Math.max(winH, Math.ceil(rows.length * rowH + u * 3))));
    const hg = headCanvas.getContext('2d');
    const bg = boardCanvas.getContext('2d');
    const cg = coverCanvas.getContext('2d');
    if (!hg || !bg || !cg) return false;
    paintHead(hg, W, headH, u, floor, data);
    const lit = paintBoard(bg, W, boardCanvas.height, u, data, rows, plan.compact, rowH, at);
    // The cover: the working lights' unlit half of the blink, nothing else.
    cg.clearRect(0, 0, W, coverCanvas.height);
    for (const l of lit) {
      cg.globalAlpha = 1;
      cg.fillStyle = INK;
      cg.beginPath();
      cg.arc(l.x, l.y, l.r * 1.3, 0, Math.PI * 2);
      cg.fill();
      cg.globalAlpha = 0.3;
      cg.fillStyle = STATUS_CSS.working;
      cg.beginPath();
      cg.arc(l.x, l.y, l.r, 0, Math.PI * 2);
      cg.fill();
    }
    cg.globalAlpha = 1;
    lamps = lit.length;
    headTex.needsUpdate = true;
    boardTex.needsUpdate = true;
    coverTex.needsUpdate = true;
    setWindow(scroll);
    return true;
  };

  /** Draws what `set` brought: at most every WALL_MIN_MS, and out of view only the first time. */
  const flush = (now: number, view: boolean) => {
    if (!pending || now - drawnAt < WALL_MIN_MS || (!view && drawnAt > -Infinity)) return false;
    pending = false;
    drawnAt = now;
    return draw(now);
  };

  return {
    group,
    set(d, f, c, now) {
      data = d;
      floor = f;
      calm = c;
      rows = d ? visibleRows(d.tree, new Set()) : [];
      plan = wallPlan(rows.length, winH - u * 3, fullRow, compactRow);
      pending = true;
      flush(now, inView);
    },
    tick(now, view) {
      inView = view;
      if (data && Math.floor(now / 60_000) !== minute) pending = true; // the since column
      let changed = flush(now, view);
      if (!view) {
        scrollFrom = now; // a look starts at the top
        return changed;
      }
      const s = scrollAt(now - scrollFrom, plan.scroll ? rows.length - plan.fit : 0, !calm);
      if (s !== scroll) {
        scroll = s;
        setWindow(s);
        changed = true;
      }
      const off = !calm && lamps > 0 && Math.floor(now / (BLINK_MS / 2)) % 2 === 1;
      if (off !== coverOn) {
        coverOn = off;
        cover.visible = off;
        changed = true;
      }
      return changed;
    },
    info: () => ({ lit: data !== null, rows: rows.length, compact: plan.compact, scroll: +scroll.toFixed(3), scrolling: plan.scroll, draws, blinking: !calm && lamps > 0, screenW, screenH }),
    dispose() {
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
      headTex.dispose();
      boardTex.dispose();
      coverTex.dispose();
      group.removeFromParent();
    },
  };
}

/** What a row shows on the wall (its redraw key): never the live activity, which moves all the time. */
function face(v: VisibleRow, now: number): unknown[] {
  const r = v.row;
  if (r.kind !== 'worker') return [r.key, r.kind, v.depth, r.kind === 'ghost' ? [r.name, r.floor] : null];
  return [r.key, v.depth, r.name, r.display, r.tag, r.runColor, r.model, ticketLine(r), lineText(r), sinceText(r.display, r.since, now)];
}

let scanlines: HTMLCanvasElement | null = null;

/** The glass: ink and faint scanlines, in two fills. */
function glass(g: CanvasRenderingContext2D, W: number, H: number): void {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = INK;
  g.fillRect(0, 0, W, H);
  if (!scanlines) {
    scanlines = document.createElement('canvas');
    scanlines.width = 1;
    scanlines.height = 4;
    const sg = scanlines.getContext('2d');
    if (sg) {
      sg.fillStyle = 'rgba(255,255,255,0.025)';
      sg.fillRect(0, 0, 1, 1);
    }
  }
  const pat = g.createPattern(scanlines, 'repeat');
  if (pat) {
    g.fillStyle = pat;
    g.fillRect(0, 0, W, H);
  }
}

/** The header: the floor's name (the destination), where it is, the counts as flaps. */
function paintHead(g: CanvasRenderingContext2D, W: number, H: number, u: number, floor: string, data: OverviewData | null): void {
  glass(g, W, H);
  const pad = Math.round(W * 0.035);
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  g.fillStyle = ACCENT;
  g.font = `860 ${Math.round(u * 13)}px ${DISPLAY}`;
  fitText(g, floor.toUpperCase(), pad, u * 14, W - pad * 2);
  g.font = `400 ${Math.round(u * 3.1)}px ${MONO}`;
  g.fillStyle = TEXT_2;
  g.fillText(data ? `${data.where} · Floor overview` : 'Floor overview', pad, u * 19);
  let x = pad;
  for (const c of data?.counts ?? []) {
    const fy = u * 20.5;
    const fh = u * 5.2;
    const fw = u * 4;
    const digits = String(c.n).padStart(2, '0');
    for (let i = 0; i < digits.length; i++) {
      const fx = x + i * (fw + u * 0.4);
      g.fillStyle = '#1a2342';
      roundRect(g, fx, fy, fw, fh, u * 0.5);
      g.fillStyle = TEXT;
      g.font = `400 ${Math.round(u * 4)}px ${MONO}`;
      g.textAlign = 'center';
      g.fillText(digits[i] as string, fx + fw / 2, fy + fh * 0.78);
      g.textAlign = 'left';
    }
    x += digits.length * (fw + u * 0.4) + u * 1.2;
    g.fillStyle = STATUS_CSS[c.kind];
    g.beginPath();
    g.arc(x + u * 0.7, fy + fh / 2, u * 0.7, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = TEXT_2;
    g.font = `600 ${Math.round(u * 3)}px ${FONT}`;
    g.fillText(c.label, x + u * 2, fy + fh * 0.68);
    x += u * 2.4 + g.measureText(c.label).width + u * 3;
  }
  g.fillStyle = INK_3;
  g.fillRect(pad, H - Math.max(2, u * 0.3), W - pad * 2, Math.max(2, u * 0.3));
}

/** The board: a line per row (two in full mode); returns where the working lights are (the cover dims them). */
function paintBoard(g: CanvasRenderingContext2D, W: number, H: number, u: number, data: OverviewData | null, rows: VisibleRow[], compact: boolean, rowH: number, now: number): Array<{ x: number; y: number; r: number }> {
  const lamps: Array<{ x: number; y: number; r: number }> = [];
  glass(g, W, H);
  const pad = Math.round(W * 0.035);
  const top = u * 1.5;
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  if (!data) {
    g.fillStyle = TEXT_3;
    g.font = `600 ${Math.round(u * 4)}px ${FONT}`;
    g.fillText('Asleep', pad, top + u * 6);
    return lamps;
  }
  if (!rows.length) {
    g.fillStyle = TEXT;
    g.font = `800 ${Math.round(u * 7)}px ${DISPLAY}`;
    g.fillText('NOBODY’S HERE YET', pad, top + u * 8);
    g.fillStyle = TEXT_2;
    g.font = `400 ${Math.round(u * 3.2)}px ${FONT}`;
    g.fillText('Look at a desk’s + and press E to hire someone.', pad, top + u * 13);
    return lamps;
  }
  const colWho = pad + u * 6;
  const colWhat = pad + W * 0.33;
  const sinceRight = W - pad;
  rows.forEach((v, i) => {
    const y = top + i * rowH;
    const mid = y + (compact ? rowH / 2 : rowH * 0.32);
    const r = v.row;
    const indent = v.depth ? u * 3 : 0;
    const lx = pad + u * 1.6 + indent;
    if (r.kind === 'worker') {
      if (r.display === 'working') lamps.push({ x: lx, y: mid, r: u * 1.1 });
      if (r.display === 'asleep') ring(g, lx, mid, u * 1.1, STATUS_CSS.asleep, u * 0.35);
      else {
        g.fillStyle = STATUS_CSS[r.display];
        g.beginPath();
        g.arc(lx, mid, u * 1.1, 0, Math.PI * 2);
        g.fill();
        if (r.display === 'needs_you') ring(g, lx, mid, u * 1.9, STATUS_CSS.needs_you, u * 0.3);
      }
    } else ring(g, lx, mid, u * 1.1, STATUS_CSS.idle, u * 0.35);
    if (v.depth) {
      g.strokeStyle = 'rgba(185,195,220,0.32)';
      g.lineWidth = Math.max(1, u * 0.2);
      g.beginPath();
      g.moveTo(pad + u * 1.6, y - rowH * 0.2);
      g.lineTo(pad + u * 1.6, mid);
      g.lineTo(lx - u * 1.4, mid);
      g.stroke();
    }
    const nameSize = Math.round(compact ? u * 3.6 : u * 4.4);
    g.font = `800 ${nameSize}px ${DISPLAY}`;
    g.fillStyle = r.kind === 'worker' ? (r.display === 'asleep' ? TEXT_3 : TEXT) : TEXT_2;
    const name = r.kind === 'worker' ? r.name : r.kind === 'ghost' ? `Orchestrator ${r.name} · ${r.floor}` : 'Unlinked';
    const base = mid + nameSize * 0.36;
    const nameW = fitText(g, name.toUpperCase(), colWho + indent, base, colWhat - colWho - indent - u * 9);
    if (r.kind === 'worker' && r.tag) chip(g, r.tag, colWho + indent + nameW + u * 1.2, mid, u, r.runColor !== null ? `#${r.runColor.toString(16).padStart(6, '0')}` : INK_3);
    if (r.kind !== 'worker') return;
    g.font = `400 ${Math.round(u * 2.8)}px ${MONO}`;
    g.fillStyle = TEXT_2;
    g.textAlign = 'right';
    const since = sinceText(r.display, r.since, now);
    g.fillText(since, sinceRight, base);
    const sinceW = g.measureText(since).width;
    g.textAlign = 'left';
    const whatW = sinceRight - sinceW - u * 3 - colWhat;
    const ticket = ticketLine(r);
    const first = ticket ?? lineText(r);
    const second = ticket ? lineText(r) : null;
    if (first) {
      g.font = `600 ${Math.round(u * 3.2)}px ${FONT}`;
      g.fillStyle = ticket ? TEXT : TEXT_2;
      fitText(g, first, colWhat, base, whatW);
    }
    if (!compact) {
      if (second) {
        g.font = `400 ${Math.round(u * 2.9)}px ${FONT}`;
        g.fillStyle = TEXT_2;
        fitText(g, second, colWhat, base + u * 4.2, whatW);
      }
      if (r.model) {
        g.font = `400 ${Math.round(u * 2.5)}px ${MONO}`;
        g.fillStyle = TEXT_3;
        fitText(g, r.model, colWho + indent, base + u * 4.2, colWhat - colWho - indent - u * 3);
      }
    }
  });
  return lamps;
}

/** `#118 · Floor overview` (the wall shows the ticket in its row's first line). */
function ticketLine(r: OverviewWorkerRow): string | null {
  return r.ticket ? `${r.ticket.key}${r.ticket.title ? ` · ${r.ticket.title}` : ''}` : null;
}

/** The task and the now line (the activity chip is the page's: it moves too often for a wall to redraw). */
function lineText(r: OverviewWorkerRow): string | null {
  const now = r.now?.text ?? '';
  if (r.task && !now) return r.task.text;
  if (r.task) return `${r.task.text} — ${now}`;
  return now || null;
}

/** Draws `s` from `x`, clipped with an ellipsis to `max` px; returns the width drawn. */
function fitText(g: CanvasRenderingContext2D, s: string, x: number, y: number, max: number): number {
  if (max <= 0) return 0;
  let t = s;
  if (g.measureText(t).width > max) {
    const cps = [...s];
    let lo = 0;
    let hi = cps.length;
    while (lo < hi) {
      const m = Math.ceil((lo + hi) / 2);
      if (g.measureText(`${cps.slice(0, m).join('')}…`).width <= max) lo = m;
      else hi = m - 1;
    }
    t = `${cps.slice(0, lo).join('').trimEnd()}…`;
  }
  g.fillText(t, x, y);
  return Math.min(max, g.measureText(t).width);
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
  g.fill();
}

function ring(g: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, w: number): void {
  g.strokeStyle = color;
  g.lineWidth = w;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.stroke();
}

function chip(g: CanvasRenderingContext2D, text: string, x: number, mid: number, u: number, bg: string): void {
  g.font = `400 ${Math.round(u * 2.2)}px ${MONO}`;
  const w = g.measureText(text).width + u * 1.6;
  g.fillStyle = bg;
  roundRect(g, x, mid - u * 1.5, w, u * 3, u * 0.4);
  g.fillStyle = '#ffffff';
  g.fillText(text, x + u * 0.8, mid + u * 0.75);
}

/** The status colours the wall draws with: the shared palette (exported for the contrast test). */
export const WALL_STATUS = { light: STATUS_CSS, chip: STATUS_CHIP_CSS, ink: INK };
