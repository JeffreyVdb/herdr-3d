import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Ask, Worker } from '../src/net/protocol';
import { BINDINGS, type Binding } from '../src/input/shortcuts';
import { frames, openGame, seatMode, watchErrors } from './game';

// #124: single keys pause while a text field has focus (WCAG 2.1.4). Every character the shortcut table binds, lower and
// upper case, is typed into each kind of field the game has, and nothing fires (no dialog, no board, no inbox, no plan,
// no step, no list of shortcuts) while the text arrives intact. Ctrl+/ is the one chord that does fire from a field
// (the list of shortcuts), and never at a seat (the terminal's own: no seated help key).

const SIM = 'play=none&sim=1&simms=150&simusage=0';

/** Every key the table binds that types a character: `[key to press, the text it leaves]`, letters in both cases. */
function bound(): Array<[string, string]> {
  const out = new Map<string, string>();
  for (const b of BINDINGS as readonly Binding[]) {
    // Every binding counts, the readonly ones too (the walk keys W A S D are handled by the walker, not the dispatcher).
    for (const c of b.keys) {
      if (c.mod || c.ctrl) continue; // a modifier chord is not a character
      if (c.key !== undefined) out.set(c.key === '?' ? 'Shift+Slash' : c.key === ',' ? 'Comma' : c.key, c.key);
      else if (c.code && /^Key[A-Z]$/.test(c.code)) {
        out.set(c.code, c.code.slice(3).toLowerCase());
        out.set(`Shift+${c.code}`, c.code.slice(3));
      } else if (c.code && /^Digit\d$/.test(c.code)) out.set(c.code, c.code.slice(5));
    }
  }
  return [...out];
}

/** What typing everything leaves (and the characters, for the spec to know it covered the table). */
const KEYS = bound();
const TEXT = KEYS.map(([, t]) => t).join('');

const read = (field: Locator): Promise<string> => field.evaluate((e) => (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement ? e.value : (e.textContent ?? '').replaceAll('\u200b', '')));  // (the composer keeps zero-width spaces around its chips)

/** The state the shortcuts would change, to compare around the typing. */
async function world(page: Page): Promise<unknown> {
  return page.evaluate(() => ({
    pose: window.__h3d.pose(),
    view: window.__h3d.view(),
    dialog: window.__h3d.dialog()?.kind ?? null,
    panel: window.__h3d.panel()?.kind ?? null,
    board: window.__h3d.board()?.kind ?? null,
    inbox: window.__h3d.inbox()?.open ?? null,
    help: window.__h3d.shortcutsOpen(),
    // The commands a shortcut could send (the composers also ask the bridge about what is typed in them).
    sent: window.__h3d.sent().filter((c) => /^(worker\.|run\.start|board\.(move|comment|assign))/.test(c.t)).length,
    toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
  }));
}

/**
 * Types every bound key into the focused `field` and asserts the text came out as typed and nothing else happened.
 * (`keep`: the keys a field does not take as text, left out of the comparison: none today.)
 */
async function typeAll(page: Page, field: Locator, label: string): Promise<void> {
  await field.focus();
  const before = await world(page);
  for (const [key] of KEYS) await page.keyboard.press(key);
  await frames(page, 2);
  expect(await read(field), `${label}: the text arrives intact`).toBe(TEXT);
  const after = (await world(page)) as { toasts: unknown[] };
  expect(after, `${label}: no shortcut fired`).toEqual(before);
  await expect(field).toBeFocused();
}

/** Ctrl+/ from the field: the list opens over it, Esc closes it, and the focus and the text are as they were. */
async function chordOpensHelp(page: Page, field: Locator, label: string): Promise<void> {
  const text = await read(field);
  await field.focus();
  await page.keyboard.press('Control+Slash');
  await expect(page.locator('dialog.shortcuts'), `${label}: Ctrl+/ opens the list`).toBeVisible();
  expect(await read(field), `${label}: nothing typed by it`).toBe(text);
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.shortcuts')).toBeHidden();
  await expect(field, `${label}: the focus is back`).toBeFocused();
  expect(await read(field)).toBe(text);
}

async function onFloor(page: Page, fixture: string, floor: string, wsQuery = SIM, extra = '&open=none&prints=0'): Promise<void> {
  await openGame(page, fixture, extra, wsQuery);
  await page.evaluate((f) => window.__h3d.enterFloor(f), floor);
  await frames(page, 4);
}

test('the hire dialog: the task composer (contenteditable) and the model filter (a search input)', { tag: '@smoke' }, async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await onFloor(page, 'demo-m6', 'herdr-3d', `${SIM}&simmodels=24`);
  await page.keyboard.press('h');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.dialog()))?.kind === 'hire' && (await page.evaluate(() => window.__h3d.dialog()) as { state: string }).state, { timeout: 10_000 }).toBe('ready');
  const task = page.locator('#hire-task');
  await expect(task).toBeFocused();
  await typeAll(page, task, 'hire task');
  await chordOpensHelp(page, task, 'hire task');
  const filter = page.locator('dialog.desk-dlg--hire input.dd-search');
  await expect(filter).toBeVisible();
  await typeAll(page, filter, 'model filter');
  await chordOpensHelp(page, filter, 'model filter');
  clean();
});

test('the Start Run dialog: the extra-instructions composer, and its desk and preset selects keep their type-ahead', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await onFloor(page, 'demo-m6', 'herdr-3d');
  await page.keyboard.press('Shift+R');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.dialog()))?.kind === 'start-run' && (await page.evaluate(() => window.__h3d.dialog()) as { state: string }).state, { timeout: 10_000 }).toBe('ready');
  const extra = page.locator('#run-extra');
  await typeAll(page, extra, 'run extra instructions');
  await chordOpensHelp(page, extra, 'run extra instructions');
  // A <select> takes letters as type-ahead: no shortcut either, and the pick is the select's.
  const desk = page.locator('#run-desk');
  await desk.focus();
  const before = await world(page);
  for (const [key] of KEYS) await page.keyboard.press(key);
  await frames(page, 2);
  expect(await world(page), 'select: no shortcut fired').toEqual(before);
  await expect(desk).toBeFocused();
  clean();
});

test('Settings: a text input', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await onFloor(page, 'demo-m6', 'herdr-3d');
  await page.keyboard.press(',');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  const zone = dialog.getByLabel('Timezone');
  await typeAll(page, zone, 'settings timezone');
  await chordOpensHelp(page, zone, 'settings timezone');
  await zone.fill('');
  clean();
});

test('a board comment: a textarea', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await onFloor(page, 'demo-m6', 'herdr-3d');
  await page.evaluate(() => window.__h3d.openBoardItem('issues', 'JeffreyVdb/herdr-3d#12'));
  const comment = page.locator('#bd-comment');
  await expect(comment).toBeVisible({ timeout: 15_000 });
  await typeAll(page, comment, 'board comment');
  await chordOpensHelp(page, comment, 'board comment');
  clean();
});

function demoWorker(name: string): Worker {
  const snap = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/demo-m5.jsonl'), 'utf8').split('\n')[0] ?? '{}') as { world: { workers: Worker[] } };
  const w = snap.world.workers.find((x) => x.name === name);
  if (!w) throw new Error(`no ${name} in demo-m5`);
  return w;
}

const one: Partial<Ask> = {
  tool_use_id: 'toolu_h124_one',
  agent: 'claude',
  questions: [
    {
      header: 'Transport',
      question: 'How should the laptop upload pasted screenshots?',
      multi: false,
      other: true,
      options: [
        { label: 'HTTP POST via helper (Recommended)', description: 'Reuses the helper proxy' },
        { label: 'WebSocket chunks', description: 'Chunk framing' },
      ],
    },
  ],
};

test('at a seat: the transcript prompt and an ask card’s Other keep every character, and Ctrl+/ is the terminal’s, not a help key', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  const w = demoWorker('Pebble');
  await openGame(page, 'demo-m5', '&prints=0', 'play=none&sim=1&simms=300&simusage=0');
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.face(id), w.id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.sitAt(id), w.id)).toBe(true);
  await frames(page, 20);
  await seatMode(page, 'transcript');
  const tx = page.locator('.seat-transcript .tx');
  await expect.poll(() => page.evaluate(async () => (await window.__h3d.simTranscripts())?.watches ?? 0)).toBeGreaterThan(0);
  // The prompt box (a composer: contenteditable).
  const prompt = tx.locator('.tx-input');
  await prompt.focus();
  const before = await world(page);
  for (const [key] of KEYS) await page.keyboard.press(key);
  await frames(page, 2);
  expect(await read(prompt), 'transcript prompt: the text arrives intact').toBe(TEXT);
  expect(await world(page), 'transcript prompt: no shortcut fired, no help').toEqual(before);
  // Seated, Ctrl+/ is not a help key (and `?` is only a character).
  await page.keyboard.press('Control+Slash');
  await frames(page, 2);
  await expect(page.locator('dialog.shortcuts')).toBeHidden();
  expect(await page.evaluate(() => window.__h3d.shortcutsOpen())).toBe(false);
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(w.id);
  await prompt.evaluate((e) => ((e as HTMLElement).textContent = ''));

  // The ask card's Other: a text input inside the seated transcript.
  await page.evaluate(([id, a]) => window.__h3d.simAsk({ id: id as string, ask: a as Record<string, unknown> }), [w.id, one] as const);
  const card = tx.locator('.tx-ask');
  await expect(card).toBeVisible();
  await tx.locator('.tx-scroll').focus();
  await page.keyboard.press('3');
  const other = card.locator('.tx-ask-other-input');
  await expect(other).toBeFocused();
  for (const [key] of KEYS) await page.keyboard.press(key);
  await frames(page, 2);
  expect(await read(other), 'ask card Other: the text arrives intact').toBe(TEXT);
  expect(await page.evaluate(() => window.__h3d.shortcutsOpen())).toBe(false);
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(w.id);
  clean();
});

test('on the floor, with no dialog open: a select, a contenteditable and the ARIA text roles keep their keys too (typingIn)', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await onFloor(page, 'demo-m6', 'herdr-3d');
  // Fields the game's own pages have only inside dialogs: put one of each kind on the page itself, where the game's key handler is what decides.
  await page.evaluate(() => {
    const mk = (html: string) => {
      const d = document.createElement('div');
      d.className = 'h124-probe';
      d.style.cssText = 'position:fixed;left:0;bottom:0;z-index:99999';
      d.innerHTML = html;
      document.body.append(d);
    };
    mk('<select id="p-select"><option>one</option><option>two</option></select>');
    mk('<div id="p-ce" contenteditable="true" tabindex="0">x</div>');
    mk('<div id="p-textbox" role="textbox" tabindex="0"></div>');
    mk('<div id="p-combo" role="combobox" tabindex="0"></div>');
    mk('<div id="p-search" role="searchbox" tabindex="0"></div>');
    mk('<input id="p-input" type="text">');
    mk('<textarea id="p-area"></textarea>');
  });
  for (const id of ['p-select', 'p-ce', 'p-textbox', 'p-combo', 'p-search', 'p-input', 'p-area']) {
    const field = page.locator(`#${id}`);
    await field.focus();
    const before = await world(page);
    for (const [key] of KEYS) await page.keyboard.press(key);
    await frames(page, 2);
    expect(await world(page), `${id}: no shortcut fired`).toEqual(before);
    await expect(field).toBeFocused();
  }
  // Ctrl+/ still opens the list from any of them.
  await page.locator('#p-textbox').focus();
  await page.keyboard.press('Control+Slash');
  await expect(page.locator('dialog.shortcuts')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.shortcuts')).toBeHidden();
  // Out of them (the page), the same keys are shortcuts again.
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await page.keyboard.press('Shift+N');
  await expect(page.locator('.toast, .ib-list').first()).toBeVisible();
  clean();
});
