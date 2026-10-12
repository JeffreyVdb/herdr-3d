import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, openMenu, shot, watchErrors } from './game';
import { board, enter, wall } from './m7';

// #248 on demo-m6 with the simulating fixture server: "Resolve conflicts with a worker" on the conflicting PR (#35),
// the Hire dialog's task levels (seeded into localStorage as a browser that saved them), the switch to the usual
// pickers, and what `worker.hire` carries. Levels never reach the bridge; the hire is a plain one with a worktree.

const SIM = 'play=none&sim=1&simms=150&simusage=0';
const EXTRA = '&open=none';
const HERDR = 'JeffreyVdb/herdr-3d';
const LEVELS = {
  very_trivial: { harness: 'codex', model: 'gpt-6-luna', effort: 'low' },
  trivial: { harness: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
  slightly_complex: { harness: 'codex', model: 'gpt-6-sol', effort: 'ultra' },
};

type Item = NonNullable<NonNullable<Awaited<ReturnType<Window['__h3d']['board']>>>['item']>;
interface HireDialogView {
  kind: string;
  state: string;
  desk: number;
  form: { prompt: string; harness: string; model: string; effort: string; worktree: boolean };
  level?: { mode: string; picked: string | null; chips: Array<{ id: string; text: string; problem: string | null }> };
}

const item = async (page: Page): Promise<Item> => ((await board(page))?.item ?? ({} as Item)) as Item;
const dialog = async (page: Page) => (await page.evaluate(() => window.__h3d.dialog())) as HireDialogView | null;
const sentOf = async (page: Page, t: string) => (await page.evaluate(() => window.__h3d.sent())).filter((c) => c.t === t);
const modal = (page: Page) => page.locator('dialog.desk-dlg--item');
const act = (page: Page, key: string) => modal(page).locator(`[data-key="${key}"]`);
const hire = (page: Page) => page.locator('dialog.desk-dlg--hire');

async function openItem(page: Page, id: string): Promise<Item> {
  await page.evaluate((i) => window.__h3d.openBoardItem('prs', i), id);
  await expect.poll(async () => (await item(page)).state, { message: `${id} loaded`, timeout: 10_000 }).toBe('ready');
  return item(page);
}

/** Seeds the levels (and Settings → Display's worktree default) before the game reads them. */
async function seed(page: Page, levels: object | null, worktree: 'on' | 'off' = 'on'): Promise<void> {
  await page.addInitScript(
    ([l, w]) => {
      if (l) localStorage.setItem('h3d.hire.taskLevels', JSON.stringify(l));
      if (w === 'off') localStorage.setItem('h3d.hire.worktree', 'off');
    },
    [levels, worktree] as const,
  );
}

async function openPrs(page: Page): Promise<void> {
  await openGame(page, 'demo-m6', EXTRA, SIM);
  await enter(page, 'herdr-3d');
  await expect.poll(async () => (await wall(page))?.prs.length).toBe(4);
}

async function resolve(page: Page): Promise<HireDialogView> {
  await act(page, 'resolve').click();
  await expect.poll(async () => (await dialog(page))?.kind).toBe('hire');
  await expect.poll(async () => (await dialog(page))?.state).toBe('ready');
  return (await dialog(page)) as HireDialogView;
}

test('Resolve conflicts: only on a conflicting PR; the dialog opens on the Trivial level and hires it with a worktree', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  // Settings → Display says no worktree: a resolve hire takes one anyway.
  await seed(page, LEVELS, 'off');
  await openPrs(page);

  // A mergeable PR: Review is the primary, no Resolve, no Comment button.
  const ok = await openItem(page, `${HERDR}#34`);
  expect(ok.actions).toEqual(['review', 'merge-method', 'merge', 'open']);
  await expect(act(page, 'review')).toHaveClass(/btn--primary/);

  // The conflicting one: Resolve is the one primary, Review quiet, Merge off with its reason.
  const conflict = await openItem(page, `${HERDR}#35`);
  expect(conflict.actions).toEqual(['resolve', 'review', 'merge-method', 'merge', 'open']);
  await expect(modal(page).locator('.bd-actions .btn--primary')).toHaveCount(1);
  await expect(act(page, 'resolve')).toHaveClass(/btn--primary/);
  await expect(act(page, 'review')).toHaveClass(/btn--quiet/);
  await expect(act(page, 'merge')).toHaveAttribute('aria-disabled', 'true');
  await expect(act(page, 'merge')).toHaveAttribute('title', /merge conflicts/);
  await shot(page, 'h248-pr-conflict');

  // The method picked in the select goes into the prompt.
  await act(page, 'merge-method').selectOption('rebase');
  const d = await resolve(page);
  expect(d.form.prompt).toContain(`https://github.com/${HERDR}/pull/35`);
  expect(d.form.prompt).toContain('gh pr checkout 35 --detach');
  expect(d.form.prompt).toContain('git push origin HEAD:feat/lounge');
  expect(d.form.prompt).toContain('gh pr merge 35 --rebase');
  expect(d.level).toMatchObject({ mode: 'levels', picked: 'trivial' });
  expect(d.level?.chips.map((c) => c.id)).toEqual(['very_trivial', 'trivial', 'slightly_complex']);
  expect(d.form).toMatchObject({ harness: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', worktree: true });
  // The levels instead of the pickers.
  await expect(hire(page).locator('[data-pick="level"] label')).toHaveCount(3);
  await expect(hire(page).locator('[data-key="level:trivial"]')).toBeChecked();
  await expect(hire(page).locator('[data-pick="harness"]')).toHaveCount(0);
  await expect(hire(page).locator('[data-pick="level"]')).toContainText('Trivial — ');
  await shot(page, 'h248-hire-levels');

  // "Choose a more complex model…": the usual pickers, holding the level's choice.
  await hire(page).locator('[data-key="levels-more"]').click();
  await expect(hire(page).locator('[data-pick="level"]')).toHaveCount(0);
  await expect(hire(page).locator('[data-key="harness:claude"]')).toBeChecked();
  await expect(hire(page).locator('[data-key="model:claude-sonnet-5-5"]')).toBeChecked();
  await expect(hire(page).locator('[data-key="effort:medium"]')).toBeChecked();
  expect((await dialog(page))?.level?.mode).toBe('more');
  await shot(page, 'h248-hire-more');
  await hire(page).locator('[data-key="levels-back"]').click();
  await expect(hire(page).locator('[data-key="level:trivial"]')).toBeChecked();

  // Hire: a plain worker.hire with the level's harness, model and effort, and a worktree.
  await hire(page).locator('[data-key="hire"]').click();
  await expect.poll(async () => (await sentOf(page, 'worker.hire')).length).toBe(1);
  const args = (await sentOf(page, 'worker.hire'))[0]?.args as Record<string, unknown>;
  expect(args).toMatchObject({ session: 'herdr-3d', harness: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', worktree: true });
  expect(String(args.prompt)).toContain('gh pr merge 35 --rebase');
  expect(Object.keys(args).filter((k) => k.includes('level'))).toEqual([]);
  clean();
});

test('Resolve conflicts with no level set: the usual pickers, and no “Choose a more complex model…”', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openPrs(page);
  await openItem(page, `${HERDR}#35`);
  const d = await resolve(page);
  expect(d.level?.mode).toBe('none');
  await expect(hire(page).locator('[data-pick="harness"]')).toHaveCount(1);
  await expect(hire(page).locator('[data-pick="level"]')).toHaveCount(0);
  await expect(hire(page).locator('[data-key="levels-more"]')).toHaveCount(0);
  await expect(hire(page).locator('[data-hook="levels-off"]')).toHaveCount(0);
  clean();
});

test('the PR footer at 390 px: the groups wrap whole, nothing scrolls sideways', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 390, height: 640 });
  await openPrs(page);
  await openItem(page, `${HERDR}#35`);
  await frames(page, 2);
  const layout = await modal(page)
    .locator('.bd-actions')
    .evaluate((bar) => ({
      overflow: bar.scrollWidth - bar.clientWidth,
      groups: [...bar.querySelectorAll<HTMLElement>(':scope > .bd-group')].map((g) => {
        const tops = [...g.children].map((c) => Math.round(c.getBoundingClientRect().top));
        const r = g.getBoundingClientRect();
        return { tops, left: Math.round(r.left), right: Math.round(r.right) };
      }),
      bar: { left: Math.round(bar.getBoundingClientRect().left), right: Math.round(bar.getBoundingClientRect().right) },
    }));
  await shot(page, 'h248-pr-footer-390');
  await test.info().attach('layout', { body: JSON.stringify(layout, null, 2), contentType: 'application/json' });
  expect(layout.overflow).toBeLessThanOrEqual(0);
  expect(layout.groups).toHaveLength(3);
  // The merge group (select and Merge…) and Open each sit on one line (within a pixel or two of alignment); the workers'
  // two buttons only wrap inside their group when it alone is wider than the bar, so it then holds a line of its own.
  const oneLine = (tops: number[]) => Math.max(...tops) - Math.min(...tops) <= 3;
  for (const g of layout.groups.slice(1)) expect(oneLine(g.tops), JSON.stringify(g)).toBe(true);
  const workers = layout.groups[0]!;
  if (!oneLine(workers.tops)) expect(workers.right - workers.left).toBeGreaterThanOrEqual(layout.bar.right - layout.bar.left - 1);
  // At 390 px the merge group starts on a line of its own, below the workers' group: no button of one beside the other's.
  expect(Math.min(...layout.groups[1]!.tops)).toBeGreaterThan(Math.max(...workers.tops));
  // Every group stays inside the bar.
  for (const g of layout.groups) {
    expect(g.left).toBeGreaterThanOrEqual(layout.bar.left - 1);
    expect(g.right).toBeLessThanOrEqual(layout.bar.right + 1);
  }
  clean();
});

test('Settings → Task levels: a level set there is what Resolve offers; a hidden model shows as stale', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await seed(page, { slightly_complex: { harness: 'claude', model: 'claude-gone-1', effort: 'high' } });
  await openPrs(page);
  await openMenu(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const section = page.locator('[data-section="task-levels"]');
  await section.scrollIntoViewIfNeeded();
  const row = (id: string) => section.locator(`.tl-level[data-level="${id}"]`);
  await expect(row('trivial').locator('.settings-badge')).toHaveText('Not set');
  await row('trivial').locator('label:has([data-key="tl-trivial-harness:codex"])').click();
  await row('trivial').locator('label:has([data-key="tl-trivial-model:gpt-6-luna"])').click();
  await row('trivial').locator('label:has([data-key="tl-trivial-effort:low"])').click();
  await expect(row('trivial').locator('.settings-badge')).toHaveText('Set');
  // The stored level whose model the bridge does not list: its slug and why.
  await expect(row('slightly_complex').locator('.tl-stale code')).toHaveText('claude-gone-1');
  await expect(row('slightly_complex').locator('.settings-badge')).toHaveText('Can’t be used');
  await section.screenshot({ path: test.info().outputPath('task-levels.png') });
  await shot(page, 'h248-settings-task-levels');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('h3d.hire.taskLevels') ?? '{}'))).toEqual({
    slightly_complex: { harness: 'claude', model: 'claude-gone-1', effort: 'high' },
    trivial: { harness: 'codex', model: 'gpt-6-luna', effort: 'low' },
  });
  await page.keyboard.press('Escape');

  await openItem(page, `${HERDR}#35`);
  const d = await resolve(page);
  expect(d.level?.picked).toBe('trivial');
  expect(d.form).toMatchObject({ harness: 'codex', model: 'gpt-6-luna', effort: 'low' });
  const stale = d.level?.chips.find((c) => c.id === 'slightly_complex');
  expect(stale?.problem).toMatch(/does not offer claude-gone-1/);
  await expect(hire(page).locator('[data-key="level:slightly_complex"]')).toBeDisabled();
  clean();
});
