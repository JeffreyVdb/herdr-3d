import type { CommandResult } from '../net/client';
import type { CommandArgs, Question, TranscriptItem, TranscriptWatchAck } from '../net/protocol';
import { failureText } from '../ui/messages';
import { MAX_PROMPT } from './keys';
import { itemsOf } from './transcriptWatches';

// The render module's side (`transcriptRender.ts`, M16): what the seated view calls it with. Declared here to the
// agreed shapes so the shell builds on its own; the module is loaded lazily (`loadRenderer`).

export interface TranscriptRenderHost {
  onPromptSubmit(text: string): void;
  onAnswer(hash: string, choice: number | null, cancel?: boolean): void;
  onSwitchToTerminal(): void;
  loadSubagent(agentId: string): Promise<TranscriptItem[]>;
}

export interface BlockedQuestion {
  kind: string;
  text: string;
  excerpt: string[];
  choices: { n: number; label: string }[];
  selected?: number;
  hash: string;
}

export interface TranscriptView {
  setItems(items: TranscriptItem[]): void;
  applyUpdates(items: TranscriptItem[]): void;
  setBlocked(q: BlockedQuestion | null): void;
  focusPrompt(): void;
  destroy(): void;
}

export type MountTranscript = (container: HTMLElement, host: TranscriptRenderHost) => TranscriptView;

/** The render module, loaded on the first switch to the transcript (it brings markdown and sanitising along); null when the build has none. */
export async function loadRenderer(): Promise<MountTranscript | null> {
  const mods = import.meta.glob('./transcriptRender.ts');
  const load = Object.values(mods)[0];
  if (!load) return null;
  const mod = (await load()) as { mountTranscript?: unknown };
  return typeof mod.mountTranscript === 'function' ? (mod.mountTranscript as MountTranscript) : null;
}

/** What you look at while seated: the live terminal, or the worker's conversation drawn over the monitor. */
export type SeatMode = 'terminal' | 'transcript';

/** The overlay's box over the monitor, in CSS px of the viewport. */
export interface OverlayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TranscriptModeHost {
  send<T extends 'worker.prompt' | 'worker.answer' | 'transcript.item'>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  /** Loads the render module (`loadRenderer`; tests pass a fake). */
  renderer(): Promise<MountTranscript | null>;
  /** A new, empty, hidden overlay element in the HUD; the controller removes it (`remove()`). */
  overlay(): HTMLElement;
  /** Where the last mode per worker is kept (null: nowhere, it lasts until the page reloads). */
  storage: Storage | null;
  /** The seat bar's note. */
  status(kind: 'ok' | 'error', text: string | null): void;
  /** The mode changed (the seat bar's toggle, the terminal watch's fps, the monitor's frame). */
  modeChanged(mode: SeatMode): void;
}

/** Remembered per worker: the ones last read in transcript mode (terminal is the default), newest last. */
const MODES_KEY = 'h3d.seat.transcript';
const MODES_MAX = 64;

function readModes(s: Storage | null): string[] {
  try {
    const v: unknown = JSON.parse(s?.getItem(MODES_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeModes(s: Storage | null, ids: string[]): void {
  try {
    if (ids.length) s?.setItem(MODES_KEY, JSON.stringify(ids.slice(-MODES_MAX)));
    else s?.removeItem(MODES_KEY);
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
  box: HTMLElement | null;
  view: TranscriptView | null;
  /** The render module is loading for this seat. */
  mounting: boolean;
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
  readonly counts = { mounted: 0, destroyed: 0, overlays: 0, removed: 0 };
  private rect: OverlayRect | null = null;

  constructor(private readonly host: TranscriptModeHost) {}

  get seated(): string | null {
    return this.s?.id ?? null;
  }

  get mode(): SeatMode {
    return this.s?.mode ?? 'terminal';
  }

  /** The overlay is up (transcript mode, seated). */
  get shown(): boolean {
    return this.s?.mode === 'transcript';
  }

  /** The overlay element while there is one (for focus checks). */
  get box(): HTMLElement | null {
    return this.s?.box ?? null;
  }

  get itemCount(): number {
    return this.s?.items.length ?? 0;
  }

  /** You sat at `id`: its last mode comes back (`canRead` false: the bridge has no transcripts, the terminal it is). */
  sit(id: string, name: string, canRead = true): void {
    this.stand();
    const mode: SeatMode = canRead && readModes(this.host.storage).includes(id) ? 'transcript' : 'terminal';
    this.s = { id, name, gen: ++this.gen, mode: 'terminal', items: [], index: new Map(), question: null, questionKey: '', box: null, view: null, mounting: false };
    if (mode === 'transcript') this.setMode('transcript', false);
    else this.host.modeChanged('terminal');
  }

  /** You stood up: the view goes, the overlay with it. */
  stand(): void {
    const s = this.s;
    if (!s) return;
    this.s = null;
    this.rect = null;
    if (s.view) {
      s.view.destroy();
      this.counts.destroyed++;
    }
    if (s.box) {
      s.box.remove();
      this.counts.removed++;
    }
  }

  toggle(): void {
    if (this.s) this.setMode(this.s.mode === 'terminal' ? 'transcript' : 'terminal');
  }

  setMode(mode: SeatMode, remember = true): void {
    const s = this.s;
    if (!s || s.mode === mode) return;
    s.mode = mode;
    if (remember) {
      const ids = readModes(this.host.storage).filter((x) => x !== s.id);
      if (mode === 'transcript') ids.push(s.id);
      writeModes(this.host.storage, ids);
    }
    if (mode === 'transcript') this.show(s);
    else if (s.box) s.box.hidden = true;
    this.host.modeChanged(mode);
  }

  private show(s: Sitting): void {
    if (!s.box) {
      s.box = this.host.overlay();
      this.counts.overlays++;
      this.applyRect(s.box);
    }
    s.box.hidden = false;
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

  private mounted(gen: number, mount: MountTranscript | null): void {
    const s = this.s;
    if (!s || s.gen !== gen || !s.box) return;
    s.mounting = false;
    if (!mount) {
      this.setMode('terminal', false);
      this.host.status('error', 'This build of the game has no transcript view.');
      return;
    }
    s.view = mount(s.box, this.renderHost(s));
    this.counts.mounted++;
    s.view.setItems([...s.items]);
    if (s.question) s.view.setBlocked(s.question);
    if (s.mode === 'transcript') this.focus();
  }

  private renderHost(s: Sitting): TranscriptRenderHost {
    const live = () => this.s === s;
    return {
      onPromptSubmit: (text) => {
        if (!live()) return;
        const t = text.replace(/\u0000/g, '');
        if (!t.trim()) return;
        if (bytes(t) > MAX_PROMPT) return this.host.status('error', 'That prompt is over 16 KiB: send less at a time.');
        void this.host.send('worker.prompt', { id: s.id, text: t }).then((r) => {
          if (!live()) return;
          if (r.ok) this.host.status('ok', `Sent to ${s.name}`);
          else this.host.status('error', failureText('worker.prompt', r.code, r.message, { worker: s.name }));
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
      onSwitchToTerminal: () => {
        if (live()) this.setMode('terminal');
      },
      loadSubagent: async (agentId) => {
        const r = await this.host.send('transcript.item', { id: s.id, item: agentId });
        if (!r.ok) throw new Error(failureText('transcript.item', r.code, r.message, { worker: s.name }));
        return subagentItems(r.data);
      },
    };
  }

  /** Focus to the transcript (its keys: scrolling, the prompt box). */
  focus(): void {
    const b = this.s?.box;
    if (b && !b.hidden && typeof b.focus === 'function') b.focus({ preventScroll: true });
  }

  /** Enter in transcript mode: to the prompt box. */
  focusPrompt(): void {
    this.s?.view?.focusPrompt();
  }

  // ---- the watch's sink ------------------------------------------------------------

  /** A watch's ack (the first, or a re-watch after `session_changed` / `resync`): the whole timeline, replaced. */
  reset(id: string, ack: TranscriptWatchAck): void {
    const s = this.s;
    if (s?.id !== id) return;
    s.items = [...ack.items];
    s.index = new Map(s.items.map((it, i) => [it.id, i]));
    s.view?.setItems([...s.items]);
  }

  /** Live: new items and replacements, both by `id` (a new item already here replaces it). */
  push(id: string, items: TranscriptItem[], updates: TranscriptItem[]): void {
    const s = this.s;
    if (s?.id !== id) return;
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
  }

  /** The watch ended for good (`worker_removed`, `asleep`, the connection): the overlay goes back to the terminal. */
  stop(id: string): void {
    const s = this.s;
    if (s?.id !== id) return;
    if (s.mode === 'transcript') this.setMode('terminal', false);
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

  /** Where the monitor's screen is this frame (null: off the view). */
  place(rect: OverlayRect | null): void {
    const same = (a: OverlayRect | null, b: OverlayRect | null) => a === b || (!!a && !!b && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height);
    if (same(rect, this.rect)) return;
    this.rect = rect;
    if (this.s?.box) this.applyRect(this.s.box);
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
  }
}

/** A `transcript.item` ack for a subagent: its timeline (`items`), or the one item it sent. */
export function subagentItems(data: unknown): TranscriptItem[] {
  if (typeof data !== 'object' || data === null) return [];
  const d = data as Record<string, unknown>;
  if (Array.isArray(d.items)) return itemsOf(d.items);
  if (d.item !== undefined) return itemsOf([d.item]);
  return itemsOf([d]);
}
