import { describe, expect, it } from 'vitest';
import type { Worker } from '../net/protocol';
import { promptBlocker, promptTextError, willQueue } from './prompt';
import type { FloorView, WorkerView } from './store';

const view = (over: Partial<Worker> = {}, display: WorkerView['display'] = 'idle', shell = false): WorkerView => {
  const worker: Worker = { id: 'w1', session: 'herdr-3d', workspace_id: 'w1', label: 'x', status: 'idle', agent_kind: 'claude', ...over };
  if (shell) delete worker.agent_kind;
  return { worker, name: 'Nibble', desk: 0, harness: shell ? undefined : 'claude', since: 0, display };
};
const floor = (over: Partial<FloorView> = {}) => ({ asleep: false, transition: null, ...over }) as FloorView;

describe('promptBlocker', () => {
  it('lets an agent on an awake floor be prompted', () => {
    expect(promptBlocker(view(), floor(), false)).toBeNull();
  });
  it('says why not: plain shell, asleep, waking, an older bridge, gone', () => {
    expect(promptBlocker(view({}, 'idle', true), floor(), false)).toBe('Nibble is a plain shell, not a coding agent: sit at its laptop (E) to type there.');
    expect(promptBlocker(view(), floor({ asleep: true }), false)).toBe('herdr-3d is asleep. Wake it from the elevator (L) to prompt Nibble.');
    expect(promptBlocker(view(), floor({ transition: 'waking' }), false)).toMatch(/waking up/);
    expect(promptBlocker(view(), floor(), true)).toBe('This herdr-world can’t send prompts yet. Update the bridge to use it.');
    expect(promptBlocker(null, null, false)).toMatch(/no longer/);
    // Blocked: the bridge answers invalid_state; answer the question instead.
    const q = { kind: 'permission', text: 'Proceed?', excerpt: [], choices: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }], hash: 'abcdabcdabcdabcd' };
    expect(promptBlocker(view({ status: 'blocked', question: q }, 'needs_you'), floor(), false)).toBe('Nibble is waiting for an answer first: pick one on its card (1–2, 0 denies).');
    expect(promptBlocker(view({ status: 'blocked' }, 'needs_you'), floor(), false)).toBe('Nibble is waiting on its screen: answer there (sit at its laptop, E), or 0 dismisses it.');
  });
});

describe('promptTextError', () => {
  it('needs 1 byte to 16 KiB without NUL', () => {
    expect(promptTextError('Run the tests and fix what fails.')).toBeNull();
    expect(promptTextError('  \n ')).toBe('Write something first.');
    expect(promptTextError('a\0b')).toMatch(/NUL/);
    expect(promptTextError('é'.repeat(8 * 1024))).toBeNull();
    expect(promptTextError('é'.repeat(8 * 1024 + 1))).toBe('Too long: 17 KiB, the most is 16 KiB.');
  });
  it('queues for a working worker', () => {
    expect(willQueue(view({}, 'working'))).toBe(true);
    expect(willQueue(view({}, 'done'))).toBe(false);
  });
});
