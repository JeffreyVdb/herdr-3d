import './seat.css';
import type { SeatView } from '../laptop';
import type { SeatMode } from '../laptop/transcriptMode';
import { filesOf } from './composer/field';

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
  private readonly modeOpts: Record<SeatMode, HTMLSpanElement> = { terminal: el('span', 'seat-mode-opt', 'Terminal'), transcript: el('span', 'seat-mode-opt', 'Transcript'), images: el('span', 'seat-mode-opt', 'Images') };
  private name = '';
  private mac = false;
  private current: SeatMode = 'terminal';

  constructor(
    private readonly hud: HTMLElement,
    handlers: { text(t: string): void; paste(t: string, files?: File[]): void; stand(): void; toggle(): void },
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
    this.el.append(this.askLine, line, this.keys, this.modeBtn, this.standBtn, this.input);
    hud.append(this.el);
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
    const nothing = 'nothing you type here goes to the terminal';
    this.keys.replaceChildren(
      ...(m === 'transcript'
        ? [key(['Enter'], 'Write a prompt'), flip, key(['Ctrl', 'Esc'], 'Terminal'), el('span', 'seat-aside', `PgUp, PgDn, j and k scroll; ${nothing}`)]
        : m === 'images'
          ? [key(['Enter'], 'Open'), flip, key(['Ctrl', 'Esc'], 'Terminal'), el('span', 'seat-aside', `Arrows move between images; ${nothing}`)]
          : [key(['Shift', 'Esc'], 'Send Esc'), key([this.mac ? '⌘' : 'Ctrl', 'V'], 'Paste'), key(['Ctrl', 'Esc'], 'Conversation'), el('span', 'seat-aside', 'Tab, arrows and Ctrl keys go to the terminal')]),
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
  summary(): { shown: boolean; tape: string; note: string; state: string; mode: SeatMode; ask: string | null } {
    return {
      shown: !this.el.hidden,
      tape: this.tape.textContent ?? '',
      note: this.note.textContent ?? '',
      state: this.el.dataset.state ?? '',
      mode: this.current,
      ask: this.askLine.hidden ? null : [...this.askLine.children].map((c) => c.textContent ?? '').join(' '),
    };
  }
}
