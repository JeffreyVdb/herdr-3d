// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import type { Ask } from '../net/protocol';
import { flush, installDialogs, secretsBridge } from '../test/secretsBridge';
import { TranscriptMode, type MountTranscript, type TranscriptRenderHost } from './transcriptMode';
import { mountTranscript } from './transcriptRender';

// #108 round 4: the transcript's answers (an ask's Other and its prompt, a follow-up's values and notes, a Codex async
// answer) through the review, each text alone; the command carries a review per text keyed by its path.

const SECRET = 'TOKEN=ghp_abcdefghijklmnopqrstu1';

async function harness() {
  document.body.replaceChildren();
  const b = secretsBridge();
  const sent: Array<{ t: string; args: Record<string, unknown> }> = [];
  let host: TranscriptRenderHost | null = null;
  const mount: MountTranscript = (_box, h) => {
    host = h;
    return { setItems() {}, applyUpdates() {}, setBlocked() {}, setAsk() {}, setFollowup() {}, setCodex() {}, setUsage() {}, setActivity() {}, setPending() {}, attachTabs() {}, hasItem: () => false, scrollToItem: () => false, focus() {}, focusPrompt() {}, destroy() {} } as never;
  };
  const tx = new TranscriptMode({
    feed: () => null,
    send: ((t: string, args: Record<string, unknown>) => (sent.push({ t, args }), Promise.resolve<CommandResult>({ ok: true, data: { sent: [], resolved: true } }))) as never,
    renderer: () => Promise.resolve(mount),
    overlay: () => document.body.appendChild(document.createElement('div')),
    storage: null,
    status: () => {},
    modeChanged: () => {},
    secrets: b.flow,
  });
  tx.sit('a', 'Ada', true, 'claude');
  await flush();
  const of = (t: string) => sent.filter((x) => x.t === t).map((x) => x.args);
  return { b, tx, of, host: () => host as unknown as TranscriptRenderHost };
}

describe('TranscriptMode: answers and prompt secrets (#108 round 4)', () => {
  beforeEach(installDialogs);
  afterEach(() => document.body.replaceChildren());

  it('an ask: the Other answer reviewed (“your answer to question 2”), sent with its review keyed by path', async () => {
    const h = await harness();
    const other = `use ${SECRET}`;
    const r = h.host().onAnswerAsk({ id: '', tool_use_id: 'tu1', answers: [{ question: 0, choices: [1] }, { question: 1, other }] });
    await flush();
    expect(h.b.open()).toMatchObject({ target: 'Ada', field: 'your answer to question 2', counts: { found: 1 } });
    expect(h.of('worker.answer_ask')).toEqual([]);
    h.b.confirm();
    await expect(r).resolves.toMatchObject({ ok: true });
    const [args] = h.of('worker.answer_ask');
    expect(Object.keys(args!.secrets as object)).toEqual(['answers[1].other']);
    expect(h.b.gate(other, (args!.secrets as Record<string, unknown>)['answers[1].other'], 'a', { field: 'answers[1].other' })).toMatchObject({ protected: 1 });
  });

  it('a follow-up: an answer’s value and the round’s note, reviewed in turn; Cancel keeps the answer and sends nothing', async () => {
    const h = await harness();
    const args = { id: '', turn_id: 't1', answers: [{ id: 'q1', value: `deploy with ${SECRET}` }], note: 'and PASSWORD=hunter22 for staging' };
    const r = h.host().onAnswerFollowup!(args);
    await flush();
    expect(h.b.open()?.field).toBe('your answer to question 1');
    h.b.confirm();
    await flush();
    expect(h.b.open()?.field).toBe('your note');
    h.b.confirm();
    await expect(r).resolves.toMatchObject({ ok: true });
    expect(Object.keys(h.of('worker.answer_followup')[0]!.secrets as object).sort()).toEqual(['answers[0].value', 'note']);
    const c = h.host().onAnswerFollowup!(args);
    await flush();
    h.b.cancel();
    await expect(c).resolves.toEqual({ ok: false, code: 'secrets_kept', message: 'Not sent: the review was cancelled. Your answer is still here.' });
    expect(h.of('worker.answer_followup')).toHaveLength(1);
  });

  it('a Codex async answer: keyed by its place in the args; “Review secrets” opens the review with nothing found', async () => {
    const h = await harness();
    const r = h.host().onAnswerAsync!({ id: '', thread: 'th', batch: 'b1', answers: [{ index: 0, answer: 'fine' }, { index: 3, answer: SECRET }] });
    await flush();
    expect(h.b.open()?.field).toBe('your answer to question 4');
    h.b.confirm();
    await expect(r).resolves.toMatchObject({ ok: true });
    expect(Object.keys(h.of('worker.answer_async')[0]!.secrets as object)).toEqual(['answers[1].answer']);
    const m = h.host().onAnswerAsync!({ id: '', thread: 'th', batch: 'b2', answers: [{ index: 0, answer: 'the code is 4471' }] }, { review: true });
    await flush();
    expect(h.b.open()).toMatchObject({ manual: true, counts: { found: 0 } });
    h.b.confirm();
    await expect(m).resolves.toMatchObject({ ok: true });
    expect(h.of('worker.answer_async')[1]).not.toHaveProperty('secrets');
  });
});

// #187: the questions' sheet with the real view, across views and seats: a mandatory question opens it once (kept per
// worker above the view), the ask's picks survive closing it and standing up, it never pops over the terminal, and
// nothing of it is left on the page once you stand up.
describe('TranscriptMode: the questions’ sheet across views and seats (#187)', () => {
  const ASK: Ask = {
    tool_use_id: 'tu-a',
    agent: 'claude',
    source: 'transcript',
    since: 1,
    questions: [
      { question: 'Which color?', header: 'Color', multi: false, other: true, options: [{ label: 'Red' }, { label: 'Blue' }] },
      { question: 'Which extras?', header: 'Extras', multi: true, other: false, options: [{ label: 'Logs' }, { label: 'Metrics' }] },
    ],
  };
  beforeEach(() => {
    // jsdom has no modal dialogs: open / close are what the sheet looks at.
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      if (!this.open) return;
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  });
  afterEach(() => document.body.replaceChildren());

  async function seat(): Promise<{ tx: TranscriptMode; sit: () => Promise<void> }> {
    document.body.replaceChildren();
    const tx = new TranscriptMode({
      feed: () => null,
      send: (() => Promise.resolve<CommandResult>({ ok: true, data: {} })) as never,
      renderer: () => Promise.resolve(mountTranscript),
      overlay: () => document.body.appendChild(document.createElement('div')),
      storage: null,
      status: () => {},
      modeChanged: () => {},
    });
    const sit = async () => {
      tx.sit('a', 'Ada', true, 'claude');
      await flush();
    };
    await sit();
    return { tx, sit };
  }
  const sheet = () => document.querySelector<HTMLDialogElement>('dialog.tx-qsheet');
  const button = () => document.querySelector<HTMLButtonElement>('.tx-qbtn');
  const hide = () => sheet()!.querySelector<HTMLButtonElement>('.sheet-close')!.click();

  it('opens once per ask: hidden, not again on a redraw or another seat (the button keeps it); a new ask opens it', async () => {
    const { tx, sit } = await seat();
    tx.asked(ASK);
    expect(sheet()?.open).toBe(true);
    expect(sheet()!.contains(document.activeElement)).toBe(true); // the keyboard inside
    hide();
    expect(sheet()?.open).toBe(false);
    expect([button()?.hidden, button()?.dataset.lane]).toEqual([false, 'urgent']);
    tx.asked({ ...ASK, since: 2 }); // the same ask again (a reconnect's snapshot)
    expect(sheet()?.open).toBe(false);
    tx.stand();
    expect(document.querySelectorAll('dialog').length).toBe(0); // nothing of the sheet left on the page
    expect(tx.counts.mounted).toBe(tx.counts.destroyed);
    await sit();
    tx.asked(ASK);
    expect(sheet()?.open ?? false).toBe(false);
    expect(button()?.hidden).toBe(false);
    tx.asked({ ...ASK, tool_use_id: 'tu-b' });
    expect(sheet()?.open).toBe(true);
    // Up when you stand: nothing is left either, and it does not open again for it at the next seat.
    tx.stand();
    expect(document.querySelectorAll('dialog').length).toBe(0);
    await sit();
    tx.asked({ ...ASK, tool_use_id: 'tu-b' });
    expect(sheet()?.open ?? false).toBe(false);
  });

  it('the ask’s picks survive closing and opening the sheet, and standing up and sitting again', async () => {
    const { tx, sit } = await seat();
    tx.asked(ASK);
    document.querySelector<HTMLButtonElement>('.tx-ask-opt[data-n="1"]')!.click(); // Red, on to Extras
    document.querySelector<HTMLButtonElement>('.tx-ask-opt[data-n="2"]')!.click(); // Metrics
    hide();
    button()!.click();
    expect(sheet()?.open).toBe(true);
    expect(document.querySelector('.tx-ask-row.is-done .tx-ask-row-text')?.textContent).toBe('Red');
    expect(document.querySelector('.tx-ask-opt[data-n="2"]')?.getAttribute('aria-checked')).toBe('true');
    tx.stand();
    await sit();
    tx.asked(ASK);
    button()!.click();
    // Every question answered: all folded to their answers, Send next.
    expect([...document.querySelectorAll('.tx-ask-row.is-done .tx-ask-row-text')].map((r) => r.textContent)).toEqual(['Red', 'Metrics']);
    expect(document.activeElement?.classList.contains('tx-ask-send')).toBe(true);
    // Another ask starts afresh.
    tx.asked({ ...ASK, tool_use_id: 'tu-b' });
    expect(document.querySelector('.tx-ask-row.is-done')).toBeNull();
  });

  it('never pops over the terminal: it opens once the conversation is shown; Ctrl+Esc in it goes to the terminal, closing it', async () => {
    const { tx } = await seat();
    tx.setMode('terminal');
    tx.asked(ASK);
    expect(sheet()?.open ?? false).toBe(false);
    tx.setMode('transcript');
    expect(sheet()?.open).toBe(true);
    const opt = document.querySelector<HTMLElement>('.tx-ask-opt')!;
    opt.focus();
    const e = new KeyboardEvent('keydown', { key: 'Escape', ctrlKey: true, bubbles: true, cancelable: true });
    opt.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(tx.mode).toBe('terminal');
    expect(sheet()?.open).toBe(false);
    tx.setMode('transcript');
    expect(sheet()?.open).toBe(false); // opened for already: the button has it
    expect(button()?.hidden).toBe(false);
  });
});
