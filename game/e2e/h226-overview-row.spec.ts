import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, shot, watchErrors } from './game';

// #226: a worker row on the floor overview gives its now line a line of its own. Turnip (demo-m118's one-off worker)
// is given a now line of the bridge's full budget (NowMax, 100 runes) from the model and an open shell command of the
// waiting detail's full budget (MaxWaitDetail, 40 runes) on its way to the page. Focused and hovered, at the e2e
// viewport and a 1440 px window: the now text is not cut, the live chip sits under the worker, the AI mark under the
// since time, and the hint takes the since time's place without overlapping any other text of the row.

const NOW = 'Verifying host credentials after recreating an IAM role, then rerunning the staging smoke test suite';
const DETAIL = 'ssh -o StrictHostKeyChecking=no op@54.83';
/** The chip as the game shows it: it clips a detail to 32 code points itself (world/activity.ts `DETAIL_MAX`). */
const CHIP = `Waiting · ${[...DETAIL].slice(0, 31).join('').trimEnd()}…`;

/** Turnip, working on a model's now line with a shell command open, whatever the fixture's sim sends. */
async function patchTurnip(page: Page): Promise<void> {
  let id = '';
  const activity = { kind: 'waiting', detail: DETAIL, since: Date.now() - 60_000 };
  const patch = (w: { id: string; label?: string; name?: string; status?: string; activity?: unknown; digest?: Record<string, unknown> }) => {
    if (w.label !== 'Turnip' && w.name !== 'Turnip' && w.id !== id) return;
    id = w.id;
    w.status = 'working';
    w.activity = activity;
    w.digest = { ...w.digest, now: NOW, now_source: 'llm', now_at: Date.now() - 30_000 };
    delete w.digest.now_status;
  };
  await page.routeWebSocket(/\/fixture\//, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (typeof m !== 'string') return ws.send(m);
      const f = JSON.parse(m);
      if (f.t === 'world.snapshot') for (const w of f.world.workers) patch(w);
      if (f.t === 'worker.upsert') patch(f.worker);
      if (f.t === 'worker.status' && f.id === id) f.status = 'working';
      if (f.t === 'worker.activity' && f.id === id) f.activity = activity;
      ws.send(JSON.stringify(f));
    });
  });
}

/** The row's text boxes other than the hint (leaf elements with text, rendered), and the hint's. */
function boxes(page: Page, key: string) {
  return page.evaluate((key) => {
    const row = document.querySelector<HTMLElement>(`.ov-row[data-key="${CSS.escape(key)}"]`);
    if (!row) throw new Error('no row');
    const hint = row.querySelector<HTMLElement>('.ov-hint');
    const box = (e: Element) => {
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    const shown = (e: HTMLElement) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    const text = [...row.querySelectorAll<HTMLElement>('*')].filter(
      (e) => !hint?.contains(e) && shown(e) && [...e.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()),
    );
    return { hint: hint && shown(hint) ? box(hint) : null, text: text.map((e) => ({ cls: e.className, text: e.textContent?.trim() ?? '', ...box(e) })) };
  }, key);
}

for (const vp of [
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
]) {
  test(`a 100-rune now line reads in full beside its chips, focused and hovered, at ${vp.width} px (#226)`, async ({ page }) => {
    test.setTimeout(150_000);
    const clean = watchErrors(page);
    await page.setViewportSize(vp);
    await patchTurnip(page);
    await openGame(page, 'demo-m118', '', 'play=none&sim=1&simms=150');
    await page.evaluate(() => window.__h3d.enterFloor('lab'));
    await frames(page, 3);
    await page.keyboard.press('KeyO');
    await expect.poll(async () => (await page.evaluate(() => window.__h3d.overview()))?.page?.open).toBe(true);
    await expect(page.locator('.ov')).not.toHaveClass(/ov--enter/, { timeout: 5000 });
    const row = page.locator('.ov-row', { hasText: 'Turnip' });
    const key = (await row.getAttribute('data-key')) ?? '';
    await expect(row.locator('.ov-now-text')).toHaveText(NOW);
    expect([...NOW]).toHaveLength(100);
    expect([...DETAIL]).toHaveLength(40);

    // The now line is the label and the text; the chip is the worker's, the AI mark the since column's.
    await expect(row.locator('.ov-who .ov-act')).toHaveText(CHIP);
    await expect(row.locator('.ov-who .ov-act')).toHaveAttribute('title', CHIP);
    await expect(row.locator('.ov-since .ov-llm')).toHaveText(/^AI · (just now|\d+m ago)$/);
    expect(await row.locator('.ov-now .ov-act, .ov-now .ov-llm').count()).toBe(0);
    expect(await row.getAttribute('aria-label')).toContain(` · ${CHIP} · `);

    // At rest: the since time shows, the hint does not.
    await page.mouse.move(2, 2);
    await expect(row.locator('.ov-hint')).toBeHidden();
    await expect(row.locator('.ov-since-text')).toBeVisible();

    // Focused and hovered.
    await row.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await row.focus();
    const name = await row.locator('.ov-name').boundingBox();
    if (!name) throw new Error('no name');
    await page.mouse.move(name.x + name.width / 2, name.y + name.height / 2);
    await expect(row.locator('.ov-hint')).toBeVisible();
    await expect(row.locator('.ov-since-text')).toBeHidden();
    // The text fits, and with room to spare: the line leaves it 5 % more than it needs, as another Chromium renders the
    // same face a few percent wider (704 px against this one's 688).
    const fit = await row.locator('.ov-now-text').evaluate(async (e) => {
      await document.fonts.ready;
      const line = e.parentElement as HTMLElement;
      const label = line.querySelector('b') as HTMLElement;
      const r = document.createRange();
      r.selectNodeContents(e);
      return {
        client: e.clientWidth,
        scroll: e.scrollWidth,
        text: r.getBoundingClientRect().width,
        room: line.clientWidth - label.getBoundingClientRect().width - parseFloat(getComputedStyle(line).columnGap),
      };
    });
    console.log(`#226 ${vp.width}px: .ov-now-text clientWidth ${fit.client} scrollWidth ${fit.scroll} text ${fit.text.toFixed(1)} room ${fit.room} (${(fit.room / fit.text).toFixed(3)}×)`);
    await shot(page, `h226-row-${vp.width}`);
    expect(fit.scroll).toBeLessThanOrEqual(fit.client);
    expect(fit.room).toBeGreaterThanOrEqual(fit.text * 1.05);

    // The hint is in the since column's place: it overlaps no other text of the row.
    const b = await boxes(page, key);
    expect(b.hint).not.toBeNull();
    const h = b.hint as NonNullable<typeof b.hint>;
    const hit = b.text.filter((t) => t.x < h.x + h.w && h.x < t.x + t.w && t.y < h.y + h.h && h.y < t.y + t.h);
    expect(hit, `hint ${JSON.stringify(h)} overlaps`).toEqual([]);

    // Away: the since time is back.
    await page.mouse.move(2, 2);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(row.locator('.ov-hint')).toBeHidden();
    await expect(row.locator('.ov-since-text')).toBeVisible();
    clean();
  });
}
