// #11: Telegram notifications for the fixture server's `sim=1` (tools/fixture-sim.ts hands these commands over).
// Rules, like herdr-world's (docs/protocol.md "Notifications"):
// - The snapshot's `notify` is the settings and the channel (`simtelegram=off`, the default: no token; `token`: a token
//   saved for @herdr3d_bot; `paired`: and Ada paired, untested, off; `on`: and switched on (tested); `env`: the bridge
//   environment sets the switch (on) and the token; `old`: a bridge before #11, no `notify` at all and every notify.*
//   command `unknown_command`). Never a token: `key_set` and its last four characters. Every change is a
//   `notify.update` with the state flat in it; every ack is the state (`notify.test`: `{ok, latency_ms}`).
// - `notify.token.set {key}`: a token shaped like @BotFather's (digits, a colon, 20+ of [A-Za-z0-9_-]) else
//   `bad_request`; one whose secret starts with `bad` is `unauthorized`; another bot's token (other digits) unpairs.
//   `notify.token.clear` forgets the token and the account. With `simtelegram=env` both are `env_locked`.
// - `notify.pair.start` shows a code (K7QM-4XPA) good for 10 minutes; the account pairs `simtelegrampair` ms later
//   (default: only by `sim.telegram {pair: true}`). `notify.pair.cancel` stops it, `notify.unpair` forgets Ada.
//   `sim.telegram {expire: true}` expires the code; `{conflict: true}` shows the 409 retry state. Like the bridge
//   (`Service.after`), each of these and a token change forget the last delivery's error.
// - `notify.test` needs the token and the account (`not_configured`, `not_paired`); `sim.telegram {blocked: true}`
//   makes the next tests `blocked` (the 403 of a bot you blocked), `{blocked: false}` undoes it.
// - `notify.set` patches enabled, events, quiet and freelancers; switching on needs the token, the account and a
//   test that passed with them (`not_configured`, `not_paired`, `test_required`), and is `env_locked` under `env`.
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).

type Obj = Record<string, unknown>;
type Send = (m: Obj) => void;

export type TelegramMode = 'off' | 'token' | 'paired' | 'on' | 'env' | 'old';

export interface TelegramDeps {
  emit(send: Send, m: Obj): void;
  error(code: string, message: string): Error;
  later(fn: () => void, ms: number): unknown;
  now(): number;
}

const COMMANDS = new Set(['notify.get', 'notify.set', 'notify.test', 'notify.token.set', 'notify.token.clear', 'notify.pair.start', 'notify.pair.cancel', 'notify.unpair', 'sim.telegram']);
const TOKEN = /^([0-9]{1,20}):([A-Za-z0-9_-]{20,100})$/;
export const SIM_BOT = 'herdr3d_bot';
export const SIM_CODE = 'K7QM-4XPA';
const SIM_TOKEN_ID = '123456789';
const PAIR_TTL = 10 * 60_000;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export class TelegramSim {
  private readonly d: TelegramDeps;
  private readonly mode: TelegramMode;
  private readonly pairMs: number | null;
  private token: { id: string; hint: string } | null = null;
  private paired: { name: string; at: number } | null = null;
  private pairing: { state: string; code?: string; expires_at?: number; message?: string } | null = null;
  private pairGen = 0;
  private enabled = false;
  private tested = false;
  private events = { needs_you: true, done: true };
  private quiet = false;
  private freelancers = false;
  private blocked = false;
  private lastError: { code: string; message: string; at: number } | null = null;

  constructor(d: TelegramDeps, mode: TelegramMode = 'off', pairMs: number | null = null) {
    this.d = d;
    this.mode = mode;
    this.pairMs = pairMs;
    if (mode !== 'off' && mode !== 'old') this.token = { id: SIM_TOKEN_ID, hint: 'Dsaw' };
    if (mode === 'paired' || mode === 'on' || mode === 'env') this.paired = { name: 'Ada', at: d.now() - 86_400_000 };
    if (mode === 'on') this.enabled = this.tested = true;
    if (mode === 'env') this.enabled = true;
  }

  private ready(): boolean {
    return !!this.token && !!this.paired;
  }

  view(): Obj {
    const env = this.mode === 'env';
    const channel: Obj = { provider: 'telegram', key_set: !!this.token };
    if (this.token) {
      channel.key_hint = this.token.hint;
      channel.bot = SIM_BOT;
    }
    if (env) channel.key_env = true;
    if (this.paired) channel.paired = { ...this.paired };
    if (this.pairing) channel.pairing = { ...this.pairing };
    const missing = [...(this.token ? [] : ['token']), ...(this.paired ? [] : ['recipient'])];
    const v: Obj = {
      enabled: this.enabled,
      state: !this.enabled ? 'off' : !this.ready() ? 'incomplete' : this.lastError?.code === 'blocked' ? 'blocked' : 'ready',
      env: env ? ['enabled', 'token'] : [],
      tested: this.tested && this.ready(),
      events: { ...this.events },
      quiet: this.quiet,
      freelancers: this.freelancers,
      channel,
    };
    if (missing.length) v.missing = missing;
    if (this.lastError) v.last_error = { ...this.lastError };
    return v;
  }

  decorate(world: Obj): void {
    if (this.mode !== 'old') world.notify = this.view();
  }

  private publish(send: Send): void {
    this.d.emit(send, { t: 'notify.update', ...this.view() });
  }

  private bad(m: string): Error {
    return this.d.error('bad_request', `bad args: ${m}`);
  }

  private only(a: Obj, keys: string[]): void {
    for (const k of Object.keys(a)) if (!keys.includes(k)) throw this.bad(`json: unknown field "${k}"`);
  }

  /** Answers the notify.* commands and `sim.telegram`; false: not ours. */
  handle(t: unknown, a: Obj, send: Send, ack: (d?: unknown) => void, fail: (e: unknown) => void): boolean {
    if (typeof t !== 'string' || !COMMANDS.has(t)) return false;
    if (this.mode === 'old' && t !== 'sim.telegram') return false;
    try {
      switch (t) {
        case 'notify.get':
          this.only(a, []);
          break;
        case 'notify.set':
          this.only(a, ['enabled', 'events', 'quiet', 'freelancers']);
          this.set(a);
          break;
        case 'notify.test':
          this.only(a, []);
          this.test(send, ack, fail);
          return true;
        case 'notify.token.set':
          this.only(a, ['key']);
          this.setToken(a);
          break;
        case 'notify.token.clear':
          this.only(a, []);
          this.envLocked();
          this.token = this.paired = this.pairing = null;
          this.tested = false;
          this.lastError = null;
          break;
        case 'notify.pair.start':
          this.only(a, []);
          this.startPairing(send);
          break;
        case 'notify.pair.cancel':
          this.only(a, []);
          this.pairing = null;
          this.pairGen++;
          this.lastError = null;
          break;
        case 'notify.unpair':
          this.only(a, []);
          this.paired = null;
          this.tested = false;
          this.lastError = null;
          break;
        case 'sim.telegram':
          this.control(a, send);
          break;
      }
      this.publish(send);
      ack(this.view());
    } catch (e) {
      fail(e);
    }
    return true;
  }

  private envLocked(): void {
    if (this.mode === 'env') throw this.d.error('env_locked', 'the bot token is set by the bridge environment (HERDR_WORLD_TELEGRAM_KEY_FILE)');
  }

  private setToken(a: Obj): void {
    this.envLocked();
    const key = typeof a.key === 'string' ? a.key.trim() : '';
    if (!key) throw this.d.error('bad_request', 'paste the bot token @BotFather gave you');
    const m = TOKEN.exec(key);
    if (!m) throw this.d.error('bad_request', 'that is not a bot token: @BotFather gives one like 123456789:AAH…');
    if (m[2]!.startsWith('bad')) throw this.d.error('unauthorized', 'Telegram refused the bot token: check it with @BotFather');
    if (this.token?.id !== m[1]) {
      this.paired = null;
      this.tested = false;
    }
    this.token = { id: m[1]!, hint: key.slice(-4) };
    this.pairing = null;
    this.lastError = null;
  }

  private startPairing(send: Send): void {
    if (!this.token) throw this.d.error('not_configured', 'set the bot token first');
    const gen = ++this.pairGen;
    this.pairing = { state: 'waiting', code: SIM_CODE, expires_at: this.d.now() + PAIR_TTL };
    this.lastError = null;
    if (this.pairMs !== null) {
      this.d.later(() => {
        if (gen !== this.pairGen || !this.pairing) return;
        this.pair();
        this.publish(send);
      }, this.pairMs);
    }
  }

  private pair(): void {
    this.pairing = null;
    this.pairGen++;
    this.paired = { name: 'Ada', at: this.d.now() };
    this.tested = false;
    this.lastError = null;
  }

  private test(send: Send, ack: (d?: unknown) => void, fail: (e: unknown) => void): void {
    if (!this.token) throw this.d.error('not_configured', 'set the bot token first');
    if (!this.paired) throw this.d.error('not_paired', 'pair your Telegram account first');
    if (this.blocked) {
      this.lastError = { code: 'blocked', message: 'Telegram will not deliver: the bot was blocked', at: this.d.now() };
      this.publish(send);
      fail(this.d.error('blocked', 'Telegram will not deliver: the bot was blocked, or you have not started a chat with it (open it and press Start)'));
      return;
    }
    this.tested = true;
    this.lastError = null;
    this.publish(send);
    ack({ ok: true, latency_ms: 240 });
  }

  private set(a: Obj): void {
    const bool = (k: string, v: unknown) => {
      if (v !== undefined && typeof v !== 'boolean') throw this.bad(`${k}: expected boolean`);
      return v as boolean | undefined;
    };
    const enabled = bool('enabled', a.enabled);
    const ev = a.events === undefined ? {} : isObj(a.events) ? a.events : null;
    if (ev === null) throw this.bad('events: expected an object');
    const needs = bool('events.needs_you', ev.needs_you);
    const done = bool('events.done', ev.done);
    const quiet = bool('quiet', a.quiet);
    const freelancers = bool('freelancers', a.freelancers);
    if (enabled !== undefined) {
      if (this.mode === 'env') {
        if (enabled !== this.enabled) throw this.d.error('env_locked', 'notifications are switched by the bridge environment (HERDR_WORLD_NOTIFY_ENABLED)');
      } else if (enabled && !this.enabled) {
        if (!this.token) throw this.d.error('not_configured', 'set the bot token first');
        if (!this.paired) throw this.d.error('not_paired', 'pair your Telegram account first');
        if (!this.tested) throw this.d.error('test_required', 'send a test message first: it must reach you with this bot and account');
      }
      this.enabled = enabled;
    }
    if (needs !== undefined) this.events.needs_you = needs;
    if (done !== undefined) this.events.done = done;
    if (quiet !== undefined) this.quiet = quiet;
    if (freelancers !== undefined) this.freelancers = freelancers;
  }

  private control(a: Obj, _send: Send): void {
    if (a.pair === true && this.pairing && this.pairing.state !== 'expired') this.pair();
    if (a.expire === true && this.pairing) {
      this.pairGen++;
      this.pairing = { state: 'expired', message: 'The code expired before it arrived: start pairing again.' };
    }
    if (a.conflict === true && this.pairing) {
      this.pairing = { ...this.pairing, state: 'conflict', message: 'Another program reads this bot’s updates (a webhook, or a second bridge with the same token): retrying.' };
    }
    if (typeof a.blocked === 'boolean') this.blocked = a.blocked;
  }
}
