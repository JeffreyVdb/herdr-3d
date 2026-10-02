import { describe, expect, it } from 'vitest';
import type { FirePrepare } from '../net/protocol';
import { PACKUP_CLEANUP, packupApplies, packupChoice, packupPrompt, packupVerdict, struckParts, validRanges } from './packup';

const TEXT = 'Please make a PR and end your turn';

describe('pack up on request (#110)', () => {
  it('applies to Claude and Codex workers, never a freelancer or a shell', () => {
    expect(packupApplies({ agent_kind: 'claude', label: 'pixel' })).toBe(true);
    expect(packupApplies({ agent_kind: 'codex', role: 'orch', label: 'boss' })).toBe(true);
    expect(packupApplies({ agent_kind: 'claude', role: 'code', label: 'c1' })).toBe(false);
    expect(packupApplies({ agent_kind: 'claude', label: 'REVIEW|r2' })).toBe(false);
    expect(packupApplies({ agent_kind: '', harness: 'claude', label: 'notes' })).toBe(false);
    expect(packupApplies({ agent_kind: 'gemini', label: 'x' })).toBe(false);
    expect(packupApplies(null)).toBe(false);
  });

  it('reads an ack strictly: anything but a well-formed match sends as written', () => {
    expect(packupVerdict({ matched: false, score: 0.2 }, TEXT)).toEqual({ kind: 'send' });
    expect(packupVerdict(null, TEXT)).toEqual({ kind: 'send' });
    expect(packupVerdict({ matched: true, task: 'Please make a PR', removed: [{ start: 16, end: 34 }], score: 0.97 }, TEXT)).toEqual({
      kind: 'confirm',
      task: 'Please make a PR',
      removed: [{ start: 16, end: 34 }],
    });
    // Nothing left: the send-home dialog.
    expect(packupVerdict({ matched: true, removed: [{ start: 0, end: 34 }], score: 0.99 }, TEXT)).toEqual({ kind: 'home' });
    expect(packupVerdict({ matched: true, task: '  ', score: 0.99 }, TEXT)).toEqual({ kind: 'home' });
    for (const removed of [undefined, [], [{ start: 16, end: 99 }], [{ start: 20, end: 25 }, { start: 18, end: 22 }], [{ start: 3, end: 3 }], [{ start: 1.5, end: 4 }]]) {
      expect(packupVerdict({ matched: true, task: 'Please make a PR', removed, score: 0.9 }, TEXT)).toEqual({ kind: 'send' });
    }
  });

  it('splits the original into kept and struck parts', () => {
    expect(struckParts(TEXT, [{ start: 16, end: 34 }])).toEqual([
      { text: 'Please make a PR', struck: false },
      { text: ' and end your turn', struck: true },
    ]);
    const t = 'Go home. Fix A, then leave.';
    const r = validRanges([{ start: 0, end: 9 }, { start: 14, end: 26 }], t.length)!;
    expect(struckParts(t, r).map((p) => (p.struck ? `[${p.text}]` : p.text)).join('')).toBe('[Go home. ]Fix A[, then leave].');
  });

  it('preselects the worktree and its branch, else the worktree, else keep', () => {
    const p = (o: Partial<FirePrepare>): FirePrepare => ({ name: 'Pixel', branch: 'h3d/pixel', worktree: { path: '/w', linked: true }, dirty: [], unpushed: 0, can_delete: true, can_delete_branch: true, ...o }) as FirePrepare;
    expect(packupChoice(p({}))).toBe('delete_branch');
    expect(packupChoice(p({ can_delete_branch: false }))).toBe('delete');
    expect(packupChoice(p({ can_delete: false, dirty: [' M a.go'] }))).toBe('keep');
    expect(packupChoice(p({ worktree: null }))).toBe('keep');
  });

  it('sends the task first, then the cleanup request', () => {
    expect(packupPrompt('  Please make a PR ')).toBe(`Please make a PR\n\n${PACKUP_CLEANUP}`);
    expect(PACKUP_CLEANUP).toMatch(/^Once that is done: Stop every server/);
  });
});
