import { describe, expect, it } from 'vitest';
import type { CodexProfile, CodexProfilesState } from '../net/protocol';
import { codexProfilesOf, hireProfiles, pickProfile, profileGoneText, profileNotice } from './codexProfiles';

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
