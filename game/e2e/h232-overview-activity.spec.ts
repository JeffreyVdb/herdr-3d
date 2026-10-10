import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, shot, watchErrors } from './game';

// #232 on demo-m118's lab floor, its workers given these states on their way to the page (the frames the game sends are
// kept): Poppy (Claude) investigating with a model's now line 2 minutes old; Juniper (Codex) testing, its model's line
// 7 minutes old and its refresh failed; Sprout needs you while its AI line is pending; Basil working with no activity;
// Radish idle; Turnip (a one-off worker) looking at an image, under a model's task line and a model's now line of the
// bridge's full budget (100 runes). In Quiet and Ubuntu: the since column says what each does in plain words (or its
// state), the sparkle sits by its line's label with the age quiet after the text, pending is quiet words, a failed
// refresh keeps its chip and Retry. From 1280 px down to a phone the verb and the time are never cut, only the detail
// (gone, never a hanging `· …`, when too little of it would show); the label, the age and the text share a baseline and
// the sparkle is centred on the text's capitals. In forced colours the sparkle and the words are the user's text colour,
// asleep rows too.

const SIM = 'play=none&sim=1&simms=150';
const NOW = 'Verifying host credentials after recreating an IAM role, then rerunning the staging smoke test suite';
const UBUNTU = { 'h3d.theme.ui': 'ubuntu', 'h3d.theme.transcript': 'ubuntu', 'h3d.theme.terminal': 'ubuntu' };

async function patch(page: Page): Promise<void> {
  const T = Date.now();
  const P: Record<string, { status: string; since: number; activity: unknown; digest?: Record<string, unknown> }> = {
    Poppy: { status: 'working', since: T - 23 * 60e3, activity: { kind: 'investigating', detail: 'grep -n activityOf src/world', since: T }, digest: { now: 'Tracing where the activity gets joined', now_source: 'llm', now_at: T - 150e3 } },
    Juniper: {
      status: 'working',
      since: T - 64 * 60e3,
      activity: { kind: 'testing', detail: 'pnpm vitest run src/ui/overview.dom.test.ts', since: T },
      digest: { now: 'Round 1 of the lobby directory is out to code', now_source: 'llm', now_at: T - 7 * 60e3, now_status: { state: 'failed', reason: 'timeout' } },
    },
    Sprout: { status: 'blocked', since: T - 4 * 60e3, activity: null, digest: { now: 'Pass 3 still has two blockers', now_source: 'recap', now_status: { state: 'pending' } } },
    Basil: { status: 'working', since: T - 12 * 60e3, activity: null },
    Radish: { status: 'idle', since: T - 41 * 60e3, activity: null },
    Turnip: {
      status: 'working',
      since: T - 64 * 60e3,
      activity: { kind: 'image', detail: 'overview-1280-quiet.png', since: T },
      digest: { task: 'Tidy the README and its links', task_source: 'llm', now: NOW, now_source: 'llm', now_at: T - 30e3 },
    },
  };
  const ids = new Map<string, string>();
  const apply = (w: { id: string; name?: string; label?: string; status?: string; status_since?: number; activity?: unknown; digest?: unknown }) => {
    const p = P[w.name ?? w.label ?? ''];
    if (!p) return;
    ids.set(w.id, w.name ?? w.label ?? '');
    Object.assign(w, { status: p.status, status_since: p.since, activity: p.activity }, p.digest ? { digest: p.digest } : {});
  };
  await page.routeWebSocket(/\/fixture\//, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (typeof m !== 'string') return ws.send(m);
      const f = JSON.parse(m);
      if (f.t === 'world.snapshot') for (const w of f.world.workers) apply(w);
      if (f.t === 'worker.upsert') apply(f.worker);
      const p = P[ids.get(f.id) ?? ''];
      if (p && f.t === 'worker.status') Object.assign(f, { status: p.status, status_since: p.since });
      if (p && f.t === 'worker.activity') f.activity = p.activity;
      if (p?.digest && f.t === 'worker.digest') return;
      ws.send(JSON.stringify(f));
    });
  });
}

async function overview(page: Page, theme: 'quiet' | 'ubuntu'): Promise<void> {
  if (theme === 'ubuntu') await page.addInitScript((o) => Object.entries(o).forEach(([k, v]) => localStorage.setItem(k, v)), UBUNTU);
  await patch(page);
  await openGame(page, 'demo-m118', '', SIM);
  await page.evaluate(() => window.__h3d.enterFloor('lab'));
  await frames(page, 3);
  await page.keyboard.press('KeyO');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.overview()))?.page?.open).toBe(true);
  await expect(page.locator('.ov')).not.toHaveClass(/ov--enter/, { timeout: 5000 });
}

for (const theme of ['quiet', 'ubuntu'] as const) {
  test(`the since column says what each worker does, the sparkle sits by its label, in ${theme} (#232)`, async ({ page }) => {
    test.setTimeout(150_000);
    const clean = watchErrors(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await overview(page, theme);
    const row = (n: string) => page.locator('.ov-row', { hasText: n }).first();
    const doing = (n: string) => row(n).locator('.ov-since .ov-doing');
    // Claude and Codex alike.
    await expect(row('Poppy').locator('.ov-who > .ov-mark')).toHaveAttribute('aria-label', 'Claude');
    await expect(row('Juniper').locator('.ov-who > .ov-mark')).toHaveAttribute('aria-label', 'Codex');
    await expect(doing('Poppy')).toHaveText(/^Investigating · grep -n activityOf src\/world · 2[34]m$/);
    await expect(doing('Juniper')).toHaveText(/^Testing · pnpm vitest run src\/ui\/overview… · 1h 0[45]m$/);
    await expect(doing('Basil')).toHaveText(/^working 1[23]m$/);
    await expect(doing('Sprout')).toHaveText(/^needs you [45]m$/);
    await expect(doing('Radish')).toHaveText(/^idle 4[12]m$/);
    await expect(doing('Turnip')).toHaveText(/^Looking at an image · overview-1280-quiet\.png · 1h 0[45]m$/);
    // The sparkle: 12–14 px, its line's label's, no outline or fill behind it; the age quiet after the text.
    for (const n of ['Poppy', 'Juniper']) {
      const s = row(n).locator('.ov-now > b > .ov-ai');
      await expect(s).toBeVisible();
      const box = await s.locator('svg').boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(12);
      expect(box?.width).toBeLessThanOrEqual(14);
      expect(await s.evaluate((e) => [getComputedStyle(e).borderTopStyle, getComputedStyle(e).backgroundColor])).toEqual(['none', 'rgba(0, 0, 0, 0)']);
    }
    await expect(row('Poppy').locator('.ov-now .ov-age')).toHaveText('2m ago');
    await expect(row('Juniper').locator('.ov-now .ov-age')).toHaveText('7m ago');
    // A failed refresh: the chip and Retry after the age; pending: quiet words, no sparkle (the line is the fallback).
    await expect(row('Juniper').locator('.ov-now .ov-ai-state')).toHaveText('refresh failed');
    await expect(row('Juniper').locator('.ov-now .ov-retry')).toBeVisible();
    const pending = row('Sprout').locator('.ov-now .ov-ai-state--pending');
    await expect(pending).toHaveText('AI pending');
    expect(await pending.evaluate((e) => getComputedStyle(e).borderTopWidth)).toBe('0px');
    expect(await row('Sprout').locator('.ov-ai').count()).toBe(0);
    // The time keeps its place at the column's right edge, row to row.
    const ends = await page.locator('.ov-row--worker .ov-time').evaluateAll((es) => es.map((e) => Math.round(e.getBoundingClientRect().right)));
    expect(new Set(ends).size).toBe(1);
    await shot(page, `h232-states-${theme}`);
    clean();
  });

  test(`the verb and the time are never cut, only the detail; the line's parts line up, 1280 px to a phone, in ${theme} (#232)`, async ({ page }) => {
    test.setTimeout(150_000);
    const clean = watchErrors(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await overview(page, theme);
    // Active only: the working rows in view.
    if ((await page.evaluate(() => window.__h3d.overview()))?.page?.filter !== 'active') await page.keyboard.press('KeyF');
    await page.mouse.move(1, 1);
    for (const vp of [
      { width: 1280, height: 720 },
      { width: 1440, height: 900 },
      { width: 760, height: 900 },
      { width: 480, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(vp);
      await page.waitForTimeout(300);
      // Narrow, the rows are taller: Turnip (its task line and its wrapped now line) in view for the shot.
      if (vp.width <= 760) await page.locator('.ov-row', { hasText: 'Turnip' }).first().scrollIntoViewIfNeeded();
      const m = await page.evaluate(async () => {
        await document.fonts.ready;
        const box = (e: Element) => e.getBoundingClientRect();
        // A text's baseline: its first line's box (a text fragment's box is its face's ascent and descent) plus the face's
        // ascent; its capitals' middle: the baseline less half an H's ink height, both read from a canvas in the text's own
        // computed face, weight and size.
        const metrics = (e: Element) => {
          const cs = getComputedStyle(e);
          const g = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D;
          g.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
          const h = g.measureText('H');
          return { ascent: h.fontBoundingBoxAscent, cap: h.actualBoundingBoxAscent };
        };
        const baseline = (e: Element) => {
          const t = [...e.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()) as Node;
          const rg = document.createRange();
          rg.selectNodeContents(t);
          return (rg.getClientRects()[0] as DOMRect).top + metrics(e).ascent;
        };
        const inked = (e: Element) => {
          const rg = document.createRange();
          rg.selectNodeContents(e);
          return rg.getBoundingClientRect().width;
        };
        const rows = [...document.querySelectorAll<HTMLElement>('.ov-row--worker')].filter((r) => r.querySelector('.ov-verb'));
        const working = rows.map((r) => {
          const q = (s: string) => r.querySelector(s) as HTMLElement;
          const verb = q('.ov-verb');
          const detail = r.querySelector<HTMLElement>('.ov-detail');
          const [v, clip, since, what, time] = [verb, q('.ov-state--act'), q('.ov-since'), q('.ov-what'), q('.ov-time')].map(box) as DOMRect[];
          const ch = (v as DOMRect).width / (verb.textContent?.length ?? 1);
          const shown = !!detail && detail.getClientRects().length > 0 && box(detail).top < (clip as DOMRect).bottom - 1 && box(detail).width > 0;
          return {
            name: q('.ov-name').textContent,
            verbWhole: verb.scrollWidth <= verb.clientWidth,
            verbInside: (v as DOMRect).left >= (clip as DOMRect).left - 0.5 && (v as DOMRect).right <= (clip as DOMRect).right + 0.5 && (v as DOMRect).left >= (since as DOMRect).left,
            clearOfWhat: (v as DOMRect).left >= (what as DOMRect).right,
            // (Its text's box: an element's whole-pixel scroll and client widths disagree by a sub-pixel here.)
            timeWhole: (time as DOMRect).width > 0 && inked(q('.ov-time')) <= (time as DOMRect).width + 0.5,
            timeRight: Math.round((time as DOMRect).right),
            // The detail's characters that show, less its ` · ` and the ellipsis when cut.
            detail: shown && detail ? Math.floor(detail.clientWidth / ch + 0.01) - 3 - (detail.scrollWidth > detail.clientWidth ? 1 : 0) : 0,
          };
        });
        const lines = [...document.querySelectorAll('.ov-row--worker .ov-line')].filter((l) => l.querySelector('.ov-ai'));
        const align = lines.map((l) => {
          const text = l.querySelector('.ov-text') as HTMLElement;
          const age = l.querySelector('.ov-age');
          const star = box(l.querySelector('.ov-ai path') as Element);
          const tb = baseline(text);
          return {
            line: `${l.closest('.ov-row')?.querySelector('.ov-name')?.textContent} ${l.querySelector('b')?.textContent}`,
            label: baseline(l.querySelector('b') as Element) - tb,
            // (On a phone a line with a chip puts its metadata on a line of its own, #174.)
            age: age && !(innerWidth <= 480 && l.matches('.ov-line--status')) ? baseline(age) - tb : 0,
            sparkle: (star.top + star.bottom) / 2 - (tb - metrics(text).cap / 2),
          };
        });
        return { overflow: document.documentElement.scrollWidth > innerWidth, working, align };
      });
      console.log(`#232 ${theme} ${vp.width}px: ${JSON.stringify(m)}`);
      expect(m.overflow, `${vp.width}`).toBe(false);
      expect(m.working.length, `${vp.width}`).toBeGreaterThan(0);
      for (const w of m.working) {
        const at = `${w.name} ${vp.width}`;
        expect(w.verbWhole, at).toBe(true);
        expect(w.verbInside, at).toBe(true);
        if (vp.width >= 1280) expect(w.clearOfWhat, at).toBe(true);
        expect(w.timeWhole, at).toBe(true);
        // No hanging `· …`: a detail shows several characters, or none.
        if (w.detail) expect(w.detail, at).toBeGreaterThanOrEqual(4);
        if (vp.width <= 480) expect(w.detail, at).toBe(0);
      }
      if (vp.width >= 1280) {
        // The time keeps its place at the column's right edge; the detail has room to say something.
        expect(new Set(m.working.map((w) => w.timeRight)).size, `${vp.width}`).toBe(1);
        for (const n of ['Poppy', 'Juniper']) expect(m.working.find((w) => w.name === n)?.detail, `${n} ${vp.width}`).toBeGreaterThanOrEqual(12);
        expect(m.working.some((w) => w.name === 'Turnip'), `${vp.width}`).toBe(true);
      }
      if (vp.width >= 480) {
        // TASK and NOW (a wrapped NOW by its first line): the label and the age on the text's baseline, the sparkle on its
        // capitals' middle.
        expect(m.align.some((a) => a.line.endsWith('Task')), `${vp.width}`).toBe(true);
        for (const a of m.align) {
          expect(Math.abs(a.label), `${a.line} ${vp.width} label`).toBeLessThanOrEqual(0.5);
          expect(Math.abs(a.age), `${a.line} ${vp.width} age`).toBeLessThanOrEqual(0.5);
          expect(Math.abs(a.sparkle), `${a.line} ${vp.width} sparkle`).toBeLessThanOrEqual(1);
        }
      }
      await shot(page, `h232-geometry-${theme}-${vp.width}`);
    }
    clean();
  });

  test(`forced colours: the sparkle and the since column’s words are the user’s text colour, asleep rows too, in ${theme} (#232)`, async ({ page }) => {
    test.setTimeout(150_000);
    const clean = watchErrors(page);
    await page.emulateMedia({ forcedColors: 'active' });
    await page.setViewportSize({ width: 1280, height: 720 });
    await overview(page, theme);
    const colours = () =>
      page.evaluate(() => {
        const probe = document.body.appendChild(document.createElement('span'));
        probe.style.color = 'CanvasText';
        const want = getComputedStyle(probe).color;
        probe.remove();
        const got = [...document.querySelectorAll<HTMLElement>('.ov-row .ov-ai, .ov-row .ov-since, .ov-row .ov-state, .ov-row .ov-time')].map((e) => ({
          sel: `${e.closest('.ov-row')?.getAttribute('data-display')} ${e.className}`,
          color: getComputedStyle(e).color,
          fill: e.matches('.ov-ai') ? getComputedStyle(e.querySelector('path') as Element).fill : null,
        }));
        return { want, got };
      });
    const floor = await colours();
    expect(floor.got.some((g) => g.sel.includes('ov-ai'))).toBe(true);
    for (const g of floor.got) {
      expect(g.color, g.sel).toBe(floor.want);
      if (g.fill) expect(g.fill, g.sel).toBe(floor.want);
    }
    // Every floor, everyone, every group open: the asleep floor's rows too.
    await page.keyboard.press('KeyA');
    await expect.poll(async () => (await page.evaluate(() => window.__h3d.overview()))?.page?.view).toBe('city');
    if ((await page.evaluate(() => window.__h3d.overview()))?.page?.filter === 'active') await page.keyboard.press('KeyF');
    await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(() => page.locator('.ov-row[data-display="asleep"]').count()).toBeGreaterThan(0);
    const city = await colours();
    expect(city.got.some((g) => g.sel.startsWith('asleep'))).toBe(true);
    for (const g of city.got) expect(g.color, g.sel).toBe(city.want);
    await shot(page, `h232-forced-${theme}`);
    clean();
  });
}
