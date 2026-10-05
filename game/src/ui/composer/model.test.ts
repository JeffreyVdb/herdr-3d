import { describe, expect, it } from 'vitest';
import {
  caretAfter,
  cleanText,
  type Doc,
  EMPTY_DOC,
  IMAGE_HINT,
  IMG,
  chipsIn,
  moveChip,
  splitMarkers,
  chipAt,
  type FileOccurrence,
  filePathProblem,
  imagesIn,
  imagesOf,
  joinMentions,
  mentionOf,
  mentionText,
  type Occurrence,
  partsLength,
  replaceParts,
  sameChips,
  savedParts,
  readSavedParts,
  fromSaved,
  offsetOfChip,
  pathProblem,
  plainText,
  removeChip,
  replaceRange,
  resourcesOf,
  segments,
  serializeErrorText,
  serializePrompt,
  utf8Length,
} from './model';

const o = (n: string, res = n): Occurrence => ({ occ: `o-${n}`, res });
const a = o('a');
const b = o('b');
const c = o('c');

let fid = 0;
const f = (path: string, dir = false): FileOccurrence => ({ kind: 'file', occ: `f-${++fid}`, path, dir });

/** A document from text with `<a>` `<b>` `<c>` where images stand and `{path}` (`{path/}`: a folder) where files do. */
function doc(src: string): Doc {
  const chips: Occurrence[] = [];
  const text = src.replace(/<([abc])>|\{([^}]+)\}/g, (_m, k: string | undefined, p: string | undefined) => {
    chips.push(k ? o(k) : p?.endsWith('/') ? f(p.slice(0, -1), true) : f(p as string));
    return IMG;
  });
  return { text, chips };
}
/** The other way, for readable expectations. */
const show = (d: Doc): string => {
  let k = 0;
  return d.text.replace(new RegExp(IMG, 'g'), () => {
    const c = d.chips[k++];
    return !c ? '<?>' : c.kind === 'file' ? `{${c.path}${c.dir ? '/' : ''}}` : `<${c.res}>`;
  });
};

describe('cleanText', () => {
  it('normalises line ends and drops the two characters the document reserves', () => {
    expect(cleanText('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
    expect(cleanText(`x${IMG}y\u200Bz`)).toBe('xyz');
    expect(cleanText('[Image #1: /x]  ')).toBe('[Image #1: /x]  ');
  });
});

describe('replaceRange', () => {
  it('types into text and keeps the images where they were', () => {
    expect(show(replaceRange(doc('hi <a> there'), 2, 2, ' you'))).toBe('hi you <a> there');
    expect(show(replaceRange(doc('hi <a> there'), 4, 4, 'X'))).toBe('hi <a>X there');
  });
  it('inserts an image at the start, the end, the middle and between two images', () => {
    const empty = replaceRange(EMPTY_DOC, 0, 0, '', [a]);
    expect(show(empty)).toBe('<a>');
    expect(show(replaceRange(doc('ab'), 0, 0, '', [a]))).toBe('<a>ab');
    expect(show(replaceRange(doc('ab'), 2, 2, '', [a]))).toBe('ab<a>');
    expect(show(replaceRange(doc('ab'), 1, 1, '', [a]))).toBe('a<a>b');
    expect(show(replaceRange(doc('<a><b>'), 1, 1, '', [c]))).toBe('<a><c><b>');
    expect(show(replaceRange(doc('x'), 1, 1, '', [a, b]))).toBe('x<a><b>');
  });
  it('replaces a selection: the text goes, and the images inside it with it', () => {
    expect(show(replaceRange(doc('aa<a>bb<b>cc'), 1, 7, 'X'))).toBe('aXc');
    expect(show(replaceRange(doc('aa<a>bb<b>cc'), 2, 3))).toBe('aabb<b>cc');
    expect(show(replaceRange(doc('aa<a>bb<b>cc'), 3, 6, '', [c]))).toBe('aa<a><c>cc');
  });
  it('replaces a selection with text and images in one edit, the text first', () => {
    expect(show(replaceRange(doc('abcd'), 1, 3, 'X', [a]))).toBe('aX<a>d');
  });
  it('accepts a backward or out-of-range selection', () => {
    expect(show(replaceRange(doc('abcd'), 3, 1, 'X'))).toBe('aXd');
    expect(show(replaceRange(doc('abcd'), -5, 99, 'X'))).toBe('X');
  });
  it('cleans what it inserts, so the document invariant holds', () => {
    const d = replaceRange(doc('a'), 1, 1, `${IMG}\u200B\r\nz`);
    expect(d.text).toBe('a\nz');
    expect(d.chips).toEqual([]);
  });
  it('does not touch the document it was given', () => {
    const d = doc('a<a>b');
    const before = JSON.stringify(d);
    replaceRange(d, 0, 3, 'x');
    expect(JSON.stringify(d)).toBe(before);
  });
  it('keeps the image count equal to the number of U+FFFC after any edit', () => {
    let d = doc('ab<a>cd<b>ef');
    for (const [s, e, t, add] of [[0, 3, 'x', [c]], [2, 2, '', [a, b]], [1, 8, '', []], [0, 0, 'q', [c]]] as const) {
      d = replaceRange(d, s, e, t, add);
      expect(chipsIn(d.text)).toBe(d.chips.length);
    }
  });
});

describe('caretAfter', () => {
  it('is after the inserted text and images, whichever way the range was drawn', () => {
    expect(caretAfter(1, 3, 'X', [a])).toBe(3);
    expect(caretAfter(3, 1, 'XY', [])).toBe(3);
    expect(caretAfter(0, 0, `\r\n`, [a, b])).toBe(3);
  });
});

describe('removeChip / moveChip', () => {
  it('removes one image and joins the text around it', () => {
    expect(show(removeChip(doc('a<a>b<b>c'), 0))).toBe('ab<b>c');
    expect(show(removeChip(doc('a<a>b<b>c'), 1))).toBe('a<a>bc');
    expect(show(removeChip(doc('<a><b>'), 0))).toBe('<b>');
  });
  it('ignores an index that is not there', () => {
    const d = doc('a<a>');
    expect(removeChip(d, 5)).toBe(d);
    expect(removeChip(d, -1)).toBe(d);
  });
  it('moves an image forward and backward among the text, keeping the occurrence', () => {
    expect(show(moveChip(doc('<a>xy<b>z'), 0, 3))).toBe('xy<a><b>z');
    expect(show(moveChip(doc('<a>xy<b>z'), 1, 0))).toBe('<b><a>xy' + 'z');
    expect(show(moveChip(doc('x<a>yz'), 0, 3))).toBe('xy<a>z');
    expect(moveChip(doc('x<a>yz'), 0, 3).chips[0]).toEqual(a);
  });
  it('renumbers by position only: after a move the images are in the new order', () => {
    const d = moveChip(doc('<a>x<b>'), 1, 0);
    expect(imagesOf(d).map((i) => i.res)).toEqual(['b', 'a']);
  });
  it('a move to where it already is changes nothing', () => {
    expect(show(moveChip(doc('x<a>y'), 0, 1))).toBe('x<a>y');
    expect(show(moveChip(doc('x<a>y'), 0, 2))).toBe('x<a>y');
  });
});

describe('segments / helpers', () => {
  it('splits into text and images in order, without empty text', () => {
    expect(segments(doc('hi <a><b>!'))).toEqual([
      { kind: 'text', text: 'hi ' },
      { kind: 'image', occ: 'o-a', res: 'a' },
      { kind: 'image', occ: 'o-b', res: 'b' },
      { kind: 'text', text: '!' },
    ]);
    expect(segments(EMPTY_DOC)).toEqual([]);
  });
  it('finds an image by index and lists distinct resources', () => {
    const d = doc('x<a>y<b>z');
    expect(offsetOfChip(d, 1)).toBe(3);
    expect(offsetOfChip(d, 2)).toBe(-1);
    const twice: Doc = { text: `${IMG}${IMG}`, chips: [{ occ: '1', res: 'r' }, { occ: '2', res: 'r' }] };
    expect(resourcesOf(twice)).toEqual(['r']);
  });
  it('plainText leaves the images out', () => {
    expect(plainText(doc('a<a>b'))).toBe('ab');
  });
});

describe('utf8Length', () => {
  it.each([
    ['', 0],
    ['abc', 3],
    ['é', 2],
    ['€', 3],
    ['😀', 4],
    ['a😀é€', 10],
    ['\ud800', 3],
    ['\udc00x', 4],
  ])('%j is %i bytes', (s, n) => {
    expect(utf8Length(s)).toBe(n);
    expect(new TextEncoder().encode(s).length).toBe(n);
  });
  it('agrees with TextEncoder on lone surrogates too', () => {
    for (const s of ['\ud800', 'x\udc00', '\ud83d']) expect(utf8Length(s)).toBe(new TextEncoder().encode(s).length);
  });
});

describe('pathProblem', () => {
  it.each([
    ['/d/a.png', null],
    ['/d/my image-é.png', null],
    ['/home/dev/drops/2026-09/h3d-nibble-1.png', null],
    ['/d/[x.png', null],
    ['', 'empty'],
    ['d/a.png', 'not absolute'],
    ['./a.png', 'not absolute'],
    ['/d/a].png', ']'],
    ['/d/a\n.png', 'control'],
    ['/d/a\r.png', 'control'],
    ['/d/a\0.png', 'control'],
    ['/d/a\x1b[0m.png', 'control'],
    ['/d/a\x1b.png', 'control'],
    ['/d/a\u2028.png', 'control'],
  ])('%j', (p, want) => {
    const got = pathProblem(p);
    if (want === null) expect(got).toBeNull();
    else expect(got).toContain(want);
  });
});

describe('serializePrompt (research-upload §5, table-driven)', () => {
  const paths = new Map([
    ['a', '/d/a.png'],
    ['b', '/d/b.webp'],
  ]);
  const ser = (d: Doc, p: ReadonlyMap<string, string> = paths, maxBytes = 32768, hint = false) => serializePrompt(d, p, { maxBytes, hint });
  const text = (r: ReturnType<typeof ser>) => (r.ok ? r.text : `ERR:${r.error.kind}`);

  it.each([
    ['plain text, brackets and all', doc('hello [x]'), 'hello [x]'],
    ['text, image, text, image, text', doc('see <a> and <b>.'), 'see [Image #1: /d/a.png] and [Image #2: /d/b.webp].'],
    ['numbering is the document order, not the upload order', doc('<b>\nthen <a>'), '[Image #1: /d/b.webp]\nthen [Image #2: /d/a.png]'],
    ['no whitespace is added', doc('before<a>after'), 'before[Image #1: /d/a.png]after'],
    ['adjacent images', doc('<a><b>'), '[Image #1: /d/a.png][Image #2: /d/b.webp]'],
    ['a typed marker stays text, the real chip is #1 too', doc('[Image #1: user typed] <a>'), '[Image #1: user typed] [Image #1: /d/a.png]'],
    ['the same resource twice is two occurrences with one path', { text: `${IMG}${IMG}`, chips: [o('1', 'a'), o('2', 'a')] }, '[Image #1: /d/a.png][Image #2: /d/a.png]'],
    ['literal brackets, backslashes and edge newlines are kept', doc('\n[a][b]\\n <a>\n'), '\n[a][b]\\n [Image #1: /d/a.png]\n'],
    ['empty', EMPTY_DOC, ''],
  ])('%s', (_name, d, want) => {
    const r = ser(d);
    expect(text(r)).toBe(want);
  });

  it('reports each image with its number and path, in order', () => {
    const r = ser(doc('<b> <a>'));
    expect(r).toMatchObject({ ok: true, images: [{ n: 1, res: 'b', path: '/d/b.webp' }, { n: 2, res: 'a', path: '/d/a.png' }] });
  });

  it('numbers by what is left after a removal', () => {
    expect(text(ser(removeChip(doc('<a> and <b>'), 0)))).toBe(' and [Image #1: /d/b.webp]');
  });

  it('keeps spaces and non-ASCII in the path exactly', () => {
    const p = new Map([['a', '/d/my image-é.png']]);
    expect(text(ser(doc('<a>'), p))).toBe('[Image #1: /d/my image-é.png]');
  });

  it('is an error, never partial text, for an image that has no path', () => {
    expect(ser(doc('x <a> <b>'), new Map([['a', '/d/a.png']]))).toEqual({ ok: false, error: { kind: 'unresolved', res: 'b' } });
  });

  it.each([
    ['relative', 'a.png'],
    ['empty', ''],
    ['with ]', '/d/a].png'],
    ['with LF', '/d/a\n.png'],
    ['with CR', '/d/a\r.png'],
    ['with NUL', '/d/a\0.png'],
    ['with ESC', '/d/a\x1b.png'],
  ])('refuses a %s path and does not repair it', (_n, path) => {
    const r = ser(doc('<a>'), new Map([['a', path]]));
    expect(r).toMatchObject({ ok: false, error: { kind: 'bad_path', res: 'a', path } });
  });

  it('adds the hint once, after a blank line, only with images and only when asked', () => {
    expect(text(ser(doc('<a> <b>'), paths, 32768, true))).toBe(`[Image #1: /d/a.png] [Image #2: /d/b.webp]\n\n${IMAGE_HINT}`);
    expect(text(ser(doc('no images'), paths, 32768, true))).toBe('no images');
    expect(text(ser(doc('<a>'), paths, 32768, false))).toBe('[Image #1: /d/a.png]');
  });

  describe('the byte cap', () => {
    const marker = '[Image #1: /d/a.png]'; // 20 bytes
    it('accepts exactly the cap and refuses one byte more', () => {
      expect(ser(doc('<a>'), paths, marker.length).ok).toBe(true);
      expect(ser(doc('<a>'), paths, marker.length - 1)).toEqual({ ok: false, error: { kind: 'too_long', bytes: 20, max: 19 } });
      expect(ser(doc('x'.repeat(100)), paths, 100).ok).toBe(true);
      expect(ser(doc('x'.repeat(101)), paths, 100).ok).toBe(false);
    });
    it('counts utf-8 bytes, not UTF-16 units, at the boundary', () => {
      // 25 emoji = 100 bytes but 50 units; 26 emoji = 104 bytes.
      expect(ser(doc('😀'.repeat(25)), paths, 100).ok).toBe(true);
      expect(ser(doc('😀'.repeat(26)), paths, 100).ok).toBe(false);
      // 'é' is 2 bytes: 50 of them are exactly 100.
      expect(ser(doc('é'.repeat(50)), paths, 100).ok).toBe(true);
      expect(ser(doc('é'.repeat(50) + 'x'), paths, 100).ok).toBe(false);
      // the path's own multibyte characters count too
      const p = new Map([['a', '/é.png']]);
      expect(ser(doc('<a>'), p, '[Image #1: /é.png]'.length).ok).toBe(false);
      expect(ser(doc('<a>'), p, utf8Length('[Image #1: /é.png]')).ok).toBe(true);
    });
    it('counts the hint', () => {
      const withHint = utf8Length(`${marker}\n\n${IMAGE_HINT}`);
      expect(ser(doc('<a>'), paths, withHint, true).ok).toBe(true);
      expect(ser(doc('<a>'), paths, withHint - 1, true).ok).toBe(false);
    });
    it('hire 32 KiB and worker.prompt 16 KiB are the numbers the hosts pass', () => {
      expect(ser(doc('x'.repeat(32768)), paths, 32768).ok).toBe(true);
      expect(ser(doc('x'.repeat(16385)), paths, 16384).ok).toBe(false);
    });
  });
});

describe('serializeErrorText', () => {
  it('says what to do', () => {
    expect(serializeErrorText({ kind: 'unresolved', res: 'a' }, 'shot.png')).toBe('shot.png has not been uploaded yet.');
    expect(serializeErrorText({ kind: 'too_long', bytes: 33000, max: 32768 })).toBe('The prompt is 32.2 KB with the image and file paths. The limit is 32 KB: shorten the text.');
    expect(serializeErrorText({ kind: 'bad_path', res: 'a', path: 'x', reason: 'the path is not absolute' })).toMatch(/not absolute/);
  });
});

describe('splitMarkers (#64)', () => {
  it('cuts text at [Image #n: path] markers, paths with spaces and non-ASCII whole', () => {
    expect(splitMarkers('a [Image #1: /d/x y-2.png] b\n[Image #2: /d/é.jpg]')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'marker', path: '/d/x y-2.png' },
      { kind: 'text', text: ' b\n' },
      { kind: 'marker', path: '/d/é.jpg' },
    ]);
  });
  it('leaves what is not a marker as text', () => {
    expect(splitMarkers('[Image #x: /a] [Image #1 /a] [Image #1: /a\n]')).toEqual([{ kind: 'text', text: '[Image #x: /a] [Image #1 /a] [Image #1: /a\n]' }]);
    expect(splitMarkers('')).toEqual([]);
  });
});

describe('file chips (#141)', () => {
  it('sit in the text as one placeholder each, next to images and to each other', () => {
    const d = doc('see {src/a.ts}{src/b.ts}<a>{lib/}!');
    expect(chipsIn(d.text)).toBe(d.chips.length);
    expect(show(d)).toBe('see {src/a.ts}{src/b.ts}<a>{lib/}!');
    expect(chipAt(d, 4)).toMatchObject({ kind: 'file', path: 'src/a.ts' });
    expect(chipAt(d, 6)).toMatchObject({ res: 'a' });
    expect(chipAt(d, 0)).toBeNull();
  });
  it('replaceParts puts text and chips in their order as one edit, removing the chips of the range', () => {
    const d = doc('x <a> y');
    const r = replaceParts(d, 2, 3, [f('a.ts'), ' and ', f('b c.md'), ' ']);
    expect(show(r)).toBe('x {a.ts} and {b c.md}  y');
    expect(chipsIn(r.text)).toBe(r.chips.length);
    expect(partsLength([f('a.ts'), ' and\r\n', f('b')])).toBe(7);
  });
  it('counts images only where the image limit asks', () => {
    const d = doc('{a.ts}<a>{b.ts}<b>');
    expect(imagesIn(d)).toBe(2);
    expect(imagesIn(d, 0, 2)).toBe(1);
    expect(imagesIn(d, 2, 3)).toBe(0);
    expect(resourcesOf(d)).toEqual(['a', 'b']);
  });
  it('segments says file chips with their path, plainText leaves them out', () => {
    const d = doc('see {src/a.ts} and {lib/}');
    expect(segments(d)).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'file', occ: d.chips[0]?.occ, path: 'src/a.ts', dir: false },
      { kind: 'text', text: ' and ' },
      { kind: 'file', occ: d.chips[1]?.occ, path: 'lib', dir: true },
    ]);
    expect(plainText(d)).toBe('see  and ');
  });
  it('removes and moves a file chip like an image', () => {
    expect(show(removeChip(doc('a{x.ts}b<a>'), 0))).toBe('ab<a>');
    expect(show(moveChip(doc('{x.ts}ab<a>'), 0, 3))).toBe('ab{x.ts}<a>');
  });
  it('sameChips tells a file chip from another path under the same occurrence', () => {
    const a1: Doc = { text: IMG, chips: [{ kind: 'file', occ: 'o1', path: 'a', dir: false }] };
    expect(sameChips(a1, { text: IMG, chips: [{ kind: 'file', occ: 'o1', path: 'a', dir: false }] })).toBe(true);
    expect(sameChips(a1, { text: IMG, chips: [{ kind: 'file', occ: 'o1', path: 'b', dir: false }] })).toBe(false);
    expect(sameChips(a1, { text: IMG, chips: [{ kind: 'file', occ: 'o1', path: 'a', dir: true }] })).toBe(false);
    expect(sameChips(a1, { text: IMG, chips: [{ occ: 'o1', res: 'a' }] })).toBe(false);
  });

  it.each([
    ['a plain path', 'src/ui/composer/draft.ts', '@src/ui/composer/draft.ts'],
    ['a space', 'my docs/a b.txt', '@"my docs/a b.txt"'],
    ['a tab', 'a\tb', '@"a\tb"'],
    ['a no-break space', 'a\u00a0b', '@"a\u00a0b"'],
    ['NEL (Go reads it as a space)', 'a\u0085b', '@"a\u0085b"'],
    ['non-ASCII, astral', 'dé/🙂.md', '@dé/🙂.md'],
    ['a folder (no trailing slash)', 'src/ui', '@src/ui'],
  ])('mentionOf: %s', (_n, path, want) => {
    expect(mentionOf(path)).toBe(want);
  });

  it.each([
    ['a quote', 'a"b.ts'],
    ['LF', 'a\nb'],
    ['CR', 'a\rb'],
    ['NUL', 'a\0b'],
    ['nothing', ''],
  ])('filePathProblem refuses %s', (_n, path) => {
    expect(filePathProblem(path)).not.toBeNull();
  });
  it('filePathProblem lets spaces, # ? and Unicode through', () => {
    expect(filePathProblem('my dir/#1 ?é 🙂.md')).toBeNull();
  });

  it('joinMentions puts a mention at a word start and keeps it apart from what follows', () => {
    const j = (...p: (string | { file: string })[]) => joinMentions(p.map((x) => (typeof x === 'string' ? { text: x } : x)));
    expect(j({ file: 'a.ts' })).toBe('@a.ts');
    expect(j('see', { file: 'a.ts' })).toBe('see @a.ts');
    expect(j('see ', { file: 'a.ts' }, ' now')).toBe('see @a.ts now');
    expect(j({ file: 'a.ts' }, ', please')).toBe('@a.ts , please');
    expect(j({ file: 'a.ts' }, { file: 'b.ts' })).toBe('@a.ts @b.ts');
    expect(j('(', { file: 'a.ts' }, ')')).toBe('(@a.ts )');
    expect(j('"', { file: 'a b' })).toBe('"@"a b"');
    expect(j('\n', { file: 'a.ts' }, '\n')).toBe('\n@a.ts\n');
    expect(j('x', { file: 'a.ts' }, '', '', 'y')).toBe('x @a.ts y');
  });
  // Go's unicode.IsSpace is not JavaScript's \s: it reads NEL as a space but not U+FEFF (a BOM / zero-width no-break
  // space), so a mention needs its separator next to U+FEFF and needs none next to NEL or an ideographic space.
  it('joinMentions keeps a mention apart from U+FEFF on both sides', () => {
    const j = (...p: (string | { file: string })[]) => joinMentions(p.map((x) => (typeof x === 'string' ? { text: x } : x)));
    expect(j('hello\ufeff', { file: 'src/a.ts' })).toBe('hello\ufeff @src/a.ts');
    expect(j({ file: 'src/a.ts' }, '\ufeffhello')).toBe('@src/a.ts \ufeffhello');
    expect(j('\ufeff', { file: 'a.ts' }, '\ufeff')).toBe('\ufeff @a.ts \ufeff');
  });
  it.each([
    ['NEL', '\u0085'],
    ['a no-break space', '\u00a0'],
    ['a vertical tab', '\v'],
    ['an ogham space', '\u1680'],
    ['an en quad', '\u2000'],
    ['a hair space', '\u200a'],
    ['a line separator', '\u2028'],
    ['a narrow no-break space', '\u202f'],
    ['an ideographic space', '\u3000'],
  ])('joinMentions reads %s as the separator Go reads', (_n, ws) => {
    expect(joinMentions([{ text: `see${ws}` }, { file: 'a.ts' }, { text: `${ws}now` }])).toBe(`see${ws}@a.ts${ws}now`);
  });
  it.each([
    ['U+FEFF', '\ufeff'],
    ['a zero-width space', '\u200b'],
    ['a Mongolian vowel separator', '\u180e'],
  ])('joinMentions does not read %s as whitespace (nor does Go)', (_n, ch) => {
    expect(joinMentions([{ text: `see${ch}` }, { file: 'a.ts' }, { text: `${ch}now` }])).toBe(`see${ch} @a.ts ${ch}now`);
  });
  it('mentionOf quotes only on what Go reads as whitespace', () => {
    expect(mentionOf('a\ufeffb')).toBe('@a\ufeffb');
    expect(mentionOf('a\u3000b')).toBe('@"a\u3000b"');
  });
  it('mentionText is a range as plain text with mentions, images left out', () => {
    const d = doc('see{src/a.ts}<a>{my d/b.md}.');
    expect(mentionText(d)).toBe('see @src/a.ts @"my d/b.md" .');
    expect(mentionText(d, 3, 4)).toBe('@src/a.ts');
    expect(mentionText(d, 4, 6)).toBe('@"my d/b.md"');
  });
});

describe('serializePrompt with file chips (#141)', () => {
  const paths = new Map([
    ['a', '/d/a.png'],
    ['b', '/d/b.webp'],
  ]);
  const ser = (d: Doc, maxBytes = 32768) => serializePrompt(d, paths, { maxBytes });
  const text = (r: ReturnType<typeof ser>) => (r.ok ? r.text : `ERR:${r.error.kind}`);

  it.each([
    ['a file chip alone', doc('{src/ui/composer/draft.ts}'), '@src/ui/composer/draft.ts'],
    ['in a sentence', doc('look at {a.ts} please'), 'look at @a.ts please'],
    ['glued to the text before and after', doc('see{a.ts}now'), 'see @a.ts now'],
    ['adjacent file chips', doc('{a.ts}{b.ts}'), '@a.ts @b.ts'],
    ['a path with spaces', doc('read {my docs/a b.txt}'), 'read @"my docs/a b.txt"'],
    ['a folder', doc('{src/ui/}'), '@src/ui'],
    ['images numbered among images only', doc('<a>{x.ts}<b>'), '[Image #1: /d/a.png] @x.ts [Image #2: /d/b.webp]'],
    ['an image right after a file', doc('{x.ts}<a>'), '@x.ts [Image #1: /d/a.png]'],
    ['after an opening bracket', doc('({x.ts})'), '(@x.ts )'],
  ])('%s', (_n, d, want) => {
    expect(text(ser(d))).toBe(want);
  });

  it('reports the images with their numbers, files between them not counted', () => {
    expect(ser(doc('{x.ts}<b>{y.ts}<a>'))).toMatchObject({ ok: true, images: [{ n: 1, res: 'b' }, { n: 2, res: 'a' }] });
  });
  it('refuses a file chip whose path could not be read back', () => {
    const d: Doc = { text: IMG, chips: [{ kind: 'file', occ: 'o1', path: 'a"b', dir: false }] };
    expect(ser(d)).toMatchObject({ ok: false, error: { kind: 'bad_file', path: 'a"b' } });
  });
  it('counts the mention, its quotes and the spaces put in toward the cap', () => {
    const d = doc('x{a b}y'); // 'x @"a b" y' = 10 bytes
    expect(ser(d, 10).ok).toBe(true);
    expect(ser(d, 9)).toEqual({ ok: false, error: { kind: 'too_long', bytes: 10, max: 9 } });
    const e = doc('{é.ts}'); // '@é.ts' = 6 bytes
    expect(ser(e, 6).ok).toBe(true);
    expect(ser(e, 5).ok).toBe(false);
  });
});

describe('saved parts (#141: storage and clipboard)', () => {
  it('keeps text and file chips in order, drops images and joins the text around them', () => {
    const d = doc('a<a>b{src/x.ts}c{lib/}');
    expect(savedParts(d)).toEqual([
      { kind: 'text', text: 'ab' },
      { kind: 'file', path: 'src/x.ts', dir: false },
      { kind: 'text', text: 'c' },
      { kind: 'file', path: 'lib', dir: true },
    ]);
    expect(savedParts(d, 3, 4)).toEqual([{ kind: 'file', path: 'src/x.ts', dir: false }]);
    expect(savedParts(EMPTY_DOC)).toEqual([]);
  });
  it('round-trips through JSON and back into a document', () => {
    const d = doc('see {my d/a b.md} and {src/}');
    const back = readSavedParts(JSON.parse(JSON.stringify(savedParts(d))));
    expect(back).toEqual(savedParts(d));
    const parts = fromSaved(back ?? []).map((p) => (typeof p === 'string' ? p : f(p.path, p.dir)));
    expect(show(replaceParts(EMPTY_DOC, 0, 0, parts))).toBe('see {my d/a b.md} and {src/}');
  });
  it('reads untrusted data: not a list is null, a bad part is left out', () => {
    expect(readSavedParts(null)).toBeNull();
    expect(readSavedParts({ kind: 'text' })).toBeNull();
    expect(
      readSavedParts([
        { kind: 'text', text: 'ok' },
        { kind: 'text', text: 3 },
        { kind: 'file', path: 'a"b', dir: false },
        { kind: 'file', path: 'a\nb', dir: false },
        { kind: 'file', path: 'x.ts' },
        { kind: 'image', occ: 'o1', res: 'r1' },
        'nope',
        null,
        { kind: 'file', path: 'y.ts', dir: false },
      ]),
    ).toEqual([
      { kind: 'text', text: 'ok' },
      { kind: 'file', path: 'y.ts', dir: false },
    ]);
  });
});
