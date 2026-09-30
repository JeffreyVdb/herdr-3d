import './transcript.css';
import DOMPurify, { type Config, type DOMPurify as Purifier } from 'dompurify';
import { Marked } from 'marked';
import type { TranscriptDiff, TranscriptItem } from '../net/protocol';
import { h, icon } from '../ui/dom';

/**
 * M16: a worker's conversation as DOM, drawn over the laptop screen while you sit there (the seated view's
 * `transcript` mode; the shell mounts it, positions the container and feeds it the bridge's items).
 *
 * Everything in a transcript is untrusted: assistant text quotes web pages, tool output is whatever a command printed.
 * Text goes in as text; markdown goes through `marked` (raw HTML escaped, images shown as links) and then DOMPurify
 * against an allowlist (no script, style, form, frame, svg or image, no `on*`, only `http(s):` / `mailto:` links, all
 * opened in a new context with `rel="noopener noreferrer"`). The code highlighter is loaded on first use and its
 * output is sanitised again (spans with classes only). Without a DOM to sanitise in, markdown shows as plain text.
 */

export interface TranscriptRenderHost {
  /** A prompt to send; resolving false (not sent) puts the text back in the prompt box. */
  onPromptSubmit(text: string): void | Promise<boolean>;
  onAnswer(hash: string, choice: number | null, cancel?: boolean): void;
  onSwitchToTerminal(): void;
  loadSubagent(agentId: string): Promise<TranscriptItem[]>;
}

export interface BlockedQuestion {
  kind: string;
  text: string;
  excerpt: string[];
  choices: { n: number; label: string }[];
  selected?: number;
  hash: string;
}

export interface TranscriptView {
  setItems(items: TranscriptItem[]): void;
  applyUpdates(items: TranscriptItem[]): void;
  setBlocked(q: BlockedQuestion | null): void;
  /** The keyboard to the timeline (its scroll keys work at once). */
  focus(): void;
  focusPrompt(): void;
  destroy(): void;
}

export function mountTranscript(container: HTMLElement, host: TranscriptRenderHost): TranscriptView {
  return new Transcript(container, host);
}

// ---------------------------------------------------------------------------------------------------------------
// Text helpers

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)|\u001b[PX^_][^\u001b\u009c]*(?:\u001b\\|\u009c)|\u001b[ -/]*[0-~]/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Terminal output as plain text: ANSI escape sequences (CSI, OSC, DCS…) removed, a carriage return overwrites its
 * line (progress bars keep their last state), a backspace eats the character before it, other control characters go.
 */
export function stripAnsi(s: string): string {
  const lines = s.replace(ANSI, '').replace(/\r\n/g, '\n').split('\n');
  return lines
    .map((line) => {
      let l = line;
      if (l.includes('\r')) {
        const segs = l.split('\r');
        l = segs.reduce((acc, seg) => (seg.length >= acc.length ? seg : seg + acc.slice(seg.length)), '');
      }
      while (l.includes('\b')) {
        const next = l.replace(/[^\x08]\x08/, '');
        if (next === l) break;
        l = next;
      }
      return l.replace(CONTROL, '');
    })
    .join('\n');
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function clock(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const d = new Date(ts);
  return d.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', month: 'short', day: 'numeric' });
}

/** 0.4s, 12s, 3m 05s, 1h 02m. */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

// ---------------------------------------------------------------------------------------------------------------
// Markdown and code

const marked = new Marked({
  gfm: true,
  breaks: false,
  async: false,
  renderer: {
    // Raw HTML in the text is text: shown, never parsed.
    html({ text }) {
      return escapeHtml(text);
    },
    // Never an <img> (a remote image tells its host who reads the transcript): a link that names it.
    image({ href, text }) {
      return `<a href="${escapeHtml(href ?? '')}">${escapeHtml(text || 'image')}</a>`;
    },
  },
});

const MD_CONFIG: Config = {
  ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'em', 'strong', 'del', 's', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'sup', 'sub', 'input'],
  ALLOWED_ATTR: ['href', 'title', 'class', 'type', 'checked', 'disabled'],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
};

const HL_CONFIG: Config = {
  ALLOWED_TAGS: ['span'],
  ALLOWED_ATTR: ['class'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

let mdPurifier: Purifier | null | undefined;
let hlPurifier: Purifier | null | undefined;

/** Our own DOMPurify instances (hooks and config apart from the boards'); null without a DOM. */
function purifiers(): { md: Purifier; hl: Purifier } | null {
  if (mdPurifier === undefined || hlPurifier === undefined) {
    if (typeof window === 'undefined') return null;
    const md = DOMPurify(window);
    const hl = DOMPurify(window);
    if (!md.isSupported || !hl.isSupported) {
      mdPurifier = hlPurifier = null;
      return null;
    }
    md.addHook('uponSanitizeAttribute', (node, data) => {
      const tag = node.nodeName;
      if (data.attrName === 'class') data.keepAttr = tag === 'CODE' && /^language-[\w+#.-]{1,32}$/.test(data.attrValue);
      // GFM task lists: a disabled checkbox and nothing else.
      else if (data.attrName === 'type' || data.attrName === 'checked' || data.attrName === 'disabled') data.keepAttr = tag === 'INPUT';
    });
    md.addHook('afterSanitizeAttributes', (node) => {
      if (node.nodeName === 'INPUT') {
        const input = node as Element;
        if (input.getAttribute('type') !== 'checkbox') input.remove();
        else input.setAttribute('disabled', '');
        return;
      }
      if (node.nodeName !== 'A') return;
      const a = node as Element;
      if (!a.getAttribute('href')) {
        a.removeAttribute('href');
        return;
      }
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    });
    hl.addHook('uponSanitizeAttribute', (_node, data) => {
      if (data.attrName === 'class') data.keepAttr = /^[\w -]{1,64}$/.test(data.attrValue);
    });
    mdPurifier = md;
    hlPurifier = hl;
  }
  return mdPurifier && hlPurifier ? { md: mdPurifier, hl: hlPurifier } : null;
}

/** Sanitised DOM for `md`; null when this environment cannot sanitise. */
export function renderMarkdown(md: string): DocumentFragment | null {
  const p = purifiers();
  if (!p) return null;
  const html = marked.parse(md ?? '', { async: false });
  return p.md.sanitize(html, { ...MD_CONFIG, RETURN_DOM_FRAGMENT: true });
}

type Highlighter = typeof import('highlight.js/lib/common').default;
let hl: Highlighter | null = null;
let hlLoading: Promise<Highlighter | null> | null = null;
const hlPending = new Set<HTMLElement>();
const hlDone = new Set<() => void>();

/** Loads the code highlighter (once); true when it is ready. Code blocks stay plain until then. */
export function loadHighlighter(): Promise<boolean> {
  hlLoading ??= import('highlight.js/lib/common')
    .then((m) => {
      hl = m.default;
      for (const code of hlPending) if (code.isConnected) highlight(code);
      hlPending.clear();
      for (const f of hlDone) f();
      return hl;
    })
    .catch(() => null);
  return hlLoading.then((x) => x !== null);
}

const MAX_HIGHLIGHT = 100_000;
const MAX_AUTO = 8_000;

function highlight(code: HTMLElement): void {
  const p = purifiers();
  if (!hl || !p || code.classList.contains('hljs')) return;
  const text = code.textContent ?? '';
  if (text.length > MAX_HIGHLIGHT) return;
  const lang = /(?:^|\s)language-([\w+#.-]+)/.exec(code.className)?.[1]?.toLowerCase();
  let html: string;
  try {
    if (lang && hl.getLanguage(lang)) html = hl.highlight(text, { language: lang, ignoreIllegals: true }).value;
    else if (!lang && text.length <= MAX_AUTO) {
      const r = hl.highlightAuto(text);
      if (r.relevance < 5) return;
      html = r.value;
    } else return;
  } catch {
    return;
  }
  code.replaceChildren(p.hl.sanitize(html, { ...HL_CONFIG, RETURN_DOM_FRAGMENT: true }));
  code.classList.add('hljs');
}

/** Markdown into `el`, its code blocks highlighted now or once the highlighter has loaded. */
function setMarkdown(el: HTMLElement, md: string): void {
  const frag = renderMarkdown(md);
  if (!frag) {
    el.textContent = md;
    el.classList.add('tx-plain');
    return;
  }
  el.replaceChildren(frag);
  for (const code of el.querySelectorAll<HTMLElement>('pre > code')) {
    const lang = /(?:^|\s)language-([\w+#.-]+)/.exec(code.className)?.[1];
    if (lang && code.parentElement) code.parentElement.dataset.lang = lang;
    if (hl) highlight(code);
    else {
      hlPending.add(code);
      void loadHighlighter();
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Icons (24×24 strokes, the HUD's family)

const TX_ICON = {
  terminal: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M7.5 10l2.5 2-2.5 2M12.5 14.5h4"/>',
  edit: '<path d="M5 19l1-4.2L15.8 5a1.8 1.8 0 0 1 2.6 0l.6.6a1.8 1.8 0 0 1 0 2.6L9.2 18z"/><path d="M13.8 7l3.2 3.2"/>',
  file: '<path d="M7 3.5h7l4 4v13H7z"/><path d="M14 3.5v4h4M9.5 12h6M9.5 15.5h6"/>',
  search: '<circle cx="10.5" cy="10.5" r="5.5"/><path d="M14.5 14.5l5 5"/>',
  globe: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.5 2.5 2.5 13.5 0 16M12 4c-2.5 2.5-2.5 13.5 0 16"/>',
  agent: '<circle cx="9" cy="9" r="3"/><path d="M3.5 19c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5"/><circle cx="17" cy="8" r="2.3"/><path d="M16 13.2c2.6-.3 4.2 1.2 4.6 4"/>',
  list: '<path d="M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01"/>',
  tool: '<path d="M14.5 5.5a4 4 0 0 0-5 5L4 16v4h4l5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-2.5-.5-.5-2.5z"/>',
  chevron: '<path d="M9.5 7l5 5-5 5"/>',
  brain: '<path d="M9 5a3 3 0 0 0-3 3 3 3 0 0 0-1.5 5.3A3 3 0 0 0 9 18.5V5zM15 5a3 3 0 0 1 3 3 3 3 0 0 1 1.5 5.3A3 3 0 0 1 15 18.5V5z"/>',
  image: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M5 17l4.5-4 3 2.5 3-3L19 16"/>',
};

function toolIcon(name: string): string {
  const n = name.toLowerCase();
  if (/bash|shell|exec|command|terminal|run/.test(n)) return TX_ICON.terminal;
  if (/edit|write|patch|notebook/.test(n)) return TX_ICON.edit;
  if (/grep|glob|search|find/.test(n)) return n.includes('web') ? TX_ICON.globe : TX_ICON.search;
  if (/web|fetch|browse|url/.test(n)) return TX_ICON.globe;
  if (/read|view|open|cat/.test(n)) return TX_ICON.file;
  if (/agent|task/.test(n)) return TX_ICON.agent;
  if (/todo|plan/.test(n)) return TX_ICON.list;
  return TX_ICON.tool;
}

/** An image in a message or a tool's output (phase 1: the bridge only says where one was). */
const imageChip = () => h('span', { class: 'tx-img-chip', title: 'Images come in a later version' }, icon(TX_ICON.image), '[image — not shown yet]');

/** A tool's diffs: every file of a multi-file patch (`diffs`), else its one `diff`. */
function toolDiffs(t: NonNullable<TranscriptItem['tool']>): TranscriptDiff[] {
  const ok = (d: unknown): d is TranscriptDiff => !!d && typeof d === 'object' && Array.isArray((d as TranscriptDiff).hunks);
  const many = Array.isArray(t.diffs) ? t.diffs.filter(ok) : [];
  return many.length ? many : ok(t.diff) ? [t.diff] : [];
}

const toolImages = (t: NonNullable<TranscriptItem['tool']>) => (Array.isArray(t.images) ? t.images.length : 0);

const STATUS_TEXT: Record<string, string> = { running: 'running', ok: 'done', error: 'error', interrupted: 'interrupted' };

// ---------------------------------------------------------------------------------------------------------------
// Diffs

interface Hunk {
  header: string | null;
  oldStart: number | null;
  newStart: number | null;
  lines: string[];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A hunk as the bridge sends it (`TranscriptHunk`: `{old_start, old_lines, new_start, new_lines, lines}`, all starts 0
 * for Codex), Claude's raw structuredPatch (`{oldStart, …}`), a unified-diff string, or `{lines}` alone. Anything else
 * becomes its JSON as context lines. */
export function parseHunk(raw: unknown): Hunk {
  if (typeof raw === 'string') {
    const lines = raw.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    const out: Hunk = { header: null, oldStart: null, newStart: null, lines: [] };
    for (const l of lines) {
      if (out.header === null && out.lines.length === 0 && (l.startsWith('--- ') || l.startsWith('+++ ') || l.startsWith('diff ') || l.startsWith('index '))) continue;
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m && out.header === null && out.lines.length === 0) {
        out.header = l;
        out.oldStart = Number(m[1]);
        out.newStart = Number(m[2]);
        continue;
      }
      out.lines.push(l);
    }
    return out;
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const lines = Array.isArray(o.lines) ? o.lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))) : o.lines === null ? [] : null;
    if (lines) {
      let oldStart = num(o.oldStart ?? o.old_start);
      let newStart = num(o.newStart ?? o.new_start);
      let oldLines = num(o.oldLines ?? o.old_lines);
      let newLines = num(o.newLines ?? o.new_lines);
      // The bridge's Codex patches have no line numbers: every field is 0 (a real hunk starts at line 1 on one side).
      if (oldStart === 0 && newStart === 0) oldStart = newStart = oldLines = newLines = null;
      const header = oldStart !== null && newStart !== null ? `@@ -${oldStart}${oldLines !== null ? `,${oldLines}` : ''} +${newStart}${newLines !== null ? `,${newLines}` : ''} @@` : typeof o.header === 'string' ? o.header : null;
      return { header, oldStart, newStart, lines };
    }
  }
  return { header: null, oldStart: null, newStart: null, lines: (JSON.stringify(raw, null, 2) ?? String(raw)).split('\n').map((l) => ` ${l}`) };
}

function diffStat(hunks: unknown[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const raw of hunks) {
    for (const l of parseHunk(raw).lines) {
      if (l.startsWith('+')) add++;
      else if (l.startsWith('-')) del++;
    }
  }
  return { add, del };
}

const MAX_DIFF_LINES = 2000;

function renderDiff(diff: TranscriptDiff): HTMLElement {
  const hunks = Array.isArray(diff.hunks) ? diff.hunks : [];
  const { add, del } = diffStat(hunks);
  const box = h('div', { class: 'tx-diff' }, h('div', { class: 'tx-diff-file' }, h('span', { class: 'tx-diff-path' }, String(diff.path ?? '')), h('span', { class: 'tx-diff-stat' }, h('span', { class: 'tx-add-n' }, `+${add}`), ' ', h('span', { class: 'tx-del-n' }, `−${del}`))));
  const body = h('div', { class: 'tx-diff-body', role: 'table' });
  let shown = 0;
  for (const raw of hunks) {
    const hk = parseHunk(raw);
    if (hk.header !== null) body.append(h('div', { class: 'tx-dl tx-dh', role: 'row' }, h('span', { class: 'tx-dn' }), h('span', { class: 'tx-dn' }), h('span', { class: 'tx-dt' }, hk.header)));
    let o = hk.oldStart;
    let n = hk.newStart;
    for (const l of hk.lines) {
      if (shown >= MAX_DIFF_LINES) break;
      shown++;
      const c = l[0];
      const kind = c === '+' ? 'add' : c === '-' ? 'del' : c === '\\' ? 'meta' : 'ctx';
      const on = kind === 'add' || kind === 'meta' ? '' : o !== null ? String(o) : '';
      const nn = kind === 'del' || kind === 'meta' ? '' : n !== null ? String(n) : '';
      if (o !== null && (kind === 'del' || kind === 'ctx')) o++;
      if (n !== null && (kind === 'add' || kind === 'ctx')) n++;
      body.append(h('div', { class: `tx-dl tx-${kind}`, role: 'row' }, h('span', { class: 'tx-dn' }, on), h('span', { class: 'tx-dn' }, nn), h('span', { class: 'tx-dt' }, l || ' ')));
    }
  }
  box.append(body);
  const total = hunks.reduce<number>((s, raw) => s + parseHunk(raw).lines.length, 0);
  if (total > shown) box.append(h('div', { class: 'tx-note' }, `${total - shown} more diff lines not shown`));
  return box;
}

// ---------------------------------------------------------------------------------------------------------------
// The view

/** Shown only with "show system": what the bridge marks hidden (dropped lines, as notices) and unknown entries. A notice
 * it does not hide (an interrupt, a turn's error, command output) is part of the conversation. */
const isSystem = (it: TranscriptItem) => it.hidden === true || it.kind === 'unknown';
const EXCERPT_LINES = 4;
const PROMPT_HINT = 'Message the agent…  (Enter sends, Shift+Enter for a new line)';
const MAX_INPUT_JSON = 4000;

/** A list of items (the transcript, or a subagent's nested one), in `seq` order, each row keyed by id. */
class Timeline {
  readonly el: HTMLOListElement;
  private items = new Map<string, TranscriptItem>();
  private rows = new Map<string, HTMLElement>();

  constructor(
    private readonly view: Transcript,
    readonly scope: string,
    nested: boolean,
  ) {
    this.el = h('ol', { class: nested ? 'tx-list tx-nested' : 'tx-list' });
  }

  get size(): number {
    return this.items.size;
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  systemCount(): number {
    let n = 0;
    for (const it of this.items.values()) if (isSystem(it)) n++;
    return n;
  }

  /** Replaces everything; returns the items that were not there before. */
  set(items: TranscriptItem[]): TranscriptItem[] {
    const before = new Set(this.items.keys());
    this.items.clear();
    this.rows.clear();
    const valid = items.filter(isItem);
    for (const it of valid) this.items.set(it.id, it);
    const sorted = [...this.items.values()].sort(bySeq);
    const rows = sorted.map((it) => {
      const row = this.view.renderRow(it, this.scope);
      this.rows.set(it.id, row);
      return row;
    });
    this.el.replaceChildren(...rows);
    return sorted.filter((it) => !before.has(it.id));
  }

  /** Adds new items and replaces known ones in place; returns the new ones. */
  apply(items: TranscriptItem[]): TranscriptItem[] {
    const added: TranscriptItem[] = [];
    for (const it of items) {
      if (!isItem(it)) continue;
      const prev = this.items.get(it.id);
      this.items.set(it.id, it);
      const row = this.view.renderRow(it, this.scope, prev);
      const old = this.rows.get(it.id);
      this.rows.set(it.id, row);
      if (old && prev && prev.seq === it.seq) {
        old.replaceWith(row);
        continue;
      }
      old?.remove();
      if (!prev) added.push(it);
      this.insert(it, row);
    }
    return added;
  }

  private insert(it: TranscriptItem, row: HTMLElement): void {
    // Usually at the end: walk back from the last row.
    let after: Element | null = this.el.lastElementChild;
    while (after) {
      const id = (after as HTMLElement).dataset.id;
      const other = id !== undefined ? this.items.get(id) : undefined;
      if (!other || bySeq(other, it) <= 0) break;
      after = after.previousElementSibling;
    }
    if (after) after.after(row);
    else this.el.prepend(row);
  }
}

function isItem(x: unknown): x is TranscriptItem {
  return !!x && typeof x === 'object' && typeof (x as TranscriptItem).id === 'string';
}

function bySeq(a: TranscriptItem, b: TranscriptItem): number {
  const sa = Number.isFinite(a.seq) ? a.seq : 0;
  const sb = Number.isFinite(b.seq) ? b.seq : 0;
  return sa - sb || (a.ts ?? 0) - (b.ts ?? 0);
}

interface SubState {
  items: TranscriptItem[] | null;
  error: string | null;
  loading: Promise<void> | null;
  status: string;
}

class Transcript implements TranscriptView {
  readonly root: HTMLDivElement;
  private readonly scroller: HTMLDivElement;
  private readonly timeline: Timeline;
  private readonly banner: HTMLDivElement;
  private readonly jump: HTMLButtonElement;
  private readonly sysBtn: HTMLButtonElement;
  private readonly countEl: HTMLSpanElement;
  private readonly input: HTMLTextAreaElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly empty: HTMLDivElement;

  private following = true;
  private fresh = 0;
  private showSystem = false;
  private blocked: BlockedQuestion | null = null;
  private destroyed = false;
  /** Expanded rows, `scope/id`, kept across re-renders and resyncs. */
  private readonly expanded = new Set<string>();
  /** When a tool we saw running was seen finished (wall clock), for its duration. */
  private readonly finished = new Map<string, number>();
  private readonly subs = new Map<string, SubState>();
  private ticker: ReturnType<typeof setInterval> | null = null;
  private resize: ResizeObserver | null = null;
  private readonly onHighlighted = () => this.stick();

  constructor(
    container: HTMLElement,
    private readonly host: TranscriptRenderHost,
  ) {
    this.timeline = new Timeline(this, '', false);
    this.countEl = h('span', { class: 'tx-count' });
    this.sysBtn = h('button', { class: 'tx-sys-toggle', 'aria-pressed': 'false', title: 'Show system notices and unrecognised entries', onclick: () => this.toggleSystem() });
    this.banner = h('div', { class: 'tx-banner', role: 'alert', hidden: true });
    this.empty = h('div', { class: 'tx-empty' }, 'No conversation yet.');
    this.scroller = h('div', { class: 'tx-scroll', tabindex: '-1', 'aria-label': 'Conversation' }, this.empty, this.timeline.el);
    this.jump = h('button', { class: 'tx-jump', hidden: true, onclick: () => this.toBottom() });
    this.input = h('textarea', { class: 'tx-input', rows: '1', placeholder: PROMPT_HINT, 'aria-label': 'Prompt', spellcheck: 'true' });
    this.sendBtn = h('button', { class: 'tx-send', title: 'Send', onclick: () => this.submit() }, 'Send');
    const form = h('div', { class: 'tx-prompt' }, this.input, this.sendBtn);
    // The toggle sits on the left: the HUD's plan-limits widget can hang over the screen's top-right corner.
    const bar = h('div', { class: 'tx-bar' }, h('span', { class: 'tx-title' }, 'Transcript'), this.countEl, this.sysBtn);
    this.root = h('div', { class: 'tx', 'data-system': 'hidden' }, bar, this.banner, h('div', { class: 'tx-main' }, this.scroller, this.jump), form);
    this.updateCounts();

    this.scroller.addEventListener('scroll', () => this.onScroll(), { passive: true });
    this.root.addEventListener('keydown', (e) => this.onKey(e));
    this.input.addEventListener('keydown', (e) => this.onInputKey(e));
    this.input.addEventListener('input', () => this.grow());
    hlDone.add(this.onHighlighted);
    if (typeof ResizeObserver !== 'undefined') {
      this.resize = new ResizeObserver(() => this.stick());
      this.resize.observe(this.scroller);
    }
    container.append(this.root);
    const a = document.activeElement;
    if (!a || a === document.body) this.scroller.focus({ preventScroll: true });
  }

  // --- TranscriptView ---

  setItems(items: TranscriptItem[]): void {
    if (this.destroyed) return;
    const hadAny = this.timeline.size > 0;
    const added = this.timeline.set(Array.isArray(items) ? items : []);
    this.afterChange(hadAny ? added : [], !hadAny);
  }

  applyUpdates(items: TranscriptItem[]): void {
    if (this.destroyed || !Array.isArray(items) || items.length === 0) return;
    const added = this.timeline.apply(items);
    this.afterChange(added, false);
  }

  setBlocked(q: BlockedQuestion | null): void {
    if (this.destroyed) return;
    this.blocked = q && typeof q === 'object' ? q : null;
    this.renderBanner();
  }

  focus(): void {
    if (this.destroyed) return;
    this.scroller.focus({ preventScroll: true });
  }

  focusPrompt(): void {
    if (this.destroyed || this.input.disabled) return;
    this.input.focus();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.resize?.disconnect();
    hlDone.delete(this.onHighlighted);
    this.root.remove();
  }

  // --- rows ---

  /** One item's row; never throws (a row that fails to render shows as an unknown one). */
  renderRow(it: TranscriptItem, scope: string, prev?: TranscriptItem): HTMLElement {
    if (it.kind === 'tool' && prev?.tool?.status === 'running' && it.tool && it.tool.status !== 'running' && !this.finished.has(it.id)) this.finished.set(it.id, Date.now());
    let row: HTMLElement;
    try {
      row = this.build(it, scope);
    } catch {
      row = this.unknownRow(it, 'unreadable entry');
    }
    row.dataset.id = it.id;
    row.dataset.kind = typeof it.kind === 'string' ? it.kind : 'unknown';
    if (isSystem(it)) row.classList.add('tx-sys');
    const t = clock(it.ts);
    if (t && !row.title) row.title = t;
    return row;
  }

  private build(it: TranscriptItem, scope: string): HTMLElement {
    switch (it.kind) {
      case 'user':
        return h('li', { class: 'tx-item tx-user' }, this.parts(it, 'tx-bubble'));
      case 'assistant':
        return h('li', { class: 'tx-item tx-assistant' }, this.parts(it, 'tx-said'));
      case 'thinking':
        return this.thinkingRow(it, scope);
      case 'tool':
        return it.tool ? this.toolRow(it, scope) : this.unknownRow(it, 'tool call without details');
      case 'subagent':
        return it.subagent ? this.subagentRow(it, scope) : this.unknownRow(it, 'subagent without details');
      case 'compaction':
        return h('li', { class: 'tx-item tx-compaction', title: it.notice?.text ?? '' }, h('div', { role: 'separator', class: 'tx-compaction-rule' }, h('span', { class: 'tx-compaction-label' }, 'Context compacted')));
      case 'notice':
        return h('li', { class: 'tx-item tx-notice' }, h('span', { class: 'tx-notice-tag' }, it.hidden ? 'system' : 'note'), h('span', { class: 'tx-notice-text' }, it.notice?.text ?? it.raw_type ?? ''));
      default:
        return this.unknownRow(it, null);
    }
  }

  private unknownRow(it: TranscriptItem, why: string | null): HTMLElement {
    const raw = typeof it.raw_type === 'string' && it.raw_type ? it.raw_type : typeof it.kind === 'string' ? it.kind : '?';
    return h('li', { class: 'tx-item tx-unknown tx-sys' }, h('span', { class: 'tx-notice-tag' }, 'unknown'), h('code', { class: 'tx-raw' }, raw), why ? h('span', { class: 'tx-notice-text' }, why) : null);
  }

  private parts(it: TranscriptItem, cls: string): HTMLElement {
    const box = h('div', { class: cls });
    for (const p of Array.isArray(it.parts) ? it.parts : []) {
      if (p && typeof p === 'object' && 'text' in p && typeof p.text === 'string') {
        const md = h('div', { class: 'tx-md' });
        setMarkdown(md, p.text);
        box.append(md);
      } else if (p && typeof p === 'object' && 'image_omitted' in p) {
        box.append(imageChip());
      }
    }
    if (it.truncated) box.append(h('div', { class: 'tx-note' }, 'Truncated: only the start is shown.'));
    if (!box.childElementCount) box.classList.add('tx-blank');
    return box;
  }

  private expander(key: string, onOpen: (open: boolean) => void): { open: boolean; toggle: (btn: HTMLElement) => void } {
    return {
      open: this.expanded.has(key),
      toggle: (btn) => {
        const open = !this.expanded.has(key);
        if (open) this.expanded.add(key);
        else this.expanded.delete(key);
        btn.setAttribute('aria-expanded', String(open));
        onOpen(open);
      },
    };
  }

  private thinkingRow(it: TranscriptItem, scope: string): HTMLElement {
    const text = (it.parts ?? [])
      .map((p) => (p && typeof p === 'object' && 'text' in p && typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n\n');
    const row = h('li', { class: 'tx-item tx-thinking' });
    if (!text.trim()) {
      row.append(h('span', { class: 'tx-chip tx-chip-mute', title: 'The reasoning is encrypted: nothing to show' }, icon(TX_ICON.brain), 'reasoning'));
      return row;
    }
    const body = h('div', { class: 'tx-thinking-body tx-md' });
    const ex = this.expander(`${scope}/${it.id}`, (open) => {
      if (open && !body.childNodes.length) setMarkdown(body, text);
      body.hidden = !open;
    });
    const chip = h('button', { class: 'tx-chip', 'aria-expanded': String(ex.open), onclick: () => ex.toggle(chip) }, icon(TX_ICON.brain), 'reasoning', icon(TX_ICON.chevron));
    body.hidden = !ex.open;
    if (ex.open) setMarkdown(body, text);
    row.append(chip, body);
    return row;
  }

  private toolRow(it: TranscriptItem, scope: string): HTMLElement {
    const t = it.tool as NonNullable<TranscriptItem['tool']>;
    const status = typeof t.status === 'string' ? t.status : 'running';
    const row = h('li', { class: 'tx-item tx-tool', 'data-status': status });
    const dur = h('span', { class: 'tx-tool-dur' });
    if (status === 'running') {
      dur.dataset.since = String(it.ts);
      dur.textContent = this.elapsed(it.ts);
      this.tick();
    } else {
      const end = this.finished.get(it.id);
      if (end !== undefined && Number.isFinite(it.ts) && it.ts > 0) {
        const ms = end - it.ts;
        if (ms >= 0 && ms < 86_400_000) dur.textContent = duration(ms);
      }
    }
    const diffs = toolDiffs(t);
    const stat = diffs.length ? diffs.map((d) => diffStat(d.hunks)).reduce((a, b) => ({ add: a.add + b.add, del: a.del + b.del })) : null;
    const head = h(
      'button',
      { class: 'tx-tool-row', 'aria-expanded': 'false' },
      h('span', { class: 'tx-tool-icon' }, icon(toolIcon(String(t.name ?? '')))),
      h('span', { class: 'tx-tool-name' }, String(t.name ?? 'tool')),
      h('span', { class: 'tx-tool-sum' }, String(t.input_summary ?? '')),
      stat ? h('span', { class: 'tx-diff-stat' }, h('span', { class: 'tx-add-n' }, `+${stat.add}`), ' ', h('span', { class: 'tx-del-n' }, `−${stat.del}`)) : null,
      h('span', { class: 'tx-tool-status' }, STATUS_TEXT[status] ?? status),
      dur,
      h('span', { class: 'tx-caret' }, icon(TX_ICON.chevron)),
    );
    const body = h('div', { class: 'tx-tool-body' });
    const ex = this.expander(`${scope}/${it.id}`, (open) => {
      if (open && !body.childNodes.length) this.fillTool(body, t, diffs);
      body.hidden = !open;
    });
    head.setAttribute('aria-expanded', String(ex.open));
    head.addEventListener('click', () => ex.toggle(head));
    body.hidden = !ex.open;
    if (ex.open) this.fillTool(body, t, diffs);
    row.append(head, body);
    return row;
  }

  private fillTool(body: HTMLElement, t: NonNullable<TranscriptItem['tool']>, diffs: TranscriptDiff[]): void {
    if (t.input !== undefined && t.input !== null) {
      let json: string;
      try {
        json = typeof t.input === 'string' ? t.input : (JSON.stringify(t.input, null, 2) ?? '');
      } catch {
        json = String(t.input);
      }
      if (json && json !== t.input_summary) {
        if (json.length > MAX_INPUT_JSON) json = `${json.slice(0, MAX_INPUT_JSON)}\n…`;
        body.append(h('div', { class: 'tx-label' }, 'Input'), h('pre', { class: 'tx-out tx-input-json' }, json));
      }
    }
    for (const d of diffs) {
      body.append(renderDiff(d));
      if (d.truncated) body.append(h('div', { class: 'tx-note' }, 'Diff truncated: only the start is shown.'));
    }
    if (typeof t.output_text === 'string' && t.output_text.length) {
      body.append(h('div', { class: 'tx-label' }, 'Output'), h('pre', { class: 'tx-out' }, stripAnsi(t.output_text)));
    } else if (!diffs.length && !toolImages(t) && t.status !== 'running') body.append(h('div', { class: 'tx-note' }, 'No output.'));
    const images = toolImages(t);
    for (let i = 0; i < images; i++) body.append(imageChip());
    if (t.output_truncated) body.append(h('div', { class: 'tx-note' }, 'Output truncated: only the start is shown.'));
    if (t.status === 'running') body.append(h('div', { class: 'tx-note' }, 'Still running…'));
  }

  private subagentRow(it: TranscriptItem, scope: string): HTMLElement {
    const s = it.subagent as NonNullable<TranscriptItem['subagent']>;
    const agentId = String(s.agent_id ?? '');
    const key = `${scope}/${it.id}`;
    const row = h('li', { class: 'tx-item tx-subagent', 'data-status': String(s.status ?? '') });
    const body = h('div', { class: 'tx-sub-body', 'data-key': key });
    const state = this.subs.get(agentId);
    // A status change (e.g. running → completed) makes what we loaded stale.
    if (state && state.status !== String(s.status ?? '')) {
      state.items = null;
      state.error = null;
      state.status = String(s.status ?? '');
    }
    const ex = this.expander(key, (open) => {
      body.hidden = !open;
      if (open) this.fillSub(body, agentId, String(s.status ?? ''), key);
    });
    const head = h(
      'button',
      { class: 'tx-sub-row', 'aria-expanded': String(ex.open), onclick: () => ex.toggle(head) },
      h('span', { class: 'tx-tool-icon' }, icon(TX_ICON.agent)),
      h('span', { class: 'tx-tool-name' }, 'Subagent'),
      h('span', { class: 'tx-tool-sum' }, String(s.description ?? '')),
      h('span', { class: 'tx-tool-status' }, String(s.status ?? '')),
      h('span', { class: 'tx-caret' }, icon(TX_ICON.chevron)),
    );
    body.hidden = !ex.open;
    if (ex.open) this.fillSub(body, agentId, String(s.status ?? ''), key);
    row.append(head, body);
    return row;
  }

  private fillSub(body: HTMLElement, agentId: string, status: string, key: string): void {
    // The bridge learns a Claude subagent's id from its call's result: until then there is no timeline to ask for.
    if (!agentId) {
      body.replaceChildren(h('div', { class: 'tx-note' }, status === 'running' ? 'Its steps show here once it reports back.' : 'This subagent’s steps were not recorded.'));
      return;
    }
    let st = this.subs.get(agentId);
    if (!st) {
      st = { items: null, error: null, loading: null, status };
      this.subs.set(agentId, st);
    }
    const state = st;
    if (state.items) {
      const tl = new Timeline(this, `${key}>`, true);
      tl.set(state.items);
      const reload = h('button', { class: 'tx-link', onclick: () => this.reloadSub(body, agentId, status, key) }, 'Reload');
      body.replaceChildren(h('div', { class: 'tx-sub-meta' }, `${tl.size} ${tl.size === 1 ? 'entry' : 'entries'}`, reload), tl.size ? tl.el : h('div', { class: 'tx-note' }, 'This subagent has no entries yet.'));
      return;
    }
    if (state.error !== null) {
      body.replaceChildren(h('div', { class: 'tx-note tx-err' }, `Couldn’t load this subagent: ${state.error}`, ' ', h('button', { class: 'tx-link', onclick: () => this.reloadSub(body, agentId, status, key) }, 'Try again')));
      return;
    }
    body.replaceChildren(h('div', { class: 'tx-note' }, 'Loading…'));
    if (state.loading) return;
    let p: Promise<TranscriptItem[]>;
    try {
      p = Promise.resolve(this.host.loadSubagent(agentId));
    } catch (e) {
      p = Promise.reject(e);
    }
    state.loading = p.then(
      (items) => {
        state.items = Array.isArray(items) ? items : [];
        state.error = null;
      },
      (e: unknown) => {
        state.error = e instanceof Error ? e.message : String(e ?? 'failed');
      },
    );
    void state.loading.then(() => {
      state.loading = null;
      if (this.destroyed) return;
      // Fill whichever body is showing it now (the row may have been re-rendered meanwhile).
      for (const b of this.root.querySelectorAll<HTMLElement>('.tx-sub-body')) {
        if (b.dataset.key === key && !b.hidden) this.fillSub(b, agentId, status, key);
      }
    });
  }

  private reloadSub(body: HTMLElement, agentId: string, status: string, key: string): void {
    const st = this.subs.get(agentId);
    if (st && !st.loading) {
      st.items = null;
      st.error = null;
    }
    this.fillSub(body, agentId, status, key);
  }

  private elapsed(since: number): string {
    if (!Number.isFinite(since) || since <= 0) return '';
    return duration(Math.max(0, Date.now() - since));
  }

  /** Keeps running tools' elapsed time ticking, while there are any. */
  private tick(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      const spans = this.root.querySelectorAll<HTMLElement>('.tx-tool[data-status="running"] .tx-tool-dur[data-since]');
      if (!spans.length || this.destroyed) {
        if (this.ticker) clearInterval(this.ticker);
        this.ticker = null;
        return;
      }
      for (const s of spans) s.textContent = this.elapsed(Number(s.dataset.since));
    }, 1000);
  }

  // --- follow mode ---

  private atBottom(): boolean {
    const s = this.scroller;
    return s.scrollHeight - s.scrollTop - s.clientHeight <= 32;
  }

  private onScroll(): void {
    this.following = this.atBottom();
    if (this.following && this.fresh) {
      this.fresh = 0;
      this.renderJump();
    }
  }

  private afterChange(added: TranscriptItem[], initial: boolean): void {
    this.updateCounts();
    if (initial || this.following) {
      this.stick(true);
      return;
    }
    const seen = added.filter((it) => this.showSystem || !isSystem(it)).length;
    if (seen) {
      this.fresh += seen;
      this.renderJump();
    }
  }

  /** Back to the bottom when following (content grew, the view resized, code got highlighted). */
  private stick(force = false): void {
    if (this.destroyed || (!force && !this.following)) return;
    this.scroller.scrollTop = this.scroller.scrollHeight;
    this.following = true;
  }

  private toBottom(): void {
    this.stick(true);
    this.fresh = 0;
    this.renderJump();
  }

  private renderJump(): void {
    this.jump.hidden = this.fresh === 0;
    this.jump.textContent = this.fresh ? `${this.fresh} new · jump to latest` : '';
  }

  private updateCounts(): void {
    const n = this.timeline.size;
    const sys = this.timeline.systemCount();
    this.countEl.textContent = n ? `${n - sys} ${n - sys === 1 ? 'entry' : 'entries'}` : '';
    this.sysBtn.textContent = sys ? `Show system (${sys})` : 'Show system';
    if (this.showSystem) this.sysBtn.textContent = sys ? `Hide system (${sys})` : 'Hide system';
    this.empty.hidden = n > 0;
  }

  private toggleSystem(): void {
    this.showSystem = !this.showSystem;
    this.root.dataset.system = this.showSystem ? 'shown' : 'hidden';
    this.sysBtn.setAttribute('aria-pressed', String(this.showSystem));
    this.updateCounts();
    this.stick();
  }

  // --- keys and prompt ---

  private scrollBy(dy: number): void {
    this.scroller.scrollTop = Math.max(0, this.scroller.scrollTop + dy);
    this.onScroll();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.target === this.input) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    // A focused button keeps Enter / Space (it opens its row); the game does not see them.
    if ((e.key === 'Enter' || e.key === ' ') && target?.closest('button, a')) {
      e.stopPropagation();
      return;
    }
    const page = Math.max(40, this.scroller.clientHeight * 0.9);
    switch (e.key) {
      case 'PageUp':
        this.scrollBy(-page);
        break;
      case 'PageDown':
        this.scrollBy(page);
        break;
      case 'Home':
        this.scroller.scrollTop = 0;
        this.onScroll();
        break;
      case 'End':
        this.toBottom();
        break;
      case 'j':
      case 'ArrowDown':
        this.scrollBy(48);
        break;
      case 'k':
      case 'ArrowUp':
        this.scrollBy(-48);
        break;
      default: {
        const q = this.blocked;
        const n = /^[1-9]$/.test(e.key) ? Number(e.key) : NaN;
        if (q && q.choices?.some((c) => c.n === n)) {
          this.host.onAnswer(q.hash, n);
          break;
        }
        return;
      }
    }
    e.preventDefault();
    e.stopPropagation();
  }

  private onInputKey(e: KeyboardEvent): void {
    // Esc is the shell's as everywhere in the seated view (a bare one stands you up, Ctrl/Cmd+Esc goes back to the
    // terminal); every other key typed here is the prompt's.
    if (e.key === 'Escape') return;
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.submit();
    }
  }

  private submit(): void {
    const text = this.input.value;
    if (!text.trim() || this.input.disabled) return;
    this.input.value = '';
    this.grow();
    // Not sent (refused, too long): the draft comes back unless something new was typed meanwhile.
    void Promise.resolve(this.host.onPromptSubmit(text)).then((sent) => {
      if (sent === false && !this.destroyed && !this.input.value) {
        this.input.value = text;
        this.grow();
      }
    });
  }

  private grow(): void {
    const el = this.input;
    el.style.height = 'auto';
    if (el.scrollHeight) el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }

  // --- blocked banner ---

  private renderBanner(): void {
    const q = this.blocked;
    // A blocked worker takes no prompt (the bridge refuses it): answer above, or in the terminal. A draft stays.
    this.input.disabled = !!q;
    this.input.placeholder = q ? 'Waiting for an answer to the question above (or switch to the terminal)' : PROMPT_HINT;
    this.sendBtn.disabled = !!q;
    if (!q) {
      this.banner.hidden = true;
      this.banner.replaceChildren();
      return;
    }
    const excerpt = (Array.isArray(q.excerpt) ? q.excerpt : [])
      .map((l) => stripAnsi(String(l)))
      .filter((l, i, a) => l.trim() || (i > 0 && i < a.length - 1))
      .slice(-EXCERPT_LINES);
    const choices = (Array.isArray(q.choices) ? q.choices : []).filter((c) => c && Number.isInteger(c.n));
    const chips = choices.map((c) =>
      h('button', { class: c.n === q.selected ? 'tx-choice tx-choice-sel' : 'tx-choice', 'data-n': String(c.n), onclick: () => this.host.onAnswer(q.hash, c.n) }, h('span', { class: 'tx-choice-n' }, String(c.n)), h('span', { class: 'tx-choice-label' }, String(c.label ?? ''))),
    );
    const parts: HTMLElement[] = [
      h('div', { class: 'tx-banner-head' }, h('span', { class: 'tx-banner-tag' }, 'Waiting for you'), h('span', { class: 'tx-banner-text' }, String(q.text ?? '').trim() || 'Waiting for input')),
    ];
    if (excerpt.length) parts.push(h('pre', { class: 'tx-banner-excerpt' }, excerpt.join('\n')));
    parts.push(
      h(
        'div',
        { class: 'tx-banner-actions' },
        ...chips,
        h('span', { class: 'tx-spacer' }),
        choices.length ? h('button', { class: 'tx-link', onclick: () => this.host.onAnswer(q.hash, null, true) }, 'Cancel') : null,
        h('button', { class: 'tx-link tx-to-term', onclick: () => this.host.onSwitchToTerminal() }, 'Switch to terminal'),
      ),
    );
    this.banner.replaceChildren(...parts);
    this.banner.hidden = false;
  }
}
