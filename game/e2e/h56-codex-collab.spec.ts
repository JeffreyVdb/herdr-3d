import { expect, test, type Locator, type Page } from '@playwright/test';
import { frames, openGame, seatMode, shot, watchErrors } from './game';

// #56: Codex's collaboration calls in the transcript, for real on the WebGL2 path: demo-h171 with the simulating fixture
// server and `simtx=demo-h56`, whose watches get what the bridge makes of its trimmed Codex rollout
// (tools/fixture-transcript.ts `h56Timeline`). Open it yourself: ?ws=%2Ffixture%2Fdemo-h171%3Fsim%3D1%26simtx%3Ddemo-h56
// and sit at Nibble on herdr-3d.

const SIM = 'play=none&sim=1&simms=500&simusage=0&simtx=demo-h56';
const SPAWN = 'call_b29014c00922488d89e346e245b44af0';

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
  await expect(tx.locator(`[data-id="${SPAWN}"]`)).toBeAttached();
  return tx;
}

test('Codex collaboration calls read as what happened; the raw call is one more click away', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  const tx = await sitAt(page);
  const spawn = tx.locator(`[data-id="${SPAWN}"]`);
  await expect(spawn.locator('.tx-tool-row')).toHaveText(/Spawn subagent\s*gpu_research on gpt-6\.1-sol high/);
  await expect(tx.locator('.tx-collab')).toHaveCount(9);
  await expect(tx).not.toContainText('collaboration.');
  await expect(tx).not.toContainText('gAAAAA');
  await spawn.locator('.tx-tool-row').click();
  await expect(spawn.locator('.tx-collab-fields dt')).toHaveText(['Agent', 'Model', 'Effort', 'Thread']);
  await expect(spawn.locator('.tx-note')).toHaveText('Message encrypted by Codex (multi-agent v2). Not readable from the session files.');
  const raw = spawn.locator('details.tx-collab-raw');
  await expect(raw).not.toHaveAttribute('open');
  await expect(raw.locator('pre').first()).toBeHidden();
  await spawn.scrollIntoViewIfNeeded();
  await frames(page, 4);
  await shot(page, 'h56-codex-collab');
  await raw.locator('summary').click();
  await expect(raw.locator('pre').first()).toContainText('gAAAAABstub0000');
  await page.setViewportSize({ width: 390, height: 844 });
  await spawn.scrollIntoViewIfNeeded();
  await frames(page, 4);
  await shot(page, 'h56-codex-collab-390');
  // The raw request is not clipped: a 5 KB unbroken ciphertext wraps inside its box at 390 px, the row does not widen.
  const fit = await raw.evaluate((d) => {
    const pre = d.querySelector('pre') as HTMLElement;
    pre.textContent = `{"task_name":"gpu_research","message":"gAAAAAB${'x'.repeat(5000)}"}`;
    const list = d.closest('.tx-list') as HTMLElement;
    return { pre: pre.scrollWidth - pre.clientWidth, list: list.scrollWidth - list.clientWidth, scrolls: pre.scrollHeight > pre.clientHeight };
  });
  expect(fit).toEqual({ pre: 0, list: 0, scrolls: true });
  clean();
});
