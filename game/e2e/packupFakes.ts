import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, type Locator, type Page } from '@playwright/test';
import { openMenu, settingsSection } from './game';

// #110 pack up on request's fakes for the fixture bridge (`sim=1`, tools/fixture-packup.ts): Jev and an OpenAI-compatible
// LLM on OS-leased loopback ports (no spec reaches a real provider), and the Settings steps that switch pack up on.
// Shared by m110-packup.spec.ts and (#108) h108-prompt-secrets.spec.ts.

export const JEV_KEY = 'jev-test-key-0123456789';
export const LLM_KEY = 'sk-test-llm-key-abcdef';
export const CLEANUP = 'Once that is done: Stop every server, background process, pane and freelancer you started in this session. Don’t touch anything else.';

/** The leaving parts the fake LLM cuts, by what the prompt says. "TAMPER" gets a span that is not in it. */
const CUTS: Array<[RegExp, (p: string) => string]> = [
  [/TAMPER/, () => ' and finish your day'],
  [/^Go home and clean up/, (p) => p],
  [/ and end your turn$/, () => ' and end your turn'],
  [/ and stop working$/, () => ' and stop working'],
  [/, leave the office and clean up the worktree$/, () => ', leave the office and clean up the worktree'],
  [/, then go home\.?$/, () => ', then go home'],
];
const LEAVES = /end your turn|stop working|leave the office|go home|Go home|finish the day/;

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
        const answer = () => res.end(JSON.stringify({ answers: { question: { noul: LEAVES.test(text) ? 0.97 : 0.03 } } }));
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
          const cut = CUTS.find(([re]) => re.test(prompt));
          content = JSON.stringify({ remove: cut ? [cut[1](prompt)] : [] });
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
