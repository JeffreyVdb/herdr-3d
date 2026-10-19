import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { frames, openGame, shot, watchErrors } from './game';

// #119: the floor overview's now line while the model writes it, against the fixture bridge (`sim=1`) on demo-m118.
// The fixture's summaries are off here; Turnip's digest is given each state on its way to the page (the bridge's frames
// are rewritten, and a worker.upsert of Turnip is sent again for each step, the bridge's seq after it moved up by one so
// the game applies both), as m118-digest does for a failed refresh.

const FIRST = 'Reviewing the picker port before the PR goes out to the reviewers';
const SECOND = 'Rerunning the picker tests after the reviewer asked for a smaller diff';
const TASK = 'Port the worker picker to the new overlay';

type Digest = Record<string, unknown>;

/** Turnip's digest per step: a first summary on its way over its title (its task the prompt's), the model's lines (now
 *  and task), a refresh of the now line, the next. */
const STEPS: Record<string, (at: number) => Digest> = {
  loading: () => ({ task: TASK, task_source: 'prompt', now_source: 'title', now_status: { state: 'pending' } }),
  first: (at) => ({ task: TASK, task_source: 'llm', task_at: at, now: FIRST, now_source: 'llm', now_at: at }),
  refresh: (at) => ({ task: TASK, task_source: 'llm', task_at: at, now: FIRST, now_source: 'llm', now_at: at, now_status: { state: 'pending' } }),
  second: (at) => ({ task: TASK, task_source: 'llm', task_at: at, now: SECOND, now_source: 'llm', now_at: at }),
};

/** The row states the board draws (`data-display`), and its two UI themes. */
const DISPLAYS = ['working', 'needs_you', 'waiting', 'done', 'idle', 'asleep'];
const THEMES = ['quiet', 'ubuntu'];

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
    const { now: _n, now_source: _s, now_at: _a, now_status: _st, task: _t, task_source: _ts, task_at: _ta, task_status: _tst, ...rest } = w.digest ?? {};
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

/**
 * Every row's box, and Turnip's lines' and metadata slots' (rounded to the pixel); its lines' text slots' left edge and
 * width (the flap row is shorter than the text that replaces it, inside the line's kept height).
 */
async function boxes(page: Page): Promise<Record<string, number[]>> {
  return page.evaluate(() => {
    const out: Record<string, number[]> = {};
    const box = (e: Element | null) => {
      const r = e?.getBoundingClientRect();
      return r ? [r.x, r.y, r.width, r.height].map((n) => Math.round(n)) : [];
    };
    const slot = (e: Element | null) => box(e).filter((_, i) => i === 0 || i === 2);
    document.querySelectorAll<HTMLElement>('.ov-row').forEach((r) => (out[r.dataset.key ?? ''] = box(r)));
    const t = [...document.querySelectorAll('.ov-row')].find((r) => r.textContent?.includes('Turnip')) ?? null;
    out.now = box(t?.querySelector('.ov-now') ?? null);
    out.nowText = slot(t?.querySelector('.ov-now > .ov-text') ?? null); // the flap row while loading, the text after
    out.nowMeta = box(t?.querySelector('.ov-now > .ov-ai-meta') ?? null);
    out.task = box(t?.querySelector('.ov-task') ?? null);
    out.taskText = slot(t?.querySelector('.ov-task > .ov-text') ?? null);
    out.taskMeta = box(t?.querySelector('.ov-task > .ov-ai-meta') ?? null);
    return out;
  });
}

/**
 * Turnip's refreshing now text as composed in the browser, for each row state and theme: its colour (its alpha and every
 * opacity over it folded in) over the row's ground, the board's ink and the hover row's; and the settled line's colour,
 * to see it is a step back. Ratios rounded to 0.01.
 */
async function refreshContrast(page: Page): Promise<{ at: string; refresh: number[]; settled: number[] }[]> {
  return page.evaluate(
    ({ displays, themes }) => {
      const row = [...document.querySelectorAll<HTMLElement>('.ov-row')].find((r) => r.textContent?.includes('Turnip'))!;
      const line = row.querySelector<HTMLElement>('.ov-now')!;
      const text = line.querySelector<HTMLElement>('.ov-now-text')!;
      const root = document.documentElement;
      const theme0 = root.getAttribute('data-ui-theme');
      const display0 = row.dataset.display ?? '';
      const probe = document.createElement('i');
      row.append(probe);
      const rgba = (c: string): number[] => {
        probe.style.color = c;
        const [r = 0, g = 0, b = 0, a = 1] = (getComputedStyle(probe).color.match(/[\d.]+/g) ?? []).map(Number);
        return [r, g, b, a];
      };
      const lum = ([r, g, b]: number[]) =>
        [r, g, b].map((v) => (v! / 255 <= 0.03928 ? v! / 255 / 12.92 : ((v! / 255 + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i]!, 0);
      const ratio = (fg: number[], bg: number[]) => {
        const [x, y] = [lum(fg), lum(bg)].sort((a, b) => b - a);
        return Math.round(((x! + 0.05) / (y! + 0.05)) * 100) / 100;
      };
      /** `el`'s colour composed over `bg`: its alpha times every opacity from it up to the board. */
      const over = (el: HTMLElement, bg: number[]) => {
        const [r, g, b, a] = rgba(getComputedStyle(el).color);
        let k = a!;
        for (let e: HTMLElement | null = el; e && !e.classList.contains('ov'); e = e.parentElement) k *= Number(getComputedStyle(e).opacity);
        return [r, g, b].map((v, i) => v! * k + bg[i]! * (1 - k));
      };
      const ground = () => {
        for (let e: HTMLElement | null = row; e; e = e.parentElement) {
          const c = rgba(getComputedStyle(e).backgroundColor);
          if (c[3]! > 0) return c;
        }
        return [0, 0, 0, 1];
      };
      text.style.transition = 'none';
      const out: { at: string; refresh: number[]; settled: number[] }[] = [];
      for (const theme of themes) {
        root.setAttribute('data-ui-theme', theme);
        for (const d of displays) {
          row.dataset.display = d;
          const bgs = [ground(), rgba(getComputedStyle(row).getPropertyValue('--ov-ink-2'))];
          out.push({ at: `${theme} ${d}`, refresh: bgs.map((bg) => ratio(over(text, bg), bg)), settled: bgs.map((bg) => ratio(over(line, bg), bg)) });
        }
      }
      if (theme0 === null) root.removeAttribute('data-ui-theme');
      else root.setAttribute('data-ui-theme', theme0);
      row.dataset.display = display0;
      text.style.transition = '';
      probe.remove();
      return out;
    },
    { displays: DISPLAYS, themes: THEMES },
  );
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
  // Its dimming keeps the text AA (4.5:1) on the row's ground and the hover row, in every row state and both themes, and
  // is a step back from the settled line's colour (never brighter; dimmer where the settled one has the room).
  const composed = await refreshContrast(page);
  expect(composed).toHaveLength(DISPLAYS.length * THEMES.length);
  for (const c of composed) {
    for (const v of c.refresh) expect(v, `${c.at}: ${c.refresh.join(' / ')}`).toBeGreaterThanOrEqual(4.5);
    c.refresh.forEach((v, i) => expect(v, `${c.at} against its settled line`).toBeLessThanOrEqual(c.settled[i]!));
  }
  expect(composed.filter((c) => c.refresh[0]! < c.settled[0]!).map((c) => c.at)).toEqual(composed.map((c) => c.at));
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
