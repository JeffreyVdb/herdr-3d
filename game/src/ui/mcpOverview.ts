import type { CommandResult } from '../net/client';
import type { CodexProfile, McpHarness, McpProvider, McpSkill } from '../net/protocol';
import type { McpChoice, McpView } from '../mcp/link';
import {
  ageOf,
  ageText,
  attentionCount,
  cellNextStep,
  cellStale,
  cellText,
  checkText,
  configKnown,
  configWhole,
  evidenceText,
  expectedNameError,
  HARNESSES,
  mcpRows,
  observedText,
  PROVIDER_NAME,
  providerNextStep,
  providerTone,
  skillsStale,
  sourceText,
  statusTone,
  type McpCell,
  type ProviderTone,
  type Received,
} from '../world/mcp';
import { h, icon, ICON } from './dom';
import { Sheet } from './sheet';
import './mcpOverview.css';

/**
 * #196: the MCP & skills overview (E at the wall screen over the rack, or the command palette): the MCP servers and the
 * skills the floor's agents (Claude Code and Codex) have, for a checkout and a Codex profile. Read-only but for three
 * things: Refresh (`mcp.inventory` again), each provider's "Check connections" (`mcp.check`, which starts the configured
 * servers: said next to the button) and the floor's expected servers (`floor.settings.set {expected_mcp}`, offered only
 * when the bridge says it has them). It never edits credentials, authorizes a server, installs a plugin or restarts a
 * worker: the next steps it shows say what to do, where.
 *
 * A modal `Sheet` (ui/sheet.ts): focus stays inside, Esc closes, focus goes back where it was, a bottom sheet on a phone.
 * It holds an edit (the expected list), so a click on the backdrop never closes it (CONTRIBUTING: dialogs never close
 * by accident). A saved list is the page's until an inventory asked after the save answers: one asked before may still
 * carry the old list (the bridge reads it when a read starts), and the next edit starts from what was saved.
 * The rows come from the client merge rule (world/mcp.ts `mcpRows`); both providers are always shown, each cell per
 * provider (the same name in both is one row, not one service). What the page shows is the link's (mcp/link.ts): the
 * Snapshot of exactly the chosen context, never a late one of another.
 */

export interface McpOverviewHost {
  view(floor: string): McpView;
  choose(floor: string, c: McpChoice): void;
  refresh(): void;
  check(h: McpHarness): void;
  /** The bridge's Codex profiles, hidden ones left out (null: a bridge without profiles: only the default). */
  profiles(): CodexProfile[] | null;
  /** `floor.settings.set {floor, expected_mcp}`. */
  saveExpected(floor: string, names: string[] | null): Promise<CommandResult>;
  floorName(floor: string): string;
  /** Wall-clock ms (`Date.now`). */
  now(): number;
  closed(): void;
}

/** What a test can read of the page. */
export interface McpOverviewSummary {
  open: boolean;
  floor: string;
  /** The checkout and profile the shown data is for (null: none shown yet). */
  context: { cwd: string | null; codex_profile: string } | null;
  state: 'unsupported' | 'offline' | 'loading' | 'error' | 'data';
  providers: Array<{ harness: McpHarness; tone: ProviderTone | null; servers: number; attention: number; checking: boolean; check: string }>;
  rows: Array<{ name: string; expected: boolean; claude: string; codex: string; missing: boolean }>;
  skills: Record<McpHarness, { count: number; incomplete: boolean; disabled: number; errors: number }>;
  expectedEditable: boolean;
  expected: string[];
  status: string;
}

const USER_SCOPE = '\u0000user';
const DEFAULT = '\u0000default';
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const TONE_WORD: Record<ProviderTone, string> = {
  ok: 'Fresh',
  partial: 'Partial read',
  stale: 'Stale',
  pending: 'Reading',
  failed: 'Couldn’t read',
  unavailable: 'CLI not found',
  unsupported: 'Not supported',
};

const INVOCATION: Record<string, string> = { both: 'You or the model', user_only: 'Only you', model_only: 'Only the model' };

export class McpOverview {
  private readonly sheet: Sheet;
  private readonly ctxBar = h('div', { class: 'mcp-ctx' });
  private readonly cwdSel = h('select', { class: 'mcp-select', id: 'mcp-cwd', 'data-key': 'cwd' });
  private readonly profSel = h('select', { class: 'mcp-select', id: 'mcp-profile', 'data-key': 'profile' });
  private readonly profField: HTMLElement;
  private readonly refreshBtn: HTMLButtonElement;
  private readonly readEl = h('span', { class: 'mcp-read', role: 'status' });
  private readonly main = h('div', { class: 'mcp-main' });
  private readonly expectedBox = h('section', { class: 'mcp-expected', 'aria-labelledby': 'mcp-exp-title' });
  private readonly expInput = h('input', { class: 'mcp-input', id: 'mcp-exp-input', type: 'text', autocomplete: 'off', spellcheck: false, placeholder: 'Server name, e.g. github', 'data-key': 'exp-input' }) as HTMLInputElement;
  private readonly expChips = h('ul', { class: 'mcp-chips', 'aria-label': 'Expected servers' });
  private readonly expMsg = h('p', { class: 'mcp-exp-msg', role: 'status' });
  private readonly expSave: HTMLButtonElement;
  private floor = '';
  /** The expected list being edited (null: as saved). */
  private draft: string[] | null = null;
  /** The list the bridge acknowledged saving for `floor`: it stands until a Snapshot of a request after `after` (McpView.sent then) comes. */
  private acked: { floor: string; names: string[]; after: number } | null = null;
  private saving = false;
  private expText = '';
  private expError = false;
  private lastSig = '';

  constructor(private readonly host: McpOverviewHost) {
    this.sheet = new Sheet({ label: 'MCP & skills', className: 'mcp', backdrop: 'none', onClose: () => this.host.closed(), initialFocus: () => this.cwdSel });
    this.refreshBtn = h('button', { class: 'btn btn--sm', 'data-key': 'refresh', title: 'Read the configuration again', onclick: () => this.host.refresh() }, icon(ICON.refresh), h('span', {}, 'Refresh'));
    this.profField = h('label', { class: 'mcp-field', for: 'mcp-profile' }, h('span', {}, 'Codex profile'), this.profSel);
    this.ctxBar.append(h('label', { class: 'mcp-field', for: 'mcp-cwd' }, h('span', {}, 'Checkout'), this.cwdSel), this.profField, h('div', { class: 'mcp-refresh' }, this.refreshBtn, this.readEl));
    this.cwdSel.addEventListener('change', () => this.pick());
    this.profSel.addEventListener('change', () => this.pick());

    this.expSave = h('button', { class: 'btn btn--sm btn--primary', 'data-key': 'exp-save', onclick: () => void this.saveExpected() }, 'Save list');
    const add = () => this.addExpected();
    this.expInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        add();
      }
    });
    this.expectedBox.append(
      h('div', { class: 'mcp-exp-head' }, h('h4', { id: 'mcp-exp-title' }, 'Expected on this floor'), h('p', { class: 'mcp-hint' }, 'A server on this list that a provider does not have shows as missing there.')),
      this.expChips,
      h('div', { class: 'mcp-exp-add' }, h('label', { class: 'visually-hidden', for: 'mcp-exp-input' }, 'Add an expected server'), this.expInput, h('button', { class: 'btn btn--sm', 'data-key': 'exp-add', onclick: add }, icon(ICON.plus), h('span', {}, 'Add')), this.expSave),
      this.expMsg,
    );
    this.sheet.body.append(this.ctxBar, this.main);
  }

  get isOpen(): boolean {
    return this.sheet.isOpen;
  }

  get el(): HTMLDialogElement {
    return this.sheet.el;
  }

  open(floor: string): void {
    this.floor = floor;
    this.draft = null;
    this.expText = '';
    this.expInput.value = '';
    this.lastSig = '';
    this.sheet.setLabel(`MCP & skills on ${this.host.floorName(floor)}`, 'MCP & skills');
    this.render(true);
    this.sheet.open();
  }

  close(): void {
    this.sheet.close();
  }

  /** The link's data changed (or a minute went by): redrawn when what it shows changed. */
  refresh(): void {
    if (this.sheet.isOpen) this.render(false);
  }

  private view(): McpView {
    return this.host.view(this.floor);
  }

  private pick(): void {
    const c: McpChoice = {};
    const cwd = this.cwdSel.value;
    if (cwd === USER_SCOPE) c.cwd = null;
    else if (cwd !== DEFAULT) c.cwd = cwd;
    const prof = this.profSel.value;
    const def = this.host.profiles()?.find((p) => p.default)?.key;
    if (prof && prof !== DEFAULT && prof !== def) c.codex_profile = prof;
    this.host.choose(this.floor, c);
  }

  private render(force: boolean): void {
    const v = this.view();
    const now = this.host.now();
    // The bridge's list counts again once a Snapshot asked after the save is in.
    if (this.acked?.floor === this.floor && v.received && v.seq > this.acked.after) this.acked = null;
    // Only what is shown: a minute's ages, the data, the requests out, the draft; never every frame.
    const sig = JSON.stringify([v, this.draft, this.acked, this.saving, this.expText, Math.floor(now / 60_000), this.host.profiles()]);
    if (!force && sig === this.lastSig) return;
    this.lastSig = sig;
    this.renderContext(v, now);
    this.renderMain(v, now);
  }

  private renderContext(v: McpView, now: number): void {
    const r = v.received;
    // Checkout: the floor's default until the bridge said which it is, its checkouts, user scope only.
    const opts: HTMLOptionElement[] = [];
    const cw = v.choice.cwd;
    if (!r && cw === undefined) opts.push(h('option', { value: DEFAULT }, 'The floor’s default checkout'));
    for (const c of r?.snap.checkouts ?? []) opts.push(h('option', { value: c.path }, `${c.label} · ${c.display}`));
    if (typeof cw === 'string' && !opts.some((o) => o.value === cw)) opts.push(h('option', { value: cw }, cw));
    opts.push(h('option', { value: USER_SCOPE }, 'User scope only (no project)'));
    const cur = cw === null ? USER_SCOPE : cw !== undefined ? cw : r ? (r.snap.context.cwd ?? USER_SCOPE) : DEFAULT;
    this.fill(this.cwdSel, opts, cur);
    // Codex profile: the bridge's visible ones; without profiles there is only the default and no picker.
    const profiles = this.host.profiles();
    this.profField.hidden = !profiles || profiles.length < 2;
    if (profiles) {
      const def = profiles.find((p) => p.default)?.key ?? DEFAULT;
      this.fill(
        this.profSel,
        profiles.map((p) => h('option', { value: p.key }, p.default ? `${p.name} (default)` : p.name)),
        v.choice.codex_profile ?? def,
      );
    }
    const disabled = v.unsupported || !v.live;
    this.cwdSel.disabled = this.profSel.disabled = disabled;
    this.refreshBtn.disabled = disabled || v.asking;
    this.readEl.textContent = v.asking ? 'Reading…' : r ? `Read ${ageText(ageOf(r.snap.generated_at, r, now))}` : '';
  }

  /** Replaces a select's options only when they differ (a redraw keeps an open picker and the focus). */
  private fill(sel: HTMLSelectElement, opts: HTMLOptionElement[], value: string): void {
    const want = opts.map((o) => `${o.value}\u0001${o.textContent}`).join('\u0002');
    const have = [...sel.options].map((o) => `${o.value}\u0001${o.textContent}`).join('\u0002');
    if (want !== have) sel.replaceChildren(...opts);
    if (sel.value !== value) sel.value = value;
  }

  private renderMain(v: McpView, now: number): void {
    const focus = document.activeElement instanceof HTMLElement && this.main.contains(document.activeElement) ? document.activeElement.dataset.key : undefined;
    const parts: Node[] = [];
    if (v.unsupported) parts.push(this.calm('No MCP inventory on this bridge', 'Update herdr-world to see the MCP servers and skills of this floor’s agents here.'));
    else if (!v.live) parts.push(this.calm('Not connected to the bridge', 'This fills in again when the bridge is back.'));
    else if (v.error && !v.received) parts.push(this.calm('The bridge can’t read this context', v.error));
    else if (!v.received) parts.push(this.calm('Reading the configuration…', 'Configuration files only: no server is started for this.', true));
    else parts.push(...this.data(v, v.received, now));
    this.main.replaceChildren(...parts);
    if (focus) this.main.querySelector<HTMLElement>(`[data-key="${CSS.escape(focus)}"]`)?.focus({ preventScroll: true });
  }

  private calm(title: string, text: string, busy = false): HTMLElement {
    return h('div', { class: 'mcp-calm', 'aria-busy': busy ? 'true' : null }, h('p', { class: 'mcp-calm-title' }, title), h('p', {}, text));
  }

  private data(v: McpView, r: Received, now: number): Node[] {
    const snap = r.snap;
    const saved = this.savedExpected();
    const expected = this.draft ?? saved;
    const rows = mcpRows({ providers: snap.providers, expected: saved });
    const out: Node[] = [];
    if (v.error) out.push(h('p', { class: 'mcp-error', role: 'alert' }, v.error));

    // The providers: what each has, its read's state, its check.
    out.push(h('div', { class: 'mcp-providers' }, ...HARNESSES.map((hh) => this.providerTile(hh, snap.providers[hh], r, v, now, saved))));

    // MCP servers.
    const list = h('ul', { class: 'mcp-rows', 'aria-label': 'MCP servers' });
    for (const row of rows) {
      list.append(
        h(
          'li',
          { class: `mcp-row${row.missing ? ' mcp-row--missing' : ''}`, 'data-name': row.name },
          h('div', { class: 'mcp-row-name' }, h('span', { class: 'mcp-name' }, row.name), row.expected ? h('span', { class: 'mcp-tag' }, 'Expected') : null),
          ...HARNESSES.map((hh) => this.cell(row.cells[hh], hh, snap.providers[hh], r, now)),
        ),
      );
    }
    const servers = h(
      'section',
      { class: 'mcp-section', 'aria-labelledby': 'mcp-servers-title' },
      h('div', { class: 'mcp-section-head' }, h('h3', { id: 'mcp-servers-title' }, 'MCP servers'), h('div', { class: 'mcp-cols', 'aria-hidden': 'true' }, h('span', {}, PROVIDER_NAME.claude), h('span', {}, PROVIDER_NAME.codex))),
      rows.length ? list : h('p', { class: 'mcp-empty' }, HARNESSES.every((hh) => configWhole(snap.providers[hh])) ? 'Neither provider has an MCP server configured for this checkout.' : 'Nothing to list until a provider’s configuration has been read.'),
    );
    if (snap.expected !== undefined) {
      this.renderExpected(expected, saved);
      servers.append(this.expectedBox);
    }
    out.push(servers);

    // Skills.
    out.push(
      h(
        'section',
        { class: 'mcp-section', 'aria-labelledby': 'mcp-skills-title' },
        h('div', { class: 'mcp-section-head' }, h('h3', { id: 'mcp-skills-title' }, 'Skills')),
        h('div', { class: 'mcp-skills' }, ...HARNESSES.map((hh) => this.skills(hh, snap.providers[hh], r, now))),
      ),
    );
    return out;
  }

  private providerTile(hh: McpHarness, p: McpProvider, r: Received, v: McpView, now: number, expected: readonly string[]): HTMLElement {
    const tone = providerTone(p, r, now);
    const known = configKnown(p) || tone === 'stale';
    const n = attentionCount(p, expected);
    const ctx = r.snap.context;
    const scope = hh === 'claude' ? `Config ${ctx.claude_config}` : `Profile ${ctx.codex_profile_name || 'default'}`;
    const where = ctx.cwd === null ? 'user scope only' : ctx.cwd_display || ctx.cwd;
    const next = providerNextStep(hh, p);
    const checking = v.checking[hh];
    // A check the bridge did not start (busy: no time, its note says why) is not "not checked yet"; the button works again.
    const checkLine = checking ? 'Checking…' : checkText(p, r, now) || (p.check.state === 'skipped' ? 'Check not started' : 'Not checked yet');
    const canCheck = p.available && p.config.state !== 'unsupported' && v.live && !v.unsupported;
    return h(
      'article',
      { class: `mcp-prov mcp-prov--${tone}`, 'data-harness': hh, 'aria-labelledby': `mcp-prov-${hh}` },
      h('header', { class: 'mcp-prov-head' }, h('h3', { id: `mcp-prov-${hh}` }, PROVIDER_NAME[hh]), h('span', { class: `mcp-state mcp-state--${tone}` }, TONE_WORD[tone])),
      h('p', { class: 'mcp-prov-count' }, known ? plural(p.servers.length, 'MCP server', 'MCP servers') : '—'),
      known ? h('p', { class: n > 0 ? 'mcp-attn' : 'mcp-calm-line' }, n > 0 ? `${n} need${n === 1 ? 's' : ''} attention` : 'Nothing needs attention') : null,
      h('p', { class: 'mcp-meta' }, [scope, where, p.version && `v${p.version}`, p.config.read_at && `read ${ageText(ageOf(p.config.read_at, r, now))}`].filter(Boolean).join(' · ')),
      p.reason || p.config.note ? h('p', { class: 'mcp-note' }, [p.reason, p.config.note].filter(Boolean).join('. ')) : null,
      next ? h('p', { class: 'mcp-next' }, next) : null,
      h(
        'div',
        { class: 'mcp-check' },
        h('button', { class: 'btn btn--sm', 'data-key': `check-${hh}`, disabled: !canCheck || checking, 'aria-describedby': `mcp-check-note-${hh}`, onclick: () => this.host.check(hh) }, checking ? 'Checking connections…' : 'Check connections'),
        h('span', { class: 'mcp-check-age', role: 'status' }, checkLine),
        h('p', { class: 'mcp-hint', id: `mcp-check-note-${hh}` }, 'Starts the configured servers once to see whether they connect.', p.check.note ? ` ${p.check.note}` : ''),
      ),
    );
  }

  private cell(c: McpCell, hh: McpHarness, p: McpProvider, r: Received, now: number): HTMLElement {
    const stale = cellStale(c, p, r, now);
    const s = c.server;
    const tone = c.kind === 'present' && s ? statusTone(s.status, stale) : c.kind === 'missing' ? 'warn' : 'muted';
    // Where the status came from and when: the configuration's read, the separate check's or the worker's time.
    const meta = s ? [sourceText(s), s.transport !== 'unknown' ? s.transport : '', evidenceText(s), observedText(s, p, r, now)].filter(Boolean).join(' · ') : '';
    const next = cellNextStep(c, hh);
    return h(
      'div',
      { class: `mcp-cell mcp-cell--${c.kind}`, 'data-harness': hh },
      h('span', { class: 'mcp-cell-prov' }, PROVIDER_NAME[hh]),
      h('p', { class: `mcp-status mcp-status--${tone}` }, h('i', { class: 'mcp-pip', 'aria-hidden': 'true' }), cellText(c, hh), stale && c.kind === 'present' ? h('span', { class: 'mcp-tag mcp-tag--stale' }, 'stale') : null),
      meta ? h('p', { class: 'mcp-meta' }, meta) : null,
      s?.reason ? h('p', { class: 'mcp-note' }, s.reason) : null,
      next ? h('p', { class: 'mcp-next' }, next) : null,
    );
  }

  private skills(hh: McpHarness, p: McpProvider, r: Received, now: number): HTMLElement {
    const sk = p.skills;
    const known = sk.state === 'ok' || sk.state === 'partial' || (sk.items.length > 0 && !!sk.read_at);
    const stale = skillsStale(p, r, now);
    const items = [...sk.items].sort((a, b) => a.name.localeCompare(b.name));
    return h(
      'div',
      { class: 'mcp-skill-col', 'data-harness': hh },
      h(
        'h4',
        {},
        PROVIDER_NAME[hh],
        h('span', { class: 'mcp-count' }, known ? ` · ${plural(items.length, 'skill', 'skills')}` : ''),
        !sk.complete && known ? h('span', { class: 'mcp-tag' }, 'Incomplete list') : null,
        stale ? h('span', { class: 'mcp-tag mcp-tag--stale' }, 'stale') : null,
      ),
      sk.note ? h('p', { class: 'mcp-hint' }, sk.note) : null,
      !known ? h('p', { class: 'mcp-empty' }, sk.state === 'pending' ? 'Reading the skills…' : sk.state === 'unavailable' ? 'The CLI is not on the bridge host.' : 'The skills could not be read.') : null,
      known && !items.length ? h('p', { class: 'mcp-empty' }, 'No skills found.') : null,
      items.length ? h('ul', { class: 'mcp-skill-list', 'aria-label': `${PROVIDER_NAME[hh]} skills` }, ...items.map((s) => this.skill(s))) : null,
      sk.errors.length
        ? h('div', { class: 'mcp-skill-errors' }, h('p', { class: 'mcp-attn' }, `${plural(sk.errors.length, 'skill', 'skills')} could not be loaded`), h('ul', {}, ...sk.errors.map((e) => h('li', {}, h('span', { class: 'mcp-path' }, e.where), ` ${e.message}`))))
        : null,
    );
  }

  private skill(s: McpSkill): HTMLElement {
    const meta = [sourceText({ source: s.source, plugin: s.plugin }), INVOCATION[s.invocation] ?? '', s.where].filter(Boolean);
    return h(
      'li',
      { class: `mcp-skill${s.enabled === false ? ' mcp-skill--off' : ''}` },
      h('p', { class: 'mcp-skill-name' }, s.name, s.enabled === false ? h('span', { class: 'mcp-tag' }, 'Disabled') : null),
      s.description ? h('p', { class: 'mcp-skill-desc' }, s.description) : null,
      h('p', { class: 'mcp-meta' }, meta.join(' · ')),
    );
  }

  // ---- the expected list ----------------------------------------------------------------------------------------------

  private renderExpected(list: readonly string[], saved: readonly string[]): void {
    this.expChips.replaceChildren(
      ...list.map((n) =>
        h('li', { class: 'mcp-chip' }, h('span', {}, n), h('button', { class: 'btn btn--icon btn--sm', 'data-key': `exp-remove-${n}`, 'aria-label': `Remove ${n}`, title: `Remove ${n}`, disabled: this.saving, onclick: () => this.removeExpected(n) }, icon(ICON.close))),
      ),
    );
    if (!list.length) this.expChips.append(h('li', { class: 'mcp-hint' }, 'None yet.'));
    const dirty = this.draft !== null && JSON.stringify(this.draft) !== JSON.stringify(saved);
    this.expSave.disabled = !dirty || this.saving;
    this.expSave.textContent = this.saving ? 'Saving…' : 'Save list';
    this.expInput.disabled = this.saving;
    this.expMsg.textContent = this.expText;
    this.expMsg.classList.toggle('mcp-exp-msg--error', this.expError);
  }

  /** The floor's expected list as saved: the one the bridge acknowledged, until a later Snapshot has it, else the Snapshot's. */
  private savedExpected(): string[] {
    if (this.acked?.floor === this.floor) return [...this.acked.names];
    return [...(this.view().received?.snap.expected ?? [])];
  }

  private addExpected(): void {
    const list = this.draft ?? this.savedExpected();
    const why = expectedNameError(this.expInput.value, list);
    if (why) {
      this.say(why, true);
      this.expInput.focus();
      return;
    }
    this.draft = [...list, this.expInput.value.trim()];
    this.expInput.value = '';
    this.say('', false);
    this.render(true);
    this.expInput.focus();
  }

  private removeExpected(name: string): void {
    this.draft = (this.draft ?? this.savedExpected()).filter((n) => n !== name);
    this.say('', false);
    this.render(true);
    this.expInput.focus();
  }

  private async saveExpected(): Promise<void> {
    if (this.draft === null || this.saving) return;
    const names = this.draft;
    this.saving = true;
    this.render(true);
    const floor = this.floor;
    const r = await this.host.saveExpected(floor, names.length ? names : null);
    this.saving = false;
    if (r.ok) {
      // Saved: this list stands until an inventory asked from now on answers (one out now may carry the old one).
      this.acked = { floor, names: [...names], after: this.host.view(floor).sent };
      this.draft = null;
      this.say('Saved. The list is read again.', false);
      this.host.refresh();
    } else this.say(r.code === 'bad_request' ? `The bridge refused the list: ${r.message.replace(/^bad args: /, '')}` : `Not saved: ${r.message || r.code}`, true);
    this.render(true);
    if (this.sheet.isOpen) this.expInput.focus();
  }

  private say(text: string, error: boolean): void {
    this.expText = text;
    this.expError = error;
    this.expMsg.textContent = text;
    this.expMsg.classList.toggle('mcp-exp-msg--error', error);
  }

  /** What the page shows (test hook `window.__h3d.mcp()`). */
  summary(): McpOverviewSummary {
    const v = this.view();
    const r = v.received;
    const now = this.host.now();
    const saved = this.savedExpected();
    const rows = r ? mcpRows({ providers: r.snap.providers, expected: saved }) : [];
    const state: McpOverviewSummary['state'] = v.unsupported ? 'unsupported' : !v.live ? 'offline' : r ? 'data' : v.error ? 'error' : 'loading';
    const skills = (hh: McpHarness) => {
      const s = r?.snap.providers[hh].skills;
      return { count: s?.items.length ?? 0, incomplete: s ? !s.complete : false, disabled: s?.items.filter((x) => x.enabled === false).length ?? 0, errors: s?.errors.length ?? 0 };
    };
    return {
      open: this.sheet.isOpen,
      floor: this.floor,
      context: r ? { cwd: r.snap.context.cwd, codex_profile: r.snap.context.codex_profile } : null,
      state,
      providers: HARNESSES.map((hh) => {
        const p = r?.snap.providers[hh];
        return {
          harness: hh,
          tone: p && r ? providerTone(p, r, now) : null,
          servers: p?.servers.length ?? 0,
          attention: p ? attentionCount(p, saved) : 0,
          checking: v.checking[hh],
          check: p?.check.state ?? 'none',
        };
      }),
      rows: rows.map((x) => ({ name: x.name, expected: x.expected, claude: cellText(x.cells.claude, 'claude'), codex: cellText(x.cells.codex, 'codex'), missing: x.missing })),
      skills: { claude: skills('claude'), codex: skills('codex') },
      expectedEditable: r?.snap.expected !== undefined,
      expected: this.draft ?? (r?.snap.expected !== undefined ? saved : []),
      status: this.expText,
    };
  }
}
