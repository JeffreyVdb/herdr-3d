import './test/fakeCanvas';
import { describe, expect, it } from 'vitest';
import { App } from './app';
import type { CommandResult } from './net/client';
import type { Question } from './net/protocol';

/**
 * #106: quick answer (`App.answer`) refused by the bridge. No App test builds a whole App (it needs a renderer and a
 * page): this takes its prototype and gives it the parts `answer` reads.
 */

const permission: Question = {
  kind: 'permission',
  text: 'Do you want to proceed?',
  excerpt: ['rm -f $D/*', 'Do you want to proceed?'],
  choices: [
    { n: 1, label: 'Yes' },
    { n: 2, label: 'No' },
  ],
  selected: 1,
  hash: 'f9dcb4e9f3a09e71',
};

const PARTIAL = 'invalid state: part of what it asks about is off its screen, so it is not approved from here: approve it in its terminal';

/** The answer `App.answer` gives choice 1 when the bridge replies `result` and the worker is then `after`. */
async function answered(result: CommandResult, after: 'needs_you' | 'working') {
  const toasts: [string, number | undefined, string | undefined][] = [];
  const sent: unknown[] = [];
  let calls = 0;
  const view = (display: string) => ({ name: 'Blip', display, worker: { id: 'w1', question: display === 'needs_you' ? permission : null } });
  const parts = {
    store: { workerView: () => view(calls === 0 ? 'needs_you' : after) },
    unsupported: new Set<string>(),
    answering: new Set<string>(),
    hud: { toast: (text: string, ms?: number, kind?: string) => toasts.push([text, ms, kind]) },
    send: async (t: string, args: unknown) => {
      sent.push([t, args]);
      calls++;
      return result;
    },
  };
  await (App.prototype.answer as (this: unknown, id: string, pick: { choice: number }) => Promise<void>).call(parts, 'w1', { choice: 1 });
  return { toasts, sent };
}

describe('quick answer refused (#106)', () => {
  it('says the bridge’s reason and where its terminal is while the worker still waits', async () => {
    const { toasts, sent } = await answered({ ok: false, code: 'invalid_state', message: PARTIAL }, 'needs_you');
    expect(sent).toEqual([['worker.answer', { id: 'w1', hash: permission.hash, choice: 1 }]]);
    expect(toasts.at(-1)).toEqual([
      'Not sent to Blip: part of what it asks about is off its screen, so it is not approved from here: approve it in its terminal. Its terminal is at its laptop (E).',
      5200,
      'error',
    ]);
    expect(toasts.some(([t]) => t.includes('any more'))).toBe(false);
  });

  it('says it is not waiting any more once it is not', async () => {
    const { toasts } = await answered({ ok: false, code: 'invalid_state', message: 'invalid state: Blip is working, not blocked' }, 'working');
    expect(toasts.at(-1)).toEqual(['Blip isn’t waiting for an answer any more.', 3200, undefined]);
  });
});
