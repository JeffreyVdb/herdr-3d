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

import { h, ICON, icon } from '../dom';

let open = 0;

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
  const closeBtn = h('button', { class: 'cmp-lb-close', 'aria-label': 'Close preview' }, icon(ICON.close));
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
    if (e.key !== 'Escape' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (!e.repeat) close();
  };
  const refuseCancel = (e: Event): void => {
    e.preventDefault();
    close();
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

  function close(): void {
    if (done) return;
    done = true;
    open--;
    window.removeEventListener('keydown', onKey, true);
    hostDialog?.removeEventListener('cancel', refuseHostCancel, true);
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
