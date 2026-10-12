import { describe, expect, it } from 'vitest';
import type { AgentHandoff, HandoffCandidate, UsageCache, Worker } from '../net/protocol';
import { agentHandoffNote, cacheCopy, cacheState, drawerFill, handoffCommand, handoffRow, HandoffBook, hireTask, newOp, noCandidateWhy, omittedNote, snippetRuns } from './handoff';

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

describe('#224 handoffCommand', () => {
  it('reads an exact top-level /handoff and its instruction', () => {
    expect(handoffCommand('/handoff')).toBe('');
    expect(handoffCommand('  /handoff focus on the tests\n')).toBe('focus on the tests');
    expect(handoffCommand('/handoff\nmulti\nline')).toBe('multi\nline');
  });
  it('leaves prose, quotes, paths and longer names alone', () => {
    for (const t of ['run /handoff later', '`/handoff`', '/handoff/x.md', '/handoffs', '"/handoff"']) expect(handoffCommand(t)).toBeNull();
  });
});

describe('#224 cacheState and cacheCopy', () => {
  const c: UsageCache = { estimated: true, policy: 'observed_1h', ttl_min_ms: 3_600_000, ttl_max_ms: 3_600_000, request_from: 1000, request_to: 5000, expires_from: 3_601_000, expires_to: 3_605_000, context_tokens: 48_200 };
  it('is warm only before the earliest expiry, expired only after the latest', () => {
    expect(cacheState(c, 3_600_999)).toBe('warm');
    expect(cacheState(c, 3_603_000)).toBe('unknown');
    expect(cacheState(c, 3_605_001)).toBe('expired');
    expect(cacheState({ ...c, expires_from: 0 }, 2000)).toBe('unknown');
    expect(cacheState({ ...c, expires_to: 0 }, 9e12)).toBe('unknown');
    expect(cacheState(undefined, 1)).toBe('unknown');
  });
  it('says the ticket’s words with context tokens, never the transcript’s size', () => {
    const cold = cacheCopy(c, 'expired');
    expect(cold.line).toBe('Agent cache may have expired. Generating a handoff can process the current conversation context again (about 48k tokens).');
    expect(cold.label).toBe('May have expired');
    expect(cold.evidence).toContain('Kept 1 h, from observed 1-hour cache writes');
    expect(cacheCopy(c, 'unknown').line).toMatch(/^Agent cache may have expired/);
    expect(cacheCopy(c, 'warm').line).toMatch(/likely still warm, an estimate/);
    expect(cacheCopy({ estimated: true, policy: 'assumed', reason: 'ChatGPT-subscription cache lifetime is not documented' }, 'unknown').evidence).toMatch(/^Lifetime unknown \(assumed/);
    expect(cacheCopy({ ...c, ttl_max_ms: 0, ttl_min_ms: 1_800_000, policy: 'documented' }, 'warm').evidence).toContain('Kept at least 30 min');
    expect(cacheCopy(undefined, 'unknown', 900).line).toContain('(about 900 tokens)');
    for (const s of ['warm', 'expired', 'unknown'] as const) expect(cacheCopy(c, s).line).not.toMatch(/JSONL|transcript|whole/i);
  });
});

describe('#224 agentHandoffNote', () => {
  const base: AgentHandoff = { op: 'o', state: 'pending', started_at: 1 };
  it('says filed, failed, or nothing while it runs', () => {
    expect(agentHandoffNote(base, 'Ada')).toBeNull();
    expect(agentHandoffNote({ ...base, state: 'filed', send_home_result: 'started' }, 'Ada')?.text).toBe('Filed Ada’s handoff, written by its agent. Ada is on the way home.');
    const f = agentHandoffNote({ ...base, state: 'failed', reason: 'a person took over' }, 'Ada');
    expect(f).toEqual({ text: 'Ada’s agent handoff was not filed: a person took over. Ada stays; nobody was sent home.', kind: 'error' });
  });
});
