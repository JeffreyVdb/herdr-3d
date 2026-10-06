import type { CodexNotice } from '../world/codexServer';
import './seat.css';
import type { SeatView } from '../laptop';
import { LOOK_KEY } from '../laptop/keys';
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

/**
 * M5: the bar at the bottom while you sit at a worker's laptop: whose
 * terminal your keys go to (on label-maker tape, like the status chips),
 * how to get up and how to send Esc, and what went wrong when typing
 * failed. A visually hidden textarea keeps the keyboard focus, so IME
 * composition and the browser's paste land here. M16: a switch between the
 * terminal and the worker's conversation (Ctrl+Esc), showing which is up.
 * #59: the terminal's own preset and zoom (the transcript has its own, in its
 * strip): three swatches and A− / level / A+, always in view. In terminal mode
 * every key is the pane's, so the mouse and Ctrl + = / − / 0 reach them there;
 * by keyboard Ctrl+, reaches them from any view (Esc goes back). #74: a split herdr pane shows at its own size, so
 * beside them a chip states that fact ("Split pane 60×40") and switches herdr's zoom for the pane.
 */
export class SeatBar implements SeatView {
  readonly el: HTMLDivElement;
  readonly input: HTMLTextAreaElement;
  private readonly tape = el('span', 'seat-tape');
  private readonly note = el('span', 'seat-note');
  private readonly keys = el('div', 'seat-keys');
  private readonly standBtn = el('button', 'seat-stand');
  private readonly modeBtn = el('button', 'seat-mode');
  /** #57: the line that says the agent asks a question (terminal mode). */
  private readonly askLine = el('div', 'seat-ask');
  /** #155: the line about the worker's own Codex server (in the ask line's place while no question shows). */
  private readonly codexLine = el('div', 'seat-codex');
  private readonly modeOpts: Record<SeatMode, HTMLSpanElement> = { terminal: el('span', 'seat-mode-opt', 'Terminal'), transcript: el('span', 'seat-mode-opt', 'Transcript'), images: el('span', 'seat-mode-opt', 'Images') };
  /** #59: the terminal's preset and zoom. */
  private readonly look = el('div', 'seat-look');
  private readonly swatches: HTMLButtonElement[] = [];
  /** #74: the fullscreen chip (hidden while there is nothing to say), and what a click of it asks for. */
  private readonly fsBtn = el('button', 'seat-fs');
  private readonly fsText = el('span', 'seat-fs-text');
  private fsAction: FullscreenChip['action'] = null;
  private readonly zoomBtns: { out: HTMLButtonElement; level: HTMLButtonElement; in: HTMLButtonElement } | null = null;
  private name = '';
  private mac = false;
  private current: SeatMode = 'terminal';

  constructor(
    private readonly hud: HTMLElement,
    handlers: { text(t: string): void; paste(t: string, files?: File[]): void; stand(): void; toggle(): void; fullscreen?(action: 'zoom' | 'unzoom'): void },
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
    this.standBtn.type = 'button';
    this.standBtn.append(el('kbd', '', 'Esc'), document.createTextNode('Stand up'));
    this.standBtn.addEventListener('click', () => handlers.stand());
    this.modeBtn.type = 'button';
    this.modeBtn.title = 'Switch between the terminal and what you read last, the conversation or the images (Ctrl+Esc)';
    const opts = el('span', 'seat-mode-opts');
    opts.append(this.modeOpts.terminal, this.modeOpts.transcript, this.modeOpts.images);
    this.modeBtn.append(el('kbd', '', 'Ctrl'), el('kbd', '', 'Esc'), opts);
    this.modeBtn.addEventListener('click', () => handlers.toggle());
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
    this.el.append(this.askLine, this.codexLine, line, this.keys, this.modeBtn, this.standBtn, this.input);
    if (prefs) {
      this.zoomBtns = this.buildLook(prefs, handlers.fullscreen);
      // At the end of the keys row (renderMode puts it back after the keys): the bar keeps its two rows.
      this.keys.append(this.look);
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
    if (this.current === 'terminal' && !this.el.hidden) this.focus();
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

  /** #59: a control of the bar has the keyboard (its Tab, Enter, Space and arrows are its own, not the pane's). */
  owns(t: EventTarget | null): boolean {
    return t instanceof Element && t !== this.input && this.el.contains(t) && !!t.closest('button');
  }

  show(name: string, mac: boolean): void {
    this.name = name;
    this.mac = mac;
    this.tape.textContent = `At ${name}’s laptop`;
    this.current = 'terminal';
    this.renderMode();
    this.status('ok', null);
    this.el.hidden = false;
    this.hud.dataset.seated = '1';
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
    const aria = { terminal: 'Showing the terminal: switch to the conversation or the images', transcript: 'Showing the conversation: switch to the terminal', images: 'Showing the images: switch to the terminal' };
    this.modeBtn.setAttribute('aria-label', aria[m]);
    for (const k of ['terminal', 'transcript', 'images'] as const) this.modeOpts[k].toggleAttribute('data-on', k === m);
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
    this.keys.replaceChildren(
      ...(m === 'transcript'
        ? [key(['Enter'], 'Write a prompt'), flip, swap('Terminal'), aside(`PgUp, PgDn, j and k scroll; ${nothing}`)]
        : m === 'images'
          ? [key(['Enter'], 'Open'), flip, swap('Terminal'), aside(`Arrows move between images; ${nothing}`)]
          : [key(['Shift', 'Esc'], 'Send Esc'), key([this.mac ? '⌘' : 'Ctrl', 'V'], 'Paste'), swap('Conversation'), aside('Tab, arrows and Ctrl keys go to the terminal')]),
      ...(this.prefs ? [this.look] : []),
    );
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
    this.codexLine.hidden = !n;
    this.el.toggleAttribute('data-codex', !!n);
    if (!n) {
      this.codexLine.replaceChildren();
      return;
    }
    this.codexLine.dataset.tone = n.tone;
    this.codexLine.replaceChildren(el('span', 'seat-codex-tag', 'Codex server'), el('span', 'seat-codex-text', n.text));
  }

  hide(): void {
    this.el.hidden = true;
    delete this.hud.dataset.seated;
    if (document.activeElement === this.input) this.input.blur();
  }

  status(kind: 'ok' | 'busy' | 'error' | 'offline', text: string | null): void {
    this.el.dataset.state = kind;
    // Sending is quick: keep the resting line instead of flickering "sending".
    if (kind === 'busy') return;
    this.note.textContent = text ?? (this.current === 'transcript' ? `Reading ${this.name}’s conversation` : this.current === 'images' ? `Looking at ${this.name}’s images` : `Your keys go to ${this.name}’s terminal`);
    this.note.title = this.note.textContent;
  }

  focus(): void {
    this.input.focus({ preventScroll: true });
  }

  /** What the bar says (test hook). */
  summary(): { shown: boolean; tape: string; note: string; state: string; mode: SeatMode; ask: string | null; terminalZoom: string | null; fullscreen: { label: string; pressed: boolean; unavailable: boolean } | null } {
    return {
      fullscreen: this.fsBtn.hidden ? null : { label: this.fsText.textContent ?? '', pressed: this.fsBtn.getAttribute('aria-pressed') === 'true', unavailable: this.fsBtn.hasAttribute('data-unavailable') },
      terminalZoom: this.zoomBtns?.level.textContent ?? null,
      shown: !this.el.hidden,
      tape: this.tape.textContent ?? '',
      note: this.note.textContent ?? '',
      state: this.el.dataset.state ?? '',
      mode: this.current,
      ask: this.askLine.hidden ? null : [...this.askLine.children].map((c) => c.textContent ?? '').join(' '),
    };
  }
}
