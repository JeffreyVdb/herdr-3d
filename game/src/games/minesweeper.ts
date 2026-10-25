/** Beginner Minesweeper, with a safe opening and no mines placed until the first reveal. */
export const SIDE = 9;
export const MINES = 10;
export interface Cell { mine: boolean; nearby: number; revealed: boolean; flagged: boolean }
export interface Minesweeper { cells: Cell[]; status: 'ready' | 'playing' | 'won' | 'lost'; exploded: number | null }

export function newMinesweeper(): Minesweeper {
  return { cells: Array.from({ length: SIDE * SIDE }, () => ({ mine: false, nearby: 0, revealed: false, flagged: false })), status: 'ready', exploded: null };
}

export function neighbors(index: number): number[] {
  const row = Math.floor(index / SIDE), col = index % SIDE;
  const out: number[] = [];
  for (let y = Math.max(0, row - 1); y <= Math.min(SIDE - 1, row + 1); y++) {
    for (let x = Math.max(0, col - 1); x <= Math.min(SIDE - 1, col + 1); x++) {
      const n = y * SIDE + x;
      if (n !== index) out.push(n);
    }
  }
  return out;
}

export function flagCell(state: Minesweeper, index: number): Minesweeper {
  const cell = state.cells[index];
  if (!cell || cell.revealed || state.status === 'won' || state.status === 'lost') return state;
  return { ...state, cells: state.cells.map((c, i) => i === index ? { ...c, flagged: !c.flagged } : c) };
}

export function revealCell(state: Minesweeper, index: number, random = Math.random): Minesweeper {
  const cell = state.cells[index];
  if (!cell || cell.flagged || state.status === 'won' || state.status === 'lost') return state;
  let pending = [index];
  if (cell.revealed) {
    const around = neighbors(index);
    if (!cell.nearby || around.filter((i) => state.cells[i]!.flagged).length !== cell.nearby) return state;
    pending = around.filter((i) => !state.cells[i]!.revealed && !state.cells[i]!.flagged);
    if (!pending.length) return state;
  }
  const next: Minesweeper = { ...state, cells: state.cells.map((c) => ({ ...c })), status: 'playing' };
  if (state.status === 'ready') {
    const safe = new Set([index, ...neighbors(index)]);
    const choices = next.cells.map((_, i) => i).filter((i) => !safe.has(i));
    for (let n = 0; n < MINES; n++) {
      const pick = Math.floor(random() * choices.length);
      next.cells[choices.splice(pick, 1)[0]!]!.mine = true;
    }
    next.cells.forEach((c, i) => { c.nearby = neighbors(i).filter((n) => next.cells[n]!.mine).length; });
  }
  while (pending.length) {
    const i = pending.pop()!;
    const c = next.cells[i]!;
    if (c.flagged || c.revealed) continue;
    c.revealed = true;
    if (c.mine) {
      next.status = 'lost';
      next.exploded = i;
      return next;
    }
    if (c.nearby === 0) pending.push(...neighbors(i));
  }
  if (next.cells.every((c) => c.mine || c.revealed)) next.status = 'won';
  return next;
}
