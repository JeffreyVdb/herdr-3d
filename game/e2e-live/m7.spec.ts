import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { LiveBridge } from '../tools/live-bridge.ts';
import { frames } from '../e2e/game';
import { enter, faceBoard, wall } from '../e2e/m7';

// Run through tools/live-m7.ts (`pnpm test:live:m7`): a throwaway herdr session, a private bridge (started here) and
// the game against it, with the real `gh`. Reads JeffreyVdb/herdr-3d (project 2) for the look; writes only on
// JeffreyVdb/h3d-lab (project 3): the probe issues the driver made, and the PR this spec opens and merges.
const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} unset: run via \`pnpm test:live:m7\``);
  return v;
};

test.describe.configure({ mode: 'serial' });

const session = env('H3D_LIVE_SESSION');
const OUT = env('H3D_LIVE_OUT');
const SHOTS = env('H3D_LIVE_SHOTS');
const DB = env('H3D_LIVE_DB');
const TOY_DIR = env('H3D_LIVE_CWD');
const lab = 'JeffreyVdb/h3d-lab';
const REAL = 'JeffreyVdb/herdr-3d';
const issues = JSON.parse(env('H3D_LIVE_TOY_ISSUES')) as Array<{ number: number; title: string }>;
const bridge = new LiveBridge({ bin: env('H3D_LIVE_BRIDGE_BIN'), socket: env('H3D_LIVE_SOCKET'), db: DB, session, log: join(OUT, 'bridge.log') });
const created: { branches: string[]; prs: number[] } = { branches: [], prs: [] };
const saveCreated = () => writeFileSync(join(OUT, 'created.json'), JSON.stringify(created));

test.beforeAll(async () => {
  await bridge.start();
});
test.afterAll(async () => {
  await bridge.stop();
});

function gh(args: string[]): string {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (k.startsWith('HERDR_') || k.startsWith('CLAUDE')) delete e[k];
  return execFileSync('gh', args, { env: e, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
}

type Msg = { t: string; req_id?: string; code?: string; message?: string; data?: unknown; world?: { workers: Array<Record<string, unknown>> } };

/** One command over a fresh connection (not the game's): the bridge's answer. */
function command(t: string, args: object): Promise<Msg> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(env('H3D_LIVE_WS'));
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`no answer to ${t}`));
    }, 120_000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'hello', proto: 1, client: 'h3d-live-m7' }));
      ws.send(JSON.stringify({ t, req_id: 'probe', args }));
    });
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as Msg;
      if (m.req_id !== 'probe') return;
      clearTimeout(timer);
      ws.close();
      resolve(m);
    });
    ws.on('error', reject);
  });
}

const ok = async (t: string, args: object): Promise<unknown> => {
  const m = await command(t, args);
  if (m.t !== 'ack') throw new Error(`${t}: ${m.code} ${m.message}`);
  return m.data;
};

/** A worker as the bridge's snapshot has it. */
function snapshotWorker(id: string): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(env('H3D_LIVE_WS'));
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('no snapshot'));
    }, 30_000);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', proto: 1, client: 'h3d-live-m7' })));
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as Msg;
      if (m.t !== 'world.snapshot') return;
      clearTimeout(timer);
      ws.close();
      resolve(m.world?.workers.find((w) => w.id === id));
    });
    ws.on('error', reject);
  });
}

async function open(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/?backend=webgl2&open=none&ws=${encodeURIComponent(env('H3D_LIVE_WS'))}`);
  await page.waitForFunction((s) => window.__h3d?.ready && !!window.__h3d.world().find((x) => x.session === s), session, { timeout: 60_000 });
  test.info().annotations.push({ type: 'page errors', description: JSON.stringify(errors) });
}

const snap = async (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
const board = (page: Page) => page.evaluate(() => window.__h3d.board());
const sent = (page: Page, t: string) => page.evaluate((x) => window.__h3d.sent().filter((c) => c.t === x), t);

async function link(repo: string, project: { owner: string; number: number }): Promise<void> {
  await ok('floor.settings.set', { session, repo, project, default_cwd: TOY_DIR });
}

test('the floor’s boards are the GitHub Project’s columns and cards (read only, JeffreyVdb/herdr-3d, project 2)', async ({ page }) => {
  test.setTimeout(240_000);
  await link(REAL, { owner: 'JeffreyVdb', number: 2 });
  await open(page);
  await enter(page, session);
  await expect.poll(async () => (await wall(page))?.issues.length ?? 0, { timeout: 90_000, message: 'the real board arrived' }).toBeGreaterThan(3);
  await faceBoard(page, session, 'issues', 3.2);
  await frames(page, 10);
  await snap(page, 'm7-live-herdr-3d-corkboard');
  await faceBoard(page, session, 'prs', 3.2);
  await snap(page, 'm7-live-herdr-3d-prboard');

  await page.evaluate(() => window.__h3d.openBoard('issues'));
  await expect.poll(async () => (await board(page))?.kind).toBe('issues');
  await page.waitForTimeout(400);
  await snap(page, 'm7-live-herdr-3d-issues-overlay');
  const b = (await board(page))!;
  expect(b.notice).toBeNull();
  const onBoard = new Map<number, string>();
  for (const c of b.columns) for (const k of c.keys) onBoard.set(Number(k.slice(1)), c.name);

  // The same, from `gh`: every card's column is the item's Status, and every open issue is on the board.
  const items = (JSON.parse(gh(['project', 'item-list', '2', '--owner', 'JeffreyVdb', '--limit', '300', '--format', 'json'])) as { items: Array<{ content: { type: string; number: number; repository?: string }; status?: string }> }).items;
  const status = new Map(items.filter((i) => i.content.type === 'Issue' && (i.content.repository ?? REAL).endsWith('herdr-3d')).map((i) => [i.content.number, i.status ?? '']));
  const openNumbers = (JSON.parse(gh(['issue', 'list', '-R', REAL, '--state', 'open', '--limit', '200', '--json', 'number'])) as Array<{ number: number }>).map((i) => i.number);
  const wrong: string[] = [];
  for (const [n, col] of onBoard) {
    const want = status.get(n);
    if (col === 'No status' ? want !== undefined && want !== '' : want !== col) wrong.push(`#${n}: game "${col}", gh "${want ?? 'not in the project'}"`);
  }
  const missing = openNumbers.filter((n) => !onBoard.has(n));
  test.info().annotations.push({ type: 'columns', description: JSON.stringify(b.columns.map((c) => [c.name, c.keys.length])) });
  expect({ wrong, missing }).toEqual({ wrong: [], missing: [] });
  // The columns are the project field's options, in its order (the "No status" one only when a card has none).
  const optionNames = ['Todo', 'Doing', 'QA', 'Done'];
  expect(b.columns.map((c) => c.name).filter((n) => n !== 'No status')).toEqual(optionNames);
  const pr = await page.evaluate(() => window.__h3d.boards());
  test.info().annotations.push({ type: 'wall', description: JSON.stringify({ issues: pr?.issues.length, prs: pr?.prs.length }) });
});

test('writes on the lab repository from the game: comment, move, close, hand to a worker, Open PR, merge', async ({ page }) => {
  test.setTimeout(900_000);
  const [a, b] = issues as [(typeof issues)[number], (typeof issues)[number]];
  const idOf = (n: number) => `${lab}#${n}`;
  await link(lab, { owner: 'JeffreyVdb', number: 3 });
  await open(page);
  await enter(page, session);
  await expect.poll(async () => (await wall(page))?.issues.some((n) => n.id === idOf(a.number)) ?? false, { timeout: 90_000, message: 'the lab board arrived' }).toBe(true);

  // ---- comment, Move to…, Close issue… on probe A --------------------------------------------------------
  await page.evaluate((id) => window.__h3d.openBoardItem('issues', id), idOf(a.number));
  await expect.poll(async () => (await board(page))?.item?.state, { timeout: 30_000 }).toBe('ready');
  const modal = page.locator('dialog.desk-dlg--item');
  const text = `m7 live comment ${Date.now()}`;
  await modal.locator('#bd-comment').fill(text);
  await modal.locator('[data-key="comment"]').click();
  await expect.poll(async () => (await sent(page, 'issue.comment')).length, { timeout: 60_000 }).toBe(1);
  await expect(modal.locator('.bd-comment', { hasText: text })).toBeVisible({ timeout: 30_000 });
  expect((JSON.parse(gh(['issue', 'view', String(a.number), '-R', lab, '--json', 'comments'])) as { comments: Array<{ body: string }> }).comments.map((c) => c.body)).toContain(text);

  await modal.locator('[data-key="move-to"]').selectOption({ label: 'Doing' });
  await modal.locator('[data-key="move"]').click();
  await expect.poll(async () => (await sent(page, 'issue.set_status')).length, { timeout: 60_000 }).toBe(1);
  const statusOf = (n: number) => (JSON.parse(gh(['project', 'item-list', '3', '--owner', 'JeffreyVdb', '--limit', '200', '--format', 'json'])) as { items: Array<{ content: { number: number }; status?: string }> }).items.find((i) => i.content.number === n)?.status;
  // `gh project item-list` is eventually consistent for a while after a write.
  await expect.poll(async () => statusOf(a.number), { timeout: 150_000, intervals: [3000] }).toBe('Doing');
  await expect.poll(async () => (await board(page))?.columns.find((c) => c.name === 'Doing')?.keys ?? [], { timeout: 60_000 }).toContain(`#${a.number}`);

  await modal.locator('[data-key="close-issue"]').click();
  await modal.locator('[data-key="reason:not_planned"]').check({ force: true });
  await modal.locator('[data-key="close-confirm"]').click();
  await expect.poll(async () => (await sent(page, 'issue.close')).length, { timeout: 60_000 }).toBe(1);
  await expect
    .poll(() => JSON.parse(gh(['issue', 'view', String(a.number), '-R', lab, '--json', 'state,stateReason'])) as { state: string; stateReason: string }, { timeout: 30_000 })
    .toEqual({ state: 'CLOSED', stateReason: 'NOT_PLANNED' });
  await expect.poll(async () => (await board(page))?.item ?? null).toBeNull();
  // GitHub closes the issue; the Project's Status is the project's own business (its workflows may move it to Done, ours does
  // not): the card stays in its column, now closed.
  await expect(page.locator(`dialog.desk-dlg--board .bd-card[data-id="${idOf(a.number)}"]`)).toHaveAttribute('data-state', 'closed', { timeout: 120_000 });
  await page.keyboard.press('Escape');
  await faceBoard(page, session, 'issues', 3.2);
  await snap(page, 'm7-live-lab-corkboard');

  // ---- Hand to a worker on probe B: a cheap Codex orchestrator and a harmless prompt (never /write-code) --------
  await page.evaluate((id) => window.__h3d.openBoardItem('issues', id), idOf(b.number));
  await expect.poll(async () => (await board(page))?.item?.state, { timeout: 30_000 }).toBe('ready');
  await modal.locator('[data-key="hand"]').click();
  await expect.poll(async () => { const d = await page.evaluate(() => window.__h3d.dialog()); return d?.kind === 'start-run' && d.state === 'ready' && !d.preparing; }, { timeout: 60_000 }).toBe(true);
  const dlg = page.locator('dialog.desk-dlg--run');
  await dlg.locator('[data-key="orch-harness:codex"]').check({ force: true });
  await dlg.locator('[data-key="orch-model:gpt-6-luna"]').check({ force: true });
  await dlg.locator('[data-key="orch-effort:low"]').check({ force: true });
  await expect.poll(async () => { const d = await page.evaluate(() => window.__h3d.dialog()); return d?.kind === 'start-run' && !d.preparing; }).toBe(true);
  const worktree = dlg.locator('#run-worktree');
  if (await worktree.isChecked()) await worktree.uncheck({ force: true });
  await dlg.locator('#run-prompt').fill('Reply with exactly the word: pong');
  const d = (await page.evaluate(() => window.__h3d.dialog())) as { ticket: { kind: string }; blocker: string | null };
  expect(d.ticket.kind).toBe('work_item');
  expect(d.blocker).toBeNull();
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect.poll(async () => (await sent(page, 'run.start')).length, { timeout: 120_000 }).toBe(1);
  const start = (await sent(page, 'run.start'))[0] as { args: Record<string, unknown>; result?: { ok: boolean; code?: string } };
  expect(start.args).toMatchObject({ session, work_item: { provider: 'github', id: idOf(b.number) }, orch: { harness: 'codex', model: 'gpt-6-luna', effort: 'low' } });
  expect(start.args).not.toHaveProperty('issue');
  await expect.poll(async () => (await sent(page, 'run.start'))[0]?.result?.ok, { timeout: 120_000 }).toBe(true);
  // The peel-off, and the holder on the note (the orchestrator's `work_item`, linked before the ack).
  await expect.poll(async () => JSON.stringify((await wall(page))?.flightLog ?? []), { timeout: 30_000 }).toContain(idOf(b.number));
  // The orchestrator holds the card (its `work_item`, linked before the ack): the overlay's card names it. (The wall shows four
  // notes a column, and the lab project's "No status" column is full of earlier probes: the overlay lists them all.)
  await page.evaluate(() => window.__h3d.openBoard('issues'));
  await expect(page.locator(`dialog.desk-dlg--board .bd-card[data-id="${idOf(b.number)}"] .bd-holder`)).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press('Escape');
  const orch = (await page.evaluate(() => window.__h3d.world().flatMap((f) => f.workers).filter((w) => w.label.startsWith('ORCH|'))))[0];
  expect(orch, 'the orchestrator is on the floor').toBeTruthy();
  const linked = await snapshotWorker(orch!.id);
  expect(linked).toMatchObject({ role: 'orch', work_item: { provider: 'github', id: idOf(b.number) }, issue: { repo: lab, number: b.number } });
  await snap(page, 'm7-live-lab-hand-to-worker');
  await ok('worker.fire', { id: orch!.id, worktree: 'keep' });

  // ---- Open PR for a plain worker, then merge it ---------------------------------------------------------------
  const hired = (await ok('worker.hire', { session, desk_index: 3, harness: 'codex', model: 'gpt-6-luna', effort: 'low', cwd: TOY_DIR, worktree: true, label: 'm7-plain' })) as { id: string; branch: string };
  created.branches.push(hired.branch);
  saveCreated();
  const w = await snapshotWorker(hired.id);
  const checkout = (w?.worktree as { checkout_path?: string } | undefined)?.checkout_path;
  expect(checkout, 'the hire has a checkout').toBeTruthy();
  const tag = hired.branch.replace(/\W+/g, '-');
  writeFileSync(join(checkout as string, `m7-live-${tag}.txt`), 'a probe made by pnpm test:live:m7\n');
  const git = (args: string[]) => execFileSync('git', ['-C', checkout as string, ...args], { encoding: 'utf8' });
  git(['add', '-A']);
  git(['commit', '-q', '-m', `m7 live probe ${tag}`]);
  await expect.poll(async () => (await wall(page))?.prs.length !== undefined, { timeout: 30_000 }).toBe(true);
  await page.evaluate((id) => window.__h3d.openChanges(id), hired.id);
  const openPr = page.locator('dialog.changes [data-key="open-pr"]');
  await expect(openPr).toBeVisible({ timeout: 60_000 });
  await openPr.click();
  await expect.poll(async () => { const s = await page.evaluate(() => window.__h3d.dialog()); return s?.kind === 'open-pr' && s.state; }, { timeout: 60_000 }).toBe('ready');
  const prep = (await page.evaluate(() => window.__h3d.dialog())) as { branch: string; base: string; ahead: number; title: string; blocker: string | null };
  expect(prep).toMatchObject({ branch: hired.branch, base: 'main', ahead: 1, title: `m7 live probe ${tag}`, blocker: null });
  await snap(page, 'm7-live-lab-open-pr');
  await page.locator('dialog.desk-dlg--openpr [data-key="confirm"]').click();
  await expect.poll(async () => { const s = await page.evaluate(() => window.__h3d.dialog()); return s?.kind === 'open-pr' ? s.result : null; }, { timeout: 120_000 }).toMatchObject({ pushed: true, existed: false });
  const made = JSON.parse(gh(['pr', 'list', '-R', lab, '--head', hired.branch, '--state', 'all', '--json', 'number,url,state'])) as Array<{ number: number; url: string; state: string }>;
  expect(made).toHaveLength(1);
  const prNumber = (made[0] as { number: number }).number;
  created.prs.push(prNumber);
  saveCreated();
  await page.locator('dialog.desk-dlg--openpr [data-key="cancel"]').click();
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await wall(page))?.prs.some((n) => n.id === idOf(prNumber)) ?? false, { timeout: 120_000, message: 'the new PR is on the PR board' }).toBe(true);
  await faceBoard(page, session, 'prs', 3.2);
  await snap(page, 'm7-live-lab-prboard');

  // The lab repository has no CI: `checks: none` is not green, so Merge is off and the override asks twice.
  await page.evaluate((id) => window.__h3d.openBoardItem('prs', id), idOf(prNumber));
  await expect.poll(async () => (await board(page))?.item?.state, { timeout: 30_000 }).toBe('ready');
  await expect(modal.locator('[data-key="merge"]')).toHaveAttribute('aria-disabled', 'true');
  await modal.locator('[data-key="merge-anyway"]').click();
  await modal.locator('[data-key="merge-override-1"]').click();
  await snap(page, 'm7-live-lab-merge-override');
  await modal.locator('[data-key="merge-override-2"]').click();
  await expect.poll(async () => (await sent(page, 'pr.merge')).length, { timeout: 120_000 }).toBe(1);
  expect(((await sent(page, 'pr.merge'))[0] as { args: unknown }).args).toEqual({ session, id: idOf(prNumber), method: 'squash', confirm: true, override: true, confirm_override: true });
  await expect.poll(async () => (JSON.parse(gh(['pr', 'view', String(prNumber), '-R', lab, '--json', 'state'])) as { state: string }).state, { timeout: 60_000 }).toBe('MERGED');
  // The next poll announces the merge once: the gong rings, the note flies off.
  await expect.poll(async () => (await wall(page))?.gongRings, { timeout: 120_000, message: 'the gong rang' }).toBe(1);
  await expect.poll(async () => JSON.stringify((await wall(page))?.flightLog), { timeout: 15_000, message: 'the merged note flew off' }).toContain(idOf(prNumber));
  await page.waitForTimeout(3000);
  expect((await wall(page))?.gongRings).toBe(1);

  // ---- the audit log has a row for each write, and no comment or PR body ---------------------------------------------
  if (existsSync(DB)) {
    const rows = execFileSync('sqlite3', [DB, "select cmd, ok, args from audit_log where cmd in ('issue.comment','issue.set_status','issue.close','run.start','worker.open_pr','pr.merge')"], { encoding: 'utf8' });
    for (const cmd of ['issue.comment', 'issue.set_status', 'issue.close', 'run.start', 'worker.open_pr', 'pr.merge']) expect(rows, cmd).toContain(`${cmd}|1|`);
    expect(rows).not.toContain(text);
    expect(rows).toContain('override');
    writeFileSync(join(OUT, 'audit.txt'), rows.split('\n').map((r) => r.slice(0, 220)).join('\n'));
  }
  await ok('worker.fire', { id: hired.id, worktree: 'delete_branch' }).catch(() => undefined);
  readFileSync(join(OUT, 'created.json'), 'utf8');
});
