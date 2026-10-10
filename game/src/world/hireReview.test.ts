import { describe, expect, it } from 'vitest';
import type { HireInterpretation, HireOptions } from '../net/protocol';
import {
  applyInterpretation,
  editTask,
  effortChoices,
  effortOk,
  fromHandoff,
  fromInterpretation,
  modelOk,
  needsAttention,
  pickEffort,
  pickHarness,
  pickModel,
  revalidate,
  taskPreview,
} from './hireReview';
import { CAT, FULL, NO_EFFORT, field } from './hireReviewFixtures';

// #212: the review's choices. Fixture ids only; the point is that nothing is ever picked for the human.

describe('fromInterpretation', () => {
  it('takes valid fields with their provenance and nothing else', () => {
    const c = fromInterpretation(FULL, CAT);
    expect(c).toMatchObject({ harness: 'claude', model: 'claude-haiku-5-5', effort: 'high', task: 'fix the login bug.' });
    expect(c.origin).toEqual({ harness: 'dictated', model: 'resolved', effort: 'dictated', task: 'dictated' });
    expect(needsAttention(c, CAT).size).toBe(0);
  });

  it('leaves a missing effort empty: no `high`, no first level', () => {
    const c = fromInterpretation(NO_EFFORT, CAT);
    expect(c.effort).toBe('');
    expect(c.origin.effort).toBe('missing');
    expect([...needsAttention(c, CAT)]).toEqual(['effort']);
  });

  it('leaves an invalid model empty (no first model) and keeps the words said', () => {
    const c = fromInterpretation({ ...FULL, model: field('invalid', undefined, 'GPT-5.5 Haiku'), effort: field('missing') }, CAT);
    expect(c.model).toBe('');
    expect(c.origin.model).toBe('invalid');
    expect(c.said.model).toBe('GPT-5.5 Haiku');
    expect(needsAttention(c, CAT).has('agent')).toBe(true);
  });

  it('refuses a value the catalog does not have, even from the proposal', () => {
    const c = fromInterpretation({ ...FULL, model: field('resolved', 'claude-gone-1') }, CAT);
    expect(c.model).toBe('');
    expect(c.origin.model).toBe('invalid');
    // the effort said with it is held, and checked once a model is valid
    expect(c.effort).toBe('high');
  });

  it('marks a dictated effort the model does not support invalid and cleared', () => {
    const c = fromInterpretation({ ...FULL, effort: field('dictated', 'max') }, CAT);
    expect(c.effort).toBe('');
    expect(c.origin.effort).toBe('invalid');
    expect(c.said.effort).toBe('max');
  });

  it('an effort supported only by a model with extras counts for that model', () => {
    const c = fromInterpretation({ ...FULL, model: field('dictated', 'claude-opus-5-5'), effort: field('dictated', 'xhigh') }, CAT);
    expect(c.effort).toBe('xhigh');
    expect(effortOk(c, CAT)).toBe(true);
  });
});

describe('changing the model, the harness and the effort', () => {
  const opus = () => fromInterpretation({ ...FULL, model: field('dictated', 'claude-opus-5-5'), effort: field('dictated', 'xhigh') }, CAT);

  it('keeps an effort the new model supports', () => {
    const c = pickModel(opus(), 'claude-sonnet-5-5', CAT);
    // sonnet has no `xhigh`: cleared, not replaced
    expect(c.effort).toBe('');
    const high = pickModel({ ...opus(), effort: 'high' }, 'claude-sonnet-5-5', CAT);
    expect(high.effort).toBe('high');
    expect(high.origin.effort).toBe('dictated');
  });

  it('clears an effort the new model does not support, and keeps its word to say why', () => {
    const c = pickModel(opus(), 'claude-haiku-5-5', CAT);
    expect(c.model).toBe('claude-haiku-5-5');
    expect(c.effort).toBe('');
    expect(c.origin.effort).toBe('invalid');
    expect(c.said.effort).toBe('xhigh');
    expect(needsAttention(c, CAT).has('effort')).toBe(true);
    expect(effortChoices(CAT, c.harness, c.model)).toEqual(['low', 'medium', 'high']);
  });

  it('never changes the task', () => {
    let c = editTask(opus(), 'fix the login bug.\nthen the logout one');
    c = pickModel(c, 'claude-haiku-5-5', CAT);
    c = pickHarness(c, 'codex', CAT);
    c = pickModel(c, 'gpt-6-sol', CAT);
    expect(c.task).toBe('fix the login bug.\nthen the logout one');
  });

  it('a harness change empties the model (it is another harness’s) and never picks one', () => {
    const c = pickHarness(fromInterpretation(FULL, CAT), 'codex', CAT);
    expect(c.harness).toBe('codex');
    expect(c.model).toBe('');
    expect(c.origin.model).toBe('missing');
    expect(modelOk(c, CAT)).toBe(false);
    // `high` is a level codex takes too: held until its model is chosen, then checked
    expect(c.effort).toBe('high');
    expect(pickModel(c, 'gpt-6-sol', CAT).effort).toBe('high');
  });

  it('ignores a model or harness the catalog does not have', () => {
    const c = fromInterpretation(FULL, CAT);
    expect(pickModel(c, 'nope', CAT)).toBe(c);
    expect(pickHarness(c, 'nope', CAT)).toBe(c);
  });

  it('takes an effort only from the model’s levels', () => {
    const c = fromInterpretation(NO_EFFORT, CAT);
    expect(pickEffort(c, 'xhigh', CAT)).toBeNull();
    const next = pickEffort(c, 'low', CAT, 'dictated');
    expect(next).toMatchObject({ effort: 'low', origin: { effort: 'dictated' } });
  });
});

describe('a later interpretation', () => {
  it('changes only what the human has not edited since it was asked for', () => {
    const asked = fromInterpretation(NO_EFFORT, CAT);
    // the human picks an effort and edits the task while the reply is on its way
    let c = pickEffort(asked, 'low', CAT)!;
    c = editTask(c, 'my own wording');
    const reply: HireInterpretation = { ...FULL, effort: field('dictated', 'high'), task: { provenance: 'dictated', value: 'dictated again' } };
    const merged = applyInterpretation(c, reply, CAT, asked.rev);
    expect(merged.effort).toBe('low');
    expect(merged.task).toBe('my own wording');
    // the agent was not edited: the reply may set it
    const other = applyInterpretation(c, { ...reply, model: field('resolved', 'claude-sonnet-5-5') }, CAT, asked.rev);
    expect(other.model).toBe('claude-sonnet-5-5');
    expect(other.effort).toBe('low');
  });

  it('keeps the harness and the model together when either was edited', () => {
    const asked = fromInterpretation(FULL, CAT);
    const c = pickModel(asked, 'claude-sonnet-5-5', CAT);
    const merged = applyInterpretation(c, { ...FULL, harness: field('dictated', 'codex'), model: field('dictated', 'gpt-6-sol') }, CAT, asked.rev);
    expect(merged.harness).toBe('claude');
    expect(merged.model).toBe('claude-sonnet-5-5');
  });

  it('fills a missing effort from a follow-up that was asked for after the last edit', () => {
    const c = fromInterpretation(NO_EFFORT, CAT);
    const merged = applyInterpretation(c, FULL, CAT, c.rev);
    expect(merged.effort).toBe('high');
    expect(merged.origin.effort).toBe('dictated');
  });
});

describe('revalidate', () => {
  it('clears a model that left the catalog and keeps the rest', () => {
    const c = fromInterpretation(FULL, CAT);
    const gone: HireOptions = { ...CAT, claude: { ...CAT.claude!, models: ['claude-opus-5-5'] } };
    const next = revalidate(c, gone);
    expect(next.model).toBe('');
    expect(next.origin.model).toBe('invalid');
    expect(next.task).toBe(c.task);
    expect(revalidate(c, CAT)).toBe(c);
  });
});

describe('taskPreview', () => {
  it('is one short line', () => {
    expect(taskPreview('fix\n  the   bug')).toBe('fix the bug');
    expect(taskPreview('x'.repeat(200), 20)).toHaveLength(20);
    expect(taskPreview('x'.repeat(200), 20).endsWith('…')).toBe(true);
  });
});

describe('fromHandoff (#223)', () => {
  const task = 'Read /h/f/a.md and continue the work. Invoke the skills it suggests.';
  it('takes the handoff’s harness and model when the catalog has them; never an effort', () => {
    const c = fromHandoff({ harness: 'claude', model: 'claude-opus-5-5' }, task, CAT);
    expect(c).toMatchObject({ harness: 'claude', model: 'claude-opus-5-5', effort: '', task });
    expect(c.origin).toEqual({ harness: 'handoff', model: 'handoff', effort: 'missing', task: 'handoff' });
    expect(needsAttention(c, CAT)).toEqual(new Set(['effort']));
  });
  it('a model the catalog lacks is empty and needs a new choice, its word kept; nothing is substituted', () => {
    const c = fromHandoff({ harness: 'claude', model: 'claude-opus-4' }, task, CAT);
    expect(c).toMatchObject({ harness: 'claude', model: '', effort: '' });
    expect(c.origin.model).toBe('invalid');
    expect(c.said.model).toBe('claude-opus-4');
    const none = fromHandoff({}, task, CAT);
    expect(none.origin).toMatchObject({ harness: 'missing', model: 'missing' });
  });
});
