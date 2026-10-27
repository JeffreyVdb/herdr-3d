import './completionRows.css';
import type { CommandResult } from '../net/client';
import type { CommandArgs, FileMatch, WorkerFiles } from '../net/protocol';
import type { Source } from '../ui/composer/complete';
import { filePathProblem } from '../ui/composer/model';
import { h, icon } from '../ui/dom';
import { duotone } from '../ui/duotone';

/**
 * #141: the transcript composer's `@` source: the files and folders of the worker's checkout, searched by the bridge
 * (`worker.files`, #137) for every query, in the bridge's order (it ranks them). Typing waits `DEBOUNCE_MS` before it
 * asks, and a query the popup has moved on from (its signal aborted) never asks at all; the popup drops any reply that
 * is not its latest and keeps the rows it shows, dimmed, until the next one comes (`completion.ts`).
 *
 * A row is the basename in bold and the folder it is in dimmed, the characters the bridge matched marked (its
 * `indices` count code points of the whole path), a folder with a trailing `/`. A pick puts in an atomic file chip and
 * a space after it (the composer sends it as `@path`). A path that no mention could carry whole (a `"`, a line break, a
 * NUL) is not offered. The bridge's `reason` (an index still building, cut short, no lister) is the popup's footer,
 * and a checkout with no file list (`source: 'none'`) says so there; neither turns the source off: the next `@` asks
 * again.
 */

export interface FileSearchHost {
  send(t: 'worker.files', args: CommandArgs['worker.files']): Promise<CommandResult>;
  /** The debounce's clock (tests pass fake timers' or their own). */
  setTimeout?(f: () => void, ms: number): unknown;
  clearTimeout?(t: unknown): void;
}

/** How long typing must pause before a query goes to the bridge. */
export const DEBOUNCE_MS = 40;
/** How many matches one query asks for (the bridge's own default). */
export const FILES_LIMIT = 30;

/** The bridge's rows that can be offered: a path a chip can hold, a known kind, whole-number indices. */
function matches(v: unknown): FileMatch[] {
  if (!Array.isArray(v)) return [];
  const out: FileMatch[] = [];
  for (const r of v) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.path !== 'string' || filePathProblem(o.path) !== null) continue;
    if (o.kind !== 'file' && o.kind !== 'dir') continue;
    const indices = Array.isArray(o.indices) ? o.indices.filter((i): i is number => Number.isInteger(i)) : [];
    out.push({ path: o.path, kind: o.kind, indices });
  }
  return out;
}

/** `chars` (code points) from `from`, the ones in `hits` (offsets into the whole path) in their own spans. */
function marked(cls: string, chars: readonly string[], from: number, to: number, hits: ReadonlySet<number>, tail = ''): HTMLElement {
  const el = h('span', { class: cls });
  let run = '';
  let on = false;
  const flush = () => {
    if (run) el.append(on ? h('span', { class: 'tx-file-hit' }, run) : run);
    run = '';
  };
  for (let i = from; i < to; i++) {
    if (hits.has(i) !== on) {
      flush();
      on = !on;
    }
    run += chars[i];
  }
  flush();
  if (tail) el.append(tail);
  return el;
}

/** One row: the icon, the basename (a folder's with `/`), the folder it is in. */
export function fileRow(m: FileMatch): HTMLElement {
  const chars = Array.from(m.path);
  const slash = chars.lastIndexOf('/');
  const hits = new Set(m.indices);
  const dir = m.kind === 'dir';
  return h(
    'span',
    { class: 'tx-file', 'data-kind': m.kind, title: dir ? `${m.path}/` : m.path },
    duotone(dir ? 'folder' : 'file'),
    marked('tx-file-name', chars, slash + 1, chars.length, hits, dir ? '/' : ''),
    // A space between the parts, for the option's accessible name (a flex row draws none).
    slash > 0 ? ' ' : null,
    slash > 0 ? marked('tx-file-dir', chars, 0, slash, hits) : null,
    dir ? h('span', { class: 'tx-file-sr' }, ', folder') : null,
  );
}

export function fileSource(id: string, host: FileSearchHost): Source<FileMatch> {
  const later = host.setTimeout ?? ((f: () => void, ms: number) => setTimeout(f, ms));
  const cancel = host.clearTimeout ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let note: string | null = null;
  let failed: string | null = null;

  /** Resolves after the debounce, or rejects at once when the popup has moved on (nothing is asked then). */
  const pause = (signal: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error('aborted'));
      const t = later(() => {
        signal.removeEventListener('abort', stop);
        resolve();
      }, DEBOUNCE_MS);
      const stop = () => {
        cancel(t);
        reject(new Error('aborted'));
      };
      signal.addEventListener('abort', stop, { once: true });
    });

  return {
    trigger: '@',
    label: 'Files and folders',
    key: (m) => `${m.kind}:${m.path}`,
    // A new popup: the last one's note is not this one's (the first answer brings its own).
    opening: () => void (note = null),
    async items(q, signal) {
      await pause(signal);
      const r = await host.send('worker.files', { id, query: q, limit: FILES_LIMIT });
      if (!r.ok) {
        if (!signal.aborted) failed = r.message || r.code;
        throw new Error(r.message);
      }
      failed = null;
      const data = (r.data ?? {}) as Partial<WorkerFiles>;
      // Only the latest query's answer may change what the footer says (the popup drops the others anyway).
      if (!signal.aborted) {
        const reason = typeof data.reason === 'string' && data.reason.trim() !== '' ? data.reason.trim() : null;
        note = reason ?? (data.source === 'none' ? 'No file list for this checkout' : null);
      }
      return matches(data.files);
    },
    render: fileRow,
    loading: () => 'Searching files…',
    failure: () => (failed ? `Could not search the files: ${failed.replace(/\.$/, '')}.` : 'Could not search the files.'),
    // #39: every query asks the bridge: asking the same one again is the retry.
    retry: () => undefined,
    insert(m, token, text) {
      // A space already after the word: the caret goes past it rather than a second one going in.
      return { chip: { kind: 'file', path: m.path, dir: m.kind === 'dir' }, text: ' ', ...(text[token.end] === ' ' ? { end: token.end + 1 } : {}) };
    },
    footer: () => note,
  };
}
