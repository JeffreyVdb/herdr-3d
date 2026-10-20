// M6 start: team presets and starting a run, simulated for the fixture server
// (`sim=1`, see tools/fixture-sim.ts). Rules, like herdr-world's (contract §2):
// - "Build team" is seeded (unless the fixture brings its own `presets`), and
//   the snapshot lists presets by name; `preset.create` / `update` / `delete`
//   validate a name (1-40 bytes, no control characters, unique ignoring case)
//   and all five roles against the hire options; an update that changes
//   nothing sends no event; a delete forgets it as a floor's `last_preset`.
// - `run.prepare` answers the dialog's defaults and the prompt, composed
//   exactly like the bridge's prompt builder (`composePrompt`); an issue
//   number needs the floor's repo (`settings.repo ?? suggested.repo`).
// - `run.start` is `worker.hire` (same rules, same steps and events) with the
//   ORCH's choice, the label and the prompt as its first task; the ORCH gets
//   `role: orch`, its `run` and `issue`, the floor its `last_preset`, and the
//   ack the launch id and the prompt that was sent.
// - `simfail=no_m6` plays an M5 bridge: no `presets`, every command here is
//   `unknown_command`.
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import type { Floor, Hire, HireOptions, Preset, PresetRole, Worker } from '../src/net/protocol.ts';

type Obj = Record<string, unknown>;
type Send = (m: Obj) => void;

export interface StartDeps {
  floors: Map<string, Floor>;
  workers: Worker[];
  hire: HireOptions;
  emit(send: Send, m: Obj): void;
  /** `hire.prepare`'s answer for a floor (throws like it: unknown, asleep, busy); #134 `preview`: local refs, no fetch. */
  prepare(session: string, preview: boolean): Obj;
  /** `worker.hire` as the simulator runs it (validation throws; the ack or the failure comes later). */
  hireWorker(a: Obj, send: Send, ack: (d?: unknown) => void, fail: (e: unknown) => void): void;
  error(code: string, message: string): Error;
  /** M7: a card of the floor's board as an issue of the M6 path (null: not on the board, or no board). */
  /** A board card's ticket: a GitHub issue, or (#184) a provider's item as the tracker read it. */
  workItem?(session: string, wi: { provider?: unknown; id?: unknown }): { repo: string; number: number; url: string } | { item: ItemRef } | null;
}

const ROLES: PresetRole[] = ['orch', 'coder', 'reviewer', 'ux', 'researcher'];

/** The seeded preset (contract §2.1). */
export const SIM_BUILD_TEAM: Preset = {
  id: 'p_5eedb0000001',
  name: 'Build team',
  seeded: true,
  roles: {
    orch: { harness: 'claude', model: 'claude-opus-5-5', effort: 'medium' },
    coder: { harness: 'claude', model: 'claude-opus-5-5', effort: 'medium' },
    reviewer: { harness: 'codex', model: 'gpt-6-sol', effort: 'high' },
    ux: { harness: 'codex', model: 'gpt-6-sol', effort: 'high' },
    researcher: { harness: 'codex', model: 'gpt-6-sol', effort: 'low' },
  },
};

const COMMANDS = new Set(['preset.create', 'preset.update', 'preset.delete', 'run.prepare', 'run.start']);
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const ISSUE_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})\/issues\/(\d+)$/;

/** One team line: `claude claude-opus-5-5, effort medium` / `codex gpt-6-sol, reasoning high`. */
function roleLine(h: Hire): string {
  return `${h.harness} ${h.model}, ${h.harness === 'codex' ? 'reasoning' : 'effort'} ${h.effort}`;
}

/** Added after the team for every ticket (#74): where the orchestrator starts its agents, as the bridge's `placementLine`. */
export const PLACEMENT_LINE = "Start every agent you hire in its own herdr workspace or tab, never in a split pane of your tab or of another agent's tab: a laptop shows a pane at its own size, and a fullscreen terminal is wanted.";
/** #58: the bridge's floorLine: tag the workspaces you create with your floor (a floor id). */
export const floorLine = (floor: string): string =>
  `Also tag every herdr workspace you create with the token h3d_floor=${floor}, in the same herdr workspace report-metadata call as its other h3d_ tokens: it puts that agent on your floor.`;
/** H3D-2: the bridge's agentLine: tag the workspaces you create with the harness, model and effort their agents start with. */
export const AGENT_LINE =
  "Also tag every herdr workspace you create with the tokens h3d_harness, h3d_model and h3d_effort, the harness, model id and effort you start that agent with, in the same herdr workspace report-metadata call as the floor token: the floor shows them as that agent's model line.";
/** #95: the herdr hiring instructions for a floor (the bridge's hireInstructions): `worker.hire` adds them after a blank line. */
export const herdrInstructions = (floor: string): string => `${PLACEMENT_LINE}\n\n${floorLine(floor)}\n\n${AGENT_LINE}`;

/** Added for an issue ticket, after the team: how the issue's status follows the run. */
export const ISSUE_STATUS_LINE = 'Move the ticket status accordingly, pull request always means QA, merging the PR always means Done.';

/** #184: a provider's item a run starts on. */
export interface ItemRef {
  provider: string;
  id: string;
  key: string;
  title: string;
  url: string;
}

/** #102: how a prompt names an item, like the bridge's itemRef: its canonical URL, else "<Provider> task <key>". */
export const itemRef = (provider: string, it: ItemRef): string => it.url || `${provider} task ${it.key}`;

/**
 * The run's first prompt (contract §2.2), like the bridge's runPrompt: `ticket` is the issue URL (`isIssue`), an item's
 * reference (`itemRef`) or the free text; after the team the herdr hiring instructions for `floor` (the floor id).
 */
export function composePrompt(orch: Hire, ticket: string, roles: Record<PresetRole, Hire>, floor: string, extra = '', isIssue = false): string {
  const lines = [
    `${orch.harness === 'codex' ? '$' : '/'}write-code ${ticket.trim()}`,
    '',
    'Team:',
    `- coders: ${roleLine(roles.coder)}`,
    `- reviewers: ${roleLine(roles.reviewer)}`,
    `- ux reviewers: ${roleLine(roles.ux)}`,
    `- researchers: ${roleLine(roles.researcher)}`,
    '',
    herdrInstructions(floor),
  ];
  if (isIssue) lines.push('', ISSUE_STATUS_LINE);
  const x = extra.trim();
  if (x) lines.push('', x);
  return lines.join('\n');
}

/**
 * `ORCH|issue-<n>`, or `ORCH|` and the text's first whole words as a slug
 * (`ORCH|run` when none): the descr at most 10 bytes, like the bridge's runLabel.
 */
export function runLabel(t: { kind: 'issue'; number: number } | { kind: 'text'; text: string } | { kind: 'item'; item: ItemRef }): string {
  if (t.kind === 'issue') return `ORCH|${`issue-${t.number}`.slice(0, 10)}`;
  if (t.kind === 'item') return `ORCH|${t.item.key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 10).replace(/-+$/, '')}`;
  let d = '';
  for (const w of t.text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-')) {
    if (!w) continue;
    if (!d) d = w.slice(0, 10);
    else if (d.length + 1 + w.length <= 10) d += `-${w}`;
    else break;
  }
  return `ORCH|${d || 'run'}`;
}

type Ticket =
  | { kind: 'issue'; repo: string; number: number; url: string }
  | { kind: 'text'; text: string }
  | { kind: 'item'; url: string; item: ItemRef; provider_name: string };

/** A ticket's prompt, like the bridge's TicketPrompt: an item (#102) by its reference, with no status line. */
function ticketPrompt(orch: Hire, t: Ticket, roles: Record<PresetRole, Hire>, floor: string, extra: string): string {
  if (t.kind === 'item') return composePrompt(orch, itemRef(t.provider_name, t.item), roles, floor, extra);
  return composePrompt(orch, t.kind === 'issue' ? t.url : t.text, roles, floor, extra, t.kind === 'issue');
}

export class StartSim {
  private readonly presets = new Map<string, Preset>();
  private next = 0;
  private launches = 0;

  private readonly d: StartDeps;
  readonly enabled: boolean;

  constructor(d: StartDeps, enabled: boolean, fixturePresets?: unknown) {
    this.d = d;
    this.enabled = enabled;
    if (!enabled) return;
    const list = Array.isArray(fixturePresets) ? (fixturePresets as Preset[]) : [SIM_BUILD_TEAM];
    for (const p of list) this.presets.set(p.id, structuredClone(p));
  }

  /** Adds `presets` to a snapshot's world (by name, ignoring case). */
  decorate(world: Obj): void {
    if (this.enabled) world.presets = this.list();
  }

  private list(): Preset[] {
    return [...this.presets.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id));
  }

  /** Answers an M6 command; false for any other (or when playing an M5 bridge). */
  handle(t: unknown, a: Obj, send: Send, ack: (d?: unknown) => void, fail: (e: unknown) => void): boolean {
    if (!this.enabled || typeof t !== 'string' || !COMMANDS.has(t)) return false;
    switch (t) {
      case 'preset.create':
        ack(this.create(a, send));
        break;
      case 'preset.update':
        this.update(a, send);
        ack();
        break;
      case 'preset.delete':
        this.remove(a, send);
        ack();
        break;
      case 'run.prepare':
        ack(this.prepare(a));
        break;
      case 'run.start':
        this.start(a, send, ack, fail);
        break;
    }
    return true;
  }

  // ---- validation ------------------------------------------------------------------

  private bad(m: string): Error {
    return this.d.error('bad_request', `bad args: ${m}`);
  }

  private only(a: Obj, keys: string[]): void {
    for (const k of Object.keys(a)) if (!keys.includes(k)) throw this.bad(`json: unknown field "${k}"`);
  }

  private hireOf(v: unknown, what: string): Hire {
    if (!isObj(v) || typeof v.harness !== 'string' || typeof v.model !== 'string' || typeof v.effort !== 'string') throw this.bad(`${what} must be {harness, model, effort}`);
    const o = this.d.hire[v.harness];
    if (!o) throw this.bad(`${what}: unknown harness ${v.harness}`);
    if (!o.models.includes(v.model)) throw this.bad(`${what}: ${v.harness} has no model ${v.model}`);
    if (![...o.efforts, ...(o.extra_efforts?.[v.model] ?? [])].includes(v.effort)) throw this.bad(`${what}: ${v.model} has no effort ${v.effort}`);
    return { harness: v.harness, model: v.model, effort: v.effort };
  }

  private rolesOf(v: unknown): Record<PresetRole, Hire> {
    if (!isObj(v)) throw this.bad('roles must be an object');
    for (const k of Object.keys(v)) if (!ROLES.includes(k as PresetRole)) throw this.bad(`roles: unknown role "${k}"`);
    return Object.fromEntries(ROLES.map((r) => [r, this.hireOf(v[r], `roles.${r}`)])) as Record<PresetRole, Hire>;
  }

  private nameOf(v: unknown, except = ''): string {
    if (typeof v !== 'string') throw this.bad('name must be a string');
    const n = v.trim();
    if (!n || bytes(n) > 40 || [...n].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw this.d.error('bad_request', 'invalid argument: preset name must be 1-40 bytes without control characters');
    for (const p of this.presets.values()) if (p.id !== except && p.name.toLowerCase() === n.toLowerCase()) throw this.d.error('name_taken', `name already used: "${n}"`);
    return n;
  }

  private preset(id: unknown): Preset {
    if (typeof id !== 'string') throw this.bad('id must be a string');
    const p = this.presets.get(id);
    if (!p) throw this.d.error('not_found', `not found: preset "${id}"`);
    return p;
  }

  // ---- presets ---------------------------------------------------------------------

  private create(a: Obj, send: Send): { id: string } {
    this.only(a, ['name', 'roles']);
    const name = this.nameOf(a.name);
    const roles = this.rolesOf(a.roles);
    const id = `p_${(0x51a000000000 + ++this.next).toString(16)}`;
    const p: Preset = { id, name, roles };
    this.presets.set(id, p);
    this.d.emit(send, { t: 'preset.upsert', preset: p });
    return { id };
  }

  private update(a: Obj, send: Send): void {
    this.only(a, ['id', 'name', 'roles']);
    const p = this.preset(a.id);
    const name = a.name === undefined ? p.name : this.nameOf(a.name, p.id);
    const roles = a.roles === undefined ? p.roles : this.rolesOf(a.roles);
    if (name === p.name && JSON.stringify(roles) === JSON.stringify(p.roles)) return;
    const next: Preset = { ...p, name, roles };
    this.presets.set(p.id, next);
    this.d.emit(send, { t: 'preset.upsert', preset: next });
  }

  private remove(a: Obj, send: Send): void {
    this.only(a, ['id']);
    const p = this.preset(a.id);
    this.presets.delete(p.id);
    this.d.emit(send, { t: 'preset.removed', id: p.id });
    for (const f of this.d.floors.values()) {
      if (f.last_preset !== p.id) continue;
      delete f.last_preset;
      this.d.emit(send, { t: 'floor.upsert', floor: f });
    }
  }

  // ---- runs ------------------------------------------------------------------------

  private repoOf(f: Floor): string | undefined {
    return f.settings?.repo ?? f.suggested?.repo;
  }

  /** The ticket of `issue` / `text` (`need`: one of them must be there). */
  private ticket(a: Obj, f: Floor, need: boolean): Ticket | null {
    // Like the bridge: an empty text or a null issue is no ticket.
    const hasIssue = a.issue !== undefined && a.issue !== null;
    const hasText = a.text !== undefined && a.text !== '';
    const hasItem = a.work_item !== undefined && a.work_item !== null;
    if (Number(hasIssue) + Number(hasText) + Number(hasItem) > 1) throw this.bad('give either an issue, a text or a work_item, not several');
    if (hasItem) {
      const wi = a.work_item;
      if (!isObj(wi) || typeof wi.provider !== 'string' || typeof wi.id !== 'string') throw this.bad('work_item must be {provider, id}');
      const got = this.d.workItem?.(f.session, wi);
      if (!got) throw this.d.error('not_found', `not found: work item "${wi.id}"`);
      if ('item' in got) return { kind: 'item', url: got.item.url, item: got.item, provider_name: got.item.provider === 'kaneo' ? 'Kaneo' : got.item.provider };
      return { kind: 'issue', repo: got.repo, number: got.number, url: got.url };
    }
    if (hasText) {
      if (typeof a.text !== 'string' || !a.text.trim() || bytes(a.text.trim()) > 4096) throw this.bad('text must be 1-4096 bytes of text');
      return { kind: 'text', text: a.text.trim() };
    }
    if (!hasIssue) {
      if (need) throw this.bad('issue or text is required');
      return null;
    }
    let n: number;
    let repo = this.repoOf(f);
    if (typeof a.issue === 'number') n = a.issue;
    else if (typeof a.issue === 'string') {
      const s = a.issue.trim();
      const url = ISSUE_URL.exec(s);
      if (url) {
        repo = url[1];
        n = Number(url[2]);
      } else if (/^#?\d+$/.test(s)) n = Number(s.replace('#', ''));
      else throw this.bad(`issue ${JSON.stringify(a.issue)}: want a number, "#<n>" or https://github.com/<owner>/<repo>/issues/<n>`);
    } else throw this.bad('issue must be a number or a string');
    if (!Number.isInteger(n) || n < 1 || n > 2 ** 31 - 1) throw this.bad(`issue must be a positive integer, got ${n}`);
    if (!repo) throw this.bad("the floor has no linked repo: set its repo, or give the issue's URL");
    return { kind: 'issue', repo, number: n, url: `https://github.com/${repo}/issues/${n}` };
  }

  private extraOf(a: Obj): string {
    if (a.extra === undefined) return '';
    if (typeof a.extra !== 'string' || bytes(a.extra) > 8192) throw this.bad('extra must be at most 8192 bytes');
    return a.extra;
  }

  /** The floor's last preset, else "Build team", else the first; null when there is none. */
  private defaultPreset(f: Floor): Preset | null {
    const list = this.list();
    return (f.last_preset && this.presets.get(f.last_preset)) || list.find((x) => x.name === SIM_BUILD_TEAM.name) || list[0] || null;
  }

  private floorOf(a: Obj): Floor {
    if (typeof a.session !== 'string') throw this.bad('session must be a string');
    const f = this.d.floors.get(a.session);
    if (!f) throw this.d.error('unknown_session', `unknown session: "${a.session}"`);
    return f;
  }

  private prepare(a: Obj): Obj {
    this.only(a, ['session', 'issue', 'text', 'work_item', 'preset', 'orch', 'extra', 'preview']);
    if (a.preview !== undefined && typeof a.preview !== 'boolean') throw this.bad('preview must be a bool');
    const f = this.floorOf(a);
    const t = this.ticket(a, f, false);
    const p = a.preset === undefined || a.preset === '' ? this.defaultPreset(f) : this.preset(a.preset);
    // No preset at all: preset "", orch as asked (else null), no prompt.
    const orch = a.orch !== undefined && a.orch !== null ? this.hireOf(a.orch, 'orch') : (p?.roles.orch ?? null);
    const extra = this.extraOf(a);
    const h = this.d.prepare(f.session, a.preview === true);
    return {
      prompt: t && p && orch ? ticketPrompt(orch, t, p.roles, f.session, extra) : '',
      label: t ? runLabel(t) : '',
      ticket: t,
      preset: p?.id ?? '',
      orch,
      cwd: h.cwd,
      git: h.git,
      capacity: h.capacity,
    };
  }

  private start(a: Obj, send: Send, ack: (d?: unknown) => void, fail: (e: unknown) => void): void {
    this.only(a, ['session', 'desk_index', 'issue', 'text', 'work_item', 'orch', 'preset', 'extra', 'worktree', 'label', 'prompt']);
    const f = this.floorOf(a);
    const t = this.ticket(a, f, true) as Ticket;
    const orch = this.hireOf(a.orch, 'orch');
    const p = this.preset(a.preset);
    const extra = this.extraOf(a);
    if (a.worktree !== undefined && typeof a.worktree !== 'boolean') throw this.bad('worktree must be a bool');
    if (a.label !== undefined && typeof a.label !== 'string') throw this.bad('label must be a string');
    if (a.prompt !== undefined && typeof a.prompt !== 'string') throw this.bad('prompt must be a string');
    // An empty prompt is none: the bridge composes it (an edited one goes through worker.hire's rules). The hiring
    // instructions are in it already: like the bridge's run.start, the hire carries no herdr_instructions.
    const prompt = (a.prompt as string | undefined) || ticketPrompt(orch, t, p.roles, f.session, extra);
    const label = (a.label as string | undefined) || runLabel(t);
    const worktree = a.worktree ?? true;
    const hire: Obj = { session: f.session, desk_index: a.desk_index, harness: orch.harness, model: orch.model, effort: orch.effort, label, worktree, prompt };
    const launch = `l_${(++this.launches).toString(16).padStart(16, '0')}`;
    this.d.hireWorker(
      hire,
      send,
      (data) => {
        const d = (data ?? {}) as Obj;
        const w = this.d.workers.find((x) => x.id === d.id);
        if (w) {
          // Like the bridge's label fallback: role and run from `ORCH|<descr>`; the issue from the launch.
          const x = w as Worker & { issue?: { repo: string; number: number } };
          x.role = 'orch';
          x.run = label.slice(label.indexOf('|') + 1);
          if (t.kind === 'item') {
            // #184: the run's item, never a GitHub issue.
            (x as Worker & { work_item?: ItemRef }).work_item = { ...t.item };
          } else if (t.kind === 'issue') {
            x.issue = { repo: t.repo, number: t.number };
            // M7: the neutral form of the same link, in the same event (before the ack).
            (x as Worker & { work_item?: { provider: string; id: string } }).work_item = { provider: 'github', id: `${t.repo}#${t.number}` };
          }
          this.d.emit(send, { t: 'worker.upsert', worker: w });
        }
        if (this.presets.has(p.id) && f.last_preset !== p.id) {
          f.last_preset = p.id;
          this.d.emit(send, { t: 'floor.upsert', floor: f });
        }
        ack({ ...d, launch_id: launch, prompt });
      },
      fail,
    );
  }
}
