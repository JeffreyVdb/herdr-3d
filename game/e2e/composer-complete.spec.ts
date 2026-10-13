import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { RESULTS } from './game';

// #139: the composer's completion popup in real Chromium, in the test-only host (`/?composer-demo`,
// src/ui/composer/demo.ts) with its stub sources: `/` lists commands at once, `@` lists files after a delay the spec
// sets (`stub.delays`, to make a reply late). Typing and keys are real keyboard input; IME composition is a real CDP
// `Input.imeSetComposition`. `H3D_EVIDENCE_DIR` says where the screenshots go (default: test-results/composer).

const EVIDENCE = process.env.H3D_EVIDENCE_DIR ?? resolve(RESULTS, 'composer');
mkdirSync(EVIDENCE, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: resolve(EVIDENCE, `${name}.png`) });

async function open(page: Page): Promise<void> {
  const ws = encodeURIComponent('/fixture/demo?play=none');
  await page.goto(`/?composer-demo&ws=${ws}`);
  await page.waitForFunction(() => window.__h3dComposer?.dialog.open === true);
  await expect(page.locator('.cmp-editor')).toBeFocused();
}

const ed = (page: Page) => page.locator('.cmp-editor');
const pop = (page: Page) => page.locator('.cmp-pop');
const list = (page: Page) => page.getByRole('listbox');
const options = (page: Page) => page.getByRole('option');
const selected = (page: Page) => page.locator('[role="option"][aria-selected="true"]');
const text = (page: Page) => page.evaluate(() => (window.__h3dComposer as NonNullable<Window['__h3dComposer']>).composer.getSnapshot().text);
const events = (page: Page) => page.evaluate(() => (window.__h3dComposer as NonNullable<Window['__h3dComposer']>).events);

test('/ at the start opens an accessible popup under the caret; arrows move, Enter picks, Enter then sends', { tag: '@component' }, async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await page.keyboard.type('/');
  await expect(pop(page)).toBeVisible();
  await expect(list(page)).toHaveAttribute('aria-label', 'Commands');
  await expect(options(page)).toHaveCount(6);
  await expect(ed(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(ed(page)).toHaveAttribute('aria-autocomplete', 'list');
  await expect(ed(page)).toHaveAttribute('aria-controls', (await list(page).getAttribute('id')) as string);
  const first = await options(page).first().getAttribute('id');
  await expect(ed(page)).toHaveAttribute('aria-activedescendant', first as string);
  // Under the caret's line, lined up with the trigger.
  const geo = await page.evaluate(() => {
    const e = document.querySelector('.cmp-editor') as HTMLElement;
    const r = document.createRange();
    r.setStart(e.firstChild as Text, 0);
    r.setEnd(e.firstChild as Text, 1);
    const c = r.getBoundingClientRect();
    const p = (document.querySelector('.cmp-pop') as HTMLElement).getBoundingClientRect();
    return { caretBottom: c.bottom, caretLeft: c.left, popTop: p.top, popLeft: p.left, side: (document.querySelector('.cmp-pop') as HTMLElement).dataset.side };
  });
  expect(geo.side).toBe('below');
  expect(geo.popTop).toBeGreaterThanOrEqual(geo.caretBottom);
  expect(geo.popTop - geo.caretBottom).toBeLessThan(12);
  expect(Math.abs(geo.popLeft - geo.caretLeft)).toBeLessThan(12);
  await shot(page, 'complete-open');

  await page.keyboard.type('c');
  await expect(options(page)).toHaveText([/\/clear/, /\/compact/, /\/cost/]);
  await page.keyboard.press('ArrowDown');
  await expect(selected(page)).toHaveText(/\/compact/);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(selected(page)).toHaveText(/\/cost/); // wraps
  await page.keyboard.press('Enter');
  await expect(pop(page)).toBeHidden();
  expect(await text(page)).toBe('/cost ');
  expect(await events(page)).not.toContain('submit');
  await expect(ed(page)).not.toHaveAttribute('aria-expanded', /.*/);
  await expect(ed(page)).not.toHaveAttribute('aria-activedescendant', /.*/);
  // Closed: Enter sends.
  await page.keyboard.press('Enter');
  await expect.poll(() => events(page)).toContain('submit');
  expect(errors).toEqual([]);
});

test('mid-word / and @ do not open; after a space they do', { tag: '@component' }, async ({ page }) => {
  await open(page);
  await page.keyboard.type('see a/b http://x/y me@x.com');
  await expect(pop(page)).toBeHidden();
  await page.keyboard.type(' @');
  await expect(pop(page)).toBeVisible();
  await expect(list(page)).toHaveAttribute('aria-label', 'Files');
});

test('Tab picks; one undo takes the pick back and redo puts it again', { tag: '@component' }, async ({ page }) => {
  await open(page);
  await page.keyboard.type('run /re');
  await expect(options(page)).toHaveText([/\/review/]);
  await page.keyboard.press('Tab');
  expect(await text(page)).toBe('run /review ');
  await expect(ed(page)).toBeFocused();
  await page.keyboard.press('ControlOrMeta+z');
  expect(await text(page)).toBe('run /re');
  await expect(pop(page)).toBeHidden();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  expect(await text(page)).toBe('run /review ');
  // The caret is after the pick: typing goes on there.
  await page.keyboard.type('now');
  expect(await text(page)).toBe('run /review now');
});

test('Esc closes the popup only, not the dialog; a second Esc is the dialog’s', { tag: '@component' }, async ({ page }) => {
  await open(page);
  await page.keyboard.type('/');
  await expect(pop(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pop(page)).toBeHidden();
  expect(await page.evaluate(() => window.__h3dComposer?.dialog.open)).toBe(true);
  expect(await events(page)).toEqual([]);
  await expect(ed(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3dComposer?.dialog.open)).toBe(false);
});

test('a click picks without taking the focus from the editor', { tag: '@component' }, async ({ page }) => {
  await open(page);
  await page.keyboard.type('/c');
  const blurs = await page.evaluateHandle(() => {
    const log: string[] = [];
    (document.querySelector('.cmp-editor') as HTMLElement).addEventListener('blur', () => log.push('blur'));
    return log;
  });
  await options(page).nth(1).click();
  expect(await text(page)).toBe('/compact ');
  await expect(ed(page)).toBeFocused();
  expect(await blurs.evaluate((l) => l)).toEqual([]);
  await page.keyboard.type('x');
  expect(await text(page)).toBe('/compact x');
});

test('the caret leaving the token closes it', { tag: '@component' }, async ({ page }) => {
  await open(page);
  await page.keyboard.type('go /he');
  await expect(pop(page)).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(pop(page)).toBeVisible(); // still inside
  await page.keyboard.press('Home');
  await expect(pop(page)).toBeHidden();
});

test('an async source: loading, rows, a late reply dropped, a failure, No match', { tag: '@component' }, async ({ page }) => {
  await open(page);
  // "my" answers late: by then the query is "my n", whose reply is already shown.
  await page.evaluate(() => {
    const s = (window.__h3dComposer as NonNullable<Window['__h3dComposer']>).stub;
    s.delays['my'] = 900;
    s.delays['my n'] = 50;
  });
  await page.keyboard.type('@my');
  await expect(page.locator('.cmp-pop-status')).toHaveText('Loading…');
  await page.keyboard.type(' n');
  await expect(options(page)).toHaveText(['src/ui/composer/My Notes.md']);
  await page.waitForTimeout(1100);
  await expect(options(page)).toHaveText(['src/ui/composer/My Notes.md']);
  const asked = await page.evaluate(() => (window.__h3dComposer as NonNullable<Window['__h3dComposer']>).stub.asked);
  expect(asked.find((a) => a.query === 'my')?.aborted).toBe(true);
  await shot(page, 'complete-files');
  await page.keyboard.press('Enter');
  expect(await text(page)).toBe('@src/ui/composer/My Notes.md ');

  await page.keyboard.type('@zzz');
  await expect(page.locator('.cmp-pop-status')).toHaveText('No match');
  await page.keyboard.press('Escape');
  await page.evaluate(() => ((window.__h3dComposer as NonNullable<Window['__h3dComposer']>).stub.fail = true));
  await page.keyboard.type(' @x');
  await expect(page.locator('.cmp-pop-status')).toHaveText('Could not load matches.');
  await expect(list(page)).toHaveAttribute('aria-busy', 'false');
});

test('the popup flips above the caret when there is no room below, and stays inside the dialog', { tag: '@component' }, async ({ page }) => {
  await open(page);
  // Lines down to the bottom of the editor, then the trigger.
  for (let i = 0; i < 14; i++) await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('/');
  await expect(pop(page)).toBeVisible();
  const g = await page.evaluate(() => {
    const p = document.querySelector('.cmp-pop') as HTMLElement;
    const d = (window.__h3dComposer as NonNullable<Window['__h3dComposer']>).dialog.getBoundingClientRect();
    const s = getSelection() as Selection;
    const c = s.getRangeAt(0).getBoundingClientRect();
    // The trigger is the character before the caret (the browser may have typed it into a text node of its own).
    const slash = document.createRange();
    slash.setStart(s.focusNode as Text, s.focusOffset - 1);
    slash.setEnd(s.focusNode as Text, s.focusOffset);
    const r = p.getBoundingClientRect();
    return { side: p.dataset.side, top: r.top, bottom: r.bottom, left: r.left, right: r.right, caretTop: c.top, triggerLeft: slash.getBoundingClientRect().left, d: { top: d.top, bottom: d.bottom, left: d.left, right: d.right } };
  });
  expect(g.side).toBe('above');
  expect(g.bottom).toBeLessThanOrEqual(g.caretTop);
  // Lined up with the trigger, though the caret before it would be at the end of the line above.
  expect(Math.abs(g.left - g.triggerLeft)).toBeLessThan(12);
  expect(g.top).toBeGreaterThanOrEqual(g.d.top);
  expect(g.left).toBeGreaterThanOrEqual(g.d.left);
  expect(g.right).toBeLessThanOrEqual(g.d.right);
  await shot(page, 'complete-above');
});

test('an IME composition does not open or disturb it; the commit does', { tag: '@component' }, async ({ page }) => {
  await open(page);
  const cdp = await page.context().newCDPSession(page);
  await page.keyboard.type('x ');
  await cdp.send('Input.imeSetComposition', { text: '/', selectionStart: 1, selectionEnd: 1 });
  await expect(pop(page)).toBeHidden();
  await cdp.send('Input.imeSetComposition', { text: '/ね', selectionStart: 2, selectionEnd: 2 });
  await expect(pop(page)).toBeHidden();
  await cdp.send('Input.insertText', { text: '/ね' });
  expect(await text(page)).toBe('x /ね');
  // Committed: the token is "/ね", which matches no command.
  await expect(pop(page)).toBeVisible();
  await expect(page.locator('.cmp-pop-status')).toHaveText('No match');
  expect(await events(page)).toEqual([]);
});

test('an image chip before the token: it still opens and picks', { tag: '@component' }, async ({ page }) => {
  await open(page);
  await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b as Blob), 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'a.png', { type: 'image/png' }));
    (document.querySelector('.cmp-editor') as HTMLElement).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('.cmp-chip')).toHaveCount(1);
  await page.keyboard.type('/he');
  await expect(options(page)).toHaveText([/\/help/]);
  const g = await page.evaluate(() => {
    const p = (document.querySelector('.cmp-pop') as HTMLElement).getBoundingClientRect();
    const chip = (document.querySelector('.cmp-chip') as HTMLElement).getBoundingClientRect();
    return { popLeft: p.left, chipRight: chip.right, popTop: p.top, chipTop: chip.top };
  });
  expect(g.popLeft).toBeGreaterThanOrEqual(g.chipRight - 2);
  expect(g.popTop).toBeGreaterThan(g.chipTop);
  await page.keyboard.press('Tab');
  await expect(page.locator('.cmp-chip')).toHaveCount(1);
  expect(await page.evaluate(() => (window.__h3dComposer as NonNullable<Window['__h3dComposer']>).composer.getSnapshot().doc.text)).toBe('￼/help ');
});

test('rows kept from an older query while the next one loads cannot be picked by a click, Enter or Tab', { tag: '@component' }, async ({ page }) => {
  await open(page);
  const stub = (delayMs: number) => page.evaluate((ms) => ((window.__h3dComposer as NonNullable<Window['__h3dComposer']>).stub.delayMs = ms), delayMs);
  await page.keyboard.type('@');
  await expect(selected(page)).toHaveText('src/main.ts');
  await stub(10000);
  await page.keyboard.type('zz');
  await expect(list(page)).toHaveAttribute('aria-busy', 'true');
  await expect(options(page).first()).toHaveText('src/main.ts'); // still shown, dimmed
  await expect(selected(page)).toHaveCount(0);
  await expect(ed(page)).not.toHaveAttribute('aria-activedescendant', /.*/);
  await options(page).first().click({ force: true });
  expect(await text(page)).toBe('@zz');
  await expect(pop(page)).toBeVisible();
  // Enter: nothing of this query's to pick, so it only closes.
  await page.keyboard.press('Enter');
  await expect(pop(page)).toBeHidden();
  expect(await text(page)).toBe('@zz');
  expect(await events(page)).toEqual([]);

  await stub(150);
  await page.keyboard.type(' @');
  await expect(selected(page)).toHaveText('src/main.ts');
  await stub(10000);
  await page.keyboard.type('q');
  await expect(list(page)).toHaveAttribute('aria-busy', 'true');
  await page.keyboard.press('Tab');
  expect(await text(page)).toBe('@zz @q');
});

test('scrolling the caret out of the editor closes the popup; the keys are the editor’s again', { tag: '@component' }, async ({ page }) => {
  await open(page);
  const inDialog = () =>
    page.evaluate(() => {
      const p = (document.querySelector('.cmp-pop') as HTMLElement).getBoundingClientRect();
      const d = (window.__h3dComposer as NonNullable<Window['__h3dComposer']>).dialog.getBoundingClientRect();
      return p.height > 0 && p.top >= d.top && p.bottom <= d.bottom;
    });
  await page.evaluate(() => {
    const d = (window.__h3dComposer as NonNullable<Window['__h3dComposer']>).composer.getDraft();
    d.replace(0, 0, Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  });
  await ed(page).focus();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('/');
  // The editor is scrolled to the caret at the bottom: open, inside the dialog.
  await expect(pop(page)).toBeVisible();
  expect(await inDialog()).toBe(true);
  await page.evaluate(() => ((document.querySelector('.cmp-editor') as HTMLElement).scrollTop = 0));
  await expect(pop(page)).toBeHidden();
  await expect(ed(page)).not.toHaveAttribute('aria-expanded', /.*/);
  // Scrolled back to the caret, it stays closed; Enter sends the draft as typed.
  await page.evaluate(() => {
    const e = document.querySelector('.cmp-editor') as HTMLElement;
    e.scrollTop = e.scrollHeight;
  });
  await page.waitForTimeout(100);
  await expect(pop(page)).toBeHidden();
  await page.keyboard.press('Enter');
  await expect.poll(() => events(page)).toContain('submit');
  expect(await text(page)).toMatch(/line 50\n\/$/);

  // Typing with the caret scrolled out of view: the browser brings it back and the popup opens there.
  await page.evaluate(() => {
    const d = (window.__h3dComposer as NonNullable<Window['__h3dComposer']>).composer.getDraft();
    d.replace(0, d.doc.text.length, Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  });
  await ed(page).focus();
  await page.keyboard.press('ControlOrMeta+End');
  await page.evaluate(() => ((document.querySelector('.cmp-editor') as HTMLElement).scrollTop = 0));
  await page.keyboard.type('/');
  await expect(pop(page)).toBeVisible();
  expect(await inDialog()).toBe(true);
});
