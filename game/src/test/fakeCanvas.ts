/**
 * Test-only: a `document.createElement('canvas')` for vitest (environment
 * `node`), so render classes that draw canvas atlases (cards, the desks'
 * status bars and stickers, signs) can be built. Its 2D context does nothing:
 * every method is a no-op, `measureText` is 10 px a character,
 * `getImageData` is black, `createImageData` transparent. A `Path2D` (#229's
 * brand marks) only keeps its path data.
 */

type Ctx = Record<string | symbol, unknown>;

function context(canvas: { width: number; height: number }): Ctx {
  const state: Ctx = { font: '10px sans-serif', fillStyle: '#000', strokeStyle: '#000', textBaseline: 'alphabetic', globalAlpha: 1, lineWidth: 1 };
  return new Proxy(state, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'canvas') return canvas;
      if (k === 'measureText') return (s: string) => ({ width: s.length * 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
      if (k === 'getImageData') return (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(0, w * h * 4)) });
      if (k === 'createImageData') return (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(0, w * h * 4)) });
      if (k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createPattern') return () => ({ addColorStop() {} });
      return () => undefined;
    },
    set(t, k, v) {
      t[k] = v;
      return true;
    },
  });
}

if (typeof globalThis.document === 'undefined') {
  const createElement = (tag: string) => {
    if (tag !== 'canvas') throw new Error(`fakeCanvas: no <${tag}>`);
    const c = { width: 300, height: 150, style: {}, getContext: () => ctx, addEventListener() {}, removeEventListener() {} };
    const ctx = context(c);
    return c;
  };
  (globalThis as unknown as { document: unknown }).document = { createElement };
}

if (typeof globalThis.Path2D === 'undefined') {
  (globalThis as unknown as { Path2D: unknown }).Path2D = class {
    constructor(readonly d?: string) {}
  };
}
