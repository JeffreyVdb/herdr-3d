/**
 * The editor's DOM and the document, both ways.
 *
 * The editable root holds text nodes and chips (`.cmp-chip`, `contenteditable=false`), and a last `<br class="cmp-tail">`
 * that only gives a trailing newline a line to show. Everything else in it is foreign (a `<br>` or `<div>` the
 * browser made): read as text (`<br>` = LF, a block after other content starts a new line), and a reason to draw the
 * editor again in its canonical shape. An empty text run is a text node holding U+200B, so a caret has a place beside
 * a chip and between two chips; the reader drops it, and so does every offset counted here.
 *
 * One walk (`linearize`) defines what the DOM says; reading a document out of it and mapping a DOM point to an
 * offset (and back) all use it, so they cannot disagree.
 */

import { type Doc, IMG, type Occurrence } from './model';

export const CHIP = 'cmp-chip';
export const TAIL = 'cmp-tail';

export const isChip = (n: Node): n is HTMLElement => n instanceof HTMLElement && n.classList.contains(CHIP);
const isTail = (n: Node): boolean => n instanceof HTMLElement && n.classList.contains(TAIL);
const BLOCKS = new Set(['DIV', 'P', 'LI', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

type Item =
  | { kind: 'text'; node: Text; text: string }
  | { kind: 'chip'; el: HTMLElement }
  /** A `<br>` or the line break before a block: one LF. */
  | { kind: 'nl'; node: Node };

const strip = (s: string) => s.replace(/[​￼]/g, '');

/** What the DOM says, in order. `foreign` is true if anything but our own nodes was found. */
export function linearize(root: HTMLElement): { items: Item[]; foreign: boolean } {
  const items: Item[] = [];
  let foreign = false;
  let any = false;
  const walk = (parent: Node): void => {
    for (const n of Array.from(parent.childNodes)) {
      if (n.nodeType === Node.TEXT_NODE) {
        const text = strip((n as Text).data);
        items.push({ kind: 'text', node: n as Text, text });
        if (text !== '') any = true;
      } else if (isChip(n)) {
        items.push({ kind: 'chip', el: n });
        any = true;
      } else if (isTail(n)) {
        // The line for a trailing newline: says nothing.
      } else if (n instanceof HTMLElement && n.tagName === 'BR') {
        foreign = true;
        items.push({ kind: 'nl', node: n });
        any = true;
      } else if (n instanceof HTMLElement) {
        foreign = true;
        if (BLOCKS.has(n.tagName) && any) items.push({ kind: 'nl', node: n });
        walk(n);
      }
    }
  };
  walk(root);
  return { items, foreign };
}

/** The document the DOM holds, its chips found in `known` by occurrence id (an unknown chip is dropped). */
export function readDoc(root: HTMLElement, known: ReadonlyMap<string, Occurrence>): { doc: Doc; foreign: boolean } {
  const { items, foreign } = linearize(root);
  let text = '';
  const images: Occurrence[] = [];
  let bad = foreign;
  for (const it of items) {
    if (it.kind === 'text') text += it.text;
    else if (it.kind === 'nl') text += '\n';
    else {
      const o = known.get(it.el.dataset.occ ?? '');
      if (!o) {
        bad = true;
        continue;
      }
      text += IMG;
      images.push(o);
    }
  }
  // Two chips for one occurrence (a copy the browser made) are one.
  const seen = new Set<string>();
  let dupText = '';
  const dupImages: Occurrence[] = [];
  let k = 0;
  for (const ch of text) {
    if (ch === IMG) {
      const o = images[k++] as Occurrence;
      if (seen.has(o.occ)) {
        bad = true;
        continue;
      }
      seen.add(o.occ);
      dupImages.push(o);
    }
    dupText += ch;
  }
  return { doc: { text: dupText, images: dupImages }, foreign: bad };
}

/**
 * Is the structure the one `render` makes: text, chip, text, chip … text, with a text node (possibly U+200B)
 * wherever there is no text? Then a caret has a home everywhere and nothing needs to be redrawn.
 */
export function isCanonical(root: HTMLElement): boolean {
  let last: 'start' | 'text' | 'chip' = 'start';
  for (const n of Array.from(root.childNodes)) {
    if (isTail(n)) continue;
    if (n.nodeType === Node.TEXT_NODE) {
      if ((n as Text).data === '') return false;
      last = 'text';
    } else if (isChip(n)) {
      if (last !== 'text') return false; // a chip with no text node before it: no home for a caret there
      last = 'chip';
    } else return false;
  }
  return last === 'text';
}

/** The offset a DOM point stands for. A point inside a chip is before it. */
export function pointToOffset(root: HTMLElement, node: Node, offset: number): number {
  if (node !== root && !root.contains(node)) return 0;
  const marker = root.ownerDocument.createRange();
  try {
    marker.setStart(node, offset);
  } catch {
    return 0;
  }
  marker.collapse(true);
  // comparePoint: -1 the point is before the marker, 0 at it, 1 after it.
  const cmp = (n: Node, off: number): number => marker.comparePoint(n, off);
  const at = (n: Node): [Node, number] => [n.parentNode as Node, Array.prototype.indexOf.call((n.parentNode as Node).childNodes, n) as number];
  let total = 0;
  for (const it of linearize(root).items) {
    if (it.kind === 'text') {
      if (it.node === node) return total + strip(it.node.data.slice(0, offset)).length;
      if (cmp(it.node, it.node.length) > 0) return total;
      total += it.text.length;
    } else if (it.kind === 'chip') {
      if (it.el === node || it.el.contains(node)) return total;
      const [p, i] = at(it.el);
      if (cmp(p, i + 1) > 0) return total;
      total += 1;
    } else {
      const [p, i] = at(it.node);
      // A <br> counts once it is behind the point; a block's line break once the point is inside or after it.
      const counted = it.node.nodeName === 'BR' ? cmp(p, i + 1) <= 0 : cmp(p, i) < 0;
      if (!counted) return total;
      total += 1;
    }
  }
  return total;
}

/** The DOM point for an offset, preferring the end of a text over the start of a chip, and text over the gap. */
export function offsetToPoint(root: HTMLElement, offset: number): { node: Node; offset: number } {
  const { items } = linearize(root);
  let acc = 0;
  for (const it of items) {
    if (it.kind === 'text') {
      const len = it.text.length;
      if (offset <= acc + len) {
        return { node: it.node, offset: rawOffset(it.node.data, offset - acc) };
      }
      acc += len;
    } else if (it.kind === 'chip') {
      if (offset === acc) return gap(it.el);
      acc += 1;
    } else {
      if (offset <= acc) return gap(it.node);
      acc += 1;
    }
  }
  const tail = Array.from(root.childNodes).find(isTail);
  return { node: root, offset: tail ? Array.prototype.indexOf.call(root.childNodes, tail) : root.childNodes.length };
}

/** The point just before a node. */
function gap(n: Node): { node: Node; offset: number } {
  const p = n.parentNode as Node;
  return { node: p, offset: Array.prototype.indexOf.call(p.childNodes, n) as number };
}

/** The index in `data` after `n` characters that count (U+200B and U+FFFC do not). Past a U+200B when it is all there is. */
function rawOffset(data: string, n: number): number {
  let seen = 0;
  for (let i = 0; i < data.length; i++) {
    if (seen === n) return data[i] === '​' || data[i] === '￼' ? i + 1 : i;
    if (data[i] !== '​' && data[i] !== '￼') seen++;
  }
  return data.length;
}

/** A text node's flat length (what it counts for in a document). */
export const flatLength = (t: Text): number => strip(t.data).length;
