// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import type { RepoRef, RepoRefsState } from '../net/protocol';
import type { Token } from '../ui/composer/complete';
import { repoInsert, repoRow, repoSource, type RepoItem, type RepoSearchHost } from './repoSearch';

// #247: the `@r:` source on its own: the bridge's rows (each row of the issue's table), what a pick puts in, the
// ranking and the list's states.

const ref = (session: string, o: Partial<RepoRef> = {}): RepoRef => ({ session, building: 'Work', same_building: true, cloned: false, ...o });
const ok = (repos: unknown): CommandResult => ({ ok: true, data: { repos } });
const flush = () => new Promise((r) => setTimeout(r, 0));

function bridge(refs: { state: RepoRefsState | null; onChange(f: () => void): () => void } | null = null) {
  const waiting: ((r: CommandResult) => void)[] = [];
  const asks: unknown[] = [];
  const host: RepoSearchHost = {
    send: (_t, args) => {
      asks.push(args);
      return new Promise<CommandResult>((res) => waiting.push(res));
    },
    refs,
  };
  return {
    host,
    asks,
    async answer(i: number, r: CommandResult) {
      waiting[i]?.(r);
      await flush();
    },
  };
}

const token = (text: string): Token => ({ trigger: '@', start: text.indexOf('@'), end: text.length, query: text.slice(text.indexOf('@') + 1) });
const signal = new AbortController().signal;
const sessions = (xs: readonly RepoItem[]) => xs.map((x) => x.item.session);

describe('the rows and what a pick puts in', () => {
  const cases: { name: string; r: RepoRef; label: string; floor: string; note: boolean; insert: string }[] = [
    { name: 'a repo cloned in its folder', r: ref('api', { repo: 'acme/api-server', dir: '/home/me/src/api', cloned: true }), label: 'acme/api-server', floor: 'api', note: false, insert: '/home/me/src/api' },
    { name: 'a repo with no folder', r: ref('web', { repo: 'acme/web' }), label: 'acme/web', floor: 'web', note: true, insert: 'https://github.com/acme/web' },
    { name: 'a repo whose folder is not a checkout of it', r: ref('web', { repo: 'acme/web', dir: '/home/me/src/other' }), label: 'acme/web', floor: 'web', note: true, insert: 'https://github.com/acme/web' },
    { name: 'only a folder', r: ref('docs', { dir: '/home/me/notes' }), label: 'notes', floor: 'docs', note: false, insert: '/home/me/notes' },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const row = repoRow({ item: c.r, hits: [], key: 0 });
      expect(row.querySelector('.tx-repo-label')?.textContent).toBe(c.label);
      expect(row.querySelector('.tx-repo-floor')?.textContent).toBe(c.floor);
      expect(!!row.querySelector('.tx-repo-note')).toBe(c.note);
      expect(repoInsert(c.r)).toBe(c.insert);
    });
  }

  it('the repo name is bold (its own span) and the owner is not; a folder-only row shows the whole path too', () => {
    const row = repoRow({ item: ref('api', { repo: 'acme/api' }), hits: [], key: 0 });
    expect(row.querySelector('.tx-repo-owner')?.textContent).toBe('acme/');
    expect(row.querySelector('.tx-repo-name')?.textContent).toBe('api');
    expect(row.textContent).toBe('acme/api api not cloned');
    const dir = repoRow({ item: ref('docs', { dir: '/home/me/notes/' }), hits: [], key: 0 });
    expect(dir.querySelector('.tx-repo-name')?.textContent).toBe('notes');
    expect(dir.querySelector('.tx-repo-dir')?.textContent).toBe('/home/me/notes/');
  });

  it('another building’s floor says which building', () => {
    const row = repoRow({ item: ref('lib', { repo: 'acme/lib', building: 'Home', same_building: false }), hits: [], key: 0 });
    expect(row.querySelector('.tx-repo-floor')?.textContent).toBe('lib · Home');
    expect(repoRow({ item: ref('lot', { dir: '/x', building: null }), hits: [], key: 0 }).querySelector('.tx-repo-floor')?.textContent).toBe('lot');
  });

  it('marks the matched characters of the key that matched', () => {
    const hits = (it: RepoItem) => [...repoRow(it).querySelectorAll('.tx-repo-hit')].map((e) => [e.parentElement?.className, e.textContent]);
    const r = ref('api', { repo: 'acme/api-server', dir: '/src/api', cloned: true });
    expect(hits({ item: r, key: 0, hits: [0, 1, 4, 7] })).toEqual([
      ['tx-repo-name', 'ap'],
      ['tx-repo-name', 's'],
      ['tx-repo-name', 'v'],
    ]);
    expect(hits({ item: r, key: 1, hits: [3, 4, 5] })).toEqual([
      ['tx-repo-owner', 'e/'],
      ['tx-repo-name', 'a'],
    ]);
    expect(hits({ item: r, key: 4, hits: [0] })).toEqual([['tx-repo-floor', 'a']]);
    const d = ref('docs', { dir: '/home/notes' });
    expect(hits({ item: d, key: 2, hits: [0, 1] })).toEqual([['tx-repo-name', 'no']]);
    expect(hits({ item: d, key: 3, hits: [1] })).toEqual([['tx-repo-dir', 'h']]);
  });

  it('quotes a path with whitespace; a space follows every pick (or the caret goes past one already there)', () => {
    expect(repoInsert(ref('d', { dir: '/home/me/My Notes' }))).toBe('"/home/me/My Notes"');
    expect(repoInsert(ref('d', { repo: 'a/b', dir: '/home/me/a b', cloned: true }))).toBe('"/home/me/a b"');
    const src = repoSource('w1', bridge().host);
    const it = { item: ref('d', { dir: '/x' }), hits: [], key: 0 };
    expect(src.insert(it, token('see @r:x'), 'see @r:x')).toEqual({ text: '/x ' });
    expect(src.insert(it, token('see @r:x'), 'see @r:x and')).toEqual({ text: '/x ', end: 9 });
  });
});

describe('the bridge’s list', () => {
  it('asks once per popup, ranks locally, repo name first, with the subsequence tier', async () => {
    const b = bridge();
    const src = repoSource('w1', b.host);
    src.opening?.();
    const first = src.items('', signal);
    expect(b.asks).toEqual([{ id: 'w1' }]);
    await b.answer(
      0,
      ok([
        ref('servers', { dir: '/srv/api-docs' }),
        ref('api', { repo: 'acme/api-server' }),
        ref('web', { repo: 'acme/web', dir: '/src/web', cloned: true }),
        ref('apsv', { repo: 'other/thing' }),
      ]),
    );
    expect(sessions(await first)).toEqual(['servers', 'api', 'web', 'apsv']);
    expect(sessions(src.items('apsv', signal) as RepoItem[])).toEqual(['apsv', 'api']);
    expect(sessions(src.items('api', signal) as RepoItem[])).toEqual(['api', 'servers']);
    expect(b.asks).toHaveLength(1);
    // The next popup asks again; meanwhile the known rows answer at once.
    src.opening?.();
    expect(sessions(src.items('web', signal) as RepoItem[])).toEqual(['web']);
    expect(b.asks).toHaveLength(2);
  });

  it('drops rows it cannot offer: a path with a quote or a line break, a malformed repo; a bad folder of a repo leaves its URL', async () => {
    const b = bridge();
    const src = repoSource('w1', b.host);
    const p = src.items('', signal);
    await b.answer(
      0,
      ok([
        ref('quote', { dir: '/a"b' }),
        ref('nl', { dir: '/a\nb' }),
        ref('bad', { repo: 'not a repo' }),
        ref('url', { repo: 'acme/x', dir: '/a"b', cloned: true }),
        { building: 'Work' },
      ]),
    );
    const got = (await p) as RepoItem[];
    expect(sessions(got)).toEqual(['url']);
    expect(got[0]?.item).toMatchObject({ repo: 'acme/x', cloned: false });
  });

  it('Loading… then the rows; a failed first ask is an error; a failed refresh keeps the rows with a note', async () => {
    const b = bridge();
    const src = repoSource('w1', b.host);
    const p = src.items('', signal);
    expect(Array.isArray(p)).toBe(false);
    // Handled before it settles, as the popup does (else the rejection is unhandled while the answer is flushed).
    const failed = expect(p).rejects.toThrow();
    await b.answer(0, { ok: false, code: 'internal', message: 'x' });
    await failed;
    // The next popup asks again.
    src.opening?.();
    const p2 = src.items('', signal);
    await b.answer(1, ok([ref('a', { repo: 'acme/a' })]));
    expect(sessions(await p2)).toEqual(['a']);
    src.opening?.();
    src.items('', signal);
    await b.answer(2, { ok: false, code: 'timeout', message: 'slow' });
    expect(sessions(src.items('', signal) as RepoItem[])).toEqual(['a']);
    expect(src.footer?.()).toBe('Could not refresh: the list may be out of date');
  });

  it('an empty list says which floors it looked at', async () => {
    let state: RepoRefsState | null = { all_buildings: false };
    const fs = new Set<() => void>();
    const b = bridge({
      get state() {
        return state;
      },
      onChange: (f) => (fs.add(f), () => fs.delete(f)),
    });
    const src = repoSource('w1', b.host);
    let told = 0;
    const off = src.subscribe?.(() => told++);
    const p = src.items('', signal);
    await b.answer(0, ok([]));
    expect(await p).toEqual([]);
    expect(src.footer?.()).toBe('No other floors in this building have a repository or folder');
    // The shared switch changes: the popup asks its query again, and the source asks the bridge again.
    state = { all_buildings: true };
    const before = told;
    for (const f of fs) f();
    expect(told).toBe(before + 1);
    src.items('', signal);
    expect(b.asks).toHaveLength(2);
    await b.answer(1, ok([]));
    expect(src.footer?.()).toBe('No other floors have a repository or folder');
    off?.();
    expect(fs.size).toBe(0);
  });
});
