import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Worker } from '../src/net/protocol';
import { frames, openGame, seatMode, shot, watchErrors } from './game';

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

/** Both models set up through the AI integration section. */
async function setUpModels(dialog: Locator, llm: Fake): Promise<void> {
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
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    const section = dialog.locator('[data-section="followups"]');
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

    await setUpModels(dialog, llm);
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
// prompt box stays reachable. In Quiet (dark) and Paper (light).
test('on a phone the card has room for the question and its answers, and the prompt box stays reachable', async ({ page }) => {
  const clean = watchErrors(page);
  const [jev, llm] = [await fakeJev(), await fakeOpenAI()];
  try {
    await page.setViewportSize({ width: 360, height: 800 });
    await openGame(page, 'demo-m5', '', `play=none&sim=1&simms=300&simusage=0&simecho=200&simjev=${encodeURIComponent(jev.url)}`);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    const section = dialog.locator('[data-section="followups"]');
    await setUpModels(dialog, llm);
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

    for (const theme of ['Quiet', 'Paper'] as const) {
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
    await shot(page, 'followup-phone-fallback-paper');
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
