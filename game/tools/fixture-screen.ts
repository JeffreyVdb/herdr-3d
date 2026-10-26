// M5 screen: the fixture simulator's laptop screens and seated input (`sim=1`;
// hooked into SimWorld.handle in tools/fixture-sim.ts). `terminal.watch`
// replays a recorded screen (fixtures/screens/*.jsonl, real `herdr terminal
// session observe` output from tools/record-screens.ts): `agent` for a worker
// with an agent, `shell` for a plain shell, each worker at its own point in
// the recording, looping. Frames go out at most `fps` a second, diffs that
// come faster concatenated, like the bridge; each watch starts with a full
// frame. `worker.keys` fast-forwards that worker's screen to the end of its
// recording and echoes what was typed as diff frames (so typed input shows
// up on the laptop). World events close watches: `worker.removed`
// (`worker_removed`), the floor going to sleep (`asleep`), a new pane
// (`pane_changed`). `simfail=input_failed` fails the next `worker.keys`,
// `simfail=observer_failed` closes the next watch after its first frame.
// `sim.watches` (not a bridge command) answers how many watches this
// connection has, for tests.
// #74: `simzoom=` plays the bridge's pane zoom. Absent: a bridge before it (`fullscreen` is ignored, the ack has no
// `zoom`, `terminal.zoom` is `unknown_command`); `old`: one that refuses the `fullscreen` argument (`bad_request`);
// `single` (the tab has one pane), `split` (it has several: `fullscreen: true` and `terminal.zoom` zoom it, standing up
// or watching without `fullscreen` restores it) and `headless` (the same, but the zoom does not widen the pane:
// `headless: true` in the zoom state). `sim.unzoom {id}` plays the human unzooming the tab: a `terminal.state`.
// The sim's screens keep their recorded size in every state; only the zoom state changes.
// #175: `simscreen=narrow` gives every worker the `narrow` recording instead: a split pane's 60×40 shell.
// #176: a watch with `control` owns its pane: the ack says `control: true`, a `terminal.control` (mode `control`)
// comes before its first frame, frames come at the grid it asked for (the recording drawn into it) and
// `terminal.resize` changes that grid with a full frame; `terminal.scroll` moves a pretend history (200 lines) and
// answers with `terminal.history`, and typing brings it back to 0. `simcontrol=old` refuses the argument (a bridge
// before #176: `bad_request`), `none` acks without `control` (a bridge whose herdr cannot own panes), `busy` falls
// back to read only (`terminal.control` mode `observe`, reason `busy`, at the recording's size). `sim.terminal {id}`
// answers what the watch has: its grid, control mode, history offset and the resizes and scrolls it got;
// `sim.write {id, data}` prints raw text (escapes too) on a worker's screen.
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Floor, Worker } from '../src/net/protocol.ts';

type Msg = Record<string, unknown>;
type Send = (m: Msg) => void;
type Obj = Record<string, unknown>;

const SCREENS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'screens');

export interface Recording {
  name: string;
  cols: number;
  rows: number;
  frames: Array<{ ms: number; full: boolean; data: Buffer }>;
}

const recordings = new Map<string, Recording>();

export function loadRecording(name: string, dir = SCREENS_DIR): Recording {
  const key = `${dir}/${name}`;
  const hit = recordings.get(key);
  if (hit) return hit;
  const [meta, ...lines] = readFileSync(join(dir, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Obj);
  if (!meta) throw new Error(`${name}: empty recording`);
  const rec: Recording = {
    name,
    cols: Number(meta.cols),
    rows: Number(meta.rows),
    frames: lines.map((l) => ({ ms: Number(l.ms), full: l.full === true, data: Buffer.from(String(l.data), 'base64') })),
  };
  if (!rec.frames[0]?.full) throw new Error(`${name}: the first frame must be full`);
  recordings.set(key, rec);
  return rec;
}

/** The key names the bridge accepts (docs/protocol.md "Input"). */
const KEYS = new Set([
  'enter', 'esc', 'tab', 'shift+tab', 'backspace', 'delete', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'space',
  'shift+up', 'shift+down', 'shift+left', 'shift+right', 'ctrl+left', 'ctrl+right', 'alt+left', 'alt+right', 'shift+enter', 'alt+enter', 'alt+backspace',
  ...Array.from({ length: 26 }, (_, i) => `ctrl+${String.fromCharCode(97 + i)}`),
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

/** What a key echoes on each recording's screen (unlisted keys echo nothing). */
const ECHO: Record<string, Record<string, string>> = {
  shell: { enter: '\r\n$ ', backspace: '\b \b', left: '\x1b[D', right: '\x1b[C', space: ' ', 'ctrl+c': '^C\r\n$ ', 'ctrl+l': '\x1b[2J\x1b[H$ ', tab: '    ' },
  // The agent screen's input box is row 25 from column 5 (tools/record-screens.ts): Enter empties it.
  agent: { enter: '\x1b[25;5H\x1b[66X', backspace: '\b \b', left: '\x1b[D', right: '\x1b[C', space: ' ' },
  // #175: the narrow screen is a bare bash too.
  narrow: { enter: '\r\n$ ', backspace: '\b \b', left: '\x1b[D', right: '\x1b[C', space: ' ', 'ctrl+c': '^C\r\n$ ', 'ctrl+l': '\x1b[2J\x1b[H$ ', tab: '    ' },
};

/** Steps before the recording starts over. */
const LOOP_GAP_MS = 3000;
/** Watches per connection, like the bridge's `--max-watches`. */
export const SIM_MAX_WATCHES = 6;

export interface ScreenHost {
  worker(id: string): Worker | undefined;
  manualProcess?(id: string): boolean;
  floor(session: string): Floor | undefined;
  later(fn: () => void, ms: number): unknown;
  cancel(h: unknown): void;
  now(): number;
  /** Consumes a one-shot `simfail` of this code. */
  failNext(code: string): boolean;
  /** #74: `simzoom` (undefined: a bridge before pane zoom). */
  zoomMode?(): ZoomMode | undefined;
  /** #175: `simscreen`, the recording every worker shows (undefined: `agent` or `shell` by the worker). */
  recording?(): string | undefined;
  /** #176: `simcontrol` (undefined: a bridge that owns the seated pane). */
  controlMode?(): ControlMode | undefined;
}

export type ControlMode = 'old' | 'none' | 'busy';

/** #176: the pretend history a controlled pane has. */
const SIM_HISTORY = 200;

export type ZoomMode = 'old' | 'single' | 'split' | 'headless';

interface ZoomState {
  state: 'single' | 'zoomed' | 'split';
  applied: boolean;
  headless?: boolean;
}

class ScreenError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface Watch {
  id: string;
  pane: string;
  fps: number;
  n: number;
  pending: Buffer[];
  full: boolean;
  timer: unknown;
  lastSent: number;
  send: Send;
  failAfterFirst: boolean;
  /** #176: the watch owns its pane at this grid (null: an observer at the recording's size). */
  control: { mode: 'control' | 'observe'; cols: number; rows: number; offset: number; resizes: Array<[number, number]>; scrolls: string[] } | null;
}

/** One worker's screen: where it is in its recording, and the bytes since the last full frame. */
interface Screen {
  rec: Recording;
  /** Index of the next recorded frame. */
  pos: number;
  tape: Buffer[];
  typed: boolean;
  timer: unknown;
}

const hash = (s: string) => {
  let h = 0;
  for (const c of s) h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0;
  return h;
};

export class SimScreens {
  readonly watches = new Map<string, Watch>();
  /** #74: the workers whose tab is zoomed (by a fullscreen watch or `terminal.zoom`), and so applied by the bridge. */
  private readonly zoomed = new Set<string>();
  /** #74: the workers whose watch wants its tab fullscreen (the bridge's refs): a re-watch of one does not zoom again. */
  private readonly held = new Set<string>();
  private readonly screens = new Map<string, Screen>();
  /** #52: workers whose next watch sends its first frame this much later (ms): a new pane slow to show anything. */
  private readonly slow = new Map<string, number>();
  private readonly host: ScreenHost;

  constructor(host: ScreenHost) {
    this.host = host;
  }

  /** Wraps a connection's send so world events close the watches they end. */
  tap(send: Send): Send {
    return (m: Msg) => {
      send(m);
      this.onEvent(m);
    };
  }

  /** Handles the screen commands; false for anything else. */
  handle(t: unknown, a: Obj, send: Send, ack: (d?: unknown) => void, fail: (code: string, message: string) => void): boolean {
    try {
      switch (t) {
        case 'terminal.watch':
          this.watch(a, send, ack);
          return true;
        case 'terminal.unwatch':
          this.only(a, ['id']);
          this.stop(this.str(a, 'id'));
          this.release(this.str(a, 'id'));
          ack();
          return true;
        case 'terminal.zoom':
          if (!this.host.zoomMode?.() || this.host.zoomMode() === 'old') return false;
          this.zoom(a, ack);
          return true;
        case 'sim.unzoom': {
          const id = this.str(a, 'id');
          this.zoomed.delete(id);
          const w = this.watches.get(id);
          if (w) this.pushState(w);
          ack();
          return true;
        }
        case 'terminal.input': {
          this.only(a, ['id', 'text', 'bytes']);
          const id = this.str(a, 'id');
          if (!id.startsWith('mp:') || !this.host.manualProcess?.(id.slice(3))) throw new ScreenError('not_found', 'manual process not found');
          const watch = this.watches.get(id);
          if (watch?.control?.mode !== 'control') throw new ScreenError('invalid_state', 'terminal is not controlled');
          if ((typeof a.text === 'string') === (typeof a.bytes === 'string')) throw new ScreenError('bad_request', 'send text or bytes');
          const data = typeof a.text === 'string' ? Buffer.from(a.text, 'utf8') : Buffer.from(String(a.bytes), 'base64');
          if (data.length > 16384) throw new ScreenError('bad_request', 'input too long');
          const screen = this.screen(this.target(id));
          screen.tape.push(data); this.push(watch, data, false); ack(); return true;
        }
        case 'worker.keys':
          this.keys(a);
          ack();
          return true;
        case 'sim.watches':
          ack({ watches: this.watches.size, ids: [...this.watches.keys()] });
          return true;
        case 'terminal.resize':
          if (this.host.controlMode?.() === 'old') return false;
          this.resize(a, ack);
          return true;
        case 'terminal.scroll':
          if (this.host.controlMode?.() === 'old') return false;
          this.scroll(a, ack);
          return true;
        case 'sim.write': {
          // #176 (tests): raw bytes onto a worker's screen, as its program would print them (links, OSC 8, long lines).
          const id = this.str(a, 'id');
          const w = this.target(id);
          const sc = this.screen(w);
          if (sc.timer) this.host.cancel(sc.timer);
          sc.timer = null;
          sc.typed = true;
          const data = Buffer.from(String(a.data ?? ''), 'utf8');
          sc.tape.push(data);
          for (const x of this.watchersOf(id)) this.push(x, data, false);
          ack();
          return true;
        }
        case 'sim.terminal': {
          const w = this.watches.get(this.str(a, 'id'));
          ack(w ? { watched: true, fps: w.fps, control: w.control, n: w.n } : { watched: false });
          return true;
        }
      }
    } catch (e) {
      if (e instanceof ScreenError) fail(e.code, e.message);
      else fail('internal', String(e));
      return true;
    }
    return false;
  }

  private only(a: Obj, keys: string[]): void {
    for (const k of Object.keys(a)) if (!keys.includes(k)) throw new ScreenError('bad_request', `bad args: json: unknown field "${k}"`);
  }

  private str(a: Obj, k: string): string {
    const v = a[k];
    if (typeof v !== 'string' || !v) throw new ScreenError('bad_request', `bad args: ${k} must be a string`);
    return v;
  }

  /** The worker a command is about, with its pane, on an awake floor. */
  private target(id: string): Worker {
    if (id.startsWith('mp:') && this.host.manualProcess?.(id.slice(3))) return { id, session: '', pane_id: id } as Worker;
    const w = this.host.worker(id);
    if (!w) throw new ScreenError('unknown_worker', `unknown worker: "${id}"`);
    if (this.host.floor(w.session)?.state !== 'running') throw new ScreenError('invalid_state', `invalid state: ${w.session} is asleep`);
    if (!w.pane_id) throw new ScreenError('invalid_state', `invalid state: ${w.name ?? id} has no pane`);
    return w;
  }

  private watch(a: Obj, send: Send, ack: (d?: unknown) => void): void {
    const mode = this.host.zoomMode?.();
    const ctl = this.host.controlMode?.();
    this.only(a, [...(mode === 'old' ? ['id', 'fps', 'cols', 'rows'] : ['id', 'fps', 'cols', 'rows', 'fullscreen']), ...(ctl === 'old' ? [] : ['control'])]);
    if (a.control !== undefined && typeof a.control !== 'boolean') throw new ScreenError('bad_request', 'bad args: control must be a boolean');
    const id = this.str(a, 'id');
    if (a.fullscreen !== undefined && typeof a.fullscreen !== 'boolean') throw new ScreenError('bad_request', 'bad args: fullscreen must be a boolean');
    const int = (k: string, lo: number, hi: number) => {
      const v = a[k];
      if (v === undefined) return undefined;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) throw new ScreenError('bad_request', `bad args: ${k} must be an int ${lo}-${hi}`);
      return v;
    };
    const fps = int('fps', 1, 30) ?? 4;
    const cols = int('cols', 40, 300);
    const rows = int('rows', 10, 100);
    const w = this.target(id);
    const owning = a.control === true && ctl !== 'none';
    if (owning && !id.startsWith('mp:') && [...this.watches.values()].some((x) => x.id !== id && !x.id.startsWith('mp:') && x.control)) throw new ScreenError('capacity', 'capacity: this connection already controls a terminal (one per connection)');
    // Watching again restarts the watch: a fresh full frame.
    this.stop(id);
    if (this.watches.size >= SIM_MAX_WATCHES) throw new ScreenError('capacity', `capacity: ${this.watches.size} watches on this connection (max ${SIM_MAX_WATCHES})`);
    const s = this.screen(w);
    const control: Watch['control'] = owning
      ? ctl === 'busy'
        ? { mode: 'observe', cols: s.rec.cols, rows: s.rec.rows, offset: 0, resizes: [], scrolls: [] }
        : { mode: 'control', cols: cols ?? s.rec.cols, rows: rows ?? s.rec.rows, offset: 0, resizes: [], scrolls: [] }
      : null;
    const watch: Watch = { id, pane: w.pane_id as string, fps, n: 0, pending: [Buffer.concat(s.tape)], full: true, timer: null, lastSent: -Infinity, send, failAfterFirst: this.host.failNext('observer_failed'), control };
    this.watches.set(id, watch);
    // #74: fullscreen true zooms, unless the watch it replaces held the tab already (a re-watch never zooms again);
    // false and absent restore, as the bridge's stand-up does.
    if (a.fullscreen === true) {
      if (!this.held.has(id)) this.zoomed.add(id);
      this.held.add(id);
    } else this.release(id);
    const zoom = this.zoomState(id);
    const size = control?.mode === 'control' ? control : s.rec;
    ack({ pane: watch.pane, cols: size.cols, rows: size.rows, ...(zoom ? { zoom } : {}), ...(control ? { control: true } : {}) });
    if (control) send({ t: 'terminal.control', id, pane: watch.pane, mode: control.mode, ...(control.mode === 'observe' ? { reason: 'busy' } : {}), cols: control.cols, rows: control.rows });
    const slow = this.slow.get(id);
    this.slow.delete(id);
    if (slow) {
      watch.timer = this.host.later(() => {
        watch.timer = null;
        this.flush(watch);
      }, slow);
    } else this.flush(watch);
    if (!s.timer && !s.typed) this.advance(id, s);
  }

  /** #176: the controlled pane's PTY to a new grid: a full frame at it. */
  private resize(a: Obj, ack: (d?: unknown) => void): void {
    this.only(a, ['id', 'cols', 'rows', 'cell_width_px', 'cell_height_px']);
    const id = this.str(a, 'id');
    const int = (k: string, lo: number, hi: number, need: boolean) => {
      const v = a[k];
      if (v === undefined && !need) return 0;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) throw new ScreenError('bad_request', `bad args: ${k} must be ${lo}-${hi}`);
      return v;
    };
    const cols = int('cols', 40, 300, true);
    const rows = int('rows', 10, 100, true);
    int('cell_width_px', 0, 256, false);
    int('cell_height_px', 0, 256, false);
    this.target(id);
    const w = this.watches.get(id);
    if (!w?.control) throw new ScreenError('bad_request', 'bad args: terminal.resize needs a terminal.watch of the worker with control');
    if (w.control.mode === 'observe') throw new ScreenError('invalid_state', 'invalid state: another client controls this terminal: it is shown read only');
    w.control.cols = cols;
    w.control.rows = rows;
    w.control.resizes.push([cols, rows]);
    ack({ cols, rows });
    const s = this.screens.get(id);
    this.push(w, Buffer.concat(s?.tape ?? []), true);
  }

  /** #176: a wheel over the controlled pane, or back to the live bottom: the pretend history's offset. */
  private scroll(a: Obj, ack: (d?: unknown) => void): void {
    this.only(a, ['id', 'direction', 'lines', 'column', 'row', 'modifiers', 'bottom']);
    const id = this.str(a, 'id');
    this.target(id);
    const w = this.watches.get(id);
    if (!w?.control) throw new ScreenError('bad_request', 'bad args: terminal.scroll needs a terminal.watch of the worker with control');
    if (w.control.mode === 'observe') throw new ScreenError('invalid_state', 'invalid state: another client controls this terminal: it is shown read only');
    const c = w.control;
    if (a.bottom === true) {
      if (a.direction !== undefined || a.lines !== undefined) throw new ScreenError('bad_request', 'bad args: give either direction and lines, or bottom');
      c.offset = 0;
      c.scrolls.push('bottom');
    } else {
      const lines = a.lines;
      if ((a.direction !== 'up' && a.direction !== 'down') || typeof lines !== 'number' || !Number.isInteger(lines) || lines < 1 || lines > 1000) throw new ScreenError('bad_request', 'bad args: direction up or down and lines 1-1000');
      c.offset = Math.max(0, Math.min(SIM_HISTORY, c.offset + (a.direction === 'up' ? lines : -lines)));
      c.scrolls.push(`${a.direction} ${lines}`);
    }
    ack();
    this.pushHistory(w);
  }

  private pushHistory(w: Watch): void {
    const c = w.control;
    if (c?.mode === 'control') w.send({ t: 'terminal.history', id: w.id, pane: w.pane, offset: c.offset, max: SIM_HISTORY, rows: c.rows });
  }

  /** #52 (`sim.swap`): the next watch of `id` holds its first frame `ms`. */
  holdFirst(id: string, ms: number): void {
    this.slow.set(id, ms);
  }

  /** #74: the zoom state of a worker's pane under `simzoom` (undefined: a bridge without it). */
  private zoomState(id: string): ZoomState | undefined {
    const mode = this.host.zoomMode?.();
    if (!mode || mode === 'old') return undefined;
    if (mode === 'single') return { state: 'single', applied: false };
    const on = this.zoomed.has(id);
    return { state: on ? 'zoomed' : 'split', applied: on, ...(on && mode === 'headless' ? { headless: true } : {}) };
  }

  /** #74: `terminal.state` for a watch (the zoom changed behind the game's back). */
  private pushState(w: Watch): void {
    const zoom = this.zoomState(w.id);
    const s = this.screens.get(w.id);
    if (zoom) w.send({ t: 'terminal.state', id: w.id, pane: w.pane, cols: s?.rec.cols ?? 120, rows: s?.rec.rows ?? 36, zoom });
  }

  private zoom(a: Obj, ack: (d?: unknown) => void): void {
    this.only(a, ['id', 'on']);
    const id = this.str(a, 'id');
    if (typeof a.on !== 'boolean') throw new ScreenError('bad_request', 'bad args: on must be a boolean');
    this.target(id);
    const w = this.watches.get(id);
    if (!w) throw new ScreenError('bad_request', `bad args: this connection does not watch ${id}`);
    if (a.on) {
      this.zoomed.add(id);
      this.held.add(id);
    } else this.release(id);
    const s = this.screens.get(id);
    ack({ pane: w.pane, cols: s?.rec.cols ?? 120, rows: s?.rec.rows ?? 36, zoom: this.zoomState(id) });
  }

  private screen(w: Worker): Screen {
    let s = this.screens.get(w.id);
    if (!s) {
      const rec = loadRecording(this.host.recording?.() ?? (w.agent_kind ? 'agent' : 'shell'));
      if (w.id.startsWith('mp:')) {
        s = { rec, pos: 0, tape: [Buffer.from('Manual process terminal\r\n')], typed: true, timer: null };
        this.screens.set(w.id, s);
        return s;
      }
      // Each worker at its own point of the recording (the fixture floor would look copy-pasted otherwise).
      const upto = hash(w.id) % rec.frames.length;
      s = { rec, pos: 0, tape: [], typed: false, timer: null };
      for (let i = 0; i <= upto; i++) this.apply(s, i, false);
      s.pos = upto + 1;
      this.screens.set(w.id, s);
    }
    return s;
  }

  /** Recorded frame `i` onto the screen's tape (and, `live`, to its watches). */
  private apply(s: Screen, i: number, live: boolean, id = ''): void {
    const f = s.rec.frames[i];
    if (!f) return;
    if (f.full) s.tape = [f.data];
    else s.tape.push(f.data);
    if (live) for (const w of this.watchersOf(id)) this.push(w, f.data, f.full);
  }

  private watchersOf(id: string): Watch[] {
    const w = this.watches.get(id);
    return w ? [w] : [];
  }

  /** Plays the recording on from `pos` while the screen is watched; loops after a pause. */
  private advance(id: string, s: Screen): void {
    if (!this.watches.has(id) || s.typed) {
      s.timer = null;
      return;
    }
    const frames = s.rec.frames;
    const prev = frames[s.pos - 1];
    const next = frames[s.pos];
    const wait = next && prev ? Math.max(20, next.ms - prev.ms) : LOOP_GAP_MS;
    s.timer = this.host.later(() => {
      s.timer = null;
      if (!this.watches.has(id) || s.typed) return;
      if (s.pos >= frames.length) s.pos = 0;
      this.apply(s, s.pos, true, id);
      s.pos++;
      this.advance(id, s);
    }, wait);
  }

  private push(w: Watch, data: Buffer, full: boolean): void {
    if (full) {
      w.pending = [data];
      w.full = true;
    } else w.pending.push(data);
    this.flush(w);
  }

  /** Sends what is pending as one frame, at most `fps` a second. */
  private flush(w: Watch): void {
    if (w.timer || !w.pending.length) return;
    const gap = 1000 / w.fps;
    const due = w.lastSent + gap - this.host.now();
    if (due > 0) {
      w.timer = this.host.later(() => {
        w.timer = null;
        this.flush(w);
      }, due);
      return;
    }
    if (this.watches.get(w.id) !== w) return;
    const data = Buffer.concat(w.pending);
    w.pending = [];
    const s = this.screens.get(w.id);
    const size = w.control?.mode === 'control' ? w.control : { cols: s?.rec.cols ?? 120, rows: s?.rec.rows ?? 36 };
    w.send({ t: 'terminal.frame', id: w.id, pane: w.pane, n: ++w.n, full: w.full, cols: size.cols, rows: size.rows, data: data.toString('base64') });
    w.full = false;
    w.lastSent = this.host.now();
    if (w.failAfterFirst) this.close(w.id, 'observer_failed');
  }

  private stop(id: string): void {
    const w = this.watches.get(id);
    if (!w) return;
    if (w.timer) this.host.cancel(w.timer);
    this.watches.delete(id);
    const s = this.screens.get(id);
    if (s?.timer) {
      this.host.cancel(s.timer);
      s.timer = null;
    }
  }

  private close(id: string, reason: string): void {
    const w = this.watches.get(id);
    if (!w) return;
    this.stop(id);
    this.release(id);
    w.send({ t: 'terminal.closed', id, reason });
  }

  private keys(a: Obj): void {
    this.only(a, ['id', 'input']);
    const id = this.str(a, 'id');
    const input = a.input;
    if (!Array.isArray(input) || input.length < 1 || input.length > 64) throw new ScreenError('bad_request', 'bad args: input must have 1-64 items');
    let text = 0;
    const items = input.map((it: unknown) => {
      if (typeof it !== 'object' || it === null) throw new ScreenError('bad_request', 'bad args: an input item must be {text} or {key}');
      const o = it as Obj;
      const n = Object.keys(o).length;
      if (n === 1 && typeof o.text === 'string') {
        const b = Buffer.byteLength(o.text);
        if (b < 1 || b > 4096) throw new ScreenError('bad_request', 'bad args: text must be 1-4096 bytes');
        if (/[\u0000-\u001f\u007f]/.test(o.text)) throw new ScreenError('bad_request', 'bad args: text has a control character: send it as a key');
        text += b;
        return { text: o.text };
      }
      if (n === 1 && typeof o.key === 'string') {
        if (!KEYS.has(o.key)) throw new ScreenError('bad_request', `bad args: unknown key "${o.key}"`);
        return { key: o.key };
      }
      throw new ScreenError('bad_request', 'bad args: an input item must be exactly one of text or key');
    });
    if (text > 8192) throw new ScreenError('bad_request', 'bad args: more than 8 KiB of text');
    const w = this.target(id);
    if (this.host.failNext('input_failed')) throw new ScreenError('input_failed', 'input_failed: herdr pane send-keys: exit status 1 (simulated)');
    // #176: input brings a controlled view back to the live bottom (the bridge does it before the keys).
    const own = this.watches.get(id);
    if (own?.control?.mode === 'control' && own.control.offset > 0) {
      own.control.offset = 0;
      this.pushHistory(own);
    }
    const s = this.screen(w);
    if (!s.typed) {
      // Someone is typing: the screen stops replaying and settles where its recording ends.
      s.typed = true;
      if (s.timer) this.host.cancel(s.timer);
      s.timer = null;
      for (let i = s.pos; i < s.rec.frames.length; i++) this.apply(s, i, true, id);
      s.pos = s.rec.frames.length;
    }
    const echo = ECHO[s.rec.name] ?? {};
    const out = items.map((it) => ('text' in it ? it.text : (echo[it.key] ?? ''))).join('');
    if (!out) return;
    const data = Buffer.from(out, 'utf8');
    s.tape.push(data);
    for (const x of this.watchersOf(id)) this.push(x, data, false);
  }

  /** World events end the watches they concern. */
  private onEvent(m: Msg): void {
    if (!this.watches.size || typeof m.seq !== 'number') return;
    if (m.t === 'worker.removed' && typeof m.id === 'string') {
      this.close(m.id, 'worker_removed');
      this.screens.delete(m.id);
    } else if (m.t === 'floor.upsert') {
      const f = m.floor as Floor | undefined;
      if (f?.state !== 'asleep') return;
      for (const w of [...this.watches.values()]) if (this.host.worker(w.id)?.session === f.session) this.close(w.id, 'asleep');
    } else if (m.t === 'worker.upsert') {
      const x = m.worker as Worker | undefined;
      const w = x ? this.watches.get(x.id) : undefined;
      if (w && x && x.pane_id !== w.pane) {
        this.close(w.id, 'pane_changed');
        this.screens.delete(w.id);
      }
    }
  }

  dispose(): void {
    for (const id of [...this.watches.keys()]) this.stop(id);
    this.zoomed.clear();
    this.held.clear();
  }

  /** #74: the watch no longer wants the tab fullscreen: it is put back (the sim's zoom is the bridge's). */
  private release(id: string): void {
    this.zoomed.delete(id);
    this.held.delete(id);
  }
}

const perWorld = new WeakMap<object, SimScreens>();

/** The screens of one simulated world (one connection), made on first use. */
export function screensOf(world: object, host: () => ScreenHost): SimScreens {
  let s = perWorld.get(world);
  if (!s) {
    s = new SimScreens(host());
    perWorld.set(world, s);
  }
  return s;
}
