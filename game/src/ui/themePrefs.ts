import { clampZoom, DEFAULT_THEME, isThemeId, ZOOM, type ThemeId } from './themes';

/**
 * #59: what the transcript view remembers per browser, for every worker alike: the preset, whether tool calls are
 * hidden, and the font zoom. Guarded like `limitsPrefs.ts`: localStorage can be missing or throw (private windows,
 * blocked site data), so the values live here and storage only carries them to the next page load. A stored value
 * that is not one of ours is ignored (a zoom is clamped onto its steps).
 */

const THEME = 'h3d.theme';
const HIDE_TOOLS = 'h3d.transcript.hideTools';
const ZOOM_KEY = 'h3d.zoom';

export type ViewPref = 'theme' | 'hideTools' | 'zoom';

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export class ViewPrefs {
  private readonly listeners = new Set<(what: ViewPref) => void>();
  private themeId: ThemeId;
  private hide: boolean;
  private level: number;

  constructor(private readonly storage: Storage | null = defaultStorage()) {
    const t = this.read(THEME);
    this.themeId = isThemeId(t) ? t : DEFAULT_THEME;
    this.hide = this.read(HIDE_TOOLS) === '1';
    const z = this.read(ZOOM_KEY);
    this.level = z === null ? ZOOM.reset : clampZoom(z);
  }

  private read(key: string): string | null {
    try {
      return this.storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  private write(key: string, value: string | null): void {
    try {
      if (value === null) this.storage?.removeItem(key);
      else this.storage?.setItem(key, value);
    } catch {
      /* not remembered past this page */
    }
  }

  private changed(what: ViewPref): void {
    for (const fn of this.listeners) fn(what);
  }

  get theme(): ThemeId {
    return this.themeId;
  }

  set theme(id: ThemeId) {
    if (!isThemeId(id) || id === this.themeId) return;
    this.themeId = id;
    this.write(THEME, id === DEFAULT_THEME ? null : id);
    this.changed('theme');
  }

  get hideTools(): boolean {
    return this.hide;
  }

  set hideTools(on: boolean) {
    if (on === this.hide) return;
    this.hide = on;
    this.write(HIDE_TOOLS, on ? '1' : null);
    this.changed('hideTools');
  }

  /** Percent, 70–200 in steps of 10 (100: the preset's own size). */
  get zoom(): number {
    return this.level;
  }

  set zoom(z: number) {
    const v = clampZoom(z);
    if (v === this.level) return;
    this.level = v;
    this.write(ZOOM_KEY, v === ZOOM.reset ? null : String(v));
    this.changed('zoom');
  }

  onChange(fn: (what: ViewPref) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
