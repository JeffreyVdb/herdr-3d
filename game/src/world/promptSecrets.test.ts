import { describe, expect, it } from 'vitest';
import { SecretsSim } from '../../tools/fixture-secrets.ts';
import { isWorldEvent, parseMessage, type PromptSecretsScan, type Snapshot, type WorldEvent } from '../net/protocol';
import {
  hideRanges,
  kindsText,
  maskRanges,
  onBoundary,
  promptSecretsFailureText,
  PromptSecretsBook,
  promptSecretsStateOf,
  type Range,
  scanOf,
  SecretReview,
  stepPoint,
} from './promptSecrets';
import { WorldStore } from './store';

const snap = (world: Partial<Snapshot['world']>): Snapshot => ({ t: 'world.snapshot', seq: 1, world: { buildings: [], unassigned: [], floors: [], workers: [], ...world } });

/** The candidates of `text` at the given substrings (each its first occurrence after the previous one). */
function scanAt(text: string, values: string[], revision = 'rev-1'): PromptSecretsScan {
  let from = 0;
  return {
    revision,
    candidates: values.map((v, i) => {
      const start = text.indexOf(v, from);
      if (start < 0) throw new Error(`${v} not in text`);
      from = start + v.length;
      return { id: `c${i + 1}`, start, end: start + v.length, kinds: ['assignment'] };
    }),
  };
}

describe('#108 the "Review prompt secrets before sending" switch', () => {
  it('reads a well-formed switch only', () => {
    expect(promptSecretsStateOf({ enabled: true, available: false, extra: 1 })).toEqual({ enabled: true, available: false });
    expect(promptSecretsStateOf({ enabled: true })).toBeNull();
    expect(promptSecretsStateOf({ enabled: 'yes', available: true })).toBeNull();
    expect(promptSecretsStateOf(null)).toBeNull();
  });

  it('the book: null from an older bridge (off), upserts tell the listeners', () => {
    const b = new PromptSecretsBook();
    let heard = 0;
    b.onChange(() => heard++);
    b.reset(undefined);
    expect(b.state).toBeNull();
    expect(b.on).toBe(false);
    expect(b.upsert({ enabled: 1, available: true })).toBe(false);
    expect(b.upsert({ enabled: true, available: true })).toBe(true);
    expect(b.on).toBe(true);
    expect(heard).toBe(2);
  });

  it('the snapshot and prompt_secrets.update reach the store', () => {
    const s = new WorldStore();
    s.applySnapshot(snap({ prompt_secrets: { enabled: false, available: true } }));
    expect(s.promptSecrets.state).toEqual({ enabled: false, available: true });
    const e = parseMessage(JSON.stringify({ t: 'prompt_secrets.update', seq: 2, enabled: true, available: true }));
    expect(e && isWorldEvent(e)).toBe(true);
    s.applyEvent(e as WorldEvent);
    expect(s.promptSecrets.on).toBe(true);
    const bad = parseMessage(JSON.stringify({ t: 'prompt_secrets.update', seq: 3, enabled: true }));
    expect(bad && isWorldEvent(bad)).toBe(false);
    // A snapshot from an older bridge: no switch.
    s.applySnapshot(snap({}));
    expect(s.promptSecrets.state).toBeNull();
  });

  it('says why a command failed, never quoting the text', () => {
    expect(promptSecretsFailureText('unknown_command', 'x')).toMatch(/Update it/);
    expect(promptSecretsFailureText('secrets_unavailable', 'no private runtime directory')).toMatch(/can’t keep secrets in files/);
    expect(promptSecretsFailureText('secrets_review_off', '')).toMatch(/off/);
    expect(promptSecretsFailureText('offline', '')).toMatch(/Not connected/);
    expect(promptSecretsFailureText('internal', ' disk full ')).toBe('disk full');
  });
});

describe('#108 UTF-16 code point boundaries', () => {
  const text = 'a😀b\r\nc';
  it('a boundary is never between the halves of a surrogate pair', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => onBoundary(text, i))).toEqual([true, true, false, true, true, true, true, true]);
    expect(onBoundary(text, -1)).toBe(false);
    expect(onBoundary(text, text.length + 1)).toBe(false);
  });

  it('steps one code point at a time (an astral character is two units; CR and LF are one each)', () => {
    expect(stepPoint(text, 1, 1)).toBe(3);
    expect(stepPoint(text, 3, -1)).toBe(1);
    expect(stepPoint(text, 4, 1)).toBe(5);
    expect(stepPoint(text, 0, -1)).toBe(0);
    expect(stepPoint(text, text.length, 1)).toBe(text.length);
  });
});

describe('#108 a scan ack, read strictly', () => {
  const text = 'key=abc123 pw=😀xyz';
  const good = scanAt(text, ['abc123', '😀xyz']);

  it('keeps a well-formed scan (unknown keys dropped)', () => {
    expect(scanOf({ ...good, extra: 1 }, text)).toEqual(good);
    expect(scanOf({ revision: 'r', candidates: [] }, text)).toEqual({ revision: 'r', candidates: [] });
    const enc = scanOf({ revision: 'r', candidates: [{ id: 'c1', start: 4, end: 10, kinds: ['assignment'], encoded: true, x: 1 }] }, text);
    expect(enc?.candidates[0]).toEqual({ id: 'c1', start: 4, end: 10, kinds: ['assignment'], encoded: true });
  });

  it('refuses anything odd: overlaps, out of order, outside, split pairs, empty, duplicate ids, no revision', () => {
    const c = (start: number, end: number, id = 'c1') => ({ id, start, end, kinds: ['x'] });
    for (const bad of [
      null,
      { candidates: [] },
      { revision: '', candidates: [] },
      { revision: 'r' },
      { revision: 'r', candidates: [c(4, 10), c(8, 12, 'c2')] },
      { revision: 'r', candidates: [c(14, 19), c(4, 10, 'c2')] },
      { revision: 'r', candidates: [c(4, 99)] },
      { revision: 'r', candidates: [c(15, 19)] },
      { revision: 'r', candidates: [c(4, 4)] },
      { revision: 'r', candidates: [c(0, 1), c(2, 3)] },
      { revision: 'r', candidates: [{ id: 'c1', start: 0, end: 1, kinds: 'x' }] },
    ]) {
      expect(scanOf(bad, text), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('#108 a review', () => {
  it('starts with every candidate proposed for protection, in text order', () => {
    const text = 'token=ghp_1 and pw=hunter2';
    const r = new SecretReview(text, scanAt(text, ['ghp_1', 'hunter2']));
    expect(r.marks().map((m) => [m.key, m.state, text.slice(m.start, m.end)])).toEqual([
      ['c1', 'protect', 'ghp_1'],
      ['c2', 'protect', 'hunter2'],
    ]);
    expect(r.counts()).toEqual({ protect: 2, ignore: 0, manual: 0, found: 2 });
    expect(r.decisions()).toEqual([
      { candidate: 'c1', action: 'protect', start: 6, end: 11 },
      { candidate: 'c2', action: 'protect', start: 19, end: 26 },
    ]);
    expect(r.protectedRanges()).toEqual([{ start: 6, end: 11 }, { start: 19, end: 26 }]);
  });

  it('two identical values take different decisions; ignoring every one is a valid review', () => {
    const text = 'a=s3cr3t!\nb=s3cr3t!';
    const r = new SecretReview(text, scanAt(text, ['s3cr3t!', 's3cr3t!']));
    r.setState('c2', 'ignore');
    expect(r.decisions()).toEqual([
      { candidate: 'c1', action: 'protect', start: 2, end: 9 },
      { candidate: 'c2', action: 'ignore' },
    ]);
    expect(r.counts()).toEqual({ protect: 1, ignore: 1, manual: 0, found: 2 });
    r.setState('c1', 'ignore');
    expect(r.decisions()).toEqual([
      { candidate: 'c1', action: 'ignore' },
      { candidate: 'c2', action: 'ignore' },
    ]);
    expect(r.protectedRanges()).toEqual([]);
  });

  it('corrects a protected candidate’s edges by a code point, never into a neighbour or to nothing', () => {
    const text = 'x=😀ab.cd';
    // Adjacent candidates: "😀ab" then ".cd".
    const r = new SecretReview(text, scanAt(text, ['😀ab', '.cd']));
    const c1 = () => text.slice(r.get('c1')!.start, r.get('c1')!.end);
    expect(r.canNudge('c1', 'end', 1)).toBe(false); // the next one starts there
    expect(r.nudge('c1', 'end', 1)).toBe(false);
    expect(r.nudge('c1', 'start', -1)).toBe(true); // extends over "="
    expect(c1()).toBe('=😀ab');
    expect(r.nudge('c1', 'start', 1)).toBe(true);
    expect(r.nudge('c1', 'start', 1)).toBe(true); // over the astral character: two units
    expect(c1()).toBe('ab');
    expect(r.get('c1')!.start).toBe(4);
    expect(r.nudge('c1', 'end', -1)).toBe(true);
    expect(c1()).toBe('a');
    expect(r.canNudge('c1', 'end', -1)).toBe(false); // never empty
    expect(r.canNudge('c1', 'start', 1)).toBe(false);
    // The second can now take the "b" back.
    expect(r.nudge('c2', 'start', -1)).toBe(true);
    expect(text.slice(r.get('c2')!.start, r.get('c2')!.end)).toBe('b.cd');
    expect(r.canNudge('c2', 'end', 1)).toBe(false); // the end of the text
    expect(r.decisions()).toEqual([
      { candidate: 'c1', action: 'protect', start: 4, end: 5 },
      { candidate: 'c2', action: 'protect', start: 5, end: 9 },
    ]);
  });

  it('an ignored candidate keeps its found range: its edges are not corrected, and ignoring drops a correction', () => {
    const text = 'pw="abc";';
    const r = new SecretReview(text, scanAt(text, ['abc']));
    r.nudge('c1', 'end', 1);
    expect(r.get('c1')!.end).toBe(8);
    r.setState('c1', 'ignore');
    expect([r.get('c1')!.start, r.get('c1')!.end]).toEqual([4, 7]);
    expect(r.canNudge('c1', 'end', 1)).toBe(false);
    r.setState('c1', 'protect');
    expect([r.get('c1')!.start, r.get('c1')!.end]).toEqual([4, 7]);
  });

  it('marks selected text by hand (exact, snapped out of a surrogate pair), refuses overlaps and nothing, and unmarks', () => {
    const text = 'user bob pass 😀top and key=abc';
    const r = new SecretReview(text, scanAt(text, ['abc']));
    const at = text.indexOf('😀');
    // A selection that starts between the halves of the pair takes the whole character.
    const m = r.mark(at + 1, at + 5);
    expect(m).toEqual({ ok: true, key: 'm1' });
    expect(text.slice(r.get('m1')!.start, r.get('m1')!.end)).toBe('😀top');
    expect(r.mark(5, 5)).toEqual({ ok: false, reason: expect.stringMatching(/Select/) });
    expect(r.mark(at + 3, at + 8)).toEqual({ ok: false, reason: expect.stringMatching(/overlaps/) });
    expect(r.mark(text.length - 5, text.length - 1)).toEqual({ ok: false, reason: expect.stringMatching(/overlaps/) });
    // The ignored candidate is still in the way: an ignored occurrence stays exactly as typed.
    r.setState('c1', 'ignore');
    expect(r.mark(text.length - 2, text.length).ok).toBe(false);
    expect(r.mark(5, 8)).toEqual({ ok: true, key: 'm2' });
    expect(r.marks().map((x) => x.key)).toEqual(['m2', 'm1', 'c1']);
    expect(r.counts()).toEqual({ protect: 2, ignore: 1, manual: 2, found: 1 });
    expect(r.decisions()).toEqual([
      { action: 'protect', start: 5, end: 8 },
      { action: 'protect', start: at, end: at + 5 },
      { candidate: 'c1', action: 'ignore' },
    ]);
    // A manual mark's edges move too; it can be taken away again, a candidate cannot.
    expect(r.nudge('m2', 'start', -1)).toBe(true);
    expect(r.unmark('c1')).toBe(false);
    expect(r.unmark('m2')).toBe(true);
    expect(r.get('m2')).toBeNull();
    expect(r.counts().manual).toBe(1);
  });

  it('a review with only manual marks (no candidates) carries the clean scan’s revision', () => {
    const text = 'the code is 4815';
    const r = new SecretReview(text, { revision: 'clean', candidates: [] });
    expect(r.decisions()).toEqual([]);
    r.mark(12, 16);
    expect(r.review()).toEqual({ revision: 'clean', decisions: [{ action: 'protect', start: 12, end: 16 }] });
  });

  it('a new scan of the same text takes the earlier choices over where the candidate is the same', () => {
    const text = 'a=one1 b=two2 c=three3';
    const first = new SecretReview(text, scanAt(text, ['one1', 'two2']));
    first.setState('c1', 'ignore');
    first.nudge('c2', 'start', -1);
    first.mark(text.indexOf('three3'), text.length);
    // The rules changed: three3 is a candidate now, and the old manual mark over it is dropped.
    const again = new SecretReview(text, scanAt(text, ['one1', 'two2', 'three3'], 'rev-2'), first);
    expect(again.revision).toBe('rev-2');
    expect(again.decisions()).toEqual([
      { candidate: 'c1', action: 'ignore' },
      { candidate: 'c2', action: 'protect', start: 8, end: 13 },
      { candidate: 'c3', action: 'protect', start: 16, end: 22 },
    ]);
    // Another text takes nothing over.
    const other = new SecretReview(`${text}!`, scanAt(`${text}!`, ['one1']), first);
    expect(other.decisions()).toEqual([{ candidate: 'c1', action: 'protect', start: 2, end: 6 }]);
  });
});

/**
 * What must hold after every operation on a review (#108 C1): the marks sorted, non-empty, apart and on code point
 * boundaries, an ignored candidate on its found range, the prompt drawn from them exactly as typed, and decisions the
 * bridge accepts (protected ranges and ignored candidates' found ranges never overlap). The first fault, or null.
 */
function fault(r: SecretReview): string | null {
  const marks = r.marks();
  let end = 0;
  for (const m of marks) {
    if (!(m.start < m.end && m.start >= end)) return `${m.key} [${m.start},${m.end}) after ${end}`;
    if (!onBoundary(r.text, m.start) || !onBoundary(r.text, m.end)) return `${m.key} splits a pair`;
    if (m.state === 'ignore' && (m.start !== m.found?.start || m.end !== m.found.end)) return `ignored ${m.key} not as found`;
    end = m.end;
  }
  // The dialog draws each text run, then each mark's own slice: an overlap would draw a character twice.
  let drawn = '';
  let from = 0;
  for (const m of marks) {
    drawn += r.text.slice(from, m.start) + r.text.slice(m.start, m.end);
    from = m.end;
  }
  if (drawn + r.text.slice(from) !== r.text) return `drawn as ${JSON.stringify(drawn + r.text.slice(from))}`;
  const found = new Map(marks.filter((m) => m.found).map((m) => [m.candidate, m.found as Range]));
  const ranges = r
    .decisions()
    .map((d) => (d.start !== undefined && d.end !== undefined ? { start: d.start, end: d.end } : (found.get(d.candidate ?? null) as Range)))
    .sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) if ((ranges[i - 1] as Range).end > (ranges[i] as Range).start) return `decisions overlap at ${(ranges[i] as Range).start}`;
  // The command log masks, and the pending row hides, by `protectedRanges()`: exactly the protected marks' code units.
  const own = marks.filter((m) => m.state === 'protect').sort((a, b) => a.start - b.start);
  let masked = '';
  let hidden = '';
  from = 0;
  for (const m of own) {
    masked += r.text.slice(from, m.start) + '•'.repeat(m.end - m.start);
    hidden += `${r.text.slice(from, m.start)}[secret]`;
    from = m.end;
  }
  if (maskRanges(r.text, r.protectedRanges()) !== masked + r.text.slice(from)) return `masked as ${JSON.stringify(maskRanges(r.text, r.protectedRanges()))}`;
  if (hideRanges(r.text, r.protectedRanges()) !== hidden + r.text.slice(from)) return `pending row ${JSON.stringify(hideRanges(r.text, r.protectedRanges()))}`;
  return null;
}

const expectSound = (r: SecretReview, at = '') => expect(fault(r), at).toBeNull();

/** The fixture's bridge with the switch on (its check is the bridge's, docs/protocol.md "Prompt secrets"): its scan of `text`, and what it makes of a review. */
function simBridge(text: string) {
  const sim = new SecretsSim({ emit: () => {}, error: (code, message) => Object.assign(new Error(message), { code }), takeFailure: () => false }, { on: true });
  let ack: unknown;
  sim.handle('prompt_secrets.scan', { text }, () => {}, (d) => (ack = d));
  const scan = scanOf(ack, text);
  if (!scan) throw new Error('no scan');
  return { scan, send: (r: SecretReview) => sim.prompt({ id: 'w1', text, secrets: r.review() }, 'w1', () => {})?.extra };
}

describe('#108 C1: no transition makes two marks overlap', () => {
  // token=abcdef: c1 is abcdef, [6, 12).
  const text = 'token=abcdef';

  it('a candidate whose end was shrunk, the freed character marked by hand: Ignore is refused (the mark is named), the prompt still as typed', () => {
    const r = new SecretReview(text, scanAt(text, ['abcdef']));
    expect(r.nudge('c1', 'end', -1)).toBe(true);
    expect(r.mark(11, 12)).toEqual({ ok: true, key: 'm1' });
    expect(r.ignoreBlocker('c1')?.key).toBe('m1');
    expect(r.setState('c1', 'ignore')).toBe(false);
    expect(r.get('c1')).toMatchObject({ state: 'protect', start: 6, end: 11 });
    expectSound(r, 'refused');
    expect(r.decisions()).toEqual([
      { candidate: 'c1', action: 'protect', start: 6, end: 11 },
      { action: 'protect', start: 11, end: 12 },
    ]);
    // The mark taken away, Ignore puts the candidate back on its found range.
    expect(r.unmark('m1')).toBe(true);
    expect(r.ignoreBlocker('c1')).toBeNull();
    expect(r.setState('c1', 'ignore')).toBe(true);
    expect(r.decisions()).toEqual([{ candidate: 'c1', action: 'ignore' }]);
    expectSound(r, 'ignored');
  });

  it('the same with the start: shrunk, the freed character marked before it', () => {
    const r = new SecretReview(text, scanAt(text, ['abcdef']));
    expect(r.nudge('c1', 'start', 1)).toBe(true);
    expect(r.mark(6, 7).ok).toBe(true);
    expect(r.ignoreBlocker('c1')?.key).toBe('m1');
    expect(r.setState('c1', 'ignore')).toBe(false);
    expectSound(r);
  });

  it('a mark that covers the freed character and more (either side) is in the way too; one beside the found range is not', () => {
    const t = 'say token=abcdef now';
    const r = new SecretReview(t, scanAt(t, ['abcdef']));
    r.nudge('c1', 'end', -1);
    r.nudge('c1', 'start', 1);
    expect(r.mark(15, 19).ok).toBe(true); // "f no"
    expect(r.setState('c1', 'ignore')).toBe(false);
    r.unmark('m1');
    expect(r.mark(4, 11).ok).toBe(true); // "token=a"
    expect(r.ignoreBlocker('c1')?.key).toBe('m2');
    expect(r.setState('c1', 'ignore')).toBe(false);
    r.unmark('m2');
    expect(r.mark(16, 20).ok).toBe(true); // " now": beside it
    expect(r.mark(0, 3).ok).toBe(true);
    expect(r.ignoreBlocker('c1')).toBeNull();
    expect(r.setState('c1', 'ignore')).toBe(true);
    expectSound(r);
  });

  it('another candidate corrected into the found range is in the way, on either side; ignoring that one first frees it', () => {
    // c1 abcdef [6, 12), c2 x9 [13, 15).
    const t = 'token=abcdef x9';
    const r = new SecretReview(t, scanAt(t, ['abcdef', 'x9']));
    r.nudge('c1', 'end', -1);
    r.nudge('c2', 'start', -1);
    r.nudge('c2', 'start', -1);
    expect(r.get('c2')).toMatchObject({ start: 11, end: 15 });
    expect(r.ignoreBlocker('c1')?.key).toBe('c2');
    expect(r.setState('c1', 'ignore')).toBe(false);
    expectSound(r, 'c2 in the way');
    // c2 ignored goes back to [13, 15): c1 can be ignored now.
    expect(r.setState('c2', 'ignore')).toBe(true);
    expect(r.setState('c1', 'ignore')).toBe(true);
    expectSound(r, 'both ignored');
    // The other side: c2's start shrunk, c1's end extended into it.
    const s = new SecretReview(t, scanAt(t, ['abcdef', 'x9']));
    s.nudge('c2', 'start', 1);
    s.nudge('c1', 'end', 1);
    s.nudge('c1', 'end', 1);
    expect(s.get('c1')).toMatchObject({ start: 6, end: 14 });
    expect(s.ignoreBlocker('c2')?.key).toBe('c1');
    expect(s.setState('c2', 'ignore')).toBe(false);
    expectSound(s, 'c1 in the way');
  });

  it('restoring an ignored candidate puts it on its found range, and while ignored nothing can move into it', () => {
    const t = 'token=abcdef x9';
    const r = new SecretReview(t, scanAt(t, ['abcdef', 'x9']));
    r.setState('c1', 'ignore');
    expect(r.mark(11, 13).ok).toBe(false);
    r.nudge('c2', 'start', -1);
    expect(r.nudge('c2', 'start', -1)).toBe(false);
    expect(r.canNudge('c2', 'start', -1)).toBe(false);
    expect(r.setState('c1', 'protect')).toBe(true);
    expect(r.get('c1')).toMatchObject({ start: 6, end: 12 });
    expectSound(r);
  });

  it('a stale review taken over keeps the shrunk candidate and the mark beside it, and Ignore stays refused there', () => {
    const first = new SecretReview(text, scanAt(text, ['abcdef']));
    first.nudge('c1', 'end', -1);
    first.mark(11, 12);
    const again = new SecretReview(text, scanAt(text, ['abcdef'], 'rev-2'), first);
    expectSound(again, 'taken over');
    expect(again.decisions()).toEqual([
      { candidate: 'c1', action: 'protect', start: 6, end: 11 },
      { action: 'protect', start: 11, end: 12 },
    ]);
    expect(again.setState('c1', 'ignore')).toBe(false);
    // Ignored earlier, a candidate comes back ignored, and a mark over it is not taken over.
    const ign = new SecretReview(text, scanAt(text, ['abcdef']));
    ign.setState('c1', 'ignore');
    const back = new SecretReview(text, scanAt(text, ['abcdef'], 'rev-2'), ign);
    expect(back.decisions()).toEqual([{ candidate: 'c1', action: 'ignore' }]);
    expectSound(back);
  });

  it('random sequences of every operation, a new scan taking the review over among them, never break it', () => {
    // Room around most candidates (a range can move well clear of where it was found), two adjacent ones, CRLF and
    // astral characters.
    const t = 'export TOKEN=ghp_A1b2😀 now\r\npw="hunter2"; key=abc.def and x9 then 😀😀 here, same: hunter2 at the end';
    const values = ['ghp_A1b2😀', 'hunter2', 'abc', '.def', 'x9', 'hunter2'];
    // A small deterministic generator (mulberry32): the same sequences every run.
    let seed = 108;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    for (let run = 0; run < 200; run++) {
      let r = new SecretReview(t, scanAt(t, values));
      const ops: string[] = [];
      // Most operations are on one mark at a time, so a run of them takes it somewhere.
      let k = 'c1';
      for (let n = 0; n < 60; n++) {
        const keys = r.marks().map((m) => m.key);
        if (!keys.includes(k) || rand() < 0.2) k = pick(keys.length ? keys : ['c1']);
        const op = pick(['nudge', 'run', 'drift', 'drift', 'gap', 'gap', 'mark', 'unmark', 'ignore', 'ignore', 'protect', 'rescan']);
        if (op === 'nudge' || op === 'run') {
          const edge = pick(['start', 'end'] as const);
          const dir = pick([1, -1] as const);
          const times = op === 'run' ? int(2, 8) : 1;
          for (let i = 0; i < times; i++) r.nudge(k, edge, dir);
          ops.push(`${times}x nudge ${k} ${edge} ${dir}`);
        } else if (op === 'drift') {
          // The whole range moves (its leading edge first, then the trailing one, a little further sometimes): far
          // enough, it lies clear of its found range.
          const dir = pick([1, -1] as const);
          const lead = dir > 0 ? 'end' : 'start';
          const trail = dir > 0 ? 'start' : 'end';
          const by = int(1, 10);
          const more = int(0, 2);
          for (let i = 0; i < by; i++) r.nudge(k, lead, dir);
          for (let i = 0; i < by + more; i++) r.nudge(k, trail, dir);
          ops.push(`drift ${k} ${dir} by ${by}+${more}`);
        } else if (op === 'gap') {
          // A mark between a corrected candidate and its found range, or over the part of that range it gave up.
          const moved = r.marks().filter((m) => m.found && (m.start !== m.found.start || m.end !== m.found.end));
          const m = moved.find((x) => x.key === k) ?? (moved.length ? pick(moved) : null);
          const f = m?.found;
          if (!m || !f) continue;
          k = m.key;
          const room = [
            [f.end, m.start],
            [m.end, f.start],
            [f.start, Math.min(f.end, m.start)],
            [Math.max(f.start, m.end), f.end],
          ].filter(([a, b]) => (a as number) < (b as number));
          if (!room.length) continue;
          const [a, b] = pick(room) as [number, number];
          const s = int(a, b - 1);
          const e = Math.min(b, s + int(1, 3));
          r.mark(s, e);
          ops.push(`mark ${s} ${e} (by ${m.key})`);
        } else if (op === 'mark') {
          const a = Math.floor(rand() * (t.length + 1));
          const b = Math.min(t.length, a + 1 + Math.floor(rand() * 4));
          r.mark(a, b);
          ops.push(`mark ${a} ${b}`);
        } else if (op === 'unmark') {
          r.unmark(k);
          ops.push(`unmark ${k}`);
        } else if (op === 'rescan') {
          // The bridge said stale: the same text scanned again (sometimes with a candidate less), the choices taken over.
          const vs = rand() < 0.5 ? values : values.filter((_, i) => i !== 2);
          const scan = scanAt(t, vs, `rev-${run}-${n}`);
          const before = choices(r);
          const same = sameFound(r, scan);
          r = new SecretReview(t, scan, r);
          ops.push(`rescan ${vs.length}`);
          // #108 A1: the same candidates found again take every earlier choice over, exactly (a sound review fits as it was).
          if (same && JSON.stringify(choices(r)) !== JSON.stringify(before)) expect(choices(r), `run ${run}: ${ops.join(', ')}`).toEqual(before);
        } else {
          r.setState(k, op as 'ignore' | 'protect');
          ops.push(`${op} ${k}`);
        }
        const bad = fault(r);
        if (bad) expect(bad, `run ${run}: ${ops.join(', ')}`).toBeNull();
      }
    }
    // 12,000 checked steps: a fraction of a second alone, more under a loaded `make test`.
  }, 20_000);
});

/** Every choice of a review, by where its candidate was found (ids change between scans), manual marks by range. */
const choices = (r: SecretReview) => r.marks().map((m) => [m.found ? `found ${m.found.start}-${m.found.end}` : 'manual', m.start, m.end, m.state]);
/** `scan` finds exactly the candidates `r` was made of. */
const sameFound = (r: SecretReview, scan: PromptSecretsScan) =>
  JSON.stringify(scan.candidates.map((c) => [c.start, c.end])) ===
  JSON.stringify(
    r
      .marks()
      .filter((m) => m.found)
      .map((m) => [m.found?.start, m.found?.end])
      .sort((a, b) => (a[0] as number) - (b[0] as number)),
  );

describe('#108 A1: a stale review taken over keeps every earlier choice that still fits', () => {
  const order = (r: SecretReview) => r.marks().map((m) => [m.key, m.start, m.end, m.state]);

  it('a mark over the character a shrunk start freed stays (the correction is placed before the mark)', () => {
    const text = 'token=abcdef xyz';
    const first = new SecretReview(text, scanAt(text, ['abcdef']));
    expect(first.nudge('c1', 'start', 1)).toBe(true);
    expect(first.mark(6, 7)).toEqual({ ok: true, key: 'm1' });
    const again = new SecretReview(text, scanAt(text, ['abcdef'], 'rev-2'), first);
    expectSound(again, 'taken over');
    expect(order(again)).toEqual([
      ['m1', 6, 7, 'protect'],
      ['c1', 7, 12, 'protect'],
    ]);
  });

  it('a correction extended into the room a neighbour’s correction freed stays (every correction is placed at once)', () => {
    // c1 abcd [2, 6) and c2 efgh [6, 10) touch: c2 gives up its first character, c1 takes it.
    const text = 'k=abcdefgh;';
    const first = new SecretReview(text, scanAt(text, ['abcd', 'efgh']));
    expect(first.nudge('c2', 'start', 1)).toBe(true);
    expect(first.nudge('c1', 'end', 1)).toBe(true);
    const again = new SecretReview(text, scanAt(text, ['abcd', 'efgh'], 'rev-2'), first);
    expectSound(again, 'taken over');
    expect(order(again)).toEqual([
      ['c1', 2, 7, 'protect'],
      ['c2', 7, 10, 'protect'],
    ]);
  });

  it('what no longer fits goes back, and what that frees is taken again (a fixpoint): a new candidate wins its found range', () => {
    // Earlier: c1 abcd and c2 efgh each took the space after it, and xy was marked by hand.
    const text = 'k=abcd efgh xy;';
    const first = new SecretReview(text, scanAt(text, ['abcd', 'efgh']));
    expect(first.nudge('c1', 'end', 1)).toBe(true); // [2, 7): the space
    expect(first.nudge('c2', 'end', 1)).toBe(true); // [7, 12): the space after efgh
    expect(first.mark(12, 14)).toEqual({ ok: true, key: 'm1' }); // xy
    // The rules changed: the space after abcd is no candidate, but " efgh" is found from the space on, and xy too.
    const scan: PromptSecretsScan = {
      revision: 'rev-2',
      candidates: [
        { id: 'c1', start: 2, end: 6, kinds: ['assignment'] },
        { id: 'c2', start: 6, end: 11, kinds: ['assignment'] },
        { id: 'c3', start: 12, end: 14, kinds: ['assignment'] },
      ],
    };
    const again = new SecretReview(text, scan, first);
    expectSound(again, 'taken over');
    // c1's correction overlaps the new c2 (found from the space): back to its found range. c2 is new (its found range
    // differs): proposed as found. The manual mark over xy overlaps the new c3: not taken over.
    expect(order(again)).toEqual([
      ['c1', 2, 6, 'protect'],
      ['c2', 6, 11, 'protect'],
      ['c3', 12, 14, 'protect'],
    ]);
  });
});

describe('#108 C1 (review pass 2): a match ignored far from its correction goes back into text order', () => {
  // token=abcdef xyz: c1 is abcdef, [6, 12) (the fixture's detector finds it too).
  const text = 'token=abcdef xyz';

  /** c1 moved clear past its found range, onto the x: [13, 14), the space between them free. */
  const movedPast = (r: SecretReview) => {
    expect(r.nudge('c1', 'end', 1)).toBe(true);
    expect(r.nudge('c1', 'end', 1)).toBe(true);
    for (let i = 0; i < 7; i++) expect(r.nudge('c1', 'start', 1)).toBe(true);
    expect(r.get('c1')).toMatchObject({ start: 13, end: 14 });
  };
  const order = (r: SecretReview) => r.marks().map((m) => [m.key, m.start, m.end, m.state]);

  it('the review’s sequence: the space marked, Ignore passes over it; drawn as typed, the pending row masks both, no edge overlaps after, and the bridge takes it', () => {
    const bridge = simBridge(text);
    expect(bridge.scan.candidates).toEqual([{ id: 'c1', start: 6, end: 12, kinds: ['assignment'] }]);
    const r = new SecretReview(text, bridge.scan);
    movedPast(r);
    expect(r.mark(12, 13)).toEqual({ ok: true, key: 'm1' });
    expect(order(r)).toEqual([
      ['m1', 12, 13, 'protect'],
      ['c1', 13, 14, 'protect'],
    ]);
    // Nothing covers the found range: Ignore is allowed, and c1 goes back before the mark it passed.
    expect(r.ignoreBlocker('c1')).toBeNull();
    expect(r.setState('c1', 'ignore')).toBe(true);
    expect(order(r)).toEqual([
      ['c1', 6, 12, 'ignore'],
      ['m1', 12, 13, 'protect'],
    ]);
    expectSound(r, 'ignored');
    expect(r.setState('c1', 'protect')).toBe(true);
    expectSound(r, 'protected again');
    expect(r.protectedRanges()).toEqual([
      { start: 6, end: 12 },
      { start: 12, end: 13 },
    ]);
    expect(hideRanges(text, r.protectedRanges())).toBe('token=[secret][secret]xyz');
    expect(maskRanges(text, r.protectedRanges())).toBe('token=•••••••xyz');
    // Its end meets the mark now: neither edge moves into the other.
    expect(r.canNudge('c1', 'end', 1)).toBe(false);
    expect(r.nudge('c1', 'end', 1)).toBe(false);
    expect(r.nudge('m1', 'start', -1)).toBe(false);
    expect(r.decisions()).toEqual([
      { candidate: 'c1', action: 'protect', start: 6, end: 12 },
      { action: 'protect', start: 12, end: 13 },
    ]);
    expect(bridge.send(r)).toEqual({ protected: 2, sent: expect.stringMatching(/^token=\[secret in file [^\]]+\]\[secret in file [^\]]+\]xyz$/) });
  });

  it('a stale review taken over from there is in text order too, and Ignore works the same on it', () => {
    const first = new SecretReview(text, scanAt(text, ['abcdef']));
    movedPast(first);
    first.mark(12, 13);
    const again = new SecretReview(text, scanAt(text, ['abcdef'], 'rev-2'), first);
    expectSound(again, 'taken over');
    expect(order(again)).toEqual([
      ['m1', 12, 13, 'protect'],
      ['c1', 13, 14, 'protect'],
    ]);
    expect(again.setState('c1', 'ignore')).toBe(true);
    expect(order(again)).toEqual([
      ['c1', 6, 12, 'ignore'],
      ['m1', 12, 13, 'protect'],
    ]);
    expectSound(again, 'ignored');
  });
});

describe('#108 masking', () => {
  it('masks code unit for code unit (offsets still line up), or hides each range behind a word', () => {
    const text = 'k=😀ab x=cd';
    expect(maskRanges(text, [{ start: 2, end: 6 }, { start: 9, end: 11 }])).toBe('k=•••• x=••');
    expect(maskRanges(text, [])).toBe(text);
    expect(hideRanges(text, [{ start: 2, end: 6 }, { start: 9, end: 11 }])).toBe('k=[secret] x=[secret]');
  });

  it('names what found a candidate in plain words', () => {
    expect(kindsText(['assignment', 'gitleaks:github-pat'])).toBe('an assignment to a credential-like name; Gitleaks’ github-pat rule');
    expect(kindsText([])).toBe('marked by you');
    expect(kindsText(['repeat'])).toBe('the same value found elsewhere in the prompt');
  });
});
