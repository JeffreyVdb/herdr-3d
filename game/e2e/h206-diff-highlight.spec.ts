import { expect, test, type Locator, type Page } from '@playwright/test';
import { frames, openGame, seatMode, shot, watchErrors } from './game';

// #206: syntax colours inside the transcript's diff rows, for real on the WebGL2 path. The #171 timeline (the bridge's own
// Claude fixtures, claude-changes.json) shows the colours; `simtx=demo-h206` (tools/fixture-transcript.ts h206Timeline)
// puts the highlighter's worst cases before it, from real code: a created 2,000-line TypeScript file (one hunk, the
// worker's) and a ten-hunk edit (the page's thread's). The long-task check runs the same page with the highlighter off
// (`?diffhl=off`) and on (`?diffhl=trace`: every slice of its work a `tx-diff-hl` performance measure), prints both and
// holds "on" to "off". Colours are CSS Custom Highlight API ranges over a row's text (diffHighlight.ts), not spans: what
// is checked is the page's highlight registry, and the colours its ::highlight() rules give.

const FLOOR = 'herdr-3d';
const SIM = 'play=none&sim=1&simms=500&simusage=0';

type Win = Window & { __lt: Array<[number, number]> };

/** The most ranges the page may hold once everything is coloured. */
const MAX_RANGES = 5000;
/**
 * Long tasks a phase may have with colours on beyond its count with them off: this host's run-to-run noise. Measured
 * (llvmpipe, 2026-10-08): this spec alone, 4 runs, on − off per phase −1…+1; run with three other specs (the plain-text
 * control's own long tasks 2 → 60) 0…+2. Painting with spans, before, was +6…+22 (open, load, next): 3 keeps that out.
 */
const LONG_TASK_NOISE = 3;

/** Records every long task from the page's start (buffered), in `window.__lt` as [start, duration]. */
async function watchLongTasks(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as Win;
    w.__lt = [];
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) w.__lt.push([e.startTime, e.duration]);
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      // No long task timing: the check below then finds none, and says so through its baseline.
    }
  });
}

async function sitAt(page: Page, extra: string, simtx = ''): Promise<Locator> {
  await openGame(page, 'demo-h171', `&prints=0${extra}`, `${SIM}${simtx}`);
  await page.evaluate((s) => window.__h3d.enterFloor(s), FLOOR);
  await frames(page, 3);
  const id = await page.evaluate(() => window.__h3d.world().flatMap((f) => f.workers).find((w) => w.name === 'Nibble')?.id ?? '');
  expect(await page.evaluate((i) => window.__h3d.face(i), id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((w) => window.__h3d.sitAt(w), id)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBe(id);
  return page.locator('.seat-transcript .tx');
}

/** The resolved colour of a custom property (as a computed `color`). */
const varColour = (tx: Locator, name: string) =>
  tx.evaluate((root, n) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${n})`;
    root.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, name);
const colour = (l: Locator) => l.evaluate((e) => getComputedStyle(e).color);
/** The colour a highlight paints on a cell (its `::highlight(name)` rule). */
const hlColour = (l: Locator, name: string) => l.evaluate((e, n) => getComputedStyle(e, `::highlight(${n})`).color, name);
/** The highlights painted on a cell's text, in order: [highlight, the text it covers] (the plain text first where both start). */
const hlRanges = (l: Locator) =>
  l.evaluate((e) => {
    const out: Array<[number, string, string]> = [];
    for (const [name, h] of CSS.highlights) for (const r of h) if (r.startContainer === e.firstChild) out.push([r.startOffset, name, (e.textContent ?? '').slice(r.startOffset, r.endOffset)]);
    return out.sort((x, y) => x[0] - y[0] || (x[1] === 'tx-hl-plain' ? -1 : 1)).map(([, n, t]) => [n, t]);
  });
/** Every range the page's highlights hold. */
const rangeCount = (page: Page) => page.evaluate(() => [...CSS.highlights.values()].reduce((s, h) => s + h.size, 0));
/** No diff cell is anything but the one text node it was drawn with: colours never change the DOM. */
const plainDom = (tx: Locator) => tx.evaluate((root) => [...root.querySelectorAll('.tx-diff-body .tx-dt')].every((e) => e.childNodes.length === 1 && e.firstChild?.nodeType === Node.TEXT_NODE));

test('diff rows gain syntax colours: tokens on the add band, the sign tinted, plain text as context; unknown files stay plain', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  const tx = await sitAt(page, '');
  await seatMode(page, 'transcript');
  await expect(tx.locator('[data-id="h171-cut"]')).toBeAttached();
  // claude-changes.json's Edit of protocol.ts: its first added row is a comment, the next ones strings.
  const edit = tx.locator('[data-id="toolu_018mQCao59VwQiRK6L6zHu5h"]');
  await edit.scrollIntoViewIfNeeded();
  const add = edit.locator('.tx-dl.tx-add .tx-dt').first();
  await expect(add).toHaveText('+  // M16: the transcript view at a laptop (docs/protocol.md "Laptops: transcript").');
  const comment = '// M16: the transcript view at a laptop (docs/protocol.md "Laptops: transcript").';
  // The plain text after the sign in the context's colour, the comment over it; the sign is the row's own.
  await expect.poll(() => hlRanges(add)).toEqual([
    ['tx-hl-plain', `  ${comment}`],
    ['tx-hl-comment', comment],
  ]);
  const add2 = edit.locator('.tx-dl.tx-add .tx-dt').nth(1);
  expect(await hlRanges(add2)).toContainEqual(['tx-hl-string', "'transcript.watch'"]);
  // What paints on top at the comment is the comment's highlight (the plain text's is under it).
  const top = await add.evaluate((e) => {
    const r = document.createRange();
    r.setStart(e.firstChild as Text, 6);
    r.setEnd(e.firstChild as Text, 9);
    const b = r.getBoundingClientRect();
    const reg = CSS.highlights as HighlightRegistry & { highlightsFromPoint(x: number, y: number): Array<{ highlight: Highlight }> };
    const hits = reg.highlightsFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return hits.map((x) => [...CSS.highlights].find(([, h]) => h === x.highlight)?.[0]);
  });
  expect(top).toEqual(['tx-hl-comment', 'tx-hl-plain']);
  for (const preset of ['quiet', 'ubuntu']) {
    await tx.locator(`.tx-theme[data-theme-id="${preset}"]`).click();
    expect(await hlColour(add, 'tx-hl-comment'), preset).toBe(await varColour(tx, '--tx-hl-comment'));
    expect(await hlColour(add2, 'tx-hl-string'), preset).toBe(await varColour(tx, '--tx-hl-string'));
    expect(await hlColour(add, 'tx-hl-plain'), preset).toBe(await varColour(tx, '--tx-text'));
    // The sign: the cell's own colour, under no highlight.
    expect(await colour(add), preset).toBe(await varColour(tx, '--tx-add-text'));
    await frames(page, 3);
    await shot(page, `h206-diff-colours-${preset}`);
  }
  await tx.locator('.tx-theme[data-theme-id="quiet"]').click();
  // Python and a deleted row: coloured on the red band too (painted once on screen).
  const py = tx.locator('[data-id="toolu_c171_bash_one"]');
  await py.scrollIntoViewIfNeeded();
  await expect.poll(() => hlRanges(py.locator('.tx-dl.tx-del .tx-dt').first())).toContainEqual(['tx-hl-number', '3']);
  expect(await hlRanges(py.locator('.tx-dl.tx-add .tx-dt').first())).toContainEqual(['tx-hl-number', '5']);
  // The hunk header and a file with no known extension (VERSION) as before: plain.
  expect(await hlRanges(edit.locator('.tx-dh .tx-dt'))).toEqual([]);
  const version = tx.locator('[data-id="toolu_c171_bash_unavail"] .tx-dl:not(.tx-dh) .tx-dt');
  await version.first().scrollIntoViewIfNeeded();
  await expect(version).toHaveText(['-1.3.2', '+1.4.0']);
  await frames(page, 3);
  for (const v of await version.all()) expect(await hlRanges(v)).toEqual([]);
  // A Codex patch (#173: no line numbers) colours too.
  const codex = tx.locator('.tx-tool[data-status="ok"]', { has: page.locator('.tx-tool-name', { hasText: 'apply_patch' }) });
  await codex.scrollIntoViewIfNeeded();
  await expect.poll(async () => (await hlRanges(codex.locator('.tx-dl.tx-add .tx-dt').first())).length).toBeGreaterThan(0);
  expect(await plainDom(tx)).toBe(true);
  clean();
});

/** What the highlighter's work cost in a window of the page's time: long tasks, and (traced) its own slices. */
interface Window_ {
  longTasks: number;
  longMax: number;
  longSum: number;
  /** Long tasks that hold a highlighter slice: the highlighter's own. */
  hlLong: number;
  slices: number;
  sliceMax: number;
  sliceSum: number;
  /** The three longest slices: ms and what they did (rows coloured, characters tokenized, a worker reply). */
  sliceTop: string[];
  /** The long tasks that hold a slice, with them. */
  hlLongTasks: string[];
  frameMax: number;
}

async function between(page: Page, t0: number, t1: number): Promise<Window_> {
  return page.evaluate(([from, to]) => {
    const lt = (window as unknown as Win).__lt.filter(([s]) => s >= from && s < to);
    const sl = performance.getEntriesByName('tx-diff-hl').filter((e) => e.startTime >= from && e.startTime < to);
    const hlLong = lt.filter(([s, d]) => sl.some((m) => m.startTime >= s - 1 && m.startTime + m.duration <= s + d + 1)).length;
    const r = (n: number) => Math.round(n * 10) / 10;
    return {
      longTasks: lt.length,
      longMax: r(Math.max(0, ...lt.map(([, d]) => d))),
      longSum: r(lt.reduce((a, [, d]) => a + d, 0)),
      hlLong,
      slices: sl.length,
      sliceMax: r(Math.max(0, ...sl.map((m) => m.duration))),
      sliceSum: r(sl.reduce((a, m) => a + m.duration, 0)),
      sliceTop: [...sl].sort((a, b) => b.duration - a.duration).slice(0, 3).map((m) => `${r(m.duration)} ${JSON.stringify((m as PerformanceMeasure).detail)}`),
      hlLongTasks: lt.filter(([s, d]) => sl.some((m) => m.startTime >= s - 1 && m.startTime + m.duration <= s + d + 1)).map(([s, d]) => `${r(d)}: ${sl.filter((m) => m.startTime >= s - 1 && m.startTime + m.duration <= s + d + 1).map((m) => `${r(m.duration)} ${JSON.stringify((m as PerformanceMeasure).detail)}`).join(', ')}`),
      frameMax: 0,
    };
  }, [t0, t1] as const);
}

/** Runs `act` while timing animation frames; the longest gap between two frames (ms). */
async function frameGaps(page: Page, act: () => Promise<void>): Promise<number> {
  await page.evaluate(() => {
    const w = window as unknown as { __gaps: number[]; __gapsOn: boolean };
    w.__gaps = [];
    w.__gapsOn = true;
    let last = performance.now();
    const tick = (t: number) => {
      w.__gaps.push(t - last);
      last = t;
      if (w.__gapsOn) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await act();
  return page.evaluate(() => {
    const w = window as unknown as { __gaps: number[]; __gapsOn: boolean };
    w.__gapsOn = false;
    return Math.round(Math.max(0, ...w.__gaps.slice(1)) * 10) / 10;
  });
}

const now = (page: Page) => page.evaluate(() => performance.now());

test('highlighting causes no long task: the 2,000-line create, a ten-hunk edit, "Show next", scrolling (off vs on)', async ({ browser }) => {
  test.setTimeout(400_000);
  const results: Record<string, Record<string, Window_>> = {};
  const geometry: Record<string, unknown> = {};
  const ranges: Record<string, number> = {};
  for (const mode of ['off', 'trace'] as const) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    const clean = watchErrors(page);
    await watchLongTasks(page);
    const tx = await sitAt(page, `&diffhl=${mode}`, '&simtx=demo-h206');
    const on = mode === 'trace';
    const create = tx.locator('[data-id="h206-create"]');
    const edit = tx.locator('[data-id="h206-edit"]');
    /**
     * The diff's box on screen, every added or deleted row of code it shows is painted (colours on; none, off). Rows out
     * of its view need not be: ranges follow the view (diffHighlight.ts). Read after a window: it is not cheap.
     */
    const coloured = async (l: Locator) => {
      const body = l.locator('.tx-diff-body');
      await body.scrollIntoViewIfNeeded();
      const look = () =>
        body.evaluate((b) => {
          const box = b.getBoundingClientRect();
          const ranged = new Set<Node>();
          for (const h of CSS.highlights.values()) for (const r of h) ranged.add(r.startContainer);
          const rows = [...b.querySelectorAll<HTMLElement>('.tx-dl.tx-add .tx-dt, .tx-dl.tx-del .tx-dt')].filter((e) => {
            const r = e.getBoundingClientRect();
            return r.bottom > box.top && r.top < box.bottom && (e.textContent ?? '').length > 1;
          });
          return [rows.length, rows.filter((e) => ranged.has(e.firstChild as Node)).length] as const;
        });
      await expect.poll(async () => { const [n, k] = await look(); return n > 0 && k === (on ? n : 0); }, { timeout: 20_000 }).toBe(true);
    };
    /** How many slices the highlighter has run so far (traced). */
    const sliceCount = () => page.evaluate(() => performance.getEntriesByName('tx-diff-hl').length);
    /** Traced: waits for slices past `before` (this phase's work began) and the idle mark after the last (a cheap look, unlike counting rows). */
    const settled = async (before: number) => {
      if (!on) return;
      await expect
        .poll(() => page.evaluate((n) => {
          const sl = performance.getEntriesByName('tx-diff-hl');
          const i = performance.getEntriesByName('tx-diff-hl-idle').at(-1);
          const s = sl.at(-1);
          return sl.length > n && !!i && !!s && i.startTime >= s.startTime + s.duration - 0.5;
        }, before), { timeout: 60_000, intervals: [250] })
        .toBe(true);
    };

    // 1. Open the transcript: both diffs draw (plain), then colour (the create in the worker, the edit here).
    let t0 = await now(page);
    let before = await sliceCount();
    const open = await frameGaps(page, async () => {
      await seatMode(page, 'transcript');
      await expect(create.locator('.tx-dl:not(.tx-dh)')).toHaveCount(2000);
      await expect(edit.locator('.tx-dl.tx-add')).toHaveCount(50);
      await page.waitForTimeout(500);
      await settled(before);
      await page.waitForTimeout(1500);
    });
    results[mode] = { open: { ...(await between(page, t0, await now(page))), frameMax: open } };
    await coloured(create);
    await coloured(edit);

    // Row geometry: the same with colours as without (both presets).
    const geo: Record<string, unknown> = {};
    for (const preset of ['quiet', 'ubuntu']) {
      await tx.locator(`.tx-theme[data-theme-id="${preset}"]`).click();
      await frames(page, 2);
      // The preset's fonts in (until then the rows are another font's width).
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await frames(page, 2);
      geo[preset] = await tx.evaluate((root) => {
        const out: Record<string, unknown> = {};
        for (const id of ['h206-create', 'h206-edit', 'toolu_018mQCao59VwQiRK6L6zHu5h']) {
          const b = root.querySelector(`[data-id="${id}"] .tx-diff-body`) as HTMLElement;
          const rows = [...b.querySelectorAll<HTMLElement>('.tx-dl')].slice(0, 300);
          out[id] = { w: b.scrollWidth, h: b.scrollHeight, rows: rows.map((r) => `${r.offsetHeight}x${r.offsetWidth}`).join(',') };
        }
        return out;
      });
    }
    geometry[mode] = geo;
    await tx.locator('.tx-theme[data-theme-id="quiet"]').click();

    // 2. Scroll the coloured create from the keyboard.
    const body = create.locator('.tx-diff-body');
    await body.scrollIntoViewIfNeeded();
    await body.focus();
    t0 = await now(page);
    const scroll = await frameGaps(page, async () => {
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press('PageDown');
        await page.waitForTimeout(60);
      }
      await page.keyboard.press('End');
      await page.waitForTimeout(500);
    });
    results[mode].scroll = { ...(await between(page, t0, await now(page))), frameMax: scroll };
    expect(await body.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
    // The rows it scrolled to are painted.
    await coloured(create);

    // 3. The cut change loaded whole (transcript.item: one 2,500-line hunk, the worker's), then "Show next 500 lines".
    const cut = tx.locator('[data-id="h171-cut"]');
    await cut.scrollIntoViewIfNeeded();
    t0 = await now(page);
    before = await sliceCount();
    const load = await frameGaps(page, async () => {
      await cut.getByRole('button', { name: 'Show the whole change' }).click();
      await expect(cut.locator('.tx-diff-body .tx-dl:not(.tx-dh)')).toHaveCount(2000);
      await page.waitForTimeout(500);
      await settled(before);
      await page.waitForTimeout(1000);
    });
    results[mode].load = { ...(await between(page, t0, await now(page))), frameMax: load };
    await coloured(cut);
    if (!on) {
      // The control: the same kind of change to the diff's rows with no highlighter at all (each cell's text put back as
      // a new text node: same text, no spans), 10 rows a frame for 60 frames, as the highlighter's batches would.
      t0 = await now(page);
      const touch = await frameGaps(page, () =>
        cut.locator('.tx-diff-body').evaluate(
          (b) =>
            new Promise<void>((res) => {
              const cells = [...b.querySelectorAll<HTMLElement>('.tx-dl:not(.tx-dh) .tx-dt')];
              let i = 0;
              const step = () => {
                for (const c of cells.slice(i, i + 10)) c.replaceChildren(document.createTextNode(c.textContent ?? ''));
                i += 10;
                if (i < 600) requestAnimationFrame(() => setTimeout(step, 0));
                else setTimeout(res, 1000);
              };
              step();
            }),
        ),
      );
      results[mode].touch = { ...(await between(page, t0, await now(page))), frameMax: touch };
    }
    t0 = await now(page);
    before = await sliceCount();
    const next = await frameGaps(page, async () => {
      await cut.getByRole('button', { name: 'Show next 500 lines (500 left)' }).click();
      await expect(cut.locator('.tx-diff-body .tx-dl:not(.tx-dh)')).toHaveCount(2500);
      await page.waitForTimeout(500);
      await settled(before);
      await page.waitForTimeout(1000);
    });
    results[mode].next = { ...(await between(page, t0, await now(page))), frameMax: next };
    await coloured(cut);
    // The last page's last rows, scrolled to, are painted.
    await cut.locator('.tx-diff-body').evaluate((b) => b.scrollTo(0, b.scrollHeight));
    await coloured(cut);
    ranges[mode] = await rangeCount(page);
    expect(await plainDom(tx)).toBe(true);
    if (on) {
      await cut.scrollIntoViewIfNeeded();
      await frames(page, 3);
      await shot(page, 'h206-diff-next-coloured');
    }
    clean();
    await ctx.close();
  }
  console.log(`h206 long tasks: ${JSON.stringify(results)}`);
  console.log(`h206 geometry equal: ${JSON.stringify(geometry.off) === JSON.stringify(geometry.trace)}; ranges held at the end: ${JSON.stringify(ranges)}`);
  // No row changed size, in either preset.
  expect(geometry.trace).toEqual(geometry.off);
  for (const [phase, w] of Object.entries(results.trace ?? {})) {
    // Every slice of the highlighter's own work stays below a long task. (A long task that holds one, `hlLong`, is
    // printed with it: the frame's rendering can land in the same task on a starved machine.)
    expect(w.sliceMax, phase).toBeLessThan(50);
  }
  // It did the work it was measured on.
  expect(results.trace?.open?.slices).toBeGreaterThan(0);
  expect(results.trace?.next?.slices).toBeGreaterThan(0);
  // Ranges only around what diffs show: a few thousand at most, never every drawn row's (~35,000 here).
  expect(ranges.off).toBe(0);
  expect(ranges.trace).toBeLessThan(MAX_RANGES);
  // Rendering too: colours on add no long tasks to the page's own (the same phase, colours off), past this host's noise.
  for (const phase of ['open', 'load', 'next', 'scroll']) {
    const on = results.trace?.[phase] as Window_;
    const off = results.off?.[phase] as Window_;
    expect(on.longTasks, `${phase}: long tasks on ${on.longTasks} vs off ${off.longTasks}`).toBeLessThanOrEqual(off.longTasks + LONG_TASK_NOISE);
  }
});
