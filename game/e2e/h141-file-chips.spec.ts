import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Worker } from '../src/net/protocol';
import { frames, openGame, RESULTS, seatMode, watchErrors } from './game';

// #141: `@` in the transcript's prompt box searches the worker's checkout, for real, against the simulating fixture
// server (tools/fixture-panels.ts `simFiles`). You sit at Pebble (an idle Claude) and Dumpling (a done Codex), type
// `@comp`, pick, and the file is an atomic chip; the prompt that leaves the game carries `@path` for both harnesses
// (the bridge, not the game, strips the `@` for Codex, #138). The draft with its chip survives a reload.

const SIM = 'play=none&sim=1&simms=300&simusage=0';
/** A plain screenshot: `game.ts`'s `shot` hides the HUD for its pixel stats, which takes the focus out of the prompt box. */
const shot = (page: Page, name: string) => page.screenshot({ path: resolve(RESULTS, `${name}.png`) });

function demoWorker(name: string): Worker {
  const snap = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/demo-m5.jsonl'), 'utf8').split('\n')[0] ?? '{}') as { world: { workers: Worker[] } };
  const w = snap.world.workers.find((x) => x.name === name);
  if (!w) throw new Error(`no ${name} in demo-m5`);
  return w;
}

const sent = (page: Page, t: string) => page.evaluate((x) => window.__h3d.sent().filter((c) => c.t === x), t);
const prompts = async (page: Page) => (await sent(page, 'worker.prompt')).map((x) => (x.args as { text: string }).text);

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

const tx = (page: Page) => page.locator('.seat-transcript .tx');
const pop = (page: Page) => tx(page).locator('.cmp-pop');
const rows = (page: Page) => tx(page).locator('[role="option"]');
const input = (page: Page) => tx(page).locator('.tx-input');
const chips = (page: Page) => input(page).locator('.cmp-file');

for (const c of [
  { harness: 'claude', worker: 'Pebble' },
  { harness: 'codex', worker: 'Dumpling' },
] as const) {
  test(`${c.harness}: @comp lists files, a pick is a chip, and the prompt leaves the game with @path`, async ({ page }) => {
    const clean = watchErrors(page);
    const w = demoWorker(c.worker);
    await openGame(page, 'demo-m5', '', SIM);
    await sitAtTranscript(page, w);

    await input(page).click();
    await page.keyboard.type('look at @comp');
    await expect(pop(page)).toBeVisible();
    await expect(tx(page).getByRole('listbox')).toHaveAttribute('aria-label', 'Files and folders');
    await expect(rows(page).first().locator('.tx-file-name')).toHaveText('composer.ts');
    await expect(rows(page).first().locator('.tx-file-dir')).toHaveText('game/src/ui');
    // The fixture aligns leftmost: the `c` of `src`, then `omp` of the basename (code points of the whole path).
    await expect(rows(page).first().locator('.tx-file-name .tx-file-hit')).toHaveText(['omp']);
    await expect(rows(page).first().locator('.tx-file-dir .tx-file-hit')).toHaveText(['c']);
    // Asked for the latest query (the debounce let none of the shorter ones go once typing was quick).
    await expect.poll(async () => (await sent(page, 'worker.files')).map((x) => x.args).at(-1)).toEqual({ id: w.id, query: 'comp', limit: 30 });
    // One row per line: the basename is never the part that is cut.
    expect(await rows(page).locator('.tx-file-name').evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent))).toEqual([]);
    await shot(page, `h141-${c.harness}-open`);

    await page.keyboard.press('Enter');
    await expect(pop(page)).toBeHidden();
    await expect(chips(page)).toHaveCount(1);
    await expect(chips(page).first()).toHaveAttribute('aria-label', 'File game/src/ui/composer.ts');
    await expect(chips(page).first()).toHaveAttribute('title', 'game/src/ui/composer.ts');
    await expect(chips(page).first()).toHaveText('composer.ts');
    expect(await sent(page, 'worker.prompt')).toHaveLength(0);

    // A folder, and a path with a space (quoted when it goes).
    await page.keyboard.type('in @docs');
    await expect(rows(page).first().locator('.tx-file-name')).toHaveText('docs/');
    await page.keyboard.press('Tab');
    await page.keyboard.type('and @launch');
    await expect(rows(page).first().locator('.tx-file-name')).toHaveText('🚀 launch.md');
    await page.keyboard.press('Enter');
    await expect(chips(page)).toHaveCount(3);
    await expect(chips(page).nth(1)).toHaveAttribute('aria-label', 'Folder docs');
    await shot(page, `h141-${c.harness}-chips`);

    // Backspace takes a chip whole (after the space the pick put in), undo brings it back.
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await expect(chips(page)).toHaveCount(2);
    await page.keyboard.press('Control+z');
    await expect(chips(page)).toHaveCount(3);

    await page.keyboard.type('please');
    await page.keyboard.press('Enter');
    await expect.poll(() => prompts(page)).toEqual(['look at @game/src/ui/composer.ts in @docs and @"docs/🚀 launch.md" please']);
    // Sent: the box is empty.
    await expect(chips(page)).toHaveCount(0);
    clean();
  });
}

test('a draft with a file chip survives a reload and a desk switch; copy and paste keeps the chip', async ({ page }) => {
  const clean = watchErrors(page);
  const pebble = demoWorker('Pebble');
  const dumpling = demoWorker('Dumpling');
  await openGame(page, 'demo-m5', '', SIM);
  await sitAtTranscript(page, pebble);
  await input(page).click();
  await page.keyboard.type('check @comp');
  await expect(rows(page).first().locator('.tx-file-name')).toHaveText('composer.ts');
  await page.keyboard.press('Enter');
  await page.keyboard.type('later');
  await expect(chips(page)).toHaveCount(1);

  // Copy everything, paste it after itself: two chips, one undo takes the paste back.
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+c');
  await page.keyboard.press('End');
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' ');
  await page.keyboard.press('Control+v');
  await expect(chips(page)).toHaveCount(2);
  await page.keyboard.press('Control+z');
  await expect(chips(page)).toHaveCount(1);

  // Another desk and back: the draft is Pebble's, Dumpling's box is empty.
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
  await sitAtTranscript(page, dumpling);
  await expect(chips(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
  await sitAtTranscript(page, pebble);
  await expect(chips(page)).toHaveCount(1);

  // A reload: the text and the chip come back from storage.
  await page.reload();
  await page.waitForFunction(() => window.__h3d?.ready && window.__h3d.frames >= 3, undefined, { timeout: 60_000 });
  await sitAtTranscript(page, pebble);
  await expect(chips(page)).toHaveCount(1);
  await expect(chips(page).first()).toHaveAttribute('aria-label', 'File game/src/ui/composer.ts');
  await expect(input(page)).toContainText('check');
  await expect(input(page)).toContainText('later');
  await input(page).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  // The space typed before the paste stays (the undo took only the paste).
  await expect.poll(() => prompts(page)).toEqual(['check @game/src/ui/composer.ts later ']);
  await expect(chips(page)).toHaveCount(0);

  // Sent: a reload brings nothing back.
  await page.reload();
  await page.waitForFunction(() => window.__h3d?.ready && window.__h3d.frames >= 3, undefined, { timeout: 60_000 });
  await sitAtTranscript(page, pebble);
  expect(await input(page).evaluate((e) => (e.textContent ?? '').replace(/\u200B/g, ''))).toBe('');
  await expect(chips(page)).toHaveCount(0);
  clean();
});
