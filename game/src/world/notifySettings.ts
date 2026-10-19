/**
 * #11 Telegram notifications: the bridge-wide settings and the channel's state as the snapshot's `notify` and the
 * `notify.update` events carry them (`NotifyBook`), and the words the Settings section says about them: a failure, a
 * pairing's state and when its code expires. Pure: the section and vitest use it. The bridge never sends the bot
 * token: `key_set` and a four-character hint only.
 */

import type { NotifyChannel, NotifyFeatureState, NotifyPairing, NotifyState } from '../net/protocol';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const FEATURE: readonly string[] = ['off', 'incomplete', 'ready', 'blocked'];
const PAIRING: readonly string[] = ['waiting', 'conflict', 'error', 'expired'];

function pairingOf(v: unknown): NotifyPairing | undefined {
  if (!isObj(v) || !PAIRING.includes(str(v.state))) return undefined;
  const p: NotifyPairing = { state: v.state as NotifyPairing['state'] };
  if (str(v.code)) p.code = str(v.code);
  if (num(v.expires_at) && v.expires_at > 0) p.expires_at = v.expires_at;
  if (str(v.message)) p.message = str(v.message);
  return p;
}

function channelOf(v: unknown): NotifyChannel {
  const c = isObj(v) ? v : {};
  const out: NotifyChannel = { provider: str(c.provider) || 'telegram', key_set: c.key_set === true };
  if (str(c.key_hint)) out.key_hint = str(c.key_hint);
  if (str(c.bot)) out.bot = str(c.bot);
  if (c.key_env === true) out.key_env = true;
  if (isObj(c.paired)) out.paired = { at: num(c.paired.at) ? c.paired.at : 0, ...(str(c.paired.name) ? { name: str(c.paired.name) } : {}) };
  const p = pairingOf(c.pairing);
  if (p) out.pairing = p;
  return out;
}

/** A well-formed state (unknown keys dropped, so nothing else is ever kept), else null. */
export function notifyStateOf(v: unknown): NotifyState | null {
  if (!isObj(v) || typeof v.enabled !== 'boolean' || !FEATURE.includes(str(v.state)) || !isObj(v.channel)) return null;
  const ev = isObj(v.events) ? v.events : {};
  const s: NotifyState = {
    enabled: v.enabled,
    state: v.state as NotifyFeatureState,
    env: Array.isArray(v.env) ? v.env.filter((x): x is string => typeof x === 'string') : [],
    tested: v.tested === true,
    events: { needs_you: ev.needs_you !== false, done: ev.done !== false },
    quiet: v.quiet === true,
    freelancers: v.freelancers === true,
    replies: v.replies === true,
    // H3D-1: an older bridge says none: everything is what it sends.
    mode: v.mode === 'questions' ? 'questions' : 'everything',
    channel: channelOf(v.channel),
  };
  const missing = Array.isArray(v.missing) ? v.missing.filter((x): x is string => x === 'token' || x === 'recipient') : [];
  if (missing.length) s.missing = missing;
  const e = v.last_error;
  if (isObj(e) && str(e.code)) s.last_error = { code: str(e.code), message: str(e.message), at: num(e.at) ? e.at : 0 };
  if (num(v.dropped) && v.dropped > 0) s.dropped = Math.floor(v.dropped);
  return s;
}

/** The settings and state, and who listens for changes. */
export class NotifyBook {
  /** The bridge sent a `notify` state (it has a channel). */
  known = false;
  version = 0;
  private cur: NotifyState | null = null;
  private readonly listeners = new Set<() => void>();

  get state(): NotifyState | null {
    return this.cur;
  }

  reset(v: unknown): void {
    this.cur = notifyStateOf(v);
    this.known = this.cur !== null;
    this.version++;
    this.emit();
  }

  upsert(v: unknown): boolean {
    const next = notifyStateOf(v);
    if (!next) return false;
    this.cur = next;
    this.known = true;
    this.version++;
    this.emit();
    return true;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }
}

/** The bot as Telegram names it: `@herdr3d_bot`, or "your bot" before the bridge learnt its name. */
export const botName = (c: Pick<NotifyChannel, 'bot'>): string => (c.bot ? `@${c.bot}` : 'your bot');

/** Telegram's link to the bot's chat (null before its name is known). */
export const botLink = (c: Pick<NotifyChannel, 'bot'>): string | null => (c.bot && /^[A-Za-z0-9_]{3,64}$/.test(c.bot) ? `https://t.me/${c.bot}` : null);

/** How long until a code expires: `9 min`, `under a minute`, null once it has. */
export function expiresIn(at: number | undefined, now: number): string | null {
  if (!at) return null;
  const ms = at - now;
  if (ms <= 0) return null;
  const m = Math.floor(ms / 60_000);
  return m < 1 ? 'under a minute' : `${m} min`;
}

/** What a failed notify.* command says: the problem, then what to do. */
export function notifyFailureText(code: string, message: string): string {
  switch (code) {
    case 'test_required':
      return 'Send a test message first: it has to reach you with this bot and account.';
    case 'not_configured':
      return 'Save a bot token first.';
    case 'not_paired':
      return 'Pair your Telegram account first.';
    case 'env_locked':
      return 'The bridge’s environment sets this (HERDR_WORLD_NOTIFY_ENABLED or HERDR_WORLD_TELEGRAM_KEY_FILE).';
    case 'unauthorized':
      return 'Telegram refused the bot token. Copy it again from @BotFather (/token), or make a new one.';
    case 'blocked':
      return 'Telegram will not deliver to you: open the bot’s chat and press Start, or unblock it, then test again.';
    case 'rate_limited':
      return 'Telegram asks to slow down. Wait a few seconds and try again.';
    case 'unreachable':
      return 'The bridge could not reach Telegram. Check its network, then try again.';
    case 'timeout':
      return 'Telegram did not answer in time. Try again.';
    case 'conflict':
      return 'Another program reads this bot’s updates (a webhook, or a second bridge with this token). Stop it, then pair again.';
    case 'bad_request':
      return message || 'The bridge refused that.';
    case 'unknown_command':
    case 'unsupported':
      return 'This bridge has no Telegram notifications. Update it to use this.';
  }
  return message || `The bridge could not do that (${code}).`;
}

/** What a pairing in progress (or the last one) says. */
export function pairingText(c: NotifyChannel, now: number): string {
  const p = c.pairing;
  if (!p) return '';
  if (p.state === 'expired') return p.message || 'The code expired before it arrived. Start pairing again.';
  const left = expiresIn(p.expires_at, now);
  const until = left ? ` The code expires in ${left}.` : '';
  if (p.state === 'conflict') return `${p.message || 'Another program reads this bot’s updates: retrying.'}${until}`;
  if (p.state === 'error') return `${p.message || 'Telegram failed: retrying.'}${until}`;
  return `Send this code to ${botName(c)} on Telegram, from the account that should get the messages.${until}`;
}
