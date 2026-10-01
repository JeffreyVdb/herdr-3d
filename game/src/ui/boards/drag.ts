/**
 * #52: the arithmetic of dragging an issue card between the board's columns. Pure; vitest covers it, the DOM side is
 * `cardDrag.ts`. A slot is a column and an index among that column's cards **without the dragged one**: index 0 is the
 * top, `cards.length` the end. The pointer picks the slot by each card's midpoint: over a card's top half the slot is
 * before it, over its bottom half after it.
 */

import type { ColumnView } from '../../world/boards';

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface DropColumn {
  id: string;
  rect: Rect;
  /** In column order; the dragged card may be among them (it is left out). */
  cards: ReadonlyArray<{ id: string; rect: Rect }>;
  /** false: cards can leave this column but not land in it ("No status"). */
  accepts?: boolean;
}

export interface Slot {
  column: string;
  index: number;
}

/** The slot under the pointer; null when it is over no column that takes cards. */
export function slotAt(p: { x: number; y: number }, columns: readonly DropColumn[], draggedId: string): Slot | null {
  const col = columns.find((c) => p.x >= c.rect.left && p.x <= c.rect.right && p.y >= c.rect.top && p.y <= c.rect.bottom);
  if (!col || col.accepts === false) return null;
  let index = 0;
  for (const c of col.cards) {
    if (c.id === draggedId) continue;
    if (p.y < (c.rect.top + c.rect.bottom) / 2) break;
    index++;
  }
  return { column: col.id, index };
}

/** The card the slot comes right after (`issue.set_status`'s `after`): null is the top of the column. */
export function afterFor(cards: readonly string[], index: number, draggedId: string): string | null {
  const rest = cards.filter((id) => id !== draggedId);
  return index <= 0 ? null : (rest[Math.min(index, rest.length) - 1] ?? null);
}

/** Whether dropping in `slot` leaves the card where it is (nothing to send). `from` is its column's cards, in order. */
export function samePlace(fromColumn: string, from: readonly string[], draggedId: string, slot: Slot): boolean {
  if (slot.column !== fromColumn) return false;
  const at = from.indexOf(draggedId);
  return at >= 0 && slot.index === at;
}

/** How far to scroll this frame when the pointer is within `edge` px of a side of [min, max] (negative: back). */
export function edgeSpeed(at: number, min: number, max: number, edge = 56, top = 18): number {
  if (max - min < edge * 2) edge = (max - min) / 3;
  if (at < min + edge) return -Math.ceil(top * Math.min(1, (min + edge - at) / edge));
  if (at > max - edge) return Math.ceil(top * Math.min(1, (at - (max - edge)) / edge));
  return 0;
}

/** A move the game made and the bridge has not confirmed yet: `after` undefined is a status-only move. */
export interface PendingMove {
  id: string;
  column: string;
  after?: string | null;
}

/**
 * The columns with pending moves applied: each card in its new column, right after its `after` (null: on top; an
 * `after` that is not in that column: on top as well). A status-only move leaves the card where the column's own sort
 * puts it, so `views` must already have the card's column changed (see `withColumns`).
 */
export function placeMoves(views: readonly ColumnView[], moves: readonly PendingMove[]): ColumnView[] {
  const out = views.map((v) => ({ ...v, cards: [...v.cards] }));
  for (const m of moves) {
    if (m.after === undefined) continue;
    let card = null;
    for (const v of out) {
      const i = v.cards.findIndex((c) => c.id === m.id);
      if (i >= 0) [card] = v.cards.splice(i, 1);
    }
    const to = out.find((v) => v.id === m.column);
    if (!card || !to) continue;
    const at = m.after === null ? -1 : to.cards.findIndex((c) => c.id === m.after);
    to.cards.splice(at + 1, 0, card);
  }
  return out;
}

/** Whether a board shows a move as made: the card in its column and, for a placed move, right after its anchor. */
export function showsMove(views: readonly ColumnView[], m: PendingMove): boolean {
  const col = views.find((v) => v.cards.some((c) => c.id === m.id));
  if (!col || col.id !== m.column) return false;
  if (m.after === undefined) return true;
  const i = col.cards.findIndex((c) => c.id === m.id);
  return m.after === null ? i === 0 : col.cards[i - 1]?.id === m.after;
}
