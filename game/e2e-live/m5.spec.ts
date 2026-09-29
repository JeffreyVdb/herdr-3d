import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { frames, shot } from '../e2e/game';

// Run through tools/live-m5.ts (`pnpm test:live:m5`), which owns the throwaway herdr session h3d-m5integ-<random>,
// its private bridge and the WS proxy. The floor: `shell`, a plain shell in a temporary git repository; `alpha` and
// `beta`, two cheap Claude agents (haiku, low, --permission-mode default) that start at their trust dialogs. The tests
// run in order and build on each other: alpha is approved, prompted and asked for a permission; beta stays blocked
// until N visits it.
const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} unset: run via \`pnpm test:live:m5\``);
  return v;
};

test.describe.configure({ mode: 'serial' });

const session = env('H3D_LIVE_SESSION');
const repo = env('H3D_LIVE_REPO');
const dirs = JSON.parse(env('H3D_LIVE_DIRS')) as { alpha: string; beta: string };
const LABELS = ['shell', 'alpha', 'beta'];

type Panel = NonNullable<ReturnType<Window['__h3d']['panel']>>;
type Prompt = Extract<Panel, { kind: 'prompt' }>;
type Changes = Extract<Panel, { kind: 'changes' }>;

/** A screenshot of the live run, in test-results/live-m5/ (non-blank checked). */
const snap = (page: Page, name: string) => shot(page, `live-m5/${name}`);

/** The page's errors; `clean()` at the end of a test. */
function watchErrors(page: Page): () => void {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return () => expect(errors).toEqual([]);
}

/** Opens the game on the live bridge and enters the throwaway floor; the workers' ids by label. */
async function open(page: Page, query = ''): Promise<Record<string, string>> {
  await page.goto(`/?backend=webgl2&ws=${encodeURIComponent(env('H3D_LIVE_WS'))}${query}`);
  await page.waitForFunction(
    ([s, want]) => {
      const f = window.__h3d?.world().find((x) => x.session === s);
      return !!f && want.every((l) => f.workers.some((w) => w.label === l));
    },
    [session, LABELS] as const,
    { timeout: 60_000 },
  );
  expect(await page.evaluate(() => window.__h3d.backend)).toBe('webgl2');
  await page.evaluate((s) => window.__h3d.enterFloor(s), session);
  await frames(page, 3);
  const f = (await page.evaluate(() => window.__h3d.world())).find((x) => x.session === session);
  return Object.fromEntries((f?.workers ?? []).map((w) => [w.label, w.id]));
}

/** A worker's name on screen (the bridge's, not its label). */
const nameOf = async (page: Page, id: string) =>
  (await page.evaluate(() => window.__h3d.world())).flatMap((f) => f.workers).find((w) => w.id === id)?.name ?? id;

/** Stands facing a worker (as N does) and checks look-at picks it. */
async function face(page: Page, id: string): Promise<void> {
  await expect.poll(() => page.evaluate((i) => window.__h3d.face(i), id), { message: `facing ${id}` }).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate(() => window.__h3d.lookAt())).toMatchObject({ kind: 'worker', id });
}

const display = (page: Page, id: string) => page.evaluate((i) => window.__h3d.status(i)?.status ?? null, id);
const panel = (page: Page) => page.evaluate(() => window.__h3d.panel());
const cardOf = async (page: Page, id: string) => {
  const name = await nameOf(page, id);
  return (await page.evaluate(() => window.__h3d.cards())).find((c) => c.name === name);
};

/** The `terminal session observe` processes of the throwaway session (the bridge's laptop observers). */
function observers(): number {
  let n = 0;
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    let args: string[];
    try {
      args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    } catch {
      continue;
    }
    if (args.includes(session) && args.includes('terminal') && args.includes('observe')) n++;
  }
  return n;
}

const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

test('the laptops near you show their workers’ terminals live', async ({ page }) => {
  const clean = watchErrors(page);
  const ids = await open(page);
  await face(page, ids.shell as string);
  await expect
    .poll(async () => (await page.evaluate(() => window.__h3d.screens())).filter((s) => s.state === 'live').map((s) => s.id).sort(), { timeout: 20_000 })
    .toEqual(Object.values(ids).sort());
  // A real terminal: the shell's prompt, the agents' trust dialogs.
  await expect
    .poll(async () => ((await page.evaluate((id) => window.__h3d.screenText(id), ids.alpha as string)) ?? []).join('\n'), { timeout: 20_000 })
    .toMatch(/trust/i);
  const shellText = (await page.evaluate((id) => window.__h3d.screenText(id), ids.shell as string)) ?? [];
  expect(shellText.join('').trim()).not.toBe('');
  expect(observers()).toBe(3);
  // Between the shell's and alpha's chairs, looking down at their screens.
  await page.evaluate(([a, b]) => {
    const h = window.__h3d;
    const floor = h.view().floor ?? '';
    const L = h.layout(floor);
    const ws = h.world().find((f) => f.session === floor)?.workers ?? [];
    const [sa, sb] = [a, b].map((id) => L?.slots[ws.find((w) => w.id === id)?.desk ?? -1]);
    const p = h.pose();
    if (!sa || !sb || !p) return;
    const [fx, fz] = [Math.sin(sa.yaw), Math.cos(sa.yaw)];
    const [x, z] = [(sa.seat.x + sb.seat.x) / 2 - fx * 0.75, (sa.seat.z + sb.seat.z) / 2 - fz * 0.75];
    const [tx, tz] = [(sa.desk.x + sb.desk.x) / 2, (sa.desk.z + sb.desk.z) / 2];
    h.setPose({ x, z, yaw: Math.atan2(-(tx - x), -(tz - z)), pitch: Math.atan2(0.8 - p.eye, Math.hypot(tx - x, tz - z)) });
  }, [ids.shell as string, ids.alpha as string] as const);
  await frames(page, 30);
  await snap(page, 'screens-live');
  clean();
});

test('E sits at the shell’s laptop: what you type echoes there, Esc stands you up; 20 sit/stand cycles leave no observer', async ({ page }) => {
  test.setTimeout(240_000);
  const clean = watchErrors(page);
  const ids = await open(page, '&screens=0');
  const shell = ids.shell as string;
  await face(page, shell);
  await expect.poll(() => observers()).toBe(0);
  const standing = await page.evaluate(() => window.__h3d.pose());
  await expect(page.locator('.prompt .key', { hasText: 'Laptop' })).not.toHaveAttribute('aria-disabled');
  await page.keyboard.press('KeyE');
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBe(shell);
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.screens())).find((s) => s.id === shell)?.state, { timeout: 15_000 }).toBe('live');
  expect(observers()).toBe(1);

  const marker = `h3d-live-${Math.random().toString(16).slice(2, 8)}`;
  await page.keyboard.type(`echo ${marker} | tr a-z A-Z`);
  await page.keyboard.press('Enter');
  // Only the command's output has it in upper case.
  await expect
    .poll(async () => ((await page.evaluate((id) => window.__h3d.screenText(id), shell)) ?? []).join('\n'), { timeout: 15_000 })
    .toContain(marker.toUpperCase());
  // Something to look at: git's own view of the checkout the Changes panel reads later.
  await page.keyboard.type('git status && git log --oneline --graph --all');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => ((await page.evaluate((id) => window.__h3d.screenText(id), shell)) ?? []).join('\n'), { timeout: 15_000 })
    .toContain('Untracked files');
  await frames(page, 6);
  await snap(page, 'seated');
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.__h3d.seated())).toBeNull();
  await frames(page, 40);
  const back = await page.evaluate(() => window.__h3d.pose());
  expect([back?.x, back?.z, back?.yaw]).toEqual([standing?.x, standing?.z, standing?.yaw]);
  await expect.poll(() => observers(), { timeout: 5000 }).toBe(0);

  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('KeyE');
    await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBe(shell);
    // Half the cycles wait for the screen, half get up at once.
    if (i % 2) await expect.poll(async () => (await page.evaluate(() => window.__h3d.screens())).find((s) => s.id === shell)?.state, { timeout: 15_000 }).toBe('live');
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.__h3d.seated())).toBeNull();
    await frames(page, 2);
  }
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.watches())).game, { timeout: 10_000 }).toBe(0);
  await expect.poll(() => observers(), { timeout: 10_000 }).toBe(0);
  const log = await page.evaluate(() => window.__h3d.watchLog());
  expect(log.filter((c) => c.t === 'terminal.watch').length).toBe(21);
  expect(log.filter((c) => c.t === 'terminal.unwatch').length).toBe(21);
  expect(log.filter((c) => c.result && !c.result.ok)).toEqual([]);
  clean();
});

test('a Claude at its trust dialog shows the question on its card and is approved with the digit key', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  const ids = await open(page);
  const alpha = ids.alpha as string;
  await expect.poll(() => display(page, alpha), { timeout: 90_000 }).toBe('needs_you');
  await face(page, alpha);
  await expect.poll(async () => (await cardOf(page, alpha))?.ask?.choices.map((c) => c.label), { timeout: 20_000 }).toContain('Yes, I trust this folder');
  const ask = (await cardOf(page, alpha))?.ask;
  const yes = ask?.choices.find((c) => c.label === 'Yes, I trust this folder')?.n as number;
  expect(ask?.text).toMatch(/trust/i);
  // Approve is the choice that trusts, not the first ("No, exit").
  await expect(page.locator('.prompt .key--approve')).toHaveText(`${yes}Approve`);
  await expect(page.locator('.prompt .key:not([aria-disabled])', { hasText: 'Prompt' })).toHaveCount(0);
  await page.keyboard.press(`Digit${yes}`);
  await expect(page.locator('.toast')).toContainText(`Answered ${await nameOf(page, alpha)}: ${yes}. Yes, I trust this folder.`);
  await expect.poll(() => display(page, alpha), { timeout: 30_000 }).not.toBe('needs_you');
  const answer = (await page.evaluate(() => window.__h3d.sent())).filter((c) => c.t === 'worker.answer');
  expect(answer).toHaveLength(1);
  expect(answer[0]?.args).toMatchObject({ id: alpha, choice: yes });
  expect(answer[0]?.result).toMatchObject({ ok: true, data: { resolved: true, sent: ['down', 'enter'] } });
  clean();
});

test('P prompts alpha: it works, then is done on screen; a prompt sent while it works is queued; its usage shows', async ({ page }) => {
  test.setTimeout(240_000);
  const clean = watchErrors(page);
  const ids = await open(page);
  const alpha = ids.alpha as string;
  await expect.poll(() => display(page, alpha), { timeout: 30_000 }).toMatch(/idle|done/);
  // Claude drops an Enter right after its trust dialog.
  await page.waitForTimeout(3000);
  await face(page, alpha);
  await expect(page.locator('.prompt .key:not([aria-disabled])', { hasText: 'Prompt' })).toHaveCount(1);
  await page.keyboard.press('p');
  await expect.poll(async () => ((await panel(page)) as Prompt | null)?.state).toBe('ready');
  await page.keyboard.type('Write a 200-word story about a lighthouse keeper. Use no tools.');
  await page.keyboard.press('Enter');
  await expect.poll(async () => ((await panel(page)) as Prompt | null)?.state, { timeout: 30_000 }).toBe('sent');
  expect(((await panel(page)) as Prompt).result).toMatchObject({ queued: false });
  await expect.poll(() => display(page, alpha), { timeout: 15_000 }).toBe('working');
  await expect(page.locator('.desk-dlg--prompt .dd-head .tape')).toHaveText('WORKING');

  // While it works: the chip says the next one will queue, the bridge's ack says it did.
  await page.keyboard.type('Then reply with exactly the word: pong');
  await expect(page.locator('.pr-queued')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect.poll(async () => ((await panel(page)) as Prompt | null)?.result, { timeout: 30_000 }).toMatchObject({ queued: true });
  await expect(page.locator('.desk-dlg--prompt .dd-status .tape')).toHaveText('Queued');
  await snap(page, 'prompt-queued');
  await expect.poll(() => display(page, alpha), { timeout: 150_000 }).toMatch(/idle|done/);
  await expect(page.locator('.desk-dlg--prompt .dd-head .tape')).toHaveText(/IDLE|DONE/);
  await page.keyboard.press('Escape');
  await expect.poll(() => panel(page)).toBeNull();

  // Usage from its real transcript: on the look-at bar, its card and the top bar, always `≈$`.
  await face(page, alpha);
  await expect(page.locator('.prompt .prompt-usage')).toHaveText(/^≈\$\d+\.\d+ · \d+(\.\d)?k? tokens( · ctx \d+%)?$/, { timeout: 30_000 });
  await expect.poll(async () => (await cardOf(page, alpha))?.usage ?? '').toMatch(/≈\$/);
  await expect(page.locator('.topbar-usage')).toHaveText(/^≈\$\d/);
  await snap(page, 'usage');
  clean();
});

test('a permission prompt is a question on the card, approved with 1: the command runs', async ({ page }) => {
  test.setTimeout(240_000);
  const clean = watchErrors(page);
  const ids = await open(page);
  const alpha = ids.alpha as string;
  const probe = join(dirs.alpha, `h3d-perm-${Math.random().toString(16).slice(2, 8)}.txt`);
  await face(page, alpha);
  await page.keyboard.press('p');
  await expect.poll(async () => ((await panel(page)) as Prompt | null)?.state).toBe('ready');
  await page.keyboard.type(`Use the Bash tool to run exactly this command: touch ${probe}`);
  await page.keyboard.press('Enter');
  await expect.poll(async () => ((await panel(page)) as Prompt | null)?.state, { timeout: 30_000 }).toBe('sent');
  await page.keyboard.press('Escape');
  await expect.poll(() => display(page, alpha), { timeout: 120_000 }).toBe('needs_you');
  await face(page, alpha);
  await expect.poll(async () => (await cardOf(page, alpha))?.ask?.choices[0]?.label, { timeout: 20_000 }).toBe('Yes');
  expect((await cardOf(page, alpha))?.ask?.text).toMatch(/\?$/);
  await expect(page.locator('.prompt .key--approve')).toHaveText('1Approve');
  await frames(page, 6);
  await snap(page, 'quick-reply');
  expect(existsSync(probe)).toBe(false);
  await page.keyboard.press('Digit1');
  await expect.poll(() => existsSync(probe), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => display(page, alpha), { timeout: 60_000 }).not.toBe('needs_you');
  const answer = (await page.evaluate(() => window.__h3d.sent())).filter((c) => c.t === 'worker.answer');
  expect(answer.map((c) => c.result)).toEqual([expect.objectContaining({ ok: true, data: { resolved: true, sent: ['1'] } })]);
  clean();
});

test('N visits who needs you: the blocked one first, then the done one', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  const ids = await open(page);
  const [alpha, beta] = [ids.alpha as string, ids.beta as string];
  await expect.poll(() => display(page, alpha), { timeout: 120_000 }).toBe('done');
  expect(await display(page, beta)).toBe('needs_you');
  await expect(page.locator('.topbar')).toContainText(/1\s*needs you/);
  expect((await page.evaluate(() => window.__h3d.needs())).map((n) => [n.id, n.reason])).toEqual([
    [beta, 'blocked'],
    [alpha, 'done'],
  ]);
  await page.keyboard.press('n');
  await frames(page, 3);
  expect(await page.evaluate(() => window.__h3d.lookAt())).toMatchObject({ kind: 'worker', id: beta });
  await expect(page.locator('.toast')).toContainText(`${await nameOf(page, beta)} needs you`);
  await page.keyboard.press('n');
  await frames(page, 3);
  expect(await page.evaluate(() => window.__h3d.lookAt())).toMatchObject({ kind: 'worker', id: alpha });
  await expect(page.locator('.toast')).toContainText(`${await nameOf(page, alpha)} is done`);

  // Back to beta, and approved from its bubble.
  await page.keyboard.press('n');
  await frames(page, 3);
  expect(await page.evaluate(() => window.__h3d.lookAt())).toMatchObject({ kind: 'worker', id: beta });
  await expect(page.locator('.prompt .key--approve')).toHaveText(/^\dApprove$/);
  const yes = Number((await page.locator('.prompt .key--approve kbd').textContent()) ?? '0');
  await page.keyboard.press(`Digit${yes}`);
  await expect.poll(() => display(page, beta), { timeout: 30_000 }).not.toBe('needs_you');
  await expect(page.locator('.topbar')).toContainText(/0\s*need you/);
  clean();
});

test('C shows the shell’s changes as git has them; a large diff is cut with a notice', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  const ids = await open(page);
  await face(page, ids.shell as string);
  await page.keyboard.press('c');
  await expect.poll(async () => ((await panel(page)) as Changes | null)?.state, { timeout: 15_000 }).toBe('ready');
  let p = (await panel(page)) as Changes;

  // git's own view of the same checkout.
  const base = git('merge-base', 'HEAD', 'origin/main').trim();
  const shortstat = git('diff', '--shortstat', base).trim(); // " 4 files changed, 9 insertions(+), 5 deletions(-)"
  const [files, ins, del] = [/(\d+) files? changed/, /(\d+) insertions?/, /(\d+) deletions?/].map((r) => Number(r.exec(shortstat)?.[1] ?? 0));
  const untracked = git('status', '--porcelain=v2', '--untracked-files=all')
    .split('\n')
    .filter((l) => l.startsWith('? '))
    .map((l) => l.slice(2));
  const numstat = Object.fromEntries(
    git('diff', '--numstat', base)
      .trim()
      .split('\n')
      .map((l) => l.split('\t'))
      .map(([a, d, path]) => [path as string, [Number(a), Number(d)]]),
  );
  expect(p.branch).toBe('main');
  expect(p.stat).toBe(`${files} files changed · +${ins} −${del}${untracked.length ? ` · ${untracked.length} untracked` : ''}`);
  expect(p.files.map((f) => f.path).sort()).toEqual([...Object.keys(numstat), ...untracked].sort());
  for (const f of p.files) if (numstat[f.path]) expect([f.path, f.insertions, f.deletions]).toEqual([f.path, ...(numstat[f.path] as number[])]);
  const chips = Object.fromEntries(p.files.map((f) => [f.path, f.chips.join(' ')]));
  expect(chips).toMatchObject({ 'staged.txt': 'staged A', 'src/app.txt': 'M', 'src/gone.txt': 'D', 'scratch.txt': 'new', 'src/feature.txt': 'committed' });
  expect(p.truncated).toBeNull();
  await snap(page, 'changes');
  // The shot's blank check hides the HUD for a moment, which takes focus from the panel's list: back to it.
  await page.locator('.cp-files').focus();

  // Past 256 KiB: whole files up to the cap, the rest listed without a diff.
  const big = (n: number) => Array.from({ length: n }, (_, i) => `a long line of text for the Changes panel's cap, number ${i}\n`).join('');
  writeFileSync(join(repo, 'big-a.txt'), big(3000));
  writeFileSync(join(repo, 'big-b.txt'), big(3000));
  git('add', 'big-a.txt', 'big-b.txt');
  await page.keyboard.press('r');
  await expect.poll(async () => ((await panel(page)) as Changes | null)?.truncated ?? null, { timeout: 15_000 }).toMatch(/^The diff is cut at 256 KiB \(\d+ KiB in all\): 1 file is listed without its diff\.$/);
  p = (await panel(page)) as Changes;
  expect(p.files.map((f) => f.path)).toEqual(expect.arrayContaining(['big-a.txt', 'big-b.txt']));
  await expect(page.getByText(/The diff is cut at 256 KiB/)).toBeVisible();
  await snap(page, 'changes-truncated');
  await page.keyboard.press('Escape');
  clean();
});
