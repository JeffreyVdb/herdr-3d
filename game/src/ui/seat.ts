import type { CodexNotice } from '../world/codexServer';
import type { Display } from '../world/derive';
import './seat.css';
import './secretChips.css';
import './seatRail.css';
import { secretFilesText } from '../world/revokeSecrets';
import type { RunAttention } from '../world/manualProcess';
import { duotone, type DuotoneName } from './duotone';
import { NeedsYouLine } from './needsYou';
import type { SeatView } from '../laptop';
import { FILES_KEY, LOOK_KEY } from '../laptop/keys';
import type { FullscreenChip } from '../laptop/fullscreen';
import type { SeatMode } from '../laptop/transcriptMode';
import { filesOf } from './composer/field';
import type { ViewPrefs } from './themePrefs';
import { stepZoom, THEMES, ZOOM, type ThemeId } from './themes';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function key(k: string[], label: string): HTMLSpanElement {
  const s = el('span', 'key');
  for (const part of k) s.append(el('kbd', '', part));
  s.append(document.createTextNode(label));
  return s;
}

/** #216: the rail's views, in their order (Ctrl+Shift+1…4): the icon, the rail's word and the view's own name. */
const VIEWS: ReadonlyArray<{ mode: SeatMode; icon: DuotoneName; word: string; name: string }> = [
  { mode: 'terminal', icon: 'terminal', word: 'Terminal', name: 'Terminal' },
  { mode: 'transcript', icon: 'chat', word: 'Chat', name: 'Conversation' },
  { mode: 'images', icon: 'image', word: 'Images', name: 'Images' },
  { mode: 'runs', icon: 'play', word: 'Runs', name: 'Runs' },
];
const VIEW_WORD: Record<SeatMode, string> = { terminal: 'Terminal', transcript: 'Chat', images: 'Images', runs: 'Runs' };

/** #216: the rail's counts: Chat's things waiting for you, the session's images, this worker's runs (waiting, running). */
export interface RailCounts {
  chat: number;
  images: number | null;
  runs: { waiting: number; running: number };
}

/**
 * M5: what you see while you sit at a worker's laptop. #176: the **seated workspace**, an in-app surface over the whole
 * window (`position: fixed; inset: 0`, never the browser's Fullscreen API) like the floor overview: a compact header
 * (whose terminal it is on sun-yellow label-maker tape, the worker's status, the Terminal / Conversation / Images
 * switch, the terminal's preset and text size, Stand up), a line of notices under it when there is something to say (a
 * question, the Codex launch, a read-only terminal), the content area that fills the rest (the seated xterm, the
 * conversation, the images) and a footer with the keys. The game behind it is inert while it is up (the toasts and
 * the dialogs over it are not). A visually hidden textarea keeps the keyboard focus, so IME composition, the browser's
 * paste and copy land here; it is the one owner of the keyboard, the terminal widget never keeps it.
 * #59: the terminal's own preset and zoom (the transcript has its own, in its strip): swatches and A− / level / A+,
 * always in view; by keyboard Ctrl+, reaches them from any view (Esc goes back). #74: in the read-only fallback (#176:
 * another client owns the pane) a chip states a split pane's size and zooms herdr's tab; while you own the pane its
 * size is the window's and there is no chip.
 * #216: the view switch is a rail at the left (Terminal, Chat, Images, Runs with their counts; the Files drawer's toggle;
 * Host, the bridge host's runs, and Leave), each view has a 44 px strip at the top of the stage (the terminal's: its
 * preset, zoom and fullscreen chip), and the seated worker's runs that wait for you have a line of their own in the
 * notices (`NeedsYouLine`). Nothing the rail, the strips, the drawer or that line do moves the terminal's box sideways:
 * only the notices' row may change its rows (the debounced fit), never its columns.
 */
export class SeatBar implements SeatView {
  readonly el: HTMLDivElement;
  readonly input: HTMLTextAreaElement;
  private readonly tape = el('span', 'seat-tape');
  private readonly note = el('span', 'seat-note');
  private readonly keys = el('div', 'seat-keys');
  private readonly standBtn = el('button', 'seat-stand');
  /** #216: the rail (the views as tabs, the files toggle, Host and Leave) and the stage beside it. */
  readonly rail = el('nav', 'seat-rail');
  private readonly railTabs = el('div', 'seat-rail-tabs');
  private readonly viewBtns = {} as Record<SeatMode, HTMLButtonElement>;
  private readonly badges = {} as Record<SeatMode, HTMLSpanElement>;
  private readonly filesBtn = el('button', 'seat-rail-item seat-rail-files');
  private readonly hostBtn = el('button', 'seat-rail-item seat-rail-host');
  private readonly leaveBtn = el('button', 'seat-rail-item seat-rail-leave');
  private readonly main = el('div', 'seat-main');
  /** #216: the terminal's strip (its name, its preset, zoom and fullscreen chip), over the terminal in the stage. */
  private readonly termStrip = el('div', 'seat-strip seat-term-strip');
  private readonly termContext = el('span', 'seat-strip-sub');
  /** #216: the seated worker's runs that wait for you (the notices' first line). */
  private readonly needs: NeedsYouLine;
  private railKey = '';
  /** #216: the view Ctrl+Esc goes back to from the terminal (the keys line names it). */
  private last: SeatMode = 'transcript';
  /** #176: the header, the notices under it, the content area (the terminal's host and the conversation's layer). */
  readonly head = el('div', 'seat-head');
  private readonly notes = el('div', 'seat-notes');
  readonly content = el('div', 'seat-content');
  /** #176: where the seated xterm opens. */
  readonly termHost = el('div', 'seat-term');
  /** #176: the worker's status, on its tape. */
  private readonly statusTape = el('span', 'tape seat-status');
  /** #176: the terminal is read only (another client owns the pane). */
  private readonly roLine = el('div', 'seat-readonly');
  /** #176: the view is up herdr's history: how far, and the way back to the live bottom. */
  private readonly historyBtn = el('button', 'seat-history');
  private readonly historyText = el('span', 'seat-history-text');
  private inerted: HTMLElement[] = [];
  private returnFocus: HTMLElement | null = null;
  private anim: Animation | null = null;
  private covered = false;
  private leaving = false;
  /** #57: the line that says the agent asks a question (terminal mode). */
  private readonly askLine = el('div', 'seat-ask');
  /** #155: the line about the worker's own Codex server (in the ask line's place while no question shows). */
  private readonly codexLine = el('div', 'seat-codex');
  /** #139: the seated Codex worker's profile, under its server's line (both in the question's place). */
  private readonly profileLine = el('div', 'seat-profile');
  private readonly codexBox = el('div', 'seat-codex-box');
  /** #59: the terminal's preset and zoom. */
  private readonly look = el('div', 'seat-look');
  private readonly swatches: HTMLButtonElement[] = [];
  /** #74: the fullscreen chip (hidden while there is nothing to say), and what a click of it asks for. */
  private readonly fsBtn = el('button', 'seat-fs');
  private readonly fsText = el('span', 'seat-fs-text');
  private fsAction: FullscreenChip['action'] = null;
  /** #108 round 4: the seated worker's protected files (hidden while it holds none): a press asks to remove them. */
  private readonly manualRunBtn = el('button', 'secret-chip seat-manual-run', 'Run a command…');
  private readonly processesBtn = el('button', 'secret-chip seat-processes');
  /** #213: the agent's command suggestion waits out of sight (another view, scrolled away): a press shows it. */
  private readonly commandBtn = el('button', 'seat-cmdreq');
  private commandCount = 0;
  /** #213: the manual runs asking for you (a notice line), and what it last showed. */
  private readonly attnLine = el('div', 'seat-attn');
  private attnKey = '0 0';
  private ownAttention = 0;
  private processesCount = 0;
  private readonly secretsBtn = el('button', 'secret-chip seat-secrets');
  private readonly secretsCount = el('span', 'seat-secrets-n');
  /** The count's words: a phone's bar keeps the count alone (its name says the rest). */
  private readonly secretsText = el('span', 'secret-chip-word seat-secrets-word');
  private readonly zoomBtns: { out: HTMLButtonElement; level: HTMLButtonElement; in: HTMLButtonElement } | null = null;
  private name = '';
  private mac = false;
  private current: SeatMode = 'terminal';
  /** #26: the child whose conversation is open over the worker's (Esc goes back first, nothing is written there), or null. */
  private child: string | null = null;

  constructor(
    private readonly hud: HTMLElement,
    private readonly handlers: {
      text(t: string): void;
      paste(t: string, files?: File[]): void;
      stand(): void;
      toggle(): void;
      fullscreen?(action: 'zoom' | 'unzoom'): void;
      revoke?(from: HTMLElement): void;
      processes?(from: HTMLElement): void;
      manualRun?(from: HTMLElement): void;
      /** #213: the command suggestion's chip: the conversation, scrolled to the card, its first action focused. */
      review?(from: HTMLElement): void;
      /** #176: a view picked on the switch (#216: the rail). */
      mode?(m: SeatMode): void;
      /** #216: the rail's Files: the drawer opens or closes. */
      files?(): void;
      /** #216: the rail's Host: the bridge host's runs (the manual-processes dialog's whole list). */
      host?(from: HTMLElement): void;
      /** #216: the needs-you line: Respond (the run's password dialog), Open terminal (the Runs view on it), +N more. */
      respond?(id: string, from: HTMLElement): void;
      openRun?(id: string): void;
      runs?(): void;
      /** #216: where the keyboard goes when a control that had it went, or the rail's tab of the view that is up (the view). */
      refocus?(): void;
      /** #176: "Back to live": the terminal's view to the live bottom of herdr's history. */
      live?(): void;
      /** #176: the terminal's selected text, for a copy ('' or none: the browser's own copy). */
      selection?(): string;
    },
    private readonly prefs: ViewPrefs | null = null,
  ) {
    this.el = el('div', 'seat');
    this.el.hidden = true;
    this.el.setAttribute('role', 'region');
    this.el.setAttribute('aria-label', 'At a laptop');
    this.note.setAttribute('role', 'status');
    this.note.setAttribute('aria-live', 'polite');
    const line = el('div', 'seat-line');
    line.append(this.tape, this.note);
    if (handlers.revoke) {
      const revoke = handlers.revoke;
      this.secretsBtn.type = 'button';
      this.secretsBtn.hidden = true;
      this.secretsBtn.setAttribute('aria-haspopup', 'dialog');
      const ic = el('span', 'secret-chip-ic');
      ic.setAttribute('aria-hidden', 'true');
      ic.append(duotone('lock'));
      const tape = el('span', 'secret-chip-tape');
      tape.append(ic, this.secretsCount, this.secretsText);
      this.secretsBtn.append(tape);
      this.secretsBtn.addEventListener('click', () => revoke(this.secretsBtn));
      line.append(this.secretsBtn);
    }
    if (handlers.review) {
      this.commandBtn.type = 'button';
      this.commandBtn.hidden = true;
      this.commandBtn.addEventListener('click', () => handlers.review?.(this.commandBtn));
      line.append(this.commandBtn);
    }
    if (handlers.processes) {
      this.processesBtn.type = 'button';
      this.processesBtn.hidden = true;
      this.processesBtn.setAttribute('aria-haspopup', 'dialog');
      this.processesBtn.addEventListener('click', () => handlers.processes?.(this.processesBtn));
      line.append(this.processesBtn);
    }
    if (handlers.manualRun) {
      this.manualRunBtn.type = 'button';
      this.manualRunBtn.setAttribute('aria-haspopup', 'dialog');
      this.manualRunBtn.addEventListener('click', () => handlers.manualRun?.(this.manualRunBtn));
      line.append(this.manualRunBtn);
    }
    this.standBtn.type = 'button';
    this.standBtn.append(el('kbd', '', 'Esc'), document.createTextNode('Stand up'));
    this.standBtn.addEventListener('click', () => handlers.stand());
    this.buildRail();
    this.needs = new NeedsYouLine({
      respond: (id, from) => handlers.respond?.(id, from),
      terminal: (id) => handlers.openRun?.(id),
      more: () => handlers.runs?.(),
      refocus: () => (handlers.refocus ? handlers.refocus() : this.focus()),
    });
    this.input = el('textarea', 'seat-input');
    this.input.setAttribute('aria-label', 'Keyboard for the terminal');
    this.input.autocapitalize = 'off';
    this.input.spellcheck = false;
    this.input.setAttribute('autocomplete', 'off');
    this.input.tabIndex = -1;
    // Composed text (IME, dead keys): keydown let it through, it arrives here.
    this.input.addEventListener('compositionend', (e) => {
      if (e.data) handlers.text(e.data);
      this.input.value = '';
    });
    this.input.addEventListener('input', (e) => {
      const ie = e as InputEvent;
      if (!ie.isComposing && ie.inputType === 'insertText' && ie.data) handlers.text(ie.data);
      if (!ie.isComposing) this.input.value = '';
    });
    this.input.addEventListener('paste', (e) => {
      e.preventDefault();
      // #64: a screenshot on the clipboard comes as files (the text a copied file may carry is its name, not a paste).
      const files = filesOf(e.clipboardData);
      handlers.paste(e.clipboardData?.getData('text/plain') ?? '', files);
    });
    this.askLine.hidden = true;
    this.askLine.setAttribute('role', 'status');
    this.codexLine.hidden = true;
    this.codexLine.setAttribute('role', 'status');
    this.profileLine.hidden = true;
    this.profileLine.setAttribute('role', 'status');
    this.codexBox.append(this.codexLine, this.profileLine);
    this.statusTape.hidden = true;
    line.insertBefore(this.statusTape, this.note);
    this.roLine.hidden = true;
    this.roLine.setAttribute('role', 'status');
    this.historyBtn.type = 'button';
    this.historyBtn.hidden = true;
    this.historyBtn.append(duotone('down'), this.historyText, el('span', 'seat-history-act', 'Back to live'));
    this.historyBtn.addEventListener('click', () => {
      handlers.live?.();
      this.backToPane();
    });
    this.attnLine.append(this.needs.el);
    this.notes.append(this.attnLine, this.askLine, this.codexBox, this.roLine);
    this.termStrip.append(duotone('terminal', 'seat-strip-ic'), el('span', 'seat-strip-name', 'Terminal'), this.termContext);
    this.content.append(this.termStrip, this.termHost, this.historyBtn);
    this.content.id = 'seat-stage';
    this.main.append(this.rail, this.content);
    this.head.append(line, this.standBtn);
    this.el.dataset.rail = '';
    this.el.append(this.head, this.notes, this.main, this.keys, this.input);
    // #176: a copy while the seat has the keyboard (⌘C on a Mac, the browser's menu) takes the terminal's selection.
    this.el.addEventListener('copy', (e) => {
      const text = handlers.selection?.() ?? '';
      if (!text || this.current !== 'terminal' || !e.clipboardData) return;
      e.preventDefault();
      e.clipboardData.setData('text/plain', text);
    });
    if (prefs) {
      this.zoomBtns = this.buildLook(prefs, handlers.fullscreen);
      // #216: in the terminal's strip, at its end.
      this.termStrip.append(this.look);
      prefs.onChange((what) => {
        if (what === 'terminalTheme' || what === 'terminalZoom') this.renderLook();
      });
      this.renderLook();
    }
    hud.append(this.el);
  }

  /**
   * #216: the rail: the four views as a vertical tab list (one tab stop, ↑ ↓ Home End move, Enter or Space picks, a click
   * picks), a divider, the Files drawer's toggle, and at the bottom Host (the bridge host's runs) and Leave (Stand up).
   */
  private buildRail(): void {
    const h = this.handlers;
    this.rail.setAttribute('aria-label', 'Laptop');
    this.railTabs.setAttribute('role', 'tablist');
    this.railTabs.setAttribute('aria-orientation', 'vertical');
    this.railTabs.setAttribute('aria-label', 'View');
    for (const [i, v] of VIEWS.entries()) {
      const b = el('button', 'seat-rail-item seat-rail-view');
      b.type = 'button';
      b.dataset.mode = v.mode;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-controls', 'seat-stage');
      b.setAttribute('aria-keyshortcuts', `Control+Shift+${i + 1}`);
      b.title = `${v.name} (Ctrl+Shift+${i + 1})`;
      const n = el('span', 'seat-rail-badge');
      n.hidden = true;
      n.setAttribute('aria-hidden', 'true');
      b.append(duotone(v.icon, 'seat-rail-ic'), el('span', 'seat-rail-word', v.word), n);
      b.addEventListener('click', () => this.pick(v.mode));
      this.viewBtns[v.mode] = b;
      this.badges[v.mode] = n;
      this.railTabs.append(b);
    }
    this.railTabs.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const i = VIEWS.findIndex((v) => this.viewBtns[v.mode] === e.target);
      if (i < 0) return;
      const n = VIEWS.length;
      const to = e.key === 'ArrowDown' ? (i + 1) % n : e.key === 'ArrowUp' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
      if (to < 0) return;
      e.preventDefault();
      e.stopPropagation();
      for (const v of VIEWS) this.viewBtns[v.mode].tabIndex = -1;
      const b = this.viewBtns[(VIEWS[to] as (typeof VIEWS)[number]).mode];
      b.tabIndex = 0;
      b.focus();
    });
    const tool = (b: HTMLButtonElement, ic: DuotoneName, word: string) => {
      b.type = 'button';
      b.append(duotone(ic, 'seat-rail-ic'), el('span', 'seat-rail-word', word));
    };
    tool(this.filesBtn, 'files', 'Files');
    this.filesBtn.setAttribute('aria-pressed', 'false');
    this.filesBtn.setAttribute('aria-keyshortcuts', FILES_KEY.aria);
    this.filesBtn.title = `The worker’s files: Enter puts an @ reference in the prompt box (${FILES_KEY.label.join('+')})`;
    this.filesBtn.hidden = !h.files;
    this.filesBtn.addEventListener('click', () => h.files?.());
    tool(this.hostBtn, 'server', 'Host');
    this.hostBtn.setAttribute('aria-haspopup', 'dialog');
    this.hostBtn.hidden = !h.host;
    this.hostBtn.addEventListener('click', () => h.host?.(this.hostBtn));
    tool(this.leaveBtn, 'door', 'Leave');
    this.leaveBtn.setAttribute('aria-label', 'Stand up');
    this.leaveBtn.title = 'Stand up (Esc)';
    this.leaveBtn.addEventListener('click', () => h.stand());
    const sep = el('div', 'seat-rail-sep');
    sep.setAttribute('role', 'presentation');
    const foot = el('div', 'seat-rail-foot');
    foot.append(this.hostBtn, this.leaveBtn);
    this.rail.append(this.railTabs, sep, this.filesBtn, foot);
    this.hostName('');
  }

  /** A view picked on the rail: the one up gives the keyboard back to its view. */
  private pick(m: SeatMode): void {
    if (m === this.current) return this.handlers.refocus ? this.handlers.refocus() : this.backToPane();
    if (this.handlers.mode) this.handlers.mode(m);
    else this.handlers.toggle();
  }

  /** #216: the rail's Host names the bridge host ("Runs on kiswe-omarchy"). */
  hostName(host: string): void {
    const name = host ? `Runs on ${host}` : 'Runs on the bridge host';
    this.hostBtn.setAttribute('aria-label', name);
    this.hostBtn.title = `${name}: every worker’s manual runs`;
  }

  /** #216: the rail's counts (each in its tab's name too); the same counts draw nothing. */
  railCounts(c: RailCounts): void {
    const key = JSON.stringify(c);
    if (key === this.railKey) return;
    this.railKey = key;
    const set = (m: SeatMode, n: number, warn: boolean, said: string) => {
      const b = this.badges[m];
      b.hidden = n <= 0;
      b.textContent = n > 0 ? (n > 99 ? '99+' : String(n)) : '';
      b.toggleAttribute('data-warn', warn && n > 0);
      this.viewBtns[m].setAttribute('aria-label', n > 0 ? `${VIEW_WORD[m]}, ${said}` : VIEW_WORD[m]);
    };
    set('terminal', 0, false, '');
    set('transcript', c.chat, false, `${c.chat} waiting for you`);
    set('images', c.images ?? 0, false, `${c.images ?? 0} ${c.images === 1 ? 'image' : 'images'}`);
    const w = c.runs.waiting;
    if (w > 0) set('runs', w, true, `${w} waiting for you`);
    else set('runs', c.runs.running, false, `${c.runs.running} running`);
  }

  /** #216: the files drawer is open (the toggle is pressed). */
  filesOpen(on: boolean): void {
    this.filesBtn.setAttribute('aria-pressed', String(on));
  }

  /** #216: where the files drawer goes: over the stage, at the rail's edge (never in the grid's flow). */
  mountDrawer(drawer: HTMLElement): void {
    this.main.append(drawer);
  }

  /** #216: the seated worker's runs that wait for you, oldest first (the needs-you line; empty: it goes). */
  needsYou(list: readonly RunAttention[]): void {
    this.needs.set(list);
  }

  /** #216: what the terminal's strip says beside its name (the pane's grid, read only…; '' for nothing). */
  terminalContext(text: string): void {
    if (this.termContext.textContent !== text) this.termContext.textContent = text;
  }

  /** #216: the view Ctrl+Esc goes back to from the terminal (the keys line names it). */
  lastView(m: SeatMode): void {
    if (m === this.last || m === 'terminal') return;
    this.last = m;
    this.renderMode();
  }

  /** #59: "Terminal" and its three swatches (a radio group), then A− / level / A+. */
  private buildLook(prefs: ViewPrefs, fullscreen?: (action: 'zoom' | 'unzoom') => void): { out: HTMLButtonElement; level: HTMLButtonElement; in: HTMLButtonElement } {
    const group = el('div', 'seat-themes');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Terminal theme');
    group.setAttribute('aria-keyshortcuts', LOOK_KEY.aria);
    for (const t of THEMES) {
      const b = el('button', 'seat-theme');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.themeId = t.id;
      b.setAttribute('aria-label', t.label);
      b.title = `Terminal: ${t.label} (${t.mono.family}, ${t.blurb.split(',')[0]?.toLowerCase()})`;
      // A tiny screen in the preset's terminal colours: its background, a line of its text, its cursor.
      b.style.setProperty('--sw-bg', `#${t.screen.bg.toString(16).padStart(6, '0')}`);
      b.style.setProperty('--sw-fg', `#${t.screen.fg.toString(16).padStart(6, '0')}`);
      b.style.setProperty('--sw-ac', `#${t.screen.cursor.toString(16).padStart(6, '0')}`);
      b.append(el('span', 'seat-swatch'));
      b.addEventListener('click', () => {
        prefs.setTheme('terminal', t.id);
        this.backToPane();
      });
      this.swatches.push(b);
      group.append(b);
    }
    group.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const n = this.swatches.length;
      const i = this.swatches.findIndex((b) => b.dataset.themeId === prefs.theme('terminal'));
      const to = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (i + 1) % n : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
      if (to < 0) return;
      e.preventDefault();
      e.stopPropagation();
      const b = this.swatches[to] as HTMLButtonElement;
      prefs.setTheme('terminal', b.dataset.themeId as ThemeId);
      b.focus();
    });
    const zoom = el('div', 'seat-zoom');
    zoom.setAttribute('role', 'group');
    zoom.setAttribute('aria-label', 'Terminal text size');
    const btn = (cls: string, text: string, label: string | null, title: string, fn: () => void) => {
      const b = el('button', cls, text);
      b.type = 'button';
      if (label) b.setAttribute('aria-label', label);
      b.title = title;
      b.addEventListener('click', () => {
        fn();
        this.backToPane();
      });
      return b;
    };
    const out = btn('seat-zoom-btn', 'A−', 'Smaller terminal text', 'Smaller terminal text (Ctrl −)', () => prefs.setZoom('terminal', stepZoom(prefs.zoom('terminal'), -1)));
    const level = btn('seat-zoom-btn seat-zoom-level', '', null, 'Terminal text back to 100% (Ctrl 0)', () => prefs.setZoom('terminal', ZOOM.reset));
    const inc = btn('seat-zoom-btn', 'A+', 'Larger terminal text', 'Larger terminal text (Ctrl +)', () => prefs.setZoom('terminal', stepZoom(prefs.zoom('terminal'), 1)));
    zoom.append(out, level, inc);
    // Its label is its key, as the keys beside it are: Ctrl+, from any view (the pane keeps Tab).
    const label = key([...LOOK_KEY.label], 'Terminal');
    label.classList.add('seat-look-label');
    label.title = `The terminal’s theme and text size (${LOOK_KEY.label.join(' ')}; Esc goes back)`;
    this.fsBtn.type = 'button';
    this.fsBtn.hidden = true;
    this.fsBtn.append(el('span', 'seat-fs-dot'), this.fsText);
    this.fsBtn.addEventListener('click', () => {
      if (this.fsAction) fullscreen?.(this.fsAction);
      this.backToPane();
    });
    this.look.append(label, group, zoom, this.fsBtn);
    return { out, level, in: inc };
  }

  /** In terminal mode a click on the controls hands the keyboard straight back to the pane. */
  private backToPane(): void {
    if (this.current === 'terminal' && this.shown) this.focus();
  }

  private renderLook(): void {
    const p = this.prefs;
    const z = this.zoomBtns;
    if (!p || !z) return;
    for (const b of this.swatches) {
      const on = b.dataset.themeId === p.theme('terminal');
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    const level = p.zoom('terminal');
    z.level.textContent = `${level}%`;
    z.level.setAttribute('aria-label', `Terminal text size ${level}%${level === ZOOM.reset ? '' : ', back to 100%'}`);
    z.out.disabled = level <= ZOOM.min;
    z.in.disabled = level >= ZOOM.max;
  }

  /**
   * #108 round 4: how many protected files the seated worker holds (0: hide the chip; also on a bridge without
   * `prompt_secrets.revoke`). A press opens the confirmation that removes them.
   */
  manualProcesses(count: number, hasRecords: boolean): void {
    this.processesBtn.hidden = !hasRecords;
    this.manualRunBtn.hidden = hasRecords;
    this.processesCount = count;
    this.processesBtn.textContent = `${count} manual process${count === 1 ? '' : 'es'}`;
    this.nameProcesses();
  }

  /**
   * #213: how many commands the seated worker's agent suggests while its card is out of sight (0: hidden: none, or the
   * card is in view). Shown, it is the one click to the card; it never scrolls the conversation by itself.
   */
  commandRequest(n: number): void {
    if (n === this.commandCount) return;
    this.commandCount = n;
    this.commandBtn.hidden = n === 0;
    if (!n) return;
    const text = n === 1 ? 'Command to review' : `${n} commands to review`;
    this.commandBtn.replaceChildren(duotone('terminal'), document.createTextNode(text));
    this.commandBtn.setAttribute('aria-label', `${text}: the agent suggests ${n === 1 ? 'a command' : 'commands'} to run. Show the suggestion`);
    this.commandBtn.title = 'The agent’s reply suggests a command to run. Show it in the conversation.';
  }

  /**
   * #213: the attention chips, in the notices' row under the header. #216: this worker's runs have the needs-you line (it
   * comes first); the other workers' chip follows it.
   */
  mountAttention(others: HTMLElement): void {
    this.attnLine.append(others);
  }

  /**
   * #213: how many of the seated worker's runs ask for you, and of the other workers': the notices' row shows their chips,
   * and the manual-process control carries the mark (its name says it too).
   */
  attention(own: number, others: number): void {
    const key = `${own} ${others}`;
    if (key === this.attnKey) return;
    this.attnKey = key;
    if (own || others) this.el.dataset.attn = '';
    else delete this.el.dataset.attn;
    this.ownAttention = own;
    if (own) this.processesBtn.dataset.attn = '';
    else delete this.processesBtn.dataset.attn;
    this.nameProcesses();
  }

  private nameProcesses(): void {
    const own = this.ownAttention;
    this.processesBtn.setAttribute('aria-label', `${this.processesCount} manual processes${own ? `, ${own} asking for you` : ''}: open list`);
  }

  secretFiles(n: number): void {
    const on = n > 0 && !!this.secretsBtn.parentElement;
    this.secretsBtn.hidden = !on;
    if (!on) return;
    const what = secretFilesText(n);
    this.secretsCount.textContent = String(n);
    this.secretsText.textContent = what.slice(String(n).length);
    this.secretsBtn.setAttribute('aria-label', `${what}: remove them now…`);
    this.secretsBtn.title = `${this.name || 'This worker'} holds ${what} on the bridge host. Remove them now…`;
  }

  /** #74: the fullscreen chip's state (null: hide it, there is nothing to say about this pane). */
  setFullscreen(chip: FullscreenChip | null): void {
    this.fsAction = chip?.action ?? null;
    this.fsBtn.hidden = !chip;
    this.el.toggleAttribute('data-fs', !!chip);
    if (!chip) return;
    this.fsText.textContent = chip.label;
    this.fsBtn.setAttribute('aria-pressed', String(chip.pressed));
    this.fsBtn.setAttribute('aria-label', chip.aria);
    this.fsBtn.toggleAttribute('data-unavailable', chip.disabled);
    if (chip.disabled) this.fsBtn.setAttribute('aria-disabled', 'true');
    else this.fsBtn.removeAttribute('aria-disabled');
    this.fsBtn.title = chip.title;
  }

  /** #59: the keyboard to the terminal's picked preset (Ctrl+,); false when the bar has no controls. */
  focusLook(): boolean {
    const b = this.swatches.find((s) => s.getAttribute('aria-checked') === 'true');
    if (!b || this.el.hidden) return false;
    b.focus();
    return true;
  }

  /** #59: `t` is one of the terminal's preset and zoom controls (Esc there hands the keyboard back, see the controller). */
  inLook(t: EventTarget | null): boolean {
    return t instanceof Element && this.look.contains(t);
  }

  /**
   * #59: a control of the bar has the keyboard (its Tab, Enter, Space and arrows are its own, not the pane's). #176: so
   * has the read-only terminal once tabbed to: its arrows scroll it (the rest still types).
   */
  owns(t: EventTarget | null): boolean {
    return t instanceof Element && t !== this.input && this.el.contains(t) && (!!t.closest('button') || (t === this.termHost && t.hasAttribute('data-readonly')));
  }

  /**
   * Sits you down: the workspace grows out of `from` (the monitor's glass on your view; the middle when unknown), the
   * game behind it goes inert, the focus it had is kept for `hide`. With reduced motion it fades in.
   */
  show(name: string, mac: boolean, from: { left: number; top: number; width: number; height: number } | null = null): void {
    if (this.leaving) {
      // Up again while it shrank: it opens anew.
      this.leaving = false;
      this.anim?.cancel();
      this.anim = null;
      this.el.inert = false;
      this.el.hidden = true;
    }
    const was = !this.el.hidden;
    this.name = name;
    this.mac = mac;
    this.tape.textContent = `At ${name}’s laptop`;
    this.el.setAttribute('aria-label', `At ${name}’s laptop`);
    this.current = 'terminal';
    this.child = null;
    this.renderMode();
    this.status('ok', null);
    this.readOnly(null);
    this.history(null);
    this.el.hidden = false;
    this.hud.dataset.seated = '1';
    if (was) return;
    const active = document.activeElement;
    this.returnFocus = active instanceof HTMLElement && !this.el.contains(active) ? active : null;
    this.inertBackground(true);
    this.covered = false;
    void this.grow(true, from).then((done) => {
      if (done && !this.el.hidden) this.covered = true;
    });
  }

  /** #176: the workspace hides the whole scene (from the end of its grow until it goes): the game draws a few frames a second. */
  get covering(): boolean {
    return this.covered && !this.el.hidden && !this.leaving;
  }

  /** It is up (shown and not on its way out). */
  get shown(): boolean {
    return !this.el.hidden && !this.leaving;
  }

  /** While it is up, the game around it is inert: the canvas and the HUD's other parts, never the toasts or a dialog. */
  private inertBackground(on: boolean): void {
    for (const e of this.inerted) e.inert = false;
    this.inerted = [];
    if (!on) return;
    // Never a dialog, a toast or a popover (the plan-limits plate: Shift+L peeks it over the seat).
    const skip = (e: Element) => e === this.el || e.contains(this.el) || e.matches('dialog, script, .toast, [popover], [data-over-seat]') || (e as HTMLElement).inert;
    for (const e of [...this.hud.children, ...(this.hud.parentElement?.children ?? [])]) {
      if (!(e instanceof HTMLElement) || skip(e)) continue;
      // Of the page around the HUD only the scene's canvas: the overlays there open over the seat (the overview from
      // the conversation, the whiteboard) and are hidden while closed.
      if (e.parentElement !== this.hud && !(e instanceof HTMLCanvasElement)) continue;
      e.inert = true;
      this.inerted.push(e);
    }
  }

  /** The grow out of the monitor (a clip path: nothing inside is scaled, so the terminal measures true) and its reverse. */
  private grow(opening: boolean, from: { left: number; top: number; width: number; height: number } | null): Promise<boolean> {
    this.anim?.cancel();
    this.anim = null;
    if (typeof this.el.animate !== 'function') return Promise.resolve(true);
    const w = window.innerWidth;
    const h = window.innerHeight;
    const r = from ? { l: from.left, t: from.top, r: w - (from.left + from.width), b: h - (from.top + from.height) } : { l: w * 0.3, t: h * 0.3, r: w * 0.3, b: h * 0.3 };
    const small = `inset(${Math.max(0, r.t).toFixed(1)}px ${Math.max(0, r.r).toFixed(1)}px ${Math.max(0, r.b).toFixed(1)}px ${Math.max(0, r.l).toFixed(1)}px round 6px)`;
    const quiet = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const frames: Keyframe[] = quiet ? [{ opacity: 0 }, { opacity: 1 }] : [{ clipPath: small, opacity: 0.5 }, { clipPath: 'inset(0px 0px 0px 0px round 0px)', opacity: 1 }];
    const anim = this.el.animate(opening ? frames : [...frames].reverse(), { duration: quiet ? 120 : opening ? 300 : 220, easing: opening ? 'cubic-bezier(0.16, 1, 0.3, 1)' : 'cubic-bezier(0.7, 0, 0.84, 0)', fill: opening ? 'none' : 'forwards' });
    this.anim = anim;
    return anim.finished.then(
      () => this.anim === anim,
      () => false,
    );
  }

  /** #176: the worker's status on its tape (null: none to show). */
  workerStatus(display: Display | null): void {
    this.statusTape.hidden = !display;
    if (!display) return;
    const words: Record<Display, string> = { working: 'Working', done: 'Done', needs_you: 'Needs you', idle: 'Idle', asleep: 'Asleep', waiting: 'Waiting' };
    if (this.statusTape.dataset.display === display) return;
    this.statusTape.dataset.display = display;
    this.statusTape.className = `tape seat-status tape--${display}`;
    this.statusTape.textContent = words[display];
  }

  /** #176: the terminal is read only (another client owns the pane): what the line says, or null when the seat owns it. */
  readOnly(note: { text: string; title?: string } | null): void {
    this.roLine.hidden = !note;
    this.el.toggleAttribute('data-readonly', !!note);
    if (!note) {
      this.roLine.replaceChildren();
      return;
    }
    this.roLine.replaceChildren(el('span', 'seat-codex-tag', 'Read only'), el('span', 'seat-readonly-text', note.text));
    this.roLine.title = note.title ?? note.text;
  }

  /** #176: how far up herdr's history the terminal's view is (null or 0: at the live bottom, nothing shown). */
  history(h: { offset: number; max: number } | null): void {
    const up = h && h.offset > 0 ? h.offset : 0;
    this.historyBtn.hidden = !up;
    if (!up) return;
    const what = `${up} ${up === 1 ? 'line' : 'lines'} up`;
    this.historyText.textContent = what;
    this.historyBtn.setAttribute('aria-label', `${what} in the history. Back to live`);
    this.historyBtn.title = `The terminal shows its history, ${what}${h && h.max ? ` of ${h.max}` : ''}. Typing or this button goes back to the live screen.`;
  }

  /** #26: a child's conversation is open over the worker's (its name) or not (null): the note and the keys say so. */
  childOpen(name: string | null): void {
    if (name === this.child) return;
    this.child = name;
    this.renderMode();
    this.status('ok', null);
  }

  /** M16: what the laptop shows: the terminal (your keys go to it) or the conversation (they stay in the view). */
  setMode(mode: SeatMode): void {
    if (mode === this.current) return;
    this.current = mode;
    this.renderMode();
    this.status('ok', null);
  }

  private renderMode(): void {
    const m = this.current;
    this.el.dataset.mode = m;
    // #26: Esc goes back to the worker's conversation first: the stand button stops naming it.
    this.el.toggleAttribute('data-child', this.child !== null && m === 'transcript');
    // #216: the rail's tab of the view that is up is selected, and the list's one tab stop.
    for (const v of VIEWS) {
      const b = this.viewBtns[v.mode];
      b.setAttribute('aria-selected', String(v.mode === m));
      b.tabIndex = v.mode === m ? 0 : -1;
    }
    this.content.dataset.mode = m;
    const flip = key(['I'], m === 'images' ? 'Conversation' : 'Images');
    // The switch's own key, repeated here (a narrow bar drops it: the switch shows it).
    const swap = (label: string) => {
      const k = key(['Ctrl', 'Esc'], label);
      k.classList.add('seat-key-mode');
      return k;
    };
    const nothing = 'nothing you type here goes to the terminal';
    const aside = (text: string) => {
      const a = el('span', 'seat-aside', text);
      a.title = text;
      return a;
    };
    // #216: the rail's chords, in every view (a narrow bar drops them: the rail's tooltips say them).
    const views = key(['Ctrl', 'Shift', '1…4'], 'Views');
    views.classList.add('seat-key-views');
    this.keys.replaceChildren(
      ...(m === 'transcript' && this.child !== null
        ? [key(['Esc'], `Back to ${this.name}`), flip, swap('Terminal'), views, aside(`A subagent’s conversation, read only; PgUp, PgDn, j and k scroll`)]
        : m === 'transcript'
        ? [key(['Enter'], 'Write a prompt'), flip, swap('Terminal'), views, aside(`PgUp, PgDn, j and k scroll; ${nothing}`)]
        : m === 'images'
          ? [key(['Enter'], 'Open'), flip, swap('Terminal'), views, aside(`Arrows move between images; ${nothing}`)]
          : m === 'runs'
            ? [key(['↑ ↓'], 'Pick a run'), key(['Enter'], 'Its terminal'), swap('Terminal'), views, aside(`In a run’s terminal Ctrl+Esc gives the keyboard back to the runs; ${nothing}`)]
            : [
                key(['Shift', 'Esc'], 'Send Esc'),
                key([this.mac ? '⌘' : 'Ctrl', 'V'], 'Paste'),
                key(this.mac ? ['⌘', 'C'] : ['Ctrl', 'Shift', 'C'], 'Copy'),
                swap(this.last === 'transcript' ? 'Conversation' : VIEW_WORD[this.last]),
                views,
                aside(`Tab, arrows and Ctrl keys go to the terminal; the wheel scrolls its history; ${this.mac ? '⌘' : 'Ctrl'}+click opens a link`),
              ]),
    );
  }

  /**
   * #57: "Claude is asking a question. T to answer in the transcript view." (null: hidden). #216: in every view (the
   * notices' row keeps its height across a swap, so the terminal's rows do not change): `key` null in the conversation
   * itself ("answer it below"), Ctrl+Shift+2 from Images and Runs.
   */
  asking(ask: { who: string; key: 'T' | 'Ctrl+Esc' | 'Ctrl+Shift+2' | null } | null): void {
    this.askLine.hidden = !ask;
    this.el.toggleAttribute('data-asking', !!ask);
    if (!ask) {
      this.askLine.replaceChildren();
      return;
    }
    const tag = el('span', 'seat-ask-tag', 'Question');
    if (ask.key === null) {
      this.askLine.replaceChildren(tag, el('span', 'seat-ask-text', `${ask.who} is asking a question: answer it in the conversation below.`));
      return;
    }
    const k = el('span', 'key');
    for (const part of ask.key.split('+')) k.append(el('kbd', '', part));
    this.askLine.replaceChildren(tag, el('span', 'seat-ask-text', `${ask.who} is asking a question.`), k, el('span', 'seat-ask-text', 'to answer in the transcript view.'));
  }

  /** #155: what the worker's Codex launch has to tell you (null: nothing): its own server stopped, or it runs without one. */
  codexNote(n: CodexNotice | null): void {
    this.noteLine(this.codexLine, 'Codex server', n);
  }

  /** #139: the worker's Codex profile, with two or more profiles (null: nothing): its name, and what its start found. */
  profileNote(n: CodexNotice | null): void {
    this.noteLine(this.profileLine, 'Codex profile', n);
  }

  private noteLine(line: HTMLElement, tag: string, n: CodexNotice | null): void {
    line.hidden = !n;
    this.el.toggleAttribute('data-codex', !this.codexLine.hidden || !this.profileLine.hidden);
    if (!n) {
      line.replaceChildren();
      return;
    }
    line.dataset.tone = n.tone;
    line.replaceChildren(el('span', 'seat-codex-tag', tag), el('span', 'seat-codex-text', n.text));
  }

  /** Gets you up: the workspace shrinks back into `to` (the monitor on your view, when known), the game is live again and the focus goes back where it was. */
  hide(to: { left: number; top: number; width: number; height: number } | null = null): void {
    if (this.el.hidden) return;
    this.covered = false;
    delete this.hud.dataset.seated;
    this.inertBackground(false);
    const back = this.returnFocus;
    this.returnFocus = null;
    if (this.el.contains(document.activeElement)) (document.activeElement as HTMLElement | null)?.blur?.();
    if (back?.isConnected) back.focus({ preventScroll: true });
    // Nothing of it takes the pointer or the keyboard while it shrinks.
    this.leaving = true;
    this.el.inert = true;
    const done = () => {
      if (!this.leaving) return; // sat down again meanwhile
      this.leaving = false;
      this.el.inert = false;
      this.el.hidden = true;
      this.anim?.cancel();
      this.anim = null;
    };
    if (typeof this.el.animate !== 'function') return done();
    void this.grow(false, to).then(done);
  }

  status(kind: 'ok' | 'busy' | 'error' | 'offline', text: string | null): void {
    this.el.dataset.state = kind;
    // Sending is quick: keep the resting line instead of flickering "sending".
    if (kind === 'busy') return;
    this.note.textContent = text ?? (this.current === 'transcript' ? `Reading ${this.child ?? this.name}’s conversation` : this.current === 'images' ? `Looking at ${this.name}’s images` : this.current === 'runs' ? `${this.name}’s manual runs` : `Your keys go to ${this.name}’s terminal`);
    this.note.title = this.note.textContent;
  }

  focus(): void {
    this.input.focus({ preventScroll: true });
  }

  /** What the bar says (test hook). */
  summary(): {
    shown: boolean;
    tape: string;
    note: string;
    state: string;
    mode: SeatMode;
    ask: string | null;
    terminalZoom: string | null;
    fullscreen: { label: string; pressed: boolean; unavailable: boolean } | null;
    secretFiles: string | null;
    /** #176: the worker's status tape, the read-only line, the history indicator (null: not shown). */
    status: string | null;
    readOnly: string | null;
    history: string | null;
    covering: boolean;
    /** #216: the needs-you line (null: hidden), the files toggle, the rail's tabs' names. */
    needs: string | null;
    files: boolean;
    rail: string[];
  } {
    return {
      needs: this.needs.summary(),
      files: this.filesBtn.getAttribute('aria-pressed') === 'true',
      rail: VIEWS.map((v) => this.viewBtns[v.mode].getAttribute('aria-label') ?? v.word),
      status: this.statusTape.hidden ? null : (this.statusTape.textContent ?? ''),
      readOnly: this.roLine.hidden ? null : (this.roLine.textContent ?? ''),
      history: this.historyBtn.hidden ? null : (this.historyBtn.textContent ?? ''),
      covering: this.covering,
      fullscreen: this.fsBtn.hidden ? null : { label: this.fsText.textContent ?? '', pressed: this.fsBtn.getAttribute('aria-pressed') === 'true', unavailable: this.fsBtn.hasAttribute('data-unavailable') },
      secretFiles: this.secretsBtn.hidden ? null : `${this.secretsCount.textContent ?? ''}${this.secretsText.textContent ?? ''}`,
      terminalZoom: this.zoomBtns?.level.textContent ?? null,
      shown: this.shown,
      tape: this.tape.textContent ?? '',
      note: this.note.textContent ?? '',
      state: this.el.dataset.state ?? '',
      mode: this.current,
      ask: this.askLine.hidden ? null : [...this.askLine.children].map((c) => c.textContent ?? '').join(' '),
    };
  }
}
