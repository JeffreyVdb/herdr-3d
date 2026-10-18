// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SecretsSim } from '../../tools/fixture-secrets.ts';
import type { CommandResult } from '../net/client';
import type { PromptSecretsScan } from '../net/protocol';
import { PromptSecretsBook, SecretReview } from '../world/promptSecrets';
import { type Go, PromptSecretsFlow } from './secretsFlow';
import { SecretsReviewDialog, type SecretsReviewOutcome } from './secretsReview';

// #108 round 3: the review of a prompt's possible secrets, by keyboard and by pointer (a tap is a click).

/** Astral characters, a tab, CRLF and two adjacent candidates: what the offsets must survive. */
const TEXT = 'export TOKEN=ghp_A1b2😀\r\nPASSWORD="hunter2";\tkey=abc.def\nsame: hunter2';

function scanAt(text: string, values: string[], extra: Partial<PromptSecretsScan['candidates'][number]>[] = []): PromptSecretsScan {
  let from = 0;
  return {
    revision: 'rev-1',
    candidates: values.map((v, i) => {
      const start = text.indexOf(v, from);
      from = start + v.length;
      return { id: `c${i + 1}`, start, end: start + v.length, kinds: ['assignment'], ...extra[i] };
    }),
  };
}

/** The open dialog's prompt, its highlights and strip, keys on them, and the prompt's text as it reads (the tapes left out). */
function controls() {
  const prompt = document.querySelector<HTMLElement>('.sr-prompt')!;
  const mark = (key: string) => prompt.querySelector<HTMLElement>(`.sr-mark[data-key="${key}"]`)!;
  const strip = (key: string) => document.querySelector<HTMLElement>(`.sr-strip [data-key="${key}"]`)!;
  const key = (target: Element, k: string, o: KeyboardEventInit = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: o.code ?? (k.length === 1 ? `Key${k.toUpperCase()}` : k), bubbles: true, cancelable: true, ...o }));
  const shown = () => {
    const c = prompt.cloneNode(true) as HTMLElement;
    c.querySelectorAll('.sr-tag').forEach((t) => t.remove());
    return c.textContent;
  };
  return { prompt, mark, strip, key, shown };
}

const flush = async () => {
  for (let n = 0; n < 5; n++) await Promise.resolve();
};

function setup(text = TEXT, values = ['ghp_A1b2😀', 'hunter2', 'abc', '.def', 'hunter2'], extra: Partial<PromptSecretsScan['candidates'][number]>[] = []) {
  document.body.replaceChildren();
  const book = new PromptSecretsBook();
  book.reset({ enabled: true, available: true });
  const dlg = new SecretsReviewDialog(document.body, { book });
  const review = new SecretReview(text, scanAt(text, values, extra));
  let outcome: SecretsReviewOutcome | null = null;
  void dlg.open({ review, target: 'Pebble', notice: null, manual: false, action: 'Confirm and send' }).then((o) => (outcome = o));
  return { dlg, book, review, ...controls(), flush, outcome: () => outcome as SecretsReviewOutcome | null };
}

/**
 * The dialog as the send flow opens it over the fixture's bridge (its scan, and its check of a review, are the
 * bridge's: docs/protocol.md "Prompt secrets"): `go` is what Confirm sends, `send` what the bridge makes of it.
 */
async function overBridge(text: string) {
  document.body.replaceChildren();
  const book = new PromptSecretsBook();
  book.reset({ enabled: true, available: true });
  const dlg = new SecretsReviewDialog(document.body, { book });
  const sim = new SecretsSim({ emit: () => {}, error: (code, message) => Object.assign(new Error(message), { code }), takeFailure: () => false }, { on: true });
  const flow = new PromptSecretsFlow({
    book,
    unsupported: () => false,
    send: (t, args) => new Promise<CommandResult>((resolve) => sim.handle(t, { ...args }, () => {}, (data) => resolve({ ok: true, data }))),
    review: (req) => dlg.open(req),
  });
  const go = flow.review({ key: 'w1', text, target: 'Pebble' }) as Promise<Go>;
  await flush();
  const send = (g: Go) => sim.prompt({ id: 'w1', text, secrets: g.secrets }, 'w1', () => {})?.extra;
  return { dlg, go, send, ...controls() };
}

/** Selects `[a, b)` of the prompt's text through its text nodes, as a mouse, a touch or Shift+arrows would. */
function selectText(prompt: HTMLElement, a: number, b: number): void {
  const nodes: Array<{ t: Text; at: number }> = [];
  let at = 0;
  const walk = document.createTreeWalker(prompt, NodeFilter.SHOW_TEXT);
  for (let t = walk.nextNode() as Text | null; t; t = walk.nextNode() as Text | null) {
    if (t.parentElement?.closest('.sr-tag')) continue;
    nodes.push({ t, at });
    at += t.data.length;
  }
  const find = (i: number) => {
    const n = nodes.find((x) => i >= x.at && i <= x.at + x.t.data.length) ?? (nodes.at(-1) as { t: Text; at: number });
    return [n.t, i - n.at] as const;
  };
  const r = document.createRange();
  r.setStart(...find(a));
  r.setEnd(...find(b));
  const s = document.getSelection()!;
  s.removeAllRanges();
  s.addRange(r);
  document.dispatchEvent(new Event('selectionchange'));
}

describe('SecretsReviewDialog (#108)', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
    Element.prototype.scrollIntoView = function () {};
  });
  afterEach(() => document.body.replaceChildren());

  it('A1: a highlight’s title counts the matches the scan found, as the strip does (a mark of yours is “Marked by you”)', () => {
    const e = setup();
    // A mark of yours before the second match: the strip says "Match 2 of 5" there, and so must the highlight.
    const at = TEXT.indexOf('PASSWORD');
    selectText(e.prompt, at, at + 4);
    e.key(e.prompt, 'm');
    const titles = [...e.prompt.querySelectorAll<HTMLElement>('.sr-mark')].map((m) => m.title.split(':')[0]);
    expect(titles).toEqual(['Match 1 of 5', 'Marked by you', 'Match 2 of 5', 'Match 3 of 5', 'Match 4 of 5', 'Match 5 of 5']);
    e.mark('c2').click();
    expect(e.strip('next').closest('.sr-nav')?.querySelector('.sr-pos')?.textContent).toBe('Match 2 of 5');
  });

  it('shows the whole prompt as it will be sent, every candidate highlighted at its exact boundaries, its state on tape', () => {
    const e = setup();
    expect(e.shown()).toBe(TEXT);
    const marks = [...e.prompt.querySelectorAll<HTMLElement>('.sr-mark')];
    expect(marks.map((m) => m.querySelector('.sr-val')!.textContent)).toEqual(['ghp_A1b2😀', 'hunter2', 'abc', '.def', 'hunter2']);
    expect(marks.map((m) => m.querySelector('.sr-tag')!.textContent)).toEqual(Array(5).fill('Protected'));
    expect(marks.every((m) => m.getAttribute('role') === 'button' && m.getAttribute('contenteditable') === 'false')).toBe(true);
    // One tab stop for the matches: the current one, which has the focus.
    expect(marks.map((m) => m.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    expect(document.activeElement).toBe(marks[0]);
    expect(document.querySelector('#sr-sub')!.textContent).toBe('To Pebble · 5 possible secrets found');
    expect(document.querySelector('.sr-sum')!.textContent).toBe('5 protected as files on the bridge host, 0 ignored. Ignored matches are sent as plain text.');
    expect(document.querySelector('.sr-what')!.textContent).toBe('Found by an assignment to a credential-like name.');
    expect([...document.querySelectorAll('.dd-actions button')].map((b) => b.textContent)).toEqual(['Cancel', 'Confirm and send']);
  });

  it('by keyboard: Space ignores and protects again, N and Shift+N step (round the end), the edges move by a character', () => {
    const e = setup();
    e.key(e.mark('c1'), ' ', { code: 'Space' });
    expect(e.mark('c1').dataset.state).toBe('ignore');
    expect(e.mark('c1').querySelector('.sr-tag')!.textContent).toBe('Ignored');
    expect(document.querySelector('.sr-sum')!.textContent).toMatch(/^4 protected as files on the bridge host, 1 ignored\./);
    expect(document.activeElement).toBe(e.mark('c1'));
    e.key(e.mark('c1'), 'Enter');
    expect(e.mark('c1').dataset.state).toBe('protect');
    // The two hunter2s take different decisions.
    e.key(e.mark('c1'), 'n');
    expect(document.activeElement).toBe(e.mark('c2'));
    e.key(e.mark('c2'), 'n');
    e.key(e.mark('c3'), 'n');
    e.key(e.mark('c4'), 'n');
    e.key(e.mark('c5'), ' ', { code: 'Space' });
    expect(e.review.decisions().filter((d) => 'candidate' in d && (d.candidate === 'c2' || d.candidate === 'c5'))).toEqual([
      { candidate: 'c2', action: 'protect', start: TEXT.indexOf('hunter2'), end: TEXT.indexOf('hunter2') + 7 },
      { candidate: 'c5', action: 'ignore' },
    ]);
    e.key(e.mark('c5'), 'n');
    expect(document.activeElement).toBe(e.mark('c1'));
    e.key(e.mark('c1'), 'N', { shiftKey: true, code: 'KeyN' });
    expect(document.activeElement).toBe(e.mark('c5'));
    // c2: "hunter2" between quotes. → takes the closing quote, Shift+← the opening one.
    e.mark('c2').focus();
    e.key(e.mark('c2'), 'ArrowRight');
    e.key(e.mark('c2'), 'ArrowLeft', { shiftKey: true });
    expect(e.mark('c2').querySelector('.sr-val')!.textContent).toBe('"hunter2"');
    expect(document.activeElement).toBe(e.mark('c2'));
    // c3 and c4 touch: c3's end cannot move into c4, and it says why.
    e.key(e.mark('c3'), 'ArrowRight');
    expect(e.mark('c3').querySelector('.sr-val')!.textContent).toBe('abc');
    expect(e.dlg.summary()!.status).toBe('The next match starts there.');
    expect(e.dlg.summary()!.error).toBe(true);
    // An astral character goes whole.
    e.key(e.mark('c1'), 'ArrowLeft');
    expect(e.mark('c1').querySelector('.sr-val')!.textContent).toBe('ghp_A1b2');
    expect(e.review.get('c1')).toMatchObject({ start: 13, end: 21 });
  });

  it('by pointer: a tap picks a match, the strip protects, ignores and moves the edges', () => {
    const e = setup();
    e.mark('c3').click();
    expect(e.dlg.summary()!.current).toBe('c3');
    expect(e.strip('protect').getAttribute('aria-pressed')).toBe('true');
    e.strip('ignore').click();
    expect(e.mark('c3').dataset.state).toBe('ignore');
    expect(e.strip('ignore').getAttribute('aria-pressed')).toBe('true');
    // Ignored, its edges are not corrected.
    expect(e.strip('start-left').getAttribute('aria-disabled')).toBe('true');
    e.strip('protect').click();
    e.strip('start-left').click();
    expect(e.mark('c3').querySelector('.sr-val')!.textContent).toBe('=abc');
    e.strip('end-left').click();
    expect(e.mark('c3').querySelector('.sr-val')!.textContent).toBe('=ab');
    e.strip('next').click();
    expect(e.dlg.summary()!.current).toBe('c4');
    // c4 can now take the "c" back.
    e.strip('start-left').click();
    expect(e.mark('c4').querySelector('.sr-val')!.textContent).toBe('c.def');
  });

  it('marks selected text by hand (M or the strip’s button), refuses an overlap, and Delete takes a mark away', () => {
    const e = setup();
    const at = TEXT.indexOf('same');
    selectText(e.prompt, at, at + 4);
    e.key(e.prompt, 'm');
    const m1 = e.mark('m1');
    expect(m1.querySelector('.sr-val')!.textContent).toBe('same');
    expect(m1.dataset.manual).toBe('true');
    expect(m1.querySelector('.sr-tag')!.textContent).toBe('Protected');
    expect(document.querySelector('.sr-what')!.textContent).toBe('Marked by you.');
    expect(e.dlg.summary()!.counts).toEqual({ protect: 6, ignore: 0, manual: 1, found: 5 });
    expect(e.shown()).toBe(TEXT);
    // A selection over a match is refused; the strip's button marks too (the selection kept while it is tapped).
    selectText(e.prompt, TEXT.indexOf('PASSWORD'), TEXT.indexOf('hunter2') + 3);
    e.strip('mark').click();
    expect(e.dlg.summary()!.status).toMatch(/overlaps a match/);
    selectText(e.prompt, TEXT.indexOf('PASSWORD'), TEXT.indexOf('PASSWORD') + 8);
    document.getSelection()!.removeAllRanges();
    e.strip('mark').click();
    expect(e.mark('m2').querySelector('.sr-val')!.textContent).toBe('PASSWORD');
    // Delete on a candidate keeps it; on a mark of yours it goes.
    e.key(e.mark('c2'), 'Delete');
    expect(e.mark('c2')).not.toBeNull();
    e.mark('m1').focus();
    e.key(e.mark('m1'), 'Delete');
    expect(e.prompt.querySelector('[data-key="m1"]')).toBeNull();
    expect(e.dlg.summary()!.counts.manual).toBe(1);
  });

  it('C1: a match shrunk, the freed character marked by hand: Ignore is refused with why, by keyboard and by pointer alike; the mark taken away, it works', () => {
    // token=abcdef: c1 is abcdef, [6, 12).
    const text = 'token=abcdef';
    const e = setup(text, ['abcdef']);
    e.key(e.mark('c1'), 'ArrowLeft');
    selectText(e.prompt, 11, 12);
    e.key(e.prompt, 'm');
    expect(e.mark('m1').querySelector('.sr-val')!.textContent).toBe('f');
    // By keyboard: Space on the match.
    e.mark('c1').click();
    e.key(e.mark('c1'), ' ', { code: 'Space' });
    const refused = e.dlg.summary()!;
    expect(refused.status).toBe('Ignoring sends the whole match as typed, and your mark covers part of it: take that mark away first (Delete on it).');
    expect(refused.error).toBe(true);
    expect(e.mark('c1').dataset.state).toBe('protect');
    expect(e.shown()).toBe(text);
    expect(e.review.decisions()).toEqual([
      { candidate: 'c1', action: 'protect', start: 6, end: 11 },
      { action: 'protect', start: 11, end: 12 },
    ]);
    // The strip says so before it is pressed; a tap (no hover on a touch screen) says the same and changes nothing.
    expect(e.strip('ignore').getAttribute('aria-disabled')).toBe('true');
    expect(e.strip('ignore').title).toBe(refused.status);
    e.key(e.mark('c1'), 'Delete');
    expect(e.dlg.summary()!.status).toMatch(/^A match the scan found stays/);
    e.strip('ignore').click();
    expect(e.dlg.summary()!.status).toBe(refused.status);
    expect(e.strip('ignore').getAttribute('aria-pressed')).toBe('false');
    expect(e.shown()).toBe(text);
    // The mark taken away: Ignore puts the match back as found.
    e.mark('m1').focus();
    e.key(e.mark('m1'), 'Delete');
    e.mark('c1').click();
    expect(e.strip('ignore').getAttribute('aria-disabled')).toBeNull();
    e.strip('ignore').click();
    expect(e.mark('c1').dataset.state).toBe('ignore');
    expect(e.mark('c1').querySelector('.sr-val')!.textContent).toBe('abcdef');
    expect(e.shown()).toBe(text);
    expect(e.review.decisions()).toEqual([{ candidate: 'c1', action: 'ignore' }]);
  });

  it('C1: a neighbouring match moved into the found range is named by its number', () => {
    const text = 'token=abcdef x9';
    const e = setup(text, ['abcdef', 'x9']);
    e.key(e.mark('c1'), 'ArrowLeft');
    e.mark('c2').click();
    e.key(e.mark('c2'), 'ArrowLeft', { shiftKey: true });
    e.key(e.mark('c2'), 'ArrowLeft', { shiftKey: true });
    e.mark('c1').click();
    e.key(e.mark('c1'), 'Enter');
    expect(e.dlg.summary()!.status).toBe('Ignoring sends the whole match as typed, and match 2 now covers part of it: move its edge back first.');
    expect(e.shown()).toBe(text);
  });

  describe('C1 (review pass 2): a match moved clear of its found range, the gap marked, then ignored', () => {
    // token=abcdef xyz: the bridge finds c1 abcdef, [6, 12). Moved onto the x ([13, 14)), the space marked ([12, 13)).
    const text = 'token=abcdef xyz';
    type Bridged = Awaited<ReturnType<typeof overBridge>>;
    const order = (e: Bridged) => e.dlg.summary()!.marks.map((m) => [m.key, m.start, m.end, m.state]);
    const drawn = (e: Bridged) => [...e.prompt.querySelectorAll<HTMLElement>('.sr-mark')].map((m) => m.dataset.key);

    /** Ignored, c1 is back on its found range, before the mark it passed, and the prompt reads as typed. */
    const ignored = (e: Bridged) => {
      expect(order(e)).toEqual([
        ['c1', 6, 12, 'ignore'],
        ['m1', 12, 13, 'protect'],
      ]);
      expect(drawn(e)).toEqual(['c1', 'm1']);
      expect(e.shown()).toBe(text);
    };
    /** Protected again (no edge moved into the mark), then Confirm: what goes, and the bridge takes it. */
    const confirmed = async (e: Bridged) => {
      expect(order(e)).toEqual([
        ['c1', 6, 12, 'protect'],
        ['m1', 12, 13, 'protect'],
      ]);
      expect(e.shown()).toBe(text);
      (document.querySelector('[data-key="confirm"]') as HTMLElement).click();
      const go = await e.go;
      // The laptop's pending row shows this until the ack: both protected ranges hidden, nothing of abcdef.
      expect(go.shown).toBe('token=[secret][secret]xyz');
      expect(go.secrets?.decisions).toEqual([
        { candidate: 'c1', action: 'protect', start: 6, end: 12 },
        { action: 'protect', start: 12, end: 13 },
      ]);
      expect(e.send(go)).toEqual({ protected: 2, sent: expect.stringMatching(/^token=\[secret in file [^\]]+\]\[secret in file [^\]]+\]xyz$/) });
    };

    it('by keyboard: → twice, Shift+→ seven times, the space selected and M, N to the match, Space; Enter, then → is refused', async () => {
      const e = await overBridge(text);
      expect(document.activeElement).toBe(e.mark('c1'));
      e.key(e.mark('c1'), 'ArrowRight');
      e.key(e.mark('c1'), 'ArrowRight');
      for (let i = 0; i < 7; i++) e.key(e.mark('c1'), 'ArrowRight', { shiftKey: true });
      expect(order(e)).toEqual([['c1', 13, 14, 'protect']]);
      selectText(e.prompt, 12, 13);
      e.key(e.prompt, 'm');
      expect(drawn(e)).toEqual(['m1', 'c1']);
      e.key(e.mark('m1'), 'n');
      expect(document.activeElement).toBe(e.mark('c1'));
      e.key(e.mark('c1'), ' ', { code: 'Space' });
      expect(e.dlg.summary()!.error).toBe(false);
      ignored(e);
      expect(document.activeElement).toBe(e.mark('c1'));
      e.key(e.mark('c1'), 'Enter');
      e.key(e.mark('c1'), 'ArrowRight');
      expect(e.dlg.summary()).toMatchObject({ status: 'The next match starts there.', error: true });
      await confirmed(e);
    });

    it('by pointer: the strip’s End → twice and Start → seven times, the space selected and marked, the match tapped, Ignore; Protect, then End → is unavailable', async () => {
      const e = await overBridge(text);
      e.strip('end-right').click();
      e.strip('end-right').click();
      for (let i = 0; i < 7; i++) e.strip('start-right').click();
      expect(order(e)).toEqual([['c1', 13, 14, 'protect']]);
      // A tap on the strip takes the selection away; the last one is kept for it.
      selectText(e.prompt, 12, 13);
      document.getSelection()!.removeAllRanges();
      e.strip('mark').click();
      e.mark('c1').click();
      expect(e.strip('ignore').getAttribute('aria-disabled')).toBeNull();
      e.strip('ignore').click();
      ignored(e);
      expect(e.strip('ignore').getAttribute('aria-pressed')).toBe('true');
      e.strip('protect').click();
      expect(e.strip('end-right').getAttribute('aria-disabled')).toBe('true');
      e.strip('end-right').click();
      await confirmed(e);
    });
  });

  it('maps a DOM position to the text’s UTF-16 offset: in text, between nodes, in a tape (the next text’s start)', () => {
    const e = setup();
    const val = e.mark('c2').querySelector('.sr-val')!.firstChild as Text;
    expect(e.dlg.offsetOf(val, 3)).toBe(TEXT.indexOf('hunter2') + 3);
    const tag = e.mark('c2').querySelector('.sr-tag')!.firstChild as Text;
    expect(e.dlg.offsetOf(tag, 4)).toBe(TEXT.indexOf('hunter2'));
    // Between c3 and c4 (adjacent): the position after c3's island is c4's start.
    const after = [...e.prompt.childNodes].indexOf(e.mark('c3')) + 1;
    expect(e.dlg.offsetOf(e.prompt, after)).toBe(TEXT.indexOf('.def'));
    expect(e.dlg.offsetOf(e.prompt, e.prompt.childNodes.length)).toBe(TEXT.length);
    // Across CRLF: the text node after c1 starts at c1's end.
    const crlf = e.mark('c1').nextSibling as Text;
    expect(crlf.data.startsWith('\r\n')).toBe(true);
    expect(e.dlg.offsetOf(crlf, 2)).toBe(TEXT.indexOf('PASSWORD'));
  });

  it('Confirm gives the review; ignoring the last match never submits, ignoring them all is a valid confirm', async () => {
    const e = setup('pw=only1', ['only1']);
    e.key(e.mark('c1'), ' ', { code: 'Space' });
    await e.flush();
    expect(e.outcome()).toBeNull();
    expect(e.dlg.isOpen).toBe(true);
    (document.querySelector('[data-key="confirm"]') as HTMLElement).click();
    await e.flush();
    expect(e.outcome()).toEqual({ kind: 'confirm', review: e.review });
    expect(e.review.decisions()).toEqual([{ candidate: 'c1', action: 'ignore' }]);
    expect(e.dlg.isOpen).toBe(false);
    // Nothing of the prompt stays in the page.
    expect(e.prompt.textContent).toBe('');
  });

  it('Ctrl+Enter confirms; Esc and the close button cancel', async () => {
    let e = setup();
    e.key(e.mark('c1'), 'Enter', { ctrlKey: true, code: 'Enter' });
    await e.flush();
    expect(e.outcome()?.kind).toBe('confirm');
    e = setup();
    document.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }));
    await e.flush();
    expect(e.outcome()).toEqual({ kind: 'cancel' });
    e = setup();
    (document.querySelector('[data-key="close"]') as HTMLElement).click();
    await e.flush();
    expect(e.outcome()).toEqual({ kind: 'cancel' });
  });

  it('the switch changing while it is open closes it: nothing confirmed, the reason given', async () => {
    const e = setup();
    e.book.upsert({ enabled: true, available: false });
    expect(e.dlg.isOpen).toBe(true);
    e.book.upsert({ enabled: false, available: true });
    await e.flush();
    expect(e.outcome()).toEqual({ kind: 'changed', message: expect.stringMatching(/switched off.*nothing was sent/) });
    expect(e.dlg.isOpen).toBe(false);
  });

  it('refuses every edit of the prompt, and puts back what a composition changed', () => {
    const e = setup();
    const ev = new Event('beforeinput', { cancelable: true, bubbles: true });
    e.prompt.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    for (const t of ['paste', 'drop', 'cut']) {
      const x = new Event(t, { cancelable: true, bubbles: true });
      e.prompt.dispatchEvent(x);
      expect(x.defaultPrevented).toBe(true);
    }
    (e.prompt.lastChild as Text).data += 'typed';
    e.prompt.dispatchEvent(new Event('input', { bubbles: true }));
    expect(e.shown()).toBe(TEXT);
  });

  it('says when a value is stored as typed, and a notice when it opens again', () => {
    const e = setup('url=https://u:p%40ss@h', ['p%40ss'], [{ encoded: true, kinds: ['url-password'] }]);
    expect(e.mark('c1').querySelector('.sr-tag')!.textContent).toBe('Protected as typed');
    expect(document.querySelector('.sr-what')!.textContent).toBe('Found by a password in a URL. Stored as typed: its escapes, percent-encoding or indentation go into the file exactly as you see them.');
    e.dlg.close();
    const review = new SecretReview('x', { revision: 'r', candidates: [] });
    void e.dlg.open({ review, target: 'Pebble', notice: 'Look it over again.', manual: true, action: 'Confirm and send' });
    expect(document.querySelector('.sr-notice')!.textContent).toBe('Look it over again.');
    expect(document.querySelector('#sr-sub')!.textContent).toBe('To Pebble · nothing found');
    expect(document.querySelector('.sr-sum')!.textContent).toMatch(/^Nothing was found\. Select text/);
    expect(document.activeElement).toBe(e.prompt);
  });

  it('a 16 KiB prompt with matches near its start, middle and end: all of it is there, N reaches each', () => {
    const line = 'lorem ipsum dolor sit amet, 😀 consectetur\n';
    const fill = line.repeat(Math.floor(8150 / new TextEncoder().encode(line).length));
    const text = `pw=start1 ${fill}pw=middle2 ${fill}pw=end3`;
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(16 * 1024);
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(15 * 1024);
    const e = setup(text, ['start1', 'middle2', 'end3']);
    expect(e.shown()).toBe(text);
    expect(document.activeElement).toBe(e.mark('c1'));
    e.key(e.mark('c1'), 'n');
    expect(document.activeElement).toBe(e.mark('c2'));
    e.key(e.mark('c2'), 'n');
    expect(document.activeElement).toBe(e.mark('c3'));
    expect(e.review.get('c3')).toMatchObject({ start: text.length - 4, end: text.length });
  });
});
