import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, shot, watchErrors } from './game';

// #226, #232: a worker row on the floor overview gives its now line a line of its own. Turnip (demo-m118's one-off
// worker) is given a now line of the bridge's full budget (NowMax, 100 runes) from the model and an open shell command
// of the waiting detail's full budget (MaxWaitDetail, 40 runes) on its way to the page. Focused and hovered, at the e2e
// viewport and a 1440 px window: the now text is never cut (at most two lines at either: the since column's room for the
// activity costs it the one-line room it had), the live activity is the since column's plain words (only the detail
// cut, the verb and the time whole), the sparkle sits by the line's label, a row whose now line takes one line is no
// taller than its name and model need, and the hint goes under the time without moving or overlapping any other text of
// the row.

const NOW = 'Verifying host credentials after recreating an IAM role, then rerunning the staging smoke test suite';
const DETAIL = 'ssh -o StrictHostKeyChecking=no op@54.83';
/** The activity as the game shows it: it clips a detail to 32 code points itself (world/activity.ts `DETAIL_MAX`). */
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
  test(`a 100-rune now line reads in full beside the activity and the sparkle, focused and hovered, at ${vp.width} px (#226, #232)`, async ({ page }) => {
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

    // The Worker column is the name and the model; the activity is the since column's words, with how long it has worked.
    expect(await row.locator('.ov-act, .ov-actline, .ov-llm').count()).toBe(0);
    const esc = (t: string) => t.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
    await expect(row.locator('.ov-since .ov-doing')).toHaveText(new RegExp(`^${esc(CHIP)} · (<1m|\\d+m|\\d+h \\d\\dm|\\d+d)$`));
    await expect(row.locator('.ov-since .ov-state')).toHaveAttribute('title', CHIP);
    expect(await row.getAttribute('aria-label')).toContain(` · ${CHIP} · `);
    // The sparkle hugs the line's label; the age is the line's quiet words after the text.
    await expect(row.locator('.ov-now > b > .ov-ai')).toBeVisible();
    await expect(row.locator('.ov-now .ov-age')).toHaveText(/^(just now|\d+m ago)$/);
    await row.locator('.ov-now').scrollIntoViewIfNeeded();

    // At rest: the time shows, the hint does not.
    await page.mouse.move(2, 2);
    await expect(row.locator('.ov-hint')).toBeHidden();
    await expect(row.locator('.ov-time')).toBeVisible();
    const rest = await row.boundingBox();

    // Focused and hovered.
    await row.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await row.focus();
    const name = await row.locator('.ov-name').boundingBox();
    if (!name) throw new Error('no name');
    await page.mouse.move(name.x + name.width / 2, name.y + name.height / 2);
    await expect(row.locator('.ov-hint')).toBeVisible();
    // The hint takes nothing's place: the activity and the time stay, the row keeps its height.
    await expect(row.locator('.ov-time')).toBeVisible();
    await expect(row.locator('.ov-state')).toBeVisible();
    expect((await row.boundingBox())?.height).toBeCloseTo(rest?.height ?? 0, 0);
    const m = await row.evaluate(async (r) => {
      await document.fonts.ready;
      const e = r.querySelector('.ov-now-text') as HTMLElement;
      const line = e.parentElement as HTMLElement;
      const label = line.querySelector('b') as HTMLElement;
      const rg = document.createRange();
      rg.selectNodeContents(e);
      const lines = new Set([...rg.getClientRects()].map((c) => Math.round(c.top))).size;
      const verb = r.querySelector('.ov-verb') as HTMLElement;
      const vr = document.createRange();
      vr.selectNodeContents(verb);
      const box = (x: Element) => x.getBoundingClientRect();
      const state = r.querySelector('.ov-state') as HTMLElement;
      const time = r.querySelector('.ov-time') as HTMLElement;
      return {
        client: e.clientWidth,
        scroll: e.scrollWidth,
        clientH: e.clientHeight,
        scrollH: e.scrollHeight,
        lines,
        text: rg.getBoundingClientRect().width,
        room: line.clientWidth - label.getBoundingClientRect().width - parseFloat(getComputedStyle(line).columnGap),
        gap: box(e).left - box(label).right,
        // The detail is cut, the verb whole: its text ends inside the activity's box; the time is whole.
        verbEnd: vr.getBoundingClientRect().right,
        stateEnd: box(state).right,
        detailCut: (() => {
          const d = r.querySelector('.ov-detail') as HTMLElement;
          return d.scrollWidth > d.clientWidth;
        })(),
        timeWhole: time.scrollWidth <= time.clientWidth,
        rowH: box(r).height,
        whoBottom: box(r.querySelector('.ov-who') as HTMLElement).bottom - box(r).top,
        whatBottom: box(r.querySelector('.ov-what') as HTMLElement).bottom - box(r).top,
      };
    });
    console.log(`#232 ${vp.width}px: ${JSON.stringify(m)}`);
    await shot(page, `h226-row-${vp.width}`);
    // Never cut: whole in width and in height, in at most two lines at 1280 and 1440 (#232: the since column's room for
    // the activity costs the line its one-line room there); on one line, with room to spare (another Chromium renders
    // the face a few percent wider), and the row then needs only its name and model lines.
    expect(m.scroll).toBeLessThanOrEqual(m.client);
    expect(m.scrollH).toBeLessThanOrEqual(m.clientH);
    expect(m.lines).toBeLessThanOrEqual(2);
    if (m.lines === 1) {
      expect(m.room).toBeGreaterThanOrEqual(m.text * 1.05);
      expect(m.whatBottom).toBeLessThanOrEqual(m.whoBottom + 1);
    }
    // The text follows its label at a small step, no slot kept for a sparkle.
    expect(m.gap).toBeGreaterThanOrEqual(5);
    expect(m.gap).toBeLessThanOrEqual(9);
    expect(m.detailCut).toBe(true);
    expect(m.verbEnd).toBeLessThanOrEqual(m.stateEnd + 0.5);
    expect(m.timeWhole).toBe(true);

    // The hint is under the time: it overlaps no other text of the row.
    const b = await boxes(page, key);
    expect(b.hint).not.toBeNull();
    const h = b.hint as NonNullable<typeof b.hint>;
    const hit = b.text.filter((t) => t.x < h.x + h.w && h.x < t.x + t.w && t.y < h.y + h.h && h.y < t.y + t.h);
    expect(hit, `hint ${JSON.stringify(h)} overlaps`).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // Away: the hint goes.
    await page.mouse.move(2, 2);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(row.locator('.ov-hint')).toBeHidden();
    await expect(row.locator('.ov-time')).toBeVisible();
    clean();
  });
}
