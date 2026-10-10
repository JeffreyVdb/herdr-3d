import { describe, expect, it } from 'vitest';
import type { HandoffCandidate, Worker } from '../net/protocol';
import { drawerFill, handoffRow, HandoffBook, hireTask, newOp, noCandidateWhy, omittedNote, snippetRuns } from './handoff';

const claude: HandoffCandidate = { id: 'c1', session: 's', revision: 'r', harness: 'claude', message: 'msg_1', source: 'message', bytes: 5 };
const codex: HandoffCandidate = { id: 'c2', session: 's', revision: 'r', harness: 'codex', message: 'msg_c', source: 'message', bytes: 5 };
const it3 = (id: string, kind: string, seq: number) => ({ id, kind, seq });

describe('handoffRow', () => {
  it('is the last assistant row of the Claude message', () => {
    const items = [it3('msg_1#0', 'thinking', 1), it3('msg_1#1', 'assistant', 2), it3('msg_1#3', 'assistant', 4), it3('msg_10#0', 'assistant', 5), it3('u', 'user', 6)];
    expect(handoffRow(items, claude)).toBe('msg_1#3');
  });
  it('is the Codex message item', () => {
    expect(handoffRow([it3('msg_c', 'assistant', 1), it3('msg_x', 'assistant', 2)], codex)).toBe('msg_c');
  });
  it('is no row when the page does not hold it (never the last row of a partial page)', () => {
    expect(handoffRow([it3('msg_0#0', 'assistant', 1), it3('msg_2#0', 'assistant', 2)], claude)).toBeNull();
    expect(handoffRow([it3('msg_1#0', 'tool', 1)], claude)).toBeNull();
    expect(handoffRow([it3('msg_1#0', 'assistant', 1)], null)).toBeNull();
    expect(handoffRow([it3('o:1', 'assistant', 1)], { id: 'c3', session: 's', revision: 'r', harness: 'codex', source: 'last_agent_message', bytes: 5 })).toBeNull();
  });
});

describe('snippetRuns', () => {
  it('turns the private-use markers into runs of text', () => {
    expect(snippetRuns('a \uE000loader\uE001 <b>x</b>…')).toEqual([
      { text: 'a ', hit: false },
      { text: 'loader', hit: true },
      { text: ' <b>x</b>…', hit: false },
    ]);
    expect(snippetRuns('\uE001odd\uE000')).toEqual([{ text: 'odd', hit: false }]);
  });
});

describe('the rest', () => {
  it('says why there is nothing to file, never a substitute', () => {
    const w = { id: 'w', session: 's', workspace_id: 'w1', label: 'l', status: 'idle', agent_kind: 'claude' } as Worker;
    expect(noCandidateWhy(w, 'Ada', false)).toMatch(/no filing cabinet/);
    expect(noCandidateWhy(w, 'Ada', true)).toMatch(/no completed reply/);
    expect(noCandidateWhy({ ...w, status: 'working' }, 'Ada', true)).toMatch(/working/);
    expect(noCandidateWhy({ ...w, handoff: claude }, 'Ada', true)).toBe('');
    expect(noCandidateWhy({ ...w, handoff: { ...claude, too_large: true } }, 'Ada', true)).toMatch(/1 MB/);
  });
  it('fills the drawers bottom first', () => {
    expect(drawerFill(0)).toEqual([0, 0, 0]);
    expect(drawerFill(3)).toEqual([0, 0, 3]);
    expect(drawerFill(10)).toEqual([0, 2, 8]);
    expect(drawerFill(99)).toEqual([8, 8, 8]);
  });
  it('words the omissions, the task and the op', () => {
    expect(omittedNote(claude)).toBeNull();
    expect(omittedNote({ ...claude, images: 2 })).toMatch(/2 images/);
    expect(hireTask('/h/f/a.md')).toBe('Read /h/f/a.md and continue the work. Invoke the skills it suggests.');
    expect(newOp()).toMatch(/^ho-[a-z0-9]{20}$/);
  });
  it('keeps the counts and the filed queue', () => {
    const b = new HandoffBook();
    b.reset(undefined);
    expect(b.known).toBe(false);
    b.reset({ counts: { f: 2, g: 0 } });
    expect([b.known, b.count('f'), b.count('g')]).toEqual([true, 2, 0]);
    const h = { id: 3, floor: 'f', worker_name: 'Ada', path: '/p', title: 't', created_at: 1, source: 'literal' as const, bytes: 1 };
    b.added({ t: 'handoff.added', seq: 1, session: 'f', handoff: h, handoff_count: 3 });
    expect(b.count('f')).toBe(3);
    expect(b.takeFiled()).toEqual([h]);
    expect(b.takeFiled()).toEqual([]);
    b.removed({ t: 'handoff.removed', seq: 2, session: 'f', handoff_id: 3, handoff_count: 2 });
    expect(b.count('f')).toBe(2);
  });
});
