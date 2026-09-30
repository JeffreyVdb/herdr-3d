import { describe, expect, it } from 'vitest';
import {
  caretAfter,
  cleanText,
  type Doc,
  EMPTY_DOC,
  IMAGE_HINT,
  IMG,
  imagesIn,
  moveImage,
  type Occurrence,
  offsetOfImage,
  pathProblem,
  plainText,
  removeImage,
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

/** A document from text with `<a>` `<b>` `<c>` where images stand. */
function doc(src: string): Doc {
  const images: Occurrence[] = [];
  const text = src.replace(/<([abc])>/g, (_m, k: string) => {
    images.push(o(k));
    return IMG;
  });
  return { text, images };
}
/** The other way, for readable expectations. */
const show = (d: Doc): string => {
  let k = 0;
  return d.text.replace(new RegExp(IMG, 'g'), () => `<${d.images[k++]?.res}>`);
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
    expect(d.images).toEqual([]);
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
      expect(imagesIn(d.text)).toBe(d.images.length);
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

describe('removeImage / moveImage', () => {
  it('removes one image and joins the text around it', () => {
    expect(show(removeImage(doc('a<a>b<b>c'), 0))).toBe('ab<b>c');
    expect(show(removeImage(doc('a<a>b<b>c'), 1))).toBe('a<a>bc');
    expect(show(removeImage(doc('<a><b>'), 0))).toBe('<b>');
  });
  it('ignores an index that is not there', () => {
    const d = doc('a<a>');
    expect(removeImage(d, 5)).toBe(d);
    expect(removeImage(d, -1)).toBe(d);
  });
  it('moves an image forward and backward among the text, keeping the occurrence', () => {
    expect(show(moveImage(doc('<a>xy<b>z'), 0, 3))).toBe('xy<a><b>z');
    expect(show(moveImage(doc('<a>xy<b>z'), 1, 0))).toBe('<b><a>xy' + 'z');
    expect(show(moveImage(doc('x<a>yz'), 0, 3))).toBe('xy<a>z');
    expect(moveImage(doc('x<a>yz'), 0, 3).images[0]).toEqual(a);
  });
  it('renumbers by position only: after a move the images are in the new order', () => {
    const d = moveImage(doc('<a>x<b>'), 1, 0);
    expect(d.images.map((i) => i.res)).toEqual(['b', 'a']);
  });
  it('a move to where it already is changes nothing', () => {
    expect(show(moveImage(doc('x<a>y'), 0, 1))).toBe('x<a>y');
    expect(show(moveImage(doc('x<a>y'), 0, 2))).toBe('x<a>y');
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
    expect(offsetOfImage(d, 1)).toBe(3);
    expect(offsetOfImage(d, 2)).toBe(-1);
    const twice: Doc = { text: `${IMG}${IMG}`, images: [{ occ: '1', res: 'r' }, { occ: '2', res: 'r' }] };
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
    ['the same resource twice is two occurrences with one path', { text: `${IMG}${IMG}`, images: [o('1', 'a'), o('2', 'a')] }, '[Image #1: /d/a.png][Image #2: /d/a.png]'],
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
    expect(text(ser(removeImage(doc('<a> and <b>'), 0)))).toBe(' and [Image #1: /d/b.webp]');
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
    expect(serializeErrorText({ kind: 'too_long', bytes: 33000, max: 32768 })).toBe('The prompt is 32.2 KB with the image paths. The limit is 32 KB: shorten the text.');
    expect(serializeErrorText({ kind: 'bad_path', res: 'a', path: 'x', reason: 'the path is not absolute' })).toMatch(/not absolute/);
  });
});
