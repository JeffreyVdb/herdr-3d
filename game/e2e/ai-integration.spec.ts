import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { openGame, shot, watchErrors } from './game';

// #92: the "AI integration" section of Settings, against the fixture bridge (`sim=1`, tools/fixture-ai.ts) which calls
// fake Jev and OpenAI-compatible servers started here on OS-leased loopback ports. Keys are typed once, sent to the
// bridge and never shown again; Save only follows a passing Test.

const JEV_KEY = 'jev-test-key-0123456789';
const LLM_KEY = 'sk-test-llm-key-abcdef';

interface Fake {
  url: string;
  close(): Promise<void>;
}

function listen(server: Server): Promise<Fake> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => (server.closeAllConnections(), server.close(() => r()))) });
    });
  });
}

/** Jev: Bearer key, GET /v1/models, POST /v1/systemone. */
function fakeJev(): Promise<Fake> {
  return listen(
    createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== `Bearer ${JEV_KEY}`) return void res.writeHead(401).end('{"error":"unauthorized"}');
      if (req.url === '/v1/models') return void res.end('{"models":[{"name":"jev-latest","description":"Newest"},{"name":"jev-preview","description":"Preview"}]}');
      req.resume();
      req.on('end', () => res.end('{"answers":{"question":{"noul":0.97}}}'));
    }),
  );
}

/** An OpenAI-compatible endpoint that lives under /v1 (the base URL typed in the panel has no /v1) and takes no response_format. */
function fakeOpenAI(): Promise<Fake> {
  return listen(
    createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== `Bearer ${LLM_KEY}`) return void res.writeHead(401).end('{"error":{"message":"bad key"}}');
      if (req.url === '/v1/models') return void res.end('{"object":"list","data":[{"id":"mimo-v2.6-flash"},{"id":"mimo-v2.6-pro"}]}');
      if (req.url === '/v1/chat/completions') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          if (body.includes('response_format')) return void res.writeHead(400).end('{"error":{"message":"response_format is not supported"}}');
          res.end('{"choices":[{"message":{"content":"{\\"ok\\": true}"}}]}');
        });
        return;
      }
      res.writeHead(404).end('{}');
    }),
  );
}

async function setup(page: Page, jev: Fake): Promise<{ dialog: Locator; classifier: Locator; llm: Locator }> {
  await openGame(page, 'demo', '', `play=none&sim=1&simms=150&simjev=${encodeURIComponent(jev.url)}`);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  return { dialog, classifier: dialog.getByRole('group', { name: /Classification model/ }), llm: dialog.getByRole('group', { name: /^LLM/ }) };
}

test('configure both models through the panel: each is ready, the bridge keeps the keys', async ({ page }) => {
  const clean = watchErrors(page);
  const [jev, llm] = [await fakeJev(), await fakeOpenAI()];
  try {
    const { dialog, classifier, llm: llmBox } = await setup(page, jev);
    const section = dialog.locator('[data-section="ai"]');
    await expect(section.getByRole('heading', { name: 'AI integration', level: 3 })).toBeVisible();
    await expect(section.locator('.settings-store')).toHaveText('Bridge');
    await expect(classifier.locator('.settings-badge')).toHaveText('Not set up');
    await expect(page.locator('.ai-chip')).toBeHidden();

    // Classification model: key, load models (jev-latest preselected), test, save.
    const key = classifier.getByLabel('Key', { exact: true });
    await expect(key).toHaveAttribute('type', 'password');
    await classifier.getByLabel('Key', { exact: true }).fill(JEV_KEY);
    await classifier.getByRole('button', { name: 'Load models' }).click();
    await expect(classifier.getByLabel('Model')).toHaveValue('jev-latest');
    await expect(classifier.getByRole('button', { name: 'Save' })).toBeDisabled();
    await classifier.getByRole('button', { name: 'Test' }).click();
    await expect(classifier).toContainText('Test passed');
    await classifier.getByRole('button', { name: 'Save' }).click();
    await expect(classifier.locator('.settings-badge')).toHaveText('Ready');
    await expect(key).toHaveValue('');
    await expect(classifier).toContainText('ending in 6789');

    // LLM: the base URL has no /v1, the bridge finds it; the endpoint has no JSON mode, the test finds that out.
    await llmBox.getByLabel('Base URL').fill(llm.url);
    await llmBox.getByLabel('API key').fill(LLM_KEY);
    await llmBox.getByRole('button', { name: 'Load models' }).click();
    await expect(llmBox.getByLabel('Base URL')).toHaveValue(`${llm.url}/v1`);
    await llmBox.getByLabel('Model').fill('mimo-v2.6-flash');
    await llmBox.getByRole('button', { name: 'Test' }).click();
    await expect(llmBox).toContainText('ignores JSON mode');
    await llmBox.getByRole('button', { name: 'Save' }).click();
    await expect(llmBox.locator('.settings-badge')).toHaveText('Ready');
    await expect(page.locator('.ai-chip')).toBeHidden();
    await shot(page, 'settings-ai');

    // Close and reopen: what the bridge holds is shown, with no key in any field or in the page.
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(llmBox.getByLabel('Model')).toHaveValue('mimo-v2.6-flash');
    await expect(llmBox).toContainText('ending in cdef');
    const everything = await page.evaluate(() => document.documentElement.outerHTML + [...document.querySelectorAll('input,textarea')].map((e) => (e as HTMLInputElement).value).join('|'));
    expect(everything).not.toContain(JEV_KEY);
    expect(everything).not.toContain(LLM_KEY);
    // The game's command log (what __h3d.sent() exposes) never held a typed key either.
    const log = await page.evaluate(() => window.__h3d.sent());
    expect(log.filter((c) => c.t.startsWith('ai.')).length).toBeGreaterThan(4);
    expect(JSON.stringify(log)).not.toContain(JEV_KEY);
    expect(JSON.stringify(log)).not.toContain(LLM_KEY);
  } finally {
    await Promise.all([jev.close(), llm.close()]);
  }
  clean();
});

test('Test before Load models: a bare base URL is resolved by the Test and the result can be saved', async ({ page }) => {
  const clean = watchErrors(page);
  const [jev, llm] = [await fakeJev(), await fakeOpenAI()];
  try {
    const { llm: llmBox } = await setup(page, jev);
    await llmBox.getByLabel('Base URL').fill(llm.url);
    await llmBox.getByLabel('API key').fill(LLM_KEY);
    await llmBox.getByLabel('Model').fill('mimo-v2.6-flash');
    await llmBox.getByRole('button', { name: 'Test' }).click();
    await expect(llmBox).toContainText('Test passed');
    await expect(llmBox.getByLabel('Base URL')).toHaveValue(`${llm.url}/v1`);
    await expect(llmBox.getByRole('button', { name: 'Save' })).toBeEnabled();
    await llmBox.getByRole('button', { name: 'Save' }).click();
    await expect(llmBox.locator('.settings-badge')).toHaveText('Ready');
    await expect(llmBox.getByLabel('Base URL')).toHaveValue(`${llm.url}/v1`);
  } finally {
    await Promise.all([jev.close(), llm.close()]);
  }
  clean();
});

test('a bad key says “Key rejected” for the model list and the test, and nothing can be saved', async ({ page }) => {
  const clean = watchErrors(page);
  const [jev, llm] = [await fakeJev(), await fakeOpenAI()];
  try {
    const { classifier, llm: llmBox } = await setup(page, jev);
    await classifier.getByLabel('Key', { exact: true }).fill('not-the-right-key-1234');
    await classifier.getByRole('button', { name: 'Load models' }).click();
    await expect(classifier).toContainText('Key rejected');
    await expect(classifier.getByRole('button', { name: 'Save' })).toBeDisabled();

    await llmBox.getByLabel('Base URL').fill(`${llm.url}/v1`);
    await llmBox.getByLabel('API key').fill('sk-wrong-wrong-wrong');
    await llmBox.getByLabel('Model').fill('mimo-v2.6-flash');
    await llmBox.getByRole('button', { name: 'Test' }).click();
    await expect(llmBox).toContainText('Key rejected');
    await expect(llmBox.getByRole('button', { name: 'Save' })).toBeDisabled();
    await expect(llmBox.locator('.settings-badge')).toHaveText('Not set up');
  } finally {
    await Promise.all([jev.close(), llm.close()]);
  }
  clean();
});

test('a call that gets the key rejected pauses the model: toast, chip, Paused in the panel', async ({ page }) => {
  const clean = watchErrors(page);
  const [jev, llm] = [await fakeJev(), await fakeOpenAI()];
  try {
    const { dialog, classifier } = await setup(page, jev);
    await classifier.getByLabel('Key', { exact: true }).fill(JEV_KEY);
    await classifier.getByRole('button', { name: 'Load models' }).click();
    await classifier.getByRole('button', { name: 'Test' }).click();
    await classifier.getByRole('button', { name: 'Save' }).click();
    await expect(classifier.locator('.settings-badge')).toHaveText('Ready');
    await page.keyboard.press('Escape');
    await expect(page.locator('.ai-chip')).toBeHidden();

    await page.evaluate(() => window.__h3d.simAi({ reject: 'classifier' }));
    await expect(page.locator('.toast')).toHaveText('AI integration paused: classification key rejected');
    const chip = page.locator('.ai-chip');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('AI paused');
    await shot(page, 'ai-paused');
    await chip.click();
    await expect(dialog).toBeVisible();
    await expect(classifier.locator('.settings-badge')).toHaveText('Paused');
    await expect(classifier).toContainText('Key rejected');
  } finally {
    await Promise.all([jev.close(), llm.close()]);
  }
  clean();
});

test('the AI section fits a narrow screen and the dialog scrolls to the LLM', async ({ page }) => {
  const clean = watchErrors(page);
  const jev = await fakeJev();
  try {
    await page.setViewportSize({ width: 360, height: 640 });
    const { dialog, llm } = await setup(page, jev);
    await llm.scrollIntoViewIfNeeded();
    const b = (await dialog.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(360);
    expect(b.y + b.height).toBeLessThanOrEqual(640);
    for (const field of ['Base URL', 'API key', 'Model']) {
      const f = (await llm.getByLabel(field).boundingBox())!;
      expect(f.x + f.width, field).toBeLessThanOrEqual(b.x + b.width);
    }
    await shot(page, 'settings-ai-narrow');
  } finally {
    await jev.close();
  }
  clean();
});
