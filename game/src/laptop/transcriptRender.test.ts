// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptItem } from '../net/protocol';
import { ViewPrefs } from '../ui/themePrefs';
import { duration, loadHighlighter, mountTranscript, parseHunk, stripAnsi, type BlockedQuestion, type TranscriptRenderHost, type TranscriptView } from './transcriptRender';

interface FakeHost extends TranscriptRenderHost {
  prompts: string[];
  /** What the next prompts resolve to (false: refused). */
  sendOk: boolean;
  answers: Array<[string, number | null, boolean | undefined]>;
  terminal: number;
  loads: string[];
}

function fakeHost(load: (id: string) => Promise<TranscriptItem[]> = async () => []): FakeHost {
  const host: FakeHost = {
    images: null,
    prompts: [],
    sendOk: true,
    answers: [],
    terminal: 0,
    loads: [],
    onPromptSubmit: (t) => {
      host.prompts.push(t);
      return Promise.resolve(host.sendOk);
    },
    onAnswer: (hash, n, cancel) => host.answers.push([hash, n, cancel]),
    onAnswerAsk: async () => ({ ok: true, resolved: true }),
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
    expect(root.querySelector('script, .tx-md img, iframe, svg:not([aria-hidden="true"]), style, object, embed, form, details')).toBeNull();
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
  it('user bubble, assistant markdown, an older bridge’s image placeholder as a "not available" card', () => {
    mount();
    view.setItems([item('user', { parts: [text('look at **this**'), { image_omitted: true }] }), item('assistant', { parts: [text('# Title\n\n- one\n- two')] })]);
    const u = row('i1');
    expect(u.querySelector('.tx-bubble strong')?.textContent).toBe('this');
    const card = u.querySelector('.tx-strip .tx-imgcard') as HTMLElement;
    expect(card.textContent).toContain('Image not available');
    expect(card.title).toContain('older than image support');
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
          // The bridge's TranscriptHunk (snake_case, from Claude's structuredPatch).
          diff: { path: 'src/app.ts', hunks: [{ old_start: 10, old_lines: 3, new_start: 10, new_lines: 3, lines: [' const a = 1;', '-const b = 2;', '+const b = 3;', ' const c = 4;'] }] },
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

  it('a Codex apply_patch over two files: every file, no made-up line numbers; output images in a strip', () => {
    mount();
    const a = { path: 'a.go', hunks: [{ old_start: 0, old_lines: 1, new_start: 0, new_lines: 1, lines: ['-x := 1', '+x := 2'] }] };
    const b = { path: 'b.go', hunks: [{ old_start: 0, old_lines: 0, new_start: 0, new_lines: 1, lines: ['+y := 3'] }], truncated: true };
    view.setItems([item('tool', { tool: { name: 'apply_patch', input_summary: 'a.go, b.go', status: 'ok', diff: a, diffs: [a, b], images: [{ image_omitted: true }] } })]);
    expect(row('i1').querySelector('.tx-tool-row .tx-diff-stat')?.textContent).toBe('+2 −1');
    ($('.tx-tool-row') as HTMLButtonElement).click();
    expect($$('.tx-diff-path').map((e) => e.textContent)).toEqual(['a.go', 'b.go']);
    expect($('.tx-dh')).toBeNull();
    expect($$('.tx-dl .tx-dn').every((n) => n.textContent === '')).toBe(true);
    expect(row('i1').textContent).toContain('Diff truncated');
    expect(row('i1').querySelectorAll('.tx-strip .tx-imgcard').length).toBe(1);
  });

  it('compaction is a divider; hidden notices and unknown entries wait for "show system", other notices show', () => {
    mount();
    view.setItems([
      item('compaction', { notice: { text: 'summary' } }),
      item('notice', { hidden: true, notice: { text: 'Turn took 12s', source: 'system/turn_duration' } }),
      item('unknown', { hidden: true, raw_type: 'queue-operation' }),
      item('notice', { notice: { text: 'Interrupted by user', source: 'user/interrupt' } }),
    ]);
    expect(row('i4').classList.contains('tx-sys')).toBe(false);
    expect(row('i4').textContent).toContain('Interrupted by user');
    expect(row('i1').getAttribute('role')).toBeNull();
    expect(row('i1').querySelector('[role="separator"]')).not.toBeNull();
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
    view.applyUpdates([item('notice', { hidden: true, notice: { text: 'hidden, not counted' } })]);
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

  it('focus() puts the keyboard on the timeline: scroll keys work at once', () => {
    mount();
    const outer = document.createElement('button');
    document.body.append(outer);
    outer.focus();
    const sc = $('.tx-scroll') as HTMLElement;
    layout(sc, 2000);
    view.focus();
    expect(document.activeElement).toBe(sc);
    const e = new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true });
    (document.activeElement as HTMLElement).dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(sc.scrollTop).toBe(1600);
    outer.remove();
  });

  it('a refused prompt comes back in the box (unless something new was typed)', async () => {
    mount();
    const ta = $('textarea') as HTMLTextAreaElement;
    host.sendOk = false;
    ta.value = 'keep me';
    press(ta, 'Enter');
    expect(ta.value).toBe('');
    await flush();
    expect(ta.value).toBe('keep me');
    ta.value = 'lost?';
    press(ta, 'Enter');
    ta.value = 'newer';
    await flush();
    expect(ta.value).toBe('newer');
    host.sendOk = true;
    press(ta, 'Enter');
    await flush();
    expect(ta.value).toBe('');
    expect(host.prompts).toEqual(['keep me', 'lost?', 'newer']);
  });

  it('a refusal after the box was edited back to empty does not bring the old draft back', async () => {
    let refuse: (ok: boolean) => void = () => undefined;
    mount({ ...fakeHost(), onPromptSubmit: () => new Promise<boolean>((r) => (refuse = r)) } as FakeHost);
    const ta = $('textarea') as HTMLTextAreaElement;
    ta.value = 'old draft';
    press(ta, 'Enter');
    ta.value = 'new draft';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.value = '';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    refuse(false);
    await flush();
    expect(ta.value).toBe('');
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
      // Esc is the game's even in the prompt box: Ctrl+Esc back to the terminal, a bare one stands you up.
      press(ta, 'Escape', { ctrlKey: true });
      press(ta, 'Escape');
      expect(seen).toEqual(['Escape', 'Escape']);
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

  it('a question arriving while you type moves the keyboard to the timeline, once: its digits answer', () => {
    mount();
    const ta = $('textarea') as HTMLTextAreaElement;
    const sc = $('.tx-scroll') as HTMLElement;
    view.focusPrompt();
    ta.value = 'follow-up';
    view.setBlocked(Q);
    expect(ta.disabled).toBe(true);
    expect(document.activeElement).toBe(sc);
    sc.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true }));
    expect(host.answers).toEqual([['h-123', 1, undefined]]);
    expect(ta.value).toBe('follow-up');
    // Another render of a question does not move the keyboard (it stays where the user put it).
    const other = document.createElement('button');
    document.body.append(other);
    other.focus();
    view.setBlocked({ ...Q, hash: 'h-456' });
    expect(document.activeElement).toBe(other);
    // Nor does a question arriving while the prompt box is not focused.
    view.setBlocked(null);
    other.focus();
    view.setBlocked(Q);
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it('while blocked the prompt is off (the bridge refuses it), its draft kept; it comes back after', () => {
    mount();
    const ta = $('textarea') as HTMLTextAreaElement;
    const send = $('.tx-send') as HTMLButtonElement;
    ta.value = 'draft';
    view.setBlocked(Q);
    expect(ta.disabled).toBe(true);
    expect(send.disabled).toBe(true);
    expect(ta.placeholder).toMatch(/question above/);
    send.click();
    view.focusPrompt();
    expect(host.prompts).toEqual([]);
    expect(document.activeElement).not.toBe(ta);
    expect(ta.value).toBe('draft');
    view.setBlocked(null);
    expect(ta.disabled).toBe(false);
    expect(send.disabled).toBe(false);
    send.click();
    expect(host.prompts).toEqual(['draft']);
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

  it('a running subagent the bridge has no agent_id for yet asks for nothing', () => {
    mount();
    view.setItems([item('subagent', { subagent: { agent_id: '', description: 'Explore', status: 'running' } })]);
    ($('.tx-sub-row') as HTMLButtonElement).click();
    expect(host.loads).toEqual([]);
    expect($('.tx-sub-body')?.textContent).toContain('once it reports back');
    // Its result names it: now it loads.
    view.applyUpdates([{ id: 'i1', seq: 1, ts: T0, kind: 'subagent', subagent: { agent_id: 'ag-9', description: 'Explore', status: 'completed' } }]);
    expect(host.loads).toEqual(['ag-9']);
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
    expect(parseHunk({ old_start: 0, old_lines: 0, new_start: 1, new_lines: 1, lines: ['+new'] })).toEqual({ header: '@@ -0,0 +1,1 @@', oldStart: 0, newStart: 1, lines: ['+new'] });
    expect(parseHunk({ old_start: 0, old_lines: 1, new_start: 0, new_lines: 1, lines: ['-a', '+b'] })).toEqual({ header: null, oldStart: null, newStart: null, lines: ['-a', '+b'] });
    expect(parseHunk({ old_start: 1, old_lines: 0, new_start: 1, new_lines: 0, lines: null }).lines).toEqual([]);
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

describe('#59: hide tool calls, the preset, the zoom', () => {
  const memory = (): Storage => {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 };
  };
  const withPrefs = (prefs: ViewPrefs) => mount({ ...fakeHost(), prefs });
  beforeEach(() => {
    Element.prototype.scrollIntoView ??= function () {};
  });
  type Status = NonNullable<TranscriptItem['tool']>['status'];
  const tool = (status: Status, name = 'Bash') => item('tool', { tool: { name, input_summary: 'ls', status } });
  const askTool = () => item('tool', { tool: { name: 'AskUserQuestion', status: 'ok', ask: { questions: [{ question: 'Which?', header: 'Pick', options: [{ label: 'A' }, { label: 'B' }], multi_select: false }] } } as never });

  it('hides tool rows (not subagents, not an agent’s question), and the choice outlives the view and the page', () => {
    const st = memory();
    const prefs = new ViewPrefs(st);
    withPrefs(prefs);
    view.setItems([item('user', { parts: [text('go')] }), tool('ok'), item('subagent', { subagent: { agent_id: 'a1', description: 'look', status: 'completed' } }), askTool(), item('assistant', { parts: [text('done')] })]);
    const box = $('.tx-check-box') as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(($('.tx') as HTMLElement).dataset.tools).toBe('shown');
    // The rows it would hide, and only those.
    expect($$('.tx-toolrow').map((r) => r.dataset.id)).toEqual(['i2']);
    expect($('.tx-check-n')?.textContent).toBe('1');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(prefs.hideTools).toBe(true);
    expect(($('.tx') as HTMLElement).dataset.tools).toBe('hidden');
    // Another view (the next seat), and the next page load, start with it ticked.
    view.destroy();
    withPrefs(new ViewPrefs(st));
    expect(($('.tx-check-box') as HTMLInputElement).checked).toBe(true);
    expect(($('.tx') as HTMLElement).dataset.tools).toBe('hidden');
  });

  it('the “new” chip does not count tool calls while they are hidden', () => {
    const prefs = new ViewPrefs(null);
    prefs.hideTools = true;
    withPrefs(prefs);
    const sc = $('.tx-scroll') as HTMLElement;
    layout(sc, 3000);
    view.setItems([item('user', { parts: [text('hi')] })]);
    sc.scrollTop = 0;
    sc.dispatchEvent(new Event('scroll'));
    view.applyUpdates([tool('running'), tool('ok', 'Read'), item('assistant', { parts: [text('one')] }), item('subagent', { subagent: { agent_id: 'b', description: 'x', status: 'running' } })]);
    const jump = $('.tx-jump') as HTMLButtonElement;
    expect(jump.textContent).toBe('2 new · jump to latest');
    // Shown again, they count.
    prefs.hideTools = false;
    view.applyUpdates([tool('ok')]);
    expect(jump.textContent).toBe('3 new · jump to latest');
  });

  it('while hidden, the strip shows a running tool call, and a failed one until you look', () => {
    const prefs = new ViewPrefs(null);
    withPrefs(prefs);
    const busy = $('.tx-busy') as HTMLButtonElement;
    view.setItems([item('user', { parts: [text('hi')] }), { id: 't1', seq: 50, ts: Date.now() - 12_000, kind: 'tool', tool: { name: 'Bash', input_summary: 'make', status: 'running' } }]);
    expect(busy.hidden).toBe(true); // tool calls shown: their own rows say it
    prefs.hideTools = true;
    expect(busy.hidden).toBe(false);
    expect(busy.dataset.state).toBe('running');
    expect(busy.textContent).toMatch(/^Bash · 1[12]s$/);
    // It fails: red, named, until clicked.
    view.applyUpdates([{ id: 't1', seq: 50, ts: Date.now() - 12_000, kind: 'tool', tool: { name: 'Bash', input_summary: 'make', status: 'error', output_text: 'boom' } }]);
    expect(busy.dataset.state).toBe('failed');
    expect(busy.textContent).toBe('Bash failed');
    busy.click();
    expect(busy.hidden).toBe(true);
    // Its row shows (the rest stay hidden) until tool calls are shown or hidden again.
    expect(row('t1').classList.contains('tx-reveal')).toBe(true);
    view.applyUpdates([{ id: 't2', seq: 51, ts: Date.now(), kind: 'tool', tool: { name: 'Edit', input_summary: 'a.ts', status: 'error' } }, { id: 't3', seq: 52, ts: Date.now(), kind: 'tool', tool: { name: 'Read', input_summary: 'b.ts', status: 'error' } }]);
    expect(busy.textContent).toBe('2 tool calls failed');
    expect(row('t1').classList.contains('tx-reveal')).toBe(true);
    expect(row('t2').classList.contains('tx-reveal')).toBe(false);
    prefs.hideTools = false;
    expect(busy.hidden).toBe(true);
    expect($$('.tx-reveal')).toHaveLength(0);
  });

  it('the preset is a radio group: one checked, ← → pick, the timeline keys stay out', () => {
    const prefs = new ViewPrefs(null);
    withPrefs(prefs);
    const group = $('[role="radiogroup"]') as HTMLElement;
    expect(group.getAttribute('aria-label')).toBe('Transcript theme');
    const radios = $$<HTMLButtonElement>('[role="radio"]');
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual(['Terminal', 'Quiet', 'Paper']);
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    expect(($('.tx') as HTMLElement).dataset.theme).toBe('quiet');
    const sc = $('.tx-scroll') as HTMLElement;
    layout(sc, 3000);
    sc.scrollTop = 500;
    sc.dispatchEvent(new Event('scroll'));
    let reached = 0;
    const count = () => reached++;
    document.addEventListener('keydown', count);
    radios[1]!.focus();
    radios[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    expect(prefs.theme('transcript')).toBe('paper');
    expect(document.activeElement).toBe(radios[2]);
    radios[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    expect(prefs.theme('transcript')).toBe('terminal');
    radios[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(prefs.theme('transcript')).toBe('quiet');
    expect(sc.scrollTop).toBe(500); // ↓ on the radios is theirs, not the timeline's
    expect(reached).toBe(0); // nor the game's
    // Esc still reaches the seat (stands you up), a click picks.
    radios[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(reached).toBe(1);
    document.removeEventListener('keydown', count);
    radios[2]!.click();
    expect(prefs.theme('transcript')).toBe('paper');
    expect(($('.tx') as HTMLElement).dataset.theme).toBe('paper');
    expect(radios[2]!.getAttribute('aria-checked')).toBe('true');
    // The transcript's own: the terminal keeps its preset.
    expect(prefs.theme('terminal')).toBe('quiet');
  });

  it('A− / 100% / A+ step the zoom by 10 within 70–200 and show it; the middle one resets', () => {
    const prefs = new ViewPrefs(null);
    withPrefs(prefs);
    const [out, level, inc] = $$<HTMLButtonElement>('.tx-zoom-btn');
    expect(level!.textContent).toBe('100%');
    inc!.click();
    inc!.click();
    expect(prefs.zoom('transcript')).toBe(120);
    expect(level!.textContent).toBe('120%');
    expect(level!.getAttribute('aria-label')).toBe('Text size 120%, back to 100%');
    level!.click();
    expect(prefs.zoom('transcript')).toBe(100);
    for (let i = 0; i < 10; i++) out!.click();
    expect(prefs.zoom('transcript')).toBe(70);
    expect(out!.disabled).toBe(true);
    for (let i = 0; i < 20; i++) inc!.click();
    expect(prefs.zoom('transcript')).toBe(200);
    expect(inc!.disabled).toBe(true);
    expect(level!.textContent).toBe('200%');
    // The transcript's own: the terminal's zoom stays.
    expect(prefs.zoom('terminal')).toBe(100);
  });

  it('the zoom keys pass through the prompt box to the seat', () => {
    mount();
    const input = $('.tx-input') as HTMLTextAreaElement;
    let reached = 0;
    const count = () => reached++;
    document.addEventListener('keydown', count);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: '=', ctrlKey: true, bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }));
    document.removeEventListener('keydown', count);
    expect(reached).toBe(1);
  });
});
