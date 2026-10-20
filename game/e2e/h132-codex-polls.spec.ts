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
  const term = (id: string) => tx.locator(`[data-id="${id}"] .tx-tool-term`);
  await expect(sum('call_p132running')).toHaveText('Waited for pnpm exec vitest run');
  await expect(term('call_p132running')).toHaveText('process running');
  await expect(sum('call_p132ctrlc')).toHaveText('Sent ^C to uv run pytest -x');
  await expect(term('call_p132ctrlc')).toHaveText('exited 130');
  await expect(sum('call_p132unknown')).toHaveText('Waited for background terminal 39999');
  await expect(term('call_p132unknown')).toHaveText('process running');
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
  // At phone width the command gives way: the process stays whole, inside its row and every box that clips it.
  const running = tx.locator('[data-id="call_p132running"]');
  await running.scrollIntoViewIfNeeded();
  await frames(page, 4);
  await expect.poll(() => clipped(running.locator('.tx-tool-term'))).toBe('');
  expect(await running.locator('.tx-tool-sum').evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  await shot(page, 'h132-codex-polls-390-running');
  // Both transcript presets, light and dark: the process still whole, a failed one in the error's colour.
  const ctrlc = tx.locator('[data-id="call_p132ctrlc"]');
  for (const preset of ['quiet', 'ubuntu'] as const) {
    await tx.locator(`.tx-theme[data-theme-id="${preset}"]`).click();
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      for (const r of [ctrlc, running]) {
        await r.scrollIntoViewIfNeeded();
        await frames(page, 3);
        await expect.poll(() => clipped(r.locator('.tx-tool-term'))).toBe('');
      }
      const [fail, ok] = await Promise.all([ctrlc, running].map((r) => r.locator('.tx-tool-term').evaluate((e) => getComputedStyle(e).color)));
      expect(fail).not.toBe(ok);
      await shot(page, `h132-codex-polls-390-${preset}-${colorScheme}`);
    }
  }
  await page.emulateMedia({ colorScheme: null });
  await tx.locator('.tx-theme[data-theme-id="quiet"]').click();
  await tx.locator('[data-id="call_p132image"]').scrollIntoViewIfNeeded();
  await frames(page, 4);
  await shot(page, 'h132-codex-polls-390');
  clean();
});

/** Why el is not fully shown ('' when it is): cut in itself, or outside its row or an ancestor that clips. */
function clipped(el: Locator): Promise<string> {
  return el.evaluate((e) => {
    if (e.scrollWidth > e.clientWidth) return `cut: ${e.scrollWidth} > ${e.clientWidth}`;
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return 'no box';
    const row = e.closest('.tx-tool-row');
    for (let a = e.parentElement; a; a = a.parentElement) {
      if (a !== row && getComputedStyle(a).overflow === 'visible') continue;
      const b = a.getBoundingClientRect();
      if (r.left < b.left - 0.5 || r.right > b.right + 0.5 || r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5) {
        return `outside ${a.className || a.tagName}: [${r.left},${r.right}] in [${b.left},${b.right}]`;
      }
    }
    return '';
  });
}
