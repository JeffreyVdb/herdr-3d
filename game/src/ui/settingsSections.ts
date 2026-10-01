import type { LimitsPrefs } from './limitsPrefs';
import type { TimePrefs } from './timePrefs';
import { browserZone } from '../world/daylight';
import type { TimeOfDay } from '../world/timeOfDay';
import { el } from './settings';
import type { SectionHandle } from './settings';

/** M17: the time of day's settings, and the time of day that reads them (for what is in effect). */
export interface TimeSettingsHost {
  prefs: TimePrefs;
  time: TimeOfDay;
}

let fieldSerial = 0;

/** M10: the plan limits widget is on by default; this is where it is switched off and on (moved from About, #91). */
export function displaySection(prefs: LimitsPrefs): (body: HTMLElement) => SectionHandle {
  return (body) => {
    const box = el('input');
    box.type = 'checkbox';
    box.id = 'settings-limits';
    const sync = () => (box.checked = !prefs.hidden);
    sync();
    box.addEventListener('change', () => (prefs.hidden = !box.checked));
    const off = prefs.onChange(sync);
    const label = el('label', 'settings-switch');
    label.htmlFor = box.id;
    label.append(box, el('span', '', 'Show plan limits (Claude and Codex) in the corner'));
    body.append(label);
    return { dispose: off };
  };
}

/**
 * M17: the timezone and latitude of the game's day and night. A field
 * commits on Enter or when it loses focus; what the browser cannot use is
 * said under the field and not kept. Empty goes back to the default.
 * (Moved from About, #91; the section's heading is the dialog's.)
 */
export function timeSection(host: TimeSettingsHost): (body: HTMLElement) => SectionHandle {
  return (body) => {
    const { prefs, time } = host;
    const id = `settings-time-${++fieldSerial}`;
    const grid = el('div', 'settings-grid');
    const field = (key: string, label: string, input: HTMLInputElement, hint: HTMLElement, short = false) => {
      const f = el('div', short ? 'settings-field settings-field--short' : 'settings-field');
      input.id = `${id}-${key}`;
      input.setAttribute('aria-describedby', hint.id = `${id}-${key}-hint`);
      const l = el('label', 'settings-field-label', label);
      l.htmlFor = input.id;
      f.append(l, input, hint);
      return f;
    };

    const zone = el('input');
    zone.type = 'text';
    zone.autocomplete = 'off';
    zone.spellcheck = false;
    zone.placeholder = browserZone();
    zone.value = prefs.timeZone ?? '';
    const zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
    if (zones.length) {
      const list = el('datalist');
      list.id = `${id}-zones`;
      list.append(...zones.map((z) => Object.assign(el('option'), { value: z })));
      zone.setAttribute('list', list.id);
      body.append(list);
    }
    const zoneHint = el('p', 'settings-field-hint');

    const lat = el('input');
    lat.type = 'text';
    lat.inputMode = 'decimal';
    lat.autocomplete = 'off';
    lat.placeholder = 'Not set';
    lat.value = prefs.latitude === null ? '' : String(prefs.latitude);
    const latHint = el('p', 'settings-field-hint');

    const say = (input: HTMLInputElement, hint: HTMLElement, error: string | null, ok: string) => {
      input.setAttribute('aria-invalid', error ? 'true' : 'false');
      hint.classList.toggle('settings-field-error', !!error);
      hint.textContent = error ?? ok;
    };
    const zoneOk = () => {
      const src = time.zoneSource;
      const now = time.timeZone;
      return src === 'override' ? `The page address sets ${now} for now (?tz=).` : src === 'setting' ? `In effect: ${now}.` : `In effect: ${now}, this browser’s zone.`;
    };
    const latOk = () =>
      time.latitude === null ? 'Not set: dawn 06:30–08:00, dusk 18:30–20:00.' : `${prefs.latitude === null ? 'The page address sets' : 'Set:'} ${time.latitude}°. Sunrise and sunset follow the season.`;
    const sync = () => {
      if (document.activeElement !== zone && zone.getAttribute('aria-invalid') !== 'true') zone.value = prefs.timeZone ?? '';
      if (document.activeElement !== lat && lat.getAttribute('aria-invalid') !== 'true') lat.value = prefs.latitude === null ? '' : String(prefs.latitude);
      if (zone.getAttribute('aria-invalid') !== 'true') say(zone, zoneHint, null, zoneOk());
      if (lat.getAttribute('aria-invalid') !== 'true') say(lat, latHint, null, latOk());
    };
    const commit = (input: HTMLInputElement, hint: HTMLElement, set: (v: string) => ReturnType<TimePrefs['setTimeZone']>, ok: () => string) => {
      const r = set(input.value);
      say(input, hint, r.ok ? null : r.error, ok());
      if (r.ok) sync();
    };
    zone.addEventListener('change', () => commit(zone, zoneHint, (v) => prefs.setTimeZone(v), zoneOk));
    lat.addEventListener('change', () => commit(lat, latHint, (v) => prefs.setLatitude(v), latOk));
    for (const [input, hint, ok] of [
      [zone, zoneHint, zoneOk],
      [lat, latHint, latOk],
    ] as const) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.dispatchEvent(new Event('change'));
      });
      // Typing again clears a refusal until the next commit.
      input.addEventListener('input', () => {
        if (input.getAttribute('aria-invalid') === 'true') say(input, hint, null, ok());
      });
    }
    const off = prefs.onChange(sync);
    sync();
    grid.append(field('zone', 'Timezone', zone, zoneHint), field('lat', 'Latitude', lat, latHint, true));
    body.append(el('p', 'settings-lede', 'The office follows the local time: dark outside at night, lit by its own lamps.'), grid);
    // On open: `?tz=` or another tab may have moved the settings.
    return { open: sync, dispose: off };
  };
}
