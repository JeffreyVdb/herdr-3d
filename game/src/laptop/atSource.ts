import type { FileMatch } from '../net/protocol';
import type { Source } from '../ui/composer/complete';
import type { RepoItem } from './repoSearch';

/**
 * #247: the transcript composer's one `@` source (the popup has one source per trigger, `completion.ts`): a query
 * that starts with `r:` or `repo:` lists the repositories on other floors (`repoSearch.ts`) with that prefix taken
 * off, anything else searches the worker's files as before (`fileSearch.ts`). `@r` and `@repo` without the colon, and
 * `@./r:x`, are file searches. The label follows the query, and a row's key names its side, so switching between them
 * never keeps a stale active row. The files' footer, when it has nothing to say, tells you about `r:`.
 */

export type AtItem = { via: 'file'; item: FileMatch } | { via: 'repo'; item: RepoItem };

/** The prefix that turns an `@` query into a repository one. */
export const REPO_PREFIX = /^(?:r|repo):/;
export const REPO_HINT = 'Type r: for repositories on other floors';

export function atSource(files: Source<FileMatch>, repos: Source<RepoItem>): Source<AtItem> {
  let mode: 'file' | 'repo' = 'file';
  const wrap = <T>(via: AtItem['via'], r: readonly T[] | Promise<readonly T[]>) => {
    const tag = (xs: readonly T[]) => xs.map((item) => ({ via, item }) as AtItem);
    return Array.isArray(r) ? tag(r as readonly T[]) : (r as Promise<readonly T[]>).then(tag);
  };
  return {
    trigger: '@',
    get label() {
      return (mode === 'repo' ? repos.label : files.label) ?? 'Suggestions';
    },
    key: (x) => (x.via === 'repo' ? `repo:${repos.key?.(x.item) ?? ''}` : `file:${files.key?.(x.item) ?? ''}`),
    opening() {
      mode = 'file';
      files.opening?.();
      repos.opening?.();
    },
    subscribe(changed) {
      // Only the side the popup shows: the other one's news would ask the query again for nothing.
      const offs = [files.subscribe?.(() => mode === 'file' && changed()), repos.subscribe?.(() => mode === 'repo' && changed())];
      return () => offs.forEach((off) => off?.());
    },
    items(q, signal) {
      const m = REPO_PREFIX.exec(q);
      mode = m ? 'repo' : 'file';
      return m ? wrap('repo', repos.items(q.slice(m[0].length), signal)) : wrap('file', files.items(q, signal));
    },
    render: (x) => (x.via === 'repo' ? repos.render(x.item) : files.render(x.item)),
    insert: (x, token, text) => (x.via === 'repo' ? repos.insert(x.item, token, text) : files.insert(x.item, token, text)),
    footer: () => (mode === 'repo' ? (repos.footer?.() ?? null) : (files.footer?.() ?? REPO_HINT)),
  };
}
