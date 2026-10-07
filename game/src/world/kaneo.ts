/**
 * #184 Kaneo: the bridge-wide connection as the snapshot's `kaneo` and the `kaneo.update` events carry it
 * (`KaneoBook`), the words for its failures, and a floor's workspace / project pickers' bookkeeping (`LatestOnly`:
 * a late answer to an earlier choice never lands). Pure, so vitest covers it. The bridge never sends a key: only
 * `key_set`.
 */

import type { KaneoState, KaneoWorkspace } from '../net/protocol';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const STATES = ['off', 'ready', 'paused'] as const;

function workspaceOf(v: unknown): KaneoWorkspace | null {
  if (!isObj(v) || !str(v.id)) return null;
  const w: KaneoWorkspace = { id: str(v.id), name: str(v.name) || str(v.id) };
  if (str(v.slug)) w.slug = str(v.slug);
  return w;
}

/** A well-formed state (unknown keys dropped, so nothing else is ever kept), else null. */
export function kaneoStateOf(v: unknown): KaneoState | null {
  if (!isObj(v) || typeof v.state !== 'string' || typeof v.key_set !== 'boolean') return null;
  const state = (STATES as readonly string[]).includes(v.state) ? (v.state as KaneoState['state']) : 'off';
  const s: KaneoState = {
    state,
    available: v.available === true,
    url: str(v.url),
    api_base: str(v.api_base),
    web_origin: str(v.web_origin),
    key_set: v.key_set,
    default_workspace: workspaceOf(v.default_workspace),
    generation: typeof v.generation === 'number' ? v.generation : 0,
  };
  if (typeof v.paused_until === 'number' && v.paused_until > 0) s.paused_until = v.paused_until;
  const e = v.last_error;
  if (isObj(e) && typeof e.kind === 'string') s.last_error = { kind: e.kind, message: str(e.message), at: typeof e.at === 'number' ? e.at : 0, ...(e.runtime === true ? { runtime: true } : {}) };
  return s;
}

/** The connection, and who listens for changes. */
export class KaneoBook {
  /** The bridge sent a `kaneo` state (it has the settings): the section can work. */
  known = false;
  private cur: KaneoState | null = null;
  private readonly listeners = new Set<() => void>();

  get state(): KaneoState | null {
    return this.cur;
  }

  /** Connected: something saved (paused counts: the floors keep their link). */
  get connected(): boolean {
    return !!this.cur && this.cur.state !== 'off';
  }

  reset(v: unknown): void {
    this.cur = kaneoStateOf(v);
    this.known = this.cur !== null;
    this.emit();
  }

  upsert(v: unknown): boolean {
    const next = kaneoStateOf(v);
    if (!next) return false;
    this.cur = next;
    this.known = true;
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

const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Plain words for a `kaneo.*` failure (and a Kaneo board command's 401 / 403): what went wrong and what to do. */
export function kaneoFailureText(code: string, message: string): string {
  const why = message.trim();
  switch (code) {
    case 'unauthorized':
      return 'Kaneo refused the API key. It may be wrong or revoked, or out of its request quota: wait a minute and test again, or paste a new key.';
    case 'forbidden':
      return 'This key may not reach that Kaneo workspace or project. Ask for access in Kaneo, or pick another.';
    case 'bad_url':
      return why || 'That is not a Kaneo address. Use the instance’s https address, e.g. https://kaneo.example.com.';
    case 'key_required':
      return why || 'Paste the API key for this instance.';
    case 'test_required':
      return 'Test the connection before saving it.';
    case 'not_configured':
      return 'Kaneo is not connected. Connect it in Settings → Kaneo first.';
    case 'unreachable':
      return `Kaneo cannot be reached${why ? ` (${why.replace(/^Kaneo could not be reached:\s*/, '')})` : ''}. Check the address and the network.`;
    case 'timeout':
      return 'Kaneo did not answer in time. Try again.';
    case 'rate_limited':
      return why || 'Kaneo is rate limiting this key. Try again in a minute.';
    case 'not_found':
      return why || 'Kaneo does not know it any more (deleted, or not visible to this key).';
    case 'stale':
      return 'The floor changed while this was saved. Save again.';
    case 'bad_request':
      return why.replace(/^bad args:\s*/, '') || 'Kaneo did not accept that.';
    case 'unknown_command':
      return 'This bridge has no Kaneo support. Update it to use this.';
    case 'unsupported':
      return why || 'This bridge cannot reach Kaneo.';
    case 'offline':
    case 'disconnected':
      return 'Not connected to herdr-world. Try again once it reconnects.';
    case 'provider_failed':
      return why || 'Kaneo failed. Try again.';
    default:
      return why || code;
  }
}

/** The connection's line in the section's header badge and in a floor's tracker picker. */
export function kaneoStatusText(s: KaneoState | null, now: number): string {
  if (!s) return 'This bridge has no Kaneo support.';
  if (!s.available && s.state === 'off') return 'This bridge cannot reach Kaneo yet.';
  switch (s.state) {
    case 'off':
      return 'Not connected.';
    case 'paused':
      return `Paused: Kaneo refused the key${s.paused_until && s.paused_until > now ? `; boards try again at ${clock(s.paused_until)}` : ''}. Test again, or paste a new key.`;
    default:
      return `Connected to ${hostOf(s.web_origin || s.api_base)}.`;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The latest of a series of requests (a picker's list for the choice in force): `next()` hands out a ticket, and only
 * the newest ticket's answer counts. A workspace switched twice quickly gets the second list even when the first one
 * answers last.
 */
export class LatestOnly {
  private n = 0;

  next(): number {
    return ++this.n;
  }

  /** Whether `ticket` is still the newest (a later choice drops its answer). */
  current(ticket: number): boolean {
    return ticket === this.n;
  }

  /** Forget any answer in flight (the picker is reset). */
  cancel(): void {
    this.n++;
  }
}
