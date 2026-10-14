import { describe, expect, it } from 'vitest';
import type { Source, Token } from './composer/complete';
import { CompletionScope, hireLookupKey, hireSources, type ContextSources, type LookupHost } from './dialogCompletion';
import { CommandCatalogs } from '../laptop/commandCatalog';

// #39: the dialogs' completion follows a context read live; a row or a reply of a context the dialog has left never
// goes in or shows.

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A source whose items are its context's name, at once or from a promise the test answers. */
function named(name: string, later: ((v: string[]) => void)[] | null = null): Source<string> {
  return {
    trigger: '/',
    items: () => (later ? new Promise<string[]>((res) => later.push(res)) : [name]),
    render: (x) => x,
    insert: (x) => ({ text: `/${x} ` }),
  };
}

const token: Token = { trigger: '/', start: 0, end: 2, query: 'x' };

describe('CompletionScope', () => {
  it('a row listed in one context puts nothing in once the context changed', async () => {
    let ctx: string | null = 'a';
    const scope = new CompletionScope(
      () => ctx,
      (k): ContextSources => ({ '/': named(k), '@': null }),
    );
    const slash = scope.sources[0] as Source<unknown>;
    const rows = (await slash.items('x', new AbortController().signal)) as unknown[];
    expect(slash.insert(rows[0], token, '/x')).toEqual({ text: '/a ' });
    ctx = 'b';
    expect(slash.insert(rows[0], token, '/x')).toEqual({ text: '/x', start: 0, end: 2 });
    const fresh = (await slash.items('x', new AbortController().signal)) as unknown[];
    expect(slash.insert(fresh[0], token, '/x')).toEqual({ text: '/b ' });
  });

  it('a reply for a context the dialog has left is dropped; the popup is told to ask again', async () => {
    let ctx: string | null = 'a';
    const later: ((v: string[]) => void)[] = [];
    const scope = new CompletionScope(
      () => ctx,
      (k): ContextSources => ({ '/': named(k, later), '@': null }),
    );
    const slash = scope.sources[0] as Source<unknown>;
    let told = 0;
    slash.subscribe?.(() => told++);
    const pending = slash.items('x', new AbortController().signal) as Promise<unknown[]>;
    ctx = 'b';
    scope.check();
    later[0]!(['a']);
    await expect(pending).rejects.toThrow(/stale/);
    await flush();
    expect(told).toBeGreaterThan(0);
  });

  it('no context: nothing opens', () => {
    const scope = new CompletionScope(
      () => null,
      (): ContextSources => ({ '/': named('a'), '@': null }),
    );
    expect(scope.sources.map((s) => s.available?.())).toEqual([false, false]);
  });

  it('a hire context asks the hire ops with its floor, harness and folder; a non-agent harness has no `/`', () => {
    const sent: [string, unknown][] = [];
    const host: LookupHost = {
      send: (t, args) => {
        sent.push([t, args]);
        return new Promise(() => {});
      },
      catalogs: new CommandCatalogs({ send: () => new Promise(() => {}) }),
      repoRefs: null,
    };
    const l = { session: 's', harness: 'codex', cwd: '/w', worktree: true };
    const s = hireSources(host, l);
    s['/']?.opening?.();
    expect(sent).toEqual([['hire.commands', { session: 's', cwd: '/w', worktree: true, harness: 'codex' }]]);
    expect(hireSources(host, { ...l, harness: 'shell' })['/']).toBeNull();
    expect(hireLookupKey(l)).not.toBe(hireLookupKey({ ...l, worktree: false }));
    // The same context is the same list (asked once), another one its own.
    expect(host.catalogs.context(hireLookupKey(l), () => new Promise(() => {}))).toBe(host.catalogs.context(hireLookupKey(l), () => new Promise(() => {})));
    expect(host.unsupported).toBeUndefined();
    const old: LookupHost = { ...host, unsupported: (t) => t.startsWith('hire.') };
    expect(hireSources(old, l)).toEqual({ '/': null, '@': null });
  });
});
