import { expect, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pixelStats } from './pixels';

export const RESULTS = resolve(import.meta.dirname, '../test-results');

/** Collects page errors; call `expectClean()` at the end of a test. */
export function watchErrors(page: Page): () => void {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    if (m.type() === 'warning' && !m.text().includes('GL Driver Message')) console.log(`page warning: ${m.text()}`);
  });
  return () => expect(errors).toEqual([]);
}

/**
 * Opens the built game on the WebGL2 backend against a recorded fixture, waits
 * for the first world frame. `wsQuery` goes to the fixture server (e.g.
 * `sim=1` to simulate commands).
 */
export async function openGame(page: Page, fixture = 'demo', extra = '', wsQuery = 'play=none'): Promise<void> {
  const ws = encodeURIComponent(`/fixture/${fixture}?${wsQuery}`);
  await page.goto(`/?backend=webgl2&ws=${ws}${extra}`);
  await page.waitForFunction(() => window.__h3d?.error || (window.__h3d?.ready && window.__h3d.frames >= 3), undefined, {
    timeout: 60_000,
  });
  expect(await page.evaluate(() => window.__h3d.error)).toBeNull();
  expect(await page.evaluate(() => window.__h3d.backend)).toBe('webgl2');
}

/** Waits for `n` more rendered frames. */
export async function frames(page: Page, n = 3): Promise<void> {
  const start = await page.evaluate(() => window.__h3d.frames);
  await page.waitForFunction((want) => window.__h3d.frames >= want, start + n, { timeout: 30_000 });
}

/**
 * Saves a full screenshot to test-results/<name>.png and checks the canvas
 * alone (HUD and debug overlay hidden) is not blank.
 */
export async function shot(page: Page, name: string): Promise<string> {
  const path = resolve(RESULTS, `${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, await page.screenshot());
  const bare = await page.screenshot({ style: '.hud, #debug { visibility: hidden !important; }' });
  const stats = pixelStats(PNG.sync.read(bare).data);
  console.log(`shot: ${path} ${JSON.stringify(stats)}`);
  expect(stats.variance, `${name} looks blank`).toBeGreaterThan(100);
  expect(stats.distinctColors, `${name} looks flat`).toBeGreaterThan(50);
  return path;
}
