import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, openMenu, settingsSection, shot, watchErrors } from './game';
import { board, enter, wall } from './m7';

// #248 on demo-m6 with the simulating fixture server: "Resolve conflicts with a worker" on the conflicting PR (#35),
// the Hire dialog's task levels (seeded into localStorage as a browser that saved them), the switch to the usual
// pickers, and what `worker.hire` carries. Levels never reach the bridge; the hire is a plain one with a worktree.
// #40: the levels are the player's own (fixed opaque ids here so the hooks are stable); #248's stored value migrates.

const SIM = 'play=none&sim=1&simms=150&simusage=0';
const EXTRA = '&open=none';
const HERDR = 'JeffreyVdb/herdr-3d';
/** #248's stored value: three slots by fixed id. */
const LEGACY = {
  very_trivial: { harness: 'codex', model: 'gpt-6-luna', effort: 'low' },
  trivial: { harness: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
  slightly_complex: { harness: 'codex', model: 'gpt-6-sol', effort: 'ultra' },
};
/** #40: the player's own levels, in their order, the middle one the default. */
const LEVELS = {
  v: 2,
  levels: [
    { id: 'tiny', name: 'Typo fix', ...LEGACY.very_trivial },
    { id: 'quick', name: 'Quick fix', ...LEGACY.trivial },
    { id: 'merge', name: 'Merge conflicts', ...LEGACY.slightly_complex },
  ],
  default: 'quick',
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

/** Seeds the levels (and Settings → Display's worktree default) before the game reads them; once, so a reload keeps what was saved. */
async function seed(page: Page, levels: object | null, worktree: 'on' | 'off' = 'on'): Promise<void> {
  await page.addInitScript(
    ([l, w]) => {
      if (sessionStorage.getItem('h248.seeded')) return;
      sessionStorage.setItem('h248.seeded', '1');
      if (l) localStorage.setItem('h3d.hire.taskLevels', JSON.stringify(l));
      if (w === 'off') localStorage.setItem('h3d.hire.worktree', 'off');
    },
    [levels, worktree] as const,
  );
}

/** Stands at a desk seat of a floor (to be the nearest to it). */
async function standAt(page: Page, session: string, desk: number, back = 0.7): Promise<void> {
  await page.evaluate(
    ([s, d, b]) => {
      const slot = window.__h3d.layout(s as string)?.slots[d as number];
      if (!slot) throw new Error('no desk');
      const fx = Math.sin(slot.yaw);
      const fz = Math.cos(slot.yaw);
      window.__h3d.setPose({ x: slot.seat.x - fx * (b as number), z: slot.seat.z - fz * (b as number), yaw: Math.atan2(-fx, -fz), pitch: -0.2 });
    },
    [session, desk, back] as const,
  );
  await frames(page, 3);
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

test('Resolve conflicts: only on a conflicting PR; the dialog opens on the default level and hires it with a worktree', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  // Settings → Display says no worktree: a resolve hire takes one anyway.
  await seed(page, LEVELS, 'off');
  await openPrs(page);
  // Like Review: the free desk nearest to where you stand.
  await standAt(page, 'herdr-3d', 12);

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
  expect(d.desk).toBe(12);
  expect(d.form.prompt).toContain(`https://github.com/${HERDR}/pull/35`);
  expect(d.form.prompt).toContain('gh pr checkout 35 --detach');
  expect(d.form.prompt).toContain('git push origin HEAD:feat/lounge');
  expect(d.form.prompt).toContain('gh pr merge 35 --rebase');
  expect(d.level).toMatchObject({ mode: 'levels', picked: 'quick' });
  expect(d.level?.chips.map((c) => c.id)).toEqual(['tiny', 'quick', 'merge']);
  expect(d.form).toMatchObject({ harness: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', worktree: true });
  // The levels instead of the pickers, by their names.
  await expect(hire(page).locator('[data-pick="level"] label')).toHaveCount(3);
  await expect(hire(page).locator('[data-key="level:quick"]')).toBeChecked();
  await expect(hire(page).locator('[data-pick="harness"]')).toHaveCount(0);
  await expect(hire(page).locator('[data-pick="level"] label').first()).toContainText('Typo fix — ');
  await expect(hire(page).locator('[data-pick="level"]')).toContainText('Quick fix — ');
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
  await expect(hire(page).locator('[data-key="level:quick"]')).toBeChecked();

  // Hire: a plain worker.hire with the level's harness, model and effort, and a worktree.
  await hire(page).locator('[data-key="hire"]').click();
  await expect.poll(async () => (await sentOf(page, 'worker.hire')).length).toBe(1);
  const args = (await sentOf(page, 'worker.hire'))[0]?.args as Record<string, unknown>;
  expect(args).toMatchObject({ floor: 'herdr-3d', harness: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', worktree: true });
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

for (const theme of ['quiet', 'ubuntu'] as const) {
  test(`the PR footer at 390 px in ${theme}: the groups wrap whole, nothing scrolls sideways`, async ({ page }) => {
    test.setTimeout(120_000);
    const clean = watchErrors(page);
    await page.setViewportSize({ width: 390, height: 640 });
    if (theme === 'ubuntu') await page.addInitScript(() => localStorage.setItem('h3d.theme.ui', 'ubuntu'));
    await openPrs(page);
    await page.evaluate(() => window.__h3d.themeLoaded());
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
    await shot(page, `h248-pr-footer-390-${theme}`);
    await test.info().attach('layout', { body: JSON.stringify(layout, null, 2), contentType: 'application/json' });
    expect(layout.overflow).toBeLessThanOrEqual(0);
    expect(layout.groups).toHaveLength(3);
    // Every group keeps its buttons on one line (within a pixel or two of alignment): the workers' (Resolve and Review,
    // their labels wrapping inside when narrow), the merge group (select and Merge…) and Open. Groups wrap whole.
    const oneLine = (tops: number[]) => Math.max(...tops) - Math.min(...tops) <= 3;
    for (const g of layout.groups) expect(oneLine(g.tops), JSON.stringify(g)).toBe(true);
    const workers = layout.groups[0]!;
    // At 390 px the merge group starts on a line of its own, below the workers' group: no button of one beside the other's.
    expect(Math.min(...layout.groups[1]!.tops)).toBeGreaterThan(Math.max(...workers.tops));
    // Every group stays inside the bar.
    for (const g of layout.groups) {
      expect(g.left).toBeGreaterThanOrEqual(layout.bar.left - 1);
      expect(g.right).toBeLessThanOrEqual(layout.bar.right + 1);
    }
    clean();
  });
}

test('#248’s saved levels migrate: named after their slots, in order, Trivial the default, and stored in the new shape', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await seed(page, LEGACY);
  await openPrs(page);
  await openItem(page, `${HERDR}#35`);
  const d = await resolve(page);
  const chips = d.level?.chips ?? [];
  expect(chips.map((c) => c.text.split(' — ')[0])).toEqual(['Very trivial', 'Trivial', 'Slightly complex']);
  expect(d.level?.picked).toBe(chips[1]?.id);
  expect(d.form).toMatchObject({ harness: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' });
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('h3d.hire.taskLevels') ?? 'null'));
  expect(saved).toEqual({
    v: 2,
    levels: [
      { id: chips[0]?.id, name: 'Very trivial', ...LEGACY.very_trivial },
      { id: chips[1]?.id, name: 'Trivial', ...LEGACY.trivial },
      { id: chips[2]?.id, name: 'Slightly complex', ...LEGACY.slightly_complex },
    ],
    default: chips[1]?.id,
  });
  // Opaque ids: never the old slot names.
  for (const c of chips) expect(['very_trivial', 'trivial', 'slightly_complex']).not.toContain(c.id);
  clean();
});

test('Settings → Task levels: a level added, named and set there is what Resolve offers; a gone model shows as stale', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await seed(page, { v: 2, levels: [{ id: 'old', name: 'Old one', harness: 'claude', model: 'claude-gone-1', effort: 'high' }], default: null });
  await openPrs(page);
  await openMenu(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  // #49: one section at a time: show Task levels.
  const section = await settingsSection(page, 'task-levels');
  // The stored level whose model the bridge does not list: its slug and why.
  const old = section.locator('.tl-level[data-level="old"]');
  await expect(old.locator('.tl-stale code')).toHaveText('claude-gone-1');
  await expect(old.locator('.settings-badge')).toHaveText('Can’t be used');

  await section.getByRole('button', { name: 'Add level' }).click();
  const row = section.locator('.tl-level').last();
  await expect(row.locator('.settings-badge')).toHaveText('Not set');
  await expect(row.locator('.tl-name')).toBeFocused();
  await page.keyboard.type('Quick fix');
  await page.keyboard.press('Enter');
  const id = (await row.getAttribute('data-level')) ?? '';
  await row.locator(`label:has([data-key="tl-${id}-harness:codex"])`).click();
  await row.locator(`label:has([data-key="tl-${id}-model:gpt-6-luna"])`).click();
  await row.locator(`label:has([data-key="tl-${id}-effort:low"])`).click();
  await expect(row.locator('.settings-badge')).toHaveText('Set');
  // Move it first and make it the default.
  await row.getByRole('button', { name: 'Move Quick fix up' }).click();
  await section.getByRole('radio', { name: 'Default level: Quick fix' }).click();
  await section.screenshot({ path: test.info().outputPath('task-levels.png') });
  await shot(page, 'h248-settings-task-levels');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('h3d.hire.taskLevels') ?? '{}'))).toEqual({
    v: 2,
    levels: [
      { id, name: 'Quick fix', harness: 'codex', model: 'gpt-6-luna', effort: 'low' },
      { id: 'old', name: 'Old one', harness: 'claude', model: 'claude-gone-1', effort: 'high' },
    ],
    default: id,
  });
  await page.keyboard.press('Escape');

  // A reload keeps the names, the order and the default.
  await page.reload();
  await page.waitForFunction(() => window.__h3d?.ready && window.__h3d.frames >= 3, undefined, { timeout: 60_000 });
  await enter(page, 'herdr-3d');
  await expect.poll(async () => (await wall(page))?.prs.length).toBe(4);
  await openItem(page, `${HERDR}#35`);
  const d = await resolve(page);
  expect(d.level?.picked).toBe(id);
  expect(d.level?.chips.map((c) => c.text.split(' — ')[0])).toEqual(['Quick fix', 'Old one']);
  expect(d.form).toMatchObject({ harness: 'codex', model: 'gpt-6-luna', effort: 'low' });
  const stale = d.level?.chips.find((c) => c.id === 'old');
  expect(stale?.problem).toMatch(/does not offer claude-gone-1/);
  await expect(hire(page).locator('[data-key="level:old"]')).toBeDisabled();
  clean();
});
