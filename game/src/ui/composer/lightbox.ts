/**
 * The click-to-enlarge view of one image, over whatever is open (a hire dialog, the prompt overlay).
 *
 * A second native modal `<dialog>`: it goes in the top layer, so it shows above a modal host (a z-index could not),
 * makes everything below inert and traps Tab. Layering is the delicate part. Esc must close *only* the preview: two
 * modal dialogs can both receive one Esc's close request, so while the preview is open a capture-phase keydown
 * closes it, swallows the key (`preventDefault` also stops the browser's own close request) and the preview's and its
 * host's `cancel` events are refused as a second line. The host keeps its own Esc handling for when no preview is open.
 *
 * It closes on its close button, on Esc, or on a click that began and ended on the empty surface (not on the image,
 * and not after a drag that ended there). What the editor showed before is given back by `onClosed`.
 */

import { h } from '../dom';
import { inPalette } from '../dismiss';
import { duotone } from '../duotone';

let open = 0;

/** A held Esc goes on repeating after the preview it closed: the guard swallows those until the key is up. Idle time after which it drops on its own (a lost keyup). */
const HELD_ESC_IDLE_MS = 1000;

/**
 * Esc closed the preview and may still be down: its auto-repeat keydowns (and the host's `cancel`) must not fall through
 * to the host, or one physical press closes both layers. Lifts on Esc keyup, a new Esc press, another key, blur, or after
 * `HELD_ESC_IDLE_MS` without a repeat.
 */
function swallowHeldEscape(hostDialog: HTMLDialogElement | null): void {
  let timer = 0;
  const lift = (): void => {
    window.clearTimeout(timer);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('blur', lift);
    hostDialog?.removeEventListener('cancel', refuse, true);
  };
  const arm = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(lift, HELD_ESC_IDLE_MS);
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    // A press that is not a repeat is a new one (its keyup was lost, or another key came): the host's to handle.
    if (e.key !== 'Escape' || !e.repeat) {
      lift();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    arm();
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') lift();
  };
  const refuse = (e: Event): void => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', lift);
  hostDialog?.addEventListener('cancel', refuse, true);
  arm();
}

/** True while any preview is open: a host's own Esc / cancel handler can ask before it closes itself. */
export const previewOpen = (): boolean => open > 0;

export interface PreviewImage {
  url: string;
  name: string;
  /** "Image 2": what the label says next to the name. */
  label: string;
}

export interface Preview {
  close(): void;
  readonly isOpen: boolean;
}

let ids = 0;
/** A click closes the preview only if its pointer moved no more than this between press and release. */
const DRAG_PX = 4;

/**
 * Opens the preview inside `host` (any element; the dialog goes to the top layer wherever it is). `release` lets go of
 * whatever keeps the image alive; `onClosed` runs after the dialog is gone, once.
 */
export function openPreview(host: HTMLElement, img: PreviewImage, release: () => void, onClosed: () => void): Preview {
  const id = `cmp-lb-${++ids}`;
  const closeBtn = h('button', { class: 'cmp-lb-close', 'aria-label': 'Close preview' }, duotone('x'));
  const pic = h('img', { class: 'cmp-lb-img', alt: `${img.label}: ${img.name}`, draggable: 'false' });
  if (img.url) pic.src = img.url;
  const stage = h('div', { class: 'cmp-lb-stage' }, pic);
  const cap = h('p', { class: 'cmp-lb-cap', id }, `${img.label} · ${img.name}`);
  const dlg = h('dialog', { class: 'cmp-lightbox', 'aria-labelledby': id }, stage, closeBtn, cap);
  const hostDialog = host.closest('dialog');

  let done = false;
  let downOnSurface = false;
  let downAt = { x: 0, y: 0 };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing || inPalette(e)) return; // (#147: the palette over the preview has its own Esc)
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (!e.repeat) close(true);
  };
  const refuseCancel = (e: Event): void => {
    e.preventDefault();
    close(true);
  };
  // In the capture phase, so it runs before a host handler that was added earlier, and that handler never sees a
  // cancel that was meant for the preview.
  const refuseHostCancel = (e: Event): void => {
    if (e.target !== hostDialog) return; // the preview's own cancel passes through to its handler
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const surface = (t: EventTarget | null): boolean => t === dlg || t === stage;
  dlg.addEventListener('pointerdown', (e) => {
    downOnSurface = surface(e.target);
    downAt = { x: e.clientX, y: e.clientY };
  });
  dlg.addEventListener('click', (e) => {
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > DRAG_PX;
    const ok = downOnSurface && surface(e.target) && !moved;
    downOnSurface = false;
    if (ok) close();
  });
  closeBtn.addEventListener('click', () => close());
  dlg.addEventListener('cancel', refuseCancel);
  dlg.addEventListener('close', () => close());
  window.addEventListener('keydown', onKey, true);
  hostDialog?.addEventListener('cancel', refuseHostCancel, true);

  /** `byKey`: Esc (or a close request) did it, and the key may still be down. */
  function close(byKey = false): void {
    if (done) return;
    done = true;
    open--;
    window.removeEventListener('keydown', onKey, true);
    hostDialog?.removeEventListener('cancel', refuseHostCancel, true);
    if (byKey) swallowHeldEscape(hostDialog);
    if (dlg.open) dlg.close();
    dlg.remove();
    release();
    onClosed();
  }

  host.append(dlg);
  open++;
  dlg.showModal();
  closeBtn.focus({ preventScroll: true });
  return { close, get isOpen() { return !done; } };
}
