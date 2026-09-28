import { describe, expect, it } from 'vitest';
import type { FloorSettings } from '../net/protocol';
import { DEFAULT_STATUS_FIELD, effortsFor, formFrom, parseForm, settingsPatch, type SettingsForm } from './settings';
import { DEFAULT_HIRE_OPTIONS } from './store';

const H = DEFAULT_HIRE_OPTIONS;

const blank = (over: Partial<SettingsForm> = {}): SettingsForm => ({
  repo: '',
  projectOwner: '',
  projectNumber: '',
  statusName: 'Status',
  statusOptions: ['Todo', 'Doing', 'QA', 'Done'],
  defaultCwd: '',
  harness: '',
  model: '',
  effort: '',
  ...over,
});

/** Parses a form and diffs it against what is stored, like the save button. */
const save = (stored: FloorSettings, over: Partial<SettingsForm>) => {
  const p = parseForm(blank(over), H, stored);
  expect(p.errors).toEqual({});
  return settingsPatch(stored, p.value);
};

/** Opens the form on what is stored, changes `edit`, saves: the patch. */
const edit = (stored: FloorSettings, change: (f: SettingsForm) => void) => {
  const f = formFrom(stored, {}).form;
  change(f);
  const p = parseForm(f, H, stored);
  expect(p.errors).toEqual({});
  return settingsPatch(stored, p.value);
};

describe('formFrom', () => {
  it('pre-fills the repo from the suggestion and marks it, the status field with the defaults', () => {
    const f = formFrom({}, { repo: 'JeffreyVdb/herdr-3d', default_cwd: '/home/dev/devel/herdr-3d' });
    expect(f.form).toEqual(blank({ repo: 'JeffreyVdb/herdr-3d' }));
    expect(f.repoSuggested).toBe(true);
    expect(f.statusDefault).toBe(true);
    expect(f.cwdPlaceholder).toBe('/home/dev/devel/herdr-3d');
  });

  it('shows stored values over suggestions and defaults, one status per row', () => {
    const f = formFrom(
      {
        repo: 'JeffreyVdb/other',
        project: { owner: 'JeffreyVdb', number: 3 },
        status_field: { name: 'State', options: ['Open', 'Review, QA', 'Closed'] },
        default_cwd: '/srv/x',
        default_hire: { harness: 'codex', model: 'gpt-6-sol', effort: 'ultra' },
      },
      { repo: 'JeffreyVdb/herdr-3d' },
    );
    expect(f.form).toEqual({
      repo: 'JeffreyVdb/other',
      projectOwner: 'JeffreyVdb',
      projectNumber: '3',
      statusName: 'State',
      statusOptions: ['Open', 'Review, QA', 'Closed'],
      defaultCwd: '/srv/x',
      harness: 'codex',
      model: 'gpt-6-sol',
      effort: 'ultra',
    });
    expect(f.repoSuggested).toBe(false);
    expect(f.statusDefault).toBe(false);
  });

  it('a stored status field without a project is shown as stored', () => {
    const f = formFrom({ status_field: { name: 'Workflow', options: ['Todo', 'Done'] } }, {});
    expect(f.form).toMatchObject({ projectOwner: '', projectNumber: '', statusName: 'Workflow', statusOptions: ['Todo', 'Done'] });
    expect(f.statusDefault).toBe(false);
  });
});

describe('parseForm', () => {
  it('accepts an empty form: nothing set', () => {
    expect(parseForm(blank({ statusName: '', statusOptions: [] }), H)).toEqual({
      value: { repo: null, project: null, status_field: null, default_cwd: null, default_hire: null },
      errors: {},
      badOption: null,
    });
  });

  it.each([
    ['JeffreyVdb/herdr-3d', 'JeffreyVdb/herdr-3d'],
    ['  a-b/c.d_e  ', 'a-b/c.d_e'],
    ['https://github.com/JeffreyVdb/herdr-3d.git', 'JeffreyVdb/herdr-3d'],
    ['git@github.com:JeffreyVdb/herdr-3d.git', 'JeffreyVdb/herdr-3d'],
    ['https://github.com/JeffreyVdb/herdr-3d/', 'JeffreyVdb/herdr-3d'],
  ])('repo %j → %j', (input, want) => {
    expect(parseForm(blank({ repo: input }), H).value.repo).toBe(want);
  });

  it.each(['herdr-3d', 'a/b/c', 'own er/repo', `${'o'.repeat(40)}/r`, `o/${'r'.repeat(101)}`, 'o_x/r', 'o/r?'])('rejects repo %j', (repo) => {
    expect(parseForm(blank({ repo }), H).errors.repo).toMatch(/owner\/repo/);
  });

  it('needs both project owner and number, a number ≥ 1', () => {
    expect(parseForm(blank({ projectOwner: 'JeffreyVdb' }), H).errors).toEqual({ projectNumber: expect.stringMatching(/number/) });
    expect(parseForm(blank({ projectNumber: '3' }), H).errors).toEqual({ projectOwner: expect.stringMatching(/owner/) });
    for (const n of ['0', '-1', '1.5', 'x', '99999999999999999999']) expect(parseForm(blank({ projectOwner: 'o', projectNumber: n }), H).errors.projectNumber, n).toBeTruthy();
    expect(parseForm(blank({ projectOwner: 'bad owner', projectNumber: '1' }), H).errors.projectOwner).toBeTruthy();
    expect(parseForm(blank({ projectOwner: ' JeffreyVdb ', projectNumber: ' 3 ' }), H).value.project).toEqual({ owner: 'JeffreyVdb', number: 3 });
  });

  it('reads the status field with or without a project, one status per row, commas and all', () => {
    expect(parseForm(blank(), H).value.status_field).toEqual({ name: 'Status', options: ['Todo', 'Doing', 'QA', 'Done'] });
    expect(parseForm(blank({ statusOptions: ['Review, QA', 'Done'] }), H).value.status_field).toEqual({ name: 'Status', options: ['Review, QA', 'Done'] });
    // Blank rows (a status added and left empty) do not count; new labels are trimmed.
    expect(parseForm(blank({ statusName: ' Stage ', statusOptions: ['', ' Todo ', '  ', 'Done'] }), H).value.status_field).toEqual({ name: 'Stage', options: ['Todo', 'Done'] });
    expect(parseForm(blank({ projectOwner: 'o', projectNumber: '1', statusOptions: ['A'] }), H).value.status_field).toEqual({ name: 'Status', options: ['A'] });
  });

  it('validates the status field like the bridge, pointing at the row to fix', () => {
    expect(parseForm(blank({ statusName: ' ' }), H)).toMatchObject({ errors: { statusName: expect.stringMatching(/Name/) }, value: { status_field: null } });
    expect(parseForm(blank({ statusName: 'é'.repeat(33) }), H).errors.statusName).toMatch(/64/); // 66 bytes
    expect(parseForm(blank({ statusOptions: ['', ' '] }), H)).toMatchObject({ errors: { statusOptions: expect.stringMatching(/at least one/) }, badOption: null });
    expect(parseForm(blank({ statusOptions: ['Todo', '', 'Todo'] }), H)).toMatchObject({ errors: { statusOptions: expect.stringMatching(/Todo.*twice/) }, badOption: 2 });
    expect(parseForm(blank({ statusOptions: ['Todo', ' Todo '] }), H)).toMatchObject({ errors: { statusOptions: expect.stringMatching(/twice/) }, badOption: 1 });
    const many = Array.from({ length: 21 }, (_, i) => `s${i}`);
    expect(parseForm(blank({ statusOptions: many }), H)).toMatchObject({ errors: { statusOptions: expect.stringMatching(/20/) }, badOption: 20 });
    expect(parseForm(blank({ statusOptions: ['ok', 'x'.repeat(65)] }), H)).toMatchObject({ errors: { statusOptions: expect.stringMatching(/64/) }, badOption: 1 });
    // An empty name and no statuses: no status field, not an error.
    expect(parseForm(blank({ statusName: '', statusOptions: ['', ''] }), H)).toMatchObject({ value: { status_field: null }, errors: {} });
  });

  it('keeps stored labels exactly while their rows show them unchanged', () => {
    // Valid on the bridge (it only rejects blank labels): spaces around a label, twins
    // that differ by a space, a line break (a text input shows it without the break).
    const stored: FloorSettings = { status_field: { name: ' Stage ', options: [' Done', 'Done', 'a\nb', '🚀 Ship it, now'] } };
    const shown = [' Done', 'Done', 'ab', '🚀 Ship it, now'];
    const p = parseForm(blank({ statusName: ' Stage ', statusOptions: shown }), H, stored);
    expect(p.errors).toEqual({});
    expect(p.value.status_field).toEqual(stored.status_field);
    // Moved rows keep their labels too; an edited row is read as typed (trimmed).
    const moved = parseForm(blank({ statusName: 'Stage', statusOptions: ['ab', 'Done', ' Done', ' Launch '] }), H, stored);
    expect(moved.value.status_field).toEqual({ name: ' Stage ', options: ['a\nb', ' Done', 'Done', 'Launch'] });
  });

  it('wants an absolute default cwd', () => {
    expect(parseForm(blank({ defaultCwd: 'devel/x' }), H).errors.defaultCwd).toMatch(/absolute/);
    expect(parseForm(blank({ defaultCwd: ' /srv/x ' }), H).value.default_cwd).toBe('/srv/x');
  });

  it('validates the default hire against the hire options, harness → model → effort', () => {
    expect(parseForm(blank({ harness: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' }), H).value.default_hire).toEqual({
      harness: 'claude',
      model: 'claude-opus-5-5',
      effort: 'xhigh',
    });
    expect(parseForm(blank({ harness: 'claude' }), H).errors).toEqual({ model: expect.any(String), effort: expect.any(String) });
    expect(parseForm(blank({ harness: 'claude', model: 'gpt-6-sol', effort: 'low' }), H).errors.model).toBeTruthy();
    expect(parseForm(blank({ harness: 'claude', model: 'claude-opus-5-5', effort: 'ultra' }), H).errors.effort).toBeTruthy();
    expect(parseForm(blank({ harness: 'codex', model: 'gpt-6-sol', effort: 'ultra' }), H).errors).toEqual({});
    expect(parseForm(blank({ harness: 'codex', model: 'gpt-6-luna', effort: 'ultra' }), H).errors.effort).toBeTruthy();
    expect(parseForm(blank({ harness: 'gemini', model: 'x', effort: 'low' }), H).errors.harness).toBeTruthy();
  });
});

describe('settingsPatch', () => {
  it('sends nothing when nothing changed', () => {
    const stored: FloorSettings = { repo: 'o/r', project: { owner: 'o', number: 1 }, status_field: { name: 'Status', options: ['Todo', 'Done'] } };
    expect(save(stored, { repo: 'o/r', projectOwner: 'o', projectNumber: '1', statusOptions: ['Todo', 'Done'] })).toEqual({});
    expect(edit(stored, () => {})).toEqual({});
    expect(save({}, {})).toEqual({});
    expect(edit({}, () => {})).toEqual({});
  });

  it('stores a pre-filled suggestion on save (it was not stored before)', () => {
    const f = formFrom({}, { repo: 'JeffreyVdb/herdr-3d' });
    const p = parseForm(f.form, H, {});
    expect(settingsPatch({}, p.value)).toEqual({ repo: 'JeffreyVdb/herdr-3d' });
  });

  it('sends only the changed keys, null to clear', () => {
    const stored: FloorSettings = { repo: 'o/r', default_cwd: '/a', default_hire: { harness: 'claude', model: 'claude-opus-5-5', effort: 'high' } };
    expect(save(stored, { repo: 'o/r', defaultCwd: '/b', harness: 'claude', model: 'claude-opus-5-5', effort: 'high' })).toEqual({ default_cwd: '/b' });
    expect(save(stored, { repo: '', defaultCwd: '/a' })).toEqual({ repo: null, default_hire: null });
  });

  it('never rewrites untouched statuses, whatever they contain (a comma, a space, twenty of them)', () => {
    // The review's case: a status with a comma, and only the repo changes.
    const stored: FloorSettings = { project: { owner: 'o', number: 1 }, status_field: { name: 'Status', options: ['Review, QA', 'Done'] } };
    expect(edit(stored, (f) => (f.repo = 'o/r'))).toEqual({ repo: 'o/r' });
    const full: FloorSettings = {
      status_field: { name: 'n'.repeat(64), options: Array.from({ length: 20 }, (_, i) => (i === 0 ? '🚀'.repeat(16) : `${i}, ${'x'.repeat(60)}`)) },
    };
    expect(edit(full, (f) => (f.defaultCwd = '/srv'))).toEqual({ default_cwd: '/srv' });
    const odd: FloorSettings = { status_field: { name: ' Stage ', options: [' Done', 'Done', 'a\nb'] } };
    // What the inputs show: a text input drops the line break.
    expect(edit(odd, (f) => (f.statusOptions = f.statusOptions.map((o) => o.replace(/[\r\n]/g, ''))))).toEqual({});
  });

  it('keeps a stored status field when there is no project; only emptying it clears it', () => {
    // The review's case: stored without a project, the form saved unchanged / with a repo.
    const stored: FloorSettings = { status_field: { name: 'Workflow', options: ['Todo', 'Done'] } };
    expect(edit(stored, () => {})).toEqual({});
    expect(edit(stored, (f) => (f.repo = 'o/r'))).toEqual({ repo: 'o/r' });
    // Clearing the project leaves the status field alone.
    const both: FloorSettings = { project: { owner: 'o', number: 2 }, status_field: { name: 'Status', options: ['Todo'] } };
    expect(edit(both, (f) => ((f.projectOwner = ''), (f.projectNumber = '')))).toEqual({ project: null });
    // Emptying the name and every status is the explicit clear.
    expect(edit(stored, (f) => ((f.statusName = ''), (f.statusOptions = [])))).toEqual({ status_field: null });
    expect(edit({}, (f) => ((f.statusName = ''), (f.statusOptions = [])))).toEqual({});
  });

  it('the pre-filled default status field is not stored until it is changed', () => {
    expect(save({}, { projectOwner: 'o', projectNumber: '2' })).toEqual({ project: { owner: 'o', number: 2 } });
    expect(edit({}, (f) => f.statusOptions.push('Blocked'))).toEqual({ status_field: { name: 'Status', options: ['Todo', 'Doing', 'QA', 'Done', 'Blocked'] } });
    expect(edit({}, (f) => (f.statusName = 'Stage'))).toEqual({ status_field: { name: 'Stage', options: DEFAULT_STATUS_FIELD.options } });
    // A stored field set back to the defaults is stored as such.
    const stored: FloorSettings = { status_field: { name: 'Status', options: ['Todo'] } };
    expect(edit(stored, (f) => (f.statusOptions = [...DEFAULT_STATUS_FIELD.options]))).toEqual({ status_field: DEFAULT_STATUS_FIELD });
  });

  it('a reordered status list is a change', () => {
    const stored: FloorSettings = { status_field: { name: 'Status', options: ['Todo', 'Done'] } };
    expect(edit(stored, (f) => f.statusOptions.reverse())).toEqual({ status_field: { name: 'Status', options: ['Done', 'Todo'] } });
  });

  it('compares stored objects whatever their key order', () => {
    const stored = JSON.parse('{"project":{"number":2,"owner":"o"},"status_field":{"options":["A"],"name":"S"}}') as FloorSettings;
    expect(save(stored, { projectOwner: 'o', projectNumber: '2', statusName: 'S', statusOptions: ['A'] })).toEqual({});
  });
});

describe('effortsFor', () => {
  it('adds a model’s extra efforts', () => {
    expect(effortsFor(H, 'codex', 'gpt-6-astra')).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(effortsFor(H, 'codex', 'gpt-6-luna')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortsFor(H, 'nope', 'x')).toEqual([]);
  });
});
