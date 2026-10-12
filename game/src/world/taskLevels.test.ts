import { describe, expect, it } from 'vitest';
import type { HireOptions } from '../net/protocol';
import { levelChipText, levelOrder, levelProblem, preselectLevel, TASK_LEVELS, TASK_LEVEL_LABEL } from './taskLevels';

// #248: task levels. Fixture slugs only; nothing here is an app default.

const CAT: HireOptions = {
  codex: { models: ['x-1', 'x-2'], efforts: ['low', 'high'], extra_efforts: { 'x-2': ['ultra'] } },
  claude: { models: ['y-1'], efforts: ['low', 'medium', 'high'], model_labels: { 'y-1': 'Why One' } },
};
const NOTHING = () => new Set<string>();

describe('task levels (#248)', () => {
  it('are three, small to large, with fixed names', () => {
    expect(TASK_LEVELS).toEqual(['very_trivial', 'trivial', 'slightly_complex']);
    expect(TASK_LEVELS.map((l) => TASK_LEVEL_LABEL[l])).toEqual(['Very trivial', 'Trivial', 'Slightly complex']);
  });

  it('a level is usable when its model is shown, in the catalog, and takes its effort (extra efforts count)', () => {
    expect(levelProblem({ harness: 'codex', model: 'x-1', effort: 'high' }, CAT, NOTHING)).toBeNull();
    expect(levelProblem({ harness: 'codex', model: 'x-2', effort: 'ultra' }, CAT, NOTHING)).toBeNull();
  });

  it('a hidden model makes it unusable, and hidden wins over every other reason', () => {
    const hidden = (h: string) => new Set(h === 'codex' ? ['x-1', 'x-9'] : []);
    expect(levelProblem({ harness: 'codex', model: 'x-1', effort: 'high' }, CAT, hidden)).toMatch(/hidden in Settings → Harness models/);
    // Gone from the catalog and an effort nobody takes: still "hidden".
    expect(levelProblem({ harness: 'codex', model: 'x-9', effort: 'nope' }, CAT, hidden)).toMatch(/hidden/);
  });

  it('a model or harness the bridge does not list makes it unusable', () => {
    expect(levelProblem({ harness: 'codex', model: 'x-9', effort: 'high' }, CAT, NOTHING)).toMatch(/does not offer x-9/);
    expect(levelProblem({ harness: 'gemini', model: 'g-1', effort: 'high' }, CAT, NOTHING)).toMatch(/cannot hire with gemini/);
  });

  it('an effort the model does not take makes it unusable (extra efforts are per model)', () => {
    expect(levelProblem({ harness: 'codex', model: 'x-1', effort: 'ultra' }, CAT, NOTHING)).toMatch(/does not take effort ultra/);
    expect(levelProblem({ harness: 'claude', model: 'y-1', effort: 'max' }, CAT, NOTHING)).toBe('Why One does not take effort max.');
  });

  it('orders the fallbacks nearest first, smaller before larger', () => {
    expect(levelOrder('trivial')).toEqual(['trivial', 'very_trivial', 'slightly_complex']);
    expect(levelOrder('very_trivial')).toEqual(['very_trivial', 'trivial', 'slightly_complex']);
    expect(levelOrder('slightly_complex')).toEqual(['slightly_complex', 'trivial', 'very_trivial']);
  });

  it('preselects the requested level, else the nearest usable one, else nothing', () => {
    const only = (...ok: string[]) => (id: string) => ok.includes(id);
    expect(preselectLevel('trivial', only('trivial', 'very_trivial', 'slightly_complex'))).toBe('trivial');
    expect(preselectLevel('trivial', only('very_trivial', 'slightly_complex'))).toBe('very_trivial');
    expect(preselectLevel('trivial', only('slightly_complex'))).toBe('slightly_complex');
    expect(preselectLevel('slightly_complex', only('very_trivial'))).toBe('very_trivial');
    expect(preselectLevel('trivial', only())).toBeNull();
  });

  it('a chip names the level, the readable model and the effort', () => {
    expect(levelChipText('trivial', { harness: 'claude', model: 'y-1', effort: 'medium' }, CAT)).toBe('Trivial — Why One · medium');
    expect(levelChipText('very_trivial', { harness: 'codex', model: 'x-9', effort: 'low' }, CAT)).toMatch(/^Very trivial — .+ · low$/);
  });
});
