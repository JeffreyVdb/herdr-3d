import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Worker } from '../src/net/protocol';
import { frames, openGame, shot, watchErrors } from './game';

// #58: the transcript view says what the agent does and shows a prompt at once. demo-m5 with the simulating fixture
// server: Pebble is an idle claude; a prompt starts its turn a step (2.5 s) later and the ack follows, it works three
// steps, and `simecho` writes the prompt's user item to the watch 1.5 s after the agent took it (a queued one mid-turn).

const FLOOR = 'herdr-3d';
const SIM = 'play=none&sim=1&simms=2500&simusage=0&simecho=1500';

/** Pebble as the demo-m5 fixture has it: an idle claude. */
function pebble(): Worker {
  const snap = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/demo-m5.jsonl'), 'utf8').split('\n')[0] ?? '{}') as { world: { workers: Worker[] } };
  const w = snap.world.workers.find((x) => x.name === 'Pebble');
  if (!w) throw new Error('no Pebble in demo-m5');
  return w;
}

type Tx = NonNullable<ReturnType<Window['__h3d']['transcript']>>;
const txState = (page: Page) => page.evaluate(() => window.__h3d.transcript()) as Promise<Tx>;
const prompts = (page: Page) => page.evaluate(() => window.__h3d.sent().filter((c) => c.t === 'worker.prompt').map((c) => (c.args as { text: string }).text));
const status = (page: Page, id: string) => page.evaluate((i) => window.__h3d.status(i)?.status ?? null, id);

async function sitAt(page: Page, name: string, sim = SIM): Promise<string> {
  await openGame(page, 'demo-m5', '&prints=0', sim);
  await page.evaluate((s) => window.__h3d.enterFloor(s), FLOOR);
  await frames(page, 3);
  const id = await page.evaluate((n) => window.__h3d.world().flatMap((f) => f.workers).find((w) => w.name === n)?.id ?? '', name);
  expect(await page.evaluate((i) => window.__h3d.face(i), id), `facing ${name}`).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((w) => window.__h3d.sitAt(w), id)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBe(id);
  await expect.poll(async () => (await txState(page)).items).toBeGreaterThan(10);
  await page.keyboard.press('Control+Escape');
  await expect.poll(async () => (await txState(page)).mounted).toBe(true);
  await expect(page.locator('.seat-transcript .tx')).toBeVisible();
  return id;
}

/** The running animations under an element (pseudo-elements included) and the properties each animates. */
const animations = (el: Locator) =>
  el.evaluate((e) =>
    e.getAnimations({ subtree: true }).map((a) => ({
      state: a.playState,
      props: [...new Set(((a.effect as KeyframeEffect | null)?.getKeyframes() ?? []).flatMap((k) => Object.keys(k)).filter((k) => !['offset', 'computedOffset', 'easing', 'composite'].includes(k)))],
    })),
  );
/** Every animation of the overlay, wherever it is (a hidden one must have none running). */
const overlayAnimations = (page: Page) =>
  page.evaluate(() =>
    document
      .getAnimations()
      .map((a) => ({ a, el: (a.effect as KeyframeEffect | null)?.target ?? null }))
      .filter(({ el }) => !!el?.closest('.seat-transcript'))
      .map(({ a, el }) => `${el?.className ?? ''}:${a.playState}`),
  );

test('a prompt shows at once, Sending → Sent → its real item; the agent thinks, works, takes a queued prompt mid-turn', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  const id = await sitAt(page, 'Pebble');
  const tx = page.locator('.seat-transcript .tx');
  const scroller = tx.locator('.tx-scroll');
  const cue = tx.locator('.tx-activity');
  const pending = tx.locator('.tx-pending');
  expect(await status(page, id)).toBe('idle');
  await expect(cue).toHaveCount(0);

  // Scrolled up, write a prompt and send it: its row is there before the next frame, and the view is at the bottom.
  await scroller.evaluate((e) => {
    e.scrollTop = 0;
    e.dispatchEvent(new Event('scroll'));
  });
  await tx.locator('.tx-input').click();
  await page.keyboard.type('Add a test for the seat bar');
  const atOnce = await page.evaluate(async () => {
    document.querySelector<HTMLButtonElement>('.seat-transcript .tx-send')?.click();
    await new Promise((r) => requestAnimationFrame(r));
    const row = document.querySelector('.seat-transcript .tx-pending');
    const sc = document.querySelector('.seat-transcript .tx-scroll') as HTMLElement;
    return { state: row?.getAttribute('data-state') ?? null, text: row?.querySelector('.tx-bubble')?.textContent?.trim() ?? '', gap: sc.scrollHeight - sc.scrollTop - sc.clientHeight };
  });
  expect(atOnce).toMatchObject({ state: 'sending', text: 'Add a test for the seat bar' });
  expect(atOnce.gap).toBeLessThanOrEqual(32);
  await expect(pending.locator('.tx-pending-state')).toHaveText('Sending…');
  // A second Enter while it is on its way sends nothing.
  await page.keyboard.press('Enter');
  await frames(page, 2);
  expect(await prompts(page)).toEqual(['Add a test for the seat bar']);
  await shot(page, 'm58-sending');

  // The ack: Sent; the turn starts and nothing explains it yet: Thinking…, with a live elapsed time.
  await expect(pending.locator('.tx-pending-state')).toHaveText('Sent', { timeout: 10_000 });
  await expect.poll(() => status(page, id)).toBe('working');
  await expect(cue.locator('.tx-activity-label')).toHaveText('Thinking…');
  await expect(cue.locator('.tx-activity-time')).toHaveText(/^\d/);
  // One running animation, of opacity only, on the cue.
  expect(await animations(cue)).toEqual([{ state: 'running', props: ['opacity'] }]);
  expect(await cue.locator('.tx-activity-label').evaluate((e) => getComputedStyle(e).willChange)).toBe('opacity');
  expect(await tx.locator('.tx-live').getAttribute('aria-live')).toBe('polite');
  await expect(tx.locator('.tx-live')).toHaveText('Pebble is thinking');

  // Its user item arrives: the pending row is replaced, not doubled.
  await expect(pending).toHaveCount(0, { timeout: 10_000 });
  await expect(tx.locator('.tx-user:not(.tx-pending)', { hasText: 'Add a test for the seat bar' })).toHaveCount(1);
  await shot(page, 'm58-thinking');

  // Mid-turn, another prompt is queued; the agent takes it before its turn ends and it too is replaced.
  expect(await status(page, id)).toBe('working');
  await tx.locator('.tx-input').click();
  await page.keyboard.type('and the docs');
  await page.keyboard.press('Enter');
  await expect(pending.locator('.tx-pending-state')).toHaveText('Queued · Pebble takes it when it can');
  await shot(page, 'm58-queued');
  await expect(pending).toHaveCount(0, { timeout: 10_000 });
  await expect(tx.locator('.tx-user:not(.tx-pending)', { hasText: 'and the docs' })).toHaveCount(1);

  // The agent writes: Working….
  const top = await page.evaluate(() => window.__h3d.transcript()?.items ?? 0);
  await page.evaluate(([w, n]) => window.__h3d.simTranscript({ id: w as string, items: [{ id: 'm58-said', seq: 1000 + (n as number), ts: Date.now(), kind: 'assistant', parts: [{ text: 'Looking at the seat bar now.' }] }] }), [id, top] as const);
  await expect(cue.locator('.tx-activity-label')).toHaveText('Working…');
  expect(await animations(cue)).toEqual([{ state: 'running', props: ['opacity'] }]);

  // Terminal mode: out of the DOM, nothing of the overlay animating; back, it runs again.
  await page.keyboard.press('Control+Escape');
  await expect.poll(async () => (await txState(page)).mode).toBe('terminal');
  await expect(cue).toHaveCount(0);
  expect(await overlayAnimations(page)).toEqual([]);
  await page.keyboard.press('Control+Escape');
  await expect(cue.locator('.tx-activity-label')).toHaveText('Working…');
  expect(await animations(cue)).toEqual([{ state: 'running', props: ['opacity'] }]);

  // The worker stops working: gone within a frame, and no animation left.
  const w = pebble();
  await page.evaluate((x) => window.__h3d.inject({ t: 'worker.status', seq: 1_000_000, id: x.id, session: x.session, workspace_id: x.workspace_id, status: 'idle', prev_status: 'working', status_since: Date.now(), title: '' }), w);
  await frames(page, 1);
  expect(await page.evaluate(() => document.querySelectorAll('.seat-transcript .tx-activity').length)).toBe(0);
  // Nothing of the cue is left running (the demo's running Bash call keeps its own status dot).
  expect((await overlayAnimations(page)).filter((a) => a.startsWith('tx-activity'))).toEqual([]);
  clean();
});

test('a refused prompt leaves its reason and the draft; with reduced motion the cue is still, not flashing', async ({ page }) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const clean = watchErrors(page);
  const id = await sitAt(page, 'Pebble', `${SIM}&simfail=prompt_failed`);
  const tx = page.locator('.seat-transcript .tx');
  const pending = tx.locator('.tx-pending');
  await tx.locator('.tx-input').click();
  await page.keyboard.type('this one fails');
  await page.keyboard.press('Enter');
  await expect(pending).toHaveAttribute('data-state', 'refused', { timeout: 10_000 });
  await expect(pending.locator('.tx-pending-state')).toContainText('Not sent:');
  await expect(tx.locator('.tx-input')).toHaveText('this one fails');
  await shot(page, 'm58-refused');

  // Sent again: the error row goes, the prompt goes through, and the cue shows without an animation.
  await tx.locator('.tx-input').click();
  await page.keyboard.press('Enter');
  await expect(pending.locator('.tx-pending-state')).toHaveText('Sending…');
  await expect.poll(() => status(page, id), { timeout: 10_000 }).toBe('working');
  const cue = tx.locator('.tx-activity');
  await expect(cue.locator('.tx-activity-label')).toHaveText('Thinking…');
  expect(await animations(cue)).toEqual([]);
  expect(await cue.locator('.tx-activity-label').evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
  expect(await prompts(page)).toEqual(['this one fails', 'this one fails']);
  clean();
});
