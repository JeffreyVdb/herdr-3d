import type { CommandRequest, ManualAttention, ManualProcess, RequestedCommand, Worker } from '../net/protocol';

const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const string = (v: unknown): v is string => typeof v === 'string';

/** Reject malformed requests rather than presenting an incomplete command for execution. */
export function commandRequestOf(worker: Pick<Worker, 'command_request'> | null | undefined): CommandRequest | null {
  const r: unknown = worker?.command_request;
  if (!obj(r) || !string(r.key) || !r.key || typeof r.at !== 'number' || !Number.isFinite(r.at) || !Array.isArray(r.commands) || !r.commands.length || r.commands.length > 3) return null;
  const commands: RequestedCommand[] = [];
  for (const c of r.commands) {
    if (!obj(c) || !string(c.command) || !c.command || !string(c.cwd) || typeof c.cwd_named !== 'boolean' || !['bridge', 'other', 'unknown'].includes(String(c.host)) || (c.host_text !== undefined && !string(c.host_text)) || (c.why !== undefined && !string(c.why))) return null;
    if (c.variants !== undefined && (!Array.isArray(c.variants) || !c.variants.every((v: unknown) => obj(v) && string(v.label) && string(v.command) && !!v.command && string(v.note)))) return null;
    const command: RequestedCommand = { command: c.command, cwd: c.cwd, cwd_named: c.cwd_named, host: c.host as RequestedCommand['host'], host_text: string(c.host_text) ? c.host_text : '', why: string(c.why) ? c.why : '' };
    if (Array.isArray(c.variants)) command.variants = c.variants.map((v) => ({ label: v.label as string, command: v.command as string, note: v.note as string }));
    commands.push(command);
  }
  return { key: r.key, at: r.at, commands };
}

export class ManualProcessBook {
  known = false;
  version = 0;
  private readonly byId = new Map<string, ManualProcess>();
  reset(list: ManualProcess[] | undefined): void {
    this.known = Array.isArray(list);
    this.byId.clear();
    for (const process of Array.isArray(list) ? list : []) if (validProcess(process)) this.byId.set(process.id, process);
    this.version++;
  }
  upsert(process: ManualProcess): void {
    if (!validProcess(process)) return;
    this.known = true;
    this.byId.set(process.id, process);
    this.version++;
  }
  removed(id: string): void {
    this.known = true;
    if (this.byId.delete(id)) this.version++;
  }
  get(id: string): ManualProcess | undefined { return this.byId.get(id); }
  all(): ManualProcess[] { return [...this.byId.values()]; }
}

function validProcess(p: unknown): p is ManualProcess {
  return obj(p) && string(p.id) && !!p.id && string(p.worker) && string(p.state) && string(p.cleanup);
}

export function needsAttention(p: ManualProcess): boolean {
  return !['exited', 'stopped', 'failed'].includes(p.state) || p.cleanup === 'needed' || p.cleanup === 'failed';
}

// ---- #213: a run asking for you ------------------------------------------------------------------------------

export interface RunAttention { process: ManualProcess; attention: ManualAttention }

const terminal = (p: ManualProcess) => ['exited', 'stopped', 'failed'].includes(p.state);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The run's open episode, or null. A credential request is the `credential` field (the only thing the password dialog
 * answers), with or without the bridge's `attention` for it; an `input` episode is only ever confirmed or uncertain.
 * Anything malformed, and anything on a run that has ended, is no episode.
 */
export function attentionOf(p: ManualProcess): ManualAttention | null {
  if (terminal(p)) return null;
  const a: unknown = p.attention;
  const ok = obj(a) && string(a.id) && !!a.id && a.id.length <= 256 && string(a.reason) && finite(a.since) && (a.expires_at === undefined || finite(a.expires_at));
  const c = p.credential;
  if (obj(c) && string(c.request) && c.request) {
    const since = ok && a.kind === 'credential' ? (a.since as number) : 0;
    return { id: c.request, kind: 'credential', confidence: 'authenticated', reason: 'askpass', since, ...(finite(c.expires_at) ? { expires_at: c.expires_at } : {}) };
  }
  if (!ok || a.kind !== 'input' || (a.confidence !== 'confirmed' && a.confidence !== 'uncertain')) return null;
  return { id: a.id as string, kind: 'input', confidence: a.confidence, reason: a.reason as string, since: a.since as number, ...(finite(a.expires_at) ? { expires_at: a.expires_at } : {}) };
}

/** What the bridge can see of this run's terminal; null: an older bridge that does not say. */
export function inputDetectionOf(p: ManualProcess): 'full' | 'hints' | 'none' | null {
  return p.input_detection === 'full' || p.input_detection === 'hints' || p.input_detection === 'none' ? p.input_detection : null;
}

/** The runs asking for you, oldest episode first. */
export function openAttention(processes: Iterable<ManualProcess>): RunAttention[] {
  const out: RunAttention[] = [];
  for (const process of processes) {
    const attention = attentionOf(process);
    if (attention) out.push({ process, attention });
  }
  return out.sort((a, b) => a.attention.since - b.attention.since || a.process.created_at - b.process.created_at);
}

/** The episode in words, by kind and certainty: an `input` episode is never a password request. */
export function attentionLabel(a: ManualAttention): string {
  if (a.kind === 'credential') return 'Password requested';
  return a.confidence === 'confirmed' ? 'Waiting for input' : 'May be waiting for input';
}

const REASONS = new Map([['tty_read', 'It is reading from its terminal'], ['tty_wait', 'It seems to wait on its terminal'], ['sudo_terminal', 'sudo runs in its terminal, not in the password dialog']]);

/** The reason code in words; an unknown code (`constructor` too: a Map, no prototype) says nothing more than the label. */
export function attentionDetail(a: ManualAttention): string {
  if (a.kind === 'credential') return 'sudo asked for the password in the dialog';
  return REASONS.get(a.reason) ?? '';
}

/** The direct action: answer the password dialog, or open the run's terminal. */
export const attentionAction = (a: ManualAttention): 'Respond' | 'Open terminal' => (a.kind === 'credential' ? 'Respond' : 'Open terminal');

/** The run's command, short: its first line, cut at `max` characters. */
export function shortCommand(p: Pick<ManualProcess, 'command' | 'title'>, max = 40): string {
  const line = (p.command || p.title || '').trim().split('\n')[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Several runs: "2 runs need you", or "2 runs may be waiting for input" when none is more than a hint. */
export function attentionCount(list: readonly RunAttention[]): string {
  const n = list.length;
  return list.every((r) => r.attention.confidence === 'uncertain') ? `${n} runs may be waiting for input` : `${n} runs need you`;
}

/** Input detection that cannot see every prompt, in words (null: nothing to say). */
export function detectionNote(p: ManualProcess): string | null {
  const d = inputDetectionOf(p);
  if (d === 'hints') return 'Other prompts may not be detected on this machine: the terminal shows what the command asks.';
  if (d === 'none') return 'Prompts are not detected on this machine: the terminal shows what the command asks.';
  return null;
}

/** Where the announced ids are kept: the tab's `sessionStorage` in the game (null: none, or it throws). */
export type EpisodeStore = Pick<Storage, 'getItem' | 'setItem'>;

const SEEN_KEY = 'h3d.manual.attention.seen';
const SEEN_MAX = 200;

/**
 * The episodes this browser tab has announced (a toast, a desktop notification), by `attention.id`: a reconnect's
 * snapshot, or a reload (the ids are in the tab's storage), brings the same ids back and announces nothing; a new tab
 * starts afresh. `gone` lists the ids no longer open; an episode that was seen open and then ended is forgotten (its id
 * does not come back: a new request or new input is a new id). Bounded, oldest first.
 */
export class AttentionEpisodes {
  private readonly seen: Set<string>;
  private open = new Set<string>();
  constructor(private readonly store: EpisodeStore | null = null) {
    this.seen = new Set(this.load());
  }
  update(list: readonly RunAttention[]): { fresh: RunAttention[]; gone: string[] } {
    const fresh = list.filter((r) => !this.seen.has(r.attention.id));
    for (const r of fresh) this.seen.add(r.attention.id);
    const now = new Set(list.map((r) => r.attention.id));
    const gone = [...this.open].filter((id) => !now.has(id));
    this.open = now;
    for (const id of gone) this.seen.delete(id);
    // Bounded: the oldest ids that are not open go first (a Set keeps insertion order), such as ones a reload brought
    // back that ended meanwhile.
    for (const id of this.seen) { if (this.seen.size <= SEEN_MAX) break; if (!now.has(id)) this.seen.delete(id); }
    if (fresh.length || gone.length) this.save();
    return { fresh, gone };
  }
  private load(): string[] {
    try {
      const v: unknown = JSON.parse(this.store?.getItem(SEEN_KEY) ?? '[]');
      return Array.isArray(v) ? v.filter((id): id is string => typeof id === 'string' && !!id && id.length <= 256).slice(-SEEN_MAX) : [];
    } catch {
      return [];
    }
  }
  private save(): void {
    try {
      this.store?.setItem(SEEN_KEY, JSON.stringify([...this.seen]));
    } catch {
      // Full or blocked: this page still remembers.
    }
  }
}
