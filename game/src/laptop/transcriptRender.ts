import './transcript.css';
import DOMPurify, { type Config, type DOMPurify as Purifier } from 'dompurify';
import { Marked } from 'marked';
import type { Ask, CommandArgs, Followup, TranscriptChanges, TranscriptDiff, TranscriptItem, Usage, WorkerCodex } from '../net/protocol';
import { AskCard, askItem, type AskResult } from './askCard';
import { AsyncCard, type AsyncResult } from './asyncCard';
import { AsyncDrafts } from './asyncDrafts';
import { isSendKey, reveal } from './askStack';
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
import { commandSource, type CommandList } from './slashCommands';
import { fileSource, type FileSearchHost } from './fileSearch';
import { SendGate } from './transcriptDrafts';
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
  /** #157: answers a Codex worker's async questions (none: the card cannot send). */
  onAnswerAsync?(args: CommandArgs['worker.answer_async']): Promise<AsyncResult>;
  /** #157: hides them in the bridge. */
  onDismissAsync?(args: CommandArgs['worker.dismiss_async']): Promise<AsyncResult>;
  /** #157: what you wrote for them, kept by the host across views (none: this view's own, which goes with it). */
  asyncDrafts?: AsyncDrafts;
  onSwitchToTerminal(): void;
  loadSubagent(agentId: string): Promise<TranscriptItem[]>;
  /**
   * #171: one item in full (`transcript.item`; `agent`: of that subagent's timeline), for a change the list cut. None: the
   * cut change says so and offers nothing.
   */
  loadItem?(itemId: string, agent?: string): Promise<TranscriptItem | null>;
  /** #58: a refused prompt's row is dismissed. */
  onDismissPending?(id: string): void;
  /** A queued prompt should go now: the host presses Esc (both CLIs stop the turn and send what is queued; none: no link). */
  onSendNow?(id: string): void;
  /** #59: the transcript's preset and zoom and hidden tool calls, shared by every view (none: this view's own, kept nowhere). */
  prefs?: ViewPrefs;
  /** #101: the worker's usage when the view opens, for its context meter (`setUsage` follows it; none: no meter yet). */
  usage?: Usage | null;
  /** #140: the worker's slash commands and skills, for the prompt box's `/` popup, and its harness (none: no popup). */
  commands?: { list: CommandList; harness: string } | null;
  /**
   * #141: the worker's unsent prompt, kept by the host across views (`TranscriptDrafts`): the view shows it and leaves
   * it alone when it goes. None: the view makes its own, which goes with it.
   */
  draft?: PromptDraft;
  /**
   * #141: whether a prompt from that draft is on its way, kept with it: a view made meanwhile is busy until it is
   * answered and sends nothing. None: the view keeps its own.
   */
  sending?: SendGate;
  /** #141: the worker's checkout, for the prompt box's `@` file search (none: no popup). */
  files?: { id: string; search: FileSearchHost } | null;
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
  /**
   * #157: the worker's Codex launch (null: none): its async questions, on a card above the prompt box, which stays on;
   * `working`: the worker works on (its effective status, not a real block), the card's "still working".
   */
  setCodex(worker: string, codex: WorkerCodex | null, working: boolean): void;
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

/** #157: the two pinned cards that share the room below the timeline (the ask's goes over both). */
type PinnedCard = 'followup' | 'asyncq';
/** Ids for the cards the tabs control (one transcript per seat, but each mount anew). */
let cardIds = 0;
/** #157: a screen this short (a phone's laptop) has no room for a pinned card beside the timeline (`fit()`). */
const SHORT_SCREEN = 300;
/** #157: the least room a pinned card's questions keep beside the timeline (a question and an answer): less, it takes the timeline's. */
const QUESTION_ROOM = 64;

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

/** #171: a Claude Bash call's recorded changes beyond its diffs (null: none sent, or not an object). */
function toolChanges(t: NonNullable<TranscriptItem['tool']>): TranscriptChanges | null {
  const c = t.changes;
  return c && typeof c === 'object' ? c : null;
}

/** #171: the changed files a record lists without a diff (strings only). */
const undiffed = (c: TranscriptChanges | null): string[] => (c && Array.isArray(c.paths) ? c.paths.filter((p): p is string => typeof p === 'string' && p !== '') : []);
const moreFiles = (c: TranscriptChanges | null): number => (c && typeof c.more_files === 'number' && Number.isFinite(c.more_files) && c.more_files > 0 ? Math.floor(c.more_files) : 0);

/**
 * #171: whether a record says something worth a line on its own: files changed without a diff, or that it is incomplete or
 * was not taken. `shared` alone (no changes listed) says nothing about this call's changes, so it does not.
 */
const changesSay = (c: TranscriptChanges | null): boolean => !!c && (undiffed(c).length > 0 || moreFiles(c) > 0 || c.unavailable === true || c.skipped === true);

/** #171: what became of a call's changes, from its status. A running call's diffs are its input's (a Codex patch): not applied yet. */
type ChangeState = 'proposed' | 'applied' | 'failed' | 'denied' | 'partial';
function changeState(status: string): ChangeState {
  if (status === 'running') return 'proposed';
  if (status === 'ok') return 'applied';
  if (status === 'denied') return 'denied';
  if (status === 'interrupted') return 'partial';
  return 'failed';
}

const CHANGE_STATE_TEXT: Record<ChangeState, string> = {
  proposed: 'Proposed: not applied yet.',
  applied: '',
  failed: 'The call failed: these changes may not have been applied, or only in part.',
  denied: 'Denied: not applied.',
  partial: 'Interrupted: these changes may be only partly applied.',
};

/** #171: the file's fate where the source says (an edit is the usual case: no tag). */
const OP_TAG: Record<string, string> = { create: 'new', delete: 'deleted', overwrite: 'overwritten' };

const STATUS_TEXT: Record<string, string> = { running: 'running', ok: 'done', error: 'error', interrupted: 'interrupted', denied: 'denied' };

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

const statEl = (add: number, del: number) => h('span', { class: 'tx-diff-stat' }, h('span', { class: 'tx-add-n' }, `+${add}`), ' ', h('span', { class: 'tx-del-n' }, `−${del}`));

/** A diff's lines as a unified view with line numbers (at most MAX_DIFF_LINES of them, then a note). */
function diffLines(diff: TranscriptDiff): HTMLElement {
  const hunks = Array.isArray(diff.hunks) ? diff.hunks : [];
  const box = h('div', { class: 'tx-diff-lines' });
  const body = h('div', { class: 'tx-diff-body', role: 'table', 'aria-label': `Changes to ${String(diff.path ?? '')}` });
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
  if (total > shown) box.append(h('div', { class: 'tx-note' }, `${total - shown} more diff lines not shown (the view draws ${MAX_DIFF_LINES.toLocaleString('en')} per file)`));
  return box;
}

// ---------------------------------------------------------------------------------------------------------------
// The view

/** Shown only with "show system": what the bridge marks hidden (dropped lines, as notices) and unknown entries. A notice
 * it does not hide (an interrupt, a turn's error, command output) is part of the conversation. */
/** #183: a usable `answers` list (the bridge's, but a malformed entry falls back to the plain bubble, never throws). */
const isAnswers = (a: unknown): a is Array<{ question: string; answer: string }> =>
  Array.isArray(a) && a.length > 0 && a.every((e) => !!e && typeof e === 'object' && typeof (e as { question?: unknown }).question === 'string' && typeof (e as { answer?: unknown }).answer === 'string');
const isSystem = (it: TranscriptItem) => it.hidden === true || it.kind === 'unknown';
/** #59: what "Hide tool calls" hides: tool rows (not subagents, not an agent's question, which is part of the conversation). */
export const isToolRow = (it: TranscriptItem) => it.kind === 'tool' && !!it.tool && !(it.tool.ask && typeof it.tool.ask === 'object' && Array.isArray(it.tool.ask.questions));
/** #70: a tool row with images (a Read of a PNG, a screenshot, a `view_image`): its strip shows collapsed, and stays when tool calls are hidden. */
export const toolHasImages = (it: TranscriptItem) => isToolRow(it) && toolImages(it.tool as NonNullable<TranscriptItem['tool']>).length > 0;
/**
 * #171: a tool row with code changes (diffs, or a record of files changed without one): they show under its header, and stay
 * when tool calls are hidden, as #70's images do.
 */
export const toolHasChanges = (it: TranscriptItem) => {
  if (!isToolRow(it)) return false;
  const t = it.tool as NonNullable<TranscriptItem['tool']>;
  return toolDiffs(t).length > 0 || changesSay(toolChanges(t));
};
/** #59/#70/#171: what still shows of a tool row while tool calls are hidden (its images, its changes). */
const keepsWhenHidden = (it: TranscriptItem) => toolHasImages(it) || toolHasChanges(it);
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
  /** #171: show code changes (diffs open), and each changed file opened or closed by hand since (key: scope/id#index). */
  private readonly changesBox: HTMLInputElement;
  private readonly fileOpen = new Map<string, boolean>();
  /** #171: each changed file shown: what opens or closes it (its row may be rebuilt: the map holds the one shown now). */
  private readonly fileSet = new WeakMap<HTMLElement, (open: boolean) => void>();
  /** #171: changes loaded in full (`transcript.item`) after the list cut them, by agent/id. */
  private readonly fullDiffs = new Map<string, TranscriptDiff[]>();
  /** The subagent each nested timeline's scope shows (for `transcript.item` with `agent`). */
  private readonly scopeAgent = new Map<string, string>();
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
  /** A prompt is on its way (uploading, then sent): the box is read-only until it is answered (#141: in any view of it). */
  private readonly sending: SendGate;
  private readonly offSending: () => void;
  private readonly empty: HTMLDivElement;

  private following = true;
  /** Rows that came in while you were scrolled up; the chip counts the ones that show (#59: recounted on each toggle). */
  private readonly fresh = new Set<string>();
  private showSystem = false;
  private readonly thumbs: Thumbs;
  private blocked: BlockedQuestion | null = null;
  private readonly ask: AskCard;
  private readonly followup: FollowupCard; // #90
  private readonly asyncq: AsyncCard; // #157
  /**
   * #157: the follow-up's card and the async questions' both up (an idle Codex worker keeps the questions its last turn
   * asked): one is open, the other one tab away, so the open one has the room (a phone's screen has none for two).
   */
  private readonly cardTabs: HTMLElement;
  private readonly tabs: Record<PinnedCard, HTMLButtonElement>;
  /** Which of the two is open while both are up (the one that was up first stays; both at once: the follow-up). */
  private front: PinnedCard | null = null;
  /** The timeline's box (the scroller and the jump chip) and the prompt box: what `fit()` measures. */
  private readonly main: HTMLDivElement;
  private readonly form: HTMLDivElement;
  /** #157: the transcript's size when `fit()` last ran (another one puts the keyboard's place in a card back in sight). */
  private fitted = '';
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
  /** #58: after the timeline, the prompts on their way and the live cue; each has its own polite live region. */
  private readonly pendingList: HTMLOListElement;
  private readonly pendingEls = new Map<string, { key: string; el: HTMLElement }>();
  private pendingRows: readonly PendingPrompt[] = [];
  private readonly tail: HTMLDivElement;
  private activity: ActivityCue | null = null;
  private activityRow: HTMLElement | null = null;
  private readonly live: HTMLDivElement;
  private readonly pendingLive: HTMLDivElement;
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
    this.pendingLive = h('div', { class: 'tx-pending-live', role: 'status', 'aria-live': 'polite' });
    this.scroller = h('div', { class: 'tx-scroll', tabindex: '-1', 'aria-label': 'Conversation' }, this.empty, this.timeline.el, this.tail);
    this.thumbs = new Thumbs({ feed: host.images, root: this.scroller });
    this.jump = h('button', { class: 'tx-jump', hidden: true, onclick: () => this.toBottom() });
    this.composer = mountComposer({
      draft: host.draft ?? new PromptDraft({ upload: host.upload ?? NO_UPLOAD, label: `transcript-${host.label ?? 'worker'}`, maxPromptBytes: WORKER_PROMPT_MAX_BYTES, holdRefused: true }),
      ariaLabel: 'Prompt',
      placeholder: PROMPT_HINT,
      submitPolicy: 'enter',
      onSubmit: () => this.submit(),
      // #139: completion is on; #140: `/` lists the worker's commands and skills, #141: `@` its files (only here: no
      // other composer has them).
      complete: {
        sources: [...(host.commands ? [commandSource(host.commands.list, host.commands.harness)] : []), ...(host.files ? [fileSource(host.files.id, host.files.search)] : [])],
        bounds: () => this.root,
      },
    });
    this.input = this.composer.editor;
    this.input.classList.add('tx-input');
    // #141: a send from an earlier view of this draft may still be on its way: busy until it is answered.
    this.sending = host.sending ?? new SendGate();
    this.offSending = this.sending.subscribe(() => this.composer.setBusy(this.sending.busy));
    if (this.sending.busy) this.composer.setBusy(true);
    this.sendBtn = h('button', { class: 'tx-send', title: 'Send', onclick: () => this.submit() }, 'Send');
    this.form = h('div', { class: 'tx-prompt' }, this.composer.element, this.sendBtn);
    this.ask = new AskCard({
      answer: (args) => host.onAnswerAsk(args),
      toTerminal: () => host.onSwitchToTerminal(),
      focusTimeline: () => this.focus(),
      resized: () => {
        this.stick();
        // Shown or gone (also by itself, once its answer is recorded): the prompt box follows.
        if (this.asking !== this.ask.shown) this.renderBanner();
        // #90: the follow-up card waits behind a question's; #157: so does the async questions'.
        this.followup?.suppress(this.ask.shown);
        this.asyncq?.suppress(this.ask.shown);
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
        this.syncCards();
        this.stick();
      },
    });
    const noAsync = (): Promise<AsyncResult> => Promise.resolve({ ok: false, code: 'unsupported', message: 'Not available here.' });
    this.asyncq = new AsyncCard({
      answer: (args) => (host.onAnswerAsync ? host.onAnswerAsync(args) : noAsync()),
      dismiss: (args) => (host.onDismissAsync ? host.onDismissAsync(args) : noAsync()),
      toTerminal: () => host.onSwitchToTerminal(),
      focusTimeline: () => this.focus(),
      drafts: host.asyncDrafts ?? new AsyncDrafts(null),
      resized: () => {
        // A very short screen gives the card the timeline's room while it is up (transcript.css), as the follow-up's.
        this.root?.toggleAttribute('data-asyncq', this.asyncq.shown);
        this.syncCards();
        this.stick();
      },
    });
    const tab = (k: PinnedCard, name: string, title: string, card: HTMLElement) => {
      card.id = `tx-${k}-${++cardIds}`;
      return h(
        'button',
        { class: 'tx-qtab', role: 'tab', 'data-card': k, 'aria-selected': 'false', 'aria-controls': card.id, tabindex: '-1', title, onclick: () => this.pickCard(k, true) },
        h('span', { class: 'tx-qtab-name' }, name),
        h('span', { class: 'tx-qtab-n' }),
      );
    };
    this.tabs = {
      followup: tab('followup', 'Open questions', 'The open questions in the agent’s last message', this.followup.el),
      asyncq: tab('asyncq', 'Codex asked', 'The questions Codex asked while it worked', this.asyncq.el),
    };
    this.cardTabs = h('div', { class: 'tx-qtabs', role: 'tablist', 'aria-label': 'Questions for you', hidden: true }, this.tabs.followup, this.tabs.asyncq);
    // The toggle sits on the left: the HUD's plan-limits widget can hang over the screen's top-right corner.
    this.titleEl = h('span', { class: 'tx-title' }, 'Transcript');
    // #59: hide tool calls, the working chip, the preset and the zoom. The preset's swatch is drawn in its colours only:
    // naming it in its own fonts would fetch them for every preset (they load when picked).
    this.prefs = host.prefs ?? new ViewPrefs(null);
    this.toolsBox = h('input', { type: 'checkbox', class: 'tx-check-box', onchange: () => (this.prefs.hideTools = this.toolsBox.checked) });
    this.toolsCount = h('span', { class: 'tx-check-n' });
    const tools = h('label', { class: 'tx-check', title: 'Hide tool calls (subagents, questions, images and code changes stay)' }, this.toolsBox, h('span', {}, 'Hide tools'), this.toolsCount);
    // #171: on by default; off, each changed file is one line (path and counts) you can still open.
    this.changesBox = h('input', { type: 'checkbox', class: 'tx-chg-box', onchange: () => (this.prefs.showChanges = this.changesBox.checked) });
    const changes = h('label', { class: 'tx-check tx-check-changes', title: 'Show code changes: the diff of each file the agent changed (off: one line per file)' }, this.changesBox, h('span', { class: 'tx-check-ic', 'aria-hidden': 'true' }, icon(TX_ICON.edit)), h('span', {}, 'Code changes'));
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
    const bar = h('div', { class: 'tx-bar' }, this.titleEl, this.countEl, this.sysBtn, tools, changes, this.busy, this.ctxEl, h('div', { class: 'tx-look' }, picker, zoom));
    this.main = h('div', { class: 'tx-main' }, this.scroller, this.jump);
    this.root = h('div', { class: 'tx', 'data-system': 'hidden', 'data-tools': 'shown', 'data-changes': 'shown' }, bar, this.banner, this.main, this.ask.el, this.cardTabs, this.followup.el, this.asyncq.el, this.asyncq.live, this.form, this.pendingLive, this.live);
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
      this.resize = new ResizeObserver((seen) => {
        // #157: the screen's size (the window resized) fits a pinned card to it first. The view's own size is its
        // screen's whatever it holds, so what fit() changes inside never calls this again for the root.
        if (seen.some((e) => e.target === this.root)) this.fit();
        this.stick();
      });
      this.resize.observe(this.root);
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
    if (this.prefs.hideTools) for (const t of this.currentTurnTools()) if (t.tool?.status === 'error' && !wasFailed.has(t.id) && !toolHasChanges(t)) this.failedHidden.add(t.id);
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
    // #171: one whose changes stay on screen says so itself.
    if (this.prefs.hideTools) for (const it of items) if (isItem(it) && isToolRow(it) && it.tool?.status === 'error' && !toolHasChanges(it) && (this.showSystem || !isSystem(it))) this.failedHidden.add(it.id);
    const added = this.timeline.apply(items);
    this.afterChange(added, false);
  }

  setBlocked(q: BlockedQuestion | null): void {
    if (this.destroyed) return;
    this.blocked = q && typeof q === 'object' ? q : null;
    this.renderBanner();
    this.fit(); // the banner takes room too
  }

  setAsk(ask: Ask | null): void {
    if (this.destroyed) return;
    // The card wins over the screen's question: it has the whole question, the descriptions and multi-select
    // (the banner and the prompt box are redrawn when it shows or goes, through its resized()).
    this.ask.set(ask);
    this.followup.suppress(this.ask.shown);
    this.asyncq.suppress(this.ask.shown);
  }

  setFollowup(f: Followup | null): void {
    if (this.destroyed) return;
    this.followup.set(f);
  }

  /** #157: the worker's Codex launch, and whether it works on (its effective status: the card's "still working"). */
  setCodex(worker: string, codex: WorkerCodex | null, working: boolean): void {
    if (this.destroyed) return;
    this.asyncq.set(worker, codex, working);
  }

  /** #157: the pinned card the timeline's keys go to after the ask's: the follow-up's or the async questions', the open one. */
  private pinned(): FollowupCard | AsyncCard | null {
    const fu = this.followup.shown;
    const aq = this.asyncq.shown;
    if (fu && aq) return this.front === 'asyncq' ? this.asyncq : this.followup;
    return fu ? this.followup : aq ? this.asyncq : null;
  }

  /** #157: with both cards up, the open one shows and the other waits behind its tab (its picks and text kept). */
  private syncCards(): void {
    if (!this.root) return; // a card drawn while the view is built
    const fu = this.followup.shown;
    const aq = this.asyncq.shown;
    if (fu !== aq) this.front = fu ? 'followup' : 'asyncq';
    else if (fu) this.front ??= 'followup';
    else if (!this.ask.shown) this.front = null; // both gone (not just behind an ask): the next pair starts afresh
    const both = fu && aq;
    this.cardTabs.hidden = !both;
    if (both && this.front) this.root.dataset.front = this.front;
    else delete this.root.dataset.front;
    const counts: Record<PinnedCard, number> = { followup: this.followup.count, asyncq: this.asyncq.toAnswer };
    for (const k of ['followup', 'asyncq'] as const) {
      const t = this.tabs[k];
      const on = both && this.front === k;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      const n = t.querySelector<HTMLElement>('.tx-qtab-n');
      if (n) {
        n.textContent = counts[k] ? String(counts[k]) : '';
        n.hidden = !counts[k];
      }
    }
    this.fit();
  }

  /**
   * #157: the open pinned card (the follow-up's, or the async questions') takes the timeline's room, the top strip's
   * and half the prompt box's (`data-tight`, transcript.css) when it does not fit beside them: always on a very short
   * screen (a phone's), and otherwise whenever the layout without it leaves the conversation less than a line, pushes
   * the prompt box off the screen, or squeezes the card's questions under QUESTION_ROOM. No height says that (the strip
   * wraps to two rows on a narrower screen, the zoom grows the card but not the strip, two cards bring their tabs), so
   * it is measured, on the layout without it: the answer never depends on itself, nothing goes back and forth. A new
   * size, or the other layout, puts the keyboard's place in a card back in sight.
   */
  private fit(): void {
    const root = this.root;
    if (!root || this.destroyed) return;
    const height = root.clientHeight;
    if (!height) return; // not laid out: a screen not shown (the terminal is up), a test's DOM
    const card = this.pinned()?.el ?? null;
    const was = root.hasAttribute('data-tight');
    let tight = !!card && height <= SHORT_SCREEN;
    if (card && !tight) {
      // Drawn without it for a moment (no frame shows it); the scroll positions it would clamp are put back.
      const kept = [card, this.scroller].map((e) => [e, e.scrollTop] as const);
      root.removeAttribute('data-tight');
      tight = !this.fitsBeside(card);
      if (tight) {
        root.setAttribute('data-tight', '');
        if (was) for (const [e, top] of kept) e.scrollTop = top;
      }
    }
    root.toggleAttribute('data-tight', tight);
    const size = `${root.clientWidth}x${height}`;
    if (tight !== was || size !== this.fitted) {
      const a = document.activeElement;
      if (a instanceof HTMLElement && root.contains(a) && a.closest('.tx-fu, .tx-aq, .tx-ask')) reveal(a);
    }
    this.fitted = size;
  }

  /** As laid out now: a line of the conversation, the prompt box on the screen, and the card's questions their room. */
  private fitsBeside(card: HTMLElement): boolean {
    if (this.form.getBoundingClientRect().bottom > this.root.getBoundingClientRect().bottom + 0.5) return false;
    const s = getComputedStyle(this.scroller);
    const line = parseFloat(s.lineHeight) || 1.5 * parseFloat(s.fontSize);
    if (this.main.getBoundingClientRect().height < parseFloat(s.paddingTop) + parseFloat(s.paddingBottom) + line) return false;
    const body = card.querySelector<HTMLElement>('.tx-ask-body');
    return !body || body.clientHeight >= QUESTION_ROOM || body.scrollHeight <= body.clientHeight + 1;
  }

  /** #157: opens card k of the two (a click, Enter: the keyboard on it; ← → on the tabs: the keyboard stays there). */
  private pickCard(k: PinnedCard, into: boolean): void {
    if (!this.followup.shown || !this.asyncq.shown) return;
    this.front = k;
    this.syncCards();
    if (into) (k === 'followup' ? this.followup : this.asyncq).focus();
    else this.tabs[k].focus({ preventScroll: true });
    this.stick();
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
    // A status event can render a cue before the prompt ack: neither announcement overwrites the other.
    if (say) this.pendingLive.textContent = say;
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
    this.asyncq.destroy();
    // The composer's own draft goes with the view: its uploads are cancelled, its object URLs revoked. The host's
    // (#141) stays for the next view of this worker.
    this.offSending();
    this.composer.dispose();
    if (!this.host.draft) this.composer.getDraft().dispose();
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
    if (toolHasChanges(it)) row.classList.add('tx-toolchg');
    if (isToolRow(it) && this.revealed.has(it.id)) row.classList.add('tx-reveal');
    const t = clock(it.ts);
    if (t && !row.title) row.title = t;
    return row;
  }

  private build(it: TranscriptItem, scope: string): HTMLElement {
    switch (it.kind) {
      case 'user':
        if (isAnswers(it.answers)) return this.answerRow(it, it.answers);
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

  /**
   * #183: your answer to a Codex async question, in your bubble: a small label, each question as context and the answer
   * as the entry. Plain text (an answer's `<b>` or `**x**` is what you typed), several answers in order. Neutral: it says
   * what you answered, not that Codex read it. The native envelope (`parts`) is behind a collapsed "Raw reply".
   */
  private answerRow(it: TranscriptItem, answers: ReadonlyArray<{ question: string; answer: string }>): HTMLElement {
    const pairs = answers.map((a) => h('div', { class: 'tx-ans-pair' }, a.question.trim() ? h('div', { class: 'tx-ans-q' }, a.question) : null, h('div', { class: 'tx-ans-a' }, a.answer)));
    const raw = (Array.isArray(it.parts) ? it.parts : []).map((p) => (p && typeof p === 'object' && 'text' in p && typeof p.text === 'string' ? p.text : '')).join('');
    const bubble = h('div', { class: 'tx-bubble tx-ans' }, h('div', { class: 'tx-ans-label' }, 'Your answer'), ...pairs);
    if (raw) bubble.append(h('details', { class: 'tx-ans-raw' }, h('summary', {}, 'Raw reply'), h('pre', {}, raw)));
    if (it.truncated) bubble.append(h('div', { class: 'tx-note' }, 'Truncated: only the start is shown.'));
    return h('li', { class: 'tx-item tx-user tx-answer' }, bubble);
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
    const diffs = this.diffsOf(it, t, scope);
    // A file recorded without lines (no_diff) counts nothing: no "+0 −0" for an overwrite whose lines are unknown.
    const counted = diffs.filter((d) => d.no_diff !== true);
    const stat = counted.length ? counted.map((d) => diffStat(d.hunks)).reduce((a, b) => ({ add: a.add + b.add, del: a.del + b.del })) : null;
    const head = h(
      'button',
      { class: 'tx-tool-row', 'aria-expanded': 'false' },
      h('span', { class: 'tx-tool-icon' }, icon(toolIcon(String(t.name ?? '')))),
      h('span', { class: 'tx-tool-name' }, String(t.name ?? 'tool')),
      h('span', { class: 'tx-tool-sum' }, String(t.input_summary ?? '')),
      stat ? statEl(stat.add, stat.del) : null,
      h('span', { class: 'tx-tool-status' }, STATUS_TEXT[status] ?? status),
      dur,
      h('span', { class: 'tx-caret' }, icon(TX_ICON.chevron)),
    );
    const body = h('div', { class: 'tx-tool-body' });
    const ex = this.expander(`${scope}/${it.id}`, (open) => {
      if (open && !body.childNodes.length) this.fillTool(body, t, diffs.length > 0);
      body.hidden = !open;
    });
    head.setAttribute('aria-expanded', String(ex.open));
    head.addEventListener('click', () => ex.toggle(head));
    body.hidden = !ex.open;
    if (ex.open) this.fillTool(body, t, diffs.length > 0);
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
    // #171: the code changes show without opening the row too (raw input and output stay in the body).
    const changes = this.changesBlock(it, t, scope, diffs, status);
    if (changes) row.append(changes);
    row.append(body);
    return row;
  }

  /** A tool's diffs: the full ones if they were loaded (#171), else what the list sent. */
  private diffsOf(it: TranscriptItem, t: NonNullable<TranscriptItem['tool']>, scope: string): TranscriptDiff[] {
    return this.fullDiffs.get(this.fullKey(it, scope)) ?? toolDiffs(t);
  }

  private fullKey(it: TranscriptItem, scope: string): string {
    return `${this.scopeAgent.get(scope) ?? ''}/${it.id}`;
  }

  /**
   * #171: a call's code changes, under its header: a line for what became of them unless applied, each changed file (its
   * path, what happened to it, its counts, then its diff: open while "Code changes" is on, one click away otherwise), and
   * what the record says beyond its diffs (files changed without one, incomplete, not taken, maybe another command's).
   * Null: nothing to show (a Bash with no record is unknown, not "no changes").
   */
  private changesBlock(it: TranscriptItem, t: NonNullable<TranscriptItem['tool']>, scope: string, diffs: TranscriptDiff[], status: string): HTMLElement | null {
    const c = toolChanges(t);
    if (!diffs.length && !changesSay(c)) return null;
    const state = changeState(status);
    const box = h('div', { class: 'tx-changes', 'data-state': state, role: 'group', 'aria-label': `Code changes: ${String(t.name ?? 'tool')}` });
    if (CHANGE_STATE_TEXT[state]) box.append(h('div', { class: 'tx-chg-state' }, CHANGE_STATE_TEXT[state]));
    const load = this.host.loadItem && diffs.some((d) => d.truncated === true) ? () => this.loadFull(it, t, scope, status, box) : null;
    diffs.forEach((d, i) => box.append(this.changeFile(d, `${scope}/${it.id}#${i}`, load)));
    if (c) {
      const paths = undiffed(c);
      const more = Math.max(moreFiles(c), paths.length);
      if (more > 0) {
        const n = `${more} ${more === 1 ? 'file' : 'files'}`;
        const text = diffs.length ? `${n} more changed, no diff recorded` : `${n} changed, no diff recorded`;
        if (paths.length) {
          const unlisted = more - paths.length;
          const list = h('ul', { class: 'tx-chg-paths' }, ...paths.map((p) => h('li', {}, p)));
          box.append(h('details', { class: 'tx-chg-more' }, h('summary', {}, text), list, unlisted > 0 ? h('div', { class: 'tx-note' }, `and ${unlisted} not listed`) : null));
        } else box.append(h('div', { class: 'tx-chg-note' }, text));
      }
      if (c.skipped === true) box.append(h('div', { class: 'tx-chg-note' }, 'No diff taken: this command moves the working tree (like git checkout or git stash).'));
      if (c.unavailable === true) box.append(h('div', { class: 'tx-chg-note' }, diffs.length || more ? 'Incomplete: Claude Code could not record all of this command’s changes.' : 'Not recorded: Claude Code could not take this command’s changes.'));
      // Only of changes it lists: with none, another command's work says nothing about this one.
      if (c.shared === true && (diffs.length || more)) box.append(h('div', { class: 'tx-chg-note' }, 'Another command ran in this repository at the same time: some of these changes may be its.'));
    }
    return box;
  }

  /** #171: one changed file: a header (path, what happened, counts) that opens and closes its diff. */
  private changeFile(d: TranscriptDiff, key: string, load: (() => void) | null): HTMLElement {
    const hunks = Array.isArray(d.hunks) ? d.hunks : [];
    const { add, del } = diffStat(hunks);
    const op = typeof d.op === 'string' ? OP_TAG[d.op] : undefined;
    const path = String(d.path ?? '');
    const head = h(
      'button',
      { class: 'tx-chg-head', title: path },
      h('span', { class: 'tx-caret' }, icon(TX_ICON.chevron)),
      h('span', { class: 'tx-diff-path' }, path),
      op ? h('span', { class: 'tx-chg-op', 'data-op': String(d.op) }, op) : null,
      d.no_diff === true ? h('span', { class: 'tx-chg-op' }, 'no diff') : statEl(add, del),
      d.truncated === true ? h('span', { class: 'tx-chg-op tx-chg-cut', title: 'Cut to fit the list: counts are of the lines shown' }, 'cut') : null,
    );
    const body = h('div', { class: 'tx-chg-body' });
    const file = h('div', { class: 'tx-diff tx-chg-file', 'data-key': key, 'data-op': typeof d.op === 'string' ? d.op : '' }, head, body);
    const set = (open: boolean) => {
      head.setAttribute('aria-expanded', String(open));
      body.hidden = !open;
      if (!open || body.childNodes.length) return;
      // Drawn on first open: a long history of changes shown closed costs nothing.
      if (d.no_diff === true) body.append(h('div', { class: 'tx-chg-note' }, 'No diff recorded: Claude Code keeps none when nothing changed, the old file was too large, or the diff timed out.'));
      else if (!hunks.length) body.append(h('div', { class: 'tx-chg-note' }, d.op === 'create' ? 'Empty file.' : d.op === 'delete' ? 'The file was empty.' : 'No lines recorded.'));
      else body.append(diffLines(d));
      if (d.truncated === true) {
        const note = h('div', { class: 'tx-chg-note tx-chg-cutnote' }, 'Cut to fit the list: only the start is shown.');
        if (load) note.append(h('span', { class: 'tx-chg-load' }, ' ', h('button', { class: 'tx-link', onclick: load }, 'Show the whole change')));
        body.append(note);
      }
    };
    head.addEventListener('click', () => {
      const open = head.getAttribute('aria-expanded') !== 'true';
      this.fileOpen.set(key, open);
      set(open);
    });
    this.fileSet.set(file, set);
    set(this.fileOpen.get(key) ?? this.prefs.showChanges);
    return file;
  }

  /** #171: the item in full, for a change the list cut; its changes are drawn again where they are (the row stays). */
  private loadFull(it: TranscriptItem, t: NonNullable<TranscriptItem['tool']>, scope: string, status: string, box: HTMLElement): void {
    const load = this.host.loadItem;
    if (!load) return;
    for (const b of box.querySelectorAll<HTMLButtonElement>('.tx-chg-cutnote .tx-link')) {
      b.disabled = true;
      b.textContent = 'Loading…';
    }
    const agent = this.scopeAgent.get(scope);
    let p: Promise<TranscriptItem | null>;
    try {
      p = Promise.resolve(load(it.id, agent));
    } catch (e) {
      p = Promise.reject(e);
    }
    const fail = (why: string) => {
      for (const n of box.querySelectorAll('.tx-chg-load')) n.replaceWith(' ', h('span', { class: 'tx-err' }, why));
    };
    p.then(
      (full) => {
        if (this.destroyed) return;
        const diffs = full?.tool ? toolDiffs(full.tool) : [];
        if (!diffs.length) return fail('The whole change could not be loaded.');
        this.fullDiffs.set(this.fullKey(it, scope), diffs);
        const next = this.changesBlock(it, t, scope, diffs, status);
        if (next && box.isConnected) box.replaceWith(next);
      },
      (e: unknown) => {
        if (!this.destroyed) fail(`The whole change could not be loaded: ${e instanceof Error ? e.message : String(e ?? 'failed')}`);
      },
    );
  }

  private fillTool(body: HTMLElement, t: NonNullable<TranscriptItem['tool']>, hasDiffs: boolean): void {
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
    // #171: the diffs are not here: the row shows them (changesBlock).
    if (typeof t.output_text === 'string' && t.output_text.length) {
      body.append(h('div', { class: 'tx-label' }, 'Output'), h('pre', { class: 'tx-out' }, stripAnsi(t.output_text)));
    } else if (!hasDiffs && !toolImages(t).length && t.status !== 'running') body.append(h('div', { class: 'tx-note' }, 'No output.'));
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
      this.scopeAgent.set(`${key}>`, agentId);
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
    return (this.showSystem || !isSystem(it)) && !(this.prefs.hideTools && isToolRow(it) && !keepsWhenHidden(it));
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
    // #171: the switch opens or closes every change; what you opened or closed by hand gives way to it.
    this.changesBox.checked = p.showChanges;
    this.root.dataset.changes = p.showChanges ? 'shown' : 'hidden';
    if (what === 'showChanges') this.keepPlace(() => {
      this.fileOpen.clear();
      for (const f of this.root.querySelectorAll<HTMLElement>('.tx-chg-file')) this.fileSet.get(f)?.(p.showChanges);
    });
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
    // New sizes (a zoom, another preset's fonts) move the bottom: a view that followed it keeps following. #157: and
    // may take a pinned card's room.
    if (what === 'transcriptZoom' || what === 'transcriptTheme') this.fit();
    if (what === 'transcriptZoom' || what === 'transcriptTheme' || what === 'hideTools' || what === 'showChanges') this.stick();
  }

  /**
   * #171: runs a change that moves the rows (every diff opening or closing) without moving what you read: the row at the
   * top of the view stays where it was. Following the bottom, `stick()` keeps the bottom instead.
   */
  private keepPlace(change: () => void): void {
    if (this.following) return change();
    const top = this.scroller.getBoundingClientRect().top;
    let anchor: HTMLElement | null = null;
    for (const r of this.timeline.el.children as HTMLCollectionOf<HTMLElement>) {
      if (r.hidden || !r.offsetParent) continue;
      if (r.getBoundingClientRect().bottom > top) {
        anchor = r;
        break;
      }
    }
    const before = anchor?.getBoundingClientRect().top ?? 0;
    change();
    if (anchor?.isConnected) this.scroller.scrollTop += anchor.getBoundingClientRect().top - before;
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
    const inAsync = !!target && this.asyncq.el.contains(target); // #157
    const pinned = this.pinned();
    // Ctrl/⌘+Enter sends the pinned card's answers, from the card or from the timeline (the ask's card goes first, then
    // the follow-up's or the async questions', the open one: the card you are on, if any).
    if (isSendKey(e)) {
      const card = inAsync ? this.asyncq : this.ask.shown ? (inFollowup ? null : this.ask) : inFollowup ? this.followup : pinned;
      if (card?.key(e, card === this.ask ? inCard : card === this.followup ? inFollowup : inAsync)) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // #157: ← → on the two cards' tabs open the other one (the keyboard stays on the tabs).
    if (target && this.cardTabs.contains(target) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      this.pickCard(this.front === 'followup' ? 'asyncq' : 'followup', false);
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // #57: on the pinned question its keys come first: ↑ ↓ through the options, Esc back to the timeline (not up
    // from the seat); Enter on an option is its click (it picks, never sends).
    if (inCard && this.ask.key(e, true)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // #90: the same on the follow-up card; #157: and on the async questions'.
    if (inFollowup && this.followup.key(e, true)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (inAsync && this.asyncq.key(e, true)) {
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
    // #90: and the follow-up card's digits and ← → (Tab and Enter stay the page's: the focus, the prompt box); #157:
    // while it is the open one of the two.
    if (!inFollowup && !this.ask.shown && pinned === this.followup && this.followup.key(e)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // #157: or the async questions' digits and ← → when theirs is the open card (behind the ask's; never the screen
    // question's digits, which the banner of a real block keeps).
    if (!inAsync && !this.ask.shown && pinned === this.asyncq && !this.blocked && this.asyncq.key(e)) {
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
    if (this.promptOff || this.sending.busy) return;
    const draft = this.composer.getDraft();
    // A file the box refused stays held until dismissed: the prompt does not go without the picture meant for it.
    const held = heldRefusalText(draft.snapshot(), { nothing: 'sent', again: 'send' });
    if (held) {
      this.composer.notice(held, 'error');
      return;
    }
    if (!hasContent(draft.snapshot())) return;
    this.sending.set(true);
    // #58: your own send brings you to the bottom, where its row goes, and follows from there.
    this.toBottom();
    void this.send(draft);
  }

  /**
   * The images first (waited for, the box read-only meanwhile; one that did not upload stops it, its chip has the
   * Retry), then the prompt. Not sent (refused, too long, an image failed): the box keeps what was written.
   */
  private async send(draft: PromptDraft): Promise<void> {
    try {
      const r = await draft.resolve({ maxBytes: WORKER_PROMPT_MAX_BYTES });
      if (this.destroyed) return;
      if (!r.ok) {
        const why = notSentText(r, { nothing: 'sent', again: 'send' });
        if (why) this.composer.notice(why, 'error');
        return;
      }
      this.composer.clearNotice();
      const sent = await Promise.resolve(this.host.onPromptSubmit(r.text)).catch(() => false);
      // Sent: the box is empty again (an edit made meanwhile is impossible while it is read-only, but a draft swap is
      // not). #141: also when the view went meanwhile: the host keeps the worker's draft for its next view.
      if (sent !== false) draft.clearIf(r.revision);
    } finally {
      // #141: the gate is the draft's, not this view's: it opens whether this view, a later one or none is up.
      this.sending.set(false);
    }
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
