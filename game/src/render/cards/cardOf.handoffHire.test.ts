import { describe, expect, it } from 'vitest';
import type { HandoffHire } from '../../net/protocol';
import type { WorkerView } from '../../world/store';
import { BOX_TAPE } from '../palette';
import { cardOf, HANDOFF_TAPE } from './cardOf';

// #219: a source worker whose handoff hires someone once filed: its card says where, so nobody hires into that desk.

const rec = (o: Partial<HandoffHire> = {}): HandoffHire => ({ op: 'ho-1', worker: 'A', worker_name: 'Pixel', mode: 'agent', floor: 'f', desk_index: 1, harness: 'claude', model: 'm', effort: 'high', state: 'waiting', started_at: 1, ...o });
const view = (o: Partial<WorkerView> = {}): WorkerView => ({ worker: { id: 'A', session: 'f', floor: 'f', workspace_id: 'w', label: 'l', status: 'working', title: 'Refactor the loader' } as WorkerView['worker'], name: 'Pixel', desk: 0, harness: 'claude', since: 0, display: 'working', ...o });

describe('cardOf: a pending handoff hire (#219)', () => {
  it('says where the new agent goes, on the handoff tape', () => {
    expect(cardOf(view({ handoffHire: rec() }))).toMatchObject({ task: 'Writing handoff → hires at Desk 2', tape: { text: HANDOFF_TAPE, color: BOX_TAPE } });
    expect(cardOf(view({ handoffHire: rec({ state: 'hiring' }) })).task).toBe('Hiring at Desk 2…');
  });

  it('nothing pending: the task as always; a worker that needs you keeps its status tape', () => {
    expect(cardOf(view())).toMatchObject({ task: 'Refactor the loader' });
    expect(cardOf(view()).tape).toBeUndefined();
    const c = cardOf(view({ display: 'needs_you', handoffHire: rec() }));
    expect(c.task).toBe('Writing handoff → hires at Desk 2');
    expect(c.tape).toBeUndefined();
  });
});
