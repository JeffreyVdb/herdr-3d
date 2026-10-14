import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Worker } from '../src/net/protocol';
import { frames, openGame, openMenu, shot, watchErrors } from './game';

// #9: "Use configured LLM" against the fixture bridge (`sim=1`, tools/fixture-handoff.ts). The first journey runs the
// bridge's gate on the simulated AI integration, which calls a fake OpenAI-compatible server started here on an
// OS-leased loopback port (no spec reaches a real provider): set up the LLM, pass the LLM handoffs test, switch it on,
// then the dialog's third mode previews who receives what, writes the handoff with the LLM and files it, and the
// worker goes home. The second plays every state with no endpoint (`simhandoffllm`, `sim.handoff_llm`): a failure
// keeps the dialog, Try again is a new request, a slow job can be cancelled, the cabinet says who wrote it.

const LLM_KEY = 'sk-test-llm-key-abcdef';
const FOCUS = 'the open review comments';
const DOC =
  '# Zippy: finish the review follow-ups\n\n## Goal and current state\nTwo review comments are left.\n\n## Decisions\n- Keep the loader.\n\n' +
  '## Verification\n- `make test` passed.\n\n## Open questions\nNone.\n\n## Next steps\n1. Answer the comments.\n\n## Suggested skills\nNone.\n';

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

/** An OpenAI-compatible endpoint: the AI test's object, else a handoff of the agreed shape. */
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
          content = DOC;
        }
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    }),
    bodies,
  );
}

async function setUpLLM(dialog: Locator, llm: Fake): Promise<void> {
  const box = dialog.getByRole('group', { name: /^LLM/ });
  await box.getByLabel('Base URL').fill(`${llm.url}/v1`);
  await box.getByLabel('API key').fill(LLM_KEY);
  await box.getByLabel('Model').fill('mimo-v2.6-flash');
  await box.getByRole('button', { name: 'Test' }).click();
  await expect(box).toContainText('Test passed');
  await box.getByRole('button', { name: 'Save' }).click();
  await expect(box.locator('.settings-badge')).toHaveText('Ready');
}

function demoWorker(name: string): Worker {
  const snap = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/demo-m5.jsonl'), 'utf8').split('\n')[0] ?? '{}') as { world: { workers: Worker[] } };
  const w = snap.world.workers.find((x) => x.name === name);
  if (!w) throw new Error(`no ${name} in demo-m5`);
  return w;
}

const sim = (page: Page, t: 'sim.final' | 'sim.handoff_llm' | 'sim.llm_finish', args: Record<string, unknown>) => page.evaluate((a) => window.__h3d.simHandoff(a.t, a.args), { t, args });
const sent = (page: Page, t: string) => page.evaluate((x) => window.__h3d.sent().filter((c) => c.t === x), t) as Promise<Array<{ args: Record<string, unknown> }>>;
const dialog = (page: Page) => page.evaluate(() => window.__h3d.handoffDialog());

/** Zippy, faced on the herdr-3d floor, with a completed reply; F opens the dialog. */
async function openOnZippy(page: Page): Promise<{ w: Worker; dlg: Locator }> {
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  const w = demoWorker('Zippy');
  expect((await sim(page, 'sim.final', { id: w.id, text: 'Two review comments left; `make test` passes.' })).ok).toBe(true);
  expect(await page.evaluate((id) => window.__h3d.face(id), w.id)).toBe(true);
  await frames(page, 3);
  await page.keyboard.press('KeyF');
  const dlg = page.getByRole('dialog', { name: 'File a handoff from Zippy' });
  await expect(dlg).toBeVisible();
  return { w, dlg };
}

test('LLM handoffs: off until tested, then the configured LLM writes and files it; the worker is not asked', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  const llm = await fakeOpenAI();
  try {
    await openGame(page, 'demo-m5', '', 'play=none&sim=1&simms=150&simusage=0');
    await openMenu(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    const section = settings.locator('[data-section="handoff-llm"]');
    await expect(section.getByRole('heading', { name: 'LLM handoffs', level: 3 })).toBeVisible();
    const order = await settings.locator('section.settings-section').evaluateAll((s) => s.map((x) => (x as HTMLElement).dataset.section));
    expect(order.indexOf('handoff-llm')).toBe(order.indexOf('digest') + 1);
    const toggle = section.getByRole('checkbox', { name: 'LLM handoffs' });
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toBeDisabled();
    const privacy = section.locator('.settings-fu-privacy');
    await expect(privacy).toContainText('sends your configured LLM endpoint a reduced copy');
    await expect(privacy).toContainText('a pattern list can miss a secret');
    await setUpLLM(settings, llm);
    await expect(toggle).toBeDisabled();
    expect(llm.bodies).toHaveLength(0); // configuring the AI sends nothing of a worker
    await section.getByRole('button', { name: 'Test' }).click();
    await expect(section).toContainText('Test passed');
    await expect(section.locator('.settings-fu-result')).toContainText('“Zippy: finish the review follow-ups”');
    expect(llm.bodies).toHaveLength(1);
    expect(llm.bodies[0]).toContain('The login test in e2e/auth.spec.ts'); // the synthetic sample, no worker's text
    await toggle.check();
    await expect(section).toContainText('On: “Use configured LLM” can be chosen');
    await section.scrollIntoViewIfNeeded();
    await shot(page, 'h9-settings');
    await page.keyboard.press('Escape');

    const { w, dlg } = await openOnZippy(page);
    expect((await dialog(page))?.mode).toBe('literal'); // never chosen for you
    await dlg.getByText('Use configured LLM', { exact: true }).click();
    await expect.poll(async () => (await dialog(page))?.state).toBe('ready');
    const host = new URL(llm.url).host;
    expect((await dialog(page))?.recipient).toBe(`mimo-v2.6-flash at ${host}`);
    await expect(dlg.locator('[data-hook="ho-payload"]')).toContainText('of transcript, about');
    await expect(dlg.locator('[data-hook="ho-coverage"]')).toContainText('Left out: messages 3–14 (older assistant detail)');
    await expect(dlg.locator('[data-hook="ho-redactions"]')).toContainText('Removed before sending: 1 GitHub token, 1 password in a URL.');
    await dlg.getByLabel(/What to focus on/).fill(FOCUS);
    await dlg.getByText('Send Zippy home after filing').click();
    await shot(page, 'h9-llm-preview');
    await dlg.getByRole('button', { name: 'Write, then send home' }).click();
    await expect.poll(async () => (await dialog(page))?.state).toBe('filed');
    await expect(dlg.locator('[data-hook="ho-written-by"]')).toContainText(`Written by mimo-v2.6-flash at ${host}; Zippy was not asked.`);
    await expect(dlg.locator('[data-hook="ho-home"]')).toContainText('on the way home');
    await shot(page, 'h9-llm-filed');
    const writes = await sent(page, 'worker.handoff');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.args).toMatchObject({ worker: w.id, mode: 'llm', instruction: FOCUS, send_home: true });
    expect(await sent(page, 'worker.prompt')).toHaveLength(0);
    expect(llm.bodies).toHaveLength(2);
    expect(llm.bodies[1]).toContain('Two review comments left');
    expect(llm.bodies[1]).toContain(FOCUS);
    await dlg.getByRole('button', { name: 'Done' }).click();
    await expect.poll(() => page.evaluate((id) => window.__h3d.world().flatMap((f) => f.workers).some((x) => x.id === id), w.id)).toBe(false);
  } finally {
    await llm.close();
  }
  clean();
});

test('LLM handoffs with no endpoint: a failure keeps the dialog, Try again is a new request, a slow job cancels, the cabinet says who wrote it', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', 'play=none&sim=1&simms=150&simusage=0&simhandoffllm=ready&simhandoffllmout=timeout');
  const { dlg } = await openOnZippy(page);
  await dlg.getByText('Use configured LLM', { exact: true }).click();
  await expect.poll(async () => (await dialog(page))?.state).toBe('ready');
  await dlg.getByRole('button', { name: 'Write with the LLM' }).click();
  await expect.poll(async () => (await dialog(page))?.state).toBe('failed');
  await expect(dlg.locator('[data-hook="ho-reason"]')).toContainText('did not answer within 90 s; it was not sent again');
  await expect(dlg.locator('[data-hook="ho-job"]')).toContainText('Zippy stays; nobody was sent home.');
  await shot(page, 'h9-llm-failed');
  // Try again: a new preview and, once written, a new op.
  await sim(page, 'sim.handoff_llm', { outcome: 'slow' });
  await dlg.getByRole('button', { name: 'Try again (new request)' }).click();
  await expect.poll(async () => (await dialog(page))?.state).toBe('ready');
  await dlg.getByRole('button', { name: 'Write with the LLM' }).click();
  await expect.poll(async () => (await dialog(page))?.state).toBe('pending');
  await expect(dlg.locator('[data-hook="ho-job"]')).toContainText('gpt-handoff-sim at llm.sim.example is writing the handoff');
  await shot(page, 'h9-llm-pending');
  await dlg.getByRole('button', { name: 'Cancel request' }).click();
  await expect.poll(async () => (await dialog(page))?.state).toBe('failed');
  await expect(dlg.locator('[data-hook="ho-reason"]')).toContainText('cancelled; nothing was filed');
  const ops = (await sent(page, 'worker.handoff')).map((c) => c.args.op);
  expect(ops).toHaveLength(2);
  expect(ops[0]).not.toBe(ops[1]);
  // A busy bridge: the preview says why and Write stays off.
  await sim(page, 'sim.handoff_llm', { outcome: 'busy' });
  await dlg.getByRole('button', { name: 'Dismiss' }).click();
  await expect.poll(async () => (await dialog(page))?.state).toBe('ready');
  await expect(dlg.locator('[data-hook="ho-llm-cannot"]')).toContainText('one at a time');
  await expect(dlg.getByRole('button', { name: 'Write with the LLM' })).toHaveAttribute('aria-disabled', 'true');
  await shot(page, 'h9-llm-busy');
  // Success, then the cabinet: by the LLM, its model and prompt.
  await sim(page, 'sim.handoff_llm', { outcome: 'success' });
  await page.keyboard.press('Escape');
  await page.keyboard.press('KeyF');
  await dlg.getByText('Use configured LLM', { exact: true }).click();
  await expect.poll(async () => (await dialog(page))?.llmReady).toBe(true);
  await dlg.getByRole('button', { name: 'Write with the LLM' }).click();
  await expect.poll(async () => (await dialog(page))?.state).toBe('filed');
  await dlg.getByRole('button', { name: 'Open the cabinet' }).click();
  const cab = page.getByRole('dialog', { name: /cabinet/i });
  await expect(cab.locator('[data-hook="cab-source"]')).toContainText('By the LLM · gpt-handoff-sim at llm.sim.example');
  await expect(cab.locator('[data-hook="cab-llm"]')).toContainText('prompt h3d-handoff-llm-1');
  await shot(page, 'h9-cabinet-llm');
  clean();
});

test('LLM handoffs off: the mode says why and leads to Settings', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', 'play=none&sim=1&simms=150&simusage=0&simhandoffllm=untested');
  const { dlg } = await openOnZippy(page);
  await expect(dlg.getByRole('radio', { name: /Use configured LLM/ })).toBeDisabled();
  await expect(dlg.locator('[data-hook="ho-modes"]')).toContainText('The LLM or the limits changed since the test: run it again in Settings.');
  await shot(page, 'h9-llm-off');
  await dlg.getByRole('button', { name: 'Open LLM handoffs settings' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Settings' }).locator('[data-section="handoff-llm"]')).toBeVisible();
  clean();
});
