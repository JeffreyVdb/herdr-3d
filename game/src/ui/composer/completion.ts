/**
 * #139: the composer's completion popup: a listbox under the caret, fed by the source of the trigger the caret is in
 * (`complete.ts`). The composer calls in on what it sees (text typed, the caret moved, the draft redrawn, a key) and
 * the popup never takes focus: its rows are not focusable and a press on it does not blur the editor, so the editor
 * keeps the keyboard and says which row is active with `aria-activedescendant`.
 *
 * A session opens only when text is typed (an `input` or an IME commit) and leaves the caret in a token; it follows
 * the caret while it stays in that token (same trigger, same start) and closes when the caret leaves it, on a pick,
 * on Esc, on blur, while composing, while the editor is read-only, on another draft and on dispose. Moving the caret
 * back into a token does not open it again: typing does.
 *
 * Every query aborts the previous one's signal and gets a sequence number: a reply that is not the latest is dropped.
 * A pending reply shows "Loading…" (or keeps the rows already shown, dimmed: they answer an older query, so none is
 * active and none can be picked until the reply comes), an empty one "No match", a rejected one says so: the popup is
 * never stuck loading.
 *
 * It is placed under the caret, so it lives only while the caret is in view: when the editor scrolls the caret out of
 * its visible box (or out of the bounds) the session closes rather than float beside nothing, and it does not come back
 * when the caret is scrolled back (typing opens one). Text typed with the caret out of view is not that: the browser
 * scrolls the caret into view only after the `input`, so the caret gets until the next frame to be back in view.
 *
 * Keys while it is open: ↑ ↓ move the active row and wrap around; Tab and Enter pick it; Esc closes the popup and only
 * the popup (the transcript, the dialog and the seated view never see that Esc). With no row to pick (none, or only
 * the dimmed rows of an older query) the arrows and Tab are the editor's, and Enter closes the popup and sends nothing.
 * Every other key, and every key while it is closed, is the editor's as before.
 *
 * #140: a source may be unavailable (its trigger opens nothing), hears when a session of it is about to open, may say
 * its items changed (an open session of it asks its query again, the active row kept by the source's `key`, or closes
 * when the source is now unavailable) and may put a note under the rows (`footer`).
 */

import { h } from '../dom';
import { findToken, replaceRangeOf, type Source, type Token, type Trigger } from './complete';
import type { Draft } from './draft';
import type { Selection } from './model';
import { offsetToPoint } from './tree';

export interface CompleteOptions {
  /** One source per trigger; none (or an empty list) never opens a popup. */
  sources: readonly Source[];
  /** What the popup stays inside (default: the composer's dialog, else the window). */
  bounds?: () => Element | null;
}

export interface CompletionHost {
  id: string;
  editor: HTMLElement;
  /** The composer's root: the popup is its child, placed against it. */
  element: HTMLElement;
  draft(): Draft;
  /** The live selection in the editor, or null when it is not there. */
  selection(): Selection | null;
  /** Composing, read-only or gone: no popup. */
  blocked(): boolean;
  announce(text: string): void;
}

export interface Completion {
  readonly isOpen: boolean;
  /** Text was typed: a session may open. */
  typed(): void;
  /** The caret moved or the draft was redrawn: an open session follows or closes. */
  update(): void;
  /** A keydown in the editor; true when the popup took it. */
  key(e: KeyboardEvent): boolean;
  close(): void;
  dispose(): void;
}

interface Session {
  token: Token;
  source: Source;
  query: string | null;
  items: unknown[];
  active: number;
  state: 'loading' | 'ready' | 'error';
  seq: number;
  ac: AbortController | null;
  /** #140: the key of the row to keep active when the next reply comes (the source changed). */
  keep: string | null;
}

const GAP = 4;
const PAD = 6;
const frame = (f: () => void): number => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(f) : window.setTimeout(f, 16));
const cancelFrame = (id: number): void => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : window.clearTimeout(id));

export function mountCompletion(host: CompletionHost, o: CompleteOptions): Completion {
  const { editor, element, id } = host;
  const triggers = [...new Set(o.sources.map((s) => s.trigger))] as Trigger[];
  let s: Session | null = null;
  let pop: HTMLElement | null = null;
  let list: HTMLElement | null = null;
  let status: HTMLElement | null = null;
  let note: HTMLElement | null = null;
  let said = '';
  let recheck = 0;
  const listId = `${id}-pop`;
  const optId = (i: number) => `${id}-opt-${i}`;

  /** Made on the first open: a composer that never completes keeps its DOM as it was. */
  function popup(): { pop: HTMLElement; list: HTMLElement; status: HTMLElement; note: HTMLElement } {
    if (pop && list && status && note) return { pop, list, status, note };
    list = h('ul', { class: 'cmp-pop-list', id: listId, role: 'listbox' });
    status = h('p', { class: 'cmp-pop-status' });
    note = h('p', { class: 'cmp-pop-note', hidden: true });
    const hint = h('p', { class: 'cmp-pop-hint', 'aria-hidden': 'true' }, 'Tab or Enter picks, Esc closes');
    pop = h('div', { class: 'cmp-pop', hidden: true }, list, status, note, hint);
    // A press anywhere on it keeps the focus (and the caret) in the editor.
    pop.addEventListener('mousedown', (e) => e.preventDefault());
    pop.addEventListener('click', (e) => {
      const row = (e.target as Element).closest<HTMLElement>('[role="option"]');
      if (!row || !s) return;
      const i = Number(row.dataset.i);
      if (Number.isInteger(i)) pick(i);
    });
    element.classList.add('cmp--complete');
    element.append(pop);
    return { pop, list, status, note };
  }

  /** #140: a source said its items changed: its open session asks again (or closes, the source now unavailable). */
  function changed(src: Source): void {
    const cur = s;
    if (!cur || cur.source !== src) return;
    if (src.available?.() === false) return close();
    const item = cur.state === 'ready' ? cur.items[cur.active] : undefined;
    cur.keep = item !== undefined && src.key ? src.key(item) : null;
    query(cur, cur.query ?? cur.token.query);
  }
  const unsubs = o.sources.map((src) => src.subscribe?.(() => changed(src)));

  // ---- sessions --------------------------------------------------------------------------

  function evaluate(opening: boolean): void {
    if (!opening && !s) return;
    if (host.blocked() || triggers.length === 0) return close();
    const sel = host.selection();
    const tok = sel ? findToken(host.draft().doc.text, sel, triggers) : null;
    if (!tok) return close();
    if (s && s.token.trigger === tok.trigger && s.token.start === tok.start) s.token = tok;
    else if (opening) {
      close();
      const source = o.sources.find((x) => x.trigger === tok.trigger) as Source;
      source.opening?.();
      if (source.available?.() === false) return;
      s = { token: tok, source, query: null, items: [], active: -1, state: 'loading', seq: 0, ac: null, keep: null };
      window.addEventListener('resize', follow);
      editor.addEventListener('scroll', follow);
    } else return close();
    if (s.query !== tok.query) query(s, tok.query);
    else place(true);
  }

  function query(cur: Session, q: string): void {
    cur.ac?.abort();
    const ac = new AbortController();
    cur.ac = ac;
    cur.query = q;
    const seq = ++cur.seq;
    const live = () => s === cur && cur.seq === seq && !ac.signal.aborted;
    let r: ReturnType<Source['items']>;
    try {
      r = cur.source.items(q, ac.signal);
    } catch {
      return fail(cur);
    }
    if (!Array.isArray(r)) {
      // The rows shown, if any, are the previous query's: dimmed, none active, none to pick.
      cur.state = 'loading';
      cur.active = -1;
      paint(false);
      Promise.resolve(r).then(
        (items) => {
          if (live()) show(cur, items);
        },
        () => {
          if (live()) fail(cur);
        },
      );
    } else show(cur, r);
  }

  function fail(cur: Session): void {
    cur.items = [];
    cur.active = -1;
    cur.state = 'error';
    paint(true);
  }

  function show(cur: Session, items: readonly unknown[]): void {
    cur.items = [...items];
    const key = cur.source.key;
    const kept = cur.keep !== null && key ? cur.items.findIndex((it) => key(it) === cur.keep) : -1;
    cur.keep = null;
    cur.active = kept >= 0 ? kept : cur.items.length > 0 ? 0 : -1;
    cur.state = 'ready';
    paint(true);
  }

  // ---- drawing ---------------------------------------------------------------------------

  /** Draws the session (`rows`: the items changed, the rows are drawn again). */
  function paint(rows: boolean): void {
    if (!s) return;
    const p = popup();
    if (rows) {
      const cur = s;
      p.list.replaceChildren(
        ...cur.items.map((item, i) => {
          return h('li', { class: 'cmp-pop-opt', id: optId(i), role: 'option', 'data-i': String(i), 'aria-selected': 'false' }, cur.source.render(item));
        }),
      );
      p.list.scrollTop = 0;
    }
    p.list.setAttribute('aria-label', s.source.label ?? 'Suggestions');
    const loading = s.state === 'loading';
    p.list.toggleAttribute('data-loading', loading);
    p.list.setAttribute('aria-busy', String(loading));
    for (const row of p.list.children) {
      if (loading) row.setAttribute('aria-disabled', 'true');
      else row.removeAttribute('aria-disabled');
    }
    const none = s.items.length === 0;
    const text = s.state === 'error' ? 'Could not load matches.' : loading ? (none ? 'Loading…' : '') : none ? 'No match' : '';
    p.status.textContent = text;
    p.status.hidden = text === '';
    p.status.dataset.kind = s.state;
    const foot = s.source.footer?.() ?? '';
    p.note.textContent = foot;
    p.note.hidden = foot === '';
    p.pop.hidden = false;
    editor.setAttribute('aria-autocomplete', 'list');
    editor.setAttribute('aria-controls', listId);
    editor.setAttribute('aria-expanded', 'true');
    paintActive();
    if (rows && !loading) {
      const n = s.items.length;
      const msg = s.state === 'error' ? 'Could not load matches.' : n === 0 ? 'No match' : `${n} ${n === 1 ? 'suggestion' : 'suggestions'}`;
      if (msg !== said) host.announce(msg);
      said = msg;
    }
    place(true);
  }

  function paintActive(): void {
    if (!s || !list) return;
    const rows = list.children;
    for (let i = 0; i < rows.length; i++) rows[i]?.setAttribute('aria-selected', String(i === s.active));
    const row = rows[s.active] as HTMLElement | undefined;
    if (row) {
      editor.setAttribute('aria-activedescendant', row.id);
      if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
      else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
    } else editor.removeAttribute('aria-activedescendant');
  }

  /** The viewport box of a collapsed caret at `offset`, with a fallback where the browser gives none (an empty line, beside a chip). */
  function caretBox(offset: number): DOMRect | null {
    const p = offsetToPoint(editor, offset);
    const r = document.createRange();
    try {
      r.setStart(p.node, p.offset);
    } catch {
      return null;
    }
    r.collapse(true);
    const empty = (b: DOMRect | undefined): boolean => !b || (b.width === 0 && b.height === 0 && b.top === 0 && b.left === 0);
    const box = typeof r.getBoundingClientRect === 'function' ? r.getBoundingClientRect() : undefined;
    if (!empty(box)) return box as DOMRect;
    // The character before, in the same text node: the caret is at its right edge.
    if (p.node.nodeType === Node.TEXT_NODE && p.offset > 0 && typeof r.getBoundingClientRect === 'function') {
      r.setStart(p.node, p.offset - 1);
      r.setEnd(p.node, p.offset);
      const b = r.getBoundingClientRect();
      if (!empty(b)) return new DOMRect(b.right, b.top, 0, b.height);
    }
    // A chip beside it, else the editor's first line.
    const near = p.node.nodeType === Node.TEXT_NODE ? (p.node.previousSibling ?? p.node.nextSibling) : (p.node.childNodes[p.offset - 1] ?? p.node.childNodes[p.offset]);
    if (near instanceof HTMLElement) {
      const b = near.getBoundingClientRect();
      if (!empty(b)) return new DOMRect(near === p.node.nextSibling || near === p.node.childNodes[p.offset] ? b.left : b.right, b.top, 0, b.height);
    }
    const e = editor.getBoundingClientRect();
    const cs = getComputedStyle(editor);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.45 || 18;
    return new DOMRect(e.left + (parseFloat(cs.paddingLeft) || 0), e.top + (parseFloat(cs.paddingTop) || 0) - editor.scrollTop, 0, lh);
  }

  /** The browser's own caret, when it is a collapsed one in the editor with a box. */
  function liveCaret(): DOMRect | null {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed || !editor.contains(sel.focusNode)) return null;
    const r = sel.getRangeAt(0);
    if (typeof r.getBoundingClientRect !== 'function') return null;
    const b = r.getBoundingClientRect();
    return b.width === 0 && b.height === 0 && b.top === 0 && b.left === 0 ? null : b;
  }

  /** The trigger character's own box (a caret before it, at the start of a line, is placed at the end of the line above). */
  function triggerBox(offset: number): DOMRect | null {
    const p = offsetToPoint(editor, offset);
    let node: Node | null = p.node;
    let at = p.offset;
    // The end of one text node is the start of the next: the browser may have typed the trigger into a node of its own.
    while (node instanceof Text && at >= node.length) {
      node = node.nextSibling;
      at = 0;
    }
    if (!(node instanceof Text)) return null;
    const r = document.createRange();
    r.setStart(node, at);
    r.setEnd(node, at + 1);
    if (typeof r.getBoundingClientRect !== 'function') return null;
    const b = r.getBoundingClientRect();
    return b.width === 0 && b.height === 0 ? null : b;
  }

  /** The caret is inside the editor's visible box (its padding box, past any scroll) and inside the bounds. */
  function inView(at: DOMRect, b: { left: number; top: number; right: number; bottom: number }, k: number): boolean {
    // An editor with no box (not laid out): nothing to tell.
    if (editor.clientHeight === 0 || editor.clientWidth === 0) return true;
    const e = editor.getBoundingClientRect();
    const eTop = e.top + editor.clientTop * k;
    const eLeft = e.left + editor.clientLeft * k;
    const top = Math.max(b.top, eTop);
    const left = Math.max(b.left, eLeft);
    const bottom = Math.min(b.bottom, eTop + editor.clientHeight * k);
    const right = Math.min(b.right, eLeft + editor.clientWidth * k);
    return at.top >= top - 1 && at.bottom <= bottom + 1 && at.left >= left - 1 && at.left <= right + 1;
  }

  /** The editor scrolled or the window resized: placed again, or closed when the caret is out of view. */
  const follow = (): void => place(false);

  /**
   * Under the caret (above it when there is no room below), inside the bounds, against the composer's box. `soon`: the
   * caret may not be revealed yet (text typed, the caret moved, rows drawn): out of view, it is looked at again next frame.
   */
  function place(soon: boolean): void {
    if (!s || !pop || pop.hidden) return;
    const sel = host.selection();
    const at = liveCaret() ?? caretBox(sel ? sel.focus : s.token.end);
    const from = triggerBox(s.token.start) ?? caretBox(s.token.start);
    if (!at) return;
    const hostBox = element.getBoundingClientRect();
    // A host drawn scaled (a CSS transform): boxes are in screen pixels, `left`/`top` in the composer's own.
    const k = element.offsetWidth > 0 && hostBox.width > 0 ? hostBox.width / element.offsetWidth : 1;
    const bEl = o.bounds?.() ?? element.closest('dialog');
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const bb = bEl?.getBoundingClientRect();
    const b = { left: Math.max(0, bb?.left ?? 0), top: Math.max(0, bb?.top ?? 0), right: Math.min(vw, bb?.right ?? vw), bottom: Math.min(vh, bb?.bottom ?? vh) };
    if (!inView(at, b, k)) {
      if (!soon) return close();
      cancelFrame(recheck);
      recheck = frame(follow);
      return;
    }
    pop.style.maxHeight = '';
    pop.style.maxWidth = `${Math.max(0, b.right - b.left - 2 * PAD) / k}px`;
    const w = pop.offsetWidth * k;
    let ht = pop.offsetHeight * k;
    const below = b.bottom - PAD - (at.bottom + GAP);
    const above = at.top - GAP - (b.top + PAD);
    const side = ht <= below || below >= above ? 'below' : 'above';
    const room = Math.max(0, side === 'below' ? below : above);
    if (ht > room) {
      pop.style.maxHeight = `${room / k}px`;
      ht = room;
    }
    const top = side === 'below' ? at.bottom + GAP : at.top - GAP - ht;
    // Lined up with the trigger when it is on the caret's line, else with the caret.
    const x = from && from.top < at.bottom - 1 && from.bottom > at.top + 1 ? from.left : at.left;
    const left = Math.max(b.left + PAD, Math.min(x, b.right - PAD - w));
    pop.style.left = `${(left - hostBox.left) / k}px`;
    pop.style.top = `${(top - hostBox.top) / k}px`;
    pop.dataset.side = side;
  }

  // ---- acting ----------------------------------------------------------------------------

  function pick(i: number): void {
    const cur = s;
    if (!cur || cur.state !== 'ready' || i < 0 || i >= cur.items.length) return;
    const draft = host.draft();
    const spec = cur.source.insert(cur.items[i], cur.token, draft.doc.text);
    const [a, b, text] = replaceRangeOf(spec, cur.token, draft.doc.text.length);
    close();
    if (spec.chip) draft.insertParts(a, b, [spec.chip, text]);
    else draft.replace(a, b, text);
  }

  function move(by: number): void {
    if (!s) return;
    const n = s.items.length;
    s.active = (s.active + by + n) % n;
    paintActive();
  }

  function key(e: KeyboardEvent): boolean {
    if (!s || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false;
    // The rows of an older query, kept while the current one loads, are not there to move to or pick.
    const rows = s.state === 'ready' && s.items.length > 0;
    const can = rows && s.active >= 0 && s.active < s.items.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!rows) return false;
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1);
      return true;
    }
    if (e.key === 'Tab') {
      if (!can) return false;
      e.preventDefault();
      pick(s.active);
      return true;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (can) pick(s.active);
      else close();
      return true;
    }
    if (e.key === 'Escape') {
      // Only the popup: not the dialog (its cancel is this key's default action), not the transcript or the seat.
      e.preventDefault();
      e.stopPropagation();
      close();
      return true;
    }
    return false;
  }

  function close(): void {
    if (!s) return;
    s.ac?.abort();
    s = null;
    window.removeEventListener('resize', follow);
    editor.removeEventListener('scroll', follow);
    cancelFrame(recheck);
    for (const a of ['aria-autocomplete', 'aria-controls', 'aria-expanded', 'aria-activedescendant']) editor.removeAttribute(a);
    if (pop && list && status && note) {
      pop.hidden = true;
      list.replaceChildren();
      status.textContent = '';
      note.textContent = '';
    }
    said = '';
  }

  return {
    get isOpen() {
      return s !== null;
    },
    typed: () => evaluate(true),
    update: () => evaluate(false),
    key,
    close,
    dispose() {
      close();
      for (const u of unsubs) u?.();
      pop?.remove();
      element.classList.remove('cmp--complete');
      pop = list = status = note = null;
    },
  };
}
