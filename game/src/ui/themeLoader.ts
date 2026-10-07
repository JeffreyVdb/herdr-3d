import { canvasFaces, themeById, themeVars, type ThemeId, type ThemePreset } from './themes';
import type { ViewPrefs } from './themePrefs';

/**
 * #59: puts the two chosen presets on the page. The transcript's goes on the root element as custom properties at
 * once (its fonts and colours, and `--font-mono` for every monospace in the DOM: the limits widget, the boards, the
 * HUD's numbers), and the DOM swaps fonts as they arrive (`font-display: swap`). The terminal's is a canvas, which
 * cannot swap by itself: `ready` fires once the faces it draws with have loaded (or failed: then the system's
 * monospace draws it) and the screens repaint with them.
 *
 * Fonts load on first use: Quiet's stylesheet comes with the app (`main.ts`), the other is split out by Vite and
 * fetched the first time either view picks it. A stylesheet only declares its faces; a file is fetched when text
 * uses it, so the terminal in Ubuntu fetches Ubuntu Mono and never Ubuntu.
 */

/** Each preset's font stylesheet: a literal import, so Vite splits each one into its own CSS and font files. */
const LOADERS: Record<ThemeId, () => Promise<unknown>> = {
  quiet: () => Promise.resolve(),
  ubuntu: () => import('../fonts/ubuntu.css'),
};

/** What `document.fonts` offers here (a fake in vitest). */
export interface FontLoader {
  load(font: string, text?: string): Promise<unknown>;
}

export class ThemeLoader {
  private readonly listeners = new Set<(t: ThemePreset) => void>();
  /** The preset the terminal draws with (the previous one while the new one's faces load). */
  private readyTheme: ThemePreset;
  private gen = 0;
  /** Settles when the latest picks' stylesheets and the terminal's faces are in (tests, the e2e hook). */
  loading: Promise<void> = Promise.resolve();
  private transcriptLoad: Promise<unknown> = Promise.resolve();
  private terminalLoad: Promise<void> = Promise.resolve();

  constructor(
    readonly prefs: ViewPrefs,
    private readonly root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement,
    private readonly fonts: FontLoader | null = typeof document === 'undefined' ? null : document.fonts,
  ) {
    this.readyTheme = themeById(prefs.theme('terminal'));
    prefs.onChange((what) => {
      if (what === 'transcriptTheme') this.applyTranscript();
      else if (what === 'transcriptZoom') this.setVars();
      else if (what === 'terminalTheme') this.applyTerminal();
    });
    this.applyTranscript();
    this.applyTerminal();
  }

  /** The transcript's preset (its colours and sizes are on the page already). */
  get theme(): ThemePreset {
    return themeById(this.prefs.theme('transcript'));
  }

  /** The terminal's preset as picked. */
  get terminal(): ThemePreset {
    return themeById(this.prefs.theme('terminal'));
  }

  /** The preset the terminal draws with now. */
  get ready(): ThemePreset {
    return this.readyTheme;
  }

  /** Called with the terminal's preset once its faces can draw on a canvas. */
  onReady(fn: (t: ThemePreset) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setVars(): void {
    const t = this.theme;
    if (!this.root) return;
    for (const [k, v] of Object.entries(themeVars(t, this.prefs.zoom('transcript')))) this.root.style.setProperty(k, v);
    this.root.dataset.theme = t.id;
  }

  private settled(): void {
    this.loading = Promise.all([this.transcriptLoad, this.terminalLoad]).then(() => undefined);
  }

  private applyTranscript(): void {
    this.setVars();
    this.transcriptLoad = LOADERS[this.theme.id]().catch(() => undefined);
    this.settled();
  }

  private applyTerminal(): void {
    const t = this.terminal;
    const gen = ++this.gen;
    // Only the mono faces the canvas draws with: the preset's prose font is not asked for.
    this.terminalLoad = LOADERS[t.id]()
      .then(() => Promise.all(canvasFaces(t).map((f) => this.fonts?.load(f, 'MW09'))))
      .catch(() => undefined)
      .then(() => {
        if (gen !== this.gen) return;
        this.readyTheme = t;
        for (const fn of this.listeners) fn(t);
      });
    this.settled();
  }
}
