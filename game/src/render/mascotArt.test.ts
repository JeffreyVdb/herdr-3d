import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { MASCOTS, POSES } from '../world/activity';
import { FRAMES, framePixels, mascotPixels, SPRITE, SPRITE_COLS, SPRITE_ROWS, spriteRow } from './mascotArt';

const filled = (px: Uint32Array) => px.reduce((n, c) => n + (c ? 1 : 0), 0);
const diff = (a: Uint32Array, b: Uint32Array) => a.reduce((n, c, i) => n + (c !== b[i] ? 1 : 0), 0);

describe('the mascot sheet', () => {
  it('has a row per mascot and pose inside the sheet, every one animated', () => {
    expect(MASCOTS.length * POSES.length).toBeLessThanOrEqual(SPRITE_ROWS);
    expect(FRAMES).toBeLessThanOrEqual(SPRITE_COLS);
    expect(FRAMES).toBeGreaterThanOrEqual(4);
    const rows = new Set<number>();
    for (const m of MASCOTS)
      for (const p of POSES) {
        rows.add(spriteRow(m, p));
        const frames = Array.from({ length: FRAMES }, (_, f) => framePixels(m, p, f));
        for (const px of frames) expect(filled(px), `${m} ${p}`).toBeGreaterThan(80);
        // At least two different frames: it moves (frame 0 is the still one of reduced motion).
        expect(new Set(frames.map((px) => px.join(','))).size, `${m} ${p}`).toBeGreaterThan(1);
      }
    expect(rows.size).toBe(MASCOTS.length * POSES.length);
  });

  it('gives Thinking a pose clearly unlike the others, and the crab and the cloud are different art', () => {
    for (const m of MASCOTS) {
      const think = framePixels(m, 'thinking', 0);
      for (const p of POSES) if (p !== 'thinking') expect(diff(think, framePixels(m, p, 0)), `${m} thinking vs ${p}`).toBeGreaterThan(40);
    }
    for (const p of POSES) expect(diff(framePixels('crab', p, 0), framePixels('cloud', p, 0)), p).toBeGreaterThan(60);
  });

  it('is drawn once into one sheet of pixels', () => {
    const s = mascotPixels();
    expect(s.width).toBe(SPRITE * SPRITE_COLS);
    expect(s.height).toBe(SPRITE * SPRITE_ROWS);
    // Pixels are opaque or empty: crisp art, no stray half-alpha.
    for (let i = 3; i < s.data.length; i += 4) expect(s.data[i] === 0 || s.data[i] === 255).toBe(true);
    if (process.env.H3D_MASCOT_SHEET) {
      // A look at the art, 6× (H3D_MASCOT_SHEET=1): test-results/mascots.png on the monitor's ground.
      const k = 6;
      const png = new PNG({ width: s.width * k, height: s.height * k });
      for (let y = 0; y < png.height; y++)
        for (let x = 0; x < png.width; x++) {
          const i = ((Math.floor(y / k) * s.width + Math.floor(x / k)) * 4) as number;
          const o = (y * png.width + x) * 4;
          const a = s.data[i + 3] ?? 0;
          png.data[o] = a ? (s.data[i] as number) : 0x1a;
          png.data[o + 1] = a ? (s.data[i + 1] as number) : 0x21;
          png.data[o + 2] = a ? (s.data[i + 2] as number) : 0x38;
          png.data[o + 3] = 255;
        }
      const out = resolve(import.meta.dirname, '../../test-results/mascots.png');
      mkdirSync(resolve(out, '..'), { recursive: true });
      writeFileSync(out, PNG.sync.write(png));
    }
  });
});
