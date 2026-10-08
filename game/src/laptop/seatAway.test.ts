import { describe, expect, it } from 'vitest';
import { awayNote, whyAway } from './seatAway';

const at = (session: string, pane_id: string | null = 'p1') => ({ worker: { session, pane_id } });

describe('whyAway (#187)', () => {
  it('is null for a worker on the floor with a terminal', () => {
    expect(whyAway('Nibble', at('lab'), 'lab', false)).toBeNull();
  });

  it('says a worker that left (or moved to another floor) is no longer on the floor', () => {
    expect(whyAway('Nibble', null, 'lab', false)).toBe('Nibble is no longer on the floor.');
    expect(whyAway('Nibble', at('other'), 'lab', false)).toBe('Nibble is no longer on the floor.');
  });

  it('says a sleeping floor is asleep, and a worker without a pane has no terminal', () => {
    expect(whyAway('Nibble', at('lab'), 'lab', true)).toBe('Nibble’s floor is asleep.');
    expect(whyAway('Nibble', at('lab', null), 'lab', false)).toBe('Nibble has no terminal right now.');
    expect(whyAway('Nibble', { worker: { session: 'lab' } }, 'lab', false)).toBe('Nibble has no terminal right now.');
  });

  it('tells the seat bar line that nothing is sent', () => {
    expect(awayNote('Nibble is no longer on the floor.')).toBe('Nibble is no longer on the floor. Nothing you type is sent.');
  });
});
