// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import { RepoRefsBook } from '../world/repoRefs';
import { repoRefsSection } from './repoRefsSection';
import { SettingsDialog } from './settings';

function mount(s: Record<string, unknown> | null, answer?: (args: Record<string, unknown>) => CommandResult) {
  document.body.replaceChildren();
  const book = new RepoRefsBook();
  book.reset(s);
  const sent: Array<{ t: string; args: Record<string, unknown> }> = [];
  const dialog = new SettingsDialog(document.body);
  dialog.addSection(
    'repos',
    'Repositories',
    repoRefsSection({
      book,
      send: ((t: string, args: Record<string, unknown>) => {
        sent.push({ t, args });
        return Promise.resolve(answer ? answer(args) : { ok: true, data: { all_buildings: args.all_buildings } });
      }) as never,
    }),
    { store: 'bridge', group: 'integrations' },
  );
  dialog.renderSections(); // #146: what the dialog's first open does
  const root = document.querySelector<HTMLElement>('[data-section="repos"]')!;
  const box = () => root.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const text = (sel: string) => root.querySelector<HTMLElement>(sel)?.textContent ?? '';
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { book, root, sent, box, text, flush };
}

describe('the “Repositories from other buildings” switch (#247)', () => {
  it('is not there for a bridge without it, and is off by default once it is, kept on the bridge', () => {
    const m = mount(null);
    expect(m.root.hidden).toBe(true);
    m.book.upsert({ all_buildings: false });
    expect(m.root.hidden).toBe(false);
    expect(m.box().checked).toBe(false);
    expect(m.root.textContent).toContain('Repositories from other buildings');
    expect(m.text('.settings-store')).toBe('Bridge');
    expect(m.box().getAttribute('aria-describedby')).toBe(m.root.querySelector('.settings-field-hint')?.id);
  });

  it('switches on and off through repo_refs.set and says what changes', async () => {
    const m = mount({ all_buildings: false });
    m.box().click();
    expect(m.box().disabled).toBe(true);
    expect(m.text('.settings-status')).toBe('Switching on…');
    await m.flush();
    expect(m.sent).toEqual([{ t: 'repo_refs.set', args: { all_buildings: true } }]);
    expect(m.book.state).toEqual({ all_buildings: true });
    expect(m.box().checked).toBe(true);
    expect(m.box().disabled).toBe(false);
    expect(m.text('.settings-status')).toBe('On. @r: lists every building’s floors.');
    m.box().click();
    await m.flush();
    expect(m.box().checked).toBe(false);
    expect(m.text('.settings-status')).toBe('Off. @r: lists the floors of the worker’s own building.');
  });

  it('follows another client’s change; a failure says why and puts the switch back', async () => {
    const m = mount({ all_buildings: false }, () => ({ ok: false, code: 'unknown_command', message: 'unknown command' }));
    m.book.upsert({ all_buildings: true });
    expect(m.box().checked).toBe(true);
    m.box().click();
    await m.flush();
    expect(m.box().checked).toBe(true);
    expect(m.text('.settings-status')).toMatch(/Update it/);
    expect(m.root.querySelector('.settings-status')?.classList.contains('settings-field-error')).toBe(true);
  });
});
