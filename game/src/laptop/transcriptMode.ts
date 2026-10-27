import type { CommandResult } from '../net/client';
import type { RepoSearchHost } from './repoSearch';
import { HANDOVER_STALE, packupAction, packupStep, type PackupCheck } from '../ui/packupSend';
import type { AnswerAskAck, Ask, ChildState, CommandArgs, Followup, FollowupMessageAck, HandoffCandidate, ImageRef, ScheduleSuggestion, PromptAck, Question, TranscriptAvailability, TranscriptChild, TranscriptItem, TranscriptWatchAck, Usage, WorkerCodex } from '../net/protocol';
import type { Uploader } from '../ui/composer/draft';
import { failureText } from '../ui/messages';
import type { ViewPrefs } from '../ui/themePrefs';
import { MAX_PROMPT } from './keys';
import type { mountTranscript, TranscriptRenderHost, TranscriptView } from './transcriptRender';
import type { ImageFeed } from './imageFeed';
import type { ImagesTabHost, ImagesTabView, MountImagesTab } from './imagesTab';
import { itemsOf, type PushHead, type TimelineOf } from './transcriptWatches';
import type { ChildViewState } from './transcriptChild';
import { TranscriptDrafts } from './transcriptDrafts';
import { AskDrafts } from './askDrafts';
import type { OpenedAsks } from './questionSheet';
import { AsyncDrafts } from './asyncDrafts';
import { FollowupDrafts } from './followupDrafts';
import { CommandCatalogs } from './commandCatalog';
import { activityCue, reconcile, SENT_TIMEOUT_MS, topSeq, type ActivityCue, type PendingPrompt } from './transcriptActivity';
import { handoffCommand, newOp } from '../world/handoff';
import type { FieldText, Go, GoFields, PromptSecretsFlow } from '../ui/secretsFlow';
import { askFields, asyncFields, followupFields } from '../world/promptSecrets';
import { bridgeKey } from '../net/bridgeScope';

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
 * every image of the session, split into what you sent and what the agent viewed or made, or (#216) the worker's manual
 * runs (their request card, their rows and the picked run's live terminal).
 */
export type SeatMode = 'terminal' | 'transcript' | 'images' | 'runs';

/** #98: the harnesses whose transcripts the bridge reads (Claude Code, Codex); a seat at any other opens in the terminal. */
export const hasTranscript = (harness: string | undefined): boolean => harness === 'claude' || harness === 'codex';

/** The views the overlay shows (every one but the terminal): what Ctrl+Esc goes back to. */
export type ReadMode = Exclude<SeatMode, 'terminal'>;

/** #216: the Runs view, which the host owns (the seat's runs of its worker): shown in the overlay, over the terminal. */
export interface RunsPane {
  /** Into `box` (once) and up. */
  show(box: HTMLElement): void;
  hide(): void;
  focus(): void;
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
    T extends 'manual_process.start' | 'worker.dismiss_command_request' | 'worker.prompt' | 'worker.keys' | 'worker.answer' | 'worker.answer_ask' | 'worker.answer_followup' | 'worker.dismiss_followup' | 'worker.dismiss_schedule_suggestion' | 'worker.retry_followup' | 'worker.followup_message' | 'worker.answer_async' | 'worker.dismiss_async' | 'transcript.page' | 'transcript.item' | 'worker.commands' | 'worker.files' | 'worker.repos',
  >(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  /** M16 phase 2: the images of a worker's transcript (thumbnails, full images, the session list); #26: of a child's. */
  feed(id: string, child?: TranscriptChild): ImageFeed | null;
  /** #26: a child's conversation was opened or left (its watch follows). */
  childChanged?(): void;
  /** Loads the render module (`loadRenderer`; tests pass a fake). */
  renderer(): Promise<MountTranscript | null>;
  /** Loads the images tab (`loadImagesTab`; none: the tab is not there and the mode stays the conversation). */
  imagesRenderer?(): Promise<MountImagesTab | null>;
  /** A child of the overlay for one view (both views are in it, one shown). None: the view takes the overlay itself. */
  pane?(box: HTMLElement): HTMLElement;
  /** #216: what leads a view's strip (its icon), for the conversation's and the images' (none: nothing). */
  lead?(mode: 'transcript' | 'images'): Element | null;
  /** #216: the session's distinct images changed (null: not known): the rail's Images count. */
  imagesCounted?(n: number | null): void;
  /** #216: the Runs view (none: there is none, Runs stays on the terminal). */
  runs?: RunsPane;
  /** #216: something over the views has the keyboard (the files drawer): a view that shows or mounts does not take it. */
  focusHeld?(): boolean;
  /**
   * #126: what stands in for a conversation (`who`'s) while the render module loads: its outline, opening
   * (`transcriptLoading.ts`). None: nothing.
   */
  loading?(who: string): HTMLElement;
  /** #126: runs `fn` once the next frame is drawn (none: now). */
  frame?(fn: () => void): void;
  /** A new, empty, hidden overlay element in the HUD; the controller removes it (`remove()`). */
  overlay(): HTMLElement;
  /** Where the last mode per worker is kept (null: nowhere, it lasts until the page reloads). */
  storage: Storage | null;
  /** #64: one image to Drop Zone, for the prompt box (none: a pasted image says it cannot go up). */
  upload?: Uploader;
  /** The seat bar's note. */
  status(kind: 'ok' | 'error', text: string | null): void;
  /** #110: the pack-up check before a prompt goes (none: it goes at once). */
  packup?: PackupCheck;
  /** The mode changed (the seat bar's toggle, the terminal watch's fps, the monitor's frame). */
  modeChanged(mode: SeatMode): void;
  /** #59: the preset, hidden tool calls and the zoom (the view's top strip sets them). */
  prefs?: ViewPrefs;
  /** #223: the inline Handoff button of a worker's reply was pressed: the filing dialog (none: no button). */
  handoff?(id: string, c: HandoffCandidate): void;
  /** #198: the inline "Hire with handoff" button was pressed: step 1 of the hire (none: no button). */
  hireHandoff?(id: string, c: HandoffCandidate): void;
  /**
   * #64 schedules: "Schedule follow-up…" beside it: the schedule form, prefilled from the worker (none: no button). #66:
   * with `s`, the worker's suggestion chip was clicked: prefilled from it too.
   */
  scheduleFollowup?(id: string, c: HandoffCandidate, s?: ScheduleSuggestion): void;
  manualHost?(): string;
  manualEntry?(id: string, command: string, cwd: string): void;
  /** #213: the seated worker's command card came into, or went out of, the conversation's view. */
  commandCardView?(inView: boolean): void;
  /** #247: the shared "Repositories from other buildings" switch, for the prompt box's `@r:` (none: as if off). */
  repoRefs?: RepoSearchHost['refs'];
  /** #54: repository discovery, for the prompt box's `@r:` (none: as if off). */
  repoDiscovery?: RepoSearchHost['discovery'];
  /** #58: a floor id's name (the `@r:` rows). */
  floorName?(id: string): string;
  /** #31: a worker's checkout now (null: not known), for the transcript's relative file references. */
  cwd?(id: string): string | null;
  /** #39: the app's lists of commands and skills, shared with the Prompt overlay and the hire dialogs (none: its own). */
  catalogs?: CommandCatalogs;
  /** #58: the clock of the pending prompts' "not seen yet" hint (default Date.now; tests pass their own). */
  now?(): number;
  /** #108: the review of a prompt's possible secrets before it goes (none: it goes as today). */
  secrets?: PromptSecretsFlow;
  /** #108 round 4: the bridge's directory of protected files (`World.prompt_secrets.dir`; null: not known). */
  secretsDir?(): string | null;
}

/** #26: what the seat shows of a child (its row in the store, as the overview has it). */
export interface ChildInfo {
  name: string;
  type?: string | null;
  description?: string | null;
  state: ChildState;
  /** Its state and time in the overview's words (`childSinceText`). */
  since: string;
}

/** #26: a native child's conversation, open over its worker's (whose view stays as it was, hidden). */
interface ChildSitting {
  target: TranscriptChild;
  info: ChildInfo;
  /** As in `Sitting`: its timeline, by `id`; where older items start. */
  items: TranscriptItem[];
  index: Map<string, number>;
  cursor: string;
  hasMore: boolean;
  /** What its watch said of its log (null: no answer yet). */
  availability: TranscriptAvailability | null;
  view: TranscriptView | null;
  pane: HTMLElement | null;
  mounting: boolean;
  /** #126: what stands in for its view while the render module loads (null: none). */
  loader: HTMLElement | null;
}

/** Remembered per worker: the ones last left in terminal mode (#98: the conversation is the default), newest last. */
const MODES_KEY = 'h3d.seat.terminal';
/** Before #98, the ones last read in transcript mode (terminal was the default): not read, and removed. */
const OLD_MODES_KEY = 'h3d.seat.transcript';
/** Remembered per worker: the ones whose last way to read was the images tab (not the conversation). */
const IMAGES_KEY = 'h3d.seat.images';
/** #216: remembered per worker: the ones whose last view other than the terminal was Runs. */
const RUNS_KEY = 'h3d.seat.runs';
/** Older pages read to find a message the images tab points at: 20 x 200 items. */
const REVEAL_PAGES = 20;
const REVEAL_LIMIT = 200;
/** The list of images is asked again this long after the last change (a push with an image). */
const RELIST_MS = 300;
/** #187: how many of a worker's questions the sheet remembers having opened for. */
const OPENED_KEPT = 32;
const MODES_MAX = 64;
/** How many of a subagent's items its nested timeline shows (the newest; the bridge's most). */
const SUBAGENT_LIMIT = 500;
/** #224: a command's outcome is not known (it may have run, or not gone at all): a retry must keep its op. */
const UNANSWERED = new Set(['timeout', 'disconnected', 'offline']);

function readModes(s: Storage | null, key = MODES_KEY): string[] {
  try {
    const v: unknown = JSON.parse(s?.getItem(bridgeKey(key)) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeModes(s: Storage | null, ids: string[], key = MODES_KEY): void {
  try {
    if (ids.length) s?.setItem(bridgeKey(key), JSON.stringify(ids.slice(-MODES_MAX)));
    else s?.removeItem(bridgeKey(key));
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
  commandRequest: import('../net/protocol').CommandRequest | null;
  commandRequestKey: string;
  /** #213: enough of its card is in the conversation's view to be seen; a reveal waiting for the view to mount. */
  commandCardInView: boolean;
  revealCard: boolean;
  /** #223: the worker's handoff candidate (the inline button's), and its id + revision. */
  handoff: HandoffCandidate | null;
  handoffKey: string;
  /** #66: the worker's schedule suggestion (the chip's), and its id + time. */
  suggestion: ScheduleSuggestion | null;
  suggestionKey: string;
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
  /** #126: what stands in for the conversation while the render module loads (null: none). */
  loader: HTMLElement | null;
  /** #126: the watch answered (its ack reset the timeline): an empty timeline is empty, not opening. */
  acked: boolean;
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
  /** Focus was asked for while the overlay was not placed yet (invisible: the browser ignores focus there). */
  focusLater: boolean;
  /** #216: the prompt box takes the keyboard once the conversation is mounted (a file reference went into it). */
  promptLater: boolean;
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
  /** #26: the child whose conversation is open over the worker's (null: the worker's own). */
  child: ChildSitting | null;
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
  /** #108: a prompt's secrets are being scanned or reviewed (no second send meanwhile). */
  private reviewing = false;
  /** #140: each worker's slash commands and skills, kept across seats (the popup shows the last list at once). */
  private readonly catalogs: CommandCatalogs;
  /** #141: each worker's unsent prompt, kept across seats (and its text and file chips across a reload). */
  private readonly drafts: TranscriptDrafts;
  /** #157: what you wrote for Codex workers' async questions, kept across views, seats and reconnects. */
  private readonly asyncDrafts: AsyncDrafts;
  private readonly followupDrafts: FollowupDrafts; // #60
  /** #187: what you picked and typed on each worker's ask, kept across the questions' sheet, views, seats and reconnects. */
  private readonly askDrafts: AskDrafts;
  /**
   * #187: per worker, the mandatory questions (an ask's id, the screen question's) the questions' sheet has opened for,
   * newest last: it opens by itself once per question, not again on a re-render, a reconnect or another seat. In memory
   * (a reload may open it once more).
   */
  private readonly opened = new Map<string, string[]>();
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
    this.catalogs = host.catalogs ?? new CommandCatalogs({ send: (t, args) => this.host.send(t, args) });
    // #108: with prompt secrets reviewed, the drafts stay in memory (they may hold one), and follow the switch (round 4:
    // the answers' drafts too).
    const persist = () => !host.secrets?.on;
    this.drafts = new TranscriptDrafts({ ...(host.upload ? { upload: host.upload } : {}), storage: host.storage, persist });
    this.asyncDrafts = new AsyncDrafts(host.storage, persist);
    this.followupDrafts = new FollowupDrafts(host.storage, persist);
    this.askDrafts = new AskDrafts(host.storage, persist);
    host.secrets?.onChange(() => {
      this.drafts.persistChanged();
      this.asyncDrafts.persistChanged();
      this.followupDrafts.persistChanged();
      this.askDrafts.persistChanged();
    });
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
    // The view looked at last time (what the first Ctrl+Esc shows when it opens in the terminal). #216: Runs needs no
    // transcript, so a worker left in it opens in it.
    const last: ReadMode =
      this.host.runs && readModes(this.host.storage, RUNS_KEY).includes(id) ? 'runs' : canRead && this.host.imagesRenderer && readModes(this.host.storage, IMAGES_KEY).includes(id) ? 'images' : 'transcript';
    const opens = (canRead || last === 'runs') && !readModes(this.host.storage).includes(id);
    this.s = {
      id, name, harness, gen: ++this.gen, mode: 'terminal', items: [], index: new Map(), question: null, questionKey: '', ask: null, askKey: '', followup: null, followupKey: '', commandRequest: null, commandRequestKey: '', commandCardInView: false, revealCard: false, handoff: null, handoffKey: '', suggestion: null, suggestionKey: '', codex: null, codexWorking: false, codexKey: '', usage: null, usageKey: '', box: null, view: null,
      viewPane: null, tabPane: null, tab: null, mounting: false, loader: null, acked: false, mountingTab: false, reading: last, cursor: '', hasMore: false, reveal: null,
      revealing: false, unsub: null, relist: null, imageCount: null, focusLater: false, promptLater: false, status: null, since: 0, mark: null, sendMark: null,
      pending: [], taken: new Set(), timeline: null, cueKey: '', cueDirty: true, child: null,
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
    this.dropChild(s);
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
    if (s.mode === 'runs') this.host.runs?.hide();
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

  /** The view Ctrl+Esc goes back to from the terminal (seated; null: not seated). */
  get reading(): ReadMode | null {
    return this.s?.reading ?? null;
  }

  /** The key that flips the two ways to read (Conversation <-> Images); #216: Runs keeps it (its rows' letters). */
  flip(): void {
    const s = this.s;
    if (!s || (s.mode !== 'transcript' && s.mode !== 'images')) return;
    this.setMode(s.mode === 'transcript' ? 'images' : 'transcript');
  }

  setMode(mode: SeatMode, remember = true): void {
    const s = this.s;
    if (!s || s.mode === mode) return;
    // No images tab (an older shell, a module that did not load): the conversation. #216: no Runs view: none to show.
    if (mode === 'images' && !this.host.imagesRenderer) mode = 'transcript';
    if (mode === 'runs' && !this.host.runs) return;
    if (s.mode === mode) return;
    const was = s.mode;
    s.mode = mode;
    if (mode !== 'terminal') s.reading = mode;
    if (remember) {
      const ids = readModes(this.host.storage).filter((x) => x !== s.id);
      if (mode === 'terminal') ids.push(s.id);
      writeModes(this.host.storage, ids);
      if (mode !== 'terminal') {
        for (const [key, m] of [[IMAGES_KEY, 'images'], [RUNS_KEY, 'runs']] as const) {
          const kept = readModes(this.host.storage, key).filter((x) => x !== s.id);
          if (mode === m) kept.push(s.id);
          writeModes(this.host.storage, kept, key);
        }
      }
    }
    if (was === 'runs') this.host.runs?.hide();
    if (mode !== 'terminal') this.show(s);
    else {
      s.focusLater = false;
      if (s.box) s.box.hidden = true;
    }
    this.visible(s);
    // #58: the cue runs only while the conversation is up.
    this.cue(s, true);
    this.host.modeChanged(mode);
  }

  private show(s: Sitting): void {
    if (!s.box) {
      s.box = this.host.overlay();
      this.counts.overlays++;
      this.applyRect(s.box);
    }
    s.box.hidden = false;
    if (s.child?.pane) s.child.pane.hidden = true;
    if (s.mode === 'runs') return this.showRuns(s);
    this.watchImages(s);
    if (s.mode === 'images') return this.showTab(s);
    if (s.child) return this.showChild(s, s.child);
    if (s.viewPane) s.viewPane.hidden = false;
    if (s.tabPane) s.tabPane.hidden = true;
    if (s.view) {
      this.focus();
      return;
    }
    if (s.mounting) return;
    s.mounting = true;
    // #126: the conversation opening, in the view's place, while its module loads (then the view says it, until the ack).
    const pane = s.viewPane ?? this.pane(s);
    s.viewPane = pane === s.box ? null : pane;
    if (s.viewPane) s.viewPane.hidden = false;
    s.loader ??= this.host.loading?.(s.name) ?? null;
    if (s.loader) pane.append(s.loader);
    const gen = s.gen;
    void this.host.renderer().then(
      (mount) => this.mounted(gen, mount),
      () => this.mounted(gen, null),
    );
  }

  /** #216: the Runs view, over the other views (they stay mounted underneath, hidden). */
  private showRuns(s: Sitting): void {
    if (s.viewPane) s.viewPane.hidden = true;
    if (s.tabPane) s.tabPane.hidden = true;
    this.host.runs?.show(s.box as HTMLElement);
    this.focus();
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

  /** The list of images is kept fresh while you read: the strip's count and the images tab. */
  private watchImages(s: Sitting): void {
    if (s.unsub) return;
    const feed = this.host.feed(s.id);
    if (!feed) return;
    const ask = () => {
      void feed.list().then(
        (refs) => {
          if (this.s !== s) return;
          const n = distinctImages(refs);
          if (n !== s.imageCount) this.host.imagesCounted?.(n);
          s.imageCount = n;
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
      lead: () => this.host.lead?.('images') ?? null,
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
    this.closeChild(); // #26: the worker's own message, under the child's
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
    const timeline = s.timeline;
    try {
      for (let pages = 0; ; pages++) {
        if (this.s !== s || s.timeline !== timeline) return false;
        if (s.index.has(id)) {
          if (!s.view?.hasItem(id)) s.view?.setItems([...s.items]);
          if (s.view?.scrollToItem(id)) {
            s.reveal = null;
            return true;
          }
        }
        if (!s.hasMore || pages >= REVEAL_PAGES) break;
        const r = await this.host.send('transcript.page', { id: s.id, before: s.cursor, limit: REVEAL_LIMIT });
        if (this.s !== s || s.timeline !== timeline) return false;
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
    s.loader?.remove();
    s.loader = null;
    if (!mount) {
      this.setMode('terminal', false);
      this.host.status('error', 'The transcript view did not load: try again.');
      return;
    }
    const pane = s.viewPane ?? this.pane(s);
    s.viewPane = pane === s.box ? null : pane;
    // #26: a child opened meanwhile stays on top; this view waits underneath.
    if (s.viewPane) s.viewPane.hidden = s.mode !== 'transcript' || !!s.child;
    s.view = mount(pane, this.renderHost(s));
    this.counts.mounted++;
    this.visible(s); // #187: before its questions (a mandatory one opens the sheet only while it is on the screen)
    // #140: the transcript opened: its commands are asked for (the popup asks again when it opens).
    if (hasTranscript(s.harness)) void this.catalogs.get(s.id).refresh();
    const lead = this.host.lead?.('transcript');
    if (lead) s.view.attachLead(lead);
    // #126: what the watch sent while the module loaded goes in after the view's first frame (two tasks, not one long
    // one); the view says it is opening till then.
    const view = s.view;
    const fill = () => {
      if (this.s === s && s.view === view) view.setItems([...s.items]);
    };
    if (s.items.length && this.host.frame) this.host.frame(fill);
    else fill();
    if (s.question) s.view.setBlocked(s.question);
    if (s.ask) s.view.setAsk(s.ask);
    if (s.followup) s.view.setFollowup(s.followup);
    if (s.commandRequest) s.view.setCommandRequest?.(s.commandRequest);
    if (s.revealCard) {
      s.revealCard = false;
      s.view.revealCommandRequest?.();
    }
    if (s.handoff) s.view.setHandoff?.(s.handoff);
    if (s.suggestion) s.view.setScheduleSuggestion?.(s.suggestion);
    if (s.codex) s.view.setCodex(s.id, s.codex, s.codexWorking);
    if (s.pending.length) s.view.setPending(s.pending);
    s.cueKey = '';
    this.cue(s, true);
    if (s.mode === 'transcript') this.focus();
    if (s.promptLater) {
      s.promptLater = false;
      this.focusPrompt();
    }
    if (s.reveal) void this.revealNow(s);
  }

  /**
   * Sends a prompt from the view: its row is in the timeline at once. Resolves the bridge's answer. #108: `go` carries the
   * review of its secrets (`secrets`), and what the row may show of it (`shown`: no protected value); `pending` (round 4)
   * is pack up's hand-over for `t`, the text its check read (references for the protected values).
   */
  private sendPrompt(s: Sitting, t: string, go: Go | null = null, pending: string | null = null): Promise<CommandResult> {
    const live = () => this.s === s;
    // #58: its row is in the timeline at once, until its `user` item comes; a refused one before it goes.
    const p: PendingPrompt = { id: `p${++this.pid}`, text: t, ...(go?.protects ? { shown: go.shown } : {}), state: 'sending', late: false, mark: topSeq(s.items), due: null };
    s.pending = [...s.pending.filter((x) => x.state !== 'refused'), p];
    // To a worker not at work it starts a turn: that turn's items come after this.
    if (s.status !== 'working') s.sendMark = p.mark;
    this.pendingChanged(s);
    this.prompting.add(s.id);
    // Resolves whether it went: a refused prompt goes back in the box.
    // #224: an exact "/handoff [instruction]" becomes an agent handoff request: one op, so a retry asks once.
    const op = this.handoffOp(s.id, t);
    return this.host.send('worker.prompt', { id: s.id, text: t, ...(op ? { op } : {}), ...(go?.secrets ? { secrets: go.secrets } : {}), ...(pending ? { secrets_pending: pending } : {}) }).then((r) => {
      // Answered (the client never rejects; it times out): this worker takes the next one, from whichever seat.
      this.prompting.delete(s.id);
      if (op && (r.ok || !UNANSWERED.has(r.code)) && this.handoffOps.get(s.id)?.op === op) this.handoffOps.delete(s.id);
      if (!live()) return r;
      const ack = (r.ok ? (r.data ?? {}) : {}) as Partial<PromptAck>;
      if (r.ok && ack.terminal === true) {
        // #140: a built-in whose output or dialog shows only in the terminal (/usage, a bare /model): its transcript
        // shows nothing of it, so no row waits for it, and the terminal is shown, where it can be read and closed. Not
        // remembered as where you left this worker.
        s.pending = s.pending.filter((x) => x.id !== p.id);
        this.pendingChanged(s);
        this.host.status('ok', `Sent to ${s.name}: it shows in the terminal`);
        if (s.mode !== 'terminal') this.setMode('terminal', false);
        return r;
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
        return r;
      }
      if (r.ok) this.host.status('ok', `Sent to ${s.name}`);
      else this.host.status('error', failureText('worker.prompt', r.code, r.message, { worker: s.name }));
      const queued = ack.queued === true;
      // #138: what the bridge sent, when it rewrote the text: the transcript shows that.
      const sent = typeof ack.sent === 'string' && ack.sent !== '' && ack.sent !== t ? ack.sent : undefined;
      const now = this.now();
      // Already shown by its item (it can come before the ack): nothing to change.
      if (!s.pending.some((x) => x.id === p.id)) return r;
      s.pending = s.pending.map((x): PendingPrompt => {
        if (x.id !== p.id) return x;
        if (!r.ok) return { ...x, state: 'refused', reason: failureText('worker.prompt', r.code, r.message, { worker: s.name }), due: null };
        // A queued prompt may wait for the whole turn: the hint only once the agent stopped working. #108: a row that
        // hides protected values shows what was sent now (their references).
        return { ...x, ...(sent !== undefined ? { sent, ...(x.shown !== undefined ? { shown: sent } : {}) } : {}), state: queued ? 'queued' : 'sent', due: queued && s.status === 'working' ? null : now + SENT_TIMEOUT_MS };
      });
      // Its item may have come before the ack, under the rewritten text: it takes the row now.
      if (sent !== undefined) {
        const left = reconcile(s.pending, s.items, s.taken);
        if (left !== s.pending) s.pending = left;
      }
      this.pendingChanged(s);
      return r;
    });
  }

  /**
   * A prompt from the view's box, in order (the box is read-only meanwhile and keeps the draft): #108 the review of its
   * possible secrets (with the switch on; `manual`: "Review secrets" asked for it), then #110 whether it also tells the
   * worker to leave (round 4: the check reads the protected values' references, and what follows is sent with its
   * hand-over), then the send, seen through the bridge's answer (a stale review is reviewed again, never sent on its
   * own). Resolves whether it went.
   */
  private async submit(s: Sitting, t: string, manual: boolean): Promise<boolean> {
    const live = () => this.s === s;
    const flow = this.host.secrets;
    const check = this.host.packup;
    // (Stood up meanwhile: nothing of it goes, no review opens.)
    const req = { key: s.id, text: t, target: s.name, manual, action: packupAction(check, s.id), live };
    let go: Go = { kind: 'send', protects: 0, shown: t, review: null };
    const kept = (why: string, message: string) => {
      if (!live()) return false;
      this.host.status(why === 'failed' ? 'error' : 'ok', why === 'cancel' ? 'Not sent: the prompt is still in the box.' : message);
      // The review had the keyboard: back to the box, its draft still in it.
      queueMicrotask(() => live() && this.focusPrompt());
      return false;
    };
    if (flow && (flow.on || manual)) {
      this.reviewing = true;
      this.host.status('ok', manual ? 'Opening the review of its secrets…' : 'Looking for secrets in the prompt…');
      const out = await flow.review(req).finally(() => (this.reviewing = false));
      if (!live()) return false;
      if (out.kind === 'kept') return kept(out.why, out.message);
      this.host.status('ok', null);
      go = out;
    }
    if (check?.applies(s.id)) {
      const abort = new AbortController();
      this.checking = abort;
      this.host.status('ok', 'Checking the prompt…');
      const step = await packupStep(check, flow, req, go, abort.signal);
      if (this.checking === abort) this.checking = null;
      if (abort.signal.aborted || !live()) return false;
      if (step.kind === 'kept') return kept(step.why, step.message);
      if (step.kind === 'done') {
        this.host.status('ok', `Sent the task to ${s.name}: it goes home once it reports CLEAN`);
        return true;
      }
      if (step.kind === 'cancel') {
        this.host.status('ok', null);
        // The confirm (or the send home) had the keyboard: back to the box, its draft still in it.
        queueMicrotask(() => live() && this.focusPrompt());
        return false;
      }
      this.host.status('ok', null);
      if (step.kind === 'handover') {
        // The text the check read, with its hand-over: refused as stale, nothing went (its files may be gone).
        const r = await this.sendPrompt(s, step.text, null, step.pending);
        if (!r.ok && (r.code === 'secrets_review_stale' || r.code === 'secrets_review_off')) return kept('failed', HANDOVER_STALE);
        return r.ok;
      }
      go = step.go;
    }
    if (!flow) return (await this.sendPrompt(s, t)).ok;
    const d = await flow.deliver(req, go, (g) => this.sendPrompt(s, t, g));
    return d.kind === 'kept' ? kept(d.why, d.message) : d.result.ok;
  }

  /**
   * #108 round 4: an answer's texts reviewed before it goes (with the switch on, or `manual`: the card's "Review
   * secrets"), each alone, and sent with a review per text (`send`); a stale review is reviewed again. Kept (the review
   * cancelled, the switch changed): nothing went, and the card keeps the answer and says why (`secrets_kept`).
   */
  private async answered(s: Sitting, what: string, fields: FieldText[], manual: boolean, send: (g: GoFields | null) => Promise<CommandResult>): Promise<CommandResult> {
    const flow = this.host.secrets;
    const live = () => this.s === s;
    // Stood up while it was scanned or reviewed again: nothing went, and nothing changes. (Not `stale`: that is the bridge's
    // "the question moved on", for which a follow-up card drops its draft, which the next seat would miss.)
    const kept = (why: string, message: string): CommandResult =>
      why === 'gone' ? { ok: false, code: 'gone', message: 'You got up.' } : { ok: false, code: 'secrets_kept', message: why === 'cancel' ? 'Not sent: the review was cancelled. Your answer is still here.' : message };
    if (manual && !fields.length) return kept('failed', 'Nothing typed to review: pick or write an answer first.');
    if (!flow || !(flow.on || manual) || !fields.length) return send(null);
    const req = { key: `${s.id}:${what}`, target: s.name, manual, fields, live };
    const go = await flow.reviewFields(req);
    if (go.kind === 'kept') return kept(go.why, go.message);
    const d = await flow.deliverFields(req, go, send);
    return d.kind === 'kept' ? kept(d.why, d.message) : d.result;
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
    const hireHandoff = this.host.hireHandoff;
    const follow = this.host.scheduleFollowup;
    return {
      loading: !s.acked || s.items.length > 0, // #126: till the ack, or the items it brought are in
      ...(handoff ? { onHandoff: (c: HandoffCandidate) => live() && handoff(s.id, c) } : {}),
      ...(hireHandoff ? { onHireHandoff: (c: HandoffCandidate) => live() && hireHandoff(s.id, c) } : {}),
      ...(follow ? { onScheduleFollowup: (c: HandoffCandidate, sug?: ScheduleSuggestion) => live() && follow(s.id, c, sug) } : {}),
      // #66: the chip's ×: the suggestion goes for good (the upsert takes the chip away).
      onDismissScheduleSuggestion: async (sug: ScheduleSuggestion) => {
        if (!live()) return { ok: false, code: 'stale', message: 'You got up.' };
        const r = await this.host.send('worker.dismiss_schedule_suggestion', { id: s.id, suggestion: sug.id });
        if (r.ok) return { ok: true };
        const message = failureText('worker.dismiss_schedule_suggestion', r.code, r.message, { worker: s.name });
        if (live() && r.code !== 'stale') this.host.status('error', message);
        return { ok: false, code: r.code, message };
      },
      onCommandCardView: (inView: boolean) => {
        s.commandCardInView = inView;
        if (live()) this.host.commandCardView?.(inView);
      },
      commandRequest: { worker: s.id, name: () => s.name, host: () => this.host.manualHost?.() ?? '', start: (args) => this.host.send('manual_process.start', args), dismiss: (key) => this.host.send('worker.dismiss_command_request', { id: s.id, key }), edit: (command, cwd) => this.host.manualEntry?.(s.id, command, cwd) },
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
      // #187: the ask's picks, and the questions the sheet opened for, kept for the worker's next view.
      askDrafts: { get: (a) => this.askDrafts.get(s.id, a), set: (a, picks) => this.askDrafts.set(s.id, a, picks), clear: (id) => this.askDrafts.clear(s.id, id) },
      opened: this.openedOf(s.id),
      files: { id: s.id, search: { send: (t, args) => this.host.send(t, args) } },
      // #247: `@r:` lists the repositories and folders of the other floors (#54: and the ones the bridge discovered).
      repos: { id: s.id, search: { send: (t, args) => this.host.send(t, args), refs: this.host.repoRefs ?? null, discovery: this.host.repoDiscovery ?? null, ...(this.host.floorName ? { floorName: (id: string) => this.host.floorName?.(id) ?? id } : {}) } },
      // #31: read when a file reference opens (the checkout may come or change while you sit).
      cwd: () => this.host.cwd?.(s.id) ?? null,
      // #108: the switch, for the box's "Review secrets".
      secrets: this.host.secrets ?? null,
      // #108 round 4: read as a row is drawn (the snapshot can bring it after the seat).
      secretsDir: () => this.host.secretsDir?.() ?? null,
      onPromptSubmit: (text, o) => {
        if (!live()) return Promise.resolve(false);
        const t = text.replace(/\u0000/g, '');
        if (!t.trim()) return Promise.resolve(false);
        if (bytes(t) > MAX_PROMPT) {
          this.host.status('error', 'That prompt is over 16 KiB: send less at a time.');
          return Promise.resolve(false);
        }
        // #58: one on its way at a time (a second Enter while it is sending sends nothing). #110: nor while one is checked.
        // #141: nor while one from an earlier seat at this worker is. #108: nor while one is reviewed.
        if (s.pending.some((p) => p.state === 'sending') || this.prompting.has(s.id) || this.checking || this.reviewing) return Promise.resolve(false);
        return this.submit(s, t, o?.review === true);
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
      onAnswerAsk: async (args, o) => {
        if (!live()) return { ok: false, code: 'stale', message: 'You got up.' };
        const r = await this.answered(s, `ask:${args.tool_use_id}`, askFields(args), o?.review === true, (g) => this.host.send('worker.answer_ask', { ...args, id: s.id, ...(g?.secrets ? { secrets: g.secrets } : {}) }));
        if (r.ok) {
          const ack = (r.data ?? {}) as Partial<AnswerAskAck>;
          if (live() && ack.resolved) this.host.status('ok', args.cancel ? `Dismissed ${s.name}’s question` : `Answered ${s.name}`);
          return { ok: true, resolved: ack.resolved === true };
        }
        const message = failureText('worker.answer_ask', r.code, r.message, { worker: s.name });
        if (live() && r.code !== 'stale') this.host.status('error', message);
        return { ok: false, code: r.code, message };
      },
      onAnswerFollowup: async (args, o) => {
        if (!live()) return { ok: false, code: 'stale', message: 'You got up.' };
        const r = await this.answered(s, `followup:${args.turn_id}`, followupFields(args), o?.review === true, (g) => this.host.send('worker.answer_followup', { ...args, id: s.id, ...(g?.secrets ? { secrets: g.secrets } : {}) }));
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
      // #60: a fallback's questions read again (the upsert brings them), and the message they are of. The card says
      // why a retry was refused.
      onRetryFollowup: async (turnId) => {
        if (!live()) return { ok: false, code: 'stale', message: 'You got up.' };
        const r = await this.host.send('worker.retry_followup', { id: s.id, turn_id: turnId });
        if (r.ok) return { ok: true };
        return { ok: false, code: r.code, message: failureText('worker.retry_followup', r.code, r.message, { worker: s.name }) };
      },
      loadFollowupMessage: async (turnId) => {
        const r = await this.host.send('worker.followup_message', { id: s.id, turn_id: turnId });
        if (!r.ok) return { ok: false, code: r.code, message: failureText('worker.followup_message', r.code, r.message, { worker: s.name }) };
        const d = (r.data ?? {}) as Partial<FollowupMessageAck>;
        return typeof d.text === 'string' ? { ok: true, text: d.text, cut: d.cut === true } : { ok: false, code: 'bad_response', message: 'The bridge sent no message.' };
      },
      followupDrafts: {
        get: (turn) => this.followupDrafts.get(s.id, turn),
        set: (turn, d) => this.followupDrafts.set(s.id, turn, d),
        clear: (turn) => this.followupDrafts.clear(s.id, turn),
      },
      // #157: a Codex worker's async questions. Refused, the card keeps the answer and says why (the seat bar too, but
      // not for `stale`: the question had moved on already, which the card says calmly).
      onAnswerAsync: async (args, o) => {
        if (!live()) return { ok: false, code: 'stale', message: 'You got up.' };
        const r = await this.answered(s, `async:${args.thread}:${args.batch}`, asyncFields(args), o?.review === true, (g) => this.host.send('worker.answer_async', { ...args, id: s.id, ...(g?.secrets ? { secrets: g.secrets } : {}) }));
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
        const timeline = s.timeline;
        const r = await this.host.send('transcript.page', { id: s.id, before: '', agent: agentId, limit: SUBAGENT_LIMIT });
        if (!live() || s.timeline !== timeline) return [];
        if (!r.ok) throw new Error(failureText('transcript.page', r.code, r.message, { worker: s.name }));
        const items = subagentItems(r.data);
        // Their images are the bridge's to serve (it authorized them in this page); the feed asks for nothing else, and
        // says whose log to read.
        this.host.feed(s.id)?.note(items, agentId);
        return items;
      },
      // #171: a change the list cut, in full (a subagent's: with its agent).
      loadItem: async (itemId, agent) => {
        const timeline = s.timeline;
        const r = await this.host.send('transcript.item', { id: s.id, item: itemId, ...(agent ? { agent } : {}) });
        if (!live() || s.timeline !== timeline) return null;
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
    if (this.host.focusHeld?.()) return;
    if (s.mode === 'runs') return this.host.runs?.focus();
    const view = s.mode === 'images' ? s.tab : (s.child?.view ?? (s.child ? null : s.view));
    if (view) view.focus();
    else if (typeof b.focus === 'function') b.focus({ preventScroll: true });
  }

  /** Enter in transcript mode: to the prompt box (a child's view has none). */
  focusPrompt(): void {
    if (this.s?.mode === 'transcript' && !this.s.child) this.s.view?.focusPrompt();
  }

  /**
   * #216: the files drawer's Enter: a file chip for `path` (a folder's with `dir`) into the seated worker's prompt box, at
   * its remembered caret (in place of a selection), and a space after it, as the box's own `@` completion inserts one;
   * then the conversation (its worker's: a child's has no box), the box's keyboard with `focus` (else the keyboard stays
   * where it is: the drawer, for the next one). Null when it went in, else why not (a prompt on its way: the box is read only).
   */
  insertFileRef(path: string, dir: boolean, focus = true): string | null {
    const s = this.s;
    if (!s) return 'You are not at a laptop.';
    if (this.drafts.sending(s.id).busy || s.pending.some((p) => p.state === 'sending')) return 'A prompt is on its way: the prompt box takes the reference once it is sent.';
    const draft = this.drafts.get(s.id, s.name);
    const sel = draft.selection;
    draft.insertParts(sel.anchor, sel.focus, [{ kind: 'file', path, dir }, ' ']);
    this.closeChild();
    if (s.mode !== 'transcript') this.setMode('transcript');
    if (!focus) return null;
    if (s.view) this.focusPrompt();
    else s.promptLater = true;
    return null;
  }

  // ---- #26: a native child's conversation -----------------------------------------------

  /** The child open over the seated worker's conversation (its watch's target), or null. */
  get child(): TranscriptChild | null {
    return this.s?.child?.target ?? null;
  }

  /** The open child's name (null: none open). */
  get childName(): string | null {
    return this.s?.child?.info.name ?? null;
  }

  /** The open child's timeline length and what its watch said (test hook). */
  get childState(): { id: string; items: number; availability: TranscriptAvailability | null; hasMore: boolean; mounted: boolean } | null {
    const c = this.s?.child;
    return c ? { id: c.target.id, items: c.items.length, availability: c.availability, hasMore: c.hasMore, mounted: !!c.view } : null;
  }

  /**
   * Opens a child's conversation over the seated worker's (whose view, scroll and pages stay as they are underneath): the
   * conversation mode, read only, with a breadcrumb back. Another child open is closed first.
   */
  openChild(target: TranscriptChild, info: ChildInfo): void {
    const s = this.s;
    if (!s) return;
    const open = s.child;
    if (open && open.target.id === target.id && open.target.generation === target.generation) {
      this.childSeen(info);
    } else {
      this.dropChild(s);
      s.child = { target, info, items: [], index: new Map(), cursor: '', hasMore: false, availability: null, view: null, pane: null, mounting: false, loader: null };
      this.host.childChanged?.();
    }
    if (s.mode !== 'transcript') this.setMode('transcript', false);
    else this.show(s);
    this.visible(s);
  }

  /**
   * Back to the worker's own conversation, as it was (`status`: why, on the seat bar: the child went, its worker's
   * session was replaced). False when no child was open.
   */
  closeChild(status: { kind: 'ok' | 'error'; text: string } | null = null): boolean {
    const s = this.s;
    if (!s?.child) return false;
    this.dropChild(s);
    this.host.childChanged?.();
    if (status) this.host.status(status.kind, status.text);
    if (s.mode === 'transcript') this.show(s);
    this.visible(s);
    return true;
  }

  /** #187: tells the worker's view whether it is the one on the screen (its questions' sheet waits while it is not). */
  private visible(s: Sitting): void {
    s.view?.setVisible?.(s.mode === 'transcript' && !s.child);
  }

  /** #187: worker's questions the sheet opened for (the last OPENED_KEPT). */
  private openedOf(worker: string): OpenedAsks {
    return {
      has: (id) => this.opened.get(worker)?.includes(id) ?? false,
      add: (id) => {
        const ids = (this.opened.get(worker) ?? []).filter((x) => x !== id);
        ids.push(id);
        this.opened.set(worker, ids.slice(-OPENED_KEPT));
      },
    };
  }

  /** The open child's row as the store has it now (every frame): its state on the breadcrumb. */
  childSeen(info: ChildInfo): void {
    const c = this.s?.child;
    if (!c) return;
    const was = c.info;
    c.info = info;
    if (was.state !== info.state || was.since !== info.since) this.childDrawn(c);
  }

  private dropChild(s: Sitting): void {
    const c = s.child;
    if (!c) return;
    s.child = null;
    if (c.view) {
      c.view.destroy();
      this.counts.destroyed++;
    }
    c.pane?.remove();
  }

  private showChild(s: Sitting, c: ChildSitting): void {
    if (s.viewPane) s.viewPane.hidden = true;
    if (s.tabPane) s.tabPane.hidden = true;
    if (c.pane) c.pane.hidden = false;
    if (c.view) {
      this.focus();
      return;
    }
    if (c.mounting) return;
    c.mounting = true;
    // #126: as the worker's: the child's conversation opening, while the module loads.
    const pane = c.pane ?? this.pane(s);
    c.pane = pane === s.box ? null : pane;
    c.loader ??= this.host.loading?.(c.info.name) ?? null;
    if (c.loader) pane.append(c.loader);
    const gen = s.gen;
    const done = (mount: MountTranscript | null) => {
      if (this.s?.gen !== gen || this.s.child !== c || !this.s.box) return;
      c.mounting = false;
      c.loader?.remove();
      c.loader = null;
      if (!mount) {
        this.closeChild({ kind: 'error', text: 'The transcript view did not load: try again.' });
        return;
      }
      if (c.pane) c.pane.hidden = s.mode !== 'transcript';
      c.view = mount(pane, this.childHost(s, c));
      this.counts.mounted++;
      c.view.setItems([...c.items]);
      this.childDrawn(c);
      if (s.mode === 'transcript') this.focus();
    };
    void this.host.renderer().then(done, () => done(null));
  }

  private childDrawn(c: ChildSitting): void {
    const st: ChildViewState = { state: c.info.state, since: c.info.since, availability: c.availability, hasMore: c.hasMore };
    c.view?.setChild?.(st);
  }

  /** The render host of a child's view: read only (nothing goes to the worker from it), its reads by its target. */
  private childHost(s: Sitting, c: ChildSitting): TranscriptRenderHost {
    const live = () => this.s === s && s.child === c;
    const no = { ok: false as const, code: 'unsupported', message: 'A subagent takes no answers here.' };
    const target = c.target;
    return {
      images: this.host.feed(s.id, target),
      label: s.name,
      loading: c.availability === null, // #126
      ...(this.host.prefs ? { prefs: this.host.prefs } : {}),
      cwd: () => this.host.cwd?.(s.id) ?? null,
      onPromptSubmit: () => Promise.resolve(false),
      onAnswer: () => {},
      onAnswerAsk: () => Promise.resolve(no),
      onSwitchToTerminal: () => {
        if (live()) this.setMode('terminal');
      },
      loadSubagent: () => Promise.reject(new Error('A subagent’s own subagents open from the floor overview.')),
      loadItem: async (itemId) => {
        const r = await this.host.send('transcript.item', { id: s.id, item: itemId, child: target });
        if (!r.ok) throw new Error(failureText('transcript.item', r.code, r.message, { worker: s.name }));
        const items = itemsOf([(r.data as { item?: unknown } | null)?.item]);
        if (items.length) this.host.feed(s.id, target)?.note(items);
        return items[0] ?? null;
      },
      child: {
        worker: s.name,
        name: c.info.name,
        type: c.info.type ?? null,
        description: c.info.description ?? null,
        onBack: () => {
          if (live()) this.closeChild();
        },
        loadOlder: () => this.childOlder(s, c),
      },
    };
  }

  /** The open child's older items, before its cursor, merged into its timeline by `seq`. */
  private async childOlder(s: Sitting, c: ChildSitting): Promise<void> {
    if (!c.hasMore || !c.cursor) return;
    const r = await this.host.send('transcript.page', { id: s.id, before: c.cursor, limit: REVEAL_LIMIT, child: c.target });
    if (this.s !== s || s.child !== c) return;
    if (!r.ok) {
      this.host.status('error', failureText('transcript.page', r.code, r.message, { worker: s.name }));
      return;
    }
    const d = typeof r.data === 'object' && r.data !== null ? (r.data as Record<string, unknown>) : {};
    const got = itemsOf(d.items);
    this.host.feed(s.id, c.target)?.note(got);
    c.cursor = typeof d.cursor === 'string' && d.cursor ? d.cursor : c.cursor;
    c.hasMore = d.has_more === true && got.length > 0;
    const known = new Set(c.items.map((it) => it.id));
    c.items = [...got.filter((it) => !known.has(it.id)), ...c.items].sort((a, b) => a.seq - b.seq);
    c.index = new Map(c.items.map((it, i) => [it.id, i]));
    c.view?.setItems([...c.items]);
    this.childDrawn(c);
  }

  /** The open child of `id`'s watch for `child` (null: another child, another generation, or none open). */
  private childOf(id: string, child: TranscriptChild): ChildSitting | null {
    const c = this.s?.id === id ? this.s.child : null;
    return c && c.target.id === child.id && c.target.generation === child.generation ? c : null;
  }

  /** #26: a child watch's ack: its whole timeline, replaced, and what it said of its log. */
  resetChild(id: string, child: TranscriptChild, ack: TranscriptWatchAck): void {
    const c = this.childOf(id, child);
    if (!c) return;
    c.items = [...ack.items];
    c.index = new Map(c.items.map((it, i) => [it.id, i]));
    c.cursor = ack.cursor;
    c.hasMore = ack.has_more;
    c.availability = ack.availability ?? (ack.pending ? 'pending' : 'available');
    c.view?.setItems([...c.items]);
    c.view?.setLoading?.(false); // #126
    this.childDrawn(c);
  }

  /** #26: a child watch's push: new items and replacements; a head says where its log is now. */
  pushChild(id: string, child: TranscriptChild, items: TranscriptItem[], updates: TranscriptItem[], head?: PushHead): void {
    const c = this.childOf(id, child);
    if (!c) return;
    if (head) {
      if (head.availability) c.availability = head.availability;
      else if (head.pending === false) c.availability = 'available';
      if (head.cursor !== undefined) c.cursor = head.cursor;
      if (head.has_more !== undefined) c.hasMore = head.has_more;
    }
    const changed = [...items, ...updates];
    for (const it of changed) {
      const at = c.index.get(it.id);
      if (at !== undefined) c.items[at] = it;
      else {
        c.index.set(it.id, c.items.length);
        c.items.push(it);
      }
    }
    if (changed.length) c.view?.applyUpdates(changed);
    if (head) this.childDrawn(c);
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
    // #192: a pending identity or rollout keeps the loading state until its first push.
    s.acked = !ack.pending;
    s.view?.setLoading?.(ack.pending);
    this.itemsChanged(s, s.items);
  }

  /** Live: new items and replacements, both by `id` (a new item already here replaces it). */
  push(id: string, items: TranscriptItem[], updates: TranscriptItem[], head?: PushHead): void {
    const s = this.s;
    if (s?.id !== id) return;
    if (head) this.timeline(s, head);
    if (head?.pending === false || items.length > 0 || updates.length > 0) {
      s.acked = true;
      s.view?.setLoading?.(false);
    }
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
    const key = f ? JSON.stringify(f) : ''; // #60: a retry changes its source, why and count too
    if (key === s.followupKey) return;
    s.followupKey = key;
    s.followup = f;
    s.view?.setFollowup(f);
  }

  /** #213: the seated worker's command card is in the conversation's view (the conversation is the view, and it scrolled there). */
  get commandCardInView(): boolean {
    return this.s?.mode === 'transcript' && !this.s.child && this.s.commandCardInView;
  }

  /** #213: to the conversation, the card into view and its first action focused (asked for: never on its own). */
  revealCommandRequest(): void {
    const s = this.s;
    if (!s?.commandRequest) return;
    if (s.child) this.closeChild();
    this.setMode('transcript');
    // A view that mounts later (its module still loading) reveals it when it gets the request.
    if (s.view) s.view.revealCommandRequest?.();
    else s.revealCard = true;
  }

  commandRequestSeen(r: import('../net/protocol').CommandRequest | null): void {
    const s = this.s; if (!s) return;
    const key = r ? JSON.stringify(r) : '';
    if (key === s.commandRequestKey) return;
    s.commandRequestKey = key; s.commandRequest = r; s.view?.setCommandRequest?.(r);
  }

  /** #66: the worker's schedule suggestion (from the store; null when it has none). */
  suggestionSeen(sug: ScheduleSuggestion | null): void {
    const s = this.s;
    if (!s) return;
    const key = sug ? `${sug.id}\u0000${sug.message ?? ''}\u0000${sug.due_at}` : '';
    if (key === s.suggestionKey) return;
    s.suggestionKey = key;
    s.suggestion = sug;
    s.view?.setScheduleSuggestion?.(sug);
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

/**
 * #26: why an open child's conversation ends, for the seat bar, as the view goes back to its worker's: its worker's
 * session was replaced (`stale` refusal, `session_changed` close, a new generation in the store), the child went (`not_found`
 * refusal, its row gone), a bridge before #26 (`bad_request`: it knows no `child`), too many followed. Null: nothing to
 * say (the worker left or its floor sleeps: the seat says so).
 */
export function childEndText(why: string, worker: string, message = ''): { kind: 'ok' | 'error'; text: string } | null {
  switch (why) {
    case 'stale':
    case 'session_changed':
      return { kind: 'ok', text: `${worker} started a new session: its subagents went with the old one` };
    case 'not_found':
      return { kind: 'ok', text: `That subagent is no longer listed: back to ${worker}’s conversation` };
    case 'bad_request':
      return { kind: 'error', text: 'This herdr-world can’t open a subagent’s conversation yet. Update the bridge to use it.' };
    case 'capacity':
      return { kind: 'error', text: 'herdr-world is following as many subagent conversations as it allows. Try again in a moment.' };
    case 'worker_removed':
    case 'asleep':
    case 'evicted':
      return null;
  }
  return { kind: 'error', text: failureText('transcript.watch', why, message, { worker }) };
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
