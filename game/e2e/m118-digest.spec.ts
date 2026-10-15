import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { frames, openGame, settingsSection, shot, watchErrors, openMenu } from './game';

// #118 phase 2, floor overview summaries, against the fixture bridge (`sim=1`, tools/fixture-digest.ts) on demo-m118,
// whose AI integration calls a fake OpenAI-compatible server started here on an OS-leased loopback port: no spec
// reaches a real provider. Set up the LLM, pass the summaries test, switch it on; then the floor you stand on gets
// its lines from the LLM, and the overview page marks them AI.

const LLM_KEY = 'sk-test-llm-key-abcdef';
const TASK = 'Tidy the lab floor’s settings dialog';
const NOW = 'Reviewing the picker port before the PR';

interface Fake {
  url: string;
  close(): Promise<void>;
  bodies: string[];
}

function listen(server: Server, bodies: string[]): Promise<Fake> {
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      done({ url: `http://127.0.0.1:${port}`, bodies, close: () => new Promise((r) => (server.closeAllConnections(), server.close(() => r()))) });
    });
  });
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((done) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => done(b));
  });
}

/** An OpenAI-compatible endpoint: the AI test's object, else a task line or a now line, quoted and in markdown (the
 * bridge cleans them). */
function fakeOpenAI(): Promise<Fake> {
  const bodies: string[] = [];
  return listen(
    createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== `Bearer ${LLM_KEY}`) return void res.writeHead(401).end('{"error":{"message":"bad key"}}');
      if (req.url === '/v1/models') return void res.end('{"object":"list","data":[{"id":"mimo-v2.6-flash"}]}');
      if (req.url !== '/v1/chat/completions') return void res.writeHead(404).end('{}');
      void body(req).then((b) => {
        let content = '{"ok": true}';
        if (!b.includes('Reply with exactly this JSON')) {
          bodies.push(b);
          const msgs = (JSON.parse(b) as { messages: Array<{ content: string }> }).messages;
          content = msgs[0]?.content.includes('label the task') ? `"${TASK}."` : `**${NOW}**`;
        }
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    }),
    bodies,
  );
}

/** The LLM set up through the AI integration section, then back to the summaries (#49: one section at a time). */
async function setUpLLM(page: Page, dialog: Locator, llm: Fake): Promise<void> {
  await settingsSection(page, 'ai');
  const box = dialog.getByRole('group', { name: /^LLM/ });
  await box.getByLabel('Base URL').fill(`${llm.url}/v1`);
  await box.getByLabel('API key').fill(LLM_KEY);
  await box.getByLabel('Model').fill('mimo-v2.6-flash');
  await box.getByRole('button', { name: 'Test' }).click();
  await expect(box).toContainText('Test passed');
  await box.getByRole('button', { name: 'Save' }).click();
  await expect(box.locator('.settings-badge')).toHaveText('Ready');
  await settingsSection(page, 'digest');
}

test('summaries: off until a test passed, then the LLM writes the floor’s lines and the overview marks them AI', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  const llm = await fakeOpenAI();
  try {
    await openGame(page, 'demo-m118', '', 'play=none&sim=1&simms=150');
    await openMenu(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    const section = await settingsSection(page, 'digest');
    await expect(section.getByRole('heading', { name: 'Floor overview summaries', level: 3 })).toBeVisible();
    await expect(section.locator('.settings-store')).toHaveText('Bridge');
    const order = await dialog.locator('section.settings-section').evaluateAll((s) => s.map((x) => (x as HTMLElement).dataset.section));
    expect(order.indexOf('digest')).toBe(order.indexOf('activity') + 1);
    // Off by default; what is sent and where above the switch.
    const toggle = section.getByRole('checkbox', { name: 'Floor overview summaries' });
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toBeDisabled();
    await expect(section.locator('.settings-fu-privacy')).toContainText('sends your configured LLM endpoint');
    await expect(section.locator('.settings-fu-privacy')).toContainText('the last 5 assistant turns of every worker');
    const [note, sw] = await Promise.all([section.locator('.settings-fu-privacy').boundingBox(), toggle.boundingBox()]);
    expect(note && sw && note.y + note.height <= sw.y).toBe(true);
    await setUpLLM(page, dialog, llm);
    await expect(toggle).toBeDisabled();
    // Nothing of the floor went before the switch.
    expect(llm.bodies).toHaveLength(0);
    // #174: the reasoning effort starts at the provider's default and the completion budget at 1,024; both are this
    // section's own, with their scope and the timing said under them.
    const effort = section.getByLabel('Reasoning effort');
    const budget = section.getByLabel('Completion budget (tokens)');
    await expect(effort).toHaveValue('');
    await expect(budget).toHaveValue('1024');
    await expect(section).toContainText('floor overview summaries only');
    await expect(section).toContainText('at most once a minute per worker');
    await budget.fill('2048');
    await budget.press('Enter');
    await expect(section).toContainText('Completion budget saved: 2,048 tokens.');
    await effort.selectOption('low');
    await expect(section).toContainText('Reasoning effort saved');
    await expect(budget).toHaveValue('2048');
    await section.getByRole('button', { name: 'Test' }).click();
    await expect(section).toContainText('Test passed');
    await expect(section.locator('.settings-fu-result')).toContainText(`“${TASK}”`);
    await expect(section.locator('.settings-fu-result')).toContainText(`“${NOW}”`);
    await toggle.check();
    await expect(section).toContainText('On: lines are written for the floors someone is viewing.');
    await section.scrollIntoViewIfNeeded();
    await shot(page, 'settings-digest');
    await section.getByRole('button', { name: 'Retry failed' }).scrollIntoViewIfNeeded();
    await shot(page, 'settings-digest-reasoning');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // On the lab floor: its workers' lines come from the LLM; the page marks them.
    await page.evaluate(() => window.__h3d.enterFloor('lab'));
    await frames(page, 3);
    await page.keyboard.press('KeyO');
    await expect.poll(async () => (await page.evaluate(() => window.__h3d.overview()))?.page?.open).toBe(true);
    const turnip = page.locator('.ov-row', { hasText: 'Turnip' });
    await expect(turnip.locator('.ov-task')).toContainText(TASK, { timeout: 30_000 });
    // #232: the sparkle beside the line's label, the same for a task line and a now line.
    await expect(turnip.locator('.ov-task > b > .ov-ai')).toHaveAttribute('aria-label', 'AI-generated summary of what this worker was asked to do.');
    await expect(page.locator('.ov-row .ov-ai').first()).toBeVisible();
    await expect(page.locator('.ov', { hasText: NOW })).toBeVisible();
    const nowRow = page.locator('.ov-row', { hasText: NOW }).first();
    expect(await nowRow.locator('.ov-now > b > .ov-ai').count()).toBe(1);
    expect(await page.locator('.ov-since .ov-ai, .ov-llm').count()).toBe(0);
    // #198: the model's now line says how long ago it was written (quiet words after it), and that the time is the summary's.
    await expect(nowRow.locator('.ov-now .ov-age')).toHaveText(/^(just now|\d+m ago)$/);
    await expect(nowRow.locator('.ov-now .ov-ai')).toHaveAttribute('title', /recent activity \(its last 5 steps\); generated .*The time is when the summary was written, not when the activity happened\.$/);
    await shot(page, 'm118-digest-page');
    // Every request marked the worker's lines as data, between delimiters, the instruction in its own turn.
    expect(llm.bodies.length).toBeGreaterThan(1);
    for (const b of llm.bodies) {
      const msgs = (JSON.parse(b) as { messages: Array<{ role: string; content: string }> }).messages;
      expect(msgs.map((m) => m.role)).toEqual(['system', 'user']);
      expect(msgs[1]?.content).toMatch(/^<transcript>\n[\s\S]*\n<\/transcript>$/);
    }
    clean();
  } finally {
    await llm.close();
  }
});

// #198: a refresh of a model's now line that failed. The line, its AI sparkle and age stay; the failure follows them,
// quietly, with Retry (pointer and R). The fixture bridge never fails a summary, so Turnip's digest is given that state
// on its way to the page (the frames the game sends are kept).
test('a failed refresh of an AI now line keeps the line and its age, says so, and Retry asks again', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  const sent: Array<{ t: string; args?: { id?: string } }> = [];
  const at = Date.now() - 4 * 60_000;
  const patch = (w: { label?: string; name?: string; digest?: Record<string, unknown> }) => {
    if ((w.label === 'Turnip' || w.name === 'Turnip') && w.digest) {
      Object.assign(w.digest, { now: NOW, now_source: 'llm', now_at: at, now_status: { state: 'failed', reason: 'timeout', attempts: 1 } });
    }
  };
  await page.routeWebSocket(/\/fixture\//, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      if (typeof m === 'string') sent.push(JSON.parse(m));
      server.send(m);
    });
    server.onMessage((m) => {
      if (typeof m !== 'string') return ws.send(m);
      const f = JSON.parse(m);
      if (f.t === 'world.snapshot') for (const w of f.world.workers) patch(w);
      if (f.t === 'worker.upsert') patch(f.worker);
      ws.send(JSON.stringify(f));
    });
  });
  const retries = () => sent.filter((f) => f.t === 'digest.retry');
  await openGame(page, 'demo-m118', '', 'play=none&sim=1&simms=150');
  await page.evaluate(() => window.__h3d.enterFloor('lab'));
  await frames(page, 3);
  await page.keyboard.press('KeyO');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.overview()))?.page?.open).toBe(true);
  const row = page.locator('.ov-row', { hasText: 'Turnip' });
  const line = row.locator('.ov-now');
  await expect(line).toContainText(NOW);
  await expect(line.locator('.ov-ai')).toBeVisible();
  await expect(line.locator('.ov-age')).toHaveText(/^\d+m ago$/);
  const chip = line.locator('.ov-ai-state');
  await expect(chip).toHaveText('refresh failed');
  await expect(chip).toHaveAttribute('aria-label', /^Refreshing this AI summary from newer activity failed: the model did not answer in time\. The summary shown is the previous one/);
  await expect(row).toHaveAttribute('aria-label', /Now: .*\(AI summary, \d+m ago; refresh failed\)/);
  await expect(page.locator('.ov')).not.toHaveClass(/ov--enter/, { timeout: 5000 }); // the grow is over
  await line.scrollIntoViewIfNeeded();
  await shot(page, 'm198-refresh-failed');
  await line.locator('.ov-retry').click();
  await expect.poll(() => retries().length).toBe(1);
  expect(retries()[0]?.args?.id).toBeTruthy();
  await page.keyboard.press('KeyR');
  await expect.poll(() => retries().length).toBe(2);
  expect(retries()[1]?.args?.id).toBe(retries()[0]?.args?.id);
  expect((await page.evaluate(() => window.__h3d.overview()))?.page?.open).toBe(true); // not the transcript
  // A phone: the age, the failure and Retry go under the line, all of them on screen; the sparkle stays by its label (#232).
  await page.setViewportSize({ width: 390, height: 844 });
  await line.scrollIntoViewIfNeeded();
  await expect(line.locator('.ov-retry')).toBeVisible();
  await expect(line.locator('b > .ov-ai')).toBeVisible();
  const [text, state] = await Promise.all([line.locator('.ov-now-text').boundingBox(), chip.boundingBox()]);
  expect(text && state && state.y >= text.y + text.height - 1).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shot(page, 'm198-refresh-failed-narrow');
  clean();
});
