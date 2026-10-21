import { expect, test, type Locator, type Page } from '@playwright/test';
import { frames, openGame, openMenu, settingsSection, shot, watchErrors } from './game';

// #140: Auto, against the fixture bridge (`simcodexprofiles=2`, tools/fixture-codex-profiles.ts: it takes Auto, has
// one rule, github.com/acme/* → work, that no fixture folder matches, and codex may be used for anything; a folder's
// origin there is JeffreyVdb/<its name>). The hire dialog's Auto chip (first, picked for a new Codex hire, its hint; a
// hire sends "auto" and the toast says the pick and why), and Settings → Codex profiles: "May be used for anything" and
// the Auto rules (add, move, remove, a refusal under its row, saved whole), then a hire that a new rule decides. At
// 390 × 844 and desktop width, in both UI themes, Quiet and Ubuntu (the game's UI has no light theme).

const SIM = 'play=none&sim=1&simms=150&simusage=0';
const SIZES = [
  { name: '390', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;
const UBUNTU = { 'h3d.theme.ui': 'ubuntu', 'h3d.theme.transcript': 'ubuntu', 'h3d.theme.terminal': 'ubuntu' };
const THEMES = ['quiet', 'ubuntu'] as const;
type Theme = (typeof THEMES)[number];

const hireDlg = (page: Page) => page.locator('dialog.desk-dlg--hire');
const chip = (page: Page, key: string) => hireDlg(page).locator(`label:has(> [data-key="${key}"])`);

async function openHire(page: Page, desk: number): Promise<void> {
  await page.evaluate((d) => window.__h3d.openHire(d), desk);
  await expect.poll(async () => {
    const d = await page.evaluate(() => window.__h3d.dialog());
    return d?.kind === 'hire' ? d.state : null;
  }, { timeout: 15_000 }).toBe('ready');
}

async function boot(page: Page, theme: Theme): Promise<void> {
  if (theme === 'ubuntu') await page.addInitScript((kv) => Object.entries(kv).forEach(([k, v]) => localStorage.setItem(k, v)), UBUNTU);
  await page.addInitScript(() => {
    try {
      localStorage.setItem('h3d.hire.goto', 'off');
    } catch {
      /* blocked */
    }
  });
  await openGame(page, 'demo-m5', '', `${SIM}&simcodexprofiles=2`);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 2);
  if (theme === 'ubuntu') await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'ubuntu');
}

/** Hires a Codex worker at `desk` on what the dialog picks, and returns the toast's text once the hire is acked. */
async function hireCodex(page: Page, desk: number): Promise<{ args: Record<string, unknown>; toast: string }> {
  const before = (await page.evaluate(() => window.__h3d.sent())).filter((c) => c.t === 'worker.hire').length;
  await openHire(page, desk);
  await chip(page, 'harness:codex').click();
  await expect(hireDlg(page).locator('[data-key="codex-profile:auto"]')).toBeChecked();
  await hireDlg(page).locator('[data-key="hire"]').click();
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.sent())).filter((c) => c.t === 'worker.hire').length).toBe(before + 1);
  const args = (await page.evaluate(() => window.__h3d.sent())).filter((c) => c.t === 'worker.hire').at(-1)!.args as Record<string, unknown>;
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.toastState()))?.text ?? '', { timeout: 15_000 }).toMatch(/^Hired /);
  return { args, toast: (await page.evaluate(() => window.__h3d.toastState()))!.text };
}

/** `el` is on screen, inside the viewport's width, and nothing scrolls sideways. */
async function fits(page: Page, el: Locator, width: number): Promise<void> {
  await el.scrollIntoViewIfNeeded();
  await expect(el).toBeInViewport();
  const box = await el.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= width + 0.5).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
}

for (const theme of THEMES)
test(`the hire dialog’s Auto: first, picked for a new Codex hire, sends "auto"; the toast says the pick (${theme})`, async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await boot(page, theme);
  await openHire(page, 5);
  await chip(page, 'harness:codex').click();
  const field = hireDlg(page).locator('[data-pick="codex-profile"]');
  await expect(field.locator('.dd-chip')).toHaveText(['Auto', 'codex', 'work', 'sparenot signed in']);
  await expect(field.locator('[data-key="codex-profile:auto"]')).toBeChecked();
  const hint = field.locator('[data-hook="profile-auto"]');
  await expect(hint).toContainText('The bridge picks at hire');
  for (const size of SIZES) {
    await page.setViewportSize(size);
    await fits(page, field, size.width);
    const box = await hint.boundingBox();
    expect(box && box.height).toBeLessThan(80); // a few lines, not a word per line
    await shot(page, `h140-hire-auto-${size.name}-${theme}`);
  }
  // Picking a profile by hand drops the hint; back to Auto for the hire.
  await chip(page, 'codex-profile:work').click();
  await expect(hint).toHaveCount(0);
  await chip(page, 'codex-profile:auto').click();
  await hireDlg(page).locator('[data-key="hire"]').click();
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.sent())).find((c) => c.t === 'worker.hire')?.args ?? null).toMatchObject({
    harness: 'codex',
    codex_profile: 'auto',
  });
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.toastState()))?.text ?? '', { timeout: 15_000 }).toContain(
    'Account: codex (the only profile that may be used for anything).',
  );
  clean();
});

for (const theme of THEMES)
test(`Settings: “May be used for anything” and the Auto rules; a rule then decides a hire (${theme})`, async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  await boot(page, theme);
  await openMenu(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const panel = await settingsSection(page, 'codex-profiles');
  const anything = (key: string) => panel.locator(`[data-key="anything:${key}"]`);
  await expect(anything('codex')).toBeChecked();
  await expect(anything('work')).not.toBeChecked();
  const rules = panel.locator('.settings-cp-auto');
  await expect(rules.locator('.settings-role-title')).toHaveText('Auto rules');
  const row = rules.locator('.settings-cp-rule');
  await expect(row).toHaveCount(1);
  await expect(rules.locator('[data-key="rule-match:0"]')).toHaveValue('github.com/acme/*');
  await expect(rules.locator('[data-key="rule-profile:0"]')).toHaveValue('work');

  // A match the editor can tell is wrong is said under its row; nothing is sent.
  await rules.locator('[data-key="rule-add"]').click();
  await expect(rules.locator('[data-key="rule-match:1"]')).toBeFocused();
  await rules.locator('[data-key="rule-match:1"]').fill('JeffreyVdb/*');
  await rules.locator('[data-key="rule-profile:1"]').selectOption('work');
  await rules.locator('[data-key="rules-save"]').click();
  const error = row.nth(1).locator('.settings-field-error');
  await expect(error).toHaveText('Use github.com/<owner>/* or github.com/<owner>/<repo>, or a folder starting with / or ~/.');
  for (const size of SIZES) {
    await page.setViewportSize(size);
    await fits(page, rules, size.width);
    for (const part of [rules.locator('[data-key="rule-match:1"]'), rules.locator('[data-key="rule-profile:1"]'), rules.locator('[data-key="rule-remove:1"]'), error])
      await fits(page, part, size.width);
    await shot(page, `h140-rules-error-${size.name}-${theme}`);
  }
  expect((await page.evaluate(() => window.__h3d.sent())).filter((c) => c.t === 'codex_profiles.set')).toHaveLength(0);

  // Fixed, moved first, saved whole in one change.
  await rules.locator('[data-key="rule-match:1"]').fill('github.com/JeffreyVdb/*');
  await rules.locator('[data-key="rule-up:1"]').click();
  await expect(rules.locator('[data-key="rule-match:0"]')).toHaveValue('github.com/JeffreyVdb/*');
  await rules.locator('[data-key="rules-save"]').click();
  await expect(rules.locator('.settings-status')).toHaveText('Saved 2 rules.');
  const sets = (await page.evaluate(() => window.__h3d.sent())).filter((c) => c.t === 'codex_profiles.set');
  expect(sets.map((c) => c.args)).toEqual([{ rules: [{ match: 'github.com/JeffreyVdb/*', profile: 'work' }, { match: 'github.com/acme/*', profile: 'work' }] }]);
  await expect(rules.locator('[data-key="rules-save"]')).toBeHidden();
  for (const size of SIZES) {
    await page.setViewportSize(size);
    await fits(page, rules, size.width);
    await fits(page, anything('work'), size.width);
    await shot(page, `h140-rules-${size.name}-${theme}`);
  }

  // The flag is one change, sent at once.
  await anything('work').check();
  await expect(panel.locator('.settings-cp .settings-status').first()).toHaveText('Auto may hire on work when no rule matches.');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();

  // The rule decides: the hire lands on work, and the toast says why.
  await page.setViewportSize(SIZES[1]);
  const { args, toast } = await hireCodex(page, 5);
  expect(args).toMatchObject({ harness: 'codex', codex_profile: 'auto' });
  expect(toast).toContain('Account: work (rule JeffreyVdb/*).');
  clean();
});
