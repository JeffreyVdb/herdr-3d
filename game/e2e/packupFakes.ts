import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, type Locator, type Page } from '@playwright/test';
import { openMenu, settingsSection } from './game';
import { packupParts, packupScore } from '../tools/fixture-ai-responses.ts';

// #110 pack up on request's fakes for the fixture bridge (`sim=1`, tools/fixture-packup.ts): Jev and an OpenAI-compatible
// LLM on OS-leased loopback ports (no spec reaches a real provider), and the Settings steps that switch pack up on.
// Shared by m110-packup.spec.ts and (#108) h108-prompt-secrets.spec.ts.

export const JEV_KEY = 'jev-test-key-0123456789';
export const LLM_KEY = 'sk-test-llm-key-abcdef';
export const CLEANUP = 'Once that is done: Stop every server, background process, pane and freelancer you started in this session. Don’t touch anything else.';
const PACKUP_TIME = new Date('2026-09-30T12:00:00Z');

/** Install before navigation: Date is fixed, while timers and rendering keep running normally. */
export async function setUpPackupClock(page: Page): Promise<void> {
  await page.clock.setFixedTime(PACKUP_TIME);
}

/**
 * Positive UI checks exercise the model result and confirm, independent of browser callback scheduling under load.
 * Invoke an already checked button with evaluate(click), or press Enter: locator.click() needs animation frames.
 * The real clock resumes before any explicit slow-provider or late-ack deadline assertion.
 */
export async function withPositivePackup(page: Page, submit: () => Promise<void>): Promise<void> {
  const before = await page.evaluate(() => window.__h3d.sent().filter((c) => c.t === 'packup.detect').length);
  await page.clock.pauseAt(PACKUP_TIME);
  try {
    await submit();
    await expect.poll(async () => JSON.stringify(await page.evaluate((n) => window.__h3d.sent().filter((c) => c.t === 'packup.detect')[n]?.result ?? null, before)),
      { message: 'the positive pack-up check receives its actual matching result', timeout: 20_000 }).toMatch(/"ok":true.*"matched":true/);
    await expect.poll(() => page.evaluate(() => {
      const d = window.__h3d.dialog();
      return d?.kind === 'send-home' ? d.state : null;
    }), { message: 'the positive pack-up confirmation is ready', timeout: 20_000 }).toBe('ready');
    await expect(page.locator('dialog.desk-dlg--home')).toBeVisible();
  } finally {
    await page.clock.resume();
  }
}

export interface Fake {
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

/** Jev: a prompt that says to leave scores high, anything else low; one that says SLOW answers after 2.5 s. */
export function fakeJev(): Promise<Fake> {
  return listen(
    createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== `Bearer ${JEV_KEY}`) return void res.writeHead(401).end('{"error":"unauthorized"}');
      if (req.url === '/v1/models') return void res.end('{"models":[{"name":"jev-latest","description":"Newest"}]}');
      void body(req).then((b) => {
        const state = (JSON.parse(b) as { state?: Record<string, string> }).state ?? {};
        const text = state.prompt ?? state.message ?? '';
        const answer = () => res.end(JSON.stringify({ answers: { question: { noul: packupScore(text) } } }));
        if (text.includes('SLOW')) setTimeout(answer, 2500);
        else answer();
      });
    }),
  );
}

/** An OpenAI-compatible endpoint (JSON mode): the AI test's object, else the parts to cut. */
export function fakeOpenAI(): Promise<Fake> {
  return listen(
    createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== `Bearer ${LLM_KEY}`) return void res.writeHead(401).end('{"error":{"message":"bad key"}}');
      if (req.url === '/v1/models') return void res.end('{"object":"list","data":[{"id":"mimo-v2.6-flash"}]}');
      if (req.url !== '/v1/chat/completions') return void res.writeHead(404).end('{}');
      void body(req).then((b) => {
        let content = '{"ok": true}';
        if (!b.includes('Reply with exactly this JSON')) {
          const msgs = (JSON.parse(b) as { messages: Array<{ content: string }> }).messages;
          const prompt = (msgs.at(-1)?.content ?? '').replace(/^The prompt:\n\n/, '');
          content = JSON.stringify({ remove: packupParts(prompt) });
        }
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    }),
  );
}

/** Both models set up through the AI integration section, then back to Pack up on request (#49: one section at a time). */
export async function setUpModels(page: Page, dialog: Locator, llm: Fake): Promise<void> {
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
  await settingsSection(page, 'packup');
}

/** Settings: the models, the pack-up test, the switch on. Returns the section. */
export async function switchOn(page: Page, llm: Fake): Promise<Locator> {
  await openMenu(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const section = dialog.locator('[data-section="packup"]');
  await setUpModels(page, dialog, llm);
  await section.getByRole('button', { name: 'Test' }).click();
  await expect(section).toContainText('Test passed');
  await section.getByRole('checkbox', { name: 'Pack up on request' }).check();
  await expect(section).toContainText('On: each prompt is checked');
  return section;
}
