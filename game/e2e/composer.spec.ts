import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { RESULTS } from './game';

// #51 / M11 part 3: the prompt composer in real Chromium, in the test-only host (`/?composer-demo`,
// src/ui/composer/demo.ts): a modal dialog shaped like the hire dialog, the editor filling it, uploads to the fixture
// server's POST /upload. Paste is a real ClipboardEvent carrying a DataTransfer with PNG Files, typing and keys are
// real keyboard input. `H3D_EVIDENCE_DIR` says where the screenshots go (default: test-results/composer).

const EVIDENCE = process.env.H3D_EVIDENCE_DIR ?? resolve(RESULTS, 'composer');
mkdirSync(EVIDENCE, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: resolve(EVIDENCE, `${name}.png`) });

const unique = () => `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const DROPS = '/home/fixture/drops/2026-09';

async function open(page: Page, extra = ''): Promise<{ key: string }> {
  const key = unique();
  const ws = encodeURIComponent(`/fixture/demo?play=none&upload_key=${key}${extra}`);
  await page.goto(`/?composer-demo&ws=${ws}`);
  await page.waitForFunction(() => window.__h3dComposer?.dialog.open === true);
  await expect(page.locator('.cmp-editor')).toBeFocused();
  return { key };
}

interface Img {
  name: string;
  w?: number;
  h?: number;
  color?: string;
}

/** A real paste: a ClipboardEvent whose DataTransfer holds PNG files (drawn here, so thumbnails have pixels). */
async function paste(page: Page, files: Img[], text?: string): Promise<boolean> {
  return page.evaluate(
    async ({ files, text }) => {
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
      if (text) dt.setData('text/plain', text);
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      (document.querySelector('.cmp-editor') as HTMLElement).dispatchEvent(ev);
      return ev.defaultPrevented;
    },
    { files, text },
  );
}

/** The editor's children in order: `text:…` and `chip:<name>` (the tail and empty runs left out). */
const layout = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    [...(document.querySelector('.cmp-editor') as HTMLElement).childNodes].flatMap((n) => {
      if (n.nodeType === 3) {
        const t = (n as Text).data.replace(/​/g, '');
        return t ? [`text:${t}`] : [];
      }
      const el = n as HTMLElement;
      return el.classList.contains('cmp-chip') ? [`chip:${el.querySelector('.cmp-name')?.textContent}`] : [];
    }),
  );

const snap = (page: Page) =>
  page.evaluate(() => {
    const s = (window.__h3dComposer as NonNullable<Window['__h3dComposer']>).composer.getSnapshot();
    return { text: s.text, revision: s.revision, sel: s.selection, images: s.images.map((i) => ({ n: i.n, name: i.name, status: i.status, path: i.path })) };
  });

/** The DOM selection as (path of child indexes from the editor, offset) pairs: the same nodes again means the same caret. */
const domSel = (page: Page) =>
  page.evaluate(() => {
    const ed = document.querySelector('.cmp-editor') as HTMLElement;
    const s = getSelection() as Selection;
    const path = (n: Node | null): number[] => {
      const out: number[] = [];
      for (let c = n; c && c !== ed; c = c.parentNode) out.unshift([...(c.parentNode?.childNodes ?? [])].indexOf(c as ChildNode));
      return out;
    };
    return { a: path(s.anchorNode), ao: s.anchorOffset, f: path(s.focusNode), fo: s.focusOffset, focused: document.activeElement === ed, inEditor: ed.contains(s.anchorNode) };
  });

const ed = (page: Page) => page.locator('.cmp-editor');
const chips = (page: Page) => page.locator('.cmp-chip');
const lightbox = (page: Page) => page.locator('dialog.cmp-lightbox[open]');
const hostEvents = (page: Page) => page.evaluate(() => (window.__h3dComposer as NonNullable<Window['__h3dComposer']>).events);
const uploadLog = async (page: Page, key: string) => (await page.evaluate(async (k) => (await fetch(`/upload/_log?upload_key=${k}`)).json(), key)).data as Array<{ label: string; n: number; result: string; mime: string | null }>;

test('a pasted screenshot lands inline at the caret, between the words, and shows its thumbnail', { tag: '@component' }, async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await page.keyboard.type('hello world');
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft');
  expect(await paste(page, [{ name: 'shot-a.png' }])).toBe(true);

  expect(await layout(page)).toEqual(['text:hello', 'chip:shot-a.png', 'text: world']);
  const chip = chips(page).first();
  await expect(chip).toBeVisible();
  const img = chip.locator('img');
  await expect(img).toBeVisible();
  expect(await img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(640);
  // Inline: on the text's line, after "hello" and before " world".
  const geo = await page.evaluate(() => {
    const e = document.querySelector('.cmp-editor') as HTMLElement;
    const kids = [...e.childNodes];
    const first = kids[0] as Text;
    const last = kids[2] as Text;
    const r1 = document.createRange();
    r1.setStart(first, 0);
    r1.setEnd(first, first.length);
    const r2 = document.createRange();
    r2.setStart(last, 0);
    r2.setEnd(last, last.length);
    const c = (kids[1] as HTMLElement).getBoundingClientRect();
    const a = r1.getBoundingClientRect();
    const b = r2.getBoundingClientRect();
    return { textEnd: a.right, chipLeft: c.left, chipRight: c.right, nextStart: b.left, chipMidY: (c.top + c.bottom) / 2, textTop: a.top, textBottom: a.bottom };
  });
  expect(geo.chipLeft).toBeGreaterThanOrEqual(geo.textEnd - 1);
  expect(geo.nextStart).toBeGreaterThanOrEqual(geo.chipRight - 1);
  expect(geo.chipMidY).toBeGreaterThan(geo.textTop - 12);
  expect(geo.chipMidY).toBeLessThan(geo.textBottom + 12);
  expect(await chip.locator('.cmp-num').textContent()).toBe('#1');
  // The caret is after the chip, where typing continues.
  await page.keyboard.type('!');
  expect((await snap(page)).text).toBe('hello! world');
  await expect(chip.locator('.cmp-state')).toHaveText('Uploaded');
  await shot(page, '01-inline-thumbnail');
  expect(errors).toEqual([]);
});

test('two images pasted around typed text stay in order, and text pasted alongside is plain', { tag: '@component' }, async ({ page }) => {
  await open(page);
  await page.keyboard.type('see ');
  await paste(page, [{ name: 'a.png', color: '#e8413a' }]);
  await page.keyboard.type(' and ');
  await paste(page, [{ name: 'b.png', color: '#12a26a' }]);
  await page.keyboard.type(' please');
  expect(await layout(page)).toEqual(['text:see ', 'chip:a.png', 'text: and ', 'chip:b.png', 'text: please']);
  // HTML never gets in: a paste of text/plain inserts text at the caret.
  const claimed = await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', '\nline two');
    dt.setData('text/html', '<b>bold</b><img src="x">');
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector('.cmp-editor')?.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  expect(claimed).toBe(true);
  expect(await ed(page).locator('b, img:not(.cmp-chip img)').count()).toBe(0);
  expect((await snap(page)).text).toBe('see  and  please\nline two');
});

test('clicking a thumbnail opens it enlarged; the close button, Esc and the empty surface all go back to the prompt untouched', { tag: '@component' }, async ({ page }) => {
  await open(page);
  await page.keyboard.type('the header overlaps the logo');
  for (let i = 0; i < 9; i++) await page.keyboard.press('ArrowLeft');
  await paste(page, [{ name: 'big.png', w: 1600, h: 900 }, { name: 'second.png', w: 800, h: 800, color: '#5a5fa8' }]);
  await page.keyboard.type('!');
  const before = await snap(page);
  const beforeSel = await domSel(page);
  const layoutBefore = await layout(page);
  await expect(chips(page).first().locator('.cmp-state')).toHaveText('Uploaded');

  // 1. The thumbnail opens the enlarged view, scaled to fit the screen.
  await chips(page).first().locator('.cmp-thumb').click();
  await expect(lightbox(page)).toBeVisible();
  const box = (await lightbox(page).locator('img').boundingBox()) as { x: number; y: number; width: number; height: number };
  const vp = page.viewportSize() as { width: number; height: number };
  expect(box.width).toBeLessThanOrEqual(vp.width);
  expect(box.height).toBeLessThanOrEqual(vp.height);
  expect(box.width).toBeGreaterThan(600); // enlarged, not the 58 px thumbnail
  expect(Math.abs(box.width / box.height - 1600 / 900)).toBeLessThan(0.02);
  await expect(lightbox(page).locator('.cmp-lb-close')).toBeFocused();
  await expect(lightbox(page)).toHaveAccessibleName('Image 1 · big.png');
  await shot(page, '02-enlarged-view');
  // The host is still open beneath it.
  expect(await page.evaluate(() => (window.__h3dComposer as NonNullable<Window['__h3dComposer']>).dialog.open)).toBe(true);

  const backToPrompt = async (how: string) => {
    await expect(lightbox(page), how).toHaveCount(0);
    await expect(ed(page), how).toBeFocused();
    expect(await snap(page), how).toMatchObject({ text: before.text, revision: before.revision, sel: before.sel });
    expect((await snap(page)).images.map((i) => i.name), how).toEqual(['big.png', 'second.png']);
    expect(await layout(page), how).toEqual(layoutBefore);
    expect(await domSel(page), how).toEqual(beforeSel);
    expect(await page.evaluate(() => (window.__h3dComposer as NonNullable<Window['__h3dComposer']>).dialog.open), how).toBe(true);
    expect(await hostEvents(page), how).toEqual([]);
  };

  // 2. Its close button.
  await lightbox(page).locator('.cmp-lb-close').click();
  await backToPrompt('close button');
  await shot(page, '03-back-to-prompt');

  // 3. Esc: only the enlarged view closes; the hire-like dialog stays.
  await chips(page).nth(1).locator('.cmp-thumb').click();
  await expect(lightbox(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await backToPrompt('Esc');

  // 4. A click on the empty surface; a click on the image itself does nothing.
  await chips(page).first().locator('.cmp-thumb').click();
  await expect(lightbox(page)).toBeVisible();
  await lightbox(page).locator('img').click();
  await expect(lightbox(page)).toBeVisible();
  await page.mouse.click(30, vp.height / 2);
  await backToPrompt('empty surface');

  // The next Esc, with nothing enlarged, reaches the host dialog and closes it.
  await page.keyboard.press('Escape');
  await expect.poll(() => hostEvents(page)).toContain('close');
  expect(await page.evaluate(() => (window.__h3dComposer as NonNullable<Window['__h3dComposer']>).dialog.open)).toBe(false);
});

test('a drag that starts on the image or ends on the surface does not close the enlarged view', { tag: '@component' }, async ({ page }) => {
  await open(page);
  await paste(page, [{ name: 'a.png', w: 1200, h: 600 }]);
  await chips(page).first().locator('.cmp-thumb').click();
  await expect(lightbox(page)).toBeVisible();
  const box = (await lightbox(page).locator('img').boundingBox()) as { x: number; y: number; width: number; height: number };
  // Press on the image, release on the surface.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(20, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(lightbox(page)).toBeVisible();
  // Press on the surface, drag, release on the surface.
  await page.mouse.move(20, 300);
  await page.mouse.down();
  await page.mouse.move(120, 330, { steps: 6 });
  await page.mouse.up();
  await expect(lightbox(page)).toBeVisible();
  // Press on the surface, release on the image.
  await page.mouse.move(20, 300);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(lightbox(page)).toBeVisible();
  // A plain click on the surface closes it.
  await page.mouse.click(20, 300);
  await expect(lightbox(page)).toHaveCount(0);
});

test('Esc closes only the topmost layer, once per press, however the host handles it', { tag: '@component' }, async ({ page }) => {
  await open(page);
  await paste(page, [{ name: 'a.png' }]);
  await chips(page).first().locator('.cmp-thumb').click();
  await expect(lightbox(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(lightbox(page)).toHaveCount(0);
  expect(await hostEvents(page)).toEqual([]);
  // Open it again by keyboard from the chip's own button and close it the same way.
  await chips(page).first().locator('.cmp-thumb').focus();
  await page.keyboard.press('Enter');
  await expect(lightbox(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(lightbox(page)).toHaveCount(0);
  expect(await hostEvents(page)).toEqual([]);
  // The enlarged view over a host that is being cancelled programmatically still leaves the host open.
  await chips(page).first().locator('.cmp-thumb').click();
  await expect(lightbox(page)).toBeVisible();
  await page.evaluate(() => (window.__h3dComposer as NonNullable<Window['__h3dComposer']>).dialog.dispatchEvent(new Event('cancel', { cancelable: true })));
  expect(await page.evaluate(() => (window.__h3dComposer as NonNullable<Window['__h3dComposer']>).dialog.open)).toBe(true);
  expect(await hostEvents(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(lightbox(page)).toHaveCount(0);
});

/** One physical Esc press held down: the key goes down, repeats while held, comes up. `CDP` is the only way to send `autoRepeat`. */
async function heldEscape(page: Page, repeats: number): Promise<{ down(): Promise<unknown>; repeat(): Promise<void>; up(): Promise<unknown> }> {
  const cdp = await page.context().newCDPSession(page);
  const key = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
  return {
    down: () => cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key }),
    repeat: async () => {
      for (let i = 0; i < repeats; i++) await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', autoRepeat: true, ...key });
    },
    up: () => cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key }),
  };
}

test('a held Esc closes only the enlarged view: its auto-repeat never reaches the host, and a new press after the key is up does', { tag: '@component' }, async ({ page }) => {
  await open(page);
  await paste(page, [{ name: 'a.png' }]);
  await chips(page).first().locator('.cmp-thumb').click();
  await expect(lightbox(page)).toBeVisible();
  const esc = await heldEscape(page, 5);
  await esc.down();
  await expect(lightbox(page)).toHaveCount(0);
  await esc.repeat();
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window.__h3dComposer as NonNullable<Window['__h3dComposer']>).dialog.open)).toBe(true);
  expect(await hostEvents(page)).toEqual([]);
  await esc.up();
  // The key is up: a new press is the host's.
  await page.keyboard.press('Escape');
  await expect.poll(() => hostEvents(page)).toContain('close');
  expect(await page.evaluate(() => (window.__h3dComposer as NonNullable<Window['__h3dComposer']>).dialog.open)).toBe(false);
});

test('the held-Esc guard lets go of a keyup that never comes: a new Esc press then closes the host', { tag: '@component' }, async ({ page }) => {
  await open(page);
  await paste(page, [{ name: 'a.png' }]);
  const hostOpen = () => page.evaluate(() => (window.__h3dComposer as NonNullable<Window['__h3dComposer']>).dialog.open);
  await chips(page).first().locator('.cmp-thumb').click();
  await expect(lightbox(page)).toBeVisible();
  const esc = await heldEscape(page, 1);
  await esc.down(); // and no keyup
  await expect(lightbox(page)).toHaveCount(0);
  await esc.repeat();
  expect(await hostOpen()).toBe(true);
  // A new (non-repeat) press with the keyup lost: it is not swallowed.
  await esc.down();
  await expect.poll(() => hostEvents(page)).toContain('close');
  expect(await hostOpen()).toBe(false);
});

test('a backward selection, the caret and the scroll come back exactly after the enlarged view', { tag: '@component' }, async ({ page }) => {
  await open(page);
  // Enough lines to scroll inside the editor.
  for (let i = 0; i < 40; i++) await page.keyboard.type(`line ${i}`), await page.keyboard.press('Shift+Enter');
  await paste(page, [{ name: 'a.png' }]);
  await page.keyboard.type(' tail');
  const scrolls = await ed(page).evaluate((e) => e.scrollHeight > e.clientHeight);
  expect(scrolls).toBe(true);
  // Scroll to the middle, select backward across the chip with the keyboard.
  for (let i = 0; i < 7; i++) await page.keyboard.press('Shift+ArrowLeft');
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(0)))); // the draft learns the selection from an event
  const top = await ed(page).evaluate((e) => (e.scrollTop = Math.round(e.scrollHeight / 3)));
  const before = await snap(page);
  const sel = await domSel(page);
  expect(before.sel.anchor).toBeGreaterThan(before.sel.focus);
  // Opened with the mouse: the chip is scrolled into view first, which moves the scroll; so open it from the API
  // the way the click does (the click handler reads the same bookmark) and check what the bookmark gives back.
  await page.evaluate(() => {
    const c = (window.__h3dComposer as NonNullable<Window['__h3dComposer']>).composer;
    c.openPreview(c.getSnapshot().images[0]?.occ as string);
  });
  await expect(lightbox(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(lightbox(page)).toHaveCount(0);
  await expect(ed(page)).toBeFocused();
  expect((await snap(page)).sel).toEqual(before.sel);
  expect(await domSel(page)).toEqual(sel);
  expect(await ed(page).evaluate((e) => e.scrollTop)).toBe(top);
  // ...and typing goes to the selection, replacing it.
  await page.keyboard.type('X');
  expect((await snap(page)).text).toContain('X');
});

test('two pasted images serialise to [Image #1] and [Image #2] in the right places through the fixture upload', { tag: '@component' }, async ({ page }) => {
  const { key } = await open(page);
  await page.keyboard.type('The header overlaps the logo, see ');
  await paste(page, [{ name: 'one.png', color: '#e8413a' }]);
  await page.keyboard.type(' and compare with the design ');
  await paste(page, [{ name: 'two.png', color: '#12a26a' }]);
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('Thanks.');
  await page.keyboard.press('Enter'); // the host's send: the composer asks, the host resolves
  await expect(page.locator('#cmp-out')).toHaveText(
    `The header overlaps the logo, see [Image #1: ${DROPS}/h3d-demo-1.png] and compare with the design [Image #2: ${DROPS}/h3d-demo-2.png]\nThanks.`,
  );
  expect(await page.evaluate(() => (window.__h3dComposer as NonNullable<Window['__h3dComposer']>).last?.ok)).toBe(true);
  // Enter asked; it did not add a line.
  expect((await snap(page)).text.endsWith('Thanks.')).toBe(true);
  // One request per image, nothing else.
  expect((await uploadLog(page, key)).map((e) => [e.n, e.result, e.mime])).toEqual([[1, 'ok', 'image/png'], [2, 'ok', 'image/png']]);
  await shot(page, '04-serialised');
});

test('a failed upload blocks the send, keeps the draft, shows a retry on that chip, and the retry lets it through', { tag: ['@smoke', '@component'] }, async ({ page }) => {
  const { key } = await open(page, '&fail_upload=1');
  await page.keyboard.type('compare ');
  await paste(page, [{ name: 'one.png', color: '#e8413a' }, { name: 'two.png', color: '#12a26a' }]);
  await page.keyboard.type(' now');
  const draftBefore = await snap(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('#cmp-out')).toContainText('Drop Zone is not answering');
  const last = await page.evaluate(() => (window.__h3dComposer as NonNullable<Window['__h3dComposer']>).last);
  expect(last).toMatchObject({ ok: false, reason: 'upload' });
  expect((last as { failed: unknown[] }).failed).toHaveLength(1);

  // Nothing was sent, nothing was lost.
  expect(await layout(page)).toEqual(['text:compare ', 'chip:one.png', 'chip:two.png', 'text: now']);
  expect((await snap(page)).text).toBe(draftBefore.text);
  expect((await snap(page)).images.map((i) => i.name)).toEqual(['one.png', 'two.png']);
  const failed = page.locator('.cmp-chip[data-status="error"]');
  await expect(failed).toHaveCount(1);
  await expect(failed.locator('.cmp-state')).toContainText('Failed: Drop Zone is not answering');
  await expect(failed.locator('.cmp-retry')).toBeVisible();
  await expect(page.locator('.cmp-chip[data-status="ready"]')).toHaveCount(1);
  await expect(page.locator('.cmp-notice')).toBeVisible();
  await expect(page.locator('.cmp-notice')).toContainText('failed to upload');
  await shot(page, '05-upload-failed-retry');
  expect(await ed(page).evaluate((e) => e.getAttribute('contenteditable'))).toBe('true'); // busy is over: it can be edited again

  // Retry that one chip: only it is sent again.
  const before = (await uploadLog(page, key)).length;
  await failed.locator('.cmp-retry').click();
  await expect(page.locator('.cmp-chip[data-status="ready"]')).toHaveCount(2);
  expect((await uploadLog(page, key)).length).toBe(before + 1);
  await page.keyboard.press('Enter');
  await expect(page.locator('#cmp-out')).toHaveText(`compare [Image #1: ${DROPS}/h3d-demo-1.png][Image #2: ${DROPS}/h3d-demo-2.png] now`);
  // The one that was ready before was never uploaded again.
  expect((await uploadLog(page, key)).map((e) => e.result).sort()).toEqual(['dropzone_unavailable', 'ok', 'ok']);
  await shot(page, '06-retried-and-sent');
});

test('pressing send again after a failure stays blocked, and does not hit the service again, until the chip is retried', { tag: '@component' }, async ({ page }) => {
  const { key } = await open(page, '&fail_upload=1');
  await paste(page, [{ name: 'only.png' }]);
  await expect(page.locator('.cmp-chip[data-status="error"]')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page.locator('#cmp-out')).toContainText('Drop Zone is not answering');
  await page.keyboard.press('Enter');
  await expect(ed(page)).toBeFocused(); // busy ended, the editor has its focus back
  expect(await page.evaluate(() => (window.__h3dComposer as NonNullable<Window['__h3dComposer']>).last?.ok)).toBe(false);
  expect(await uploadLog(page, key)).toHaveLength(1);
  await page.locator('.cmp-retry').click();
  await expect(page.locator('.cmp-chip[data-status="ready"]')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page.locator('#cmp-out')).toHaveText(`[Image #1: ${DROPS}/h3d-demo-1.png]`);
});

test('keys around chips in a real browser: Backspace, Delete, arrows, a caret between chips, undo and redo', { tag: '@component' }, async ({ page }) => {
  await open(page);
  await page.keyboard.type('ab');
  await page.keyboard.press('ArrowLeft');
  await paste(page, [{ name: 'a.png' }, { name: 'b.png', color: '#12a26a' }]); // a | chip chip | b
  expect(await layout(page)).toEqual(['text:a', 'chip:a.png', 'chip:b.png', 'text:b']);
  // The caret is after both chips. One Left steps over one chip (not two, not half of one).
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('X');
  expect(await layout(page)).toEqual(['text:a', 'chip:a.png', 'text:X', 'chip:b.png', 'text:b']);
  // Backspace removes the text, then (caret beside a chip) the chip.
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  expect(await layout(page)).toEqual(['text:a', 'chip:b.png', 'text:b']);
  expect((await snap(page)).images.map((i) => i.n)).toEqual([1]); // renumbered
  await expect(chips(page).first().locator('.cmp-num')).toHaveText('#1');
  // Undo brings the chip back at its place; redo removes it again.
  await page.keyboard.press('Control+z');
  expect(await layout(page)).toEqual(['text:a', 'chip:a.png', 'chip:b.png', 'text:b']);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  expect(await layout(page)).toEqual(['text:ab']);
  await page.keyboard.press('Control+Shift+z');
  await page.keyboard.press('Control+y');
  expect((await layout(page)).some((l) => l.startsWith('chip:'))).toBe(true);
  // Delete (forward) in front of a chip removes it.
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  expect(await layout(page)).toEqual([]);
  await paste(page, [{ name: 'z.png' }]);
  await page.keyboard.type('after');
  await page.keyboard.press('Home');
  await page.keyboard.press('Delete');
  expect(await layout(page)).toEqual(['text:after']);
  // A selection that spans a chip is deleted with it, natively.
  await page.keyboard.press('Control+a');
  await paste(page, [{ name: 'y.png' }]);
  expect(await layout(page)).toEqual(['chip:y.png']);
});

test('Enter sends and adds no line; Shift+Enter adds one; both work at the start and end; an IME composition is left alone', { tag: '@component' }, async ({ page }) => {
  await open(page);
  await page.keyboard.type('one');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('two');
  expect((await snap(page)).text).toBe('one\ntwo');
  await page.keyboard.press('Enter');
  await expect.poll(() => hostEvents(page)).toContain('submit');
  expect((await snap(page)).text).toBe('one\ntwo');
  // A trailing newline is a line of its own the caret can be on.
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('x');
  expect((await snap(page)).text).toBe('one\ntwo\n\nx');
  // IME: composition events; Enter while composing must not send.
  const submits = (await hostEvents(page)).filter((e) => e === 'submit').length;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'にほんご', selectionStart: 4, selectionEnd: 4 });
  await page.keyboard.press('Enter');
  await cdp.send('Input.insertText', { text: '日本語' });
  expect((await hostEvents(page)).filter((e) => e === 'submit').length).toBe(submits);
  expect((await snap(page)).text).toContain('日本語');
});

test('the draft survives closing and reopening the dialog: text, caret, images and their uploaded paths', { tag: '@component' }, async ({ page }) => {
  await open(page);
  await page.keyboard.type('first task ');
  await paste(page, [{ name: 'keep.png' }]);
  await page.keyboard.type(' more');
  await expect(chips(page).first().locator('.cmp-state')).toHaveText('Uploaded');
  const before = await snap(page);
  await page.click('#cmp-close');
  await expect(page.locator('dialog.cmp-demo')).not.toHaveAttribute('open', '');
  await page.click('#cmp-reopen');
  await expect(ed(page)).toBeFocused();
  expect(await layout(page)).toEqual(['text:first task ', 'chip:keep.png', 'text: more']);
  expect(await snap(page)).toMatchObject({ text: before.text, sel: before.sel, images: [{ name: 'keep.png', status: 'ready', path: `${DROPS}/h3d-demo-1.png` }] });
  await page.keyboard.type('!');
  expect((await snap(page)).text).toBe('first task  more!');
});

test('the editor fills its dialog and scrolls inside; the placeholder shows only while empty; it works at phone width', { tag: '@component' }, async ({ page }) => {
  await open(page);
  await expect(ed(page)).toHaveAttribute('data-empty', 'true');
  const placeholder = await ed(page).evaluate((e) => getComputedStyle(e, '::before').content);
  expect(placeholder).toContain('Describe the first task');
  const dlg = (await page.locator('dialog.cmp-demo').boundingBox()) as { height: number };
  const box = (await ed(page).boundingBox()) as { height: number };
  expect(box.height).toBeGreaterThan(dlg.height * 0.45);
  await paste(page, [{ name: 'a.png' }]);
  await expect(ed(page)).toHaveAttribute('data-empty', 'false');
  for (let i = 0; i < 80; i++) await page.keyboard.press('Shift+Enter');
  const after = (await ed(page).boundingBox()) as { height: number };
  expect(after.height).toBeCloseTo(box.height, 0); // it did not grow past the dialog
  expect(await ed(page).evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 375, height: 640 });
  await expect(chips(page).first()).toBeVisible();
  const narrow = (await chips(page).first().boundingBox()) as { x: number; width: number };
  expect(narrow.x + narrow.width).toBeLessThanOrEqual(375);
  await chips(page).first().locator('.cmp-thumb').click();
  await expect(lightbox(page)).toBeVisible();
  const lb = (await lightbox(page).locator('img').boundingBox()) as { x: number; width: number };
  expect(lb.x).toBeGreaterThanOrEqual(0);
  expect(lb.x + lb.width).toBeLessThanOrEqual(375);
  await shot(page, '07-phone-width');
});
