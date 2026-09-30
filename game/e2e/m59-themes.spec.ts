import { expect, test, type Locator, type Page } from '@playwright/test';
import { frames, openGame, shot, watchErrors } from './game';

// #59: the transcript's three presets (fonts and colours, the terminal's and the limits widget's mono too), "Hide
// tools" and the text zoom, for real on the WebGL2 path: demo-m5 with the simulating fixture server (the demo
// timeline of tools/fixture-transcript.ts, plus the items pushed below: a tool whose output draws a box, emphasis in a
// reply, a long code line). You sit at Tofu, Ctrl+Esc opens the conversation.

const FLOOR = 'herdr-3d';
const SIM = 'play=none&sim=1&simms=500&simusage=0&simlimits=ok';
/** Font files, by preset: what a load may fetch (Recursive is the HUD's, in every preset). */
const FILES = { terminal: /DepartureMono|archivo/i, quiet: /jetbrains-mono|atkinson/i, paper: /space-mono|newsreader/i } as const;
type Id = keyof typeof FILES;
const IDS: Id[] = ['terminal', 'quiet', 'paper'];
const FAMILY = {
  terminal: { mono: 'Departure Mono', prose: 'Archivo Variable' },
  quiet: { mono: 'JetBrains Mono Variable', prose: 'Atkinson Hyperlegible Next Variable' },
  paper: { mono: 'Space Mono', prose: 'Newsreader Variable' },
} as const;

type Theme = Awaited<ReturnType<Window['__h3d']['theme']>>;
const theme = (page: Page) => page.evaluate(() => window.__h3d.theme()) as Promise<Theme>;

/** Every font file the page asks for, from before it loads. */
function fontRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'font') urls.push(r.url());
  });
  return urls;
}

async function sitAt(page: Page, name = 'Tofu', init: Record<string, string> = {}): Promise<string> {
  if (Object.keys(init).length) await page.addInitScript((kv) => Object.entries(kv).forEach(([k, v]) => localStorage.setItem(k, v)), init);
  await openGame(page, 'demo-m5', '&prints=0', SIM);
  await page.evaluate((s) => window.__h3d.enterFloor(s), FLOOR);
  await frames(page, 3);
  const id = await page.evaluate((n) => window.__h3d.world().flatMap((f) => f.workers).find((w) => w.name === n)?.id ?? '', name);
  expect(await page.evaluate((i) => window.__h3d.face(i), id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((w) => window.__h3d.sitAt(w), id)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBe(id);
  await expect.poll(() => page.evaluate(() => (window.__h3d.screenText(window.__h3d.seated() ?? '') ?? []).join('').trim().length)).toBeGreaterThan(0);
  await frames(page, 20);
  return id;
}

/** Ctrl+Esc to the conversation, with the extra items pushed; the view's root. */
async function openTranscript(page: Page, id: string): Promise<Locator> {
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.transcript()))?.items ?? 0).toBeGreaterThan(10);
  await page.keyboard.press('Control+Escape');
  const tx = page.locator('.seat-transcript .tx');
  await expect(tx).toBeVisible();
  const r = await page.evaluate(
    (w) =>
      window.__h3d.simTranscript({
        id: w,
        items: [
          {
            id: 'm59-box',
            seq: 90,
            ts: Date.now(),
            kind: 'tool',
            tool: { name: 'Bash', input_summary: 'gh pr checks', status: 'ok', output_text: '╭──────────┬────────╮\n│ check    │ result │\n├──────────┼────────┤\n│ vitest   │ ✓ pass │\n╰──────────┴────────╯\n▁▂▃▅▇ █ ░▒▓ ⠋⠙⠹' },
          },
          {
            id: 'm59-say',
            seq: 91,
            ts: Date.now(),
            kind: 'assistant',
            parts: [{ text: 'Done: the checks are *all green*, and **nothing** else changed. The long line in `wide.ts`:\n\n```ts\nexport const WIDE = "' + 'a very long line that must scroll sideways instead of overflowing the screen '.repeat(3) + '";\n```' }],
          },
        ],
      }),
    id,
  );
  expect(r.ok).toBe(true);
  await expect(tx.locator('[data-id="m59-say"]')).toBeVisible();
  return tx;
}

const family = (l: Locator) => l.first().evaluate((e) => getComputedStyle(e).fontFamily);
const pseudoFamily = (l: Locator) => l.first().evaluate((e) => getComputedStyle(e).fontFamily);

/** Decision 5: what is mono and what is prose, by the computed font-family, in a preset. */
async function checkFonts(page: Page, tx: Locator, id: Id): Promise<void> {
  const { mono, prose } = FAMILY[id];
  // Open the Edit (its diff), the box-drawing Bash, and the reasoning.
  for (const sel of ['[data-id="toolu_demo_edit"] .tx-tool-row', '[data-id="m59-box"] .tx-tool-row', '.tx-thinking .tx-chip']) {
    const el = tx.locator(sel);
    if ((await el.getAttribute('aria-expanded')) !== 'true') await el.click();
  }
  const monoSel = ['.tx-md pre code', '.tx-md p code', '.tx-diff-body', '.tx-diff-path', '.tx-tool-name', '.tx-tool-sum', '.tx-out', '.tx-imgcard-path'];
  const proseSel = ['.tx-assistant .tx-md p', '.tx-bubble', '.tx-thinking-body', '.tx-notice-text', '.tx-tool-status', '.tx-tool-dur', '.tx-chip', '.tx-count', '.tx-send', '.tx-banner-text', '.tx-choice', '.tx-diff-stat'];
  for (const s of monoSel) expect(await family(tx.locator(s)), `${id}: ${s} is mono`).toContain(mono);
  for (const s of proseSel) {
    const f = await pseudoFamily(tx.locator(s));
    expect(f, `${id}: ${s} is prose`).toContain(prose);
    expect(f).not.toContain(mono);
  }
  // No ligatures in code (JetBrains Mono's are contextual alternates).
  expect(await tx.locator('.tx-out').first().evaluate((e) => getComputedStyle(e).fontVariantLigatures)).toBe('none');
  // The picked preset's mono reaches the terminal canvas and the limits widget; the HUD keeps Recursive.
  expect((await theme(page)).terminalFont).toContain(mono);
  expect(await family(page.locator('.lm-pct'))).toContain(mono);
  expect(await page.locator('.hud').first().evaluate((e) => getComputedStyle(e).fontFamily)).toContain('Recursive');
  // The fonts are really in (not the fallback).
  expect(await page.evaluate((f) => document.fonts.check(`16px "${f.mono}"`) && document.fonts.check(`16px "${f.prose}"`), FAMILY[id])).toBe(true);
}

test('a fresh load fetches Quiet’s fonts only; a stored preset fetches its own only, and survives a reload', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  const fonts = fontRequests(page);
  const id = await sitAt(page);
  await openTranscript(page, id);
  await page.evaluate(() => window.__h3d.themeLoaded());
  expect(await theme(page)).toMatchObject({ picked: 'quiet', ready: 'quiet', zoom: 100, hideTools: false });
  // The selected preset's files were fetched (not an empty set passing trivially), no other preset's.
  await expect.poll(() => fonts.filter((u) => FILES.quiet.test(u)).length).toBeGreaterThanOrEqual(2);
  expect(fonts.filter((u) => FILES.terminal.test(u) || FILES.paper.test(u))).toEqual([]);
  expect(fonts.every((u) => /recursive|jetbrains-mono|atkinson/i.test(u))).toBe(true);
  clean();
});

for (const pick of ['terminal', 'paper'] as const) {
  test(`a stored ${pick} preset loads its fonts only, from the first frame`, async ({ page }) => {
    test.setTimeout(150_000);
    const fonts = fontRequests(page);
    const id = await sitAt(page, 'Tofu', { 'h3d.theme': pick });
    const tx = await openTranscript(page, id);
    await page.evaluate(() => window.__h3d.themeLoaded());
    expect(await theme(page)).toMatchObject({ picked: pick, ready: pick });
    await expect.poll(() => fonts.filter((u) => FILES[pick].test(u)).length).toBeGreaterThanOrEqual(2);
    const others = IDS.filter((i) => i !== pick);
    expect(fonts.filter((u) => others.some((o) => FILES[o].test(u)))).toEqual([]);
    await expect(tx.locator('[role="radio"][aria-checked="true"]')).toHaveAttribute('aria-label', pick === 'terminal' ? 'Terminal' : 'Paper');
  });
}

test('each preset restyles the transcript, the terminal and the limits widget without a reload; tools shown and hidden', async ({ page }) => {
  test.setTimeout(240_000);
  const clean = watchErrors(page);
  const id = await sitAt(page);
  const tx = await openTranscript(page, id);
  for (const pick of IDS) {
    await tx.locator(`[role="radio"][data-theme-id="${pick}"]`).click();
    await page.evaluate(() => window.__h3d.themeLoaded());
    expect(await theme(page)).toMatchObject({ picked: pick, ready: pick });
    await expect(tx).toHaveAttribute('data-theme', pick);
    await checkFonts(page, tx, pick);
    // Box drawing in tool output: drawn by a face that has it (the mono, or the system monospace after it), in line.
    const out = tx.locator('[data-id="m59-box"] .tx-out');
    await out.scrollIntoViewIfNeeded();
    const widths = await out.evaluate((e) => {
      const r = document.createRange();
      const lines = (e.textContent ?? '').split('\n');
      const node = e.firstChild as Text;
      let at = 0;
      const w: number[] = [];
      for (const l of lines.slice(0, 5)) {
        r.setStart(node, at);
        r.setEnd(node, at + l.length);
        w.push(Math.round(r.getBoundingClientRect().width));
        at += l.length + 1;
      }
      return w;
    });
    // Every row of the box is as wide as the others: its corners meet.
    expect(Math.max(...widths) - Math.min(...widths), `${pick}: box rows ${widths.join(',')}`).toBeLessThanOrEqual(2);
    await tx.locator('[data-id="m59-say"]').scrollIntoViewIfNeeded();
    await frames(page, 4);
    await shot(page, `m59-transcript-${pick}`);
    // Hide tools: the tool rows go, the subagent and the conversation stay.
    await tx.locator('.tx-check-box').check();
    await expect(tx.locator('[data-id="toolu_demo_grep"]')).toBeHidden();
    await expect(tx.locator('[data-id="toolu_demo_agent"]')).toBeVisible();
    // The demo's Bash is still running: the strip says so.
    await expect(tx.locator('.tx-busy')).toBeVisible();
    await expect(tx.locator('.tx-busy')).toContainText('Bash');
    await frames(page, 4);
    await shot(page, `m59-transcript-${pick}-hidden`);
    await tx.locator('.tx-check-box').uncheck();
    await expect(tx.locator('[data-id="toolu_demo_grep"]')).toBeVisible();
    // The terminal in the preset: its font and colours, painted with its metrics.
    await page.keyboard.press('Control+Escape');
    await expect(tx).toBeHidden();
    await frames(page, 12);
    expect((await theme(page)).terminalFont).toContain(FAMILY[pick].mono);
    await shot(page, `m59-terminal-${pick}`);
    await page.keyboard.press('Control+Escape');
    await expect(tx).toBeVisible();
  }
  // The pick survives a reload (and so does "Hide tools").
  await tx.locator('.tx-check-box').check();
  await page.reload();
  await page.waitForFunction(() => window.__h3d?.ready && window.__h3d.frames >= 3);
  expect(await theme(page)).toMatchObject({ picked: 'paper', hideTools: true });
  clean();
});

test('with localStorage blocked the preset, Hide tools and the zoom still work for the page', async ({ page }) => {
  test.setTimeout(150_000);
  await page.addInitScript(() => {
    const boom = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
    Object.defineProperty(window, 'localStorage', { configurable: true, get: boom });
  });
  const id = await sitAt(page);
  const tx = await openTranscript(page, id);
  await tx.locator('[role="radio"][data-theme-id="paper"]').click();
  await page.evaluate(() => window.__h3d.themeLoaded());
  expect(await theme(page)).toMatchObject({ picked: 'paper', ready: 'paper' });
  await tx.getByRole('button', { name: 'Larger text' }).click();
  await tx.locator('.tx-check-box').check();
  expect(await theme(page)).toMatchObject({ picked: 'paper', zoom: 110, hideTools: true });
  await expect(tx.locator('[data-id="toolu_demo_grep"]')).toBeHidden();
});

test('the zoom: A− / 100% / A+ and Ctrl keys in the transcript, Ctrl+wheel on the terminal, only while seated', async ({ page }) => {
  test.setTimeout(200_000);
  const clean = watchErrors(page);
  // Not seated: the keys are the browser's, never taken.
  await openGame(page, 'demo-m5', '&prints=0', SIM);
  const prevented = await page.evaluate(() => {
    const e = new KeyboardEvent('keydown', { key: '=', code: 'Equal', ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });
  expect(prevented).toBe(false);
  expect((await theme(page)).zoom).toBe(100);

  const id = await sitAt(page, 'Nibble');
  const tx = await openTranscript(page, id);
  const body = tx.locator('.tx-assistant .tx-md p').first();
  const size = () => body.evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  const monoSize = () => tx.locator('.tx-md pre code').first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  expect(await size()).toBe(13.5);
  const level = tx.locator('.tx-zoom-level');
  await expect(level).toHaveText('100%');
  await tx.getByRole('button', { name: 'Larger text' }).click();
  await expect(level).toHaveText('110%');
  expect(Math.abs((await size()) - 14.85)).toBeLessThan(0.2);
  await page.keyboard.press('Control+=');
  await expect(level).toHaveText('120%');
  // From the prompt box too, which keeps what is typed there.
  await tx.locator('.tx-input').focus();
  await page.keyboard.press('Control+-');
  await expect(level).toHaveText('110%');
  await expect(tx.locator('.tx-input')).toHaveValue('');
  await tx.locator('.tx-scroll').focus();
  await page.keyboard.press('Control+0');
  await expect(level).toHaveText('100%');

  // 200% and 70%: nothing overlaps or clips, code scrolls sideways inside its block.
  for (const z of [200, 70]) {
    while ((await theme(page)).zoom !== z) await page.keyboard.press(z > 100 ? 'Control+=' : 'Control+-');
    await expect(level).toHaveText(`${z}%`);
    expect(Math.abs((await size()) - 13.5 * (z / 100))).toBeLessThan(0.2);
    expect(await monoSize()).toBeCloseTo(11.5 * (z / 100), 0);
    await tx.locator('[data-id="m59-say"]').scrollIntoViewIfNeeded();
    const layout = await tx.evaluate((root) => {
      const scroller = root.querySelector('.tx-scroll') as HTMLElement;
      const rows = [...root.querySelectorAll<HTMLElement>('.tx-list > .tx-item')].filter((r) => r.offsetParent);
      const boxes = rows.map((r) => r.getBoundingClientRect());
      const overlaps = boxes.slice(1).filter((b, i) => b.top < (boxes[i] as DOMRect).bottom - 0.5).length;
      const pre = root.querySelector('[data-id="m59-say"] pre') as HTMLElement;
      const sr = scroller.getBoundingClientRect();
      const pr = pre.getBoundingClientRect();
      return { overlaps, sideways: scroller.scrollWidth - scroller.clientWidth, preScrolls: pre.scrollWidth > pre.clientWidth, preInside: pr.left >= sr.left - 0.5 && pr.right <= sr.right + 0.5 };
    });
    expect(layout, `${z}%`).toEqual({ overlaps: 0, sideways: 0, preScrolls: true, preInside: true });
    await frames(page, 4);
    await shot(page, `m59-zoom-${z}`);
  }
  await page.keyboard.press('Control+0');
  await expect(level).toHaveText('100%');

  // Terminal mode: Ctrl+wheel over the screen zooms, the seat bar says the level, the cursor stays on screen.
  await page.keyboard.press('Control+Escape');
  await expect(tx).toBeHidden();
  await page.mouse.move(640, 360);
  await page.keyboard.down('Control');
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -120);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await theme(page)).zoom).toBe(200);
  await expect(page.locator('.seat')).toContainText('Text size 200%');
  await frames(page, 12);
  await shot(page, 'm59-terminal-zoom-200');
  // The level survives a reload; switching preset keeps it (Departure Mono on its 22px step at 200%).
  await page.reload();
  await page.waitForFunction(() => window.__h3d?.ready && window.__h3d.frames >= 3);
  expect((await theme(page)).zoom).toBe(200);
  const id2 = await sitAt(page);
  const tx2 = await openTranscript(page, id2);
  await tx2.locator('[role="radio"][data-theme-id="terminal"]').click();
  await page.evaluate(() => window.__h3d.themeLoaded());
  expect((await theme(page)).zoom).toBe(200);
  expect(await tx2.locator('.tx-md pre code').first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBe(22);
  await tx2.getByRole('button', { name: /Text size 200%/ }).click();
  expect(await tx2.locator('.tx-md pre code').first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBe(11);
  clean();
});

test('the picker and Hide tools are reachable by keyboard, and the transcript keys still work', async ({ page }) => {
  test.setTimeout(150_000);
  const id = await sitAt(page, 'Nibble');
  const tx = await openTranscript(page, id);
  const scroller = tx.locator('.tx-scroll');
  await scroller.focus();
  // Tab from the timeline wraps round to the strip: the first stop in it that is ours is reached within a few presses.
  const focused = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.className ?? '');
  let hops = 0;
  while (!(await focused()).includes('tx-theme') && hops++ < 40) await page.keyboard.press('Shift+Tab');
  expect(await focused()).toContain('tx-theme');
  // The checked radio holds the tab stop; arrows pick.
  expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-checked'))).toBe('true');
  await page.keyboard.press('ArrowRight');
  expect((await theme(page)).picked).toBe('paper');
  await page.keyboard.press('ArrowLeft');
  expect((await theme(page)).picked).toBe('quiet');
  hops = 0;
  while (!(await focused()).includes('tx-check-box') && hops++ < 20) await page.keyboard.press('Shift+Tab');
  expect(await focused()).toContain('tx-check-box');
  await page.keyboard.press('Space');
  expect((await theme(page)).hideTools).toBe(true);
  await page.keyboard.press('Space');
  expect((await theme(page)).hideTools).toBe(false);
  // Back on the timeline: PgUp / PgDn and j / k scroll, Ctrl+Esc swaps, Esc stands up.
  await scroller.focus();
  const top = () => scroller.evaluate((e) => e.scrollTop);
  await page.keyboard.press('End');
  const bottom = await top();
  await page.keyboard.press('PageUp');
  expect(await top()).toBeLessThan(bottom);
  await page.keyboard.press('j');
  const afterJ = await top();
  await page.keyboard.press('k');
  expect(await top()).toBeLessThan(afterJ);
  await page.keyboard.press('PageDown');
  // Enter goes to the prompt box, Esc from there… stands you up, as before; so back to the timeline first.
  await page.keyboard.press('Enter');
  expect(await focused()).toContain('tx-input');
  await scroller.focus();
  await page.keyboard.press('Control+Escape');
  await expect(tx).toBeHidden();
  await page.keyboard.press('Control+Escape');
  await expect(tx).toBeVisible();
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
});
