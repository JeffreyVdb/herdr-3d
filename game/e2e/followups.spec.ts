import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Worker } from '../src/net/protocol';
import { frames, openGame, seatMode, settingsSection, shot, watchErrors, openMenu } from './game';

// #90: follow-up questions against the fixture bridge (`sim=1`, tools/fixture-followup.ts), whose AI integration
// calls fake Jev and OpenAI-compatible servers started here on OS-leased loopback ports. Set up both models, pass
// the follow-up test, switch it on (ready); then a turn of Pebble's ends with open questions: Pebble needs you, its
// transcript view pins the card, the answers go back as one prompt, echoed in the transcript.

const JEV_KEY = 'jev-test-key-0123456789';
const LLM_KEY = 'sk-test-llm-key-abcdef';
const QUESTIONS =
  'I refactored the session loader and all 42 tests pass.\n\n## Open questions for you\n- Does the legacy importer still need the v1 format?\n- Do you want to ship this already, or wait for the e2e-live run?';
const EXTRACTED = {
  questions: [
    { question: 'Does the legacy importer still need the v1 format?', kind: 'yes_no' },
    { question: 'Ship this already, or wait for the e2e-live run?', kind: 'choice', options: ['Ship now', 'Wait for e2e-live'] },
  ],
};

// A turn whose LLM answer has all three kinds, and one whose answer is not JSON (the fallback).
const THREE_MARK = 'three kinds';
const THREE = `Moved the loader over (${THREE_MARK}).\n\n## Open questions for you\n- Does the legacy importer still need the v1 format?\n- Ship now or wait for the e2e-live run?\n- What should the new flag be called?`;
const EXTRACTED_THREE = {
  questions: [...EXTRACTED.questions, { question: 'What should the new flag be called?', kind: 'open' }],
};
// #60: followups.test's grill round, as a model listed it (internal/followup/testdata: a live answer).
const GRILL_MARK = 'Hire params captured at creation';
const GRILL_LLM = readFileSync(resolve(import.meta.dirname, '../../internal/followup/testdata/grill-round2-llm.json'), 'utf8');
const FALLBACK_MARK = 'cannot be parsed';
const FALLBACK = `The importer change is in, but its answer ${FALLBACK_MARK}.\n\nShould I keep the v1 reader around for another release, or drop it now?`;

interface Fake {
  url: string;
  close(): Promise<void>;
}

function listen(server: Server): Promise<Fake> {
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      done({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => (server.closeAllConnections(), server.close(() => r()))) });
    });
  });
}

function body(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((done) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => done(b));
  });
}

/** Jev: a message that asks something (a question mark) scores high, anything else low. */
function fakeJev(): Promise<Fake> {
  return listen(
    createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== `Bearer ${JEV_KEY}`) return void res.writeHead(401).end('{"error":"unauthorized"}');
      if (req.url === '/v1/models') return void res.end('{"models":[{"name":"jev-latest","description":"Newest"}]}');
      void body(req).then((b) => {
        const state = (JSON.parse(b) as { state?: Record<string, string> }).state ?? {};
        const text = state.last_agent_message ?? state.message ?? '';
        res.end(JSON.stringify({ answers: { question: { noul: text.includes('?') ? 0.96 : 0.02 } } }));
      });
    }),
  );
}

/** An OpenAI-compatible endpoint (JSON mode): the AI test's object, else the questions. */
function fakeOpenAI(): Promise<Fake> {
  return listen(
    createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== `Bearer ${LLM_KEY}`) return void res.writeHead(401).end('{"error":{"message":"bad key"}}');
      if (req.url === '/v1/models') return void res.end('{"object":"list","data":[{"id":"mimo-v2.6-flash"}]}');
      if (req.url !== '/v1/chat/completions') return void res.writeHead(404).end('{}');
      void body(req).then((b) => {
        const content = b.includes('Reply with exactly this JSON')
          ? '{"ok": true}'
          : b.includes(GRILL_MARK)
            ? GRILL_LLM
            : b.includes(THREE_MARK)
            ? JSON.stringify(EXTRACTED_THREE)
            : b.includes(FALLBACK_MARK)
              ? '{"questions": ['
              : JSON.stringify(EXTRACTED);
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    }),
  );
}

function demoWorker(name: string): Worker {
  const snap = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/demo-m5.jsonl'), 'utf8').split('\n')[0] ?? '{}') as { world: { workers: Worker[] } };
  const w = snap.world.workers.find((x) => x.name === name);
  if (!w) throw new Error(`no ${name} in demo-m5`);
  return w;
}

/** Both models set up through the AI integration section, then back to Follow-up questions (#49: one section at a time). */
async function setUpModels(page: Page, dialog: Locator, llm: Fake): Promise<void> {
  await settingsSection(page, 'ai');
  const classifier = dialog.getByRole('group', { name: /Classification model/ });
  await classifier.getByLabel('Key', { exact: true }).fill(JEV_KEY);
  await classifier.getByRole('button', { name: 'Load models' }).click();
  await expect(classifier.getByLabel('Model')).toHaveValue('jev-latest');
  await classifier.getByRole('button', { name: 'Test' }).click();
  await expect(classifier).toContainText('Test passed');
  await classifier.getByRole('button', { name: 'Save' }).click();
  await expect(classifier.locator('.settings-badge')).toHaveText('Ready');
  const box = dialog.getByRole('group', { name: /^LLM/ });
  await box.getByLabel('Base URL').fill(`${llm.url}/v1`);
  await box.getByLabel('API key').fill(LLM_KEY);
  await box.getByLabel('Model').fill('mimo-v2.6-flash');
  await box.getByRole('button', { name: 'Test' }).click();
  await expect(box).toContainText('Test passed');
  await box.getByRole('button', { name: 'Save' }).click();
  await expect(box.locator('.settings-badge')).toHaveText('Ready');
  await settingsSection(page, 'followups');
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

const sent = (page: Page, t: string) => page.evaluate((x) => window.__h3d.sent().filter((c) => c.t === x), t);

test('switched on after a passing test, a turn ending in questions needs you and is answered from the transcript view', async ({ page }) => {
  const clean = watchErrors(page);
  const [jev, llm] = [await fakeJev(), await fakeOpenAI()];
  try {
    await openGame(page, 'demo-m5', '', `play=none&sim=1&simms=300&simusage=0&simecho=200&simjev=${encodeURIComponent(jev.url)}`);
    await openMenu(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    const section = await settingsSection(page, 'followups');
    await expect(section.getByRole('heading', { name: 'Follow-up questions', level: 3 })).toBeVisible();
    await expect(section.locator('.settings-store')).toHaveText('Bridge');
    // Configuring nothing yet: off, and it cannot be switched on.
    const toggle = section.getByRole('checkbox', { name: 'Detect follow-up questions' });
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toBeDisabled();
    await expect(section.getByRole('button', { name: 'Set up in AI integration' })).toBeVisible();
    // The privacy note sits above the switch.
    const [note, sw] = await Promise.all([section.locator('.settings-fu-privacy').boundingBox(), toggle.boundingBox()]);
    expect(note && sw && note.y + note.height <= sw.y).toBe(true);

    await setUpModels(page, dialog, llm);
    // The models alone switch nothing on, and still no test passed.
    await expect(section.locator('.settings-fu-role .settings-badge')).toHaveText(['Ready', 'Ready']);
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toBeDisabled();
    expect(await sent(page, 'followups.set')).toHaveLength(0);

    await section.getByRole('button', { name: 'Test' }).click();
    await expect(section).toContainText('Test passed');
    await expect(section.locator('.settings-fu-samples')).toContainText('0.96');
    await expect(section.locator('.settings-fu-samples')).toContainText('0.02');
    await expect(section.locator('.settings-fu-questions li')).toHaveCount(2);
    await expect(toggle).toBeEnabled();
    await toggle.check();
    await expect(section).toContainText('On: each agent’s final message is checked');
    await expect(toggle).toBeChecked();
    await section.scrollIntoViewIfNeeded();
    await shot(page, 'settings-followups');
    expect(await page.evaluate(() => window.__h3d.followups())).toMatchObject({ enabled: true, state: 'ready', tested: true });
    await page.keyboard.press('Escape');

    // A turn of Pebble's (idle) ends with open questions.
    const w = demoWorker('Pebble');
    await sitAtTranscript(page, w);
    const tx = page.locator('.seat-transcript .tx');
    const turn = await page.evaluate((a) => window.__h3d.simTurn(a), { id: w.id, text: QUESTIONS });
    expect(turn).toMatchObject({ ok: true, data: { flagged: true } });
    const card = tx.locator('.tx-fu');
    await expect(card).toBeVisible();
    await expect(card.locator('.tx-fu-auto')).toHaveText('Detected automatically');
    await expect.poll(() => page.evaluate((id) => window.__h3d.needs().some((n) => n.id === id && n.reason === 'blocked'), w.id)).toBe(true);
    // Above the prompt box, which stays on.
    const [cb, pb] = await Promise.all([card.boundingBox(), tx.locator('.tx-prompt').boundingBox()]);
    expect(cb && pb && cb.y + cb.height <= pb.y + 1).toBe(true);
    await expect(tx.locator('.tx-input')).toBeEnabled();
    // Stacked: question 1 open, question 2 folded under it.
    await expect(card.locator('.tx-ask-q .tx-ask-chip')).toHaveText('Question 1');
    await expect(card.locator('.tx-ask-row .tx-ask-row-text')).toHaveText(['Ship this already, or wait for the e2e-live run?']);
    await expect(card.locator('.tx-ask-question')).toHaveText('Does the legacy importer still need the v1 format?');
    await shot(page, 'followup-card');
    await tx.locator('.tx-scroll').focus(); // the bare screenshot hides the HUD, and that drops the focus

    // No, then (it moves on) the Enter after the click: picks nothing, sends nothing (the question says how to pick).
    await card.getByRole('radio', { name: 'No' }).click();
    await expect(card.locator('.tx-ask-question')).toHaveText('Ship this already, or wait for the e2e-live run?');
    await expect(card.locator('.tx-ask-q')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(card.locator('.tx-ask-nudge.is-loud')).toBeVisible();
    await expect(card.getByRole('button', { name: /^Send 1 of 2/ })).toBeVisible();
    expect(await sent(page, 'worker.answer_followup')).toHaveLength(0);
    // Wait for e2e-live, then Send answers.
    await card.getByRole('radio', { name: 'Wait for e2e-live' }).click();
    await expect(card.locator('.tx-ask-hint-text')).toHaveText('All answered: Enter on Send');
    await expect(card.locator('.tx-ask-send')).toBeFocused();
    await card.getByRole('button', { name: 'Send answers' }).click();
    await expect(card).toBeHidden();
    const answers = await sent(page, 'worker.answer_followup');
    expect(answers).toHaveLength(1);
    expect(await sent(page, 'worker.prompt')).toHaveLength(0);
    // The prompt is echoed in the transcript as the agent took it.
    const echoed = tx.locator('.tx-item').filter({ hasText: 'Answers to your open questions:' });
    await expect(echoed).toBeVisible();
    // (Its markdown makes the numbered answers a list.)
    await expect(echoed.locator('ol > li')).toHaveText(['Does the legacy importer still need the v1 format? → No', 'Ship this already, or wait for the e2e-live run? → Wait for e2e-live']);
    await expect.poll(() => page.evaluate((id) => window.__h3d.needs().some((n) => n.id === id && n.reason === 'blocked'), w.id)).toBe(false);
  } finally {
    await Promise.all([jev.close(), llm.close()]);
  }
  clean();
});

test('switched off, a turn with questions flags nothing and sends nothing', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', 'play=none&sim=1&simms=300&simusage=0&simjev=http%3A%2F%2F127.0.0.1%3A9');
  const w = demoWorker('Pebble');
  const turn = await page.evaluate((a) => window.__h3d.simTurn(a), { id: w.id, text: QUESTIONS });
  expect(turn).toMatchObject({ ok: true, data: { flagged: false } });
  await frames(page, 5);
  expect(await page.evaluate((id) => window.__h3d.needs().some((n) => n.id === id), w.id)).toBe(false);
  clean();
});

// On a phone (360×800) the laptop's screen is short: the card takes the room the timeline leaves (collapsed to a
// strip while it is up), so its question, options, text and a fallback's message tail are shown and usable, and the
// prompt box stays reachable. In Quiet (navy) and Ubuntu (purple).
test('on a phone the card has room for the question and its answers, and the prompt box stays reachable', async ({ page }) => {
  const clean = watchErrors(page);
  const [jev, llm] = [await fakeJev(), await fakeOpenAI()];
  try {
    await page.setViewportSize({ width: 360, height: 800 });
    await openGame(page, 'demo-m5', '', `play=none&sim=1&simms=300&simusage=0&simecho=200&simjev=${encodeURIComponent(jev.url)}`);
    await openMenu(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    const section = await settingsSection(page, 'followups');
    await setUpModels(page, dialog, llm);
    await section.getByRole('button', { name: 'Test' }).click();
    await expect(section).toContainText('Test passed');
    await section.getByRole('checkbox', { name: 'Detect follow-up questions' }).check();
    await expect(section).toContainText('On: each agent’s final message is checked');
    await page.keyboard.press('Escape');

    const w = demoWorker('Pebble');
    await sitAtTranscript(page, w);
    const tx = page.locator('.seat-transcript .tx');
    const card = tx.locator('.tx-fu');
    const box = async (l: Locator) => {
      const b = await l.boundingBox();
      expect(b, 'laid out').toBeTruthy();
      return b as NonNullable<typeof b>;
    };
    /** Within the card's visible rectangle (it may scroll: then scrolled to first). */
    const shown = async (l: Locator, what: string) => {
      await l.scrollIntoViewIfNeeded();
      const [c, b] = await Promise.all([box(card), box(l)]);
      expect(b.height, `${what} has a height`).toBeGreaterThan(8);
      expect(b.y, `${what} top`).toBeGreaterThanOrEqual(c.y - 0.5);
      expect(b.y + b.height, `${what} bottom`).toBeLessThanOrEqual(c.y + c.height + 0.5);
    };
    const promptReachable = async () => {
      const [c, p] = await Promise.all([box(card), box(tx.locator('.tx-input'))]);
      expect(p.height, 'the prompt box has a line').toBeGreaterThanOrEqual(16);
      expect(p.y, 'the prompt box below the card').toBeGreaterThanOrEqual(c.y + c.height - 1);
      await expect(tx.locator('.tx-input')).toBeEnabled();
    };

    for (const theme of ['Quiet', 'Ubuntu'] as const) {
      await tx.getByRole('radio', { name: theme, exact: true }).click();
      expect(await page.evaluate((a) => window.__h3d.simTurn(a), { id: w.id, text: THREE })).toMatchObject({ ok: true, data: { flagged: true } });
      await expect(card).toBeVisible();
      await expect(card.locator('.tx-ask-row')).toHaveCount(2); // the other two, folded
      const body = await box(card.locator('.tx-ask-body'));
      expect(body.height, 'the body has room for the question and an answer').toBeGreaterThanOrEqual(60);
      await shot(page, `followup-phone-${theme.toLowerCase()}`);
      await shown(card.locator('.tx-ask-question'), 'the question');
      await shown(card.getByRole('radio', { name: 'No' }), 'No');
      await shown(card.locator('.tx-fu-text'), 'the note');
      await shown(card.locator('.tx-ask-send'), 'Send');
      await shown(card.locator('.tx-ask-dismiss'), 'Dismiss');
      await promptReachable();
      // Answer all three with taps and send.
      await card.getByRole('radio', { name: 'No' }).click();
      await expect(card.locator('.tx-ask-question')).toHaveText('Ship this already, or wait for the e2e-live run?');
      await card.getByRole('radio', { name: 'Wait for e2e-live' }).click();
      await expect(card.locator('textarea.tx-fu-text')).toBeVisible();
      await shown(card.locator('textarea.tx-fu-text'), 'the open answer');
      await card.locator('textarea.tx-fu-text').fill('--legacy-v1');
      await shown(card.locator('.tx-ask-send'), 'Send');
      await card.locator('.tx-ask-send').click();
      await expect(card).toBeHidden();
      // The timeline is back once the card is gone.
      expect((await box(tx.locator('.tx-main'))).height).toBeGreaterThan(40);
    }
    expect(await sent(page, 'worker.answer_followup')).toHaveLength(2);

    // The fallback: the message's end and a free answer.
    expect(await page.evaluate((a) => window.__h3d.simTurn(a), { id: w.id, text: FALLBACK })).toMatchObject({ ok: true, data: { flagged: true } });
    await expect(card.locator('.tx-fu-tail')).toBeVisible();
    await shot(page, 'followup-phone-fallback-ubuntu');
    // The tail may be longer than the card: it shows a good part of it, the rest scrolls.
    await card.locator('.tx-fu-tail').scrollIntoViewIfNeeded();
    const [c, tail] = await Promise.all([box(card), box(card.locator('.tx-fu-tail'))]);
    expect(Math.min(c.y + c.height, tail.y + tail.height) - Math.max(c.y, tail.y), 'the message tail shown').toBeGreaterThanOrEqual(36);
    await shown(card.locator('textarea.tx-fu-text'), 'the free answer');
    await shown(card.locator('.tx-ask-send'), 'Send');
    await promptReachable();
    await card.locator('textarea.tx-fu-text').fill('Keep it one more release.');
    await card.locator('.tx-ask-send').click();
    await expect(card).toBeHidden();
  } finally {
    await Promise.all([jev.close(), llm.close()]);
  }
  clean();
});

// #60: a grill round (the incident's ten questions, Q8–Q17, seeded on Pebble by the fixture bridge as the bridge reads
// it: `simfollowup=grill`). Every question keeps its label, context, options and the agent's recommendation; R and
// Use all recommendations only fill answers, an override stays, and one Send sends them paired with their questions.
test('a grill round: each question with its recommendation, accepted or overridden, sent once', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', 'play=none&sim=1&simms=300&simusage=0&simecho=200&simfollowup=grill');
  const w = demoWorker('Pebble');
  await sitAtTranscript(page, w);
  const tx = page.locator('.seat-transcript .tx');
  const card = tx.locator('.tx-fu');
  await expect(card).toBeVisible();
  await expect(card.locator('.tx-ask-tag')).toHaveText('10 open questions');
  await expect(card.locator('.tx-ask-q .tx-ask-chip')).toHaveText('Q8');
  await expect(card.locator('.tx-ask-row .tx-ask-row-head')).toHaveText(['Q9', 'Q10', 'Q11', 'Q12', 'Q13', 'Q14', 'Q15', 'Q16', 'Q17']);
  // Q8: its context rendered (the sub-questions a list, code as code), its recommendation whole.
  await expect(card.locator('.tx-ask-question')).toHaveText('Hire params captured at creation');
  await expect(card.locator('.tx-fu-context li')).toHaveCount(2);
  await expect(card.locator('.tx-fu-context code').first()).toHaveText('worker.hire');
  await expect(card.locator('.tx-fu-rec-text')).toContainText('Desk is picked at fire time, not stored.');
  await expect(card.locator('.tx-fu-progress')).toHaveText('0 of 10 answered');
  await shot(page, 'followup-grill');
  await tx.locator('.tx-scroll').focus();

  // R fills Q8's answer with the recommendation (the keyboard in its text, to edit): nothing is sent.
  await page.keyboard.press('r');
  await expect(card.locator('textarea.tx-fu-text')).toBeFocused();
  await expect(card.locator('textarea.tx-fu-text')).toHaveValue(/^Store the full spec/);
  await expect(card.locator('.tx-fu-rec.is-using .tx-fu-rec-using')).toHaveText('Your answer');
  await expect(card.locator('.tx-fu-progress')).toHaveText('1 of 10 answered');
  // Q9: the recommended option is marked; another one picked overrides it.
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowRight');
  await expect(card.locator('.tx-ask-q .tx-ask-chip')).toHaveText('Q9');
  await expect(card.getByRole('radio', { name: /Per-schedule checkbox/ }).locator('.tx-ask-rec')).toHaveText('Recommended');
  await card.getByRole('radio', { name: /Mark the schedule/ }).click();
  await expect(card.locator('.tx-ask-q .tx-ask-chip')).toHaveText('Q10');
  await expect(card.locator('.tx-ask-hint-text')).toContainText('2 of 10 answered: Q10, Q11, Q12, Q13 and 4 more go as unanswered');
  // Use all: the eight left take theirs; Q9's override stays.
  await card.getByRole('button', { name: 'Use all recommendations' }).click();
  await expect(card.locator('.tx-fu-progress')).toHaveText('10 of 10 answered');
  await expect(card.locator('.tx-ask-note')).toContainText('Filled 8 answers');
  await expect(card.locator('.tx-ask-send')).toBeFocused();
  expect(await sent(page, 'worker.answer_followup')).toHaveLength(0);
  await expect(card.locator('.tx-ask-row').filter({ hasText: 'Q9' }).locator('.tx-ask-row-text')).toHaveText('(b) Mark the schedule failed: floor_asleep and notify.');
  await shot(page, 'followup-grill-filled');
  // Send: one command, the prompt pairs each answer with its question.
  await card.locator('.tx-ask-send').click();
  await expect(card).toBeHidden();
  const answers = await sent(page, 'worker.answer_followup');
  expect(answers).toHaveLength(1);
  const echoed = tx.locator('.tx-item').filter({ hasText: 'Answers to your open questions:' });
  await expect(echoed).toBeVisible();
  await expect(echoed.locator('li').nth(1)).toHaveText('Q9 Asleep floor at fire time → (b) Mark the schedule failed: floor_asleep and notify.');
  await expect(echoed.locator('li').nth(2)).toContainText('Q10 Desks full at fire time → (b) Wait in a waiting_desk state');
  await expect(echoed.locator('li').nth(2)).toContainText('(your recommendation)');
  clean();
});

// #60: the round's fallback (`simfollowup=fallback`: the model ran out of budget). The card says why, shows the whole
// message on request, keeps the free answer typed meanwhile; Retry reads the round and the free answer goes along as a
// note after the answers.
test('a fallback says why, shows the whole message, and a retry keeps what you wrote', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', 'play=none&sim=1&simms=300&simusage=0&simecho=200&simfollowup=fallback');
  const w = demoWorker('Pebble');
  await sitAtTranscript(page, w);
  const tx = page.locator('.seat-transcript .tx');
  const card = tx.locator('.tx-fu');
  await expect(card.locator('.tx-fu-fail-title')).toHaveText('The questions could not be prepared as answers.');
  await expect(card.locator('.tx-fu-fail-why')).toContainText('whole completion budget');
  await expect(card.locator('.tx-fu-tail')).toBeVisible();
  await card.locator('textarea.tx-fu-text').fill('Q9: (a), please.');
  await card.getByRole('button', { name: 'Show the whole message' }).click();
  await expect(card.locator('.tx-fu-msg-text')).toContainText('Round 2.');
  await expect(card.locator('.tx-fu-msg-text strong').first()).toHaveText('Q8');
  await expect(card.locator('.tx-fu-tail')).toHaveCount(0);
  await shot(page, 'followup-fallback');
  await card.getByRole('button', { name: 'Retry' }).click();
  await expect(card.locator('.tx-ask-tag')).toHaveText('10 open questions');
  expect(await sent(page, 'worker.retry_followup')).toHaveLength(1);
  // The free answer survived the retry: it goes after the answers.
  await expect(card.locator('textarea.tx-fu-note')).toHaveValue('Q9: (a), please.');
  await expect(card.locator('.tx-ask-send')).toHaveText(/Send your reply/);
  await card.locator('.tx-ask-send').click();
  await expect(card).toBeHidden();
  const [a] = await sent(page, 'worker.answer_followup');
  expect((a as { args: { note?: string; answers: unknown[] } }).args).toMatchObject({ note: 'Q9: (a), please.', answers: [] });
  clean();
});

// #60 on a phone (360×800), in Quiet and Ubuntu (the transcript's theme, picked before sitting: the card hides the bar):
// a grill question's context, recommendation and Send are reachable, Use recommendation fills it, and a reload keeps it.
test('on a phone a grill round’s question, recommendation and Send are reachable', async ({ page }) => {
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 360, height: 800 });
  for (const theme of ['quiet', 'ubuntu'] as const) {
    await page.addInitScript((t) => {
      try {
        localStorage.setItem('h3d.theme.transcript', t);
      } catch {
        /* blocked: the default theme */
      }
    }, theme);
    await openGame(page, 'demo-m5', '', 'play=none&sim=1&simms=300&simusage=0&simfollowup=grill');
    await sitAtTranscript(page, demoWorker('Pebble'));
    const card = page.locator('.seat-transcript .tx .tx-fu');
    await expect(card).toBeVisible();
    await card.locator('.tx-ask-row').filter({ hasText: 'Q9' }).click();
    await expect(card.locator('.tx-ask-q .tx-ask-chip')).toHaveText('Q9');
    await shot(page, `followup-grill-phone-${theme}`);
    // The second time (a reload) the answer the first one filled is still there: the draft is kept.
    const use = theme === 'quiet' ? card.getByRole('button', { name: /Use recommendation/ }) : card.locator('.tx-fu-rec-using');
    for (const l of [card.locator('.tx-ask-question'), card.locator('.tx-fu-rec'), use, card.locator('.tx-ask-send')]) {
      await l.scrollIntoViewIfNeeded();
      await expect(l).toBeInViewport();
    }
    if (theme === 'quiet') await use.click();
    await expect(card.locator('.tx-fu-progress')).toHaveText('1 of 10 answered');
  }
  clean();
});
