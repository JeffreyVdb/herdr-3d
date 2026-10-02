import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Worker } from '../src/net/protocol';
import { frames, openGame, watchErrors } from './game';

// #100 on demo-m4 with the simulator (laptops to sit at): the inbox's desktop notifications. The page's Notification is a recorder with the permission
// granted, and the window says it is not in front, so every ping is a notification. demo-m4 starts with blocked and
// done workers: the snapshot lists them silently (one "while you were away" toast), only live changes ping.

declare global {
  interface Window {
    __notes: Array<{ title: string; body: string; tag: string; renotify: boolean; click(): void }>;
  }
}

const workers = (): Worker[] => (JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/demo-m4.jsonl'), 'utf8').split('\n')[0] ?? '{}') as { world: { workers: Worker[] } }).world.workers;
const notes = (page: Page) => page.evaluate(() => window.__notes.map(({ title, body, tag, renotify }) => ({ title, body, tag, renotify })));

/** A live `worker.status`, as the bridge would send it (each with the next seq). */
function statuses(page: Page): (w: Worker, status: string) => Promise<void> {
  let seq = 2_000_000;
  return async (w, status) => {
    await page.evaluate(([x, st, n]) => window.__h3d.inject({ t: 'worker.status', seq: n, id: x.id, session: x.session, workspace_id: x.workspace_id, status: st, prev_status: x.status, status_since: Date.now(), title: '' }), [w, status, seq++] as const);
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__notes = [];
    class Recorder {
      static permission = 'granted';
      static requestPermission = () => Promise.resolve('granted');
      onclick: (() => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(title: string, o: { body: string; tag: string; renotify: boolean }) {
        window.__notes.push({ title, body: o.body, tag: o.tag, renotify: o.renotify, click: () => this.onclick?.() });
      }
      close(): void {
        this.onclose?.();
      }
    }
    Object.defineProperty(window, 'Notification', { value: Recorder, configurable: true, writable: true });
    document.hasFocus = () => false;
  });
});

test('pings: none on load, one per live need, a settled finish, never a freelancer’s finish or a restarted turn', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  const all = workers();
  const setStatus = statuses(page);
  const at = (session: string, ws: string) => all.find((w) => w.session === session && w.workspace_id === ws)!;
  await openGame(page, 'demo-m4', '', 'play=none&sim=1&simms=150');
  await frames(page, 3);

  // The snapshot's blocked and done workers: no notification, one soft summary instead.
  await expect(page.locator('.toast')).toContainText('While you were away:');
  expect(await notes(page)).toEqual([]);

  // Inky in the unassigned lot needs you: one notification, its id the tag.
  const inky = at('scratchpad', 'w2');
  await setStatus(inky, 'blocked');
  await expect.poll(() => notes(page)).toEqual([{ title: 'Inky needs you', body: 'Unassigned › scratchpad · needs you', tag: inky.id, renotify: false }]);

  // An employee's finish settles first, then pings once.
  const pip = at('herdr-3d', 'w7');
  await setStatus(pip, 'done');
  expect(await page.evaluate(() => window.__h3d.pendingPings())).toEqual([pip.id]);
  expect(await notes(page)).toHaveLength(1);
  await expect.poll(() => notes(page), { timeout: 10_000 }).toHaveLength(2);
  expect((await notes(page))[1]).toEqual({ title: 'Pip finished', body: 'Work › herdr-3d', tag: pip.id, renotify: false });

  // A turn that ends and starts again within the settle delay: nothing.
  const bean = at('herdr-3d', 'w9');
  await setStatus(bean, 'done');
  await setStatus(bean, 'working');
  expect(await page.evaluate(() => window.__h3d.pendingPings())).toEqual([]);

  // A freelancer (Mochi, CODE|) that finishes: settles, then nothing (freelancers are off by default).
  const mochi = at('herdr-3d', 'w3');
  await setStatus(mochi, 'done');
  expect(await page.evaluate(() => window.__h3d.pendingPings())).toEqual([mochi.id]);
  await expect.poll(() => page.evaluate(() => window.__h3d.pendingPings()), { timeout: 10_000 }).toEqual([]);
  expect(await notes(page)).toHaveLength(2);

  // A click takes you to the worker: on its floor, sat at its laptop.
  await page.evaluate(() => window.__notes[0]?.click());
  await expect.poll(() => page.evaluate(() => window.__h3d.seated()), { timeout: 20_000 }).toBe(inky.id);
  expect(await page.evaluate(() => window.__h3d.where()?.loaded)).toBe('scratchpad');

  // With Settings up (a modal), a click shuts it first: seated at the worker's terminal, the keyboard on its laptop.
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await page.evaluate(() => window.__notes[1]?.click());
  await expect.poll(() => page.evaluate(() => window.__h3d.seated()), { timeout: 20_000 }).toBe(pip.id);
  await expect(settings).toBeHidden();
  expect(await page.evaluate(() => window.__h3d.where()?.loaded)).toBe('herdr-3d');
  await expect.poll(() => page.evaluate(() => window.__h3d.seat().mode)).toBe('terminal');
  await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('seat-input'))).toBe(true);
  clean();
});

test('a collapsed burst’s click shuts the modal that is up (Settings) and shows the inbox list', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  const all = workers();
  const setStatus = statuses(page);
  const at = (session: string, ws: string) => all.find((w) => w.session === session && w.workspace_id === ws)!;
  await openGame(page, 'demo-m4', '', 'play=none&sim=1&simms=150');
  await frames(page, 3);

  // Four employees start needing you within the burst window: the fourth collapses them into one notification.
  for (const ws of ['w7', 'w9', 'w8', 'wc']) await setStatus(at('herdr-3d', ws), 'blocked');
  await expect.poll(() => page.evaluate(() => window.__notes.findLast((n) => n.tag === 'h3d-inbox')?.title)).toBe('4 agents need you');

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  expect((await page.evaluate(() => window.__h3d.inbox()))?.open).toBe(false);
  await page.evaluate(() => window.__notes.findLast((n) => n.tag === 'h3d-inbox')?.click());
  await expect(settings).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__h3d.inbox()?.open)).toBe(true);
  await expect(page.locator('.ib-list')).toBeVisible();
  clean();
});
