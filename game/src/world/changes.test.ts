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

describe('helpers', () => {
  it('formats sizes and splits paths', () => {
    expect([912, 18_230, 1_363_149].map(bytesText)).toEqual(['912 B', '18 KiB', '1.3 MiB']);
    expect(splitPath('internal/server/hub.go')).toEqual({ dir: 'internal/server/', base: 'hub.go' });
    expect(splitPath('go.mod')).toEqual({ dir: '', base: 'go.mod' });
  });
});
