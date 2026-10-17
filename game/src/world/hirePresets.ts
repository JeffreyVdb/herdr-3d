/**
 * #93 hire presets: the world's `hire_presets` and their `hire_preset.upsert` / `hire_preset.removed` events, and the
 * pure rules of the picker and the editor. A preset is a named first prompt with the exact harness / model / effort to
 * hire it with, on one floor (its floor id: a virtual floor is its own) or global. `known` is false while the bridge
 * never sent a `hire_presets` list (one before #93: the feature is unavailable).
 */

import type { Hire, HireOptions, HirePreset, HirePresetSpec } from '../net/protocol';
import { HARNESS_LABEL } from './hire';
import { labelsOf, modelLabel } from './modelLabel';
import { effortsFor } from './settings';

/** A first prompt's limit (the bridge's `herdr.MaxPrompt`), in UTF-8 bytes. */
export const PRESET_PROMPT_MAX_BYTES = 32 * 1024;
/** A name's limit (the team presets' too), in UTF-8 bytes. */
export const PRESET_NAME_MAX_BYTES = 40;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const bytes = (s: string) => new TextEncoder().encode(s).length;

/** A well-formed preset, else null (anything malformed is left out). */
export function hirePresetOf(v: unknown): HirePreset | null {
  if (!isObj(v) || !isStr(v.id) || !isStr(v.name) || !isStr(v.prompt) || !isStr(v.harness) || !isStr(v.model) || !isStr(v.effort)) return null;
  const out: HirePreset = {
    id: v.id,
    name: v.name,
    prompt: v.prompt,
    harness: v.harness,
    model: v.model,
    effort: v.effort,
    created_at: typeof v.created_at === 'number' ? v.created_at : 0,
    updated_at: typeof v.updated_at === 'number' ? v.updated_at : 0,
  };
  if (isStr(v.floor) && v.floor) out.floor = v.floor;
  return out;
}

const byName = (a: HirePreset, b: HirePreset) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);

export class HirePresetBook {
  private readonly map = new Map<string, HirePreset>();
  /** The bridge sent a `hire_presets` list: it keeps hire presets. */
  known = false;
  /** Bumped on every change (dialogs re-render on it). */
  version = 0;

  /** From a snapshot's `world.hire_presets`: undefined is an older bridge. */
  reset(list: unknown): void {
    this.map.clear();
    this.known = Array.isArray(list);
    if (Array.isArray(list))
      for (const v of list) {
        const p = hirePresetOf(v);
        if (p) this.map.set(p.id, p);
      }
    this.version++;
  }

  upsert(v: unknown): boolean {
    const p = hirePresetOf(v);
    if (!p) return false;
    this.known = true;
    this.map.set(p.id, p);
    this.version++;
    return true;
  }

  remove(id: string): boolean {
    const had = this.map.delete(id);
    if (had) this.version++;
    return had;
  }

  get(id: string | null | undefined): HirePreset | null {
    return (id && this.map.get(id)) || null;
  }

  /** Every preset by name, case-insensitive. */
  list(): HirePreset[] {
    return [...this.map.values()].sort(byName);
  }

  /** What a floor offers: its own presets (by floor id, never its session's or building's) and the global ones. */
  forFloor(floor: string): { floor: HirePreset[]; global: HirePreset[] } {
    const all = this.list();
    return { floor: all.filter((p) => p.floor === floor), global: all.filter((p) => !p.floor) };
  }

  /** Another preset of the scope (`floor` '' is global) is already called `name`, ignoring case; `except` is the one edited. */
  nameTaken(name: string, floor: string, except = ''): boolean {
    const n = name.trim().toLowerCase();
    return [...this.map.values()].some((p) => p.id !== except && (p.floor ?? '') === floor && p.name.toLowerCase() === n);
  }
}

/** Which part of a saved choice cannot be hired exactly now, and why (in the player's words). */
export interface ExactProblem {
  field: 'harness' | 'model' | 'effort';
  why: string;
}

/**
 * Whether a saved harness / model / effort can be hired exactly as it is, against the WHOLE catalog (a model Settings
 * hides is still a valid choice): null when it can. Never a replacement: the caller shows the saved values and why,
 * and the player repairs the choice.
 */
export function exactProblem(catalog: HireOptions, c: Hire): ExactProblem | null {
  const h = catalog[c.harness];
  const harness = HARNESS_LABEL[c.harness] ?? c.harness;
  if (!h) return { field: 'harness', why: `herdr-world no longer offers ${harness || 'this harness'}.` };
  const model = modelLabel(c.harness, c.model, labelsOf(catalog, c.harness));
  if (!h.models.includes(c.model)) return { field: 'model', why: `${harness} no longer offers ${model}.` };
  if (!effortsFor(catalog, c.harness, c.model).includes(c.effort)) return { field: 'effort', why: `${model} does not take effort “${c.effort}”.` };
  return null;
}

/** "Claude Code · Sonnet 5.5 · low": the readable choice (an unknown model by its saved id). */
export function presetChoiceText(catalog: HireOptions, c: Hire): string {
  return `${HARNESS_LABEL[c.harness] ?? c.harness} · ${modelLabel(c.harness, c.model, labelsOf(catalog, c.harness))} · ${c.effort}`;
}

/** The prompt on one line, cut at a word near `max` characters. */
export function promptPreview(prompt: string, max = 140): string {
  const flat = prompt.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max / 2 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

/** The editor's fields. `scope` 'floor' is the floor the editor is for. */
export interface HirePresetDraft {
  name: string;
  prompt: string;
  harness: string;
  model: string;
  effort: string;
  scope: 'floor' | 'global';
}

/** A preset as the editor opens it (its scope as seen from `floor`). */
export function draftFrom(p: HirePreset, floor: string): HirePresetDraft {
  return { name: p.name, prompt: p.prompt, harness: p.harness, model: p.model, effort: p.effort, scope: p.floor && p.floor === floor ? 'floor' : 'global' };
}

/** `hire_preset.create`'s args (and update's, with the id): the floor for "This floor", none for Global. */
export function presetSpec(d: HirePresetDraft, floor: string): HirePresetSpec {
  const s: HirePresetSpec = { name: d.name.trim(), prompt: d.prompt, harness: d.harness, model: d.model, effort: d.effort };
  if (d.scope === 'floor') s.floor = floor;
  return s;
}

/**
 * Why Claude Code cannot be typed this prompt (null: it can, or the harness pastes): control characters other than
 * line ends and tabs would reach its terminal as keys (the bridge's `herdr.NormalizeTyped`).
 */
export function typedProblem(harness: string, prompt: string): string | null {
  if (harness !== 'claude') return null;
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(prompt) ? 'Claude Code is typed its prompt: it can’t hold control characters other than line ends and tabs.' : null;
}

/** Why the editor cannot save (null: it can), with the field to fix. `taken(name)`: another preset of the scope has it. */
export function draftBlocker(d: HirePresetDraft, catalog: HireOptions, taken: (name: string) => boolean): { field: 'name' | 'prompt' | 'choice'; why: string } | null {
  const name = d.name.trim();
  // eslint-disable-next-line no-control-regex
  if (!name || bytes(name) > PRESET_NAME_MAX_BYTES || /[\u0000-\u001f\u007f-\u009f]/.test(name)) return { field: 'name', why: `Name it: 1–${PRESET_NAME_MAX_BYTES} bytes, no control characters.` };
  if (taken(name)) return { field: 'name', why: `Another preset ${d.scope === 'floor' ? 'on this floor' : 'in Global'} is called “${name}”.` };
  if (!d.prompt.trim()) return { field: 'prompt', why: 'Write the prompt the worker starts with.' };
  if (d.prompt.trimStart().startsWith('--')) return { field: 'prompt', why: 'The prompt can’t start with “--” (herdr would read it as a flag).' };
  if (bytes(d.prompt) > PRESET_PROMPT_MAX_BYTES) return { field: 'prompt', why: 'The prompt is at most 32 KiB.' };
  const typed = typedProblem(d.harness, d.prompt);
  if (typed) return { field: 'prompt', why: typed };
  const bad = exactProblem(catalog, d);
  if (bad) return { field: 'choice', why: bad.why };
  return null;
}
