// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../net/client';
import type { CodexProfile, McpHarness, McpProvider, McpSnapshot } from '../net/protocol';
import { McpLink, type McpChoice, type McpView } from '../mcp/link';
import { MCP_POLL_MS } from '../world/mcp';
import { McpOverview, type McpOverviewHost } from './mcpOverview';

const T0 = Date.parse('2026-10-23T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    if (!this.open) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});
afterEach(() => {
  document.body.innerHTML = '';
});

const server = (name: string, o: Partial<McpProvider['servers'][number]> = {}): McpProvider['servers'][number] => ({ name, source: 'user', plugin: '', transport: 'stdio', enabled: true, approval: 'n/a', status: 'not_checked', status_scope: 'config', status_at: null, reason: '', ...o });

const provider = (o: Partial<McpProvider> = {}): McpProvider => ({
  available: true,
  version: '2.1.309',
  reason: '',
  config: { state: 'ok', read_at: iso(T0 - 4_000), stale: false, note: '' },
  check: { state: 'none', at: null, note: '' },
  servers: [],
  skills: { state: 'ok', read_at: iso(T0 - 4_000), stale: false, complete: true, note: '', items: [], errors: [] },
  ...o,
});

function snapshot(o: Partial<McpSnapshot> = {}): McpSnapshot {
  return {
    context: { floor: 'lab', cwd: '/home/me/repos/x', cwd_display: '~/repos/x', codex_profile: 'codex', codex_profile_name: 'codex', claude_config: '~/.claude' },
    checkouts: [
      { path: '/home/me/repos/x', display: '~/repos/x', label: 'x (default)' },
      { path: '/home/me/repos/y', display: '~/repos/y', label: 'y' },
    ],
    expected: ['github', 'notion'],
    generated_at: iso(T0),
    providers: {
      claude: provider({
        servers: [server('github', { status: 'connected', status_scope: 'probe', status_at: iso(T0 - 60_000) }), server('sentry', { status: 'auth_required', reason: 'Authentication required', source: 'project' }), server('linear', { status: 'approval_required', approval: 'pending', source: 'project' })],
        check: { state: 'ok', at: iso(T0 - 60_000), note: '' },
        skills: {
          state: 'ok',
          read_at: iso(T0 - 4_000),
          stale: false,
          complete: false,
          note: 'Found on disk; claude.ai-synced and lazily loaded skills are not listed',
          items: [{ name: 'deploy', description: 'Ship it', source: 'user', plugin: '', enabled: true, invocation: 'both', where: '~/.claude/skills/deploy' }],
          errors: [],
        },
      }),
      codex: provider({
        version: '0.163.0',
        servers: [server('github')],
        skills: {
          state: 'ok',
          read_at: iso(T0 - 4_000),
          stale: false,
          complete: true,
          note: '',
          items: [
            { name: 'changelog', description: 'Write it', source: 'user', plugin: '', enabled: true, invocation: 'both', where: '~/.codex/skills/changelog' },
            { name: 'legacy-lint', description: 'Old', source: 'user', plugin: '', enabled: false, invocation: 'user_only', where: '~/.codex/skills/legacy-lint' },
          ],
          errors: [{ where: '~/.codex/skills/broken', message: 'Invalid SKILL.md frontmatter' }],
        },
      }),
    },
    ...o,
  };
}

const profiles: CodexProfile[] = [
  { key: 'codex', name: 'codex', path: '/home/me/.codex', display: '~/.codex', plan: '', signed_in: true, default: true, hidden: false, added: false },
  { key: 'work', name: 'work', path: '/home/me/.codex-work', display: '~/.codex-work', plan: '', signed_in: true, default: false, hidden: false, added: false },
];

function rig(view: Partial<McpView> = {}) {
  let v: McpView = { floor: 'lab', choice: {}, received: { snap: snapshot(), at: T0 }, seq: 1, sent: 1, asking: false, checking: { claude: false, codex: false }, error: null, unsupported: false, live: true, ...view };
  const chose: McpChoice[] = [];
  const checks: McpHarness[] = [];
  const saved: Array<string[] | null> = [];
  let refreshes = 0;
  let closes = 0;
  let saveAnswer: CommandResult = { ok: true, data: undefined };
  const host: McpOverviewHost = {
    view: () => v,
    choose: (_f, c) => void chose.push(c),
    refresh: () => void refreshes++,
    check: (h) => void checks.push(h),
    profiles: () => profiles,
    saveExpected: async (_f, names) => (saved.push(names), saveAnswer),
    floorName: () => 'Lab',
    now: () => T0,
    closed: () => void closes++,
  };
  const page = new McpOverview(host);
  const opener = document.createElement('button');
  document.body.append(opener);
  opener.focus();
  const $ = <T extends Element = HTMLElement>(sel: string) => page.el.querySelector<T & Element>(sel) as T;
  return {
    page,
    opener,
    $,
    chose,
    checks,
    saved,
    refreshes: () => refreshes,
    closes: () => closes,
    set: (o: Partial<McpView>) => {
      v = { ...v, ...o };
      page.refresh();
    },
    answerSave: (r: CommandResult) => void (saveAnswer = r),
    text: () => page.el.textContent ?? '',
  };
}

describe('the MCP & skills overview (#196)', () => {
  it('opens with the focus on its first control, closes on Esc and gives the focus back', () => {
    const r = rig();
    r.page.open('lab');
    expect(r.page.isOpen).toBe(true);
    expect(document.activeElement).toBe(r.$('#mcp-cwd'));
    expect(r.page.el.getAttribute('aria-label')).toBe('MCP & skills on Lab');
    r.page.el.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(r.page.isOpen).toBe(false);
    expect(r.closes()).toBe(1);
    expect(document.activeElement).toBe(r.opener);
  });

  it('shows both providers, their counts, attention, scope, check and next steps', () => {
    const r = rig();
    r.page.open('lab');
    const s = r.page.summary();
    expect(s.state).toBe('data');
    expect(s.providers.map((p) => [p.harness, p.tone, p.servers, p.attention])).toEqual([
      ['claude', 'ok', 3, 3], // sentry (sign-in), linear (approval), notion (expected, missing)
      ['codex', 'ok', 1, 1], // notion
    ]);
    const claude = r.$('.mcp-prov[data-harness="claude"]');
    expect(claude.textContent).toContain('3 MCP servers');
    expect(claude.textContent).toContain('3 need attention');
    expect(claude.textContent).toContain('Config ~/.claude · ~/repos/x · v2.1.309');
    expect(claude.textContent).toContain('Checked 1 min ago');
    expect(r.$('.mcp-prov[data-harness="codex"]').textContent).toContain('Profile codex');
    expect(r.$('.mcp-prov[data-harness="codex"]').textContent).toContain('Not checked yet');
    // The check says it starts the servers, and the button is described by that note.
    const btn = r.$<HTMLButtonElement>('[data-key="check-codex"]');
    expect(r.$(`#${btn.getAttribute('aria-describedby')}`).textContent).toMatch(/Starts the configured servers/);
  });

  it('lists the rows by the merge rule: a missing expected server, sign-in and approval are not missing, evidence and time', () => {
    const r = rig();
    r.page.open('lab');
    expect(r.page.summary().rows).toEqual([
      { name: 'github', expected: true, claude: 'Connected', codex: 'Configured', missing: false },
      { name: 'linear', expected: false, claude: 'Needs approval', codex: 'Not configured in Codex', missing: false },
      { name: 'notion', expected: true, claude: 'Expected, not configured in Claude Code', codex: 'Expected, not configured in Codex', missing: true },
      { name: 'sentry', expected: false, claude: 'Needs sign-in', codex: 'Not configured in Codex', missing: false },
    ]);
    const gh = r.$('.mcp-row[data-name="github"] .mcp-cell[data-harness="claude"]');
    expect(gh.querySelector('.mcp-status--ok')).not.toBeNull();
    expect(gh.querySelector('.mcp-meta')?.textContent).toBe('User · stdio · Separate check · checked 1 min ago');
    // A configuration-backed cell says when the configuration was read (UX-R3).
    expect(r.$('.mcp-row[data-name="github"] .mcp-cell[data-harness="codex"] .mcp-meta').textContent).toBe('User · stdio · Configuration · read just now');
    const sentry = r.$('.mcp-row[data-name="sentry"] .mcp-cell[data-harness="claude"]');
    expect(sentry.textContent).toContain('Authentication required');
    expect(sentry.textContent).toContain('Sign in with /mcp in Claude Code.');
    expect(r.$('.mcp-row[data-name="notion"]').classList.contains('mcp-row--missing')).toBe(true);
  });

  it('never says "not configured" for a provider whose read failed, and keeps both providers when a CLI is missing', () => {
    const r = rig();
    const s = snapshot();
    s.providers.codex = provider({ available: false, reason: 'codex not found on the bridge’s PATH', config: { state: 'unavailable', read_at: null, stale: false, note: '' } });
    s.providers.claude = provider({ config: { state: 'failed', read_at: null, stale: false, note: 'The configuration could not be read' } });
    r.set({ received: { snap: s, at: T0 } });
    r.page.open('lab');
    const sum = r.page.summary();
    expect(sum.rows.map((x) => [x.name, x.claude, x.codex])).toEqual([
      ['github', 'Unknown', 'Unknown'],
      ['notion', 'Unknown', 'Unknown'],
    ]);
    expect(sum.rows.some((x) => x.missing)).toBe(false);
    expect(r.$('.mcp-prov[data-harness="codex"]').textContent).toContain('CLI not found');
    expect(r.$('.mcp-prov[data-harness="codex"]').textContent).toContain('Install the codex CLI on the bridge host');
    expect(r.$('.mcp-prov[data-harness="claude"]').textContent).toContain('It is tried again by itself; Refresh tries now.');
    expect(r.$<HTMLButtonElement>('[data-key="check-codex"]').disabled).toBe(true);
  });

  it('labels a stale read and never shows it green', () => {
    const r = rig();
    const s = snapshot();
    s.providers.claude.config = { state: 'ok', read_at: iso(T0 - 10 * 60_000), stale: true, note: 'The last read failed; this is the one before it' };
    r.set({ received: { snap: s, at: T0 } });
    r.page.open('lab');
    expect(r.page.summary().providers[0]?.tone).toBe('stale');
    expect(r.$('.mcp-prov[data-harness="claude"] .mcp-state').textContent).toBe('Stale');
    const gh = r.$('.mcp-row[data-name="github"] .mcp-cell[data-harness="claude"]');
    expect(gh.querySelector('.mcp-status--ok')).toBeNull();
    expect(gh.textContent).toContain('stale');
  });

  it('never shows an old check or worker status green, though the configuration was read just now, and says how old it is', () => {
    const r = rig();
    const s = snapshot();
    const day = T0 - 86_400_000;
    s.providers.claude.servers[0] = server('github', { status: 'connected', status_scope: 'probe', status_at: iso(day) });
    s.providers.claude.check = { state: 'ok', at: iso(day), note: '' };
    s.providers.codex.servers[0] = server('github', { status: 'connected', status_scope: 'worker', status_at: iso(T0 - 11 * 60_000), worker: { id: 'w1', name: 'Juniper' } });
    r.set({ received: { snap: s, at: T0 } });
    r.page.open('lab');
    expect(r.page.summary().providers.map((p) => p.tone)).toEqual(['ok', 'ok']); // the configuration is fresh
    for (const hh of ['claude', 'codex']) {
      const cell = r.$(`.mcp-row[data-name="github"] .mcp-cell[data-harness="${hh}"]`);
      expect(cell.querySelector('.mcp-status--ok'), hh).toBeNull();
      expect(cell.querySelector('.mcp-tag--stale'), hh).not.toBeNull();
    }
    expect(r.$('.mcp-row[data-name="github"] .mcp-cell[data-harness="claude"] .mcp-meta').textContent).toBe('User · stdio · Separate check · checked 1 d ago, may be out of date');
    expect(r.$('.mcp-row[data-name="github"] .mcp-cell[data-harness="codex"] .mcp-meta').textContent).toBe('User · stdio · Worker Juniper · seen 11 min ago, may be out of date');
    expect(r.$('.mcp-prov[data-harness="claude"] .mcp-check-age').textContent).toBe('Checked 1 d ago, may be out of date');
  });

  it('never closes on a backdrop click (it holds an edit), only by its close button and Esc; the draft stays while open', () => {
    const r = rig();
    r.page.open('lab');
    expect(r.page.el.getAttribute('closedby')).toBe('closerequest');
    r.$<HTMLInputElement>('#mcp-exp-input').value = 'new-expected';
    r.$<HTMLButtonElement>('[data-key="exp-add"]').click();
    const down = new MouseEvent('pointerdown', { button: 0, clientX: 2, clientY: 2, bubbles: true });
    Object.defineProperty(down, 'isPrimary', { value: true });
    r.page.el.dispatchEvent(down);
    r.page.el.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 2, clientY: 2, bubbles: true }));
    expect(r.page.isOpen).toBe(true);
    expect(r.page.summary().expected).toEqual(['github', 'notion', 'new-expected']);
    r.$<HTMLButtonElement>('.sheet-close').click();
    expect(r.page.isOpen).toBe(false);
  });

  it('names the provider of every cell for assistive tech at every width (UX-R2)', () => {
    const r = rig();
    r.page.open('lab');
    for (const cell of r.page.el.querySelectorAll<HTMLElement>('.mcp-cell')) {
      const label = cell.querySelector('.mcp-cell-prov');
      expect(label?.textContent).toBe(cell.dataset.harness === 'claude' ? 'Claude Code' : 'Codex');
      expect(label?.getAttribute('aria-hidden')).toBeNull();
    }
    // Wide: hidden visually, not from the accessibility tree (never display: none outside the narrow layout).
    const css = readFileSync(resolve(import.meta.dirname, 'mcpOverview.css'), 'utf8');
    const wide = css.slice(0, css.indexOf('@media (max-width: 720px)'));
    const rule = wide.match(/\.mcp-cell-prov \{([^}]*)\}/)?.[1] ?? '';
    expect(rule).not.toMatch(/display:\s*none/);
    expect(rule).toMatch(/clip-path: inset\(50%\)/);
  });

  it('shows the bridge busy: a check it did not start says so and can be asked again; a read waiting for a reader says why', () => {
    const r = rig();
    const s = snapshot();
    s.providers.claude.check = { state: 'skipped', at: null, note: 'Other connection checks or reads are running; try again in a moment' };
    s.providers.codex = provider({ config: { state: 'pending', read_at: null, stale: false, note: 'Other inventory reads are running; this one starts on a later refresh' }, skills: { ...provider().skills, state: 'pending', read_at: null } });
    r.set({ received: { snap: s, at: T0 }, checking: { claude: false, codex: false } });
    r.page.open('lab');
    const claude = r.$('.mcp-prov[data-harness="claude"]');
    expect(claude.querySelector('.mcp-check-age')?.textContent).toBe('Check not started');
    expect(claude.textContent).toContain('Other connection checks or reads are running; try again in a moment');
    expect(r.$<HTMLButtonElement>('[data-key="check-claude"]').disabled).toBe(false);
    const codex = r.$('.mcp-prov[data-harness="codex"]');
    expect(codex.querySelector('.mcp-state')?.textContent).toBe('Reading');
    expect(codex.querySelector('.mcp-note')?.textContent).toBe('Other inventory reads are running; this one starts on a later refresh');
    expect(codex.querySelector('.mcp-next')).toBeNull(); // the bridge's note says it; no second, contradicting line
    expect(r.page.summary().rows.find((x) => x.name === 'github')?.codex).toBe('Unknown');
  });

  it('keeps a failed half’s last good rows, stale and with the bridge’s "Last read failed" note', () => {
    const r = rig();
    const s = snapshot();
    s.providers.codex.config = { state: 'ok', read_at: iso(T0 - 5 * 60_000), stale: true, note: 'Last read failed: config/read refused; showing the read from 11:55' };
    s.providers.codex.skills = { ...s.providers.codex.skills, stale: true, note: 'Last read failed: skills/list refused; showing the read from 11:55' };
    r.set({ received: { snap: s, at: T0 } });
    r.page.open('lab');
    const codex = r.$('.mcp-prov[data-harness="codex"]');
    expect(codex.querySelector('.mcp-state')?.textContent).toBe('Stale');
    expect(codex.querySelector('.mcp-note')?.textContent).toContain('Last read failed: config/read refused');
    expect(r.$('.mcp-row[data-name="github"] .mcp-cell[data-harness="codex"] .mcp-tag--stale')).not.toBeNull();
    const skills = r.$('.mcp-skill-col[data-harness="codex"]');
    expect(skills.querySelector('.mcp-tag--stale')).not.toBeNull();
    expect(skills.textContent).toContain('Last read failed: skills/list refused');
  });

  it('has calm states: an old bridge, no connection, the first read, a refused context', () => {
    const r = rig({ received: null, asking: true });
    r.page.open('lab');
    expect(r.page.summary().state).toBe('loading');
    expect(r.$('.mcp-calm').textContent).toContain('no server is started');
    r.set({ asking: false, error: 'That Codex profile is not on the bridge any more. Pick another.' });
    expect(r.$('.mcp-calm').textContent).toContain('Pick another');
    r.set({ live: false });
    expect(r.$('.mcp-calm').textContent).toContain('Not connected to the bridge');
    expect(r.$<HTMLButtonElement>('[data-key="refresh"]').disabled).toBe(true);
    r.set({ live: true, unsupported: true });
    expect(r.$('.mcp-calm').textContent).toContain('No MCP inventory on this bridge');
    expect(r.$<HTMLSelectElement>('#mcp-cwd').disabled).toBe(true);
  });

  it('picks the checkout and the Codex profile; Refresh and Check connections ask the link', () => {
    const r = rig();
    r.page.open('lab');
    const cwd = r.$<HTMLSelectElement>('#mcp-cwd');
    expect([...cwd.options].map((o) => o.textContent)).toEqual(['x (default) · ~/repos/x', 'y · ~/repos/y', 'User scope only (no project)']);
    expect(cwd.value).toBe('/home/me/repos/x');
    cwd.value = cwd.options[2]?.value ?? '';
    cwd.dispatchEvent(new Event('change'));
    cwd.value = '/home/me/repos/y';
    cwd.dispatchEvent(new Event('change'));
    const prof = r.$<HTMLSelectElement>('#mcp-profile');
    expect([...prof.options].map((o) => o.textContent)).toEqual(['codex (default)', 'work']);
    prof.value = 'work';
    prof.dispatchEvent(new Event('change'));
    prof.value = 'codex';
    prof.dispatchEvent(new Event('change'));
    expect(r.chose).toEqual([{ cwd: null }, { cwd: '/home/me/repos/y' }, { cwd: '/home/me/repos/y', codex_profile: 'work' }, { cwd: '/home/me/repos/y' }]);
    r.$<HTMLButtonElement>('[data-key="refresh"]').click();
    expect(r.refreshes()).toBe(1);
    const check = r.$<HTMLButtonElement>('[data-key="check-codex"]');
    check.focus();
    check.click();
    expect(r.checks).toEqual(['codex']);
    // While it runs the button is disabled and says so; the focus stays on it across the redraw.
    r.set({ checking: { claude: false, codex: true } });
    const busy = r.$<HTMLButtonElement>('[data-key="check-codex"]');
    expect(busy.disabled).toBe(true);
    expect(busy.textContent).toBe('Checking connections…');
    expect(r.$('.mcp-prov[data-harness="codex"] .mcp-check-age').textContent).toBe('Checking…');
  });

  it('keeps a redraw out when nothing it shows changed (the focus and an open picker stay)', () => {
    const r = rig();
    r.page.open('lab');
    const row = r.$('.mcp-row[data-name="github"]');
    r.page.refresh();
    r.page.refresh();
    expect(r.$('.mcp-row[data-name="github"]')).toBe(row);
  });

  it('edits the expected servers: add, refuse a bad name, remove, save; offered only when the bridge has the list', async () => {
    const r = rig();
    r.page.open('lab');
    expect(r.page.summary().expectedEditable).toBe(true);
    const input = r.$<HTMLInputElement>('#mcp-exp-input');
    const save = r.$<HTMLButtonElement>('[data-key="exp-save"]');
    expect(save.disabled).toBe(true);
    input.value = 'github';
    r.$<HTMLButtonElement>('[data-key="exp-add"]').click();
    expect(r.$('.mcp-exp-msg').textContent).toBe('github is on the list already.');
    input.value = '  linear ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(r.page.summary().expected).toEqual(['github', 'notion', 'linear']);
    expect(document.activeElement).toBe(r.$('#mcp-exp-input'));
    r.$<HTMLButtonElement>('[data-key="exp-remove-notion"]').click();
    expect(r.page.summary().expected).toEqual(['github', 'linear']);
    expect(r.$<HTMLButtonElement>('[data-key="exp-save"]').disabled).toBe(false);
    r.$<HTMLButtonElement>('[data-key="exp-save"]').click();
    await vi.waitFor(() => expect(r.saved).toEqual([['github', 'linear']]));
    await vi.waitFor(() => expect(r.$('.mcp-exp-msg').textContent).toContain('Saved'));
    expect(r.refreshes()).toBe(1);
    // A refusal says why.
    r.answerSave({ ok: false, code: 'bad_request', message: 'bad args: expected_mcp: x is listed twice' });
    r.$<HTMLButtonElement>('[data-key="exp-remove-github"]').click();
    r.$<HTMLButtonElement>('[data-key="exp-save"]').click();
    await vi.waitFor(() => expect(r.$('.mcp-exp-msg').textContent).toBe('The bridge refused the list: expected_mcp: x is listed twice'));
    // An older bridge: no list to edit.
    const before = snapshot();
    delete before.expected;
    const old = rig({ received: { snap: before, at: T0 } });
    old.page.open('lab');
    expect(old.page.summary().expectedEditable).toBe(false);
    expect(old.page.el.querySelector('#mcp-exp-input')).toBeNull();
  });

  it('keeps the saved expected list until an inventory asked after the save comes; a Refresh during a poll is queued; two quick saves keep both names', async () => {
    const held: Array<{ t: string; resolve(r: CommandResult): void }> = [];
    let now = 1000;
    let page: McpOverview | null = null;
    const link = new McpLink({
      request: (t) => new Promise<CommandResult>((resolve) => void held.push({ t, resolve })),
      hudInfo: () => {},
      unsupported: () => false,
      markUnsupported: () => {},
      now: () => now,
      clock: () => T0,
      changed: () => page?.refresh(),
    });
    const step = () => link.step({ office: { id: 'lab', tickMcp: () => false, setMcpScreen: () => {} }, here: true, live: true, connected: true, page: 'lab', camera: {} as never });
    const answer = async (i: number, expected: string[]) => {
      held[i]?.resolve({ ok: true, data: snapshot({ expected }) });
      for (let k = 0; k < 4; k++) await Promise.resolve();
    };
    const saved: Array<string[] | null> = [];
    page = new McpOverview({
      view: (f) => link.view(f),
      choose: (f, c) => link.choose(f, c),
      refresh: () => link.refresh(),
      check: (h) => link.check(h),
      profiles: () => null,
      saveExpected: async (_f, names) => (saved.push(names), { ok: true, data: undefined }),
      floorName: () => 'Lab',
      now: () => T0,
      closed: () => {},
    });
    step();
    await answer(0, []);
    page.open('lab');
    now += MCP_POLL_MS + 1;
    step();
    expect(held).toHaveLength(2); // a poll is out, its expected list read before any save
    const $ = <T extends HTMLElement>(sel: string) => page?.el.querySelector(sel) as T;
    const addAndSave = async (name: string) => {
      $<HTMLInputElement>('#mcp-exp-input').value = name;
      $<HTMLButtonElement>('[data-key="exp-add"]').click();
      $<HTMLButtonElement>('[data-key="exp-save"]').click();
      await vi.waitFor(() => expect($('.mcp-exp-msg').textContent).toContain('Saved'));
    };
    await addAndSave('alpha');
    expect(saved).toEqual([['alpha']]);
    expect(page.summary().expected).toEqual(['alpha']);
    expect(page.summary().rows.map((x) => [x.name, x.expected])).toEqual([['alpha', true], ['github', false], ['linear', false], ['sentry', false]]);
    expect($<HTMLButtonElement>('[data-key="exp-save"]').disabled).toBe(true);
    expect(held).toHaveLength(2); // the Refresh is queued behind the poll out
    await addAndSave('beta');
    expect(saved).toEqual([['alpha'], ['alpha', 'beta']]);
    // Closed and opened again before the bridge's list came: still the saved one.
    page.close();
    page.open('lab');
    expect(page.summary().expected).toEqual(['alpha', 'beta']);
    // The poll asked before the saves answers with the old list: not believed; the queued Refresh goes now.
    await answer(1, []);
    expect(page.summary().expected).toEqual(['alpha', 'beta']);
    expect(held).toHaveLength(3);
    // The inventory asked after the saves: the bridge's list counts again, whatever it says.
    await answer(2, ['alpha', 'beta']);
    expect(page.summary().expected).toEqual(['alpha', 'beta']);
    now += MCP_POLL_MS + 1;
    step();
    await answer(3, ['alpha']);
    expect(page.summary().expected).toEqual(['alpha']);
    expect($('.mcp-chips').textContent).toContain('alpha');
    expect($('.mcp-chips').textContent).not.toContain('beta');
  });

  it('a check asked before a save and answered after it shows its result but never its old expected list (F-R6)', async () => {
    const held: Array<{ t: string; resolve(r: CommandResult): void }> = [];
    let page: McpOverview | null = null;
    const link = new McpLink({
      request: (t) => new Promise<CommandResult>((resolve) => void held.push({ t, resolve })),
      hudInfo: () => {},
      unsupported: () => false,
      markUnsupported: () => {},
      now: () => 1000,
      clock: () => T0,
      changed: () => page?.refresh(),
    });
    const step = () => link.step({ office: { id: 'lab', tickMcp: () => false, setMcpScreen: () => {} }, here: true, live: true, connected: true, page: 'lab', camera: {} as never });
    const settle = async () => {
      for (let k = 0; k < 4; k++) await Promise.resolve();
    };
    /** A check's ack: its provider checked at T0 with a server needing sign-in, the expected list read when it started. */
    const checkedSnap = (h: 'claude' | 'codex', expected: string[]) => {
      const s = snapshot({ expected });
      s.providers[h] = { ...s.providers[h], check: { state: 'failed', at: iso(T0), note: '' }, servers: [server('github', { status: 'auth_required', status_scope: 'probe', status_at: iso(T0), reason: 'Authentication required' })] };
      return s;
    };
    page = new McpOverview({
      view: (f) => link.view(f),
      choose: (f, c) => link.choose(f, c),
      refresh: () => link.refresh(),
      check: (h) => link.check(h),
      profiles: () => null,
      saveExpected: async () => ({ ok: true, data: undefined }),
      floorName: () => 'Lab',
      now: () => T0,
      closed: () => {},
    });
    step();
    held[0]?.resolve({ ok: true, data: snapshot({ expected: [] }) });
    await settle();
    page.open('lab');
    const $ = <T extends HTMLElement>(sel: string) => page?.el.querySelector(sel) as T;
    link.check('claude');
    link.check('codex');
    $<HTMLInputElement>('#mcp-exp-input').value = 'alpha';
    $<HTMLButtonElement>('[data-key="exp-add"]').click();
    $<HTMLButtonElement>('[data-key="exp-save"]').click();
    await vi.waitFor(() => expect($('.mcp-exp-msg').textContent).toContain('Saved'));
    expect(held.map((x) => x.t)).toEqual(['mcp.inventory', 'mcp.check', 'mcp.check', 'mcp.inventory']);
    // The Claude check (asked before the save) ends first: its result shows, the saved list stays.
    held[1]?.resolve({ ok: true, data: checkedSnap('claude', []) });
    await settle();
    expect(page.summary().expected).toEqual(['alpha']);
    expect(link.view('lab').received?.snap.providers.claude.check.state).toBe('failed');
    // The inventory asked after the save, then the Codex check asked before it: the list is the bridge's post-save one.
    held[3]?.resolve({ ok: true, data: snapshot({ expected: ['alpha'] }) });
    await settle();
    held[2]?.resolve({ ok: true, data: checkedSnap('codex', []) });
    await settle();
    expect(page.summary().expected).toEqual(['alpha']);
    expect($('.mcp-chips').textContent).toContain('alpha');
    const p = link.view('lab').received?.snap.providers;
    expect([p?.claude.check.state, p?.codex.check.state]).toEqual(['failed', 'failed']);
    expect(link.view('lab').checking).toEqual({ claude: false, codex: false });
  });

  it('lists the skills per provider: incomplete label, disabled ones kept, load errors', () => {
    const r = rig();
    r.page.open('lab');
    expect(r.page.summary().skills).toEqual({ claude: { count: 1, incomplete: true, disabled: 0, errors: 0 }, codex: { count: 2, incomplete: false, disabled: 1, errors: 1 } });
    const claude = r.$('.mcp-skill-col[data-harness="claude"]');
    expect(claude.textContent).toContain('Incomplete list');
    expect(claude.textContent).toContain('claude.ai-synced and lazily loaded skills are not listed');
    const codex = r.$('.mcp-skill-col[data-harness="codex"]');
    expect(codex.querySelector('.mcp-skill--off')?.textContent).toContain('Disabled');
    expect(codex.textContent).toContain('1 skill could not be loaded');
    expect(codex.textContent).toContain('~/.codex/skills/broken Invalid SKILL.md frontmatter');
    expect(codex.textContent).toContain('Only you');
  });

  it('stacks the providers and the cells at narrow widths (390 px)', () => {
    const css = readFileSync(resolve(import.meta.dirname, 'mcpOverview.css'), 'utf8');
    const narrow = css.slice(css.indexOf('@media (max-width: 720px)'));
    expect(narrow).toMatch(/\.mcp-providers,\s*\.mcp-skills \{\s*grid-template-columns: minmax\(0, 1fr\);/);
    expect(narrow).toMatch(/\.mcp-cell-prov \{\s*position: static;/);
    expect(css.slice(css.indexOf('@media (max-width: 420px)'))).toMatch(/\.mcp-row \{\s*grid-template-columns: minmax\(0, 1fr\);/);
  });
});
