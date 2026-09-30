import { expect, test, type Locator, type Page } from '@playwright/test';
import { frames, openGame, shot, watchErrors } from './game';

// #59: the three presets, picked apart for the transcript (fonts and colours; the limits widget's mono follows it) and
// for the terminal (its canvas's font and colours), "Hide tools" and each view's text zoom, for real on the WebGL2 path: demo-m5 with the simulating fixture server (the demo
// timeline of tools/fixture-transcript.ts, plus the items pushed below: a tool whose output draws a box, emphasis in a
// reply, a long code line). You sit at Tofu, Ctrl+Esc opens the conversation.

const FLOOR = 'herdr-3d';
const SIM = 'play=none&sim=1&simms=500&simusage=0&simlimits=ok';
/** Font files, by preset: what a load may fetch (Recursive is the HUD's, in every preset). */
const FILES = { terminal: /DepartureMono|archivo/i, quiet: /jetbrains-mono|atkinson/i, paper: /space-mono|newsreader/i } as const;
type Id = keyof typeof FILES;
const IDS: Id[] = ['terminal', 'quiet', 'paper'];
const LABEL = { terminal: 'Terminal', quiet: 'Quiet', paper: 'Paper' } as const;
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

async function sitAt(page: Page, name = 'Tofu', init: Record<string, string> = {}, sim = SIM): Promise<string> {
  if (Object.keys(init).length) await page.addInitScript((kv) => Object.entries(kv).forEach(([k, v]) => localStorage.setItem(k, v)), init);
  await openGame(page, 'demo-m5', '&prints=0', sim);
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
  // The transcript's mono reaches the limits widget (every DOM monospace); the HUD keeps Recursive.
  expect(await family(page.locator('.lm-pct'))).toContain(mono);
  expect(await page.locator('.hud').first().evaluate((e) => getComputedStyle(e).fontFamily)).toContain('Recursive');
  // The fonts are really in (not the fallback).
  expect(await page.evaluate((f) => document.fonts.check(`16px "${f.mono}"`) && document.fonts.check(`16px "${f.prose}"`), FAMILY[id])).toBe(true);
}

test('a fresh load fetches Quiet’s fonts only', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  const fonts = fontRequests(page);
  const id = await sitAt(page);
  await openTranscript(page, id);
  await page.evaluate(() => window.__h3d.themeLoaded());
  expect(await theme(page)).toMatchObject({ transcript: 'quiet', terminal: 'quiet', ready: 'quiet', transcriptZoom: 100, terminalZoom: 100, hideTools: false });
  // The selected preset's files were fetched (not an empty set passing trivially), no other preset's.
  await expect.poll(() => fonts.filter((u) => FILES.quiet.test(u)).length).toBeGreaterThanOrEqual(2);
  expect(fonts.filter((u) => FILES.terminal.test(u) || FILES.paper.test(u))).toEqual([]);
  expect(fonts.every((u) => /recursive|jetbrains-mono|atkinson/i.test(u))).toBe(true);
  clean();
});

for (const pick of ['terminal', 'paper'] as const) {
  test(`a stored ${pick} transcript loads its fonts only, from the first frame`, async ({ page }) => {
    test.setTimeout(150_000);
    const fonts = fontRequests(page);
    const id = await sitAt(page, 'Tofu', { 'h3d.theme.transcript': pick, 'h3d.theme.terminal': pick });
    const tx = await openTranscript(page, id);
    await page.evaluate(() => window.__h3d.themeLoaded());
    expect(await theme(page)).toMatchObject({ transcript: pick, terminal: pick, ready: pick });
    await expect.poll(() => fonts.filter((u) => FILES[pick].test(u)).length).toBeGreaterThanOrEqual(2);
    const others = IDS.filter((i) => i !== pick);
    expect(fonts.filter((u) => others.some((o) => FILES[o].test(u)))).toEqual([]);
    await expect(tx.locator('[role="radio"][aria-checked="true"]')).toHaveAttribute('aria-label', LABEL[pick]);
  });
}

test('the terminal in Paper fetches Space Mono, not Newsreader (its prose font), and changes nothing in the DOM', async ({ page }) => {
  test.setTimeout(150_000);
  const fonts = fontRequests(page);
  await sitAt(page, 'Tofu', { 'h3d.theme.terminal': 'paper' });
  await page.evaluate(() => window.__h3d.themeLoaded());
  expect(await theme(page)).toMatchObject({ transcript: 'quiet', terminal: 'paper', ready: 'paper' });
  expect((await theme(page)).terminalFont).toContain('Space Mono');
  await expect.poll(() => fonts.filter((u) => /space-mono/i.test(u)).length).toBeGreaterThanOrEqual(1);
  expect(fonts.filter((u) => /newsreader|DepartureMono|archivo/i.test(u))).toEqual([]);
  // The limits widget follows the transcript's preset, not the terminal's.
  expect(await family(page.locator('.lm-pct'))).toContain('JetBrains Mono Variable');
});

test('each view takes its own preset without a reload: transcript (tools shown and hidden), terminal, a mixed pair', async ({ page }) => {
  test.setTimeout(300_000);
  const clean = watchErrors(page);
  const id = await sitAt(page);
  const tx = await openTranscript(page, id);
  for (const pick of IDS) {
    await tx.locator(`[role="radio"][data-theme-id="${pick}"]`).click();
    await page.evaluate(() => window.__h3d.themeLoaded());
    expect(await theme(page)).toMatchObject({ transcript: pick, terminal: 'quiet' });
    await expect(tx).toHaveAttribute('data-theme', pick);
    await checkFonts(page, tx, pick);
    // The terminal keeps its own.
    expect((await theme(page)).terminalFont).toContain(FAMILY.quiet.mono);
    // Box drawing in tool output: drawn by a face that has it, in line.
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
    // #70: a Read's images stay while tool calls are hidden, as a bare strip (no header, no body).
    const read = tx.locator('[data-id="toolu_demo_read"]');
    await read.scrollIntoViewIfNeeded();
    await expect(read.locator('.tx-tool-strip .tx-thumb')).toHaveCount(2);
    await expect(read.locator('.tx-tool-strip')).toBeVisible();
    await expect(read.locator('.tx-tool-row')).toBeHidden();
    await expect.poll(() => read.locator('.tx-thumb img').evaluateAll((els) => els.every((e) => (e as HTMLImageElement).naturalWidth > 0))).toBe(true);
    await frames(page, 4);
    await shot(page, `m70-toolimg-${pick}-hidden`);
    await tx.locator('.tx-check-box').uncheck();
    await expect(tx.locator('[data-id="toolu_demo_grep"]')).toBeVisible();
    // Shown: the same strip under the Read's collapsed header.
    await expect(read.locator('.tx-tool-row')).toBeVisible();
    await expect(read.locator('.tx-tool-body')).toBeHidden();
    await read.scrollIntoViewIfNeeded();
    await frames(page, 4);
    await shot(page, `m70-toolimg-${pick}`);
  }
  // The terminal's own presets, from the seat bar: its canvas changes, the transcript and the limits widget do not.
  await page.keyboard.press('Control+Escape');
  await expect(tx).toBeHidden();
  const seatRadios = page.getByRole('radiogroup', { name: 'Terminal theme' });
  for (const pick of IDS) {
    await seatRadios.getByRole('radio', { name: LABEL[pick] }).click();
    await page.evaluate(() => window.__h3d.themeLoaded());
    expect(await theme(page)).toMatchObject({ transcript: 'paper', terminal: pick, ready: pick });
    expect((await theme(page)).terminalFont).toContain(FAMILY[pick].mono);
    expect(await family(page.locator('.lm-pct'))).toContain(FAMILY.paper.mono);
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('paper');
    await frames(page, 12);
    await shot(page, `m59-terminal-${pick}`);
  }
  // A mixed pair: the transcript in Paper over the terminal in Terminal (Departure Mono, phosphor green).
  await seatRadios.getByRole('radio', { name: 'Terminal' }).click();
  await page.evaluate(() => window.__h3d.themeLoaded());
  await frames(page, 12);
  await shot(page, 'm59-mixed-terminal');
  await page.keyboard.press('Control+Escape');
  await expect(tx).toBeVisible();
  await frames(page, 6);
  await shot(page, 'm59-mixed-transcript');
  // Both picks survive a reload (and so does "Hide tools").
  await tx.locator('.tx-check-box').check();
  await page.reload();
  await page.waitForFunction(() => window.__h3d?.ready && window.__h3d.frames >= 3);
  expect(await theme(page)).toMatchObject({ transcript: 'paper', terminal: 'terminal', hideTools: true });
  clean();
});

test('with localStorage blocked both presets, Hide tools and both zooms still work for the page', async ({ page }) => {
  test.setTimeout(150_000);
  await page.addInitScript(() => {
    const boom = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
    Object.defineProperty(window, 'localStorage', { configurable: true, get: boom });
  });
  const id = await sitAt(page);
  await page.getByRole('radiogroup', { name: 'Terminal theme' }).getByRole('radio', { name: 'Terminal' }).click();
  await page.getByRole('button', { name: 'Larger terminal text' }).click();
  const tx = await openTranscript(page, id);
  await tx.locator('[role="radio"][data-theme-id="paper"]').click();
  await page.evaluate(() => window.__h3d.themeLoaded());
  await tx.getByRole('button', { name: 'Larger text' }).click();
  await tx.getByRole('button', { name: 'Larger text' }).click();
  await tx.locator('.tx-check-box').check();
  expect(await theme(page)).toMatchObject({ transcript: 'paper', terminal: 'terminal', ready: 'terminal', transcriptZoom: 120, terminalZoom: 110, hideTools: true });
  await expect(tx.locator('[data-id="toolu_demo_grep"]')).toBeHidden();
});

test('each view has its own zoom: A− / 100% / A+ and the Ctrl keys in the transcript, Ctrl+wheel on the terminal, only while seated', async ({ page }) => {
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
  expect(await theme(page)).toMatchObject({ transcriptZoom: 100, terminalZoom: 100 });

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
  await expect(tx.locator('.tx-input')).toHaveText('');
  await tx.locator('.tx-scroll').focus();
  await page.keyboard.press('Control+0');
  await expect(level).toHaveText('100%');

  // 200% and 70%: nothing overlaps or clips, code scrolls sideways inside its block; the terminal's zoom stays.
  for (const z of [200, 70]) {
    while ((await theme(page)).transcriptZoom !== z) await page.keyboard.press(z > 100 ? 'Control+=' : 'Control+-');
    await expect(level).toHaveText(`${z}%`);
    expect((await theme(page)).terminalZoom).toBe(100);
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
  await page.keyboard.press('Control+=');
  await expect(level).toHaveText('110%');

  // Terminal mode: its own zoom. Ctrl+wheel over the screen, and the keys; the seat bar shows its level; the
  // transcript's stays at 110%.
  await page.keyboard.press('Control+Escape');
  await expect(tx).toBeHidden();
  const termLevel = page.locator('.seat-zoom-level');
  await expect(termLevel).toHaveText('100%');
  await page.mouse.move(640, 360);
  await page.keyboard.down('Control');
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -120);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await theme(page)).terminalZoom).toBe(200);
  await expect(termLevel).toHaveText('200%');
  expect((await theme(page)).transcriptZoom).toBe(110);
  await frames(page, 12);
  await shot(page, 'm59-terminal-zoom-200');
  await page.keyboard.press('Control+-');
  await expect(termLevel).toHaveText('190%');
  await page.keyboard.press('Control+0');
  await expect(termLevel).toHaveText('100%');
  await page.getByRole('button', { name: 'Larger terminal text' }).click();
  await expect(termLevel).toHaveText('110%');
  expect((await theme(page)).transcriptZoom).toBe(110);

  // Levels survive a reload; switching the transcript's preset keeps its zoom (Departure Mono on 22px at 200%).
  await page.reload();
  await page.waitForFunction(() => window.__h3d?.ready && window.__h3d.frames >= 3);
  expect(await theme(page)).toMatchObject({ transcriptZoom: 110, terminalZoom: 110 });
  const id2 = await sitAt(page, 'Nibble');
  const tx2 = await openTranscript(page, id2);
  for (let i = 0; i < 9; i++) await page.keyboard.press('Control+=');
  expect((await theme(page)).transcriptZoom).toBe(200);
  await tx2.locator('[role="radio"][data-theme-id="terminal"]').click();
  await page.evaluate(() => window.__h3d.themeLoaded());
  expect((await theme(page)).transcriptZoom).toBe(200);
  expect(await tx2.locator('.tx-md pre code').first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBe(22);
  await tx2.getByRole('button', { name: /Text size 200%/ }).click();
  expect(await tx2.locator('.tx-md pre code').first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBe(11);
  expect((await theme(page)).terminalZoom).toBe(110);
  clean();
});

test('both pickers and Hide tools are reachable by keyboard, and the transcript keys still work', async ({ page }) => {
  test.setTimeout(150_000);
  const id = await sitAt(page, 'Nibble');
  const tx = await openTranscript(page, id);
  const scroller = tx.locator('.tx-scroll');
  await scroller.focus();
  const focused = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.className ?? '');
  // Shift+Tab from the timeline reaches the strip's controls: the transcript's preset (the checked radio holds the stop).
  let hops = 0;
  while (!(await focused()).includes('tx-theme') && hops++ < 40) await page.keyboard.press('Shift+Tab');
  expect(await focused()).toContain('tx-theme');
  expect(await page.evaluate(() => document.activeElement?.closest('[role="radiogroup"]')?.getAttribute('aria-label'))).toBe('Transcript theme');
  expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-checked'))).toBe('true');
  await page.keyboard.press('ArrowRight');
  expect((await theme(page)).transcript).toBe('paper');
  await page.keyboard.press('ArrowLeft');
  expect((await theme(page)).transcript).toBe('quiet');
  hops = 0;
  while (!(await focused()).includes('tx-check-box') && hops++ < 20) await page.keyboard.press('Shift+Tab');
  expect(await focused()).toContain('tx-check-box');
  await page.keyboard.press('Space');
  expect((await theme(page)).hideTools).toBe(true);
  await page.keyboard.press('Space');
  expect((await theme(page)).hideTools).toBe(false);
  // Further on, the terminal's preset and zoom in the seat bar (in terminal mode every key is the pane's).
  hops = 0;
  while (!(await focused()).includes('seat-theme') && hops++ < 60) await page.keyboard.press('Shift+Tab');
  expect(await focused()).toContain('seat-theme');
  expect(await page.evaluate(() => document.activeElement?.closest('[role="radiogroup"]')?.getAttribute('aria-label'))).toBe('Terminal theme');
  await page.keyboard.press('ArrowRight');
  expect(await theme(page)).toMatchObject({ transcript: 'quiet', terminal: 'paper' });
  await page.keyboard.press('Tab');
  expect(await focused()).toContain('seat-zoom-btn');
  await page.keyboard.press('Enter');
  expect((await theme(page)).terminalZoom).toBe(90);
  expect((await theme(page)).transcriptZoom).toBe(100);
  // Back on the timeline: PgUp / PgDn and j / k scroll, Enter goes to the prompt box, Ctrl+Esc swaps, Esc stands up.
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

test('Ctrl+, reaches the terminal’s preset and zoom without a transcript (a bridge before M16), and Tab stays the pane’s', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await sitAt(page, 'Tofu', {}, `${SIM}&simfail=no_m16`);
  const focused = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.className ?? '');
  // No conversation to open: Ctrl+Esc says why and stays on the terminal.
  await page.keyboard.press('Control+Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.seat().state)).toBe('error');
  expect(await page.evaluate(() => window.__h3d.seat().mode)).toBe('terminal');
  // Tab and Shift+Tab are the pane's: the keyboard stays on the pane's hidden input.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  expect(await focused()).toContain('seat-input');
  // The seat bar says the key; Ctrl+, lands on the picked preset.
  const label = page.locator('.seat-look-label');
  await expect(label.locator('kbd')).toHaveText(['Ctrl', ',']);
  expect(await page.locator('.seat [role="radiogroup"]').getAttribute('aria-keyshortcuts')).toBe('Control+,');
  await page.keyboard.press('Control+,');
  expect(await focused()).toContain('seat-theme');
  expect(await page.evaluate(() => document.activeElement?.closest('[role="radiogroup"]')?.getAttribute('aria-label'))).toBe('Terminal theme');
  await page.keyboard.press('ArrowRight');
  await page.evaluate(() => window.__h3d.themeLoaded());
  expect(await theme(page)).toMatchObject({ transcript: 'quiet', terminal: 'paper', ready: 'paper' });
  await page.keyboard.press('Tab');
  expect(await focused()).toContain('seat-zoom-btn');
  await page.keyboard.press('Enter');
  expect((await theme(page)).terminalZoom).toBe(90);
  // Esc hands the keyboard back to the pane (you stay seated); the next Esc stands you up.
  const back = page.locator('.seat-zoom-btn').first();
  await back.focus();
  await page.keyboard.press('Escape');
  expect(await focused()).toContain('seat-input');
  expect(await page.evaluate(() => window.__h3d.seated())).not.toBeNull();
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
  clean();
});

/** Every shown control of `sel` (buttons, inputs), with its box, and the boxes it must lie in. */
async function controlsInside(page: Page, sel: string, within: string): Promise<{ outside: string[]; count: number }> {
  return page.evaluate(
    ([s, w]) => {
      const box = document.querySelector<HTMLElement>(w)!.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const els = [...document.querySelectorAll<HTMLElement>(`${s} button, ${s} input`)].filter((e) => e.offsetParent !== null && getComputedStyle(e).visibility !== 'hidden');
      const outside = els
        .filter((e) => {
          const r = e.getBoundingClientRect();
          if (r.width < 8) return false; // the Hide tools label's box is its checkbox's
          return r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5 || r.left < 0 || r.right > vw || r.top < 0 || r.bottom > vh;
        })
        .map((e) => `${e.className} ${e.getAttribute('aria-label') ?? e.textContent} ${JSON.stringify(e.getBoundingClientRect())}`);
      return { outside, count: els.length };
    },
    [sel, within] as const,
  );
}

for (const [w, h] of [
  [640, 667],
  [390, 667],
] as const) {
  test(`at ${w}×${h} the transcript strip and the seat bar keep every control in view, the level too`, async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: w, height: h });
    const id = await sitAt(page, 'Tofu', { 'h3d.theme.transcript': 'paper', 'h3d.zoom.transcript': '70', 'h3d.transcript.hideTools': '1' });
    const tx = await openTranscript(page, id);
    await page.evaluate(() => window.__h3d.themeLoaded());
    // The worst case the review found: Paper, 70%, Hide tools on (its chip up), a question pinned.
    expect(await theme(page)).toMatchObject({ transcript: 'paper', transcriptZoom: 70, hideTools: true });
    await frames(page, 5);
    const strip = await controlsInside(page, '.seat-transcript .tx-bar', '.seat-transcript .tx-bar');
    expect(strip.outside, 'strip controls outside the strip or the window').toEqual([]);
    expect(strip.count).toBeGreaterThanOrEqual(8);
    // The strip is inside the overlay, and the overlay inside the window.
    const inView = await controlsInside(page, '.seat-transcript .tx-bar', '.seat-transcript');
    expect(inView.outside).toEqual([]);
    const level = tx.locator('.tx-zoom-level');
    await expect(level).toHaveAttribute('aria-label', /^Text size 70%/);
    await expect(level).toBeVisible();
    await expect(level).toHaveText('70%');
    for (const name of ['Terminal', 'Quiet', 'Paper', 'Smaller text', 'Larger text']) await expect(tx.getByRole(name.includes('text') ? 'button' : 'radio', { name, exact: true })).toBeVisible();
    await tx.getByRole('button', { name: 'Larger text' }).click();
    await expect(level).toHaveText('80%');
    const seat = await controlsInside(page, '.seat', '.seat');
    expect(seat.outside, 'seat bar controls outside the bar or the window').toEqual([]);
    await shot(page, `m59-narrow-${w}-transcript`);
    // The terminal's side: the seat bar's controls, in terminal mode, at the same width.
    await page.keyboard.press('Control+Escape');
    await expect(tx).toBeHidden();
    await frames(page, 5);
    const term = await controlsInside(page, '.seat', '.seat');
    expect(term.outside, 'seat bar controls outside the bar or the window (terminal mode)').toEqual([]);
    expect(term.count).toBeGreaterThanOrEqual(8);
    await expect(page.locator('.seat-zoom-level')).toHaveText('100%');
    await expect(page.locator('.seat-zoom-level')).toBeVisible();
    await page.locator('.seat [aria-label="Larger terminal text"]').click();
    await expect(page.locator('.seat-zoom-level')).toHaveText('110%');
    await shot(page, `m59-narrow-${w}-terminal`);
  });
}
