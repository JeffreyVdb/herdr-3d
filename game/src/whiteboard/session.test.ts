// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExcalidrawElement, ExcalidrawImageElement, OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { BinaryFileData, BinaryFiles } from '@excalidraw/excalidraw/types';
import type { BoardStatus } from './model';

// M13: the editor session's sync (editor.ts) with the real BoardSession and Excalidraw's own element functions
// (reconcile, restore, hash), the editor's React island replaced by a fake imperative API and the bridge's routes by
// mocks. Only the PNG export is faked: it writes the ids of the elements it was given, so a test can tell which scene
// a render shows.

let renderHold: Promise<void> | null = null;
vi.mock('@excalidraw/excalidraw', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@excalidraw/excalidraw')>()),
  exportToBlob: vi.fn(async ({ elements }: { elements: readonly ExcalidrawElement[] }) => {
    const ids = elements.map((e) => e.id).join(',');
    if (renderHold) await renderHold;
    return new Blob([ids], { type: 'image/png' });
  }),
}));
vi.mock('../net/whiteboard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../net/whiteboard')>()),
  getBoard: vi.fn(),
  saveBoard: vi.fn(),
  putFile: vi.fn(async () => ({ ok: true, data: {} })),
}));

// jsdom has no 2D canvas, and Excalidraw asks for one when it loads (it measures text): a context that does nothing.
HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
  return new Proxy({ canvas: this, font: '10px sans-serif', filter: 'none' } as Record<string | symbol, unknown>, {
    get: (t, k) => (k in t ? t[k] : k === 'measureText' ? (s: string) => ({ width: s.length * 10 }) : () => undefined),
    set: (t, k, v) => ((t[k] = v), true),
  });
} as unknown as typeof HTMLCanvasElement.prototype.getContext;

type Ex = typeof import('@excalidraw/excalidraw');
type Net = typeof import('../net/whiteboard');
let ex: Ex;
let net: { getBoard: ReturnType<typeof vi.fn>; saveBoard: ReturnType<typeof vi.fn>; putFile: ReturnType<typeof vi.fn> };
let BoardSession: typeof import('./editor').BoardSession;
let drafts: typeof import('./draft');

beforeAll(async () => {
  ex = await import('@excalidraw/excalidraw');
  net = (await import('../net/whiteboard')) as unknown as Net & typeof net;
  BoardSession = (await import('./editor')).BoardSession;
  drafts = await import('./draft');
  // Importing Excalidraw (transformed for the test, see vite.config.ts) takes seconds on a loaded machine.
}, 120_000);

const WS = 'ws://bridge.test/ws?token=t';
const FLOOR = 'f';
const WHITE = { viewBackgroundColor: '#ffffff', gridSize: 20, gridStep: 5, gridModeEnabled: false };

/** Elements a, b, pin … with valid fractional indices, in this order. */
function make(...ids: string[]): OrderedExcalidrawElement[] {
  return ex.convertToExcalidrawElements(ids.map((id, i) => ({ type: 'rectangle', id, x: i * 200, y: 0, width: 100, height: 60 })), { regenerateIds: false }) as OrderedExcalidrawElement[];
}

const ids = (els: readonly ExcalidrawElement[]) => els.filter((e) => !e.isDeleted).map((e) => e.id);

interface Fake {
  api: unknown;
  elements(): readonly OrderedExcalidrawElement[];
  app(): Record<string, unknown>;
  /** A user's edit: the scene changes and Excalidraw calls onChange. */
  draw(els: readonly OrderedExcalidrawElement[]): void;
  setBackground(c: string): void;
}

type Session = InstanceType<typeof BoardSession>;

/** A session on a mounted editor showing `els` at version `base` (what open() leaves). */
function session(els: OrderedExcalidrawElement[], base: number, statuses: BoardStatus[] = []): { s: Session; f: Fake } {
  const s = new BoardSession({ wsUrl: WS, floor: FLOOR, mount: document.createElement('div'), author: () => 'Theo', status: (x) => statuses.push(x), stale: () => {}, saved: () => {}, link: () => {} });
  let elements: readonly OrderedExcalidrawElement[] = els;
  let files: BinaryFiles = {};
  let appState: Record<string, unknown> = { ...WHITE, selectedElementIds: {}, activeTool: { type: 'selection' } };
  const internal = s as unknown as { changed(): void };
  const api = {
    getSceneElementsIncludingDeleted: () => elements,
    getSceneElements: () => elements.filter((e) => !e.isDeleted),
    getAppState: () => appState,
    getFiles: () => files,
    addFiles: (added: BinaryFileData[]) => {
      files = { ...files, ...Object.fromEntries(added.map((file) => [file.id, file])) };
    },
    updateScene: (u: { elements?: readonly OrderedExcalidrawElement[]; appState?: Record<string, unknown> }) => {
      if (u.elements) elements = u.elements;
      if (u.appState) appState = { ...appState, ...u.appState };
    },
  };
  Object.assign(s, { api, base, savedEls: ex.hashElementsVersion(els).toString(), savedApp: JSON.stringify(WHITE) });
  // open() knows the files of this already-saved scene are on the bridge, even if a local download failed.
  const uploaded = (s as unknown as { uploaded: Set<string> }).uploaded;
  for (const e of els) if (e.type === 'image' && e.fileId) uploaded.add(e.fileId);
  const f: Fake = {
    api,
    elements: () => elements,
    app: () => appState,
    draw: (next) => {
      elements = next;
      internal.changed();
    },
    setBackground: (c) => {
      appState = { ...appState, viewBackgroundColor: c };
      internal.changed();
    },
  };
  return { s, f };
}

/** The bridge's save: answers the next version, after `hold` when one is given. */
function bridgeSaves(start: number, hold?: () => Promise<void>): void {
  let v = start;
  let first = true;
  net.saveBoard.mockImplementation(async () => {
    if (first && hold) await hold();
    first = false;
    v++;
    return { ok: true, data: { floor: FLOOR, version: v, author: 'Theo', at: 1, render_version: v, render: true, stale: false, stale_pins: [] } };
  });
}

const posted = () => net.saveBoard.mock.calls.map((c) => c[2] as { base: number; scene: { elements: OrderedExcalidrawElement[]; appState: Record<string, unknown> }; render: Blob });

function board(version: number, elements: readonly ExcalidrawElement[], appState: Record<string, unknown> = WHITE) {
  return { ok: true, data: { version, state: { floor: FLOOR, version, author: 'Nibble', at: 1, render_version: version, render: true, stale: false, stale_pins: [] }, scene: { type: 'excalidraw', version: 2, elements, appState }, files: {}, history: [] } };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

let open: Session[] = [];
beforeEach(() => {
  net.saveBoard.mockReset();
  net.getBoard.mockReset();
  net.putFile.mockClear();
  renderHold = null;
  open = [];
  localStorage.clear();
  drafts.dropDraft(drafts.draftKey(WS, FLOOR)); // the memory copy outlives localStorage.clear()
});
afterEach(() => {
  for (const s of open) s.dispose('discard');
  vi.unstubAllGlobals();
});

describe('BoardSession', () => {
  it('saves a background change on its own, and takes the remote one in a merge (WB-R1)', async () => {
    const els = make('a');
    const { s, f } = session(els, 1);
    open.push(s);
    expect(s.dirty).toBe(false);
    f.setBackground('#ff0000');
    expect(s.dirty).toBe(true);
    bridgeSaves(1);
    expect(await s.flush()).toBe(true);
    expect(posted()).toHaveLength(1);
    expect(posted()[0]?.scene.appState.viewBackgroundColor).toBe('#ff0000');
    expect(s.dirty).toBe(false);

    // Another client set the grid and a green background: unchanged here, so theirs is taken, and nothing to save.
    net.getBoard.mockResolvedValue(board(3, els, { ...WHITE, viewBackgroundColor: '#00ff00', gridModeEnabled: true }));
    await s.merge();
    expect(f.app()).toMatchObject({ viewBackgroundColor: '#00ff00', gridModeEnabled: true });
    expect(s.dirty).toBe(false);

    // Changed here and not saved yet: ours stays over theirs, and is saved on their version.
    f.setBackground('#0000ff');
    net.getBoard.mockResolvedValue(board(4, els, { ...WHITE, viewBackgroundColor: '#ffff00' }));
    await s.merge();
    expect(f.app().viewBackgroundColor).toBe('#0000ff');
    bridgeSaves(4);
    expect(await s.flush()).toBe(true);
    expect(posted().at(-1)).toMatchObject({ base: 4, scene: { appState: { viewBackgroundColor: '#0000ff' } } });
  }, 30_000);

  it('drains on close: a stroke drawn while a save is in flight is saved before it closes (WB-R2)', async () => {
    const [a, b] = make('a', 'b') as [OrderedExcalidrawElement, OrderedExcalidrawElement];
    const { s, f } = session([a], 1);
    open.push(s);
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    bridgeSaves(1, () => held);
    f.draw([ex.newElementWith(a, { x: 10 }) as OrderedExcalidrawElement]);
    const first = s.save();
    await until(() => net.saveBoard.mock.calls.length === 1);
    f.draw([...f.elements(), b]);
    const closing = s.flush();
    release();
    await first;
    expect(await closing).toBe(true);
    expect(posted().map((p) => ids(p.scene.elements))).toEqual([['a'], ['a', 'b']]);
    expect(posted()[1]?.base).toBe(2);
    expect(s.dirty).toBe(false);
  }, 30_000);

  it('posts one snapshot: the render is of the scene it sends, and a merge meanwhile restarts the round (WB-R3)', async () => {
    const [a, b, pin] = make('a', 'b', 'pin') as [OrderedExcalidrawElement, OrderedExcalidrawElement, OrderedExcalidrawElement];
    const { s, f } = session([a], 1);
    open.push(s);
    bridgeSaves(1);

    // A stroke while the PNG is being made: the first save sends and shows the scene without it, the next one with it.
    let release = () => {};
    renderHold = new Promise<void>((r) => (release = r));
    f.draw([ex.newElementWith(a, { x: 10 }) as OrderedExcalidrawElement]);
    const saving = s.save();
    await until(() => vi.mocked(ex.exportToBlob).mock.calls.length > 0);
    f.draw([...f.elements(), b]);
    renderHold = null;
    release();
    await saving;
    expect(await s.flush()).toBe(true);
    for (const p of posted()) expect(await p.render.text()).toBe(ids(p.scene.elements).join(','));
    expect(posted().map((p) => ids(p.scene.elements))).toEqual([['a'], ['a', 'b']]);

    // An agent's pin is merged while a save's PNG is being made: that save is not posted on the base the merge
    // brought (it would drop the pin); the round starts over and the pin is in what is sent.
    const onBridge = f.elements(); // version 3
    net.saveBoard.mockClear();
    vi.mocked(ex.exportToBlob).mockClear();
    bridgeSaves(4);
    renderHold = new Promise<void>((r) => (release = r));
    f.draw(f.elements().map((e) => (e.id === 'b' ? (ex.newElementWith(e, { x: 400 }) as OrderedExcalidrawElement) : e)));
    const again = s.save();
    await until(() => vi.mocked(ex.exportToBlob).mock.calls.length > 0);
    net.getBoard.mockResolvedValue(board(4, [...onBridge, pin]));
    await s.merge();
    expect(ids(f.elements()).sort()).toEqual(['a', 'b', 'pin']);
    renderHold = null;
    release();
    await again;
    expect(await s.flush()).toBe(true);
    expect(posted().length).toBeGreaterThan(0);
    for (const p of posted()) {
      expect(p.base).toBe(4);
      expect(ids(p.scene.elements).sort()).toEqual(['a', 'b', 'pin']);
      expect(await p.render.text()).toBe(ids(p.scene.elements).join(','));
    }
    // b's local edit won over the board's older b.
    expect(posted().at(-1)?.scene.elements.find((e) => e.id === 'b')?.x).toBe(400);
  }, 30_000);

  it('freezes elements that Excalidraw mutates while a save renders (#32)', async () => {
    const { s, f } = session(make('a'), 1);
    open.push(s);
    bridgeSaves(1);
    f.draw(f.elements().map((e) => ex.newElementWith(e, { x: 10 })));
    let release = () => {};
    renderHold = new Promise<void>((r) => (release = r));
    const rendering = vi.mocked(ex.exportToBlob).mock.calls.length;
    const saving = s.save();
    await until(() => vi.mocked(ex.exportToBlob).mock.calls.length > rendering);
    ex.mutateElement(f.elements()[0]!, { x: 20 }, false);
    f.draw(f.elements());
    renderHold = null;
    release();
    await saving;
    expect(posted()[0]?.scene.elements[0]?.x).toBe(10);
    expect(await s.flush()).toBe(true);
    expect(posted()[1]?.scene.elements[0]?.x).toBe(20);
  }, 30_000);

  it.each(['file id', 'binary data'])('waits for a pasted image’s %s before a close saves it (#32)', async (pending) => {
    const statuses: BoardStatus[] = [];
    const { s, f } = session(make('a'), 1, statuses);
    open.push(s);
    const fileId = 'a'.repeat(64);
    const [image] = ex.convertToExcalidrawElements([{ type: 'image', id: 'paste', fileId: (pending === 'binary data' ? fileId : null) as BinaryFileData['id'], x: 200, y: 0, width: 20, height: 20 }], { regenerateIds: false }) as OrderedExcalidrawElement[];
    f.draw([...f.elements(), image!]);
    const missing: string[] = [];
    net.saveBoard.mockImplementation(async (_ws, _floor, request) => {
      const uploaded = new Set(net.putFile.mock.calls.map((c) => c[2] as string));
      const refs = (request.scene.elements as ExcalidrawElement[]).filter((e) => e.type === 'image' && e.fileId && !uploaded.has(e.fileId));
      missing.push(...refs.map((e) => (e as { fileId: string }).fileId));
      return refs.length
        ? { ok: false, code: 'whiteboard_missing_file', message: 'upload it first' }
        : { ok: true, data: { floor: FLOOR, version: net.saveBoard.mock.calls.length + 1, author: 'Theo', at: 1, render_version: net.saveBoard.mock.calls.length + 1, render: true, stale: false, stale_pins: [] } };
    });
    const rendering = vi.mocked(ex.exportToBlob).mock.calls.length;
    const closing = s.flush();
    await until(() => statuses.some((status) => status.kind === 'saving'));
    expect(vi.mocked(ex.exportToBlob).mock.calls.length, 'an incomplete paste must not be reported saved or closed').toBe(rendering);
    expect(net.saveBoard).not.toHaveBeenCalled();
    // initializeImage() mutates the existing scene element and then adds its binary data.
    ex.mutateElement(image! as ExcalidrawImageElement, { fileId: fileId as BinaryFileData['id'] }, false);
    s.excalidraw!.addFiles([{ id: fileId as BinaryFileData['id'], mimeType: 'image/png', dataURL: 'data:image/png;base64,AA==' as BinaryFileData['dataURL'], created: 1 }]);
    // Keep this test focused on the save snapshot; this file is already canonical.
    (s as unknown as { canon: Map<string, string> }).canon.set(fileId, fileId);
    expect(await closing).toBe(true);
    expect(missing, 'a save must never fail with whiteboard_missing_file after a paste mutates its snapshot').toEqual([]);
    expect(posted()).toHaveLength(1);
    expect(net.putFile).toHaveBeenCalledTimes(1);
    expect(posted()[0]?.scene.elements.find((e) => e.id === 'paste')).toMatchObject({ fileId });
    expect(s.dirty).toBe(false);
  }, 30_000);

  it('can still save when a bridge-owned image fails to download locally (#32)', async () => {
    const fileId = 'a'.repeat(64);
    const els = ex.convertToExcalidrawElements([{ type: 'image', id: 'existing', fileId: fileId as BinaryFileData['id'], x: 0, y: 0, width: 20, height: 20 }]) as OrderedExcalidrawElement[];
    const { s, f } = session(els, 1);
    open.push(s);
    (s as unknown as { uploaded: Set<string> }).uploaded.clear();
    const remote = board(1, els);
    Object.assign(remote.data.files, { [fileId]: { mimeType: 'image/png', size: 1, created: 1 } });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    expect(await (s as unknown as { fetchFiles(data: unknown): Promise<BinaryFileData[]> }).fetchFiles(remote.data)).toEqual([]);
    f.setBackground('#ff0000');
    bridgeSaves(1);
    expect(await s.flush()).toBe(true);
    expect(net.putFile).not.toHaveBeenCalled();
    expect(posted()[0]?.scene.appState.viewBackgroundColor).toBe('#ff0000');
  }, 30_000);

  it('a close that cannot save says so, and keeps a draft unless told to discard (WB-U1)', async () => {
    const [a, b] = make('a', 'b') as [OrderedExcalidrawElement, OrderedExcalidrawElement];
    const statuses: BoardStatus[] = [];
    const { s, f } = session([a], 1, statuses);
    net.saveBoard.mockResolvedValue({ ok: false, code: 'internal', message: 'HTTP 503' });
    f.draw([a, b]);
    expect(await s.flush()).toBe(false);
    expect(statuses.at(-1)).toEqual({ kind: 'error', message: 'HTTP 503' });
    s.dispose('draft');
    const key = drafts.draftKey(WS, FLOOR);
    expect(ids(drafts.readDraft(key)?.elements as ExcalidrawElement[])).toEqual(['a', 'b']);
    expect(localStorage.getItem(`h3d.wb.draft.${key}`)).toContain('"id":"b"');
    expect(key).not.toContain('token');

    const other = session([a], 1);
    other.f.draw([a, b]);
    other.s.dispose('discard');
    expect(drafts.readDraft(key)).toBeNull();
    expect(localStorage.getItem(`h3d.wb.draft.${key}`)).toBeNull();
  }, 30_000);

  it('a late save of a restored session keeps the newer draft a close kept meanwhile (WB-U1, pass 2 repro)', async () => {
    const [a, b, c] = make('a', 'restored', 'new') as [OrderedExcalidrawElement, OrderedExcalidrawElement, OrderedExcalidrawElement];
    const key = drafts.draftKey(WS, FLOOR);
    const { s, f } = session([a], 1);
    open.push(s);
    // open() reconciled a kept draft [a, restored] into the board and set restored, before its first save.
    drafts.keepDraft(key, { v: 1, at: 1, elements: [a, b], files: [], appState: null });
    Object.assign(s, { restored: true });
    f.draw([a, b]);
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    bridgeSaves(1, () => gate);
    const saving = s.save();
    await until(() => posted().length === 1);
    // Drawn while that save is held; the close runs out of time and the user keeps a draft.
    f.draw([a, b, c]);
    expect(await s.flush(10)).toBe(false);
    s.dispose('draft');
    expect(ids(drafts.readDraft(key)?.elements as ExcalidrawElement[])).toEqual(['a', 'restored', 'new']);
    release();
    await saving;
    expect(ids(posted()[0]?.scene.elements ?? [])).toEqual(['a', 'restored']);
    // The bridge has [a, restored] only: the kept draft (memory and storage) is what still has `new`.
    expect(ids(drafts.readDraft(key)?.elements as ExcalidrawElement[])).toEqual(['a', 'restored', 'new']);
    expect(localStorage.getItem(`h3d.wb.draft.${key}`)).toContain('"id":"new"');
    expect(posted()).toHaveLength(1);
  }, 30_000);

  it('a restored draft goes once a save has all of it, not before (WB-U1)', async () => {
    const [a, b, c] = make('a', 'restored', 'new') as [OrderedExcalidrawElement, OrderedExcalidrawElement, OrderedExcalidrawElement];
    const key = drafts.draftKey(WS, FLOOR);
    const { s, f } = session([a], 1);
    open.push(s);
    // A draft with more than this session shows (kept by a close in another tab after this one opened, say).
    drafts.keepDraft(key, { v: 1, at: 1, elements: [a, b, c], files: [], appState: { ...WHITE, viewBackgroundColor: '#123456' } });
    Object.assign(s, { restored: true });
    f.draw([a, b]);
    bridgeSaves(1);
    expect(await s.flush()).toBe(true);
    expect(drafts.readDraft(key), 'the save lacks `new` and the background: the draft stays').not.toBeNull();
    f.draw([a, b, c]);
    expect(await s.flush()).toBe(true);
    expect(drafts.readDraft(key), 'still not its background').not.toBeNull();
    f.setBackground('#123456');
    expect(await s.flush()).toBe(true);
    expect(drafts.readDraft(key)).toBeNull();
    expect(localStorage.getItem(`h3d.wb.draft.${key}`)).toBeNull();
  }, 30_000);

  it('a session closed during a save posts nothing more (discarded changes are not saved behind the user)', async () => {
    const [a, b] = make('a', 'b') as [OrderedExcalidrawElement, OrderedExcalidrawElement];
    const { s, f } = session([a], 1);
    bridgeSaves(1);
    let release = () => {};
    renderHold = new Promise<void>((r) => (release = r));
    f.draw([a, b]);
    const saving = s.save();
    await until(() => vi.mocked(ex.exportToBlob).mock.calls.length > 0);
    s.dispose('discard');
    renderHold = null;
    release();
    await saving;
    expect(net.saveBoard).not.toHaveBeenCalled();
    expect(drafts.readDraft(drafts.draftKey(WS, FLOOR))).toBeNull();
  }, 30_000);

  it('an older merge waiting on an image does not replace a newer remote background (WB-R1, pass 2 repro)', async () => {
    const fileId = 'a'.repeat(64);
    const els = [...make('a'), ...ex.convertToExcalidrawElements([{ type: 'image', id: 'im', fileId: fileId as never, x: 200, y: 0, width: 20, height: 20 }], { regenerateIds: false })] as OrderedExcalidrawElement[];
    const { s, f } = session(els, 1);
    open.push(s);
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const meta = { [fileId]: { mimeType: 'image/png', size: 1, created: 1 } };
    const older = board(2, els, { ...WHITE, viewBackgroundColor: '#ff0000' });
    Object.assign(older.data.files, meta);
    let fetches = 0;
    Object.assign(s, {
      fetchFiles: async () => {
        if (++fetches === 1) await gate;
        return [{ id: fileId, mimeType: 'image/png', created: 1, dataURL: 'data:image/png;base64,AA==' }];
      },
    });
    const newer = board(3, els, { ...WHITE, viewBackgroundColor: '#00ff00' });
    Object.assign(newer.data.files, meta);
    net.getBoard.mockResolvedValueOnce(older).mockResolvedValueOnce(newer);
    const merging = s.merge();
    await until(() => fetches === 1);
    await s.merge();
    expect(f.app().viewBackgroundColor).toBe('#00ff00');
    release();
    await merging;
    expect(f.app().viewBackgroundColor, 'v2 must not overwrite v3').toBe('#00ff00');
    expect((s as unknown as { base: number }).base).toBe(3);
    expect(s.dirty).toBe(false);
  }, 30_000);

  it('a merge that started before a save landed does not take the base or the appState back (WB-R1)', async () => {
    const fileId = 'b'.repeat(64);
    const els = [...make('a'), ...ex.convertToExcalidrawElements([{ type: 'image', id: 'im', fileId: fileId as never, x: 200, y: 0, width: 20, height: 20 }], { regenerateIds: false })] as OrderedExcalidrawElement[];
    const { s, f } = session(els, 1);
    open.push(s);
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    // Another client's v2: a red background (and the image).
    const v2 = board(2, els, { ...WHITE, viewBackgroundColor: '#ff0000' });
    Object.assign(v2.data.files, { [fileId]: { mimeType: 'image/png', size: 1, created: 1 } });
    net.getBoard.mockResolvedValue(v2);
    let fetches = 0;
    Object.assign(s, {
      fetchFiles: async () => {
        if (++fetches === 1) await gate;
        return [{ id: fileId, mimeType: 'image/png', created: 1, dataURL: 'data:image/png;base64,AA==' }];
      },
    });
    // whiteboard.updated v2: the merge waits on the image bytes.
    s.remote(v2.data.state);
    await until(() => fetches === 1);
    // Meanwhile a blue background here: its save conflicts, merges v2 (keeping blue) and lands as v3.
    f.setBackground('#0000ff');
    let n = 0;
    net.saveBoard.mockImplementation(async () =>
      ++n === 1
        ? { ok: false, code: 'whiteboard_conflict', message: 'stale base' }
        : { ok: true, data: { floor: FLOOR, version: 3, author: 'Theo', at: 1, render_version: 3, render: true, stale: false, stale_pins: [] } },
    );
    expect(await s.flush()).toBe(true);
    expect(posted().map((p) => p.base)).toEqual([1, 2]);
    expect((s as unknown as { base: number }).base).toBe(3);
    release();
    await until(() => fetches >= 2);
    await new Promise((r) => setTimeout(r, 20));
    expect(f.app().viewBackgroundColor).toBe('#0000ff');
    expect((s as unknown as { base: number }).base).toBe(3);
    expect(s.dirty).toBe(false);
  }, 30_000);
});
