/**
 * The shared prompt composer: a `contenteditable` with plain text and atomic chips (images; #141 files of the worker's
 * checkout, from the `@` popup), for every place a prompt is typed (the hire dialog's first task; later the P overlay
 * and the start-run instructions).
 *
 * The document lives in a `Draft` (`draft.ts`), not in the DOM: the DOM is drawn from it, and read back on `input`
 * (typing, an IME commit, a native delete), so the browser edits text natively while everything the browser cannot
 * be trusted with goes through the model: chips, paste, drop, Enter, delete next to a chip, undo/redo. One history
 * (the draft's) covers text and chips; the browser's own undo is never used. Rich text never gets in: paste is
 * `text/plain`, image files or (#141) the composer's own copy (`CLIP_TYPE`: text and file chips, so a copied file chip
 * pastes back as a chip), drop is image files, and anything else the browser puts in is read as text and the editor is
 * drawn again in its canonical shape (`tree.ts`). A copy or cut writes `text/plain` too: the text with each file chip
 * as its `@path` mention (images left out).
 *
 * The host owns what happens with the prompt (`onSubmit` is only a request), the draft object (keep it to keep
 * text, images and paths across a closed dialog) and the layout: the editor is a flex child that fills its parent
 * (`min-height: 0`, internal scroll), sized by the host's CSS.
 */

import './composer.css';
import { postUpload } from '../../net/upload';
import { h, ICON, icon } from '../dom';
import { mountCompletion, type CompleteOptions, type Completion } from './completion';
import { filesOf } from './field';
import { Draft, type AddResult, type DraftEvent, type DraftOptions, type DraftSnapshot, type ResolveResult, type Uploader } from './draft';
import { openPreview, type Preview } from './lightbox';
import { caret, chipAt, type FileOccurrence, fromSaved, IMG, imagesOf, isFileOcc, mentionText, type Occurrence, rangeOf, readSavedParts, savedParts, type Selection, ZWSP } from './model';
import { CHIP, isCanonical, offsetToPoint, pointToOffset, readDoc, TAIL } from './tree';

export interface ComposerOptions {
  /** The draft to show; else the composer makes one (the host then keeps it with `getDraft()`). */
  draft?: Draft;
  /** For a draft the composer makes: uploads go beside this bridge WebSocket URL. */
  wsUrl?: string;
  /** For a draft the composer makes, instead of `wsUrl`. */
  upload?: Uploader;
  label?: DraftOptions['label'];
  maxPromptBytes?: number;
  maxImages?: number;
  /** The accessible name of the editor (or `labelledBy`). */
  ariaLabel?: string;
  labelledBy?: string;
  describedBy?: string;
  placeholder?: string;
  /** `enter`: Enter sends, Shift+Enter adds a line. `mod-enter`: Ctrl/⌘+Enter sends, Enter adds a line. */
  submitPolicy?: 'enter' | 'mod-enter';
  /** The user asked to send. Only a request: the host decides (and calls `resolve()`). */
  onSubmit?: () => void;
  /** The document or an image's state changed. */
  onChange?: (snapshot: DraftSnapshot) => void;
  /** A message for the user, also shown under the editor. */
  onNotice?: (message: string, kind: 'error' | 'info') => void;
  /**
   * #139: a completion popup for `/` and `@` tokens (`completion.ts`), fed by these sources. Opt-in: without it the
   * composer, its keys and its DOM are as they were.
   */
  complete?: CompleteOptions;
}

export interface Composer {
  /** The whole component: mount this. */
  readonly element: HTMLElement;
  /** The editable root (for a host that needs its size or focus). */
  readonly editor: HTMLElement;
  getDraft(): Draft;
  /** Shows another draft (a desk's, a worker's): the editor is drawn from it, its uploads go on where they are. */
  setDraft(d: Draft): void;
  getSnapshot(): DraftSnapshot;
  /** The final text with the image markers, once every image is uploaded; see `Draft.resolve`. */
  resolve(o?: { maxBytes?: number; hint?: boolean }): Promise<ResolveResult>;
  retry(resourceId: string): boolean;
  insertFiles(files: readonly File[]): AddResult;
  insertText(text: string): void;
  focus(): void;
  /** Read-only while the host is sending: no typing, no chip removal. Previews still open. */
  setBusy(busy: boolean): void;
  /** Read-only and out of reach because the field cannot take a prompt now (#64: a blocked worker): the draft stays. */
  setDisabled(disabled: boolean): void;
  setPlaceholder(text: string): void;
  clearNotice(): void;
  /** Scrolls the held refusal (if any) into view: a host that refuses a send because of it shows where it is. */
  revealRefusal(): void;
  openPreview(occ: string): void;
  closePreview(): void;
  readonly previewOpen: boolean;
  notice(message: string, kind?: 'error' | 'info'): void;
  /** Removes the view and its listeners. The draft is not touched: the host clears or disposes it. */
  dispose(): void;
}

const STATE_TEXT = { pending: 'Waiting…', uploading: 'Uploading…', ready: 'Uploaded', error: 'Failed' } as const;

/** #141: the clipboard type of a copy out of the composer: `{ v: 1, parts: SavedPart[] }` (text and file chips). */
export const CLIP_TYPE = 'application/x-h3d-composer+json';

/** A file chip's words for a screen reader and its announcements: "File src/a.ts", "Folder src". */
export const fileWord = (f: { path: string; dir: boolean }): string => `${f.dir ? 'Folder' : 'File'} ${f.path}`;
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1) || path;

let uid = 0;

export function mountComposer(o: ComposerOptions = {}): Composer {
  const id = `cmp${++uid}`;
  let draft = o.draft ?? makeDraft(o);
  let unsub: () => void = () => {};
  let composing = false;
  /** Read-only, for either reason (the host is sending, or the field is off). */
  let busy = false;
  let hostBusy = false;
  let hostOff = false;
  let refocus = false;
  /** The host asked for focus while the editor was read-only: it gets it when the editor is writable again. */
  let wantFocus = false;
  let dead = false;
  let preview: Preview | null = null;
  const policy = o.submitPolicy ?? 'enter';
  /** The chips already drawn, by occurrence, so a redraw keeps their images loaded. */
  const chips = new Map<string, HTMLElement>();

  const editor = h('div', {
    class: 'cmp-editor',
    id: `${id}-editor`,
    contenteditable: 'true',
    role: 'textbox',
    'aria-multiline': 'true',
    'aria-label': o.labelledBy ? null : (o.ariaLabel ?? 'Prompt'),
    'aria-labelledby': o.labelledBy,
    'aria-describedby': o.describedBy,
    'data-placeholder': o.placeholder ?? '',
    'data-empty': 'true',
    spellcheck: 'true',
  });
  const notice = h('p', { class: 'cmp-notice', role: 'status', 'aria-live': 'polite', hidden: true });
  const live = h('span', { class: 'cmp-sr', role: 'status', 'aria-live': 'polite' });
  // A draft that holds refusals (`holdRefused`, #64): the refused file stays said, with its dismiss, until the user acts.
  const refusalText = h('span', { class: 'cmp-refusal-text' });
  const dismiss = h('button', { class: 'cmp-dismiss', type: 'button', title: 'Dismiss: send without the refused file' }, icon(ICON.close));
  // Announced by `live` when it appears (polite), not a `role=alert` of its own: a hidden alert would be the first one
  // anything looking for the dialog's alert finds.
  const refusal = h('p', { class: 'cmp-refusal', hidden: true }, refusalText, dismiss);
  const element = h('div', { class: 'cmp' }, editor, notice, refusal, live);
  const completion: Completion | null = o.complete
    ? mountCompletion(
        {
          id,
          editor,
          element,
          draft: () => draft,
          selection: () => (focusInEditor() ? readSelection() : null),
          blocked: () => dead || busy || composing,
          announce: (text) => (live.textContent = text),
        },
        o.complete,
      )
    : null;

  // ---- notices -------------------------------------------------------------------------

  function say(message: string, kind: 'error' | 'info' = 'info'): void {
    if (kind === 'error') {
      notice.textContent = message;
      notice.hidden = false;
      notice.dataset.kind = 'error';
    } else live.textContent = message;
    o.onNotice?.(message, kind);
  }
  const clearNotice = (): void => {
    if (!notice.hidden) {
      notice.hidden = true;
      notice.textContent = '';
    }
  };
  /** The draft's held refusal, drawn (it is the draft's, so it comes back with the draft when a worker's note reopens). */
  function paintRefusal(): void {
    const why = draft.refusal;
    refusal.hidden = why === null;
    refusalText.textContent = why === null ? '' : `Not attached: ${why} Nothing is sent until you dismiss this.`;
    dismiss.setAttribute('aria-label', 'Dismiss this message and send without the refused file');
    dismiss.disabled = busy;
  }

  // ---- drawing -------------------------------------------------------------------------

  const imageWord = (n: number, name: string): string => `image ${n}, ${name}`;

  /**
   * #141: a file chip: the icon and the basename, the whole path in its tooltip and its accessible name. Nothing in it
   * acts: a click puts nothing in motion, Backspace and Delete take it whole, the arrows step over it.
   */
  function makeFileChip(occ: FileOccurrence): HTMLElement {
    const el = h(
      'span',
      { class: `${CHIP} cmp-file`, contenteditable: 'false', draggable: 'false', 'data-occ': occ.occ, 'data-kind': occ.dir ? 'dir' : 'file', role: 'img', 'aria-label': fileWord(occ), title: occ.path },
      icon(occ.dir ? ICON.folder : ICON.file),
      h('span', { class: 'cmp-file-name', 'aria-hidden': 'true' }, baseName(occ.path)),
    );
    chips.set(occ.occ, el);
    return el;
  }

  function makeChip(occ: Occurrence): HTMLElement {
    if (isFileOcc(occ)) return makeFileChip(occ);
    const thumb = h('button', { class: 'cmp-thumb', tabindex: '0' }, h('img', { alt: '', draggable: 'false' }));
    const badge = h('span', { class: 'cmp-num', 'aria-hidden': 'true' });
    const name = h('span', { class: 'cmp-name' });
    const state = h('span', { class: 'cmp-state' });
    const retry = h('button', { class: 'cmp-retry' }, icon(ICON.refresh), 'Retry');
    const remove = h('button', { class: 'cmp-remove' }, icon(ICON.close));
    const bar = h('span', { class: 'cmp-bar', 'aria-hidden': 'true' });
    const el = h(
      'span',
      { class: CHIP, contenteditable: 'false', draggable: 'false', 'data-occ': occ.occ, 'data-res': occ.res, role: 'group' },
      h('span', { class: 'cmp-thumb-wrap' }, thumb, badge),
      h('span', { class: 'cmp-text' }, name, state),
      retry,
      remove,
      bar,
    );
    chips.set(occ.occ, el);
    return el;
  }

  /** Brings a chip's number, name, state and buttons up to date with the draft. */
  function paintChip(el: HTMLElement): void {
    if (el.classList.contains('cmp-file')) return; // a file chip has no state to show
    const occ = el.dataset.occ ?? '';
    const r = draft.resource(el.dataset.res ?? '');
    const n = draft.numberOf(occ);
    const name = r?.name ?? 'image';
    const status = r?.status ?? 'error';
    el.dataset.status = status;
    el.setAttribute('aria-label', `${imageWord(n, name)}, ${STATE_TEXT[status].toLowerCase().replace('…', '')}`);
    el.querySelector('.cmp-num')!.textContent = `#${n}`;
    const nameEl = el.querySelector<HTMLElement>('.cmp-name')!;
    nameEl.textContent = name;
    nameEl.title = name;
    const stateEl = el.querySelector<HTMLElement>('.cmp-state')!;
    stateEl.textContent = status === 'error' ? `Failed: ${r?.error ?? 'upload failed'}` : STATE_TEXT[status];
    stateEl.title = status === 'error' ? (r?.error ?? '') : '';
    const thumb = el.querySelector<HTMLButtonElement>('.cmp-thumb')!;
    thumb.setAttribute('aria-label', `Preview ${imageWord(n, name)}`);
    thumb.setAttribute('aria-haspopup', 'dialog');
    const img = thumb.querySelector('img')!;
    if (r?.url && img.getAttribute('src') !== r.url) img.setAttribute('src', r.url);
    const retry = el.querySelector<HTMLButtonElement>('.cmp-retry')!;
    retry.hidden = status !== 'error';
    retry.setAttribute('aria-label', `Retry uploading ${imageWord(n, name)}`);
    retry.disabled = busy;
    const remove = el.querySelector<HTMLButtonElement>('.cmp-remove')!;
    remove.setAttribute('aria-label', `Remove ${imageWord(n, name)}`);
    remove.disabled = busy;
  }

  function paintAll(): void {
    for (const el of editor.querySelectorAll<HTMLElement>(`.${CHIP}`)) paintChip(el);
    const d = draft.doc;
    editor.dataset.empty = String(d.text === '');
    paintRefusal();
  }

  /** Draws the editor from the draft: a text node for every text run, the chips between, the tail line. */
  function render(): void {
    const d = draft.doc;
    const top = editor.scrollTop;
    const parts = d.text.split(IMG);
    const nodes: Node[] = [];
    const live = new Set<string>();
    parts.forEach((t, i) => {
      nodes.push(document.createTextNode(t === '' ? ZWSP : t));
      const occ = d.chips[i];
      if (occ && i < parts.length - 1) {
        live.add(occ.occ);
        nodes.push(chips.get(occ.occ) ?? makeChip(occ));
      }
    });
    for (const k of [...chips.keys()]) if (!live.has(k)) chips.delete(k);
    nodes.push(h('br', { class: TAIL }));
    editor.replaceChildren(...nodes);
    editor.scrollTop = top;
    paintAll();
  }

  // ---- selection -----------------------------------------------------------------------

  const focusInEditor = (): boolean => document.activeElement === editor;

  /** The DOM selection as offsets, or null when it is not in the editor. */
  function readSelection(): Selection | null {
    const s = document.getSelection();
    if (!s || s.rangeCount === 0 || !s.anchorNode || !s.focusNode) return null;
    if (!editor.contains(s.anchorNode) || !editor.contains(s.focusNode)) return null;
    return { anchor: pointToOffset(editor, s.anchorNode, s.anchorOffset), focus: pointToOffset(editor, s.focusNode, s.focusOffset) };
  }

  /** Puts the DOM selection where the offsets say, keeping the direction of a backward selection. */
  function writeSelection(sel: Selection): void {
    const s = document.getSelection();
    if (!s) return;
    const a = offsetToPoint(editor, sel.anchor);
    const f = sel.anchor === sel.focus ? a : offsetToPoint(editor, sel.focus);
    s.setBaseAndExtent(a.node, a.offset, f.node, f.offset);
  }

  /** Where an edit goes: the live selection while typing, else the last one the draft remembers. */
  function where(): Selection {
    return (focusInEditor() ? readSelection() : null) ?? draft.selection;
  }

  // ---- reading back --------------------------------------------------------------------

  function known(): Map<string, Occurrence> {
    return new Map(draft.doc.chips.map((c) => [c.occ, c]));
  }

  /** The browser edited the DOM: take the document out of it. */
  function reconcile(): void {
    const sel = readSelection() ?? draft.selection;
    const { doc, foreign } = readDoc(editor, known());
    draft.fromEditor(doc, sel);
    const changedShape = foreign || !isCanonical(editor);
    if (changedShape) {
      render();
      if (focusInEditor()) writeSelection(draft.selection);
    } else {
      paintAll();
    }
  }

  // ---- draft events --------------------------------------------------------------------

  function onDraft(e: DraftEvent): void {
    if (dead) return;
    if (e.kind === 'refusal') {
      paintRefusal();
    } else if (e.kind === 'resource') {
      const mine = [...editor.querySelectorAll<HTMLElement>(`.${CHIP}`)].filter((c) => c.dataset.res === e.id);
      for (const c of mine) paintChip(c);
      const el = mine[0];
      const r = draft.resource(e.id);
      if (el && r?.status === 'error') {
        const n = draft.numberOf(el.dataset.occ ?? '');
        say(`Image ${n} (${r.name}) failed to upload: ${r.error ?? 'unknown error'}. Retry it or remove it.`, 'error');
      }
    } else if (e.origin !== 'dom') {
      render();
      if (focusInEditor()) writeSelection(draft.selection);
      completion?.update();
    }
    o.onChange?.(draft.snapshot());
  }

  function attach(d: Draft): void {
    completion?.close();
    unsub();
    draft = d;
    unsub = d.subscribe(onDraft);
    closePreview();
    render();
    clearNotice();
    paintRefusal();
  }

  // ---- edits ---------------------------------------------------------------------------

  function insertText(text: string): void {
    const [a, b] = rangeOf(where());
    draft.replace(a, b, text);
  }

  function insertFiles(files: readonly File[], at?: number): AddResult {
    const r = draft.addImages(files, at === undefined ? rangeOf(where()) : [at, at]);
    if (r.errors.length > 0 && draft.refusal !== null) {
      // Held by the draft: the refusal line says it (and stays); the notice would say it twice.
      clearNotice();
      live.textContent = r.errors.join(' ');
      o.onNotice?.(r.errors.join(' '), 'error');
    } else if (r.errors.length > 0) say(r.errors.join(' '), 'error');
    else clearNotice();
    if (r.added > 0) {
      say(`${r.added === 1 ? 'Image' : `${r.added} images`} added. ${imagesOf(draft.doc).length} in the prompt.`);
    }
    return r;
  }

  function removeAt(occ: string): void {
    if (busy) return;
    const chip = draft.doc.chips.find((c) => c.occ === occ);
    if (!chip) return;
    const n = draft.numberOf(occ);
    draft.removeChip(occ);
    clearNotice();
    say(isFileOcc(chip) ? `${fileWord(chip)} removed.` : `Image ${n} removed.`);
    focusEditor();
  }

  function focusEditor(): void {
    if (dead) return;
    if (busy) {
      wantFocus = true;
      return;
    }
    wantFocus = false;
    editor.focus({ preventScroll: true });
    writeSelection(draft.selection);
  }

  // ---- preview -------------------------------------------------------------------------

  function openPreviewOf(occ: string): void {
    if (preview?.isOpen) return;
    const im = draft.snapshot().images.find((i) => i.occ === occ);
    if (!im) return;
    // The bookmark is the draft's own record of the caret and the editor's scroll: the click that opens the
    // preview does not move either (mousedown on a chip is not allowed to), and nothing can change them while it is
    // open.
    const focused = focusInEditor();
    // The live selection when the editor has focus: the draft's copy of it trails the browser's by an event.
    const live = focused ? readSelection() : null;
    if (live) draft.setSelection(live);
    const bookmark = { sel: draft.selection, top: editor.scrollTop, focused };
    const unpin = draft.pin(im.res);
    const restore = (): void => {
      if (dead) return;
      const put = (): void => {
        editor.scrollTop = bookmark.top;
        if (bookmark.focused && !busy) {
          editor.focus({ preventScroll: true });
          writeSelection(draft.selection);
        }
      };
      draft.setSelection(bookmark.sel);
      put();
      // The browser puts focus back on what had it when the dialog closes, in the same task: once more after it.
      requestAnimationFrame(() => {
        if (dead) return;
        const cur = readSelection();
        const want = draft.selection;
        if (bookmark.focused && (!cur || cur.anchor !== want.anchor || cur.focus !== want.focus || !focusInEditor())) put();
      });
    };
    preview = openPreview(element, { url: im.url, name: im.name, label: `Image ${im.n}` }, unpin, () => {
      preview = null;
      restore();
    });
  }

  function closePreview(): void {
    preview?.close();
  }

  // ---- input handlers ------------------------------------------------------------------

  const isSubmit = (e: KeyboardEvent): boolean => {
    const mod = e.ctrlKey || e.metaKey;
    // Enter policy: Ctrl/⌘+Enter sends too (the hire dialog's textarea always did).
    return policy === 'enter' ? !e.shiftKey && !e.altKey : mod;
  };

  /** Arrow keys beside a chip step over it in one press; everywhere else the browser moves the caret. */
  function arrow(e: KeyboardEvent): boolean {
    if (e.altKey || e.ctrlKey || e.metaKey) return false;
    const sel = readSelection();
    if (!sel) return false;
    const dir = e.key === 'ArrowLeft' ? -1 : 1;
    if (!e.shiftKey && sel.anchor !== sel.focus) return false;
    const next = draft.doc.text[dir < 0 ? sel.focus - 1 : sel.focus];
    if (next !== IMG) return false;
    const focus = sel.focus + dir;
    const to = e.shiftKey ? { anchor: sel.anchor, focus } : caret(focus);
    draft.setSelection(to);
    writeSelection(to);
    return true;
  }

  editor.addEventListener('keydown', (e) => {
    if (e.target !== editor) return; // a chip's own buttons: Enter and Space are theirs
    if (composing || e.isComposing || e.keyCode === 229) return;
    if (busy) {
      if (e.key === 'Enter') e.preventDefault();
      return;
    }
    // #139: while the completion popup is open, its keys (arrows, Tab, Enter, Esc) are its own.
    if (completion?.key(e)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (isSubmit(e)) o.onSubmit?.();
      else insertText('\n');
    } else if (mod && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) draft.redo();
      else draft.undo();
    } else if (mod && !e.altKey && !e.shiftKey && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      draft.redo();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (arrow(e)) e.preventDefault();
    }
  });

  editor.addEventListener('beforeinput', (e) => {
    if (busy) {
      e.preventDefault();
      return;
    }
    const t = e.inputType;
    if (t === 'historyUndo' || t === 'historyRedo') {
      e.preventDefault();
      if (t === 'historyUndo') draft.undo();
      else draft.redo();
      return;
    }
    if (composing || e.isComposing) return;
    if (t === 'insertParagraph' || t === 'insertLineBreak') {
      e.preventDefault();
      insertText('\n');
    } else if (t === 'insertFromDrop' || t === 'insertFromPaste' || t === 'insertFromYank') {
      // Our own drop and paste handlers took these; anything that still gets here would bring markup.
      e.preventDefault();
    } else if (t === 'deleteContentBackward' || t === 'deleteContentForward') {
      const sel = readSelection();
      if (!sel || sel.anchor !== sel.focus) return;
      const at = t === 'deleteContentBackward' ? sel.focus - 1 : sel.focus;
      const occ = chipAt(draft.doc, at);
      if (!occ) return;
      e.preventDefault();
      removeAt(occ.occ);
    }
  });

  editor.addEventListener('input', () => {
    if (composing) return;
    reconcile();
    completion?.typed();
  });
  editor.addEventListener('compositionstart', () => {
    composing = true;
    completion?.close();
  });
  editor.addEventListener('compositionend', () => {
    composing = false;
    reconcile();
    completion?.typed();
  });
  if (completion) editor.addEventListener('blur', () => completion.close());

  editor.addEventListener('paste', (e) => {
    const dt = e.clipboardData;
    if (!dt) return;
    e.preventDefault();
    if (busy) return;
    // #141: our own copy first: its file chips come back as chips (one edit, one undo step).
    const own = ownClip(dt);
    if (own) {
      const [a, b] = rangeOf(where());
      draft.insertParts(a, b, fromSaved(own));
      return;
    }
    const files = filesOf(dt);
    if (files.length > 0) {
      insertFiles(files);
      return;
    }
    const text = dt.getData('text/plain');
    if (text) insertText(text);
  });

  /** The composer's own clipboard data, read as untrusted (another page can put anything under any type), or null. */
  function ownClip(dt: DataTransfer): ReturnType<typeof readSavedParts> {
    let raw = '';
    try {
      raw = dt.getData(CLIP_TYPE);
    } catch {
      return null;
    }
    if (!raw) return null;
    try {
      const o = JSON.parse(raw) as { v?: unknown; parts?: unknown } | null;
      const parts = o && o.v === 1 ? readSavedParts(o.parts) : null;
      return parts && parts.length > 0 ? parts : null;
    } catch {
      return null;
    }
  }

  /** A copy of the selection: text with `@path` for each file chip, and (with any file chip in it) our own type. */
  function copyOut(dt: DataTransfer, a: number, b: number): void {
    const parts = savedParts(draft.doc, a, b);
    dt.setData('text/plain', mentionText(draft.doc, a, b));
    if (parts.some((p) => p.kind === 'file')) dt.setData(CLIP_TYPE, JSON.stringify({ v: 1, parts }));
  }

  const selected = (): { a: number; b: number } | null => {
    const sel = readSelection();
    if (!sel || sel.anchor === sel.focus) return null;
    const [a, b] = rangeOf(sel);
    return { a, b };
  };
  editor.addEventListener('copy', (e) => {
    const s = selected();
    if (!s || !e.clipboardData) return;
    e.preventDefault();
    copyOut(e.clipboardData, s.a, s.b);
  });
  editor.addEventListener('cut', (e) => {
    const s = selected();
    if (!s || !e.clipboardData) return;
    e.preventDefault();
    if (busy) return;
    copyOut(e.clipboardData, s.a, s.b);
    draft.replace(s.a, s.b, '');
  });

  const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  editor.addEventListener('dragover', (e) => {
    if (busy || !hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    element.classList.add('cmp--dropping');
  });
  editor.addEventListener('dragleave', (e) => {
    if (!editor.contains(e.relatedTarget as Node | null)) element.classList.remove('cmp--dropping');
  });
  editor.addEventListener('drop', (e) => {
    e.preventDefault();
    element.classList.remove('cmp--dropping');
    if (busy) return;
    const files = filesOf(e.dataTransfer);
    if (files.length === 0) return;
    const at = offsetAtPoint(e.clientX, e.clientY);
    insertFiles(files, at ?? undefined);
    focusEditor();
  });
  // Nothing inside is meant to be dragged out and back in: a chip or a selection dropped again would bring markup.
  editor.addEventListener('dragstart', (e) => e.preventDefault());
  dismiss.addEventListener('click', () => {
    if (busy || !draft.dismissRefusal()) return;
    say('Dismissed. The prompt goes without the refused file.');
    focusEditor();
  });

  function offsetAtPoint(x: number, y: number): number | null {
    const doc = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    let node: Node | null = null;
    let off = 0;
    const p = doc.caretPositionFromPoint?.(x, y);
    if (p) {
      node = p.offsetNode;
      off = p.offset;
    } else {
      const r = doc.caretRangeFromPoint?.(x, y);
      if (r) {
        node = r.startContainer;
        off = r.startOffset;
      }
    }
    if (!node || !editor.contains(node)) return null;
    return pointToOffset(editor, node, off);
  }

  // The chips' buttons. A press on one must not move the caret or take focus from the editor.
  editor.addEventListener('mousedown', (e) => {
    if ((e.target as Element).closest(`.${CHIP} button`)) e.preventDefault();
  });
  editor.addEventListener('click', (e) => {
    const btn = (e.target as Element).closest<HTMLElement>(`.${CHIP} button`);
    const chip = btn?.closest<HTMLElement>(`.${CHIP}`);
    if (!btn || !chip) return;
    const occ = chip.dataset.occ ?? '';
    if (btn.classList.contains('cmp-thumb')) openPreviewOf(occ);
    else if (btn.classList.contains('cmp-remove')) removeAt(occ);
    else if (btn.classList.contains('cmp-retry')) {
      clearNotice();
      draft.retry(chip.dataset.res ?? '');
      focusEditor();
    }
  });

  /** The caret is kept in the draft while the editor has focus, for a preview or a closed dialog to give back. */
  const onSelectionChange = (): void => {
    if (composing || dead || !focusInEditor()) return;
    const sel = readSelection();
    if (sel) draft.setSelection(sel);
    completion?.update();
  };
  document.addEventListener('selectionchange', onSelectionChange);

  /** Read-only while the host is sending or the field is off. */
  function lock(): void {
    const b = hostBusy || hostOff;
    const changed = b !== busy;
    // Making the editor read-only takes focus from it: give it back when the host is done, if nothing else took it.
    if (changed && b) refocus = focusInEditor();
    busy = b;
    if (b) completion?.close();
    editor.setAttribute('contenteditable', String(!b));
    editor.setAttribute('aria-busy', String(hostBusy));
    if (hostOff) editor.setAttribute('aria-disabled', 'true');
    else editor.removeAttribute('aria-disabled');
    element.classList.toggle('cmp--busy', hostBusy);
    element.classList.toggle('cmp--off', hostOff);
    paintAll();
    if (changed && !b) {
      const back = refocus && (!document.activeElement || document.activeElement === document.body);
      refocus = false;
      if (wantFocus || back) focusEditor();
    }
  }

  // ---- lifecycle -----------------------------------------------------------------------

  attach(draft);

  return {
    element,
    editor,
    getDraft: () => draft,
    setDraft: attach,
    getSnapshot: () => draft.snapshot(),
    resolve: (r) => draft.resolve(r),
    retry: (rid) => draft.retry(rid),
    insertFiles: (files) => insertFiles(files),
    insertText,
    focus: focusEditor,
    setBusy(b) {
      if (b === hostBusy) return;
      hostBusy = b;
      lock();
    },
    setDisabled(d) {
      if (d === hostOff) return;
      hostOff = d;
      lock();
    },
    setPlaceholder(text) {
      editor.dataset.placeholder = text;
    },
    clearNotice,
    revealRefusal() {
      if (!refusal.hidden) refusal.scrollIntoView?.({ block: 'nearest' });
    },
    openPreview: openPreviewOf,
    closePreview,
    get previewOpen() {
      return preview?.isOpen ?? false;
    },
    notice: say,
    dispose() {
      if (dead) return;
      closePreview();
      completion?.dispose();
      dead = true;
      unsub();
      document.removeEventListener('selectionchange', onSelectionChange);
      element.remove();
    },
  };

  function makeDraft(c: ComposerOptions): Draft {
    const upload: Uploader | undefined = c.upload ?? (c.wsUrl ? (file, hint, signal) => postUpload(c.wsUrl as string, file, hint, signal) : undefined);
    if (!upload) throw new Error('mountComposer: give it a draft, an upload function or a wsUrl');
    return new Draft({
      upload,
      ...(c.label !== undefined ? { label: c.label } : {}),
      ...(c.maxPromptBytes !== undefined ? { maxPromptBytes: c.maxPromptBytes } : {}),
      ...(c.maxImages !== undefined ? { maxImages: c.maxImages } : {}),
    });
  }
}
