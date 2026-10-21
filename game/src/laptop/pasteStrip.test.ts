import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pasteStrip } from './pasteStrip';

// #176 part 2: internal/herdr/testdata/paste-strip.json is herdr.PasteStrip's vectors (the bridge's strip of a
// worker.paste before its scan): the game's port gives the same text, so the text it reviews is the text the bridge scans.
describe('pasteStrip', () => {
  const vectors = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../internal/herdr/testdata/paste-strip.json'), 'utf8')) as Array<[string, string]>;
  it('is herdr.PasteStrip: NUL and the paste markers removed until none is left', () => {
    expect(vectors.length).toBeGreaterThan(9);
    expect(vectors.map(([text]) => pasteStrip(text))).toEqual(vectors.map(([, want]) => want));
  });
});
