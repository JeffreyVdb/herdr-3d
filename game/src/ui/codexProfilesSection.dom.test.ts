// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import type { CodexProfile, CodexProfilesState } from '../net/protocol';
import { CodexProfilesBook } from '../world/codexProfiles';
import { codexProfilesSection } from './codexProfilesSection';
import { SettingsDialog } from './settings';

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
const START: CodexProfilesState = {
  profiles: [profile('codex', { default: true, path: '/home/u/.codex', display: '~/.codex', plan: 'prolite' }), profile('work', { plan: 'team' }), profile('spare', { added: true, signed_in: false, path: '/srv/spare', display: '/srv/spare' })],
};

/** A bridge that keeps the list and answers like herdr-world (its refusals given by `refuse`). */
function mount(s: CodexProfilesState | null, refuse?: (args: Record<string, unknown>) => CommandResult | null) {
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
        const cur = (book.state as CodexProfilesState).profiles;
        let next = cur.map((p) => ({ ...p }));
        if (typeof args.add === 'string') next.push(profile('team', { added: true, signed_in: false, path: '/home/u/team', display: args.add }));
        else if (args.remove) next = next.filter((p) => p.key !== args.key);
        else next = next.map((p) => (p.key !== args.key ? p : { ...p, ...(typeof args.name === 'string' ? { name: args.name } : {}), ...(typeof args.hidden === 'boolean' ? { hidden: args.hidden } : {}) }));
        return Promise.resolve({ ok: true, data: { profiles: next } });
      }) as never,
    }),
    { store: 'bridge', group: 'workers' },
  );
  const root = document.querySelector<HTMLElement>('[data-section="codex-profiles"]')!;
  const text = (sel: string) => root.querySelector<HTMLElement>(sel)?.textContent ?? '';
  const btn = (name: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent) === name);
  const row = (key: string) => root.querySelector<HTMLElement>(`[data-profile="${key}"]`)!;
  const add = () => root.querySelector<HTMLInputElement>('input[data-key="add-input"]')!;
  const type = (i: HTMLInputElement, v: string) => {
    i.value = v;
    i.dispatchEvent(new Event('input'));
  };
  const enter = (i: HTMLInputElement) => i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { book, root, sent, text, btn, row, add, type, enter, flush };
}

describe('the “Codex profiles” section (#138)', () => {
  it('is not there for an older bridge; lists every profile with its folder, plan, sign-in and marks, kept on the bridge', () => {
    const m = mount(null);
    expect(m.root.hidden).toBe(true);
    m.book.upsert(START);
    expect(m.root.hidden).toBe(false);
    expect(m.text('.settings-store')).toBe('Bridge');
    expect(m.text('.settings-lede')).toBe('A profile is a Codex home folder with its own sign-in. Add one with CODEX_HOME=~/.codex-<name> codex login.');
    expect(m.text('.settings-used')).toBe('Codex profiles: 3');
    const own = m.row('codex');
    expect(own.querySelector('.settings-cp-name')?.textContent).toBe('codex');
    expect([...own.querySelectorAll('.settings-badge')].map((b) => b.textContent)).toEqual(['Default', 'Signed in']);
    expect(own.querySelector('.settings-cp-path')?.textContent).toBe('~/.codex');
    expect(own.querySelector('.settings-cp-plan')?.textContent).toBe('prolite plan');
    // The default cannot be hidden or removed; a found one can be hidden, not removed; an added one both.
    expect(m.btn('Hide codex')).toBeUndefined();
    expect(m.btn('Remove codex')).toBeUndefined();
    expect(m.btn('Hide work')).toBeDefined();
    expect(m.btn('Remove work')).toBeUndefined();
    expect(m.btn('Remove spare')).toBeDefined();
    expect([...m.row('spare').querySelectorAll('.settings-badge')].map((b) => b.textContent)).toEqual(['Not signed in']);
    expect(m.row('spare').querySelector('.settings-cp-plan')).toBeNull();
    // Labels: every input has one.
    for (const i of m.root.querySelectorAll('input')) expect(i.labels?.length || i.getAttribute('aria-label')).toBeTruthy();
  });

  it('renames in place, checks the name first and shows the bridge’s refusal under the field', async () => {
    const m = mount(START, (a) => (a.name === 'Taken' ? { ok: false, code: 'bad_request', message: 'bad args: Another profile is called "Taken".' } : null));
    m.btn('Rename work')!.click();
    const input = m.root.querySelector<HTMLInputElement>('input[data-key="rename-input:work"]')!;
    expect(document.activeElement).toBe(input);
    m.type(input, 'CODEX');
    m.enter(input);
    expect(m.sent).toEqual([]);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(m.text('.settings-cp-edit .settings-field-error')).toBe('Another profile is called “codex”.');
    m.type(input, 'Taken');
    m.enter(input);
    await m.flush();
    expect(m.text('.settings-cp-edit .settings-field-error')).toBe('Another profile is called "Taken".');
    m.type(input, '  Work seat ');
    m.enter(input);
    await m.flush();
    expect(m.sent.at(-1)).toEqual({ t: 'codex_profiles.set', args: { key: 'work', name: 'Work seat' } });
    expect(m.row('work').querySelector('.settings-cp-name')?.textContent).toBe('Work seat');
    expect(m.root.querySelector('.settings-cp-edit')).toBeNull();
    expect(m.text('.settings-status')).toBe('Renamed work to Work seat.');
    expect(document.activeElement?.getAttribute('data-key')).toBe('rename:work');
  });

  it('Escape ends a rename and leaves the window open', () => {
    const m = mount(START);
    m.btn('Rename work')!.click();
    const input = m.root.querySelector<HTMLInputElement>('input[data-key="rename-input:work"]')!;
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    input.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(m.root.querySelector('.settings-cp-edit')).toBeNull();
  });

  it('hides and shows a profile', async () => {
    const m = mount(START);
    m.btn('Hide work')!.click();
    await m.flush();
    expect(m.sent.at(-1)).toEqual({ t: 'codex_profiles.set', args: { key: 'work', hidden: true } });
    expect(m.row('work').dataset.hidden).toBe('true');
    expect([...m.row('work').querySelectorAll('.settings-badge')].map((b) => b.textContent)).toEqual(['Hidden', 'Signed in']);
    expect(m.text('.settings-used')).toBe('Codex profiles: 3 (1 hidden)');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Show work');
    m.btn('Show work')!.click();
    await m.flush();
    expect(m.sent.at(-1)?.args).toEqual({ key: 'work', hidden: false });
  });

  it('adds a folder: checked first, the bridge’s refusal under the field, then added; removes an added one', async () => {
    const m = mount(START, (a) => (a.add === '~/nothing' ? { ok: false, code: 'bad_request', message: 'bad args: There is no folder there on the bridge host.' } : null));
    m.btn('Add folder')!.click();
    expect(m.sent).toEqual([]);
    expect(m.add().getAttribute('aria-invalid')).toBe('true');
    expect(m.text('.settings-cp .settings-field-error')).toBe('Type the folder’s path on the bridge host.');
    m.type(m.add(), 'relative/x');
    expect(m.add().getAttribute('aria-invalid')).toBe('false');
    m.enter(m.add());
    expect(m.text('.settings-cp .settings-field-error')).toBe('Use an absolute path on the bridge host, starting with / or ~/.');
    m.type(m.add(), '~/nothing');
    m.enter(m.add());
    await m.flush();
    expect(m.sent.at(-1)).toEqual({ t: 'codex_profiles.set', args: { add: '~/nothing' } });
    expect(m.text('.settings-cp .settings-field-error')).toBe('There is no folder there on the bridge host.');
    expect(m.add().value).toBe('~/nothing');
    m.type(m.add(), '~/team');
    m.btn('Add folder')!.click();
    await m.flush();
    expect(m.row('team')).not.toBeNull();
    expect(m.add().value).toBe('');
    expect(m.text('.settings-status')).toBe('Added ~/team as team. It is not signed in yet.');
    m.btn('Remove team')!.click();
    await m.flush();
    expect(m.sent.at(-1)?.args).toEqual({ key: 'team', remove: true });
    expect(m.root.querySelector('[data-profile="team"]')).toBeNull();
    expect(document.activeElement).toBe(m.add());
  });

  it('marks an added folder that is gone', () => {
    const m = mount({ profiles: [START.profiles[0]!, profile('gone', { added: true, signed_in: false, missing: true })] });
    expect([...m.row('gone').querySelectorAll('.settings-badge')].map((b) => b.textContent)).toEqual(['Folder not found']);
  });
});
