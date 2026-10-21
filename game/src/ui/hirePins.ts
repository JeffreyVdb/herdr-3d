/**
 * Hire presets pinned to the desk dialogs' tab bar, in the player's order, remembered per browser (like
 * `hireModelPrefs.ts`). A pin is a preset id: a floor's own preset shows only on that floor, and a deleted one is
 * skipped until it is unpinned. Guarded the same way: storage can be missing, throw or hold something malformed, and
 * then nothing is pinned.
 */

import type { HireOptions } from '../net/protocol';
import { bridgeKey } from '../net/bridgeScope';
import { presetChoiceText, type HirePresetBook } from '../world/hirePresets';
import type { DeskPins } from './deskTabs';

const KEY = 'h3d.hire.pinnedPresets';

/** The stored value read back: the string ids of a list, once each, in order; anything else pins nothing. */
export function parsePins(raw: string | null): string[] {
  if (!raw) return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((s): s is string => typeof s === 'string' && s !== ''))];
}

/** The presets of `offered` (a floor's) that are pinned, in pin order. */
export function pinnedOn<T extends { id: string }>(ids: readonly string[], offered: readonly T[]): T[] {
  const byId = new Map(offered.map((p) => [p.id, p]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/**
 * The tab bar's pins on `floor`: the floor's own presets and the global ones that are pinned, in pin order, each named
 * with its choice as the tooltip, and moved among themselves. Undefined without pins or on a bridge without presets.
 */
export function deskPins(pins: HirePins | undefined, book: HirePresetBook | undefined, catalog: HireOptions, floor: string): DeskPins | undefined {
  if (!pins || !book?.known) return undefined;
  const { floor: own, global } = book.forFloor(floor);
  const shown = pinnedOn(pins.ids, [...own, ...global]);
  const ids = shown.map((p) => p.id);
  return {
    list: shown.map((p) => ({ id: p.id, name: p.name, title: `Hire with “${p.name}”: ${presetChoiceText(catalog, p)}${p.floor ? ' (this floor)' : ''}\nDrag, or Shift+← / Shift+→, to move it` })),
    move: (id, to) => pins.move(id, to, ids),
  };
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export class HirePins {
  private readonly listeners = new Set<() => void>();
  private ids_: string[];
  private rev = 0;

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = defaultStorage()) {
    let raw: string | null = null;
    try {
      raw = this.storage?.getItem(bridgeKey(KEY)) ?? null;
    } catch {
      raw = null;
    }
    this.ids_ = parsePins(raw);
  }

  /** Bumped on every change: a tab bar drawn before it is out of date. */
  get version(): number {
    return this.rev;
  }

  /** Every pinned id, in the tab bar's order (shown on this floor or not). */
  get ids(): readonly string[] {
    return this.ids_;
  }

  has(id: string): boolean {
    return this.ids_.includes(id);
  }

  /** Pins `id` at the end of the tab bar (already pinned: stays where it is). */
  pin(id: string): void {
    if (!this.has(id)) this.write([...this.ids_, id]);
  }

  unpin(id: string): void {
    if (this.has(id)) this.write(this.ids_.filter((x) => x !== id));
  }

  /**
   * Moves `id` to place `to` among `shown`, the pins one tab bar shows (a drop, or one place left or right): the shown
   * pins take their new order in the places they had, so pins hidden on that floor keep theirs. Nothing past either end.
   */
  move(id: string, to: number, shown: readonly string[]): void {
    const from = shown.indexOf(id);
    if (from < 0 || to < 0 || to >= shown.length || to === from || !shown.every((x) => this.has(x))) return;
    const order = shown.filter((x) => x !== id);
    order.splice(to, 0, id);
    const slots = new Set(shown);
    let k = 0;
    this.write(this.ids_.map((x) => (slots.has(x) ? (order[k++] as string) : x)));
  }

  /** Called when the pins change (an open dialog redraws its tab bar). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private write(next: string[]): void {
    this.ids_ = next;
    this.rev++;
    try {
      if (next.length) this.storage?.setItem(bridgeKey(KEY), JSON.stringify(next));
      else this.storage?.removeItem(bridgeKey(KEY));
    } catch {
      /* not remembered past this page */
    }
    for (const fn of this.listeners) fn();
  }
}
