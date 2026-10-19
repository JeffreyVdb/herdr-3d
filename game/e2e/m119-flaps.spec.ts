import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { frames, openGame, shot, watchErrors } from './game';

// #119: the floor overview's now line while the model writes it, against the fixture bridge (`sim=1`) on demo-m118.
// The fixture's summaries are off here; Turnip's digest is given each state on its way to the page (the bridge's frames
// are rewritten, and a worker.upsert of Turnip is sent again for each step, the bridge's seq after it moved up by one so
// the game applies both), as m118-digest does for a failed refresh.

const FIRST = 'Reviewing the picker port before the PR goes out to the reviewers';
const SECOND = 'Rerunning the picker tests after the reviewer asked for a smaller diff';

type Digest = Record<string, unknown>;

/** Turnip's digest per step: a first summary on its way over its title, the model's line, a refresh of it, the next. */
const STEPS: Record<string, (at: number) => Digest> = {
  loading: () => ({ now_source: 'title', now_status: { state: 'pending' } }),
  first: (at) => ({ now: FIRST, now_source: 'llm', now_at: at }),
  refresh: (at) => ({ now: FIRST, now_source: 'llm', now_at: at, now_status: { state: 'pending' } }),
  second: (at) => ({ now: SECOND, now_source: 'llm', now_at: at }),
};

interface Rig {
  /** Gives Turnip the step's digest and sends Turnip's last worker.upsert again with it. */
  step(name: keyof typeof STEPS): void;
}

async function rig(page: Page): Promise<Rig> {
  let client: WebSocketRoute | null = null;
  let mode: keyof typeof STEPS = 'loading';
  let last: Record<string, unknown> | null = null;
  // The bridge's seq as the game sees it: each step adds an event, so every later one is one further on.
  let seq = 0;
  let shift = 0;
  const at = Date.now() - 2 * 60_000;
  const patch = (w: { label?: string; name?: string; digest?: Digest }) => {
    if (w.label !== 'Turnip' && w.name !== 'Turnip') return;
    const { now: _n, now_source: _s, now_at: _a, now_status: _st, ...rest } = w.digest ?? {};
    w.digest = { ...rest, ...STEPS[mode]?.(at) };
    last = w as Record<string, unknown>;
  };
  await page.routeWebSocket(/\/fixture\//, (ws) => {
    client = ws;
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (typeof m !== 'string') return ws.send(m);
      const f = JSON.parse(m);
      if (typeof f.seq === 'number') seq = f.seq += shift;
      if (f.t === 'world.snapshot') for (const w of f.world.workers) patch(w);
      if (f.t === 'worker.upsert') patch(f.worker);
      ws.send(JSON.stringify(f));
    });
  });
  return {
    step(name) {
      mode = name;
      if (!client || !last) throw new Error('no Turnip seen yet');
      patch(last as never);
      shift++;
      client.send(JSON.stringify({ t: 'worker.upsert', seq: ++seq, worker: last }));
    },
  };
}

/** Every row's box, and Turnip's lines' and metadata slots' (rounded to the pixel). */
async function boxes(page: Page): Promise<Record<string, number[]>> {
  return page.evaluate(() => {
    const out: Record<string, number[]> = {};
    const box = (e: Element | null) => {
      const r = e?.getBoundingClientRect();
      return r ? [r.x, r.y, r.width, r.height].map((n) => Math.round(n)) : [];
    };
    document.querySelectorAll<HTMLElement>('.ov-row').forEach((r) => (out[r.dataset.key ?? ''] = box(r)));
    const t = [...document.querySelectorAll('.ov-row')].find((r) => r.textContent?.includes('Turnip')) ?? null;
    out.now = box(t?.querySelector('.ov-now') ?? null);
    out.nowMeta = box(t?.querySelector('.ov-now > .ov-ai-meta') ?? null);
    out.task = box(t?.querySelector('.ov-task') ?? null);
    out.taskMeta = box(t?.querySelector('.ov-task > .ov-ai-meta') ?? null);
    return out;
  });
}

async function openOverview(page: Page): Promise<void> {
  await openGame(page, 'demo-m118', '', 'play=none&sim=1&simms=150');
  await page.evaluate(() => window.__h3d.enterFloor('lab'));
  await frames(page, 3);
  await page.keyboard.press('KeyO');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.overview()))?.page?.open).toBe(true);
  await expect(page.locator('.ov')).not.toHaveClass(/ov--enter/, { timeout: 5000 }); // the grow and cascade are over
}

test('a summary’s loading, arrival and refresh move no row, and keep the line’s place and its metadata slot', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  const r = await rig(page);
  await openOverview(page);
  const row = page.locator('.ov-row', { hasText: 'Turnip' });
  const line = row.locator('.ov-now');
  // A first summary on its way: flap cells over the title, turning, busy for assistive tech.
  await expect(line).toHaveClass(/ov-now--loading/);
  await expect(line).toHaveAttribute('aria-busy', 'true');
  await expect(line.locator('.ov-fc').first()).toBeVisible();
  await expect(line.locator('.ov-ai-meta')).toHaveText('summarizing');
  await expect(row).toHaveAttribute('aria-label', /Now: AI summary loading/);
  const g0 = await line.locator('.ov-fc').evaluateAll((c) => c.map((e) => (e as HTMLElement).dataset.g).join(''));
  await page.waitForTimeout(300);
  expect(await line.locator('.ov-fc').evaluateAll((c) => c.map((e) => (e as HTMLElement).dataset.g).join(''))).not.toBe(g0);
  await line.scrollIntoViewIfNeeded();
  const before = await boxes(page);
  // The cells that fit are whole: none is cut at the column's edge, and none spills out of the line.
  const fit = await line.evaluate((p) => {
    const lr = p.querySelector('.ov-flaprow')?.getBoundingClientRect();
    return [...p.querySelectorAll('.ov-fc')].filter((c) => {
      const b = c.getBoundingClientRect();
      return lr && b.top < lr.bottom && b.right > lr.right + 0.5;
    }).length;
  });
  expect(fit).toBe(0);
  await shot(page, 'm119-loading');

  // The model's line arrives: it resolves flap by flap, and nothing moves.
  r.step('first');
  await expect(line.locator('.ov-ch').first()).toBeAttached();
  await page.waitForTimeout(120);
  await shot(page, 'm119-arrival');
  await expect(line.locator('.ov-ch')).toHaveCount(0, { timeout: 2000 });
  await expect(line.locator('.ov-now-text')).toHaveText(FIRST);
  await expect(line.locator('.ov-age')).toHaveText(/^\dm ago$/);
  await expect(row).toHaveAttribute('aria-label', new RegExp(`Now: ${FIRST} \\(AI summary, \\dm ago\\)`));
  const arrived = await boxes(page);
  expect(arrived).toEqual(before);

  // A refresh of it: the line stays, dimmed, the busy mark where its age was; then the next line; nothing moves.
  r.step('refresh');
  await expect(line).toHaveClass(/ov-now--refreshing/);
  await expect(line.locator('.ov-busy')).toBeVisible();
  await expect(line.locator('.ov-now-text')).toHaveText(FIRST);
  expect(await boxes(page)).toEqual(before);
  await shot(page, 'm119-refresh');
  r.step('second');
  await expect(line.locator('.ov-ch').first()).toBeAttached();
  await expect(line.locator('.ov-ch')).toHaveCount(0, { timeout: 2000 });
  await expect(line.locator('.ov-now-text')).toHaveText(SECOND);
  expect(await boxes(page)).toEqual(before);
  // A phone: the cells stay within the line, nothing scrolls sideways; the row keeps its height as the line arrives.
  await page.setViewportSize({ width: 390, height: 844 });
  r.step('loading');
  await expect(line.locator('.ov-fc').first()).toBeVisible();
  await line.scrollIntoViewIfNeeded();
  const narrow = await boxes(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shot(page, 'm119-loading-narrow');
  r.step('first');
  await expect(line.locator('.ov-ch')).toHaveCount(0, { timeout: 2000 });
  expect(await boxes(page)).toEqual(narrow);
  clean();
});

test('reduced motion: the loading line is a still bar that says it, and the model’s line shows at once', async ({ page }) => {
  test.setTimeout(150_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const clean = watchErrors(page);
  const r = await rig(page);
  await openOverview(page);
  expect((await page.evaluate(() => window.__h3d.overview()))?.page?.calm).toBe(true);
  const row = page.locator('.ov-row', { hasText: 'Turnip' });
  const line = row.locator('.ov-now');
  await expect(line.locator('.ov-flapbar')).toHaveText('summarizing…');
  await expect(line.locator('.ov-fc')).toHaveCount(0);
  await line.scrollIntoViewIfNeeded();
  const before = await boxes(page);
  await shot(page, 'm119-calm');
  r.step('first');
  await expect(line.locator('.ov-now-text')).toHaveText(FIRST);
  // At once, and nothing in the column is animated (no resolve, no flip).
  expect(await line.locator('.ov-ch').count()).toBe(0);
  expect(await line.evaluate((p) => p.getAnimations({ subtree: true }).length)).toBe(0);
  expect(await boxes(page)).toEqual(before);
  r.step('refresh');
  await expect(line.locator('.ov-busy')).toBeVisible();
  expect(await row.evaluate((p) => p.getAnimations({ subtree: true }).length)).toBe(0);
  clean();
});
