import { expect, test, type Page } from '@playwright/test';
import { openGame, openMenu, settingsSection, watchErrors } from './game';
import { dictate, enterFloor, fakeOpenAI, hires, openBar, reviewReady, sentOf, setUpLlm } from './dictation';

// #190 on demo-m4 against the fixture bridge (`sim=1`, tools/fixture-interpret.ts): the "Say a command" bar reads the
// models Settings → Harness models leaves shown. The screenshot's sentence goes with the hidden list as `hidden_models`;
// the fixture's interpreter hands its fake LLM (e2e/dictation.ts) the catalog without them, and the review opens with
// the one Sol shown, the effort said and the task word for word. Nothing is hired.

const SIM = 'play=none&sim=1&simms=150&simusage=0';
const SENTENCE = 'Please spawn a GPT Sol agent on high reasoning to solve the issue with the frontend.';

/** Settings → Harness models: unchecks `slugs` of Codex, as a player does. */
async function hideCodex(page: Page, slugs: string[]): Promise<void> {
  await openMenu(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await settingsSection(page, 'harness-models');
  const group = page.locator('[data-section="harness-models"] .hm-group').filter({ has: page.getByRole('heading', { name: 'Codex', exact: true }) });
  for (const slug of slugs) await group.locator('.hm-row').filter({ has: page.locator('.hm-slug', { hasText: new RegExp(`^${slug}$`) }) }).getByRole('checkbox').uncheck();
  await expect(group.locator('.settings-badge')).toHaveText(/^1 of \d+ shown$/);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
}

test('the screenshot sentence with only GPT-6 Sol shown: hidden_models goes with it, the LLM reads the shown models, the review opens with Sol, high, the task', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  const llm = await fakeOpenAI();
  try {
    await openGame(page, 'demo-m4', '', SIM);
    await setUpLlm(page, llm);
    await hideCodex(page, ['gpt-6-luna', 'gpt-6-astra']);
    await enterFloor(page, 'pastry');

    await openBar(page);
    await dictate(page, SENTENCE);
    const r = await reviewReady(page, 'pastry');
    expect([r.choice.harness, r.choice.model, r.choice.effort, r.choice.task]).toEqual(['codex', 'gpt-6-sol', 'high', 'solve the issue with the frontend.']);
    expect(r.sections.filter((s) => s.open)).toEqual([]);
    expect(r.blocker).toBeNull();

    const [sent] = await sentOf(page, 'hire.interpret');
    expect((sent?.args as { hidden_models?: unknown }).hidden_models).toEqual({ codex: ['gpt-6-luna', 'gpt-6-astra'] });
    expect(llm.options.at(-1)?.codex?.models).toEqual(['gpt-6-sol']);
    expect(await hires(page)).toHaveLength(0);
    await page.locator('dialog.desk-dlg--review[open]').screenshot({ path: test.info().outputPath('h190-review.png') });
  } finally {
    await llm.close();
  }
  clean();
});

