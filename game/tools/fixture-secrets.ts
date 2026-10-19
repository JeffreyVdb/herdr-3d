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
//   value of 6 or more characters: `repeat`. Never `$X`, `${X}` or `<…>`, and never the bridge's own reference: exactly
//   `[secret in file <dir>/<owner>/<file>]` (`SECRETS_DIR`, both names 26–64 of `A-Z2-7`): no candidate or repeat
//   touches its bytes, and a value that starts at one is left out whole (`PASSWORD=[secret in file …]x` proposes
//   nothing: simpler than the bridge, which proposes the `x`). Text that only looks like one is read as any other.
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
// - Round 2 (`gate()`, docs/protocol.md "Round 2: every other route"), with the switch on, each route's texts the same
//   way, the args rewritten to the texts with their references before the route's own simulator sees them: one review
//   (`worker.hire` `prompt`, `packup.detect` and `hire.interpret` `text`, `worker.wrapup` `prompt`, `worker.handoff`
//   agent/llm `instruction`) or one per path (`run.start` `text`/`extra`/`prompt`, `extra` only beside no `prompt`;
//   `worker.answer_ask` `prompt`/`answers[N].other`; `worker.answer_followup` `note`/`answers[N].value`/`answers[N].note`;
//   `worker.answer_async` `answers[N].answer`), a refusal starting with the path, a review keyed by a text not sent
//   `secrets_review_required`, all or nothing. A hire's (`worker.hire`, `run.start`) files are a pending owner's until
//   its ack, then the new worker's; acks add `protected` (`run.start`'s `prompt` and `worker.handoff`'s stored
//   `instruction` hold the references). Stored prompts (`schedule.create`/`update`, `hire_preset.create`/`update`/
//   `check`) need an all-ignore review (protecting is `secrets_review_stored`); a schedule's row keeps the record
//   (`digest`), and its fire with the switch on fails as the bridge's (`storedFireReason`) unless its candidates are
//   none or its record's; `schedule.retry`/`run_now {id, secrets}` review the stored prompt, keep the record and fire;
//   `secrets` on cancel or dismiss is `bad_request`.
// - The hand-over (`secrets_pending`, a random token, memory only, 30 minutes): `packup.detect` (only for a worker it
//   looks at) answers `sent` (when changed), `protected` and one when it had a review, its `removed` indexing `sent`;
//   `worker.prompt {id, text: sent or task, secrets_pending}` needs no review and claims the files for that worker
//   (another worker's, an unknown, expired or pre-switch-change token: `secrets_review_stale`). `hire.interpret` answers
//   one (its `text`, `hire.sources`, `hire.task.value` with references; a follow-up's new files join the same owner and
//   keep the token; a pending source with candidates the token did not answer is `pending.sources[N]: …` required);
//   `worker.hire {prompt: that task, secrets_pending}` needs no review, its worker claims the files, and a second hire
//   with it is stale. Round 5: `worker.wrapup {id, prompt, secrets_pending}` with packup's hand-over: a prompt that is
//   its task, a blank line and a rest without candidates needs no review (any other prompt is reviewed as usual), and
//   the files are the worker's before it arms.
// - Round 5: `prompt_secrets.revoke {worker}` → `{removed}` removes every file the worker holds on this bridge, the
//   switch on or off (`not_found`, `secrets_unavailable` without a directory); `Worker.secret_files` (left out at 0) is
//   in the snapshot and a `worker.upsert` whenever it changes; a worker sent home takes its files with it. The files
//   are host-wide (`sim.secret_files`), but each is held on the bridge that wrote it (a `simsecrets` key's
//   connections, else the connection): every test loads the same fixture, so its worker ids repeat.
// - `simfail=secrets_review_stale|secrets_review_required|secrets_unavailable|secrets_review_off` refuses the next
//   command that carries a review that way, on any route (`secrets_review_off` switches it off first, for every client;
//   `secrets_review_stale` changes the key, as a restart would); `simfail=secrets_pending_stale` the next one that
//   carries a `secrets_pending`; `simfail=no_revoke` plays a bridge before round 5 (no `prompt_secrets.revoke`, no
//   `secret_files`), `simfail=old_wrapup` one whose `worker.wrapup` refuses `secrets_pending` (`bad_request`,
//   "unknown field").
// - `sim.secret_files {}` (the simulator's own, not a bridge command) lists the files written: `{path, owner, text}`.
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import { createHash, createHmac, randomBytes } from 'node:crypto';

type Obj = Record<string, unknown>;
type Send = (m: Obj) => void;

export interface SecretsHost {
  emit(send: Send, m: Obj): void;
  error(code: string, message: string): Error;
  /** True (and used up) when `simfail` is `code`. */
  takeFailure(code: string): boolean;
  /** Round 5: whether this world has the worker (`prompt_secrets.revoke`; absent: every id is known). */
  hasWorker?(id: string): boolean;
}

/** What the routes' gate needs of the world (tools/fixture-sim.ts). */
export interface RouteWorld {
  /** Whether `packup.detect` looks at a prompt to this worker (a skipped one is not reviewed). */
  packupLooks(id: unknown): boolean;
  /** A schedule's stored prompt (undefined: no such schedule). */
  schedulePrompt(id: unknown): string | undefined;
}

/** A route's text gone through the gate: its ack as the bridge answers it, or its failure (the files it made go). */
export interface Gate {
  ack(data: unknown): unknown;
  fail(): void;
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
  /** Round 5: `prompt_secrets.revoke` and `Worker.secret_files` (false: `simfail=no_revoke`, a bridge before it). */
  revoke?: boolean;
  /** Round 5: `worker.wrapup` takes `secrets_pending` (false: `simfail=old_wrapup`, a bridge before it). */
  wrapupHandover?: boolean;
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
/** A pending owner's id (a route with no worker yet): `pending:<n>`. */
let pendingSerial = 0;
/** Each owner's directory name (the bridge's are random; here one per owner, for the whole host). */
const ownerDirs = new Map<string, string>();
/** The files the simulated bridge wrote, by path (every world's: one simulated host). */
const files = new Map<string, { owner: string; text: string; bridge: string }>();
/** The simulated bridges (a `simsecrets` key's connections are one bridge, else each connection is its own). */
let bridgeSerial = 0;
let fileSerial = 0;

export const MAX_SCAN_BYTES = 32 * 1024;
export const SECRETS_DIR = '/run/user/1000/herdr-world/secrets';
const RETRY_MS = 5 * 60_000;
/** A pending owner's and its hand-over's life (docs/protocol.md "Pending owners"). */
export const PENDING_MS = 30 * 60_000;
/** The reason a schedule's fire fails with when its stored prompt has unreviewed candidates (the bridge's words). */
export const storedFireReason = (n: number) =>
  `its prompt was not reviewed for secrets: it has ${n} possible secrets that “Review prompt secrets before sending” has not seen left as typed (saved before the switch was on, or the rules changed): open the schedule, review them and retry it; nothing was sent`;

/** The routes that carry typed text through the gate (docs/protocol.md "Round 2: every other route"). */
const GATED = new Set([
  'worker.prompt',
  'worker.hire',
  'run.start',
  'schedule.create',
  'schedule.update',
  'schedule.retry',
  'schedule.run_now',
  'schedule.cancel',
  'schedule.dismiss',
  'hire_preset.create',
  'hire_preset.update',
  'hire_preset.check',
  'packup.detect',
  'hire.interpret',
  'worker.answer_ask',
  'worker.answer_followup',
  'worker.answer_async',
  'worker.wrapup',
  'worker.handoff',
]);

/** A stored prompt's "owner": it keeps no file (`protect` refuses what would make one). */
const STORED = 'stored';

/** One text through the gate, its files counted for the command's undo. */
type Protect = (text: string, review: unknown, owner: string, o?: { field?: string; stored?: boolean }) => { text: string; protected: number } | null;

/** A hand-over (`secrets_pending`): its pending owner, the worker it is for (packup's; a hire's has none), the texts it answered as reviewed, its task (packup's, for a wrap-up), the switch's key then, when, and who claimed it. */
interface Handover {
  owner: string;
  worker: string | null;
  texts: Set<string>;
  task: string | null;
  key: Buffer;
  at: number;
  claimed: string | null;
}

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

/** Templates, references, a redaction (the bridge's `notASecret`: any value that says "redacted", #117's check text) and the bridge's own file references are never candidates. */
const notASecret = (v: string) => !v || /^(\$|<|\{\{|\[secret in file )/.test(v) || /^(true|false|null)$/i.test(v) || /redacted/i.test(v);

/** The bridge's own references (decisions row 6): exactly its directory's shape, as `Files.IsFilePath` reads it. */
// (`SECRETS_DIR` holds no character a pattern reads specially.)
const OWN_REF = new RegExp(String.raw`\[secret in file ${SECRETS_DIR}/[A-Z2-7]{26,64}/[A-Z2-7]{26,64}\]`, 'g');

/** Where `text` holds the bridge's own references: never a candidate's bytes. */
export function ownReferences(text: string): Array<{ start: number; end: number }> {
  return [...text.matchAll(OWN_REF)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
}

/** The fake detector (see the top): candidates in order, apart, ids in text order. */
export function detect(text: string): Candidate[] {
  const refs = ownReferences(text);
  const inRef = (start: number, end: number) => refs.some((r) => start < r.end && r.start < end);
  const found: Array<Omit<Candidate, 'id'>> = [];
  const add = (start: number, end: number, kind: string) => {
    // A value that starts at (or runs into) one of the bridge's references is left out whole.
    if (notASecret(text.slice(start, end)) || inRef(start, end)) return;
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
      if (!apart.some((x) => i < x.end && x.start < i + v.length) && !inRef(i, i + v.length)) apart.push({ start: i, end: i + v.length, kinds: ['repeat'] });
    }
  }
  apart.sort((a, b) => a.start - b.start);
  return apart.map((c, i) => {
    const encoded = /\\|%[0-9A-Fa-f]{2}/.test(text.slice(c.start, c.end));
    return { id: `c${i + 1}`, ...c, ...(encoded ? { encoded: true } : {}) };
  });
}

/** A stored prompt's record (the bridge's `StoredDigest`): a plain SHA-256 of the text and its candidates, no key. */
export function digest(text: string): string {
  return createHash('sha256').update(JSON.stringify([text, detect(text)])).digest('base64url');
}

/** The texts of a command with several, keyed by their path in the args (docs/protocol.md "One text, or a review per text"). */
function fieldsOf(t: string, a: Obj): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const add = (path: string, v: unknown) => {
    if (typeof v === 'string' && v !== '') out.push([path, v]);
  };
  const answers = Array.isArray(a.answers) ? (a.answers as unknown[]) : [];
  if (t === 'run.start') {
    add('text', a.text);
    // `extra` is in the composed prompt only: beside an edited `prompt` it is not sent.
    if (typeof a.prompt !== 'string' || a.prompt === '') add('extra', a.extra);
    add('prompt', a.prompt);
  } else if (t === 'worker.answer_ask') {
    add('prompt', a.prompt);
    answers.forEach((x, i) => isObj(x) && add(`answers[${i}].other`, x.other));
  } else if (t === 'worker.answer_followup') {
    add('note', a.note);
    answers.forEach((x, i) => {
      if (!isObj(x)) return;
      add(`answers[${i}].value`, x.value);
      add(`answers[${i}].note`, x.note);
    });
  } else if (t === 'worker.answer_async') {
    answers.forEach((x, i) => isObj(x) && add(`answers[${i}].answer`, x.answer));
  }
  return out;
}

/** Puts `text` back at `path` in the args (the protected text). */
function setField(a: Obj, path: string, text: string): void {
  const m = /^answers\[(\d+)\]\.(\w+)$/.exec(path);
  if (!m) {
    a[path] = text;
    return;
  }
  ((a.answers as Obj[])[Number(m[1])] as Obj)[m[2] as string] = text;
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
  /** Round 5: revoke and `Worker.secret_files` (false: a bridge before round 5). */
  readonly revocable: boolean;
  /**
   * Which simulated bridge holds the files this one writes: the fixture's worlds share worker ids (every test loads the
   * same fixture), so a worker's files are counted, claimed and revoked on its own bridge only.
   */
  private readonly bridge: string;
  private readonly wrapupHandover: boolean;
  /** Hand-overs by token (memory only, as the bridge's). */
  private readonly tokens = new Map<string, Handover>();
  /** Schedules' records: the digest of the review that left their stored prompt's candidates as typed. */
  private readonly records = new Map<string, string>();

  constructor(h: SecretsHost, o: SecretsOptions = {}) {
    this.h = h;
    this.supported = o.supported !== false;
    this.revocable = this.supported && o.revoke !== false;
    this.bridge = o.key ? `key:${o.key}` : `sim:${++bridgeSerial}`;
    this.wrapupHandover = o.wrapupHandover !== false;
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
    return [...files].map(([path, f]) => ({ path, owner: f.owner, text: f.text }));
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
      case 'prompt_secrets.revoke': {
        // Round 5: every file the worker holds now goes; it keeps running. The switch on or off.
        if (!this.revocable) break;
        for (const k of Object.keys(a)) if (k !== 'worker') throw this.h.error('bad_request', `bad args: json: unknown field "${k}"`);
        if (typeof a.worker !== 'string' || !a.worker) throw this.h.error('bad_request', 'worker is required');
        if (this.h.hasWorker && !this.h.hasWorker(a.worker)) throw this.h.error('not_found', `not found: worker "${a.worker}"`);
        if (!this.sw.available) throw this.h.error('secrets_unavailable', 'no private runtime directory');
        ack({ removed: this.release(a.worker) });
        return true;
      }
    }
    throw this.h.error('unknown_command', `unknown command: "${t}"`);
  }

  /** How many files `worker` holds (`Worker.secret_files`). */
  held(worker: string): number {
    let n = 0;
    for (const f of files.values()) if (f.owner === worker && f.bridge === this.bridge) n++;
    return n;
  }

  /** Removes every file `owner` holds (a revoke, or a worker that really ended): how many went. */
  release(owner: string): number {
    let n = 0;
    for (const [path, f] of files)
      if (f.owner === owner && f.bridge === this.bridge) {
        files.delete(path);
        n++;
      }
    return n;
  }

  /** `from`'s files become `to`'s (a pending owner claimed by its worker; the paths stay). */
  private reown(from: string, to: string): void {
    for (const f of files.values()) if (f.owner === from && f.bridge === this.bridge) f.owner = to;
  }

  private newOwner(): string {
    return `pending:${++pendingSerial}`;
  }

  /** A schedule's fire with the switch on (docs/protocol.md "A schedule's fire"): why it fails, or null (it fires). */
  storedFire(id: string, prompt: string): string | null {
    if (!this.supported || !this.sw.enabled) return null;
    const n = detect(prompt).length;
    if (!n || this.records.get(id) === digest(prompt)) return null;
    return storedFireReason(n);
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
        files.set(path, { owner, text: text.slice(r.start, r.end), bridge: this.bridge });
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

  /** A new hand-over of `owner`'s files (`secrets_pending`): a random token, never the owner's directory. */
  private handOver(owner: string, worker: string | null): string {
    const token = randomBytes(18).toString('base64url');
    this.tokens.set(token, { owner, worker, texts: new Set(), task: null, key: this.sw.key, at: Date.now(), claimed: null });
    return token;
  }

  /**
   * The hand-over `token` for `worker` (null: a hire's, which has no worker), checked as the bridge checks it when a
   * command arrives: unknown, expired, from before a change of the switch, another worker's (or a preview's for a hire,
   * a hire's for a worker's prompt) is `secrets_review_stale`; `simfail=secrets_pending_stale` plays one.
   */
  private pendingFor(token: unknown, worker: string | null): Handover {
    const stale = (why: string) => this.h.error('secrets_review_stale', `secrets_pending: ${why}: review it again`);
    if (typeof token !== 'string' || !token) throw this.h.error('bad_request', 'secrets_pending must be a token');
    if (this.h.takeFailure('secrets_pending_stale')) throw stale('the review of the text before no longer holds');
    const tok = this.tokens.get(token);
    if (!tok || Date.now() - tok.at > PENDING_MS) throw stale('unknown or expired');
    if (!tok.key.equals(this.sw.key)) throw stale('the setting changed');
    if (tok.worker !== worker) throw stale(tok.worker === null ? 'it is a hire’s' : 'it is another worker’s');
    return tok;
  }

  /** `worker` claims `tok`'s files (once: another worker's claim is stale). */
  private claim(tok: Handover, worker: string): void {
    if (tok.claimed !== null && tok.claimed !== worker) throw this.h.error('secrets_review_stale', 'secrets_pending: another worker claimed it: review it again');
    tok.claimed = worker;
    this.reown(tok.owner, worker);
  }

  /**
   * A route's texts through the gate (docs/protocol.md "Round 2: every other route"), with the switch on: each text
   * reviewed (or answered by its hand-over), the args rewritten in place with the texts as they go on (references in
   * place, `secrets` and `secrets_pending` taken out), refused with the bridge's codes and the text's path. The returned
   * gate gives the ack the bridge's fields and claims what the command's worker takes; its `fail` removes the files the
   * command made. Null: nothing to do (not a gated route, a bridge before #108, off without a review).
   */
  gate(t: unknown, a: Obj, send: Send, w: RouteWorld): Gate | null {
    if (!this.supported || typeof t !== 'string' || !GATED.has(t)) return null;
    const review = a.secrets;
    const pending = a.secrets_pending;
    if ((t === 'schedule.cancel' || t === 'schedule.dismiss') && review !== undefined) throw this.h.error('bad_request', `bad request: ${t} takes no secrets`);
    if (t === 'worker.wrapup' && pending !== undefined && !this.wrapupHandover) throw this.h.error('bad_request', 'bad args: json: unknown field "secrets_pending"');
    if (!this.sw.enabled) {
      if (review !== undefined || pending !== undefined) throw this.h.error('secrets_review_stale', 'secrets review: the switch is off');
      return null;
    }
    delete a.secrets;
    delete a.secrets_pending;
    const made: Array<() => void> = [];
    const undo = () => {
      for (const r of made.splice(0)) r();
    };
    const one: Protect = (text, r, owner, o = {}) => {
      const p = this.protect(text, r, owner, send, o);
      if (p) made.push(p.rollback);
      return p;
    };
    const plain: Gate = { ack: (d) => d, fail: undo };
    try {
      switch (t) {
        case 'worker.prompt':
          return this.gatePrompt(a, review, pending, one, undo);
        case 'worker.hire': {
          const prompt = typeof a.prompt === 'string' ? a.prompt : '';
          const tok = pending !== undefined ? this.pendingFor(pending, null) : null;
          if (tok?.claimed) throw this.h.error('secrets_review_stale', 'secrets_pending: another hire claimed it: review it again');
          if (!prompt) {
            if (review !== undefined || tok) throw this.h.error('secrets_review_required', 'secrets review: a review needs the prompt it is of');
            return null;
          }
          const own = this.newOwner();
          // hire.interpret's task exactly as it answered it needs no review again; anything else is reviewed.
          const p = review === undefined && tok?.texts.has(prompt) ? null : one(prompt, review, own);
          if (p) a.prompt = p.text;
          if (!p && !tok) return null;
          return {
            ack: (d) => {
              const id = isObj(d) && typeof d.id === 'string' ? d.id : '';
              if (id) {
                this.reown(own, id);
                if (tok) this.claim(tok, id);
              }
              return p?.protected && isObj(d) ? { ...d, protected: p.protected } : d;
            },
            fail: undo, // a hire that fails leaves the hand-over for another attempt
          };
        }
        case 'run.start': {
          const own = this.newOwner();
          let n = 0;
          for (const [path, text] of this.fields(t, a, review)) {
            const p = one(text, (review as Obj | undefined)?.[path], own, { field: path });
            if (p) {
              setField(a, path, p.text);
              n += p.protected;
            }
          }
          return {
            ack: (d) => {
              const id = isObj(d) && typeof d.id === 'string' ? d.id : '';
              if (id) this.reown(own, id);
              return n && isObj(d) ? { ...d, protected: n } : d;
            },
            fail: undo,
          };
        }
        case 'worker.answer_ask':
        case 'worker.answer_followup':
        case 'worker.answer_async': {
          const owner = typeof a.id === 'string' ? a.id : '';
          for (const [path, text] of this.fields(t, a, review)) {
            const p = one(text, (review as Obj | undefined)?.[path], owner, { field: path });
            if (p) setField(a, path, p.text);
          }
          return plain;
        }
        case 'schedule.create':
        case 'schedule.update':
        case 'hire_preset.create':
        case 'hire_preset.update':
        case 'hire_preset.check': {
          const prompt = typeof a.prompt === 'string' ? a.prompt : '';
          one(prompt, review, STORED, { stored: true });
          if (!t.startsWith('schedule.') || review === undefined) return plain;
          // The row keeps the record of the review that left the candidates as typed.
          return {
            ack: (d) => {
              const id = isObj(d) && typeof d.id === 'string' ? d.id : '';
              if (id) this.records.set(id, digest(prompt));
              return d;
            },
            fail: undo,
          };
        }
        case 'schedule.retry':
        case 'schedule.run_now': {
          if (review === undefined) return null;
          const prompt = w.schedulePrompt(a.id);
          if (prompt === undefined) throw this.h.error('not_found', `not found: schedule ${JSON.stringify(a.id)}`);
          // Checked as a save's, its record kept on the schedule, then it fires (as typed).
          one(prompt, review, STORED, { stored: true });
          this.records.set(String(a.id), digest(prompt));
          return plain;
        }
        case 'packup.detect': {
          // A detect the bridge does not look at (not ready, a freelancer) reads nothing: not reviewed.
          if (!w.packupLooks(a.id) || typeof a.text !== 'string') return null;
          const text = a.text;
          const own = this.newOwner();
          const p = one(text, review, own);
          if (!p) return null;
          a.text = p.text;
          const token = review !== undefined ? this.handOver(own, String(a.id)) : null;
          return {
            ack: (d) => {
              if (!isObj(d)) return d;
              const tok = token ? this.tokens.get(token) : undefined;
              if (tok) {
                tok.texts.add(p.text);
                if (d.matched === true && typeof d.task === 'string' && d.task) {
                  tok.texts.add(d.task);
                  tok.task = d.task;
                }
              }
              return { ...d, ...(p.text !== text ? { sent: p.text } : {}), ...(p.protected ? { protected: p.protected } : {}), ...(token ? { secrets_pending: token } : {}) };
            },
            fail: () => {
              undo();
              if (token) this.tokens.delete(token);
            },
          };
        }
        case 'hire.interpret':
          return this.gateInterpret(a, review, pending, one, undo);
        case 'worker.wrapup': {
          const owner = typeof a.id === 'string' ? a.id : '';
          const prompt = typeof a.prompt === 'string' ? a.prompt : '';
          const tok = pending !== undefined ? this.pendingFor(pending, owner) : null;
          const task = tok?.task;
          if (review === undefined && task && prompt.startsWith(`${task}\n\n`)) {
            // Round 5: the hand-over's task as answered needs no review; the rest (the cleanup sentence) is scanned.
            const n = detect(prompt.slice(task.length + 2)).length;
            if (n) throw this.h.error('secrets_review_required', `${n} possible ${n === 1 ? 'secret' : 'secrets'} after the task: review them`);
          } else {
            const p = one(prompt, review, owner);
            if (p) a.prompt = p.text;
          }
          // Its files are the worker's before the wrap-up arms.
          if (tok) this.claim(tok, owner);
          return plain;
        }
        case 'worker.handoff': {
          if (a.mode !== 'agent' && a.mode !== 'llm') {
            if (review !== undefined) throw this.h.error('bad_request', 'bad request: a literal handoff has no text to review');
            return null;
          }
          const instruction = typeof a.instruction === 'string' ? a.instruction : '';
          if (!instruction.trim()) {
            if (review !== undefined) throw this.h.error('secrets_review_required', 'instruction: a review of a text the command does not send');
            return null;
          }
          const p = one(instruction, review, typeof a.worker === 'string' ? a.worker : '');
          if (p) a.instruction = p.text;
          return {
            ack: (d) => (p?.protected && isObj(d) && d.existing !== true ? { ...d, protected: p.protected } : d),
            fail: undo,
          };
        }
      }
      return null;
    } catch (e) {
      undo();
      throw e;
    }
  }

  /** The texts a command with several sends, each with its path; a review keyed by any other path is refused. */
  private fields(t: string, a: Obj, review: unknown): Array<[string, string]> {
    if (review !== undefined && (!isObj(review) || Object.values(review).some((r) => !isObj(r)))) throw this.h.error('bad_request', 'bad args: secrets: an object of reviews keyed by each text’s path');
    const fields = fieldsOf(t, a);
    for (const k of Object.keys((review as Obj | undefined) ?? {}))
      if (!fields.some(([path]) => path === k)) throw this.h.error('secrets_review_required', `${k}: a review of a text the command does not send`);
    return fields;
  }

  /** `worker.prompt`: round 1's gate, or (round 2) `packup.detect`'s hand-over for its exact `sent` or `task`. */
  private gatePrompt(a: Obj, review: unknown, pending: unknown, one: Protect, undo: () => void): Gate | null {
    const owner = typeof a.id === 'string' ? a.id : '';
    const text = typeof a.text === 'string' ? a.text : '';
    const tok = pending !== undefined ? this.pendingFor(pending, owner) : null;
    const p = review === undefined && tok?.texts.has(text) ? null : one(text, review, owner);
    // The hand-over's files are the worker's from now on, sent or not.
    if (tok) this.claim(tok, owner);
    if (!p) return tok ? { ack: (d) => d, fail: undo } : null;
    a.text = p.text;
    return {
      ack: (d) => (isObj(d) ? { ...d, ...(p.protected ? { sent: p.text } : {}), protected: p.protected } : d),
      fail: undo,
    };
  }

  /** `hire.interpret`: its sentence reviewed, a pending proposal's sentences answered by the hand-over or clean. */
  private gateInterpret(a: Obj, review: unknown, pending: unknown, one: Protect, undo: () => void): Gate | null {
    const tok = pending !== undefined ? this.pendingFor(pending, null) : null;
    if (tok?.claimed) throw this.h.error('secrets_review_stale', 'secrets_pending: a hire claimed it: review it again');
    const sources = isObj(a.pending) && Array.isArray(a.pending.sources) ? (a.pending.sources as unknown[]) : [];
    sources.forEach((src, i) => {
      if (typeof src !== 'string' || tok?.texts.has(src)) return;
      const n = detect(src).length;
      if (n) throw this.h.error('secrets_review_required', `pending.sources[${i}]: ${n} possible ${n === 1 ? 'secret' : 'secrets'}: review them`);
    });
    const text = typeof a.text === 'string' ? a.text : '';
    const own = tok?.owner ?? this.newOwner();
    const p = one(text, review, own);
    if (p) a.text = p.text;
    // A new sentence's files join the hand-over's owner, and the answer keeps its token.
    const token = tok ? (pending as string) : review !== undefined ? this.handOver(own, null) : null;
    if (!token && !p) return null;
    return {
      ack: (d) => {
        if (!isObj(d)) return d;
        // An operational error answered nothing to follow up: what this sentence made goes.
        if (isObj(d.error)) {
          undo();
          if (token && !tok) this.tokens.delete(token);
          return d;
        }
        const h = token ? this.tokens.get(token) : undefined;
        if (h) {
          if (typeof d.text === 'string') h.texts.add(d.text);
          const hire = isObj(d.hire) ? d.hire : null;
          if (hire && Array.isArray(hire.sources)) for (const src of hire.sources) if (typeof src === 'string') h.texts.add(src);
          if (hire && isObj(hire.task) && typeof hire.task.value === 'string') h.texts.add(hire.task.value);
        }
        return { ...d, ...(p?.protected ? { protected: p.protected } : {}), ...(token ? { secrets_pending: token } : {}) };
      },
      fail: () => {
        undo();
        if (token && !tok) this.tokens.delete(token);
      },
    };
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
