import type { HireInterpretation, HireOptions } from '../net/protocol';

/** #212: fixture catalog and interpretations (ids are fixtures, not app defaults) for the review's tests. */

export const CAT: HireOptions = {
  claude: {
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    efforts: ['low', 'medium', 'high'],
    extra_efforts: { 'claude-opus-5-5': ['xhigh', 'max'] },
    model_labels: { 'claude-haiku-5-5': 'Haiku 5.5' },
  },
  codex: { models: ['gpt-6-luna', 'gpt-6-sol'], efforts: ['low', 'high'] },
};

export const field = (provenance: 'dictated' | 'resolved' | 'missing' | 'invalid', value?: string, said?: string) => ({ provenance, ...(value ? { value } : {}), ...(said ? { said } : {}) });

export const FULL: HireInterpretation = {
  sources: ['Hire a Claude Code agent on Haiku 5.5 with high effort. Task: fix the login bug.'],
  harness: field('dictated', 'claude'),
  model: field('resolved', 'claude-haiku-5-5'),
  effort: field('dictated', 'high'),
  task: { provenance: 'dictated', value: 'fix the login bug.', span: { source: 0, start: 62, end: 80 } },
  questions: [],
  ready_for_review: true,
};

export const NO_EFFORT: HireInterpretation = {
  ...FULL,
  effort: field('missing'),
  questions: [{ field: 'effort', text: 'What effort level should this agent use?', efforts: ['low', 'medium', 'high'] }],
  ready_for_review: false,
};
