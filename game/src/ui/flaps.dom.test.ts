// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { FLAP_GLYPHS, FlapClock, RESOLVE_MAX_MS, RESOLVE_STAGGER_MS } from './flaps';

// #119: the overview's split-flap clock, on a hand-driven clock and frame.
function clock(calm = false) {
  let t = 0;
  let frames: Array<() => void> = [];
  const state = { calm };
  const flaps = new FlapClock({ calm: () => state.calm, now: () => t, frame: (cb) => void frames.push(cb) });
  /** Runs frames every 16 ms for `ms`. */
  const run = (ms: number) => {
    const end = t + ms;
    while (t < end) {
      t = Math.min(end, t + 16);
      const f = frames;
      frames = [];
      f.forEach((cb) => cb());
    }
  };
  return { flaps, run, state, pending: () => frames.length };
}

function line(text = ''): { p: HTMLElement; span: HTMLElement } {
  const p = document.body.appendChild(document.createElement('p'));
  const span = p.appendChild(document.createElement('span'));
  span.textContent = text;
  return { p, span };
}

const glyphs = (cells: Iterable<Element>) => [...cells].map((c) => (c as HTMLElement).dataset.g ?? '');

describe('FlapClock (#119)', () => {
  it('turns a skeleton’s cells through ░▒▓█ until the line gets another job or leaves the page', () => {
    const { flaps, run, pending } = clock();
    const { p } = line();
    const cells = Array.from({ length: 8 }, () => p.appendChild(document.createElement('span')));
    flaps.skeleton(p, cells);
    const first = glyphs(cells);
    expect(first.every((g) => (FLAP_GLYPHS as readonly string[]).includes(g))).toBe(true);
    expect(new Set(first).size).toBeGreaterThan(1);
    run(500);
    expect(glyphs(cells)).not.toEqual(first);
    expect(flaps.busy(p)).toBe(true);
    p.remove();
    run(50);
    expect(flaps.running).toBe(0);
    expect(pending()).toBe(0); // no frame asked for with nothing to do
  });

  it('resolves a line left to right within 600 ms, its text unseen in cells of its own width, then one text node', () => {
    const { flaps, run } = clock();
    const { p, span } = line('Old line');
    const text = 'Reading the lift code';
    flaps.resolve(p, span, text);
    const cells = [...span.querySelectorAll<HTMLElement>('.ov-ch')];
    // Every letter is a cell holding itself (its width), the spaces plain text; the text reads whole all along.
    expect(cells.map((c) => c.textContent).join('')).toBe(text.replace(/ /g, ''));
    expect(span.textContent).toBe(text);
    expect(cells.every((c) => c.dataset.g)).toBe(true);
    // Left to right: some way in, the first letters are settled and the last are not.
    run(260);
    const settled = cells.map((c) => !c.dataset.g);
    expect(settled[0]).toBe(true);
    expect(settled.at(-1)).toBe(false);
    expect(settled.indexOf(false)).toBeGreaterThan(0);
    expect(settled.slice(settled.indexOf(false)).every((s) => !s)).toBe(true);
    run(600 - 260);
    expect(span.childNodes).toHaveLength(1);
    expect(span.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(span.textContent).toBe(text);
    expect(flaps.running).toBe(0);
  });

  it('staggers lines that arrive together, each within 600 ms', () => {
    const { flaps, run } = clock();
    expect(RESOLVE_MAX_MS).toBeLessThanOrEqual(600);
    const lines = Array.from({ length: 6 }, () => line());
    lines.forEach(({ p, span }) => flaps.resolve(p, span, 'Editing the door timer'));
    run(RESOLVE_MAX_MS - 3 * RESOLVE_STAGGER_MS);
    // The first is done, a later one still turning: they started apart.
    expect(lines[0]?.span.querySelector('.ov-ch')).toBeNull();
    expect(lines[3]?.span.querySelector('.ov-ch[data-g]')).not.toBeNull();
    run(3 * RESOLVE_STAGGER_MS + 16);
    expect(lines.every(({ span }) => !span.querySelector('.ov-ch'))).toBe(true);
  });

  it('calm: no job runs; a resolve shows its text at once, and calm ends a running one at its final state', () => {
    const c = clock(true);
    const a = line('Old');
    c.flaps.resolve(a.p, a.span, 'New line');
    expect(a.span.textContent).toBe('New line');
    expect(a.span.querySelector('.ov-ch')).toBeNull();
    const cells = [a.p.appendChild(document.createElement('span'))];
    c.flaps.skeleton(a.p, cells);
    expect(c.flaps.running).toBe(0);
    expect(c.pending()).toBe(0);
    // Turning calm mid-way: the next frame ends it.
    c.state.calm = false;
    const b = line('Old');
    c.flaps.resolve(b.p, b.span, 'Newer line');
    expect(b.span.querySelector('.ov-ch')).not.toBeNull();
    c.state.calm = true;
    c.run(16);
    expect(b.span.textContent).toBe('Newer line');
    expect(b.span.querySelector('.ov-ch')).toBeNull();
    expect(c.flaps.running).toBe(0);
  });
});
