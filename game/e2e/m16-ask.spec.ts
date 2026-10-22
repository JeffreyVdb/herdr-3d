import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Ask, Worker } from '../src/net/protocol';
import { frames, openGame, seatMode, shot, watchErrors } from './game';

// #57: an agent's structured question (Claude's AskUserQuestion, Codex's request_user_input) on demo-m5 with sim=1.
// The simulator's `sim.ask` plays the bridge reading it from the transcript: the worker (idle, as herdr calls a
// hire's question) needs you; at its laptop the ask opens the questions' sheet by itself, once (#187: a dialog, a
// bottom sheet on a phone; its questions stacked: the open one, the others folded to their answer), answered with the
// keyboard or clicks, where Enter never sends: only Send or Ctrl+Enter does. Hidden (Esc), the questions button in the
// prompt box keeps it and Q opens it again; the conversation keeps its whole height. Where you stand a one-pick question
// takes a digit; the terminal says T answers it.

const SIM = 'play=none&sim=1&simms=300&simusage=0';

function demoWorker(name: string): Worker {
  const snap = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/demo-m5.jsonl'), 'utf8').split('\n')[0] ?? '{}') as { world: { workers: Worker[] } };
  const w = snap.world.workers.find((x) => x.name === name);
  if (!w) throw new Error(`no ${name} in demo-m5`);
  return w;
}

/** Two questions, the first a multi-select: the shape AC5 answers (one multi-select, one Other). */
const two: Partial<Ask> = {
  tool_use_id: 'toolu_e2e_two',
  agent: 'claude',
  questions: [
    {
      header: 'Extras',
      question: 'Which extras should be enabled?',
      multi: true,
      other: true,
      options: [
        { label: 'Logs', description: 'Request logs' },
        { label: 'Metrics', description: 'Request metrics' },
        { label: 'Traces', description: 'Request traces' },
      ],
    },
    {
      header: 'Color',
      question: 'Which color?',
      multi: false,
      other: true,
      options: [
        { label: 'Red (Recommended)', description: 'Warm color' },
        { label: 'Blue', description: 'Cool color' },
      ],
    },
  ],
};

const one: Partial<Ask> = {
  tool_use_id: 'toolu_e2e_one',
  agent: 'claude',
  questions: [
    {
      header: 'Transport',
      question: 'How should the laptop upload pasted screenshots: an HTTP POST through the helper, or WebSocket chunks?',
      multi: false,
      other: true,
      options: [
        { label: 'HTTP POST via helper (Recommended)', description: 'Reuses the helper proxy that already checks Host, Origin and the token' },
        { label: 'WebSocket chunks (as #13)', description: 'Chunk framing, reassembly, backpressure and resume on reconnect' },
      ],
    },
  ],
};

const sent = (page: Page, t: string) => page.evaluate((x) => window.__h3d.sent().filter((c) => c.t === x), t);

/** #187: the questions' sheet (on the page, outside the laptop's screen). */
const sheetOf = (page: Page): Locator => page.locator('dialog.tx-qsheet');
/** #187: the urgent questions button in the prompt box (its text runs label and count together: by its name). */
const urgentButton = (page: Page): Locator => page.locator('.seat-transcript .tx-prompt').getByRole('button', { name: /^Answer to continue/ });

/** #187 AC1: the timeline's bottom edge meets the prompt box: no question sits between them. */
async function fullHeight(page: Page): Promise<void> {
  const tx = page.locator('.seat-transcript .tx');
  const [m, f] = await Promise.all([tx.locator('.tx-main').boundingBox(), tx.locator('.tx-prompt').boundingBox()]);
  expect(m && f, 'the timeline and the prompt box').toBeTruthy();
  if (m && f) expect(Math.abs(m.y + m.height - f.y), 'the timeline meets the prompt box').toBeLessThanOrEqual(1);
  expect(await tx.locator('.tx-ask, .tx-fu, .tx-aq, .tx-bq').count()).toBe(0);
}

async function sitAtTranscript(page: Page, w: Worker): Promise<void> {
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.face(id), w.id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.sitAt(id), w.id)).toBe(true);
  await frames(page, 20);
  // #98: its conversation is up as you sit.
  await seatMode(page, 'transcript');
  await expect(page.locator('.seat-transcript .tx .tx-scroll')).toBeFocused();
  await expect.poll(() => page.evaluate(async () => (await window.__h3d.simTranscripts())?.watches ?? 0)).toBeGreaterThan(0);
}

test('a two-question ask: needs you while herdr says idle, opens the sheet, answered from the keyboard, recorded in the timeline', { tag: '@smoke' }, async ({ page }) => {
  const clean = watchErrors(page);
  const w = demoWorker('Pebble'); // idle: herdr never said blocked
  await openGame(page, 'demo-m5', '', SIM);
  await sitAtTranscript(page, w);
  const tx = page.locator('.seat-transcript .tx');

  expect((await page.evaluate(() => window.__h3d.simAsk({ id: 'cf1db588-9a66-4307-adfa-1bbe4306c2f3', ask: null }))).ok).toBe(true); // nothing to end: fine
  await page.evaluate((a) => window.__h3d.simAsk({ id: 'cf1db588-9a66-4307-adfa-1bbe4306c2f3', ask: a }), two);
  const sheet = sheetOf(page);
  const card = sheet.locator('.tx-ask');
  await expect(card).toBeVisible();
  // It needs you (N's queue, the look of its card), idle or not.
  await expect.poll(() => page.evaluate((id) => window.__h3d.needs().some((n) => n.id === id && n.reason === 'blocked'), w.id)).toBe(true);
  // #187: the sheet opened by itself, named for its lane, the keyboard on the open question's first option; the prompt
  // box is off; the timeline has the call, waiting.
  await expect(sheet).toHaveAttribute('open', '');
  await expect(sheet).toHaveAccessibleName('Answer to continue');
  await expect(card.locator('button.tx-ask-opt[data-n="1"]')).toBeFocused();
  await expect(tx.locator('.tx-input')).toBeDisabled();
  await expect(tx.locator('.tx-input')).toHaveAttribute('data-placeholder', 'Answer the questions first (button above, or in the terminal)');
  await expect(tx.locator('.tx-ask-item[data-outcome="pending"]')).toContainText('Which extras should be enabled?');
  await expect(tx.locator('.tx-ask-item .tx-ask-input > summary')).toHaveText('Input');
  // Stacked: Extras open (checkboxes, pick several), Color folded under it; Send off until both are answered.
  await expect(card.locator('.tx-ask-q .tx-ask-chip')).toHaveText('Extras');
  await expect(card.locator('.tx-ask-row .tx-ask-row-head')).toHaveText(['Color']);
  await expect(card.locator('.tx-ask-row .tx-ask-row-text')).toHaveText(['Which color?']);
  await expect(card.locator('.tx-ask-opts')).toHaveClass(/is-multi/);
  await expect(card.locator('[role="checkbox"]')).toHaveCount(3);
  await expect(card.locator('.tx-ask-send')).toHaveAttribute('aria-disabled', 'true');
  await expect(card.locator('.tx-ask-wait')).toHaveText(/^waiting \d+s$/);
  await shot(page, 'm16-ask-card');
  await card.locator('button.tx-ask-opt[data-n="1"]').focus(); // the bare screenshot may drop the focus

  // No click: 1 and 3 tick Logs and Traces, 4 goes to Other; Esc there closes the sheet (the timeline has the keys
  // again, you are still seated), the button keeps the question, the conversation its whole height; Q opens it again.
  await page.keyboard.press('1');
  await page.keyboard.press('3');
  await expect(card.locator('[role="checkbox"][aria-checked="true"]')).toHaveCount(2);
  await page.keyboard.press('4');
  await expect(card.locator('.tx-ask-other-input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(tx.locator('.tx-scroll')).toBeFocused();
  expect(await page.evaluate(() => window.__h3d.seated())).not.toBeNull(); // Esc in the sheet does not stand you up
  await expect(urgentButton(page)).toBeVisible();
  await expect(urgentButton(page)).toHaveAccessibleName('Answer to continue: 2 questions');
  await expect(urgentButton(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(tx.locator('.tx-input')).toBeDisabled();
  await fullHeight(page);
  await shot(page, 'm16-ask-hidden');
  await tx.locator('.tx-scroll').focus();
  await page.keyboard.press('q');
  await expect(sheet).toHaveAttribute('open', '');
  await expect(card.locator('[role="checkbox"][aria-checked="true"]')).toHaveCount(2); // kept
  await page.keyboard.press('4');
  await page.keyboard.type('Custom dashboards');
  // Enter in the text takes it and moves on to Color (the question itself has the keyboard); nothing is sent.
  await page.keyboard.press('Enter');
  await expect(card.locator('.tx-ask-q .tx-ask-chip')).toHaveText('Color');
  await expect(card.locator('.tx-ask-q')).toBeFocused();
  await expect(card.locator('.tx-ask-row.is-done .tx-ask-row-text')).toHaveText('Logs, Traces, Custom dashboards');
  await expect(card.locator('.tx-ask-rec')).toHaveText('recommended');
  await expect(card.locator('.tx-ask-opt-label').first()).toContainText('Red');
  await expect(card.locator('[role="radio"]')).toHaveCount(2);
  // An Enter on the question itself picks nothing: it says how to pick.
  await page.keyboard.press('Enter');
  await expect(card.locator('.tx-ask-nudge.is-loud')).toContainText('Enter picks nothing here');
  await expect(card.locator('[role="radio"][aria-checked="true"]')).toHaveCount(0);
  // ← back to Extras (what was typed is kept), 2 ticks Metrics too, → on to Color again.
  await page.keyboard.press('ArrowLeft');
  await expect(card.locator('.tx-ask-q .tx-ask-chip')).toHaveText('Extras');
  await expect(card.locator('.tx-ask-other-input')).toHaveValue('Custom dashboards');
  await page.keyboard.press('2');
  await expect(card.locator('[role="checkbox"][aria-checked="true"]')).toHaveCount(3);
  await page.keyboard.press('ArrowRight');
  await expect(card.locator('.tx-ask-q .tx-ask-chip')).toHaveText('Color');
  // Opened with ← →, its first option has the keyboard: ↓ to the second, ↓ to Other; typed, Enter: every question
  // answered, all folded, Send has the keyboard.
  await expect(card.locator('button.tx-ask-opt[data-n="1"]')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(card.locator('button.tx-ask-opt[data-n="2"]')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(card.locator('.tx-ask-other-input')).toBeFocused();
  await page.keyboard.type('Green');
  await page.keyboard.press('Enter');
  await expect(card.locator('.tx-ask-q')).toHaveCount(0);
  await expect(card.locator('.tx-ask-row .tx-ask-row-text')).toHaveText(['Logs, Metrics, Traces, Custom dashboards', 'Green']);
  await expect(card.locator('.tx-ask-send')).toBeFocused();
  await expect(card.locator('.tx-ask-send')).toHaveAttribute('aria-disabled', 'false');
  expect(await sent(page, 'worker.answer_ask')).toHaveLength(0);
  await shot(page, 'm16-ask-card-filled');
  await card.locator('.tx-ask-send').focus(); // the screenshot may drop the focus

  // Closed and opened again (the button this time): the answers are kept, Send has the keyboard; nothing went meanwhile.
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await urgentButton(page).click();
  await expect(card.locator('.tx-ask-row .tx-ask-row-text')).toHaveText(['Logs, Metrics, Traces, Custom dashboards', 'Green']);
  await expect(card.locator('.tx-ask-send')).toBeFocused();
  expect(await sent(page, 'worker.answer_ask')).toHaveLength(0);
  expect(await page.evaluate(() => window.__h3d.seated())).not.toBeNull();
  await page.keyboard.press('Enter');

  // Sending, then gone once the bridge says it is resolved; the timeline shows what the transcript recorded.
  await expect.poll(async () => (await sent(page, 'worker.answer_ask')).length).toBe(1);
  expect((await sent(page, 'worker.answer_ask'))[0]?.args).toEqual({
    id: w.id,
    tool_use_id: 'toolu_e2e_two',
    answers: [
      { question: 0, choices: [1, 2, 3], other: 'Custom dashboards' },
      { question: 1, other: 'Green' },
    ],
  });
  await expect(card).toBeHidden();
  await expect(sheet).toBeHidden();
  await expect(urgentButton(page)).toBeHidden();
  const item = tx.locator('.tx-ask-item[data-outcome="answered"]');
  await expect(item.locator('.tx-ask-answers li')).toHaveText([
    '●You answered: Which extras should be enabled? → Logs, Metrics, Traces, Custom dashboards',
    '●You answered: Which color? → Green',
  ]);
  await expect(tx.locator('.tx-input')).toBeEnabled();
  await expect.poll(() => page.evaluate((id) => window.__h3d.needs().some((n) => n.id === id), w.id)).toBe(false);
  await shot(page, 'm16-ask-answered');
  clean();
});

/** Two pick-one questions: the shape of the reported bug (#90's card had it: a click, then Enter sent one answer). */
const twoPicks: Partial<Ask> = {
  tool_use_id: 'toolu_e2e_picks',
  agent: 'claude',
  questions: [
    { header: 'Where', question: 'Where did you see it?', multi: false, other: true, options: [{ label: 'Transcript view card' }, { label: 'Claude Code dialog' }] },
    { header: 'Next', question: 'Build it or prototype first?', multi: false, other: true, options: [{ label: 'Build it' }, { label: 'Prototype first' }] },
  ],
};

test('a click on the first question, then Enter, sends nothing: the next one has the keyboard, says how to pick, and Ctrl+Enter sends once both are answered', async ({ page }) => {
  const clean = watchErrors(page);
  const w = demoWorker('Pebble');
  await openGame(page, 'demo-m5', '', SIM);
  await sitAtTranscript(page, w);
  const tx = page.locator('.seat-transcript .tx');
  const card = sheetOf(page).locator('.tx-ask');
  await page.evaluate((a) => window.__h3d.simAsk({ id: 'cf1db588-9a66-4307-adfa-1bbe4306c2f3', ask: a }), twoPicks);
  await expect(card).toBeVisible();
  await card.locator('button.tx-ask-opt[data-n="1"]').click();
  await expect(card.locator('.tx-ask-q .tx-ask-chip')).toHaveText('Next');
  await expect(card.locator('.tx-ask-q')).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await frames(page, 5);
  expect(await sent(page, 'worker.answer_ask')).toHaveLength(0);
  await expect(card.locator('[role="radio"][aria-checked="true"]')).toHaveCount(0);
  await expect(card.locator('.tx-ask-nudge.is-loud')).toBeVisible();
  // Ctrl+Enter with Next unanswered: nothing sent, it says so.
  await page.keyboard.press('Control+Enter');
  await expect(card.locator('.tx-ask-note')).toContainText('Answer “Next” first');
  expect(await sent(page, 'worker.answer_ask')).toHaveLength(0);
  // A pick by its digit, then Ctrl+Enter: both go.
  await page.keyboard.press('2');
  await expect(card.locator('.tx-ask-send')).toBeFocused();
  await page.keyboard.press('Control+Enter');
  await expect.poll(async () => (await sent(page, 'worker.answer_ask')).length).toBe(1);
  expect((await sent(page, 'worker.answer_ask'))[0]?.args).toEqual({ id: w.id, tool_use_id: 'toolu_e2e_picks', answers: [{ question: 0, choices: [1] }, { question: 1, choices: [2] }] });
  await expect(card).toBeHidden();
  clean();
});

test('a stale answer is refused and the card updates; answered in the terminal, the timeline shows it', async ({ page }) => {
  const clean = watchErrors(page);
  const w = demoWorker('Pebble');
  await openGame(page, 'demo-m5', '', SIM);
  await sitAtTranscript(page, w);
  const tx = page.locator('.seat-transcript .tx');
  const card = sheetOf(page).locator('.tx-ask');
  await page.evaluate((a) => window.__h3d.simAsk({ id: 'cf1db588-9a66-4307-adfa-1bbe4306c2f3', ask: a }), one);
  await expect(card).toBeVisible();
  await expect(card.locator('.tx-ask-question')).toContainText('How should the laptop upload');

  // The game still shows an ask the bridge no longer has (another tool_use_id): stale, and it says so.
  const cur: Worker = { ...w, ask: { source: 'transcript', since: Date.now(), ...one } as Ask };
  await page.evaluate((x) => window.__h3d.inject({ t: 'worker.upsert', seq: 1_000_000, worker: x }), { ...cur, ask: { ...(cur.ask as Ask), tool_use_id: 'toolu_gone' } });
  await card.locator('[data-n="2"]').click();
  await card.locator('.tx-ask-send').click();
  await expect(card.locator('.tx-ask-note.is-error')).toContainText('answered or changed meanwhile');
  // The real one comes back (the next upsert): the card is that question, fresh.
  await page.evaluate((x) => window.__h3d.inject({ t: 'worker.upsert', seq: 1_000_001, worker: x }), cur);
  await expect(card.locator('[aria-checked="true"]')).toHaveCount(0);

  // Answered in the terminal: the card goes, the timeline has the answer.
  await page.evaluate(() => window.__h3d.simAsk({ id: 'cf1db588-9a66-4307-adfa-1bbe4306c2f3', ask: null, answers: [{ question: 0, answer: 'HTTP POST via helper (Recommended)' }] }));
  await expect(card).toBeHidden();
  await expect(tx.locator('.tx-ask-item[data-outcome="answered"] .tx-ask-answers li')).toHaveText([
    '●You answered: How should the laptop upload pasted screenshots: an HTTP POST through the helper, or WebSocket chunks? → HTTP POST via helper (Recommended)',
  ]);
  clean();
});

test('another question while an answer is sent: the old ack leaves it up, the prompt stays off', async ({ page }) => {
  const clean = watchErrors(page);
  const w = demoWorker('Pebble');
  await openGame(page, 'demo-m5', '', 'play=none&sim=1&simms=1500&simusage=0'); // slow acks: the new ask comes first
  await sitAtTranscript(page, w);
  const tx = page.locator('.seat-transcript .tx');
  const card = sheetOf(page).locator('.tx-ask');
  await page.evaluate((a) => window.__h3d.simAsk({ id: 'cf1db588-9a66-4307-adfa-1bbe4306c2f3', ask: a }), one);
  await card.locator('[data-n="2"]').click();
  await card.locator('.tx-ask-send').click();
  await expect(card).toHaveAttribute('data-phase', 'sending');
  const q = one.questions?.[0] as Ask['questions'][number];
  await page.evaluate((a) => window.__h3d.simAsk({ id: 'cf1db588-9a66-4307-adfa-1bbe4306c2f3', ask: a }), { ...one, tool_use_id: 'toolu_e2e_new', questions: [{ ...q, question: 'NEW QUESTION: which transport?' }] });
  await expect(card.locator('.tx-ask-question')).toHaveText('NEW QUESTION: which transport?');
  await expect(card).toHaveAttribute('data-phase', 'pending');
  await expect(card.locator('[aria-checked="true"]')).toHaveCount(0);
  // The old answer's ack (stale: another question now) changes nothing but a note.
  await expect(card.locator('.tx-ask-note')).toContainText('changed meanwhile');
  await expect(card).toBeVisible();
  await expect(card.locator('.tx-ask-question')).toHaveText('NEW QUESTION: which transport?');
  await expect(tx.locator('.tx-input')).toBeDisabled();
  expect(await page.evaluate((id) => window.__h3d.needs().some((n) => n.id === id), w.id)).toBe(true);
  // And it is answered as usual.
  await card.locator('[data-n="1"]').click();
  await card.locator('.tx-ask-send').click();
  await expect(card).toBeHidden();
  await expect.poll(async () => (await sent(page, 'worker.answer_ask')).map((c) => (c.args as { tool_use_id: string }).tool_use_id)).toEqual(['toolu_e2e_one', 'toolu_e2e_new']);
  clean();
});

/** Four questions with descriptions and previews: the tallest card, for the screen sizes below. */
const four: Partial<Ask> = {
  tool_use_id: 'toolu_e2e_four',
  agent: 'claude',
  questions: ['Storage', 'Delivery', 'Observability', 'Migration'].map((header, i) => ({
    header,
    question: `${header}: which approach should the service take for the ${header.toLowerCase()} of uploaded screenshots, given the helper proxy and the existing token checks?`,
    multi: i === 2,
    other: i !== 1,
    options: [
      { label: `${header} plan A (Recommended)`, description: 'Keeps the current shape and adds the least new moving parts to the bridge', ...(i === 1 ? { preview: 'POST /upload\n  Host: 127.0.0.1\n  Origin: game\n  X-Token: …' } : {}) },
      { label: `${header} plan B`, description: 'More work up front, but it scales past one laptop per worker', ...(i === 1 ? { preview: 'ws.send(chunk)\n  ack → next\n  resume on reconnect' } : {}) },
      { label: `${header} plan C`, description: 'Defers the decision: a flag, both paths, measure first' },
    ],
  })),
};

for (const [width, height, phone] of [
  [1280, 720, false],
  [960, 600, false],
  [390, 844, true],
] as const) {
  test(`a four-question ask at ${width}×${height}${phone ? ' (a phone: a bottom sheet)' : ' (a dialog)'}: in the viewport, every question and option reachable, Send clickable; hidden, the conversation keeps its height`, async ({ browser }) => {
    // #187: the sheet is sized to the page's viewport, not to the laptop's screen (a phone's can be under 200px tall).
    const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: phone, isMobile: phone });
    const page = await ctx.newPage();
    const clean = watchErrors(page);
    const w = demoWorker('Pebble');
    await openGame(page, 'demo-m5', '', SIM);
    await sitAtTranscript(page, w);
    const sheet = sheetOf(page);
    const card = sheet.locator('.tx-ask');
    await page.evaluate((a) => window.__h3d.simAsk({ id: 'cf1db588-9a66-4307-adfa-1bbe4306c2f3', ask: a }), four);
    await expect(card).toBeVisible();
    await expect(sheet).toHaveAttribute('open', '');
    const box = await sheet.boundingBox();
    expect(box, 'the sheet').toBeTruthy();
    if (box) {
      expect(box.x).toBeGreaterThanOrEqual(-0.5);
      expect(box.y).toBeGreaterThanOrEqual(-0.5);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
      expect(box.y + box.height).toBeLessThanOrEqual(height + 0.5);
      if (phone) {
        // A bottom sheet: the whole width, on the bottom edge.
        expect(box.width).toBeGreaterThanOrEqual(width - 1);
        expect(Math.abs(box.y + box.height - height)).toBeLessThanOrEqual(1);
      } else {
        // A dialog: centred, with the page around it.
        expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThanOrEqual(1);
        expect(box.y).toBeGreaterThan(0);
      }
    }
    await shot(page, `m16-ask-fit-${width}x${height}`);
    // Hidden: the conversation keeps its whole height; the button opens it again.
    await sheet.locator('.sheet-close').click();
    await expect(sheet).toBeHidden();
    await fullHeight(page);
    await shot(page, `m16-ask-hidden-${width}x${height}`);
    await urgentButton(page).click();
    await expect(sheet).toHaveAttribute('open', '');
    // Every question answered with clicks (each option scrolled to, not hidden under an edge), then Send: a single-pick
    // answer moves on by itself, the pick-several one is left with a click on the next folded question.
    for (const header of ['Storage', 'Delivery', 'Observability', 'Migration']) {
      if ((await card.locator('.tx-ask-q .tx-ask-chip').textContent()) !== header) await card.locator('.tx-ask-row').filter({ hasText: header }).click();
      await expect(card.locator('.tx-ask-question')).toContainText(header);
      await card.locator('button.tx-ask-opt[data-n="3"]').click();
    }
    await expect(card.locator('.tx-ask-row.is-done')).toHaveCount(4);
    await card.locator('.tx-ask-send').click();
    await expect.poll(async () => (await sent(page, 'worker.answer_ask')).length).toBe(1);
    await expect(card).toBeHidden();
    clean();
    await ctx.close();
  });
}

test('where you stand: digits answer a one-pick ask, a richer one sends you to the laptop; seated at the terminal, T answers it in the transcript view', async ({ page }) => {
  const clean = watchErrors(page);
  const w = demoWorker('Pebble');
  const codex = demoWorker('Dumpling'); // done, a Codex agent
  await openGame(page, 'demo-m5', '', SIM);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  await page.evaluate((a) => window.__h3d.simAsk({ id: 'cf1db588-9a66-4307-adfa-1bbe4306c2f3', ask: a }), one);
  expect(await page.evaluate((id) => window.__h3d.face(id), w.id)).toBe(true);
  await expect
    .poll(() => page.evaluate((name) => window.__h3d.cards().find((c) => c.name === name)?.ask ?? null, w.name ?? ''))
    .toMatchObject({ text: expect.stringContaining('How should the laptop upload'), choices: [{ n: 1, label: 'HTTP POST via helper' }, { n: 2, label: 'WebSocket chunks (as #13)' }] });
  await expect(page.locator('.prompt .prompt-ask')).toHaveText(/^asks · waiting/);
  await expect(page.locator('.prompt .key--answer').first()).toContainText('Answer');
  await page.keyboard.press('2');
  await expect.poll(async () => (await sent(page, 'worker.answer_ask')).length).toBe(1);
  expect((await sent(page, 'worker.answer_ask'))[0]?.args).toEqual({ id: w.id, tool_use_id: 'toolu_e2e_one', answers: [{ question: 0, choices: [2] }] });
  await expect.poll(() => page.evaluate((id) => window.__h3d.needs().some((n) => n.id === id), w.id)).toBe(false);

  // Two questions: the bar says answer at the laptop, and a digit sends nothing.
  await page.evaluate((a) => window.__h3d.simAsk({ id: 'cf1db588-9a66-4307-adfa-1bbe4306c2f3', ask: a }), two);
  await expect(page.locator('.prompt .key--answer')).toContainText('Answer at laptop');
  await page.keyboard.press('1');
  await frames(page, 5);
  expect(await sent(page, 'worker.answer_ask')).toHaveLength(1);

  // Seated in terminal mode: the seat bar says so, T switches to the transcript view with the card.
  expect(await page.evaluate((id) => window.__h3d.sitAt(id), w.id)).toBe(true);
  await frames(page, 10);
  if ((await page.evaluate(() => window.__h3d.seat().mode)) !== 'terminal') await page.keyboard.press('Control+Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.seat().ask ?? null)).toBe('Question Claude is asking a question. T to answer in the transcript view.');
  await page.keyboard.press('t');
  await expect(sheetOf(page).locator('.tx-ask')).toBeVisible(); // #187: the conversation shown, the sheet opens
  await expect(sheetOf(page)).toHaveAttribute('open', '');
  expect(await sent(page, 'worker.keys')).toHaveLength(0); // T never reached the terminal
  // Ctrl+Esc in the sheet: the terminal, the sheet closed (not over the terminal).
  await page.keyboard.press('Control+Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.seat().mode)).toBe('terminal');
  await expect(sheetOf(page)).toBeHidden();
  // Typed into the terminal since: T is a letter again, Ctrl+Esc it says.
  await page.keyboard.press('x');
  await expect.poll(() => page.evaluate(() => window.__h3d.seat().ask ?? null)).toBe('Question Claude is asking a question. CtrlEsc to answer in the transcript view.');
  await page.keyboard.press('Escape');

  // A Codex agent says Codex.
  await page.evaluate((a) => window.__h3d.simAsk({ id: 'e9b53d33-7ac4-48d0-a7cf-9ae394a9fbfc', ask: a }), { ...one, tool_use_id: 'call_e2e', agent: 'codex' });
  expect(await page.evaluate((id) => window.__h3d.face(id), codex.id)).toBe(true);
  expect(await page.evaluate((id) => window.__h3d.sitAt(id), codex.id)).toBe(true);
  await frames(page, 10);
  if ((await page.evaluate(() => window.__h3d.seat().mode)) !== 'terminal') await page.keyboard.press('Control+Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.seat().ask ?? null)).toBe('Question Codex is asking a question. T to answer in the transcript view.');
  await shot(page, 'm16-ask-terminal-bar');
  clean();
});
