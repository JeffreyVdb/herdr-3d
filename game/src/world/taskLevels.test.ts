import { describe, expect, it } from 'vitest';
import type { HireOptions } from '../net/protocol';
import { effectiveDefault, isComplete, levelChipText, levelOrder, levelProblem, MAX_LEVEL_NAME, nameProblem, preselectLevel, type TaskLevel } from './taskLevels';

// #248, #40: task levels. Fixture slugs and names only; nothing here is an app default.

const CAT: HireOptions = {
  codex: { models: ['x-1', 'x-2'], efforts: ['low', 'high'], extra_efforts: { 'x-2': ['ultra'] } },
  claude: { models: ['y-1'], efforts: ['low', 'medium', 'high'], model_labels: { 'y-1': 'Why One' } },
};
const NOTHING = () => new Set<string>();
const lvl = (id: string, name: string, harness = 'claude', model = 'y-1', effort = 'low'): TaskLevel => ({ id, name, harness, model, effort });

describe('task levels (#248, #40)', () => {
  it('a level is complete once its harness, model and effort are all set', () => {
    expect(isComplete(lvl('a', 'Quick'))).toBe(true);
    expect(isComplete(lvl('a', 'Quick', '', '', ''))).toBe(false);
    expect(isComplete(lvl('a', 'Quick', 'claude', 'y-1', ''))).toBe(false);
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

  it('orders the fallbacks by list position, nearest first, the earlier before the later at each distance', () => {
    const ids = ['p', 'q', 'r', 's', 't'];
    expect(levelOrder(ids, 'r')).toEqual(['r', 'q', 's', 'p', 't']);
    expect(levelOrder(ids, 'p')).toEqual(['p', 'q', 'r', 's', 't']);
    expect(levelOrder(ids, 't')).toEqual(['t', 's', 'r', 'q', 'p']);
    expect(levelOrder(['only'], 'only')).toEqual(['only']);
    // A level that is not in the list (removed meanwhile): the list as it is.
    expect(levelOrder(ids, 'gone')).toEqual(ids);
    expect(levelOrder([], 'gone')).toEqual([]);
  });

  it('preselects the requested level, else the nearest usable one, else nothing', () => {
    const ids = ['p', 'q', 'r'];
    const only = (...ok: string[]) => (id: string) => ok.includes(id);
    expect(preselectLevel(ids, 'q', only('p', 'q', 'r'))).toBe('q');
    expect(preselectLevel(ids, 'q', only('p', 'r'))).toBe('p');
    expect(preselectLevel(ids, 'q', only('r'))).toBe('r');
    expect(preselectLevel(ids, 'r', only('p'))).toBe('p');
    expect(preselectLevel(ids, 'q', only())).toBeNull();
  });

  it('the default is the level marked so, else the first in the list; none without levels', () => {
    const list = [lvl('p', 'One'), lvl('q', 'Two'), lvl('r', 'Three')];
    expect(effectiveDefault(list, 'q')).toBe('q');
    expect(effectiveDefault(list, null)).toBe('p');
    // A mark that names no level any more: the first.
    expect(effectiveDefault(list, 'gone')).toBe('p');
    expect(effectiveDefault([], null)).toBeNull();
  });

  it('a name is trimmed, not empty, at most 40 characters and unique ignoring case', () => {
    expect(nameProblem('Quick fix', ['Docs'])).toBeNull();
    expect(nameProblem('   ', [])).toMatch(/needs a name/);
    expect(nameProblem('x'.repeat(MAX_LEVEL_NAME), [])).toBeNull();
    expect(nameProblem('x'.repeat(MAX_LEVEL_NAME + 1), [])).toMatch(/40 characters/);
    expect(nameProblem(' docs ', ['Docs'])).toMatch(/already/);
  });

  it('a chip names the level, the readable model and the effort', () => {
    expect(levelChipText(lvl('p', 'Quick fix', 'claude', 'y-1', 'medium'), CAT)).toBe('Quick fix — Why One · medium');
    expect(levelChipText(lvl('q', 'Tiny', 'codex', 'x-9', 'low'), CAT)).toMatch(/^Tiny — .+ · low$/);
  });
});
