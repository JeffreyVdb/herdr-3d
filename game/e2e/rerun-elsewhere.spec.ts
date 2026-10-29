import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Worker } from '../src/net/protocol';
import { frames, openGame, seatMode, shot, watchErrors } from './game';

// Run elsewhere against the fixture bridge: the button on a message you wrote opens the picker over the seat on the
// other harness; Enter hires through the Hire dialog (its `go`) with the message as the first task and `rerun_of`; you
// stay at the laptop, and the seat bar gets a chip for the new worker.

const SIM = 'play=none&sim=1&simms=150&simusage=0';

function demoWorker(name: string): Worker {
  const snap = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/demo-m5.jsonl'), 'utf8').split('\n')[0] ?? '{}') as { world: { workers: Worker[] } };
  const w = snap.world.workers.find((x) => x.name === name);
  if (!w) throw new Error(`no ${name} in demo-m5`);
  return w;
}

async function sitAtTranscript(page: Page, w: Worker): Promise<void> {
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.face(id), w.id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.sitAt(id), w.id)).toBe(true);
  await frames(page, 20);
  await seatMode(page, 'transcript');
  await expect(page.locator('.seat-transcript .tx .tx-scroll')).toBeFocused();
}

const hires = (page: Page) => page.evaluate(() => window.__h3d.sent().filter((c) => c.t === 'worker.hire').map((c) => c.args as Record<string, unknown>));

test('Run elsewhere: the picker under a message, Enter hires on the other harness, and both seats link', async ({ page }) => {
  const clean = watchErrors(page);
  // The Ubuntu theme, as h172 sets it: before the page loads.
  await page.addInitScript(() => ['ui', 'transcript', 'terminal'].forEach((k) => localStorage.setItem(`h3d.theme.${k}`, 'ubuntu')));
  await openGame(page, 'demo-m5', '', SIM);
  const w = demoWorker('Zippy');
  await sitAtTranscript(page, w);
  await page.evaluate((id) => window.__h3d.simHandoff('sim.prompt_turn', { id, text: 'Read the access logs and track which buckets and prefixes are touched.' }), w.id);
  const tx = page.locator('.seat-transcript .tx');
  const row = tx.locator('.tx-user.tx-can-rerun').last();
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  const btn = row.getByRole('button', { name: 'Run elsewhere' });
  await expect(btn).toBeVisible();
  await shot(page, 'rerun-hover');
  await btn.click();

  const pick = page.getByRole('dialog', { name: /elsewhere/ });
  await expect(pick).toBeVisible();
  const other = w.harness === 'codex' ? 'claude' : 'codex';
  await expect(pick.locator(`input[name="rerun-harness"][value="${other}"]`)).toBeChecked();
  await shot(page, 'rerun-picker');
  // The picker keeps the seat (the frame check would stand you up for any other dialog).
  await frames(page, 5);
  expect((await page.evaluate(() => window.__h3d.seat())).shown).toBe(true);

  await page.keyboard.press('Enter');
  await expect.poll(() => hires(page).then((h) => h.length)).toBe(1);
  const [hire] = await hires(page);
  expect(hire).toMatchObject({ harness: other, prompt: 'Read the access logs and track which buckets and prefixes are touched.', rerun_of: w.id });
  await expect(page.locator('.seat-rerun')).toHaveCount(1);
  expect((await page.evaluate(() => window.__h3d.seat())).shown).toBe(true);
  await shot(page, 'rerun-chip');
  // A narrow window: the button beside a wide bubble, and the chip in the header.
  await page.setViewportSize({ width: 900, height: 720 });
  await frames(page, 5);
  await row.hover();
  await expect(btn).toBeVisible();
  await shot(page, 'rerun-900');
  clean();
});
