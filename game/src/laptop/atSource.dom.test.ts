// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import type { CommandArgs, FileMatch, RepoRef } from '../net/protocol';
import type { FileSearchHost } from './fileSearch';
import { REPO_HINT } from './atSource';
import type { RepoSearchHost } from './repoSearch';
import { mountTranscript, type TranscriptRenderHost, type TranscriptView } from './transcriptRender';

// #247: the transcript's one `@` source: `@r:` / `@repo:` list the other floors' repositories (the prefix taken off),
// anything else searches the worker's files as before. The real composer and popup; the test answers the bridge and
// fires the file search's debounce by hand.

interface Bridge extends Omit<FileSearchHost, 'send'> {
  send(t: string, args: unknown): Promise<CommandResult>;
  files: CommandArgs['worker.files'][];
  repos: CommandArgs['worker.repos'][];
  timers: { f: () => void; live: boolean }[];
  fire(): Promise<void>;
  answerFiles(i: number, r: CommandResult): Promise<void>;
  answerRepos(i: number, r: CommandResult): Promise<void>;
}

function bridge(): Bridge {
  const files: ((r: CommandResult) => void)[] = [];
  const repos: ((r: CommandResult) => void)[] = [];
  const b: Bridge = {
    files: [],
    repos: [],
    timers: [],
    send: (t, args) => {
      if (t === 'worker.repos') b.repos.push(args as CommandArgs['worker.repos']);
      else b.files.push(args as CommandArgs['worker.files']);
      return new Promise<CommandResult>((res) => (t === 'worker.repos' ? repos : files).push(res));
    },
    setTimeout: (f) => {
      const t = { f, live: true };
      b.timers.push(t);
      return t;
    },
    clearTimeout: (t) => {
      (t as { live: boolean }).live = false;
    },
    async fire() {
      for (const t of b.timers.splice(0)) if (t.live) t.f();
      await flush();
    },
    async answerFiles(i, r) {
      files[i]?.(r);
      await flush();
    },
    async answerRepos(i, r) {
      repos[i]?.(r);
      await flush();
    },
  };
  return b;
}

const file = (path: string): FileMatch => ({ path, kind: 'file', indices: [] });
const okFiles = (fs: FileMatch[]): CommandResult => ({ ok: true, data: { files: fs, source: 'git', reason: null } });
const ref = (session: string, o: Partial<RepoRef>): RepoRef => ({ session, building: 'Work', same_building: true, cloned: false, ...o });
const okRepos = (rs: RepoRef[]): CommandResult => ({ ok: true, data: { repos: rs } });

function host(b: Bridge): TranscriptRenderHost {
  return {
    images: null,
    files: { id: 'w1', search: b as FileSearchHost },
    repos: { id: 'w1', search: b as RepoSearchHost },
    onPromptSubmit: () => Promise.resolve(true),
    onAnswer: () => {},
    onAnswerAsk: async () => ({ ok: true, resolved: true }),
    onSwitchToTerminal: () => {},
    loadSubagent: async () => [],
  };
}

let container: HTMLDivElement;
let view: TranscriptView | null = null;
const flush = () => new Promise((r) => setTimeout(r, 0));
const box = () => container.querySelector('.tx-input') as HTMLElement;
const pop = () => container.querySelector<HTMLElement>('.cmp-pop');
const isOpen = () => !!pop() && !pop()!.hidden;
const list = () => container.querySelector<HTMLElement>('[role="listbox"]');
const rows = () => [...container.querySelectorAll<HTMLElement>('[role="option"]')];
const names = () => rows().map((r) => (r.querySelector('.tx-file-name') ?? r.querySelector('.tx-repo-label'))?.textContent);
const active = () => box().getAttribute('aria-activedescendant');
const status = () => {
  const s = container.querySelector<HTMLElement>('.cmp-pop-status');
  return s && !s.hidden ? s.textContent : null;
};
const note = () => {
  const n = container.querySelector<HTMLElement>('.cmp-pop-note');
  return n && !n.hidden ? n.textContent : null;
};
const chips = () => [...box().querySelectorAll<HTMLElement>('.cmp-file')];

function mount(h: TranscriptRenderHost): TranscriptView {
  view = mountTranscript(container, h);
  view.setItems([]);
  view.focusPrompt();
  return view;
}

/** Typing `s` at the caret (the end of the text unless moved). */
function type(s: string): void {
  const ed = box();
  let node = [...ed.childNodes].reverse().find((n) => n.nodeType === Node.TEXT_NODE) as Text | undefined;
  const sel = document.getSelection();
  let at: number;
  if (sel && sel.rangeCount && sel.focusNode instanceof Text && ed.contains(sel.focusNode)) {
    node = sel.focusNode;
    at = sel.focusOffset;
  } else {
    if (!node) {
      node = document.createTextNode('');
      ed.replaceChildren(node);
    }
    at = node.length;
  }
  node.insertData(at, s);
  sel?.setBaseAndExtent(node, at + s.length, node, at + s.length);
  ed.dispatchEvent(new Event('input', { bubbles: true }));
}
const press = (k: string, init: KeyboardEventInit = {}) => box().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));

beforeEach(() => {
  container = document.createElement('div');
  document.body.replaceChildren(container);
  document.getSelection()?.removeAllRanges();
});
afterEach(() => {
  view?.destroy();
  view = null;
});

function ready(): Bridge {
  const b = bridge();
  mount(host(b));
  return b;
}

const REPOS = [ref('api', { repo: 'acme/api-server', dir: '/src/api', cloned: true }), ref('web', { repo: 'acme/web' }), ref('docs', { dir: '/home/me/My Notes' })];

describe('the `@` source: files, or repositories behind r:', () => {
  it('@r: lists the other floors’ repositories, the prefix taken off the query; a pick puts in plain text', async () => {
    const b = ready();
    type('see @r:');
    expect(isOpen()).toBe(true);
    expect(list()?.getAttribute('aria-label')).toBe('Repositories on other floors');
    expect(status()).toBe('Loading…');
    expect(b.repos).toEqual([{ id: 'w1' }]);
    expect(b.files).toEqual([]);
    await b.answerRepos(0, okRepos(REPOS));
    expect(names()).toEqual(['acme/api-server', 'acme/web', 'My Notes']);
    type('wb');
    expect(names()).toEqual(['acme/web']);
    // The bridge was asked once for the popup: the query ranks locally.
    expect(b.repos).toHaveLength(1);
    press('Enter');
    expect(isOpen()).toBe(false);
    expect(box().textContent).toBe('see https://github.com/acme/web ');
    expect(chips()).toHaveLength(0);
  });

  it('@repo: does the same; a cloned repo puts in its folder, a folder with a space goes in quoted', async () => {
    const b = ready();
    type('@repo:api');
    await b.answerRepos(0, okRepos(REPOS));
    expect(names()).toEqual(['acme/api-server']);
    press('Tab');
    expect(box().textContent).toBe('/src/api ');
    type('@r:notes');
    // A new popup asks again; the rows known show at once.
    expect(b.repos).toHaveLength(2);
    expect(names()).toEqual(['My Notes']);
    press('Enter');
    expect(box().textContent).toBe('/src/api "/home/me/My Notes" ');
  });

  for (const q of ['r', 'repo', 'rx:', './r:x']) {
    it(`@${q} stays a file search, the query whole`, async () => {
      const b = ready();
      type(`@${q}`);
      expect(list()?.getAttribute('aria-label')).toBe('Files and folders');
      await b.fire();
      expect(b.files.at(-1)).toEqual({ id: 'w1', query: q, limit: 30 });
      expect(b.repos).toEqual([]);
    });
  }

  it('the file popup hints at r: when it has nothing else to say', async () => {
    const b = ready();
    type('@comp');
    await b.fire();
    await b.answerFiles(0, okFiles([file('src/composer.ts')]));
    expect(note()).toBe(REPO_HINT);
    type('x');
    await b.fire();
    await b.answerFiles(1, { ok: true, data: { files: [], source: 'git', reason: 'index still building' } });
    expect(note()).toBe('index still building');
  });

  it('switching between files and repositories keeps no stale active row and follows the label', async () => {
    const b = ready();
    type('@r');
    await b.fire();
    await b.answerFiles(0, okFiles([file('a.ts'), file('r.ts')]));
    press('ArrowDown');
    const fileRow = active();
    expect(fileRow).toBeTruthy();
    expect(rows().findIndex((r) => r.id === fileRow)).toBe(1);
    type(':');
    expect(list()?.getAttribute('aria-label')).toBe('Repositories on other floors');
    await b.answerRepos(0, okRepos(REPOS));
    expect(names()).toEqual(['acme/api-server', 'acme/web', 'My Notes']);
    // The first row is active, not the second one the file list had.
    expect(rows().findIndex((r) => r.id === active())).toBe(0);
    expect(note()).toBeNull();
    // The colon deleted: files again (the label paints with the pending query).
    const t = [...box().childNodes].find((n): n is Text => n instanceof Text) as Text;
    t.deleteData(t.length - 1, 1);
    document.getSelection()?.setBaseAndExtent(t, t.length, t, t.length);
    box().dispatchEvent(new Event('input', { bubbles: true }));
    expect(list()?.getAttribute('aria-label')).toBe('Files and folders');
    await b.fire();
    expect(b.files.at(-1)).toEqual({ id: 'w1', query: 'r', limit: 30 });
  });

  it('an empty repository list says so under “No match”', async () => {
    const b = ready();
    type('@r:');
    await b.answerRepos(0, okRepos([]));
    expect(status()).toBe('No match');
    expect(note()).toBe('No other floors in this building have a repository or folder');
  });
});
