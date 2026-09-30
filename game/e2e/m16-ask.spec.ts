import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Ask, Worker } from '../src/net/protocol';
import { frames, openGame, shot, watchErrors } from './game';

// #57: an agent's structured question (Claude's AskUserQuestion, Codex's request_user_input) on demo-m5 with sim=1.
// The simulator's `sim.ask` plays the bridge reading it from the transcript: the worker (idle, as herdr calls a
// hire's question) needs you; at its laptop the transcript view pins a card above the prompt box, answered with the
// keyboard or clicks; where you stand a one-pick question takes a digit; the terminal says T answers it.

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

async function sitAtTranscript(page: Page, w: Worker): Promise<void> {
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.face(id), w.id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.sitAt(id), w.id)).toBe(true);
  await frames(page, 20);
  await page.keyboard.press('Control+Escape');
  await expect(page.locator('.seat-transcript .tx .tx-scroll')).toBeFocused();
  await expect.poll(() => page.evaluate(async () => (await window.__h3d.simTranscripts())?.watches ?? 0)).toBeGreaterThan(0);
}

test('a two-question ask: needs you while herdr says idle, a pinned card, answered from the keyboard, recorded in the timeline', async ({ page }) => {
  const clean = watchErrors(page);
  const w = demoWorker('Pebble'); // idle: herdr never said blocked
  await openGame(page, 'demo-m5', '', SIM);
  await sitAtTranscript(page, w);
  const tx = page.locator('.seat-transcript .tx');

  expect((await page.evaluate(() => window.__h3d.simAsk({ id: 'cf1db588-9a66-4307-adfa-1bbe4306c2f3', ask: null }))).ok).toBe(true); // nothing to end: fine
  await page.evaluate((a) => window.__h3d.simAsk({ id: 'cf1db588-9a66-4307-adfa-1bbe4306c2f3', ask: a }), two);
  const card = tx.locator('.tx-ask');
  await expect(card).toBeVisible();
  // It needs you (N's queue, the look of its card), idle or not.
  await expect.poll(() => page.evaluate((id) => window.__h3d.needs().some((n) => n.id === id && n.reason === 'blocked'), w.id)).toBe(true);
  // Pinned above the prompt box, which is off; the timeline has the call, waiting.
  const [cb, pb] = await Promise.all([card.boundingBox(), tx.locator('.tx-prompt').boundingBox()]);
  expect(cb && pb && cb.y + cb.height <= pb.y + 1).toBe(true);
  await expect(tx.locator('.tx-input')).toBeDisabled();
  await expect(tx.locator('.tx-ask-item[data-outcome="pending"]')).toContainText('Which extras should be enabled?');
  await expect(tx.locator('.tx-ask-item .tx-ask-input > summary')).toHaveText('Input');
  // Tabs for the two questions, checkboxes for the multi-select one, Send off until both are answered.
  await expect(card.locator('.tx-ask-tab')).toHaveText(['1Extras', '2Color']);
  await expect(card.locator('.tx-ask-opts')).toHaveClass(/is-multi/);
  await expect(card.locator('[role="checkbox"]')).toHaveCount(3);
  await expect(card.locator('.tx-ask-send')).toBeDisabled();
  await expect(card.locator('.tx-ask-wait')).toHaveText(/^waiting \d+s$/);
  await shot(page, 'm16-ask-card');
  await tx.locator('.tx-scroll').focus(); // the bare screenshot hides the HUD, and that drops the focus

  // No click: 1 and 3 tick Logs and Traces, 4 goes to Other; Esc there leaves it (the timeline has the keys again).
  await page.keyboard.press('1');
  await page.keyboard.press('3');
  await expect(card.locator('[role="checkbox"][aria-checked="true"]')).toHaveCount(2);
  await page.keyboard.press('4');
  await expect(card.locator('.tx-ask-other-input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(tx.locator('.tx-scroll')).toBeFocused();
  expect(await page.evaluate(() => window.__h3d.seated())).not.toBeNull(); // Esc in the card does not stand you up
  await page.keyboard.press('4');
  await page.keyboard.type('Custom dashboards');
  // Enter with a question unanswered goes to it; Tab moves between them.
  await page.keyboard.press('Enter');
  await expect(card.locator('.tx-ask-tab.is-active')).toContainText('Color');
  await expect(card.locator('.tx-ask-rec')).toHaveText('recommended');
  await expect(card.locator('.tx-ask-opt-label').first()).toContainText('Red');
  await expect(card.locator('[role="radio"]')).toHaveCount(2);
  await page.keyboard.press('Tab');
  await expect(card.locator('.tx-ask-tab.is-active')).toContainText('Extras');
  await expect(card.locator('.tx-ask-other-input')).toHaveValue('Custom dashboards');
  await page.keyboard.press('ArrowRight');
  await expect(card.locator('.tx-ask-tab.is-active')).toContainText('Color');
  await page.keyboard.press('3');
  await page.keyboard.type('Green');
  await expect(card.locator('.tx-ask-send')).toBeEnabled();
  expect(await sent(page, 'worker.answer_ask')).toHaveLength(0);
  await shot(page, 'm16-ask-card-filled');
  await tx.locator('.tx-scroll').focus(); // the screenshot dropped the focus again

  // On the card itself: Tab focuses the other question's option; Esc there goes back to the timeline, seated.
  await page.keyboard.press('Tab');
  await expect(card.locator('.tx-ask-tab.is-active')).toContainText('Extras');
  await expect(card.locator('button.tx-ask-opt[data-n="1"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(tx.locator('.tx-scroll')).toBeFocused();
  expect(await page.evaluate(() => window.__h3d.seated())).not.toBeNull();
  // Tab, Tab (an option focused), a digit, Enter: sent from there.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(card.locator('.tx-ask-tab.is-active')).toContainText('Extras');
  await expect(card.locator('button.tx-ask-opt[data-n="1"]')).toBeFocused();
  await page.keyboard.press('2');
  await expect(card.locator('[role="checkbox"][aria-checked="true"]')).toHaveCount(3);
  expect(await sent(page, 'worker.answer_ask')).toHaveLength(0);
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

test('a stale answer is refused and the card updates; answered in the terminal, the timeline shows it', async ({ page }) => {
  const clean = watchErrors(page);
  const w = demoWorker('Pebble');
  await openGame(page, 'demo-m5', '', SIM);
  await sitAtTranscript(page, w);
  const tx = page.locator('.seat-transcript .tx');
  const card = tx.locator('.tx-ask');
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

test('another question while an answer is sent: the old ack leaves it pinned, the prompt stays off', async ({ page }) => {
  const clean = watchErrors(page);
  const w = demoWorker('Pebble');
  await openGame(page, 'demo-m5', '', 'play=none&sim=1&simms=1500&simusage=0'); // slow acks: the new ask comes first
  await sitAtTranscript(page, w);
  const tx = page.locator('.seat-transcript .tx');
  const card = tx.locator('.tx-ask');
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
  await expect(page.locator('.seat-transcript .tx .tx-ask')).toBeVisible();
  expect(await sent(page, 'worker.keys')).toHaveLength(0); // T never reached the terminal
  await page.keyboard.press('Control+Escape');
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
