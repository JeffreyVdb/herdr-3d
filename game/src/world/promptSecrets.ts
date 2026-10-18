/**
 * #108 round 3: the "Review prompt secrets before sending" switch (`PromptSecretsBook`, the snapshot's
 * `prompt_secrets` and `prompt_secrets.update`) and a prompt's review as the game keeps it. Pure.
 *
 * A review (`SecretReview`) starts from a `prompt_secrets.scan` of the exact text `worker.prompt` will carry (the
 * composer's resolved text: image markers and file paths in place), so every range is UTF-16 code units of that
 * text, JavaScript's own string indexes. Each candidate is proposed for protection; the user ignores it, corrects
 * its edges a code point at a time, or marks text the scan missed. Ranges never overlap and never split a surrogate
 * pair (docs/protocol.md "Prompt secrets": the bridge checks the same and trusts nothing of this).
 */

import type { PromptSecretsScan, PromptSecretsState, SecretCandidate, SecretDecision, SecretsReview } from '../net/protocol';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** A well-formed switch (unknown keys dropped), else null. */
export function promptSecretsStateOf(v: unknown): PromptSecretsState | null {
  if (!isObj(v) || typeof v.enabled !== 'boolean' || typeof v.available !== 'boolean') return null;
  return { enabled: v.enabled, available: v.available };
}

/** The switch, and who listens for changes. */
export class PromptSecretsBook {
  private cur: PromptSecretsState | null = null;
  private readonly listeners = new Set<() => void>();

  /** null: an older bridge, without the switch. */
  get state(): PromptSecretsState | null {
    return this.cur;
  }

  /** Prompts are scanned and reviewed before they go (off, or an older bridge: today's sends). */
  get on(): boolean {
    return this.cur?.enabled === true;
  }

  reset(v: unknown): void {
    this.cur = promptSecretsStateOf(v);
    this.emit();
  }

  upsert(v: unknown): boolean {
    const next = promptSecretsStateOf(v);
    if (!next) return false;
    this.cur = next;
    this.emit();
    return true;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }
}

/** Plain words for a failed `prompt_secrets.*` command or a refused review. Never the text. */
export function promptSecretsFailureText(code: string, message: string): string {
  switch (code) {
    case 'unknown_command':
      return 'This bridge can’t review prompt secrets yet. Update it to use this.';
    case 'offline':
    case 'disconnected':
      return 'Not connected to herdr-world. Try again once it reconnects.';
    case 'timeout':
      return 'herdr-world did not answer in time. Try again.';
    case 'secrets_review_off':
      return 'Review prompt secrets was switched off meanwhile. Nothing was sent.';
    case 'secrets_review_stale':
      return 'The review no longer fits this prompt (the bridge’s rules or the switch changed, or it restarted). Nothing was sent.';
    case 'secrets_review_required':
      return 'The prompt has possible secrets the review did not cover. Nothing was sent.';
    case 'secrets_unavailable':
      return `herdr-world can’t keep secrets in files right now${message.trim() ? ` (${message.trim().replace(/[.:]\s*$/, '')})` : ''}. Nothing was sent.`;
    default:
      return message.trim() || code;
  }
}

// ---- UTF-16 code point boundaries ------------------------------------------------------------------------------

const high = (c: number) => c >= 0xd800 && c <= 0xdbff;
const low = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** `i` is in `[0, text.length]` and not between the halves of a surrogate pair. */
export function onBoundary(text: string, i: number): boolean {
  if (!isInt(i) || i < 0 || i > text.length) return false;
  return i === 0 || i === text.length || !(high(text.charCodeAt(i - 1)) && low(text.charCodeAt(i)));
}

/** The code point boundary one code point from boundary `i` in `dir`, clamped to the text. */
export function stepPoint(text: string, i: number, dir: 1 | -1): number {
  if (dir > 0) {
    if (i >= text.length) return text.length;
    return high(text.charCodeAt(i)) && low(text.charCodeAt(i + 1)) ? i + 2 : i + 1;
  }
  if (i <= 0) return 0;
  return low(text.charCodeAt(i - 1)) && high(text.charCodeAt(i - 2)) ? i - 2 : i - 1;
}

/** `i` moved off the middle of a surrogate pair: back to the pair's start (`dir` -1) or past its end (`dir` 1). */
function snap(text: string, i: number, dir: 1 | -1): number {
  const c = Math.max(0, Math.min(text.length, Math.trunc(i)));
  if (onBoundary(text, c)) return c;
  return dir < 0 ? c - 1 : c + 1;
}

// ---- the scan -------------------------------------------------------------------------------------------------

/**
 * A `prompt_secrets.scan` ack for `text`, read strictly: a revision, and candidates with unique ids, in order, apart,
 * non-empty, inside the text and on code point boundaries. Anything else is null (the game does not guess).
 */
export function scanOf(ack: unknown, text: string): PromptSecretsScan | null {
  if (!isObj(ack) || typeof ack.revision !== 'string' || !ack.revision || !Array.isArray(ack.candidates)) return null;
  const ids = new Set<string>();
  const candidates: SecretCandidate[] = [];
  let at = 0;
  for (const raw of ack.candidates as unknown[]) {
    if (!isObj(raw) || typeof raw.id !== 'string' || !raw.id || ids.has(raw.id)) return null;
    const { start, end } = raw;
    if (!isInt(start) || !isInt(end) || start < at || end <= start || end > text.length || !onBoundary(text, start) || !onBoundary(text, end)) return null;
    if (!Array.isArray(raw.kinds) || !raw.kinds.every((k): k is string => typeof k === 'string')) return null;
    ids.add(raw.id);
    candidates.push({ id: raw.id, start, end, kinds: [...raw.kinds], ...(raw.encoded === true ? { encoded: true } : {}) });
    at = end;
  }
  return { revision: ack.revision, candidates };
}

// ---- the review -----------------------------------------------------------------------------------------------

export type MarkState = 'protect' | 'ignore';

export interface Range {
  start: number;
  end: number;
}

/** One highlight of the review: a candidate the scan found, or a mark made by hand. */
export interface Mark {
  /** The candidate's id (`c1`), or `m1`, `m2`, … for a manual mark. */
  readonly key: string;
  /** null: marked by hand. */
  readonly candidate: string | null;
  start: number;
  end: number;
  /** The range the scan found (null: marked by hand). An ignored candidate always has it. */
  readonly found: Range | null;
  state: MarkState;
  readonly kinds: readonly string[];
  readonly encoded: boolean;
}

export type MarkResult = { ok: true; key: string } | { ok: false; reason: string };

export interface ReviewCounts {
  /** Ranges that go to files: protected candidates and manual marks. */
  protect: number;
  /** Ignored candidates: they stay plain text. */
  ignore: number;
  manual: number;
  /** Candidates the scan found. */
  found: number;
}

/**
 * The decisions on one scan of one text. Every operation keeps the marks sorted, non-empty, apart (touching is
 * fine) and on code point boundaries, so `decisions()` is always a review the bridge can check.
 */
export class SecretReview {
  readonly revision: string;
  private list: Mark[];
  private manual = 0;

  /** `earlier`: a review of the same text (the bridge said it was stale): its choices are taken over where they still fit. */
  constructor(
    readonly text: string,
    scan: PromptSecretsScan,
    earlier?: SecretReview,
  ) {
    this.revision = scan.revision;
    this.list = scan.candidates.map((c) => ({ key: c.id, candidate: c.id, start: c.start, end: c.end, found: { start: c.start, end: c.end }, state: 'protect', kinds: [...c.kinds], encoded: c.encoded === true }));
    if (earlier && earlier.text === text) this.takeOver(earlier);
  }

  private takeOver(earlier: SecretReview): void {
    for (const old of earlier.list) {
      if (old.found) {
        const m = this.list.find((x) => x.found && x.found.start === old.found?.start && x.found.end === old.found.end);
        if (!m) continue;
        m.state = old.state;
        if (old.state === 'protect' && this.fits(old.start, old.end, m)) {
          m.start = old.start;
          m.end = old.end;
        }
      } else if (this.fits(old.start, old.end, null)) {
        this.add(old.start, old.end);
      }
    }
  }

  marks(): readonly Readonly<Mark>[] {
    return this.list;
  }

  get(key: string): Readonly<Mark> | null {
    return this.list.find((m) => m.key === key) ?? null;
  }

  /** No other mark overlaps `[start, end)` (`self` is left out). */
  private fits(start: number, end: number, self: Mark | null): boolean {
    return start < end && this.list.every((m) => m === self || m.end <= start || end <= m.start);
  }

  setState(key: string, state: MarkState): boolean {
    const m = this.list.find((x) => x.key === key);
    if (!m || !m.found || m.state === state) return false;
    m.state = state;
    // Ignored, a candidate stays exactly as typed: its found range, never a correction.
    if (state === 'ignore') {
      m.start = m.found.start;
      m.end = m.found.end;
    }
    return true;
  }

  /** Where `edge` of `key` would go one code point in `dir`, or null when it cannot. */
  private target(key: string, edge: 'start' | 'end', dir: 1 | -1): { m: Mark; to: number } | null {
    const i = this.list.findIndex((x) => x.key === key);
    const m = this.list[i];
    if (!m || m.state !== 'protect') return null;
    const to = stepPoint(this.text, m[edge], dir);
    if (to === m[edge]) return null;
    const lo = this.list[i - 1]?.end ?? 0;
    const hi = this.list[i + 1]?.start ?? this.text.length;
    if (edge === 'start' ? to < lo || to >= m.end : to > hi || to <= m.start) return null;
    return { m, to };
  }

  canNudge(key: string, edge: 'start' | 'end', dir: 1 | -1): boolean {
    return this.target(key, edge, dir) !== null;
  }

  /** Moves one edge of a protected mark by a code point: the start left extends it, the end left shrinks it. */
  nudge(key: string, edge: 'start' | 'end', dir: 1 | -1): boolean {
    const t = this.target(key, edge, dir);
    if (!t) return false;
    t.m[edge] = t.to;
    return true;
  }

  /** Marks `[start, end)` by hand, its edges taken out of a surrogate pair (outwards). */
  mark(start: number, end: number): MarkResult {
    const s = snap(this.text, Math.min(start, end), -1);
    const e = snap(this.text, Math.max(start, end), 1);
    if (s >= e) return { ok: false, reason: 'Select some text in the prompt first.' };
    if (!this.fits(s, e, null)) return { ok: false, reason: 'That overlaps a match: correct its edges instead, or select only the text beside it.' };
    return { ok: true, key: this.add(s, e) };
  }

  private add(start: number, end: number): string {
    const key = `m${++this.manual}`;
    this.list.push({ key, candidate: null, start, end, found: null, state: 'protect', kinds: [], encoded: false });
    this.list.sort((a, b) => a.start - b.start);
    return key;
  }

  /** Takes a manual mark away (a candidate is ignored instead). */
  unmark(key: string): boolean {
    const i = this.list.findIndex((m) => m.key === key && !m.candidate);
    if (i < 0) return false;
    this.list.splice(i, 1);
    return true;
  }

  counts(): ReviewCounts {
    const c: ReviewCounts = { protect: 0, ignore: 0, manual: 0, found: 0 };
    for (const m of this.list) {
      if (m.state === 'protect') c.protect++;
      else c.ignore++;
      if (m.candidate) c.found++;
      else c.manual++;
    }
    return c;
  }

  /**
   * The decisions, in text order: a protected candidate with its range (corrected or not: the bridge takes the same
   * range as the candidate's own, and the command log masks by it), an ignored one by id, a manual mark by range.
   */
  decisions(): SecretDecision[] {
    return this.list.map((m): SecretDecision => {
      if (!m.candidate) return { action: 'protect', start: m.start, end: m.end };
      return m.state === 'ignore' ? { candidate: m.candidate, action: 'ignore' } : { candidate: m.candidate, action: 'protect', start: m.start, end: m.end };
    });
  }

  review(): SecretsReview {
    return { revision: this.revision, decisions: this.decisions() };
  }

  /** What goes to files, in text order. */
  protectedRanges(): Range[] {
    return this.list.filter((m) => m.state === 'protect').map((m) => ({ start: m.start, end: m.end }));
  }
}

// ---- masking --------------------------------------------------------------------------------------------------

/** `text` with every code unit of each range (sorted, apart) as `•`: the same length, so offsets still line up. */
export function maskRanges(text: string, ranges: readonly Range[], fill = '•'): string {
  let out = '';
  let at = 0;
  for (const r of ranges) {
    out += text.slice(at, r.start) + fill.repeat(r.end - r.start);
    at = r.end;
  }
  return out + text.slice(at);
}

/** `text` with each range (sorted, apart) as `word`: what a pending prompt shows until the bridge says what it sent. */
export function hideRanges(text: string, ranges: readonly Range[], word = '[secret]'): string {
  let out = '';
  let at = 0;
  for (const r of ranges) {
    out += text.slice(at, r.start) + word;
    at = r.end;
  }
  return out + text.slice(at);
}

const KINDS: Record<string, string> = {
  pem: 'a private key block',
  'auth-header': 'an Authorization header',
  'url-password': 'a password in a URL',
  'url-query': 'a credential in a URL’s query',
  assignment: 'an assignment to a credential-like name',
  'yaml-block': 'a YAML block under a credential-like name',
  prose: 'a sentence that names a password or a token',
  fenced: 'a code block after a line that names a credential',
  repeat: 'the same value found elsewhere in the prompt',
};

/** What found a candidate, in plain words (`marked by you` for none). */
export function kindsText(kinds: readonly string[]): string {
  if (!kinds.length) return 'marked by you';
  return kinds.map((k) => (k.startsWith('gitleaks:') ? `Gitleaks’ ${k.slice(9)} rule` : (KINDS[k] ?? k))).join('; ');
}
