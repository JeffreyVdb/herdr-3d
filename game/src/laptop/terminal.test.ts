// @vitest-environment jsdom
// #175: the seated laptop's own painter options, through the real `LaptopTerminal`: a split pane at 100% shows its
// whole grid. jsdom has no 2D canvas: a context that records the text drawn and does nothing else.
import { describe, expect, it, vi } from 'vitest';
import { cellGrid } from './paint';
import { LaptopTerminal } from './terminal';

const texts: Array<{ text: string; y: number }> = [];
HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
  return new Proxy({ canvas: this, font: '10px monospace' } as Record<string | symbol, unknown>, {
    get: (t, k) =>
      k in t ? t[k] : k === 'measureText' ? (s: string) => ({ width: s.length * 6 }) : k === 'fillText' ? (text: string, _x: number, y: number) => texts.push({ text, y }) : () => undefined,
    set: (t, k, v) => ((t[k] = v), true),
  });
} as unknown as typeof HTMLCanvasElement.prototype.getContext;

describe('LaptopTerminal seated (#175)', () => {
  it('paints all 40 rows of a 60-column split pane at 100%, and again after a zoom and a reset to 100%', async () => {
    const t = new LaptopTerminal({ width: 1200, height: 600 });
    t.setGlance(false);
    const data = btoa(Array.from({ length: 40 }, (_, i) => `r${i}`).join('\r\n'));
    t.frame({ t: 'terminal.frame', id: 'w', pane: 'p', n: 1, full: true, cols: 60, rows: 40, data });
    await vi.waitFor(() => expect(t.draw(performance.now(), 0)).toBe(true));
    const fit = cellGrid({ cols: 60, rows: 40, width: 1200, height: 600 });
    const rowsDrawn = () => new Set(texts.map((x) => Math.floor((x.y - fit.y0) / fit.ch)));
    expect(rowsDrawn().size).toBe(40);
    expect(Math.min(...rowsDrawn())).toBe(0);
    expect(Math.max(...rowsDrawn())).toBe(39);

    texts.length = 0;
    t.setZoom(200);
    expect(rowsDrawn().size).toBeLessThan(40);
    texts.length = 0;
    t.setZoom(100);
    expect(rowsDrawn().size).toBe(40);
  });
});
