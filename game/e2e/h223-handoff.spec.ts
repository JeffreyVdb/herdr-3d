import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Worker } from '../src/net/protocol';
import { frames, openGame, seatMode, shot, watchErrors } from './game';

// #223: a literal handoff and the filing cabinet against the fixture bridge (`sim=1`, tools/fixture-handoff.ts):
// `sim.final` plays a worker's agent ending its turn, `sim.prompt_turn` a new prompt. The inline Handoff button is on
// the reply's row only; the dialog previews the exact text and files it; nothing is sent to the worker and no AI
// command goes out; the drawers fill; the cabinet lists, searches, shows, deletes and hires from a handoff.

const SIM = 'play=none&sim=1&simms=150&simusage=0';
const LONG = `  # Loader refactor\n\n\`\`\`go\nfunc main() {\n\tprintln("keep  the   spaces")\n}\n\`\`\`\n\n${'A line of the report that goes on and on.\n'.repeat(1800)}\nThe last line, past the preview.  `;

function demoWorker(name: string): Worker {
  const snap = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/demo-m5.jsonl'), 'utf8').split('\n')[0] ?? '{}') as { world: { workers: Worker[] } };
  const w = snap.world.workers.find((x) => x.name === name);
  if (!w) throw new Error(`no ${name} in demo-m5`);
  return w;
}

async function sitAtTranscript(page: Page, w: Worker): Promise<void> {
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.face(id), w.id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.sitAt(id), w.id)).toBe(true);
  await frames(page, 20);
  await seatMode(page, 'transcript');
  await expect(page.locator('.seat-transcript .tx .tx-scroll')).toBeFocused();
}

const final = (page: Page, id: string, text: string, extra: Record<string, unknown> = {}) => page.evaluate((a) => window.__h3d.simHandoff('sim.final', a), { id, text, ...extra });
const sentTypes = (page: Page) => page.evaluate(() => window.__h3d.sent().map((c) => c.t as string));
/** Nothing went to the worker and no AI command was sent. */
async function nothingToWorker(page: Page): Promise<void> {
  const ts = await sentTypes(page);
  expect(ts.filter((t) => ['worker.prompt', 'worker.keys', 'worker.answer', 'worker.wrapup'].includes(t) || t.startsWith('ai.') || t.startsWith('followups.') || t.startsWith('digest.') || t === 'packup.detect')).toEqual([]);
}

test('the inline button on the last reply files it as written, sends the worker home after, and the drawers fill', { tag: '@smoke' }, async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', SIM);
  const w = demoWorker('Zippy');
  await sitAtTranscript(page, w);
  const tx = page.locator('.seat-transcript .tx');
  await expect(tx.locator('.tx-handoff-btn')).toHaveCount(0);
  const r = await final(page, w.id, LONG, { images: 1 });
  expect(r.ok).toBe(true);
  const btn = tx.getByRole('button', { name: 'Handoff', exact: true });
  await expect(btn).toHaveCount(1);
  await expect(btn).toHaveAccessibleDescription('Save this message as written · no AI call');
  // On the reply's own row, not elsewhere.
  expect(await btn.evaluate((b) => (b.closest('[data-id]') as HTMLElement).dataset.kind)).toBe('assistant');
  await shot(page, 'h223-inline-button');
  // #216 row 21: a labelled button is 36px high in Ubuntu; Quiet keeps its own.
  const height = () => btn.evaluate((b) => b.getBoundingClientRect().height);
  const quiet = await height();
  const was = await page.evaluate(() => document.documentElement.getAttribute('data-ui-theme'));
  await page.evaluate(() => document.documentElement.setAttribute('data-ui-theme', 'ubuntu'));
  expect(await height()).toBeGreaterThanOrEqual(36);
  await page.evaluate((v) => (v === null ? document.documentElement.removeAttribute('data-ui-theme') : document.documentElement.setAttribute('data-ui-theme', v)), was);
  expect(await height()).toBe(quiet);
  await btn.click();

  const dlg = page.getByRole('dialog', { name: 'File a handoff from Zippy' });
  await expect(dlg).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__h3d.handoffDialog()?.state)).toBe('ready');
  const s = await page.evaluate(() => window.__h3d.handoffDialog());
  expect(s?.truncated).toBe(true);
  expect(LONG.startsWith(s?.text ?? 'x')).toBe(true);
  expect(s?.text.startsWith('  # Loader refactor\n\n```go\nfunc main() {\n\tprintln("keep  the   spaces")')).toBe(true);
  expect(s?.title).toBe('Loader refactor');
  await expect(dlg.locator('[data-hook="ho-notes"]')).toContainText('the whole reply is filed');
  await expect(dlg.locator('[data-hook="ho-notes"]')).toContainText('An image in this message is not text');
  await expect(dlg.locator('[data-hook="ho-prov"]')).toContainText('Zippy');
  await expect(dlg.getByRole('checkbox', { name: 'Send Zippy home after filing' })).toBeEnabled();
  await shot(page, 'h223-filing-dialog');
  await dlg.getByText('Send Zippy home after filing').click();
  await dlg.getByRole('button', { name: 'File, then send home' }).click();
  await expect.poll(() => page.evaluate(() => window.__h3d.handoffDialog()?.state)).toBe('filed');
  await expect(dlg.locator('[data-hook="ho-path"]')).toContainText('/home/u/handoff/herdr-3d/');
  await expect(dlg.locator('[data-hook="ho-home"]')).toContainText('on the way home');
  const filed = (await page.evaluate(() => window.__h3d.sent().filter((c) => c.t === 'worker.handoff'))) as Array<{ args: Record<string, unknown> }>;
  expect(filed).toHaveLength(1);
  expect(filed[0]?.args).toMatchObject({ worker: w.id, mode: 'literal', send_home: true });
  await nothingToWorker(page);
  await dlg.getByRole('button', { name: 'Done' }).click();
  // The worker goes home (the send home followed the filing), and the drawer holds one folder.
  await expect.poll(() => page.evaluate((id) => window.__h3d.world().flatMap((f) => f.workers).some((x) => x.id === id), w.id)).toBe(false);
  await expect.poll(() => page.evaluate(() => window.__h3d.filing().drawers)).toEqual([0, 0, 1]);
  clean();
});

test('F at a worker: a stale reply, a filing failure, a retry, and no candidate says why', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', SIM);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  const zippy = demoWorker('Zippy');
  // Nothing to file yet: it says why and offers nothing else.
  expect(await page.evaluate((id) => window.__h3d.face(id), zippy.id)).toBe(true);
  await frames(page, 3);
  await page.keyboard.press('KeyF');
  const dlg = page.getByRole('dialog', { name: 'File a handoff from Zippy' });
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('[data-hook="ho-why"]')).toContainText('no completed reply to file');
  await expect(dlg.getByRole('button', { name: 'Close' }).last()).toBeVisible();
  expect(await sentTypes(page)).not.toContain('worker.handoff_preview');
  await page.keyboard.press('Escape');

  // A reply comes; F opens its preview; a new prompt makes it stale; File is off.
  await final(page, zippy.id, 'Short reply.\n\nDone.');
  await page.keyboard.press('KeyF');
  await expect.poll(() => page.evaluate(() => window.__h3d.handoffDialog()?.state)).toBe('ready');
  await page.evaluate((id) => window.__h3d.simHandoff('sim.prompt_turn', { id }), zippy.id);
  await expect.poll(() => page.evaluate(() => window.__h3d.handoffDialog()?.stale)).toBe(true);
  await expect(dlg.getByRole('button', { name: 'File handoff' })).toHaveAttribute('aria-disabled', 'true');
  // A newer reply: show it, then a failed filing keeps the dialog and says so; the retry files once.
  await final(page, zippy.id, '# Second\n\nThe newer one.');
  await dlg.getByRole('button', { name: 'Show the latest reply' }).click();
  await expect.poll(() => page.evaluate(() => window.__h3d.handoffDialog()?.title)).toBe('Second');
  await page.evaluate(() => window.__h3d.simHandoff('sim.handoff_fail', { code: 'handoff_failed' }));
  await dlg.getByRole('button', { name: 'File handoff' }).click();
  await expect(dlg.getByRole('alert')).toContainText('The handoff was not filed');
  await expect(dlg.getByRole('alert')).toContainText('Nobody was sent home');
  await shot(page, 'h223-filing-error');
  await dlg.getByRole('button', { name: 'File handoff' }).click();
  await expect.poll(() => page.evaluate(() => window.__h3d.handoffDialog()?.state)).toBe('filed');
  const ops = (await page.evaluate(() => window.__h3d.sent().filter((c) => c.t === 'worker.handoff').map((c) => (c.args as { op: string }).op))) as string[];
  expect(ops).toHaveLength(2);
  expect(ops[0]).toBe(ops[1]);
  // Zippy (not sent home) carries the folder to the cabinet; the drawer holds it.
  await expect.poll(() => page.evaluate(() => window.__h3d.filing().walks.some((k) => k.includes('@handoff:')))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__h3d.filing().drawers)).toEqual([0, 0, 1]);
  await nothingToWorker(page);
  clean();
});

test('the button survives a view reopen and goes with a new prompt; older pages never get it', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', SIM);
  const w = demoWorker('Pebble');
  await sitAtTranscript(page, w);
  const tx = page.locator('.seat-transcript .tx');
  await final(page, w.id, 'The reply to file.');
  await expect(tx.locator('.tx-handoff-btn')).toHaveCount(1);
  // Stand up and sit again: the view is new, the button is back on the same row.
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
  expect(await page.evaluate((id) => window.__h3d.sitAt(id), w.id)).toBe(true);
  await frames(page, 20);
  await seatMode(page, 'transcript');
  await expect(tx.locator('.tx-handoff-btn')).toHaveCount(1);
  // Only the reply's row has it, however much of the timeline is loaded.
  expect(await tx.locator('.tx-handoff').evaluateAll((els) => els.map((e) => (e.closest('[data-id]') as HTMLElement).dataset.kind))).toEqual(['assistant']);
  // A new genuine prompt: the earlier reply is not the latest any more.
  await page.evaluate((id) => window.__h3d.simHandoff('sim.prompt_turn', { id }), w.id);
  await expect(tx.locator('.tx-handoff-btn')).toHaveCount(0);
  clean();
});

test('the filing cabinet: E opens it, search, safe preview, delete with a confirm, hire from a handoff', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', `${SIM}&simhandoffs=3`);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 6);
  await expect.poll(() => page.evaluate(() => window.__h3d.filing().drawers)).toEqual([0, 0, 3]);
  // T goes through the workers, desks and props: the filing cabinet is one of them; E opens it.
  for (let i = 0; i < 80; i++) {
    const t = await page.evaluate(() => window.__h3d.target());
    if (t?.id === 'filing') break;
    await page.keyboard.press('KeyT');
    await frames(page, 1);
  }
  expect((await page.evaluate(() => window.__h3d.target()))?.id).toBe('filing');
  await expect(page.locator('.prompt').filter({ hasText: 'Filing cabinet' })).toBeVisible();
  await page.keyboard.press('KeyE');
  const cab = page.getByRole('dialog', { name: 'Filing cabinet' });
  await expect(cab).toBeVisible();
  await expect(cab.locator('.cab-row')).toHaveCount(3);
  await expect(cab.getByRole('searchbox', { name: 'Search the cabinet' })).toBeFocused();
  await shot(page, 'h223-cabinet');
  // A search: the matches, the matching words marked as text.
  await page.keyboard.type('pagin');
  await expect(cab.locator('.cab-row')).toHaveCount(1);
  await expect(cab.locator('.cab-row-title')).toHaveText('Transcript pagination');
  await page.keyboard.press('Backspace');
  for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace');
  await expect(cab.locator('.cab-row')).toHaveCount(3);
  await page.keyboard.type('streams');
  await expect(cab.locator('.cab-snippet mark').first()).toHaveText('streams');
  await cab.locator('.cab-row').first().click();
  const doc = cab.locator('[data-hook="cab-doc"]');
  await expect(doc.locator('h1')).toBeVisible();
  await expect(doc.locator('pre code')).toContainText('make e2e');
  expect(await doc.locator('script, img, iframe, [onerror]').count()).toBe(0);
  // The actions wear the dialog's text colour and face in Quiet, never the browser's black on the dark surface.
  const unthemed = () =>
    cab.locator('.cab-actions .btn:not(.btn--danger)').evaluateAll((bs) => {
      const d = getComputedStyle(bs[0]!.closest('dialog')!);
      return bs.filter((b) => getComputedStyle(b).color !== d.color || getComputedStyle(b).fontFamily !== d.fontFamily).map((b) => b.textContent);
    });
  expect(await cab.locator('.cab-actions .btn').count()).toBe(3);
  expect(await unthemed()).toEqual([]);
  // Delete: a confirm first, then out of the drawer.
  await cab.getByRole('button', { name: 'Delete' }).click();
  await expect(cab.getByRole('button', { name: 'Move to trash' })).toBeVisible();
  expect(await unthemed()).toEqual([]); // Keep it
  await cab.getByRole('button', { name: 'Move to trash' }).click();
  await expect(cab.locator('.cab-foot [role="status"]')).toContainText('trash');
  await expect.poll(() => page.evaluate(() => window.__h3d.filing().drawers)).toEqual([0, 0, 2]);
  // Hire from handoff: the reviewed hire, the task reading the handoff, its model checked, no effort guessed.
  await cab.getByRole('searchbox').fill('');
  await expect(cab.locator('.cab-row')).toHaveCount(2);
  await cab.locator('.cab-row').first().click();
  const path = (await cab.locator('.cab-view .ho-path').textContent()) ?? '';
  await cab.getByRole('button', { name: 'Hire from handoff' }).click();
  await expect(cab).toBeHidden();
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.dialog())) as { kind?: string } | null).toMatchObject({ kind: 'hire-review' });
  const review = (await page.evaluate(() => window.__h3d.dialog())) as unknown as { choice: { task: string; effort: string; model: string } };
  expect(review.choice.task).toBe(`Read ${path} and continue the work. Invoke the skills it suggests.`);
  expect(review.choice.effort).toBe('');
  clean();
});

// #198: "Hire with handoff" beside Handoff: step 1 (the mode, the new agent's task), step 2 (the reviewed hire), one
// Hire that files the reply and then hires with the composed task and the filed path. A hire refused after filing keeps
// the handoff: Hire again hires only.
test('Hire with handoff: the reply is filed, then one agent is hired with the composed task; a failed hire retries without filing again', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', `${SIM}&simfail=hire_failed`);
  const w = demoWorker('Pebble');
  await sitAtTranscript(page, w);
  const tx = page.locator('.seat-transcript .tx');
  expect((await final(page, w.id, '# Loader\n\nThe loader is half done.')).ok).toBe(true);
  const hireBtn = tx.getByRole('button', { name: 'Hire with handoff', exact: true });
  await expect(hireBtn).toHaveCount(1);
  await expect(tx.getByRole('button', { name: 'Handoff', exact: true })).toHaveCount(1);
  await hireBtn.click();
  const step1 = page.getByRole('dialog', { name: 'Hire with a handoff from Pebble' });
  await expect(step1).toBeVisible();
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.handoffDialog()))?.state).toBe('ready');
  const go = step1.getByRole('button', { name: 'Continue to hire' });
  await expect(go).toHaveAttribute('aria-disabled', 'true');
  const task = 'Fix the issue\n\n  - keep the tests green';
  await step1.getByLabel(/Task for the new agent/).fill(task);
  await shot(page, 'h198-step1');
  await go.click();
  await expect(step1).toBeHidden();
  const review = page.getByRole('dialog', { name: /^Hire with a handoff at Desk/ });
  await expect(review).toBeVisible();
  // Nothing filed yet; the effort is never guessed.
  expect((await page.evaluate(() => window.__h3d.sent().map((c) => c.t as string))).filter((t) => t === 'worker.handoff' || t === 'worker.hire')).toEqual([]);
  await expect(review.locator('[data-hook="composed"]')).toContainText('First read the handoff here: ‹the handoff’s path, once it is filed› and then follow these instructions:');
  await review.locator('label:has(> input[data-key="effort:high"])').click();
  await expect.poll(async () => {
    const d = (await page.evaluate(() => window.__h3d.dialog())) as { blocker: string | null } | null;
    return d ? d.blocker : 'no review';
  }).toBeNull();
  await shot(page, 'h198-review');
  await review.getByRole('button', { name: 'File handoff and hire' }).click();
  // The first hire fails (simulated): the handoff stays filed, and the status says where.
  await expect(review.locator('[role="alert"]')).toContainText('The handoff is saved at /home/u/handoff/herdr-3d/');
  await expect(review.locator('[role="alert"]')).toContainText('Hire again hires only');
  await shot(page, 'h198-hire-failed');
  const filed = (await page.evaluate(() => window.__h3d.sent().filter((c) => c.t === 'worker.handoff'))) as Array<{ args: Record<string, unknown> }>;
  expect(filed).toHaveLength(1);
  expect(filed[0]?.args).toMatchObject({ worker: w.id, mode: 'literal' });
  const path = ((await page.evaluate(() => window.__h3d.dialog())) as { handoff: { filed: string } }).handoff.filed;
  expect(path).toMatch(/^\/home\/u\/handoff\/herdr-3d\/.+\.md$/);
  expect(path).not.toContain('.pending');
  await review.getByRole('button', { name: /^Hire / }).click();
  await expect(review).toBeHidden();
  const hires = (await page.evaluate(() => window.__h3d.sent().filter((c) => c.t === 'worker.hire'))) as Array<{ args: Record<string, unknown> }>;
  expect(hires).toHaveLength(2);
  for (const h of hires) expect(h.args).toMatchObject({ floor: 'herdr-3d', harness: 'claude', model: 'claude-fable-5-1', effort: 'high', cwd: w.cwd, prompt: `First read the handoff here: ${path} and then follow these instructions:\n\n${task}` });
  expect(hires[0]?.args.desk_index).not.toBe(w.desk_index);
  expect((await page.evaluate(() => window.__h3d.sent().filter((c) => c.t === 'worker.handoff'))).length).toBe(1);
  await expect(page.locator('.toast')).toContainText('Hired');
  await nothingToWorker(page);
  clean();
});

// #198 (R3): a reply that went stale after step 1 is refused when Hire files it; "Back to the handoff" shows step 1 again
// (the latest reply, the task kept), and Continue brings back the hire as it was reviewed: effort, label, folder, desk.
test('Hire with handoff: a stale reply goes back to step 1, and Continue keeps the reviewed hire settings', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', SIM);
  const w = demoWorker('Pebble');
  await sitAtTranscript(page, w);
  const tx = page.locator('.seat-transcript .tx');
  expect((await final(page, w.id, '# Loader\n\nThe loader is half done.')).ok).toBe(true);
  await tx.getByRole('button', { name: 'Hire with handoff', exact: true }).click();
  const step1 = page.getByRole('dialog', { name: 'Hire with a handoff from Pebble' });
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.handoffDialog()))?.state).toBe('ready');
  const task = 'Fix the issue\n\n  - keep the tests green';
  await step1.getByLabel(/Task for the new agent/).fill(task);
  await step1.getByRole('button', { name: 'Continue to hire' }).click();
  const review = page.getByRole('dialog', { name: /^Hire with a handoff at Desk/ });
  await expect(review).toBeVisible();
  type Seen = { desk: number; blocker: string | null; choice: { effort: string; model: string; task: string }; form: { label: string; cwd: string } } | null;
  const seen = async () => (await page.evaluate(() => window.__h3d.dialog())) as Seen;
  // The human's choices: an effort, a label, another folder.
  await review.locator('label:has(> input[data-key="effort:high"])').click();
  await review.locator('[data-key="sec:where"]').click();
  await review.locator('#review-label').fill('Pip');
  const folder = `${w.cwd}/loader`;
  await review.locator('#review-cwd').fill(folder);
  await review.locator('#review-cwd').press('Tab');
  await expect.poll(async () => (await seen())?.form).toMatchObject({ label: 'Pip', cwd: folder });
  const before = (await seen())!;
  expect(before.choice.effort).toBe('high');
  // A newer reply: the one step 1 previewed is no longer the latest; filing it is refused and nobody is hired.
  expect((await final(page, w.id, '# Loader\n\nNow the loader is done.')).ok).toBe(true);
  await review.getByRole('button', { name: 'File handoff and hire' }).click();
  await expect(review.locator('[role="alert"]')).toContainText('Nobody was hired');
  await review.getByRole('button', { name: 'Back to the handoff' }).click();
  await expect(step1).toBeVisible();
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.handoffDialog()))?.state).toBe('ready');
  const again = (await page.evaluate(() => window.__h3d.handoffDialog()))!;
  expect(again.task).toBe(task);
  expect(again.text).toContain('Now the loader is done.');
  await step1.getByRole('button', { name: 'Continue to hire' }).click();
  await expect(review).toBeVisible();
  // The review as it was reviewed: the effort is not asked again, the label and the folder are the human's.
  await expect.poll(async () => (await seen())?.blocker).toBeNull();
  const after = (await seen())!;
  expect(after.desk).toBe(before.desk);
  expect(after.choice).toMatchObject({ effort: 'high', model: before.choice.model, task });
  expect(after.form).toMatchObject({ label: 'Pip', cwd: folder });
  await review.getByRole('button', { name: 'File handoff and hire' }).click();
  await expect(review).toBeHidden();
  const hires = (await page.evaluate(() => window.__h3d.sent().filter((c) => c.t === 'worker.hire'))) as Array<{ args: Record<string, unknown> }>;
  expect(hires).toHaveLength(1);
  expect(hires[0]?.args).toMatchObject({ effort: 'high', label: 'Pip', cwd: folder, desk_index: before.desk });
  expect(String(hires[0]?.args.prompt)).toMatch(/^First read the handoff here: \/home\/u\/handoff\/herdr-3d\/.+\.md and then follow these instructions:\n\nFix the issue/);
  expect((await page.evaluate(() => window.__h3d.sent().filter((c) => c.t === 'worker.handoff'))).length).toBe(2);
  await nothingToWorker(page);
  clean();
});
