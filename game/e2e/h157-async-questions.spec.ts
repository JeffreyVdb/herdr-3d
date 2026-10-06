import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Ask, Worker } from '../src/net/protocol';
import { frames, openGame, seatMode, shot, watchErrors } from './game';

// #157: a shared Codex worker's async questions against the fixture bridge (demo-m5, sim=1, `simcodex=ask`: Pixel's
// running turn asked "Which fixture color?" (Green / Blue) and "Any context for the fixture?" (free text); herdr says
// blocked, the bridge async_blocked). Pixel works on: no "needs you", a cue that it asks, prompts still go. At its
// laptop the transcript pins a card: picks and typing send nothing, Send sends once, and the reply's state follows the
// bridge (sent, answered, refused, not delivered, answered in the terminal), the answer kept through all of it, the
// terminal toggle and a reconnect.

const SIM = 'play=none&sim=1&simms=300&simusage=0&simcodex=ask';
const THREAD = '01a1112a-85b8-7bf2-9d6e-sim000000001';

function pixel(): Worker {
  const snap = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/demo-m5.jsonl'), 'utf8').split('\n')[0] ?? '{}') as { world: { workers: Worker[] } };
  const w = snap.world.workers.find((x) => x.name === 'Pixel');
  if (!w) throw new Error('no Pixel in demo-m5');
  return w;
}

const sent = (page: Page, t: string) => page.evaluate((x) => window.__h3d.sent().filter((c) => c.t === x), t);
const simCodex = (page: Page, t: 'sim.codex' | 'sim.codex_answer' | 'sim.codex_turn_end', args: Record<string, unknown>) => page.evaluate(([tt, a]) => window.__h3d.simCodex(tt, a), [t, args] as const);

async function sitAtTranscript(page: Page, w: Worker): Promise<Locator> {
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.face(id), w.id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.sitAt(id), w.id)).toBe(true);
  await frames(page, 20);
  await seatMode(page, 'transcript');
  const tx = page.locator('.seat-transcript .tx');
  await expect(tx.locator('.tx-scroll')).toBeFocused();
  return tx;
}

test('answered from the transcript while Codex works on: picks never send, Send sends once; prompts and the terminal stay', async ({ page }) => {
  const clean = watchErrors(page);
  const w = pixel();
  await openGame(page, 'demo-m5', '', SIM);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.face(id), w.id)).toBe(true);
  // herdr says blocked; the game says working, with what it asks, and Pixel is not in N's queue.
  expect(await page.evaluate((id) => window.__h3d.worker(id)?.status, w.id)).toBe('blocked');
  await expect.poll(() => page.evaluate((id) => window.__h3d.status(id)?.status, w.id)).toBe('working'); // as drawn
  await expect
    .poll(() => page.evaluate(() => window.__h3d.cards().find((c) => c.name === 'Pixel') ?? null))
    .toMatchObject({ display: 'working', ask: { text: 'Which fixture color?', about: ['Codex asks 2 questions · answer at the laptop (E)'] } });
  expect(await page.evaluate((id) => window.__h3d.needs().some((n) => n.id === id), w.id)).toBe(false);

  const tx = await sitAtTranscript(page, w);
  const card = tx.getByRole('region', { name: 'Codex’s questions' });
  await expect(card).toBeVisible();
  await expect(card.locator('.tx-aq-tag')).toHaveText('Codex asked');
  await expect(card.locator('.tx-aq-work')).toHaveText('still working');
  await expect(tx.locator('.tx-input')).toBeEnabled();
  await shot(page, 'h157-async-card');
  await tx.locator('.tx-scroll').focus();

  // No click: 1 picks Green and the card moves on to the open question (its text box has the keyboard). Nothing sent.
  await page.keyboard.press('1');
  await expect(card.locator('.tx-ask-row[data-index="0"] .tx-ask-row-text')).toHaveText('Green');
  await expect(card.locator('textarea.tx-aq-text')).toBeFocused();
  await page.keyboard.type('Use the staging bucket.');
  await page.keyboard.press('Enter'); // takes the text, moves on: never sends
  await expect(card.locator('.tx-ask-send')).toHaveText(/^Send answers/);
  expect(await sent(page, 'worker.answer_async')).toHaveLength(0);

  // The prompt box works meanwhile: the bridge queues the prompt through Codex's app-server.
  await page.keyboard.press('Escape');
  await expect(tx.locator('.tx-scroll')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(tx.locator('.tx-input')).toBeFocused();
  await page.keyboard.type('Also check the docs.');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await sent(page, 'worker.prompt')).map((c) => c.args)).toEqual([{ id: w.id, text: 'Also check the docs.' }]);
  await expect(tx.locator('.tx-input')).toHaveText('');
  expect(await sent(page, 'worker.answer_async')).toHaveLength(0);

  // To the terminal and back: the card and what was picked and typed are still there.
  await seatMode(page, 'terminal');
  await seatMode(page, 'transcript');
  await expect(card).toBeVisible();
  await expect(card.locator('textarea.tx-aq-text')).toHaveValue('Use the staging bucket.');
  await expect(card.locator('.tx-ask-row[data-index="0"] .tx-ask-row-text')).toHaveText('Green');

  // Ctrl+Enter twice from the timeline: one send, both answers.
  await tx.locator('.tx-scroll').focus();
  await page.keyboard.press('Control+Enter');
  await page.keyboard.press('Control+Enter');
  await expect.poll(async () => (await sent(page, 'worker.answer_async')).length).toBe(1);
  expect((await sent(page, 'worker.answer_async'))[0]?.args).toEqual({
    id: w.id,
    thread: THREAD,
    batch: 'call_3',
    answers: [
      { index: 0, answer: 'Green' },
      { index: 1, answer: 'Use the staging bucket.' },
    ],
  });
  await expect(card.locator('.tx-ask-q .tx-aq-state')).toHaveText('Sent — Codex will read it with its next step');
  await tx.getByRole('radio', { name: 'Paper', exact: true }).click(); // a light preset: the card keeps its blue
  await shot(page, 'h157-async-sent-paper');
  // Then Codex reads it: answered, said politely; the worker no longer asks.
  await expect(card.locator('.tx-ask-q .tx-aq-state')).toHaveText('Answered');
  await expect(tx.locator('.tx-aq-live')).toHaveText('Question answered.');
  await expect(card.locator('.tx-ask-row[data-index="0"]')).toHaveAttribute('data-phase', 'answered');
  expect(await sent(page, 'worker.answer_async')).toHaveLength(1);
  await card.getByRole('button', { name: 'Clear' }).click();
  await expect(card).toBeHidden();
  await expect(tx.locator('.tx-scroll')).toBeFocused();

  // A real block (an approval waits on the terminal) needs you, as before.
  await simCodex(page, 'sim.codex', { id: w.id, ask: { batch: 'call_8', questions: [{ title: 'Deploy now?' }] }, approval: true });
  await expect.poll(() => page.evaluate((id) => window.__h3d.needs().some((n) => n.id === id), w.id)).toBe(true);
  await simCodex(page, 'sim.codex', { id: w.id, approval: false });
  await expect.poll(() => page.evaluate((id) => window.__h3d.needs().some((n) => n.id === id), w.id)).toBe(false);
  clean();
});

test('a refused answer keeps what you wrote; the terminal’s answer shows; a reconnect keeps the draft and one card', async ({ page }) => {
  const clean = watchErrors(page);
  const w = pixel();
  await openGame(page, 'demo-m5', '', SIM);
  const tx = await sitAtTranscript(page, w);
  const card = tx.locator('.tx-aq');
  await expect(card).toBeVisible();
  expect((await simCodex(page, 'sim.codex', { id: w.id, fail: 'input_failed' })).ok).toBe(true);

  // → to the open question, typed, sent with Ctrl+Enter from its text box: refused, the text kept, the reason said.
  await page.keyboard.press('ArrowRight');
  const text = card.locator('textarea.tx-aq-text');
  await expect(text).toBeFocused();
  await page.keyboard.type('first try');
  await page.keyboard.press('Control+Enter');
  await expect(card.locator('.tx-ask-note.is-error')).toHaveText(/^Not sent: Codex refused it \(turn\/steer refused the answer/);
  await expect(card.locator('.tx-ask-q .tx-aq-state')).toHaveText(/^Not sent: turn\/steer refused the answer.*Your answer is kept/);
  await expect(text).toHaveValue('first try');
  await expect(text).toBeEnabled();

  // Answered in the terminal meanwhile: the card says so.
  await simCodex(page, 'sim.codex_answer', { id: w.id, batch: 'call_3', index: 0, answer: 'Blue' });
  await expect(card.locator('.tx-ask-row[data-index="0"] .tx-ask-row-text')).toHaveText('Blue');
  await expect(card.locator('.tx-ask-row[data-index="0"] .tx-ask-row-act')).toHaveText('answered elsewhere');
  await expect(tx.locator('.tx-aq-live')).toHaveText('Question answered elsewhere.');

  await text.fill('draft before the reconnect');
  const before = (await sent(page, 'worker.answer_async')).length;
  await page.evaluate(() => window.__h3d.reconnect());
  await expect.poll(() => page.evaluate(async () => (await window.__h3d.watches()).sim ?? 0)).toBeGreaterThan(0);
  // The snapshot brings the batch back (this simulated bridge starts afresh): one card, the draft in it.
  await expect(card).toBeVisible();
  await expect(tx.locator('.tx-aq')).toHaveCount(1);
  await expect(card.locator('.tx-aq-batch')).toHaveCount(1);
  await expect(card.locator('.tx-aq-fold')).toHaveCount(0);
  if ((await card.locator('.tx-ask-q').getAttribute('data-index')) !== '1') await card.locator('.tx-ask-row[data-index="1"]').click();
  await expect(card.locator('textarea.tx-aq-text')).toHaveValue('draft before the reconnect');
  await shot(page, 'h157-async-after-reconnect');
  expect((await sent(page, 'worker.answer_async')).length).toBe(before); // nothing sent by itself

  // Sent now: answered, once.
  await card.locator('textarea.tx-aq-text').press('Control+Enter');
  await expect(card.locator('.tx-ask-q .tx-aq-state')).toHaveText('Answered');
  const after = (await sent(page, 'worker.answer_async')).slice(before);
  expect(after.map((c) => c.args)).toEqual([{ id: w.id, thread: THREAD, batch: 'call_3', answers: [{ index: 1, answer: 'draft before the reconnect' }] }]);
  clean();
});

test('an answer the turn ended before reading is kept to send again; on a phone the card fits beside the prompt box', async ({ page }) => {
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const w = pixel();
  await openGame(page, 'demo-m5', '', SIM);
  const tx = await sitAtTranscript(page, w);
  const card = tx.locator('.tx-aq');
  await expect(card).toBeVisible();
  const inside = async (sel: string) => {
    const [c, b] = await Promise.all([card.boundingBox(), card.locator(sel).first().boundingBox()]);
    expect(c && b, sel).toBeTruthy();
    if (!c || !b) return;
    expect(b.y, `${sel} top`).toBeGreaterThanOrEqual(c.y - 0.5);
    expect(b.y + b.height, `${sel} bottom`).toBeLessThanOrEqual(c.y + c.height + 0.5);
  };
  await inside('.tx-ask-foot');
  await inside('.tx-ask-send');
  await inside('.tx-aq-hide');
  const [c, p] = await Promise.all([card.boundingBox(), tx.locator('.tx-input').boundingBox()]);
  expect(c && p && p.y >= c.y + c.height - 1, 'the prompt box below the card').toBe(true);
  await expect(tx.locator('.tx-input')).toBeEnabled();
  await shot(page, 'h157-async-phone');

  // Taps: Blue, then the text; Send.
  await simCodex(page, 'sim.codex', { id: w.id, fail: 'undelivered' });
  await card.getByRole('radio', { name: 'Blue' }).click();
  await card.locator('textarea.tx-aq-text').fill('Context: the staging run.');
  await card.locator('.tx-ask-send').click();
  // Accepted, then the turn ended before Codex read it: not delivered, the answer still there, and Send is back.
  await expect(card.locator('.tx-ask-q .tx-aq-state')).toHaveText(/^Not delivered — the turn ended before Codex read it/);
  await shot(page, 'h157-async-phone-undelivered');
  await expect(card.locator('textarea.tx-aq-text')).toHaveValue('Context: the staging run.');
  await expect(card.locator('.tx-ask-row[data-index="0"] .tx-ask-row-act')).toHaveText('not delivered');
  await expect(card.locator('.tx-aq-work')).toHaveCount(0); // no turn runs now
  await card.locator('.tx-ask-send').click();
  await expect(card.locator('.tx-ask-q .tx-aq-state')).toHaveText('Answered');
  const sends = await sent(page, 'worker.answer_async');
  expect(sends).toHaveLength(2);
  expect(sends[1]?.args).toEqual(sends[0]?.args);
  clean();
});

test('a blocking ask still wins: the async card waits behind it, and its digits are the ask’s', async ({ page }) => {
  const clean = watchErrors(page);
  const w = pixel();
  await openGame(page, 'demo-m5', '', SIM);
  const tx = await sitAtTranscript(page, w);
  await expect(tx.locator('.tx-aq')).toBeVisible();
  const ask: Partial<Ask> = {
    tool_use_id: 'call_block_1',
    agent: 'codex',
    questions: [{ header: 'Mode', question: 'Run the migration now?', multi: false, other: false, options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }],
  };
  await page.evaluate(([id, a]) => window.__h3d.simAsk({ id, ask: a }), [w.id, ask] as const);
  await expect(tx.locator('.tx-ask')).toBeVisible();
  await expect(tx.locator('.tx-aq')).toBeHidden();
  await expect(tx.locator('.tx-input')).toBeDisabled();
  await tx.locator('.tx-scroll').focus();
  await page.keyboard.press('1');
  await expect(tx.locator('.tx-ask [role="radio"][aria-checked="true"]')).toContainText('Yes');
  expect(await sent(page, 'worker.answer_async')).toHaveLength(0);
  // Ended in the terminal: the async card is back, untouched.
  await page.evaluate((id) => window.__h3d.simAsk({ id, ask: null }), w.id);
  await expect(tx.locator('.tx-aq')).toBeVisible();
  await expect(tx.locator('.tx-aq [role="radio"][aria-checked="true"]')).toHaveCount(0);
  clean();
});
