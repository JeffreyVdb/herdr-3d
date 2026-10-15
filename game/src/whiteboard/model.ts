/**
 * M13 whiteboard: the pure parts of the editor session (no React, no Excalidraw), shared by the lazy editor
 * (./editor.ts) and the overlay (../ui/whiteboard.ts), and unit-tested.
 */

import type { WhiteboardState } from '../net/protocol';

/** What the overlay shows of the board's save state. */
export type BoardStatus =
  | { kind: 'loading' }
  | { kind: 'saved'; version: number }
  | { kind: 'dirty' }
  | { kind: 'saving' }
  | { kind: 'error'; message: string };

/** What the editor session needs from the game. */
export interface EditorHost {
  /** The bridge WebSocket URL (the HTTP routes derive from it). */
  wsUrl: string;
  /** #58: the floor id (the board's key, the HTTP routes). */
  floor: string;
  /** #58: the floor's name (what the editor calls the board; absent: the id). */
  floorName?: string;
  /** The element the editor mounts in. */
  mount: HTMLElement;
  /** Who saves (the `?me=` name). */
  author(): string;
  status(s: BoardStatus): void;
  /** The board's state as last read (its stale pins). */
  stale(s: WhiteboardState): void;
  saved(s: WhiteboardState): void;
  /** A link on the board was clicked (never followed from here). */
  link(url: string): void;
}

/** The appState keys a board keeps (Excalidraw's own `export`+`server` set), each checked. */
export function cleanAppState(a: Record<string, unknown> | null | undefined): { viewBackgroundColor: string; gridSize: number; gridStep: number; gridModeEnabled: boolean } {
  const o = a ?? {};
  const bg = typeof o.viewBackgroundColor === 'string' && /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,32})$/.test(o.viewBackgroundColor) ? o.viewBackgroundColor : '#ffffff';
  const gridSize = typeof o.gridSize === 'number' && o.gridSize >= 1 && o.gridSize <= 1000 ? o.gridSize : 20;
  const gridStep = typeof o.gridStep === 'number' && Number.isInteger(o.gridStep) && o.gridStep >= 1 && o.gridStep <= 100 ? o.gridStep : 5;
  return { viewBackgroundColor: bg, gridSize, gridStep, gridModeEnabled: o.gridModeEnabled === true };
}

/** The part of Excalidraw's appState that says whether the user is in the middle of something. */
export interface BusyState {
  newElement?: unknown;
  multiElement?: unknown;
  selectionElement?: unknown;
  editingTextElement?: unknown;
  resizingElement?: unknown;
  editingLinearElement?: unknown;
  isResizing?: boolean;
  isRotating?: boolean;
  isCropping?: boolean;
  cursorButton?: string;
  openMenu?: unknown;
  openPopup?: unknown;
  openDialog?: unknown;
  openSidebar?: unknown;
  contextMenu?: unknown;
  showHyperlinkPopup?: unknown;
}

/**
 * Nothing in progress: no stroke, drag, resize or text edit (a save waits for that). With `forEsc`, also no menu,
 * popup, dialog, sidebar, context menu or link editor: Esc belongs to Excalidraw while one is open.
 */
export function isIdle(s: BusyState, forEsc = false): boolean {
  const busy = !!(s.newElement || s.multiElement || s.selectionElement || s.editingTextElement || s.resizingElement || s.isResizing || s.isRotating || s.cursorButton === 'down');
  if (busy) return false;
  if (!forEsc) return true;
  return !(s.editingLinearElement || s.isCropping || s.openMenu || s.openPopup || s.openDialog || s.openSidebar || s.contextMenu || s.showHyperlinkPopup);
}

/** w × h scaled down (never up) to fit in maxW × maxH, whole units. */
export function fitInto(w: number, h: number, maxW: number, maxH: number): { w: number; h: number } {
  const k = Math.min(1, maxW / w, maxH / h);
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** An empty board's render: its background at the board's shape (Excalidraw would export a 20 px square). */
export function blankRender(bg: string): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = 1600;
  c.height = 650;
  const g = c.getContext('2d');
  if (g) {
    g.fillStyle = bg || '#ffffff';
    g.fillRect(0, 0, c.width, c.height);
  }
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'));
}

/** "Saved", "Saving…" and the rest, for the overlay's status line. */
export function statusText(s: BoardStatus): string {
  switch (s.kind) {
    case 'loading':
      return 'Opening…';
    case 'saved':
      return s.version ? `Saved · version ${s.version}` : 'Nothing drawn yet';
    case 'dirty':
      return 'Unsaved changes';
    case 'saving':
      return 'Saving…';
    case 'error':
      return `Not saved: ${s.message}`;
  }
}

/** The stale pins in words: "Nibble pinned a note · Crumpet pinned an image". */
export function pinsText(s: Pick<WhiteboardState, 'stale_pins'>): string[] {
  return s.stale_pins.map((p) => `${p.author} pinned ${p.kind === 'image' ? 'an image' : p.note ? `“${p.note}”` : 'a note'}`);
}

/** "3 min ago" for a drop's time. */
export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
