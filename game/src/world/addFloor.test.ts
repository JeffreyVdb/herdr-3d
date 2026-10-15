import { describe, expect, it } from 'vitest';
import { FLOOR_KINDS, newSessionNameError, MAX_SESSION_NAME } from './addFloor';

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
    expect(newSessionNameError('-h3dtest', taken)).toBe('The name cannot start with “-”.');
    for (const name of ['Upper', 'a.b', 'a/b', 'a b', 'émile', ' x']) expect(newSessionNameError(name, taken)).toBe('Use only lowercase letters, digits, “_” and “-”.');
    expect(newSessionNameError('x'.repeat(MAX_SESSION_NAME + 1), taken)).toBe(`Keep the name to at most ${MAX_SESSION_NAME} characters.`);
  });

  it('refuses a session the game already shows as a floor', () => {
    expect(newSessionNameError('pastry', taken)).toBe('“pastry” is already a floor.');
    expect(newSessionNameError('pastry2', taken)).toBe('');
  });

  it('lists the kinds the dialog offers, the new herdr session first', () => {
    expect(FLOOR_KINDS.map((k) => k.id)).toEqual(['session']);
  });
});
