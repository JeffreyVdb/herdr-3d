/**
 * A prompt draft: the document (`model.ts`), the images it uses with their upload state, one undo history, and the
 * upload queue. It has no DOM and outlives the editor that shows it: the host keeps the draft object while its dialog
 * is closed, so text, caret, images (their bytes, and the paths of the ones already uploaded) and history come back
 * when the dialog reopens. Uploads go on in the background while it is closed.
 *
 * Resources, by identity, not by name or size (two screenshots can share both): each has a state
 *   pending → uploading → ready(path) | error(message)         error → pending on retry
 * and an `attempt` that changes whenever an upload is started or cancelled, so an answer that arrives after its
 * image was removed, or after a retry began, is ignored. A resource is uploaded only while it is *wanted*: used by
 * the current document, or by a `resolve()` in flight. Removing a chip cancels its upload; undoing the removal
 * queues it again. A resource is released (upload cancelled, object URL revoked) once no history entry, pin (an open
 * preview) or the document refers to it.
 */

import type { CommandResult } from '../../net/client';
import { type PickedFile, precheckUpload, type UploadedImage } from '../../net/upload';
import {
  caretAfter,
  clampSel,
  type Doc,
  EMPTY_DOC,
  type FileRef,
  HIRE_PROMPT_MAX_BYTES,
  IMG,
  imagesIn,
  imagesOf,
  indexOfOcc,
  isFileOcc,
  isImageOcc,
  MAX_IMAGES,
  moveChip,
  type Occurrence,
  offsetOfChip,
  type Part,
  partsLength,
  plainText,
  rangeOf,
  removeChip,
  replaceParts,
  replaceRange,
  resourcesOf,
  sameChips,
  type Segment,
  type SerializeError,
  serializePrompt,
  type SerializedImage,
  segments,
  splitMarkers,
  cleanText,
  type Selection,
  caret,
} from './model';

export type ResourceStatus = 'pending' | 'uploading' | 'ready' | 'error';

export interface Resource {
  readonly id: string;
  /** 1-based, per draft, in the order images were added: the `n` hint of the upload (never the marker's number). */
  readonly seq: number;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly blob: Blob;
  /** An object URL of `blob` for thumbnails and the preview; '' where the platform has none. */
  readonly url: string;
  status: ResourceStatus;
  path?: string;
  error?: string;
  code?: string;
  attempt: number;
}

export type Uploader = (file: Blob, hint: { label: string; n: number }, signal: AbortSignal) => Promise<CommandResult>;

export interface DraftOptions {
  upload: Uploader;
  /** The hint for the stored file's name (`h3d-<label>-<n>`), e.g. the worker's or the desk's name. */
  label?: string | (() => string);
  /** Uploads at once. */
  concurrency?: number;
  maxImages?: number;
  /** The default cap of `resolve()` in utf-8 bytes. */
  maxPromptBytes?: number;
  /**
   * A file `addImages` refuses (too big, not an image, over the limit) is *held* as the draft's refusal, and the draft
   * does not resolve until the user dismisses it (`dismissRefusal`): the prompt is not sent without the picture the
   * user meant to attach (#64). Off by default: the hire dialog says so in its notice and lets the rest go.
   */
  holdRefused?: boolean;
  historyLimit?: number;
  /** Typing within this many ms of the last typing is one undo step. */
  coalesceMs?: number;
  now?: () => number;
  createUrl?: (b: Blob) => string;
  revokeUrl?: (u: string) => void;
}

export type DraftEvent =
  /** The document or the caret changed: `dom` when the editor's own typing did it (nothing to redraw). */
  | { kind: 'doc'; origin: 'dom' | 'api' | 'history' }
  /** A resource's state changed. */
  | { kind: 'resource'; id: string }
  /** The held refusal appeared or was dismissed. */
  | { kind: 'refusal' };

export interface ImageInfo {
  /** The marker's number, from the document order. */
  n: number;
  occ: string;
  res: string;
  name: string;
  size: number;
  status: ResourceStatus;
  path: string | null;
  error: string | null;
  code: string | null;
  url: string;
}

/** #141: a file chip, for what a host shows or keeps of a draft. */
export interface FileInfo {
  occ: string;
  path: string;
  dir: boolean;
}

/** What `insertParts` and `hydrate` take: text, and file chips by their content (the draft gives them their ids). */
export type DraftPart = string | FileRef;

export interface DraftSnapshot {
  revision: number;
  doc: Doc;
  selection: Selection;
  segments: Segment[];
  /** The text without the chips. */
  text: string;
  images: ImageInfo[];
  /** #141: the file chips, in order. */
  files: FileInfo[];
  /** Any image not uploaded yet (pending or uploading). */
  uploading: boolean;
  /** Any image whose upload failed. */
  failed: boolean;
  /** The held refusal (`holdRefused`): why a file was not attached. The draft does not resolve until it is dismissed. */
  refusal: string | null;
}

export interface FailedImage {
  res: string;
  name: string;
  /** The marker numbers it would have had. */
  numbers: number[];
  message: string;
  code: string;
}

export type ResolveResult =
  | { ok: true; text: string; revision: number; images: SerializedImage[] }
  | { ok: false; reason: 'upload'; revision: number; failed: FailedImage[] }
  | { ok: false; reason: 'serialize'; revision: number; error: SerializeError }
  | { ok: false; reason: 'refused'; revision: number; message: string }
  | { ok: false; reason: 'disposed'; revision: number };

export interface AddResult {
  added: number;
  /** One friendly message per refused file (and one for images over the limit). */
  errors: string[];
}

interface Entry {
  doc: Doc;
  sel: Selection;
}

const EMPTY_SEL = caret(0);

export class Draft {
  private opts: Required<Omit<DraftOptions, 'label'>> & { label: string | (() => string) };
  private cur: Doc = EMPTY_DOC;
  private sel: Selection = EMPTY_SEL;
  private rev = 0;
  private res = new Map<string, Resource>();
  private hist: Entry[] = [{ doc: EMPTY_DOC, sel: EMPTY_SEL }];
  private at = 0;
  private lastTypeAt = -Infinity;
  private inflight = new Map<string, AbortController>();
  /** Resources a `resolve()` waits for: uploaded even if the document no longer uses them. */
  private wants = new Map<string, number>();
  /** Resources something displays (an open preview): kept even if nothing else refers to them. */
  private pins = new Map<string, number>();
  private listeners = new Set<(e: DraftEvent) => void>();
  private seq = 0;
  private ids = 0;
  private dead = false;
  private refused: string | null = null;

  constructor(opts: DraftOptions) {
    this.opts = {
      concurrency: 2,
      maxImages: MAX_IMAGES,
      maxPromptBytes: HIRE_PROMPT_MAX_BYTES,
      historyLimit: 100,
      coalesceMs: 1000,
      now: () => Date.now(),
      createUrl: (b) => {
        try {
          return typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(b) : '';
        } catch {
          return ''; // no object URLs here: the chip has no thumbnail, everything else works
        }
      },
      revokeUrl: (u) => {
        if (u && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(u);
      },
      label: 'hire',
      holdRefused: false,
      ...opts,
    };
  }

  // ---- reading ------------------------------------------------------------------------

  get doc(): Doc {
    return this.cur;
  }
  get selection(): Selection {
    return this.sel;
  }
  /** Changes with every change of the document (not with the caret, nor with upload progress). */
  get revision(): number {
    return this.rev;
  }
  get disposed(): boolean {
    return this.dead;
  }
  get maxImages(): number {
    return this.opts.maxImages;
  }
  get maxPromptBytes(): number {
    return this.opts.maxPromptBytes;
  }
  resource(id: string): Resource | undefined {
    return this.res.get(id);
  }
  get canUndo(): boolean {
    return this.at > 0;
  }
  get canRedo(): boolean {
    return this.at < this.hist.length - 1;
  }
  /** The held refusal (`holdRefused`), or null. */
  get refusal(): string | null {
    return this.refused;
  }
  /** How many resources are held (tests: nothing leaks). */
  get resourceCount(): number {
    return this.res.size;
  }

  /** The place of an image occurrence among the images of the document (1-based), or 0 (a file chip has none). */
  numberOf(occ: string): number {
    return imagesOf(this.cur).findIndex((o) => o.occ === occ) + 1;
  }

  snapshot(): DraftSnapshot {
    const images = imagesOf(this.cur).map((o, i): ImageInfo => {
      const r = this.res.get(o.res);
      return {
        n: i + 1,
        occ: o.occ,
        res: o.res,
        name: r?.name ?? '',
        size: r?.size ?? 0,
        status: r?.status ?? 'error',
        path: r?.path ?? null,
        error: r?.error ?? null,
        code: r?.code ?? null,
        url: r?.url ?? '',
      };
    });
    return {
      revision: this.rev,
      doc: this.cur,
      selection: this.sel,
      segments: segments(this.cur),
      text: plainText(this.cur),
      images,
      files: this.cur.chips.filter(isFileOcc).map((o) => ({ occ: o.occ, path: o.path, dir: o.dir })),
      uploading: images.some((i) => i.status === 'pending' || i.status === 'uploading'),
      failed: images.some((i) => i.status === 'error'),
      refusal: this.refused,
    };
  }

  subscribe(fn: (e: DraftEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: DraftEvent): void {
    for (const fn of [...this.listeners]) fn(e);
  }

  // ---- editing ------------------------------------------------------------------------

  /** The caret moved (no event, no history: it is remembered so a preview or a closed dialog can give it back). */
  setSelection(s: Selection): void {
    this.sel = clampSel(s, this.cur);
  }

  /**
   * The editor read a new document out of its own DOM (typing, an IME commit, a native delete): one undo step, or
   * part of the previous step while the user keeps typing.
   */
  fromEditor(doc: Doc, sel: Selection): boolean {
    return this.apply(doc, sel, 'dom', true);
  }

  /** Replaces `[start, end)` with `text` and puts the caret after it; one undo step. */
  replace(start: number, end: number, text: string): void {
    const [a, b] = start <= end ? [start, end] : [end, start];
    this.apply(replaceRange(this.cur, a, b, text), caret(caretAfter(a, b, text, [])), 'api', false);
  }

  /**
   * #141: replaces `[start, end)` with text and file chips in their order (a picked file and the space after it, a
   * paste) and puts the caret after them; one undo step. Each file chip is a new occurrence.
   */
  insertParts(start: number, end: number, parts: readonly DraftPart[]): void {
    const [a, b] = start <= end ? [start, end] : [end, start];
    const mine = this.own(parts);
    this.apply(replaceParts(this.cur, a, b, mine), caret(a + partsLength(mine)), 'api', false);
  }

  private own(parts: readonly DraftPart[]): Part[] {
    return parts.map((p) => (typeof p === 'string' ? p : { kind: 'file', occ: `o${++this.ids}`, path: p.path, dir: p.dir }));
  }

  /**
   * #141: makes `parts` the whole document with no undo history behind it (a draft kept from an earlier visit coming
   * back), the caret at the end. False (and no event) when the document is already that.
   */
  hydrate(parts: readonly DraftPart[]): boolean {
    const doc = replaceParts(EMPTY_DOC, 0, 0, this.own(parts));
    if (doc.text === this.cur.text && contentOf(doc) === contentOf(this.cur)) return false;
    this.reset(doc, caret(doc.text.length));
    return true;
  }

  /**
   * Puts image files into the document at `range` (default: the caret), replacing what was selected there, as one
   * step, in the files' order. Every file that cannot go is refused with a message; the rest go.
   */
  addImages(files: readonly File[], range?: readonly [number, number]): AddResult {
    const [start, end] = range ?? rangeOf(this.sel);
    const errors: string[] = [];
    const room = this.opts.maxImages - (imagesIn(this.cur) - imagesIn(this.cur, Math.min(start, end), Math.max(start, end)));
    const accepted: File[] = [];
    let overflow = false;
    for (const f of files) {
      const why = precheckUpload(f as PickedFile);
      if (why) errors.push(why);
      else if (accepted.length >= room) overflow = true;
      else accepted.push(f);
    }
    if (overflow) errors.push(`You can attach up to ${this.opts.maxImages} images to one prompt.`);
    if (this.opts.holdRefused && errors.length > 0) {
      this.refused = [...new Set([...(this.refused ? [this.refused] : []), errors.join(' ')])].join(' ');
      this.emit({ kind: 'refusal' });
    }
    if (accepted.length === 0) return { added: 0, errors };
    const occs: Occurrence[] = accepted.map((f) => ({ occ: `o${++this.ids}`, res: this.addResource(f).id }));
    const [a, b] = start <= end ? [start, end] : [end, start];
    this.apply(replaceRange(this.cur, a, b, '', occs), caret(caretAfter(a, b, '', occs)), 'api', false);
    return { added: accepted.length, errors };
  }

  /** The user dismissed the held refusal: the prompt goes without the refused file(s). False when none was held. */
  dismissRefusal(): boolean {
    if (this.refused === null) return false;
    this.refused = null;
    this.emit({ kind: 'refusal' });
    return true;
  }

  private addResource(f: File): Resource {
    const id = `r${++this.ids}`;
    const r: Resource = {
      id,
      seq: ++this.seq,
      name: f.name || 'pasted image',
      mime: f.type,
      size: f.size,
      blob: f,
      url: this.opts.createUrl(f),
      status: 'pending',
      attempt: 0,
    };
    this.res.set(id, r);
    return r;
  }

  /** Removes one chip (an image or a file), the caret where it was; one undo step. */
  removeChip(occ: string): void {
    const i = indexOfOcc(this.cur, occ);
    if (i < 0) return;
    const at = offsetOfChip(this.cur, i);
    this.apply(removeChip(this.cur, i), caret(at), 'api', false);
  }

  /** Moves a chip to another place in the text (a reorder along with the text). */
  moveChip(occ: string, to: number): void {
    const i = indexOfOcc(this.cur, occ);
    if (i < 0) return;
    const next = moveChip(this.cur, i, to);
    if (next === this.cur) return;
    this.apply(next, caret(Math.max(0, Math.min(next.text.length, to))), 'api', false);
  }

  undo(): boolean {
    if (this.at === 0) return false;
    this.restore(this.at - 1);
    return true;
  }
  redo(): boolean {
    if (this.at >= this.hist.length - 1) return false;
    this.restore(this.at + 1);
    return true;
  }

  private restore(i: number): void {
    this.at = i;
    const e = this.hist[i] as Entry;
    this.cur = e.doc;
    this.sel = clampSel(e.sel, e.doc);
    this.rev++;
    this.lastTypeAt = -Infinity;
    this.afterChange('history');
  }

  private apply(doc: Doc, sel: Selection, origin: 'dom' | 'api', typing: boolean): boolean {
    if (doc.text === this.cur.text && sameChips(doc, this.cur)) {
      this.sel = clampSel(sel, this.cur);
      return false;
    }
    const now = this.opts.now();
    const entry: Entry = { doc, sel: clampSel(sel, doc) };
    this.hist.length = this.at + 1;
    if (typing && this.at > 0 && now - this.lastTypeAt < this.opts.coalesceMs) {
      this.hist[this.at] = entry;
    } else {
      this.hist.push(entry);
      this.at++;
      if (this.hist.length > this.opts.historyLimit + 1) {
        this.hist.shift();
        this.at--;
      }
    }
    this.lastTypeAt = typing ? now : -Infinity;
    this.cur = doc;
    this.sel = entry.sel;
    this.rev++;
    this.afterChange(origin);
    return true;
  }

  private afterChange(origin: 'dom' | 'api' | 'history'): void {
    this.settleUploads();
    this.gc();
    this.emit({ kind: 'doc', origin });
  }

  // ---- lifetime -----------------------------------------------------------------------

  /** Keeps a resource (its bytes and its object URL) while something displays it. Call the result to let go. */
  pin(id: string): () => void {
    this.pins.set(id, (this.pins.get(id) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.pins.get(id) ?? 1) - 1;
      if (n > 0) this.pins.set(id, n);
      else this.pins.delete(id);
      this.gc();
    };
  }

  private referenced(): Set<string> {
    const set = new Set<string>();
    for (const e of this.hist) for (const id of resourcesOf(e.doc)) set.add(id);
    for (const id of this.pins.keys()) set.add(id);
    for (const id of this.wants.keys()) set.add(id);
    return set;
  }

  private gc(): void {
    const keep = this.referenced();
    for (const r of [...this.res.values()]) if (!keep.has(r.id)) this.release(r);
  }

  private release(r: Resource): void {
    this.cancel(r);
    this.res.delete(r.id);
    this.opts.revokeUrl(r.url);
  }

  /**
   * Makes `text` the whole document, with no undo history behind it (a generated prompt replacing the last one, not
   * something the user typed). Each `[Image #n: <path>]` whose path is an uploaded image of `from` becomes a chip that
   * is already uploaded (no second upload; the bytes are shared for its thumbnail); any other marker stays text. The
   * caret goes to the end. False (and no event) when the document would not change.
   */
  replaceAll(text: string, from?: Draft): boolean {
    const known = new Map<string, Resource>();
    if (from) for (const r of from.res.values()) if (r.status === 'ready' && r.path !== undefined && !known.has(r.path)) known.set(r.path, r);
    const mine = new Map<string, string>();
    const occs: Occurrence[] = [];
    let out = '';
    for (const part of splitMarkers(cleanText(text))) {
      if (part.kind === 'text') {
        out += part.text;
        continue;
      }
      const src = known.get(part.path);
      if (!src || occs.length >= this.opts.maxImages) {
        out += `[Image #${occs.length + 1}: ${part.path}]`;
        continue;
      }
      let res = mine.get(part.path);
      if (res === undefined) {
        const r: Resource = { id: `r${++this.ids}`, seq: ++this.seq, name: src.name, mime: src.mime, size: src.size, blob: src.blob, url: this.opts.createUrl(src.blob), status: 'ready', path: part.path, attempt: 0 };
        this.res.set(r.id, r);
        res = r.id;
        mine.set(part.path, res);
      }
      occs.push({ occ: `o${++this.ids}`, res });
      out += IMG;
    }
    const paths = (d: Doc) => d.chips.map((o) => (isImageOcc(o) ? (this.res.get(o.res)?.path ?? '') : `@${o.path}`));
    const doc: Doc = { text: out, chips: occs };
    if (doc.text === this.cur.text && paths(doc).join('\n') === paths(this.cur).join('\n')) {
      this.gc();
      return false;
    }
    this.reset(doc, caret(out.length));
    return true;
  }

  /** `doc` is the whole document now, with no history behind it. */
  private reset(doc: Doc, sel: Selection): void {
    this.hist = [{ doc, sel }];
    this.at = 0;
    this.cur = doc;
    this.sel = sel;
    this.rev++;
    this.lastTypeAt = -Infinity;
    this.afterChange('api');
  }

  /** After a successful send: nothing of the draft is kept. */
  clear(): void {
    this.wipe(false);
  }

  private wipe(keepRefusal: boolean): void {
    this.hist = [{ doc: EMPTY_DOC, sel: EMPTY_SEL }];
    this.at = 0;
    this.cur = EMPTY_DOC;
    this.sel = EMPTY_SEL;
    this.rev++;
    this.lastTypeAt = -Infinity;
    for (const r of [...this.res.values()]) this.release(r);
    const held = this.refused !== null && !keepRefusal;
    if (!keepRefusal) this.refused = null;
    this.emit({ kind: 'doc', origin: 'api' });
    if (held) this.emit({ kind: 'refusal' });
  }

  /**
   * `clear()` only if nothing was edited since `revision`: a newer edit, made while the send was pending, survives it.
   * A held refusal survives too: `resolve()` does not resolve while one is held, so any refusal held now was made after
   * the send's snapshot, and the send's (stale) acknowledgement must not dismiss it for the user.
   */
  clearIf(revision: number): boolean {
    if (this.rev !== revision) return false;
    this.wipe(true);
    return true;
  }

  /** The draft is no more: uploads are cancelled and every object URL is revoked. */
  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    for (const r of [...this.res.values()]) this.release(r);
    this.hist = [{ doc: EMPTY_DOC, sel: EMPTY_SEL }];
    this.at = 0;
    this.cur = EMPTY_DOC;
    this.emit({ kind: 'doc', origin: 'api' });
    this.listeners.clear();
  }

  // ---- uploads ------------------------------------------------------------------------

  private wanted(id: string): boolean {
    return this.wants.has(id) || imagesOf(this.cur).some((o) => o.res === id);
  }

  /** Cancels an upload in flight; the resource goes back to pending and any late answer is ignored. */
  private cancel(r: Resource): void {
    const ac = this.inflight.get(r.id);
    if (!ac) return;
    this.inflight.delete(r.id);
    r.attempt++;
    r.status = 'pending';
    ac.abort();
  }

  /** Cancels what nothing wants any more, starts what is wanted and waits. */
  private settleUploads(): void {
    for (const r of this.res.values()) {
      if (r.status === 'uploading' && !this.wanted(r.id)) {
        this.cancel(r);
        this.emit({ kind: 'resource', id: r.id });
      }
    }
    this.pump();
  }

  private pump(): void {
    if (this.dead) return;
    let running = this.inflight.size;
    for (const r of this.res.values()) {
      if (running >= this.opts.concurrency) break;
      if (r.status !== 'pending' || !this.wanted(r.id)) continue;
      running++;
      this.start(r);
    }
  }

  private start(r: Resource): void {
    const ac = new AbortController();
    const token = ++r.attempt;
    this.inflight.set(r.id, ac);
    r.status = 'uploading';
    delete r.error;
    delete r.code;
    this.emit({ kind: 'resource', id: r.id });
    const label = typeof this.opts.label === 'function' ? this.opts.label() : this.opts.label;
    let p: Promise<CommandResult>;
    try {
      p = this.opts.upload(r.blob, { label, n: r.seq }, ac.signal);
    } catch (e) {
      p = Promise.resolve({ ok: false, code: 'internal', message: String(e) });
    }
    void p.then(
      (res) => this.done(r, token, res),
      (e: unknown) => this.done(r, token, { ok: false, code: 'internal', message: String(e) }),
    );
  }

  private done(r: Resource, token: number, res: CommandResult): void {
    // Stale: cancelled (removed, disposed) or retried since this attempt began.
    if (r.attempt !== token || r.status !== 'uploading' || this.res.get(r.id) !== r) return;
    this.inflight.delete(r.id);
    const data = res.ok ? (res.data as Partial<UploadedImage> | null) : null;
    if (res.ok && data && typeof data.path === 'string') {
      r.status = 'ready';
      r.path = data.path;
    } else {
      r.status = 'error';
      r.code = res.ok ? 'dropzone_bad_response' : res.code;
      r.error = res.ok ? 'the upload answered with something that is not an image path' : res.message;
    }
    this.emit({ kind: 'resource', id: r.id });
    this.pump();
  }

  /** Puts a failed upload back in the queue. Images already uploaded are never sent again. */
  retry(id: string): boolean {
    const r = this.res.get(id);
    if (!r || r.status !== 'error') return false;
    r.status = 'pending';
    delete r.error;
    delete r.code;
    this.emit({ kind: 'resource', id });
    this.pump();
    return true;
  }

  /**
   * The finished prompt, once every image of the document *as it is now* is uploaded: the text with its markers.
   * Images not uploaded yet are waited for. One that has failed (before or during the wait) is not tried again by
   * this: the user retries it (`retry`, the chip's button), so a broken Drop Zone is not hammered by every press of
   * Enter. It never returns partial text: one failed image makes it `ok:false` with the list of the failed, and
   * nothing to send. It reads the document at the moment of the call: the host freezes editing (or compares `revision` with
   * `result.revision`) while it waits.
   */
  async resolve(o: { maxBytes?: number; hint?: boolean } = {}): Promise<ResolveResult> {
    const doc = this.cur;
    const revision = this.rev;
    if (this.dead) return { ok: false, reason: 'disposed', revision };
    if (this.refused !== null) return { ok: false, reason: 'refused', revision, message: this.refused };
    const ids = resourcesOf(doc);
    for (const id of ids) this.wants.set(id, (this.wants.get(id) ?? 0) + 1);
    try {
      this.pump();
      await this.settled(ids);
    } finally {
      for (const id of ids) {
        const n = (this.wants.get(id) ?? 1) - 1;
        if (n > 0) this.wants.set(id, n);
        else this.wants.delete(id);
      }
    }
    if (this.dead) return { ok: false, reason: 'disposed', revision };
    const failed: FailedImage[] = [];
    const paths = new Map<string, string>();
    for (const id of ids) {
      const r = this.res.get(id);
      if (r?.status === 'ready' && r.path !== undefined) {
        paths.set(id, r.path);
        continue;
      }
      failed.push({
        res: id,
        name: r?.name ?? 'An image',
        numbers: imagesOf(doc).flatMap((im, i) => (im.res === id ? [i + 1] : [])),
        message: r?.error ?? 'the image is no longer in the draft',
        code: r?.code ?? 'gone',
      });
    }
    this.settleUploads();
    if (failed.length > 0) return { ok: false, reason: 'upload', revision, failed };
    const s = serializePrompt(doc, paths, { maxBytes: o.maxBytes ?? this.opts.maxPromptBytes, ...(o.hint !== undefined ? { hint: o.hint } : {}) });
    if (!s.ok) return { ok: false, reason: 'serialize', revision, error: s.error };
    return { ok: true, text: s.text, revision, images: s.images };
  }

  /** Resolves when none of `ids` is pending or uploading (or the draft is gone). */
  private settled(ids: readonly string[]): Promise<void> {
    const open = () => !this.dead && ids.some((id) => {
      const s = this.res.get(id)?.status;
      return s === 'pending' || s === 'uploading';
    });
    if (!open()) return Promise.resolve();
    return new Promise((resolve) => {
      const off = this.subscribe(() => {
        if (open()) return;
        off();
        resolve();
      });
    });
  }
}

/** A document's chips by what they are, not by their occurrence ids. */
const contentOf = (d: Doc): string => d.chips.map((c) => (isFileOcc(c) ? `f${c.dir ? '/' : ''}:${c.path}` : `i:${c.res}`)).join('\n');
