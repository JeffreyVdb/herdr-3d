// #138: Codex profiles for the fixture server's `sim=1` (tools/fixture-sim.ts hands these commands over and asks it for
// the Codex readings of the plan limits). Off unless `simcodexprofiles=<n>` (then no `codex_profiles` in the snapshot
// and the Codex reading has no account: a bridge before #138). With `simcodexprofiles=2`, like herdr-world:
// - the snapshot's `codex_profiles` lists `codex` (the bridge's own home, ~/.codex, default, prolite), `work`
//   (~/.codex-work, team), `old` (~/.codex-old, hidden) and `spare` (/srv/codex-spare, added, not signed in);
// - the plan limits have a Codex reading per visible profile, each with its `account`: `codex` fresh, `work` a stale
//   one from 50 minutes ago (its probe failed), `spare` no plan;
// - `codex_profiles.set` takes one change (`add`, or `key` with `name`, `hidden` or `remove`), refuses what herdr-world
//   refuses (`bad_request` with its words; an unknown key is `not_found`), and an added path ending in `/nothing` is
//   "no folder there"; a change is a `codex_profiles.update`, a rename also a `limits.update` with the new name, a
//   profile shown or added again its reading.
// `simcodexprofiles=1` is the same with only the default profile (the meter looks as before profiles).
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import type { CodexProfile, Limits } from '../src/net/protocol.ts';

type Obj = Record<string, unknown>;
type Send = (m: Obj) => void;

const MIN = 60_000;
const MAX_NAME = 40;

export interface CodexProfilesHost {
  emit(send: Send, m: Obj): void;
  error(code: string, message: string): Error;
  now(): number;
}

export class CodexProfilesSim {
  private profiles: CodexProfile[];
  private readonly h: CodexProfilesHost;

  constructor(h: CodexProfilesHost, n: number) {
    this.h = h;
    const p = (key: string, o: Partial<CodexProfile>): CodexProfile => ({
      key,
      name: key,
      path: `/home/u/.codex-${key}`,
      display: `~/.codex-${key}`,
      plan: '',
      signed_in: true,
      default: false,
      hidden: false,
      added: false,
      ...o,
    });
    this.profiles = [p('codex', { path: '/home/u/.codex', display: '~/.codex', plan: 'prolite', default: true })];
    if (n >= 2)
      this.profiles.push(p('work', { plan: 'team' }), p('old', { hidden: true }), p('spare', { path: '/srv/codex-spare', display: '/srv/codex-spare', signed_in: false, added: true }));
  }

  decorate(world: Obj): void {
    world.codex_profiles = this.view();
  }

  private view(): Obj {
    return { profiles: this.profiles.map((p) => ({ ...p })) };
  }

  /** The Codex readings at `now`, one per visible profile; `base` is the scenario's own Codex reading (the default's). */
  readings(base: Limits, now: number): Limits[] {
    return this.profiles.filter((p) => !p.hidden).map((p) => this.reading(p, base, now));
  }

  private reading(p: CodexProfile, base: Limits, now: number): Limits {
    const account = { key: p.key, name: p.name, plan: p.plan, default: p.default };
    if (p.default) return { ...base, account: { ...account, plan: base.plan } };
    if (!p.signed_in) return { provider: 'codex', plan: '', windows: [], at: now, stale: false, error: 'no_plan', source: 'probe', account };
    return {
      provider: 'codex',
      plan: p.plan,
      windows: [
        { label: '5h', pct: 72, resets_at: now + 40 * MIN, window_mins: 300 },
        { label: 'week', pct: 38, resets_at: now + 4 * 24 * 60 * MIN, window_mins: 10080 },
      ],
      at: now - 50 * MIN,
      stale: true,
      error: 'failed',
      source: 'probe',
      account,
    };
  }

  handle(t: unknown, a: Obj, send: Send, ack: (d?: unknown) => void, base: () => Limits | undefined): boolean {
    if (t !== 'codex_profiles.get' && t !== 'codex_profiles.set') return false;
    if (t === 'codex_profiles.set') this.set(a, send, base);
    ack(this.view());
    return true;
  }

  private bad(msg: string): Error {
    return this.h.error('bad_request', `bad args: ${msg}`);
  }

  private set(a: Obj, send: Send, base: () => Limits | undefined): void {
    const n = ['add', 'name', 'hidden', 'remove'].filter((k) => a[k] !== undefined && a[k] !== false).length;
    if (n !== 1) throw this.bad('exactly one of add, name, hidden and remove is required');
    let changed: CodexProfile | null = null;
    if (typeof a.add === 'string') {
      const path = a.add.trim();
      if (!path) throw this.bad('Type the folder’s path on the bridge host.');
      if (!path.startsWith('/') && !path.startsWith('~/')) throw this.bad('Use an absolute path on the bridge host, starting with / or ~/.');
      if (path.endsWith('/nothing')) throw this.bad('There is no folder there on the bridge host.');
      const abs = path.startsWith('~/') ? `/home/u/${path.slice(2)}` : path;
      const dup = this.profiles.find((p) => p.path === abs.replace(/\/+$/, ''));
      if (dup) throw this.bad(`That folder is already the profile "${dup.name}".`);
      if (this.profiles.filter((p) => p.added).length >= 16) throw this.bad('At most 16 folders can be added; remove one first.');
      let key = (abs.split('/').filter(Boolean).pop() ?? 'profile').replace(/^\.+/, '').replace(/^codex-/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'profile';
      for (let i = 2, k = key; this.profiles.some((p) => p.key === key); i++) key = `${k}-${i}`;
      changed = { key, name: key, path: abs, display: abs.startsWith('/home/u/') ? `~/${abs.slice(8)}` : abs, plan: '', signed_in: false, default: false, hidden: false, added: true };
      this.profiles.push(changed);
    } else {
      const p = this.profiles.find((x) => x.key === a.key);
      if (typeof a.key !== 'string' || !a.key) throw this.bad('key is required');
      if (!p) throw this.h.error('not_found', `not found: no Codex profile "${a.key}"`);
      if (typeof a.name === 'string') {
        const name = a.name.trim();
        if (!name) throw this.bad('Type a name for the profile.');
        if ([...name].length > MAX_NAME) throw this.bad(`A profile name has at most ${MAX_NAME} characters.`);
        const other = this.profiles.find((x) => x !== p && (x.name.toLowerCase() === name.toLowerCase() || x.key.toLowerCase() === name.toLowerCase()));
        if (other) throw this.bad(`Another profile is called "${other.name}".`);
        p.name = name;
        if (!p.hidden) this.h.emit(send, { t: 'limits.update', ...this.reading(p, base() ?? emptyCodex(this.h.now()), this.h.now()) });
      } else if (typeof a.hidden === 'boolean') {
        if (p.default && a.hidden) throw this.bad("The bridge's own Codex profile cannot be hidden.");
        if (p.hidden !== a.hidden) {
          p.hidden = a.hidden;
          if (!p.hidden) changed = p;
        }
      } else if (a.remove === true) {
        if (!p.added) throw this.bad('A profile the bridge found cannot be removed, only hidden.');
        this.profiles = this.profiles.filter((x) => x !== p);
      } else throw this.bad('expected a string name, a boolean hidden or remove: true');
    }
    this.h.emit(send, { t: 'codex_profiles.update', ...this.view() });
    if (changed) this.h.emit(send, { t: 'limits.update', ...this.reading(changed, base() ?? emptyCodex(this.h.now()), this.h.now()) });
  }
}

const emptyCodex = (now: number): Limits => ({ provider: 'codex', plan: '', windows: [], at: now, stale: false });
