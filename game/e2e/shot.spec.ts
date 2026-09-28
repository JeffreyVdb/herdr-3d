import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pixelStats } from './pixels';

const SHOT = resolve(import.meta.dirname, '../test-results/shot.png');

test('placeholder scene renders with WebGL2', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    if (m.type() === 'warning' && !m.text().includes('GL Driver Message')) console.log(`page warning: ${m.text()}`);
  });

  await page.goto('/?backend=webgl2');
  // Wait for a few rendered frames so shadows and the first real draw have landed,
  // or bail out early if the renderer failed to start.
  await page.waitForFunction(() => window.__h3d?.error || window.__h3d?.frames >= 3, undefined, {
    timeout: 45_000,
  });
  expect(await page.evaluate(() => window.__h3d.error)).toBeNull();

  const backend = await page.evaluate(() => window.__h3d.backend);
  expect(backend).toBe('webgl2');
  await expect(page.locator('#debug')).toHaveText('backend: webgl2');

  // Which GL implementation actually rendered (expect mesa llvmpipe via ANGLE/Vulkan).
  const glRenderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  });

  const png = await page.screenshot();
  mkdirSync(dirname(SHOT), { recursive: true });
  writeFileSync(SHOT, png);

  // Judge blankness on the canvas alone: the overlay by itself must not pass.
  const bare = await page.screenshot({ style: '#debug { visibility: hidden; }' });
  const stats = pixelStats(PNG.sync.read(bare).data);
  console.log(`shot: ${SHOT} backend=${backend} gl=${glRenderer} ${JSON.stringify(stats)}`);
  expect(stats.variance, 'screenshot looks blank').toBeGreaterThan(100);
  expect(stats.distinctColors, 'screenshot looks flat').toBeGreaterThan(50);
  expect(errors).toEqual([]);
});
