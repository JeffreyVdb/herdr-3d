import { describe, expect, it } from 'vitest';
import { AT_QUERY_MAX, findToken, replaceRangeOf } from './complete';
import { caret, IMG } from './model';

/** `|` marks the caret; the token found there (or null). */
const at = (marked: string, triggers: ReadonlyArray<'/' | '@'> = ['/', '@']) => {
  const i = marked.indexOf('|');
  return findToken(marked.slice(0, i) + marked.slice(i + 1), caret(i), triggers);
};

describe('findToken: where a trigger opens', () => {
  it('opens at the start of the text', () => {
    expect(at('/|')).toEqual({ trigger: '/', start: 0, end: 1, query: '' });
    expect(at('/he|')).toEqual({ trigger: '/', start: 0, end: 3, query: 'he' });
    expect(at('@|')).toEqual({ trigger: '@', start: 0, end: 1, query: '' });
  });

  it('opens right after a space, a tab or a newline', () => {
    expect(at('run /he|')).toEqual({ trigger: '/', start: 4, end: 7, query: 'he' });
    expect(at('look\t@ma|')).toEqual({ trigger: '@', start: 5, end: 8, query: 'ma' });
    expect(at('one\n/x|')).toEqual({ trigger: '/', start: 4, end: 6, query: 'x' });
  });

  it('opens right after an image chip: a chip is a word boundary', () => {
    expect(at(`${IMG}/he|`)).toEqual({ trigger: '/', start: 1, end: 4, query: 'he' });
    expect(at(`see ${IMG}@src|`)).toEqual({ trigger: '@', start: 5, end: 9, query: 'src' });
  });

  it('never opens mid-word: paths, a/b, URLs, emails', () => {
    expect(at('a/|')).toBeNull();
    expect(at('a/b|')).toBeNull();
    expect(at('/usr/bin|')).toBeNull();
    expect(at('see /usr/|')).toBeNull();
    expect(at('http://x/y|')).toBeNull();
    expect(at('http:/|')).toBeNull();
    expect(at('me@x.com|')).toBeNull();
    expect(at('me@|')).toBeNull();
    expect(at('(@x|')).toBeNull();
  });

  it('opens only for the triggers asked for', () => {
    expect(at('/x|', ['@'])).toBeNull();
    expect(at('@x|', ['/'])).toBeNull();
    expect(at('/x|', [])).toBeNull();
  });
});

describe('findToken: the query', () => {
  it('a / query ends at whitespace', () => {
    expect(at('/help me|')).toBeNull();
    expect(at('/help |')).toBeNull();
  });

  it('an @ query may contain spaces (file names have them)', () => {
    expect(at('@my file|')).toEqual({ trigger: '@', start: 0, end: 8, query: 'my file' });
    expect(at('fix @src/My Doc|')).toEqual({ trigger: '@', start: 4, end: 15, query: 'src/My Doc' });
  });

  it('an @ query ends at a newline, a chip or the length cap', () => {
    expect(at('@a\nb|')).toBeNull();
    expect(at(`@a${IMG}b|`)).toBeNull();
    const long = 'x'.repeat(AT_QUERY_MAX);
    expect(at(`@${long}|`)?.query).toBe(long);
    expect(at(`@${long}y|`)).toBeNull();
  });

  it('the nearest trigger decides', () => {
    // A later trigger at a boundary wins over an earlier @ whose query would reach it.
    expect(at('@my /x|')).toEqual({ trigger: '/', start: 4, end: 6, query: 'x' });
    // A mid-word @ before the caret stops the search: it does not reach back to the earlier one.
    expect(at('@foo me@x|')).toBeNull();
    // A trigger inside the other's query is just a character of it.
    expect(at('/a@b|')).toEqual({ trigger: '/', start: 0, end: 4, query: 'a@b' });
    expect(at('@src/li|')).toEqual({ trigger: '@', start: 0, end: 7, query: 'src/li' });
  });

  it('keeps trailing punctuation in the query', () => {
    expect(at('/help.|')).toEqual({ trigger: '/', start: 0, end: 6, query: 'help.' });
    expect(at('@file,|')).toEqual({ trigger: '@', start: 0, end: 6, query: 'file,' });
  });
});

describe('findToken: the caret', () => {
  it('a caret before the trigger is outside the token', () => {
    expect(at('|/help')).toBeNull();
    expect(at('a |/help')).toBeNull();
  });

  it('inside the token: the query is up to the caret, the token runs to the end of the word', () => {
    expect(at('/he|lp now')).toEqual({ trigger: '/', start: 0, end: 5, query: 'he' });
    expect(at('@sr|c/x y')).toEqual({ trigger: '@', start: 0, end: 6, query: 'sr' });
    expect(at(`/a|b${IMG}`)).toEqual({ trigger: '/', start: 0, end: 3, query: 'a' });
  });

  it('moving the caret out of the token loses it', () => {
    expect(at('/help |x')).toBeNull();
    expect(at('/help x|')).toBeNull();
    expect(at('/help\n|')).toBeNull();
  });

  it('a selection that is not collapsed has no token', () => {
    expect(findToken('/help', { anchor: 1, focus: 3 }, ['/'])).toBeNull();
    expect(findToken('/help', { anchor: 3, focus: 1 }, ['/'])).toBeNull();
  });

  it('a caret out of range has no token', () => {
    expect(findToken('/x', caret(9), ['/'])).toBeNull();
    expect(findToken('/x', caret(-1), ['/'])).toBeNull();
  });
});

describe('replaceRangeOf', () => {
  const tok = { trigger: '/' as const, start: 4, end: 7, query: 'he' };
  it('defaults to the token', () => {
    expect(replaceRangeOf({ text: '/help ' }, tok, 20)).toEqual([4, 7, '/help ']);
  });
  it('takes the source’s own range, clamped to the document and put in order', () => {
    expect(replaceRangeOf({ text: 'x', start: 0 }, tok, 20)).toEqual([0, 7, 'x']);
    expect(replaceRangeOf({ text: 'x', start: 9, end: 2 }, tok, 20)).toEqual([2, 9, 'x']);
    expect(replaceRangeOf({ text: 'x', start: -3, end: 99 }, tok, 20)).toEqual([0, 20, 'x']);
  });
});
