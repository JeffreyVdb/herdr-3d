import { expect, test, type Locator, type Page } from '@playwright/test';
import { frames, openGame, openMenu, settingsSection, shot, watchErrors } from './game';

// #167: "Share setup with <default>", against the fixture bridge (`simcodexprofiles=2`, tools/fixture-codex-profiles.ts:
// work shares the default's setup and has drifted (its config.toml replaced by a file, and a skill folder only on the
// default), old shares but is hidden, spare does not share and holds its own config.toml). Settings → Codex profiles:
// the switch → the plan's confirm list → the report; the drift badge → Fix → its confirm; the skill's own move; the
// meter's mark on work's row. At 390 × 844 and desktop width, in both UI themes, Quiet and Ubuntu.

const SIM = 'play=none&sim=1&simms=150&simusage=0&simcodexprofiles=2';
const SIZES = [
  { name: '390', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;
const UBUNTU = { 'h3d.theme.ui': 'ubuntu', 'h3d.theme.transcript': 'ubuntu', 'h3d.theme.terminal': 'ubuntu' };
const THEMES = ['quiet', 'ubuntu'] as const;
type Theme = (typeof THEMES)[number];

async function boot(page: Page, theme: Theme): Promise<void> {
  if (theme === 'ubuntu') await page.addInitScript((kv) => Object.entries(kv).forEach(([k, v]) => localStorage.setItem(k, v)), UBUNTU);
  await openGame(page, 'demo-m5', '', SIM);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 2);
  if (theme === 'ubuntu') await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'ubuntu');
}

/** `el` is on screen, inside the viewport's width, and nothing scrolls sideways. */
async function fits(page: Page, el: Locator, width: number): Promise<void> {
  await el.scrollIntoViewIfNeeded();
  await expect(el).toBeInViewport();
  const box = await el.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= width + 0.5).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
}

const shares = async (page: Page) => (await page.evaluate(() => window.__h3d.sent())).filter((c) => c.t === 'codex_profiles.share' || c.t === 'codex_profiles.move_skill');

for (const theme of THEMES)
  test(`Settings: share spare (confirm, report), work’s drift and Fix, the skill’s move (${theme})`, async ({ page }) => {
    test.setTimeout(180_000);
    const clean = watchErrors(page);
    await boot(page, theme);
    await openMenu(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const panel = await settingsSection(page, 'codex-profiles');
    const row = (key: string) => panel.locator(`.settings-cp-row[data-profile="${key}"]`);
    const key = (k: string) => panel.locator(`[data-key="${k}"]`);

    // The switch is on every other row, never on the default; work is shared and drifted, old (hidden) shows none.
    await expect(key('share:codex')).toHaveCount(0);
    await expect(key('share:work')).toBeChecked();
    await expect(key('share:spare')).not.toBeChecked();
    await expect(row('spare').locator('.settings-cp-share')).toHaveText('Share setup with codex');
    await expect(row('old').locator('[data-hook="drift-badge"]')).toHaveCount(0);
    await expect(row('work').locator('[data-hook="drift-badge"]')).toHaveText('Setup drifted');
    await expect(row('work').locator('[data-hook="drift"] li > span')).toHaveText([
      'config.toml is no longer a link: a file replaced it (MCP servers only on codex: alterlab, kaneo)',
      'skill infra is only on codex',
    ]);
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await fits(page, row('work').locator('.settings-cp-share-panel'), size.width);
      await fits(page, key('fix:work'), size.width);
      await fits(page, key('move:work:infra'), size.width);
      await shot(page, `h167-drift-${size.name}-${theme}`);
    }

    // Spare: its own config.toml is in the way, so the plan is confirmed first; nothing is written before.
    await key('share:spare').check();
    const confirm = row('spare').locator('[data-hook="share-confirm"]');
    await expect(confirm.locator('li')).toHaveText([/^config\.toml \(a file\) is kept as config\.toml\.before-share-\d{8}-\d{6}$/]);
    await expect(key('share-confirm:spare')).toBeFocused();
    await expect(key('share:spare')).not.toBeChecked();
    expect((await shares(page)).map((c) => c.args)).toEqual([{ key: 'spare', share: true, dry_run: true }]);
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await fits(page, confirm, size.width);
      await fits(page, key('share-confirm:spare'), size.width);
      await shot(page, `h167-confirm-${size.name}-${theme}`);
    }
    await key('share-confirm:spare').click();
    const report = row('spare').locator('[data-hook="share-report"]');
    await expect(report).toHaveText(/^Linked config\.toml and AGENTS\.md, wrote hooks\.json, backed up the old config\.toml to config\.toml\.before-share-\d{8}-\d{6}\. Codex will ask once to review the hooks of spare\.$/);
    await expect(key('share:spare')).toBeChecked();
    expect((await shares(page)).at(-1)!.args).toEqual({ key: 'spare', share: true, replace: ['config.toml'] });
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await fits(page, report, size.width);
      await shot(page, `h167-report-${size.name}-${theme}`);
    }

    // Work: Fix goes through the same plan and confirm; the file drift goes, the skill stays (Fix does not move it).
    await key('fix:work').click();
    await expect(key('share-confirm:work')).toHaveText('Back up and fix');
    await key('share-confirm:work').click();
    await expect(row('work').locator('[data-hook="share-report"]')).toContainText('backed up the old config.toml');
    await expect(row('work').locator('[data-hook="drift"] li > span')).toHaveText(['skill infra is only on codex']);
    await expect(key('fix:work')).toHaveCount(0);

    // The skill: its own confirm, then it moves and the drift is gone.
    await key('move:work:infra').click();
    await expect(row('work').locator('.settings-cp-share-ask')).toHaveText(
      'Move the skill infra out of codex’s skills/ into ~/.agents/skills, where every Codex home reads it, and leave a link in its place?',
    );
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await fits(page, key('move-confirm:work'), size.width);
      await shot(page, `h167-move-${size.name}-${theme}`);
    }
    await key('move-confirm:work').click();
    await expect(row('work').locator('[data-hook="share-report"]')).toHaveText("Moved the skill infra to ~/.agents/skills/infra and left a link in codex's skills/: every Codex home sees it now.");
    await expect(row('work').locator('[data-hook="drift-badge"]')).toHaveCount(0);
    expect((await shares(page)).at(-1)).toMatchObject({ t: 'codex_profiles.move_skill', args: { key: 'codex', skill: 'infra' } });

    // Off: the links become copies, at once.
    await key('share:work').uncheck();
    await expect(row('work').locator('[data-hook="share-report"]')).toHaveText('Copied config.toml and AGENTS.md from codex: work keeps them as its own and no longer follows codex. Its hooks.json stays.');
    await expect(key('share:work')).not.toBeChecked();
    clean();
  });

for (const theme of THEMES)
  test(`the meter marks work’s drifted setup and points to Settings (${theme})`, async ({ page }) => {
    test.setTimeout(120_000);
    const clean = watchErrors(page);
    await boot(page, theme);
    const meter = page.locator('[data-hook="limits"]');
    const tag = meter.locator('.lm-lines .lm-line[data-account="work"] [data-hook="drift-badge"]');
    await expect(tag).toHaveText('drifted');
    await expect(meter.locator('.lm-lines .lm-line[data-account="codex"] [data-hook="drift-badge"]')).toHaveCount(0);
    const note = 'work’s shared setup differs from codex’s: config.toml is no longer a link: a file replaced it (MCP servers only on codex: alterlab, kaneo); skill infra is only on codex. Fix it in Settings → Codex profiles.';
    await expect(tag).toHaveAttribute('title', note);
    await meter.locator('.lm-strip').click();
    await expect(meter.locator('.lm-sec[data-account="work"] [data-hook="drift"]')).toHaveText(note);
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await expect(meter.locator('.lm-sec[data-account="work"] [data-hook="drift"]')).toBeVisible();
      await shot(page, `h167-meter-${size.name}-${theme}`);
    }
    clean();
  });
