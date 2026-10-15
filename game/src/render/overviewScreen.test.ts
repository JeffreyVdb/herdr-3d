import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import '../test/fakeCanvas';
import { SPARKLE_D } from '../ui/dom';
import { lineMark, lineSegs, metaLine, scrollAt, segPlan, sparkleAt, wallCycle, wallPages, WALL_STATUS, wallPlan, wallTag, whatLines, type WallSeg } from './overviewScreen';
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
    kind: 'worker', key: 'w', id: 'w', floorId: 's', name: 'Sprout', display: 'working', since: 0, harness: 'claude', model: 'Opus 5.5 high',
    role: null, tag: null, runColor: null, orch: null, ticket: null, task: null, now: null, activity: null, act: null, floor: null, ...over,
  });
  const ticket = { key: '#118', title: 'Floor overview', item: null, url: null };
  const now = { text: 'Reviewing the wall', source: 'recap' as const, llm: false };

  const at = 1_790_000_000_000;
  const llmNow = { ...now, source: 'llm' as const, llm: true, at };
  const task = { text: 'Fix it', source: 'prompt' as const, llm: false };
  const llmTask = { text: 'Fix it', source: 'llm' as const, llm: true };

  it('one line a row keeps what it does now: the ticket’s key, then the task and now lines (never the ticket alone)', () => {
    const NOW = [{ label: 'NOW', text: 'Reviewing the wall', words: null }];
    expect(whatLines(row({ ticket, now }), true, at)).toEqual(['#118', NOW]);
    expect(whatLines(row({ ticket, now }), false, at)).toEqual(['#118 · Floor overview', NOW]);
    expect(whatLines(row({ ticket }), true, at)).toEqual(['#118 · Floor overview', null]);
    expect(whatLines(row({ now }), true, at)).toEqual([NOW, null]);
    expect(whatLines(row({ task, now }), true, at)).toEqual([[{ label: 'TASK', text: 'Fix it', words: null }, ...NOW], null]);
    expect(whatLines(row({}), true, at)).toEqual([null, null]);
  });

  it('each line carries its own label and sparkle: an AI now line’s never goes on a task line the LLM did not write (#232)', () => {
    expect(lineSegs(row({ task, now: llmNow }), at + 2 * 60_000)).toEqual([
      { label: 'TASK', text: 'Fix it', words: null },
      { label: 'NOW', text: 'Reviewing the wall', words: '2m ago' },
    ]);
    expect(lineSegs(row({ task: llmTask, now }), at)).toEqual([
      { label: 'TASK', text: 'Fix it', words: '' },
      { label: 'NOW', text: 'Reviewing the wall', words: null },
    ]);
    expect(lineSegs(row({ task, now: { ...now, text: '' } }), at)).toEqual([{ label: 'TASK', text: 'Fix it', words: null }]);
  });

  it('the words after a line’s sparkle say how old the model’s line is and what became of its refresh; no time, no age, but the failure stays (#198, #232)', () => {
    expect(lineMark(now, 'now', at)).toBeNull();
    expect(lineMark(llmNow, 'now', at + 2 * 60_000)).toBe('2m ago');
    expect(lineMark(llmNow, 'now', at + 9 * 60_000)).toBe('9m ago');
    // The sparkle alone: a task line, a now line with no time (none made up).
    expect(lineMark(llmTask, 'task', at)).toBe('');
    expect(lineMark({ ...now, source: 'llm', llm: true }, 'now', at)).toBe('');
    // A failed refresh of the line: the page's chip after the age (the wall drops it first when short of room).
    expect(lineMark({ ...llmNow, status: { state: 'failed', reason: 'timeout' } }, 'now', at + 2 * 60_000)).toBe('2m ago · refresh failed');
    expect(lineMark({ ...llmNow, status: { state: 'retrying', reason: 'timeout', retry_at: at + 10 * 60_000 } }, 'now', at)).toMatch(/^just now · refresh failed · retry \d\d:\d\d/);
    // No time: only the age goes, never the failure.
    expect(lineMark({ ...now, source: 'llm', llm: true, status: { state: 'failed', reason: 'timeout' } }, 'now', at)).toBe('refresh failed');
    expect(lineMark({ ...now, source: 'llm', llm: true, status: { state: 'retrying', reason: 'timeout', retry_at: at + 10 * 60_000 } }, 'now', at)).toMatch(/^refresh failed · retry \d\d:\d\d/);
  });

  describe('a wall line’s layout (#232)', () => {
    // u 10; a character is 10 px in the fake; label TASK/NOW 40/30, sparkle 28 after a gap of 6, text 12 after, words 14 after.
    const measure = (_: string, s: string) => [...s].length * 10;
    const seg = (label: 'TASK' | 'NOW', text: string, words: string | null): WallSeg => ({ label, text, words });
    const plan = (segs: WallSeg[], max: number) => segPlan(measure, segs, max, 10).map((p) => ({ label: p.seg.label, x: Math.round(p.x), sparkle: p.sparkle, text: Math.round(p.textMax), words: p.words }));
    const N = seg('NOW', 'Tracing the bug', '2m ago · refresh failed');

    it('room for all: the label, its sparkle, the whole text, the words after', () => {
      expect(plan([N], 1000)).toEqual([{ label: 'NOW', x: 0, sparkle: true, text: 150, words: '2m ago · refresh failed' }]);
      expect(plan([seg('NOW', 'Tracing the bug', null)], 1000)).toEqual([{ label: 'NOW', x: 0, sparkle: false, text: 150, words: '' }]);
    });

    it('short of room the failed refresh goes first, then the age, down to the sparkle alone; then the text is cut', () => {
      // head 30 + 6 + 28 + 12 = 76; the text keeps 140 (14u) while the words give way.
      expect(plan([N], 76 + 150 + 14 + 60)).toEqual([{ label: 'NOW', x: 0, sparkle: true, text: 150, words: '2m ago' }]);
      expect(plan([N], 76 + 140 + 14 + 60)).toEqual([{ label: 'NOW', x: 0, sparkle: true, text: 140, words: '2m ago' }]);
      expect(plan([N], 76 + 140 + 14 + 59)).toEqual([{ label: 'NOW', x: 0, sparkle: true, text: 150, words: '' }]);
      expect(plan([N], 76 + 40)).toEqual([{ label: 'NOW', x: 0, sparkle: true, text: 40, words: '' }]);
      // No time on the line: its failure is what shows, and what goes.
      expect(plan([seg('NOW', 'Tracing the bug', 'refresh failed')], 1000)[0]?.words).toBe('refresh failed');
      expect(plan([seg('NOW', 'Tracing the bug', 'refresh failed')], 76 + 150)[0]?.words).toBe('');
      // Not even the sparkle's room: the label alone, nothing overlaps.
      expect(plan([N], 50)).toEqual([{ label: 'NOW', x: 0, sparkle: false, text: 8, words: '' }]);
    });

    it('two lines on one: each its own label, and a sparkle only where the LLM wrote it', () => {
      const T = seg('TASK', 'Fix it', null);
      expect(plan([T, N], 1000)).toEqual([
        { label: 'TASK', x: 0, sparkle: false, text: 60, words: '' },
        { label: 'NOW', x: 40 + 12 + 60 + 30, sparkle: true, text: 150, words: '2m ago · refresh failed' },
      ]);
    });

    it('two lines short of room: the now line keeps what it needs, the task a share; a task with no room goes', () => {
      const T = seg('TASK', 'Write the overview screen for the lounge wall', '');
      const out = plan([T, seg('NOW', 'Tracing the bug', '2m ago')], 600);
      // Room 570 after the gap between them: the now line needs 76 + 150 + 74 = 300, the task the other 270.
      expect(out).toEqual([
        { label: 'TASK', x: 0, sparkle: true, text: 270 - 86, words: '' },
        { label: 'NOW', x: 300, sparkle: true, text: 150, words: '2m ago' },
      ]);
      // A long now line: the task keeps 35% of the room.
      const long = plan([T, seg('NOW', 'Tracing the bug through the bridge and the page', '2m ago')], 600);
      expect(long[0]?.x).toBe(0);
      expect(long[1]?.x).toBe(Math.round(570 * 0.35 + 30));
      // Too narrow for the task's label and a little text: the now line alone.
      expect(plan([T, N], 200).map((p) => p.label)).toEqual(['NOW']);
    });
  });

  it('draws the page’s sparkle (its own path), centred on the capitals of the text beside it (#232)', () => {
    const calls: string[] = [];
    const g = {
      fillStyle: '',
      save: () => calls.push('save'),
      restore: () => calls.push('restore'),
      translate: (x: number, y: number) => calls.push(`at ${x} ${y}`),
      scale: (s: number) => calls.push(`scale ${s}`),
      fill: (p: { d?: string }) => calls.push(`fill ${p.d === SPARKLE_D ? 'sparkle' : '?'} ${g.fillStyle}`),
    } as unknown as CanvasRenderingContext2D & { fillStyle: string };
    // u 10: 28 px, centred on capitals 22 px tall on the baseline at 50: its middle at 39.
    sparkleAt(g, 5, 50, 10, 22);
    expect(calls).toEqual(['save', 'at 5 25', `scale ${28 / 24}`, 'fill sparkle #b9c3dc', 'restore']);
    // No outlined box any more: nothing is stroked.
    expect(readFileSync(resolve(import.meta.dirname, 'overviewScreen.ts'), 'utf8')).not.toMatch(/AI · /);
  });

  it('an orchestrator’s round is in its chip (both modes); its meta line is the model alone, no run words (#229)', () => {
    const o = row({ role: 'orch', tag: 'ORCH', orch: { round: 2, overCap: true } });
    expect(wallTag(o)).toBe('ORCH r2');
    expect(metaLine(o)).toBe('Opus 5.5 high');
    expect(metaLine(o)).not.toMatch(/waiting|round|pass|over cap/);
    expect(wallTag(row({ role: 'orch', tag: 'ORCH', orch: { round: null, overCap: false } }))).toBe('ORCH');
    expect(wallTag(row({ tag: 'CODE r1' }))).toBe('CODE r1');
  });

  it('the harness is the mark before the name (#229): Claude and Codex have one, any other harness says its name', () => {
    expect(metaLine(row({ harness: 'codex', model: 'GPT 6 Sol medium' }))).toBe('GPT 6 Sol medium');
    expect(metaLine(row({ harness: 'gemini', model: 'gemini-3 high' }))).toBe('gemini gemini-3 high');
    expect(metaLine(row({ harness: null, model: '' }))).toBe('');
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
