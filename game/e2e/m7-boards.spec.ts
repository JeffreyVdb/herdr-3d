import { expect, test } from '@playwright/test';
import { tint, paperOf } from '../src/world/boards';
import { frames, openGame, shot, watchErrors, openMenu } from './game';
import { board, columns, enter, faceBoard, wall, waitNotes, type Wall } from './m7';

// M7: the issues corkboard, the pull request board and the merge gong, on demo-m6 with the simulating fixture server
// (tools/fixture-boards.ts): the `lab` floor (repo JeffreyVdb/lab, a project: Todo / Doing / QA / Done) and `herdr-3d`
// (repo JeffreyVdb/herdr-3d) have boards; `depot-manager` (asleep) has a repo without a project (Open / Closed);
// `pastry` has no repo. `open=none` keeps window.open quiet.

const SIM = 'play=none&sim=1&simms=150&simusage=0';
const EXTRA = '&open=none';

test('the corkboard shows the provider’s columns and cards, and E on it opens the overlay', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', EXTRA, SIM);
  await enter(page);
  await waitNotes(page, 8, 2);
  const w = (await wall(page)) as Wall;
  // The floor was watched once, and only it; the game asked before it drew.
  expect(w).toMatchObject({ session: 'lab', watched: 'lab', off: null, batches: 2 });
  expect(await page.evaluate(() => window.__h3d.boardLog().map((l) => [l.t, (l.args as { session: string }).session]))).toEqual([['board.watch', 'lab']]);
  // One note per card of the visible columns, each in its own cell of the one atlas, tinted by the first non-priority label.
  expect(w.issues.map((n) => n.id).sort()).toEqual(['JeffreyVdb/lab#1', 'JeffreyVdb/lab#2', 'JeffreyVdb/lab#3', 'JeffreyVdb/lab#4', 'JeffreyVdb/lab#5', 'JeffreyVdb/lab#6', 'JeffreyVdb/lab#7', 'JeffreyVdb/lab#8']);
  expect(new Set(w.issues.map((n) => n.cell)).size).toBe(8);
  const face = (id: string) => w.issues.find((n) => n.id === id)?.face as { key: string; paper: string; pin: string; holder: { name: string } | null; done: boolean };
  // #3 is urgent (red pin) and held by the over-cap orchestrator on the floor; its paper is the `bug` label's, not `urgent`'s.
  expect(face('JeffreyVdb/lab#3')).toMatchObject({ key: '#3', pin: '#e8413a', holder: { name: expect.any(String) }, done: false });
  expect(face('JeffreyVdb/lab#3').paper).toBe(tint('#d73a4a', 0.55));
  expect(face('JeffreyVdb/lab#3').paper).toBe(paperOf({ labels: [{ name: 'urgent', color: '#e11d21' }, { name: 'bug', color: '#d73a4a' }] }));
  expect(face('JeffreyVdb/lab#4').holder).not.toBeNull();
  expect(face('JeffreyVdb/lab#5').holder).toBeNull();
  expect(face('JeffreyVdb/lab#5').pin).toBe('#f4f4f0');
  expect(face('JeffreyVdb/lab#1').done).toBe(true);
  expect(face('JeffreyVdb/lab#5').paper).not.toBe(face('JeffreyVdb/lab#7').paper);

  // Looking at it: the prompt is "Issues board · E Open" with what the provider says.
  await faceBoard(page, 'lab', 'issues');
  expect(await page.evaluate(() => window.__h3d.lookAt())).toMatchObject({ kind: 'board', id: 'board.issues' });
  const prompt = page.locator('.prompt');
  await expect(prompt).toContainText('Issues board');
  await expect(prompt).toContainText('GitHub · 6 open');
  await expect(prompt.locator('.key').first()).toHaveText('EOpen');
  await expect(prompt.locator('[aria-disabled="true"]')).toHaveCount(0);
  await shot(page, 'm7-corkboard-lab');

  await page.keyboard.press('e');
  await expect.poll(async () => (await board(page))?.kind).toBe('issues');
  const b = (await board(page))!;
  expect(b).toMatchObject({ session: 'lab', title: 'Issues · lab', provider: 'GitHub', notice: null, off: null });
  expect(await columns(page)).toEqual({ Todo: ['#7', '#6', '#5'], Doing: ['#3', '#4'], QA: ['#8'], Done: ['#2', '#1'] });
  await expect(page.locator('dialog.desk-dlg--board .dd-titles p')).toContainText('lab · GitHub · 6 open');
  await shot(page, 'm7-issues-overlay');
  await page.keyboard.press('Escape');
  await expect.poll(async () => await board(page)).toBeNull();

  // The PR board: Prompt says "Pull requests · E Open".
  await faceBoard(page, 'lab', 'prs');
  expect(await page.evaluate(() => window.__h3d.lookAt())).toMatchObject({ kind: 'board', id: 'board.prs' });
  await expect(prompt).toContainText('Pull requests');
  await expect(prompt).toContainText('GitHub · 2 open');
  await page.keyboard.press('e');
  await expect.poll(async () => (await board(page))?.kind).toBe('prs');
  expect(await columns(page)).toEqual({ Open: ['#9', '#10'] });
  await shot(page, 'm7-prs-overlay');
  clean();
});

test('the wall boards are two instanced batches with one atlas each; PR notes carry CI, review, closes and the verdict stamp', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', EXTRA, SIM);
  await enter(page);
  await waitNotes(page, 8, 2);
  const w = (await wall(page)) as Wall;
  expect(w.batches).toBe(2);
  type Pr = { key: string; branch: string; checks: string; review: string; closes: string; draft: boolean; stamp: { tone: string; text: string } | null };
  const pr = (key: string) => w.prs.map((n) => n.face as Pr).find((f) => f.key === key) as Pr;
  // #9 closes #3 (on the issue board, so it is named) and runs under the over-cap orchestrator: its freelancers reviewed it.
  expect(pr('#9')).toMatchObject({ branch: 'h3d/overcap-fix', checks: 'failure', review: 'changes_requested', closes: 'closes #3', draft: false });
  expect(pr('#9').stamp).not.toBeNull();
  // #10 closes #4, whose run has only an INCOMPLETE review.
  expect(pr('#10')).toMatchObject({ checks: 'pending', review: 'none', closes: 'closes #4' });
  expect(pr('#10').stamp).toMatchObject({ tone: 'incomplete', text: 'INCOMPLETE' });
  await faceBoard(page, 'lab', 'prs');
  await shot(page, 'm7-prboard-lab');
  clean();
});

test('the Issues and PRs buttons open the overlays from anywhere on the floor', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', EXTRA, SIM);
  await enter(page);
  await waitNotes(page, 8, 2);
  // Far from the board wall: at a desk in the north.
  await page.evaluate(() => {
    const s = window.__h3d.layout('lab')?.slots[0];
    if (s) window.__h3d.setPose({ x: s.seat.x, z: s.seat.z - 1, yaw: 0, pitch: 0 });
  });
  await frames(page, 3);
  await openMenu(page);
  await page.locator('.topbar button', { hasText: 'Issues' }).click();
  await expect.poll(async () => (await board(page))?.kind).toBe('issues');
  await expect(page.locator('dialog.desk-dlg--board h2')).toHaveText('Issues · lab');
  await page.keyboard.press('Escape');
  await expect.poll(async () => await board(page)).toBeNull();
  await openMenu(page);
  await page.locator('.topbar button', { hasText: 'PRs' }).click();
  await expect.poll(async () => (await board(page))?.kind).toBe('prs');
  await expect(page.locator('dialog.desk-dlg--board h2')).toHaveText('Pull requests · lab');
  // Provider-neutral copy: the provider's own name comes from the bridge.
  await expect(page.locator('dialog.desk-dlg--board .dd-titles p')).toContainText('GitHub');
  clean();
});

test('a floor without a project shows Open and Closed, and a floor without a repo says so', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', EXTRA, SIM);
  await enter(page, 'depot-manager');
  await waitNotes(page, 4, 1);
  await openMenu(page);
  await page.locator('.topbar button', { hasText: 'Issues' }).click();
  await expect.poll(async () => (await board(page))?.kind).toBe('issues');
  expect(await columns(page)).toEqual({ Open: ['#2', '#1', '#3'], Closed: ['#4'] });
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__h3d.leaveFloor());
  await enter(page, 'pastry');
  await expect.poll(async () => (await wall(page))?.off).toBe('No board on this floor');
  await faceBoard(page, 'pastry', 'issues');
  await shot(page, 'm7-no-repo');
  await openMenu(page);
  await page.locator('.topbar button', { hasText: 'Issues' }).click();
  await expect(page.locator('dialog.desk-dlg--board .bd-off h3')).toHaveText('No board on this floor');
  await expect(page.locator('dialog.desk-dlg--board .bd-off p')).toContainText('No repo linked');
  clean();
});

test('an older bridge: boards say “Update the bridge to use boards”, the buttons are off, and nothing errors', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', EXTRA, `${SIM}&simfail=no_m7`);
  await enter(page);
  await expect.poll(async () => (await wall(page))?.off).toBe('Update the bridge to use boards');
  expect((await wall(page))?.issues).toEqual([]);
  await faceBoard(page, 'lab', 'issues');
  await expect(page.locator('.prompt')).toContainText('Update the bridge to use boards');
  await expect(page.locator('.prompt [aria-disabled="true"]')).toContainText('Open');
  await shot(page, 'm7-old-bridge');
  const issues = page.locator('.topbar button', { hasText: 'Issues' });
  await expect(issues).toHaveAttribute('aria-disabled', 'true');
  // aria-disabled, not disabled: it stays clickable to say why.
  await openMenu(page);
  await issues.click({ force: true });
  await expect(page.locator('.toast')).toContainText('Update the bridge to use boards');
  expect(await board(page)).toBeNull();
  await page.keyboard.press('e');
  expect(await board(page)).toBeNull();
  // It asked once; an answer of unknown_command is remembered (no polling for a bridge that cannot).
  expect(await page.evaluate(() => window.__h3d.boardLog().filter((l) => l.t === 'board.watch').length)).toBe(1);
  clean();
});

test('the game watches the floor you are on and only that one, again after a reconnect, and not once you leave', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', EXTRA, SIM);
  const log = () => page.evaluate(() => window.__h3d.boardLog().map((l) => `${l.t}:${(l.args as { session: string }).session}`));
  expect(await log()).toEqual([]);
  await enter(page, 'lab');
  await waitNotes(page, 8, 2);
  await page.evaluate(() => window.__h3d.reconnect());
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.connection().phase))).toBe('live');
  await expect.poll(async () => (await log()).filter((x) => x.startsWith('board.watch')).length).toBe(2);
  await waitNotes(page, 8, 2);
  await page.evaluate(() => window.__h3d.leaveFloor());
  await expect.poll(async () => (await log()).at(-1)).toBe('board.unwatch:lab');
  expect(await wall(page)).toBeNull();
  await enter(page, 'herdr-3d');
  await expect.poll(async () => (await log()).at(-1)).toBe('board.watch:herdr-3d');
  // Four notes a column at most: Todo 4 of 9, Doing 2, QA 2, Done 3.
  await waitNotes(page, 11, 4);
  // Never two floors at once: every watch is a floor you stood on.
  expect((await log()).filter((x) => x.startsWith('board.watch')).map((x) => x.split(':')[1])).toEqual(['lab', 'lab', 'herdr-3d']);
  clean();
});

test('a board update animates by diff and never rebuilds the floor; a quiet poll writes nothing', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', EXTRA, SIM);
  await enter(page);
  await waitNotes(page, 8, 2);
  await faceBoard(page, 'lab', 'issues');
  await frames(page, 30);
  const before = (await wall(page)) as Wall;
  const at = (w: Wall, id: string) => w.issues.find((n) => n.id === id) as Wall['issues'][number];
  // A poll with nothing new draws nothing: the buffers are not written, the atlas not redrawn.
  await page.evaluate(() => window.__h3d.simBoards({ poll: true }));
  await frames(page, 20);
  const same = (await wall(page)) as Wall;
  expect(same.issuesWrites).toBe(before.issuesWrites);
  expect(same.prsWrites).toBe(before.prsWrites);
  expect(same.office).toBe(before.office);
  // A card moved by someone else (Todo → QA): the note slides to its new column; the office is the same object.
  const x0 = at(before, 'JeffreyVdb/lab#5').x;
  await page.evaluate(() => window.__h3d.simBoards({ card: { id: 'JeffreyVdb/lab#5', column: '64e1b0ac' } }));
  await expect.poll(async () => at((await wall(page)) as Wall, 'JeffreyVdb/lab#5').x).toBeGreaterThan(x0 + 0.3);
  await frames(page, 45);
  const after = (await wall(page)) as Wall;
  expect(after.office).toBe(before.office);
  expect(after.issues).toHaveLength(8);
  expect(new Set(after.issues.map((n) => n.cell)).size).toBe(8);
  // A stale poll keeps every card and says so.
  await page.evaluate(() => window.__h3d.simBoards({ fail: 'GitHub auth' }));
  await expect.poll(async () => (await wall(page))?.issues.length).toBe(8);
  await openMenu(page);
  await page.locator('.topbar button', { hasText: 'Issues' }).click();
  await expect.poll(async () => (await board(page))?.notice).toContain('GitHub did not answer (GitHub auth)');
  expect((await columns(page)).QA).toContain('#5');
  clean();
});

test('a click on a holder’s tag on a wall note goes to that worker’s transcript', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', EXTRA, SIM);
  await enter(page);
  await waitNotes(page, 8, 2);
  // Close in on the board: the tag is a few pixels, so find one by sweeping the viewport.
  await faceBoard(page, 'lab', 'issues', 1.6);
  const size = page.viewportSize() as { width: number; height: number };
  const hit = await page.evaluate(() => {
    for (let y = 1; y > -1; y -= 0.01) for (let x = -1; x < 1; x += 0.01) {
      const id = window.__h3d.holderAt(x, y);
      if (id) return { id, x, y };
    }
    return null;
  });
  expect(hit, 'a holder tag on screen').not.toBeNull();
  const h = hit as { id: string; x: number; y: number };
  const px = ((h.x + 1) / 2) * size.width;
  const py = ((1 - h.y) / 2) * size.height;
  await page.mouse.move(px, py);
  await expect.poll(() => page.evaluate(() => document.querySelector('canvas')?.style.cursor)).toBe('pointer');
  await page.mouse.click(px, py);
  await expect.poll(() => page.evaluate(() => window.__h3d.seated()), { timeout: 15_000 }).toBe(h.id);
  expect((await page.evaluate(() => window.__h3d.seat())).mode).toBe('transcript');
  clean();
});
