/**
 * The prompt composer's document, pure: no DOM, no uploads.
 *
 * A document is one string in which every chip is a single U+FFFC ("object replacement") character, plus the chips
 * (occurrences) in that order. A caret or a selection is then just an offset into the string, ranges are one `slice`,
 * and "the image between these two words" or "two chips side by side" need no special cases. The invariant is
 * `count(U+FFFC in text) === chips.length`; text typed or pasted is cleaned of U+FFFC (and of U+200B, which the view
 * uses to give a caret a place between chips) at the boundary so it can never break it.
 *
 * A chip is an image or (#141) a file of the worker's checkout. An image occurrence is one chip in the editor (`occ`);
 * it points at the uploaded thing (`res`, a resource of the draft). The two are different so an image can appear twice
 * (undo, later a duplicate) with one upload, while every chip stays editable on its own. Numbers ("Image #2") are never
 * stored: they are the image occurrences' order in the document (a file chip between two images does not count). A
 * file chip carries its path itself: it has nothing to upload, and serialises to an `@path` mention.
 */

/** Stands for one chip (an image or a file) in `Doc.text`. */
export const IMG = '\uFFFC';
/** Gives an empty text run a node to hold a caret in the view; never part of the document. */
export const ZWSP = '\u200B';

/** An image chip. `kind` is left out by most of the code that makes one: an occurrence without it is an image. */
export interface ImageOccurrence {
  readonly kind?: 'image';
  readonly occ: string;
  readonly res: string;
}

/** #141: a file (or folder) of the worker's checkout: its path relative to it, '/'-separated, no trailing '/'. */
export interface FileOccurrence {
  readonly kind: 'file';
  readonly occ: string;
  readonly path: string;
  readonly dir: boolean;
}

export type Occurrence = ImageOccurrence | FileOccurrence;

/** A file chip's content, before it has an occurrence id (what a pick, a paste or a stored draft puts in). */
export interface FileRef {
  readonly kind: 'file';
  readonly path: string;
  readonly dir: boolean;
}

export const isFileOcc = (o: Occurrence): o is FileOccurrence => o.kind === 'file';
export const isImageOcc = (o: Occurrence): o is ImageOccurrence => o.kind !== 'file';

export interface Doc {
  readonly text: string;
  readonly chips: readonly Occurrence[];
}

export const EMPTY_DOC: Doc = { text: '', chips: [] };

/** A caret is `anchor === focus`; a backward selection has `focus < anchor`. Offsets into `Doc.text`. */
export interface Selection {
  readonly anchor: number;
  readonly focus: number;
}

export const caret = (at: number): Selection => ({ anchor: at, focus: at });
export const rangeOf = (s: Selection): [number, number] => (s.anchor <= s.focus ? [s.anchor, s.focus] : [s.focus, s.anchor]);
export const clampSel = (s: Selection, doc: Doc): Selection => {
  const c = (n: number) => Math.max(0, Math.min(doc.text.length, n));
  return { anchor: c(s.anchor), focus: c(s.focus) };
};

/** CRLF and lone CR become LF; U+FFFC and U+200B are dropped. Applied to everything that enters the document as text. */
export function cleanText(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(/[\uFFFC\u200B]/g, '');
}

/** How many chips `text` holds between two offsets. */
export function chipsIn(text: string, from = 0, to = text.length): number {
  let n = 0;
  for (let i = text.indexOf(IMG, from); i >= 0 && i < to; i = text.indexOf(IMG, i + 1)) n++;
  return n;
}

/** How many of the chips between two offsets are images (the image limit counts only these). */
export function imagesIn(doc: Doc, from = 0, to = doc.text.length): number {
  const first = chipsIn(doc.text, 0, from);
  return doc.chips.slice(first, first + chipsIn(doc.text, from, to)).filter(isImageOcc).length;
}

/** The image chips of a document, in order. */
export const imagesOf = (doc: Doc): ImageOccurrence[] => doc.chips.filter(isImageOcc);

/** Text with each chip removed: what a plain-text view of the draft would show. */
export const plainText = (doc: Doc): string => doc.text.split(IMG).join('');

export const isEmptyDoc = (doc: Doc): boolean => doc.text === '';

/**
 * Replaces `[start, end)` with `insert` (cleaned) followed by `add` (new chips), removing the chips that were inside
 * the range. Offsets are clamped and put in order. One call is one edit: one history entry.
 */
export function replaceRange(doc: Doc, start: number, end: number, insert = '', add: readonly Occurrence[] = []): Doc {
  return replaceParts(doc, start, end, [insert, ...add]);
}

/** What one edit puts in, in order: text (cleaned on the way in) and chips. */
export type Part = string | Occurrence;

/**
 * Replaces `[start, end)` with `parts` in their order (text and chips mixed: a chip followed by a space, a pasted run
 * of text and file chips), removing the chips that were inside the range. One call is one edit.
 */
export function replaceParts(doc: Doc, start: number, end: number, parts: readonly Part[]): Doc {
  let a = Math.max(0, Math.min(doc.text.length, start));
  let b = Math.max(0, Math.min(doc.text.length, end));
  if (a > b) [a, b] = [b, a];
  const before = chipsIn(doc.text, 0, a);
  const inside = chipsIn(doc.text, a, b);
  let mid = '';
  const add: Occurrence[] = [];
  for (const p of parts) {
    if (typeof p === 'string') mid += cleanText(p);
    else {
      mid += IMG;
      add.push(p);
    }
  }
  const text = doc.text.slice(0, a) + mid + doc.text.slice(b);
  const chips = [...doc.chips.slice(0, before), ...add, ...doc.chips.slice(before + inside)];
  return { text, chips };
}

/** How long `parts` are in the document (where the caret goes after them). */
export const partsLength = (parts: readonly Part[]): number => parts.reduce((n, p) => n + (typeof p === 'string' ? cleanText(p).length : 1), 0);

/** Where the caret goes after `replaceRange(doc, start, end, insert, add)`: after everything inserted. */
export function caretAfter(start: number, end: number, insert: string, add: readonly Occurrence[]): number {
  return Math.min(start, end) + cleanText(insert).length + add.length;
}

/** The offset of chip `index` (its U+FFFC), or -1. */
export function offsetOfChip(doc: Doc, index: number): number {
  let at = -1;
  for (let k = 0; k <= index; k++) {
    at = doc.text.indexOf(IMG, at + 1);
    if (at < 0) return -1;
  }
  return at;
}

/** The index of the chip `occ` among all chips, or -1. */
export const indexOfOcc = (doc: Doc, occ: string): number => doc.chips.findIndex((o) => o.occ === occ);

/** The chip at offset `at` (a U+FFFC there), or null. */
export function chipAt(doc: Doc, at: number): Occurrence | null {
  if (doc.text[at] !== IMG) return null;
  return doc.chips[chipsIn(doc.text, 0, at)] ?? null;
}

/** Removes chip `index`; the text on both sides stays as it is (they join). */
export function removeChip(doc: Doc, index: number): Doc {
  const at = offsetOfChip(doc, index);
  return at < 0 ? doc : replaceRange(doc, at, at + 1);
}

/** Moves chip `index` to offset `to` (in the document as it is now); a reorder along with the text around it. */
export function moveChip(doc: Doc, index: number, to: number): Doc {
  const at = offsetOfChip(doc, index);
  const occ = doc.chips[index];
  if (at < 0 || !occ) return doc;
  const gone = replaceRange(doc, at, at + 1);
  const dest = Math.max(0, Math.min(gone.text.length, to > at ? to - 1 : to));
  return replaceRange(gone, dest, dest, '', [occ]);
}

/** The things a document is made of, in order, without empty text runs. */
export type Segment = { kind: 'text'; text: string } | { kind: 'image'; occ: string; res: string } | { kind: 'file'; occ: string; path: string; dir: boolean };

export function segments(doc: Doc): Segment[] {
  const out: Segment[] = [];
  let k = 0;
  for (const part of doc.text.split(IMG)) {
    if (part !== '') out.push({ kind: 'text', text: part });
    const o = doc.chips[k++];
    if (!o) continue;
    out.push(isFileOcc(o) ? { kind: 'file', occ: o.occ, path: o.path, dir: o.dir } : { kind: 'image', occ: o.occ, res: o.res });
  }
  return out;
}

/** The distinct resources a document's images use, in the order they first appear (a file chip has none). */
export function resourcesOf(doc: Doc): string[] {
  return [...new Set(imagesOf(doc).map((o) => o.res))];
}

/** Two chips are the same edit-wise: same occurrence, same kind, same content. */
export function sameChip(a: Occurrence, b: Occurrence): boolean {
  if (a.occ !== b.occ) return false;
  if (isFileOcc(a) || isFileOcc(b)) return isFileOcc(a) && isFileOcc(b) && a.path === b.path && a.dir === b.dir;
  return a.res === b.res;
}

export const sameChips = (a: Doc, b: Doc): boolean => a.chips.length === b.chips.length && a.chips.every((o, i) => sameChip(o, b.chips[i] as Occurrence));

// ---- file mentions (#141) ------------------------------------------------------------------

/**
 * Why a checkout path cannot be a file chip, or null. The bridge reads a mention up to the next whitespace, or a quoted
 * one up to the next `"` (no escaping) and never across a line break: a path with a `"`, a line break or a NUL could
 * not be written so that it reads back whole, so the popup does not offer it and a stored or pasted draft drops it.
 */
export function filePathProblem(path: string): string | null {
  if (path === '') return 'the path is empty';
  if (path.includes('"')) return 'the path contains "';
  if (/[\r\n\0]/.test(path)) return 'the path contains a line break or a NUL';
  return null;
}

/** What the bridge reads as whitespace (Go's `unicode.IsSpace`, a superset of JavaScript's `\s` with U+0085). */
const WS = /[\s\u0085]/;
/** Before a mention the bridge reads, besides whitespace: an opening bracket or quote (its `startsWord`). */
const OPENERS = '([{"\'';

/** A file chip as prompt text: `@path`, or `@"path"` when the path has whitespace in it (#138's rule). */
export const mentionOf = (path: string): string => (WS.test(path) ? `@"${path}"` : `@${path}`);

/** A run of prompt text (an image's marker is text too), or a file chip by its path. */
export type MentionPart = { text: string } | { file: string };

/**
 * Text and file chips as one string: a file chip as its mention, with a space put in before it
 * when the text before it would make it start mid-word (the bridge reads a mention only at a word's start) and after it
 * when text follows without one (`@a.ts,` reads `a.ts,`: the bridge trims prose, but `@a.ts@b.ts` is one token). Those
 * spaces are part of the prompt and count toward its bytes.
 */
export function joinMentions(parts: readonly MentionPart[]): string {
  let out = '';
  let afterFile = false;
  for (const p of parts) {
    if ('file' in p) {
      const last = out.slice(-1);
      if (out !== '' && !WS.test(last) && !OPENERS.includes(last)) out += ' ';
      out += mentionOf(p.file);
      afterFile = true;
      continue;
    }
    const s = p.text;
    if (s === '') continue;
    if (afterFile && !WS.test(s[0] as string)) out += ' ';
    out += s;
    afterFile = false;
  }
  return out;
}

/** A selection's text and file chips as plain text (images left out): what a copy puts on the clipboard as text. */
export function mentionText(doc: Doc, from = 0, to = doc.text.length): string {
  const first = chipsIn(doc.text, 0, from);
  const out: MentionPart[] = [];
  let k = first;
  for (const piece of doc.text.slice(from, to).split(/(\uFFFC)/)) {
    if (piece !== IMG) {
      out.push({ text: piece });
      continue;
    }
    const o = doc.chips[k++];
    if (o && isFileOcc(o)) out.push({ file: o.path });
  }
  return joinMentions(out);
}

/**
 * A draft's text and file chips as plain data, for what keeps or carries it outside the editor: a stored draft (a
 * reload), the clipboard. Images do not travel this way (their bytes and uploads live in the draft): the text on both
 * sides of one joins.
 */
export type SavedPart = { kind: 'text'; text: string } | { kind: 'file'; path: string; dir: boolean };

/** `[from, to)` of a document as saved parts, adjacent text runs joined, no empty run. */
export function savedParts(doc: Doc, from = 0, to = doc.text.length): SavedPart[] {
  const out: SavedPart[] = [];
  const text = (t: string) => {
    if (t === '') return;
    const last = out[out.length - 1];
    if (last?.kind === 'text') out[out.length - 1] = { kind: 'text', text: last.text + t };
    else out.push({ kind: 'text', text: t });
  };
  let k = chipsIn(doc.text, 0, from);
  for (const piece of doc.text.slice(from, to).split(/(\uFFFC)/)) {
    if (piece !== IMG) {
      text(piece);
      continue;
    }
    const o = doc.chips[k++];
    if (o && isFileOcc(o)) out.push({ kind: 'file', path: o.path, dir: o.dir });
  }
  return out;
}

/**
 * Saved parts read back from somewhere untrusted (storage, the clipboard): null when `v` is not a list; a part that is
 * not one (a wrong shape, a path no chip may hold) is left out, the rest kept.
 */
export function readSavedParts(v: unknown): SavedPart[] | null {
  if (!Array.isArray(v)) return null;
  const out: SavedPart[] = [];
  for (const p of v as unknown[]) {
    if (!p || typeof p !== 'object') continue;
    const o = p as Record<string, unknown>;
    if (o.kind === 'text' && typeof o.text === 'string') out.push({ kind: 'text', text: o.text });
    else if (o.kind === 'file' && typeof o.path === 'string' && typeof o.dir === 'boolean' && filePathProblem(o.path) === null) out.push({ kind: 'file', path: o.path, dir: o.dir });
  }
  return out;
}

/** Saved parts as what `Draft.insertParts` and `Draft.hydrate` take. */
export const fromSaved = (parts: readonly SavedPart[]): (string | FileRef)[] => parts.map((p) => (p.kind === 'text' ? p.text : { kind: 'file', path: p.path, dir: p.dir }));

// ---- markers ------------------------------------------------------------------------------

/** One `[Image #n: <path>]` marker (the bridge's transcript reads the same grammar: no `]` or line break in the path). */
const MARKER = /\[Image #\d+: ([^\]\n]+)\]/g;

export type MarkedPart = { kind: 'text'; text: string } | { kind: 'marker'; path: string };

/** A prompt's text cut at its markers, in order (`replaceAll` turns the ones it knows into chips). */
export function splitMarkers(text: string): MarkedPart[] {
  const out: MarkedPart[] = [];
  let at = 0;
  for (const m of text.matchAll(MARKER)) {
    if (m.index > at) out.push({ kind: 'text', text: text.slice(at, m.index) });
    out.push({ kind: 'marker', path: m[1] as string });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) });
  return out;
}

// ---- limits ------------------------------------------------------------------------------

/** Most images one prompt may carry (an opinion, not a ticket number: the agents read them one by one). */
export const MAX_IMAGES = 20;
/** The bridge's cap on the text of a hire's first task and of a `worker.prompt` (utf-8 bytes). */
export const HIRE_PROMPT_MAX_BYTES = 32 * 1024;
export const WORKER_PROMPT_MAX_BYTES = 16 * 1024;

/** The utf-8 length of a string in bytes, as the bridge counts (a lone surrogate is the 3 bytes of U+FFFD). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

// ---- serialising -------------------------------------------------------------------------

/**
 * What a path from Drop Zone must look like to go into a marker: absolute, and free of what would break the
 * `[Image #n: <path>]` grammar or the prompt (`]`, line breaks, control characters). The bridge checks the same; this
 * is the last check before text goes to an agent. Spaces and non-ASCII are fine and go through untouched.
 */
export function pathProblem(path: string): string | null {
  if (path === '') return 'the path is empty';
  if (!path.startsWith('/')) return 'the path is not absolute';
  if (path.includes(']')) return 'the path contains ]';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(path)) return 'the path contains a control character or a line break';
  return null;
}

export type SerializeError =
  | { kind: 'unresolved'; res: string }
  | { kind: 'bad_file'; path: string; reason: string }
  | { kind: 'bad_path'; res: string; path: string; reason: string }
  | { kind: 'too_long'; bytes: number; max: number };

export interface SerializeOptions {
  /** The cap on the final text in utf-8 bytes (hire 32 KiB, worker.prompt 16 KiB). */
  maxBytes: number;
  /** Adds one trailing line telling the agent the paths are local files. Off: no experiment has said it is needed. */
  hint?: boolean;
}

export const IMAGE_HINT = 'The images referenced above are local files: open them.';

export interface SerializedImage {
  /** The marker's number: the occurrence's place among the images of the document. */
  n: number;
  occ: string;
  res: string;
  path: string;
}

export type Serialized = { ok: true; text: string; images: SerializedImage[] } | { ok: false; error: SerializeError };

/**
 * The final prompt: the text as it is, with each image replaced by `[Image #n: <path>]`, n counted among the images in
 * document order whatever order the uploads finished in, and (#141) each file chip by its `@path` mention, at a word's
 * start (`joinMentions`). The image path is written as Drop Zone returned it; the file path as the checkout listed it,
 * whether or not the file is still there (the bridge leaves a mention it cannot find as it is). Brackets the user typed
 * (`[Image #1: x]` included) are text and are never read, counted or escaped. Never returns partial text: an image
 * with no path, a path that would break the marker or the mention, or a result over the cap is an error, and the
 * caller sends nothing.
 */
export function serializePrompt(doc: Doc, paths: ReadonlyMap<string, string>, o: SerializeOptions): Serialized {
  const images: SerializedImage[] = [];
  const out: MentionPart[] = [];
  let k = 0;
  const parts = doc.text.split(IMG);
  for (let i = 0; i < parts.length; i++) {
    out.push({ text: parts[i] as string });
    const occ = doc.chips[k];
    if (i === parts.length - 1 || !occ) continue;
    k++;
    if (isFileOcc(occ)) {
      const bad = filePathProblem(occ.path);
      if (bad) return { ok: false, error: { kind: 'bad_file', path: occ.path, reason: bad } };
      out.push({ file: occ.path });
      continue;
    }
    const path = paths.get(occ.res);
    if (path === undefined) return { ok: false, error: { kind: 'unresolved', res: occ.res } };
    const bad = pathProblem(path);
    if (bad) return { ok: false, error: { kind: 'bad_path', res: occ.res, path, reason: bad } };
    const n = images.length + 1;
    images.push({ n, occ: occ.occ, res: occ.res, path });
    out.push({ text: `[Image #${n}: ${path}]` });
  }
  let text = joinMentions(out);
  if (o.hint && images.length > 0) text += `\n\n${IMAGE_HINT}`;
  const bytes = utf8Length(text);
  if (bytes > o.maxBytes) return { ok: false, error: { kind: 'too_long', bytes, max: o.maxBytes } };
  return { ok: true, text, images };
}

/** A message for a serialize error, in words for the composer. */
export function serializeErrorText(e: SerializeError, name?: string): string {
  switch (e.kind) {
    case 'unresolved':
      return `${name ?? 'An image'} has not been uploaded yet.`;
    case 'bad_path':
      return `${name ?? 'An image'} came back with a path the prompt cannot carry (${e.reason}).`;
    case 'bad_file':
      return `The file ${e.path} cannot go in a prompt (${e.reason}): remove its chip.`;
    case 'too_long':
      return `The prompt is ${(e.bytes / 1024).toFixed(1)} KB with the image and file paths. The limit is ${Math.round(e.max / 1024)} KB: shorten the text.`;
  }
}
