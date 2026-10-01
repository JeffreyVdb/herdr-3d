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

describe('fractional index vectors', () => {
  it('are generateKeyBetween(key, null) of the fractional-indexing Excalidraw depends on', async () => {
    // Its package.json is not exported: its real directory, through the node_modules link.
    const excalidraw = realpathSync(resolve(import.meta.dirname, '../../node_modules/@excalidraw/excalidraw/package.json'));
    const fi = createRequire(excalidraw).resolve('fractional-indexing');
    const { generateKeyBetween } = (await import(pathToFileURL(fi).href)) as { generateKeyBetween: (a: string | null, b: string | null) => string };
    const fiPkg = JSON.parse(readFileSync(resolve(dirname(fi), '..', 'package.json'), 'utf8')) as { version: string };
    expect(fiPkg.version).toBe('3.2.0');
    expect(vectors.length).toBeGreaterThan(6000);
    for (const [k, next] of vectors) expect(generateKeyBetween(k, null), k).toBe(next);
    expect(generateKeyBetween(null, null)).toBe(appendIndex(''));
  });

  it('match the fixture server\'s port too', () => {
    for (const [k, next] of vectors) expect(appendIndex(k), k).toBe(next);
  });

  it('come from the Excalidraw the game pins', () => {
    expect(pkg.dependencies['@excalidraw/excalidraw']).toBe(EXCALIDRAW_VERSION);
  });
});
