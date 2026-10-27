import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { HandoffHire, Worker } from '../src/net/protocol';
import { frames, openGame, seatMode, shot, watchErrors } from './game';
import { beeps, forgetToasts, probe, SPAWNED, toasts } from './hireProbe';

// #219: "Hire with handoff" in the background against the fixture bridge with `simhandoffhires=1` (the bridge hires
// once the handoff is filed, tools/fixture-handoffhire.ts). The review sends one `worker.handoff` with `hire` and never
// `worker.hire`; the desk is held and the source's card says where the new agent goes; `sim.agent_turn` /
// `sim.llm_finish` file it and the bridge hires once. Cancel from the F dialog cancels both; a hire refused after
// filing gives the task back with the path; a reload while it is written still hires, and says so once.

const SIM = 'play=none&sim=1&simms=150&simusage=0&simhandoffhires=1';
const unique = () => `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const WRITING = (desk: number) => `Writing Pebble’s handoff. Nibble is hired at Desk ${desk + 1} once it is filed.`;

function demoWorker(name: string): Worker {
  const snap = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/demo-m5.jsonl'), 'utf8').split('\n')[0] ?? '{}') as { world: { workers: Worker[] } };
  const w = snap.world.workers.find((x) => x.name === name);
  if (!w) throw new Error(`no ${name} in demo-m5`);
  return w;
}

const sim = (page: Page, t: 'sim.agent_turn' | 'sim.llm_finish' | 'sim.handoff_hire' | 'sim.final', args: Record<string, unknown>) => page.evaluate((a) => window.__h3d.simHandoff(a.t, a.args), { t, args });
const sent = (page: Page, t: string) => page.evaluate((x) => window.__h3d.sent().filter((c) => c.t === x), t) as Promise<Array<{ args: Record<string, unknown> }>>;
/** The hire's own toasts (others, the filing's "Filed …" note among them, are not counted). */
const said = async (page: Page) => (await toasts(page)).filter((t) => t === SPAWNED || t.startsWith('Writing ') || t.includes('nobody was hired') || t.startsWith('Hired '));
const records = (page: Page) => page.evaluate(() => window.__h3d.handoffHires().records) as Promise<HandoffHire[]>;
const reviewState = (page: Page) => page.evaluate(() => window.__h3d.dialog()) as Promise<{ kind?: string; state?: string; desk?: number; status?: string; form?: { prompt: string }; handoff?: { filed: string | null } | null } | null>;
const desk = (page: Page, d: number) => page.evaluate((i) => window.__h3d.desks()[i], d);
const card = (page: Page, name: string) => page.evaluate((n) => window.__h3d.cards().find((c) => c.name === n) ?? null, name);

/** Seated at Pebble's laptop, its last reply ready: "Hire with handoff", step 1 in `mode`, then the review. */
async function toReview(page: Page, mode: 'agent' | 'llm', task: string, extra = ''): Promise<{ w: Worker; review: Locator; desk: number }> {
  await openGame(page, 'demo-m5', '', `${SIM}${mode === 'llm' ? '&simhandoffllm=ready&simhandoffllmout=slow' : ''}${extra}`);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  const w = demoWorker('Pebble');
  expect(await page.evaluate(() => window.__h3d.handoffHires().known)).toBe(true);
  expect((await sim(page, 'sim.final', { id: w.id, text: 'Two review comments left; `make test` passes.' })).ok).toBe(true);
  expect(await page.evaluate((id) => window.__h3d.face(id), w.id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.sitAt(id), w.id)).toBe(true);
  await frames(page, 20);
  await seatMode(page, 'transcript');
  await page.locator('.seat-transcript .tx').getByRole('button', { name: 'Hire with handoff', exact: true }).click();
  const step1 = page.getByRole('dialog', { name: 'Hire with a handoff from Pebble' });
  if (mode === 'agent') {
    await step1.getByText('Ask the agent', { exact: true }).click();
    await expect.poll(async () => ((await page.evaluate(() => window.__h3d.handoffDialog())) as { canAsk?: boolean } | null)?.canAsk).toBe(true);
    await step1.getByLabel(/Handoff instruction/).fill('focus on the open review comments');
  } else {
    await step1.getByText('Use configured LLM', { exact: true }).click();
    await expect.poll(async () => ((await page.evaluate(() => window.__h3d.handoffDialog())) as { llmReady?: boolean } | null)?.llmReady).toBe(true);
  }
  await step1.getByLabel(/Task for the new agent/).fill(task);
  await step1.getByRole('button', { name: 'Continue to hire' }).click();
  const review = page.getByRole('dialog', { name: /^Hire with a handoff at Desk/ });
  await expect(review).toBeVisible();
  await review.locator('label:has(> input[data-key="effort:high"])').click();
  await expect.poll(async () => (await reviewState(page))?.state).toBe('ready');
  // The new agent's name, so the messages are known: the options' section opens for it.
  if (!(await review.locator('#review-label').isVisible())) await review.locator('[data-key="sec:where"]').click();
  await review.locator('#review-label').fill('Nibble');
  const d = (await reviewState(page))?.desk as number;
  return { w, review, desk: d };
}

/** The one `worker.handoff` carries the hire: the task as typed (no path line), this browser's id. */
async function expectOneRequestWithHire(page: Page, w: Worker, task: string, d: number): Promise<string> {
  const asks = await sent(page, 'worker.handoff');
  expect(asks).toHaveLength(1);
  const hire = asks[0]?.args.hire as Record<string, unknown>;
  const origin = await page.evaluate(() => window.__h3d.handoffHires().origin);
  expect(asks[0]?.args).toMatchObject({ worker: w.id });
  expect(hire).toMatchObject({ floor: 'herdr-3d', desk_index: d, effort: 'high', label: 'Nibble', prompt: task, origin });
  return String(asks[0]?.args.op);
}

/** The new agent sits at the desk, once, with the composed task; the client never sent `worker.hire`. */
async function expectHiredOnce(page: Page, d: number, task: string): Promise<void> {
  await expect.poll(async () => (await desk(page, d))?.worker ?? null, { timeout: 20_000 }).not.toBeNull();
  const prompts = await page.evaluate(() => window.__h3d.simFirstPrompts());
  expect(prompts).toHaveLength(1);
  expect(prompts[0]?.prompt).toMatch(new RegExp(`^First read the handoff here: /home/u/handoff/herdr-3d/[^\\n]+\\.md and then follow these instructions:\\n\\n${task}$`));
  expect(prompts[0]?.prompt).not.toContain('.pending');
  expect(await sent(page, 'worker.hire')).toHaveLength(0);
}

test('agent, Hire in background on: the review closes on the ack; you play on; filed by the agent, the bridge hires once', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await probe(page, { background: true });
  const { w, review, desk: d } = await toReview(page, 'agent', 'Fix the issue');
  await forgetToasts(page);
  await review.getByRole('button', { name: 'File handoff and hire' }).click();
  await expect(review).toBeHidden();
  await expect.poll(() => toasts(page)).toEqual([WRITING(d)]);
  const op = await expectOneRequestWithHire(page, w, 'Fix the issue', d);
  // Held for every client, the source's card says where; nobody else hires into it.
  await expect.poll(async () => (await desk(page, d))?.plus).toBe(false);
  expect((await desk(page, d))?.worker ?? null).toBeNull();
  // You play on: stand up, open another dialog, close it.
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
  await frames(page, 6);
  await expect.poll(async () => (await card(page, 'Pebble'))?.task).toBe(`Writing handoff → hires at Desk ${d + 1}`);
  expect((await card(page, 'Pebble'))?.tape?.text).toBe('HANDOFF');
  await shot(page, 'h219-held-desk');
  await page.evaluate(() => window.__h3d.openCabinet());
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.cabinet()))?.open).toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.cabinet()))?.open ?? false).toBe(false);
  expect(await beeps(page)).toBe(0);
  // The agent files it: the bridge hires, once.
  expect((await sim(page, 'sim.agent_turn', { id: w.id, text: '# Review follow-ups\n\nTwo comments left.\n' })).ok).toBe(true);
  await expectHiredOnce(page, d, 'Fix the issue');
  await expect.poll(() => said(page)).toEqual([WRITING(d), SPAWNED]);
  await expect.poll(() => beeps(page)).toBe(1);
  expect((await records(page)).find((r) => r.op === op)).toMatchObject({ state: 'hired', prompted: true });
  await expect.poll(async () => (await card(page, 'Pebble'))?.task).not.toContain('Writing handoff');
  // A repeated update or a reconnect says nothing again and hires nobody else.
  await page.waitForTimeout(2000);
  expect(await said(page)).toEqual([WRITING(d), SPAWNED]);
  expect(await beeps(page)).toBe(1);
  expect(await page.evaluate(() => window.__h3d.simFirstPrompts())).toHaveLength(1);
  clean();
});

test('LLM, Hire in background off: Continue in background keeps the hire running; the job files, the bridge hires once', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await probe(page, { background: false });
  const { w, review, desk: d } = await toReview(page, 'llm', 'Answer the comments');
  await review.getByRole('button', { name: 'File handoff and hire' }).click();
  await expect(review.locator('.dd-foot [role="status"]')).toContainText(`is writing the handoff… then Nibble is hired at Desk ${d + 1}.`);
  const cont = review.getByRole('button', { name: 'Continue in background' });
  await expect(cont).toBeVisible();
  await expect(review.getByRole('button', { name: 'Cancel request' })).toBeEnabled();
  await shot(page, 'h219-review-continue');
  await expectOneRequestWithHire(page, w, 'Answer the comments', d);
  await forgetToasts(page);
  await cont.click();
  await expect(review).toBeHidden();
  await expect.poll(() => toasts(page)).toEqual([WRITING(d)]);
  expect((await sim(page, 'sim.llm_finish', { id: w.id })).ok).toBe(true);
  await expectHiredOnce(page, d, 'Answer the comments');
  await expect.poll(() => said(page)).toEqual([WRITING(d), SPAWNED]);
  await expect.poll(() => beeps(page)).toBe(1);
  clean();
});

test('Cancel from the F dialog cancels the request and the hire; the task comes back through Review again', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await probe(page, { background: true });
  const { w, review, desk: d } = await toReview(page, 'agent', 'Fix the issue');
  await review.getByRole('button', { name: 'File handoff and hire' }).click();
  await expect(review).toBeHidden();
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
  await page.evaluate((id) => window.__h3d.openHandoff(id), w.id);
  const f = page.getByRole('dialog', { name: 'File a handoff from Pebble' });
  await expect(f.locator('[data-hook="ho-hire"]')).toContainText(`Then hires Nibble`);
  await expect(f.locator('[data-hook="ho-hire"]')).toContainText(`at Desk ${d + 1} once it is filed; the desk is held until then. Cancel request cancels the hire too.`);
  await shot(page, 'h219-fdialog-hire');
  await forgetToasts(page);
  await f.getByRole('button', { name: 'Cancel request and hire' }).click();
  await expect.poll(async () => (await records(page))[0]?.state).toBe('cancelled');
  // The F dialog is open: the task waits behind Review again.
  await expect.poll(async () => (await toasts(page)).at(-1) ?? '').toContain('Cancelled: nothing was filed and nobody was hired.');
  await expect.poll(async () => (await desk(page, d))?.plus).toBe(true);
  await page.keyboard.press('Escape');
  await expect(f).toBeHidden();
  await page.locator('.toast').getByRole('button', { name: 'Review again' }).click();
  await expect(page.getByRole('dialog', { name: /^Hire with a handoff at Desk/ })).toBeVisible();
  expect((await reviewState(page))?.form?.prompt).toBe('Fix the issue');
  expect(await sent(page, 'worker.hire')).toHaveLength(0);
  expect(await page.evaluate(() => window.__h3d.simFirstPrompts())).toHaveLength(0);
  clean();
});

test('a hire refused after filing: nobody hired, the task comes back with the path; Hire again hires only', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await probe(page, { background: true });
  const { w, review, desk: d } = await toReview(page, 'agent', 'Fix the issue');
  await review.getByRole('button', { name: 'File handoff and hire' }).click();
  await expect(review).toBeHidden();
  expect((await sim(page, 'sim.handoff_hire', { fail: 'desk_taken' })).ok).toBe(true);
  expect((await sim(page, 'sim.agent_turn', { id: w.id })).ok).toBe(true);
  // Nothing else open: the review opens again with the task, the filed path and the reason.
  await expect(review).toBeVisible();
  const s = await reviewState(page);
  expect(s?.form?.prompt).toBe('Fix the issue');
  expect(s?.handoff?.filed).toMatch(/^\/home\/u\/handoff\/herdr-3d\/.+\.md$/);
  expect(s?.status).toContain(`The handoff is saved at ${s?.handoff?.filed}. Desk ${d + 1} of`);
  expect(s?.status).toContain('Hire again hires only: the handoff is not made again.');
  await shot(page, 'h219-giveback');
  expect(await sent(page, 'worker.hire')).toHaveLength(0);
  await review.getByRole('button', { name: 'Hire Nibble' }).click();
  await expect.poll(async () => (await sent(page, 'worker.hire')).length).toBe(1);
  expect(String((await sent(page, 'worker.hire'))[0]?.args.prompt)).toBe(`First read the handoff here: ${s?.handoff?.filed} and then follow these instructions:\n\nFix the issue`);
  expect(await sent(page, 'worker.handoff')).toHaveLength(1);
  clean();
});

test('reload while it is written: the hold and the card line come back; filed, the bridge hires; said once, also after another reload', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  await probe(page, { background: true });
  const { w, review, desk: d } = await toReview(page, 'agent', 'Fix the issue', `&simkeep=${unique()}`);
  await review.getByRole('button', { name: 'File handoff and hire' }).click();
  await expect(review).toBeHidden();
  await expect.poll(async () => (await records(page)).length).toBe(1);
  await page.reload();
  await page.waitForFunction(() => window.__h3d?.ready && window.__h3d.frames >= 3);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 6);
  // A player back at the page (a key: the browser lets the success beep play).
  await page.keyboard.press('Shift');
  expect((await records(page))[0]).toMatchObject({ state: 'waiting', desk_index: d });
  await expect.poll(async () => (await desk(page, d))?.plus).toBe(false);
  // The cards drawn are the nearest ones: look at Pebble.
  expect(await page.evaluate((id) => window.__h3d.face(id), w.id)).toBe(true);
  await frames(page, 6);
  await expect.poll(async () => (await card(page, 'Pebble'))?.task).toBe(`Writing handoff → hires at Desk ${d + 1}`);
  expect((await sim(page, 'sim.agent_turn', { id: w.id })).ok).toBe(true);
  await expect.poll(async () => (await desk(page, d))?.worker ?? null, { timeout: 20_000 }).not.toBeNull();
  await expect.poll(() => said(page)).toEqual([SPAWNED]);
  await expect.poll(() => beeps(page)).toBe(1);
  // Another reload: the hire is said already.
  await page.reload();
  await page.waitForFunction(() => window.__h3d?.ready && window.__h3d.frames >= 3);
  await page.waitForTimeout(2500);
  expect(await said(page)).toEqual([]);
  expect(await beeps(page)).toBe(0);
  expect(await sent(page, 'worker.hire')).toHaveLength(0);
  expect(await page.evaluate(() => window.__h3d.simFirstPrompts())).toHaveLength(1);
  clean();
});
