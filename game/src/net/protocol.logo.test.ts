import { describe, expect, it } from 'vitest';
import { isSnapshot, isWorldEvent, logoHashOf, parseMessage, type WorldEvent } from './protocol';

const hash = 'f'.repeat(64);
const building = { id: 'b1', name: 'Work', sort: 0, floors: [] as string[] };

describe('the logo field of a building (M3d)', () => {
  it('a building.upsert with or without a logo is a world event', () => {
    for (const b of [building, { ...building, logo: hash }, { ...building, logo: 42 }, { ...building, logo: null }]) {
      const m = parseMessage(JSON.stringify({ t: 'building.upsert', seq: 3, building: b }));
      expect(m && isWorldEvent(m)).toBe(true);
    }
  });
  it('a snapshot with logos is a snapshot', () => {
    const m = parseMessage(JSON.stringify({ t: 'world.snapshot', seq: 1, world: { buildings: [{ ...building, logo: hash }], floors: [], workers: [] } }));
    expect(m && isSnapshot(m)).toBe(true);
  });
  it('reads the hash only when it is a hex string', () => {
    expect(logoHashOf({ logo: hash })).toBe(hash);
    expect(logoHashOf({ logo: 'ABCDEF0123456789' })).toBe('ABCDEF0123456789');
    expect(logoHashOf({})).toBeNull();
    expect(logoHashOf(null)).toBeNull();
    expect(logoHashOf(undefined)).toBeNull();
    for (const odd of [42, '', 'xyz', 'abc', hash + '!', null, {}, []]) expect(logoHashOf({ logo: odd as never })).toBeNull();
  });
  it('the event carries the logo through as sent', () => {
    const m = parseMessage(JSON.stringify({ t: 'building.upsert', seq: 3, building: { ...building, logo: hash } })) as WorldEvent;
    expect((m as { building: { logo?: string } }).building.logo).toBe(hash);
  });
});
