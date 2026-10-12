import type { CommandResult } from '../net/client';
import type { RepoSearchHost } from './repoSearch';
import type { PackupGate } from '../world/packup';
import type { AnswerAskAck, Ask, CommandArgs, Followup, HandoffCandidate, ImageRef, PromptAck, Question, TranscriptItem, TranscriptWatchAck, Usage, WorkerCodex } from '../net/protocol';
import type { Uploader } from '../ui/composer/draft';
import { failureText } from '../ui/messages';
import type { ViewPrefs } from '../ui/themePrefs';
import { MAX_PROMPT } from './keys';
import type { mountTranscript, TranscriptRenderHost, TranscriptView } from './transcriptRender';
import type { ImageFeed } from './imageFeed';
import type { ImagesTabHost, ImagesTabView, MountImagesTab } from './imagesTab';
import { itemsOf, type TimelineOf } from './transcriptWatches';
import { TranscriptDrafts } from './transcriptDrafts';
import { AsyncDrafts } from './asyncDrafts';
import { CommandCatalogs } from './commandCatalog';
import { activityCue, reconcile, SENT_TIMEOUT_MS, topSeq, type ActivityCue, type PendingPrompt } from './transcriptActivity';
import { handoffCommand, newOp } from '../world/handoff';

export type { ImagesTabHost, ImagesTabView, MountImagesTab, TranscriptRenderHost, TranscriptView };

/** The render module's entry (`transcriptRender.ts`): what the seated view mounts in its overlay. */
export type MountTranscript = typeof mountTranscript;

/** The render module, loaded when the transcript first shows (it brings markdown, sanitising and highlighting along). */
export async function loadRenderer(): Promise<MountTranscript | null> {
  const mod = await import('./transcriptRender');
  return typeof mod.mountTranscript === 'function' ? mod.mountTranscript : null;
}

/** The images tab's module, loaded when it first shows. */
export async function loadImagesTab(): Promise<MountImagesTab | null> {
  const mod = await import('./imagesTab');
  return typeof mod.mountImagesTab === 'function' ? mod.mountImagesTab : null;
}

/**
 * What you look at while seated: the live terminal, the worker's conversation drawn over the monitor, or (M16 phase 2)
 * every image of the session, split into what you sent and what the agent viewed or made.
 */
export type SeatMode = 'terminal' | 'transcript' | 'images';

/** #98: the harnesses whose transcripts the bridge reads (Claude Code, Codex); a seat at any other opens in the terminal. */
export const hasTranscript = (harness: string | undefined): boolean => harness === 'claude' || harness === 'codex';

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
  send<
    T extends 'worker.prompt' | 'worker.keys' | 'worker.answer' | 'worker.answer_ask' | 'worker.answer_followup' | 'worker.dismiss_followup' | 'worker.answer_async' | 'worker.dismiss_async' | 'transcript.page' | 'transcript.item' | 'worker.commands' | 'worker.files' | 'worker.repos',
  >(t: T, args: CommandArgs[T]): Promise<CommandResult>;
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
  /** #110: the pack-up check before a prompt goes (none: it goes at once). */
  packup?: PackupGate;
  /** The mode changed (the seat bar's toggle, the terminal watch's fps, the monitor's frame). */
  modeChanged(mode: SeatMode): void;
  /** #59: the preset, hidden tool calls and the zoom (the view's top strip sets them). */
  prefs?: ViewPrefs;
  /** #223: the inline Handoff button of a worker's reply was pressed: the filing dialog (none: no button). */
  handoff?(id: string, c: HandoffCandidate): void;
  /** #247: the shared "Repositories from other buildings" switch, for the prompt box's `@r:` (none: as if off). */
  repoRefs?: RepoSearchHost['refs'];
  /** #58: the clock of the pending prompts' "not seen yet" hint (default Date.now; tests pass their own). */
  now?(): number;
}

/** Remembered per worker: the ones last left in terminal mode (#98: the conversation is the default), newest last. */
const MODES_KEY = 'h3d.seat.terminal';
/** Before #98, the ones last read in transcript mode (terminal was the default): not read, and removed. */
const OLD_MODES_KEY = 'h3d.seat.transcript';
/** Remembered per worker: the ones whose last way to read was the images tab (not the conversation). */
const IMAGES_KEY = 'h3d.seat.images';
/** Older pages read to find a message the images tab points at: 20 x 200 items. */
const REVEAL_PAGES = 20;
const REVEAL_LIMIT = 200;
/** The list of images is asked again this long after the last change (a push with an image). */
const RELIST_MS = 300;
const MODES_MAX = 64;
/** How many of a subagent's items its nested timeline shows (the newest; the bridge's most). */
const SUBAGENT_LIMIT = 500;
/** #224: a command's outcome is not known (it may have run, or not gone at all): a retry must keep its op. */
const UNANSWERED = new Set(['timeout', 'disconnected', 'offline']);

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

/** #98: the list of before (who was read in transcript mode) says nothing now that the conversation is the default. */
function dropOldModes(s: Storage | null): void {
  try {
    s?.removeItem(OLD_MODES_KEY);
  } catch {
    /* nothing to drop */
  }
}

const bytes = (s: string) => new TextEncoder().encode(s).length;
const questionKey = (q: Question | null) => (q ? `${q.hash}\u0000${q.selected ?? ''}\u0000${q.text}\u0000${q.excerpt.join('\n')}` : '');

interface Sitting {
  id: string;
  name: string;
  /** #140: its harness (`claude`, `codex`; '' unknown), for the prompt box's commands. */
  harness: string;
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
  /** #90: the worker's follow-up questions, and their turn + questions (a new one told from the same one). */
  followup: Followup | null;
  followupKey: string;
  /** #223: the worker's handoff candidate (the inline button's), and its id + revision. */
  handoff: HandoffCandidate | null;
  handoffKey: string;
  /** #157: the worker's Codex launch (its async questions), and what of it the card shows (a new one told from the same one). */
  codex: WorkerCodex | null;
  /** #157: the worker works on (its effective status): the async card's "still working". */
  codexWorking: boolean;
  codexKey: string;
  /** #101: the worker's usage (for the view's context meter), and the part of it the meter shows (so a frame that changed nothing is skipped). */
  usage: Usage | null;
  usageKey: string;
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
 * M16: the seated view's two modes. Keeps the transcript of the worker you
 * sit at (fed by `TranscriptWatches` from the moment you sit), mounts the
 * render module in a DOM overlay over the monitor when it first shows, and
 * hides the overlay when you go to the terminal (Ctrl+Esc). #98: the
 * conversation is what you sit down to, unless the worker has none to read or
 * you left it in the terminal last time (remembered per worker, localStorage,
 * guarded). Standing up destroys the view and removes the overlay.
 */
export class TranscriptMode {
  private s: Sitting | null = null;
  private gen = 0;
  /** Views mounted and destroyed, overlays made and removed (test hook: nothing may be left over). */
  readonly counts = { mounted: 0, destroyed: 0, overlays: 0, removed: 0, tabsMounted: 0, tabsDestroyed: 0 };
  private rect: OverlayRect | null = null;
  /** Numbers the pending prompts. */
  private pid = 0;
  /** An Esc for a queued prompt is on its way. */
  private escBusy = false;
  /** #110: the pack-up check of the prompt being sent (aborted: Esc, standing up). */
  private checking: AbortController | null = null;
  /** #140: each worker's slash commands and skills, kept across seats (the popup shows the last list at once). */
  private readonly catalogs = new CommandCatalogs({ send: (t, args) => this.host.send(t, args) });
  /** #141: each worker's unsent prompt, kept across seats (and its text and file chips across a reload). */
  private readonly drafts: TranscriptDrafts;
  /** #157: what you wrote for Codex workers' async questions, kept across views, seats and reconnects. */
  private readonly asyncDrafts: AsyncDrafts;
  /**
   * #141: the workers a prompt is on its way to (until the bridge answered it). A sitting's pending rows go when you
   * stand up but the send does not, nor does the draft it came from: sitting there again must not send it twice.
   */
  private readonly prompting = new Set<string>();
  /**
   * #224: each worker's composer "/handoff" not answered for sure (its ack lost: the connection dropped, it timed out),
   * with its text and op: sending the same text to the same worker again reuses the op, so the bridge answers the request
   * it may have started (or filed) instead of asking the agent twice. An answer, a refusal or other text drops it.
   */
  private readonly handoffOps = new Map<string, { text: string; op: string }>();

  constructor(private readonly host: TranscriptModeHost) {
    this.drafts = new TranscriptDrafts({ ...(host.upload ? { upload: host.upload } : {}), storage: host.storage });
    this.asyncDrafts = new AsyncDrafts(host.storage);
  }

  private now(): number {
    return this.host.now?.() ?? Date.now();
  }

  get seated(): string | null {
    return this.s?.id ?? null;
  }

  /** Not seated: 'terminal' (no overlay); seated, the mode `sit` picked or you switched to. */
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

  /**
   * You sat at `id`: its conversation (or its images, if you left it there), unless you left it in the terminal last
   * time. `canRead` false (the bridge has no transcripts, the worker's harness writes none): the terminal it is.
   * `harness` (#140): the worker's, for its commands in the prompt box ('': none).
   */
  sit(id: string, name: string, canRead = true, harness = ''): void {
    this.stand();
    dropOldModes(this.host.storage);
    const opens = canRead && !readModes(this.host.storage).includes(id);
    // The way to read it last time (what the first Ctrl+Esc shows when it opens in the terminal).
    const last: ReadMode = canRead && this.host.imagesRenderer && readModes(this.host.storage, IMAGES_KEY).includes(id) ? 'images' : 'transcript';
    this.s = {
      id, name, harness, gen: ++this.gen, mode: 'terminal', items: [], index: new Map(), question: null, questionKey: '', ask: null, askKey: '', followup: null, followupKey: '', handoff: null, handoffKey: '', codex: null, codexWorking: false, codexKey: '', usage: null, usageKey: '', box: null, view: null,
      viewPane: null, tabPane: null, tab: null, mounting: false, mountingTab: false, reading: last, cursor: '', hasMore: false, reveal: null,
      revealing: false, unsub: null, relist: null, imageCount: null, tabs: null, focusLater: false, status: null, since: 0, mark: null, sendMark: null,
      pending: [], taken: new Set(), timeline: null, cueKey: '', cueDirty: true,
    };
    if (opens) this.setMode(last, false);
    else this.host.modeChanged('terminal');
  }

  /** You stood up: the view goes, the overlay with it. */
  stand(): void {
    const s = this.s;
    if (!s) return;
    this.checking?.abort();
    this.checking = null;
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

  /** #110: Esc while a prompt is being checked: the check is dropped and nothing is sent (the draft stays). False: none ran. */
  cancelCheck(): boolean {
    const c = this.checking;
    if (!c) return false;
    c.abort();
    this.checking = null;
    this.host.status('ok', 'Not sent: the prompt is still in the box.');
    return true;
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
      if (mode === 'terminal') ids.push(s.id);
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
    // #140: the transcript opened: its commands are asked for (the popup asks again when it opens).
    if (hasTranscript(s.harness)) void this.catalogs.get(s.id).refresh();
    const strip = this.tabsFor(s);
    if (strip) {
      s.view.attachTabs(strip.create());
      this.tabsChanged(s);
    }
    s.view.setItems([...s.items]);
    if (s.question) s.view.setBlocked(s.question);
    if (s.ask) s.view.setAsk(s.ask);
    if (s.followup) s.view.setFollowup(s.followup);
    if (s.handoff) s.view.setHandoff?.(s.handoff);
    if (s.codex) s.view.setCodex(s.id, s.codex, s.codexWorking);
    if (s.pending.length) s.view.setPending(s.pending);
    s.cueKey = '';
    this.cue(s, true);
    if (s.mode === 'transcript') this.focus();
    if (s.reveal) void this.revealNow(s);
  }

  /** Sends a prompt from the view: its row is in the timeline at once. Resolves whether it went. */
  private sendPrompt(s: Sitting, t: string): Promise<boolean> {
    const live = () => this.s === s;
    // #58: its row is in the timeline at once, until its `user` item comes; a refused one before it goes.
    const p: PendingPrompt = { id: `p${++this.pid}`, text: t, state: 'sending', late: false, mark: topSeq(s.items), due: null };
    s.pending = [...s.pending.filter((x) => x.state !== 'refused'), p];
    // To a worker not at work it starts a turn: that turn's items come after this.
    if (s.status !== 'working') s.sendMark = p.mark;
    this.pendingChanged(s);
    this.prompting.add(s.id);
    // Resolves whether it went: a refused prompt goes back in the box.
    // #224: an exact "/handoff [instruction]" becomes an agent handoff request: one op, so a retry asks once.
    const op = this.handoffOp(s.id, t);
    return this.host.send('worker.prompt', { id: s.id, text: t, ...(op ? { op } : {}) }).then((r) => {
      // Answered (the client never rejects; it times out): this worker takes the next one, from whichever seat.
      this.prompting.delete(s.id);
      if (op && (r.ok || !UNANSWERED.has(r.code)) && this.handoffOps.get(s.id)?.op === op) this.handoffOps.delete(s.id);
      if (!live()) return r.ok;
      const ack = (r.ok ? (r.data ?? {}) : {}) as Partial<PromptAck>;
      if (r.ok && ack.terminal === true) {
        // #140: a built-in whose output or dialog shows only in the terminal (/usage, a bare /model): its transcript
        // shows nothing of it, so no row waits for it, and the terminal is shown, where it can be read and closed. Not
        // remembered as where you left this worker.
        s.pending = s.pending.filter((x) => x.id !== p.id);
        this.pendingChanged(s);
        this.host.status('ok', `Sent to ${s.name}: it shows in the terminal`);
        if (s.mode !== 'terminal') this.setMode('terminal', false);
        return true;
      }
      if (r.ok && ack.handoff) {
        // #224: the bridge sent its own request (the skill, where to save, the marker), which the transcript shows;
        // the outcome follows on the worker (a toast when it is filed or fails).
        s.pending = s.pending.filter((x) => x.id !== p.id);
        this.pendingChanged(s);
        const a = ack.handoff;
        this.host.status(
          a.state === 'failed' ? 'error' : 'ok',
          a.state === 'failed'
            ? `${s.name}’s agent handoff was not filed: ${a.reason ?? 'it failed'}`
            : a.state === 'filed'
              ? `${s.name}’s handoff is filed`
              : ack.existing
                ? `${s.name} is already writing a handoff: nothing was sent again`
                : `Asked ${s.name}’s agent for a handoff: it is filed once its turn ends with the file written`,
        );
        return true;
      }
      if (r.ok) this.host.status('ok', `Sent to ${s.name}`);
      else this.host.status('error', failureText('worker.prompt', r.code, r.message, { worker: s.name }));
      const queued = ack.queued === true;
      // #138: what the bridge sent, when it rewrote the text: the transcript shows that.
      const sent = typeof ack.sent === 'string' && ack.sent !== '' && ack.sent !== t ? ack.sent : undefined;
      const now = this.now();
      // Already shown by its item (it can come before the ack): nothing to change.
      if (!s.pending.some((x) => x.id === p.id)) return r.ok;
      s.pending = s.pending.map((x): PendingPrompt => {
        if (x.id !== p.id) return x;
        if (!r.ok) return { ...x, state: 'refused', reason: failureText('worker.prompt', r.code, r.message, { worker: s.name }), due: null };
        // A queued prompt may wait for the whole turn: the hint only once the agent stopped working.
        return { ...x, ...(sent !== undefined ? { sent } : {}), state: queued ? 'queued' : 'sent', due: queued && s.status === 'working' ? null : now + SENT_TIMEOUT_MS };
      });
      // Its item may have come before the ack, under the rewritten text: it takes the row now.
      if (sent !== undefined) {
        const left = reconcile(s.pending, s.items, s.taken);
        if (left !== s.pending) s.pending = left;
      }
      this.pendingChanged(s);
      return r.ok;
    });
  }

  /**
   * #224: the op of a composer prompt to worker id that is "/handoff [instruction]": the unanswered one's for the same
   * text, else a new one. Any other prompt has none, and the unanswered one is dropped (the person moved on).
   */
  private handoffOp(id: string, text: string): string | undefined {
    if (handoffCommand(text) === null) {
      this.handoffOps.delete(id);
      return undefined;
    }
    const kept = this.handoffOps.get(id);
    if (kept && kept.text === text) return kept.op;
    const op = newOp();
    this.handoffOps.set(id, { text, op });
    return op;
  }

  private renderHost(s: Sitting): TranscriptRenderHost {
    const live = () => this.s === s;
    const handoff = this.host.handoff;
    return {
      ...(handoff ? { onHandoff: (c: HandoffCandidate) => live() && handoff(s.id, c) } : {}),
      images: this.host.feed(s.id),
      upload: this.host.upload ?? null,
      label: s.name,
      usage: s.usage,
      ...(this.host.prefs ? { prefs: this.host.prefs } : {}),
      commands: hasTranscript(s.harness) ? { list: this.catalogs.get(s.id), harness: s.harness } : null,
      // #141: the worker's own draft, back from its last seat (or a reload); `@` searches the worker's checkout.
      draft: this.drafts.get(s.id, s.name),
      sending: this.drafts.sending(s.id),
      asyncDrafts: this.asyncDrafts,
      files: { id: s.id, search: { send: (t, args) => this.host.send(t, args) } },
      // #247: `@r:` lists the repositories and folders of the other floors.
      repos: { id: s.id, search: { send: (t, args) => this.host.send(t, args), refs: this.host.repoRefs ?? null } },
      onPromptSubmit: (text) => {
        if (!live()) return Promise.resolve(false);
        const t = text.replace(/\u0000/g, '');
        if (!t.trim()) return Promise.resolve(false);
        if (bytes(t) > MAX_PROMPT) {
          this.host.status('error', 'That prompt is over 16 KiB: send less at a time.');
          return Promise.resolve(false);
        }
        // #58: one on its way at a time (a second Enter while it is sending sends nothing). #110: nor while one is checked.
        // #141: nor while one from an earlier seat at this worker is.
        if (s.pending.some((p) => p.state === 'sending') || this.prompting.has(s.id) || this.checking) return Promise.resolve(false);
        // #110: first whether it also tells the worker to leave. Meanwhile the box is read-only and keeps the draft.
        const check = new AbortController();
        const checked = this.host.packup?.(s.id, t, check.signal) ?? null;
        if (!checked) return this.sendPrompt(s, t);
        this.checking = check;
        this.host.status('ok', 'Checking the prompt…');
        return checked.then((out) => {
          if (this.checking === check) this.checking = null;
          if (check.signal.aborted || !live()) return false;
          if (out === 'done') {
            this.host.status('ok', `Sent the task to ${s.name}: it goes home once it reports CLEAN`);
            return true;
          }
          if (out === 'cancel') {
            this.host.status('ok', null);
            // The confirm (or the send home) had the keyboard: back to the box, its draft still in it.
            queueMicrotask(() => live() && this.focusPrompt());
            return false;
          }
          this.host.status('ok', null);
          return this.sendPrompt(s, t);
        });
      },
      onDismissPending: (id) => {
        if (!live()) return;
        const left = s.pending.filter((x) => x.id !== id || x.state !== 'refused');
        if (left.length === s.pending.length) return;
        s.pending = left;
        this.pendingChanged(s);
      },
      onSendNow: (id) => {
        // Esc stops the turn and both CLIs send what is queued at once. One at a time: a second Esc on an empty
        // Claude box opens its rewind menu.
        if (!live() || this.escBusy || !s.pending.some((x) => x.id === id && x.state === 'queued')) return;
        this.escBusy = true;
        void this.host.send('worker.keys', { id: s.id, input: [{ key: 'esc' }] }).then((r) => {
          this.escBusy = false;
          if (!live() || r.ok) return;
          this.host.status('error', failureText('worker.keys', r.code, r.message, { worker: s.name }));
          // Not sent: the link comes back (rows are rebuilt, not reused).
          s.view?.setPending([]);
          s.view?.setPending(s.pending);
        });
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
      onAnswerFollowup: async (args) => {
        if (!live()) return { ok: false, code: 'stale', message: 'You got up.' };
        const r = await this.host.send('worker.answer_followup', { ...args, id: s.id });
        if (r.ok) {
          if (live()) this.host.status('ok', `Answered ${s.name}`);
          return { ok: true };
        }
        const message = failureText('worker.answer_followup', r.code, r.message, { worker: s.name });
        if (live() && r.code !== 'stale') this.host.status('error', message);
        return { ok: false, code: r.code, message };
      },
      onDismissFollowup: async (turnId) => {
        if (!live()) return { ok: false, code: 'stale', message: 'You got up.' };
        const r = await this.host.send('worker.dismiss_followup', { id: s.id, turn_id: turnId });
        if (r.ok) return { ok: true };
        const message = failureText('worker.dismiss_followup', r.code, r.message, { worker: s.name });
        if (live() && r.code !== 'stale') this.host.status('error', message);
        return { ok: false, code: r.code, message };
      },
      // #157: a Codex worker's async questions. Refused, the card keeps the answer and says why (the seat bar too, but
      // not for `stale`: the question had moved on already, which the card says calmly).
      onAnswerAsync: async (args) => {
        if (!live()) return { ok: false, code: 'stale', message: 'You got up.' };
        const r = await this.host.send('worker.answer_async', { ...args, id: s.id });
        if (r.ok) {
          if (live()) this.host.status('ok', `Sent your answer to ${s.name}`);
          return { ok: true };
        }
        const message = failureText('worker.answer_async', r.code, r.message, { worker: s.name });
        if (live() && r.code !== 'stale') this.host.status('error', message);
        return { ok: false, code: r.code, message };
      },
      onDismissAsync: async (args) => {
        if (!live()) return { ok: false, code: 'stale', message: 'You got up.' };
        const r = await this.host.send('worker.dismiss_async', { ...args, id: s.id });
        if (r.ok) return { ok: true };
        const message = failureText('worker.dismiss_async', r.code, r.message, { worker: s.name });
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
      // #171: a change the list cut, in full (a subagent's: with its agent).
      loadItem: async (itemId, agent) => {
        const r = await this.host.send('transcript.item', { id: s.id, item: itemId, ...(agent ? { agent } : {}) });
        if (!r.ok) throw new Error(failureText('transcript.item', r.code, r.message, { worker: s.name }));
        const item = (r.data as { item?: unknown } | null)?.item;
        const items = itemsOf([item]);
        if (items.length) this.host.feed(s.id)?.note(items, agent);
        return items[0] ?? null;
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

  /** #90: the worker's follow-up questions (from the store; null when there are none). */
  followedUp(f: Followup | null): void {
    const s = this.s;
    if (!s) return;
    const key = f ? `${f.turn_id}\u0000${JSON.stringify(f.questions)}` : '';
    if (key === s.followupKey) return;
    s.followupKey = key;
    s.followup = f;
    s.view?.setFollowup(f);
  }

  /** #223: the worker's handoff candidate (from the store; null when it has none). */
  handoffSeen(c: HandoffCandidate | null): void {
    const s = this.s;
    if (!s) return;
    const key = c ? `${c.id}\u0000${c.revision}\u0000${c.message ?? ''}` : '';
    if (key === s.handoffKey) return;
    s.handoffKey = key;
    s.handoff = c;
    s.view?.setHandoff?.(c);
  }

  /**
   * #157: the worker's Codex launch (from the store; null when it has none): its async questions' card, and whether the
   * worker works on (its effective status: not a real block, not idle) for the card's "still working". Only its mode,
   * attachment, thread, turn and questions matter to the card: a change elsewhere draws nothing.
   */
  codexSeen(c: WorkerCodex | null, working = false): void {
    const s = this.s;
    if (!s) return;
    const key = c?.mode === 'shared' ? JSON.stringify([c.attached === true, c.thread ?? '', c.turn ?? '', working, c.questions ?? []]) : '';
    if (key === s.codexKey) return;
    s.codexKey = key;
    s.codex = key ? c : null;
    s.codexWorking = working;
    s.view?.setCodex(s.id, s.codex, working);
  }

  /** #101: the worker's usage (from the store; null when it has none), for the context meter: kept for a view still loading. */
  usageSeen(u: Usage | null): void {
    const s = this.s;
    if (!s) return;
    const key = u ? [u.context_pct, u.context_window, u.context_tokens, u.context_window_estimated, u.model].join('\u0000') : '';
    if (key === s.usageKey) return;
    s.usageKey = key;
    s.usage = u;
    s.view?.setUsage(u);
  }

  /** The seated worker's follow-up questions. */
  get followup(): Followup | null {
    return this.s?.followup ?? null;
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
