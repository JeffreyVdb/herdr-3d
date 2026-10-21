import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import pkg from '../../package.json' with { type: 'json' };
import { appendIndex } from '../../tools/fixture-whiteboard.ts';
import { EXCALIDRAW_VERSION } from './version';

// M13: internal/whiteboard/testdata/append-vectors.json (the Go AppendIndex's test vectors) is what the
// fractional-indexing that Excalidraw ships says: recomputed here with that very package, so the vectors cannot rot.
const vectors = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../internal/whiteboard/testdata/append-vectors.json'), 'utf8')) as Array<[string, string]>;
// Load the dependency with the rest of this module, outside any individual test's five-second budget.
// Its package.json is not exported: resolve from Excalidraw's real directory through the node_modules link.
const excalidraw = realpathSync(resolve(import.meta.dirname, '../../node_modules/@excalidraw/excalidraw/package.json'));
const fi = createRequire(excalidraw).resolve('fractional-indexing');
const { generateKeyBetween } = (await import(pathToFileURL(fi).href)) as { generateKeyBetween: (a: string | null, b: string | null) => string };
const fiPkg = JSON.parse(readFileSync(resolve(dirname(fi), '..', 'package.json'), 'utf8')) as { version: string };

describe('fractional index vectors', () => {
  it('are generateKeyBetween(key, null) of the fractional-indexing Excalidraw depends on', () => {
    expect(fiPkg.version).toBe('3.2.0');
    expect(vectors.length).toBeGreaterThan(6000);
    expect(vectors.map(([k]) => generateKeyBetween(k, null))).toEqual(vectors.map(([, next]) => next));
    expect(generateKeyBetween(null, null)).toBe(appendIndex(''));
  });

  it('match the fixture server\'s port too', () => {
    expect(vectors.map(([k]) => appendIndex(k))).toEqual(vectors.map(([, next]) => next));
  });

  it('come from the Excalidraw the game pins', () => {
    expect(pkg.dependencies['@excalidraw/excalidraw']).toBe(EXCALIDRAW_VERSION);
  });
});
