/**
 * M13 whiteboard: the Excalidraw editor as a React island, and the board's sync with the bridge. This module and
 * everything it imports from React, ReactDOM and Excalidraw are loaded only by `loadEditor()` (./load.ts), the first
 * time a whiteboard opens: the game's entry chunk has none of it (tools/check-bundle.ts proves it on every build).
 *
 * Sync (docs/research/excalidraw-data.md, section 7): the board is versioned on the bridge. A save sends every
 * element (tombstones included) based on the version it was loaded or merged at; the bridge refuses a stale base
 * (409), and the session then fetches the board, restores the remote elements on their own (never against the local
 * ones, which would bump their versions) and reconciles them into the live scene with `CaptureUpdateAction.NEVER`,
 * so an agent's pin lands without touching a stroke in progress, and saves again. Image files go up first, each once,
 * under the sha256 of exactly the bytes stored: Excalidraw hashes a pasted file before it resizes it, so a file whose
 * bytes do not match its id is re-filed under their hash (and SVGs and other types become PNG) before a save.
 */

import { createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  CaptureUpdateAction,
  Excalidraw,
  MainMenu,
  WelcomeScreen,
  convertToExcalidrawElements,
  exportToBlob,
  exportToCanvas,
  hashElementsVersion,
  newElementWith,
  reconcileElements,
  restoreElements,
  viewportCoordsToSceneCoords,
} from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import './editor.css';
import type { AppState, BinaryFileData, BinaryFiles, DataURL, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement, ExcalidrawImageElement, FileId, OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { RemoteExcalidrawElement } from '@excalidraw/excalidraw/data/reconcile';
import { fileUrl, getBoard, putFile, saveBoard, sha256Hex, WB_FILE_TYPES, WB_MAX_FILE, WB_RENDER_MAX_SIDE, type BoardData } from '../net/whiteboard';
import type { WhiteboardState } from '../net/protocol';
import { blankRender, cleanAppState, fitInto, isIdle, type BoardStatus, type EditorHost } from './model';

export type { EditorHost } from './model';

/** How long after the last change a save starts; again after a failure. */
const SAVE_DEBOUNCE_MS = 1200;
const RETRY_MS = 5000;
const MAX_ROUNDS = 6;
/** A pinned drop is placed at most this big (scene units) in the middle of the view. */
const DROP_BOX = { w: 640, h: 480 };
/** Images over this side are scaled down before they are stored (Excalidraw's own insertion uses 1440). */
const MAX_IMAGE_SIDE = 1600;

const toDataURL = (b: Blob): Promise<DataURL> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.onload = () => resolve(r.result as DataURL);
    r.readAsDataURL(b);
  });

function dataURLBytes(d: string): { bytes: Uint8Array; mime: string } | null {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(d);
  if (!m) return null;
  const body = m[3] ?? '';
  if (!m[2]) return { bytes: new TextEncoder().encode(decodeURIComponent(body)), mime: m[1] || 'application/octet-stream' };
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mime: m[1] || 'application/octet-stream' };
}

/** Bytes the bridge stores: a PNG/JPEG/GIF/WebP of at most WB_MAX_FILE and MAX_IMAGE_SIDE, else redrawn as PNG/JPEG. */
async function storable(blob: Blob): Promise<Blob> {
  const typeOk = (WB_FILE_TYPES as readonly string[]).includes(blob.type);
  let bmp: ImageBitmap | null = null;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    if (typeOk && blob.size <= WB_MAX_FILE) return blob; // not decodable here (an animated GIF frame?): as it is
    throw new Error('the image cannot be read');
  }
  const big = Math.max(bmp.width, bmp.height) > MAX_IMAGE_SIDE;
  if (typeOk && blob.size <= WB_MAX_FILE && !big) {
    bmp.close();
    return blob;
  }
  const { w, hh } = ((): { w: number; hh: number } => {
    const k = Math.min(1, MAX_IMAGE_SIDE / Math.max(bmp.width, bmp.height));
    return { w: Math.max(1, Math.round(bmp.width * k)), hh: Math.max(1, Math.round(bmp.height * k)) };
  })();
  const c = document.createElement('canvas');
  c.width = w;
  c.height = hh;
  c.getContext('2d')?.drawImage(bmp, 0, 0, w, hh);
  bmp.close();
  const jpeg = blob.type === 'image/jpeg';
  for (const q of [0.9, 0.8, 0.65]) {
    const out = await new Promise<Blob | null>((r) => c.toBlob(r, jpeg ? 'image/jpeg' : 'image/png', q));
    if (out && out.size <= WB_MAX_FILE) return out;
    if (!out) break;
  }
  const out = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.6));
  if (!out || out.size > WB_MAX_FILE) throw new Error('the image is too large to store');
  return out;
}

const imageOf = <T extends ExcalidrawElement>(e: T): e is T & ExcalidrawImageElement => e.type === 'image';

/** One open whiteboard: the editor mounted in `host.mount` and its sync with the bridge. */
export class BoardSession {
  private api: ExcalidrawImperativeAPI | null = null;
  private root: Root | null = null;
  private base = 0;
  private savedSig = '';
  /** Files the bridge has (by id), so each goes up once. */
  private readonly uploaded = new Set<string>();
  /** Original file id → the hash of the bytes it stores as (canonicalised already). */
  private readonly canon = new Map<string, string>();
  private stale = false;
  private stalePins = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> | null = null;
  private again = false;
  private closed = false;
  private changeSeq = 0;
  private status: BoardStatus = { kind: 'loading' };

  constructor(private readonly host: EditorHost) {}

  private setStatus(s: BoardStatus): void {
    this.status = s;
    if (!this.closed) this.host.status(s);
  }

  get statusNow(): BoardStatus {
    return this.status;
  }

  /** Loads the board and mounts the editor; resolves when it is on screen. */
  async open(): Promise<void> {
    const r = await getBoard(this.host.wsUrl, this.host.floor);
    if (!r.ok) throw new Error(r.message);
    const board = r.data as BoardData;
    const files = await this.fetchFiles(board);
    if (this.closed) return;
    this.base = board.version;
    this.noteState(board.state);
    const elements = restoreElements(board.scene.elements as ExcalidrawElement[], null, { repairBindings: true });
    this.savedSig = hashElementsVersion(elements).toString();
    const ready = new Promise<ExcalidrawImperativeAPI>((resolve) => {
      this.root = createRoot(this.host.mount);
      this.root.render(
        h(
          Excalidraw,
          {
            initialData: { elements, appState: { ...cleanAppState(board.scene.appState), theme: 'light' }, files: Object.fromEntries(files.map((f) => [f.id, f])), scrollToContent: true },
            excalidrawAPI: (api) => {
              this.api = api;
              resolve(api);
            },
            onChange: () => this.changed(),
            theme: 'light',
            langCode: 'en',
            autoFocus: true,
            handleKeyboardGlobally: false,
            aiEnabled: false,
            // No web embeds (they would load other sites), and links never navigate away from the game.
            validateEmbeddable: () => false,
            onLinkOpen: (el, ev) => {
              ev.preventDefault();
              if (el.link) this.host.link(el.link);
            },
            generateIdForFile: async (file: File) => sha256Hex(await file.arrayBuffer()),
            UIOptions: {
              canvasActions: { export: false, loadScene: false, saveToActiveFile: false, saveAsImage: false, toggleTheme: null, clearCanvas: false },
              tools: { image: true },
            },
            name: `${this.host.floor} whiteboard`,
          },
          // Our own menu and welcome: Excalidraw's defaults link to its website, socials and help.
          h(MainMenu, null, h(MainMenu.DefaultItems.ChangeCanvasBackground), h(MainMenu.DefaultItems.SearchMenu)),
          h(
            WelcomeScreen,
            null,
            h(WelcomeScreen.Hints.ToolbarHint),
            h(WelcomeScreen.Center, null, h(WelcomeScreen.Center.Heading, null, 'Draw, paste a screenshot, or pin a drop. Everyone on this floor sees it.')),
          ),
        ),
      );
    });
    const api = await ready;
    if (this.closed) return;
    if (this.stale) {
      // Agents pinned since the last render: lay their notes out with the fonts loaded and render the board again.
      await this.normalizePins(api);
      this.schedule(0);
    }
    this.setStatus({ kind: 'saved', version: this.base });
  }

  private async fetchFiles(board: BoardData): Promise<BinaryFileData[]> {
    const out: BinaryFileData[] = [];
    await Promise.all(
      Object.entries(board.files).map(async ([id, meta]) => {
        try {
          const res = await fetch(fileUrl(this.host.wsUrl, this.host.floor, id), { cache: 'force-cache' });
          if (!res.ok) return;
          const blob = await res.blob();
          out.push({ id: id as FileId, mimeType: meta.mimeType as BinaryFileData['mimeType'], dataURL: await toDataURL(blob), created: meta.created || Date.now() });
          this.uploaded.add(id);
        } catch {
          // A missing file shows as Excalidraw's broken image; the board still opens.
        }
      }),
    );
    return out;
  }

  private noteState(s: WhiteboardState): void {
    this.stale = s.stale;
    this.stalePins = new Set(s.stale_pins.map((p) => p.id));
    this.host.stale(s);
  }

  private changed(): void {
    if (this.closed || !this.api) return;
    const sig = this.sig();
    if (sig === this.savedSig) return;
    this.changeSeq++;
    if (this.status.kind === 'saved') this.setStatus({ kind: 'dirty' });
    this.schedule(SAVE_DEBOUNCE_MS);
  }

  private sig(): string {
    if (!this.api) return '';
    return hashElementsVersion(this.api.getSceneElementsIncludingDeleted()).toString();
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      const api = this.api;
      // Never in the middle of a stroke, a drag or a text edit: the save waits until it is done.
      if (api && !isIdle(api.getAppState())) return this.schedule(400);
      void this.save();
    }, ms);
  }

  /** Saves now (or after the save in flight); resolves when the board is saved or the save gave up. */
  save(): Promise<void> {
    if (this.saving) {
      this.again = true;
      return this.saving;
    }
    this.saving = this.saveRounds().finally(() => {
      this.saving = null;
      if (this.again && !this.closed) {
        this.again = false;
        this.schedule(0);
      }
    });
    return this.saving;
  }

  private async saveRounds(): Promise<void> {
    const api = this.api;
    if (!api) return;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      await this.canonicalize(api);
      const elements = api.getSceneElementsIncludingDeleted();
      const sig = hashElementsVersion(elements).toString();
      if (sig === this.savedSig && !this.stale) {
        this.setStatus({ kind: 'saved', version: this.base });
        return;
      }
      this.setStatus({ kind: 'saving' });
      try {
        await this.uploadFiles(api, elements);
        const render = await this.render(api);
        const appState = cleanAppState(api.getAppState() as unknown as Record<string, unknown>);
        const r = await saveBoard(this.host.wsUrl, this.host.floor, { base: this.base, author: this.host.author(), scene: { elements, appState }, render });
        if (r.ok) {
          const st = r.data as WhiteboardState;
          this.base = st.version;
          this.savedSig = sig;
          this.noteState(st);
          this.setStatus({ kind: 'saved', version: this.base });
          this.host.saved(st);
          return;
        }
        if (r.code === 'whiteboard_conflict') {
          await this.merge();
          continue;
        }
        if (r.code === 'whiteboard_missing_file') {
          this.uploaded.clear();
          continue;
        }
        throw new Error(r.message);
      } catch (err) {
        this.setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
        if (!this.closed) this.schedule(RETRY_MS);
        return;
      }
    }
    this.setStatus({ kind: 'error', message: 'the board kept changing on the bridge; trying again' });
    if (!this.closed) this.schedule(RETRY_MS);
  }

  /** Every image's file id is the sha256 of the bytes it stores as: a file that is not is re-filed under its hash. */
  private async canonicalize(api: ExcalidrawImperativeAPI): Promise<void> {
    const files = api.getFiles();
    const remap = new Map<string, string>();
    const used = new Set(api.getSceneElementsIncludingDeleted().filter(imageOf).map((e) => e.fileId as string | null));
    for (const id of used) {
      if (!id || this.uploaded.has(id)) continue;
      const f = files[id];
      if (!f) continue;
      let to = this.canon.get(id);
      if (to === undefined) {
        const raw = dataURLBytes(f.dataURL);
        if (!raw) continue;
        let blob = new Blob([raw.bytes as Uint8Array<ArrayBuffer>], { type: raw.mime });
        blob = await storable(blob).catch(() => blob);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        to = await sha256Hex(bytes);
        this.canon.set(id, to);
        if (to !== id) api.addFiles([{ id: to as FileId, mimeType: blob.type as BinaryFileData['mimeType'], dataURL: await toDataURL(blob), created: f.created }]);
      }
      if (to !== id) remap.set(id, to);
    }
    if (!remap.size) return;
    const next = api
      .getSceneElementsIncludingDeleted()
      .map((e) => (imageOf(e) && e.fileId && remap.has(e.fileId) ? newElementWith(e, { fileId: remap.get(e.fileId) as FileId }) : e));
    api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER });
  }

  private async uploadFiles(api: ExcalidrawImperativeAPI, elements: readonly ExcalidrawElement[]): Promise<void> {
    const files = api.getFiles();
    const ids = new Set(elements.filter(imageOf).map((e) => e.fileId as string | null));
    for (const id of ids) {
      if (!id || this.uploaded.has(id)) continue;
      const f = files[id];
      const raw = f && dataURLBytes(f.dataURL);
      if (!raw) continue; // a tombstone's file this session never had: the bridge does not need it
      const r = await putFile(this.host.wsUrl, this.host.floor, id, new Blob([raw.bytes as Uint8Array<ArrayBuffer>], { type: raw.mime }));
      if (!r.ok) throw new Error(`an image could not be stored: ${r.message}`);
      this.uploaded.add(id);
    }
  }

  /** The board as a PNG of at most WB_RENDER_MAX_SIDE px (exportScale 1: a larger saved scale would beat the cap). */
  private async render(api: ExcalidrawImperativeAPI): Promise<Blob> {
    const elements = api.getSceneElements();
    const bg = api.getAppState().viewBackgroundColor;
    if (!elements.length) return blankRender(bg);
    return exportToBlob({
      elements,
      files: api.getFiles(),
      mimeType: 'image/png',
      maxWidthOrHeight: WB_RENDER_MAX_SIDE,
      exportPadding: 24,
      appState: { viewBackgroundColor: bg, exportBackground: true, exportWithDarkMode: false, exportEmbedScene: false, exportScale: 1 },
    });
  }

  /** Fetches the board and reconciles it into the live scene (local strokes in progress are kept). */
  async merge(): Promise<void> {
    const api = this.api;
    if (!api) return;
    const r = await getBoard(this.host.wsUrl, this.host.floor);
    if (!r.ok || this.closed) return;
    const board = r.data as BoardData;
    const have = api.getFiles();
    const missing = Object.keys(board.files).filter((id) => !have[id]);
    if (missing.length) api.addFiles(await this.fetchFiles({ ...board, files: Object.fromEntries(missing.map((id) => [id, board.files[id] as BoardData['files'][string]])) }));
    for (const id of Object.keys(board.files)) this.uploaded.add(id);
    this.noteState(board.state);
    // Remote alone: restoring against the local elements would bump the remote versions above them.
    let remote = restoreElements(board.scene.elements as ExcalidrawElement[], null, { repairBindings: true });
    const remoteSig = hashElementsVersion(remote).toString();
    const local = api.getSceneElementsIncludingDeleted();
    const localUnsaved = hashElementsVersion(local).toString() !== this.savedSig;
    if (this.stalePins.size) remote = await this.normalizeList(remote, api.getFiles());
    const merged = reconcileElements(local, remote as RemoteExcalidrawElement[], api.getAppState());
    api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
    this.base = board.version;
    // Nothing of ours on top of the remote board: it is what is saved (only a stale render still needs a save).
    if (!localUnsaved) this.savedSig = remoteSig;
    if (this.stale || hashElementsVersion(api.getSceneElementsIncludingDeleted()).toString() !== this.savedSig) this.schedule(SAVE_DEBOUNCE_MS / 2);
    else this.setStatus({ kind: 'saved', version: this.base });
  }

  /** The bridge says the board changed: merge it unless it is our own save. */
  remote(state: WhiteboardState): void {
    if (this.closed || !this.api || state.version <= this.base) return;
    void this.merge();
  }

  /** Lays out the agents' pins (their notes' sizes are the bridge's guesses) with the fonts loaded. */
  private async normalizePins(api: ExcalidrawImperativeAPI): Promise<void> {
    const all = api.getSceneElementsIncludingDeleted();
    const next = await this.normalizeList(all, api.getFiles());
    if (next !== all) api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER });
  }

  private async normalizeList(elements: readonly OrderedExcalidrawElement[], files: BinaryFiles): Promise<OrderedExcalidrawElement[]> {
    const pins = elements.filter((e) => this.stalePins.has(e.id) && !e.isDeleted && e.type === 'text');
    if (!pins.length) return elements as OrderedExcalidrawElement[];
    // A tiny export loads the font faces the notes use, so the measure below uses them.
    await exportToCanvas({ elements: pins, files, maxWidthOrHeight: 1, appState: { exportScale: 1 }, exportPadding: 1 }).catch(() => null);
    const fixed = new Map(restoreElements(pins, null, { repairBindings: true, refreshDimensions: true }).map((e) => [e.id, e]));
    return elements.map((e) => {
      const f = fixed.get(e.id);
      return f && (f.width !== e.width || f.height !== e.height) ? newElementWith(e, { width: f.width, height: f.height }) : e;
    }) as OrderedExcalidrawElement[];
  }

  /** Pins an image (a drop's bytes) in the middle of the view, as one undoable step. */
  async insertImage(blob: Blob, name: string): Promise<void> {
    const api = this.api;
    if (!api) throw new Error('the whiteboard is not open');
    const stored = await storable(blob);
    const bytes = new Uint8Array(await stored.arrayBuffer());
    const id = (await sha256Hex(bytes)) as FileId;
    const bmp = await createImageBitmap(stored);
    const size = fitInto(bmp.width, bmp.height, DROP_BOX.w, DROP_BOX.h);
    bmp.close();
    this.canon.set(id, id);
    api.addFiles([{ id, mimeType: stored.type as BinaryFileData['mimeType'], dataURL: await toDataURL(stored), created: Date.now() }]);
    const st = api.getAppState();
    const mid = viewportCoordsToSceneCoords({ clientX: st.offsetLeft + st.width / 2, clientY: st.offsetTop + st.height / 2 }, st);
    const [el] = convertToExcalidrawElements([
      { type: 'image', fileId: id, x: mid.x - size.w / 2, y: mid.y - size.h / 2, width: size.w, height: size.h, customData: { herdr: { kind: 'drop', name } } },
    ]);
    if (!el) return;
    api.updateScene({
      elements: [...api.getSceneElementsIncludingDeleted(), el],
      appState: { selectedElementIds: { [el.id]: true } } as unknown as AppState,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    this.schedule(300);
  }

  /** Esc: what it does in the editor right now. `pass`: Excalidraw handles it (finishing a text, a menu, a tool). */
  escape(): 'pass' | 'handled' | 'close' {
    const api = this.api;
    if (!api) return 'close';
    const st = api.getAppState();
    if (!isIdle(st, true)) return 'pass';
    if (Object.keys(st.selectedElementIds).length) {
      api.updateScene({ appState: { selectedElementIds: {}, selectedGroupIds: {} } as unknown as AppState, captureUpdate: CaptureUpdateAction.NEVER });
      return 'handled';
    }
    if (st.activeTool.type !== 'selection' && st.activeTool.type !== 'hand') {
      api.setActiveTool({ type: 'selection' });
      return 'handled';
    }
    return 'close';
  }

  /** Keys to the editor again (Excalidraw takes only the keys aimed at its container). */
  focus(): void {
    this.host.mount.querySelector<HTMLElement>('.excalidraw-container, .excalidraw')?.focus({ preventScroll: true });
  }

  /** Unsaved changes (or a save in flight). */
  get dirty(): boolean {
    return !!this.saving || !!this.timer || (!!this.api && this.sig() !== this.savedSig);
  }

  /** Saves what is left (bounded), then unmounts the editor. */
  async close(timeoutMs = 8000): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.api && (this.dirty || this.stale)) {
      await Promise.race([this.save(), new Promise((r) => setTimeout(r, timeoutMs))]);
    }
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.api = null;
    this.root?.unmount();
    this.root = null;
  }

  /** Test hook: the editor's API. */
  get excalidraw(): ExcalidrawImperativeAPI | null {
    return this.api;
  }

  get changes(): number {
    return this.changeSeq;
  }
}

/** Opens a board in `host.mount`. */
export function openSession(host: EditorHost): BoardSession {
  return new BoardSession(host);
}
