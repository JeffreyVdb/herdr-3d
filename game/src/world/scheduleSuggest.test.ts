import { describe, expect, it } from 'vitest';
import type { HandoffCandidate } from '../net/protocol';
import { scheduleSuggestionsStateOf, suggestionFor, suggestionOf, suggestionWhen, validSuggestion } from './scheduleSuggest';

// #66: the suggestion and the feature's state read strictly; the chip's words.

const S = { id: 't1', message: 'msg_a', due_at: Date.UTC(2026, 9, 19, 10, 45), title: 'Post-soak cleanup', draft_prompt: 'Go on.', score: 0.9, at: 1 };
const cand = (message?: string): HandoffCandidate => ({ id: 'c', session: 's', revision: 'r', harness: 'claude', source: 'message', bytes: 1, ...(message ? { message } : {}) });

describe('schedule suggestions (#66)', () => {
  it('reads a suggestion strictly: anything odd is none', () => {
    expect(validSuggestion(S)).toEqual(S);
    expect(suggestionOf({ schedule_suggestion: { ...S, extra: 1 } as never })).toEqual(S);
    for (const bad of [null, 'x', { ...S, id: '' }, { ...S, due_at: 'soon' }, { ...S, due_at: 0 }, { ...S, title: ' ' }, { ...S, draft_prompt: undefined }]) {
      expect(validSuggestion(bad)).toBeNull();
    }
    expect(suggestionOf(undefined)).toBeNull();
  });

  it('is for the candidate of its own message only', () => {
    const s = validSuggestion(S);
    expect(suggestionFor(s, cand('msg_a'))).toBe(s);
    expect(suggestionFor(s, cand('msg_b'))).toBeNull();
    expect(suggestionFor(s, null)).toBeNull();
    // A Codex last_agent_message: neither names a row.
    expect(suggestionFor(validSuggestion({ ...S, message: undefined }), cand())).not.toBeNull();
  });

  it('the chip’s time on the viewer’s clock, UTC beside it unless the viewer is on UTC, and passed', () => {
    const now = Date.UTC(2026, 9, 18, 10, 52);
    expect(suggestionWhen(S, now, 'Europe/Brussels')).toEqual({ when: 'tomorrow 12:45', utc: '10:45 UTC', passed: false });
    expect(suggestionWhen(S, now, 'UTC')).toEqual({ when: 'tomorrow 10:45', utc: '', passed: false });
    expect(suggestionWhen(S, S.due_at, 'UTC').passed).toBe(true);
  });

  it('reads the feature’s state strictly', () => {
    expect(scheduleSuggestionsStateOf({ enabled: true, threshold: 0.7, state: 'incomplete', missing: ['llm', 'x'], roles: { classifier: 'ready', llm: 'bogus' }, env: ['enabled', 3], zone: 'Europe/Brussels' })).toEqual({
      enabled: true,
      threshold: 0.7,
      state: 'incomplete',
      missing: ['llm'],
      roles: { classifier: 'ready', llm: 'off' },
      env: ['enabled'],
      zone: 'Europe/Brussels',
    });
    expect(scheduleSuggestionsStateOf({ enabled: true, threshold: 0.7, state: 'maybe' })).toBeNull();
  });
});
