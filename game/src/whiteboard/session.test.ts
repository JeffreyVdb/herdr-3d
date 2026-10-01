// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExcalidrawElement, OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
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
let net: { getBoard: ReturnType<typeof vi.fn>; saveBoard: ReturnType<typeof vi.fn> };
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
  let appState: Record<string, unknown> = { ...WHITE, selectedElementIds: {}, activeTool: { type: 'selection' } };
  const internal = s as unknown as { changed(): void };
  const api = {
    getSceneElementsIncludingDeleted: () => elements,
    getSceneElements: () => elements.filter((e) => !e.isDeleted),
    getAppState: () => appState,
    getFiles: () => ({}),
    addFiles: () => {},
    updateScene: (u: { elements?: readonly OrderedExcalidrawElement[]; appState?: Record<string, unknown> }) => {
      if (u.elements) elements = u.elements;
      if (u.appState) appState = { ...appState, ...u.appState };
    },
  };
  Object.assign(s, { api, base, savedEls: ex.hashElementsVersion(els).toString(), savedApp: JSON.stringify(WHITE) });
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
  renderHold = null;
  open = [];
  localStorage.clear();
});
afterEach(() => {
  for (const s of open) s.dispose('discard');
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
});
