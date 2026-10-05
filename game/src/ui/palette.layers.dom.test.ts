// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openPreview } from './composer/lightbox';
import { inPalette } from './dismiss';
import { openImageLightbox } from './imageLightbox';

// #147: the command palette opens over the image previews (the issue's "every view"), as a modal on top of them. Their window
// capture-phase keys (Esc closes the preview, everything else is theirs) leave a key from inside the palette alone, so Esc closes
// only the palette and the preview stays up under it.

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});
afterEach(() => void (document.body.innerHTML = ''));

/** A palette over the preview: a dialog with a field, in the document after it. */
function palette(): { dlg: HTMLDialogElement; input: HTMLInputElement } {
  const dlg = document.createElement('dialog');
  dlg.className = 'credits palette';
  const input = document.createElement('input');
  dlg.append(input);
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, input };
}

/** Presses `key` on `target`; true when the page cancelled it. */
function press(target: Element, key: string, o: KeyboardEventInit = {}): { cancelled: boolean; seen: boolean } {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...o });
  let seen = false;
  target.addEventListener('keydown', () => (seen = true), { once: true });
  target.dispatchEvent(e);
  return { cancelled: e.defaultPrevented, seen };
}

describe('inPalette', () => {
  it('is true for what comes from inside the palette, false elsewhere', () => {
    const { input } = palette();
    const seen: boolean[] = [];
    window.addEventListener('keydown', (e) => seen.push(inPalette(e)), { once: true });
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    window.addEventListener('keydown', (e) => seen.push(inPalette(e)), { once: true });
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(seen).toEqual([true, false]);
  });
});

describe('the image previews under the command palette (#147)', () => {
  it('the composer preview keeps its Esc to itself when the key comes from the palette, and still closes on the page', () => {
    const closed = vi.fn();
    const p = openPreview(document.body, { url: '', name: 'a.png', label: 'Image 1' }, () => undefined, closed);
    const pal = palette();
    const esc = press(pal.input, 'Escape');
    expect(esc.seen).toBe(true); // it reached the palette's field
    expect(esc.cancelled).toBe(false);
    expect(p.isOpen).toBe(true);
    pal.dlg.close();
    const onPage = press(document.body.querySelector('.cmp-lightbox') as Element, 'Escape');
    expect(onPage.cancelled).toBe(true);
    expect(p.isOpen).toBe(false);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('the image lightbox lets a palette key through, Esc and the arrows included, and closes on Esc from the page', () => {
    const lb = openImageLightbox({ feed: null, refs: [], index: 0 });
    const pal = palette();
    for (const k of ['Escape', 'ArrowDown', 'Enter', '+']) {
      const r = press(pal.input, k);
      expect([k, r.seen, r.cancelled]).toEqual([k, true, false]);
    }
    expect(lb.isOpen).toBe(true);
    pal.dlg.close();
    const onPage = press(document.querySelector('dialog.ilb') as Element, 'Escape');
    expect(onPage.cancelled).toBe(true);
    expect(lb.isOpen).toBe(false);
  });
});
