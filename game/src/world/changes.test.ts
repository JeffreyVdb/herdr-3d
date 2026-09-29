import { describe, expect, it } from 'vitest';
import type { Changes } from '../net/protocol';
import { bytesText, changesView, fileState, noDiffReason, numberLines, splitDiff, splitPath } from './changes';

const DIFF = [
  'diff --git a/internal/server/hub.go b/internal/server/hub.go',
  'index 3f09a1c..7b2e4d0 100644',
  '--- a/internal/server/hub.go',
  '+++ b/internal/server/hub.go',
  '@@ -10,6 +10,7 @@ func (h *Hub) run() {',
  ' \tfor {',
  '-\t\tselect {',
  '+\t\t// fan out',
  '+\t\tselect {',
  '--- not a header: a removed line starting with --',
  '\\ No newline at end of file',
  'diff --git a/old.txt b/old.txt',
  'deleted file mode 100644',
  'index 1111111..0000000',
  '--- a/old.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
  'diff --git a/logo.png b/logo.png',
  'new file mode 100644',
  'Binary files /dev/null and b/logo.png differ',
  '',
].join('\n');

const changes = (over: Partial<Changes> = {}): Changes => ({
  cwd: '/home/dev/devel/herdr-3d-wt/m5-term',
  branch: 'feat/6-m5-term',
  head: '3f09a1c',
  upstream: 'origin/feat/6-m5-term',
  ahead: 2,
  behind: 0,
  base: { ref: 'origin/main', sha: '0d8c09d4e5f6a7b8c9d0' },
  files: [
    { path: 'internal/server/hub.go', index: '.', worktree: 'M', insertions: 2, deletions: 2, binary: false },
    { path: 'old.txt', index: 'D', worktree: '.', insertions: 0, deletions: 1, binary: false },
    { path: 'logo.png', index: 'A', worktree: '.', insertions: 0, deletions: 0, binary: true },
    { path: 'notes.txt', untracked: true, insertions: 4, deletions: 0, binary: false },
    { path: 'big.json', index: 'A', worktree: 'M', insertions: 90_000, deletions: 0, binary: false },
  ],
  stat: { files: 4, insertions: 90_002, deletions: 3 },
  diff: DIFF,
  diff_bytes: 1_363_149,
  truncated: true,
  omitted: ['big.json'],
  ...over,
});

describe('splitDiff', () => {
  it('splits per file and classifies each line (headers only before the first hunk)', () => {
    const d = splitDiff(DIFF);
    expect(d.map((x) => x.path)).toEqual(['internal/server/hub.go', 'old.txt', 'logo.png']);
    expect(d[0]?.kinds).toEqual(['meta', 'meta', 'meta', 'meta', 'hunk', 'ctx', 'del', 'add', 'add', 'del', 'note']);
    expect(d[1]?.kinds.slice(-2)).toEqual(['hunk', 'del']);
    expect(d[2]?.kinds).toEqual(['meta', 'meta', 'meta']);
    expect(splitDiff('')).toEqual([]);
  });

  it('numbers the old and new lines from the hunk headers', () => {
    const d = splitDiff(DIFF)[0];
    if (!d) throw new Error('no diff');
    expect(numberLines(d).slice(4)).toEqual([
      [null, null],
      [10, 10],
      [11, null],
      [null, 11],
      [null, 12],
      [12, null],
      [null, null],
    ]);
  });

  it('is fast for a 256 KiB diff', () => {
    const body = Array.from({ length: 9000 }, (_, i) => `${i % 3 ? '+' : ' '}${'x'.repeat(24)} line ${i}`).join('\n');
    const big = `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,3000 +1,9000 @@\n${body}\n`;
    expect(big.length).toBeGreaterThan(256 * 1024);
    const t = performance.now();
    const d = splitDiff(big);
    expect(performance.now() - t).toBeLessThan(80);
    expect(d[0]?.lines).toHaveLength(9004);
  });
});

describe('file states', () => {
  it('marks staged, unstaged, untracked and committed files', () => {
    expect(fileState({ path: 'a', index: 'A', worktree: 'M', insertions: 1, deletions: 0, binary: false })).toEqual({
      chips: [
        { kind: 'staged', text: 'staged A' },
        { kind: 'unstaged', text: 'M' },
      ],
      words: 'staged: added; unstaged: modified',
    });
    expect(fileState({ path: 'a', untracked: true, insertions: 1, deletions: 0, binary: false }).chips).toEqual([{ kind: 'untracked', text: 'new' }]);
    expect(fileState({ path: 'a', index: '.', worktree: '.', insertions: 1, deletions: 0, binary: false }).chips).toEqual([{ kind: 'committed', text: 'committed' }]);
  });
});

describe('changesView', () => {
  it('shows branch, upstream, base, the stat and the truncation notice', () => {
    const v = changesView(changes());
    expect(v).toMatchObject({
      branch: 'feat/6-m5-term',
      upstream: 'origin/feat/6-m5-term: 2 ahead, 0 behind',
      base: 'origin/main @ 0d8c09d',
      stat: '4 files changed · +90002 −3 · 1 untracked',
      truncated: 'The diff is cut at 256 KiB (1.3 MiB in all): 1 file is listed without its diff.',
    });
    expect(v.files.map((f) => [f.path, !!f.diff, f.omitted])).toEqual([
      ['internal/server/hub.go', true, false],
      ['old.txt', true, false],
      ['logo.png', true, false],
      ['notes.txt', false, false],
      ['big.json', false, true],
    ]);
    expect(v.files.map(noDiffReason)).toEqual([
      null,
      null,
      'Binary file: no text diff.',
      'Untracked file with no content here (over 64 KiB, binary, or outside the folder).',
      'Left out of the diff: it would go over the 256 KiB cap.',
    ]);
  });

  it('copes with a detached head, no upstream and no base', () => {
    const v = changesView(changes({ branch: null, upstream: null, base: null, truncated: false, omitted: [], files: [], diff: '', stat: { files: 0, insertions: 0, deletions: 0 } }));
    expect(v).toMatchObject({ branch: 'detached HEAD', upstream: 'no upstream (not pushed)', base: 'HEAD (no origin default branch)', stat: '0 files changed · +0 −0', truncated: null });
  });
});

// As git 2.x prints it (`git diff --patch --find-renames HEAD`) after: normal.txt, "s p.txt", "tést.txt" and
// 'q"uo te.txt' edited, f.txt (a regular file) replaced with a symlink, "old name.txt" renamed to "né name.txt"; then
// an untracked "new file.txt" as the bridge adds it.
const ODD_DIFF = [
  'diff --git a/f.txt b/f.txt',
  'deleted file mode 100644',
  'index 53cef30..0000000',
  '--- a/f.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-valuable old content',
  'diff --git a/f.txt b/f.txt',
  'new file mode 120000',
  'index 0000000..e9750ee',
  '--- /dev/null',
  '+++ b/f.txt',
  '@@ -0,0 +1 @@',
  '+normal.txt',
  '\\ No newline at end of file',
  'diff --git a/normal.txt b/normal.txt',
  'index 7898192..422c2b7 100644',
  '--- a/normal.txt',
  '+++ b/normal.txt',
  '@@ -1 +1,2 @@',
  ' a',
  '+b',
  'diff --git a/old name.txt "b/n\\303\\251 name.txt"',
  'similarity index 100%',
  'rename from old name.txt',
  'rename to "n\\303\\251 name.txt"',
  'diff --git "a/q\\"uo te.txt" "b/q\\"uo te.txt"',
  'index 7898192..422c2b7 100644',
  '--- "a/q\\"uo te.txt"\t',
  '+++ "b/q\\"uo te.txt"\t',
  '@@ -1 +1,2 @@',
  ' a',
  '+b',
  'diff --git a/s p.txt b/s p.txt',
  'index 7898192..422c2b7 100644',
  '--- a/s p.txt\t',
  '+++ b/s p.txt\t',
  '@@ -1 +1,2 @@',
  ' a',
  '+b',
  'diff --git "a/t\\303\\251st.txt" "b/t\\303\\251st.txt"',
  'index 7898192..422c2b7 100644',
  '--- "a/t\\303\\251st.txt"',
  '+++ "b/t\\303\\251st.txt"',
  '@@ -1 +1,2 @@',
  ' a',
  '+b',
  'diff --git a/new file.txt b/new file.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new file.txt\t',
  '@@ -0,0 +1 @@',
  '+hi',
  '',
].join('\n');

describe('file names as git prints them', () => {
  const file = (path: string, over: Partial<Changes['files'][number]> = {}) => ({ path, index: '.', worktree: 'M', insertions: 1, deletions: 0, binary: false, ...over });
  const view = changesView(
    changes({
      files: [
        file('f.txt', { worktree: 'T', deletions: 1 }),
        file('normal.txt'),
        file('né name.txt', { index: 'R', worktree: '.', orig_path: 'old name.txt', insertions: 0 }),
        file('q"uo te.txt'),
        file('s p.txt'),
        file('tést.txt'),
        { path: 'new file.txt', untracked: true, insertions: 1, deletions: 0, binary: false },
      ],
      diff: ODD_DIFF,
      truncated: false,
      omitted: [],
    }),
  );
  const byPath = (p: string) => view.files.find((f) => f.path === p);

  it('decodes quoted names and drops the tab after a name with a space', () => {
    expect(splitDiff(ODD_DIFF).map((d) => d.path)).toEqual(['f.txt', 'f.txt', 'normal.txt', 'né name.txt', 'q"uo te.txt', 's p.txt', 'tést.txt', 'new file.txt']);
    for (const p of ['normal.txt', 'q"uo te.txt', 's p.txt', 'tést.txt', 'new file.txt']) {
      const f = byPath(p);
      expect(f && noDiffReason(f), p).toBeNull();
      expect(f?.diff?.lines.at(-1), p).toMatch(/^\+(b|hi)$/);
    }
    expect(byPath('né name.txt') && noDiffReason(byPath('né name.txt')!)).toBe('Only its mode or name changed.');
  });

  it('keeps every section of a path: a type change shows the old content going and the new coming', () => {
    const lines = byPath('f.txt')?.diff?.lines ?? [];
    expect(lines).toContain('-valuable old content');
    expect(lines).toContain('+normal.txt');
    expect(lines.indexOf('-valuable old content')).toBeLessThan(lines.indexOf('+normal.txt'));
    const d = byPath('f.txt')!.diff!;
    expect(numberLines(d).filter(([o, n]) => o !== null || n !== null)).toEqual([
      [1, null],
      [null, 1],
    ]);
  });

  it('reads the header when there are no --- / +++ lines', () => {
    const d = splitDiff(['diff --git a/a b.bin b/a b.bin', 'index 1..2 100644', 'Binary files a/a b.bin and b/a b.bin differ', 'diff --git "a/\\303\\251.png" "b/\\303\\251.png"', 'new file mode 100644', 'Binary files /dev/null and "b/\\303\\251.png" differ'].join('\n'));
    expect(d.map((x) => x.path)).toEqual(['a b.bin', 'é.png']);
  });
});

describe('helpers', () => {
  it('formats sizes and splits paths', () => {
    expect([912, 18_230, 1_363_149].map(bytesText)).toEqual(['912 B', '18 KiB', '1.3 MiB']);
    expect(splitPath('internal/server/hub.go')).toEqual({ dir: 'internal/server/', base: 'hub.go' });
    expect(splitPath('go.mod')).toEqual({ dir: '', base: 'go.mod' });
  });
});
