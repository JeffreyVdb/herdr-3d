import { expect, test, type Locator, type Page } from '@playwright/test';
import { frames, openGame, shot, watchErrors } from './game';

// #167: a Codex profile for a run's orchestrator and each Codex role of a team preset, against the fixture bridge
// (`simcodexprofiles=2`, tools/fixture-codex-profiles.ts and tools/fixture-start.ts: codex (the default), work, spare
// not signed in; runs take a profile). Start a run's Hire orchestrator tab shows the hire dialog's "Codex profile" chips
// for a Codex orchestrator only, and run.start carries the pick; the team preset editor shows them under each Codex role,
// the preset keeps the pick, and the run's prompt names that role's profile and home. At 390 × 844 and desktop width, in
// both UI themes, Quiet and Ubuntu (the game's UI has no light theme).

const SIM = 'play=none&sim=1&simms=150&simusage=0&simcodexprofiles=2';
const SIZES = [
  { name: '390', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;
const UBUNTU = { 'h3d.theme.ui': 'ubuntu', 'h3d.theme.transcript': 'ubuntu', 'h3d.theme.terminal': 'ubuntu' };
const THEMES = ['quiet', 'ubuntu'] as const;
type Theme = (typeof THEMES)[number];

const runDlg = (page: Page) => page.locator('dialog.desk-dlg--run');
const presetsDlg = (page: Page) => page.locator('dialog.desk-dlg--presets');
const chipIn = (scope: Locator, key: string) => scope.locator(`label:has(> [data-key="${key}"])`);

async function boot(page: Page, theme: Theme): Promise<void> {
  if (theme === 'ubuntu') await page.addInitScript((kv) => Object.entries(kv).forEach(([k, v]) => localStorage.setItem(k, v)), UBUNTU);
  await openGame(page, 'demo-m5', '', SIM);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 2);
  if (theme === 'ubuntu') await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'ubuntu');
}

async function openRun(page: Page): Promise<void> {
  await page.evaluate(() => window.__h3d.openStartRun({ floor: 'herdr-3d' }));
  await expect.poll(async () => {
    const d = await page.evaluate(() => window.__h3d.dialog());
    return d?.kind === 'start-run' ? d.state : null;
  }, { timeout: 15_000 }).toBe('ready');
}

async function ticket(page: Page, text: string): Promise<void> {
  await runDlg(page).locator('#run-ticket').fill(text);
  await expect.poll(async () => {
    const d = (await page.evaluate(() => window.__h3d.dialog())) as { kind?: string; preparing?: boolean; preview?: { text: string } } | null;
    return d?.kind === 'start-run' && !d.preparing ? d.preview?.text ?? '' : '';
  }, { timeout: 15_000 }).toContain(text);
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
  test(`Hire orchestrator: Codex profile chips for a Codex orchestrator only; run.start carries the pick (${theme})`, async ({ page }) => {
    test.setTimeout(120_000);
    const clean = watchErrors(page);
    await boot(page, theme);
    await openRun(page);
    const dlg = runDlg(page);
    const field = dlg.locator('[data-pick="orch-profile"]');
    // Build team's orchestrator is Claude: the dialog as before profiles.
    await expect(field).toHaveCount(0);
    await chipIn(dlg, 'orch-harness:codex').click();
    await expect(field.locator('.dd-chip')).toHaveText(['Auto', 'codex', 'work', 'sparenot signed in']);
    await expect(field.locator('[data-key="orch-profile:codex"]')).toBeChecked(); // a preset role with none: the default
    await expect(field.locator('[data-key="orch-profile:spare"]')).toBeDisabled();
    await chipIn(field, 'orch-profile:work').click();
    await expect(field.locator('[data-key="orch-profile:work"]')).toBeChecked();
    await ticket(page, 'Tidy the lobby');
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await fits(page, field, size.width);
      await shot(page, `h167-orch-profile-${size.name}-${theme}`);
    }
    await chipIn(dlg, 'orch-harness:claude').click();
    await expect(field).toHaveCount(0);
    await chipIn(dlg, 'orch-harness:codex').click();
    await expect(field.locator('[data-key="orch-profile:work"]')).toBeChecked(); // the pick stays the dialog's
    await dlg.locator('[data-key="start"]').click();
    await expect.poll(async () => (await page.evaluate(() => window.__h3d.sent())).find((c) => c.t === 'run.start')?.args ?? null).toMatchObject({
      orch: { harness: 'codex', codex_profile: 'work' },
    });
    await expect.poll(async () => (await page.evaluate(() => window.__h3d.toastState()))?.text ?? '', { timeout: 15_000 }).toContain('work has no hooks.json');
    clean();
  });

for (const theme of THEMES)
  test(`Team presets: a Codex role's profile, kept by the preset and named in the run's prompt (${theme})`, async ({ page }) => {
    test.setTimeout(120_000);
    const clean = watchErrors(page);
    await boot(page, theme);
    await page.evaluate(() => window.__h3d.openPresets());
    const dlg = presetsDlg(page);
    await dlg.locator('[data-key^="edit:"]').first().click();
    // Build team: Claude orchestrator and coders, Codex reviewers, ux reviewers and researchers.
    for (const r of ['orch', 'coder']) await expect(dlg.locator(`[data-role-profile="${r}"]`)).toHaveCount(0);
    const reviewer = dlg.locator('[data-role-profile="reviewer"]');
    await expect(reviewer.locator('.dd-chip')).toHaveText(['Auto', 'codex', 'work', 'sparenot signed in']);
    await expect(reviewer.locator('[data-key="role:reviewer:profile:codex"]')).toBeChecked();
    await chipIn(reviewer, 'role:reviewer:profile:work').click();
    await expect(reviewer.locator('[data-key="role:reviewer:profile:work"]')).toBeChecked();
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await fits(page, reviewer, size.width);
      await shot(page, `h167-preset-profile-${size.name}-${theme}`);
    }
    await dlg.locator('[data-key="save"]').click();
    await expect(dlg.locator('.pp-roles dd').nth(2)).toHaveText(/· work$/);
    expect((await page.evaluate(() => window.__h3d.sent())).find((c) => c.t === 'preset.update')?.args).toMatchObject({
      roles: { reviewer: { harness: 'codex', codex_profile: 'work' }, ux: { harness: 'codex' } },
    });
    await dlg.locator('[data-key="done"]').click();
    await openRun(page);
    await ticket(page, 'Tidy the lobby');
    const prompt = ((await page.evaluate(() => window.__h3d.dialog())) as { preview: { text: string } }).preview.text;
    expect(prompt).toContain('- reviewers: codex gpt-6-sol, reasoning high, Codex profile work (CODEX_HOME=/home/u/.codex-work, token h3d_codex_profile=work)');
    expect(prompt).toContain('h3d_codex_profile=<key> its team line gives');
    clean();
  });
