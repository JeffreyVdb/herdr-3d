import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expectCommandDone, frames, openGame, watchErrors, openMenu } from './game';

// #51 on demo-m4 and the simulating fixture server: dialogs never close by accident (a press inside released on the
// backdrop, a plain backdrop click), the hire dialog keeps what was typed until a hire is acknowledged, and it is a
// near-full-screen sheet with a readable model list. `H3D_EVIDENCE_DIR` also saves the layout screenshots there.

const SIM = 'play=none&sim=1&simms=150';

type Dialog = NonNullable<ReturnType<Window['__h3d']['dialog']>>;
type Hire = Extract<Dialog, { kind: 'hire' }>;

const dialog = (page: Page) => page.evaluate(() => window.__h3d.dialog());
const sent = (page: Page) => page.evaluate(() => window.__h3d.sent());
const hireDlg = (page: Page) => page.locator('dialog.desk-dlg--hire');

async function hireDialog(page: Page): Promise<Hire> {
  await expect.poll(async () => (await dialog(page))?.kind === 'hire' && (await dialog(page))?.state, { message: 'hire dialog ready', timeout: 10_000 }).toBe('ready');
  return (await dialog(page)) as Hire;
}

async function onFloor(page: Page, wsQuery = SIM): Promise<void> {
  await openGame(page, 'demo-m4', '', wsQuery);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
}

/** The first two desks of the floor with no worker (the "+" is there). */
async function freeDesks(page: Page): Promise<[number, number]> {
  const free = (await page.evaluate(() => window.__h3d.desks())).filter((d) => d.plus).map((d) => d.desk);
  expect(free.length).toBeGreaterThan(1);
  return [free[0]!, free[1]!];
}

async function openHire(page: Page, desk = 5): Promise<Hire> {
  await page.evaluate((d) => window.__h3d.openHire(d), desk);
  return hireDialog(page);
}

/** How much of a text box is selected: a textarea's own selection, or (the composer is a contenteditable) the document's when it is inside. */
const selected = (box: Locator) =>
  box.evaluate((e) => {
    if (e instanceof HTMLTextAreaElement) return e.selectionEnd - e.selectionStart;
    const s = getSelection();
    return s && s.anchorNode && e.contains(s.anchorNode) && e.contains(s.focusNode) ? s.toString().length : 0;
  });
/** What the first task reads as (images as `[Image #n]`), from the dialog's own summary. */
const taskText = async (page: Page) => ((await dialog(page)) as Hire).form.prompt;

/** A real mouse gesture: press on the first line of `box`, drag out to (x, y), release. */
async function dragOut(page: Page, box: Locator, x: number, y: number): Promise<void> {
  const b = (await box.boundingBox())!;
  await page.mouse.move(b.x + 70, b.y + 20);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 14 });
  await page.mouse.up();
}

test('hire: a press in the task released on the backdrop keeps the dialog, the text and the selection', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await onFloor(page);
  await openHire(page);
  const task = page.locator('#hire-task');
  const text = 'Rework the header so it no longer overlaps the logo on mobile.\nThen check the footer.';
  await task.fill(text);
  const d = (await hireDlg(page).boundingBox())!;
  // Out past the dialog's left edge, and out past its top edge.
  for (const [x, y] of [[3, d.y + 60], [d.x + 200, 3]] as const) {
    // A press on selected text starts dragging it (the composer refuses that): collapse the last selection first.
    await task.press('Control+End');
    await dragOut(page, task, x, y);
    await expect(hireDlg(page)).toBeVisible();
    expect(await taskText(page)).toBe(text);
    expect(await selected(task)).toBeGreaterThan(0);
    expect(((await dialog(page)) as Hire).form.prompt).toBe(text);
  }
  expect((await sent(page)).filter((c) => c.t === 'worker.hire')).toHaveLength(0);
  clean();
});

test('hire: a plain backdrop click does nothing; the close button and Esc close it', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await onFloor(page);
  await openHire(page);
  await page.mouse.click(4, 4);
  await page.mouse.click(1276, 716);
  await expect(hireDlg(page)).toBeVisible();
  await hireDlg(page).locator('[data-key="close"]').click();
  await expect(hireDlg(page)).toBeHidden();
  await openHire(page);
  await page.keyboard.press('Escape');
  await expect(hireDlg(page)).toBeHidden();
  clean();
});

test('hire: what was typed comes back for the desk, until a hire is acknowledged', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await onFloor(page);
  const [one, two] = await freeDesks(page);
  const stored = (desk: number) => page.evaluate((k) => localStorage.getItem(`h3d.draft.hire.${k}`), `herdr-3d:${desk}`);
  await openHire(page, one);
  await page.locator('#hire-task').fill('Draft for the first desk');
  await page.locator('#hire-label').fill('Nibble');
  await page.keyboard.press('Escape');
  await expect(hireDlg(page)).toBeHidden();
  // Same desk: back as it was. Another desk: its own (empty) draft.
  let d = await openHire(page, one);
  expect(d.form).toMatchObject({ prompt: 'Draft for the first desk', label: 'Nibble' });
  expect(await taskText(page)).toBe('Draft for the first desk');
  await expect(page.locator('#hire-task')).toHaveText('Draft for the first desk');
  await page.keyboard.press('Escape');
  d = await openHire(page, two);
  expect(d.form.prompt).toBe('');
  await page.keyboard.press('Escape');
  await expect(hireDlg(page)).toBeHidden();
  // It survives a reload too (localStorage).
  expect(await stored(one)).toContain('Draft for the first desk');
  await onFloor(page);
  d = await openHire(page, one);
  expect(d.form).toMatchObject({ prompt: 'Draft for the first desk', label: 'Nibble' });
  // Hire: acknowledged, the draft goes.
  await page.locator('#hire-task').focus();
  await page.keyboard.press('Enter');
  await expectCommandDone(page, 'worker.hire');
  expect((await sent(page)).filter((c) => c.t === 'worker.hire')).toHaveLength(1);
  await expect.poll(() => stored(one)).toBeNull();
  clean();
});

test('hire: a failed hire keeps the draft', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await onFloor(page, `${SIM}&simfail=hire_failed`);
  await openHire(page, 5);
  await page.locator('#hire-task').fill('Do not lose me');
  await page.keyboard.press('Enter');
  await expect(hireDlg(page).locator('.dd-status--error')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(hireDlg(page)).toBeHidden();
  const d = await openHire(page, 5);
  expect(d.form.prompt).toBe('Do not lose me');
  clean();
});

test('the other typed-text dialogs never close from the backdrop either (start-run, presets, the P prompt)', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await onFloor(page);

  // Start-run: extra instructions.
  await page.evaluate(() => window.__h3d.openStartRun({ floor: 'herdr-3d', desk: 5 }));
  await expect.poll(async () => (await dialog(page))?.kind === 'start-run' && (await dialog(page))?.state).toBe('ready');
  const run = page.locator('dialog.desk-dlg--run');
  const extra = page.locator('#run-extra');
  await extra.fill('Scope: the header only. Keep the footer as it is.');
  await dragOut(page, extra, 4, 4);
  await expect(run).toBeVisible();
  await expect(extra).toHaveText('Scope: the header only. Keep the footer as it is.');
  expect(await selected(extra)).toBeGreaterThan(0);
  await page.mouse.click(4, 4);
  await expect(run).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(run).toBeHidden();

  // Presets: a plain backdrop click.
  await page.evaluate(() => window.__h3d.openPresets());
  const presets = page.locator('dialog.desk-dlg--presets');
  await expect(presets).toBeVisible();
  const pb = (await presets.boundingBox())!;
  await page.mouse.click(4, 4);
  await page.mouse.click(pb.x + pb.width + 6, pb.y + 30);
  await expect(presets).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(presets).toBeHidden();

  // The P prompt to a worker.
  const id = await page.evaluate(() => window.__h3d.world().find((f) => f.session === 'herdr-3d')!.workers[0]!.id);
  await page.evaluate((w) => window.__h3d.openPrompt(w), id);
  const prompt = page.locator('dialog.desk-dlg--prompt');
  await expect(prompt).toBeVisible();
  const text = page.locator('#prompt-text');
  await text.fill('Please look at the header overlap on mobile.');
  await dragOut(page, text, 4, 4);
  await expect(prompt).toBeVisible();
  await expect(text).toHaveText('Please look at the header overlap on mobile.');
  expect(await selected(text)).toBeGreaterThan(0);
  await page.mouse.click(4, 4);
  await expect(prompt).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(prompt).toBeHidden();
  clean();
});

test('a read-only sheet (About) closes on a real backdrop click, not on a drag that started inside', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page);
  await openMenu(page);
  await page.getByRole('button', { name: 'About' }).click();
  const about = page.getByRole('dialog', { name: 'About' });
  await expect(about).toBeVisible();
  const b = (await about.boundingBox())!;
  // Press inside, release on the backdrop: stays.
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(4, 4, { steps: 10 });
  await page.mouse.up();
  await expect(about).toBeVisible();
  // Press on the backdrop, release inside: stays.
  await page.mouse.move(4, 4);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(about).toBeVisible();
  // Press and release on the backdrop: closes.
  await page.mouse.click(4, 4);
  await expect(about).toBeHidden();
  clean();
});

// ---- the layout ------------------------------------------------------------------------------------------------------

async function shotTo(page: Page, name: string): Promise<void> {
  const dir = process.env.H3D_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: resolve(dir, `${name}.png`) });
}

/** Everything the user needs to press is on screen: close, the editor, Hire and Cancel. */
async function reachable(page: Page, editor = true): Promise<void> {
  // (On a phone the body scrolls, so after scrolling to the options the editor may be out of view: the actions never are.)
  for (const sel of ['[data-key="close"]', ...(editor ? ['#hire-task'] : []), '[data-key="hire"]', '[data-key="cancel"]']) await expect(hireDlg(page).locator(sel)).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await hireDlg(page).evaluate((d) => d.scrollWidth <= d.clientWidth)).toBe(true);
}

for (const vp of [
  { name: '1280x720', width: 1280, height: 720 },
  { name: '1024x640', width: 1024, height: 640 },
  { name: '375x667', width: 375, height: 667 },
]) {
  test(`hire is a near-full-screen sheet with a readable long model list at ${vp.name}`, async ({ page }) => {
    test.setTimeout(120_000);
    const clean = watchErrors(page);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await onFloor(page, `${SIM}&simmodels=24&simlimits=hot`);
    await openHire(page);
    await page.locator('#hire-task').fill('Rework the header so it no longer overlaps the logo on mobile, and check the footer.\n\nScope: the top bar only.');
    const box = (await hireDlg(page).boundingBox())!;
    // It fills the viewport, minus a small gutter (none on a phone).
    expect(box.width).toBeGreaterThanOrEqual(vp.width - 26);
    expect(box.height).toBeGreaterThanOrEqual(vp.height - 26);
    // The editor is the big thing: no 180 px cap.
    const ed = (await page.locator('#hire-task').boundingBox())!;
    expect(ed.height).toBeGreaterThan(vp.width < 760 ? 150 : 250);
    // Long list: a filter and every model in the DOM as a radio.
    const n = await page.locator('[data-pick="model"] input[type="radio"]').count();
    expect(n).toBeGreaterThanOrEqual(24);
    await expect(page.locator('[data-key="model-search"]')).toBeVisible();
    await expect(page.locator('[data-pick="model"] .dd-count')).toHaveText(String(n));
    if (vp.width >= 760) {
      // Editor left, options right; the model chips run in several columns (no tiny scroll box).
      const opt = (await page.locator('.hire-options-pane').boundingBox())!;
      expect(opt.x).toBeGreaterThan(ed.x + ed.width - 1);
      const xs = await page.locator('[data-pick="model"] .dd-chip').evaluateAll((els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().left))).size);
      expect(xs).toBeGreaterThan(1);
    } else {
      // One column: the options under the editor.
      const opt = (await page.locator('.hire-options-pane').boundingBox())!;
      expect(opt.y).toBeGreaterThanOrEqual(ed.y + ed.height - 1);
    }
    await reachable(page);
    await shotTo(page, `hire-${vp.name}`);
    // Filtering: Enter does not hire, Esc clears the filter first (and does not close the dialog).
    const search = page.locator('[data-key="model-search"]');
    await search.fill('lab-1');
    await expect(page.locator('[data-pick="model"] .dd-count')).toHaveText(`10 of ${n}`);
    await search.press('Enter');
    expect((await sent(page)).filter((c) => c.t === 'worker.hire')).toHaveLength(0);
    await shotTo(page, `hire-${vp.name}-filtered`);
    await search.press('Escape');
    await expect(hireDlg(page)).toBeVisible();
    await expect(search).toHaveValue('');
    await expect(page.locator('[data-pick="model"] .dd-count')).toHaveText(String(n));
    // Picking one keeps the filter box and the choice.
    await page.locator('label.dd-chip', { has: page.locator('[data-key="model:claude-lab-07"]') }).click();
    expect(((await dialog(page)) as Hire).form.model).toBe('claude-lab-07');
    await reachable(page, false);
    clean();
  });
}

test('the editor grows with the window, and the plate steps out of the hire dialog', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await onFloor(page, `${SIM}&simlimits=ok`);
  await openHire(page);
  const small = (await page.locator('#hire-task').boundingBox())!.height;
  await page.setViewportSize({ width: 1280, height: 1000 });
  await expect.poll(async () => (await page.locator('#hire-task').boundingBox())!.height).toBeGreaterThan(small + 200);
  // #51: hire is a screen dialog for the limits widget: no gutter for a tab, so it is away; the dialog carries the limits inline.
  await expect(page.locator('.limits')).toHaveAttribute('data-dock', 'away');
  await expect(page.locator('[data-hook="plan-limits"] .lm-line')).toHaveCount(1);
  // Shift+L peeks the plate over the dialog, and leaves the close button reachable.
  await page.locator('#hire-task').evaluate((e) => (e as HTMLElement).blur()); // in the text box Shift+L types an L
  await page.keyboard.press('Shift+L');
  await expect(page.locator('.limits')).toBeVisible();
  clean();
});
