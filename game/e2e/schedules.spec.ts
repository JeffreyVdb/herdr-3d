import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Worker } from '../src/net/protocol';
import { frames, openGame, openMenu, seatMode, shot, watchErrors } from './game';

test.use({ timezoneId: 'Europe/Brussels' });

// #64 schedules (part 3 of #61): the scheduled agents dialog against the fixture bridge (`sim=1`,
// tools/fixture-schedule.ts): "New" from the Menu creates one, the palette opens the dialog, "Schedule follow-up…"
// under a reply files it as a literal handoff exactly once and schedules with its path, a fire updates an open dialog
// live, and a toast's click opens the dialog on that row.

const SIM = 'play=none&sim=1&simms=150&simusage=0';
const HOUR = 3_600_000;

function demoWorker(name: string): Worker {
  const snap = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/demo-m5.jsonl'), 'utf8').split('\n')[0] ?? '{}') as { world: { workers: Worker[] } };
  const w = snap.world.workers.find((x) => x.name === name);
  if (!w) throw new Error(`no ${name} in demo-m5`);
  return w;
}

const sent = (page: Page) => page.evaluate(() => window.__h3d.sent().map((c) => ({ t: c.t as string, args: c.args as Record<string, unknown>, ok: c.result?.ok })));
const list = (page: Page) => page.evaluate(() => window.__h3d.schedules());

async function onFloor(page: Page): Promise<void> {
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
}

test('“New” from the Menu schedules an agent; the palette opens the dialog', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', SIM);
  await onFloor(page);
  await openMenu(page);
  await page.locator('.topbar-menu [data-action="schedules"]').click();
  const dlg = page.getByRole('dialog', { name: 'Scheduled agents' });
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('[data-hook="sch-empty"]')).toContainText('No scheduled agents on herdr-3d.');
  await dlg.locator('[data-key="new"]').click();
  const form = page.getByRole('dialog', { name: 'Schedule an agent' });
  await expect(form).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__h3d.scheduleForm()?.harness)).not.toBe('');
  await expect(form.locator('[data-key="save"]')).toHaveAttribute('aria-disabled', 'true');
  await form.locator('#sf-title-in').fill('After the soak');
  await form.locator('#sf-when').fill('in 2h');
  await expect(form.locator('[data-hook="sf-resolved"]')).toContainText('UTC');
  await expect(form.locator('[data-hook="sf-resolved"]')).toContainText('in 2 h');
  await form.locator('#sf-prompt').click();
  await page.keyboard.type('Delete the backups and close the ticket.');
  await expect(form.locator('[data-key="save"]')).not.toHaveAttribute('aria-disabled', 'true');
  await shot(page, 'h64-schedule-form');
  const before = Date.now();
  await form.locator('[data-key="save"]').click();
  await expect(form).toBeHidden();
  // Back in the list: the new row, marked.
  await expect.poll(async () => (await list(page))?.upcoming.map((r) => r.title)).toEqual(['After the soak']);
  const s = await list(page);
  expect(s?.focus).toBe(s?.upcoming[0]?.id);
  const create = (await sent(page)).find((c) => c.t === 'schedule.create');
  expect(create?.args).toMatchObject({ floor: 'herdr-3d', title: 'After the soak', prompt: 'Delete the backups and close the ticket.', on_miss: 'run_late', wake_floor: true });
  const due = create?.args.due_at as number;
  expect(due).toBeGreaterThanOrEqual(before + 2 * HOUR - 60_000);
  expect(due).toBeLessThanOrEqual(Date.now() + 2 * HOUR);
  await shot(page, 'h64-schedules');
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  // The palette's row (no key of its own).
  await page.keyboard.press('Control+KeyP');
  await page.locator('dialog.palette .pal-input').fill('scheduled agents');
  await page.keyboard.press('Enter');
  await expect(dlg).toBeVisible();
  expect((await list(page))?.upcoming).toHaveLength(1);
  clean();
});

test('“Schedule follow-up…” files the reply once, as written, and schedules with its path', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', SIM);
  const w = demoWorker('Zippy');
  await onFloor(page);
  expect(await page.evaluate((id) => window.__h3d.face(id), w.id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.sitAt(id), w.id)).toBe(true);
  await frames(page, 20);
  await seatMode(page, 'transcript');
  const r = await page.evaluate((id) => window.__h3d.simHandoff('sim.final', { id, text: '# Soak started\n\nThe 24h soak runs until 10:45 UTC tomorrow; then delete the backups.' }), w.id);
  expect(r.ok).toBe(true);
  const tx = page.locator('.seat-transcript .tx');
  const follow = tx.getByRole('button', { name: 'Schedule follow-up…' });
  await expect(follow).toHaveCount(1);
  await expect(tx.getByRole('button', { name: 'Handoff', exact: true })).toHaveCount(1);
  await follow.click();
  const form = page.getByRole('dialog', { name: 'Schedule a follow-up to Zippy' });
  await expect(form).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__h3d.scheduleForm()?.preparing)).toBe(false);
  const f = await page.evaluate(() => window.__h3d.scheduleForm());
  expect(f).toMatchObject({ handoff: 'transcript', when: '', due: null, harness: w.harness, cwd: w.cwd });
  await form.locator('#sf-title-in').fill('After the soak');
  await form.locator('#sf-when').fill('tomorrow 10:45 UTC');
  await shot(page, 'h64-follow-up-form');
  await form.getByRole('button', { name: 'File and schedule' }).click();
  await expect(form).toBeHidden();
  const cmds = await sent(page);
  const filed = cmds.filter((c) => c.t === 'worker.handoff');
  expect(filed).toHaveLength(1);
  expect(filed[0]?.args).toMatchObject({ worker: w.id, mode: 'literal' });
  const create = cmds.find((c) => c.t === 'schedule.create');
  expect(create?.args).toMatchObject({ prompt: '', source: { kind: 'transcript', worker: w.id } });
  expect(String(create?.args.handoff_path)).toMatch(/^\//);
  // Nothing went to the worker; the seat stays.
  expect(cmds.filter((c) => ['worker.prompt', 'worker.keys', 'worker.fire'].includes(c.t))).toEqual([]);
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(w.id);
  // The cabinet has it, once.
  await expect.poll(() => page.evaluate(() => window.__h3d.filing().drawers?.reduce((a, b) => a + b, 0) ?? 0)).toBe(1);
  clean();
});

test('a fire updates the open dialog live; with it closed, a toast’s click opens it on that row', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', `${SIM}&simschedules=8`);
  await onFloor(page);
  await page.evaluate(() => window.__h3d.openSchedules({ floor: null, allFloors: true }));
  await expect.poll(async () => (await list(page))?.upcoming.length ?? 0).toBeGreaterThan(0);
  const soak = (await list(page))!.upcoming.find((r) => r.title === 'After the soak')!;
  expect(soak.actions).toEqual(['edit', 'run-now', 'cancel']);
  // Played 3 h late by the bridge: running, then done with the late badge, without closing the dialog.
  await page.locator(`.sch-row[data-id="${soak.id}"] [data-act="edit"]`).focus();
  expect((await page.evaluate((id) => window.__h3d.simSchedule('sim.schedule_fire', { id, late_ms: 3 * 3_600_000 }), soak.id)).ok).toBe(true);
  await expect.poll(async () => (await list(page))?.done.find((r) => r.id === soak.id)?.late ?? null).toBe('+3h late');
  await expect(page.locator(`.sch-row[data-id="${soak.id}"] .sch-late`)).toHaveText('+3h late');
  // No toast while the dialog shows it.
  expect((await page.evaluate(() => window.__h3d.toastState()))?.action ?? null).toBeNull();
  await shot(page, 'h64-schedules-live');
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.sch')).toBeHidden();
  // Closed: a failure toasts, and its click opens the dialog on that row.
  const next = await page.evaluate(() => {
    window.__h3d.openSchedules({ floor: null, allFloors: true });
    const s = window.__h3d.schedules()!;
    return s.upcoming.find((r) => r.state === 'scheduled')!.id;
  });
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.sch')).toBeHidden();
  expect((await page.evaluate((id) => window.__h3d.simSchedule('sim.schedule_fire', { id, fail: 'floor herdr-3d is gone' }), next)).ok).toBe(true);
  const toast = page.locator('.toast');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('failed: floor herdr-3d is gone.');
  await expect(toast.getByRole('button', { name: 'Show' })).toBeVisible();
  await shot(page, 'h64-toast');
  await toast.click();
  await expect(page.locator('dialog.sch')).toBeVisible();
  const s = await list(page);
  expect(s?.focus).toBe(next);
  expect(s?.attention.map((r) => r.id)).toContain(next);
  await expect(page.locator(`.sch-row[data-id="${next}"]`)).toHaveAttribute('data-focus', 'true');
  await expect(page.locator(`.sch-row[data-id="${next}"]`)).toBeFocused();
  // Retry and Dismiss from the dialog: dismissed, it leaves the list.
  await page.locator(`.sch-row[data-id="${next}"] [data-act="dismiss"]`).click();
  await expect.poll(async () => (await list(page))?.attention.map((r) => r.id).includes(next)).toBe(false);
  clean();
});

// #66 schedule suggestions: Zippy starts with a finished rollout reply whose suggestion is the chip
// (`simschedsuggest=on&simsuggest=<key>`, tools/fixture-schedsuggest.ts). Its click opens the form prefilled from it;
// only Save schedules, and the chip goes. Its × dismisses it for good: a reload does not bring it back.
const suggestSim = (key: string) => `${SIM}&simschedsuggest=on&simsuggest=${key}-${Date.now()}`;

async function sitAtZippy(page: Page, params: string): Promise<{ w: Worker; tx: ReturnType<Page['locator']> }> {
  await openGame(page, 'demo-m5', '', params);
  const w = demoWorker('Zippy');
  await onFloor(page);
  expect(await page.evaluate((id) => window.__h3d.face(id), w.id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.sitAt(id), w.id)).toBe(true);
  await frames(page, 20);
  await seatMode(page, 'transcript');
  return { w, tx: page.locator('.seat-transcript .tx') };
}

test('the suggestion chip opens the form prefilled; Save schedules it and the chip goes', async ({ page }) => {
  const clean = watchErrors(page);
  const { w, tx } = await sitAtZippy(page, suggestSim('save'));
  const suggestion = await page.evaluate((id) => window.__h3d.worker(id)?.schedule_suggestion, w.id);
  expect(suggestion).toBeTruthy();
  const made = new Date(suggestion!.at);
  const due = Date.UTC(made.getUTCFullYear(), made.getUTCMonth(), made.getUTCDate() + 1, 10, 45);
  expect(suggestion!.due_at).toBe(due);
  // The fixture's UTC tomorrow can already be today in the viewer's zone near midnight.
  const label = await page.evaluate((at) => {
    const date = new Date(at);
    const day = date.toDateString() === new Date().toDateString() ? 'today' : 'tomorrow';
    const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    const utc = Intl.DateTimeFormat().resolvedOptions().timeZone === 'UTC' ? '' : ' (10:45 UTC)';
    return `Schedule follow-up · ${day} ${clock}${utc}`;
  }, due);
  const chip = tx.getByRole('button', { name: label, exact: true });
  await expect(chip).toHaveCount(1);
  // On the reply's row, beside Handoff, in place of the plain button.
  await expect(tx.getByRole('button', { name: 'Schedule follow-up…' })).toHaveCount(0);
  await expect(tx.locator('.tx-handoff').getByRole('button', { name: 'Handoff', exact: true })).toHaveCount(1);
  await expect(tx.getByRole('button', { name: 'Dismiss the suggested follow-up' })).toHaveCount(1);
  // The game told the bridge its zone on connect, once, and the bridge took it.
  await expect.poll(async () => (await sent(page)).filter((c) => c.t === 'schedule_suggestions.zone').map((c) => c.ok)).toEqual([true]);
  await shot(page, 'h66-suggestion-chip');
  await chip.click();
  const form = page.getByRole('dialog', { name: 'Schedule a follow-up to Zippy' });
  await expect(form).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__h3d.scheduleForm()?.preparing)).toBe(false);
  const f = await page.evaluate(() => window.__h3d.scheduleForm());
  expect(f).toMatchObject({ title: 'Post-soak cleanup: Vector 0.59 rollout', handoff: 'transcript', harness: w.harness, cwd: w.cwd });
  expect(f?.due).toBe(due);
  // Opening it scheduled nothing.
  expect((await sent(page)).filter((c) => c.t === 'schedule.create')).toEqual([]);
  await shot(page, 'h66-suggestion-form');
  await form.getByRole('button', { name: 'File and schedule' }).click();
  await expect(form).toBeHidden();
  const create = (await sent(page)).find((c) => c.t === 'schedule.create');
  expect(create?.args).toMatchObject({ title: 'Post-soak cleanup: Vector 0.59 rollout', due_at: due, source: { kind: 'suggestion', worker: w.id } });
  expect(String(create?.args.prompt)).toContain('You are picking up the Vector 0.59 rollout');
  // The bridge has it.
  await expect.poll(async () => (await sent(page)).find((c) => c.t === 'schedule.create')?.ok).toBe(true);
  await expect(tx.locator('.tx-sched-sug')).toHaveCount(0);
  await expect(tx.getByRole('button', { name: 'Schedule follow-up…' })).toHaveCount(1);
  clean();
});

test('the chip’s × dismisses it for good: a reload does not bring it back', async ({ page }) => {
  const clean = watchErrors(page);
  const params = suggestSim('dismiss');
  const { tx } = await sitAtZippy(page, params);
  await expect(tx.locator('.tx-sched-sug')).toHaveCount(1);
  // Cancelling the form leaves it.
  await tx.locator('.tx-sched-sug').click();
  const form = page.getByRole('dialog', { name: 'Schedule a follow-up to Zippy' });
  await expect(form).toBeVisible();
  await form.locator('[data-key="cancel"]').click();
  await expect(form).toBeHidden();
  await expect(tx.locator('.tx-sched-sug')).toHaveCount(1);
  await tx.getByRole('button', { name: 'Dismiss the suggested follow-up' }).click();
  await expect(tx.locator('.tx-sched-sug')).toHaveCount(0);
  await expect(tx.getByRole('button', { name: 'Schedule follow-up…' })).toHaveCount(1);
  expect((await sent(page)).filter((c) => c.t === 'worker.dismiss_schedule_suggestion' && c.ok)).toHaveLength(1);
  expect((await sent(page)).filter((c) => c.t === 'schedule.create')).toEqual([]);
  const again = await sitAtZippy(page, params);
  await expect(again.tx.getByRole('button', { name: 'Schedule follow-up…' })).toHaveCount(1);
  await expect(again.tx.locator('.tx-sched-sug')).toHaveCount(0);
  clean();
});
