import * as THREE from 'three/webgpu';
import type { Box3 } from '../world/layout';
import {
  ageText,
  BLINK_MS,
  CHILD_TRANSCRIPT_WORD,
  childShortName,
  childSinceText,
  endedChildGroups,
  sinceText,
  visibleRows,
  type OverviewChildRow,
  type OverviewData,
  type OverviewLine,
  type OverviewWorkerRow,
  type VisibleRow,
} from '../world/overview';
import { lineStatusText } from '../world/digestSettings';
import { STATUS_CSS, STATUS_CHIP_CSS, WALL, type WallPalette } from './palette';
import { drawMark, markFor } from './brandMarks';
import { SPARKLE_D } from '../ui/dom';

/**
 * #118: the floor overview's big screen on the lounge wall. A thin dark bezel box a few cm off the west wall, facing +x,
 * and in it the same tree as the page (ui/overview.ts) drawn on canvas textures: a header (the floor's name, the
 * counts) and under it the board, a line per worker with its light, name, ticket and now line. Unlit
 * (`MeshBasicMaterial`, not tone mapped), so it reads like a screen in any light, and it adds no light to the room (M17).
 *
 * Canvas work happens only when what it shows changes (at most once a second, the since column once a minute, never
 * for the live activity, which is the page's); nothing is drawn or uploaded to blink or to scroll:
 * - the board is one tall canvas of the rows, shown through a window (the texture's repeat and offset): more rows
 *   than fit go one line a row, then the window scrolls down slowly and back to the top, so no row is cut off unsaid;
 *   a floor with more rows than one canvas holds (WebGL2's 4096 px) is drawn a page of them at a time, each page
 *   overlapping the next by a window: the window scrolls down a page, the next one is drawn where it ended, and after
 *   the last it goes back to the first, so every row comes by in a cycle;
 * - the working lights blink by showing and hiding a second layer over the board, the same size, that holds only
 *   dark covers over those lights. Battery saver or reduced motion: steady lights, and the board jumps instead of
 *   gliding.
 * Out of view (or too small on it to read) it neither redraws nor scrolls.
 *
 * #24: the workers' native children nest under them as quieter lines (a diamond pip, the provider's mark, the name a
 * size down, what each was asked, its state in words), every group open but an ended child's own children (the page's
 * default); the indent stops at `WALL_NEST_MAX` levels. A long list rides the same scroll and pages.
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
/** #24: nesting levels the wall's indent follows (the page's NEST_MAX); deeper rows share the last one. */
export const WALL_NEST_MAX = 4;

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

/** A page of the board: the rows `start` to `start + count`. */
export interface WallPage {
  start: number;
  count: number;
}

/**
 * The board's pages: one while `rows` fit a canvas (`cap` rows), else pages of `cap` rows, each starting a window
 * (`fit` rows) before the previous one ended, the last one ending at the last row: every row is on a page. Pure.
 */
export function wallPages(rows: number, cap: number, fit: number): WallPage[] {
  cap = Math.max(1, Math.floor(cap));
  if (rows <= cap) return [{ start: 0, count: rows }];
  const step = Math.max(1, cap - Math.min(fit, cap - 1));
  const out: WallPage[] = [];
  for (let start = 0; ; start += step) {
    const s = Math.min(start, rows - cap);
    out.push({ start: s, count: cap });
    if (s + cap >= rows) return out;
  }
}

/** How long the window spends on a page of `extra` rows past it: the two rests and the glide. */
const pageMs = (extra: number) => SCROLL_REST_MS * 2 + (Math.max(0, extra) / SCROLL_ROWS_PER_S) * 1000;

/**
 * Which page the window is on and where on it (`scrollAt`), `ms` into a cycle through pages that each have `extras[i]`
 * rows past the window. One page: `scrollAt`'s cycle. Pure.
 */
export function wallCycle(ms: number, extras: readonly number[], glide = true): { page: number; s: number } {
  if (extras.length <= 1) return { page: 0, s: scrollAt(ms, extras[0] ?? 0, glide) };
  const total = extras.reduce((a, e) => a + pageMs(e), 0);
  let t = ((ms % total) + total) % total;
  for (let i = 0; i < extras.length; i++) {
    const len = pageMs(extras[i] as number);
    if (t < len || i === extras.length - 1) return { page: i, s: scrollAt(t, extras[i] as number, glide) };
    t -= len;
  }
  return { page: 0, s: 0 };
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
  info(): { lit: boolean; rows: number; compact: boolean; scroll: number; scrolling: boolean; draws: number; blinking: boolean; screenW: number; screenH: number; page: number; pages: WallPage[] };
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

/** An unlit, not tone mapped picture material with its own program key (three r186: see render/tv.ts). #65: the departures boards' too. */
export function pictureMaterial(map: THREE.Texture, transparent: boolean, program = 'h3d-overview'): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ map, toneMapped: false, transparent, depthWrite: !transparent });
  const key = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => `${key()}|${program}`;
  return m;
}

/** The screen on its wall: `box` is the prop's box, its front at max x, facing +x (into the lounge). */
export function buildOverviewScreen(box: Box3, c: Readonly<WallPalette> = WALL): OverviewScreenMesh {
  const group = new THREE.Group();
  group.name = 'screen.overview';
  const [x0, y0, z0] = box.min;
  const [x1, y1, z1] = box.max;
  const cz = (z0 + z1) / 2;
  const screenW = z1 - z0 - 2 * BEZEL;
  const screenH = y1 - y0 - 2 * BEZEL;
  const body = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), new THREE.MeshToonMaterial({ color: c.housing }));
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
  let pages: WallPage[] = [{ start: 0, count: 0 }];
  let page = 0;
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
    const pg = pages[page] ?? { start: 0, count: rows.length };
    const shown = rows.slice(pg.start, pg.start + pg.count);
    const k = JSON.stringify([floor, data?.where, data?.counts, shown.map((v) => face(v, at)), plan, pg, data === null]);
    if (k === drawnKey) return false;
    drawnKey = k;
    draws++;
    const rowH = plan.compact ? compactRow : fullRow;
    resize(Math.min(MAX_PX, Math.max(winH, Math.ceil(shown.length * rowH + u * 3))));
    const hg = headCanvas.getContext('2d');
    const bg = boardCanvas.getContext('2d');
    const cg = coverCanvas.getContext('2d');
    if (!hg || !bg || !cg) return false;
    paintHead(hg, c, W, headH, u, floor, data);
    const lit = paintBoard(bg, c, W, boardCanvas.height, u, data, shown, plan.compact, rowH, at);
    // The cover: the working lights' unlit half of the blink, nothing else.
    cg.clearRect(0, 0, W, coverCanvas.height);
    for (const l of lit) {
      cg.globalAlpha = 1;
      cg.fillStyle = c.ink;
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
      rows = d ? visibleRows(d.tree, new Set(endedChildGroups(d.tree))) : [];
      plan = wallPlan(rows.length, winH - u * 3, fullRow, compactRow);
      // The rows one canvas holds: more than that go in pages (wallPages), never cut off.
      const cap = Math.floor((MAX_PX - u * 3) / (plan.compact ? compactRow : fullRow));
      pages = wallPages(rows.length, cap, plan.fit);
      if (page >= pages.length) page = 0;
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
      const at = wallCycle(
        now - scrollFrom,
        pages.map((p) => (plan.scroll ? p.count - plan.fit : 0)),
        !calm,
      );
      const s = at.s;
      if (at.page !== page) {
        // The next page: drawn now (a page turn is rare, a minute or more apart), where the window is on it.
        page = at.page;
        scroll = s;
        pending = false;
        drawnAt = now;
        if (draw(now)) changed = true;
      }
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
    info: () => ({ lit: data !== null, rows: rows.length, compact: plan.compact, scroll: +scroll.toFixed(3), scrolling: plan.scroll, draws, blinking: !calm && lamps > 0, screenW, screenH, page, pages: pages.map((p) => ({ ...p })) }),
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
  if (r.kind === 'child') return [r.key, v.depth, v.more, r.name, r.type, r.model, markFor(r.provider), r.state, r.unresolved, r.description, r.transcript, childSinceText(r, now)];
  if (r.kind !== 'worker') return [r.key, r.kind, v.depth, v.more, r.kind === 'ghost' ? [r.name, r.floor] : null];
  return [r.key, v.depth, v.more, r.name, r.display, markFor(r.harness), wallTag(r), !!r.orch?.overCap, r.runColor, metaLine(r), ticketLine(r), lineSegs(r, now), sinceText(r.display, r.since, now)];
}

let scanlines: HTMLCanvasElement | null = null;

/** The glass: ink and faint scanlines, in two fills. #65: the departures boards' glass too. */
export function glass(g: CanvasRenderingContext2D, W: number, H: number, c: Readonly<WallPalette>): void {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = c.ink;
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
function paintHead(g: CanvasRenderingContext2D, c: Readonly<WallPalette>, W: number, H: number, u: number, floor: string, data: OverviewData | null): void {
  glass(g, W, H, c);
  const pad = Math.round(W * 0.035);
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  g.fillStyle = c.accent;
  g.font = `860 ${Math.round(u * 13)}px ${c.font}`;
  fitText(g, floor.toUpperCase(), pad, u * 14, W - pad * 2);
  g.font = `400 ${Math.round(u * 3.1)}px ${c.font}`;
  g.fillStyle = c.text2;
  g.fillText(data ? `${data.where} · Floor overview` : 'Floor overview', pad, u * 19);
  let x = pad;
  for (const k of data?.counts ?? []) {
    const fy = u * 20.5;
    const fh = u * 5.2;
    const fw = u * 4;
    const digits = String(k.n).padStart(2, '0');
    for (let i = 0; i < digits.length; i++) {
      const fx = x + i * (fw + u * 0.4);
      g.fillStyle = c.flap;
      roundRect(g, fx, fy, fw, fh, u * 0.5);
      g.fillStyle = c.text;
      g.font = `400 ${Math.round(u * 4)}px ${c.font}`;
      g.textAlign = 'center';
      g.fillText(digits[i] as string, fx + fw / 2, fy + fh * 0.78);
      g.textAlign = 'left';
    }
    x += digits.length * (fw + u * 0.4) + u * 1.2;
    g.fillStyle = STATUS_CSS[k.kind];
    g.beginPath();
    g.arc(x + u * 0.7, fy + fh / 2, u * 0.7, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = c.text2;
    g.font = `600 ${Math.round(u * 3)}px ${c.font}`;
    g.fillText(k.label, x + u * 2, fy + fh * 0.68);
    x += u * 2.4 + g.measureText(k.label).width + u * 3;
  }
  g.fillStyle = c.ink3;
  g.fillRect(pad, H - Math.max(2, u * 0.3), W - pad * 2, Math.max(2, u * 0.3));
}

/** The board: a line per row (two in full mode); returns where the working lights are (the cover dims them). */
function paintBoard(g: CanvasRenderingContext2D, c: Readonly<WallPalette>, W: number, H: number, u: number, data: OverviewData | null, rows: VisibleRow[], compact: boolean, rowH: number, now: number): Array<{ x: number; y: number; r: number }> {
  const lamps: Array<{ x: number; y: number; r: number }> = [];
  glass(g, W, H, c);
  const pad = Math.round(W * 0.035);
  const top = u * 1.5;
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  if (!data) {
    g.fillStyle = c.text3;
    g.font = `600 ${Math.round(u * 4)}px ${c.font}`;
    g.fillText('Asleep', pad, top + u * 6);
    return lamps;
  }
  if (!rows.length) {
    g.fillStyle = c.text;
    g.font = `800 ${Math.round(u * 7)}px ${c.font}`;
    g.fillText('NOBODY’S HERE YET', pad, top + u * 8);
    g.fillStyle = c.text2;
    g.font = `400 ${Math.round(u * 3.2)}px ${c.font}`;
    g.fillText('Look at a desk’s + and press E to hire someone.', pad, top + u * 13);
    return lamps;
  }
  const colWho = pad + u * 6;
  const colWhat = pad + W * 0.36;
  const sinceRight = W - pad;
  rows.forEach((v, i) => {
    const y = top + i * rowH;
    const mid = y + (compact ? rowH / 2 : rowH * 0.32);
    const r = v.row;
    const nest = Math.min(v.depth, WALL_NEST_MAX);
    const indent = nest * u * 3;
    const lx = pad + u * 1.6 + indent;
    if (v.depth) wires(g, c, v.more, pad + u * 1.6, u, y, mid, rowH, lx - u * 1.4, r.kind === 'child' && r.unresolved);
    if (r.kind === 'child') {
      paintChild(g, c, r, { y, mid, rowH, compact, u, lx, colWho: colWho + indent, colWhat, sinceRight, now });
      return;
    }
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
    const nameSize = Math.round(compact ? u * 3.6 : u * 4.4);
    g.fillStyle = r.kind === 'worker' ? (r.display === 'asleep' ? c.text3 : c.text) : c.text2;
    const name = r.kind === 'worker' ? r.name : r.kind === 'ghost' ? `Orchestrator ${r.name} · ${r.floor}` : 'Unlinked';
    const base = mid + nameSize * 0.36;
    // #229: the harness's mark before a worker's name, as tall as its capitals, on their baseline; then the role chip
    // and an orchestrator's over-cap badge after it, the name giving way to them.
    const mark = r.kind === 'worker' ? markFor(r.harness) : null;
    const nameX = colWho + indent + (mark ? nameSize * 0.92 : 0);
    if (mark) {
      const ink = g.fillStyle;
      g.fillStyle = r.kind === 'worker' && r.display === 'asleep' ? c.text3 : '#ffffff';
      drawMark(g, mark, colWho + indent + nameSize * 0.36, base - nameSize * 0.36, nameSize * 0.72);
      g.fillStyle = ink;
    }
    const tag = r.kind === 'worker' ? wallTag(r) : null;
    const cap = r.kind === 'worker' && r.orch?.overCap ? 'OVER CAP' : null;
    const chipsW = (tag ? chipW(g, tag, u, c.font) + u * 1.2 : 0) + (cap ? chipW(g, cap, u, c.font) + u * 1.2 : 0);
    g.font = `800 ${nameSize}px ${c.font}`;
    const nameW = fitText(g, name.toUpperCase(), nameX, base, colWhat - nameX - Math.max(u * 9, chipsW + u));
    let cx = nameX + nameW + u * 1.2;
    if (r.kind === 'worker' && tag) cx += chip(g, tag, cx, mid, u, r.runColor !== null ? `#${r.runColor.toString(16).padStart(6, '0')}` : c.ink3, c.font) + u * 1.2;
    if (cap) chip(g, cap, cx, mid, u, STATUS_CHIP_CSS.needs_you, c.font);
    if (r.kind !== 'worker') return;
    g.font = `400 ${Math.round(u * 2.8)}px ${c.font}`;
    g.fillStyle = c.text2;
    g.textAlign = 'right';
    const since = sinceText(r.display, r.since, now);
    g.fillText(since, sinceRight, base);
    const sinceW = g.measureText(since).width;
    g.textAlign = 'left';
    const whatW = sinceRight - sinceW - u * 3 - colWhat;
    const [first, second] = whatLines(r, compact, now);
    // The task and now lines under their labels, each with the page's AI sparkle by its label when the LLM wrote it
    // (#118 phase 2, #232) and its words (the now line's age, #198) quiet after its text.
    const big = `600 ${Math.round(u * 3.2)}px ${c.font}`;
    if (first) {
      const w = drawLine(g, c, first, colWhat, base, whatW, u, big, r.ticket ? c.text : c.text2);
      // One line a row: the ticket's key, then what it does now, never dropped for the ticket's title.
      if (compact && second) {
        g.font = big;
        g.fillStyle = c.text2;
        const sep = fitText(g, ' · ', colWhat + w, base, whatW - w);
        drawLine(g, c, second, colWhat + w + sep, base, whatW - w - sep, u, big, c.text2);
      }
    }
    if (!compact) {
      if (second) drawLine(g, c, second, colWhat, base + u * 4.2, whatW, u, `400 ${Math.round(u * 2.9)}px ${c.font}`, c.text2);
      const meta = metaLine(r);
      if (meta) {
        g.font = `400 ${Math.round(u * 2.5)}px ${c.font}`;
        g.fillStyle = c.text3;
        fitText(g, meta, colWho + indent, base + u * 4.2, colWhat - colWho - indent - u * 3);
      }
    }
  });
  return lamps;
}


/**
 * The tree's wires of a nested row (#24: at any depth, the page's): down each ancestor's level that runs on below it
 * (`more`), and at its own the line from its parent's light to its elbow, on down when a sibling follows. Past
 * WALL_NEST_MAX the deeper levels share the last column. An unresolved child's elbow is detached and dashed: under its
 * worker, never drawn as started by it.
 */
function wires(g: CanvasRenderingContext2D, c: Readonly<WallPalette>, more: readonly boolean[], x0: number, u: number, y: number, mid: number, rowH: number, to: number, detached: boolean): void {
  const vis = Math.min(more.length, WALL_NEST_MAX);
  const x = (level: number) => x0 + (level - 1) * u * 3;
  g.strokeStyle = `rgba(${c.rule},0.32)`;
  g.lineWidth = Math.max(1, u * 0.2);
  g.beginPath();
  for (let l = 1; l < vis; l++) {
    if (!more[l - 1]) continue;
    g.moveTo(x(l), y);
    g.lineTo(x(l), y + rowH);
  }
  const own = x(vis);
  const on = more.slice(vis - 1).some(Boolean);
  if (on || !detached) {
    g.moveTo(own, y - rowH * 0.2);
    g.lineTo(own, on ? y + rowH : mid);
  }
  if (!detached) {
    g.moveTo(own, mid);
    g.lineTo(to, mid);
  }
  g.stroke();
  if (!detached) return;
  g.setLineDash([u * 0.5, u * 0.6]);
  g.beginPath();
  g.moveTo(own + u * 0.9, mid);
  g.lineTo(to, mid);
  g.stroke();
  g.setLineDash([]);
}

/** #24: a child's pip on the wall: its state's diamond (filled, ringed, half filled, or dashed for `unknown`). */
function pip(g: CanvasRenderingContext2D, c: Readonly<WallPalette>, r: OverviewChildRow, x: number, y: number, s: number, u: number): void {
  const diamond = () => {
    g.beginPath();
    g.moveTo(x, y - s);
    g.lineTo(x + s, y);
    g.lineTo(x, y + s);
    g.lineTo(x - s, y);
    g.closePath();
  };
  const fill = r.state === 'running' ? STATUS_CSS.working : r.state === 'completed' ? STATUS_CSS.done : null;
  const ink = fill ?? (r.state === 'shut_down' ? STATUS_CSS.asleep : r.state === 'interrupted' ? STATUS_CSS.waiting : r.state === 'unknown' ? c.text3 : STATUS_CSS.idle);
  diamond();
  if (fill) {
    g.fillStyle = fill;
    g.fill();
    return;
  }
  if (r.state === 'interrupted') {
    g.save();
    g.clip();
    g.fillStyle = ink;
    g.fillRect(x - s, y - s, s * 2, s);
    g.restore();
    diamond();
  }
  g.strokeStyle = ink;
  g.lineWidth = u * 0.3;
  if (r.state === 'unknown') g.setLineDash([u * 0.4, u * 0.4]);
  g.stroke();
  g.setLineDash([]);
}

/**
 * #24: a native child's line on the wall: its pip, the provider's mark and its name (a size down, not in capitals), a
 * `PARENT UNKNOWN` chip for an unresolved one, what it was asked and its transcript's availability, its state and time at
 * the right; in full mode its type under the name.
 */
function paintChild(
  g: CanvasRenderingContext2D,
  c: Readonly<WallPalette>,
  r: OverviewChildRow,
  o: { y: number; mid: number; rowH: number; compact: boolean; u: number; lx: number; colWho: number; colWhat: number; sinceRight: number; now: number },
): void {
  const { mid, compact, u, colWho, colWhat, sinceRight } = o;
  pip(g, c, r, o.lx, mid, u * 0.95, u);
  const nameSize = Math.round(compact ? u * 3 : u * 3.6);
  const base = mid + nameSize * 0.36;
  const mark = markFor(r.provider);
  const nameX = colWho + (mark ? nameSize * 0.92 : 0);
  if (mark) {
    g.fillStyle = '#ffffff';
    drawMark(g, mark, colWho + nameSize * 0.36, base - nameSize * 0.36, nameSize * 0.72);
  }
  const orphan = r.unresolved ? 'PARENT UNKNOWN' : null;
  const chipsW = orphan ? chipW(g, orphan, u, c.font) + u * 1.2 : 0;
  g.font = `700 ${nameSize}px ${c.font}`;
  g.fillStyle = c.text;
  const nameW = fitText(g, childShortName(r.name), nameX, base, colWhat - nameX - Math.max(u * 6, chipsW + u));
  if (orphan) {
    // Dashed, like its elbow: a chip that says what is missing, not a role.
    const cx = nameX + nameW + u * 1.2;
    const w = chipW(g, orphan, u, c.font);
    g.strokeStyle = c.text3;
    g.lineWidth = Math.max(1, u * 0.2);
    g.setLineDash([u * 0.5, u * 0.4]);
    g.beginPath();
    g.roundRect(cx, mid - u * 1.5, w, u * 3, u * 0.4);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = c.text2;
    g.fillText(orphan, cx + u * 0.8, mid + u * 0.75);
  }
  g.font = `400 ${Math.round(u * 2.6)}px ${c.font}`;
  g.fillStyle = r.state === 'unknown' ? c.text3 : c.text2;
  g.textAlign = 'right';
  const since = childSinceText(r, o.now);
  g.fillText(since, sinceRight, base);
  const sinceW = g.measureText(since).width;
  g.textAlign = 'left';
  // What it was asked, then its transcript's availability, quiet (that keeps its room; the description gives way).
  const room = sinceRight - sinceW - u * 3 - colWhat;
  const small = `400 ${Math.round(u * 2.4)}px ${c.font}`;
  const tx = CHILD_TRANSCRIPT_WORD[r.transcript];
  g.font = small;
  const txW = g.measureText(tx).width;
  g.font = `400 ${Math.round(u * (compact ? 2.8 : 3))}px ${c.font}`;
  g.fillStyle = r.description ? c.text2 : c.text3;
  const w = fitText(g, r.description ?? 'No task description', colWhat, base, room - txW - u * 2);
  g.font = small;
  g.fillStyle = c.text3;
  fitText(g, tx, colWhat + w + u * 2, base, room - w - u * 2);
  if (compact) return;
  g.font = `400 ${Math.round(u * 2.4)}px ${c.font}`;
  g.fillStyle = c.text3;
  fitText(g, childMeta(r), colWho, base + u * 3.8, colWhat - colWho - u * 3);
}

/**
 * #24: under a child's name on the wall (full mode): a provider without a mark, its type when it has a name, what it runs
 * on when known, `subagent`.
 */
export function childMeta(r: OverviewChildRow): string {
  return [markFor(r.provider) ? null : r.provider || null, r.type, r.model || null, 'subagent'].filter(Boolean).join(' · ');
}

/** `#118 · Floor overview` (the wall shows the ticket in its row's first line). */
function ticketLine(r: OverviewWorkerRow): string | null {
  return r.ticket ? `${r.ticket.key}${r.ticket.title ? ` · ${r.ticket.title}` : ''}` : null;
}

/** #232: a task or now line on the wall: its label, its text, and the words after its AI sparkle (null: no sparkle). */
export interface WallSeg {
  label: 'TASK' | 'NOW';
  text: string;
  words: string | null;
}

/** The ticket's line, or the row's task and now lines (one wall line, each under its own label). */
export type WallLine = string | WallSeg[];

/**
 * A row's what column on the wall: two lines, the ticket then the task and now lines; one line (`compact`), the
 * ticket's key alone then the task and now lines (what it does now beats the ticket's title), else the ticket's line.
 * Pure (exported for its test).
 */
export function whatLines(r: OverviewWorkerRow, compact: boolean, now: number): [WallLine | null, WallLine | null] {
  const ticket = ticketLine(r);
  const segs = lineSegs(r, now);
  const line = segs.length ? segs : null;
  if (!ticket) return [line, null];
  if (compact && line) return [r.ticket?.key ?? ticket, line];
  return [ticket, compact ? null : line];
}
/**
 * #229: the model under the name, its readable name and effort (`Opus 5.5 high`), never the run's words (the chips say
 * ORCH, the round and over cap); a harness without a mark says its name before it.
 */
export function metaLine(r: OverviewWorkerRow): string {
  return [markFor(r.harness) ? null : r.harness, r.model].filter(Boolean).join(' ');
}

/** The role chip: an orchestrator's carries its round (`ORCH r2`), as a freelancer's does, for the one-line rows. */
export function wallTag(r: OverviewWorkerRow): string | null {
  return r.tag && r.orch?.round ? `${r.tag} r${r.orch.round}` : r.tag;
}

/** The task and the now line, each under its label (the live activity is the page's: it moves too often for a wall to redraw). Pure. */
export function lineSegs(r: OverviewWorkerRow, now: number): WallSeg[] {
  const segs: WallSeg[] = [];
  if (r.task) segs.push({ label: 'TASK', text: r.task.text, words: lineMark(r.task, 'task', now) });
  if (r.now?.text) segs.push({ label: 'NOW', text: r.now.text, words: lineMark(r.now, 'now', now) });
  return segs;
}

/**
 * #198, #232: the words after a line's AI sparkle (null: the LLM did not write it, no sparkle): how long ago the model
 * wrote it, then a failed refresh of it (`2m ago · refresh failed`, the page's chip); a line with no time (a task line,
 * a now line without one) has none made up, only what became of it, if anything ('': the sparkle alone).
 * Pure (for its test).
 */
export function lineMark(l: OverviewLine, kind: 'task' | 'now', now: number): string | null {
  if (!l.llm) return null;
  return [l.at ? ageText(l.at, now) : null, l.status ? lineStatusText(l.status, kind, true).chip : null].filter(Boolean).join(' · ');
}

/** Where a wall line's parts go: a segment's start, whether its sparkle shows, its text's room, its words (shrunk). */
export interface SegPlan {
  seg: WallSeg;
  x: number;
  sparkle: boolean;
  textMax: number;
  words: string;
}

/** The wall line's measures (in u): the sparkle, the label to it, the label (or sparkle) to the text, the text to its words, a segment to the next. */
const SPARK = 2.8;
const GAP_SPARK = 0.6;
const GAP_TEXT = 1.2;
const GAP_WORDS = 1.4;
const GAP_SEG = 3;
/** A segment's text keeps at least this much (in u) while its words give way. */
const TEXT_MIN = 14;

/**
 * #232: lays out a wall line of task and now segments in `max` px from 0: each its label, its sparkle hugging it (an AI
 * line), its text, its words after. Short of room a segment's words drop their last ` · ` parts (the failed refresh),
 * then go (the age), down to the sparkle alone, while its text keeps some room; then the text is cut. Two segments
 * that do not fit: the now line keeps what it needs but the task keeps a share; a task too short of room for its label
 * and a little text goes, the now line taking the whole line. `measure` reads a part's width in its font. Pure (for its
 * test).
 */
export function segPlan(measure: (part: 'label' | 'text' | 'words', s: string) => number, segs: readonly WallSeg[], max: number, u: number): SegPlan[] {
  const wordsW = (w: string) => (w ? u * GAP_WORDS + measure('words', w) : 0);
  const head = (s: WallSeg, spark: boolean) => measure('label', s.label) + (spark ? u * (GAP_SPARK + SPARK) : 0) + u * GAP_TEXT;
  const natural = (s: WallSeg) => head(s, s.words !== null) + measure('text', s.text) + wordsW(s.words ?? '');
  const fit = (s: WallSeg, x: number, room: number): SegPlan | null => {
    if (measure('label', s.label) > room) return null;
    const sparkle = s.words !== null && head(s, true) <= room;
    const h = head(s, sparkle);
    const min = Math.min(measure('text', s.text), u * TEXT_MIN);
    let words = sparkle ? (s.words ?? '') : '';
    while (words && h + min + wordsW(words) > room) words = words.includes(' · ') ? words.slice(0, words.lastIndexOf(' · ')) : '';
    return { seg: s, x, sparkle, textMax: Math.max(0, Math.min(measure('text', s.text), room - h - wordsW(words))), words };
  };
  const [task, now] = segs.length > 1 ? segs : [null, segs[0]];
  if (!now) return [];
  if (!task) return [fit(now, 0, max)].filter((p) => p !== null);
  const room = max - u * GAP_SEG;
  const own = Math.min(natural(task), Math.max(room - natural(now), room * 0.35));
  if (own < Math.min(natural(task), head(task, false) + u * TEXT_MIN)) return [fit(now, 0, max)].filter((p) => p !== null);
  return [fit(task, 0, own), fit(now, own + u * GAP_SEG, room - own)].filter((p) => p !== null);
}

/** Draws a wall line from `x` in `max` px (a ticket's line in `font`, or task and now segments); returns the width it takes. */
function drawLine(g: CanvasRenderingContext2D, c: Readonly<WallPalette>, line: WallLine, x: number, base: number, max: number, u: number, font: string, ink: string): number {
  if (typeof line === 'string') {
    g.font = font;
    g.fillStyle = ink;
    return fitText(g, line, x, base, max);
  }
  const small = `400 ${Math.round(u * 2.4)}px ${c.font}`;
  const measure = (part: 'label' | 'text' | 'words', s: string) => {
    g.font = part === 'text' ? font : small;
    return g.measureText(s).width;
  };
  // The sparkle is centred on the capitals of the text beside it, not on its small label.
  g.font = font;
  const cap = g.measureText('H').actualBoundingBoxAscent || u * 2.2;
  let end = 0;
  for (const p of segPlan(measure, line, max, u)) {
    let at = x + p.x;
    g.font = small;
    g.fillStyle = c.text3;
    at += fitText(g, p.seg.label, at, base, max - p.x);
    if (p.sparkle) {
      sparkleAt(g, at + u * GAP_SPARK, base, u, cap);
      at += u * (GAP_SPARK + SPARK);
    }
    at += u * GAP_TEXT;
    g.font = font;
    g.fillStyle = ink;
    at += fitText(g, p.seg.text, at, base, p.textMax);
    if (p.words) {
      g.font = small;
      g.fillStyle = c.text3;
      at += u * GAP_WORDS + fitText(g, p.words, at + u * GAP_WORDS, base, Infinity);
    }
    end = at - x;
  }
  return end;
}

let sparkle: Path2D | null = null;

/**
 * #232: the page's AI sparkle (`ICON.sparkle`'s path, centred in its box) from `x`, centred on capitals `cap` px tall on
 * `base` (the line's text's). Exported for its test.
 */
export function sparkleAt(g: CanvasRenderingContext2D, x: number, base: number, u: number, cap: number, ink = WALL.text2): void {
  const size = u * SPARK;
  sparkle ??= new Path2D(SPARKLE_D);
  g.save();
  g.translate(x, base - cap / 2 - size / 2);
  g.scale(size / 24, size / 24);
  g.fillStyle = ink;
  g.fill(sparkle);
  g.restore();
}

/** Draws `s` from `x`, clipped with an ellipsis to `max` px; returns the width drawn. #65: the departures boards cut with it too. */
export function fitText(g: CanvasRenderingContext2D, s: string, x: number, y: number, max: number): number {
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

function chipW(g: CanvasRenderingContext2D, text: string, u: number, font: string): number {
  g.font = `400 ${Math.round(u * 2.2)}px ${font}`;
  return g.measureText(text).width + u * 1.6;
}

/** A chip of `text` from `x`, centred on `mid`; returns its width. */
function chip(g: CanvasRenderingContext2D, text: string, x: number, mid: number, u: number, bg: string, font: string): number {
  const w = chipW(g, text, u, font);
  g.fillStyle = bg;
  roundRect(g, x, mid - u * 1.5, w, u * 3, u * 0.4);
  g.fillStyle = '#ffffff';
  g.fillText(text, x + u * 0.8, mid + u * 0.75);
  return w;
}

/** The status colours the wall draws with: the shared palette (exported for the contrast test). */
export const WALL_STATUS = { light: STATUS_CSS, chip: STATUS_CHIP_CSS, ink: WALL.ink };
