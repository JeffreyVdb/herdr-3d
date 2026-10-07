// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { Worker } from '../net/protocol';
import type { WorkerView } from '../world/store';
import { askChip, promptBarAria, promptBarKey } from './promptBar';

const worker: Worker = {
  id: 'a',
  session: 'top',
  workspace_id: 'w1',
  label: 'x',
  status: 'blocked',
  agent_kind: 'codex',
  codex: {
    mode: 'shared',
    attached: true,
    thread: 'th1',
    async_blocked: true,
    questions: [{ batch: 'call_3', turn: 't1', seen: ['live'], at: 1, questions: [{ index: 0, title: 'Which fixture color?', options: ['Green'], state: 'pending' }, { index: 1, title: 'Any context?', state: 'pending' }] }],
  },
};
const view = (asks: number): WorkerView => ({ worker, name: 'Pixel', desk: 0, harness: 'codex', since: 0, display: 'working', asks });

describe('the look-at bar of a Codex worker with async questions (#157)', () => {
  it('says it asks, in the working colour, with the questions in its title', () => {
    const chip = askChip(view(2));
    expect(chip?.textContent).toBe('asks 2 questions');
    expect(chip?.className).toBe('prompt-ask prompt-ask--async');
    expect(chip?.title).toContain('Which fixture color?\nAny context?');
    expect(promptBarAria(view(2))).toBe('Codex asks 2 questions');
  });

  it('redraws when the count changes, and says nothing without one', () => {
    expect(promptBarKey(view(2))).not.toEqual(promptBarKey(view(1)));
    expect(askChip(view(0))).toBeNull();
    expect(promptBarAria(view(0))).toBe('');
  });
});
