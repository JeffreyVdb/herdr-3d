import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Ask, TranscriptItem } from '../net/protocol';
import {
  answerAskArgs,
  answered,
  answeredLines,
  askLine,
  askOf,
  complete,
  emptyPicks,
  firstUnanswered,
  isSimple,
  optionLabel,
  pickedText,
  pickOption,
  pickOther,
  quickReplyBlocker,
  validAsk,
  waitingText,
} from './ask';

/** Two questions, the first a multi-select: the shape the e2e answers. */
const twoAsk: Ask = {
  tool_use_id: 'toolu_01U8ZrKFNvqFNsavBe7a22df',
  source: 'transcript',
  agent: 'claude',
  since: 1_790_000_000_000,
  questions: [
    { header: 'Extras', question: 'Which extras?', multi: true, other: true, options: [{ label: 'Logs', description: 'Request logs' }, { label: 'Metrics' }, { label: 'Traces' }] },
    { header: 'Color', question: 'Which color?', multi: false, other: true, options: [{ label: 'Red (Recommended)', description: 'Warm color' }, { label: 'Blue' }] },
  ],
};

describe('an ask', () => {
  it('is well formed or nothing', () => {
    expect(validAsk(twoAsk)).toBe(twoAsk);
    expect(askOf({ ask: twoAsk })).toBe(twoAsk);
    expect(askOf({})).toBeNull();
    expect(validAsk({ ...twoAsk, tool_use_id: '' })).toBeNull();
    expect(validAsk({ ...twoAsk, questions: [] })).toBeNull();
    expect(validAsk({ ...twoAsk, questions: [{ question: 'x' }] })).toBeNull();
    expect(validAsk(null)).toBeNull();
  });

  it('answers only when every question has an answer', () => {
    let p = emptyPicks(twoAsk);
    expect(complete(twoAsk, p)).toBe(false);
    expect(answerAskArgs('w', twoAsk, p)).toBeNull();
    p = pickOption(twoAsk, p, 0, 1);
    p = pickOption(twoAsk, p, 0, 3);
    expect(answered(twoAsk, p, 0)).toBe(true);
    expect(firstUnanswered(twoAsk, p)).toBe(1);
    // A typed answer that is only spaces is none.
    p = pickOther(twoAsk, p, 1, '   ');
    expect(complete(twoAsk, p)).toBe(false);
    p = pickOther(twoAsk, p, 1, ' Green\n');
    p = pickOther(twoAsk, p, 0, 'Custom dashboards');
    expect(complete(twoAsk, p)).toBe(true);
    expect(answerAskArgs('w', twoAsk, p)).toEqual({
      id: 'w',
      tool_use_id: twoAsk.tool_use_id,
      answers: [
        { question: 0, choices: [1, 3], other: 'Custom dashboards' },
        { question: 1, other: 'Green' },
      ],
    });
    expect(pickedText(twoAsk, p, 0)).toBe('Logs, Traces, Custom dashboards');
    expect(pickedText(twoAsk, p, 1)).toBe('Green');
  });

  it('toggles a multi-select option and swaps a single-select one', () => {
    let p = pickOption(twoAsk, emptyPicks(twoAsk), 0, 2);
    p = pickOption(twoAsk, p, 0, 2);
    expect(p[0]?.choices).toEqual([]);
    p = pickOption(twoAsk, p, 1, 1);
    p = pickOption(twoAsk, p, 1, 2);
    expect(p[1]?.choices).toEqual([2]);
    // A typed answer replaces a single-select option, and an option the typed answer.
    p = pickOther(twoAsk, p, 1, 'Green');
    expect(p[1]).toEqual({ choices: [], other: 'Green' });
    p = pickOption(twoAsk, p, 1, 1);
    expect(p[1]).toEqual({ choices: [1], other: null });
    // Out of range: unchanged.
    expect(pickOption(twoAsk, p, 1, 9)).toBe(p);
    expect(pickOption(twoAsk, p, 5, 1)).toBe(p);
  });

  it('shows "(Recommended)" apart from the label', () => {
    expect(optionLabel('Red (Recommended)')).toEqual({ text: 'Red', recommended: true });
    expect(optionLabel('HTTP POST via helper (recommended)')).toEqual({ text: 'HTTP POST via helper', recommended: true });
    expect(optionLabel('Blue')).toEqual({ text: 'Blue', recommended: false });
  });

  it('says what it asks, how long it waited, and whether a digit answers it', () => {
    expect(askLine(twoAsk)).toBe('2 questions: Extras, Color');
    const one: Ask = { ...twoAsk, questions: [twoAsk.questions[1] as Ask['questions'][number]] };
    expect(askLine(one)).toBe('Which color?');
    expect(isSimple(one)).toBe(true);
    expect(quickReplyBlocker(one)).toBeNull();
    expect(isSimple(twoAsk)).toBe(false);
    expect(quickReplyBlocker(twoAsk)).toBe('2 questions');
    expect(quickReplyBlocker({ ...twoAsk, questions: [twoAsk.questions[0] as Ask['questions'][number]] })).toBe('pick several');
    const t = 1_790_000_000_000;
    expect(waitingText(t, t + 12_000)).toBe('waiting 12s');
    expect(waitingText(t, t + 3 * 60_000 + 5_000)).toBe('waiting 3m');
    expect(waitingText(t, t + 65 * 60_000)).toBe('waiting 1h 05m');
    expect(waitingText(0, t)).toBe('waiting');
  });

  it("reads the bridge's recorded answers (fixtures/transcript/claude-ask.json)", () => {
    const items = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../fixtures/transcript/claude-ask.json'), 'utf8')) as TranscriptItem[];
    const cards = items.filter((it) => it.tool?.ask).map((it) => it.tool?.ask as NonNullable<NonNullable<TranscriptItem['tool']>['ask']>);
    expect(cards.map((c) => c.outcome)).toEqual(['answered', 'answered', 'answered', 'answered', 'answered', 'declined', 'clarify', 'answered', 'pending']);
    expect(answeredLines(cards[2] as (typeof cards)[number])).toEqual([
      { question: 'Which color?', answer: 'Blue' },
      { question: 'Which extras?', answer: 'Logs' },
    ]);
    expect(answeredLines(cards[7] as (typeof cards)[number])).toEqual([{ question: 'Which preview?', answer: 'B', notes: 'Prefer larger type' }]);
    expect(answeredLines(cards[8] as (typeof cards)[number])).toEqual([]);
  });
});
