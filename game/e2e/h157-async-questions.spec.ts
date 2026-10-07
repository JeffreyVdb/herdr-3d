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

/**
 * What `l` is drawn, in plain sight on its card: inside it, clear of a sticky top line and foot (unless it is in the
 * foot), and nothing over its middle. The faults found, none when it is in sight.
 */
async function inSight(card: Locator, l: Locator): Promise<string[]> {
  const c = await card.elementHandle();
  return l.evaluate((el, cardEl) => {
    const bad: string[] = [];
    if (!cardEl) return ['no card'];
    const r = el.getBoundingClientRect();
    const box = cardEl.getBoundingClientRect();
    const inFoot = !!el.closest('.tx-ask-foot');
    const top = Math.max(box.top, cardEl.querySelector('.tx-ask-top')?.getBoundingClientRect().bottom ?? box.top);
    const foot = cardEl.querySelector('.tx-ask-foot')?.getBoundingClientRect().top ?? box.bottom;
    const bottom = inFoot ? box.bottom : Math.min(box.bottom, foot);
    if (r.height < 8) bad.push(`${r.height}px high`);
    if (r.top < top - 0.5) bad.push(`top ${r.top.toFixed(1)} over ${top.toFixed(1)}`);
    if (r.bottom > bottom + 0.5) bad.push(`bottom ${r.bottom.toFixed(1)} under ${bottom.toFixed(1)}`);
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 12));
    if (!hit || !el.contains(hit)) bad.push(`covered by .${String(hit?.className ?? 'nothing')}`);
    return bad;
  }, c);
}

/** The height the card shows its questions in: inside it, between its top line and its foot (when they show). */
async function room(card: Locator): Promise<number> {
  return card.evaluate((c) => {
    const box = c.getBoundingClientRect();
    const top = c.querySelector('.tx-ask-top')?.getBoundingClientRect();
    const foot = c.querySelector('.tx-ask-foot')?.getBoundingClientRect();
    return Math.min(box.bottom, foot?.height ? foot.top : box.bottom) - Math.max(box.top, top?.height ? top.bottom : box.top);
  });
}

// The review's phone (390×844): the laptop's screen is under 300 px tall, so the card scrolls as one under a sticky
// top line and over a sticky foot. Where the keyboard lands (→ to a question, or the card moving on after a pick) is
// scrolled into plain sight, never left under the foot.
test('on a phone the keyboard lands in plain sight: → to a question, and the next one after a pick', async ({ page }) => {
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const w = pixel();
  await openGame(page, 'demo-m5', '', SIM);
  const tx = await sitAtTranscript(page, w);
  const card = tx.locator('.tx-aq');
  await expect(card).toBeVisible();
  const text = card.locator('textarea.tx-aq-text');

  await page.keyboard.press('ArrowRight');
  await expect(text).toBeFocused();
  expect(await inSight(card, text), 'question 2’s text box after →').toEqual([]);

  // Back on question 1 (its first option has the keyboard), 1 picks Green and the card moves on to question 2.
  await page.keyboard.press('Escape');
  await expect(tx.locator('.tx-scroll')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  const green = card.getByRole('radio', { name: 'Green' });
  await expect(green).toBeFocused();
  expect(await inSight(card, green), 'question 1’s option after ←').toEqual([]);
  await page.keyboard.press('1');
  await expect(text).toBeFocused();
  expect(await inSight(card, text), 'question 2’s text box after a pick').toEqual([]);
  await page.keyboard.type('Typed where it can be seen.');
  expect(await inSight(card, text)).toEqual([]);
  expect(await inSight(card, card.locator('.tx-ask-send'))).toEqual([]);
  expect(await sent(page, 'worker.answer_async')).toHaveLength(0);
  await shot(page, 'h157-async-phone-keyboard'); // last: the shot hides the HUD for a moment, and the focus with it
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
// (docs/protocol.md: a turn's end answers none of them). On a phone there is no room for two cards: one is open, the
// other a tab away; each, when open, has its question, its answers and Send in plain sight, and what was written on
// each survives the switches.
test('on a phone the follow-up and the async questions take turns: one open, the other a tab away, both drafts kept', async ({ page }) => {
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const w = pixel();
  await openGame(page, 'demo-m5', '', SIM);
  const tx = await sitAtTranscript(page, w);
  const aq = tx.locator('.tx-aq');
  const fu = tx.locator('.tx-fu');
  await expect(aq).toBeVisible();
  await idleWithFollowup(page, w);
  const tabs = tx.getByRole('tablist', { name: 'Questions for you' });
  const fuTab = tabs.getByRole('tab', { name: /^Open questions/ });
  const aqTab = tabs.getByRole('tab', { name: /^Codex asked/ });
  await expect(tabs).toBeVisible();
  // The card that was up stays open; the follow-up waits behind its tab.
  await expect(aqTab).toHaveAttribute('aria-selected', 'true');
  await expect(fuTab).toHaveAttribute('aria-selected', 'false');
  await expect(fu).toBeHidden();
  await expect(aq).toBeVisible();
  await expect(tx.locator('.tx-input')).toBeEnabled();
  // The open card keeps the room a lone one has (the review measured 3 px with both drawn): a question and an answer.
  expect(await room(aq), 'the async card’s room for its questions').toBeGreaterThanOrEqual(64);
  expect(await inSight(aq, aq.locator('.tx-ask-question'))).toEqual([]);
  expect(await inSight(aq, aq.locator('.tx-ask-send'))).toEqual([]);
  // Its draft: question 2's text, from the keyboard (→ from the timeline), in sight.
  await tx.locator('.tx-scroll').focus();
  await page.keyboard.press('ArrowRight');
  await expect(aq.locator('textarea.tx-aq-text')).toBeFocused();
  expect(await inSight(aq, aq.locator('textarea.tx-aq-text'))).toEqual([]);
  await page.keyboard.type('async draft');

  // The follow-up's tab: its card opens, the keyboard on it, everything in sight.
  await fuTab.click();
  await expect(fu).toBeVisible();
  await expect(aq).toBeHidden();
  await expect(fuTab).toHaveAttribute('aria-selected', 'true');
  await expect(fu.getByRole('radio', { name: 'Yes' })).toBeFocused();
  expect(await room(fu), 'the follow-up card’s room for its questions').toBeGreaterThanOrEqual(64);
  expect(await inSight(fu, fu.getByRole('radio', { name: 'Yes' }))).toEqual([]);
  expect(await inSight(fu, fu.locator('.tx-ask-send'))).toEqual([]);
  await fu.getByRole('radio', { name: 'No' }).click();
  await expect(fu.locator('.tx-ask-question')).toHaveText('Any release context?');
  const note = fu.locator('textarea.tx-fu-text');
  await note.fill('follow-up draft');
  expect(await inSight(fu, note)).toEqual([]);

  // Back and forth from the keyboard (← → on the tabs): both drafts are where they were.
  await fuTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(aqTab).toBeFocused();
  await expect(aq).toBeVisible();
  await expect(aq.locator('textarea.tx-aq-text')).toHaveValue('async draft');
  await page.keyboard.press('ArrowLeft');
  await expect(fuTab).toBeFocused();
  await expect(fu).toBeVisible();
  await expect(note).toHaveValue('follow-up draft');
  await expect(fu.locator('.tx-ask-row').first()).toContainText('No');
  expect(await sent(page, 'worker.answer_async')).toHaveLength(0);
  expect(await sent(page, 'worker.answer_followup')).toHaveLength(0);
  await shot(page, 'h157-phone-both-followup');
  await aqTab.click();
  await shot(page, 'h157-phone-both-async');
  clean();
});

// On a laptop's screen the two take turns as well: the open card whole (its top line too), the timeline keeps room.
test('on a laptop the follow-up and the async questions take turns too, and the conversation keeps its room', async ({ page }) => {
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  const w = pixel();
  await openGame(page, 'demo-m5', '', SIM);
  const tx = await sitAtTranscript(page, w);
  const aq = tx.locator('.tx-aq');
  await expect(aq).toBeVisible();
  await idleWithFollowup(page, w);
  const tabs = tx.getByRole('tablist', { name: 'Questions for you' });
  await expect(tabs).toBeVisible();
  await expect(aq.locator('.tx-ask-top')).toBeVisible();
  await expect(tx.locator('.tx-fu')).toBeHidden();
  expect((await tx.locator('.tx-main').boundingBox())?.height ?? 0, 'the conversation’s room').toBeGreaterThanOrEqual(80);
  await tabs.getByRole('tab', { name: /^Open questions/ }).click();
  await expect(tx.locator('.tx-fu .tx-ask-top')).toBeVisible();
  await expect(aq).toBeHidden();
  expect((await tx.locator('.tx-main').boundingBox())?.height ?? 0, 'the conversation’s room').toBeGreaterThanOrEqual(70);
  // Room for both: the card stays beside the conversation, the strip on top.
  await expect(tx).not.toHaveAttribute('data-tight');
  await expect(tx.locator('.tx-bar')).toBeVisible();
  expect(await faults(tx)).toEqual([]);
  await shot(page, 'h157-laptop-both-followup');
  clean();
});

/**
 * What is wrong with the pinned card's layout as drawn: a tab not hit where it is drawn (the timeline painting over
 * it), the timeline running into the card, the prompt box pushed off the screen or covered, the open card's questions
 * under 64 px. None when it holds.
 */
async function faults(tx: Locator): Promise<string[]> {
  return tx.evaluate((root) => {
    const bad: string[] = [];
    const hits = (el: Element) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 12));
      return hit && el.contains(hit) ? null : `.${String(hit?.className ?? 'nothing')}`;
    };
    for (const t of root.querySelectorAll('.tx-qtabs:not([hidden]) .tx-qtab')) {
      const by = hits(t);
      if (by) bad.push(`tab “${t.querySelector('.tx-qtab-name')?.textContent}” covered by ${by}`);
    }
    const box = root.getBoundingClientRect();
    const main = root.querySelector('.tx-main')!.getBoundingClientRect();
    if (main.height < 0) bad.push(`timeline ${main.height}px`);
    const card = [...root.querySelectorAll<HTMLElement>('.tx-fu, .tx-aq')].find((c) => !c.hidden && getComputedStyle(c).display !== 'none');
    if (!card) return [...bad, 'no open card'];
    const c = card.getBoundingClientRect();
    if (main.bottom > c.top + 0.5) bad.push(`timeline ends at ${main.bottom}, the card starts at ${c.top}`);
    const top = card.querySelector('.tx-ask-top')?.getBoundingClientRect();
    const foot = card.querySelector('.tx-ask-foot')?.getBoundingClientRect();
    const room = Math.min(c.bottom, foot?.height ? foot.top : c.bottom) - Math.max(c.top, top?.height ? top.bottom : c.top);
    if (room < 64) bad.push(`question room ${room}px`);
    const prompt = root.querySelector('.tx-prompt')!.getBoundingClientRect();
    if (prompt.bottom > box.bottom + 0.5) bad.push(`prompt box ends at ${prompt.bottom}, the screen at ${box.bottom}`);
    const input = root.querySelector('.tx-input');
    const by = input && hits(input);
    if (by) bad.push(`prompt box covered by ${by}`);
    return bad;
  });
}

// #157 (review round 2): seated on a phone with both cards, then the window made a short laptop's. The screen comes
// out about 303 px tall, just above a phone's: the strip, the tabs, a card and the prompt box do not fit together
// there, so the open card takes the timeline's room as on a phone (measured, not a height), the tabs clickable, and
// the answer field that had the keyboard is in sight.
test('a seated resize from a phone to a short laptop keeps the tabs clickable and the focused answer in sight', async ({ page }) => {
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const w = pixel();
  await openGame(page, 'demo-m5', '', SIM);
  const tx = await sitAtTranscript(page, w);
  const aq = tx.locator('.tx-aq');
  const fu = tx.locator('.tx-fu');
  await expect(aq).toBeVisible();
  await idleWithFollowup(page, w);
  const tabs = tx.getByRole('tablist', { name: 'Questions for you' });
  const fuTab = tabs.getByRole('tab', { name: /^Open questions/ });
  const aqTab = tabs.getByRole('tab', { name: /^Codex asked/ });
  await fuTab.click();
  await fu.getByRole('radio', { name: 'No' }).click();
  const note = fu.locator('textarea.tx-fu-text');
  await note.fill('resize draft');
  await expect(note).toBeFocused();

  await page.setViewportSize({ width: 1024, height: 586 });
  await frames(page, 6);
  const height = await tx.evaluate((e) => e.clientHeight);
  expect(height, 'a short laptop’s screen, just above a phone’s').toBeGreaterThan(300);
  expect(height).toBeLessThan(380);
  await expect(tx).toHaveAttribute('data-tight', '');
  expect(await faults(tx)).toEqual([]);
  await expect(note).toBeFocused();
  expect(await inSight(fu, note), 'the focused answer after the resize').toEqual([]);
  await shot(page, 'h157-resized-short-followup');

  // The mouse switches: the other card opens, and back, the draft kept.
  await aqTab.click();
  await expect(aqTab).toHaveAttribute('aria-selected', 'true');
  await expect(aq).toBeVisible();
  await expect(fu).toBeHidden();
  expect(await faults(tx)).toEqual([]);
  await fuTab.click();
  await expect(fu).toBeVisible();
  await expect(note).toHaveValue('resize draft');

  // Back to a roomy window: the card goes back beside the conversation, the strip with it.
  await page.setViewportSize({ width: 1920, height: 1080 });
  await frames(page, 6);
  await expect(tx).not.toHaveAttribute('data-tight');
  await expect(tx.locator('.tx-bar')).toBeVisible();
  expect(await faults(tx)).toEqual([]);
  expect(await sent(page, 'worker.answer_followup')).toHaveLength(0);
  clean();
});

// #157 (review round 2): fresh loads across a phone's height and just above it (the screen's height for a 1024-wide
// window is its height less about 183 px: the slim top bar (#top-bar redesign) gave back 14 px). Wherever the open card does not fit beside the conversation it takes its
// room; the tabs, the card's questions and the prompt box hold at every height, for either card.
for (const [vh, want, tight] of [
  [473, 290, true],
  [486, 303, true],
  [503, 320, true],
  [523, 340, true],
  [1066, 883, false],
] as const) {
  test(`both cards on a ${want} px screen: the tabs, the questions and the prompt box hold`, async ({ page }) => {
    const clean = watchErrors(page);
    await page.setViewportSize({ width: vh > 1000 ? 1920 : 1024, height: vh });
    const w = pixel();
    await openGame(page, 'demo-m5', '', SIM);
    const tx = await sitAtTranscript(page, w);
    expect(Math.abs((await tx.evaluate((e) => e.clientHeight)) - want), 'the screen’s height').toBeLessThanOrEqual(8);
    await expect(tx.locator('.tx-aq')).toBeVisible();
    await idleWithFollowup(page, w);
    const tabs = tx.getByRole('tablist', { name: 'Questions for you' });
    await expect(tabs).toBeVisible();
    if (tight) await expect(tx).toHaveAttribute('data-tight', '');
    else await expect(tx).not.toHaveAttribute('data-tight');
    expect(await faults(tx), 'the async card open').toEqual([]);
    await tabs.getByRole('tab', { name: /^Open questions/ }).click();
    await expect(tx.locator('.tx-fu')).toBeVisible();
    expect(await faults(tx), 'the follow-up open').toEqual([]);
    await tabs.getByRole('tab', { name: /^Codex asked/ }).click();
    await expect(tx.locator('.tx-aq')).toBeVisible();
    clean();
  });
}
