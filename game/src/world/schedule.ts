import type { HireOptions, Schedule, ScheduleRemoved, ScheduleSource, ScheduleSpec, ScheduleState } from '../net/protocol';
import { modelsFor } from './hire';
import { effortsFor } from './settings';

/**
 * #64 schedules (part 3 of #61), the game's side: pure logic, no DOM. The bridge owns the schedules (#62:
 * `World.schedules`, `schedule.upsert` / `schedule.removed`); this keeps them (`ScheduleBook`), sorts them into the
 * dialog's three sections, says how late a fire was and what a toast says when one moves on, and checks the form.
 */

/** The bridge's grace (#62 decision 3): a fire this late or less is on time. */
export const SCHEDULE_GRACE_MS = 5 * 60_000;
/** `title`: 1–200 bytes after trimming (the bridge's `ScheduleMaxTitle`). */
export const SCHEDULE_TITLE_MAX = 200;
/** The bridge keeps each floor's last 50 `done`; the dialog shows as many. */
export const SCHEDULE_KEEP_DONE = 50;

const UPCOMING: ReadonlySet<ScheduleState> = new Set(['scheduled', 'waiting', 'running']);
const ATTENTION: ReadonlySet<ScheduleState> = new Set(['failed', 'skipped']);

/**
 * #64 schedules: the bridge's schedules in view. `known` false: a bridge before #62 (its snapshot has no `schedules`,
 * read as none).
 */
export class ScheduleBook {
  known = false;
  version = 0;
  private readonly byId = new Map<string, Schedule>();

  reset(list: Schedule[] | undefined): void {
    this.known = Array.isArray(list);
    this.byId.clear();
    for (const s of list ?? []) if (isSchedule(s)) this.byId.set(s.id, s);
    this.version++;
  }

  upsert(s: Schedule): void {
    this.known = true;
    // Cancelled and dismissed ones are out of view (the bridge sends `schedule.removed` for them).
    if (s.state === 'cancelled' || s.dismissed_at) this.byId.delete(s.id);
    else this.byId.set(s.id, s);
    this.version++;
  }

  removed(e: ScheduleRemoved): void {
    this.known = true;
    if (this.byId.delete(e.id)) this.version++;
  }

  get(id: string): Schedule | undefined {
    return this.byId.get(id);
  }

  all(): Schedule[] {
    return [...this.byId.values()];
  }
}

function isSchedule(s: unknown): s is Schedule {
  const o = s as Partial<Schedule> | null;
  return !!o && typeof o.id === 'string' && typeof o.floor === 'string' && typeof o.state === 'string' && typeof o.due_at === 'number';
}

/** The dialog's sections of some schedules. */
export interface ScheduleSections {
  /** `scheduled`, `waiting` and `running` (starting), soonest first. */
  upcoming: Schedule[];
  /** `failed` and `skipped`, the latest change first; they stay until dismissed. */
  attention: Schedule[];
  /** The last `done`, newest fire first, at most `SCHEDULE_KEEP_DONE`. */
  done: Schedule[];
}

export function scheduleSections(list: Iterable<Schedule>): ScheduleSections {
  const out: ScheduleSections = { upcoming: [], attention: [], done: [] };
  for (const s of list) {
    if (UPCOMING.has(s.state)) out.upcoming.push(s);
    else if (ATTENTION.has(s.state)) out.attention.push(s);
    else if (s.state === 'done') out.done.push(s);
  }
  const byId = (a: Schedule, b: Schedule) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  out.upcoming.sort((a, b) => a.due_at - b.due_at || byId(a, b));
  out.attention.sort((a, b) => b.updated_at - a.updated_at || byId(a, b));
  out.done.sort((a, b) => (b.fired_at ?? b.updated_at) - (a.fired_at ?? a.updated_at) || byId(a, b));
  out.done.length = Math.min(out.done.length, SCHEDULE_KEEP_DONE);
  return out;
}

/** How late a fire was (ms) when that is over the grace; null when on time, early (Run now) or not fired. */
export function lateBy(s: Pick<Schedule, 'due_at' | 'fired_at'>): number | null {
  if (typeof s.fired_at !== 'number') return null;
  const late = s.fired_at - s.due_at;
  return late > SCHEDULE_GRACE_MS ? late : null;
}

/** `3h`, `2h 20m`, `45m`, `1d 4h`: a lateness, coarsely. */
export function spanText(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.floor(h / 24)}d`;
}

/** The badge of a late fire: `+3h late`. */
export function lateText(ms: number): string {
  return `+${spanText(ms)} late`;
}

/** The `on_miss` policy in words. */
export function onMissText(s: Pick<Schedule, 'on_miss' | 'max_lateness_ms'>): string {
  if (s.on_miss === 'skip') return 'Skip if missed';
  return s.max_lateness_ms && s.max_lateness_ms > 0 ? `Run late, only if less than ${spanText(s.max_lateness_ms)} late` : 'Run late if missed';
}

/** A toast for a schedule that moved on. */
export interface ScheduleToast {
  kind: 'fired' | 'late' | 'skipped' | 'failed';
  text: string;
  level: 'info' | 'warn' | 'error';
}

/**
 * What to say when a live upsert moves a schedule on (null: nothing). Only a known schedule whose state changed into
 * `done`, `failed` or `skipped` says anything: a first sight (a snapshot, a reconnect, a schedule made elsewhere)
 * and an upsert in the same state (a re-delivered one) never do. `running` is the dialog's "starting", not a toast.
 */
export function scheduleToast(old: Schedule | undefined, next: Schedule): ScheduleToast | null {
  if (!old || old.state === next.state) return null;
  const title = `“${next.title}”`;
  switch (next.state) {
    case 'done': {
      const late = lateBy(next);
      return late !== null ? { kind: 'late', text: `Scheduled agent ${title} started ${spanText(late)} late.`, level: 'warn' } : { kind: 'fired', text: `Scheduled agent ${title} started.`, level: 'info' };
    }
    case 'failed':
      return { kind: 'failed', text: `Scheduled agent ${title} failed${next.state_reason ? `: ${next.state_reason}` : ''}.`, level: 'error' };
    case 'skipped':
      return { kind: 'skipped', text: `Scheduled agent ${title} was skipped${next.state_reason ? `: ${next.state_reason}` : ''}.`, level: 'warn' };
    default:
      return null;
  }
}

/** The create/edit form as filled in. `due` is the resolved instant (null: the time does not read yet). */
export interface ScheduleForm {
  floor: string;
  title: string;
  prompt: string;
  due: number | null;
  /** Why the time does not read (shown while `due` is null). */
  dueError: string;
  harness: string;
  model: string;
  effort: string;
  cwd: string;
  worktree: boolean;
  wakeFloor: boolean;
  onMiss: 'run_late' | 'skip';
  /** "Only if less than N h late" (`run_late` only): its hours as typed, "" for no limit. */
  maxLateHours: string;
  /** The handoff the worker reads: none, a cabinet entry's (or the edited schedule's) path, or this transcript message filed on save. */
  handoff: { kind: 'none' } | { kind: 'path'; path: string; title?: string } | { kind: 'transcript' };
}

const bytes = (s: string) => new TextEncoder().encode(s).length;

/** "Only if less than N h late" as ms (null: no limit; NaN: not a positive number). */
export function maxLateMs(hours: string): number | null {
  const t = hours.trim();
  if (!t) return null;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 3_600_000) : Number.NaN;
}

/**
 * Why the form cannot be saved (null: it can): the bridge's own checks (#62 `applyScheduleSpec`) as far as the game
 * can see them. `promptBytes` is the prompt as it would be sent (images as their paths).
 */
export function scheduleBlocker(f: ScheduleForm, options: HireOptions, now: number, promptBytes = bytes(f.prompt)): string | null {
  if (!f.floor) return 'Choose a floor.';
  const title = f.title.trim();
  if (!title) return 'Give it a title.';
  if (bytes(title) > SCHEDULE_TITLE_MAX) return `The title is at most ${SCHEDULE_TITLE_MAX} bytes.`;
  if (/[\u0000-\u001f\u007f]/.test(title)) return 'The title can’t hold control characters.';
  if (f.due === null) return f.dueError || 'Say when it should start.';
  if (f.due <= now) return 'That time has passed: pick a later one.';
  if (!options[f.harness]) return 'Choose a harness.';
  if (!modelsFor(options, f.harness).length) return 'Every model for this harness is hidden. Show one in Settings.';
  if (!modelsFor(options, f.harness).includes(f.model)) return 'Choose a model.';
  if (!effortsFor(options, f.harness, f.model).includes(f.effort)) return 'Choose an effort.';
  const cwd = f.cwd.trim();
  if (!cwd) return 'Give the folder it works in.';
  if (!cwd.startsWith('/')) return 'The folder must be an absolute path.';
  if (!f.prompt.trim() && f.handoff.kind === 'none') return 'Write the prompt, or attach a handoff for it to read.';
  if (promptBytes > 32 * 1024) return 'The prompt is at most 32 KiB.';
  if (f.prompt.trim().startsWith('--')) return 'The prompt can’t start with “--” (herdr would read it as a flag).';
  if (f.onMiss === 'run_late' && Number.isNaN(maxLateMs(f.maxLateHours) ?? 0)) return '“Only if less than … late” takes a number of hours above 0.';
  return null;
}

/**
 * `schedule.create`'s args for the form (`handoffPath`: the transcript message's, once filed). `wake_floor` is always
 * sent, since its absence means on.
 */
export function scheduleSpec(f: ScheduleForm, prompt: string, handoffPath: string | null, source?: ScheduleSource): ScheduleSpec {
  const spec: ScheduleSpec = {
    floor: f.floor,
    title: f.title.trim(),
    prompt,
    due_at: f.due ?? 0,
    on_miss: f.onMiss,
    harness: f.harness,
    model: f.model,
    effort: f.effort,
    cwd: f.cwd.trim(),
    worktree: f.worktree,
    wake_floor: f.wakeFloor,
  };
  const max = f.onMiss === 'run_late' ? maxLateMs(f.maxLateHours) : null;
  if (max !== null && !Number.isNaN(max)) spec.max_lateness_ms = max;
  const path = f.handoff.kind === 'path' ? f.handoff.path : f.handoff.kind === 'transcript' ? handoffPath : null;
  if (path) spec.handoff_path = path;
  if (source) spec.source = source;
  return spec;
}
