import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { lineLLM, lineMark, metaLine, scrollAt, wallCycle, wallPages, WALL_STATUS, wallPlan, wallTag, whatLines } from './overviewScreen';
import type { OverviewWorkerRow } from '../world/overview';
import { STATUS_CHIP_CSS, STATUS_CSS } from './palette';

const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);
};
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

describe('the wall screen’s plan (#118)', () => {
  it('two lines a row while they fit, then one line a row, then a scrolling window: never a row cut off', () => {
    expect(wallPlan(5, 600, 80, 45)).toEqual({ compact: false, fit: 7, scroll: false });
    expect(wallPlan(7, 600, 80, 45)).toEqual({ compact: false, fit: 7, scroll: false });
    expect(wallPlan(8, 600, 80, 45)).toEqual({ compact: true, fit: 13, scroll: false });
    expect(wallPlan(40, 600, 80, 45)).toEqual({ compact: true, fit: 13, scroll: true });
  });

  it('the window rests at the top, glides down, rests at the bottom and jumps back; calm: no glide', () => {
    expect(scrollAt(0, 0)).toBe(0);
    expect(scrollAt(99_999, 0)).toBe(0);
    // 6 rows past the window at 0.6 rows/s: a 10 s glide between two 4 s rests (an 18 s cycle).
    expect(scrollAt(2_000, 6)).toBe(0);
    expect(scrollAt(9_000, 6)).toBeCloseTo(0.5, 5);
    expect(scrollAt(15_000, 6)).toBe(1);
    expect(scrollAt(18_000 + 2_000, 6)).toBe(0);
    expect(scrollAt(9_000, 6, false)).toBe(1);
    expect(scrollAt(2_000, 6, false)).toBe(0);
  });
});

describe('a floor bigger than one canvas (#118)', () => {
  // The 4 m wall: a 695 px screen, one-line rows of 33.08 px, a 4096 px canvas: 123 rows a canvas, 17 a window.
  const u = 6.95;
  const rowH = 695 * 0.085 * 0.56;
  const cap = Math.floor((4096 - u * 3) / rowH);
  const fit = 17;

  it('splits the rows into pages a canvas holds, each overlapping the next by a window: every row is on one', () => {
    expect(cap).toBe(123);
    expect(wallPages(100, cap, fit)).toEqual([{ start: 0, count: 100 }]);
    for (const n of [124, 140, 300, 1000]) {
      const pages = wallPages(n, cap, fit);
      expect(pages.length, `${n}`).toBeGreaterThan(1);
      const seen = new Set<number>();
      for (const p of pages) {
        expect(p.count * rowH + u * 3, `page of ${n}`).toBeLessThanOrEqual(4096);
        for (let i = p.start; i < p.start + p.count; i++) seen.add(i);
      }
      expect(seen.size, `${n} rows`).toBe(n);
      expect(Math.max(...seen)).toBe(n - 1);
      // Consecutive pages share at least a window: the scroll's bottom is the next page's top.
      for (let i = 1; i < pages.length; i++) expect((pages[i - 1] as { start: number; count: number }).start + cap - (pages[i] as { start: number }).start).toBeGreaterThanOrEqual(fit);
    }
    expect(wallPages(140, cap, fit)).toEqual([
      { start: 0, count: 123 },
      { start: 17, count: 123 },
    ]);
  });

  it('the window scrolls a page, then the next one, then back to the first: the last rows come by every cycle', () => {
    const extras = wallPages(140, cap, fit).map((p) => p.count - fit); // 106 rows past the window each
    const page = 4_000 * 2 + (106 / 0.6) * 1000;
    expect(wallCycle(0, extras)).toEqual({ page: 0, s: 0 });
    expect(wallCycle(page - 1, extras)).toEqual({ page: 0, s: 1 });
    expect(wallCycle(page + 1, extras)).toEqual({ page: 1, s: 0 });
    expect(wallCycle(page * 2 - 1, extras)).toEqual({ page: 1, s: 1 }); // the 140th row in the window
    expect(wallCycle(page * 2 + 1, extras)).toEqual({ page: 0, s: 0 });
    // One page: the plain cycle.
    expect(wallCycle(9_000, [6])).toEqual({ page: 0, s: scrollAt(9_000, 6) });
  });
});

describe('the wall’s what column (#118)', () => {
  const row = (over: Partial<OverviewWorkerRow>): OverviewWorkerRow => ({
    kind: 'worker', key: 'w', id: 'w', session: 's', name: 'Sprout', display: 'working', since: 0, harness: 'claude', model: 'claude',
    role: null, tag: null, runColor: null, orch: null, ticket: null, task: null, now: null, activity: null, floor: null, ...over,
  });
  const ticket = { key: '#118', title: 'Floor overview', item: null, url: null };
  const now = { text: 'Reviewing the wall', source: 'recap' as const, llm: false };

  it('one line a row keeps what it does now: the ticket’s key, then the now line (never the ticket alone)', () => {
    expect(whatLines(row({ ticket, now }), true)).toEqual(['#118', 'Reviewing the wall']);
    expect(whatLines(row({ ticket, now }), false)).toEqual(['#118 · Floor overview', 'Reviewing the wall']);
    expect(whatLines(row({ ticket }), true)).toEqual(['#118 · Floor overview', null]);
    expect(whatLines(row({ now }), true)).toEqual(['Reviewing the wall', null]);
    expect(whatLines(row({ task: { text: 'Fix it', source: 'prompt', llm: false }, now }), true)).toEqual(['Fix it — Reviewing the wall', null]);
  });

  it('the AI mark follows the page’s: a line with a part the LLM wrote (#118 phase 2)', () => {
    expect(lineLLM(row({ now }))).toBe(false);
    expect(lineLLM(row({ now: { ...now, source: 'llm', llm: true } }))).toBe(true);
    expect(lineLLM(row({ task: { text: 'Fix it', source: 'llm', llm: true }, now }))).toBe(true);
    expect(lineLLM(row({ ticket }))).toBe(false);
  });

  it('the AI mark says how old the model’s now line is, as the page does, and moves with the time alone (#198)', () => {
    const at = 1_790_000_000_000;
    const llmNow = { ...now, source: 'llm' as const, llm: true, at };
    expect(lineMark(row({ now }), at)).toBeNull();
    expect(lineMark(row({ now: llmNow }), at + 2 * 60_000)).toBe('AI · 2m ago');
    expect(lineMark(row({ now: llmNow }), at + 9 * 60_000)).toBe('AI · 9m ago');
    expect(lineMark(row({ task: { text: 'Fix it', source: 'llm', llm: true }, now }), at)).toBe('AI');
    expect(lineMark(row({ now: { ...now, source: 'llm', llm: true } }), at)).toBe('AI');
    // A failed refresh of the line: the page's chip after the age (the wall drops it first when short of room).
    expect(lineMark(row({ now: { ...llmNow, status: { state: 'failed', reason: 'timeout' } } }), at + 2 * 60_000)).toBe('AI · 2m ago · refresh failed');
    expect(lineMark(row({ now: { ...llmNow, status: { state: 'retrying', reason: 'timeout', retry_at: at + 10 * 60_000 } } }), at)).toMatch(/^AI · just now · refresh failed · retry \d\d:\d\d/);
  });

  it('an orchestrator’s round: in its chip (both modes) and its meta line with the phase and pass (two-line rows)', () => {
    const o = row({ role: 'orch', tag: 'ORCH', orch: { phase: 'waiting for you', round: 2, pass: 'pass 3 of 3', overCap: true } });
    expect(wallTag(o)).toBe('ORCH r2');
    expect(metaLine(o)).toBe('claude · waiting for you · round 2 · pass 3 of 3 · over cap');
    expect(wallTag(row({ role: 'orch', tag: 'ORCH', orch: { phase: null, round: null, pass: null, overCap: false } }))).toBe('ORCH');
    expect(wallTag(row({ tag: 'CODE r1' }))).toBe('CODE r1');
  });
});

describe('the overview’s colours (#118)', () => {
  const css = readFileSync(resolve(import.meta.dirname, '../ui/overview.css'), 'utf8');
  const token = (name: string) => new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`).exec(css)?.[1] as string;

  it('the page and the wall share the ink, and draw the shared status palette (no hues of their own)', () => {
    expect(token('ov-ink')).toBe(WALL_STATUS.ink);
    expect(WALL_STATUS.light).toBe(STATUS_CSS);
    expect(WALL_STATUS.chip).toBe(STATUS_CHIP_CSS);
    // Working stays blue (the top bar's), done green.
    expect(STATUS_CSS.working).toBe('#2f6bf0');
    expect(css).not.toMatch(/--(working|done|needs_you|idle|asleep|waiting):/);
  });

  it('AA: every status light is >= 3:1 on the ink (and the hover row); text >= 4.5:1; white on every chip >= 4.5:1', () => {
    for (const bg of [token('ov-ink'), token('ov-ink-2')]) {
      for (const [k, c] of Object.entries(STATUS_CSS)) expect(contrast(c, bg), `${k} on ${bg}`).toBeGreaterThanOrEqual(3);
      for (const t of ['ov-text', 'ov-text-2', 'ov-text-3']) expect(contrast(token(t), bg), `${t} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const [k, c] of Object.entries(STATUS_CHIP_CSS)) expect(contrast('#ffffff', c), `white on ${k}`).toBeGreaterThanOrEqual(4.5);
  });

  it('AA on an asleep row as drawn: its own dimmer text tokens (no opacity over its text) stay >= 4.5:1', () => {
    // Every rule for an asleep row, and the tokens it sets (the rest inherited from .ov).
    const rules = [...css.matchAll(/([^{}]*data-display='asleep'[^{}]*)\{([^}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(0);
    for (const [, sel, body] of rules) expect(body, `${sel?.trim()}`).not.toMatch(/(^|[\s;])(opacity|filter)\s*:/);
    const own = /\.ov-row\[data-display='asleep'\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    const asleep = (name: string) => new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`).exec(own)?.[1] ?? token(name);
    expect(asleep('ov-text')).not.toBe(token('ov-text')); // it does dim
    const used = ['ov-text', 'ov-text-2', 'ov-text-3', 'ov-key-asleep'].map(asleep);
    for (const bg of [token('ov-ink'), token('ov-ink-2')]) for (const t of used) expect(contrast(t, bg), `${t} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    // The ticket key uses its asleep colour.
    expect(css).toMatch(/data-display='asleep'\] \.ov-ticket-key \{\s*color: var\(--ov-key-asleep\)/);
  });
});
