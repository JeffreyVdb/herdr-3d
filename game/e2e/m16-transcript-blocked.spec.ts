import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Worker } from '../src/net/protocol';
import { frames, openGame, seatMode, watchErrors } from './game';

// M16: a worker going from working to blocked while you type a prompt in its transcript view (demo-m5, sim=1).
// The prompt box turns off (the bridge refuses prompts to a blocked worker) and (#187) the question opens the questions'
// sheet with the keyboard in it, so its reply digits work without a click; hidden, the scroll keys are the timeline's
// again; the draft stays.

const SIM = 'play=none&sim=1&simms=500&simusage=0';

/** Tofu as the demo-m5 fixture has it: a blocked claude with a permission question. */
function tofu(): Worker {
  const snap = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/demo-m5.jsonl'), 'utf8').split('\n')[0] ?? '{}') as { world: { workers: Worker[] } };
  const w = snap.world.workers.find((x) => x.name === 'Tofu');
  if (!w) throw new Error('no Tofu in demo-m5');
  return w;
}

test('a question arriving while you type: the prompt turns off, its draft kept, the sheet opens and 1 answers the new question', async ({ page }) => {
  const clean = watchErrors(page);
  const w = tofu();
  const answers = () => page.evaluate(() => window.__h3d.sent().filter((c) => c.t === 'worker.answer'));
  await openGame(page, 'demo-m5', '', SIM);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.face(id), w.id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.sitAt(id), w.id)).toBe(true);
  await frames(page, 30);

  // Answer the question it came with: it works again and takes a prompt. (#98: its conversation is up as you sit;
  // #187: the question opened the sheet, the keyboard on its highlighted choice.)
  await seatMode(page, 'transcript');
  const tx = page.locator('.seat-transcript .tx');
  const sheet = page.locator('dialog.tx-qsheet');
  await expect(sheet).toHaveAttribute('open', '');
  await expect(sheet.locator('.tx-bq .tx-choice-sel')).toBeFocused();
  await page.keyboard.press('1');
  await expect.poll(async () => (await answers()).length).toBe(1);
  // The simulator plays out its turn (working, then done): wait for it, so it does not undo the question below.
  await expect.poll(() => page.evaluate((id) => window.__h3d.status(id)?.status ?? null, w.id), { timeout: 15_000 }).toBe('done');
  await expect(tx.locator('.tx-input')).toBeEnabled();
  await expect(sheet).toBeHidden(); // the question went: the sheet with it
  await expect(tx.locator('.tx-scroll')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(tx.locator('.tx-input')).toBeFocused();
  await page.keyboard.type('draft while agent works');

  // Mid-draft it hits another question.
  const q = { ...(w.question as NonNullable<Worker['question']>), hash: 'q-second', text: 'Allow the second push?' };
  await page.evaluate((x) => window.__h3d.inject({ t: 'worker.upsert', seq: 1_000_000, worker: x }), { ...w, status: 'blocked', question: q });
  await expect(sheet).toHaveAttribute('open', '');
  await expect(sheet.locator('.tx-bq')).toContainText('Allow the second push?');
  await expect(tx.locator('.tx-input')).toBeDisabled();
  await expect(tx.locator('.tx-input')).toHaveText('draft while agent works');
  // The keyboard went into the sheet, not <body>.
  await expect(sheet.locator('.tx-bq .tx-choice').first()).toBeFocused();

  // No click: 1 answers the new question; hidden (Esc), the scroll keys work.
  await page.keyboard.press('1');
  await expect.poll(async () => (await answers()).length).toBe(2);
  expect((await answers()).at(-1)?.args).toEqual({ id: w.id, hash: 'q-second', choice: 1 });
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(tx.locator('.tx-scroll')).toBeFocused();
  expect(await page.evaluate(() => window.__h3d.seated())).not.toBeNull();
  const top = () => tx.locator('.tx-scroll').evaluate((e) => e.scrollTop);
  await page.keyboard.press('Home');
  expect(await top()).toBe(0);
  await page.keyboard.press('j');
  expect(await top()).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__h3d.sent().filter((c) => c.t === 'worker.prompt' || c.t === 'worker.keys').length)).toBe(0);
  clean();
});

test('an ask over the screen’s question while the sheet is open: the keyboard goes to the ask, Esc only hides the sheet (#187 R1)', async ({ page }) => {
  const clean = watchErrors(page);
  const w = tofu();
  const seen: string[] = [];
  await page.exposeFunction('h3dWindowKey', (k: string) => void seen.push(k));
  await openGame(page, 'demo-m5', '', SIM);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.face(id), w.id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.sitAt(id), w.id)).toBe(true);
  await frames(page, 30);
  await seatMode(page, 'transcript');
  const sheet = page.locator('dialog.tx-qsheet');
  await expect(sheet).toHaveAttribute('open', '');
  await expect(sheet.locator('.tx-bq .tx-choice-sel')).toBeFocused();
  // What reaches the page's own keys (the laptop's Esc stands you up), from here on.
  await page.evaluate(() => window.addEventListener('keydown', (e) => void (window as unknown as { h3dWindowKey(k: string): void }).h3dWindowKey(e.key)));

  // The agent asks while the screen's question is up: the ask's card replaces it (and its focused chip).
  const ask = {
    tool_use_id: 'toolu_e2e_r1',
    agent: 'claude',
    questions: [{ header: 'Color', question: 'Which color?', multi: false, other: false, options: [{ label: 'Red' }, { label: 'Blue' }] }],
  };
  await page.evaluate(([id, a]) => window.__h3d.simAsk({ id, ask: a }), [w.id, ask] as const);
  await expect(sheet.locator('.tx-ask')).toBeVisible();
  await expect(sheet.locator('.tx-bq')).toBeHidden();
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('dialog.tx-qsheet .tx-ask'))).toBe(true);
  await page.keyboard.press('2');
  await expect(sheet.locator('.tx-ask-opt[data-n="2"]')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  expect(await page.evaluate(() => window.__h3d.seated())).not.toBeNull();
  expect(seen).toEqual([]);
  expect(await page.evaluate(() => window.__h3d.sent().filter((c) => c.t === 'worker.answer').length)).toBe(0);
  clean();
});
