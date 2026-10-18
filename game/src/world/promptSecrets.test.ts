import { describe, expect, it } from 'vitest';
import { isWorldEvent, parseMessage, type PromptSecretsScan, type Snapshot, type WorldEvent } from '../net/protocol';
import {
  hideRanges,
  kindsText,
  maskRanges,
  onBoundary,
  promptSecretsFailureText,
  PromptSecretsBook,
  promptSecretsStateOf,
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
