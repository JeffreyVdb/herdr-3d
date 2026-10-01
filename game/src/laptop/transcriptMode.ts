import type { CommandResult } from '../net/client';
import type { AnswerAskAck, Ask, CommandArgs, ImageRef, PromptAck, Question, TranscriptItem, TranscriptWatchAck } from '../net/protocol';
import type { Uploader } from '../ui/composer/draft';
import { failureText } from '../ui/messages';
import type { ViewPrefs } from '../ui/themePrefs';
import { MAX_PROMPT } from './keys';
import type { mountTranscript, TranscriptRenderHost, TranscriptView } from './transcriptRender';
import type { ImageFeed } from './imageFeed';
import type { ImagesTabHost, ImagesTabView, MountImagesTab } from './imagesTab';
import { itemsOf, type TimelineOf } from './transcriptWatches';
import { activityCue, reconcile, SENT_TIMEOUT_MS, topSeq, type ActivityCue, type PendingPrompt } from './transcriptActivity';

export type { ImagesTabHost, ImagesTabView, MountImagesTab, TranscriptRenderHost, TranscriptView };

/** The render module's entry (`transcriptRender.ts`): what the seated view mounts in its overlay. */
export type MountTranscript = typeof mountTranscript;

/** The render module, loaded on the first switch to the transcript (it brings markdown, sanitising and highlighting along). */
export async function loadRenderer(): Promise<MountTranscript | null> {
  const mod = await import('./transcriptRender');
  return typeof mod.mountTranscript === 'function' ? mod.mountTranscript : null;
}

/** The images tab's module, loaded on the first switch to it. */
export async function loadImagesTab(): Promise<MountImagesTab | null> {
  const mod = await import('./imagesTab');
  return typeof mod.mountImagesTab === 'function' ? mod.mountImagesTab : null;
}

/**
 * What you look at while seated: the live terminal, the worker's conversation drawn over the monitor, or (M16 phase 2)
 * every image of the session, split into what you sent and what the agent viewed or made.
 */
export type SeatMode = 'terminal' | 'transcript' | 'images';

/** The two ways to read: the modes the overlay shows. */
export type ReadMode = Exclude<SeatMode, 'terminal'>;

/** The Conversation | Images strip that sits in the bar of both views. */
export interface SeatTabs {
  /** A fresh strip (one per view: an element has one place); they stay in step through `update`. */
  create(): HTMLElement;
  update(active: ReadMode, images: number | null): void;
  dispose(): void;
}

/** The overlay's box over the monitor, in CSS px of the viewport. */
export interface OverlayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TranscriptModeHost {
  send<T extends 'worker.prompt' | 'worker.answer' | 'worker.answer_ask' | 'transcript.page'>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  /** M16 phase 2: the images of a worker's transcript (thumbnails, full images, the session list). */
  feed(id: string): ImageFeed | null;
  /** Loads the render module (`loadRenderer`; tests pass a fake). */
  renderer(): Promise<MountTranscript | null>;
  /** Loads the images tab (`loadImagesTab`; none: the tab is not there and the mode stays the conversation). */
  imagesRenderer?(): Promise<MountImagesTab | null>;
  /** A child of the overlay for one view (both views are in it, one shown). None: the view takes the overlay itself. */
  pane?(box: HTMLElement): HTMLElement;
  /** The tab strip; `pick` switches the view. */
  tabs?(pick: (mode: ReadMode) => void): SeatTabs;
  /** A new, empty, hidden overlay element in the HUD; the controller removes it (`remove()`). */
  overlay(): HTMLElement;
  /** Where the last mode per worker is kept (null: nowhere, it lasts until the page reloads). */
  storage: Storage | null;
  /** #64: one image to Drop Zone, for the prompt box (none: a pasted image says it cannot go up). */
  upload?: Uploader;
  /** The seat bar's note. */
  status(kind: 'ok' | 'error', text: string | null): void;
  /** The mode changed (the seat bar's toggle, the terminal watch's fps, the monitor's frame). */
  modeChanged(mode: SeatMode): void;
  /** #59: the preset, hidden tool calls and the zoom (the view's top strip sets them). */
  prefs?: ViewPrefs;
  /** #58: the clock of the pending prompts' "not seen yet" hint (default Date.now; tests pass their own). */
  now?(): number;
}

/** Remembered per worker: the ones last read in transcript mode (terminal is the default), newest last. */
const MODES_KEY = 'h3d.seat.transcript';
/** Remembered per worker: of those, the ones whose last view was the images tab. */
const IMAGES_KEY = 'h3d.seat.images';
/** Older pages read to find a message the images tab points at: 20 x 200 items. */
const REVEAL_PAGES = 20;
const REVEAL_LIMIT = 200;
/** The list of images is asked again this long after the last change (a push with an image). */
const RELIST_MS = 300;
const MODES_MAX = 64;
/** How many of a subagent's items its nested timeline shows (the newest; the bridge's most). */
const SUBAGENT_LIMIT = 500;

function readModes(s: Storage | null, key = MODES_KEY): string[] {
  try {
    const v: unknown = JSON.parse(s?.getItem(key) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeModes(s: Storage | null, ids: string[], key = MODES_KEY): void {
  try {
    if (ids.length) s?.setItem(key, JSON.stringify(ids.slice(-MODES_MAX)));
    else s?.removeItem(key);
  } catch {
    /* not remembered past this page */
  }
}

const bytes = (s: string) => new TextEncoder().encode(s).length;
const questionKey = (q: Question | null) => (q ? `${q.hash}\u0000${q.selected ?? ''}\u0000${q.text}\u0000${q.excerpt.join('\n')}` : '');

interface Sitting {
  id: string;
  name: string;
  /** Tells a late answer (a render module loading, a prompt's ack) for an earlier seat from this one. */
  gen: number;
  mode: SeatMode;
  /** The timeline as the bridge sent it: the watch's items, then pushes (by `id`). */
  items: TranscriptItem[];
  index: Map<string, number>;
  question: Question | null;
  questionKey: string;
  /** #57: the worker's ask, and its tool_use_id + since (so a new one is told from the same one). */
  ask: Ask | null;
  askKey: string;
  box: HTMLElement | null;
  view: TranscriptView | null;
  /** The panes the two views are in (the overlay itself when the host makes none). */
  viewPane: HTMLElement | null;
  tabPane: HTMLElement | null;
  tab: ImagesTabView | null;
  /** The render module is loading for this seat. */
  mounting: boolean;
  mountingTab: boolean;
  /** The view read last (what Ctrl+Esc goes back to). */
  reading: ReadMode;
  /** Where the next page of older items starts, and whether there is one (from the watch's head). */
  cursor: string;
  hasMore: boolean;
  /** A message to scroll to once the conversation is up (the images tab's "jump to message"). */
  reveal: string | null;
  revealing: boolean;
  /** The feed listener and the debounce that asks for the list again. */
  unsub: (() => void) | null;
  relist: ReturnType<typeof setTimeout> | null;
  /** How many distinct images the session has (null: not asked yet). */
  imageCount: number | null;
  tabs: SeatTabs | null;
  /** Focus was asked for while the overlay was not placed yet (invisible: the browser ignores focus there). */
  focusLater: boolean;
  /** #58: the worker's status as the store has it (null: not seen yet) and since when (the bridge's clock). */
  status: string | null;
  since: number;
  /** The current turn starts after this `seq` (null: you sat down while it worked, the last item is taken as it is). */
  mark: number | null;
  /** The timeline's top when you sent a prompt to a worker not at work: its turn starts there. */
  sendMark: number | null;
  /** The prompts sent from the view that the transcript has not shown yet (and refused ones, until the next send). */
  pending: readonly PendingPrompt[];
  /** The `user` items that took a pending prompt (`reconcile`'s `taken`): a resync sends them again, they take no other. */
  taken: Set<string>;
  /** The transcript the `seq`s (and so `taken` and the marks) are of: `harness/session`, the bridge's key (null: no ack yet). */
  timeline: string | null;
  /** What the view was last told of the cue (it is recomputed only when this changes). */
  cueKey: string;
  cueDirty: boolean;
}

/**
 * M16: the seated view's second mode. Keeps the transcript of the worker you
 * sit at (fed by `TranscriptWatches` from the moment you sit, so the first
 * Ctrl+Esc shows it at once), mounts the render module in a DOM overlay over
 * the monitor on the first switch to it, and hides the overlay when you go
 * back to the terminal. Standing up destroys the view and removes the
 * overlay. The mode is remembered per worker (localStorage, guarded).
 */
export class TranscriptMode {
  private s: Sitting | null = null;
  private gen = 0;
  /** Views mounted and destroyed, overlays made and removed (test hook: nothing may be left over). */
  readonly counts = { mounted: 0, destroyed: 0, overlays: 0, removed: 0, tabsMounted: 0, tabsDestroyed: 0 };
  private rect: OverlayRect | null = null;
  /** Numbers the pending prompts. */
  private pid = 0;

  constructor(private readonly host: TranscriptModeHost) {}

  private now(): number {
    return this.host.now?.() ?? Date.now();
  }

  get seated(): string | null {
    return this.s?.id ?? null;
  }

  get mode(): SeatMode {
    return this.s?.mode ?? 'terminal';
  }

  /** The overlay is up (the conversation or the images, seated). */
  get shown(): boolean {
    return !!this.s && this.s.mode !== 'terminal';
  }

  /** The overlay element while there is one (for focus checks). */
  get box(): HTMLElement | null {
    return this.s?.box ?? null;
  }

  get itemCount(): number {
    return this.s?.items.length ?? 0;
  }

  /** The images tab is mounted (test hook). */
  get tabMounted(): boolean {
    return !!this.s?.tab;
  }

  /** How many distinct images the tab strip counts (null: not known). */
  get imageCount(): number | null {
    return this.s?.imageCount ?? null;
  }

  /** You sat at `id`: its last mode comes back (`canRead` false: the bridge has no transcripts, the terminal it is). */
  sit(id: string, name: string, canRead = true): void {
    this.stand();
    const wasReading = canRead && readModes(this.host.storage).includes(id);
    const last: ReadMode = wasReading && this.host.imagesRenderer && readModes(this.host.storage, IMAGES_KEY).includes(id) ? 'images' : 'transcript';
    this.s = {
      id, name, gen: ++this.gen, mode: 'terminal', items: [], index: new Map(), question: null, questionKey: '', ask: null, askKey: '', box: null, view: null,
      viewPane: null, tabPane: null, tab: null, mounting: false, mountingTab: false, reading: last, cursor: '', hasMore: false, reveal: null,
      revealing: false, unsub: null, relist: null, imageCount: null, tabs: null, focusLater: false, status: null, since: 0, mark: null, sendMark: null,
      pending: [], taken: new Set(), timeline: null, cueKey: '', cueDirty: true,
    };
    if (wasReading) this.setMode(last, false);
    else this.host.modeChanged('terminal');
  }

  /** You stood up: the view goes, the overlay with it. */
  stand(): void {
    const s = this.s;
    if (!s) return;
    this.s = null;
    this.rect = null;
    s.unsub?.();
    if (s.relist) clearTimeout(s.relist);
    if (s.view) {
      s.view.destroy();
      this.counts.destroyed++;
    }
    if (s.tab) {
      s.tab.destroy();
      this.counts.tabsDestroyed++;
    }
    s.tabs?.dispose();
    s.viewPane?.remove();
    s.tabPane?.remove();
    if (s.box) {
      s.box.remove();
      this.counts.removed++;
    }
  }

  /** Ctrl+Esc: the terminal, or the view you read last. */
  toggle(): void {
    if (this.s) this.setMode(this.s.mode === 'terminal' ? this.s.reading : 'terminal');
  }

  /** The key that flips the two ways to read (Conversation <-> Images). */
  flip(): void {
    const s = this.s;
    if (!s || s.mode === 'terminal') return;
    this.setMode(s.mode === 'transcript' ? 'images' : 'transcript');
  }

  setMode(mode: SeatMode, remember = true): void {
    const s = this.s;
    if (!s || s.mode === mode) return;
    // No images tab (an older shell, a module that did not load): the conversation.
    if (mode === 'images' && !this.host.imagesRenderer) mode = 'transcript';
    if (s.mode === mode) return;
    s.mode = mode;
    if (mode !== 'terminal') s.reading = mode;
    if (remember) {
      const ids = readModes(this.host.storage).filter((x) => x !== s.id);
      if (mode !== 'terminal') ids.push(s.id);
      writeModes(this.host.storage, ids);
      if (mode !== 'terminal') {
        const imgs = readModes(this.host.storage, IMAGES_KEY).filter((x) => x !== s.id);
        if (mode === 'images') imgs.push(s.id);
        writeModes(this.host.storage, imgs, IMAGES_KEY);
      }
    }
    if (mode !== 'terminal') this.show(s);
    else {
      s.focusLater = false;
      if (s.box) s.box.hidden = true;
    }
    // #58: the cue runs only while the conversation is up.
    this.cue(s, true);
    this.tabsChanged(s);
    this.host.modeChanged(mode);
  }

  private show(s: Sitting): void {
    if (!s.box) {
      s.box = this.host.overlay();
      this.counts.overlays++;
      this.applyRect(s.box);
    }
    s.box.hidden = false;
    this.watchImages(s);
    if (s.mode === 'images') return this.showTab(s);
    if (s.viewPane) s.viewPane.hidden = false;
    if (s.tabPane) s.tabPane.hidden = true;
    if (s.view) {
      this.focus();
      return;
    }
    if (s.mounting) return;
    s.mounting = true;
    const gen = s.gen;
    void this.host.renderer().then(
      (mount) => this.mounted(gen, mount),
      () => this.mounted(gen, null),
    );
  }

  private showTab(s: Sitting): void {
    if (s.viewPane) s.viewPane.hidden = true;
    if (s.tabPane) s.tabPane.hidden = false;
    if (s.tab) {
      s.tab.refresh();
      this.focus();
      return;
    }
    if (s.mountingTab) return;
    s.mountingTab = true;
    const gen = s.gen;
    const load = this.host.imagesRenderer as NonNullable<TranscriptModeHost['imagesRenderer']>;
    void load().then(
      (mount) => this.onTabMounted(gen, mount),
      () => this.onTabMounted(gen, null),
    );
  }

  private onTabMounted(gen: number, mount: MountImagesTab | null): void {
    const s = this.s;
    if (!s || s.gen !== gen || !s.box) return;
    s.mountingTab = false;
    if (!mount) {
      // Back to the conversation; the images are not there.
      if (s.mode === 'images') this.setMode('transcript', false);
      this.host.status('error', 'The images view did not load: try again.');
      return;
    }
    const pane = this.pane(s);
    s.tabPane = pane;
    pane.hidden = s.mode !== 'images';
    s.tab = mount(pane, this.tabHost(s));
    this.counts.tabsMounted++;
    if (s.mode === 'images') this.focus();
  }

  /** A child of the overlay for a view, or the overlay itself. */
  private pane(s: Sitting): HTMLElement {
    const box = s.box as HTMLElement;
    return this.host.pane ? this.host.pane(box) : box;
  }

  private tabsFor(s: Sitting): SeatTabs | null {
    if (!s.tabs && this.host.tabs) s.tabs = this.host.tabs((mode) => this.setMode(mode));
    return s.tabs;
  }

  private tabsChanged(s: Sitting): void {
    if (s.mode !== 'terminal') s.tabs?.update(s.mode, s.imageCount);
  }

  /** The list of images is kept fresh while you read: the strip's count and the images tab. */
  private watchImages(s: Sitting): void {
    if (s.unsub) return;
    const feed = this.host.feed(s.id);
    if (!feed) return;
    const ask = () => {
      void feed.list().then(
        (refs) => {
          if (this.s !== s) return;
          s.imageCount = distinctImages(refs);
          this.tabsChanged(s);
          if (s.mode === 'images') s.tab?.refresh();
        },
        () => {
          if (this.s === s) s.tab?.refresh();
        },
      );
    };
    s.unsub = feed.onChange(() => {
      if (s.relist) clearTimeout(s.relist);
      s.relist = setTimeout(() => {
        s.relist = null;
        if (this.s === s) ask();
      }, RELIST_MS);
    });
    ask();
  }

  private tabHost(s: Sitting): ImagesTabHost {
    const live = () => this.s === s;
    return {
      feed: this.host.feed(s.id),
      tabs: () => this.tabsFor(s)?.create() ?? null,
      jump: (ref) => {
        if (live()) void this.jump(ref);
      },
    };
  }

  /**
   * "Jump to message" from the images tab (or a print): the conversation, at the item the image is in, paging older
   * items in first when the watch's window did not reach it. False when it cannot be found.
   */
  async jump(ref: ImageRef): Promise<boolean> {
    const s = this.s;
    if (!s || !ref.item_id) return false;
    s.reveal = ref.item_id;
    this.setMode('transcript');
    if (s.view) return this.revealNow(s);
    return true; // done when the view mounts
  }

  private async revealNow(s: Sitting): Promise<boolean> {
    const id = s.reveal;
    const view = s.view;
    if (!id || !view || s.revealing) return false;
    s.revealing = true;
    try {
      for (let pages = 0; ; pages++) {
        if (this.s !== s) return false;
        if (s.index.has(id)) {
          if (!s.view?.hasItem(id)) s.view?.setItems([...s.items]);
          if (s.view?.scrollToItem(id)) {
            s.reveal = null;
            return true;
          }
        }
        if (!s.hasMore || pages >= REVEAL_PAGES) break;
        const r = await this.host.send('transcript.page', { id: s.id, before: s.cursor, limit: REVEAL_LIMIT });
        if (this.s !== s) return false;
        if (!r.ok) {
          this.host.status('error', failureText('transcript.page', r.code, r.message, { worker: s.name }));
          s.reveal = null;
          return false;
        }
        this.older(s, r.data);
      }
    } finally {
      s.revealing = false;
    }
    s.reveal = null;
    this.host.status('error', 'That message is too far back to show here.');
    return false;
  }

  /** An older page: merged into the timeline by `seq`. */
  private older(s: Sitting, data: unknown): void {
    const d = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
    const got = itemsOf(d.items);
    s.cursor = typeof d.cursor === 'string' && d.cursor ? d.cursor : s.cursor;
    s.hasMore = d.has_more === true && got.length > 0;
    const known = new Set(s.items.map((it) => it.id));
    const merged = [...got.filter((it) => !known.has(it.id)), ...s.items].sort((a, b) => a.seq - b.seq);
    s.items = merged;
    s.index = new Map(merged.map((it, i) => [it.id, i]));
    s.view?.setItems([...merged]);
  }

  private mounted(gen: number, mount: MountTranscript | null): void {
    const s = this.s;
    if (!s || s.gen !== gen || !s.box) return;
    s.mounting = false;
    if (!mount) {
      this.setMode('terminal', false);
      this.host.status('error', 'The transcript view did not load: try again.');
      return;
    }
    const pane = this.pane(s);
    s.viewPane = pane === s.box ? null : pane;
    if (s.viewPane) s.viewPane.hidden = s.mode !== 'transcript';
    s.view = mount(pane, this.renderHost(s));
    this.counts.mounted++;
    const strip = this.tabsFor(s);
    if (strip) {
      s.view.attachTabs(strip.create());
      this.tabsChanged(s);
    }
    s.view.setItems([...s.items]);
    if (s.question) s.view.setBlocked(s.question);
    if (s.ask) s.view.setAsk(s.ask);
    if (s.pending.length) s.view.setPending(s.pending);
    s.cueKey = '';
    this.cue(s, true);
    if (s.mode === 'transcript') this.focus();
    if (s.reveal) void this.revealNow(s);
  }

  private renderHost(s: Sitting): TranscriptRenderHost {
    const live = () => this.s === s;
    return {
      images: this.host.feed(s.id),
      upload: this.host.upload ?? null,
      label: s.name,
      ...(this.host.prefs ? { prefs: this.host.prefs } : {}),
      onPromptSubmit: (text) => {
        if (!live()) return Promise.resolve(false);
        const t = text.replace(/\u0000/g, '');
        if (!t.trim()) return Promise.resolve(false);
        if (bytes(t) > MAX_PROMPT) {
          this.host.status('error', 'That prompt is over 16 KiB: send less at a time.');
          return Promise.resolve(false);
        }
        // #58: one on its way at a time (a second Enter while it is sending sends nothing).
        if (s.pending.some((p) => p.state === 'sending')) return Promise.resolve(false);
        // #58: its row is in the timeline at once, until its `user` item comes; a refused one before it goes.
        const p: PendingPrompt = { id: `p${++this.pid}`, text: t, state: 'sending', late: false, mark: topSeq(s.items), due: null };
        s.pending = [...s.pending.filter((x) => x.state !== 'refused'), p];
        // To a worker not at work it starts a turn: that turn's items come after this.
        if (s.status !== 'working') s.sendMark = p.mark;
        this.pendingChanged(s);
        // Resolves whether it went: a refused prompt goes back in the box.
        return this.host.send('worker.prompt', { id: s.id, text: t }).then((r) => {
          if (!live()) return r.ok;
          if (r.ok) this.host.status('ok', `Sent to ${s.name}`);
          else this.host.status('error', failureText('worker.prompt', r.code, r.message, { worker: s.name }));
          const queued = r.ok && ((r.data ?? {}) as Partial<PromptAck>).queued === true;
          const now = this.now();
          // Already shown by its item (it can come before the ack): nothing to change.
          if (!s.pending.some((x) => x.id === p.id)) return r.ok;
          s.pending = s.pending.map((x): PendingPrompt => {
            if (x.id !== p.id) return x;
            if (!r.ok) return { ...x, state: 'refused', reason: failureText('worker.prompt', r.code, r.message, { worker: s.name }), due: null };
            // A queued prompt may wait for the whole turn: the hint only once the agent stopped working.
            return { ...x, state: queued ? 'queued' : 'sent', due: queued && s.status === 'working' ? null : now + SENT_TIMEOUT_MS };
          });
          this.pendingChanged(s);
          return r.ok;
        });
      },
      onDismissPending: (id) => {
        if (!live()) return;
        const left = s.pending.filter((x) => x.id !== id || x.state !== 'refused');
        if (left.length === s.pending.length) return;
        s.pending = left;
        this.pendingChanged(s);
      },
      onAnswer: (hash, choice, cancel) => {
        if (!live()) return;
        const args: CommandArgs['worker.answer'] | null = cancel ? { id: s.id, hash, cancel: true } : choice !== null ? { id: s.id, hash, choice } : null;
        if (!args) return;
        void this.host.send('worker.answer', args).then((r) => {
          if (!live() || r.ok) return;
          this.host.status('error', failureText('worker.answer', r.code, r.message, { worker: s.name }));
        });
      },
      onAnswerAsk: async (args) => {
        if (!live()) return { ok: false, code: 'stale', message: 'You got up.' };
        const r = await this.host.send('worker.answer_ask', { ...args, id: s.id });
        if (r.ok) {
          const ack = (r.data ?? {}) as Partial<AnswerAskAck>;
          if (live() && ack.resolved) this.host.status('ok', args.cancel ? `Dismissed ${s.name}’s question` : `Answered ${s.name}`);
          return { ok: true, resolved: ack.resolved === true };
        }
        const message = failureText('worker.answer_ask', r.code, r.message, { worker: s.name });
        if (live() && r.code !== 'stale') this.host.status('error', message);
        return { ok: false, code: r.code, message };
      },
      onSwitchToTerminal: () => {
        if (live()) this.setMode('terminal');
      },
      loadSubagent: async (agentId) => {
        // A subagent's own timeline: its newest page (the bridge finds <session>/subagents/agent-<id>.jsonl).
        const r = await this.host.send('transcript.page', { id: s.id, before: '', agent: agentId, limit: SUBAGENT_LIMIT });
        if (!r.ok) throw new Error(failureText('transcript.page', r.code, r.message, { worker: s.name }));
        const items = subagentItems(r.data);
        // Their images are the bridge's to serve (it authorized them in this page); the feed asks for nothing else, and
        // says whose log to read.
        this.host.feed(s.id)?.note(items, agentId);
        return items;
      },
    };
  }

  /** Focus to the transcript: its timeline once the view is up (so its scroll keys work at once), else the overlay. */
  focus(): void {
    const s = this.s;
    const b = s?.box;
    if (!s || !b || b.hidden) return;
    // Not on screen yet (the first frame has not placed it): once it is (applyRect).
    if (!this.rect) {
      s.focusLater = true;
      return;
    }
    s.focusLater = false;
    const view = s.mode === 'images' ? s.tab : s.view;
    if (view) view.focus();
    else if (typeof b.focus === 'function') b.focus({ preventScroll: true });
  }

  /** Enter in transcript mode: to the prompt box. */
  focusPrompt(): void {
    if (this.s?.mode === 'transcript') this.s.view?.focusPrompt();
  }

  // ---- the watch's sink ------------------------------------------------------------

  /** A watch's ack (the first, or a re-watch after `session_changed` / `resync`): the whole timeline, replaced. */
  reset(id: string, ack: TranscriptWatchAck): void {
    const s = this.s;
    if (s?.id !== id) return;
    this.timeline(s, ack);
    s.items = [...ack.items];
    s.index = new Map(s.items.map((it, i) => [it.id, i]));
    s.cursor = ack.cursor;
    s.hasMore = ack.has_more;
    s.view?.setItems([...s.items]);
    this.itemsChanged(s, s.items);
  }

  /** Live: new items and replacements, both by `id` (a new item already here replaces it). */
  push(id: string, items: TranscriptItem[], updates: TranscriptItem[], head?: TimelineOf): void {
    const s = this.s;
    if (s?.id !== id) return;
    if (head) this.timeline(s, head);
    const changed = [...items, ...updates];
    for (const it of changed) {
      const at = s.index.get(it.id);
      if (at !== undefined) s.items[at] = it;
      else {
        s.index.set(it.id, s.items.length);
        s.items.push(it);
      }
    }
    if (changed.length) s.view?.applyUpdates(changed);
    this.itemsChanged(s, changed);
  }

  /**
   * #58: another transcript (a new session while seated: /clear, /new, a resume) counts its `seq`s from 1 again, so
   * nothing marked in the old one holds. Its items are other items: one at the same place with the same words as one
   * that took a prompt is a new echo. A prompt still waiting was sent before the switch, so its item may be anywhere in
   * the new timeline (the send that started the session, one just after it). Where the turn started is not known: the
   * last item is taken as it is, and the next start of work marks the new timeline's top. A resync of the same
   * transcript keeps it all (its items are the ones already seen).
   */
  private timeline(s: Sitting, head: TimelineOf): void {
    const key = `${head.harness}/${head.session}`;
    if (key === s.timeline) return;
    const first = s.timeline === null;
    s.timeline = key;
    if (first) return;
    s.taken = new Set();
    if (s.pending.some((p) => p.mark !== 0)) s.pending = s.pending.map((p) => (p.mark !== 0 ? { ...p, mark: 0 } : p));
    s.mark = null;
    s.sendMark = null;
  }

  /** #58: prompts their items show are no longer pending, and what the agent does may read otherwise. */
  private itemsChanged(s: Sitting, items: readonly TranscriptItem[]): void {
    const left = reconcile(s.pending, items, s.taken);
    if (left !== s.pending) {
      s.pending = left;
      this.pendingChanged(s);
    }
    s.cueDirty = true;
    this.cue(s);
  }

  private pendingChanged(s: Sitting): void {
    s.view?.setPending(s.pending);
    s.cueDirty = true;
    this.cue(s);
  }

  /**
   * #58: the seated worker's status, every frame (from the store). A turn starts when it becomes `working` (not when it
   * comes back from `blocked`: that is the same turn); a pending prompt's "not seen yet" hint shows once it is due.
   */
  activity(status: string, since: number | null): void {
    const s = this.s;
    if (!s) return;
    const now = this.now();
    if (status !== s.status || (since ?? s.since) !== s.since) {
      const was = s.status;
      if (status === 'working' && was !== 'working' && was !== null && was !== 'blocked') s.mark = s.sendMark ?? topSeq(s.items);
      if (status === 'working') s.sendMark = null;
      // The turn a queued prompt waited for is over: now it should show soon.
      if (was === 'working' && status !== 'working' && s.pending.some((p) => p.state === 'queued' && p.due === null)) {
        s.pending = s.pending.map((p) => (p.state === 'queued' && p.due === null ? { ...p, due: now + SENT_TIMEOUT_MS } : p));
        s.view?.setPending(s.pending);
      }
      s.status = status;
      s.since = since ?? now;
      s.cueDirty = true;
    }
    if (s.pending.some((p) => !p.late && p.due !== null && now >= p.due)) {
      s.pending = s.pending.map((p) => (!p.late && p.due !== null && now >= p.due ? { ...p, late: true } : p));
      s.view?.setPending(s.pending);
    }
    this.cue(s);
  }

  /**
   * The cue goes to the view only when it changes, and only while it can be seen: the conversation up and placed on the
   * screen, no question pinned (the card is what the agent waits on). Anything else takes it out of the DOM.
   */
  private cue(s: Sitting, force = false): void {
    if (!s.view || (!s.cueDirty && !force)) return;
    s.cueDirty = false;
    const seen = s.mode === 'transcript' && !!this.rect && !s.ask;
    const cue: ActivityCue | null = seen && s.status ? activityCue(s.items, s.status, s.since, s.mark) : null;
    const key = cue ? `${cue.kind}@${cue.since}` : '';
    if (key === s.cueKey) return;
    s.cueKey = key;
    s.view.setActivity(cue);
  }

  /** The cue as the view was last told it (test hook): `thinking@<since>`, or '' for none. */
  get cueState(): string {
    return this.s?.cueKey ?? '';
  }

  /** The pending prompts (test hook). */
  get pending(): readonly PendingPrompt[] {
    return this.s?.pending ?? [];
  }

  /** The watch ended for good (`worker_removed`, `asleep`, the connection): the overlay goes back to the terminal. */
  stop(id: string): void {
    const s = this.s;
    if (s?.id !== id) return;
    if (s.mode !== 'terminal') this.setMode('terminal', false);
  }

  /** The worker's blocked question (from the store; null when it is not blocked). */
  blocked(q: Question | null): void {
    const s = this.s;
    if (!s) return;
    const key = questionKey(q);
    if (key === s.questionKey) return;
    s.questionKey = key;
    s.question = q;
    s.view?.setBlocked(q);
  }

  /** #57: the worker's ask (from the store; null when there is none). */
  asked(ask: Ask | null): void {
    const s = this.s;
    if (!s) return;
    const key = ask ? `${ask.tool_use_id}\u0000${JSON.stringify(ask.questions)}` : '';
    if (key === s.askKey) return;
    s.askKey = key;
    s.ask = ask;
    s.view?.setAsk(ask);
    this.cue(s, true);
  }

  /** The seated worker's ask, while it waits on one. */
  get ask(): Ask | null {
    return this.s?.ask ?? null;
  }

  /** Where the monitor's screen is this frame (null: off the view). */
  place(rect: OverlayRect | null): void {
    const same = (a: OverlayRect | null, b: OverlayRect | null) => a === b || (!!a && !!b && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height);
    if (same(rect, this.rect)) return;
    const shown = !!this.rect;
    this.rect = rect;
    if (this.s?.box) this.applyRect(this.s.box);
    // Off the view (or back on it): the cue stops (or runs again).
    if (this.s && shown !== !!rect) this.cue(this.s, true);
  }

  private applyRect(b: HTMLElement): void {
    const r = this.rect;
    if (!r) {
      b.style.visibility = 'hidden';
      return;
    }
    b.style.visibility = '';
    b.style.left = `${r.left}px`;
    b.style.top = `${r.top}px`;
    b.style.width = `${r.width}px`;
    b.style.height = `${r.height}px`;
    if (this.s?.focusLater && this.s.box === b) this.focus();
  }
}

/** A `transcript.page` ack for a subagent (`TranscriptPageAck`): its items, oldest first. */
export function subagentItems(data: unknown): TranscriptItem[] {
  if (typeof data !== 'object' || data === null) return [];
  return itemsOf((data as Record<string, unknown>).items);
}

/** How many different images a session has: the same bytes twice are one; a path that was not opened counts by its path. */
export function distinctImages(refs: readonly ImageRef[]): number {
  const seen = new Set<string>();
  let n = 0;
  for (const r of refs) {
    const key = r.hash ? `h:${r.origin}:${r.hash}` : `u:${r.origin}:${r.path ?? ''}:${r.item_id ?? n}`;
    seen.add(key);
    n++;
  }
  return seen.size;
}
