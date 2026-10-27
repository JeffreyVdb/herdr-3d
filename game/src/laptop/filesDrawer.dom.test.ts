// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { FileMatch, WorkerFiles } from '../net/protocol';
import { buildTree, FILES_CAP, FilesDrawer, type FilesDrawerDeps, type TreeNode } from './filesDrawer';
import { DEBOUNCE_MS } from './fileSearch';

const f = (path: string, kind: 'file' | 'dir' = 'file'): FileMatch => ({ path, kind, indices: [] });
const answer = (files: FileMatch[], extra: Partial<WorkerFiles> = {}): WorkerFiles => ({ files, source: 'git', reason: null, ...extra });
/** The tree as indented lines: `dir/` for folders, a change after the name, `•` for a folder holding one. */
const lines = (n: TreeNode, depth = 0): string[] => n.children.flatMap((c) => [`${'  '.repeat(depth)}${c.name}${c.kind === 'dir' ? '/' : ''}${c.change ? ` ${c.change}` : ''}${c.kind === 'dir' && c.dirty && !c.change ? ' •' : ''}`, ...lines(c, depth + 1)]);

describe('buildTree', () => {
  it('builds folders from flat paths: nested, files at the root, folders as entries, spaces and unicode', () => {
    const t = buildTree([f('README.md'), f('src/app.ts'), f('src', 'dir'), f('src/ui/seat.ts'), f('docs/a b/naïve 文件.md'), f('Makefile'), f('src/ui', 'dir'), f('empty', 'dir'), f('v10.txt'), f('v9.txt')], null);
    expect(lines(t)).toEqual([
      'docs/',
      '  a b/',
      '    naïve 文件.md',
      'empty/',
      'src/',
      '  ui/',
      '    seat.ts',
      '  app.ts',
      'Makefile',
      'README.md',
      'v9.txt',
      'v10.txt',
    ]);
    expect(t.children.find((c) => c.name === 'docs')!.children[0]!.path).toBe('docs/a b');
  });

  it('marks changes, dots the folders above them, and adds changed paths the list did not have', () => {
    const changes = new Map<string, 'M' | 'U'>([['src/ui/seat.ts', 'M'], ['tools/new.ts', 'U'], ['notes/', 'U']]);
    const t = buildTree([f('src/ui/seat.ts'), f('src/app.ts')], changes);
    expect(lines(t)).toEqual(['notes/ U', 'src/ •', '  ui/ •', '    seat.ts M', '  app.ts', 'tools/ •', '  new.ts U']);
  });

  it('a path under a file makes it a folder; duplicates are one node', () => {
    const t = buildTree([f('a'), f('a/b'), f('a/b'), f('a', 'dir')], null);
    expect(lines(t)).toEqual(['a/', '  b']);
  });
});

describe('FilesDrawer', () => {
  type Deps = Omit<FilesDrawerDeps, 'list' | 'insertRef' | 'closed'> & { list: Mock<FilesDrawerDeps['list']>; insertRef: Mock<FilesDrawerDeps['insertRef']>; closed: Mock<FilesDrawerDeps['closed']> };
  let deps: Deps;
  let changes: Map<string, 'M' | 'U'> | null;
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  const rows = (d: FilesDrawer) => [...d.el.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  const names = (d: FilesDrawer) => rows(d).map((r) => `${'  '.repeat(Number(r.getAttribute('aria-level')) - 1)}${r.querySelector('.fdr-name')!.textContent}${r.querySelector('.fdr-badge')?.textContent ? ` ${r.querySelector('.fdr-badge')!.textContent}` : ''}${r.querySelector('.fdr-dot') ? ' •' : ''}`);
  const key = (k: string, target: Element | null = document.activeElement) => { const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }); target!.dispatchEvent(e); return e; };
  const make = async (r: WorkerFiles | null = answer([f('src/ui/seat.ts'), f('src/app.ts'), f('README.md')])) => {
    deps.list.mockResolvedValue(r);
    const d = new FilesDrawer(deps);
    document.body.append(d.el);
    d.open();
    await flush();
    return d;
  };

  beforeEach(() => {
    document.body.replaceChildren();
    changes = null;
    deps = { rootLabel: 'herdr-3d', list: vi.fn<FilesDrawerDeps['list']>(), changes: () => changes, insertRef: vi.fn<FilesDrawerDeps['insertRef']>(), closed: vi.fn<FilesDrawerDeps['closed']>() };
  });
  afterEach(() => vi.useRealTimers());

  it('opens with the keyboard in its filter, asks once with an empty query, shows the tree with a header', async () => {
    const d = await make();
    expect(d.isOpen).toBe(true);
    expect(d.el.dataset.open).toBe('true');
    expect(d.el.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(d.el.querySelector('.fdr-input'));
    expect(deps.list.mock.calls).toEqual([['']]);
    expect(d.el.querySelector('.fdr-title')!.textContent).toBe('herdr-3d');
    expect(d.el.querySelector('[role="tree"]')!.getAttribute('aria-label')).toBe('Files of herdr-3d');
    expect(names(d)).toEqual(['src', 'README.md']);
    expect(d.el.querySelector('.fdr-keys')!.textContent).toBe('Enter inserts an @ reference · Esc closes');
    expect((d.el.querySelector('.fdr-partial') as HTMLElement).hidden).toBe(true);
    // Every icon is a duotone SVG.
    expect([...d.el.querySelectorAll('svg')].every((s) => s.classList.contains('dt'))).toBe(true);
  });

  it('a reference the prompt box refuses: the drawer says why (a status), until one goes in or it closes', async () => {
    const d = await make();
    const said = d.el.querySelector<HTMLElement>('.fdr-said')!;
    expect(said.getAttribute('role')).toBe('status');
    expect(said.hidden).toBe(true);
    deps.insertRef.mockReturnValueOnce('Ada is waiting for your answer: answer the questions first.');
    key('ArrowDown');
    key('Enter');
    expect(said.hidden).toBe(false);
    expect(said.textContent).toBe('Ada is waiting for your answer: answer the questions first.');
    expect(document.activeElement).toBe(rows(d)[0]); // the keyboard stays in the tree
    key('Enter'); // it went in this time
    expect(said.hidden).toBe(true);
    deps.insertRef.mockReturnValueOnce('Not now.');
    key('Enter');
    expect(said.hidden).toBe(false);
    d.close();
    expect(said.hidden).toBe(true);
  });

  it('says the list is partial at the cap or with a reason, never a total; changed files outside the cap still show', async () => {
    changes = new Map([['zzz/outside.ts', 'M'], ['f000', 'M'], ['new.txt', 'U']]);
    const many = Array.from({ length: FILES_CAP }, (_, i) => f(`f${String(i).padStart(3, '0')}`));
    const d = await make(answer(many));
    const note = d.el.querySelector<HTMLElement>('.fdr-partial')!;
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe('Showing the first 100 — type to search');
    expect(d.el.textContent).not.toMatch(/\b(10[1-9]|1\d\d\d|of 100)\b/);
    const shown = names(d);
    expect(shown).toContain('zzz •');
    expect(shown).toContain('  outside.ts M');
    expect(shown).toContain('f000 M');
    expect(shown).toContain('new.txt U');
    expect(rows(d).find((r) => r.dataset.path === 'f000')!.getAttribute('aria-label')).toBe('f000, changed');
    expect(rows(d).find((r) => r.dataset.path === 'zzz')!.getAttribute('aria-label')).toBe('zzz, folder, has changes');
    d.close();
    const e = await make(answer([f('a.ts')], { reason: 'the file index is still building' }));
    expect(e.el.querySelector('.fdr-partial')!.textContent).toBe('This list may be incomplete — type to search · the file index is still building');
  });

  it('keyboard: ↑↓ move, → opens then enters, ← closes then goes to the parent, Enter inserts with its kind', async () => {
    const d = await make(answer([f('src/ui/seat.ts'), f('src/app.ts'), f('README.md')]));
    key('ArrowDown');
    expect(document.activeElement).toBe(rows(d)[0]);
    expect(rows(d)[0]!.getAttribute('aria-expanded')).toBe('false');
    expect(rows(d).map((r) => r.tabIndex)).toEqual([0, -1]);
    key('ArrowRight');
    expect(names(d)).toEqual(['src', '  ui', '  app.ts', 'README.md']);
    expect(rows(d)[0]!.getAttribute('aria-expanded')).toBe('true');
    key('ArrowRight');
    expect(document.activeElement).toBe(rows(d)[1]);
    key('ArrowRight'); key('ArrowRight');
    expect(document.activeElement!.getAttribute('data-path')).toBe('src/ui/seat.ts');
    key('Enter');
    expect(deps.insertRef).toHaveBeenLastCalledWith('src/ui/seat.ts', 'file');
    key('ArrowLeft');
    expect(document.activeElement!.getAttribute('data-path')).toBe('src/ui');
    key('Enter');
    expect(deps.insertRef).toHaveBeenLastCalledWith('src/ui', 'dir');
    key('ArrowLeft');
    expect(names(d)).toEqual(['src', '  ui', '  app.ts', 'README.md']);
    key('ArrowLeft');
    expect(document.activeElement!.getAttribute('data-path')).toBe('src');
    key('ArrowLeft');
    expect(names(d)).toEqual(['src', 'README.md']);
    key('End');
    expect(document.activeElement!.getAttribute('data-path')).toBe('README.md');
    key('ArrowDown');
    expect(document.activeElement!.getAttribute('data-path')).toBe('README.md');
    key('Home'); key('ArrowUp');
    expect(document.activeElement!.getAttribute('data-path')).toBe('src');
    expect(rows(d).filter((r) => r.getAttribute('aria-selected') === 'true').map((r) => r.dataset.path)).toEqual(['src']);
  });

  it('Esc closes from the tree or the filter, stops there, and calls closed(); the closed drawer is inert', async () => {
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    const d = await make();
    const e = key('Escape');
    expect(e.defaultPrevented).toBe(true);
    expect(outer).not.toHaveBeenCalled();
    expect(d.isOpen).toBe(false);
    expect(d.el.dataset.open).toBe('false');
    expect(d.el.hasAttribute('inert')).toBe(true);
    expect(deps.closed).toHaveBeenCalledOnce();
    d.open(); await flush();
    key('ArrowDown');
    key('Escape');
    expect(deps.closed).toHaveBeenCalledTimes(2);
    // A second open does not ask again; toggle closes and opens.
    expect(deps.list).toHaveBeenCalledTimes(1);
    d.toggle(); expect(d.isOpen).toBe(true);
    d.toggle(); expect(d.isOpen).toBe(false);
    document.removeEventListener('keydown', outer);
  });

  it('the filter asks the bridge again after the debounce, once for a burst; a stale answer is dropped', async () => {
    vi.useFakeTimers();
    const d = await make();
    const later: Array<(r: WorkerFiles) => void> = [];
    deps.list.mockImplementation(() => new Promise<WorkerFiles>((r) => later.push(r)));
    const input = d.el.querySelector<HTMLInputElement>('.fdr-input')!;
    for (const v of ['s', 'se', 'sea']) { input.value = v; input.dispatchEvent(new Event('input')); vi.advanceTimersByTime(DEBOUNCE_MS - 1); }
    expect(deps.list).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(deps.list.mock.calls.at(-1)).toEqual(['sea']);
    input.value = 'seat'; input.dispatchEvent(new Event('input')); vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(deps.list.mock.calls.at(-1)).toEqual(['seat']);
    // The tree shows the old rows, dimmed, while the answer is out.
    expect(d.el.querySelector('.fdr-tree')!.classList.contains('is-stale')).toBe(true);
    later[1]!(answer([f('src/ui/seat.ts'), f('src/ui/seat.css')]));
    later[0]!(answer([f('old/sea.ts')]));
    await flush();
    // A filtered tree is open all the way down.
    expect(names(d)).toEqual(['src', '  ui', '    seat.css', '    seat.ts']);
    expect(d.el.querySelector('.fdr-tree')!.classList.contains('is-stale')).toBe(false);
    // Typing in the tree types into the filter.
    key('ArrowDown', input);
    expect(document.activeElement!.getAttribute('data-path')).toBe('src');
    key('x');
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('seatx');
  });

  it('empty and failed states: no lister, no files, no match, an error with a retry', async () => {
    const none = await make(answer([], { source: 'none', reason: 'no rg on the bridge host' }));
    expect(none.el.querySelector('.fdr-msg')!.textContent).toBe('No file list for this checkout: no rg on the bridge host');
    expect(rows(none)).toHaveLength(0);
    none.dispose();
    const empty = await make(answer([]));
    expect(empty.el.querySelector('.fdr-msg')!.textContent).toBe('No files');
    expect((empty.el.querySelector('.fdr-partial') as HTMLElement).hidden).toBe(true);
    empty.dispose();
    const failed = await make(null);
    expect(failed.el.querySelector('.fdr-msg')!.textContent).toBe('Could not list the files. Try again');
    deps.list.mockResolvedValue(answer([f('a.ts')]));
    failed.el.querySelector<HTMLButtonElement>('.fdr-retry')!.click();
    await flush();
    expect(names(failed)).toEqual(['a.ts']);
    expect((failed.el.querySelector('.fdr-msg') as HTMLElement).hidden).toBe(true);
    const rejected = await make();
    deps.list.mockRejectedValue(new Error('gone'));
    const input = rejected.el.querySelector<HTMLInputElement>('.fdr-input')!;
    vi.useFakeTimers();
    input.value = 'q'; input.dispatchEvent(new Event('input')); vi.advanceTimersByTime(DEBOUNCE_MS);
    vi.useRealTimers();
    await flush();
    expect(rejected.el.querySelector('.fdr-msg')!.textContent).toContain('Could not list the files.');
  });

  it('says the listing is unavailable or partial even when changed files fill the tree, and a reason only once', async () => {
    changes = new Map([['src/app.ts', 'M']]);
    const partial = await make(answer([], { reason: 'the file index is still building' }));
    expect(names(partial)).toEqual(['src •', '  app.ts M']);
    const note = partial.el.querySelector<HTMLElement>('.fdr-partial')!;
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe('This list may be incomplete — type to search · the file index is still building');
    expect((partial.el.querySelector('.fdr-msg') as HTMLElement).hidden).toBe(true);
    partial.dispose();
    const none = await make(answer([], { source: 'none', reason: 'no rg on the bridge host' }));
    expect(names(none)).toEqual(['src •', '  app.ts M']);
    const msg = none.el.querySelector<HTMLElement>('.fdr-msg')!;
    expect(msg.hidden).toBe(false);
    expect(msg.textContent).toBe('No file list for this checkout: no rg on the bridge host — only the changed files are shown');
    expect(none.el.textContent!.split('no rg on the bridge host')).toHaveLength(2);
    none.dispose();
    // No rows at all: the message says so and the footer carries the reason, once.
    changes = null;
    const empty = await make(answer([], { reason: 'the file index is still building' }));
    expect(empty.el.querySelector('.fdr-msg')!.textContent).toBe('No files');
    expect(empty.el.querySelector('.fdr-partial')!.textContent).toBe('This list may be incomplete — type to search · the file index is still building');
    expect(empty.el.textContent!.split('the file index is still building')).toHaveLength(2);
  });

  it('a filter typed and closed before the debounce is asked for on reopen; an unchanged filter is not', async () => {
    vi.useFakeTimers();
    const d = await make();
    deps.list.mockResolvedValue(answer([f('src/ui/seat.ts')]));
    const input = d.el.querySelector<HTMLInputElement>('.fdr-input')!;
    input.value = 'seat'; input.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(DEBOUNCE_MS - 1);
    d.close();
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(deps.list.mock.calls).toEqual([['']]);
    d.open(); await flush();
    expect(deps.list.mock.calls).toEqual([[''], ['seat']]);
    expect(names(d)).toEqual(['src', '  ui', '    seat.ts']);
    d.close(); d.open(); await flush();
    expect(deps.list).toHaveBeenCalledTimes(2);
  });

  it('a filtered tree starts open but its folders collapse and open by click, ←, → and Space; clearing it restores the old expansion', async () => {
    vi.useFakeTimers();
    const all = answer([f('src/ui/seat.ts'), f('src/app.ts'), f('docs/a.md')]);
    const seat = answer([f('src/ui/seat.ts'), f('src/ui/seat.css')]);
    const d = await make(all);
    const input = d.el.querySelector<HTMLInputElement>('.fdr-input')!;
    const type = async (v: string, r: WorkerFiles) => { deps.list.mockResolvedValue(r); input.value = v; input.dispatchEvent(new Event('input')); vi.advanceTimersByTime(DEBOUNCE_MS); await flush(); };
    rows(d)[0]!.click();
    expect(names(d)).toEqual(['docs', '  a.md', 'src']);
    await type('seat', seat);
    expect(names(d)).toEqual(['src', '  ui', '    seat.css', '    seat.ts']);
    key('ArrowDown', input); key('ArrowDown');
    expect(document.activeElement!.getAttribute('data-path')).toBe('src/ui');
    key('ArrowLeft');
    expect(names(d)).toEqual(['src', '  ui']);
    expect(rows(d)[1]!.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement!.getAttribute('data-path')).toBe('src/ui');
    key('ArrowRight');
    expect(names(d)).toEqual(['src', '  ui', '    seat.css', '    seat.ts']);
    expect(rows(d)[1]!.getAttribute('aria-expanded')).toBe('true');
    key(' ');
    expect(names(d)).toEqual(['src', '  ui']);
    rows(d)[0]!.click();
    expect(names(d)).toEqual(['src']);
    rows(d)[0]!.click();
    expect(names(d)).toEqual(['src', '  ui']);
    await type('', all);
    expect(names(d)).toEqual(['docs', '  a.md', 'src']);
    // A new query starts open again.
    await type('seat', seat);
    expect(names(d)).toEqual(['src', '  ui', '    seat.css', '    seat.ts']);
  });

  it('no match for a query says so; refreshChanges redraws the badges without asking', async () => {
    const d = await make(answer([f('a.ts'), f('b.ts')]));
    expect(names(d)).toEqual(['a.ts', 'b.ts']);
    changes = new Map([['b.ts', 'M']]);
    d.refreshChanges();
    expect(names(d)).toEqual(['a.ts', 'b.ts M']);
    expect(deps.list).toHaveBeenCalledTimes(1);
    const e = await make(answer([]));
    e.el.querySelector<HTMLInputElement>('.fdr-input')!.value = 'zz';
    vi.useFakeTimers();
    e.el.querySelector('.fdr-input')!.dispatchEvent(new Event('input')); vi.advanceTimersByTime(DEBOUNCE_MS);
    vi.useRealTimers();
    await flush();
    expect(e.el.querySelector('.fdr-msg')!.textContent).toBe('No files match “zz”');
  });

  it('a click selects a row and opens a folder; a double click on a file inserts it', async () => {
    const d = await make(answer([f('src/app.ts')]));
    rows(d)[0]!.click();
    expect(names(d)).toEqual(['src', '  app.ts']);
    rows(d)[1]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(deps.insertRef).toHaveBeenCalledWith('src/app.ts', 'file');
  });

  it('never uses a transform (the stage holds the terminal)', async () => {
    const d = await make();
    const css = await import('./filesDrawer.css?raw');
    expect(css.default).not.toMatch(/transform/);
    expect(d.el.getAttribute('style') ?? '').not.toMatch(/transform/);
  });
});
