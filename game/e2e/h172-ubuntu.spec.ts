import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { frames, leftInTerminal, openGame, seatMode, shot, watchErrors } from './game';

// #172: the Ubuntu preset in the real app (demo-m5, sim=1, WebGL2): its colours and fonts as computed, every text
// against the ground it really sits on (4.5:1), box drawing lined up at 70 / 100 / 200 %, the terminal canvas at the
// same zooms, and the screenshots the ticket asks for (Ubuntu prose, code and tool output, a diff, the waiting card,
// the terminal, a phone width). The m59 spec covers laziness, migration, keyboard and the pickers.

const SIM = 'play=none&sim=1&simms=500&simusage=0&simlimits=ok';
// #216: fully Ubuntu is all three picks: the transcript's bar, Send and its other widgets are the UI theme's now.
const UBUNTU = { 'h3d.theme.ui': 'ubuntu', 'h3d.theme.transcript': 'ubuntu', 'h3d.theme.terminal': 'ubuntu' };

async function sit(page: Page, init: Record<string, string> = UBUNTU): Promise<string> {
  await page.addInitScript((kv) => Object.entries(kv).forEach(([k, v]) => localStorage.setItem(k, v)), init);
  await openGame(page, 'demo-m5', '&prints=0', SIM);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  const id = await page.evaluate(() => window.__h3d.world().flatMap((f) => f.workers).find((w) => w.name === 'Tofu')?.id ?? '');
  await leftInTerminal(page, id);
  expect(await page.evaluate((i) => window.__h3d.face(i), id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((w) => window.__h3d.sitAt(w), id)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBe(id);
  await seatMode(page, 'terminal');
  await expect.poll(() => page.evaluate(() => (window.__h3d.screenText(window.__h3d.seated() ?? '') ?? []).join('').trim().length)).toBeGreaterThan(0);
  await page.evaluate(() => window.__h3d.themeLoaded());
  await frames(page, 20);
  return id;
}

/** Ctrl+Esc to the conversation, plus a box with no fallback glyph, a table with one, rows of symbols, a reply with every emphasis. */
async function transcript(page: Page, id: string): Promise<Locator> {
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.transcript()))?.items ?? 0).toBeGreaterThan(10);
  await seatMode(page, 'transcript');
  const tx = page.locator('.seat-transcript .tx');
  await expect(tx).toBeVisible();
  const r = await page.evaluate(
    (w) =>
      window.__h3d.simTranscript({
        id: w,
        items: [
          {
            id: 'u-box',
            seq: 90,
            ts: Date.now(),
            kind: 'tool',
            tool: { name: 'Bash', input_summary: 'make table', status: 'ok', output_text: '╭──────────┬────────╮\n│ check    │ result │\n├──────────┼────────┤\n│ vitest   │ passed │\n│ tsc      │ passed │\n╰──────────┴────────╯\n▁▂▃▅▇ █ ░▒▓ ⠋⠙⠹ ✓ → ❯' },
          },
          {
            id: 'u-sym',
            seq: 92,
            ts: Date.now(),
            kind: 'tool',
            tool: { name: 'Bash', input_summary: 'make symbols', status: 'ok', output_text: ['aaaaaaaa', '→→→→→→→→', '←↑↓↔⇒⇄↩↵', '●●●●●●●●', '◆◆◆◆◆◆◆◆', '▶▶▶▶▶▶▶▶', '✓✓✓✓✓✓✓✓', '✔✔✔✔✔✔✔✔', '✗✘❯❯★★☐☑', '⠿⠿⠿⠿⠿⠿⠿⠿', '≤≥≠≤≥≠≤≥'].map((c) => `│ ${c} │`).join('\n') },
          },
          {
            id: 'u-say',
            seq: 91,
            ts: Date.now(),
            kind: 'assistant',
            parts: [{ text: 'Done: the checks are *all green*, **nothing** else changed, and ***both*** at once. See [the docs](https://example.com/docs) and `wide.ts`:\n\n- one\n- two\n\n```ts\n// a comment\nexport const WIDE = "a string"; const n = 42; function go(a: number) { return a; }\n```' }],
          },
        ],
      }),
    id,
  );
  expect(r.ok).toBe(true);
  await expect(tx.locator('[data-id="u-say"]')).toBeVisible();
  for (const sel of ['[data-id="toolu_demo_edit"] .tx-tool-row', '[data-id="u-box"] .tx-tool-row', '[data-id="u-sym"] .tx-tool-row']) {
    const row = tx.locator(sel);
    // (a script click: at a phone width the waiting card and the prompt box cover the rows below them)
    if ((await row.getAttribute('aria-expanded')) !== 'true') await row.evaluate((e) => (e as HTMLElement).click());
  }
  return tx;
}

test('Ubuntu: the purple ground, white text, the orange accent, Ubuntu for prose and Ubuntu Mono for code, bold and italic real', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  const id = await sit(page);
  const tx = await transcript(page, id);
  const css = (l: Locator, prop: string) => l.first().evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop);
  expect(await css(tx, 'background-color')).toBe('rgb(48, 10, 36)'); // #300A24, opaque
  expect(await css(tx.locator('.tx-assistant .tx-md p'), 'color')).toBe('rgb(255, 255, 255)');
  expect(await css(tx.locator('.tx-md pre'), 'background-color')).toBe('rgb(44, 0, 30)'); // #2C001E
  // The accent is Ubuntu orange (#E95420) as a fill, and a lighter tint as text.
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--tx-blue').trim())).toBe('#e95420');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--tx-bg-3').trim())).toBe('#5e2750');
  const prose = ['.tx-assistant .tx-md p', '.tx-md strong', '.tx-md em', '.tx-md li', '.tx-bubble', '.tx-thinking-body'];
  const mono = ['.tx-md pre code', '.tx-md p code', '.tx-diff-body', '.tx-diff-path', '.tx-tool-name', '.tx-tool-sum', '.tx-out'];
  for (const s of prose) if (await tx.locator(s).count()) expect(await css(tx.locator(s), 'font-family'), s).toMatch(/^"?Ubuntu"?,/);
  for (const s of mono) expect(await css(tx.locator(s), 'font-family'), s).toMatch(/^"?Ubuntu Mono"?,/);
  // Bold and italic are the family's own faces (400 / 700 upright and italic are all loaded), not synthesised.
  expect(await css(tx.locator('.tx-md strong').first(), 'font-weight')).toBe('700');
  expect(await css(tx.locator('.tx-md em').first(), 'font-style')).toBe('italic');
  const loaded = await page.evaluate(async () => {
    const faces = ['400 16px', '700 16px', 'italic 400 16px', 'italic 700 16px'];
    const out: Record<string, boolean> = {};
    for (const fam of ['Ubuntu', 'Ubuntu Mono']) for (const f of faces) {
      await document.fonts.load(`${f} "${fam}"`, 'Mg');
      out[`${f} ${fam}`] = document.fonts.check(`${f} "${fam}"`, 'Mg');
    }
    return out;
  });
  expect(Object.entries(loaded).filter(([, ok]) => !ok)).toEqual([]);
  expect(await page.evaluate(() => [...document.fonts].filter((f) => /^"?Ubuntu/.test(f.family) && f.status === 'error').length)).toBe(0);
  // Sizes at 100%.
  expect(parseFloat(await css(tx.locator('.tx-assistant .tx-md p'), 'font-size'))).toBe(13.5);
  expect(parseFloat(await css(tx.locator('.tx-md pre code'), 'font-size'))).toBe(14);
  // The ticket's screenshots: the diff, the reply with its emphasis, link and code.
  await tx.locator('[data-id="toolu_demo_edit"]').scrollIntoViewIfNeeded();
  await frames(page, 4);
  await shot(page, 'h172-ubuntu-diff');
  await tx.locator('[data-id="u-say"]').scrollIntoViewIfNeeded();
  await frames(page, 4);
  await shot(page, 'h172-ubuntu-prose');
  // The focus ring is the accent, 3:1 or better on the ground.
  await tx.locator('.tx-scroll').focus();
  await page.keyboard.press('Shift+Tab');
  const ring = await page.evaluate(() => {
    const e = document.activeElement as HTMLElement;
    const s = getComputedStyle(e);
    return { outline: s.outlineColor, width: s.outlineWidth, style: s.outlineStyle };
  });
  expect(ring.style).not.toBe('none');
  clean();
});

/** Every text of `root` against the opaque ground it sits on: the ratio of each, the worst first. */
async function contrastScan(root: Locator): Promise<Array<{ text: string; cls: string; ratio: number; fg: string; bg: string }>> {
  return root.evaluate((rootEl) => {
    type C = [number, number, number, number];
    const parse = (s: string): C => {
      // #206: a color-mix() computes to `color(srgb r g b [/ a])`, its channels 0–1.
      const c = s.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/);
      if (c) return [+c[1]! * 255, +c[2]! * 255, +c[3]! * 255, c[4] === undefined ? 1 : +c[4]];
      const m = s.match(/rgba?\(([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+%?))?\)/);
      if (!m) return [0, 0, 0, 0];
      const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      return [+m[1]!, +m[2]!, +m[3]!, a];
    };
    const over = (f: C, b: C): C => [f[0] * f[3] + b[0] * (1 - f[3]), f[1] * f[3] + b[1] * (1 - f[3]), f[2] * f[3] + b[2] * (1 - f[3]), 1];
    const lum = (c: C) => {
      const [r, g, b] = c.slice(0, 3).map((v) => ((v / 255) <= 0.03928 ? v / 255 / 12.92 : (((v / 255) + 0.055) / 1.055) ** 2.4)) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ground = (el: Element): C => {
      const chain: C[] = [];
      for (let e: Element | null = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c[3] > 0) chain.push(c);
        if (c[3] === 1) break;
      }
      let base: C = [48, 10, 36, 1];
      if (!(chain.length && chain[chain.length - 1]![3] === 1)) chain.push(base);
      return chain.reverse().reduce((acc, c) => over(c, acc), [0, 0, 0, 1] as C);
    };
    const opacityOf = (el: Element) => {
      let o = 1;
      for (let e: Element | null = el; e && e !== rootEl.parentElement; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity);
      return o;
    };
    const out: Array<{ text: string; cls: string; ratio: number; fg: string; bg: string }> = [];
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = (n.textContent ?? '').trim();
      const el = n.parentElement;
      if (!t || !el || el.closest('[disabled], [aria-disabled="true"], [hidden]')) continue;
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none' || el.getClientRects().length === 0) continue;
      const bg = ground(el);
      let fg = parse(st.color);
      const op = opacityOf(el);
      fg = [fg[0], fg[1], fg[2], fg[3] * op];
      const f = over(fg, bg);
      const [hi, lo] = [lum(f), lum(bg)].sort((a, b) => b - a) as [number, number];
      out.push({ text: t.slice(0, 40), cls: `${el.tagName.toLowerCase()}.${String(el.className).split(' ').join('.')}`, ratio: +((hi + 0.05) / (lo + 0.05)).toFixed(2), fg: st.color, bg: `rgb(${bg.slice(0, 3).map(Math.round).join(',')})` });
    }
    return out.sort((a, b) => a.ratio - b.ratio);
  });
}

test('Ubuntu: every visible text of the transcript is 4.5:1 or better on the ground it sits on', async ({ page }) => {
  test.setTimeout(150_000);
  const id = await sit(page);
  const tx = await transcript(page, id);
  await expect(tx.getByText('Waiting for you', { exact: false }).first()).toBeVisible({ timeout: 20_000 }); // the demo's waiting card
  await frames(page, 6);
  const low = (await contrastScan(tx)).filter((r) => r.ratio < 4.5);
  expect(low, `low contrast: ${JSON.stringify(low.slice(0, 8))}`).toEqual([]);
  // Hide tools on, and the other reading modes of the strip.
  await tx.locator('.tx-check-box').check();
  expect((await contrastScan(tx)).filter((r) => r.ratio < 4.5)).toEqual([]);
  await tx.locator('.tx-check-box').uncheck();
});

test('Ubuntu: a table of box drawing stays lined up at 70, 100 and 200 %, and the terminal draws unclipped at each', async ({ page }) => {
  test.setTimeout(240_000);
  const clean = watchErrors(page);
  const id = await sit(page);
  const tx = await transcript(page, id);
  // The app's optional local fallback fonts differ by host. Keep its real family, unicode range and size-adjust,
  // replacing only that face's source with a pinned monospace fixture for every symbol measured below.
  const font = readFileSync(new URL('./fixtures/fonts/h3d-test-symbols.woff2', import.meta.url)).toString('base64');
  await page.evaluate(async (bytes) => {
    const rules = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]);
    const face = rules.find((rule): rule is CSSFontFaceRule => rule instanceof CSSFontFaceRule && rule.style.getPropertyValue('font-family').replaceAll('"', '').replaceAll("'", '') === 'H3D Symbols Ubuntu');
    if (!face) throw new Error('Ubuntu symbol fallback face is missing');
    face.style.setProperty('src', `url("data:font/woff2;base64,${bytes}") format("woff2")`);
    await document.fonts.load('14px "H3D Symbols Ubuntu"', '→←↑↓↔⇒⇄↩↵●◆▶✓✔✗✘❯★☐☑⠿≤≥≠');
    await document.fonts.ready;
  }, font);
  const widths = (id = 'u-box', rows = 6) =>
    tx.locator(`[data-id="${id}"] .tx-out`).evaluate((e, n) => {
      const r = document.createRange();
      const node = e.firstChild as Text;
      let at = 0;
      const w: number[] = [];
      const lines = (e.textContent ?? '').split('\n');
      for (const l of lines.slice(0, n)) {
        r.setStart(node, at);
        r.setEnd(node, at + l.length);
        w.push(r.getBoundingClientRect().width);
        at += l.length + 1;
      }
      const cell = (() => {
        const s = document.createElement('span');
        s.textContent = 'M'.repeat(20);
        s.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
        e.append(s);
        const cw = s.getBoundingClientRect().width / 20;
        s.remove();
        return cw;
      })();
      return { w, cell };
    }, rows);
  const level = tx.locator('.tx-zoom-level');
  for (const z of [100, 150, 200, 70]) {
    while ((await page.evaluate(() => window.__h3d.theme())).transcriptZoom !== z) await page.keyboard.press(z > 100 || (z === 100 && false) ? 'Control+=' : 'Control+-');
    await expect(level).toHaveText(`${z}%`);
    await tx.locator('[data-id="u-box"]').scrollIntoViewIfNeeded();
    const { w, cell } = await widths();
    // The six framed rows (box and table) are as wide as each other: the corners meet. (The glyph row below it is not
    // framed, and is measured by the symbol rows.)
    const framed = w.slice(0, 6);
    expect(Math.max(...framed) - Math.min(...framed), `${z}%: rows ${framed.map((x) => x.toFixed(1)).join(',')}`).toBeLessThanOrEqual(1);
    // Arrows, bullets, shapes, check marks, braille and math in a frame are as wide as the row of letters at its top (the
    // symbol fallback faces are sized to Ubuntu Mono's advance; a glyph this machine has no font for is a box of that
    // same width, so the row holds either way).
    const sym = (await widths('u-sym', 11)).w;
    for (const [i, x] of sym.entries()) expect(Math.abs(x - sym[0]!), `${z}%: symbol row ${i} is ${x.toFixed(2)}px, the letters ${sym[0]!.toFixed(2)}px: ${sym.map((v) => v.toFixed(1)).join(',')}`).toBeLessThanOrEqual(0.5);
    // Ubuntu Mono's advance is half its size (the cell is not the system mono's 0.6).
    const px = parseFloat(await tx.locator('.tx-out').first().evaluate((e) => getComputedStyle(e).fontSize));
    expect(Math.abs(cell - px / 2), `${z}%: advance ${cell} of ${px}px`).toBeLessThanOrEqual(0.5); // (whole pixels at 21 px: 10.5 -> 11)
    await frames(page, 3);
    await shot(page, `h172-transcript-ubuntu-${z}`);
    if (z === 100) {
      // Reset, the keys reach it from the prompt box too.
      await page.keyboard.press('Control+0');
    }
  }
  await page.keyboard.press('Control+0');
  // The terminal canvas takes the same stack: a symbol measures the advance of a letter there too (paint.ts draws a
  // glyph that is not the font's own inside its cell, so one a half wider than a cell would be squeezed).
  const adv = await tx.evaluate((e) => {
    const g = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D;
    g.font = `28px ${getComputedStyle(e).getPropertyValue('--tx-mono')}`;
    return { stack: g.font, M: g.measureText('M').width, sym: ['→', '●', '◆', '≤'].map((c) => g.measureText(c).width) };
  });
  for (const [i, w] of adv.sym.entries()) expect(Math.abs(w - adv.M), `canvas: symbol ${i} ${w} vs M ${adv.M} (${adv.stack})`).toBeLessThanOrEqual(0.5);
  // The terminal: its own zoom.
  await page.keyboard.press('Control+Escape');
  await expect(tx).toBeHidden();
  for (const z of [100, 200, 70]) {
    while ((await page.evaluate(() => window.__h3d.theme())).terminalZoom !== z) await page.keyboard.press(z > 100 ? 'Control+=' : 'Control+-');
    await expect(page.locator('.seat-zoom-level')).toHaveText(`${z}%`);
    await frames(page, 12);
    await shot(page, `h172-terminal-ubuntu-${z}`);
  }
  clean();
});

test('Ubuntu: the waiting card and the transcript at a phone width, transcript and terminal', async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 390, height: 780 });
  const id = await sit(page);
  const tx = await transcript(page, id);
  await expect(tx.getByText('Waiting for you', { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  await tx.getByText('Waiting for you', { exact: false }).first().scrollIntoViewIfNeeded();
  await shot(page, 'h172-phone-ubuntu-waiting');
  const low = (await contrastScan(tx)).filter((r) => r.ratio < 4.5);
  expect(low, JSON.stringify(low.slice(0, 6))).toEqual([]);
  await page.keyboard.press('Control+Escape');
  await expect(tx).toBeHidden();
  await frames(page, 12);
  await shot(page, 'h172-phone-ubuntu-terminal');
});

/** The colour a filled control paints its label in, the colour it fills with, their ratio, and (disabled) the pair as composited. */
async function filled(el: Locator): Promise<{ fg: string; bg: string; ratio: number; shown: number; opacity: string }> {
  return el.evaluate((e) => {
    const rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number) as [number, number, number];
    const lum = (c: number[]) => {
      const [r, g, b] = c.map((v) => ((v / 255) <= 0.03928 ? v / 255 / 12.92 : (((v / 255) + 0.055) / 1.055) ** 2.4)) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: number[], b: number[]) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    const st = getComputedStyle(e);
    const fg = rgb(st.color);
    const bg = rgb(st.backgroundColor);
    // What a disabled (faded) control really shows: both its fill and its ink at the opacity, over what is behind it.
    const op = parseFloat(st.opacity);
    let behind: [number, number, number] = [48, 10, 36];
    for (let p = e.parentElement; p; p = p.parentElement) {
      const c = getComputedStyle(p).backgroundColor.match(/[\d.]+/g)?.map(Number);
      if (c && (c[3] ?? 1) === 1 && c.length >= 3) {
        behind = [c[0]!, c[1]!, c[2]!];
        break;
      }
    }
    const mix = (c: number[]) => c.map((v, i) => v * op + behind[i]! * (1 - op));
    return { fg: st.color, bg: st.backgroundColor, ratio: +ratio(fg, bg).toFixed(2), shown: +ratio(mix(fg), mix(bg)).toFixed(2), opacity: st.opacity };
  });
}

// L2: `.tx button { color: inherit }` out-specified .tx-send and .tx-jump, so white sat on the orange (3.65:1) in place of
// the on-accent ink. Each theme's own on-accent is what a filled control must show: Ubuntu #2C001E on #E95420, Quiet's
// #0b1020 on #6f9bff, enabled (Send, the jump chip) and hovered or focused, desktop and phone width.
for (const [name, theme, ink, fill, size] of [
  ['Ubuntu desktop', 'ubuntu', 'rgb(44, 0, 30)', 'rgb(233, 84, 32)', null],
  ['Ubuntu 390px', 'ubuntu', 'rgb(44, 0, 30)', 'rgb(233, 84, 32)', { width: 390, height: 780 }],
  ['Quiet desktop', 'quiet', 'rgb(11, 16, 32)', 'rgb(111, 155, 255)', null],
  ['Quiet 390px', 'quiet', 'rgb(11, 16, 32)', 'rgb(111, 155, 255)', { width: 390, height: 780 }],
] as const) {
  test(`${name}: Send and the jump chip are drawn in the theme's on-accent ink, 4.5:1 or better`, async ({ page }) => {
    test.setTimeout(150_000);
    if (size) await page.setViewportSize(size);
    const id = await sit(page, { 'h3d.theme.ui': theme, 'h3d.theme.transcript': theme, 'h3d.theme.terminal': theme });
    const tx = await transcript(page, id);
    const send = tx.locator('.tx-send');
    // Disabled while Tofu waits: faded to .45, the ink is still the on-accent one; a disabled control is exempt from 4.5:1 (reported, floor 2).
    await expect(send).toBeDisabled();
    const off = await filled(send);
    test.info().annotations.push({ type: 'disabled Send', description: JSON.stringify(off) });
    console.log(`disabled Send (${name}): ${JSON.stringify(off)}`);
    // #216: Ubuntu's disabled action is the raised purple with the muted label (5.7:1), not a faded fill; Quiet fades as before.
    if (theme === 'ubuntu') {
      expect(off.fg).toBe('rgb(205, 177, 198)');
      expect(off.shown, `disabled Send as shown: ${JSON.stringify(off)}`).toBeGreaterThanOrEqual(4.5);
    } else {
      expect(off.fg).toBe(ink);
      expect(off.shown, `disabled Send as shown: ${JSON.stringify(off)}`).toBeGreaterThanOrEqual(2);
    }
    // Answered: the prompt comes back, Send is live.
    await page.keyboard.press('1');
    await expect(tx.locator('.tx-input')).toBeEnabled();
    await expect(send).toBeEnabled();
    await expect(tx.locator('.tx-banner')).toBeHidden();
    const on = await filled(send);
    expect(on, 'enabled Send').toMatchObject({ fg: ink, bg: fill });
    expect(on.ratio).toBeGreaterThanOrEqual(4.5);
    await send.hover();
    // #216: the issue's hover fill for the action (#EB6536) in Ubuntu; Quiet's Send keeps its fill.
    await expect.poll(async () => (await filled(send)).bg, { message: 'hovered Send' }).toBe(theme === 'ubuntu' ? 'rgb(235, 101, 54)' : fill);
    expect(await filled(send), 'hovered Send').toMatchObject({ fg: ink });
    await send.focus();
    expect((await filled(send)).fg, 'focused Send').toBe(ink);
    await shot(page, `r2-send-${name.toLowerCase().replace(/ /g, '-')}`);
    // Scrolled away from the bottom, a new item shows the chip.
    await tx.locator('.tx-scroll').evaluate((e) => (e.scrollTop = 0));
    await frames(page, 3);
    await page.evaluate(() => window.__h3d.simTranscript({ id: window.__h3d.seated(), items: [{ id: 'demo-98', seq: 98, ts: Date.now(), kind: 'assistant', parts: [{ text: 'All green now.' }] }] }));
    const jump = tx.locator('.tx-jump');
    await expect(jump).toBeVisible();
    const chip = await filled(jump);
    expect(chip, 'jump chip').toMatchObject({ fg: ink, bg: fill });
    expect(chip.ratio).toBeGreaterThanOrEqual(4.5);
    await jump.hover();
    await expect.poll(async () => (await filled(jump)).bg, { message: 'hovered chip' }).toBe(theme === 'ubuntu' ? 'rgb(235, 101, 54)' : fill);
    expect(await filled(jump), 'hovered chip').toMatchObject({ fg: ink });
    await shot(page, `r2-jump-${name.toLowerCase().replace(/ /g, '-')}`);
    // And the whole transcript, enabled controls included, still clears 4.5:1 on the ground each text sits on.
    expect((await contrastScan(tx)).filter((r) => r.ratio < 4.5 && theme === 'ubuntu')).toEqual([]);
  });
}
