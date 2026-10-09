import './appearance.css';
import type { ViewPrefs } from './themePrefs';
import { UI_THEME_FIELD, UI_THEME_HINT, UI_THEMES, isUiThemeId } from './uiTheme';
import { el } from './settings';
import type { SectionHandle } from './settings';

let serial = 0;

/**
 * #216: Settings → Appearance (This browser): the UI theme, Quiet or Ubuntu. A native radio group in a fieldset, so the
 * keyboard (arrows, Tab out of the group), the announcement ("UI theme, Quiet, selected, 1 of 2") and the click target
 * are the platform's. Each option shows a swatch of its colours, its name and its description, and its state is a
 * filled dot and a filled card as well as colour. A pick applies at once to everything on screen (ui/themeLoader.ts:
 * one attribute on the root), the focus stays on the radio and nothing is rebuilt.
 */
export function appearanceSection(prefs: ViewPrefs): (body: HTMLElement) => SectionHandle {
  return (body) => {
    const id = `settings-ui-theme-${++serial}`;
    const group = el('fieldset', 'settings-theme');
    const legend = el('legend', 'settings-field-label', UI_THEME_FIELD);
    const hint = el('p', 'settings-field-hint', UI_THEME_HINT);
    hint.id = `${id}-hint`;
    group.setAttribute('aria-describedby', hint.id);
    const options = el('div', 'settings-theme-options');
    const radios: HTMLInputElement[] = [];
    for (const t of UI_THEMES) {
      const label = el('label', 'settings-theme-opt');
      const input = el('input');
      input.type = 'radio';
      input.name = id;
      input.value = t.id;
      input.id = `${id}-${t.id}`;
      const desc = el('span', 'settings-theme-desc', t.blurb);
      desc.id = `${input.id}-desc`;
      input.setAttribute('aria-describedby', desc.id);
      // A miniature of the theme: its bar, its surface with a raised card and a line of text, its action. Decoration.
      const swatch = el('span', 'settings-theme-swatch');
      swatch.setAttribute('aria-hidden', 'true');
      for (const [k, v] of Object.entries(t.swatch)) swatch.style.setProperty(`--swatch-${k}`, v);
      for (const part of ['bar', 'card', 'line', 'action']) swatch.append(el('i', `settings-theme-swatch-${part}`));
      const text = el('span', 'settings-theme-text');
      text.append(el('span', 'settings-theme-name', t.label), desc);
      const dot = el('span', 'settings-theme-dot');
      dot.setAttribute('aria-hidden', 'true');
      label.append(input, swatch, text, dot);
      input.addEventListener('change', () => {
        if (input.checked && isUiThemeId(input.value)) prefs.setUiTheme(input.value);
      });
      radios.push(input);
      options.append(label);
    }
    const sync = () => {
      for (const r of radios) r.checked = r.value === prefs.uiTheme();
    };
    sync();
    const off = prefs.onChange((what) => {
      if (what === 'uiTheme') sync();
    });
    group.append(legend, hint, options);
    body.append(group);
    return { open: sync, dispose: off };
  };
}
