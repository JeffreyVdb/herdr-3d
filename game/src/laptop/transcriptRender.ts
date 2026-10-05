import './transcript.css';
import DOMPurify, { type Config, type DOMPurify as Purifier } from 'dompurify';
import { Marked } from 'marked';
import type { Ask, CommandArgs, Followup, TranscriptDiff, TranscriptItem, Usage } from '../net/protocol';
import { AskCard, askItem, type AskResult } from './askCard';
import { isSendKey } from './askStack';
import { FollowupCard, type FollowupResult } from './followupCard';
import type { ImageFeed } from './imageFeed';
import { imageRuns, imagesOf, isImageOnly, isImagePart, isOmittedPart, Thumbs } from './transcriptImages';
import { h, icon } from '../ui/dom';
// #64: the prompt box is the shared composer, so a screenshot can be pasted into it
import { mountComposer, type Composer } from '../ui/composer/composer';
import { Draft as PromptDraft, type Uploader } from '../ui/composer/draft';
import { hasContent, heldRefusalText, notSentText, PASTE_HINT } from '../ui/composer/field';
import { WORKER_PROMPT_MAX_BYTES } from '../ui/composer/model';
import { ViewPrefs, type ViewPref } from '../ui/themePrefs';
import { THEMES, ZOOM, stepZoom, type ThemeId } from '../ui/themes';
import { contextMeter } from '../world/usage';
import { zoomKey } from './keys';
import type { ActivityCue, PendingPrompt } from './transcriptActivity';

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
  /** M16 phase 2: this worker's images (null: none can be fetched, every image is a "not available" card). */
  images: ImageFeed | null;
  /** A prompt to send (images already uploaded, as `[Image #n: <path>]` markers); resolving false (not sent) leaves it in the prompt box. */
  onPromptSubmit(text: string): void | Promise<boolean>;
  /** #64: one image to Drop Zone (null: none can be uploaded here, a pasted image says so). */
  upload?: Uploader | null;
  /** #64: the worker's name, for the upload's file name. */
  label?: string;
  onAnswer(hash: string, choice: number | null, cancel?: boolean): void;
  /** #57: answers (or dismisses) the worker's ask; `id` is filled in by the host. */
  onAnswerAsk(args: CommandArgs['worker.answer_ask']): Promise<AskResult>;
  /** #90: answers the worker's follow-up questions; `id` is filled in by the host (none: the card cannot send). */
  onAnswerFollowup?(args: CommandArgs['worker.answer_followup']): Promise<FollowupResult>;
  /** #90: dismisses them. */
  onDismissFollowup?(turnId: string): Promise<FollowupResult>;
  onSwitchToTerminal(): void;
  loadSubagent(agentId: string): Promise<TranscriptItem[]>;
  /** #58: a refused prompt's row is dismissed. */
  onDismissPending?(id: string): void;
  /** A queued prompt should go now: the host presses Esc (both CLIs stop the turn and send what is queued; none: no link). */
  onSendNow?(id: string): void;
  /** #59: the transcript's preset and zoom and hidden tool calls, shared by every view (none: this view's own, kept nowhere). */
  prefs?: ViewPrefs;
  /** #101: the worker's usage when the view opens, for its context meter (`setUsage` follows it; none: no meter yet). */
  usage?: Usage | null;
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
  /** #57: the worker's ask (null: none): a card pinned above the prompt box while it waits. */
  setAsk(ask: Ask | null): void;
  /** #90: the open questions of the agent's final message (null: none): a card above the prompt box, which stays on. */
  setFollowup(f: Followup | null): void;
  /** The mode's tab strip (Conversation | Images), put in the bar after the title. */
  attachTabs(tabs: HTMLElement): void;
  /** Is the item in the timeline (loaded)? */
  hasItem(id: string): boolean;
  /** Scrolls to an item and flashes it; false when it is not loaded (the caller pages older items first). */
  scrollToItem(id: string): boolean;
  /** #101: the worker's usage, for the context meter in the top strip (null, or a usage whose context is unknown: no meter). */
  setUsage(usage: Usage | null): void;
  /** #58: the live cue at the bottom of the timeline ("Thinking…" / "Working…" and for how long; null: none). */
  setActivity(cue: ActivityCue | null): void;
  /** #58: the prompts you sent that the transcript does not show yet, after its last item. */
  setPending(rows: readonly PendingPrompt[]): void;
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

/** A tool's diffs: every file of a multi-file patch (`diffs`), else its one `diff`. */
function toolDiffs(t: NonNullable<TranscriptItem['tool']>): TranscriptDiff[] {
  const ok = (d: unknown): d is TranscriptDiff => !!d && typeof d === 'object' && Array.isArray((d as TranscriptDiff).hunks);
  const many = Array.isArray(t.diffs) ? t.diffs.filter(ok) : [];
  return many.length ? many : ok(t.diff) ? [t.diff] : [];
}

const toolImages = (t: NonNullable<TranscriptItem['tool']>) => imagesOf(t.images);

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
/** #59: what "Hide tool calls" hides: tool rows (not subagents, not an agent's question, which is part of the conversation). */
export const isToolRow = (it: TranscriptItem) => it.kind === 'tool' && !!it.tool && !(it.tool.ask && typeof it.tool.ask === 'object' && Array.isArray(it.tool.ask.questions));
/** #70: a tool row with images (a Read of a PNG, a screenshot, a `view_image`): its strip shows collapsed, and stays when tool calls are hidden. */
export const toolHasImages = (it: TranscriptItem) => isToolRow(it) && toolImages(it.tool as NonNullable<TranscriptItem['tool']>).length > 0;
const EXCERPT_LINES = 4;
const PROMPT_HINT = `Message the agent…  (Enter sends, Shift+Enter for a new line, ${PASTE_HINT})`;

/** Where a pasted image goes when the host has no upload: the chip says it did not go up. */
const NO_UPLOAD: Uploader = () => Promise.resolve({ ok: false, code: 'unavailable', message: 'images cannot be uploaded from here' });
const MAX_INPUT_JSON = 4000;

/** A list of items (the transcript, or a subagent's nested one), in `seq` order, each row keyed by id. */
class Timeline {
  readonly el: HTMLOListElement;
  private items = new Map<string, TranscriptItem>();
  private rows = new Map<string, HTMLElement>();
  /** Merged image-only rows, and the first row of the run each is shown in. */
  private readonly merged = new Set<string>();
  private readonly leadOf = new Map<string, string>();
  /** An image-only row's own thumbnails (a merged row gives its away and gets them back). */
  private readonly own = new WeakMap<HTMLElement, HTMLElement[]>();

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

  get(id: string): TranscriptItem | undefined {
    return this.items.get(id);
  }

  /** The `seq` of the last item of this kind (-Infinity: none). */
  lastSeq(kind: string): number {
    let n = -Infinity;
    for (const it of this.items.values()) if (it.kind === kind && it.seq > n) n = it.seq;
    return n;
  }

  systemCount(): number {
    let n = 0;
    for (const it of this.items.values()) if (isSystem(it)) n++;
    return n;
  }

  /** #59: the tool rows (what "Hide tool calls" hides) that show otherwise (system ones only with "show system"). */
  tools(showSystem: boolean): TranscriptItem[] {
    return [...this.items.values()].filter((it) => isToolRow(it) && (showSystem || !isSystem(it))).sort(bySeq);
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
    this.regroup();
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
    this.regroup();
    return added;
  }

  /** The row an item is shown in: a merged image-only item shows in the row of the run's first. */
  row(id: string): HTMLElement | undefined {
    const lead = this.leadOf.get(id);
    return this.rows.get(lead ?? id);
  }

  /**
   * Runs of image-only items share one strip (`imageRuns` has the rule): the first item's row keeps every thumbnail of
   * the run and the others are hidden, so a run of screenshots reads as one row. Everything is undone and done again
   * on every change, so an update of any item of a run (or a row that breaks it) is right.
   */
  regroup(): void {
    // A row seen for the first time is whole: its thumbnails are its own.
    for (const r of this.rows.values()) {
      const strip = r.classList.contains('tx-imgonly') ? r.querySelector('.tx-strip') : null;
      if (strip && !this.own.has(r)) this.own.set(r, [...strip.children] as HTMLElement[]);
    }
    for (const r of this.rows.values()) {
      const own = this.own.get(r);
      const strip = r.querySelector('.tx-strip');
      if (!own || !strip) continue;
      if (strip.childElementCount !== own.length || r.hidden) {
        r.hidden = false;
        r.classList.remove('tx-merged');
        strip.replaceChildren(...own);
        strip.setAttribute('aria-label', own.length > 1 ? `${own.length} images` : 'Image');
      }
    }
    this.merged.clear();
    this.leadOf.clear();
    const sorted = [...this.items.values()].sort(bySeq);
    for (const ids of imageRuns(sorted, this.view.systemShown)) {
      if (ids.length < 2) continue;
      const lead = this.rows.get(ids[0] as string);
      const leadStrip = lead?.querySelector('.tx-strip');
      if (!lead || !leadStrip) continue;
      for (const id of ids.slice(1)) {
        const r = this.rows.get(id);
        const strip = r?.querySelector('.tx-strip');
        if (!r || !strip) continue;
        leadStrip.append(...strip.children);
        r.hidden = true;
        r.classList.add('tx-merged');
        this.merged.add(id);
        this.leadOf.set(id, ids[0] as string);
      }
      leadStrip.setAttribute('aria-label', `${leadStrip.childElementCount} images`);
    }
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
  /** #59: the view's prefs and its controls in the top strip: hide tool calls, the preset, the zoom. */
  private readonly prefs: ViewPrefs;
  private readonly unprefs: () => void;
  private readonly toolsBox: HTMLInputElement;
  private readonly toolsCount: HTMLSpanElement;
  /** While tool calls are hidden: the one running now, or the ones that failed since. */
  private readonly busy: HTMLButtonElement;
  private readonly themeBtns: HTMLButtonElement[];
  private readonly zoomBtns: { out: HTMLButtonElement; reset: HTMLButtonElement; in: HTMLButtonElement };
  /** Tool calls that failed while hidden, not looked at yet; and hidden rows shown anyway (looked at from the chip). */
  private readonly failedHidden = new Set<string>();
  private readonly revealed = new Set<string>();
  private readonly countEl: HTMLSpanElement;
  /** #101: the context meter (a `role="meter"`, hidden while its share or window is unknown) and what it was last drawn from. */
  private readonly ctxEl: HTMLDivElement;
  private readonly ctxFill: HTMLSpanElement;
  private readonly ctxPct: HTMLSpanElement;
  private readonly ctxUsed: HTMLSpanElement;
  private readonly ctxWin: HTMLSpanElement;
  private ctxKey = '';
  private readonly titleEl: HTMLSpanElement;
  /** The prompt box: the composer's editor (#64). */
  private readonly input: HTMLElement;
  private readonly composer: Composer;
  private readonly sendBtn: HTMLButtonElement;
  /** The box cannot take a prompt now (the worker waits on a question). */
  private promptOff = false;
  /** A prompt is on its way (uploading, then sent): the box is read-only until it is answered. */
  private sending = false;
  private readonly empty: HTMLDivElement;

  private following = true;
  /** Rows that came in while you were scrolled up; the chip counts the ones that show (#59: recounted on each toggle). */
  private readonly fresh = new Set<string>();
  private showSystem = false;
  private readonly thumbs: Thumbs;
  private blocked: BlockedQuestion | null = null;
  private readonly ask: AskCard;
  private readonly followup: FollowupCard; // #90
  /** Whether the banner and the prompt box were last drawn with the card up. */
  private asking = false;
  private destroyed = false;
  /** Expanded rows, `scope/id`, kept across re-renders and resyncs. */
  private readonly expanded = new Set<string>();
  /** When a tool we saw running was seen finished (wall clock), for its duration. */
  private readonly finished = new Map<string, number>();
  private readonly subs = new Map<string, SubState>();
  private ticker: ReturnType<typeof setInterval> | null = null;
  private resize: ResizeObserver | null = null;
  private readonly onHighlighted = () => this.stick();
  /** #58: after the timeline, the prompts on their way and the live cue; a polite live region says when either changes. */
  private readonly pendingList: HTMLOListElement;
  private readonly pendingEls = new Map<string, { key: string; el: HTMLElement }>();
  private pendingRows: readonly PendingPrompt[] = [];
  private readonly tail: HTMLDivElement;
  private activity: ActivityCue | null = null;
  private activityRow: HTMLElement | null = null;
  private readonly live: HTMLDivElement;
  /** A hidden tab pauses the cue's flash (the browser still runs a CSS animation there). */
  private readonly onVisibility = () => this.root.toggleAttribute('data-page-hidden', document.visibilityState === 'hidden');

  constructor(
    container: HTMLElement,
    private readonly host: TranscriptRenderHost,
  ) {
    this.timeline = new Timeline(this, '', false);
    this.countEl = h('span', { class: 'tx-count' });
    this.sysBtn = h('button', { class: 'tx-sys-toggle', 'aria-pressed': 'false', title: 'Show system notices and unrecognised entries', onclick: () => this.toggleSystem() });
    this.banner = h('div', { class: 'tx-banner', role: 'alert', hidden: true });
    this.empty = h('div', { class: 'tx-empty' }, 'No conversation yet.');
    this.pendingList = h('ol', { class: 'tx-list tx-pending-list', 'aria-label': 'Prompts on their way' });
    this.tail = h('div', { class: 'tx-tail' }, this.pendingList);
    this.live = h('div', { class: 'tx-live', role: 'status', 'aria-live': 'polite' });
    this.scroller = h('div', { class: 'tx-scroll', tabindex: '-1', 'aria-label': 'Conversation' }, this.empty, this.timeline.el, this.tail);
    this.thumbs = new Thumbs({ feed: host.images, root: this.scroller });
    this.jump = h('button', { class: 'tx-jump', hidden: true, onclick: () => this.toBottom() });
    this.composer = mountComposer({
      draft: new PromptDraft({ upload: host.upload ?? NO_UPLOAD, label: `transcript-${host.label ?? 'worker'}`, maxPromptBytes: WORKER_PROMPT_MAX_BYTES, holdRefused: true }),
      ariaLabel: 'Prompt',
      placeholder: PROMPT_HINT,
      submitPolicy: 'enter',
      onSubmit: () => this.submit(),
      // #139: completion is on, with no source yet (commands and files come next): no popup opens until one is added.
      complete: { sources: [], bounds: () => this.root },
    });
    this.input = this.composer.editor;
    this.input.classList.add('tx-input');
    this.sendBtn = h('button', { class: 'tx-send', title: 'Send', onclick: () => this.submit() }, 'Send');
    const form = h('div', { class: 'tx-prompt' }, this.composer.element, this.sendBtn);
    this.ask = new AskCard({
      answer: (args) => host.onAnswerAsk(args),
      toTerminal: () => host.onSwitchToTerminal(),
      focusTimeline: () => this.focus(),
      resized: () => {
        this.stick();
        // Shown or gone (also by itself, once its answer is recorded): the prompt box follows.
        if (this.asking !== this.ask.shown) this.renderBanner();
        // #90: the follow-up card waits behind a question's.
        this.followup?.suppress(this.ask.shown);
      },
    });
    const noFollowup = (): Promise<FollowupResult> => Promise.resolve({ ok: false, code: 'unsupported', message: 'Not available here.' });
    this.followup = new FollowupCard({
      answer: (args) => (host.onAnswerFollowup ? host.onAnswerFollowup(args) : noFollowup()),
      dismiss: (turnId) => (host.onDismissFollowup ? host.onDismissFollowup(turnId) : noFollowup()),
      focusTimeline: () => this.focus(),
      resized: () => {
        // A very short screen gives the card the timeline's room while it is up (transcript.css).
        this.root?.toggleAttribute('data-followup', this.followup.shown);
        this.stick();
      },
    });
    // The toggle sits on the left: the HUD's plan-limits widget can hang over the screen's top-right corner.
    this.titleEl = h('span', { class: 'tx-title' }, 'Transcript');
    // #59: hide tool calls, the working chip, the preset and the zoom. The preset's swatch is drawn in its colours only:
    // naming it in its own fonts would fetch them for every preset (they load when picked).
    this.prefs = host.prefs ?? new ViewPrefs(null);
    this.toolsBox = h('input', { type: 'checkbox', class: 'tx-check-box', onchange: () => (this.prefs.hideTools = this.toolsBox.checked) });
    this.toolsCount = h('span', { class: 'tx-check-n' });
    const tools = h('label', { class: 'tx-check', title: 'Hide tool calls (subagents and questions stay)' }, this.toolsBox, h('span', {}, 'Hide tools'), this.toolsCount);
    this.busy = h('button', { class: 'tx-busy', hidden: true, onclick: () => this.showHiddenTools() });
    this.themeBtns = THEMES.map((t) =>
      h(
        'button',
        {
          class: 'tx-theme',
          role: 'radio',
          'data-theme-id': t.id,
          'aria-label': t.label,
          title: `${t.label}: ${t.blurb}`,
          style: `--sw-bg: ${t.palette.bg}; --sw-fg: ${t.palette.text}; --sw-ac: ${t.palette.blue}`,
          onclick: () => this.pickTheme(t.id),
        },
        h('span', { class: 'tx-swatch', 'aria-hidden': 'true' }),
        h('span', { class: 'tx-theme-name', 'aria-hidden': 'true' }, t.label),
      ),
    );
    const picker = h('div', { class: 'tx-themes', role: 'radiogroup', 'aria-label': 'Transcript theme' }, ...this.themeBtns);
    picker.addEventListener('keydown', (e) => this.onPickerKey(e));
    this.zoomBtns = {
      out: h('button', { class: 'tx-zoom-btn', 'aria-label': 'Smaller text', title: 'Smaller text (Ctrl −)', onclick: () => this.prefs.setZoom('transcript', stepZoom(this.prefs.zoom('transcript'), -1)) }, 'A−'),
      reset: h('button', { class: 'tx-zoom-btn tx-zoom-level', title: 'Back to 100% (Ctrl 0)', onclick: () => this.prefs.setZoom('transcript', ZOOM.reset) }),
      in: h('button', { class: 'tx-zoom-btn', 'aria-label': 'Larger text', title: 'Larger text (Ctrl +)', onclick: () => this.prefs.setZoom('transcript', stepZoom(this.prefs.zoom('transcript'), 1)) }, 'A+'),
    };
    const zoom = h('div', { class: 'tx-zoom', role: 'group', 'aria-label': 'Transcript text size' }, this.zoomBtns.out, this.zoomBtns.reset, this.zoomBtns.in);
    // #101: how much of the context window is in use. The fill is decoration (the number says it all); the meter's own text is
    // its accessible value, so no live region chatters as it changes.
    this.ctxFill = h('span', { class: 'tx-ctx-fill' });
    this.ctxPct = h('span', { class: 'tx-ctx-pct' });
    this.ctxUsed = h('span', { class: 'tx-ctx-used' });
    this.ctxWin = h('span', { class: 'tx-ctx-win' });
    this.ctxEl = h(
      'div',
      { class: 'tx-ctx', role: 'meter', 'aria-label': 'Context in use', 'aria-valuemin': '0', 'aria-valuemax': '100', hidden: true },
      h('span', { class: 'tx-ctx-track', 'aria-hidden': 'true' }, this.ctxFill),
      h('span', { class: 'tx-ctx-text' }, this.ctxPct, this.ctxUsed, this.ctxWin),
    );
    // The preset and the zoom keep together at the strip's end; a narrow screen wraps them to a line of their own.
    const bar = h('div', { class: 'tx-bar' }, this.titleEl, this.countEl, this.sysBtn, tools, this.busy, this.ctxEl, h('div', { class: 'tx-look' }, picker, zoom));
    this.root = h('div', { class: 'tx', 'data-system': 'hidden', 'data-tools': 'shown' }, bar, this.banner, h('div', { class: 'tx-main' }, this.scroller, this.jump), this.ask.el, this.followup.el, form, this.live);
    this.unprefs = this.prefs.onChange((what) => this.applyPrefs(what));
    this.applyPrefs(null);
    this.updateCounts();
    this.setUsage(host.usage ?? null);

    this.scroller.addEventListener('scroll', () => this.onScroll(), { passive: true });
    this.root.addEventListener('keydown', (e) => this.onKey(e));
    this.input.addEventListener('keydown', (e) => this.onInputKey(e));
    hlDone.add(this.onHighlighted);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.onVisibility();
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
    const wasFailed = new Set(this.timeline.tools(true).filter((t) => t.tool?.status === 'error').map((t) => t.id));
    const added = this.timeline.set(Array.isArray(items) ? items : []);
    // #59: the first timeline (a failure that came while the terminal was up, before this view) or a resync is no
    // quieter than a live update: this turn's hidden failures you have not seen fail yet go on the chip.
    if (this.prefs.hideTools) for (const t of this.currentTurnTools()) if (t.tool?.status === 'error' && !wasFailed.has(t.id)) this.failedHidden.add(t.id);
    this.afterChange(hadAny ? added : [], !hadAny);
  }

  /** The tool rows that show otherwise (see `Timeline.tools`) since your last message: the turn the agent is on. */
  private currentTurnTools(): TranscriptItem[] {
    const since = this.timeline.lastSeq('user');
    return this.timeline.tools(this.showSystem).filter((t) => t.seq > since);
  }

  applyUpdates(items: TranscriptItem[]): void {
    if (this.destroyed || !Array.isArray(items) || items.length === 0) return;
    // #59: a tool call that fails while tool calls are hidden is not lost: the strip's chip says so until you look.
    if (this.prefs.hideTools) for (const it of items) if (isItem(it) && isToolRow(it) && it.tool?.status === 'error' && (this.showSystem || !isSystem(it))) this.failedHidden.add(it.id);
    const added = this.timeline.apply(items);
    this.afterChange(added, false);
  }

  setBlocked(q: BlockedQuestion | null): void {
    if (this.destroyed) return;
    this.blocked = q && typeof q === 'object' ? q : null;
    this.renderBanner();
  }

  setAsk(ask: Ask | null): void {
    if (this.destroyed) return;
    // The card wins over the screen's question: it has the whole question, the descriptions and multi-select
    // (the banner and the prompt box are redrawn when it shows or goes, through its resized()).
    this.ask.set(ask);
    this.followup.suppress(this.ask.shown);
  }

  setFollowup(f: Followup | null): void {
    if (this.destroyed) return;
    this.followup.set(f);
  }

  setUsage(usage: Usage | null): void {
    if (this.destroyed) return;
    const m = contextMeter(usage);
    // Called every seated frame: the DOM is touched only when what it shows changed.
    const key = m ? `${m.pct}|${m.level}|${m.label}|${m.title}|${m.valueText}` : '';
    if (key === this.ctxKey) return;
    this.ctxKey = key;
    this.ctxEl.hidden = !m;
    if (!m) return;
    this.ctxEl.dataset.level = m.level;
    this.ctxEl.title = m.title;
    this.ctxEl.setAttribute('aria-valuenow', String(m.pct));
    this.ctxEl.setAttribute('aria-valuetext', m.valueText);
    this.ctxFill.style.width = `${m.pct}%`;
    this.ctxPct.textContent = m.pctText;
    this.ctxUsed.textContent = m.usedText === null ? '' : ` · ${m.usedText}`;
    this.ctxWin.textContent = m.usedText === null ? ` of ${m.windowText}` : ` / ${m.windowText}`;
  }

  setActivity(cue: ActivityCue | null): void {
    if (this.destroyed) return;
    const was = this.activity;
    if (was === cue || (was && cue && was.kind === cue.kind && was.since === cue.since)) return;
    this.activity = cue;
    if (!cue) {
      // Out of the DOM, not hidden: nothing is left animating.
      this.activityRow?.remove();
      this.activityRow = null;
    } else {
      // One flashing element (the word and its icon, opacity only: transcript.css); the time is its sibling, set by the
      // 1 s ticker, so its repaint never happens inside the animated layer.
      const word = cue.kind === 'working' ? 'Working…' : 'Thinking…';
      const row = h(
        'div',
        { class: 'tx-activity', 'data-kind': cue.kind },
        h('span', { class: 'tx-activity-label' }, icon(cue.kind === 'working' ? TX_ICON.edit : TX_ICON.brain), word),
        h('span', { class: 'tx-activity-time tx-tick', 'data-since': String(cue.since) }, this.elapsed(cue.since)),
      );
      if (this.activityRow) this.activityRow.replaceWith(row);
      else this.tail.append(row);
      this.activityRow = row;
      this.tick();
    }
    // The state is announced when it changes, never the ticking time.
    if (was?.kind !== cue?.kind) this.announce(cue ? `${this.agent} is ${cue.kind === 'working' ? 'working' : 'thinking'}` : '');
    this.stick();
  }

  setPending(rows: readonly PendingPrompt[]): void {
    if (this.destroyed) return;
    const before = new Map(this.pendingRows.map((p) => [p.id, p]));
    this.pendingRows = Array.isArray(rows) ? rows : [];
    const els: HTMLElement[] = [];
    let say = '';
    for (const p of this.pendingRows) {
      const key = `${p.state}\u0000${p.late}\u0000${p.reason ?? ''}\u0000${p.due === null}`;
      let at = this.pendingEls.get(p.id);
      if (!at || at.key !== key) {
        at = { key, el: this.pendingRow(p) };
        this.pendingEls.set(p.id, at);
        const old = before.get(p.id);
        if (!old || old.state !== p.state || old.late !== p.late) say = this.pendingText(p);
      }
      els.push(at.el);
    }
    const ids = new Set(this.pendingRows.map((p) => p.id));
    for (const id of this.pendingEls.keys()) if (!ids.has(id)) this.pendingEls.delete(id);
    this.pendingList.replaceChildren(...els);
    if (say) this.announce(say);
    this.updateCounts();
    this.stick();
  }

  focus(): void {
    if (this.destroyed) return;
    this.scroller.focus({ preventScroll: true });
  }

  attachTabs(tabs: HTMLElement): void {
    if (this.destroyed) return;
    this.titleEl.after(tabs);
  }

  hasItem(id: string): boolean {
    return this.timeline.has(id);
  }

  scrollToItem(id: string): boolean {
    if (this.destroyed) return false;
    const row = this.timeline.row(id);
    if (!row) return false;
    // Reveal a hidden system row too? Images never come from one.
    this.following = false;
    row.scrollIntoView({ block: 'center' });
    this.onScroll();
    row.classList.remove('tx-flash');
    void row.offsetWidth;
    row.classList.add('tx-flash');
    return true;
  }

  focusPrompt(): void {
    if (this.destroyed || this.promptOff) return;
    this.composer.focus();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.resize?.disconnect();
    hlDone.delete(this.onHighlighted);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.unprefs();
    this.thumbs.destroy();
    this.ask.destroy();
    this.followup.destroy();
    // The composer's draft goes with the view: its uploads are cancelled, its object URLs revoked.
    this.composer.dispose();
    this.composer.getDraft().dispose();
    this.root.remove();
  }

  /** Rows of the timeline that merge image-only items need to know whether system rows show (they break a run then). */
  get systemShown(): boolean {
    return this.showSystem;
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
    if (isToolRow(it)) row.classList.add('tx-toolrow');
    if (toolHasImages(it)) row.classList.add('tx-toolimg');
    if (isToolRow(it) && this.revealed.has(it.id)) row.classList.add('tx-reveal');
    const t = clock(it.ts);
    if (t && !row.title) row.title = t;
    return row;
  }

  private build(it: TranscriptItem, scope: string): HTMLElement {
    switch (it.kind) {
      case 'user':
        return h('li', { class: isImageOnly(it) ? 'tx-item tx-user tx-imgonly' : 'tx-item tx-user' }, this.parts(it, 'tx-bubble'));
      case 'assistant':
        return h('li', { class: isImageOnly(it) ? 'tx-item tx-assistant tx-imgonly' : 'tx-item tx-assistant' }, this.parts(it, 'tx-said'));
      case 'thinking':
        return this.thinkingRow(it);
      case 'tool':
        if (it.tool?.ask && typeof it.tool.ask === 'object' && Array.isArray(it.tool.ask.questions)) return askItem(it, it.tool.ask);
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
    // Consecutive images (no text between) are one strip; text between them makes another.
    let run: unknown[] = [];
    const flush = () => {
      if (!run.length) return;
      box.append(this.thumbs.strip(imagesOf(run)));
      run = [];
    };
    for (const p of Array.isArray(it.parts) ? it.parts : []) {
      if (isImagePart(p) || isOmittedPart(p)) run.push(p);
      else if (p && typeof p === 'object' && 'text' in p && typeof p.text === 'string') {
        flush();
        const md = h('div', { class: 'tx-md' });
        setMarkdown(md, p.text);
        box.append(md);
      }
    }
    flush();
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

  /** The worker's name, for the cue and the queued prompt's chip. */
  private get agent(): string {
    return this.host.label || 'The agent';
  }

  private announce(text: string): void {
    this.live.textContent = text;
  }

  /** What a pending prompt's chip says. */
  private pendingText(p: PendingPrompt): string {
    switch (p.state) {
      case 'sending':
        return 'Sending…';
      case 'refused':
        return `Not sent: ${p.reason ?? 'the bridge refused it'}`;
      case 'queued':
        return p.late ? 'Queued · not seen in the transcript yet' : `Queued · ${this.agent} takes it when it can`;
      default:
        return p.late ? 'Sent · not seen in the transcript yet' : 'Sent';
    }
  }

  /** #58: a prompt on its way, where its message will be: your bubble, dimmed, and what became of it. */
  private pendingRow(p: PendingPrompt): HTMLElement {
    const md = h('div', { class: 'tx-md' });
    // Its images show once the agent has them: until then the marker reads as the number it will have.
    setMarkdown(md, p.text.replace(/\[Image #(\d+): [^\]\n]+\]/g, '[Image #$1]'));
    const meta = h('div', { class: 'tx-pending-meta' }, h('span', { class: 'tx-pending-state' }, this.pendingText(p)));
    if (p.state === 'refused') {
      const why = 'The prompt is still in the box below: change it or send it again.';
      meta.append(h('button', { class: 'tx-link', title: why, onclick: () => this.host.onDismissPending?.(p.id) }, 'Dismiss'));
    }
    // Only while the agent is still busy with the turn it waits for (`due` is null then).
    if (p.state === 'queued' && p.due === null && this.host.onSendNow) {
      const why = `Stops ${this.agent}'s current turn (and any tool it is running) and sends the queued prompt now.`;
      const now = h('button', {
        class: 'tx-link tx-send-now',
        title: why,
        onclick: (e: Event) => {
          (e.currentTarget as HTMLButtonElement).disabled = true;
          this.host.onSendNow?.(p.id);
        },
      }, 'Send now (interrupts)');
      meta.append(now);
    }
    return h('li', { class: 'tx-item tx-user tx-pending', 'data-state': p.state, 'data-late': String(p.late), 'data-pending': p.id }, h('div', { class: 'tx-bubble' }, md), meta);
  }

  private thinkingRow(it: TranscriptItem): HTMLElement {
    const text = (it.parts ?? [])
      .map((p) => (p && typeof p === 'object' && 'text' in p && typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n\n');
    const row = h('li', { class: 'tx-item tx-thinking' });
    if (!text.trim()) {
      row.append(h('span', { class: 'tx-chip tx-chip-mute', title: 'The reasoning is encrypted: nothing to show' }, icon(TX_ICON.brain), 'reasoning'));
      return row;
    }
    // Often the agent's own narration (Claude Code writes it as a thinking block, Codex as a reasoning summary): shown
    // as it is, dimmed, not behind a click. Not a tool row, so "Hide tool calls" leaves it.
    const body = h('div', { class: 'tx-thinking-body tx-md' });
    setMarkdown(body, text);
    row.append(h('span', { class: 'tx-thinking-tag' }, icon(TX_ICON.brain), 'summary'), body);
    return row;
  }

  private toolRow(it: TranscriptItem, scope: string): HTMLElement {
    const t = it.tool as NonNullable<TranscriptItem['tool']>;
    const status = typeof t.status === 'string' ? t.status : 'running';
    const row = h('li', { class: 'tx-item tx-tool', 'data-status': status });
    const dur = h('span', { class: 'tx-tool-dur' });
    if (status === 'running') {
      dur.classList.add('tx-tick');
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
    row.append(head);
    // #70: the images show without opening the row, under its header and outside the lazy body (a thumbnail is its own
    // button, so a click on it opens the lightbox and never toggles the row). With tool calls hidden it is all that shows.
    const images = toolImages(t);
    if (images.length) {
      const n = images.length === 1 ? '1 image' : `${images.length} images`;
      const sum = String(t.input_summary ?? '').trim();
      const strip = this.thumbs.strip(images, `${String(t.name ?? 'tool')}${sum ? `: ${sum}` : ''} — ${n}`);
      strip.classList.add('tx-tool-strip');
      row.append(strip);
    }
    row.append(body);
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
    } else if (!diffs.length && !toolImages(t).length && t.status !== 'running') body.append(h('div', { class: 'tx-note' }, 'No output.'));
    // The images are not repeated here: the row shows them collapsed (toolRow).
    if (t.output_truncated) body.append(h('div', { class: 'tx-note' }, 'Output truncated: only the start is shown.'));
    if (t.status === 'running') body.append(h('div', { class: 'tx-note' }, 'Still running…'));
    const images = toolImages(t).length;
    if (images && !body.childNodes.length) body.append(h('div', { class: 'tx-note' }, images === 1 ? 'No text output: the image is above.' : 'No text output: the images are above.'));
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
      this.subDuration(it, String(s.status ?? '')),
      h('span', { class: 'tx-caret' }, icon(TX_ICON.chevron)),
    );
    body.hidden = !ex.open;
    if (ex.open) this.fillSub(body, agentId, String(s.status ?? ''), key);
    row.append(head, body);
    return row;
  }

  /** #58: a subagent at work shows for how long, as a running tool does (the bottom cue leaves it the say). */
  private subDuration(it: TranscriptItem, status: string): HTMLElement {
    const dur = h('span', { class: 'tx-tool-dur' });
    if (status !== 'running' || !Number.isFinite(it.ts) || it.ts <= 0) return dur;
    dur.classList.add('tx-tick');
    dur.dataset.since = String(it.ts);
    dur.textContent = this.elapsed(it.ts);
    this.tick();
    return dur;
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

  /** Keeps running tools', subagents' and the cue's elapsed time ticking, while there are any. */
  private tick(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      const spans = this.root.querySelectorAll<HTMLElement>('.tx-tick[data-since]');
      if (!spans.length || this.destroyed) {
        if (this.ticker) clearInterval(this.ticker);
        this.ticker = null;
        return;
      }
      for (const s of spans) s.textContent = this.elapsed(Number(s.dataset.since));
      this.renderBusy();
    }, 1000);
  }

  // --- follow mode ---

  private atBottom(): boolean {
    const s = this.scroller;
    return s.scrollHeight - s.scrollTop - s.clientHeight <= 32;
  }

  private onScroll(): void {
    this.following = this.atBottom();
    if (this.following && this.fresh.size) {
      this.fresh.clear();
      this.renderJump();
    }
  }

  private afterChange(added: TranscriptItem[], initial: boolean): void {
    this.updateCounts();
    if (initial || this.following) {
      this.stick(true);
      return;
    }
    for (const it of added) this.fresh.add(it.id);
    // An update can change what an unread row shows too (#70: a hidden Read that finishes with its images).
    if (added.length || this.fresh.size) this.renderJump();
  }

  /**
   * Only what shows counts as new: not system rows unless shown, not tool calls while they are hidden (#59), except a
   * tool call's images, which stay on screen as a bare strip then (#70).
   */
  private shows(it: TranscriptItem): boolean {
    return (this.showSystem || !isSystem(it)) && !(this.prefs.hideTools && isToolRow(it) && !toolHasImages(it));
  }

  /** Back to the bottom when following (content grew, the view resized, code got highlighted). */
  private stick(force = false): void {
    if (this.destroyed || (!force && !this.following)) return;
    this.scroller.scrollTop = this.scroller.scrollHeight;
    this.following = true;
  }

  private toBottom(): void {
    this.stick(true);
    this.fresh.clear();
    this.renderJump();
  }

  private renderJump(): void {
    let n = 0;
    for (const id of this.fresh) {
      const it = this.timeline.get(id);
      if (it && this.shows(it)) n++;
    }
    this.jump.hidden = n === 0;
    this.jump.textContent = n ? `${n} new · jump to latest` : '';
  }

  private updateCounts(): void {
    const n = this.timeline.size;
    const sys = this.timeline.systemCount();
    this.countEl.textContent = n ? `${n - sys} ${n - sys === 1 ? 'entry' : 'entries'}` : '';
    this.sysBtn.textContent = sys ? `Show system (${sys})` : 'Show system';
    if (this.showSystem) this.sysBtn.textContent = sys ? `Hide system (${sys})` : 'Hide system';
    this.empty.hidden = n > 0 || this.pendingRows.length > 0;
    const tools = this.timeline.tools(this.showSystem).length;
    this.toolsCount.textContent = tools ? String(tools) : '';
    this.renderBusy();
  }

  // --- #59: hide tool calls, the preset, the zoom ---

  private applyPrefs(what: ViewPref | null): void {
    if (this.destroyed) return;
    const p = this.prefs;
    const theme = p.theme('transcript');
    const zoom = p.zoom('transcript');
    this.root.dataset.theme = theme;
    for (const b of this.themeBtns) {
      const on = b.dataset.themeId === theme;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    const was = this.root.dataset.tools === 'hidden';
    this.toolsBox.checked = p.hideTools;
    this.root.dataset.tools = p.hideTools ? 'hidden' : 'shown';
    if (was !== p.hideTools) {
      this.failedHidden.clear();
      this.revealed.clear();
      for (const r of this.root.querySelectorAll('.tx-reveal')) r.classList.remove('tx-reveal');
    }
    this.zoomBtns.reset.textContent = `${zoom}%`;
    this.zoomBtns.reset.setAttribute('aria-label', `Text size ${zoom}%${zoom === ZOOM.reset ? '' : ', back to 100%'}`);
    this.zoomBtns.out.disabled = zoom <= ZOOM.min;
    this.zoomBtns.in.disabled = zoom >= ZOOM.max;
    this.renderBusy();
    this.renderJump();
    // New sizes (a zoom, another preset's fonts) move the bottom: a view that followed it keeps following.
    if (what === 'transcriptZoom' || what === 'transcriptTheme' || what === 'hideTools') this.stick();
  }

  private pickTheme(id: ThemeId): void {
    this.prefs.setTheme('transcript', id);
  }

  /** The preset's radio group: ← → (↑ ↓, Home, End) move and pick, as radios do; the timeline's keys stay out. */
  private onPickerKey(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const i = this.themeBtns.findIndex((b) => b.dataset.themeId === this.prefs.theme('transcript'));
    const n = this.themeBtns.length;
    const to = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (i + 1) % n : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    e.stopPropagation();
    const b = this.themeBtns[to] as HTMLButtonElement;
    this.pickTheme(b.dataset.themeId as ThemeId);
    b.focus();
  }

  /**
   * While tool calls are hidden the strip says what they do: the ones that failed since (red, until you look), else
   * the one running now and for how long, so a quiet view does not look stuck.
   */
  private renderBusy(): void {
    if (!this.prefs.hideTools) {
      this.busy.hidden = true;
      return;
    }
    const tools = this.timeline.tools(this.showSystem);
    for (const id of this.failedHidden) if (!tools.some((t) => t.id === id && t.tool?.status === 'error')) this.failedHidden.delete(id);
    const failed = this.failedHidden.size;
    const running = tools.filter((t) => t.tool?.status === 'running' && !this.revealed.has(t.id));
    const last = running.at(-1);
    this.busy.dataset.state = failed ? 'failed' : 'running';
    if (failed) {
      const name = String(tools.find((t) => this.failedHidden.has(t.id))?.tool?.name ?? 'tool');
      this.busy.textContent = failed === 1 ? `${name} failed` : `${failed} tool calls failed`;
      this.busy.title = 'Show the failed tool calls';
    } else if (last) {
      const more = running.length > 1 ? ` +${running.length - 1}` : '';
      this.busy.textContent = `${String(last.tool?.name ?? 'tool')}${more} · ${this.elapsed(last.ts) || 'running'}`;
      this.busy.title = 'A hidden tool call is running: show it';
    }
    this.busy.hidden = !failed && !last;
  }

  /** The chip: shows the hidden rows it speaks of (the failed ones, else the running ones) and goes to the last. */
  private showHiddenTools(): void {
    const tools = this.timeline.tools(this.showSystem);
    const ids = this.failedHidden.size ? [...this.failedHidden] : tools.filter((t) => t.tool?.status === 'running').map((t) => t.id);
    this.failedHidden.clear();
    let last: HTMLElement | undefined;
    for (const id of ids) {
      this.revealed.add(id);
      const row = this.timeline.row(id);
      row?.classList.add('tx-reveal');
      last = row ?? last;
    }
    this.renderBusy();
    if (last) {
      const id = last.dataset.id;
      if (id) this.scrollToItem(id);
    }
  }

  private toggleSystem(): void {
    this.showSystem = !this.showSystem;
    this.timeline.regroup();
    this.root.dataset.system = this.showSystem ? 'shown' : 'hidden';
    this.sysBtn.setAttribute('aria-pressed', String(this.showSystem));
    this.updateCounts();
    this.renderJump();
    this.stick();
  }

  // --- keys and prompt ---

  private scrollBy(dy: number): void {
    this.scroller.scrollTop = Math.max(0, this.scroller.scrollTop + dy);
    this.onScroll();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.target === this.input) return;
    const target = e.target as HTMLElement | null;
    const inCard = !!target && this.ask.el.contains(target);
    const inFollowup = !!target && this.followup.el.contains(target);
    // Ctrl/⌘+Enter sends the pinned card's answers, from the card or from the timeline (the ask's card goes first).
    if (isSendKey(e)) {
      const card = this.ask.shown ? (inFollowup ? null : this.ask) : this.followup.shown ? this.followup : null;
      if (card?.key(e, card === this.ask ? inCard : inFollowup)) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // #57: on the pinned question its keys come first: ↑ ↓ through the options, Esc back to the timeline (not up
    // from the seat); Enter on an option is its click (it picks, never sends).
    if (inCard && this.ask.key(e, true)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // #90: the same on the follow-up card.
    if (inFollowup && this.followup.key(e, true)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // A focused button keeps Enter / Space (it opens its row); the game does not see them.
    if ((e.key === 'Enter' || e.key === ' ') && target?.closest('button, a, summary')) {
      e.stopPropagation();
      return;
    }
    // #57: then, from the timeline, the pinned question's digits, ← →, Enter (to the card).
    if (!inCard && this.ask.shown && this.ask.key(e)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // #90: and the follow-up card's digits and ← → (Tab and Enter stay the page's: the focus, the prompt box).
    if (!inFollowup && !this.ask.shown && this.followup.shown && this.followup.key(e)) {
      e.preventDefault();
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
        const q = this.ask.shown ? null : this.blocked; // the card wins over the screen's question
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
    // terminal), and the text zoom (#59) works from here too; every other key typed here is the prompt's.
    if (e.key === 'Escape' || zoomKey(e)) return;
    e.stopPropagation();
    // Enter sends and Shift+Enter adds a line: the composer's own key handling (submitPolicy 'enter').
  }

  private submit(): void {
    if (this.promptOff || this.sending) return;
    const draft = this.composer.getDraft();
    // A file the box refused stays held until dismissed: the prompt does not go without the picture meant for it.
    const held = heldRefusalText(draft.snapshot(), { nothing: 'sent', again: 'send' });
    if (held) {
      this.composer.notice(held, 'error');
      return;
    }
    if (!hasContent(draft.snapshot())) return;
    this.sending = true;
    this.composer.setBusy(true);
    // #58: your own send brings you to the bottom, where its row goes, and follows from there.
    this.toBottom();
    void this.send(draft);
  }

  /**
   * The images first (waited for, the box read-only meanwhile; one that did not upload stops it, its chip has the
   * Retry), then the prompt. Not sent (refused, too long, an image failed): the box keeps what was written.
   */
  private async send(draft: PromptDraft): Promise<void> {
    const r = await draft.resolve({ maxBytes: WORKER_PROMPT_MAX_BYTES });
    if (this.destroyed) return;
    if (!r.ok) {
      this.sending = false;
      this.composer.setBusy(false);
      const why = notSentText(r, { nothing: 'sent', again: 'send' });
      if (why) this.composer.notice(why, 'error');
      return;
    }
    this.composer.clearNotice();
    const sent = await Promise.resolve(this.host.onPromptSubmit(r.text)).catch(() => false);
    if (this.destroyed) return;
    this.sending = false;
    this.composer.setBusy(false);
    // Sent: the box is empty again (an edit made meanwhile is impossible while it is read-only, but a draft swap is not).
    if (sent !== false) draft.clearIf(r.revision);
  }

  // --- blocked banner ---

  private renderBanner(): void {
    const asking = this.ask.shown;
    this.asking = asking;
    const q = asking ? null : this.blocked;
    // A blocked worker takes no prompt (the bridge refuses it): answer above, or in the terminal. A draft stays.
    // Disabling the focused box or button would drop the keyboard on <body>, out of reach of the reply digits and
    // scroll keys: it goes to the timeline instead, once, as the question arrives (a disabled control never has focus
    // later, so re-renders leave focus alone).
    const a = document.activeElement;
    const waiting = !!q || asking;
    if (waiting && (this.input.contains(a) || a === this.sendBtn)) this.scroller.focus({ preventScroll: true });
    this.promptOff = waiting;
    this.composer.setDisabled(waiting);
    // A very short screen gives the card the prompt box's room while it is up (transcript.css).
    this.root.toggleAttribute('data-asking', asking);
    this.composer.setPlaceholder(asking
      ? 'Answer the question above first (or in the terminal)'
      : q
        ? 'Waiting for an answer to the question above (or switch to the terminal)'
        : PROMPT_HINT,
    );
    this.sendBtn.disabled = waiting;
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
