import { describe, expect, it } from 'vitest';
import type { HireInterpretation } from '../net/protocol';
import { barKey, interpretErrorText, interpretOutcome, NOT_SUPPORTED, outcomeText, UNCLEAR, type KeyLike } from './dictationModel';

const hire: HireInterpretation = {
  sources: ['Hire an agent.'],
  harness: { provenance: 'missing' },
  model: { provenance: 'missing' },
  effort: { provenance: 'missing' },
  task: { provenance: 'missing' },
  questions: [],
  ready_for_review: false,
};

const k = (key: string, o: Partial<KeyLike> = {}): KeyLike => ({ key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...o });

describe('the bar field’s keys (#213)', () => {
  it('submits on Enter (and on Ctrl/⌘+Enter), and leaves Shift+Enter to the field as a new line', () => {
    expect(barKey(k('Enter'))).toBe('submit');
    expect(barKey(k('Enter', { ctrlKey: true }))).toBe('submit');
    expect(barKey(k('Enter', { metaKey: true }))).toBe('submit');
    expect(barKey(k('Enter', { shiftKey: true }))).toBeNull();
    expect(barKey(k('Enter', { altKey: true }))).toBeNull();
  });

  it('never submits or closes during an IME composition, Safari’s committing Enter (keyCode 229) included', () => {
    expect(barKey(k('Enter', { isComposing: true }))).toBeNull();
    expect(barKey(k('Enter', { keyCode: 229 }))).toBeNull();
    expect(barKey(k('Process'))).toBeNull();
    expect(barKey(k('Escape', { isComposing: true }))).toBeNull();
  });

  it('closes on a plain Esc, and leaves letters, paste and the rest to the field', () => {
    expect(barKey(k('Escape'))).toBe('close');
    expect(barKey(k('Escape', { shiftKey: true }))).toBeNull();
    for (const e of [k('w'), k('v', { ctrlKey: true }), k('v', { metaKey: true }), k('ArrowUp'), k('Tab')]) expect(barKey(e)).toBeNull();
  });
});

describe('routing hire.interpret’s answer (#213)', () => {
  const ok = (data: unknown) => interpretOutcome({ ok: true, data });

  it('a hire proposal goes to the review; unsupported and unclear are their exact lines', () => {
    expect(ok({ text: 'Hire an agent.', intent: 'hire', hire })).toEqual({ kind: 'hire', hire });
    expect(ok({ text: 'Open Settings.', intent: 'unsupported' })).toEqual({ kind: 'unsupported' });
    expect(ok({ text: 'Hire two agents.', intent: 'unsupported', reason: 'multiple' })).toEqual({ kind: 'unsupported' });
    expect(ok({ text: 'high', intent: 'unclear' })).toEqual({ kind: 'unclear' });
    expect(outcomeText({ kind: 'unsupported' })).toBe('Not supported yet.');
    expect(outcomeText({ kind: 'unclear' })).toBe('Your intent is unclear.');
    expect([NOT_SUPPORTED, UNCLEAR]).toEqual(['Not supported yet.', 'Your intent is unclear.']);
  });

  it('an operational error in the ack is a direct error, never a hire', () => {
    const o = ok({ text: 'Hire an agent.', error: { code: 'provider_failed', message: 'the provider failed' } });
    expect(o).toEqual({ kind: 'error', message: interpretErrorText('provider_failed') });
    expect(ok({ text: 'x', error: { code: 'timeout', message: '' } })).toMatchObject({ kind: 'error', message: expect.stringContaining('did not answer in time') });
    expect(ok({ text: 'x', error: { code: 'not_ready', message: '' } })).toMatchObject({ kind: 'error', message: expect.stringContaining('Settings') });
    expect(ok({ text: 'x', error: { code: 'bad_span', message: '' } })).toMatchObject({ kind: 'error', message: expect.stringContaining('not usable') });
    // Even with a hire in it.
    expect(ok({ text: 'x', intent: 'hire', hire, error: { code: 'bad_answer', message: '' } }).kind).toBe('error');
  });

  it('an answer of the wrong shape is an error', () => {
    for (const d of [null, 'hire', {}, { intent: 'hire' }, { intent: 'hire', hire: 'x' }, { intent: 'fire' }]) expect(ok(d).kind, JSON.stringify(d)).toBe('error');
  });

  it('a request that failed (timeout, disconnect, an older bridge) is an error that says nothing was hired, and to try again', () => {
    expect(interpretOutcome({ ok: false, code: 'timeout', message: 'herdr-world did not answer hire.interpret within 40 s' })).toEqual({
      kind: 'error',
      message: 'herdr-world did not answer in time. Nothing was hired; press Enter to try again.',
    });
    expect(interpretOutcome({ ok: false, code: 'disconnected', message: '' })).toMatchObject({ message: expect.stringContaining('Nothing was hired') });
    expect(interpretOutcome({ ok: false, code: 'offline', message: '' })).toMatchObject({ message: expect.stringContaining('Not connected') });
    expect(interpretOutcome({ ok: false, code: 'unknown_command', message: 'unknown command: "hire.interpret"' })).toMatchObject({ message: 'This herdr-world can’t understand dictated commands yet. Update the bridge to use it.' });
  });
});
