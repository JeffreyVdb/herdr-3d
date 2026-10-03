import * as THREE from 'three/webgpu';
import type { Box3 } from '../world/layout';
import { BLINK_MS, sinceText, visibleRows, type OverviewData, type OverviewWorkerRow, type VisibleRow } from '../world/overview';
import { STATUS_CSS, STATUS_CHIP_CSS } from './palette';
import { FONT } from './cards/atlasCards';

/**
 * #118: the floor overview's big screen on the lounge wall. A thin dark bezel box a few cm off the west wall, facing +x,
 * and in it a canvas texture drawn from the same tree as the page (ui/overview.ts): the floor's name, the counts, a
 * line per worker with its light, name, ticket and now line. Unlit (`MeshBasicMaterial`, not tone mapped), so it reads
 * like a screen in any light, and it adds no light to the room (M17).
 *
 * Drawn only when what it shows changes (the since column moves once a minute); the working lights blink by swapping
 * between two drawings of the same data, lit and unlit (no redraw, no upload), at the page's rhythm, and stay lit with
 * battery saver or reduced motion. A floor with more rows than fit goes one line a row (compact), then pages through
 * them like a departures board ("1 / 3"): a row is never cut off unsaid.
 */

/** The screen's resolution, per metre of it (a 7.4 m screen: 1628 px), and its longest side. */
const PX_PER_M = 220;
const MAX_PX = 2048;
const BEZEL = 0.07;
/** A page stays this long before the next. */
export const PAGE_MS = 8000;

/** The departures board's own colours: the page's (overview.css). */
const INK = '#0b1022';
const INK_3 = '#1c2540';
const TEXT = '#eef2fb';
const TEXT_2 = '#b9c3dc';
const TEXT_3 = '#7d89ab';
const ACCENT = '#ffc233';
const DISPLAY = `"H3D Overview Display", ${FONT}`;
const MONO = '"H3D Overview Mono", ui-monospace, monospace';

export interface WallPlan {
  compact: boolean;
  /** Rows per page. */
  perPage: number;
  pages: number;
}

/**
 * How the rows fit `avail` px of board under the header: two lines a row when they all fit, else one line a row, else
 * pages of one-line rows. Pure.
 */
export function wallPlan(rows: number, avail: number, full: number, compact: number): WallPlan {
  const fitFull = Math.max(1, Math.floor(avail / full));
  if (rows <= fitFull) return { compact: false, perPage: fitFull, pages: 1 };
  const fit = Math.max(1, Math.floor(avail / compact));
  return { compact: true, perPage: fit, pages: Math.max(1, Math.ceil(rows / fit)) };
}

export interface OverviewScreenMesh {
  group: THREE.Group;
  /** What it shows (null: a sleeping or unknown floor's blank board); `calm`: no blinking. */
  set(data: OverviewData | null, floor: string, calm: boolean, now: number): void;
  /** The blink and the paging; true when the picture changed (a frame is due). */
  tick(now: number): boolean;
  info(): { lit: boolean; rows: number; page: number; pages: number; compact: boolean; draws: number; blinking: boolean; screenW: number; screenH: number };
  dispose(): void;
}

function canvasTexture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.generateMipmaps = true;
  return t;
}

/** The screen on its wall: `box` is the prop's box, its front at max x, facing +x (into the lounge). */
export function buildOverviewScreen(box: Box3): OverviewScreenMesh {
  const group = new THREE.Group();
  group.name = 'screen.overview';
  const [x0, y0, z0] = box.min;
  const [x1, y1, z1] = box.max;
  const cy = (y0 + y1) / 2;
  const cz = (z0 + z1) / 2;
  const screenW = z1 - z0 - 2 * BEZEL;
  const screenH = y1 - y0 - 2 * BEZEL;
  const body = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), new THREE.MeshToonMaterial({ color: 0x141a2b }));
  body.position.set((x0 + x1) / 2, cy, cz);
  body.receiveShadow = true;
  group.add(body);

  const scale = Math.min(PX_PER_M, MAX_PX / Math.max(screenW, screenH));
  const W = Math.round(screenW * scale);
  const H = Math.round(screenH * scale);
  const make = () => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    return c;
  };
  const lit = make();
  const dark = make();
  const texLit = canvasTexture(lit);
  const texDark = canvasTexture(dark);
  const mat = new THREE.MeshBasicMaterial({ map: texLit, toneMapped: false });
  // three r186 keys a render pipeline by a map's `mapping` (render/tv.ts): a key of its own keeps this unlit,
  // not-tone-mapped picture a program of its own, never one of the room's signs.
  const key = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => `${key()}|h3d-overview`;
  const pic = new THREE.Mesh(new THREE.PlaneGeometry(screenW, screenH).rotateY(Math.PI / 2), mat);
  pic.position.set(x1 + 0.003, cy, cz);
  pic.name = 'screen.overview.picture';
  group.add(pic);

  let data: OverviewData | null = null;
  let floor = '';
  let calm = false;
  let drawnKey = '';
  let draws = 0;
  let plan: WallPlan = { compact: false, perPage: 1, pages: 1 };
  let rows: VisibleRow[] = [];
  let page = 0;
  let pageAt = 0;
  let showLit = true;
  let blinking = false;
  let minute = 0;

  const draw = (now: number) => {
    const shown = rows;
    const k = JSON.stringify([floor, data?.where, data?.counts, shown.map((v) => v.row), plan, page, Math.floor(now / 60_000), data === null]);
    if (k === drawnKey) return false;
    drawnKey = k;
    minute = Math.floor(now / 60_000);
    draws++;
    for (const [c, on] of [
      [lit, true],
      [dark, false],
    ] as const) {
      const g = c.getContext('2d');
      if (!g) continue;
      paint(g, W, H, floor, data, shown, plan, page, on, now);
    }
    texLit.needsUpdate = true;
    texDark.needsUpdate = true;
    return true;
  };

  const layoutRows = () => {
    const head = H * 0.27;
    const fullH = Math.max(40, H * 0.085);
    rows = data ? visibleRows(data.tree, new Set()) : [];
    plan = wallPlan(rows.length, H - head - H * 0.05, fullH, fullH * 0.56);
    if (page >= plan.pages) page = 0;
  };

  return {
    group,
    set(d, f, c, now) {
      data = d;
      floor = f;
      calm = c;
      layoutRows();
      blinking = !calm && rows.some((v) => v.row.kind === 'worker' && v.row.display === 'working');
      if (!blinking && !showLit) {
        showLit = true;
        mat.map = texLit;
      }
      draw(now);
    },
    tick(now) {
      let changed = false;
      if (plan.pages > 1 && now - pageAt >= PAGE_MS) {
        pageAt = now;
        page = (page + 1) % plan.pages;
        changed = draw(now) || changed;
      } else if (plan.pages <= 1) pageAt = now;
      // The minute rolls over: the since column.
      if (data && Math.floor(now / 60_000) !== minute) changed = draw(now) || changed;
      const on = !blinking || Math.floor(now / (BLINK_MS / 2)) % 2 === 0;
      if (on !== showLit) {
        showLit = on;
        mat.map = on ? texLit : texDark;
        changed = true;
      }
      return changed;
    },
    info: () => ({ lit: data !== null, rows: rows.length, page, pages: plan.pages, compact: plan.compact, draws, blinking, screenW, screenH }),
    dispose() {
      body.geometry.dispose();
      (body.material as THREE.Material).dispose();
      pic.geometry.dispose();
      mat.dispose();
      texLit.dispose();
      texDark.dispose();
      group.removeFromParent();
    },
  };
}

/** Draws the board: lit (every light on) or the off half of the blink (working lights dark). */
function paint(g: CanvasRenderingContext2D, W: number, H: number, floor: string, data: OverviewData | null, rows: VisibleRow[], plan: WallPlan, page: number, on: boolean, now: number): void {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = INK;
  g.fillRect(0, 0, W, H);
  // The glass's faint scanlines.
  g.fillStyle = 'rgba(255,255,255,0.025)';
  for (let y = 0; y < H; y += 4) g.fillRect(0, y, W, 1);
  const pad = Math.round(W * 0.035);
  const u = H / 100; // a hundredth of the height
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  // The destination: the floor's name.
  g.fillStyle = ACCENT;
  g.font = `860 ${Math.round(u * 13)}px ${DISPLAY}`;
  setStretch(g, 'ultra-condensed');
  fitText(g, floor.toUpperCase(), pad, u * 15, W - pad * 2);
  setStretch(g, 'normal');
  g.font = `400 ${Math.round(u * 3.1)}px ${MONO}`;
  g.fillStyle = TEXT_2;
  g.fillText(data ? `${data.where} · Floor overview` : 'Floor overview', pad, u * 20.5);
  // The counts: a dot, the number in a flap, the word.
  let x = pad;
  for (const c of data?.counts ?? []) {
    const fy = u * 22.5;
    const fh = u * 5.6;
    g.fillStyle = '#1a2342';
    const digits = String(c.n).padStart(2, '0');
    const fw = u * 4.2;
    for (let i = 0; i < digits.length; i++) {
      roundRect(g, x + i * (fw + u * 0.4), fy, fw, fh, u * 0.5);
      g.fillStyle = TEXT;
      g.font = `400 ${Math.round(u * 4.2)}px ${MONO}`;
      g.textAlign = 'center';
      g.fillText(digits[i] as string, x + i * (fw + u * 0.4) + fw / 2, fy + fh * 0.78);
      g.textAlign = 'left';
      g.fillStyle = 'rgba(0,0,0,0.5)';
      g.fillRect(x + i * (fw + u * 0.4), fy + fh / 2, fw, Math.max(1, u * 0.12));
      g.fillStyle = '#1a2342';
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
  const top = H * 0.3;
  g.fillStyle = INK_3;
  g.fillRect(pad, top - u * 1.2, W - pad * 2, Math.max(2, u * 0.3));
  if (!data) {
    g.fillStyle = TEXT_3;
    g.font = `600 ${Math.round(u * 4)}px ${FONT}`;
    g.fillText('Asleep', pad, top + u * 8);
    return;
  }
  if (!rows.length) {
    g.fillStyle = TEXT;
    g.font = `760 ${Math.round(u * 7)}px ${DISPLAY}`;
    setStretch(g, 'condensed');
    g.fillText('NOBODY’S HERE YET', pad, top + u * 10);
    setStretch(g, 'normal');
    g.fillStyle = TEXT_2;
    g.font = `400 ${Math.round(u * 3.2)}px ${FONT}`;
    g.fillText('Look at a desk’s + and press E to hire someone.', pad, top + u * 15);
    return;
  }
  const rowH = plan.compact ? H * 0.085 * 0.56 : H * 0.085;
  const shown = rows.slice(page * plan.perPage, page * plan.perPage + plan.perPage);
  const colWho = pad + u * 6;
  const colWhat = pad + W * 0.33;
  const sinceRight = W - pad;
  shown.forEach((v, i) => {
    const y = top + i * rowH;
    const mid = y + (plan.compact ? rowH / 2 : rowH * 0.32);
    const r = v.row;
    const indent = v.depth ? u * 3 : 0;
    // The light.
    const lx = pad + u * 1.6 + indent;
    if (r.kind === 'worker') {
      const off = !on && r.display === 'working';
      if (r.display === 'asleep') ring(g, lx, mid, u * 1.1, STATUS_CSS.asleep, u * 0.35);
      else {
        g.fillStyle = STATUS_CSS[r.display];
        g.globalAlpha = off ? 0.3 : 1;
        g.beginPath();
        g.arc(lx, mid, u * 1.1, 0, Math.PI * 2);
        g.fill();
        g.globalAlpha = 1;
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
    const nameSize = Math.round(plan.compact ? u * 3.6 : u * 4.4);
    g.font = `760 ${nameSize}px ${DISPLAY}`;
    setStretch(g, 'condensed');
    g.fillStyle = r.kind === 'worker' ? (r.display === 'asleep' ? TEXT_3 : TEXT) : TEXT_2;
    const name = r.kind === 'worker' ? r.name : r.kind === 'ghost' ? `Orchestrator ${r.name} · ${r.floor}` : 'Unlinked';
    const base = mid + nameSize * 0.36;
    const nameW = fitText(g, name.toUpperCase(), colWho + indent, base, colWhat - colWho - indent - u * 9);
    setStretch(g, 'normal');
    if (r.kind === 'worker' && r.tag) chip(g, r.tag, colWho + indent + nameW + u * 1.2, mid, u, r.runColor !== null ? `#${r.runColor.toString(16).padStart(6, '0')}` : INK_3);
    if (r.kind !== 'worker') return;
    // The since column.
    g.font = `400 ${Math.round(u * 2.8)}px ${MONO}`;
    g.fillStyle = TEXT_2;
    g.textAlign = 'right';
    const since = sinceText(r.display, r.since, now);
    g.fillText(since, sinceRight, base);
    const sinceW = g.measureText(since).width;
    g.textAlign = 'left';
    const whatW = sinceRight - sinceW - u * 3 - colWhat;
    const first = ticketLine(r) ?? lineText(r);
    const second = ticketLine(r) ? lineText(r) : null;
    if (first) {
      g.font = `600 ${Math.round(u * 3.2)}px ${FONT}`;
      g.fillStyle = ticketLine(r) ? TEXT : TEXT_2;
      fitText(g, first, colWhat, base, whatW);
    }
    if (!plan.compact) {
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
  if (plan.pages > 1) {
    g.font = `400 ${Math.round(u * 2.8)}px ${MONO}`;
    g.fillStyle = ACCENT;
    g.textAlign = 'right';
    g.fillText(`${page + 1} / ${plan.pages}`, W - pad, H - u * 2);
    g.textAlign = 'left';
  }
}

/** `#118 · Floor overview` (the wall shows the ticket in its row's first line). */
function ticketLine(r: OverviewWorkerRow): string | null {
  return r.ticket ? `${r.ticket.key}${r.ticket.title ? ` · ${r.ticket.title}` : ''}` : null;
}

/** The task, else the now line and the activity. */
function lineText(r: OverviewWorkerRow): string | null {
  const now = [r.now?.text, r.activity].filter(Boolean).join(' · ');
  if (r.task && !now) return r.task.text;
  if (r.task) return `${r.task.text} — ${now}`;
  return now || null;
}

function setStretch(g: CanvasRenderingContext2D, s: CanvasFontStretch): void {
  if ('fontStretch' in g) g.fontStretch = s;
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
