import { describe, expect, it } from 'vitest';
import type { Question } from '../net/protocol';
import { answerable, answerArgs, answerKeys, digitPick, pickLabel, questionLine } from './answer';

const permission: Question = {
  kind: 'permission',
  text: 'Do you want to make this edit to hub.go?',
  excerpt: ['╭─ Edit file ─╮', '│ internal/server/hub.go │', 'Do you want to make this edit to hub.go?'],
  choices: [
    { n: 1, label: 'Yes' },
    { n: 2, label: 'Yes, allow all edits during this session' },
    { n: 3, label: 'No, and tell Claude what to do differently' },
  ],
  selected: 1,
  hash: '9f2c01ab77d3e410',
};

describe('answering a question', () => {
  it('approves with the first choice and denies with the "No" choice', () => {
    const k = answerKeys(permission);
    expect(k.approve).toEqual({ n: 1, label: 'Yes' });
    expect(k.deny).toEqual({ choice: 3 });
    expect(answerArgs('w1', permission, k.deny)).toEqual({ id: 'w1', hash: '9f2c01ab77d3e410', choice: 3 });
  });

  it('denies with a cancel when no choice says no', () => {
    const q: Question = { ...permission, kind: 'choice', choices: [{ n: 1, label: 'Work' }, { n: 2, label: 'Personal' }] };
    expect(answerKeys(q)).toMatchObject({ approve: { n: 1 }, deny: { cancel: true }, denyChoice: null });
    expect(answerArgs('w1', q, { cancel: true })).toEqual({ id: 'w1', hash: q.hash, cancel: true });
    const none: Question = { ...permission, kind: 'other', text: '', choices: [] };
    expect(answerKeys(none)).toEqual({ approve: null, deny: { cancel: true }, denyChoice: null });
  });

  it('maps digit keys to choices that exist', () => {
    expect(digitPick(permission, 2)).toEqual({ choice: 2 });
    expect(digitPick(permission, 4)).toBeNull();
    expect(pickLabel(permission, { choice: 2 })).toBe('2. Yes, allow all edits during this session');
    expect(pickLabel(permission, { cancel: true })).toBe('Esc (dismissed)');
  });

  it('reads the question line, else the excerpt', () => {
    expect(questionLine(permission)).toBe('Do you want to make this edit to hub.go?');
    expect(questionLine({ ...permission, text: '  ', excerpt: ['Allow?', '  ', 'Esc to cancel'] })).toBe('Esc to cancel');
    expect(questionLine({ ...permission, text: '', excerpt: [] })).toBe('');
  });

  it('answers only a question with a hash', () => {
    expect(answerable(permission)).toBe(permission);
    expect(answerable({ ...permission, hash: '' })).toBeNull();
    expect(answerable(undefined)).toBeNull();
  });
});
