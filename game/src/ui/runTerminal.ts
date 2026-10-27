import './runTerminal.css';
import type { CommandResult } from '../net/client';
import type { CommandArgs, ConnMessage, ManualProcess } from '../net/protocol';
import { SeatTerminal } from '../laptop/seatTerm';
import { seatedKey } from '../laptop/keys';
import { attentionLabel, attentionOf, detectionNote } from '../world/manualProcess';
import { h } from './dom';
import { failureText } from './messages';

/**
 * #216: a manual run's live terminal (`mp:<id>`), one component for the processes dialog and the seat's Runs view, and
 * the broker that lets them share a run.
 *
 * The bridge's watch rules decide the broker's shape (internal/server/term.go, termcontrol.go, mpterm.go; the fixture,
 * tools/fixture-screen.ts):
 * - A connection has at most one watch per id: a second `terminal.watch` of the same id replaces the first (the old one
 *   is cancelled, the new one starts with a full frame), and one `terminal.unwatch` ends it whoever asked for it. Two
 *   surfaces watching the same run on one connection would each tear the other's watch down.
 * - `terminal.input` and `terminal.resize` of a run need this connection's control watch of it, and a connection holds
 *   at most one control watch of a manual run at a time, across every run id (`controls()`: a second one is refused as
 *   `capacity`; the worker terminals count separately, so the seat's own terminal never competes). The fixture enforces
 *   this only for worker ids, so the e2e specs would not notice two live run terminals: the broker does it.
 * So one surface holds the keyboard of one run at a time (the holder): it alone watches (with control and its own
 * size), resizes, scrolls and types, and it alone gets the run's frames and control messages. A surface that loses the
 * run shows a placeholder. The dialog's surface takes precedence: while it is mounted no seat surface can hold. When the
 * holder goes, the run goes back to the surface it took it from (the latest one still mounted; the dialog's first):
 * for the same run it watches again (a re-watch replaces, a full frame resyncs), so nothing is unwatched in between;
 * for another run the old one is unwatched first (one control watch per connection). Detaching never stops a run.
 */

type WatchCommand = 'terminal.watch' | 'terminal.unwatch' | 'terminal.resize' | 'terminal.scroll';
export type RunWatch = <T extends WatchCommand>(t: T, args: CommandArgs[T]) => Promise<CommandResult>;

/** One place a run's terminal is shown (the broker's view of a mounted `RunTerminalHandle`). */
export interface RunSurface {
  /** `mp:<process id>`. */
  readonly id: string;
  readonly kind: 'dialog' | 'seat';
  /** You hold the run now (again, or after a reconnect): watch it at your size; a full frame comes. */
  hold(): void;
  /** Another surface holds the run (or none may): stop sending, show the placeholder. Sends nothing to the bridge. */
  lose(): void;
  /** A connection message of the run, while you hold it. */
  message(m: ConnMessage): void;
}

/** Per connection: which surface holds the run terminal (one at a time, across every run id). */
export class RunTerminalBroker {
  private readonly surfaces: RunSurface[] = [];
  private current: RunSurface | null = null;

  constructor(private readonly watch: RunWatch) {}

  /** The surface holding a run now (tests, the seat's placeholder wording). */
  get holder(): RunSurface | null {
    return this.current;
  }

  /** Whether `s` may type, resize and watch now. */
  holds(s: RunSurface): boolean {
    return this.current === s;
  }

  /** A surface was mounted: the dialog's takes the run; a seat's takes it unless the dialog's is mounted. */
  add(s: RunSurface): void {
    if (!this.surfaces.includes(s)) this.surfaces.push(s);
    this.claim(s);
  }

  /** `s` asks for the run (its Show here, a focus): refused (it shows its placeholder) while the dialog's is mounted. */
  claim(s: RunSurface): boolean {
    if (!this.surfaces.includes(s)) return false;
    if (this.current === s) return true;
    if (s.kind === 'seat' && this.surfaces.some((x) => x !== s && x.kind === 'dialog')) {
      s.lose();
      return false;
    }
    const prev = this.current;
    this.current = s;
    if (prev) {
      prev.lose();
      // The other run's control watch goes first: the bridge allows one per connection.
      if (prev.id !== s.id) void this.watch('terminal.unwatch', { id: prev.id });
    }
    s.hold();
    return true;
  }

  /** A surface was disposed: the run goes back to the one it was taken from (if still mounted), else it is unwatched. */
  remove(s: RunSurface): void {
    const i = this.surfaces.indexOf(s);
    if (i < 0) return;
    this.surfaces.splice(i, 1);
    if (this.current !== s) return;
    this.current = null;
    const next = [...this.surfaces].reverse().find((x) => x.kind === 'dialog') ?? this.surfaces.at(-1) ?? null;
    if (!next || next.id !== s.id) void this.watch('terminal.unwatch', { id: s.id });
    if (next) {
      this.current = next;
      next.hold();
    }
  }

  /** A connection message: a run's goes to its holder only; every `mp:` one is the broker's (true), held or not. */
  onConn(m: ConnMessage): boolean {
    if (!('id' in m) || typeof m.id !== 'string' || !m.id.startsWith('mp:')) return false;
    if (this.current && this.current.id === m.id) this.current.message(m);
    return true;
  }

  /** A new connection (the old one's watches are gone): the holder watches again. */
  reconnect(): void {
    this.current?.hold();
  }
}

/** What a run terminal needs from the app. */
export interface RunTerminalHost {
  broker: RunTerminalBroker;
  input(args: CommandArgs['terminal.input']): Promise<CommandResult>;
  watch: RunWatch;
  /** A link's activation (Ctrl/⌘+click): the app's validated opener. */
  external(url: string): void;
}

export interface RunTerminalOptions {
  surface: 'dialog' | 'seat';
  /** Ctrl+Esc with the keyboard in the terminal: where the keyboard goes instead (the dialog's Back, the run rows). */
  releaseFocus(): void;
  /** Before any byte is sent: the seat's chords (Ctrl+Shift+1…4, Ctrl+Shift+E); true = handled, nothing goes to the run. */
  onKey?(e: KeyboardEvent): boolean;
  /** Shown while another surface holds the run; `takeBack` asks for it again (refused while the dialog holds it). */
  placeholder?: (takeBack: () => void) => HTMLElement;
  /** A failure or read-only notice ('' clears it). Without one the terminal shows it under itself. */
  onStatus?(text: string): void;
}

export interface RunTerminalHandle {
  /** Mount anywhere; it sizes to its container (no transforms). */
  readonly el: HTMLElement;
  /** This surface holds the run (types, resizes, gets frames). */
  readonly holding: boolean;
  /** State, attention and detection lines from the record. */
  update(p: ManualProcess): void;
  /** The keyboard into the process (the placeholder's button while another surface holds it). */
  focus(): void;
  /** Takes the run if another surface holds it, or shows the placeholder if that is not allowed. */
  activate(): void;
  /** Watches again (a new connection). */
  reconnect(): void;
  /** Releases the run (hands it back or unwatches); never stops the process. */
  dispose(): void;
}

const ended = (p: ManualProcess) => ['exited', 'stopped', 'failed'].includes(p.state);
const keyBytes: Record<string, string> = { enter: '\r', tab: '\t', 'shift+tab': '\x1b[Z', esc: '\x1b', backspace: '\x7f', delete: '\x1b[3~', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', home: '\x1b[H', end: '\x1b[F', pageup: '\x1b[5~', pagedown: '\x1b[6~', space: ' ', 'shift+enter': '\x1b[13;2u', 'alt+enter': '\x1b\r', 'alt+backspace': '\x1b\x7f', 'ctrl+left': '\x1b[1;5D', 'ctrl+right': '\x1b[1;5C', 'alt+left': '\x1b[1;3D', 'alt+right': '\x1b[1;3C', 'shift+up': '\x1b[1;2A', 'shift+down': '\x1b[1;2B', 'shift+left': '\x1b[1;2D', 'shift+right': '\x1b[1;2C' };
for (let i = 1; i <= 26; i++) keyBytes[`ctrl+${String.fromCharCode(96 + i)}`] = String.fromCharCode(i);
for (const [i, seq] of ['OP', 'OQ', 'OR', 'OS', '[15~', '[17~', '[18~', '[19~', '[20~', '[21~', '[23~', '[24~'].entries()) keyBytes[`f${i + 1}`] = `\x1b${seq}`;

/** The run's state line: host, result, what it asks for (an input episode never says password), cleanup, error. */
export function runStateText(p: ManualProcess): string {
  const result = p.state === 'exited' ? `Exited${p.exit_code !== undefined ? ` with code ${p.exit_code}` : ''} — output stays until you dismiss it` : p.state;
  const a = attentionOf(p);
  return `${p.host} · ${result}${a ? ` · ${attentionLabel(a)}` : ''} · Cleanup: ${p.cleanup}${p.cleanup_note ? ` — ${p.cleanup_note}` : ''}${p.error ? ` — ${p.error}` : ''}`;
}

/**
 * A run's terminal: its state and detection lines, the screen (a `SeatTerminal`, sized to its container), the input
 * field the keyboard lives in (IME, paste, a 16 KiB-chunked serial queue to `terminal.input`; Esc and Tab go to the
 * process, Ctrl+P too; Ctrl+Esc releases the keyboard), and the placeholder for while another surface holds the run.
 */
export function mountRunTerminal(host: RunTerminalHost, p: ManualProcess, opts: RunTerminalOptions): RunTerminalHandle {
  const id = `mp:${p.id}`;
  const mac = /Mac/.test(navigator.platform);
  const state = h('p', { class: 'mp-run-state', 'aria-live': 'polite' });
  const detect = h('p', { class: 'mp-detect' });
  const screen = h('div', { class: 'mp-terminal', 'aria-label': 'Process terminal' });
  const input = h('textarea', { class: 'mp-terminal-input', 'aria-label': 'Terminal input', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false', rows: 1 });
  const note = h('p', { class: 'mp-run-note', role: 'status', hidden: true });
  const held = h('div', { class: 'mp-run-held', hidden: true });
  const el = h('div', { class: 'mp-run', 'data-surface': opts.surface, 'data-process': p.id }, state, detect, screen, input, note, held);
  const status = (text: string) => {
    if (opts.onStatus) return opts.onStatus(text);
    note.textContent = text;
    note.hidden = !text;
  };

  let generation = 0; // a new hold, a loss or the dispose: what an older async step finds stale
  let disposed = false;
  let watched = false;
  const current = (g: number) => !disposed && g === generation && host.broker.holds(surface);

  let inputQueue = Promise.resolve();
  const sendText = (text: string) => {
    const g = generation;
    let part = '';
    let bytes = 0;
    const flush = () => {
      if (!part) return;
      const chunk = part;
      part = '';
      bytes = 0;
      inputQueue = inputQueue.then(async () => {
        if (!current(g)) return;
        const result = await host.input({ id, text: chunk });
        if (!result.ok && current(g)) status('Could not send terminal input. Try again.');
      });
    };
    for (const ch of text) {
      const n = new TextEncoder().encode(ch).length;
      if (bytes + n > 16384) flush();
      part += ch;
      bytes += n;
    }
    flush();
  };
  input.addEventListener('compositionend', (e) => {
    if (e.data) sendText(e.data);
    input.value = '';
  });
  input.addEventListener('input', (e) => {
    const event = e as InputEvent;
    if (event.isComposing) return;
    const text = event.inputType === 'insertFromComposition' ? '' : input.value;
    input.value = '';
    sendText(text);
  });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    // The seat's chords first: they never reach the process.
    if (opts.onKey?.(e)) return;
    if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      opts.releaseFocus();
      return;
    }
    // Ctrl+P belongs to the process (readline's history), not the game's palette.
    if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      sendText('\x10');
      return;
    }
    const key = seatedKey(e, mac);
    if (key.items.length && key.items.some((it) => 'key' in it)) {
      e.preventDefault();
      sendText(key.items.map((it) => ('text' in it ? it.text : (keyBytes[it.key] ?? ''))).join(''));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      sendText('\x1b');
    }
  });

  const term = new SeatTerminal(screen, {
    mac,
    grid: (g) => {
      if (watched && host.broker.holds(surface)) void host.watch('terminal.resize', { id, cols: g.cols, rows: g.rows });
    },
    wheel: (lines, column, row, modifiers) => {
      if (host.broker.holds(surface)) void host.watch('terminal.scroll', { id, direction: lines > 0 ? 'up' : 'down', lines: Math.abs(lines), column, row, modifiers });
    },
    open: (url) => host.external(url),
    paste: (text) => sendText(text),
    keyboard: () => {
      if (host.broker.holds(surface)) input.focus();
    },
  });

  const showHeld = (on: boolean) => {
    el.toggleAttribute('data-held', on);
    held.hidden = !on;
    screen.hidden = on;
    input.hidden = on;
    if (on && !held.firstChild) held.append(opts.placeholder ? opts.placeholder(() => handle.activate()) : defaultPlaceholder(() => handle.activate()));
  };

  const watchNow = async () => {
    const g = ++generation;
    watched = false;
    showHeld(false);
    await term.mount();
    if (!current(g)) return;
    screen.querySelector('.xterm-helper-textarea')?.setAttribute('aria-hidden', 'true');
    const grid = term.grid;
    const r = await host.watch('terminal.watch', { id, fps: 10, control: true, ...(grid ? { cols: grid.cols, rows: grid.rows } : {}) });
    if (!current(g)) return;
    watched = r.ok;
    if (!r.ok) status(failureText('terminal.watch', r.code, r.message));
    else {
      const gridNow = term.grid;
      if (gridNow) void host.watch('terminal.resize', { id, cols: gridNow.cols, rows: gridNow.rows });
    }
  };

  const surface: RunSurface = {
    id,
    kind: opts.surface,
    hold: () => {
      if (!disposed) void watchNow();
    },
    lose: () => {
      generation++;
      watched = false;
      if (!disposed) showHeld(true);
    },
    message: (m) => {
      if (m.t === 'terminal.frame') term.frame(m);
      else if (m.t === 'terminal.control') {
        input.disabled = m.mode !== 'control';
        status(m.mode === 'control' ? '' : 'This terminal is read only because another client controls it.');
      } else if (m.t === 'terminal.closed') status('The terminal closed.');
    },
  };

  const update = (q: ManualProcess) => {
    state.textContent = runStateText(q);
    const n = ended(q) ? null : detectionNote(q);
    detect.textContent = n ?? '';
    detect.hidden = !n;
  };

  const handle: RunTerminalHandle = {
    el,
    get holding() {
      return host.broker.holds(surface);
    },
    update,
    focus: () => {
      if (host.broker.holds(surface)) input.focus();
      else held.querySelector<HTMLElement>('button')?.focus();
    },
    activate: () => {
      if (!disposed) host.broker.claim(surface);
    },
    reconnect: () => {
      if (!disposed && host.broker.holds(surface)) void watchNow();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      generation++;
      term.dispose();
      host.broker.remove(surface);
    },
  };
  update(p);
  host.broker.add(surface);
  return handle;
}

function defaultPlaceholder(takeBack: () => void): HTMLElement {
  return h('div', { class: 'mp-run-held-body' }, h('p', {}, 'This run’s terminal is open in the processes dialog.'), h('button', { class: 'btn', 'data-action': 'run-take-back', onclick: takeBack }, 'Show it here'));
}
