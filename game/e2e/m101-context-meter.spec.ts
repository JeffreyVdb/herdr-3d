import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Usage } from '../src/net/protocol';
import { frames, openGame, shot, watchErrors } from './game';

// #101: the context meter in the transcript bar, for real: demo-m5's usage numbers (Tofu is a Claude worker: an
// assumed window; a Codex worker shows its own and the baseline note). Every preset, 80-200% zoom (the strip does not
// zoom) and a phone's width, where the window part of the label goes and the strip wraps cleanly.

const FLOOR = 'herdr-3d';
const SIM = 'play=none&sim=1&simms=500&simusage=0';

/** Sits at the first of `names` the player can walk up to and face; returns its id and name. */
async function sitAt(page: Page, names: string | string[], storage: Record<string, string> = {}): Promise<{ id: string; name: string }> {
  await page.addInitScript((kv) => {
    try {
      for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
    } catch {
      /* blocked */
    }
  }, storage);
  await openGame(page, 'demo-m5', '&prints=0', SIM);
  await page.evaluate((s) => window.__h3d.enterFloor(s), FLOOR);
  await frames(page, 3);
  let id = '';
  let name = '';
  for (const n of [names].flat()) {
    id = await page.evaluate((who) => window.__h3d.world().flatMap((f) => f.workers).find((w) => w.name === who)?.id ?? '', n);
    name = n;
    if (id && (await page.evaluate((i) => window.__h3d.face(i), id))) break;
    id = '';
  }
  expect(id, `facing one of ${[names].flat().join(', ')}`).not.toBe('');
  await frames(page, 3);
  expect(await page.evaluate((w) => window.__h3d.sitAt(w), id)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBe(id);
  await expect(page.locator('.seat')).toBeVisible();
  await expect(page.locator('.tx')).toBeVisible();
  await frames(page, 20);
  return { id, name };
}

/** The usage the fixture server sends for a worker (the file is the source: `simusage=0` changes nothing in it). */
function fixtureUsage(name: string): Usage | null {
  const snap = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/demo-m5.jsonl'), 'utf8').split('\n')[0] as string) as {
    world: { floors: Array<{ workers?: Array<{ name: string; usage?: Usage }> }>; workers?: Array<{ name: string; usage?: Usage }> };
  };
  const all = [...(snap.world.workers ?? []), ...snap.world.floors.flatMap((f) => f.workers ?? [])];
  return all.find((w) => w.name === name)?.usage ?? null;
}
const text = async (el: ReturnType<Page['locator']>) => ((await el.innerText()) ?? '').replace(/\s+/g, ' ').trim();

test('a seated Claude worker shows its context: share, count and an assumed window, matching the bridge', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await sitAt(page, 'Tofu');
  const u = fixtureUsage('Tofu');
  expect(u?.context_pct).toBeGreaterThan(0);
  const meter = page.locator('.tx-bar .tx-ctx');
  await expect(meter).toBeVisible();
  await expect(meter).toHaveAttribute('role', 'meter');
  await expect(meter).toHaveAttribute('aria-valuenow', String(u?.context_pct));
  const label = await text(meter);
  expect(label).toMatch(new RegExp(`^${Math.round(u?.context_pct ?? -1)}% · \\d+(\\.\\d)?k / ~200k$`));
  await expect(meter).toHaveAttribute('title', /Context in use: [\d,]+ of 200,000 tokens \(\d+\.\d%\)\. .*Window size assumed\./);
  await shot(page, 'm101-meter-claude');
  // The fill is the share of the track.
  const [track, fill] = await Promise.all([page.locator('.tx-ctx-track').boundingBox(), page.locator('.tx-ctx-fill').boundingBox()]);
  expect(fill!.width / track!.width).toBeCloseTo((u?.context_pct ?? 0) / 100, 1);
  // Before the preset and zoom, on the strip's first line at this width.
  const [m, look] = await Promise.all([meter.boundingBox(), page.locator('.tx-look').boundingBox()]);
  expect(m!.y).toBeLessThan(look!.y + look!.height);
  expect(m!.x + m!.width).toBeLessThanOrEqual(look!.x + 1);
  clean();
});

test('a seated Codex worker shows the rollout\'s window and says its share leaves out the baseline', async ({ page }) => {
  test.setTimeout(150_000);
  await openGame(page, 'demo-m5', '&prints=0', SIM);
  const codex = await page.evaluate((f) => window.__h3d.world().filter((x) => x.session === f).flatMap((x) => x.workers).filter((w) => w.harness === 'codex').map((w) => w.name), FLOOR);
  const { name } = await sitAt(page, codex.filter((n) => fixtureUsage(n)?.context_pct != null));
  const u = fixtureUsage(name);
  const meter = page.locator('.tx-bar .tx-ctx');
  await expect(meter).toBeVisible();
  expect(await text(meter)).toMatch(new RegExp(`^${Math.round(u?.context_pct ?? -1)}% · \\d+k / 272k$`));
  await expect(meter).toHaveAttribute('title', /272,000 tokens .*The percentage leaves out Codex's 12,000-token baseline\.$/);
  await expect(meter).not.toHaveAttribute('title', /assumed/);
});

test('every preset: the number reads, and the steps (neutral, warm, hot) differ from each other and from the track; the zoom does not resize the strip', async ({ page }) => {
  test.setTimeout(300_000);
  const clean = watchErrors(page);
  await sitAt(page, 'Tofu');
  const tx = page.locator('.tx');
  const meter = tx.locator('.tx-bar .tx-ctx');
  for (const pick of ['quiet', 'ubuntu']) {
    await tx.locator(`[role="radio"][data-theme-id="${pick}"]`).click();
    await page.evaluate(() => window.__h3d.themeLoaded());
    await expect(tx).toHaveAttribute('data-theme', pick);
    // The real levels come from the share (vitest); here the CSS of each step, set by hand on the same element.
    const steps = await meter.evaluate((e) => {
      const out: Record<string, { text: string; fill: string; track: string }> = {};
      for (const level of ['ok', 'warm', 'hot']) {
        (e as HTMLElement).dataset.level = level;
        out[level] = {
          text: getComputedStyle(e.querySelector('.tx-ctx-pct')!).color,
          fill: getComputedStyle(e.querySelector('.tx-ctx-fill')!).backgroundColor,
          track: getComputedStyle(e.querySelector('.tx-ctx-track')!).backgroundColor,
        };
      }
      return out;
    });
    expect(new Set([steps.ok?.fill, steps.warm?.fill, steps.hot?.fill]).size, `${pick}: three fills`).toBe(3);
    for (const level of ['ok', 'warm', 'hot']) expect(steps[level]?.fill, `${pick} ${level} on its track`).not.toBe(steps[level]?.track);
    expect(await text(meter)).toMatch(/^\d+% · /);
    await shot(page, `m101-meter-${pick}`);
  }
  // The strip's controls do not zoom: nor does the meter.
  const baseBox = await meter.boundingBox();
  for (const label of ['Larger text', 'Larger text', 'Smaller text', 'Smaller text', 'Smaller text', 'Smaller text']) {
    await tx.getByRole('button', { name: label }).click();
    const box = await meter.boundingBox();
    expect(Math.round(box!.width)).toBe(Math.round(baseBox!.width));
    expect(Math.round(box!.height)).toBe(Math.round(baseBox!.height));
  }
  clean();
});

test.describe('phone width', () => {
  test.use({ viewport: { width: 375, height: 667 } });
  test('the strip wraps cleanly: the share stays, the window goes, the meter never sits in the zoom group', async ({ page }) => {
    test.setTimeout(150_000);
    const clean = watchErrors(page);
    await sitAt(page, 'Tofu');
    const meter = page.locator('.tx-bar .tx-ctx');
    await expect(meter).toBeVisible();
    const u = fixtureUsage('Tofu');
    expect(await text(meter)).toMatch(new RegExp(`^${Math.round(u?.context_pct ?? -1)}%( · \\d+(\\.\\d)?k)?$`));
    await expect(page.locator('.tx-ctx-win')).toBeHidden();
    const [m, bar, look] = await Promise.all([meter.boundingBox(), page.locator('.tx-bar').boundingBox(), page.locator('.tx-look').boundingBox()]);
    expect(m!.x).toBeGreaterThanOrEqual(bar!.x);
    expect(m!.x + m!.width).toBeLessThanOrEqual(bar!.x + bar!.width + 1);
    // Not inside the preset and zoom group's box.
    const overlaps = m!.x < look!.x + look!.width && m!.x + m!.width > look!.x && m!.y < look!.y + look!.height && m!.y + m!.height > look!.y;
    expect(overlaps).toBe(false);
    // Nothing scrolls sideways.
    expect(await page.locator('.tx-bar').evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    await shot(page, 'm101-meter-phone');
    clean();
  });
});
