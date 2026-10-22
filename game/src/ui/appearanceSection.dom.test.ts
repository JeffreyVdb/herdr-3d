// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { appearanceSection } from './appearanceSection';
import { SettingsDialog } from './settings';
import { ViewPrefs } from './themePrefs';

function mount(prefs = new ViewPrefs(null)) {
  document.body.replaceChildren();
  const dialog = new SettingsDialog(document.body);
  const remove = dialog.addSection('appearance', 'Appearance', appearanceSection(prefs), { store: 'browser', group: 'general' });
  dialog.renderSections(); // #146: what the dialog's first open does
  const section = document.querySelector<HTMLElement>('[data-section="appearance"]')!;
  const radios = () => [...section.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  return { dialog, prefs, section, radios, remove };
}

describe('Settings → Appearance (#216)', () => {
  it('is a browser-scoped section titled Appearance with a labelled “UI theme” radio group of exactly Quiet and Ubuntu', () => {
    const { section, radios } = mount();
    expect(section.querySelector('h3')!.textContent).toBe('Appearance');
    expect(section.querySelector('.settings-store')!.textContent).toBe('This browser');
    const group = section.querySelector('fieldset')!;
    expect(group.querySelector('legend')!.textContent).toBe('UI theme');
    expect(group.getAttribute('aria-describedby')).toBe(group.querySelector('.settings-field-hint')!.id);
    expect(group.querySelector('.settings-field-hint')!.textContent).toBe('Colors and fonts for menus, dialogs, bars, and controls, and the colors of the office. Transcript and terminal appearance are set separately.');
    expect(radios().map((r) => r.value)).toEqual(['quiet', 'ubuntu']);
    // One radio group (one name), each named by its label and described by its description.
    expect(new Set(radios().map((r) => r.name)).size).toBe(1);
    const labels = [...section.querySelectorAll('.settings-theme-opt')].map((l) => [l.querySelector('.settings-theme-name')!.textContent, l.querySelector('.settings-theme-desc')!.textContent]);
    expect(labels).toEqual([
      ['Quiet', 'The current navy interface.'],
      ['Ubuntu', 'Ubuntu purple, orange accents, Ubuntu and Ubuntu Mono.'],
    ]);
    for (const r of radios()) expect(document.getElementById(r.getAttribute('aria-describedby')!)).not.toBeNull();
    // The swatch is decoration: the name and the state carry the meaning.
    expect(section.querySelectorAll('.settings-theme-swatch[aria-hidden="true"]')).toHaveLength(2);
  });

  it('has Quiet selected for a fresh browser', () => {
    const { radios } = mount();
    expect(radios().map((r) => r.checked)).toEqual([true, false]);
  });

  it('starts on a saved Ubuntu', () => {
    const st = new Map([['h3d.theme.ui', 'ubuntu']]);
    const { radios } = mount(new ViewPrefs({ getItem: (k: string) => st.get(k) ?? null, setItem: () => {}, removeItem: () => {} } as unknown as Storage));
    expect(radios().map((r) => r.checked)).toEqual([false, true]);
  });

  it('picking an option sets the pref, and only the UI pref; the focus stays on the radio', () => {
    const { prefs, radios, dialog } = mount();
    const seen: string[] = [];
    prefs.onChange((w) => seen.push(w));
    const ubuntu = radios()[1]!;
    ubuntu.focus();
    ubuntu.checked = true;
    ubuntu.dispatchEvent(new Event('change', { bubbles: true }));
    expect(prefs.uiTheme()).toBe('ubuntu');
    expect(prefs.theme('transcript')).toBe('quiet');
    expect(prefs.theme('terminal')).toBe('quiet');
    expect(seen).toEqual(['uiTheme']);
    expect(document.activeElement).toBe(ubuntu);
    expect(radios().map((r) => r.checked)).toEqual([false, true]);
    dialog.dispose();
  });

  it('follows the pref when something else changes it, and stops listening once removed', () => {
    const { prefs, radios, remove } = mount();
    prefs.setUiTheme('ubuntu');
    expect(radios().map((r) => r.checked)).toEqual([false, true]);
    const [quiet] = radios() as [HTMLInputElement];
    remove();
    prefs.setUiTheme('quiet');
    expect(quiet.checked).toBe(false);
  });
});
