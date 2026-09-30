/**
 * The prompt composer's document, pure: no DOM, no uploads.
 *
 * A document is one string in which every image occurrence is a single U+FFFC ("object replacement") character, plus
 * the occurrences in that order. A caret or a selection is then just an offset into the string, ranges are one
 * `slice`, and "the image between these two words" or "two images side by side" need no special cases. The invariant
 * is `count(U+FFFC in text) === images.length`; text typed or pasted is cleaned of U+FFFC (and of U+200B, which the
 * view uses to give a caret a place between chips) at the boundary so it can never break it.
 *
 * An occurrence is one chip in the editor (`occ`); it points at the uploaded thing (`res`, a resource of the draft).
 * The two are different so an image can appear twice (undo, later a duplicate) with one upload, while every chip stays
 * editable on its own. Numbers ("Image #2") are never stored: they are the occurrences' order in the document.
 */

/** Stands for one image in `Doc.text`. */
export const IMG = '\uFFFC';
/** Gives an empty text run a node to hold a caret in the view; never part of the document. */
export const ZWSP = '\u200B';

export interface Occurrence {
  readonly occ: string;
  readonly res: string;
}

export interface Doc {
  readonly text: string;
  readonly images: readonly Occurrence[];
}

export const EMPTY_DOC: Doc = { text: '', images: [] };

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

/** How many images `text` holds between two offsets. */
export function imagesIn(text: string, from = 0, to = text.length): number {
  let n = 0;
  for (let i = text.indexOf(IMG, from); i >= 0 && i < to; i = text.indexOf(IMG, i + 1)) n++;
  return n;
}

/** Text with each image removed: what a plain-text view of the draft would show. */
export const plainText = (doc: Doc): string => doc.text.split(IMG).join('');

export const isEmptyDoc = (doc: Doc): boolean => doc.text === '';

/**
 * Replaces `[start, end)` with `insert` (cleaned) followed by `add` (new image occurrences), removing the images that
 * were inside the range. Offsets are clamped and put in order. One call is one edit: one history entry.
 */
export function replaceRange(doc: Doc, start: number, end: number, insert = '', add: readonly Occurrence[] = []): Doc {
  let a = Math.max(0, Math.min(doc.text.length, start));
  let b = Math.max(0, Math.min(doc.text.length, end));
  if (a > b) [a, b] = [b, a];
  const before = imagesIn(doc.text, 0, a);
  const inside = imagesIn(doc.text, a, b);
  const text = doc.text.slice(0, a) + cleanText(insert) + IMG.repeat(add.length) + doc.text.slice(b);
  const images = [...doc.images.slice(0, before), ...add, ...doc.images.slice(before + inside)];
  return { text, images };
}

/** Where the caret goes after `replaceRange(doc, start, end, insert, add)`: after everything inserted. */
export function caretAfter(start: number, end: number, insert: string, add: readonly Occurrence[]): number {
  return Math.min(start, end) + cleanText(insert).length + add.length;
}

/** The offset of image `index` (its U+FFFC), or -1. */
export function offsetOfImage(doc: Doc, index: number): number {
  let at = -1;
  for (let k = 0; k <= index; k++) {
    at = doc.text.indexOf(IMG, at + 1);
    if (at < 0) return -1;
  }
  return at;
}

/** The index of the image occurrence `occ`, or -1. */
export const indexOfOcc = (doc: Doc, occ: string): number => doc.images.findIndex((o) => o.occ === occ);

/** Removes image `index`; the text on both sides stays as it is (they join). */
export function removeImage(doc: Doc, index: number): Doc {
  const at = offsetOfImage(doc, index);
  return at < 0 ? doc : replaceRange(doc, at, at + 1);
}

/** Moves image `index` to offset `to` (in the document as it is now); a reorder along with the text around it. */
export function moveImage(doc: Doc, index: number, to: number): Doc {
  const at = offsetOfImage(doc, index);
  const occ = doc.images[index];
  if (at < 0 || !occ) return doc;
  const gone = replaceRange(doc, at, at + 1);
  const dest = Math.max(0, Math.min(gone.text.length, to > at ? to - 1 : to));
  return replaceRange(gone, dest, dest, '', [occ]);
}

/** The two things a document is made of, in order, without empty text runs. */
export type Segment = { kind: 'text'; text: string } | { kind: 'image'; occ: string; res: string };

export function segments(doc: Doc): Segment[] {
  const out: Segment[] = [];
  let k = 0;
  for (const part of doc.text.split(IMG)) {
    if (part !== '') out.push({ kind: 'text', text: part });
    const o = doc.images[k++];
    if (o) out.push({ kind: 'image', occ: o.occ, res: o.res });
  }
  return out;
}

/** The distinct resources a document uses, in the order they first appear. */
export function resourcesOf(doc: Doc): string[] {
  return [...new Set(doc.images.map((o) => o.res))];
}

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
 * The final prompt: the text as it is, with each image replaced by `[Image #n: <path>]`, n counted in document order
 * whatever order the uploads finished in. The path is written as Drop Zone returned it. Brackets the user typed
 * (`[Image #1: x]` included) are text and are never read, counted or escaped. Never returns partial text: an image
 * with no path, a path that would break the marker, or a result over the cap is an error, and the caller sends
 * nothing.
 */
export function serializePrompt(doc: Doc, paths: ReadonlyMap<string, string>, o: SerializeOptions): Serialized {
  const images: SerializedImage[] = [];
  let text = '';
  let k = 0;
  const parts = doc.text.split(IMG);
  for (let i = 0; i < parts.length; i++) {
    text += parts[i];
    const occ = doc.images[k];
    if (i === parts.length - 1 || !occ) continue;
    k++;
    const path = paths.get(occ.res);
    if (path === undefined) return { ok: false, error: { kind: 'unresolved', res: occ.res } };
    const bad = pathProblem(path);
    if (bad) return { ok: false, error: { kind: 'bad_path', res: occ.res, path, reason: bad } };
    const n = k;
    images.push({ n, occ: occ.occ, res: occ.res, path });
    text += `[Image #${n}: ${path}]`;
  }
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
    case 'too_long':
      return `The prompt is ${(e.bytes / 1024).toFixed(1)} KB with the image paths. The limit is ${Math.round(e.max / 1024)} KB: shorten the text.`;
  }
}
