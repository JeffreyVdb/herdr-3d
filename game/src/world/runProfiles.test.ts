import { describe, expect, it } from 'vitest';
import type { CodexProfile, CodexProfilesState, Hire, PresetRoles } from '../net/protocol';
import { keepProfile, roleGoneText, roleLoneGone, roleProfileChoice, roleProfileLabel, rolesFor, withProfile } from './runProfiles';
import { presetLines, presetPatch } from './startRun';

// #167: the orchestrator's and the team roles' Codex profile: offered only by a bridge with `runs`, for Codex, with two
// or more usable profiles; a role with none is on the default (never Auto); a gone one falls back and says so.

const prof = (key: string, more: Partial<CodexProfile> = {}): CodexProfile => ({
  key, name: key, path: `/home/test/.codex-${key}`, display: `~/.codex-${key}`, plan: '', signed_in: true, default: false, hidden: false, added: false, ...more,
});
const own = prof('codex', { default: true, name: 'Own', path: '/home/test/.codex' });
const RUNS: CodexProfilesState = { hire: true, auto: true, runs: true, rules: [], profiles: [own, prof('work', { name: 'Work' }), prof('off', { signed_in: false })] };
const { runs: _runs, ...NORUNS } = RUNS;
const { auto: _auto, ...NOAUTO } = RUNS;
const codex = (p?: string): Hire => ({ harness: 'codex', model: 'x', effort: 'low', ...(p === undefined ? {} : { codex_profile: p }) });
const claude: Hire = { harness: 'claude', model: 'y', effort: 'low' };

describe('roleProfileChoice', () => {
  it('is for a Codex role on a bridge with runs and two usable profiles', () => {
    expect(roleProfileChoice(RUNS, 'claude', undefined)).toBeNull();
    expect(roleProfileChoice(NORUNS, 'codex', undefined)).toBeNull();
    expect(roleProfileChoice({ ...RUNS, profiles: [own, prof('work', { hidden: true })] }, 'codex', undefined)).toBeNull();
    expect(roleProfileChoice(null, 'codex', undefined)).toBeNull();
    expect(roleProfileChoice(RUNS, 'codex', undefined)).toMatchObject({ key: 'codex', gone: null, auto: true });
  });
  it('starts on the preset’s, a pick wins while it can be picked, Auto only when offered', () => {
    expect(roleProfileChoice(RUNS, 'codex', 'work')?.key).toBe('work');
    expect(roleProfileChoice(RUNS, 'codex', 'auto')?.key).toBe('auto');
    expect(roleProfileChoice(NOAUTO, 'codex', 'auto')?.key).toBe('codex');
    expect(roleProfileChoice(RUNS, 'codex', 'work', 'auto')?.key).toBe('auto');
    expect(roleProfileChoice(RUNS, 'codex', 'work', 'off')?.key).toBe('work'); // not signed in: not pickable
    expect(roleProfileChoice(RUNS, 'codex', '', 'work')?.key).toBe('work');
  });
  it('a gone profile falls back to the default and says so; with no picker the note stands alone', () => {
    const c = roleProfileChoice(RUNS, 'codex', 'lab')!;
    expect(c).toMatchObject({ key: 'codex', gone: 'lab' });
    expect(roleGoneText(RUNS, c)).toBe('This preset’s Codex profile “lab” is gone: it runs on Own.');
    const lone: CodexProfilesState = { ...RUNS, profiles: [own, prof('lab', { hidden: true })] };
    expect(roleLoneGone(lone, 'codex', 'gone')).toBe('This preset’s Codex profile “gone” is gone: it runs on Own.');
    expect(roleLoneGone((({ runs: _r, ...x }) => x)(lone), 'codex', 'gone')).toBeNull();
    expect(roleLoneGone(lone, 'codex', undefined)).toBeNull();
  });
});

describe('the profile on the wire', () => {
  it('withProfile and keepProfile: only on Codex, kept while the role stays Codex', () => {
    expect(withProfile(codex('work'), null)).toEqual(codex());
    expect(withProfile(codex(), 'auto')).toEqual(codex('auto'));
    expect(withProfile(claude, 'work')).toEqual(claude);
    expect(keepProfile(codex(), codex('work'))).toEqual(codex('work'));
    expect(keepProfile(claude, codex('work'))).toEqual(claude);
    expect(keepProfile(codex(), claude)).toEqual(codex());
  });
  it('rolesFor sends profiles only to a bridge with runs, and only on Codex roles', () => {
    const roles: PresetRoles = { orch: codex('work'), coder: { ...claude, codex_profile: 'work' }, reviewer: codex('auto'), ux: codex(), researcher: codex('') };
    expect(rolesFor(RUNS, roles)).toEqual({ orch: codex('work'), coder: claude, reviewer: codex('auto'), ux: codex(), researcher: codex() });
    const old = rolesFor(NORUNS, roles);
    expect(Object.values(old).some((h) => 'codex_profile' in h)).toBe(false);
  });
  it('presetPatch sees a profile change; the list line names a non-default profile', () => {
    const p = { id: 'p_1', name: 'T', roles: { orch: codex(), coder: claude, reviewer: codex(), ux: codex(), researcher: codex() } };
    expect(presetPatch(p, { name: 'T', roles: { ...p.roles, reviewer: codex('') } })).toBeNull();
    expect(presetPatch(p, { name: 'T', roles: { ...p.roles, reviewer: codex('work') } })?.roles?.reviewer).toEqual(codex('work'));
    expect(roleProfileLabel(RUNS, codex('work'))).toBe('Work');
    expect(roleProfileLabel(RUNS, codex('auto'))).toBe('Auto');
    expect(roleProfileLabel(RUNS, codex('codex'))).toBe('');
    const lines = presetLines({ ...p, roles: { ...p.roles, reviewer: codex('work') } }, {}, RUNS).map((l) => l.line);
    expect(lines[2]).toBe('codex · x · low · Work');
    expect(presetLines({ ...p, roles: { ...p.roles, reviewer: codex('work') } }).map((l) => l.line)[2]).toBe('codex · x · low');
  });
});
