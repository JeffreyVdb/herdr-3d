import { expect, test, type Page } from '@playwright/test';
import { herdrInstructions } from '../tools/fixture-start.ts';
import { frames, openGame, openMenu, watchErrors } from './game';

// #93 hire presets on demo-m3 with the simulator (tools/fixture-hirepreset.ts): Work = herdr-3d + depot-manager,
// Personal = pastry (desks 14 and 15 free), the lot holds scratchpad. `simhirepresets=<key>` keeps a test's presets
// across a reload and shares them with a second page, as a bridge's database would; each test has its own key (the
// fixture server is shared by the parallel tests). Going to a new hire is off, so the player stays where they are.

type Dialog = NonNullable<ReturnType<Window['__h3d']['dialog']>>;
type Presets = Extract<Dialog, { kind: 'hire-presets' }>;
type Hire = Extract<Dialog, { kind: 'hire' }>;

const sim = (key: string) => `play=none&sim=1&simms=150&simusage=0&simhirepresets=${key}`;
const keyOf = (title: string) => `h93-${title.replace(/\W+/g, '-').slice(0, 24)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const dialog = (page: Page) => page.evaluate(() => window.__h3d.dialog());
const sentOf = async (page: Page, prefix: string) => (await page.evaluate(() => window.__h3d.sent())).filter((c) => c.t.startsWith(prefix));
const presetsDlg = (page: Page) => page.locator('dialog.desk-dlg--hire-presets');
const hireDlg = (page: Page) => page.locator('dialog.desk-dlg--hire');
/** A chip is a visually hidden radio in its label: the label takes the click. */
const chip = (page: Page, scope: string, key: string) => page.locator(`${scope} label:has(> [data-key="${key}"])`);

/** The game on the key's bridge, on `floor` (null: the city). */
async function boot(page: Page, key: string, floor: string | null): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('h3d.hire.goto', 'off');
    } catch {
      /* blocked */
    }
  });
  await openGame(page, 'demo-m3', '', sim(key));
  if (floor) await goTo(page, floor);
}

async function goTo(page: Page, floor: string): Promise<void> {
  await page.evaluate((f) => window.__h3d.enterFloor(f), floor);
  await frames(page, 2);
}

/** The hire dialog for a desk of the floor you are on, ready. */
async function openHire(page: Page, desk: number): Promise<void> {
  await page.evaluate((d) => window.__h3d.openHire(d), desk);
  await expect.poll(async () => {
    const d = await dialog(page);
    return d?.kind === 'hire' ? d.state : null;
  }, { timeout: 15_000 }).toBe('ready');
}

/** The desk's "Hire preset" tab. */
async function openPresets(page: Page, desk: number): Promise<Presets> {
  await openHire(page, desk);
  await hireDlg(page).locator('[data-key="tab:preset"]').click();
  await expect(presetsDlg(page)).toBeVisible();
  await expect(presetsDlg(page).locator('[data-key="tab:preset"]')).toBeFocused();
  return (await dialog(page)) as Presets;
}

/** New preset from the list: a name, a prompt and where it shows (the chosen harness / model / effort stay the default). */
async function createPreset(page: Page, name: string, prompt: string, scope: 'floor' | 'global'): Promise<void> {
  await presetsDlg(page).locator('[data-key="new"]').click();
  await expect(presetsDlg(page).locator('#hp-name')).toBeFocused();
  await page.keyboard.type(name);
  await presetsDlg(page).locator('#hp-prompt').fill(prompt);
  if (scope === 'global') await chip(page, '.desk-dlg--hire-presets', 'preset-scope:global').click();
  await presetsDlg(page).locator('[data-key="save"]').click();
  await expect.poll(async () => ((await dialog(page)) as Presets | null)?.view).toBe('list');
}

const names = (d: Presets) => ({ floor: d.groups.floor.map((r) => r.name), global: d.groups.global.map((r) => r.name) });

test('a preset saved from the hire form survives a reload, shows on another client, and hires its exact prompt and model again and again', async ({ page, browser }, info) => {
  test.setTimeout(240_000);
  const key = keyOf('repeat');
  const clean = watchErrors(page);
  await boot(page, key, 'pastry');

  // The hire form: a first task and a choice other than the floor's default, then "Save as preset…".
  await openHire(page, 14);
  await page.locator('#hire-task').focus();
  await page.keyboard.type('Deploy the release to A, B and C.');
  await chip(page, '.desk-dlg--hire', 'harness:codex').click();
  await chip(page, '.desk-dlg--hire', 'model:gpt-6-luna').click();
  await chip(page, '.desk-dlg--hire', 'effort:low').click();
  await hireDlg(page).locator('[data-key="save-preset"]').click();
  await expect(presetsDlg(page)).toBeVisible();
  await expect(presetsDlg(page).locator('#hp-prompt')).toHaveValue('Deploy the release to A, B and C.');
  await expect(chip(page, '.desk-dlg--hire-presets', 'preset-scope:floor').locator('input')).toBeChecked();
  await presetsDlg(page).locator('#hp-name').fill('Deploy release');
  await page.screenshot({ path: info.outputPath('editor-desktop.png') });
  await presetsDlg(page).locator('[data-key="save"]').click();
  await expect(presetsDlg(page)).toBeHidden();
  await expect(hireDlg(page).locator('[data-key="save-preset"]')).toBeFocused();
  expect((await sentOf(page, 'hire_preset.')).map((c) => [c.t, c.args])).toEqual([
    // #95: the box is sent, off: the plain hire form it came from has none.
    ['hire_preset.create', { name: 'Deploy release', floor: 'pastry', prompt: 'Deploy the release to A, B and C.', harness: 'codex', model: 'gpt-6-luna', effort: 'low', herdr_instructions: false }],
  ]);
  // Nobody was hired by saving; the typed task stays the desk's draft.
  expect(await sentOf(page, 'worker.hire')).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(hireDlg(page)).toBeHidden();

  // Another client of the bridge sees it on the same floor.
  const other = await browser.newPage();
  await boot(other, key, 'pastry');
  const seen = await openPresets(other, 15);
  expect(names(seen)).toEqual({ floor: ['Deploy release'], global: [] });
  expect(seen.groups.floor[0]?.choice).toBe('Codex · GPT 6 Luna · low');
  await other.close();

  // A reload (the bridge kept it): Use on desk 14, whose unsent task is replaced only once asked.
  await boot(page, key, 'pastry');
  let list = await openPresets(page, 14);
  expect(names(list)).toEqual({ floor: ['Deploy release'], global: [] });
  const id = list.groups.floor[0]?.id as string;
  await page.screenshot({ path: info.outputPath('list-desktop.png') });
  await page.setViewportSize({ width: 390, height: 780 });
  await page.screenshot({ path: info.outputPath('list-phone.png') });
  await page.setViewportSize({ width: 1280, height: 720 });
  await presetsDlg(page).locator(`[data-key="use:${id}"]`).click();
  await expect(presetsDlg(page).locator('[data-hook="hp-replace"]')).toContainText('Desk 15 has an unsent first task');
  await presetsDlg(page).locator(`[data-key="replace:${id}"]`).click();
  await expect.poll(async () => ((await dialog(page)) as Hire | null)?.state).toBe('ready');
  let form = (await dialog(page)) as Hire;
  expect(form.form).toMatchObject({ prompt: 'Deploy the release to A, B and C.', harness: 'codex', model: 'gpt-6-luna', effort: 'low' });
  expect(form.preset).toMatchObject({ id, name: 'Deploy release', problem: null });
  await expect(hireDlg(page).locator('[data-hook="preset"]')).toContainText('Deploy release');
  await page.screenshot({ path: info.outputPath('hire-from-preset-desktop.png') });
  await page.setViewportSize({ width: 390, height: 780 });
  await page.screenshot({ path: info.outputPath('hire-from-preset-phone.png') });
  await page.setViewportSize({ width: 1280, height: 720 });
  await hireDlg(page).locator('[data-key="hire"]').click();
  await expect(hireDlg(page)).toBeHidden({ timeout: 20_000 });

  // Again, on desk 15: an effort changed for this hire only.
  list = await openPresets(page, 15);
  await presetsDlg(page).locator(`[data-key="use:${id}"]`).click();
  await expect.poll(async () => ((await dialog(page)) as Hire | null)?.state).toBe('ready');
  await chip(page, '.desk-dlg--hire', 'effort:high').click();
  form = (await dialog(page)) as Hire;
  expect(form.form).toMatchObject({ prompt: 'Deploy the release to A, B and C.', model: 'gpt-6-luna', effort: 'high' });
  await hireDlg(page).locator('[data-key="hire"]').click();
  await expect(hireDlg(page)).toBeHidden({ timeout: 20_000 });

  // Two hires, one worker each, through worker.hire; the preset was never changed.
  const hires = (await sentOf(page, 'worker.hire')).map((c) => c.args as Record<string, unknown>);
  expect(hires).toHaveLength(2);
  expect(hires[0]).toMatchObject({ floor: 'pastry', desk_index: 14, harness: 'codex', model: 'gpt-6-luna', effort: 'low', prompt: 'Deploy the release to A, B and C.' });
  expect(hires[1]).toMatchObject({ floor: 'pastry', desk_index: 15, harness: 'codex', model: 'gpt-6-luna', effort: 'high', prompt: 'Deploy the release to A, B and C.' });
  expect(await sentOf(page, 'hire_preset.')).toEqual([]);
  await expect.poll(() => page.evaluate(() => window.__h3d.world().find((f) => f.id === 'pastry')?.workers.length)).toBe(16);
  clean();
});

test('a global preset shows on every floor of every building; a floor’s own only on it, also beside virtual floors of one session', async ({ page }) => {
  test.setTimeout(240_000);
  const key = keyOf('scopes');
  const clean = watchErrors(page);
  await boot(page, key, null);

  // Two virtual floors on herdr-3d's session (Work), from the city's Add floor.
  for (const name of ['Web', 'API']) {
    await openMenu(page);
    await page.getByRole('button', { name: 'Add floor' }).click();
    const add = page.locator('dialog.desk-dlg--addfloor');
    await add.getByRole('radio', { name: /Virtual floor on an existing session/ }).check();
    await add.getByLabel('Floor name').fill(name);
    await add.getByLabel('Base session').selectOption('herdr-3d');
    await add.getByLabel('Floor name').press('Enter');
    await expect(add).toBeHidden();
  }

  // Personal's pastry: a global preset and its own.
  await goTo(page, 'pastry');
  let list = await openPresets(page, 14);
  await expect(presetsDlg(page).locator('[data-hook="hp-empty"]')).toBeVisible();
  await createPreset(page, 'Nightly audit', 'Audit the dependencies and open an issue per problem.', 'global');
  await createPreset(page, 'Pastry only', 'Bake.', 'floor');
  list = (await dialog(page)) as Presets;
  expect(names(list)).toEqual({ floor: ['Pastry only'], global: ['Nightly audit'] });
  await page.keyboard.press('Escape');
  await expect(presetsDlg(page)).toBeHidden();

  const floors = await page.evaluate(() => window.__h3d.world());
  const web = floors.find((f) => f.name === 'Web')?.id as string;
  const api = floors.find((f) => f.name === 'API')?.id as string;
  expect([web, api].every((id) => /^v-[0-9a-f]{12}$/.test(id))).toBe(true);

  // Web: the global one, then its own.
  await goTo(page, web);
  list = await openPresets(page, 0);
  expect(names(list)).toEqual({ floor: [], global: ['Nightly audit'] });
  await createPreset(page, 'Web deploy', 'Deploy the web front end.', 'floor');
  expect(names((await dialog(page)) as Presets)).toEqual({ floor: ['Web deploy'], global: ['Nightly audit'] });
  await page.keyboard.press('Escape');

  // API (the same session, another floor), herdr-3d (its real floor, Work) and the lot: the global one only.
  for (const f of [api, 'herdr-3d', 'scratchpad']) {
    await goTo(page, f);
    const desk = f === 'herdr-3d' ? 5 : f === 'scratchpad' ? 3 : 0;
    expect(names(await openPresets(page, desk)), f).toEqual({ floor: [], global: ['Nightly audit'] });
    await page.keyboard.press('Escape');
  }
  expect(await sentOf(page, 'worker.hire')).toEqual([]);
  clean();
});

test('#95: a ticked global preset adds the herdr hiring instructions for the floor it is used on, never to its stored prompt', async ({ page }, info) => {
  test.setTimeout(240_000);
  const key = keyOf('instructions');
  const clean = watchErrors(page);
  await boot(page, key, null);
  for (const name of ['Web', 'API']) {
    await openMenu(page);
    await page.getByRole('button', { name: 'Add floor' }).click();
    const add = page.locator('dialog.desk-dlg--addfloor');
    await add.getByRole('radio', { name: /Virtual floor on an existing session/ }).check();
    await add.getByLabel('Floor name').fill(name);
    await add.getByLabel('Base session').selectOption('herdr-3d');
    await add.getByLabel('Floor name').press('Enter');
    await expect(add).toBeHidden();
  }
  const floors = await page.evaluate(() => window.__h3d.world());
  const web = floors.find((f) => f.name === 'Web')?.id as string;
  const api = floors.find((f) => f.name === 'API')?.id as string;

  // On Web: a global preset with the box ticked (the box is a visually hidden input in its label).
  const task = 'Merge all dependabot pull requests: for each one, spawn a subagent that reviews and merges it.';
  await goTo(page, web);
  await openPresets(page, 0);
  await presetsDlg(page).locator('[data-key="new"]').click();
  await page.keyboard.type('Dependabot');
  await presetsDlg(page).locator('#hp-prompt').fill(task);
  await chip(page, '.desk-dlg--hire-presets', 'preset-scope:global').click();
  await presetsDlg(page).locator('label[for="hp-instructions"]').click();
  await expect(presetsDlg(page).locator('#hp-instructions')).toBeChecked();
  await page.screenshot({ path: info.outputPath('editor-instructions.png') });
  await presetsDlg(page).locator('[data-key="save"]').click();
  await expect.poll(async () => ((await dialog(page)) as Presets | null)?.view).toBe('list');
  expect((await sentOf(page, 'hire_preset.')).map((c) => c.args)).toEqual([
    { name: 'Dependabot', prompt: task, harness: expect.any(String), model: expect.any(String), effort: expect.any(String), herdr_instructions: true },
  ]);
  const id = ((await dialog(page)) as Presets).groups.global[0]?.id as string;

  // Used on Web, API (the same session) and the real floor herdr-3d: each form shows its own floor's lines.
  for (const [floor, desk] of [
    [web, 0],
    [api, 0],
    ['herdr-3d', 5],
  ] as const) {
    if (floor !== web) {
      await goTo(page, floor);
      await openPresets(page, desk);
    }
    await presetsDlg(page).locator(`[data-key="use:${id}"]`).click();
    await expect.poll(async () => ((await dialog(page)) as Hire | null)?.state).toBe('ready');
    const form = (await dialog(page)) as Hire;
    expect(form.instructions, floor).toMatchObject({ on: true, lines: herdrInstructions(floor) });
    await expect(hireDlg(page).locator('#hire-instructions')).toBeChecked();
    await hireDlg(page).locator('[data-hook="instructions-lines"] summary').click();
    await expect(hireDlg(page).locator('[data-hook="instructions-lines"] pre')).toContainText(`h3d_floor=${floor},`);
    if (floor === web) await page.screenshot({ path: info.outputPath('hire-instructions.png') });
    await hireDlg(page).locator('[data-key="hire"]').click();
    await expect(hireDlg(page)).toBeHidden({ timeout: 20_000 });
  }

  // Only the flag went out; each worker's first prompt ends with its own floor's lines; the preset is as saved.
  const hires = (await sentOf(page, 'worker.hire')).map((c) => c.args as Record<string, unknown>);
  expect(hires.map((a) => [a.floor, a.prompt, a.herdr_instructions])).toEqual([
    [web, task, true],
    [api, task, true],
    ['herdr-3d', task, true],
  ]);
  const first = await page.evaluate(() => window.__h3d.simFirstPrompts());
  expect(first.map((x) => [x.floor, x.prompt])).toEqual([
    [web, `${task}\n\n${herdrInstructions(web)}`],
    [api, `${task}\n\n${herdrInstructions(api)}`],
    ['herdr-3d', `${task}\n\n${herdrInstructions('herdr-3d')}`],
  ]);
  // The preset holds the task alone (the create above), and nothing changed it since.
  expect((await sentOf(page, 'hire_preset.')).map((c) => c.t)).toEqual(['hire_preset.create']);
  clean();
});

test('pinned presets sit in the desk tabs, hire in one click, move by drag or Shift+arrows, and stay pinned after a reload', async ({ page }) => {
  test.setTimeout(240_000);
  const key = keyOf('pins');
  const clean = watchErrors(page);
  await boot(page, key, 'pastry');

  let list = await openPresets(page, 14);
  await createPreset(page, 'Deploy', 'Deploy the release.', 'floor');
  await createPreset(page, 'Audit', 'Audit the dependencies.', 'global');
  await createPreset(page, 'Triage', 'Triage the new issues.', 'global');
  list = (await dialog(page)) as Presets;
  const id = (name: string) => [...list.groups.floor, ...list.groups.global].find((r) => r.name === name)?.id as string;
  const [deploy, audit, triage] = [id('Deploy'), id('Audit'), id('Triage')];
  for (const p of [deploy, audit, triage]) await presetsDlg(page).locator(`[data-key="pin:${p}"]`).click();
  await expect.poll(async () => ((await dialog(page)) as Presets).pins).toEqual([deploy, audit, triage]);
  await page.keyboard.press('Escape');

  // From the hire form: Audit's tab hires with it, its tab selected.
  const pinKeys = (scope: ReturnType<typeof hireDlg>) => scope.locator('.dd-tab--pin').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.key));
  await openHire(page, 14);
  expect(await pinKeys(hireDlg(page))).toEqual([`tab:pin:${deploy}`, `tab:pin:${audit}`, `tab:pin:${triage}`]);
  await hireDlg(page).locator(`[data-key="tab:pin:${audit}"]`).click();
  await expect.poll(async () => {
    const d = (await dialog(page)) as Hire | null;
    return d?.kind === 'hire' && d.state === 'ready' ? [d.preset?.name, d.form.prompt] : null;
  }, { timeout: 15_000 }).toEqual(['Audit', 'Audit the dependencies.']);
  const auditTab = hireDlg(page).locator(`[data-key="tab:pin:${audit}"]`);
  await expect(auditTab).toHaveAttribute('aria-selected', 'true');
  await expect(auditTab).toBeFocused();

  // Shift+← moves it before Deploy; a drag puts Triage first.
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(() => pinKeys(hireDlg(page))).toEqual([`tab:pin:${audit}`, `tab:pin:${deploy}`, `tab:pin:${triage}`]);
  await expect(hireDlg(page).locator(`[data-key="tab:pin:${audit}"]`)).toBeFocused();
  await hireDlg(page).locator(`[data-key="tab:pin:${triage}"]`).dragTo(hireDlg(page).locator(`[data-key="tab:pin:${audit}"]`), { targetPosition: { x: 2, y: 10 } });
  await expect.poll(() => pinKeys(hireDlg(page))).toEqual([`tab:pin:${triage}`, `tab:pin:${audit}`, `tab:pin:${deploy}`]);

  // Hire worker: back to the desk's own form, no preset. A task typed there is asked about before a pin replaces it.
  await hireDlg(page).locator('[data-key="tab:worker"]').click();
  await expect.poll(async () => {
    const d = (await dialog(page)) as Hire | null;
    return d?.kind === 'hire' && d.state === 'ready' ? [d.preset ?? null, d.form.prompt] : null;
  }, { timeout: 15_000 }).toEqual([null, '']);
  await expect(hireDlg(page).locator('[data-key="tab:worker"]')).toHaveAttribute('aria-selected', 'true');
  await expect(hireDlg(page).locator('[data-key="tab:worker"]')).toBeFocused();
  await hireDlg(page).locator('.cmp-editor').first().click();
  await page.keyboard.type('My own task.');
  await hireDlg(page).locator(`[data-key="tab:pin:${deploy}"]`).click();
  await expect(presetsDlg(page)).toBeVisible();
  await expect.poll(async () => ((await dialog(page)) as Presets | null)?.replacing).toBe(deploy);
  await expect(presetsDlg(page).locator(`[data-key="keep-task:${deploy}"]`)).toBeFocused();
  await presetsDlg(page).locator(`[data-key="keep-task:${deploy}"]`).click();
  await page.keyboard.press('Escape');

  // After a reload, in the same order; on another floor only the global ones.
  await openGame(page, 'demo-m3', '', sim(key));
  await goTo(page, 'pastry');
  await openHire(page, 14);
  expect(await pinKeys(hireDlg(page))).toEqual([`tab:pin:${triage}`, `tab:pin:${audit}`, `tab:pin:${deploy}`]);
  await page.keyboard.press('Escape');
  await goTo(page, 'herdr-3d');
  await openHire(page, 5);
  expect(await pinKeys(hireDlg(page))).toEqual([`tab:pin:${triage}`, `tab:pin:${audit}`]);
  expect(await sentOf(page, 'worker.hire')).toEqual([]);
  clean();
});
