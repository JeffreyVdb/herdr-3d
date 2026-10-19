// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandoffCandidate, ScheduleSuggestion, TranscriptItem } from '../net/protocol';
import type { FollowupResult } from './followupCard';
import { mountTranscript, type TranscriptRenderHost, type TranscriptView } from './transcriptRender';

// #66: the schedule suggestion's chip: on the handoff candidate's row, in place of the plain "Schedule follow-up…",
// while the suggestion is of that message. Its click hands the suggestion to the host (the form opens; nothing is
// scheduled, and the chip stays until the bridge says otherwise); its × dismisses it, and a refused dismiss keeps it.

vi.mock('../world/daylight', async (orig) => ({ ...(await orig<typeof import('../world/daylight')>()), browserZone: () => 'Europe/Brussels' }));

const NOW = Date.UTC(2026, 9, 18, 10, 52); // Sun 18 Oct 2026, 12:52 in Brussels
let container: HTMLDivElement;
let view: TranscriptView;
let opened: Array<{ c: HandoffCandidate; s?: ScheduleSuggestion }>;
let dismissed: ScheduleSuggestion[];
let dismissAnswer: FollowupResult;

function host(): TranscriptRenderHost {
  return {
    images: null,
    onPromptSubmit: () => Promise.resolve(true),
    onAnswer: () => undefined,
    onAnswerAsk: async () => ({ ok: true, resolved: true }),
    onSwitchToTerminal: () => undefined,
    loadSubagent: async () => [],
    onHandoff: () => undefined,
    onScheduleFollowup: (c, s) => opened.push(s ? { c, s } : { c }),
    onDismissScheduleSuggestion: async (s) => {
      dismissed.push(s);
      return dismissAnswer;
    },
  };
}

const item = (id: string, seq: number, kind: TranscriptItem['kind'], t = 'text'): TranscriptItem => ({ id, seq, ts: NOW + seq, kind, parts: [{ text: t }] });
const cand = (message: string): HandoffCandidate => ({ id: `c-${message}`, session: 's', revision: 'r', harness: 'claude', message, source: 'message', bytes: 4 });
const sug = (message: string, due = Date.UTC(2026, 9, 19, 10, 45), id = `t-${message}`): ScheduleSuggestion => ({
  id,
  message,
  due_at: due,
  title: 'Post-soak cleanup',
  draft_prompt: 'You are picking up after the soak.',
  score: 0.93,
  at: NOW,
});
const chip = () => container.querySelector<HTMLButtonElement>('.tx-sched-sug');
const plain = () => [...container.querySelectorAll<HTMLButtonElement>('.tx-sched-btn:not(.tx-sched-sug)')];
const x = () => container.querySelector<HTMLButtonElement>('.tx-sched-x');
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  opened = [];
  dismissed = [];
  dismissAnswer = { ok: true };
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(() => {
  view?.destroy();
  container.remove();
  vi.useRealTimers();
});

describe('the schedule suggestion chip', () => {
  it('stands in for “Schedule follow-up…” on its reply’s row: the time in the viewer’s zone, UTC beside it', () => {
    view = mountTranscript(container, host());
    view.setItems([item('u1', 1, 'user'), item('msg_a#0', 2, 'assistant', '24h soak until 10:45 UTC tomorrow.')]);
    view.setHandoff?.(cand('msg_a'));
    expect(plain()).toHaveLength(1);
    view.setScheduleSuggestion?.(sug('msg_a'));
    expect(plain()).toHaveLength(0);
    const c = chip()!;
    expect(c.getAttribute('aria-label')).toBe('Schedule follow-up · tomorrow 12:45 (10:45 UTC)');
    expect(c.textContent).toBe('Schedule follow-uptomorrow 12:45(10:45 UTC)');
    expect((c.closest('[data-id]') as HTMLElement).dataset.id).toBe('msg_a#0');
    // Handoff stays beside it.
    expect(container.querySelectorAll('.tx-handoff-btn')).toHaveLength(1);
    expect(x()?.getAttribute('aria-label')).toBe('Dismiss the suggested follow-up');
    expect(x()?.tagName).toBe('BUTTON');
  });

  it('a click hands the suggestion to the host and changes nothing (the form opens; nothing is scheduled)', () => {
    view = mountTranscript(container, host());
    view.setItems([item('msg_a#0', 1, 'assistant')]);
    view.setHandoff?.(cand('msg_a'));
    view.setScheduleSuggestion?.(sug('msg_a'));
    chip()!.click();
    expect(opened).toHaveLength(1);
    expect(opened[0]?.c.id).toBe('c-msg_a');
    expect(opened[0]?.s?.id).toBe('t-msg_a');
    expect(dismissed).toEqual([]);
    // Cancelling the form sends nothing: the chip is still there.
    expect(chip()).not.toBeNull();
  });

  it('× dismisses it; refused, it stays to try again; gone, the plain button returns', async () => {
    view = mountTranscript(container, host());
    view.setItems([item('msg_a#0', 1, 'assistant')]);
    view.setHandoff?.(cand('msg_a'));
    view.setScheduleSuggestion?.(sug('msg_a'));
    dismissAnswer = { ok: false, code: 'offline', message: 'Not connected' };
    x()!.click();
    expect(x()!.disabled).toBe(true); // in flight
    x()!.click();
    expect(dismissed).toHaveLength(1);
    await flush();
    expect(chip()).not.toBeNull();
    expect(x()!.disabled).toBe(false);
    expect(opened).toEqual([]); // the × never opens the form
    dismissAnswer = { ok: true };
    x()!.click();
    await flush();
    expect(dismissed).toHaveLength(2);
    view.setScheduleSuggestion?.(null); // the bridge's upsert
    expect(chip()).toBeNull();
    expect(plain()).toHaveLength(1);
  });

  it('is keyboard reachable: the chip and its × are buttons in order', () => {
    view = mountTranscript(container, host());
    view.setItems([item('msg_a#0', 1, 'assistant')]);
    view.setHandoff?.(cand('msg_a'));
    view.setScheduleSuggestion?.(sug('msg_a'));
    const group = container.querySelector('.tx-sched-chip')!;
    expect(group.getAttribute('role')).toBe('group');
    expect([...group.querySelectorAll('button')].map((b) => b.dataset.key)).toEqual(['schedule', 'dismiss-suggestion']);
  });

  it('only on its own message’s row: another reply’s candidate keeps the plain button', () => {
    view = mountTranscript(container, host());
    view.setItems([item('msg_a#0', 1, 'assistant'), item('u2', 2, 'user'), item('msg_b#0', 3, 'assistant')]);
    view.setScheduleSuggestion?.(sug('msg_a'));
    view.setHandoff?.(cand('msg_b'));
    expect(chip()).toBeNull();
    expect(plain()).toHaveLength(1);
  });

  it('a time that passed says so (the form then flags it); the day words follow the clock', () => {
    view = mountTranscript(container, host());
    view.setItems([item('msg_a#0', 1, 'assistant')]);
    view.setHandoff?.(cand('msg_a'));
    view.setScheduleSuggestion?.(sug('msg_a', Date.UTC(2026, 9, 18, 10, 0)));
    expect(chip()!.getAttribute('aria-label')).toBe('Schedule follow-up · suggested today 12:00, passed');
    expect(container.querySelector('.tx-sched-utc')).toBeNull();
    view.setScheduleSuggestion?.(sug('msg_a', Date.UTC(2026, 9, 21, 6, 30), 't2'));
    expect(chip()!.getAttribute('aria-label')).toBe('Schedule follow-up · Wed 08:30 (06:30 UTC)');
  });
});
