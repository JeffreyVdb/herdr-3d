import type { BuildInfo } from '../version';
import type { LimitsPrefs } from './limitsPrefs';
import type { TimePrefs } from './timePrefs';
import { browserZone } from '../world/daylight';
import type { TimeOfDay } from '../world/timeOfDay';
import './about.css';
import { backdropPolicy } from './dismiss';

const NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function closeIcon(): SVGSVGElement {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '2');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', 'M6.5 6.5l11 11M17.5 6.5l-11 11');
  s.append(p);
  return s;
}

/** M17: the time of day's settings, and the time of day that reads them (for what is in effect). */
export interface TimeSettingsHost {
  prefs: TimePrefs;
  time: TimeOfDay;
}

let fieldSerial = 0;

/**
 * The About panel: which build each side of the game is (this bundle, the Mac
 * helper, the bridge) and which renderer backend is drawing. It used to be a
 * badge over the corner of the canvas at all times; it sat on top of the HUD.
 * A modal `<dialog>` like the Music credits; Esc or Close shuts it, and the
 * game's keys do nothing while it is open. It follows the build info live.
 */
export class AboutDialog {
  private readonly dialog = el('dialog', 'credits about');
  private readonly list = el('dl', 'about-list');
  private readonly note = el('p', 'about-note');
  private opener: HTMLElement | null = null;
  private readonly off: () => void;
  /** M17: re-reads the time settings into their fields (on open: `?tz=` or another tab may have moved them). */
  private syncTime: (() => void) | null = null;
  private offTime: (() => void) | null = null;

  constructor(
    parent: HTMLElement,
    private readonly info: BuildInfo,
    private readonly limits?: LimitsPrefs,
    private readonly time?: TimeSettingsHost,
  ) {
    const head = el('header', 'panel-head');
    const titles = el('div', 'panel-titles');
    const h = el('h2', '', 'About');
    h.id = 'about-title';
    titles.append(h, el('p', '', 'Which build is running'));
    const close = el('button', 'btn btn--icon panel-close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.title = 'Close (Esc)';
    close.append(closeIcon());
    close.addEventListener('click', () => this.close());
    head.append(titles, close);

    const body = el('div', 'panel-body credits-body about-body');
    body.tabIndex = -1;
    body.append(this.list, this.note);
    if (limits) body.append(this.limitsSwitch(limits));
    if (time) body.append(this.timeSettings(time));

    this.dialog.setAttribute('aria-labelledby', 'about-title');
    this.dialog.append(head, body);
    this.dialog.addEventListener('keydown', (e) => e.stopPropagation());
    this.dialog.addEventListener('close', () => {
      this.opener?.focus();
      this.opener = null;
    });
    // A read-only sheet: the backdrop closes it only when the press and the click both began there (#51).
    backdropPolicy(this.dialog, 'sheet', () => this.close());
    parent.append(this.dialog);
    this.off = info.onChange(() => this.render());
    this.render();
  }

  /** M10: the plan limits widget is on by default; this is where it is switched off and on. */
  private limitsSwitch(prefs: LimitsPrefs): HTMLElement {
    const box = el('input');
    box.type = 'checkbox';
    box.id = 'about-limits';
    const sync = () => (box.checked = !prefs.hidden);
    sync();
    box.addEventListener('change', () => (prefs.hidden = !box.checked));
    prefs.onChange(sync);
    const label = el('label', 'about-switch');
    label.htmlFor = 'about-limits';
    label.append(box, el('span', '', 'Show plan limits (Claude and Codex) in the corner'));
    return label;
  }

  /**
   * M17: the timezone and latitude of the game's day and night. A field
   * commits on Enter or when it loses focus; what the browser cannot use is
   * said under the field and not kept. Empty goes back to the default.
   */
  private timeSettings(host: TimeSettingsHost): HTMLElement {
    const { prefs, time } = host;
    const box = el('section', 'about-time');
    const id = `about-time-${++fieldSerial}`;
    box.setAttribute('aria-labelledby', `${id}-h`);
    const h = el('h3', 'about-time-title', 'Day and night');
    h.id = `${id}-h`;
    const grid = el('div', 'about-time-grid');
    const field = (key: string, label: string, input: HTMLInputElement, hint: HTMLElement, short = false) => {
      const f = el('div', short ? 'about-field about-field--short' : 'about-field');
      input.id = `${id}-${key}`;
      input.setAttribute('aria-describedby', hint.id = `${id}-${key}-hint`);
      const l = el('label', 'about-field-label', label);
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
      box.append(list);
    }
    const zoneHint = el('p', 'about-field-hint');

    const lat = el('input');
    lat.type = 'text';
    lat.inputMode = 'decimal';
    lat.autocomplete = 'off';
    lat.placeholder = 'Not set';
    lat.value = prefs.latitude === null ? '' : String(prefs.latitude);
    const latHint = el('p', 'about-field-hint');

    const say = (input: HTMLInputElement, hint: HTMLElement, error: string | null, ok: string) => {
      input.setAttribute('aria-invalid', error ? 'true' : 'false');
      hint.classList.toggle('about-field-error', !!error);
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
    this.offTime = prefs.onChange(sync);
    this.syncTime = sync;
    sync();
    grid.append(field('zone', 'Timezone', zone, zoneHint), field('lat', 'Latitude', lat, latHint, true));
    box.append(h, el('p', 'about-time-lede', 'The office follows the local time: dark outside at night, lit by its own lamps.'), grid);
    return box;
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  open(from: HTMLElement | null = null): void {
    if (this.dialog.open) return;
    this.opener = from;
    this.render();
    this.syncTime?.();
    this.dialog.showModal();
    this.dialog.querySelector<HTMLElement>('.about-body')?.focus();
  }

  close(): void {
    if (this.dialog.open) this.dialog.close();
  }

  dispose(): void {
    this.off();
    this.offTime?.();
    this.close();
    this.dialog.remove();
  }

  private render(): void {
    const { info } = this;
    const rows: Array<[string, string | null]> = [
      ['Game', info.game],
      ['Helper', info.helper],
      ['Bridge', info.bridge],
      ['Renderer', info.backend],
    ];
    this.list.replaceChildren(
      ...rows.flatMap(([k, v]) => {
        const dd = el('dd', 'about-value', v ?? 'not connected');
        dd.classList.toggle('about-value--none', v === null);
        return [el('dt', 'about-key', k), dd];
      }),
    );
    const s = info.summary();
    this.note.hidden = !s.mismatch;
    this.note.textContent = s.mismatch ? 'The versions differ: one side is a stale install. Run h3d-update to bring them together.' : '';
  }
}
