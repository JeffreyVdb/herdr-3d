import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Ask, Worker } from '../src/net/protocol';
import { frames, openGame, seatMode, sheetSettled, shot, watchErrors } from './game';

// #157: a shared Codex worker's async questions against the fixture bridge (demo-m5, sim=1, `simcodex=ask`: Pixel's
// running turn asked "Which fixture color?" (Green / Blue) and "Any context for the fixture?" (free text); herdr says
// blocked, the bridge async_blocked). Pixel works on: no "needs you", a cue that it asks, prompts still go. At its
// laptop the questions button glows calm (#187: Codex's questions never open the questions' sheet by themselves); in
// the sheet picks and typing send nothing, Send sends once, and the reply's state follows the bridge (sent, answered,
// refused, not delivered, answered in the terminal), the answer kept through all of it, closing the sheet, the terminal
// toggle and a reconnect.

const SIM = 'play=none&sim=1&simms=300&simusage=0&simcodex=ask';
const THREAD = '01a1112a-85b8-7bf2-9d6e-sim000000001';

function pixel(): Worker {
  const snap = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/demo-m5.jsonl'), 'utf8').split('\n')[0] ?? '{}') as { world: { workers: Worker[] } };
  const w = snap.world.workers.find((x) => x.name === 'Pixel');
  if (!w) throw new Error('no Pixel in demo-m5');
  return w;
}

const sent = (page: Page, t: string) => page.evaluate((x) => window.__h3d.sent().filter((c) => c.t === x), t);
/** #187: the questions' sheet (on the page, outside the laptop's screen), its async card, and the calm button. */
const sheetOf = (page: Page): Locator => page.locator('dialog.tx-qsheet');
const asyncCard = (page: Page): Locator => sheetOf(page).getByRole('region', { name: 'Codex’s questions' });
const calmButton = (page: Page): Locator => page.locator('.seat-transcript .tx-prompt').getByRole('button', { name: /^(Codex asked|Questions)/ });

/** #187 AC1: the timeline's bottom edge meets the prompt box: no question sits between them. */
async function fullHeight(tx: Locator): Promise<void> {
  const [m, f] = await Promise.all([tx.locator('.tx-main').boundingBox(), tx.locator('.tx-prompt').boundingBox()]);
  expect(m && f, 'the timeline and the prompt box').toBeTruthy();
  if (m && f) expect(Math.abs(m.y + m.height - f.y), 'the timeline meets the prompt box').toBeLessThanOrEqual(1);
  expect(await tx.locator('.tx-ask, .tx-fu, .tx-aq, .tx-bq').count()).toBe(0);
}

/**
 * What is wrong with `l` as drawn in the sheet: outside the viewport or the sheet's scrolling body, under 8 px, or
 * something else over its middle. None when it is in plain sight.
 */
async function inSight(page: Page, l: Locator): Promise<string[]> {
  const body = await sheetOf(page).locator('.sheet-body').elementHandle();
  return l.evaluate((el, b) => {
    const bad: string[] = [];
    if (!b) return ['no sheet'];
    const r = el.getBoundingClientRect();
    const box = b.getBoundingClientRect();
    const top = Math.max(box.top, 0);
    const bottom = Math.min(box.bottom, window.innerHeight);
    if (r.height < 8) bad.push(`${r.height}px high`);
    if (r.top < top - 0.5) bad.push(`top ${r.top.toFixed(1)} over ${top.toFixed(1)}`);
    if (r.bottom > bottom + 0.5) bad.push(`bottom ${r.bottom.toFixed(1)} under ${bottom.toFixed(1)}`);
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 12));
    if (!hit || !el.contains(hit)) bad.push(`covered by .${String(hit?.className ?? 'nothing')}`);
    return bad;
  }, body);
}

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

test('answered from the transcript while Codex works on: picks never send, Send sends once; prompts and the terminal stay', { tag: '@smoke' }, async ({ page }) => {
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
  const sheet = sheetOf(page);
  const card = asyncCard(page);
  // #187: the calm button, not the sheet; the prompt box on, the conversation its whole height.
  await expect(calmButton(page)).toBeVisible();
  await expect(calmButton(page)).toHaveAccessibleName('Codex asked 2 questions');
  await expect(calmButton(page)).toHaveAttribute('data-lane', 'optional');
  await expect(sheet).toBeHidden();
  await expect(tx.locator('.tx-input')).toBeEnabled();
  await fullHeight(tx);
  await shot(page, 'h157-async-button');
  // Q opens it, the keyboard on the open question's first option.
  await tx.locator('.tx-scroll').focus();
  await page.keyboard.press('q');
  await expect(sheet).toHaveAttribute('open', '');
  await expect(sheet).toHaveAccessibleName('Codex asked');
  await expect(card).toBeVisible();
  await expect(card.locator('.tx-aq-tag')).toHaveText('Codex asked');
  await expect(card.locator('.tx-aq-work')).toHaveText('still working');
  await shot(page, 'h157-async-card');
  await card.getByRole('radio', { name: 'Green' }).focus(); // the bare screenshot may drop the focus

  // No click: 1 picks Green and the card moves on to the open question (its text box has the keyboard). Nothing sent.
  await page.keyboard.press('1');
  await expect(card.locator('.tx-ask-row[data-index="0"] .tx-ask-row-text')).toHaveText('Green');
  await expect(card.locator('textarea.tx-aq-text')).toBeFocused();
  await page.keyboard.type('Use the staging bucket.');
  await page.keyboard.press('Enter'); // takes the text, moves on: never sends
  await expect(card.locator('.tx-ask-send')).toHaveText(/^Send answers/);
  expect(await sent(page, 'worker.answer_async')).toHaveLength(0);

  // The prompt box works meanwhile (Esc closes the sheet): the bridge queues the prompt through Codex's app-server.
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(tx.locator('.tx-scroll')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(tx.locator('.tx-input')).toBeFocused();
  await page.keyboard.type('Also check the docs.');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await sent(page, 'worker.prompt')).map((c) => c.args)).toEqual([{ id: w.id, text: 'Also check the docs.' }]);
  await expect(tx.locator('.tx-input')).toHaveText('');
  expect(await sent(page, 'worker.answer_async')).toHaveLength(0);

  // To the terminal and back: what was picked and typed is still there.
  await seatMode(page, 'terminal');
  await seatMode(page, 'transcript');
  await expect(sheet).toBeHidden(); // never by itself
  await calmButton(page).click();
  await expect(card).toBeVisible();
  await expect(card.locator('textarea.tx-aq-text')).toHaveValue('Use the staging bucket.');
  await expect(card.locator('.tx-ask-row[data-index="0"] .tx-ask-row-text')).toHaveText('Green');

  // Ctrl+Enter twice in the sheet: one send, both answers.
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
  // The Ubuntu orange (the transcript's preset, behind the sheet): the card keeps its accent, not the waiting sun.
  await page.keyboard.press('Escape');
  await tx.getByRole('radio', { name: 'Ubuntu', exact: true }).click();
  await calmButton(page).click();
  await shot(page, 'h157-async-sent-ubuntu');
  // Then Codex reads it: answered, said politely; the worker no longer asks.
  await expect(card.locator('.tx-ask-q .tx-aq-state')).toHaveText('Answered');
  await expect(tx.locator('.tx-aq-live')).toHaveText('Question answered.');
  await expect(card.locator('.tx-ask-row[data-index="0"]')).toHaveAttribute('data-phase', 'answered');
  expect(await sent(page, 'worker.answer_async')).toHaveLength(1);
  await card.getByRole('button', { name: 'Clear' }).click();
  await expect(card).toBeHidden();
  await expect(sheet).toBeHidden(); // nothing left in it
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
  const card = asyncCard(page);
  await calmButton(page).click();
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
  await expect.poll(() => page.evaluate(async () => (await window.__h3d.watches()).sim ?? 0), {
    message: 'the reconnected bridge has replayed the terminal watch', timeout: 20_000,
  }).toBeGreaterThan(0);
  // The snapshot brings the batch back (this simulated bridge starts afresh): one card, the draft in it.
  if (!(await sheetOf(page).isVisible())) await calmButton(page).click();
  await expect(card).toBeVisible();
  await expect(page.locator('.tx-aq')).toHaveCount(1);
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

test('an answer the turn ended before reading is kept to send again; on a phone the questions are a bottom sheet', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const clean = watchErrors(page);
  const w = pixel();
  await openGame(page, 'demo-m5', '', SIM);
  const tx = await sitAtTranscript(page, w);
  const sheet = sheetOf(page);
  const card = asyncCard(page);
  // The pill above the composer, a 44 px target; the conversation its whole height.
  const pill = await calmButton(page).boundingBox();
  expect(pill && pill.height, 'a 44px target').toBeGreaterThanOrEqual(43.5);
  await fullHeight(tx);
  await shot(page, 'h157-async-phone-button');
  await calmButton(page).tap();
  await expect(card).toBeVisible();
  await sheetSettled(page);
  const box = await sheet.boundingBox();
  expect(box && box.width >= 389 && Math.abs(box.y + box.height - 844) <= 1, 'a bottom sheet: the whole width, on the bottom edge').toBe(true);
  for (const l of [card.locator('.tx-ask-question').first(), card.locator('.tx-ask-send'), card.locator('.tx-aq-hide').first()]) {
    await l.scrollIntoViewIfNeeded();
    expect(await inSight(page, l)).toEqual([]);
  }
  await shot(page, 'h157-async-phone');

  // Taps: Blue, then the text; Send.
  await simCodex(page, 'sim.codex', { id: w.id, fail: 'undelivered' });
  await card.getByRole('radio', { name: 'Blue' }).tap();
  await card.locator('textarea.tx-aq-text').fill('Context: the staging run.');
  await card.locator('.tx-ask-send').tap();
  // Accepted, then the turn ended before Codex read it: not delivered, the answer still there, and Send is back.
  await expect(card.locator('.tx-ask-q .tx-aq-state')).toHaveText(/^Not delivered — the turn ended before Codex read it/);
  await shot(page, 'h157-async-phone-undelivered');
  await expect(card.locator('textarea.tx-aq-text')).toHaveValue('Context: the staging run.');
  await expect(card.locator('.tx-ask-row[data-index="0"] .tx-ask-row-act')).toHaveText('not delivered');
  await expect(card.locator('.tx-aq-work')).toHaveCount(0); // no turn runs now
  await card.locator('.tx-ask-send').tap();
  await expect(card.locator('.tx-ask-q .tx-aq-state')).toHaveText('Answered');
  const sends = await sent(page, 'worker.answer_async');
  expect(sends).toHaveLength(2);
  expect(sends[1]?.args).toEqual(sends[0]?.args);
  clean();
  await ctx.close();
});

test('a blocking ask opens the sheet: urgent lane first, the async card under it, the keys the card’s you are on', async ({ page }) => {
  const clean = watchErrors(page);
  const w = pixel();
  await openGame(page, 'demo-m5', '', SIM);
  const tx = await sitAtTranscript(page, w);
  const sheet = sheetOf(page);
  await expect(calmButton(page)).toBeVisible();
  const ask: Partial<Ask> = {
    tool_use_id: 'call_block_1',
    agent: 'codex',
    questions: [{ header: 'Mode', question: 'Run the migration now?', multi: false, other: false, options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }],
  };
  await page.evaluate(([id, a]) => window.__h3d.simAsk({ id, ask: a }), [w.id, ask] as const);
  await expect(sheet).toHaveAttribute('open', '');
  await expect(sheet).toHaveAccessibleName('Answer to continue, and Codex asked');
  await expect(sheet.locator('.tx-qlane:not([hidden]) .tx-qlane-head')).toHaveText(['Answer to continue', 'Codex asked']);
  await expect(sheet.locator('.tx-ask')).toBeVisible();
  await expect(asyncCard(page)).toBeVisible();
  await expect(tx.locator('.tx-input')).toBeDisabled();
  await expect(page.locator('.seat-transcript .tx-prompt').getByRole('button', { name: /^Answer to continue/ })).toHaveAttribute('data-lane', 'urgent');
  await shot(page, 'h157-ask-and-async');
  // The keyboard is on the ask's card: its digit picks there, nothing goes to the async questions.
  await page.keyboard.press('1');
  await expect(sheet.locator('.tx-ask [role="radio"][aria-checked="true"]')).toContainText('Yes');
  expect(await sent(page, 'worker.answer_async')).toHaveLength(0);
  await expect(asyncCard(page).locator('[role="radio"][aria-checked="true"]')).toHaveCount(0);
  // Ended in the terminal: the sheet goes with it, the async questions back on the calm button, untouched.
  await page.evaluate((id) => window.__h3d.simAsk({ id, ask: null }), w.id);
  await expect(sheet).toBeHidden();
  await expect(calmButton(page)).toBeVisible();
  await expect(tx.locator('.tx-input')).toBeEnabled();
  await calmButton(page).click();
  await expect(asyncCard(page).locator('[role="radio"][aria-checked="true"]')).toHaveCount(0);
  clean();
});

// The review's phone (390×844): where the keyboard lands (→ to a question, or the card moving on after a pick) is in
// plain sight in the bottom sheet.
test('on a phone the keyboard lands in plain sight: → to a question, and the next one after a pick', async ({ page }) => {
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const w = pixel();
  await openGame(page, 'demo-m5', '', SIM);
  const tx = await sitAtTranscript(page, w);
  const card = asyncCard(page);
  await tx.locator('.tx-scroll').focus();
  await page.keyboard.press('q');
  await expect(card).toBeVisible();
  const text = card.locator('textarea.tx-aq-text');

  await page.keyboard.press('ArrowRight');
  await expect(text).toBeFocused();
  expect(await inSight(page, text), 'question 2’s text box after →').toEqual([]);

  // Back on question 1 (its first option has the keyboard), 1 picks Green and the card moves on to question 2.
  await card.locator('.tx-ask-q').focus();
  await page.keyboard.press('ArrowLeft');
  const green = card.getByRole('radio', { name: 'Green' });
  await expect(green).toBeFocused();
  expect(await inSight(page, green), 'question 1’s option after ←').toEqual([]);
  await page.keyboard.press('1');
  await expect(text).toBeFocused();
  expect(await inSight(page, text), 'question 2’s text box after a pick').toEqual([]);
  await page.keyboard.type('Typed where it can be seen.');
  expect(await inSight(page, text)).toEqual([]);
  await card.locator('.tx-ask-send').scrollIntoViewIfNeeded();
  expect(await inSight(page, card.locator('.tx-ask-send'))).toEqual([]);
  expect(await sent(page, 'worker.answer_async')).toHaveLength(0);
  await shot(page, 'h157-async-phone-keyboard');
  clean();
});

/** Codex's turn ended (its async questions stay, docs/protocol.md) and the bridge found open questions in its last message. */
async function idleWithFollowup(page: Page, w: Worker): Promise<void> {
  await page.evaluate((id) => {
    const x = window.__h3d.worker(id);
    if (!x?.codex) throw new Error('no Codex launch on Pixel');
    window.__h3d.inject({
      t: 'worker.upsert',
      seq: 0,
      worker: {
        ...x,
        status: 'idle',
        codex: { ...x.codex, turn: '', async_blocked: false },
        followup: {
          turn_id: 'h157-followup',
          source: 'model',
          score: 0.96,
          at: Date.now(),
          questions: [
            { id: 'q1', kind: 'yes_no', question: 'Ship this release?' },
            { id: 'q2', kind: 'open', question: 'Any release context?' },
          ],
        },
      },
    } as never);
  }, w.id);
}

// An idle shared Codex worker keeps the async questions its last turn asked, and a follow-up can come as well
// (docs/protocol.md: a turn's end answers none of them). #187: both are in the sheet's calm lane (no tabs any more),
// each with its question, its answers and Send in plain sight, and what was written on each survives closing the sheet.
for (const [width, height] of [
  [390, 844],
  [1280, 720],
] as const) {
  test(`at ${width}×${height} the follow-up and the async questions are in the sheet together, both drafts kept, the conversation its height`, async ({ page }) => {
    const clean = watchErrors(page);
    await page.setViewportSize({ width, height });
    const w = pixel();
    await openGame(page, 'demo-m5', '', SIM);
    const tx = await sitAtTranscript(page, w);
    const sheet = sheetOf(page);
    const aq = asyncCard(page);
    const fu = sheet.locator('.tx-fu');
    await idleWithFollowup(page, w);
    await expect(calmButton(page)).toHaveAccessibleName('Questions: 2 open, 2 from Codex');
    await expect(sheet).toBeHidden();
    await expect(tx.locator('.tx-input')).toBeEnabled();
    await fullHeight(tx);
    await calmButton(page).click();
    await expect(sheet).toHaveAccessibleName('Questions for you');
    await expect(fu).toBeVisible();
    await expect(aq).toBeVisible();
    // The follow-up first, the keyboard on it.
    await expect(fu.getByRole('radio', { name: 'Yes' })).toBeFocused();
    for (const l of [fu.getByRole('radio', { name: 'Yes' }), fu.locator('.tx-ask-send'), aq.locator('.tx-ask-question').first(), aq.locator('.tx-ask-send')]) {
      await l.scrollIntoViewIfNeeded();
      expect(await inSight(page, l)).toEqual([]);
    }
    await fu.getByRole('radio', { name: 'No' }).click();
    await expect(fu.locator('.tx-ask-question')).toHaveText('Any release context?');
    const note = fu.locator('textarea.tx-fu-text');
    await note.fill('follow-up draft');
    await aq.locator('.tx-ask-row[data-index="1"]').click();
    await aq.locator('textarea.tx-aq-text').fill('async draft');
    await shot(page, `h157-both-${width}x${height}`);
    // Closed and opened again: both drafts where they were, nothing sent.
    await sheet.locator('.sheet-close').click();
    await expect(sheet).toBeHidden();
    await fullHeight(tx);
    await calmButton(page).click();
    await expect(note).toHaveValue('follow-up draft');
    await expect(fu.locator('.tx-ask-row').first()).toContainText('No');
    await expect(aq.locator('textarea.tx-aq-text')).toHaveValue('async draft');
    expect(await sent(page, 'worker.answer_async')).toHaveLength(0);
    expect(await sent(page, 'worker.answer_followup')).toHaveLength(0);
    clean();
  });
}

// #157 (review round 2), #187: seated on a phone with both lanes' cards open, then the window made a short laptop's
// (#176: the workspace's content area, about 85 px less): the sheet follows the viewport (a bottom sheet, then a centred
// dialog), the answer field that had the keyboard keeps it, in sight; the conversation behind keeps its height.
test('a seated resize from a phone to a short laptop keeps the sheet in the viewport and the focused answer in sight', async ({ page }) => {
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const w = pixel();
  await openGame(page, 'demo-m5', '', SIM);
  const tx = await sitAtTranscript(page, w);
  const sheet = sheetOf(page);
  const fu = sheet.locator('.tx-fu');
  await idleWithFollowup(page, w);
  await calmButton(page).click();
  await fu.getByRole('radio', { name: 'No' }).click();
  const note = fu.locator('textarea.tx-fu-text');
  await note.fill('resize draft');
  await expect(note).toBeFocused();

  for (const [vw, vh] of [
    [1024, 440],
    [1920, 1080],
  ] as const) {
    await page.setViewportSize({ width: vw, height: vh });
    await frames(page, 6);
    const b = await sheet.boundingBox();
    expect(b && b.y >= -0.5 && b.y + b.height <= vh + 0.5 && b.x >= -0.5 && b.x + b.width <= vw + 0.5, `the sheet inside ${vw}×${vh}`).toBe(true);
    expect(b && Math.abs(b.x + b.width / 2 - vw / 2) <= 1, 'a centred dialog').toBe(true);
    await expect(note).toBeFocused();
    expect(await inSight(page, note), `the focused answer at ${vw}×${vh}`).toEqual([]);
    await expect(note).toHaveValue('resize draft');
  }
  await shot(page, 'h157-resized-dialog');
  await sheet.locator('.sheet-close').click();
  await fullHeight(tx);
  expect(await sent(page, 'worker.answer_followup')).toHaveLength(0);
  clean();
});

// #157 (review round 2), #187: fresh loads across a phone's height and just above it (#176: the screen's height is the
// seated workspace's content area, the window's height less about 85 px). The laptop's screen is short there, but the
// questions are not on it: the conversation keeps its whole height with both lanes' questions waiting, and the sheet,
// sized to the window, holds both cards' questions and Send.
for (const [vh, want] of [
  [375, 290],
  [425, 340],
  [968, 883],
] as const) {
  test(`both lanes on a ${want} px screen: the conversation keeps its height, the sheet holds the questions`, async ({ page }) => {
    const clean = watchErrors(page);
    await page.setViewportSize({ width: want > 800 ? 1920 : 1024, height: vh });
    const w = pixel();
    await openGame(page, 'demo-m5', '', SIM);
    const tx = await sitAtTranscript(page, w);
    expect(Math.abs((await tx.evaluate((e) => e.clientHeight)) - want), 'the screen’s height').toBeLessThanOrEqual(8);
    await idleWithFollowup(page, w);
    await expect(calmButton(page)).toBeVisible();
    await fullHeight(tx);
    await calmButton(page).click();
    const sheet = sheetOf(page);
    for (const l of [sheet.locator('.tx-fu .tx-ask-question'), sheet.locator('.tx-fu .tx-ask-send'), sheet.locator('.tx-aq .tx-ask-question').first(), sheet.locator('.tx-aq .tx-ask-send')]) {
      await l.scrollIntoViewIfNeeded();
      expect(await inSight(page, l)).toEqual([]);
    }
    clean();
  });
}
