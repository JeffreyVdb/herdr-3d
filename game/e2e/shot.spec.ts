import { expect, test } from '@playwright/test';
import { openGame, shot, watchErrors } from './game';

test('the game renders the fixture city with WebGL2', { tag: '@smoke' }, async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page);
  await expect(page.locator('#debug')).toHaveText('backend: webgl2');

  // Which GL implementation actually rendered (expect mesa llvmpipe via ANGLE/Vulkan).
  const glRenderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  });
  console.log(`gl=${glRenderer}`);
  await shot(page, 'shot');
  clean();
});
