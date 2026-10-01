import { describe, expect, it } from 'vitest';
import type { FirePrepare, Snapshot, Worker } from '../net/protocol';
import { cardOf } from '../render/cards/cardOf';
import { BOX_TAPE } from '../render/palette';
import { sameCard } from '../render/cards/types';
import { WorldStore } from './store';
import { armedText, defaultChoice, needsYouLine, needsYouText, sentHomeText, WRAPPING_UP, WRAPUP_PROMPT, worktreeFate, wrapUpOf } from './wrapup';

const prep = (over: Partial<FirePrepare> = {}): FirePrepare => ({
  name: 'Marble',
  label: 'x',
  worktree: { path: '/wt/marble', linked: true },
  dirty: [],
  unpushed: 0,
  can_delete: true,
  can_delete_branch: true,
  ...over,
});

const w = (over: Partial<Worker>): Worker => ({ id: 'x', session: 'lab', workspace_id: 'w1', label: 'x', status: 'idle', agent_kind: 'claude', name: 'Pip', desk_index: 0, ...over });

function viewOf(worker: Worker) {
  const s = new WorldStore(0);
  const snap: Snapshot = {
    t: 'world.snapshot',
    seq: 1,
    world: { buildings: [], unassigned: ['lab'], floors: [{ session: 'lab', state: 'running', building: null, index: null, desks: 8 }], workers: [worker] },
  };
  s.applySnapshot(snap);
  const v = s.workerView(worker.id);
  if (!v) throw new Error('no view');
  return v;
}

describe('wrap-up (#83)', () => {
  it('preselects delete whenever it is safe, in send home and wrap up alike', () => {
    expect(defaultChoice(prep())).toBe('delete');
    expect(defaultChoice(prep({ can_delete_branch: false }))).toBe('delete');
    expect(defaultChoice(prep({ can_delete: false, can_delete_branch: false, dirty: [' M a.ts'] }))).toBe('keep');
    expect(defaultChoice(prep({ worktree: { path: '/repo', linked: false }, can_delete: false }))).toBe('keep');
    expect(defaultChoice(prep({ worktree: null, can_delete: false }))).toBe('keep');
  });

  it('starts from the ticket’s cleanup task', () => {
    expect(WRAPUP_PROMPT).toBe('Stop every server, background process, pane and freelancer you started in this session. Don’t touch anything else.');
  });

  it('says what happens to the worktree', () => {
    const u = { state: 'armed', worktree: 'delete', armed_at: 1 } as const;
    expect(sentHomeText('Marble', u, true)).toBe('Sent Marble home after wrap-up. Its worktree is deleted.');
    expect(sentHomeText('Marble', { ...u, worktree: 'delete_branch' }, true)).toBe('Sent Marble home after wrap-up. Its worktree and branch are deleted.');
    expect(sentHomeText('Marble', { ...u, worktree: 'keep' }, true)).toBe('Sent Marble home after wrap-up. Its worktree is kept.');
    expect(sentHomeText('Nacho', { ...u, worktree: 'keep' }, false)).toBe('Sent Nacho home after wrap-up.');
    expect(worktreeFate('keep', false)).toBe('');
    expect(armedText('Marble', u, true)).toBe('Marble is wrapping up. Once it reports CLEAN it goes home: its worktree is deleted.');
    expect(armedText('Nacho', { ...u, worktree: 'keep' }, false)).toBe('Nacho is wrapping up. Once it reports CLEAN it goes home.');
    const stuck = { state: 'needs_you', worktree: 'delete', armed_at: 1, reason: 'port 4173 is not mine' } as const;
    expect(needsYouText('Marble', stuck)).toBe('Marble’s wrap-up needs you: port 4173 is not mine.');
    expect(needsYouLine(stuck)).toBe('Wrap-up: port 4173 is not mine');
    expect(wrapUpOf({ wrapup: { state: 'firing', worktree: 'keep', armed_at: 1 } as never })).toBeNull();
  });

  it('wrapping up: the cardboard tape on the desk card; needing you: red, with the reason', () => {
    const plain = cardOf(viewOf(w({ title: 'Tidying' })));
    const armed = cardOf(viewOf(w({ title: 'Tidying', wrapup: { state: 'armed', worktree: 'delete', armed_at: 1 } })));
    expect(armed.tape).toEqual({ text: WRAPPING_UP, color: BOX_TAPE, box: true });
    expect(armed.display).toBe('idle');
    expect(sameCard(plain, armed)).toBe(false);
    const v = viewOf(w({ title: 'Tidying', wrapup: { state: 'needs_you', worktree: 'delete', armed_at: 1, reason: 'did not report a wrap-up result' } }));
    expect(v.display).toBe('needs_you');
    const stuck = cardOf(v);
    expect(stuck.tape).toBeUndefined();
    expect(stuck.task).toBe('Wrap-up: did not report a wrap-up result');
    // Its agent's own question goes first.
    const blocked = cardOf(viewOf(w({ status: 'blocked', wrapup: { state: 'armed', worktree: 'keep', armed_at: 1 } })));
    expect(blocked.display).toBe('needs_you');
    expect(blocked.tape).toBeUndefined();
  });
});
