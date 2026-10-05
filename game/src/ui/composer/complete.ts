/**
 * #139: completion in the composer, pure: which token the caret is in, and what a completion source looks like. No DOM
 * (the popup and its keys are `completion.ts`).
 *
 * A token starts with a trigger character (`/` or `@`) that stands at the start of the text, after whitespace
 * (a space, a tab, a newline) or right after a chip (an image or a file: a chip is a word of its own), so `/usr/bin`, `a/b`, URLs
 * and emails never open one. The query is the text from after the trigger to the caret:
 * - `/` (commands): no whitespace; the token ends at the first space, newline or chip.
 * - `@` (files): may contain spaces (file names have them), but not a newline or a chip, and at most `AT_QUERY_MAX`
 *   characters, so it cannot swallow a paragraph.
 * Looking back from the caret, the nearest trigger decides: one that is mid-word (`me@x`) means no token, it does not
 * reach back to an earlier one. A token's range runs from its trigger to the end of the word the caret is in (the
 * characters after the caret up to whitespace or a chip), so a pick with the caret inside `/he|lp` replaces all of it.
 * A selection that is not collapsed has no token.
 */

import { type FileRef, IMG, type Selection } from './model';

export type Trigger = '/' | '@';

export interface Token {
  trigger: Trigger;
  /** The offset of the trigger character. */
  start: number;
  /** The end of the token's word (after the caret when the caret is inside it). */
  end: number;
  /** From after the trigger to the caret. */
  query: string;
}

/** The longest `@` query: past it the `@` is just a character (an email address someone is typing a sentence after). */
export const AT_QUERY_MAX = 80;

export type Items<T> = readonly T[];

/**
 * What a pick puts into the draft: `text` replaces `[start, end)`, by default the token's own range (the trigger and
 * its word). The caret lands after `text`. One `Draft.replace`, so one undo takes the pick back.
 *
 * #141: with `chip`, an atomic file chip goes in first and `text` after it (the space after a picked file), still one
 * edit (`Draft.insertParts`), the caret after both.
 */
export interface ReplaceSpec {
  text: string;
  chip?: FileRef;
  start?: number;
  end?: number;
}

/**
 * Where completion items come from, one per trigger. `items` may answer at once (commands, filtered locally) or with a
 * promise (files from the bridge): the composer aborts `signal` when the query changes or the popup closes, and drops
 * a reply that is no longer the latest.
 *
 * #140: a source whose items live elsewhere (a list the bridge sends, cached) may also say whether it has anything
 * here at all (`available`), hear that a session is opening (`opening`, to refresh what it knows), say that its items
 * changed (`subscribe`: an open session asks its query again and keeps the active row by `key`) and add a note under
 * the rows (`footer`).
 */
export interface Source<T = unknown> {
  trigger: Trigger;
  /** The listbox's accessible name (default "Suggestions"). */
  label?: string;
  items(query: string, signal: AbortSignal): Items<T> | Promise<Items<T>>;
  /** One row's content. */
  render(item: T): Node | string;
  /** What a pick puts in; `text` is the draft's text. */
  insert(item: T, token: Token, text: string): ReplaceSpec;
  /** False: the trigger opens no popup (and an open one closes when the source says it changed). Default true. */
  available?(): boolean;
  /** Text was typed into a token of this trigger and no session of it is open: one may open (even when unavailable). */
  opening?(): void;
  /** `changed` is called when the items (or the availability, or the footer) changed; returns the unsubscribe. */
  subscribe?(changed: () => void): () => void;
  /** An item's identity across changes (default: none, the first row is active again). */
  key?(item: T): string;
  /** A short note under the rows (null or '': none), read on every draw. */
  footer?(): string | null;
}

const isSpace = (c: string): boolean => /\s/.test(c);
/** Before a trigger: the start of the text, whitespace or a chip. */
const boundary = (text: string, i: number): boolean => i === 0 || isSpace(text[i - 1] as string) || text[i - 1] === IMG;

/** The token of `trigger` the caret at `c` is in, or null. */
function tokenOf(text: string, c: number, trigger: Trigger): Token | null {
  const spaces = trigger === '@';
  for (let i = c - 1; i >= 0; i--) {
    const ch = text[i] as string;
    if (ch === IMG || ch === '\n') return null;
    if (isSpace(ch) && !spaces) return null;
    if (spaces && c - i - 1 > AT_QUERY_MAX) return null;
    if (ch !== trigger) continue;
    if (!boundary(text, i)) return null;
    let end = c;
    while (end < text.length && !isSpace(text[end] as string) && text[end] !== IMG) end++;
    return { trigger, start: i, end, query: text.slice(i + 1, c) };
  }
  return null;
}

/** The token the caret is in, for the triggers that have a source; the nearest one when two would match. */
export function findToken(text: string, sel: Selection, triggers: readonly Trigger[]): Token | null {
  if (sel.anchor !== sel.focus) return null;
  const c = sel.focus;
  if (c < 0 || c > text.length) return null;
  let best: Token | null = null;
  for (const t of triggers) {
    const tok = tokenOf(text, c, t);
    if (tok && (!best || tok.start > best.start)) best = tok;
  }
  return best;
}

/** The range and text a pick replaces: the source's own range or the token's, clamped to `[0, length]` and in order. */
export function replaceRangeOf(spec: ReplaceSpec, token: Token, length: number): [number, number, string] {
  const c = (n: number) => Math.max(0, Math.min(length, n));
  const a = c(spec.start ?? token.start);
  const b = c(spec.end ?? token.end);
  return a <= b ? [a, b, spec.text] : [b, a, spec.text];
}
