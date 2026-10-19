import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, shot, watchErrors } from './game';

// #26 (phase 5 of #20): a native child's own conversation, opened from its row on the floor overview, against the
// fixture bridge simulating the recorded children (`children-nested`, `sim=1`: Nibble over Ada, running, a long Codex
// conversation; Bell, idle; Curie, completed with no transcript; tools/fixture-children.ts, tools/fixture-transcript.ts).

const info = (page: Page) => page.evaluate(() => window.__h3d.overview());
const rows = async (page: Page) => (await info(page))?.page?.rows ?? [];
const tx = (page: Page) => page.evaluate(() => window.__h3d.transcript());
const childView = (page: Page) => page.locator('.seat-transcript .tx[data-child]');

async function onOffice(page: Page): Promise<void> {
  await openGame(page, 'children-nested', '', 'sim=1');
  await page.evaluate(() => window.__h3d.enterFloor('office'));
  await frames(page, 3);
}

/** Opens the floor overview's page and clicks the child named `name`; returns the worker's id and the child's row id. */
async function openChild(page: Page, name: string): Promise<{ worker: string; child: string }> {
  await page.keyboard.press('KeyO');
  await expect.poll(async () => (await info(page))?.page?.open).toBe(true);
  await expect(page.locator('.ov')).not.toHaveClass(/ov--enter/, { timeout: 5000 });
  await expect.poll(async () => (await rows(page)).some((r) => r.text.includes(name))).toBe(true);
  const r = await rows(page);
  const worker = (r.find((x) => x.kind === 'worker')?.key ?? '').replace(/^worker:/, '');
  const row = r.find((x) => x.kind === 'child' && x.text.includes(name));
  const child = (row?.key ?? '').replace(/^child:/, '');
  await page.locator(`.ov-row[data-key="${row?.key}"] .ov-name`).click();
  await expect.poll(() => page.evaluate(() => window.__h3d.seated()), { timeout: 20_000 }).not.toBeNull();
  return { worker: (await page.evaluate(() => window.__h3d.seated())) ?? worker, child };
}

test('a child row opens that child’s live conversation with a breadcrumb; older items load; Esc goes back to the worker’s, then stands up', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await onOffice(page);
  const { worker, child } = await openChild(page, 'Ada');
  await expect.poll(async () => (await tx(page))?.child).toMatchObject({ id: child, availability: 'available', items: 200, hasMore: true, mounted: true });
  expect((await tx(page))?.mode).toBe('transcript');
  const view = childView(page);
  await expect(view).toBeVisible();
  await expect(view.locator('.tx-crumb-back')).toHaveText('Nibble');
  await expect(view.locator('.tx-crumb-name')).toHaveText('Ada');
  await expect(view.locator('.tx-crumbs')).toHaveAttribute('data-state', 'running');
  await expect(view.locator('.tx-crumb-state')).toContainText('running');
  await expect(view.locator('.tx-prompt')).toBeHidden();
  await expect(view.locator('.tx-child-foot')).toContainText('Back to Nibble');
  // The seat bar says what Esc does here, and whose conversation you read.
  await expect(page.locator('.seat .seat-keys')).toContainText('Back to Nibble');
  await expect(page.locator('.seat .seat-note')).toHaveText('Reading Ada’s conversation');
  // The worker's own watch stays beside the child's.
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.simTranscripts()))?.ids.length).toBe(2);
  await shot(page, 'h26-child-open');

  // Live: what the child does next arrives on its own watch.
  const target = { id: child, generation: 1, provider: 'codex' };
  const r = await page.evaluate(
    (a) => window.__h3d.simTranscript({ id: a.worker, child: a.target, items: [{ id: 'ada-live', seq: 9999, ts: Date.now(), kind: 'assistant', parts: [{ text: 'Found it: the discrete GPU flag was already on.' }] }] }),
    { worker, target },
  );
  expect(r.ok).toBe(true);
  await expect(view.getByText('Found it: the discrete GPU flag was already on.')).toBeVisible();

  // Its older items, on request.
  await view.locator('.tx-older').click();
  await expect.poll(async () => (await tx(page))?.child?.items).toBeGreaterThan(201);
  await expect(view.locator('.tx-older')).toBeHidden();

  // Esc: back to the worker's conversation (its child watch goes), then a second Esc stands you up.
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await tx(page))?.child).toBeNull();
  await expect(childView(page)).toHaveCount(0);
  await expect(page.locator('.seat-transcript .tx')).toBeVisible();
  await expect(page.locator('.seat .seat-keys')).toContainText('Write a prompt');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.simTranscripts()))?.ids).toEqual([worker]);
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(worker);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
  clean();
});

test('a child with no transcript and one not written yet say so; it goes live; a replaced session returns to the worker', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await onOffice(page);
  // Curie completed, its transcript unavailable: an explicit state, not an error or another conversation.
  const curie = await openChild(page, 'Curie');
  await expect.poll(async () => (await tx(page))?.child).toMatchObject({ id: curie.child, availability: 'unavailable', items: 0 });
  await expect(childView(page).locator('.tx-empty')).toContainText('Curie has no conversation to show');
  await expect(childView(page).locator('.tx-crumbs')).toHaveAttribute('data-state', 'completed');
  await shot(page, 'h26-child-unavailable');
  await childView(page).locator('.tx-crumb-back').click();
  await expect.poll(async () => (await tx(page))?.child).toBeNull();
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();

  // A child just dispatched (no native id yet): pending.
  const worker = curie.worker;
  const dalton = { id: 'ch_00000000000000dd', provider: 'codex', worker_id: worker, agent_session: 'sess-n1', generation: 1, parent: 'root', name: 'Dalton', state: 'running', source: 'fixture', transcript: 'pending' };
  expect((await page.evaluate((c) => window.__h3d.simChild('sim.child', { child: c }), dalton)).ok).toBe(true);
  const d = await openChild(page, 'Dalton');
  expect(d.child).toBe(dalton.id);
  await expect.poll(async () => (await tx(page))?.child).toMatchObject({ id: dalton.id, availability: 'pending', items: 0 });
  await expect(childView(page).locator('.tx-empty')).toContainText('Dalton hasn’t written anything yet');
  await shot(page, 'h26-child-pending');

  // Named and written: the same watch goes live.
  await page.evaluate((c) => window.__h3d.simChild('sim.child', { child: { ...c, native_id: 'th-d', transcript: 'available' } }), dalton);
  await page.evaluate(
    (a) =>
      window.__h3d.simTranscript({
        id: a.worker,
        child: { id: a.id, generation: 1, provider: 'codex' },
        items: [{ id: 'd-1', seq: 1, ts: Date.now(), kind: 'user', parts: [{ text: 'Dalton: check the shader cache.' }] }],
        head: { harness: 'codex', session: 'th-d', version: '0.160.1', cursor: 'c:1', has_more: false, pending: false, availability: 'available' },
      }),
    { worker, id: dalton.id },
  );
  await expect.poll(async () => (await tx(page))?.child).toMatchObject({ availability: 'available', items: 1 });
  await expect(childView(page).getByText('Dalton: check the shader cache.')).toBeVisible();

  // The worker's session replaced: back to the worker's conversation, and the seat bar says why.
  await page.evaluate((id) => window.__h3d.simChild('sim.child_session', { id }), worker);
  await expect.poll(async () => (await tx(page))?.child).toBeNull();
  await expect(page.locator('.seat-note')).toContainText('started a new session');
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(worker);
  clean();
});
