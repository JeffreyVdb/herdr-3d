/**
 * #139 / #147: what the game's two listboxes share, the composer's completion popup (focus stays in a contenteditable)
 * and the command palette (focus stays in a plain `<input>`): the keys that move through the rows and the active row's
 * scroll. Both are `aria-activedescendant` lists: the rows are never focused, the field keeps the keyboard.
 *
 * Keys: ↑ ↓ move the active row and wrap around; Tab and Enter pick it; Esc closes. A key with Ctrl, ⌘, Alt or Shift is
 * not a list key. With no row to pick (none, or only the dimmed rows of an older query) the arrows and Tab are the
 * field's, and Enter is `enter-empty`: the list decides (the popup closes, the palette keeps waiting for a match).
 */

export type ListKey = 'next' | 'prev' | 'pick' | 'enter-empty' | 'close';

export interface ListState {
  /** There are rows to move through (loaded, not dimmed). */
  rows: boolean;
  /** One of them is active and can be picked. */
  can: boolean;
  /** Tab picks too (the popup: yes; the palette leaves Tab to the field's own focus order). */
  tab?: boolean;
}

/** What a keydown means to an open list, or null when the key is the field's. */
export function listKey(e: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>, s: ListState): ListKey | null {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') return s.rows ? (e.key === 'ArrowDown' ? 'next' : 'prev') : null;
  if (e.key === 'Tab') return s.tab && s.can ? 'pick' : null;
  if (e.key === 'Enter') return s.can ? 'pick' : 'enter-empty';
  if (e.key === 'Escape') return 'close';
  return null;
}

/** The row after moving `by` from `active` among `n`, wrapping; -1 when there is none. */
export function wrapIndex(active: number, n: number, by: number): number {
  if (n <= 0) return -1;
  return (((active < 0 ? (by > 0 ? -1 : 0) : active) + by) % n + n) % n;
}

/** Scrolls `list` the least that shows `row` whole. */
export function revealRow(list: HTMLElement, row: HTMLElement): void {
  if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
  else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
}

/** Marks `active` the selected row (`aria-selected`) and scrolls it into view; returns its element, if there is one. */
export function paintActiveRow(list: HTMLElement, active: number): HTMLElement | null {
  const rows = list.children;
  for (let i = 0; i < rows.length; i++) rows[i]?.setAttribute('aria-selected', String(i === active));
  const row = rows[active] as HTMLElement | undefined;
  if (!row) return null;
  revealRow(list, row);
  return row;
}
