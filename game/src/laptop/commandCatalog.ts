import type { CommandResult } from '../net/client';
import type { CommandArgs, CommandEntry } from '../net/protocol';

/**
 * #140: each worker's slash commands and skills (`worker.commands`, #136), kept for the transcript's `/` popup: asked
 * when the transcript opens for a worker and again when the popup opens, the last list kept meanwhile (the popup shows
 * it at once and follows the refresh). One ask per worker at a time. No DOM.
 *
 * - No list yet: `commands` null (`loading` while the first ask is out).
 * - `partial`: the bridge has not probed the harness yet: only its static built-ins (none for Claude).
 * - `failed`: the last ask failed (a timeout, the link down, an internal error); the list it had stays.
 * - `unavailable`: the bridge says the worker has none (`invalid_state`: no Claude or Codex agent, an asleep floor, no
 *   directory; `unknown_worker`): no list and no popup. Asked again at most every `RETRY_UNAVAILABLE_MS`, since a
 *   floor wakes and an agent starts.
 */

export interface CommandsState {
  readonly commands: readonly CommandEntry[] | null;
  readonly partial: boolean;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly unavailable: boolean;
}

export interface CatalogHost {
  send(t: 'worker.commands', args: CommandArgs['worker.commands']): Promise<CommandResult>;
  /** The clock of the unavailable retry (default Date.now). */
  now?(): number;
}

/** An unavailable worker is asked again after this long. */
export const RETRY_UNAVAILABLE_MS = 10_000;
/** How many workers' lists are kept (the least recently used goes). */
const KEEP = 64;
const KINDS = new Set<CommandEntry['kind']>(['command', 'skill', 'custom']);

/** The bridge's rows that can be offered: a name that is one word (no leading slash), strings, a known kind. */
function rows(v: unknown): CommandEntry[] | null {
  if (!Array.isArray(v)) return null;
  const out: CommandEntry[] = [];
  for (const r of v) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.replace(/^\/+/, '') : '';
    if (!name || /\s/.test(name)) continue;
    const kind = KINDS.has(o.kind as CommandEntry['kind']) ? (o.kind as CommandEntry['kind']) : 'skill';
    out.push({ name, description: typeof o.description === 'string' ? o.description : '', argument_hint: typeof o.argument_hint === 'string' ? o.argument_hint : '', kind });
  }
  return out;
}

export class WorkerCommandList {
  private s: CommandsState = { commands: null, partial: false, loading: false, failed: false, unavailable: false };
  private out: Promise<void> | null = null;
  private lastTry = -Infinity;
  private readonly subs = new Set<() => void>();

  constructor(
    readonly id: string,
    private readonly host: CatalogHost,
  ) {}

  get state(): CommandsState {
    return this.s;
  }

  /** The ask that is out, or a new one (none while unavailable and asked recently). */
  refresh(): Promise<void> {
    if (this.out) return this.out;
    const now = this.host.now?.() ?? Date.now();
    if (this.s.unavailable && now - this.lastTry < RETRY_UNAVAILABLE_MS) return Promise.resolve();
    this.lastTry = now;
    this.set({ loading: true });
    const p = this.host
      .send('worker.commands', { id: this.id })
      .catch((e: unknown): CommandResult => ({ ok: false, code: 'internal', message: String(e) }))
      .then((r) => {
        this.out = null;
        if (!r.ok) {
          if (r.code === 'invalid_state' || r.code === 'unknown_worker') this.set({ commands: null, partial: false, loading: false, failed: false, unavailable: true });
          else this.set({ loading: false, failed: true });
          return;
        }
        const d = (r.data ?? {}) as { commands?: unknown; partial?: unknown };
        const commands = rows(d.commands);
        if (!commands) this.set({ loading: false, failed: true });
        else this.set({ commands, partial: d.partial === true, loading: false, failed: false, unavailable: false });
      });
    this.out = p;
    return p;
  }

  subscribe(f: () => void): () => void {
    this.subs.add(f);
    return () => this.subs.delete(f);
  }

  private set(next: Partial<CommandsState>): void {
    this.s = { ...this.s, ...next };
    for (const f of [...this.subs]) f();
  }
}

export class CommandCatalogs {
  private readonly lists = new Map<string, WorkerCommandList>();

  constructor(private readonly host: CatalogHost) {}

  get(id: string): WorkerCommandList {
    let l = this.lists.get(id);
    if (l) this.lists.delete(id);
    else l = new WorkerCommandList(id, this.host);
    this.lists.set(id, l);
    for (const old of this.lists.keys()) {
      if (this.lists.size <= KEEP) break;
      this.lists.delete(old);
    }
    return l;
  }
}
