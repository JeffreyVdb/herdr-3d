import { describe, expect, it } from 'vitest';
import type { HireOptions, HirePreset } from '../net/protocol';
import { draftBlocker, draftFrom, exactProblem, HirePresetBook, hirePresetOf, instructionsBlocker, nudgeWanted, presetChoiceText, presetSpec, promptPreview, typedProblem } from './hirePresets';

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

  it('#95: reads each preset’s flag, and whether the bridge takes it (the snapshot’s herdr_instructions)', () => {
    const b = new HirePresetBook();
    b.reset([preset({ id: 'a', herdr_instructions: true }), preset({ id: 'b' }), { ...preset({ id: 'c' }), herdr_instructions: 'yes' }]);
    expect(b.instructions).toBe(false);
    expect([b.get('a')?.herdr_instructions, b.get('b')?.herdr_instructions, b.get('c')?.herdr_instructions]).toEqual([true, undefined, undefined]);
    b.reset([], true);
    expect(b.instructions).toBe(true);
    b.reset([]);
    expect(b.instructions).toBe(false);
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
    expect(draft).toEqual({ name: 'Deploy', prompt: 'Deploy the release to A, B and C.', harness: 'claude', model: 'claude-sonnet-5-5', effort: 'low', scope: 'floor', instructions: false, profile: '' });
    expect(draftFrom(preset({ herdr_instructions: true }), 'herdr-3d').instructions).toBe(true);
    expect(draftFrom(preset({ floor: undefined }), 'herdr-3d').scope).toBe('global');
  });

  it('sends the spec with the floor for "This floor" and none for Global', () => {
    expect(presetSpec(draft, 'herdr-3d')).toEqual({ name: 'Deploy', floor: 'herdr-3d', prompt: 'Deploy the release to A, B and C.', harness: 'claude', model: 'claude-sonnet-5-5', effort: 'low' });
    expect(presetSpec({ ...draft, name: ' x ', scope: 'global' }, 'herdr-3d')).not.toHaveProperty('floor');
  });

  it('#139: keeps a Codex preset’s profile, and sends it for a Codex preset only', () => {
    const codex = draftFrom(preset({ harness: 'codex', model: 'gpt-6-sol', codex_profile: 'work' }), 'herdr-3d');
    expect(codex.profile).toBe('work');
    expect(presetSpec(codex, 'herdr-3d')).toMatchObject({ codex_profile: 'work' });
    expect(presetSpec({ ...codex, profile: '' }, 'herdr-3d')).not.toHaveProperty('codex_profile');
    expect(presetSpec({ ...codex, harness: 'claude' }, 'herdr-3d')).not.toHaveProperty('codex_profile');
    expect(hirePresetOf({ ...preset(), codex_profile: 'work' })?.codex_profile).toBe('work');
    expect(hirePresetOf({ ...preset(), codex_profile: 7 })).not.toHaveProperty('codex_profile');
  });

  it('#95: sends herdr_instructions, on or off, only to a bridge that takes it', () => {
    expect(presetSpec({ ...draft, instructions: true }, 'herdr-3d', true)).toMatchObject({ herdr_instructions: true });
    expect(presetSpec(draft, 'herdr-3d', true)).toMatchObject({ herdr_instructions: false });
    expect(presetSpec({ ...draft, instructions: true }, 'herdr-3d', false)).not.toHaveProperty('herdr_instructions');
    expect(presetSpec({ ...draft, instructions: true }, 'herdr-3d')).not.toHaveProperty('herdr_instructions');
  });

  it('#95: asks the classifier only with the box off, no h3d_floor of its own, the check there, and not for a text already answered', () => {
    const ok = { supported: true, ready: true, dismissed: null };
    const d = { ...draft, prompt: 'For each pull request, spawn a subagent.' };
    expect(nudgeWanted(d, ok)).toBe(true);
    expect(nudgeWanted({ ...d, instructions: true }, ok)).toBe(false);
    expect(nudgeWanted({ ...d, prompt: `${d.prompt} Tag them h3d_floor=v-1.` }, ok)).toBe(false);
    expect(nudgeWanted(d, { ...ok, supported: false })).toBe(false);
    expect(nudgeWanted(d, { ...ok, ready: false })).toBe(false);
    expect(nudgeWanted(d, { ...ok, dismissed: d.prompt })).toBe(false);
    expect(nudgeWanted(d, { ...ok, dismissed: 'For each pull request, spawn a subagent' })).toBe(true);
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

describe('#95 the hiring instructions in a hire', () => {
  const lines = 'Start every agent you hire in its own herdr workspace or tab.\n\nAlso tag every herdr workspace you create with the token h3d_floor=v-1.';
  it('counts the task, the blank line and the lines against 32 KiB', () => {
    const room = 32 * 1024 - 2 - new TextEncoder().encode(lines).length;
    expect(instructionsBlocker('x'.repeat(room), lines)).toBeNull();
    const over = instructionsBlocker('x'.repeat(room + 1), lines);
    expect(over).toContain('32 KiB');
    expect(over).toContain('untick');
  });

  it('needs a task to add them to', () => {
    expect(instructionsBlocker(' \n', lines)).toContain('first task');
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
