import './imageLightbox.css';
import type { ImageFeed } from '../laptop/imageFeed';
import type { ImageRef } from '../net/protocol';
import { h, ICON, icon } from './dom';

/**
 * M16 phase 2: the click-to-enlarge view of a transcript image, shared by the conversation, the Images tab and the desk
 * prints. A native modal `<dialog>` (top layer, inert page, Tab trapped), like the composer's preview, with what a
 * screenshot needs: the full image (the thumbnail shows at once, blurred up), zoom (wheel, + / -, drag to pan, double click
 * for actual size), "copy image" and, from the tab and the prints, "jump to message". An image that is not available
 * (outside the bridge's roots, gone, binary) is a card that says so with its path as text; one over 12 MiB shows its
 * thumbnail with a note.
 *
 * Esc closes only this (swallowed in the capture phase, its held repeats too); every other key is the dialog's: the
 * game underneath never sees it.
 */

let openCount = 0;
/** True while a lightbox is up: the game's own key handling can ask. */
export const imageLightboxOpen = (): boolean => openCount > 0;

export interface LightboxOptions {
  /** Where the images come from (null: only the "not available" card can show). */
  feed: ImageFeed | null;
  refs: ImageRef[];
  index: number;
  /** "Jump to message": closes the lightbox first. */
  onJump?: (ref: ImageRef) => void;
  onClosed?: () => void;
  /** Where the dialog goes (default: the document body). */
  host?: HTMLElement;
}

export interface Lightbox {
  close(): void;
  show(index: number): void;
  readonly isOpen: boolean;
  readonly index: number;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 16;
const STEP = 1.25;
/** A click closes only if the pointer moved no more than this between press and release. */
const DRAG_PX = 4;

/** "Agent viewed" / "You sent" / "Agent generated". */
export function originLabel(r: Pick<ImageRef, 'origin' | 'kind'>): string {
  if (r.origin === 'input') return 'You sent';
  return r.kind === 'generated' ? 'Agent generated' : 'Agent viewed';
}

const REASONS: Record<string, string> = {
  not_allowed: 'The bridge only opens images from Drop Zone, the agent’s own folders and the worker’s directory.',
  missing: 'The file is gone.',
  too_large: 'The file is over 25 MB.',
  not_image: 'The file is not a PNG, JPEG, GIF or WebP image.',
  invalid: 'The image data could not be read.',
  omitted: 'This herdr-world is older than image support: update the bridge to see images.',
};

export function unavailableText(r: Pick<ImageRef, 'unavailable' | 'reason' | 'mime'>): string {
  if (r.mime === 'binary') return 'These bytes are not an image the game can show.';
  return REASONS[r.reason ?? ''] ?? 'The bridge did not open this image.';
}

function timeText(ts: number | undefined): string {
  if (!ts || !Number.isFinite(ts) || ts <= 0) return '';
  return new Date(ts).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });
}

/** PNG bytes of an image blob (the clipboard takes PNG). */
async function asPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob;
  const bmp = await createImageBitmap(blob);
  try {
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const g = c.getContext('2d');
    if (!g) throw new Error('no canvas');
    g.drawImage(bmp, 0, 0);
    return await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/png'));
  } finally {
    bmp.close();
  }
}

export function openImageLightbox(o: LightboxOptions): Lightbox {
  const refs = o.refs;
  let index = Math.min(Math.max(0, o.index), Math.max(0, refs.length - 1));
  let done = false;
  let gen = 0;
  // Zoom state: `z` times the fitted size, panned by (px, py) CSS px.
  let z = 1;
  let px = 0;
  let py = 0;
  let natural: { w: number; h: number } | null = null;
  let full: Blob | null = null;

  const cap = h('div', { class: 'ilb-cap' });
  const status = h('div', { class: 'ilb-status', role: 'status', 'aria-live': 'polite' });
  const pic = h('img', { class: 'ilb-img', alt: '', draggable: 'false' });
  const card = h('div', { class: 'ilb-card', hidden: true });
  const note = h('div', { class: 'ilb-note', hidden: true });
  const stage = h('div', { class: 'ilb-stage' }, pic, card);
  const count = h('div', { class: 'ilb-count' });

  const btn = (cls: string, label: string, path: string, on: () => void) => h('button', { class: `ilb-btn ${cls}`, 'aria-label': label, title: label, onclick: on }, icon(path));
  const zoomOut = btn('ilb-zoom-out', 'Zoom out (−)', '<path d="M5 12h14"/>', () => setZoom(z / STEP));
  const zoomIn = btn('ilb-zoom-in', 'Zoom in (+)', ICON.plus, () => setZoom(z * STEP));
  const zoomFit = h('button', { class: 'ilb-btn ilb-fit', title: 'Fit to screen (0) or actual size (1)', onclick: () => toggleActual() }, 'Fit');
  const copyBtn = h('button', { class: 'ilb-btn ilb-copy', title: 'Copy image (C)', onclick: () => void copy() }, icon('<rect x="8.5" y="8.5" width="10" height="11" rx="1.6"/><path d="M15.5 8.5v-2a1.6 1.6 0 0 0-1.6-1.6H7A1.6 1.6 0 0 0 5.5 6.5v8.8A1.6 1.6 0 0 0 7 16.9h1.5"/>'), 'Copy image');
  const jumpBtn = h('button', { class: 'ilb-btn ilb-jump', title: 'Show this in the conversation (J)', onclick: () => jump() }, icon('<path d="M5 12h10.5M11.5 7.5 16 12l-4.5 4.5"/><path d="M19.5 5v14"/>'), 'Jump to message');
  const closeBtn = h('button', { class: 'ilb-btn ilb-close', 'aria-label': 'Close (Esc)', title: 'Close (Esc)', onclick: () => close() }, icon(ICON.close));
  const prev = h('button', { class: 'ilb-nav ilb-prev', 'aria-label': 'Previous image (←)', title: 'Previous image (←)', onclick: () => show(index - 1) }, icon(ICON.back));
  const next = h('button', { class: 'ilb-nav ilb-next', 'aria-label': 'Next image (→)', title: 'Next image (→)', onclick: () => show(index + 1) }, icon('<path d="M9.5 6l6 6-6 6"/>'));
  const tools = h('div', { class: 'ilb-tools' }, zoomOut, zoomFit, zoomIn, copyBtn, o.onJump ? jumpBtn : null, closeBtn);
  const dlg = h('dialog', { class: 'ilb', 'aria-label': 'Image', 'aria-modal': 'true' }, stage, h('div', { class: 'ilb-top' }, cap, tools), note, status, refs.length > 1 ? prev : null, refs.length > 1 ? next : null, refs.length > 1 ? count : null);

  const cur = (): ImageRef | undefined => refs[index];

  function apply(): void {
    pic.style.transform = z === 1 && px === 0 && py === 0 ? '' : `translate(${px}px, ${py}px) scale(${z})`;
    dlg.classList.toggle('ilb-zoomed', z > 1);
    zoomOut.disabled = z <= MIN_ZOOM;
    zoomIn.disabled = z >= MAX_ZOOM;
    zoomFit.textContent = z > 1 ? `${Math.round(z * 100)}%` : 'Fit';
  }

  function clampPan(): void {
    const w = pic.clientWidth * z;
    const hh = pic.clientHeight * z;
    const maxX = Math.max(0, (w - stage.clientWidth) / 2 + 40);
    const maxY = Math.max(0, (hh - stage.clientHeight) / 2 + 40);
    px = Math.min(maxX, Math.max(-maxX, px));
    py = Math.min(maxY, Math.max(-maxY, py));
  }

  function setZoom(nz: number): void {
    z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nz));
    if (z === 1) px = py = 0;
    clampPan();
    apply();
  }

  /** Between fit and the image's own pixels (1 CSS px per image px, on a css-pixel screen). */
  function toggleActual(): void {
    if (z > 1) return setZoom(1);
    const shown = pic.clientWidth;
    if (natural && shown > 0) setZoom(Math.max(1.5, natural.w / shown));
    else setZoom(2);
  }

  function setStatus(text: string): void {
    status.textContent = text;
  }

  function showCard(r: ImageRef, why: string): void {
    pic.hidden = true;
    pic.removeAttribute('src');
    card.hidden = false;
    card.replaceChildren(
      h('div', { class: 'ilb-card-icon' }, icon(ICON.image)),
      h('div', { class: 'ilb-card-title' }, 'Image not available'),
      h('div', { class: 'ilb-card-why' }, why),
      ...(r.path ? [h('code', { class: 'ilb-card-path' }, r.path)] : []),
    );
    full = null;
    copyBtn.disabled = true;
    natural = null;
    setZoom(1);
  }

  function caption(r: ImageRef): void {
    const dims = r.width && r.height ? `${r.width} × ${r.height}` : '';
    const when = timeText(r.ts);
    cap.replaceChildren(h('span', { class: `ilb-badge ilb-badge-${r.origin}` }, originLabel(r)), ...(dims ? [h('span', { class: 'ilb-meta' }, dims)] : []), ...(when ? [h('span', { class: 'ilb-meta' }, when)] : []));
    pic.alt = `${originLabel(r)}${dims ? `, ${dims}` : ''}`;
    count.textContent = refs.length > 1 ? `${index + 1} / ${refs.length}` : '';
    prev.disabled = index <= 0;
    next.disabled = index >= refs.length - 1;
    jumpBtn.hidden = !o.onJump || !r.item_id;
  }

  function load(): void {
    const r = cur();
    const my = ++gen;
    z = 1;
    px = py = 0;
    natural = null;
    full = null;
    note.hidden = true;
    setStatus('');
    card.hidden = true;
    pic.hidden = false;
    pic.classList.remove('ilb-loading');
    copyBtn.disabled = true;
    apply();
    if (!r) return showEmpty();
    caption(r);
    const feed = o.feed;
    if (r.unavailable || !r.hash || !feed || !feed.canFetch(r)) return showCard(r, unavailableText(r));
    const thumb = feed.thumbNow(r.hash);
    if (thumb) {
      pic.src = thumb.url;
      pic.classList.add('ilb-loading');
    } else {
      pic.removeAttribute('src');
      pic.classList.add('ilb-loading');
      void feed.thumb(r.hash).then((t) => {
        if (my === gen && t && !full) pic.src = t.url;
      });
    }
    setStatus('Loading…');
    void feed.full(r.hash).then((res) => {
      if (my !== gen || done) return;
      if (res.ok) {
        full = res.blob;
        natural = { w: res.width || r.width || 0, h: res.height || r.height || 0 };
        pic.src = res.url;
        pic.classList.remove('ilb-loading');
        copyBtn.disabled = false;
        setStatus('');
        return;
      }
      pic.classList.remove('ilb-loading');
      if (res.reason === 'too_large') {
        note.hidden = false;
        note.textContent = res.message;
        setStatus('');
        // The thumbnail is what there is: copy that.
        const t = feed.thumbNow(r.hash as string);
        if (t) {
          full = t.blob;
          natural = { w: t.width, h: t.height };
          pic.src = t.url;
          copyBtn.disabled = false;
        }
        return;
      }
      if (feed.thumbNow(r.hash as string)) {
        note.hidden = false;
        note.textContent = res.reason === 'error' ? `${res.message} The thumbnail is shown.` : 'The full image is not available: the thumbnail is shown.';
        setStatus('');
        return;
      }
      showCard(r, res.reason === 'error' ? res.message : unavailableText({ ...r, unavailable: true }));
    });
  }

  function showEmpty(): void {
    showCard({ source: 'inline', origin: 'agent', unavailable: true, reason: 'invalid' }, 'There is no image to show.');
  }

  function show(i: number): void {
    if (done || i < 0 || i >= refs.length || i === index) return;
    index = i;
    load();
  }

  async function copy(): Promise<void> {
    if (!full) return;
    try {
      const png = await asPng(full);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      setStatus('Image copied');
    } catch (e) {
      setStatus(`Couldn’t copy: ${e instanceof Error && e.message ? e.message : 'the browser refused'}`);
    }
  }

  function jump(): void {
    const r = cur();
    if (!r || !o.onJump) return;
    close();
    o.onJump(r);
  }

  // --- pointer: drag to pan when zoomed, click on the empty surface to close, wheel to zoom ---
  let downOnSurface = false;
  let downAt = { x: 0, y: 0 };
  let pan: { x: number; y: number; px: number; py: number } | null = null;
  stage.addEventListener('pointerdown', (e) => {
    downOnSurface = e.target === stage;
    downAt = { x: e.clientX, y: e.clientY };
    if (z > 1 && e.target === pic) {
      pan = { x: e.clientX, y: e.clientY, px, py };
      stage.setPointerCapture(e.pointerId);
      dlg.classList.add('ilb-panning');
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pan) return;
    px = pan.px + (e.clientX - pan.x);
    py = pan.py + (e.clientY - pan.y);
    clampPan();
    apply();
  });
  const endPan = () => {
    pan = null;
    dlg.classList.remove('ilb-panning');
  };
  stage.addEventListener('pointerup', endPan);
  stage.addEventListener('pointercancel', endPan);
  stage.addEventListener('click', (e) => {
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > DRAG_PX;
    const ok = downOnSurface && e.target === stage && !moved;
    downOnSurface = false;
    if (ok) close();
  });
  stage.addEventListener('dblclick', (e) => {
    if (e.target === pic) toggleActual();
  });
  stage.addEventListener(
    'wheel',
    (e) => {
      if (card.hidden === false) return;
      e.preventDefault();
      setZoom(z * (e.deltaY < 0 ? STEP : 1 / STEP));
    },
    { passive: false },
  );

  // --- keys: the dialog's; the game underneath sees none of them ---
  const onKey = (e: KeyboardEvent): void => {
    if (e.isComposing) return;
    if (e.key === 'Escape') {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (!e.repeat) close(true);
      return;
    }
    // Tab stays the browser's (the dialog traps it); every other key is ours and nobody else's.
    if (e.key === 'Tab') return;
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case '+':
      case '=':
        setZoom(z * STEP);
        break;
      case '-':
      case '_':
        setZoom(z / STEP);
        break;
      case '0':
        setZoom(1);
        break;
      case '1':
        if (z === 1) toggleActual();
        else setZoom(1);
        break;
      case 'ArrowLeft':
        if (z > 1) {
          px += 60;
          clampPan();
          apply();
        } else show(index - 1);
        break;
      case 'ArrowRight':
        if (z > 1) {
          px -= 60;
          clampPan();
          apply();
        } else show(index + 1);
        break;
      case 'ArrowUp':
        if (z > 1) {
          py += 60;
          clampPan();
          apply();
        }
        break;
      case 'ArrowDown':
        if (z > 1) {
          py -= 60;
          clampPan();
          apply();
        }
        break;
      case 'c':
      case 'C':
        void copy();
        break;
      case 'j':
      case 'J':
        jump();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };
  const refuseCancel = (e: Event): void => {
    e.preventDefault();
    close(true);
  };
  dlg.addEventListener('cancel', refuseCancel);
  dlg.addEventListener('close', () => close());
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', swallowKeyup, true);
  const hostDialog = (o.host ?? document.body).closest('dialog');
  const refuseHostCancel = (e: Event): void => {
    if (e.target !== hostDialog) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  hostDialog?.addEventListener('cancel', refuseHostCancel, true);

  function swallowKeyup(e: KeyboardEvent): void {
    if (e.target instanceof Node && dlg.contains(e.target)) e.stopPropagation();
  }

  function close(byKey = false): void {
    if (done) return;
    done = true;
    gen++;
    openCount--;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', swallowKeyup, true);
    hostDialog?.removeEventListener('cancel', refuseHostCancel, true);
    if (byKey) swallowHeldEscape(hostDialog);
    if (dlg.open) dlg.close();
    dlg.remove();
    o.onClosed?.();
  }

  (o.host ?? document.body).append(dlg);
  openCount++;
  dlg.showModal();
  closeBtn.focus({ preventScroll: true });
  load();
  return {
    close: () => close(),
    show,
    get isOpen() {
      return !done;
    },
    get index() {
      return index;
    },
  };
}

/** A held Esc goes on repeating after the lightbox it closed: swallowed until the key is up (or a second of quiet). */
function swallowHeldEscape(hostDialog: HTMLDialogElement | null): void {
  let timer = 0;
  const lift = (): void => {
    window.clearTimeout(timer);
    window.removeEventListener('keydown', onDown, true);
    window.removeEventListener('keyup', onUp, true);
    window.removeEventListener('blur', lift);
    hostDialog?.removeEventListener('cancel', refuse, true);
  };
  const arm = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(lift, 1000);
  };
  const onDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !e.repeat) {
      lift();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    arm();
  };
  const onUp = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') lift();
  };
  const refuse = (e: Event): void => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  window.addEventListener('keydown', onDown, true);
  window.addEventListener('keyup', onUp, true);
  window.addEventListener('blur', lift);
  hostDialog?.addEventListener('cancel', refuse, true);
  arm();
}
