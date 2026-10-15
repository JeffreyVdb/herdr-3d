import { describe, expect, it } from 'vitest';
import type { StoredFloor } from './store';
import { baseSessions, FLOOR_KINDS, floorNameError, MAX_FLOOR_NAME, newSessionNameError, MAX_SESSION_NAME } from './addFloor';

describe('newSessionNameError (#58, the bridge’s rule for a new herdr session)', () => {
  const taken = ['herdr-3d', 'pastry'];

  it('accepts lowercase letters, digits, _ and -', () => {
    for (const name of ['a', 'h3dtest_9', '1h3dtest', '424242', 'my-floor', 'a_b-c', 'x'.repeat(MAX_SESSION_NAME)]) {
      expect(newSessionNameError(name, taken)).toBe('');
    }
  });

  it('says why a name is refused, like the bridge does', () => {
    expect(newSessionNameError('', taken)).toBe('Give the floor a name.');
    expect(newSessionNameError('default', taken)).toBe('“default” is herdr’s own session: pick another name.');
    for (const name of ['v-0123456789ab', 'v-ba9876543210']) expect(newSessionNameError(name, taken)).toBe('Names like “v-” and 12 hex digits are kept for virtual floors: pick another name.');
    for (const name of ['v-0123', 'v-0123456789abc', 'xv-0123456789ab']) expect(newSessionNameError(name, taken)).toBe('');
    expect(newSessionNameError('-h3dtest', taken)).toBe('The name cannot start with “-”.');
    for (const name of ['Upper', 'a.b', 'a/b', 'a b', 'émile', ' x']) expect(newSessionNameError(name, taken)).toBe('Use only lowercase letters, digits, “_” and “-”.');
    expect(newSessionNameError('x'.repeat(MAX_SESSION_NAME + 1), taken)).toBe(`Keep the name to at most ${MAX_SESSION_NAME} characters.`);
  });

  it('refuses a session the game already shows as a floor', () => {
    expect(newSessionNameError('pastry', taken)).toBe('“pastry” is already a floor.');
    expect(newSessionNameError('pastry2', taken)).toBe('');
  });

  it('lists the kinds the dialog offers, the new herdr session first', () => {
    expect(FLOOR_KINDS.map((k) => k.id)).toEqual(['session', 'virtual']);
    expect(FLOOR_KINDS[1]?.label).toBe('Virtual floor on an existing session');
  });
});

describe('floorNameError (#58 stage 4, the bridge’s rule for a virtual floor’s name)', () => {
  it('takes free text, trimmed, up to 64 bytes', () => {
    for (const name of ['Frontend', 'Back office 2', '  padded  ', 'Émile’s floor', 'x'.repeat(MAX_FLOOR_NAME), `${'é'.repeat(32)}`]) expect(floorNameError(name)).toBe('');
  });

  it('says why a name is refused', () => {
    expect(floorNameError('')).toBe('Give the floor a name.');
    expect(floorNameError('   ')).toBe('Give the floor a name.');
    expect(floorNameError('two\nlines')).toBe('A floor name cannot have a line break or a control character in it.');
    expect(floorNameError('bell\u0007')).toBe('A floor name cannot have a line break or a control character in it.');
    expect(floorNameError('c1\u0085')).toBe('A floor name cannot have a line break or a control character in it.');
    // Bytes, not characters: 33 two-byte letters are 66 bytes.
    expect(floorNameError('é'.repeat(33))).toMatch(/^Keep the name shorter: at most 64 bytes/);
    expect(floorNameError('x'.repeat(MAX_FLOOR_NAME + 1))).toMatch(/^Keep the name shorter/);
  });
});

describe('baseSessions (#58 stage 4)', () => {
  const f = (id: string, o: Partial<StoredFloor> = {}): StoredFloor => ({ id, session: id, name: id, base_session: id, virtual: false, hidden: false, state: 'running', building: null, index: null, ...o });
  it('offers every real floor’s session (hidden and asleep too), never a virtual floor, by name', () => {
    const floors = [f('pastry', { state: 'asleep' }), f('v-00000000f0e1', { name: 'Frontend', session: 'herdr-3d', base_session: 'herdr-3d', virtual: true }), f('herdr-3d', { hidden: true })];
    expect(baseSessions(floors)).toEqual([
      { session: 'herdr-3d', name: 'herdr-3d', asleep: false },
      { session: 'pastry', name: 'pastry', asleep: true },
    ]);
  });
});
