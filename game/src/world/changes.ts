/**
 * M5: the Changes panel's model of `worker.changes`: the file list's states
 * and counts, the diff split per file with each line's kind, the branch and
 * base lines, and the truncation notice. Pure: the panel only draws this.
 */

import type { ChangeFile, Changes } from '../net/protocol';

/** The bridge's diff cap (docs: 256 KiB). */
export const DIFF_CAP = 256 * 1024;

export type LineKind = 'meta' | 'hunk' | 'add' | 'del' | 'ctx' | 'note';

export interface FileDiff {
  path: string;
  /** Lines of this file's diff (header included). */
  lines: string[];
  kinds: LineKind[];
}

const HEADER = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/;

/** The path a diff section is about: `+++ b/…` (`--- a/…` for a deletion), else the `diff --git` line's. */
function sectionPath(lines: readonly string[], start: number, end: number): string {
  let minus = '';
  for (let i = start + 1; i < end; i++) {
    const l = lines[i] ?? '';
    if (l.startsWith('@@')) break;
    if (l.startsWith('+++ ') && l !== '+++ /dev/null') return unquote(l.slice(4)).replace(/^b\//, '');
    if (l.startsWith('--- ') && l !== '--- /dev/null') minus = unquote(l.slice(4)).replace(/^a\//, '');
    if (l.startsWith('rename to ')) return l.slice('rename to '.length);
  }
  if (minus) return minus;
  const m = HEADER.exec(lines[start] ?? '');
  return m?.[2] ?? m?.[1] ?? (lines[start] ?? '').slice('diff --git '.length);
}

const unquote = (s: string) => (s.length > 1 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);

/** Splits a unified diff (`git diff`) into its files, classifying every line. */
export function splitDiff(diff: string): FileDiff[] {
  if (!diff) return [];
  const lines = diff.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const starts: number[] = [];
  lines.forEach((l, i) => l.startsWith('diff --git ') && starts.push(i));
  const out: FileDiff[] = [];
  starts.forEach((s, k) => {
    const e = starts[k + 1] ?? lines.length;
    const part = lines.slice(s, e);
    const kinds: LineKind[] = [];
    let inHunk = false;
    for (const l of part) {
      if (l.startsWith('@@')) {
        inHunk = true;
        kinds.push('hunk');
      } else if (!inHunk) kinds.push('meta');
      else if (l.startsWith('+')) kinds.push('add');
      else if (l.startsWith('-')) kinds.push('del');
      else if (l.startsWith('\\')) kinds.push('note');
      else kinds.push('ctx');
    }
    out.push({ path: sectionPath(lines, s, e), lines: part, kinds });
  });
  return out;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Old / new line numbers per diff line (null where a side has none: headers, hunk lines, the other side's lines). */
export function numberLines(d: FileDiff): Array<[number | null, number | null]> {
  let o = 0;
  let n = 0;
  return d.lines.map((l, i) => {
    const k = d.kinds[i];
    if (k === 'hunk') {
      const m = HUNK.exec(l);
      o = Number(m?.[1] ?? 0);
      n = Number(m?.[2] ?? 0);
      return [null, null];
    }
    if (k === 'add') return [null, n++];
    if (k === 'del') return [o++, null];
    if (k === 'ctx') return [o++, n++];
    return [null, null];
  });
}

const WORD: Record<string, string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type changed',
  U: 'unmerged',
};

export interface FileState {
  /** Short marks as chips: `staged A`, `M`, `new`, `committed`. */
  chips: Array<{ kind: 'staged' | 'unstaged' | 'untracked' | 'committed'; text: string }>;
  /** Words for a screen reader and the tooltip: "staged: added; unstaged: modified". */
  words: string;
}

const letter = (v: string | undefined) => (v && v !== '.' && v !== ' ' ? v : '');

/** How a file stands: in the index, in the worktree, untracked, or only in the branch's commits. */
export function fileState(f: ChangeFile): FileState {
  if (f.untracked) return { chips: [{ kind: 'untracked', text: 'new' }], words: 'untracked (not added yet)' };
  const i = letter(f.index);
  const w = letter(f.worktree);
  const chips: FileState['chips'] = [];
  const words: string[] = [];
  if (i) {
    chips.push({ kind: 'staged', text: `staged ${i}` });
    words.push(`staged: ${WORD[i] ?? i}`);
  }
  if (w) {
    chips.push({ kind: 'unstaged', text: w });
    words.push(`unstaged: ${WORD[w] ?? w}`);
  }
  if (!chips.length) {
    chips.push({ kind: 'committed', text: 'committed' });
    words.push('committed on the branch, no local changes');
  }
  return { chips, words: words.join('; ') };
}

/** `1.3 MiB`, `18 KiB`, `912 B`. */
export function bytesText(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KiB`;
  return `${Math.max(0, n)} B`;
}

export interface ChangesView {
  branch: string;
  /** `origin/feat/x: 2 ahead, 1 behind` / `no upstream`. */
  upstream: string;
  ahead: number;
  behind: number;
  /** `origin/main @ 0d8c09d`, or `HEAD` when there is no remote default branch. */
  base: string;
  /** `2 files changed · +222 −3 · 1 untracked` (the bridge's `stat`, git diff --stat against the base). */
  stat: string;
  /** The truncation notice, null when the whole diff is here. */
  truncated: string | null;
  files: Array<ChangeFile & { state: FileState; diff: FileDiff | null; omitted: boolean }>;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Everything the panel shows for an ack, the files in the bridge's order with their diffs. */
export function changesView(c: Changes): ChangesView {
  const sections = new Map(splitDiff(c.diff ?? '').map((d) => [d.path, d]));
  const omitted = new Set(c.omitted ?? []);
  const files = (c.files ?? []).map((f) => ({ ...f, state: fileState(f), diff: sections.get(f.path) ?? (f.orig_path ? sections.get(f.orig_path) : undefined) ?? null, omitted: omitted.has(f.path) }));
  const ahead = c.ahead ?? 0;
  const behind = c.behind ?? 0;
  const upstream = c.upstream ? `${c.upstream}: ${ahead} ahead, ${behind} behind` : 'no upstream (not pushed)';
  const base = c.base ? `${c.base.ref} @ ${c.base.sha.slice(0, 7)}` : 'HEAD (no origin default branch)';
  // git diff --stat against the base (tracked files), plus the untracked ones the list shows too.
  const tracked = files.filter((f) => !f.untracked);
  const st = c.stat ?? { files: tracked.length, insertions: tracked.reduce((s, f) => s + (f.insertions || 0), 0), deletions: tracked.reduce((s, f) => s + (f.deletions || 0), 0) };
  const untracked = files.length - tracked.length;
  const stat = `${plural(st.files, 'file')} changed · +${st.insertions} −${st.deletions}${untracked ? ` · ${untracked} untracked` : ''}`;
  let truncated: string | null = null;
  if (c.truncated) {
    const n = omitted.size;
    truncated = `The diff is cut at ${bytesText(DIFF_CAP)} (${bytesText(c.diff_bytes)} in all): ${plural(n, 'file')} ${n === 1 ? 'is' : 'are'} listed without ${n === 1 ? 'its' : 'their'} diff.`;
  }
  return { branch: c.branch ?? 'detached HEAD', upstream, ahead, behind, base, stat, truncated, files };
}

/** Why a file has no diff to show (null: it has one). */
export function noDiffReason(f: ChangesView['files'][number]): string | null {
  if (f.diff && f.diff.kinds.some((k) => k !== 'meta')) return null;
  if (f.binary) return 'Binary file: no text diff.';
  if (f.omitted) return `Left out of the diff: it would go over the ${bytesText(DIFF_CAP)} cap.`;
  if (f.untracked) return 'Untracked file with no content here (over 64 KiB, binary, or outside the folder).';
  if (f.diff) return 'Only its mode or name changed.';
  return 'No diff for this file.';
}

/** The path split for display: the folder (dimmed) and the file name. */
export function splitPath(p: string): { dir: string; base: string } {
  const i = p.lastIndexOf('/');
  return i < 0 ? { dir: '', base: p } : { dir: p.slice(0, i + 1), base: p.slice(i + 1) };
}
