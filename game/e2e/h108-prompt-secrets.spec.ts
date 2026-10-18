import { expect, test, type Page } from '@playwright/test';
import { frames, leftInTerminal, openGame, openMenu, seatMode, settingsSection, shot, watchErrors } from './game';

// #108 round 3: "Review prompt secrets before sending" against the fixture bridge (`sim=1`, tools/fixture-secrets.ts and
// its fake detector). The switch in Settings; a prompt with possible secrets opens the review of the whole prompt, where
// one match is ignored, one corrected and one value marked by hand; Confirm sends the decisions and the bridge sends the
// prompt with file references. Cancel sends nothing. Nothing of a protected value reaches localStorage or the command log.

const SIM = 'play=none&sim=1&simms=200&simusage=0';
const TEXT = 'Deploy with TOKEN=ghp_abcdefghijklmnopqrstu1 and PASSWORD="hunt😀r2"; the password is s3cr3t!x. Note: hunt😀r2 again, the db user is admin42';
/** Values that must never be kept by the page once protected. */
const PROTECTED = ['ghp_abcdefghijklmnopqrstu1', 'hunt😀r2', 'admin42'];

const sent = (page: Page, t: string) => page.evaluate((x) => window.__h3d.sent().filter((c) => c.t === x), t);
type Review = Extract<NonNullable<ReturnType<Window['__h3d']['dialog']>>, { kind: 'secrets-review' }>;
const review = (page: Page) => page.evaluate(() => window.__h3d.dialog()) as Promise<Review | null>;

/** Every value localStorage holds now, joined: a protected value must never be in it. */
const storage = (page: Page) => page.evaluate(() => Object.keys(localStorage).map((k) => `${k}=${localStorage.getItem(k) ?? ''}`).join('\n'));
async function noSecretStored(page: Page, at: string): Promise<void> {
  const all = await storage(page);
  for (const v of PROTECTED) expect(all.includes(v), `${at}: localStorage holds ${v}`).toBe(false);
}

async function idOf(page: Page, session: string, name: string): Promise<string> {
  return page.evaluate(([s, n]) => window.__h3d.world().find((f) => f.session === s)?.workers.find((w) => w.name === n)?.id ?? '', [session, name] as const);
}

/** Selects `[a, b)` of the review's prompt text (its tapes left out), as a drag or Shift+arrows would. */
async function selectInReview(page: Page, a: number, b: number): Promise<void> {
  await page.evaluate(
    ([a, b]) => {
      const prompt = document.querySelector('.sr-prompt') as HTMLElement;
      const nodes: Array<{ t: Text; at: number }> = [];
      let at = 0;
      const walk = document.createTreeWalker(prompt, NodeFilter.SHOW_TEXT);
      for (let t = walk.nextNode() as Text | null; t; t = walk.nextNode() as Text | null) {
        if (t.parentElement?.closest('.sr-tag')) continue;
        nodes.push({ t, at });
        at += t.data.length;
      }
      const find = (i: number) => {
        const n = nodes.find((x) => i >= x.at && i <= x.at + x.t.data.length)!;
        return [n.t, i - n.at] as const;
      };
      const r = document.createRange();
      r.setStart(...find(a));
      r.setEnd(...find(b));
      const s = document.getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
    },
    [a, b] as const,
  );
}

/** The review's prompt as it reads (the tapes left out). */
const reviewText = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector('.sr-prompt')!.cloneNode(true) as HTMLElement;
    c.querySelectorAll('.sr-tag').forEach((t) => t.remove());
    return c.textContent;
  });

test('the switch in Settings: off by default, kept on the bridge, followed from another client; no private directory said; hidden on an older bridge', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', `${SIM}&simsecretsdir=none&simsecrets=h108-settings-${Date.now()}`);
  await openMenu(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const section = await settingsSection(page, 'prompt-secrets');
  await expect(section.getByRole('heading', { name: 'Prompt secrets', level: 3 })).toBeVisible();
  await expect(section.locator('.settings-store')).toHaveText('Bridge');
  const toggle = section.getByRole('checkbox', { name: 'Review prompt secrets before sending' });
  await expect(toggle).not.toBeChecked();
  await expect(section).toContainText('the agent can still read a protected file');
  await expect(section).toContainText('no private runtime directory');
  await toggle.check();
  await expect(section).toContainText('On. Prompts are reviewed for secrets before they go.');
  expect((await sent(page, 'prompt_secrets.set')).map((c) => c.args)).toEqual([{ enabled: true }]);
  // Another client switches it off: this one follows.
  await page.evaluate(() => window.__h3d.inject({ t: 'prompt_secrets.update', seq: 1_000_000, enabled: false, available: false }));
  await expect(toggle).not.toBeChecked();
  await section.scrollIntoViewIfNeeded();
  await shot(page, 'h108-settings');
  clean();
});

test('an older bridge has no section', async ({ page }) => {
  await openGame(page, 'demo-m5', '', `${SIM}&simfail=no_secrets`);
  await openMenu(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[role="tab"][data-tab="prompt-secrets"]')).toBeHidden();
  await expect(dialog.locator('.settings-section[data-section="prompt-secrets"]')).toBeHidden();
  expect(await sent(page, 'prompt_secrets.scan')).toEqual([]);
});

test('the P overlay: found → the whole prompt reviewed (ignore one, correct one, mark one by hand) → Confirm → sent with file references', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', `${SIM}&simsecretson=1`);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  const id = await idOf(page, 'herdr-3d', 'Pebble');
  await page.evaluate((i) => window.__h3d.openPrompt(i), id);
  await expect(page.locator('dialog.desk-dlg--prompt')).toBeVisible();
  await page.keyboard.insertText(TEXT);
  await noSecretStored(page, 'typed');
  await page.keyboard.press('Enter');
  const dlg = page.locator('dialog.desk-dlg--secrets');
  await expect(dlg).toBeVisible();
  // Nothing went: only the scan, and the log keeps no text of it.
  expect(await sent(page, 'worker.prompt')).toEqual([]);
  expect((await sent(page, 'prompt_secrets.scan')).map((c) => c.args)).toEqual([{ text: '[redacted]', length: TEXT.length }]);
  // The whole prompt, exactly as typed; four matches, each on tape, the first in hand.
  expect(await reviewText(page)).toBe(TEXT);
  await expect(dlg.locator('.sr-mark')).toHaveCount(4);
  await expect(dlg.locator('.sr-mark .sr-tag')).toHaveText(Array(4).fill('Protected'));
  await expect(dlg.locator('#sr-sub')).toHaveText('To Pebble · 4 possible secrets found');
  const r = (await review(page)) as Review;
  expect(r.marks.map((m) => TEXT.slice(m.start, m.end))).toEqual(['ghp_abcdefghijklmnopqrstu1', 'hunt😀r2', 's3cr3t!x', 'hunt😀r2']);
  expect(r.current).toBe('c1');
  await noSecretStored(page, 'review open');

  // Ignore the prose one (N twice, Space): it stays plain text.
  await page.keyboard.press('n');
  await page.keyboard.press('n');
  await page.keyboard.press('Space');
  await expect(dlg.locator('.sr-mark[data-key="c3"] .sr-tag')).toHaveText('Ignored');
  // Correct the quoted one to take its quotes (→ the end, Shift+← the start), by keyboard.
  await page.keyboard.press('Shift+N');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(dlg.locator('.sr-mark[data-key="c2"] .sr-val')).toHaveText('"hunt😀r2"');
  // Mark "admin42" by hand: select it, then the strip's button.
  const a = TEXT.indexOf('admin42');
  await selectInReview(page, a, a + 'admin42'.length);
  await dlg.getByRole('button', { name: 'Mark the selection as secret' }).click();
  await expect(dlg.locator('.sr-mark[data-manual="true"] .sr-val')).toHaveText('admin42');
  await expect(dlg.locator('.sr-sum')).toHaveText('4 protected as files on the bridge host (1 marked by you), 1 ignored. Ignored matches are sent as plain text.');
  expect(await reviewText(page)).toBe(TEXT);
  await shot(page, 'h108-review');
  await noSecretStored(page, 'reviewed');
  expect(await sent(page, 'worker.prompt')).toEqual([]);

  await dlg.getByRole('button', { name: 'Confirm and send' }).click();
  await expect(dlg).toBeHidden();
  await expect.poll(async () => (await sent(page, 'worker.prompt')).length).toBe(1);
  const [cmd] = await sent(page, 'worker.prompt');
  const args = cmd!.args as { text: string; secrets: { decisions: Array<Record<string, unknown>> } };
  const q = (v: string, from = 0) => ({ start: TEXT.indexOf(v, from), end: TEXT.indexOf(v, from) + v.length });
  expect(args.secrets.decisions).toEqual([
    { candidate: 'c1', action: 'protect', ...q('ghp_abcdefghijklmnopqrstu1') },
    { candidate: 'c2', action: 'protect', start: q('hunt😀r2').start - 1, end: q('hunt😀r2').end + 1 },
    { candidate: 'c3', action: 'ignore' },
    { candidate: 'c4', action: 'protect', ...q('hunt😀r2', TEXT.indexOf('Note')) },
    { action: 'protect', ...q('admin42') },
  ]);
  // The command log masks every protected range, code unit for code unit; the ignored value stays as typed.
  expect(args.text).toHaveLength(TEXT.length);
  for (const v of PROTECTED) expect(args.text.includes(v)).toBe(false);
  expect(args.text).toContain('s3cr3t!x');
  expect(JSON.stringify(await page.evaluate(() => window.__h3d.sent()))).not.toMatch(/ghp_abcdefghijklmnopqrstu1|hunt😀r2|admin42/);
  // The bridge sent references; its files hold exactly the reviewed bytes.
  await expect.poll(() => page.evaluate(() => (window.__h3d.panel() as { state?: string } | null)?.state)).toBe('sent');
  const ack = (await sent(page, 'worker.prompt'))[0]!.result as { ok: boolean; data?: { sent?: string; protected?: number } };
  expect(ack.data?.protected).toBe(4);
  expect(ack.data?.sent).toMatch(/^Deploy with TOKEN=\[secret in file \/run\/user\/1000\/herdr-world\/secrets\/[^\]]+\] and PASSWORD=\[secret in file [^\]]+\]; the password is s3cr3t!x\. Note: \[secret in file [^\]]+\] again, the db user is \[secret in file [^\]]+\]$/);
  const files = (await page.evaluate(() => window.__h3d.simSecretFiles())).filter((f) => ack.data?.sent?.includes(f.path));
  expect(files.map((f) => f.text)).toEqual(['ghp_abcdefghijklmnopqrstu1', '"hunt😀r2"', 'hunt😀r2', 'admin42']);
  await noSecretStored(page, 'sent');
  clean();
});

async function sitAt(page: Page, name: string, mode: 'transcript' | 'terminal'): Promise<string> {
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  const id = await idOf(page, 'herdr-3d', name);
  if (mode === 'terminal') await leftInTerminal(page, id);
  expect(await page.evaluate((i) => window.__h3d.face(i), id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((i) => window.__h3d.sitAt(i), id)).toBe(true);
  await frames(page, 20);
  await seatMode(page, mode);
  return id;
}

test('the laptop’s prompt box: Cancel sends nothing and keeps the draft (in memory only); Confirm shows the row masked, then the references', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', `${SIM}&simsecretson=1&simecho=600`);
  const id = await sitAt(page, 'Pebble', 'transcript');
  const input = page.locator('.seat-transcript .tx .tx-input');
  await input.click();
  await page.keyboard.insertText(TEXT);
  await noSecretStored(page, 'typed in the box');
  await expect(page.locator('.seat-transcript .tx-review')).toBeVisible();
  await page.keyboard.press('Enter');
  const dlg = page.locator('dialog.desk-dlg--secrets');
  await expect(dlg).toBeVisible();
  // Esc is Cancel: nothing sent, still seated, the draft still in the box.
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(id);
  await expect(input).toHaveText(TEXT);
  expect(await sent(page, 'worker.prompt')).toEqual([]);
  expect(await page.evaluate(() => window.__h3d.seat().note)).toBe('Not sent: the prompt is still in the box.');
  await noSecretStored(page, 'cancelled');

  // Again, and Confirm (all protected): the pending row never shows a value, then shows what was sent.
  await input.click();
  await page.keyboard.press('Enter');
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'Confirm and send' }).click();
  const row = page.locator('.seat-transcript .tx-pending .tx-md');
  await expect(row).toContainText('[secret');
  for (const v of PROTECTED.slice(0, 2)) await expect(row).not.toContainText(v);
  await expect(row).toContainText('[secret in file /run/user/1000/herdr-world/secrets/');
  await expect(input).toHaveText('');
  await noSecretStored(page, 'sent from the box');
  clean();
});

test('a paste into an agent’s terminal is reviewed first: exact UTF-16 ranges across CRLF and an astral character', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', `${SIM}&simsecretson=1`);
  const id = await sitAt(page, 'Pebble', 'terminal');
  const paste = 'line one\r\nPASSWORD=p😀ss-w0rd\r\nAPI_KEY="k3y😀value"\r\nend';
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    document.querySelector('.seat-input')?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, paste);
  const dlg = page.locator('dialog.desk-dlg--secrets');
  await expect(dlg).toBeVisible();
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(id);
  expect(await reviewText(page)).toBe(paste);
  expect(await sent(page, 'worker.prompt')).toEqual([]);
  await dlg.getByRole('button', { name: 'Confirm and send' }).click();
  await expect.poll(async () => (await sent(page, 'worker.prompt')).length).toBe(1);
  const { secrets } = (await sent(page, 'worker.prompt'))[0]!.args as { secrets: { decisions: Array<{ start: number; end: number }> } };
  expect(secrets.decisions.map((d) => paste.slice(d.start, d.end))).toEqual(['p😀ss-w0rd', 'k3y😀value']);
  await expect.poll(() => page.evaluate(() => window.__h3d.seat().note)).toMatch(/Pasted into Pebble/);
  // The files hold exactly those bytes (the fixture's files are the whole simulated host's: this paste's by their paths).
  const ack = (await sent(page, 'worker.prompt'))[0]!.result as { ok: boolean; data?: { sent?: string } };
  expect(ack.data?.sent).toMatch(/^line one\r\nPASSWORD=\[secret in file [^\]]+\]\r\nAPI_KEY="\[secret in file [^\]]+\]"\r\nend$/);
  const files = (await page.evaluate(() => window.__h3d.simSecretFiles())).filter((f) => ack.data?.sent?.includes(f.path));
  expect(files.map((f) => [f.owner, f.text])).toEqual([
    [id, 'p😀ss-w0rd'],
    [id, 'k3y😀value'],
  ]);
  clean();
});

test('stale: reviewed again with a note, sent only on the new Confirm; the switch going off mid-review closes it, nothing sent', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', `${SIM}&simsecretson=1&simfail=secrets_review_stale`);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  const id = await idOf(page, 'herdr-3d', 'Pebble');
  await page.evaluate((i) => window.__h3d.openPrompt(i), id);
  await page.keyboard.insertText('ship it with TOKEN=abc123xyz');
  await page.keyboard.press('Enter');
  const dlg = page.locator('dialog.desk-dlg--secrets');
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'Confirm and send' }).click();
  // The bridge says the review is stale: it opens again, with why, and nothing went.
  await expect(dlg.locator('.sr-notice')).toContainText('no longer fits');
  expect((await sent(page, 'worker.prompt')).map((c) => c.result?.code)).toEqual(['secrets_review_stale']);
  await dlg.getByRole('button', { name: 'Confirm and send' }).click();
  await expect.poll(async () => (await sent(page, 'worker.prompt')).map((c) => c.result?.ok)).toEqual([false, true]);

  // The switch goes off (another client) while a review is open: it closes, nothing is sent, the note stays.
  const overlay = page.locator('dialog.desk-dlg--prompt');
  await overlay.locator('#prompt-text').click();
  await page.keyboard.insertText('and TOKEN=zzz999yyy');
  await page.keyboard.press('Enter');
  await expect(dlg).toBeVisible();
  await page.evaluate(() => window.__h3d.inject({ t: 'prompt_secrets.update', seq: 1_000_001, enabled: false, available: true }));
  await expect(dlg).toBeHidden();
  await expect(overlay.locator('p.dd-status[role="status"]')).toContainText('switched off');
  expect(await sent(page, 'worker.prompt')).toHaveLength(2);
  expect(await page.evaluate(() => (window.__h3d.panel() as { text?: string } | null)?.text)).toBe('and TOKEN=zzz999yyy');
  clean();
});
