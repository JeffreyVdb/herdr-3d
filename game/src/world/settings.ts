/**
 * Floor settings (M3): the settings panel's form, its validation (the rules of
 * `floor.settings.set`) and the patch it sends: only changed keys, `null` to
 * clear. Pure, so it is covered by vitest.
 */

import type { FloorSettings, FloorSuggested, GithubProject, Hire, HireOptions, SettingsPatch, StatusField } from '../net/protocol';

/** The panel's inputs, as typed. */
export interface SettingsForm {
  repo: string;
  projectOwner: string;
  projectNumber: string;
  statusName: string;
  /** Comma separated. */
  statusOptions: string;
  defaultCwd: string;
  /** '' = no default hire. */
  harness: string;
  model: string;
  effort: string;
}

export type FieldKey = keyof SettingsForm;

/** What the form asks for, key by key (`null` = not set). */
export interface SettingsValue {
  repo: string | null;
  project: GithubProject | null;
  status_field: StatusField | null;
  default_cwd: string | null;
  default_hire: Hire | null;
}

export const DEFAULT_STATUS_FIELD: StatusField = { name: 'Status', options: ['Todo', 'Doing', 'QA', 'Done'] };

const OWNER = /^[A-Za-z0-9-]{1,39}$/;
const REPO = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/;
const MAX_TEXT = 64;
const MAX_OPTIONS = 20;

const bytes = (s: string) => new TextEncoder().encode(s).length;

/** The form for stored settings; the repo falls back to the bridge's suggestion. */
export function formFrom(settings: FloorSettings, suggested: FloorSuggested): { form: SettingsForm; repoSuggested: boolean; cwdPlaceholder: string } {
  const status = settings.status_field ?? DEFAULT_STATUS_FIELD;
  const hire = settings.default_hire;
  return {
    form: {
      repo: settings.repo ?? suggested.repo ?? '',
      projectOwner: settings.project?.owner ?? '',
      projectNumber: settings.project ? String(settings.project.number) : '',
      statusName: status.name,
      statusOptions: status.options.join(', '),
      defaultCwd: settings.default_cwd ?? '',
      harness: hire?.harness ?? '',
      model: hire?.model ?? '',
      effort: hire?.effort ?? '',
    },
    repoSuggested: !settings.repo && !!suggested.repo,
    cwdPlaceholder: suggested.default_cwd ?? '',
  };
}

/** `owner/repo`, also from a pasted GitHub https or ssh URL; null when it is none of those. */
export function normalizeRepo(input: string): string | null {
  let s = input.trim();
  const url = /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)(.+?)(?:\.git)?\/?$/.exec(s);
  if (url?.[1]) s = url[1];
  return REPO.test(s) ? s : null;
}

/** Efforts a model takes: its harness's, plus the model's extra ones. */
export function effortsFor(o: HireOptions, harness: string, model: string): string[] {
  const h = o[harness];
  if (!h) return [];
  return [...h.efforts, ...(h.extra_efforts?.[model] ?? []).filter((e) => !h.efforts.includes(e))];
}

/** Validates the form like the bridge does; `errors` is keyed by input. */
export function parseForm(f: SettingsForm, hire: HireOptions): { value: SettingsValue; errors: Partial<Record<FieldKey, string>> } {
  const errors: Partial<Record<FieldKey, string>> = {};
  const value: SettingsValue = { repo: null, project: null, status_field: null, default_cwd: null, default_hire: null };

  if (f.repo.trim()) {
    const r = normalizeRepo(f.repo);
    if (r) value.repo = r;
    else errors.repo = 'Use owner/repo, e.g. JeffreyVdb/herdr-3d.';
  }

  const owner = f.projectOwner.trim();
  const num = f.projectNumber.trim();
  if (owner || num) {
    if (!owner) errors.projectOwner = 'Add the owner of the project (a user or an organization).';
    else if (!OWNER.test(owner)) errors.projectOwner = 'A GitHub owner is 1–39 letters, digits or dashes.';
    const n = Number(num);
    if (!num) errors.projectNumber = 'Add the project number (from its URL: …/projects/3).';
    else if (!/^\d+$/.test(num) || !Number.isSafeInteger(n) || n < 1) errors.projectNumber = 'The project number is a whole number from 1.';
    if (!errors.projectOwner && !errors.projectNumber) value.project = { owner, number: n };
  }

  // The status field belongs to the project: none without one.
  if (owner || num) {
    const name = f.statusName.trim();
    if (!name) errors.statusName = 'Name the status field, e.g. Status.';
    else if (bytes(name) > MAX_TEXT) errors.statusName = `Keep the field name within ${MAX_TEXT} bytes.`;
    const options = f.statusOptions
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    const seen = new Set<string>();
    const twice = options.find((o) => (seen.has(o) ? true : (seen.add(o), false)));
    if (!options.length) errors.statusOptions = 'List at least one status, separated by commas.';
    else if (options.length > MAX_OPTIONS) errors.statusOptions = `Use at most ${MAX_OPTIONS} statuses.`;
    else if (options.some((o) => bytes(o) > MAX_TEXT)) errors.statusOptions = `Keep each status within ${MAX_TEXT} bytes.`;
    else if (twice !== undefined) errors.statusOptions = `“${twice}” is listed twice.`;
    if (value.project && !errors.statusName && !errors.statusOptions) value.status_field = { name, options };
  }

  const cwd = f.defaultCwd.trim();
  if (cwd) {
    if (!cwd.startsWith('/')) errors.defaultCwd = 'Use an absolute path on the server, e.g. /home/dev/devel/herdr-3d.';
    else value.default_cwd = cwd;
  }

  if (f.harness) {
    const h = hire[f.harness];
    if (!h) errors.harness = `${f.harness} is not a harness this bridge can hire.`;
    else {
      if (!h.models.includes(f.model)) errors.model = f.model ? `${f.harness} has no model ${f.model}.` : 'Choose a model.';
      const efforts = effortsFor(hire, f.harness, f.model);
      if (!errors.model && !efforts.includes(f.effort)) errors.effort = f.effort ? `${f.model} does not take effort ${f.effort}.` : 'Choose an effort.';
      else if (errors.model && !f.effort) errors.effort = 'Choose an effort.';
      if (!errors.model && !errors.effort) value.default_hire = { harness: f.harness, model: f.model, effort: f.effort };
    }
  }
  return { value, errors };
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  return ka.length === kb.length && ka.every((k) => same(ra[k], rb[k]));
}

const KEYS = ['repo', 'project', 'status_field', 'default_cwd', 'default_hire'] as const;

/** `floor.settings.set` args (minus `session`): the keys that differ from what is stored. */
export function settingsPatch(stored: FloorSettings, want: SettingsValue): SettingsPatch {
  const patch: Record<string, unknown> = {};
  for (const k of KEYS) {
    if (!same(stored[k] ?? null, want[k])) patch[k] = want[k];
  }
  return patch as SettingsPatch;
}
