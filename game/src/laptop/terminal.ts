import * as THREE from 'three/webgpu';
import { Terminal, type IBufferCell } from '@xterm/xterm';
import type { TerminalFrame } from '../net/protocol';
import { paintBuffer } from './paint';

/** Live laptop screens far from you, and the one you sit at (sized to the view when you sit down). */
export const LIVE_SIZE = { width: 480, height: 310 };

/** Base64 → bytes (xterm takes UTF-8 bytes as they came from the pane). */
export function decodeFrame(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * One watched pane's screen: xterm.js as the VT emulator (never opened, so
 * no DOM renderer: `write` parses into its buffer), painted into a canvas
 * that is a laptop's texture. A `full` frame resets the emulator first (RIS,
 * queued with the bytes so it stays in order), a diff applies on top.
 * Repaints only after a write, at most `fps` times a second.
 */
export class LaptopTerminal {
  readonly canvas: HTMLCanvasElement;
  readonly texture: THREE.CanvasTexture;
  private readonly g: CanvasRenderingContext2D;
  private readonly term: Terminal;
  /** One cell object the painter reuses for every cell. */
  private readonly cell: IBufferCell;
  private cursorHidden = false;
  private dirty = false;
  private lastDraw = -Infinity;
  /** A frame has been painted since the last reset (before that, the laptop keeps its glow). */
  painted = false;
  /** Frames written and repaints done (tests, bench). */
  frames = 0;
  paints = 0;

  constructor(size = LIVE_SIZE) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = size.width;
    this.canvas.height = size.height;
    const g = this.canvas.getContext('2d', { alpha: false });
    if (!g) throw new Error('2D canvas unavailable');
    this.g = g;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.term = new Terminal({ cols: 120, rows: 36, scrollback: 0, allowProposedApi: false });
    // DECTCEM (show / hide the cursor) is not in xterm's public modes: follow it from the parser.
    const cursor = (hidden: boolean) => (params: (number | number[])[]) => {
      if (params.includes(25)) this.cursorHidden = hidden;
      return false;
    };
    this.term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, cursor(false));
    this.term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, cursor(true));
    this.term.parser.registerEscHandler({ final: 'c' }, () => {
      this.cursorHidden = false;
      return false;
    });
    this.cell = this.term.buffer.active.getNullCell();
  }

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  /**
   * Canvas size in pixels (the seated screen is bigger). Resizing clears a
   * canvas, so what it showed is painted again at once: a painted screen is
   * never blank (standing up freezes it right after).
   */
  setSize(width: number, height: number): void {
    const w = Math.round(width);
    const h = Math.round(height);
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
    // A resized canvas needs a new GPU texture of that size.
    this.texture.dispose();
    this.texture.image = this.canvas;
    this.lastDraw = -Infinity;
    if (this.painted) this.paint(performance.now());
  }

  /** Applies a frame: `full` resets first; a diff for other dimensions waits for a full one (false). */
  frame(f: TerminalFrame): boolean {
    if (!f.full && (f.cols !== this.term.cols || f.rows !== this.term.rows)) return false;
    if (f.full) {
      if (f.cols !== this.term.cols || f.rows !== this.term.rows) this.term.resize(f.cols, f.rows);
      this.term.write('\x1bc');
    }
    this.term.write(decodeFrame(f.data), () => (this.dirty = true));
    this.frames++;
    return true;
  }

  /** Forgets the screen (the watch ended and the laptop shows its frozen copy or glow). */
  reset(): void {
    this.term.write('\x1bc');
    this.painted = false;
    this.dirty = false;
  }

  /** Repaints when something was written and `minMs` passed since the last paint; true when it did. */
  draw(now: number, minMs: number): boolean {
    if (!this.dirty || now - this.lastDraw < minMs) return false;
    this.paint(now);
    return true;
  }

  private paint(now: number): void {
    this.dirty = false;
    this.lastDraw = now;
    paintBuffer(this.g, this.term.buffer.active, { cols: this.term.cols, rows: this.term.rows, width: this.canvas.width, height: this.canvas.height, cursor: !this.cursorHidden }, this.cell);
    this.texture.needsUpdate = true;
    this.painted = true;
    this.paints++;
  }

  /** The screen's text, one string per row, right-trimmed (tests). */
  lines(): string[] {
    const b = this.term.buffer.active;
    return Array.from({ length: this.term.rows }, (_, y) => (b.getLine(b.viewportY + y)?.translateToString(true) ?? '').trimEnd());
  }

  dispose(): void {
    this.term.dispose();
    this.texture.dispose();
  }
}
