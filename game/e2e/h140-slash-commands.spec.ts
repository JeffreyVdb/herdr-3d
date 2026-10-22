import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Worker } from '../src/net/protocol';
import { frames, hideQuestions, openGame, RESULTS, seatMode, watchErrors } from './game';

// #140: `/` in the transcript's prompt box lists the worker's commands and skills, for real, against the simulating
// fixture server (tools/fixture-panels.ts `simCommands`: a Claude list and a Codex one). You sit at Pebble (an idle
// Claude) and Dumpling (a done Codex), type a sentence with a `/` in it and pick from the popup; Esc closes only the
// popup (you stay seated); Enter with the popup closed sends the prompt as typed (the bridge rewrites a Codex skill).

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

async function sitAtTranscript(page: Page, w: Worker): Promise<void> {
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.face(id), w.id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.sitAt(id), w.id)).toBe(true);
  await frames(page, 20);
  await seatMode(page, 'transcript');
  await hideQuestions(page, w.id); // #187: a waiting worker's question opened the questions' sheet
  await expect(page.locator('.seat-transcript .tx .tx-scroll')).toBeFocused();
}

const tx = (page: Page) => page.locator('.seat-transcript .tx');
const pop = (page: Page) => tx(page).locator('.cmp-pop');
const names = (page: Page) => tx(page).locator('[role="option"] .tx-cmd-name');
const input = (page: Page) => tx(page).locator('.tx-input');

for (const c of [
  {
    harness: 'claude',
    worker: 'Pebble',
    all: ['/compact', '/review', '/usage', '/model', '/caveman:caveman-commit', '/handoff', '/deploy', '/release:notes'],
    query: 'cav',
    picked: '/caveman:caveman-commit',
    // #39: with nothing else to say, the footer says files are @'s.
    note: 'Skills and commands · type @ for files',
  },
  {
    harness: 'codex',
    worker: 'Dumpling',
    all: ['/humanizer:humanizer', '/imagegen', '/init', '/compact', '/review', '/mcp', '/status'],
    query: 'hum',
    picked: '/humanizer:humanizer',
    note: 'Codex: skills are sent as $name',
  },
] as const) {
  test(`${c.harness}: / lists the worker's commands and skills, filters, picks mid-sentence; Esc closes only it; Enter sends when closed`, async ({ page }) => {
    const clean = watchErrors(page);
    const w = demoWorker(c.worker);
    await openGame(page, 'demo-m5', '', SIM);
    await sitAtTranscript(page, w);
    // Asked as the transcript opened.
    await expect.poll(async () => (await sent(page, 'worker.commands')).map((x) => x.args)).toContainEqual({ id: w.id });

    await input(page).click();
    await page.keyboard.type('/');
    await expect(pop(page)).toBeVisible();
    await expect(tx(page).getByRole('listbox')).toHaveAttribute('aria-label', 'Commands and skills');
    await expect(names(page)).toHaveText([...c.all]);
    // The kind, the argument hint and the description are drawn on the row's one line.
    const review = tx(page).locator('[role="option"]', { has: page.locator('.tx-cmd-name', { hasText: /^\/review$/ }) });
    await expect(review.locator('.tx-cmd-kind')).toHaveText('command');
    await expect(review.locator('.tx-cmd-desc')).not.toBeEmpty();
    const oneLine = await tx(page)
      .locator('[role="option"]')
      .evaluateAll((rows) => rows.every((r) => Math.abs(r.getBoundingClientRect().height - (rows[0] as HTMLElement).getBoundingClientRect().height) < 1));
    expect(oneLine).toBe(true);
    // The name is never the part that gets cut (the description is, then the hint).
    expect(await names(page).evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent))).toEqual([]);
    if (c.note) await expect(tx(page).locator('.cmp-pop-note')).toHaveText(c.note);
    else await expect(tx(page).locator('.cmp-pop-note')).toBeHidden();
    await shot(page, `h140-${c.harness}-open`);

    // Esc: the popup closes, you stay seated in the transcript.
    await expect(pop(page)).toBeVisible();
    await expect(input(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(pop(page)).toBeHidden();
    expect(await page.evaluate(() => window.__h3d.seated())).toBe(w.id);
    expect(await page.evaluate(() => window.__h3d.seat().mode)).toBe('transcript');
    await expect(input(page)).toBeFocused();

    // Mid-sentence: the query filters, the matched letters are marked, Enter picks.
    await page.keyboard.press('Backspace');
    await page.keyboard.type(`please use /${c.query}`);
    await expect(names(page).first()).toHaveText(c.picked);
    await expect(tx(page).locator('[role="option"]').first().locator('.tx-cmd-hit')).toHaveText(c.query);
    await shot(page, `h140-${c.harness}-filtered`);
    await page.keyboard.press('Enter');
    await expect(pop(page)).toBeHidden();
    await expect(input(page)).toHaveText(`please use ${c.picked} `);
    expect(await sent(page, 'worker.prompt')).toHaveLength(0);

    // Closed: Enter sends what was typed.
    await page.keyboard.type('on the README');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await sent(page, 'worker.prompt')).map((x) => (x.args as { text: string }).text)).toEqual([`please use ${c.picked} on the README`]);
    clean();
  });
}

test('a worker waiting on a question: the box is disabled and / opens nothing', async ({ page }) => {
  const clean = watchErrors(page);
  const w = demoWorker('Tofu'); // a blocked Claude
  await openGame(page, 'demo-m5', '', SIM);
  await sitAtTranscript(page, w);
  await expect(input(page)).toHaveAttribute('aria-disabled', 'true');
  await input(page).click({ force: true });
  await page.keyboard.type('/');
  await frames(page, 3);
  await expect(pop(page)).toHaveCount(0);
  clean();
});

test('#140: a terminal-only built-in has a badge; sending it shows the terminal, /model with a model does not', async ({ page }) => {
  const clean = watchErrors(page);
  const w = demoWorker('Pebble');
  await openGame(page, 'demo-m5', '', SIM);
  await sitAtTranscript(page, w);
  await input(page).click();

  await page.keyboard.type('/us');
  const usage = tx(page).locator('[role="option"]').first();
  await expect(usage.locator('.tx-cmd-name')).toHaveText('/usage');
  await expect(usage.locator('.tx-cmd-term')).toHaveText('terminal');
  await expect(usage.locator('.tx-cmd-term')).toHaveAttribute('title', 'Shows in the worker’s terminal, not in the conversation');
  await shot(page, 'h140-terminal-badge');

  // With arguments, /model runs inline: it stays in the conversation.
  await page.keyboard.press('Escape');
  for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace');
  // (The space after /model ends its token: the popup is closed, so Enter sends.)
  await page.keyboard.type('/model opus');
  await expect(pop(page)).toBeHidden();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await sent(page, 'worker.prompt')).map((x) => (x.args as { text: string }).text)).toEqual(['/model opus']);
  await expect(input(page)).toHaveAttribute('contenteditable', 'true', { timeout: 20_000 });
  await expect(input(page)).toHaveText('');
  expect(await page.evaluate(() => window.__h3d.seat().mode)).toBe('transcript');

  // Picked from the popup and sent (Pebble works on the last prompt meanwhile): the bridge says it shows only in the
  // terminal, so the terminal is shown.
  await input(page).click();
  await page.keyboard.type('/usa');
  await expect(usage.locator('.tx-cmd-name')).toHaveText('/usage');
  await page.keyboard.press('Enter');
  await expect(input(page)).toHaveText('/usage ');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__h3d.seat().mode)).toBe('terminal');
  expect((await sent(page, 'worker.prompt')).map((x) => (x.args as { text: string }).text)).toEqual(['/model opus', '/usage ']);
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(w.id);
  clean();
});
