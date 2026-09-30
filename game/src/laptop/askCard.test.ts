// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { Ask, CommandArgs } from '../net/protocol';
import { AskCard, type AskResult } from './askCard';
import { mountTranscript, type TranscriptView } from './transcriptRender';

// #57: the pinned question card: an answer's ack changes only the ask it was sent for (upserts that come meanwhile are
// the worker's word), and its keys work from the card itself (Enter sends, Esc back to the timeline).

const ask = (id = 'a', question = 'Which color?'): Ask => ({
  tool_use_id: id,
  agent: 'claude',
  source: 'transcript',
  since: 1,
  questions: [
    { question, header: 'Color', multi: false, other: true, options: [{ label: 'Red' }, { label: 'Blue' }] },
    { question: 'Which extras?', header: 'Extras', multi: true, other: true, options: [{ label: 'Logs' }, { label: 'Metrics' }, { label: 'Traces' }] },
  ],
});

/** A host whose answers wait until the test settles them. */
function slowHost() {
  const pending: Array<{ args: CommandArgs['worker.answer_ask']; done: (r: AskResult) => void }> = [];
  let timeline = 0;
  const host = {
    answer: (args: CommandArgs['worker.answer_ask']) => new Promise<AskResult>((done) => pending.push({ args, done })),
    toTerminal: () => {},
    focusTimeline: () => timeline++,
    resized: () => {},
  };
  return { host, pending, timelines: () => timeline };
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};
const press = (c: AskCard, key: string) => c.key(new KeyboardEvent('keydown', { key }));

describe('AskCard: an ack is about its own ask', () => {
  let card: AskCard | null = null;
  afterEach(() => {
    card?.destroy();
    card = null;
  });

  function sending(): { c: AskCard; pending: ReturnType<typeof slowHost>['pending'] } {
    const { host, pending } = slowHost();
    const c = new AskCard(host);
    card = c;
    document.body.append(c.el);
    c.set(ask('a'));
    press(c, '1');
    press(c, '1');
    press(c, 'Enter');
    expect(pending).toHaveLength(1);
    expect(c.el.dataset.phase).toBe('sending');
    return { c, pending };
  }

  it('answered in the terminal while sending: it shows sending until the ack, then goes (a stale ack too)', async () => {
    const { c, pending } = sending();
    c.set(null);
    expect(c.shown).toBe(true);
    expect(c.el.dataset.phase).toBe('sending');
    pending[0]?.done({ ok: false, code: 'stale', message: 'answered' });
    await flush();
    expect(c.shown).toBe(false);
    expect(c.el.hidden).toBe(true);
  });

  it('another question while sending: it is shown at once, and the old ack (resolved or stale) leaves it', async () => {
    for (const r of [{ ok: true, resolved: true }, { ok: false, code: 'stale', message: 'another' }] as AskResult[]) {
      const { c, pending } = sending();
      c.set(ask('b', 'NEW QUESTION: which color?'));
      expect(c.toolUseId).toBe('b');
      expect(c.el.querySelector('.tx-ask-question')?.textContent).toBe('NEW QUESTION: which color?');
      expect(c.el.dataset.phase).toBe('pending');
      // Its picks start empty, and it waits for the old ack before it can be sent.
      expect(c.el.querySelector('.tx-ask-opt.is-on')).toBeNull();
      pending[0]?.done(r);
      await flush();
      expect(c.shown).toBe(true);
      expect(c.toolUseId).toBe('b');
      expect(c.el.dataset.phase).toBe('pending');
      if (!r.ok) expect(c.el.querySelector('.tx-ask-note')?.textContent).toContain('changed meanwhile');
      card?.destroy();
    }
  });

  it('resolved while its upsert without the ask is still on its way: gone, and the same ask again stays gone', async () => {
    const { c, pending } = sending();
    pending[0]?.done({ ok: true, resolved: true });
    await flush();
    expect(c.shown).toBe(false);
    c.set(ask('a'));
    expect(c.shown).toBe(false);
    c.set(null);
    c.set(ask('b'));
    expect(c.toolUseId).toBe('b');
  });

  it('stale for the ask it still shows: the card stays with the reason', async () => {
    const { c, pending } = sending();
    pending[0]?.done({ ok: false, code: 'stale', message: 'gone' });
    await flush();
    expect(c.toolUseId).toBe('a');
    expect(c.el.dataset.phase).toBe('pending');
    expect(c.el.querySelector('.tx-ask-note.is-error')?.textContent).toContain('answered or changed meanwhile');
  });

  it('dismissing: the same, a new question kept', async () => {
    const { host, pending } = slowHost();
    const c = new AskCard(host);
    card = c;
    document.body.append(c.el);
    c.set(ask('a'));
    c.el.querySelector<HTMLButtonElement>('.tx-ask-dismiss')?.click();
    expect(pending[0]?.args).toMatchObject({ tool_use_id: 'a', cancel: true });
    c.set(ask('b'));
    pending[0]?.done({ ok: true, resolved: true });
    await flush();
    expect(c.toolUseId).toBe('b');
  });
});

describe('the card in the transcript view: keys', () => {
  let view: TranscriptView | null = null;
  let el: HTMLElement | null = null;
  afterEach(() => {
    view?.destroy();
    el?.remove();
    view = null;
  });

  function mount(answer: (args: CommandArgs['worker.answer_ask']) => Promise<AskResult> = async () => ({ ok: true, resolved: true })) {
    el = document.createElement('div');
    document.body.append(el);
    const sent: Array<CommandArgs['worker.answer_ask']> = [];
    view = mountTranscript(el, {
      images: null,
      onPromptSubmit: async () => true,
      onAnswer: () => {},
      onAnswerAsk: (args) => {
        sent.push(args);
        return answer(args);
      },
      onSwitchToTerminal: () => {},
      loadSubagent: async () => [],
    });
    return { root: el, sent };
  }
  /** A keydown on whatever has the keyboard, as the browser sends it; true: nothing took it (the default action runs). */
  const key = (k: string, opts: KeyboardEventInit = {}) => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));

  it('digits, Tab (an option focused), a digit, Enter: sent', async () => {
    const { root, sent } = mount();
    view?.setAsk(ask('a'));
    view?.focus();
    key('1'); // Red, on to Extras
    key('1'); // Logs
    key('Tab'); // back to Color: its option focused
    expect(document.activeElement?.classList.contains('tx-ask-opt')).toBe(true);
    key('2'); // Blue instead
    expect(key('Enter')).toBe(false); // the card's, not the focused option's click
    await flush();
    expect(sent).toEqual([{ id: '', tool_use_id: 'a', answers: [{ question: 0, choices: [2] }, { question: 1, choices: [1] }] }]);
    expect(root.querySelector('.tx-ask')?.hasAttribute('hidden')).toBe(true);
  });

  it('Enter on a focused option before every question has an answer: to the one missing, nothing sent', () => {
    const { root, sent } = mount();
    view?.setAsk(ask('a'));
    view?.focus();
    key('Tab'); // Extras
    key('Enter');
    expect(sent).toHaveLength(0);
    expect(root.querySelector('.tx-ask-tab.is-active')?.textContent).toContain('Color');
    expect(root.querySelector('.tx-ask-note')?.textContent).toContain('Answer “Color” first');
  });

  it('Space on a focused option picks it (its click)', () => {
    const { root } = mount();
    view?.setAsk(ask('a'));
    view?.focus();
    key('Tab');
    key('Tab'); // Color again, Red focused
    const opt = document.activeElement as HTMLButtonElement;
    expect(key(' ')).toBe(true); // left to the button
    opt.click();
    expect(root.querySelector('.tx-ask-tab.is-done')?.textContent).toContain('Color'); // picked: on to Extras
  });

  it('Esc on an option or a tab: the timeline has the keyboard, the seat is not left', () => {
    const { root } = mount();
    const stood: KeyboardEvent[] = [];
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) stood.push(e);
    };
    window.addEventListener('keydown', up);
    try {
      view?.setAsk(ask('a'));
      view?.focus();
      key('Tab');
      expect(document.activeElement?.classList.contains('tx-ask-opt')).toBe(true);
      expect(key('Escape')).toBe(false);
      expect(document.activeElement?.classList.contains('tx-scroll')).toBe(true);
      root.querySelector<HTMLElement>('.tx-ask-tab')?.focus();
      key('Escape');
      expect(document.activeElement?.classList.contains('tx-scroll')).toBe(true);
      expect(stood).toHaveLength(0);
      // From the timeline itself Esc is the seat's again.
      key('Escape');
      expect(stood).toHaveLength(1);
    } finally {
      window.removeEventListener('keydown', up);
    }
  });

  it('a stale ack for the old ask while a new one is up: its card stays pinned, the prompt stays off', async () => {
    let done: (r: AskResult) => void = () => {};
    const { root } = mount(() => new Promise((r) => (done = r)));
    view?.setAsk(ask('a'));
    view?.focus();
    key('1');
    key('1');
    key('Enter');
    view?.setAsk(ask('b', 'NEW QUESTION: which color?'));
    done({ ok: false, code: 'stale', message: 'another question' });
    await flush();
    expect(root.querySelector('.tx-ask')?.hasAttribute('hidden')).toBe(false);
    expect(root.querySelector('.tx-ask-question')?.textContent).toBe('NEW QUESTION: which color?');
    expect(root.querySelector<HTMLElement>('.tx-input')?.getAttribute('aria-disabled')).toBe('true');
  });
});
