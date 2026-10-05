// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import type { CommandEntry } from '../net/protocol';
import { CommandCatalogs, type WorkerCommandList } from './commandCatalog';
import { offsetToPoint } from '../ui/composer/tree';
import { mountTranscript, type TranscriptRenderHost, type TranscriptView } from './transcriptRender';

// #140: the transcript's `/` popup, the real composer and popup over a worker's command list whose bridge the test
// answers. Typing is the browser's: the text goes into the editor's text node, the caret after it, then `input`.

const cmd = (name: string, description = '', argument_hint = '', kind: CommandEntry['kind'] = 'command'): CommandEntry => ({ name, description, argument_hint, kind });
const CLAUDE: CommandEntry[] = [
  cmd('compact', 'Free up context by summarizing the conversation so far', '<optional custom summarization instructions>'),
  cmd('review', 'Review a pull request'),
  cmd('caveman:caveman-commit', '(caveman) Ultra-compressed commit message generator.\nSecond line.', '', 'skill'),
  cmd('handoff', 'Compact the conversation into a handoff document (user)', 'What will the next session be used for?', 'skill'),
  cmd('deploy', 'Deploy the bridge to the test host (project)', '<host>', 'custom'),
];
const CODEX: CommandEntry[] = [cmd('humanizer:humanizer', 'Remove AI writing patterns', '', 'skill'), cmd('init', 'create an AGENTS.md file'), cmd('review', 'review my current changes', '<instructions>')];

interface Bridge {
  list: WorkerCommandList;
  asks: number;
  answer(r: CommandResult): Promise<void>;
}

function bridge(): Bridge {
  const waiting: ((r: CommandResult) => void)[] = [];
  const b = {
    asks: 0,
    async answer(r: CommandResult) {
      waiting.shift()?.(r);
      await flush();
    },
  } as Bridge;
  const catalogs = new CommandCatalogs({
    send: () => {
      b.asks++;
      return new Promise<CommandResult>((res) => waiting.push(res));
    },
  });
  b.list = catalogs.get('w1');
  return b;
}
const ok = (commands: CommandEntry[], partial = false): CommandResult => ({ ok: true, data: { commands, partial } });

function host(commands: NonNullable<TranscriptRenderHost['commands']> | null): TranscriptRenderHost & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    images: null,
    prompts,
    commands,
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
const text = () => (box().textContent ?? '').replace(/​/g, '');
const pop = () => container.querySelector<HTMLElement>('.cmp-pop');
const isOpen = () => !!pop() && !pop()!.hidden;
const rows = () => [...container.querySelectorAll<HTMLElement>('[role="option"]')];
const names = () => rows().map((r) => r.querySelector('.tx-cmd-name')?.textContent);
const active = () => rows().find((r) => r.getAttribute('aria-selected') === 'true')?.querySelector('.tx-cmd-name')?.textContent ?? null;
const status = () => {
  const s = container.querySelector<HTMLElement>('.cmp-pop-status');
  return s && !s.hidden ? s.textContent : null;
};
const note = () => {
  const n = container.querySelector<HTMLElement>('.cmp-pop-note');
  return n && !n.hidden ? n.textContent : null;
};

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
/** The caret put at a draft offset (the editor's text nodes have markers the offsets skip). */
function caretAt(offset: number): void {
  const p = offsetToPoint(box(), offset);
  document.getSelection()?.setBaseAndExtent(p.node, p.offset, p.node, p.offset);
  document.dispatchEvent(new Event('selectionchange'));
}
const press = (k: string) => box().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

beforeEach(() => {
  container = document.createElement('div');
  document.body.replaceChildren(container);
  document.getSelection()?.removeAllRanges();
});
afterEach(() => {
  view?.destroy();
  view = null;
});

async function ready(harness = 'claude', list: CommandEntry[] = CLAUDE): Promise<{ b: Bridge; h: ReturnType<typeof host> }> {
  const b = bridge();
  const h = host({ list: b.list, harness });
  mount(h);
  b.list.refresh();
  await b.answer(ok(list));
  return { b, h };
}

describe('the transcript composer lists the worker’s commands and skills', () => {
  it('/ at the start lists them all, in the harness’s order: /name, the argument hint, the description, the kind', async () => {
    await ready();
    type('/');
    expect(isOpen()).toBe(true);
    expect(container.querySelector('[role="listbox"]')?.getAttribute('aria-label')).toBe('Commands and skills');
    expect(names()).toEqual(['/compact', '/review', '/caveman:caveman-commit', '/handoff', '/deploy']);
    const first = rows()[0] as HTMLElement;
    expect(first.querySelector('.tx-cmd-arg')?.textContent).toBe('<optional custom summarization instructions>');
    expect(first.querySelector('.tx-cmd-desc')?.textContent).toBe('Free up context by summarizing the conversation so far');
    expect(first.querySelector('.tx-cmd-kind')?.textContent).toBe('command');
    expect(rows()[1]?.querySelector('.tx-cmd-arg')).toBeNull();
    // One line: a description's later lines are not drawn (its whole text is the row's tooltip).
    const cave = rows()[2] as HTMLElement;
    expect(cave.querySelector('.tx-cmd-desc')?.textContent).toBe('(caveman) Ultra-compressed commit message generator.');
    expect(cave.querySelector('.tx-cmd')?.getAttribute('title')).toContain('Second line.');
    expect(rows().map((r) => r.querySelector('.tx-cmd-kind')?.textContent)).toEqual(['command', 'command', 'skill', 'skill', 'custom']);
    expect(note()).toBeNull();
  });

  it('filters as I type, prefix and word starts before substrings, and highlights the matched characters', async () => {
    await ready();
    type('/co');
    expect(names()).toEqual(['/compact', '/caveman:caveman-commit']);
    const hits = (r: HTMLElement) => [...r.querySelectorAll('.tx-cmd-hit')].map((e) => e.textContent).join('');
    expect(rows().map(hits)).toEqual(['co', 'co']);
    type('mm');
    expect(names()).toEqual(['/caveman:caveman-commit']);
    type('x');
    expect(names()).toEqual([]);
    expect(status()).toBe('No match');
  });

  it('a pick (Enter, Tab or a click) puts /name and a space in, as plain text', async () => {
    await ready();
    type('/rev');
    press('Enter');
    expect(text()).toBe('/review ');
    expect(isOpen()).toBe(false);
    type('/han');
    press('Tab');
    expect(text()).toBe('/review /handoff ');
    type('/dep');
    (rows()[0] as HTMLElement).click();
    expect(text()).toBe('/review /handoff /deploy ');
    expect(box().querySelector('.tx-cmd')).toBeNull();
  });

  it('opens mid-sentence; a pick there takes the space that follows instead of adding one', async () => {
    const { h } = await ready();
    type('use the /cav skill');
    expect(isOpen()).toBe(false);
    caretAt('use the /cav'.length);
    type('e');
    expect(isOpen()).toBe(true);
    expect(names()).toEqual(['/caveman:caveman-commit']);
    press('Enter');
    expect(text()).toBe('use the /caveman:caveman-commit skill');
    // Closed: Enter sends.
    press('Enter');
    await flush();
    expect(h.prompts).toEqual(['use the /caveman:caveman-commit skill']);
  });

  it('a path is not a command: /usr/bin, a/b and URLs open nothing', async () => {
    await ready();
    type('ls /usr/bin');
    expect(isOpen()).toBe(false);
    type(' a/b https://x/y');
    expect(isOpen()).toBe(false);
  });

  it('Esc closes the popup only; Enter then sends', async () => {
    const { h } = await ready();
    type('/rev');
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    box().dispatchEvent(esc);
    expect(isOpen()).toBe(false);
    expect(esc.defaultPrevented).toBe(true);
    press('Enter');
    await flush();
    expect(h.prompts).toEqual(['/rev']);
  });
});

describe('the list: cached, refreshed, and its states', () => {
  it('no list yet: Loading…, then the rows when the bridge answers', async () => {
    const b = bridge();
    mount(host({ list: b.list, harness: 'claude' }));
    type('/');
    expect(b.asks).toBe(1);
    expect(status()).toBe('Loading…');
    await b.answer(ok(CLAUDE));
    expect(names()).toHaveLength(5);
    expect(status()).toBeNull();
  });

  it('asks when the transcript opens and again when the popup opens; the cached list shows at once and follows the refresh', async () => {
    const b = bridge();
    mount(host({ list: b.list, harness: 'claude' }));
    b.list.refresh(); // what the seated view does as the transcript opens
    await b.answer(ok(CLAUDE.slice(0, 2)));
    type('/');
    expect(b.asks).toBe(2);
    expect(names()).toEqual(['/compact', '/review']);
    press('ArrowDown');
    expect(active()).toBe('/review');
    await b.answer(ok([cmd('clear'), ...CLAUDE.slice(0, 2)]));
    expect(names()).toEqual(['/clear', '/compact', '/review']);
    expect(active()).toBe('/review');
    // Typing more does not ask again: one ask per popup.
    type('r');
    expect(b.asks).toBe(2);
  });

  it('partial: the built-ins it has, and a quiet note', async () => {
    const b = bridge();
    mount(host({ list: b.list, harness: 'claude' }));
    type('/');
    await b.answer(ok([], true));
    expect(status()).toBe('No match');
    expect(note()).toBe('Partial list: only the built-in commands so far');
  });

  it('the first ask failing says so and is not stuck loading; the next popup asks again', async () => {
    const b = bridge();
    mount(host({ list: b.list, harness: 'claude' }));
    type('/');
    await b.answer({ ok: false, code: 'timeout', message: 'no answer' });
    expect(status()).toBe('Could not load matches.');
    press('Escape');
    type(' /');
    expect(b.asks).toBe(2);
    await b.answer(ok(CLAUDE));
    expect(names()).toHaveLength(5);
  });

  it('a refresh that fails keeps the list, with a note', async () => {
    const { b } = await ready();
    type('/');
    await b.answer({ ok: false, code: 'disconnected', message: 'gone' });
    expect(names()).toHaveLength(5);
    expect(note()).toBe('Could not refresh: the list may be out of date');
  });

  it('a worker with no Claude or Codex agent (invalid_state): no popup at all, the box works as before', async () => {
    const b = bridge();
    const h = host({ list: b.list, harness: 'claude' });
    mount(h);
    b.list.refresh();
    await b.answer({ ok: false, code: 'invalid_state', message: 'runs no Claude or Codex agent' });
    type('/he');
    expect(isOpen()).toBe(false);
    press('Enter');
    await flush();
    expect(h.prompts).toEqual(['/he']);
  });

  it('invalid_state while the popup waits closes it', async () => {
    const b = bridge();
    mount(host({ list: b.list, harness: 'claude' }));
    type('/');
    expect(isOpen()).toBe(true);
    await b.answer({ ok: false, code: 'invalid_state', message: 'asleep' });
    expect(isOpen()).toBe(false);
  });

  it('no popup while the worker waits on a question (the box is disabled)', async () => {
    await ready();
    type('/re');
    expect(isOpen()).toBe(true);
    view?.setBlocked({ kind: 'confirm', text: 'Proceed?', excerpt: [], choices: [{ n: 1, label: 'Yes' }], hash: 'h1' });
    expect(isOpen()).toBe(false);
    expect(box().getAttribute('contenteditable')).toBe('false');
  });

  it('without a command list (another host) the transcript box opens nothing', () => {
    mount(host(null));
    type('/re');
    expect(pop()).toBeNull();
  });
});

describe('per harness', () => {
  it('Codex: skills keep the / label, with a hint that they are sent as $name', async () => {
    await ready('codex', CODEX);
    type('/');
    expect(names()).toEqual(['/humanizer:humanizer', '/init', '/review']);
    expect(note()).toBe('Codex: skills are sent as $name');
    type('hu');
    press('Enter');
    expect(text()).toBe('/humanizer:humanizer ');
  });

  it('Codex with no skill in the list: no hint', async () => {
    await ready('codex', CODEX.slice(1));
    type('/');
    expect(note()).toBeNull();
  });

  it('Claude: no hint, a skill is typed as it is sent', async () => {
    await ready('claude');
    type('/han');
    expect(note()).toBeNull();
  });
});
