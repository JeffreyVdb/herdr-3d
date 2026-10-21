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
// #139: the list says `hire` (worker.hire and presets take `codex_profile`). A Codex hire with `codex_profile` gets it
// on its `codex` (`work`: its account confirmed, and the bare home's note; `spare`: refused, not signed in; an unknown
// key: `not_found`). With `simcodexprofiles=2` the seeded Codex workers show the seat's profile line: Pixel (Desk 2 of
// herdr-3d) on `work`, confirmed; Sprocket (Desk 4) woken on `codex` after its profile went; Bean (Desk 10) on `work`
// signed in to another account; the others hired before profiles ("Runs on the default profile"). Both modes start
// with a global hire preset "Review on old-work" on a profile that is gone: its hire form says it hires on the default.
// #140: the list says `auto` and carries the rules: `simcodexprofiles=2` starts with one rule (`github.com/acme/*` →
// work, which no fixture folder matches) and `codex` may be used for anything. `codex_profiles.set` also takes `key`
// with `anything`, and `rules` alone (the bridge's checks, its "Rule N: …" words). A hire with `codex_profile: "auto"`
// is picked as the bridge picks (rules first, the fixture's origin of a folder being `JeffreyVdb/<its name>`, then the
// flagged profiles by their fresh 5-hour left, then the default) and its ack has `codex_profile_reason`.
//
// #167: the list says `share`. With `simcodexprofiles=2`, `work` shares the default's setup and has drifted (its
// config.toml was replaced by a file, `sed -i` style, and the default's skills/ holds a real folder `infra`), the hidden
// `old` shares and shows none, and `spare` does not share and holds its own config.toml. `codex_profiles.share` plays
// the bridge: a dry run's plan (a config.toml in the way is a replace with its backup name), an apply refused unless
// every replace is confirmed ("<folder> changed since you looked; look again."), its report, Fix (share again) clearing
// the drift, and share off; `codex_profiles.move_skill` moves `infra` (only on the default) and its drift goes. A hire
// on `work` says its shared setup drifted.
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import type { CodexDrift, CodexProfile, CodexRule, CodexShareStep, Limits, Worker, WorkerCodex } from '../src/net/protocol.ts';

type Obj = Record<string, unknown>;
type Send = (m: Obj) => void;

const MIN = 60_000;
const MAX_NAME = 40;
const MAX_RULES = 32;
const FORMS = 'github.com/<owner>/* or github.com/<owner>/<repo>';

export interface CodexProfilesHost {
  emit(send: Send, m: Obj): void;
  error(code: string, message: string): Error;
  now(): number;
}

export class CodexProfilesSim {
  private profiles: CodexProfile[];
  private rules: CodexRule[] = [];
  private readonly h: CodexProfilesHost;
  /** #167: per profile, the entries that are regular files where a link to the default's would be. */
  private readonly own = new Map<string, Set<string>>();
  /** #167: the real skill folders in the default's skills/. */
  private readonly skills = new Set<string>();

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
    if (n >= 2) {
      this.profiles.push(p('work', { plan: 'team' }), p('old', { hidden: true }), p('spare', { path: '/srv/codex-spare', display: '/srv/codex-spare', signed_in: false, added: true }));
      this.profiles[0]!.anything = true;
      this.rules = [{ match: 'github.com/acme/*', profile: 'work' }];
      this.profiles[1]!.share = this.profiles[2]!.share = true;
      this.own.set('work', new Set(['config.toml']));
      this.own.set('spare', new Set(['config.toml']));
      this.skills.add('infra');
    }
  }

  /** #167: how a visible shared profile differs from the default, as the bridge words it. */
  private drift(p: CodexProfile): CodexDrift[] {
    if (!p.share || p.hidden || p.default) return [];
    const def = this.profiles.find((x) => x.default)!.name;
    const out: CodexDrift[] = [...(this.own.get(p.key) ?? [])].map((name) => ({
      kind: 'link_replaced',
      name,
      text: `${name} is no longer a link: a file replaced it${name === 'config.toml' ? ` (MCP servers only on ${def}: alterlab, kaneo)` : ''}`,
    }));
    for (const s of this.skills) out.push({ kind: 'skill_only_default', name: s, text: `skill ${s} is only on ${def}` });
    return out;
  }

  decorate(world: Obj): void {
    world.codex_profiles = this.view();
  }

  private view(): Obj {
    const profiles = this.profiles.map((p) => {
      const out: CodexProfile = { ...p };
      const drift = this.drift(p);
      if (drift.length) out.drift = drift;
      return out;
    });
    return { profiles, hire: true, auto: true, runs: true, rules: this.rules.map((r) => ({ ...r })), share: true }; // #167: runs (B), share (A)
  }

  /** #167: the plan of sharing `p` now (the fixture's default has config.toml, AGENTS.md and hooks.json). */
  private plan(p: CodexProfile): CodexShareStep[] {
    const stamp = new Date(this.h.now()).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const own = this.own.get(p.key) ?? new Set<string>();
    const entry = (name: string): CodexShareStep =>
      own.has(name) ? { name, action: 'replace', was: 'file', backup: `${name}.before-share-${stamp}` } : { name, action: p.share ? 'keep' : 'link' };
    return [entry('config.toml'), entry('AGENTS.md'), { name: 'AGENTS.override.md', action: 'skip' }, { name: 'rules/', action: 'skip' }, { name: 'hooks.json', action: p.share ? 'keep' : 'write' }];
  }

  /** #167: codex_profiles.share and .move_skill, as the bridge answers them. */
  private share(t: string, a: Obj, send: Send): Obj {
    const p = this.profiles.find((x) => x.key === a.key);
    const def = this.profiles.find((x) => x.default)!;
    const done = (steps: CodexShareStep[], report?: string): Obj => {
      this.h.emit(send, { t: 'codex_profiles.update', ...this.view() });
      return { ...this.view(), steps, ...(report ? { report } : {}) };
    };
    if (t === 'codex_profiles.move_skill') {
      if (typeof a.key !== 'string' || !a.key || typeof a.skill !== 'string' || !a.skill) throw this.bad('key and skill are required');
      if (!p) throw this.h.error('not_found', `not found: no Codex profile "${a.key}"`);
      if (!p.default || !this.skills.has(a.skill)) throw this.bad(`${p.name} has no skill folder ${a.skill}.`);
      this.skills.delete(a.skill);
      return done([{ name: a.skill, action: 'move' }], `Moved the skill ${a.skill} to ~/.agents/skills/${a.skill} and left a link in ${p.name}'s skills/: every Codex home sees it now.`);
    }
    if (typeof a.key !== 'string' || !a.key) throw this.bad('key is required');
    if (typeof a.share !== 'boolean') throw this.bad('share is required');
    if (!a.share && (a.dry_run || a.replace)) throw this.bad('dry_run and replace are for share: true');
    if (!p) throw this.h.error('not_found', `not found: no Codex profile "${a.key}"`);
    if (p.default) throw this.bad('The default profile is the one the others share from.');
    if (p.missing) throw this.h.error('not_found', `not found: the folder of the Codex profile "${p.name}" no longer exists`);
    const plan = this.plan(p);
    if (a.dry_run) return { ...this.view(), steps: plan };
    if (!a.share) {
      const copied = p.share ? plan.filter((x) => x.action === 'keep' && x.name !== 'hooks.json').map((x) => x.name) : [];
      p.share = false;
      delete p.drift;
      return done(
        copied.map((name) => ({ name, action: 'copy' })),
        copied.length ? `Copied ${names(copied)} from ${def.name}: ${p.name} keeps them as its own and no longer follows ${def.name}. Its hooks.json stays.` : `${p.name} had no links to ${def.name} to copy. Its hooks.json stays.`,
      );
    }
    const confirmed = Array.isArray(a.replace) ? a.replace : [];
    if (plan.some((x) => x.action === 'replace' && !confirmed.includes(x.name))) throw this.bad(`${p.display} changed since you looked; look again.`);
    const linked = plan.filter((x) => (x.action === 'link' || x.action === 'replace') && x.name !== 'hooks.json').map((x) => x.name);
    const backups = plan.filter((x) => x.action === 'replace').map((x) => `the old ${x.name} to ${x.backup}`);
    const wrote = plan.some((x) => x.name === 'hooks.json' && x.action === 'write');
    const parts = [linked.length ? `linked ${names(linked)}` : '', wrote ? 'wrote hooks.json' : '', backups.length ? `backed up ${names(backups)}` : ''].filter(Boolean);
    let report = parts.length ? `${parts.join(', ')}.` : `Nothing to change: ${p.name} already shares ${def.name}'s setup.`;
    report = report[0]!.toUpperCase() + report.slice(1);
    if (wrote) report += ` Codex will ask once to review the hooks of ${p.name}.`;
    p.share = true;
    this.own.delete(p.key);
    return done(plan, report);
  }

  /** #139: a global hire preset on a profile that is gone (`old-work`): the hire form and the preset editor say so. */
  static readonly GONE_PRESET = { name: 'Review on old-work', prompt: 'Review the open pull requests.', harness: 'codex', model: 'gpt-6-sol', effort: 'low', codex_profile: 'old-work' };

  /** #139: the seeded Codex workers' profiles (`simcodexprofiles=2`; ids from fixtures/demo.jsonl). */
  seed(workers: Worker[]): void {
    if (!this.profiles.some((p) => p.key === 'work')) return;
    const on = (id: string, c: Partial<WorkerCodex>) => {
      const w = workers.find((x) => x.id === id);
      if (w) w.codex = { ...(w.codex ?? { mode: 'shared', server: 'running' }), ...c };
    };
    on(PIXEL, { profile: 'work', account: 'confirmed', plan: 'team' });
    on(SPROCKET, { profile: 'codex', profile_note: 'old-work is gone: woke on codex. Its Codex session stays in that folder, so a new one was started.' });
    on(BEAN, { profile: 'work', account: 'mismatch', plan: 'team', profile_note: 'Asked for work, the server signed in to another account.' });
  }

  /**
   * #139: a Codex hire on profile `key`: its `codex` with the profile, as the bridge reports it; a refusal as the bridge's
   * (a profile not signed in fails the hire, an unknown one is not found).
   */
  hire(key: string, codex: WorkerCodex | undefined): WorkerCodex {
    if (key === 'auto') throw this.h.error('bad_request', 'bad args: resolve auto with pick first');
    const p = this.profiles.find((x) => x.key === key && !x.missing);
    if (!p) throw this.h.error('not_found', `not found: no Codex profile "${key}"`);
    const base = codex ?? { mode: 'shared' as const, server: 'running' as const };
    if (p.default) return { ...base, profile: key };
    if (!p.signed_in) throw this.h.error('hire_failed', `hire_failed: ${p.name} is not signed in. Run \`CODEX_HOME=${p.path} codex login\` in a terminal.`);
    const note = setupNote(this.profiles.find((x) => x.default)!.name, { ...p, drift: this.drift(p) }); // #167: its setup first
    const setup = note ? `${note} ` : '';
    return {
      ...base,
      profile: key,
      account: 'confirmed',
      plan: p.plan,
      profile_note: `${setup}${p.name} has no hooks.json with herdr's hook: herdr is not told the worker's Codex session, so the bridge takes its thread from the worker's own Codex server and does not follow a new session started in its terminal (/new).`,
    };
  }

  /**
   * #140: Auto's profile for a hire from `cwd`, and why, in the bridge's words (codexaccount.Pick, simplified: the
   * fixture's origin of a folder is `JeffreyVdb/<its name>`).
   */
  pick(cwd: string, base: Limits | undefined): { key: string; reason: string } {
    const name = cwd.replace(/\/+$/, '').split('/').pop() ?? '';
    const notes: string[] = [];
    const why = (p: CodexProfile, w: string) => ({ key: p.key, reason: `Account: ${p.name} (${[w, ...notes].join('; ')})` });
    for (const r of this.rules) {
      const m = r.match;
      const gh = m.toLowerCase().startsWith('github.com/') ? m.slice(11).split('/') : null;
      const folder = m.startsWith('~') ? `/home/u${m.slice(1)}` : m;
      const hit = gh ? gh[0]!.toLowerCase() === 'jeffreyvdb' && (gh[1] === '*' || gh[1]!.toLowerCase() === name.toLowerCase()) : cwd === folder || cwd.startsWith(`${folder.replace(/\/$/, '')}/`);
      if (!hit) continue;
      const label = gh ? gh.join('/') : m;
      const p = this.profiles.find((x) => x.key === r.profile);
      if (!p || p.missing) notes.push(`rule ${label} names ${p?.name ?? r.profile}, which is gone`);
      else if (p.hidden) notes.push(`rule ${label} names ${p.name}, which is hidden`);
      else if (!p.signed_in) notes.push(`rule ${label} names ${p.name}, which is not signed in`);
      else return why(p, `rule ${label}`);
    }
    const def = this.profiles.find((p) => p.default)!;
    const now = this.h.now();
    const left = (p: CodexProfile, label: string): number | null => {
      const l = this.reading(p, base ?? emptyCodex(now), now);
      const w = l.windows.find((x) => x.label === label && !x.model);
      return !w || l.stale || l.error || now - l.at > 10 * MIN ? null : l.reached ? 0 : 100 - w.pct;
    };
    const cmp = (x: number | null, y: number | null) => (x === y ? 0 : y === null ? 1 : x === null ? -1 : Math.sign(x - y));
    const cands = this.profiles.filter((p) => p.anything && !p.missing && p.signed_in && !p.hidden).map((p) => ({ p, five: left(p, '5h'), week: left(p, 'week') }));
    if (!cands.length) return why(def, `${notes.length ? '' : 'no rule matched, '}no profile may be used for anything: the default`);
    if (cands.length === 1) return why(cands[0]!.p, 'the only profile that may be used for anything');
    type C = (typeof cands)[number];
    const by = (x: C, y: C): [number, string] => {
      const f = cmp(x.five, y.five);
      return f ? [f, '5h'] : [cmp(x.week, y.week), 'week'];
    };
    let best = cands[0]!;
    for (const c of cands.slice(1)) if (by(c, best)[0] > 0) best = c;
    let win = '5h';
    const tied = [best];
    for (const c of cands) {
      if (c === best) continue;
      const [d, w] = by(best, c);
      if (d === 0) tied.push(c);
      else if (w === 'week') win = 'week';
    }
    if (tied.length === 1) return why(best.p, win === '5h' ? `most left: ${Math.round(best.five as number)}% of 5 h` : `most left: ${Math.round(best.week as number)}% of the week`);
    const w = best.five === null && best.week === null ? 'no fresh limits reading' : 'same limits left';
    const d = tied.find((c) => c.p.default);
    return d ? why(d.p, `${w}: the default`) : why(best.p, `${w}: first listed`);
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
    if (t === 'codex_profiles.share' || t === 'codex_profiles.move_skill') {
      ack(this.share(t, a, send));
      return true;
    }
    if (t !== 'codex_profiles.get' && t !== 'codex_profiles.set') return false;
    if (t === 'codex_profiles.set') this.set(a, send, base);
    ack(this.view());
    return true;
  }

  /** #140: the rules as codexaccount.Service.SetRules checks and stores them. */
  private checkRules(rules: CodexRule[]): CodexRule[] {
    if (rules.length > MAX_RULES) throw this.bad(`At most ${MAX_RULES} rules; remove one first.`);
    const out: CodexRule[] = [];
    const seen = new Map<string, number>();
    for (const [i, r] of rules.entries()) {
      const n = i + 1;
      const m = String(r?.match ?? '').trim();
      let stored = m;
      if (!m) throw this.bad(`Rule ${n}: type a repo (${FORMS}) or a folder (/… or ~/…).`);
      if (/[\u0000-\u001f\u007f]/.test(m)) throw this.bad(`Rule ${n}: a match cannot have a line break or a tab in it.`);
      if (m.slice(0, 11).toLowerCase() === 'github.com/') {
        const [owner = '', ...rest] = m.slice(11).split('/');
        const repo = rest.join('/');
        if (!/^[A-Za-z0-9-]{1,39}$/.test(owner)) throw this.bad(`Rule ${n}: "${owner}" is not a GitHub owner: use ${FORMS}.`);
        if (repo !== '*' && !/^[A-Za-z0-9._-]{1,100}$/.test(repo)) throw this.bad(`Rule ${n}: "${repo}" is not a GitHub repo: use ${FORMS}.`);
        stored = `github.com/${owner}/${repo}`;
      } else if (m === '~' || m.startsWith('~/') || m.startsWith('/')) stored = m.length > 1 ? m.replace(/\/+$/, '') : m;
      else throw this.bad(`Rule ${n}: use ${FORMS}, or a folder starting with / or ~/.`);
      const key = stored.startsWith('github.com/') ? stored.toLowerCase() : stored; // GitHub ignores case; a folder keeps it
      const j = seen.get(key);
      if (j !== undefined) throw this.bad(`Rule ${n}: rule ${j} already matches ${stored.replace(/^github\.com\//, '')}.`);
      seen.set(key, n);
      if (!r.profile) throw this.bad(`Rule ${n}: choose the profile it hires on.`);
      if (!this.profiles.some((p) => p.key === r.profile)) throw this.bad(`Rule ${n}: there is no Codex profile "${r.profile}".`);
      out.push({ match: stored, profile: r.profile });
    }
    return out;
  }

  private bad(msg: string): Error {
    return this.h.error('bad_request', `bad args: ${msg}`);
  }

  private set(a: Obj, send: Send, base: () => Limits | undefined): void {
    // As the bridge counts them: add, name, hidden, anything and rules when given (hidden: false shows), remove when true.
    const n = ['add', 'name', 'hidden', 'anything', 'rules'].filter((k) => a[k] !== undefined && a[k] !== null).length + (a.remove === true ? 1 : 0);
    if (n !== 1) throw this.bad('exactly one of add, name, hidden, anything, rules and remove is required');
    let changed: CodexProfile | null = null;
    if (Array.isArray(a.rules)) {
      if (a.key) throw this.bad('rules takes no key');
      this.rules = this.checkRules(a.rules as CodexRule[]);
    } else if (typeof a.add === 'string') {
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
      } else if (typeof a.anything === 'boolean') {
        if (a.anything) p.anything = true;
        else delete p.anything;
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

/**
 * #167: what a Codex hire, or a run's team role, on profile `p` says of its setup, as codexaccount.SetupNote words it
 * (`p.drift` as the list carries it; `def` the default's name): "" on the default or a shared profile in step.
 */
export function setupNote(def: string, p: CodexProfile): string {
  if (p.default) return '';
  if (p.drift?.length) return `${p.name}'s shared setup has drifted from ${def}'s: ${p.drift.map((d) => d.text).join('; ')}.`;
  return p.share ? '' : `${p.name} does not share setup with ${def}: no MCP servers, no herdr hooks.`;
}

/** "a", "a and b", "a, b and c". */
const names = (list: string[]): string => (list.length < 2 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);

const PIXEL = 'fc018d58-4789-46c2-afac-c062bc9fff9e';
const SPROCKET = '0f5107ad-89da-4dd9-a49f-832839d2ca53';
const BEAN = '4c84f4e1-d183-4025-a24b-556d2f5c8bea';

const emptyCodex = (now: number): Limits => ({ provider: 'codex', plan: '', windows: [], at: now, stale: false });
