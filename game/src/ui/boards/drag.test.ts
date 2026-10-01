import { describe, expect, it } from 'vitest';
import type { IssueCard } from '../../net/protocol';
import type { ColumnView } from '../../world/boards';
import { afterFor, edgeSpeed, placeMoves, samePlace, showsMove, slotAt, type DropColumn } from './drag';

// Two columns side by side: Todo (x 0–200) with three cards 50 px tall and 10 px apart from y 40, Doing (x 210–410) with
// one card, Empty (x 420–620) with none, No status (x 630–830) that takes no cards.
const rect = (left: number, top: number, w: number, h: number) => ({ left, top, right: left + w, bottom: top + h });
const cardsAt = (left: number, ids: string[]) => ids.map((id, i) => ({ id, rect: rect(left + 8, 40 + i * 60, 184, 50) }));
const COLUMNS: DropColumn[] = [
  { id: 'todo', rect: rect(0, 0, 200, 600), cards: cardsAt(0, ['a', 'b', 'c']) },
  { id: 'doing', rect: rect(210, 0, 200, 600), cards: cardsAt(210, ['d']) },
  { id: 'empty', rect: rect(420, 0, 200, 600), cards: [] },
  { id: '', rect: rect(630, 0, 200, 600), cards: cardsAt(630, ['n']), accepts: false },
];

describe('slotAt', () => {
  it('aims before a card over its top half and after it over its bottom half', () => {
    // d spans y 40–90, its midpoint 65.
    expect(slotAt({ x: 300, y: 50 }, COLUMNS, 'a')).toEqual({ column: 'doing', index: 0 });
    expect(slotAt({ x: 300, y: 64 }, COLUMNS, 'a')).toEqual({ column: 'doing', index: 0 });
    expect(slotAt({ x: 300, y: 66 }, COLUMNS, 'a')).toEqual({ column: 'doing', index: 1 });
    // Above the first card, below the last: the top and the end.
    expect(slotAt({ x: 300, y: 5 }, COLUMNS, 'a')).toEqual({ column: 'doing', index: 0 });
    expect(slotAt({ x: 300, y: 590 }, COLUMNS, 'a')).toEqual({ column: 'doing', index: 1 });
  });

  it('crosses each midpoint in turn down a column', () => {
    const at = (y: number) => slotAt({ x: 100, y }, COLUMNS, 'z')?.index;
    expect([at(10), at(70), at(100), at(130), at(160), at(200)]).toEqual([0, 1, 1, 2, 2, 3]);
  });

  it('leaves the dragged card out of its own column', () => {
    // b (y 100–150) is the one being dragged: just below a's midpoint is index 1, and so is anything over b.
    expect(slotAt({ x: 100, y: 70 }, COLUMNS, 'b')).toEqual({ column: 'todo', index: 1 });
    expect(slotAt({ x: 100, y: 140 }, COLUMNS, 'b')).toEqual({ column: 'todo', index: 1 });
    expect(slotAt({ x: 100, y: 180 }, COLUMNS, 'b')).toEqual({ column: 'todo', index: 1 });
    expect(slotAt({ x: 100, y: 200 }, COLUMNS, 'b')).toEqual({ column: 'todo', index: 2 });
  });

  it('takes an empty column, refuses one that takes no cards, and nothing between or outside columns', () => {
    expect(slotAt({ x: 500, y: 300 }, COLUMNS, 'a')).toEqual({ column: 'empty', index: 0 });
    expect(slotAt({ x: 700, y: 50 }, COLUMNS, 'a')).toBeNull();
    expect(slotAt({ x: 205, y: 50 }, COLUMNS, 'a')).toBeNull();
    expect(slotAt({ x: 100, y: 700 }, COLUMNS, 'a')).toBeNull();
    expect(slotAt({ x: -1, y: 50 }, COLUMNS, 'a')).toBeNull();
  });
});

describe('afterFor and samePlace', () => {
  it('names the card the slot follows, null for the top, the dragged card left out', () => {
    expect(afterFor(['d'], 0, 'a')).toBeNull();
    expect(afterFor(['d'], 1, 'a')).toBe('d');
    expect(afterFor([], 0, 'a')).toBeNull();
    expect(afterFor(['a', 'b', 'c'], 1, 'b')).toBe('a');
    expect(afterFor(['a', 'b', 'c'], 2, 'b')).toBe('c');
    expect(afterFor(['a', 'b', 'c'], 0, 'a')).toBeNull();
    expect(afterFor(['a', 'b', 'c'], 2, 'a')).toBe('c');
    expect(afterFor(['a', 'b'], 9, 'x')).toBe('b');
  });

  it('knows a drop that changes nothing', () => {
    expect(samePlace('todo', ['a', 'b', 'c'], 'b', { column: 'todo', index: 1 })).toBe(true);
    expect(samePlace('todo', ['a', 'b', 'c'], 'b', { column: 'todo', index: 0 })).toBe(false);
    expect(samePlace('todo', ['a', 'b', 'c'], 'b', { column: 'todo', index: 2 })).toBe(false);
    expect(samePlace('todo', ['a', 'b', 'c'], 'b', { column: 'doing', index: 1 })).toBe(false);
  });
});

describe('edgeSpeed', () => {
  it('scrolls back near the start, on near the end, faster the closer, and not in between', () => {
    expect(edgeSpeed(500, 0, 1000)).toBe(0);
    expect(edgeSpeed(0, 0, 1000)).toBe(-18);
    expect(edgeSpeed(1000, 0, 1000)).toBe(18);
    expect(edgeSpeed(1100, 0, 1000)).toBe(18);
    expect(edgeSpeed(28, 0, 1000)).toBe(-9);
    expect(edgeSpeed(980, 0, 1000)).toBeGreaterThan(0);
    // A small box shrinks the edges so its middle stays still.
    expect(edgeSpeed(50, 0, 90)).toBe(0);
  });
});

const ic = (id: string, column: string): IssueCard => ({ id, key: id, title: id, state: 'open', column, labels: [], assignees: [], updated_at: 1, closed_at: null });
const views = (): ColumnView[] => [
  { id: 'todo', name: 'Todo', done: false, cards: [ic('a', 'todo'), ic('b', 'todo')] },
  { id: 'doing', name: 'Doing', done: false, cards: [ic('d', 'doing'), ic('e', 'doing')] },
  { id: 'qa', name: 'QA', done: false, cards: [] },
];
const keys = (vs: ColumnView[]) => Object.fromEntries(vs.map((v) => [v.id, v.cards.map((c) => c.id)]));

describe('placeMoves and showsMove', () => {
  it('puts a moved card right after its anchor, on top for null, and leaves status-only moves to the sort', () => {
    expect(keys(placeMoves(views(), [{ id: 'a', column: 'doing', after: 'd' }]))).toEqual({ todo: ['b'], doing: ['d', 'a', 'e'], qa: [] });
    expect(keys(placeMoves(views(), [{ id: 'e', column: 'doing', after: null }]))).toEqual({ todo: ['a', 'b'], doing: ['e', 'd'], qa: [] });
    expect(keys(placeMoves(views(), [{ id: 'b', column: 'qa', after: null }, { id: 'a', column: 'qa', after: 'b' }]))).toEqual({ todo: [], doing: ['d', 'e'], qa: ['b', 'a'] });
    expect(keys(placeMoves(views(), [{ id: 'a', column: 'doing' }]))).toEqual(keys(views()));
    // An anchor that is not there (any more): on top.
    expect(keys(placeMoves(views(), [{ id: 'a', column: 'doing', after: 'zz' }])).doing).toEqual(['a', 'd', 'e']);
  });

  it('tells whether a board already shows a move', () => {
    const v = views();
    expect(showsMove(v, { id: 'e', column: 'doing', after: 'd' })).toBe(true);
    expect(showsMove(v, { id: 'd', column: 'doing', after: null })).toBe(true);
    expect(showsMove(v, { id: 'e', column: 'doing', after: null })).toBe(false);
    expect(showsMove(v, { id: 'a', column: 'doing', after: 'd' })).toBe(false);
    expect(showsMove(v, { id: 'a', column: 'todo' })).toBe(true);
    expect(showsMove(v, { id: 'a', column: 'qa' })).toBe(false);
  });
});
