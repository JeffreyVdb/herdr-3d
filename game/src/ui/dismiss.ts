/**
 * How a modal `<dialog>` treats a pointer on its backdrop (#51).
 *
 * The old check, `click` with `e.target === dialog`, misfires: a press inside the dialog (say, starting a text
 * selection) released on the backdrop fires `click` on their common ancestor, the `<dialog>`, and read as a backdrop
 * click. Two policies replace it:
 *
 * - `none`: the backdrop does nothing. The close button and Esc are the only ways out. For every dialog that holds
 *   typed text or a consequential choice.
 * - `sheet`: a read-only dialog may close on the backdrop, but only when the press AND the click both landed on it
 *   (primary button, on the `<dialog>` element itself, outside its box). A press that started inside never counts.
 *
 * `closedby` (native light dismissal) is not relied on: Safari has no stable support. Esc stays the platform's.
 */

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A point outside the dialog's own box: on the backdrop, not on its padding or scrollbar. */
export function outsideBox(box: Box, x: number, y: number): boolean {
  return x < box.left || x >= box.right || y < box.top || y >= box.bottom;
}

export interface Gesture {
  /** The event's target is the `<dialog>` itself (not something inside it). */
  onDialog: boolean;
  x: number;
  y: number;
  box: Box;
}

/** The two-event predicate: armed by a qualifying press, spent by the click that follows. */
export class BackdropPress {
  private armed = false;

  /** A primary-button press on the backdrop arms; every other press (inside, right button, second finger) disarms. */
  down(g: Gesture & { primary: boolean }): void {
    this.armed = g.primary && g.onDialog && outsideBox(g.box, g.x, g.y);
  }

  /** The click that ends the gesture: true only when it also landed on the backdrop, after a press that did. */
  click(g: Gesture): boolean {
    const ok = this.armed && g.onDialog && outsideBox(g.box, g.x, g.y);
    this.armed = false;
    return ok;
  }

  /** A cancelled pointer (a touch that became a scroll) or a closed dialog: nothing is pending. */
  reset(): void {
    this.armed = false;
  }
}

/**
 * #147: a key event from inside the command palette, a modal of its own on top of whatever else is up (the image previews, the
 * whiteboard, the floor overview): what is under it leaves the key alone, Esc above all, so Esc closes only the palette.
 */
export const inPalette = (e: Event): boolean => e.target instanceof Element && !!e.target.closest('dialog.palette');

/**
 * Installs a backdrop policy on a dialog. `sheet` needs `close`; `none` needs nothing and only marks the dialog
 * `closedby="closerequest"` (Esc and the close controls; browsers without the attribute already do that for a modal).
 */
export function backdropPolicy(dialog: HTMLDialogElement, policy: 'none'): void;
export function backdropPolicy(dialog: HTMLDialogElement, policy: 'sheet', close: () => void): void;
export function backdropPolicy(dialog: HTMLDialogElement, policy: 'none' | 'sheet', close?: () => void): void {
  dialog.setAttribute('closedby', 'closerequest');
  if (policy === 'none' || !close) return;
  const press = new BackdropPress();
  const gesture = (e: MouseEvent): Gesture => ({ onDialog: e.target === dialog, x: e.clientX, y: e.clientY, box: dialog.getBoundingClientRect() });
  // Capture: a control inside that stops the event must not leave a stale press behind.
  dialog.addEventListener('pointerdown', (e) => press.down({ ...gesture(e), primary: e.button === 0 && e.isPrimary }), true);
  dialog.addEventListener('pointercancel', () => press.reset(), true);
  dialog.addEventListener('close', () => press.reset());
  dialog.addEventListener('click', (e) => {
    if (press.click(gesture(e))) close();
  });
}
