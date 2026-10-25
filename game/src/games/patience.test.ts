import { describe, expect, it } from 'vitest';
import { drawCard, moveCards, newPatience, patienceWon, sourceCards, type Patience } from './patience';

const blank = (): Patience => ({ stock: [], waste: [], foundations: [[], [], [], []], columns: Array.from({ length: 7 }, () => []), moves: 0 });
const up = (card: number) => ({ card, up: true });

describe('draw-one Patience', () => {
  it('deals every card exactly once, with only each column’s top card turned up', () => {
    const s = newPatience(() => 0.5);
    expect(s.stock).toHaveLength(24);
    expect(s.columns.map((p) => p.length)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(s.columns.map((p) => p.filter((c) => c.up).length)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(new Set([...s.stock, ...s.columns.flat().map((c) => c.card)]).size).toBe(52);
  });

  it('draws one and recycles the waste in the original draw order without changing earlier states', () => {
    const start = { ...blank(), stock: [0, 1, 2] };
    let s = start;
    for (let i = 0; i < 3; i++) s = drawCard(s);
    expect(s.waste).toEqual([2, 1, 0]);
    s = drawCard(s);
    expect(s.stock).toEqual([0, 1, 2]);
    expect(s.waste).toEqual([]);
    expect(drawCard(s).waste).toEqual([2]);
    expect(start.stock).toEqual([0, 1, 2]);
    expect(start.moves).toBe(0);
  });

  it('moves an alternating descending stack and turns up the newly exposed card', () => {
    const s = blank();
    s.columns[0] = [{ card: 5, up: false }, up(11), up(23)]; // black Q, red J
    s.columns[1] = [up(25)]; // red K
    const next = moveCards(s, { pile: 'column', column: 0, index: 1 }, { pile: 'column', column: 1 });
    expect(next.columns[0]).toEqual([up(5)]);
    expect(next.columns[1]).toEqual([up(25), up(11), up(23)]);
    expect(next.moves).toBe(1);
    expect(s.columns[0]![0]!.up).toBe(false);
  });

  it('rejects face-down cards, broken stacks, same-color moves and non-Kings in empty columns', () => {
    const s = blank();
    s.waste = [11];
    s.columns[0] = [up(12)];
    s.columns[1] = [{ card: 25, up: false }];
    s.columns[2] = [up(25), up(10)];
    expect(moveCards(s, { pile: 'waste' }, { pile: 'column', column: 0 })).toBe(s);
    expect(moveCards(s, { pile: 'waste' }, { pile: 'column', column: 3 })).toBe(s);
    expect(sourceCards(s, { pile: 'column', column: 1, index: 0 })).toEqual([]);
    expect(sourceCards(s, { pile: 'column', column: 2, index: 0 })).toEqual([]);
    expect(moveCards(s, { pile: 'column', column: 0, index: 0 }, { pile: 'column', column: 3 }).columns[3]).toEqual([up(12)]);
  });

  it('builds foundations Ace to King in suit and permits moving a top foundation card back', () => {
    const s = { ...blank(), waste: [0, 13] };
    expect(moveCards(s, { pile: 'waste' }, { pile: 'foundation', column: 0 })).toBe(s);
    let next = moveCards(s, { pile: 'waste' }, { pile: 'foundation', column: 1 });
    expect(next.foundations[1]).toEqual([13]);
    next = moveCards(next, { pile: 'waste' }, { pile: 'foundation', column: 0 });
    next.columns[0] = [up(14)];
    next = moveCards(next, { pile: 'foundation', column: 0 }, { pile: 'column', column: 0 });
    expect(next.foundations[0]).toEqual([]);
    expect(next.columns[0]).toEqual([up(14), up(0)]);
  });

  it('only accepts a single exposed card on a foundation and recognizes a completed game', () => {
    const s = blank();
    s.columns[0] = [up(1), up(13)];
    expect(moveCards(s, { pile: 'column', column: 0, index: 0 }, { pile: 'foundation', column: 0 })).toBe(s);
    s.foundations = Array.from({ length: 4 }, (_, suit) => Array.from({ length: suit === 3 ? 12 : 13 }, (_, rank) => suit * 13 + rank));
    s.waste = [51];
    expect(patienceWon(s)).toBe(false);
    const won = moveCards(s, { pile: 'waste' }, { pile: 'foundation', column: 3 });
    expect(patienceWon(won)).toBe(true);
    expect(drawCard(won)).toBe(won);
  });
});
