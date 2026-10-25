import { describe, expect, it } from 'vitest';
import { flagCell, MINES, neighbors, newMinesweeper, revealCell } from './minesweeper';

function randomBoard() {
  let seed = 42;
  return revealCell(newMinesweeper(), 40, () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296));
}

describe('Minesweeper', () => {
  it('starts empty, then places exactly ten mines outside the first cell’s neighborhood', () => {
    const s = newMinesweeper();
    expect(s.cells.some((c) => c.mine)).toBe(false);
    for (const first of [0, 8, 40, 72, 80]) {
      const next = revealCell(s, first, () => 0.4);
      expect(next.cells.filter((c) => c.mine)).toHaveLength(MINES);
      expect(next.cells[first]).toMatchObject({ revealed: true, nearby: 0, mine: false });
      for (const n of neighbors(first)) expect(next.cells[n]!.mine).toBe(false);
      next.cells.forEach((c, i) => expect(c.nearby).toBe(neighbors(i).filter((n) => next.cells[n]!.mine).length));
    }
    expect(s.status).toBe('ready');
    expect(s.cells.every((c) => !c.revealed)).toBe(true);
  });

  it('flags without starting the game and does not reveal flagged cells', () => {
    const flagged = flagCell(newMinesweeper(), 40);
    expect(flagged.status).toBe('ready');
    expect(revealCell(flagged, 40)).toBe(flagged);
    const next = revealCell(flagged, 41, () => 0);
    expect(next.cells[40]).toMatchObject({ flagged: true, revealed: false });
    expect(flagCell(next, 41)).toBe(next);
    expect(flagCell(next, 40).cells[40]!.flagged).toBe(false);
  });

  it('floods empty areas without wrapping rows', () => {
    expect(neighbors(0)).toEqual([1, 9, 10]);
    expect(neighbors(8)).toEqual([7, 16, 17]);
    const next = revealCell(newMinesweeper(), 80, () => 0);
    expect(next.cells.filter((c) => c.revealed).length).toBeGreaterThan(20);
    expect(next.cells.filter((c) => c.revealed).every((c) => !c.mine)).toBe(true);
  });

  it('ends the game when a mine is revealed, and freezes reveals and flags', () => {
    const s = randomBoard();
    const mine = s.cells.findIndex((c) => c.mine);
    const lost = revealCell(s, mine);
    expect(lost).toMatchObject({ status: 'lost', exploded: mine });
    expect(flagCell(lost, 0)).toBe(lost);
    expect(revealCell(lost, 0)).toBe(lost);
  });

  it('wins by revealing every safe square, without requiring flags', () => {
    let s = randomBoard();
    for (let i = 0; i < s.cells.length; i++) if (!s.cells[i]!.mine) s = revealCell(s, i);
    expect(s.status).toBe('won');
    expect(s.cells.filter((c) => c.revealed)).toHaveLength(71);
    expect(flagCell(s, 0)).toBe(s);
  });

  it('chords a number only when its flags match, and wrong flags can lose', () => {
    const start = randomBoard();
    const number = start.cells.findIndex((c, i) => c.revealed && c.nearby > 0 && neighbors(i).some((n) => !start.cells[n]!.revealed && !start.cells[n]!.mine));
    expect(number).toBeGreaterThanOrEqual(0);
    expect(revealCell(start, number)).toBe(start);
    const around = neighbors(number);
    let flagged = start;
    for (const i of around) if (start.cells[i]!.mine) flagged = flagCell(flagged, i);
    const cleared = revealCell(flagged, number);
    expect(around.every((i) => cleared.cells[i]!.flagged || cleared.cells[i]!.revealed)).toBe(true);
    expect(cleared.status).not.toBe('lost');
    const actual = around.find((i) => start.cells[i]!.mine)!;
    const wrong = around.find((i) => !start.cells[i]!.mine && !start.cells[i]!.revealed)!;
    const incorrect = flagCell(flagCell(flagged, actual), wrong);
    expect(revealCell(incorrect, number).status).toBe('lost');
  });
});
