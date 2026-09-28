/** Pure helpers that turn protocol objects into what the game shows. */

import type { Worker } from '../net/protocol';

/** Bridge default for `--max-desks`; the local fallback uses the same cap. */
export const MAX_DESKS = 96;
export const MIN_DESKS = 6;

/**
 * Desks a floor renders when the bridge does not say (`floor.desks`):
 * `max(maxDeskIndex+1, min(cap, max(6, workers+2)))`, so there is always a
 * free desk to hire into, and never fewer desks than the highest slot in use.
 */
export function deskCountFallback(workers: number, maxDeskIndex: number, cap = MAX_DESKS): number {
  return Math.max(maxDeskIndex + 1, Math.min(cap, Math.max(MIN_DESKS, workers + 2)));
}

const validDesk = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/**
 * Desk slot per worker. Bridge `desk_index` wins; workers without one (older
 * bridge) or with a clashing one keep their previous local slot if it is still
 * free, else take the lowest free slot, in the order given.
 */
export function assignDesks(
  workers: ReadonlyArray<Pick<Worker, 'id' | 'desk_index'>>,
  prev: ReadonlyMap<string, number> = new Map(),
): Map<string, number> {
  const out = new Map<string, number>();
  const taken = new Set<number>();
  const rest: string[] = [];
  for (const w of workers) {
    if (validDesk(w.desk_index) && !taken.has(w.desk_index)) {
      out.set(w.id, w.desk_index);
      taken.add(w.desk_index);
    } else {
      rest.push(w.id);
    }
  }
  const needFresh: string[] = [];
  for (const id of rest) {
    const p = prev.get(id);
    if (p !== undefined && !taken.has(p)) {
      out.set(id, p);
      taken.add(p);
    } else {
      needFresh.push(id);
    }
  }
  let next = 0;
  for (const id of needFresh) {
    while (taken.has(next)) next++;
    out.set(id, next);
    taken.add(next);
  }
  return out;
}

/** What a worker's card and animation show. */
export type Display = 'working' | 'done' | 'needs_you' | 'idle' | 'asleep';

export function displayStatus(status: string, floorAsleep: boolean): Display {
  if (floorAsleep) return 'asleep';
  switch (status) {
    case 'working':
      return 'working';
    case 'done':
      return 'done';
    case 'blocked':
      return 'needs_you';
    default:
      return 'idle';
  }
}

export const CHIP_TEXT: Record<Display, string> = {
  working: 'WORKING',
  done: 'DONE',
  needs_you: 'NEEDS YOU',
  idle: 'IDLE',
  asleep: 'ASLEEP',
};

/** Words for the prompt bar, e.g. `Nibble · working · …`. */
export const STATUS_WORD: Record<Display, string> = {
  working: 'working',
  done: 'done',
  needs_you: 'needs you',
  idle: 'idle',
  asleep: 'asleep',
};

export function displayName(w: Pick<Worker, 'name' | 'label'>): string {
  const n = w.name?.trim();
  if (n) return n;
  const l = w.label.trim();
  return l || 'Worker';
}

/** `harness`, else `agent_kind` when it is a harness we know. */
export function resolveHarness(w: Pick<Worker, 'harness' | 'agent_kind'>): string | undefined {
  if (w.harness) return w.harness;
  if (w.agent_kind === 'claude' || w.agent_kind === 'codex') return w.agent_kind;
  return undefined;
}

/** One-line task: the terminal title, else the workspace label. */
export function taskLine(w: Pick<Worker, 'title' | 'label'>): string {
  const t = w.title?.trim();
  if (t) return t;
  return w.label.trim();
}

export type CueFamily = 'opus' | 'fable' | 'sonnet' | 'haiku' | 'sol' | 'luna' | 'astra' | 'other' | 'unknown' | 'none';

export interface ModelCue {
  family: CueFamily;
  /** Hat and laptop-sticker colour. */
  color: number;
  hat: 'beanie' | 'cap' | 'none';
}

export const CUE_COLORS: Record<CueFamily, number> = {
  opus: 0xff7a3d,
  fable: 0x17b897,
  sonnet: 0x4aa3f0,
  haiku: 0x9ccf4f,
  sol: 0xffc21a,
  luna: 0x8190ff,
  astra: 0xe04fc0,
  other: 0xb48a6a,
  unknown: 0xa9a49b,
  none: 0xa9a49b,
};

const FAMILIES: CueFamily[] = ['opus', 'fable', 'sonnet', 'haiku', 'sol', 'luna', 'astra'];

/** Hat shape per harness (claude: beanie, codex: cap), colour per model family. */
export function modelCue(harness: string | undefined, model: string | undefined): ModelCue {
  if (!harness && !model) return { family: 'none', color: CUE_COLORS.none, hat: 'none' };
  let family: CueFamily = 'unknown';
  if (model) {
    const m = model.toLowerCase();
    family = FAMILIES.find((f) => m.includes(f)) ?? 'other';
  }
  const hat = harness === 'codex' ? 'cap' : 'beanie';
  return { family, color: CUE_COLORS[family], hat };
}

/** `claude opus-5-5 high` / `codex gpt-6-sol medium`; empty when nothing is known. */
export function modelLabel(harness: string | undefined, model: string | undefined, effort: string | undefined): string {
  let m = model ?? '';
  if (harness === 'claude' && m.startsWith('claude-')) m = m.slice('claude-'.length);
  return [harness, m, effort].filter((s): s is string => !!s).join(' ');
}

/** Stable small hash for per-worker variation (tint, animation phase). */
export function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
