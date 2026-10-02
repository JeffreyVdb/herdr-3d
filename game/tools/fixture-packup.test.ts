import { describe, expect, it } from 'vitest';
import { cutSpans } from './fixture-packup.ts';

// #110: the fixture cuts like internal/packup (its tests' cases).
describe('fixture pack up: the cut', () => {
  it('cuts and tidies like the bridge', () => {
    expect(cutSpans('Please make a PR and end your turn', [' and end your turn'])).toEqual({ task: 'Please make a PR', removed: [{ start: 16, end: 34 }] });
    expect(cutSpans('Fix the test, then go home.', ['then go home'])).toMatchObject({ task: 'Fix the test.' });
    expect(cutSpans('Fix A,   go home,   and fix B', ['go home,'])).toMatchObject({ task: 'Fix A, and fix B' });
    expect(cutSpans('Go home and clean up the worktree.', ['Go home', ' and clean up the worktree.'])).toEqual({ task: '', removed: [{ start: 0, end: 34 }] });
  });

  it('refuses a span not in the prompt or over an image, and never shows a path', () => {
    const img = '[Image #1: /home/u/drops/shot.png]';
    const p = `Match this ${img} exactly, then go home`;
    expect(cutSpans(p, [', then go home'])).toMatchObject({ task: `Match this ${img} exactly` });
    expect(cutSpans(p, ['[Image #1] exactly'])).toBe('part 1 would remove an image');
    expect(cutSpans(p, ['/home/u'])).toBe('part 1 is not in the prompt (in order)');
    expect(cutSpans('Please make a PR and end your turn', [' and finish your turn'])).toBe('part 1 is not in the prompt (in order)');
  });
});
