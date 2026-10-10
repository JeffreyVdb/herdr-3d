import { expect, type Page } from '@playwright/test';
import { frames, leftInTerminal, openGame, openMenu, seatMode } from './game';
import { board as boardState, enter, faceBoard, waitNotes } from './m7';

// #216: the application surfaces, one opener each, shared by the screenshot spec, the coverage inventory and the
// contrast / font checks. A surface is opened on a fresh page (`boot`) with the UI, transcript and terminal themes seeded
// into localStorage before the page loads, exactly as a browser that saved them.

export type UiTheme = 'quiet' | 'ubuntu';
export interface Themes {
  ui?: UiTheme;
  transcript?: UiTheme;
  terminal?: UiTheme;
}

export const SIM = 'play=none&sim=1&simms=150&simusage=0&simlimits=ok';
export const NARROW = { width: 390, height: 844 } as const;
export const DESKTOP = { width: 1280, height: 720 } as const;

/** What to seed: Quiet is never stored (the default), like the app. */
export function seed(t: Themes): Record<string, string> {
  const kv: Record<string, string> = {};
  if (t.ui === 'ubuntu') kv['h3d.theme.ui'] = 'ubuntu';
  if (t.transcript === 'ubuntu') kv['h3d.theme.transcript'] = 'ubuntu';
  if (t.terminal === 'ubuntu') kv['h3d.theme.terminal'] = 'ubuntu';
  return kv;
}

export async function boot(page: Page, fixture: string, themes: Themes, extra = '', wsQuery = SIM, size: { width: number; height: number } = DESKTOP): Promise<void> {
  await page.setViewportSize(size);
  const kv = seed(themes);
  await page.addInitScript((entries) => {
    try {
      for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
      localStorage.setItem('h3d.monitors', 'terminal');
    } catch {
      /* blocked */
    }
  }, kv);
  await openGame(page, fixture, extra, wsQuery);
  await page.evaluate(() => window.__h3d.themeLoaded());
}

async function onFloor(page: Page, session = 'herdr-3d'): Promise<void> {
  await page.evaluate((s) => window.__h3d.enterFloor(s), session);
  await frames(page, 3);
}

/** Sits at Tofu (or another worker of demo-m5) and leaves its conversation or terminal up. Tofu waits on a question: its composer is off. */
export async function sitAtTofu(page: Page, mode: 'transcript' | 'terminal' = 'transcript', name = 'Tofu', minItems = 10): Promise<string> {
  await onFloor(page);
  const id = await page.evaluate((n) => window.__h3d.world().flatMap((f) => f.workers).find((w) => w.name === n)?.id ?? '', name);
  if (mode === 'terminal') await leftInTerminal(page, id);
  expect(await page.evaluate((i) => window.__h3d.face(i), id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((w) => window.__h3d.sitAt(w), id)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBe(id);
  await expect(page.locator('.seat')).toBeVisible();
  await frames(page, 12);
  await seatMode(page, mode);
  if (mode === 'transcript') {
    await expect.poll(async () => (await page.evaluate(() => window.__h3d.transcript()))?.items ?? 0).toBeGreaterThan(minItems);
    await expect(page.locator('.seat-transcript .tx')).toBeVisible();
  }
  await page.evaluate(() => window.__h3d.themeLoaded());
  await frames(page, 6);
  return id;
}

export interface Surface {
  name: string;
  fixture: string;
  extra?: string;
  wsQuery?: string;
  /** Opens it on a booted page. */
  open(page: Page): Promise<void>;
  /** What must be visible once open. */
  root: string;
  /** A narrow viewport can skip it (a 3D-only affordance). */
  skipNarrow?: boolean;
}

/** Into herdr-3d, in front of the whiteboard on the north wall; E opens the real editor, which draws a rectangle and keeps it selected (its property panel). */
export async function openWhiteboard(page: Page, draw = true): Promise<void> {
  await onFloor(page);
  await page.evaluate((floor) => {
    const b = window.__h3d.layout(floor)?.props.find((p) => p.id === 'whiteboard')?.box;
    if (!b) throw new Error('no whiteboard prop');
    window.__h3d.setPose({ x: (b.min[0] + b.max[0]) / 2, z: 2.4, yaw: 0, pitch: 0.02 });
  }, 'herdr-3d');
  await frames(page, 3);
  await page.keyboard.press('KeyE');
  await expect(page.locator('.wb .excalidraw')).toBeVisible({ timeout: 60_000 });
  await frames(page, 3);
  if (!draw) return;
  const box = await page.locator('.wb-canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  await page.keyboard.press('r');
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.35);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(box.x + box.width * (0.3 + 0.03 * i), box.y + box.height * (0.35 + 0.03 * i));
  await page.mouse.up();
  await page.waitForTimeout(300);
}

/** #215: a coder's report that asks something of its orchestrator: the look-at bar's request line and the inbox row's request. */
async function reportRequest(page: Page, long: boolean): Promise<string> {
  await enter(page);
  const text = `September parity fails on stale local CUR data. ${'More evidence follows. '.repeat(long ? 30 : 1)}Or the ORCHESTRATOR ACCEPTANCE of the existing evidence.`;
  const hire = await page.evaluate(() => window.__h3d.simCrew({ step: 'hire' }));
  const id = (hire.data as { id: string }).id;
  await page.evaluate(() => window.__h3d.simCrew({ step: 'onboard' }));
  await page.evaluate((t) => window.__h3d.simCrew({ step: 'report', summary: 'Implemented; head 3f9c2e1.', input_required: t, input_for: 'orchestrator' }), text);
  await expect.poll(() => page.evaluate(() => window.__h3d.needs().some((n) => n.session === 'lab' && n.desk === 13 && n.reason === 'blocked')), { timeout: 10_000 }).toBe(true);
  return id;
}

const dialog = (page: Page) => page.evaluate(() => window.__h3d.dialog());

/**
 * #212: the review of a dictated hire at Desk 6 of herdr-3d, from a fixture interpretation; `pick` shapes it from the
 * floor's own catalog (the hire dialog's default choice), as the dictation bar's interpreter would.
 */
async function openReview(page: Page, pick: (c: { harness: string; model: string; effort: string }) => Record<string, unknown>, expand: string[] = []): Promise<void> {
  await onFloor(page);
  await page.evaluate(() => window.__h3d.openHire(5));
  await expect.poll(async () => ((await dialog(page)) as { state?: string } | null)?.state).toBe('ready');
  const form = ((await dialog(page)) as { form: { harness: string; model: string; effort: string } }).form;
  await page.keyboard.press('Escape');
  await expect.poll(() => dialog(page)).toBeNull();
  expect(await page.evaluate((i) => window.__h3d.openHireReview(i as never, 5), pick(form))).toBe(true);
  await expect.poll(async () => ((await dialog(page)) as { kind?: string; state?: string } | null)?.state).toBe('ready');
  for (const id of expand) await page.locator(`.desk-dlg--review [data-key="sec:${id}"]`).click();
  await page.mouse.move(1, 1);
}
const said = (task: string) => ({ provenance: 'dictated', value: task, span: { source: 0, start: 0, end: task.length } });

export const SURFACES: Surface[] = [
  {
    name: 'bars-city',
    fixture: 'demo-m5',
    open: async (page) => void (await frames(page, 4)),
    root: '.topbar',
  },
  {
    // The plan-limits plate opened from its strip (the strip itself rides every surface's probes).
    name: 'limits-open',
    fixture: 'demo-m5',
    open: async (page) => {
      await frames(page, 4);
      await page.locator('.lm-strip').click();
      await expect(page.locator('#lm-panel')).toBeVisible();
    },
    root: '.limits',
  },
  {
    name: 'bars-floor',
    fixture: 'demo-m5',
    open: async (page) => {
      await onFloor(page);
      await page.evaluate(() => window.__h3d.plan(true));
      await frames(page, 3);
    },
    root: '.plan-card',
  },
  {
    name: 'menu',
    fixture: 'demo-m5',
    open: async (page) => {
      await openMenu(page);
    },
    root: '.topbar-menu',
  },
  {
    name: 'settings',
    fixture: 'demo-m5',
    open: async (page) => {
      await openMenu(page);
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    },
    root: 'dialog.settings',
  },
  {
    name: 'about',
    fixture: 'demo-m5',
    open: async (page) => {
      await openMenu(page);
      await page.getByRole('button', { name: 'About', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'About' })).toBeVisible();
    },
    root: 'dialog.about, dialog[aria-label="About"]',
  },
  {
    name: 'shortcuts',
    fixture: 'demo-m5',
    open: async (page) => {
      await onFloor(page);
      await page.keyboard.press('Shift+Slash');
      await expect.poll(() => page.evaluate(() => window.__h3d.shortcutsOpen())).toBe(true);
    },
    root: 'dialog.shortcuts, dialog[aria-label*="hortcut"]',
  },
  {
    name: 'music-pop',
    fixture: 'demo-m5',
    open: async (page) => {
      await openMenu(page);
      await page.locator('.audio-music').click();
      await expect(page.locator('.audio-pop:popover-open')).toBeVisible();
    },
    root: '.audio-pop',
  },
  {
    name: 'credits',
    fixture: 'demo-m5',
    open: async (page) => {
      await openMenu(page);
      await page.locator('.audio-music').click();
      await page.locator('.audio-credits').click();
      await expect(page.locator('dialog.credits').first()).toBeVisible();
    },
    root: 'dialog.credits',
  },
  {
    name: 'toast-info',
    fixture: 'demo-m5',
    open: async (page) => {
      await page.evaluate(() => window.__h3d.toast('Hired Nibble on desk 5', 'info'));
      await expect(page.locator('.toast')).toBeVisible();
    },
    root: '.toast',
  },
  {
    name: 'toast-warn',
    fixture: 'demo-m5',
    open: async (page) => {
      await page.evaluate(() => window.__h3d.toast('Hired, but Codex runs on its built-in server', 'warn'));
      await expect(page.locator('.toast')).toBeVisible();
    },
    root: '.toast',
  },
  {
    name: 'toast-error',
    fixture: 'demo-m5',
    open: async (page) => {
      await page.evaluate(() => window.__h3d.toast('Could not reach the bridge', 'error'));
      await expect(page.locator('.toast')).toBeVisible();
    },
    root: '.toast',
  },
  {
    name: 'hire',
    fixture: 'demo-m4',
    open: async (page) => {
      await onFloor(page);
      await page.evaluate(() => window.__h3d.openHire(5));
      await expect.poll(async () => ((await dialog(page)) as { kind?: string; state?: string } | null)?.state).toBe('ready');
      await page.locator('#hire-task').fill('Rework the header so it no longer overlaps the logo on mobile.');
    },
    root: 'dialog.desk-dlg--hire',
  },
  {
    // The hire composer holding a pasted screenshot: an image chip (its thumbnail and remove button) in the text.
    name: 'hire-chips',
    fixture: 'demo-m4',
    wsQuery: `${SIM}&upload_key=ui${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    open: async (page) => {
      await onFloor(page);
      await page.evaluate(() => window.__h3d.openHire(5));
      await expect.poll(async () => ((await dialog(page)) as { kind?: string; state?: string } | null)?.state).toBe('ready');
      await page.locator('#hire-task').fill('Match the header to this screenshot: ');
      await page.locator('#hire-task').press('End');
      await page.evaluate(async () => {
        const c = document.createElement('canvas');
        c.width = 640;
        c.height = 360;
        const g = c.getContext('2d') as CanvasRenderingContext2D;
        g.fillStyle = '#5e2750';
        g.fillRect(0, 0, c.width, c.height);
        const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b as Blob), 'image/png'));
        const dt = new DataTransfer();
        dt.items.add(new File([blob], 'header.png', { type: 'image/png' }));
        document.querySelector('#hire-task')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      await expect(page.locator('#hire-task .cmp-chip[data-status="ready"]')).toBeVisible({ timeout: 15_000 });
    },
    root: 'dialog.desk-dlg--hire',
  },
  {
    // Effort not given: its section is open with the interpreter's question and Hire is off; Harness and model opened by hand (a selected header).
    name: 'hire-review',
    fixture: 'demo-m4',
    open: async (page) => {
      await openReview(
        page,
        (c) => ({
          sources: ['Hire an agent to rework the header. Task: rework the header so it no longer overlaps the logo on mobile.'],
          harness: { provenance: 'dictated', value: c.harness },
          model: { provenance: 'resolved', value: c.model },
          effort: { provenance: 'missing' },
          task: said('Rework the header so it no longer overlaps the logo on mobile.'),
          questions: [{ field: 'effort', text: 'What effort level should this agent use?' }],
          ready_for_review: false,
        }),
        ['agent'],
      );
      await expect(page.locator('.desk-dlg--review [data-key="hire"]')).toBeDisabled();
    },
    root: 'dialog.desk-dlg--review',
  },
  {
    // What cannot be hired: a model not in the catalog, no effort, a task that starts with "--" (each section open, outlined, asking).
    name: 'hire-review-invalid',
    fixture: 'demo-m4',
    open: async (page) => {
      await openReview(page, (c) => ({
        sources: ['Hire an agent on GPT nine turbo. Task: --yolo fix the login bug.'],
        harness: { provenance: 'dictated', value: c.harness },
        model: { provenance: 'invalid', said: 'GPT nine turbo' },
        effort: { provenance: 'missing' },
        task: said('--yolo fix the login bug.'),
        questions: [{ field: 'model', text: 'Which model should this agent use?' }],
        ready_for_review: false,
      }));
      await expect.poll(async () => ((await dialog(page)) as { sections: Array<{ attention: boolean }> }).sections.filter((x) => x.attention).length).toBe(3);
      await expect(page.locator('.desk-dlg--review [data-key="hire"]')).toBeDisabled();
    },
    root: 'dialog.desk-dlg--review',
  },
  {
    // Everything given: every header collapsed with its value, Location opened (label, folder, worktree), Hire on.
    name: 'hire-review-ready',
    fixture: 'demo-m4',
    open: async (page) => {
      await openReview(
        page,
        (c) => ({
          sources: ['Hire an agent with high effort. Task: rework the header so it no longer overlaps the logo on mobile.'],
          harness: { provenance: 'dictated', value: c.harness },
          model: { provenance: 'resolved', value: c.model },
          effort: { provenance: 'dictated', value: c.effort },
          task: said('Rework the header so it no longer overlaps the logo on mobile.'),
          questions: [],
          ready_for_review: true,
        }),
        ['where'],
      );
      await expect(page.locator('.desk-dlg--review [data-key="hire"]')).toBeEnabled();
    },
    root: 'dialog.desk-dlg--review',
  },
  {
    // The elevator: a floor plate per floor, the one you are on lit (aria-current), an asleep floor's empty plate.
    name: 'elevator',
    fixture: 'demo-m3',
    open: async (page) => {
      await onFloor(page);
      await page.evaluate(() => window.__h3d.openElevator());
      await expect(page.locator('dialog.panel .lift-go[aria-current="location"]')).toBeVisible();
      await page.mouse.move(1, 1);
    },
    root: 'dialog.panel',
  },
  {
    // Buildings: each floor's small number plate beside its name.
    name: 'buildings',
    fixture: 'demo-m3',
    open: async (page) => {
      await onFloor(page);
      await page.evaluate(() => window.__h3d.openBuildings());
      await expect(page.locator('dialog.panel .dir-floor .lift-num--sm').first()).toBeVisible();
    },
    root: 'dialog.panel',
  },
  {
    name: 'start-run',
    fixture: 'demo-m4',
    open: async (page) => {
      await onFloor(page);
      await page.evaluate(() => window.__h3d.openStartRun({ session: 'herdr-3d', desk: 5 }));
      await expect.poll(async () => ((await dialog(page)) as { kind?: string; state?: string } | null)?.state).toBe('ready');
    },
    root: 'dialog.desk-dlg--run',
  },
  {
    name: 'presets',
    fixture: 'demo-m4',
    open: async (page) => {
      await onFloor(page);
      await page.evaluate(() => window.__h3d.openPresets());
      await expect(page.locator('dialog.desk-dlg--presets')).toBeVisible();
    },
    root: 'dialog.desk-dlg--presets',
  },
  {
    // A preset being deleted: the bridge's answer is held (the page's socket drops the command), so the final destructive
    // button stays busy: natively disabled and aria-busy, "Deleting…" with its spinner (busy wins, decisions #216 row 14).
    name: 'presets-deleting',
    fixture: 'demo-m4',
    open: async (page) => {
      await onFloor(page);
      await page.evaluate(() => {
        const send = WebSocket.prototype.send;
        WebSocket.prototype.send = function (this: WebSocket, ...a: Parameters<WebSocket['send']>) {
          if (typeof a[0] === 'string' && a[0].includes('"preset.delete"')) return;
          send.apply(this, a);
        };
      });
      await page.evaluate(() => window.__h3d.openPresets());
      const del = page.locator('dialog.desk-dlg--presets [data-key^="delete:"]:enabled').first();
      const id = (await del.getAttribute('data-key'))!.slice('delete:'.length);
      await del.click();
      const confirm = page.locator(`dialog.desk-dlg--presets [data-key="confirm-delete:${id}"]`);
      await confirm.click();
      await expect(confirm).toHaveAttribute('aria-busy', 'true');
      await expect(confirm).toBeDisabled();
      await page.mouse.move(1, 1);
    },
    root: 'dialog.desk-dlg--presets',
  },
  {
    name: 'prompt-dialog',
    fixture: 'demo-m4',
    open: async (page) => {
      await onFloor(page);
      const id = await page.evaluate(() => window.__h3d.world().find((f) => f.session === 'herdr-3d')!.workers[0]!.id);
      await page.evaluate((w) => window.__h3d.openPrompt(w), id);
      await expect(page.locator('dialog.desk-dlg--prompt')).toBeVisible();
    },
    root: 'dialog.desk-dlg--prompt',
  },
  {
    name: 'send-home',
    fixture: 'demo-m4',
    open: async (page) => {
      await onFloor(page);
      const id = await page.evaluate(() => window.__h3d.world().find((f) => f.session === 'herdr-3d')!.workers[0]!.id);
      await page.evaluate((w) => window.__h3d.openSendHome(w), id);
      await expect(page.locator('dialog.desk-dlg--home')).toBeVisible();
    },
    root: 'dialog.desk-dlg--home',
  },
  {
    // #223: the filing dialog with a reply's exact text (a sim.final of Zippy's), and the floor's filing cabinet.
    name: 'handoff-dialog',
    fixture: 'demo-m5',
    open: async (page) => {
      await onFloor(page);
      const id = await page.evaluate(() => window.__h3d.world().flatMap((f) => f.workers).find((w) => w.name === 'Zippy')!.id);
      await page.evaluate((w) => window.__h3d.simHandoff('sim.final', { id: w, text: '# Loader refactor\n\nThe loader streams now.\n\n```sh\nmake test\n```\n' }), id);
      await page.evaluate((w) => window.__h3d.openHandoff(w), id);
      await expect.poll(() => page.evaluate(() => window.__h3d.handoffDialog()?.state)).toBe('ready');
    },
    root: 'dialog.desk-dlg--handoff',
  },
  {
    name: 'cabinet',
    fixture: 'demo-m5',
    wsQuery: `${SIM}&simhandoffs=3`,
    open: async (page) => {
      await onFloor(page);
      await page.evaluate(() => window.__h3d.openCabinet('herdr-3d'));
      await expect(page.locator('dialog.cab .cab-row')).toHaveCount(3);
      await expect(page.locator('dialog.cab [data-hook="cab-doc"] h1')).toBeVisible();
    },
    root: 'dialog.cab',
  },
  {
    name: 'changes',
    fixture: 'demo-m4',
    open: async (page) => {
      await onFloor(page);
      const id = await page.evaluate(() => window.__h3d.world().find((f) => f.session === 'herdr-3d')!.workers.find((x) => x.status === 'working')!.id);
      await page.evaluate((w) => window.__h3d.openChanges(w), id);
      await expect(page.locator('dialog.changes')).toBeVisible();
    },
    root: 'dialog.changes',
  },
  {
    name: 'look-at-request',
    fixture: 'demo-m6',
    extra: '&open=none',
    open: async (page) => {
      const id = await reportRequest(page, true);
      expect(await page.evaluate((w) => window.__h3d.face(w), id)).toBe(true);
      await frames(page, 4);
      await expect(page.locator('.prompt .prompt-crew .crew-ask')).toContainText('Report request');
      await expect(page.locator('.prompt .prompt-crew .crew-more')).toBeVisible();
    },
    root: '.prompt',
  },
  {
    // A reviewer's verdict stamp in the look-at bar (the REVIEW r3 desk of the over-cap run: CHANGES · 2 BLOCKERS).
    name: 'crew-stamp',
    fixture: 'demo-m6',
    extra: '&open=none',
    open: async (page) => {
      await enter(page);
      const id = await page.evaluate(() => window.__h3d.crew().members.find((m) => m.desk === 2)?.id ?? '');
      expect(await page.evaluate((w) => window.__h3d.face(w), id)).toBe(true);
      await frames(page, 4);
      await expect(page.locator('.prompt .prompt-crew .crew-stamp')).toHaveText('CHANGES · 2 BLOCKERS');
    },
    root: '.prompt',
  },
  {
    name: 'inbox-request',
    fixture: 'demo-m6',
    extra: '&open=none',
    open: async (page) => {
      const id = await reportRequest(page, true);
      await page.locator('.ib-chip').click();
      const more = page.locator(`.ib-more[data-id="${id}"]`);
      await more.focus();
      await page.keyboard.press('Enter');
      await expect(page.locator(`#ib-req-${id}`)).toContainText('ORCHESTRATOR ACCEPTANCE');
    },
    root: '.inbox',
  },
  {
    // #215 with "Show the inbox" off: the chip is gone, the look-at bar says Shift+N, which opens the list anyway.
    name: 'inbox-forced-request',
    fixture: 'demo-m6',
    extra: '&open=none',
    open: async (page) => {
      await page.addInitScript(() => localStorage.setItem('h3d.inbox', JSON.stringify({ show: false })));
      await openGame(page, 'demo-m6', '&open=none', SIM);
      await page.evaluate(() => window.__h3d.themeLoaded());
      const id = await reportRequest(page, true);
      expect(await page.evaluate((w) => window.__h3d.face(w), id)).toBe(true);
      await frames(page, 4);
      await expect(page.locator('.ib-chip')).toBeHidden();
      await page.keyboard.press('Shift+N');
      await expect.poll(() => page.evaluate(() => window.__h3d.inbox())).toMatchObject({ open: true });
      await page.locator(`.ib-more[data-id="${id}"]`).focus();
      await page.keyboard.press('Enter');
      await expect(page.locator(`#ib-req-${id}`)).toContainText('ORCHESTRATOR ACCEPTANCE');
    },
    root: '.inbox, .prompt',
  },
  {
    name: 'board-issues',
    fixture: 'demo-m6',
    extra: '&open=none',
    open: async (page) => {
      await enter(page);
      await waitNotes(page, 8, 2);
      await faceBoard(page, 'lab', 'issues');
      await page.keyboard.press('e');
      await expect.poll(async () => (await boardState(page))?.kind).toBe('issues');
      await frames(page, 4);
    },
    root: 'dialog.desk-dlg--board',
  },
  {
    name: 'board-prs',
    fixture: 'demo-m6',
    extra: '&open=none',
    open: async (page) => {
      await enter(page);
      await waitNotes(page, 8, 2);
      await faceBoard(page, 'lab', 'prs');
      await page.keyboard.press('e');
      await expect.poll(async () => (await boardState(page))?.kind).toBe('prs');
      await frames(page, 4);
    },
    root: 'dialog.desk-dlg--board',
  },
  {
    name: 'palette',
    fixture: 'demo-m5',
    open: async (page) => {
      await page.keyboard.press('Control+KeyP');
      await expect(page.locator('dialog.palette')).toBeVisible();
    },
    root: 'dialog.palette',
  },
  {
    // On a floor while others need you: the foot's "2 floors need you · type @" hint (a button) is up.
    name: 'palette-hint',
    fixture: 'demo-m4',
    open: async (page) => {
      await onFloor(page);
      await page.keyboard.press('Control+KeyP');
      await expect(page.locator('dialog.palette')).toBeVisible();
      await expect(page.locator('dialog.palette .pal-hint')).toBeVisible();
    },
    root: 'dialog.palette',
  },
  {
    // #213: the dictation bar on a floor, a dictated command (two lines) in its box.
    name: 'dictation',
    fixture: 'demo-m4',
    open: async (page) => {
      await onFloor(page);
      await page.keyboard.press('Control+Shift+Space');
      await expect(page.locator('dialog.dictation')).toBeVisible();
      await page.locator('dialog.dictation textarea').fill('Hire a Claude agent on Sonnet 5.5 with high effort.\nTask: rework the header so it no longer overlaps the logo on mobile.');
    },
    root: 'dialog.dictation',
  },
  {
    // An error answer: no LLM is set up, so the interpreter is not ready; the text stays and the line says what to do.
    name: 'dictation-error',
    fixture: 'demo-m4',
    open: async (page) => {
      await page.keyboard.press('Control+Shift+Space');
      const field = page.locator('dialog.dictation textarea');
      await field.fill('Hire an agent to fix the login bug.');
      await field.press('Enter');
      await expect(page.locator('dialog.dictation .dict-status')).toHaveAttribute('data-tone', 'error');
    },
    root: 'dialog.dictation',
  },
  {
    // A floor's settings: a long form in the panel, its Save bar sticky at the foot.
    name: 'floor-settings',
    fixture: 'demo-m6',
    open: async (page) => {
      await enter(page, 'lab');
      await page.evaluate(() => window.__h3d.openElevator());
      await page.getByRole('button', { name: 'Settings for lab' }).click();
      await expect(page.locator('dialog.panel h2')).toHaveText('Floor settings');
    },
    root: 'dialog.panel',
  },
  {
    // One floor's overview: its first row is a worker's, at the top of the scrolling board.
    name: 'overview-floor',
    fixture: 'demo-m6',
    open: async (page) => {
      await enter(page, 'lab');
      await openMenu(page);
      await page.locator('.btn--overview:visible').first().click();
      await expect(page.locator('.ov .ov-row--worker').first()).toBeVisible();
      await page.waitForTimeout(700);
    },
    root: '.ov',
  },
  {
    name: 'overview',
    fixture: 'demo-m118',
    extra: '&open=none',
    open: async (page) => {
      await page.locator('.topbar-menu').evaluate((m) => (m as HTMLElement).hidePopover?.()).catch(() => undefined);
      await openMenu(page);
      await page.locator('.btn--overview-all:visible, .btn--overview:visible').first().click();
      await expect(page.locator('.ov')).toBeVisible();
      await page.waitForTimeout(700);
    },
    root: '.ov',
  },
  {
    name: 'whiteboard',
    fixture: 'demo',
    extra: '&me=Theo',
    wsQuery: `play=none&sim=1&simusage=0&wb_key=wb${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    open: async (page) => void (await openWhiteboard(page)),
    root: '.wb',
  },
  {
    // An empty board (a fresh one): the editor's welcome, its heading and the toolbar and menu hints.
    name: 'whiteboard-empty',
    fixture: 'demo',
    extra: '&me=Theo',
    wsQuery: `play=none&sim=1&simusage=0&wb_key=wb${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    open: async (page) => {
      await openWhiteboard(page, false); // (a short screen has no room for the welcome: Excalidraw leaves it out)
      await page.waitForTimeout(300);
    },
    root: '.wb',
  },
  {
    name: 'whiteboard-menu',
    fixture: 'demo',
    extra: '&me=Theo',
    wsQuery: `play=none&sim=1&simusage=0&wb_key=wb${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    open: async (page) => {
      await openWhiteboard(page);
      await page.locator('.wb .main-menu-trigger, .wb [data-testid="main-menu-trigger"]').first().click();
      await expect(page.locator('.dropdown-menu, .excalidraw .dropdown-menu').first()).toBeVisible();
    },
    root: '.wb',
  },
  // The editor's own popovers and dialogs (Excalidraw mounts its dialogs on body, in .excalidraw-modal-container).
  {
    name: 'whiteboard-colors',
    fixture: 'demo',
    extra: '&me=Theo',
    wsQuery: `play=none&sim=1&simusage=0&wb_key=wb${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    open: async (page) => {
      await openWhiteboard(page);
      await page.locator('.wb .color-picker__button.active-color').first().click();
      await expect(page.locator('.color-picker-content').first()).toBeVisible();
    },
    root: '.wb, .color-picker-content',
    skipNarrow: true, // the phone layout has no property panel open beside a selection
  },
  {
    name: 'whiteboard-tools',
    fixture: 'demo',
    extra: '&me=Theo',
    wsQuery: `play=none&sim=1&simusage=0&wb_key=wb${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    open: async (page) => {
      await openWhiteboard(page);
      await page.locator('.wb .App-toolbar__extra-tools-trigger').first().click();
      await expect(page.locator('.App-toolbar__extra-tools-dropdown').first()).toBeVisible();
    },
    root: '.wb, .App-toolbar__extra-tools-dropdown',
    skipNarrow: true, // the phone toolbar has no extra-tools menu
  },
  {
    name: 'whiteboard-context',
    fixture: 'demo',
    extra: '&me=Theo',
    wsQuery: `play=none&sim=1&simusage=0&wb_key=wb${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    open: async (page) => {
      await openWhiteboard(page);
      const box = await page.locator('.wb-canvas').boundingBox();
      if (!box) throw new Error('no canvas');
      await page.mouse.click(box.x + box.width * 0.36, box.y + box.height * 0.41, { button: 'right' });
      await expect(page.locator('.context-menu').first()).toBeVisible();
    },
    root: '.wb, .context-menu',
    skipNarrow: true, // a right click: no phone has one
  },
  {
    name: 'whiteboard-search',
    fixture: 'demo',
    extra: '&me=Theo',
    wsQuery: `play=none&sim=1&simusage=0&wb_key=wb${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    open: async (page) => {
      await openWhiteboard(page);
      await page.locator('.wb [data-testid="main-menu-trigger"]').first().click();
      await page.locator('[data-testid="search-menu-button"]').first().click();
      await expect(page.locator('.layer-ui__search, .sidebar').first()).toBeVisible();
    },
    root: '.wb, .layer-ui__search, .sidebar',
  },
  {
    name: 'whiteboard-help',
    fixture: 'demo',
    extra: '&me=Theo',
    wsQuery: `play=none&sim=1&simusage=0&wb_key=wb${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    open: async (page) => {
      await openWhiteboard(page);
      // The editor takes keys only while it has the focus (handleKeyboardGlobally: false): a click on empty canvas first.
      const box = await page.locator('.wb-canvas').boundingBox();
      if (!box) throw new Error('no canvas');
      await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.8);
      await page.keyboard.press('?');
      await expect(page.locator('.HelpDialog').first()).toBeVisible();
    },
    root: '.excalidraw-modal-container',
  },
  {
    name: 'whiteboard-mermaid',
    fixture: 'demo',
    extra: '&me=Theo',
    wsQuery: `play=none&sim=1&simusage=0&wb_key=wb${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    open: async (page) => {
      await openWhiteboard(page);
      await page.locator('.wb .App-toolbar__extra-tools-trigger').first().click();
      await page.locator('.App-toolbar__extra-tools-dropdown').getByText(/Mermaid/i).first().click();
      await expect(page.locator('.excalidraw-modal-container .Dialog, .excalidraw-modal-container .ttd-dialog').first()).toBeVisible();
    },
    root: '.excalidraw-modal-container',
    skipNarrow: true, // reached through the extra-tools menu, which the phone toolbar has not
  },
  {
    name: 'seat-transcript',
    fixture: 'demo-m5',
    extra: '&prints=0',
    open: async (page) => void (await sitAtTofu(page, 'transcript')),
    root: '.seat-transcript',
  },
  {
    // The composer's completion popup in the seated prompt box: `/` lists the worker's commands, `@comp` its files.
    name: 'completion-commands',
    fixture: 'demo-m5',
    extra: '&prints=0',
    open: async (page) => {
      await sitAtTofu(page, 'transcript', 'Nibble');
      await page.locator('.seat-transcript .cmp-editor').click();
      await page.keyboard.type('/');
      await expect(page.locator('.seat-transcript .cmp-pop [role="option"] .tx-cmd-name').first()).toBeVisible();
    },
    root: '.seat-transcript',
  },
  {
    name: 'completion-files',
    fixture: 'demo-m5',
    extra: '&prints=0',
    open: async (page) => {
      await sitAtTofu(page, 'transcript', 'Nibble');
      await page.locator('.seat-transcript .cmp-editor').click();
      await page.keyboard.type('look at @comp');
      await expect(page.locator('.seat-transcript .cmp-pop [role="option"] .tx-file').first()).toBeVisible();
    },
    root: '.seat-transcript',
  },
  {
    name: 'seat-terminal',
    fixture: 'demo-m5',
    extra: '&prints=0',
    open: async (page) => void (await sitAtTofu(page, 'terminal')),
    root: '.seat',
  },
  {
    name: 'seat-images',
    fixture: 'demo-m5',
    extra: '&prints=0',
    open: async (page) => {
      await sitAtTofu(page, 'transcript');
      await expect.poll(async () => (await page.evaluate(() => window.__h3d.transcript()))?.imageCount ?? 0).toBeGreaterThan(0);
      await page.locator('.seat-transcript .tx-bar .seat-tab[data-mode="images"]').click();
      await expect(page.locator('.seat-transcript .imgs')).toBeVisible();
      // (A phone shows two tiles, the rest are below the fold.)
      await expect.poll(() => page.locator('.imgs img.imgs-img').evaluateAll((els) => els.filter((e) => (e as HTMLImageElement).naturalWidth > 0).length)).toBeGreaterThan(0);
    },
    root: '.seat-transcript .imgs',
  },
  {
    name: 'lightbox',
    fixture: 'demo-m5',
    extra: '&prints=0',
    open: async (page) => {
      await sitAtTofu(page, 'transcript');
      await expect.poll(async () => (await page.evaluate(() => window.__h3d.transcript()))?.imageCount ?? 0).toBeGreaterThan(0);
      await page.locator('.seat-transcript .tx-bar .seat-tab[data-mode="images"]').click();
      const tile = page.locator('.imgs .imgs-group[data-origin="input"] .imgs-item .imgs-tile').first();
      await tile.click();
      const lb = page.locator('dialog.ilb');
      await expect(lb).toBeVisible();
      await expect(lb.locator('.ilb-img.ilb-loading')).toHaveCount(0);
    },
    root: 'dialog.ilb',
  },
];
