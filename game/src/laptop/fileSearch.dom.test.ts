// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import type { CommandArgs, FileMatch } from '../net/protocol';
import { IMG } from '../ui/composer/model';
import { DEBOUNCE_MS, FILES_LIMIT, type FileSearchHost } from './fileSearch';
import { mountTranscript, type TranscriptRenderHost, type TranscriptView } from './transcriptRender';

// #141: the transcript's `@` popup, the real composer and popup over a worker's checkout whose bridge the test answers
// and whose debounce the test fires by hand.

interface Bridge extends FileSearchHost {
  asks: CommandArgs['worker.files'][];
  timers: { f: () => void; ms: number; live: boolean }[];
  /** Runs the debounce timers that are still set. */
  fire(): Promise<void>;
  answer(i: number, r: CommandResult): Promise<void>;
}

function bridge(): Bridge {
  const waiting: ((r: CommandResult) => void)[] = [];
  const b: Bridge = {
    asks: [],
    timers: [],
    send: (_t, args) => {
      b.asks.push(args);
      return new Promise<CommandResult>((res) => waiting.push(res));
    },
    setTimeout: (f, ms) => {
      const t = { f, ms, live: true };
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
    async answer(i, r) {
      waiting[i]?.(r);
      await flush();
    },
  };
  return b;
}

const m = (path: string, indices: number[] = [], kind: FileMatch['kind'] = 'file'): FileMatch => ({ path, kind, indices });
const ok = (files: FileMatch[], source = 'git', reason: string | null = null): CommandResult => ({ ok: true, data: { files, source, reason } });

function host(files: { id: string; search: FileSearchHost } | null): TranscriptRenderHost & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    images: null,
    prompts,
    files,
    onPromptSubmit: (t) => {
      prompts.push(t);
      return Promise.resolve(true);
    },
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
const names = () => rows().map((r) => r.querySelector('.tx-file-name')?.textContent);
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

function ready(): { b: Bridge; h: ReturnType<typeof host> } {
  const b = bridge();
  const h = host({ id: 'w1', search: b });
  mount(h);
  return { b, h };
}

describe('the transcript composer searches the worker’s files', () => {
  it('@ opens “Files and folders”, asks the bridge once the typing pauses, and lists what it answers in its order', async () => {
    const { b } = ready();
    type('@');
    expect(isOpen()).toBe(true);
    expect(list()?.getAttribute('aria-label')).toBe('Files and folders');
    expect(status()).toBe('Searching files…');
    expect(b.asks).toEqual([]);
    expect(b.timers.map((t) => t.ms)).toEqual([DEBOUNCE_MS]);
    await b.fire();
    expect(b.asks).toEqual([{ id: 'w1', query: '', limit: FILES_LIMIT }]);
    await b.answer(0, ok([m('src', [], 'dir'), m('README.md'), m('src/ui/composer.ts')]));
    expect(names()).toEqual(['src/', 'README.md', 'composer.ts']);
    expect(rows().map((r) => r.querySelector('.tx-file-dir')?.textContent ?? null)).toEqual([null, null, 'src/ui']);
    expect(rows()[0]?.querySelector('.tx-file')?.getAttribute('data-kind')).toBe('dir');
    expect(rows()[2]?.querySelector('.tx-file')?.getAttribute('title')).toBe('src/ui/composer.ts');
    expect(rows()[0]?.textContent).toBe('src/, folder');
    expect(note()).toBeNull();
  });

  it('fast typing asks once, for the latest query: a query it moved on from never asks', async () => {
    const { b } = ready();
    type('@');
    type('c');
    type('o');
    type('mp');
    expect(b.timers.filter((t) => t.live)).toHaveLength(1);
    await b.fire();
    expect(b.asks.map((a) => a.query)).toEqual(['comp']);
  });

  it('marks the matched characters, counted in code points over the whole path (basename and folder)', async () => {
    const { b } = ready();
    type('@🙂a');
    await b.fire();
    // 'd/🙂/a🙂b.md': d=0 /=1 🙂=2 /=3 a=4 🙂=5 b=6
    await b.answer(0, ok([m('d/🙂/a🙂b.md', [2, 4, 5])]));
    const r = rows()[0] as HTMLElement;
    expect([...r.querySelectorAll('.tx-file-name .tx-file-hit')].map((e) => e.textContent)).toEqual(['a🙂']);
    expect([...r.querySelectorAll('.tx-file-dir .tx-file-hit')].map((e) => e.textContent)).toEqual(['🙂']);
    expect(r.querySelector('.tx-file-name')?.textContent).toBe('a🙂b.md');
    expect(r.querySelector('.tx-file-dir')?.textContent).toBe('d/🙂');
  });

  it('keeps the last rows dimmed and not pickable while the next query is out, and drops a reply that is not the latest', async () => {
    const { b } = ready();
    type('@a');
    await b.fire();
    await b.answer(0, ok([m('a.ts')]));
    type('b');
    await b.fire();
    expect(list()?.hasAttribute('data-loading')).toBe(true);
    expect(names()).toEqual(['a.ts']);
    expect(rows()[0]?.getAttribute('aria-disabled')).toBe('true');
    press('Enter'); // nothing to pick: it closes and sends nothing
    expect(chips()).toHaveLength(0);
    type('c');
    await b.fire();
    await b.answer(2, ok([m('abc.ts')]));
    await b.answer(1, ok([m('ab.ts')])); // late
    expect(names()).toEqual(['abc.ts']);
  });

  it('does not offer a path no mention could carry whole', async () => {
    const { b } = ready();
    type('@a');
    await b.fire();
    await b.answer(0, ok([m('a"b.ts'), m('a\nb.ts'), m('a b.ts'), m('ok.ts')]));
    expect(names()).toEqual(['a b.ts', 'ok.ts']);
  });

  it('a pick puts in a file chip and a space, the caret after them, one undo step; a folder too', async () => {
    const { b } = ready();
    type('see @comp');
    await b.fire();
    await b.answer(0, ok([m('game/src/ui/composer.ts', [17, 18, 19, 20])]));
    press('Enter');
    expect(isOpen()).toBe(false);
    const c = chips();
    expect(c).toHaveLength(1);
    expect(c[0]?.getAttribute('aria-label')).toBe('File game/src/ui/composer.ts');
    expect(c[0]?.title).toBe('game/src/ui/composer.ts');
    type('and @ui');
    await b.fire();
    await b.answer(1, ok([m('game/src/ui', [9, 10], 'dir')]));
    press('Tab');
    expect(chips()[1]?.getAttribute('aria-label')).toBe('Folder game/src/ui');
    press('z', { ctrlKey: true });
    expect(chips()).toHaveLength(1);
  });

  it('a pick consumes a space already after the word', async () => {
    const { b, h } = ready();
    type('@x tail');
    // the caret back right after `@x`
    const t = [...box().childNodes].find((n) => n.nodeType === Node.TEXT_NODE) as Text;
    document.getSelection()?.setBaseAndExtent(t, 2, t, 2);
    type('y');
    await b.fire();
    await b.answer(0, ok([m('xy.ts')]));
    press('Enter');
    press('Enter');
    await flush();
    expect(h.prompts).toEqual(['@xy.ts tail']);
  });

  it('sends the chip as @path, quoted when it has spaces, beside the text', async () => {
    const { b, h } = ready();
    type('read @my');
    await b.fire();
    await b.answer(0, ok([m('my docs/a b.txt')]));
    press('Enter');
    type('now');
    press('Enter');
    await flush();
    expect(h.prompts).toEqual(['read @"my docs/a b.txt" now']);
  });

  it('says the bridge’s reason under the rows, and a checkout with no file list; neither turns it off', async () => {
    const { b } = ready();
    type('@a');
    await b.fire();
    await b.answer(0, ok([m('a.ts')], 'git', 'the file list is still being built'));
    expect(note()).toBe('the file list is still being built');
    press('Escape');
    type(' @');
    await b.fire();
    await b.answer(1, ok([], 'none', null));
    expect(status()).toBe('No match');
    expect(note()).toBe('No file list for this checkout');
    press('Escape');
    type(' @');
    expect(isOpen()).toBe(true);
    await b.fire();
    expect(b.asks).toHaveLength(3);
  });

  it('a failed search says so (the next @ asks again)', async () => {
    const { b } = ready();
    type('@a');
    await b.fire();
    await b.answer(0, { ok: false, code: 'invalid_state', message: 'asleep' });
    expect(status()).toBe('Could not search the files: asleep.');
  });

  it('a chip next to text keeps the text atomic around it: Backspace after it takes the chip whole', async () => {
    const { b } = ready();
    type('@a');
    await b.fire();
    await b.answer(0, ok([m('a.ts')]));
    press('Enter');
    expect(view).not.toBeNull();
    // The caret is after the space: back over it, then the chip.
    const text = () => (box().textContent ?? '').replace(/​/g, '');
    expect(text()).toBe('a.ts ');
    const ev = (t: string) => new InputEvent('beforeinput', { inputType: t, bubbles: true, cancelable: true });
    const tail = box().lastChild?.previousSibling as Text; // the text node after the chip (before the tail <br>)
    document.getSelection()?.setBaseAndExtent(tail, 0, tail, 0);
    const e = ev('deleteContentBackward');
    box().dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(chips()).toHaveLength(0);
    expect(box().textContent?.includes(IMG)).toBe(false);
  });

  it('without a checkout to search, @ opens nothing', () => {
    mount(host(null));
    type('@a');
    expect(isOpen()).toBe(false);
  });
});
