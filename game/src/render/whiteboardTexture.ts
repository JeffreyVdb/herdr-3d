import type * as THREE from 'three/webgpu';
import type { WhiteboardState } from '../net/protocol';
import { renderUrl } from '../net/whiteboard';
import { FONT } from './cards/atlasCards';
import { canvasTexture } from './props';

/**
 * M13: the room's whiteboard shows its floor's latest render.png (one texture per floor; the one it replaces is
 * disposed by the props). The render keeps its proportions on the board's face (3.2 × 1.3 m), centred on white. When
 * agents pinned since the render (stale), their pins are listed on a sticky note in the corner until a client opens
 * the board and renders it again.
 */

/** The board face's texture size: its 3.2 × 1.3 m in pixels. */
export const BOARD_TEX = { w: 2048, h: 832 };

/** Where an image of w × h sits inside the board face, contained, with a margin. */
export function containIn(w: number, h: number, box: { w: number; h: number }, margin = 24): { x: number; y: number; w: number; h: number } {
  const k = Math.min((box.w - 2 * margin) / w, (box.h - 2 * margin) / h);
  const dw = Math.max(1, Math.round(w * k));
  const dh = Math.max(1, Math.round(h * k));
  return { x: Math.round((box.w - dw) / 2), y: Math.round((box.h - dh) / 2), w: dw, h: dh };
}

/** The lines of the stale note: who pinned what, newest last, at most four. */
export function staleLines(s: Pick<WhiteboardState, 'stale_pins'>): string[] {
  const pins = s.stale_pins;
  const lines = pins.slice(-4).map((p) => `${p.author}: ${p.kind === 'image' ? 'an image' : (p.note ?? 'a note')}`);
  if (pins.length > 4) lines.unshift(`… and ${pins.length - 4} more`);
  return lines;
}

/** The board face: the render (or nothing yet) and the stale pins' note. */
export function boardTexture(img: CanvasImageSource & { width: number; height: number }, s: WhiteboardState): THREE.CanvasTexture {
  const t = canvasTexture(BOARD_TEX.w, BOARD_TEX.h, (g) => {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, BOARD_TEX.w, BOARD_TEX.h);
    const r = containIn(img.width, img.height, BOARD_TEX);
    g.drawImage(img, r.x, r.y, r.w, r.h);
    if (s.stale && s.stale_pins.length) staleNote(g, staleLines(s));
  });
  t.userData.key = `render:${s.render_version}${s.stale && s.stale_pins.length ? `+${s.stale_pins.length}` : ''}`;
  return t;
}

/** A board with no render yet (agents pinned on a board nobody opened since): their pins on the note. */
export function pinsOnlyTexture(s: WhiteboardState): THREE.CanvasTexture {
  const t = canvasTexture(BOARD_TEX.w, BOARD_TEX.h, (g) => {
    g.fillStyle = '#fbfcff';
    g.fillRect(0, 0, BOARD_TEX.w, BOARD_TEX.h);
    g.fillStyle = '#1c2540';
    g.font = `700 64px ${FONT}`;
    g.fillText('Whiteboard', 64, 110);
    staleNote(g, staleLines(s));
  });
  t.userData.key = `pins:${s.stale_pins.length}`;
  return t;
}

function staleNote(g: CanvasRenderingContext2D, lines: string[]): void {
  const w = 760;
  const lh = 46;
  const hgt = 110 + lines.length * lh;
  const x = BOARD_TEX.w - w - 48;
  const y = BOARD_TEX.h - hgt - 40;
  g.save();
  g.translate(x + w / 2, y + hgt / 2);
  g.rotate(-0.015);
  g.fillStyle = 'rgba(0,0,0,0.18)';
  g.fillRect(-w / 2 + 6, -hgt / 2 + 8, w, hgt);
  g.fillStyle = '#ffe27a';
  g.fillRect(-w / 2, -hgt / 2, w, hgt);
  g.fillStyle = '#1c2540';
  g.font = `800 36px ${FONT}`;
  g.fillText('New pins · open the board to place them', -w / 2 + 28, -hgt / 2 + 58);
  g.font = `500 32px ${FONT}`;
  lines.forEach((l, i) => {
    let t = l;
    while (g.measureText(t).width > w - 60 && t.length > 4) t = `${t.slice(0, -2)}…`;
    g.fillText(t, -w / 2 + 28, -hgt / 2 + 108 + i * lh);
  });
  g.fillStyle = '#e8413a';
  g.beginPath();
  g.arc(0, -hgt / 2 + 14, 11, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

/**
 * Loads a floor's board face for `s`: its render at `render_version` (cached by the browser: the URL names the
 * version), a pins-only face when there is no render but pins, null for an empty board (the placeholder).
 */
export async function loadBoardTexture(wsUrl: string, s: WhiteboardState, signal?: AbortSignal): Promise<THREE.CanvasTexture | null> {
  if (!s.render) return s.stale_pins.length ? pinsOnlyTexture(s) : null;
  const res = await fetch(renderUrl(wsUrl, s.floor, s.render_version), signal ? { signal } : {});
  if (!res.ok) throw new Error(`render.png: HTTP ${res.status}`);
  const bmp = await createImageBitmap(await res.blob());
  try {
    return boardTexture(bmp, s);
  } finally {
    bmp.close();
  }
}
