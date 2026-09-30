import './seatTabs.css';
import type { ReadMode, SeatTabs } from './transcriptMode';

/** The key that flips Conversation <-> Images (when no text box has the keyboard). */
export const FLIP_KEY = 'i';

/**
 * M16 phase 2: the Conversation | Images strip in the bar of both views of the seated overlay. Each view gets its own
 * element (an element has one place); `update` keeps them all lit the same, with the image count on the second tab.
 */
export function createSeatTabs(pick: (mode: ReadMode) => void): SeatTabs {
  const strips = new Set<HTMLElement>();
  let active: ReadMode = 'transcript';
  let count: number | null = null;
  const paint = (strip: HTMLElement) => {
    for (const b of strip.querySelectorAll<HTMLButtonElement>('button[data-mode]')) {
      const on = b.dataset.mode === active;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? -1 : 0;
      const other = b.dataset.mode === 'images' ? 'Images' : 'Conversation';
      b.title = on ? `${other} (showing)` : `${other} (${FLIP_KEY.toUpperCase()})`;
    }
    const n = strip.querySelector<HTMLElement>('.seat-tabs-n');
    if (n) {
      n.textContent = count === null ? '' : String(count);
      n.hidden = count === null || count === 0;
    }
  };
  return {
    create() {
      const tab = (mode: ReadMode, label: string) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'seat-tab';
        b.dataset.mode = mode;
        b.setAttribute('role', 'tab');
        b.append(document.createTextNode(label));
        if (mode === 'images') {
          const n = document.createElement('span');
          n.className = 'seat-tabs-n';
          b.append(n);
        }
        b.addEventListener('click', () => pick(mode));
        return b;
      };
      const strip = document.createElement('div');
      strip.className = 'seat-tabs';
      strip.setAttribute('role', 'tablist');
      strip.setAttribute('aria-label', 'What to show');
      strip.append(tab('transcript', 'Conversation'), tab('images', 'Images'));
      strips.add(strip);
      paint(strip);
      return strip;
    },
    update(mode, n) {
      active = mode;
      count = n;
      for (const s of strips) paint(s);
    },
    dispose() {
      for (const s of strips) s.remove();
      strips.clear();
    },
  };
}
