import { expect, test, type Locator, type Page } from '@playwright/test';
import { frames, openGame, seatMode, shot, watchErrors } from './game';

// #132: Codex's polls of background terminals in the transcript, for real on the WebGL2 path: demo-h171 with the simulating
// fixture server and `simtx=demo-h132`, whose watches get what the bridge makes of its synthetic rollouts
// (tools/fixture-transcript.ts `h132Timeline`). Open it yourself: ?ws=%2Ffixture%2Fdemo-h171%3Fsim%3D1%26simtx%3Ddemo-h132
// and sit at Nibble on herdr-3d.

const SIM = 'play=none&sim=1&simms=500&simusage=0&simtx=demo-h132';

async function sitAt(page: Page): Promise<Locator> {
  await openGame(page, 'demo-h171', '&prints=0', SIM);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  const id = await page.evaluate(() => window.__h3d.world().flatMap((f) => f.workers).find((w) => w.name === 'Nibble')?.id ?? '');
  expect(await page.evaluate((i) => window.__h3d.face(i), id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((w) => window.__h3d.sitAt(w), id)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBe(id);
  await seatMode(page, 'transcript');
  const tx = page.locator('.seat-transcript .tx');
  await expect(tx.locator('[data-id="call_p132exit1"]')).toBeAttached();
  return tx;
}

test('a poll names the command it waits on and what happened; opened, its new output', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  const tx = await sitAt(page);
  const sum = (id: string) => tx.locator(`[data-id="${id}"] .tx-tool-sum`);
  await expect(sum('call_p132running')).toHaveText('Waited for pnpm exec vitest run · still running · 30s');
  await expect(sum('call_p132ctrlc')).toHaveText('Sent ^C to uv run pytest -x · exited 130');
  await expect(sum('call_p132unknown')).toHaveText('Waited for background terminal 39999 · still running · 5s');
  await expect(tx.locator('.tx-tool-sum', { hasText: 'tools.write_stdin' })).toHaveCount(0);
  const failed = tx.locator('[data-id="call_p132exit1"]');
  await expect(failed).toHaveAttribute('data-status', 'error');
  await expect(tx.locator('[data-id="call_p132image"] .tx-strip')).toBeVisible();
  await failed.locator('.tx-tool-row').click();
  await expect(failed.locator('.tx-tool-body')).toContainText('Tests  1 failed | 14 passed (15)');
  await expect(failed.locator('.tx-tool-body')).not.toContainText('chunk_id');
  await failed.scrollIntoViewIfNeeded();
  await frames(page, 4);
  await shot(page, 'h132-codex-polls');
  await page.setViewportSize({ width: 390, height: 844 });
  await tx.locator('[data-id="call_p132image"]').scrollIntoViewIfNeeded();
  await frames(page, 4);
  await shot(page, 'h132-codex-polls-390');
  clean();
});
