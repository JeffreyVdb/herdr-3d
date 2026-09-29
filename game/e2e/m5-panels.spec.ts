import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { frames, openGame, shot, watchErrors } from './game';

// M5 panels on the demo-m5 fixture and the simulating fixture server
// (tools/fixture-sim.ts → tools/fixture-panels.ts). Work holds herdr-3d
// (top), depot-manager (asleep) and pastry (bottom); scratchpad is in the
// lot. Blocked with a question, as the bridge reads them off real screens:
// Tater (herdr-3d, Claude's trust dialog: "No, exit" first), Quibble
// (pastry, Claude's AskUserQuestion), Tofu (herdr-3d, a Claude Bash
// permission), Sprocket (herdr-3d, a Codex approval), Waffle (herdr-3d, no
// menu) — N visits them in that order, then the done ones. A prompt to an idle agent starts it working one sim
// step later, done three steps after that.

const SIM = 'play=none&sim=1&simms=150&simusage=0';

type Panel = NonNullable<ReturnType<Window['__h3d']['panel']>>;
type Prompt = Extract<Panel, { kind: 'prompt' }>;
type Changes = Extract<Panel, { kind: 'changes' }>;
type Card = ReturnType<Window['__h3d']['cards']>[number];

const panel = (page: Page) => page.evaluate(() => window.__h3d.panel());
const sent = (page: Page) => page.evaluate(() => window.__h3d.sent());
const cards = (page: Page) => page.evaluate(() => window.__h3d.cards());
const toast = (page: Page) => page.locator('.toast');

async function enter(page: Page, session: string): Promise<void> {
  await page.evaluate((s) => window.__h3d.enterFloor(s), session);
  await frames(page, 3);
}

/** A worker's id by its name. */
async function idOf(page: Page, name: string): Promise<string> {
  const id = await page.evaluate((n) => window.__h3d.world().flatMap((f) => f.workers).find((w) => w.name === n)?.id ?? null, name);
  if (!id) throw new Error(`no worker ${name}`);
  return id;
}

/** Stands facing a worker (as N does) and checks look-at picks it. */
async function face(page: Page, name: string): Promise<string> {
  const id = await idOf(page, name);
  expect(await page.evaluate((i) => window.__h3d.face(i), id), `facing ${name}`).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate(() => window.__h3d.lookAt())).toMatchObject({ kind: 'worker', id, name });
  return id;
}

async function promptPanel(page: Page, state?: Prompt['state']): Promise<Prompt> {
  await expect.poll(async () => ((await panel(page)) as Prompt | null)?.kind === 'prompt' && (state === undefined || ((await panel(page)) as Prompt).state === state), { message: `prompt ${state ?? ''}`, timeout: 10_000 }).toBe(true);
  return (await panel(page)) as Prompt;
}

async function changesPanel(page: Page, state: Changes['state'] = 'ready'): Promise<Changes> {
  await expect.poll(async () => ((await panel(page)) as Changes | null)?.state, { message: `changes ${state}`, timeout: 10_000 }).toBe(state);
  return (await panel(page)) as Changes;
}

const statusOf = (page: Page, id: string) => page.evaluate((i) => window.__h3d.status(i)?.status ?? null, id);
const cardOf = async (page: Page, name: string): Promise<Card | undefined> => (await cards(page)).find((c) => c.name === name);

test('P prompts the looked-at worker: sent, then it works and is done; queued while it works', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', SIM);
  await enter(page, 'herdr-3d');
  const pebble = await face(page, 'Pebble');
  await expect(page.locator('.prompt .key:not([aria-disabled])')).toHaveText(['ELaptop', 'CChanges', 'PPrompt', 'XSend home']);

  await page.keyboard.press('p');
  let p = await promptPanel(page, 'ready');
  expect(p).toMatchObject({ name: 'Pebble', display: 'idle', queued: false, blocker: null, result: null });
  await expect(page.locator('#prompt-title')).toHaveText('Prompt Pebble');
  expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.id)).toBe('prompt-text');
  expect(await page.evaluate(() => document.pointerLockElement)).toBeNull();
  // Typing never reaches the game; Shift+Enter is a new line, Enter sends.
  await page.keyboard.type('Write the M5 section of CONTRIBUTING');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('and keep it short');
  expect(((await panel(page)) as Prompt).text).toBe('Write the M5 section of CONTRIBUTING\nand keep it short');
  await page.keyboard.press('Enter');
  p = await promptPanel(page, 'sent');
  expect(p).toMatchObject({ result: { queued: false, retried: false }, status: 'Sent: Pebble is on it.', error: false, text: '' });
  expect((await sent(page)).filter((c) => c.t === 'worker.prompt')).toEqual([
    { t: 'worker.prompt', args: { id: pebble, text: 'Write the M5 section of CONTRIBUTING\nand keep it short' }, result: expect.objectContaining({ ok: true }) },
  ]);
  // It reaches the worker: working on screen (the header and the card), then done.
  await expect.poll(() => statusOf(page, pebble), { timeout: 5000 }).toBe('working');
  await expect(page.locator('.desk-dlg--prompt .dd-head .tape')).toHaveText('WORKING');
  await shot(page, 'm5-prompt');
  await expect.poll(() => statusOf(page, pebble), { timeout: 5000 }).toBe('done');
  await expect(page.locator('.desk-dlg--prompt .dd-head .tape')).toHaveText('DONE');
  await page.keyboard.press('Escape');
  await expect.poll(() => panel(page)).toBeNull();

  // A working worker: the chip says it will queue, the ack confirms.
  const nibble = await face(page, 'Nibble');
  await page.keyboard.press('p');
  p = await promptPanel(page, 'ready');
  expect(p).toMatchObject({ display: 'working', queued: true });
  await expect(page.locator('.pr-queued')).toBeVisible();
  await expect(page.locator('.pr-queued .tape')).toHaveText('Will queue');
  await page.keyboard.type('Then update docs/protocol.md');
  await page.keyboard.press('Enter');
  p = await promptPanel(page, 'sent');
  expect(p).toMatchObject({ result: { queued: true, retried: false }, queued: true, status: 'Queued: Nibble takes it after the current turn.' });
  await expect(page.locator('.pr-queued')).toBeHidden();
  await expect(page.locator('.desk-dlg--prompt .dd-status .tape')).toHaveText('Queued');
  await shot(page, 'm5-prompt-queued');
  expect(await statusOf(page, nibble)).toBe('working');
  // Writing the next one while it still works: the chip is up again. Esc closes; a draft left unsent is still there next time.
  await page.keyboard.type('half a thought');
  await expect(page.locator('.pr-queued')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('p');
  expect((await promptPanel(page)).text).toBe('half a thought');
  await page.keyboard.press('Escape');
  clean();
});

test('P says why not: a plain shell, a worker waiting on a question, an asleep floor; a failed prompt keeps the text and shows the reason', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', `${SIM}&simfail=prompt_failed`);
  await enter(page, 'herdr-3d');
  await face(page, 'Sprout');
  const pKey = page.locator('.prompt .key[aria-disabled="true"]', { hasText: 'Prompt' });
  await expect(pKey).toHaveAttribute('title', 'Sprout is a plain shell, not a coding agent: sit at its laptop (E) to type there.');
  await page.keyboard.press('p');
  await expect(toast(page)).toHaveText('Sprout is a plain shell, not a coding agent: sit at its laptop (E) to type there.');
  expect(await panel(page)).toBeNull();

  // Waiting on a question: the bridge refuses a prompt then, so P says to answer first.
  await face(page, 'Tofu');
  await expect(page.locator('.prompt .key[aria-disabled="true"]', { hasText: 'Prompt' })).toHaveAttribute('title', 'Tofu is waiting for an answer first: pick one on its card (1–3, 0 denies).');
  await page.keyboard.press('p');
  await expect(toast(page)).toHaveText('Tofu is waiting for an answer first: pick one on its card (1–3, 0 denies).');
  expect(await panel(page)).toBeNull();

  await face(page, 'Zippy');
  await page.keyboard.press('p');
  await promptPanel(page, 'ready');
  await page.keyboard.type('Regenerate the sprites');
  await page.keyboard.press('Enter');
  const p = await promptPanel(page, 'failed');
  expect(p).toMatchObject({ error: true, text: 'Regenerate the sprites' });
  expect(p.status).toBe('The prompt did not reach Zippy: Zippy did not start working, even after one more Enter (simulated). Your text is still here: try again, or sit at its laptop (E).');
  await expect(page.locator('.desk-dlg--prompt [role="alert"]')).toHaveText(p.status);
  // The next one goes through (simfail fails one prompt).
  await page.keyboard.press('Enter');
  await promptPanel(page, 'sent');
  await page.keyboard.press('Escape');

  await enter(page, 'depot-manager');
  await face(page, 'Muffin');
  await expect(page.locator('.prompt .key[aria-disabled="true"]', { hasText: 'Prompt' })).toHaveAttribute('title', 'depot-manager is asleep. Wake it from the elevator (L) to prompt Muffin.');
  await expect(page.locator('.prompt .key[aria-disabled="true"]', { hasText: 'Changes' })).toHaveAttribute('title', /depot-manager is asleep/);
  clean();
});

test('against a bridge without the M5 commands, P, C and the quick reply say so', async ({ page }) => {
  const clean = watchErrors(page);
  // The read-only fixture server answers every command with unknown_command.
  await openGame(page, 'demo-m5', '', 'play=none');
  await enter(page, 'herdr-3d');
  await face(page, 'Pebble');
  await page.keyboard.press('p');
  await promptPanel(page, 'ready');
  await page.keyboard.type('hello');
  await page.keyboard.press('Enter');
  const p = await promptPanel(page, 'failed');
  expect(p.status).toBe('This herdr-world can’t send prompts yet. Update the bridge to use it.');
  expect(p.blocker).toBe('This herdr-world can’t send prompts yet. Update the bridge to use it.');
  await expect(page.locator('.desk-dlg--prompt [data-key="send"]')).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await frames(page, 2);
  await expect(page.locator('.prompt .key[aria-disabled="true"]', { hasText: 'Prompt' })).toHaveAttribute('title', 'This herdr-world can’t send prompts yet. Update the bridge to use it.');

  await page.keyboard.press('c');
  const c = await changesPanel(page, 'error');
  expect(c).toMatchObject({ code: 'unknown_command', status: expect.stringMatching(/^This herdr-world can’t show changes yet( \(.*\))?\. Update the bridge to use it\.$/) });
  await page.keyboard.press('Escape');
  await expect.poll(() => panel(page)).toBeNull();

  await face(page, 'Tofu');
  await page.keyboard.press('1');
  await expect(toast(page)).toHaveText('This herdr-world can’t answer questions yet. Update the bridge to use it.');
  await page.keyboard.press('1');
  await expect(toast(page)).toHaveText('This herdr-world can’t answer questions yet. Update the bridge to use it.');
  expect((await sent(page)).filter((x) => x.t === 'worker.answer')).toHaveLength(1);
  await expect(page.locator('.prompt .key--approve')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('.prompt .key--approve')).toHaveAttribute('title', 'This herdr-world can’t answer questions yet. Update the bridge to use it.');
  clean();
});

/** A worker as the demo-m5 fixture has it (to inject a changed copy). */
function fixtureWorker(name: string): Record<string, unknown> {
  const snap = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/demo-m5.jsonl'), 'utf8').split('\n')[0] ?? '{}') as { world: { workers: Array<Record<string, unknown>> } };
  const w = snap.world.workers.find((x) => x.name === name);
  if (!w) throw new Error(`no ${name} in demo-m5`);
  return w;
}

test('a blocked worker’s card shows its numbered choices; 1–3 answer it from where you stand, 0 denies', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', SIM);
  await enter(page, 'herdr-3d');
  const tofu = await face(page, 'Tofu');
  await expect.poll(async () => (await cardOf(page, 'Tofu'))?.tall).toBe(true);
  expect(await cardOf(page, 'Tofu')).toMatchObject({
    display: 'needs_you',
    ask: {
      text: 'Do you want to proceed?',
      choices: [
        { n: 1, label: 'Yes' },
        { n: 2, label: "Yes, and don't ask again for git push commands in /home/dev/devel/herdr-3d" },
        { n: 3, label: 'No' },
      ],
      selected: 1,
    },
    usage: '≈$6.89 · 150k tokens · ctx 42%',
  });
  // Approve / Deny lead the prompt bar: the first choice, and the menu's "No".
  await expect(page.locator('.prompt .key--answer')).toHaveText(['1Approve', '3Deny']);
  await expect(page.locator('.prompt .key--approve')).toHaveAttribute('title', 'Answer “Yes”');
  await shot(page, 'm5-quick-reply');
  await page.keyboard.press('1');
  await expect(toast(page)).toHaveText('Answered Tofu: 1. Yes.');
  const answers = (await sent(page)).filter((c) => c.t === 'worker.answer');
  expect(answers).toEqual([{ t: 'worker.answer', args: { id: tofu, hash: fixtureWorker('Tofu').question && (fixtureWorker('Tofu').question as { hash: string }).hash, choice: 1 }, result: expect.objectContaining({ ok: true }) }]);
  // The card updates: working, no question.
  await expect.poll(async () => (await cardOf(page, 'Tofu'))?.display).toBe('working');
  expect((await cardOf(page, 'Tofu'))?.ask).toBeUndefined();
  await expect(page.locator('.prompt .key--answer')).toHaveCount(0);

  // Claude's trust dialog lists "No, exit" first: Approve is the choice that trusts (2), Deny "No, exit" (1).
  const tater = await face(page, 'Tater');
  await expect(page.locator('.prompt .key--answer')).toHaveText(['2Approve', '1Deny']);
  await page.keyboard.press('2');
  await expect(toast(page)).toHaveText('Answered Tater: 2. Yes, I trust this folder.');
  // Trusted, it waits for its first prompt, as Claude Code does.
  await expect.poll(() => statusOf(page, tater)).toBe('idle');

  // A Codex approval: 3 is its "No" (Deny); the agent is left idle.
  const sprocket = await face(page, 'Sprocket');
  await expect(page.locator('.prompt .key--answer')).toHaveText(['1Approve', '3Deny']);
  await page.keyboard.press('3');
  await expect(toast(page)).toHaveText('Answered Sprocket: 3. No, and tell Codex what to do differently (esc).');
  await expect.poll(() => statusOf(page, sprocket)).toBe('idle');

  // No menu on screen: the card quotes the question from the screen; a digit says so, 0 dismisses (Esc).
  const waffle = await face(page, 'Waffle');
  expect((await cardOf(page, 'Waffle'))?.ask).toEqual({ text: 'Should I regenerate every fixture, or only demo-m5?', choices: [], selected: undefined });
  await expect(page.locator('.prompt .key--answer')).toHaveText(['0Deny']);
  await page.keyboard.press('4');
  await expect(toast(page)).toHaveText('Waffle’s question has no numbered choices: 0 dismisses it (Esc); to answer in words, sit at its laptop (E).');
  await page.keyboard.press('0');
  await expect(toast(page)).toHaveText('Answered Waffle: Esc (dismissed).');
  expect((await sent(page)).at(-1)?.args).toMatchObject({ id: waffle, cancel: true });
  await expect.poll(() => statusOf(page, waffle)).toBe('idle');

  // A worker that is not blocked: nothing to answer.
  await face(page, 'Nibble');
  await page.keyboard.press('1');
  await expect(toast(page)).toHaveText('Nibble isn’t asking anything right now.');
  clean();
});

test('a stale question: the bridge re-reads the screen, the card shows the current one, then it can be answered', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', SIM);
  await enter(page, 'pastry');
  const quibble = await face(page, 'Quibble');
  const real = fixtureWorker('Quibble');
  // The game still shows an older question than the one on the screen now.
  await page.evaluate(
    (w) => window.__h3d.inject({ t: 'worker.upsert', seq: 1, worker: { ...w, question: { kind: 'choice', text: 'Kilograms or pounds?', excerpt: [], choices: [{ n: 1, label: 'kg' }, { n: 2, label: 'lb' }], hash: 'deadbeefdeadbeef' } } } as never),
    real,
  );
  await expect.poll(async () => (await cardOf(page, 'Quibble'))?.ask?.text).toBe('Kilograms or pounds?');
  await page.keyboard.press('1');
  await expect(toast(page)).toHaveText('Quibble’s question changed: now “Which unit system should the nutrition label use?”. Look at its card and answer again.');
  await expect.poll(async () => (await cardOf(page, 'Quibble'))?.ask?.text).toBe('Which unit system should the nutrition label use?');
  expect((await sent(page)).at(-1)).toMatchObject({ t: 'worker.answer', args: { hash: 'deadbeefdeadbeef', choice: 1 }, result: { ok: false, code: 'stale' } });
  await page.keyboard.press('3');
  await expect(toast(page)).toHaveText('Answered Quibble: 3. Both, metric first.');
  await expect.poll(() => statusOf(page, quibble)).toBe('working');
  clean();
});

test('C: the Changes panel lists staged, unstaged, untracked and committed files and shows a diff, from the keyboard', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', SIM);
  await enter(page, 'herdr-3d');
  await face(page, 'Pixel');
  await page.keyboard.press('c');
  await changesPanel(page, 'loading');
  let c = await changesPanel(page);
  expect(c).toMatchObject({
    name: 'Pixel',
    branch: 'h3d/pixel-m2-go',
    upstream: 'origin/h3d/pixel-m2-go: 2 ahead, 0 behind',
    base: expect.stringMatching(/^origin\/main @ [0-9a-f]{7}$/),
    stat: '6 files changed · +18 −5 · 1 untracked',
    truncated: null,
  });
  expect(c.files.map((f) => [f.path, f.chips.join(' '), f.insertions, f.deletions])).toEqual([
    ['game/src/world/next.ts', 'staged A', 6, 0],
    ['docs/img/m5-prompt.png', 'staged A', 0, 0],
    ['game/src/app.ts', 'M', 4, 2],
    ['game/src/ui/hud.ts', 'M', 2, 2],
    ['notes/todo.md', 'new', 6, 0],
    ['game/src/world/usage.ts', 'committed', 4, 0],
    ['docs/protocol.md', 'committed', 2, 1],
  ]);
  // The first file with a diff is selected; the list has focus.
  expect(c.diff).toMatchObject({ path: 'game/src/world/next.ts', none: null });
  expect(c.diff?.shown).toContain('+export function needQueue(ws: Array<{ id: string; display: Display; since: number }>) {');
  expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.key)).toBe('files');
  await expect(page.locator('.cp-file[aria-selected="true"] .cp-base')).toHaveText('next.ts');
  // Keys in the panel are the panel's: W does not walk.
  const before = await page.evaluate(() => window.__h3d.pose());
  await page.keyboard.down('w');
  await frames(page, 5);
  await page.keyboard.up('w');
  expect((await page.evaluate(() => window.__h3d.pose()))?.z).toBe(before?.z);
  await page.keyboard.press('ArrowDown');
  c = await changesPanel(page);
  expect(c.diff).toMatchObject({ path: 'docs/img/m5-prompt.png', none: 'Binary file: no text diff.' });
  await page.keyboard.press('ArrowDown');
  c = await changesPanel(page);
  expect(c.diff?.path).toBe('game/src/app.ts');
  expect(c.diff?.shown).toEqual(expect.arrayContaining(['+    // M5: the prompt overlay and the Changes panel.', '-      this.openElevator();', '@@ -780,3 +782,3 @@ private onKey(e: KeyboardEvent, down: boolean): void {']));
  await expect(page.locator('.cp-line--add').first()).toBeVisible();
  await expect(page.locator('.cp-line--del').first()).toBeVisible();
  await shot(page, 'm5-changes');
  // (The bare-canvas shot hides the HUD, and with it the panel's focus.)
  await page.locator('.cp-files').focus();
  await page.keyboard.press('End');
  expect((await changesPanel(page)).diff?.path).toBe('docs/protocol.md');
  await page.keyboard.press('Home');
  expect((await changesPanel(page)).diff?.path).toBe('game/src/world/next.ts');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.key)).toBe('diff');
  await page.keyboard.press('ArrowLeft');
  expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.key)).toBe('files');
  // Refresh keeps the selection.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('r');
  await changesPanel(page, 'loading');
  expect((await changesPanel(page)).diff?.path).toBe('game/src/app.ts');
  // C again (or Esc) closes it; the game has the keys back.
  await page.keyboard.press('c');
  await expect.poll(() => panel(page)).toBeNull();
  await page.keyboard.press('c');
  await changesPanel(page);
  await page.keyboard.press('Escape');
  await expect.poll(() => panel(page)).toBeNull();

  // A clean tree: the empty state.
  await face(page, 'Pebble');
  await page.keyboard.press('c');
  await changesPanel(page);
  await expect(page.locator('.cp-empty')).toHaveText('No changes against origin/main: Pebble’s working tree is clean and its branch has nothing new.');
  await page.keyboard.press('Escape');
  clean();
});

test('C on a big diff: cut at 256 KiB with a notice, the kept 250 KiB file scrolls a window at a time; not a repo', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', SIM);
  await enter(page, 'herdr-3d');
  await face(page, 'Gizmo');
  await page.keyboard.press('c');
  let c = await changesPanel(page);
  expect(c.truncated).toBe('The diff is cut at 256 KiB (1.6 MiB in all): 2 files are listed without their diff.');
  await expect(page.locator('.cp-cut')).toHaveText(c.truncated as string);
  expect(c.files.map((f) => f.path)).toEqual(['game/src/render/city.ts', 'game/fixtures/perf-city240-replay.jsonl', 'docs/perf.md', 'perf/trace-city240.json', 'perf/trace-floor96.json']);
  await page.keyboard.press('ArrowDown');
  c = await changesPanel(page);
  expect(c.diff).toMatchObject({ path: 'game/fixtures/perf-city240-replay.jsonl', lines: 2906, none: null });
  // Only a screenful (and a margin) is drawn, however long the file.
  expect(await page.locator('.cp-line').count()).toBeLessThan(120);
  const t0 = Date.now();
  await page.locator('.cp-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect.poll(async () => (await changesPanel(page)).diff?.shown.at(-1)).toMatch(/"seq":3942,/);
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(await page.locator('.cp-line').count()).toBeLessThan(120);
  await shot(page, 'm5-changes-truncated');
  await page.locator('.cp-files').focus();
  await page.keyboard.press('End');
  expect((await changesPanel(page)).diff).toMatchObject({ path: 'perf/trace-floor96.json', none: 'Left out of the diff: it would go over the 256 KiB cap.' });
  await page.keyboard.press('Escape');

  // Not a git repository: says so, nothing to retry.
  await enter(page, 'scratchpad');
  await face(page, 'Inky');
  await page.keyboard.press('c');
  c = await changesPanel(page, 'error');
  expect(c).toMatchObject({ code: 'not_a_repo', status: 'Inky’s folder is not a git repository, so there are no changes to show.' });
  await expect(page.locator('.cp-empty--error [data-key="retry"]')).toHaveCount(0);
  clean();
});

test('N visits who needs you in order, across floors: blocked oldest first, then done; another floor through the elevator', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', SIM);
  await enter(page, 'herdr-3d');
  expect((await page.evaluate(() => window.__h3d.needs())).map((n) => `${n.name}:${n.reason}`)).toEqual([
    'Tater:blocked',
    'Quibble:blocked',
    'Tofu:blocked',
    'Sprocket:blocked',
    'Waffle:blocked',
    'Umami:done',
    'Dumpling:done',
    'Noodle:done',
    'Marble:done',
    'Jumble:done',
  ]);
  await expect(page.locator('.topbar-counts .count--needs_you')).toHaveAttribute('title', '4 need you · N: go to the next (then 2 done)');
  const look = () => page.evaluate(() => window.__h3d.lookAt()?.name ?? null);

  // This floor: you are put facing it.
  await page.keyboard.press('n');
  await expect.poll(look).toBe('Tater');
  await expect(toast(page)).toHaveText('Tater needs you: “Quick safety check: Is this a project you created or one you trust?” · N: the next one');
  // Another floor: the elevator opens with it picked; Enter rides there and you arrive facing it.
  await page.keyboard.press('n');
  await expect.poll(async () => (await panel(page)) as { kind: string; pick?: string } | null).toMatchObject({ kind: 'elevator', pick: 'pastry' });
  expect(((await panel(page)) as { status: string }).status).toBe('Quibble needs you on floor 1 (pastry): “Which unit system should the nutrition label use?”. Enter rides there.');
  await expect(page.locator('.lift-row[data-session="pastry"] .lift-need')).toHaveText('Next up');
  await shot(page, 'm5-next-elevator');
  expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.key)).toBe('go:pastry');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__h3d.view().floor), { timeout: 10_000 }).toBe('pastry');
  await expect.poll(look, { timeout: 10_000 }).toBe('Quibble');
  // Back up for Tofu, then Sprocket on the same floor.
  await page.keyboard.press('n');
  await expect.poll(async () => ((await panel(page)) as { pick?: string } | null)?.pick).toBe('herdr-3d');
  await page.keyboard.press('Enter');
  await expect.poll(look, { timeout: 10_000 }).toBe('Tofu');
  await page.keyboard.press('n');
  await expect.poll(look).toBe('Sprocket');
  await page.keyboard.press('n');
  await expect.poll(look).toBe('Waffle');
  // Then the done ones: Umami is downstairs; Esc leaves the elevator shut.
  await page.keyboard.press('n');
  await expect.poll(async () => ((await panel(page)) as { pick?: string } | null)?.pick).toBe('pastry');
  expect(((await panel(page)) as { status: string }).status).toMatch(/^Umami is done on floor 1 \(pastry\)/);
  await page.keyboard.press('Escape');
  await expect.poll(() => panel(page)).toBeNull();
  await page.keyboard.press('n');
  await expect.poll(look).toBe('Dumpling');
  await page.keyboard.press('n');
  await expect.poll(look).toBe('Noodle');

  // Answered: it leaves the queue.
  await face(page, 'Tater');
  await page.keyboard.press('1');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.needs())).map((n) => n.name)).toEqual(['Quibble', 'Tofu', 'Sprocket', 'Waffle', 'Umami', 'Dumpling', 'Noodle', 'Marble', 'Jumble']);

  // From the city: the elevator of that building, the floor picked.
  await page.evaluate(() => window.__h3d.leaveFloor());
  await expect.poll(() => page.evaluate(() => window.__h3d.view().mode), { timeout: 10_000 }).toBe('city');
  await page.keyboard.press('n');
  await expect.poll(async () => (await panel(page)) as { kind: string; pick?: string } | null).toMatchObject({ kind: 'elevator', pick: 'pastry' });
  clean();
});

test('usage: the look-at line, the card and the floor’s ≈$ total, an unknown model flagged; live worker.usage', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', 'play=none&sim=1&simms=150&simusage=400');
  // The city shows no floor total.
  await expect(page.locator('.topbar-usage')).toBeHidden();
  await enter(page, 'herdr-3d');
  await expect(page.locator('.topbar-usage')).toHaveText(/^≈\$\d+$/);
  await expect(page.locator('.topbar-usage')).toHaveAttribute('title', /on this floor: an API-equivalent estimate over 16 agents$/);
  await face(page, 'Pebble');
  await expect(page.locator('.prompt .prompt-usage')).toHaveText('≈$3.14 · 285k tokens · ctx 65%');
  await expect(page.locator('.prompt')).toHaveAttribute('aria-label', /· about \$3\.14 · 285k tokens · ctx 65%$/);
  expect((await cardOf(page, 'Pebble'))?.usage).toBe('≈$3.14 · 285k tokens · ctx 65%');
  // Another worker's card has no usage line (only the one you look at).
  expect((await cards(page)).filter((c) => c.usage).map((c) => c.name)).toEqual(['Pebble']);
  // No model seen: no cost, no tokens yet, no line.
  await face(page, 'Zippy');
  await expect(page.locator('.prompt .prompt-usage')).toHaveCount(0);
  // A working agent's usage goes up as worker.usage events arrive.
  await face(page, 'Nibble');
  const first = await page.locator('.prompt .prompt-usage').textContent();
  expect(first).toMatch(/^≈\$\d+\.\d\d · \d+k tokens · ctx \d+%$/);
  await expect.poll(() => page.locator('.prompt .prompt-usage').textContent(), { timeout: 5000 }).not.toBe(first);

  await enter(page, 'pastry');
  await expect(page.locator('.topbar-usage')).toHaveText(/^≈\$\d+\.\d\d\*$|^≈\$\d+\*$/);
  await expect(page.locator('.topbar-usage')).toHaveClass(/topbar-usage--flagged/);
  await expect(page.locator('.topbar-usage')).toHaveAttribute('title', /\(\* 1 priced as the most expensive known model\)$/);
  await face(page, 'Ravioli');
  const u = page.locator('.prompt .prompt-usage');
  await expect(u).toHaveText(/^≈\$5\.\d\d\* · \d+k tokens · ctx \d+%$/);
  await expect(u).toHaveClass(/prompt-usage--flagged/);
  await expect(u).toHaveAttribute('title', /claude-preview-2026-09 is not in the pricing table: priced as the most expensive known model/);
  await expect.poll(async () => (await cardOf(page, 'Ravioli'))?.usage).toMatch(/^≈\$5\.\d\d\*/);
  await shot(page, 'm5-usage');
  clean();
});
