import hljs from 'highlight.js/lib/common';
import { describe, expect, it } from 'vitest';
import { diffLanguage, EXT_LANGUAGE, hunkSides, splitHighlighted, tokenizeHunk, tokensText, type LineTokens } from './diffTokens';

/** #206: a diff's syntax colours, the pure half: the language of a path, a hunk's two sides, highlight.js's HTML per line. */

const known = (n: string) => !!hljs.getLanguage(n);
const highlight = (text: string, language: string) => hljs.highlight(text, { language, ignoreIllegals: true }).value;
/** A line's tokens as [classes, text] pairs. */
const pairs = (t: LineTokens | undefined) => {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < (t?.length ?? 0); i += 2) out.push([t?.[i] as string, t?.[i + 1] as string]);
  return out;
};

describe('diffLanguage', () => {
  it('takes the language from the extension: highlight.js aliases, then the map; never from the text', () => {
    expect(diffLanguage('/home/dev/project/src/fetch.py', known)).toBe('py');
    expect(diffLanguage('src/a.go', known)).toBe('go');
    expect(diffLanguage('config/app.toml', known)).toBe('toml');
    expect(diffLanguage('docs/notes.MD', known)).toBe('md');
    expect(diffLanguage('C:\\work\\x.rs', known)).toBe('rs');
    for (const [ext, lang] of [
      ['tsx', 'typescript'],
      ['jsx', 'javascript'],
      ['mjs', 'javascript'],
      ['cjs', 'javascript'],
      ['mts', 'typescript'],
      ['cts', 'typescript'],
      ['pyi', 'python'],
      ['htm', 'xml'],
      ['vue', 'xml'],
      ['mdx', 'markdown'],
      ['jsonl', 'json'],
    ])
      expect(diffLanguage(`src/x.${ext}`, known), ext).toBe(lang);
    expect(diffLanguage('src/app.d.ts', known)).toBe('typescript');
  });

  it('every extension the map pins names a language highlight.js has', () => {
    for (const [ext, lang] of Object.entries(EXT_LANGUAGE)) expect(hljs.getLanguage(lang), `${ext} -> ${lang}`).toBeTruthy();
  });

  it('a missing or unknown extension stays plain', () => {
    for (const p of ['Makefile', 'VERSION', '/home/dev/project/.env', '/home/dev/project/.env.example', 'notes.', 'a.zzz', 'src/dir.ts/README', 'x.foo bar', '', undefined, null, 42]) expect(diffLanguage(p, known), String(p)).toBeNull();
  });
});

describe('hunkSides', () => {
  it('old side is context and deleted lines, new side context and added lines; context rows read the new side', () => {
    const s = hunkSides([' a', '-b', '+B', '+C', ' d', '\\ No newline at end of file', '']);
    expect(s.old).toBe('a\nb\nd\n');
    expect(s.neu).toBe('a\nB\nC\nd\n');
    expect(s.at).toEqual([[1, 0], [0, 1], [1, 1], [1, 2], [1, 3], null, [1, 4]]);
    expect(s.sign).toEqual([1, 1, 1, 1, 1, 0, 0]);
  });

  it('a pure addition has an empty old side; a line with no sign is context as it is', () => {
    const s = hunkSides(['+x', '+y', 'z']);
    expect(s).toMatchObject({ old: 'z', neu: 'x\ny\nz', sign: [1, 1, 0] });
  });
});

describe('splitHighlighted', () => {
  it('closes a span at a line end and opens it again on the next line', () => {
    const lines = splitHighlighted('<span class="hljs-comment">/* a\nb */</span> x');
    expect(lines.map(pairs)).toEqual([[['hljs-comment', '/* a']], [['hljs-comment', 'b */'], ['', ' x']]]);
  });

  it('keeps nested spans as levels, outermost first, and only hljs-* classes', () => {
    const html = '<span class="hljs-string">`a <span class="hljs-subst">${<span class="hljs-title function_">f</span>}</span>\n`</span><span class="language-xml"><span class="hljs-tag">&lt;b&gt;</span></span>';
    expect(splitHighlighted(html).map(pairs)).toEqual([
      [
        ['hljs-string', '`a '],
        ['hljs-string,hljs-subst', '${'],
        ['hljs-string,hljs-subst,hljs-title', 'f'],
        ['hljs-string,hljs-subst', '}'],
      ],
      [
        ['hljs-string', '`'],
        ['hljs-tag', '<b>'],
      ],
    ]);
  });

  it('decodes the entities highlight.js writes, and joins text it split', () => {
    const lines = splitHighlighted('a &lt; b &amp;&amp; c &gt; &quot;d&quot; &#x27;e&#x27; &#39;f&#39; &amp;lt;');
    expect(lines.map(pairs)).toEqual([[['', `a < b && c > "d" 'e' 'f' &lt;`]]]);
  });

  it('empty lines are empty lists, and a trailing newline is one more line', () => {
    expect(splitHighlighted('a\n\nb\n').map(pairs)).toEqual([[['', 'a']], [], [['', 'b']], []]);
    expect(splitHighlighted('')).toEqual([[]]);
  });

  it('a class attribute that is not highlight.js’s own adds no class', () => {
    expect(splitHighlighted('<span class="x onload hljs-">a</span><span class="hljs-keyword evil">b</span>').map(pairs)).toEqual([[['', 'a'], ['hljs-keyword', 'b']]]);
  });
});

describe('tokenizeHunk', () => {
  it('a template literal and a block comment that span rows colour on every row (#206)', () => {
    const lines = ['+const q = `select *', '+  from t', '+  where ${id}`;', ' /* one', '-  two */', '+  three */', ' const n = 1;'];
    const s = hunkSides(lines);
    const t = tokenizeHunk(highlight, 'typescript', s.old, s.neu);
    expect(t).not.toBeNull();
    const row = (i: number) => {
      const at = s.at[i];
      return at && t ? (at[0] ? t.neu : t.old)[at[1]] : undefined;
    };
    // Each row spells its own line.
    lines.forEach((l, i) => expect(tokensText(row(i) as LineTokens)).toBe(l.slice(1)));
    // The string's middle row is all string; its last row, string then the substitution inside it.
    expect(pairs(row(1))).toEqual([['hljs-string', '  from t']]);
    expect(pairs(row(2))[0]).toEqual(['hljs-string', '  where ']);
    expect(pairs(row(2))).toContainEqual(['hljs-string,hljs-subst', '${id}']);
    // The comment: its opening context row, the deleted and the added close (each on its side), all comment.
    expect(pairs(row(3))).toEqual([['hljs-comment', '/* one']]);
    expect(pairs(row(4))).toEqual([['hljs-comment', '  two */']]);
    expect(pairs(row(5))).toEqual([['hljs-comment', '  three */']]);
    // After it, code again: context from the new side.
    expect(pairs(row(6))[0]).toEqual(['hljs-keyword', 'const']);
  });

  it('per line alone the middle of a string would not be one (why sides, not lines)', () => {
    expect(pairs(splitHighlighted(highlight('  from t', 'typescript'))[0])).not.toEqual([['hljs-string', '  from t']]);
  });

  it('null when the highlighter throws or its lines do not match the text', () => {
    expect(tokenizeHunk(() => { throw new Error('x'); }, 'typescript', 'a', 'b')).toBeNull();
    expect(tokenizeHunk(() => 'one line', 'typescript', 'a\nb', '')).toBeNull();
    expect(tokenizeHunk(highlight, 'typescript', '', 'x')).toEqual({ old: [[]], neu: [['', 'x']] });
  });
});
