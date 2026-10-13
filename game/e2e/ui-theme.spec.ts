import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, openMenu, watchErrors } from './game';
import { boot, DESKTOP, NARROW, seed, SIM, sitAtTofu, SURFACES, type Themes, type UiTheme } from './ui-surfaces';
import { strays, targets, textSamples } from './ui-theme-probe';

// #216: the application UI theme in the real app (WebGL2, the fixture bridge): Settings → Appearance, live switching
// without losing anything, the saved choice before the first frame, blocked storage, the fonts the theme loads (and
// the ones it must not), every surface of the inventory free of Quiet's navy / yellow / Recursive in Ubuntu, the
// computed palette anchors, contrast on the rendered surfaces, the eight UI x transcript x terminal combinations, and
// the narrow / zoomed / forced-colors / reduced-motion / touch layouts. The screenshots are ui-theme-shots.spec.ts.
// #42: the per-surface audit and the finer state checks are @visual (make e2e-visual); a representative of each runs in
// every functional run (docs/research/e2e-selection.md). Every audit and combination is @theme too, so make e2e-visual
// runs all of them, the representatives included.

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

test('keyboard: arrows move the UI theme between Quiet and Ubuntu, the pick applies at once, Esc closes only Settings and gives the focus back', { tag: '@smoke' }, async ({ page }) => {
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

test('a saved Ubuntu survives a reload and no frame paints navy first', { tag: '@smoke' }, async ({ page }) => {
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

// #42: invalid and missing stored values (and the pre-frame script's reading of them) are src/ui/themePrefs.test.ts and
// src/ui/uiTheme.test.ts, the limits panel's src/ui/limitsPrefs.test.ts; this is the integrated start-up with storage
// that throws, for the theme picker and for the plan-limits panel (once m10-limits' own boot).
test('blocked and throwing storage is safe: Quiet at start-up, a working picker in memory, nothing persisted; the limits panel opens, closes and hides', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  // Storage that throws on every access (private windows, blocked site data).
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new DOMException('denied', 'SecurityError');
      },
    });
  });
  await openGame(page, 'demo-m5', '', SIM);
  expect(await uiAttr(page)).toBe('quiet');
  const dialog = await openSettings(page);
  await dialog.getByRole('radio', { name: /^Ubuntu/ }).check();
  expect(await uiAttr(page)).toBe('ubuntu');
  expect(await css(page, 'dialog.settings', 'background-color')).toBe(ANCHOR.surface);
  expect((await theme(page)).ui).toBe('ubuntu');
  await dialog.getByRole('radio', { name: /^Quiet/ }).check();
  expect(await uiAttr(page)).toBe('quiet');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  // The plan-limits panel: open and closed by a click and Shift+L, hidden and back, all in memory.
  const limitsOpen = async () => (await page.evaluate(() => window.__h3d.limits()))?.open;
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.limits()))?.lines.length, { message: 'readings arrived', timeout: 10_000 }).toBe(2);
  await page.locator('.lm-strip').click();
  expect(await limitsOpen()).toBe(true);
  await page.locator('.lm-strip').click();
  expect(await limitsOpen()).toBe(false);
  await page.keyboard.press('Shift+L');
  expect(await limitsOpen()).toBe(true);
  await page.locator('[data-key="limits-hide"]').click();
  await expect(page.locator('.limits')).toBeHidden();
  await page.keyboard.press('Shift+L'); // and back
  await expect(page.locator('.limits')).toBeVisible();
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
  // The light mat a building's uploaded logo is shown on in Buildings (logos are drawn for a light ground): the logo's, not the UI's.
  '.logo-thumb',
].join(', ');

// ---- the eight combinations --------------------------------------------------------------------------------------

const COMBOS: Themes[] = [];
for (const ui of ['quiet', 'ubuntu'] as UiTheme[]) for (const transcript of ['quiet', 'ubuntu'] as UiTheme[]) for (const terminal of ['quiet', 'ubuntu'] as UiTheme[]) COMBOS.push({ ui, transcript, terminal });

// #42: two combinations in every functional run, each pick apart from its neighbour (Ubuntu UI over Quiet transcript and
// Ubuntu terminal, and the reverse); the other six are @visual. All eight are @theme, so the visual profile runs them all.
const ROUTINE_COMBOS = ['ubuntu quiet ubuntu', 'quiet ubuntu quiet'];
for (const c of COMBOS) {
  const tag = ROUTINE_COMBOS.includes(`${c.ui} ${c.transcript} ${c.terminal}`) ? ['@theme'] : ['@theme', '@visual'];
  test(`combination ui=${c.ui} transcript=${c.transcript} terminal=${c.terminal}: independent selections, each surface in its own fonts and colours`, { tag }, async ({ page }) => {
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

test('view zoom and a mode switch leave the shell’s fonts, colours and sizes unchanged (Ubuntu UI)', { tag: '@visual' }, async ({ page }) => {
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

/** Zooms the seated transcript to `to` % with the keyboard (Ctrl+= / Ctrl+-, 10 % a step). */
async function zoomTo(page: Page, to: number): Promise<void> {
  for (let i = 0; i < 20 && (await theme(page)).transcriptZoom !== to; i++) {
    await page.keyboard.press((await theme(page)).transcriptZoom < to ? 'Control+=' : 'Control+-');
    await frames(page, 1);
  }
  expect((await theme(page)).transcriptZoom).toBe(to);
  await frames(page, 3);
}

test('transcript zoom 100 → 200 leaves the seated widgets (prompt box, Send, jump chip, answer controls) at the UI’s own sizes in Ubuntu; Quiet’s still zoom as before', async ({ page }) => {
  test.setTimeout(240_000);
  const clean = watchErrors(page);
  const WIDGETS = ['.tx-prompt', '.tx-prompt .cmp-editor', '.tx-send', '.tx-jump', '.tx-ask-opt', '.tx-ask-key', '.tx-ask-send'];
  const measure = () =>
    page.evaluate(
      (sels) =>
        sels.map((s) => {
          const e = document.querySelector(`.seat-transcript ${s}`);
          if (!e) return `${s}: missing`;
          const r = e.getBoundingClientRect();
          return `${s}: ${getComputedStyle(e).fontSize} ${Math.round(r.height)}px`;
        }),
      WIDGETS,
    );
  // Quiet first: a booted Ubuntu's seed would outlive its page (init scripts add up).
  for (const ui of ['quiet', 'ubuntu'] as UiTheme[]) {
    await boot(page, 'demo-m5', { ui }, '&prints=0');
    await sitAtTofu(page, 'transcript', 'Pebble', 0);
    // A question (the simulator's AskUserQuestion, as m16-ask): its card's answer controls, the prompt box under it.
    await page.evaluate(() => window.__h3d.simAsk({ id: 'cf1db588-9a66-4307-adfa-1bbe4306c2f3', ask: { tool_use_id: 'toolu_zoom', agent: 'claude', questions: [{ header: 'Color', question: 'Which color?', multi: false, other: true, options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue', description: 'Cool' }] }] } }));
    await expect(page.locator('.seat-transcript .tx-ask .tx-ask-opt').first()).toBeVisible();
    const at100 = await measure();
    expect(at100.filter((m) => m.endsWith('missing'))).toEqual([]);
    await page.locator('.seat-transcript .tx-scroll').focus();
    await zoomTo(page, 200);
    const at200 = await measure();
    if (ui === 'ubuntu') {
      expect(at200, 'Ubuntu: the widgets do not zoom').toEqual(at100);
      expect(at100.find((m) => m.startsWith('.tx-prompt .cmp-editor'))).toContain(': 14px');
      expect(parseFloat(at100.find((m) => m.startsWith('.tx-send:'))!.split(' ').pop()!)).toBeGreaterThanOrEqual(36);
      expect(parseFloat(at100.find((m) => m.startsWith('.tx-ask-opt:'))!.split(' ').pop()!)).toBeGreaterThanOrEqual(36);
    } else {
      // Quiet is as it was: its widgets follow the transcript's zoom.
      expect(at200.find((m) => m.startsWith('.tx-prompt:')), 'Quiet: the prompt box zooms').not.toBe(at100.find((m) => m.startsWith('.tx-prompt:')));
      expect(at200.find((m) => m.startsWith('.tx-send:'))).not.toBe(at100.find((m) => m.startsWith('.tx-send:')));
    }
    await page.goto('about:blank');
  }
  clean();
});

test('the completion popup’s commands and paths are the UI’s Ubuntu Mono at 14px with a Quiet transcript, at any transcript zoom; the conversation’s code keeps the transcript’s mono', { tag: '@visual' }, async ({ page }) => {
  test.setTimeout(240_000);
  const clean = watchErrors(page);
  for (const name of ['completion-commands', 'completion-files']) {
    const s = SURFACES.find((x) => x.name === name)!;
    await boot(page, s.fixture, { ui: 'ubuntu', transcript: 'quiet' }, s.extra ?? '', s.wsQuery);
    await s.open(page);
    const sel = name === 'completion-commands' ? '.seat-transcript .cmp-pop .tx-cmd-name' : '.seat-transcript .cmp-pop .tx-file';
    const font = () => page.locator(sel).first().evaluate((e) => `${getComputedStyle(e).fontFamily.split(',')[0]!.trim()} ${getComputedStyle(e).fontSize}`).catch(() => 'detached');
    await expect.poll(font).toMatch(/^"?Ubuntu Mono"? 14px$/); // (the rows re-render as the list settles)
    // The transcript's own mono (a code span in a message) stays the Quiet preset's.
    expect(await page.locator('.seat-transcript .tx').evaluate((e) => getComputedStyle(e).getPropertyValue('--tx-mono'))).toMatch(/JetBrains/);
    await page.keyboard.press('Escape'); // closes only the popup
    await page.locator('.seat-transcript .tx-scroll').focus();
    await zoomTo(page, 200);
    await page.locator('.seat-transcript .cmp-editor').click();
    await page.keyboard.press('End');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(name === 'completion-commands' ? '/' : 'p');
    await expect(page.locator(sel).first()).toBeVisible();
    await expect.poll(font).toMatch(/^"?Ubuntu Mono"? 14px$/); // (the rows re-render as the list settles)
    await page.goto('about:blank');
  }
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

for (const size of [{ name: '1280x720', ...DESKTOP, floor: 150 }, { name: '200% browser zoom (640x360)', width: 640, height: 360, floor: 0 }]) {
  // #42: the 200% zoom one in every functional run, the laptop size @visual.
  test(`layout at ${size.name}: the seated conversation’s timeline and prompt box are on the screen or reached by scrolling it, never under the strip (Ubuntu)`, { tag: size.floor ? ['@visual'] : [] }, async ({ page }) => {
    test.setTimeout(180_000);
    const clean = watchErrors(page);
    const s = SURFACES.find((x) => x.name === 'seat-transcript')!;
    await boot(page, s.fixture, ALL_UBUNTU, s.extra ?? '', s.wsQuery, size);
    await s.open(page);
    await settle(page);
    const got = await page.evaluate(() => {
      const tx = document.querySelector('.seat-transcript .tx') as HTMLElement;
      const seen = (el: Element) => {
        const a = el.getBoundingClientRect();
        const b = tx.getBoundingClientRect();
        return { h: Math.round(a.height), visible: Math.round(Math.max(0, Math.min(a.bottom, b.bottom, innerHeight) - Math.max(a.top, b.top, 0))) };
      };
      const timeline = document.querySelector('.seat-transcript .tx-scroll')!;
      const prompt = document.querySelector('.seat-transcript .tx-prompt')!;
      const first = { timeline: seen(timeline).visible, screen: Math.round(tx.getBoundingClientRect().height), scrolls: getComputedStyle(tx).overflowY };
      // Reached: brought into view the way the keyboard's focus would bring it.
      timeline.scrollIntoView({ block: 'nearest' });
      const tl = seen(timeline);
      prompt.scrollIntoView({ block: 'nearest' });
      const pr = seen(prompt);
      return { first, tl, pr };
    });
    // The timeline: at least half the screen (or all of it, if less) once reached; the prompt box whole.
    expect(got.tl.visible, `timeline seen once reached: ${JSON.stringify(got)}`).toBeGreaterThanOrEqual(Math.min(got.tl.h, Math.floor(got.first.screen / 2)) - 1);
    expect(got.pr.visible, `prompt box seen once reached: ${JSON.stringify(got)}`).toBeGreaterThanOrEqual(got.pr.h - 1);
    // On a laptop-sized screen the strip's second row does not squeeze the conversation: it is there without scrolling.
    expect(got.first.timeline, `timeline without scrolling: ${JSON.stringify(got)}`).toBeGreaterThanOrEqual(size.floor);
    clean();
  });
}

test('touch targets: Ubuntu standard controls are >= 36 px, icon controls >= 32 px, and >= 44 px on a coarse pointer', async ({ browser }) => {
  test.setTimeout(240_000);
  const sizes = async (page: Page, root: string) =>
    page.evaluate((sel) => {
      const out: Array<{ at: string; w: number; h: number; icon: boolean; dense: boolean }> = [];
      for (const b of document.querySelectorAll(`${sel} button, ${sel} input[type="checkbox"], ${sel} input[type="radio"], ${sel} select`)) {
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
    await openGame(page, 'demo-m4', '', SIM);
    await openMenu(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    const tooSmall = async (root: string) => (await sizes(page, root)).filter((t) => (coarse ? t.w < 44 || t.h < 44 : t.icon || t.dense ? t.w < 32 || t.h < 32 : t.h < 36)).map((t) => `${t.at} ${t.w}x${t.h}`);
    expect(await tooSmall('dialog.settings'), `settings, ${coarse ? 'coarse' : 'fine'} pointer`).toEqual([]);
    await page.keyboard.press('Escape');
    // The Hire dialog and the top bar's menu.
    await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
    await frames(page, 3);
    await page.evaluate(() => window.__h3d.openHire(5));
    await expect.poll(async () => ((await page.evaluate(() => window.__h3d.dialog())) as { state?: string } | null)?.state).toBe('ready');
    expect(await tooSmall('dialog.desk-dlg--hire'), `hire, ${coarse ? 'coarse' : 'fine'} pointer`).toEqual([]);
    await page.keyboard.press('Escape');
    await openMenu(page);
    expect(await tooSmall('.topbar-menu'), `menu, ${coarse ? 'coarse' : 'fine'} pointer`).toEqual([]);
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

test('the whiteboard’s phone toolbar at 390px: every tool on the board and in reach, 44px on a touch screen and 32px with a mouse (Ubuntu)', async ({ browser }) => {
  test.setTimeout(240_000);
  for (const coarse of [true, false]) {
    const ctx = await browser.newContext({ viewport: { ...NARROW }, hasTouch: coarse, isMobile: coarse });
    const page = await ctx.newPage();
    const clean = watchErrors(page);
    const s = SURFACES.find((x) => x.name === 'whiteboard')!;
    await boot(page, s.fixture, { ui: 'ubuntu' }, s.extra ?? '', s.wsQuery, NARROW);
    await s.open(page);
    await settle(page);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(coarse);
    const min = coarse ? 44 : 32;
    const toolbar = '.wb .App-toolbar-container, .wb .mobile-misc-tools-container';
    const tools = await targets(page, toolbar);
    expect(tools.length, 'the toolbar’s tools, the lock and the hand').toBeGreaterThanOrEqual(12);
    expect(tools.filter((t) => t.w < min || t.h < min).map((t) => `${t.at} ${t.w}x${t.h}`), `${coarse ? 'touch' : 'mouse'}: tools under ${min}px`).toEqual([]);
    // On the board (its frame clips): no tool past its edge, no tool under another.
    const placed = await page.evaluate((sel) => {
      const surface = document.querySelector('.wb-surface') as HTMLElement;
      const sb = surface.getBoundingClientRect();
      const inner = { l: sb.left + surface.clientLeft, t: sb.top + surface.clientTop, r: sb.left + surface.clientLeft + surface.clientWidth, b: sb.top + surface.clientTop + surface.clientHeight };
      const els = [...document.querySelectorAll(`:is(${sel}) :is(label.ToolIcon, .App-toolbar__extra-tools-trigger)`)].filter((e) => e.getBoundingClientRect().width > 0);
      const out: string[] = [];
      const rects = els.map((e) => ({ name: (e.getAttribute('title') ?? e.getAttribute('aria-label') ?? e.className).slice(0, 24), r: e.getBoundingClientRect() }));
      for (const { name, r } of rects) if (r.left < inner.l - 0.5 || r.right > inner.r + 0.5 || r.top < inner.t - 0.5) out.push(`${name} off the board: ${Math.round(r.left)}..${Math.round(r.right)} of ${Math.round(inner.l)}..${Math.round(inner.r)}`);
      for (let i = 0; i < rects.length; i++)
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i]!.r, b = rects[j]!.r;
          if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.push(`${rects[i]!.name} overlaps ${rects[j]!.name}`);
        }
      return { out, n: rects.length };
    }, toolbar);
    expect(placed.n).toBeGreaterThanOrEqual(12);
    expect(placed.out, coarse ? 'touch' : 'mouse').toEqual([]);
    // The last ones (Insert image, Eraser, More tools) answer a tap where they are drawn.
    await page.locator('.wb .App-toolbar-container label.ToolIcon[title^="Eraser"]').click();
    await expect(page.locator('.wb .App-toolbar-container [data-testid="toolbar-eraser"]')).toBeChecked();
    clean();
    await ctx.close();
  }
});

test('forced colors: the whiteboard’s tools stay visible (system text on the system canvas) and the selected tool is the system highlight (Ubuntu)', async ({ page }) => {
  test.setTimeout(240_000);
  const clean = watchErrors(page);
  await page.emulateMedia({ forcedColors: 'active' });
  const s = SURFACES.find((x) => x.name === 'whiteboard')!;
  await boot(page, s.fixture, { ui: 'ubuntu' }, s.extra ?? '', s.wsQuery);
  await s.open(page);
  await page.keyboard.press('Escape'); // the rectangle tool's selection off: the Selection tool is the checked one
  await settle(page);
  expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
  const icons = await page.evaluate(() => {
    const lum = (c: string) => {
      const m = c.match(/(\d+)[ ,]+(\d+)[ ,]+(\d+)/);
      if (!m) return NaN;
      const [r, g, b] = [m[1], m[2], m[3]].map((v) => {
        const x = Number(v) / 255;
        return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const bgOf = (e: Element | null): string => {
      for (let n = e; n; n = n.parentElement) {
        const c = getComputedStyle(n).backgroundColor;
        if (!/rgba\(.*, 0\)$|transparent/.test(c)) return c;
      }
      return 'rgb(255, 255, 255)';
    };
    return [...document.querySelectorAll('.wb .App-toolbar-container label.ToolIcon, .wb .App-menu label.ToolIcon')].map((l) => {
      const icon = l.querySelector('.ToolIcon__icon')!;
      const svg = icon.querySelector('svg')!;
      const fg = getComputedStyle(svg).color;
      const bg = bgOf(icon);
      const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x) as [number, number];
      return { name: (l.getAttribute('title') ?? '').slice(0, 20), checked: !!l.querySelector('input:checked'), fg, bg, ratio: (a + 0.05) / (b + 0.05) };
    });
  });
  expect(icons.length).toBeGreaterThanOrEqual(10);
  expect(icons.filter((i) => i.ratio < 3).map((i) => `${i.name}: ${i.fg} on ${i.bg} = ${i.ratio.toFixed(2)}`), 'tool icons under 3:1').toEqual([]);
  const checked = icons.filter((i) => i.checked);
  const unchecked = icons.filter((i) => !i.checked);
  expect(checked.length, 'a selected tool').toBeGreaterThanOrEqual(1);
  for (const c of checked) expect(c.bg, `${c.name}: the selected tool is told apart by its fill`).not.toBe(unchecked[0]!.bg);
  clean();
});

test('the empty whiteboard’s welcome (heading, hints) is Ubuntu UI text in Ubuntu and Excalidraw’s hand in Quiet; the drawing’s own text is not touched', { tag: '@visual' }, async ({ page }) => {
  test.setTimeout(240_000);
  const clean = watchErrors(page);
  const s = SURFACES.find((x) => x.name === 'whiteboard-empty')!;
  for (const ui of ['quiet', 'ubuntu'] as UiTheme[]) {
    await boot(page, s.fixture, { ui }, s.extra ?? '', s.wsQuery);
    await s.open(page);
    const fonts = await page.evaluate(() =>
      [...document.querySelectorAll('.wb .welcome-screen-center__heading, .wb .welcome-screen-decor-hint__label')].map((e) => `${(e.textContent ?? '').trim().slice(0, 20)}: ${getComputedStyle(e).fontFamily}`),
    );
    expect(fonts.length, 'the heading and the hints').toBeGreaterThanOrEqual(2);
    for (const f of fonts) expect(f, ui).toMatch(ui === 'ubuntu' ? /: "?Ubuntu"?,/ : /Excalifont/);
    // A text element typed on the board keeps the drawing's font (the editor's own setting), in both themes.
    const box = (await page.locator('.wb-canvas').boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.6);
    await page.keyboard.press('t');
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.6);
    await expect(page.locator('.excalidraw-wysiwyg')).toBeVisible();
    expect(await page.locator('.excalidraw-wysiwyg').evaluate((e) => getComputedStyle(e).fontFamily)).toMatch(/Excalifont/);
    await page.keyboard.press('Escape');
    await page.goto('about:blank');
  }
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

test('states: inside the transcript the composer’s Send, the selected tab and its count keep the UI theme’s colours (#111): dark on orange, never white', { tag: '@visual' }, async ({ page }) => {
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

// ---- the per-surface audit: palette, contrast, targets, focus and layout after one boot ----------------------------
// #42: one page per surface and viewport for every check that reads it (they were a test each). A representative of
// each component family runs in every functional run; the whole inventory (@theme) is in the visual profile (make
// e2e-visual), for CSS and theme work.

/** Every keyboard-operable widget of `root`, focused forwards then backwards: those without the issue's ring (3px #FF9B76, 2px outside), or with it clipped or covered; null when there is none. */
async function focusRings(page: Page, root: string): Promise<string[] | null> {
  await settle(page);
  await page.keyboard.press('Shift');
  const bad: string[] = [];
  const n = await page.evaluate((root) => {
    const els = [...document.querySelectorAll(`:is(${root}) :is(button, a[href], input, select, textarea, [contenteditable="true"], [tabindex="0"], [role="button"], [role="radio"], [role="tab"], [role="option"])`)] as HTMLElement[];
    (window as unknown as { __focusables: HTMLElement[] }).__focusables = els.filter((e) => {
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return r.width > 3 && r.height > 3 && cs.visibility !== 'hidden' && cs.display !== 'none' && !(e as HTMLButtonElement).disabled && e.getAttribute('aria-hidden') !== 'true' && !e.closest('[inert], [hidden]');
    });
    (window as unknown as { __sticky: Element[] }).__sticky = [...document.querySelectorAll('*')].filter((x) => getComputedStyle(x).position === 'sticky');
    return (window as unknown as { __focusables: HTMLElement[] }).__focusables.length;
  }, root);
  if (n === 0) return null;
  // Forwards (Tab), then backwards (Shift+Tab): scrolling up brings a widget in at a scroller's top edge, under a
  // sticky heading if there is one.
  const order = [...Array(Math.min(n, 150)).keys()];
  for (const i of [...order, ...order.slice(0, -1).reverse()]) {
    const got = await page.evaluate(async (i) => {
      const e = (window as unknown as { __focusables: HTMLElement[] }).__focusables[i]!;
      e.scrollIntoView({ block: 'nearest' });
      e.focus();
      if (document.activeElement !== e) return null;
      // Measured where the focus leaves it: a focus transition (the Overview row's lift) is let finish first.
      void getComputedStyle(e).transform;
      await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined)));
      if (document.activeElement !== e) return null;
      // A native input drawn invisible (the whiteboard's tool radios) shows its focus on the control it stands for.
      let ringOn: HTMLElement = e;
      const ringed = (x: Element) => {
        const xc = getComputedStyle(x);
        return (xc.outlineStyle !== 'none' && parseFloat(xc.outlineWidth) > 0) || /0px 0px 0px 3px/.test(xc.boxShadow);
      };
      // A widget that fills a box that clips (the whiteboard's editor in its board) may have that box wear its ring:
      // an ancestor up to two levels up that draws one around it.
      if (!ringed(e)) {
        const up = [e.parentElement, e.parentElement?.parentElement].find((x) => x && ringed(x));
        if (up) ringOn = up;
      }
      if (getComputedStyle(e).opacity === '0') {
        const drawn = [e.nextElementSibling, e.closest('label'), e.parentElement].filter((x): x is HTMLElement => !!x && getComputedStyle(x).opacity !== '0');
        const ringed = drawn.find((x) => {
          const xc = getComputedStyle(x);
          return (xc.outlineStyle !== 'none' && parseFloat(xc.outlineWidth) > 0) || /0px 0px 0px 3px/.test(xc.boxShadow);
        });
        if (ringed ?? drawn[0]) ringOn = (ringed ?? drawn[0])!;
      }
      const c = getComputedStyle(ringOn);
      const rg = c.outlineColor.match(/(\d+)[ ,]+(\d+)[ ,]+(\d+)/);
      const width = parseFloat(c.outlineWidth);
      const offset = parseFloat(c.outlineOffset);
      const outline = c.outlineStyle !== 'none' && width > 0;
      // Never clipped: the ring's outer edge is inside every box between it and the page that clips (overflow other than visible).
      // (An inset shadow ring is drawn inside its box.)
      const reach = outline ? Math.max(0, offset) + width : / inset/.test(c.boxShadow) ? 0 : 3;
      const r = ringOn.getBoundingClientRect();
      const ring = { l: r.left - reach, t: r.top - reach, r: r.right + reach, b: r.bottom + reach };
      let clipped = '';
      let judgeX = true, judgeY = true;
      // Only a box on the ring's containing-block chain clips it (a fixed or absolutely placed widget escapes the
      // boxes between it and its containing block: the plan-limits tab inside a top-layer dialog).
      const makesCb = (n: Element, fixed: boolean) => {
        const ns = getComputedStyle(n);
        return (!fixed && ns.position !== 'static') || ns.transform !== 'none' || ns.filter !== 'none' || ns.perspective !== 'none' || /paint|layout|strict|content/.test(ns.contain) || /transform|filter|perspective/.test(ns.willChange) || (ns.containerType ?? 'normal') !== 'normal';
      };
      const chain = new Set<Element>();
      for (let x: Element | null = ringOn; x; ) {
        const pos = getComputedStyle(x).position;
        let next: Element | null = x.parentElement;
        if (pos === 'fixed' || pos === 'absolute') while (next && !makesCb(next, pos === 'fixed')) next = next.parentElement;
        if (next) chain.add(next);
        x = next;
      }
      for (let n = ringOn.parentElement; n && !clipped; n = n.parentElement) {
        if (!chain.has(n)) continue;
        const ns = getComputedStyle(n);
        if (ns.display === 'inline' || ns.display === 'contents') continue;
        const cx = ns.overflowX !== 'visible', cy = ns.overflowY !== 'visible';
        if (!cx && !cy) continue;
        const b = n.getBoundingClientRect();
        const box = { l: b.left + n.clientLeft, t: b.top + n.clientTop, r: b.left + n.clientLeft + n.clientWidth, b: b.top + n.clientTop + n.clientHeight };
        // (Bigger than the box on an axis, e.g. a tall picture in the timeline, it is seen by scrolling: that axis is not judged.)
        // (Once a nearer scroller cannot hold it on an axis, the boxes outside it are not judged on that axis either.)
        if (cx && ring.r - ring.l > box.r - box.l + 1) judgeX = false;
        if (cy && ring.b - ring.t > box.b - box.t + 1) judgeY = false;
        const out = (cx && judgeX && (ring.l < box.l - 0.5 || ring.r > box.r + 0.5)) || (cy && judgeY && (ring.t < box.t - 0.5 || ring.b > box.b + 0.5));
        const f = (q: { l: number; t: number; r: number; b: number }) => [q.l, q.t, q.r, q.b].map(Math.round).join(',');
        if (out) clipped = `${n.tagName.toLowerCase()}.${String(n.className).split(' ').slice(0, 2).join('.')} (ring ${f(ring)}, box ${f(box)})`;
      }
      // Never covered: no sticky bar (a scroller's heading or Save foot) lies over the ring.
      if (!clipped) {
        for (const st of (window as unknown as { __sticky: Element[] }).__sticky) {
          if (st.contains(ringOn) || ringOn.contains(st)) continue;
          const sc = getComputedStyle(st);
          if (sc.position !== 'sticky' || sc.display === 'none' || sc.visibility === 'hidden') continue;
          const b = st.getBoundingClientRect();
          if (b.width < 1 || b.height < 1) continue;
          if (ring.l < b.right - 0.5 && ring.r > b.left + 0.5 && ring.t < b.bottom - 0.5 && ring.b > b.top + 0.5) {
            clipped = `the sticky ${st.tagName.toLowerCase()}.${String(st.className).split(' ').slice(0, 2).join('.')} over it (ring ${[ring.l, ring.t, ring.r, ring.b].map(Math.round).join(',')})`;
            break;
          }
        }
      }
      const tag = (x: Element) => `${x.tagName.toLowerCase()}.${String(x.className).split(' ').slice(0, 2).join('.')}`;
      // The ring is the outline, or (a field / card that draws its ring as a shadow) a 3px spread in the colour.
      // The issue's exact geometry on every widget: 3px, exactly 2px off, never clipped.
      return { at: tag(e) + (ringOn !== e ? ` → ${tag(ringOn)}` : ''), outline, style: c.outlineStyle, width, offset, color: rg ? `${rg[1]},${rg[2]},${rg[3]}` : c.outlineColor, shadow: c.boxShadow, clipped };
    }, i);
    if (!got) continue;
    const asOutline = got.style === 'solid' && got.width === 3 && got.color === '255,155,118' && got.offset === 2;
    const asShadow = /rgb\(255, 155, 118\) 0px 0px 0px 3px/.test(got.shadow);
    if (!asOutline && !asShadow) bad.push(`${got.at}: ${got.style} ${got.width}px offset ${got.offset}px ${got.color} / ${got.shadow.slice(0, 60)}`);
    else if (got.clipped) bad.push(`${got.at}: its ring is clipped by ${got.clipped}`);
  }
  return [...new Set(bad)];
}

const AUDIT_ROOTS = '.topbar, .limits, .hud .prompt, .hud .hint, .toast';
const ZOOMED = { width: 640, height: 360 } as const;
type AuditSize = 'desktop' | 'narrow' | 'zoomed';
const AUDIT_SIZES: Record<AuditSize, { label: string; size: { width: number; height: number }; checks: string }> = {
  desktop: { label: '1280x720', size: DESKTOP, checks: 'no Quiet navy, yellow or Recursive; text 4.5:1 on what sits behind it; controls >= 32 x 32 px, labelled ones >= 36 px high; a 3px #FF9B76 ring 2px outside every operable widget, never clipped or under a sticky bar' },
  narrow: { label: '390x844', size: NARROW, checks: 'no sideways overflow or clipped control; the focus ring on every operable widget, never clipped' },
  zoomed: { label: '200% browser zoom (640x360)', size: ZOOMED, checks: 'no sideways overflow or clipped control' },
};
/** The family representatives every functional run audits (Settings and Hire, the seat's transcript and terminal, board and overview, the whiteboard); the rest are @visual only. */
const AUDITED: Record<AuditSize, string[]> = {
  desktop: ['settings', 'hire', 'seat-transcript', 'seat-terminal', 'board-issues', 'overview', 'whiteboard'],
  narrow: ['hire'],
  zoomed: ['settings'],
};

for (const kind of ['desktop', 'narrow', 'zoomed'] as AuditSize[]) {
  const { label, size, checks } = AUDIT_SIZES[kind];
  for (const s of SURFACES.filter((x) => kind === 'desktop' || !x.skipNarrow)) {
    // The narrow Hire audit is the smoke run's one narrow layout / keyboard-focus journey. Every audit is @theme, so the
    // visual profile runs every surface's, the representatives too.
    const tag = ['@theme', ...(!AUDITED[kind].includes(s.name) ? ['@visual'] : kind === 'narrow' ? ['@smoke'] : [])];
    test(`audit at ${label}: ${s.name} in Ubuntu: ${checks}`, { tag }, async ({ page }) => {
      test.setTimeout(360_000);
      const clean = watchErrors(page);
      await boot(page, s.fixture, ALL_UBUNTU, s.extra ?? '', s.wsQuery, size);
      await s.open(page);
      await page.waitForTimeout(300);
      if (kind === 'desktop') {
        const found = await strays(page, `${s.root}, ${AUDIT_ROOTS}, .excalidraw-modal-container, .excalidraw .Island`, ALLOW);
        expect.soft(found.map((f) => `${f.at} ${f.prop}: ${f.value} (${f.why})`), `${s.name}: Quiet leftovers`).toEqual([]);
        // The editor's swatch hotkeys are drawn on the artwork colour in a colour Excalidraw picks for it, the same in both themes.
        const samples = await textSamples(page, `${s.root}, ${AUDIT_ROOTS}`, '.excalidraw canvas, canvas, img, .seat-swatch, .settings-theme-swatch, .color-picker__button__hotkey-label');
        expect.soft(samples.length, `${s.name}: the probe found text to measure`).toBeGreaterThan(5);
        const bad = samples.filter((t) => (t.ratio !== null && t.ratio < (t.size >= 24 || (t.size >= 18.66 && Number(t.weight) >= 700) ? 3 : 4.5)) || t.bg === 'translucent');
        expect
          .soft(
            bad.map((t) => `${t.at} "${t.text}" ${t.fg} on ${t.bg} = ${t.ratio?.toFixed(2)} (${t.size}px, from ${t.bgFrom})`),
            `${s.name}: text under 4.5:1 or on a translucent surface`,
          )
          .toEqual([]);
        const small = (await targets(page, `${s.root}, ${AUDIT_ROOTS}, .excalidraw-modal-container`)).filter((t) => t.w < 32 || t.h < (t.kind === 'standard' ? 36 : 32));
        expect.soft(small.map((t) => `${t.at} ${t.w}x${t.h} (${t.kind})`), `${s.name}: controls under the Ubuntu sizes`).toEqual([]);
      } else {
        expect.soft(await noOverflow(page, `${s.root}, .topbar`), `${s.name} at ${label}: overflow`).toEqual([]);
      }
      // Last: walking the focus scrolls and moves it.
      if (kind !== 'zoomed') {
        const rings = await focusRings(page, s.root);
        if (rings) expect.soft(rings, `${s.name} at ${label}: widgets without the 3px #FF9B76 ring 2px outside them, or with it clipped or covered`).toEqual([]);
      }
      clean();
    });
  }
}

test('states: a hire in flight (the bridge’s ack held) keeps the primary orange with a dark label and a spinner, says aria-busy, and refuses a second press', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  await boot(page, 'demo-m4', { ui: 'ubuntu' }, '', 'play=none&sim=1&simms=150&simusage=0&simclock=manual');
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  await page.evaluate(() => window.__h3d.openHire(5));
  await expect.poll(async () => ((await page.evaluate(() => window.__h3d.dialog())) as { state?: string } | null)?.state).toBe('ready');
  const hire = page.locator('dialog.desk-dlg--hire [data-key="hire"]');
  const widthBefore = await hire.evaluate((b) => b.getBoundingClientRect().width);
  await hire.click();
  await expect(hire).toHaveText('Hiring…');
  await expect(hire).toHaveAttribute('aria-busy', 'true');
  const busy = await pair(page, 'dialog.desk-dlg--hire [data-key="hire"]');
  expect([rgbToHex(busy.bg), rgbToHex(busy.fg)]).toEqual(['#e95420', '#2c001e']);
  expect(busy.ratio).toBeGreaterThanOrEqual(4.5);
  expect(await hire.evaluate((b) => getComputedStyle(b, '::before').content)).toBe('""');
  expect(Math.abs((await hire.evaluate((b) => b.getBoundingClientRect().width)) - widthBefore)).toBeLessThan(60);
  // A second press is not a second hire.
  await hire.click({ force: true });
  await page.keyboard.press('Control+Enter');
  expect((await page.evaluate(() => window.__h3d.sent())).filter((c) => c.t === 'worker.hire')).toHaveLength(1);
  clean();
});

test('states: the review’s Hire in flight (#212) is busy like the hire dialog’s: orange, dark label, spinner, focus kept, no second hire', { tag: '@visual' }, async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  const s = SURFACES.find((x) => x.name === 'hire-review-ready')!;
  await boot(page, s.fixture, { ui: 'ubuntu' }, '', 'play=none&sim=1&simms=150&simusage=0&simclock=manual');
  await s.open(page);
  const hire = page.locator('dialog.desk-dlg--review [data-key="hire"]');
  await hire.focus();
  await page.keyboard.press('Enter');
  await expect(hire).toHaveText('Hiring…');
  await expect(hire).toHaveAttribute('aria-busy', 'true');
  await expect(hire).toBeFocused();
  const busy = await pair(page, 'dialog.desk-dlg--review [data-key="hire"]');
  expect([rgbToHex(busy.bg), rgbToHex(busy.fg)]).toEqual(['#e95420', '#2c001e']);
  expect(busy.ratio).toBeGreaterThanOrEqual(4.5);
  expect(await hire.evaluate((b) => getComputedStyle(b, '::before').content)).toBe('""');
  await hire.click({ force: true });
  expect((await page.evaluate(() => window.__h3d.sent())).filter((c) => c.t === 'worker.hire')).toHaveLength(1);
  clean();
});

test('states: a preset being deleted (natively disabled and busy) keeps the final destructive fill with a dark label and spinner, never the disabled look', { tag: '@visual' }, async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  const s = SURFACES.find((x) => x.name === 'presets-deleting')!;
  await boot(page, s.fixture, { ui: 'ubuntu' }, s.extra ?? '', s.wsQuery);
  await s.open(page);
  const sel = 'dialog.desk-dlg--presets [data-key^="confirm-delete:"]';
  await expect(page.locator(sel)).toHaveText('Deleting…');
  const busy = await pair(page, sel);
  expect([rgbToHex(busy.bg), rgbToHex(busy.fg)]).toEqual(['#ff8a80', '#2c001e']);
  expect(busy.ratio).toBeGreaterThanOrEqual(4.5);
  const spinner = await page.locator(sel).evaluate((b) => ({ content: getComputedStyle(b, '::before').content, ring: getComputedStyle(b, '::before').borderTopColor, opacity: getComputedStyle(b).opacity }));
  expect(spinner.content).toBe('""');
  expect(rgbToHex(spinner.ring)).toBe('#2c001e');
  expect(spinner.opacity).toBe('1');
  clean();
});

test('states: a reviewer’s verdict stamps are Ubuntu status chips: raised purple, the status colour as ink and border, the word kept (Quiet: white paper)', { tag: '@visual' }, async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  const s = SURFACES.find((x) => x.name === 'crew-stamp')!;
  for (const ui of ['quiet', 'ubuntu'] as UiTheme[]) {
    await boot(page, s.fixture, { ui }, s.extra ?? '', s.wsQuery);
    await s.open(page);
    const stamp = page.locator('.prompt .prompt-crew .crew-stamp');
    const want: Record<string, [string, string]> = ui === 'ubuntu' ? { pass: ['#3b1330', '#6be08f'], changes: ['#3b1330', '#ff8a80'], incomplete: ['#3b1330', '#cdb1c6'] } : { pass: ['#ffffff', '#0b8454'], changes: ['#ffffff', '#c42a26'], incomplete: ['#ffffff', '#5d6478'] };
    for (const [kind, [bg, fg]] of Object.entries(want)) {
      await stamp.evaluate((e, k) => e.setAttribute('class', `crew-stamp crew-stamp--${k}`), kind);
      const got = await stamp.evaluate((e) => ({ bg: getComputedStyle(e).backgroundColor, fg: getComputedStyle(e).color, border: getComputedStyle(e).borderTopColor }));
      expect([rgbToHex(got.bg), rgbToHex(got.fg), rgbToHex(got.border)], `${ui} ${kind}`).toEqual([bg, fg, fg]);
      if (ui === 'ubuntu') expect((await pair(page, '.prompt .prompt-crew .crew-stamp')).ratio, kind).toBeGreaterThanOrEqual(4.5);
    }
    await page.goto('about:blank');
  }
  clean();
});

test('states: the elevator’s floor plates are Ubuntu controls: raised purple with a white number at rest, the lit ring on hover, orange with the dark number where you are and pressed', { tag: '@visual' }, async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  const s = SURFACES.find((x) => x.name === 'elevator')!;
  await boot(page, s.fixture, { ui: 'ubuntu' }, s.extra ?? '', s.wsQuery);
  await s.open(page);
  const plate = (sel: string) => page.locator(sel).first().evaluate((e) => ({ bg: getComputedStyle(e).backgroundColor, img: getComputedStyle(e).backgroundImage, fg: getComputedStyle(e).color, ring: getComputedStyle(e).boxShadow }));
  const here = await plate('dialog.panel .lift-go[aria-current="location"] .lift-num');
  expect([rgbToHex(here.bg), here.img, rgbToHex(here.fg)]).toEqual(['#e95420', 'none', '#2c001e']);
  const other = 'dialog.panel .lift-go:not([aria-current]) .lift-num';
  const rest = await plate(other);
  expect([rgbToHex(rest.bg), rest.img, rgbToHex(rest.fg)]).toEqual(['#3b1330', 'none', '#ffffff']);
  expect(rest.ring).toContain('rgb(174, 147, 167)');
  await page.locator('dialog.panel .lift-go:not([aria-current])').first().hover();
  await expect.poll(async () => (await plate(other)).ring).toContain('rgb(255, 155, 118)');
  await page.mouse.down();
  // (The plate eases its fill and number for 200 ms on a page that draws a few frames a second.)
  await expect.poll(async () => rgbToHex((await plate(other)).bg), { timeout: 15_000 }).toBe('#ed764d');
  await expect.poll(async () => rgbToHex((await plate(other)).fg), { timeout: 15_000 }).toBe('#2c001e');
  await page.mouse.move(1, 1);
  await page.mouse.up();
  // The Buildings list's small plates are the same control at rest.
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__h3d.openBuildings());
  const small = await plate('dialog.panel .dir-floor .lift-num--sm');
  expect([rgbToHex(small.bg), small.img, rgbToHex(small.fg)]).toEqual(['#3b1330', 'none', '#ffffff']);
  clean();
});

// ---- what must survive a live switch ---------------------------------------------------------------------------------

test('a live switch leaves the whiteboard’s drawing, its canvas and its saved data untouched (the editor stays light, nothing is filtered)', async ({ page }) => {
  test.setTimeout(240_000);
  const clean = watchErrors(page);
  const wb = SURFACES.find((x) => x.name === 'whiteboard')!;
  await boot(page, wb.fixture, {}, wb.extra ?? '', wb.wsQuery);
  await wb.open(page);
  const read = () =>
    page.evaluate(() => {
      const api = window.__h3d.excalidraw() as { getSceneElements(): unknown[]; getAppState(): { theme: string; viewBackgroundColor: string } } | null;
      const canvases = [...document.querySelectorAll<HTMLCanvasElement>('.wb canvas')].filter((c) => c.width > 100 && c.height > 100);
      const filters = canvases.map((c) => getComputedStyle(c).filter);
      const staticCanvas = canvases.find((c) => c.classList.contains('static')) ?? canvases[0]!;
      return { elements: JSON.stringify(api?.getSceneElements() ?? [], (k, v) => (k === 'boundElements' && !v?.length ? null : v)), theme: api?.getAppState().theme, bg: api?.getAppState().viewBackgroundColor, filters, pixels: staticCanvas.toDataURL().length, hash: staticCanvas.toDataURL().slice(-400) };
    });
  const before = await read();
  expect(before.theme).toBe('light');
  expect(JSON.parse(before.elements).length).toBeGreaterThan(0);
  await page.evaluate(() => window.__h3d.setUiTheme('ubuntu'));
  await frames(page, 4);
  const after = await read();
  expect(after).toEqual(before);
  expect(after.filters.every((f) => f === 'none')).toBe(true);
  // The editor's own controls did follow: the toolbar is the raised purple in Ubuntu fonts, outside the canvas.
  expect(await page.locator('.wb .App-toolbar, .wb .Island').first().evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(ANCHOR.raised);
  expect(await page.locator('.wb .excalidraw').first().evaluate((e) => getComputedStyle(e).fontFamily)).toContain('Ubuntu');
  await page.evaluate(() => window.__h3d.setUiTheme('quiet'));
  await frames(page, 4);
  expect(await read()).toEqual(before);
  clean();
});

test('a live switch leaves the terminal’s screen, the seated worker, a typed draft and the conversation alone', async ({ page }) => {
  test.setTimeout(240_000);
  const clean = watchErrors(page);
  await boot(page, 'demo-m5', { terminal: 'ubuntu' }, '&prints=0');
  const id = await sitAtTofu(page, 'terminal');
  // The recorded agent thinks (a spinner, a clock), answers and starts over: a key it does not echo (Up) settles the
  // fixture's screen where its recording ends, then wait until the frames stop coming, so the comparison sees the theme
  // switch and not the recording playing on.
  const screen = () => page.evaluate((w) => (window.__h3d.screenText(w) ?? []).join('\n'), id);
  await page.keyboard.press('ArrowUp');
  let settled = await screen();
  for (;;) {
    await page.waitForTimeout(1500);
    const now = await screen();
    if (now === settled) break;
    settled = now;
  }
  const before = { screen: settled, seated: await page.evaluate(() => window.__h3d.seated()), th: await theme(page) };
  expect(before.screen.trim().length).toBeGreaterThan(0);
  await page.evaluate(() => window.__h3d.setUiTheme('ubuntu'));
  await frames(page, 6);
  expect(await screen()).toBe(before.screen);
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(before.seated);
  expect({ ...(await theme(page)), ui: 'x' }).toEqual({ ...before.th, ui: 'x' });
  // The conversation, a draft in its composer.
  await page.keyboard.press('Control+Escape');
  await expect(page.locator('.seat-transcript .tx')).toBeVisible();
  const items = (await page.evaluate(() => window.__h3d.transcript()))?.items;
  const composer = page.locator('.seat-transcript .cmp-editor');
  const enabled = (await composer.getAttribute('aria-disabled')) !== 'true';
  if (enabled) {
    await composer.click();
    await page.keyboard.type('half a thought');
    await page.evaluate(() => window.__h3d.setUiTheme('quiet'));
    await frames(page, 4);
    await expect(composer).toContainText('half a thought');
    await expect(composer).toBeFocused();
  } else {
    await page.evaluate(() => window.__h3d.setUiTheme('quiet'));
  }
  expect((await page.evaluate(() => window.__h3d.transcript()))?.items).toBe(items);
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(id);
  clean();
});
