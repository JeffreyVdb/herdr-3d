import { describe, expect, it } from 'vitest';
import { hiredToast } from './hiredToast';

// #186: an acknowledged hire (or run start) is never an error by itself. A Codex hire that asked for its own server and
// runs on Codex's built-in one is a warning; a task that did not reach the worker stays an error, and wins over the warning.

const LEAD = 'Hired Sprocket at Desk 2 on h3d/sprocket-e4f2f1. Here they come.';
const UNVERIFIED = {
  mode: 'legacy' as const,
  note: 'shared Codex server: unsupported Codex version: "codex-cli 0.163.0" (supported: codex-cli 0.160.x, 0.161.x or 0.162.x); started the usual way',
};
const NOT_SENT = 'The first task was not sent (no luck): prompt them yourself (P).';

describe('hiredToast', () => {
  it('a plain hire is info, the lead alone', () => {
    expect(hiredToast(LEAD, {}, '')).toEqual({ text: LEAD, kind: 'info' });
    expect(hiredToast(LEAD, undefined, '')).toEqual({ text: LEAD, kind: 'info' });
    expect(hiredToast(LEAD, { codex: { mode: 'shared', server: 'running' } }, '')).toEqual({ text: LEAD, kind: 'info' });
  });

  it('a hire on an unverified Codex is a warning that names the version, what is not verified and what it costs', () => {
    const t = hiredToast(LEAD, { codex: UNVERIFIED }, '');
    expect(t.kind).toBe('warn');
    expect(t.text).toBe(
      `${LEAD} No own Codex server: the shared Codex server is not verified with Codex 0.163.0 yet (verified: 0.160.x, 0.161.x or 0.162.x). ` +
        'It runs on Codex’s built-in server, so its async questions can’t be answered from the transcript.',
    );
  });

  it('any other fallback is a warning too: the worker is there and works', () => {
    const t = hiredToast(LEAD, { codex: { mode: 'legacy', note: 'shared Codex server: .envrc is blocked: /r/.envrc; started the usual way' } }, '');
    expect(t.kind).toBe('warn');
    expect(t.text).toContain('No own Codex server: .envrc is blocked: /r/.envrc.');
  });

  it('direnv without a mise version is a warning with the short, actionable copy', () => {
    const t = hiredToast(LEAD, { codex: { mode: 'legacy', note: 'shared Codex server: direnv is installed through mise but has no version selected for /r; started the usual way' } }, '');
    expect(t.kind).toBe('warn');
    expect(t.text).toContain('No own Codex server: direnv is installed with mise, but no version of it is selected for this worker’s folder (/r).');
    expect(t.text).not.toContain('mise use');
  });

  it('a task that was not sent is an error, also beside a fallback (the more severe wins), both said', () => {
    expect(hiredToast(LEAD, {}, NOT_SENT)).toEqual({ text: `${LEAD} ${NOT_SENT}`, kind: 'error' });
    const t = hiredToast(LEAD, { codex: UNVERIFIED }, NOT_SENT);
    expect(t.kind).toBe('error');
    expect(t.text.startsWith(`${LEAD} ${NOT_SENT} No own Codex server:`)).toBe(true);
  });
});

describe('#139 the hire’s Codex profile', () => {
  it('says what the hire found about the profile: a warning unless its account was confirmed', () => {
    const mismatch = { mode: 'shared' as const, server: 'running' as const, profile: 'work', account: 'mismatch' as const, profile_note: 'Asked for work, the server signed in to another account.' };
    expect(hiredToast(LEAD, { codex: mismatch }, '')).toEqual({ text: `${LEAD} Asked for work, the server signed in to another account.`, kind: 'warn' });
    const bare = { mode: 'shared' as const, profile: 'work', account: 'confirmed' as const, profile_note: 'work has no hooks.json with herdr’s hook.' };
    expect(hiredToast(LEAD, { codex: bare }, '')).toEqual({ text: `${LEAD} work has no hooks.json with herdr’s hook.`, kind: 'info' });
    expect(hiredToast(LEAD, { codex: { mode: 'shared', profile: 'work', account: 'confirmed' } }, '')).toEqual({ text: LEAD, kind: 'info' });
  });
});
