/**
 * #147: the command palette (⌘/Ctrl+P) as data, pure: the commands for the scopes you are in, the floors with their
 * worker counts, and the order and filter of both. The window (ui/palette.ts) draws it; the game (app.ts) runs it.
 *
 * Commands come from the shortcut table (`palette` on a binding), so a name and a key cannot drift from what the key
 * does; a few rows with no key of their own (`PALETTE_ONLY`) follow them. A query ranks the commands (name, then
 * the other words that find it) the way the composer's popup does (`rankByName`: prefix, word start, substring).
 *
 * Floors (`@` first): the ones with someone who needs you, then every other, each group by "Building › floor" without
 * regard to case. A query only filters: it never reorders. The order is fixed when the list opens or the query changes
 * (`floorList`); the counts of its rows are read live (`floorRow`), so a count moves and the row stays put (the rule of
 * the floor overview, world/overview.ts).
 */

import { BINDINGS, PALETTE_ONLY, bindingCaps, isMac, scopesOf, type ActionId, type Binding, type PaletteOnlyId, type Scope } from '../input/shortcuts';
import { inboxWhere } from './inbox';
import { rankByName } from './rank';
import type { Counts, FloorView, WorldStore } from './store';

// ---- commands -----------------------------------------------------------------------------------------

export type PaletteCommandId = ActionId | PaletteOnlyId;

export interface PaletteCommand {
  id: PaletteCommandId;
  name: string;
  aliases: readonly string[];
  /** The key as the `?` dialog draws it (one alternative); none for a row with no key. */
  caps: readonly string[];
  /** It acts on a floor: off an office floor, Enter asks which one first. */
  floor: boolean;
  /** What the floor list asks then. */
  pick: string;
}

/** The order of the empty palette: what you reach for first, then the rest. Every palette row of the table is here (a test says so). */
export const COMMAND_ORDER: readonly PaletteCommandId[] = [
  'hire',
  'issues',
  'prs',
  'run',
  'overview',
  'overview.all',
  'elevator',
  'buildings',
  'inbox',
  'next-need',
  'dictate',
  'plan',
  'leave',
  'look.level',
  'settings',
  'limits',
  'battery',
  'help',
  'presets',
  'about',
];

/** The commands of the scopes you are in (`active`: the game's live scopes), in `COMMAND_ORDER`. */
export function paletteCommands(active: ReadonlySet<Scope>, mac = isMac()): PaletteCommand[] {
  const out: PaletteCommand[] = [];
  for (const b of BINDINGS as readonly Binding[]) {
    const p = b.palette;
    if (!p) continue;
    if (p.where === undefined && !scopesOf(b).some((s) => active.has(s))) continue;
    const caps = bindingCaps(b, mac)[0] ?? [];
    out.push({ id: b.id as PaletteCommandId, name: p.name, aliases: p.aliases ?? [], caps, floor: p.where === 'floor', pick: p.pick ?? `${p.name} on which floor?` });
  }
  for (const o of PALETTE_ONLY) out.push({ id: o.id, name: o.name, aliases: o.aliases, caps: [], floor: false, pick: `${o.name} on which floor?` });
  const at = (c: PaletteCommand) => COMMAND_ORDER.indexOf(c.id);
  return out.sort((a, b) => at(a) - at(b));
}

/** Does a command need a floor you are not on: Enter shows the floor list first. */
export const needsFloorPick = (c: PaletteCommand, here: string | null): boolean => c.floor && here === null;

export interface CommandMatch {
  command: PaletteCommand;
  /** The offsets of the name's matched characters (none for an empty query or a match on an alias). */
  hits: number[];
}

/**
 * The commands that match, best first: the name's prefix, word start, then substring, before the aliases' in the same
 * tiers; within a tier the order of the list. An empty query keeps them all.
 */
export function filterCommands(commands: readonly PaletteCommand[], query: string): CommandMatch[] {
  const q = query.trim();
  if (q === '') return commands.map((command) => ({ command, hits: [] }));
  type Entry = { command: PaletteCommand; text: string; alias: boolean };
  const entries: Entry[] = commands.flatMap((command) => [{ command, text: command.name, alias: false }, ...command.aliases.map((text) => ({ command, text, alias: true }))]);
  const out: CommandMatch[] = [];
  const seen = new Set<PaletteCommand>();
  for (const r of rankByName(entries, q, (e) => e.text)) {
    if (seen.has(r.item.command)) continue;
    seen.add(r.item.command);
    out.push({ command: r.item.command, hits: r.item.alias ? [] : r.hits });
  }
  return out;
}

// ---- modes --------------------------------------------------------------------------------------------

export interface PaletteQuery {
  mode: 'commands' | 'floors';
  /** What is searched for: the text, or what follows the `@`. */
  query: string;
}

/** A leading `@` lists floors; take it away and it is commands again. */
export function parseQuery(text: string): PaletteQuery {
  return text.startsWith('@') ? { mode: 'floors', query: text.slice(1).trim() } : { mode: 'commands', query: text.trim() };
}

// ---- floors -------------------------------------------------------------------------------------------

/** What `floorList` and `floorRow` read of the store. */
export type FloorSource = Pick<WorldStore, 'city' | 'floorView' | 'buildings' | 'floors'>;

/** A floor as the list fixed it: where it sits in the order is not read again until the list is built again. */
export interface FloorItem {
  session: string;
  /** "Building › floor" when it was listed. */
  label: string;
  /** The characters of `label` the query matched. */
  hits: number[];
}

/** A floor row as it is now. */
export interface FloorRow {
  session: string;
  label: string;
  counts: Counts;
  asleep: boolean;
  /** A floor that is waking up or going to sleep. */
  transition: FloorView['transition'];
  /** It is the floor you are on. */
  here: boolean;
  hits: number[];
}

const byLabel = (a: { label: string; session: string }, b: { label: string; session: string }): number => a.label.toLowerCase().localeCompare(b.label.toLowerCase()) || (a.session < b.session ? -1 : a.session > b.session ? 1 : 0);

/**
 * Every floor of the city whose "Building › floor" holds `query`, in the order the list keeps until it is built again:
 * the floors with someone who needs you, then the rest, each by name. The query filters and never reorders.
 */
export function floorList(store: FloorSource, query: string): FloorItem[] {
  const all = store.city().flatMap((b) => b.floors);
  const items = all.map((f) => ({ session: f.session, label: inboxWhere(store, f.session), needs: f.counts.needsYou > 0 }));
  items.sort((a, b) => +b.needs - +a.needs || byLabel(a, b));
  const q = query.trim();
  if (q === '') return items.map(({ session, label }) => ({ session, label, hits: [] }));
  // `rankByName` orders by match tier; the list's order is the rule, so it only says who matches and where.
  const hit = new Map(rankByName(items, q, (i) => i.label).map((r) => [r.item.session, r.hits]));
  return items.filter((i) => hit.has(i.session)).map(({ session, label }) => ({ session, label, hits: hit.get(session) as number[] }));
}

/** The row of a listed floor with its counts as they are now; null when the floor is gone. */
export function floorRow(store: FloorSource, item: FloorItem, here: string | null): FloorRow | null {
  const f = store.floorView(item.session);
  if (!f) return null;
  const label = inboxWhere(store, item.session);
  return { session: item.session, label, counts: f.counts, asleep: f.asleep, transition: f.transition, here: item.session === here, hits: label === item.label ? item.hits : [] };
}

/** How many floors have someone who needs you: the hint under an empty palette. */
export function floorsNeedingYou(store: Pick<WorldStore, 'city'>): number {
  return store.city().reduce((n, b) => n + b.floors.filter((f) => f.counts.needsYou > 0).length, 0);
}
