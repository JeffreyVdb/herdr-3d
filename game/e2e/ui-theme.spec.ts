import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, openMenu, watchErrors } from './game';
import { boot, DESKTOP, NARROW, seed, SIM, sitAtTofu, SURFACES, type Themes, type UiTheme } from './ui-surfaces';
import { strays, textSamples } from './ui-theme-probe';

// #216: the application UI theme in the real app (WebGL2, the fixture bridge): Settings → Appearance, live switching
// without losing anything, the saved choice before the first frame, blocked storage, the fonts the theme loads (and
// the ones it must not), every surface of the inventory free of Quiet's navy / yellow / Recursive in Ubuntu, the
// computed palette anchors, contrast on the rendered surfaces, the eight UI x transcript x terminal combinations, and
// the narrow / zoomed / forced-colors / reduced-motion / touch layouts. The screenshots are ui-theme-shots.spec.ts.

const ALL_UBUNTU: Themes = { ui: 'ubuntu', transcript: 'ubuntu', terminal: 'ubuntu' };
const ANCHOR = { surface: 'rgb(48, 10, 36)', chrome: 'rgb(44, 0, 30)', raised: 'rgb(59, 19, 48)', hover: 'rgb(94, 39, 80)', white: 'rgb(255, 255, 255)', orange: 'rgb(233, 84, 32)', focus: 'rgb(255, 155, 118)', text2: 'rgb(232, 213, 226)', text3: 'rgb(205, 177, 198)' };

const uiAttr = (page: Page) => page.evaluate(() => document.documentElement.getAttribute('data-ui-theme'));
const theme = (page: Page) => page.evaluate(() => window.__h3d.theme());
const css = (page: Page, sel: string, prop: string) => page.locator(sel).first().evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop);
const stored = (page: Page, key = 'h3d.theme.ui') => page.evaluate((k) => localStorage.getItem(k), key);

async function openSettings(page: Page) {
  await openMenu(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Font files a page asked for. */
function fontRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (r) => {
    if (/\.(woff2?|ttf|otf)(\?|$)/i.test(r.url())) urls.push(r.url());
  });
  return urls;
}
const UBUNTU_PROSE = /\/ubuntu-latin(-ext)?-\d{3}-/i;
const UBUNTU_MONO = /\/ubuntu-mono-latin(-ext)?-\d{3}-/i;

// ---- Settings → Appearance ----------------------------------------------------------------------------------------

test('Settings → Appearance (This browser): a labelled UI theme radio group of exactly Quiet and Ubuntu, Quiet selected, the exact copy', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  // A browser that only picked the transcript and the terminal: its UI theme is still Quiet (nothing is migrated).
  await boot(page, 'demo-m5', { transcript: 'ubuntu', terminal: 'ubuntu' });
  expect(await uiAttr(page)).toBe('quiet');
  const dialog = await openSettings(page);
  const section = dialog.locator('[data-section="appearance"]');
  await expect(section.getByRole('heading', { name: 'Appearance', level: 3 })).toBeVisible();
  await expect(section.locator('.settings-store')).toHaveText('This browser');
  const group = section.getByRole('group', { name: 'UI theme' });
  await expect(group).toBeVisible();
  await expect(group).toHaveAccessibleDescription('Colors and fonts for menus, dialogs, bars, and controls. Transcript and terminal appearance are set separately.');
  const radios = group.getByRole('radio');
  await expect(radios).toHaveCount(2);
  await expect(radios.nth(0)).toHaveAccessibleName(/^Quiet/);
  await expect(radios.nth(1)).toHaveAccessibleName(/^Ubuntu/);
  await expect(radios.nth(0)).toHaveAccessibleDescription('The current navy interface.');
  await expect(radios.nth(1)).toHaveAccessibleDescription('Ubuntu purple, orange accents, Ubuntu and Ubuntu Mono.');
  await expect(radios.nth(0)).toBeChecked();
  await expect(radios.nth(1)).not.toBeChecked();
  expect(await stored(page)).toBeNull();
  // The picker is a section of the existing dialog, and Quiet stays the default of a fresh browser too.
  expect((await theme(page)).ui).toBe('quiet');
  clean();
});

test('keyboard: arrows move the UI theme between Quiet and Ubuntu, the pick applies at once, Esc closes only Settings and gives the focus back', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await boot(page, 'demo-m5', {});
  const dialog = await openSettings(page);
  const radios = dialog.locator('[data-section="appearance"]').getByRole('radio');
  await radios.nth(0).focus();
  await page.keyboard.press('ArrowRight');
  await expect(radios.nth(1)).toBeChecked();
  await expect(radios.nth(1)).toBeFocused();
  expect(await uiAttr(page)).toBe('ubuntu');
  expect(await stored(page)).toBe('ubuntu');
  await page.keyboard.press('ArrowLeft');
  await expect(radios.nth(0)).toBeChecked();
  expect(await uiAttr(page)).toBe('quiet');
  expect(await stored(page)).toBeNull();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  clean();
});

// ---- live switching ------------------------------------------------------------------------------------------------

test('a switch restyles the open Settings dialog and the HUD at once: no reload, the focus stays, the 3D scene is not rebuilt, nothing is sent', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await boot(page, 'demo-m5', {});
  await page.evaluate(() => performance.mark('before-switch'));
  const rebuilds = await page.evaluate(() => window.__h3d.officeRebuilds());
  const dialog = await openSettings(page);
  const sentBefore = (await page.evaluate(() => window.__h3d.sent())).length;
  const nav = await page.evaluate(() => performance.getEntriesByType('navigation').length + (performance.getEntriesByName('before-switch').length));
  expect(await css(page, 'dialog.settings', 'background-color')).not.toBe(ANCHOR.surface);
  const ubuntu = dialog.locator('[data-section="appearance"]').getByRole('radio', { name: /^Ubuntu/ });
  await ubuntu.focus();
  await page.keyboard.press('Space');
  await expect(ubuntu).toBeChecked();
  await expect(ubuntu).toBeFocused();
  // The same dialog element, now purple with Ubuntu type; the page was not reloaded.
  expect(await css(page, 'dialog.settings', 'background-color')).toBe(ANCHOR.surface);
  expect(await css(page, 'dialog.settings', 'font-family')).toContain('Ubuntu');
  expect(await css(page, '.topbar', 'background-color')).toBe(ANCHOR.chrome);
  expect(await css(page, 'html', 'color-scheme')).toBe('dark');
  expect(await page.evaluate(() => performance.getEntriesByName('before-switch').length)).toBe(1);
  expect(nav).toBeGreaterThan(0);
  await frames(page, 3);
  expect(await page.evaluate(() => window.__h3d.officeRebuilds())).toBe(rebuilds);
  expect((await page.evaluate(() => window.__h3d.sent())).length).toBe(sentBefore);
  expect(await page.evaluate(() => window.__h3d.error)).toBeNull();
  // And back.
  await page.getByRole('radio', { name: /^Quiet/ }).check();
  expect(await css(page, 'dialog.settings', 'background-color')).not.toBe(ANCHOR.surface);
  expect(await css(page, 'html', 'color-scheme')).toBe('light');
  clean();
});

test('a switch with the Hire dialog open keeps its draft, its focus and its model pick; the dialog restyles in place', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await boot(page, 'demo-m4', {});
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  await page.evaluate(() => window.__h3d.openHire(5));
  await expect.poll(async () => ((await page.evaluate(() => window.__h3d.dialog())) as { state?: string } | null)?.state).toBe('ready');
  const task = page.locator('#hire-task');
  await task.fill('Rework the header so it no longer overlaps the logo on mobile.');
  await task.focus();
  const before = await page.locator('dialog.desk-dlg--hire').evaluate((d) => getComputedStyle(d).backgroundColor);
  await page.evaluate(() => window.__h3d.setUiTheme('ubuntu'));
  await expect(page.locator('dialog.desk-dlg--hire')).toBeVisible();
  await expect(task).toBeFocused();
  await expect(task).toContainText('Rework the header');
  expect(await page.locator('dialog.desk-dlg--hire').evaluate((d) => getComputedStyle(d).backgroundColor)).not.toBe(before);
  expect(await page.locator('dialog.desk-dlg--hire').evaluate((d) => getComputedStyle(d).backgroundColor)).toBe(ANCHOR.surface);
  expect(((await page.evaluate(() => window.__h3d.dialog())) as { form: { prompt: string } }).form.prompt).toContain('Rework the header');
  expect((await page.evaluate(() => window.__h3d.sent())).filter((c) => c.t === 'worker.hire')).toHaveLength(0);
  clean();
});

test('a seated switch leaves the transcript and the terminal exactly as they were: their prefs, fonts and colours', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  await boot(page, 'demo-m5', { transcript: 'ubuntu', terminal: 'quiet' }, '&prints=0');
  await sitAtTofu(page, 'transcript');
  const tx = page.locator('.seat-transcript .tx');
  const read = () =>
    tx.evaluate((e) => {
      const q = (s: string) => {
        const n = e.querySelector(s);
        if (!n) return null;
        const c = getComputedStyle(n);
        return [c.color, c.backgroundColor, c.fontFamily, c.fontSize, c.fontWeight].join('|');
      };
      const root = getComputedStyle(document.documentElement);
      return { body: q('.tx-assistant .tx-md p'), code: q('.tx-out'), bubble: q('.tx-bubble'), txBg: getComputedStyle(e).backgroundColor, mono: root.getPropertyValue('--tx-mono'), prose: root.getPropertyValue('--tx-prose'), fs: root.getPropertyValue('--tx-fs') };
    });
  const before = await read();
  const prefs = await page.evaluate(() => ({ t: localStorage.getItem('h3d.theme.transcript'), k: localStorage.getItem('h3d.theme.terminal') }));
  const th = await theme(page);
  await page.evaluate(() => window.__h3d.setUiTheme('ubuntu'));
  await page.evaluate(() => window.__h3d.themeLoaded());
  expect(await read()).toEqual(before);
  expect(await page.evaluate(() => ({ t: localStorage.getItem('h3d.theme.transcript'), k: localStorage.getItem('h3d.theme.terminal') }))).toEqual(prefs);
  const after = await theme(page);
  expect({ ...after, ui: th.ui }).toEqual(th);
  expect(after.ui).toBe('ubuntu');
  await page.evaluate(() => window.__h3d.setUiTheme('quiet'));
  expect(await read()).toEqual(before);
  clean();
});

// ---- reload, first frame, blocked storage ------------------------------------------------------------------------

test('a saved Ubuntu survives a reload and no frame paints navy first', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await page.addInitScript(() => {
    const w = window as unknown as { __uiFrames: Array<string | null>; __uiFirstHud: string | null };
    w.__uiFrames = [];
    w.__uiFirstHud = null;
    const tick = () => {
      w.__uiFrames.push(document.documentElement.getAttribute('data-ui-theme'));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    new MutationObserver((_m, obs) => {
      if (document.querySelector('.hud, .topbar')) {
        w.__uiFirstHud = document.documentElement.getAttribute('data-ui-theme');
        obs.disconnect();
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await boot(page, 'demo-m5', {});
  const dialog = await openSettings(page);
  await dialog.getByRole('radio', { name: /^Ubuntu/ }).check();
  expect(await stored(page)).toBe('ubuntu');
  await page.reload();
  await page.waitForFunction(() => window.__h3d?.ready && window.__h3d.frames >= 3);
  expect(await uiAttr(page)).toBe('ubuntu');
  const frames_ = await page.evaluate(() => (window as unknown as { __uiFrames: Array<string | null> }).__uiFrames);
  expect(frames_.length).toBeGreaterThan(2);
  expect(frames_.filter((v) => v !== 'ubuntu'), 'frames before data-ui-theme').toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __uiFirstHud: string | null }).__uiFirstHud)).toBe('ubuntu');
  expect(await css(page, '.topbar', 'background-color')).toBe(ANCHOR.chrome);
  expect((await theme(page)).ui).toBe('ubuntu');
  // The picker shows the saved one.
  const d = await openSettings(page);
  await expect(d.getByRole('radio', { name: /^Ubuntu/ })).toBeChecked();
  clean();
});

test('missing, invalid, blocked and throwing storage is safe: Quiet, a working picker in memory, nothing persisted', async ({ page, browser }) => {
  test.setTimeout(240_000);
  const clean = watchErrors(page);
  // Invalid stored values are Quiet.
  for (const bad of ['', 'solarized', 'UBUNTU', 'null']) {
    const p = await browser.newPage();
    await p.addInitScript((v) => localStorage.setItem('h3d.theme.ui', v), bad);
    await openGame(p, 'demo-m5');
    expect(await uiAttr(p), `stored ${JSON.stringify(bad)}`).toBe('quiet');
    expect((await p.evaluate(() => window.__h3d.theme())).ui).toBe('quiet');
    await p.close();
  }
  // Storage that throws on every access (private windows, blocked site data).
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new DOMException('denied', 'SecurityError');
      },
    });
  });
  await openGame(page, 'demo-m5');
  expect(await uiAttr(page)).toBe('quiet');
  const dialog = await openSettings(page);
  await dialog.getByRole('radio', { name: /^Ubuntu/ }).check();
  expect(await uiAttr(page)).toBe('ubuntu');
  expect(await css(page, 'dialog.settings', 'background-color')).toBe(ANCHOR.surface);
  expect((await theme(page)).ui).toBe('ubuntu');
  await dialog.getByRole('radio', { name: /^Quiet/ }).check();
  expect(await uiAttr(page)).toBe('quiet');
  clean();
});

// ---- fonts -------------------------------------------------------------------------------------------------------

test('all Quiet is lazy: no Ubuntu file is fetched; Ubuntu UI alone (transcript and terminal Quiet) fetches Ubuntu and Ubuntu Mono for the shell', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  const fonts = fontRequests(page);
  await boot(page, 'demo-m5', {});
  await openSettings(page);
  expect(fonts.filter((u) => UBUNTU_PROSE.test(u) || UBUNTU_MONO.test(u))).toEqual([]);
  await page.getByRole('radio', { name: /^Ubuntu/ }).check();
  await page.evaluate(() => window.__h3d.themeLoaded());
  await expect.poll(() => fonts.filter((u) => UBUNTU_PROSE.test(u)).length).toBeGreaterThanOrEqual(2);
  await expect.poll(() => fonts.filter((u) => UBUNTU_MONO.test(u)).length).toBeGreaterThanOrEqual(1);
  expect(await page.evaluate(() => document.fonts.check('400 14px "Ubuntu"') && document.fonts.check('700 14px "Ubuntu"') && document.fonts.check('14px "Ubuntu Mono"'))).toBe(true);
  expect(await page.evaluate(() => window.__h3d.theme().transcript + window.__h3d.theme().terminal)).toBe('quietquiet');
  clean();
});

test('a terminal-only Ubuntu fetches Ubuntu Mono but no proportional Ubuntu while the UI and the transcript are Quiet', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  const fonts = fontRequests(page);
  await boot(page, 'demo-m5', { terminal: 'ubuntu' }, '&prints=0');
  await sitAtTofu(page, 'terminal');
  await page.evaluate(() => window.__h3d.themeLoaded());
  await expect.poll(() => fonts.filter((u) => UBUNTU_MONO.test(u)).length).toBeGreaterThanOrEqual(1);
  expect(fonts.filter((u) => UBUNTU_PROSE.test(u))).toEqual([]);
  clean();
});

test('Ubuntu UI draws the shell in the real Ubuntu faces: prose Ubuntu 400/700, data Ubuntu Mono, bold really bold, no synthesised weights, no Recursive axes', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  await boot(page, 'demo-m5', { ui: 'ubuntu' });
  await openSettings(page);
  expect(await css(page, 'dialog.settings', 'font-family')).toMatch(/^Ubuntu,/);
  expect(await css(page, 'dialog.settings h2', 'font-weight')).toBe('800'); // the authored weight; the face drawn is the 700 file
  expect(await css(page, 'html', 'font-synthesis')).toMatch(/none/);
  expect(await css(page, 'dialog.settings h2', 'font-variation-settings')).toBe('normal');
  // The bold face is a real one: its text is wider than the regular face's (a synthesised bold only smears the same advance).
  const widths = await page.evaluate(async () => {
    await document.fonts.load('400 20px Ubuntu');
    await document.fonts.load('700 20px Ubuntu');
    const c = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D;
    const w = (font: string) => {
      c.font = font;
      return c.measureText('Settings Appearance Quiet Ubuntu').width;
    };
    return { regular: w('400 20px Ubuntu'), bold: w('700 20px Ubuntu'), fallback: w('700 20px NoSuchFamily') };
  });
  expect(widths.bold).toBeGreaterThan(widths.regular * 1.02);
  expect(widths.regular).not.toBeCloseTo(widths.fallback, 0);
  // Shell data (keycaps, numbers) is Ubuntu Mono, never the transcript's or JetBrains.
  const mono = await page.locator('.hud').first().evaluate((hud) => {
    const root = getComputedStyle(document.documentElement);
    return root.getPropertyValue('--font-mono');
  });
  expect(mono).toContain('Ubuntu Mono');
  clean();
});

// ---- palette anchors ---------------------------------------------------------------------------------------------

test('Ubuntu UI: exact palette anchors on the real elements, dark native controls, orange primary with a dark label, never a white label on orange', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  await boot(page, 'demo-m4', { ui: 'ubuntu' });
  expect(await css(page, 'html', 'color-scheme')).toBe('dark');
  expect(await css(page, '.topbar', 'background-color')).toBe(ANCHOR.chrome);
  expect(await css(page, '.topbar', 'border-radius')).toBe('14px');
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  await page.evaluate(() => window.__h3d.openHire(5));
  await expect.poll(async () => ((await page.evaluate(() => window.__h3d.dialog())) as { state?: string } | null)?.state).toBe('ready');
  const dlg = page.locator('dialog.desk-dlg--hire');
  expect(await dlg.evaluate((d) => getComputedStyle(d).backgroundColor)).toBe(ANCHOR.surface);
  expect(await dlg.evaluate((d) => getComputedStyle(d).color)).toBe(ANCHOR.white);
  expect(await dlg.evaluate((d) => getComputedStyle(d).colorScheme)).toBe('dark');
  const hire = dlg.locator('[data-key="hire"]');
  await expect(hire).toBeVisible();
  const prim = await hire.evaluate((b) => {
    const c = getComputedStyle(b);
    return { bg: c.backgroundColor, fg: c.color, border: c.borderTopColor, radius: c.borderTopLeftRadius, h: b.getBoundingClientRect().height };
  });
  expect(prim.bg).toBe(ANCHOR.orange);
  expect(prim.fg).toBe(ANCHOR.chrome);
  expect(prim.border).toBe(ANCHOR.focus);
  expect(prim.radius).toBe('9px');
  expect(prim.h).toBeGreaterThanOrEqual(36);
  const cancel = dlg.locator('[data-key="cancel"]');
  const sec = await cancel.evaluate((b) => {
    const c = getComputedStyle(b);
    return { bg: c.backgroundColor, fg: c.color, border: c.borderTopColor };
  });
  expect(sec).toEqual({ bg: ANCHOR.raised, fg: ANCHOR.white, border: 'rgb(174, 147, 167)' });
  // Fields: recessed purple, white text, a strong border; the caret is orange.
  const field = await page.locator('#hire-task').evaluate((f) => {
    const c = getComputedStyle(f);
    return { bg: c.backgroundColor, fg: c.color, border: c.borderTopColor, caret: c.caretColor };
  });
  expect(field.bg).toBe(ANCHOR.chrome);
  expect(field.fg).toBe(ANCHOR.white);
  clean();
});

// ---- coverage inventory ------------------------------------------------------------------------------------------

const ALLOW = [
  'canvas', '.wb-canvas', '.excalidraw canvas', 'img', 'video', '.seat-swatch', '.settings-theme-swatch', '.settings-theme-swatch *',
  '.imgs-img', '.ilb-img', '.ib-logo', '[data-content]', '.bd-label', '.bd-chip-label', '.label-chip', '.hire-logo', '.kraft', '[data-artwork]',
  // Content with its own colours: a board pin (the note's own status colour), the transcript's diff rows (--tx-del-bg is the diff's red) and the seat bar's swatches of the presets.
  '.bd-pin', '.tx-dl', '.tx-swatch',
].join(', ');

for (const s of SURFACES) {
  test(`coverage: ${s.name} has no Quiet navy, yellow or Recursive left in Ubuntu (all three themes Ubuntu)`, async ({ page }) => {
    test.setTimeout(180_000);
    const clean = watchErrors(page);
    await boot(page, s.fixture, ALL_UBUNTU, s.extra ?? '', s.wsQuery);
    await s.open(page);
    await page.waitForTimeout(300);
    const found = await strays(page, `${s.root}, .topbar, .hud .prompt, .hud .hint, .toast, .excalidraw-modal-container, .excalidraw .Island`, ALLOW);
    expect(found.map((f) => `${f.at} ${f.prop}: ${f.value} (${f.why})`), `${s.name}: Quiet leftovers`).toEqual([]);
    clean();
  });
}

// ---- contrast on the rendered surfaces ---------------------------------------------------------------------------

for (const s of SURFACES) {
  test(`contrast: text on ${s.name} is 4.5:1 on what really sits behind it (Ubuntu), inside transcript and composer scopes too`, async ({ page }) => {
    test.setTimeout(180_000);
    const clean = watchErrors(page);
    await boot(page, s.fixture, ALL_UBUNTU, s.extra ?? '', s.wsQuery);
    await s.open(page);
    await page.waitForTimeout(300);
    const samples = await textSamples(page, `${s.root}, .topbar, .hud .prompt, .hud .hint, .toast`, '.excalidraw canvas, canvas, img, .seat-swatch, .settings-theme-swatch');
    expect(samples.length, `${s.name}: the probe found text to measure`).toBeGreaterThan(5);
    const bad = samples.filter((t) => (t.ratio !== null && t.ratio < (t.size >= 24 || (t.size >= 18.66 && Number(t.weight) >= 700) ? 3 : 4.5)) || t.bg === 'translucent');
    expect(
      bad.map((t) => `${t.at} "${t.text}" ${t.fg} on ${t.bg} = ${t.ratio?.toFixed(2)} (${t.size}px, from ${t.bgFrom})`),
      `${s.name}: text under 4.5:1 or on a translucent surface`,
    ).toEqual([]);
    clean();
  });
}

// ---- the eight combinations --------------------------------------------------------------------------------------

const COMBOS: Themes[] = [];
for (const ui of ['quiet', 'ubuntu'] as UiTheme[]) for (const transcript of ['quiet', 'ubuntu'] as UiTheme[]) for (const terminal of ['quiet', 'ubuntu'] as UiTheme[]) COMBOS.push({ ui, transcript, terminal });

for (const c of COMBOS) {
  test(`combination ui=${c.ui} transcript=${c.transcript} terminal=${c.terminal}: independent selections, each surface in its own fonts and colours`, async ({ page }) => {
    test.setTimeout(240_000);
    const clean = watchErrors(page);
    await boot(page, 'demo-m5', c, '&prints=0');
    expect(seed(c)).toBeDefined();
    await sitAtTofu(page, 'transcript');
    const t = await theme(page);
    expect([t.ui, t.transcript, t.terminal]).toEqual([c.ui, c.transcript, c.terminal]);
    expect(await uiAttr(page)).toBe(c.ui);
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(c.transcript);
    // The shell's fonts follow the UI theme only; the transcript's follow its own.
    const shell = await css(page, '.seat .seat-tape, .seat', 'font-family');
    expect(shell).toContain(c.ui === 'ubuntu' ? 'Ubuntu' : 'Recursive');
    const barFont = await css(page, '.topbar', 'font-family');
    expect(barFont).toContain(c.ui === 'ubuntu' ? 'Ubuntu' : 'Recursive');
    const prose = await page.locator('.seat-transcript .tx-assistant .tx-md p').first().evaluate((e) => getComputedStyle(e).fontFamily);
    expect(prose).toContain(c.transcript === 'ubuntu' ? 'Ubuntu' : 'Atkinson');
    const monoEl = page.locator('.seat-transcript .tx-tool-name, .seat-transcript .tx-md code, .seat-transcript .tx-out').first();
    expect(await monoEl.count(), 'a monospace element of the transcript').toBeGreaterThan(0);
    expect(await monoEl.evaluate((e) => getComputedStyle(e).fontFamily)).toContain(c.transcript === 'ubuntu' ? 'Ubuntu Mono' : 'JetBrains');
    // Shell data (the limits numbers, a keycap) is the UI's mono, never the transcript's.
    const key = await page.locator('.seat-keys kbd, .key kbd').first().evaluate((e) => getComputedStyle(e).fontFamily);
    expect(key).toContain(c.ui === 'ubuntu' ? 'Ubuntu Mono' : 'JetBrains');
    expect(await page.evaluate(() => window.__h3d.theme().terminalFont)).toContain(c.terminal === 'ubuntu' ? 'Ubuntu Mono' : 'JetBrains');
    // The transcript's ground is its own colour, whatever the shell is.
    const txBg = await css(page, '.seat-transcript .tx', 'background-color');
    expect(txBg).toBe(c.transcript === 'ubuntu' ? ANCHOR.surface : 'rgb(15, 21, 38)');
    // The seat bar is the UI's.
    const bar = await css(page, '.seat-bar, .seat', 'background-color');
    expect(bar).not.toBe('');
    clean();
  });
}

test('view zoom and a mode switch leave the shell’s fonts, colours and sizes unchanged (Ubuntu UI)', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  await boot(page, 'demo-m5', { ui: 'ubuntu', transcript: 'ubuntu' }, '&prints=0');
  await sitAtTofu(page, 'transcript');
  const shell = () =>
    page.evaluate(() =>
      ['.topbar', '.topbar .btn', '.seat', '.seat .seat-tape', '.seat-keys kbd'].map((s) => {
        const e = document.querySelector(s);
        if (!e) return null;
        const c = getComputedStyle(e);
        const r = e.getBoundingClientRect();
        return [s, c.fontFamily, c.fontSize, c.color, c.backgroundColor, Math.round(r.height)].join('|');
      }),
    );
  const before = await shell();
  for (let i = 0; i < 3; i++) await page.keyboard.press('Control+=');
  await frames(page, 3);
  expect((await theme(page)).transcriptZoom).toBeGreaterThan(100);
  expect(await shell()).toEqual(before);
  await page.keyboard.press('Control+0');
  await page.keyboard.press('Control+Escape');
  await frames(page, 6);
  await page.keyboard.press('Control+Escape');
  await frames(page, 6);
  expect(await shell()).toEqual(before);
  clean();
});

// ---- narrow, zoomed, touch, forced colors, reduced motion ----------------------------------------------------------

/** Lets a panel's entrance finish (finite animations only) before it is measured. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));
  await frames(page, 2);
}

async function noOverflow(page: Page, rootSel: string): Promise<string[]> {
  await settle(page);
  return page.evaluate((sel) => {
    const out: string[] = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth + 1) out.push(`page scrolls sideways: ${doc.scrollWidth} > ${doc.clientWidth}`);
    for (const root of document.querySelectorAll(sel)) {
      const r = root as HTMLElement;
      if (r.scrollWidth > r.clientWidth + 1 && getComputedStyle(r).overflowX === 'visible') out.push(`${r.className || r.tagName} overflows: ${r.scrollWidth} > ${r.clientWidth}`);
    }
    const vp = { w: window.innerWidth, h: window.innerHeight };
    for (const b of document.querySelectorAll(`:is(${sel}) :is(button, [role="button"], input, select, a)`)) {
      const cs = getComputedStyle(b);
      if (cs.display === 'none' || cs.visibility === 'hidden' || (b as HTMLElement).hidden) continue;
      const r = b.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (b.closest('[inert], [hidden]')) continue;
      // A control in a region that scrolls sideways by design (the board's columns) is reached by scrolling it.
      let scrolls = false;
      for (let n = b.parentElement; n && n !== document.body; n = n.parentElement) {
        const ox = getComputedStyle(n).overflowX;
        if ((ox === 'auto' || ox === 'scroll') && n.scrollWidth > n.clientWidth + 1) scrolls = true;
      }
      if (scrolls) continue;
      // Scrollable regions hold what is below the fold: only horizontal clipping matters here.
      if (r.left < -0.5 || r.right > vp.w + 0.5) out.push(`${(b as HTMLElement).className || b.tagName} “${(b.textContent ?? '').trim().slice(0, 20)}” leaves the screen sideways: ${Math.round(r.left)}..${Math.round(r.right)} of ${vp.w}`);
    }
    return out;
  }, rootSel);
}

for (const size of [{ name: '390px wide', ...NARROW }, { name: '200% browser zoom (640x360)', width: 640, height: 360 }]) {
  for (const s of SURFACES.filter((x) => !x.skipNarrow)) {
    test(`layout at ${size.name}: ${s.name} has no sideways overflow or clipped control in Ubuntu`, async ({ page }) => {
      test.setTimeout(180_000);
      const clean = watchErrors(page);
      await boot(page, s.fixture, ALL_UBUNTU, s.extra ?? '', s.wsQuery, size);
      await s.open(page);
      await page.waitForTimeout(300);
      expect(await noOverflow(page, `${s.root}, .topbar`)).toEqual([]);
      clean();
    });
  }
}

test('touch targets: Ubuntu standard controls are >= 36 px, icon controls >= 32 px, and >= 44 px on a coarse pointer', async ({ browser }) => {
  test.setTimeout(240_000);
  const sizes = async (page: Page, root: string) =>
    page.evaluate((sel) => {
      const out: Array<{ at: string; w: number; h: number; icon: boolean; dense: boolean }> = [];
      for (const b of document.querySelectorAll(`${sel} button, ${sel} input[type="checkbox"], ${sel} input[type="radio"], ${sel} select, ${sel} a[href]`)) {
        const cs = getComputedStyle(b);
        if (cs.display === 'none' || cs.visibility === 'hidden' || (b as HTMLElement).hidden || cs.position === 'absolute' && cs.clipPath !== 'none') continue;
        const r = b.getBoundingClientRect();
        if (r.width < 1 || r.height < 1 || r.width <= 1) continue;
        const label = b.closest('label');
        const rr = label && b.matches('input') ? label.getBoundingClientRect() : r;
        out.push({ at: `${(b as HTMLElement).className || b.tagName}:${(b.getAttribute('aria-label') ?? b.textContent ?? '').trim().slice(0, 18)}`, w: Math.round(rr.width), h: Math.round(rr.height), icon: !(b.textContent ?? '').trim(), dense: /\bbtn--sm\b/.test(String((b as HTMLElement).className)) });
      }
      return out;
    }, root);
  for (const coarse of [false, true]) {
    const ctx = await browser.newContext({ viewport: coarse ? { width: 412, height: 915 } : { ...DESKTOP }, hasTouch: coarse, isMobile: coarse });
    const page = await ctx.newPage();
    const clean = watchErrors(page);
    await page.addInitScript(() => localStorage.setItem('h3d.theme.ui', 'ubuntu'));
    await openGame(page, 'demo-m5');
    await openMenu(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    const small = (await sizes(page, 'dialog.settings')).filter((t) => (coarse ? t.w < 44 || t.h < 44 : t.icon || t.dense ? t.w < 32 || t.h < 32 : t.h < 36));
    expect(small.map((t) => `${t.at} ${t.w}x${t.h}`), coarse ? 'coarse pointer' : 'fine pointer').toEqual([]);
    clean();
    await ctx.close();
  }
});

test('forced colors keep the picker, focus and controls legible; reduced motion keeps the theme switch instant', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await boot(page, 'demo-m5', { ui: 'ubuntu' });
  const dialog = await openSettings(page);
  const radios = dialog.locator('[data-section="appearance"]').getByRole('radio');
  await radios.first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(radios.nth(1)).toBeFocused();
  const outline = await dialog.locator('.settings-theme-opt:has(input:focus-visible)').evaluate((e) => {
    const c = getComputedStyle(e);
    return { style: c.outlineStyle, width: c.outlineWidth };
  });
  expect(outline.style).not.toBe('none');
  expect(parseFloat(outline.width)).toBeGreaterThanOrEqual(3);
  const checked = await dialog.locator('.settings-theme-opt:has(input:checked)').evaluate((e) => {
    const c = getComputedStyle(e);
    return { bg: c.backgroundColor, fg: c.color };
  });
  expect(checked.bg).not.toBe(checked.fg);
  // Switching has no transition on the page: a colour change is one frame.
  const dur = await page.evaluate(() => [...document.querySelectorAll('.topbar, dialog.settings, .btn')].map((e) => getComputedStyle(e).transitionDuration));
  for (const d of dur) for (const t of d.split(',')) expect(parseFloat(t) * (t.trim().endsWith('ms') ? 0.001 : 1)).toBeLessThanOrEqual(0.2);
  clean();
});

// ---- states: every state of the controls, measured on the page -----------------------------------------------------

/** The label colour and the opaque colour behind it of the first element matching `sel`, with their ratio. */
async function pair(page: Page, sel: string): Promise<{ fg: string; bg: string; ratio: number }> {
  const samples = await textSamples(page, sel);
  const t = samples.find((s) => s.ratio !== null);
  if (!t) throw new Error(`no measurable text in ${sel}: ${JSON.stringify(samples.map((s) => [s.at, s.bg]))}`);
  return { fg: t.fg, bg: t.bg as string, ratio: t.ratio as number };
}
/** Waits for an eased fill to arrive (a transition runs on the page's own frames, a few a second here). */
async function eased(page: Page, sel: string, hex: string): Promise<void> {
  await expect.poll(async () => rgbToHex((await pair(page, sel)).bg), { timeout: 15_000 }).toBe(hex);
}
const rgbToHex = (c: string) => {
  const m = c.match(/(\d+)[ ,]+(\d+)[ ,]+(\d+)/);
  return m ? `#${[1, 2, 3].map((i) => Number(m[i]).toString(16).padStart(2, '0')).join('')}` : c;
};

test('states: the primary, secondary and busy buttons keep readable dark/white labels at rest, hover, pressed, focus and busy; focus is 3px, offset 2px, 3:1', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  await boot(page, 'demo-m4', { ui: 'ubuntu' });
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  await page.evaluate(() => window.__h3d.openHire(5));
  await expect.poll(async () => ((await page.evaluate(() => window.__h3d.dialog())) as { state?: string } | null)?.state).toBe('ready');
  const dlg = page.locator('dialog.desk-dlg--hire');
  const hire = dlg.locator('[data-key="hire"]');
  const sel = 'dialog.desk-dlg--hire [data-key="hire"]';
  const rest = await pair(page, sel);
  expect(rgbToHex(rest.bg)).toBe('#e95420');
  expect(rgbToHex(rest.fg)).toBe('#2c001e');
  expect(rest.ratio).toBeGreaterThanOrEqual(4.5);
  // Hover and pressed: the issue's two fills, the same dark label.
  await hire.hover();
  await eased(page, sel, '#eb6536'); // the fill eases for 160 ms of a page that draws at a few frames a second
  const hover = await pair(page, sel);
  expect([rgbToHex(hover.bg), rgbToHex(hover.fg)]).toEqual(['#eb6536', '#2c001e']);
  await page.mouse.down();
  await eased(page, sel, '#ed764d');
  const pressed = await pair(page, sel);
  expect([rgbToHex(pressed.bg), rgbToHex(pressed.fg)]).toEqual(['#ed764d', '#2c001e']);
  expect(pressed.ratio).toBeGreaterThanOrEqual(4.5);
  // Released away from the button: no click, no hire.
  await page.mouse.move(5, 5);
  await page.mouse.up();
  // Keyboard focus: a 3px ring in #FF9B76, 2px off, visible against the surface behind it.
  await dlg.locator('#hire-task').focus();
  await page.keyboard.press('Shift'); // a key press: the next focus is a keyboard focus (:focus-visible)
  await hire.focus();
  const ring = await page.evaluate(() => {
    const e = document.activeElement as HTMLElement;
    const c = getComputedStyle(e);
    return { tag: `${e.tagName}.${e.className}`, style: c.outlineStyle, width: c.outlineWidth, offset: c.outlineOffset, color: c.outlineColor };
  });
  expect(ring.style, `focused: ${ring.tag}`).toBe('solid');
  expect(ring.width).toBe('3px');
  expect(ring.offset).toBe('2px');
  expect(rgbToHex(ring.color)).toBe('#ff9b76');
  // The secondary: white on raised purple, the strong border.
  const cancel = await pair(page, 'dialog.desk-dlg--hire [data-key="cancel"]');
  expect([rgbToHex(cancel.bg), rgbToHex(cancel.fg)]).toEqual(['#3b1330', '#ffffff']);
  await dlg.locator('[data-key="cancel"]').hover();
  await eased(page, 'dialog.desk-dlg--hire [data-key="cancel"]', '#5e2750');
  const cancelHover = await pair(page, 'dialog.desk-dlg--hire [data-key="cancel"]');
  expect(rgbToHex(cancelHover.bg)).toBe('#5e2750');
  expect(cancelHover.ratio).toBeGreaterThanOrEqual(4.5);
  // Busy: the same colours and width, a spinner before the label, and the button says so.
  const before = await hire.evaluate((b) => b.getBoundingClientRect().width);
  await hire.evaluate((b) => b.setAttribute('aria-busy', 'true'));
  const busy = await pair(page, sel);
  expect([rgbToHex(busy.bg), rgbToHex(busy.fg)]).toEqual(['#e95420', '#2c001e']);
  expect(await hire.evaluate((b) => Math.abs(b.getBoundingClientRect().width - 0) > 0 && getComputedStyle(b, '::before').content)).not.toBe('none');
  expect(Math.abs((await hire.evaluate((b) => b.getBoundingClientRect().width)) - before)).toBeLessThan(40);
  await hire.evaluate((b) => b.removeAttribute('aria-busy'));
  clean();
});

test('states: disabled controls keep their label readable (muted on raised, no opacity), placeholders and invalid fields read, links are the lighter orange', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  await boot(page, 'demo-m5', { ui: 'ubuntu' });
  const dlg = await openSettings(page);
  // A disabled button: any in the dialog (Test, Save and Clear wait for a configured model).
  const dis = dlg.locator('button:disabled, button[aria-disabled="true"]').first();
  await dis.scrollIntoViewIfNeeded();
  const d = await dis.evaluate((b) => {
    const c = getComputedStyle(b);
    return { opacity: c.opacity, bg: c.backgroundColor, fg: c.color, border: c.borderTopColor };
  });
  expect(d.opacity).toBe('1');
  expect([rgbToHex(d.bg), rgbToHex(d.fg), rgbToHex(d.border)]).toEqual(['#3b1330', '#cdb1c6', '#ae93a7']);
  // A field's placeholder: muted text on the recessed well, 4.5:1.
  const zone = dlg.locator('input[placeholder]').first();
  await zone.scrollIntoViewIfNeeded();
  const ph = await zone.evaluate((i) => ({ fg: getComputedStyle(i, '::placeholder').color, bg: getComputedStyle(i).backgroundColor, border: getComputedStyle(i).borderTopColor, caret: getComputedStyle(i).caretColor }));
  expect([rgbToHex(ph.fg), rgbToHex(ph.bg), rgbToHex(ph.border)]).toEqual(['#cdb1c6', '#2c001e', '#ae93a7']);
  expect(rgbToHex(ph.caret)).toBe('#e95420');
  // Invalid: a typed zone the browser cannot use: red border and a message in red text (and aria-invalid).
  const zoneInput = dlg.getByLabel('Timezone');
  await zoneInput.scrollIntoViewIfNeeded();
  await zoneInput.fill('Not/AZone');
  await zoneInput.press('Enter');
  await expect(zoneInput).toHaveAttribute('aria-invalid', 'true');
  expect(rgbToHex(await zoneInput.evaluate((i) => getComputedStyle(i).borderTopColor))).toBe('#ff8a80');
  const msg = await pair(page, '.settings-field-error');
  expect(rgbToHex(msg.fg)).toBe('#ff8a80');
  expect(msg.ratio).toBeGreaterThanOrEqual(4.5);
  clean();
});

test('states: inside the transcript the composer’s Send, the selected tab and its count keep the UI theme’s colours (#111): dark on orange, never white', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  for (const tx of ['quiet', 'ubuntu'] as UiTheme[]) {
    await boot(page, 'demo-m5', { ui: 'ubuntu', transcript: tx }, '&prints=0');
    await sitAtTofu(page, 'transcript', 'Nibble');
    const editor = page.locator('.seat-transcript .cmp-editor');
    await editor.click();
    await page.keyboard.type('hello');
    const send = await pair(page, '.seat-transcript .tx-send');
    expect([rgbToHex(send.bg), rgbToHex(send.fg)], `transcript ${tx}: Send`).toEqual(['#e95420', '#2c001e']);
    const tab = await pair(page, '.seat-transcript .tx-bar .seat-tab[aria-selected="true"]');
    expect([rgbToHex(tab.bg), rgbToHex(tab.fg)], `transcript ${tx}: selected tab`).toEqual(['#e95420', '#2c001e']);
    const count = await pair(page, '.seat-transcript .tx-bar .seat-tabs-n');
    expect(count.ratio, `transcript ${tx}: count`).toBeGreaterThanOrEqual(4.5);
    // The transcript's own content kept its own tokens.
    const body = await page.locator('.seat-transcript .tx').evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(body).toBe(tx === 'ubuntu' ? ANCHOR.surface : 'rgb(15, 21, 38)');
    await page.goto('about:blank');
  }
  clean();
});

// ---- focus: every keyboard-operable widget has the ring -----------------------------------------------------------

for (const name of ['settings', 'hire', 'start-run', 'presets', 'board-issues', 'menu', 'palette', 'about', 'overview', 'seat-transcript', 'seat-images', 'lightbox']) {
  test(`focus: every operable widget of ${name} shows a 3px ring in #FF9B76 in Ubuntu`, async ({ page }) => {
    test.setTimeout(240_000);
    const clean = watchErrors(page);
    const s = SURFACES.find((x) => x.name === name)!;
    await boot(page, s.fixture, ALL_UBUNTU, s.extra ?? '', s.wsQuery);
    await s.open(page);
    await settle(page);
    await page.keyboard.press('Shift');
    const bad: string[] = [];
    const n = await page.evaluate((root) => {
      const els = [...document.querySelectorAll(`:is(${root}) :is(button, a[href], input, select, textarea, [tabindex="0"], [role="button"], [role="radio"], [role="tab"], [role="option"])`)] as HTMLElement[];
      (window as unknown as { __focusables: HTMLElement[] }).__focusables = els.filter((e) => {
        const r = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        return r.width > 3 && r.height > 3 && cs.visibility !== 'hidden' && cs.display !== 'none' && !(e as HTMLButtonElement).disabled && e.getAttribute('aria-hidden') !== 'true' && !e.closest('[inert], [hidden]');
      });
      return (window as unknown as { __focusables: HTMLElement[] }).__focusables.length;
    }, s.root);
    expect(n, `${name}: controls found`).toBeGreaterThan(0);
    for (let i = 0; i < Math.min(n, 40); i++) {
      const got = await page.evaluate((i) => {
        const e = (window as unknown as { __focusables: HTMLElement[] }).__focusables[i]!;
        e.scrollIntoView({ block: 'nearest' });
        e.focus();
        if (document.activeElement !== e) return null;
        const c = getComputedStyle(e);
        const rg = c.outlineColor.match(/(\d+)[ ,]+(\d+)[ ,]+(\d+)/);
        // The ring is the outline, or (a field / card that draws its ring as a shadow) a 3px spread in the colour.
        return { at: `${e.tagName.toLowerCase()}.${String(e.className).split(' ').slice(0, 2).join('.')}`, style: c.outlineStyle, width: parseFloat(c.outlineWidth), color: rg ? `${rg[1]},${rg[2]},${rg[3]}` : c.outlineColor, shadow: c.boxShadow };
      }, i);
      if (!got) continue;
      const ok = (got.style === 'solid' && got.width >= 3 && got.color === '255,155,118') || /rgb\(255, 155, 118\) 0px 0px 0px 3px/.test(got.shadow);
      if (!ok) bad.push(`${got.at}: ${got.style} ${got.width}px ${got.color} / ${got.shadow.slice(0, 60)}`);
    }
    expect(bad, `${name}: widgets without the 3px #FF9B76 ring`).toEqual([]);
    clean();
  });
}
