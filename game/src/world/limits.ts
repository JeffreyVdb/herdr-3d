/**
 * Plan limits (M10, #12): the bridge's `limits.update` events and the
 * snapshot's `limits`, and everything the widget and the dialogs say about
 * them, as plain data (colours, stale, reset times). The widget only turns
 * these views into DOM, so what matters is covered by vitest.
 *
 * #138: Codex is read once per Codex profile (a Codex home folder): a reading is keyed by its provider and its
 * `account.key`; one without an account (an older bridge) is the bridge's own home's, the default. With two or more
 * Codex readings the meter names each by its profile; with one it looks as it did before profiles.
 */

import type { LimitCredits, Limits, LimitsAccount, LimitWindow } from '../net/protocol';

/** Amber from here, red from HIGH_PCT (also where the dialogs warn). */
export const WARN_PCT = 60;
export const HIGH_PCT = 85;
/** A reading older than this is dimmed, whatever the bridge says. */
export const STALE_MS = 10 * 60_000;

export type Severity = 'ok' | 'warn' | 'high';

export const severity = (pct: number): Severity => (pct >= HIGH_PCT ? 'high' : pct >= WARN_PCT ? 'warn' : 'ok');

export const PROVIDERS = ['claude', 'codex'] as const;
export const PROVIDER_NAME: Record<string, string> = { claude: 'Claude', codex: 'Codex' };

/** The harness names the hire options use are the providers'. */
export const providerOf = (harness: string): string => harness;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function windowOf(v: unknown): LimitWindow | null {
  if (!isObj(v) || typeof v.label !== 'string' || typeof v.pct !== 'number' || !Number.isFinite(v.pct)) return null;
  const w: LimitWindow = { label: v.label, pct: Math.max(0, v.pct), resets_at: num(v.resets_at) };
  if (typeof v.model === 'string' && v.model) w.model = v.model;
  if (typeof v.window_mins === 'number') w.window_mins = v.window_mins;
  if (typeof v.reached === 'string' && v.reached) w.reached = v.reached;
  return w;
}

/** A well-formed reading (unknown keys dropped), else null. */
export function limitsOf(v: unknown): Limits | null {
  if (!isObj(v) || typeof v.provider !== 'string' || !v.provider || !Array.isArray(v.windows)) return null;
  const l: Limits = {
    provider: v.provider,
    plan: typeof v.plan === 'string' ? v.plan : '',
    windows: v.windows.map(windowOf).filter((w): w is LimitWindow => w !== null),
    at: num(v.at),
    stale: v.stale === true,
  };
  if (typeof v.error === 'string' && v.error) l.error = v.error;
  if (typeof v.source === 'string') l.source = v.source;
  if (typeof v.reached === 'string' && v.reached) l.reached = v.reached;
  if (isObj(v.credits)) {
    const c: LimitCredits = { has_credits: v.credits.has_credits === true, unlimited: v.credits.unlimited === true };
    if (typeof v.credits.balance === 'string') c.balance = v.credits.balance;
    l.credits = c;
  }
  const a = v.account;
  if (isObj(a) && typeof a.key === 'string' && a.key) {
    const acct: LimitsAccount = { key: a.key, name: typeof a.name === 'string' && a.name ? a.name : a.key, plan: typeof a.plan === 'string' ? a.plan : '', default: a.default === true };
    l.account = acct;
  }
  return l;
}

/** A reading's key in the book: its provider, and its Codex profile's key. */
export const limitsKey = (l: Pick<Limits, 'provider' | 'account'>): string => (l.account ? `${l.provider}:${l.account.key}` : l.provider);

/** The reading is its provider's default: no profile (an older bridge), or the bridge's own Codex home. */
export const isDefaultReading = (l: Limits): boolean => !l.account || l.account.default;

/** The latest reading of each provider (and of each Codex profile). */
export class LimitBook {
  private readonly map = new Map<string, Limits>();
  /** The bridge sent a `limits` list (an M10 bridge): the widget belongs on screen. */
  known = false;
  /** Bumped on every change: the widget renders on it and on nothing else. */
  version = 0;

  reset(list: unknown): void {
    this.map.clear();
    this.known = Array.isArray(list);
    if (Array.isArray(list))
      for (const v of list) {
        const l = limitsOf(v);
        if (l) this.map.set(limitsKey(l), l);
      }
    this.version++;
  }

  upsert(v: unknown): boolean {
    const l = limitsOf(v);
    if (!l) return false;
    this.known = true;
    this.map.set(limitsKey(l), l);
    this.version++;
    return true;
  }

  /** A provider's default reading, or (with `account`) a Codex profile's. */
  get(provider: string, account?: string): Limits | undefined {
    if (account !== undefined) return this.map.get(`${provider}:${account}`);
    const all = [...this.map.values()].filter((l) => l.provider === provider);
    return all.find(isDefaultReading) ?? all[0];
  }

  /**
   * #138: keeps only the Codex profiles in `keys` (the visible ones, as `codex_profiles` says): a profile hidden or
   * removed takes its row off the meter at once. A reading without an account stays.
   */
  retainProfiles(keys: ReadonlySet<string>): void {
    let changed = false;
    for (const [k, l] of this.map)
      if (l.account && !keys.has(l.account.key)) {
        this.map.delete(k);
        changed = true;
      }
    if (changed) this.version++;
  }

  /** Claude first, then Codex (the default profile, then the others by name), then any other provider by name. */
  list(): Limits[] {
    const rank = (p: string) => {
      const i = (PROVIDERS as readonly string[]).indexOf(p);
      return i < 0 ? PROVIDERS.length : i;
    };
    const name = (l: Limits) => l.account?.name ?? '';
    return [...this.map.values()].sort(
      (a, b) =>
        rank(a.provider) - rank(b.provider) ||
        a.provider.localeCompare(b.provider) ||
        Number(isDefaultReading(b)) - Number(isDefaultReading(a)) ||
        name(a).localeCompare(name(b), undefined, { sensitivity: 'base' }) ||
        limitsKey(a).localeCompare(limitsKey(b)),
    );
  }
}

// ---- times ---------------------------------------------------------------------------

const part = (parts: Intl.DateTimeFormatPart[], t: string) => parts.find((p) => p.type === t)?.value ?? '';

/** The parts of a moment in `tz` (the browser's local zone by default), 24-hour. */
function zoned(ms: number, tz?: string) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = f.formatToParts(new Date(ms));
  return { day: `${part(p, 'day')} ${part(p, 'month')}`, weekday: part(p, 'weekday'), clock: `${part(p, 'hour')}:${part(p, 'minute')}` };
}

/**
 * When a window resets, in the local time zone: "17:59" today, "Tue 23:59"
 * within the next 6 days, else "6 Oct 23:59"; "" when unknown.
 */
export function resetText(ms: number, now: number, tz?: string): string {
  if (!ms) return '';
  const t = zoned(ms, tz);
  const n = zoned(now, tz);
  if (t.day === n.day) return t.clock;
  const ahead = ms - now;
  if (ahead > 0 && ahead < 6 * 86_400_000) return `${t.weekday} ${t.clock}`;
  return `${t.day} ${t.clock}`;
}

/** The clock time of a reading ("17:01"), with the day when it is not today. */
export function readText(ms: number, now: number, tz?: string): string {
  if (!ms) return '';
  const t = zoned(ms, tz);
  return t.day === zoned(now, tz).day ? t.clock : `${t.weekday} ${t.clock}`;
}

/** "just now", "3 min ago", "2 h ago". */
export function agoText(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 90) return `${Math.max(1, m)} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

// ---- views -----------------------------------------------------------------------------

export interface WindowView {
  key: string;
  label: string;
  model: string | null;
  pct: number;
  /** "61%" */
  pctText: string;
  severity: Severity;
  /** When it resets ("Tue 23:59"), "" when unknown. */
  resets: string;
  /** The bridge says the limit this window belongs to is reached (Codex's rateLimitReachedType of a model's own limit). */
  reached: boolean;
}

export interface ProviderView {
  provider: string;
  /** The row's identity: the provider, and a Codex profile's key. */
  key: string;
  /** The provider's name ("Codex"). */
  name: string;
  /** #138: the Codex profile's name when there are two or more Codex rows; null otherwise (the row looks as before profiles). */
  profile: string | null;
  /** #138: the Codex profile's key (null: no profile, an older bridge or Claude). */
  account: string | null;
  /** #138: the profile is the bridge's own Codex home (marked when `profile` is set). */
  isDefault: boolean;
  plan: string;
  /** The plan's own windows, then the per-model ones. */
  windows: WindowView[];
  models: WindowView[];
  /** Older than STALE_MS, from a transcript, or the last read failed: dimmed. */
  stale: boolean;
  /** A limit is reached (a window at 100 %, or Codex's rateLimitReachedType, wherever it comes from): pulses. */
  reached: boolean;
  /** The bridge itself says the plan's own limit is reached (Codex's rateLimitReachedType); a model's is on its windows. */
  flagged: boolean;
  /** "as of 17:01" when the reading is stale, else null. */
  asOf: string | null;
  /** What the panel says about the last read: "Read 19:05 (2 min ago)", or where a stale one came from. */
  readNote: string;
  /** Why there is no fresh reading, in words; null when fine. */
  problem: string | null;
  credits: string | null;
  /** The highest own-window percentage (0 when none). */
  worst: number;
  worstSeverity: Severity;
}

const ERRORS: Record<string, string> = {
  no_plan: 'No plan limits: signed in with an API key, or signed out.',
  not_installed: 'Not installed on the bridge’s machine.',
  timeout: 'Did not answer in time.',
  failed: 'Could not be read.',
};

function creditsText(c: LimitCredits | undefined): string | null {
  if (!c) return null;
  if (c.unlimited) return 'Unlimited';
  if (!c.has_credits) return 'None';
  return c.balance ? c.balance : 'Available';
}

/** How one reading shows at `now`. */
export function providerView(l: Limits, now: number, tz?: string): ProviderView {
  const view = (w: LimitWindow, i: number): WindowView => ({
    key: `${limitsKey(l)}:${w.model ?? ''}:${w.label}:${i}`,
    label: w.label,
    model: w.model ?? null,
    pct: w.pct,
    pctText: `${Math.round(w.pct)}%`,
    severity: severity(w.pct),
    resets: resetText(w.resets_at, now, tz),
    reached: !!w.reached,
  });
  const all = l.windows.map(view);
  const windows = all.filter((w) => w.model === null);
  const models = all.filter((w) => w.model !== null);
  const stale = l.stale || l.error !== undefined || now - l.at > STALE_MS;
  const worst = windows.reduce((m, w) => Math.max(m, w.pct), 0);
  const fromLog = l.source === 'transcript';
  const read = readText(l.at, now, tz);
  return {
    provider: l.provider,
    key: limitsKey(l),
    name: PROVIDER_NAME[l.provider] ?? l.provider,
    profile: null,
    account: l.account?.key ?? null,
    isDefault: isDefaultReading(l),
    plan: l.plan,
    windows,
    models,
    stale,
    reached: !!l.reached || l.windows.some((w) => w.pct >= 100 || !!w.reached),
    flagged: !!l.reached,
    asOf: stale && l.at ? `as of ${read}` : null,
    readNote: !l.at ? '' : fromLog ? `As of ${read}, from the last Codex session log` : stale ? `Last read ${read} (${agoText(l.at, now)})` : `Read ${read} (${agoText(l.at, now)})`,
    problem: l.error ? (ERRORS[l.error] ?? ERRORS.failed ?? null) : null,
    credits: creditsText(l.credits),
    worst,
    worstSeverity: severity(worst),
  };
}

/** Every provider's view, in display order; with two or more readings of one provider, each names its profile. */
export function limitsView(book: LimitBook, now: number, tz?: string): ProviderView[] {
  const list = book.list();
  const count = new Map<string, number>();
  for (const l of list) count.set(l.provider, (count.get(l.provider) ?? 0) + 1);
  return list.map((l) => {
    const v = providerView(l, now, tz);
    return (count.get(l.provider) ?? 0) > 1 ? { ...v, profile: l.account?.name ?? 'default' } : v;
  });
}

/** What a dialog is about: a harness and, once chosen, its model (`claude-opus-5-5`). */
export interface LimitTarget {
  harness: string;
  model?: string;
}

/** Words of a model name that tell it apart ("Sonnet 4.5" → sonnet): the digits are versions, not names. */
const nameWords = (s: string): string[] => {
  const words = s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const named = words.filter((w) => !/^\d+$/.test(w));
  return named.length ? named : words;
};

/** Whether a per-model window ("Opus", "Sonnet 4.5", "Spark") is the one of a model id ("claude-opus-5-5"). */
export function windowIsFor(window: WindowView, model: string): boolean {
  if (!window.model) return false;
  const id = model.toLowerCase();
  return nameWords(window.model).every((w) => id.includes(w));
}

/**
 * The view a dialog shows for a provider: the plan's own windows plus the per-model windows of the models
 * chosen (all of them when a choice does not name its model, since then there is no telling which counts).
 * A model without a window of its own is left out: the plan's windows are all it has.
 */
export function scopedView(v: ProviderView, models: readonly (string | undefined)[]): ProviderView {
  const keep = models.some((m) => !m) ? v.models : v.models.filter((w) => models.some((m) => m && windowIsFor(w, m)));
  return { ...v, models: keep, reached: v.flagged || [...v.windows, ...keep].some((w) => w.pct >= 100 || w.reached) };
}

/**
 * The views of the given harnesses (the dialogs), each once, in display order; a harness with no reading is left
 * out. A plain harness name stands for "any model".
 */
export function harnessViews(book: LimitBook, targets: ReadonlyArray<string | LimitTarget>, now: number, tz?: string): ProviderView[] {
  const chosen = new Map<string, Array<string | undefined>>();
  for (const t of targets) {
    const { harness, model } = typeof t === 'string' ? { harness: t, model: undefined } : t;
    const p = providerOf(harness);
    chosen.set(p, [...(chosen.get(p) ?? []), model]);
  }
  // #138: the dialogs hire on the bridge's own Codex home: its profile's limits only.
  return limitsView(book, now, tz)
    .filter((v) => chosen.has(v.provider) && v.isDefault)
    .map((v) => ({ ...v, profile: null }))
    .map((v) => scopedView(v, chosen.get(v.provider)!));
}

/** "5h", or "week · Fable" for a per-model window. */
export const windowName = (w: { label: string; model: string | null }): string => (w.model ? `${w.label} · ${w.model}` : w.label);

/** What a dialog warns about a provider whose plan is nearly used up ("" when there is nothing to warn about). */
export function warningOf(v: ProviderView): string {
  const top = [...v.windows, ...v.models].sort((a, b) => b.pct - a.pct)[0];
  const back = top?.resets ? `, resets ${top.resets}` : '';
  if (v.reached) return top && top.pct >= 100 ? `${v.name} has used up its ${windowName(top)} limit${back}.` : `${v.name} has reached a limit.`;
  if (top && top.pct >= HIGH_PCT) return `${v.name} ${windowName(top)} limit is at ${top.pctText}${back}.`;
  return '';
}
