import { canvasFaces, themeById, themeVars, type ThemeId, type ThemePreset } from './themes';
import type { ViewPrefs } from './themePrefs';

/**
 * #59: puts the chosen preset on the page. Its custom properties go on the root element at once (the DOM swaps
 * fonts as they arrive: `font-display: swap`); its fonts load on first use: Quiet's come with the app (`main.ts`
 * imports them), the other two's stylesheets are split out by Vite and fetched the first time they are picked. The
 * terminal canvas cannot swap by itself, so `ready` fires only once the faces it draws with have loaded (or failed:
 * then the system's monospace draws it) and repaints with them.
 */

/** Each preset's font stylesheet: a literal import, so Vite splits each one into its own CSS and font files. */
const LOADERS: Record<ThemeId, () => Promise<unknown>> = {
  quiet: () => Promise.resolve(),
  terminal: () => import('../fonts/terminal.css'),
  paper: () => import('../fonts/paper.css'),
};

/** What `document.fonts` offers here (a fake in vitest). */
export interface FontLoader {
  load(font: string, text?: string): Promise<unknown>;
}

export class ThemeLoader {
  private readonly listeners = new Set<(t: ThemePreset) => void>();
  /** The preset whose fonts the canvas may draw with (the previous one while the new one loads). */
  private readyTheme: ThemePreset;
  private gen = 0;
  /** Settles when the latest pick's fonts are in (tests, the e2e hook). */
  loading: Promise<void> = Promise.resolve();

  constructor(
    readonly prefs: ViewPrefs,
    private readonly root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement,
    private readonly fonts: FontLoader | null = typeof document === 'undefined' ? null : document.fonts,
  ) {
    this.readyTheme = themeById(prefs.theme);
    prefs.onChange((what) => {
      if (what === 'theme') this.apply();
      else if (what === 'zoom') this.setVars();
    });
    this.apply();
  }

  /** The preset picked (its colours and sizes are on the page already). */
  get theme(): ThemePreset {
    return themeById(this.prefs.theme);
  }

  /** The preset the terminal draws with. */
  get ready(): ThemePreset {
    return this.readyTheme;
  }

  /** Called with the preset once its fonts can draw on a canvas. */
  onReady(fn: (t: ThemePreset) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setVars(): void {
    const t = this.theme;
    if (!this.root) return;
    for (const [k, v] of Object.entries(themeVars(t, this.prefs.zoom))) this.root.style.setProperty(k, v);
    this.root.dataset.theme = t.id;
  }

  private apply(): void {
    this.setVars();
    const t = this.theme;
    const gen = ++this.gen;
    this.loading = LOADERS[t.id]()
      .then(() => Promise.all(canvasFaces(t).map((f) => this.fonts?.load(f, 'MW09│'))))
      .catch(() => undefined)
      .then(() => {
        if (gen !== this.gen) return;
        this.readyTheme = t;
        for (const fn of this.listeners) fn(t);
      });
  }
}
