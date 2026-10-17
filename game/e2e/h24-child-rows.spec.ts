import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, shot, watchErrors } from './game';

// #24 (phase 3 of #20): native child agents on the board, against the fixture bridge playing the recorded child frames
// (game/fixtures/children-*.jsonl, from internal/childagents/testdata): children-nested is one worker (Nibble, on the
// office floor) over three generations of Codex children (Ada → Bell → Curie); children-many one Claude worker over
// thirty children in every state, nested four deep, one of them unresolved. No transcript is ever open: the board
// follows the child events alone.

const info = (page: Page) => page.evaluate(() => window.__h3d.overview());
const pageInfo = async (page: Page) => (await info(page))?.page;
const rows = async (page: Page) => (await pageInfo(page))?.rows ?? [];

async function onOffice(page: Page, fixture: string, wsQuery: string): Promise<void> {
  await openGame(page, fixture, '', wsQuery);
  await page.evaluate(() => window.__h3d.enterFloor('office'));
  await frames(page, 3);
}

async function openPage(page: Page): Promise<void> {
  await page.keyboard.press('KeyO');
  await expect.poll(async () => (await pageInfo(page))?.open).toBe(true);
  await expect(page.locator('.ov')).not.toHaveClass(/ov--enter/, { timeout: 5000 });
}

/** In the lounge, a few metres off the west wall, looking at the overview screen (as m118's). */
async function faceScreen(page: Page): Promise<void> {
  await page.evaluate(() => {
    const b = window.__h3d.layout('office')?.props.find((p) => p.id === 'screen.overview')?.box;
    if (!b) throw new Error('no overview screen');
    window.__h3d.setPose({ x: 4.5, z: (b.min[2] + b.max[2]) / 2, yaw: Math.PI / 2, pitch: 0.35 });
  });
  await frames(page, 4);
}

test('three levels nest on the page and the wall; keys move, fold and open at any depth; Enter seats at the owning worker', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await onOffice(page, 'children-nested', 'play=all');
  // The wall: the worker and its three generations (Curie completed, its parent Bell idle: nothing folded).
  await expect.poll(async () => (await info(page))?.wall).toMatchObject({ lit: true, rows: 4 });
  await openPage(page);
  const r = await rows(page);
  expect(r.map((x) => [x.kind, x.depth])).toEqual([
    ['worker', 0],
    ['child', 1],
    ['child', 2],
    ['child', 3],
  ]);
  const worker = r[0]?.key ?? '';
  const [ada, bell, curie] = r.slice(1).map((x) => x.key);
  expect(r[1]?.text).toContain('Ada');
  expect(r[2]?.text).toContain('Bell');
  expect(r[3]?.text).toContain('Curie');
  expect(r[3]?.text).toContain('completed in');
  const row = (k: string | undefined) => page.locator(`.ov-row[data-key="${k}"]`);
  await expect(row(curie)).toHaveAttribute('aria-level', '4');
  await expect(row(bell)).toHaveAttribute('aria-expanded', 'true');
  await expect(row(ada).locator('.ov-mark title')).toHaveText('Codex');
  await shot(page, 'h24-nested-page');

  // ↓ to the deepest, ← to its parent, ← folds it, → opens it, Shift+← folds every group, Shift+→ opens them.
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await pageInfo(page))?.focused).toBe(curie);
  await expect(row(curie)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await pageInfo(page))?.focused).toBe(bell);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await rows(page)).length).toBe(3);
  await expect(row(bell)).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await rows(page)).length).toBe(4);
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(async () => (await rows(page)).map((x) => x.key)).toEqual([worker]);
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => (await rows(page)).length).toBe(4);

  // Enter on a child: until #26 it seats at the worker that owns it, as the worker's own row does (the fixture's worker
  // names no harness, so its laptop opens on its terminal rather than a conversation).
  await page.keyboard.press('End');
  await expect.poll(async () => (await pageInfo(page))?.focused).toBe(curie);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await pageInfo(page))?.open).toBe(false);
  await expect.poll(() => page.evaluate(() => window.__h3d.seated()), { timeout: 20_000 }).toBe(worker);
  clean();
});

test('the board follows child events with no transcript open: rows appear on the page and the wall as they are played', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await onOffice(page, 'children-nested', 'play=700');
  await openPage(page);
  // The snapshot has none; the five events (three new children, two state changes) arrive one by one.
  await expect.poll(async () => (await rows(page)).length, { timeout: 20_000 }).toBe(4);
  await expect.poll(async () => (await rows(page))[2]?.text ?? '', { timeout: 20_000 }).toContain('idle');
  await expect.poll(async () => (await rows(page))[3]?.text ?? '').toContain('completed');
  expect(await page.evaluate(() => window.__h3d.seated())).toBeNull();
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await info(page))?.wall).toMatchObject({ lit: true, rows: 4 });
  clean();
});

test('a long tree stays usable: thirty children scroll on the page and the wall, the unresolved one says so, finished groups fold, active only trims', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await onOffice(page, 'children-many', 'play=all');
  // The wall: 1 worker + 30 children, the finished reviewer's two folded under it: one-line rows, scrolling.
  await expect.poll(async () => (await info(page))?.wall).toMatchObject({ lit: true, rows: 29, compact: true, scrolling: true });
  await faceScreen(page);
  await shot(page, 'h24-many-wall');
  await openPage(page);
  expect(await rows(page)).toHaveLength(29);
  expect((await pageInfo(page))?.hidden).toBe('');
  await expect(page.locator('.ov-where')).toContainText('1 worker');
  const orphan = page.locator('.ov-row--child', { hasText: 'Plan the filter for subagents' });
  await expect(orphan.locator('.ov-orphan')).toHaveText('parent unknown');
  await expect(orphan).toHaveAttribute('aria-level', '2');
  // Four deep, still readable: its name has room.
  const deep = page.locator('.ov-row--child[aria-level="5"]');
  await expect(deep).toHaveCount(1);
  expect((await deep.locator('.ov-name').boundingBox())?.width ?? 0).toBeGreaterThan(40);
  await shot(page, 'h24-many-page');
  // A phone's width: the rows stack (name and state over the task), the deep ones still have room for their names.
  await page.setViewportSize({ width: 390, height: 844 });
  expect((await deep.locator('.ov-name').boundingBox())?.width ?? 0).toBeGreaterThan(40);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shot(page, 'h24-many-page-390');
  await page.setViewportSize({ width: 1280, height: 720 });

  // End reaches the last row, in view on the scrolled board.
  await page.keyboard.press('End');
  const last = (await rows(page)).at(-1)?.key;
  await expect.poll(async () => (await pageInfo(page))?.focused).toBe(last);
  await expect(page.locator(`.ov-row[data-key="${last}"]`)).toBeInViewport();
  // The finished reviewer's children open on its chevron.
  const review = page.locator('.ov-row--child', { hasText: 'Review the child row design' });
  await expect(review).toHaveAttribute('aria-expanded', 'false');
  await review.locator('[data-fold]').click();
  await expect.poll(async () => (await rows(page)).length).toBe(31);
  // Active only: the six running children and their worker; the rest said as subagents, not workers.
  await page.keyboard.press('KeyF');
  await expect.poll(async () => (await rows(page)).length).toBe(7);
  expect((await pageInfo(page))?.hidden).toBe('24 subagents hidden');
  clean();
});
