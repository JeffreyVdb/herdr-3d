import './seat.css';
import type { SeatView } from '../laptop';

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
 * composition and the browser's paste land here.
 */
export class SeatBar implements SeatView {
  readonly el: HTMLDivElement;
  readonly input: HTMLTextAreaElement;
  private readonly tape = el('span', 'seat-tape');
  private readonly note = el('span', 'seat-note');
  private readonly keys = el('div', 'seat-keys');
  private readonly standBtn = el('button', 'seat-stand');
  private name = '';

  constructor(
    private readonly hud: HTMLElement,
    handlers: { text(t: string): void; paste(t: string): void; stand(): void },
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
      handlers.paste(e.clipboardData?.getData('text/plain') ?? '');
    });
    this.el.append(line, this.keys, this.standBtn, this.input);
    hud.append(this.el);
  }

  show(name: string, mac: boolean): void {
    this.name = name;
    this.tape.textContent = `At ${name}’s laptop`;
    this.keys.replaceChildren(
      key(['Shift', 'Esc'], 'Send Esc'),
      key([mac ? '⌘' : 'Ctrl', 'V'], 'Paste'),
      el('span', 'seat-aside', 'Tab, arrows and Ctrl keys go to the terminal'),
    );
    this.status('ok', null);
    this.el.hidden = false;
    this.hud.dataset.seated = '1';
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
    this.note.textContent = text ?? `Your keys go to ${this.name}’s terminal`;
  }

  focus(): void {
    this.input.focus({ preventScroll: true });
  }

  /** What the bar says (test hook). */
  summary(): { shown: boolean; tape: string; note: string; state: string } {
    return { shown: !this.el.hidden, tape: this.tape.textContent ?? '', note: this.note.textContent ?? '', state: this.el.dataset.state ?? '' };
  }
}
