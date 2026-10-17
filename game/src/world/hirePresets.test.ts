import { describe, expect, it } from 'vitest';
import type { HireOptions, HirePreset } from '../net/protocol';
import { draftBlocker, draftFrom, exactProblem, HirePresetBook, presetChoiceText, presetSpec, promptPreview, typedProblem } from './hirePresets';

const CATALOG: HireOptions = {
  claude: { models: ['claude-opus-5-5', 'claude-sonnet-5-5'], efforts: ['low', 'medium', 'high'] },
  codex: { models: ['gpt-6-sol', 'gpt-6-luna'], efforts: ['low', 'high'], extra_efforts: { 'gpt-6-sol': ['ultra'] }, model_labels: { 'gpt-6-sol': 'GPT-6-Sol' } },
};

/** A preset; `floor: undefined` makes it global. */
const preset = (over: Omit<Partial<HirePreset>, 'floor'> & { floor?: string | undefined } = {}): HirePreset => {
  const { floor, ...rest } = { floor: 'herdr-3d', ...over };
  const p: HirePreset = { id: 'hp_1', name: 'Deploy', prompt: 'Deploy the release to A, B and C.', harness: 'claude', model: 'claude-sonnet-5-5', effort: 'low', created_at: 1, updated_at: 1, ...rest };
  return floor === undefined ? p : { ...p, floor };
};

describe('HirePresetBook', () => {
  it('is unknown until a snapshot lists hire_presets (an older bridge sends none), then known even when empty', () => {
    const b = new HirePresetBook();
    b.reset(undefined);
    expect(b.known).toBe(false);
    b.reset([]);
    expect(b.known).toBe(true);
    expect(b.list()).toEqual([]);
  });

  it('groups a floor’s own presets and the global ones by name, never another floor’s (a virtual floor is its own)', () => {
    const b = new HirePresetBook();
    b.reset([
      preset({ id: 'a', name: 'zeta' }),
      preset({ id: 'b', name: 'Alpha' }),
      preset({ id: 'c', name: 'Deploy', floor: 'v-0123456789ab' }),
      preset({ id: 'd', name: 'deploy', floor: undefined }),
      { id: 'e', name: 'Broken' },
    ]);
    expect(b.forFloor('herdr-3d')).toEqual({ floor: [b.get('b'), b.get('a')], global: [b.get('d')] });
    expect(b.forFloor('v-0123456789ab').floor.map((p) => p.id)).toEqual(['c']);
    expect(b.forFloor('elsewhere')).toEqual({ floor: [], global: [b.get('d')] });
    expect(b.get('e')).toBeNull();
  });

  it('follows upserts and removals, bumping the version', () => {
    const b = new HirePresetBook();
    b.reset([]);
    const v = b.version;
    expect(b.upsert(preset())).toBe(true);
    expect(b.upsert({ id: 'x' })).toBe(false);
    expect(b.get('hp_1')?.name).toBe('Deploy');
    expect(b.remove('hp_1')).toBe(true);
    expect(b.remove('hp_1')).toBe(false);
    expect(b.version).toBe(v + 2);
  });

  it('takes a name ignoring case within one scope only', () => {
    const b = new HirePresetBook();
    b.reset([preset({ id: 'a' }), preset({ id: 'g', floor: undefined, name: 'Global' })]);
    expect(b.nameTaken(' deploy ', 'herdr-3d')).toBe(true);
    expect(b.nameTaken('deploy', 'herdr-3d', 'a')).toBe(false);
    expect(b.nameTaken('deploy', 'other')).toBe(false);
    expect(b.nameTaken('deploy', '')).toBe(false);
    expect(b.nameTaken('GLOBAL', '')).toBe(true);
    expect(b.nameTaken('global', 'herdr-3d')).toBe(false);
  });

  it('ignores case beyond ASCII, as the bridge does', () => {
    const b = new HirePresetBook();
    b.reset([preset({ id: 'a', name: 'Équipe', floor: 'herdr-3d' })]);
    expect(b.nameTaken('équipe', 'herdr-3d')).toBe(true);
    expect(b.nameTaken('ÉQUIPE', 'herdr-3d')).toBe(true);
    expect(b.nameTaken('équipe', '')).toBe(false);
  });
});

describe('exactProblem', () => {
  it('is null for a tuple of the whole catalog, hidden by Settings or not', () => {
    expect(exactProblem(CATALOG, { harness: 'codex', model: 'gpt-6-sol', effort: 'ultra' })).toBeNull();
  });

  it('names the field and why for a removed harness, a removed model and an effort the model does not take', () => {
    expect(exactProblem(CATALOG, { harness: 'gemini', model: 'g', effort: 'low' })).toMatchObject({ field: 'harness' });
    expect(exactProblem(CATALOG, { harness: 'claude', model: 'claude-haiku-4-5', effort: 'low' })).toMatchObject({ field: 'model' });
    const e = exactProblem(CATALOG, { harness: 'codex', model: 'gpt-6-luna', effort: 'ultra' });
    expect(e).toMatchObject({ field: 'effort' });
    expect(e?.why).toContain('ultra');
    expect(e?.why).toContain('GPT 6 Luna');
  });
});

describe('the editor', () => {
  const draft = draftFrom(preset(), 'herdr-3d');

  it('opens a preset as it is saved, and scope "floor" for its own floor', () => {
    expect(draft).toEqual({ name: 'Deploy', prompt: 'Deploy the release to A, B and C.', harness: 'claude', model: 'claude-sonnet-5-5', effort: 'low', scope: 'floor' });
    expect(draftFrom(preset({ floor: undefined }), 'herdr-3d').scope).toBe('global');
  });

  it('sends the spec with the floor for "This floor" and none for Global', () => {
    expect(presetSpec(draft, 'herdr-3d')).toEqual({ name: 'Deploy', floor: 'herdr-3d', prompt: 'Deploy the release to A, B and C.', harness: 'claude', model: 'claude-sonnet-5-5', effort: 'low' });
    expect(presetSpec({ ...draft, name: ' x ', scope: 'global' }, 'herdr-3d')).not.toHaveProperty('floor');
  });

  it('blocks a bad name, a taken one, a missing or flag-like prompt, an oversize one and a tuple off the catalog', () => {
    const taken = () => false;
    expect(draftBlocker(draft, CATALOG, taken)).toBeNull();
    expect(draftBlocker({ ...draft, name: '  ' }, CATALOG, taken)).toMatchObject({ field: 'name' });
    expect(draftBlocker({ ...draft, name: 'x'.repeat(41) }, CATALOG, taken)).toMatchObject({ field: 'name' });
    expect(draftBlocker({ ...draft, name: 'a\u0007' }, CATALOG, taken)).toMatchObject({ field: 'name' });
    expect(draftBlocker(draft, CATALOG, () => true)).toMatchObject({ field: 'name' });
    expect(draftBlocker({ ...draft, prompt: ' \n ' }, CATALOG, taken)).toMatchObject({ field: 'prompt' });
    expect(draftBlocker({ ...draft, prompt: '--yes' }, CATALOG, taken)).toMatchObject({ field: 'prompt' });
    expect(draftBlocker({ ...draft, prompt: 'é'.repeat(16 * 1024 + 1) }, CATALOG, taken)).toMatchObject({ field: 'prompt' });
    expect(draftBlocker({ ...draft, prompt: 'ring \u0007' }, CATALOG, taken)).toMatchObject({ field: 'prompt' });
    expect(draftBlocker({ ...draft, harness: 'codex', model: 'gpt-6-luna', effort: 'low', prompt: 'ring \u0007' }, CATALOG, taken)).toBeNull();
    expect(draftBlocker({ ...draft, model: 'claude-haiku-4-5' }, CATALOG, taken)).toMatchObject({ field: 'choice' });
  });

  it('types Claude prompts: line ends and tabs only', () => {
    expect(typedProblem('claude', 'a\r\nb\tc')).toBeNull();
    expect(typedProblem('claude', 'a\u001bb')).not.toBeNull();
    expect(typedProblem('codex', 'a\u001bb')).toBeNull();
  });
});

describe('presentation', () => {
  it('shows the readable model and the effort', () => {
    expect(presetChoiceText(CATALOG, preset({ harness: 'codex', model: 'gpt-6-sol', effort: 'ultra' }))).toBe('Codex · GPT 6 Sol · ultra');
    expect(presetChoiceText(CATALOG, preset({ model: 'claude-gone-1' }))).toBe('Claude Code · claude-gone-1 · low');
  });

  it('previews a prompt on one line, cut at a word', () => {
    expect(promptPreview('Deploy\n\n  to A,   B')).toBe('Deploy to A, B');
    const long = promptPreview('word '.repeat(60), 40);
    expect(long.length).toBeLessThanOrEqual(41);
    expect(long.endsWith('…')).toBe(true);
  });
});
