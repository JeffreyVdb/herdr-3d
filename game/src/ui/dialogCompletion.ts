import type { CommandResult } from '../net/client';
import type { CommandArgs, CommandName } from '../net/protocol';
import { atSource } from '../laptop/atSource';
import type { CommandCatalogs } from '../laptop/commandCatalog';
import { fileSource } from '../laptop/fileSearch';
import { repoSource, type RepoSearchHost } from '../laptop/repoSearch';
import { commandSource } from '../laptop/slashCommands';
import type { ReplaceSpec, Source, Token, Trigger } from './composer/complete';

/**
 * #39: `/` skills, `@` files and `@r:` repositories in the Hire worker, Start run and Prompt dialogs: the transcript's
 * sources (`slashCommands.ts`, `fileSearch.ts`, `repoSearch.ts`, `atSource.ts`) over the dialog's lookup context
 * instead of a seated worker.
 *
 * - A hire has no worker yet: its context is the floor, the harness and the folder the hire would get (a worktree
 *   hire's repository root, where the worktree is made from), asked with `hire.commands`, `hire.files` and
 *   `hire.repos`. The Prompt overlay's is its worker (`worker.commands`, `worker.files`, `worker.repos`), its list
 *   shared with the transcript (one `CommandCatalogs`, the app's).
 * - The context is read live (`key`): a change (another floor, harness, folder, the worktree box) is a new context
 *   with sources of its own (kept for the next time it comes back, a few at most) and a new generation. An open popup
 *   asks its query again in the new context (its rows dim, none can be picked meanwhile). A reply of the old context
 *   is dropped when it comes, and a row of the old context can never be put in: every row carries the generation it
 *   was listed in, and a pick of an older one changes nothing.
 * - Nothing is asked before the popup opens (a dialog opens and hires without waiting for any lookup); a lookup that
 *   is slow, fails or times out shows only in the popup ("Loading skills…", the failure and "Try again").
 */

export interface LookupHost {
  send<T extends CommandName>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  /** An older bridge without the op: its source is left out. */
  unsupported?(t: CommandName): boolean;
  /** The lists of commands and skills, shared with the transcript. */
  catalogs: CommandCatalogs;
  /** The shared "Repositories from other buildings" switch (`@r:`'s empty-list note, and a change asks again). */
  repoRefs: NonNullable<RepoSearchHost['refs']> | null;
  /** #54: repository discovery (`@r:`'s label and notes, and a new revision asks again; none: as if off). */
  repoDiscovery?: NonNullable<RepoSearchHost['discovery']> | null;
}

/** The sources of one context, per trigger (null: that trigger opens nothing here). */
export interface ContextSources {
  '/': Source | null;
  '@': Source | null;
}

/** A row as the dialog's popup has it: the context's own item, and the generation it was listed in. */
interface Tagged {
  gen: number;
  src: Source;
  item: unknown;
}

/** How many contexts' sources are kept (a switch back to one shows what it had). */
const KEEP = 8;
const SKILL_HARNESSES = new Set(['claude', 'codex']);

export class CompletionScope {
  private gen = 0;
  private last: string | null | undefined = undefined;
  private cur: { key: string; s: ContextSources; offs: (() => void)[] } | null = null;
  private readonly kept = new Map<string, { key: string; s: ContextSources; offs: (() => void)[] }>();
  private readonly listeners: Record<Trigger, Set<() => void>> = { '/': new Set(), '@': new Set() };
  /** The composer's `complete.sources`: one per trigger, following the context. */
  readonly sources: readonly Source[];

  /** `key`: the context now (null: none yet, nothing opens); `make`: its sources. */
  constructor(
    private readonly key: () => string | null,
    private readonly make: (key: string) => ContextSources,
  ) {
    this.sources = [this.proxy('/'), this.proxy('@')];
  }

  /** The dialog changed something that may be part of the context: an open popup follows it. */
  check(): void {
    this.current();
  }

  /** The generation of the context now (test hook). */
  get generation(): number {
    this.current();
    return this.gen;
  }

  private current(): { gen: number; s: ContextSources } | null {
    const k = this.key();
    if (k !== this.last) {
      this.last = k;
      this.gen++;
      this.cur = k === null ? null : this.bundle(k);
      this.notify('/');
      this.notify('@');
    }
    return this.cur ? { gen: this.gen, s: this.cur.s } : null;
  }

  private bundle(key: string): { key: string; s: ContextSources; offs: (() => void)[] } {
    let b = this.kept.get(key);
    if (b) this.kept.delete(key);
    else {
      const s = this.make(key);
      const made: { key: string; s: ContextSources; offs: (() => void)[] } = { key, s, offs: [] };
      for (const t of ['/', '@'] as const) {
        const off = s[t]?.subscribe?.(() => {
          if (this.cur === made) this.notify(t);
        });
        if (off) made.offs.push(off);
      }
      b = made;
    }
    this.kept.set(key, b);
    for (const [k, old] of this.kept) {
      if (this.kept.size <= KEEP) break;
      if (old === b) continue;
      this.kept.delete(k);
      for (const off of old.offs) off();
    }
    return b;
  }

  /** Tells an open popup of trigger `t` (after the current call: never inside the popup's own query). */
  private notify(t: Trigger): void {
    queueMicrotask(() => {
      for (const f of [...this.listeners[t]]) f();
    });
  }

  private proxy(t: Trigger): Source<Tagged> {
    const src = (): Source | null => this.current()?.s[t] ?? null;
    const fallback = t === '/' ? 'Commands and skills' : 'Files and folders';
    // The generation a popup last opened in: a popup still open in a newer one opens that context's source first (its list is asked then).
    let opened = -1;
    return {
      trigger: t,
      get label() {
        return src()?.label ?? fallback;
      },
      available: () => {
        const s = src();
        return !!s && s.available?.() !== false;
      },
      opening: () => {
        opened = this.current()?.gen ?? -1;
        src()?.opening?.();
      },
      subscribe: (f) => {
        this.listeners[t].add(f);
        return () => this.listeners[t].delete(f);
      },
      key: (x) => `${x.gen}:${x.src.key?.(x.item) ?? ''}`,
      items: (q, signal) => {
        const c = this.current();
        const s = c?.s[t];
        if (!c || !s) return Promise.reject(new Error('no lookup context'));
        if (c.gen !== opened) {
          opened = c.gen;
          s.opening?.();
        }
        const tag = (xs: readonly unknown[]): Tagged[] => xs.map((item) => ({ gen: c.gen, src: s, item }));
        const r = s.items(q, signal);
        if (Array.isArray(r)) return tag(r as readonly unknown[]);
        return Promise.resolve(r).then((xs) => {
          // An answer for a context the dialog has left: never shown.
          if (this.current()?.gen !== c.gen) throw new Error('stale lookup context');
          return tag(xs);
        });
      },
      render: (x) => x.src.render(x.item),
      insert: (x: Tagged, token: Token, text: string): ReplaceSpec => {
        // A row of an older context: nothing goes in (the token stays as typed).
        if (this.current()?.gen !== x.gen) return { text: text.slice(token.start, token.end), start: token.start, end: token.end };
        return x.src.insert(x.item, token, text);
      },
      footer: () => src()?.footer?.() ?? null,
      loading: () => src()?.loading?.() ?? 'Loading…',
      failure: () => src()?.failure?.() ?? 'Could not load matches.',
      retry: () => src()?.retry?.(),
    };
  }
}

/** What a hire would get, as its dialog knows it: `cwd` `worker.hire`'s, as typed (none: the floor's default). */
export interface HireLookup {
  session: string;
  harness: string;
  cwd?: string;
  worktree: boolean;
}

/** The key of a hire's lookup context. */
export function hireLookupKey(l: HireLookup): string {
  return JSON.stringify(['hire', l.session, l.harness, l.cwd ?? '', l.worktree]);
}

/** A hire's sources: `hire.commands` for its harness (Claude or Codex), `hire.files` in its folder, `hire.repos` of its floor. */
export function hireSources(host: LookupHost, l: HireLookup): ContextSources {
  const where = { session: l.session, ...(l.cwd ? { cwd: l.cwd } : {}), ...(l.worktree ? { worktree: true } : {}) };
  const key = hireLookupKey(l);
  const has = (t: CommandName) => !host.unsupported?.(t);
  const commands =
    SKILL_HARNESSES.has(l.harness) && has('hire.commands')
      ? commandSource(
          host.catalogs.context(key, () => host.send('hire.commands', { ...where, harness: l.harness })),
          l.harness,
        )
      : null;
  const files = has('hire.files') ? fileSource(key, { send: (_t, a) => host.send('hire.files', { ...where, query: a.query, ...(a.limit !== undefined ? { limit: a.limit } : {}) }) }) : null;
  const repos = has('hire.repos') ? repoSource(key, { send: () => host.send('hire.repos', { session: l.session }), refs: host.repoRefs, discovery: host.repoDiscovery ?? null }) : null;
  return { '/': commands, '@': files && repos ? atSource(files, repos) : files };
}

/** A worker's sources (the Prompt overlay): the transcript's, over its id; `/` only for a Claude or Codex agent. */
export function workerSources(host: LookupHost, id: string, harness: string | undefined): ContextSources {
  const send = <T extends 'worker.files' | 'worker.repos'>(t: T, a: CommandArgs[T]) => host.send(t, a);
  return {
    '/': harness && SKILL_HARNESSES.has(harness) ? commandSource(host.catalogs.get(id), harness) : null,
    '@': atSource(fileSource(id, { send }), repoSource(id, { send, refs: host.repoRefs, discovery: host.repoDiscovery ?? null })),
  };
}
