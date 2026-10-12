import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, shot, watchErrors } from './game';
import { board, enter, faceBoard, wall } from './m7';

// M7 actions on demo-m6 with the simulating fixture server (tools/fixture-boards.ts): the issue and PR modals, their
// actions and the commands they send. Every write is checked as the wire the contract defines (`confirm: true`, the
// opaque ids, `override` + `confirm_override` on the second confirmation).

const SIM = 'play=none&sim=1&simms=150&simusage=0';
const EXTRA = '&open=none';
const lab = 'JeffreyVdb/lab';
const HERDR = 'JeffreyVdb/herdr-3d';

type Item = NonNullable<NonNullable<Awaited<ReturnType<Window['__h3d']['board']>>>['item']>;

const sent = (page: Page) => page.evaluate(() => window.__h3d.sent());
const sentOf = async (page: Page, t: string) => (await sent(page)).filter((c) => c.t === t);
const item = async (page: Page): Promise<Item> => ((await board(page))?.item ?? ({} as Item)) as Item;

async function openItem(page: Page, which: 'issues' | 'prs', id: string): Promise<Item> {
  await page.evaluate(([w, i]) => window.__h3d.openBoardItem(w as 'issues' | 'prs', i as string), [which, id] as const);
  await expect.poll(async () => (await item(page)).state, { message: `${id} loaded`, timeout: 10_000 }).toBe('ready');
  return item(page);
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

const modal = (page: Page) => page.locator('dialog.desk-dlg--item');
const act = (page: Page, key: string) => modal(page).locator(`[data-key="${key}"]`);

test('an issue’s markdown is sanitised: nothing runs, no on* or javascript: survives, links are external', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  // The Mac helper's endpoint, faked: the link goes through it, with the header (never the URL) carrying the token.
  const asked: Array<{ body: unknown; token: string | undefined; method: string }> = [];
  await page.route('**/api/open', async (route) => {
    const r = route.request();
    asked.push({ body: r.postDataJSON(), token: r.headers()['x-h3d-token'], method: r.method() });
    await route.fulfill({ status: 204 });
  });
  // Served by the helper the page has its token (the helper opens the game with it): the game asks the helper.
  await page.addInitScript(() => localStorage.setItem('h3d.token', 'tok-7'));
  await openGame(page, 'demo-m6', EXTRA, SIM);
  await enter(page);
  await openItem(page, 'issues', `${lab}#7`);
  await page.waitForTimeout(700);
  const seen = await page.evaluate(() => {
    const roots = [...document.querySelectorAll('.desk-dlg--item .bd-md')];
    const all = roots.flatMap((r) => [...r.querySelectorAll('*')]);
    return {
      xss: (window as unknown as { __xss?: unknown }).__xss ?? null,
      roots: roots.length,
      banned: roots.flatMap((r) => [...r.querySelectorAll('script, iframe, svg, form, img, style, input, button, object, embed, link, meta')]).map((e) => e.tagName),
      handlers: all.flatMap((e) => [...e.attributes].map((a) => a.name).filter((n) => n.startsWith('on') || n === 'style' || n === 'class')),
      hrefs: all.filter((e) => e.tagName === 'A').map((e) => [e.getAttribute('href'), e.getAttribute('target'), e.getAttribute('rel')] as const),
      text: roots[0]?.textContent ?? '',
      hasTable: !!roots[0]?.querySelector('table td'),
      hasCode: !!roots[0]?.querySelector('pre code'),
      bold: roots[0]?.querySelector('strong')?.textContent ?? null,
    };
  });
  // Two bodies: the issue's and the second comment (the same probe from a stranger).
  expect(seen.roots).toBe(3);
  expect(seen.xss).toBeNull();
  expect(seen.banned).toEqual([]);
  expect(seen.handlers).toEqual([]);
  // The `javascript:` link lost its href altogether (it is text now); every link that is left goes out safely.
  expect(seen.hrefs.some(([href]) => href === null)).toBe(true);
  for (const [href, target, rel] of seen.hrefs.filter(([href]) => href !== null)) {
    expect(href).toMatch(/^(https?:|mailto:)/i);
    expect(href).not.toMatch(/^javascript:/i);
    expect(target).toBe('_blank');
    expect(rel).toBe('noopener noreferrer');
  }
  // The safe parts render; the tracking pixel is only a link, the `javascript:` link lost its href.
  expect(seen.hrefs.map((h) => h[0])).toEqual(expect.arrayContaining(['https://example.com/docs', 'https://evil.example/pixel.png']));
  expect(seen.text).toContain('Markdown probe');
  expect(seen.bold).toBe('bold');
  expect(seen.hasTable).toBe(true);
  expect(seen.hasCode).toBe(true);
  expect(seen.text).toContain('click me');
  await shot(page, 'm7-issue-modal-xss');
  // A click on a link goes to the helper: nothing navigates the game.
  await modal(page).locator('a[href="https://example.com/docs"]').first().click();
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.opened())).length).toBe(1);
  expect(await page.evaluate(() => window.__h3d.opened())).toEqual([{ url: 'https://example.com/docs', via: 'helper' }]);
  expect(asked).toEqual([{ method: 'POST', token: 'tok-7', body: { url: 'https://example.com/docs' } }]);
  expect(new URL(page.url()).pathname).toBe('/');
  expect((await page.evaluate(() => (window as unknown as { __xss?: unknown }).__xss)) ?? null).toBeNull();
  clean();
});

test('Open in the provider: through the helper when there is one, a new window when not; hidden when the card has no page', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', EXTRA, SIM);
  await enter(page);
  const it = await openItem(page, 'issues', `${lab}#5`);
  expect(it.actions).toContain('open');
  await expect(act(page, 'open')).toHaveText('Open in GitHub');
  // No helper on this page (the preview server has no /api/open): the game opens the page itself.
  await act(page, 'open').click();
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.opened())).length).toBe(1);
  expect(await page.evaluate(() => window.__h3d.opened())).toEqual([{ url: `https://github.com/${lab}/issues/5`, via: 'window' }]);
  clean();
});

test('Hand to a worker: the start-run dialog with the card as work_item, the last team, the desk nearest you; then the note peels off to the desk', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', EXTRA, SIM);
  await enter(page, 'herdr-3d');
  await expect.poll(async () => (await wall(page))?.issues.length).toBe(11);
  // Desks 5 and 12 are free: the first free one is 5, but you stand by 12.
  await standAt(page, 'herdr-3d', 12);
  const it = await openItem(page, 'issues', `${HERDR}#12`);
  expect(it.actions.slice(0, 2)).toEqual(['hand', 'ask']);
  await act(page, 'hand').click();
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.dialog()))?.kind).toBe('start-run');
  await expect.poll(async () => { const d = (await page.evaluate(() => window.__h3d.dialog())) as { state: string; preparing: boolean }; return d.state === 'ready' && !d.preparing; }).toBe(true);
  const d = (await page.evaluate(() => window.__h3d.dialog())) as { session: string; desk: number; ticket: { kind: string; item: { id: string; key: string; title: string } }; form: { preset: string; workItem: { id: string } | null; ticket: string }; ticketLine: string; blocker: string | null; title: string };
  expect(d).toMatchObject({ session: 'herdr-3d', desk: 12, title: 'Start a run at Desk 13', blocker: null });
  expect(d.ticket).toMatchObject({ kind: 'work_item', item: { id: `${HERDR}#12`, key: '#12' } });
  expect(d.ticketLine).toBe('#12 · M8: Lounge, coffee machine and the wandering worker');
  expect(d.form).toMatchObject({ preset: 'p_5eedb0000001', ticket: '' });
  await expect(page.locator('dialog.desk-dlg--run .dd-workitem')).toContainText('#12');
  await expect(page.locator('#run-ticket')).toHaveCount(0);
  // The prompt the bridge builds for the card (the simulator: the M6 path with the issue's URL).
  await expect(page.locator('#run-prompt')).toHaveText(new RegExp(`^/write-code https://github.com/${HERDR}/issues/12`));
  await shot(page, 'm7-hand-to-worker');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect.poll(async () => (await sentOf(page, 'run.start')).length).toBe(1);
  const start = (await sentOf(page, 'run.start'))[0]?.args as Record<string, unknown>;
  expect(start).toMatchObject({ session: 'herdr-3d', desk_index: 12, work_item: { provider: 'github', id: `${HERDR}#12` }, preset: 'p_5eedb0000001' });
  expect(start).not.toHaveProperty('issue');
  expect(start).not.toHaveProperty('text');
  // The peel-off: the note leaves the board, flies to the orchestrator's desk, and is back in its column afterwards.
  await expect.poll(async () => ((await wall(page)) as { flights: Array<{ id: string; kind: string }> }).flights.map((f) => `${f.kind}:${f.id}`), { timeout: 15_000 }).toEqual([`peel:${HERDR}#12`]);
  expect(((await wall(page)) as { issues: Array<{ id: string }> }).issues.some((n) => n.id === `${HERDR}#12`)).toBe(false);
  await expect.poll(async () => ((await wall(page)) as { flights: unknown[] }).flights.length, { timeout: 15_000 }).toBe(0);
  expect(((await wall(page)) as { flightLog: Array<{ id: string; kind: string }> }).flightLog).toEqual([{ id: `${HERDR}#12`, kind: 'peel' }]);
  await expect.poll(async () => ((await wall(page)) as { issues: Array<{ id: string }> }).issues.some((n) => n.id === `${HERDR}#12`), { timeout: 15_000 }).toBe(true);
  // The orchestrator now holds it: its avatar and name are on the note.
  await expect.poll(async () => (((await wall(page)) as { issues: Array<{ id: string; face: { holder: { name: string } | null } }> }).issues.find((n) => n.id === `${HERDR}#12`)?.face.holder)?.name ?? null).not.toBeNull();
  clean();
});

test('Ask a worker…: the plain hire dialog at the nearest free desk with the investigate prompt', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', EXTRA, SIM);
  await enter(page, 'herdr-3d');
  await expect.poll(async () => (await wall(page))?.issues.length).toBe(11);
  await standAt(page, 'herdr-3d', 5);
  await openItem(page, 'issues', `${HERDR}#13`);
  await act(page, 'ask').click();
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.dialog()))?.kind).toBe('hire');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.dialog()) as { state: string }).state).toBe('ready');
  const d = (await page.evaluate(() => window.__h3d.dialog())) as { desk: number; form: { prompt: string } };
  expect(d.desk).toBe(5);
  expect(d.form.prompt).toBe(`Investigate #13 (https://github.com/${HERDR}/issues/13) and report back. Don't change code.`);
  await expect(page.locator('#hire-task')).toHaveText(d.form.prompt);
  clean();
});

test('Move to…, comment and Close issue… (confirm and reason) send the contract’s commands', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', EXTRA, SIM);
  await enter(page);
  await expect.poll(async () => (await wall(page))?.issues.length).toBe(8);
  const it = await openItem(page, 'issues', `${lab}#5`);
  expect(it.actions).toEqual(expect.arrayContaining(['hand', 'ask', 'move-to', 'move', 'close-issue', 'open']));
  // Move to… Doing.
  await act(page, 'move-to').selectOption({ label: 'Doing' });
  await act(page, 'move').click();
  await expect.poll(async () => (await sentOf(page, 'issue.set_status')).length).toBe(1);
  expect((await sentOf(page, 'issue.set_status'))[0]?.args).toEqual({ session: 'lab', id: `${lab}#5`, column: 'ae6334b4' });
  await expect(page.locator('.toast')).toHaveText('Moved #5 to Doing.');
  await expect.poll(async () => (await board(page))?.columns.find((c) => c.name === 'Doing')?.keys).toContain('#5');
  // Comment.
  await modal(page).locator('#bd-comment').fill('Looks **good** to me.');
  await modal(page).locator('#bd-comment').press('ControlOrMeta+Enter');
  await expect.poll(async () => (await sentOf(page, 'issue.comment')).length).toBe(1);
  expect((await sentOf(page, 'issue.comment'))[0]?.args).toEqual({ session: 'lab', id: `${lab}#5`, body: 'Looks **good** to me.' });
  await expect.poll(async () => (await item(page)).comments).toBe(2);
  await expect(modal(page).locator('.bd-comment strong', { hasText: 'good' })).toHaveText('good');
  await expect(modal(page).locator('#bd-comment')).toHaveValue('');
  // Close: needs a confirmation, and a reason.
  await act(page, 'close-issue').click();
  await expect(modal(page).locator('.bd-confirm')).toContainText('Close #5 on GitHub?');
  expect((await sentOf(page, 'issue.close')).length).toBe(0);
  await act(page, 'reason:not_planned').check({ force: true });
  await shot(page, 'm7-issue-close-confirm');
  await act(page, 'close-confirm').click();
  await expect.poll(async () => (await sentOf(page, 'issue.close')).length).toBe(1);
  expect((await sentOf(page, 'issue.close'))[0]?.args).toEqual({ session: 'lab', id: `${lab}#5`, reason: 'not_planned', confirm: true });
  await expect.poll(async () => (await item(page)).kind ?? null, { message: 'the modal closed' }).toBeNull();
  // The next poll: it is closed, in Done, and its note has the check mark.
  await expect.poll(async () => (await board(page))?.columns.find((c) => c.name === 'Done')?.keys).toContain('#5');
  await expect.poll(async () => (((await wall(page)) as { issues: Array<{ id: string; face: { done: boolean } }> }).issues.find((n) => n.id === `${lab}#5`)?.face.done)).toBe(true);
  // A closed issue offers no Close, Hand or Ask.
  const closed = await openItem(page, 'issues', `${lab}#5`);
  expect(closed.actions).not.toContain('close-issue');
  expect(closed.actions).not.toContain('hand');
  expect(closed.actions).toContain('open');
  clean();
});

test('actions follow the provider’s capabilities: a floor without a project has no Move to…', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', EXTRA, SIM);
  await enter(page, 'depot-manager');
  await expect.poll(async () => (await wall(page))?.issues.length).toBe(4);
  const open = await openItem(page, 'issues', 'fomra/depot-manager#1');
  expect(open.actions).toContain('close-issue');
  expect(open.actions).not.toContain('move');
  expect(open.actions).not.toContain('move-to');
  // A closed card carries its own capability: no close.
  const closed = await openItem(page, 'issues', 'fomra/depot-manager#4');
  expect(closed.actions).not.toContain('close-issue');
  // The floor is asleep: Hand and Ask are on screen but off, saying why.
  await openItem(page, 'issues', 'fomra/depot-manager#1');
  await expect(act(page, 'hand')).toHaveAttribute('aria-disabled', 'true');
  await expect(act(page, 'hand')).toHaveAttribute('title', /asleep/);
  clean();
});

test('a PR: body, files, checks; Review with a worker hires the last team’s reviewer with the code-review prompt', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', EXTRA, SIM);
  await enter(page, 'herdr-3d');
  await expect.poll(async () => (await wall(page))?.prs.length).toBe(4);
  await standAt(page, 'herdr-3d', 12);
  const it = await openItem(page, 'prs', `${HERDR}#34`);
  // Green checks and mergeable: Merge is on, and there is nothing to override.
  expect(it.actions).toEqual(['review', 'merge-method', 'merge', 'open']);
  await expect(modal(page).locator('.bd-files li')).toHaveCount(3);
  await expect(modal(page).locator('.bd-checks li')).toHaveCount(3);
  await expect(modal(page).locator('.bd-diffstat')).toContainText('+');
  await shot(page, 'm7-pr-modal');
  await act(page, 'review').click();
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.dialog()))?.kind).toBe('hire');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.dialog()) as { state: string }).state).toBe('ready');
  const d = (await page.evaluate(() => window.__h3d.dialog())) as { desk: number; form: { prompt: string; harness: string; model: string; effort: string } };
  // The Build team's reviewer is Codex gpt-6-sol / high: its skill is `$code-review`.
  expect(d.desk).toBe(12);
  expect(d.form).toMatchObject({ prompt: `$code-review https://github.com/${HERDR}/pull/34`, harness: 'codex', model: 'gpt-6-sol', effort: 'high' });
  clean();
});

test('Merge: confirmation first; red checks disable it, and Merge anyway asks twice before it sends override + confirm_override; conflicts never merge', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', EXTRA, SIM);
  await enter(page, 'herdr-3d');
  await expect.poll(async () => (await wall(page))?.prs.length).toBe(4);
  // Conflicts: no override path.
  const conflict = await openItem(page, 'prs', `${HERDR}#35`);
  expect(conflict.actions).toContain('merge');
  expect(conflict.actions).not.toContain('merge-anyway');
  await expect(act(page, 'merge')).toHaveAttribute('aria-disabled', 'true');
  // aria-disabled, not disabled: it stays clickable to say why.
  await act(page, 'merge').click({ force: true });
  await expect(modal(page).locator('.dd-status--error')).toContainText('merge conflicts');
  expect((await sentOf(page, 'pr.merge')).length).toBe(0);

  // Failing checks: Merge is off; Merge anyway is a two-step confirmation.
  await openItem(page, 'prs', `${HERDR}#33`);
  await expect(act(page, 'merge')).toHaveAttribute('aria-disabled', 'true');
  await expect(act(page, 'merge')).toHaveAttribute('title', /checks fail/);
  await act(page, 'merge-anyway').click();
  await expect(modal(page).locator('.bd-confirm')).toHaveAttribute('aria-label', 'Merge #33 anyway');
  expect((await sentOf(page, 'pr.merge')).length).toBe(0);
  await act(page, 'merge-override-1').click();
  await expect(modal(page).locator('.bd-confirm')).toHaveAttribute('aria-label', 'Really merge #33 anyway');
  await shot(page, 'm7-pr-merge-override');
  expect((await sentOf(page, 'pr.merge')).length).toBe(0);
  await act(page, 'merge-cancel').click();
  await expect(modal(page).locator('.bd-confirm')).toHaveCount(0);
  expect((await sentOf(page, 'pr.merge')).length).toBe(0);
  await act(page, 'merge-anyway').click();
  await act(page, 'merge-override-1').click();
  await act(page, 'merge-method').selectOption('rebase');
  await act(page, 'merge-override-2').click();
  await expect.poll(async () => (await sentOf(page, 'pr.merge')).length).toBe(1);
  expect((await sentOf(page, 'pr.merge'))[0]?.args).toEqual({ session: 'herdr-3d', id: `${HERDR}#33`, method: 'squash', confirm: true, override: true, confirm_override: true });
  await expect.poll(async () => (await item(page)).kind ?? null).toBeNull();

  // The happy path: one confirmation, no override fields.
  await openItem(page, 'prs', `${HERDR}#32`);
  await expect(act(page, 'merge')).not.toHaveAttribute('aria-disabled', 'true');
  expect((await item(page)).actions).not.toContain('merge-anyway');
  await act(page, 'merge-method').selectOption('merge');
  await act(page, 'merge').click();
  await expect(modal(page).locator('.bd-confirm')).toContainText('Merge #32 into main (create a merge commit)?');
  expect((await sentOf(page, 'pr.merge')).length).toBe(1);
  await act(page, 'merge-confirm').click();
  await expect.poll(async () => (await sentOf(page, 'pr.merge')).length).toBe(2);
  expect((await sentOf(page, 'pr.merge'))[1]?.args).toEqual({ session: 'herdr-3d', id: `${HERDR}#32`, method: 'merge', confirm: true });
  clean();
});

test('a merge rings the gong once and flies the note off; the replay on watch never rings; the linked issue moves to Done', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', EXTRA, SIM);
  await enter(page, 'herdr-3d');
  await expect.poll(async () => (await wall(page))?.prs.length).toBe(4);
  await faceBoard(page, 'herdr-3d', 'prs');
  expect((await wall(page))?.gongRings).toBe(0);
  // An `initial` message (the cache replayed on a watch) with merges in it: never a gong, no flight.
  const base = { session: 'herdr-3d', provider: 'github', provider_name: 'GitHub', fetched_at: 5, prs: [] as unknown[] };
  await page.evaluate(([b, id]) => window.__h3d.injectBoard({ t: 'board.prs', ...(b as object), initial: true, merged: [{ id, key: '#32', title: 'x', merged_at: 1 }] } as never), [base, `${HERDR}#32`] as const);
  await frames(page, 6);
  expect((await wall(page))?.gongRings).toBe(0);
  expect(((await wall(page)) as { flightLog: unknown[] }).flightLog).toEqual([]);
  // The real thing: merged by a poll, the next poll announces it.
  await page.evaluate(() => window.__h3d.reconnect());
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.connection().phase))).toBe('live');
  await expect.poll(async () => (await wall(page))?.prs.length).toBe(4);
  const todo = ((await wall(page)) as { issues: Array<{ id: string }> }).issues.find((n) => n.id === `${HERDR}#9`);
  expect(todo).toBeTruthy();
  await page.evaluate((id) => window.__h3d.simBoards({ merge: id }), `${HERDR}#32`);
  await expect.poll(async () => (await wall(page))?.gongRings, { timeout: 10_000 }).toBe(1);
  await expect.poll(async () => ((await wall(page)) as { flights: Array<{ kind: string }> }).flights.map((f) => f.kind)).toEqual(['merged']);
  await shot(page, 'm7-gong');
  await expect.poll(async () => ((await wall(page)) as { flightLog: unknown[] }).flightLog.length, { timeout: 10_000 }).toBe(1);
  expect(((await wall(page)) as { prs: unknown[] }).prs).toHaveLength(3);
  // The linked issue (#9) moved to Done by the normal diff (a closed, checked note).
  await expect.poll(async () => (((await wall(page)) as { issues: Array<{ id: string; face: { done: boolean } }> }).issues.find((n) => n.id === `${HERDR}#9`)?.face.done)).toBe(true);
  // Once only: another poll does not ring it again.
  await page.evaluate(() => window.__h3d.simBoards({ poll: true }));
  await frames(page, 15);
  expect((await wall(page))?.gongRings).toBe(1);
  clean();
});

test('two merges in one poll ring the gong twice, one ring each', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', EXTRA, SIM);
  await enter(page, 'herdr-3d');
  await expect.poll(async () => (await wall(page))?.prs.length).toBe(4);
  await faceBoard(page, 'herdr-3d', 'prs');
  expect((await wall(page))?.gongRings).toBe(0);
  const msg = { t: 'board.prs', session: 'herdr-3d', provider: 'github', provider_name: 'GitHub', fetched_at: 9, prs: [], merged: [
    { id: `${HERDR}#32`, key: '#32', title: 'x', merged_at: 1 },
    { id: `${HERDR}#33`, key: '#33', title: 'y', merged_at: 2 },
  ] };
  await page.evaluate((m) => window.__h3d.injectBoard(m as never), msg);
  await expect.poll(async () => (await wall(page))?.gongRings, { timeout: 10_000 }).toBe(2);
  // The same message again announces nothing new.
  await page.evaluate((m) => window.__h3d.injectBoard(m as never), msg);
  await frames(page, 30);
  expect((await wall(page))?.gongRings).toBe(2);
  clean();
});

test('Open PR for a plain worker: prepare, edit, confirm, push and open; freelancers do not get it', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', EXTRA, SIM);
  await enter(page, 'herdr-3d');
  await expect.poll(async () => (await wall(page))?.prs.length).toBe(4);
  const workers = await page.evaluate(() => window.__h3d.world().find((f) => f.session === 'herdr-3d')?.workers ?? []);
  const fixtures = workers.find((w) => w.label === 'fixtures')!;
  const freelancer = workers.find((w) => w.label.startsWith('CODE|m2-go'))!;
  // A freelancer's changes have no Open PR.
  await page.evaluate((id) => window.__h3d.openChanges(id), freelancer.id);
  await expect(page.locator('dialog.changes [data-key="refresh"]')).toBeVisible();
  await expect(page.locator('dialog.changes [data-key="open-pr"]')).toHaveCount(0);
  // A plain worker's has.
  await page.evaluate((id) => window.__h3d.openChanges(id), fixtures.id);
  await expect(page.locator('dialog.changes h2')).toContainText(fixtures.name);
  await expect(page.locator('dialog.changes [data-key="open-pr"]')).toBeVisible();
  await page.locator('dialog.changes [data-key="open-pr"]').click();
  await expect.poll(async () => { const d = await page.evaluate(() => window.__h3d.dialog()); return d?.kind === 'open-pr' && d.state; }).toBe('ready');
  const d = (await page.evaluate(() => window.__h3d.dialog())) as { branch: string; base: string; ahead: number; title: string; body: string; blocker: string | null; existing: string | null };
  expect(d).toMatchObject({ branch: 'h3d/waffle-fixtures', base: 'main', ahead: 2, title: 'Work on waffle-fixtures', blocker: null, existing: null });
  expect(d.body).toBe('- Work on waffle-fixtures\n- Tidy the tests');
  await shot(page, 'm7-open-pr');
  await page.locator('#openpr-title-in').fill('Fixtures for the waffle machine');
  await page.locator('dialog.desk-dlg--openpr [data-key="confirm"]').click();
  await expect.poll(async () => (await sentOf(page, 'worker.open_pr')).length).toBe(1);
  expect((await sentOf(page, 'worker.open_pr'))[0]?.args).toEqual({ id: fixtures.id, title: 'Fixtures for the waffle machine', body: '- Work on waffle-fixtures\n- Tidy the tests', confirm: true });
  await expect.poll(async () => { const s = await page.evaluate(() => window.__h3d.dialog()); return s?.kind === 'open-pr' ? s.result : null; }).toMatchObject({ key: '#36', pushed: true, existed: false });
  await expect(page.locator('.toast')).toContainText('Opened #36');
  // The PR is on the board after the next poll; asking again finds it (retry-safe).
  await expect.poll(async () => ((await wall(page)) as { prs: Array<{ id: string }> }).prs.some((n) => n.id === `${HERDR}#36`)).toBe(true);
  await page.locator('dialog.desk-dlg--openpr [data-key="open-result"]').click();
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.opened())).at(-1)?.url).toBe(`https://github.com/${HERDR}/pull/36`);
  await page.locator('dialog.desk-dlg--openpr [data-key="cancel"]').click();
  await page.locator('dialog.changes [data-key="open-pr"]').click();
  await expect.poll(async () => { const s = await page.evaluate(() => window.__h3d.dialog()); return s?.kind === 'open-pr' ? s.existing : null; }).toBe('#36');
  await expect(page.locator('dialog.desk-dlg--openpr [data-key="confirm"]')).toHaveCount(0);
  clean();
});

test('Open PR says why when the worker is not on a branch the bridge made', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', EXTRA, SIM);
  await enter(page, 'herdr-3d');
  await expect.poll(async () => (await wall(page))?.prs.length).toBe(4);
  const w = await page.evaluate(() => window.__h3d.world().find((f) => f.session === 'herdr-3d')?.workers.find((x) => x.label === 'docs'));
  await page.evaluate((id) => window.__h3d.openChanges(id), w!.id);
  await page.locator('dialog.changes [data-key="open-pr"]').click();
  await expect.poll(async () => { const s = await page.evaluate(() => window.__h3d.dialog()); return s?.kind === 'open-pr' && s.state; }).toBe('failed');
  await expect(page.locator('dialog.desk-dlg--openpr .dd-status--error')).toContainText('refused it');
  clean();
});

// ---- #52: dragging cards between the columns ------------------------------------------------------------------------
// The lab floor's project board: Todo #7 #6 #5, Doing #3 #4, QA #8, Done #2 #1 (the project's order, `position`).

const COL = { todo: '49294ed0', doing: 'ae6334b4', qa: '64e1b0ac', done: 'ccf5765b' } as const;
const boardDlg = (page: Page) => page.locator('dialog.desk-dlg--board');
const cardEl = (page: Page, n: number, repo = lab) => boardDlg(page).locator(`.bd-card[data-id="${repo}#${n}"]`);
const colEl = (page: Page, id: string) => boardDlg(page).locator(`.bd-col[data-col="${id}"]`);
const slotLine = (page: Page) => boardDlg(page).locator('.bd-slot');
const keysOf = async (page: Page) => Object.fromEntries(((await board(page))?.columns ?? []).map((c) => [c.name, c.keys]));

async function box(loc: ReturnType<Page['locator']>) {
  const b = await loc.boundingBox();
  if (!b) throw new Error('not on screen');
  return b;
}

async function openIssues(page: Page, session = 'lab', notes = 8): Promise<void> {
  await enter(page, session);
  await expect.poll(async () => (await wall(page))?.issues.length).toBe(notes);
  await page.evaluate(() => window.__h3d.openBoard('issues'));
  await expect(boardDlg(page)).toBeVisible();
  await expect.poll(async () => (await board(page))?.columns.length ?? 0).toBeGreaterThan(1);
  // The dialog's opening slide is over: what is measured now is where it stays.
  await boardDlg(page).evaluate((d) => Promise.all(d.getAnimations({ subtree: true }).map((a) => a.finished)));
}

/** Presses on a card's middle and moves a little: the drag is live. */
async function pickUp(page: Page, n: number, repo = lab): Promise<void> {
  const b = await box(cardEl(page, n, repo));
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 8, b.y + b.height / 2 + 8, { steps: 3 });
  await expect(page.locator('.bd-card--lifted')).toHaveCount(1);
}

/** The middle of the slot line, once it shows in that column and has come to rest (it glides between slots). */
async function lineAt(page: Page, column: string): Promise<number> {
  await expect(boardDlg(page).locator(`.bd-slot[data-column="${column}"]`)).toHaveCount(1);
  await slotLine(page).evaluate((e) => Promise.all(e.getAnimations().map((a) => a.finished)));
  const l = await box(slotLine(page));
  return l.y + l.height / 2;
}

const setStatus = async (page: Page) => (await sentOf(page, 'issue.set_status')).map((c) => c.args);

test('#52 drag with the mouse: the line above a card in its top half, below it in its bottom half; the drop sends after and the card stays there after the poll', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', EXTRA, SIM);
  await openIssues(page);
  expect(await keysOf(page)).toMatchObject({ Todo: ['#7', '#6', '#5'], Doing: ['#3', '#4'], QA: ['#8'], Done: ['#2', '#1'] });
  await expect(cardEl(page, 5)).toHaveAttribute('data-drag', 'true');
  const three = await box(cardEl(page, 3));
  const four = await box(cardEl(page, 4));
  await pickUp(page, 5);
  // The spot it left is a ghost; the card follows the pointer.
  await expect(cardEl(page, 5)).toHaveClass(/bd-card--ghost/);
  // Over #3's top half: the line above #3.
  await page.mouse.move(three.x + three.width / 2, three.y + three.height * 0.25, { steps: 6 });
  await expect(colEl(page, COL.doing)).toHaveAttribute('data-over', 'true');
  let y = await lineAt(page, COL.doing);
  expect(y).toBeLessThan(three.y);
  expect(y).toBeGreaterThan(three.y - 12);
  // Over its bottom half: below #3, between it and #4.
  await page.mouse.move(three.x + three.width / 2, three.y + three.height * 0.75, { steps: 4 });
  await expect.poll(async () => (await lineAt(page, COL.doing)) > three.y + three.height).toBe(true);
  y = await lineAt(page, COL.doing);
  expect(y).toBeLessThan(four.y);
  const lifted = await box(page.locator('.bd-card--lifted'));
  expect(Math.abs(lifted.y + lifted.height / 2 - (three.y + three.height * 0.75))).toBeLessThan(lifted.height);
  await shot(page, 'm52-drag-preview');
  expect(await setStatus(page)).toEqual([]);
  await page.mouse.up();
  await expect.poll(async () => (await setStatus(page)).length).toBe(1);
  expect((await setStatus(page))[0]).toEqual({ session: 'lab', id: `${lab}#5`, column: COL.doing, after: `${lab}#3` });
  // At once, and no card opened for the release.
  expect((await keysOf(page)).Doing).toEqual(['#3', '#5', '#4']);
  expect((await keysOf(page)).Todo).toEqual(['#7', '#6']);
  expect((await board(page))?.item ?? null).toBeNull();
  await expect(page.locator('.bd-card--lifted')).toHaveCount(0);
  await expect(slotLine(page)).toHaveCount(0);
  // The bridge's refresh, and another poll: still there, now by the project's order itself.
  await expect.poll(async () => (await sentOf(page, 'issue.set_status'))[0]?.result?.ok).toBe(true);
  await page.evaluate(() => window.__h3d.simBoards({ poll: true }));
  await frames(page, 10);
  expect((await keysOf(page)).Doing).toEqual(['#3', '#5', '#4']);
  const m = (await page.evaluate(() => window.__h3d.boardMessage('issues'))) as { cards: Array<{ key: string; position?: number }> };
  const pos = (k: string) => m.cards.find((c) => c.key === k)?.position ?? -1;
  expect(pos('#3')).toBeLessThan(pos('#5'));
  expect(pos('#5')).toBeLessThan(pos('#4'));
  clean();
});

test('#52 drag to the end of a column and into an empty one', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', EXTRA, SIM);
  await openIssues(page);
  // #8 to the end of Done: below its last card.
  const one = await box(cardEl(page, 1));
  await pickUp(page, 8);
  await page.mouse.move(one.x + one.width / 2, one.y + one.height + 40, { steps: 6 });
  expect(await lineAt(page, COL.done)).toBeGreaterThan(one.y + one.height);
  await page.mouse.up();
  await expect.poll(async () => (await setStatus(page)).length).toBe(1);
  expect((await setStatus(page))[0]).toEqual({ session: 'lab', id: `${lab}#8`, column: COL.done, after: `${lab}#1` });
  expect(await keysOf(page)).toMatchObject({ QA: [], Done: ['#2', '#1', '#8'] });
  await expect.poll(async () => (await sentOf(page, 'issue.set_status'))[0]?.result?.ok).toBe(true);
  // QA is empty now: #6 into it, at the top (after: null).
  const qa = await box(colEl(page, COL.qa));
  await pickUp(page, 6);
  await page.mouse.move(qa.x + qa.width / 2, qa.y + 60, { steps: 6 });
  await lineAt(page, COL.qa);
  await expect(colEl(page, COL.qa)).toHaveAttribute('data-over', 'true');
  await page.mouse.up();
  await expect.poll(async () => (await setStatus(page)).length).toBe(2);
  expect((await setStatus(page))[1]).toEqual({ session: 'lab', id: `${lab}#6`, column: COL.qa, after: null });
  await expect.poll(async () => (await sentOf(page, 'issue.set_status'))[1]?.result?.ok).toBe(true);
  await page.evaluate(() => window.__h3d.simBoards({ poll: true }));
  await frames(page, 10);
  expect(await keysOf(page)).toMatchObject({ Todo: ['#7', '#5'], QA: ['#6'], Done: ['#2', '#1', '#8'] });
  clean();
});

test('#52 Esc, a drop outside the columns or on its own place cancel: nothing sent, nothing moved; a plain click still opens the card', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', EXTRA, SIM);
  await openIssues(page);
  const before = await keysOf(page);
  const three = await box(cardEl(page, 3));
  const five = await box(cardEl(page, 5));
  // Esc: the drag ends, the board stays open.
  await pickUp(page, 5);
  await page.mouse.move(three.x + three.width / 2, three.y + 5, { steps: 4 });
  await lineAt(page, COL.doing);
  await page.keyboard.press('Escape');
  await expect(page.locator('.bd-card--lifted')).toHaveCount(0);
  await expect(slotLine(page)).toHaveCount(0);
  await expect(cardEl(page, 5)).not.toHaveClass(/bd-card--ghost/);
  // The button still down, back over the card it picked up: its release is the cancelled drag's, not a click.
  await page.mouse.move(five.x + five.width / 2, five.y + five.height / 2, { steps: 4 });
  await page.mouse.up();
  await frames(page, 4);
  await expect(boardDlg(page)).toBeVisible();
  expect((await board(page))?.item ?? null).toBeNull();
  // Over the dialog's header: no column, no line; the drop there does nothing.
  await pickUp(page, 5);
  const head = await box(boardDlg(page).locator('.dd-head'));
  await page.mouse.move(head.x + head.width / 2, head.y + head.height / 2, { steps: 6 });
  await expect(boardDlg(page).locator('.bd-col[data-over]')).toHaveCount(0);
  await expect(slotLine(page)).toHaveCount(0);
  await page.mouse.up();
  // Back on its own place: no line (its ghost is the place), and no command.
  await pickUp(page, 6);
  await expect(slotLine(page)).toHaveCount(0);
  await page.mouse.up();
  await frames(page, 4);
  expect(await setStatus(page)).toEqual([]);
  expect(await keysOf(page)).toEqual(before);
  expect((await board(page))?.item ?? null).toBeNull();
  // A click with no drag opens the card, as before.
  await cardEl(page, 5).click();
  await expect.poll(async () => (await item(page)).key ?? null).toBe('#5');
  // And the modal's Move to… still moves the status only: no after.
  await expect.poll(async () => (await item(page)).state).toBe('ready');
  await act(page, 'move-to').selectOption({ label: 'QA' });
  await act(page, 'move').click();
  await expect.poll(async () => (await setStatus(page)).length).toBe(1);
  expect((await setStatus(page))[0]).toEqual({ session: 'lab', id: `${lab}#5`, column: COL.qa });
  clean();
});

test('#52 a failed write puts the card back and says why', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', EXTRA, SIM);
  await openIssues(page);
  await page.evaluate(() => window.__h3d.simBoards({ fail_write: 'Resource not accessible by integration' }));
  const three = await box(cardEl(page, 3));
  await pickUp(page, 5);
  await page.mouse.move(three.x + three.width / 2, three.y + three.height * 0.75, { steps: 6 });
  await lineAt(page, COL.doing);
  await page.mouse.up();
  await expect.poll(async () => (await setStatus(page)).length).toBe(1);
  await expect.poll(async () => (await sentOf(page, 'issue.set_status'))[0]?.result?.code).toBe('provider_failed');
  // Said in the board, which stays open over the HUD: visible, on top, and announced from inside the modal.
  const alert = boardDlg(page).locator('.bd-alert-text');
  await expect(alert).toBeVisible();
  await expect(alert).toHaveText('GitHub refused or failed: Resource not accessible by integration. The board shows where #5 is now.');
  await expect(alert).toHaveAttribute('role', 'alert');
  expect(await alert.evaluate((e) => {
    const r = e.getBoundingClientRect();
    return e.contains(document.elementFromPoint(r.left + 8, r.top + r.height / 2));
  })).toBe(true);
  await expect.poll(async () => (await keysOf(page)).Doing).toEqual(['#3', '#4']);
  expect((await keysOf(page)).Todo).toEqual(['#7', '#6', '#5']);
  await expect(cardEl(page, 5)).not.toHaveAttribute('data-moving', 'true');
  await shot(page, 'm52-drag-failed');
  // Dismissed, it goes; so does it when the next drag starts.
  await boardDlg(page).locator('[data-key="dismiss-move-error"]').click();
  await expect(boardDlg(page).locator('.bd-alert')).toBeHidden();
  clean();
});

test('#52 a write that fails halfway (the status changed, the place did not): the error says so and the refresh shows the card where it is', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', EXTRA, SIM);
  await openIssues(page);
  await page.evaluate(() => window.__h3d.simBoards({ partial_write: 'Resource not accessible by integration' }));
  const three = await box(cardEl(page, 3));
  await pickUp(page, 5);
  await page.mouse.move(three.x + three.width / 2, three.y + three.height * 0.75, { steps: 6 });
  await lineAt(page, COL.doing);
  await page.mouse.up();
  await expect.poll(async () => (await sentOf(page, 'issue.set_status'))[0]?.result?.code).toBe('provider_failed');
  await expect(boardDlg(page).locator('.bd-alert-text')).toContainText('its status changed, but its place in the column did not');
  // The bridge's refresh: #5 in Doing, at its old place in the project's order (not where it was dropped).
  await expect.poll(async () => (await keysOf(page)).Doing).toContain('#5');
  expect((await keysOf(page)).Todo).toEqual(['#7', '#6']);
  await frames(page, 10);
  expect((await keysOf(page)).Doing).toContain('#5');
  clean();
});

test('#52 a board polled before the write never makes the card jump back; no project means no dragging', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', EXTRA, SIM);
  await openIssues(page);
  const old = await page.evaluate(() => window.__h3d.boardMessage('issues'));
  // The bridge's refresh is late: the board that comes first is one from before the write.
  await page.evaluate(() => window.__h3d.simBoards({ no_refresh: true }));
  const three = await box(cardEl(page, 3));
  await pickUp(page, 5);
  await page.mouse.move(three.x + three.width / 2, three.y + 4, { steps: 6 });
  await lineAt(page, COL.doing);
  await page.mouse.up();
  await expect.poll(async () => (await sentOf(page, 'issue.set_status'))[0]?.result?.ok).toBe(true);
  expect((await setStatus(page))[0]).toEqual({ session: 'lab', id: `${lab}#5`, column: COL.doing, after: null });
  await page.evaluate((m) => window.__h3d.injectBoard({ ...(m as object), initial: false, fetched_at: Date.now() } as never), old);
  await frames(page, 4);
  expect((await keysOf(page)).Doing).toEqual(['#5', '#3', '#4']);
  // The refresh comes: the same.
  await page.evaluate(() => window.__h3d.simBoards({ no_refresh: false, poll: true }));
  await frames(page, 10);
  expect((await keysOf(page)).Doing).toEqual(['#5', '#3', '#4']);

  // A floor with no project: no card can be picked up, and a drag does nothing.
  await page.evaluate(() => window.__h3d.board() && document.querySelector<HTMLDialogElement>('dialog.desk-dlg--board')?.close());
  await openIssues(page, 'depot-manager', 4);
  await expect(boardDlg(page).locator('.bd-card[data-drag]')).toHaveCount(0);
  const closed = await box(colEl(page, 'closed'));
  const b = await box(cardEl(page, 1, 'fomra/depot-manager'));
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(closed.x + closed.width / 2, closed.y + 80, { steps: 6 });
  await expect(page.locator('.bd-card--lifted')).toHaveCount(0);
  await page.mouse.up();
  await frames(page, 4);
  expect(await setStatus(page)).toHaveLength(1);
  clean();
});

test('#52 far columns: the board scrolls sideways near its edge to reach Done', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 620, height: 720 });
  await openGame(page, 'demo-m6', EXTRA, SIM);
  await openIssues(page);
  const body = boardDlg(page).locator('.bd-body');
  const bb = await box(body);
  expect(await body.evaluate((e) => e.scrollWidth > e.clientWidth + 100)).toBe(true);
  expect(await body.evaluate((e) => e.scrollLeft)).toBe(0);
  await pickUp(page, 5);
  // Rest near the right edge: the board scrolls until Done is in reach.
  await page.mouse.move(bb.x + bb.width - 8, bb.y + 120, { steps: 6 });
  await expect.poll(async () => body.evaluate((e) => e.scrollLeft + e.clientWidth >= e.scrollWidth - 2), { timeout: 20_000 }).toBe(true);
  const done = await box(colEl(page, COL.done));
  await page.mouse.move(done.x + done.width / 2, done.y + 20, { steps: 4 });
  await lineAt(page, COL.done);
  await page.mouse.up();
  await expect.poll(async () => (await setStatus(page)).length).toBe(1);
  expect((await setStatus(page))[0]).toEqual({ session: 'lab', id: `${lab}#5`, column: COL.done, after: null });
  clean();
});

test('#52 prefers-reduced-motion: no lift or slide animation, the line still shows', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openGame(page, 'demo-m6', EXTRA, SIM);
  await openIssues(page);
  const three = await box(cardEl(page, 3));
  await pickUp(page, 5);
  await page.mouse.move(three.x + three.width / 2, three.y + 4, { steps: 4 });
  await lineAt(page, COL.doing);
  expect(await slotLine(page).evaluate((e) => getComputedStyle(e).transitionDuration)).toBe('0s');
  expect(await page.locator('.bd-card--lifted').evaluate((e) => getComputedStyle(e).animationName)).toBe('none');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  // With motion allowed the note lifts off with an animation.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await pickUp(page, 5);
  expect(await page.locator('.bd-card--lifted').evaluate((e) => getComputedStyle(e).animationName)).toBe('bd-lift');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await setStatus(page)).toEqual([]);
  clean();
});

test.describe('#52 touch', () => {
  test.use({ hasTouch: true, viewport: { width: 620, height: 720 } });

  test('a swipe scrolls the board; a long press picks the card up and the finger drags it without scrolling the page', async ({ page }) => {
    test.setTimeout(150_000);
    const clean = watchErrors(page);
    await openGame(page, 'demo-m6', EXTRA, SIM);
    await openIssues(page);
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: string, x?: number, y?: number) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: x === undefined ? [] : [{ x, y: y as number }] } as never);
    const body = boardDlg(page).locator('.bd-body');
    // A swipe left that starts on a card: the board scrolls, nothing is picked up.
    const six = await box(cardEl(page, 6));
    let x = six.x + six.width / 2;
    const y = six.y + six.height / 2;
    // (Headless Chromium on llvmpipe lets the first touch sequences after the dialog opens go by without a scroll, before
    // its compositor has the board's scroller: the swipe is tried up to four times, and none of them may pick a card up.)
    await frames(page, 10);
    for (let k = 0; k < 4 && (await body.evaluate((e) => e.scrollLeft)) === 0; k++) {
      await touch('touchStart', x, y);
      for (let i = 1; i <= 8; i++) {
        await touch('touchMove', x - i * 25, y);
        await page.waitForTimeout(16);
      }
      await touch('touchEnd');
      await page.waitForTimeout(300);
      await expect(page.locator('.bd-card--lifted')).toHaveCount(0);
    }
    await expect.poll(async () => body.evaluate((e) => e.scrollLeft)).toBeGreaterThan(50);
    await expect(page.locator('.bd-card--lifted')).toHaveCount(0);
    expect(await setStatus(page)).toEqual([]);
    await body.evaluate((e) => (e.scrollLeft = 0));
    // A long press on #5, then the finger carries it onto #3's bottom half.
    const five = await box(cardEl(page, 5));
    const three = await box(cardEl(page, 3));
    x = five.x + five.width / 2;
    await touch('touchStart', x, five.y + five.height / 2);
    await page.waitForTimeout(600);
    await expect(page.locator('.bd-card--lifted')).toHaveCount(1);
    const steps = 8;
    const tx = three.x + three.width / 2;
    const ty = three.y + three.height * 0.75;
    for (let i = 1; i <= steps; i++) {
      await touch('touchMove', x + ((tx - x) * i) / steps, five.y + five.height / 2 + ((ty - five.y - five.height / 2) * i) / steps);
      await page.waitForTimeout(16);
    }
    await lineAt(page, COL.doing);
    expect(await body.evaluate((e) => e.scrollTop)).toBe(0);
    await touch('touchEnd');
    await expect.poll(async () => (await setStatus(page)).length).toBe(1);
    expect((await setStatus(page))[0]).toEqual({ session: 'lab', id: `${lab}#5`, column: COL.doing, after: `${lab}#3` });
    expect((await board(page))?.item ?? null).toBeNull();
    // The browser takes the finger back (pointercancel): the drag ends, nothing is sent and nothing opens; a tap still opens.
    await expect.poll(async () => (await sentOf(page, 'issue.set_status'))[0]?.result?.ok).toBe(true);
    await frames(page, 10);
    await body.evaluate((e) => (e.scrollLeft = 0));
    await expect(cardEl(page, 6)).toBeVisible();
    const six2 = await box(cardEl(page, 6));
    x = six2.x + six2.width / 2;
    await touch('touchStart', x, six2.y + six2.height / 2);
    await page.waitForTimeout(600);
    await expect(page.locator('.bd-card--lifted')).toHaveCount(1);
    await touch('touchMove', x + 20, six2.y + six2.height / 2 + 20);
    await touch('touchCancel');
    await expect(page.locator('.bd-card--lifted')).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(await setStatus(page)).toHaveLength(1);
    expect((await board(page))?.item ?? null).toBeNull();
    await page.touchscreen.tap(x, six2.y + six2.height / 2);
    await expect.poll(async () => (await item(page)).key ?? null).toBe('#6');
    clean();
  });
});
