// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// M13: the elements the bridge's Go code pins (internal/whiteboard, testdata/pinned-scene.json, written by
// `go test ./internal/whiteboard -run TestPinnedSceneFixture -update`) go through Excalidraw 0.18.1's own
// restoreElements, the way the editor loads a board: they must come out as the same elements, not repaired.
const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../internal/whiteboard/testdata/pinned-scene.json'), 'utf8')) as {
  elements: Array<Record<string, unknown>>;
};

const ESSENTIAL = ['id', 'type', 'x', 'y', 'width', 'height', 'index', 'version', 'versionNonce', 'isDeleted', 'groupIds', 'frameId', 'link', 'locked', 'customData', 'strokeColor', 'opacity', 'angle'];
const IMAGE = ['fileId', 'status', 'scale', 'crop'];
const TEXT = ['text', 'originalText', 'fontSize', 'fontFamily', 'textAlign', 'verticalAlign', 'containerId', 'autoResize', 'lineHeight'];

// jsdom has no 2D canvas, and Excalidraw asks for one when it loads (it measures text): a context that does nothing.
HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
  return new Proxy({ canvas: this, font: '10px sans-serif', filter: 'none' } as Record<string | symbol, unknown>, {
    get: (t, k) => (k in t ? t[k] : k === 'measureText' ? (s: string) => ({ width: s.length * 10 }) : () => undefined),
    set: (t, k, v) => ((t[k] = v), true),
  });
} as unknown as typeof HTMLCanvasElement.prototype.getContext;

describe('Go-made pins through restoreElements', () => {
  it('survive unchanged in their essential fields', async () => {
    const { restoreElements } = await import('@excalidraw/excalidraw');
    const pins = fixture.elements.filter((e) => (e.customData as { herdr?: { kind?: string } } | undefined)?.herdr?.kind === 'agent-pin');
    expect(pins.map((e) => e.type).sort()).toEqual(['image', 'text']);
    const out = restoreElements(fixture.elements as never, null, { repairBindings: true });
    expect(out).toHaveLength(fixture.elements.length);
    for (const pin of pins) {
      const got = out.find((e) => e.id === pin.id) as unknown as Record<string, unknown> | undefined;
      expect(got, `pin ${String(pin.id)}`).toBeDefined();
      const keys = [...ESSENTIAL, ...(pin.type === 'image' ? IMAGE : TEXT)];
      for (const k of keys) expect(got?.[k], `${String(pin.type)}.${k}`).toEqual(pin[k]);
    }
    // Their order is the indices' order, and no index was repaired (that would bump the versions).
    expect(out.map((e) => e.index)).toEqual(fixture.elements.map((e) => e.index));
    expect([...out.map((e) => e.index as string)].sort()).toEqual(out.map((e) => e.index));
    // Importing Excalidraw (transformed for the test, see vite.config.ts) takes seconds on a loaded machine.
  }, 120_000);
});
