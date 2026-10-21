import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Worker } from '../src/net/protocol';
import { frames, openGame, watchErrors } from './game';

// #145: the overview page's own cost. Its endless motion (a working lamp's blink, the needs-you ring, a busy mark) moves
// opacity and transform only, never a property that repaints; a row off the board's view is skipped (content-visibility):
// it does not animate, and keys still reach it (focused, scrolled to, drawn whole), and its estimated height keeps the
// scrollbar's length in every layout and theme; the lamp's glow and the ring fit inside their row (its paint is clipped
// there); opening the view again keeps its rows and where it was scrolled to, and shows what changed while it was closed. perf-floor60 is 60 workers (36 working, 6 needing you) on one floor; demo-m118's lab nests freelancers.

const info = (page: Page) => page.evaluate(() => window.__h3d.overview()?.page ?? null);
const UBUNTU = { 'h3d.theme.ui': 'ubuntu', 'h3d.theme.transcript': 'ubuntu', 'h3d.theme.terminal': 'ubuntu' };

async function openPage(page: Page): Promise<void> {
  await page.keyboard.press('KeyO');
  await expect.poll(async () => (await info(page))?.open).toBe(true);
  await expect(page.locator('.ov')).not.toHaveClass(/ov--enter/, { timeout: 5000 });
}

async function onPerfFloor(page: Page): Promise<void> {
  await openGame(page, 'perf-floor60', '&screens=0');
  await page.evaluate(() => window.__h3d.enterFloor('perf-floor'));
  await frames(page, 3);
}

/** The endless animations on the page: what each animates, and the row it is in (its key, and whether it is in view). */
function endless(page: Page) {
  return page.evaluate(() => {
    const board = (document.querySelector('.ov-board') as HTMLElement).getBoundingClientRect();
    return document
      .getAnimations()
      .filter((a) => a.effect?.getComputedTiming().iterations === Infinity && (a.effect as KeyframeEffect).target?.closest('.ov'))
      .map((a) => {
        const fx = a.effect as KeyframeEffect;
        const row = fx.target?.closest<HTMLElement>('.ov-row');
        const r = row?.getBoundingClientRect();
        const props = [...new Set(fx.getKeyframes().flatMap((k) => Object.keys(k)))].filter((k) => !['offset', 'computedOffset', 'easing', 'composite'].includes(k));
        // Drawn: the row's contents are rendered (a skipped row's own box is, never what is in it).
        const drawn = !!row?.querySelector('.ov-name')?.checkVisibility({ contentVisibilityAuto: true });
        return { name: (a as CSSAnimation).animationName ?? '', pseudo: fx.pseudoElement, props, row: row?.dataset.key ?? null, drawn, fromView: r ? Math.max(board.top - r.bottom, r.top - board.bottom, 0) : 0 };
      });
  });
}

test('endless motion is opacity and transform only, and only rows near the view run it', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await onPerfFloor(page);
  await openPage(page);
  const rows = (await info(page))?.rows ?? [];
  const lit = rows.filter((r) => r.display === 'working' || r.display === 'needs_you').length;
  expect(lit).toBe(42);
  const anims = await endless(page);
  expect(anims.length).toBeGreaterThan(0);
  for (const a of anims) for (const p of a.props) expect(['opacity', 'transform'], `${a.name} animates ${p}`).toContain(p);
  // The blink is the lamp's lit layer (its glow drawn once on it); the ring the needs-you lamp's.
  expect(new Set(anims.map((a) => `${a.name}${a.pseudo ?? ''}`))).toEqual(new Set(['ov-blink::before', 'ov-ring::after']));
  // Skipped rows run nothing: only rows near the board's view are drawn (Chromium keeps those within a viewport or so
  // of it rendered: here up to some 800px past it), far fewer than the lit ones. A skipped row may hold the animation it had while drawn, never
  // advanced, styled or painted (that is the content-visibility contract: the trace in h145-overview-perf counts it).
  const drawn = anims.filter((a) => a.drawn);
  expect(drawn.length).toBeGreaterThan(0);
  expect(drawn.length).toBeLessThan(lit / 2);
  for (const a of drawn) expect(a.fromView, `${a.row} is ${a.fromView}px off the view`).toBeLessThan(2 * 720);
  // Scrolled to the bottom: the top's rows are skipped (but the focused one: the focus keeps a row drawn), the bottom's
  // are drawn and run.
  const focused = (await info(page))?.focused;
  const top = new Set(drawn.map((a) => a.row).filter((k) => k !== focused));
  await page.locator('.ov-board').evaluate((b) => (b.scrollTop = b.scrollHeight));
  await expect.poll(async () => (await endless(page)).filter((a) => a.drawn && top.has(a.row)).length).toBe(0);
  expect((await endless(page)).filter((a) => a.drawn).length).toBeGreaterThan(0);
  clean();
});

test('keys reach a skipped row: focused, scrolled into view, drawn whole; the scrollbar holds its length', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await onPerfFloor(page);
  await openPage(page);
  const board = page.locator('.ov-board');
  const height = await board.evaluate((b) => b.scrollHeight);
  const rows = (await info(page))?.rows ?? [];
  const last = rows.at(-1)?.key as string;
  const lastRow = page.locator(`.ov-row[data-key="${last}"]`);
  // Off the view, the last row is skipped: its contents are not drawn.
  const drawn = () => lastRow.locator('.ov-name').evaluate((e) => e.checkVisibility({ contentVisibilityAuto: true }));
  expect(await drawn()).toBe(false);
  await page.keyboard.press('End');
  await expect.poll(async () => (await info(page))?.focused).toBe(last);
  await expect(lastRow).toBeFocused();
  await expect(lastRow).toBeInViewport({ ratio: 1 });
  expect(await drawn()).toBe(true);
  await expect(lastRow.locator('.ov-name')).toBeVisible();
  // Its size is its own (the row as drawn), and its lamp lit and blinking if it works.
  const box = await lastRow.boundingBox();
  expect(box?.height).toBeGreaterThan(55);
  if (rows.at(-1)?.display === 'working') expect(await lastRow.locator('.ov-light').evaluate((l) => getComputedStyle(l, '::before').animationName)).toBe('ov-blink');
  // Up a row, and Home: the first again, at the top.
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await info(page))?.focused).toBe(rows.at(-2)?.key);
  await page.keyboard.press('Home');
  await expect(page.locator(`.ov-row[data-key="${rows[0]?.key}"]`)).toBeFocused();
  await expect.poll(() => board.evaluate((b) => b.scrollTop)).toBe(0);
  // Scrolled through every row (each drawn once, its height its own from then on): the board's length stays within a
  // few rows' of what it was with only the top ones drawn (the estimate is near a row's real height).
  for (let y = 0; y < height; y += 300) await board.evaluate((b, top) => (b.scrollTop = top), y);
  const after = await board.evaluate((b) => b.scrollHeight);
  expect(Math.abs(after - height)).toBeLessThan(height * 0.03);
  clean();
});

test('the scrollbar holds its length on every floor\'s long page: Quiet and Ubuntu, wide, narrow and on a phone', async ({ browser }) => {
  test.setTimeout(300_000);
  // Each row kind's estimate per layout and theme (overview.css): scrolled top to bottom, each row drawn as it comes
  // near, the board's length stays within 3% of its length with every row drawn (perf-city240, All: 240 workers, 30 floors).
  for (const [theme, store] of [['quiet', {}], ['ubuntu', UBUNTU]] as const) {
    for (const [width, height] of [[1280, 720], [600, 844], [390, 844]] as const) {
      const page = await browser.newPage({ viewport: { width, height } });
      await page.addInitScript((s) => {
        for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
      }, store as Record<string, string>);
      await openGame(page, 'perf-city240', '&screens=0');
      await frames(page, 3);
      await page.waitForTimeout(2500);
      await openPage(page);
      await page.keyboard.press('KeyF');
      await expect.poll(async () => (await info(page))?.rows?.length).toBe(270);
      await expect(page.locator('.ov')).not.toHaveClass(/ov--enter/, { timeout: 5000 });
      const { lengths, full } = await page.locator('.ov-board').evaluate(async (b) => {
        const frame = () => new Promise((r) => requestAnimationFrame(r));
        const lengths: number[] = [];
        for (let y = 0; y <= b.scrollHeight; y += 400) {
          b.scrollTop = y;
          await frame();
          await frame();
          lengths.push(b.scrollHeight);
        }
        const all = document.createElement('style');
        all.textContent = '.ov-row { content-visibility: visible !important; }';
        document.head.append(all);
        const full = b.scrollHeight;
        all.remove();
        return { lengths, full };
      });
      const off = Math.max(...lengths.map((l) => Math.abs(l - full))) / full;
      test.info().annotations.push({ type: 'length', description: `${theme} ${width}x${height}: ${lengths[0]}..${lengths.at(-1)} of ${full}, at most ${(off * 100).toFixed(1)}% off` });
      expect.soft(off, `${theme} ${width}px: ${lengths[0]} → ${lengths.at(-1)} of ${full}`).toBeLessThan(0.03);
      await page.close();
    }
  }
});

test('the glow and the ring fit inside their row (its paint is clipped there): Quiet and Ubuntu, wide and on a phone', async ({ browser }) => {
  test.setTimeout(240_000);
  for (const [theme, store] of [['quiet', {}], ['ubuntu', UBUNTU]] as const) {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 720 } });
      await page.addInitScript((s) => {
        for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
      }, store as Record<string, string>);
      await openGame(page, 'demo-m118');
      await page.evaluate(() => window.__h3d.enterFloor('lab'));
      await frames(page, 3);
      await openPage(page);
      // The furthest each reaches: the working glow 3px of halo and 14px of blur spread 2px out of the lamp; the
      // needs-you ring (2px out of it) scaled to 2.4.
      const out = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.ov-row[data-display="working"], .ov-row[data-display="needs_you"]')].map((row) => {
          row.scrollIntoView({ block: 'center' });
          const l = (row.querySelector('.ov-light') as HTMLElement).getBoundingClientRect();
          const r = row.getBoundingClientRect();
          const rule = parseFloat(getComputedStyle(row).borderBottomWidth);
          const reach = row.dataset.display === 'working' ? { x: 16, y: 16 } : { x: ((l.width + 4) * 2.4 - l.width) / 2, y: ((l.height + 4) * 2.4 - l.height) / 2 };
          return { key: row.dataset.display, room: Math.min(l.left - reach.x - r.left, l.top - reach.y - r.top, r.right - (l.right + reach.x), r.bottom - rule - (l.bottom + reach.y)) };
        }),
      );
      expect(out.length).toBeGreaterThan(2);
      for (const o of out) expect(o.room, `${theme} ${width}px ${o.key}`).toBeGreaterThanOrEqual(0);
      await page.close();
    }
  }
});

function crew(): Worker[] {
  const snap = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/perf-floor60.jsonl'), 'utf8').split('\n')[0] ?? '{}') as { world: { workers: Worker[] } };
  return snap.world.workers;
}

test('opening the view again keeps its rows and where it was scrolled to, the first focused; what changed while closed shows', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await onPerfFloor(page);
  await openPage(page);
  // Each row tagged: the same element is the same tag after the page closes and opens again.
  const tags = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.ov-board > .ov-row')].map((el, i) => ((el as HTMLElement & { h145?: number }).h145 = i)));
  const first = (await info(page))?.rows ?? [];
  const board = page.locator('.ov-board');
  // Where the board is scrolled to, and the rows in its view.
  const at = () =>
    board.evaluate((b) => {
      const v = b.getBoundingClientRect();
      const keys = [...b.querySelectorAll<HTMLElement>(':scope > .ov-row')].filter((r) => {
        const x = r.getBoundingClientRect();
        return x.bottom > v.top && x.top < v.bottom;
      });
      return { top: b.scrollTop, keys: keys.map((r) => r.dataset.key) };
    });
  await page.keyboard.press('End');
  await expect.poll(() => board.evaluate((b) => b.scrollTop)).toBeGreaterThan(1000);
  // Up some, off the bottom (rows above it never drawn yet): the place to come back to.
  await board.evaluate((b) => (b.scrollTop -= 900));
  await frames(page, 2);
  const was = await at();
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await info(page))?.open).toBe(false);
  await page.keyboard.press('KeyO');
  await expect.poll(async () => (await info(page))?.open).toBe(true);
  // The cascade plays over the kept rows.
  await expect(page.locator('.ov')).toHaveClass(/ov--enter/);
  expect(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.ov-board > .ov-row')].map((el) => (el as HTMLElement & { h145?: number }).h145))).toEqual(tags);
  // As when every open built the rows anew: the board where it was, the same rows in view, the first row focused
  // without scrolling to it.
  await expect(page.locator(`.ov-row[data-key="${first[0]?.key}"]`)).toBeFocused();
  const back = await at();
  expect(Math.abs(back.top - was.top)).toBeLessThanOrEqual(1);
  expect(back.keys).toEqual(was.keys);
  expect(back.keys).not.toContain(first[0]?.key);
  await expect(page.locator('.ov')).not.toHaveClass(/ov--enter/, { timeout: 5000 });
  // The next key goes on from the focused row: the second, scrolled into view.
  await page.keyboard.press('ArrowDown');
  await expect(page.locator(`.ov-row[data-key="${first[1]?.key}"]`)).toBeFocused();
  await expect(page.locator(`.ov-row[data-key="${first[1]?.key}"]`)).toBeInViewport({ ratio: 1 });

  // Closed: one worker goes home, one stops working, one is hired. Open: the page shows them as they are.
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await info(page))?.open).toBe(false);
  const ws = crew();
  const byId = (id: string | undefined) => ws.find((w) => w.id === id) as Worker;
  const gone = byId(first[1]?.key);
  const stops = byId(first.find((r) => r.display === 'working')?.key);
  const hired: Worker = { ...byId(first[0]?.key), id: 'h145-new', workspace_id: 'ws-h145-new', label: 'Zinnia', name: 'Zinnia', desk_index: 61, status: 'working' };
  await page.evaluate(
    ([g, s, n]) => {
      window.__h3d.inject({ t: 'worker.removed', seq: 1_000_000, id: g.id, session: g.session, workspace_id: g.workspace_id });
      window.__h3d.inject({ t: 'worker.status', seq: 1_000_001, id: s.id, session: s.session, workspace_id: s.workspace_id, status: 'idle', prev_status: 'working', status_since: Date.now(), title: '' });
      window.__h3d.inject({ t: 'worker.upsert', seq: 1_000_002, worker: n });
    },
    [gone, stops, hired] as const,
  );
  await page.keyboard.press('KeyO');
  await expect.poll(async () => (await info(page))?.open).toBe(true);
  const now = (await info(page))?.rows ?? [];
  expect(now.map((r) => r.key)).not.toContain(gone.id);
  expect(now.map((r) => r.key)).toContain('h145-new');
  expect(now.find((r) => r.key === stops.id)?.display).toBe('idle');
  // The board is the page's rows, in its order: no leftover, nothing folding or flashing.
  expect(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.ov-board > .ov-row')].map((el) => el.dataset.key))).toEqual(now.map((r) => r.key));
  expect(await page.locator('.ov-row--leaving, .ov-row--flash').count()).toBe(0);
  await expect(page.locator(`.ov-row[data-key="${stops.id}"]`)).toHaveAttribute('data-display', 'idle');
  // The rows that stayed are the same elements.
  const kept = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.ov-board > .ov-row')].filter((el) => (el as HTMLElement & { h145?: number }).h145 !== undefined).length);
  expect(kept).toBe(first.length - 1);

  // `a` still switches to every floor's page; the board stays where it was scrolled (as it always did), its first row
  // focused.
  await expect(page.locator('.ov')).not.toHaveClass(/ov--enter/, { timeout: 5000 });
  await board.evaluate((b) => (b.scrollTop = 1500));
  await page.keyboard.press('KeyA');
  await expect.poll(async () => (await info(page))?.view).toBe('city');
  await expect.poll(async () => (await info(page))?.rows?.[0]?.kind).toBe('floor');
  await expect.poll(async () => (await info(page))?.focused).toBe((await info(page))?.rows?.[0]?.key);
  expect(Math.abs((await board.evaluate((b) => b.scrollTop)) - 1500)).toBeLessThanOrEqual(1);
  clean();
});
