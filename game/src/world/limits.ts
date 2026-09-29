/**
 * Plan limits (M10, #12): the bridge's `limits.update` events and the
 * snapshot's `limits`, and everything the widget and the dialogs say about
 * them, as plain data (colours, stale, reset times). The widget only turns
 * these views into DOM, so what matters is covered by vitest.
 */

import type { LimitCredits, Limits, LimitWindow } from '../net/protocol';

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
  return l;
}

/** The latest reading of each provider. */
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
        if (l) this.map.set(l.provider, l);
      }
    this.version++;
  }

  upsert(v: unknown): boolean {
    const l = limitsOf(v);
    if (!l) return false;
    this.known = true;
    this.map.set(l.provider, l);
    this.version++;
    return true;
  }

  get(provider: string): Limits | undefined {
    return this.map.get(provider);
  }

  /** Claude first, then Codex, then any other provider by name. */
  list(): Limits[] {
    const rank = (p: string) => {
      const i = (PROVIDERS as readonly string[]).indexOf(p);
      return i < 0 ? PROVIDERS.length : i;
    };
    return [...this.map.values()].sort((a, b) => rank(a.provider) - rank(b.provider) || a.provider.localeCompare(b.provider));
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
}

export interface ProviderView {
  provider: string;
  name: string;
  plan: string;
  /** The plan's own windows, then the per-model ones. */
  windows: WindowView[];
  models: WindowView[];
  /** Older than STALE_MS, from a transcript, or the last read failed: dimmed. */
  stale: boolean;
  /** A limit is reached (a window at 100 %, or Codex's rateLimitReachedType): pulses. */
  reached: boolean;
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
    key: `${l.provider}:${w.model ?? ''}:${w.label}:${i}`,
    label: w.label,
    model: w.model ?? null,
    pct: w.pct,
    pctText: `${Math.round(w.pct)}%`,
    severity: severity(w.pct),
    resets: resetText(w.resets_at, now, tz),
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
    name: PROVIDER_NAME[l.provider] ?? l.provider,
    plan: l.plan,
    windows,
    models,
    stale,
    reached: !!l.reached || l.windows.some((w) => w.pct >= 100),
    asOf: stale && l.at ? `as of ${read}` : null,
    readNote: !l.at ? '' : fromLog ? `As of ${read}, from the last Codex session log` : stale ? `Last read ${read} (${agoText(l.at, now)})` : `Read ${read} (${agoText(l.at, now)})`,
    problem: l.error ? (ERRORS[l.error] ?? ERRORS.failed ?? null) : null,
    credits: creditsText(l.credits),
    worst,
    worstSeverity: severity(worst),
  };
}

/** Every provider's view, in display order. */
export function limitsView(book: LimitBook, now: number, tz?: string): ProviderView[] {
  return book.list().map((l) => providerView(l, now, tz));
}

/** The views of the given harnesses (the dialogs), each once, in display order; a harness with no reading is left out. */
export function harnessViews(book: LimitBook, harnesses: readonly string[], now: number, tz?: string): ProviderView[] {
  const want = new Set(harnesses.map(providerOf));
  return limitsView(book, now, tz).filter((v) => want.has(v.provider));
}

/** What a dialog warns about a provider whose plan is nearly used up ("" when there is nothing to warn about). */
export function warningOf(v: ProviderView): string {
  const top = [...v.windows].sort((a, b) => b.pct - a.pct)[0];
  const back = top?.resets ? `, resets ${top.resets}` : '';
  if (v.reached) return top && top.pct >= 100 ? `${v.name} has used up its ${top.label} limit${back}.` : `${v.name} has reached a limit.`;
  if (top && top.pct >= HIGH_PCT) return `${v.name} ${top.label} limit is at ${top.pctText}${back}.`;
  return '';
}
