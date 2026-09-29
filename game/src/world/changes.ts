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

const HEADER = /^diff --git a\/(.+?) b\/(.+)$/;

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/**
 * A C-quoted name as git prints it (`"t\303\251st.txt"`: octal escapes are
 * UTF-8 bytes) starting at `s[from]`, decoded, and where it ends; null if
 * it is not one.
 */
function cQuoted(s: string, from: number): { value: string; end: number } | null {
  if (s[from] !== '"') return null;
  const bytes: number[] = [];
  const utf8 = new TextEncoder();
  for (let i = from + 1; i < s.length; ) {
    const ch = s[i] ?? '';
    if (ch === '"') return { value: new TextDecoder().decode(new Uint8Array(bytes)), end: i + 1 };
    if (ch === '\\') {
      const oct = /^[0-7]{1,3}/.exec(s.slice(i + 1, i + 4))?.[0];
      const next = s[i + 1] ?? '';
      if (oct) {
        bytes.push(parseInt(oct, 8) & 0xff);
        i += 1 + oct.length;
      } else {
        bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0));
        i += 2;
      }
      continue;
    }
    const cp = s.codePointAt(i) ?? 0;
    bytes.push(...utf8.encode(String.fromCodePoint(cp)));
    i += cp > 0xffff ? 2 : 1;
  }
  return null;
}

/**
 * A path as a patch header has it (`--- a/…`, `rename to …`), as the
 * bridge's `files[].path` has it: C-quoted names decoded, and the tab git
 * puts after a name with a space dropped (a plain name has no tab: git
 * quotes one that does). `prefix` (`a/`, `b/`) is taken off.
 */
export function gitPath(s: string, prefix = ''): string {
  const q = cQuoted(s, 0);
  const name = q ? q.value : s.split('\t')[0] ?? '';
  return prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** The b-side path of a `diff --git a/… b/…` line (a-side when b cannot be read). */
function headerPath(line: string): string {
  const rest = line.slice('diff --git '.length);
  const a = cQuoted(rest, 0);
  if (a) return gitPath(rest.slice(a.end + 1), 'b/');
  const b = rest.lastIndexOf(' "b/');
  if (b >= 0) return gitPath(rest.slice(b + 1), 'b/');
  // Unquoted both: "a/X b/X" when unchanged; else the first " b/".
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest.slice(0, half) === `a/${rest.slice(half + 3)}` && rest.slice(half, half + 3) === ' b/') {
    return rest.slice(half + 3);
  }
  const m = HEADER.exec(line);
  return m?.[2] ?? m?.[1] ?? rest;
}

/** The path a diff section is about: `+++ b/…` (`--- a/…` for a deletion), a rename's or copy's new name, else the `diff --git` line's. */
function sectionPath(lines: readonly string[], start: number, end: number): string {
  let minus = '';
  for (let i = start + 1; i < end; i++) {
    const l = lines[i] ?? '';
    if (l.startsWith('@@')) break;
    if (l.startsWith('+++ ') && l !== '+++ /dev/null') return gitPath(l.slice(4), 'b/');
    if (l.startsWith('--- ') && l !== '--- /dev/null') minus = gitPath(l.slice(4), 'a/');
    if (l.startsWith('rename to ')) return gitPath(l.slice('rename to '.length));
    if (l.startsWith('copy to ')) return gitPath(l.slice('copy to '.length));
  }
  if (minus) return minus;
  return headerPath(lines[start] ?? '');
}

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
  // A path can have more than one section (a type change is a deletion and an addition): all of them, in order.
  const sections = new Map<string, FileDiff>();
  for (const d of splitDiff(c.diff ?? '')) {
    const had = sections.get(d.path);
    sections.set(d.path, had ? { path: d.path, lines: [...had.lines, ...d.lines], kinds: [...had.kinds, ...d.kinds] } : d);
  }
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
