import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, watchErrors } from './game';

// #212 on demo-m4 (simulator on a manual clock): the review of a dictated hire, opened with a fixture interpretation (the
// dictation bar is phase 4). Nothing is sent until Hire: opening, picking, folding a section and pressing Enter in a field
// send no `worker.hire`; Hire sends exactly one, with the reviewed values, and a second press none.

const SIM = 'play=none&sim=1&simms=150&simusage=0&simclock=manual';

const dialog = (page: Page) => page.evaluate(() => window.__h3d.dialog());
const hires = async (page: Page) => (await page.evaluate(() => window.__h3d.sent())).filter((c) => c.t === 'worker.hire');

test('the review opens collapsed or open as its values say, and only Hire hires', async ({ page }, info) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', SIM);
  await page.evaluate(() => window.__h3d.enterFloor('pastry'));
  await frames(page, 3);

  // What the catalog offers: read it from the hire dialog's own form (its choices are the floor's default).
  await page.evaluate(() => window.__h3d.openHire(14));
  await expect.poll(async () => (await dialog(page))?.kind === 'hire' && (await dialog(page))?.state, { timeout: 10_000 }).toBe('ready');
  const form = ((await dialog(page)) as { form: { harness: string; model: string } }).form;
  await page.keyboard.press('Escape');
  expect(await dialog(page)).toBeNull();

  const interp = {
    sources: ['Hire an agent. Task: fix the login bug.'],
    harness: { provenance: 'dictated', value: form.harness },
    model: { provenance: 'resolved', value: form.model },
    effort: { provenance: 'missing' },
    task: { provenance: 'dictated', value: 'fix the login bug.', span: { source: 0, start: 17, end: 35 } },
    questions: [{ field: 'effort', text: 'What effort level should this agent use?' }],
    ready_for_review: false,
  } as const;
  expect(await page.evaluate((i) => window.__h3d.openHireReview(i as never, 14), interp)).toBe(true);
  await expect.poll(async () => (await dialog(page))?.kind === 'hire-review' && (await dialog(page))?.state, { timeout: 10_000 }).toBe('ready');

  const sections = async () => ((await dialog(page)) as { sections: Array<{ id: string; open: boolean }> }).sections;
  expect((await sections()).map((s) => [s.id, s.open])).toEqual([['agent', false], ['effort', true], ['task', false], ['where', false]]);
  const hire = page.getByRole('button', { name: /^Hire/ });
  await expect(hire).toBeDisabled();
  await expect(page.locator('[data-pick="effort"] input:checked')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('review-desktop.png') });

  // Opening, folding and Enter in fields: no hire.
  await page.locator('[data-key="sec:agent"]').click();
  await page.locator('[data-key="sec:where"]').click();
  expect((await sections()).filter((s) => s.open).map((s) => s.id)).toEqual(['agent', 'effort', 'where']);
  await page.locator('#review-label').press('Enter');
  await page.locator('#review-cwd').press('Enter');
  await page.locator('[data-key="sec:task"]').click();
  await page.locator('#review-task').press('Enter');
  expect(await hires(page)).toHaveLength(0);

  // The effort is the human's to pick; then Hire is possible and sends once.
  const levels = page.locator('[data-pick="effort"] label');
  await levels.first().click();
  await expect(hire).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 780 });
  await page.screenshot({ path: info.outputPath('review-phone.png') });
  await page.setViewportSize({ width: 1280, height: 800 });
  await hire.click();
  await hire.click({ force: true }).catch(() => {});
  await expect.poll(async () => (await hires(page)).length).toBe(1);
  const sent = (await hires(page))[0] as { args: Record<string, unknown> };
  expect(sent.args).toMatchObject({ session: 'pastry', desk_index: 14, harness: form.harness, model: form.model, prompt: 'fix the login bug.' });
  expect(typeof sent.args.effort).toBe('string');
  expect(await hires(page)).toHaveLength(1);
  clean();
});
