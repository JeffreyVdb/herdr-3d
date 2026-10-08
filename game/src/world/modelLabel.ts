/**
 * Readable model names (#200), one place for every model picker (Hire, Start run, team presets, floor defaults) and
 * Settings → Harness models. The bridge sends the harness's own
 * display names (`model_labels`, keyed by exact launch id); everything else here is presentation. The id stays the
 * value: selection, the submitted launch id, saved defaults, hidden-model prefs and effort lookup never see a label.
 * All functions are pure and return plain text (callers set it with `textContent`, never `innerHTML`).
 */

import type { HarnessOptions } from '../net/protocol';

/** Readable names by exact launch id, as `HarnessOptions.model_labels` carries them. */
export type ModelLabels = Readonly<Record<string, string>> | undefined;

/** A provider name longer than this is not a name: the id is shown instead. */
const MAX_LABEL = 64;

/** The labels of a catalog entry (undefined for an unknown harness or a bridge that sends none). */
export function labelsOf(options: Record<string, HarnessOptions | undefined>, harness: string): ModelLabels {
  return options[harness]?.model_labels;
}

/** A provider label as plain single-line text, or '' when it is not usable. */
function providerLabel(id: string, labels: ModelLabels): string {
  if (!labels || !Object.hasOwn(labels, id)) return '';
  const raw: unknown = labels[id];
  if (typeof raw !== 'string') return '';
  const s = raw.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > MAX_LABEL ? '' : s;
}

/**
 * A Codex label that is still a slug-like token (`GPT-6.1-Sol`) with its separators turned into spaces
 * (`GPT 6.1 Sol`). Only a label without whitespace is touched; dots stay, so `6.1` is not `6`, and every
 * variant word is kept.
 */
export function spaceSeparators(label: string): string {
  if (/\s/.test(label) || !/[-_]/.test(label)) return label;
  const words = label.split(/[-_]+/).filter(Boolean);
  return words.length > 1 ? words.join(' ') : label;
}

const CLAUDE_SLUG = /^claude-(opus|sonnet|haiku|fable)-(\d{1,2})(?:-(\d{1,2}))?$/;

/** `claude-opus-5` → `Opus 5`, `claude-opus-5-5` → `Opus 5.5`; null for any other slug (dated ids, other vendors). */
export function claudeSlugName(id: string): string | null {
  const m = CLAUDE_SLUG.exec(id);
  if (!m) return null;
  const family = m[1]!;
  return `${family[0]!.toUpperCase()}${family.slice(1)} ${m[2]}${m[3] !== undefined ? `.${m[3]}` : ''}`;
}

/**
 * The readable name of a model: the harness's own label (Codex's tidied), else a recognised Claude slug, else the
 * exact id, which is never invented into something else.
 */
export function modelLabel(harness: string, id: string, labels?: ModelLabels): string {
  const provided = providerLabel(id, labels);
  if (provided) return harness === 'codex' ? spaceSeparators(provided) : provided;
  return claudeSlugName(id) ?? id;
}

/** One model as a picker shows it. */
export interface ModelEntry {
  /** The exact launch id: the value of the choice. */
  id: string;
  /** What is shown for it. */
  label: string;
  /** The label is a name, not the id itself: the id is worth showing beside or behind it. */
  named: boolean;
  /** Another model of the list has the same label: the id must be visible to tell them apart. */
  collides: boolean;
  /** What a filter looks at, lower case: the label, the exact id and the provider's own wording. */
  haystack: string;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** `ids` of a harness as picker entries, in order, with colliding labels marked. */
export function modelEntries(harness: string, ids: readonly string[], labels?: ModelLabels): ModelEntry[] {
  const entries = ids.map((id) => {
    const label = modelLabel(harness, id, labels);
    return { id, label, named: label !== id, collides: false, haystack: [squash(label), id.toLowerCase(), squash(providerLabel(id, labels))].join('\n') };
  });
  const count = new Map<string, number>();
  for (const e of entries) count.set(squash(e.label), (count.get(squash(e.label)) ?? 0) + 1);
  for (const e of entries) e.collides = (count.get(squash(e.label)) ?? 0) > 1;
  return entries;
}

/** Whether a filter text matches a model: its whole text, case-insensitive, against the label or the exact id (spaces allowed). */
export function modelMatches(query: string, e: ModelEntry): boolean {
  const q = squash(query);
  return !q || e.haystack.includes(q);
}

/** A model as one line of plain text (a `<select>` option): its label, with the exact id when another model shares it. */
export function modelOptionText(e: ModelEntry): string {
  return e.collides ? `${e.label} (${e.id})` : e.label;
}
