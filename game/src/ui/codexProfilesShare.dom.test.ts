// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import type { CodexDrift, CodexProfile, CodexProfilesState, CodexShareStep } from '../net/protocol';
import { CodexProfilesBook } from '../world/codexProfiles';
import { codexProfilesSection } from './codexProfilesSection';
import { SettingsDialog } from './settings';

// #167: "Share setup with <default>" in Settings → Codex profiles: the switch (not on the default row, not from a
// bridge without sharing), the plan's confirm list, the report, the drift badge with its list and Fix, and the skill
// move with its own confirm.

const profile = (key: string, o: Partial<CodexProfile> = {}): CodexProfile => ({
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
const DEF = profile('codex', { default: true, name: 'personal', path: '/home/u/.codex', display: '~/.codex' });
const state = (work: Partial<CodexProfile> = {}, share = true): CodexProfilesState => ({
  profiles: [DEF, profile('work', work), profile('old', { hidden: true, share: true })],
  ...(share ? { share: true } : {}),
});
const REPLACE: CodexShareStep[] = [
  { name: 'config.toml', action: 'replace', was: 'file', backup: 'config.toml.before-share-20261021-151002' },
  { name: 'AGENTS.md', action: 'link' },
  { name: 'hooks.json', action: 'write' },
];
const DRIFT: CodexDrift[] = [
  { kind: 'link_replaced', name: 'config.toml', text: 'config.toml is no longer a link: a file replaced it' },
  { kind: 'skill_only_default', name: 'infra', text: 'skill infra is only on personal' },
];

/** A bridge that answers the share commands: `plan` is the dry run's steps; an apply turns share on and clears drift. */
function mount(s: CodexProfilesState, plan: CodexShareStep[] = [], refuse?: (args: Record<string, unknown>) => CommandResult | null) {
  document.body.replaceChildren();
  const book = new CodexProfilesBook();
  book.reset(s);
  const sent: Array<{ t: string; args: Record<string, unknown> }> = [];
  const dialog = new SettingsDialog(document.body);
  dialog.addSection(
    'codex-profiles',
    'Codex profiles',
    codexProfilesSection({
      book,
      send: ((t: string, args: Record<string, unknown>) => {
        sent.push({ t, args });
        const no = refuse?.(args);
        if (no) return Promise.resolve(no);
        const cur = book.state!;
        if (t === 'codex_profiles.move_skill') {
          const profiles = cur.profiles.map((p) => ({ ...p, drift: p.drift?.filter((d) => d.name !== args.skill) }));
          return Promise.resolve({ ok: true, data: { ...cur, profiles, steps: [{ name: args.skill, action: 'move' }], report: `Moved the skill ${String(args.skill)} to ~/.agents/skills/${String(args.skill)}.` } });
        }
        if (args.dry_run) return Promise.resolve({ ok: true, data: { ...cur, steps: plan } });
        const on = args.share === true;
        const profiles = cur.profiles.map((p) => (p.key === args.key ? { ...p, share: on, drift: undefined } : p));
        return Promise.resolve({ ok: true, data: { ...cur, profiles, steps: [], report: on ? 'Linked config.toml, wrote hooks.json.' : 'Copied config.toml from personal.' } });
      }) as never,
    }),
    { store: 'bridge', group: 'workers' },
  );
  const root = document.querySelector<HTMLElement>('[data-section="codex-profiles"]')!;
  const row = (key: string) => root.querySelector<HTMLElement>(`.settings-cp-row[data-profile="${key}"]`)!;
  const key = (k: string) => root.querySelector<HTMLElement>(`[data-key="${k}"]`);
  const flush = async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  };
  return { book, root, sent, row, key, flush };
}

describe('sharing a Codex profile’s setup (#167)', () => {
  it('offers the switch on every other row, never on the default, and nowhere from a bridge without sharing', () => {
    let m = mount(state());
    expect(m.key('share:codex')).toBeNull();
    const sw = m.key('share:work') as HTMLInputElement;
    expect(sw.checked).toBe(false);
    expect(sw.closest('label')?.textContent).toBe('Share setup with personal');
    expect(m.root.querySelector('[data-hook="drift-badge"]')).toBeNull();
    m = mount(state({ share: true, drift: DRIFT }, false));
    expect(m.key('share:work')).toBeNull();
    expect(m.root.querySelector('[data-hook="drift-badge"]')).toBeNull();
    expect(m.root.querySelector('.settings-cp-share-panel')).toBeNull();
  });

  it('turns sharing on at once when nothing is in the way, and shows the report', async () => {
    const m = mount(state(), [{ name: 'config.toml', action: 'link' }, { name: 'hooks.json', action: 'write' }]);
    const sw = m.key('share:work') as HTMLInputElement;
    sw.checked = true;
    sw.dispatchEvent(new Event('change'));
    await m.flush();
    expect(m.sent.map((x) => x.args)).toEqual([
      { key: 'work', share: true, dry_run: true },
      { key: 'work', share: true, replace: [] },
    ]);
    expect((m.key('share:work') as HTMLInputElement).checked).toBe(true);
    expect(m.row('work').querySelector('[data-hook="share-report"]')?.textContent).toBe('Linked config.toml, wrote hooks.json.');
  });

  it('lists what is in the way with its backup name and sends only the confirmed list; Cancel sends nothing', async () => {
    const m = mount(state(), REPLACE);
    const sw = m.key('share:work') as HTMLInputElement;
    sw.checked = true;
    sw.dispatchEvent(new Event('change'));
    await m.flush();
    expect(m.sent).toHaveLength(1);
    expect((m.key('share:work') as HTMLInputElement).checked).toBe(false);
    const list = m.row('work').querySelector('[data-hook="share-confirm"]')!;
    expect([...list.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['config.toml (a file) is kept as config.toml.before-share-20261021-151002']);
    expect(m.row('work').querySelector('.settings-cp-share-ask')?.textContent).toBe('These are in the way in ~/.codex-work. Each is renamed, never deleted:');
    expect(document.activeElement).toBe(m.key('share-confirm:work'));
    (m.key('share-cancel:work') as HTMLButtonElement).click();
    expect(m.row('work').querySelector('[data-hook="share-confirm"]')).toBeNull();
    expect(m.sent).toHaveLength(1);
    const again = m.key('share:work') as HTMLInputElement; // the rows are rebuilt
    again.checked = true;
    again.dispatchEvent(new Event('change'));
    await m.flush();
    expect(m.key('share-confirm:work')?.textContent).toBe('Back up and share');
    (m.key('share-confirm:work') as HTMLButtonElement).click();
    await m.flush();
    expect(m.sent.at(-1)!.args).toEqual({ key: 'work', share: true, replace: ['config.toml'] });
    expect(m.row('work').querySelector('[data-hook="share-report"]')?.textContent).toBe('Linked config.toml, wrote hooks.json.');
  });

  it('shows the bridge’s refusal under the row (the home changed since the plan)', async () => {
    const m = mount(state(), REPLACE, (a) => (a.replace ? { ok: false, code: 'bad_request', message: 'bad args: ~/.codex-work changed since you looked; look again.' } : null));
    const sw = m.key('share:work') as HTMLInputElement;
    sw.checked = true;
    sw.dispatchEvent(new Event('change'));
    await m.flush();
    (m.key('share-confirm:work') as HTMLButtonElement).click();
    await m.flush();
    const r = m.row('work').querySelector('[data-hook="share-report"]')!;
    expect(r.textContent).toBe('~/.codex-work changed since you looked; look again.');
    expect(r.classList.contains('settings-field-error')).toBe(true);
  });

  it('turns sharing off at once, with its report', async () => {
    const m = mount(state({ share: true }));
    const sw = m.key('share:work') as HTMLInputElement;
    expect(sw.checked).toBe(true);
    sw.checked = false;
    sw.dispatchEvent(new Event('change'));
    await m.flush();
    expect(m.sent.map((x) => x.args)).toEqual([{ key: 'work', share: false }]);
    expect((m.key('share:work') as HTMLInputElement).checked).toBe(false);
    expect(m.row('work').querySelector('[data-hook="share-report"]')?.textContent).toBe('Copied config.toml from personal.');
  });

  it('marks a drifted row, lists what differs, and Fix goes through the same plan and confirm; a hidden one shows none', async () => {
    const m = mount(state({ share: true, drift: DRIFT }), REPLACE);
    expect(m.row('old').querySelector('[data-hook="drift-badge"]')).toBeNull();
    const badge = m.row('work').querySelector('[data-hook="drift-badge"]')!;
    expect(badge.textContent).toBe('Setup drifted');
    expect(badge.getAttribute('data-state')).toBe('incomplete');
    const items = [...m.row('work').querySelectorAll('[data-hook="drift"] li')].map((l) => l.querySelector('span')?.textContent);
    expect(items).toEqual(['config.toml is no longer a link: a file replaced it', 'skill infra is only on personal']);
    (m.key('fix:work') as HTMLButtonElement).click();
    await m.flush();
    expect(m.sent.map((x) => x.args)).toEqual([{ key: 'work', share: true, dry_run: true }]);
    expect(m.key('share-confirm:work')?.textContent).toBe('Back up and fix');
    (m.key('share-confirm:work') as HTMLButtonElement).click();
    await m.flush();
    expect(m.sent.at(-1)!.args).toEqual({ key: 'work', share: true, replace: ['config.toml'] });
    expect(m.row('work').querySelector('[data-hook="drift-badge"]')).toBeNull();
  });

  it('moves a skill to ~/.agents/skills after its own confirm, from the home that has it', async () => {
    const m = mount(state({ share: true, drift: [DRIFT[1]!, { kind: 'skill_only_profile', name: 'mine', text: 'skill mine is only on work' }] }));
    expect(m.key('fix:work')).toBeNull(); // only skills differ: Fix would change nothing
    (m.key('move:work:infra') as HTMLButtonElement).click();
    expect(m.sent).toHaveLength(0);
    expect(m.row('work').querySelector('.settings-cp-share-ask')?.textContent).toBe(
      'Move the skill infra out of personal’s skills/ into ~/.agents/skills, where every Codex home reads it, and leave a link in its place?',
    );
    (m.key('move-cancel:work') as HTMLButtonElement).click();
    expect(m.sent).toHaveLength(0);
    (m.key('move:work:infra') as HTMLButtonElement).click();
    (m.key('move-confirm:work') as HTMLButtonElement).click();
    await m.flush();
    expect(m.sent).toEqual([{ t: 'codex_profiles.move_skill', args: { key: 'codex', skill: 'infra' } }]);
    expect(m.row('work').querySelector('[data-hook="share-report"]')?.textContent).toBe('Moved the skill infra to ~/.agents/skills/infra.');
    (m.key('move:work:mine') as HTMLButtonElement).click();
    (m.key('move-confirm:work') as HTMLButtonElement).click();
    await m.flush();
    expect(m.sent.at(-1)).toEqual({ t: 'codex_profiles.move_skill', args: { key: 'work', skill: 'mine' } });
  });
});
