// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TranscriptItem } from '../net/protocol';
import { mountTranscript, type TranscriptRenderHost, type TranscriptView } from './transcriptRender';

// Run elsewhere: the button on every message you wrote and the R key (the conversation's first message) hand the
// message's whole text to the host; no host callback, no button and R does nothing.

let container: HTMLDivElement;
let view: TranscriptView;
let asked: Array<{ text: string; first: boolean; anchor: boolean; images?: boolean }>;

function host(o: Partial<TranscriptRenderHost> = {}, withRerun = true): TranscriptRenderHost {
  return {
    images: null,
    onPromptSubmit: () => Promise.resolve(true),
    onAnswer: () => undefined,
    onAnswerAsk: async () => ({ ok: true, resolved: true }),
    onSwitchToTerminal: () => undefined,
    loadSubagent: async () => [],
    ...(withRerun ? { onRerun: (text: string, first: boolean, anchor: HTMLElement | null, images: boolean) => asked.push({ text, first, anchor: anchor !== null, ...(images ? { images } : {}) }) } : {}),
    ...o,
  };
}

const T0 = Date.UTC(2026, 9, 29, 10, 0, 0);
const item = (id: string, seq: number, kind: TranscriptItem['kind'], ...texts: string[]): TranscriptItem => ({ id, seq, ts: T0 + seq * 1000, kind, parts: texts.map((text) => ({ text })) });
const buttons = () => [...container.querySelectorAll<HTMLButtonElement>('.tx-rerun')];
const rowOf = (b: Element) => (b.closest('[data-id]') as HTMLElement).dataset.id;
const flush = () => new Promise((r) => setTimeout(r, 0));
const pressR = (target: Element) => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', code: 'KeyR', bubbles: true, cancelable: true }));

beforeEach(() => {
  asked = [];
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(() => {
  view?.destroy();
  container.remove();
});

describe('Run elsewhere in the conversation', () => {
  const items = () => [item('u1', 1, 'user', 'Read the logs', 'Track the costs'), item('a1', 2, 'assistant', 'On it.'), item('u2', 3, 'user', 'Now the prefixes'), item('u3', 4, 'user', '  ')];

  it('puts a button on each message you wrote, none on the agent’s or a blank one', () => {
    view = mountTranscript(container, host());
    view.setItems(items());
    expect(buttons().map(rowOf)).toEqual(['u1', 'u2']);
    expect(buttons()[0]?.textContent).toBe('Run elsewhere');
  });

  it('hands the whole message (its text parts joined) and whether it is the first', async () => {
    view = mountTranscript(container, host());
    view.setItems(items());
    buttons()[0]?.click();
    buttons()[1]?.click();
    await flush();
    expect(asked).toEqual([
      { text: 'Read the logs\n\nTrack the costs', first: true, anchor: true },
      { text: 'Now the prefixes', first: false, anchor: true },
    ]);
  });

  it('loads a truncated message whole before handing it over', async () => {
    const short = { ...item('u1', 1, 'user', 'Read the'), truncated: true };
    view = mountTranscript(container, host({ loadItem: async (id) => (id === 'u1' ? item('u1', 1, 'user', 'Read the logs, all of them') : null) }));
    view.setItems([short]);
    buttons()[0]?.click();
    await flush();
    expect(asked.map((a) => a.text)).toEqual(['Read the logs, all of them']);
  });

  it('R picks the first message by seq, even when an older page came in after a newer one', async () => {
    view = mountTranscript(container, host());
    view.setItems([item('u5', 5, 'user', 'A later message'), item('u2', 2, 'user', 'The first message')]);
    pressR(container.querySelector('.tx-scroll') as Element);
    await flush();
    expect(asked.map((a) => [a.text, a.first])).toEqual([['The first message', true]]);
  });

  it('says when the message has images (they do not go)', async () => {
    const withImage: TranscriptItem = { ...item('u1', 1, 'user', 'See the screenshot'), parts: [{ text: 'See the screenshot' }, { image_omitted: { reason: 'size' } } as never] };
    view = mountTranscript(container, host());
    view.setItems([withImage]);
    buttons()[0]?.click();
    await flush();
    expect(asked).toEqual([{ text: 'See the screenshot', first: true, anchor: true, images: true }]);
  });

  it('R picks the conversation’s first message', async () => {
    view = mountTranscript(container, host());
    view.setItems(items());
    pressR(container.querySelector('.tx-scroll') as Element);
    await flush();
    expect(asked).toEqual([{ text: 'Read the logs\n\nTrack the costs', first: true, anchor: true }]);
  });

  it('without the host’s callback: no button, and R is not taken', async () => {
    view = mountTranscript(container, host({}, false));
    view.setItems(items());
    expect(buttons()).toHaveLength(0);
    const scroller = container.querySelector('.tx-scroll') as Element;
    const e = new KeyboardEvent('keydown', { key: 'r', code: 'KeyR', bubbles: true, cancelable: true });
    scroller.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});
