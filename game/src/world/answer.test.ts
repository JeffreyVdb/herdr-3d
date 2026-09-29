import { describe, expect, it } from 'vitest';
import type { Question } from '../net/protocol';
import { answerable, answerArgs, answerKeys, digitPick, pickLabel, questionAbout, questionLine } from './answer';

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

  it("approves Claude's trust dialog with the choice that trusts, not its first ('No, exit')", () => {
    const trust: Question = {
      kind: 'trust',
      text: 'Quick safety check: Is this a project you created or one you trust?',
      excerpt: [],
      choices: [
        { n: 1, label: 'No, exit' },
        { n: 2, label: 'Yes, I trust this folder' },
      ],
      selected: 1,
      hash: '1111111111111111',
    };
    expect(answerKeys(trust)).toEqual({ approve: { n: 2, label: 'Yes, I trust this folder' }, deny: { choice: 1 }, denyChoice: { n: 1, label: 'No, exit' } });
    const codex: Question = { ...trust, kind: 'permission', choices: [{ n: 1, label: 'Yes, proceed (y)' }, { n: 2, label: 'Yes, and don’t ask again (p)' }, { n: 3, label: 'No, and tell Codex what to do differently (esc)' }] };
    expect(answerKeys(codex)).toMatchObject({ approve: { n: 1 }, deny: { choice: 3 } });
    // Only a "no": nothing to approve with.
    expect(answerKeys({ ...trust, choices: [{ n: 1, label: 'No, exit' }, { n: 2, label: 'Later' }] }).approve).toBeNull();
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
    expect(questionLine({ ...permission, text: '  ', excerpt: ['Allow?', '  ', 'Esc to cancel'] })).toBe('Allow?');
    expect(questionLine({ ...permission, text: '', excerpt: ['Should I regenerate every fixture, or only demo-m5?', '❯'] })).toBe('Should I regenerate every fixture, or only demo-m5?');
    expect(questionLine({ ...permission, text: '', excerpt: ['Working on it', '> '] })).toBe('Working on it');
    expect(questionLine({ ...permission, text: '', excerpt: [] })).toBe('');
  });

  it('says what a question is about: the command, file or folder above its menu, not its frame', () => {
    // The demo-m5 fixture's questions, as the bridge reads them off real screens.
    const tofu: Question = {
      kind: 'permission',
      text: 'Do you want to proceed?',
      excerpt: ['Bash command', 'git push origin h3d/tofu-m3-plan', 'Push the plan branch for review', 'Do you want to proceed?', '❯ 1. Yes', "2. Yes, and don't ask again for git push commands in /home/dev/devel/herdr-3d", '3. No', 'Esc to cancel · Tab to amend'],
      choices: [
        { n: 1, label: 'Yes' },
        { n: 2, label: "Yes, and don't ask again for git push commands in /home/dev/devel/herdr-3d" },
        { n: 3, label: 'No' },
      ],
      selected: 1,
      hash: 'c811ca8fe78acc26',
    };
    expect(questionAbout(tofu)).toEqual(['git push origin h3d/tofu-m3-plan', 'Push the plan branch for review']);
    const sprocket: Question = {
      kind: 'permission',
      text: 'Would you like to run the following command?',
      excerpt: ['Would you like to run the following command?', 'Reason: May I run the store tests outside the read-only sandbox?', '$ go test ./internal/store', '› 1. Yes, proceed (y)', "2. Yes, and don't ask again for commands that start with `go test` (p)", '3. No, and tell Codex what to do differently (esc)', 'Press enter to confirm or esc to cancel'],
      choices: [
        { n: 1, label: 'Yes, proceed (y)' },
        { n: 2, label: "Yes, and don't ask again for commands that start with `go test` (p)" },
        { n: 3, label: 'No, and tell Codex what to do differently (esc)' },
      ],
      selected: 1,
      hash: 'f20078f30c684732',
    };
    expect(questionAbout(sprocket)).toEqual(['$ go test ./internal/store', 'Reason: May I run the store tests outside the read-only sandbox?']);
    const tater: Question = {
      kind: 'trust',
      text: 'Quick safety check: Is this a project you created or one you trust?',
      excerpt: ['Accessing workspace:', '/home/dev/devel/herdr-3d-wt/release', 'Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source', 'Claude Code’ll be able to read, edit, and execute files here.', '❯ No, exit', 'Yes, I trust this folder', 'Enter to confirm · Esc to cancel'],
      choices: [
        { n: 1, label: 'No, exit' },
        { n: 2, label: 'Yes, I trust this folder' },
      ],
      selected: 1,
      hash: '629f0ff89e317dd0',
    };
    expect(questionAbout(tater)).toEqual(['/home/dev/devel/herdr-3d-wt/release', 'Claude Code’ll be able to read, edit, and execute files here.']);
    expect(questionAbout(permission)).toEqual(['internal/server/hub.go', 'Edit file']);
    expect(questionAbout(permission, 1)).toEqual(['internal/server/hub.go']);
    // No menu: the lines above the one that asks.
    const waffle: Question = { kind: 'other', text: '', excerpt: ['I can regenerate every fixture, or only the new demo-m5 one.', 'Should I regenerate every fixture, or only demo-m5?', '❯'], choices: [], hash: '7f110216d30d0654' };
    expect(questionAbout(waffle)).toEqual(['I can regenerate every fixture, or only the new demo-m5 one.']);
    expect(questionAbout({ ...permission, excerpt: [] })).toEqual([]);
  });

  it('answers only a question with a hash', () => {
    expect(answerable(permission)).toBe(permission);
    expect(answerable({ ...permission, hash: '' })).toBeNull();
    expect(answerable(undefined)).toBeNull();
  });
});
