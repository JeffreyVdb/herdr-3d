import { describe, expect, it } from 'vitest';
import { claudeSlugName, modelEntries, modelLabel, modelMatches, spaceSeparators } from './modelLabel';

// #200: readable model names. Fixture ids only; nothing here is a catalog.

describe('modelLabel', () => {
  it("prefers the harness's own label", () => {
    expect(modelLabel('claude', 'claude-opus-5', { 'claude-opus-5': 'Opus 5' })).toBe('Opus 5');
    expect(modelLabel('claude', 'some-alias', { 'some-alias': '  Some   Name ' })).toBe('Some Name');
  });

  it('turns a Codex label that is still a token into words, keeping versions and variants', () => {
    expect(modelLabel('codex', 'gpt-6.1-sol', { 'gpt-6.1-sol': 'GPT-6.1-Sol' })).toBe('GPT 6.1 Sol');
    expect(modelLabel('codex', 'gpt-6-sol', { 'gpt-6-sol': 'GPT-6-Sol' })).toBe('GPT 6 Sol');
    expect(modelLabel('codex', 'gpt-6.1-sol-mini', { 'gpt-6.1-sol-mini': 'GPT-6.1-Sol-Mini' })).toBe('GPT 6.1 Sol Mini');
    expect(modelLabel('codex', 'a', { a: 'GPT 6.1 Sol' })).toBe('GPT 6.1 Sol');
    expect(modelLabel('codex', 'a', { a: 'GPT-6.1 Sol' })).toBe('GPT-6.1 Sol'); // already has words: left as the provider wrote it
    expect(spaceSeparators('Sol')).toBe('Sol');
    expect(spaceSeparators('-')).toBe('-');
  });

  it('names recognised Claude slugs when there is no label', () => {
    expect(modelLabel('claude', 'claude-opus-5')).toBe('Opus 5');
    expect(modelLabel('claude', 'claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabel('claude', 'claude-fable-5-1')).toBe('Fable 5.1');
    expect(modelLabel('claude', 'claude-sonnet-5-5', {})).toBe('Sonnet 5.5');
    expect(modelLabel('claude', 'claude-haiku-5')).toBe('Haiku 5');
    expect(claudeSlugName('claude-opus-5-5')).toBe('Opus 5.5');
  });

  it('keeps any other slug exactly as it is', () => {
    for (const id of ['gpt-6.1-sol', 'gpt-6-sol', 'claude-sonnet-4-20250514', 'claude-3-5-sonnet', 'claude-opus-5-5-1', 'claude-opus', 'sonnet', 'default', 'x_1']) {
      expect(modelLabel('claude', id)).toBe(id);
      expect(modelLabel('codex', id)).toBe(id);
    }
    expect(claudeSlugName('claude-opus-x')).toBeNull();
  });

  it('ignores a label that is not usable text, and a label of another model', () => {
    expect(modelLabel('claude', 'claude-opus-5', { 'claude-opus-5': '   ' })).toBe('Opus 5');
    expect(modelLabel('claude', 'claude-opus-5', { 'claude-opus-5': 'x'.repeat(65) })).toBe('Opus 5');
    expect(modelLabel('claude', 'claude-opus-5', { 'claude-opus-5': 7 as never })).toBe('Opus 5');
    expect(modelLabel('claude', 'claude-opus-5', { 'claude-fable-5': 'Fable 5' })).toBe('Opus 5');
    expect(modelLabel('claude', 'm', { m: 'A\u0007B\nC' })).toBe('A B C');
    // Inherited properties are not labels.
    expect(modelLabel('claude', 'constructor', {})).toBe('constructor');
    expect(modelLabel('claude', '__proto__', {})).toBe('__proto__');
    expect(modelLabel('claude', 'toString', undefined)).toBe('toString');
  });

  it('returns markup as text to be set with textContent, unchanged', () => {
    expect(modelLabel('claude', 'm', { m: '<img src=x onerror=alert(1)>' })).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('modelEntries and modelMatches', () => {
  const labels = { 'claude-opus-5': 'Opus 5', 'claude-opus-5-5': 'Opus 5.5', 'a-1': 'Twin', 'a-2': 'twin ' };
  const ids = ['claude-opus-5', 'claude-opus-5-5', 'a-1', 'a-2', 'raw-id'];
  const entries = modelEntries('claude', ids, labels);
  const hits = (q: string) => entries.filter((e) => modelMatches(q, e)).map((e) => e.id);

  it('names each id, marks the named ones and the ones sharing a name', () => {
    expect(entries.map((e) => [e.id, e.label, e.named, e.collides])).toEqual([
      ['claude-opus-5', 'Opus 5', true, false],
      ['claude-opus-5-5', 'Opus 5.5', true, false],
      ['a-1', 'Twin', true, true],
      ['a-2', 'twin', true, true],
      ['raw-id', 'raw-id', false, false],
    ]);
  });

  it('matches the readable name or the exact id, case-insensitively, spaces included', () => {
    expect(hits('')).toEqual(ids);
    expect(hits('opus 5.5')).toEqual(['claude-opus-5-5']);
    expect(hits('  OPUS   5.5 ')).toEqual(['claude-opus-5-5']);
    expect(hits('opus 5')).toEqual(['claude-opus-5', 'claude-opus-5-5']);
    expect(hits('claude-opus-5-5')).toEqual(['claude-opus-5-5']);
    expect(hits('RAW')).toEqual(['raw-id']);
    expect(hits('twin')).toEqual(['a-1', 'a-2']);
    expect(hits('a-2')).toEqual(['a-2']);
    expect(hits('zzz')).toEqual([]);
  });

  it("also matches the provider's own wording of a Codex name", () => {
    const [e] = modelEntries('codex', ['gpt-6.1-sol'], { 'gpt-6.1-sol': 'GPT-6.1-Sol' });
    expect(e!.label).toBe('GPT 6.1 Sol');
    expect(modelMatches('gpt 6.1 sol', e!)).toBe(true);
    expect(modelMatches('GPT-6.1-Sol', e!)).toBe(true);
    expect(modelMatches('6.1-so', e!)).toBe(true);
    expect(modelMatches('6 sol', e!)).toBe(false);
  });
});
