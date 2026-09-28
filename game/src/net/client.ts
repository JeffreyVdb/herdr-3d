import {
  PROTO,
  isAck,
  isError,
  isSnapshot,
  isWelcome,
  isWorldEvent,
  parseMessage,
  type CommandArgs,
  type CommandName,
  type Hello,
  type Snapshot,
  type Welcome,
  type WorldEvent,
} from './protocol';

/** The subset of the browser WebSocket the client uses (injectable for tests). */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type ConnState =
  | { phase: 'connecting'; attempt: number }
  | { phase: 'live'; epoch: string; resume: 'snapshot' | 'replay' }
  | { phase: 'waiting'; attempt: number; retryAt: number; reason: string }
  | { phase: 'failed'; reason: string }
  | { phase: 'stopped' };

export interface BackoffOptions {
  initialMs: number;
  maxMs: number;
  /** ± fraction of the delay, 0..1. */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { initialMs: 500, maxMs: 10_000, jitter: 0.2 };

/** Delay before reconnect attempt `attempt` (1-based): exponential, capped, jittered. */
export function backoffDelay(attempt: number, o: BackoffOptions = DEFAULT_BACKOFF, rand: () => number = Math.random): number {
  const base = Math.min(o.maxMs, o.initialMs * 2 ** Math.max(0, attempt - 1));
  const j = base * o.jitter * (rand() * 2 - 1);
  return Math.max(0, Math.round(base + j));
}

/** The resume position the client remembers across connections. */
export interface Resume {
  epoch: string | null;
  seq: number | null;
}

/** `hello` for a (re)connect: ask for a replay only when we know both epoch and seq. */
export function helloFor(client: string, r: Resume): Hello {
  const h: Hello = { t: 'hello', proto: PROTO, client };
  if (r.epoch !== null && r.seq !== null) {
    h.since_seq = r.seq;
    h.epoch = r.epoch;
  }
  return h;
}

/** What to do with an event, given the last applied seq. */
export function eventDecision(lastSeq: number | null, seq: number): 'apply' | 'skip' | 'resync' {
  if (lastSeq === null) return 'resync';
  if (seq <= lastSeq) return 'skip';
  if (seq === lastSeq + 1) return 'apply';
  return 'resync';
}

export interface ClientHandlers {
  onSnapshot(s: Snapshot): void;
  onEvent(e: WorldEvent): void;
  onState?(s: ConnState): void;
  onWelcome?(w: Welcome): void;
}

export interface ClientOptions {
  url: string;
  clientName: string;
  socket: SocketFactory;
  handlers: ClientHandlers;
  timers?: Timers;
  backoff?: BackoffOptions;
  now?: () => number;
  rand?: () => number;
}

const FATAL_CODES = new Set(['unsupported_proto']);

/** The answer to a command: its ack, or an error (from the bridge, or `offline` / `timeout` / `disconnected`). */
export type CommandResult = { ok: true; data: unknown } | { ok: false; code: string; message: string };

export interface RequestOptions {
  timeoutMs?: number;
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

/**
 * Commands whose ack can take long. `floor.wake` is acked once every worker
 * resumed or fell back (~20 s worst case); progress shows through events
 * (`transition`, `resume`) meanwhile, so the wait here is generous.
 */
export const COMMAND_TIMEOUT_MS: Partial<Record<CommandName, number>> = {
  'floor.wake': 60_000,
  'floor.sleep': 30_000,
  // M4: prepare runs `git fetch`; a hire creates a worktree, starts the agent and waits out its trust dialog;
  // a send-home waits for the agent to exit.
  'hire.prepare': 30_000,
  'worker.hire': 90_000,
  'worker.fire.prepare': 20_000,
  'worker.fire': 45_000,
};

interface Pending {
  resolve(r: CommandResult): void;
  timer: unknown;
}

/**
 * Protocol v1 client: hello → welcome → snapshot | replay → events, with
 * reconnect (exponential backoff) that resumes from `since_seq` + `epoch`.
 */
export class BridgeClient {
  readonly resume: Resume = { epoch: null, seq: null };
  state: ConnState = { phase: 'stopped' };
  private sock: SocketLike | null = null;
  private attempt = 0;
  private timer: unknown = null;
  /** Between a `welcome` with resume=snapshot and the snapshot itself. */
  private awaitingSnapshot = false;
  private welcomed = false;
  private reqSeq = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly timers: Timers;
  private readonly now: () => number;

  constructor(private readonly o: ClientOptions) {
    this.timers = o.timers ?? {
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
    };
    this.now = o.now ?? (() => Date.now());
  }

  start(): void {
    if (this.state.phase !== 'stopped') return;
    this.connect();
  }

  stop(): void {
    this.clearTimer();
    this.setState({ phase: 'stopped' });
    const s = this.sock;
    this.sock = null;
    if (s) {
      s.onclose = s.onmessage = s.onerror = s.onopen = null;
      s.close(1000, 'client stop');
    }
    this.failPending();
  }

  /**
   * Sends a command and resolves with its `ack` or `error` (matched by
   * `req_id`). Never rejects. The events the command caused are applied
   * before this resolves (the bridge sends them before the ack).
   */
  request<T extends CommandName>(t: T, args: CommandArgs[T], o: RequestOptions = {}): Promise<CommandResult> {
    const s = this.sock;
    if (!s || this.state.phase !== 'live') {
      return Promise.resolve({ ok: false, code: 'offline', message: 'not connected to herdr-world' });
    }
    const reqId = `g${++this.reqSeq}`;
    const ms = o.timeoutMs ?? COMMAND_TIMEOUT_MS[t] ?? DEFAULT_COMMAND_TIMEOUT_MS;
    return new Promise((resolve) => {
      const timer = this.timers.setTimeout(() => {
        this.pending.delete(reqId);
        resolve({ ok: false, code: 'timeout', message: `herdr-world did not answer ${t} within ${Math.round(ms / 1000)} s` });
      }, ms);
      this.pending.set(reqId, { resolve, timer });
      s.send(JSON.stringify({ t, req_id: reqId, args }));
    });
  }

  private settle(reqId: string, r: CommandResult): boolean {
    const p = this.pending.get(reqId);
    if (!p) return false;
    this.pending.delete(reqId);
    this.timers.clearTimeout(p.timer);
    p.resolve(r);
    return true;
  }

  /** The socket is gone: no answer will come for what is in flight. */
  private failPending(): void {
    for (const id of [...this.pending.keys()]) {
      this.settle(id, { ok: false, code: 'disconnected', message: 'the connection to herdr-world dropped before it answered; the command may still have run' });
    }
  }

  private setState(s: ConnState): void {
    this.state = s;
    this.o.handlers.onState?.(s);
  }

  private clearTimer(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private connect(): void {
    this.clearTimer();
    this.attempt++;
    this.welcomed = false;
    this.awaitingSnapshot = false;
    this.setState({ phase: 'connecting', attempt: this.attempt });
    let s: SocketLike;
    try {
      s = this.o.socket(this.o.url);
    } catch (err) {
      this.scheduleReconnect(`cannot open socket: ${String(err)}`);
      return;
    }
    this.sock = s;
    s.onopen = () => s.send(JSON.stringify(helloFor(this.o.clientName, this.resume)));
    s.onmessage = (ev) => {
      if (this.sock === s && typeof ev.data === 'string') this.handle(ev.data);
    };
    s.onerror = () => {};
    s.onclose = (ev) => {
      if (this.sock !== s) return;
      this.sock = null;
      this.failPending();
      if (this.state.phase === 'failed' || this.state.phase === 'stopped') return;
      this.scheduleReconnect(ev.reason || `closed (${ev.code})`);
    };
  }

  private scheduleReconnect(reason: string): void {
    const delay = backoffDelay(this.attempt, this.o.backoff, this.o.rand);
    this.setState({ phase: 'waiting', attempt: this.attempt, retryAt: this.now() + delay, reason });
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  /** Drop the resume point and reconnect: the next hello gets a fresh snapshot. */
  private resync(reason: string): void {
    this.resume.epoch = null;
    this.resume.seq = null;
    const s = this.sock;
    this.sock = null;
    if (s) {
      s.onclose = s.onmessage = s.onerror = s.onopen = null;
      s.close(1000, reason);
    }
    this.failPending();
    this.attempt = 0;
    this.connect();
  }

  private handle(raw: string): void {
    const m = parseMessage(raw);
    if (!m) return;
    if (isWelcome(m)) {
      this.welcomed = true;
      this.o.handlers.onWelcome?.(m);
      if (m.resume === 'replay' && m.epoch === this.resume.epoch && this.resume.seq !== null) {
        this.goLive(m.epoch, 'replay');
      } else if (m.resume === 'replay') {
        this.resync('replay for an unknown epoch');
      } else {
        this.resume.epoch = m.epoch;
        this.resume.seq = null;
        this.awaitingSnapshot = true;
      }
      return;
    }
    if (isAck(m)) {
      this.settle(m.req_id, { ok: true, data: m.data });
      return;
    }
    if (isError(m) && m.req_id) {
      this.settle(m.req_id, { ok: false, code: m.code, message: m.message ?? '' });
      return;
    }
    if (isError(m) && !m.req_id && FATAL_CODES.has(m.code)) {
      this.clearTimer();
      this.setState({ phase: 'failed', reason: `${m.code}: ${m.message}` });
      const s = this.sock;
      this.sock = null;
      s?.close(1000, m.code);
      this.failPending();
      return;
    }
    if (!this.welcomed) return;
    if (isSnapshot(m)) {
      this.awaitingSnapshot = false;
      this.resume.seq = m.seq;
      this.o.handlers.onSnapshot(m);
      if (this.resume.epoch !== null) this.goLive(this.resume.epoch, 'snapshot');
      return;
    }
    // Any other message with a seq is an event, including types this client
    // does not know yet: it still advances the sequence.
    const seq = (m as { seq?: unknown }).seq;
    if (typeof seq === 'number' && Number.isInteger(seq)) {
      if (this.awaitingSnapshot) return;
      switch (eventDecision(this.resume.seq, seq)) {
        case 'skip':
          return;
        case 'resync':
          this.resync(`seq gap: have ${String(this.resume.seq)}, got ${seq}`);
          return;
        case 'apply':
          this.resume.seq = seq;
          if (isWorldEvent(m)) this.o.handlers.onEvent(m);
          return;
      }
    }
    // Everything else (acks, unknown types) is ignored.
  }

  private goLive(epoch: string, resume: 'snapshot' | 'replay'): void {
    this.attempt = 0;
    this.setState({ phase: 'live', epoch, resume });
  }
}
