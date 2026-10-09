import '../test/fakeCanvas';
import { describe, expect, it, vi } from 'vitest';
import { drawMark, harnessName, markFor, MARK_CREDITS, MARKS } from './brandMarks';

describe('the harness marks (#229)', () => {
  it('Claude for claude, OpenAI for codex (never a Codex mark), none for any other harness', () => {
    expect(markFor('claude')).toBe('claude');
    expect(markFor('codex')).toBe('openai');
    for (const h of ['gemini', '', null, undefined, 'constructor', '__proto__']) expect(markFor(h)).toBeNull();
    expect(Object.keys(MARKS)).toEqual(['claude', 'openai']);
    expect(harnessName('claude')).toBe('Claude');
    expect(harnessName('codex')).toBe('Codex');
    expect(harnessName('gemini')).toBe('gemini');
    expect(harnessName(null)).toBe('');
  });

  it('are the originals’ single paths and view boxes', () => {
    expect(MARKS.claude.viewBox).toBe('0 0 100 100');
    expect(MARKS.claude.d).toMatch(/^m19\.6 66\.5 19\.7-11 .*Z$/);
    expect(MARKS.openai.viewBox).toBe('1.68 1.75 16.65 16.5');
    expect(MARKS.openai.d).toMatch(/^M11\.248 18\.25q-\.825 0-1\.568-\.314.*z$/);
    expect(MARK_CREDITS.map((m) => m.license.name)).toEqual(['CC0 1.0', 'Public domain']);
  });

  it('a canvas fills a mark from its view box: its longer side `size` px, centred on the point', () => {
    const g = { save: vi.fn(), restore: vi.fn(), translate: vi.fn(), scale: vi.fn(), fill: vi.fn() };
    drawMark(g as unknown as CanvasRenderingContext2D, 'openai', 50, 40, 33.3);
    const k = 33.3 / 16.65;
    expect(g.scale).toHaveBeenCalledWith(k, k);
    const [[x0, y0], [x1, y1]] = g.translate.mock.calls as [[number, number], [number, number]];
    expect(x0).toBeCloseTo(50 - 33.3 / 2, 6);
    expect(y0).toBeCloseTo(40 - (16.5 * k) / 2, 6);
    expect([x1, y1]).toEqual([-1.68, -1.75]);
    expect((g.fill.mock.calls[0]?.[0] as { d?: string }).d).toBe(MARKS.openai.d);
    expect(g.restore).toHaveBeenCalledOnce();
  });
});
