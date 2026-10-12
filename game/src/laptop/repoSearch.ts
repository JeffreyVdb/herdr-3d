import type { CommandResult } from '../net/client';
import type { CommandArgs, RepoRef, RepoRefsState } from '../net/protocol';
import type { Source } from '../ui/composer/complete';
import { filePathProblem } from '../ui/composer/model';
import { h, ICON, icon } from '../ui/dom';
import { rankByKeys, type KeyRanked } from '../world/rank';

/**
 * #247: the transcript composer's `@r:` (and `@repo:`) source, behind the `@` files (`atSource.ts`): the repositories
 * and folders stored on the other floors of the worker's building, every building's with the shared switch on. The
 * bridge scopes, orders and checks them (`worker.repos`: is the folder a checkout of the repo?); this source ranks them
 * as you type (`rankByKeys`, with the subsequence tier: `apsv` finds `api-server`) and draws them.
 *
 * One ask per popup: `opening` marks the list stale and the first `r:` query asks; the rows already known show at
 * once and follow the answer (`subscribe`). "Loading…" while the first ask is out, a failed first ask an error (the
 * next popup asks again), a failed refresh the old rows and a note, like the `/` source (`slashCommands.ts`). A change
 * of the shared switch asks again (an open popup follows).
 *
 * | The floor has                          | The row                                   | A pick puts in              |
 * | a repo, its folder a checkout of it    | `owner/repo` (the name bold), the floor    | the folder                  |
 * | a repo, no folder or not a checkout    | `owner/repo`, the floor, "not cloned"      | `https://github.com/o/r`    |
 * | only a folder (the bridge saw it)      | the basename, the path, the floor         | the folder                  |
 *
 * Plain text, never a file chip (chips are paths inside the worker's checkout, #138): a path with whitespace goes in
 * double quotes, one with a `"` or a line break is not offered (`filePathProblem`), a space follows the pick.
 */

export interface RepoSearchHost {
  send(t: 'worker.repos', args: CommandArgs['worker.repos']): Promise<CommandResult>;
  /** The shared "Repositories from other buildings" switch: the empty list's note names the floors looked at; a change asks again. */
  refs?: { readonly state: RepoRefsState | null; onChange(f: () => void): () => void } | null;
}

/** A floor's row, ranked: `key` is the match key (0 the repo name, 1 `owner/repo`, 2 the folder's basename, 3 the folder, 4 the floor). */
export type RepoItem = KeyRanked<RepoRef>;

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/** The bridge's rows that can be offered: a known floor, a well-formed repo, a folder a pick can carry whole. */
function refs(v: unknown): RepoRef[] | null {
  if (!Array.isArray(v)) return null;
  const out: RepoRef[] = [];
  for (const r of v) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.session !== 'string' || !o.session) continue;
    const repo = typeof o.repo === 'string' && REPO.test(o.repo) ? o.repo : undefined;
    const dir = typeof o.dir === 'string' && o.dir && filePathProblem(o.dir) === null ? o.dir : undefined;
    if (!repo && !dir) continue;
    out.push({
      session: o.session,
      building: typeof o.building === 'string' ? o.building : null,
      same_building: o.same_building === true,
      ...(repo ? { repo } : {}),
      ...(dir ? { dir } : {}),
      // A folder no pick can carry is no checkout to offer: the URL goes in instead.
      cloned: !!repo && !!dir && o.cloned === true,
    });
  }
  return out;
}

const base = (dir: string): string => dir.replace(/\/+$/, '').split('/').pop() || dir;
/** What a pick puts in (without the space after it). */
export function repoInsert(r: RepoRef): string {
  if (r.repo && !r.cloned) return `https://github.com/${r.repo}`;
  const dir = r.dir ?? '';
  return /\s/.test(dir) ? `"${dir}"` : dir;
}

/** `text` with the characters at `hits` (offsets in it, from `shift`) in their own spans. */
function marked(cls: string, text: string, hits: readonly number[], shift = 0): HTMLElement {
  const on = new Set(hits.map((i) => i - shift));
  const el = h('span', { class: cls });
  let run = '';
  let hit = false;
  const flush = () => {
    if (run) el.append(hit ? h('span', { class: 'tx-repo-hit' }, run) : run);
    run = '';
  };
  for (let i = 0; i < text.length; i++) {
    if (on.has(i) !== hit) {
      flush();
      hit = !hit;
    }
    run += text[i];
  }
  flush();
  return el;
}

/** One row: the glyph, the label (the matched characters marked), the floor dimmed, a repo that is not cloned says so. */
export function repoRow(it: RepoItem): HTMLElement {
  const r = it.item;
  const hit = (k: number) => (it.key === k ? it.hits : []);
  const where = r.same_building || r.building === null ? r.session : `${r.session} · ${r.building}`;
  const floor = marked('tx-repo-floor', where, hit(4));
  const pick = repoInsert(r);
  if (r.repo) {
    const slash = r.repo.indexOf('/');
    const owner = r.repo.slice(0, slash + 1);
    const name = r.repo.slice(slash + 1);
    return h(
      'span',
      { class: 'tx-repo', 'data-kind': 'repo', 'data-cloned': String(r.cloned), title: `${r.repo} on ${where}: puts in ${pick}` },
      icon(ICON.repo),
      h('span', { class: 'tx-repo-label' }, marked('tx-repo-owner', owner, hit(1)), it.key === 0 ? marked('tx-repo-name', name, it.hits) : marked('tx-repo-name', name, hit(1), slash + 1)),
      // Spaces between the parts, for the option's accessible name (a flex row draws none).
      ' ',
      floor,
      r.cloned ? null : ' ',
      r.cloned ? null : h('span', { class: 'tx-repo-note' }, 'not cloned'),
    );
  }
  const dir = r.dir ?? '';
  const name = base(dir);
  return h(
    'span',
    { class: 'tx-repo', 'data-kind': 'dir', title: `${dir} on ${where}` },
    icon(ICON.folder),
    h('span', { class: 'tx-repo-label' }, marked('tx-repo-name', name, hit(2))),
    ' ',
    marked('tx-repo-dir', dir, hit(3)),
    ' ',
    floor,
  );
}

const keysOf = (r: RepoRef): (string | undefined)[] => [r.repo?.slice(r.repo.indexOf('/') + 1), r.repo, r.dir ? base(r.dir) : undefined, r.dir, r.session];

export function repoSource(id: string, host: RepoSearchHost): Source<RepoItem> {
  let list: RepoRef[] | null = null;
  let loading = false;
  let failed = false;
  let stale = true;
  let out: Promise<void> | null = null;
  const subs = new Set<() => void>();
  const tell = () => {
    for (const f of [...subs]) f();
  };

  function refresh(): Promise<void> {
    if (out) return out;
    stale = false;
    loading = true;
    const p = host
      .send('worker.repos', { id })
      .catch((e: unknown): CommandResult => ({ ok: false, code: 'internal', message: String(e) }))
      .then((r) => {
        out = null;
        loading = false;
        const got = r.ok ? refs(((r.data ?? {}) as { repos?: unknown }).repos) : null;
        failed = !got;
        if (got) list = got;
        tell();
      });
    out = p;
    return p;
  }

  const ranked = (q: string): RepoItem[] | null => (list ? rankByKeys(list, q, keysOf, { subsequence: true }) : null);
  const all = () => host.refs?.state?.all_buildings === true;

  return {
    trigger: '@',
    label: 'Repositories on other floors',
    key: (it) => it.item.session,
    // A new popup asks again, when it first lists repositories.
    opening: () => void (stale = true),
    subscribe(f) {
      subs.add(f);
      const off = host.refs?.onChange(() => {
        stale = true;
        f();
      });
      return () => {
        subs.delete(f);
        off?.();
      };
    },
    items(q) {
      if (stale) void refresh();
      const now = ranked(q);
      if (now) return now;
      if (!loading) return Promise.reject(new Error('no list'));
      // The first ask is out: its answer (the popup drops it if the query moved on meanwhile).
      return refresh().then(() => {
        const r = ranked(q);
        if (!r) throw new Error('no list');
        return r;
      });
    },
    render: repoRow,
    insert(it, token, text) {
      // A space already after the word: the caret goes past it rather than a second one going in.
      return { text: `${repoInsert(it.item)} `, ...(text[token.end] === ' ' ? { end: token.end + 1 } : {}) };
    },
    footer() {
      if (failed && list) return 'Could not refresh: the list may be out of date';
      if (list && list.length === 0 && !loading) return all() ? 'No other floors have a repository or folder' : 'No other floors in this building have a repository or folder';
      return null;
    },
  };
}
