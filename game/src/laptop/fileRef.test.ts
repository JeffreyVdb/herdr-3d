import { describe, expect, it } from 'vitest';
import { decodePercent, fileRefPath, resolveFileRef } from './fileRef';

// #31: which link destinations are file references, the path each one is, and a relative one against the checkout.
describe('fileRefPath', () => {
  it.each([
    ['/tmp/herdr-remote-runtime-handoff-2026-10-09.md', '/tmp/herdr-remote-runtime-handoff-2026-10-09.md'],
    ['/tmp/a%20b.md', '/tmp/a b.md'],
    ['/tmp/%E6%97%A5%E6%9C%AC.md', '/tmp/日本.md'],
    ['/tmp/100%.md', '/tmp/100%.md'],
    ['/tmp/bad%E6%97.md', '/tmp/bad%E6%97.md'],
    ['/tmp/a%23b.md', '/tmp/a#b.md'],
    ['~/notes.md', '~/notes.md'],
    ['./docs/handoff.md', './docs/handoff.md'],
    ['../up.md', '../up.md'],
    ['docs/x.md', 'docs/x.md'],
    ['README.md', 'README.md'],
    ['src/app.ts#L42', 'src/app.ts'],
    ['file:///tmp/a%20b.md', '/tmp/a b.md'],
    ['file://localhost/tmp/x.md', '/tmp/x.md'],
    ['FILE:/tmp/x.md', '/tmp/x.md'],
    ['file:///tmp/x.md?raw#top', '/tmp/x.md'],
    ['file:///C:/Users/me/a.md', 'C:/Users/me/a.md'],
    ['C:\\Users\\me\\a.md', 'C:\\Users\\me\\a.md'],
    ['  /tmp/trimmed.md ', '/tmp/trimmed.md'],
  ])('%s is the file %s', (href, path) => {
    expect(fileRefPath(href)).toBe(path);
  });

  it.each([
    'https://example.com/x.md',
    'http://example.com',
    'mailto:me@example.com',
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox',
    'blob:https://example.com/1',
    'app.ts:42',
    'javascript%3Aalert(1)',
    '//evil.example/x.md',
    '\\\\server\\share\\x.md',
    'file://server/share/x.md',
    'file:relative.md',
    'file://localhost',
    '#section',
    '?q=1',
    '/tmp/a%0Ab.md',
    '/%2Fevil.example/x',
    '',
    '   ',
    `/${'x'.repeat(5000)}`,
  ])('%s is not a file reference', (href) => {
    expect(fileRefPath(href)).toBeNull();
  });
});

describe('decodePercent', () => {
  it('decodes valid escapes and never throws on malformed ones', () => {
    expect(decodePercent('a%20b%2')).toBe('a b%2');
    expect(decodePercent('%ZZ%')).toBe('%ZZ%');
    expect(decodePercent('%C3%A9')).toBe('é');
    expect(decodePercent('%C3')).toBe('%C3');
  });
});

describe('resolveFileRef', () => {
  const cwd = '/home/dev/devel/herdr-3d';
  it('joins a relative path to the checkout, resolving . and ..', () => {
    expect(resolveFileRef('docs/x.md', cwd)).toBe('/home/dev/devel/herdr-3d/docs/x.md');
    expect(resolveFileRef('./docs/./x.md', cwd)).toBe('/home/dev/devel/herdr-3d/docs/x.md');
    expect(resolveFileRef('../other/y.md', cwd)).toBe('/home/dev/devel/other/y.md');
    expect(resolveFileRef('../../../../../../etc/z', cwd)).toBe('/etc/z');
    expect(resolveFileRef('docs/', `${cwd}/`)).toBe('/home/dev/devel/herdr-3d/docs/');
    expect(resolveFileRef('a b/é.md', cwd)).toBe('/home/dev/devel/herdr-3d/a b/é.md');
  });
  it('keeps an absolute path, and a relative one when the checkout is unknown', () => {
    expect(resolveFileRef('/tmp/a.md', cwd)).toBe('/tmp/a.md');
    expect(resolveFileRef('~/a.md', cwd)).toBe('~/a.md');
    expect(resolveFileRef('docs/x.md', null)).toBe('docs/x.md');
    expect(resolveFileRef('docs/x.md', '')).toBe('docs/x.md');
    // Never against something that is not a path (the page's origin least of all).
    expect(resolveFileRef('docs/x.md', 'relative/cwd')).toBe('docs/x.md');
  });
});
