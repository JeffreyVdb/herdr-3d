import './bubble.css';

/** What a bubble shows: the words, and for a nudge who is waiting where. */
export interface BubbleLine {
  kind: string;
  bubble: string;
  waiting?: ReadonlyArray<{ name: string; count: number }>;
  /** More floors waiting than the list shows. */
  more?: number;
}

const svg = (paths: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const SPEAKER_OFF = svg('<path d="M4.5 9.5h3l4.5-4v13l-4.5-4h-3z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>');

const MARGIN = 12;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

/**
 * The receptionist's speech bubble: an M2 card in the DOM (paper, ink stroke,
 * a tail pointing at the speaker) with a "Front desk" label-maker tape. It is
 * a polite live region, so what is said is read out even with the sound off.
 * `place()` runs per frame and only writes a transform.
 */
export class SpeechBubble {
  readonly root: HTMLDivElement;
  private readonly pop: HTMLDivElement;
  private readonly text: HTMLParagraphElement;
  private readonly list: HTMLUListElement;
  private readonly voice: HTMLSpanElement;
  private readonly sr: HTMLSpanElement;
  private shown: BubbleLine | null = null;
  private size = { w: 0, h: 0 };
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTransform = '';

  constructor(parent: HTMLElement) {
    this.root = el('div', 'rx-bubble');
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
    this.root.hidden = true;
    this.pop = el('div', 'rx-bubble-pop');
    this.pop.setAttribute('aria-hidden', 'true');
    const card = el('div', 'rx-bubble-card');
    const head = el('div', 'rx-bubble-head');
    const tape = el('span', 'tape rx-bubble-tape');
    tape.textContent = 'Front desk';
    this.voice = el('span', 'rx-bubble-voice');
    head.append(tape, this.voice);
    this.text = el('p', 'rx-bubble-text');
    this.list = el('ul', 'rx-bubble-list');
    card.append(head, this.text, this.list);
    this.pop.append(card);
    this.sr = el('span', 'rx-bubble-sr');
    this.root.append(this.pop, this.sr);
    parent.append(this.root);
  }

  /** The bubble text on screen, null when none is. */
  get current(): string | null {
    return this.shown?.bubble ?? null;
  }

  /** Shows a line; `silent`: no sound is playing with it (muted, or audio still locked). */
  show(line: BubbleLine, silent: boolean): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    this.shown = line;
    this.root.dataset.kind = line.kind;
    const waiting = line.waiting ?? [];
    this.text.textContent = waiting.length ? 'Waiting on you upstairs' : line.bubble;
    this.list.replaceChildren(
      ...waiting.map((w) => {
        const li = el('li', '');
        const n = el('b', '');
        n.textContent = String(w.count);
        const name = el('span', '');
        name.textContent = w.name;
        li.append(el('i', ''), n, name);
        return li;
      }),
    );
    if (line.more) {
      const li = el('li', 'rx-bubble-more');
      li.textContent = `and ${line.more} more ${line.more === 1 ? 'floor' : 'floors'}`;
      this.list.append(li);
    }
    this.list.hidden = !waiting.length;
    this.voice.innerHTML = silent ? SPEAKER_OFF : '<i></i><i></i><i></i>';
    this.voice.dataset.silent = String(silent);
    this.voice.title = silent ? 'Sound is off' : '';
    this.sr.textContent = line.bubble;
    const wasHidden = this.root.hidden;
    this.root.hidden = false;
    this.root.classList.remove('is-leaving');
    // Measured once per line (not per frame), for keeping it on screen.
    this.size = { w: this.pop.offsetWidth, h: this.pop.offsetHeight };
    if (wasHidden) {
      // Restart the entrance.
      this.root.classList.remove('is-in');
      void this.pop.offsetWidth;
    }
    this.root.classList.add('is-in');
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = null;
    this.root.classList.add('is-leaving');
    this.root.classList.remove('is-in');
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      this.root.hidden = true;
      this.root.classList.remove('is-leaving');
      this.hideTimer = null;
    }, 420);
  }

  /**
   * Places the tail at a screen point (CSS px), scaled by distance. `null`
   * (behind the camera) or a point off screen docks it under the top bar.
   */
  place(p: { x: number; y: number } | null, scale: number, vw: number, vh: number, top: number): void {
    if (this.root.hidden) return;
    let s = Math.max(0.7, Math.min(1, scale));
    let x = vw / 2;
    let y = top + MARGIN + this.size.h;
    let docked = true;
    if (p) {
      const hw = (this.size.w * s) / 2;
      const h = this.size.h * s;
      const cx = Math.min(vw - MARGIN - hw, Math.max(MARGIN + hw, p.x));
      const cy = Math.min(vh - MARGIN, Math.max(top + MARGIN + h, p.y));
      // Pushed well away from its speaker (or off screen): the tail would point at nothing.
      docked = Math.abs(cx - p.x) > hw * 0.6 || Math.abs(cy - p.y) > h * 0.6;
      if (!docked) {
        x = cx;
        y = cy;
      }
    }
    if (docked) s = 1;
    const t = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) scale(${s.toFixed(3)})`;
    if (t !== this.lastTransform) {
      this.lastTransform = t;
      this.root.style.transform = t;
    }
    if (this.root.classList.contains('is-docked') !== docked) this.root.classList.toggle('is-docked', docked);
  }

  dispose(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.root.remove();
  }
}
