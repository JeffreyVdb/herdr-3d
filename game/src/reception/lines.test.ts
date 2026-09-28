import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../net/protocol';
import { WorldStore } from '../world/store';
import { receptionContext } from './context';
import { COOLDOWN_MS, LINE_KINDS, LineBook, nudgeBubble, parseLines, plainText, timeOfDay, type ReceptionContext, type VoiceLine } from './lines';
import { RECEPTIONIST_LINES } from './manifest';

const at = (h: number, m = 0) => new Date(2026, 8, 28, h, m, 0);

const floor = (session: string, state: 'running' | 'asleep' = 'running', needsYou = 0) => ({ session, name: session, state, needsYou });

const ctx = (now: Date, floors: ReceptionContext['floors'] = [floor('top'), floor('bottom')]): ReceptionContext => ({
  now,
  building: { id: 'b1', name: 'Work' },
  floors,
});

/** Two variants of every kind, ids `<kind>-a|b`. */
const LINES: VoiceLine[] = LINE_KINDS.flatMap((kind) => ['a', 'b'].map((v) => ({ id: `${kind}-${v}`, kind, text: `(Happy) ${kind} ${v}!` })));

/** Cycles through fixed values in [0, 1). */
const seq = (...xs: number[]) => {
  let i = 0;
  return () => xs[i++ % xs.length] ?? 0;
};

describe('timeOfDay', () => {
  it.each([
    [5, 0, 'morning'],
    [11, 59, 'morning'],
    [12, 0, 'afternoon'],
    [16, 59, 'afternoon'],
    [17, 0, 'evening'],
    [21, 59, 'evening'],
    [22, 0, 'night'],
    [0, 0, 'night'],
    [4, 59, 'night'],
  ] as const)('%i:%i is %s', (h, m, want) => {
    expect(timeOfDay(at(h, m))).toBe(want);
  });
});

describe('plainText', () => {
  it('drops style and inline tags, keeps the words', () => {
    expect(plainText('(Happy) Good morning! Welcome in.')).toBe('Good morning! Welcome in.');
    expect(plainText('(Calm) Shh... the whole building [chuckle] is napping (pauses for a moment) .')).toBe('Shh... the whole building is napping.');
    expect(plainText('（Lively）Hi!')).toBe('Hi!');
  });
});

describe('LineBook', () => {
  it('welcomes by the local time of day', () => {
    for (const [h, kind] of [
      [8, 'welcome-morning'],
      [13, 'welcome-afternoon'],
      [19, 'welcome-evening'],
      [23, 'welcome-night'],
      [3, 'welcome-night'],
    ] as const) {
      const said = new LineBook(LINES, () => 0).handle('arrive-street', ctx(at(h)));
      expect(said.map((s) => s.kind)).toEqual([kind]);
      expect(said[0]).toMatchObject({ id: `${kind}-a`, text: `${kind} a!`, bubble: `${kind} a!` });
    }
  });

  it('follows the welcome with a nudge when a floor needs you, with live details in the bubble only', () => {
    const said = new LineBook(LINES, () => 0).handle('arrive-street', ctx(at(9), [floor('herdr-3d', 'running', 2), floor('pastry', 'running', 1), floor('lab', 'asleep')]));
    expect(said.map((s) => s.kind)).toEqual(['welcome-morning', 'nudge']);
    expect(said[1]).toMatchObject({ id: 'nudge-a', text: 'nudge a!', bubble: 'Waiting on you: 2 on herdr-3d and 1 on pastry.' });
  });

  it('says the building is quiet (instead of a nudge) when every floor is asleep', () => {
    const book = new LineBook(LINES, () => 0);
    expect(book.handle('arrive-street', ctx(at(14), [floor('a', 'asleep'), floor('b', 'asleep')])).map((s) => s.kind)).toEqual(['welcome-afternoon', 'quiet']);
    // One floor awake, nobody waiting: just the welcome.
    const other = new LineBook(LINES, () => 0);
    expect(other.handle('arrive-street', ctx(at(14), [floor('a', 'asleep'), floor('b')])).map((s) => s.kind)).toEqual(['welcome-afternoon']);
  });

  it('has short lines for the elevator, the goodbye and the desk', () => {
    const book = new LineBook(LINES, () => 0);
    expect(book.handle('arrive-elevator', ctx(at(10))).map((s) => s.kind)).toEqual(['elevator']);
    expect(book.handle('leave-front', ctx(at(10))).map((s) => s.kind)).toEqual(['goodbye']);
    expect(book.handle('interact', ctx(at(10))).map((s) => s.kind)).toEqual(['interact']);
  });

  it('never repeats the previous variant of a kind', () => {
    const lines = ['1', '2', '3'].map((v) => ({ id: `interact-${v}`, kind: 'interact' as const, text: v }));
    // The RNG keeps asking for the first candidate: each pick must still differ from the last.
    const book = new LineBook([...LINES.filter((l) => l.kind !== 'interact'), ...lines], () => 0);
    const ids = Array.from({ length: 12 }, () => book.handle('interact', ctx(at(10)))[0]?.id);
    for (let i = 1; i < ids.length; i++) expect(ids[i]).not.toBe(ids[i - 1]);
    expect(new Set(ids).size).toBeGreaterThan(1);
    // Random picks from 3: still never twice in a row.
    const rnd = new LineBook([...LINES.filter((l) => l.kind !== 'interact'), ...lines], seq(0.9, 0.1, 0.5, 0.99, 0.3, 0.7, 0.2));
    const r = Array.from({ length: 30 }, () => rnd.handle('interact', ctx(at(10)))[0]?.id);
    for (let i = 1; i < r.length; i++) expect(r[i]).not.toBe(r[i - 1]);
  });

  it('keeps one variant working when a kind has only one', () => {
    const one = LINES.filter((l) => l.id !== 'goodbye-b');
    const book = new LineBook(one, () => 0.99);
    const t = at(10).getTime();
    expect(book.handle('leave-front', ctx(new Date(t)))[0]?.id).toBe('goodbye-a');
    expect(book.handle('leave-front', ctx(new Date(t + COOLDOWN_MS)))[0]?.id).toBe('goodbye-a');
  });

  it('holds greetings and goodbyes back for two minutes, each on its own', () => {
    const book = new LineBook(LINES, () => 0);
    const t0 = at(10).getTime();
    const when = (ms: number) => ctx(new Date(t0 + ms));
    expect(book.handle('arrive-street', when(0))).toHaveLength(1);
    expect(book.cooldownUntil('greeting', t0)).toBe(t0 + COOLDOWN_MS);
    // Walking straight back out: the goodbye has its own cooldown, so it still plays once.
    expect(book.handle('leave-front', when(5_000))).toHaveLength(1);
    // In and out again inside the two minutes: silence.
    expect(book.handle('arrive-street', when(20_000))).toEqual([]);
    expect(book.handle('arrive-elevator', when(30_000))).toEqual([]);
    expect(book.handle('leave-front', when(40_000))).toEqual([]);
    // Once it runs out, greetings come back.
    expect(book.cooldownUntil('greeting', t0 + COOLDOWN_MS)).toBeNull();
    expect(book.handle('arrive-street', when(COOLDOWN_MS))).toHaveLength(1);
    expect(book.handle('leave-front', when(COOLDOWN_MS + 4_000))).toEqual([]);
    expect(book.handle('leave-front', when(COOLDOWN_MS + 5_000))).toHaveLength(1);
  });

  it('answers at the desk even inside a cooldown, and the desk does not start one', () => {
    const book = new LineBook(LINES, () => 0);
    const t0 = at(10).getTime();
    expect(book.handle('interact', ctx(new Date(t0)))).toHaveLength(1);
    expect(book.cooldownUntil('greeting', t0)).toBeNull();
    expect(book.handle('arrive-street', ctx(new Date(t0 + 1_000)))).toHaveLength(1);
    for (let i = 2; i < 6; i++) expect(book.handle('interact', ctx(new Date(t0 + i * 1_000))).map((s) => s.kind)).toEqual(['interact']);
  });
});

describe('nudgeBubble', () => {
  it('lists up to three floors, then a count of the rest', () => {
    expect(nudgeBubble([floor('a', 'running', 1)])).toBe('Waiting on you: 1 on a.');
    expect(nudgeBubble([floor('a', 'running', 1), floor('b'), floor('c', 'running', 4), floor('d', 'running', 2), floor('e', 'running', 1), floor('f', 'running', 3)])).toBe(
      'Waiting on you: 1 on a, 4 on c, 2 on d and 2 more floors.',
    );
  });

  it('is built from a fixture snapshot through the store', () => {
    const line = readFileSync(join(import.meta.dirname, '../../fixtures/demo-m3.jsonl'), 'utf8').split('\n')[0] ?? '';
    const store = new WorldStore(1000);
    store.applySnapshot(JSON.parse(line) as Snapshot);
    const work = [...store.buildings.values()].find((b) => b.name === 'Work');
    expect(work).toBeDefined();
    const c = receptionContext(store, work?.id ?? null, at(9));
    expect(c.building).toEqual({ id: work?.id, name: 'Work' });
    expect(c.floors).toEqual([
      { session: 'herdr-3d', name: 'herdr-3d', state: 'running', needsYou: 3 },
      { session: 'depot-manager', name: 'depot-manager', state: 'asleep', needsYou: 0 },
    ]);
    const said = new LineBook(RECEPTIONIST_LINES, () => 0).handle('arrive-street', c);
    expect(said.map((s) => s.kind)).toEqual(['welcome-morning', 'nudge']);
    expect(said[1]?.bubble).toBe('Waiting on you: 3 on herdr-3d.');
    // The audio stays generic: no floor names in what is spoken.
    for (const l of RECEPTIONIST_LINES.filter((x) => x.kind === 'nudge')) expect(l.text).not.toMatch(/herdr|infra|pastry/);
  });

  it('says quiet for the unassigned lot of a fully asleep fixture', () => {
    const line = readFileSync(join(import.meta.dirname, '../../fixtures/demo-m3.jsonl'), 'utf8').split('\n')[0] ?? '';
    const snap = JSON.parse(line) as Snapshot;
    for (const f of snap.world.floors) f.state = 'asleep';
    const store = new WorldStore(1000);
    store.applySnapshot(snap);
    const c = receptionContext(store, null, at(23));
    expect(c.building.id).toBeNull();
    expect(c.floors.map((f) => f.session)).toEqual(['scratchpad']);
    expect(new LineBook(RECEPTIONIST_LINES, () => 0).handle('arrive-street', c).map((s) => s.kind)).toEqual(['welcome-night', 'quiet']);
  });
});

describe('the receptionist manifest', () => {
  it('parses, with a few variants of every kind', () => {
    for (const k of LINE_KINDS) expect(RECEPTIONIST_LINES.filter((l) => l.kind === k).length).toBeGreaterThanOrEqual(2);
  });

  it('rejects broken manifests', () => {
    expect(() => parseLines({})).toThrow(/lines/);
    expect(() => parseLines({ lines: [{ id: 'Bad Id', kind: 'goodbye', text: 'x' }] })).toThrow(/bad id/);
    expect(() => parseLines({ lines: [{ id: 'a', kind: 'shout', text: 'x' }] })).toThrow(/bad kind/);
    expect(() => parseLines({ lines: [{ id: 'a', kind: 'goodbye', text: '(Happy)' }] })).toThrow(/empty text/);
    expect(() => parseLines({ lines: LINES.slice(2) })).toThrow(/no line of kind welcome-morning/);
    expect(() => parseLines({ lines: [...LINES, LINES[0]] })).toThrow(/duplicate/);
  });
});
