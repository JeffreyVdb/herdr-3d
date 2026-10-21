import type { CommandResult } from '../net/client';
import type { KeyItem } from '../net/protocol';

/**
 * M5: typing at a worker's laptop. A keydown becomes herdr logical keys
 * (`worker.keys` items: printable text as `{text}`, special keys as `{key}`
 * names from the contract's allowlist), stands you up (Esc), or starts a
 * paste (Cmd+V on a Mac, Ctrl+V elsewhere: the browser's paste event carries
 * the text), or swaps the terminal and the transcript (Ctrl+Esc, M16), or
 * zooms the text (#59: Ctrl + = / + / − / 0, which no pane gets: see
 * `zoomKey`), or goes to the terminal's preset and zoom controls (#59:
 * Ctrl+, as for an app's settings, see `LOOK_KEY`). Nothing a seated key does
 * reaches the game, except the command palette's chord (#147: ⌘/Ctrl+P, taken by the game before the pane sees it) and the
 * dictation bar's (#213: ⌘/Ctrl+Shift+Space, the same way). Pure logic.
 */

export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}

export interface SeatKey {
  /** What the pane gets. */
  items: KeyItem[];
  /**
   * `stand`: Esc gets you up; `paste`: the browser's paste event follows with the text; `toggle-transcript` (M16):
   * Ctrl+Esc swaps the terminal and the transcript; `zoom-in` / `zoom-out` / `zoom-reset` (#59): the text size;
   * `look` (#59): the keyboard to the seat bar's terminal preset and zoom; `palette` (#147): the command palette
   * (the game opens it from the capture phase; the pane never gets the chord); `dictate` (#213): the dictation bar, the same way;
   * `copy` (#176): Ctrl+Shift+C off a Mac copies the terminal's selection (as Linux terminals do; Ctrl+C stays ^C, and a
   * Mac's ⌘C is the browser's copy event).
   */
  action?: 'stand' | 'paste' | 'copy' | 'toggle-transcript' | 'look' | 'palette' | 'dictate' | ZoomAction;
  /** The browser must not act on it (Tab moving focus, Backspace, F5, Ctrl+W…). */
  prevent: boolean;
}

/** Special keys, by `KeyboardEvent.key`, and the herdr names they send. */
const NAMED: Record<string, string> = {
  Enter: 'enter',
  Tab: 'tab',
  Backspace: 'backspace',
  Delete: 'delete',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
};
for (let i = 1; i <= 12; i++) NAMED[`F${i}`] = `f${i}`;

/** Special keys with one modifier that herdr-world takes as a chord (the bridge's key table). */
const CHORDS: Record<string, Partial<Record<'shift' | 'ctrl' | 'alt', string>>> = {
  Enter: { shift: 'shift+enter', alt: 'alt+enter' },
  Backspace: { alt: 'alt+backspace' },
  ArrowUp: { shift: 'shift+up' },
  ArrowDown: { shift: 'shift+down' },
  ArrowLeft: { shift: 'shift+left', ctrl: 'ctrl+left', alt: 'alt+left' },
  ArrowRight: { shift: 'shift+right', ctrl: 'ctrl+right', alt: 'alt+right' },
};

/** Every key name the game sends (the contract's allowlist, `docs/protocol.md`). */
export const KEY_NAMES: readonly string[] = [
  ...new Set([
    ...Object.values(NAMED),
    ...Object.values(CHORDS).flatMap((c) => Object.values(c)),
    'esc',
    'shift+tab',
    'space',
    ...Array.from({ length: 26 }, (_, i) => `ctrl+${String.fromCharCode(97 + i)}`),
  ]),
];

/** Modifiers and locks alone: nothing to send, and the browser may keep them. */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock', 'Fn', 'FnLock', 'Hyper', 'Super', 'OS']);

const one = (key: string): SeatKey => ({ items: [{ key }], prevent: true });
const none = (prevent: boolean): SeatKey => ({ items: [], prevent });
const graphemes = new Intl.Segmenter();
/** One printable character (a grapheme); named keys ("Enter", "F13", "Insert") are longer. */
const printable = (k: string) => k.length > 0 && (k.length === 1 || [...graphemes.segment(k)].length === 1);

export type ZoomAction = 'zoom-in' | 'zoom-out' | 'zoom-reset';

/**
 * #59: Ctrl + = or + zooms in, Ctrl + − out, Ctrl + 0 back to 100% (the main keys and the keypad's). None of them
 * reaches a pane today (the Ctrl branch below sends ctrl+letter only), so taking them costs a pane nothing. Ctrl+_
 * (Ctrl+Shift+− on a US layout) is not one: it is readline's, zsh's, fish's and Claude Code's undo. Cmd stays the
 * browser's (a Mac's own zoom), as does Ctrl with Alt or Meta.
 */
export function zoomKey(e: KeyLike): ZoomAction | null {
  if (!e.ctrlKey || e.altKey || e.metaKey) return null;
  if (e.key === '=' || e.key === '+') return 'zoom-in';
  if (e.key === '-' && !e.shiftKey) return 'zoom-out';
  if (e.key === '0' && !e.shiftKey) return 'zoom-reset';
  return null;
}

/**
 * #59: Ctrl+, (settings, in many apps) takes the keyboard to the terminal's preset and zoom on the seat bar, in every
 * view, so they are reachable without the transcript (a bridge may not have one) and without taking Tab from the
 * pane. Like the zoom keys it sent a pane nothing before (the Ctrl branch below sends ctrl+letter only); on a Mac
 * Cmd+, stays the browser's settings. As `KeyboardEvent.key`: the comma wherever the layout puts it.
 */
export const LOOK_KEY = { key: ',', label: ['Ctrl', ','], aria: 'Control+,' } as const;

/** What a keydown does while you sit at a laptop (`mac`: Cmd is the command key, Ctrl goes to the pane). */
export function seatedKey(e: KeyLike, mac: boolean): SeatKey {
  // IME composition and dead keys: the composed text arrives as input (see `composedText`).
  if (e.isComposing || e.key === 'Process' || e.key === 'Dead' || e.key === 'Unidentified') return none(false);
  if (MODIFIERS.has(e.key)) return none(false);
  if (e.key === 'Escape') {
    if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) return one('esc');
    // M16: Ctrl+Esc (on a Mac too) swaps the terminal and the transcript; the other modified Escs do nothing.
    if (e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey) return { items: [], action: 'toggle-transcript', prevent: true };
    return e.ctrlKey || e.metaKey || e.altKey ? none(true) : { items: [], action: 'stand', prevent: true };
  }
  const zoom = zoomKey(e);
  if (zoom) return { items: [], action: zoom, prevent: true };
  if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.key === LOOK_KEY.key) return { items: [], action: 'look', prevent: true };
  const cmd = mac ? e.metaKey : e.ctrlKey;
  // #147: ⌘P / Ctrl+P is the command palette, as in VS Code's terminal: the pane loses readline's previous-history (↑ stays).
  if (cmd && !e.altKey && !e.shiftKey && (mac ? !e.ctrlKey : !e.metaKey) && e.code === 'KeyP') return { items: [], action: 'palette', prevent: true };
  // #213: ⌘⇧Space / Ctrl+Shift+Space is the dictation bar (the game's, from the capture phase): the pane never gets it.
  if (cmd && !e.altKey && e.shiftKey && (mac ? !e.ctrlKey : !e.metaKey) && e.code === 'Space') return { items: [], action: 'dictate', prevent: true };
  if (cmd && !e.altKey && e.code === 'KeyV') return { items: [], action: 'paste', prevent: false };
  // #176: Ctrl+Shift+C copies (Chrome's own chord for it opens the inspector, so it is kept from the browser).
  if (!mac && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyC') return { items: [], action: 'copy', prevent: true };
  // Cmd+← / → are the start and end of the line, as in a Mac terminal.
  if (mac && e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return one(e.key === 'ArrowLeft' ? 'home' : 'end');
  // The Mac's other Cmd shortcuts stay the browser's and the system's (copy, quit, …).
  if (e.metaKey) return none(false);
  if (e.key === 'Tab') return e.shiftKey ? one('shift+tab') : one('tab');
  const named = NAMED[e.key];
  if (named) {
    const mods = +e.shiftKey + +e.ctrlKey + +e.altKey;
    if (!mods) return one(named);
    const chord = mods === 1 ? CHORDS[e.key]?.[e.shiftKey ? 'shift' : e.ctrlKey ? 'ctrl' : 'alt'] : undefined;
    if (chord) return one(chord);
    // Shift with a key that has no shifted name (Shift+Home, Shift+F1): the key itself.
    return mods === 1 && e.shiftKey ? one(named) : none(true);
  }
  if (e.ctrlKey && !e.altKey) {
    // The letter on the key (AZERTY's A is ctrl+a); a layout without Latin letters falls back to the key's position.
    const letter = /^[a-z]$/i.test(e.key) ? e.key : /^Key([A-Z])$/.exec(e.code)?.[1];
    return letter ? one(`ctrl+${letter.toLowerCase()}`) : none(true);
  }
  // Printable text, Option/AltGr characters included.
  if (printable(e.key)) return { items: [{ text: e.key }], prevent: true };
  return none(true);
}

/** Text from an input or composition event (IME, dead keys) as items: control characters become keys. */
export function textItems(text: string): KeyItem[] {
  const out: KeyItem[] = [];
  let run = '';
  const flush = () => {
    if (run) out.push({ text: run });
    run = '';
  };
  for (const ch of text.replace(/\r\n?/g, '\n')) {
    if (ch === '\n') {
      flush();
      out.push({ key: 'enter' });
    } else if (ch === '\t') {
      flush();
      out.push({ key: 'tab' });
    } else if (/[\u0000-\u001f\u007f]/.test(ch)) {
      // Other control characters have no key name to go by: dropped.
    } else run += ch;
  }
  flush();
  return out;
}

/** The contract's limits for one `worker.keys`. */
export const MAX_ITEMS = 64;
export const MAX_TEXT_ITEM = 4096;
export const MAX_TEXT = 8192;
/** `worker.prompt` text limit (a paste). */
export const MAX_PROMPT = 16 * 1024;

const bytes = (s: string) => new TextEncoder().encode(s).length;

/** Appends `items`, merging consecutive text within the per-item limit (split on code points). */
export function mergeItems(into: KeyItem[], items: readonly KeyItem[]): void {
  for (const it of items) {
    const last = into.at(-1);
    if ('text' in it && last && 'text' in last && bytes(last.text) + bytes(it.text) <= MAX_TEXT_ITEM) {
      into[into.length - 1] = { text: last.text + it.text };
      continue;
    }
    if ('text' in it && bytes(it.text) > MAX_TEXT_ITEM) {
      let run = '';
      for (const ch of it.text) {
        if (bytes(run) + bytes(ch) > MAX_TEXT_ITEM) {
          into.push({ text: run });
          run = '';
        }
        run += ch;
      }
      if (run) into.push({ text: run });
      continue;
    }
    into.push(it);
  }
}

/** Takes the next command's worth of items: at most MAX_ITEMS, text at most MAX_TEXT in all. */
export function takeBatch(queue: KeyItem[]): KeyItem[] {
  const out: KeyItem[] = [];
  let text = 0;
  while (queue.length && out.length < MAX_ITEMS) {
    const it = queue[0] as KeyItem;
    const b = 'text' in it ? bytes(it.text) : 0;
    if (out.length && text + b > MAX_TEXT) break;
    text += b;
    out.push(it);
    queue.shift();
  }
  return out;
}

/** #176 part 2: a click on a cell (0-based) of the pane the seat owns, with herdr's modifier bits. */
export interface SeatClick {
  button: 'left' | 'right' | 'middle';
  column: number;
  row: number;
  modifiers: number;
}

/**
 * A prompt op: its text through the sender's `prompt`, or (#108, a paste reviewed for secrets) its own `send`. #176
 * part 2: a `paste` inserts its text (the sender's `paste`, or its own `send`) and a `click` clicks, both in order
 * with the keys around them.
 */
type Op =
  | { kind: 'keys'; items: KeyItem[] }
  | { kind: 'prompt' | 'paste'; text: string; send?: () => Promise<CommandResult> }
  | { kind: 'click'; click: SeatClick };

/** What an answer was for: typing, a paste as a prompt (`worker.prompt`), a paste inserted (`worker.paste`), a click. */
export type InputKind = 'keys' | 'prompt' | 'paste' | 'click';

export interface InputSender {
  keys(items: KeyItem[]): Promise<CommandResult>;
  prompt(text: string): Promise<CommandResult>;
  /** #176 part 2: `worker.paste` (inserted, never submitted) and `terminal.mouse`. */
  paste?(text: string): Promise<CommandResult>;
  click?(c: SeatClick): Promise<CommandResult>;
  /** Every answer, in order (the seat bar shows failures). */
  done(kind: InputKind, r: CommandResult): void;
}

/**
 * Seated input, in order, one command in flight at a time: keys typed while
 * one is on its way go out together in the next `worker.keys` (the natural
 * batch), a paste waits for the keys before it. `prompt` falls back to keys
 * for a plain shell (the bridge answers `worker.prompt` with `invalid_state`
 * there): the text typed, newlines as Enter.
 */
export class InputQueue {
  private readonly ops: Op[] = [];
  private busy = false;
  /** Commands sent (for tests): kind and item or byte counts, never the text. */
  sent = 0;

  constructor(
    private readonly out: InputSender,
    /** A worker without an agent (a plain shell) takes a paste as keys. */
    private readonly shell: () => boolean,
  ) {}

  get pending(): boolean {
    return this.busy || this.ops.length > 0;
  }

  keys(items: readonly KeyItem[]): void {
    if (!items.length) return;
    const last = this.ops.at(-1);
    if (last?.kind === 'keys') mergeItems(last.items, items);
    else {
      const op: Op = { kind: 'keys', items: [] };
      mergeItems(op.items, items);
      this.ops.push(op);
    }
    this.pump();
  }

  /** A paste: `worker.prompt` for an agent, typed keys for a plain shell. False when it is too long to send. */
  paste(text: string): boolean {
    const t = text.replace(/\u0000/g, '');
    if (!t) return true;
    if (this.shell()) {
      this.keys(textItems(t));
      return true;
    }
    if (bytes(t) > MAX_PROMPT) return false;
    this.ops.push({ kind: 'prompt', text: t });
    this.pump();
    return true;
  }

  /**
   * #176 part 2: a paste inserted where the terminal's cursor is (`worker.paste`: the seat owns the pane), for an
   * agent and a shell alike: nothing is submitted. False when it is too long to send.
   */
  insert(text: string): boolean {
    const t = text.replace(/\u0000/g, '');
    if (!t) return true;
    if (bytes(t) > MAX_PROMPT) return false;
    this.ops.push({ kind: 'paste', text: t });
    this.pump();
    return true;
  }

  /** #176 part 2: a click on the pane the seat owns, after what was typed before it. */
  click(c: SeatClick): void {
    this.ops.push({ kind: 'click', click: c });
    this.pump();
  }

  /**
   * #108: a paste whose possible secrets were reviewed: `send` sends it (the review's flow, which may ask for the review
   * again before it goes), in order with what was typed before it. Only an agent's paste is reviewed. `kind`: `paste`
   * when it is inserted (#176 part 2).
   */
  pasteReviewed(send: () => Promise<CommandResult>, kind: 'prompt' | 'paste' = 'prompt'): void {
    this.ops.push({ kind, text: '', send });
    this.pump();
  }

  /** Drops what has not been sent (you stood up). */
  clear(): void {
    this.ops.length = 0;
  }

  private pump(): void {
    if (this.busy) return;
    const op = this.ops[0];
    if (!op) return;
    this.busy = true;
    let p: Promise<CommandResult>;
    const kind: InputKind = op.kind;
    if (op.kind === 'keys') {
      const batch = takeBatch(op.items);
      if (!op.items.length) this.ops.shift();
      p = this.out.keys(batch);
    } else if (op.kind === 'click') {
      this.ops.shift();
      p = this.out.click ? this.out.click(op.click) : Promise.resolve(unsupported('terminal.mouse'));
    } else {
      this.ops.shift();
      p = op.send ? op.send() : op.kind === 'paste' ? (this.out.paste ? this.out.paste(op.text) : Promise.resolve(unsupported('worker.paste'))) : this.out.prompt(op.text);
    }
    this.sent++;
    void p.then((r) => {
      this.busy = false;
      this.out.done(kind, r);
      this.pump();
    });
  }
}

/** The answer of a command the sender has no way to send. */
function unsupported(cmd: string): CommandResult {
  return { ok: false, code: 'unknown_command', message: `${cmd} is not available here` };
}

/**
 * Seated input per worker. Standing up does not drop what you typed: the
 * worker's lane keeps sending what it accepted, in order, and goes once it
 * is empty; sitting down at that worker again types into the same lane,
 * behind it.
 */
export class InputLanes {
  private readonly lanes = new Map<string, InputQueue>();
  private seated: string | null = null;

  /** `make` builds a worker's lane; its sender calls `settled` after each answer. */
  constructor(private readonly make: (id: string, settled: () => void) => InputQueue) {}

  /** You sit at `id`: its lane (the one still sending for it, if any). */
  sit(id: string): InputQueue {
    this.stand();
    this.seated = id;
    let q = this.lanes.get(id);
    if (!q) {
      const lane = this.make(id, () => {
        if (this.seated !== id && !lane.pending && this.lanes.get(id) === lane) this.lanes.delete(id);
      });
      q = lane;
      this.lanes.set(id, q);
    }
    return q;
  }

  /** You stood up: the lane goes once it has sent what it has. */
  stand(): void {
    const id = this.seated;
    this.seated = null;
    if (id !== null && !this.lanes.get(id)?.pending) this.lanes.delete(id);
  }

  /** Workers whose lanes still send after you stood up (tests). */
  draining(): string[] {
    return [...this.lanes.keys()].filter((id) => id !== this.seated);
  }

  /** Drops everything not sent yet (the game goes away). */
  clear(): void {
    for (const q of this.lanes.values()) q.clear();
    this.lanes.clear();
    this.seated = null;
  }
}
