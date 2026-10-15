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
import { draftKey, dropDraft, dropDraftIf, keepDraft, readDraft, type Draft } from './draft';

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

type BoardAppState = ReturnType<typeof cleanAppState>;

/** What a save sends, taken at one moment: the scene, its files, the board's appState and the version it is based on. */
interface SaveSnapshot {
  elements: readonly OrderedExcalidrawElement[];
  files: BinaryFiles;
  appState: BoardAppState;
  base: number;
  /** The elements' and the appState's signatures: what is saved once this lands. */
  els: string;
  app: string;
}

const elsSig = (els: readonly ExcalidrawElement[]): string => hashElementsVersion(els).toString();
/** The board's part of an appState (background, grid) as JSON: compared, never parsed. */
const appSig = (a: unknown): string => JSON.stringify(cleanAppState(a as Record<string, unknown>));

/**
 * A saved scene (and its appState signature) has all of a draft: reconciling the draft into it would change nothing.
 * Every draft element is in it at a version Excalidraw's reconcile keeps over the draft's (higher, or the same with a
 * nonce not above it: data/reconcile.ts), and the draft's appState, when it changed one, is the saved one. A draft
 * with anything more (a stroke drawn after that save was taken) is not covered and stays.
 */
function covers(saved: readonly ExcalidrawElement[], app: string, d: Draft): boolean {
  if (d.appState && appSig(d.appState) !== app) return false;
  const have = new Map(saved.map((e) => [e.id, e]));
  return restoreElements(d.elements as ExcalidrawElement[], null).every((e) => {
    const s = have.get(e.id);
    return !!s && (s.version > e.version || (s.version === e.version && s.versionNonce <= e.versionNonce));
  });
}

type PinSizes = Map<string, { version: number; width: number; height: number }>;

/** `elements` with the measured pin sizes; a pin edited since it was measured keeps its own. Same array if none apply. */
function resized(elements: readonly OrderedExcalidrawElement[], sizes: PinSizes): OrderedExcalidrawElement[] {
  if (!sizes.size) return elements as OrderedExcalidrawElement[];
  let changed = false;
  const out = elements.map((e) => {
    const f = sizes.get(e.id);
    if (!f || f.version !== e.version || (f.width === e.width && f.height === e.height)) return e;
    changed = true;
    return newElementWith(e, { width: f.width, height: f.height });
  });
  return changed ? out : (elements as OrderedExcalidrawElement[]);
}

/** One open whiteboard: the editor mounted in `host.mount` and its sync with the bridge. */
export class BoardSession {
  private api: ExcalidrawImperativeAPI | null = null;
  private root: Root | null = null;
  private base = 0;
  /** The signatures of what the bridge has at `base`: the elements (hashElementsVersion) and the board's appState. */
  private savedEls = '';
  private savedApp = '';
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
  private readonly draft: string;
  /** A kept draft came back at open: a save that lands with all of it drops it (never once disposed). */
  private restored = false;
  /** The newest version the bridge announced before the editor was up: merged once it is. */
  private announced = 0;

  constructor(private readonly host: EditorHost) {
    this.draft = draftKey(host.wsUrl, host.floor);
  }

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
    let elements: readonly OrderedExcalidrawElement[] = restoreElements(board.scene.elements as ExcalidrawElement[], null, { repairBindings: true });
    this.savedEls = elsSig(elements);
    let appState: BoardAppState = cleanAppState(board.scene.appState);
    this.savedApp = JSON.stringify(appState);
    const draft = readDraft(this.draft);
    if (draft) {
      // What a close could not save, on top of the board as it is now (an agent's pin since stays): it is saved below.
      const mine = restoreElements(draft.elements as ExcalidrawElement[], null, { repairBindings: true });
      elements = reconcileElements(mine, elements as RemoteExcalidrawElement[], {} as AppState);
      if (draft.appState) appState = cleanAppState(draft.appState);
      const have = new Set(files.map((f) => f.id as string));
      for (const f of draft.files) if (!have.has(f.id)) files.push(f as BinaryFileData);
      this.restored = true;
    }
    const ready = new Promise<ExcalidrawImperativeAPI>((resolve) => {
      this.root = createRoot(this.host.mount);
      this.root.render(
        h(
          Excalidraw,
          {
            initialData: { elements, appState: { ...appState, theme: 'light' }, files: Object.fromEntries(files.map((f) => [f.id, f])), scrollToContent: true },
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
            name: `${this.host.floorName ?? this.host.floor} whiteboard`,
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
    // The board's appState as Excalidraw shows it (its defaults filled in) is what is saved, unless a draft changed it.
    if (!draft?.appState) this.savedApp = appSig(api.getAppState());
    if (this.stale) {
      // Agents pinned since the last render: lay their notes out with the fonts loaded and render the board again.
      await this.normalizePins(api);
      if (this.closed) return;
      this.schedule(0);
    }
    // Nothing in the draft the bridge does not have: it goes (only that draft: what it covers is checked again).
    if (this.restored && !this.unsaved(api)) this.dropDraftCovered(api.getSceneElementsIncludingDeleted(), this.savedApp);
    if (this.unsaved(api)) {
      this.setStatus({ kind: 'dirty' });
      this.schedule(0);
    } else this.setStatus({ kind: 'saved', version: this.base });
    // The board changed on the bridge while it opened (its update came before the editor could merge it).
    if (this.announced > this.base) void this.merge().catch(() => {});
  }

  /** Drops the kept draft if `elements` (saved, with appState `app`) have all of it; a disposed session never does. */
  private dropDraftCovered(elements: readonly ExcalidrawElement[], app: string): void {
    if (this.closed || !this.restored) return;
    if (dropDraftIf(this.draft, (d) => covers(elements, app, d))) this.restored = false;
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
    if (this.closed || !this.api || !this.unsaved(this.api)) return;
    this.changeSeq++;
    if (this.status.kind === 'saved') this.setStatus({ kind: 'dirty' });
    this.schedule(SAVE_DEBOUNCE_MS);
  }

  /** The live scene or the board's appState differs from what the bridge has. */
  private unsaved(api: ExcalidrawImperativeAPI): boolean {
    return elsSig(api.getSceneElementsIncludingDeleted()) !== this.savedEls || appSig(api.getAppState()) !== this.savedApp;
  }

  /** The board as one save sends it. The PNG is made from this, and it is posted on this base, whatever comes after. */
  private snapshot(api: ExcalidrawImperativeAPI): SaveSnapshot {
    const elements = api.getSceneElementsIncludingDeleted();
    const appState = cleanAppState(api.getAppState() as unknown as Record<string, unknown>);
    return { elements, files: api.getFiles(), appState, base: this.base, els: elsSig(elements), app: JSON.stringify(appState) };
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
      if (this.api !== api) return;
      const snap = this.snapshot(api);
      if (snap.els === this.savedEls && snap.app === this.savedApp && !this.stale) {
        this.setStatus({ kind: 'saved', version: this.base });
        return;
      }
      this.setStatus({ kind: 'saving' });
      try {
        await this.uploadFiles(snap);
        const render = await this.render(snap);
        // Closed meanwhile (kept as a draft, or discarded): a disposed session posts nothing more.
        if (this.closed || this.api !== api) return;
        // A merge moved the board on while the files went up or the PNG was made: this snapshot is from before it, and
        // posting it on the new base would drop what the merge brought (an agent's pin). Take the scene again.
        if (this.base !== snap.base) continue;
        const r = await saveBoard(this.host.wsUrl, this.host.floor, { base: snap.base, author: this.host.author(), scene: { elements: snap.elements, appState: snap.appState }, render });
        if (r.ok) {
          const st = r.data as WhiteboardState;
          // (A merge of a still newer version may have landed meanwhile: then that one is what is saved.)
          if (st.version >= this.base) {
            this.base = st.version;
            this.savedEls = snap.els;
            this.savedApp = snap.app;
            this.noteState(st);
          }
          // A draft restored at open goes once a save has all of it. Not when the session was closed meanwhile: the
          // draft kept then has what was drawn after this snapshot (and belongs to the next open).
          this.dropDraftCovered(snap.elements, snap.app);
          // Drawn while it was saving: the next save (scheduled by the change) takes it.
          this.setStatus(this.unsaved(api) ? { kind: 'dirty' } : { kind: 'saved', version: this.base });
          this.host.saved(st);
          return;
        }
        if (this.closed) return;
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
        if (to !== id && this.api === api) api.addFiles([{ id: to as FileId, mimeType: blob.type as BinaryFileData['mimeType'], dataURL: await toDataURL(blob), created: f.created }]);
      }
      if (to !== id) remap.set(id, to);
    }
    if (!remap.size || this.api !== api) return;
    const next = api
      .getSceneElementsIncludingDeleted()
      .map((e) => (imageOf(e) && e.fileId && remap.has(e.fileId) ? newElementWith(e, { fileId: remap.get(e.fileId) as FileId }) : e));
    api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER });
  }

  private async uploadFiles(snap: SaveSnapshot): Promise<void> {
    const files = snap.files;
    const ids = new Set(snap.elements.filter(imageOf).map((e) => e.fileId as string | null));
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

  /** The snapshot as a PNG of at most WB_RENDER_MAX_SIDE px (exportScale 1: a larger saved scale would beat the cap). */
  private async render(snap: SaveSnapshot): Promise<Blob> {
    const elements = snap.elements.filter((e) => !e.isDeleted);
    const bg = snap.appState.viewBackgroundColor;
    if (!elements.length) return blankRender(bg);
    return exportToBlob({
      elements,
      files: snap.files,
      mimeType: 'image/png',
      maxWidthOrHeight: WB_RENDER_MAX_SIDE,
      exportPadding: 24,
      appState: { viewBackgroundColor: bg, exportBackground: true, exportWithDarkMode: false, exportEmbedScene: false, exportScale: 1 },
    });
  }

  /**
   * Fetches the board and reconciles it into the live scene (local strokes in progress are kept). Merges may overlap
   * (an update arrives while one waits on image bytes) and a save may land during one: the version is checked against
   * the base after every await, and a board older than what the session already has is dropped before it touches the
   * scene, the appState, the base or the saved signatures. The base only ever goes up.
   */
  async merge(): Promise<void> {
    const api = this.api;
    if (!api) return;
    const r = await getBoard(this.host.wsUrl, this.host.floor);
    if (!r.ok) return;
    const board = r.data as BoardData;
    const current = () => !this.closed && this.api === api && board.version >= this.base;
    if (!current()) return;
    const have = api.getFiles();
    const missing = Object.keys(board.files).filter((id) => !have[id]);
    if (missing.length) {
      const files = await this.fetchFiles({ ...board, files: Object.fromEntries(missing.map((id) => [id, board.files[id] as BoardData['files'][string]])) });
      if (!current()) return;
      api.addFiles(files);
    }
    // Remote alone: restoring against the local elements would bump the remote versions above them.
    let remote = restoreElements(board.scene.elements as ExcalidrawElement[], null, { repairBindings: true });
    const remoteSig = elsSig(remote);
    const remoteApp = cleanAppState(board.scene.appState);
    const pins = new Set(board.state.stale_pins.map((p) => p.id));
    if (pins.size) {
      remote = resized(remote, await this.measurePins(remote, api.getFiles(), pins));
      if (!current()) return;
    }
    // From here to the end nothing awaits: this board is applied whole, against the live scene as it is now (a stroke
    // drawn during the awaits above is in it).
    for (const id of Object.keys(board.files)) this.uploaded.add(id);
    this.noteState(board.state);
    const local = api.getSceneElementsIncludingDeleted();
    const localUnsaved = elsSig(local) !== this.savedEls;
    // The background and the grid are the board's too: the remote ones win, unless they were changed here since the
    // last save (then ours are saved next, over them).
    const localAppUnsaved = appSig(api.getAppState()) !== this.savedApp;
    const merged = reconcileElements(local, remote as RemoteExcalidrawElement[], api.getAppState());
    api.updateScene({ elements: merged, ...(localAppUnsaved ? {} : { appState: remoteApp as unknown as AppState }), captureUpdate: CaptureUpdateAction.NEVER });
    this.base = board.version;
    // Nothing of ours on top of the remote board: it is what is saved (only a stale render still needs a save).
    if (!localUnsaved) this.savedEls = remoteSig;
    if (!localAppUnsaved) this.savedApp = JSON.stringify(remoteApp);
    if (this.stale || this.unsaved(api)) this.schedule(SAVE_DEBOUNCE_MS / 2);
    else this.setStatus({ kind: 'saved', version: this.base });
  }

  /** The bridge says the board changed: merge it unless it is our own save (or, before the editor is up, note it). */
  remote(state: WhiteboardState): void {
    if (this.closed || state.version <= this.base) return;
    if (!this.api) {
      this.announced = Math.max(this.announced, state.version);
      return;
    }
    // A merge that fails leaves the board as it is: the next save's conflict merges again.
    void this.merge().catch(() => {});
  }

  /** Lays out the agents' pins (their notes' sizes are the bridge's guesses) with the fonts loaded. */
  private async normalizePins(api: ExcalidrawImperativeAPI): Promise<void> {
    const sizes = await this.measurePins(api.getSceneElementsIncludingDeleted(), api.getFiles(), this.stalePins);
    if (this.api !== api) return;
    // The scene as it is now (a merge or a stroke may have landed during the measure), not the one measured.
    const all = api.getSceneElementsIncludingDeleted();
    const next = resized(all, sizes);
    if (next !== all) api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER });
  }

  /** The sizes of the pinned notes in `elements` measured with their fonts loaded, by id and for their version. */
  private async measurePins(elements: readonly OrderedExcalidrawElement[], files: BinaryFiles, ids: ReadonlySet<string>): Promise<PinSizes> {
    const pins = elements.filter((e) => ids.has(e.id) && !e.isDeleted && e.type === 'text');
    if (!pins.length) return new Map();
    // A tiny export loads the font faces the notes use, so the measure below uses them.
    await exportToCanvas({ elements: pins, files, maxWidthOrHeight: 1, appState: { exportScale: 1 }, exportPadding: 1 }).catch(() => null);
    const version = new Map(pins.map((e) => [e.id, e.version]));
    return new Map(
      restoreElements(pins, null, { repairBindings: true, refreshDimensions: true }).map((e) => [e.id, { version: version.get(e.id) ?? -1, width: e.width, height: e.height }]),
    );
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
    const dataURL = await toDataURL(stored);
    if (this.api !== api) return; // closed meanwhile
    this.canon.set(id, id);
    api.addFiles([{ id, mimeType: stored.type as BinaryFileData['mimeType'], dataURL, created: Date.now() }]);
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
    return !!this.saving || !!this.timer || (!!this.api && this.unsaved(this.api));
  }

  /**
   * Saves what is left, until nothing is: what was drawn while a save was in flight goes in the next one. True when
   * the board is saved; false when a save failed or `timeoutMs` passed (the session stays as it was, its retry
   * scheduled: the caller retries, keeps a draft or discards, see dispose).
   */
  async flush(timeoutMs = 8000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const api = this.api;
      if (!api || this.closed) return true;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      if (!this.saving && !this.stale && !this.unsaved(api)) return true;
      const left = deadline - Date.now();
      if (left <= 0) return false;
      let late: ReturnType<typeof setTimeout> | undefined;
      const done = await Promise.race([this.save().then(() => true), new Promise<boolean>((r) => (late = setTimeout(() => r(false), left)))]);
      clearTimeout(late);
      if (!done || this.status.kind === 'error') return false;
    }
  }

  /**
   * Unmounts the editor. What is not saved yet is kept as a draft for the next open of this board ('draft': in memory,
   * and in localStorage when it fits), or dropped with any draft kept before ('discard', the user's choice).
   */
  dispose(keep: 'draft' | 'discard' = 'draft'): void {
    if (this.closed) return; // once: a disposed session never touches the drafts again
    const api = this.api;
    if (keep === 'discard') dropDraft(this.draft);
    else if (api && (this.saving || this.unsaved(api))) this.keepDraft(api);
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.api = null;
    this.root?.unmount();
    this.root = null;
  }

  private keepDraft(api: ExcalidrawImperativeAPI): void {
    const elements = api.getSceneElementsIncludingDeleted();
    const files = api.getFiles();
    const ids = new Set(elements.filter((e) => imageOf(e) && !e.isDeleted).map((e) => (e as ExcalidrawImageElement).fileId as string | null));
    const live = [...ids].flatMap((id) => (id && files[id] ? [files[id]] : []));
    const app = appSig(api.getAppState()) !== this.savedApp ? cleanAppState(api.getAppState() as unknown as Record<string, unknown>) : null;
    keepDraft(this.draft, { v: 1, at: Date.now(), elements: [...elements], files: live, appState: app });
  }

  /** Saves what is left (bounded) and unmounts the editor, keeping a draft of what could not be saved. */
  async close(timeoutMs = 8000): Promise<boolean> {
    const saved = await this.flush(timeoutMs);
    this.dispose('draft');
    return saved;
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
