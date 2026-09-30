// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptItem } from '../net/protocol';
import { duration, loadHighlighter, mountTranscript, parseHunk, stripAnsi, type BlockedQuestion, type TranscriptRenderHost, type TranscriptView } from './transcriptRender';

interface FakeHost extends TranscriptRenderHost {
  prompts: string[];
  answers: Array<[string, number | null, boolean | undefined]>;
  terminal: number;
  loads: string[];
}

function fakeHost(load: (id: string) => Promise<TranscriptItem[]> = async () => []): FakeHost {
  const host: FakeHost = {
    prompts: [],
    answers: [],
    terminal: 0,
    loads: [],
    onPromptSubmit: (t) => host.prompts.push(t),
    onAnswer: (hash, n, cancel) => host.answers.push([hash, n, cancel]),
    onSwitchToTerminal: () => host.terminal++,
    loadSubagent: (id) => {
      host.loads.push(id);
      return load(id);
    },
  };
  return host;
}

let seq = 0;
const T0 = Date.UTC(2026, 8, 30, 9, 0, 0);
function item(kind: TranscriptItem['kind'], extra: Partial<TranscriptItem> = {}): TranscriptItem {
  seq++;
  return { id: `i${seq}`, seq, ts: T0 + seq * 1000, kind, ...extra };
}
const text = (t: string) => ({ text: t });

let container: HTMLDivElement;
let host: FakeHost;
let view: TranscriptView;

function mount(h: FakeHost = fakeHost()): TranscriptView {
  host = h;
  view = mountTranscript(container, host);
  return view;
}
const $ = <E extends Element = HTMLElement>(sel: string) => container.querySelector<E>(sel);
const $$ = <E extends Element = HTMLElement>(sel: string) => [...container.querySelectorAll<E>(sel)];
const row = (id: string) => $(`[data-id="${id}"]`) as HTMLElement;
const flush = () => new Promise((r) => setTimeout(r, 0));

/** jsdom has no layout: give the scroller a size and a real, settable scrollTop. */
function layout(el: HTMLElement, content: number | (() => number), client = 400): void {
  let top = 0;
  const hOf = typeof content === 'number' ? () => content : content;
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: hOf });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => client });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, Math.max(0, hOf() - client)));
    },
  });
}

beforeEach(() => {
  seq = 0;
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(() => {
  view?.destroy();
  container.remove();
  delete (window as unknown as Record<string, unknown>).__pwned;
});

describe('untrusted text renders inert (marked + DOMPurify)', () => {
  const EVIL = [
    'Before <script>window.__pwned = 1</script> after',
    '<img src=x onerror="window.__pwned = 2">',
    '<a href="javascript:window.__pwned=3" onclick="window.__pwned=4">html link</a>',
    '[md link](javascript:window.__pwned=5) and [data](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==) and [vb](vbscript:msgbox)',
    '<javascript:alert(1)> and ![pixel](https://evil.example/p.png) and [ok](https://example.com/x)',
    '<iframe src="https://evil.example"></iframe><svg onload="window.__pwned=6"></svg><style>body{display:none}</style>',
    '<details open ontoggle="window.__pwned=7"><summary>s</summary></details>',
    '```html\n<script>window.__pwned = 8</script>\n```',
  ].join('\n\n');

  function assertInert(root: HTMLElement): void {
    expect(root.querySelector('script, img, iframe, svg:not([aria-hidden="true"]), style, object, embed, form, details')).toBeNull();
    for (const el of root.querySelectorAll('*')) {
      for (const a of el.getAttributeNames()) expect(a.toLowerCase().startsWith('on'), `${el.tagName} has ${a}`).toBe(false);
      const href = el.getAttribute('href');
      if (href !== null) expect(href).toMatch(/^(?:https?:|mailto:)/i);
      for (const a of ['src', 'srcdoc', 'action', 'formaction', 'xlink:href']) expect(el.hasAttribute(a), `${el.tagName}[${a}]`).toBe(false);
    }
    for (const a of root.querySelectorAll('a[href]')) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    }
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
  }

  it('assistant and user markdown: no script, no handler, javascript:/data: links neutralised', async () => {
    mount();
    view.setItems([item('assistant', { parts: [text(EVIL)] }), item('user', { parts: [text(EVIL)] }), item('thinking', { parts: [text(EVIL)] })]);
    (row('i3').querySelector('button') as HTMLButtonElement).click();
    await loadHighlighter();
    await flush();
    const md = $$('.tx-md');
    expect(md.length).toBe(3);
    for (const m of md) assertInert(m);
    // Raw HTML is shown as text, not dropped silently.
    expect(md[0]?.textContent).toContain('<script>window.__pwned = 1</script>');
    expect(md[0]?.textContent).toContain('<img src=x onerror=');
    // The one good link survives, opening in a new context.
    const ok = md[0]?.querySelector('a[href="https://example.com/x"]');
    expect(ok).not.toBeNull();
    // The markdown image became a link, not an <img>.
    expect(md[0]?.querySelector('a[href="https://evil.example/p.png"]')?.textContent).toBe('pixel');
    // A javascript: markdown link keeps its text but loses the href; the raw HTML one is only text.
    const js = [...(md[0]?.querySelectorAll('a') ?? [])].filter((a) => a.textContent === 'md link');
    expect(js.length).toBe(1);
    for (const a of js) expect(a.hasAttribute('href')).toBe(false);
    expect([...(md[0]?.querySelectorAll('a') ?? [])].some((a) => a.textContent === 'html link')).toBe(false);
    expect(md[0]?.textContent).toContain('<a href="javascript:window.__pwned=3"');
    assertInert(container);
  });

  it('tool output and input are text, not HTML', () => {
    mount();
    view.setItems([item('tool', { tool: { name: 'WebFetch', input_summary: '<img src=x onerror=alert(1)>', input: { url: 'javascript:alert(1)', html: '<script>x</script>' }, status: 'ok', output_text: EVIL } })]);
    ($('.tx-tool-row') as HTMLButtonElement).click();
    const out = $$('.tx-out');
    expect(out.length).toBe(2);
    expect(out[1]?.textContent).toContain('<script>window.__pwned = 1</script>');
    expect($('.tx-tool-sum')?.textContent).toBe('<img src=x onerror=alert(1)>');
    assertInert(container);
    expect($$('.tx-tool-body a').length).toBe(0);
  });

  it('highlighted code is re-sanitised: spans only', async () => {
    mount();
    view.setItems([item('assistant', { parts: [text('```js\nconst a = "<img src=x onerror=alert(1)>"; // hi\n```')] })]);
    await loadHighlighter();
    const code = $('pre code') as HTMLElement;
    expect(code.classList.contains('hljs')).toBe(true);
    expect(code.querySelector('span.hljs-keyword')?.textContent).toBe('const');
    for (const el of code.querySelectorAll('*')) {
      expect(el.tagName).toBe('SPAN');
      expect(el.getAttributeNames().every((a) => a === 'class')).toBe(true);
    }
    expect(code.textContent).toContain('<img src=x onerror=alert(1)>');
    assertInert(container);
  });
});

describe('rows per kind', () => {
  it('user bubble, assistant markdown, the image placeholder chip', () => {
    mount();
    view.setItems([item('user', { parts: [text('look at **this**'), { image_omitted: true }] }), item('assistant', { parts: [text('# Title\n\n- one\n- two')] })]);
    const u = row('i1');
    expect(u.querySelector('.tx-bubble strong')?.textContent).toBe('this');
    const chip = u.querySelector('.tx-img-chip') as HTMLElement;
    expect(chip.textContent).toContain('[image — not shown yet]');
    expect(chip.tagName).toBe('SPAN');
    expect(chip.closest('button, a')).toBeNull();
    const a = row('i2');
    expect(a.querySelector('.tx-said h1')?.textContent).toBe('Title');
    expect(a.querySelectorAll('li').length).toBe(2);
  });

  it('code blocks are plain <pre> until the highlighter loads', async () => {
    mount();
    view.setItems([item('assistant', { parts: [text('```python\ndef f():\n    return 1\n```')] })]);
    const pre = $('pre') as HTMLElement;
    expect(pre.dataset.lang).toBe('python');
    expect(await loadHighlighter()).toBe(true);
    expect(pre.querySelector('code')?.classList.contains('hljs')).toBe(true);
    expect(pre.querySelector('.hljs-keyword')?.textContent).toBe('def');
  });

  it('thinking is collapsed; encrypted reasoning is a bare chip', () => {
    mount();
    view.setItems([item('thinking', { parts: [text('I should *check* the tests')] }), item('thinking', {})]);
    const chip = row('i1').querySelector('button') as HTMLButtonElement;
    const body = row('i1').querySelector('.tx-thinking-body') as HTMLElement;
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    expect(body.hidden).toBe(true);
    chip.click();
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    expect(body.hidden).toBe(false);
    expect(body.querySelector('em')?.textContent).toBe('check');
    expect(row('i2').querySelector('button')).toBeNull();
    expect(row('i2').textContent).toContain('reasoning');
  });

  it('a tool row: icon, name, summary, status; expanded: ANSI-stripped output, truncation note, input', () => {
    mount();
    view.setItems([
      item('tool', {
        tool: { name: 'Bash', input_summary: 'pnpm test', input: { command: 'pnpm test', timeout: 60000 }, status: 'error', output_text: '\u001b[31mFAIL\u001b[0m src/a.test.ts\r\n\u001b[1m1 failed\u001b[22m', output_truncated: true },
      }),
    ]);
    const r = row('i1');
    expect(r.dataset.status).toBe('error');
    expect(r.querySelector('.tx-tool-icon svg')).not.toBeNull();
    expect(r.querySelector('.tx-tool-name')?.textContent).toBe('Bash');
    expect(r.querySelector('.tx-tool-sum')?.textContent).toBe('pnpm test');
    expect(r.querySelector('.tx-tool-status')?.textContent).toBe('error');
    const body = r.querySelector('.tx-tool-body') as HTMLElement;
    expect(body.hidden).toBe(true);
    (r.querySelector('.tx-tool-row') as HTMLButtonElement).click();
    expect(body.hidden).toBe(false);
    const outs = [...body.querySelectorAll('.tx-out')].map((e) => e.textContent);
    expect(outs[0]).toContain('"timeout": 60000');
    expect(outs[1]).toBe('FAIL src/a.test.ts\n1 failed');
    expect(body.textContent).toContain('Output truncated');
  });

  it('a tool diff: a coloured unified view with line numbers, for the right file', () => {
    mount();
    view.setItems([
      item('tool', {
        tool: {
          name: 'Edit',
          input_summary: 'src/app.ts',
          status: 'ok',
          diff: { path: 'src/app.ts', hunks: [{ oldStart: 10, oldLines: 3, newStart: 10, newLines: 3, lines: [' const a = 1;', '-const b = 2;', '+const b = 3;', ' const c = 4;'] }] },
        },
      }),
    ]);
    expect(row('i1').querySelector('.tx-tool-row .tx-diff-stat')?.textContent).toBe('+1 −1');
    ($('.tx-tool-row') as HTMLButtonElement).click();
    expect($('.tx-diff-path')?.textContent).toBe('src/app.ts');
    expect($('.tx-dh')?.textContent).toContain('@@ -10,3 +10,3 @@');
    const add = $$('.tx-add');
    const del = $$('.tx-del');
    expect(add.map((e) => e.querySelector('.tx-dt')?.textContent)).toEqual(['+const b = 3;']);
    expect(del.map((e) => e.querySelector('.tx-dt')?.textContent)).toEqual(['-const b = 2;']);
    const nums = $$('.tx-dl:not(.tx-dh)').map((e) => [...e.querySelectorAll('.tx-dn')].map((n) => n.textContent));
    expect(nums).toEqual([
      ['10', '10'],
      ['11', ''],
      ['', '11'],
      ['12', '12'],
    ]);
  });

  it('compaction is a divider; notices and unknown entries hide until "show system"', () => {
    mount();
    view.setItems([item('compaction', { notice: { text: 'summary' } }), item('notice', { notice: { text: 'Turn took 12s' } }), item('unknown', { raw_type: 'queue-operation' })]);
    expect(row('i1').getAttribute('role')).toBe('separator');
    expect(row('i1').classList.contains('tx-sys')).toBe(false);
    expect(row('i2').classList.contains('tx-sys')).toBe(true);
    expect(row('i3').classList.contains('tx-sys')).toBe(true);
    expect(row('i3').querySelector('.tx-raw')?.textContent).toBe('queue-operation');
    const root = $('.tx') as HTMLElement;
    const btn = $('.tx-sys-toggle') as HTMLButtonElement;
    expect(root.dataset.system).toBe('hidden');
    expect(btn.textContent).toBe('Show system (2)');
    btn.click();
    expect(root.dataset.system).toBe('shown');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(row('i2').textContent).toContain('Turn took 12s');
  });

  it('malformed items never throw: they fall back to an unknown row', () => {
    mount();
    const bad = [
      { id: 'a', seq: 1, ts: 0, kind: 'tool' },
      { id: 'b', seq: 2, ts: 0, kind: 'subagent' },
      { id: 'c', seq: 3, ts: 0, kind: 'something-new', raw_type: 'future_block' },
      { id: 'd', seq: 4, ts: 0, kind: 'user', parts: [null, 42, { weird: true }] },
      { id: 'e', seq: 5, ts: 0, kind: 'tool', tool: { name: 'X', input_summary: 'y', status: 'ok', diff: { path: 'p', hunks: [42, 'garbage', { lines: [1, 2] }] } } },
      { seq: 6, kind: 'user' },
      null,
    ] as unknown as TranscriptItem[];
    expect(() => view.setItems(bad)).not.toThrow();
    expect(row('a').classList.contains('tx-unknown')).toBe(true);
    expect(row('b').classList.contains('tx-unknown')).toBe(true);
    expect(row('c').querySelector('.tx-raw')?.textContent).toBe('future_block');
    expect(() => (row('e').querySelector('button') as HTMLButtonElement).click()).not.toThrow();
    expect($$('.tx-item').length).toBe(5);
    expect(() => view.applyUpdates(bad)).not.toThrow();
  });
});

describe('live updates', () => {
  it('a running tool flips to ok in place (an update, not a duplicate) and shows how long it took', () => {
    mount();
    const user = item('user', { parts: [text('go')] });
    const running = item('tool', { ts: Date.now() - 2500, tool: { name: 'Bash', input_summary: 'sleep 2', status: 'running' } });
    view.setItems([user, running]);
    expect(row(running.id).dataset.status).toBe('running');
    expect(row(running.id).querySelector('.tx-tool-dur')?.textContent).toMatch(/^2\.\ds$|^2s$/);
    view.applyUpdates([{ ...running, tool: { name: 'Bash', input_summary: 'sleep 2', status: 'ok', output_text: 'done' } }]);
    expect($$(`[data-id="${running.id}"]`).length).toBe(1);
    expect(row(running.id).dataset.status).toBe('ok');
    expect(row(running.id).querySelector('.tx-tool-dur')?.textContent).toMatch(/^2s$/);
    expect($$('.tx-item').map((e) => e.dataset.id)).toEqual(['i1', running.id]);
  });

  it('an expanded row stays expanded across updates and resyncs', () => {
    mount();
    const t = item('tool', { tool: { name: 'Read', input_summary: 'a.ts', status: 'running' } });
    view.setItems([t]);
    ($('.tx-tool-row') as HTMLButtonElement).click();
    view.applyUpdates([{ ...t, tool: { name: 'Read', input_summary: 'a.ts', status: 'ok', output_text: 'file body' } }]);
    expect(($('.tx-tool-body') as HTMLElement).hidden).toBe(false);
    expect($('.tx-out')?.textContent).toBe('file body');
    view.setItems([{ ...t, tool: { name: 'Read', input_summary: 'a.ts', status: 'ok', output_text: 'file body 2' } }]);
    expect($('.tx-out')?.textContent).toBe('file body 2');
  });

  it('new items go in seq order', () => {
    mount();
    view.setItems([
      { id: 'a', seq: 1, ts: 1, kind: 'user', parts: [text('a')] },
      { id: 'c', seq: 5, ts: 3, kind: 'user', parts: [text('c')] },
    ]);
    view.applyUpdates([
      { id: 'd', seq: 9, ts: 4, kind: 'assistant', parts: [text('d')] },
      { id: 'b', seq: 3, ts: 2, kind: 'assistant', parts: [text('b')] },
    ]);
    expect($$('.tx-list > .tx-item').map((e) => e.dataset.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('follow mode', () => {
  it('sticks to the bottom while there; scrolled up, counts new items on a chip that jumps back', () => {
    mount();
    const sc = $('.tx-scroll') as HTMLElement;
    let height = 2000;
    layout(sc, () => height);
    view.setItems([item('user', { parts: [text('hi')] })]);
    expect(sc.scrollTop).toBe(1600);
    // At the bottom: new items keep it there.
    height = 2400;
    view.applyUpdates([item('assistant', { parts: [text('hello')] })]);
    expect(sc.scrollTop).toBe(2000);
    expect(($('.tx-jump') as HTMLElement).hidden).toBe(true);
    // Scrolled up: no auto-scroll, a chip instead.
    sc.scrollTop = 300;
    sc.dispatchEvent(new Event('scroll'));
    height = 2800;
    view.applyUpdates([item('assistant', { parts: [text('one')] }), item('tool', { tool: { name: 'Bash', input_summary: 'ls', status: 'running' } })]);
    view.applyUpdates([item('notice', { notice: { text: 'hidden, not counted' } })]);
    expect(sc.scrollTop).toBe(300);
    const jump = $('.tx-jump') as HTMLButtonElement;
    expect(jump.hidden).toBe(false);
    expect(jump.textContent).toBe('2 new · jump to latest');
    // An update of a known item is not "new".
    view.applyUpdates([{ id: 'i4', seq: 4, ts: T0, kind: 'tool', tool: { name: 'Bash', input_summary: 'ls', status: 'ok' } }]);
    expect(jump.textContent).toBe('2 new · jump to latest');
    jump.click();
    expect(sc.scrollTop).toBe(2400);
    expect(jump.hidden).toBe(true);
  });

  it('scrolling back down by hand clears the chip', () => {
    mount();
    const sc = $('.tx-scroll') as HTMLElement;
    layout(sc, 2000);
    view.setItems([item('user', { parts: [text('hi')] })]);
    sc.scrollTop = 0;
    sc.dispatchEvent(new Event('scroll'));
    view.applyUpdates([item('assistant', { parts: [text('x')] })]);
    expect(($('.tx-jump') as HTMLElement).hidden).toBe(false);
    sc.scrollTop = 1600;
    sc.dispatchEvent(new Event('scroll'));
    expect(($('.tx-jump') as HTMLElement).hidden).toBe(true);
  });
});

describe('keys inside the view', () => {
  const press = (target: Element, key: string, init: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(e);
    return e;
  };

  it('PageUp/PageDown, Home/End, j/k scroll the timeline and stay out of the game', () => {
    mount();
    const sc = $('.tx-scroll') as HTMLElement;
    layout(sc, 3000, 400);
    view.setItems([item('user', { parts: [text('hi')] })]);
    const seen: string[] = [];
    const onWin = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener('keydown', onWin);
    try {
      expect(sc.scrollTop).toBe(2600);
      press(sc, 'Home');
      expect(sc.scrollTop).toBe(0);
      press(sc, 'PageDown');
      expect(sc.scrollTop).toBe(360);
      press(sc, 'j');
      expect(sc.scrollTop).toBe(408);
      press(sc, 'k');
      press(sc, 'k');
      expect(sc.scrollTop).toBe(312);
      press(sc, 'PageUp');
      expect(sc.scrollTop).toBe(0);
      const e = press(sc, 'End');
      expect(sc.scrollTop).toBe(2600);
      expect(e.defaultPrevented).toBe(true);
      expect(seen).toEqual([]);
      // Keys it does not handle go on to the game (Esc stands up, Ctrl+Esc toggles, Enter focuses the prompt).
      press(sc, 'Escape');
      press(sc, 'Escape', { ctrlKey: true });
      press(sc, 'Enter');
      expect(seen).toEqual(['Escape', 'Escape', 'Enter']);
    } finally {
      window.removeEventListener('keydown', onWin);
    }
  });

  it('the prompt: focusPrompt, Enter submits, Shift+Enter does not, keys do not reach the game', () => {
    mount();
    const seen: string[] = [];
    const onWin = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener('keydown', onWin);
    try {
      view.focusPrompt();
      const ta = $('textarea') as HTMLTextAreaElement;
      expect(document.activeElement).toBe(ta);
      press(ta, 'Enter');
      expect(host.prompts).toEqual([]);
      ta.value = 'run the tests';
      press(ta, 'Enter', { shiftKey: true });
      expect(host.prompts).toEqual([]);
      press(ta, 'w');
      press(ta, 'Enter');
      expect(host.prompts).toEqual(['run the tests']);
      expect(ta.value).toBe('');
      expect(seen).toEqual([]);
      press(ta, 'Escape', { ctrlKey: true });
      expect(seen).toEqual(['Escape']);
      press(ta, 'Escape');
      expect(document.activeElement).not.toBe(ta);
      expect(seen).toEqual(['Escape']);
      // The Send button too.
      ta.value = 'again';
      ($('.tx-send') as HTMLButtonElement).click();
      expect(host.prompts).toEqual(['run the tests', 'again']);
    } finally {
      window.removeEventListener('keydown', onWin);
    }
  });
});

describe('blocked banner', () => {
  const Q: BlockedQuestion = {
    kind: 'permission',
    text: 'Allow Bash to run `rm -rf build`?',
    excerpt: ['line 1', 'line 2', '\u001b[1mDo you want to proceed?\u001b[0m', '❯ 1. Yes', '  2. No, and tell Claude what to do differently', ''],
    choices: [
      { n: 1, label: 'Yes' },
      { n: 2, label: 'No, and tell Claude what to do differently' },
    ],
    selected: 1,
    hash: 'h-123',
  };

  it('shows the question, the excerpt tail and numbered chips that answer', () => {
    mount();
    const banner = $('.tx-banner') as HTMLElement;
    expect(banner.hidden).toBe(true);
    view.setBlocked(Q);
    expect(banner.hidden).toBe(false);
    expect($('.tx-banner-text')?.textContent).toBe('Allow Bash to run `rm -rf build`?');
    expect($('.tx-banner-excerpt')?.textContent).toBe('line 2\nDo you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently');
    const chips = $$<HTMLButtonElement>('.tx-choice');
    expect(chips.map((c) => c.textContent)).toEqual(['1Yes', '2No, and tell Claude what to do differently']);
    expect(chips[0]?.classList.contains('tx-choice-sel')).toBe(true);
    chips[1]?.click();
    expect(host.answers).toEqual([['h-123', 2, undefined]]);
    // A digit key in the view answers too.
    const sc = $('.tx-scroll') as HTMLElement;
    sc.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true }));
    sc.dispatchEvent(new KeyboardEvent('keydown', { key: '7', bubbles: true, cancelable: true }));
    expect(host.answers).toEqual([
      ['h-123', 2, undefined],
      ['h-123', 1, undefined],
    ]);
    [...banner.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')?.click();
    expect(host.answers.at(-1)).toEqual(['h-123', null, true]);
    [...banner.querySelectorAll('button')].find((b) => b.textContent === 'Switch to terminal')?.click();
    expect(host.terminal).toBe(1);
    view.setBlocked(null);
    expect(banner.hidden).toBe(true);
    expect(banner.childElementCount).toBe(0);
  });

  it('an empty question reads "Waiting for input" and still offers the terminal', () => {
    mount();
    view.setBlocked({ kind: 'unknown', text: '', excerpt: [], choices: [], hash: 'x' });
    expect($('.tx-banner-text')?.textContent).toBe('Waiting for input');
    expect($('.tx-banner-excerpt')).toBeNull();
    expect($$('.tx-choice').length).toBe(0);
    expect($('.tx-to-term')).not.toBeNull();
  });
});

describe('subagents', () => {
  it('collapsed by default; expanding loads and renders the nested timeline through the same renderer', async () => {
    let resolve: (items: TranscriptItem[]) => void = () => undefined;
    mount(fakeHost(() => new Promise((r) => (resolve = r))));
    view.setItems([item('subagent', { subagent: { agent_id: 'ag-1', description: 'Explore the repo', status: 'running' } })]);
    expect(host.loads).toEqual([]);
    const head = $('.tx-sub-row') as HTMLButtonElement;
    expect(head.textContent).toContain('Explore the repo');
    head.click();
    expect(host.loads).toEqual(['ag-1']);
    expect($('.tx-sub-body')?.textContent).toContain('Loading');
    resolve([
      { id: 'n1', seq: 1, ts: T0, kind: 'assistant', parts: [text('nested **reply**')] },
      { id: 'n2', seq: 2, ts: T0, kind: 'tool', tool: { name: 'Grep', input_summary: 'TODO', status: 'ok', output_text: 'a.ts:1' } },
    ]);
    await flush();
    await flush();
    const nested = $('.tx-nested') as HTMLElement;
    expect(nested).not.toBeNull();
    expect(nested.querySelector('strong')?.textContent).toBe('reply');
    (nested.querySelector('.tx-tool-row') as HTMLButtonElement).click();
    expect(nested.querySelector('.tx-out')?.textContent).toBe('a.ts:1');
    // Collapse and open again: no second load.
    head.click();
    head.click();
    expect(host.loads).toEqual(['ag-1']);
    // Its status changes: what was loaded is stale, it loads again.
    view.applyUpdates([{ id: 'i1', seq: 1, ts: T0, kind: 'subagent', subagent: { agent_id: 'ag-1', description: 'Explore the repo', status: 'completed' } }]);
    expect(host.loads).toEqual(['ag-1', 'ag-1']);
  });

  it('a failed load says so and can be retried', async () => {
    let fail = true;
    mount(fakeHost(async () => {
      if (fail) throw new Error('not_found');
      return [{ id: 'n1', seq: 1, ts: T0, kind: 'user', parts: [text('ok now')] }];
    }));
    view.setItems([item('subagent', { subagent: { agent_id: 'ag-2', description: 'd', status: 'completed' } })]);
    ($('.tx-sub-row') as HTMLButtonElement).click();
    await flush();
    await flush();
    expect($('.tx-sub-body')?.textContent).toContain('not_found');
    fail = false;
    [...container.querySelectorAll('button')].find((b) => b.textContent === 'Try again')?.click();
    await flush();
    await flush();
    expect($('.tx-nested')?.textContent).toContain('ok now');
  });
});

describe('lifecycle', () => {
  it('destroy removes the view and later calls do nothing', () => {
    mount();
    view.setItems([item('user', { parts: [text('x')] })]);
    expect(container.querySelector('.tx')).not.toBeNull();
    view.destroy();
    expect(container.childElementCount).toBe(0);
    expect(() => {
      view.setItems([item('user', { parts: [text('y')] })]);
      view.applyUpdates([item('user', { parts: [text('z')] })]);
      view.setBlocked(null);
      view.focusPrompt();
      view.destroy();
    }).not.toThrow();
    expect(container.childElementCount).toBe(0);
  });

  it('a running tool ticks its elapsed time until destroyed', () => {
    vi.useFakeTimers({ now: T0 + 10_000 });
    try {
      mount();
      view.setItems([{ id: 't', seq: 1, ts: T0, kind: 'tool', tool: { name: 'Bash', input_summary: 'x', status: 'running' } }]);
      const dur = () => row('t').querySelector('.tx-tool-dur')?.textContent;
      expect(dur()).toBe('10s');
      vi.advanceTimersByTime(5000);
      expect(dur()).toBe('15s');
      view.destroy();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('helpers', () => {
  it('stripAnsi removes escapes, applies carriage returns and backspaces', () => {
    expect(stripAnsi('\u001b[1;32mok\u001b[0m')).toBe('ok');
    expect(stripAnsi('\u001b]0;title\u0007prompt $ ')).toBe('prompt $ ');
    expect(stripAnsi('\u001b]8;;https://x\u001b\\link\u001b]8;;\u001b\\')).toBe('link');
    expect(stripAnsi('10%\r50%\r100%\ndone')).toBe('100%\ndone');
    expect(stripAnsi('abcdef\rXY')).toBe('XYcdef');
    expect(stripAnsi('ab\bc')).toBe('ac');
    expect(stripAnsi('a\u001b(Bb\u001b=c\u0000\u0007')).toBe('abc');
    expect(stripAnsi('tab\there')).toBe('tab\there');
  });

  it('parseHunk reads structuredPatch objects and unified strings', () => {
    expect(parseHunk({ oldStart: 3, oldLines: 2, newStart: 3, newLines: 3, lines: [' a', '+b', ' c'] })).toEqual({ header: '@@ -3,2 +3,3 @@', oldStart: 3, newStart: 3, lines: [' a', '+b', ' c'] });
    expect(parseHunk('--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@ fn\n-a\n+b\n c\n')).toEqual({ header: '@@ -1,2 +1,2 @@ fn', oldStart: 1, newStart: 1, lines: ['-a', '+b', ' c'] });
    expect(parseHunk({ lines: ['+only'] })).toEqual({ header: null, oldStart: null, newStart: null, lines: ['+only'] });
    expect(parseHunk(7).lines).toEqual([' 7']);
  });

  it('duration', () => {
    expect(duration(400)).toBe('0.4s');
    expect(duration(12_300)).toBe('12s');
    expect(duration(185_000)).toBe('3m 05s');
    expect(duration(3_720_000)).toBe('1h 02m');
    expect(duration(-1)).toBe('');
  });
});
