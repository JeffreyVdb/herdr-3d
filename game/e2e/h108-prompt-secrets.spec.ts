import { expect, test, type Page } from '@playwright/test';
import { frames, leftInTerminal, openGame, openMenu, seatMode, settingsSection, shot, watchErrors } from './game';
import { CLEANUP, fakeJev, fakeOpenAI, setUpPackupClock, switchOn, withPositivePackup } from './packupFakes';
import { boot, SURFACES } from './ui-surfaces';

// #108 round 3: "Review prompt secrets before sending" against the fixture bridge (`sim=1`, tools/fixture-secrets.ts and
// its fake detector). The switch in Settings; a prompt with possible secrets opens the review of the whole prompt, where
// one match is ignored, one corrected and one value marked by hand; Confirm sends the decisions and the bridge sends the
// prompt with file references. Cancel sends nothing. Nothing of a protected value reaches localStorage or the command log.
// The two pack-up hand-over cases use the same scripted model replies in process: their focus is the protected-file
// hand-over and confirmation. Provider HTTP setup, timeout behavior and model-response parsing have separate coverage.

const SIM = 'play=none&sim=1&simms=200&simusage=0';
const TEXT = 'Deploy with TOKEN=ghp_abcdefghijklmnopqrstu1 and PASSWORD="hunt😀r2"; the password is s3cr3t!x. Note: hunt😀r2 again, the db user is admin42';
/** Values that must never be kept by the page once protected. */
const PROTECTED = ['ghp_abcdefghijklmnopqrstu1', 'hunt😀r2', 'admin42'];

const sent = (page: Page, t: string) => page.evaluate((x) => window.__h3d.sent().filter((c) => c.t === x), t);
type Review = Extract<NonNullable<ReturnType<Window['__h3d']['dialog']>>, { kind: 'secrets-review' }>;
const review = (page: Page) => page.evaluate(() => window.__h3d.dialog()) as Promise<Review | null>;

/** The bridge finishes its scan (or scans again after a stale review) before the review opens. */
async function secretReviewReady(page: Page, notice?: string): Promise<void> {
  await expect.poll(() => page.evaluate((notice) => {
    const dialog = window.__h3d.dialog();
    if (dialog?.kind === 'secrets-review' && (!notice || dialog.notice?.includes(notice))) return 'ready';
    const scan = window.__h3d.sent().filter((c) => c.t === 'prompt_secrets.scan').at(-1)?.result;
    return JSON.stringify({
      dialog: dialog?.kind ?? null,
      scan: !scan ? 'pending' : scan.ok ? 'acknowledged' : scan.code,
      notice: dialog?.kind === 'secrets-review' ? dialog.notice : null,
    });
  }, notice), { message: 'the prompt scan opens its secret review', timeout: 20_000 }).toBe('ready');
  await expect(page.locator('dialog.desk-dlg--secrets')).toBeVisible();
}

/** The file paths of the `[secret in file …]` references in a sent text (the fixture's file list is the whole host's). */
const refsOf = (sent: string | undefined) => new Set([...(sent ?? '').matchAll(/\[secret in file ([^\]]+)\]/g)].map((m) => m[1]));

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
  await secretReviewReady(page);
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
  const refs = refsOf(ack.data?.sent);
  const files = (await page.evaluate(() => window.__h3d.simSecretFiles())).filter((f) => refs.has(f.path));
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
  await secretReviewReady(page);
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
  await secretReviewReady(page);
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
  await secretReviewReady(page);
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
  const refs = refsOf(ack.data?.sent);
  const files = (await page.evaluate(() => window.__h3d.simSecretFiles())).filter((f) => refs.has(f.path));
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
  await secretReviewReady(page);
  await dlg.getByRole('button', { name: 'Confirm and send' }).click();
  // The bridge says the review is stale: it opens again, with why, and nothing went.
  await secretReviewReady(page, 'no longer fits');
  await expect(dlg.locator('.sr-notice')).toContainText('no longer fits');
  expect((await sent(page, 'worker.prompt')).map((c) => c.result?.code)).toEqual(['secrets_review_stale']);
  await dlg.getByRole('button', { name: 'Confirm and send' }).click();
  await expect.poll(async () => (await sent(page, 'worker.prompt')).map((c) => c.result?.ok)).toEqual([false, true]);

  // The switch goes off (another client) while a review is open: it closes, nothing is sent, the note stays.
  const overlay = page.locator('dialog.desk-dlg--prompt');
  await overlay.locator('#prompt-text').click();
  await page.keyboard.insertText('and TOKEN=zzz999yyy');
  await page.keyboard.press('Enter');
  await secretReviewReady(page);
  await page.evaluate(() => window.__h3d.inject({ t: 'prompt_secrets.update', seq: 1_000_001, enabled: false, available: true }));
  await expect(dlg).toBeHidden();
  await expect(overlay.locator('p.dd-status[role="status"]')).toContainText('switched off');
  expect(await sent(page, 'worker.prompt')).toHaveLength(2);
  expect(await page.evaluate(() => (window.__h3d.panel() as { text?: string } | null)?.text)).toBe('and TOKEN=zzz999yyy');
  clean();
});

test('a prompt near 16 KiB with matches near its start, middle and end: N brings each into the well’s view; Confirm sends it', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', `${SIM}&simsecretson=1`);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  await page.evaluate((i) => window.__h3d.openPrompt(i), await idOf(page, 'herdr-3d', 'Pebble'));
  const line = 'lorem ipsum dolor sit amet, 😀 consectetur adipiscing\n';
  // Near the 16 KiB limit, with room for the three file references the bridge puts in (it checks the limit after them).
  const fill = line.repeat(Math.floor(7600 / Buffer.byteLength(line)));
  const text = `TOKEN=start1x ${fill}TOKEN=middle2x ${fill}TOKEN=end3x`;
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16 * 1024 - 300);
  expect(Buffer.byteLength(text)).toBeGreaterThan(15_000);
  await page.keyboard.insertText(text);
  await page.keyboard.press('Enter');
  const dlg = page.locator('dialog.desk-dlg--secrets');
  await secretReviewReady(page);
  expect(await reviewText(page)).toBe(text);
  const inView = (key: string) =>
    page.evaluate((k) => {
      const well = document.querySelector('.sr-prompt')!.getBoundingClientRect();
      const m = document.querySelector(`.sr-mark[data-key="${k}"]`)!.getBoundingClientRect();
      return m.top >= well.top && m.bottom <= well.bottom;
    }, key);
  expect(await inView('c1')).toBe(true);
  expect(await inView('c3')).toBe(false);
  await page.keyboard.press('n');
  await expect.poll(() => inView('c2')).toBe(true);
  await page.keyboard.press('n');
  await expect.poll(() => inView('c3')).toBe(true);
  expect((await review(page))?.current).toBe('c3');
  await dlg.getByRole('button', { name: 'Confirm and send' }).click();
  await expect.poll(async () => (await sent(page, 'worker.prompt')).map((c) => c.result?.ok)).toEqual([true]);
  const ack = (await sent(page, 'worker.prompt'))[0]!.result as { data?: { protected?: number } };
  expect(ack.data?.protected).toBe(3);
  clean();
});

/** The review's own controls, by `data-key`: the strip's (a found match in hand), then the footer's and the header's. */
const STRIP = ['prev', 'next', 'protect', 'ignore', 'start-left', 'start-right', 'end-left', 'end-right', 'mark'];
const ALWAYS = ['close', 'cancel', 'confirm'];

/**
 * What hides each control now: an ancestor that cuts it off and that a person cannot scroll (wheel, touch) is a fault;
 * one that scrolls is fine (the control is reached by scrolling it), and the walk goes on with what it shows. Then,
 * brought into view (as a click or the focus would), the control is what is under its centre: never the footer.
 */
const reachOf = (page: Page, keys: string[]) =>
  page.evaluate((ks) => {
    const dlg = document.querySelector('dialog.desk-dlg--secrets') as HTMLElement;
    const cut: string[] = [];
    const hidden: string[] = [];
    const els = ks.map((k) => [k, dlg.querySelector<HTMLElement>(`[data-key="${k}"]:not(.sr-mark)`)] as const);
    // Everything measured first, as drawn: bringing one into view scrolls the others.
    for (const [k, el] of els) {
      if (!el) {
        cut.push(`${k}: not there`);
        continue;
      }
      let r = { top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom };
      for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
        const oy = getComputedStyle(n).overflowY;
        if (oy === 'visible') continue;
        const top = n.getBoundingClientRect().top + n.clientTop;
        const box = { top, bottom: top + n.clientHeight };
        if (r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5) continue;
        if (oy !== 'auto' && oy !== 'scroll') {
          cut.push(`${k}: cut off by ${n.className || n.tagName} (overflow-y ${oy}): ${Math.round(r.top)}..${Math.round(r.bottom)} outside ${Math.round(box.top)}..${Math.round(box.bottom)}`);
          break;
        }
        r = box;
      }
    }
    for (const [k, el] of els) {
      if (!el) continue;
      el.scrollIntoView({ block: 'nearest' });
      const b = el.getBoundingClientRect();
      const at = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      if (!at || !el.contains(at)) hidden.push(`${k}: under ${at ? (at as HTMLElement).className || at.tagName : 'nothing'} once scrolled to`);
    }
    return { cut, hidden };
  }, keys);

/** Seen without scrolling anything: inside the screen and on top at its centre. */
const seenNow = (page: Page, sels: string[]) =>
  page.evaluate((ss) => {
    const out: string[] = [];
    for (const s of ss) {
      const el = document.querySelector(s);
      const b = el?.getBoundingClientRect();
      if (!el || !b || b.height < 1) {
        out.push(`${s}: not shown`);
        continue;
      }
      const at = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      if (b.top < -0.5 || b.bottom > innerHeight + 0.5 || !at || !el.contains(at)) out.push(`${s}: ${Math.round(b.top)}..${Math.round(b.bottom)} of ${innerHeight}, under ${at ? (at as HTMLElement).className || at.tagName : 'nothing'}`);
    }
    return out;
  }, sels);

// #108 U1: at 200% zoom the strip's actions sat below the body's clipping edge, behind the footer, out of reach.
test('the review at 1280x720, at 200% zoom (640x360) and on a phone (390x844, touch): every control reached by pointer and keyboard, the counts and the footer always in view, the prompt scrolls', async ({ browser }) => {
  test.setTimeout(300_000);
  const long = `${TEXT}\n${Array.from({ length: 28 }, (_, i) => `step ${i + 1}: run the release checks and report back`).join('\n')}`;
  for (const size of [
    { name: '1280x720', viewport: { width: 1280, height: 720 }, touch: false },
    { name: '640x360', viewport: { width: 640, height: 360 }, touch: false },
    { name: '390x844-touch', viewport: { width: 390, height: 844 }, touch: true },
  ]) {
    const ctx = await browser.newContext({ viewport: size.viewport, hasTouch: size.touch, isMobile: size.touch });
    const page = await ctx.newPage();
    const clean = watchErrors(page);
    await openGame(page, 'demo-m5', '', `${SIM}&simsecretson=1`);
    await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
    await frames(page, 3);
    const id = await idOf(page, 'herdr-3d', 'Pebble');
    await page.evaluate((i) => window.__h3d.openPrompt(i), id);
    await expect(page.locator('dialog.desk-dlg--prompt')).toBeVisible();
    await page.keyboard.insertText(long);
    await page.locator('dialog.desk-dlg--prompt [data-key="send"]').click();
    const dlg = page.locator('dialog.desk-dlg--secrets');
    await secretReviewReady(page);
    // The dialog's entrance done (finite animations only) before anything is measured.
    await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));
    const at = `${size.name}`;
    // The counts sentence, Confirm and Cancel: in view from the start.
    expect(await seenNow(page, ['.sr-sum', ...ALWAYS.map((k) => `dialog.desk-dlg--secrets [data-key="${k}"]`)]), `${at}: in view`).toEqual([]);
    // The full prompt keeps at least three lines and scrolls (a long prompt), under the wheel too.
    const well = await page.locator('.sr-prompt').evaluate((p) => {
      const cs = getComputedStyle(p);
      return { inner: p.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom), line: parseFloat(cs.lineHeight), scrolls: p.scrollHeight > p.clientHeight, oy: cs.overflowY };
    });
    expect(well.inner, `${at}: the prompt's height ${JSON.stringify(well)}`).toBeGreaterThanOrEqual(3 * well.line - 1);
    expect(well.scrolls && well.oy === 'auto', `${at}: the long prompt scrolls`).toBe(true);
    const pb = (await page.locator('.sr-prompt').boundingBox())!;
    await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
    await page.mouse.wheel(0, 120);
    await expect.poll(() => page.locator('.sr-prompt').evaluate((p) => p.scrollTop), `${at}: the wheel scrolls the prompt`).toBeGreaterThan(0);
    // The strip's controls (a found match in hand): never cut off by a box that does not scroll, never under the footer.
    const found = await reachOf(page, STRIP);
    expect(found.cut, `${at}: cut off`).toEqual([]);
    expect(found.hidden, `${at}: hidden`).toEqual([]);
    // A body taller than its box scrolls under the wheel (over the strip, not the prompt), down to its last control.
    const body = await page.locator('.sr-body').evaluate((b) => ({ over: b.scrollHeight - b.clientHeight, rect: b.getBoundingClientRect().toJSON() as DOMRect }));
    if (body.over > 1) {
      await page.locator('.sr-body').evaluate((b) => (b.scrollTop = 0));
      const strip = (await page.locator('.sr-strip').boundingBox())!;
      await page.mouse.move(strip.x + strip.width / 2, Math.min(strip.y + 12, body.rect.bottom - 4));
      await page.mouse.wheel(0, body.over + 50);
      await expect.poll(() => page.locator('.sr-body').evaluate((b) => b.scrollTop), `${at}: the wheel scrolls the review`).toBeGreaterThanOrEqual(body.over - 1);
      expect(await seenNow(page, ['.sr-strip [data-key="mark"]', '.sr-sum', 'dialog.desk-dlg--secrets [data-key="confirm"]']), `${at}: scrolled to the end`).toEqual([]);
    }
    // By pointer: Ignore and Protect again, an edge, all where they are drawn.
    await dlg.locator('.sr-strip [data-key="ignore"]').click();
    await expect(dlg.locator('.sr-mark[data-key="c1"]')).toHaveAttribute('data-state', 'ignore');
    await dlg.locator('.sr-strip [data-key="protect"]').click();
    await dlg.locator('.sr-strip [data-key="start-left"]').click();
    expect((await review(page))?.marks[0]?.start).toBe(TEXT.indexOf('ghp_') - 1);
    // By keyboard: Tab from the match in hand reaches every strip control and the footer, each in view when focused.
    await dlg.locator('.sr-mark[data-key="c1"]').focus();
    const tabbed: string[] = [];
    for (let n = 0; n < 16 && !tabbed.includes('confirm'); n++) {
      await page.keyboard.press('Tab');
      const k = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.key ?? '');
      if (!k) continue;
      tabbed.push(k);
      expect(await seenNow(page, [`dialog.desk-dlg--secrets [data-key="${k}"]:focus`]), `${at}: ${k} focused`).toEqual([]);
    }
    expect(tabbed.filter((k) => STRIP.includes(k) || ALWAYS.includes(k)).sort(), `${at}: tabbed through ${tabbed.join(' ')}`).toEqual([...STRIP, 'cancel', 'confirm'].sort());
    // A mark of yours in hand: Remove this mark, the same.
    const a = TEXT.indexOf('admin42');
    await selectInReview(page, a, a + 'admin42'.length);
    await dlg.locator('.sr-strip [data-key="mark"]').click();
    await expect(dlg.locator('.sr-mark[data-manual="true"]')).toHaveCount(1);
    const mine = await reachOf(page, ['unmark']);
    expect([...mine.cut, ...mine.hidden], `${at}: Remove this mark`).toEqual([]);
    await page.locator('.sr-body').evaluate((b) => (b.scrollTop = 0));
    await shot(page, `h108-review-${size.name}`);
    await dlg.locator('[data-key="cancel"]').click();
    await expect(dlg).toBeHidden();
    clean();
    await ctx.close();
  }
});

// ---- round 4: every other composer -------------------------------------------------------------------------------

test('round 4: a hire’s first task with a protected value: reviewed before the desk is held, hired with references; its files are the new worker’s', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', `${SIM}&simsecretson=1`);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  await page.evaluate(() => window.__h3d.openHire(5));
  await expect.poll(async () => ((await page.evaluate(() => window.__h3d.dialog())) as { kind?: string; state?: string } | null)?.state, { timeout: 10_000 }).toBe('ready');
  const task = 'Rotate the deploy credential: the new one is TOKEN=ghp_abcdefghijklmnopqrstu1, then report back';
  await page.locator('#hire-task').click();
  await page.keyboard.insertText(task);
  await noSecretStored(page, 'typed in the hire dialog');
  const hire = page.locator('dialog.desk-dlg--hire');
  await expect(hire.locator('[data-key="review"]')).toHaveText('Review secrets');
  const dlg = page.locator('dialog.desk-dlg--secrets');
  // Ctrl+Shift+X in the first task: the review on purpose, as its button; Cancel gives the task back, nothing hired.
  await expect(page.locator('#hire-task')).toBeFocused();
  await page.keyboard.press('Control+Shift+X');
  await secretReviewReady(page);
  expect(await review(page)).toMatchObject({ manual: true, counts: { found: 1 } });
  await dlg.locator('[data-key="cancel"]').click();
  await expect(dlg).toBeHidden();
  await expect.poll(async () => ((await page.evaluate(() => window.__h3d.dialog())) as { state?: string } | null)?.state).toBe('ready');
  expect(await sent(page, 'worker.hire')).toEqual([]);
  await hire.locator('[data-key="hire"]').click();
  await secretReviewReady(page);
  expect(await review(page)).toMatchObject({ target: expect.stringMatching(/ at Desk 6$/), action: 'Confirm and send', counts: { found: 1, protect: 1 } });
  expect(await sent(page, 'worker.hire')).toEqual([]);
  await dlg.getByRole('button', { name: 'Confirm and send' }).click();
  await expect(dlg).toBeHidden();
  await expect.poll(async () => (await sent(page, 'worker.hire')).length).toBe(1);
  await expect.poll(async () => ((await sent(page, 'worker.hire'))[0]?.result as { ok?: boolean } | undefined)?.ok).toBe(true);
  const [cmd] = await sent(page, 'worker.hire');
  const args = cmd!.args as { prompt: string; secrets: { decisions: unknown[] } };
  // The command log masks the protected range; the bridge acked one file, owned by the new worker.
  expect(args.prompt).toHaveLength(task.length);
  expect(args.prompt).not.toContain('ghp_abcdefghijklmnopqrstu1');
  expect(args.secrets.decisions).toEqual([{ candidate: 'c1', action: 'protect', start: task.indexOf('ghp_'), end: task.indexOf('ghp_') + 'ghp_abcdefghijklmnopqrstu1'.length }]);
  const ack = cmd!.result as { data?: { id: string; protected?: number } };
  expect(ack.data?.protected).toBe(1);
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.simSecretFiles())).filter((f) => f.owner === ack.data?.id).map((f) => f.text)).toEqual(['ghp_abcdefghijklmnopqrstu1']);
  expect(JSON.stringify(await page.evaluate(() => window.__h3d.sent()))).not.toContain('ghp_abcdefghijklmnopqrstu1');
  await noSecretStored(page, 'hired');
  clean();
});

test('round 4: pack up reads the references (“Confirm and continue”); “Send as written (stay)” sends what it read with the hand-over', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  const [jev, llm] = [await fakeJev(), await fakeOpenAI()];
  try {
    await setUpPackupClock(page);
    await openGame(page, 'demo-m5', '', `${SIM}&simclock=manual&simsecretson=1&simmodel=packup&simjev=${encodeURIComponent(jev.url)}`);
    await switchOn(page, llm);
    await page.keyboard.press('Escape');
    const id = await sitAt(page, 'Pebble', 'transcript');
    const input = page.locator('.seat-transcript .tx .tx-input');
    const dlg = page.locator('dialog.desk-dlg--secrets');
    const confirm = page.locator('dialog.desk-dlg--home');
    const write = async (text: string) => {
      await input.click();
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
      await page.keyboard.insertText(text);
      await page.keyboard.press('Enter');
    };

    // Send as written (stay): the text the check read (references) goes with its hand-over, no review again.
    await write('Deploy with TOKEN=ghp_abcdefghijklmnopqrstu1 and end your turn');
    await secretReviewReady(page);
    expect(await review(page)).toMatchObject({ action: 'Confirm and continue', counts: { found: 1 } });
    const proceed = dlg.getByRole('button', { name: 'Confirm and continue' });
    await expect(proceed).toBeEnabled();
    await withPositivePackup(page, () => proceed.evaluate((button) => (button as HTMLButtonElement).click()));
    await expect(confirm).toBeVisible();
    const [detect] = await sent(page, 'packup.detect');
    expect((detect!.args as { secrets?: unknown }).secrets).toBeTruthy();
    const ackd = detect!.result as { data?: { sent?: string; secrets_pending?: string } };
    expect(ackd.data?.sent).toMatch(/^Deploy with TOKEN=\[secret in file [^\]]+\] and end your turn$/);
    expect(ackd.data?.secrets_pending).toBeTruthy();
    await expect(confirm.locator('[data-key="pk-original"] del')).toHaveText(' and end your turn');
    await expect(confirm.locator('[data-key="pk-original"]')).not.toContainText('ghp_');
    await confirm.getByRole('button', { name: 'Send as written (stay)' }).click();
    await expect(confirm).toBeHidden();
    await expect.poll(async () => (await sent(page, 'worker.prompt')).length).toBe(1);
    // Only the prompt's delivery needs a scripted timer; unrelated worker turns stay pinned throughout the review.
    expect(await page.evaluate(() => window.__h3d.simAdvance(200))).toBe(true);
    const [prompt] = await sent(page, 'worker.prompt');
    expect(prompt!.args).toEqual({ id, text: ackd.data?.sent, secrets_pending: ackd.data?.secrets_pending });
    await expect.poll(async () => (prompt!.result as { ok?: boolean } | undefined)?.ok ?? (await sent(page, 'worker.prompt'))[0]?.result?.ok).toBe(true);
    const refs = refsOf(ackd.data?.sent);
    await expect.poll(async () => (await page.evaluate(() => window.__h3d.simSecretFiles())).filter((f) => refs.has(f.path)).map((f) => [f.owner, f.text])).toEqual([[id, 'ghp_abcdefghijklmnopqrstu1']]);
    expect((await review(page)) as unknown).toBeNull();

    expect(JSON.stringify(await page.evaluate(() => window.__h3d.sent()))).not.toContain('ghp_abcdefghijklmnopqrstu1');
    await noSecretStored(page, 'packed up');
  } finally {
    await Promise.all([jev.close(), llm.close()]);
  }
  clean();
});

test('round 4: pack up’s “Send and go home”: the task (references) and the cleanup go as a wrap-up with the hand-over; the files are the worker’s', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  const [jev, llm] = [await fakeJev(), await fakeOpenAI()];
  try {
    await setUpPackupClock(page);
    await openGame(page, 'demo-m4', '', `${SIM}&simclock=manual&simsecretson=1&simmodel=packup&simjev=${encodeURIComponent(jev.url)}`);
    await switchOn(page, llm);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__h3d.enterFloor('pastry'));
    await frames(page, 3);
    // Marble: a clean linked worktree the bridge made (it may go home).
    const id = await idOf(page, 'pastry', 'Marble');
    await page.evaluate((i) => window.__h3d.openPrompt(i), id);
    await expect(page.locator('dialog.desk-dlg--prompt')).toBeVisible();
    await page.keyboard.insertText('Fix the header with PASSWORD=hunter22, then go home.');
    await page.keyboard.press('Enter');
    const dlg = page.locator('dialog.desk-dlg--secrets');
    await secretReviewReady(page);
    expect(await review(page)).toMatchObject({ action: 'Confirm and continue' });
    const proceed = dlg.getByRole('button', { name: 'Confirm and continue' });
    await expect(proceed).toBeEnabled();
    await withPositivePackup(page, () => proceed.evaluate((button) => (button as HTMLButtonElement).click()));
    const confirm = page.locator('dialog.desk-dlg--home');
    await expect(confirm).toBeVisible();
    await expect(confirm.locator('[data-key="pk-original"]')).not.toContainText('hunter22');
    await expect(confirm.locator('[data-key="wrap-prompt"]')).not.toHaveValue(/hunter22/);
    await confirm.getByRole('button', { name: 'Send and go home' }).click();
    await expect.poll(async () => (await sent(page, 'worker.wrapup')).length).toBe(1);
    const [wrap] = await sent(page, 'worker.wrapup');
    const detect = (await sent(page, 'packup.detect'))[0]!.result as { data?: { task?: string; sent?: string; secrets_pending?: string } };
    expect(detect.data?.task).toMatch(/^Fix the header with PASSWORD=\[secret in file [^\]]+\]\.?$/);
    expect(wrap!.args).toMatchObject({ id, prompt: `${detect.data?.task}\n\n${CLEANUP}`, secrets_pending: detect.data?.secrets_pending });
    expect((wrap!.args as { secrets?: unknown }).secrets).toBeUndefined();
    await expect.poll(async () => (await sent(page, 'worker.wrapup'))[0]?.result,
      { message: 'the wrap-up is acknowledged after its world updates', timeout: 20_000 }).toMatchObject({ ok: true });
    const refs = refsOf(detect.data?.task);
    await expect.poll(async () => (await page.evaluate(() => window.__h3d.simSecretFiles())).filter((f) => refs.has(f.path)).map((f) => [f.owner, f.text])).toEqual([[id, 'hunter22']]);
    expect(await sent(page, 'worker.prompt')).toEqual([]);
    expect(JSON.stringify(await page.evaluate(() => window.__h3d.sent()))).not.toContain('hunter22');
  } finally {
    await Promise.all([jev.close(), llm.close()]);
  }
  clean();
});

test('round 4: a schedule’s prompt is saved with every match ignored: Protect refused with why, “Confirm and save” stores it as typed', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', `${SIM}&simsecretson=1`);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  await openMenu(page);
  await page.locator('.topbar-menu [data-action="schedules"]').click();
  const list = page.getByRole('dialog', { name: 'Scheduled agents' });
  await list.locator('[data-key="new"]').click();
  const form = page.getByRole('dialog', { name: 'Schedule an agent' });
  await expect.poll(() => page.evaluate(() => window.__h3d.scheduleForm()?.harness)).not.toBe('');
  await form.locator('#sf-title-in').fill('Nightly deploy');
  await form.locator('#sf-when').fill('in 2h');
  await form.locator('#sf-prompt').click();
  const prompt = 'Deploy with TOKEN=ghp_abcdefghijklmnopqrstu1 tonight.';
  await page.keyboard.insertText(prompt);
  await form.locator('[data-key="save"]').click();
  const dlg = page.locator('dialog.desk-dlg--secrets');
  await secretReviewReady(page);
  expect(await review(page)).toMatchObject({ action: 'Confirm and save', stored: expect.stringMatching(/^A saved prompt keeps no protected file/), counts: { protect: 0, ignore: 1 } });
  await expect(dlg.locator('.sr-stored')).toBeVisible();
  await expect(dlg.locator('.sr-tag')).toHaveText(['Ignored']);
  // Protect: unavailable, and a press says why (nothing changes).
  const protect = dlg.locator('.sr-strip [data-key="protect"]');
  await expect(protect).toHaveAttribute('aria-disabled', 'true');
  // (Unavailable, not disabled: a tap still says why; Playwright waits for an aria-disabled button, so force it.)
  await protect.click({ force: true });
  await expect(dlg.locator('p.dd-status--error[role="alert"]')).toHaveText(/^A saved prompt keeps no protected file/);
  expect((await review(page))?.counts.protect).toBe(0);
  await shot(page, 'h108-stored-review');
  expect((await sent(page, 'schedule.create')).length).toBe(0);
  await dlg.getByRole('button', { name: 'Confirm and save' }).click();
  await expect(form).toBeHidden();
  const [create] = await sent(page, 'schedule.create');
  expect(create!.args).toMatchObject({ title: 'Nightly deploy', prompt, secrets: { decisions: [{ candidate: 'c1', action: 'ignore' }] } });
  await expect.poll(async () => (await sent(page, 'schedule.create'))[0]?.result?.ok).toBe(true);
  clean();
});

const CHIP_REF = /\[secret in file \/run\/user\/1000\/herdr-world\/secrets\/[A-Z2-7]{26}\/[A-Z2-7]{26}\]/;

test('round 4: a protected value’s reference is a masked chip in the conversation: its path in the file popover, the reference in a copy', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  const s = SURFACES.find((x) => x.name === 'secret-chips')!;
  await boot(page, s.fixture, { ui: 'quiet' }, s.extra ?? '', s.wsQuery);
  await s.open(page);
  const msg = page.locator('.seat-transcript .tx-item.tx-user:not(.tx-pending) .tx-md', { has: page.locator('.secret-chip') }).last();
  const chip = msg.locator('.secret-chip');
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveAccessibleName(/^Protected file: \/run\/user\/1000\/herdr-world\/secrets\//);
  // On screen: the tape's words, never the path or the value.
  const visible = await msg.evaluate((el) => {
    const c = el.cloneNode(true) as HTMLElement;
    c.querySelectorAll('.secret-chip-ref').forEach((x) => x.remove());
    return c.textContent?.trim();
  });
  expect(visible).toBe('Deploy with TOKEN=protected file now');
  expect(await page.content()).not.toContain('ghp_abcdefghijklmnopqrstu1');
  // A copy of the whole message: the reference as sent, in place.
  const copied = await msg.evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    const t = sel.toString();
    sel.removeAllRanges();
    return t;
  });
  expect(copied.trim()).toMatch(new RegExp(`^Deploy with TOKEN=${CHIP_REF.source} now$`));
  // A press opens the file popover with the path and "Copy file path".
  await chip.click();
  const pop = page.locator('.seat-transcript .tx-fref[role="dialog"]');
  await expect(pop).toBeVisible();
  await expect(pop.locator('.tx-fref-path')).toHaveText(/^\/run\/user\/1000\/herdr-world\/secrets\/[A-Z2-7]{26}\/[A-Z2-7]{26}$/);
  await expect(pop.locator('.tx-fref-copy')).toHaveText('Copy file path');
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  clean();
});

/** Sends a prompt with a protected value from Pebble's prompt box (seated in its conversation); Pebble's id. */
async function sendProtectedFromBox(page: Page): Promise<string> {
  const id = await sitAt(page, 'Pebble', 'transcript');
  await page.locator('.seat-transcript .tx .tx-input').click();
  await page.keyboard.insertText('Deploy with TOKEN=ghp_abcdefghijklmnopqrstu1 now');
  await page.keyboard.press('Enter');
  const dlg = page.locator('dialog.desk-dlg--secrets');
  await secretReviewReady(page);
  await dlg.getByRole('button', { name: 'Confirm and send' }).click();
  await expect(dlg).toBeHidden();
  await expect.poll(async () => (await sent(page, 'worker.prompt'))[0]?.result?.ok, { timeout: 30_000 }).toBe(true);
  return id;
}

test('round 4: revoke: the seat bar’s “protected files” chip asks first, then removes the worker’s files; it keeps working, you stay seated', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', `${SIM}&simsecretson=1`);
  const id = await sendProtectedFromBox(page);
  const chip = page.locator('.seat .seat-secrets');
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await expect(chip).toContainText('1');
  await chip.click();
  const dlg = page.locator('dialog.desk-dlg--revoke');
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('#rv-sec-title')).toHaveText('Remove the protected file');
  await expect(dlg).toContainText('Pebble keeps running, but the references in its earlier prompts will point at nothing');
  await expect(dlg).toContainText('This cannot be undone.');
  await expect(dlg.locator('[data-key="cancel"]')).toBeFocused();
  await shot(page, 'h108-revoke');
  // Cancel removes nothing.
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  expect(await sent(page, 'prompt_secrets.revoke')).toEqual([]);
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(id);
  await chip.click();
  await dlg.locator('[data-key="remove"]').click();
  await expect(dlg).toBeHidden();
  const [cmd] = await sent(page, 'prompt_secrets.revoke');
  expect(cmd!.args).toEqual({ worker: id });
  await expect.poll(async () => ((await sent(page, 'prompt_secrets.revoke'))[0]?.result as { data?: { removed?: number } } | undefined)?.data?.removed).toBe(1);
  await expect(page.locator('.toast')).toContainText('Removed 1 protected file from Pebble. Pebble keeps working.');
  await expect(chip).toBeHidden();
  // This prompt's file is gone (the fixture's list is the whole host's: other tests' Pebbles have files too).
  const refs = refsOf(((await sent(page, 'worker.prompt'))[0]?.result as { data?: { sent?: string } } | undefined)?.data?.sent);
  expect(refs.size).toBe(1);
  expect((await page.evaluate(() => window.__h3d.simSecretFiles())).filter((f) => refs.has(f.path))).toEqual([]);
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(id);
  clean();
});

test('round 4: revoke on a bridge before round 5: no count, no chip', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', `${SIM}&simsecretson=1&simfail=no_revoke`);
  await sendProtectedFromBox(page);
  await expect(page.locator('.seat-transcript .secret-chip').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.seat .seat-secrets')).toBeHidden();
  clean();
});
