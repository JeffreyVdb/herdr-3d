import { clampZoom, DEFAULT_THEME, isThemeId, ZOOM, type ThemeId } from './themes';

/**
 * #59: what the seated views remember per browser, for every worker alike. The transcript and the terminal each have
 * their own preset and their own zoom (the same two presets); the transcript also remembers whether tool calls are
 * hidden. Guarded like `limitsPrefs.ts`: localStorage can be missing or throw (private windows, blocked site data), so
 * the values live here and storage only carries them to the next page load. A stored value that is not one of ours is
 * ignored (a zoom is clamped onto its steps).
 */

/** #172: the presets this build dropped, by the id a browser may still have stored, and what each one opens as now. */
const RETIRED: Readonly<Record<string, ThemeId>> = { terminal: 'ubuntu', paper: 'quiet' };

/** The two seated views a preset and a zoom are chosen for. */
export type ThemedView = 'transcript' | 'terminal';

const THEME: Record<ThemedView, string> = { transcript: 'h3d.theme.transcript', terminal: 'h3d.theme.terminal' };
const ZOOM_KEY: Record<ThemedView, string> = { transcript: 'h3d.zoom.transcript', terminal: 'h3d.zoom.terminal' };
const HIDE_TOOLS = 'h3d.transcript.hideTools';
/** #171: the transcript shows code changes (diffs) open (on unless the player turned them off: stored as '0'). */
const SHOW_CHANGES = 'h3d.transcript.showChanges';
/** #74: a laptop at a split pane zooms it to the whole herdr tab (on unless the player turned it off: stored as '0'). */
const FULLSCREEN = 'h3d.term.fullscreen';

export type ViewPref = 'transcriptTheme' | 'terminalTheme' | 'transcriptZoom' | 'terminalZoom' | 'hideTools' | 'showChanges' | 'fullscreen';

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export class ViewPrefs {
  private readonly listeners = new Set<(what: ViewPref) => void>();
  private readonly themes: Record<ThemedView, ThemeId>;
  private readonly zooms: Record<ThemedView, number>;
  private hide: boolean;
  private changes: boolean;
  private full: boolean;

  constructor(private readonly storage: Storage | null = defaultStorage()) {
    const theme = (v: ThemedView): ThemeId => {
      const t = this.read(THEME[v]);
      if (isThemeId(t)) return t;
      // A retired preset opens as its successor, and the stored value follows (the default is stored as nothing).
      const next = t === null || !Object.hasOwn(RETIRED, t) ? DEFAULT_THEME : RETIRED[t]!;
      if (t !== null && Object.hasOwn(RETIRED, t)) this.write(THEME[v], next === DEFAULT_THEME ? null : next);
      return next;
    };
    const zoom = (v: ThemedView): number => {
      const z = this.read(ZOOM_KEY[v]);
      return z === null ? ZOOM.reset : clampZoom(z);
    };
    this.themes = { transcript: theme('transcript'), terminal: theme('terminal') };
    this.zooms = { transcript: zoom('transcript'), terminal: zoom('terminal') };
    this.hide = this.read(HIDE_TOOLS) === '1';
    this.changes = this.read(SHOW_CHANGES) !== '0';
    this.full = this.read(FULLSCREEN) !== '0';
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

  theme(view: ThemedView): ThemeId {
    return this.themes[view];
  }

  setTheme(view: ThemedView, id: ThemeId): void {
    if (!isThemeId(id) || id === this.themes[view]) return;
    this.themes[view] = id;
    this.write(THEME[view], id === DEFAULT_THEME ? null : id);
    this.changed(view === 'transcript' ? 'transcriptTheme' : 'terminalTheme');
  }

  /** Percent, 70–200 in steps of 10 (100: the view's preset's own size). */
  zoom(view: ThemedView): number {
    return this.zooms[view];
  }

  setZoom(view: ThemedView, z: number): void {
    const v = clampZoom(z);
    if (v === this.zooms[view]) return;
    this.zooms[view] = v;
    this.write(ZOOM_KEY[view], v === ZOOM.reset ? null : String(v));
    this.changed(view === 'transcript' ? 'transcriptZoom' : 'terminalZoom');
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

  /**
   * #171: whether the transcript shows code changes' diffs (default on). Off, each changed file is one line (its path and
   * counts), opened one at a time. Display only: Claude Code's own recording setting is never read or written.
   */
  get showChanges(): boolean {
    return this.changes;
  }

  set showChanges(on: boolean) {
    if (on === this.changes) return;
    this.changes = on;
    this.write(SHOW_CHANGES, on ? null : '0');
    this.changed('showChanges');
  }

  /** #74: whether sitting at a split pane's laptop zooms the pane to its whole tab (default on). */
  get fullscreen(): boolean {
    return this.full;
  }

  set fullscreen(on: boolean) {
    if (on === this.full) return;
    this.full = on;
    this.write(FULLSCREEN, on ? null : '0');
    this.changed('fullscreen');
  }

  onChange(fn: (what: ViewPref) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
