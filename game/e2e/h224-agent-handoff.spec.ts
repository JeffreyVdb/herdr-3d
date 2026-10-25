import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Worker } from '../src/net/protocol';
import { frames, openGame, seatMode, shot, watchErrors } from './game';

// #224: "Ask the agent" against the fixture bridge (`sim=1`, tools/fixture-handoff.ts): the filing dialog's modes,
// the instruction, the cache estimate said as an estimate, the request followed until it is filed (then sent home)
// or fails; the composer's exact "/handoff" becomes the same request, once per op. `sim.agent_turn` plays the agent.

const SIM = 'play=none&sim=1&simms=150&simusage=0';

function demoWorker(name: string): Worker {
  const snap = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/demo-m5.jsonl'), 'utf8').split('\n')[0] ?? '{}') as { world: { workers: Worker[] } };
  const w = snap.world.workers.find((x) => x.name === name);
  if (!w) throw new Error(`no ${name} in demo-m5`);
  return w;
}

const sim = (page: Page, t: 'sim.agent_turn' | 'sim.agent_skill' | 'sim.cache', args: Record<string, unknown>) => page.evaluate((a) => window.__h3d.simHandoff(a.t, a.args), { t, args });
const sent = (page: Page, t: string) => page.evaluate((x) => window.__h3d.sent().filter((c) => c.t === x), t) as Promise<Array<{ args: Record<string, unknown> }>>;
const dialog = (page: Page) => page.evaluate(() => window.__h3d.handoffDialog());

test('F, Ask the agent: who gets it, the estimate, the instruction; filed by the agent, then sent home', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', SIM);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  const w = demoWorker('Zippy');
  expect(await page.evaluate((id) => window.__h3d.face(id), w.id)).toBe(true);
  await frames(page, 3);
  await page.keyboard.press('KeyF');
  const dlg = page.getByRole('dialog', { name: 'File a handoff from Zippy' });
  await expect(dlg).toBeVisible();
  // Literal stays the default, even with nothing to save; nothing is chosen for you.
  expect((await dialog(page))?.mode).toBe('literal');
  await expect(dlg.getByRole('radio', { name: /Use configured LLM/ })).toBeDisabled();
  // #9: off until LLM handoffs are switched on, and it says so with the way to Settings.
  await expect(dlg.locator('[data-hook="ho-modes"]')).toContainText('Off: switch LLM handoffs on in Settings after a passing test.');
  await expect(dlg.getByRole('button', { name: 'Open LLM handoffs settings' })).toBeVisible();
  await dlg.getByText('Ask the agent', { exact: true }).click();
  await expect.poll(async () => (await dialog(page))?.state).toBe('ready');
  const s = await dialog(page);
  expect(s?.mode).toBe('agent');
  expect(s?.canAsk).toBe(true);
  expect(s?.call).toBe('/handoff');
  const cache = dlg.locator('[data-hook="ho-cache"]');
  await expect(cache).toContainText('Estimate · May have expired');
  await expect(cache).toContainText('Agent cache may have expired. Generating a handoff can process the current conversation context again (about');
  await expect(cache).not.toContainText(/JSONL|transcript file/);
  await dlg.getByLabel(/Handoff instruction/).fill('focus on the open review comments');
  await dlg.getByText('Send Zippy home after filing').click();
  await shot(page, 'h224-ask-the-agent');
  await dlg.getByRole('button', { name: 'Ask, then send home' }).click();
  await expect.poll(async () => (await dialog(page))?.state).toBe('pending');
  await expect(dlg.locator('[data-hook="ho-request"]')).toContainText('Waiting for Zippy’s agent');
  const asks = await sent(page, 'worker.handoff');
  expect(asks).toHaveLength(1);
  expect(asks[0]?.args).toMatchObject({ worker: w.id, mode: 'agent', instruction: 'focus on the open review comments', send_home: true });
  // The client never prompts the worker itself: the bridge sends the request.
  expect(await sent(page, 'worker.prompt')).toHaveLength(0);
  await shot(page, 'h224-request-pending');
  expect((await sim(page, 'sim.agent_turn', { id: w.id, text: '# Review follow-ups\n\nTwo comments left.\n' })).ok).toBe(true);
  await expect.poll(async () => (await dialog(page))?.state).toBe('filed');
  await expect(dlg.locator('[data-hook="ho-path"]')).toContainText('/home/u/handoff/herdr-3d/');
  await expect(dlg.locator('[data-hook="ho-home"]')).toContainText('on the way home');
  await shot(page, 'h224-filed');
  await dlg.getByRole('button', { name: 'Done' }).click();
  await expect.poll(() => page.evaluate((id) => window.__h3d.world().flatMap((f) => f.workers).some((x) => x.id === id), w.id)).toBe(false);
  clean();
});

test('a missing skill or a busy worker can’t be asked; a failure says why and keeps the worker', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', SIM);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  const w = demoWorker('Zippy');
  expect(await page.evaluate((id) => window.__h3d.face(id), w.id)).toBe(true);
  await frames(page, 3);
  await sim(page, 'sim.agent_skill', { missing: true });
  await page.keyboard.press('KeyF');
  const dlg = page.getByRole('dialog', { name: 'File a handoff from Zippy' });
  await dlg.getByText('Ask the agent', { exact: true }).click();
  await expect.poll(async () => (await dialog(page))?.state).toBe('ready');
  await expect(dlg.locator('[data-hook="ho-cannot"]')).toContainText('lists no "handoff" skill');
  await expect(dlg.getByRole('button', { name: 'Ask the agent' })).toHaveAttribute('aria-disabled', 'true');
  await shot(page, 'h224-no-skill');
  await sim(page, 'sim.agent_skill', { missing: false });
  await sim(page, 'sim.cache', { id: w.id, state: 'warm' });
  await page.keyboard.press('Escape');
  await page.keyboard.press('KeyF');
  await dlg.getByText('Ask the agent', { exact: true }).click();
  await expect.poll(async () => (await dialog(page))?.canAsk).toBe(true);
  await expect(dlg.locator('[data-hook="ho-cache"]')).toContainText('Estimate · Likely warm');
  await dlg.getByRole('button', { name: 'Ask the agent' }).click();
  await expect.poll(async () => (await dialog(page))?.state).toBe('pending');
  await sim(page, 'sim.agent_turn', { id: w.id, fail: 'the agent’s turn ended without the handoff at /home/u/handoff/.pending/herdr-3d/x.md' });
  await expect.poll(async () => (await dialog(page))?.state).toBe('failed');
  await expect(dlg.locator('[data-hook="ho-reason"]')).toContainText('ended without the handoff');
  await expect(dlg.locator('[data-hook="ho-request"]')).toContainText('Zippy stays; nobody was sent home.');
  await shot(page, 'h224-failed');
  // Ask again: a new request with a new op.
  await dlg.getByRole('button', { name: 'Ask again' }).click();
  await expect.poll(async () => (await dialog(page))?.state).toBe('ready');
  await dlg.getByRole('button', { name: 'Ask the agent' }).click();
  await expect.poll(async () => (await dialog(page))?.state).toBe('pending');
  const ops = (await sent(page, 'worker.handoff')).map((c) => c.args.op);
  expect(ops).toHaveLength(2);
  expect(ops[0]).not.toBe(ops[1]);
  expect(await page.evaluate((id) => window.__h3d.world().flatMap((f) => f.workers).some((x) => x.id === id), w.id)).toBe(true);
  clean();
});

test('the composer’s exact /handoff asks the agent once; the outcome is said when it is filed', async ({ page }) => {
  const clean = watchErrors(page);
  const w = demoWorker('Pebble');
  await openGame(page, 'demo-m5', '', SIM);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.face(id), w.id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.sitAt(id), w.id)).toBe(true);
  await frames(page, 20);
  await seatMode(page, 'transcript');
  const input = page.locator('.seat-transcript .tx .tx-input');
  await input.click();
  await page.keyboard.type('/handoff keep it short');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await sent(page, 'worker.prompt')).length).toBe(1);
  const p = (await sent(page, 'worker.prompt'))[0];
  expect(p?.args).toMatchObject({ id: w.id, text: '/handoff keep it short' });
  expect(String(p?.args.op)).toMatch(/^ho-/);
  await shot(page, 'h224-composer');
  // The request runs on the bridge: the agent's turn files it.
  await expect.poll(async () => (await sim(page, 'sim.agent_turn', { id: w.id })).ok).toBe(true);
  await expect(page.locator('.toast')).toContainText('Filed Pebble’s handoff, written by its agent.');
  expect(await sent(page, 'worker.handoff')).toHaveLength(0);
  clean();
});

// #198: "Hire with handoff" by the agent: the request is followed until filed, then one agent is hired with the final
// path; closed while it is written, nobody is hired and the handoff still goes to the cabinet.
async function hireWithAgentHandoff(page: Page, w: Worker, task: string): Promise<Locator> {
  await openGame(page, 'demo-m5', '', SIM);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.face(id), w.id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.sitAt(id), w.id)).toBe(true);
  await frames(page, 20);
  await seatMode(page, 'transcript');
  expect((await page.evaluate((a) => window.__h3d.simHandoff('sim.final', a), { id: w.id, text: 'Two review comments left.' })).ok).toBe(true);
  await page.locator('.seat-transcript .tx').getByRole('button', { name: 'Hire with handoff', exact: true }).click();
  const step1 = page.getByRole('dialog', { name: `Hire with a handoff from ${w.name}` });
  await step1.getByText('Ask the agent', { exact: true }).click();
  await expect.poll(async () => (await dialog(page))?.canAsk).toBe(true);
  await step1.getByLabel(/Handoff instruction/).fill('focus on the open review comments');
  await step1.getByLabel(/Task for the new agent/).fill(task);
  await step1.getByRole('button', { name: 'Continue to hire' }).click();
  const review = page.getByRole('dialog', { name: /^Hire with a handoff at Desk/ });
  await expect(review).toBeVisible();
  await review.locator('label:has(> input[data-key="effort:high"])').click();
  await review.getByRole('button', { name: 'File handoff and hire' }).click();
  await expect.poll(async () => ((await page.evaluate(() => window.__h3d.dialog())) as { state?: string } | null)?.state).toBe('filing');
  return review;
}

test('Hire with handoff, Ask the agent: filed by the agent, then one hire with the final path; the task never reaches the source', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  const w = demoWorker('Pebble');
  const review = await hireWithAgentHandoff(page, w, 'Fix the issue');
  await expect(review.locator('.dd-foot [role="status"]')).toContainText('Asking Pebble’s agent…');
  await shot(page, 'h198-agent-filing');
  const asks = await sent(page, 'worker.handoff');
  expect(asks).toHaveLength(1);
  expect(asks[0]?.args).toMatchObject({ worker: w.id, mode: 'agent', instruction: 'focus on the open review comments' });
  expect(JSON.stringify(asks[0]?.args)).not.toContain('Fix the issue');
  expect(await sent(page, 'worker.hire')).toHaveLength(0);
  expect((await sim(page, 'sim.agent_turn', { id: w.id, text: '# Review follow-ups\n\nTwo comments left.\n' })).ok).toBe(true);
  await expect(review).toBeHidden();
  const hires = await sent(page, 'worker.hire');
  expect(hires).toHaveLength(1);
  const prompt = String(hires[0]?.args.prompt);
  expect(prompt).toMatch(/^First read the handoff here: \/home\/u\/handoff\/herdr-3d\/[^\n]+\.md and then follow these instructions:\n\nFix the issue$/);
  expect(prompt).not.toContain('.pending');
  expect(await sent(page, 'worker.prompt')).toHaveLength(0);
  clean();
});

test('Hire with handoff: closed while the agent writes it, nobody is hired; the handoff is still filed', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  const w = demoWorker('Pebble');
  const review = await hireWithAgentHandoff(page, w, 'Fix the issue');
  await page.keyboard.press('Escape');
  await expect(review).toBeHidden();
  await expect(page.locator('.toast')).toContainText('No agent hired. Pebble’s handoff will still be filed to the cabinet; hire from it there.');
  expect((await sim(page, 'sim.agent_turn', { id: w.id })).ok).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__h3d.filing().drawers)).toEqual([0, 0, 1]);
  await frames(page, 10);
  expect(await sent(page, 'worker.hire')).toHaveLength(0);
  clean();
});
