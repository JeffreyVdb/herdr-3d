// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HandoffCandidate, TranscriptItem } from '../net/protocol';
import { mountTranscript, type TranscriptRenderHost, type TranscriptView } from './transcriptRender';

// #223: the inline Handoff button: one, on the row of the worker's latest completed reply, and only when the timeline
// holds that row; it follows live updates, pages, a new candidate and none.

let container: HTMLDivElement;
let view: TranscriptView;
let pressed: HandoffCandidate[];

function host(withHandoff = true): TranscriptRenderHost {
  return {
    images: null,
    onPromptSubmit: () => Promise.resolve(true),
    onAnswer: () => undefined,
    onAnswerAsk: async () => ({ ok: true, resolved: true }),
    onSwitchToTerminal: () => undefined,
    loadSubagent: async () => [],
    ...(withHandoff ? { onHandoff: (c: HandoffCandidate) => pressed.push(c) } : {}),
  };
}

const T0 = Date.UTC(2026, 9, 10, 9, 0, 0);
const it2 = (id: string, seq: number, kind: TranscriptItem['kind'], t = 'text'): TranscriptItem => ({ id, seq, ts: T0 + seq * 1000, kind, parts: [{ text: t }] });
const cand = (message: string, harness = 'claude', id = `c-${message}`): HandoffCandidate => ({ id, session: 's', revision: 'r', harness, message, source: 'message', bytes: 4 });
const buttons = () => [...container.querySelectorAll<HTMLButtonElement>('.tx-handoff-btn')];
const rowOf = (b: Element) => (b.closest('[data-id]') as HTMLElement).dataset.id;

beforeEach(() => {
  pressed = [];
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(() => {
  view?.destroy();
  container.remove();
});

describe('the inline Handoff button', () => {
  it('is one accessible button on the candidate’s row, and says it makes no AI call', () => {
    view = mountTranscript(container, host());
    view.setItems([it2('u1', 1, 'user'), it2('msg_a#0', 2, 'thinking'), it2('msg_a#1', 3, 'assistant', 'Done.'), it2('msg_b#0', 4, 'assistant', 'Other')]);
    view.setHandoff?.(cand('msg_a'));
    const b = buttons();
    expect(b).toHaveLength(1);
    expect(rowOf(b[0] as HTMLButtonElement)).toBe('msg_a#1');
    expect(b[0]?.textContent).toBe('Handoff');
    const note = document.getElementById(b[0]?.getAttribute('aria-describedby') ?? '');
    expect(note?.textContent).toBe('Save this message as written · no AI call');
    b[0]?.click();
    expect(pressed.map((c) => c.id)).toEqual(['c-msg_a']);
  });

  it('is on no row when the page does not hold the reply, and appears when its page loads', () => {
    view = mountTranscript(container, host());
    view.setItems([it2('msg_x#0', 10, 'assistant'), it2('msg_y#0', 11, 'assistant')]);
    view.setHandoff?.(cand('msg_a'));
    expect(buttons()).toHaveLength(0); // never the last row of a partial page
    view.setItems([it2('msg_a#0', 5, 'assistant'), it2('msg_x#0', 10, 'assistant'), it2('msg_y#0', 11, 'assistant')]);
    expect(buttons().map(rowOf)).toEqual(['msg_a#0']);
  });

  it('follows live updates (a rebuilt row keeps it), a new candidate and none', () => {
    view = mountTranscript(container, host());
    view.setItems([it2('msg_a#0', 1, 'assistant', 'First')]);
    view.setHandoff?.(cand('msg_a'));
    view.applyUpdates([it2('msg_a#0', 1, 'assistant', 'First, longer')]);
    expect(buttons().map(rowOf)).toEqual(['msg_a#0']);
    // A new turn: the old reply loses it before a new one is complete.
    view.applyUpdates([it2('u2', 2, 'user'), it2('msg_b#0', 3, 'assistant', 'Second')]);
    view.setHandoff?.(null);
    expect(buttons()).toHaveLength(0);
    view.setHandoff?.(cand('msg_b'));
    expect(buttons().map(rowOf)).toEqual(['msg_b#0']);
  });

  it('a Codex reply by its item id; nothing for a tool or thinking row, nor without the host’s handler', () => {
    view = mountTranscript(container, host());
    view.setItems([it2('msg_c', 1, 'assistant'), it2('call_1', 2, 'tool')]);
    view.setHandoff?.(cand('msg_c', 'codex'));
    expect(buttons().map(rowOf)).toEqual(['msg_c']);
    view.setHandoff?.(cand('call_1', 'codex'));
    expect(buttons()).toHaveLength(0);
    view.destroy();
    view = mountTranscript(container, host(false));
    view.setItems([it2('msg_c', 1, 'assistant')]);
    view.setHandoff?.(cand('msg_c', 'codex'));
    expect(buttons()).toHaveLength(0);
  });
});
