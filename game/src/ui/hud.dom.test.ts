// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { Worker } from '../net/protocol';
import type { WorkerView } from '../world/store';
import { workerShown } from './hud';

const view = (over: Partial<Worker>, harness?: string): WorkerView => ({
  worker: { id: 'w', session: 's', floor: 's', workspace_id: 'ws', label: 'l', name: 'Pip', status: 'idle', status_since: 0, ...over },
  name: 'Pip',
  desk: 0,
  harness,
  since: 0,
  display: 'idle',
});

describe('the look-at bar’s key (#229)', () => {
  it('has the shown model (readable, no harness word) and still the exact id and the harness', () => {
    const k = workerShown(view({ model: 'claude-opus-5-5', effort: 'high' }, 'claude'), {});
    expect(k).toContain('Opus 5.5 high');
    expect(k).toContain('claude-opus-5-5');
    expect(k).toContain('claude');
    expect(k.join('\n')).not.toContain('claude opus');
  });

  it('a harness- or id-only change changes it, so the bar redraws', () => {
    const a = workerShown(view({ model: 'gpt-6-sol' }, 'codex'), {});
    expect(workerShown(view({ model: 'gpt-6-sol' }, 'claude'), {})).not.toEqual(a);
    const labelled = { codex: { models: ['gpt-6-sol', 'sol'], efforts: [], model_labels: { 'gpt-6-sol': 'Sol', sol: 'Sol' } } };
    expect(workerShown(view({ model: 'gpt-6-sol' }, 'codex'), labelled)).not.toEqual(workerShown(view({ model: 'sol' }, 'codex'), labelled));
  });
});
