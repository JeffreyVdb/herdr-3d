// #108: prompt secrets for the fixture server's `sim=1` (tools/fixture-sim.ts hands these commands over). Rules, like
// herdr-world's (docs/protocol.md "Prompt secrets"), with a small deterministic detector in place of the bridge's:
// - the snapshot's `prompt_secrets` is `{enabled, available}`, off by default; `simsecretson=1` starts it on,
//   `simsecretsdir=none` plays a bridge host without a private runtime directory (`available: false`), and
//   `simfail=no_secrets` a bridge from before #108 (no `prompt_secrets`, the commands `unknown_command`).
//   `prompt_secrets.set {enabled}` (a boolean, else `bad_request`) answers the switch; a change is a
//   `prompt_secrets.update` with it flat, and a new revision key: every review made before it is stale.
// - `simsecrets=<key>`: the connections with the same key share the switch (a change reaches all of them, as the
//   bridge's does). Without it the switch is the connection's own.
// - `prompt_secrets.scan {text}` (32 KiB of UTF-8 at most, else `bad_request`; off: `secrets_review_off`) answers
//   `{revision, candidates}`: the detector's finds in UTF-16 code units, in order, apart, ids `c1`, `c2`, …; the
//   revision is an HMAC over the text and the candidates with the switch's key, never a plain hash.
// - The detector: the value assigned to a name ending in password, passwd, pwd, secret, token or key (`NAME=value`,
//   `NAME: value`; between its quotes, else to the next blank without a trailing `.,;`): `assignment`; `ghp_` and 20
//   or more letters and digits: `gitleaks:github-pat`; "the password is X": `prose`; every other occurrence of a found
//   value of 6 or more characters: `repeat`. Never `$X`, `${X}`, `<…>` or a `[secret in file …]` reference.
//   `encoded`: the value holds a backslash or a `%XX`.
// - `worker.prompt` with the switch on: the text is scanned again. Candidates and no `secrets`:
//   `secrets_review_required`; a review: its revision (else `secrets_review_stale`), one decision per candidate, ranges
//   non-empty, inside, on code point boundaries and apart (else `secrets_review_required`); anything protected without
//   a directory: `secrets_unavailable`. Then each protected range becomes `[secret in file <path>]` (its exact text is
//   kept for `sim.secret_files`), the prompt goes on as before (tools/fixture-panels.ts) as the text it now is, and the
//   ack adds `sent` (when it changed) and `protected`. The identical submission again (same worker, revision and
//   decisions) reuses its files. Off, a prompt that carries `secrets` is `secrets_review_stale`. Every other route's
//   text goes through the same check (`protect()`). A file's path has the bridge's shape: `<dir>/<owner>/<file>`, both
//   names 26 of `A-Z2-7` (an owner's from its id, a file's at random), so the game's chips take it as the bridge's.
// - `simfail=secrets_review_stale|secrets_review_required|secrets_unavailable|secrets_review_off` refuses the next
//   `worker.prompt` that carries a review that way (`secrets_review_off` switches it off first, for every client;
//   `secrets_review_stale` changes the key, as a restart would).
// - `sim.secret_files {}` (the simulator's own, not a bridge command) lists the files written: `{path, owner, text}`.
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import { createHmac, randomBytes } from 'node:crypto';

type Obj = Record<string, unknown>;
type Send = (m: Obj) => void;

export interface SecretsHost {
  emit(send: Send, m: Obj): void;
  error(code: string, message: string): Error;
  /** True (and used up) when `simfail` is `code`. */
  takeFailure(code: string): boolean;
}

export interface SecretsOptions {
  /** `simsecrets=<key>`: the connections with this key share the switch. */
  key?: string | null;
  /** `simsecretson=1`. */
  on?: boolean;
  /** `simsecretsdir=none`: no private runtime directory. */
  available?: boolean;
  /** False: a bridge from before #108. */
  supported?: boolean;
  /** This world's own announce (its connection's send), for a change another connection made. */
  announce?: (m: Obj) => void;
}

interface Candidate {
  id: string;
  start: number;
  end: number;
  kinds: string[];
  encoded?: boolean;
}

/** The switch the connections of one key share (or one connection's own), and who hears its changes. */
interface Switch {
  enabled: boolean;
  available: boolean;
  key: Buffer;
  worlds: Set<(m: Obj) => void>;
}

const shared = new Map<string, Switch>();
/** Each owner's directory name (the bridge's are random; here one per owner, for the whole host). */
const ownerDirs = new Map<string, string>();
/** The files the simulated bridge wrote, by path (every world's: one simulated host). */
const files = new Map<string, { owner: string; text: string }>();
let fileSerial = 0;

export const MAX_SCAN_BYTES = 32 * 1024;
export const SECRETS_DIR = '/run/user/1000/herdr-world/secrets';
const RETRY_MS = 5 * 60_000;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** A name as the bridge's files and owner directories have them (`[A-Z2-7]{26}`, crypto/rand.Text's). */
export function fileName(): string {
  let out = '';
  for (const b of randomBytes(26)) out += B32[b & 31];
  return out;
}
/** `owner`'s directory: one name per owner, kept. */
export function ownerDir(owner: string): string {
  let d = ownerDirs.get(owner);
  if (!d) ownerDirs.set(owner, (d = fileName()));
  return d;
}

/** Not between the halves of a surrogate pair. */
function onBoundary(text: string, i: number): boolean {
  if (i <= 0 || i >= text.length) return i === 0 || i === text.length;
  const a = text.charCodeAt(i - 1);
  const b = text.charCodeAt(i);
  return !(a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff);
}

const NAME = /\b(?:[A-Za-z_][\w.-]*?)?(?:password|passwd|pwd|secret|token|key)\b["']?\s*[:=]\s*/gi;
const PAT = /ghp_[A-Za-z0-9]{20,}/g;
const PROSE = /\bthe password is\s+/gi;

/** A value starting at `at`: between its quotes, else to the next blank without trailing `.,;`. */
function valueAt(text: string, at: number): { start: number; end: number } | null {
  const q = text[at];
  if (q === '"' || q === "'") {
    const close = text.indexOf(q, at + 1);
    if (close <= at + 1) return null;
    return { start: at + 1, end: close };
  }
  let end = at;
  while (end < text.length && !/\s/.test(text[end] as string)) end++;
  while (end > at && '.,;'.includes(text[end - 1] as string)) end--;
  return end > at ? { start: at, end } : null;
}

/** Templates, references and the bridge's own file references are never candidates. */
const notASecret = (v: string) => !v || /^(\$|<|\{\{|\[secret in file )/.test(v) || /^(true|false|null)$/i.test(v);

/** The fake detector (see the top): candidates in order, apart, ids in text order. */
export function detect(text: string): Candidate[] {
  const found: Array<Omit<Candidate, 'id'>> = [];
  const add = (start: number, end: number, kind: string) => {
    if (notASecret(text.slice(start, end))) return;
    const same = found.find((c) => c.start === start && c.end === end);
    if (same) {
      if (!same.kinds.includes(kind)) same.kinds.push(kind);
      return;
    }
    found.push({ start, end, kinds: [kind] });
  };
  for (const m of text.matchAll(PAT)) add(m.index, m.index + m[0].length, 'gitleaks:github-pat');
  for (const m of text.matchAll(NAME)) {
    const v = valueAt(text, m.index + m[0].length);
    if (v) add(v.start, v.end, 'assignment');
  }
  for (const m of text.matchAll(PROSE)) {
    const v = valueAt(text, m.index + m[0].length);
    if (v) add(v.start, v.end, 'prose');
  }
  // Apart: the earlier start wins, then the longer.
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const apart: Array<Omit<Candidate, 'id'>> = [];
  for (const c of found) if (!apart.some((x) => c.start < x.end && x.start < c.end)) apart.push(c);
  // Each other exact occurrence of a value found.
  for (const c of [...apart]) {
    const v = text.slice(c.start, c.end);
    if (v.length < 6) continue;
    for (let i = text.indexOf(v); i >= 0; i = text.indexOf(v, i + 1)) {
      if (!apart.some((x) => i < x.end && x.start < i + v.length)) apart.push({ start: i, end: i + v.length, kinds: ['repeat'] });
    }
  }
  apart.sort((a, b) => a.start - b.start);
  return apart.map((c, i) => {
    const encoded = /\\|%[0-9A-Fa-f]{2}/.test(text.slice(c.start, c.end));
    return { id: `c${i + 1}`, ...c, ...(encoded ? { encoded: true } : {}) };
  });
}

/** One decision as the bridge reads it: a candidate's, or a manual mark. */
interface Decision {
  candidate: string;
  protect: boolean;
  range: { start: number; end: number } | null;
}

export class SecretsSim {
  private readonly h: SecretsHost;
  private readonly sw: Switch;
  private readonly supported: boolean;
  private readonly hear: ((m: Obj) => void) | null;
  /** Sent reviews, for a retry: their key, the text they sent, when. */
  private readonly sent = new Map<string, { text: string; at: number; paths: string[] }>();

  constructor(h: SecretsHost, o: SecretsOptions = {}) {
    this.h = h;
    this.supported = o.supported !== false;
    const fresh = (): Switch => ({ enabled: o.on === true, available: o.available !== false, key: randomBytes(32), worlds: new Set() });
    let sw: Switch;
    if (o.key) {
      sw = shared.get(o.key) ?? fresh();
      shared.set(o.key, sw);
    } else sw = fresh();
    this.sw = sw;
    this.hear = o.announce ?? null;
    if (this.hear) sw.worlds.add(this.hear);
  }

  dispose(): void {
    if (this.hear) this.sw.worlds.delete(this.hear);
  }

  view(): Obj {
    return { enabled: this.sw.enabled, available: this.sw.available, ...(this.sw.available ? { dir: SECRETS_DIR } : {}) };
  }

  /** The switch is on (a route's text goes through `protect()`). */
  get on(): boolean {
    return this.supported && this.sw.enabled;
  }

  decorate(world: Obj): void {
    if (this.supported) world.prompt_secrets = this.view();
  }

  /** The files written so far (`sim.secret_files`). */
  static files(): Array<{ path: string; owner: string; text: string }> {
    return [...files].map(([path, f]) => ({ path, ...f }));
  }

  /** `prompt_secrets.*` and `sim.secret_files`; false: not one of them. */
  handle(t: unknown, a: Obj, send: Send, ack: (d?: unknown) => void): boolean {
    if (t === 'sim.secret_files') {
      ack({ files: SecretsSim.files() });
      return true;
    }
    if (typeof t !== 'string' || !t.startsWith('prompt_secrets.')) return false;
    if (!this.supported) throw this.h.error('unknown_command', `unknown command: "${t}"`);
    switch (t) {
      case 'prompt_secrets.get':
        ack(this.view());
        return true;
      case 'prompt_secrets.set': {
        if (typeof a.enabled !== 'boolean') throw this.h.error('bad_request', 'enabled must be true or false');
        this.set(a.enabled, send);
        ack(this.view());
        return true;
      }
      case 'prompt_secrets.scan': {
        if (typeof a.text !== 'string') throw this.h.error('bad_request', 'text must be a string');
        if (bytes(a.text) > MAX_SCAN_BYTES) throw this.h.error('bad_request', 'text must be at most 32 KiB');
        if (!this.sw.enabled) throw this.h.error('secrets_review_off', 'Review prompt secrets is off');
        const cands = detect(a.text);
        ack({ revision: this.revision(a.text, cands), candidates: cands });
        return true;
      }
    }
    throw this.h.error('unknown_command', `unknown command: "${t}"`);
  }

  /** Changes the switch: every connection hears it (this one through `send`), and every review before it is stale. */
  private set(on: boolean, send: Send): void {
    if (this.sw.enabled === on) return;
    this.sw.enabled = on;
    this.sw.key = randomBytes(32);
    const m = { t: 'prompt_secrets.update', ...this.view() };
    this.h.emit(send, m);
    for (const other of this.sw.worlds) if (other !== this.hear) other(m);
  }

  private revision(text: string, cands: Candidate[]): string {
    return createHmac('sha256', this.sw.key).update(JSON.stringify([text, cands])).digest('base64url');
  }

  /**
   * `worker.prompt`'s gate (see the top): refuses it (throws), or gives the args to go on with (the text with its
   * references, `secrets` taken out) and what the ack adds. Null: nothing to do (off, no review, or a bridge before #108).
   */
  prompt(a: Obj, owner: string, send: Send): { args: Obj; extra: Obj; rollback(): void } | null {
    if (!this.supported || typeof a.text !== 'string') return null;
    const p = this.protect(a.text, a.secrets, owner, send);
    if (!p) return null;
    const rest: Obj = { ...a };
    delete rest.secrets;
    if (!p.protected) return { args: rest, extra: { protected: 0 }, rollback: () => {} };
    return { args: { ...rest, text: p.text }, extra: { sent: p.text, protected: p.protected }, rollback: p.rollback };
  }

  /**
   * One text through the gate, as any route's (docs/protocol.md "Prompt secrets"): refused (throws) with the bridge's
   * codes and `field: ` before the message when given (a route with several texts), or the text with each protected
   * range as a reference to a file of `owner`. Null: nothing to do (off without a review, a bridge before #108, or
   * nothing found and no review). `stored`: a saved prompt, whose review must ignore everything
   * (`secrets_review_stored`, no file). The `simfail=secrets_*` failures are taken by the first text with a review.
   */
  protect(text: string, review: unknown, owner: string, send: Send, o: { field?: string; stored?: boolean } = {}): { text: string; protected: number; rollback(): void } | null {
    if (!this.supported) return null;
    const at = o.field ? `${o.field}: ` : '';
    if (!this.sw.enabled) {
      if (review !== undefined) throw this.h.error('secrets_review_stale', 'secrets review: the switch is off');
      return null;
    }
    if (bytes(text) > MAX_SCAN_BYTES) throw this.h.error('bad_request', `${at}text must be at most 32 KiB`);
    if (review !== undefined) {
      if (this.h.takeFailure('secrets_review_off')) {
        this.set(false, send);
        throw this.h.error('secrets_review_off', 'Review prompt secrets is off');
      }
      if (this.h.takeFailure('secrets_review_stale')) {
        this.sw.key = randomBytes(32);
        throw this.h.error('secrets_review_stale', 'the review’s revision is not this text’s: scan it again');
      }
      if (this.h.takeFailure('secrets_review_required')) throw this.h.error('secrets_review_required', `${at}secrets review: scan it again and review`);
      if (this.h.takeFailure('secrets_unavailable')) throw this.h.error('secrets_unavailable', 'no private runtime directory');
    }
    const cands = detect(text);
    if (review === undefined) {
      if (!cands.length) return null;
      throw this.h.error('secrets_review_required', `${at}${cands.length} possible ${cands.length === 1 ? 'secret' : 'secrets'}: review them`);
    }
    const ds = this.check(text, cands, review, at);
    const protect = ds.flatMap((d) => (d.protect ? [d.range ?? (cands.find((c) => c.id === d.candidate) as Candidate)] : [])).map((r) => ({ start: r.start, end: r.end }));
    protect.sort((x, y) => x.start - y.start);
    if (o.stored && protect.length) throw this.h.error('secrets_review_stored', `${at}a stored prompt keeps no protected file: remove those values from it, or protect them when you hire with it`);
    const ignored = ds.filter((d) => !d.protect).map((d) => d.candidate).sort();
    if (!protect.length) return { text, protected: 0, rollback: () => {} };
    if (!this.sw.available) throw this.h.error('secrets_unavailable', 'no private runtime directory');
    const key = JSON.stringify([owner, (review as Obj).revision, protect, ignored]);
    const now = Date.now();
    const again = this.sent.get(key);
    let paths: string[];
    let made: string[] = [];
    if (again && now - again.at < RETRY_MS) paths = again.paths;
    else {
      paths = made = protect.map((r) => {
        const path = `${SECRETS_DIR}/${ownerDir(owner)}/${fileName()}`;
        files.set(path, { owner, text: text.slice(r.start, r.end) });
        return path;
      });
      this.sent.set(key, { text, at: now, paths });
    }
    // A send that fails removes the files it made, never the ones it reused.
    const rollback = () => {
      for (const p of made) files.delete(p);
      if (made.length) this.sent.delete(key);
    };
    let out = '';
    let from = 0;
    protect.forEach((r, i) => {
      out += `${text.slice(from, r.start)}[secret in file ${paths[i]}]`;
      from = r.end;
    });
    out += text.slice(from);
    return { text: out, protected: protect.length, rollback };
  }

  /** The decisions of a review against the fresh scan (docs/protocol.md): refused with the bridge's codes. */
  private check(text: string, cands: Candidate[], review: unknown, at = ''): Decision[] {
    const bad = (why: string) => this.h.error('secrets_review_required', `${at}secrets review: ${why}`);
    if (!isObj(review) || typeof review.revision !== 'string' || !Array.isArray(review.decisions)) throw bad('a review is {revision, decisions}');
    if (review.revision !== this.revision(text, cands)) throw this.h.error('secrets_review_stale', 'the review’s revision is not this text’s: scan it again');
    const out: Decision[] = [];
    const seen = new Set<string>();
    const placed: Array<{ start: number; end: number; i: number }> = [];
    (review.decisions as unknown[]).forEach((raw, i) => {
      if (!isObj(raw) || (raw.action !== 'protect' && raw.action !== 'ignore')) throw bad(`decision ${i} is not protect or ignore`);
      const id = typeof raw.candidate === 'string' ? raw.candidate : '';
      const protect = raw.action === 'protect';
      const ranged = raw.start !== undefined || raw.end !== undefined;
      let range: { start: number; end: number } | null = null;
      if (ranged) {
        if (!isInt(raw.start) || !isInt(raw.end) || raw.start >= raw.end || raw.start < 0 || raw.end > text.length || !onBoundary(text, raw.start) || !onBoundary(text, raw.end)) throw bad(`decision ${i}: a range that is empty, outside the text or splits a character`);
        range = { start: raw.start, end: raw.end };
      }
      if (id) {
        const c = cands.find((x) => x.id === id);
        if (!c) throw bad(`decision ${i} names no candidate of this revision`);
        if (seen.has(id)) throw bad(`candidate ${id} has more than one decision`);
        seen.add(id);
        if (range && !protect) throw bad(`decision ${i}: only a protected candidate takes a corrected range`);
        placed.push({ ...(range ?? { start: c.start, end: c.end }), i });
      } else {
        if (!protect || !range) throw bad(`decision ${i}: a manual mark protects a range (start and end)`);
        placed.push({ ...range, i });
      }
      out.push({ candidate: id, protect, range });
    });
    if (seen.size !== cands.length) throw bad(`${cands.length - seen.size} of ${cands.length} candidates have no decision`);
    placed.sort((x, y) => x.start - y.start);
    for (let k = 1; k < placed.length; k++) {
      const [p, q] = [placed[k - 1], placed[k]] as [{ end: number; i: number }, { start: number; i: number }];
      if (q.start < p.end) throw bad(`decisions ${p.i} and ${q.i} overlap`);
    }
    return out;
  }
}
