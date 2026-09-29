import type { CommandResult } from '../net/client';
import type { KeyItem } from '../net/protocol';

/**
 * M5: typing at a worker's laptop. A keydown becomes herdr logical keys
 * (`worker.keys` items: printable text as `{text}`, special keys as `{key}`
 * names from the contract's allowlist), stands you up (Esc), or starts a
 * paste (Cmd+V on a Mac, Ctrl+V elsewhere: the browser's paste event carries
 * the text). Nothing a seated key does reaches the game. Pure logic.
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
  /** `stand`: Esc gets you up; `paste`: the browser's paste event follows with the text. */
  action?: 'stand' | 'paste';
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

/** Every key name the game sends (the contract's allowlist, `docs/protocol.md`). */
export const KEY_NAMES: readonly string[] = [
  ...new Set([
    ...Object.values(NAMED),
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

/** What a keydown does while you sit at a laptop (`mac`: Cmd is the command key, Ctrl goes to the pane). */
export function seatedKey(e: KeyLike, mac: boolean): SeatKey {
  // IME composition and dead keys: the composed text arrives as input (see `composedText`).
  if (e.isComposing || e.key === 'Process' || e.key === 'Dead' || e.key === 'Unidentified') return none(false);
  if (MODIFIERS.has(e.key)) return none(false);
  if (e.key === 'Escape') return e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey ? one('esc') : e.ctrlKey || e.metaKey || e.altKey ? none(true) : { items: [], action: 'stand', prevent: true };
  const cmd = mac ? e.metaKey : e.ctrlKey;
  if (cmd && !e.altKey && e.code === 'KeyV') return { items: [], action: 'paste', prevent: false };
  // The Mac's Cmd shortcuts stay the browser's and the system's (copy, quit, …).
  if (e.metaKey) return none(false);
  if (e.key === 'Tab') return e.shiftKey ? one('shift+tab') : one('tab');
  const named = NAMED[e.key];
  if (named && !e.ctrlKey && !e.altKey) return one(named);
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

type Op = { kind: 'keys'; items: KeyItem[] } | { kind: 'prompt'; text: string };

export interface InputSender {
  keys(items: KeyItem[]): Promise<CommandResult>;
  prompt(text: string): Promise<CommandResult>;
  /** Every answer, in order (the seat bar shows failures). */
  done(kind: 'keys' | 'prompt', r: CommandResult): void;
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
    let kind: 'keys' | 'prompt';
    if (op.kind === 'keys') {
      kind = 'keys';
      const batch = takeBatch(op.items);
      if (!op.items.length) this.ops.shift();
      p = this.out.keys(batch);
    } else {
      kind = 'prompt';
      this.ops.shift();
      p = this.out.prompt(op.text);
    }
    this.sent++;
    void p.then((r) => {
      this.busy = false;
      this.out.done(kind, r);
      this.pump();
    });
  }
}
