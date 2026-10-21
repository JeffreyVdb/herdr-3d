import type { CodexNotice } from '../world/codexServer';
import type { Display } from '../world/derive';
import './seat.css';
import './secretChips.css';
import { secretFilesText } from '../world/revokeSecrets';
import { icon, ICON } from './dom';
import type { SeatView } from '../laptop';
import { LOOK_KEY } from '../laptop/keys';
import type { FullscreenChip } from '../laptop/fullscreen';
import type { SeatMode } from '../laptop/transcriptMode';
import { filesOf } from './composer/field';
import { HistoryBar } from './seatScrollbar';
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
 */
export class SeatBar implements SeatView {
  readonly el: HTMLDivElement;
  readonly input: HTMLTextAreaElement;
  private readonly tape = el('span', 'seat-tape');
  private readonly note = el('span', 'seat-note');
  private readonly keys = el('div', 'seat-keys');
  private readonly standBtn = el('button', 'seat-stand');
  /** #176: the view switch: one button per view (the one up is pressed); Ctrl+Esc still swaps. */
  private readonly modeBtn = el('div', 'seat-mode');
  private readonly modeBtns: Record<SeatMode, HTMLButtonElement> = { terminal: el('button', 'seat-mode-opt'), transcript: el('button', 'seat-mode-opt'), images: el('button', 'seat-mode-opt') };
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
  /** #176 part 2: a paste while seated (on the document, capture phase). */
  private readonly onPaste: (e: ClipboardEvent) => void;
  /** #176 part 2: the history's scrollbar, beside the terminal. */
  private readonly historyBar: HistoryBar;
  /** #176 part 2: whether clicks reach the terminal: `on`, `old` (herdr before 0.9.2), `readonly` (null: nothing to say). */
  private clicks: 'on' | 'old' | 'readonly' | null = null;
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
      /** #176: a view picked on the switch. */
      mode?(m: SeatMode): void;
      /** #176: "Back to live": the terminal's view to the live bottom of herdr's history. */
      live?(): void;
      /** #176 part 2: the history scrollbar: wheel lines over the terminal (positive: up the history). */
      historyScroll?(lines: number): void;
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
      ic.append(icon(ICON.lock));
      const tape = el('span', 'secret-chip-tape');
      tape.append(ic, this.secretsCount, this.secretsText);
      this.secretsBtn.append(tape);
      this.secretsBtn.addEventListener('click', () => revoke(this.secretsBtn));
      line.append(this.secretsBtn);
    }
    this.standBtn.type = 'button';
    this.standBtn.append(el('kbd', '', 'Esc'), document.createTextNode('Stand up'));
    this.standBtn.addEventListener('click', () => handlers.stand());
    this.modeBtn.setAttribute('role', 'group');
    this.modeBtn.setAttribute('aria-label', 'View');
    this.modeBtn.title = 'Ctrl+Esc switches between the terminal and what you read last, the conversation or the images';
    const words: Record<SeatMode, string> = { terminal: 'Terminal', transcript: 'Conversation', images: 'Images' };
    for (const m of ['terminal', 'transcript', 'images'] as const) {
      const b = this.modeBtns[m];
      b.type = 'button';
      b.dataset.mode = m;
      b.textContent = words[m];
      b.addEventListener('click', () => {
        if (m === this.current) return this.backToPane();
        if (handlers.mode) handlers.mode(m);
        else handlers.toggle();
      });
      this.modeBtn.append(b);
    }
    const swap = el('span', 'key seat-mode-key');
    swap.append(el('kbd', '', 'Ctrl'), el('kbd', '', 'Esc'));
    swap.setAttribute('aria-hidden', 'true');
    this.modeBtn.prepend(swap);
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
    // #176 part 2 (#38): a paste anywhere in the workspace while the terminal shows is the terminal's (a header button
    // focused, the page itself), before xterm's own listener could take it; a text field keeps its own. Listened to
    // on the document while seated (`show` to `hide`).
    this.onPaste = (e: ClipboardEvent) => {
      if (!this.pasteIsTerminals(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      // #64: a screenshot on the clipboard comes as files (the text a copied file may carry is its name, not a paste).
      const files = filesOf(e.clipboardData);
      handlers.paste(e.clipboardData?.getData('text/plain') ?? '', files);
    };
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
    this.historyBtn.append(icon(ICON.down), this.historyText, el('span', 'seat-history-act', 'Back to live'));
    this.historyBtn.addEventListener('click', () => {
      handlers.live?.();
      this.backToPane();
    });
    this.notes.append(this.askLine, this.codexBox, this.roLine);
    this.termHost.id = 'seat-term';
    this.historyBar = new HistoryBar(this.termHost, { scroll: (n) => handlers.historyScroll?.(n), bottom: () => handlers.live?.() });
    // #176 part 2: the scrollbar before the terminal, so Tab reaches it after the header, before the terminal's keyboard
    // (from which Tab is the application's); it lies over the terminal all the same (absolute, z-index).
    this.content.append(this.historyBar.el, this.termHost, this.historyBtn);
    this.head.append(line, this.modeBtn, this.standBtn);
    this.el.append(this.head, this.notes, this.content, this.keys, this.input);
    // #176: a copy while the seat has the keyboard (⌘C on a Mac, the browser's menu) takes the terminal's selection.
    this.el.addEventListener('copy', (e) => {
      const text = handlers.selection?.() ?? '';
      if (!text || this.current !== 'terminal' || !e.clipboardData) return;
      e.preventDefault();
      e.clipboardData.setData('text/plain', text);
    });
    if (prefs) {
      this.zoomBtns = this.buildLook(prefs, handlers.fullscreen);
      // #176: in the header, between the view switch and Stand up.
      this.head.insertBefore(this.look, this.standBtn);
      prefs.onChange((what) => {
        if (what === 'terminalTheme' || what === 'terminalZoom') this.renderLook();
      });
      this.renderLook();
    }
    hud.append(this.el);
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

  /**
   * #176 part 2: a paste at `t` goes to the terminal: the workspace shows the terminal and `t` is in it (its keyboard,
   * a header button, the terminal) or nowhere (the page), but not a text field, which pastes into itself.
   */
  pasteIsTerminals(t: EventTarget | null): boolean {
    if (this.el.hidden || this.leaving || this.current !== 'terminal') return false;
    if (t === this.input) return true;
    if (t === document.body || t === document.documentElement || t === document) return true;
    if (!(t instanceof Element) || !this.el.contains(t)) return false;
    if (this.termHost.contains(t)) return true; // xterm's own textarea too
    return !t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
  }

  /** #59: `t` is one of the terminal's preset and zoom controls (Esc there hands the keyboard back, see the controller). */
  inLook(t: EventTarget | null): boolean {
    return t instanceof Element && this.look.contains(t);
  }

  /**
   * #59: a control of the bar has the keyboard (its Tab, Enter, Space and arrows are its own, not the pane's). #176: so
   * has the read-only terminal once tabbed to: its arrows scroll it (the rest still types). Part 2: so has the history
   * scrollbar (Tab and Shift+Tab move the focus on; its own keys it handles itself).
   */
  owns(t: EventTarget | null): boolean {
    return (
      t instanceof Element &&
      t !== this.input &&
      this.el.contains(t) &&
      (!!t.closest('button') || this.historyBar.el.contains(t) || (t === this.termHost && t.hasAttribute('data-readonly')))
    );
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
    this.mouse(null);
    this.el.hidden = false;
    this.hud.dataset.seated = '1';
    document.addEventListener('paste', this.onPaste, { capture: true }); // #176 part 2 (once: the same listener)
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
  history(h: { offset: number; max: number; rows?: number } | null): void {
    // #176 part 2: the scrollbar (hidden without a history, or without the bridge's rows).
    this.historyBar.update(h && h.rows !== undefined ? { offset: h.offset, max: h.max, rows: h.rows } : null);
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
    for (const k of ['terminal', 'transcript', 'images'] as const) {
      this.modeBtns[k].setAttribute('aria-pressed', String(k === m));
      this.modeBtns[k].toggleAttribute('data-on', k === m);
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
    const aside = (text: string, cls = 'seat-aside') => {
      const a = el('span', cls, text);
      a.title = text;
      return a;
    };
    this.keys.replaceChildren(
      ...(m === 'transcript' && this.child !== null
        ? [key(['Esc'], `Back to ${this.name}`), flip, swap('Terminal'), aside(`A subagent’s conversation, read only; PgUp, PgDn, j and k scroll`)]
        : m === 'transcript'
        ? [key(['Enter'], 'Write a prompt'), flip, swap('Terminal'), aside(`PgUp, PgDn, j and k scroll; ${nothing}`)]
        : m === 'images'
          ? [key(['Enter'], 'Open'), flip, swap('Terminal'), aside(`Arrows move between images; ${nothing}`)]
          : [
              key(['Shift', 'Esc'], 'Send Esc'),
              key([this.mac ? '⌘' : 'Ctrl', 'V'], 'Paste'),
              key(this.mac ? ['⌘', 'C'] : ['Ctrl', 'Shift', 'C'], 'Copy'),
              swap('Conversation'),
              aside(`Tab, arrows and Ctrl keys go to the terminal; the wheel scrolls its history; ${this.clicks === 'on' ? 'a click goes to an app that uses the mouse; ' : ''}${this.mac ? '⌘' : 'Ctrl'}+click opens a link`),
              // #176 part 2: said once, beside the keys, never in the way: the pane cannot take clicks from here.
              ...(this.clicks === 'old' ? [aside('Mouse clicks need herdr 0.9.2 or newer', 'seat-aside seat-clicks')] : []),
            ]),
    );
  }

  /** #176 part 2: whether a click in the terminal reaches its app (`old`: herdr before 0.9.2 cannot; null: nothing to say). */
  mouse(state: 'on' | 'old' | 'readonly' | null): void {
    if (state === this.clicks) return;
    this.clicks = state;
    this.renderMode();
  }

  /** #57: "Claude is asking a question. T to answer in the transcript view." (null: hidden). */
  asking(ask: { who: string; key: 'T' | 'Ctrl+Esc' } | null): void {
    this.askLine.hidden = !ask;
    this.el.toggleAttribute('data-asking', !!ask);
    if (!ask) {
      this.askLine.replaceChildren();
      return;
    }
    const keys = ask.key === 'T' ? ['T'] : ['Ctrl', 'Esc'];
    const k = el('span', 'key');
    for (const part of keys) k.append(el('kbd', '', part));
    this.askLine.replaceChildren(el('span', 'seat-ask-tag', 'Question'), el('span', 'seat-ask-text', `${ask.who} is asking a question.`), k, el('span', 'seat-ask-text', 'to answer in the transcript view.'));
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
    document.removeEventListener('paste', this.onPaste, { capture: true });
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
    this.note.textContent = text ?? (this.current === 'transcript' ? `Reading ${this.child ?? this.name}’s conversation` : this.current === 'images' ? `Looking at ${this.name}’s images` : `Your keys go to ${this.name}’s terminal`);
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
    /** #176 part 2: the history scrollbar (null: hidden) and the footer's word on clicks (null: none). */
    scrollbar: { offset: number; max: number } | null;
    clicks: string | null;
  } {
    return {
      scrollbar: this.historyBar.shown,
      clicks: this.keys.querySelector('.seat-clicks')?.textContent ?? null,
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
