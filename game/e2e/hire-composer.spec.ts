import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { frames, openGame, RESULTS, watchErrors } from './game';

// #51 part 3: the shared composer inside the real hire dialog (built game, fixture server with sim=1 and the fixture
// POST /upload). Paste is a real ClipboardEvent carrying PNG Files, typing and keys are real keyboard input.
// `H3D_EVIDENCE_DIR` says where the screenshots go (default: test-results/hire-composer).

const EVIDENCE = process.env.H3D_EVIDENCE_DIR ?? resolve(RESULTS, 'hire-composer');
mkdirSync(EVIDENCE, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: resolve(EVIDENCE, `${name}.png`) });

const SIM = 'play=none&sim=1&simms=150';
const unique = () => `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const DROP = /\/home\/fixture\/drops\/2026-09\/h3d-[a-z0-9-]+-(\d+)\.png/;

type Dialog = NonNullable<ReturnType<Window['__h3d']['dialog']>>;
type Hire = Extract<Dialog, { kind: 'hire' }>;

const dialog = (page: Page) => page.evaluate(() => window.__h3d.dialog());
const sent = (page: Page) => page.evaluate(() => window.__h3d.sent());
const hires = async (page: Page) => (await sent(page)).filter((c) => c.t === 'worker.hire');
const hireDlg = (page: Page) => page.locator('dialog.desk-dlg--hire');
const lightbox = (page: Page) => page.locator('dialog.cmp-lightbox[open]');
const editor = (page: Page) => page.locator('#hire-task');
const chips = (page: Page) => hireDlg(page).locator('.cmp-chip');
const summary = async (page: Page) => (await dialog(page)) as Hire;

async function onFloor(page: Page, extra = ''): Promise<{ key: string }> {
  const key = unique();
  await openGame(page, 'demo-m4', '', `${SIM}&upload_key=${key}${extra}`);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  return { key };
}

async function openHire(page: Page, desk = 5): Promise<Hire> {
  await page.evaluate((d) => window.__h3d.openHire(d), desk);
  await expect.poll(async () => (await dialog(page))?.kind === 'hire' && (await dialog(page))?.state, { timeout: 10_000 }).toBe('ready');
  await expect(editor(page)).toBeFocused();
  return summary(page);
}

interface Img {
  name: string;
  w?: number;
  h?: number;
  color?: string;
}

/** A real paste at the caret: a ClipboardEvent whose DataTransfer holds PNG files (drawn here, so thumbnails have pixels). */
async function paste(page: Page, files: Img[]): Promise<void> {
  await page.evaluate(
    async ({ files }) => {
      const dt = new DataTransfer();
      for (const f of files) {
        const c = document.createElement('canvas');
        c.width = f.w ?? 640;
        c.height = f.h ?? 360;
        const g = c.getContext('2d') as CanvasRenderingContext2D;
        g.fillStyle = f.color ?? '#2f6bf0';
        g.fillRect(0, 0, c.width, c.height);
        g.fillStyle = '#ffffff';
        g.fillRect(c.width * 0.1, c.height * 0.1, c.width * 0.3, c.height * 0.8);
        g.font = `bold ${Math.round(c.height / 8)}px sans-serif`;
        g.fillText(f.name, c.width * 0.45, c.height / 2);
        const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b as Blob), 'image/png'));
        dt.items.add(new File([blob], f.name, { type: 'image/png' }));
      }
      (document.querySelector('#hire-task') as HTMLElement).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    { files },
  );
}

/** The editor's children in order: `text:…` and `chip:<name>`. */
const layout = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    [...(document.querySelector('#hire-task') as HTMLElement).childNodes].flatMap((n) => {
      if (n.nodeType === 3) {
        const t = (n as Text).data.replace(/​/g, '');
        return t ? [`text:${t}`] : [];
      }
      const el = n as HTMLElement;
      return el.classList.contains('cmp-chip') ? [`chip:${el.querySelector('.cmp-name')?.textContent}`] : [];
    }),
  );

const left = async (page: Page, n: number) => {
  for (let i = 0; i < n; i++) await page.keyboard.press('ArrowLeft');
};
const stored = (page: Page, desk: number) => page.evaluate((k) => localStorage.getItem(`h3d.draft.hire.${k}`), `herdr-3d:${desk}`);

test('a pasted screenshot lands inline at the caret; the enlarged view closes by button, Esc and the surface, one layer at a time', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await onFloor(page, '&simlimits=hot');
  await openHire(page);
  await page.keyboard.type('Rework the header so it no longer overlaps the logo');
  await left(page, 18);
  await paste(page, [{ name: 'shot-a.png' }, { name: 'shot-b.png', color: '#12a26a' }]);
  await page.keyboard.type('!');
  const layoutBefore = await layout(page);
  expect(layoutBefore).toEqual(['text:Rework the header so it no longer', 'chip:shot-a.png', 'chip:shot-b.png', 'text:! overlaps the logo']);
  expect(layoutBefore.filter((x) => x.startsWith('chip:'))).toEqual(['chip:shot-a.png', 'chip:shot-b.png']);
  const first = chips(page).first();
  await expect(first.locator('img')).toBeVisible();
  await expect(first.locator('.cmp-state')).toHaveText('Uploaded');
  // Inline: on the same line as the text, not in a strip below.
  const geo = await page.evaluate(() => {
    const e = document.querySelector('#hire-task') as HTMLElement;
    const c = (e.querySelector('.cmp-chip') as HTMLElement).getBoundingClientRect();
    const t = document.createRange();
    t.selectNodeContents(e.firstChild as Text);
    const r = t.getBoundingClientRect();
    return { chipMid: (c.top + c.bottom) / 2, textTop: r.top, textBottom: r.bottom, textRight: r.right, chipLeft: c.left };
  });
  expect(geo.chipMid).toBeGreaterThan(geo.textTop - 14);
  expect(geo.chipMid).toBeLessThan(geo.textBottom + 14);
  expect(geo.chipLeft).toBeGreaterThanOrEqual(geo.textRight - 1);
  await shot(page, '01-hire-inline-thumbnails-1280x720');

  const before = await summary(page);
  const sel = await page.evaluate(() => {
    const s = getSelection()!;
    return { a: s.anchorOffset, f: s.focusOffset };
  });
  const backToPrompt = async (how: string) => {
    await expect(lightbox(page), how).toHaveCount(0);
    await expect(hireDlg(page), how).toBeVisible();
    await expect(editor(page), how).toBeFocused();
    expect(await layout(page), how).toEqual(layoutBefore);
    expect((await summary(page)).form.prompt, how).toBe(before.form.prompt);
    expect((await summary(page)).images.map((i) => i.name), how).toEqual(['shot-a.png', 'shot-b.png']);
    expect(await page.evaluate(() => ({ a: getSelection()!.anchorOffset, f: getSelection()!.focusOffset })), how).toEqual(sel);
    expect(await hires(page), how).toHaveLength(0);
  };

  // The thumbnail opens it above the dialog, enlarged.
  await first.locator('.cmp-thumb').click();
  await expect(lightbox(page)).toBeVisible();
  const box = (await lightbox(page).locator('img').boundingBox())!;
  expect(box.width).toBeGreaterThan(400);
  await expect(lightbox(page).locator('.cmp-lb-close')).toBeFocused();
  await shot(page, '02-hire-lightbox-open');
  await lightbox(page).locator('.cmp-lb-close').click();
  await backToPrompt('close button');

  // Esc closes only the enlarged view; the next Esc closes the dialog.
  await chips(page).nth(1).locator('.cmp-thumb').click();
  await expect(lightbox(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await backToPrompt('Esc');

  // A click outside the image (the empty surface).
  await first.locator('.cmp-thumb').click();
  await expect(lightbox(page)).toBeVisible();
  await page.mouse.click(30, 360);
  await backToPrompt('click outside');

  // Shift+L in the editor types an L (the limits plate is not peeked).
  await page.keyboard.press('Shift+L');
  expect((await summary(page)).form.prompt).toContain('!L');
  await expect(page.locator('.limits')).toHaveAttribute('data-dock', 'away');

  // Now Esc is the dialog's.
  await page.keyboard.press('Escape');
  await expect(hireDlg(page)).toBeHidden();
  clean();
});

test('a held Esc closes only the enlarged view in the hire dialog; a fresh press then closes the dialog', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await onFloor(page);
  await openHire(page);
  await paste(page, [{ name: 'shot-a.png' }]);
  await chips(page).first().locator('.cmp-thumb').click();
  await expect(lightbox(page)).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  const key = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key });
  await expect(lightbox(page)).toHaveCount(0);
  for (let i = 0; i < 5; i++) await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', autoRepeat: true, ...key });
  await page.waitForTimeout(100);
  await expect(hireDlg(page)).toBeVisible();
  await expect(editor(page)).toBeFocused();
  expect((await summary(page)).images.map((i) => i.name)).toEqual(['shot-a.png']);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  await page.keyboard.press('Escape');
  await expect(hireDlg(page)).toBeHidden();
  clean();
});

test('hire with two pasted images sends both markers in document order, with the paths Drop Zone gave', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await onFloor(page);
  await openHire(page);
  await page.keyboard.type('aaa bbb ccc');
  // The first paste goes at the end, the second before "bbb": document order is not upload order.
  await paste(page, [{ name: 'first.png' }]);
  await left(page, 11);
  await paste(page, [{ name: 'second.png', color: '#e8413a' }]);
  await expect(chips(page).locator('.cmp-state')).toHaveText(['Uploaded', 'Uploaded']);
  expect(await layout(page)).toEqual(['text:a', 'chip:second.png', 'text:aa bbb ccc', 'chip:first.png']);
  await editor(page).press('Enter');
  await expect.poll(async () => (await hires(page)).length).toBe(1);
  const args = (await hires(page))[0]!.args as { prompt: string };
  // second.png was the second upload (n=2), first.png the first (n=1); in the text second comes first and is #1.
  expect(args.prompt).toMatch(/^a\[Image #1: \/home\/fixture\/drops\/2026-09\/h3d-[a-z0-9-]+-2\.png\]aa bbb ccc\[Image #2: \/home\/fixture\/drops\/2026-09\/h3d-[a-z0-9-]+-1\.png\]$/);
  await expect.poll(() => dialog(page)).toBeNull();
  clean();
});

test('an image alone is a valid first task', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await onFloor(page);
  await openHire(page);
  await paste(page, [{ name: 'only.png' }]);
  await expect(chips(page).locator('.cmp-state')).toHaveText('Uploaded');
  expect((await summary(page)).blocker).toBeNull();
  await editor(page).press('Enter');
  await expect.poll(async () => (await hires(page)).length).toBe(1);
  expect(((await hires(page))[0]!.args as { prompt: string }).prompt).toMatch(new RegExp(`^\\[Image #1: ${DROP.source}\\]$`));
  clean();
});

test('a failed upload blocks the hire, keeps the prompt and shows a retry; then the retry and the hire go through', { tag: '@smoke' }, async ({ page }) => {
  test.setTimeout(120_000);
  // The forced failure is a real 502 the browser logs by itself: only script errors count here.
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const clean = () => expect(errors).toEqual([]);
  await page.setViewportSize({ width: 1280, height: 720 });
  const { key } = await onFloor(page, '&fail_upload=1');
  await openHire(page);
  await page.keyboard.type('look at this: ');
  await paste(page, [{ name: 'bad.png', color: '#e8413a' }, { name: 'good.png' }]);
  await page.keyboard.type(' thanks');
  const bad = chips(page).first();
  await expect(bad.locator('.cmp-state')).toContainText('Failed');
  await expect(chips(page).nth(1).locator('.cmp-state')).toHaveText('Uploaded');
  await expect(bad.locator('.cmp-retry')).toBeVisible();
  const text = (await summary(page)).form.prompt;

  await editor(page).press('Enter');
  // The dialog says why, nothing was sent, the prompt is whole and editable again.
  await expect(hireDlg(page).locator('.dd-status--error')).toContainText('did not upload');
  await expect(hireDlg(page).locator('.dd-status--error')).toContainText('Your prompt is kept');
  expect(await hires(page)).toHaveLength(0);
  const d = await summary(page);
  expect(d.state).toBe('ready');
  expect(d.form.prompt).toBe(text);
  expect(d.images.map((i) => i.status)).toEqual(['error', 'ready']);
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
  await shot(page, '03-hire-upload-failed');

  // Retry the one image (the fixture fails only the first upload): the message goes, the good one is not sent again.
  await bad.locator('.cmp-retry').click();
  await expect(bad.locator('.cmp-state')).toHaveText('Uploaded');
  await expect(hireDlg(page).locator('.dd-status--error')).toBeHidden();
  await editor(page).press('Enter');
  await expect.poll(async () => (await hires(page)).length).toBe(1);
  const prompt = ((await hires(page))[0]!.args as { prompt: string }).prompt;
  expect(prompt).toMatch(/^look at this: \[Image #1: [^\]]+\]\[Image #2: [^\]]+\] thanks$/);
  const log = (await page.evaluate(async (k) => (await fetch(`/upload/_log?upload_key=${k}`)).json(), key)).data as Array<{ result: string; n: number }>;
  expect(log.map((e) => e.result)).toEqual(['dropzone_unavailable', 'ok', 'ok']);
  await expect.poll(() => dialog(page)).toBeNull();
  clean();
});

test('images can be removed, several stay in order with the text around them', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await onFloor(page);
  await openHire(page);
  await page.keyboard.type('one ');
  await paste(page, [{ name: 'a.png' }]);
  await page.keyboard.type(' two ');
  await paste(page, [{ name: 'b.png', color: '#12a26a' }]);
  await page.keyboard.type(' three ');
  await paste(page, [{ name: 'c.png', color: '#5a5fa8' }]);
  await page.keyboard.type(' four');
  expect(await layout(page)).toEqual(['text:one ', 'chip:a.png', 'text: two ', 'chip:b.png', 'text: three ', 'chip:c.png', 'text: four']);
  await expect(chips(page).locator('.cmp-state')).toHaveText(['Uploaded', 'Uploaded', 'Uploaded']);
  // Remove the middle one with its button: the others keep their place and renumber.
  await chips(page).nth(1).locator('.cmp-remove').click();
  expect(await layout(page)).toEqual(['text:one ', 'chip:a.png', 'text: two  three ', 'chip:c.png', 'text: four']);
  await expect(chips(page).locator('.cmp-num')).toHaveText(['#1', '#2']);
  await editor(page).press('Enter');
  await expect.poll(async () => (await hires(page)).length).toBe(1);
  const prompt = ((await hires(page))[0]!.args as { prompt: string }).prompt;
  expect(prompt).toMatch(/^one \[Image #1: [^\]]+\] two {2}three \[Image #2: [^\]]+\] four$/);
  clean();
});

test('the desk keeps its draft, images too, across close and reopen and other desks; an acknowledged hire clears it, a failed one does not', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await onFloor(page);
  const desks = (await page.evaluate(() => window.__h3d.desks())).filter((d) => d.plus).map((d) => d.desk);
  const [one, two] = [desks[0]!, desks[1]!];
  await openHire(page, one);
  await page.keyboard.type('start ');
  await paste(page, [{ name: 'kept.png' }]);
  await page.keyboard.type(' end');
  const before = await layout(page);
  await expect(chips(page).locator('.cmp-state')).toHaveText('Uploaded');
  await page.keyboard.press('Escape');
  await expect(hireDlg(page)).toBeHidden();
  // The text is mirrored to localStorage (not the image).
  expect(await stored(page, one)).toContain('start  end');
  // Same desk: the same document, the image already uploaded; another desk: empty.
  const again = await openHire(page, one);
  expect(await layout(page)).toEqual(before);
  expect(again.images).toEqual([{ n: 1, name: 'kept.png', status: 'ready', path: expect.stringMatching(DROP) }]);
  await page.keyboard.press('Escape');
  const other = await openHire(page, two);
  expect(other.form.prompt).toBe('');
  await expect(chips(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  // Hire from the first desk: acknowledged, the draft goes (memory and storage).
  await openHire(page, one);
  await editor(page).press('Enter');
  await expect.poll(() => dialog(page)).toBeNull();
  expect(await hires(page)).toHaveLength(1);
  await expect.poll(() => stored(page, one)).toBeNull();
  // (Desk `one` has its worker now, so its dialog cannot reopen to show the empty draft: the store is the check.)
  clean();
});

test('a hire the bridge refuses keeps text and images', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await onFloor(page, '&simfail=hire_failed');
  await openHire(page, 5);
  await page.keyboard.type('keep me ');
  await paste(page, [{ name: 'keep.png' }]);
  await expect(chips(page).locator('.cmp-state')).toHaveText('Uploaded');
  await editor(page).press('Enter');
  await expect(hireDlg(page).locator('.dd-status--error')).toBeVisible();
  expect(await hires(page)).toHaveLength(1);
  await page.keyboard.press('Escape');
  const d = await openHire(page, 5);
  expect(d.form.prompt).toBe('keep me [Image #1]');
  expect(d.images.map((i) => i.status)).toEqual(['ready']);
  clean();
});

test('the tab strip, the model list and the limits plate still work with the composer; the lightbox is a nested modal that hands focus back', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await onFloor(page, '&simmodels=24&simlimits=hot');
  await openHire(page);
  await paste(page, [{ name: 'a.png' }]);
  await expect(chips(page).locator('.cmp-state')).toHaveText('Uploaded');
  // Model list: filter, pick.
  await expect(page.locator('[data-key="model-search"]')).toBeVisible();
  await page.locator('[data-key="model-search"]').fill('lab-1');
  await page.locator('label.dd-chip', { has: page.locator('[data-key="model:claude-lab-12"]') }).click();
  expect((await summary(page)).form.model).toBe('claude-lab-12');
  // Tab reaches the editor's chip buttons and the rest of the dialog; the lightbox traps focus and gives it back.
  await chips(page).first().locator('.cmp-thumb').focus();
  await page.keyboard.press('Enter');
  await expect(lightbox(page)).toBeVisible();
  for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.closest('dialog')?.classList.contains('cmp-lightbox'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(lightbox(page)).toHaveCount(0);
  await expect(hireDlg(page)).toBeVisible();
  await expect(page.locator('[data-key="tab:worker"]')).toBeVisible();
  // The limits plate: the dialog's own line stays; Shift+L (outside the editor) still peeks the plate over the dialog.
  await expect(page.locator('[data-hook="plan-limits"] .lm-line')).toHaveCount(1);
  await page.locator('[data-key="model-search"]').focus();
  await page.locator('[data-key="model-search"]').evaluate((e) => (e as HTMLElement).blur());
  await page.keyboard.press('Shift+L');
  await expect(page.locator('.limits')).toBeVisible();
  clean();
});

test('a hire dialog at a phone width keeps the thumbnails inline and the actions reachable', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 375, height: 667 });
  await onFloor(page, '&simlimits=ok');
  await openHire(page);
  await page.keyboard.type('Fix the header, see ');
  await paste(page, [{ name: 'screenshot-1.png' }]);
  await page.keyboard.type(' and ');
  await paste(page, [{ name: 'screenshot-2.png', color: '#12a26a' }]);
  await page.keyboard.type(' too');
  await expect(chips(page).locator('.cmp-state')).toHaveText(['Uploaded', 'Uploaded']);
  for (const sel of ['[data-key="close"]', '#hire-task', '[data-key="hire"]', '[data-key="cancel"]']) await expect(hireDlg(page).locator(sel)).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await hireDlg(page).evaluate((d) => d.scrollWidth <= d.clientWidth)).toBe(true);
  await shot(page, '04-hire-inline-thumbnails-375x667');
  clean();
});
