import { describe, expect, it } from 'vitest';
import type { Snapshot, Worker } from '../../net/protocol';
import { runColor } from '../../world/crew';
import { WorldStore } from '../../world/store';
import { cardOf } from './cardOf';
import { STAMP_INK, TAG_DEFAULT } from './crewCard';
import { cardLayout, compactOf, isTall, MAX_CREW, TALL_H, type Measure } from './layout';
import { sameCard } from './types';

const measure: Measure = (font, text) => text.length * Number(/(\d+)px/.exec(font)?.[1] ?? 25) * 0.48;

const RUN = '20260928-1400-overcap';
const w = (over: Partial<Worker>): Worker => ({ id: 'x', session: 'lab', workspace_id: 'w1', label: 'x', status: 'idle', agent_kind: 'claude', name: 'Pip', desk_index: 0, ...over });

function viewOf(workers: Worker[], id: string) {
  const s = new WorldStore(0);
  const snap: Snapshot = {
    t: 'world.snapshot',
    seq: 1,
    world: { buildings: [], unassigned: ['lab'], floors: [{ session: 'lab', state: 'running', building: null, index: null, desks: 8 }], workers },
  };
  s.applySnapshot(snap);
  const v = s.workerView(id);
  if (!v) throw new Error('no view');
  return v;
}

const orch = w({ id: 'o', label: 'ORCH|overcap', role: 'orch', run: RUN, status: 'done', phase: 'waiting_user', pass: 3, over_cap: true, title: 'Orchestrating #3' });
const review = w({
  id: 'r',
  label: 'REVIEW|overcap|3|r3',
  role: 'review',
  run: RUN,
  round: 3,
  ticket: '3',
  issue: { repo: 'JeffreyVdb/lab', number: 3 },
  orch_id: 'o',
  desk_index: 2,
  status: 'done',
  report: { state: 'ready', at: 1, verdict: 'CHANGES_REQUIRED', blockers: 2, issues: 5 },
});

describe('crew cards (M6)', () => {
  it('a reviewer: role tag in its run colour, the verdict stamp; its issue and run when looked at', () => {
    const c = cardOf(viewOf([orch, review], 'r'));
    const hex = `#${(runColor(RUN) as number).toString(16).padStart(6, '0')}`;
    expect(c).toMatchObject({ name: 'Pip', display: 'done', tag: { text: 'REVIEW r3', color: hex }, stamp: { tone: 'changes', text: 'CHANGES · 2 BLOCKERS' } });
    expect(c.crew).toBeUndefined();
    expect(isTall(c)).toBe(false);
    const f = cardOf(viewOf([orch, review], 'r'), true);
    expect(f.crew).toEqual(['JeffreyVdb/lab#3 · run 20260928-1400-overcap', 'Handed in its report']);
    expect(isTall(f)).toBe(true);
    expect(sameCard(c, f)).toBe(false);
  });

  it('an over-cap orchestrator: its phase and pass on the tag, the cap as its red bubble', () => {
    const c = cardOf(viewOf([orch], 'o'));
    expect(c).toMatchObject({ display: 'needs_you', tag: { text: 'ORCH · waiting for you · 3/3' }, ask: { text: 'Past the review cap (pass 3 of 3). It needs your call.', choices: [] } });
    expect(c.stamp).toBeUndefined();
    expect(isTall(c)).toBe(true);
    // Without a tall cell: the call as the task line, the tag kept.
    expect(compactOf(c)).toMatchObject({ task: 'Past the review cap (pass 3 of 3). It needs your call.', tag: { text: 'ORCH · waiting for you · 3/3' } });
    expect(cardOf(viewOf([orch], 'o'), true).crew).toEqual(['run 20260928-1400-overcap', 'Waiting for you · pass 3 of 3']);
  });

  it('a freelancer whose report asks: the question in its bubble', () => {
    const c = cardOf(viewOf([w({ label: 'UX|lobby|3|r1', report: { state: 'ready', at: 1, input_required: 'Which port should the demo use?' } })], 'x'));
    expect(c).toMatchObject({ display: 'needs_you', tag: { text: 'UX r1', color: TAG_DEFAULT }, ask: { text: 'Which port should the demo use?', choices: [] } });
  });

  it('a question on the screen wins over the report', () => {
    const q = { kind: 'permission', text: 'Proceed?', excerpt: [], choices: [{ n: 1, label: 'Yes' }], hash: 'h' };
    const c = cardOf(viewOf([w({ label: 'CODE|x|r1', status: 'blocked', question: q, report: { state: 'ready', input_required: 'Port?' } })], 'x'));
    expect(c.ask?.text).toBe('Proceed?');
  });

  it('a coder report: its summary when looked at; plain workers get nothing', () => {
    const c = cardOf(viewOf([w({ label: 'CODE|lobby|3|r1', ticket: 'lobby-3', report: { state: 'ready', at: 1, summary: 'Head 821f4b3.\nTests green.' } })], 'x'), true);
    expect(c.crew).toEqual(['ticket lobby-3', 'Handed in its report', 'Report: Head 821f4b3. Tests green.']);
    expect(c.stamp).toBeUndefined();
    const plain = cardOf(viewOf([w({ label: 'docs' })], 'x'), true);
    expect(plain.tag).toBeUndefined();
    expect(plain.crew).toBeUndefined();
  });

  it('a freelancer without a terminal title says what it is doing, not its label', () => {
    expect(cardOf(viewOf([w({ label: 'GROUND|lobby-a11y', role: 'ground' })], 'x')).task).toBe('Reading the brief');
    expect(cardOf(viewOf([w({ label: 'CODE|lobby-sign|4|r1', status: 'unknown' })], 'x')).task).toBe('Just arrived: unpacking');
    expect(cardOf(viewOf([w({ label: 'CODE|x|r1', title: 'Wire the lobby' })], 'x')).task).toBe('Wire the lobby');
    // An orchestrator keeps its label.
    expect(cardOf(viewOf([w({ label: 'ORCH|lobby', role: 'orch' })], 'x')).task).toBe('ORCH|lobby');
  });

  it('stamp inks differ per verdict', () => {
    expect(new Set(Object.values(STAMP_INK)).size).toBe(3);
  });
});

describe('crew rows in a tall card', () => {
  it('puts the tag row under the name, then the crew lines, then the question', () => {
    const L = cardLayout(
      { name: 'Pip', display: 'needs_you', task: 't', tag: { text: 'ORCH', color: '#000' }, crew: ['a', 'b'], ask: { text: 'Call?', choices: [] } },
      measure,
    );
    expect(L.rows.map((r) => r.kind)).toEqual(['tag', 'crew', 'crew', 'question']);
    const ys = L.rows.map((r) => r.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  });

  it('drops crew lines before it overflows the tall cell', () => {
    const choices = Array.from({ length: 6 }, (_, i) => ({ n: i + 1, label: `choice ${i + 1}` }));
    const L = cardLayout(
      {
        name: 'Pip',
        display: 'needs_you',
        task: 't',
        tag: { text: 'CODE r2', color: '#000' },
        stamp: { tone: 'pass', text: 'PASS' },
        crew: ['one', 'two', 'three', 'four'],
        ask: { text: 'A long question that wraps onto a second line for sure, yes it does indeed wrap', about: ['cmd', 'more'], choices },
        usage: '≈$0.09 · 37k tokens',
      },
      measure,
    );
    expect(L.rows.filter((r) => r.kind === 'crew').length).toBeLessThanOrEqual(MAX_CREW);
    expect(L.height).toBeLessThanOrEqual(TALL_H);
  });
});
