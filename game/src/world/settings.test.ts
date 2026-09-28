import { describe, expect, it } from 'vitest';
import type { FloorSettings } from '../net/protocol';
import { effortsFor, formFrom, parseForm, settingsPatch, type SettingsForm } from './settings';
import { DEFAULT_HIRE_OPTIONS } from './store';

const H = DEFAULT_HIRE_OPTIONS;

const blank = (over: Partial<SettingsForm> = {}): SettingsForm => ({
  repo: '',
  projectOwner: '',
  projectNumber: '',
  statusName: 'Status',
  statusOptions: 'Todo, Doing, QA, Done',
  defaultCwd: '',
  harness: '',
  model: '',
  effort: '',
  ...over,
});

/** Parses a form and diffs it against what is stored, like the save button. */
const save = (stored: FloorSettings, over: Partial<SettingsForm>) => {
  const p = parseForm(blank(over), H);
  expect(p.errors).toEqual({});
  return settingsPatch(stored, p.value);
};

describe('formFrom', () => {
  it('pre-fills the repo from the suggestion and marks it, the status field with the defaults', () => {
    const f = formFrom({}, { repo: 'JeffreyVdb/herdr-3d', default_cwd: '/home/dev/devel/herdr-3d' });
    expect(f.form).toEqual(blank({ repo: 'JeffreyVdb/herdr-3d' }));
    expect(f.repoSuggested).toBe(true);
    expect(f.cwdPlaceholder).toBe('/home/dev/devel/herdr-3d');
  });

  it('shows stored values over suggestions', () => {
    const f = formFrom(
      {
        repo: 'JeffreyVdb/other',
        project: { owner: 'JeffreyVdb', number: 3 },
        status_field: { name: 'State', options: ['Open', 'Closed'] },
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
      statusOptions: 'Open, Closed',
      defaultCwd: '/srv/x',
      harness: 'codex',
      model: 'gpt-6-sol',
      effort: 'ultra',
    });
    expect(f.repoSuggested).toBe(false);
  });
});

describe('parseForm', () => {
  it('accepts an empty form: nothing set', () => {
    expect(parseForm(blank(), H)).toEqual({
      value: { repo: null, project: null, status_field: null, default_cwd: null, default_hire: null },
      errors: {},
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

  it('keeps the status field with the project only, and validates it', () => {
    const withProject = (over: Partial<SettingsForm>) => parseForm(blank({ projectOwner: 'o', projectNumber: '1', ...over }), H);
    expect(withProject({}).value.status_field).toEqual({ name: 'Status', options: ['Todo', 'Doing', 'QA', 'Done'] });
    expect(withProject({ statusOptions: 'Todo,, Done, ' }).value.status_field?.options).toEqual(['Todo', 'Done']);
    expect(withProject({ statusName: ' ' }).errors.statusName).toBeTruthy();
    expect(withProject({ statusName: 'é'.repeat(33) }).errors.statusName).toMatch(/64/); // 66 bytes
    expect(withProject({ statusOptions: ' , ' }).errors.statusOptions).toMatch(/at least one/);
    expect(withProject({ statusOptions: 'Todo, Todo' }).errors.statusOptions).toMatch(/Todo.*twice/);
    expect(withProject({ statusOptions: Array.from({ length: 21 }, (_, i) => `s${i}`).join(',') }).errors.statusOptions).toMatch(/20/);
    expect(withProject({ statusOptions: `ok, ${'x'.repeat(65)}` }).errors.statusOptions).toMatch(/64/);
    // Without a project there is no status field, whatever the inputs say.
    expect(parseForm(blank({ statusName: '' }), H)).toMatchObject({ value: { status_field: null }, errors: {} });
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
    expect(save(stored, { repo: 'o/r', projectOwner: 'o', projectNumber: '1', statusOptions: 'Todo, Done' })).toEqual({});
    expect(save({}, {})).toEqual({});
  });

  it('stores a pre-filled suggestion on save (it was not stored before)', () => {
    const f = formFrom({}, { repo: 'JeffreyVdb/herdr-3d' });
    const p = parseForm(f.form, H);
    expect(settingsPatch({}, p.value)).toEqual({ repo: 'JeffreyVdb/herdr-3d' });
  });

  it('sends only the changed keys, null to clear', () => {
    const stored: FloorSettings = { repo: 'o/r', default_cwd: '/a', default_hire: { harness: 'claude', model: 'claude-opus-5-5', effort: 'high' } };
    expect(save(stored, { repo: 'o/r', defaultCwd: '/b', harness: 'claude', model: 'claude-opus-5-5', effort: 'high' })).toEqual({ default_cwd: '/b' });
    expect(save(stored, { repo: '', defaultCwd: '/a' })).toEqual({ repo: null, default_hire: null });
  });

  it('a new project brings its status field; clearing the project clears it', () => {
    expect(save({}, { projectOwner: 'o', projectNumber: '2' })).toEqual({
      project: { owner: 'o', number: 2 },
      status_field: { name: 'Status', options: ['Todo', 'Doing', 'QA', 'Done'] },
    });
    const stored: FloorSettings = { project: { owner: 'o', number: 2 }, status_field: { name: 'Status', options: ['Todo'] } };
    expect(save(stored, {})).toEqual({ project: null, status_field: null });
  });

  it('compares stored objects whatever their key order', () => {
    const stored = JSON.parse('{"project":{"number":2,"owner":"o"},"status_field":{"options":["A"],"name":"S"}}') as FloorSettings;
    expect(save(stored, { projectOwner: 'o', projectNumber: '2', statusName: 'S', statusOptions: 'A' })).toEqual({});
  });
});

describe('effortsFor', () => {
  it('adds a model’s extra efforts', () => {
    expect(effortsFor(H, 'codex', 'gpt-6-astra')).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(effortsFor(H, 'codex', 'gpt-6-luna')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortsFor(H, 'nope', 'x')).toEqual([]);
  });
});
