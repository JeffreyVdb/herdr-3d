import './transcript.css';
import DOMPurify, { type Config, type DOMPurify as Purifier } from 'dompurify';
import { Marked } from 'marked';
import type { Ask, CommandArgs, CommandRequest, Followup, HandoffCandidate, ScheduleSuggestion, TranscriptChanges, TranscriptCollab, TranscriptDiff, TranscriptItem, TranscriptTerminal, Usage, WorkerCodex } from '../net/protocol';
import { AskCard, askItem, type AskCardHost, type AskResult } from './askCard';
import { AsyncCard, type AsyncResult } from './asyncCard';
import { AsyncDrafts } from './asyncDrafts';
import type { AnswerOptions } from './askStack';
import { BlockedCard, type BlockedQuestion } from './blockedCard';
import { QuestionSheet, type OpenedAsks } from './questionSheet';
import { diffColours, type DiffColours } from './diffHighlight';
import { CommandRequestCard, type CommandRequestCardHost } from './commandRequestCard';
import { FollowupCard, type FollowupMessage, type FollowupResult } from './followupCard';
import type { FollowupDraft } from './followupDrafts';
import type { ImageFeed } from './imageFeed';
import { imageRuns, imagesOf, isImageOnly, isImagePart, isOmittedPart, textOf, Thumbs } from './transcriptImages';
import { h, icon } from '../ui/dom';
import { handoffRow } from '../world/handoff';
import { suggestionFor, suggestionWhen } from '../world/scheduleSuggest';
import { browserZone } from '../world/daylight';
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
import { repoSource, type RepoSearchHost } from './repoSearch';
import { atSource } from './atSource';
import type { Source } from '../ui/composer/complete';
import { SendGate } from './transcriptDrafts';
import { seatChord, zoomKey } from './keys';
import { fileRefPath } from './fileRef';
import { clipboardCopy, FILE_REF, FileRefPopover, markFileRefs } from './fileRefPopover';
import { chipSecretRefs } from '../ui/secretChips';
import type { ActivityCue, PendingPrompt } from './transcriptActivity';
import { ChildBar, type ChildViewHost, type ChildViewState } from './transcriptChild';
import { reviewKey } from '../ui/secretsFlow';
import { loadingOutline } from './transcriptLoading';
import { keyName } from '../input/shortcuts';
import { duotone, type DuotoneName } from '../ui/duotone';

/**
 * M16: a worker's conversation as DOM, drawn over the laptop screen while you sit there (the seated view's
 * `transcript` mode; the shell mounts it, positions the container and feeds it the bridge's items).
 *
 * Everything in a transcript is untrusted: assistant text quotes web pages, tool output is whatever a command printed.
 * Text goes in as text; markdown goes through `marked` (raw HTML escaped, images shown as links) and then DOMPurify
 * against an allowlist (no script, style, form, frame, svg or image, no `on*`, only `http(s):` / `mailto:` links, all
 * opened in a new context with `rel="noopener noreferrer"`). The code highlighter is loaded on first use and its
 * output is sanitised again (spans with classes only). Without a DOM to sanitise in, markdown shows as plain text.
 * #31: a link to a file on the worker's machine (`fileRef.ts`) loses its `href` too, but keeps its path as inert data
 * (`data-tx-file`): the reference opens a popover with the path and "Copy file path" (`fileRefPopover.ts`).
 */

export interface TranscriptRenderHost {
  /** M16 phase 2: this worker's images (null: none can be fetched, every image is a "not available" card). */
  images: ImageFeed | null;
  /**
   * A prompt to send (images already uploaded, as `[Image #n: <path>]` markers); resolving false (not sent) leaves it in
   * the prompt box. #108: `review`: "Review secrets" (Ctrl/⌘+Shift+X) asked for the review of its possible secrets.
   */
  onPromptSubmit(text: string, o?: { review: boolean }): void | Promise<boolean>;
  /** #108: the "Review prompt secrets before sending" switch, for the prompt box's "Review secrets" (none: no such control). */
  secrets?: { readonly on: boolean; onChange(fn: () => void): () => void } | null;
  /** #108 round 4: the bridge's directory of protected files (null: unknown, the references' shape alone makes a chip). */
  secretsDir?(): string | null;
  /** #64: one image to Drop Zone (null: none can be uploaded here, a pasted image says so). */
  upload?: Uploader | null;
  /** #64: the worker's name, for the upload's file name. */
  label?: string;
  onAnswer(hash: string, choice: number | null, cancel?: boolean): void;
  /** #57: answers (or dismisses) the worker's ask; `id` is filled in by the host. */
  onAnswerAsk(args: CommandArgs['worker.answer_ask'], o?: AnswerOptions): Promise<AskResult>;
  /** #90: answers the worker's follow-up questions; `id` is filled in by the host (none: the card cannot send). */
  onAnswerFollowup?(args: CommandArgs['worker.answer_followup'], o?: AnswerOptions): Promise<FollowupResult>;
  /** #90: dismisses them. */
  onDismissFollowup?(turnId: string): Promise<FollowupResult>;
  /** #60: reads a fallback's questions again (none: no Retry). */
  onRetryFollowup?(turnId: string): Promise<FollowupResult>;
  /** #60: the whole message the follow-up is of (none: only a fallback's end). */
  loadFollowupMessage?(turnId: string): Promise<FollowupMessage>;
  /** #60: what you picked and wrote for the follow-up, kept by the host across views (none: the card's own). */
  followupDrafts?: { get(turn: string): FollowupDraft | null; set(turn: string, d: FollowupDraft): void; clear(turn: string): void };
  commandRequest?: CommandRequestCardHost;
  /** #213: whether enough of the command card is in the conversation's view to be seen (it changed). */
  onCommandCardView?(inView: boolean): void;
  /** #223: the inline Handoff button on the worker's latest completed reply was pressed (none: no button). */
  onHandoff?(c: HandoffCandidate): void;
  /** #198: "Hire with handoff" beside it: a handoff, then a new agent with it (none: no button). */
  onHireHandoff?(c: HandoffCandidate): void;
  /**
   * Run elsewhere: a message you wrote, whole, to send as a new worker's first task (`first`: the conversation's first
   * message; `anchor`: the button pressed, null from the R key when the row is not drawn; `images`: it has images, which
   * do not go). None: no button, no key.
   */
  onRerun?(text: string, first: boolean, anchor: HTMLElement | null, images: boolean): void;
  /**
   * #64 schedules: "Schedule follow-up…" beside it, on the same reply (none: no button). #66: with `s`, the suggestion
   * chip that stands in its place was clicked.
   */
  onScheduleFollowup?(c: HandoffCandidate, s?: ScheduleSuggestion): void;
  /** #66: the suggestion chip's ×: dismisses it for good (none: no ×). */
  onDismissScheduleSuggestion?(s: ScheduleSuggestion): Promise<FollowupResult>;
  /** #157: answers a Codex worker's async questions (none: the card cannot send). */
  onAnswerAsync?(args: CommandArgs['worker.answer_async'], o?: AnswerOptions): Promise<AsyncResult>;
  /** #157: hides them in the bridge. */
  onDismissAsync?(args: CommandArgs['worker.dismiss_async']): Promise<AsyncResult>;
  /** #157: what you wrote for them, kept by the host across views (none: this view's own, which goes with it). */
  asyncDrafts?: AsyncDrafts;
  /** #187: what you picked and typed on the worker's ask, kept by the host across views (none: the card's own). */
  askDrafts?: AskCardHost['drafts'];
  /**
   * #187: the worker's mandatory questions the questions' sheet opened for already, kept by the host across views (so
   * it opens once per question, not again on another view; none: this view's own).
   */
  opened?: OpenedAsks | null;
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
  /** #247: the worker, for the `@r:` repositories of the other floors (needs `files`; none: `@` is files only). */
  repos?: { id: string; search: RepoSearchHost } | null;
  /** #31: the worker's checkout now, for a relative file reference's full path (none, or null: not known, it stays relative). */
  cwd?(): string | null;
  /** #31: puts a file reference's path on the clipboard, false when refused (none: the browser's clipboard). */
  copy?(text: string): Promise<boolean>;
  /**
   * #26: the view is one of the worker's native children's conversation (none: the worker's own). Read only: no prompt
   * box, cards or context meter; its bar is a breadcrumb back to the worker (`transcriptChild.ts`).
   */
  child?: ChildViewHost | null;
  /**
   * #126: the watch has not answered yet: the timeline says the conversation is opening (never "No conversation yet."),
   * until `setLoading(false)` or items come. None: answered.
   */
  loading?: boolean;
}

export type { BlockedQuestion } from './blockedCard';

export interface TranscriptView {
  setItems(items: TranscriptItem[]): void;
  applyUpdates(items: TranscriptItem[]): void;
  /** The question on the worker's screen (null: none). #187: the questions' sheet's urgent lane, while there is no ask. */
  setBlocked(q: BlockedQuestion | null): void;
  /** #57: the worker's ask (null: none). #187: the questions' sheet's urgent lane: it opens by itself, once per ask. */
  setAsk(ask: Ask | null): void;
  /** #90: the open questions of the agent's final message (null: none): the sheet's calm lane; the prompt box stays on. */
  setFollowup(f: Followup | null): void;
  setCommandRequest?(r: CommandRequest | null): void;
  /** #213: the command card into view, its first action focused (now, or once its reply's row is drawn). */
  revealCommandRequest?(): void;
  /**
   * #223: the worker's latest completed reply a literal handoff can file (null: none). Its row, when the timeline has
   * it, gets the inline Handoff button; no other row ever does.
   */
  setHandoff?(c: HandoffCandidate | null): void;
  /**
   * #66: the worker's schedule suggestion (null: none). On its reply's row (the handoff candidate's) the chip
   * "Schedule follow-up · tomorrow 12:45 (10:45 UTC)" stands in for the plain "Schedule follow-up…".
   */
  setScheduleSuggestion?(s: ScheduleSuggestion | null): void;
  /**
   * #157: the worker's Codex launch (null: none): its async questions, in the sheet's calm lane (#187); the prompt box
   * stays on. `working`: the worker works on (its effective status, not a real block), the card's "still working".
   */
  setCodex(worker: string, codex: WorkerCodex | null, working: boolean): void;
  /** #216: what leads the bar (the view's icon), put before the title. */
  attachLead(lead: Element): void;
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
  /** #26: a child's view: its state, its log's availability and whether older items can be shown. */
  setChild?(s: ChildViewState): void;
  /** #126: whether the watch's answer is still to come (`TranscriptRenderHost.loading`). */
  setLoading?(loading: boolean): void;
  /**
   * #187: whether the conversation is the view on the screen (not the terminal, the images or a child's conversation;
   * a view starts as shown). Hidden, the questions' sheet closes; a mandatory question opens it once it is shown.
   */
  setVisible?(shown: boolean): void;
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

/** #126: one formatter for every row's time (`toLocaleString` makes one per call: a third of a millisecond each). */
let clockFormat: Intl.DateTimeFormat | null = null;

function clock(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  clockFormat ??= new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', month: 'short', day: 'numeric' });
  return clockFormat.format(new Date(ts));
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

/** #223: ids for the Handoff button's note. */
let handoffIds = 0;

let mdPurifier: Purifier | null | undefined;
let hlPurifier: Purifier | null | undefined;
/** #31: the file path of each link the sanitiser is taking the `href` of, until its attributes are done. */
const fileHrefs = new WeakMap<Element, string>();

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
      // #31: a file reference is no URL to follow: its href goes, its path is kept (below) as data for the copy.
      else if (data.attrName === 'href' && tag === 'A') {
        const path = fileRefPath(data.attrValue);
        if (path !== null) {
          fileHrefs.set(node, path);
          data.keepAttr = false;
        }
      }
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
      const path = fileHrefs.get(a);
      if (path !== undefined) {
        fileHrefs.delete(a);
        a.removeAttribute('href');
        a.setAttribute('data-tx-file', path);
        return;
      }
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
  markFileRefs(el);
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

// #216: the seat's duotone set (ui/duotone.ts), by the names the transcript uses.
const TX_ICON = {
  terminal: 'terminal',
  edit: 'pencil',
  file: 'fileText',
  search: 'search',
  globe: 'globe',
  agent: 'agent',
  list: 'list',
  tool: 'tool',
  chevron: 'chevronRight',
  brain: 'brain',
  image: 'image',
} as const satisfies Record<string, DuotoneName>;

function toolIcon(name: string): DuotoneName {
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

// ---------------------------------------------------------------------------------------------------------------
// #56: Codex collaboration calls and inter-agent messages

/** What the view says of a message multi-agent v2 encrypted (the session files only have ciphertext). */
export const COLLAB_ENCRYPTED = 'Message encrypted by Codex (multi-agent v2). Not readable from the session files.';

const isCollab = (c: unknown): c is TranscriptCollab => !!c && typeof c === 'object' && typeof (c as { kind?: unknown }).kind === 'string';
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** A tool's input as shown: a string as it is, anything else as indented JSON. */
function jsonOf(input: unknown): string {
  try {
    return typeof input === 'string' ? input : (JSON.stringify(input, null, 2) ?? '');
  } catch {
    return String(input);
  }
}

/** A part of a collab header: plain words, or a name (an agent, a model). */
type CollabBit = string | { id: string };

/** fork_turns as words: '' for none (a fresh thread is the default, not worth saying). */
function forkWords(f: string): string {
  if (!f || f === 'none') return '';
  if (f === 'all') return 'full context';
  if (/^\d+$/.test(f)) return f === '1' ? 'the last turn' : `the last ${f} turns`;
  return f;
}

/** The agent a call or message is about: its path, else the name the call gave it. */
const collabWho = (c: TranscriptCollab) => text(c.agent_path) || text(c.target) || text(c.task_name);

/** An inbound message's header type ("FINAL_ANSWER") as words. */
const messageType = (t: string) => (t ? t.charAt(0) + t.slice(1).toLowerCase().replace(/_/g, ' ') : '');

/** A collab row's header: what happened (the verb) and whom it is about. */
function collabHead(c: TranscriptCollab, output: string): { verb: string; bits: CollabBit[] } {
  const who = collabWho(c);
  const named = (verb: string): { verb: string; bits: CollabBit[] } => ({ verb, bits: who ? [{ id: who }] : [] });
  switch (c.kind) {
    case 'spawn': {
      const nick = text(c.nickname);
      const name = text(c.task_name) || nick || text(c.agent_type);
      const bits: CollabBit[] = name ? [{ id: name }] : [];
      if (nick && nick !== name) bits.push(` (${nick})`);
      const how = [text(c.model), text(c.effort)].filter(Boolean);
      if (how.length) bits.push(' on ', ...how.flatMap((id, i): CollabBit[] => (i ? [' ', { id }] : [{ id }])));
      const fork = forkWords(text(c.fork_turns));
      if (fork) bits.push(`, with ${fork}`);
      return { verb: 'Spawn subagent', bits };
    }
    case 'send':
    case 'followup':
      return named('Message to');
    case 'close':
      return named('Close');
    case 'wait': {
      let timedOut = false;
      try {
        timedOut = (JSON.parse(output) as { timed_out?: unknown } | null)?.timed_out === true;
      } catch {
        // not JSON: nothing to add
      }
      return { verb: 'Wait for subagents', bits: timedOut ? ['timed out'] : [] };
    }
    default: {
      const from = text(c.agent_path);
      const to = text(c.recipient);
      const type = text(c.message_type);
      // A parent writes down to its child (its task, a message); a child replies up.
      const verb = type === 'NEW_TASK' ? 'Task from' : from && to.startsWith(`${from}/`) ? 'Message from' : type === 'FINAL_ANSWER' ? 'Final reply from' : 'Reply from';
      return { verb, bits: from ? [{ id: from }] : [] };
    }
  }
}

/** A collab row's labelled facts, only the ones the source said. */
function collabFields(c: TranscriptCollab): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const add = (label: string, v: unknown) => {
    const s = text(v);
    if (s) out.push([label, s]);
  };
  if (c.kind === 'inbound') {
    add('From', c.agent_path);
    add('To', c.recipient);
    add('Type', messageType(text(c.message_type)));
    return out;
  }
  if (c.kind === 'wait') return out;
  add('Agent', collabWho(c));
  if (c.kind === 'spawn') {
    add('Nickname', c.nickname);
    add('Role', c.agent_type);
    add('Model', c.model);
    add('Effort', c.effort);
    const f = text(c.fork_turns);
    add('Context', f === 'none' ? 'none (a fresh thread)' : forkWords(f));
  }
  add('Thread', c.thread_id);
  return out;
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
const changesSay = (c: TranscriptChanges | null): boolean =>
  !!c && (undiffed(c).length > 0 || moreFiles(c) > 0 || c.unavailable === true || c.skipped === true || computed(c) > 0);

/** #21: the patches a running Codex script builds itself (none shown until applied). */
const computed = (c: TranscriptChanges | null): number => (c && typeof c.computed === 'number' && Number.isFinite(c.computed) && c.computed > 0 ? Math.floor(c.computed) : 0);

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
const OP_TAG: Record<string, string> = { create: 'new', delete: 'deleted', overwrite: 'overwritten', rename: 'renamed' };

/** #171: what the body says of a file with no lines, by what happened to it. */
function emptyNote(d: TranscriptDiff): string {
  if (d.no_diff === true) {
    // #21: a patch names a file it deletes, not its lines.
    if (d.op === 'delete') return 'No lines recorded: a patch that deletes a file does not carry its lines.';
    return 'No diff recorded: Claude Code keeps none when nothing changed, the old file was too large, or the diff timed out.';
  }
  if (d.op === 'create') return 'Empty file.';
  if (d.op === 'delete') return 'The file was empty.';
  if (d.op === 'rename') return 'Renamed only: no lines changed.';
  return 'No lines recorded.';
}

const STATUS_TEXT: Record<string, string> = { running: 'running', ok: 'done', error: 'error', interrupted: 'interrupted', denied: 'denied' };

/**
 * #132: a poll's process, beside the call's own status: `process running` (never the call's `running`) or `exited N`,
 * the wait in the title. Null: not a poll, or its result said neither.
 */
function terminalTag(t: TranscriptTerminal | undefined): HTMLElement | null {
  if (!t || typeof t !== 'object') return null;
  const wall = typeof t.wall_seconds === 'number' && t.wall_seconds >= 0 ? duration(t.wall_seconds * 1000) : '';
  if (t.state === 'running') {
    const title = `The process is still running${wall ? ` (the poll waited ${wall})` : ''}`;
    return h('span', { class: 'tx-tool-term', 'data-state': 'running', title }, 'process running');
  }
  if (t.state !== 'exited' || typeof t.exit_code !== 'number') return null;
  const code = t.exit_code;
  return h('span', { class: 'tx-tool-term', 'data-state': 'exited', 'data-failed': code !== 0, title: `The process exited with code ${code}` }, `exited ${code}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Diffs

interface Hunk {
  header: string | null;
  oldStart: number | null;
  newStart: number | null;
  lines: string[];
  /** #206: lines made of what was not a hunk (its JSON): not the file's code, never coloured as it. */
  opaque?: true;
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
  return { header: null, oldStart: null, newStart: null, lines: (JSON.stringify(raw, null, 2) ?? String(raw)).split('\n').map((l) => ` ${l}`), opaque: true };
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

/** The lines a diff draws at a time: its first ones, then each "Show next" (#171). */
const MAX_DIFF_LINES = 2000;
/**
 * #126: the most diff lines put off that are drawn in one frame: DIFF_NEAR of a body near the view (each line is a
 * max-content grid: 200 took 25 ms to lay out), DIFF_FRAME in all (one away from the view is not laid out:
 * `content-visibility: auto`; 500 a frame kept every frame of the worst page at 17 ms).
 */
const DIFF_NEAR = 50;
const DIFF_FRAME = 500;
/** #126: draws the next `max` lines at most of a diff put off; `done`: all of them are drawn (its fixed height gone). */
type DiffStep = (max: number) => { drawn: number; done: boolean };

const statEl = (add: number, del: number) => h('span', { class: 'tx-diff-stat' }, h('span', { class: 'tx-add-n' }, `+${add}`), ' ', h('span', { class: 'tx-del-n' }, `−${del}`));

/** A diff's row: a hunk's header, or its line `li` of hunk `hk` with the line's old and new numbers. */
type DiffRow = { kind: 'head'; text: string } | { kind: 'add' | 'del' | 'ctx' | 'meta'; text: string; on: string; nn: string; hk: number; li: number };

/** A diff's rows: its hunks' headers and lines, each line with its old and new numbers; and each hunk's lines (#206: null for one that is not code). */
function diffRows(hunks: unknown[]): { rows: DiffRow[]; lines: Array<string[] | null> } {
  const rows: DiffRow[] = [];
  const lines: Array<string[] | null> = [];
  for (const raw of hunks) {
    const hk = parseHunk(raw);
    const k = lines.push(hk.opaque ? null : hk.lines) - 1;
    if (hk.header !== null) rows.push({ kind: 'head', text: hk.header });
    let o = hk.oldStart;
    let n = hk.newStart;
    for (const [li, l] of hk.lines.entries()) {
      const c = l[0];
      const kind = c === '+' ? 'add' : c === '-' ? 'del' : c === '\\' ? 'meta' : 'ctx';
      const on = kind === 'add' || kind === 'meta' ? '' : o !== null ? String(o) : '';
      const nn = kind === 'del' || kind === 'meta' ? '' : n !== null ? String(n) : '';
      if (o !== null && (kind === 'del' || kind === 'ctx')) o++;
      if (n !== null && (kind === 'add' || kind === 'ctx')) n++;
      rows.push({ kind, text: l, on, nn, hk: k, li });
    }
  }
  return { rows, lines };
}

/**
 * A diff's lines as a unified view with line numbers: `limit` of them, then "Show next" adds MAX_DIFF_LINES more in place
 * (`around` wraps the change, to keep the reader's place; `onShown` hears how many show now). Its body scrolls, and takes
 * the focus to scroll from the keyboard (Transcript.onKey). #126: `later` may put its lines off (true: the view draws them
 * with `step`, a few at a time); the body keeps their room meanwhile.
 */
function diffLines(diff: TranscriptDiff, limit: number, around: (change: () => void) => void, onShown: (shown: number) => void, later?: (el: HTMLElement, step: DiffStep) => boolean): HTMLElement {
  const { rows, lines } = diffRows(Array.isArray(diff.hunks) ? diff.hunks : []);
  const total = rows.reduce((s, r) => s + (r.kind === 'head' ? 0 : 1), 0);
  const box = h('div', { class: 'tx-diff-lines' });
  const body = h('div', { class: 'tx-diff-body', role: 'table', tabindex: '0', 'aria-label': `Changes to ${String(diff.path ?? '')}` });
  let colours: DiffColours | null = null;
  let pos = 0;
  let shown = 0;
  const draw = (upTo: number) => {
    // Built apart, then added at once: a page of rows is one change to the page.
    const page = document.createDocumentFragment();
    for (; pos < rows.length; pos++) {
      const r = rows[pos] as DiffRow;
      if (r.kind === 'head') {
        page.append(h('div', { class: 'tx-dl tx-dh', role: 'row' }, h('span', { class: 'tx-dn' }), h('span', { class: 'tx-dn' }), h('span', { class: 'tx-dt' }, r.text)));
        continue;
      }
      if (shown >= upTo) break;
      shown++;
      const dt = h('span', { class: 'tx-dt' }, r.text || ' ');
      const dl = h('div', { class: `tx-dl tx-${r.kind}`, role: 'row' }, h('span', { class: 'tx-dn' }, r.on), h('span', { class: 'tx-dn' }, r.nn), dt);
      page.append(dl);
      colours?.row(r.hk, r.li, dl, dt);
    }
    body.append(page);
  };
  // The lines that show (a "Show next" adds to them); #126: the ones drawn so far may be fewer, for a frame or two.
  let target = Math.max(limit, MAX_DIFF_LINES);
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    // #206: drawn plain, coloured once its hunk is tokenized (while these rows are still the page's).
    colours = diffColours(diff.path, lines, body);
  };
  const step: DiffStep = (max) => {
    start();
    const was = shown;
    draw(Math.min(target, shown + max));
    const done = shown >= target || pos >= rows.length;
    if (done) body.style.removeProperty('height');
    return { drawn: shown - was, done };
  };
  // #126: as tall as its lines will be (each is a line of the body's font, whose own maximum caps it) until they are.
  let n = 0;
  let seen = 0;
  for (const r of rows) {
    if (r.kind !== 'head' && seen++ >= target) break;
    n++;
  }
  body.style.height = `${n * 1.5}em`;
  body.style.setProperty('contain-intrinsic-block-size', `auto ${n * 1.5}em`);
  const deferred = later?.(body, step);
  if (!deferred) {
    start();
    draw(target);
    body.style.removeProperty('height');
  }
  box.append(body);
  if (total > Math.min(total, target)) {
    const btn = h('button', { class: 'tx-link' });
    const note = h('div', { class: 'tx-note tx-diff-more' }, btn);
    const label = () => {
      const left = total - target;
      const next = Math.min(MAX_DIFF_LINES, left);
      btn.textContent = `Show next ${next.toLocaleString('en')} ${next === 1 ? 'line' : 'lines'} (${left.toLocaleString('en')} left)`;
    };
    label();
    btn.addEventListener('click', () => {
      around(() => {
        start();
        draw(target);
        draw(shown + MAX_DIFF_LINES);
        target = shown;
        body.style.removeProperty('height');
        if (shown < total) return label();
        note.remove();
        // The button is gone: the focus goes to the lines it showed, not to the page.
        body.focus({ preventScroll: true });
      });
      onShown(shown);
    });
    box.append(note);
  }
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
/** #187: the prompt box while an ask or the screen's question waits (the bridge refuses a prompt then). */
const WAITING_HINT = 'Answer the questions first (button above, or in the terminal)';

/** Where a pasted image goes when the host has no upload: the chip says it did not go up. */
const NO_UPLOAD: Uploader = () => Promise.resolve({ ok: false, code: 'unavailable', message: 'images cannot be uploaded from here' });
const MAX_INPUT_JSON = 4000;

/**
 * #126: how the view's timeline is built when it starts over (its first items, a resync): its newest rows at once, then
 * the older ones above them, a slice of about `budgetMs` at a time, each right after a frame is drawn, so the page paints
 * and takes input between two (and the 3D scene keeps its frames). Not `scheduler.yield` alone: its continuations go
 * before the frame's own work, and in Chrome 149 seven slices ran back to back in one 112 ms frame. Where no frame is
 * drawn (a hidden page) it is `scheduler.yield`, else a timeout. Tests put in their own clock and yield.
 */
export const backfill = {
  budgetMs: 8,
  now: (): number => performance.now(),
  yield: (): Promise<void> =>
    new Promise((resume) => {
      if (typeof requestAnimationFrame === 'function' && typeof document !== 'undefined' && document.visibilityState === 'visible') {
        requestAnimationFrame(() => setTimeout(resume, 0));
        return;
      }
      const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
      if (typeof s?.yield === 'function') void s.yield().then(resume);
      else setTimeout(resume, 0);
    }),
};
/** #126: the rows a fresh timeline builds at once (then more while they leave the view to fill, for TOPUP_MS at most). */
const FIRST_ROWS = 30;
const TOPUP_ROWS = 15;
const TOPUP_MS = 30;
/** #126: the most rows of one backfill slice (a clock that stands still builds no more than this at a time). */
const SLICE_ROWS = 60;
let fills = 0;

/** #126: what a timeline that builds its older rows in the background asks of its view. */
interface Backfill {
  /** Rows `change` puts in above the others keep the ones on the screen where they are (following: the bottom). */
  hold(change: () => void): void;
  /** The rows built so far leave the view to fill: the first build goes on. */
  room(): boolean;
  /** The last row is built: what waited for all of them. */
  done(): void;
}

/** #126: the same item again (a resync's): equal as the bridge sent it. */
function sameItem(a: TranscriptItem, b: TranscriptItem): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * A list of items (the transcript, or a subagent's nested one), in `seq` order, each row keyed by id. #126: every item
 * is known at once (counts, tool calls and the rest read the items, never the rows), but the view's own timeline (the
 * one with a `Backfill`) builds the rows of a fresh start newest first and the older ones in the background, and builds
 * no system row until "Show system" is on.
 */
class Timeline {
  readonly el: HTMLOListElement;
  private items = new Map<string, TranscriptItem>();
  private rows = new Map<string, HTMLElement>();
  /** #126: the items still to build, oldest first, all older than every row built: the backfill takes them from the end. */
  private pending: string[] = [];
  private readonly waiting = new Set<string>();
  /** The items in `seq` order (null: to sort again). */
  private order: TranscriptItem[] | null = null;
  /** #126: the backfill running (its number; 0: none). */
  private filling = 0;
  /** Merged image-only rows, and the first row of the run each is shown in. */
  private readonly merged = new Set<string>();
  private readonly leadOf = new Map<string, string>();
  /** An image-only row's own thumbnails (a merged row gives its away and gets them back). */
  private readonly own = new WeakMap<HTMLElement, HTMLElement[]>();

  constructor(
    private readonly view: Transcript,
    readonly scope: string,
    nested: boolean,
    private readonly bg: Backfill | null = null,
  ) {
    this.el = h('ol', { class: nested ? 'tx-list tx-nested' : 'tx-list' });
  }

  get size(): number {
    return this.items.size;
  }

  /** #126: older rows are being built. */
  get building(): boolean {
    return this.filling !== 0;
  }

  /** #126: rows are still to build and one of them will show (`shows`), but none built so far does: still opening. */
  opening(shows: (it: TranscriptItem) => boolean): boolean {
    if (!this.pending.length) return false;
    for (const id of this.rows.keys()) {
      const it = this.items.get(id);
      if (it && shows(it)) return false;
    }
    return this.pending.some((id) => {
      const it = this.items.get(id);
      return !!it && this.wants(it) && shows(it);
    });
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  get(id: string): TranscriptItem | undefined {
    return this.items.get(id);
  }

  values(): IterableIterator<TranscriptItem> {
    return this.items.values();
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
    return this.sorted().filter((it) => isToolRow(it) && (showSystem || !isSystem(it)));
  }

  private sorted(): TranscriptItem[] {
    return (this.order ??= [...this.items.values()].sort(bySeq));
  }

  /** The items whose turn to be built has come (all but the backfill's), in order; a system one may have no row. */
  private built(): TranscriptItem[] {
    return this.waiting.size ? this.sorted().filter((it) => !this.waiting.has(it.id)) : this.sorted();
  }

  /** #126: whether an item gets a row now: a system one only once "Show system" is on, in the view's own timeline. */
  private wants(it: TranscriptItem): boolean {
    return !this.bg || !isSystem(it) || this.view.systemShown;
  }

  /**
   * Replaces everything; returns the items that were not there before. #126: a row whose item did not change stays as it
   * is, where it is (a resync of the same transcript, older items paged in). With no such row the newest rows come first
   * and the older ones are built in the background; with some, only what changed is built, and the items older than them
   * in the background.
   */
  set(items: TranscriptItem[]): TranscriptItem[] {
    this.stop();
    const before = this.items;
    const was = this.rows;
    this.items = new Map();
    for (const it of items) if (isItem(it)) this.items.set(it.id, it);
    this.order = null;
    const sorted = this.sorted();
    this.rows = new Map();
    this.pending = [];
    this.waiting.clear();
    this.merged.clear();
    this.leadOf.clear();
    let oldest = -1;
    sorted.forEach((it, i) => {
      const row = was.get(it.id);
      const prev = before.get(it.id);
      if (!row || !prev || (prev !== it && !sameItem(prev, it))) return;
      this.rows.set(it.id, row);
      if (oldest < 0) oldest = i;
    });
    for (const [id, row] of was) if (this.rows.get(id) !== row) row.remove();
    const bg = this.bg;
    // The items from here on have their rows now; the ones before it wait for the backfill.
    let from = sorted.length;
    if (!bg || oldest >= 0) {
      from = bg ? oldest : 0;
      for (const it of sorted.slice(from)) if (!this.rows.has(it.id) && this.wants(it)) this.rows.set(it.id, this.view.renderRow(it, this.scope));
      this.place(sorted.slice(from));
    } else {
      // A screenful at least, newest first, of rows that show (a tool row "Hide tool calls" hides fills none, nor does an
      // image-only row merged into the older one of its run), for TOPUP_MS at most.
      const start = backfill.now();
      const late = () => backfill.now() - start > TOPUP_MS;
      let n = 0;
      let run: string | null = null;
      for (let limit = FIRST_ROWS; ; limit = n + TOPUP_ROWS) {
        const rows: HTMLElement[] = [];
        while (from > 0 && n < limit) {
          const it = sorted[--from] as TranscriptItem;
          if (!this.wants(it)) continue;
          const row = this.view.renderRow(it, this.scope);
          this.rows.set(it.id, row);
          rows.push(row);
          const img = isImageOnly(it) ? it.kind : null;
          const shows = this.view.rowShows(it) && (img === null || img !== run);
          run = img;
          if (shows) n++;
          else if (late()) break;
        }
        this.el.prepend(...rows.reverse());
        if (from === 0 || late() || !bg.room()) break;
      }
    }
    this.pending = sorted.slice(0, from).map((it) => it.id);
    for (const id of this.pending) this.waiting.add(id);
    this.regroup();
    this.fill();
    return sorted.filter((it) => !before.has(it.id));
  }

  /** The rows of `list` (in order) in the list in that order, the ones already in place left where they are. */
  private place(list: readonly TranscriptItem[]): void {
    let at = this.el.firstElementChild;
    for (const it of list) {
      const row = this.rows.get(it.id);
      if (!row) continue;
      if (row === at) at = at.nextElementSibling;
      else this.el.insertBefore(row, at);
    }
  }

  /** Adds new items and replaces known ones in place; returns the new ones. */
  apply(items: TranscriptItem[]): TranscriptItem[] {
    const added: TranscriptItem[] = [];
    for (const it of items) {
      if (!isItem(it)) continue;
      const prev = this.items.get(it.id);
      this.items.set(it.id, it);
      this.order = null;
      if (!prev) added.push(it);
      // #126: one the backfill has not built yet is built as it is when its turn comes.
      if (this.waiting.has(it.id)) {
        if (prev && bySeq(prev, it) === 0) continue;
        this.unwait(it.id);
      }
      const old = this.rows.get(it.id);
      if (!old && this.below(it)) {
        this.wait(it.id);
        continue;
      }
      if (!this.wants(it)) {
        old?.remove();
        this.rows.delete(it.id);
        continue;
      }
      const row = this.view.renderRow(it, this.scope, prev);
      this.rows.set(it.id, row);
      if (old && prev && prev.seq === it.seq) {
        old.replaceWith(row);
        continue;
      }
      old?.remove();
      this.insert(it, row);
    }
    this.regroup();
    return added;
  }

  /** #126: while the backfill runs, an item older than every row built waits with the others. */
  private below(it: TranscriptItem): boolean {
    if (!this.pending.length) return false;
    const id = (this.el.firstElementChild as HTMLElement | null)?.dataset.id;
    const top = id !== undefined ? this.items.get(id) : undefined;
    return !top || bySeq(it, top) < 0;
  }

  private wait(id: string): void {
    const it = this.items.get(id) as TranscriptItem;
    let lo = 0;
    let hi = this.pending.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const other = this.items.get(this.pending[mid] as string);
      if (other && bySeq(other, it) <= 0) lo = mid + 1;
      else hi = mid;
    }
    this.pending.splice(lo, 0, id);
    this.waiting.add(id);
  }

  private unwait(id: string): void {
    const i = this.pending.indexOf(id);
    if (i >= 0) this.pending.splice(i, 1);
    this.waiting.delete(id);
  }

  /** #126: builds what is still to build, newest first, a slice at a time; a new `set`, or `stop`, ends it. */
  private fill(): void {
    const bg = this.bg;
    if (!bg || this.filling || !this.pending.length) return;
    const run = ++fills;
    this.filling = run;
    void (async () => {
      while (this.filling === run && this.pending.length) {
        await backfill.yield();
        if (this.filling !== run) return;
        this.slice(backfill.budgetMs);
      }
      if (this.filling !== run) return;
      this.filling = 0;
      bg.done();
    })();
  }

  /** #126: ends the backfill (a new `set`, the view gone); what it did not build waits. */
  stop(): void {
    this.filling = 0;
  }

  /**
   * #126: the next rows still to build, newest first, until `budget` ms went by (one at least, SLICE_ROWS at most), put
   * in above the others at once; their image runs are merged again with the run they may join below them.
   */
  private slice(budget: number): void {
    const start = backfill.now();
    const rows: HTMLElement[] = [];
    let newest: TranscriptItem | null = null;
    while (this.pending.length && rows.length < SLICE_ROWS && (!rows.length || backfill.now() - start < budget)) {
      const id = this.pending.pop() as string;
      this.waiting.delete(id);
      const it = this.items.get(id);
      if (!it || !this.wants(it)) continue;
      const row = this.view.renderRow(it, this.scope);
      this.rows.set(id, row);
      rows.push(row);
      newest ??= it;
    }
    if (!newest) return;
    const page = document.createDocumentFragment();
    page.append(...rows.reverse());
    const list = this.built();
    let end = list.indexOf(newest) + 1;
    while (end < list.length && (isImageOnly(list[end] as TranscriptItem) || (!this.view.systemShown && isSystem(list[end] as TranscriptItem)))) end++;
    (this.bg as Backfill).hold(() => {
      this.el.prepend(page);
      this.regroup(list.slice(0, end));
    });
  }

  /** #126: builds what is still to build down to `id`, now (a jump to it). */
  ensure(id: string): void {
    while (this.waiting.has(id)) this.slice(Infinity);
  }

  /** #126: "Show system" turned on: the system rows not built yet are built now (the backfill builds its own as it goes). */
  buildSystem(): void {
    if (!this.bg) return;
    const list = this.built();
    let made = false;
    for (const it of list) {
      if (this.rows.has(it.id) || !this.wants(it)) continue;
      this.rows.set(it.id, this.view.renderRow(it, this.scope));
      made = true;
    }
    if (made) this.place(list);
  }

  /** The row an item is shown in: a merged image-only item shows in the row of the run's first. */
  row(id: string): HTMLElement | undefined {
    const lead = this.leadOf.get(id);
    return this.rows.get(lead ?? id);
  }

  /**
   * Runs of image-only items share one strip (`imageRuns` has the rule): the first item's row keeps every thumbnail of
   * the run and the others are hidden, so a run of screenshots reads as one row. Everything is undone and done again
   * on every change, so an update of any item of a run (or a row that breaks it) is right. #126: of the items whose rows
   * are built (`list`: a backfill slice's, which holds every run it can change, whole; the backfill's own are not built
   * yet, so a run that goes on in them is merged again when they are).
   */
  regroup(list: readonly TranscriptItem[] = this.built()): void {
    const rows: HTMLElement[] = [];
    for (const it of list) {
      const r = this.rows.get(it.id);
      if (r) rows.push(r);
    }
    // A row seen for the first time is whole: its thumbnails are its own.
    for (const r of rows) {
      const strip = r.classList.contains('tx-imgonly') ? r.querySelector('.tx-strip') : null;
      if (strip && !this.own.has(r)) this.own.set(r, [...strip.children] as HTMLElement[]);
    }
    for (const r of rows) {
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
    for (const it of list) {
      this.merged.delete(it.id);
      this.leadOf.delete(it.id);
    }
    for (const ids of imageRuns(list, this.view.systemShown)) {
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
  /** #171: how many of a changed file's lines show, once "Show next" showed more than the first MAX_DIFF_LINES (same key). */
  private readonly diffShown = new Map<string, number>();
  /** #171: changes loaded in full (`transcript.item`) after the list cut them, by agent/id. */
  private readonly fullDiffs = new Map<string, TranscriptDiff[]>();
  /** #56: collaboration items loaded in full (`transcript.item`) for what the list left out, by agent/id. */
  private readonly fullCollab = new Map<string, TranscriptItem>();
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
  /** #108: "Review secrets", shown while the switch is on. */
  private readonly reviewBtn: HTMLButtonElement;
  private readonly offSecrets: () => void;
  /** The box cannot take a prompt now (the worker waits on a question). */
  private promptOff = false;
  /** A prompt is on its way (uploading, then sent): the box is read-only until it is answered (#141: in any view of it). */
  private readonly sending: SendGate;
  private readonly offSending: () => void;
  private readonly empty: HTMLDivElement;
  /** #126: the watch's answer is still to come: the outline of a conversation opening stands in the empty state's place. */
  private loading: boolean;
  private readonly loader: HTMLElement;
  /**
   * #126: the changed files' lines still to draw, by body, in the order they were built (the newest rows' first). The ones
   * that come near the view go first (`drawQueue`); once the open settles, every other one the observer said is away from
   * it (`far`), one at a time (`draining`), so find in page finds every line. DIFF_NEAR / DIFF_FRAME lines a frame at most
   * (`drawing`: the next frame is to draw them).
   */
  private lazyIO: IntersectionObserver | null = null;
  private readonly lazyDraw = new Map<Element, DiffStep>();
  private readonly far = new WeakSet<Element>();
  private readonly drawQueue: Array<[Element, DiffStep]> = [];
  private draining: [Element, DiffStep] | null = null;
  private drawing = false;
  /** #26: a child's breadcrumb, read-only note and older items' button (null: the worker's own view). */
  private readonly childBar: ChildBar | null = null;

  private following = true;
  /** Rows that came in while you were scrolled up; the chip counts the ones that show (#59: recounted on each toggle). */
  private readonly fresh = new Set<string>();
  private showSystem = false;
  private readonly thumbs: Thumbs;
  private blocked: BlockedQuestion | null = null;
  /** #187: the screen's question as a card in the sheet's urgent lane (while there is no ask). */
  private readonly blockedCard: BlockedCard;
  private readonly ask: AskCard;
  private readonly followup: FollowupCard; // #90
  /** #223: the worker's handoff candidate, and the inline button on its row (null: none shown). */
  private handoff: HandoffCandidate | null = null;
  private handoffEl: HTMLElement | null = null;
  private commandCard: CommandRequestCard | null = null;
  /** #213: the card's share of the scroller, and a reveal asked for before the card had its row. */
  private commandCardIO: IntersectionObserver | null = null;
  private commandCardSeen = false;
  private revealCard = false;
  /** #66: the worker's schedule suggestion, the × in flight, and the minute tick that keeps the chip's day words true. */
  private suggestion: ScheduleSuggestion | null = null;
  private dismissing = false;
  private suggestionTick: ReturnType<typeof setInterval> | null = null;
  private readonly zone = browserZone();
  private readonly asyncq: AsyncCard; // #157
  /** #187: the cards' sheet and its button in the prompt box (the conversation keeps its whole height). */
  private readonly questions: QuestionSheet;
  /** The timeline's box (the scroller and the jump chip) and the prompt box. */
  private readonly main: HTMLDivElement;
  private readonly form: HTMLDivElement;
  /** Whether the prompt box was last drawn off (an ask or the screen's question waits). */
  private waiting = false;
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
  /** #31: the popover of a file reference: its full path and "Copy file path". */
  private readonly fileRefs: FileRefPopover;
  /** A hidden tab pauses the cue's flash (the browser still runs a CSS animation there); #187: and the questions' glow. */
  private readonly onVisibility = () => {
    const hidden = document.visibilityState === 'hidden';
    this.root.toggleAttribute('data-page-hidden', hidden);
    this.questions.cardsEl.toggleAttribute('data-page-hidden', hidden);
  };

  constructor(
    container: HTMLElement,
    private readonly host: TranscriptRenderHost,
  ) {
    this.timeline = new Timeline(this, '', false, {
      hold: (change) => {
        this.holdBottom(change);
        if (!this.loader.hidden) this.updateCounts(); // #126: the first row that shows may be in
      },
      room: () => this.room(),
      done: () => this.filled(),
    });
    this.countEl = h('span', { class: 'tx-count' });
    this.sysBtn = h('button', { class: 'tx-sys-toggle', 'aria-pressed': 'false', title: 'Show system notices and unrecognised entries', onclick: () => this.toggleSystem() });
    this.empty = h('div', { class: 'tx-empty' }, 'No conversation yet.');
    this.loading = host.loading === true;
    this.loader = loadingOutline(host.child?.name ?? host.label ?? null);
    this.pendingList = h('ol', { class: 'tx-list tx-pending-list', 'aria-label': 'Prompts on their way' });
    this.tail = h('div', { class: 'tx-tail' }, this.pendingList);
    this.live = h('div', { class: 'tx-live', role: 'status', 'aria-live': 'polite' });
    this.pendingLive = h('div', { class: 'tx-pending-live', role: 'status', 'aria-live': 'polite' });
    this.scroller = h('div', { class: 'tx-scroll', tabindex: '-1', 'aria-label': 'Conversation' }, this.empty, this.loader, this.timeline.el, this.tail);
    this.thumbs = new Thumbs({ feed: host.images, root: this.scroller });
    this.jump = h('button', { class: 'tx-jump', hidden: true, onclick: () => this.toBottom() });
    this.composer = mountComposer({
      draft: host.draft ?? new PromptDraft({ upload: host.upload ?? NO_UPLOAD, label: `transcript-${host.label ?? 'worker'}`, maxPromptBytes: WORKER_PROMPT_MAX_BYTES, holdRefused: true }),
      ariaLabel: 'Prompt',
      placeholder: PROMPT_HINT,
      submitPolicy: 'enter',
      onSubmit: () => this.submit(),
      // #139: completion is on; #140: `/` lists the worker's commands and skills, #141: `@` its files, #247: `@r:` the
      // other floors' repositories (only here: no other composer has them).
      complete: {
        sources: [...(host.commands ? [commandSource(host.commands.list, host.commands.harness)] : []), ...this.atSources(host)],
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
    // #108: with "Review prompt secrets before sending" on, the review on purpose (to mark a value the scan would miss).
    this.reviewBtn = h(
      'button',
      { class: 'tx-review', 'aria-label': 'Review secrets', title: `Review secrets: look over the prompt’s possible secrets now, and mark one the scan missed (${keyName('dialog.secrets')})`, onclick: () => this.submit(true) },
      duotone('lock'),
    );
    this.form = h('div', { class: 'tx-prompt' }, this.composer.element, this.reviewBtn, this.sendBtn);
    const secrets = host.secrets ?? null;
    const showReview = () => (this.reviewBtn.hidden = !secrets?.on);
    showReview();
    this.offSecrets = secrets ? secrets.onChange(showReview) : () => {};
    // #187: the cards live in the questions' sheet; their way back to the timeline closes it (or moves to the next card).
    this.ask = new AskCard({
      answer: (args, o) => host.onAnswerAsk(args, o),
      secrets: host.secrets ?? null,
      toTerminal: () => host.onSwitchToTerminal(),
      focusTimeline: () => this.questions.leave(this.ask),
      ...(host.askDrafts ? { drafts: host.askDrafts } : {}),
      resized: () => {
        // Shown or gone (also by itself, once its answer is recorded): the screen's question and the prompt box follow.
        this.blockedCard?.set(this.ask.shown ? null : this.blocked);
        if (this.questions && this.waiting !== (this.ask.shown || !!this.blocked)) this.renderPrompt();
        this.questions?.sync();
      },
    });
    this.blockedCard = new BlockedCard({
      answer: (hash, choice, cancel) => host.onAnswer(hash, choice, cancel),
      toTerminal: () => host.onSwitchToTerminal(),
    });
    this.commandCard = host.commandRequest ? new CommandRequestCard(host.commandRequest) : null;
    if (this.commandCard && host.onCommandCardView && typeof IntersectionObserver === 'function') {
      const card = this.commandCard.el;
      const seen = host.onCommandCardView;
      this.commandCardIO = new IntersectionObserver((entries) => {
        const e = entries[entries.length - 1]!;
        // Seen: 80 px of it (or all of a shorter one) in the scroller, so its heading and command show.
        const now = e.isIntersecting && !card.hidden && e.intersectionRect.height >= Math.min(80, e.boundingClientRect.height - 1);
        if (now !== this.commandCardSeen) seen((this.commandCardSeen = now));
      }, { root: this.scroller, threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] });
      this.commandCardIO.observe(card);
    }
    const noFollowup = (): Promise<FollowupResult> => Promise.resolve({ ok: false, code: 'unsupported', message: 'Not available here.' });
    this.followup = new FollowupCard({
      answer: (args, o) => (host.onAnswerFollowup ? host.onAnswerFollowup(args, o) : noFollowup()),
      secrets: host.secrets ?? null,
      dismiss: (turnId) => (host.onDismissFollowup ? host.onDismissFollowup(turnId) : noFollowup()),
      ...(host.onRetryFollowup ? { retry: (turnId: string) => host.onRetryFollowup!(turnId) } : {}),
      ...(host.loadFollowupMessage ? { message: (turnId: string) => host.loadFollowupMessage!(turnId) } : {}),
      ...(host.followupDrafts ? { drafts: host.followupDrafts } : {}),
      focusTimeline: () => this.questions.leave(this.followup),
      resized: () => this.questions?.sync(),
    });
    const noAsync = (): Promise<AsyncResult> => Promise.resolve({ ok: false, code: 'unsupported', message: 'Not available here.' });
    this.asyncq = new AsyncCard({
      answer: (args, o) => (host.onAnswerAsync ? host.onAnswerAsync(args, o) : noAsync()),
      secrets: host.secrets ?? null,
      dismiss: (args) => (host.onDismissAsync ? host.onDismissAsync(args) : noAsync()),
      toTerminal: () => host.onSwitchToTerminal(),
      focusTimeline: () => this.questions.leave(this.asyncq),
      drafts: host.asyncDrafts ?? new AsyncDrafts(null),
      resized: () => this.questions?.sync(),
    });
    this.questions = new QuestionSheet(
      { ask: this.ask, blocked: this.blockedCard, followup: this.followup, asyncq: this.asyncq },
      { opened: host.opened ?? null, toTerminal: () => host.onSwitchToTerminal(), focusTimeline: () => this.focus() },
    );
    // A row of its own above the composer, in the prompt box: never over the conversation (transcript.css).
    this.form.prepend(h('div', { class: 'tx-qrow' }, this.questions.button.el));
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
    const changes = h('label', { class: 'tx-check tx-check-changes', title: 'Show code changes: the diff of each file the agent changed (off: one line per file)' }, this.changesBox, h('span', { class: 'tx-check-ic', 'aria-hidden': 'true' }, duotone(TX_ICON.edit)), h('span', {}, 'Code changes'));
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
    this.root = h('div', { class: 'tx', 'data-system': 'hidden', 'data-tools': 'shown', 'data-changes': 'shown' }, bar, this.main, this.form, this.questions.button.live, this.asyncq.live, this.pendingLive, this.live);
    this.fileRefs = new FileRefPopover({
      root: this.root,
      scroller: this.scroller,
      cwd: () => host.cwd?.() ?? null,
      copy: (t) => (host.copy ? host.copy(t) : clipboardCopy(t)),
    });
    if (host.child) {
      // #26: the breadcrumb takes the title's place; the note and the way back take the prompt box's.
      const child = host.child;
      this.childBar = new ChildBar(
        {
          ...child,
          // Older items go above what you read: it stays where it was on the screen.
          loadOlder: async () => {
            const below = this.scroller.scrollHeight - this.scroller.scrollTop;
            await child.loadOlder();
            this.scroller.scrollTop = this.scroller.scrollHeight - below;
          },
        },
        this.empty,
        (text) => (this.live.textContent = text),
      );
      this.titleEl.replaceWith(this.childBar.el);
      this.form.hidden = true;
      this.form.after(this.childBar.foot);
      this.scroller.prepend(this.childBar.older);
      this.root.dataset.child = '';
    }
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
      this.resize = new ResizeObserver(() => {
        this.sizeView();
        this.stick();
        this.fileRefs.place(); // #31
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
    if (this.timeline.size) this.loading = false;
    this.root.toggleAttribute('data-building', this.timeline.building);
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
    // Its excerpt as plain text, the screen's last lines only.
    const excerpt = (Array.isArray(this.blocked?.excerpt) ? this.blocked.excerpt : [])
      .map((l) => stripAnsi(String(l)))
      .filter((l, i, a) => l.trim() || (i > 0 && i < a.length - 1))
      .slice(-EXCERPT_LINES);
    if (this.blocked) this.blocked = { ...this.blocked, excerpt };
    this.blockedCard.set(this.ask.shown ? null : this.blocked);
    this.renderPrompt();
    this.questions.sync();
  }

  setAsk(ask: Ask | null): void {
    if (this.destroyed) return;
    // The card wins over the screen's question: it has the whole question, the descriptions and multi-select
    // (the screen's card and the prompt box are redrawn when it shows or goes, through its resized()).
    this.ask.set(ask);
  }

  setFollowup(f: Followup | null): void {
    if (this.destroyed) return;
    this.followup.set(f);
  }

  setCommandRequest(r: CommandRequest | null): void {
    this.commandCard?.set(r);
    this.syncCommandRequest();
  }

  revealCommandRequest(): void {
    this.revealCard = true;
    this.syncCommandRequest();
  }

  private syncCommandRequest(): void {
    const card = this.commandCard;
    if (!card || card.el.hidden) {
      card?.el.remove();
      if (this.commandCardSeen) this.host.onCommandCardView?.((this.commandCardSeen = false));
      return;
    }
    const last = [...this.timeline.values()].filter((item) => item.kind === 'assistant').sort((a, b) => b.seq - a.seq)[0];
    const row = last ? this.timeline.row(last.id) : undefined;
    if (row && card.el.parentElement !== row) row.append(card.el);
    if (this.revealCard && card.el.isConnected) {
      this.revealCard = false;
      card.reveal();
    }
  }

  setHandoff(c: HandoffCandidate | null): void {
    if (this.destroyed) return;
    this.handoff = c && typeof c === 'object' && typeof c.id === 'string' ? c : null;
    this.syncHandoff();
    this.stick(); // following: the button under the last reply stays in view
  }

  setScheduleSuggestion(s: ScheduleSuggestion | null): void {
    if (this.destroyed) return;
    this.suggestion = s && typeof s === 'object' && typeof s.id === 'string' ? s : null;
    this.dismissing = false;
    // The day words change at midnight and the time can pass while it shows: a look every minute while there is one.
    if (this.suggestion && !this.suggestionTick) this.suggestionTick = setInterval(() => this.syncHandoff(), 60_000);
    if (!this.suggestion && this.suggestionTick) {
      clearInterval(this.suggestionTick);
      this.suggestionTick = null;
    }
    this.syncHandoff();
  }

  /**
   * #223: the one inline Handoff button, on the row of the candidate's message when the timeline holds it (a page
   * without it has none: never the last row of a partial page). A row rebuilt by an update gets it back. #66: a
   * suggestion of the same message puts its chip in place of "Schedule follow-up…"; the key tells a changed chip.
   */
  private syncHandoff(): void {
    const c = this.host.onHandoff || this.host.onScheduleFollowup ? this.handoff : null;
    const id = handoffRow(this.timeline.values(), c);
    const row = id ? this.timeline.row(id) : undefined;
    const sug = this.host.onScheduleFollowup ? suggestionFor(this.suggestion, c) : null;
    const when = sug ? suggestionWhen(sug, Date.now(), this.zone) : null;
    const key = c ? `${c.id}|${sug ? `${sug.id}|${when?.when}|${when?.passed}|${this.dismissing}` : ''}` : '';
    const btn = this.handoffEl;
    if (btn && row && c && btn.parentElement === row && btn.dataset.key === key) return;
    const a = document.activeElement;
    const had = a instanceof HTMLElement && btn?.contains(a) ? a.dataset.key : null;
    btn?.remove();
    this.handoffEl = null;
    if (!row || !c) return;
    const note = `tx-ho-note-${++handoffIds}`;
    const el = h(
      'div',
      { class: 'tx-handoff', 'data-cand': c.id, 'data-key': key },
      this.host.onHandoff
        ? h(
            'button',
            { class: 'tx-handoff-btn', 'data-key': 'handoff', 'aria-describedby': note, title: 'File this reply in the cabinet, exactly as written', onclick: () => this.host.onHandoff?.(c) },
            duotone('folder'),
            'Handoff',
          )
        : null,
      // #198: the same candidate, the same row: a handoff, then a new agent that reads it and does your task.
      this.host.onHandoff && this.host.onHireHandoff
        ? h(
            'button',
            { class: 'tx-hire-handoff-btn', 'data-key': 'hire-handoff', title: 'File a handoff from this conversation, then hire a new agent that reads it and does your task', onclick: () => this.host.onHireHandoff?.(c) },
            duotone('hire'),
            'Hire with handoff',
          )
        : null,
      // #64 schedules: a fresh worker later, with this reply attached as a literal handoff (the form files it on Save).
      // #66: the agent's own suggestion of when and what, while there is one, in its place.
      sug && when
        ? this.suggestionChip(c, sug, when)
        : this.host.onScheduleFollowup
        ? h(
            'button',
            { class: 'tx-sched-btn', 'data-key': 'schedule', title: 'Hire a fresh worker later that goes on from this reply', onclick: () => this.host.onScheduleFollowup?.(c) },
            duotone('clock'),
            'Schedule follow-up…',
          )
        : null,
      this.host.onHandoff ? h('span', { class: 'tx-handoff-note', id: note }, 'Save this message as written · no AI call') : null,
    );
    row.append(el);
    this.handoffEl = el;
    // The keyboard keeps its place: the same button, else (a × gone or busy) the one that schedules.
    if (had) {
      const same = el.querySelector<HTMLButtonElement>(`[data-key="${had}"]`);
      (same && !same.disabled ? same : el.querySelector<HTMLElement>('[data-key="schedule"]'))?.focus();
    }
  }

  /**
   * #66: the suggestion chip: one button that opens the schedule form prefilled from it (nothing is scheduled before
   * its Save), joined to a × that dismisses it for good. A time that has passed says so; the form then flags it.
   */
  private suggestionChip(c: HandoffCandidate, s: ScheduleSuggestion, when: { when: string; utc: string; passed: boolean }): HTMLElement {
    const label = when.passed ? `Schedule follow-up · suggested ${when.when}, passed` : `Schedule follow-up · ${when.when}${when.utc ? ` (${when.utc})` : ''}`;
    const open = h(
      'button',
      {
        class: 'tx-sched-btn tx-sched-sug',
        'data-key': 'schedule',
        'data-suggestion': s.id,
        'aria-label': label,
        title: `Suggested by the agent: “${s.title}”. Opens the schedule form, prefilled; nothing is scheduled until you save.`,
        onclick: () => this.host.onScheduleFollowup?.(c, s),
      },
      duotone('clock'),
      h('span', { class: 'tx-sched-label' }, 'Schedule follow-up'),
      h('span', { class: 'tx-sched-when', 'data-passed': String(when.passed) }, when.passed ? `suggested ${when.when}, passed` : when.when),
      when.utc && !when.passed ? h('span', { class: 'tx-sched-utc' }, `(${when.utc})`) : null,
    );
    const dismiss = this.host.onDismissScheduleSuggestion
      ? h(
          'button',
          {
            class: 'tx-sched-x',
            'data-key': 'dismiss-suggestion',
            'aria-label': 'Dismiss the suggested follow-up',
            title: 'Dismiss this suggestion (the plain “Schedule follow-up…” comes back)',
            disabled: this.dismissing,
            onclick: (e: Event) => {
              e.stopPropagation();
              if (this.dismissing) return;
              this.dismissing = true;
              this.syncHandoff();
              void this.host.onDismissScheduleSuggestion?.(s).then((r) => {
                if (this.destroyed || this.suggestion?.id !== s.id) return;
                // Gone: the upsert takes the chip away; refused, it stays to try again.
                if (!r.ok) {
                  this.dismissing = false;
                  this.syncHandoff();
                }
              });
            },
          },
          duotone('x'),
        )
      : null;
    return h('span', { class: 'tx-sched-chip', role: 'group', 'aria-label': 'Suggested follow-up' }, open, dismiss);
  }

  /** #157: the worker's Codex launch, and whether it works on (its effective status: the card's "still working"). */
  setCodex(worker: string, codex: WorkerCodex | null, working: boolean): void {
    if (this.destroyed) return;
    this.asyncq.set(worker, codex, working);
  }

  /** #171: the timeline's height (`--tx-view-h`): a diff body is never taller than the view (transcript.css). */
  private sizeView(): void {
    const height = this.scroller.clientHeight;
    if (height && !this.destroyed) this.root.style.setProperty('--tx-view-h', `${height}px`);
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
        h('span', { class: 'tx-activity-label' }, duotone(cue.kind === 'working' ? TX_ICON.edit : TX_ICON.brain), word),
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
      const key = `${p.state}\u0000${p.late}\u0000${p.reason ?? ''}\u0000${p.due === null}\u0000${p.shown ?? ''}`;
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
    // #187: with the questions' sheet open the keyboard is in it (it comes back to the timeline as the sheet closes).
    if (this.destroyed || this.questions.isOpen) return;
    this.scroller.focus({ preventScroll: true });
  }

  attachLead(lead: Element): void {
    if (this.destroyed) return;
    this.titleEl.before(lead);
  }

  hasItem(id: string): boolean {
    return this.timeline.has(id);
  }

  scrollToItem(id: string): boolean {
    if (this.destroyed) return false;
    this.timeline.ensure(id); // #126: the backfill had not got to it yet
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
    if (this.destroyed || this.promptOff || this.childBar) return;
    this.composer.focus();
  }

  setChild(s: ChildViewState): void {
    if (!this.destroyed) this.childBar?.set(s);
  }

  setLoading(loading: boolean): void {
    if (this.destroyed || this.loading === loading) return;
    this.loading = loading;
    this.updateCounts();
  }

  setVisible(shown: boolean): void {
    if (!this.destroyed) this.questions.setVisible(shown);
  }

  destroy(): void {
    if (this.destroyed) return;
    if (this.suggestionTick) clearInterval(this.suggestionTick); // #66
    this.destroyed = true;
    this.commandCardIO?.disconnect(); // #213
    this.timeline.stop(); // #126
    this.lazyIO?.disconnect();
    this.lazyDraw.clear();
    this.drawQueue.length = 0;
    this.draining = null;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.resize?.disconnect();
    hlDone.delete(this.onHighlighted);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.unprefs();
    this.thumbs.destroy();
    this.questions.destroy(); // #187: its sheet leaves the page
    this.ask.destroy();
    this.blockedCard.destroy();
    this.followup.destroy();
    this.asyncq.destroy();
    this.fileRefs.destroy(); // #31
    // The composer's own draft goes with the view: its uploads are cancelled, its object URLs revoked. The host's
    // (#141) stays for the next view of this worker.
    this.offSending();
    this.offSecrets(); // #108
    this.composer.dispose();
    if (!this.host.draft) this.composer.getDraft().dispose();
    this.root.remove();
  }

  /** Rows of the timeline that merge image-only items need to know whether system rows show (they break a run then). */
  get systemShown(): boolean {
    return this.showSystem;
  }

  /** #126: whether an item's row shows under the prefs now (a tool row looked at from the chip does too). */
  rowShows(it: TranscriptItem): boolean {
    return this.shows(it) || this.revealed.has(it.id);
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
    // #56: a Codex collaboration call (a tool) or a message from another agent (a notice), read for the view.
    if (((it.kind === 'tool' && it.tool) || it.kind === 'notice') && isCollab(it.collab)) return this.collabRow(it, scope, it.collab);
    switch (it.kind) {
      case 'user':
        if (isAnswers(it.answers)) return this.answerRow(it, it.answers);
        return this.userRow(it);
      case 'assistant':
        return h('li', { class: isImageOnly(it) ? 'tx-item tx-assistant tx-imgonly' : 'tx-item tx-assistant' }, this.parts(it, 'tx-said'));
      case 'thinking':
        return this.thinkingRow(it);
      case 'tool':
        if (it.tool?.ask && typeof it.tool.ask === 'object' && Array.isArray(it.tool.ask.questions)) return this.withSecretChips(askItem(it, it.tool.ask));
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
    for (const a of bubble.querySelectorAll<HTMLElement>('.tx-ans-pair')) this.withSecretChips(a);
    return h('li', { class: 'tx-item tx-user tx-answer' }, bubble);
  }

  /**
   * #108 round 4: the bridge's references to protected files under `el` as masked chips (ui/secretChips.ts), each opening
   * the file popover (#31) with its path and "Copy file path".
   */
  private withSecretChips<T extends HTMLElement>(el: T): T {
    chipSecretRefs(el, { dir: this.host.secretsDir?.() ?? null, action: { kind: 'popover', cls: FILE_REF } });
    return el;
  }

  private unknownRow(it: TranscriptItem, why: string | null): HTMLElement {
    const raw = typeof it.raw_type === 'string' && it.raw_type ? it.raw_type : typeof it.kind === 'string' ? it.kind : '?';
    return h('li', { class: 'tx-item tx-unknown tx-sys' }, h('span', { class: 'tx-notice-tag' }, 'unknown'), h('code', { class: 'tx-raw' }, raw), why ? h('span', { class: 'tx-notice-text' }, why) : null);
  }

  /** A message you wrote; with `onRerun` (not a child's view), its Run elsewhere button rides the bubble's edge. */
  private userRow(it: TranscriptItem): HTMLElement {
    const row = h('li', { class: isImageOnly(it) ? 'tx-item tx-user tx-imgonly' : 'tx-item tx-user' }, this.parts(it, 'tx-bubble'));
    if (!this.host.onRerun || this.host.child || !textOf(it).trim()) return row;
    row.classList.add('tx-can-rerun');
    const btn = h(
      'button',
      { class: 'tx-rerun', 'data-key': 'rerun', title: 'Send this message to a new worker on another harness or model', onclick: () => void this.rerun(it.id, btn) },
      duotone('fork'),
      'Run elsewhere',
    );
    row.append(btn);
    return row;
  }

  /** The conversation's first message you wrote, by `seq` (an older page loads later); answers and blank ones are not messages. */
  private firstMessage(): TranscriptItem | null {
    let first: TranscriptItem | null = null;
    for (const it of this.timeline.values()) if (it.kind === 'user' && !isAnswers(it.answers) && textOf(it).trim() && (!first || it.seq < first.seq)) first = it;
    return first;
  }

  /** Run elsewhere: the message's whole text (a truncated one is loaded first), then the host's picker. */
  private async rerun(id: string, anchor: HTMLElement | null): Promise<void> {
    const on = this.host.onRerun;
    let it = this.timeline.get(id);
    if (!on || !it) return;
    if (it.truncated && this.host.loadItem) it = (await this.host.loadItem(id)) ?? it;
    const text = textOf(it);
    const images = (Array.isArray(it.parts) ? it.parts : []).some((p) => isImagePart(p) || isOmittedPart(p));
    if (text.trim()) on(text, this.firstMessage()?.id === id, anchor?.isConnected ? anchor : null, images);
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
        box.append(this.withSecretChips(md));
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
    // Its images show once the agent has them: until then the marker reads as the number it will have. #108: protected
    // values never show (`shown`).
    setMarkdown(md, (p.shown ?? p.text).replace(/\[Image #(\d+): [^\]\n]+\]/g, '[Image #$1]'));
    // #108 round 4: once the bridge said what it sent, its references to protected files are chips.
    this.withSecretChips(md);
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
      row.append(h('span', { class: 'tx-chip tx-chip-mute', title: 'The reasoning is encrypted: nothing to show' }, duotone(TX_ICON.brain), 'reasoning'));
      return row;
    }
    // Often the agent's own narration (Claude Code writes it as a thinking block, Codex as a reasoning summary): shown
    // as it is, dimmed, not behind a click. Not a tool row, so "Hide tool calls" leaves it.
    const body = h('div', { class: 'tx-thinking-body tx-md' });
    setMarkdown(body, text);
    row.append(h('span', { class: 'tx-thinking-tag' }, duotone(TX_ICON.brain), 'summary'), body);
    return row;
  }

  private toolRow(it: TranscriptItem, scope: string): HTMLElement {
    const t = it.tool as NonNullable<TranscriptItem['tool']>;
    const status = typeof t.status === 'string' ? t.status : 'running';
    const row = h('li', { class: 'tx-item tx-tool', 'data-status': status });
    const dur = this.toolDuration(it, status);
    // #132: a poll the view did not see finish: how long it waited is how long it took.
    const wall = t.terminal?.wall_seconds;
    if (status !== 'running' && !dur.textContent && typeof wall === 'number' && wall >= 0) dur.textContent = duration(wall * 1000);
    const diffs = this.diffsOf(it, t, scope);
    // A file recorded without lines (no_diff) counts nothing: no "+0 −0" for an overwrite whose lines are unknown.
    const counted = diffs.filter((d) => d.no_diff !== true);
    const stat = counted.length ? counted.map((d) => diffStat(d.hunks)).reduce((a, b) => ({ add: a.add + b.add, del: a.del + b.del })) : null;
    const term = terminalTag(t.terminal);
    const head = h(
      'button',
      { class: term ? 'tx-tool-row tx-tool-row-term' : 'tx-tool-row', 'aria-expanded': 'false' },
      h('span', { class: 'tx-tool-icon' }, duotone(toolIcon(String(t.name ?? '')))),
      h('span', { class: 'tx-tool-name' }, String(t.name ?? 'tool')),
      h('span', { class: 'tx-tool-sum' }, String(t.input_summary ?? '')),
      term,
      stat ? statEl(stat.add, stat.del) : null,
      h('span', { class: 'tx-tool-status' }, STATUS_TEXT[status] ?? status),
      dur,
      h('span', { class: 'tx-caret' }, duotone(TX_ICON.chevron)),
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

  /** How long a call has run (ticking), or took if it finished while shown. */
  private toolDuration(it: TranscriptItem, status: string): HTMLElement {
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
    return dur;
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
        const text = `${more}${diffs.length ? ' more' : ''} ${more === 1 ? 'file' : 'files'} changed, no diff recorded`;
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
      // #21: a running script's patches that are not plain text: nothing to show until Codex applies them.
      const n = computed(c);
      if (n > 0) {
        const what = diffs.length ? (n === 1 ? '1 more patch is' : `${n} more patches are`) : n === 1 ? 'Its patch is' : `Its ${n} patches are`;
        box.append(h('div', { class: 'tx-chg-note' }, `${what} built by the script, not written out: the changes show once Codex applies ${n === 1 ? 'it' : 'them'}.`));
      }
    }
    return box;
  }

  /** #171: one changed file: a header (path, what happened, counts) that opens and closes its diff. */
  private changeFile(d: TranscriptDiff, key: string, load: (() => void) | null): HTMLElement {
    const hunks = Array.isArray(d.hunks) ? d.hunks : [];
    const { add, del } = diffStat(hunks);
    const op = typeof d.op === 'string' ? OP_TAG[d.op] : undefined;
    const path = String(d.path ?? '');
    // #21: a renamed file says where it went (each path gives way on its own; the title has both whole).
    const to = d.op === 'rename' && typeof d.to === 'string' && d.to !== '' ? d.to : '';
    const head = h(
      'button',
      { class: 'tx-chg-head', title: to ? `${path} → ${to}` : path },
      h('span', { class: 'tx-caret' }, duotone(TX_ICON.chevron)),
      h('span', { class: to ? 'tx-diff-path tx-chg-from' : 'tx-diff-path' }, path),
      to ? h('span', { class: 'tx-diff-path tx-chg-to' }, h('span', { class: 'tx-chg-arrow' }, '→ '), to) : null,
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
      if (d.no_diff === true || !hunks.length) body.append(h('div', { class: 'tx-chg-note' }, emptyNote(d)));
      else body.append(diffLines(d, this.diffShown.get(key) ?? MAX_DIFF_LINES, (change) => this.keepPlace(change), (n) => this.diffShown.set(key, n), (el, draw) => this.later(el, draw)));
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

  /**
   * #56: a Codex collaboration call or inter-agent message: a header that says what happened in words ("Spawn subagent
   * gpu_research on gpt-6.1-sol high"), never the tool's namespaced name or the message's ciphertext. Opened: the facts
   * the source said, the message (or that it is encrypted), then the call as Codex recorded it behind a collapsed "Raw
   * request". A plain reply shows under its header, as the agent said it.
   */
  private collabRow(listed: TranscriptItem, scope: string, listedCollab: TranscriptCollab): HTMLElement {
    // Loaded in full before (Raw request, the whole message): drawn from that while it is the same call.
    const full = this.fullCollab.get(this.fullKey(listed, scope));
    const whole = full && isCollab(full.collab) && full.kind === listed.kind && full.tool?.status === listed.tool?.status;
    const it = whole ? full : listed;
    const c = whole && isCollab(full.collab) ? full.collab : listedCollab;
    const t = it.kind === 'tool' ? it.tool : undefined;
    const status = t ? (typeof t.status === 'string' ? t.status : 'running') : '';
    const { verb, bits } = collabHead(c, typeof t?.output_text === 'string' ? t.output_text : '');
    const row = h('li', { class: t ? 'tx-item tx-tool tx-collab' : 'tx-item tx-tool tx-collab tx-collab-in', 'data-collab': c.kind, 'data-status': status || null });
    const sum = h('span', { class: 'tx-tool-sum tx-collab-sum' }, ...bits.map((b) => (typeof b === 'string' ? b : h('span', { class: 'tx-collab-id' }, b.id))));
    const head = h(
      'button',
      { class: 'tx-tool-row', 'aria-expanded': 'false' },
      h('span', { class: 'tx-tool-icon' }, duotone(TX_ICON.agent)),
      h('span', { class: 'tx-tool-name tx-collab-verb' }, verb),
      sum,
      t ? h('span', { class: 'tx-tool-status' }, STATUS_TEXT[status] ?? status) : null,
      t ? this.toolDuration(it, status) : null,
      h('span', { class: 'tx-caret' }, duotone(TX_ICON.chevron)),
    );
    head.title = `${verb} ${sum.textContent ?? ''}`.trim();
    const prompt = text(c.prompt);
    const said = !t && prompt ? h('div', { class: 'tx-said tx-collab-said' }) : null;
    if (said) {
      const md = h('div', { class: 'tx-md' });
      setMarkdown(md, prompt);
      said.append(md);
      if (it.truncated) said.append(this.collabCut(it, scope, md));
    }
    const body = h('div', { class: 'tx-tool-body' });
    const ex = this.expander(`${scope}/${it.id}`, (open) => {
      if (open && !body.childNodes.length) this.fillCollab(body, it, scope, c, t, !said);
      body.hidden = !open;
    });
    head.setAttribute('aria-expanded', String(ex.open));
    head.addEventListener('click', () => ex.toggle(head));
    body.hidden = !ex.open;
    if (ex.open) this.fillCollab(body, it, scope, c, t, !said);
    row.append(head);
    if (said) row.append(said);
    row.append(body);
    return row;
  }

  /** #56: an opened collab row: its facts, its message (or the encrypted note), then the raw call, closed. */
  private fillCollab(body: HTMLElement, it: TranscriptItem, scope: string, c: TranscriptCollab, t: TranscriptItem['tool'] | undefined, withPrompt: boolean): void {
    const fields = collabFields(c);
    if (fields.length) body.append(h('dl', { class: 'tx-collab-fields' }, ...fields.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])));
    const prompt = text(c.prompt);
    if (withPrompt && prompt) {
      const md = h('div', { class: 'tx-md tx-collab-prompt' });
      setMarkdown(md, prompt);
      body.append(h('div', { class: 'tx-label' }, 'Message'), md);
      if (it.truncated) body.append(this.collabCut(it, scope, md));
    } else if (!prompt && c.encrypted === true) body.append(h('div', { class: 'tx-note' }, COLLAB_ENCRYPTED));
    if (!t) {
      if (!body.childNodes.length) body.append(h('div', { class: 'tx-note' }, 'Nothing more recorded.'));
      return;
    }
    body.append(this.collabRaw(it, scope, t));
    if (t.status === 'running') body.append(h('div', { class: 'tx-note' }, 'Still running…'));
  }

  /**
   * #56: the call as Codex recorded it, behind a collapsed "Raw request" that every call has. Arguments the list left out
   * (above MaxInput) or an output it cut are loaded whole (`transcript.item`) the first time it opens; nothing in it is
   * clipped (it wraps and scrolls instead).
   */
  private collabRaw(it: TranscriptItem, scope: string, t: NonNullable<TranscriptItem['tool']>): HTMLElement {
    const box = h('div', { class: 'tx-collab-rawbody' });
    const raw = h('details', { class: 'tx-ans-raw tx-collab-raw' }, h('summary', {}, 'Raw request'), box);
    const draw = (tool: NonNullable<TranscriptItem['tool']>, loaded = false) => {
      box.replaceChildren();
      if (tool.input !== undefined && tool.input !== null) box.append(h('div', { class: 'tx-label' }, 'Arguments'), h('pre', {}, jsonOf(tool.input)));
      else box.append(h('div', { class: 'tx-note' }, loaded ? 'No arguments recorded.' : 'The arguments were too large to send with the list.'));
      if (typeof tool.output_text === 'string' && tool.output_text.length) box.append(h('div', { class: 'tx-label' }, 'Output'), h('pre', {}, stripAnsi(tool.output_text)));
      else box.append(h('div', { class: 'tx-note' }, tool.status === 'running' ? 'No output yet.' : 'No output.'));
      if (tool.output_truncated) box.append(h('div', { class: 'tx-note' }, 'Output truncated: only the start is shown.'));
    };
    const missing = t.input === undefined || t.input === null || t.output_truncated === true;
    if (!missing || !this.host.loadItem) {
      draw(t);
      return raw;
    }
    box.append(h('div', { class: 'tx-note' }, 'Loading…'));
    let asked = false;
    raw.addEventListener('toggle', () => {
      if (!raw.open || asked) return;
      asked = true;
      this.loadCollab(it, scope).then(
        (full) => {
          if (this.destroyed) return;
          if (!full?.tool) return this.rawFailed(box, draw, t, 'it is no longer in the transcript');
          draw(full.tool, true);
        },
        (e: unknown) => {
          if (!this.destroyed) this.rawFailed(box, draw, t, e instanceof Error ? e.message : String(e ?? 'failed'));
        },
      );
    });
    return raw;
  }

  /** #56: the whole request did not load: what the list has, and why the rest is not there. */
  private rawFailed(box: HTMLElement, draw: (tool: NonNullable<TranscriptItem['tool']>) => void, t: NonNullable<TranscriptItem['tool']>, why: string): void {
    draw(t);
    box.prepend(h('div', { class: 'tx-note tx-err' }, `The whole request could not be loaded: ${why}`));
  }

  /** #56: a message the list cut (64 KiB): says so, with a link to the whole of it when the host can load one item. */
  private collabCut(it: TranscriptItem, scope: string, md: HTMLElement): HTMLElement {
    const note = h('div', { class: 'tx-note' }, 'Truncated: only the start is shown.');
    if (!this.host.loadItem) return note;
    const link = h('button', { class: 'tx-link' }, 'Show the whole message');
    const slot = h('span', { class: 'tx-collab-load' }, ' ', link);
    const fail = (why: string) => slot.replaceChildren(' ', h('span', { class: 'tx-err' }, `The whole message could not be loaded: ${why}`));
    link.addEventListener('click', () => {
      link.disabled = true;
      link.textContent = 'Loading…';
      this.loadCollab(it, scope).then(
        (full) => {
          if (this.destroyed) return;
          const whole = isCollab(full?.collab) ? text(full.collab.prompt) : '';
          if (!whole) return fail('it is no longer in the transcript');
          setMarkdown(md, whole);
          note.remove();
        },
        (e: unknown) => {
          if (!this.destroyed) fail(e instanceof Error ? e.message : String(e ?? 'failed'));
        },
      );
    });
    note.append(slot);
    return note;
  }

  /** #56: a collaboration item in full, kept for the row's next drawing (collabRow uses it while the call's status holds). */
  private loadCollab(it: TranscriptItem, scope: string): Promise<TranscriptItem | null> {
    const load = this.host.loadItem;
    if (!load) return Promise.resolve(null);
    let p: Promise<TranscriptItem | null>;
    try {
      p = Promise.resolve(load(it.id, this.scopeAgent.get(scope)));
    } catch (e) {
      p = Promise.reject(e);
    }
    return p.then((full) => {
      if (full && isCollab(full.collab)) this.fullCollab.set(this.fullKey(it, scope), full);
      return full;
    });
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
      h('span', { class: 'tx-tool-icon' }, duotone(TX_ICON.agent)),
      h('span', { class: 'tx-tool-name' }, 'Subagent'),
      h('span', { class: 'tx-tool-sum' }, String(s.description ?? '')),
      h('span', { class: 'tx-tool-status' }, String(s.status ?? '')),
      this.subDuration(it, String(s.status ?? '')),
      h('span', { class: 'tx-caret' }, duotone(TX_ICON.chevron)),
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
    this.syncHandoff(); // #223
    this.syncCommandRequest();
    if (initial || this.following) {
      this.stick(true);
      this.fileRefs.place(); // #31: its reference's row may be drawn anew, or scrolled away
      return;
    }
    this.fileRefs.place();
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

  /**
   * #126: rows `change` puts in above the others leave the ones on the screen where they were: the bottom stays as far
   * away as it was (an absolute target, which a scroll anchoring correction cannot add to), or following, the bottom.
   */
  private holdBottom(change: () => void): void {
    const s = this.scroller;
    const below = s.scrollHeight - s.scrollTop;
    change();
    if (this.following) this.stick(true);
    else s.scrollTop = s.scrollHeight - below;
  }

  /** #126: the rows built so far leave the view (and a little above it) to fill. */
  private room(): boolean {
    const s = this.scroller;
    return s.clientHeight > 0 && s.scrollHeight < s.clientHeight * 1.25;
  }

  /** #126: the backfill built the last row: what looks for a row anywhere in the timeline looks again; the diffs put off are drawn. */
  private filled(): void {
    if (this.destroyed) return;
    this.root.removeAttribute('data-building');
    this.syncHandoff();
    this.syncCommandRequest();
    this.fileRefs.place();
    this.updateCounts();
    this.stick();
    this.drawSoon();
  }

  /**
   * #126: `el`'s lines are drawn with `step` once it comes near the view, or once the open settles (all the rows built),
   * keeping the reader's place; false: no IntersectionObserver, not put off.
   */
  private later(el: HTMLElement, step: DiffStep): boolean {
    if (typeof IntersectionObserver === 'undefined') return false;
    this.lazyIO ??= new IntersectionObserver(
      (entries) => {
        let near = false;
        for (const e of entries) {
          if (!e.isIntersecting) {
            this.far.add(e.target);
            continue;
          }
          this.far.delete(e.target);
          this.lazyIO?.unobserve(e.target);
          const f = this.lazyDraw.get(e.target);
          this.lazyDraw.delete(e.target);
          if (f) this.drawQueue.push([e.target, f]);
          // One drawn as away from the view came near: the rest of it at a near one's pace.
          if (this.draining?.[0] === e.target) {
            this.drawQueue.push(this.draining);
            this.draining = null;
          }
          near = true;
        }
        // The far ones wait for the frames' drawing (`drawSoon`); what came near is drawn now.
        if (near) this.drawDue();
      },
      { root: this.scroller, rootMargin: '100% 0px' },
    );
    this.lazyDraw.set(el, step);
    this.lazyIO.observe(el);
    this.root.setAttribute('data-drawing', '');
    if (!this.timeline.building) this.drawSoon();
    return true;
  }

  /**
   * #126: draws the lines put off, DIFF_NEAR or DIFF_FRAME of them (and `backfill.budgetMs`) per frame, the reader's place
   * (or the bottom) kept: the ones near the view first, then, once the open settles, the others newest first, one diff at
   * a time.
   */
  private drawDue(): void {
    if (this.destroyed) return;
    const start = backfill.now();
    let lines = 0;
    this.keepPlace(() => {
      while (lines < DIFF_FRAME && backfill.now() - start < backfill.budgetMs) {
        const near = this.drawQueue[0];
        if (near && lines >= DIFF_NEAR) break;
        const next = near ?? (this.timeline.building ? null : (this.draining ??= this.nextLazy()));
        if (!next) break;
        // A body whose row is gone (drawn anew, a resync) is dropped.
        const { drawn, done } = next[0].isConnected ? next[1]((near ? DIFF_NEAR : DIFF_FRAME) - lines) : { drawn: 0, done: true };
        lines += drawn;
        if (!done) continue;
        if (near) this.drawQueue.shift();
        else this.draining = null;
        this.lazyIO?.unobserve(next[0]);
      }
    });
    this.stick();
    this.drawn();
    if (this.drawQueue.length || ((this.draining || this.lazyDraw.size) && !this.timeline.building)) this.drawSoon();
  }

  /**
   * #126: once the open settled, the next diff put off, in the order they were built, of those the observer said are away
   * from the view (a body near it but not reported yet would be drawn and laid out at the far pace). It stays observed
   * until drawn.
   */
  private nextLazy(): [Element, DiffStep] | null {
    for (const [el, step] of this.lazyDraw) {
      if (!el.isConnected) {
        this.lazyDraw.delete(el);
        this.lazyIO?.unobserve(el);
        continue;
      }
      if (!this.far.has(el)) continue;
      this.lazyDraw.delete(el);
      return [el, step];
    }
    return null;
  }

  /** #126: the rest of a body's lines put off, now (End on it). */
  private drawAll(el: Element): void {
    const i = this.drawQueue.findIndex(([b]) => b === el);
    const step = i >= 0 ? this.drawQueue.splice(i, 1)[0]?.[1] : this.draining?.[0] === el ? this.draining[1] : this.lazyDraw.get(el);
    if (!step) return;
    if (this.draining?.[0] === el) this.draining = null;
    this.lazyDraw.delete(el);
    this.lazyIO?.unobserve(el);
    this.keepPlace(() => step(Infinity));
    this.drawn();
  }

  /** #126: `data-drawing` while lines are still to draw. */
  private drawn(): void {
    this.root.toggleAttribute('data-drawing', this.drawQueue.length > 0 || this.draining !== null || this.lazyDraw.size > 0);
  }

  /** #126: `drawDue` after the next frame (one at a time). */
  private drawSoon(): void {
    if (this.drawing || this.destroyed) return;
    this.drawing = true;
    void backfill.yield().then(() => {
      this.drawing = false;
      this.drawDue();
    });
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
    // #126: empty only once the watch said so; until then the conversation is opening. So it is while the rows built so
    // far all hide (Hide tool calls) and one still to build shows; a page where none shows is blank, as before #126.
    this.empty.hidden = n > 0 || this.pendingRows.length > 0 || this.loading;
    this.loader.hidden = n > 0 ? !this.timeline.building || !this.timeline.opening((it) => this.rowShows(it)) : !this.loading;
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
      this.updateCounts(); // #126: while rows are built, whether one shows yet
    }
    this.zoomBtns.reset.textContent = `${zoom}%`;
    this.zoomBtns.reset.setAttribute('aria-label', `Text size ${zoom}%${zoom === ZOOM.reset ? '' : ', back to 100%'}`);
    this.zoomBtns.out.disabled = zoom <= ZOOM.min;
    this.zoomBtns.in.disabled = zoom >= ZOOM.max;
    this.renderBusy();
    this.renderJump();
    // New sizes (a zoom, another preset's fonts) move the bottom: a view that followed it keeps following.
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
    if (this.showSystem) this.timeline.buildSystem(); // #126: built the first time they show
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

  /**
   * #171: a diff body's keys (PageUp/PageDown, Space, the arrows, Home/End, j/k); false: not one of them. Where the body
   * goes no further that way (and on Home/End), the timeline moves toward the body's edge that way while it is out of
   * view, on either side, a key's step at a time, so its first and last lines always come into view (a body taller than
   * the view: a large zoom, a short screen; a body the view left behind: a resize).
   */
  private scrollLines(el: HTMLElement, e: KeyboardEvent): boolean {
    const page = Math.max(40, el.clientHeight * 0.9);
    let dy: number; // down +, up −; Home/End: all the way
    switch (e.key) {
      case 'PageUp':
        dy = -page;
        break;
      case 'PageDown':
        dy = page;
        break;
      case ' ':
        dy = e.shiftKey ? -page : page;
        break;
      case 'Home':
        dy = -Infinity;
        break;
      case 'End':
        this.drawAll(el); // #126: its last line, not the last drawn so far
        dy = Infinity;
        break;
      case 'j':
      case 'ArrowDown':
        dy = 48;
        break;
      case 'k':
      case 'ArrowUp':
        dy = -48;
        break;
      case 'ArrowLeft':
        el.scrollLeft -= 48;
        return true;
      case 'ArrowRight':
        el.scrollLeft += 48;
        return true;
      default:
        return false;
    }
    const before = el.scrollTop;
    if (Number.isFinite(dy)) el.scrollTop += dy;
    else el.scrollTop = dy > 0 ? el.scrollHeight : 0;
    if (Number.isFinite(dy) && el.scrollTop !== before) return true;
    // The edge the key heads for, clipped on its side of the view (the timeline follows it), or past the other side with
    // its line out of view (the body gone by after a resize: the timeline comes back for it). It lands on the view's
    // edge on that side: the bottom edge on the view's bottom, the top on its top.
    const view = this.scroller.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const edge = dy > 0 ? box.bottom : box.top;
    const line = Math.min(box.height, (dy > 0 ? el.lastElementChild : el.firstElementChild)?.getBoundingClientRect().height ?? 0);
    const out = dy > 0 ? edge > view.bottom || edge - line < view.top : edge < view.top || edge + line > view.bottom;
    const move = out ? edge - (dy > 0 ? view.bottom : view.top) : 0;
    if (move) this.scrollBy(Math.sign(move) * Math.min(Math.abs(move), Math.abs(dy)));
    return true;
  }

  private onKey(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.target === this.input) return;
    const target = e.target as HTMLElement | null;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // A focused button keeps Enter / Space (it opens its row); the game does not see them.
    if ((e.key === 'Enter' || e.key === ' ') && target?.closest('button, a, summary')) {
      e.stopPropagation();
      return;
    }
    // #171: a changed file's lines, focused, scroll themselves (not the timeline) with the timeline's keys.
    const lines = target?.closest<HTMLElement>('.tx-diff-body');
    if (lines && this.scrollLines(lines, e)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // #187: Q opens the questions' sheet while its button shows (the cards' keys are the sheet's, in it).
    if (e.code === 'KeyQ' && !e.shiftKey && !target?.closest('input, textarea, select, [contenteditable]') && this.questions.canOpen) {
      e.preventDefault();
      e.stopPropagation();
      this.questions.open();
      return;
    }
    // Run elsewhere: R picks the conversation's first message (the hover button picks any other).
    if (e.code === 'KeyR' && !e.shiftKey && !e.repeat && this.host.onRerun && !this.host.child && !target?.closest('input, textarea, select, [contenteditable]')) {
      const first = this.firstMessage();
      if (first) {
        e.preventDefault();
        e.stopPropagation();
        const btn = this.timeline.el.querySelector<HTMLElement>(`[data-id="${CSS.escape(first.id)}"] .tx-rerun`);
        void this.rerun(first.id, btn);
        return;
      }
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
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  private onInputKey(e: KeyboardEvent): void {
    // Esc is the shell's as everywhere in the seated view (a bare one stands you up, Ctrl/Cmd+Esc goes back to the
    // terminal), and the text zoom (#59) works from here too; every other key typed here is the prompt's.
    // #216: the seat's chords (a view, the files drawer) too.
    if (e.key === 'Escape' || zoomKey(e) || seatChord(e)) return;
    e.stopPropagation();
    // #108: the review of the prompt's secrets, now.
    if (reviewKey(e) && this.host.secrets?.on) {
      e.preventDefault();
      if (!e.repeat) this.submit(true);
      return;
    }
    // Enter sends and Shift+Enter adds a line: the composer's own key handling (submitPolicy 'enter').
  }

  /** #141, #247: the `@` source: the worker's files, and with `repos` the other floors' repositories behind `r:`. */
  private atSources(host: TranscriptRenderHost): Source[] {
    if (!host.files) return [];
    const files = fileSource(host.files.id, host.files.search);
    return [(host.repos ? atSource(files, repoSource(host.repos.id, host.repos.search)) : files) as Source];
  }

  /** `review` (#108): "Review secrets": the host reviews the prompt's possible secrets even when the scan finds none. */
  private submit(review = false): void {
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
    void this.send(draft, review);
  }

  /**
   * The images first (waited for, the box read-only meanwhile; one that did not upload stops it, its chip has the
   * Retry), then the prompt. Not sent (refused, too long, an image failed): the box keeps what was written.
   */
  private async send(draft: PromptDraft, review: boolean): Promise<void> {
    try {
      const r = await draft.resolve({ maxBytes: WORKER_PROMPT_MAX_BYTES });
      if (this.destroyed) return;
      if (!r.ok) {
        const why = notSentText(r, { nothing: 'sent', again: 'send' });
        if (why) this.composer.notice(why, 'error');
        return;
      }
      this.composer.clearNotice();
      const sent = await Promise.resolve(review ? this.host.onPromptSubmit(r.text, { review }) : this.host.onPromptSubmit(r.text)).catch(() => false);
      // Sent: the box is empty again (an edit made meanwhile is impossible while it is read-only, but a draft swap is
      // not). #141: also when the view went meanwhile: the host keeps the worker's draft for its next view.
      if (sent !== false) draft.clearIf(r.revision);
    } finally {
      // #141: the gate is the draft's, not this view's: it opens whether this view, a later one or none is up.
      this.sending.set(false);
    }
  }

  // --- the prompt box while the agent waits ---

  /**
   * A blocked worker takes no prompt (the bridge refuses it): an ask or the screen's question waits, in the questions'
   * sheet (open or not: its button says so) or in the terminal. A draft stays. Disabling the focused box or button would
   * drop the keyboard on <body>: it goes to the timeline instead, once, as the question arrives (a disabled control
   * never has focus later, so re-renders leave focus alone).
   */
  private renderPrompt(): void {
    const waiting = this.ask.shown || !!this.blocked;
    this.waiting = waiting;
    const a = document.activeElement;
    if (waiting && (this.input.contains(a) || a === this.sendBtn)) this.scroller.focus({ preventScroll: true });
    this.promptOff = waiting;
    this.composer.setDisabled(waiting);
    this.composer.setPlaceholder(waiting ? WAITING_HINT : PROMPT_HINT);
    this.sendBtn.disabled = waiting;
    this.reviewBtn.disabled = waiting;
  }
}
