import { describe, expect, it } from 'vitest';
import type { CodexProfile, CodexProfilesState } from '../net/protocol';
import { codexProfilesOf, hireProfiles, loneProfileGone, pickProfile, profileGoneText, profileNotice, ruleMatchProblem, ruleProfileProblem, ruleRefusal, rulesProblem } from './codexProfiles';

const prof = (key: string, more: Partial<CodexProfile> = {}): CodexProfile => ({
  key,
  name: key,
  path: `/home/u/.codex-${key}`,
  display: `~/.codex-${key}`,
  plan: '',
  signed_in: true,
  default: false,
  hidden: false,
  added: false,
  ...more,
});

const two: CodexProfilesState = { hire: true, profiles: [prof('codex', { default: true, path: '/home/u/.codex' }), prof('work', { name: 'Work' })] };

describe('#139 Codex profiles for a hire', () => {
  it('reads the bridge that takes a profile on a hire', () => {
    expect(codexProfilesOf({ profiles: [], hire: true })?.hire).toBe(true);
    expect(codexProfilesOf({ profiles: [] })).toEqual({ profiles: [] });
  });

  it('offers a picker only with two or more usable profiles, on a bridge that takes one', () => {
    expect(hireProfiles(two)?.map((p) => p.key)).toEqual(['codex', 'work']);
    expect(hireProfiles({ profiles: two.profiles })).toBeNull(); // an older bridge
    expect(hireProfiles(null)).toBeNull();
    expect(hireProfiles({ hire: true, profiles: [two.profiles[0]!] })).toBeNull();
    // A hidden profile and an added folder that went are not offered: one is left, no picker.
    const shy = { hire: true, profiles: [two.profiles[0]!, prof('shy', { hidden: true }), prof('gone', { added: true, missing: true })] };
    expect(hireProfiles(shy)).toBeNull();
    // Not signed in: offered (disabled).
    expect(hireProfiles({ hire: true, profiles: [...two.profiles, prof('new', { signed_in: false })] })?.map((p) => p.key)).toEqual(['codex', 'work', 'new']);
  });

  it('starts on the default, or a preset’s profile while it can be picked', () => {
    const list = [...two.profiles, prof('new', { signed_in: false })];
    expect(pickProfile(list)).toEqual({ key: 'codex', gone: null });
    expect(pickProfile(list, 'work')).toEqual({ key: 'work', gone: null });
    expect(pickProfile(list, 'old')).toEqual({ key: 'codex', gone: 'old' });
    expect(pickProfile(list, 'new')).toEqual({ key: 'codex', gone: null }); // listed, not signed in: the default, no "gone"
    expect(profileGoneText(two, 'old', 'codex')).toBe('This preset’s Codex profile “old” is gone: it hires on codex.');
  });
});

describe('#139 the seat’s Codex profile line', () => {
  const codexW = { harness: 'codex' };
  it('says nothing with fewer than two profiles shown', () => {
    expect(profileNotice({ ...codexW, codex: { mode: 'shared', profile: 'work' } }, { hire: true, profiles: [two.profiles[0]!] })).toBeNull();
    expect(profileNotice({ ...codexW }, null)).toBeNull();
  });
  it('says a wake on the default because its profile was gone, also with only the default left', () => {
    const gone = 'work is gone: woke on codex. Its Codex session stays in that folder, so a new one was started.';
    const one: CodexProfilesState = { hire: true, profiles: [two.profiles[0]!] };
    expect(profileNotice({ ...codexW, codex: { mode: 'legacy', profile: 'codex', profile_note: gone } }, one)).toEqual({ tone: 'note', text: gone });
    expect(profileNotice({ ...codexW, codex: { mode: 'shared', profile: 'codex' } }, one)).toBeNull();
    expect(profileNotice({ ...codexW, codex: { mode: 'shared', profile: 'work', profile_note: 'Could not confirm the account.' } }, one)).toBeNull();
  });
  it('names the profile by its current name, with what its start found', () => {
    expect(profileNotice({ ...codexW, codex: { mode: 'shared', profile: 'work' } }, two)).toEqual({ tone: 'note', text: 'Work' });
    expect(
      profileNotice({ ...codexW, codex: { mode: 'shared', profile: 'work', account: 'mismatch', profile_note: 'Asked for work, the server signed in to another account.' } }, two),
    ).toEqual({ tone: 'down', text: 'Work. Asked for work, the server signed in to another account.' });
    expect(profileNotice({ ...codexW, codex: { mode: 'shared', profile: 'gone-key' } }, two)?.text).toBe('gone-key');
  });
  it('says a Codex worker without one runs on the default profile; not other workers', () => {
    expect(profileNotice({ agent_kind: 'codex' }, two)).toEqual({ tone: 'note', text: 'Runs on the default profile (codex).' });
    expect(profileNotice({ harness: 'codex', codex: { mode: 'legacy' } }, two)?.text).toBe('Runs on the default profile (codex).');
    expect(profileNotice({ harness: 'claude', agent_kind: 'claude' }, two)).toBeNull();
  });
});

describe('#140 Auto and its rules', () => {
  it('reads Auto, the rules (well-formed ones only) and the flag; an older bridge has neither', () => {
    const v = codexProfilesOf({ hire: true, auto: true, rules: [{ match: '/a', profile: 'work' }, { match: 1 }], profiles: [{ ...prof('work'), anything: true }] });
    expect(v?.auto).toBe(true);
    expect(v?.rules).toEqual([{ match: '/a', profile: 'work' }]);
    expect(v?.profiles[0]?.anything).toBe(true);
    const old = codexProfilesOf({ hire: true, profiles: [prof('work')] });
    expect(old?.auto).toBeUndefined();
    expect(old?.rules).toBeUndefined();
    expect(old?.profiles[0]?.anything).toBeUndefined();
  });

  it('a new form and an Auto preset start on Auto where it is offered; a preset with none or a profile keeps it', () => {
    const list = two.profiles;
    expect(pickProfile(list, undefined, true)).toEqual({ key: 'auto', gone: null });
    expect(pickProfile(list, 'auto', true)).toEqual({ key: 'auto', gone: null });
    expect(pickProfile(list, '', true)).toEqual({ key: 'codex', gone: null });
    expect(pickProfile(list, 'work', true)).toEqual({ key: 'work', gone: null });
    // An older bridge: the default, and Auto is not "gone".
    expect(pickProfile(list, 'auto')).toEqual({ key: 'codex', gone: null });
    expect(loneProfileGone({ hire: true, auto: true, profiles: [list[0]!] }, 'auto')).toBeNull();
  });

  it('checks a rule’s match in the bridge’s words', () => {
    for (const ok of ['github.com/acme/*', 'GitHub.com/acme/widgets', '~/work', '~', '/srv/x']) expect(ruleMatchProblem(ok)).toBeNull();
    expect(ruleMatchProblem(' ')).toBe('Type a repo (github.com/<owner>/* or github.com/<owner>/<repo>) or a folder (/… or ~/…).');
    expect(ruleMatchProblem('github.com/bad_owner/*')).toBe('“bad_owner” is not a GitHub owner: use github.com/<owner>/* or github.com/<owner>/<repo>.');
    expect(ruleMatchProblem('github.com/acme')).toBe('“” is not a GitHub repo: use github.com/<owner>/* or github.com/<owner>/<repo>.');
    expect(ruleMatchProblem('acme/*')).toBe('Use github.com/<owner>/* or github.com/<owner>/<repo>, or a folder starting with / or ~/.');
    expect(ruleMatchProblem('/a\tb')).toBe('A match cannot have a line break or a tab in it.');
  });

  it('finds the first rule the editor can tell is wrong, and reads the bridge’s refusal of one', () => {
    const list = two.profiles;
    expect(rulesProblem([{ match: '/a', profile: 'work' }], list)).toBeNull();
    expect(rulesProblem([{ match: '/a', profile: 'work' }, { match: '/a/', profile: 'codex' }], list)).toEqual({ index: 1, text: 'Rule 1 already matches this.' });
    // A folder keeps its case (the bridge's picker compares it so); GitHub matches are one rule ignoring case.
    expect(rulesProblem([{ match: '/work/A', profile: 'work' }, { match: '/work/a/', profile: 'codex' }, { match: '~/Work', profile: 'work' }, { match: '~/work', profile: 'codex' }], list)).toBeNull();
    expect(rulesProblem([{ match: 'github.com/acme/*', profile: 'work' }, { match: 'GitHub.com/ACME/*', profile: 'codex' }], list)).toEqual({ index: 1, text: 'Rule 1 already matches this.' });
    expect(rulesProblem([{ match: 'github.com/acme/widgets', profile: 'work' }, { match: 'github.com/Acme/Widgets', profile: 'codex' }], list)).toEqual({ index: 1, text: 'Rule 1 already matches this.' });
    expect(rulesProblem([{ match: '/a', profile: '' }], list)).toEqual({ index: 0, text: 'Choose the profile it hires on.' });
    expect(rulesProblem([{ match: '/a', profile: 'nope' }], list)).toEqual({ index: 0, text: 'There is no Codex profile “nope”.' });
    expect(ruleRefusal('Rule 3: there is no Codex profile "x".')).toEqual({ index: 2, text: 'There is no Codex profile "x".' });
    expect(ruleRefusal('At most 32 rules; remove one first.')).toBeNull();
  });

  it('says when Auto passes a rule over', () => {
    const list = [...two.profiles, prof('shy', { hidden: true }), prof('out', { signed_in: false }), prof('lost', { added: true, missing: true })];
    expect(ruleProfileProblem('work', list)).toBeNull();
    expect(ruleProfileProblem('shy', list)).toBe('shy is hidden: Auto passes this rule over.');
    expect(ruleProfileProblem('out', list)).toBe('out is not signed in: Auto passes this rule over.');
    expect(ruleProfileProblem('lost', list)).toBe('lost is gone: Auto passes this rule over.');
    expect(ruleProfileProblem('nope', list)).toBe('nope is gone: Auto passes this rule over.');
  });
});
