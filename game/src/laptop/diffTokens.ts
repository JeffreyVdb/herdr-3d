/**
 * #206: the pure half of a diff's syntax colours, shared by the transcript and its highlight worker (no DOM, no
 * highlight.js import): which language a changed file's path names, a hunk's two sides as whole texts, and
 * highlight.js's HTML split back into one token list per line.
 *
 * A diff is coloured per hunk side, never per line: the old side (context and deleted lines) and the new side (context
 * and added lines) are each one text, so a template literal or a block comment that spans rows colours right on every
 * row. Context rows take the new side's tokens.
 *
 * Rows are coloured with the CSS Custom Highlight API, not spans (diffHighlight.ts): `rowRanges` turns a line's tokens
 * into the character ranges each colour paints.
 */

/**
 * Extensions highlight.js's own aliases (`lib/common`, 11.12) miss, or that matter enough to pin: the language they name.
 * Anything else resolves through `getLanguage(ext)`; what that does not know stays plain.
 */
export const EXT_LANGUAGE: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  pyi: 'python',
  pyw: 'python',
  htm: 'xml',
  vue: 'xml',
  svelte: 'xml',
  mdx: 'markdown',
  jsonl: 'json',
  ndjson: 'json',
  webmanifest: 'json',
  bats: 'bash',
  cfg: 'ini',
  properties: 'ini',
};

/**
 * The language a diff's path names by its extension (lower-cased: the map, then `known`, highlight.js's own names and
 * aliases), or null: no extension (`Makefile`, `.env`), or one nothing knows. Never a guess from the text.
 */
export function diffLanguage(path: unknown, known: (name: string) => boolean): string | null {
  if (typeof path !== 'string') return null;
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  const lang = Object.hasOwn(EXT_LANGUAGE, ext) ? (EXT_LANGUAGE[ext] as string) : ext;
  return /^[\w+-]+$/.test(lang) && known(lang) ? lang : null;
}

/** Where a hunk line's tokens come from: [side (0 old, 1 new), line on that side], or null (a `\ No newline` row). */
export type SideLine = readonly [0 | 1, number] | null;

export interface HunkSides {
  /** Context and deleted lines, joined with `\n`. */
  old: string;
  /** Context and added lines, joined with `\n`. */
  neu: string;
  /** Per hunk line, in order. */
  at: SideLine[];
  /** Per hunk line: how many leading characters are the diff's own (the `+`, `-` or space), not code: 1 or 0. */
  sign: number[];
}

/** A hunk's lines (each with its `+`, `-`, space or `\`) as its two sides. A line with no sign is context as it is. */
export function hunkSides(lines: readonly string[]): HunkSides {
  const old: string[] = [];
  const neu: string[] = [];
  const at: SideLine[] = [];
  const sign: number[] = [];
  for (const l of lines) {
    const c = l[0];
    if (c === '\\') {
      at.push(null);
      sign.push(0);
      continue;
    }
    const s = c === '+' || c === '-' || c === ' ' ? 1 : 0;
    const code = l.slice(s);
    sign.push(s);
    if (c === '+') at.push([1, neu.push(code) - 1]);
    else if (c === '-') at.push([0, old.push(code) - 1]);
    else {
      old.push(code);
      at.push([1, neu.push(code) - 1]);
    }
  }
  return { old: old.join('\n'), neu: neu.join('\n'), at, sign };
}

/**
 * One line's tokens, flat: `[classes, text, classes, text, …]`. `classes` is the token's highlight.js classes from the
 * outermost span in: one level per span, levels joined with `,`, a level's classes with a space (`hljs-string,hljs-subst`);
 * empty for text in no span. Only `hljs-*` classes are kept (`hljs-title class_` is `hljs-title`; a `language-xml`
 * wrapper is no level). Flat strings: cheap to send from the worker.
 */
export type LineTokens = string[];

const ENTITY: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'" };
const decode = (s: string) => (s.includes('&') ? s.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (m) => ENTITY[m] as string) : s);
const hljsClasses = (attr: string) =>
  attr
    .split(' ')
    .filter((c) => /^hljs-[\w-]{1,48}$/.test(c))
    .join(' ');

/**
 * highlight.js's HTML (`highlight(text).value`: spans and escaped text, nothing else) as one token list per line of the
 * text: a span that crosses a newline is closed at the line's end and opened again on the next. As many lists as the
 * text has lines (`a\n` is two, the second empty).
 */
export function splitHighlighted(html: string): LineTokens[] {
  const lines: LineTokens[] = [[]];
  const stack: string[] = [];
  let path = '';
  const re = /<span class="([^"]*)">|<\/span>|([^<]+)/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[1] !== undefined || m[2] === undefined) {
      if (m[1] !== undefined) stack.push(hljsClasses(m[1]));
      else stack.pop();
      path = stack.filter(Boolean).join(',');
      continue;
    }
    const parts = decode(m[2]).split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) lines.push([]);
      const p = parts[i] as string;
      if (!p) continue;
      const line = lines[lines.length - 1] as LineTokens;
      // Text next to text of the same classes (an entity split it) is one token.
      if (line.length && line[line.length - 2] === path) line[line.length - 1] += p;
      else line.push(path, p);
    }
  }
  return lines;
}

/** A hunk's two sides, tokenized: one token list per line of each side. */
export interface HunkTokens {
  old: LineTokens[];
  neu: LineTokens[];
}

/** `text` highlighted as `lang` (highlight.js: `highlight(text, {language, ignoreIllegals: true}).value`). */
export type HighlightFn = (text: string, lang: string) => string;

/**
 * Both sides of a hunk, tokenized whole and split back into lines; null when the highlighter fails or its lines do not
 * match the text's (the rows then stay plain).
 */
export function tokenizeHunk(highlight: HighlightFn, lang: string, old: string, neu: string): HunkTokens | null {
  const side = (text: string): LineTokens[] | null => {
    if (!text) return [[]];
    const lines = splitHighlighted(highlight(text, lang));
    return lines.length === text.split('\n').length ? lines : null;
  };
  try {
    const o = side(old);
    const n = o && side(neu);
    return o && n ? { old: o, neu: n } : null;
  } catch {
    return null;
  }
}

/** The text a line's tokens spell (to check a split against the line it is for). */
export const tokensText = (t: LineTokens): string => t.filter((_, i) => i % 2 === 1).join('');

/**
 * The colours a token can take, in transcript.css's order (its `.tx .hljs-*` rules), and the highlight.js classes each
 * colours. Each is a highlight named `tx-hl-<colour>` painted in `var(--tx-hl-<colour>)` (`::highlight()` in
 * transcript.css). A class not here (`hljs-subst`, `hljs-emphasis`…) has no colour of its own.
 */
export const HL_COLOURS: ReadonlyArray<readonly [colour: string, classes: readonly string[]]> = [
  ['comment', ['hljs-comment', 'hljs-quote']],
  ['keyword', ['hljs-keyword', 'hljs-selector-tag', 'hljs-literal', 'hljs-type']],
  ['string', ['hljs-string', 'hljs-regexp', 'hljs-addition', 'hljs-symbol']],
  ['number', ['hljs-number', 'hljs-built_in', 'hljs-params']],
  ['title', ['hljs-title', 'hljs-section', 'hljs-name']],
  ['attr', ['hljs-attr', 'hljs-attribute', 'hljs-variable', 'hljs-property']],
  ['meta', ['hljs-meta', 'hljs-deletion']],
];

/** highlight.js class -> its colour's index in HL_COLOURS. */
const COLOUR_OF = new Map(HL_COLOURS.flatMap(([, cls], c) => cls.map((k) => [k, c] as const)));

/**
 * The colour of a token's classes (a LineTokens `classes`): the innermost level that has one, as a span's would be
 * inherited (`hljs-string,hljs-subst` is a string's; `hljs-string,hljs-subst,hljs-title` a title's). Within a level the
 * class whose rule comes last wins, as in CSS. -1: none (the row's plain text).
 */
export function tokenColour(classes: string): number {
  if (!classes) return -1;
  const levels = classes.split(',');
  for (let i = levels.length - 1; i >= 0; i--) {
    let c = -1;
    for (const k of (levels[i] as string).split(' ')) c = Math.max(c, COLOUR_OF.get(k) ?? -1);
    if (c >= 0) return c;
  }
  return -1;
}

/**
 * A row's colours as character ranges of its text (the line as drawn: `from` characters of sign, then the tokens'
 * text), flat: `[colour, start, end, …]`, `colour` an index in HL_COLOURS. Text of no colour has no range; neighbouring
 * tokens of one colour are one range.
 */
export function rowRanges(tokens: LineTokens, from: number): number[] {
  const out: number[] = [];
  let at = from;
  for (let i = 0; i < tokens.length; i += 2) {
    const len = (tokens[i + 1] as string).length;
    const c = tokenColour(tokens[i] as string);
    if (c >= 0) {
      if (out.length && out[out.length - 3] === c && out[out.length - 1] === at) out[out.length - 1] = at + len;
      else out.push(c, at, at + len);
    }
    at += len;
  }
  return out;
}
