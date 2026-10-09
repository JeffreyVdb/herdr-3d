import '../test/fakeCanvas';
import { describe, expect, it, vi } from 'vitest';

const drawn = vi.hoisted(() => [] as Array<{ mark: string; cx: number; size: number; fill: unknown }>);
vi.mock('./brandMarks', async (orig) => {
  const m = await orig<typeof import('./brandMarks')>();
  return { ...m, drawMark: (g: CanvasRenderingContext2D, mark: string, cx: number, _cy: number, size: number) => void drawn.push({ mark, cx, size, fill: g.fillStyle }) };
});

const { STICKER_LOGOS, STICKER_MARK, stickerAtlas, stickerLogo } = await import('./deskArt');

describe('the laptop stickers (#229)', () => {
  it('carry the overview’s marks in white: Claude’s cell the Claude mark, Codex’s the OpenAI mark, the plain one none', () => {
    expect(STICKER_LOGOS).toEqual(['claude', 'codex', 'plain']);
    expect(STICKER_MARK).toEqual({ claude: 'claude', codex: 'openai', plain: null });
    expect([stickerLogo('claude'), stickerLogo('codex'), stickerLogo('gemini'), stickerLogo(null)]).toEqual(['claude', 'codex', 'plain', 'plain']);
    stickerAtlas();
    // One mark a cell, in its cell's middle (128 px a cell), white.
    expect(drawn.map((d) => [d.mark, d.cx, d.fill])).toEqual([
      ['claude', 64, '#ffffff'],
      ['openai', 192, '#ffffff'],
    ]);
  });
});
