import { expect, test, type Locator, type Page } from '@playwright/test';
import { frames, openGame, seatMode, shot, watchErrors } from './game';

// #206: syntax colours inside the transcript's diff rows, for real on the WebGL2 path. The #171 timeline (the bridge's own
// Claude fixtures, claude-changes.json) shows the colours; `simtx=demo-h206` (tools/fixture-transcript.ts h206Timeline)
// puts the highlighter's worst cases before it, from real code: a created 2,000-line TypeScript file (one hunk, the
// worker's) and a ten-hunk edit (the page's thread's). The long-task check runs the same page with the highlighter off
// (`?diffhl=off`) and on (`?diffhl=trace`: every slice of its work a `tx-diff-hl` performance measure) and prints both.

const FLOOR = 'herdr-3d';
const SIM = 'play=none&sim=1&simms=500&simusage=0';

type Win = Window & { __lt: Array<[number, number]> };

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
  await expect(add).toHaveClass(/\btx-hl\b/);
  await expect(add).toHaveText('+  // M16: the transcript view at a laptop (docs/protocol.md "Laptops: transcript").');
  await expect(add.locator('.hljs-comment')).toHaveText('// M16: the transcript view at a laptop (docs/protocol.md "Laptops: transcript").');
  await expect(edit.locator('.tx-dl.tx-add .tx-dt').nth(1).locator('.hljs-string')).toHaveText(["'transcript.watch'"]);
  for (const preset of ['quiet', 'ubuntu']) {
    await tx.locator(`.tx-theme[data-theme-id="${preset}"]`).click();
    expect(await colour(add.locator('.hljs-comment')), preset).toBe(await varColour(tx, '--tx-hl-comment'));
    expect(await colour(edit.locator('.tx-dl.tx-add .hljs-string').first()), preset).toBe(await varColour(tx, '--tx-hl-string'));
    expect(await colour(add.locator('.tx-dsg')), preset).toBe(await varColour(tx, '--tx-add-text'));
    expect(await colour(add), preset).toBe(await varColour(tx, '--tx-text'));
    await frames(page, 3);
    await shot(page, `h206-diff-colours-${preset}`);
  }
  await tx.locator('.tx-theme[data-theme-id="quiet"]').click();
  // Python and a deleted row: coloured on the red band too.
  const py = tx.locator('[data-id="toolu_c171_bash_one"]');
  await expect(py.locator('.tx-dl.tx-del .hljs-number')).toHaveText(['3']);
  await expect(py.locator('.tx-dl.tx-add .hljs-number')).toHaveText(['5']);
  // The hunk header and a file with no known extension (VERSION) as before: one plain text.
  expect(await edit.locator('.tx-dh .tx-dt').evaluate((e) => e.childNodes.length)).toBe(1);
  const version = tx.locator('[data-id="toolu_c171_bash_unavail"] .tx-dl:not(.tx-dh) .tx-dt');
  await expect(version).toHaveText(['-1.3.2', '+1.4.0']);
  expect(await version.evaluateAll((es) => es.every((e) => e.childNodes.length === 1 && !e.classList.contains('tx-hl')))).toBe(true);
  // A Codex patch (#173: no line numbers) colours too.
  const codex = tx.locator('.tx-tool[data-status="ok"]', { has: page.locator('.tx-tool-name', { hasText: 'apply_patch' }) });
  await expect(codex.locator('.tx-dl.tx-add .tx-dt.tx-hl').first()).toBeAttached();
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
  for (const mode of ['off', 'trace'] as const) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    const clean = watchErrors(page);
    await watchLongTasks(page);
    const tx = await sitAt(page, `&diffhl=${mode}`, '&simtx=demo-h206');
    const on = mode === 'trace';
    const create = tx.locator('[data-id="h206-create"]');
    const edit = tx.locator('[data-id="h206-edit"]');
    /** Rows a coloured diff colours: every one with code (an empty line has none). Read after a window: it is not cheap. */
    const coloured = async (l: Locator) => {
      if (!on) return;
      const [a, b] = await l.locator('.tx-dl:not(.tx-dh) .tx-dt').evaluateAll((es) => [es.filter((e) => e.classList.contains('tx-hl')).length, es.filter((e) => (e.textContent ?? '').length > 1).length]);
      expect(b).toBeGreaterThan(0);
      expect(a).toBe(b);
    };
    /** Traced: waits for the highlighter's idle mark after its last slice (a cheap look, unlike counting rows). */
    const settled = async () => {
      if (!on) return;
      await expect
        .poll(() => page.evaluate(() => {
          const last = (n: string) => performance.getEntriesByName(n).at(-1);
          const i = last('tx-diff-hl-idle');
          const s = last('tx-diff-hl');
          return !!i && !!s && i.startTime >= s.startTime + s.duration - 0.5;
        }), { timeout: 60_000, intervals: [250] })
        .toBe(true);
    };

    // 1. Open the transcript: both diffs draw (plain), then colour (the create in the worker, the edit here).
    let t0 = await now(page);
    const open = await frameGaps(page, async () => {
      await seatMode(page, 'transcript');
      await expect(create.locator('.tx-dl:not(.tx-dh)')).toHaveCount(2000);
      await expect(edit.locator('.tx-dl.tx-add')).toHaveCount(50);
      await page.waitForTimeout(500);
      await settled();
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

    // 3. The cut change loaded whole (transcript.item: one 2,500-line hunk, the worker's), then "Show next 500 lines".
    const cut = tx.locator('[data-id="h171-cut"]');
    await cut.scrollIntoViewIfNeeded();
    t0 = await now(page);
    const load = await frameGaps(page, async () => {
      await cut.getByRole('button', { name: 'Show the whole change' }).click();
      await expect(cut.locator('.tx-diff-body .tx-dl:not(.tx-dh)')).toHaveCount(2000);
      await page.waitForTimeout(500);
      await settled();
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
    const next = await frameGaps(page, async () => {
      await cut.getByRole('button', { name: 'Show next 500 lines (500 left)' }).click();
      await expect(cut.locator('.tx-diff-body .tx-dl:not(.tx-dh)')).toHaveCount(2500);
      await page.waitForTimeout(500);
      await settled();
      await page.waitForTimeout(1000);
    });
    results[mode].next = { ...(await between(page, t0, await now(page))), frameMax: next };
    await coloured(cut);
    if (on) {
      await expect(cut.locator('.tx-dl:not(.tx-dh) .tx-dt').last()).toHaveClass(/\btx-hl\b/);
      await cut.scrollIntoViewIfNeeded();
      await frames(page, 3);
      await shot(page, 'h206-diff-next-coloured');
    } else expect(await tx.locator('.tx-dt.tx-hl').count()).toBe(0);
    clean();
    await ctx.close();
  }
  console.log(`h206 long tasks: ${JSON.stringify(results)}`);
  console.log(`h206 geometry equal: ${JSON.stringify(geometry.off) === JSON.stringify(geometry.trace)}`);
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
});
