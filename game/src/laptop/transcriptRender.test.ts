// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptItem, Usage } from '../net/protocol';
import { Draft as PromptDraft } from '../ui/composer/draft';
import { WORKER_PROMPT_MAX_BYTES } from '../ui/composer/model';
import { ViewPrefs } from '../ui/themePrefs';
import { SendGate } from './transcriptDrafts';
import { duration, loadHighlighter, mountTranscript, parseHunk, renderMarkdown, stripAnsi, type BlockedQuestion, type TranscriptRenderHost, type TranscriptView } from './transcriptRender';

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

/** The prompt box is the composer's editor (#64): a contenteditable, its text is the document's. */
const box = () => $('.tx-input') as HTMLElement;
const boxText = () => (box().textContent ?? '').replace(/\u200B/g, '');
/** What typing does: the browser edits the text node and fires `input`. */
function write(text: string): void {
  box().replaceChildren(document.createTextNode(text));
  document.getSelection()?.setBaseAndExtent(box().firstChild as Text, text.length, box().firstChild as Text, text.length);
  box().dispatchEvent(new Event('input', { bubbles: true }));
}
/** A paste event carrying image files, as a screenshot does. */
function pasteImages(files: File[]): void {
  const e = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'clipboardData', { value: { items: files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })), files, getData: () => '' } });
  box().dispatchEvent(e);
}
const press = (target: Element, key: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};
const isOff = () => box().getAttribute('aria-disabled') === 'true';

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

  it('thinking shows inline, dimmed, with markdown; encrypted reasoning is a bare muted chip', () => {
    mount();
    view.setItems([item('thinking', { parts: [text('I should *check* the tests')] }), item('thinking', {})]);
    expect(row('i1').querySelector('button')).toBeNull();
    expect(row('i1').querySelector('[aria-expanded]')).toBeNull();
    const body = row('i1').querySelector('.tx-thinking-body') as HTMLElement;
    expect(body.hidden).toBe(false);
    expect(body.textContent?.trim()).toBe('I should check the tests');
    expect(body.querySelector('em')?.textContent).toBe('check');
    expect(row('i1').querySelector('.tx-thinking-tag')?.textContent).toBe('summary');
    expect(row('i1').querySelector('.tx-chip')).toBeNull();
    expect(row('i2').querySelector('button')).toBeNull();
    expect(row('i2').querySelector('.tx-thinking-body')).toBeNull();
    expect(row('i2').querySelector('.tx-chip.tx-chip-mute')?.textContent).toContain('reasoning');
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
    // #171: shown without opening the row (its raw input and output stay closed).
    expect(row('i1').querySelector('.tx-tool-body')?.hasAttribute('hidden')).toBe(true);
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
    expect($$('.tx-diff-path').map((e) => e.textContent)).toEqual(['a.go', 'b.go']);
    expect($('.tx-dh')).toBeNull();
    expect($$('.tx-dl .tx-dn').every((n) => n.textContent === '')).toBe(true);
    // #171: a Codex patch says nothing of the file's fate: no tag; a diff the list cut says so (the host has no loadItem: no link).
    expect($$('.tx-chg-op').map((e) => e.textContent)).toEqual(['cut']);
    expect(row('i1').textContent).toContain('Cut to fit the list: only the start is shown.');
    expect(row('i1').querySelector('.tx-chg-cutnote .tx-link')).toBeNull();
    expect(row('i1').querySelector('.tx-chg-state')).toBeNull();
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

describe('#183: your answer to a Codex async question', () => {
  const ENVELOPE = '<send_user_message_question_reply>\n[{"questionItemId":"[\\"request_user_input_async\\",\\"call_1\\",0]","question":"Which board?","answer":"GitHub"}]\n</send_user_message_question_reply>';
  const answered = (answers: Array<{ question: string; answer: string }>, extra: Partial<TranscriptItem> = {}) => item('user', { parts: [text(ENVELOPE)], answers, ...extra });
  /** What the default view shows: the row's text without the collapsed raw reply. */
  const visible = (el: HTMLElement) => {
    const c = el.cloneNode(true) as HTMLElement;
    c.querySelectorAll('details').forEach((d) => d.remove());
    return c.textContent ?? '';
  };

  it('is a labelled bubble: the question as context, the answer as the entry, no envelope syntax or ids', () => {
    mount();
    const it = answered([{ question: 'Which board should receive the Shift Plan template ticket?', answer: 'GitHub: Fomra/shift-plan' }]);
    view.setItems([it]);
    const r = row(it.id);
    expect(r.classList.contains('tx-user')).toBe(true);
    expect(r.querySelector('.tx-ans-label')?.textContent).toBe('Your answer');
    expect(r.querySelector('.tx-ans-q')?.textContent).toBe('Which board should receive the Shift Plan template ticket?');
    expect(r.querySelector('.tx-ans-a')?.textContent).toBe('GitHub: Fomra/shift-plan');
    const t = visible(r);
    for (const bad of ['send_user_message_question_reply', 'questionItemId', 'request_user_input_async', 'call_1', '[{', '"answer"']) expect(t).not.toContain(bad);
    // Neutral: it says what you answered, not what the model did with it.
    expect(t).not.toMatch(/seen|read|acknowledged|received|delivered|sent/i);
  });

  it('several answers keep their order; an empty question shows its answer alone', () => {
    mount();
    const it = answered([
      { question: 'First?', answer: 'one' },
      { question: '', answer: 'two' },
      { question: 'Third?', answer: 'three' },
    ]);
    view.setItems([it]);
    const r = row(it.id);
    expect([...r.querySelectorAll('.tx-ans-pair')].map((p) => p.textContent)).toEqual(['First?one', 'two', 'Third?three']);
  });

  it('text stays text: quotes, Unicode, line breaks and literal markup keep their meaning, nothing is injected', () => {
    mount();
    const answer = '**bold?** <img src=x onerror=alert(1)> [link](javascript:alert(1)) "quoted" – naïve 日本語 🙂\nsecond line';
    const it = answered([{ question: '<script>alert(1)</script> `code`?', answer }]);
    view.setItems([it]);
    const r = row(it.id);
    expect(r.querySelector('.tx-ans-a')?.textContent).toBe(answer);
    expect(r.querySelector('.tx-ans-q')?.textContent).toBe('<script>alert(1)</script> `code`?');
    expect(r.querySelector('img, script, a, strong, code')).toBeNull();
  });

  it('the raw reply is behind a collapsed, secondary disclosure', () => {
    mount();
    const it = answered([{ question: 'Which board?', answer: 'GitHub' }]);
    view.setItems([it]);
    const d = row(it.id).querySelector('details') as HTMLDetailsElement;
    expect(d.open).toBe(false);
    expect(d.querySelector('summary')?.textContent).toBe('Raw reply');
    expect(d.querySelector('pre')?.textContent).toBe(ENVELOPE);
  });

  it('keeps its place in the conversation, also when older history is merged in after it, and an update does not duplicate it', () => {
    mount();
    const later = { ...answered([{ question: 'Which board?', answer: 'GitHub' }]), seq: 20 };
    const after: TranscriptItem = { id: 'after', seq: 21, ts: T0, kind: 'assistant', parts: [text('thanks')] };
    view.setItems([later, after]);
    // An older page, then the same entry again (a resync or an update).
    view.applyUpdates([{ id: 'older', seq: 3, ts: T0, kind: 'user', parts: [text('start')] }, { ...later }]);
    expect($$('.tx-list > .tx-item').map((e) => e.dataset.id)).toEqual(['older', later.id, 'after']);
    expect($$('.tx-ans-label').length).toBe(1);
  });

  it('a truncated entry says so; an item whose answers are malformed (or none) is the ordinary bubble, content kept', () => {
    mount();
    const cut = answered([{ question: 'q', answer: 'a' }], { truncated: true });
    const odd = item('user', { parts: [text('quoted: ' + ENVELOPE)], answers: [{ question: 1, answer: null }] as unknown as NonNullable<TranscriptItem['answers']> });
    const none = item('user', { parts: [text('plain prompt')], answers: [] });
    view.setItems([cut, odd, none]);
    expect(row(cut.id).querySelector('.tx-note')?.textContent).toContain('Truncated');
    expect(row(odd.id).querySelector('.tx-ans')).toBeNull();
    expect(row(odd.id).textContent).toContain('send_user_message_question_reply');
    expect(row(none.id).textContent?.trim()).toBe('plain prompt');
    expect(row(none.id).querySelector('.tx-ans')).toBeNull();
  });

  it('an entry missing its question or answer, or holding null or another type, is the ordinary bubble with the content shown', () => {
    mount();
    const bad = (answers: unknown) => item('user', { parts: [text(ENVELOPE)], answers: answers as NonNullable<TranscriptItem['answers']> });
    const cases = {
      noQuestion: bad([{ answer: 'a' }]),
      noAnswer: bad([{ question: 'q' }]),
      nullQuestion: bad([{ question: null, answer: 'a' }]),
      nullAnswer: bad([{ question: 'q', answer: null }]),
      numberAnswer: bad([{ question: 'q', answer: 3 }]),
      nullEntry: bad([null]),
      oneBadOfTwo: bad([{ question: 'q', answer: 'a' }, { question: 'q' }]),
    };
    view.setItems(Object.values(cases));
    for (const [name, it] of Object.entries(cases)) {
      expect(row(it.id).querySelector('.tx-ans'), name).toBeNull();
      expect(row(it.id).textContent, name).toContain('send_user_message_question_reply');
    }
    // An empty answer string is a valid answer: it is still the entry, not a fallback.
    const empty = answered([{ question: 'q', answer: '' }]);
    view.setItems([empty]);
    expect(row(empty.id).querySelector('.tx-ans')).not.toBeNull();
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

  it('a refused prompt stays in the box; the box is read-only while it is on its way', async () => {
    let answer: (ok: boolean) => void = () => undefined;
    const h = fakeHost();
    h.onPromptSubmit = (t) => {
      h.prompts.push(t);
      return new Promise<boolean>((r) => (answer = r));
    };
    mount(h);
    write('keep me');
    press(box(), 'Enter');
    await flush();
    expect(h.prompts).toEqual(['keep me']);
    expect(box().getAttribute('contenteditable')).toBe('false');
    // A second Enter while it is on its way sends nothing more.
    press(box(), 'Enter');
    await flush();
    expect(h.prompts).toEqual(['keep me']);
    answer(false);
    await flush();
    expect(box().getAttribute('contenteditable')).toBe('true');
    expect(boxText()).toBe('keep me');
    press(box(), 'Enter');
    await flush();
    answer(true);
    await flush();
    expect(h.prompts).toEqual(['keep me', 'keep me']);
    expect(boxText()).toBe('');
  });

  it('the prompt: focusPrompt, Enter submits, Shift+Enter does not, keys do not reach the game', async () => {
    mount();
    const seen: string[] = [];
    const onWin = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener('keydown', onWin);
    try {
      view.focusPrompt();
      const ta = box();
      expect(document.activeElement).toBe(ta);
      press(ta, 'Enter');
      expect(host.prompts).toEqual([]);
      write('run the tests');
      // Shift+Enter is a new line (the composer's own), not a send.
      press(ta, 'Enter', { shiftKey: true });
      await flush();
      expect(host.prompts).toEqual([]);
      expect(boxText()).toBe('run the tests\n');
      press(ta, 'Enter');
      await flush();
      expect(host.prompts).toEqual(['run the tests\n']);
      expect(boxText()).toBe('');
      expect(seen).toEqual([]);
      // Esc is the game's even in the prompt box: Ctrl+Esc back to the terminal, a bare one stands you up.
      press(ta, 'Escape', { ctrlKey: true });
      press(ta, 'Escape');
      expect(seen).toEqual(['Escape', 'Escape']);
      // The Send button too.
      write('again');
      ($('.tx-send') as HTMLButtonElement).click();
      await flush();
      expect(host.prompts).toEqual(['run the tests\n', 'again']);
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
    const ta = box();
    const sc = $('.tx-scroll') as HTMLElement;
    view.focusPrompt();
    write('follow-up');
    view.setBlocked(Q);
    expect(isOff()).toBe(true);
    expect(document.activeElement).toBe(sc);
    sc.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true }));
    expect(host.answers).toEqual([['h-123', 1, undefined]]);
    expect(boxText()).toBe('follow-up');
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

  it('while blocked the prompt is off (the bridge refuses it), its draft kept; it comes back after', async () => {
    mount();
    const ta = box();
    const send = $('.tx-send') as HTMLButtonElement;
    write('draft');
    view.setBlocked(Q);
    expect(isOff()).toBe(true);
    expect(send.disabled).toBe(true);
    expect(ta.dataset.placeholder).toMatch(/question above/);
    send.click();
    view.focusPrompt();
    await flush();
    expect(host.prompts).toEqual([]);
    expect(document.activeElement).not.toBe(ta);
    expect(boxText()).toBe('draft');
    view.setBlocked(null);
    expect(isOff()).toBe(false);
    expect(send.disabled).toBe(false);
    send.click();
    await flush();
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

describe('the prompt box takes pasted screenshots (#64)', () => {
  const png = (name: string) => new File([new Uint8Array(8).fill(1)], name, { type: 'image/png' });
  interface Up {
    label: string;
    n: number;
    ok(path?: string): void;
    fail(message?: string): void;
  }
  const withUpload = () => {
    const ups: Up[] = [];
    const h = fakeHost();
    h.label = 'Sunny Otter';
    h.upload = (_f, hint) =>
      new Promise((resolve) => {
        ups.push({
          label: hint.label,
          n: hint.n,
          ok: (path = `/drops/h3d-${hint.n}.png`) => resolve({ ok: true, data: { path, mime: 'image/png', size: 8 } }),
          fail: (message = 'Drop Zone is down') => resolve({ ok: false, code: 'dropzone_unavailable', message }),
        });
      });
    return { h, ups };
  };
  const notice = () => $('.tx .cmp-notice') as HTMLElement;

  it('a pasted screenshot is a chip, uploaded under the surface and the worker; sending carries its [Image #n: path] marker', async () => {
    const { h, ups } = withUpload();
    mount(h);
    write('look at ');
    pasteImages([png('a.png')]);
    expect($$('.cmp-chip')).toHaveLength(1);
    expect(ups.map((u) => [u.label, u.n])).toEqual([['transcript-Sunny Otter', 1]]);
    // Enter while it is still uploading: nothing goes yet, the box waits read-only.
    press(box(), 'Enter');
    await flush();
    expect(h.prompts).toEqual([]);
    expect(box().getAttribute('contenteditable')).toBe('false');
    ups[0]!.ok('/home/u/drops/h3d-transcript-1.png');
    await flush();
    expect(h.prompts).toEqual(['look at [Image #1: /home/u/drops/h3d-transcript-1.png]']);
    expect($$('.cmp-chip')).toHaveLength(0);
    expect(boxText()).toBe('');
  });

  it('an image alone is a prompt', async () => {
    const { h, ups } = withUpload();
    mount(h);
    pasteImages([png('a.png')]);
    ups[0]!.ok('/d/a.png');
    await flush();
    press(box(), 'Enter');
    await flush();
    expect(h.prompts).toEqual(['[Image #1: /d/a.png]']);
  });

  it('an upload that failed blocks the send, says so, keeps the prompt and its chip; Retry then send goes', async () => {
    const { h, ups } = withUpload();
    mount(h);
    write('fix it ');
    pasteImages([png('a.png')]);
    ups[0]!.fail('Too many uploads at once: try again in a moment');
    await flush();
    press(box(), 'Enter');
    await flush();
    expect(h.prompts).toEqual([]);
    expect(notice().hidden).toBe(false);
    expect(notice().textContent).toMatch(/Nothing was sent: image 1 \(a\.png\) did not upload/);
    expect(box().getAttribute('contenteditable')).toBe('true');
    expect(boxText()).toContain('fix it');
    ($('.cmp-retry') as HTMLButtonElement).click();
    expect(ups).toHaveLength(2);
    ups[1]!.ok('/d/a.png');
    await flush();
    press(box(), 'Enter');
    await flush();
    expect(h.prompts).toEqual(['fix it [Image #1: /d/a.png]']);
  });

  it('a prompt refused by the bridge keeps its images for another try', async () => {
    const { h, ups } = withUpload();
    mount(h);
    pasteImages([png('a.png')]);
    ups[0]!.ok('/d/a.png');
    await flush();
    h.sendOk = false;
    press(box(), 'Enter');
    await flush();
    expect(h.prompts).toEqual(['[Image #1: /d/a.png]']);
    expect($$('.cmp-chip')).toHaveLength(1);
    h.sendOk = true;
    press(box(), 'Enter');
    await flush();
    expect(h.prompts).toEqual(['[Image #1: /d/a.png]', '[Image #1: /d/a.png]']);
    expect($$('.cmp-chip')).toHaveLength(0);
  });

  it('without an upload door the chip says it did not go up and nothing is sent', async () => {
    mount(); // fakeHost: no upload
    pasteImages([png('a.png')]);
    await flush();
    expect($('.cmp-chip')?.getAttribute('data-status')).toBe('error');
    expect($('.cmp-state')?.textContent).toMatch(/images cannot be uploaded from here/);
    press(box(), 'Enter');
    await flush();
    expect(host.prompts).toEqual([]);
  });

  it('pasted text is still text', async () => {
    mount();
    const e = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clipboardData', { value: { items: [], files: [], getData: (t: string) => (t === 'text/plain' ? 'from the clipboard' : '') } });
    box().dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    press(box(), 'Enter');
    await flush();
    expect(host.prompts).toEqual(['from the clipboard']);
  });

  it('the hint says a screenshot can be pasted', () => {
    mount();
    expect(box().dataset.placeholder).toMatch(/paste a screenshot to add it/);
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

  it('thinking narration is not a tool row: it stays while tool calls are hidden', () => {
    const prefs = new ViewPrefs(null);
    prefs.hideTools = true;
    withPrefs(prefs);
    view.setItems([item('thinking', { parts: [text('No blockers, kicking off now')] }), item('thinking', {}), tool('ok')]);
    expect(($('.tx') as HTMLElement).dataset.tools).toBe('hidden');
    expect($$('.tx-thinking').map((r) => r.dataset.id)).toEqual(['i1', 'i2']);
    expect($('.tx-thinking-body')?.textContent?.trim()).toBe('No blockers, kicking off now');
    // Only tool rows are the ones the hide rule matches.
    expect($$('.tx-toolrow').map((r) => r.dataset.id)).toEqual(['i3']);
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
    // Shown again, they count: the two that came in hidden are unread rows you now see, and the new one.
    prefs.hideTools = false;
    view.applyUpdates([tool('ok')]);
    expect(jump.textContent).toBe('5 new · jump to latest');
  });

  it('the “new” chip follows the checkbox: ticked, it drops the unread tool calls; unticked, they count again', () => {
    const prefs = new ViewPrefs(null);
    withPrefs(prefs);
    const sc = $('.tx-scroll') as HTMLElement;
    layout(sc, 3000);
    view.setItems([item('user', { parts: [text('hi')] })]);
    sc.scrollTop = 0;
    sc.dispatchEvent(new Event('scroll'));
    const jump = $('.tx-jump') as HTMLButtonElement;
    view.applyUpdates([tool('ok')]);
    expect(jump.textContent).toBe('1 new · jump to latest');
    // The only unread row is a tool call: hidden, nothing new shows.
    prefs.hideTools = true;
    expect(jump.hidden).toBe(true);
    expect(jump.textContent).toBe('');
    // A reply still counts; the tool call does not while hidden.
    view.applyUpdates([item('assistant', { parts: [text('done')] })]);
    expect(jump.textContent).toBe('1 new · jump to latest');
    prefs.hideTools = false;
    expect(jump.textContent).toBe('2 new · jump to latest');
    // Read (at the bottom): nothing is new whatever the checkbox says.
    sc.scrollTop = 3000;
    sc.dispatchEvent(new Event('scroll'));
    expect(jump.hidden).toBe(true);
    prefs.hideTools = true;
    prefs.hideTools = false;
    expect(jump.hidden).toBe(true);
  });

  it('a hidden tool call that failed before the view mounted still shows on the strip (this turn’s, not old ones)', () => {
    const prefs = new ViewPrefs(null);
    prefs.hideTools = true;
    withPrefs(prefs);
    const busy = $('.tx-busy') as HTMLButtonElement;
    const failed = (id: string, s: number, name: string): TranscriptItem => ({ id, seq: s, ts: Date.now(), kind: 'tool', tool: { name, input_summary: 'x', status: 'error' } });
    // An old turn's failure (the agent went on, you answered since) and this turn's, plus one still running.
    view.setItems([
      item('user', { parts: [text('first')] }),
      failed('old', 10, 'Edit'),
      item('assistant', { parts: [text('fixed it')] }),
      { ...item('user', { parts: [text('again')] }), seq: 20 },
      failed('now', 30, 'Read'),
      { id: 'run', seq: 31, ts: Date.now() - 5000, kind: 'tool', tool: { name: 'Bash', input_summary: 'make', status: 'running' } },
    ]);
    expect(busy.hidden).toBe(false);
    expect(busy.dataset.state).toBe('failed');
    expect(busy.textContent).toBe('Read failed');
    busy.click();
    expect(row('now').classList.contains('tx-reveal')).toBe(true);
    expect(row('old').classList.contains('tx-reveal')).toBe(false);
    expect(busy.dataset.state).toBe('running');
    // A resync replaces the timeline: what you have seen fail stays acknowledged, a new failure is flagged.
    view.setItems([
      { ...item('user', { parts: [text('again')] }), id: 'u2', seq: 20 },
      failed('now', 30, 'Read'),
      failed('run', 31, 'Bash'),
    ]);
    expect(busy.dataset.state).toBe('failed');
    expect(busy.textContent).toBe('Bash failed');
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

  it('the preset is a radio group of Ubuntu and Quiet: one checked, ← → pick, the timeline keys stay out', () => {
    const prefs = new ViewPrefs(null);
    withPrefs(prefs);
    const group = $('[role="radiogroup"]') as HTMLElement;
    expect(group.getAttribute('aria-label')).toBe('Transcript theme');
    const radios = $$<HTMLButtonElement>('[role="radio"]');
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual(['Ubuntu', 'Quiet']);
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0]);
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
    expect(prefs.theme('transcript')).toBe('ubuntu');
    expect(document.activeElement).toBe(radios[0]);
    radios[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(prefs.theme('transcript')).toBe('quiet');
    expect(sc.scrollTop).toBe(500); // ↓ on the radios is theirs, not the timeline's
    expect(reached).toBe(0); // nor the game's
    // Esc still reaches the seat (stands you up), a click picks.
    radios[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(reached).toBe(1);
    document.removeEventListener('keydown', count);
    radios[0]!.click();
    expect(prefs.theme('transcript')).toBe('ubuntu');
    expect(($('.tx') as HTMLElement).dataset.theme).toBe('ubuntu');
    expect(radios[0]!.getAttribute('aria-checked')).toBe('true');
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

describe('#58: the live cue and the prompts on their way', () => {
  const pend = (id: string, state: 'sending' | 'sent' | 'queued' | 'refused', extra: { due?: number | null; late?: boolean; reason?: string; text?: string } = {}) => ({ id, text: extra.text ?? `prompt ${id}`, state, late: extra.late ?? false, mark: 0, due: extra.due === undefined ? null : extra.due, ...(extra.reason ? { reason: extra.reason } : {}) });

  it('one flashing label at the end of the timeline, its time a sibling the ticker sets; gone from the DOM with the status', () => {
    vi.useFakeTimers({ now: T0 + 12_000 });
    try {
      mount({ ...fakeHost(), label: 'Ada' });
      view.setItems([item('user', { parts: [text('hi')] })]);
      view.setPending([pend('p1', 'sent')]);
      view.setActivity({ kind: 'thinking', since: T0 });
      const cue = $('.tx-activity') as HTMLElement;
      // After the timeline and the pending rows.
      expect(($('.tx-scroll') as HTMLElement).lastElementChild?.lastElementChild).toBe(cue);
      expect($$('.tx-activity-label')).toHaveLength(1);
      const label = $('.tx-activity-label') as HTMLElement;
      expect(label.textContent).toBe('Thinking…');
      // No element per letter: the word is one text node, beside its icon.
      expect(label.children).toHaveLength(1);
      expect(label.querySelector('svg')).not.toBeNull();
      const time = $('.tx-activity-time') as HTMLElement;
      expect(label.contains(time)).toBe(false);
      expect(time.textContent).toBe('12s');
      expect($('.tx-live')?.textContent).toBe('Ada is thinking');
      expect($('.tx-live')?.getAttribute('aria-live')).toBe('polite');
      // The 1 s ticker moves the time and nothing else: the label is the same node, the live region says nothing new.
      $('.tx-live')?.replaceChildren();
      vi.advanceTimersByTime(3000);
      expect(time.textContent).toBe('15s');
      expect($('.tx-activity-label')).toBe(label);
      expect($('.tx-live')?.textContent).toBe('');
      // The same cue again (every frame) changes nothing.
      view.setActivity({ kind: 'thinking', since: T0 });
      expect($('.tx-activity-label')).toBe(label);
      view.setActivity({ kind: 'working', since: T0 });
      expect($('.tx-activity-label')?.textContent).toBe('Working…');
      expect($('.tx-live')?.textContent).toBe('Ada is working');
      view.setActivity(null);
      expect($('.tx-activity')).toBeNull();
      expect($$('.tx-activity-label')).toHaveLength(0);
      view.destroy();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['ack-first', 'activity-first'])('prompt and activity announcements survive either delivery order (%s)', (order) => {
    mount({ ...fakeHost(), label: 'Ada' });
    view.setPending([pend('p1', 'sending')]);
    const ack = () => view.setPending([pend('p1', 'sent')]);
    const activity = () => view.setActivity({ kind: 'thinking', since: T0 });
    if (order === 'ack-first') {
      ack();
      activity();
    } else {
      activity();
      ack();
    }
    expect($('.tx-pending-state')?.textContent).toBe('Sent');
    expect($('.tx-live')?.textContent).toBe('Ada is thinking');
    expect($('.tx-pending-live')?.textContent).toBe('Sent');
    // The echo removes the optimistic row without losing either announcement.
    view.setPending([]);
    expect($('.tx-pending')).toBeNull();
    expect($('.tx-live')?.textContent).toBe('Ada is thinking');
    // A queued prompt and a refusal still announce while the agent is thinking.
    view.setPending([pend('p2', 'queued')]);
    expect($('.tx-pending-live')?.textContent).toBe('Queued · Ada takes it when it can');
    view.setPending([pend('p2', 'refused', { reason: 'not delivered' })]);
    expect($('.tx-pending-live')?.textContent).toBe('Not sent: not delivered');
    expect($('.tx-live')?.textContent).toBe('Ada is thinking');
  });

  it('a hidden tab pauses it (the view marks the root)', () => {
    mount();
    const root = $('.tx') as HTMLElement;
    expect(root.hasAttribute('data-page-hidden')).toBe(false);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(root.hasAttribute('data-page-hidden')).toBe(true);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(root.hasAttribute('data-page-hidden')).toBe(false);
  });

  it('pending rows: your bubble, dimmed, with its state; queued, late and refused say so; Dismiss asks the host', () => {
    const dismissed: string[] = [];
    mount({ ...fakeHost(), label: 'Ada', onDismissPending: (id) => dismissed.push(id) });
    expect(($('.tx-empty') as HTMLElement).hidden).toBe(false);
    view.setPending([pend('p1', 'sending', { text: 'look [Image #1: /tmp/x.png]' })]);
    // Your first prompt to an empty conversation is not "No conversation yet".
    expect(($('.tx-empty') as HTMLElement).hidden).toBe(true);
    const chip = () => $$('.tx-pending-state').map((e) => e.textContent);
    expect($$('.tx-pending')).toHaveLength(1);
    expect($('.tx-pending')?.classList.contains('tx-user')).toBe(true);
    expect($('.tx-pending .tx-bubble')?.textContent?.trim()).toBe('look [Image #1]');
    expect(chip()).toEqual(['Sending…']);
    expect($('.tx-pending-live')?.textContent).toBe('Sending…');
    view.setPending([pend('p1', 'sent'), pend('p2', 'queued')]);
    expect(chip()).toEqual(['Sent', 'Queued · Ada takes it when it can']);
    view.setPending([pend('p1', 'sent', { late: true }), pend('p2', 'queued', { late: true })]);
    expect(chip()).toEqual(['Sent · not seen in the transcript yet', 'Queued · not seen in the transcript yet']);
    view.setPending([pend('p3', 'refused', { reason: 'Ada is blocked: answer its question first.' })]);
    expect($('.tx-pending')?.getAttribute('data-state')).toBe('refused');
    expect(chip()).toEqual(['Not sent: Ada is blocked: answer its question first.']);
    expect($('.tx-pending-live')?.textContent).toBe('Not sent: Ada is blocked: answer its question first.');
    ($('.tx-pending .tx-link') as HTMLButtonElement).click();
    expect(dismissed).toEqual(['p3']);
    view.setPending([]);
    expect($$('.tx-pending')).toHaveLength(0);
    expect(($('.tx-empty') as HTMLElement).hidden).toBe(false);
  });

  it('a queued prompt the agent is still busy with has a Send now link; once its turn is over or it was clicked, not', () => {
    const sent: string[] = [];
    mount({ ...fakeHost(), label: 'Ada', onSendNow: (id) => sent.push(id) });
    view.setPending([pend('p1', 'sent'), pend('p2', 'refused', { reason: 'x' })]);
    expect($$('.tx-send-now')).toHaveLength(0);
    view.setPending([pend('p1', 'queued', { due: null })]);
    const btn = $('.tx-send-now') as HTMLButtonElement;
    expect(btn.textContent).toBe('Send now (interrupts)');
    btn.click();
    expect(sent).toEqual(['p1']);
    expect(btn.disabled).toBe(true);
    // Its turn is over (a due time): the link goes.
    view.setPending([pend('p1', 'queued', { due: 5 })]);
    expect($$('.tx-send-now')).toHaveLength(0);
  });

  it('your own send goes to the bottom and follows again, even scrolled up', async () => {
    mount();
    const sc = $('.tx-scroll') as HTMLElement;
    let height = 2000;
    layout(sc, () => height);
    view.setItems([item('user', { parts: [text('hi')] })]);
    sc.scrollTop = 100;
    sc.dispatchEvent(new Event('scroll'));
    write('go on');
    press(box(), 'Enter');
    expect(sc.scrollTop).toBe(1600);
    // Its row (and later ones) keep it there.
    height = 2300;
    view.setPending([pend('p1', 'sending', { text: 'go on' })]);
    expect(sc.scrollTop).toBe(1900);
    await flush();
    expect(host.prompts).toEqual(['go on']);
  });

  it('a running subagent’s header ticks its elapsed time like a running tool', () => {
    vi.useFakeTimers({ now: T0 + 65_000 });
    try {
      mount();
      view.setItems([{ id: 's', seq: 1, ts: T0, kind: 'subagent', tool: { name: 'Agent', input_summary: 'x', status: 'running' }, subagent: { agent_id: '', description: 'Look around', status: 'running' } }]);
      const dur = () => row('s').querySelector('.tx-sub-row .tx-tool-dur')?.textContent;
      expect(dur()).toBe('1m 05s');
      vi.advanceTimersByTime(2000);
      expect(dur()).toBe('1m 07s');
      view.applyUpdates([{ id: 's', seq: 1, ts: T0, kind: 'subagent', tool: { name: 'Agent', input_summary: 'x', status: 'ok' }, subagent: { agent_id: 'a1', description: 'Look around', status: 'completed' } }]);
      expect(dur()).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('context meter (#101)', () => {
  const usage = (over: Record<string, unknown> = {}): Usage =>
    ({ tokens: 99_000, cost_usd_est: 1, priced: 'known', model: 'claude-opus-5-5', context_pct: 47.7, context_window: 1_000_000, context_tokens: 476_871, ...over }) as Usage;
  const meter = () => $('.tx-bar .tx-ctx') as HTMLElement;
  const shownText = () => (meter().textContent ?? '').replace(/\s+/g, ' ').trim();

  it('is a labelled meter in the top strip, before the preset and zoom: the share, the count and the window, and the fill', () => {
    mount();
    view.setUsage(usage());
    const m = meter();
    expect(m.hidden).toBe(false);
    expect(m.getAttribute('role')).toBe('meter');
    expect(m.getAttribute('aria-label')).toBe('Context in use');
    expect(m.getAttribute('aria-valuemin')).toBe('0');
    expect(m.getAttribute('aria-valuemax')).toBe('100');
    expect(m.getAttribute('aria-valuenow')).toBe('47.7');
    expect(m.getAttribute('aria-valuetext')).toBe('48 percent, 476,871 of 1,000,000 tokens');
    expect(m.title).toBe('Context in use: 476,871 of 1,000,000 tokens (47.7%). Estimate of what the next turn starts with, main thread only.');
    expect(shownText()).toBe('48% · 477k / 1M');
    expect(m.dataset.level).toBe('ok');
    const fill = m.querySelector<HTMLElement>('.tx-ctx-fill')!;
    expect(fill.style.width).toBe('47.7%');
    // The track is decoration, and the meter is not a tab stop (nothing to operate).
    expect(m.querySelector('.tx-ctx-track')?.getAttribute('aria-hidden')).toBe('true');
    expect(m.hasAttribute('tabindex')).toBe(false);
    // Between the strip's own controls and its right-hand group.
    expect(m.nextElementSibling).toBe($('.tx-look'));
    expect(m.parentElement).toBe($('.tx-bar'));
    // It has no live region of its own.
    expect(m.closest('[aria-live]')).toBeNull();
    expect(m.querySelector('[aria-live]')).toBeNull();
  });

  it('shows an assumed window with ~ and the tooltip says so; Codex gets its baseline note', () => {
    mount();
    view.setUsage(usage({ context_window_estimated: true }));
    expect(shownText()).toBe('48% · 477k / ~1M');
    expect(meter().title).toContain('Window size assumed.');
    expect(meter().getAttribute('aria-valuetext')).toContain('window size assumed');
    view.setUsage(usage({ model: 'gpt-6.1-sol', context_pct: 15.4, context_window: 258_400, context_tokens: 50_000 }));
    expect(shownText()).toBe('15% · 50k / 258k');
    expect(meter().title).toContain("The percentage leaves out Codex's 12,000-token baseline.");
    expect(meter().title).not.toContain('assumed');
  });

  it('steps warm at 70 and hot at 90, and the number stays', () => {
    mount();
    for (const [pct, level, label] of [
      [69.9, 'ok', '70%'],
      [70, 'warm', '70%'],
      [89.9, 'warm', '90%'],
      [90, 'hot', '90%'],
      [100, 'hot', '100%'],
    ] as const) {
      view.setUsage(usage({ context_pct: pct }));
      expect(meter().dataset.level).toBe(level);
      expect(meter().querySelector('.tx-ctx-pct')?.textContent).toBe(label);
    }
  });

  it('is hidden until there is a share and a window: no usage, a compact, an unknown model, junk — never a NaN or a 0%', () => {
    mount();
    expect(meter().hidden).toBe(true);
    for (const bad of [null, usage({ context_pct: null, context_tokens: 0 }), usage({ context_window: 0, context_pct: null }), usage({ context_pct: Number.NaN }), usage({ context_window: Number.POSITIVE_INFINITY })]) {
      view.setUsage(usage());
      expect(meter().hidden).toBe(false);
      view.setUsage(bad);
      expect(meter().hidden).toBe(true);
      expect(shownText()).not.toMatch(/NaN|Infinity/);
    }
    // A real zero is a real 0%.
    view.setUsage(usage({ context_pct: 0, context_tokens: 5000 }));
    expect(meter().hidden).toBe(false);
    expect(shownText()).toBe('0% · 5k / 1M');
    expect(meter().getAttribute('aria-valuenow')).toBe('0');
  });

  it('updates in place as the usage changes, drops after a compact and comes back; an unchanged usage touches nothing', () => {
    mount();
    view.setUsage(usage());
    const m = meter();
    const mutations: MutationRecord[] = [];
    const watch = new MutationObserver((r) => mutations.push(...r));
    watch.observe(m, { subtree: true, childList: true, attributes: true, characterData: true });
    view.setUsage(usage()); // the same values, another object: a seated frame
    view.setUsage({ ...usage() });
    expect(watch.takeRecords()).toEqual([]);
    view.setUsage(usage({ context_pct: 72.4, context_tokens: 724_000 }));
    expect(meter()).toBe(m);
    expect(shownText()).toBe('72% · 724k / 1M');
    expect(m.dataset.level).toBe('warm');
    expect(m.getAttribute('aria-valuenow')).toBe('72.4');
    expect(m.querySelector<HTMLElement>('.tx-ctx-fill')?.style.width).toBe('72.4%');
    // The count alone changing is shown too, at the same rounded share.
    view.setUsage(usage({ context_pct: 72.4, context_tokens: 724_900 }));
    expect(shownText()).toBe('72% · 725k / 1M');
    expect(m.title).toContain('724,900');
    // A /compact: no meter until the next measure.
    view.setUsage(usage({ context_pct: null, context_tokens: 0 }));
    expect(m.hidden).toBe(true);
    view.setUsage(usage({ context_pct: 6.1, context_tokens: 61_000 }));
    expect(m.hidden).toBe(false);
    expect(shownText()).toBe('6% · 61k / 1M');
    expect(m.dataset.level).toBe('ok');
    watch.disconnect();
  });

  it('opens with the usage the host has, and an older bridge (no count) shows the share of the window only', () => {
    const h = fakeHost();
    h.usage = usage({ context_tokens: undefined, context_window_estimated: true });
    mount(h);
    expect(meter().hidden).toBe(false);
    expect(shownText()).toBe('48% of ~1M');
    expect(meter().title).toBe('Context in use: 47.7% of 1,000,000 tokens. Estimate of what the next turn starts with, main thread only. Window size assumed.');
    expect(shownText()).not.toContain('99k');
  });

  it('is left alone once the view is gone', () => {
    mount();
    view.destroy();
    expect(() => view.setUsage(usage())).not.toThrow();
  });
});

describe('#141: the host’s draft', () => {
  const draft = () => new PromptDraft({ upload: () => Promise.resolve({ ok: false, code: 'x', message: 'x' }), maxPromptBytes: WORKER_PROMPT_MAX_BYTES });

  it('shows the draft the host keeps and leaves it alone when the view goes; the next view shows it again', () => {
    const d = draft();
    d.insertParts(0, 0, ['see ', { kind: 'file', path: 'src/a.ts', dir: false }]);
    mount({ ...fakeHost(), draft: d });
    expect($('.tx-input .cmp-file')?.getAttribute('aria-label')).toBe('File src/a.ts');
    view.destroy();
    expect(d.disposed).toBe(false);
    mount({ ...fakeHost(), draft: d });
    expect($$('.tx-input .cmp-file')).toHaveLength(1);
    view.destroy();
  });

  it('a view of a draft whose send is on its way starts busy, sends nothing, and takes prompts once the send is done', async () => {
    const d = draft();
    d.replace(0, 0, 'go');
    let ack: (ok: boolean) => void = () => {};
    const sending = new SendGate();
    const h = { ...fakeHost(), draft: d, sending, onPromptSubmit: (t: string) => (h.prompts.push(t), new Promise<boolean>((r) => (ack = r))) };
    mount(h);
    view.focusPrompt();
    $('.tx-send')?.click();
    await flush();
    expect(h.prompts).toEqual(['go']);
    expect(sending.busy).toBe(true);
    view.destroy();
    // The next view of the same draft: busy from the start, its Send and Enter do nothing.
    mount(h);
    expect(box().getAttribute('contenteditable')).toBe('false');
    expect(box().getAttribute('aria-busy')).toBe('true');
    $('.tx-send')?.click();
    press(box(), 'Enter');
    await flush();
    expect(h.prompts).toEqual(['go']);
    ack(true);
    await flush();
    expect(sending.busy).toBe(false);
    expect(d.doc.text).toBe('');
    expect(box().getAttribute('contenteditable')).toBe('true');
    write('next');
    $('.tx-send')?.click();
    await flush();
    expect(h.prompts).toEqual(['go', 'next']);
    view.destroy();
  });

  it('the gate opens when the view goes before its images resolved (nothing was sent)', async () => {
    const d = draft();
    d.replace(0, 0, 'go');
    const sending = new SendGate();
    let resolve: () => void = () => {};
    const gated = new Promise<void>((r) => (resolve = r));
    const real = d.resolve.bind(d);
    d.resolve = async (o) => {
      await gated;
      return real(o);
    };
    const h = { ...fakeHost(), draft: d, sending };
    mount(h);
    $('.tx-send')?.click();
    expect(sending.busy).toBe(true);
    view.destroy();
    resolve();
    await flush();
    expect(sending.busy).toBe(false);
    expect(h.prompts).toEqual([]);
    expect(d.doc.text).toBe('go');
  });

  it('a prompt whose ack comes after the view went still clears the host’s draft', async () => {
    const d = draft();
    d.replace(0, 0, 'go');
    let ack: (ok: boolean) => void = () => {};
    const h = { ...fakeHost(), draft: d, onPromptSubmit: () => new Promise<boolean>((r) => (ack = r)) };
    mount(h);
    view.focusPrompt();
    $('.tx-send')?.click();
    await flush();
    view.destroy();
    ack(true);
    await flush();
    expect(d.doc.text).toBe('');
  });
});

describe('#31 file references: the friendly label, the full path to copy', () => {
  const REPRO = '/tmp/herdr-remote-runtime-handoff-2026-10-09.md';
  const md = (s: string) => {
    const root = document.createElement('div');
    root.append(renderMarkdown(s)!);
    return root;
  };
  /** The file paths the anchors of `s` keep, in order (null: an anchor that is not a file reference). */
  const paths = (s: string) => [...md(s).querySelectorAll('a')].map((a) => a.getAttribute('data-tx-file'));

  it('retains a file reference destination for copying', () => {
    const root = md(`[handoff document](${REPRO})`);
    expect(root.querySelector('a')?.textContent).toBe('handoff document');
    expect(root.innerHTML).toContain(REPRO);
    // Inert: no href to follow, nothing that resolves against the page.
    expect(root.querySelector('a')?.hasAttribute('href')).toBe(false);
    expect(root.querySelector('a')?.getAttribute('data-tx-file')).toBe(REPRO);
  });

  it('keeps spaces, Unicode and markdown escapes faithfully', () => {
    expect(paths('[a](</tmp/a b.md>)')).toEqual(['/tmp/a b.md']);
    expect(paths('[a](/tmp/日本語/é.md)')).toEqual(['/tmp/日本語/é.md']);
    expect(paths('[a](/tmp/my\\_file\\(1\\).md)')).toEqual(['/tmp/my_file(1).md']);
    expect(paths('[a](<./a (1) & b.md>)')).toEqual(['./a (1) & b.md']);
    expect(paths('[a](/tmp/x"y.md)')).toEqual(['/tmp/x"y.md']);
    expect(paths('[a](/tmp/100%.md)')).toEqual(['/tmp/100%.md']);
    expect(paths('[a](/tmp/a%20b.md "A title")')).toEqual(['/tmp/a b.md']);
  });

  it('file: URLs decode to their path; relative references stay as written', () => {
    expect(paths('[a](file:///tmp/a%20b.md) <file:///tmp/c.md>')).toEqual(['/tmp/a b.md', '/tmp/c.md']);
    expect(paths('[a](./docs/handoff.md) [b](docs/x.md) [c](../up.md) [d](src/app.ts#L42) [e](~/notes.md)')).toEqual(['./docs/handoff.md', 'docs/x.md', '../up.md', 'src/app.ts', '~/notes.md']);
    // A markdown image of a local file is a reference too (it is never an <img>).
    expect(paths('![shot](/tmp/shot.png)')).toEqual(['/tmp/shot.png']);
  });

  it('a Windows drive path survives markdown encoding its backslashes', () => {
    expect(paths('[a](C:\\Users\\me\\a.md) [b](C:/Users/me/b.md) [c](<D:\\My Docs\\c.md>)')).toEqual(['C:\\Users\\me\\a.md', 'C:/Users/me/b.md', 'D:\\My Docs\\c.md']);
    // A one-letter scheme without a slash is no drive path.
    expect(paths('[x](x:alert(1))')).toEqual([null]);
  });

  it('unsafe destinations stay inert and are no file reference; http(s) and mailto links are unchanged', () => {
    const root = md('[js](javascript:alert(1)) [data](data:text/html,x) [vb](vbscript:msgbox) [ent](&#106;avascript:alert(1)) [net](//evil.example/x) [host](file://evil.example/x) [anchor](#top) [web](https://example.com/a.md) [mail](mailto:me@example.com)');
    const as = [...root.querySelectorAll('a')];
    expect(as.map((a) => a.getAttribute('data-tx-file'))).toEqual([null, null, null, null, null, null, null, null, null]);
    for (const a of as.slice(0, 7)) expect(a.hasAttribute('href'), a.textContent ?? '').toBe(false);
    for (const a of as.slice(7)) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    }
    expect(as[7]?.getAttribute('href')).toBe('https://example.com/a.md');
    expect(as[8]?.getAttribute('href')).toBe('mailto:me@example.com');
    // Raw HTML cannot plant the marker: it is text.
    expect(md('<a data-tx-file="/etc/passwd">x</a>').querySelector('[data-tx-file]')).toBeNull();
  });

  interface CopyHost extends FakeHost {
    copied: string[];
    copyOk: boolean;
  }
  function copyHost(cwd: string | null = null): CopyHost {
    const h = fakeHost() as CopyHost;
    h.copied = [];
    h.copyOk = true;
    h.copy = (t) => {
      h.copied.push(t);
      return Promise.resolve(h.copyOk);
    };
    h.cwd = () => cwd;
    return h;
  }
  const ref = () => $('.tx-file-ref') as HTMLElement;
  const pop = () => $('.tx-fref') as HTMLElement;

  function showRepro(h: CopyHost): void {
    mount(h);
    view.setItems([item('assistant', { parts: [text(`Saved the [handoff document](${REPRO}) in \`/tmp\`.`)] })]);
  }

  it('the reference is a button in the tab order; Enter opens the popover with the path, Copy copies exactly that', async () => {
    const h = copyHost();
    showRepro(h);
    const a = ref();
    expect(a.textContent).toBe('handoff document');
    expect(a.getAttribute('role')).toBe('button');
    expect(a.getAttribute('tabindex')).toBe('0');
    expect(a.getAttribute('aria-haspopup')).toBe('dialog');
    expect(a.getAttribute('aria-expanded')).toBe('false');
    expect(pop().hidden).toBe(true);
    a.focus();
    const e = press(a, 'Enter');
    expect(e.defaultPrevented).toBe(true);
    expect(pop().hidden).toBe(false);
    expect(pop().getAttribute('role')).toBe('dialog');
    expect(a.getAttribute('aria-expanded')).toBe('true');
    expect(a.getAttribute('aria-controls')).toBe(pop().id);
    // Not in the scroller: nothing there clips it.
    expect($('.tx-scroll')?.contains(pop())).toBe(false);
    expect($('.tx-fref-path')?.textContent).toBe(REPRO);
    const copy = $('.tx-fref-copy') as HTMLButtonElement;
    expect(document.activeElement).toBe(copy);
    expect(copy.textContent).toBe('Copy file path');
    copy.click();
    await flush();
    expect(h.copied).toEqual([REPRO]);
    expect(copy.textContent).toBe('Copied');
    expect(pop().dataset.state).toBe('copied');
    expect($('.tx-fref-status')?.getAttribute('aria-live')).toBe('polite');
    expect($('.tx-fref-status')?.textContent).toBe('File path copied to the clipboard.');
  });

  it('Esc closes it and gives the keyboard back to the reference, without reaching the seat; Space opens it too', () => {
    showRepro(copyHost());
    const seat = vi.fn();
    document.addEventListener('keydown', seat);
    try {
      const a = ref();
      a.focus();
      press(a, ' ');
      expect(pop().hidden).toBe(false);
      const esc = press(document.activeElement as HTMLElement, 'Escape');
      expect(esc.defaultPrevented).toBe(true);
      expect(pop().hidden).toBe(true);
      expect(document.activeElement).toBe(a);
      expect(a.getAttribute('aria-expanded')).toBe('false');
      // Neither key got past the transcript (Esc would stand you up).
      expect(seat).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', seat);
    }
  });

  it('keys in the popover are its own: Tab goes between the path and Copy, j does not scroll', () => {
    showRepro(copyHost());
    ref().click();
    const copy = $('.tx-fref-copy') as HTMLElement;
    const path = $('.tx-fref-path') as HTMLElement;
    expect(document.activeElement).toBe(copy);
    press(copy, 'Tab');
    expect(document.activeElement).toBe(path);
    // The path, focused, is selected whole (the copy key copies it).
    expect(document.getSelection()?.toString()).toBe(REPRO);
    press(path, 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(copy);
    const j = press(copy, 'j');
    expect(j.defaultPrevented).toBe(false);
    expect(pop().hidden).toBe(false);
  });

  it('a click opens it, a click outside closes it, a click on the reference again closes it', () => {
    showRepro(copyHost());
    const a = ref();
    a.click();
    expect(pop().hidden).toBe(false);
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(pop().hidden).toBe(true);
    a.click();
    expect(pop().hidden).toBe(false);
    pop().dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(pop().hidden).toBe(false);
    a.click();
    expect(pop().hidden).toBe(true);
  });

  it('a refused clipboard says so and selects the path for the copy key', async () => {
    const h = copyHost();
    h.copyOk = false;
    showRepro(h);
    ref().click();
    ($('.tx-fref-copy') as HTMLButtonElement).click();
    await flush();
    expect(pop().dataset.state).toBe('failed');
    expect($('.tx-fref-copy')?.textContent).toBe('Copy file path');
    expect($('.tx-fref-status')?.textContent).toMatch(/^Couldn’t copy: .*The path is selected: press (Ctrl\+C|⌘C) to copy it\.$/);
    expect(document.activeElement).toBe($('.tx-fref-path'));
    expect(document.getSelection()?.toString()).toBe(REPRO);
  });

  it('without a host copy it uses the browser clipboard, and a missing one is a refusal', async () => {
    const h = fakeHost();
    mount(h);
    view.setItems([item('assistant', { parts: [text(`[doc](${REPRO})`)] })]);
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      ref().click();
      ($('.tx-fref-copy') as HTMLButtonElement).click();
      await flush();
      expect(writeText).toHaveBeenCalledWith(REPRO);
      expect(pop().dataset.state).toBe('copied');
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      ($('.tx-fref-copy') as HTMLButtonElement).click();
      await flush();
      expect(pop().dataset.state).toBe('failed');
    } finally {
      delete (navigator as unknown as Record<string, unknown>).clipboard;
    }
  });

  it('a relative reference copies the path in the worker’s checkout; unknown, it stays relative and says so', async () => {
    const h = copyHost('/home/dev/devel/herdr-3d');
    mount(h);
    view.setItems([item('assistant', { parts: [text('See [the plan](./docs/../docs/plan%20v2.md).')] })]);
    ref().click();
    expect($('.tx-fref-path')?.textContent).toBe('/home/dev/devel/herdr-3d/docs/plan v2.md');
    expect($('.tx-fref-note')?.hidden).toBe(false);
    expect($('.tx-fref-note')?.textContent).toBe('Written as ./docs/../docs/plan v2.md, in the worker’s checkout.');
    ($('.tx-fref-copy') as HTMLButtonElement).click();
    await flush();
    expect(h.copied).toEqual(['/home/dev/devel/herdr-3d/docs/plan v2.md']);
    view.destroy();

    const u = copyHost(null);
    mount(u);
    view.setItems([item('assistant', { parts: [text('See [the plan](docs/plan.md).')] })]);
    ref().click();
    expect($('.tx-fref-path')?.textContent).toBe('docs/plan.md');
    expect($('.tx-fref-note')?.textContent).toBe('Relative to the worker’s checkout, which isn’t known here.');
    ($('.tx-fref-copy') as HTMLButtonElement).click();
    await flush();
    expect(u.copied).toEqual(['docs/plan.md']);
    // An absolute one needs no note.
    view.setItems([item('assistant', { parts: [text(`[doc](${REPRO})`)] })]);
    ref().click();
    expect($('.tx-fref-note')?.hidden).toBe(true);
  });

  it('a row drawn anew keeps the popover on the same reference; one that goes closes it', () => {
    showRepro(copyHost());
    const it0 = item('assistant', { parts: [text(`Saved the [handoff document](${REPRO}) in \`/tmp\`.`)] });
    view.setItems([it0]);
    const was = ref();
    was.click();
    expect(pop().hidden).toBe(false);
    view.applyUpdates([{ ...it0, parts: [text(`Saved the [handoff document](${REPRO}) in \`/tmp\`. Done.`)] }]);
    expect(ref()).not.toBe(was);
    expect(pop().hidden).toBe(false);
    expect(ref().getAttribute('aria-expanded')).toBe('true');
    expect(ref().getAttribute('aria-controls')).toBe(pop().id);
    view.setItems([item('assistant', { parts: [text('Nothing here.')] })]);
    expect(pop().hidden).toBe(true);
  });

  it('a popover goes with its view', () => {
    showRepro(copyHost());
    ref().click();
    view.destroy();
    expect($('.tx-fref')).toBeNull();
  });
});
